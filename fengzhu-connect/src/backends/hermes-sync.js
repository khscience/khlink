// Hermes Agent sessions, mirrored to the phone.
//
// Reads come from Hermes' own session store through a read-only helper
// (hermes-store.py), so every history row has a stable id (the message row).
// Writes go through `hermes acp`, attached to the running Hermes gateway: new
// sessions, prompts (slash commands such as /goal, /loop and /kanban are run
// by the gateway), stop, model choice (including the MoA presets) and the
// answers to Hermes' permission prompts. While a phone turn runs, ACP's text
// chunks feed one live row so the reply can be read as it is written.
// Installed onto Connector.prototype by install().

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const writeFileAtomic = require('../atomic-file').writeFileAtomic;
const { encryptJson } = require('../crypto');
const { clip } = require('../history');
const { HermesTransport, readTransportConfig } = require('./hermes-transport');
const { HermesAcp } = require('./hermes-acp');
const { fileKind } = require('./claude-sent-files');

const POLL_MS = 5_000;
const ACTIVE_POLL_MS = 1_500;
const LIVE_FLUSH_MS = 1_200;
const PAGE = 400;
const ITEMS_SCHEMA = 6;   // 2: mirrored files moved out of the key folder; 3/4: clear a stale live row; 5: user pictures; 6: index keeps activity time
// History order: each stored message owns SLOTS positions (reasoning, text,
// tool calls, files); locally answered commands and the live row use the
// tail of the latest message's range so they sort after it.
const SLOTS = 100;
const LOCAL_SLOT = 60;
const LIVE_SLOT = 99;
const UPLOAD_BATCH = 100;
const UPLOAD_BATCH_BYTES = 1_500_000;
const THREAD_PREFIX = 'hermes-';
const OTHER_SURFACE_ACTIVE_MS = 3 * 60_000;
const FILE_MAX_BYTES = 25 * 1024 * 1024;
const HERMES_OFFLINE = 'Hermes 没有响应：请确认 Hermes 主机（WSL）已开机、hermes-gateway 正在运行。';
const BACKGROUND_READ = /(\.read|\.get|\.list|capabilities|usage)$/;
const SKIP_DISPLAY = new Set(['hidden', 'internal_notification', 'auto_continue', 'steer', 'model_switch']);
// Files Hermes leaves on its host (screenshots, charts, exports). Absolute
// POSIX paths only; the extension list keeps prose and code paths out.
const MEDIA_PATH = /(?:^|[\s"'`(\[<:：])((?:\/(?:home|tmp|root|mnt|srv|opt|var|data)\/)[^\s"'`<>()\[\]{}|]+?\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|pdf|csv|xlsx|docx|pptx|zip|md|txt|html))(?=$|[\s"'`)\]>.,;:，。；、])/gi;

function threadIdOf(sessionId) { return `${THREAD_PREFIX}${sessionId}`; }
function sessionIdOf(threadId) { return String(threadId || '').startsWith(THREAD_PREFIX) ? String(threadId).slice(THREAD_PREFIX.length) : null; }
function parseJson(value, fallback = null) { if (value && typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function seconds(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0; }

// A user/assistant content cell: plain text, or a list of parts.
function contentText(content) {
  if (content == null) return { text: '', images: 0 };
  const parsed = typeof content === 'string' && /^\s*\[/.test(content) ? parseJson(content, null) : null;
  if (!Array.isArray(parsed)) return { text: String(content), images: 0 };
  let images = 0;
  const text = parsed.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' || part?.type === 'input_text') return String(part.text || '');
    if (/image/.test(String(part?.type || ''))) { images += 1; return ''; }
    return '';
  }).filter(Boolean).join('\n');
  return { text, images };
}

// Tool results arrive wrapped for the model; show the payload itself.
function unwrapToolResult(content) {
  let text = String(content || '');
  const wrapped = text.match(/^<untrusted_tool_result[^>]*>\n?(?:The following content[^\n]*\n)?([\s\S]*?)<\/untrusted_tool_result>\s*$/);
  if (wrapped) text = wrapped[1];
  return text.trim();
}

function toolFailed(text) {
  const data = parseJson(text, null);
  if (data && typeof data === 'object') return data.success === false || Boolean(data.error) || (Number.isFinite(data.exit_code) && data.exit_code !== 0);
  return /^(error|❌|failed)/i.test(text.trim());
}

function toolKind(name, args = {}) {
  const tool = String(name || 'tool');
  if (tool === 'terminal' || tool === 'execute_code' || tool === 'process') {
    return { type: 'commandExecution', text: [tool, String(args.command || args.code || args.cmd || '').trim()].filter(Boolean).join('\n') };
  }
  if (['read_file', 'search_files', 'list_directory'].includes(tool)) {
    return { type: 'mcpToolCall', text: [tool, args.path || args.pattern || args.query || ''].filter(Boolean).join('\n') };
  }
  if (['write_file', 'patch', 'edit_file', 'apply_patch'].includes(tool)) {
    return { type: 'fileChange', text: [tool, args.path || args.file_path || ''].filter(Boolean).join('\n') };
  }
  if (/^web_|search$/.test(tool)) {
    return { type: 'webSearch', text: [tool, args.query || args.url || (Array.isArray(args.urls) ? args.urls.join('\n') : '')].filter(Boolean).join('\n') };
  }
  if (/delegate|subagent|kanban|send_message/.test(tool)) {
    return { type: 'collabAgentToolCall', text: [tool, args.goal || args.title || args.task || args.message || ''].filter(Boolean).join('\n') };
  }
  const summary = args.description || args.title || args.question || args.url || args.path || args.code || args.query || '';
  return { type: 'mcpToolCall', text: [tool, String(summary).slice(0, 600)].filter(Boolean).join('\n') };
}

// Hermes keeps a picture the user sent as "[The user sent an image~ …]" plus
// "[If you need a closer look, use vision_analyze with image_url: PATH ~]",
// then the user's words. Returns the paths and the words, or null.
const IMAGE_MARKER = /\[If you need a closer look, use vision_analyze with image_url: (\S+?) ~\]/g;
function imageInput(text) {
  const source = String(text || '');
  const paths = [];
  let end = -1;
  for (const match of source.matchAll(IMAGE_MARKER)) { paths.push(match[1]); end = match.index + match[0].length; }
  if (end < 0) return null;
  return { paths, text: source.slice(end).trim() };
}
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const MAX_USER_IMAGES = 4;
const MAX_USER_IMAGE_BYTES = 1_400_000;   // about 2 MB as a data URI, as for Claude

// Tool output lists many paths; only pictures, video, audio and PDFs from it
// are shown. Documents are shown when the reply itself names them.
const MEDIA_ONLY = /.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|pdf)$/i;

function mediaPaths(text, { documents = true } = {}) {
  const found = [];
  const source = String(text || '');
  for (const match of source.matchAll(MEDIA_PATH)) {
    const file = match[1].replace(/[.,;:]+$/, '');
    if (!documents && !MEDIA_ONLY.test(file)) continue;
    if (!found.includes(file)) found.push(file);
    if (found.length >= 8) break;
  }
  for (const match of source.matchAll(/MEDIA:\s*(\/[^\s"'`<>]+)/g)) if (!found.includes(match[1])) found.push(match[1]);
  return found;
}

