use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read},
    fs::OpenOptions,
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use uiautomation::controls::ControlType;
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UISelectionItemPattern, UITogglePattern, UIValuePattern,
};
use uiautomation::types::{ExpandCollapseState, ToggleState, TreeScope, UIProperty};
use uiautomation::{UIAutomation, UIElement};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, SendInput,
    VIRTUAL_KEY,
};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE,
    SetForegroundWindow, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PWSTR};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    action: String,
    #[serde(skip)]
    transport_id: Option<u64>,
    request_id: Option<String>,
    thread_id: Option<String>,
    title: Option<String>,
    #[serde(default)]
    known_titles: Vec<String>,
    mode: Option<String>,
    text: Option<String>,
    #[serde(default)]
    attachments: Vec<Attachment>,
    target: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<String>,
    permission_mode: Option<String>,
    collaboration_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    name: String,
    path: String,
    #[allow(dead_code)]
    size: u64,
    #[allow(dead_code)]
    mime_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    ok: bool,
    code: String,
    message: String,
    delivery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    items: Option<Vec<DesktopQueuedItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effective_collaboration_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desired_collaboration_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode_sync_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_presence: Option<AgentPresence>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPresence {
    codex: bool,
    claude: bool,
    antigravity: bool,
    codex_profile_isolation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopQueuedItem {
    text: String,
    order: usize,
}

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--serve") {
        return serve();
    }
    let mut raw = String::new();
    if io::stdin().read_to_string(&mut raw).is_err() {
        return print(error("invalid_input", "Cannot read request", "not_sent"), 2);
    }
    let request: Request = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => {
            return print(
                error("invalid_input", "Invalid JSON request", "not_sent"),
                2,
            );
        }
    };
    let result = run(request);
    let code = if result.ok {
        0
    } else if result.delivery == "uncertain" {
        3
    } else {
        2
    };
    print(result, code);
}

