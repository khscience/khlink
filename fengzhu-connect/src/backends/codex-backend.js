// CodexBackend — wraps the existing CodexClient behind the AgentBackend seam.
// It deliberately keeps `.client` as the live CodexClient so connector.js can
// continue to use `this.codex` (= backend.client) and every existing test that
// stubs `connector.codex` keeps working unchanged. New, backend-neutral thread
// and turn helpers delegate to the same JSON-RPC the connector already uses, so
// they are behaviour-identical to the inline calls.
const { CodexClient } = require('../codex-client');

const CODEX_CAPABILITIES = Object.freeze({
  collaborationMode: true,
  threadQueue: true,
  desktopAutomation: true,
  fork: true,
  rollback: true,
  rateLimits: true,
  compact: true,
  permissionModes: ['manual', 'auto', 'yolo'],
});

class CodexBackend {
  constructor(config, client = new CodexClient(config)) {
    this.config = config;
    this.client = client;
  }

  get id() { return 'codex'; }
  get displayName() { return 'Codex'; }
  capabilities() { return CODEX_CAPABILITIES; }

  // ---- lifecycle (delegate to the client) ----
  start() { return this.client.start(); }
  stop() { return this.client.stop?.(); }
  restart() { return this.client.restart?.(); }
  isAvailable() { return this.client.isAvailable?.() ?? false; }
  on(event, handler) { return this.client.on(event, handler); }

  get ready() { return this.client.ready; }
  get version() { return this.client.version; }
  get mode() { return this.client.mode; }

  // ---- neutral thread/turn operations (delegate to the same JSON-RPC) ----
  // These mirror the calls connector.js makes today; new backends implement the
  // same shape so the connector can route by backend without agent-specific code.
  listThreads(params = {}, timeoutMs = 15_000) { return this.client.request('thread/list', params, timeoutMs); }
  readThread(threadId, timeoutMs = 15_000) { return this.client.request('thread/read', { threadId }, timeoutMs); }
  startThread(params = {}, timeoutMs = 15_000) { return this.client.request('thread/start', params, timeoutMs); }
  resumeThread(threadId, extra = {}, timeoutMs = 15_000) { return this.client.request('thread/resume', { threadId, ...extra }, timeoutMs); }
  startTurn(params, timeoutMs) { return this.client.request('turn/start', params, timeoutMs); }
  steerTurn(params, timeoutMs = 15_000) { return this.client.request('turn/steer', params, timeoutMs); }
  interruptTurn(params, timeoutMs = 15_000) { return this.client.request('turn/interrupt', params, timeoutMs); }
}

module.exports = { CodexBackend, CODEX_CAPABILITIES };
