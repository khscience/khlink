// Mirrors Google Antigravity conversations to the phone: list, history and a
// coarse running state come from ~/.gemini/antigravity (see antigravity.js).
// Messages and Stop from the phone go through Antigravity's own window
// (scripts/antigravity-send.ps1: its sidebar link, message box and buttons),
// never its local server, debugging port or sign-in token. Approvals and
// anything else stay in the desktop app.
// Installed onto Connector.prototype by install().

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { writeFileAtomic } = require('../atomic-file');
const { encryptJson } = require('../crypto');
const { clip } = require('../history');
const ag = require('./antigravity');

const POLL_MS = 4_000;
const INDEX_VERSION = 7;
const ITEMS_VERSION = 2; // Correct native generating/canceled status semantics.
// The conversation file is written as the agent works; quiet this long = idle.
const RUNNING_QUIET_MS = 90_000;
// After a finished reply or an error step the turn is over; this short quiet
// only covers the next step being written right after it.
const TURN_END_QUIET_MS = 25_000;
// A step left "in progress" (waiting for approval, a long command) counts as
// busy, but not for ever: the app may have been closed mid-step.
const OPEN_STEP_STALE_MS = 30 * 60_000;
// A send waits until the keyboard and mouse have been still this long, so the
// window does not jump in front of someone at the computer; after waiting
// MAX_IDLE_WAIT_MS it goes anyway.
const IDLE_BEFORE_SEND_S = 15;
const MAX_IDLE_WAIT_MS = 3 * 60_000;
const IDLE_RETRY_MS = 8_000;
const SEND_CONFIRM_MS = 15_000;
const SEND_UNCERTAIN = '已尝试发送，但还没有确认到新消息。请检查电脑上的对话；系统不会自动重发。';

// The relay takes at most 100 items per request; keep requests small too.
const UPLOAD_BATCH = 100;
const UPLOAD_BATCH_BYTES = 1_500_000;
// First sight of a conversation: only its most recent items (old ones are
// long tool logs nobody scrolls back to from a phone).
const FIRST_SYNC_ITEMS = 600;
const ANTIGRAVITY_ACTIONS_UNSUPPORTED = '这个操作请在电脑上的反重力里完成。';
const SEND_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'antigravity-send.ps1');
const SEND_ERRORS = {
  not_running: '电脑上的反重力没有打开。',
  conversation_not_in_sidebar: '在反重力的对话列表和历史记录里都没找到这个对话（可能已被删除），请在电脑上打开它一次。',
  conversation_not_opened: '电脑上的反重力未能切换到这个对话，已取消发送。',
  no_message_box: '反重力里没找到这个对话的输入框。',
  draft_in_box: '电脑上反重力的输入框里有还没发出的草稿，已取消，免得覆盖它。',
  needs_foreground: '要把文字填进反重力，需要它的窗口能切到前台（电脑可能锁屏了），已取消发送。',
  text_not_taken: '文字没能填进反重力的输入框，已取消发送。',
  send_unavailable: '反重力的发送按钮当前不可用（可能还在运行），已取消。',
  no_stop_button: '反重力里没有找到停止按钮（可能已经停了）。',
  no_question: '反重力里没有正在等待回答的问题（可能已经在电脑上答过了）。',
  option_not_found: '反重力里没找到这个选项，请在电脑上回答。',
  other_not_taken: '自己写的答案没能填进反重力，已取消。',
  submit_unavailable: '反重力的提交按钮当前不可用，请在电脑上回答。',
  bad_answer: '回答内容不完整。',
  empty_message: '消息是空的。',
};

