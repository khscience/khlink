// DeepSeek Harness desktop sessions, mirrored to the phone through the live
// Desktop Host API published by the KH Link bridge plugin.
//
// The phone and the DSH desktop window drive the same sessions and the same
// live turns: this backend never starts a second DSH process and never writes
// DSH session files directly.
// Installed onto Connector.prototype by install().

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const writeFileAtomic = require('../atomic-file').writeFileAtomic;
const execFileAsync = promisify(execFile);
const { encryptJson } = require('../crypto');
const { clip } = require('../history');
const { isImageAttachment } = require('../attachment-store');
const { DshClient, DshApiError } = require('./dsh-api');

const POLL_MS = 5_000;
const ACTIVE_POLL_MS = 1_500;
const FIRST_SYNC_MESSAGES = 400;
const ITEMS_SCHEMA = 5;   // 5: reconcile image receipts and recover the final live status
const UPLOAD_BATCH = 100;
const UPLOAD_BATCH_BYTES = 1_500_000;
const THREAD_PREFIX = 'dsh-';
const DSH_OFFLINE = 'DeepSeek Harness 桌面端没有运行，或 KH Link 桥接没有加载。请在电脑上打开 DSH。';
const DSH_BUSY = 'DeepSeek Harness 正在运行，但暂时没有响应，请稍后再试。';
const BACKGROUND_READ = /(\.read|\.get|\.list|capabilities|usage)$/;
const ACTIVE_WINDOW_MS = 3 * 60_000;
const CONNECTOR_VERSION = require('../../package.json').version;
const ACCOUNT_REFRESH_MS = 5 * 60_000;

const DSH_BRIDGE_ROW = '# KH Link desktop bridge (managed by khLink; remove this row to disable)\n- insert:\n    - id: kh-link-dsh-bridge\n      name: kh-link-dsh-bridge\n';

// The Desktop profile's cordis.patch.yml is a top-level YAML list. A fresh DSH
// writes it as an empty flow list ("[]"); appending a block item after that is
// invalid YAML and DSH refuses to start. Returns the text with the bridge row
// (repairing a file an older connector broke that way), or null to leave the
// file alone (a non-empty flow list we cannot extend safely).
function withDshBridgeRow(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const isEmptyList = (line) => line.trim() === '[]';
  const content = lines.filter((line) => line.trim() && !line.trim().startsWith('#'));
  const hasRow = text.includes('id: kh-link-dsh-bridge');
  const blockItems = content.some((line) => line.startsWith('- '));
  if (hasRow) {
    if (!blockItems || !lines.some(isEmptyList)) return text;
    return lines.filter((line) => !isEmptyList(line)).join(eol);
  }
  let kept = lines;
  if (content.length === 1 && isEmptyList(content[0])) kept = lines.filter((line) => !isEmptyList(line));
  else if (content.length && content[0].trim().startsWith('[')) return null;
  let body = kept.join(eol);
  if (body && !body.endsWith(eol)) body += eol;
  return `${body}${body.trim() ? eol : ''}${DSH_BRIDGE_ROW.replace(/\n/g, eol)}`;
}
const USAGE_SEED_MESSAGES = 800;

function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfDay(now = Date.now()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}

function threadIdOf(sessionId) { return `${THREAD_PREFIX}${sessionId}`; }
function sessionIdOf(threadId) { return String(threadId || '').startsWith(THREAD_PREFIX) ? String(threadId).slice(THREAD_PREFIX.length) : null; }
function textOf(value) { return typeof value === 'string' ? value : ''; }
function parseJson(value) { try { if (value && typeof value === 'object') return value; return JSON.parse(value || '{}'); } catch { return {}; } }

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((block) => block?.type === 'text').map((block) => textOf(block.text)).filter(Boolean).join('\n');
}

function messageImages(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter((block) => block?.type === 'image').map((block) => {
    const raw = block.data || block.source?.data;
    const mime = block.mediaType || block.mimeType || block.source?.media_type || 'image/png';
    if (typeof raw !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mime)) return null;
    const data = raw.startsWith('data:image/') ? raw : `data:${mime};base64,${raw}`;
    if (data.length > 2_000_000 || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(data)) return null;
    return { mimeType: mime, data };
  }).filter(Boolean).slice(0, 4);
}

// DSH stores image blocks as attachment references, not base64. For a message
// sent from this phone, its rpcId identifies the exact original receipt and
// lets us restore a small preview without exposing its local path. Attachments
// sent outside khLink or already expired remain honest placeholders.
function receiptImages(receipt, imageCount) {
  const attachments = (receipt?.attachments || []).filter(isImageAttachment);
  if (!imageCount || attachments.length !== imageCount || imageCount > 4) return [];
  let remaining = 480_000;
  try {
    return attachments.map((attachment) => {
      const mime = String(attachment.mimeType || attachment.mediaType || '');
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(mime) || !attachment.path) throw new Error('preview unavailable');
      const stat = fs.statSync(attachment.path);
      if (!stat.isFile() || stat.size <= 0 || stat.size > remaining) throw new Error('preview unavailable');
      const bytes = fs.readFileSync(attachment.path);
      if (bytes.length !== stat.size) throw new Error('preview changed');
      remaining -= bytes.length;
      return { mimeType: mime, data: `data:${mime};base64,${bytes.toString('base64')}` };
    });
  } catch { return []; }
}

function assistantBlocks(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block && ['reasoning', 'text'].includes(block.type) && textOf(block.text).trim());
}

function toolKind(name, args) {
  const tool = String(name || '');
  if (tool === 'pwsh' || tool === 'bash') {
    return { type: 'commandExecution', text: [tool, textOf(args.command || args.CommandLine || args.command_line)].filter(Boolean).join('\n') || '命令' };
  }
  if (tool === 'read' || tool === 'glob' || tool === 'grep') {
    const target = args.file_path || args.path || args.pattern || '';
    return { type: 'mcpToolCall', text: [tool, target].filter(Boolean).join('\n') };
  }
  if (['write', 'edit', 'str_replace_editor', 'apply_patch'].includes(tool)) {
    const target = args.file_path || args.path || args.filePath || '';
    return { type: 'fileChange', text: [tool, target].filter(Boolean).join('\n') };
  }
  if (tool === 'web_search' || tool === 'web_fetch') {
    return { type: 'webSearch', text: [tool, args.query || args.url || ''].filter(Boolean).join('\n') || '网络搜索' };
  }
  if (tool === 'ask_user_question' || tool === 'ask_user') {
    const question = Array.isArray(args.questions) ? args.questions[0] : null;
    if (question?.question) {
      const labels = Array.isArray(question.options) ? question.options.map((option) => String(option.label || '')).filter(Boolean) : [];
      return { type: 'mcpToolCall', text: ['提问', String(question.question), labels.length ? `选项：${labels.join(' / ')}` : '', '（请在 DSH 桌面端回答）'].filter(Boolean).join('\n') };
    }
    return { type: 'mcpToolCall', text: '提问' };
  }
  if (tool === 'todo_write') return { type: 'mcpToolCall', text: '更新待办' };
  if (tool === 'list_agents' || tool === 'spawn_agent' || tool === 'send_message') return { type: 'collabAgentToolCall', text: tool };
  const summary = args.description || args.command || args.query || args.file_path || args.path || '';
  return { type: 'mcpToolCall', text: [tool || 'tool', summary].filter(Boolean).join('\n') };
}