// Hermes model ids look like "moa:panel" or "custom:custom:claude-sonnet-4-6".
// The phone's model picker keys models as "<group>/<id>"; the group is the
// part before the first colon, so the mapping is lossless both ways.
function hermesModelKey(modelId) {
  const text = String(modelId || '');
  const index = text.indexOf(':');
  return index > 0 ? `${text.slice(0, index)}/${text.slice(index + 1)}` : text;
}
function hermesModelId(key) {
  const text = String(key || '');
  const index = text.indexOf('/');
  return index > 0 ? `${text.slice(0, index)}:${text.slice(index + 1)}` : text;
}
// The ACP model list in the picker's catalog shape: Mixture-of-Agents presets
// first (专家会诊), then each provider's models.
function hermesCatalog(models, current) {
  const groups = new Map();
  for (const model of models?.availableModels || []) {
    const id = String(model.modelId || '');
    const index = id.indexOf(':');
    if (index <= 0) continue;
    const group = id.slice(0, index);
    const name = group === 'moa' ? '专家会诊（MoA）' : String(model.description || '').replace(/^Provider:\s*/, '').replace(/\s*•\s*current$/, '') || group;
    if (!groups.has(group)) groups.set(group, { id: group, name, models: [] });
    groups.get(group).models.push({ id: id.slice(index + 1), name: group === 'moa' ? `专家会诊 · ${id.slice(index + 1)}` : String(model.name || id) });
  }
  const ordered = [...groups.values()].sort((left, right) => (left.id === 'moa' ? -1 : right.id === 'moa' ? 1 : 0));
  const key = hermesModelKey(current);
  const slash = key.indexOf('/');
  return { groups: ordered, ...(slash > 0 ? { default: { provider: key.slice(0, slash), model: key.slice(slash + 1) } } : {}) };
}

// Hermes names its approval choices in English; the phone shows them in Chinese.
const PERMISSION_LABELS = {
  'allow once': '允许这一次', 'allow for session': '本会话内都允许', 'allow always': '以后都允许',
  deny: '拒绝', 'deny always': '以后都拒绝',
};
function permissionLabel(option) {
  const name = String(option.name || option.optionId || '');
  return PERMISSION_LABELS[name.trim().toLowerCase()] || name;
}

