// ClaudeBackend — drives the user's locally installed, already-logged-in Claude
// Code CLI (`claude`) in bidirectional stream-json mode, behind the AgentBackend
// seam. One `claude` process per active thread; it exits when idle and is resumed
// with --resume on the next turn.
//
// SECURITY (matches agent-backend.js invariant): this backend only spawns the
// official `claude` binary and lets it handle its own login. It never reads,
// copies or transmits any credential. It strips every CLAUDE*/ANTHROPIC* var
// from the child env so a host session's injected desktop-app auth is never
// borrowed — the CLI uses its own `claude /login` session only.
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PERMISSION_MODES_LIST = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const CLAUDE_CAPABILITIES = Object.freeze({
  collaborationMode: false,
  threadQueue: false,
  desktopAutomation: false,
  fork: false,
  rollback: false,
  rateLimits: false,
  compact: true,
  permissionModes: PERMISSION_MODES_LIST,
  // Values accepted by `claude --model` / `claude --effort`. '' = CLI default.
  models: ['', 'opus', 'sonnet', 'haiku'],
  efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
});

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function normalizeEffort(value) { const v = String(value || '').toLowerCase(); return EFFORTS.has(v) ? v : ''; }
// Model names go straight onto the command line: allow only alias / model-id characters.
function normalizeModel(value) { const v = String(value || '').trim(); return /^[A-Za-z0-9._\[\]-]{1,80}$/.test(v) ? v : ''; }

const IDLE_EXIT_MS = 15 * 60_000;
const MAX_CONCURRENT = 3;

// Remove the desktop app's injected auth/config so the CLI uses only its own login.
function cleanEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

// Map a Claude tool name to the connector's item vocabulary.
function toolItemType(toolName) {
  const name = String(toolName || '');
  if (name === 'Bash') return 'commandExecution';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'fileChange';
  if (name === 'TodoWrite') return 'plan';
  if (name === 'WebSearch' || name === 'WebFetch') return 'webSearch';
  if (name.startsWith('mcp__')) return 'mcpToolCall';
  return 'mcpToolCall'; // generic tool (Read/Grep/Glob/Task/…) — refined in P6
}

// Claude Code permission modes, exactly as the desktop app offers them
// (labels there: Manual, Accept edits, Plan, Auto, Bypass permissions).
// Older KH Link values manual/auto/yolo are mapped for existing threads.
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const LEGACY_PERMISSION = { manual: 'default', yolo: 'bypassPermissions', ask: 'default' };
function normalizePermissionMode(mode) {
  const value = String(mode || '');
  if (PERMISSION_MODES.includes(value)) return value;
  if (value === 'auto') return 'auto';
  return LEGACY_PERMISSION[value] || 'default';
}

function permissionArgs(approveMode) {
  const mode = normalizePermissionMode(approveMode);
  // Every mode except bypass may need a decision; route those to the phone.
  return mode === 'bypassPermissions'
    ? ['--permission-mode', 'bypassPermissions']
    : ['--permission-mode', mode, '--permission-prompt-tool', 'stdio'];
}

// The command line runs a phone's turn when the desktop app is not open (after
// a restart, say). Its own login is separate, and its English "Not logged in ·
// Please run /login" told the phone nothing it could act on.
function cliErrorText(text) {
  if (/not logged in|please run \/login/i.test(text)) return '电脑上的 Claude 桌面版没有打开，命令行 Claude 也没有登录，这条消息没有发出。请先在电脑上打开 Claude 桌面版再发。';
  return text;
}

class ClaudeSession {
  constructor(threadId) {
    this.threadId = threadId;
    this.child = null;
    this.buffer = '';
    this.sessionId = null;      // Claude session_id, used for --resume
    this.workdir = null;
    this.approveMode = 'manual';
    this.model = '';
    this.effort = '';
    this.spawnedSig = null;     // launch flags of the live process
    this.status = 'idle';       // idle | running
    this.activeTurnId = null;
    this.pendingApprovals = new Map(); // requestId -> { toolName, input }
    this.lastActivity = Date.now();
    this.assistantText = '';    // accumulates streaming text for the current message
  }
  alive() { return this.child && this.child.exitCode === null && !this.child.killed; }
  write(obj) { if (this.alive()) this.child.stdin.write(`${JSON.stringify(obj)}\n`); }
}

