// Client for the local PI WEB server (https://pi-web.dev), which runs Pi Coding
// Agent sessions in its session daemon. KH Link talks to the same server the
// browser UI uses, so the phone and PI WEB see the same live sessions.
//
// Everything is local (127.0.0.1). Pi's model providers, API keys and their
// traffic stay inside PI WEB / Pi; KH Link only relays what the user asks for.

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const DEFAULT_BASE = 'http://127.0.0.1:8504/api';
const PI_WEB_HOME = 'G:\\Apps\\pi-web';

class PiWebClient {
  constructor(options = {}) {
    this.base = String(options.baseUrl || process.env.KH_LINK_PI_WEB_URL || DEFAULT_BASE).replace(/\/$/, '');
    this.home = options.home || process.env.KH_LINK_PI_WEB_HOME || PI_WEB_HOME;
  }

  async request(method, route, { query, body, timeoutMs = 20_000, headers = {} } = {}) {
    const url = new URL(`${this.base}${route}`);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method, signal: controller.signal,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
      if (!response.ok) {
        const error = new Error(data?.error || `PI WEB ${response.status}`);
        error.status = response.status;
        if ([400, 401, 403, 404, 409, 422, 429].includes(response.status)) error.delivery = 'not_sent';
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('PI WEB 没有响应');
      if (/fetch failed|ECONNREFUSED/i.test(String(error.message))) { const offline = new Error('PI WEB 没有运行'); offline.offline = true; throw offline; }
      throw error;
    } finally { clearTimeout(timer); }
  }

  get(route, query, options) { return this.request('GET', route, { ...options, query }); }
  post(route, body, options) { return this.request('POST', route, { ...options, body: body || {} }); }

  // Twice, so one slow answer while PI WEB is busy does not count as down.
  async alive() { return (await this.probe()) === 'up'; }

  // 'up', 'busy' (it takes the connection but does not answer in time: it is
  // running, only slow, and starting another copy cannot help) or 'down'
  // (nothing listening).
  async probe() {
    let busy = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await this.request('GET', '/pi-web/version', { timeoutMs: 5_000 }); return 'up'; } catch (error) { if (!error.offline) busy = true; }
    }
    return busy ? 'busy' : 'down';
  }

  // PI WEB's own supervisor, without opening a browser window.
  start() {
    const launcher = path.join(this.home, 'launcher.mjs');
    if (!fs.existsSync(launcher)) throw new Error('没有找到 PI WEB 启动器');
    const child = spawn(process.execPath, [launcher, '--background'], { cwd: this.home, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }

  async workspaces() {
    const listed = await this.get('/projects');
    const projects = Array.isArray(listed) ? listed : listed?.projects || [];
    const rows = [];
    for (const project of projects) {
      let list = [];
      try { list = (await this.get(`/projects/${encodeURIComponent(project.id)}/workspaces`))?.workspaces || []; } catch { continue; }
      for (const workspace of list) rows.push({ projectId: project.id, projectName: project.name, workspaceId: workspace.id, cwd: workspace.path, label: workspace.label });
    }
    return rows;
  }

  sessions(cwd) { return this.get('/sessions', { cwd }); }
  // A session PI WEB has not loaded yet takes it 20-30 s to open.
  status(id, cwd, timeoutMs = 20_000) { return this.get(`/sessions/${encodeURIComponent(id)}/status`, { cwd }, { timeoutMs }); }
  messages(id, cwd, page = {}) { return this.get(`/sessions/${encodeURIComponent(id)}/messages`, { cwd, ...page }, { timeoutMs: 60_000 }); }
  unread() { return this.get('/sessions/unread'); }
  modelCatalog(id, cwd) { return this.get(`/sessions/${encodeURIComponent(id)}/models/catalog`, { cwd }, { timeoutMs: 60_000 }); }
  thinkingLevels(id, cwd) { return this.get(`/sessions/${encodeURIComponent(id)}/thinking-levels`, { cwd }, { timeoutMs: 60_000 }); }
  createSession(cwd) { return this.post('/sessions', { cwd }); }
  prompt(id, cwd, text, streamingBehavior, attachments) { return this.post(`/sessions/${encodeURIComponent(id)}/prompt`, { cwd, text, ...(streamingBehavior ? { streamingBehavior } : {}), ...(attachments?.length ? { attachments } : {}) }); }
  clearQueue(id, cwd) { return this.post(`/sessions/${encodeURIComponent(id)}/queue/clear`, { cwd }); }
  abort(id, cwd) { return this.post(`/sessions/${encodeURIComponent(id)}/abort`, { cwd }); }
  archive(id, cwd) { return this.post(`/sessions/${encodeURIComponent(id)}/archive`, { cwd }); }
  restore(id, cwd) { return this.post(`/sessions/${encodeURIComponent(id)}/restore`, { cwd }); }
  setModel(id, cwd, provider, modelId) { return this.post(`/sessions/${encodeURIComponent(id)}/model`, { cwd, provider, modelId }, { timeoutMs: 60_000 }); }
  setThinking(id, cwd, level) { return this.post(`/sessions/${encodeURIComponent(id)}/thinking-level`, { cwd, level }, { timeoutMs: 60_000 }); }
  saveAttachments(id, cwd, attachments) { return this.post(`/sessions/${encodeURIComponent(id)}/attachments`, { cwd, attachments }, { timeoutMs: 60_000 }); }
  submitAsk(id, cwd, askId, submission) { return this.post(`/sessions/${encodeURIComponent(id)}/ask/submit`, { cwd, askId, ...submission }); }
  // The user's own provider manager in this PI WEB (customizations/): it only
  // accepts same-site requests that say they come from a Pi config screen.
  providerRequest(method, route, body) { return this.request(method, `/custom-providers${route}`, { body, headers: { 'x-pi-custom-config': '1' } }); }
  providers() { return this.providerRequest('GET', ''); }
  createProvider(provider) { return this.providerRequest('POST', '', provider); }
  updateProvider(id, provider) { return this.providerRequest('PUT', `/${encodeURIComponent(id)}`, provider); }
  answerDialog(id, cwd, dialogId, value) { return this.post(`/sessions/${encodeURIComponent(id)}/dialogs/answer`, { cwd, dialogId, value }); }
}

// ---- Pi's own session file (read-only) --------------------------------------
// Reading history through PI WEB makes it load the whole session into memory
// (20-30 s each), so history is read from the session's JSONL file instead,
// built the way PI WEB builds it: the branch from the last entry back to the
// root, then its messages plus compaction / branch summaries.
function readPiSessionMessages(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  const linked = entries.filter((entry) => entry && entry.type !== 'session' && entry.id);
  let branch = linked;
  if (linked.some((entry) => entry.parentId)) {
    const byId = new Map(linked.map((entry) => [entry.id, entry]));
    branch = [];
    const seen = new Set();
    for (let entry = linked[linked.length - 1]; entry && !seen.has(entry.id); entry = byId.get(entry.parentId)) { seen.add(entry.id); branch.push(entry); }
    branch.reverse();
  }
  const messages = [];
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message) messages.push({ ...entry.message, sourceMessageId: entry.id });
    else if (entry.type === 'custom_message' && entry.display === true) messages.push({ role: 'custom', content: entry.content });
    else if (entry.type === 'compaction') messages.push({ role: 'system', source: 'compaction', content: `Compacted history:

${entry.summary || ''}` });
    else if (entry.type === 'branch_summary') messages.push({ role: 'system', source: 'branch_summary', content: `Branch summary:

${entry.summary || ''}` });
  }
  return messages;
}