// A one-shot process pays a full Windows process spawn plus a fresh COM/UI
// Automation client init on every single probe or dispatch. That per-call
// startup cost is the likely reason probes run close enough to their
// timeout to fail intermittently (observed repeatedly as "Desktop adapter
// timed out" from the connector's periodic queue scan). `--serve` keeps one
// process alive across many requests, framed as newline-delimited
// `{"id", "request"}` -> `{"id", "response"}` JSON so the Node side can
// correlate concurrent probes. `run()` itself is untouched: each request
// still creates its own `UIAutomation` instance, so none of the existing
// automation/tree-walking logic changes.
fn serve() {
    use std::io::{BufRead, Write};
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let envelope: ServeEnvelope = match serde_json::from_str(&line) {
            Ok(value) => value,
            // A malformed line must not silently desync the stream forever;
            // there is no id to reply to, so just drop this one line and
            // keep serving the rest of the connection.
            Err(_) => continue,
        };
        let mut request = envelope.request;
        request.transport_id = Some(envelope.id);
        let response = run(request);
        let out = ServeResponseEnvelope {
            id: envelope.id,
            response,
        };
        let Ok(encoded) = serde_json::to_string(&out) else {
            continue;
        };
        if writeln!(stdout, "{encoded}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

#[derive(Deserialize)]
struct ServeEnvelope {
    id: u64,
    request: Request,
}

#[derive(Serialize)]
struct ServeResponseEnvelope {
    id: u64,
    response: Response,
}

fn run(request: Request) -> Response {
    let started = Instant::now();
    // Presence is deliberately checked before constructing UI Automation. It
    // only enumerates top-level windows and process image paths, so it remains
    // cheap and still works when Codex Desktop is closed.
    if request.action == "agent_presence" {
        return agent_presence_snapshot();
    }
    let automation = match UIAutomation::new() {
        Ok(value) => value,
        Err(_) => {
            return error(
                "uia_unavailable",
                "Windows UI Automation is unavailable",
                "not_sent",
            );
        }
    };
    trace("automation", started);
    if request.action == "probe" {
        let Some(root) = codex_root(&automation) else {
            return error(
                "desktop_not_ready",
                "Codex Desktop was not found",
                "not_sent",
            );
        };
        // A targeted probe must be read-only.  It never navigates to the task
        // and never focuses the window; this keeps a background mobile send
        // from stealing the user's foreground Desktop session.
        if request.thread_id.is_some() {
            if request
                .thread_id
                .as_deref()
                .map(thread_writer_lock_is_held)
                .unwrap_or(false)
            {
                return ok(
                    "task_active",
                    "The requested Codex task has an active writer lock",
                );
            }
            let selected = request
                .title
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|title| is_active_task(&automation, &root, title))
                .unwrap_or(false);
            if selected {
                // Entering a long task can leave the composer unavailable for
                // a few seconds while its history is restored. It is still a
                // Desktop-owned task during that window. Returning
                // `task_active` here keeps mobile attachments in the durable
                // queue instead of starting a competing app-server writer.
                let message = if find_composer_in(&automation, &root).is_some() {
                    "The requested Codex task is the active Desktop writer"
                } else {
                    "The requested Codex task is active and still loading"
                };
                return ok("task_active", message);
            }
            if find_composer(&automation).is_some() {
                return error(
                    "desktop_other_task",
                    "Codex Desktop is open on another task; background protocol may write this task",
                    "not_sent",
                );
            }
            return error(
                "desktop_present",
                "Codex Desktop is open but its composer is still loading",
                "not_sent",
            );
        }
        return if find_composer_in(&automation, &root).is_some() {
            ok("ready", "Codex Desktop adapter is ready")
        } else {
            error(
                "desktop_present",
                "Codex Desktop is open but its composer is still loading",
                "not_sent",
            )
        };
    }
    if request.action == "inspect" {
        if let Some(root) = codex_root(&automation) {
            dump_controls(&automation, &root);
            return ok("inspected", "Codex Desktop controls were listed");
        }
        return error(
            "desktop_not_ready",
            "Codex Desktop was not found",
            "not_sent",
        );
    }
    if request.action == "inspect_queue" {
        let id = request.thread_id.as_deref().unwrap_or_default();
        if !valid_thread_id(id) { return error("invalid_thread_id", "A valid task id is required", "not_sent"); }
        let root = match select_requested_task(&automation, id, request.title.as_deref()) {
            Ok(root) => root, Err(message) => return error("task_identity_unconfirmed", &message, "not_sent"),
        };
        return if find_queued_action(&automation, &root, request.text.as_deref().unwrap_or_default(), steer_action_names()).is_some() {
            ok("queue_action_available", "The matching queue action is available")
        } else { error("queue_action_missing", "The matching queue action is unavailable", "not_sent") };
    }
    if request.action == "open_thread" {
        let thread_id = request.thread_id.as_deref().unwrap_or_default();
        // Only navigate: never submit a prompt, dismiss a writer conflict or
        // change permissions. The protocol queue submits the message later.
        if request.title.as_deref().unwrap_or_default().trim().is_empty() {
            return error("missing_task_title", "The target task title is required", "not_sent");
        }
        let previous = unsafe { GetForegroundWindow() };
        let result = match select_requested_task(&automation, thread_id, request.title.as_deref()) {
            Ok(_) => ok("task_opened", "Codex Desktop opened the requested task"),
            Err(message) => error("task_identity_unconfirmed", &message, "not_sent"),
        };
        restore_foreground(previous);
        return result;
    }
    if request.action == "list_queued" {
        return list_queued(&automation, &request);
    }
    if request.action == "click" {
        let Some(root) = codex_root(&automation) else {
            return error(
                "desktop_not_ready",
                "Codex Desktop was not found",
                "not_sent",
            );
        };
        let target = request.target.as_deref().unwrap_or_default();
        if target.is_empty() {
            return error("missing_target", "A control name is required", "not_sent");
        }
        let mut clicked = false;
        for element in descendants_named(&automation, &root, target) {
            eprintln!(
                "click-candidate type={:?} process={:?} offscreen={:?} class={:?}",
                element.get_control_type().ok(),
                element.get_process_id().ok(),
                element.is_offscreen().ok(),
                element.get_classname().ok()
            );
            if !matches!(
                element.get_control_type().ok(),
                Some(ControlType::Button) | Some(ControlType::MenuItem)
            ) || element.is_offscreen().unwrap_or(true)
            {
                continue;
            }
            if let Ok(pattern) = element.get_pattern::<UIInvokePattern>() {
                if pattern.invoke().is_ok() {
                    clicked = true;
                    break;
                }
            }
            if let Ok(pattern) = element.get_pattern::<UIExpandCollapsePattern>() {
                let changed = match pattern.get_state().ok() {
                    Some(
                        ExpandCollapseState::Expanded | ExpandCollapseState::PartiallyExpanded,
                    ) => pattern.collapse().is_ok(),
                    _ => pattern.expand().is_ok(),
                };
                if changed {
                    clicked = true;
                    break;
                }
            }
        }
        return if clicked {
            ok("clicked", "Codex Desktop control was invoked")
        } else {
            error(
                "control_not_found",
                "Codex Desktop control was not found",
                "not_sent",
            )
        };
    }
    if request.action == "settings" {
        return apply_settings(&automation, request);
    }
    if request.action == "cancel" {
        return cancel(&automation, request);
    }
    if request.action == "steer_queued" {
        return steer_queued(&automation, request);
    }
    if request.action == "interrupt" {
        return interrupt(&automation, request);
    }
    if request.action != "dispatch" {
        return error(
            "unsupported_action",
            "Unsupported adapter action",
            "not_sent",
        );
    }
    if request.request_id.as_deref().unwrap_or_default().is_empty() {
        return error("missing_request_id", "requestId is required", "not_sent");
    }
    let thread_id = request.thread_id.as_deref().unwrap_or_default();
    if !valid_thread_id(thread_id) {
        return error(
            "invalid_thread_id",
            "A valid Codex task id is required",
            "not_sent",
        );
    }
    let previous = unsafe { GetForegroundWindow() };
    let root = match select_requested_task(&automation, thread_id, request.title.as_deref()) {
        Ok(value) => value,
        Err(message) => return error("task_identity_unconfirmed", &message, "not_sent"),
    };
    if desktop_queue_paused(&automation, &root) {
        restore_foreground(previous);
        return error("queue_paused", "The Codex Desktop queue is paused after an interruption", "not_sent");
    }
    trace("task", started);
    let composer = match wait_for_composer(&automation, &root) {
        Some(value) => value,
        None => {
            return error(
                "desktop_not_ready",
                "Codex Desktop composer was not found",
                "not_sent",
            );
        }
    };
    trace("composer", started);
    let text = request.text.unwrap_or_default();
    if text.trim().is_empty() {
        return error("empty_message", "Message is empty", "not_sent");
    }
    let pattern: UIValuePattern = match composer.get_pattern() {
        Ok(value) => value,
        Err(_) => {
            return error(
                "composer_unavailable",
                "Codex composer cannot be edited",
                "not_sent",
            );
        }
    };
    let old = match pattern.get_value() {
        Ok(value) => value,
        Err(_) => {
            restore_foreground(previous);
            return error("composer_unavailable", "Codex composer cannot be read safely", "not_sent");
        }
    };
    let name = composer.get_name().unwrap_or_default();
    if !is_blank_composer(&old, &name) {
        restore_foreground(previous);
        return error(
            "composer_busy",
            "Codex Desktop already contains an unsent draft",
            "not_sent",
        );
    }
    if !request.attachments.is_empty() {
        focus_codex();
        if let Err(message) = attach_files(&automation, &root, &request.attachments) {
            restore_foreground(previous);
            return error("attachment_not_confirmed", &message, "not_sent");
        }
        trace("attachments-confirmed", started);
    }

    // Desktop can re-render the editor between discovery and SetValue. Retry
    // only while a newly acquired editor is still blank. If anything appeared
    // after a failed write, leave it untouched and never submit it as ours.
    let title = request.title.as_deref().filter(|title| !title.trim().is_empty());
    let written = guarded_composer_write(
        &text,
        5,
        || {
            let live_root = live_root_or(&automation, &root);
            if title.is_some_and(|title| !is_active_task(&automation, &live_root, title)) {
                return None;
            }
            let composer = find_composer_in(&automation, &live_root)?;
            let pattern: UIValuePattern = composer.get_pattern().ok()?;
            let value = pattern.get_value().ok()?;
            let name = composer.get_name().unwrap_or_default();
            Some(((composer, pattern), value, name))
        },
        |(_, pattern), text| pattern.set_value(text).is_ok(),
        || thread::sleep(Duration::from_millis(150)),
    );
    let ((composer, pattern), name) = match written {
        Ok(value) => value,
        Err(failure) => {
            restore_foreground(previous);
            return match failure {
                ComposerWriteFailure::Busy => error("composer_busy", "Codex Desktop already contains an unsent draft", "not_sent"),
                ComposerWriteFailure::Unavailable => error("composer_unavailable", "Codex composer cannot be edited", "not_sent"),
                ComposerWriteFailure::Failed => error("composer_write_failed", "Could not enter text in Codex Desktop", "not_sent"),
            };
        }
    };
    trace("write", started);

    let mode = request.mode.as_deref().unwrap_or("queue");
    let mut sent = false;
    let mut task_changed = false;
    for _ in 0..20 {
        let live_root = live_root_or(&automation, &root);
        if title.is_some_and(|title| !is_active_task(&automation, &live_root, title)) {
            task_changed = true;
            break;
        }
        sent = invoke_named_button(
            &automation,
            &live_root,
            &composer,
            send_control_names(),
        );
        if sent {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    trace("queue-invoke", started);
    if !sent {
        // Only clear the exact text we placed there. Never replace a draft
        // that changed while we were looking for the send button.
        if pattern.get_value().ok().as_deref() == Some(text.as_str()) {
            let _ = pattern.set_value("");
        }
        restore_foreground(previous);
        if task_changed {
            return error("task_identity_unconfirmed", "The active Codex task changed before sending", "not_sent");
        }
        return error(
            "control_not_found",
            "Codex Desktop send control was not available",
            "not_sent",
        );
    }

    let mut confirmed = false;
    for _ in 0..24 {
        let live_root = live_root_or(&automation, &root);
        // A paused queue can open a dialog whose effect on every existing item
        // is not reliably observable. Leave it for the user rather than risk
        // losing a queued message or claiming an unconfirmed send succeeded.
        if is_queue_send_confirmation(&automation, &live_root) {
            break;
        }
        // Missing/stale UIA controls are unknown, not an empty editor. A text
        // node can also be the still-unsent draft, so do not count it as a
        // delivery receipt. Re-acquire the current editor and read its value.
        let remaining = find_composer_in(&automation, &live_root)
            .and_then(|editor| editor.get_pattern::<UIValuePattern>().ok())
            .and_then(|value| value.get_value().ok());
        if composer_confirmed_empty(remaining.as_deref(), &name) {
            confirmed = true;
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    restore_foreground(previous);
    if !confirmed {
        return error(
            "delivery_uncertain",
            "Codex Desktop did not confirm that the composer was cleared",
            "uncertain",
        );
    }
    if mode != "steer" {
        return ok("queued", "Accepted by Codex Desktop");
    }
    trace("queue-confirm", started);

    let mut action = None;
    for _ in 0..10 {
        action = find_queued_action(&automation, &root, &text, steer_action_names());
        if action.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    trace("steer-find", started);
    let Some(action) = action else {
        return ok(
            "steer_deferred",
            "Codex Desktop kept the message in the same-task queue",
        );
    };
    if action
        .get_pattern::<UIInvokePattern>()
        .and_then(|value| value.invoke())
        .is_err()
    {
        return ok(
            "steer_deferred",
            "Codex Desktop kept the message in the same-task queue",
        );
    }
    trace("steer-invoke", started);
    ok(
        "steer_accepted",
        "Accepted by the active Codex Desktop turn",
    )
}

#[derive(Debug, PartialEq, Eq)]
enum ComposerWriteFailure { Busy, Unavailable, Failed }

fn guarded_composer_write<T>(
    text: &str,
    attempts: usize,
    mut probe: impl FnMut() -> Option<(T, String, String)>,
    mut write: impl FnMut(&T, &str) -> bool,
    mut pause: impl FnMut(),
) -> Result<(T, String), ComposerWriteFailure> {
    let mut saw_editor = false;
    for attempt in 0..attempts {
        if let Some((target, current, name)) = probe() {
            saw_editor = true;
            if !is_blank_composer(&current, &name) {
                return Err(ComposerWriteFailure::Busy);
            }
            if write(&target, text) {
                return Ok((target, name));
            }
        }
        if attempt + 1 < attempts { pause(); }
    }
    Err(if saw_editor { ComposerWriteFailure::Failed } else { ComposerWriteFailure::Unavailable })
}

fn send_control_names() -> &'static [&'static str] {
    // Desktop 26.11 uses 排队 while a turn is running; older releases use 加入队列.
    &["加入队列", "排队", "Queue", "发送", "Send"]
}

fn composer_confirmed_empty(value: Option<&str>, name: &str) -> bool {
    value.is_some_and(|value| is_blank_composer(value, name))
}

fn queue_send_confirmation_names(names: &[String]) -> bool {
    names.iter().any(|name| name == "发送消息？")
        && names.iter().any(|name| name.contains("要清除之前已排队") && name.contains("消息"))
        && names.iter().any(|name| name == "清空队列")
        && names.iter().any(|name| name == "发送消息")
}

fn is_queue_send_confirmation(automation: &UIAutomation, root: &UIElement) -> bool {
    let names = [ControlType::Text, ControlType::Button, ControlType::Window]
        .into_iter()
        .flat_map(|kind| descendants_of_type(automation, root, kind))
        .filter(|element| !element.is_offscreen().unwrap_or(true))
        .filter_map(|element| element.get_name().ok())
        .collect::<Vec<_>>();
    queue_send_confirmation_names(&names)
}

fn is_queue_paused_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (value.contains("中断了当前响应") && value.contains("队列已暂停"))
        || (lower.contains("queue") && lower.contains("paused") && lower.contains("interrupted"))
}

fn desktop_queue_paused(automation: &UIAutomation, root: &UIElement) -> bool {
    descendants_of_type(automation, root, ControlType::Text)
        .into_iter()
        .filter(|element| !element.is_offscreen().unwrap_or(true))
        .filter_map(|element| element.get_name().ok())
        .any(|name| is_queue_paused_text(&name))
}

fn agent_presence_snapshot() -> Response {
    Response {
        ok: true,
        code: "agent_presence".into(),
        message: "Desktop agent windows were checked".into(),
        delivery: "confirmed".into(),
        active_title: None,
        items: None,
        effective_collaboration_mode: None,
        desired_collaboration_mode: None,
        mode_sync_state: None,
        reason: None,
        agent_presence: Some(detect_agent_presence()),
    }
}

/// Codex Desktop and its app-server protect loaded tasks with a per-thread
/// lock file. UI Automation only exposes the currently selected row, while a
/// task can remain loaded (and locked) after the user switches to another row.
/// Check the actual lock before allowing the connector's isolated host to
/// write the same thread. A stale zero-byte file is harmless: an exclusive
/// open succeeds and the file is treated as unlocked.
fn thread_writer_lock_is_held(thread_id: &str) -> bool {
    if !valid_thread_id(thread_id) {
        return false;
    }
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    let path = PathBuf::from(home)
        .join(".codex")
        .join("thread-writer-locks")
        .join(format!("{thread_id}.lock"));
    if !path.is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        // Do not mutate or remove the lock. Asking for no sharing is enough to
        // distinguish a live Codex writer from a leftover empty file.
        return OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .is_err();
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        true
    }
}

fn apply_settings(automation: &UIAutomation, request: Request) -> Response {
    let thread_id = request.thread_id.as_deref().unwrap_or_default();
    if !valid_thread_id(thread_id) {
        return error(
            "invalid_thread_id",
            "A valid Codex task id is required",
            "not_sent",
        );
    }
    if request.model.is_none()
        && request.effort.is_none()
        && request.service_tier.is_none()
        && request.permission_mode.is_none()
        && request.collaboration_mode.is_none()
    {
        return error(
            "empty_settings",
            "No desktop setting was requested",
            "not_sent",
        );
    }

    let previous = unsafe { GetForegroundWindow() };
    let mut root = match select_requested_task(automation, thread_id, request.title.as_deref()) {
        Ok(value) => value,
        Err(message) => return error("task_identity_unconfirmed", &message, "not_sent"),
    };
    // A previous YOLO request can leave Desktop's confirmation dialog open
    // while the adapter process has already returned. Close that idempotently
    // before looking up the settings menu so the next mobile request can retry.
    if !confirm_pending_full_access(automation) {
        restore_foreground(previous);
        return error(
            "approval_confirmation_failed",
            "Desktop did not close the full access confirmation",
            "not_sent",
        );
    }
    root = codex_root(automation).unwrap_or_else(|| root.clone());

    let result = (|| {
        if let Some(mode) = request.collaboration_mode.as_deref() {
            let desired = match mode.to_ascii_lowercase().as_str() {
                "plan" => "plan",
                "default" | "execute" => "default",
                _ => {
                    return mode_error(
                        "invalid_collaboration_mode",
                        "Unknown collaboration mode",
                        "not_sent",
                        None,
                        Some(mode),
                        "failed",
                    );
                }
            };
            root = codex_root(automation).unwrap_or(root);
            close_command_menu(automation, &root);
            root = codex_root(automation).unwrap_or(root);
            match apply_collaboration_mode(automation, &root, desired) {
                Ok(effective) if effective == desired => {}
                Ok(effective) => {
                    return mode_error(
                        "plan_mode_unverified",
                        "Codex Desktop did not confirm the requested collaboration mode",
                        "not_sent",
                        Some(&effective),
                        Some(desired),
                        "failed",
                    );
                }
                Err((code, message, effective)) => {
                    let sync_state = if code == "desktop_busy" {
                        "pending"
                    } else {
                        "failed"
                    };
                    return mode_error(
                        code,
                        &message,
                        "not_sent",
                        effective.as_deref(),
                        Some(desired),
                        sync_state,
                    );
                }
            }
            thread::sleep(Duration::from_millis(120));
            root = codex_root(automation).unwrap_or(root);
        }
        if let Some(model) = request.model.as_deref() {
            if let Err(failure) = apply_composer_category(automation, &root, "model", "模型 ", model, |name| {
                model_menu_matches(name, model)
            }) {
                return menu_error("model", failure);
            }
            thread::sleep(Duration::from_millis(120));
            root = codex_root(automation).unwrap_or(root);
        }
        if let Some(effort) = request.effort.as_deref() {
            if let Err(failure) = apply_composer_category(automation, &root, "effort", "推理强度 ", effort, |name| {
                effort_menu_matches(name, effort)
            }) {
                return menu_error("effort", failure);
            }
            thread::sleep(Duration::from_millis(120));
            root = codex_root(automation).unwrap_or(root);
        }
        if let Some(tier) = request.service_tier.as_deref() {
            if let Err(failure) = apply_composer_category(automation, &root, "service_tier", "速度 ", tier, |name| {
                tier_menu_matches(name, tier)
            }) {
                return menu_error("service_tier", failure);
            }
            thread::sleep(Duration::from_millis(120));
        }
        // Apply approval last. YOLO may open a delayed confirmation dialog;
        // keeping it last prevents that dialog from hiding the other menus.
        if let Some(mode) = request.permission_mode.as_deref() {
            let yolo = matches!(mode.to_ascii_lowercase().as_str(), "yolo" | "never");
            let target = match mode.to_ascii_lowercase().as_str() {
                "manual" | "untrusted" => "请求批准",
                "auto" | "on-request" => "帮我批准",
                "yolo" | "never" => "完全访问权限",
                _ => {
                    return error(
                        "invalid_permission_mode",
                        "Unknown approval mode",
                        "not_sent",
                    );
                }
            };
            root = codex_root(automation).unwrap_or(root);
            if !invoke_named_button_exact(automation, &root, "更改权限") {
                return error(
                    "settings_control_not_found",
                    "Desktop approval control was not found",
                    "not_sent",
                );
            }
            thread::sleep(Duration::from_millis(100));
            let menu_root = codex_root(automation).unwrap_or_else(|| root.clone());
            if !invoke_visible_menu_matching(automation, &menu_root, |name| name.contains(target)) {
                return error(
                    "approval_option_not_found",
                    "Desktop approval option was not found",
                    "not_sent",
                );
            }
            if yolo {
                let mut confirmation_seen = false;
                for _ in 0..32 {
                    let live_root = codex_root(automation).unwrap_or_else(|| root.clone());
                    if has_visible_text(automation, &live_root, "要开启完整访问权限吗？")
                    {
                        confirmation_seen = true;
                        if !confirm_pending_full_access(automation) {
                            return error(
                                "approval_confirmation_failed",
                                "Desktop did not confirm full access permission",
                                "not_sent",
                            );
                        }
                        break;
                    }
                    thread::sleep(Duration::from_millis(125));
                }
                if confirmation_seen {
                    thread::sleep(Duration::from_millis(350));
                }
            }
        }
        let mut response = ok("settings_applied", "Desktop task settings were updated");
        if let Some(desired) = request.collaboration_mode.as_deref() {
            let desired = desired.to_ascii_lowercase();
            response.effective_collaboration_mode = Some(desired.clone());
            response.desired_collaboration_mode = Some(desired);
            response.mode_sync_state = Some("applied".into());
        }
        response
    })();
    restore_foreground(previous);
    result
}

fn apply_collaboration_mode(
    automation: &UIAutomation,
    root: &UIElement,
    desired: &str,
) -> Result<String, (&'static str, String, Option<String>)> {
    let current = detect_collaboration_mode(automation, root).ok_or_else(|| {
        (
            "plan_mode_state_unknown",
            "Codex Desktop collaboration mode could not be read".to_string(),
            None,
        )
    })?;
    if current == desired {
        return Ok(current);
    }

    if is_composer_running(automation, root) {
        return Err((
            "desktop_busy",
            "Codex Desktop is running the current turn; the mode will be applied to the next turn"
                .to_string(),
            Some(current),
        ));
    }

    if desired == "default" {
        let button = find_plan_indicator(automation, root).ok_or_else(|| {
            (
                "plan_mode_control_not_found",
                "Codex Desktop Plan control was not found".to_string(),
                Some(current.clone()),
            )
        })?;
        if !activate_element(&button) && button.click().is_err() {
            return Err((
                "plan_mode_toggle_failed",
                "Codex Desktop Plan control could not be invoked".to_string(),
                Some(current),
            ));
        }
    } else {
        // Ctrl+K in current Desktop versions searches other chats. Use the
        // composer's own slash command so another chat cannot be selected.
        invoke_plan_slash_command(automation, root, &current)?;
    }

    for _ in 0..24 {
        thread::sleep(Duration::from_millis(100));
        if let Some(live_root) = codex_root(automation) {
            if let Some(effective) = detect_collaboration_mode(automation, &live_root) {
                if effective == desired {
                    return Ok(effective);
                }
            }
        }
    }
    let effective = codex_root(automation)
        .and_then(|live_root| detect_collaboration_mode(automation, &live_root));
    Err((
        "plan_mode_unverified",
        "Codex Desktop did not confirm the requested collaboration mode".to_string(),
        effective,
    ))
}

fn is_composer_running(automation: &UIAutomation, root: &UIElement) -> bool {
    descendants_of_type(automation, root, ControlType::Button)
        .into_iter()
        .filter(|element| !element.is_offscreen().unwrap_or(true))
        .filter_map(|element| element.get_name().ok())
        .any(|name| is_running_composer_action(&name))
}

fn is_running_composer_action(name: &str) -> bool {
    matches!(name.trim(), "加入队列" | "排队" | "Queue" | "停止" | "Stop")
}

fn close_command_menu(automation: &UIAutomation, root: &UIElement) {
    for _ in 0..4 {
        let live_root = codex_root(automation).unwrap_or_else(|| root.clone());
        let menu = descendants_of_type(automation, &live_root, ControlType::ComboBox)
            .into_iter()
            .find(|element| {
                !element.is_offscreen().unwrap_or(true)
                    && matches!(
                        element.get_name().as_deref(),
                        Ok("命令菜单") | Ok("Command menu")
                    )
            });
        let Some(menu) = menu else { return };
        let _ = menu.send_keys("{esc}", 0);
        thread::sleep(Duration::from_millis(120));
    }
}

fn invoke_plan_slash_command(
    automation: &UIAutomation,
    root: &UIElement,
    current: &str,
) -> Result<(), (&'static str, String, Option<String>)> {
    let mut draft = None;
    for _ in 0..20 {
        let live_root = codex_root(automation).unwrap_or_else(|| root.clone());
        let Some(composer) = find_composer_in(automation, &live_root) else {
            thread::sleep(Duration::from_millis(100));
            continue;
        };
        let Ok(pattern) = composer.get_pattern::<UIValuePattern>() else {
            thread::sleep(Duration::from_millis(100));
            continue;
        };
        let candidate_draft = pattern.get_value().unwrap_or_default();
        let name = composer.get_name().unwrap_or_default();
        let Some(candidate_draft) = blank_plan_draft(&candidate_draft, &name) else {
            return Err((
                "plan_draft_present",
                "Codex Desktop has an unsent draft; finish or save it before changing Plan mode".to_string(),
                Some(current.to_string()),
            ));
        };
        // UIA reports the placeholder as the value of a blank editor. It is
        // not a draft and must never be written into the user's composer.
        focus_codex();
        let foreground_ok = unsafe { codex_main_window().map(|window| GetForegroundWindow() == window).unwrap_or(false) };
        if !foreground_ok {
            return Err(("desktop_busy", "Codex Desktop could not be focused safely".to_string(), Some(current.to_string())));
        }
        let click_result = composer.click();
        let focus_result = composer.set_focus();
        if focus_result.is_err() {
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        let select_result = composer.send_keys("{ctrl}a", 0);
        if select_result.is_err() {
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        // A Unicode keyboard packet bypasses the Chinese IME while still
        // generating the input event that opens Codex's slash-command list.
        let text_result = send_unicode_character('/');
        if std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() {
            eprintln!(
                "plan-input click={click_result:?} focus={focus_result:?} select={select_result:?} text={text_result}"
            );
        }
        if !text_result {
            let _ = restore_composer_draft(automation, root, &candidate_draft);
            return Err((
                "composer_write_failed",
                "Could not open the Codex Desktop Plan command".to_string(),
                Some(current.to_string()),
            ));
        }
        draft = Some(candidate_draft);
        break;
    }
    let Some(draft) = draft else {
        return Err((
            "desktop_busy",
            "Codex Desktop composer is not available; the mode will be applied to the next turn"
                .to_string(),
            Some(current.to_string()),
        ));
    };

    thread::sleep(Duration::from_millis(180));
    let live_root = codex_root(automation).unwrap_or_else(|| root.clone());
    let query = if desktop_uses_chinese_ui(automation, &live_root) {
        "计划"
    } else {
        "plan"
    };
    if !send_unicode_text(query) {
        let _ = restore_composer_draft(automation, root, &draft);
        return Err((
            "composer_write_failed",
            "Could not filter the Codex Desktop Plan command".to_string(),
            Some(current.to_string()),
        ));
    }

    let mut invoked = false;
    for attempt in 0..20 {
        let live_root = codex_root(automation).unwrap_or_else(|| root.clone());
        if attempt == 5 && std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() {
            trace_plan_candidates(automation, &live_root);
            trace_controls_near_composer(automation, &live_root);
        }
        if let Some(command) = find_plan_slash_command(automation, &live_root) {
            if std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() {
                eprintln!(
                    "plan-command type={:?} name={:?}",
                    command.get_control_type().ok(),
                    command.get_name().ok()
                );
            }
            invoked = command.click().is_ok() || activate_element(&command);
            if invoked {
                break;
            }
        }
        thread::sleep(Duration::from_millis(100));
    }

    if !invoked {
        let _ = restore_composer_draft(automation, root, &draft);
        return Err((
            "plan_command_not_found",
            "Codex Desktop did not expose the Plan slash-command suggestion".to_string(),
            Some(current.to_string()),
        ));
    }

    if !restore_composer_draft(automation, root, &draft) {
        return Err((
            "draft_restore_failed",
            "Plan mode changed, but the existing Codex Desktop draft could not be restored"
                .to_string(),
            Some("plan".to_string()),
        ));
    }
    Ok(())
}

fn restore_composer_draft(automation: &UIAutomation, root: &UIElement, draft: &str) -> bool {
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(80));
        let live_root = codex_root(automation).unwrap_or_else(|| root.clone());
        let Some(composer) = find_composer_in(automation, &live_root) else {
            continue;
        };
        let Ok(pattern) = composer.get_pattern::<UIValuePattern>() else {
            continue;
        };
        let name = composer.get_name().unwrap_or_default();
        let current = pattern.get_value().unwrap_or_default();
        if draft.trim().is_empty() && is_blank_composer(&current, &name) {
            return true;
        }
        if pattern.set_value(draft).is_err() {
            continue;
        }
        let restored = pattern.get_value().unwrap_or_default();
        if restored == draft || (draft.trim().is_empty() && is_blank_composer(&restored, &name)) {
            return true;
        }
    }
    false
}

fn send_unicode_character(value: char) -> bool {
    let Ok(scan) = u16::try_from(value as u32) else {
        return false;
    };
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan,
                dwFlags: KEYEVENTF_UNICODE | flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [key(Default::default()), key(KEYEVENTF_KEYUP)];
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) == inputs.len() as u32 }
}

fn send_unicode_text(value: &str) -> bool {
    value.chars().all(|character| {
        let sent = send_unicode_character(character);
        if sent {
            thread::sleep(Duration::from_millis(20));
        }
        sent
    })
}

fn desktop_uses_chinese_ui(automation: &UIAutomation, root: &UIElement) -> bool {
    !descendants_named(automation, root, "更改权限").is_empty()
}

fn detect_collaboration_mode(automation: &UIAutomation, root: &UIElement) -> Option<String> {
    let composer = find_composer_in(automation, root)?;
    let placeholder = composer.get_name().unwrap_or_default();
    Some(
        infer_collaboration_mode(
            find_plan_indicator(automation, root).is_some(),
            &placeholder,
        )
        .to_string(),
    )
}

fn infer_collaboration_mode(has_indicator: bool, placeholder: &str) -> &'static str {
    let placeholder = placeholder.to_ascii_lowercase();
    if has_indicator || placeholder.contains("生成套餐") || placeholder.contains("generate a plan")
    {
        "plan"
    } else {
        "default"
    }
}

