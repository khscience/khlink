// Pi Coding Agent through the local PI WEB server (see pi-web.js): mirrors its
// sessions to the phone and turns phone commands into PI WEB calls, so the
// phone and the PI WEB page drive the same live sessions.
// Installed onto Connector.prototype by install().

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-file');
const { SendReceipts } = require('../send-receipts');
const { publicAttachments } = require('../attachment-privacy');
const { encryptJson } = require('../crypto');
const { clip } = require('../history');
const { PiWebClient, messageItems, readPiSessionMessages } = require('./pi-web');

const POLL_MS = 5_000;
const WORKSPACES_REFRESH_MS = 60_000;
// Every workspace is listed through PI WEB this often; in between only those
// whose session files changed, or that have a live session. Listing all of
// them every tick (about 500 requests a minute) slowed PI WEB enough that it
// looked offline.
const FULL_SCAN_MS = 60_000;
// Sessions touched this recently get their live status polled.
const ACTIVE_WINDOW_MS = 3 * 60_000;
const FIRST_SYNC_MESSAGES = 300;
// Bump when messageItems() changes what it produces, to re-upload once.
const ITEMS_SCHEMA = 5;   // 5: stable source ids/timestamps for completed-turn usage, including cached branches
const UPLOAD_BATCH = 100;
const UPLOAD_BATCH_BYTES = 1_500_000;
const PI_OFFLINE = 'PI WEB 没有运行。可以在手机上点「启动 PI WEB」，或在电脑上打开它。';
// PI WEB not answering: start it (no browser window), at most this often.
const AUTO_START_EVERY_MS = 3 * 60_000;
const PI_STARTING_MS = 3 * 60_000;
const PI_STARTING = 'PI WEB 正在启动，大约需要一分钟，请稍后再试。';
const PI_BUSY = 'PI WEB 正在运行，但暂时没有响应，请稍后再试。';
// Reads the phone sends by itself for every thread (settings, capabilities, ...).
const BACKGROUND_READ = /(\.read|\.get|\.list|capabilities|usage)$/;
// Pi's model catalog changes only when providers are edited.
const MODEL_CACHE_MS = 10 * 60_000;
// Thinking levels as the phone's Pi settings name them (Chinese, like the rest of the phone).
const PI_THINKING_LABELS = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
function piThinkingLabel(level) { return PI_THINKING_LABELS[level] || (level ? String(level) : '未知'); }

function isRunningStatus(status) { return Boolean(status?.isStreaming || status?.isCompacting || status?.isBashRunning); }

// What PI WEB is waiting for the user to answer, in the phone's "等你处理"
// card shape (the same one Claude's desktop prompts use).
function piWaiting(status) {
  const ask = status?.pendingAsk;
  if (ask?.askId && Array.isArray(ask.questions)) {
    const questions = ask.questions.map((question) => ({
      question: String(question.question || ''), header: '', multiSelect: Boolean(question.multiple),
      options: (question.options || []).map((option) => ({ label: String(option.label || option.value || ''), description: String(option.detail || '') })),
    }));
    return { kind: 'question', tool: 'ask_user', requestId: `ask:${ask.askId}`, summary: questions[0]?.question || 'Pi 在问你', description: '', questions };
  }
  const dialog = Array.isArray(status?.pendingDialogs) ? status.pendingDialogs[0] : null;
  if (dialog?.dialogId) {
    const title = String(dialog.title || dialog.message || 'Pi 需要你确认');
    if (dialog.kind === 'confirm') return { kind: 'permission', tool: title, requestId: `dialog:${dialog.dialogId}`, summary: String(dialog.message || title), description: '', questions: [] };
    return { kind: 'question', tool: 'dialog', requestId: `dialog:${dialog.dialogId}`, summary: title, description: '',
      questions: [{ question: title, header: '', multiSelect: false, options: (dialog.options || []).map((option) => ({ label: String(option), description: '' })) }] };
  }
  return null;
}