// ---- Pi message -> KH Link history items ------------------------------------
const FILE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'create_file']);

function toolItem(block) {
  const name = String(block.name || 'tool');
  const args = block.arguments && typeof block.arguments === 'object' ? block.arguments : {};
  if (name === 'bash' || name === 'shell' || name === 'run_command') return { type: 'commandExecution', text: String(args.command || args.cmd || name), status: 'completed' };
  if (FILE_TOOLS.has(name)) {
    const file = args.path || args.file_path || args.filePath || '';
    return { type: 'fileChange', text: `${name === 'write' || name === 'create_file' ? '新增' : '修改'} ${file}`.trim(), status: 'completed' };
  }
  if (/search|fetch|web/i.test(name)) return { type: 'webSearch', text: String(args.query || args.url || name), status: 'completed' };
  const target = args.path || args.pattern || args.query || '';
  return { type: 'mcpToolCall', text: [name, target].filter(Boolean).join('\n'), status: 'completed' };
}

// `start` is the index of messages[0] in the whole session, so ids are stable.
function messageItems(messages, start = 0) {
  const items = []; const toolsById = new Map();
  messages.forEach((message, offset) => {
    const index = start + offset;
    const at = Number(message.timestamp) || null;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }];
    // Order: message index, then block position inside the message.
    const add = (suffix, value, block = 0) => { if (String(value.text || '').trim()) items.push({ id: `pi-${index}-${suffix}`, order: index * 100 + Math.min(block, 99), at,
      value: { ...value, ...(message.sourceMessageId ? { sourceMessageId: message.sourceMessageId } : {}), ...(at ? { createdAt: at } : {}) } }); };
    if (message.role === 'user') {
      // Images sent with the message (from the phone or PI WEB), shown like Claude's: at most 4, ~1.5 MB each.
      const images = blocks.filter((b) => b.type === 'image' && typeof b.data === 'string')
        .map((b) => {
          const mimeType = /^image\/[a-z0-9.+-]+$/i.test(b.mimeType || '') ? b.mimeType : 'image/png';
          return { mimeType, data: `data:${mimeType};base64,${b.data}` };
        })
        .filter((image) => image.data.length <= 2_000_000).slice(0, 4);
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      add('u', { type: 'userMessage', text: text || (images.length ? '图片' : ''), status: null, ...(images.length ? { images } : {}) });
    } else if (message.role === 'assistant') {
      // A failed model call (e.g. the relay cut the stream) leaves only an error.
      // Stopped by the user (Stop in PI WEB or on the phone): not a failure.
      const stopped = message.stopReason === 'aborted' || /^request aborted/i.test(String(message.errorMessage || ''));
      if (stopped) add('e', { type: 'agentMessage', text: '已停止', status: 'interrupted' }, 99);
      else if (message.stopReason === 'error' || message.errorMessage) add('e', { type: 'turnError', text: String(message.errorMessage || '模型调用失败'), status: 'failed' }, 99);
      blocks.forEach((block, b) => {
        if (block.type === 'thinking') add(`t${b}`, { type: 'reasoning', text: block.thinking || '', status: null }, b);
        else if (block.type === 'text') add(`m${b}`, { type: 'agentMessage', text: block.text || '', status: null }, b);
        else if (block.type === 'toolCall') {
          const item = toolItem(block);
          add(`c${b}`, item, b);
          if (block.id) toolsById.set(block.id, items[items.length - 1]);
        }
      });
    } else if (message.role === 'toolResult' && message.isError) {
      // Mark the call that failed; the output itself is not shown.
      const call = toolsById.get(message.toolCallId); if (call) call.value = { ...call.value, status: 'failed' };
    }
  });
  return items;
}

module.exports = { PiWebClient, messageItems, toolItem, readPiSessionMessages, DEFAULT_BASE };