fn find_plan_indicator(automation: &UIAutomation, root: &UIElement) -> Option<UIElement> {
    let composer = find_composer_in(automation, root)?;
    let composer_rect = composer.get_bounding_rectangle().ok()?;
    descendants_of_type(automation, root, ControlType::Button)
        .into_iter()
        .find(|element| {
            if element.is_offscreen().unwrap_or(true) {
                return false;
            }
            let name = element.get_name().unwrap_or_default();
            if name != "计划" && !name.eq_ignore_ascii_case("plan") {
                return false;
            }
            let class_matches = element
                .get_classname()
                .map(|class| class.contains("h-token-button-composer"))
                .unwrap_or(false);
            let near_composer = element
                .get_bounding_rectangle()
                .map(|rect| rect.get_top() >= composer_rect.get_top() - 16)
                .unwrap_or(false);
            class_matches && near_composer
        })
}

fn find_plan_slash_command(automation: &UIAutomation, root: &UIElement) -> Option<UIElement> {
    [
        ControlType::MenuItem,
        ControlType::ListItem,
        ControlType::Button,
    ]
    .into_iter()
    .flat_map(|control_type| descendants_of_type(automation, root, control_type))
    .find(|element| {
        !element.is_offscreen().unwrap_or(true)
            && is_plan_command_name(&element.get_name().unwrap_or_default())
    })
}

fn trace_plan_candidates(automation: &UIAutomation, root: &UIElement) {
    for control_type in [
        ControlType::Button,
        ControlType::MenuItem,
        ControlType::ListItem,
        ControlType::Text,
        ControlType::DataItem,
    ] {
        for element in descendants_of_type(automation, root, control_type) {
            let name = element.get_name().unwrap_or_default();
            if !element.is_offscreen().unwrap_or(true)
                && (name.to_ascii_lowercase().contains("plan") || name.contains("计划"))
            {
                eprintln!("plan-candidate type={control_type:?} name={name:?}");
            }
        }
    }
}

fn trace_controls_near_composer(automation: &UIAutomation, root: &UIElement) {
    let Some(composer) = find_composer_in(automation, root) else {
        return;
    };
    let Ok(composer_rect) = composer.get_bounding_rectangle() else {
        return;
    };
    for control_type in [
        ControlType::Button,
        ControlType::MenuItem,
        ControlType::ListItem,
        ControlType::DataItem,
        ControlType::Text,
    ] {
        for element in descendants_of_type(automation, root, control_type) {
            let name = element.get_name().unwrap_or_default();
            let near = element
                .get_bounding_rectangle()
                .map(|rect| rect.get_bottom() >= composer_rect.get_top() - 500)
                .unwrap_or(false);
            if near
                && !element.is_offscreen().unwrap_or(true)
                && !name.is_empty()
                && name.len() < 240
            {
                eprintln!("near-composer type={control_type:?} name={name:?}");
            }
        }
    }
}

fn is_plan_command_name(name: &str) -> bool {
    let value = name.to_ascii_lowercase();
    value.contains("计划模式") && value.contains("开启计划模式")
        || value.contains("plan mode") && value.contains("turn plan mode on")
}

// Stop the turn Codex Desktop is running in this task: its composer shows a
// "停止" / "Stop" button only while a turn runs. UI Automation Invoke only.
fn interrupt(automation: &UIAutomation, request: Request) -> Response {
    let thread_id = request.thread_id.as_deref().unwrap_or_default();
    if !valid_thread_id(thread_id) {
        return error("invalid_thread_id", "A valid Codex task id is required", "not_sent");
    }
    let root = match select_requested_task(automation, thread_id, request.title.as_deref()) {
        Ok(value) => value,
        Err(message) => return error("task_identity_unconfirmed", &message, "not_sent"),
    };
    for name in ["停止", "Stop"] {
        if invoke_named_button_exact(automation, &root, name) {
            return ok("interrupted", "Codex Desktop stopped the running turn");
        }
    }
    error("not_running", "Codex Desktop shows no running turn in this task", "not_sent")
}

fn invoke_named_button_exact(automation: &UIAutomation, root: &UIElement, name: &str) -> bool {
    descendants_named(automation, root, name)
        .into_iter()
        .find(|element| {
            element.get_control_type().ok() == Some(ControlType::Button)
                && !element.is_offscreen().unwrap_or(true)
        })
        .map(|element| activate_element(&element))
        .unwrap_or(false)
}

fn confirm_pending_full_access(automation: &UIAutomation) -> bool {
    for _ in 0..20 {
        let Some(root) = codex_root(automation) else {
            thread::sleep(Duration::from_millis(120));
            continue;
        };
        if !has_visible_text(automation, &root, "要开启完整访问权限吗？") {
            return true;
        }
        if invoke_named_button_exact(automation, &root, "确认") {
            thread::sleep(Duration::from_millis(180));
        } else {
            thread::sleep(Duration::from_millis(120));
        }
    }
    false
}

fn activate_element(element: &UIElement) -> bool {
    if element
        .get_pattern::<UIInvokePattern>()
        .and_then(|pattern| pattern.invoke())
        .is_ok()
    {
        return true;
    }
    // Recent Codex Desktop releases expose model choices as radio menu items,
    // which support SelectionItem rather than Invoke.
    if element
        .get_pattern::<UISelectionItemPattern>()
        .and_then(|pattern| pattern.select())
        .is_ok()
    {
        return true;
    }
    if let Ok(pattern) = element.get_pattern::<UIExpandCollapsePattern>() {
        return match pattern.get_state().ok() {
            Some(ExpandCollapseState::Expanded | ExpandCollapseState::PartiallyExpanded) => {
                pattern.collapse().is_ok()
            }
            _ => pattern.expand().is_ok(),
        };
    }
    false
}

fn invoke_visible_menu_matching<F>(automation: &UIAutomation, root: &UIElement, matcher: F) -> bool
where
    F: Fn(&str) -> bool,
{
    descendants_of_type(automation, root, ControlType::MenuItem)
        .into_iter()
        .filter(|element| !element.is_offscreen().unwrap_or(true))
        .find(|element| matcher(&element.get_name().unwrap_or_default()))
        .map(|element| activate_element(&element))
        .unwrap_or(false)
}

// Why a Desktop task-settings menu could not be used. The stage decides the
// code the connector acts on (a menu that did not open may simply be busy);
// `visible` says what the menu showed, for the log.
#[derive(Debug, PartialEq)]
enum MenuFailure {
    SettingsButtonNotFound,
    MenuNotOpened,
    CategoryNotFound { visible: Vec<String> },
    OptionNotMatched { visible: Vec<String> },
    ConfirmationRequired,
}

// `category` is the connector's name for the setting: model, effort or service_tier.
fn menu_failure_code(category: &str, failure: &MenuFailure) -> String {
    match failure {
        MenuFailure::SettingsButtonNotFound => "settings_button_not_found".into(),
        MenuFailure::MenuNotOpened => "settings_menu_not_opened".into(),
        MenuFailure::CategoryNotFound { .. } => format!("{category}_category_not_found"),
        MenuFailure::OptionNotMatched { .. } => format!("{category}_option_not_matched"),
        MenuFailure::ConfirmationRequired => format!("{category}_confirmation_required"),
    }
}

fn menu_failure_text(failure: &MenuFailure) -> String {
    match failure {
        MenuFailure::SettingsButtonNotFound => {
            "the task settings button was not found under the composer".into()
        }
        MenuFailure::MenuNotOpened => "the task settings menu did not open".into(),
        MenuFailure::CategoryNotFound { visible } => format!(
            "the settings menu has no matching category; visible: {}",
            visible_summary(visible)
        ),
        MenuFailure::OptionNotMatched { visible } => format!(
            "the settings submenu has no matching option; visible: {}",
            visible_summary(visible)
        ),
        MenuFailure::ConfirmationRequired =>
            "this setting needs an explicit confirmation in Codex Desktop".into(),
    }
}

fn menu_error(category: &str, failure: MenuFailure) -> Response {
    let code = menu_failure_code(category, &failure);
    let message = menu_failure_text(&failure);
    // stderr is kept in the connector's log, so a failure can be traced later
    // even when the phone only saw its short message.
    eprintln!("settings-failed code={code} {message}");
    error(&code, &message, "not_sent")
}

// The names a menu showed, joined for the message and capped so one long menu
// cannot flood the log.
fn visible_summary(names: &[String]) -> String {
    if names.is_empty() {
        return "none".into();
    }
    let joined = names.join(" | ");
    if joined.chars().count() > 300 {
        format!("{}...", joined.chars().take(300).collect::<String>())
    } else {
        joined
    }
}

// Older releases include the current model in this label; newer releases use
// the explicit "选择模型" item. Neither item is itself a model option.
fn is_category_name(name: &str, category_prefix: &str) -> bool {
    name.starts_with(category_prefix)
        || (category_prefix == "模型 " && name.trim() == "选择模型")
}

fn category_index(names: &[String], category_prefix: &str) -> Option<usize> {
    names.iter().position(|name| is_category_name(name, category_prefix))
}

// Position of the option inside an open category. Category items never count as
// options, so a model named like a category cannot be picked by mistake.
fn option_index<F: Fn(&str) -> bool>(names: &[String], category_prefix: &str, matcher: F) -> Option<usize> {
    names
        .iter()
        .position(|name| !is_category_name(name, category_prefix) && matcher(name))
}

// Calls `probe` until it yields a value or the time runs out. Polling a
// deadline replaces fixed sleeps: a slow menu is waited for, a fast one is not.
fn poll_until<T>(timeout: Duration, interval: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = probe() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(interval);
    }
}

// Opens a menu trigger without ever closing an open menu: Invoke first, then
// Expand, which is skipped when the trigger already reports expanded (Toggle
// would close it).
fn open_menu_trigger(element: &UIElement) -> bool {
    if element
        .get_pattern::<UIInvokePattern>()
        .and_then(|pattern| pattern.invoke())
        .is_ok()
    {
        return true;
    }
    if let Ok(pattern) = element.get_pattern::<UIExpandCollapsePattern>() {
        return match pattern.get_state().ok() {
            Some(ExpandCollapseState::Expanded | ExpandCollapseState::PartiallyExpanded) => true,
            _ => pattern.expand().is_ok(),
        };
    }
    false
}

// Visible items of the open menus, with their names, in document order.
fn visible_menu_items(automation: &UIAutomation, root: &UIElement) -> Vec<(UIElement, String)> {
    [ControlType::MenuItem, ControlType::RadioButton, ControlType::CheckBox]
        .into_iter()
        .flat_map(|kind| descendants_of_type(automation, root, kind))
        .filter(|element| !element.is_offscreen().unwrap_or(true))
        .map(|element| {
            let name = element.get_name().unwrap_or_default();
            (element, name)
        })
        .collect()
}

fn live_root_or(automation: &UIAutomation, fallback: &UIElement) -> UIElement {
    codex_root(automation).unwrap_or_else(|| fallback.clone())
}

