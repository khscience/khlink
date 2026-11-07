mod claude_profiles;
mod codex_profiles;
mod connector_update;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use qrcode::QrCode;
use qrcode::render::svg;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State, WindowEvent};
use url::Url;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows::core::w;
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;
use x25519_dalek::{PublicKey, StaticSecret};

// The relay is at khsci.vip since 2026-10-28. It was on
// 45.59.131.115, which only forwards there until it is shut down.
const DEFAULT_SERVER: &str = "https://khsci.vip/fengzhu-bridge";
const LEGACY_SERVERS: &[&str] = &[
    "https://45.59.131.115/fengzhu-bridge",
    "https://www.khsci.vip/fengzhu-bridge",
];

/// A saved relay address from before the move points at the new one; the
/// accounts, devices and sessions moved with it.
fn current_server(saved: String) -> String {
    if LEGACY_SERVERS.contains(&saved.trim_end_matches('/')) {
        DEFAULT_SERVER.to_string()
    } else {
        saved
    }
}
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "KHLink";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    device_id: String,
    private_key: String,
    account_key: String,
}

impl Identity {
    fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let mut account_key = [0u8; 32];
        OsRng.fill_bytes(&mut account_key);
        Self {
            device_id: uuid_like(),
            private_key: B64.encode(secret.to_bytes()),
            account_key: B64.encode(account_key),
        }
    }

    fn public_key(&self) -> Result<String, String> {
        let bytes = decode_32(&self.private_key)?;
        let secret = StaticSecret::from(bytes);
        Ok(B64.encode(PublicKey::from(&secret).as_bytes()))
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    account_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    profile: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretFile {
    identity: Identity,
    session: Option<Session>,
    // This computer joined an account that already has another computer and
    // waits for that account's shared key before it starts its connector.
    #[serde(default)]
    awaiting_shared_key: bool,
    // The account the identity's account key was made for or received from.
    // Logging in to a different account on this computer gets a fresh key, so
    // the new account never shares the previous account's key.
    #[serde(default)]
    key_account_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredFile {
    server: String,
    protected: String,
}

#[derive(Clone)]
struct CallbackResult {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Clone)]
struct PendingLogin {
    verifier: String,
    state: String,
    callback: Arc<Mutex<Option<CallbackResult>>>,
    expires_at: Instant,
    cancelled: Arc<AtomicBool>,
}

struct Runtime {
    server: String,
    secrets: SecretFile,
    pending_login: Option<PendingLogin>,
}

struct AppState(Arc<Mutex<Runtime>>);

fn lock_runtime(state: &Mutex<Runtime>) -> Result<std::sync::MutexGuard<'_, Runtime>, String> {
    match state.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => {
            eprintln!("khLink runtime lock recovered after a previous request failure");
            Ok(poisoned.into_inner())
        }
    }
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("后台操作异常结束：{error}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopState {
    authenticated: bool,
    connection_mode: String,
    server: String,
    device_id: String,
    profile: Option<Value>,
    autostart: bool,
    connector: Value,
    awaiting_shared_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingView {
    id: String,
    secret: String,
    expires_at: u64,
    payload: String,
    qr_svg: String,
}

fn app_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "无法定位用户配置目录".to_string())?;
    Ok(base.join("KHLink"))
}

fn store_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("session.json"))
}

fn diagnostics_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("diagnostics.jsonl"))
}

fn diagnostics_state_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("diagnostics-state.json"))
}

fn connector_config_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "无法定位用户配置目录".to_string())?;
    Ok(base.join("FengzhuAgentBridge").join("config.json"))
}

fn uuid_like() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            w!("khLink"),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|error| format!("DPAPI 加密失败：{error}"))?;
        let value = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(value)
    }
}

fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|error| format!("DPAPI 解密失败：{error}"))?;
        let value = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(value)
    }
}

fn load_runtime() -> Runtime {
    let loaded = store_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| {
            let outer: StoredFile = serde_json::from_str(&text).ok()?;
            let encrypted = B64.decode(outer.protected).ok()?;
            let plain = unprotect(&encrypted).ok()?;
            let mut secrets: SecretFile = serde_json::from_slice(&plain).ok()?;
            // Older files have no owner for the key: it belongs to the account
            // that is signed in now, if any.
            if secrets.key_account_id.is_none() {
                secrets.key_account_id = secrets.session.as_ref().map(|session| session.account_id.clone());
            }
            Some((current_server(outer.server), secrets))
        });
    let (server, secrets) = loaded.unwrap_or_else(|| {
        (
            DEFAULT_SERVER.to_string(),
            SecretFile {
                identity: Identity::generate(),
                session: None,
                awaiting_shared_key: false,
                key_account_id: None,
            },
        )
    });
    Runtime {
        server,
        secrets,
        pending_login: None,
    }
}

fn save_runtime(runtime: &Runtime) -> Result<(), String> {
    let directory = app_dir()?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建配置目录失败：{error}"))?;
    let plain = serde_json::to_vec(&runtime.secrets).map_err(|error| error.to_string())?;
    let stored = StoredFile {
        server: runtime.server.clone(),
        protected: B64.encode(protect(&plain)?),
    };
    let temporary = directory.join("session.json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&stored).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("保存会话失败：{error}"))?;
    fs::rename(temporary, store_path()?).map_err(|error| format!("提交会话失败：{error}"))
}

fn request(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut client_builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15));
    let loopback = Url::parse(url).ok().is_some_and(|url| {
        matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("[::1]")
        )
    });
    if loopback {
        client_builder = client_builder.no_proxy();
    } else if let Some(proxy) = wininet_proxy_url() {
        client_builder = client_builder
            .proxy(reqwest::Proxy::all(proxy).map_err(|error| format!("代理配置无效：{error}"))?);
    }
    let client = client_builder.build().map_err(|error| error.to_string())?;
    let mut builder = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        _ => return Err("不支持的请求方法".into()),
    };
    if let Some(token) = token {
        builder = builder.bearer_auth(token);
    }
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let response = builder
        .send()
        .map_err(|error| format!("无法连接 khLink 服务：{error:?}"))?;
    let status = response.status();
    let value = response.json::<Value>().unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("服务请求失败");
        return Err(format!("{message} ({})", status.as_u16()));
    }
    Ok(value)
}

fn wininet_proxy_url() -> Option<String> {
    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    if settings.get_value::<u32, _>("ProxyEnable").ok()? == 0 {
        return None;
    }
    let raw = settings.get_value::<String, _>("ProxyServer").ok()?;
    let value = raw
        .split(';')
        .find_map(|part| {
            part.strip_prefix("https=")
                .or_else(|| part.strip_prefix("http="))
        })
        .unwrap_or(raw.as_str())
        .trim();
    if value.is_empty() {
        None
    } else if value.starts_with("http://") || value.starts_with("https://") {
        Some(value.to_string())
    } else {
        Some(format!("http://{value}"))
    }
}

