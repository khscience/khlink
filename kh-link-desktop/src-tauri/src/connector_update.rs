//! Connector update channel for the combined installer.
//!
//! The combined package ships a snapshot of the connector next to the desktop
//! console (`<install dir>\connector`). Connector releases are published on
//! their own (`windowsConnector` in the signed update manifest), so the console
//! fetches the manifest, verifies its Ed25519 signature and the package SHA-256,
//! and swaps only the connector code. `node.exe`, `node_modules` and the task
//! script stay; a release whose dependencies differ needs a new installer.
//! If the new connector does not report its version within a minute, the
//! previous code is restored and started again.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{DEFAULT_SERVER, connector_status, now_ms, wininet_proxy_url};

/// `releases/update-signing-public.pem` (SPKI DER, the key is the last 32 bytes).
const UPDATE_PUBLIC_KEY: &str = "MCowBQYDK2VwAyEAooVsYkdIQc9U6n0kBXlFxxMUaFnrb1VbVs5zeHf6Lr0=";
const NO_WINDOW: u32 = 0x08000000;

fn downloads_base() -> String {
    format!("{DEFAULT_SERVER}/downloads")
}

/// The signed manifest and packages are also published as GitHub Releases.
/// It is tried first; the relay's downloads are the fallback.
const UPDATE_MIRROR: &str = "https://github.com/khscience/khlink-releases/releases/latest/download";
const UPDATE_CDN_MIRROR: &str = "https://gcore.jsdelivr.net/gh/khscience/khlink-releases@dist";

/// GitHub can be slow or blocked: it gets short timeouts so the relay takes over quickly.
fn is_mirror(url: &str) -> bool {
    let host = url.strip_prefix("https://").unwrap_or("").split('/').next().unwrap_or("").to_ascii_lowercase();
    host == "github.com" || host.ends_with(".github.com") || host.ends_with(".githubusercontent.com")
        || host == "jsdelivr.net" || host.ends_with(".jsdelivr.net")
}

/// A manifest entry's download sources in order: `urls` (GitHub first, the
/// relay second) in newer manifests, the single `url` always kept as fallback.
fn download_urls(entry: &Value) -> Vec<String> {
    let mut urls: Vec<String> = entry
        .get("urls")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    urls.push(text(entry, "url"));
    let mut seen = Vec::new();
    for url in urls.into_iter().map(|url| url.trim().to_string()) {
        if url.starts_with("https://") && !seen.contains(&url) {
            seen.push(url);
        }
    }
    seen
}

/// Of the manifests that verified, the newest (a mirror that lags behind loses).
fn newest_manifest(manifests: Vec<Value>) -> Option<Value> {
    let key = |m: &Value| (text(&m["windowsDesktop"], "version"), text(&m["windowsConnector"], "version"));
    manifests.into_iter().reduce(|best, next| {
        let (best_desktop, best_connector) = key(&best);
        let (next_desktop, next_connector) = key(&next);
        let better = newer(&next_desktop, &best_desktop)
            || (next_desktop == best_desktop && newer(&next_connector, &best_connector));
        if better { next } else { best }
    })
}

/// The bundled connector, when this console was installed by the combined
/// package. A source checkout or the separate connector install is not ours.
pub fn bundled_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("connector");
    let complete = ["node.exe", "src\\cli.js", "package.json", "connector-task.ps1"]
        .iter()
        .all(|name| dir.join(name).is_file());
    complete.then_some(dir)
}

/// The scheduled task must start this copy; a developer machine may keep the
/// task on a source checkout while the console is installed.
fn task_runs(dir: &Path) -> bool {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ScheduledTask -TaskName FengzhuAgentBridge -ErrorAction Stop).Actions | ForEach-Object { $_.Arguments }",
    ]);
    #[cfg(windows)]
    command.creation_flags(NO_WINDOW);
    let Ok(output) = command.output() else {
        return false;
    };
    let cli = dir.join("src").join("cli.js").to_string_lossy().to_lowercase();
    String::from_utf8_lossy(&output.stdout)
        .to_lowercase()
        .contains(&cli)
}