// Selects one value of a task-settings category: the settings button, the
// category item and then the matching option. Each step waits for the menu it
// opens instead of sleeping for a fixed time.
fn apply_composer_category<F>(
    automation: &UIAutomation,
    root: &UIElement,
    category: &str,
    category_prefix: &str,
    desired: &str,
    matcher: F,
) -> Result<(), MenuFailure>
where
    F: Fn(&str) -> bool,
{
    // The button can appear a moment after the task opens.
    let button = poll_until(Duration::from_millis(2000), Duration::from_millis(100), || {
        find_composer_settings_button(automation, &live_root_or(automation, root))
    })
    .ok_or(MenuFailure::SettingsButtonNotFound)?;
    if std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() {
        eprintln!("settings-button={:?} category={category}", button.get_name().unwrap_or_default());
    }
    let menu_is_open = || visible_menu_items(automation, &live_root_or(automation, root))
        .iter().any(|(_, name)| is_settings_menu_name(name));
    let mut opened = menu_is_open();
    if !opened {
        if !open_menu_trigger(&button) {
            return Err(MenuFailure::MenuNotOpened);
        }
        opened = poll_until(Duration::from_millis(2000), Duration::from_millis(100), || menu_is_open().then_some(())).is_some();
    }
    if !opened {
        // The menu is confirmed closed, so one more click cannot close it again.
        opened = open_menu_trigger(&button)
            && poll_until(Duration::from_millis(2000), Duration::from_millis(100), || menu_is_open().then_some(())).is_some();
    }
    if !opened {
        return Err(MenuFailure::MenuNotOpened);
    }

    // The current Desktop UI replaced the speed submenu with a toggle and
    // the reasoning submenu with a keyboard-adjustable scale. Keep the old
    // submenu path below for earlier Desktop releases.
    let live_root = live_root_or(automation, root);
    let items = visible_menu_items(automation, &live_root);
    if category == "service_tier" {
        if let Some((toggle, _)) = items.iter().find(|(_, name)| is_modern_speed_toggle_name(name)) {
            return apply_modern_speed_toggle(toggle, desired);
        }
    }
    if category == "effort" {
        if let Some((scale, _)) = items.iter().find(|(_, name)| name.trim() == "强度") {
            return apply_modern_effort(automation, root, scale, desired);
        }
    }

    let category_item = poll_until(Duration::from_millis(1000), Duration::from_millis(100), || {
        let items = visible_menu_items(automation, &live_root_or(automation, root));
        let names: Vec<String> = items.iter().map(|(_, name)| name.clone()).collect();
        category_index(&names, category_prefix).map(|index| items[index].0.clone())
    });
    let Some(category_item) = category_item else {
        let names = visible_menu_items(automation, &live_root_or(automation, root))
            .into_iter()
            .map(|(_, name)| name)
            .collect();
        return Err(MenuFailure::CategoryNotFound { visible: names });
    };
    if !open_menu_trigger(&category_item) {
        return Err(MenuFailure::CategoryNotFound { visible: Vec::new() });
    }

    let option = poll_until(Duration::from_millis(2500), Duration::from_millis(100), || {
        let items = visible_menu_items(automation, &live_root_or(automation, root));
        let names: Vec<String> = items.iter().map(|(_, name)| name.clone()).collect();
        option_index(&names, category_prefix, &matcher).map(|index| items[index].0.clone())
    });
    let Some(option) = option else {
        let names = visible_menu_items(automation, &live_root_or(automation, root))
            .into_iter()
            .map(|(_, name)| name)
            .filter(|name| !is_category_name(name, category_prefix))
            .collect();
        return Err(MenuFailure::OptionNotMatched { visible: names });
    };
    if !activate_element(&option) {
        return Err(MenuFailure::OptionNotMatched { visible: Vec::new() });
    }
    thread::sleep(Duration::from_millis(500));
    Ok(())
}

fn requested_fast_mode(tier: &str) -> Option<bool> {
    match tier.to_ascii_lowercase().as_str() {
        "priority" | "fast" | "快速" => Some(true),
        "default" | "standard" | "标准" => Some(false),
        _ => None,
    }
}

fn is_modern_speed_toggle_name(name: &str) -> bool {
    matches!(name.trim(), "启用快速模式" | "启用标准模式")
}

fn is_settings_menu_name(name: &str) -> bool {
    is_category_name(name, "模型 ") || name.starts_with("推理强度 ")
        || name.starts_with("速度 ") || name.trim() == "强度"
        || is_modern_speed_toggle_name(name)
}

fn apply_modern_speed_toggle(toggle: &UIElement, tier: &str) -> Result<(), MenuFailure> {
    let desired = requested_fast_mode(tier).ok_or(MenuFailure::OptionNotMatched { visible: vec![] })?;
    let pattern = toggle.get_pattern::<UITogglePattern>()
        .map_err(|_| MenuFailure::OptionNotMatched { visible: vec![] })?;
    let actual = pattern.get_toggle_state()
        .map_err(|_| MenuFailure::OptionNotMatched { visible: vec![] })?;
    let target = if desired { ToggleState::On } else { ToggleState::Off };
    if actual == ToggleState::Indeterminate {
        return Err(MenuFailure::OptionNotMatched { visible: vec!["speed state unknown".into()] });
    }
    if actual != target {
        pattern.toggle().map_err(|_| MenuFailure::OptionNotMatched { visible: vec![] })?;
        let confirmed = poll_until(Duration::from_millis(1500), Duration::from_millis(100), || {
            (pattern.get_toggle_state().ok() == Some(target)).then_some(())
        });
        if confirmed.is_none() {
            return Err(MenuFailure::OptionNotMatched { visible: vec!["speed change unconfirmed".into()] });
        }
    }
    Ok(())
}

fn desired_effort_rank(value: &str) -> Option<u8> {
    match value.to_ascii_lowercase().as_str() {
        "minimal" | "none" | "light" | "low" | "轻度" => Some(0),
        "medium" | "standard" | "中" | "标准" => Some(1),
        "high" | "高" | "深度" => Some(2),
        "xhigh" | "extra-high" | "very-high" | "极高" => Some(3),
        "max" | "最高" => Some(4),
        "ultra" => Some(5),
        _ => None,
    }
}

fn modern_effort_rank(name: &str) -> Option<u8> {
    // The live region is e.g. "GPT-6 Astra 标准，第 2 项，共 6 项。".
    // Require its ordinal so unrelated model text cannot be mistaken for it.
    let (label, ordinal) = name.split_once("，第 ")?;
    if !ordinal.contains("项") { return None; }
    let value = label.split_whitespace().last()?;
    desired_effort_rank(value)
}

fn read_modern_effort(automation: &UIAutomation, root: &UIElement) -> Option<u8> {
    // The descriptive live region itself is visually hidden; constrain the
    // search to a visible menu instead of discarding off-screen text nodes.
    descendants_of_type(automation, &live_root_or(automation, root), ControlType::Menu)
        .into_iter()
        .filter(|menu| !menu.is_offscreen().unwrap_or(true))
        .flat_map(|menu| descendants_of_type(automation, &menu, ControlType::Text))
        .filter_map(|element| element.get_name().ok())
        .find_map(|name| modern_effort_rank(&name))
}

fn apply_modern_effort(
    automation: &UIAutomation,
    root: &UIElement,
    scale: &UIElement,
    effort: &str,
) -> Result<(), MenuFailure> {
    let desired = desired_effort_rank(effort)
        .ok_or(MenuFailure::OptionNotMatched { visible: vec![] })?;
    // Ultra can open a separate full-access confirmation. Never approve that
    // dialog on the user's behalf: ask them to complete it on the computer.
    if desired == 5 { return Err(MenuFailure::ConfirmationRequired); }
    let mut current = read_modern_effort(automation, root)
        .ok_or(MenuFailure::OptionNotMatched { visible: vec!["effort state unknown".into()] })?;
    for _ in 0..6 {
        if current == desired { return Ok(()); }
        focus_codex();
        let foreground_ok = unsafe { codex_main_window().map(|window| GetForegroundWindow() == window).unwrap_or(false) };
        if !foreground_ok { return Err(MenuFailure::MenuNotOpened); }
        let key = if current < desired { "{right}" } else { "{left}" };
        scale.send_keys(key, 0).map_err(|_| MenuFailure::OptionNotMatched { visible: vec![] })?;
        let previous = current;
        current = poll_until(Duration::from_millis(1200), Duration::from_millis(100), || {
            read_modern_effort(automation, root).filter(|rank| *rank != previous)
        }).ok_or(MenuFailure::OptionNotMatched { visible: vec!["effort change unconfirmed".into()] })?;
    }
    Err(MenuFailure::OptionNotMatched { visible: vec!["effort value unavailable".into()] })
}

fn find_composer_settings_button(automation: &UIAutomation, root: &UIElement) -> Option<UIElement> {
    let composer = find_composer_in(automation, root)?;
    let composer_rect = composer.get_bounding_rectangle().ok()?;
    descendants_of_type(automation, root, ControlType::Button)
        .into_iter()
        .filter(|element| {
            !element.is_offscreen().unwrap_or(true)
                && element
                    .get_classname()
                    .map(|class| class.contains("h-token-button-composer"))
                    .unwrap_or(false)
        })
        .filter_map(|element| {
            let name = element.get_name().unwrap_or_default();
            if [
                "添加文件等内容",
                "更改权限",
                "听写",
                "发送",
                "开始新的语音聊天",
                "开启语音聊天",
            ]
            .contains(&name.as_str())
                || name.contains("语音")
            {
                return None;
            }
            let rect = element.get_bounding_rectangle().ok()?;
            if rect.get_top() < composer_rect.get_top() {
                return None;
            }
            Some((rect.get_right() - rect.get_left(), element))
        })
        .max_by_key(|(width, _)| *width)
        .map(|(_, element)| element)
}

fn model_menu_matches(name: &str, model: &str) -> bool {
    // Ignore punctuation and spacing but preserve the version and family.
    // A substring match on "Sol" could select 6.1 when 6 was requested.
    let normalize = |value: &str| value.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let expected = normalize(model);
    !expected.is_empty() && normalize(name) == expected
}

fn effort_menu_matches(name: &str, effort: &str) -> bool {
    let target = match effort.to_ascii_lowercase().as_str() {
        "minimal" | "none" | "light" | "low" | "轻度" => "轻度",
        "medium" | "中" => "中",
        "high" | "高" => "高",
        "xhigh" | "extra-high" | "very-high" | "极高" => "极高",
        "max" | "ultra" | "最高" => "最高",
        _ => effort,
    };
    name.trim() == target
}

fn tier_menu_matches(name: &str, tier: &str) -> bool {
    let target = match tier.to_ascii_lowercase().as_str() {
        "priority" | "fast" | "快速" => "快速",
        "default" | "standard" | "标准" => "标准",
        _ => tier,
    };
    name.trim().starts_with(target)
}

fn trace(label: &str, started: Instant) {
    if std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() {
        eprintln!("{label}={}ms", started.elapsed().as_millis());
    }
}

fn restore_foreground(previous: windows::Win32::Foundation::HWND) {
    unsafe {
        if !previous.0.is_null() {
            let _ = SetForegroundWindow(previous);
        }
    }
}

fn has_visible_text(automation: &UIAutomation, root: &UIElement, text: &str) -> bool {
    descendants_named(automation, root, text)
        .into_iter()
        .any(|element| {
            element.get_control_type().ok() == Some(ControlType::Text)
                && !element.is_offscreen().unwrap_or(true)
        })
}

fn attach_files(
    automation: &UIAutomation,
    root: &UIElement,
    attachments: &[Attachment],
) -> Result<(), String> {
    for attachment in attachments {
        let path = std::path::Path::new(&attachment.path);
        if !path.is_file() {
            return Err(format!(
                "Attachment file is not available: {}",
                attachment.path
            ));
        }
        let metadata = std::fs::metadata(path)
            .map_err(|_| format!("Attachment file cannot be read: {}", attachment.path))?;
        if metadata.len() == 0 {
            return Err(format!("Attachment file is empty: {}", attachment.path));
        }

        if !open_attachment_menu(automation) {
            return Err("Codex Desktop attachment control was not available".to_string());
        }
        let dialog = open_file_dialog(automation)
            .ok_or_else(|| "Windows file picker did not open".to_string())?;
        let file_name = find_file_name_edit(automation, &dialog)
            .ok_or_else(|| "Windows file picker file-name field was not found".to_string())?;
        file_name
            .click()
            .map_err(|_| "Windows file picker file-name field could not be focused".to_string())?;
        file_name
            .send_keys("{ctrl}a", 0)
            .and_then(|_| file_name.send_text(&attachment.path, 0))
            .map_err(|_| "Windows file picker rejected the attachment path".to_string())?;
        if !invoke_dialog_open(automation, &dialog) {
            return Err("Windows file picker open control was not available".to_string());
        }
        if !wait_for_visible_attachment(automation, root, attachment) {
            return Err(format!(
                "Codex Desktop did not confirm attachment: {}",
                attachment.name
            ));
        }
    }
    Ok(())
}

fn open_file_dialog(automation: &UIAutomation) -> Option<UIElement> {
    for attempt in 0..3 {
        let picker = wait_for_attachment_picker(automation)?;
        thread::sleep(Duration::from_millis(250));
        if invoke_picker_choice(automation, &picker) {
            if let Some(dialog) = wait_for_file_dialog(automation) {
                return Some(dialog);
            }
        }
        if attempt < 2 {
            let _ = open_attachment_menu(automation);
        }
    }
    None
}