const methods = {
  startHermesSync() {
    if (this._hermesTimer || !this.config?.configFile) return;
    const configDir = path.dirname(this.config.configFile);
    const transportConfig = readTransportConfig(configDir);
    if (!transportConfig) return;
    this.hermesConfig = transportConfig;
    this.hermesTransport = new HermesTransport(transportConfig);
    this.hermesAcp = new HermesAcp(this.hermesTransport, { log: (error) => this.log(error) });
    this.hermesAcp.on('update', (sessionId, update) => this.onHermesUpdate(sessionId, update));
    this.hermesAcp.on('permission', (rpcId, params) => this.onHermesPermission(rpcId, params).catch((error) => this.log(error)));
    this.hermesAcp.on('exit', (error) => this.onHermesAcpExit(error));
    this.hermesThreadsFile = path.join(configDir, 'hermes-threads.json');
    // Not beside config.json: the phone may never read from the connector's
    // key folder (files.js), and it has to read these.
    this.hermesFilesDir = process.env.HERMES_FILES_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'khLink', 'hermes-files');
    this.hermesThreads = this.readHermesThreads();
    this.hermesRunning = new Map();     // sessionId -> { startedAt, text, flushedText, lastFlushAt }
    this.hermesPermissions = new Map(); // requestId -> { rpcId, sessionId, options }
    this.hermesOnline = false;
    console.log(`[fengzhu-connect] hermes sync on via ${this.hermesTransport.describe()} (${this.hermesThreads.size} known)`);
    const tick = () => this.pollHermes().catch((error) => this.log(error));
    this._hermesTimer = setInterval(tick, POLL_MS);
    this._hermesTimer.unref?.();
    tick();
  },

  readHermesThreads() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(this.hermesThreadsFile, 'utf8')))); } catch { return new Map(); }
  },

  saveHermesThreads() {
    try { writeFileAtomic(this.hermesThreadsFile, JSON.stringify(Object.fromEntries(this.hermesThreads))); } catch (error) { this.log(error); }
  },

  setHermesOnline(online) {
    if (Boolean(this.hermesOnline) === online) return;
    this.hermesOnline = online;
    this.emit?.('connector.presence', null, this.presencePayload());
  },

  hermesIndexValue(id, meta) {
    return {
      id, title: meta.title || 'Hermes 会话', cwd: meta.cwd || '',
      status: this.hermesThreadStatus(meta), updatedAt: meta.updatedAt || Date.now(), activityAt: meta.activityAt ?? meta.updatedAt ?? 0,
      note: meta.waiting?.summary || '', waiting: meta.waiting || null,
      backend: 'hermes', archived: Boolean(meta.archived), pinned: Boolean(meta.pinned),
      pinOrder: meta.pinned ? 0 : -1, unread: false, origin: meta.origin || 'desktop', model: meta.model || '',
      source: meta.source || '',
    };
  },

  hermesThreadStatus(meta) {
    return meta.waiting ? 'desktop_waiting' : meta.running ? 'desktop_running' : meta.terminalStatus || 'completed';
  },

  async uploadHermesIndex(id, meta, indexChanged = false) {
    const value = this.hermesIndexValue(id, meta);
    const encrypted = encryptJson(this.config.accountKey, 'history.thread', id, id, value);
    const indexUpdatedAt = indexChanged ? Date.now() : value.updatedAt;
    await this.api.request(this.api.path('/history/threads'), { method: 'PUT', body: { id, archived: value.archived, updatedAt: indexUpdatedAt, ...encrypted } });
  },

  async uploadHermesItems(id, items) {
    let batch = []; let bytes = 0;
    const flush = async () => { if (!batch.length) return; await this.putHistoryItems(id, batch); batch = []; bytes = 0; };
    for (const item of items) {
      const value = { ...item.value, ...clip(item.value.text || '', 32 * 1024) };
      const row = { id: item.id, order: item.order, createdAt: item.at || Date.now(), ...await this.historyItemFrame(id, item.id, value) };
      const size = row.ciphertext.length + 200;
      if (batch.length >= UPLOAD_BATCH || (batch.length && bytes + size > UPLOAD_BATCH_BYTES)) await flush();
      batch.push(row); bytes += size;
    }
    await flush();
  },

  async pollHermes(forceId = null) {
    if (this.stopping || !this.config.accountKey || !this.hermesTransport) return;
    if (this._hermesPolling) {
      // A turn that just ended must not wait for the next timer tick.
      this._hermesPollAgain = forceId || this._hermesPollAgain || true;
      return;
    }
    this._hermesPolling = true;
    try {
      let list;
      try {
        list = await this.hermesTransport.store('list');
        this._hermesOfflineLogged = false;
        this.setHermesOnline(true);
      } catch (error) {
        this.setHermesOnline(false);
        if (!this._hermesOfflineLogged) { this.log(new Error(`hermes: ${error.message}`)); this._hermesOfflineLogged = true; }
        return;
      }
      let changed = false;
      for (const summary of Array.isArray(list?.sessions) ? list.sessions : []) {
        if (!summary?.id) continue;
        const id = threadIdOf(summary.id);
        // Empty shells (a client that opened a session and never wrote) stay
        // hidden unless khLink created them.
        if (!(Number(summary.message_count) > 0) && !this.hermesThreads.has(id)) continue;
        try { if (await this.syncHermesSession(summary, forceId === id || forceId === summary.id)) changed = true; }
        catch (error) { this.log(new Error(`hermes ${summary.id}: ${error.message}`)); }
      }
      if (changed) { this.saveHermesThreads(); this.emit('threads.updated', null, { updatedAt: Date.now() }); }
    } finally {
      this._hermesPolling = false;
      const again = this._hermesPollAgain;
      this._hermesPollAgain = null;
      if (again) setImmediate(() => this.pollHermes(again === true ? null : again).catch((error) => this.log(error)));
    }
  },

  async syncHermesSession(summary, force = false) {
    const sessionId = summary.id;
    const id = threadIdOf(sessionId);
    const meta = this.hermesThreads.get(id) || { sessionId, syncedMessageId: 0, pendingCalls: {}, itemsSchema: ITEMS_SCHEMA, origin: 'desktop' };
    // A resync also hides any live row a failed upload left behind.
    if ((meta.itemsSchema || 0) < ITEMS_SCHEMA) { meta.syncedMessageId = 0; meta.pendingCalls = {}; meta.itemsSchema = ITEMS_SCHEMA; meta.liveShown = true; }
    const maxId = Number(summary.max_message_id) || 0;
    const contentChanged = force || maxId > (Number(meta.syncedMessageId) || 0);
    const own = this.hermesRunning.has(sessionId);
    const last = summary.last_message;
    const lastAt = seconds(last?.timestamp) || seconds(summary.last_activity_at);
    // Gateway admissions remain started during long, quiet tool calls. Older
    // Hermes versions and sessions outside the gateway still need the legacy
    // recent-message fallback, which must not override an unknown admission.
    const execution = summary.execution_state;
    const uncertain = !own && (execution === 'unknown' || execution === 'queued');
    const legacyRunning = !summary.ended_at && last && (last.role === 'user' || last.role === 'tool' || (last.role === 'assistant' && Number(last.calls) === 1))
      && Date.now() - lastAt < OTHER_SURFACE_ACTIVE_MS;
    const outcomeStatus = { completed: 'completed', interrupted: 'interrupted', cancelled: 'cancelled', failed: 'failed', rejected: 'failed' }[summary.execution_outcome];
    // A terminal admission settles a turn we observed on the gateway only if
    // no newer messages appeared. Otherwise a different surface may already
    // have started a new, untracked turn; keep the recent-message fallback.
    const witnessedTerminal = meta.gatewayActive && Number(meta.gatewayActiveMessageId) === maxId;
    const gatewayTerminal = execution === 'idle' && outcomeStatus && (witnessedTerminal || !legacyRunning);
    const otherRunning = !own && !uncertain && (execution === 'running' || (!gatewayTerminal && legacyRunning));
    const running = own || Boolean(otherRunning);
    // The queued suffix also prevents older Android versions from showing an
    // unknown state as a completed green dot; newer versions label it clearly.
    const nonTerminal = ['unknown', 'unknown_queued', 'queued'];
    const terminalStatus = uncertain ? (execution === 'queued' ? 'queued' : 'unknown_queued')
      : gatewayTerminal ? outcomeStatus
        : (meta.terminalStatus && !nonTerminal.includes(meta.terminalStatus) ? meta.terminalStatus : 'completed');
    const title = String(summary.title || meta.title || '');
    const model = String(summary.model || meta.model || '');
    const pinned = Boolean(Number(summary.pinned));
    const archived = Boolean(Number(summary.archived)) || Boolean(meta.localArchive);
    const updatedAt = Math.max(seconds(summary.last_activity_at), seconds(summary.started_at), lastAt) || Date.now();
    const labelChanged = meta.title !== title || Boolean(meta.running) !== running || (execution === 'running' && !meta.gatewayActive)
      || (!running && meta.terminalStatus !== terminalStatus) || meta.model !== model
      || Boolean(meta.pinned) !== pinned || Boolean(meta.archived) !== archived || meta.source !== summary.source;
    if (!contentChanged && !labelChanged && meta.indexed) return false;

    // A label change moves the row's version forward; the first upload of a
    // session keeps its own last-activity time, so a computer that starts
    // syncing (or a resync) does not make old sessions look new.
    const indexChanged = Boolean(meta.indexed) && (meta.title !== title || Boolean(meta.pinned) !== pinned || Boolean(meta.archived) !== archived);
    Object.assign(meta, {
      sessionId, title, model, pinned, archived, running, source: summary.source || meta.source || '',
      gatewayActive: execution === 'running' || (uncertain && Boolean(meta.gatewayActive)),
      gatewayActiveMessageId: execution === 'running' ? maxId : Number(meta.gatewayActiveMessageId) || 0,
      cwd: summary.cwd || meta.cwd || '', updatedAt,
      activityAt: Math.max(Number(meta.activityAt) || 0, updatedAt),
    });
    if (running) meta.terminalStatus = null;
    else meta.terminalStatus = terminalStatus;
    // The item table references the thread row: index first.
    await this.uploadHermesIndex(id, meta, indexChanged);
    meta.indexed = true;

    if (contentChanged) {
      const items = [];
      let after = Number(meta.syncedMessageId) || 0;
      for (let page = 0; page < 20; page += 1) {
        const data = await this.hermesTransport.store('messages', sessionId, String(after), String(PAGE));
        const rows = Array.isArray(data?.messages) ? data.messages : [];
        for (const row of rows) {
          for (const item of await this.hermesItemsForMessage(id, meta, row)) items.push(item);
          after = Math.max(after, Number(row.id) || 0);
        }
        if (rows.length < PAGE) break;
      }
      if (items.length) {
        this.reconcileSendReceipts?.('hermes', id, items);
        const unique = new Map();
        for (const item of items) unique.set(item.id, item);
        await this.uploadHermesItems(id, [...unique.values()]);
        // The newest message's own time: a resync must not make an old session look active.
        const newest = Math.max(...items.map((item) => Number(item.at) || 0), 0) || updatedAt;
        // The stored reply replaces the live row (before the phone is told to
        // read, so it never sees both); live text stays closed until Hermes
        // starts another step (a tool call).
        if (items.some((item) => item.value.type === 'agentMessage')) await this.hideHermesLive(id, meta);
        this.emit('history.updated', id, { threadId: id, itemCount: items.length, updatedAt: newest, backend: 'hermes' });
      }
      meta.syncedMessageId = after;
    }

    this.hermesThreads.set(id, meta);
    this.announceHermesStatus(id, meta);
    return true;
  },

  announceHermesStatus(id, meta) {
    const liveStatus = this.hermesThreadStatus(meta);
    if (meta.announcedStatus !== liveStatus || (liveStatus === 'desktop_running' && Date.now() - (meta.announcedAt || 0) > 15_000)) {
      meta.announcedStatus = liveStatus; meta.announcedAt = Date.now();
      this.emit('thread.status', id, { threadId: id, status: liveStatus, backend: 'hermes', updatedAt: Date.now() });
    }
  },

  // One stored Hermes message -> zero or more history items. Ids come from the
  // message row (and the tool call id), so a later sync updates, never repeats.
  async hermesItemsForMessage(threadId, meta, row) {
    const items = [];
    const rowId = Number(row.id) || 0;
    const at = seconds(row.timestamp) || Date.now();
    const push = (suffix, slot, value) => items.push({ id: `${threadId}-m${rowId}${suffix}`, order: rowId * SLOTS + slot, at, value: { createdAt: at, status: null, ...value } });
    if (row.active === 0 || row.active === false) return items;
    if (row.display_kind && SKIP_DISPLAY.has(row.display_kind)) return items;
    if (row.display_kind) {
      const display = parseJson(row.display_metadata, {}) || {};
      const text = String(display.display_text || contentText(row.content).text || '').trim();
      if (text) push('', 1, { type: 'agentMessage', text });
      return items;
    }
    if (row.role === 'user') {
      const content = contentText(row.content);
      // A picture reaches Hermes' history as its description plus a cache
      // path; the phone shows the user's own words and the picture.
      const attached = imageInput(content.text);
      const text = attached ? attached.text : content.text;
      const images = attached ? await this.hermesUserImages(attached.paths) : [];
      const shown = text.trim() || (images.length || content.images ? '图片附件' : '');
      // "/goal X" and "/moa X" are already shown as the user's row; Hermes
      // stores X again as the message it acts on.
      const echo = (meta.commandArgs || []).indexOf(shown);
      if (echo >= 0) { meta.commandArgs.splice(echo, 1); return items; }
      if (shown) push('', 1, { type: 'userMessage', text: shown, ...(images.length ? { images } : {}) });
      return items;
    }
    if (row.role === 'assistant') {
      const reasoning = String(row.reasoning_content || row.reasoning || '').trim();
      if (reasoning) push('-r', 2, { type: 'reasoning', text: reasoning });
      const { text } = contentText(row.content);
      if (text.trim()) push('', 3, { type: 'agentMessage', text: text.trim() });
      const calls = parseJson(row.tool_calls, []) || [];
      calls.slice(0, 8).forEach((call, index) => {
        const callId = String(call?.id || call?.call_id || `${rowId}-${index}`);
        const name = call?.function?.name || call?.name || 'tool';
        const args = parseJson(call?.function?.arguments, {}) || {};
        const kind = toolKind(name, args);
        const item = { id: `${threadId}-c-${callId}`, order: rowId * SLOTS + 4 + index, at, value: { type: kind.type, text: kind.text, status: 'inProgress', createdAt: at, tool: name, callId } };
        meta.pendingCalls ||= {};
        meta.pendingCalls[callId] = { id: item.id, order: item.order, at, value: item.value };
        items.push(item);
      });
      const files = await this.hermesMirrorFiles(mediaPaths(text), rowId, meta);
      if (files.length) push('-f', 15, { type: 'sentFiles', tool: 'hermes', status: 'completed', text: '', files });
      return items;
    }
    if (row.role === 'tool') {
      const callId = String(row.tool_call_id || '');
      const pending = meta.pendingCalls?.[callId];
      const result = unwrapToolResult(row.content);
      if (pending) {
        const value = {
          ...pending.value,
          ...(result ? { text: `${pending.value.text}\n\n${clip(result, 8 * 1024).text}` } : {}),
          status: toolFailed(result) ? 'failed' : 'completed',
        };
        items.push({ id: pending.id, order: pending.order, at, value });
        delete meta.pendingCalls[callId];
      }
      const files = await this.hermesMirrorFiles(mediaPaths(result, { documents: false }), rowId, meta);
      if (files.length) push('-f', 15, { type: 'sentFiles', tool: 'hermes', status: 'completed', text: '', files });
      return items;
    }
    return items;
  },

  // Copy files Hermes produced on its host into the connector's cache, so the
  // phone fetches them with the ordinary file.read from this computer. A
  // screenshot path is overwritten by the next screenshot; copying when the
  // message is first seen keeps each message's own picture.
  async hermesMirrorFiles(paths, rowId, meta) {
    const files = [];
    if (!paths.length) return files;
    fs.mkdirSync(this.hermesFilesDir, { recursive: true });
    for (const remote of paths) {
      const name = path.posix.basename(remote);
      const local = path.join(this.hermesFilesDir, `${rowId}-${crypto.createHash('sha256').update(remote).digest('hex').slice(0, 8)}-${name.replace(/[^\w.\-一-龥]/g, '_')}`);
      try {
        if (!fs.existsSync(local)) {
          const bytes = await this.hermesTransport.readFile(remote, FILE_MAX_BYTES);
          if (!bytes.length) continue;
          fs.writeFileSync(local, bytes);
        }
        // A reply that repeats the path of a picture already shown in this
        // conversation does not show it a second time.
        const digest = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex').slice(0, 16);
        if (meta) {
          if (!meta.shownFiles || Array.isArray(meta.shownFiles)) meta.shownFiles = {};
          const firstRow = meta.shownFiles[digest];
          if (firstRow !== undefined && firstRow !== rowId) { try { fs.rmSync(local); } catch {} continue; }
          meta.shownFiles[digest] = rowId;
          const keys = Object.keys(meta.shownFiles);
          if (keys.length > 200) delete meta.shownFiles[keys[0]];
        }
        const size = fs.statSync(local).size;
        files.push({ path: local, name, kind: fileKind(name), size, remotePath: remote });
      } catch { /* gone or too large: the text still names the path */ }
    }
    return files;
  },

  // The phone drops items of type "hidden", which is how a finished live row
  // disappears once the stored reply replaces it.
  // Pictures the user sent, read back from the Hermes host as data URIs.
  async hermesUserImages(paths) {
    const images = [];
    for (const remote of paths.slice(0, MAX_USER_IMAGES)) {
      const mimeType = IMAGE_MIME[path.posix.extname(remote).slice(1).toLowerCase()];
      if (!mimeType) continue;
      try {
        const bytes = await this.hermesTransport.readFile(remote, MAX_USER_IMAGE_BYTES);
        if (bytes.length) images.push({ data: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType });
      } catch { /* gone from the cache or too large: the words still show */ }
    }
    return images;
  },

  hermesLiveItem(threadId, meta, text, hidden = false) {
    const order = (Number(meta.syncedMessageId) || 0) * SLOTS + LIVE_SLOT;
    return { id: `${threadId}-live`, order, at: Date.now(), value: { type: hidden ? 'hidden' : 'agentMessage', text, status: hidden ? null : 'inProgress', createdAt: Date.now(), ...(hidden ? {} : { live: true }) } };
  },

  onHermesUpdate(sessionId, update) {
    const run = this.hermesRunning?.get(sessionId);
    if (!run) return;
    const kind = update?.sessionUpdate;
    if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
      run.text += String(update.content.text || '');
      run.allText = (run.allText || '') + String(update.content.text || '');
      this.flushHermesLive(sessionId).catch((error) => this.log(error));
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      // Tool rows are stored as they happen; pull them now. Text before a tool
      // call is part of the stored assistant row, so the live text restarts.
      run.text = ''; run.flushedText = ''; run.liveClosed = false;
      this.nudgeHermes([300, 1500]);
    } else if (kind === 'session_info_update' && update.title) {
      this.nudgeHermes([300]);
    }
  },

  async flushHermesLive(sessionId, force = false) {
    const run = this.hermesRunning.get(sessionId);
    const id = threadIdOf(sessionId);
    const meta = this.hermesThreads.get(id);
    if (!run || !meta) return;
    const now = Date.now();
    if (!force && now - (run.lastFlushAt || 0) < LIVE_FLUSH_MS) {
      if (!run.flushTimer) run.flushTimer = setTimeout(() => { run.flushTimer = null; this.flushHermesLive(sessionId, true).catch((error) => this.log(error)); }, LIVE_FLUSH_MS);
      return;
    }
    // Uploads of the live row run one after another, so a late text update
    // can never land after the row was hidden.
    await this.queueHermesLive(id, async () => {
      if (run.liveClosed || !run.text.trim() || run.text === run.flushedText) return;
      run.lastFlushAt = Date.now(); run.flushedText = run.text;
      meta.liveShown = true;
      await this.uploadHermesItems(id, [this.hermesLiveItem(id, meta, run.text)]);
      this.emit('history.updated', id, { threadId: id, itemCount: 1, updatedAt: now, backend: 'hermes', live: true });
    });
  },

  queueHermesLive(id, task) {
    this._hermesLiveChains ||= new Map();
    const next = (this._hermesLiveChains.get(id) || Promise.resolve()).then(task, task);
    const settled = next.catch((error) => this.log(error));
    this._hermesLiveChains.set(id, settled);
    settled.finally(() => { if (this._hermesLiveChains.get(id) === settled) this._hermesLiveChains.delete(id); });
    return settled;
  },

  async hideHermesLive(id, meta) {
    const run = this.hermesRunning?.get(meta.sessionId);
    if (run) { run.liveClosed = true; run.text = ''; run.flushedText = ''; }
    await this.queueHermesLive(id, async () => {
      if (!meta.liveShown) return;
      meta.liveShown = false;
      await this.uploadHermesItems(id, [this.hermesLiveItem(id, meta, '', true)]);
    });
  },

  onHermesAcpExit(error) {
    // A running phone turn's outcome is now unknown; Hermes keeps executing
    // gateway-side, so the next poll shows what really happened.
    for (const [sessionId] of this.hermesRunning || []) {
      const meta = this.hermesThreads.get(threadIdOf(sessionId));
      if (meta) meta.waiting = null;
    }
    this.hermesRunning?.clear();
    this.hermesPermissions?.clear();
    if (!this.stopping) this.log(error);
    this.nudgeHermes([1000]);
  },

  async onHermesPermission(rpcId, params) {
    const sessionId = params.sessionId;
    const id = threadIdOf(sessionId);
    const meta = this.hermesThreads.get(id);
    const options = (Array.isArray(params.options) ? params.options : []).map((option) => ({
      optionId: String(option.optionId || ''), label: permissionLabel(option), kind: String(option.kind || ''),
    })).filter((option) => option.optionId);
    if (!meta || !options.length) {
      // Nothing to show it on: refuse rather than leave Hermes waiting.
      const reject = options.find((option) => /reject/.test(option.kind));
      if (reject) this.hermesAcp.respond(rpcId, { outcome: { outcome: 'selected', optionId: reject.optionId } });
      else this.hermesAcp.respond(rpcId, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const call = params.toolCall || {};
    const detail = [call.title, ...(Array.isArray(call.content) ? call.content.map((block) => block?.content?.text || '').filter(Boolean) : [])]
      .filter(Boolean).join('\n').slice(0, 2000);
    const requestId = `perm:${rpcId}`;
    this.hermesPermissions.set(requestId, { rpcId, sessionId, options });
    meta.waiting = {
      kind: 'question', tool: 'approval', requestId, summary: `Hermes 请求授权：${call.title || '操作'}`, description: detail,
      questions: [{ id: 'approval', question: detail || 'Hermes 请求授权', header: '授权', multiSelect: false,
        options: options.map((option) => ({ label: option.label, description: '' })) }],
    };
    await this.uploadHermesIndex(id, meta, true);
    this.saveHermesThreads();
    this.announceHermesStatus(id, meta);
    this.emit('threads.updated', null, { updatedAt: Date.now() });
  },

  async answerHermesPermission(id, meta, args) {
    const requestId = meta?.waiting?.requestId;
    const pending = requestId ? this.hermesPermissions.get(requestId) : null;
    if (!pending) return { ok: false, error: '这个授权已经处理过了' };
    const label = String((Array.isArray(args.answers) ? args.answers[0]?.labels?.[0] : '') || args.option || '').trim();
    const option = pending.options.find((item) => item.label === label) || pending.options.find((item) => item.optionId === label);
    if (!option) throw new Error('请选择一个选项');
    this.hermesAcp.respond(pending.rpcId, { outcome: { outcome: 'selected', optionId: option.optionId } });
    this.hermesPermissions.delete(requestId);
    meta.waiting = null;
    await this.uploadHermesIndex(id, meta, true);
    this.saveHermesThreads();
    this.announceHermesStatus(id, meta);
    return { ok: true, continued: true, backend: 'hermes' };
  },

  hermesActiveThreadRows() {
    const rows = [];
    for (const [threadId, meta] of this.hermesThreads || []) {
      if (meta.archived || !(meta.running || meta.waiting)) continue;
      rows.push({ threadId, status: meta.waiting ? 'desktop_waiting' : 'desktop_running', updatedAt: meta.announcedAt || meta.updatedAt || Date.now() });
    }
    return rows;
  },

  nudgeHermes(delays = [800, 2500, 6000]) { for (const wait of delays) setTimeout(() => this.pollHermes().catch((error) => this.log(error)), wait).unref?.(); },

  watchHermesTurn(sessionId) {
    const id = threadIdOf(sessionId);
    const tick = async () => {
      if (this.stopping || !this.hermesRunning.has(sessionId)) return;
      await this.pollHermes(id).catch((error) => this.log(error));
      setTimeout(tick, ACTIVE_POLL_MS).unref?.();
    };
    setTimeout(tick, 600).unref?.();
  },

  async hermesPromptBlocks(args) {
    const parts = typeof this.claudeAttachmentParts === 'function' ? this.claudeAttachmentParts(args) : { text: String(args.text || ''), images: [] };
    const blocks = [];
    let text = parts.text || '';
    // Non-image files are copied onto the Hermes host so its tools can open them.
    const notes = [];
    for (const item of (typeof this.resolveAttachments === 'function' ? this.resolveAttachments(args.threadId, args.attachments) : []) || []) {
      if (!item?.path || (parts.imagePaths || []).includes(item.path)) continue;
      try {
        const bytes = fs.readFileSync(item.path);
        const name = String(item.name || path.basename(item.path)).replace(/[^\w.\-一-龥]/g, '_');
        const remote = await this.hermesTransport.writeFile(`/tmp/khlink-uploads/${Date.now()}-${name}`, bytes);
        notes.push(`[附件] ${item.name || name}\n路径：${remote}`);
      } catch (error) { this.log(error); }
    }
    if (notes.length) text = [String(args.text || '').trim(), ...notes].filter(Boolean).join('\n\n');
    if (text.trim()) blocks.push({ type: 'text', text });
    for (const image of parts.images || []) blocks.push({ type: 'image', mimeType: image.mediaType || 'image/png', data: image.data });
    return blocks;
  },

  // Run one phone turn. Returns once Hermes accepted it; the turn itself
  // continues in the background and is followed through the session store.
  async startHermesTurn(id, meta, blocks) {
    const sessionId = meta.sessionId;
    await this.hermesAcp.attach(sessionId, meta.cwd || this.hermesHomeDir || '/');
    const run = { startedAt: Date.now(), text: '', flushedText: '', lastFlushAt: 0, syncedAtStart: Number(meta.syncedMessageId) || 0,
      promptText: blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim() };
    run.allText = '';
    this.hermesRunning.set(sessionId, run);
    meta.running = true; meta.terminalStatus = null; meta.activityAt = Date.now();
    this.announceHermesStatus(id, meta);
    // Hermes stores a command's effect (a goal's turns, a MoA answer), not the
    // command itself: keep the "/goal …" line as the user's row, placed before
    // whatever Hermes stores next. Up to 19 commands fit after one stored
    // message; older ones in the same gap are overwritten by order.
    const command = /^\/[a-z]/i.test(run.promptText);
    if (command) {
      const arg = run.promptText.replace(/^\/\S+\s*/, '').trim();
      if (arg && !/^(status|pause|resume|clear|stop|list|show|stats|boards)\b/i.test(arg)) {
        meta.commandArgs = [...(meta.commandArgs || []), arg].slice(-10);
      }
      const base = run.syncedAtStart * SLOTS + LOCAL_SLOT;
      const used = meta.localSlots?.base === base ? meta.localSlots.count : 0;
      meta.localSlots = { base, count: (used + 1) % 19 };
      run.localOrder = base + used * 2;
      const row = { id: `${id}-local-${run.startedAt}-u`, order: run.localOrder, at: run.startedAt,
        value: { type: 'userMessage', text: run.promptText, status: null, createdAt: run.startedAt } };
      await this.uploadHermesItems(id, [row]).catch((error) => this.log(error));
      // The phone's waiting copy of this message is settled by this row.
      this.reconcileSendReceipts?.('hermes', id, [row]);
      this.emit('history.updated', id, { threadId: id, itemCount: 1, updatedAt: run.startedAt, backend: 'hermes' });
    }
    const promise = this.hermesAcp.prompt(sessionId, blocks);
    promise.then((result) => {
      meta.terminalStatus = result?.stopReason === 'cancelled' ? 'interrupted' : result?.stopReason === 'refusal' ? 'failed' : 'completed';
    }, (error) => {
      meta.terminalStatus = 'failed';
      this.log(new Error(`hermes turn ${sessionId}: ${error.message}`));
      meta.lastError = error.message;
    }).finally(async () => {
      if (run.flushTimer) clearTimeout(run.flushTimer);
      this.hermesRunning.delete(sessionId);
      meta.running = false; meta.waiting = null;
      await this.pollHermes(id).catch((error) => this.log(error));
      // Whatever stayed live leaves with the turn, before the phone is told
      // to read again (so it never shows the live copy beside the final one).
      await this.hideHermesLive(id, meta);
      // A command's own answer ("Goal set…", a status report) is not stored
      // by Hermes; keep it after the command unless a stored reply says the same.
      const reply = run.allText.trim();
      if (command && reply) {
        const stored = await this.hermesTransport.store('messages', sessionId, String(run.syncedAtStart), '60').catch(() => null);
        const repeated = (stored?.messages || []).some((row) => row.role === 'assistant' && contentText(row.content).text.trim() === reply);
        if (stored && !repeated) {
          const at = Date.now();
          await this.queueHermesLive(id, async () => {
            await this.uploadHermesItems(id, [{ id: `${id}-local-${run.startedAt}`, order: run.localOrder + 1, at, value: { type: 'agentMessage', text: reply, status: null, createdAt: at } }]);
          });
        }
      }
      // One last read for the phone: the live row may have been uploaded
      // (and hidden) after its previous read.
      this.emit('history.updated', id, { threadId: id, itemCount: 1, updatedAt: Date.now(), backend: 'hermes' });
      this.announceHermesStatus(id, meta);
      this.saveHermesThreads();
    });
    this.watchHermesTurn(sessionId);
    return promise;
  },

  async hermesCommand(payload) {
    const args = payload.args || {};
    const id = args.threadId;
    const meta = id ? this.hermesThreads.get(id) : null;
    const action = payload.action || '';
    if (!this.hermesOnline && (BACKGROUND_READ.test(action) || action === 'history.sync')) {
      if (action === 'followup.list') return { items: [] };
      return { backend: 'hermes', offline: true };
    }
    switch (action) {
      case 'history.sync': {
        await this.pollHermes(id || null);
        return { synced: true, threadId: id, backend: 'hermes' };
      }
      case 'thread.new':
      case 'thread.newWithTurn': {
        // Hermes runs on Linux: a Windows folder from the phone's recent list
        // (or "~") means the Linux home directory.
        const asked = String(args.cwd || '').trim();
        const cwd = asked.startsWith('/') ? asked : asked.startsWith('~/') ? `${await this.hermesDefaultCwd()}/${asked.slice(2)}` : await this.hermesDefaultCwd();
        let created;
        try { created = await this.hermesAcp.newSession(cwd); }
        catch (error) { throw Object.assign(new Error(`${HERMES_OFFLINE}（${error.message}）`), { delivery: 'not_sent' }); }
        const sessionId = created?.sessionId;
        if (!sessionId) throw new Error('Hermes 没有返回新会话');
        const newId = threadIdOf(sessionId);
        const newMeta = { sessionId, cwd, syncedMessageId: 0, pendingCalls: {}, title: '', updatedAt: Date.now(), itemsSchema: ITEMS_SCHEMA, origin: 'phone', source: 'acp' };
        this.hermesThreads.set(newId, newMeta);
        await this.uploadHermesIndex(newId, newMeta, true);
        newMeta.indexed = true;
        this.saveHermesThreads();
        if (args.model) await this.hermesAcp.setModel(sessionId, String(args.model)).catch((error) => this.log(error));
        if (String(args.text || '').trim() || args.attachments?.length) {
          const blocks = await this.hermesPromptBlocks(args);
          this.startHermesTurn(newId, newMeta, blocks).catch(() => {});
        }
        this.emit('threads.updated', null, { updatedAt: Date.now() });
        return { thread: { id: newId }, threadId: newId, backend: 'hermes' };
      }
      case 'turn.start':
      case 'followup.enqueue':
      case 'turn.steer': {
        if (!meta) throw Object.assign(new Error('没有找到这个 Hermes 会话'), { delivery: 'not_sent' });
        const busy = this.hermesRunning.has(meta.sessionId);
        let blocks = await this.hermesPromptBlocks(args);
        if (!blocks.length) throw Object.assign(new Error('消息是空的'), { delivery: 'not_sent' });
        if (busy) {
          if (blocks.some((block) => block.type === 'image')) {
            const { sendRunningImage } = require('./hermes-running-image');
            const result = await sendRunningImage(this.hermesAcp, meta.sessionId, blocks, { action, mode: args.mode });
            this.nudgeHermes([800, 3000]);
            return result;
          }
          // One ACP prompt at a time per session: a second message steers the
          // running turn or queues behind it with Hermes' own commands.
          const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
          // A Hermes command (/goal, /loop, /kanban …) is dispatched by the
          // gateway even while a turn runs, so it goes as it is.
          const command = /^\/[a-z]/i.test(text.trim());
          const verb = command ? '' : action === 'turn.steer' || args.mode === 'steer' ? '/steer' : '/queue';
          await this.hermesAcp.prompt(meta.sessionId, [{ type: 'text', text: verb ? `${verb} ${text}` : text.trim() }]);
          this.nudgeHermes([800, 3000]);
          return { accepted: true, queued: verb === '/queue', steered: verb === '/steer', backend: 'hermes' };
        }
        try { await this.hermesAcp.attach(meta.sessionId, meta.cwd || await this.hermesDefaultCwd()); }
        catch (error) { throw Object.assign(new Error(`${HERMES_OFFLINE}（${error.message}）`), { delivery: 'not_sent' }); }
        this.startHermesTurn(id, meta, blocks).catch(() => {});
        return { accepted: true, queued: false, backend: 'hermes' };
      }
      case 'turn.stop': {
        if (!meta) throw new Error('没有找到这个 Hermes 会话');
        if (!this.hermesRunning.has(meta.sessionId)) {
          await this.hermesAcp.attach(meta.sessionId, meta.cwd || '/').catch(() => {});
        }
        await this.hermesAcp.cancel(meta.sessionId);
        this.nudgeHermes();
        return { stopped: true, backend: 'hermes' };
      }
      case 'thread.rename': {
        if (!meta) throw new Error('没有找到这个 Hermes 会话');
        const title = String(args.title || args.name || '').trim();
        if (!title) throw new Error('标题不能为空');
        const result = await this.hermesTransport.hermes(['sessions', 'rename', meta.sessionId, title], { timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(`改名失败：${result.stderr.trim().slice(0, 200)}`);
        meta.title = title;
        await this.uploadHermesIndex(id, meta, true);
        this.saveHermesThreads();
        return { renamed: true, title, backend: 'hermes' };
      }
      case 'thread.pin': {
        if (!meta) throw new Error('没有找到这个 Hermes 会话');
        const result = await this.hermesTransport.hermes(['sessions', args.pinned ? 'pin' : 'unpin', meta.sessionId], { timeoutMs: 60_000 });
        if (result.code !== 0) throw new Error(`置顶失败：${result.stderr.trim().slice(0, 200)}`);
        meta.pinned = Boolean(args.pinned);
        await this.uploadHermesIndex(id, meta, true);
        this.saveHermesThreads();
        this.emit('threads.updated', null, { updatedAt: Date.now() });
        return { pinned: meta.pinned, pinOrder: meta.pinned ? 0 : -1, backend: 'hermes' };
      }
      case 'thread.archive': {
        if (!meta) throw new Error('没有找到这个 Hermes 会话');
        // Hermes has no single-session archive verb; khLink keeps its own flag.
        meta.archived = Boolean(args.archived);
        meta.localArchive = meta.archived;
        await this.uploadHermesIndex(id, meta, true);
        this.saveHermesThreads();
        this.emit('threads.updated', null, { updatedAt: Date.now() });
        return { archived: meta.archived, backend: 'hermes' };
      }
      case 'settings.get':
      case 'thread.settings.read': {
        if (meta) await this.hermesAcp.attach(meta.sessionId, meta.cwd || await this.hermesDefaultCwd()).catch(() => {});
        else if (!this.hermesAcp.models) await this.hermesAcp.start().catch(() => null);
        const models = this.hermesAcp.models;
        const current = (meta && (meta.modelId || this.hermesAcp.sessionModels.get(meta.sessionId))) || models?.currentModelId || '';
        return { backend: 'hermes', settings: { model: hermesModelKey(current) }, catalog: hermesCatalog(models, current) };
      }
      case 'settings.set': {
        if (!meta) throw new Error('没有找到这个 Hermes 会话');
        const settings = args.settings || args;
        const modelId = hermesModelId(String(settings.model || '').trim());
        if (!modelId) throw new Error('请选择一个模型');
        await this.hermesAcp.attach(meta.sessionId, meta.cwd || await this.hermesDefaultCwd());
        await this.hermesAcp.setModel(meta.sessionId, modelId);
        meta.modelId = modelId;
        this.hermesAcp.sessionModels.set(meta.sessionId, modelId);
        this.saveHermesThreads();
        const key = hermesModelKey(modelId);
        this.emit('thread.settings', id, { threadId: id, settings: { model: key }, updatedAt: Date.now(), source: 'hermes' });
        return { saved: true, backend: 'hermes', model: key, reason: modelId.startsWith('moa:') ? '已切换到专家会诊，下一条消息起生效' : '模型已切换，下一条消息起生效' };
      }
      case 'claude.desktop.answer':
      case 'hermes.answer':
        return this.answerHermesPermission(id, meta, args);
      case 'followup.list': return { items: [] };
      default:
        if (BACKGROUND_READ.test(action)) return { backend: 'hermes' };
        throw new Error(`Hermes 暂不支持这个操作：${action}`);
    }
  },

  async hermesDefaultCwd() {
    if (this.hermesHomeDir) return this.hermesHomeDir;
    try {
      const result = await this.hermesTransport.run('printf %s "$HOME"', { timeoutMs: 20_000 });
      const home = result.stdout.toString('utf8').trim();
      if (home.startsWith('/')) this.hermesHomeDir = home;
    } catch { /* fall back below */ }
    return this.hermesHomeDir || '/';
  },
};

function install(Connector) { Object.assign(Connector.prototype, methods); }

module.exports = { install, methods, imageInput, hermesModelKey, hermesModelId, hermesCatalog, toolKind, mediaPaths, contentText, unwrapToolResult, threadIdOf, sessionIdOf, HERMES_OFFLINE };