/// Take a short snapshot of the runtime, perform token refresh outside the
/// global mutex, then write back only the refreshed session.  Network calls
/// must not hold the mutex: the UI polls `get_state` while these commands run.
fn request_context(state: &Mutex<Runtime>) -> Result<(String, String), String> {
    // Refresh tokens rotate. Serialize refreshes without holding the UI's lock.
    static REFRESH: OnceLock<Mutex<()>> = OnceLock::new();
    let _refresh = REFRESH
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "账户刷新状态失效".to_string())?;
    let (server, session, device_id) = {
        let runtime = lock_runtime(state)?;
        (
            runtime.server.clone(),
            runtime
                .secrets
                .session
                .clone()
                .ok_or_else(|| "尚未登录".to_string())?,
            runtime.secrets.identity.device_id.clone(),
        )
    };
    if session.expires_at > now_ms() + 60_000 {
        return Ok((server, session.access_token));
    }

    let response = request(
        "POST",
        &format!("{server}/api/v2/session/refresh"),
        None,
        Some(json!({
            "accountId": session.account_id,
            "deviceId": device_id,
            "refreshToken": session.refresh_token,
        })),
    );
    let value = match response {
        Ok(value) => value,
        Err(error) => {
            if error.contains("(401)") {
                let mut runtime = lock_runtime(state)?;
                if runtime
                    .secrets
                    .session
                    .as_ref()
                    .is_some_and(|current| current.refresh_token == session.refresh_token)
                {
                    runtime.secrets.session = None;
                    save_runtime(&runtime)?;
                }
            }
            return Err(error);
        }
    };
    let access_token = field(&value, "accessToken")?;
    let refresh_token = field(&value, "refreshToken")?;
    let expires_at = value
        .get("expiresAt")
        .and_then(Value::as_u64)
        .ok_or_else(|| "刷新响应缺少 expiresAt".to_string())?;
    {
        let mut runtime = lock_runtime(state)?;
        if let Some(current) = runtime.secrets.session.as_mut() {
            if current.account_id == session.account_id
                && current.refresh_token == session.refresh_token
            {
                current.access_token = access_token.clone();
                current.refresh_token = refresh_token;
                current.expires_at = expires_at;
                save_runtime(&runtime)?;
            } else {
                return Err("账户已改变，请重试".into());
            }
        } else {
            return Err("尚未登录".into());
        }
    }
    Ok((server, access_token))
}

fn connector_config_matches(runtime: &Runtime) -> bool {
    if runtime.secrets.awaiting_shared_key {
        return false;
    }
    let Some(session) = runtime.secrets.session.as_ref() else {
        return false;
    };
    connector_config_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|value| {
            value.get("protocolVersion").and_then(Value::as_u64) == Some(2)
                && value.get("accountId").and_then(Value::as_str)
                    == Some(session.account_id.as_str())
                && value.get("deviceId").and_then(Value::as_str)
                    == Some(format!("{}.connector", runtime.secrets.identity.device_id).as_str())
        })
}

/// Opens a device-key v3 envelope (the connector's wrap for a phone, used here
/// for a joining computer): X25519 with this installation's key, SHA-256 key
/// derivation and XChaCha20-Poly1305 bound to the account and device ids.
fn open_device_key_envelope(
    identity: &Identity,
    account_id: &str,
    envelope: &Value,
) -> Result<String, String> {
    if envelope.get("version").and_then(Value::as_u64) != Some(3) {
        return Err("账户密钥信封版本不对".into());
    }
    let private = StaticSecret::from(decode_32(&identity.private_key)?);
    let sender = PublicKey::from(decode_32(&field(envelope, "senderPublicKey")?)?);
    let shared = private.diffie_hellman(&sender);
    let mut hasher = Sha256::new();
    hasher.update(b"KH Link device-key v3");
    hasher.update(shared.as_bytes());
    hasher.update(identity.device_id.as_bytes());
    let key_bytes = hasher.finalize();
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key_bytes));
    let nonce = B64
        .decode(field(envelope, "nonce")?)
        .map_err(|_| "账户密钥信封无效".to_string())?;
    let ciphertext = B64
        .decode(field(envelope, "ciphertext")?)
        .map_err(|_| "账户密钥信封无效".to_string())?;
    if nonce.len() != 24 {
        return Err("账户密钥信封无效".into());
    }
    let aad = format!("kh-link-device-key-v3|{account_id}|{}", identity.device_id);
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "账户密钥解不开：信封不是给这台电脑的".to_string())?;
    if plain.len() != 32 {
        return Err("账户密钥长度不对".into());
    }
    Ok(B64.encode(plain))
}

/// A computer joining an account that already has one takes that account's
/// key, so the phone reads every computer with one key. A connector running
/// on another computer wraps it to this installation's public key; this waits
/// up to `wait` for it. Returns true once the key is adopted (or none was needed).
fn adopt_shared_key(shared: &Mutex<Runtime>, wait: Duration) -> Result<bool, String> {
    if !lock_runtime(shared)?.secrets.awaiting_shared_key {
        return Ok(true);
    }
    let started = Instant::now();
    loop {
        let (server, access_token) = request_context(shared)?;
        let response = request(
            "GET",
            &format!("{server}/api/v2/session/key-envelope"),
            Some(&access_token),
            None,
        )?;
        if let Some(text) = response.get("keyEnvelope").and_then(Value::as_str) {
            let envelope: Value =
                serde_json::from_str(text).map_err(|_| "账户密钥信封无效".to_string())?;
            let mut runtime = lock_runtime(shared)?;
            let account_id = runtime
                .secrets
                .session
                .as_ref()
                .map(|session| session.account_id.clone())
                .ok_or_else(|| "尚未登录".to_string())?;
            let key = open_device_key_envelope(&runtime.secrets.identity, &account_id, &envelope)?;
            runtime.secrets.identity.account_key = key;
            runtime.secrets.awaiting_shared_key = false;
            save_runtime(&runtime)?;
            return Ok(true);
        }
        if started.elapsed() >= wait {
            return Ok(false);
        }
        thread::sleep(Duration::from_secs(3));
    }
}

const SHARED_KEY_WAITING: &str =
    "这个账号已经有另一台电脑。请保持那台电脑上的 khLink 在线，这台电脑会自动拿到共享的账户密钥后开始同步。";