class ClaudeBackend extends EventEmitter {
  constructor(config = {}, options = {}) {
    super();
    this.config = config;
    this.spawnFn = options.spawnFn || spawn;
    this.claudeBin = options.claudeBin
      || process.env.KH_LINK_CLAUDE_BIN
      || path.join(process.env.APPDATA ? path.join(os.homedir(), 'AppData', 'Roaming') : os.homedir(), 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    this.now = options.now || Date.now;
    this.idleExitMs = options.idleExitMs || IDLE_EXIT_MS;
    this.maxConcurrent = options.maxConcurrent || MAX_CONCURRENT;
    this.sessions = new Map(); // threadId -> ClaudeSession
    this.idleTimer = null;
  }

  get id() { return 'claude'; }
  get displayName() { return 'Claude Code'; }
  capabilities() { return CLAUDE_CAPABILITIES; }

  start() {
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
      this.idleTimer.unref?.();
    }
    return Promise.resolve();
  }

  stop() {
    clearInterval(this.idleTimer); this.idleTimer = null;
    for (const session of this.sessions.values()) this.killSession(session, 'backend stopped');
    this.sessions.clear();
    return Promise.resolve();
  }

  isAvailable() { return true; }

  newThread({ workdir, approveMode = 'manual', model = '', effort = '' } = {}) {
    const threadId = crypto.randomUUID();
    const session = new ClaudeSession(threadId);
    session.workdir = workdir || this.config.workspace || process.env.USERPROFILE || os.homedir();
    session.approveMode = approveMode;
    session.model = normalizeModel(model);
    session.effort = normalizeEffort(effort);
    this.sessions.set(threadId, session);
    return { threadId, workdir: session.workdir };
  }

  // Re-attach a thread persisted by the connector (e.g. after a connector
  // restart) so the next turn resumes the same Claude session.
  adoptThread({ threadId, workdir, sessionId = null, approveMode = 'manual', model = '', effort = '' } = {}) {
    if (!threadId) throw new Error('adoptThread 需要 threadId');
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const session = new ClaudeSession(threadId);
    session.workdir = workdir || this.config.workspace || process.env.USERPROFILE || os.homedir();
    session.sessionId = sessionId || null;
    session.approveMode = approveMode || 'manual';
    session.model = normalizeModel(model);
    session.effort = normalizeEffort(effort);
    this.sessions.set(threadId, session);
    return session;
  }

  hasThread(threadId) { return this.sessions.has(threadId); }

  // Stop this backend's process for a thread (kept resumable). Used once the
  // desktop app has taken the session over, so only one process holds it.
  releaseSession(threadId) {
    const session = this.sessions.get(threadId);
    if (!session || session.status === 'running') return false;
    this.killSession(session, 'handed to desktop');
    return true;
  }
  isRunning(threadId) { return this.sessions.get(threadId)?.status === 'running'; }

