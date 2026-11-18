'use strict';

// Account login for a computer without the khLink desktop app (macOS, Linux).
// It does what the desktop app's login does (kh-link-desktop lib.rs
// begin_login_runtime / complete_login_runtime / adopt_shared_key /
// provision_connector_runtime): khQuant OAuth with PKCE and a loopback
// callback, registers this installation as a computer, takes the account's
// shared key from a running connector (device-key v3) when the account already
// has a computer, then provisions this computer's connector and writes its
// config. Nothing here reads any agent credential.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const sodium = require('libsodium-wrappers-sumo');
const { unwrapAccountKey } = require('./device-key');

const CALLBACK_TIMEOUT_MS = 10 * 60_000;

function b64url(buffer) { return Buffer.from(buffer).toString('base64url'); }

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function newIdentity() {
  const privateKey = crypto.randomBytes(32);
  return {
    deviceId: crypto.randomUUID(),
    privateKey: privateKey.toString('base64'),
    accountKey: crypto.randomBytes(32).toString('base64'),
    keyAccountId: null,
  };
}

function publicKeyOf(identity) {
  return Buffer.from(sodium.crypto_scalarmult_base(Buffer.from(identity.privateKey, 'base64'))).toString('base64');
}

// The identity is kept (sealed like the config) so logging in again on the
// same computer reuses it instead of adding another computer to the account.
function identityStore({ dir, protect, unprotect }) {
  const file = path.join(dir, 'login-identity.dat');
  return {
    file,
    load() {
      try {
        const value = JSON.parse(unprotect(fs.readFileSync(file, 'utf8')));
        if (value?.deviceId && value?.privateKey && value?.accountKey) return value;
      } catch { /* missing or unreadable: start a new one */ }
      return null;
    },
    save(identity) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') { try { fs.chmodSync(dir, 0o700); } catch { /* not ours */ } }
      fs.writeFileSync(file, protect(JSON.stringify(identity)), { mode: 0o600 });
    },
  };
}