fn client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    client_with(Duration::from_secs(10), timeout)
}

fn client_with(connect: Duration, timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(connect)
        .timeout(timeout);
    if let Some(proxy) = wininet_proxy_url() {
        builder = builder
            .proxy(reqwest::Proxy::all(proxy).map_err(|error| format!("代理配置无效：{error}"))?);
    }
    builder.build().map_err(|error| error.to_string())
}

fn fetch(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("无法连接更新服务：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("更新服务返回 {}", response.status().as_u16()));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("下载中断：{error}"))
}

/// Production serves the detached signature as raw 64 bytes; mirrors may serve
/// Base64 text. Accept both, like the Android updater.
pub fn verify_manifest(manifest: &[u8], signature: &[u8]) -> Result<Value, String> {
    let raw = if signature.len() == 64 {
        signature.to_vec()
    } else {
        B64.decode(String::from_utf8_lossy(signature).trim())
            .map_err(|_| "更新签名格式无效".to_string())?
    };
    let signature = Signature::from_slice(&raw).map_err(|_| "更新签名格式无效".to_string())?;
    let spki = B64.decode(UPDATE_PUBLIC_KEY).map_err(|error| error.to_string())?;
    let key: [u8; 32] = spki[spki.len() - 32..].try_into().map_err(|_| "公钥无效")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|error| error.to_string())?;
    key.verify(manifest, &signature)
        .map_err(|_| "更新清单签名验证失败".to_string())?;
    serde_json::from_slice(manifest).map_err(|error| format!("更新清单无法解析：{error}"))
}

fn fetch_manifest_from(base: &str) -> Result<Value, String> {
    let client = if is_mirror(base) {
        client_with(Duration::from_secs(6), Duration::from_secs(15))?
    } else {
        client(Duration::from_secs(20))?
    };
    let manifest = fetch(&client, &format!("{base}/update-manifest.json"))?;
    let signature = fetch(&client, &format!("{base}/update-manifest.sig"))?;
    verify_manifest(&manifest, &signature)
}

/// Compare verified manifests, including the relay, so CDN cache lag cannot
/// make a newly released version appear up to date. The bool is specifically
/// GitHub availability: the desktop installer exceeds jsDelivr's file limit.
fn fetch_manifest() -> Result<(Value, bool), String> {
    let relay = downloads_base();
    let (mirror, cdn, own) = std::thread::scope(|scope| {
        let mirror = scope.spawn(|| fetch_manifest_from(UPDATE_MIRROR));
        let cdn = scope.spawn(|| fetch_manifest_from(UPDATE_CDN_MIRROR));
        let own = fetch_manifest_from(&relay);
        (mirror.join().unwrap_or_else(|_| Err("更新检查中断".into())),
         cdn.join().unwrap_or_else(|_| Err("更新检查中断".into())), own)
    });
    let mirror_ok = mirror.is_ok();
    let error = own.as_ref().err().cloned();
    newest_manifest([mirror, cdn, own].into_iter().filter_map(Result::ok).collect())
        .map(|manifest| (manifest, mirror_ok))
        .ok_or_else(|| error.unwrap_or_else(|| "更新清单读取失败".into()))
}

