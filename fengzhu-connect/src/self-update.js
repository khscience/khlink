// Connector self-update for computers without the desktop console (macOS).
//
// Same channel as the Windows console (kh-link-desktop connector_update.rs):
// the signed update manifest's `windowsConnector` entry is the plain connector
// package. This module only fetches, verifies (Ed25519 manifest signature,
// package SHA-256) and unpacks it next to the installed copy; the swap, the
// restart and the rollback are done by scripts/khlink-macos.sh, which owns the
// LaunchAgent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// releases/update-signing-public.pem
const UPDATE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAooVsYkdIQc9U6n0kBXlFxxMUaFnrb1VbVs5zeHf6Lr0=\n-----END PUBLIC KEY-----\n';
const SOURCES = [
  'https://github.com/khscience/khlink-releases/releases/latest/download',
  'https://gcore.jsdelivr.net/gh/khscience/khlink-releases@dist',
  'https://khsci.vip/fengzhu-bridge/downloads',
];
const MAX_PACKAGE = 100 * 1024 * 1024;

/** `0.2.92` > `0.2.9`; missing parts count as zero. */
function newer(candidate, current) {
  const parts = (text) => String(text || '').trim().split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(candidate); const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0; const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The relay serves the detached signature as 64 raw bytes, mirrors may serve Base64. */
function verifyManifest(manifest, signature, publicKey = UPDATE_PUBLIC_KEY) {
  const raw = signature.length === 64 ? signature : Buffer.from(signature.toString('utf8').trim(), 'base64');
  if (raw.length !== 64) throw new Error('更新签名格式无效');
  if (!crypto.verify(null, manifest, publicKey, raw)) throw new Error('更新清单签名验证失败');
  return JSON.parse(manifest.toString('utf8'));
}

async function fetchBytes(url, { timeoutMs = 20_000, limit = MAX_PACKAGE, fetchFn = fetch } = {}) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > limit) throw new Error('下载内容超出预期大小');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('下载内容超出预期大小');
  return bytes;
}

/** Every source's verified manifest; the newest connector wins, so a CDN lagging behind loses. */
async function fetchManifest({ sources = SOURCES, publicKey = UPDATE_PUBLIC_KEY, fetchFn = fetch } = {}) {
  const results = await Promise.allSettled(sources.map(async (base) => {
    const [manifest, signature] = await Promise.all([
      fetchBytes(`${base}/update-manifest.json`, { fetchFn, limit: 4 * 1024 * 1024 }),
      fetchBytes(`${base}/update-manifest.sig`, { fetchFn, limit: 4096 }),
    ]);
    return verifyManifest(manifest, signature, publicKey);
  }));
  const manifests = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!manifests.length) throw new Error(`更新清单读取失败：${results.find((r) => r.status === 'rejected')?.reason?.message || ''}`);
  return manifests.reduce((best, next) => (newer(next.windowsConnector?.version, best.windowsConnector?.version) ? next : best));
}

/** A manifest entry's download sources: `urls` first, the single `url` as fallback, https only. */
function downloadUrls(entry) {
  const list = [...(Array.isArray(entry?.urls) ? entry.urls : []), entry?.url];
  return [...new Set(list.filter((url) => typeof url === 'string').map((url) => url.trim()).filter((url) => url.startsWith('https://')))];
}

async function fetchVerified(urls, sha256, { fetchFn = fetch } = {}) {
  let last = '连接器安装包没有下载地址';
  for (const url of urls) {
    try {
      const bytes = await fetchBytes(url, { fetchFn, timeoutMs: 300_000 });
      if (crypto.createHash('sha256').update(bytes).digest('hex') === String(sha256).toLowerCase()) return bytes;
      last = '连接器安装包校验失败，已丢弃';
    } catch (error) { last = error.message; }
  }
  throw new Error(last);
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** Why updating now would cut something the phone is waiting for, from a fresh status file. */
function restartBlocker(status, now = Date.now()) {
  if (!status || !(now - Number(status.updatedAt || 0) <= 15_000)) return null;
  const inFlight = Array.isArray(status.inFlightCommands) ? status.inFlightCommands.length : Number(status.inFlightCommands) || 0;
  return status.restartSafe === false || inFlight > 0 ? '电脑上还有任务在运行或消息在发送，等它们结束后再更新' : null;
}

/**
 * Download and unpack a newer connector next to `appDir`. Returns
 * `{ available: false, installed, latest }` when up to date, otherwise
 * `{ available: true, installed, version, staged, depsChanged }`; a reason
 * to wait (`busy`) comes back instead of staging.
 */
async function stageUpdate({ appDir, workDir, statusFile, fetchFn = fetch, sources = SOURCES, publicKey = UPDATE_PUBLIC_KEY, extract = extractTgz, force = false }) {
  const installedPackage = readJson(path.join(appDir, 'package.json'));
  if (!installedPackage?.version) throw new Error(`找不到已安装的连接器：${appDir}`);
  const installed = installedPackage.version;
  const manifest = await fetchManifest({ sources, publicKey, fetchFn });
  const entry = manifest.windowsConnector || {};
  const version = String(entry.version || '');
  if (!/^\d+(\.\d+){1,3}$/.test(version) || !/^[0-9a-f]{64}$/i.test(String(entry.sha256 || ''))) throw new Error('更新清单里没有有效的连接器版本');
  if (!newer(version, installed)) return { available: false, installed, latest: version };
  const busy = force ? null : restartBlocker(readJson(statusFile));
  if (busy) return { available: true, installed, version, busy };
  fs.mkdirSync(workDir, { recursive: true });
  const bytes = await fetchVerified(downloadUrls(entry), entry.sha256, { fetchFn });
  const archive = path.join(workDir, `fengzhu-connect-${version}.tgz`);
  const staged = path.join(workDir, `staged-${version}`);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.writeFileSync(archive, bytes);
  try { extract(archive, staged); } finally { fs.rmSync(archive, { force: true }); }
  const stagedPackage = readJson(path.join(staged, 'package.json'));
  if (stagedPackage?.version !== version || !fs.existsSync(path.join(staged, 'src', 'cli.js')) || !fs.existsSync(path.join(staged, 'scripts', 'khlink-macos.sh'))) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw new Error('连接器安装包内容不完整');
  }
  const depsChanged = JSON.stringify(stagedPackage.dependencies || {}) !== JSON.stringify(installedPackage.dependencies || {});
  return { available: true, installed, version, staged, depsChanged };
}

function extractTgz(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', into, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'pipe'] });
}

module.exports = { newer, verifyManifest, fetchManifest, downloadUrls, restartBlocker, stageUpdate, SOURCES };