fn provision_connector_runtime(shared: &Mutex<Runtime>) -> Result<Value, String> {
    let (server, access_token) = request_context(shared)?;
    let identity = lock_runtime(shared)?.secrets.identity.clone();
    let desktop_name = hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let response = request(
        "POST",
        &format!("{server}/api/v2/connector/session"),
        Some(&access_token),
        Some(json!({
            "deviceName": format!("{desktop_name} 后台连接器"),
        })),
    )?;
    let account_id = field(&response, "accountId")?;
    let device_id = field(&response, "deviceId")?;
    let refresh_token = field(&response, "refreshToken")?;
    let path = connector_config_path()?;
    let previous = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    let workspace = previous
        .get("workspace")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_else(|| "C:\\".to_string());
    let codex_bin = previous.get("codexBin").cloned().unwrap_or(Value::Null);
    let secrets = json!({
        "accountKey": identity.account_key,
        "refreshToken": refresh_token,
    });
    let protected = B64.encode(protect(
        &serde_json::to_vec(&secrets).map_err(|error| error.to_string())?,
    )?);
    let config = json!({
        "protocolVersion": 2,
        "serverUrl": server,
        "accountId": account_id,
        "deviceId": device_id,
        "deviceName": format!("{desktop_name} 后台连接器"),
        "workspace": workspace,
        "codexBin": codex_bin,
        "directOnly": false,
        "protected": protected,
    });
    let directory = path
        .parent()
        .ok_or_else(|| "连接器配置目录无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| format!("创建连接器配置目录失败：{error}"))?;
    fs::write(
        path,
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("保存连接器账户会话失败：{error}"))?;
    Ok(json!({ "configured": true, "accountId": account_id, "deviceId": device_id }))
}

fn field(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("服务响应缺少 {name}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn decode_32(value: &str) -> Result<[u8; 32], String> {
    B64.decode(value)
        .map_err(|_| "密钥编码无效".to_string())?
        .try_into()
        .map_err(|_| "密钥长度无效".to_string())
}

fn connector_status() -> Value {
    let path = dirs::config_dir()
        .unwrap_or_default()
        .join("FengzhuAgentBridge")
        .join("status.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({ "online": false, "label": "连接器未运行" }))
}

/// How many sessions wait for the user right now, from a fresh status file.
fn waiting_sessions(status: &Value) -> usize {
    let updated_at = status.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
    if updated_at == 0 || now_ms().saturating_sub(updated_at) > 30_000 {
        return 0;
    }
    status
        .get("activeThreads")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|row| {
                    row.get("status")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s.contains("waiting"))
                })
                .count()
        })
        .unwrap_or(0)
}

/// The tray icon with an orange dot (white rim) in the lower right corner.
fn badged_icon(base: &tauri::image::Image<'_>) -> tauri::image::Image<'static> {
    let (width, height) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    let radius = width.min(height) as f32 * 0.24;
    let (cx, cy) = (width as f32 - radius - 0.5, height as f32 - radius - 0.5);
    for y in 0..height {
        for x in 0..width {
            let distance = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            if distance > radius + 1.0 {
                continue;
            }
            let (r, g, b) = if distance <= radius - 0.8 {
                (0xF5, 0x9E, 0x0B)
            } else {
                (0xFF, 0xFF, 0xFF)
            };
            let i = ((y * width + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&[r, g, b, 0xFF]);
        }
    }
    tauri::image::Image::new_owned(rgba, width, height)
}

fn connector_observation(connector: &Value) -> (bool, bool, u64, String) {
    let updated_at = connector
        .get("updatedAt")
        .or_else(|| connector.get("updated_at"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let age = if updated_at == 0 {
        u64::MAX
    } else {
        now_ms().saturating_sub(updated_at)
    };
    let heartbeat_fresh = updated_at > 0 && age <= 15_000;
    let reports_online = connector
        .get("online")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || connector
            .get("connected")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || connector.get("state").and_then(Value::as_str) == Some("online");
    let online = reports_online && heartbeat_fresh;
    let lifecycle = connector
        .get("lifecycle")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    (online, heartbeat_fresh, age, lifecycle)
}

fn record_connector_observation(connector: &Value) {
    let (online, heartbeat_fresh, age, lifecycle) = connector_observation(connector);
    let restart_safe = connector
        .get("restartSafe")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let status_missing =
        connector.get("updatedAt").is_none() && connector.get("updated_at").is_none();
    let key = format!(
        "{}|{}|{}|{}|{}",
        online, heartbeat_fresh, lifecycle, restart_safe, status_missing
    );
    let previous = diagnostics_state_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("key")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
    if previous.as_deref() == Some(key.as_str()) {
        return;
    }
    let level = if online && heartbeat_fresh && lifecycle == "running" && restart_safe {
        "info"
    } else {
        "warn"
    };
    let kind = if status_missing {
        "status_missing"
    } else if !heartbeat_fresh {
        "heartbeat_stale"
    } else if !online {
        "connector_offline"
    } else if lifecycle != "running" {
        "lifecycle_changed"
    } else if !restart_safe {
        "restart_not_safe"
    } else {
        "connection_recovered"
    };
    let entry = json!({
        "at": now_ms(), "level": level, "kind": kind,
        "message": if online { "连接器状态已恢复" } else { "连接器状态异常或心跳过期" },
        "online": online, "heartbeatFresh": heartbeat_fresh,
        "heartbeatAgeMs": if age == u64::MAX { Value::Null } else { json!(age) },
        "lifecycle": lifecycle,
        "version": connector.get("version").cloned().unwrap_or(Value::Null),
        "activeThreads": connector.get("activeThreads").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
    });
    if let Ok(path) = diagnostics_path() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(existing) = fs::read_to_string(&path) {
            let lines = existing.lines().collect::<Vec<_>>();
            if lines.len() > 500 {
                let retained = lines[lines.len() - 400..].join("\n") + "\n";
                let _ = fs::write(&path, retained);
            }
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{}", entry);
        }
    }
    if let Ok(path) = diagnostics_state_path() {
        let _ = fs::write(path, json!({ "key": key, "at": now_ms() }).to_string());
    }
}

fn recent_diagnostics(limit: usize) -> Vec<Value> {
    let Ok(path) = diagnostics_path() else {
        return Vec::new();
    };
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let lines = BufReader::new(file).lines().flatten().collect::<Vec<_>>();
    let mut entries = Vec::new();
    for line in lines.into_iter().rev().take(limit) {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            entries.push(value);
        }
    }
    entries.reverse();
    entries
}

#[derive(Default)]
struct UsageTotals {
    input: u64,
    cached_input: u64,
    output: u64,
    reasoning: u64,
    total: u64,
    sessions: u64,
}

/// Last cumulative usage per Codex session file, with the file's size and
/// modified time. Reading every rollout in full (16 GB in 700+ files) every
/// 30 s kept a CPU core busy; now an unchanged file costs one stat and a
/// changed one only its tail.
type UsageCache = HashMap<PathBuf, (u64, SystemTime, Option<Value>)>;
static USAGE_CACHE: OnceLock<Mutex<UsageCache>> = OnceLock::new();
const USAGE_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// The usage in the last token_count record of `text`. Newer Codex sessions
/// expose the cumulative total; older records only the last turn's usage.
fn latest_token_usage(text: &str) -> Option<Value> {
    text.lines().rev().find_map(|line| {
        if !line.contains("\"token_count\"") {
            return None;
        }
        let value = serde_json::from_str::<Value>(line).ok()?;
        let payload = value.get("payload")?;
        if payload.get("type")?.as_str()? != "token_count" {
            return None;
        }
        let info = payload.get("info")?;
        info.get("total_token_usage")
            .or_else(|| info.get("last_token_usage"))
            .cloned()
    })
}

fn file_token_usage(path: &PathBuf, len: u64) -> Option<Value> {
    let mut file = fs::File::open(path).ok()?;
    if len > USAGE_TAIL_BYTES {
        file.seek(SeekFrom::Start(len - USAGE_TAIL_BYTES)).ok()?;
        let mut tail = Vec::new();
        Read::by_ref(&mut file)
            .take(USAGE_TAIL_BYTES)
            .read_to_end(&mut tail)
            .ok()?;
        if let Some(usage) = latest_token_usage(&String::from_utf8_lossy(&tail)) {
            return Some(usage);
        }
        file.seek(SeekFrom::Start(0)).ok()?;
    }
    let mut latest = None;
    for line in BufReader::new(file).lines().flatten() {
        if let Some(usage) = latest_token_usage(&line) {
            latest = Some(usage);
        }
    }
    latest
}

fn scan_usage_dir(
    path: &PathBuf,
    totals: &mut UsageTotals,
    cache: &mut UsageCache,
    seen: &mut HashSet<PathBuf>,
) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            scan_usage_dir(&child, totals, cache, seen);
            continue;
        }
        if child.extension().and_then(|v| v.to_str()) != Some("jsonl") {
            continue;
        }
        let len = meta.len();
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        seen.insert(child.clone());
        let usage = match cache.get(&child) {
            Some((cached_len, cached_modified, usage))
                if *cached_len == len && *cached_modified == modified =>
            {
                usage.clone()
            }
            _ => {
                let usage = file_token_usage(&child, len);
                cache.insert(child.clone(), (len, modified, usage.clone()));
                usage
            }
        };
        let Some(usage) = usage else { continue };
        let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        totals.sessions += 1;
        totals.input += count("input_tokens");
        totals.cached_input += count("cached_input_tokens");
        totals.output += count("output_tokens");
        totals.reasoning += count("reasoning_output_tokens");
        totals.total += count("total_tokens");
    }
}