/// Downloads from each source in turn until one gives the expected bytes.
fn fetch_verified_with<F>(urls: &[String], sha256: &str, what: &str, mut download: F) -> Result<Vec<u8>, String>
where F: FnMut(&str) -> Result<Vec<u8>, String> {
    let mut last = format!("{what}没有下载地址");
    for url in urls {
        match download(url) {
            Ok(bytes) if hex(&Sha256::digest(&bytes)).eq_ignore_ascii_case(sha256) => return Ok(bytes),
            Ok(_) => last = format!("{what}校验失败，已丢弃"),
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn fetch_verified(urls: &[String], sha256: &str, what: &str) -> Result<Vec<u8>, String> {
    fetch_verified_with(urls, sha256, what, |url| {
        let client = if is_mirror(url) {
            client_with(Duration::from_secs(6), Duration::from_secs(300))?
        } else {
            client(Duration::from_secs(300))?
        };
        fetch(&client, url)
    })
}

fn desktop_installer_name(version: &str) -> Result<String, String> {
    if version.is_empty() || version.len() > 40 || version.split('.').any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit())) {
        return Err("桌面安装包版本无效".into());
    }
    Ok(format!("khLink-Setup-{version}.exe"))
}

fn save_desktop_installer(dir: &Path, version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let name = desktop_installer_name(version)?;
    for index in 0..100 {
        let candidate = if index == 0 { dir.join(&name) }
            else { dir.join(format!("khLink-Setup-{version}-{index}.exe")) };
        match fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file); let _ = fs::remove_file(&candidate);
                    return Err(format!("保存安装包失败：{error}"));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法保存安装包：{error}")),
        }
    }
    Err("下载文件夹中已有太多同名安装包，请先整理后重试".into())
}

/// Download only from a verified manifest, trying the next source after a
/// timeout or hash mismatch. Never execute the downloaded installer.
pub fn download_desktop() -> Result<Value, String> {
    let (manifest, _) = fetch_manifest()?;
    let entry = &manifest["windowsDesktop"];
    let (version, urls, sha256) = (text(entry, "version"), download_urls(entry), text(entry, "sha256"));
    desktop_installer_name(&version)?;
    if urls.is_empty() || sha256.len() != 64 || !sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("更新清单里没有有效的桌面安装包信息".into());
    }
    const MAX_INSTALLER: u64 = 200 * 1024 * 1024;
    let expected = entry.get("sizeBytes").and_then(Value::as_u64);
    if expected.is_some_and(|size| size == 0 || size > MAX_INSTALLER) { return Err("桌面安装包大小无效".into()); }
    let limit = expected.unwrap_or(MAX_INSTALLER);
    let bytes = fetch_verified_with(&urls, &sha256, "桌面安装包", |url| {
        let http = if is_mirror(url) { client_with(Duration::from_secs(6), Duration::from_secs(60))? }
            else { client(Duration::from_secs(300))? };
        let response = http.get(url).send().map_err(|error| format!("无法连接更新服务：{error}"))?;
        if !response.status().is_success() { return Err(format!("更新服务返回 {}", response.status().as_u16())); }
        if response.content_length().is_some_and(|length| length > limit) { return Err("桌面安装包超出预期大小".into()); }
        let mut data = Vec::new();
        response.take(limit + 1).read_to_end(&mut data).map_err(|error| format!("下载中断：{error}"))?;
        if data.len() as u64 > limit || expected.is_some_and(|size| data.len() as u64 != size) {
            return Err("桌面安装包大小不一致".into());
        }
        Ok(data)
    })?;
    let downloads = dirs::download_dir().ok_or("无法找到系统下载文件夹")?;
    let saved = save_desktop_installer(&downloads, &version, &bytes)?;
    let _ = open::that(&downloads);
    Ok(json!({ "version": version, "fileName": saved.file_name().and_then(|name| name.to_str()).unwrap_or("khLink 安装包") }))
}