const methods = {
  startAntigravitySync() {
    if (this._antigravityTimer || !this.config?.configFile) return;
    const home = ag.antigravityHome();
    if (!fs.existsSync(path.join(home, 'conversations'))) return;
    this.antigravityHomeDir = home;
    this.antigravityFile = path.join(path.dirname(this.config.configFile), 'antigravity-threads.json');
    this.antigravityThreads = this.readAntigravityThreads();
    this.recoverAntigravityDeliveries();
    // A question still waiting is read again, so its card reflects this version.
    for (const meta of this.antigravityThreads.values()) {
      meta.windowProbePending = false;
      if (meta.waiting) meta.mtimeMs = 0;
    }
    console.log(`[fengzhu-connect] antigravity sync on (${this.antigravityThreads.size} known)`);
    this._antigravityTimer = setInterval(() => this.pollAntigravity().catch((error) => this.log(error)), POLL_MS);
    this._antigravityTimer.unref?.();
    this.pollAntigravity().catch((error) => this.log(error));
  },

  readAntigravityThreads() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(this.antigravityFile, 'utf8')))); } catch { return new Map(); }
  },

  saveAntigravityThreads({ required = false } = {}) {
    try { writeFileAtomic(this.antigravityFile, JSON.stringify(Object.fromEntries(this.antigravityThreads))); }
    catch (error) { if (required) throw error; this.log(error); }
  },

  antigravityThreadStatus(meta) {
    if (meta.waiting) return 'desktop_waiting';
    if (meta.running) return 'desktop_running';
    if (this.antigravityStopped(meta) || ag.STATUS_STOPPED.has(meta.lastStatus)) return 'interrupted';
    return meta.lastType === ag.STEP_ERROR || ag.STATUS_FAILED.has(meta.lastStatus) ? 'failed' : 'completed';
  },

  antigravityStopped(meta) {
    return Boolean(meta.stoppedAt && meta.stoppedAt >= (meta.lastAt || 0) && meta.stoppedAt >= (meta.sentAt || 0));
  },

  antigravityRunning(meta, stat) {
    const now = Date.now(); const quiet = now - (meta.lastAt || stat.mtimeMs);
    if (this.antigravityStopped(meta)) return false;
    if (meta.waiting) return false;
    const window = meta.windowState;
    // Only a foreground observation is authoritative. An occluded Electron
    // window can retain its old Cancel button after the reply has finished.
    if (window?.foreground && window.at >= (meta.lastAt || 0) && window.at >= (meta.sentAt || 0) &&
      (!window.active || now - window.at < 10_000)) return window.active;
    // Sent from the phone and nothing written yet: the agent may be thinking.
    if (meta.sentAt && now - meta.sentAt < RUNNING_QUIET_MS && (meta.lastAt || stat.mtimeMs) < meta.sentAt &&
      (!Number.isInteger(meta.sentReceiptIdx) || meta.sentReceiptIdx > (meta.lastIdx ?? -1))) return true;
    if (ag.STATUS_STOPPED.has(meta.lastStatus) || ag.STATUS_FAILED.has(meta.lastStatus) || meta.lastType === ag.STEP_ERROR) return false;
    if (ag.STATUS_ACTIVE.has(meta.lastStatus)) return quiet < OPEN_STEP_STALE_MS;
    // Stopped from the phone: whatever the last step is, the turn is over.
    const ended = meta.lastType === ag.STEP_MODEL;
    return quiet < (ended ? TURN_END_QUIET_MS : RUNNING_QUIET_MS);
  },

  // The turn went quiet and was taken as over (see antigravityRunning): an open
  // step left for OPEN_STEP_STALE_MS, or no step written for RUNNING_QUIET_MS
  // after a tool step. A stop, a failure, a finished model reply and a foreground
  // window that says the turn is over are explicit ends, not silence.
  antigravityEndedBySilence(meta, stat) {
    if (this.antigravityRunning(meta, stat)) return false;
    if (this.antigravityStopped(meta) || meta.waiting) return false;
    const window = meta.windowState;
    if (window?.foreground && window.at >= (meta.lastAt || 0)) return false;
    if (ag.STATUS_STOPPED.has(meta.lastStatus) || ag.STATUS_FAILED.has(meta.lastStatus) || meta.lastType === ag.STEP_ERROR) return false;
    if (meta.lastType === ag.STEP_MODEL && !ag.STATUS_ACTIVE.has(meta.lastStatus)) return false;
    return true;
  },

  antigravityIndexValue(id, meta) {
    const status = this.antigravityThreadStatus(meta);
    return {
      id, title: meta.title || meta.firstText?.slice(0, 40) || '反重力对话', cwd: meta.cwd || '', status,
      note: meta.waiting?.summary || '', waiting: meta.waiting || null, model: meta.model || '',
      updatedAt: meta.updatedAt || Date.now(), activityAt: meta.lastAt || meta.createdAt || 0, backend: 'antigravity', archived: false, pinned: false, pinOrder: -1,
      unread: !meta.running && (meta.lastAt || 0) > (meta.viewedAt || 0) + 1_000, origin: 'desktop',
    };
  },

  async uploadAntigravityIndex(id, meta, { archived = false } = {}) {
    const value = { ...this.antigravityIndexValue(id, meta), archived };
    const encrypted = encryptJson(this.config.accountKey, 'history.thread', id, id, value);
    await this.api.request(this.api.path('/history/threads'), { method: 'PUT', body: { id, archived, updatedAt: value.updatedAt, ...encrypted } });
  },

  async uploadAntigravityItems(id, items) {
    const rows = await Promise.all(items.map(async (item) => {
      // Steps are ordered by index; a step's thinking comes before its reply.
      const [, idx, suffix] = item.id.match(/^ag-(\d+)(.*)$/) || [];
      const order = Number(idx) * 10 + (suffix === '-think' ? 0 : 1);
      const createdAt = item.at || Date.now();
      const value = { ...item.value, ...clip(item.value.text || '', 32 * 1024) };
      return { id: item.id, order, createdAt, ...await this.historyItemFrame(id, item.id, value) };
    }));
    let batch = []; let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.api.request(this.api.path(`/history/threads/${encodeURIComponent(id)}/items`), { method: 'PUT', body: { items: batch } });
      batch = []; bytes = 0;
    };
    for (const row of rows) {
      const size = row.ciphertext.length + 200;
      if (batch.length >= UPLOAD_BATCH || (batch.length && bytes + size > UPLOAD_BATCH_BYTES)) await flush();
      batch.push(row); bytes += size;
    }
    await flush();
  },

  async pollAntigravity() {
    if (this._antigravityPolling || this.stopping || !this.config.accountKey) return;
    this._antigravityPolling = true;
    try {
      const dir = path.join(this.antigravityHomeDir, 'conversations');
      let changed = false;
      // Most recently active first, so the conversations that matter show up first.
      // Asynchronous: on a busy disk this listing once took 24 s and, done
      // synchronously, stalled the whole connector (2026-10-09 05:18).
      const listed = await fs.promises.readdir(dir);
      const names = (await Promise.all(listed.map(async (name) => {
        try { return [name, (await fs.promises.stat(path.join(dir, name))).mtimeMs]; } catch { return [name, 0]; }
      }))).sort((a, b) => b[1] - a[1]).map(([name]) => name);
      for (const name of names) {
        const match = name.match(/^([0-9a-f-]{36})\.db$/i); if (!match) continue;
        const id = match[1];
        try { if (await this.syncAntigravityConversation(dir, name, id)) changed = true; }
        catch (error) { this.log(new Error(`antigravity ${id}: ${error.message}`)); }
      }
      // A conversation deleted in Antigravity cannot still be running: without
      // this its last "running" was re-announced every 15 s for good.
      for (const [id, meta] of this.antigravityThreads) {
        if (names.includes(`${id}.db`)) { if (meta.deletedSynced) Object.assign(meta, { deletedSynced: false, indexVersion: 0 }); continue; }
        if (meta.running || meta.waiting) {
          // A conversation deleted mid-turn is not the turn's end: no reminder.
          Object.assign(meta, { running: false, waiting: null, quietEnd: true });
          this.announceAntigravityStatus(id, meta); changed = true;
        }
        // The relay keeps the row as last uploaded, possibly "running" from
        // before the conversation was deleted (seen: a deleted conversation
        // shown running for 10 days). Archive it there once.
        if (!meta.deletedSynced) {
          try { await this.uploadAntigravityIndex(id, meta, { archived: true }); meta.deletedSynced = true; changed = true; }
          catch (error) { this.log(new Error(`antigravity ${id}: ${error.message}`)); }
        }
      }
      if (changed) { this.saveAntigravityThreads(); this.emit('threads.updated', null, { updatedAt: Date.now() }); }
      // A running turn is said again every 15 s, as for the other agents.
      for (const [id, meta] of this.antigravityThreads) if (meta.running && Date.now() - (meta.announcedAt || 0) > 15_000) this.announceAntigravityStatus(id, meta);
    } finally { this._antigravityPolling = false; }
    await this.drainAntigravityQueues();
  },

  // One conversation; returns whether anything was uploaded.
  async syncAntigravityConversation(dir, name, id) {
    let stat; try { stat = fs.statSync(path.join(dir, name)); } catch { return false; }
    // Antigravity writes through SQLite's WAL; the .db itself only moves at a
    // checkpoint, so a long turn would otherwise look idle until it ends.
    try {
      const wal = fs.statSync(path.join(dir, `${name}-wal`));
      stat = { mtimeMs: Math.max(stat.mtimeMs, wal.mtimeMs), size: stat.size + wal.size };
    } catch {}
    const annotation = ag.readAnnotation(this.antigravityHomeDir, id);
    const meta = this.antigravityThreads.get(id) || { lastIdx: -1 };
    const rebuilt = meta.itemsVersion !== ITEMS_VERSION;
    const fileChanged = rebuilt || meta.mtimeMs !== stat.mtimeMs || meta.size !== stat.size;
    let conversation = null;
    if (fileChanged) {
      conversation = ag.readConversation(path.join(dir, name), rebuilt ? -1 : meta.lastIdx, rebuilt ? null : meta.openIdx);
      if (conversation.lastIdx !== meta.lastIdx || conversation.lastStatus !== meta.lastStatus || conversation.lastType !== meta.lastType) meta.windowState = null;
      for (const entry of meta.deliveries || []) {
        if (entry.state !== 'uncertain' || !Number.isInteger(entry.afterIdx)) continue;
        const receipt = conversation.items.find((item) => item.value.type === 'userMessage' && Number(item.id.slice(3)) > entry.afterIdx && ag.normalizeSendText(item.value.text) === ag.normalizeSendText(entry.text));
        if (receipt) {
          Object.assign(entry, { state: 'started', receiptIdx: Number(receipt.id.slice(3)), startedAt: receipt.at || Date.now(), reason: null, stateVersion: Math.max(Date.now(), (entry.stateVersion || 0) + 1) });
          this.emit('followup.started', id, this.antigravityQueueItem(id, entry));
        }
      }
      Object.assign(meta, { cwd: conversation.cwd, lastAt: conversation.lastAt || meta.lastAt,
        createdAt: conversation.createdAt, firstText: conversation.firstText,
        lastType: conversation.lastType, lastStatus: conversation.lastStatus, waiting: conversation.waiting,
        model: conversation.model || meta.model || '' });
      // SQLite may still contain the unanswered question immediately after
      // its native panel was cancelled. A later native turn supersedes stop.
      if (this.antigravityStopped(meta)) meta.waiting = null;
      if (meta.waiting && meta.waitingId !== meta.waiting.requestId) { meta.waitingId = meta.waiting.requestId; meta.waitingAt = Date.now(); }
      if (!meta.waiting) meta.waitingId = null;
    }
    // Busy while the last step is open or the file keeps moving (see antigravityRunning).
    const running = this.antigravityRunning(meta, stat);
    if (running && meta.lastType === ag.STEP_MODEL && !ag.STATUS_ACTIVE.has(meta.lastStatus) && this.config?.configFile) this.refreshAntigravityWindowState(id, meta);
    // 2: re-sent once after the integration came back (its rows had been
    // archived on the relay when it was removed). 3: rows gained the model.
    const labelChanged = meta.title !== annotation.title || meta.viewedAt !== annotation.viewedAt || Boolean(meta.running) !== running || meta.indexVersion !== INDEX_VERSION;
    if (!fileChanged && !labelChanged) return false;
    if (meta.model === undefined) meta.model = ag.readModel(path.join(dir, name));
    Object.assign(meta, { title: annotation.title, viewedAt: annotation.viewedAt, running,
      quietEnd: !running && this.antigravityEndedBySilence(meta, stat),
      updatedAt: meta.lastAt || stat.mtimeMs });
    // The relay stores items only for a thread it already has.
    await this.uploadAntigravityIndex(id, meta);
    meta.indexVersion = INDEX_VERSION;
    if (conversation) {
      const items = rebuilt || meta.lastIdx < 0 ? conversation.items.slice(-FIRST_SYNC_ITEMS) : conversation.items;
      if (items.length) await this.uploadAntigravityItems(id, items);
      Object.assign(meta, { lastIdx: conversation.lastIdx, openIdx: conversation.openIdx, mtimeMs: stat.mtimeMs, size: stat.size, itemsVersion: ITEMS_VERSION });
      if (conversation.items.length) this.emit('history.updated', id, { threadId: id, itemCount: conversation.items.length, updatedAt: conversation.lastAt || stat.mtimeMs, backend: 'antigravity', ...(rebuilt ? { fullHistory: true } : {}) });
    }
    this.antigravityThreads.set(id, meta);
    this.saveAntigravityThreads();
    if (meta.announcedStatus !== this.antigravityThreadStatus(meta)) this.announceAntigravityStatus(id, meta);
    return true;
  },

  announceAntigravityStatus(id, meta) {
    const status = this.antigravityThreadStatus(meta);
    // The list row on the relay carries a status too; re-upload it on the next
    // scan whenever the status changes outside a file change.
    if (meta.announcedStatus !== undefined && meta.announcedStatus !== status) meta.indexVersion = 0;
    meta.announcedRunning = Boolean(meta.running); meta.announcedStatus = status; meta.announcedAt = Date.now();
    this.emit('thread.status', id, { threadId: id, status, backend: 'antigravity', updatedAt: Date.now(), ...(status === 'completed' && meta.quietEnd ? { quiet: true } : {}) });
  },

  // For the connector's live-task snapshot: without these rows the phone
  // clears a running badge on every heartbeat.
  antigravityActiveThreadRows() {
    const rows = [];
    for (const [threadId, meta] of this.antigravityThreads || []) {
      if (meta.waiting) rows.push({ threadId, status: 'desktop_waiting', updatedAt: meta.waitingAt || Date.now() });
      else if (meta.running) rows.push({ threadId, status: 'desktop_running', updatedAt: meta.announcedAt || meta.updatedAt || Date.now() });
    }
    return rows;
  },

  // Messages waiting for the running turn to end (Antigravity's Send button is
  // not available meanwhile); sent in order once it is quiet.
  antigravityQueueItem(threadId, entry) {
    const state = entry.state || 'desktop_queued';
    return { id: entry.id, requestId: entry.id, threadId, text: entry.text, createdAt: entry.createdAt, state, reason: entry.reason || null, startedAt: entry.startedAt || null, stateVersion: entry.stateVersion || 0, origin: 'mobile', blocking: state === 'desktop_queued', backend: 'antigravity' };
  },

  antigravityQueueItems(threadId = null) {
    const rows = [];
    for (const [id, meta] of this.antigravityThreads || []) {
      if (threadId && id !== threadId) continue;
      for (const entry of meta.queue || []) rows.push(this.antigravityQueueItem(id, entry));
      for (const entry of meta.deliveries || []) if (['dispatching', 'uncertain', 'failed'].includes(entry.state)) rows.push(this.antigravityQueueItem(id, entry));
    }
    return rows;
  },

  refreshAntigravityWindowState(id, meta) {
    if (meta.windowProbePending || Date.now() - (meta.windowProbedAt || 0) < 5_000) return;
    meta.windowProbePending = true; meta.windowProbedAt = Date.now();
    this.runAntigravitySend(id, 'probe').then((result) => {
      if (!result.ok || !result.current || !result.foreground || !result.box || !result.send || result.active) return;
      if (meta.deliveries?.some((entry) => entry.state === 'dispatching')) return;
      const observedAt = result.observedAt || Date.now();
      if (observedAt < Math.max(meta.lastAt || 0, meta.sentAt || 0)) return;
      meta.windowState = { at: observedAt, active: false, foreground: true };
      if (!result.active && meta.running && !meta.waiting) {
        meta.running = false; this.announceAntigravityStatus(id, meta);
        this.saveAntigravityThreads(); this.uploadAntigravityIndex(id, meta).catch((error) => this.log(error));
      }
    }).catch((error) => this.log(error)).finally(() => { meta.windowProbePending = false; });
  },

  readAntigravitySendState(id, text = '', afterIdx = -1) {
    return ag.readSendState(path.join(this.antigravityHomeDir, 'conversations', `${id}.db`), text, afterIdx);
  },

  recoverAntigravityDeliveries() {
    for (const [id, meta] of this.antigravityThreads) for (const entry of meta.deliveries || []) {
      if (entry.state !== 'dispatching') continue;
      let receipt = null;
      try { receipt = this.readAntigravitySendState(id, entry.text, entry.afterIdx).receipt; } catch {}
      Object.assign(entry, { state: receipt ? 'started' : 'uncertain', reason: receipt ? null : SEND_UNCERTAIN, receiptIdx: receipt?.idx, startedAt: receipt?.at || null, stateVersion: Math.max(Date.now(), (entry.stateVersion || 0) + 1) });
      meta.queue = (meta.queue || []).filter((queued) => queued.id !== entry.id);
    }
    this.saveAntigravityThreads();
  },

  serializeAntigravityDelivery(run) {
    const next = (this._antigravityDeliveryChain || Promise.resolve()).then(run, run);
    this._antigravityDeliveryChain = next.catch(() => {});
    return next;
  },

  antigravityDeliveryResult(id, entry) {
    const item = this.antigravityQueueItem(id, entry);
    return { accepted: entry.state === 'started', queued: !entry.state || entry.state === 'desktop_queued', uncertain: entry.state === 'uncertain', failed: entry.state === 'failed', cancelled: entry.state === 'cancelled', item, deliveredTo: entry.state === 'started' ? 'desktop' : null, backend: 'antigravity' };
  },

  runAntigravitySend(conversationId, mode, text = '', { idleSeconds = 0 } = {}) {
    const file = path.join(os.tmpdir(), `kh-link-antigravity-${crypto.randomUUID()}.txt`);
    const progressFile = `${file}.progress.json`;
    fs.writeFileSync(file, text || '', { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(progressFile, JSON.stringify({ phase: 'starting', mayHaveSent: false }), { mode: 0o600 });
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SEND_SCRIPT, '-TextFile', file, '-ProgressFile', progressFile, '-Mode', mode];
    if (conversationId) args.push('-ConversationId', conversationId);
    if (idleSeconds > 0) args.push('-IdleSeconds', String(idleSeconds));
    const exec = this.execFileFn || execFile;
    // One at a time: two scripts driving the same window would trip over each other.
    const run = () => new Promise((resolve) => {
      exec('powershell.exe', args, { windowsHide: true, timeout: 45_000 }, (error, stdout) => {
        let progress = {};
        try { progress = JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch {}
        if (progress.phase === 'confirmed') return resolve({ ...progress, ok: true, reason: 'confirmed' });
        if (error && !stdout) return resolve({ ...progress, ok: false, reason: 'automation_timeout' });
        try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); } catch { resolve({ ...progress, ok: false, reason: 'bad_output' }); }
      });
    });
    // UI Automation can fail to start in a fresh PowerShell; nothing was touched then, so try once more.
    const runRetrying = () => run().then((result) => (!result.ok && /TypeInitializationException/i.test(String(result.reason || ''))
      ? new Promise((resolve) => setTimeout(resolve, 800)).then(run) : result));
    const next = (this._antigravitySendChain || Promise.resolve()).then(runRetrying, runRetrying);
    next.finally(() => { for (const temporary of [file, progressFile]) fs.rm(temporary, { force: true }, () => {}); }).catch(() => {});
    this._antigravitySendChain = next.catch(() => {});
    return next;
  },

  async deliverAntigravity(id, meta, entry, { waitForIdle = false } = {}) {
    const boundary = this.readAntigravitySendState(id).lastIdx;
    Object.assign(entry, { state: 'dispatching', afterIdx: boundary, attemptedAt: Date.now(), stateVersion: Date.now() });
    const previous = (meta.deliveries || []).filter((row) => row.id !== entry.id);
    meta.deliveries = [...previous.filter((row) => ['uncertain', 'dispatching'].includes(row.state)),
      ...previous.filter((row) => !['uncertain', 'dispatching'].includes(row.state) && Date.now() - row.createdAt < 7 * 86400_000).slice(-99), entry];
    // Save before touching the Send button. After a restart this request is
    // checked against history, never blindly driven through the window again.
    this.saveAntigravityThreads({ required: true });
    // This acknowledges durable processing, not delivery to Antigravity.
    // The phone keeps showing "sending" until the history receipt arrives.
    this.emit('followup.queued', id, this.antigravityQueueItem(id, entry));
    const result = await this.runAntigravitySend(id, 'send', entry.text, { idleSeconds: waitForIdle ? IDLE_BEFORE_SEND_S : 0 })
      .catch(() => ({ ok: false, reason: 'automation_error' }));
    if (!result.ok && result.reason === 'user_active') {
      meta.deliveries = meta.deliveries.filter((row) => row.id !== entry.id); delete entry.state; this.saveAntigravityThreads();
      const error = new Error('电脑正在使用，等空闲后再发'); error.code = 'USER_ACTIVE'; throw error;
    }
    if (!result.ok && (SEND_ERRORS[result.reason] || result.mayHaveSent === false)) {
      Object.assign(entry, { state: 'failed', reason: SEND_ERRORS[result.reason] || '反重力窗口操作失败，消息没有发出。', stateVersion: Date.now() });
      this.saveAntigravityThreads();
      return this.antigravityDeliveryResult(id, entry);
    }
    const deadline = Date.now() + (this.antigravitySendConfirmMs ?? SEND_CONFIRM_MS);
    let receipt = result.ok && result.receiptSource === 'window' && Number.isFinite(result.confirmedAt)
      ? { at: result.confirmedAt, source: 'window' } : null;
    do {
      if (!receipt) try { receipt = this.readAntigravitySendState(id, entry.text, boundary).receipt; } catch {}
      if (receipt || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    } while (true);
    Object.assign(entry, { state: receipt ? 'started' : 'uncertain', reason: receipt ? null : SEND_UNCERTAIN, startedAt: receipt?.at || null, receiptIdx: receipt?.idx, receiptSource: receipt?.source || 'history', stateVersion: Math.max(Date.now(), entry.stateVersion + 1) });
    this.saveAntigravityThreads();
    if (!receipt) return this.antigravityDeliveryResult(id, entry);
    // Receipt observation happens after native history timestamps. Using that
    // later time would make a finished reply look like a pending new send.
    Object.assign(meta, { running: true, sentAt: entry.attemptedAt, sentReceiptIdx: receipt.idx, stoppedAt: 0, windowState: null });
    this.announceAntigravityStatus(id, meta);
    this.saveAntigravityThreads();
    setTimeout(() => this.pollAntigravity().catch((error) => this.log(error)), 2_000).unref?.();
    return this.antigravityDeliveryResult(id, entry);
  },

  async drainAntigravityQueues() {
    for (const [id, meta] of this.antigravityThreads || []) {
      if (!meta.queue?.length || meta.running || meta.waiting || this._antigravityDraining) continue;
      const entry = meta.queue[0];
      if (entry.retryAt && Date.now() < entry.retryAt) continue;
      this._antigravityDraining = true;
      try {
        await this.serializeAntigravityDelivery(async () => {
          if (meta.running || meta.waiting || meta.queue?.[0]?.id !== entry.id) return;
          const result = await this.deliverAntigravity(id, meta, entry, { waitForIdle: Date.now() - entry.createdAt < MAX_IDLE_WAIT_MS });
          meta.queue = meta.queue.filter((row) => row.id !== entry.id); this.saveAntigravityThreads();
          this.emit(result.accepted ? 'followup.started' : 'followup.failed', id, { ...result.item, needsConfirmation: result.uncertain });
        });
      } catch (error) {
        // Someone is at the computer: keep it first in line and look again shortly.
        if (error.code === 'USER_ACTIVE') { entry.retryAt = Date.now() + IDLE_RETRY_MS; continue; }
        meta.queue.shift(); this.saveAntigravityThreads();
        this.emit('followup.failed', id, { ...this.antigravityQueueItem(id, entry), state: 'failed', reason: error.message });
      } finally { this._antigravityDraining = false; }
    }
  },

  // Phone commands for an Antigravity thread.
  async antigravityCommand(payload) {
    const threadId = payload.args?.threadId;
    if (payload.action === 'history.sync') {
      const meta = this.antigravityThreads.get(threadId);
      if (meta) { meta.mtimeMs = 0; await this.pollAntigravity(); }
      return { synced: true, threadId, backend: 'antigravity' };
    }
    const meta = this.antigravityThreads.get(threadId);
    const args = payload.args || {};
    switch (payload.action) {
      case 'followup.list': return { items: this.antigravityQueueItems(threadId) };
      case 'turn.start':
      case 'turn.steer':
      case 'followup.enqueue': {
        if (!meta) throw new Error('没有找到这个反重力对话');
        const text = String(args.text || '').trim();
        if (args.attachments?.length) throw new Error('反重力暂不支持从手机发图片或文件，只能发文字。');
        if (!text) throw new Error(SEND_ERRORS.empty_message);
        return this.serializeAntigravityDelivery(async () => {
          const requestId = payload.requestId || args.requestId || `ag-q-${crypto.randomUUID()}`;
          const previous = [...(meta.queue || []), ...(meta.deliveries || [])].find((entry) => entry.id === requestId);
          if (previous) return { ...this.antigravityDeliveryResult(threadId, previous), duplicate: true };
          const entry = { id: requestId, text, createdAt: Date.now() };
          const enqueue = () => {
            const before = meta.queue || [];
            meta.queue = [...before, entry];
            try { this.saveAntigravityThreads({ required: true }); } catch (error) { meta.queue = before; throw error; }
            const item = this.antigravityQueueItem(threadId, entry);
            this.emit('followup.queued', threadId, item);
            return { queued: true, item, backend: 'antigravity' };
          };
          if (meta.running || meta.waiting || meta.queue?.length) return enqueue();
          try { return await this.deliverAntigravity(threadId, meta, entry, { waitForIdle: true }); }
          catch (error) { if (error.code === 'USER_ACTIVE') return enqueue(); throw error; }
        });
      }
      case 'followup.cancel': {
        return this.serializeAntigravityDelivery(async () => {
          if (meta) {
            const queued = meta.queue?.find((entry) => entry.id === args.id);
            const delivery = meta.deliveries?.find((entry) => entry.id === args.id);
            if (['dispatching', 'started'].includes(delivery?.state)) throw new Error('这条消息已经开始发送，无法再从队列取消。');
            const before = { queue: meta.queue, deliveries: meta.deliveries };
            const cancelled = (entry) => ({ ...entry, state: 'cancelled', stateVersion: Math.max(Date.now(), (entry.stateVersion || 0) + 1) });
            meta.queue = (meta.queue || []).filter((entry) => entry.id !== args.id);
            meta.deliveries = (meta.deliveries || []).map((entry) => entry.id === args.id ? cancelled(entry) : entry);
            if (queued && !delivery) meta.deliveries.push(cancelled(queued));
            try { this.saveAntigravityThreads({ required: true }); } catch (error) { Object.assign(meta, before); throw error; }
          }
          this.emit('followup.cancelled', threadId, { id: args.id, threadId });
          return { cancelled: true, backend: 'antigravity' };
        });
      }
      // The phone's waiting card (shared with Claude): answer Antigravity's question.
      case 'claude.desktop.answer': {
        const waiting = meta?.waiting;
        if (!waiting || waiting.kind !== 'question') throw new Error(SEND_ERRORS.no_question);
        if (args.requestId && waiting.requestId && args.requestId !== waiting.requestId) throw new Error(SEND_ERRORS.no_question);
        const answers = Array.isArray(args.answers) ? args.answers.map((answer) => ({
          labels: (Array.isArray(answer?.labels) ? answer.labels : []).map(String), other: String(answer?.other || '').trim(),
        })) : (args.choice ? [{ labels: [String(args.choice)], other: '' }] : []);
        if (!answers.length || answers.some((answer) => !answer.labels.length && !answer.other)) throw new Error(SEND_ERRORS.bad_answer);
        const result = await this.runAntigravitySend(threadId, 'answer', JSON.stringify({ answers }));
        if (!result.ok) throw new Error(SEND_ERRORS[result.reason] || `回答失败：${result.reason}`);
        setTimeout(() => this.pollAntigravity().catch((error) => this.log(error)), 1_500).unref?.();
        return { ok: true, answered: true, backend: 'antigravity' };
      }
      case 'turn.stop': {
        const result = await this.runAntigravitySend(threadId, 'stop');
        if (!result.ok) throw new Error(SEND_ERRORS[result.reason] || `停止失败：${result.reason}`);
        if (meta) { Object.assign(meta, { stoppedAt: Date.now(), sentAt: 0, running: false, waiting: null, indexVersion: 0 }); this.announceAntigravityStatus(threadId, meta); this.saveAntigravityThreads(); }
        setTimeout(() => this.pollAntigravity().catch((error) => this.log(error)), 1_500).unref?.();
        return { stopped: true, backend: 'antigravity' };
      }
      default:
        // Renames and settings remain in the desktop app.
        if (/^(followup\.|thread\.(rename|archive|compact|fork|rollback|resume)|settings\.set|approval)/.test(payload.action || '')) throw new Error(ANTIGRAVITY_ACTIONS_UNSUPPORTED);
        return { backend: 'antigravity', readOnly: true };
    }
  },
};

function install(Connector) { Object.assign(Connector.prototype, methods); }

module.exports = { install, methods, ANTIGRAVITY_ACTIONS_UNSUPPORTED };