fn codex_usage() -> Value {
    let root = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|path| path.join(".codex")));
    let mut totals = UsageTotals::default();
    if let Some(root) = root {
        let mut cache = USAGE_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut seen = HashSet::new();
        scan_usage_dir(&root.join("sessions"), &mut totals, &mut cache, &mut seen);
        cache.retain(|path, _| seen.contains(path));
    }
    json!({ "inputTokens": totals.input, "cachedInputTokens": totals.cached_input,
        "outputTokens": totals.output, "reasoningOutputTokens": totals.reasoning,
        "totalTokens": totals.total, "sessionCount": totals.sessions, "updatedAt": now_ms() })
}

fn connector_is_running() -> bool {
    connector_status()
        .get("updatedAt")
        .and_then(Value::as_u64)
        .is_some_and(|updated_at| now_ms().saturating_sub(updated_at) <= 15_000)
}

fn start_connector_task() -> Result<(), String> {
    if connector_is_running() {
        return Ok(());
    }
    let mut command = Command::new("schtasks.exe");
    command.args(["/Run", "/TN", "FengzhuAgentBridge"]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|error| format!("无法启动后台连接器：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "后台连接器启动失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn autostart_enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .ok()
        .and_then(|key| key.get_value::<String, _>(RUN_VALUE).ok())
        .is_some()
}

#[tauri::command]
fn get_state(state: State<AppState>) -> Result<DesktopState, String> {
    let connector = connector_status();
    record_connector_observation(&connector);
    let autostart = autostart_enabled();
    let runtime = lock_runtime(&state.0)?;
    let connection_mode = connector_config_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|config| {
            if config["directOnly"] == true {
                "direct"
            } else {
                "server"
            }
        })
        .unwrap_or("server")
        .to_string();
    Ok(DesktopState {
        authenticated: runtime.secrets.session.is_some(),
        connection_mode,
        server: runtime.server.clone(),
        device_id: runtime.secrets.identity.device_id.clone(),
        profile: runtime
            .secrets
            .session
            .as_ref()
            .map(|session| session.profile.clone()),
        autostart,
        connector,
        awaiting_shared_key: runtime.secrets.awaiting_shared_key,
    })
}

#[tauri::command]
fn diagnostics() -> Result<Value, String> {
    let connector = connector_status();
    record_connector_observation(&connector);
    let (online, heartbeat_fresh, age, lifecycle) = connector_observation(&connector);
    let status_file_ok =
        connector.get("updatedAt").is_some() || connector.get("updated_at").is_some();
    Ok(json!({
        "current": connector,
        "checks": [
            { "name": "连接器心跳", "ok": online && heartbeat_fresh, "message": if online && heartbeat_fresh { "心跳正常" } else { "心跳缺失或已过期" } },
            { "name": "状态文件", "ok": status_file_ok, "message": if status_file_ok { "状态文件可读" } else { "尚未发现连接器状态" } },
            { "name": "生命周期", "ok": lifecycle == "running", "message": format!("当前为 {lifecycle}") },
        ],
        "heartbeatAgeMs": if age == u64::MAX { Value::Null } else { json!(age) },
        "entries": recent_diagnostics(100),
    }))
}

#[tauri::command]
fn clear_diagnostics() -> Result<(), String> {
    if let Ok(path) = diagnostics_path() {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = diagnostics_state_path() {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
async fn usage() -> Result<Value, String> {
    run_blocking(|| Ok(codex_usage())).await
}

#[tauri::command]
async fn begin_login(state: State<'_, AppState>) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || begin_login_runtime(&shared)).await
}

#[cfg(test)]
mod login_flow_tests {
    use super::*;
    use std::net::TcpStream;
    use std::sync::mpsc;

    fn pending(callback: Option<CallbackResult>) -> PendingLogin {
        PendingLogin {
            verifier: "test-verifier".into(),
            state: "expected-state".into(),
            callback: Arc::new(Mutex::new(callback)),
            expires_at: Instant::now() + Duration::from_secs(30),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn callback_ignores_unrelated_requests_and_requires_the_original_state() {
        for line in [
            "GET /favicon.ico HTTP/1.1",
            "GET /callback?state=wrong&code=test HTTP/1.1",
            "GET /callback?state=expected-state HTTP/1.1",
            "POST /callback?state=expected-state&code=test HTTP/1.1",
        ] {
            assert!(login_callback(line, "expected-state").is_none());
        }
        let value = login_callback(
            "GET /callback?state=expected-state&code=test%2Bcode HTTP/1.1",
            "expected-state",
        )
        .unwrap();
        assert_eq!(value.code.as_deref(), Some("test+code"));
        assert!(
            login_callback(
                "GET /callback?state=expected-state&error=access_denied HTTP/1.1",
                "expected-state"
            )
            .unwrap()
            .error
            .is_some()
        );
    }

    #[test]
    fn loopback_listener_survives_favicon_and_accepts_the_real_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let slot = Arc::new(Mutex::new(None));
        listen_for_callback(
            listener,
            slot.clone(),
            "expected-state".into(),
            Arc::new(AtomicBool::new(false)),
        );
        let send = |path: &str| {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        assert!(send("/favicon.ico").starts_with("HTTP/1.1 400"));
        assert!(slot.lock().unwrap().is_none());
        assert!(send("/callback?code=real-code&state=expected-state").starts_with("HTTP/1.1 200"));
        assert_eq!(
            slot.lock().unwrap().as_ref().unwrap().code.as_deref(),
            Some("real-code")
        );
    }

    #[test]
    fn oauth_redemption_does_not_lock_the_ui_repeat_the_code_or_apply_a_cancelled_login() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let pending = pending(Some(CallbackResult {
            code: Some("test-code".into()),
            state: Some("expected-state".into()),
            error: None,
        }));
        let shared = Arc::new(Mutex::new(Runtime {
            server,
            secrets: SecretFile {
                identity: Identity::generate(),
                session: None,
                awaiting_shared_key: false,
                key_account_id: None,
            },
            pending_login: Some(pending),
        }));
        let (received_tx, received_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let fake_server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = [0; 8192];
            let read = stream.read(&mut buffer).unwrap();
            assert!(
                String::from_utf8_lossy(&buffer[..read])
                    .starts_with("POST /api/v2/session/oauth/complete ")
            );
            received_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let body = json!({ "session": { "accountId": "test-account", "accessToken": "test-access", "refreshToken": "test-refresh", "expiresAt": now_ms() + 60000 }, "profile": {} }).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        });
        let in_flight = shared.clone();
        let redeeming = thread::spawn(move || poll_login_runtime(&in_flight));
        received_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            shared.try_lock().is_ok(),
            "UI state remains available while OAuth is pending"
        );
        assert_eq!(poll_login_runtime(&shared).unwrap()["status"], "pending");
        finish_pending_login(&shared, "a-previous-login").unwrap();
        assert!(shared.lock().unwrap().pending_login.is_some());
        finish_pending_login(&shared, "expected-state").unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(redeeming.join().unwrap().unwrap_err(), "登录已取消");
        fake_server.join().unwrap();
        assert!(shared.lock().unwrap().secrets.session.is_none());
    }
}

fn begin_login_runtime(shared: &Mutex<Runtime>) -> Result<Value, String> {
    let server = lock_runtime(shared)?.server.clone();
    let mut verifier_bytes = [0u8; 48];
    OsRng.fill_bytes(&mut verifier_bytes);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("无法建立本机登录回调：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let response = request(
        "POST",
        &format!("{server}/api/v2/session/oauth/authorization"),
        None,
        Some(json!({ "codeChallenge": challenge, "redirectUri": redirect_uri })),
    )?;
    let authorization_url = field(&response, "authorizationUrl")?;
    let bridge_state = field(&response, "state")?;
    let callback = Arc::new(Mutex::new(None));
    let cancelled = Arc::new(AtomicBool::new(false));
    listen_for_callback(
        listener,
        callback.clone(),
        bridge_state.clone(),
        cancelled.clone(),
    );
    let pending = PendingLogin {
        verifier,
        state: bridge_state,
        callback,
        expires_at: Instant::now() + Duration::from_secs(300),
        cancelled,
    };
    {
        let mut runtime = lock_runtime(shared)?;
        if let Some(previous) = runtime.pending_login.take() {
            previous.cancelled.store(true, Ordering::Relaxed);
        }
        runtime.pending_login = Some(pending.clone());
    }
    if let Err(error) = open::that(&authorization_url) {
        finish_pending_login(shared, &pending.state)?;
        return Err(format!("无法打开浏览器：{error}"));
    }
    Ok(json!({ "status": "browser_opened", "authorizationUrl": authorization_url }))
}

fn login_callback(request_line: &str, expected_state: &str) -> Option<CallbackResult> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let parsed = Url::parse(&format!("http://127.0.0.1{}", parts.next()?)).ok()?;
    if parsed.path() != "/callback" {
        return None;
    }
    let get = |name: &str| {
        parsed
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let callback = CallbackResult {
        code: get("code"),
        state: get("state"),
        error: get("error"),
    };
    if callback.state.as_deref() != Some(expected_state)
        || (callback.code.as_deref().unwrap_or("").is_empty() && callback.error.is_none())
    {
        return None;
    }
    Some(callback)
}

fn listen_for_callback(
    listener: TcpListener,
    result: Arc<Mutex<Option<CallbackResult>>>,
    expected_state: String,
    cancelled: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        let deadline = Instant::now() + Duration::from_secs(300);
        while Instant::now() < deadline && !cancelled.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let mut buffer = [0u8; 8192];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let request_line = String::from_utf8_lossy(&buffer[..read])
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    let Some(callback) = login_callback(&request_line, &expected_state) else {
                        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        continue;
                    };
                    if cancelled.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut slot) = result.lock() {
                        *slot = Some(callback);
                    }
                    let html = "<!doctype html><meta charset=utf-8><title>khLink</title><style>body{font-family:system-ui;margin:80px;text-align:center;color:#18201d}h1{font-size:28px}</style><h1>授权已收到</h1><p>请返回 khLink 查看登录结果，可以关闭此页面。</p>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        html.len(),
                        html
                    );
                    let _ = stream.write_all(response.as_bytes());
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100))
                }
                Err(_) => return,
            }
        }
    });
}