  // Change model / effort / permission mode. Launch flags only apply at spawn,
  // so an idle live process is restarted lazily on the next turn (--resume
  // keeps the conversation).
  updateSettings(threadId, { model, effort, approveMode } = {}) {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`未知的 Claude 线程: ${threadId}`);
    if (model !== undefined) session.model = normalizeModel(model);
    if (effort !== undefined) session.effort = normalizeEffort(effort);
    if (approveMode) session.approveMode = approveMode;
    return { model: session.model, effort: session.effort, approveMode: session.approveMode };
  }

  launchSig(session) { return JSON.stringify([session.approveMode, session.model, session.effort]); }

  reapIdle() {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.status !== 'running' && session.alive() && now - session.lastActivity > this.idleExitMs) {
        this.killSession(session, 'idle');
      }
    }
  }

  killSession(session, _reason) {
    if (session.alive()) { try { session.child.kill(); } catch { /* ignore */ } }
    session.child = null; session.buffer = ''; session.status = 'idle'; session.activeTurnId = null;
    // Deny any approvals still pending so the model is not left hanging on restart.
    session.pendingApprovals.clear();
  }

  ensureProcess(session) {
    if (session.alive()) {
      if (session.spawnedSig === this.launchSig(session) || session.status === 'running') return session;
      this.killSession(session, 'launch settings changed');
    }
    if ([...this.sessions.values()].filter((s) => s.alive()).length >= this.maxConcurrent) {
      // Evict the least-recently-active idle session to make room.
      const victim = [...this.sessions.values()]
        .filter((s) => s !== session && s.alive() && s.status !== 'running')
        .sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (victim) this.killSession(victim, 'evicted for concurrency');
    }
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--include-partial-messages', '--verbose', ...permissionArgs(session.approveMode)];
    if (session.model) args.push('--model', session.model);
    if (session.effort) args.push('--effort', session.effort);
    if (session.sessionId) args.push('--resume', session.sessionId);
    // The desktop app updates its bundled Claude Code in place: the version
    // folder found at start-up can lose its claude.exe (seen: ENOENT on
    // 2.1.281 mid-update). Look again before every start.
    if (this.resolveBin) { try { const found = this.resolveBin(); if (found?.bin) this.claudeBin = found.bin; } catch { /* keep */ } }
    // A missing working folder makes spawn fail with an ENOENT naming the program.
    const cwd = this.resolveCwd ? this.resolveCwd(session.workdir) : session.workdir;
    if (this.resolveCwd && cwd && !fs.existsSync(cwd)) {
      this.emit('error', { threadId: session.threadId, message: `这个会话的工作目录在电脑上已经不存在：${cwd}`, terminal: true });
      return;
    }
    const child = this.spawnFn(this.claudeBin, args, {
      cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    session.child = child;
    session.spawnedSig = this.launchSig(session);
    session.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(session, chunk));
    child.stderr?.setEncoding?.('utf8');
    // Ignore a late exit from a process that was already replaced.
    child.on('exit', (code) => { if (session.child === child) this.onExit(session, code); });
    child.on('error', (error) => {
      // spawn ENOENT names the program but is also what Windows says for a missing working folder.
      const detail = error?.code === 'ENOENT' ? ` (bin ${fs.existsSync(this.claudeBin) ? 'ok' : 'missing'}, cwd ${session.workdir} ${session.workdir && fs.existsSync(session.workdir) ? 'ok' : 'missing'})` : '';
      console.error(`[fengzhu-connect] claude spawn failed: ${error?.message || error}${detail}`);
      this.emit('error', { threadId: session.threadId, message: String(error?.message || error), terminal: true });
    });
    return session;
  }

  onExit(session, code) {
    if (session.child && session.child.exitCode === null && !session.child.killed) return;
    const wasRunning = session.status === 'running';
    session.child = null; session.status = 'idle';
    if (wasRunning) {
      // A crash mid-turn: surface a failure and clear the active turn.
      session.activeTurnId = null;
      this.emit('status', { threadId: session.threadId, status: 'failed' });
      this.emit('error', { threadId: session.threadId, message: `claude 进程退出（code=${code}）`, terminal: true });
    }
  }

  onStdout(session, chunk) {
    session.buffer += chunk;
    let index;
    while ((index = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, index).trim();
      session.buffer = session.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      try { this.handleEvent(session, event); } catch (error) { this.emit('error', { threadId: session.threadId, message: `解析 Claude 事件失败: ${error.message}` }); }
    }
  }

  handleEvent(session, event) {
    session.lastActivity = this.now();
    const threadId = session.threadId;
    switch (event.type) {
      // Plan usage windows (five_hour / seven_day utilisation and reset time)
      // reported by Claude Code with each request.
      case 'rate_limit_event':
        if (event.rate_limit_info) this.emit('rateLimit', { threadId, info: event.rate_limit_info });
        break;
      case 'system':
        if (event.subtype === 'init' && event.session_id) { session.sessionId = event.session_id; this.emit('session', { threadId: session.threadId, sessionId: event.session_id }); }
        break;
      case 'assistant':
        this.handleAssistant(session, event.message);
        break;
      case 'control_request':
        this.handleControlRequest(session, event);
        break;
      case 'result': {
        session.status = 'idle';
        const turnId = session.activeTurnId;
        session.activeTurnId = null;
        session.assistantText = '';
        const failed = event.is_error === true || (event.subtype && event.subtype !== 'success');
        this.emit('status', { threadId, status: failed ? 'failed' : 'completed' });
        if (failed) this.emit('error', { threadId, message: cliErrorText(String(event.result || event.subtype || 'claude 执行失败')), terminal: true });
        this.emit('turnComplete', { threadId, turnId, usage: event.usage || null, sessionId: session.sessionId, cost: event.total_cost_usd });
        break;
      }
      default:
        break;
    }
  }

  handleAssistant(session, message) {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this.emit('item', { threadId: session.threadId, item: { id: crypto.randomUUID(), type: 'agentMessage', text: block.text, at: this.now() } });
      } else if (block.type === 'thinking' && (block.thinking || block.text)) {
        this.emit('item', { threadId: session.threadId, item: { id: crypto.randomUUID(), type: 'reasoning', text: block.thinking || block.text, at: this.now() } });
      } else if (block.type === 'tool_use') {
        this.emit('item', { threadId: session.threadId, item: { id: block.id || crypto.randomUUID(), type: toolItemType(block.name), tool: block.name, input: block.input || {}, at: this.now() } });
      }
    }
  }

  handleControlRequest(session, event) {
    const request = event.request || {};
    if (request.subtype !== 'can_use_tool') return;
    const requestId = event.request_id;
    const toolName = request.tool_name || 'tool';
    const input = request.input || {};
    session.pendingApprovals.set(requestId, { toolName, input });
    if (toolName === 'AskUserQuestion') {
      this.emit('question', { threadId: session.threadId, requestId, questions: input.questions || [] });
    } else {
      this.emit('approval', { threadId: session.threadId, requestId, tool: toolName, input, summary: summarizeToolInput(toolName, input) });
    }
  }

  // ---- turn operations ----
  startTurn(threadId, { text = '', images = [], approveMode, model, effort, turnId } = {}) {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`未知的 Claude 线程: ${threadId}`);
    if (approveMode) session.approveMode = approveMode;
    if (model) session.model = normalizeModel(model);
    if (effort) session.effort = normalizeEffort(effort);
    this.ensureProcess(session);
    session.status = 'running';
    session.activeTurnId = turnId || crypto.randomUUID();
    session.assistantText = '';
    this.emit('status', { threadId, status: 'running' });
    session.write({ type: 'user', message: { role: 'user', content: buildContent(text, images) } });
    return { turnId: session.activeTurnId };
  }

  steerTurn(threadId, input = {}) {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`未知的 Claude 线程: ${threadId}`);
    // "Send now" while a turn runs: hand the message to the running Claude
    // Code, which absorbs it mid-turn — the same thing the desktop does when
    // you type while it works. No interrupt, nothing is lost.
    if (session.status === 'running' && session.alive()) {
      session.lastActivity = this.now();
      session.write({ type: 'user', message: { role: 'user', content: buildContent(input.text || '', input.images || []) } });
      return { turnId: session.activeTurnId, midTurn: true };
    }
    return this.startTurn(threadId, input);
  }

  interruptTurn(threadId) {
    const session = this.sessions.get(threadId);
    if (!session || !session.alive()) return false;
    session.write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } });
    return true;
  }

  resolveApproval(threadId, requestId, approved) {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return false;
    session.pendingApprovals.delete(requestId);
    const response = approved
      ? { behavior: 'allow', updatedInput: pending.input || {} }
      : { behavior: 'deny', message: '用户在手机上拒绝了此操作，请停止并等待用户指示。' };
    session.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    return true;
  }

  answerQuestion(threadId, requestId, answers) {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return false;
    session.pendingApprovals.delete(requestId);
    session.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: { ...pending.input, answers } } } });
    return true;
  }
}

function buildContent(text, images) {
  if (!images || images.length === 0) return String(text || '');
  const blocks = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data } }));
  if (text) blocks.push({ type: 'text', text: String(text) });
  return blocks;
}

function summarizeToolInput(toolName, input) {
  if (toolName === 'Bash') return String(input.command || '').slice(0, 400);
  if (input && typeof input === 'object') {
    const target = input.file_path || input.path || input.url || input.pattern;
    if (target) return String(target).slice(0, 400);
  }
  return '';
}

module.exports = { cliErrorText, normalizePermissionMode, PERMISSION_MODES: PERMISSION_MODES_LIST, ClaudeBackend, CLAUDE_CAPABILITIES, toolItemType, cleanEnv, buildContent, normalizeEffort, normalizeModel };