async function jsonRequest(fetchFn, url, { method = 'GET', token = null, body } = {}) {
  const response = await fetchFn(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null; try { value = text ? JSON.parse(text) : null; } catch { value = null; }
  if (!response.ok) {
    const message = value?.message || text || response.statusText;
    throw new Error(`${method} ${new URL(url).pathname} 失败 (${response.status})：${Array.isArray(message) ? message.join('; ') : message}`);
  }
  return value || {};
}

const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>khLink</title><body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center"><h2>khLink 登录完成</h2><p>可以关闭这个页面，回到终端。</p></body>';

// Resolves with { code, state, error } from the first /callback request.
function listenForCallback({ host = '127.0.0.1', timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  return new Promise((resolveListen, rejectListen) => {
    let settle;
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${host}`);
      if (req.method !== 'GET' || url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
      clearTimeout(timer);
      server.close();
      settle.resolve({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') });
    });
    const timer = setTimeout(() => { server.close(); settle.reject(new Error('等待浏览器登录超时（10 分钟）')); }, timeoutMs);
    server.on('error', rejectListen);
    server.listen(0, host, () => resolveListen({ port: server.address().port, result, close: () => { clearTimeout(timer); server.close(); } }));
  });
}

async function waitForSharedKey({ fetchFn, api, accessToken, identity, accountId, waitMs, intervalMs = 3000, log, sleep }) {
  const started = Date.now();
  let told = false;
  for (;;) {
    const response = await jsonRequest(fetchFn, `${api}/session/key-envelope`, { token: accessToken });
    if (response.keyEnvelope) {
      const envelope = JSON.parse(response.keyEnvelope);
      if (envelope?.version !== 3) throw new Error('账户密钥信封版本不对');
      const key = unwrapAccountKey(envelope, Buffer.from(identity.privateKey, 'base64'), accountId, identity.deviceId);
      if (key.length !== 32) throw new Error('账户密钥长度不对');
      return { key: key.toString('base64'), shared: true };
    }
    // Every computer it waited for was unbound: this one keeps its own key.
    if (response.noKeyHolder) return { key: null, shared: false };
    if (!told) {
      const holders = Array.isArray(response.holders) && response.holders.length ? `（${response.holders.join('、')}）` : '';
      log(`这个账号已有其他电脑${holders}。正在等它上面的 khLink 连接器把共享密钥交给这台电脑，请保持那台电脑在线……`);
      told = true;
    }
    if (Date.now() - started >= waitMs) throw new Error('没有等到共享密钥：请确认另一台电脑上的 khLink 连接器在线，然后重新运行 login');
    await sleep(intervalMs);
  }
}

async function loginAccount(options) {
  const {
    serverUrl, deviceName = os.hostname(), workspace = os.homedir(), codexBin = null, clientVersion = null,
    protect, unprotect, saveConfig, dataDir,
    fetchFn = fetch, openUrl = null, log = (line) => console.log(line),
    waitKeyMs = 10 * 60_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    listen = listenForCallback,
  } = options;
  if (!serverUrl) throw new Error('缺少中转地址');
  await sodium.ready;
  const api = `${serverUrl.replace(/\/$/, '')}/api/v2`;
  const store = identityStore({ dir: dataDir, protect, unprotect });
  const identity = store.load() || newIdentity();
  store.save(identity);

  const { verifier, challenge } = pkcePair();
  const callback = await listen();
  let callbackResult;
  try {
    const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
    const begin = await jsonRequest(fetchFn, `${api}/session/oauth/authorization`, { method: 'POST', body: { codeChallenge: challenge, redirectUri } });
    if (!begin.authorizationUrl || !begin.state) throw new Error('登录服务响应不完整');
    log(`请在浏览器中登录 khLink 账号并授权：\n${begin.authorizationUrl}`);
    log(`（授权完成后浏览器会跳回 ${redirectUri}；如在别的电脑上打开，需要把这个端口转发到本机）`);
    if (openUrl) { try { await openUrl(begin.authorizationUrl); } catch (error) { log(`没能自动打开浏览器：${error.message || error}`); } }
    callbackResult = await callback.result;
    if (callbackResult.error) throw new Error(`授权被拒绝：${callbackResult.error}`);
    if (callbackResult.state !== begin.state) throw new Error('登录 state 校验失败');
    if (!callbackResult.code) throw new Error('登录回调缺少授权码');
  } finally { callback.close(); }

  const completed = await jsonRequest(fetchFn, `${api}/session/oauth/complete`, {
    method: 'POST',
    body: {
      state: callbackResult.state, code: callbackResult.code, codeVerifier: verifier,
      deviceId: identity.deviceId, deviceName, publicKey: publicKeyOf(identity), deviceType: 'desktop',
      ...(clientVersion ? { clientVersion } : {}),
    },
  });
  const session = completed.session || {};
  if (!session.accountId || !session.accessToken) throw new Error('登录响应缺少会话');
  const accountId = session.accountId;
  // Switching to another account on this computer: never carry a key over.
  if (identity.keyAccountId && identity.keyAccountId !== accountId) identity.accountKey = crypto.randomBytes(32).toString('base64');
  identity.keyAccountId = accountId;
  store.save(identity);
  log(`已登录：${completed.profile?.displayName || completed.profile?.name || accountId}`);

  if (completed.keyPending) {
    const result = await waitForSharedKey({ fetchFn, api, accessToken: session.accessToken, identity, accountId, waitMs: waitKeyMs, log, sleep });
    if (result.key) { identity.accountKey = result.key; store.save(identity); log('已拿到账号的共享密钥'); }
  }

  const connectorName = `${deviceName} 后台连接器`;
  const connector = await jsonRequest(fetchFn, `${api}/connector/session`, { method: 'POST', token: session.accessToken, body: { deviceName: connectorName } });
  if (!connector.accountId || !connector.deviceId || !connector.refreshToken) throw new Error('连接器会话响应不完整');
  const config = saveConfig({
    protocolVersion: 2, serverUrl, accountId: connector.accountId, deviceId: connector.deviceId, deviceName: connectorName,
    workspace, codexBin, directOnly: false, accountKey: identity.accountKey, refreshToken: connector.refreshToken,
  });
  return { accountId: connector.accountId, deviceId: connector.deviceId, configFile: config.configFile, sharedKey: Boolean(completed.keyPending) };
}

module.exports = { loginAccount, listenForCallback, pkcePair, newIdentity, publicKeyOf, identityStore, waitForSharedKey };