#[tauri::command]
async fn poll_login(state: State<'_, AppState>) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || poll_login_runtime(&shared)).await
}

fn finish_pending_login(shared: &Mutex<Runtime>, expected_state: &str) -> Result<(), String> {
    let mut runtime = lock_runtime(shared)?;
    if runtime
        .pending_login
        .as_ref()
        .is_some_and(|current| current.state == expected_state)
    {
        if let Some(pending) = runtime.pending_login.take() {
            pending.cancelled.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[tauri::command]
fn cancel_login(state: State<AppState>) -> Result<(), String> {
    let mut runtime = lock_runtime(&state.0)?;
    if let Some(pending) = runtime.pending_login.take() {
        pending.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn poll_login_runtime(shared: &Mutex<Runtime>) -> Result<Value, String> {
    let pending = {
        let runtime = lock_runtime(shared)?;
        runtime
            .pending_login
            .clone()
            .ok_or_else(|| "没有等待中的登录".to_string())?
    };
    if Instant::now() >= pending.expires_at {
        finish_pending_login(shared, &pending.state)?;
        return Err("授权已超时，请重新点击登录".into());
    }
    let callback = pending
        .callback
        .lock()
        .map_err(|_| "回调状态失效".to_string())?
        .take();
    let Some(callback) = callback else {
        return Ok(json!({ "status": "pending" }));
    };
    let completed = complete_login_runtime(shared, &pending, callback);
    if completed.is_err() {
        finish_pending_login(shared, &pending.state)?;
    }
    completed
}

fn complete_login_runtime(
    shared: &Mutex<Runtime>,
    pending: &PendingLogin,
    callback: CallbackResult,
) -> Result<Value, String> {
    if let Some(error) = callback.error {
        return Err(format!("授权被拒绝：{error}"));
    }
    if callback.state.as_deref() != Some(&pending.state) {
        return Err("登录 state 校验失败".into());
    }
    let code = callback
        .code
        .ok_or_else(|| "登录回调缺少授权码".to_string())?;
    let (server, identity) = {
        let runtime = lock_runtime(shared)?;
        (runtime.server.clone(), runtime.secrets.identity.clone())
    };
    let public_key = identity.public_key()?;
    let device_name = hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let response = request(
        "POST",
        &format!("{server}/api/v2/session/oauth/complete"),
        None,
        Some(json!({
            "state": pending.state, "code": code, "codeVerifier": pending.verifier,
            "deviceId": identity.device_id, "deviceName": device_name, "publicKey": public_key,
        })),
    )?;
    let session_value = response
        .get("session")
        .ok_or_else(|| "登录响应缺少会话".to_string())?;
    let session = Session {
        account_id: field(session_value, "accountId")?,
        access_token: field(session_value, "accessToken")?,
        refresh_token: field(session_value, "refreshToken")?,
        expires_at: session_value
            .get("expiresAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| "登录响应缺少 expiresAt".to_string())?,
        profile: response.get("profile").cloned().unwrap_or(Value::Null),
    };
    {
        let mut runtime = lock_runtime(shared)?;
        if pending.cancelled.load(Ordering::Relaxed)
            || !runtime
                .pending_login
                .as_ref()
                .is_some_and(|current| current.state == pending.state)
        {
            return Err("登录已取消".into());
        }
        if runtime.secrets.key_account_id.as_deref().is_some_and(|id| id != session.account_id) {
            let mut account_key = [0u8; 32];
            OsRng.fill_bytes(&mut account_key);
            runtime.secrets.identity.account_key = B64.encode(account_key);
        }
        runtime.secrets.key_account_id = Some(session.account_id.clone());
        runtime.secrets.session = Some(session);
        runtime.secrets.awaiting_shared_key =
            response.get("keyPending").and_then(Value::as_bool) == Some(true);
        runtime.pending_login = None;
        save_runtime(&runtime)?;
    }
    if !adopt_shared_key(shared, Duration::from_secs(90))? {
        return Ok(json!({ "status": "complete", "keyPending": true, "connectorError": SHARED_KEY_WAITING }));
    }
    let connector = provision_connector_runtime(shared).and_then(|value| {
        activate_account_connector()?;
        Ok(value)
    });
    Ok(match connector {
        Ok(value) => json!({ "status": "complete", "connector": value }),
        Err(error) => json!({ "status": "complete", "connectorError": error }),
    })
}

#[tauri::command]
async fn ensure_connector(state: State<'_, AppState>) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || {
        if !adopt_shared_key(&shared, Duration::from_secs(10))? {
            return Ok(json!({ "configured": false, "keyPending": true, "message": SHARED_KEY_WAITING }));
        }
        let matches = {
            let runtime = lock_runtime(&shared)?;
            connector_config_matches(&runtime)
        } && connector_status()["lifecycle"] != "login_required";
        let provisioned = if matches {
            json!({ "configured": true, "unchanged": true })
        } else {
            provision_connector_runtime(&shared)?
        };
        activate_account_connector()?;
        Ok(provisioned)
    })
    .await
}

#[tauri::command]
async fn account(state: State<'_, AppState>) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || {
        let (server, token) = request_context(&shared)?;
        let result = request(
            "GET",
            &format!("{server}/api/v2/account"),
            Some(&token),
            None,
        );
        if result.as_ref().is_err_and(|error| error.contains("(401)")) {
            let mut runtime = lock_runtime(&shared)?;
            if runtime
                .secrets
                .session
                .as_ref()
                .is_some_and(|session| session.access_token == token)
            {
                runtime.secrets.session = None;
                save_runtime(&runtime)?;
            }
        }
        result
    })
    .await
}

#[tauri::command]
async fn create_pairing(state: State<'_, AppState>) -> Result<PairingView, String> {
    let shared = state.0.clone();
    run_blocking(move || {
        let (server, token) = request_context(&shared)?;
        let response = request(
            "POST",
            &format!("{server}/api/v2/pairing"),
            Some(&token),
            Some(json!({})),
        )?;
        let id = field(&response, "id")?;
        let secret = field(&response, "secret")?;
        let expires_at = response
            .get("expiresAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| "配对响应缺少 expiresAt".to_string())?;
        let payload = format!(
            "khlink://pair?v=2&server={}&id={}&secret={}&expiresAt={}",
            url::form_urlencoded::byte_serialize(server.as_bytes()).collect::<String>(),
            id,
            secret,
            expires_at
        );
        let code =
            QrCode::new(payload.as_bytes()).map_err(|error| format!("二维码生成失败：{error}"))?;
        let qr_svg = code
            .render::<svg::Color>()
            .min_dimensions(256, 256)
            .dark_color(svg::Color("#16201c"))
            .light_color(svg::Color("#ffffff"))
            .build();
        Ok(PairingView {
            id,
            secret,
            expires_at,
            payload,
            qr_svg,
        })
    })
    .await
}

fn direct_request(method: &str, route: &str, body: Option<Value>) -> Result<Value, String> {
    let directory = connector_config_path()?
        .parent()
        .ok_or("连接器目录无效")?
        .to_path_buf();
    let control: Value = serde_json::from_str(
        &fs::read_to_string(directory.join("direct-control.json"))
            .map_err(|_| "请启动支持二维码直连的新版本连接器".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let port = control
        .get("port")
        .and_then(Value::as_u64)
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("本机控制端口无效")?;
    let token = String::from_utf8(unprotect(
        &B64.decode(field(&control, "protected")?)
            .map_err(|e| e.to_string())?,
    )?)
    .map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(if method == "GET" { 3 } else { 50 }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
            format!("http://127.0.0.1:{port}{route}"),
        )
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .map_err(|e| format!("本机直连控制暂不可用：{e}"))?;
    let success = response.status().is_success();
    let value: Value = response.json().map_err(|e| e.to_string())?;
    if !success {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("直连操作失败")
            .to_string());
    }
    Ok(value)
}

fn activate_account_connector() -> Result<(), String> {
    start_connector_task()?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while !connector_is_running() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(200));
    }
    direct_request("POST", "/server", Some(json!({})))?;
    Ok(())
}

#[tauri::command]
async fn direct_begin(state: State<'_, AppState>, stun: bool) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || {
        let config_path = connector_config_path()?;
        if !config_path.exists() {
            let runtime = lock_runtime(&shared)?;
            let identity = &runtime.secrets.identity;
            let protected = B64.encode(protect(&serde_json::to_vec(&json!({ "accountKey": identity.account_key, "refreshToken": null })).map_err(|e| e.to_string())?)?);
            fs::create_dir_all(config_path.parent().ok_or("连接器目录无效")?).map_err(|e| e.to_string())?;
            fs::write(&config_path, serde_json::to_vec_pretty(&json!({ "protocolVersion": 2, "directOnly": true,
                "serverUrl": DEFAULT_SERVER, "accountId": format!("direct:{}", identity.device_id), "deviceId": identity.device_id,
                "deviceName": hostname::get().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|_| "电脑".to_string()),
                "workspace": std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string()), "protected": protected })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        start_connector_task()?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !connector_is_running() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(200)); }
        with_direct_qr(direct_request("POST", "/offer", Some(json!({ "stun": stun })))?)
    }).await
}