const methods = {
  startPiSync() {
    if (this._piTimer || !this.config?.configFile) return;
    this.pi = new PiWebClient(this.config.piWeb || {});
    this.piFile = path.join(path.dirname(this.config.configFile), 'pi-threads.json');
    this.piThreads = this.readPiThreads();
    console.log(`[fengzhu-connect] pi sync on (${this.piThreads.size} known)`);
    this._piTimer = setInterval(() => this.pollPi().catch((error) => this.log(error)), POLL_MS);
    this._piTimer.unref?.();
    this.pollPi().catch((error) => this.log(error));
  },

  readPiThreads() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(this.piFile, 'utf8')))); } catch { return new Map(); }
  },

  savePiThreads() {
    try { writeFileAtomic(this.piFile, JSON.stringify(Object.fromEntries(this.piThreads))); } catch (error) { this.log(error); }
  },

  piIndexValue(id, meta) {
    return {
      id, title: meta.name || String(meta.firstMessage || '').slice(0, 40) || 'Pi 会话', cwd: meta.cwd || '',
      status: this.piThreadStatus(meta), updatedAt: meta.updatedAt || Date.now(), activityAt: meta.activityAt ?? meta.updatedAt ?? 0,
      note: meta.waiting?.summary || '', waiting: meta.waiting || null,
      backend: 'pi', archived: Boolean(meta.archived), pinned: false, pinOrder: -1,
      unread: Boolean(meta.unread) && !meta.running, origin: 'desktop', model: meta.model || '',
    };
  },

  piThreadStatus(meta) {
    return meta.waiting ? 'desktop_waiting' : meta.running ? 'desktop_running' : meta.terminalStatus || 'completed';
  },

  async uploadPiIndex(id, meta) {
    const value = this.piIndexValue(id, meta);
    const encrypted = encryptJson(this.config.accountKey, 'history.thread', id, id, value);
    await this.api.request(this.api.path('/history/threads'), { method: 'PUT', body: { id, archived: value.archived, updatedAt: value.updatedAt, ...encrypted } });
  },

  async uploadPiItems(id, items) {
    let batch = []; let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.putHistoryItems(id, batch);
      batch = []; bytes = 0;
    };
    for (const item of items) {
      const value = { ...item.value, ...clip(item.value.text || '', 32 * 1024) };
      const row = { id: item.id, order: item.order, createdAt: item.at || Date.now(), ...await this.historyItemFrame(id, item.id, value) };
      const size = row.ciphertext.length + 200;
      if (batch.length >= UPLOAD_BATCH || (batch.length && bytes + size > UPLOAD_BATCH_BYTES)) await flush();
      batch.push(row); bytes += size;
    }
    await flush();
  },

  // `forceId`: also re-read this one session now (the phone opened it). The
  // live status of other sessions is read only while they are recently
  // active: reading it makes PI WEB load the session into memory.
  async pollPi(forceId = null) {
    if (this._piPolling || this.stopping || !this.config.accountKey) return;
    this._piPolling = true;
    try {
      const state = typeof this.pi.probe === 'function' ? await this.pi.probe() : ((await this.pi.alive()) ? 'up' : 'down');
      if (state !== 'up') {
        this.piOnline = false;
        // Running but slow: another launcher would only pile up more servers.
        if (state === 'busy') return;
        // Only once PI WEB has been seen here (it is installed and used), and
        // unless turned off with piWeb.autoStart = false in the config.
        if (this.config.piWeb?.autoStart !== false && (this.piThreads.size || this._piEverOnline) && Date.now() - (this._piStartedAt || 0) > AUTO_START_EVERY_MS) {
          this._piStartedAt = Date.now();
          try { this.pi.start(); console.log('[fengzhu-connect] PI WEB not running; started it'); } catch (error) { this.log(error); }
        }
        return;
      }
      this._piEverOnline = true;
      this.piOnline = true;
      if (!this._piWorkspaces || Date.now() - (this._piWorkspacesAt || 0) > WORKSPACES_REFRESH_MS) {
        this._piWorkspaces = await this.pi.workspaces(); this._piWorkspacesAt = Date.now();
      }
      let unread = new Set();
      try { unread = new Set(((await this.pi.unread())?.sessions || []).map((row) => row.sessionId)); } catch { /* optional */ }
      const seenCwds = new Set();
      let changed = false;
      const files = this.piSessionFileSignatures();
      const unreadKey = [...unread].sort().join(',');
      const full = !files || Date.now() - (this._piFullScanAt || 0) > FULL_SCAN_MS ||
        files.dirs !== this._piFileSig?.dirs || unreadKey !== this._piUnreadKey;
      if (full) this._piFullScanAt = Date.now();
      this._piUnreadKey = unreadKey;
      const previousSig = this._piFileSig; this._piFileSig = files;
      const hot = new Set([...this.piThreads.values()]
        .filter((meta) => meta.cwd && (meta.running || meta.waiting || Date.now() - (meta.updatedAt || 0) < ACTIVE_WINDOW_MS))
        .map((meta) => String(meta.cwd).toLowerCase()));
      // The session asked for (opened on the phone, or a turn being followed).
      if (forceId && this.piThreads.get(forceId)?.cwd) hot.add(String(this.piThreads.get(forceId).cwd).toLowerCase());
      // PI WEB's workspaces, plus folders of sessions started from the phone
      // outside them (PI WEB runs those too but does not list the folder).
      const extra = [...this.piThreads.values()].filter((meta) => meta.cwd).map((meta) => ({ cwd: meta.cwd, projectId: meta.projectId || null }));
      for (const workspace of [...this._piWorkspaces, ...extra]) {
        const key = String(workspace.cwd || '').toLowerCase();
        if (!workspace.cwd || seenCwds.has(key)) continue;
        seenCwds.add(key);
        const dir = this._piDirByCwd?.get(key);
        if (!full && !hot.has(key) && (!dir || files.byDir.get(dir) === previousSig?.byDir.get(dir))) continue;
        let sessions = [];
        try { sessions = await this.pi.sessions(workspace.cwd); } catch { continue; }
        // Which session folder holds this workspace, to notice its changes locally.
        const file = (Array.isArray(sessions) ? sessions : []).find((row) => row.path)?.path;
        if (file) {
          (this._piDirByCwd ||= new Map()).set(key, path.resolve(path.dirname(file)).toLowerCase());
          this._piSessionsRoot ||= path.resolve(path.dirname(path.dirname(file)));
        }
        for (const session of Array.isArray(sessions) ? sessions : []) {
          try { if (await this.syncPiSession(session, workspace, unread.has(session.id), session.id === forceId)) changed = true; }
          catch (error) { this.log(new Error(`pi ${session.id}: ${error.message}`)); }
        }
      }
      if (changed) { this.savePiThreads(); this.emit('threads.updated', null, { updatedAt: Date.now() }); }
    } finally { this._piPolling = false; }
  },

  // Newest modification time per Pi session folder, plus the folder list (a
  // new folder means a session in a workspace not seen before). Read from the
  // local files, so it costs PI WEB nothing. null when the folder is unknown.
  piSessionFileSignatures() {
    const root = this._piSessionsRoot;
    if (!root) return null;
    let names; try { names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return null; }
    const byDir = new Map();
    for (const name of names) {
      const dir = path.join(root, name); let newest = 0; let count = 0;
      try { for (const file of fs.readdirSync(dir)) { count += 1; try { newest = Math.max(newest, fs.statSync(path.join(dir, file)).mtimeMs); } catch {} } } catch {}
      byDir.set(path.resolve(dir).toLowerCase(), `${count}:${newest}`);
    }
    return { dirs: names.sort().join('|'), byDir };
  },

  async syncPiSession(session, workspace, unread, force = false) {
    const id = session.id; if (!id) return false;
    const meta = this.piThreads.get(id) || { syncedCount: 0, itemsSchema: ITEMS_SCHEMA };
    if ((meta.itemsSchema || 1) < ITEMS_SCHEMA) { meta.syncedCount = 0; meta.modifiedAt = null; meta.itemsSchema = ITEMS_SCHEMA; }
    const modifiedAt = Date.parse(session.modified || session.created) || 0;
    const recentlyActive = Date.now() - modifiedAt < ACTIVE_WINDOW_MS || meta.running || meta.waiting;
    let running = Boolean(meta.running); let status = null; let waiting = meta.waiting || null;
    if (recentlyActive || force) {
      try { status = await this.pi.status(id, session.cwd || workspace.cwd); running = isRunningStatus(status); waiting = piWaiting(status); } catch { /* keep */ }
    }
    if (status) this.trackPiQueue(id, meta, status);
    // A running or waiting turn is said again every 15 s, as for Codex and
    // Claude: a phone that (re)connects mid-turn learns it, and gets its stop
    // button. Before, only a change was sent, so a long turn looked finished.
    if (status && (running || waiting) && Date.now() - (meta.announcedAt || 0) > 15_000) {
      meta.announcedStatus = waiting ? 'desktop_waiting' : 'desktop_running'; meta.announcedAt = Date.now();
      this.emit('thread.status', id, { threadId: id, status: meta.announcedStatus, backend: 'pi', updatedAt: Date.now() });
    }
    const waitingChanged = (waiting?.requestId || null) !== (meta.waiting?.requestId || null);
    const count = Number(session.messageCount) || 0;
    const contentChanged = count !== meta.entryCount || meta.modifiedAt !== modifiedAt;
    const labelChanged = meta.name !== session.name || Boolean(meta.unread) !== unread || Boolean(meta.running) !== running;
    const sourceChanged = Boolean(session.path && meta.sessionFile !== session.path);
    if (!contentChanged && !labelChanged && !waitingChanged && !sourceChanged && !force) return false;
    meta.waiting = waiting;
    Object.assign(meta, { cwd: session.cwd || workspace.cwd, name: session.name || '', firstMessage: session.firstMessage || '',
      ...(session.path ? { sessionFile: session.path } : {}),
      updatedAt: modifiedAt || Date.now(), unread, running, projectId: workspace.projectId,
      ...(status?.model ? { model: `${status.model.provider}/${status.model.id}` } : {}) });
    await this.uploadPiIndex(id, meta);
    if (contentChanged) {
      // The session's own file (no loading in PI WEB); PI WEB only when the
      // list gave no path. Only what is new since the last sync, plus the last
      // message (it may still have been streaming); the first time, the recent part.
      let messages = null; let start = 0;
      if (session.path) { try { messages = readPiSessionMessages(session.path); } catch (error) { if (error.code !== 'ENOENT') this.log(error); } }
      if (messages) {
        start = meta.syncedCount ? Math.max(0, meta.syncedCount - 1) : Math.max(0, messages.length - FIRST_SYNC_MESSAGES);
        messages = messages.slice(start);
      } else if (count > (meta.syncedCount || 0)) {
        const fresh = meta.syncedCount ? count - meta.syncedCount + 1 : Math.min(count, FIRST_SYNC_MESSAGES);
        const page = await this.pi.messages(id, meta.cwd, { limit: Math.min(fresh, FIRST_SYNC_MESSAGES) });
        messages = page?.messages || []; start = Number(page?.start) || 0;
      }
      const items = messages ? messageItems(messages, start) : [];
      if (items.length) this.reconcileSendReceipts?.('pi', id, items);
      if (messages) {
        const activityAt = Math.max(meta.activityAt || 0, ...items.map((item) => Number(item.at) || 0));
        const last = messages.at(-1);
        const terminalStatus = last?.role === 'assistant' && last.stopReason === 'error' ? 'failed'
          : last?.role === 'assistant' && last.stopReason === 'aborted' ? 'interrupted' : 'completed';
        if (meta.activityAt !== activityAt || meta.terminalStatus !== terminalStatus) {
          Object.assign(meta, { activityAt, terminalStatus }); await this.uploadPiIndex(id, meta);
        }
      }
      if (items.length) await this.uploadPiItems(id, items);
      if (messages) meta.syncedCount = start + messages.length;
      meta.entryCount = count;
      if (items.length) this.emit('history.updated', id, { threadId: id, itemCount: items.length, updatedAt: Math.max(...items.map((item) => Number(item.at) || 0), 0) || modifiedAt || Date.now(), backend: 'pi' });
    }
    meta.modifiedAt = modifiedAt;
    const liveStatus = this.piThreadStatus(meta);
    if (meta.announcedStatus !== liveStatus) {
      meta.announcedStatus = liveStatus; meta.announcedAt = Date.now();
      this.emit('thread.status', id, { threadId: id, status: liveStatus, backend: 'pi', updatedAt: Date.now() });
    }
    this.piThreads.set(id, meta);
    // Save as we go: a first sync of many sessions takes a while.
    this.savePiThreads();
    return true;
  },

  // Phone uploads: images inline (PI WEB's prompt attachment format), other
  // files referenced by path in the text, as for Claude.
  piAttachmentParts(args) {
    const parts = typeof this.claudeAttachmentParts === 'function' ? this.claudeAttachmentParts(args) : { text: String(args.text || ''), images: [] };
    const images = (parts.images || []).map((image, index) => ({ kind: 'image', mimeType: image.mediaType || 'image/png', data: image.data, name: `image-${index + 1}` }));
    return { text: parts.text || (images.length ? '请看图片' : ''), images };
  },

  notePiStatus(meta, status) {
    if (status?.model) meta.model = `${status.model.provider}/${status.model.id}`;
    if (status?.thinkingLevel) meta.thinkingLevel = status.thinkingLevel;
  },

  // Model and thinking level of a Pi session. PI WEB clamps the level to what a
  // new model supports, and refuses a level the model does not support, so the
  // model is changed first and the level is checked against what the new model
  // offers. Whatever PI ends up running is what the record and the phone keep,
  // and a failure still leaves them showing the real state.
  async setPiSettings(id, cwd, meta, wanted) {
    const modelKeyOf = (value) => (value?.model ? `${value.model.provider}/${value.model.id}` : null);
    const label = piThinkingLabel;
    let status = await this.pi.status(id, cwd, 60_000).catch(() => null);
    let modelChanged = false;
    let unsupported = null;
    let failure = null;
    try {
      if (wanted.model && wanted.model !== (modelKeyOf(status) || meta?.model)) {
        const [provider, ...rest] = wanted.model.split('/');
        status = await this.pi.setModel(id, cwd, provider, rest.join('/'));
        modelChanged = true;
      }
      if (wanted.level && wanted.level !== status?.thinkingLevel) {
        const offered = await this.pi.thinkingLevels(id, cwd).then((value) => (Array.isArray(value?.levels) ? value.levels : null)).catch(() => null);
        if (offered && !offered.includes(wanted.level)) unsupported = true;
        else {
          try { status = await this.pi.setThinking(id, cwd, wanted.level); }
          catch (error) {
            if (!/Invalid thinking level/i.test(String(error?.message || ''))) throw error;
            unsupported = true;
          }
        }
      }
    } catch (error) { failure = error; }
    // After a failure the status is read again: the last answer may predate the change.
    const real = failure ? (await this.pi.status(id, cwd, 60_000).catch(() => null)) || status : status;
    if (meta) {
      this.notePiStatus(meta, real);
      this.savePiThreads();
      await this.uploadPiIndex(id, meta).catch((error) => this.log(error));
    }
    this.nudgePi([500]);
    if (failure) throw failure;
    const actualModel = modelKeyOf(real) || meta?.model || null;
    const actualLevel = real?.thinkingLevel ?? meta?.thinkingLevel ?? null;
    let note = null;
    if (wanted.level && (unsupported || actualLevel !== wanted.level)) {
      const modelName = real?.model?.name || real?.model?.id || '';
      note = `${modelChanged && modelName ? `已切到 ${modelName}；` : ''}这个模型不支持强度「${label(wanted.level)}」，当前为「${label(actualLevel)}」`;
    }
    return { saved: true, backend: 'pi', model: actualModel, effort: actualLevel, thinkingLevel: actualLevel, ...(note ? { note } : {}) };
  },

  // Background: open the session in PI WEB and refresh the model cache.
  warmPiSession(id, meta) {
    this._piWarming ||= new Set();
    if (this._piWarming.has(id)) return;
    this._piWarming.add(id);
    (async () => {
      const status = await this.pi.status(id, meta.cwd, 60_000);
      const before = meta.model;
      this.notePiStatus(meta, status);
      // The phone's header shows the model from the index row.
      if (meta.model !== before) { await this.uploadPiIndex(id, meta); this.savePiThreads(); this.emit('threads.updated', null, { updatedAt: Date.now() }); }
      if (!this.piModelCache || Date.now() - this.piModelCache.at > MODEL_CACHE_MS / 2) {
        const [catalog, levels] = await Promise.all([this.pi.modelCatalog(id, meta.cwd), this.pi.thinkingLevels(id, meta.cwd)]);
        if (catalog?.models?.length) this.piModelCache = { at: Date.now(), catalog, levels };
      }
    })().catch((error) => this.log(error)).finally(() => this._piWarming.delete(id));
  },

  // A turn the phone just started: say "running" at once (a short answer can
  // be done before the next regular look), then follow this one session every
  // second until the turn is over, so the reply shows as it lands.
  // Messages PI WEB holds for after the running turn (sent from the phone with
  // "排队" or typed in PI WEB). The phone lists them as waiting like Codex's and
  // Claude's; before, a queued Pi message vanished from the phone.
  piQueueItem(threadId, entry) {
    return { id: entry.id, requestId: entry.id, threadId, text: entry.text, createdAt: entry.createdAt, state: 'desktop_queued',
      attachments: publicAttachments(entry.attachments), origin: entry.origin || 'desktop', blocking: true, backend: 'pi' };
  },

  piQueueItems(threadId = null) {
    const rows = [];
    for (const [id, meta] of this.piThreads || []) {
      if (threadId && id !== threadId) continue;
      for (const entry of meta.queue || []) rows.push(this.piQueueItem(id, entry));
    }
    return rows;
  },

  // Align the saved queue with PI WEB's: entries keep their ids (matched by
  // text, in order). A disappeared entry may have been cleared in PI WEB;
  // only a new user message in history proves that it actually started.
  trackPiQueue(id, meta, status) {
    if (this._piQueueMutating?.has(id)) return;
    const texts = (Array.isArray(status?.queuedMessages) ? status.queuedMessages : [])
      // PI WEB lists immediate steers before ordinary follow-ups. They may
      // have the same text but different images, so never match a steer to a
      // phone follow-up solely by text.
      .filter((item) => typeof item === 'string' || String(item?.kind || '').toLowerCase() !== 'steer')
      .map((item) => (typeof item === 'string' ? item : String(item?.text || item?.message || '')).trim()).filter(Boolean);
    const before = meta.queue || []; const unused = [...before]; const next = [];
    for (const text of texts) {
      const index = unused.findIndex((entry) => entry.text === text);
      if (index >= 0) { next.push({ ...unused.splice(index, 1)[0], listed: true }); continue; }
      next.push({ id: `pi-q-${crypto.createHash('sha1').update(`${id}|${text}|${Date.now()}|${next.length}`).digest('hex').slice(0, 16)}`, text, createdAt: Date.now(), origin: 'desktop', listed: true });
    }
    // Queued from the phone a moment ago, not yet listed by PI WEB: keep it a little.
    for (const entry of unused) if (entry.origin === 'mobile' && !entry.listed && Date.now() - entry.createdAt < 8_000) next.push(entry);
    const kept = new Set(next.map((entry) => entry.id));
    for (const entry of before) if (!kept.has(entry.id)) {
      this.sendReceipts ||= new SendReceipts();
      let receipt = this.sendReceipts.get(entry.id);
      if (receipt?.historyId || ['started', 'steered', 'cancelled'].includes(receipt?.state)) continue;
      if (!receipt) {
        receipt = this.sendReceipts.begin(entry.id, 'pi', { ...entry, threadId: id });
        this.sendReceipts.update(entry.id, { createdAt: entry.createdAt, origin: entry.origin || 'desktop' });
      }
      this.sendReceipts.update(entry.id, { state: 'dispatching', reason: '消息已离开队列，正在核对对话记录。' });
      // The queue can empty just before the new user message is visible. Do
      // not alarm the phone until we have checked PI WEB's newer history.
      this.confirmPiQueueExit(id, meta, entry).catch((error) => this.log?.(error));
    }
    const had = new Set(before.map((entry) => entry.id));
    for (const entry of next) if (!had.has(entry.id)) this.emit('followup.queued', id, this.piQueueItem(id, entry));
    meta.queue = next;
  },

  async confirmPiQueueExit(id, meta, entry) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.sendReceipts.get(entry.id);
      if (!row || row.state !== 'dispatching' || row.historyId) return;
      if (attempt) await (this._piQueueConfirmationDelay?.() || new Promise((resolve) => setTimeout(resolve, 1000)));
      try {
        const page = await this.pi.messages(id, meta.cwd, { limit: 100 });
        const items = messageItems(page?.messages || [], Number(page?.start) || 0);
        for (const item of this.sendReceipts.reconcile('pi', id, items)) this.emit('followup.started', id, item);
      } catch { /* Pi can be slow or offline; the unresolved receipt remains safe. */ }
    }
    const row = this.sendReceipts.get(entry.id);
    if (!row || row.state !== 'dispatching' || row.historyId) return;
    this.sendReceipts.update(entry.id, { state: 'uncertain', reason: '这条消息已离开 PI WEB 队列，尚未能从对话记录确认；系统不会自动重发。' });
    this.emit('followup.failed', id, { ...this.sendReceipts.item(row), needsConfirmation: true });
  },

  // PI WEB clears the whole queue when removing one entry. Keep every
  // affected request durable and suppress intermediate empty snapshots;
  // partial failure must not silently lose the messages being restored.
  async changePiQueue(id, meta, status, picked, action) {
    const original = [...(meta.queue || [])];
    // PI WEB clears both its steering and follow-up queues at once. It only
    // reports their text, not desktop-created images: rebuilding them would
    // silently lose those images or a pending steer.
    if ((status?.queuedMessages || []).some((entry) => String(entry?.kind || '').toLowerCase() === 'steer') ||
        original.some((entry) => entry.origin === 'desktop')) {
      throw Object.assign(new Error('PI WEB 还有立即发送或电脑端排队的消息，请等其处理后再调整队列。'), { delivery: 'not_sent' });
    }
    const rest = original.filter((entry) => !picked.includes(entry));
    this.sendReceipts ||= new SendReceipts();
    for (const entry of original) {
      if (!this.sendReceipts.get(entry.id)) {
        this.sendReceipts.begin(entry.id, 'pi', { ...entry, threadId: id });
        this.sendReceipts.update(entry.id, { origin: entry.origin || 'desktop', createdAt: entry.createdAt });
      }
      this.sendReceipts.update(entry.id, { state: 'dispatching' });
    }
    this._piQueueMutating ||= new Set(); this._piQueueMutating.add(id);
    let cleared = false; let attempted = [];
    const restored = [];
    try {
      await this.pi.clearQueue(id, meta.cwd); cleared = true;
      if (action === 'followup.cancel') {
        for (const entry of picked) {
          this.sendReceipts.update(entry.id, { state: 'cancelled', reason: null });
          this.emit('followup.cancelled', id, { id: entry.id, threadId: id });
        }
      } else {
        attempted = picked;
        const parts = this.piAttachmentParts({ text: picked.map((entry) => entry.text).join('\n\n'), attachments: picked.flatMap((entry) => entry.attachments || []) });
        await this.pi.prompt(id, meta.cwd, parts.text, isRunningStatus(status) ? 'steer' : undefined, parts.images);
        for (const entry of picked) {
          this.sendReceipts.update(entry.id, { state: 'steered', startedAt: Date.now(), reason: null });
          this.emit('followup.started', id, { ...this.piQueueItem(id, entry), state: 'steered', startedAt: Date.now() });
        }
        attempted = [];
      }
      for (const entry of rest) {
        attempted = [entry];
        const parts = this.piAttachmentParts(entry);
        await this.pi.prompt(id, meta.cwd, parts.text, 'followUp', parts.images);
        this.sendReceipts.update(entry.id, { state: 'desktop_queued', reason: null }); restored.push(entry); attempted = [];
      }
      meta.queue = rest; this.savePiThreads();
    } catch (error) {
      if (!cleared && error.delivery === 'not_sent') {
        for (const entry of original) this.sendReceipts.update(entry.id, { state: 'desktop_queued' });
      } else {
        for (const entry of original) {
          const row = this.sendReceipts.get(entry.id);
          if (['cancelled', 'steered'].includes(row.state) || restored.includes(entry)) continue;
          const uncertain = !cleared || (attempted.includes(entry) && error.delivery !== 'not_sent');
          this.sendReceipts.update(entry.id, { state: uncertain ? 'uncertain' : 'failed',
            reason: uncertain ? '队列调整结果尚未确认，请检查对话；系统不会自动重发。' : '原队列已清空，这条消息尚未重新入队，请复制后重发。' });
          this.emit('followup.failed', id, { ...this.sendReceipts.item(row), needsConfirmation: uncertain });
        }
        meta.queue = restored; this.savePiThreads();
      }
      throw error;
    } finally { this._piQueueMutating.delete(id); }
  },

  // Pi turns in progress, for the connector's live-task snapshot.
  piActiveThreadRows() {
    const rows = [];
    for (const [threadId, meta] of this.piThreads || []) {
      if (meta.archived || !(meta.running || meta.waiting)) continue;
      rows.push({ threadId, status: meta.waiting ? 'desktop_waiting' : 'desktop_running', updatedAt: meta.announcedAt || meta.updatedAt || Date.now() });
    }
    return rows;
  },

  announcePiRunning(id) {
    const meta = this.piThreads.get(id);
    if (!meta || meta.announcedStatus === 'desktop_running') return;
    meta.running = true; meta.announcedStatus = 'desktop_running';
    this.emit('thread.status', id, { threadId: id, status: 'desktop_running', backend: 'pi', updatedAt: Date.now() });
  },

  watchPiTurn(id) {
    this.announcePiRunning(id);
    this._piWatched ||= new Map();
    const startedAt = Date.now();
    if (this._piWatched.has(id)) { this._piWatched.get(id).startedAt = startedAt; return; }
    const watch = { startedAt, idleChecks: 0 };
    this._piWatched.set(id, watch);
    const tick = async () => {
      if (this.stopping) { this._piWatched.delete(id); return; }
      await this.pollPi(id).catch((error) => this.log(error));
      const current = this.piThreads.get(id);
      const active = current?.running || current?.waiting;
      watch.idleChecks = active ? 0 : watch.idleChecks + 1;
      // Over when it has looked idle twice (past the first seconds), or after 15 minutes.
      if ((watch.idleChecks >= 2 && Date.now() - watch.startedAt > 3_000) || Date.now() - watch.startedAt > 15 * 60_000) { this._piWatched.delete(id); return; }
      setTimeout(tick, 1_000).unref?.();
    };
    setTimeout(tick, 600).unref?.();
  },

  // After a phone action, look again soon instead of waiting for the next tick.
  nudgePi(delays = [800, 2500, 6000]) { for (const wait of delays) setTimeout(() => this.pollPi().catch((error) => this.log(error)), wait).unref?.(); },

  async piCommand(payload) {
    const args = payload.args || {}; const id = args.threadId;
    const meta = id ? this.piThreads.get(id) : null;
    const state = typeof this.pi.probe === 'function' ? await this.pi.probe() : ((await this.pi.alive()) ? 'up' : 'down');
    // Reads the phone makes on its own (settings, lists, history) are answered
    // empty rather than failing while PI WEB is down or busy: nobody asked for
    // them, so there is nobody to tell.
    // (pi.* are the phone's Pi screens, opened by the user: those still say why.)
    const action = payload.action || '';
    if (state !== 'up' && !/^pi\./.test(action) && (BACKGROUND_READ.test(action) || action === 'history.sync')) {
      if (action === 'followup.list') return { items: [] };
      return { backend: 'pi', offline: true };
    }
    if (state === 'busy') {
      if (action === 'pi.start') return { running: true, busy: true };
      if (action === 'pi.status') return { running: true, busy: true };
      throw Object.assign(new Error(PI_BUSY), { delivery: 'not_sent' });
    }
    if (state !== 'up') {
      if (payload.action === 'pi.start') { this._piStartedAt = Date.now(); this.pi.start(); this.nudgePi([4000, 8000]); return { starting: true }; }
      if (payload.action === 'pi.status') return { running: false };
      if (payload.action === 'followup.list') return { items: [] };
      // A cold start of PI WEB takes a minute or more.
      throw Object.assign(new Error(Date.now() - (this._piStartedAt || 0) < PI_STARTING_MS ? PI_STARTING : PI_OFFLINE), { delivery: 'not_sent' });
    }
    const cwd = meta?.cwd || args.cwd;
    switch (payload.action) {
      case 'pi.start': return { running: true };
      // Relay providers (base URL, API type, models, prices). The API key is
      // write-only: listing never returns it, and an empty key on edit keeps it.
      case 'pi.providers.list': return { providers: (await this.pi.providers())?.providers || [] };
      case 'pi.providers.save': {
        const input = args.provider || {};
        const models = (Array.isArray(input.models) ? input.models : []).map((model) => {
          const entry = { id: String(model.id || '').trim() };
          const cost = model.cost && typeof model.cost === 'object' ? model.cost : null;
          if (cost) entry.cost = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].filter((key) => Number.isFinite(Number(cost[key])) && cost[key] !== '' && cost[key] !== null).map((key) => [key, Number(cost[key])]));
          if (Number.isInteger(Number(model.contextWindow)) && Number(model.contextWindow) > 0) entry.contextWindow = Number(model.contextWindow);
          if (typeof model.reasoning === 'boolean') entry.reasoning = model.reasoning;
          return entry;
        });
        const body = { name: input.name, baseUrl: input.baseUrl, api: input.api, models, ...(String(input.apiKey || '').trim() ? { apiKey: String(input.apiKey) } : {}) };
        const result = input.revision
          ? await this.pi.updateProvider(input.id, { ...body, revision: input.revision })
          : await this.pi.createProvider({ ...body, id: input.id });
        this.piModelCache = null;
        return { saved: Boolean(result?.saved), providerId: result?.providerId || input.id };
      }
      case 'history.sync': {
        // The phone opened this session: load it in PI WEB now, so its model
        // settings and the next message do not wait for that.
        if (meta) this.warmPiSession(id, meta);
        await this.pollPi(id);
        return { synced: true, threadId: id, backend: 'pi' };
      }
      case 'thread.new':
      case 'thread.newWithTurn': {
        if (!args.cwd) throw new Error('请填写工作目录');
        const created = await this.pi.createSession(args.cwd);
        const newId = created?.id || created?.sessionId || created?.session?.id;
        if (!newId) throw new Error('PI WEB 没有返回新会话');
        this.piThreads.set(newId, { cwd: args.cwd, syncedCount: 0, name: '', updatedAt: Date.now() });
        if (args.model && args.model.includes('/')) { const [provider, ...rest] = args.model.split('/'); await this.pi.setModel(newId, args.cwd, provider, rest.join('/')).catch((error) => this.log(error)); }
        if (hasText(args) || args.attachments?.length) { const { text, images } = this.piAttachmentParts(args); await this.pi.prompt(newId, args.cwd, text, undefined, images); this.watchPiTurn(newId); }
        else this.nudgePi();
        return { thread: { id: newId }, threadId: newId, backend: 'pi' };
      }
      case 'turn.start':
      case 'followup.enqueue':
      case 'turn.steer': {
        if (!meta) throw Object.assign(new Error('没有找到这个 Pi 会话'), { delivery: 'not_sent' });
        // A running badge is published only after PI WEB accepts the prompt.
        const wasRunning = Boolean(meta.running);
        const status = await this.pi.status(id, cwd).catch(() => null);
        const busy = isRunningStatus(status) || (!status && wasRunning);
        // Busy: "排队" waits for the turn to end, "立即发送" steers it now.
        const behavior = busy ? (payload.action === 'turn.steer' || args.mode === 'steer' ? 'steer' : 'followUp') : undefined;
        const { text, images } = this.piAttachmentParts(args);
        // PI WEB ignores a second identical text already in its queue. Keep
        // separate phone requests visible instead of accepting a lost copy.
        if (behavior === 'followUp' && !images.length && (status?.queuedMessages || []).some((entry) => String(typeof entry === 'string' ? entry : entry?.text || '').trim() === String(text).trim())) {
          throw Object.assign(new Error('PI WEB 队列里已有相同消息，请等待它发送或修改内容后再发。'), { delivery: 'not_sent' });
        }
        await this.pi.prompt(id, cwd, text, behavior, images);
        this.watchPiTurn(id);
        if (behavior === 'followUp') {
          const entry = { id: payload.requestId || args.requestId || `pi-q-${crypto.randomUUID()}`, text: String(text || '').trim() || '图片', attachments: args.attachments || [], createdAt: Date.now(), origin: 'mobile' };
          meta.queue = [...(meta.queue || []).filter((item) => item.id !== entry.id), entry];
          this.savePiThreads();
          const item = this.piQueueItem(id, entry);
          this.emit('followup.queued', id, item);
          return { accepted: true, queued: true, item, backend: 'pi' };
        }
        return { accepted: true, queued: false, backend: 'pi' };
      }
      case 'claude.desktop.answer': {
        if (!meta) throw new Error('没有找到这个 Pi 会话');
        const status = await this.pi.status(id, cwd);
        const [kind, ref] = String(args.requestId || '').split(/:(.*)/s);
        if (kind === 'ask') {
          const ask = status?.pendingAsk;
          if (!ask || ask.askId !== ref) return { ok: false, error: '这个问题已经在别处回答过了' };
          const given = Array.isArray(args.answers) ? args.answers : [];
          const answers = ask.questions.map((question, index) => {
            const answer = given[index] || {};
            const labels = Array.isArray(answer.labels) ? answer.labels : [];
            const values = (question.options || []).filter((option) => labels.includes(option.label || option.value)).map((option) => option.value);
            const other = String(answer.other || '').trim();
            return { id: question.id, values, ...(other ? { otherText: other } : {}) };
          });
          await this.pi.submitAsk(id, cwd, ref, { answers });
        } else if (kind === 'dialog') {
          const dialog = (status?.pendingDialogs || []).find((entry) => entry.dialogId === ref);
          if (!dialog) return { ok: false, error: '这个确认已经在别处处理过了' };
          let value;
          if (dialog.kind === 'confirm') value = args.choice === 'allow' || args.choice === 'allow_auto' || args.choice === 'accept';
          else value = String(args.answers?.[0]?.labels?.[0] ?? args.answers?.[0]?.other ?? '');
          await this.pi.answerDialog(id, cwd, ref, value);
        } else return { ok: false, error: '无法识别的提示' };
        this.watchPiTurn(id);
        return { ok: true };
      }
      case 'turn.stop': { await this.pi.abort(id, cwd); this.nudgePi(); return { stopped: true, backend: 'pi' }; }
      case 'thread.archive': {
        await (args.archived ? this.pi.archive(id, cwd) : this.pi.restore(id, cwd));
        if (meta) { meta.archived = Boolean(args.archived); await this.uploadPiIndex(id, meta); this.savePiThreads(); }
        return { archived: Boolean(args.archived), backend: 'pi' };
      }
      // PI WEB can only clear a session's whole queue: to take one message out
      // (or send it now as a steer), clear it and queue the others again, in order.
      case 'followup.cancel':
      case 'followup.steer':
      case 'followup.steer_all': {
        if (!meta) throw new Error('没有找到这个 Pi 会话');
        const status = await this.pi.status(id, cwd).catch(() => null);
        if (!status) throw new Error('暂时无法确认 PI WEB 的队列状态，请稍后再试');
        if (status) this.trackPiQueue(id, meta, status);
        const queue = meta.queue || [];
        const picked = payload.action === 'followup.steer_all' ? queue : queue.filter((entry) => entry.id === args.id);
        if (!picked.length) {
          if (payload.action === 'followup.cancel') this.emit('followup.cancelled', id, { id: args.id, threadId: id });
          return { cancelled: payload.action === 'followup.cancel', steered: false, backend: 'pi' };
        }
        await this.changePiQueue(id, meta, status, picked, payload.action);
        this.nudgePi();
        return payload.action === 'followup.cancel' ? { cancelled: true, backend: 'pi' } : { steered: true, backend: 'pi' };
      }
      case 'followup.list': {
        const status = id ? await this.pi.status(id, cwd).catch(() => null) : null;
        if (status && meta) { this.trackPiQueue(id, meta, status); this.savePiThreads(); }
        return { items: this.piQueueItems(id) };
      }
      case 'settings.get':
      case 'pi.models': {
        // The model list and levels are the same for every session: answer from
        // the cache at once, with the session's model as last seen, and refresh
        // in the background (opening an unloaded session is slow in PI WEB).
        const cached = this.piModelCache;
        if (cached && Date.now() - cached.at < MODEL_CACHE_MS) {
          if (meta) this.warmPiSession(id, meta);
          const [provider, ...rest] = String(meta?.model || '').split('/');
          const status = meta?.model ? { model: { provider, id: rest.join('/') }, thinkingLevel: meta.thinkingLevel || '' } : null;
          return { backend: 'pi', status, catalog: cached.catalog, thinkingLevels: cached.levels, cached: true };
        }
        // No cache yet (first open after a restart): the catalog is quick, but
        // the session's own status waits for PI WEB to load it (seen: 54 s).
        // Answer with the model last seen and let the status arrive in the background.
        const [catalog, levels] = await Promise.all([
          this.pi.modelCatalog(id, cwd).catch(() => null), this.pi.thinkingLevels(id, cwd).catch(() => null)]);
        if (catalog?.models?.length) this.piModelCache = { at: Date.now(), catalog, levels };
        let status = null;
        if (meta?.model) {
          const [provider, ...rest] = String(meta.model).split('/');
          status = { model: { provider, id: rest.join('/') }, thinkingLevel: meta.thinkingLevel || '' };
          this.warmPiSession(id, meta);
        } else status = await this.pi.status(id, cwd, 60_000).catch(() => null);
        if (meta && status && !meta.model) this.notePiStatus(meta, status);
        return { backend: 'pi', status, catalog, thinkingLevels: levels };
      }
      case 'settings.set': {
        const settings = args.settings || args;
        const model = settings.model && String(settings.model).includes('/') ? String(settings.model) : null;
        const level = settings.thinkingLevel || settings.effort || null;
        return this.setPiSettings(id, cwd, meta, { model, level });
      }
      default:
        // Reads the phone makes for every thread (settings, capabilities, ...)
        // just come back empty; only changes Pi cannot make are refused.
        if (BACKGROUND_READ.test(payload.action || '')) return { backend: 'pi' };
        throw new Error(`Pi 暂不支持这个操作：${payload.action}`);
    }
  },
};

function hasText(args) { return Boolean(String(args.text || '').trim()); }

function install(Connector) { Object.assign(Connector.prototype, methods); }

module.exports = { install, methods, piWaiting, PI_OFFLINE, PI_BUSY };
