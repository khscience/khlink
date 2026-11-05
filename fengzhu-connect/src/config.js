const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Dpapi, isPlatformSupported } = require('@primno/dpapi');

const home = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'FengzhuAgentBridge');
const file = path.join(home, 'config.json');

function protect(value) {
  if (!isPlatformSupported) throw new Error('Windows DPAPI is unavailable');
  return Buffer.from(Dpapi.protectData(Buffer.from(value, 'utf8'), null, 'CurrentUser')).toString('base64');
}

function unprotect(value) {
  return Buffer.from(Dpapi.unprotectData(Buffer.from(value, 'base64'), null, 'CurrentUser')).toString('utf8');
}

// The official khLink relay. Without official-relay.json setup needs --server. A saved
// legacy address of the relay is read as the current one (same accounts,
// devices and sessions).
const official = (() => { try { return require('./official-relay.json'); } catch { return {}; } })();
const DEFAULT_SERVER_URL = official.serverUrl || '';
const LEGACY_SERVER_URLS = official.legacyServerUrls || [];
function currentServerUrl(value, current = DEFAULT_SERVER_URL, legacy = LEGACY_SERVER_URLS) {
  const url = String(value || '').replace(/\/$/, '');
  return legacy.includes(url) ? current : url;
}

function loadConfig() {
  if (!fs.existsSync(file)) throw new Error(`Connector is not configured: ${file}`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const secrets = JSON.parse(unprotect(stored.protected));
  const config = { ...stored, ...secrets, serverUrl: currentServerUrl(stored.serverUrl), protocolVersion: Number(stored.protocolVersion) || 1, configFile: file };
  if (config.protocolVersion === 2 && (!config.accountId || !config.accountKey || (!config.refreshToken && !config.directOnly))) {
    throw new Error('khLink v2 connector configuration is incomplete');
  }
  return config;
}

function saveConfig(input) {
  fs.mkdirSync(home, { recursive: true });
  const protocolVersion = Number(input.protocolVersion) === 2 ? 2 : 1;
  const publicPart = {
    protocolVersion,
    serverUrl: input.serverUrl.replace(/\/$/, ''),
    deviceId: input.deviceId || crypto.randomUUID(),
    deviceName: input.deviceName || os.hostname(),
    workspace: input.workspace || process.cwd(),
    codexBin: input.codexBin || null,
    directOnly: input.directOnly === true,
  };
  if (protocolVersion === 2) publicPart.accountId = input.accountId;
  const secretPart = { accountKey: input.accountKey, refreshToken: input.refreshToken || null };
  fs.writeFileSync(file, JSON.stringify({ ...publicPart, protected: protect(JSON.stringify(secretPart)) }, null, 2), { mode: 0o600 });
  return { ...publicPart, ...secretPart, configFile: file };
}

// Direct mode keeps the relay as a fallback while the computer is signed in to
// an account: a phone whose direct link keeps failing can then switch to the
// account login. A computer paired by QR only, with no account, stays off the
// relay.
function relayEnabled(config) { return !config?.directOnly || Boolean(config?.refreshToken); }

function updateSecrets(config, changes) {
  return saveConfig({ ...config, ...changes });
}

module.exports = { file, home, protect, unprotect, loadConfig, saveConfig, updateSecrets, currentServerUrl, relayEnabled, DEFAULT_SERVER_URL };