#[tauri::command]
async fn direct_status(qr: Option<bool>) -> Result<Value, String> {
    run_blocking(move || {
        let value = direct_request("GET", "/status", None)?;
        if qr == Some(true) && value.get("payload").and_then(Value::as_str).is_some() {
            with_direct_qr(value)
        } else {
            Ok(value)
        }
    })
    .await
}

fn with_direct_qr(mut value: Value) -> Result<Value, String> {
    let payload = field(&value, "payload")?;
    let code = qrcode::QrCode::with_error_correction_level(payload.as_bytes(), qrcode::EcLevel::L)
        .map_err(|e| format!("二维码生成失败：{e}"))?;
    value["qrSvg"] = Value::String(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(512, 512)
            .build(),
    );
    Ok(value)
}
#[tauri::command]
async fn direct_answer(payload: String) -> Result<Value, String> {
    run_blocking(move || direct_request("POST", "/answer", Some(json!({ "payload": payload }))))
        .await
}
#[tauri::command]
async fn direct_cancel() -> Result<Value, String> {
    run_blocking(|| direct_request("POST", "/cancel", Some(json!({})))).await
}
#[tauri::command]
async fn direct_server() -> Result<Value, String> {
    run_blocking(|| direct_request("POST", "/server", Some(json!({})))).await
}