fn open_attachment_menu(automation: &UIAutomation) -> bool {
    for _ in 0..20 {
        if let Some(root) = codex_root(automation) {
            if invoke_named_button_exact(automation, &root, "添加文件等内容")
                || invoke_named_button_exact(automation, &root, "Add files and more")
            {
                return true;
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn wait_for_attachment_picker(automation: &UIAutomation) -> Option<UIElement> {
    for _ in 0..20 {
        if let Some(root) = codex_root(automation) {
            if descendants_named(automation, &root, "文件和文件夹")
                .into_iter()
                .any(|element| !element.is_offscreen().unwrap_or(true))
            {
                return Some(root);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

fn invoke_picker_choice(automation: &UIAutomation, root: &UIElement) -> bool {
    for name in ["文件和文件夹", "Files and folders"] {
        for element in descendants_named(automation, root, name) {
            if element.get_control_type().ok() != Some(ControlType::Button)
                || element.is_offscreen().unwrap_or(true)
            {
                continue;
            }
            // Chromium can expose this menu item either as a normal invoke
            // control or as a hit-test-only control, depending on whether the
            // desktop window was just restored from the background. Try each
            // input method and verify the native dialog after every attempt;
            // a successful UIA Invoke alone is not proof that the picker opened.
            if physical_click(&element) {
                thread::sleep(Duration::from_millis(180));
                if find_file_dialog(automation).is_some() { return true; }
            }
            if activate_element(&element) {
                thread::sleep(Duration::from_millis(120));
                if find_file_dialog(automation).is_some() { return true; }
            }
            if element.click().is_ok() {
                thread::sleep(Duration::from_millis(120));
                if find_file_dialog(automation).is_some() { return true; }
            }
        }
    }
    false
}

fn physical_click(element: &UIElement) -> bool {
    let Ok(rect) = element.get_bounding_rectangle() else { return false };
    let x = (rect.get_left() + rect.get_right()) / 2;
    let y = (rect.get_top() + rect.get_bottom()) / 2;
    if std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() {
        eprintln!("picker-physical-click x={x} y={y}");
    }
    unsafe {
        if SetCursorPosNative(x, y) == 0 { return false; }
        MouseEventNative(0x0002, 0, 0, 0, 0);
        MouseEventNative(0x0004, 0, 0, 0, 0);
    }
    true
}

#[link(name = "user32")]
unsafe extern "system" {
    #[link_name = "SetCursorPos"]
    fn SetCursorPosNative(x: i32, y: i32) -> i32;
    #[link_name = "mouse_event"]
    fn MouseEventNative(flags: u32, dx: u32, dy: u32, data: u32, extra: usize);
}

fn focus_codex() {
    unsafe {
        if let Some(window) = codex_main_window() {
            let _ = SetForegroundWindow(window);
        }
    }
}

fn wait_for_file_dialog(automation: &UIAutomation) -> Option<UIElement> {
    for _ in 0..30 {
        if let Some(dialog) = find_file_dialog(automation) {
            return Some(dialog);
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

fn find_file_dialog(automation: &UIAutomation) -> Option<UIElement> {
    // Another account (or another app) may already own an Open dialog.
    // Attachments belong only to the same default Codex process as dispatch.
    let target_pid = codex_root(automation)?.get_process_id().ok()?;
    let desktop = automation.get_root_element().ok()?;
    let condition = automation.create_true_condition().ok()?;
    desktop
        .find_all(TreeScope::Children, &condition)
        .unwrap_or_default()
        .into_iter()
        .find(|element| {
            if element.get_control_type().ok() != Some(ControlType::Window) {
                return false;
            }
            let class_name = element.get_classname().unwrap_or_default();
            let name = element.get_name().unwrap_or_default().to_ascii_lowercase();
            file_dialog_matches(target_pid, element.get_process_id().ok(), &class_name,
                &name, !element.is_offscreen().unwrap_or(true))
        })
}

fn file_dialog_matches(target_pid: u32, pid: Option<u32>, class_name: &str, name: &str, visible: bool) -> bool {
    target_pid > 0 && pid == Some(target_pid) && visible
        && (class_name == "#32770" || name.contains("open") || name.contains("打开"))
}

fn find_file_name_edit(automation: &UIAutomation, dialog: &UIElement) -> Option<UIElement> {
    let edits = descendants_of_type(automation, dialog, ControlType::Edit)
        .into_iter()
        .filter(|element| !element.is_offscreen().unwrap_or(true))
        .collect::<Vec<_>>();
    edits
        .iter()
        .find(|element| {
            let name = element.get_name().unwrap_or_default().to_ascii_lowercase();
            name.contains("文件名") || name.contains("file name")
        })
        .cloned()
        .or_else(|| edits.into_iter().last())
}

fn invoke_dialog_open(automation: &UIAutomation, dialog: &UIElement) -> bool {
    let buttons = descendants_of_type(automation, dialog, ControlType::Button)
        .into_iter()
        .filter(|element| {
            let name = element.get_name().unwrap_or_default().to_ascii_lowercase();
            !element.is_offscreen().unwrap_or(true)
                && (name.starts_with("打开")
                    || name.starts_with("open")
                    || name.starts_with("选择")
                    || name.starts_with("select"))
        })
        .collect::<Vec<_>>();
    for element in buttons {
        let _ = dialog.set_focus();
        let _ = element.set_focus();
        if activate_element(&element) {
            thread::sleep(Duration::from_millis(180));
            if find_file_dialog(automation).is_none() { return true; }
        }
        if element.send_keys("{enter}", 0).is_ok() {
            thread::sleep(Duration::from_millis(180));
            if find_file_dialog(automation).is_none() { return true; }
        }
        if element.click().is_ok() {
            thread::sleep(Duration::from_millis(180));
            if find_file_dialog(automation).is_none() { return true; }
        }
        if physical_click(&element) {
            thread::sleep(Duration::from_millis(180));
            if find_file_dialog(automation).is_none() { return true; }
        }
    }
    false
}

fn wait_for_visible_attachment(
    automation: &UIAutomation,
    root: &UIElement,
    attachment: &Attachment,
) -> bool {
    // The native picker keeps the stored basename (which contains the
    // attachment id), while the phone-facing registry keeps the original
    // display name. Accept both forms so a successful attach is never
    // downgraded to a retry merely because the picker renamed the file.
    let targets = [
        attachment.name.to_ascii_lowercase(),
        std::path::Path::new(&attachment.path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase(),
    ];
    for _ in 0..30 {
        let found = [
            ControlType::Button,
            ControlType::Text,
            ControlType::ListItem,
        ]
        .into_iter()
        .flat_map(|control_type| descendants_of_type(automation, root, control_type))
        .any(|element| {
            !element.is_offscreen().unwrap_or(true)
                && element
                    .get_name()
                    .map(|value| {
                        let value = value.to_ascii_lowercase();
                        targets.iter().any(|target| !target.is_empty() && value.contains(target))
                    })
                    .unwrap_or(false)
        });
        if found {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn find_composer(automation: &UIAutomation) -> Option<UIElement> {
    let root = codex_root(automation)?;
    find_composer_in(automation, &root)
}

fn find_composer_in(automation: &UIAutomation, root: &UIElement) -> Option<UIElement> {
    let candidates: Vec<_> = descendants_of_type(automation, &root, ControlType::Edit)
        .into_iter()
        .filter(|element| {
            element
                .get_classname()
                .map(|value| value.starts_with("ProseMirror"))
                .unwrap_or(false)
                && !element.is_offscreen().unwrap_or(true)
        })
        .collect();
    let names = candidates.iter().map(|element| element.get_name().unwrap_or_default()).collect::<Vec<_>>();
    select_composer_index(&names).and_then(|index| candidates.get(index).cloned())
}

fn is_main_composer_name(name: &str) -> bool {
    matches!(name.trim(),
        "和 Codex 一起工作" | "可向 Codex 询问任何问题" | "Ask Codex anything" |
        "Work with Codex" | "Message Codex" | "描述你的任务以生成计划…" |
        "Describe your task to generate a plan..." | "Describe your task to generate a plan…")
}

fn is_question_editor_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.contains("自行撰写回复") || name.contains("自行填写")
        || lower.contains("write your own answer") || lower.contains("type your own answer")
}

fn select_composer_index(names: &[String]) -> Option<usize> {
    let preferred = names.iter().enumerate().filter(|(_, name)| is_main_composer_name(name)).map(|(index, _)| index).collect::<Vec<_>>();
    if preferred.len() == 1 { return preferred.first().copied(); }
    if !preferred.is_empty() { return None; }
    let candidates = names.iter().enumerate().filter(|(_, name)| !is_question_editor_name(name)).map(|(index, _)| index).collect::<Vec<_>>();
    if candidates.len() == 1 { candidates.first().copied() } else { None }
}

// Codex Desktop owns several top-level windows titled "ChatGPT" (the main
// window, the pet/avatar overlay, ...). FindWindowW returns whichever comes
// first, which can be the small overlay. Prefer a visible, non-minimised
// window, then the largest one.
fn codex_main_window() -> Option<HWND> {
    unsafe extern "system" fn collect(window: HWND, param: LPARAM) -> BOOL {
        let found = unsafe { &mut *(param.0 as *mut Vec<(HWND, i64)>) };
        let mut class = [0u16; 64];
        let mut title = [0u16; 64];
        let class_len = unsafe { GetClassNameW(window, &mut class) } as usize;
        let title_len = unsafe { GetWindowTextW(window, &mut title) } as usize;
        if String::from_utf16_lossy(&class[..class_len]) == "Chrome_WidgetWin_1"
            && String::from_utf16_lossy(&title[..title_len]) == "ChatGPT"
            && is_default_codex_window(window)
        {
            let mut rect = RECT::default();
            let area = if unsafe { GetWindowRect(window, &mut rect) }.is_ok() {
                ((rect.right - rect.left) as i64).max(0) * ((rect.bottom - rect.top) as i64).max(0)
            } else {
                0
            };
            let shown = unsafe { IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() };
            // Shown windows always outrank hidden ones; area breaks ties.
            found.push((window, if shown { 1 << 40 } else { 0 } + area));
        }
        BOOL(1)
    }
    let mut found: Vec<(HWND, i64)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut found as *mut _ as isize));
    }
    found.into_iter().max_by_key(|(_, score)| *score).map(|(window, _)| window)
}

fn codex_root(automation: &UIAutomation) -> Option<UIElement> {
    let window = codex_main_window()?;
    automation.element_from_handle(window.into()).ok()
}

// KH Link's connector owns the default Codex home. A different Desktop user
// data directory belongs to a different account, even if its window is larger
// or foreground. Read only the official main process's command-line flags;
// never its environment, auth files or process memory. Native query avoids a
// new PowerShell/WMI process on every 5-second presence tick.
fn command_uses_default_profile(command: &str) -> bool {
    !command.split_whitespace().any(|arg| {
        let arg=arg.trim_matches('"').to_ascii_lowercase();
        arg == "--user-data-dir" || arg.starts_with("--user-data-dir=")
    })
}
#[repr(C)]
struct CommandLineString { length: u16, maximum_length: u16, buffer: *const u16 }
#[link(name="ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(process: windows::Win32::Foundation::HANDLE, class: u32,
        information: *mut std::ffi::c_void, length: u32, returned: *mut u32) -> i32;
}
fn process_command_line(pid: u32) -> Option<String> {
    unsafe {
        let process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid).ok()?;
        struct Handle(windows::Win32::Foundation::HANDLE);
        impl Drop for Handle { fn drop(&mut self) { unsafe { let _=CloseHandle(self.0); } } }
        let _handle=Handle(process);
        let mut size=0u32;
        let _=NtQueryInformationProcess(process,60,std::ptr::null_mut(),0,&mut size);
        if size < std::mem::size_of::<CommandLineString>() as u32 || size > 131072 { return None; }
        let mut memory=vec![0usize;(size as usize).div_ceil(std::mem::size_of::<usize>())];
        if NtQueryInformationProcess(process,60,memory.as_mut_ptr().cast(),size,&mut size)<0 { return None; }
        let value=&*(memory.as_ptr() as *const CommandLineString);
        let begin=memory.as_ptr() as usize; let end=begin+memory.len()*std::mem::size_of::<usize>();
        let pointer=value.buffer as usize;
        if value.length==0 || value.length%2!=0 || pointer<begin || pointer.checked_add(value.length as usize)? > end { return None; }
        String::from_utf16(std::slice::from_raw_parts(value.buffer,value.length as usize/2)).ok()
    }
}
fn is_default_codex_window(window: HWND) -> bool {
    if window_process_image_path(window).as_deref().and_then(classify_agent_executable) != Some("codex") { return false; }
    let mut pid=0u32; unsafe { GetWindowThreadProcessId(window,Some(&mut pid)); }
    process_command_line(pid).is_some_and(|line| command_uses_default_profile(&line))
}

// These identities were confirmed on the production Windows host on
// 2026-10-06. Codex Desktop runs as
// `C:\Program Files\WindowsApps\OpenAI.Codex_<version>\app\ChatGPT.exe`,
// while the connector's own app-server is
// `C:\Users\me\AppData\Local\OpenAI\Codex\bin\...\codex.exe` and must
// never make the Codex tab look open. Claude Desktop runs from the
// `WindowsApps\Claude_<version>\app\Claude.exe` package. Antigravity is the
// installed desktop app at `...\AppData\Local\Programs\antigravity\Antigravity.exe`.
// We require a visible top-level application window so background helper
// processes left behind by an app close do not keep its tab lit. A minimized
// main window is intentionally accepted: IsWindowVisible remains true for it,
// and minimizing is not the same as closing. Exact title/class matching plus
// the tool-window check filters Electron helper/utility windows and tray-only
// processes without rejecting a minimized main window.
fn classify_agent_executable(path: &str) -> Option<&'static str> {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    if normalized.contains("\\windowsapps\\openai.codex_")
        && normalized.ends_with("\\app\\chatgpt.exe")
    {
        return Some("codex");
    }
    if normalized.contains("\\windowsapps\\claude_")
        && normalized.ends_with("\\app\\claude.exe")
    {
        return Some("claude");
    }
    if normalized.ends_with("\\programs\\antigravity\\antigravity.exe") {
        return Some("antigravity");
    }
    None
}

fn agent_window_candidate(
    agent: &str,
    visible: bool,
    minimized: bool,
    tool_window: bool,
    title: &str,
    class_name: &str,
) -> bool {
    // IsWindowVisible is normally true for a minimized window, but some
    // packaged Electron builds briefly report false while the window is being
    // minimized. IsIconic is the reliable signal that this is still the app's
    // main window, so keep it eligible while rejecting ordinary hidden helpers.
    if (!visible && !minimized) || tool_window {
        return false;
    }
    let title = title.trim();
    let class_name = class_name.trim();
    match agent {
        // Confirmed on this host: the main Codex Desktop, Claude Desktop and
        // Antigravity windows are all Chrome_WidgetWin_1 with these titles.
        "codex" => title.eq_ignore_ascii_case("ChatGPT") && class_name == "Chrome_WidgetWin_1",
        "claude" => title.eq_ignore_ascii_case("Claude") && class_name == "Chrome_WidgetWin_1",
        "antigravity" => {
            title.eq_ignore_ascii_case("Antigravity") && class_name == "Chrome_WidgetWin_1"
        }
        _ => false,
    }
}

fn window_text(window: HWND, class_name: bool) -> String {
    let mut text = [0u16; 256];
    let length = if class_name {
        unsafe { GetClassNameW(window, &mut text) }
    } else {
        unsafe { GetWindowTextW(window, &mut text) }
    } as usize;
    String::from_utf16_lossy(&text[..length.min(text.len())])
}

fn is_tool_window(window: HWND) -> bool {
    let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) } as u32;
    style & WS_EX_TOOLWINDOW.0 != 0
}

fn window_process_image_path(window: HWND) -> Option<String> {
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)); }
    if process_id == 0 {
        return None;
    }
    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?
    };
    let mut path = vec![0u16; 32_768];
    let mut length = path.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    };
    unsafe { let _ = CloseHandle(process); }
    result.ok()?;
    Some(String::from_utf16_lossy(&path[..length as usize]))
}

fn detect_agent_presence() -> AgentPresence {
    unsafe extern "system" fn collect(window: HWND, param: LPARAM) -> BOOL {
        let presence = unsafe { &mut *(param.0 as *mut AgentPresence) };
        let visible = unsafe { IsWindowVisible(window).as_bool() };
        let Some(path) = window_process_image_path(window) else {
            return BOOL(1);
        };
        let Some(agent) = classify_agent_executable(&path) else {
            return BOOL(1);
        };
        let candidate = agent_window_candidate(
            agent,
            visible,
            unsafe { IsIconic(window).as_bool() },
            is_tool_window(window),
            &window_text(window, false),
            &window_text(window, true),
        );
        if candidate {
            match agent {
                "codex" => { if is_default_codex_window(window) { presence.codex = true; } },
                "claude" => presence.claude = true,
                "antigravity" => presence.antigravity = true,
                _ => {}
            }
        }
        BOOL(1)
    }

    let mut presence = AgentPresence { codex: false, claude: false, antigravity: false, codex_profile_isolation: true };
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut presence as *mut _ as isize));
    }
    presence
}

fn wait_for_composer(automation: &UIAutomation, root: &UIElement) -> Option<UIElement> {
    for _ in 0..8 {
        if let Some(element) = find_composer_in(automation, root) {
            return Some(element);
        }
        thread::sleep(Duration::from_millis(450));
    }
    None
}

fn invoke_named_button(
    automation: &UIAutomation,
    root: &UIElement,
    composer: &UIElement,
    names: &[&str],
) -> bool {
    let process_id = match composer.get_process_id() {
        Ok(value) => value,
        Err(_) => return false,
    };
    let button = names.iter().find_map(|name| {
        descendants_named(automation, &root, name)
            .into_iter()
            .find(|element| {
                element.get_control_type().ok() == Some(ControlType::Button)
                    && element
                        .get_process_id()
                        .map(|value| value == process_id)
                        .unwrap_or(false)
                    && !element.is_offscreen().unwrap_or(true)
            })
    });
    let Some(button) = button else { return false };
    button
        .get_pattern::<UIInvokePattern>()
        .and_then(|pattern| pattern.invoke())
        .is_ok()
}

