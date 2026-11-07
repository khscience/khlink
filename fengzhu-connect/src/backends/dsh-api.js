// DeepSeek Harness desktop Host API client.
//
// The DSH desktop app keeps its Host API behind a per-process launch token.
// The KH Link bridge plugin (fengzhu-connect/dsh-bridge) publishes the
// tokenized loopback URL to a user-scoped file; this module exchanges that
// token for an API operator cookie and speaks the Host's Typert Remote API.
//
// Nothing here reads a vendor credential: the token only authenticates the
// local Desktop Host that KH Link is already allowed to drive.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BRIDGE = 'dsh-desktop-bridge.json';
const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

class DshApiError extends Error {
  constructor(message, { code = null, status = 0, delivery = 'not_sent' } = {}) {
    super(message);
    this.name = 'DshApiError';
    this.code = code;
    this.status = status;
    this.delivery = delivery;
  }
}

function bridgePath() {
  if (process.env.KHLINK_DSH_BRIDGE) return process.env.KHLINK_DSH_BRIDGE;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'KH Link', DEFAULT_BRIDGE);
}

function loopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

// Read and validate the bridge file. The token lives only in memory and is
// never logged; callers must not serialize `url` outside this module.
function readBridge(file = bridgePath()) {
  let raw; let stat;
  try { stat = fs.statSync(file); raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null;
  let url; try { url = new URL(value.url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !loopbackHost(url.hostname)) return null;
  if (!url.searchParams.get('token')) return null;
  const port = Number(value.port) || Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    url: value.url,
    port,
    pid: Number(value.pid) || 0,
    profile: String(value.profile || ''),
    hostVersion: String(value.hostVersion || ''),
    updatedAt: Number(value.updatedAt) || stat.mtimeMs,
    ageMs: Math.max(0, Date.now() - (Number(value.updatedAt) || stat.mtimeMs)),
  };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

class DshClient {
  constructor(options = {}) {
    this.bridgeFile = options.bridgeFile || bridgePath();
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.timeoutMs = Number(options.timeoutMs) || REQUEST_TIMEOUT_MS;
    this.bridge = null;
    this.cookie = null;
    this.host = null;
    this.token = null;
  }

  get online() { return Boolean(this.cookie && this.host); }

  // Load the bridge and exchange its launch token for an API operator cookie.
  async connect() {
    const bridge = readBridge(this.bridgeFile);
    if (!bridge) throw new DshApiError('DeepSeek Harness 桌面端没有运行，或 KH Link 桥接没有加载。', { code: 'bridge-missing' });
    if (bridge.ageMs > 3 * 60_000 && bridge.pid && !alive(bridge.pid)) {
      throw new DshApiError('DeepSeek Harness 桌面端已退出。', { code: 'bridge-stale' });
    }
    const url = new URL(bridge.url);
    const token = url.searchParams.get('token');
    const connect = new URL('/connect', url);
    connect.searchParams.set('token', token);
    connect.searchParams.set('interactions', 'answer');
    let response;
    try {
      response = await this.fetchFn(connect, {
        method: 'GET',
        redirect: 'manual',
        headers: { host: url.host },
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DshApiError(`连不上 DeepSeek Harness 桌面端：${error.message}`, { code: 'connect-failed' });
    }
    if (response.status !== 302 && response.status !== 303 && response.status !== 200) {
      throw new DshApiError(`DeepSeek Harness 桌面端拒绝了连接（HTTP ${response.status}），请在电脑上重新打开 DSH。`, { code: 'connect-rejected', status: response.status });
    }
    const setCookie = response.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    if (!cookie || !cookie.includes('=')) {
      throw new DshApiError('DeepSeek Harness 桌面端没有返回会话凭据，请重新打开 DSH。', { code: 'connect-no-cookie' });
    }
    this.bridge = bridge;
    this.host = url.host;
    this.token = token;
    this.cookie = cookie;
    return { port: bridge.port, pid: bridge.pid, hostVersion: bridge.hostVersion };
  }

  // DSH restarted (new pid or port in the bridge file): the cached host and
  // cookie point at the old process. On 2026-11-06 DSH came back on another
  // port and every poll kept asking the old one, so the phone showed DSH
  // closed until the connector restarted.
  bridgeMoved() {
    if (!this.bridge) return false;
    const now = readBridge(this.bridgeFile);
    return Boolean(now && (now.port !== this.bridge.port || (now.pid && this.bridge.pid && now.pid !== this.bridge.pid)));
  }

  async call(method, args = {}, { retry = true } = {}) {
    if (this.online && this.bridgeMoved()) this.cookie = null;
    if (!this.online) await this.connect();
    const body = JSON.stringify({ type: 'client-request', rpcId: `khlink-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, payload: { args } });
    let response;
    try {
      response = await this.fetchFn(`http://${this.host}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.cookie, host: this.host },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.cookie = null;
      throw new DshApiError(`DeepSeek Harness 没有响应：${error.message}`, { code: 'request-failed' });
    }
    if (response.status === 401 && retry) {
      this.cookie = null;
      await this.connect();
      return this.call(method, args, { retry: false });
    }
    if (response.status === 404) throw new DshApiError(`DeepSeek Harness 不认识这个操作：${method}`, { code: 'method-not-found', status: 404 });
    let envelope;
    // Not DSH answering (or not this DSH): drop the session so the next call
    // reads the bridge file and connects again.
    try { envelope = await response.json(); } catch { this.cookie = null; throw new DshApiError(`DeepSeek Harness 返回了无法解析的响应（HTTP ${response.status}）`, { code: 'bad-response', status: response.status }); }
    if (!envelope || envelope.type !== 'server-response') { this.cookie = null; throw new DshApiError('DeepSeek Harness 返回了意外的响应。', { code: 'bad-response', status: response.status }); }
    const result = envelope.result || {};
    if (result.ok !== true) {
      const error = result.error || {};
      throw new DshApiError(error.message || 'DeepSeek Harness 操作失败', { code: error.code || 'rpc-failed', status: response.status, delivery: isNotSent(error.code) ? 'not_sent' : 'unknown' });
    }
    return result.value;
  }

  async probe() {
    try {
      await this.sessionList();
      return 'up';
    } catch (error) {
      if (['bridge-missing', 'bridge-stale'].includes(error.code)) return 'down';
      if (['request-failed', 'connect-failed', 'connect-rejected', 'connect-no-cookie'].includes(error.code)) return 'down';
      return 'up';
    }
  }

  async sessionList() {
    const value = await this.call('session/list', { _request: {} });
    return Array.isArray(value?.items) ? value.items : [];
  }

  async sessionPage(sessionId, throughSeq, maxMessages = 300) {
    const request = (seq, limit) => this.call('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq: Number.isFinite(Number(seq)) ? Number(seq) : 0,
        maxMessages: limit,
      },
    });
    try {
      return await request(throughSeq, maxMessages) || { records: [], hasMore: false };
    } catch (error) {
      // A cached projection watermark is not in this connection's cursor
      // space; the Host reports the real last cursor in the refusal.
      const past = /past cursor (\d+)/i.exec(String(error.message || ''));
      if (past) return await request(Number(past[1]), maxMessages) || { records: [], hasMore: false };
      // An append racing a large page can surface as a 500. A smaller page
      // after a short pause sees the settled log.
      if (Number(error.status) === 500 && maxMessages > 120) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return await request(throughSeq, 120) || { records: [], hasMore: false };
      }
      throw error;
    }
  }

  async prompt(sessionId, { text, requestId, mode = 'queue', images = [], clientTimeZone = 'Asia/Singapore' } = {}) {
    const content = [];
    if (String(text || '').trim()) content.push({ type: 'text', text: String(text) });
    for (const image of images) {
      if (!image?.data) continue;
      content.push({ type: 'image', mediaType: image.mediaType || 'image/png', data: image.data, ...(image.name ? { name: image.name } : {}) });
    }
    if (!content.length) throw new DshApiError('消息内容为空。', { code: 'empty-prompt' });
    return this.call('session/prompt', {
      request: { requestId: requestId || `khlink-${Date.now()}`, sessionId, mode, content, clientTimeZone },
    }, { retry: true });
  }

  async cancel(sessionId) { return this.call('session/cancel', { request: { sessionId } }); }

  async create({ cwd, agentPreset } = {}) {
    const request = {};
    if (cwd) request.cwd = cwd;
    if (agentPreset) request.agentPreset = agentPreset;
    return this.call('session/create', { request });
  }

  async rename(sessionId, title) { return this.call('session/rename', { request: { sessionId, title } }); }

  async archiveSession(sessionId, stopActivity = true) {
    return this.call('workspace/archiveSession', { request: { sessionId, stopActivity } });
  }

  async unarchiveSession(sessionId) {
    return this.call('workspace/unarchiveSession', { request: { sessionId } });
  }

  async modelCatalog() { return this.call('session/modelCatalog', {}); }

  async accountState() { return this.call('account/getState', {}); }

  async accountProfile(client) { return this.call('account/getProfile', { client }); }

  async accountBalance(client) { return this.call('account/getBalance', { client }); }

  async pinSession(sessionId) { return this.call('workspace/pinSession', { request: { sessionId } }); }

  async unpinSession(sessionId) { return this.call('workspace/unpinSession', { request: { sessionId } }); }

  async selectModel(sessionId, { provider, model, reasoningEffort } = {}) {
    return this.call('session/selectModel', { request: { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } });
  }

  // The Host exposes the permission-preset catalog at process scope. The
  // catalog contains read-only / workspace-write / danger-full-access / auto;
  // defaultOptions excludes Auto because it is only selectable when its
  // integration is live.
  async permissionCatalog() {
    return this.call('permissionPresets/catalog', {});
  }

  // Slash commands are Host commands, not model prompts. `/permission <name>`
  // is the supported way to switch one live session; it writes the permission
  // preset and the underlying sandbox/approval facts immediately.
  async executeCommand(sessionId, line, submittedAttachments = []) {
    return this.call('commands/execute', { agentId: sessionId, line, submittedAttachments });
  }

  async answerQuestion(sessionId, callId, answers) {
    return this.call('userQuestions/answer', { agentId: sessionId, callId, answer: { answers: Array.isArray(answers) ? answers : [] } });
  }
}

function isNotSent(code) {
  return new Set([
    'bridge-missing', 'bridge-stale', 'connect-failed', 'connect-rejected', 'connect-no-cookie',
    'request-failed', 'method-not-found', 'empty-prompt',
    'session/attachment-invalid', 'session/model-unavailable', 'session/not-found', 'session/agent-busy',
  ]).has(String(code || ''));
}

module.exports = { DshClient, DshApiError, readBridge, bridgePath, loopbackHost, isNotSent, DEFAULT_BRIDGE };