#[tauri::command]
async fn pairing_status(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || {
        let (server, token) = request_context(&shared)?;
        request(
            "GET",
            &format!("{server}/api/v2/pairing/{id}"),
            Some(&token),
            None,
        )
    })
    .await
}

fn pairing_envelope(
    identity: &Identity,
    pairing_id: &str,
    device_id: &str,
    phone_public_key: &str,
) -> Result<String, String> {
    let private = StaticSecret::from(decode_32(&identity.private_key)?);
    let phone_public = PublicKey::from(decode_32(phone_public_key)?);
    let shared = private.diffie_hellman(&phone_public);
    let mut hasher = Sha256::new();
    hasher.update(b"KH Link pairing v2");
    hasher.update(shared.as_bytes());
    hasher.update(pairing_id.as_bytes());
    let key_bytes = hasher.finalize();
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key_bytes));
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let aad = format!("kh-link-pairing-v2|{pairing_id}|{device_id}");
    let account_key = B64
        .decode(&identity.account_key)
        .map_err(|_| "账户主密钥无效".to_string())?;
    let encrypted = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &account_key,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "账户主密钥包装失败".to_string())?;
    Ok(json!({
        "version": 2,
        "algorithm": "X25519-XChaCha20-Poly1305",
        "desktopPublicKey": identity.public_key()?,
        "nonce": B64.encode(nonce),
        "ciphertext": B64.encode(encrypted),
    })
    .to_string())
}

#[tauri::command]
async fn confirm_pairing(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || {
        let (server, token) = request_context(&shared)?;
        let identity = {
            let runtime = lock_runtime(&shared)?;
            runtime.secrets.identity.clone()
        };
        let status = request(
            "GET",
            &format!("{server}/api/v2/pairing/{id}"),
            Some(&token),
            None,
        )?;
        if status.get("status").and_then(Value::as_str) != Some("pending") {
            return Err("手机尚未提交配对申请".into());
        }
        let device_id = field(&status, "deviceId")?;
        let public_key = field(&status, "publicKey")?;
        let envelope = pairing_envelope(&identity, &id, &device_id, &public_key)?;
        request(
            "POST",
            &format!("{server}/api/v2/pairing/{id}/confirm"),
            Some(&token),
            Some(json!({ "keyEnvelope": envelope })),
        )
    })
    .await
}

#[tauri::command]
async fn revoke_device(state: State<'_, AppState>, device_id: String) -> Result<Value, String> {
    let shared = state.0.clone();
    run_blocking(move || {
        let (server, token) = request_context(&shared)?;
        request(
            "POST",
            &format!("{server}/api/v2/devices/revoke"),
            Some(&token),
            Some(json!({ "deviceId": device_id })),
        )
    })
    .await
}

#[tauri::command]
fn logout(state: State<AppState>) -> Result<(), String> {
    let mut runtime = lock_runtime(&state.0)?;
    runtime.secrets.session = None;
    if let Some(pending) = runtime.pending_login.take() {
        pending.cancelled.store(true, Ordering::Relaxed);
    }
    save_runtime(&runtime)
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(RUN_KEY)
        .map_err(|error| format!("无法修改开机启动：{error}"))?;
    if enabled {
        let path = std::env::current_exe().map_err(|error| error.to_string())?;
        key.set_value(RUN_VALUE, &format!("\"{}\" --background", path.display()))
            .map_err(|error| error.to_string())?;
    } else {
        let _ = key.delete_value(RUN_VALUE);
    }
    Ok(autostart_enabled())
}

#[tauri::command]
async fn connector_update_check() -> Result<Value, String> {
    run_blocking(connector_update::check).await
}

#[tauri::command]
async fn connector_update_apply() -> Result<Value, String> {
    // One update at a time; a second click waits for the first result.
    static APPLYING: Mutex<()> = Mutex::new(());
    run_blocking(|| {
        let _guard = APPLYING.lock().map_err(|_| "更新状态异常".to_string())?;
        connector_update::apply()
    })
    .await
}

#[tauri::command]
async fn desktop_update_download() -> Result<Value, String> {
    static DOWNLOADING: Mutex<()> = Mutex::new(());
    run_blocking(|| {
        let _guard = DOWNLOADING.lock().map_err(|_| "下载状态异常".to_string())?;
        connector_update::download_desktop()
    }).await
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "链接无效".to_string())?;
    let allowed = matches!(
        parsed.host_str(),
        Some("khsci.com") | Some("www.khsci.com") | Some("khsci.vip") | Some("www.khsci.vip")
    );
    if parsed.scheme() != "https" || !allowed {
        return Err("只允许打开 KH 官方 HTTPS 链接".into());
    }
    open::that(url).map_err(|error| error.to_string())
}