/// `0.2.92` > `0.2.9`; missing parts count as zero.
pub fn newer(candidate: &str, current: &str) -> bool {
    let parts = |text: &str| -> Vec<u64> {
        text.trim()
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    for index in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(index).copied().unwrap_or(0),
            b.get(index).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

fn read_package(dir: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(dir.join("package.json"))
        .map_err(|error| format!("读取连接器版本失败：{error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("连接器 package.json 无效：{error}"))
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub fn check() -> Result<Value, String> {
    let desktop = env!("CARGO_PKG_VERSION");
    let (manifest, mirror_ok) = fetch_manifest()?;
    // The installer opens in the browser: GitHub when it answered, else the relay.
    let desktop_urls = download_urls(&manifest["windowsDesktop"]);
    let desktop_url = if mirror_ok { desktop_urls.first() } else { desktop_urls.last() }.cloned().unwrap_or_default();
    let connector = &manifest["windowsConnector"];
    let latest_desktop = text(&manifest["windowsDesktop"], "version");
    let desktop_view = json!({
        "current": desktop,
        "latest": latest_desktop,
        "available": newer(&latest_desktop, desktop),
        "url": desktop_url,
        "notes": text(&manifest["windowsDesktop"], "notes"),
    });
    let Some(dir) = bundled_dir().filter(|dir| task_runs(dir)) else {
        return Ok(json!({ "bundled": false, "latest": text(connector, "version"), "notes": text(connector, "notes"), "desktop": desktop_view }));
    };
    let installed = text(&read_package(&dir)?, "version");
    let latest = text(connector, "version");
    Ok(json!({
        "bundled": true,
        "installed": installed,
        "latest": latest,
        "available": !latest.is_empty() && newer(&latest, &installed),
        "notes": text(connector, "notes"),
        "desktop": desktop_view,
    }))
}

fn powershell_task(dir: &Path, action: &str) -> Result<(), String> {
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(dir.join("connector-task.ps1"))
        .args(["-Action", action]);
    #[cfg(windows)]
    command.creation_flags(NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("无法运行连接器任务脚本：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "连接器任务脚本失败（{action}）：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// The connector says when a restart would cut a running phone request.
pub fn restart_blocker(status: &Value) -> Option<String> {
    let fresh = status
        .get("updatedAt")
        .and_then(Value::as_u64)
        .is_some_and(|at| now_ms().saturating_sub(at) <= 15_000);
    if !fresh {
        return None;
    }
    let in_flight = status
        .get("inFlightCommands")
        .map(|value| match value {
            Value::Array(items) => items.len(),
            Value::Number(count) => count.as_u64().unwrap_or(0) as usize,
            _ => 0,
        })
        .unwrap_or(0);
    if status.get("restartSafe") == Some(&Value::Bool(false)) || in_flight > 0 {
        Some("电脑上还有任务在运行或消息在发送，等它们结束后再更新连接器".into())
    } else {
        None
    }
}

/// Top-level entries of the new package that replace the installed ones.
/// The runtime and the installer's files are never touched.
fn replaceable(staged: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(staged).map_err(|error| error.to_string())? {
        let name = entry
            .map_err(|error| error.to_string())?
            .file_name()
            .to_string_lossy()
            .to_string();
        if !["node.exe", "node_modules", "connector-task.ps1"]
            .iter()
            .any(|kept| kept.eq_ignore_ascii_case(&name))
        {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn swap(dir: &Path, staged: &Path, previous: &Path, names: &[String]) -> Result<(), String> {
    fs::create_dir_all(previous).map_err(|error| error.to_string())?;
    let mut moved_out = Vec::new();
    let mut moved_in = Vec::new();
    let result = (|| -> Result<(), String> {
        for name in names {
            let current = dir.join(name);
            if current.exists() {
                fs::rename(&current, previous.join(name))
                    .map_err(|error| format!("{name} 正在被占用：{error}"))?;
                moved_out.push(name.clone());
            }
            fs::rename(staged.join(name), &current)
                .map_err(|error| format!("放入新的 {name} 失败：{error}"))?;
            moved_in.push(name.clone());
        }
        Ok(())
    })();
    if result.is_err() {
        for name in moved_in {
            let _ = fs::rename(dir.join(&name), staged.join(&name));
        }
        for name in moved_out {
            let _ = fs::rename(previous.join(&name), dir.join(&name));
        }
    }
    result
}

fn restore(dir: &Path, previous: &Path, names: &[String]) {
    for name in names {
        let backup = previous.join(name);
        if backup.exists() {
            let current = dir.join(name);
            if current.is_dir() {
                let _ = fs::remove_dir_all(&current);
            } else {
                let _ = fs::remove_file(&current);
            }
            let _ = fs::rename(backup, current);
        }
    }
}

fn wait_for_version(version: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let status = connector_status();
        let fresh = status
            .get("updatedAt")
            .and_then(Value::as_u64)
            .is_some_and(|at| now_ms().saturating_sub(at) <= 15_000);
        if fresh && status.get("version").and_then(Value::as_str) == Some(version) {
            return true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    false
}

fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(into);
    fs::create_dir_all(into).map_err(|error| error.to_string())?;
    let mut command = Command::new("tar.exe");
    command
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .arg("--strip-components=1");
    #[cfg(windows)]
    command.creation_flags(NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("无法解压连接器：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "解压连接器失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

pub fn apply() -> Result<Value, String> {
    let dir = bundled_dir()
        .filter(|dir| task_runs(dir))
        .ok_or("这台电脑的后台连接器不是 khLink 安装包里的这一份，不能在这里更新")?;
    let (manifest, _) = fetch_manifest()?;
    let entry = &manifest["windowsConnector"];
    let (version, urls, sha256) = (text(entry, "version"), download_urls(entry), text(entry, "sha256"));
    if version.is_empty() || urls.is_empty() || sha256.is_empty() {
        return Err("更新清单里没有连接器版本".into());
    }
    let installed_package = read_package(&dir)?;
    let installed = text(&installed_package, "version");
    if !newer(&version, &installed) {
        return Ok(json!({ "updated": false, "installed": installed }));
    }
    if let Some(reason) = restart_blocker(&connector_status()) {
        return Err(reason);
    }

    let work = dir
        .parent()
        .ok_or("安装目录无效")?
        .join("connector-update");
    fs::create_dir_all(&work).map_err(|error| error.to_string())?;
    let archive = work.join(format!("fengzhu-connect-{version}.tgz"));
    let bytes = fetch_verified(&urls, &sha256, "连接器安装包")?;
    fs::write(&archive, &bytes).map_err(|error| error.to_string())?;
    let staged = work.join(format!("staged-{version}"));
    let extracted = extract(&archive, &staged);
    let _ = fs::remove_file(&archive);
    extracted?;

    let package = read_package(&staged)?;
    if text(&package, "version") != version || !staged.join("src\\cli.js").is_file() {
        let _ = fs::remove_dir_all(&staged);
        return Err("连接器安装包内容不完整".into());
    }
    if package.get("dependencies") != installed_package.get("dependencies") {
        let _ = fs::remove_dir_all(&staged);
        return Err(format!(
            "连接器 {version} 需要新的运行库，请下载最新的 khLink 安装包"
        ));
    }

    let names = replaceable(&staged)?;
    let previous = work.join("previous");
    let _ = fs::remove_dir_all(&previous);
    powershell_task(&dir, "stop")?;
    if let Err(error) = swap(&dir, &staged, &previous, &names) {
        let _ = fs::remove_dir_all(&staged);
        let _ = powershell_task(&dir, "start");
        return Err(format!("替换连接器失败，已保持原版本：{error}"));
    }
    let _ = fs::remove_dir_all(&staged);
    if let Err(start_error) = powershell_task(&dir, "start") {
        let _ = powershell_task(&dir, "stop");
        restore(&dir, &previous, &names);
        let _ = powershell_task(&dir, "start");
        let recovered = wait_for_version(&installed, Duration::from_secs(60));
        return Err(if recovered {
            format!("连接器 {version} 启动失败，已恢复到 {installed}：{start_error}")
        } else {
            format!("连接器 {version} 启动失败，已放回 {installed}，但它也还没上线，请点“重新连接”：{start_error}")
        });
    }
    if wait_for_version(&version, Duration::from_secs(60)) {
        return Ok(json!({ "updated": true, "installed": version, "previous": installed }));
    }

    // The new code did not come up: put the old one back and start it.
    let _ = powershell_task(&dir, "stop");
    restore(&dir, &previous, &names);
    let _ = powershell_task(&dir, "start");
    let recovered = wait_for_version(&installed, Duration::from_secs(60));
    Err(if recovered {
        format!("连接器 {version} 没有正常启动，已恢复到 {installed}")
    } else {
        format!("连接器 {version} 没有正常启动，已放回 {installed}，但它也还没上线，请点“重新连接”")
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_download_retries_after_failure_or_wrong_hash() {
        let urls = vec!["first".to_string(), "second".to_string(), "fallback".to_string()];
        let good = b"verified installer";
        let sha = hex(&Sha256::digest(good));
        let mut attempts = Vec::new();
        let bytes = fetch_verified_with(&urls, &sha, "桌面安装包", |url| {
            attempts.push(url.to_string());
            match url {
                "first" => Err("timeout".into()),
                "second" => Ok(b"wrong bytes".to_vec()),
                _ => Ok(good.to_vec()),
            }
        }).unwrap();
        assert_eq!(bytes, good);
        assert_eq!(attempts, urls);
    }

    #[test]
    fn verified_download_falls_back_to_a_real_local_http_server() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for body in [None, Some(&b"local verified installer"[..])] {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                if let Some(body) = body {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                    stream.write_all(body).unwrap();
                } else {
                    stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                }
            }
        });
        let urls = vec![format!("http://127.0.0.1:{port}/unavailable"), format!("http://127.0.0.1:{port}/fallback")];
        let expected = b"local verified installer";
        let http = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
        let bytes = fetch_verified_with(&urls, &hex(&Sha256::digest(expected)), "桌面安装包", |url| fetch(&http, url)).unwrap();
        assert_eq!(bytes, expected);
        server.join().unwrap();
    }

    #[test]
    fn desktop_installer_does_not_overwrite_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("khlink-installer-test-{}-{}", std::process::id(), now_ms()));
        fs::create_dir(&dir).unwrap();
        let original = dir.join("khLink-Setup-1.2.3.exe");
        fs::write(&original, b"keep").unwrap();
        let saved = save_desktop_installer(&dir, "1.2.3", b"new").unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"keep");
        assert_eq!(fs::read(&saved).unwrap(), b"new");
        assert!(desktop_installer_name("../escape").is_err());
        fs::remove_file(saved).unwrap();
        fs::remove_file(original).unwrap();
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn downloads_try_github_first_and_always_keep_the_relay() {
        let own = "https://khsci.vip/fengzhu-bridge/downloads/fengzhu-connect-0.2.110.tgz";
        let github = "https://github.com/khscience/khlink/releases/download/v2026.10.31.2/khLink-connector-0.2.110.tgz";
        assert_eq!(download_urls(&json!({ "url": own, "urls": [github, own] })), vec![github, own]);
        assert_eq!(download_urls(&json!({ "url": own })), vec![own]);
        assert_eq!(download_urls(&json!({ "url": own, "urls": ["http://example.com/x.tgz"] })), vec![own]);
        assert!(is_mirror(github));
        assert!(is_mirror("https://objects.githubusercontent.com/github-production-release-asset/1"));
        assert!(is_mirror("https://gcore.jsdelivr.net/gh/repo/file"));
        assert!(is_mirror("https://fastly.jsdelivr.net/gh/repo/file"));
        assert!(!is_mirror(own));
        assert!(!is_mirror("https://evilgithub.com/x"));
        assert!(!is_mirror("https://eviljsdelivr.net/x"));
    }

    #[test]
    #[ignore = "network: run with --ignored on a machine that can reach the update servers"]
    fn the_live_manifest_comes_from_github_or_the_relay() {
        let started = Instant::now();
        let (manifest, mirror_ok) = fetch_manifest().expect("a verified manifest from at least one source");
        assert!(!text(&manifest["windowsDesktop"], "version").is_empty());
        eprintln!("github answered: {mirror_ok}; desktop {}; connector urls {:?}; {} ms",
            text(&manifest["windowsDesktop"], "version"), download_urls(&manifest["windowsConnector"]), started.elapsed().as_millis());
    }

    #[test]
    fn a_mirror_that_lags_behind_loses_to_the_newer_manifest() {
        let older = json!({ "windowsDesktop": { "version": "0.1.25" }, "windowsConnector": { "version": "0.2.109" } });
        let newer_connector = json!({ "windowsDesktop": { "version": "0.1.25" }, "windowsConnector": { "version": "0.2.110" } });
        let newer_desktop = json!({ "windowsDesktop": { "version": "0.1.26" }, "windowsConnector": { "version": "0.2.109" } });
        assert_eq!(newest_manifest(vec![older.clone(), newer_connector.clone()]), Some(newer_connector.clone()));
        assert_eq!(newest_manifest(vec![newer_connector.clone(), older.clone()]), Some(newer_connector));
        assert_eq!(newest_manifest(vec![newer_desktop.clone(), older]), Some(newer_desktop));
        assert_eq!(newest_manifest(vec![]), None);
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("0.2.92", "0.2.85"));
        assert!(newer("0.2.100", "0.2.99"));
        assert!(newer("0.3", "0.2.99"));
        assert!(!newer("0.2.85", "0.2.85"));
        assert!(!newer("0.2.9", "0.2.10"));
        assert!(!newer("", "0.2.1"));
    }

    #[test]
    fn the_published_manifest_signature_verifies_and_a_changed_one_does_not() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../releases");
        let manifest = fs::read(root.join("update-manifest.json")).unwrap();
        let raw = fs::read(root.join("update-manifest.sig")).unwrap();
        let text = fs::read(root.join("update-manifest.sig.b64")).unwrap();
        assert!(verify_manifest(&manifest, &raw).is_ok());
        assert!(verify_manifest(&manifest, &text).is_ok());
        let mut tampered = manifest.clone();
        tampered[10] ^= 1;
        assert!(verify_manifest(&tampered, &raw).is_err());
    }

    #[test]
    fn a_busy_connector_blocks_the_restart_and_a_stale_status_does_not() {
        let busy = json!({ "updatedAt": now_ms(), "restartSafe": false });
        assert!(restart_blocker(&busy).is_some());
        let sending = json!({ "updatedAt": now_ms(), "inFlightCommands": [{ "id": "x" }] });
        assert!(restart_blocker(&sending).is_some());
        let idle = json!({ "updatedAt": now_ms(), "restartSafe": true, "inFlightCommands": [] });
        assert!(restart_blocker(&idle).is_none());
        let stale = json!({ "updatedAt": now_ms() - 60_000, "restartSafe": false });
        assert!(restart_blocker(&stale).is_none());
    }

    #[test]
    fn the_runtime_and_installer_files_are_never_replaced() {
        let staged = std::env::temp_dir().join(format!("khlink-replaceable-{}", now_ms()));
        for name in ["src", "bin", "node_modules"] {
            fs::create_dir_all(staged.join(name)).unwrap();
        }
        for name in ["package.json", "node.exe", "connector-task.ps1"] {
            fs::write(staged.join(name), b"x").unwrap();
        }
        assert_eq!(replaceable(&staged).unwrap(), vec!["bin", "package.json", "src"]);
        let _ = fs::remove_dir_all(&staged);
    }

    #[test]
    fn a_failed_swap_puts_everything_back() {
        let base = std::env::temp_dir().join(format!("khlink-swap-{}", now_ms()));
        let (dir, staged, previous) = (base.join("connector"), base.join("staged"), base.join("previous"));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("cli.js"), b"old").unwrap();
        fs::create_dir_all(staged.join("src")).unwrap();
        fs::write(staged.join("src").join("cli.js"), b"new").unwrap();
        // "missing" is listed but not staged, so the swap fails after src moved.
        let names = vec!["src".to_string(), "zz-missing".to_string()];
        assert!(swap(&dir, &staged, &previous, &names).is_err());
        assert_eq!(fs::read(dir.join("src").join("cli.js")).unwrap(), b"old");
        assert_eq!(fs::read(staged.join("src").join("cli.js")).unwrap(), b"new");

        let names = vec!["src".to_string()];
        swap(&dir, &staged, &previous, &names).unwrap();
        assert_eq!(fs::read(dir.join("src").join("cli.js")).unwrap(), b"new");
        restore(&dir, &previous, &names);
        assert_eq!(fs::read(dir.join("src").join("cli.js")).unwrap(), b"old");
        let _ = fs::remove_dir_all(&base);
    }
}