function toolResultText(data) {
  const message = data?.message || data?.result?.message || data?.result || data;
  if (message && Array.isArray(message.content)) {
    return message.content.filter((block) => block?.type === 'text').map((block) => textOf(block.text)).filter(Boolean).join('\n');
  }
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') return JSON.stringify(message);
  return '';
}

function turnStatus(reason) {
  const kind = reason?.kind || reason || '';
  if (kind === 'error') return 'failed';
  if (kind === 'cancelled' || kind === 'interrupted') return 'interrupted';
  return 'completed';
}

function waitingFor(summary) {
  const active = summary?.projections?.values?.userQuestions?.active;
  const first = Array.isArray(active) ? active[0] : null;
  if (!first?.callId || !Array.isArray(first.questions) || !first.questions.length) return null;
  const questions = first.questions.map((question) => ({
    id: String(question.id || ''),
    question: String(question.question || ''),
    header: String(question.header || ''),
    multiSelect: Boolean(question.multiSelect),
    options: (Array.isArray(question.options) ? question.options : []).map((option) => ({ label: String(option.label || ''), description: String(option.description || '') })),
  })).filter((question) => question.question);
  if (!questions.length) return null;
  return {
    kind: 'question', tool: 'ask_user_question', requestId: `uq:${first.callId}`,
    summary: questions[0].question, description: String(first.questions[0]?.detail || ''), questions,
  };
}

// The live question projection remains empty while ask_user_question is
// blocking, so the pending tool call is the authoritative "waiting" signal.
// Its arguments were captured when the call row was ingested.
function pendingQuestionFor(meta) {
  const pending = Object.entries(meta?.pendingCalls || {}).find(([, value]) => String(value?.value?.tool || '') === 'ask_user_question');
  if (!pending) return null;
  const [callId] = pending;
  const raw = meta.pendingQuestions?.[callId];
  const questions = (Array.isArray(raw) ? raw : []).map((question) => ({
    id: String(question?.id || ''),
    question: String(question?.question || ''),
    header: String(question?.header || ''),
    multiSelect: Boolean(question?.multiSelect),
    options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({ label: String(option?.label || ''), description: String(option?.description || '') })),
  })).filter((question) => question.question);
  const list = questions.length ? questions : [{ id: callId, question: 'DSH 桌面端正在等待回答', header: '', multiSelect: false, options: [] }];
  return {
    kind: 'question', tool: 'ask_user_question', requestId: `uq:${callId}`,
    summary: list[0].question, description: '', questions: list,
  };
}

// Approval requests are written to the session audit log as
// `approval/asked` and `approval/decided`; unlike ask_user_question they do
// not appear in the `userQuestions` projection. Keep the pending approval in
// meta so the phone row and the desktop window agree while the card waits.
function pendingApprovalFor(meta) {
  const pending = Object.values(meta?.pendingApprovals || {}).filter((value) => value?.id);
  const first = pending[pending.length - 1];
  if (!first) return null;
  const summary = String(first.reason || first.toolName || 'DSH 桌面端正在等待审批');
  return {
    kind: 'approval', tool: 'approval', requestId: `ap:${first.id}`,
    summary, description: '', questions: [], toolName: String(first.toolName || ''),
  };
}

// Apply one `approval/asked` or `approval/decided` audit event. The same
// helper is used by the normal history stream and by the small tail probe
// that recovers a card already open when the connector starts.
function applyApprovalEvent(meta, event) {
  const data = event?.data || {};
  const id = String(data.id || '').trim();
  if (!id) return;
  if (event.type === 'approval/asked') {
    meta.pendingApprovals ||= {};
    meta.pendingApprovals[id] = {
      id, toolName: String(data.toolName || ''), callId: String(data.callId || ''),
      reason: String(data.reason || ''), askedAt: Number(event.time) || Date.now(),
    };
  } else if (event.type === 'approval/decided' && meta.pendingApprovals) {
    delete meta.pendingApprovals[id];
  }
}

