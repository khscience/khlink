//! Official Desktop lifecycle only. GUI and headless calls share this coordinator.
use serde_json::{Value, json};
use std::os::windows::process::CommandExt;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::{
    Foundation::HANDLE,
    System::{StationsAndDesktops::*, Variant::VARIANT},
};
use windows::Win32::{
    Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0},
    System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
};
use windows::Win32::{
    System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    },
    UI::Accessibility::*,
};

static SWITCH: Mutex<()> = Mutex::new(());
/// 2026-10-18: Claude Desktop account switching is temporarily disabled while
/// the remote-control compliance review is pending. Profiles, usage records and
/// switching scripts stay on disk; only the product entry points are closed.
const ACCOUNT_SWITCH_ENABLED: bool = false;
struct ProcessMutex(HANDLE);
impl ProcessMutex {
    fn acquire() -> Result<Self, String> {
        unsafe {
            let handle = CreateMutexW(
                None,
                false,
                windows::core::w!("Local\\KHLinkClaudeAccountSwitchV1"),
            )
            .map_err(|_| "busy")?;
            let status = WaitForSingleObject(handle, 0);
            if status == WAIT_OBJECT_0 || status == WAIT_ABANDONED {
                Ok(Self(handle))
            } else {
                let _ = CloseHandle(handle);
                Err("busy".into())
            }
        }
    }
}
impl Drop for ProcessMutex {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}
pub(crate) fn child_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", unc));
    }
    if let Some(local) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(local);
    }
    path
}
fn resources(app: Option<&AppHandle>) -> Result<PathBuf, String> {
    let base = match app {
        Some(app) => child_path(app.path().resource_dir().map_err(|_| "component_failed")?),
        None => child_path(std::env::current_exe().map_err(|_| "component_failed")?)
            .parent()
            .ok_or("component_failed")?
            .to_path_buf(),
    };
    let dir = base.join("claude-switch");
    if dir.join("console.cjs").is_file() {
        return Ok(dir);
    }
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ops/claude-switch");
        if source.join("console.cjs").is_file() {
            return Ok(source);
        }
    }
    Err("component_failed".into())
}
struct Context<'a> {
    app: Option<&'a AppHandle>,
    dir: PathBuf,
    id: String,
    pid: String,
}
fn run(
    command: Command,
    timeout: Duration,
    mutation: Option<&Context>,
) -> Result<String, String> {
    run_child(command, timeout, mutation, true)
}
fn run_child(mut command: Command, timeout: Duration, mutation: Option<&Context>, cancellable: bool) -> Result<String, String> {
    command
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "component_failed")?;
    // A journal failure must not abandon a still-mutating child. Keep waiting
    // for it; the script also holds its own PID lock before touching a link.
    let tracking_failed =
        mutation.is_some_and(|ctx| ctx.phase("syncing", Some(child.id())).is_err());
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let read = |mut r: Box<dyn std::io::Read + Send>| {
        let mut b = Vec::new();
        let _ = r.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    };
    let o = std::thread::spawn(move || read(Box::new(out)));
    let e = std::thread::spawn(move || read(Box::new(err)));
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|_| "component_failed")? {
            let stdout = o.join().unwrap_or_default();
            let stderr = e.join().unwrap_or_default();
            if let Some(ctx) = mutation {
                ctx.phase("syncing", None)?;
            }
            if !status.success() {
                let code = serde_json::from_str::<Value>(stderr.trim())
                    .ok()
                    .and_then(|v| v["code"].as_str().map(String::from))
                    .unwrap_or_else(|| "component_failed".into());
                return Err(code);
            }
            if tracking_failed {
                return Err("component_failed".into());
            }
            return Ok(stdout.trim_start_matches('\u{feff}').trim().to_string());
        }
        if start.elapsed() > timeout {
            // Read-only helpers can be cancelled. A mutating helper remains in
            // the durable lock with its PID until it exits; never kill Claude.
            if mutation.is_none() && cancellable {
                let _ = child.kill();
            }
            return Err("helper_timeout".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn node(dir: &Path, args: &[&str]) -> Result<Value, String> {
    let exe =
        PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_default()).join("nodejs/node.exe");
    let mut cmd = Command::new(if exe.is_file() {
        exe
    } else {
        PathBuf::from("node.exe")
    });
    cmd.arg(dir.join("console.cjs"))
        .args(args)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    serde_json::from_str(&run(cmd, Duration::from_secs(30), None)?)
        .map_err(|_| "component_failed".into())
}
fn info(dir: &Path) -> Result<Value, String> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(dir.join("desktop-info.ps1"));
    serde_json::from_str(&run(cmd, Duration::from_secs(20), None)?)
        .map_err(|_| "component_failed".into())
}
impl Context<'_> {
    fn phase(&self, phase: &str, helper: Option<u32>) -> Result<Value, String> {
        let data = node(
            &self.dir,
            &[
                "operation",
                "update",
                &self.id,
                &self.pid,
                phase,
                &helper.unwrap_or(0).to_string(),
            ],
        )?;
        if let Some(app) = self.app {
            let _ = app.emit("claude-profile-progress", &data);
        }
        Ok(data)
    }
}
fn unlocked_desktop() -> bool {
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let mut name = [0u16; 128];
        let ok = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            256,
            None,
        )
        .is_ok();
        let _ = CloseDesktop(desktop);
        ok && String::from_utf16_lossy(
            &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
        )
        .eq_ignore_ascii_case("Default")
    }
}
unsafe fn elements(
    ui: &IUIAutomation,
    scope: &IUIAutomationElement,
    pid: i32,
    kind: UIA_CONTROLTYPE_ID,
) -> Result<Vec<IUIAutomationElement>, String> {
    unsafe {
        let a = ui
            .CreatePropertyCondition(UIA_ProcessIdPropertyId, &VARIANT::from(pid))
            .map_err(|_| "menu_unknown")?;
        let b = ui
            .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(kind.0))
            .map_err(|_| "menu_unknown")?;
        let condition = ui.CreateAndCondition(&a, &b).map_err(|_| "menu_unknown")?;
        let found = scope
            .FindAll(TreeScope_Descendants, &condition)
            .map_err(|_| "menu_unknown")?;
        let mut out = Vec::new();
        for i in 0..found.Length().map_err(|_| "menu_unknown")? {
            let item = found.GetElement(i).map_err(|_| "menu_unknown")?;
            if !item
                .CurrentIsOffscreen()
                .map_err(|_| "menu_unknown")?
                .as_bool()
            {
                out.push(item);
            }
        }
        Ok(out)
    }
}
unsafe fn unique_named(
    rows: Vec<IUIAutomationElement>,
    names: &[&str],
) -> Result<IUIAutomationElement, String> {
    unsafe {
        let matching: Vec<_> = rows
            .into_iter()
            .filter(|e| {
                e.CurrentName()
                    .ok()
                    .is_some_and(|v| names.contains(&v.to_string().as_str()))
            })
            .collect();
        if matching.len() != 1 {
            return Err("menu_unknown".into());
        }
        Ok(matching.into_iter().next().unwrap())
    }
}
unsafe fn invoke(element: &IUIAutomationElement) -> Result<(), String> {
    unsafe {
        if let Ok(p) = element
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        {
            return p.Expand().map_err(|_| "menu_unknown".into());
        }
        element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .and_then(|p| p.Invoke())
            .map_err(|_| "menu_unknown".into())
    }
}
unsafe fn new_popup(
    ui: &IUIAutomation,
    root: &IUIAutomationElement,
    pid: i32,
    before: &[IUIAutomationElement],
) -> Result<IUIAutomationElement, String> {
    unsafe {
        let after = elements(ui, root, pid, UIA_MenuControlTypeId)?;
        let added: Vec<_> = after
            .into_iter()
            .filter(|item| {
                !before
                    .iter()
                    .any(|old| ui.CompareElements(old, item).is_ok_and(|v| v.as_bool()))
            })
            .collect();
        if added.len() != 1 {
            return Err("menu_unknown".into());
        }
        Ok(added.into_iter().next().unwrap())
    }
}
fn normal_exit(pids: &[Value]) -> Result<(), String> {
    if !unlocked_desktop() {
        return Err("locked".into());
    }
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|_| "menu_unknown")?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _com = Com;
        let ui: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "menu_unknown")?;
        let root = ui.GetRootElement().map_err(|_| "menu_unknown")?;
        let mut main = Vec::new();
        for pid in pids.iter().filter_map(Value::as_i64) {
            for window in elements(&ui, &root, pid as i32, UIA_WindowControlTypeId)? {
                if let Ok(p) =
                    window.GetCurrentPatternAs::<IUIAutomationWindowPattern>(UIA_WindowPatternId)
                {
                    if p.CurrentIsModal().map_err(|_| "modal")?.as_bool()
                        || p.CurrentWindowInteractionState().map_err(|_| "modal")?
                            == WindowInteractionState_BlockedByModalWindow
                    {
                        return Err("modal".into());
                    }
                }
                if window
                    .CurrentName()
                    .ok()
                    .is_some_and(|n| n.to_string() == "Claude")
                {
                    main.push((pid as i32, window));
                }
            }
        }
        if main.len() != 1 {
            return Err("menu_unknown".into());
        }
        let (pid, window) = main.remove(0);
        // Electron web dialogs may not expose WindowPattern.IsModal. Match
        // their dialog role as well, within this official main window.
        for role in ["dialog", "alertdialog"] {
            let condition = ui
                .CreatePropertyCondition(UIA_AriaRolePropertyId, &VARIANT::from(role))
                .map_err(|_| "modal")?;
            let dialogs = window
                .FindAll(TreeScope_Descendants, &condition)
                .map_err(|_| "modal")?;
            for i in 0..dialogs.Length().map_err(|_| "modal")? {
                if !dialogs
                    .GetElement(i)
                    .map_err(|_| "modal")?
                    .CurrentIsOffscreen()
                    .map_err(|_| "modal")?
                    .as_bool()
                {
                    return Err("modal".into());
                }
            }
        }
        for row in elements(&ui, &window, pid, UIA_TextControlTypeId)?
            .into_iter()
            .chain(elements(&ui, &window, pid, UIA_ButtonControlTypeId)?)
        {
            let text = row
                .CurrentName()
                .map_err(|_| "status_unknown")?
                .to_string()
                .to_lowercase();
            if (text.contains("running task") || text.contains("运行中的任务"))
                && !text.starts_with("0 ")
            {
                return Err("tasks_running".into());
            }
        }
        // Verified official path is Menu → File → Exit. Each submenu must be
        // newly created by this action and owned by the official process.
        let menu = unique_named(
            elements(&ui, &window, pid, UIA_ButtonControlTypeId)?,
            &["Menu", "菜单"],
        )?;
        let before = elements(&ui, &root, pid, UIA_MenuControlTypeId)?;
        if !before.is_empty() {
            return Err("menu_unknown".into());
        }
        invoke(&menu)?;
        std::thread::sleep(Duration::from_millis(400));
        let popup = new_popup(&ui, &root, pid, &before)?;
        let file = unique_named(
            elements(&ui, &popup, pid, UIA_MenuItemControlTypeId)?,
            &["File", "文件", "文件(F)"],
        )?;
        let before = elements(&ui, &root, pid, UIA_MenuControlTypeId)?;
        invoke(&file)?;
        std::thread::sleep(Duration::from_millis(400));
        let submenu = new_popup(&ui, &root, pid, &before)?;
        let exit = unique_named(
            elements(&ui, &submenu, pid, UIA_MenuItemControlTypeId)?,
            &["Exit", "退出", "退出(X)"],
        )?;
        invoke(&exit)
    }
}
fn check_profile_helpers(installed: &Value, changing: bool) -> Result<(), String> {
    if !changing {
        return Ok(()); // Reopen never changes the profile or closes the browser.
    }
    match installed["browserHelperBlockingCount"].as_u64()
        .or_else(|| installed["browserHelperCount"].as_u64()) {
        Some(0) => Ok(()),
        Some(_) => Err("browser_extension_active".into()),
        None => Err("status_unknown".into()),
    }
}
fn switch_inner(ctx: &Context, to: &str, action: &str) -> Result<Value, String> {
    if !unlocked_desktop() {
        return Err("locked".into());
    }
    let state = node(&ctx.dir, &["state"])?;
    if state["awaitingLogin"] == true { return Err("onboarding_pending".into()); }
    let from = state["active"].as_str().ok_or("link_unknown")?;
    if !state["profiles"]
        .as_array()
        .is_some_and(|r| r.iter().any(|p| p["id"].as_str() == Some(to)))
    {
        return Err("invalid_request".into());
    }
    let installed = info(&ctx.dir)?;
    check_profile_helpers(&installed, action == "switch" && from != to)?;
    if installed["version"] != state["desktopVersion"] {
        return Err("version_changed".into());
    }
    let executable = installed["executable"].as_str().ok_or("component_failed")?;
    let pids = installed["desktopPids"]
        .as_array()
        .cloned()
        .ok_or("status_unknown")?;
    if action == "switch" && from != to {
        if !pids.is_empty() {
            ctx.phase("closing", None)?;
            normal_exit(&pids)?;
            let start = Instant::now();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let now = info(&ctx.dir)?;
                check_profile_helpers(&now, true)?;
                if now["desktopPids"].as_array().is_some_and(Vec::is_empty)
                    && now["helperCount"].as_u64() == Some(0)
                {
                    break;
                }
                if start.elapsed() > Duration::from_secs(100) {
                    return Err("exit_pending".into());
                }
            }
        }
        ctx.phase("syncing", None)?;
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-File"])
            .arg(ctx.dir.join("switch-profile.ps1"))
            .args(["-From", from, "-To", to, "-OwnerConfirmedExit"]);
        if let Err(e) = run(cmd, Duration::from_secs(180), Some(ctx)) {
            // A still-running helper owns the lock. Never relaunch during it.
            if e != "helper_timeout"
                && node(&ctx.dir, &["state"])
                    .ok()
                    .is_some_and(|s| s["active"].as_str() == Some(from))
            {
                let _ = Command::new(executable).spawn();
            }
            return Err(e);
        }
    }
    let after = node(&ctx.dir, &["state"])?;
    if after["active"].as_str() != Some(to) {
        return Err("link_unknown".into());
    }
    ctx.phase("opening", None)?;
    Command::new(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "launch_failed")?;
    let start = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if info(&ctx.dir).ok().is_some_and(|state| {
            state["desktopPids"]
                .as_array()
                .is_some_and(|p| !p.is_empty())
        }) {
            return Ok(after);
        }
        if start.elapsed() > Duration::from_secs(20) {
            return Err("launch_failed".into());
        }
    }
}
fn execute(
    app: Option<&AppHandle>,
    to: &str,
    id: &str,
    origin: &str,
    action: &str,
) -> Result<Value, String> {
    if !ACCOUNT_SWITCH_ENABLED {
        return Err("account_switch_disabled".into());
    }
    let _guard = SWITCH.try_lock().map_err(|_| "busy")?;
    let _process_guard = ProcessMutex::acquire()?;
    let ctx = Context {
        app,
        dir: resources(app)?,
        id: id.into(),
        pid: std::process::id().to_string(),
    };
    let claimed = if action == "repair" {
        if !unlocked_desktop() {
            return Err("locked".into());
        }
        let info = info(&ctx.dir)?;
        if !info["desktopPids"].as_array().is_some_and(Vec::is_empty)
            || info["helperCount"].as_u64() != Some(0)
        {
            return Err("operation_active".into());
        }
        node(&ctx.dir, &["operation", "repair", id, &ctx.pid, origin])?
    } else {
        node(
            &ctx.dir,
            &["operation", "begin", id, &ctx.pid, to, origin, action],
        )?
    };
    if claimed["replay"] == true {
        return Ok(claimed);
    }
    let result = if action == "repair" {
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-File"])
            .arg(ctx.dir.join("recover-profile.ps1"));
        run(command, Duration::from_secs(45), Some(&ctx)).and_then(|_| {
            switch_inner(
                &ctx,
                claimed["to"].as_str().ok_or("link_unknown")?,
                "reopen",
            )
        })
    } else {
        switch_inner(&ctx, to, action)
    };
    let code = result.as_ref().err().map(String::as_str).unwrap_or("ok");
    let done = node(&ctx.dir, &["operation", "finish", id, &ctx.pid, code])?;
    if let Some(app) = app {
        let _ = app.emit("claude-profile-progress", &done);
    }
    result
}
/// Called before the single-instance plugin. Never opens a WebView.
pub fn headless() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--claude-account-switch") {
        return false;
    }
    let result = if args.len() == 5 {
        execute(None, &args[2], &args[3], "phone", &args[4])
    } else {
        Err("invalid_request".into())
    };
    println!(
        "{}",
        match result {
            Ok(_) => json!({"ok":true}),
            Err(code) => json!({"ok":false,"code":code}),
        }
    );
    true
}
#[tauri::command]
pub async fn claude_profiles(app: AppHandle) -> Result<Value, String> {
    crate::run_blocking(move || {
        if !ACCOUNT_SWITCH_ENABLED { return Err("account_switch_disabled".into()); }
        let dir = resources(Some(&app))?;
        let mut state = node(&dir, &["state"])?;
        state["operation"] = if state["configured"] == true {
            node(&dir, &["operation", "state"])?
        } else {
            json!({"busy":false})
        };
        Ok(state)
    })
    .await
}
#[tauri::command]
pub async fn claude_switch(
    app: AppHandle,
    profile: String,
    action: Option<String>,
) -> Result<Value, String> {
    crate::run_blocking(move || {
        execute(
            Some(&app),
            &profile,
            &format!("desktop-{}-{}", crate::now_ms(), rand::random::<u64>()),
            "desktop",
            action.as_deref().unwrap_or("switch"),
        )
    })
    .await
}
#[tauri::command]
pub async fn claude_rename(app: AppHandle, profile: String, name: String) -> Result<Value, String> {
    crate::run_blocking(move || {
        if !ACCOUNT_SWITCH_ENABLED { return Err("account_switch_disabled".into()); }
        let _guard = SWITCH.try_lock().map_err(|_| "busy")?;
        let dir = resources(Some(&app))?;
        if node(&dir, &["operation", "state"])?["busy"] == true {
            return Err("busy".into());
        }
        node(&dir, &["rename", &profile, &name])
    })
    .await
}
#[tauri::command]
pub async fn claude_profile_manage(app: AppHandle, profile: String, action: String) -> Result<Value, String> {
    crate::run_blocking(move || {
        if !ACCOUNT_SWITCH_ENABLED { return Err("account_switch_disabled".into()); }
        if !["remove", "restore"].contains(&action.as_str()) { return Err("invalid_request".into()); }
        let _guard = SWITCH.try_lock().map_err(|_| "busy")?;
        let _process_guard = ProcessMutex::acquire()?;
        let dir = resources(Some(&app))?;
        // The Node registry also holds a two-phase desktop-operation lease,
        // protecting this brief write against headless/phone switch claims.
        node(&dir, &[&action, &profile])
    }).await
}
#[tauri::command]
pub async fn claude_profile_create(app: AppHandle, name: String) -> Result<Value, String> {
    crate::run_blocking(move || {
        if !ACCOUNT_SWITCH_ENABLED { return Err("account_switch_disabled".into()); }
        let _guard = SWITCH.try_lock().map_err(|_| "busy")?;
        let _process_guard = ProcessMutex::acquire()?;
        let dir = resources(Some(&app))?;
        node(&dir, &["onboard", "create", &name])
    }).await
}
fn check_enrollment(installed: &Value, state: &Value) -> Result<(), String> {
    if installed["version"] != state["desktopVersion"] { return Err("version_changed".into()); }
    if !installed["desktopPids"].as_array().is_some_and(Vec::is_empty)
        || installed["helperCount"].as_u64() != Some(0)
        || installed["browserHelperBlockingCount"].as_u64() != Some(0) {
        return Err("onboarding_exit_required".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn claude_profile_onboard(app: AppHandle, profile: String, action: String) -> Result<Value, String> {
    crate::run_blocking(move || {
        if !ACCOUNT_SWITCH_ENABLED { return Err("account_switch_disabled".into()); }
        if !["open", "complete", "return"].contains(&action.as_str()) { return Err("invalid_request".into()); }
        let _guard = SWITCH.try_lock().map_err(|_| "busy")?;
        let _process_guard = ProcessMutex::acquire()?;
        if !unlocked_desktop() { return Err("locked".into()); }
        let dir = resources(Some(&app))?;
        let before = node(&dir, &["state"])?;
        let installed = info(&dir)?;
        check_enrollment(&installed, &before)?;
        let executable = installed["executable"].as_str().ok_or("component_failed")?;
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-File"])
            .arg(dir.join("profile-enroll.ps1")).args(["-Profile", &profile, "-Action", &action]);
        // This helper owns its durable lock. A timeout must not kill it midway
        // through the index transaction or leave a child mutating after unlock.
        let result: Value = serde_json::from_str(&run_child(cmd, Duration::from_secs(300), None, false)?)
            .map_err(|_| "component_failed")?;
        if result["launch"] == true {
            Command::new(executable).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|_| "launch_failed")?;
            let started = Instant::now();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                if info(&dir)?.get("desktopPids").and_then(Value::as_array).is_some_and(|p| !p.is_empty()) { break; }
                if started.elapsed() > Duration::from_secs(20) { return Err("launch_failed".into()); }
            }
        }
        node(&dir, &["state"])
    }).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enrollment_requires_offline_official_desktop_and_profile_helpers() {
        let state = json!({"desktopVersion":"fixture"});
        let info = json!({"version":"fixture","desktopPids":[],"helperCount":0,"browserHelperBlockingCount":0});
        assert!(check_enrollment(&info, &state).is_ok());
        for (key, value) in [("desktopPids",json!([123])),("helperCount",json!(1)),("browserHelperBlockingCount",json!(1))] {
            let mut blocked = info.clone(); blocked[key] = value;
            assert_eq!(check_enrollment(&blocked, &state), Err("onboarding_exit_required".into()));
        }
        assert_eq!(check_enrollment(&info, &json!({"desktopVersion":"changed"})), Err("version_changed".into()));
        assert!(check_enrollment(&json!({"version":"fixture"}), &state).is_err());
    }
    #[test]
    fn browser_extension_blocks_before_exit_and_allows_reopen() {
        assert_eq!(
            check_profile_helpers(&json!({"browserHelperCount": 1}), true),
            Err("browser_extension_active".into())
        );
        assert!(check_profile_helpers(&json!({"browserHelperCount": 0}), true).is_ok());
        assert!(check_profile_helpers(&json!({"browserHelperCount": 1, "browserHelperBlockingCount": 0, "independentBrowserHelperCount": 1}), true).is_ok());
        assert_eq!(check_profile_helpers(&json!({"browserHelperCount": 0, "browserHelperBlockingCount": 1}), true), Err("browser_extension_active".into()));
        assert_eq!(
            check_profile_helpers(&json!({}), true),
            Err("status_unknown".into())
        );
        assert!(check_profile_helpers(&json!({"browserHelperCount": 1}), false).is_ok());
    }
    #[test]
    fn installed_resource_paths() {
        assert_eq!(
            child_path(PathBuf::from(r"\\?\C:\Users\me\AppData\Local\KH Link")),
            PathBuf::from(r"C:\Users\me\AppData\Local\KH Link")
        );
        assert_eq!(
            child_path(PathBuf::from(r"\\?\UNC\host\share")),
            PathBuf::from(r"\\host\share")
        );
    }
}