pub fn run() {
    if claude_profiles::headless() {
        return;
    }
    tauri::Builder::default()
        .manage(AppState(Arc::new(Mutex::new(load_runtime()))))
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            get_state,
            claude_profiles::claude_profiles,
            claude_profiles::claude_switch,
            claude_profiles::claude_rename,
            claude_profiles::claude_profile_manage,
            claude_profiles::claude_profile_create,
            claude_profiles::claude_profile_onboard,
            codex_profiles::codex_profiles,
            codex_profiles::codex_profile_create,
            codex_profiles::codex_profile_rename,
            codex_profiles::codex_profile_open,
            codex_profiles::codex_profile_manage,
            diagnostics,
            clear_diagnostics,
            usage,
            begin_login,
            poll_login,
            cancel_login,
            account,
            create_pairing,
            direct_begin,
            direct_status,
            direct_answer,
            direct_cancel,
            direct_server,
            pairing_status,
            confirm_pairing,
            revoke_device,
            logout,
            ensure_connector,
            connector_update_check,
            connector_update_apply,
            desktop_update_download,
            set_autostart,
            open_external,
        ])
        .setup(|app| {
            let background = std::env::args().any(|argument| argument == "--background");
            let show = MenuItem::with_id(app, "show", "打开 khLink", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
            let base_icon = app.default_window_icon().map(|icon| {
                tauri::image::Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height())
            });
            let mut builder = TrayIconBuilder::with_id("main");
            if let Some(icon) = base_icon.clone() {
                builder = builder.icon(icon);
            }
            let tray = builder
                .tooltip("khLink")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            // A session waiting for the user (permission / question) marks the
            // tray icon with a dot and says how many in the tooltip.
            if let Some(base) = base_icon {
                let badged = badged_icon(&base);
                std::thread::spawn(move || {
                    let mut shown = usize::MAX;
                    loop {
                        let waiting = waiting_sessions(&connector_status());
                        if waiting != shown {
                            shown = waiting;
                            let _ = tray.set_icon(Some(if waiting > 0 {
                                badged.clone()
                            } else {
                                base.clone()
                            }));
                            let tip = if waiting > 0 {
                                format!("khLink · {waiting} 个会话等你处理")
                            } else {
                                "khLink".to_string()
                            };
                            let _ = tray.set_tooltip(Some(tip));
                        }
                        std::thread::sleep(std::time::Duration::from_secs(5));
                    }
                });
            }
            if let Some(window) = app.get_webview_window("main") {
                if !background {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("khLink 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    // 115 is only reachable through a VPN from China; the relay moved to khsci.vip.
    #[test]
    fn a_saved_115_relay_address_is_read_as_khsci_vip() {
        assert_eq!(DEFAULT_SERVER, "https://khsci.vip/fengzhu-bridge");
        assert_eq!(current_server("https://45.59.131.115/fengzhu-bridge/".into()), DEFAULT_SERVER);
        assert_eq!(current_server("https://khsci.vip/fengzhu-bridge".into()), DEFAULT_SERVER);
        assert_eq!(current_server("https://example.test/relay".into()), "https://example.test/relay");
    }

    // Wrapped by the connector's device-key.js (wrapAccountKey) for device
    // "pc-b" of account "acct-1": a joining computer must open it unchanged.
    #[test]
    fn opens_the_connectors_device_key_envelope() {
        let identity = Identity {
            device_id: "pc-b".into(),
            private_key: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=".into(),
            account_key: B64.encode([1u8; 32]),
        };
        assert_eq!(identity.public_key().unwrap(), "V9tLNZ8jrl4Ubk4lEgVnBHIlBjSMFQwUdT0Mkz0E1CE=");
        let envelope = json!({
            "version": 3, "algorithm": "X25519-XChaCha20-Poly1305",
            "senderPublicKey": "H8vL5kcCbiSVGPW72OHG7MzxFfanfIihZuDPwEZEA0o=",
            "nonce": "Za8Aef7ySfl8gtdnpdkQmqIQQbrjeOgN",
            "ciphertext": "mIqvtMg0xSqSjkbKkefEUX9vxU16zjCeUV9XHwNcTh9iqQraO1iM6VUwoa69OrhP",
        });
        assert_eq!(
            open_device_key_envelope(&identity, "acct-1", &envelope).unwrap(),
            "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo="
        );
        // Bound to the account and the device: another account cannot open it.
        assert!(open_device_key_envelope(&identity, "acct-2", &envelope).is_err());
        let other = Identity { device_id: "pc-c".into(), ..identity };
        assert!(open_device_key_envelope(&other, "acct-1", &envelope).is_err());
    }

    #[test]
    fn tray_counts_waiting_sessions_from_a_fresh_status_only() {
        let fresh = json!({ "updatedAt": now_ms(), "activeThreads": [
            { "threadId": "a", "status": "desktop_waiting" },
            { "threadId": "b", "status": "desktop_running" },
            { "threadId": "c", "status": "waitingOnApproval" },
        ]});
        assert_eq!(waiting_sessions(&fresh), 2);
        let stale = json!({ "updatedAt": now_ms() - 60_000, "activeThreads": [{ "status": "desktop_waiting" }] });
        assert_eq!(waiting_sessions(&stale), 0);
        assert_eq!(waiting_sessions(&json!({ "online": false })), 0);
    }

    #[test]
    fn tray_badge_is_drawn_in_the_lower_right_corner_only() {
        let base = tauri::image::Image::new_owned(vec![0u8; 32 * 32 * 4], 32, 32);
        let badged = badged_icon(&base);
        let pixel = |x: u32, y: u32| {
            let i = ((y * 32 + x) * 4) as usize;
            badged.rgba()[i..i + 4].to_vec()
        };
        assert_eq!(pixel(0, 0), vec![0, 0, 0, 0], "top left untouched");
        assert_eq!(
            pixel(24, 24),
            vec![0xF5, 0x9E, 0x0B, 0xFF],
            "orange dot centre"
        );
    }

    #[test]
    fn pairing_envelope_contains_no_plain_account_key() {
        let desktop = Identity::generate();
        let phone = StaticSecret::random_from_rng(OsRng);
        let pairing_id = "pair-1";
        let device_id = "phone-1";
        let envelope = pairing_envelope(
            &desktop,
            pairing_id,
            device_id,
            &B64.encode(PublicKey::from(&phone).as_bytes()),
        )
        .unwrap();
        assert!(!envelope.contains(&desktop.account_key));
        assert!(envelope.contains("X25519-XChaCha20-Poly1305"));

        let value: Value = serde_json::from_str(&envelope).unwrap();
        let desktop_public =
            PublicKey::from(decode_32(value["desktopPublicKey"].as_str().unwrap()).unwrap());
        let shared = phone.diffie_hellman(&desktop_public);
        let mut hasher = Sha256::new();
        hasher.update(b"KH Link pairing v2");
        hasher.update(shared.as_bytes());
        hasher.update(pairing_id.as_bytes());
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&hasher.finalize()));
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&B64.decode(value["nonce"].as_str().unwrap()).unwrap()),
                Payload {
                    msg: &B64.decode(value["ciphertext"].as_str().unwrap()).unwrap(),
                    aad: format!("kh-link-pairing-v2|{pairing_id}|{device_id}").as_bytes(),
                },
            )
            .unwrap();
        assert_eq!(plaintext, B64.decode(&desktop.account_key).unwrap());
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    #[test]
    fn the_last_token_count_record_wins() {
        let text = concat!(
            r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":10}}}}"#,
            "\n",
            r#"{"payload":{"type":"agent_message","text":"token_count mentioned"}}"#,
            "\n",
            r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":25}}}}"#,
            "\n",
            r#"{"payload":{"type":"token_count","info":null}}"#,
            "\n",
            r#"{"payload":{"type":"token_cou"#,
        );
        assert_eq!(
            latest_token_usage(text).and_then(|u| u.get("total_tokens").and_then(Value::as_u64)),
            Some(25)
        );
    }

    #[test]
    fn an_unchanged_file_is_not_read_again() {
        let dir = std::env::temp_dir().join(format!("khlink-usage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("2026")).unwrap();
        let file = dir.join("2026").join("a.jsonl");
        fs::write(&file, concat!(r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":7,"input_tokens":5}}}}"#, "\n")).unwrap();
        let mut cache = UsageCache::new();
        let mut totals = UsageTotals::default();
        scan_usage_dir(&dir, &mut totals, &mut cache, &mut HashSet::new());
        assert_eq!((totals.sessions, totals.total, totals.input), (1, 7, 5));
        // Poison the cached entry: an unchanged file must come from the cache.
        let key = cache.keys().next().unwrap().clone();
        cache.get_mut(&key).unwrap().2 = Some(json!({ "total_tokens": 99 }));
        let mut again = UsageTotals::default();
        scan_usage_dir(&dir, &mut again, &mut cache, &mut HashSet::new());
        assert_eq!(again.total, 99);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod usage_bench {
    use super::*;

    /// Real data timing: `cargo test --release usage_bench -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_sessions_cold_then_cached() {
        let started = Instant::now();
        let first = codex_usage();
        let cold = started.elapsed();
        let started = Instant::now();
        let second = codex_usage();
        let warm = started.elapsed();
        println!(
            "sessions {} total {} | cold {:?} | cached {:?}",
            first["sessionCount"], first["totalTokens"], cold, warm
        );
        assert_eq!(first["totalTokens"], second["totalTokens"]);
    }
}
