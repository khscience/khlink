'use strict';
// A long-lived `hermes acp` child speaking the Agent Client Protocol over
// stdio. `hermes acp` attaches to the running Hermes gateway on its host (its
// ticket comes from the gateway's private control socket), so khLink never
// handles a Hermes API key, and Hermes slash commands such as /goal, /loop and
// /kanban are run by the gateway itself.
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

const REQUEST_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 6 * 60 * 60_000;

class AcpError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data; }
}

class HermesAcp extends EventEmitter {
  constructor(transport, { log = () => {} } = {}) {
    super();
    this.transport = transport;
    this.log = log;
    this.child = null;
    this.ready = null;
    this.nextId = 0;
    this.pending = new Map();
    this.attached = new Set();   // sessions resumed/created on this child
    this.models = null;          // last availableModels from session/new|resume
    this.sessionModels = new Map(); // sessionId -> currentModelId
    this.stderrTail = '';
  }

  // Start (or reuse) the child and finish `initialize`.
  start() {
    if (this.ready) return this.ready;
    this.ready = this._start().catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  async _start() {
    const child = this.transport.spawnAcp();
    this.child = child;
    this.attached = new Set();
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(line));
    child.on('exit', (code, signal) => this._onExit(child, code, signal));
    child.on('error', (error) => this._onExit(child, null, error.message));
    const init = await this._request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'khLink', version: require('../../package.json').version },
    }, 30_000);
    this.agentInfo = init?.agentInfo || null;
    return init;
  }

  _onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    this.attached = new Set();
    const tail = this.stderrTail.trim().split('\n').slice(-3).join(' | ');
    const error = new AcpError(`Hermes ACP 进程已退出（${signal || code}）${tail ? `：${tail.slice(0, 300)}` : ''}`, 'hermes-acp-exit');
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.emit('exit', error);
  }

  stop() {
    const child = this.child;
    this.child = null; this.ready = null;
    try { child?.kill(); } catch {}
  }

  _write(message) {
    if (!this.child) throw new AcpError('Hermes ACP 没有运行', 'hermes-acp-down');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`Hermes 没有在 ${Math.round(timeoutMs / 1000)} 秒内响应 ${method}`, 'hermes-timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this._write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async request(method, params, timeoutMs) {
    await this.start();
    return this._request(method, params, timeoutMs);
  }

  respond(id, result) { this._write({ jsonrpc: '2.0', id, result }); }
  respondError(id, code, message) { this._write({ jsonrpc: '2.0', id, error: { code, message } }); }

  _onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && !message.method && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(new AcpError(String(message.error.message || 'Hermes 返回错误'), message.error.code, message.error.data));
      else resolve(message.result);
      return;
    }
    if (message.method === 'session/update') {
      this.emit('update', message.params?.sessionId, message.params?.update || {});
      return;
    }
    if (message.method && message.id != null) {
      // Server -> client requests. Permission prompts are answered by the
      // phone; anything else this client does not implement fails fast.
      if (message.method === 'session/request_permission') { this.emit('permission', message.id, message.params || {}); return; }
      try { this.respondError(message.id, -32601, 'not implemented by khLink'); } catch {}
    }
  }

  // ---- ACP verbs ------------------------------------------------------------
  async newSession(cwd) {
    const result = await this.request('session/new', { cwd, mcpServers: [] }, 120_000);
    if (result?.sessionId) this.attached.add(result.sessionId);
    if (result?.models) { this.models = result.models; this.sessionModels.set(result.sessionId, result.models.currentModelId); }
    return result;
  }

  // Prompting needs the session attached to this child; resume does that and
  // replays its history as updates, which the caller ignores.
  async attach(sessionId, cwd) {
    await this.start();
    if (this.attached.has(sessionId)) return null;
    const result = await this._request('session/resume', { sessionId, cwd: cwd || '/', mcpServers: [] }, 120_000);
    this.attached.add(sessionId);
    if (result?.models) { this.models = result.models; this.sessionModels.set(sessionId, result.models.currentModelId); }
    return result;
  }

  prompt(sessionId, blocks) { return this.request('session/prompt', { sessionId, prompt: blocks }, PROMPT_TIMEOUT_MS); }
  // ACP cancel is a notification: the running prompt answers with stopReason "cancelled".
  async cancel(sessionId) { await this.start(); this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); }
  setModel(sessionId, modelId) { return this.request('session/set_model', { sessionId, modelId }, 60_000); }
}

module.exports = { HermesAcp, AcpError };
