'use strict';
const { spawn } = require('node:child_process');
const { accountIdentity } = require('./account-identity');
function isolatedEnv(home, userData = null, original = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(original)) if (!/^(CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) env[key] = value;
  env.CODEX_HOME = home;
  if (userData) env.CODEX_ELECTRON_USER_DATA_PATH = userData;
  return env;
}
function quota(value, at) {
  if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
  const reset = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt * 1000 : null;
  return { remaining: Math.round((100 - value.usedPercent) * 10) / 10, resetsAt: reset, observedAt: at, windowDurationMins: value.windowDurationMins ?? null };
}
function normalize(accountResult, usageResult, at = Date.now(), { includeIdentity = false } = {}) {
  const account = accountResult?.account;
  // Only these fields leave the child RPC. No raw responses or stderr logs.
  const identity = typeof account?.email === 'string' && account.email ? [account.type, account.email, account.chatgptAccountId || ''].join('\0') : null;
  const result = { checkedAt: at, loggedIn: !!account, fingerprint: identity ? accountIdentity('codex-account', identity) : null, kind: account?.type === 'chatgpt' ? 'chatgpt' : account?.type === 'apiKey' ? 'apiKey' : account ? 'other' : null,
    plan: typeof account?.planType === 'string' && /^[a-zA-Z0-9_-]{1,30}$/.test(account.planType) ? account.planType : null, usage: null, error: null };
  // Opt-in belongs to the local desktop panel only. Phone pollers keep the
  // default fingerprint-only contract, including usagePayload's whitelist.
  if (includeIdentity && typeof account?.email === 'string' && account.email.length <= 254 &&
    !/[\s\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(account.email) && /^[^@]+@[^@]+\.[^@.]+$/.test(account.email)) {
    result.identity = { email: account.email };
  }
  if (!account || !usageResult) return result;
  const limits = usageResult.rateLimitsByLimitId?.codex || usageResult.rateLimits;
  if (!limits) return result;
  const windows = [limits.primary, limits.secondary].filter(Boolean);
  result.usage = { observedAt: at, fiveHour: quota(windows.find(w => w.windowDurationMins === 300), at), sevenDay: quota(windows.find(w => w.windowDurationMins === 10080), at) };
  if (!result.usage.fiveHour && !result.usage.sevenDay) result.usage = null;
  return result;
}
async function readAccount(binary, profile, { spawnFn = spawn, timeoutMs = 18000, now = Date.now, includeIdentity = false } = {}) {
  const child = spawnFn(binary, ['app-server', '--listen', 'stdio://'], { cwd: profile.home, env: isolatedEnv(profile.home), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '', nextId = 0, failed = false; const pending = new Map();
  const failure = () => { failed = true; for (const p of pending.values()) p.reject(new Error('官方账号接口暂时不可用。')); pending.clear(); };
  child.on('error', failure); child.on('close', failure);
  child.stdin.on?.('error', failure);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { failure(); return; }
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); let value;
      try { value = JSON.parse(line); } catch { continue; }
      const p = pending.get(value.id); if (!p) continue;
      pending.delete(value.id); value.error ? p.reject(new Error('官方账号接口返回失败。')) : p.resolve(value.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failed) return reject(new Error('官方账号接口不可用。'));
    const id = ++nextId; pending.set(id, { resolve, reject });
    try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); } catch { failure(); }
  });
  const timer = setTimeout(() => { failure(); child.kill(); }, timeoutMs); // Only this disposable, no-turn helper, never Desktop.
  try {
    await request('initialize', { clientInfo: { name: 'khlink-account-panel', version: '0.1.11' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const account = await request('account/read', { refreshToken: false });
    if (!account?.account || account.account.type !== 'chatgpt') return normalize(account, null, now(), { includeIdentity });
    try { return normalize(account, await request('account/rateLimits/read', {}), now(), { includeIdentity }); }
    catch { return { ...normalize(account, null, now(), { includeIdentity }), error: '额度暂时无法获取。' }; }
  } finally { clearTimeout(timer); child.stdin.end(); const end = setTimeout(() => child.kill(), 1500); end.unref(); child.once('close', () => clearTimeout(end)); }
}
function usagePayload(record, snapshotAt) {
  const window = value => value ? { usedPercent: 100 - value.remaining,
    resetsAt: value.resetsAt ? value.resetsAt / 1000 : null, windowDurationMins: value.windowDurationMins } : null;
  return {
    snapshotAt, accountFingerprint: record?.fingerprint || null,
    accountState: record?.loggedIn === false ? 'signed_out' : record?.loggedIn === true ? 'ready' : 'unavailable',
    rateLimits: record?.usage ? { planType: record.plan, primary: window(record.usage.fiveHour), secondary: window(record.usage.sevenDay) } : null,
    error: record?.error || null,
  };
}

// A task-owning app-server can retain its original login after Desktop changes
// accounts. Inspect using a disposable, no-turn reader; never recycle that host.
// Coalesce all consumers (poll, reconnect, capabilities) into one bounded read.
class AccountUsagePoller {
  constructor({ read, now = Date.now, ttlMs = 30_000 }) {
    this.read = read; this.now = now; this.ttlMs = ttlMs; this.generation = 0;
  }
  invalidate() { this.generation++; this.value = null; }
  async get() {
    if (this.pending) return this.pending;
    if (this.value && this.now() >= this.value.snapshotAt && this.now() - this.value.snapshotAt < this.ttlMs) return this.value;
    const generation = this.generation;
    this.pending = (async () => {
      let record;
      try { record = await this.read(); } catch { record = { error: '额度暂时无法获取。' }; }
      if (generation !== this.generation) return null; // An account notification overtook this read.
      const at = Math.max(this.now(), (this.lastAt || 0) + 1); this.lastAt = at;
      return this.value = usagePayload(record, at);
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}
module.exports = { isolatedEnv, normalize, quota, readAccount, usagePayload, AccountUsagePoller };