const methods = {
  startDshSync() {
    if (this._dshTimer || !this.config?.configFile) return;
    this.dsh = new DshClient({ bridgeFile: this.config.dshBridgeFile || undefined });
    this.dshThreadsFile = path.join(path.dirname(this.config.configFile), 'dsh-threads.json');
    this.dshThreads = this.readDshThreads();
    this.dshOnline = false;
    this.dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.dshWorkspaceFile = path.join(this.dshHome, 'storages', 'workspace.json');
    this.dshWorkspace = { mtimeMs: 0, loaded: false, pinned: new Map(), archived: new Set() };
    this.dshUsage = this.emptyDshUsage();
    this.dshUsageSeq = new Map();
    this.dshBalanceFile = path.join(path.dirname(this.config.configFile), 'dsh-balance.json');
    this.dshBalance = this.readDshBalance();
    this._dshUsageSeeded = false;
    this.dshAccount = null;
    this.dshAccountAt = 0;
    this._dshUsageEmitAt = 0;
    // The Desktop API is only reachable through the bridge plugin. Install or
    // refresh it before the first poll; DSH's profile watcher mounts it live.
    this.ensureDshBridge().catch((error) => this.log(error));
    console.log(`[fengzhu-connect] dsh sync on (${this.dshThreads.size} known)`);
    const tick = () => this.pollDsh().catch((error) => this.log(error));
    this._dshTimer = setInterval(tick, POLL_MS);
    this._dshTimer.unref?.();
    tick();
  },

  // Copy the bridge package into $DSH_HOME/profiles/node_modules and add the
  // marked Desktop-profile row when it is absent. Idempotent; never rewrites
  // an unchanged file (which would make DSH reload the plugin for nothing).
  async ensureDshBridge() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const profile = path.join(home, 'profiles', 'desktop');
    if (!fs.existsSync(profile)) return { installed: false, reason: 'no-desktop-profile' };
    const source = path.join(__dirname, '..', '..', 'dsh-bridge');
    if (!fs.existsSync(path.join(source, 'index.js'))) return { installed: false, reason: 'bridge-source-missing' };
    const target = path.join(home, 'profiles', 'node_modules', 'kh-link-dsh-bridge');
    const names = ['package.json', 'index.js', 'README.md'];
    let copied = false;
    fs.mkdirSync(target, { recursive: true });
    for (const name of names) {
      const from = path.join(source, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(target, name);
      const next = fs.readFileSync(from);
      let current = null;
      try { current = fs.readFileSync(to); } catch {}
      if (current && current.equals(next)) continue;
      const temp = `${to}.kiru-${process.pid}.tmp`;
      fs.writeFileSync(temp, next, { mode: 0o600 });
      fs.renameSync(temp, to);
      copied = true;
    }
    const patch = path.join(profile, 'cordis.patch.yml');
    let patched = false;
    if (fs.existsSync(patch)) {
      const text = fs.readFileSync(patch, 'utf8');
      const next = withDshBridgeRow(text);
      if (next !== null && next !== text) {
        const temp = `${patch}.kiru-${process.pid}.tmp`;
        fs.writeFileSync(temp, next);
        fs.renameSync(temp, patch);
        patched = true;
      }
    }
    if (copied || patched) console.log(`[fengzhu-connect] dsh bridge ${copied ? 'updated' : 'present'}${patched ? ', profile row added' : ''}`);
    return { installed: true, copied, patched };
  },

  // DSH keeps the Desktop pin and archive sets in its workspace storage,
  // not in session/list. Reading that file makes a pin/archive made on the
  // desktop visible on the phone (and vice versa) within one poll.
  refreshDshWorkspace() {
    try {
      const stat = fs.statSync(this.dshWorkspaceFile);
      if (this.dshWorkspace?.loaded && this.dshWorkspace.mtimeMs === stat.mtimeMs) return;
      const raw = JSON.parse(fs.readFileSync(this.dshWorkspaceFile, 'utf8'));
      const pinnedIds = Array.isArray(raw?.global?.pinnedSessionIds) ? raw.global.pinnedSessionIds : [];
      const archivedIds = Array.isArray(raw?.global?.archivedSessionIds) ? raw.global.archivedSessionIds : [];
      this.dshWorkspace = {
        mtimeMs: stat.mtimeMs,
        loaded: true,
        pinned: new Map(pinnedIds.map((id, index) => [String(id), index])),
        archived: new Set(archivedIds.map(String)),
      };
    } catch {
      this.dshWorkspace = { mtimeMs: 0, loaded: false, pinned: new Map(), archived: new Set() };
    }
  },

  emptyDshUsage() {
    return { day: dayKey(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, updatedAt: 0 };
  },

  readDshBalance() {
    try { return JSON.parse(fs.readFileSync(this.dshBalanceFile, 'utf8')); } catch { return null; }
  },

  saveDshBalance() {
    try { writeFileAtomic(this.dshBalanceFile, JSON.stringify(this.dshBalance)); } catch (error) { this.log(error); }
  },

  // Today's spend is the wallet difference since the last balance observed
  // before this local day. A connector that runs across midnight therefore
  // reports the exact daily spend; a first-ever start mid-day reports spend
  // since that first reading (surfaced as spentSince).
  applyDshSpend(account) {
    const wallet = Array.isArray(account?.balance) ? account.balance[0] : null;
    const balance = Number(wallet?.balance);
    if (!wallet || !Number.isFinite(balance)) { account.spent = null; return; }
    const now = Date.now();
    const today = dayKey();
    const dayStart = startOfDay(now);
    let record = this.dshBalance;
    if (!record || record.day !== today) {
      let startBalance = balance;
      let since = now;
      if (record && record.currency === wallet.currency && Number.isFinite(Number(record.lastBalance))
        && record.lastAt && dayStart - Number(record.lastAt) < 36 * 60 * 60_000) {
        startBalance = Number(record.lastBalance);
        since = dayStart;
      }
      record = { day: today, startBalance, lastBalance: balance, currency: wallet.currency, since, lastAt: now };
    } else {
      record.lastBalance = balance;
      record.lastAt = now;
      record.currency = wallet.currency;
    }
    this.dshBalance = record;
    account.spent = Math.max(0, Number((Number(record.startBalance) - balance).toFixed(2)));
    account.spentCurrency = wallet.currency;
    account.spentSince = record.since;
    this.saveDshBalance();
  },

  ensureDshUsageDay() {
    const today = dayKey();
    if (this.dshUsage?.day === today) return;
    // Keep usageSeq: it only suppresses re-adding events already seen, and
    // sequence numbers continue across midnight.
    this.dshUsage = this.emptyDshUsage();
  },

  addUsageTo(target, usage) {
    if (!usage) return false;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    if (!input && !output && !cacheRead && !cacheWrite) return false;
    target.input += input; target.output += output;
    target.cacheRead += cacheRead; target.cacheWrite += cacheWrite;
    target.total += input + output + cacheRead + cacheWrite;
    target.updatedAt = Date.now();
    return true;
  },

  addDshUsage(sessionId, event) {
    if (!sessionId || event?.type !== 'assistant/message') return;
    const at = Number(event.time) || 0;
    if (at < startOfDay()) return;
    const seq = Number(event.seq) || 0;
    const previous = Number(this.dshUsageSeq?.get(sessionId) ?? -1);
    if (seq <= previous) return;
    this.ensureDshUsageDay();
    if (this.addUsageTo(this.dshUsage, event.data?.usage)) {
      this.dshUsageSeq.set(sessionId, seq);
      this.emitDshUsage();
    }
  },

  // First poll after a connector start: sum today's assistant usage from the
  // sessions that changed today. Later polls only add new assistant messages.
  async seedDshUsage(sessions) {
    const start = startOfDay();
    const usage = this.emptyDshUsage();
    const seq = new Map();
    for (const summary of sessions) {
      if (!summary?.sessionId || summary.origin === 'subagent' || summary.parentSessionId) continue;
      const sessionId = summary.sessionId;
      if ((Number(summary.updatedAt) || 0) < start) { seq.set(sessionId, -1); continue; }
      let page;
      try { page = await this.dsh.sessionPage(sessionId, summary.projections?.asOfSeq, USAGE_SEED_MESSAGES); }
      catch { continue; }
      let maxSeq = -1;
      for (const record of Array.isArray(page?.records) ? page.records : []) {
        const event = record?.event;
        if (!event) continue;
        maxSeq = Math.max(maxSeq, Number(event.seq) || 0);
        if (event.type === 'assistant/message' && (Number(event.time) || 0) >= start) this.addUsageTo(usage, event.data?.usage);
      }
      seq.set(sessionId, maxSeq);
    }
    this.dshUsage = usage;
    this.dshUsageSeq = seq;
    this._dshUsageSeeded = true;
    this.emitDshUsage(true);
  },

  async refreshDshAccount() {
    if (this._dshAccountLoading) return;
    this._dshAccountLoading = true;
    try {
      const state = await this.dsh.accountState();
      if (state?.status !== 'credential-stored') {
        this.dshAccount = { status: state?.status || 'signed-out', at: Date.now() };
      } else {
        const client = {
          version: CONNECTOR_VERSION,
          locale: 'zh-CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
        const [profile, balance] = await Promise.all([
          this.dsh.accountProfile(client).catch(() => null),
          this.dsh.accountBalance(client).catch(() => null),
        ]);
        this.dshAccount = {
          status: 'credential-stored',
          name: profile?.value?.name || null,
          contact: profile?.value?.contact || null,
          balance: balance?.status === 'ready' ? balance.value || [] : [],
          bonusWallets: balance?.status === 'ready' ? balance.bonusWallets || [] : [],
          balanceStatus: balance?.status || 'unknown',
          at: Date.now(),
        };
        this.applyDshSpend(this.dshAccount);
      }
      this.dshAccountAt = Date.now();
      this.emitDshUsage(true);
    } catch (error) {
      this.log(error);
    } finally { this._dshAccountLoading = false; }
  },

  dshUsageState() {
    const usage = this.dshUsage || this.emptyDshUsage();
    return {
      backend: 'dsh',
      day: usage.day,
      today: {
        input: usage.input, output: usage.output,
        cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.total,
      },
      account: this.dshAccount,
      spent: this.dshAccount?.spent ?? null,
      spentCurrency: this.dshAccount?.spentCurrency || this.dshAccount?.balance?.[0]?.currency || 'CNY',
      spentSince: this.dshAccount?.spentSince || null,
      updatedAt: Math.max(usage.updatedAt || 0, this.dshAccount?.at || 0),
    };
  },

  emitDshUsage(force = false) {
    if (this.stopping || !this.isConnected?.()) return;
    const now = Date.now();
    if (!force && now - (this._dshUsageEmitAt || 0) < 5_000) return;
    this._dshUsageEmitAt = now;
    this.emit('dsh.usage', null, this.dshUsageState());
  },

  readDshThreads() {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(this.dshThreadsFile, 'utf8')))); } catch { return new Map(); }
  },

  saveDshThreads() {
    try { writeFileAtomic(this.dshThreadsFile, JSON.stringify(Object.fromEntries(this.dshThreads))); } catch (error) { this.log(error); }
  },

  dshIndexValue(id, meta) {
    return {
      id, title: meta.title || 'DeepSeek 会话', cwd: meta.cwd || '',
      status: this.dshThreadStatus(meta), updatedAt: meta.updatedAt || Date.now(), activityAt: meta.activityAt ?? meta.updatedAt ?? 0,
      note: meta.waiting?.summary || '', waiting: this.dshPhoneWaiting(meta.waiting),
      backend: 'dsh', archived: Boolean(meta.archived), pinned: Boolean(meta.pinned),
      pinOrder: Number.isFinite(meta.pinOrder) ? meta.pinOrder : -1,
      unread: Boolean(meta.unread) && !meta.running, origin: 'desktop', model: meta.model || '',
      ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    };
  },

  // An approval goes to the phone as a permission prompt (tool + reason), so
  // it shows 允许一次 / 拒绝; dsh.answer clicks the same buttons on the desktop
  // card. The row keeps its approval status, which raises the phone's alert.
  dshPhoneWaiting(waiting) {
    if (!waiting || waiting.kind !== 'approval') return waiting || null;
    return {
      kind: 'permission', tool: waiting.toolName || 'DeepSeek', requestId: waiting.requestId,
      summary: waiting.summary || 'DSH 桌面端正在等待审批', description: '', questions: [], autoOption: false,
    };
  },

  dshThreadStatus(meta) {
    if (meta.waiting) return meta.waiting.kind === 'approval' ? 'desktop_waiting_approval' : 'desktop_waiting_answer';
    return meta.running ? 'desktop_running' : meta.terminalStatus || 'completed';
  },

  async uploadDshIndex(id, meta, indexChanged = false) {
    const value = this.dshIndexValue(id, meta);
    // The same row again costs traffic and makes every phone reload its list.
    const digest = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
    if (meta.indexDigest === digest && !indexChanged) return;
    const encrypted = encryptJson(this.config.accountKey, 'history.thread', id, id, value);
    // The relay orders and versions the list row by this updatedAt. Pin,
    // archive and wait-state changes must use a fresh one or the phone keeps
    // the old encrypted row even though the workspace/connector already moved.
    const indexUpdatedAt = indexChanged ? Date.now() : value.updatedAt;
    await this.api.request(this.api.path('/history/threads'), { method: 'PUT', body: { id, archived: value.archived, updatedAt: indexUpdatedAt, ...encrypted } });
    meta.indexDigest = digest;
  },

  async uploadDshItems(id, items) {
    let batch = []; let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.putHistoryItems(id, batch);
      batch = []; bytes = 0;
    };
    for (const item of items) {
      const value = { ...item.value, ...clip(item.value.text || '', 32 * 1024) };
      // A single history item must also fit the relay's request limit. Keep a
      // bounded preview budget; the receipt check already used the raw event.
      if (Array.isArray(value.images)) {
        let remaining = 650_000;
        value.images = value.images.filter((image) => {
          const size = String(image?.data || '').length;
          if (!size || size > remaining) return false;
          remaining -= size; return true;
        });
      }
      const row = { id: item.id, order: item.order, createdAt: item.at || Date.now(), ...await this.historyItemFrame(id, item.id, value) };
      const size = row.ciphertext.length + 200;
      if (batch.length >= UPLOAD_BATCH || (batch.length && bytes + size > UPLOAD_BATCH_BYTES)) await flush();
      batch.push(row); bytes += size;
    }
    await flush();
  },

  async pollDsh(forceId = null) {
    if (this._dshPolling || this.stopping || !this.config.accountKey) return;
    this._dshPolling = true;
    try {
      let sessions;
      try {
        sessions = await this.dsh.sessionList();
        if (!this.dshOnline) { this.dshOnline = true; this.emit?.('connector.presence', null, this.presencePayload()); }
      } catch (error) {
        this.dshOnline = false;
        // The bridge plugin may have just been installed (or DSH just started).
        // Retry the installer occasionally; it is cheap when nothing changed.
        if (error.code === 'bridge-missing' && Date.now() - (this._dshBridgeCheckedAt || 0) > 60_000) {
          this._dshBridgeCheckedAt = Date.now();
          this.ensureDshBridge().catch((installError) => this.log(installError));
        }
        // One failed poll is not enough to grey the tab: only a definite
        // "no Host" is reported, and ordinary reads stay quiet.
        // A PC without DSH at all is normal, not an error worth a stack trace.
        if (!this._dshOfflineLogged) {
          const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
          if (fs.existsSync(home)) this.log(new Error(`dsh: ${error.message}`));
          else console.log('[fengzhu-connect] DSH not installed; DeepSeek Harness sync idle');
          this._dshOfflineLogged = true;
        }
        return;
      }
      this._dshOfflineLogged = false;
      this.refreshDshWorkspace();
      if (!this._dshUsageSeeded) {
        // Seed before the history loop so both share the day's boundary and
        // the per-session sequence guards.
        try { await this.seedDshUsage(sessions); }
        catch (error) { this._dshUsageSeeded = true; this.log(error); }
      }
      if (Date.now() - (this.dshAccountAt || 0) > ACCOUNT_REFRESH_MS) {
        this.refreshDshAccount().catch((error) => this.log(error));
      }
      let changed = false;
      for (const summary of sessions) {
        if (!summary?.sessionId || summary.origin === 'subagent' || summary.parentSessionId) continue;
        try { if (await this.syncDshSession(summary, summary.sessionId === sessionIdOf(forceId) || forceId === summary.sessionId)) changed = true; }
        catch (error) { this.log(new Error(`dsh ${summary.sessionId}: ${error.message}`)); }
      }
      if (changed) { this.saveDshThreads(); this.emit('threads.updated', null, { updatedAt: Date.now() }); }
    } finally { this._dshPolling = false; }
  },

  // Read one older ask_user_question tool call and cache the questions it
  // carried. Only used when a pending call has no cached arguments.
  async recoverDshQuestion(sessionId, meta, callId) {
    if (!sessionId || !callId) return false;
    try {
      const page = await this.dsh.sessionPage(sessionId, Number(meta.syncedSeq) || 0, 80);
      const record = (page?.records || []).find((item) => {
        const event = item?.event;
        const data = event?.data || {};
        return event?.type === 'tool/call' && String(data.callId || '') === callId
          && String(data.name || '') === 'ask_user_question';
      });
      const args = parseJson(record?.event?.data?.arguments);
      if (!Array.isArray(args?.questions)) return false;
      meta.pendingQuestions ||= {};
      meta.pendingQuestions[callId] = args.questions;
      return true;
    } catch (error) {
      this.log?.(error);
      return false;
    }
  },

  // On connector start the persisted `syncedSeq` can already be past an
  // approval/asked event, so the normal incremental page will never see the
  // open card. Read only the tail (maxMessages=2 returns the last few
  // records) while a session is running and recover any open approval.
  async probeDshApproval(meta, summary) {
    if (!summary?.running || meta.waiting || meta.permissionMode === 'danger-full-access') return;
    const now = Date.now();
    if (now - (meta.approvalProbeAt || 0) < 5_000) return;
    meta.approvalProbeAt = now;
    let page;
    try { page = await this.dsh.sessionPage(meta.sessionId, Number(summary.projections?.asOfSeq) || 0, 2); }
    catch { return; }
    for (const record of page?.records || []) {
      const event = record?.event;
      if (event?.type === 'approval/asked' || event?.type === 'approval/decided') applyApprovalEvent(meta, event);
    }
  },

  async syncDshSession(summary, force = false) {    const sessionId = summary.sessionId;
    const id = threadIdOf(sessionId);
    const meta = this.dshThreads.get(id) || { sessionId, syncedSeq: -1, pendingCalls: {}, pendingApprovals: {}, itemsSchema: ITEMS_SCHEMA };
    const schemaReplay = (meta.itemsSchema || 1) < ITEMS_SCHEMA;
    if (schemaReplay) { meta.syncedSeq = -1; meta.pendingCalls = {}; meta.pendingApprovals = {}; meta.itemsSchema = ITEMS_SCHEMA; }
    let reconciledReceipts = 0;
    const asOf = Number(summary.projections?.asOfSeq);
    const throughSeq = Number.isFinite(asOf) && asOf >= 0 ? asOf : Math.max(0, Number(meta.syncedSeq) || 0);
    const contentChanged = force || throughSeq > Number(meta.syncedSeq ?? -1);
    if (!contentChanged) await this.probeDshApproval(meta, summary);
    let waiting = waitingFor(summary) || pendingQuestionFor(meta) || pendingApprovalFor(meta);
    // Older pending calls predate the cached questions. Pull their tool/call
    // argument once so the phone can show the actual question, not just that
    // something is waiting.
    if (waiting?.requestId?.startsWith('uq:') && waiting.questions?.[0]?.question === 'DSH 桌面端正在等待回答') {
      const callId = waiting.requestId.slice(3);
      if (await this.recoverDshQuestion(sessionId, meta, callId)) waiting = pendingQuestionFor(meta);
    }
    const waitingChanged = (waiting?.requestId || null) !== (meta.waiting?.requestId || null);
    const waitingSummaryChanged = (waiting?.summary || '') !== (meta.waiting?.summary || '');
    const title = textOf(summary.projections?.values?.title) || meta.title || '';
    const modelSelection = summary.projections?.values?.modelSelection?.next;
    const model = modelSelection ? `${modelSelection.provider}/${modelSelection.model}` : (meta.model || '');
    const effort = modelSelection?.reasoningEffort || meta.effort || '';
    const permissionMode = summary.projections?.values?.permissions?.currentValue || meta.permissionMode || '';
    const workspace = this.dshWorkspace;
    const workspaceLoaded = workspace?.loaded === true;
    const pinIndex = workspaceLoaded ? workspace.pinned.get(sessionId) : undefined;
    const pinned = workspaceLoaded ? pinIndex !== undefined : Boolean(meta.pinned);
    const pinOrder = workspaceLoaded ? (pinIndex ?? -1) : (Number.isFinite(meta.pinOrder) ? meta.pinOrder : -1);
    const archived = workspaceLoaded ? workspace.archived.has(sessionId) : Boolean(meta.archived);
    const labelChanged = meta.title !== title || Boolean(meta.running) !== Boolean(summary.running) || Boolean(meta.unread) !== false || meta.model !== model || meta.permissionMode !== permissionMode
      || meta.effort !== effort || waitingSummaryChanged
      || Boolean(meta.pinned) !== pinned || meta.pinOrder !== pinOrder || Boolean(meta.archived) !== archived;
    // A newer connector may publish the same waiting row in a new shape (a
    // DSH approval with its tool and reason): send it again once.
    const waitingShapeChanged = Boolean(waiting) && JSON.stringify(waiting) !== JSON.stringify(meta.waiting);
    if (!contentChanged && !waitingChanged && !labelChanged && !waitingShapeChanged) return false;

    meta.waiting = waiting;
    Object.assign(meta, {
      sessionId, title, cwd: summary.cwd || meta.cwd || '', updatedAt: Number(summary.updatedAt) || Date.now(),
      running: Boolean(summary.running), model, effort, permissionMode, unread: false,
      pinned, pinOrder, archived,
      activityAt: Math.max(Number(meta.activityAt) || 0, Number(summary.updatedAt) || 0),
    });

    const indexChanged = waitingChanged || waitingSummaryChanged || waitingShapeChanged || meta.title !== title
      || Boolean(meta.pinned) !== pinned || Boolean(meta.archived) !== archived;
    // The item table references the thread row, so the index row must exist
    // before the first history batch of a newly discovered session.
    await this.uploadDshIndex(id, meta, indexChanged);

    if (contentChanged) {
      let page;
      try {
        page = await this.dsh.sessionPage(sessionId, throughSeq, meta.syncedSeq > -1 ? 300 : FIRST_SYNC_MESSAGES);
      } catch (error) {
        // DSH can answer 500 when a just-appended event races the page
        // boundary; one short retry sees the settled log.
        if (Number(error.status) !== 500) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
        page = await this.dsh.sessionPage(sessionId, throughSeq, meta.syncedSeq > -1 ? 300 : FIRST_SYNC_MESSAGES);
      }
      const records = Array.isArray(page?.records) ? page.records : [];
      const maxSeq = records.reduce((max, record) => Math.max(max, Number(record?.event?.seq) || 0), Number(meta.syncedSeq) || -1);
      const fresh = meta.syncedSeq > -1 ? records.filter((record) => Number(record?.event?.seq) > meta.syncedSeq) : records;
      const items = [];
      for (const record of fresh) {
        const event = record?.event;
        if (!event || typeof event.type !== 'string') continue;
        const produced = this.dshItemsForEvent(id, meta, event);
        for (const item of produced) items.push(item);
        if (event.type === 'turn/end') meta.terminalStatus = turnStatus(event.data?.reason);
      }
      if (items.length) reconciledReceipts = this.reconcileSendReceipts?.('dsh', id, items) || 0;
      if (items.length) {
        // A tool result updates its call's row; upload the last value once.
        const unique = new Map();
        for (const item of items) unique.set(item.id, item);
        await this.uploadDshItems(id, [...unique.values()]);
      }
      // A session's own events can end well below the summary's asOfSeq (seen:
      // events to 206, asOfSeq 28165). The page read up to asOfSeq is the
      // whole story, so count it as synced there; otherwise the session looked
      // changed on every poll and re-uploaded its list row each time
      // (2026-11-05: 59 sessions, ~3,500 uploads an hour of free traffic).
      meta.syncedSeq = Math.max(Number(meta.syncedSeq) || -1, maxSeq, throughSeq);
      if (items.length) this.emit('history.updated', id, { threadId: id, itemCount: items.length, updatedAt: Math.max(...items.map((item) => Number(item.at) || 0), 0) || Date.now(), backend: 'dsh' });
    }

    // The approval audit event may have been discovered in the page read
    // above. Publish the waiting row immediately instead of waiting for the
    // next five-second poll, so the phone does not briefly show "running"
    // while the desktop is already showing an approval card.
    const discoveredApproval = pendingApprovalFor(meta);
    if (discoveredApproval && meta.waiting?.kind !== 'question' && meta.waiting?.requestId !== discoveredApproval.requestId) {
      meta.waiting = discoveredApproval;
      await this.uploadDshIndex(id, meta, true);
    }

    this.dshThreads.set(id, meta);
    const liveStatus = this.dshThreadStatus(meta);
    const alreadyAnnounced = meta.announcedStatus === liveStatus;
    // A late followup.started clears the phone queue but also marks the chat
    // running. If the turn had already ended, restore its true status after
    // that receipt, quietly so replay cannot create a second notification.
    const restoreAfterReplay = liveStatus !== 'desktop_running' && (schemaReplay || reconciledReceipts > 0);
    if (!alreadyAnnounced || restoreAfterReplay || (liveStatus === 'desktop_running' && Date.now() - (meta.announcedAt || 0) > 15_000)) {
      meta.announcedStatus = liveStatus; meta.announcedAt = Date.now();
      this.emit('thread.status', id, { threadId: id, status: liveStatus, backend: 'dsh', updatedAt: Date.now(), ...(alreadyAnnounced && restoreAfterReplay ? { quiet: true } : {}) });
    }
    this.saveDshThreads();
    return true;
  },

  // One DSH session event -> zero or more encrypted history items. Stable ids
  // and orders make a tool result an update of its call rather than a second row.
  dshItemsForEvent(threadId, meta, event) {
    const seq = Number(event.seq) || 0;
    const at = Number(event.time) || Date.now();
    const items = [];
    const push = (suffix, order, value) => items.push({ id: `${threadId}-${seq}${suffix}`, order: seq * 20 + order, at, value });
    const data = event.data || {};
    if (event.type === 'approval/asked' || event.type === 'approval/decided') {
      applyApprovalEvent(meta, event);
      return items;
    }
    if (event.type === 'user/message') {
      const kind = data.source?.kind;
      if (kind !== 'user') return items;
      const message = data.message || data;
      const text = messageText(message); let images = messageImages(message);
      const imageCount = Array.isArray(message.content) ? message.content.filter((block) => block?.type === 'image').length : 0;
      const rpcId = typeof data.source?.rpcId === 'string' ? data.source.rpcId : '';
      const receipt = rpcId ? this.sendReceipts?.get(rpcId) : null;
      if (!images.length && receipt?.backend === 'dsh' && receipt.threadId === threadId) images = receiptImages(receipt, imageCount);
      if (text.trim() || imageCount) {
        push('', 1, { type: 'userMessage', text: text || (images.length ? '图片附件' : '图片附件（预览不可用）'), status: null, createdAt: at, ...(images.length ? { images } : {}) });
        // Internal only: uploadDshItems serializes item.value, never these fields.
        items[0].receiptRequestId = rpcId;
        items[0].receiptImageCount = imageCount;
      }
      return items;
    }
    if (event.type === 'assistant/message') {
      this.addDshUsage?.(sessionIdOf(threadId), event);
      const blocks = assistantBlocks(data.message);
      let index = 0;
      for (const block of blocks) {
        if (block.type === 'reasoning') push(`-r${index}`, 2 + index, { type: 'reasoning', text: textOf(block.text), status: null, createdAt: at });
        else push(`-t${index}`, 2 + index, { type: 'agentMessage', text: textOf(block.text), status: null, createdAt: at });
        index += 1;
      }
      return items;
    }
    if (event.type === 'tool/call') {
      const args = parseJson(data.arguments);
      const kind = toolKind(data.name, args);
      const item = { id: `${threadId}-${seq}`, order: seq * 20 + 3, at, value: { type: kind.type, text: kind.text, status: 'inProgress', createdAt: at, tool: String(data.name || 'tool'), callId: String(data.callId || '') } };
      meta.pendingCalls ||= {};
      meta.pendingCalls[String(data.callId || '')] = { id: item.id, order: item.order, at, value: item.value };
      if (String(data.name || '') === 'ask_user_question' && Array.isArray(args?.questions)) {
        meta.pendingQuestions ||= {};
        meta.pendingQuestions[String(data.callId || '')] = args.questions;
      }
      items.push(item);
      return items;
    }
    if (event.type === 'tool/result') {
      const callId = String(data.message?.toolCallId || data.toolCallId || data.callId || '');
      const pending = meta.pendingCalls?.[callId];
      if (!pending) return items;
      const result = toolResultText(data);
      const failed = data.message?.isError === true || data.isError === true;
      const value = {
        ...pending.value,
        ...(result.trim() ? { text: `${pending.value.text}\n\n${clip(result.trim(), 8 * 1024).text}` } : {}),
        status: failed ? 'failed' : 'completed',
      };
      items.push({ id: pending.id, order: pending.order, at, value });
      delete meta.pendingCalls[callId];
      if (meta.pendingQuestions) delete meta.pendingQuestions[callId];
      return items;
    }
    if (event.type === 'turn/end') {
      const status = turnStatus(data.reason);
      meta.terminalStatus = status;
      meta.running = false;
      meta.pendingCalls = {};
      meta.pendingQuestions = {};
      meta.pendingApprovals = {};
      return items;
    }
    if (event.type === 'session/title') {
      const title = textOf(data.title);
      if (title) meta.title = title;
      return items;
    }
    if (event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy') {
      return items;
    }
    return items;
  },

  dshActiveThreadRows() {
    const rows = [];
    for (const [threadId, meta] of this.dshThreads || []) {
      if (meta.archived || !(meta.running || meta.waiting)) continue;
      rows.push({ threadId, status: this.dshThreadStatus(meta), updatedAt: meta.announcedAt || meta.updatedAt || Date.now() });
    }
    return rows;
  },

  announceDshRunning(id) {
    const meta = this.dshThreads.get(id);
    if (!meta || meta.announcedStatus === 'desktop_running') return;
    meta.running = true; meta.announcedStatus = 'desktop_running';
    this.emit('thread.status', id, { threadId: id, status: 'desktop_running', backend: 'dsh', updatedAt: Date.now() });
  },

  watchDshTurn(id) {
    this.announceDshRunning(id);
    this._dshWatched ||= new Map();
    const startedAt = Date.now();
    if (this._dshWatched.has(id)) { this._dshWatched.get(id).startedAt = startedAt; return; }
    const watch = { startedAt, idleChecks: 0 };
    this._dshWatched.set(id, watch);
    const tick = async () => {
      if (this.stopping) { this._dshWatched.delete(id); return; }
      await this.pollDsh(id).catch((error) => this.log(error));
      const current = this.dshThreads.get(id);
      const active = current?.running || current?.waiting;
      watch.idleChecks = active ? 0 : watch.idleChecks + 1;
      if ((watch.idleChecks >= 2 && Date.now() - watch.startedAt > 3_000) || Date.now() - watch.startedAt > 30 * 60_000) { this._dshWatched.delete(id); return; }
      setTimeout(tick, ACTIVE_POLL_MS).unref?.();
    };
    setTimeout(tick, 600).unref?.();
  },

  nudgeDsh(delays = [800, 2500, 6000]) { for (const wait of delays) setTimeout(() => this.pollDsh().catch((error) => this.log(error)), wait).unref?.(); },

  dshAttachmentParts(args) {
    const parts = typeof this.claudeAttachmentParts === 'function' ? this.claudeAttachmentParts(args) : { text: String(args.text || ''), images: [] };
    return { text: parts.text || '', images: (parts.images || []).map((image) => ({ mediaType: image.mediaType || 'image/png', data: image.data, name: image.name })).filter((image) => image.data) };
  },

  // DSH has no remote channel for its live question/approval cards; drive the
  // already-open desktop window through UI Automation instead. The script
  // returns one JSON line; any noisy PowerShell output is ignored.
  async runDshUia(action, meta, option = '', labels = null) {
    const script = path.join(__dirname, '..', '..', 'scripts', 'dsh-answer.ps1');
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Action', action, '-SessionTitle', String(meta?.title || ''),
      '-TimeoutSeconds', action === 'list' ? '8' : '15'];
    if (option) args.push('-Option', String(option));
    // One label per question page of a card with several questions.
    let answersFile = null;
    if (Array.isArray(labels) && labels.length) {
      answersFile = path.join(os.tmpdir(), `kh-link-dsh-answers-${crypto.randomUUID()}.json`);
      fs.writeFileSync(answersFile, JSON.stringify(labels.map(String)), { encoding: 'utf8', mode: 0o600 });
      args.push('-AnswersFile', answersFile);
    }
    let stdout; let stderr;
    try { ({ stdout, stderr } = await (this.dshExecFile || execFileAsync)(process.env.DSH_PWSH || 'pwsh', args, { timeout: 25_000 + 5_000 * (labels?.length || 0), windowsHide: true })); }
    finally { if (answersFile) fs.rm(answersFile, { force: true }, () => {}); }
    const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let result;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { result = JSON.parse(lines[index]); break; } catch { /* keep the last valid JSON line */ }
    }
    if (!result) throw new Error(`DSH 桌面端没有返回可读结果${stderr ? `：${String(stderr).trim().slice(0, 200)}` : ''}`);
    // A session whose folder is not a DSH project is not in the desktop's
    // sidebar, so its card cannot be reached from here.
    if (!result.ok && /^DSH session not found/.test(String(result.error || ''))) throw new Error('DSH 桌面端左侧列表里没有这个会话，请在电脑上处理');
    if (!result.ok) throw new Error(result.error || 'DSH 桌面端没有响应');
    return result;
  },

  async dshCommand(payload) {
    const args = payload.args || {};
    const id = args.threadId;
    const meta = id ? this.dshThreads.get(id) : null;
    const action = payload.action || '';
    if (action === 'dsh.pending') {
      if (!meta) throw new Error('没有找到这个 DeepSeek 会话');
      return { ...(await this.runDshUia('list', meta)), threadId: id, backend: 'dsh' };
    }
    if (action === 'dsh.answer') {
      if (!meta) throw new Error('没有找到这个 DeepSeek 会话');
      const option = String(args.option || '').trim();
      if (!option) throw new Error('请选择一个答案');
      return { ...(await this.runDshUia('answer', meta, option)), threadId: id, backend: 'dsh' };
    }
    let state;
    try { state = await this.dsh.probe(); } catch { state = 'down'; }
    if (state !== 'up' && !/^dsh\./.test(action) && (BACKGROUND_READ.test(action) || action === 'history.sync')) {
      if (action === 'followup.list') return { items: [] };
      return { backend: 'dsh', offline: true };
    }
    if (state !== 'up') {
      if (action === 'followup.list') return { items: [] };
      throw Object.assign(new Error(DSH_OFFLINE), { delivery: 'not_sent' });
    }
    // A folder typed on the phone as "I:/tmp/x" is stored by DSH as written;
    // use the Windows form the desktop itself uses, so one folder is one
    // project there.
    const cwd = meta?.cwd || normalizeDshCwd(args.cwd);
    switch (action) {
      case 'history.sync': {
        await this.pollDsh(id || null);
        return { synced: true, threadId: id, backend: 'dsh' };
      }
      case 'thread.new':
      case 'thread.newWithTurn': {
        if (!cwd) throw new Error('请填写工作目录');
        const created = await this.dsh.create({ cwd, agentPreset: args.agentPreset || undefined });
        const sessionId = created?.sessionId;
        if (!sessionId) throw new Error('DeepSeek Harness 没有返回新会话');
        const newId = threadIdOf(sessionId);
        this.dshThreads.set(newId, { sessionId, cwd, syncedSeq: -1, title: '', updatedAt: Date.now(), itemsSchema: ITEMS_SCHEMA });
        this.saveDshThreads();
        if (String(args.text || '').trim() || args.attachments?.length) {
          const parts = this.dshAttachmentParts(args);
          await this.dsh.prompt(sessionId, { text: parts.text, images: parts.images, requestId: payload.requestId || args.requestId || crypto.randomUUID(), mode: 'queue' });
          this.watchDshTurn(newId);
        } else this.nudgeDsh();
        return { thread: { id: newId }, threadId: newId, backend: 'dsh' };
      }
      case 'turn.start':
      case 'followup.enqueue':
      case 'turn.steer': {
        if (!meta) throw Object.assign(new Error('没有找到这个 DeepSeek 会话'), { delivery: 'not_sent' });
        const parts = this.dshAttachmentParts(args);
        const mode = action === 'turn.steer' || args.mode === 'steer' ? 'steer' : 'queue';
        await this.dsh.prompt(meta.sessionId, { text: parts.text, images: parts.images, requestId: payload.requestId || args.requestId || crypto.randomUUID(), mode });
        this.watchDshTurn(id);
        return { accepted: true, queued: mode === 'queue' && Boolean(meta.running), backend: 'dsh' };
      }
      case 'turn.stop': {
        if (!meta) throw new Error('没有找到这个 DeepSeek 会话');
        await this.dsh.cancel(meta.sessionId);
        this.nudgeDsh();
        return { stopped: true, backend: 'dsh' };
      }
      case 'thread.rename': {
        if (!meta) throw new Error('没有找到这个 DeepSeek 会话');
        const title = String(args.title || args.name || '').trim();
        if (!title) throw new Error('标题不能为空');
        const result = await this.dsh.rename(meta.sessionId, title);
        meta.title = result?.title || meta.title;
        await this.uploadDshIndex(id, meta, true);
        this.saveDshThreads();
        return { renamed: true, title: meta.title, backend: 'dsh' };
      }
      case 'thread.archive': {
        if (!meta) throw new Error('没有找到这个 DeepSeek 会话');
        const result = args.archived
          ? await this.dsh.archiveSession(meta.sessionId, true)
          : await this.dsh.unarchiveSession(meta.sessionId);
        if (Array.isArray(result?.archivedSessionIds)) {
          this.dshWorkspace = { ...this.dshWorkspace, loaded: true, archived: new Set(result.archivedSessionIds.map(String)) };
        }
        meta.archived = Boolean(args.archived);
        await this.uploadDshIndex(id, meta, true);
        this.saveDshThreads();
        this.emit('threads.updated', null, { updatedAt: Date.now() });
        return { archived: meta.archived, backend: 'dsh' };
      }
      case 'thread.pin': {
        if (!meta) throw new Error('没有找到这个 DeepSeek 会话');
        const result = args.pinned
          ? await this.dsh.pinSession(meta.sessionId)
          : await this.dsh.unpinSession(meta.sessionId);
        const ids = Array.isArray(result?.pinnedSessionIds) ? result.pinnedSessionIds.map(String) : [];
        this.dshWorkspace = { ...this.dshWorkspace, loaded: true, pinned: new Map(ids.map((sessionId, index) => [sessionId, index])) };
        meta.pinned = Boolean(args.pinned);
        meta.pinOrder = ids.indexOf(meta.sessionId);
        await this.uploadDshIndex(id, meta, true);
        this.saveDshThreads();
        // Push a list refresh so the phone moves the row immediately; the
        // workspace API already persisted the pin for the desktop.
        this.emit('threads.updated', null, { updatedAt: Date.now() });
        return { pinned: meta.pinned, pinOrder: meta.pinOrder, pinnedSessionIds: ids, backend: 'dsh' };
      }
      case 'dsh.usage': {
        if (!this._dshUsageSeeded) {
          try { await this.seedDshUsage(await this.dsh.sessionList()); }
          catch (error) { this._dshUsageSeeded = true; this.log(error); }
        }
        await this.refreshDshAccount().catch((error) => this.log(error));
        return this.dshUsageState();
      }
      case 'settings.get':
      case 'thread.settings.read': {
        const catalog = await this.dsh.modelCatalog().catch(() => null);
        const permissionCatalog = await this.dsh.permissionCatalog().catch(() => null);
        return { backend: 'dsh', settings: { model: meta?.model || '', effort: meta?.effort || '', permissionMode: meta?.permissionMode || '' }, catalog, permissionCatalog };
      }
      case 'settings.set': {
        if (!meta) throw new Error('没有找到这个 DeepSeek 会话');
        const settings = args.settings || args;
        const model = String(settings.model || '').trim();
        const preset = String(settings.permissionMode || settings.permissionPreset || '').trim();
        if (!model.includes('/') && !preset) throw new Error('请选择一个模型或权限模式');
        if (preset) {
          const result = await this.dsh.executeCommand(meta.sessionId, `/permission ${preset}`);
          const outcome = result?.result;
          if (outcome?.kind && outcome.kind !== 'success') {
            throw new Error(outcome.text || outcome.message || 'DSH 没有接受这个权限模式');
          }
          meta.permissionMode = preset;
        }
        if (model.includes('/')) {
          const [provider, ...rest] = model.split('/');
          const effort = String(settings.effort || settings.reasoningEffort || '').trim();
          const result = await this.dsh.selectModel(meta.sessionId, { provider, model: rest.join('/'), ...(effort ? { reasoningEffort: effort } : {}) });
          const selected = result?.selected || { provider, model: rest.join('/') };
          meta.model = `${selected.provider}/${selected.model}`;
          meta.effort = selected.reasoningEffort || '';
        }
        await this.uploadDshIndex(id, meta, true);
        this.saveDshThreads();
        this.emit('thread.settings', id, { threadId: id, settings: { model: meta.model || '', effort: meta.effort || '', permissionMode: meta.permissionMode || '' }, updatedAt: Date.now(), source: 'dsh' });
        return { saved: true, backend: 'dsh', model: meta.model || '', effort: meta.effort || '', permissionMode: meta.permissionMode || '' };
      }
      case 'claude.desktop.answer': {
        if (!meta?.waiting?.requestId?.startsWith('uq:')) return { ok: false, error: '这个问题已经在别处回答过了' };
        const callId = meta.waiting.requestId.slice(3);
        const given = Array.isArray(args.answers) ? args.answers : [];
        const answers = meta.waiting.questions.map((question, index) => {
          const answer = given[index] || {};
          const labels = Array.isArray(answer.labels) ? answer.labels : [];
          const selected = labels.filter((label) => question.options.some((option) => option.label === label));
          const custom = String(answer.other || '').trim();
          return { id: question.id, selected, ...(custom ? { custom } : {}) };
        });
        const continued = await this.dsh.answerQuestion(meta.sessionId, callId, answers);
        if (!continued) {
          // DSH's Host can lose a question its window still shows (2026-11-05:
          // the card stayed open for hours and userQuestions/answer returned
          // false). Answer it on the desktop card instead, page by page.
          if (answers.some((answer) => answer.custom || answer.selected.length !== 1)) {
            return { ok: false, error: 'DSH 没有接收这个回答；自己写的答案或多选请在电脑上回答', backend: 'dsh' };
          }
          await this.runDshUia('answer', meta, '', answers.map((answer) => answer.selected[0]));
        }
        this.nudgeDsh();
        return { ok: true, continued: true, backend: 'dsh' };
      }
      case 'followup.list': return { items: [] };
      default:
        if (BACKGROUND_READ.test(action)) return { backend: 'dsh' };
        throw new Error(`DeepSeek Harness 暂不支持这个操作：${action}`);
    }
  },
};

function normalizeDshCwd(value) {
  const text = String(value || '').trim();
  if (!text || process.platform !== 'win32') return text;
  const normalized = path.win32.normalize(text);
  // "I:\tmp\x\" and "I:\tmp\x" are one project; a drive root stays "I:\".
  return /^[A-Za-z]:\x5c$/.test(normalized) ? normalized : normalized.replace(/\x5c+$/, '');
}

function install(Connector) { Object.assign(Connector.prototype, methods); }

module.exports = { install, withDshBridgeRow, methods, waitingFor, toolKind, turnStatus, threadIdOf, sessionIdOf, normalizeDshCwd, DSH_OFFLINE, DSH_BUSY };
