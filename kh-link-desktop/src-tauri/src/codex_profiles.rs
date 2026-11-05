//! Independent official Codex instances. Never closes the caller's Desktop,
//! moves its data, reads authentication files, or changes connector identity.
use std::{path::PathBuf, process::{Command, Stdio}, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use std::os::windows::process::CommandExt;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use windows::core::BOOL;
use windows::Win32::{Foundation::{HWND, LPARAM}, UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindowAsync, SW_RESTORE}};

static OPERATION: Mutex<()> = Mutex::new(());
static INFO: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
const VERIFIED_VERSIONS: &[&str] = &["26.1007.2314.0", "26.1007.9446.0"];
fn verified_version(value: &Value) -> bool {
    value.as_str().is_some_and(|version| VERIFIED_VERSIONS.contains(&version))
}
fn resources(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::claude_profiles::child_path(app.path().resource_dir().map_err(|_| "安装资源路径不可用。")?).join("codex-switch");
    if dir.join("console.cjs").is_file() { return Ok(dir); }
    #[cfg(debug_assertions)] {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ops/codex-switch");
        if dir.join("console.cjs").is_file() { return Ok(dir); }
    }
    Err("Codex 账号组件缺失，请重新安装 khLink。".into())
}
fn run(mut command: Command) -> Result<Value, String> {
    command.creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command.spawn().map_err(|_| "无法启动本地账号组件。")?;
    let output = child.wait_with_output().map_err(|_| "账号组件执行失败。")?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(if message.trim().is_empty() { "本地账号操作失败。".into() } else { message.trim().chars().take(300).collect() });
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "账号组件返回了无效数据。".into())
}
fn node(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    let exe = PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_default()).join("nodejs/node.exe");
    let mut command = Command::new(if exe.is_file() { exe } else { PathBuf::from("node.exe") });
    command.arg(resources(app)?.join("console.cjs")).args(args).env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    run(command)
}
fn info(app: &AppHandle, fresh: bool) -> Result<Value, String> {
    let mut cache = INFO.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "安装信息繁忙。")?;
    if !fresh { if let Some((at, data)) = &*cache { if at.elapsed() < Duration::from_secs(10) { return Ok(data.clone()); } } }
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-File"]).arg(resources(app)?.join("desktop-info.ps1"));
    let data = run(command)?; *cache = Some((Instant::now(), data.clone())); Ok(data)
}
fn same_profile(process: &Value, profile: &Value) -> bool {
    match (process["userData"].as_str(), profile["userData"].as_str()) {
        (None, None) => profile["primary"] == true,
        (Some(a), Some(b)) => a.trim_end_matches(['/', '\\']).replace('/', "\\").eq_ignore_ascii_case(&b.trim_end_matches(['/', '\\']).replace('/', "\\")),
        _ => false,
    }
}
fn decorate(mut state: Value, installed: Result<Value, String>) -> Value {
    state["remoteIsolationReady"] = json!(remote_isolation_ready(&crate::connector_status(), crate::now_ms()));
    match installed {
        Ok(data) => {
            state["available"] = json!(true); state["desktopVersion"] = data["version"].clone();
            state["isolatedSupported"] = json!(verified_version(&data["version"]));
            if let Some(profiles) = state["profiles"].as_array_mut() { for profile in profiles {
                profile["running"] = json!(data["processes"].as_array().is_some_and(|rows| rows.iter().any(|p| same_profile(p, profile))));
                // Filesystem paths stay in the Rust helper. Only the managed
                // root and public account/usage data reach the WebView.
                profile.as_object_mut().unwrap().remove("home"); profile.as_object_mut().unwrap().remove("userData");
            } }
        }
        Err(_) => { state["available"] = json!(false); state["message"] = json!("未找到可用的官方 Codex Desktop。安装后可在这里管理账号。");
            if let Some(profiles) = state["profiles"].as_array_mut() { for p in profiles { p["running"] = json!(false); p.as_object_mut().unwrap().remove("home"); p.as_object_mut().unwrap().remove("userData"); } }
        }
    }
    state
}
fn remote_isolation_ready(status: &Value, now: u64) -> bool {
    status["codexProfileIsolation"] == true && status["updatedAt"].as_u64().is_some_and(|at| at <= now && now-at < 30_000)
}
fn state_inner(app: &AppHandle, refresh: bool, force: bool) -> Result<Value, String> {
    let installed = info(app, false); let state = node(app, &["state"])?;
    let selected = state["selected"].as_str().unwrap_or("default");
    let state = if refresh {
        if let Ok(ref data) = installed { node(app, &["refresh", selected, data["cli"].as_str().ok_or("官方程序路径不可用。")?, if force { "force" } else { "cached" }])? } else { state }
    } else { state };
    Ok(decorate(state, installed))
}
struct WindowSearch { pid: u32, window: Option<HWND> }
unsafe extern "system" fn find_window(window: HWND, param: LPARAM) -> BOOL {
    unsafe { let search = &mut *(param.0 as *mut WindowSearch); let mut pid = 0; GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == search.pid && IsWindowVisible(window).as_bool() { search.window = Some(window); return BOOL(0); } BOOL(1) }
}
fn focus(pid: u32) -> bool {
    let mut search = WindowSearch { pid, window: None };
    unsafe { let _ = EnumWindows(Some(find_window), LPARAM(&mut search as *mut _ as isize));
        if let Some(window) = search.window { let _ = ShowWindowAsync(window, SW_RESTORE); return SetForegroundWindow(window).as_bool(); } }
    false
}
fn isolated_environment(command: &mut Command, profile: &Value) -> Result<(), String> {
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if ["CODEX_", "OPENAI_", "ANTHROPIC_", "CLAUDE_", "ELECTRON_"].iter().any(|prefix| upper.starts_with(prefix)) || ["NODE_OPTIONS", "NODE_PATH"].contains(&upper.as_str()) { command.env_remove(&key); }
    }
    command.env("CODEX_HOME", profile["home"].as_str().ok_or("账号目录无效。")?);
    if let Some(dir) = profile["userData"].as_str() { command.env("CODEX_ELECTRON_USER_DATA_PATH", dir).arg(format!("--user-data-dir={dir}")); }
    Ok(())
}
#[tauri::command]
pub async fn codex_profiles(app: AppHandle, refresh: Option<bool>, force: Option<bool>) -> Result<Value, String> {
    crate::run_blocking(move || { let _lock = OPERATION.try_lock().map_err(|_| "正在处理 Codex 账号，请稍候。")?; state_inner(&app, refresh.unwrap_or(false), force.unwrap_or(false)) }).await
}
#[tauri::command]
pub async fn codex_profile_create(app: AppHandle, name: String) -> Result<Value, String> {
    crate::run_blocking(move || { let _lock = OPERATION.try_lock().map_err(|_| "正在处理 Codex 账号，请稍候。")?;
        let installed = info(&app, true)?;
        if !verified_version(&installed["version"]) { return Err("此 Codex 版本尚未验证独立账号目录，暂未创建账号。".into()); }
        let profile = node(&app, &["create", &name])?;
        Ok(json!({"id":profile["id"],"state":state_inner(&app,false,false)?})) }).await
}
#[tauri::command]
pub async fn codex_profile_rename(app: AppHandle, profile: String, name: String) -> Result<Value, String> {
    crate::run_blocking(move || { let _lock = OPERATION.try_lock().map_err(|_| "正在处理 Codex 账号，请稍候。")?;
        let state = node(&app, &["rename", &profile, &name])?; Ok(decorate(state, info(&app,false))) }).await
}
#[tauri::command]
pub async fn codex_profile_open(app: AppHandle, profile: String) -> Result<Value, String> {
    crate::run_blocking(move || {
        let _lock = OPERATION.try_lock().map_err(|_| "正在打开 Codex 账号，请稍候。")?;
        let target = node(&app, &["profile", &profile])?; let installed = info(&app, true)?;
        if target["primary"] != true && !remote_isolation_ready(&crate::connector_status(),crate::now_ms()) {
            return Err("请先运行更新后的 khLink 连接器（0.2.67 或更新版），以确保手机只控制默认账号。备用账号目录已保留。".into());
        }
        if target["primary"] != true && !verified_version(&installed["version"]) { return Err("Codex 已升级，需核对独立账号目录支持后再打开。".into()); }
        let existing = installed["processes"].as_array().and_then(|ps|ps.iter().find(|p| same_profile(p,&target))).and_then(|p|p["pid"].as_u64());
        let focused = existing.is_some_and(|pid| focus(pid as u32));
        if !focused {
            // The official single-instance lock belongs to its user-data path.
            // Relaunching the same path asks that instance to show its window.
            let mut command = Command::new(installed["executable"].as_str().ok_or("官方程序路径不可用。")?);
            isolated_environment(&mut command,&target)?;
            command.current_dir(target["home"].as_str().ok_or("账号目录不可用。")?).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x08000000).spawn().map_err(|_| "无法打开官方 Codex。原账号保持不变。")?;
            let start = Instant::now();
            loop { std::thread::sleep(Duration::from_millis(800));
                let current = info(&app,true)?;
                if current["processes"].as_array().is_some_and(|ps|ps.iter().any(|p|same_profile(p,&target))) { break; }
                if start.elapsed()>Duration::from_secs(20) { return Err("官方窗口尚未打开，请稍后重试；账号数据已保留。".into()); }
            }
        }
        node(&app, &["select", &profile])?;
        state_inner(&app,false,false)
    }).await
}