fn select_requested_task(
    automation: &UIAutomation,
    thread_id: &str,
    expected_title: Option<&str>,
) -> Result<UIElement, String> {
    if !valid_thread_id(thread_id) {
        return Err("A valid Codex task id is required".into());
    }
    Command::new("explorer.exe")
        .arg(format!("codex://threads/{thread_id}"))
        .spawn()
        .map_err(|_| "Codex Desktop task navigation could not be started".to_string())?;

    // The thread id is the only stable task identity. Titles can be duplicated
    // or stale, so never use a sidebar title as a navigation fallback.
    // A window restored from the tray needs a few seconds to render the task.
    thread::sleep(Duration::from_millis(700));
    for _ in 0..40 {
        if let Some(root) = codex_root(automation) {
            let title_matches = expected_title
                .filter(|value| !value.trim().is_empty())
                .map(|title| is_active_task(automation, &root, title))
                .unwrap_or(true);
            if title_matches && find_composer_in(automation, &root).is_some() {
                return Ok(root);
            }
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err("Codex Desktop did not confirm the requested task; the message was not sent".into())
}

fn is_active_task(automation: &UIAutomation, root: &UIElement, title: &str) -> bool {
    // Codex Desktop 26.1013.4894.0 exposes the active chat title on its
    // RootWebArea document. The header is now plain Text, and collapsing or
    // scrolling the sidebar removes the selected Button from the visible tree.
    // Use only the app's own document, never a browser/editor pane with the
    // same title. Navigation still uses the UUID and requires a live composer.
    if let Some(active) = active_document_title(automation, root) {
        return active.trim() == title.trim();
    }
    // Most requests carry the full saved title. Checking its few exact UIA
    // matches avoids querying selection/class properties on every sidebar,
    // chat and embedded-browser button during each navigation retry.
    let exact: Vec<UIElement> = descendants_named(automation, root, title)
        .into_iter()
        .filter(|element| matches!(element.get_control_type().ok(), Some(ControlType::Button | ControlType::ListItem)))
        .collect();
    if !exact.is_empty() {
        return exact.iter().any(|element| {
            !element.is_offscreen().unwrap_or(true)
                && (element.get_pattern::<UISelectionItemPattern>()
                    .and_then(|pattern| pattern.is_selected()).unwrap_or(false)
                    || element.get_classname().map(|value| is_active_task_class(&value)).unwrap_or(false))
        });
    }
    active_task_names(automation, root)
        .iter()
        .any(|name| title_matches(name, title))
}

// Codex sometimes exposes the selected sidebar row as a Button and sometimes
// as a ListItem.  Its accessible name can also be prefixed with the unread
// marker or truncated while the sidebar is narrow, so more than one node can
// legitimately qualify for the single active row.  A caller that needs to
// test many candidate titles (see `list_queued`) must find this set once and
// match every title against it in memory: calling `is_active_task` per title
// used to redo this same full sidebar walk once per tracked thread, which is
// what pushed the periodic queue scan past its timeout on accounts with more
// than a handful of threads.
fn active_task_names(automation: &UIAutomation, root: &UIElement) -> Vec<String> {
    if let Some(active) = active_document_title(automation, root) {
        return vec![active];
    }
    [ControlType::Button, ControlType::ListItem]
        .into_iter()
        .flat_map(|control_type| descendants_of_type(automation, root, control_type))
        .filter(|element| {
            !element.is_offscreen().unwrap_or(true)
                && (element
                    .get_pattern::<UISelectionItemPattern>()
                    .and_then(|pattern| pattern.is_selected())
                    .unwrap_or(false)
                    || element
                        .get_classname()
                        .map(|value| is_active_task_class(&value))
                        .unwrap_or(false))
        })
        .map(|element| element.get_name().unwrap_or_default())
        .collect()
}

fn is_app_document(id: &str, url: &str, offscreen: bool) -> bool {
    !offscreen && id == "RootWebArea" && url == "app://-/index.html"
}

fn unique_document_title(titles: Vec<String>) -> Option<String> {
    let mut titles = titles.into_iter().filter(|title| !title.trim().is_empty());
    let first = titles.next()?;
    if titles.next().is_some() { None } else { Some(first) }
}

fn active_document_title(automation: &UIAutomation, root: &UIElement) -> Option<String> {
    unique_document_title(descendants_of_type(automation, root, ControlType::Document)
        .into_iter().filter(|element| is_app_document(
            &element.get_automation_id().unwrap_or_default(),
            &element.get_pattern::<UIValuePattern>().and_then(|p| p.get_value()).unwrap_or_default(),
            element.is_offscreen().unwrap_or(true),
        )).filter_map(|element| element.get_name().ok()).collect())
}

fn title_matches(candidate: &str, expected: &str) -> bool {
    let candidate = normalize_title(candidate);
    let expected = normalize_title(expected);
    if candidate.is_empty() || expected.is_empty() {
        return false;
    }
    if candidate == expected {
        return true;
    }
    // A selected sidebar row may be rendered with an ellipsis. Only accept a
    // meaningful prefix (not a one-character title) so duplicate short task
    // names cannot silently change the single-writer decision.
    let minimum = 6;
    (candidate.len() >= minimum && expected.starts_with(&candidate))
        || (expected.len() >= minimum && candidate.starts_with(&expected))
}

fn normalize_title(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("未读")
        .trim_start_matches("Unread")
        // A truncated sidebar row ends in an ellipsis; compare the prefix only.
        .trim_end_matches('\u{2026}')
        .trim_end_matches("...")
        .split_whitespace()
        .collect::<String>()
        .to_lowercase()
}

fn is_active_task_class(value: &str) -> bool {
    value
        .split_whitespace()
        .any(|token| {
            token == "max-w-full" || token.starts_with("bg-primary-ghost-hover")
        })
}

fn steer_action_names() -> &'static [&'static str] {
    // Codex Desktop / CLI 0.162.0-alpha.2, observed on 2026-10-09:
    // the queued message button is now Chinese "引导"; older builds use
    // "调整方向" and English builds use "Steer".
    &["引导", "调整方向", "Steer"]
}

fn queue_label_candidates(text: &str) -> Vec<String> {
    // 0.162's compact queue label displays just the first prompt line; the
    // request marker remains in the persisted protocol input. Older versions
    // expose the entire input. Never shorten an ordinary one-line prompt.
    // The marker is now zero-width characters (connector 0.2.57), which the
    // accessible label may or may not keep, so also try the text without them.
    let mut candidates: Vec<String> = Vec::new();
    let visible: String = text.chars().filter(|c| !matches!(c, '\u{2063}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}')).collect();
    for full in [text.to_string(), visible] {
        // Codex 26.1007 renders queued prompts as Markdown. A structured
        // async-question reply loses its XML wrapper in the accessible text;
        // the remaining JSON is one Text node, including the question's ID.
        // Matching the common opening tag can never identify an answer.
        let body = full.trim().strip_prefix("<send_user_message_question_reply>")
            .and_then(|value| value.strip_suffix("</send_user_message_question_reply>"))
            .map(str::trim);
        if let Some(body) = body.filter(|body| serde_json::from_str::<serde_json::Value>(body).is_ok()) {
            for label in [full.clone(), body.to_string()] {
                if !label.is_empty() && !candidates.contains(&label) { candidates.push(label); }
            }
            continue;
        }
        let first = full.lines().next().unwrap_or_default().trim().to_string();
        for label in [full.clone(), first] {
            if !label.is_empty() && !candidates.contains(&label) { candidates.push(label); }
        }
    }
    candidates
}

fn find_queued_action(
    automation: &UIAutomation,
    root: &UIElement,
    text: &str,
    names: &[&str],
) -> Option<UIElement> {
    let messages: Vec<UIElement> = queue_label_candidates(text).into_iter()
        .flat_map(|label| descendants_named(automation, root, &label)).collect();
    let visible: Vec<UIElement> = messages
        .into_iter()
        .filter(|element| {
            element.get_control_type().ok() == Some(ControlType::Text)
                && !element.is_offscreen().unwrap_or(true)
        })
        .collect();
    if std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() { eprintln!("queue-scope candidates={}", visible.len()); }
    let mut matched = Vec::new();
    let mut rectangles = Vec::new();
    for message in visible {
        // Use the message's own queue row. In 26.1007 a multiline answer's
        // accessible Text rectangle is taller than its one-line CSS preview;
        // pairing by vertical centre alone misses its Steer button (or pairs
        // a neighbouring row). The nearest ancestor with one queue-delete
        // control identifies a row without relying on prompt height.
        if let Some(button) = scoped_queue_action(automation, root, &message, names) {
            let rect = button.get_bounding_rectangle().ok()?;
            let key = (rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom());
            if !rectangles.contains(&key) { rectangles.push(key); matched.push(button); }
            continue;
        }
        if text.trim_start().starts_with("<send_user_message_question_reply>") {
            continue; // A structured answer must never use a neighbouring row.
        }
        let message_rect = message.get_bounding_rectangle().ok()?;
        let message_center = (message_rect.get_top() + message_rect.get_bottom()) / 2;
        for name in names {
            let buttons = descendants_named(automation, &root, name);
            for button in buttons {
                if button.get_control_type().ok() != Some(ControlType::Button)
                    || button.is_offscreen().unwrap_or(true)
                {
                    continue;
                }
                let rect = match button.get_bounding_rectangle() {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let center = (rect.get_top() + rect.get_bottom()) / 2;
                if (center - message_center).abs() <= 18
                    && rect.get_left() >= message_rect.get_right()
                {
                    let key = (rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom());
                    if !rectangles.contains(&key) {
                        rectangles.push(key);
                        matched.push(button);
                    }
                }
            }
        }
    }
    // Two identical visible previews cannot identify a specific request.
    // Leave both queued instead of steering whichever happens to come first.
    if matched.len() == 1 { matched.pop() } else { None }
}

fn scoped_queue_action(automation: &UIAutomation, root: &UIElement, message: &UIElement, names: &[&str]) -> Option<UIElement> {
    let walker = automation.get_control_view_walker().ok()?;
    let mut ancestor = message.clone();
    for level in 0..8 {
        ancestor = walker.get_parent(&ancestor).ok()?;
        if automation.compare_elements(&ancestor, root).unwrap_or(true) { return None; }
        let deletes: Vec<_> = ["删除排队的消息", "Delete queued message", "Remove queued message"].into_iter()
            .flat_map(|name| descendants_named(automation, &ancestor, name))
            .filter(|element| element.get_control_type().ok() == Some(ControlType::Button) && !element.is_offscreen().unwrap_or(true)).collect();
        if std::env::var_os("FENGZHU_ADAPTER_TRACE").is_some() {
            let rect = ancestor.get_bounding_rectangle().ok();
            eprintln!("queue-scope level={level} deletes={} bounds={rect:?}", deletes.len());
        }
        if !deletes.is_empty() {
            let buttons: Vec<_> = names.iter().flat_map(|name| descendants_named(automation, &ancestor, name))
                .filter(|element| element.get_control_type().ok() == Some(ControlType::Button) && !element.is_offscreen().unwrap_or(true)).collect();
            let bounds = |element: &UIElement| element.get_bounding_rectangle().ok()
                .map(|r| [r.get_left(), r.get_top(), r.get_right(), r.get_bottom()]);
            let delete_bounds: Vec<_> = deletes.iter().map(bounds).collect::<Option<_>>()?;
            let button_bounds: Vec<_> = buttons.iter().map(bounds).collect::<Option<_>>()?;
            // Chromium's Control View sometimes omits the queue-row div. Its
            // first exposed common ancestor then includes the composer too
            // (259 px in the real 2026-10-15 failure). An ancestor-height cap
            // rejects a valid row. Use its actual delete button as the row
            // anchor, while still rejecting transcript text and ambiguous rows.
            let index = queue_row_action_index(bounds(message)?, &delete_bounds, &button_bounds)?;
            return buttons.get(index).cloned();
        }
    }
    None
}

fn queue_row_action_index(message: [i32; 4], deletes: &[[i32; 4]], actions: &[[i32; 4]]) -> Option<usize> {
    let mut matches = Vec::new();
    for delete in deletes {
        let height = delete[3] - delete[1];
        // Text can report the unclipped multiline height. Its first line must
        // still be aligned with this row's delete control.
        if !queue_row_message_matches(message, *delete) { continue; }
        for (index, action) in actions.iter().enumerate() {
            if action[2] <= action[0] || action[3] <= action[1] { continue; }
            let centers = (action[1] + action[3]) / 2 - (delete[1] + delete[3]) / 2;
            if centers.abs() <= (height / 3).max(8) && action[0] > message[0] && action[2] <= delete[0] + 8 {
                matches.push(index);
            }
        }
    }
    if matches.len() == 1 { matches.pop() } else { None }
}

fn queue_row_message_matches(message: [i32; 4], delete: [i32; 4]) -> bool {
    let height = delete[3] - delete[1];
    let tolerance = (height / 2).max(12);
    message[2] > message[0] && message[3] > message[1] && height > 0 && delete[2] > delete[0]
        && message[0] < delete[0] && message[1] >= delete[1] - tolerance && message[1] <= delete[3] + tolerance
}

#[cfg(test)]
mod queue_row_tests {
    use super::{queue_row_action_index, queue_row_message_matches};
    #[test]
    fn real_multiline_answer_uses_its_delete_row_even_when_composer_ancestor_is_tall() {
        assert_eq!(queue_row_action_index([403, 738, 910, 838], &[[984, 736, 1008, 761]], &[[918, 736, 980, 761]]), Some(0));
    }
    #[test]
    fn identical_transcript_text_cannot_borrow_the_queue_action() {
        assert_eq!(queue_row_action_index([403, 600, 910, 700], &[[984, 736, 1008, 761]], &[[918, 736, 980, 761]]), None);
    }
    #[test]
    fn multiple_rows_are_paired_only_with_their_own_action() {
        let deletes = [[984, 736, 1008, 761], [984, 778, 1008, 803]];
        let actions = [[918, 736, 980, 761], [918, 778, 980, 803]];
        assert_eq!(queue_row_action_index([403, 738, 910, 838], &deletes, &actions), Some(0));
        assert_eq!(queue_row_action_index([403, 780, 910, 880], &deletes, &actions), Some(1));
    }
    #[test]
    fn ambiguous_or_missing_controls_are_never_invoked() {
        let message = [403, 738, 910, 838]; let delete = [984, 736, 1008, 761]; let action = [918, 736, 980, 761];
        assert_eq!(queue_row_action_index(message, &[delete, delete], &[action]), None);
        assert_eq!(queue_row_action_index(message, &[delete], &[]), None);
        assert_eq!(queue_row_action_index(message, &[delete], &[[918, 778, 980, 803]]), None);
    }
    #[test]
    fn queue_reader_keeps_the_clipped_answer_and_excludes_the_latest_reply_label() {
        let delete = [984, 736, 1008, 761];
        assert!(queue_row_message_matches([403, 738, 910, 838], delete));
        assert!(!queue_row_message_matches([403, 650, 910, 690], delete));
        assert!(!queue_row_message_matches([403, 780, 910, 880], delete));
    }
}

fn list_queued(automation: &UIAutomation, request: &Request) -> Response {
    let Some(root) = codex_root(automation) else {
        return error(
            "desktop_not_ready",
            "Codex Desktop was not found",
            "not_sent",
        );
    };
    let mut titles = request.known_titles.clone();
    if let Some(title) = request
        .title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        titles.push(title.to_owned());
    }
    titles.retain(|title| !title.trim().is_empty());
    titles.sort();
    titles.dedup();
    // Walk the sidebar once for the active row(s), then match every known
    // title against that small set in memory instead of re-walking the whole
    // tree per title (see `active_task_names`).
    let active_names = active_task_names(automation, &root);
    let active: Vec<String> = titles
        .into_iter()
        .filter(|title| active_names.iter().any(|name| title_matches(name, title)))
        .collect();
    if active.len() != 1 {
        return queue_snapshot(None, Vec::new());
    }
    let mut snapshot = queue_snapshot(
        Some(active[0].clone()),
        visible_queued_items(automation, &root),
    );
    // A Desktop-owned tool approval is not delivered to the connector's own
    // app-server. Observe the currently selected task's visible prompt; never
    // click or approve it here. Both controls must be present in this window.
    snapshot.reason = desktop_approval_observation(automation, &root, &active[0])
        .map(|pending| if pending { "desktop_approval_pending" } else { "desktop_approval_clear" }.into());
    snapshot
}

fn approval_button_names_have_pending(names: &[String]) -> bool {
    let allow = names.iter().any(|name| ["允许一次", "Allow once", "Allow Once"].contains(&name.as_str()));
    let deny = names.iter().any(|name| ["拒绝", "Deny"].contains(&name.as_str()));
    allow && deny
}

fn approval_row_status(rows: &[String], title: &str) -> Option<bool> {
    let mut matched = Vec::new();
    for row in rows {
        for prefix in ["", "Unread", "未读"] {
            let plain = format!("{prefix}{title}");
            if row == &plain { matched.push(false); break; }
            if ["Needs approval", " Needs approval", "需要批准", " 需要批准"]
                .iter().any(|suffix| row == &format!("{plain}{suffix}")) {
                matched.push(true); break;
            }
        }
    }
    if matched.len() == 1 { Some(matched[0]) } else { None }
}

fn desktop_approval_observation(automation: &UIAutomation, root: &UIElement, title: &str) -> Option<bool> {
    // The sidebar supplies an explicit state even when the prompt is scrolled
    // away; checking it first avoids several full-tree searches on every poll.
    let rows: Vec<String> = descendants_of_type(automation, root, ControlType::ListItem)
        .into_iter().map(|element| element.get_name().unwrap_or_default()).collect();
    if let Some(status) = approval_row_status(&rows, title) { return Some(status); }
    let names: Vec<String> = ["允许一次", "Allow once", "Allow Once", "拒绝", "Deny"]
        .into_iter()
        .flat_map(|name| descendants_named(automation, root, name))
        .filter(|element| element.get_control_type().ok() == Some(ControlType::Button)
            && !element.is_offscreen().unwrap_or(true))
        .map(|element| element.get_name().unwrap_or_default())
        .collect();
    if approval_button_names_have_pending(&names) { return Some(true); }
    // With a collapsed or unavailable sidebar, absence of buttons is not
    // proof that the task no longer needs approval.
    None
}

fn visible_queued_items(automation: &UIAutomation, root: &UIElement) -> Vec<DesktopQueuedItem> {
    let action_names = [
        "引导",
        "调整方向",
        "Steer",
        "删除排队的消息",
        "Remove queued message",
        "Delete queued message",
    ];
    let deletes: Vec<_> = ["删除排队的消息", "Remove queued message", "Delete queued message"]
        .into_iter()
        .flat_map(|name| descendants_named(automation, root, name))
        .filter(|button| {
            button.get_control_type().ok() == Some(ControlType::Button)
                && !button.is_offscreen().unwrap_or(true)
        })
        .collect();
    let Ok(walker) = automation.get_control_view_walker() else { return Vec::new(); };
    let mut rows = Vec::new();
    // Walk up from actual queue-delete buttons, never from unrelated transcript
    // text near the queue. The old global Y-distance scan also picked up
    // "最新一条回复", inventing an extra queue item on the phone.
    for delete in deletes {
        let Ok(rect) = delete.get_bounding_rectangle() else { continue; };
        let mut ancestor = delete;
        for _ in 0..8 {
            let Ok(parent) = walker.get_parent(&ancestor) else { break; };
            ancestor = parent;
            if automation.compare_elements(&ancestor, root).unwrap_or(true) { break; }
            let delete_rect = [rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom()];
            let values: Vec<_> = descendants_of_type(automation, &ancestor, ControlType::Text).into_iter()
                .filter(|text| !text.is_offscreen().unwrap_or(true))
                .filter(|text| text.get_bounding_rectangle().map(|r| queue_row_message_matches(
                    [r.get_left(), r.get_top(), r.get_right(), r.get_bottom()], delete_rect)).unwrap_or(false))
                .map(|text| text.get_name().unwrap_or_default().trim().to_string())
                .filter(|value| !value.is_empty() && value.len() <= 16_384 && !action_names.contains(&value.as_str()))
                .collect();
            if let Some(value) = values.into_iter().max_by_key(String::len) {
                rows.push((rect.get_top(), value));
                break;
            }
        }
    }
    rows.sort_by_key(|(top, _)| *top);
    rows.into_iter()
        .fold(Vec::<DesktopQueuedItem>::new(), |mut items, (_, text)| {
            if !items.iter().any(|item| item.text == text) {
                let order = items.len();
                items.push(DesktopQueuedItem { text, order });
            }
            items
        })
}

fn queue_snapshot(active_title: Option<String>, items: Vec<DesktopQueuedItem>) -> Response {
    let collaboration_mode = UIAutomation::new().ok().and_then(|automation| {
        codex_root(&automation).and_then(|root| detect_collaboration_mode(&automation, &root))
    });
    Response {
        ok: true,
        code: "queue_snapshot".into(),
        message: "Codex Desktop queue was read without changing the task".into(),
        delivery: "confirmed".into(),
        active_title,
        items: Some(items),
        effective_collaboration_mode: collaboration_mode,
        desired_collaboration_mode: None,
        mode_sync_state: None,
        reason: None,
        agent_presence: None,
    }
}

fn descendants_named(automation: &UIAutomation, root: &UIElement, name: &str) -> Vec<UIElement> {
    let condition = match automation.create_property_condition(UIProperty::Name, name.into(), None)
    {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    root.find_all(TreeScope::Descendants, &condition)
        .unwrap_or_default()
}

fn descendants_of_type(
    automation: &UIAutomation,
    root: &UIElement,
    control_type: ControlType,
) -> Vec<UIElement> {
    let condition = match automation.create_property_condition(
        UIProperty::ControlType,
        (control_type as i32).into(),
        None,
    ) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    root.find_all(TreeScope::Descendants, &condition)
        .unwrap_or_default()
}

fn dump_controls(automation: &UIAutomation, root: &UIElement) {
    let types = [
        ControlType::Button,
        ControlType::MenuItem,
        ControlType::Text,
        ControlType::Edit,
        ControlType::ListItem,
        ControlType::CheckBox,
        ControlType::ComboBox,
    ];
    for control_type in types {
        for element in descendants_of_type(automation, root, control_type) {
            let name = element.get_name().unwrap_or_default();
            if name.trim().is_empty() || element.is_offscreen().unwrap_or(true) {
                continue;
            }
            let class_name = element.get_classname().unwrap_or_default();
            let bounds = element.get_bounding_rectangle().ok();
            eprintln!(
                "control type={control_type:?} name={name:?} class={class_name:?} bounds={bounds:?}"
            );
        }
    }
}

fn cancel(automation: &UIAutomation, request: Request) -> Response {
    let text = request.text.as_deref().unwrap_or_default();
    if text.is_empty() {
        return error(
            "empty_message",
            "Queued message text is required",
            "not_sent",
        );
    }
    let thread_id = request.thread_id.as_deref().unwrap_or_default();
    if !valid_thread_id(thread_id) {
        return error(
            "invalid_thread_id",
            "A valid Codex task id is required",
            "not_sent",
        );
    }
    let root = match select_requested_task(automation, thread_id, request.title.as_deref()) {
        Ok(value) => value,
        Err(message) => return error("task_identity_unconfirmed", &message, "not_sent"),
    };
    if let Some(button) = find_queued_action(automation, &root, text, &["删除排队的消息"]) {
        if button
            .get_pattern::<UIInvokePattern>()
            .and_then(|pattern| pattern.invoke())
            .is_ok()
        {
            return ok("cancelled", "Queued message was removed from Codex Desktop");
        }
    }
    error(
        "cancel_control_not_found",
        "The matching Codex Desktop queue remove control was not found",
        "not_sent",
    )
}

fn steer_queued(automation: &UIAutomation, request: Request) -> Response {
    let text = request.text.as_deref().unwrap_or_default();
    if text.is_empty() {
        return error(
            "empty_message",
            "Queued message text is required",
            "not_sent",
        );
    }
    let thread_id = request.thread_id.as_deref().unwrap_or_default();
    if !valid_thread_id(thread_id) {
        return error(
            "invalid_thread_id",
            "A valid Codex task id is required",
            "not_sent",
        );
    }
    let mut root = match select_requested_task(automation, thread_id, request.title.as_deref()) {
        Ok(value) => value,
        Err(message) => return error("task_identity_unconfirmed", &message, "not_sent"),
    };
    let queue_wait_started = Instant::now();
    loop {
        if desktop_queue_paused(automation, &root) {
            return error("queue_paused", "The Codex Desktop queue is paused after an interruption", "not_sent");
        }
        if let Some(button) = find_queued_action(automation, &root, text, steer_action_names())
        {
            // A slow read-only UIA search is not an uncertain send. Tell the
            // connector exactly when an invocation becomes possible, before
            // clicking; a lost receipt after this boundary must never retry.
            if let Some(id) = request.transport_id {
                use std::io::Write;
                let mut stdout = io::stdout();
                let _ = writeln!(stdout, "{{\"id\":{id},\"phase\":\"write\"}}");
                let _ = stdout.flush();
            }
            return if button
                .get_pattern::<UIInvokePattern>()
                .and_then(|pattern| pattern.invoke())
                .is_ok()
            {
                ok(
                    "steer_accepted",
                    "Existing queued message was sent to the active Desktop turn",
                )
            } else {
                error(
                    "steer_invoke_failed",
                    "The matching Desktop steer control could not be invoked",
                    "uncertain",
                )
            };
        }
        // queue/add can be acknowledged before Desktop paints the row. Wait
        // for that same row instead of immediately reporting a failed steer.
        if queue_wait_started.elapsed() >= Duration::from_secs(7) { break; }
        thread::sleep(Duration::from_millis(80));
        root = codex_root(automation).unwrap_or(root);
    }
    error(
        "steer_control_not_found",
        "The matching queued message is not available for steering",
        "not_sent",
    )
}

fn is_blank_composer(value: &str, name: &str) -> bool {
    let value = value.trim();
    value.is_empty()
        || value == name.trim()
        || matches!(
            value,
            "可向 Codex 询问任何问题"
                | "Ask Codex anything"
                | "描述你的任务以生成计划…"
                | "Describe your task to generate a plan..."
        )
}

fn blank_plan_draft(value: &str, name: &str) -> Option<String> {
    is_blank_composer(value, name).then(String::new)
}
fn valid_thread_id(value: &str) -> bool {
    value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[cfg(test)]
mod task_identity_tests {
    use super::{is_active_task_class, is_app_document, unique_document_title, title_matches, valid_thread_id};

    #[test]
    fn collapsed_sidebar_uses_the_app_document_without_a_title_button() {
        assert!(is_app_document("RootWebArea", "app://-/index.html", false));
        assert_eq!(unique_document_title(vec!["公园散步安排".into()]).as_deref(), Some("公园散步安排"));
    }

    #[test]
    fn embedded_or_hidden_documents_cannot_confirm_a_chat() {
        assert!(!is_app_document("RootWebArea", "https://example.com/", false));
        assert!(!is_app_document("editor", "app://-/index.html", false));
        assert!(!is_app_document("RootWebArea", "app://-/index.html", true));
    }

    #[test]
    fn ambiguous_or_empty_documents_do_not_confirm_a_chat() {
        assert_eq!(unique_document_title(vec![]), None);
        assert_eq!(unique_document_title(vec![" ".into()]), None);
        assert_eq!(unique_document_title(vec!["对话 A".into(), "对话 B".into()]), None);
    }

    #[test]
    fn inactive_sidebar_hover_classes_do_not_identify_the_active_task() {
        let class = "sidebar-item hover:bg-primary-ghost-hover data-[app-action-sidebar-thread-selected=true]:bg-primary-ghost-hover";
        assert!(!is_active_task_class(class));
    }

    #[test]
    fn selected_sidebar_and_header_classes_identify_the_active_task() {
        assert!(is_active_task_class(
            "sidebar-item bg-primary-ghost-hover focus-visible:outline"
        ));
        assert!(is_active_task_class("truncate leading-6 max-w-full"));
    }

    #[test]
    fn task_identity_requires_a_uuid_shaped_thread_id() {
        assert!(valid_thread_id("019f191a-2ed0-7cf1-9f33-92e3bf5871df"));
        assert!(!valid_thread_id("same-title"));
    }

    #[test]
    fn selected_task_matching_handles_unread_prefix_and_sidebar_truncation() {
        assert!(title_matches("未读 3-2 副服务器", "3-2 副服务器"));
        assert!(title_matches("3-2 副服务器…", "3-2 副服务器"));
        assert!(title_matches(
            "KH Link test: create a file named hello.txt containing hi,\u{2026}",
            "KH Link test: create a file named hello.txt containing hi, then reply DONE."
        ));
        assert!(!title_matches("3-2", "3-2 副服务器"));
    }
}

#[cfg(test)]
mod agent_presence_tests {
    use super::{agent_window_candidate, classify_agent_executable};

    #[test]
    fn distinguishes_desktop_windows_from_connector_helpers() {
        assert_eq!(
            classify_agent_executable(
                r"C:\Program Files\WindowsApps\OpenAI.Codex_26.930.3930.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"
            ),
            Some("codex")
        );
        assert_eq!(
            classify_agent_executable(
                r"C:\Users\me\AppData\Local\OpenAI\Codex\bin\8aaf1547b825b104\codex.exe"
            ),
            None
        );
        assert_eq!(
            classify_agent_executable(
                r"C:\Program Files\WindowsApps\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe"
            ),
            Some("claude")
        );
        assert_eq!(
            classify_agent_executable(
                r"C:\Users\me\AppData\Local\Programs\antigravity\Antigravity.exe"
            ),
            Some("antigravity")
        );
    }
    #[test]
    fn minimized_main_window_still_counts_but_hidden_tool_windows_do_not() {
        assert!(agent_window_candidate(
            "codex",
            true,
            true,
            false,
            "ChatGPT",
            "Chrome_WidgetWin_1"
        ));
        assert!(agent_window_candidate(
            "claude",
            true,
            true,
            false,
            "Claude",
            "Chrome_WidgetWin_1"
        ));
        assert!(agent_window_candidate(
            "claude",
            false,
            true,
            false,
            "Claude",
            "Chrome_WidgetWin_1"
        ));
        assert!(!agent_window_candidate(
            "antigravity",
            false,
            false,
            false,
            "Antigravity",
            "Chrome_WidgetWin_1"
        ));
        assert!(!agent_window_candidate(
            "codex",
            true,
            false,
            true,
            "ChatGPT",
            "Chrome_WidgetWin_1"
        ));
        assert!(!agent_window_candidate(
            "claude",
            true,
            false,
            false,
            "",
            "Chrome_WidgetWin_1"
        ));
    }
}

fn ok(code: &str, message: &str) -> Response {
    Response {
        ok: true,
        code: code.into(),
        message: message.into(),
        delivery: "confirmed".into(),
        active_title: None,
        items: None,
        effective_collaboration_mode: None,
        desired_collaboration_mode: None,
        mode_sync_state: None,
        reason: None,
        agent_presence: None,
    }
}
fn mode_error(
    code: &str,
    message: &str,
    delivery: &str,
    effective: Option<&str>,
    desired: Option<&str>,
    sync_state: &str,
) -> Response {
    Response {
        ok: false,
        code: code.into(),
        message: message.into(),
        delivery: delivery.into(),
        active_title: None,
        items: None,
        effective_collaboration_mode: effective.map(str::to_string),
        desired_collaboration_mode: desired.map(str::to_string),
        mode_sync_state: Some(sync_state.into()),
        reason: Some(message.into()),
        agent_presence: None,
    }
}
fn error(code: &str, message: &str, delivery: &str) -> Response {
    Response {
        ok: false,
        code: code.into(),
        message: message.into(),
        delivery: delivery.into(),
        active_title: None,
        items: None,
        effective_collaboration_mode: None,
        desired_collaboration_mode: None,
        mode_sync_state: None,
        reason: None,
        agent_presence: None,
    }
}
fn print(value: Response, code: i32) {
    println!("{}", serde_json::to_string(&value).unwrap());
    std::process::exit(code);
}

#[cfg(test)]
mod settings_menu_tests {
    use super::{
        category_index, desired_effort_rank, effort_menu_matches, is_modern_speed_toggle_name,
        is_settings_menu_name, menu_failure_code,
        model_menu_matches, modern_effort_rank, option_index, poll_until, requested_fast_mode,
        tier_menu_matches, visible_summary, MenuFailure,
    };
    use std::cell::Cell;
    use std::time::Duration;

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn each_stage_has_its_own_code() {
        assert_eq!(
            menu_failure_code("model", &MenuFailure::SettingsButtonNotFound),
            "settings_button_not_found"
        );
        assert_eq!(
            menu_failure_code("model", &MenuFailure::MenuNotOpened),
            "settings_menu_not_opened"
        );
        assert_eq!(
            menu_failure_code("effort", &MenuFailure::CategoryNotFound { visible: Vec::new() }),
            "effort_category_not_found"
        );
        assert_eq!(
            menu_failure_code("service_tier", &MenuFailure::OptionNotMatched { visible: Vec::new() }),
            "service_tier_option_not_matched"
        );
    }

    #[test]
    fn a_category_item_is_never_taken_as_an_option() {
        let items = names(&["模型 GPT-5.5", "推理强度 高", "速度 标准"]);
        assert_eq!(category_index(&items, "推理强度 "), Some(1));
        assert_eq!(category_index(&items, "文件 "), None);
        // The category item contains the model name, but it is not an option.
        assert_eq!(option_index(&items, "模型 ", |name| name.contains("GPT-5.5")), None);
        let options = names(&["GPT-5.5", "GPT-5.4 mini", "模型 GPT-5.4 mini"]);
        assert_eq!(option_index(&options, "模型 ", |name| name.contains("5.4 mini")), Some(1));
        let modern = names(&["选择模型", "启用快速模式", "强度"]);
        assert_eq!(category_index(&modern, "模型 "), Some(0));
        assert_eq!(option_index(&modern, "模型 ", |name| name.contains("模型")), None);
    }

    #[test]
    fn what_a_menu_showed_is_listed_and_capped() {
        assert_eq!(visible_summary(&[]), "none");
        assert_eq!(visible_summary(&names(&["Auto", "Manual"])), "Auto | Manual");
        let summary = visible_summary(&["字".repeat(400)]);
        assert_eq!(summary.chars().count(), 303);
        assert!(summary.ends_with("..."));
    }

    #[test]
    fn a_wait_ends_as_soon_as_the_menu_appears() {
        let probes = Cell::new(0);
        let found = poll_until(Duration::from_millis(500), Duration::from_millis(1), || {
            probes.set(probes.get() + 1);
            (probes.get() == 3).then_some("open")
        });
        assert_eq!(found, Some("open"));
        assert_eq!(probes.get(), 3);
        assert_eq!(poll_until(Duration::from_millis(5), Duration::from_millis(1), || None::<()>), None);
    }

    #[test]
    fn the_menu_matchers_keep_their_meaning() {
        assert!(model_menu_matches("GPT-5.5", "gpt-5.5"));
        assert!(!model_menu_matches("GPT-5.4", "gpt-5.5"));
        assert!(model_menu_matches("GPT-5.4 mini", "gpt-5.4-mini"));
        assert!(model_menu_matches("GPT-6 Astra", "gpt-6-astra"));
        assert!(model_menu_matches("GPT-6.1 Sol", "gpt-6.1-sol"));
        assert!(!model_menu_matches("GPT-6.1 Sol", "gpt-6-sol"));
        assert!(effort_menu_matches("中", "medium"));
        assert!(effort_menu_matches("极高", "xhigh"));
        assert!(!effort_menu_matches("高", "xhigh"));
        assert!(tier_menu_matches("快速 2 倍速", "priority"));
        assert!(tier_menu_matches("标准", "default"));
    }

    #[test]
    fn modern_strength_and_speed_read_exact_known_values() {
        assert_eq!(modern_effort_rank("GPT-6 Astra 标准，第 2 项，共 6 项。"), Some(1));
        assert_eq!(modern_effort_rank("GPT-6.1 Sol Max，第 5 项，共 6 项。"), Some(4));
        assert_eq!(modern_effort_rank("GPT-6 Astra 标准"), None);
        assert_eq!(desired_effort_rank("ultra"), Some(5));
        assert_eq!(desired_effort_rank("unrecognised"), None);
        assert_eq!(requested_fast_mode("priority"), Some(true));
        assert_eq!(requested_fast_mode("default"), Some(false));
        assert_eq!(requested_fast_mode("unrecognised"), None);
        assert!(is_modern_speed_toggle_name("启用快速模式"));
        assert!(is_modern_speed_toggle_name("启用标准模式"));
        assert!(!is_modern_speed_toggle_name("重置为默认"));
        assert!(!is_settings_menu_name("文件"));
        assert!(is_settings_menu_name("选择模型"));
        assert_eq!(menu_failure_code("effort", &MenuFailure::ConfirmationRequired), "effort_confirmation_required");
    }
}

#[cfg(test)]
mod plan_mode_tests {
    use super::{blank_plan_draft, infer_collaboration_mode, is_plan_command_name, is_running_composer_action};

    #[test]
    fn blank_placeholder_is_not_restored_as_a_draft_and_real_drafts_are_preserved() {
        assert_eq!(blank_plan_draft("和 Codex 一起工作", "和 Codex 一起工作"), Some(String::new()));
        assert_eq!(blank_plan_draft("", "和 Codex 一起工作"), Some(String::new()));
        assert_eq!(blank_plan_draft("真实未发送草稿", "和 Codex 一起工作"), None);
    }

    #[test]
    fn detects_plan_from_indicator_or_placeholder() {
        assert_eq!(infer_collaboration_mode(true, "Do anything"), "plan");
        assert_eq!(
            infer_collaboration_mode(false, "描述你的任务以生成套餐…"),
            "plan"
        );
        assert_eq!(
            infer_collaboration_mode(false, "Describe your task to generate a plan..."),
            "plan"
        );
        assert_eq!(
            infer_collaboration_mode(false, "可向 Codex 询问任何问题"),
            "default"
        );
    }

    #[test]
    fn only_matches_the_enable_plan_command() {
        assert!(is_plan_command_name("计划模式 开启计划模式"));
        assert!(is_plan_command_name("Plan mode Turn plan mode on"));
        assert!(!is_plan_command_name("计划"));
        assert!(!is_plan_command_name("计划模式 关闭计划模式"));
        assert!(!is_plan_command_name("Plan mode Turn plan mode off"));
    }

    #[test]
    fn detects_an_active_turn_from_the_composer_action() {
        assert!(is_running_composer_action("加入队列"));
        assert!(is_running_composer_action("排队"));
        assert!(is_running_composer_action("Queue"));
        assert!(is_running_composer_action("停止"));
        assert!(is_running_composer_action("Stop"));
        assert!(!is_running_composer_action("发送"));
        assert!(!is_running_composer_action("Send"));
    }
}

#[cfg(test)]
mod guarded_write_tests {
    use super::{composer_confirmed_empty, guarded_composer_write, is_queue_paused_text, queue_send_confirmation_names, select_composer_index, send_control_names, ComposerWriteFailure};
    use std::cell::Cell;
    use std::collections::VecDeque;

    #[test]
    fn transient_write_failure_reacquires_a_blank_editor_before_retry() {
        let mut values = VecDeque::from(["", ""]);
        let writes = Cell::new(0);
        let result = guarded_composer_write("hello", 5,
            || values.pop_front().map(|value| (7, value.to_string(), "placeholder".into())),
            |_, _| { writes.set(writes.get() + 1); writes.get() == 2 },
            || {});
        assert_eq!(result, Ok((7, "placeholder".to_string())));
        assert_eq!(writes.get(), 2);
    }

    #[test]
    fn a_draft_appearing_after_a_failed_write_is_never_overwritten_or_sent() {
        for appeared in ["someone else's draft", "hello"] {
            let mut values = VecDeque::from(["", appeared]);
            let writes = Cell::new(0);
            let result = guarded_composer_write("hello", 5,
                || values.pop_front().map(|value| (7, value.to_string(), "placeholder".into())),
                |_, _| { writes.set(writes.get() + 1); false },
                || {});
            assert_eq!(result, Err(ComposerWriteFailure::Busy));
            assert_eq!(writes.get(), 1);
        }
    }

    #[test]
    fn unreadable_editor_is_never_written_and_new_queue_label_is_supported() {
        let writes = Cell::new(0);
        let result: Result<(u8, String), _> = guarded_composer_write("hello", 3,
            || None,
            |_, _| { writes.set(writes.get() + 1); true },
            || {});
        assert_eq!(result, Err(ComposerWriteFailure::Unavailable));
        assert_eq!(writes.get(), 0);
        assert!(send_control_names().contains(&"排队"));
    }

    #[test]
    fn only_the_known_queue_dialog_can_use_the_preserving_send_action() {
        let known = vec!["发送消息？", "你即将发送一条消息。要清除之前已排队的1 条消息吗？", "清空队列", "发送消息"]
            .into_iter().map(str::to_string).collect::<Vec<_>>();
        assert!(queue_send_confirmation_names(&known));
        for missing in 0..known.len() {
            let mut incomplete = known.clone();
            incomplete.remove(missing);
            assert!(!queue_send_confirmation_names(&incomplete));
        }
    }

    #[test]
    fn missing_editor_is_not_a_send_receipt() {
        assert!(!composer_confirmed_empty(None, "和 Codex 一起工作"));
        assert!(!composer_confirmed_empty(Some("draft"), "和 Codex 一起工作"));
        assert!(composer_confirmed_empty(Some(""), "和 Codex 一起工作"));
        assert!(composer_confirmed_empty(Some("和 Codex 一起工作"), "和 Codex 一起工作"));
    }

    #[test]
    fn a_paused_queue_is_not_an_active_send_control() {
        assert!(is_queue_paused_text("由于你中断了当前响应，队列已暂停"));
        assert!(is_queue_paused_text("Queue paused after interrupted turn"));
        assert!(!is_queue_paused_text("正在运行"));
    }

    #[test]
    fn question_answer_editors_are_never_mistaken_for_the_composer() {
        let names = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(select_composer_index(&names(&["或自行撰写回复", "和 Codex 一起工作"])), Some(1));
        assert_eq!(select_composer_index(&names(&["和 Codex 一起工作", "或自行撰写回复"])), Some(0));
        assert_eq!(select_composer_index(&names(&["或自行撰写回复"])), None);
        assert_eq!(select_composer_index(&names(&["unknown one", "unknown two"])), None);
        assert_eq!(select_composer_index(&names(&["unknown composer"])), Some(0));
        assert_eq!(select_composer_index(&names(&["和 Codex 一起工作", "和 Codex 一起工作"])), None);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_approval_requires_both_visible_decision_buttons() {
        use super::approval_button_names_have_pending as pending;
        assert!(pending(&["允许一次".into(), "拒绝".into()]));
        assert!(pending(&["Allow once".into(), "Deny".into()]));
        assert!(!pending(&["允许一次".into()]));
        assert!(!pending(&["拒绝".into()]));
        assert!(!pending(&["已允许".into(), "拒绝".into()]));
        assert_eq!(super::approval_row_status(&["回复好的Needs approval".into()], "回复好的"), Some(true));
        assert_eq!(super::approval_row_status(&["回复好的".into()], "回复好的"), Some(false));
        assert_eq!(super::approval_row_status(&["其他对话Needs approval".into()], "回复好的"), None);
        assert_eq!(super::approval_row_status(&["回复好的Needs approval".into(), "回复好的".into()], "回复好的"), None);
    }

    #[test]
    fn attachment_dialog_cannot_belong_to_another_account_or_app() {
        use super::file_dialog_matches as matches;
        assert!(matches(100, Some(100), "#32770", "打开", true));
        assert!(!matches(100, Some(200), "#32770", "打开", true));
        assert!(!matches(100, None, "#32770", "打开", true));
        assert!(!matches(100, Some(100), "#32770", "打开", false));
    }

    #[test]
    fn remote_control_excludes_every_explicit_codex_profile() {
        use super::command_uses_default_profile as primary;
        assert!(primary(r#""C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe""#));
        assert!(!primary(r#"ChatGPT.exe --user-data-dir=G:\Apps\CodexSwitch\profiles\a\desktop"#));
        assert!(!primary(r#"ChatGPT.exe "--user-data-dir=G:\Account With Spaces\desktop""#));
        assert!(!primary(r#"ChatGPT.exe --USER-DATA-DIR "G:\Other\desktop""#));
        assert!(!primary(r#"ChatGPT.exe "--user-data-dir" "G:\Other\desktop""#));
    }

    #[test]
    fn native_command_line_query_can_identify_its_own_process() {
        let line = super::process_command_line(std::process::id()).expect("native process query");
        assert!(line.to_ascii_lowercase().contains("fengzhu_desktop_adapter"));
        assert!(super::process_command_line(0).is_none());
    }

    #[test]
    fn queued_steering_handles_the_0162_compact_label_and_new_chinese_action() {
        let text = "Please continue\n\n[KH_LINK_REQUEST_ID:test-id]";
        assert_eq!(super::queue_label_candidates(text), vec![text, "Please continue"]);
        assert_eq!(super::queue_label_candidates("Please continue"), vec!["Please continue"]);
        let invisible = "Please continue\u{2063}\u{200b}\u{200c}\u{2063}";
        assert_eq!(super::queue_label_candidates(invisible), vec![invisible, "Please continue"]);
        assert!(super::steer_action_names().contains(&"引导"));
        assert!(super::steer_action_names().contains(&"调整方向"));
        assert!(super::steer_action_names().contains(&"Steer"));
    }
    #[test]
    fn queued_async_answer_matches_the_json_markdown_node_not_the_shared_xml_tag() {
        let body = r#"[{"questionItemId":"[\"request_user_input_async\",\"call_A\",0]","question":"选哪个？","answer":"中文回答"}]"#;
        let text = format!("<send_user_message_question_reply>\n{body}\n</send_user_message_question_reply>");
        let candidates = super::queue_label_candidates(&text);
        assert!(candidates.contains(&body.to_string()));
        assert!(!candidates.contains(&"<send_user_message_question_reply>".to_string()));
        assert!(!candidates.contains(&"中文回答".to_string()));
        let other = text.replace("call_A", "call_B");
        assert!(!super::queue_label_candidates(&other).contains(&body.to_string()));
    }
    use super::{Request, is_blank_composer};
    #[test]
    fn placeholder_is_blank() {
        assert!(is_blank_composer("\n随心输入", "随心输入"));
        assert!(is_blank_composer("可向 Codex 询问任何问题", "输入消息"));
        assert!(is_blank_composer("Ask Codex anything", "Input message"));
        assert!(is_blank_composer("描述你的任务以生成计划…", "输入消息"));
    }
    #[test]
    fn draft_is_not_blank() {
        assert!(!is_blank_composer("待发送内容", "随心输入"));
    }

    #[test]
    fn request_keeps_desktop_attachment_metadata() {
        let request: Request = serde_json::from_str(
            r#"{"action":"dispatch","attachments":[{"name":"phone.png","path":"C:\\Temp\\phone.png","size":42,"mimeType":"image/png"}]}"#,
        )
        .unwrap();
        assert_eq!(request.attachments.len(), 1);
        assert_eq!(request.attachments[0].name, "phone.png");
        assert_eq!(request.attachments[0].path, r"C:\Temp\phone.png");
    }
}