#[tauri::command]
pub async fn codex_profile_manage(app: AppHandle, profile: String, action: String) -> Result<Value, String> {
    crate::run_blocking(move || {
        if !["remove", "restore"].contains(&action.as_str()) { return Err("不支持的账号管理操作。".into()); }
        let _lock = OPERATION.try_lock().map_err(|_| "正在处理 Codex 账号，请稍候。")?;
        // Only edits local registration; running official windows and data stay untouched.
        let state = node(&app, &[&action, &profile])?;
        Ok(decorate(state, info(&app, false)))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn instance_matching_never_confuses_default_and_isolated_accounts() {
        let default = json!({"primary":true,"userData":null}); let other = json!({"primary":false,"userData":"G:\\Apps\\CodexSwitch\\profiles\\a\\desktop"});
        assert!(same_profile(&json!({"userData":null}), &default));
        assert!(!same_profile(&json!({"userData":null}), &other));
        assert!(same_profile(&json!({"userData":"g:/apps/codexswitch/profiles/a/desktop/"}), &other));
        assert!(!same_profile(&json!({"userData":"G:\\Apps\\CodexSwitch\\profiles\\b\\desktop"}), &other));
    }
    #[test] fn public_state_excludes_private_filesystem_paths() {
        let state = json!({"profiles":[{"id":"default","primary":true,"home":"private","userData":null}]});
        for info in [Ok(json!({"version":VERIFIED_VERSIONS[1],"processes":[{"pid":123,"userData":null}]})),Err("missing".into())] {
            let result=decorate(state.clone(),info); assert!(result["profiles"][0].get("home").is_none()); assert!(result["profiles"][0].get("userData").is_none());
        }
    }
    #[test] fn isolated_launch_requires_recent_native_adapter_capability() {
        assert!(remote_isolation_ready(&json!({"codexProfileIsolation":true,"updatedAt":1000}),2000));
        assert!(!remote_isolation_ready(&json!({"updatedAt":1000}),2000));
        assert!(!remote_isolation_ready(&json!({"codexProfileIsolation":true,"updatedAt":1000}),32000));
        assert!(!remote_isolation_ready(&json!({"codexProfileIsolation":true,"updatedAt":9999}),2000));
    }
}
