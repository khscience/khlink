// Connector-side sync between KH Link and the Claude desktop app (Code tab).
//
//  * desktop sessions (and their sidebar pin order) appear on the phone;
//  * conversation history comes from the Claude Code transcript on disk, so
//    turns run on the desktop and turns run by the connector look the same;
//  * a message sent from the phone to a session the desktop currently holds
//    open is typed into the desktop composer (scripts/claude-desktop-send.ps1)
//    so the turn runs in the desktop's own session — the conversation never
//    forks. Otherwise the connector resumes the session itself.
//  * sessions created on the phone are registered in the desktop sidebar.
//  * the model / effort catalogue is read from the desktop's own Claude Code.
//
// Installed onto Connector.prototype by install().
const fs = require('node:fs');
const profileLock = require('./claude-profile-lock');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { parseDesktopResult, ADAPTER_ERRORS } = require('./claude-desktop-result');
const { encryptJson } = require('../crypto');
const { ClaudeDesktopStore, findDesktopClaudeBin, realDesktopPath, probeModels, readTranscript, readTranscriptImage, peekTranscriptState, pendingToolUse, transcriptPath, prettyModelId, START_SESSION_TOOL, OFFER_NEW, OFFER_HERE } = require('./claude-desktop');
const { readDesktopQueue } = require('./claude-desktop');
const { reduceQueue } = require('./claude-desktop-queue');
const { detectImageMime, isImageAttachment } = require('../attachment-store');
const { desktopPermissionDetail, desktopQuestionDetail } = require('./claude-desktop-prompts');
const { claudeUsageState: usageFromObservations, officialDesktopUsageState } = require('./claude-usage');
const { workflowEvents, journalProgress, workflowItem, FINAL_STATUSES: WORKFLOW_FINAL } = require('./claude-workflows');

const DESKTOP_POLL_MS = 5_000;
const DESKTOP_PROBE_MS = 60_000;    // looking for a desktop app that is not installed yet
const LIVE_CACHE_MS = 5_000;
// A phone-created Claude session with no desktop counterpart and no activity
// for this long is stale test/history, not something the desktop still owns.
const PHONE_ONLY_ARCHIVE_MS = 7 * 86_400_000;
const FIRST_SYNC_MAX_ITEMS = 800;   // shown right away; older items follow in the background
// 2: user messages carry their images. 4: images from tools, loaded on request
// (3 was marked on threads that had not actually been rebuilt; 5: the rebuild now
// tells the phone to reload the conversation, which 4 did not).
const TRANSCRIPT_SCHEMA = 11;   // 11: the next-step box checks off the whole task list
const { needsWrapUpHistoryRebuild } = require('./claude-wrap-up');
const LIVE_SCAN_MS = 10_000;          // shared activity evidence must stay fresh before a profile switch
const DESKTOP_MISSING_GRACE_MS = 30_000;
const CLAUDE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// A desktop turn with no transcript activity for this long is treated as over.
const DESKTOP_BUSY_STALE_MS = 20 * 60_000;
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// The effort to show for a desktop session: a level set from the phone stays
// until the desktop's own record changes.
function claudeEffortFromDesktop(prior, session) {
  const override = prior?.effortOverride;
  if (override && (session.effort || '') === override.desktopEffort) return override.value;
  return session.effort || prior?.effort || '';
}
// Workflows: how often running ones are checked, which sessions are scanned
// for launches, and when a silent run without an end notice is "unknown".
const WORKFLOW_POLL_MS = 5_000;
const WORKFLOW_SCAN_RECENT_MS = 2 * 86_400_000;
const WORKFLOW_SILENT_MS = 2 * 3600_000;
// Bumped when the card text changes, so already published cards are redone.
const WORKFLOW_CARD_VERSION = 2;
// "Waiting for you" = the desktop shows an unanswered prompt (its yellow dot).
function promptLabel(tool) {
  if (tool === 'AskUserQuestion') return 'Claude 在等你回答问题';
  if (tool === 'ExitPlanMode') return 'Claude 在等你确认计划';
  if (tool === START_SESSION_TOOL) return 'Claude 想单独开一个新会话';
  if (tool === TRUST_TOOL) return '电脑端在问要不要信任这个工作区';
  return `等你批准：${tool}`;
}
// Claude Desktop 2.42304.2 classifies every finished turn (postTurnSummary)
// and lists a turn that ended on a question as "Blocked · Asked a question".
// No prompt is open then: the user answers in the normal input box.
// An old question nobody answered stays in the summary; the desktop's list
// only keeps recent ones, so do the phone and the tray badge.
const BLOCKED_RECENT_MS = 2 * 86_400_000;
function claudeBlockedText(summary, updatedAt = 0, now = Date.now()) {
  if (!summary?.current || summary.category !== 'blocked' || now - (updatedAt || 0) > BLOCKED_RECENT_MS) return '';
  const text = String(summary.needsAction || summary.detail || '').replace(/\s+/g, ' ').trim();
  return text ? `等你回复：${text.slice(0, 200)}` : 'Claude 在等你回复';
}
// The question is the user's to answer only when the user drove that turn: a
// session another session started reports to it (it relays the answer), and a
// session woken by its side sessions since the user's last message summarises
// their state (each is asked in its own session). Both looked like stale
// "等你回复" rows with no way to answer them (2026-10-20).
function claudeBlockedForUser(session) {
  if (session.spawned && session.turnReported) return false;
  return !(session.sideWakes > 0);
}
// Like the desktop's own "Blocked" list: only while that answer is unseen
// there; once the user has looked at it on the computer it is theirs to pick up.
function claudeWaiting(session, prompt, unseen = true, prior = null, now = Date.now()) {
  // When the prompt appeared: the same prompt always carries the same time.
  if (prompt) return { waitingCategory: 'prompt', waitingAt: prompt.at || null, waitingText: promptLabel(prompt.tool) };
  const blocked = unseen && claudeBlockedForUser(session) ? claudeBlockedText(session.turnSummary, session.updatedAt, now) : '';
  // Stamped when first seen: the summary is written after the turn's own
  // "completed" status, and the phone drops a heartbeat row older than that.
  const same = prior?.waitingCategory === 'blocked' && prior.waitingText === blocked && prior.waitingAt > (session.updatedAt || 0);
  if (blocked) return { waitingCategory: 'blocked', waitingAt: same ? prior.waitingAt : now, waitingText: blocked };
  return { waitingCategory: null, waitingAt: null, waitingText: '' };
}
const MODEL_REFRESH_MS = 6 * 60 * 60_000;
const SEND_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'claude-desktop-send.ps1');
const NEW_SEND_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'claude-desktop-new.ps1');
// All three assets must exist before starting PowerShell. A missing script or
// loader cannot have clicked Send, even though PowerShell exits with a generic
// nonzero code that is otherwise indistinguishable from a late failure.
async function claudeDesktopAssetsPresent(script) {
  const scripts = path.dirname(script);
  const assets = [script, path.join(scripts, 'claude-desktop-native.ps1'),
    path.join(scripts, '..', 'bin', 'khlink-claude-desktop-native-v1.dll')];
  if (path.basename(script) === 'claude-desktop-send.ps1') assets.push(path.join(scripts, 'claude-desktop-navigation.ps1'));
  // A slow disk must not block status updates or other agents' messages.
  try {
    const available = await Promise.all(assets.map(async (asset) => {
      await fs.promises.access(asset, fs.constants.R_OK);
      return (await fs.promises.stat(asset)).isFile();
    }));
    return available.every(Boolean);
  } catch { return false; }
}
const { runSidebarScript, sidebarError, waitUntil } = require('../desktop-sidebar');
// Quota refresh is passive for both managed and ordinary installations.
const ANSWER_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'claude-desktop-answer.ps1');
const TRUST_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'claude-desktop-trust.ps1');
// Not a tool: the desktop's "Trust this workspace?" dialog, shown as a prompt.
const TRUST_TOOL = 'workspaceTrust';
const TRUST_YES = '信任工作区';
const TRUST_NO = '取消';
function trustDetail(folder) {
  return {
    kind: 'question', source: 'workspace-trust', tool: TRUST_TOOL, folder,
    questions: [{
      question: `电脑端在问：要信任工作区「${folder}」吗？信任后 Claude 可以读写、运行这个文件夹里的文件。`, header: '信任工作区', multiSelect: false,
      options: [{ label: TRUST_YES, description: '只在你信任这个文件夹时选' }, { label: TRUST_NO, description: '不开这个文件夹' }],
    }],
  };
}
const DESKTOP_ANSWER_ERRORS = {
  ...ADAPTER_ERRORS,
  desktop_not_running: '电脑端 Claude 没有在运行。',
  prompt_not_found: '电脑端没有找到这个提示，可能已经在电脑上处理过了。',
  prompt_mismatch: '电脑端显示的内容和手机上看到的不一致，为安全起见没有操作，请在电脑上处理。',
  folder_not_found: '电脑端的信任窗口上没看到文件夹，为安全起见没有操作，请在电脑上处理。',
  button_not_found: '电脑端窗口上没有找到对应的按钮，请在电脑上处理。',
  auto_not_offered: '电脑上的这个请求没有“允许并切到自动模式”，请改选“允许一次”。',
  session_not_opened: '电脑端 Claude 没有切到这个会话（可能正忙），没有操作，请稍后再点或在电脑上处理。',
  button_not_found: '电脑端没有找到对应的按钮，请在电脑上处理。',
  option_not_found: '电脑端没有找到这个选项，请在电脑上处理。',
  prompt_still_open: '已经点了，但电脑端的提示还在，请在电脑上确认。',
  option_not_set: '电脑端的选项没能设置成你选的样子，请在电脑上处理。',
  text_not_set: '没能把文字填进电脑端的输入框，请在电脑上处理。',
  bad_choice: '回答的格式不对。',
  window_not_foreground: '电脑端 Claude 窗口没能切到前台，为安全起见没有操作。',
  ambiguous_prompt: '电脑端同时显示了多条审批，暂时无法确定对应操作，请刷新后重试。',
  request_stale: '这条审批已经处理过或已变化，请刷新后重新选择。',
};
// Refusals that come from the window still redrawing, not from a real
// difference: worth one more try. A permission card that differs is never
// retried (the phone gets the refreshed card instead).
const RETRY_QUESTION_REASONS = new Set(['prompt_mismatch', 'prompt_not_found', 'option_not_found', 'option_not_set', 'button_not_found', 'prompt_still_open']);
function desktopAnswerRetryable(kind, reason) {
  return kind === 'question' ? RETRY_QUESTION_REASONS.has(reason) : reason === 'prompt_still_open';
}

const DESKTOP_SEND_ERRORS = {
  ...ADAPTER_ERRORS,
  desktop_draft_present: '电脑端这个会话的输入框里有未发送的草稿，为避免一起发出已取消。请先在电脑上处理草稿。',
  composer_not_found: '没能在电脑端 Claude 窗口里找到输入框（窗口可能未打开或被最小化）。',
  paste_failed: '没能把消息填入电脑端输入框，请重试。',
  session_not_shown: '电脑端 Claude 没能打开这个会话，消息没有发出，请稍后重试。',
  not_sent: '消息已填入电脑端输入框，但发送没有生效，请到电脑上确认。',
  window_not_foreground: '电脑端 Claude 窗口没能切到前台，为避免把内容输入到别的程序里，已取消发送。',
  image_needs_foreground: '图片要粘贴进电脑端输入框，需要 Claude 窗口能切到前台（电脑可能锁屏或有其他窗口占着前台），已取消发送。纯文字消息不受影响。',
  image_missing: '图片文件已不可用，消息没有发出；请重新选择图片。',
  mode_menu_not_found: '没能在电脑端这个会话里找到权限模式菜单（窗口可能未打开或被最小化），权限模式没有改。',
  mode_option_not_found: '电脑端的权限模式菜单里没有这个选项，权限模式没有改。',
  mode_not_applied: '电脑端没有接受这个权限模式（例如本机不允许 Bypass permissions），仍是原来的模式。',
};

// The script's reason is a code, optionally followed by what it saw ("mode_option_not_found: Auto | Manual").
function desktopReasonCode(reason) {
  return String(reason || '').split(':')[0].trim();
}

// Permission modes as the desktop's mode menu names them.
const DESKTOP_PERMISSION_LABELS = { default: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass permissions' };

// When the process query fails, keep what was last seen; with nothing seen
// yet, assume the desktop app is open so a desktop session is never resumed
// with the command-line login (a different account, seen: "Your organization
// has disabled Claude subscription access").
function keepLiveOnFailure(fresh, previous) {
  if (!fresh?.failed) return fresh;
  if (previous && !previous.failed) return previous;
  const assumed = new Set(); assumed.appRunning = true; assumed.failed = true;
  return assumed;
}

function sameFields(a, b, keys) { return keys.every((key) => (a?.[key] ?? null) === (b?.[key] ?? null)); }

const methods = {
  // ---- lifecycle ---------------------------------------------------------
  startClaudeDesktopSync() {
    this.claudeProfileLock = profileLock;
    if (this._claudeDesktopTimer || !this.claude) return;
    if (!this.claudeDesktop) this.claudeDesktop = new ClaudeDesktopStore();
    this.claudeDesktop.relocate?.();
    if (!this.claudeDesktop.available()) {
      // Not installed yet (or uninstalled): keep looking, so installing the
      // desktop app later does not need a connector restart.
      if (!this._claudeDesktopProbeTimer) {
        console.log('[fengzhu-connect] claude desktop sync: app data not found, checking again every minute');
        this._claudeDesktopProbeTimer = setInterval(() => { try { this.startClaudeDesktopSync(); } catch (error) { this.log(error); } }, DESKTOP_PROBE_MS);
        this._claudeDesktopProbeTimer.unref?.();
      }
      return;
    }
    if (this._claudeDesktopProbeTimer) {
      clearInterval(this._claudeDesktopProbeTimer); this._claudeDesktopProbeTimer = null;
      // Found after start-up: pick up the newly installed Claude Code too.
      this.useDesktopClaudeBinary?.();
      this.refreshClaudeModels?.().catch((e) => this.log(e));
    }
    console.log(`[fengzhu-connect] claude desktop sync on (claude ${this.claudeBinVersion || "cli"})`);
    this._claudeDesktopTimer = setInterval(() => {
      // Session scans/permission inspection can still be awaiting a desktop
      // operation. Quota polling must not wait behind that unrelated work.
      try { this.publishClaudeUsage(); } catch (error) { this.log(error); }
      this.syncClaudeDesktopSessions().catch((e) => this.log(e));
    }, DESKTOP_POLL_MS);
    this._claudeDesktopTimer.unref?.();
    this._claudeWorkflowTimer = setInterval(() => this.pollClaudeWorkflows().catch((e) => this.log(e)), WORKFLOW_POLL_MS);
    this._claudeWorkflowTimer.unref?.();
    this.syncClaudeDesktopSessions().catch((e) => this.log(e));
    this.refreshClaudeCliOrg().catch((e) => this.log(e));
    this.restoreClaudeQueues?.();
  },

  stopClaudeDesktopSync() {
    clearInterval(this._claudeDesktopTimer); this._claudeDesktopTimer = null;
    clearInterval(this._claudeModelTimer); this._claudeModelTimer = null;
    clearInterval(this._claudeWorkflowTimer); this._claudeWorkflowTimer = null;
    clearInterval(this._claudeDesktopProbeTimer); this._claudeDesktopProbeTimer = null;
  },

  // Prefer the desktop app's bundled Claude Code so models and behaviour match
  // the desktop exactly; fall back to whatever the backend was configured with.
  // The claude.exe to run now. Re-resolve the desktop bundle on every use so
  // an in-place Claude Desktop update (including its hash-directory layout)
  // is picked up without restarting the connector.
  currentClaudeBin() {
    const found = this.useDesktopClaudeBinary?.();
    if (found?.bin && fs.existsSync(found.bin)) return found.bin;
    const bin = this.claude?.claudeBin;
    return bin && fs.existsSync(bin) ? bin : null;
  },

  useDesktopClaudeBinary() {
    const found = findDesktopClaudeBin();
    if (found && this.claude) { this.claude.claudeBin = found.bin; this.claudeBinVersion = found.version; }
    if (this.claude) { this.claude.resolveBin = () => findDesktopClaudeBin(); this.claude.resolveCwd = realDesktopPath; }
    return found;
  },

  async refreshClaudeModels() {
    const bin = this.currentClaudeBin(); if (!bin || !fs.existsSync(bin)) return this.claudeModels || [];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)));
    try {
      this.claudeModels = await probeModels(bin, { env });
      this.claudeModelsAt = Date.now();
    } catch (error) { this.log(error); }
    return this.claudeModels || [];
  },

  startClaudeModelRefresh() {
    if (this._claudeModelTimer) return;
    this.refreshClaudeModels().catch((e) => this.log(e));
    this._claudeModelTimer = setInterval(() => { this.useDesktopClaudeBinary(); this.refreshClaudeModels().catch((e) => this.log(e)); }, MODEL_REFRESH_MS);
    this._claudeModelTimer.unref?.();
  },

  claudeCapabilities(base) {
    const models = (this.claudeModels || []).map((model) => ({ value: model.value, label: model.label, description: model.description, efforts: model.efforts }));
    return { ...base, models, desktopSync: !!this._claudeDesktopTimer, claudeVersion: this.claudeBinVersion || null, usage: this.claudeUsageState() };
  },

  // ---- thread index ------------------------------------------------------
  // Set fields without bumping updatedAt (which should follow real activity).
  setClaudeThreadFields(threadId, changes) {
    const meta = { id: threadId, title: '', workdir: '', model: '', approveMode: 'manual', sessionId: null, archived: false, updatedAt: Date.now(), ...(this.claudeThreads.get(threadId) || {}), ...changes };
    this.claudeThreads.set(threadId, meta);
    return meta;
  },

  // The desktop sidebar's pins in order (KH Link thread ids), for the phone
  // to reconcile its cached rows against. null until the first desktop scan.
  claudePinSnapshot() {
    if (!this._claudeIndexPublished || !this.claudeThreads) return null;
    return [...this.claudeThreads.values()]
      .filter((meta) => meta.pinned && !meta.archived)
      .sort((a, b) => (Number.isFinite(a.pinOrder) ? a.pinOrder : Infinity) - (Number.isFinite(b.pinOrder) ? b.pinOrder : Infinity)
        || String(a.id).localeCompare(String(b.id)))
      .map((meta) => meta.id);
  },

  // What the phone should show for a Claude thread right now.
  claudeThreadStatus(threadId) {
    const meta = this.claudeThreads.get(threadId); if (!meta) return 'idle';
    if (meta.waitingCategory === 'prompt') return 'desktop_waiting';
    if (this.claude?.isRunning?.(threadId)) return 'mobile_running';
    if (this.claudeDesktopBusy(threadId)) return 'desktop_running';
    // A reply to a turn that ended on a question runs before the summary moves
    // on. The turn is over: the phone highlights it but sends replies straight
    // away instead of offering to queue them (desktop_waiting means a live turn).
    if (meta.waitingCategory) return 'needs_reply';
    if (meta.transcriptTerminalStatus === 'interrupted') return 'interrupted';
    return ['failed', 'interrupted'].includes(meta.lastStatus) && (meta.lastStatusAt || meta.activityAt || 0) >= (meta.transcriptLastEventAt || 0) ? meta.lastStatus : 'completed';
  },

  // A completion that only follows from a transcript gone quiet for the whole
  // busy window (no end_turn yet): a long command writes nothing, so the turn
  // may still be running. It clears the badge, but it is not the turn's end and
  // the phone must not announce it as one.
  claudeCompletionIsQuiet(threadId) {
    const meta = this.claudeThreads?.get(threadId);
    if (!meta || meta.transcriptLastEvent === 'end_turn' || !(meta.transcriptLastEventAt > 0)) return false;
    if (this.claudeThreadStatus(threadId) !== 'completed') return false;
    return Date.now() - meta.transcriptLastEventAt >= DESKTOP_BUSY_STALE_MS;
  },

  claudeQuietField(threadId) {
    return this.claudeCompletionIsQuiet(threadId) ? { quiet: true } : {};
  },

  claudeThreadIndexValue(threadId) {
    const meta = this.claudeThreads.get(threadId); if (!meta) return null;
    const status = this.claudeThreadStatus(threadId);
    return {
      status, unread: !!meta.desktopUnread && !/running/.test(status),
      note: status === 'desktop_waiting' || status === 'needs_reply' ? (meta.waitingText || '') : '',
      waiting: status === 'desktop_waiting' ? (meta.waitingDetail || null) : null,
      id: threadId, title: meta.title || 'Claude 任务', cwd: meta.workdir || '', updatedAt: meta.updatedAt || Date.now(),
      activityAt: meta.activityAt ?? meta.transcriptLastEventAt ?? meta.updatedAt ?? 0,
      backend: 'claude', archived: !!meta.archived, pinned: !!meta.pinned, desktopLive: !!meta.desktopLive, pinOrder: Number.isFinite(meta.pinOrder) ? meta.pinOrder : -1,
      origin: meta.origin || 'phone',
      // Links in replies name the desktop's session id; a phone-created session keeps its KH Link id.
      ...(meta.desktopId && meta.desktopId !== threadId ? { desktopId: meta.desktopId } : {}),
      model: meta.pendingDesktopSettings?.model ?? meta.model ?? '', effort: meta.pendingDesktopSettings?.effort ?? meta.effort ?? '',
    };
  },

  // The question / command behind a desktop prompt, read once per prompt.
  claudeWaitingDetail(prior, session, prompt, snapshot = null) {
    if (!prompt) return { waitingRequestId: null, waitingDetail: null };
    if (prompt.tool === TRUST_TOOL) return { waitingRequestId: prompt.requestId, waitingDetail: { ...trustDetail(prompt.folder), requestId: prompt.requestId } };
    const visible = desktopPermissionDetail(snapshot, prompt, session.desktopId) || desktopQuestionDetail(snapshot, prompt, session.desktopId);
    if (visible) return { waitingRequestId: prompt.requestId,
      waitingDetail: prior?.waitingDetail?.requestId === visible.requestId ? prior.waitingDetail : visible };
    // A card read from the window stands in only while the transcript has no
    // question for this prompt: once it does, the transcript's (every page) wins.
    const fromWindow = prior?.waitingDetail?.source === 'desktop-ui-question';
    if (prior?.waitingRequestId === prompt.requestId && prior.waitingDetail && !fromWindow) return { waitingRequestId: prompt.requestId, waitingDetail: prior.waitingDetail };
    const file = transcriptPath(session.cwd, session.cliSessionId, this.claudeDesktop?.projectsRoot);
    let detail = null; try { detail = file ? pendingToolUse(file, prompt.tool) : null; } catch { /* unreadable */ }
    if (!detail && fromWindow && prior.waitingRequestId === prompt.requestId) return { waitingRequestId: prompt.requestId, waitingDetail: prior.waitingDetail };
    return { waitingRequestId: prompt.requestId, waitingDetail: detail ? { ...detail, requestId: prompt.requestId } : null };
  },

  // The question behind a focused session's AskUserQuestion prompt is already
  // known: shown before for this request, or written in the transcript.
  claudeQuestionKnown(sessions, desktopId, prompt) {
    for (const meta of this.claudeThreads.values()) {
      if (meta.desktopId === desktopId && meta.waitingRequestId === prompt.requestId && meta.waitingDetail) return true;
    }
    const session = sessions.find((item) => item.desktopId === desktopId);
    const file = session && transcriptPath(session.cwd, session.cliSessionId, this.claudeDesktop?.projectsRoot);
    try { return !!(file && pendingToolUse(file, 'AskUserQuestion')); } catch { return false; }
  },

  // Sessions whose "Start this in its own session?" card is still unanswered:
  // offered in the desktop's log, and the start_session call has no result
  // yet in the transcript. Read again only when the transcript changed.
  claudeDesktopCardPrompts(sessions) {
    const out = new Map();
    const offers = this.claudeDesktop.pendingOffers?.(Date.now()) || new Map();
    this._claudeOfferChecks ||= new Map();
    for (const [desktopId, offer] of offers) {
      const session = sessions.find((item) => item.desktopId === desktopId);
      if (!session) continue;
      const file = transcriptPath(session.cwd, session.cliSessionId, this.claudeDesktop?.projectsRoot);
      let mtimeMs = 0; try { mtimeMs = file ? fs.statSync(file).mtimeMs : 0; } catch { /* absent */ }
      let cached = this._claudeOfferChecks.get(desktopId);
      if (!cached || cached.mtimeMs !== mtimeMs || cached.task !== offer.task) {
        let call = null; try { call = file ? pendingToolUse(file, START_SESSION_TOOL) : null; } catch { /* unreadable */ }
        cached = { mtimeMs, task: offer.task, call: call?.source === 'session-offer' ? call : null };
        this._claudeOfferChecks.set(desktopId, cached);
      }
      if (cached.call) out.set(desktopId, { requestId: `offer-${cached.call.toolUseId}`, tool: START_SESSION_TOOL, desktopId, at: offer.at });
    }
    for (const id of this._claudeOfferChecks.keys()) if (!offers.has(id)) this._claudeOfferChecks.delete(id);
    return out;
  },

  // The "Trust this workspace?" dialog. The log says when a folder's trust was
  // checked; only then is the window looked at (a few times, as the dialog
  // draws), and again while it stays up. It is shown in the session that is
  // starting a side session, else in the one most recently active.
  async claudeDesktopTrustPrompt(sessions, now = Date.now()) {
    const checks = this.claudeDesktop.pendingTrustChecks?.(now) || [];
    const latest = checks.reduce((max, item) => Math.max(max, item.at), 0);
    this._claudeTrust ||= { checkedAt: 0, looks: 0, lookedAt: 0, dialog: null };
    const state = this._claudeTrust;
    if (latest > state.checkedAt) Object.assign(state, { checkedAt: latest, looks: 0 });
    const due = state.dialog ? now - state.lookedAt >= 4_000 : state.looks < 4 && now - state.lookedAt >= 3_000 && checks.length > 0;
    if (due) {
      state.looks += 1; state.lookedAt = now;
      const result = await this.runClaudeTrustScript(['-Action', 'inspect']);
      const folder = result?.ok && result.folder ? String(result.folder) : null;
      if (!folder) state.dialog = null;
      else if (state.dialog?.folder !== folder) {
        const recent = sessions.filter((item) => !item.archived).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
        const starting = recent.find((item) => {
          const file = transcriptPath(item.cwd, item.cliSessionId, this.claudeDesktop?.projectsRoot);
          try { return file && pendingToolUse(file, START_SESSION_TOOL); } catch { return false; }
        });
        const owner = starting || recent[0];
        state.dialog = owner ? { folder, desktopId: owner.desktopId, at: now,
          requestId: `trust-${crypto.createHash('sha256').update(`${folder}|${now}`).digest('hex').slice(0, 24)}` } : null;
      }
    }
    return state.dialog ? { requestId: state.dialog.requestId, tool: TRUST_TOOL, desktopId: state.dialog.desktopId, at: state.dialog.at, folder: state.dialog.folder } : null;
  },

  runClaudeTrustScript(args) {
    const exec = this.execFileFn || execFile;
    return new Promise((resolve) => {
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', TRUST_SCRIPT, ...args],
        { windowsHide: true, encoding: 'utf8', timeout: 20_000 }, (error, stdout) => resolve(parseDesktopResult(error, stdout)));
    });
  },

  // The phone's answer to a suggested-session card or the trust dialog: the
  // card or dialog must still show what the phone showed.
  async answerClaudeDesktopCard(threadId, meta, detail, { choice, choices, answers } = {}) {
    const label = String((Array.isArray(answers) && answers[0]?.labels?.[0]) ?? (Array.isArray(choices) ? choices[0] : choice) ?? '');
    const temp = [];
    const tempFile = (content) => { const file = path.join(os.tmpdir(), `kh-link-claude-${crypto.randomUUID()}.txt`); fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 }); temp.push(file); return file; };
    let result;
    try {
      if (detail.source === 'workspace-trust') {
        if (![TRUST_YES, TRUST_NO].includes(label)) throw new Error('只能选择信任工作区或取消');
        result = await this.runClaudeTrustScript(['-Action', label === TRUST_YES ? 'trust' : 'cancel', '-ExpectFile', tempFile(String(detail.folder || ''))]);
        if (result.ok) this._claudeTrust = { ...(this._claudeTrust || {}), dialog: null, lookedAt: Date.now() };
      } else {
        if (![OFFER_NEW, OFFER_HERE].includes(label)) throw new Error('只能选择新会话或在这里做');
        const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ANSWER_SCRIPT, '-SessionId', meta.desktopId,
          '-Kind', 'offer', '-Choice', label === OFFER_NEW ? 'new' : 'here', '-ExpectFile', tempFile(String(detail.title || ''))];
        const restoreId = this.claudeDesktop.focusedSessionId?.();
        if (restoreId && restoreId !== meta.desktopId) args.push('-RestoreId', restoreId);
        const exec = this.execFileFn || execFile;
        result = await new Promise((resolve) => {
          exec('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 60_000 }, (error, stdout) => resolve(parseDesktopResult(error, stdout)));
        });
        if (result.ok) this._claudeOfferChecks?.delete(meta.desktopId);
      }
    } finally { for (const file of temp) fs.rm(file, { force: true }, () => {}); }
    if (!result?.ok) throw new Error(DESKTOP_ANSWER_ERRORS[result?.reason] || `没能在电脑端操作：${result?.reason || 'unknown'}`);
    this.setClaudeThreadFields(threadId, { waitingCategory: null, waitingRequestId: null, waitingDetail: null, waitingText: '', waitingAt: null });
    this.saveClaudeThreads();
    this.emit('thread.status', threadId, { threadId, status: this.claudeThreadStatus(threadId), backend: 'claude', updatedAt: Date.now() });
    await this.syncClaudeDesktopSessions?.().catch?.((e) => this.log(e));
    return { answered: true, kind: 'question' };
  },

  async syncClaudeDesktopSessions() {
    if (this.claudeProfileLock?.switching()) { this._claudeMissingSessions = new Map(); return; } // Never publish the link-changing gap.
    if (this._claudeDesktopSyncing) return; this._claudeDesktopSyncing = true;
    try {
      // A desktop update/reopen can move its data while the connector stays
      // alive. Re-resolve here too, not only when starting the polling timer.
      if (this.claudeDesktop.relocate?.()) {
        this._claudeLive = null; this._claudeScannedProfile = null;
        this._claudeMissingSessions = new Map();
        this.useDesktopClaudeBinary?.();
      }
      const profile = this.claudeDesktop.profileSignature?.();
      if (profile === 'switching' || profile === 'unavailable') { this._claudeMissingSessions = new Map(); return; }
      const sourceRoot = this.claudeDesktop.root;
      const sameProfile = () => !this.claudeProfileLock?.switching() && this.claudeDesktop.profileSignature?.() === profile &&
        this.claudeDesktop.root === sourceRoot && this.claudeDesktop.available?.() !== false;
      if (profile !== this._claudeScannedProfile) {
        this.claudeDesktop.resetProfileCaches?.(); this._claudeLive = null;
        this._claudeScannedProfile = profile;
      }
      const sessions = this.claudeDesktop.listSessions();
      const prompts = this.claudeDesktop.pendingPrompts?.(Date.now()) || new Map();
      // Claude Desktop 3.x waits on two things the permission log never lists:
      // a suggested side session's card, and the workspace trust dialog.
      for (const [desktopId, prompt] of this.claudeDesktopCardPrompts?.(sessions) || []) if (!prompts.has(desktopId)) prompts.set(desktopId, prompt);
      const trust = this.claudeDesktopTrustPrompt ? await this.claudeDesktopTrustPrompt(sessions).catch((error) => { this.log(error); return null; }) : null;
      if (trust && !prompts.has(trust.desktopId)) prompts.set(trust.desktopId, trust);
      // Reading the visible dialog requires no navigation, focus changes or
      // clicks. Other sessions retain their transcript card until opened or
      // until answering refreshes a mismatch against the real dialog.
      const focusedDesktopId = this.claudeDesktop.focusedSessionId?.();
      const focusedPrompt = prompts.get(focusedDesktopId);
      let visiblePermission = null;
      // A question is read from the transcript; the window only when it is
      // not there (the desktop's safeguard card is never written to it).
      if (focusedPrompt && focusedPrompt.tool !== 'ExitPlanMode'
        && (focusedPrompt.tool !== 'AskUserQuestion' || !this.claudeQuestionKnown(sessions, focusedDesktopId, focusedPrompt))) {
        const inspection = await this.inspectClaudeDesktopPermission(focusedDesktopId).catch((error) => { this.log(error); return null; });
        // The user may have answered while the UI was being read.
        if (this.claudeDesktop.pendingPrompts(Date.now()).get(focusedDesktopId)?.requestId === focusedPrompt.requestId) visiblePermission = inspection?.prompt || null;
      }
      if (!this._claudeLive || Date.now() - this._claudeLive.at > LIVE_SCAN_MS) {
        try { const fresh = await this.claudeDesktop.liveDesktopSessions(); this._claudeLive = { at: Date.now(), verified: !fresh.failed, unattributed: !!fresh.unattributed, ids: keepLiveOnFailure(fresh, this._claudeLive?.ids) }; } catch (error) { this.log(error); }
      }
      // Both permission inspection and live-process scans await other work.
      // A completed switch invalidates their old-profile results in full.
      if (!sameProfile()) { this._claudeLive = null; this._claudeMissingSessions = new Map(); return; }
      const liveIds = this._claudeLive?.ids || new Set();
      const byCli = new Map();
      for (const [id, meta] of this.claudeThreads) if (meta.sessionId) byCli.set(meta.sessionId, id);
      const appStartedAt = this.claudeDesktop.appStartedAt?.() || 0;
      const unreadIds = this.claudeDesktop.readUnreadIds?.() || null;
      let focusedId = null; let focusedAt = 0;
      for (const session of sessions) if ((session.focusedAt || 0) > focusedAt) { focusedAt = session.focusedAt; focusedId = session.desktopId; }
      const seen = new Set(); const changed = []; const indexChanged = new Set();
      for (const session of sessions) {
        // A phone-created session registered on the desktop keeps its KH Link id.
        const threadId = byCli.get(session.cliSessionId) || session.desktopId;
        seen.add(threadId);
        const prior = this.claudeThreads.get(threadId);
        // The desktop's dot: activity after the user last looked at it, and
        // since the app started (the desktop keeps that state in memory). A
        // session never opened there and the one in view carry no dot.
        // Read straight from the desktop's own unread list when available.
        const desktopUnread = unreadIds ? unreadIds.has(session.desktopId) : session.focusedAt > 0 && session.desktopId !== focusedId
          && (session.updatedAt || 0) > Math.max(session.focusedAt + 2_000, appStartedAt);
        const next = {
          origin: prior?.origin || 'desktop', desktopId: session.desktopId, sessionId: session.cliSessionId,
          workdir: session.cwd || prior?.workdir || '', title: session.title || prior?.title || '',
          model: session.model || prior?.model || '', effort: claudeEffortFromDesktop(prior, session),
          effortOverride: prior?.effortOverride && (session.effort || '') === prior.effortOverride.desktopEffort ? prior.effortOverride : null,
          approveMode: session.approveMode || prior?.approveMode || 'manual', archived: session.archived,
          pinned: session.pinned, pinOrder: session.pinOrder,
          updatedAt: Math.max(session.updatedAt || 0, prior?.updatedAt || 0),
          desktopLive: liveIds.has(session.cliSessionId),
          ...claudeWaiting(session, prompts.get(session.desktopId), desktopUnread || (session.focusedAt || 0) < (session.updatedAt || 0), prior),
          ...this.claudeWaitingDetail(prior, session, prompts.get(session.desktopId), session.desktopId === focusedDesktopId ? visiblePermission : null),
          desktopUnread,
        };
        if (sameFields(prior, next, Object.keys(next))) continue;
        if (!sameFields(prior, next, ['pinned', 'pinOrder', 'archived'])) indexChanged.add(threadId);
        const waitingChanged = (prior?.waitingCategory || null) !== next.waitingCategory || prior?.waitingDetail?.requestId !== next.waitingDetail?.requestId;
        if (waitingChanged) indexChanged.add(threadId);
        this.setClaudeThreadFields(threadId, next);
        if (waitingChanged) this.emit('thread.status', threadId, { threadId, status: this.claudeThreadStatus(threadId), backend: 'claude', updatedAt: Date.now(), ...this.claudeQuietField(threadId) });
        // A mode, model or effort changed on the desktop ("Allow and switch to
        // Auto", or the user there) reaches the phone too, which otherwise kept
        // showing the old one until the conversation was reopened.
        if (prior && !sameFields(prior, next, ['approveMode', 'model', 'effort']) && this.claudeSettingsResult) {
          this.emit('thread.settings', threadId, { threadId, settings: this.claudeSettingsResult(threadId), updatedAt: Date.now(), source: 'claude' });
        }
        this.threadState?.set?.(threadId, { ...(this.threadState.get(threadId) || {}), backendId: 'claude' });
        changed.push(threadId);
      }
      // A missing/unreadable/empty tree during restart is not a delete event.
      // Only retire missing rows after a stable, complete, nonempty scan while
      // Desktop is open. Explicit isArchived values above still apply at once.
      const source = this.claudeDesktop.sessionSource || sourceRoot;
      const complete = this.claudeDesktop.sessionScanComplete !== false && sessions.length > 0;
      const canRetireMissing = complete && liveIds.appRunning === true && !liveIds.failed && this._claudeLive?.verified !== false;
      if (!canRetireMissing || this._claudeMissingSource !== source) this._claudeMissingSessions = new Map();
      this._claudeMissingSource = source;
      this._claudeMissingSessions ||= new Map();
      for (const id of seen) this._claudeMissingSessions.delete(id);
      for (const [id, meta] of this.claudeThreads) {
        if (meta.origin === 'desktop' && !seen.has(id) && (!meta.archived || meta.pinned)) {
          // Already archived rows can safely lose a leftover pin. Never infer
          // a new archive from one partial scan or an app's shutdown window.
          if (!complete) continue;
          if (!meta.archived) {
            if (!canRetireMissing) continue;
            const since = this._claudeMissingSessions.get(id) ?? Date.now();
            this._claudeMissingSessions.set(id, since);
            if (Date.now() - since < DESKTOP_MISSING_GRACE_MS) continue;
          }
          this.setClaudeThreadFields(id, { archived: true, pinned: false, pinOrder: -1 }); changed.push(id); indexChanged.add(id);
          this._claudeMissingSessions.delete(id);
        }
      }
      // Phone-created sessions are not desktop-owned; after a week without a
      // desktop counterpart, pinned state or recent activity they are stale.
      for (const [id, meta] of this.claudeThreads) {
        if (meta.origin !== 'phone' || seen.has(id) || meta.archived || meta.pinned) continue;
        const lastActive = Math.max(Number(meta.updatedAt) || 0, Number(meta.activityAt) || 0, Number(meta.transcriptLastEventAt) || 0);
        if (!lastActive || Date.now() - lastActive < PHONE_ONLY_ARCHIVE_MS) continue;
        if (/running|waiting/.test(this.claudeThreadStatus(id))) continue;
        this.setClaudeThreadFields(id, { archived: true });
        changed.push(id); indexChanged.add(id);
      }
      // After a restart the relay may hold an out-of-date index (e.g. a thread
      // archived while the connector was off): publish every entry once.
      if (!this._claudeIndexPublished) {
        this._claudeIndexPublished = true;
        for (const id of this.claudeThreads.keys()) if (!changed.includes(id)) changed.push(id);
      }
      if (changed.length) {
        this.saveClaudeThreads();
        // A pin, archive or approval change keeps the real activity time inside
        // the encrypted metadata but moves its index row onto the phone's
        // newest page, which is all a normal refresh reads.
        for (const id of changed) {
          if (!sameProfile()) return;
          await this.syncClaudeThreadMetadata(id, indexChanged.has(id)).catch((e) => this.log(e));
        }
      }
      if (!sameProfile()) return;
      const accountChanged = profile !== undefined && profile !== this._claudePublishedProfile;
      if (changed.length || accountChanged) this.emit('threads.updated', null, { backend: 'claude', count: changed.length, updatedAt: Date.now(), accountChanged });
      this._claudePublishedProfile = profile;
      this.publishClaudeUsage();
      this.maybeRefreshFiveHourReset().catch((e) => this.log(e));
      await this.recheckClaudeOpenTurns?.();
      await this.peekUnwatchedClaudeSessions();
      await this.announceClaudeBusyExpiry?.();
      // Keep watched conversations (opened on the phone) current.
      for (const [id, meta] of this.claudeThreads) if (meta.transcriptWatched && !meta.archived) await this.syncClaudeTranscript(id).catch((e) => this.log(e));
      // Messages the phone queued go out as soon as their session is idle,
      // whether or not its transcript was re-read this round.
      for (const [id, queue] of this._claudeQueues || []) if (queue.length) await this.drainClaudeQueue?.(id).catch?.((e) => this.log(e));
      this._claudeActiveDesktopIds = seen;
      try { require('../account-preflight').publishActivity(this); } catch { this.log('Claude account activity check unavailable'); }
    } finally { this._claudeDesktopSyncing = false; }
  },

  // Once per connector start: a turn saved as still open is checked against
  // its transcript's tail. A reload or crash between reading a turn's end and
  // saving it must not leave the session "running" until its file changes.
  async recheckClaudeOpenTurns() {
    if (this._claudeOpenTurnsChecked) return;
    this._claudeOpenTurnsChecked = true;
    for (const [threadId, meta] of this.claudeThreads) {
      if (meta.archived || !meta.sessionId || !meta.transcriptLastEvent || meta.transcriptLastEvent === 'end_turn') continue;
      const file = meta.transcriptFile && fs.existsSync(meta.transcriptFile) ? meta.transcriptFile : transcriptPath(meta.workdir, meta.sessionId, this.claudeDesktop?.projectsRoot);
      let tail = null; try { tail = file ? peekTranscriptState(file) : null; } catch { /* unreadable */ }
      const newer = tail?.lastEvent && (tail.lastEventAt || 0) >= (meta.transcriptLastEventAt || 0)
        && (tail.lastEvent !== meta.transcriptLastEvent || tail.lastEventAt !== meta.transcriptLastEventAt);
      if (newer) {
        this.setClaudeThreadFields(threadId, { transcriptLastEvent: tail.lastEvent, transcriptLastEventAt: tail.lastEventAt || meta.transcriptLastEventAt, transcriptTerminalStatus: tail.lastTerminalStatus || null });
        this.saveClaudeThreads();
      }
      // A phone may still hold "running" from before the restart: correct it
      // for a turn found ended, or one that went quiet in the last day.
      const recent = Date.now() - (this.claudeThreads.get(threadId).transcriptLastEventAt || 0) < 24 * 3600_000;
      if (this.claudeDesktopBusy(threadId) || this.claude?.isRunning?.(threadId) || !(newer || recent)) continue;
      this.emit('thread.status', threadId, { threadId, status: this.claudeThreadStatus(threadId), backend: 'claude', updatedAt: Date.now(), ...this.claudeQuietField(threadId) });
      if (newer) await this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
    }
  },

  // A turn shown as running that goes quiet for the whole busy window stops
  // counting as running without any new line. Tell the phone then: it kept
  // the last "running" (status frame and index row) until something changed.
  async announceClaudeBusyExpiry() {
    if (!this._claudeBusyAnnounced) return;
    for (const [threadId, at] of this._claudeBusyAnnounced) {
      const meta = this.claudeThreads.get(threadId);
      if (!meta || meta.archived) { this._claudeBusyAnnounced.delete(threadId); continue; }
      if (!at || this.claudeDesktopBusy(threadId)) continue;
      this._claudeBusyAnnounced.set(threadId, 0);
      if (this.claude?.isRunning?.(threadId)) continue;
      this.emit('thread.status', threadId, { threadId, status: this.claudeThreadStatus(threadId), backend: 'claude', updatedAt: Date.now(), ...this.claudeQuietField(threadId) });
      await this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
    }
  },

  // Sessions never opened on the phone: when their transcript changes, read
  // only its tail to know whether a turn is running (no history upload).
  async peekUnwatchedClaudeSessions() {
    if (!this._claudePeek) this._claudePeek = new Map(); // threadId -> mtimeMs
    for (const [threadId, meta] of this.claudeThreads) {
      if (meta.transcriptWatched || meta.archived || !meta.sessionId) continue;
      if (Date.now() - (meta.updatedAt || 0) > 7 * 24 * 3600_000) continue;
      const file = meta.transcriptFile && fs.existsSync(meta.transcriptFile) ? meta.transcriptFile : transcriptPath(meta.workdir, meta.sessionId, this.claudeDesktop?.projectsRoot);
      if (!file) continue;
      let mtimeMs; try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (this._claudePeek.get(threadId) === mtimeMs) continue;
      const first = !this._claudePeek.has(threadId);
      this._claudePeek.set(threadId, mtimeMs);
      const state = peekTranscriptState(file); if (!state?.lastEvent) continue;
      const wasBusy = this.claudeDesktopBusy(threadId);
      const activityChanged = state.lastEventAt > 0 && meta.activityAt !== state.lastEventAt;
      this.setClaudeThreadFields(threadId, { transcriptFile: file, transcriptLastEvent: state.lastEvent, transcriptLastEventAt: state.lastEventAt || mtimeMs,
        transcriptTerminalStatus: state.lastTerminalStatus || null,
        ...(state.lastEventAt > 0 ? { activityAt: state.lastEventAt } : {}) });
      const nowBusy = this.claudeDesktopBusy(threadId);
      if (nowBusy) (this._claudeBusyAnnounced ||= new Map()).set(threadId, Date.now());
      if (activityChanged || (!first && wasBusy !== nowBusy) || (first && nowBusy)) {
        this.saveClaudeThreads();
        this.emit('thread.status', threadId, { threadId, status: this.claudeThreadStatus(threadId), backend: 'claude', updatedAt: Date.now(), ...this.claudeQuietField(threadId) });
        await this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
      } else if (first) this.saveClaudeThreads();
    }
  },

  // ---- history from transcript -------------------------------------------
  isLegacyLiveClaudeThread(meta) { return !!meta && Number(meta.nextOrder) > 0 && !meta.transcriptOffset && meta.origin !== 'desktop'; },

  scheduleClaudeTranscriptSync(threadId, delay = 400) {
    if (!this._claudeSyncTimers) this._claudeSyncTimers = new Map();
    clearTimeout(this._claudeSyncTimers.get(threadId));
    const timer = setTimeout(() => { this._claudeSyncTimers.delete(threadId); this.syncClaudeTranscript(threadId).catch((e) => this.log(e)); }, delay);
    timer.unref?.(); this._claudeSyncTimers.set(threadId, timer);
  },

  async syncClaudeTranscript(threadId, { watch = false } = {}) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta || !meta.sessionId || !this.config.accountKey || this.isLegacyLiveClaudeThread(meta)) return { items: 0 };
    if (!this._claudeTranscriptLocks) this._claudeTranscriptLocks = new Map();
    // Wait until no read of this transcript runs: two callers waiting on the
    // same read both went ahead at once and read the same lines twice.
    for (let running = this._claudeTranscriptLocks.get(threadId); running; running = this._claudeTranscriptLocks.get(threadId)) {
      await running.catch(() => {});
    }
    const work = (async () => {
      const current = this.claudeThreads.get(threadId);
      const file = current.transcriptFile && fs.existsSync(current.transcriptFile) ? current.transcriptFile : transcriptPath(current.workdir, current.sessionId, this.claudeDesktop?.projectsRoot);
      if (!file) return { items: 0 };
      // Reproject old image/card history once on opening, with stable ids.
      let offset = current.transcriptOffset || 0; let lines = current.transcriptLines || 0; let rebuilt = false;
      let checkedSchema = current.transcriptSchema || 1;
      if (offset && watch && (current.transcriptSchema || 1) < TRANSCRIPT_SCHEMA) {
        if (needsWrapUpHistoryRebuild(file, checkedSchema)) { offset = 0; lines = 0; rebuilt = true; }
        checkedSchema = TRANSCRIPT_SCHEMA;
      }
      const result = readTranscript(file, offset, lines, { wrapUpCalls: current.transcriptWrapUpCalls, sentFileCalls: current.transcriptSentFileCalls, taskList: current.transcriptTaskList, taskListNewTurn: current.transcriptTaskListNewTurn });
      if (!result) return { items: 0 };
      // Repair old FIFO drift once without replaying messages. Limit the read
      // to this sync's committed offset, so concurrent appends are not applied
      // twice by the following incremental read.
      const rebuiltQueue = offset > 0 && (current.desktopQueue || []).length && (current.desktopQueueSchema || 1) < 2
        ? readDesktopQueue(file, result.offset) : null;
      const statusBefore = this.claudeThreadStatus(threadId);
      // A watched transcript may already be fully consumed by an older
      // connector. Initialize the terminal marker from its tail once without
      // replaying history or old queue operations.
      if (current.transcriptTerminalStatus === undefined && !result.lastEvent) {
        const tail = peekTranscriptState(file);
        if (tail?.lastEvent) Object.assign(result, { lastEvent: tail.lastEvent, lastEventAt: tail.lastEventAt, lastTerminalStatus: tail.lastTerminalStatus });
      }
      this.reconcileSendReceipts?.('claude', threadId, result.items);
      // The turn state is committed together with the offset, before any
      // await: a connector reloaded mid-upload (seen 2026-11-05, 21 挖矿) had
      // saved the offset past the turn's end but not the end itself, so the
      // lines were never read again and the session stayed "running".
      const wasBusy = this.claudeDesktopBusy(threadId);
      const turnBefore = { transcriptLastEvent: current.transcriptLastEvent, transcriptLastEventAt: current.transcriptLastEventAt, transcriptTerminalStatus: current.transcriptTerminalStatus };
      if (result.lastEvent) this.setClaudeThreadFields(threadId, { transcriptLastEvent: result.lastEvent, transcriptLastEventAt: result.lastEventAt || Date.now(), transcriptTerminalStatus: result.lastTerminalStatus || null });
      let items = result.items; let older = [];
      if (!offset && items.length > FIRST_SYNC_MAX_ITEMS) { older = items.slice(0, -FIRST_SYNC_MAX_ITEMS); items = items.slice(-FIRST_SYNC_MAX_ITEMS); }
      // A failed upload is read again: put the turn state back so that read
      // still sees (and announces) the change.
      if (items.length) {
        try { await this.uploadClaudeHistoryItems(threadId, items); } catch (error) {
          if (result.lastEvent) this.setClaudeThreadFields(threadId, turnBefore);
          throw error;
        }
      }
      // Older history keeps loading behind the visible page, newest first, so
      // scrolling up on the phone finds it.
      if (older.length) {
        setImmediate(async () => {
          try {
            for (let end = older.length; end > 0; end -= 200) {
              await this.uploadClaudeHistoryItems(threadId, older.slice(Math.max(0, end - 200), end));
              this.emit('history.updated', threadId, { threadId, itemCount: Math.min(200, end), updatedAt: Date.now(), backend: 'claude', older: true });
            }
          } catch (error) { this.log(error); }
        });
      }
      const lastAt = items.length ? items[items.length - 1].at : null;
      // Uploads finished: the read is committed (offset and turn state).
      this.setClaudeThreadFields(threadId, {
        // Only a read from the start produces every item of the current
        // schema; an incremental read keeps the older mark, so the rebuild
        // still happens when the thread is next opened.
        transcriptFile: file, transcriptOffset: result.offset, transcriptLines: result.lineCount,
        transcriptSchema: offset === 0 ? TRANSCRIPT_SCHEMA : checkedSchema,
        ...(result.wrapUpCalls ? { transcriptWrapUpCalls: result.wrapUpCalls } : {}),
        ...(result.sentFileCalls ? { transcriptSentFileCalls: result.sentFileCalls } : {}),
        // A read that found no new line carries no state: keep the saved list.
        ...('taskList' in result ? { transcriptTaskList: result.taskList || null, transcriptTaskListNewTurn: !!result.taskListNewTurn } : {}),
        transcriptWatched: current.transcriptWatched || watch,
        ...(lastAt > 0 ? { activityAt: Math.max(current.activityAt || 0, lastAt) } : {}),
        ...(lastAt && lastAt > (current.updatedAt || 0) ? { updatedAt: lastAt } : {}),
      });
      this.saveClaudeThreads();
      if (items.length) {
        // A rebuild adds items in the middle of the conversation, which the
        // phone only picks up by reloading it (fullHistory); either way the
        // time is that of the newest item, not of this read.
        this.emit('history.updated', threadId, { threadId, itemCount: items.length, updatedAt: lastAt || Date.now(), backend: 'claude', ...(rebuilt ? { fullHistory: true } : {}) });
        if (lastAt && (lastAt > (current.updatedAt || 0) || lastAt > (current.activityAt || 0))) await this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
      }
      this.applyClaudeDesktopQueue(threadId, result.queueOps || [], { fromStart: !offset || result.offset < offset, rebuiltQueue });
      // Whether a turn is in progress in the transcript (desktop or not).
      const connectorTurn = this.claude?.isRunning?.(threadId);
      const nowBusy = this.claudeDesktopBusy(threadId);
      const terminalChanged = statusBefore !== this.claudeThreadStatus(threadId);
      // Announce transitions, and keep re-announcing a running turn so a phone
      // that (re)connects mid-turn still learns about it.
      if (!this._claudeBusyAnnounced) this._claudeBusyAnnounced = new Map();
      const lastAnnounced = this._claudeBusyAnnounced.get(threadId) || 0;
      const transition = (wasBusy !== nowBusy && current.transcriptOffset) || (current.desktopTurnSince && !nowBusy);
      // On opening, refresh the phone's cached status even if this connector
      // already knows the turn ended (including a migrated next-step box).
      if (!connectorTurn && (watch || transition || terminalChanged || (nowBusy && Date.now() - lastAnnounced > 15_000))) {
        this._claudeBusyAnnounced.set(threadId, nowBusy ? Date.now() : 0);
        // The real state: a turn waiting on a prompt is "waiting", not "running"
        // (announcing it as running made the phone drop its answer controls).
        this.emit('thread.status', threadId, { threadId, status: this.claudeThreadStatus(threadId), backend: 'claude', updatedAt: Date.now(), ...this.claudeQuietField(threadId) });
      }
      if (watch || terminalChanged) await this.syncClaudeThreadMetadata(threadId).catch((error) => this.log(error));
      if (!nowBusy && current.desktopTurnSince) this.setClaudeThreadFields(threadId, { desktopTurnSince: null });
      this.saveClaudeThreads();
      if (!nowBusy) setImmediate(() => this.drainClaudeQueue?.(threadId));
      return { items: items.length };
    })();
    this._claudeTranscriptLocks.set(threadId, work);
    try { return await work; } finally { if (this._claudeTranscriptLocks.get(threadId) === work) this._claudeTranscriptLocks.delete(threadId); }
  },

  // ---- workflows (see claude-workflows.js) -------------------------------
  // New transcript lines are scanned for workflow launches and end notices,
  // separately from the item sync (which may already be past a launch).
  async scanClaudeWorkflows(threadId) {
    const meta = this.claudeThreads.get(threadId);
    const file = meta?.transcriptFile && fs.existsSync(meta.transcriptFile) ? meta.transcriptFile
      : meta?.sessionId ? transcriptPath(meta.workdir, meta.sessionId, this.claudeDesktop?.projectsRoot) : null;
    if (!file) return;
    let size; try { size = (await fs.promises.stat(file)).size; } catch { return; }
    let offset = meta.workflowScanOffset || 0; let lineCount = meta.workflowScanLines || 0;
    if (meta.workflowScanFile !== file || size < offset) { offset = 0; lineCount = 0; }
    if (size === offset) return;
    const handle = await fs.promises.open(file, 'r');
    let text;
    try { const buffer = Buffer.alloc(size - offset); await handle.read(buffer, 0, buffer.length, offset); text = buffer.toString('utf8'); }
    finally { await handle.close(); }
    const end = text.lastIndexOf('\n'); if (end < 0) return;
    const lines = text.slice(0, end).split('\n');
    const { launches, notifications } = workflowEvents(lines, lineCount);
    const workflows = { ...(meta.workflows || {}) };
    for (const launch of launches) if (!workflows[launch.taskId]) workflows[launch.taskId] = { ...launch, status: 'running' };
    for (const notice of notifications) {
      const workflow = workflows[notice.taskId];
      if (workflow && !WORKFLOW_FINAL.has(workflow.status)) Object.assign(workflow, { status: notice.status, endedAt: notice.at });
    }
    this.setClaudeThreadFields(threadId, { workflows, workflowScanFile: file,
      workflowScanOffset: offset + Buffer.byteLength(text.slice(0, end + 1)), workflowScanLines: lineCount + lines.length });
    this.saveClaudeThreads();
  },

  async pollClaudeWorkflows(now = Date.now()) {
    if (this._claudeWorkflowPolling || !this.config?.accountKey || !this.claudeThreads) return;
    this._claudeWorkflowPolling = true;
    try {
      for (const [threadId, meta] of this.claudeThreads) {
        const running = Object.values(meta.workflows || {}).some((workflow) => !WORKFLOW_FINAL.has(workflow.status) && workflow.status !== 'unknown');
        if (!running && !(meta.sessionId && now - (meta.activityAt || meta.updatedAt || 0) < WORKFLOW_SCAN_RECENT_MS)) continue;
        try { await this.scanClaudeWorkflows(threadId); } catch (error) { this.log(error); continue; }
        for (const workflow of Object.values(this.claudeThreads.get(threadId)?.workflows || {})) {
          await this.publishClaudeWorkflow(threadId, workflow, now).catch((error) => this.log(error));
        }
      }
    } finally { this._claudeWorkflowPolling = false; }
  },

  // Re-upload a workflow's card when its progress or state changed.
  async publishClaudeWorkflow(threadId, workflow, now = Date.now()) {
    const current = workflow.cardVersion === WORKFLOW_CARD_VERSION;
    if (current && workflow.published && (WORKFLOW_FINAL.has(workflow.status) || workflow.status === 'unknown') && workflow.publishedStatus === workflow.status) return;
    const journal = workflow.transcriptDir ? path.join(workflow.transcriptDir, 'journal.jsonl') : null;
    let stat = null; try { stat = journal ? await fs.promises.stat(journal) : null; } catch { /* not written yet */ }
    if (!WORKFLOW_FINAL.has(workflow.status) && workflow.status !== 'unknown' && now - Math.max(stat?.mtimeMs || 0, workflow.launchedAt) > WORKFLOW_SILENT_MS) {
      workflow.status = 'unknown';
    }
    const signature = `${stat?.size || 0}:${workflow.status}`;
    // A running card's clock is refreshed at most once a minute without news.
    if (current && workflow.published && workflow.signature === signature && (WORKFLOW_FINAL.has(workflow.status) || now - (workflow.publishedAt || 0) < 60_000)) return;
    const progress = stat ? journalProgress(await fs.promises.readFile(journal, 'utf8')) : null;
    const item = workflowItem(workflow, progress, now);
    await this.uploadClaudeHistoryItems(threadId, [item]);
    Object.assign(workflow, { published: true, publishedStatus: workflow.status, signature, publishedAt: now, cardVersion: WORKFLOW_CARD_VERSION });
    this.saveClaudeThreads();
    this.emit('agent.event', threadId, { threadId, item, backend: 'claude' });
    this.emit('history.updated', threadId, { threadId, itemCount: 1, updatedAt: now, backend: 'claude' });
  },

  claudeActiveThreadRows() {
    const rows = [];
    for (const [threadId, meta] of this.claudeThreads || []) {
      if (meta.archived) continue;
      if (meta.waitingCategory === 'prompt') rows.push({ threadId, status: 'desktop_waiting', updatedAt: meta.waitingAt || Date.now() });
      else if (this.claude?.isRunning?.(threadId)) rows.push({ threadId, status: 'mobile_running', updatedAt: meta.updatedAt || Date.now() });
      else if (this.claudeDesktopBusy(threadId)) {
        rows.push({ threadId, status: 'desktop_running', updatedAt: meta.transcriptLastEventAt || Date.now() });
        if (!(this._claudeBusyAnnounced ||= new Map()).get(threadId)) this._claudeBusyAnnounced.set(threadId, Date.now());
      }
      else if (meta.waitingCategory) rows.push({ threadId, status: 'needs_reply', updatedAt: meta.waitingAt || Date.now() });
    }
    return rows;
  },

  // ---- plan usage (five-hour / weekly windows) ----------------------------
  // Two local sources, merged:
  //  * rate_limit_event from any Claude Code turn the connector runs — exact
  //    utilisation plus both reset times;
  //  * the desktop app's own 15-minute usage samples — fresh utilisation even
  //    when only the desktop is being used (no reset times there).
  // Refresh is passive for every installation; no quota probe creates a turn.
  onClaudeRateLimit(info, now = Date.now()) {
    const windows = info?.unifiedWindows || {};
    const pick = (key) => {
      const w = windows[key];
      if (w && Number.isFinite(w.utilization) && w.utilization >= 0 && w.utilization <= 1) return { utilization: w.utilization, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null, observedAt: now };
      if (info?.rateLimitType === key && Number.isFinite(info.resetsAt)) return { utilization: null, resetsAt: info.resetsAt * 1000, observedAt: now };
      return null;
    };
    const fiveHour = pick('five_hour'); const sevenDay = pick('seven_day');
    if (!fiveHour && !sevenDay) return;
    const prior = this.readClaudeUsageEvent() || {};
    // These events come from turns the connector runs with the command-line
    // login, which can be a different account from the desktop app's.
    const org = this._claudeCliOrg || null;
    const same = prior.org === org;
    // Partial/reset-only events must not make another window's old usage
    // look newly observed. Legacy files inherit their original event time.
    const merge = (next, old) => {
      if (!same) return next;
      const previous = old && { ...old, observedAt: old.observedAt ?? prior.at };
      if (!next || (previous && next.observedAt < previous.observedAt)) return previous || null;
      if (next.utilization === null && previous?.resetsAt === next.resetsAt) return { ...next, utilization: previous.utilization, observedAt: previous.observedAt };
      return next;
    };
    this._claudeUsageEvent = { at: now, org, fiveHour: merge(fiveHour, prior.fiveHour), sevenDay: merge(sevenDay, prior.sevenDay), status: info.status || null };
    try { fs.writeFileSync(this.claudeUsageFile(), JSON.stringify(this._claudeUsageEvent), { mode: 0o600 }); } catch (error) { this.log(error); }
    this.publishClaudeUsage();
  },

  claudeUsageFile() { return path.join(path.dirname(this.config.configFile || path.join(os.homedir(), 'x')), 'claude-usage.json'); },

  readClaudeUsageEvent() {
    if (this._claudeUsageEvent) return this._claudeUsageEvent;
    try { this._claudeUsageEvent = JSON.parse(fs.readFileSync(this.claudeUsageFile(), 'utf8')); } catch { this._claudeUsageEvent = null; }
    return this._claudeUsageEvent;
  },

  claudeUsageState(now = Date.now()) {
    const snapshot = state => {
      // Source observation time can go backwards on A -> B. This separate
      // envelope clock orders responses/pushes even across account changes.
      this._claudeUsageSnapshotAt = Math.max(now, (this._claudeUsageSnapshotAt || 0) + 1);
      return { ...state, accountState: state.accountState || (state.accountFingerprint ? 'ready' : 'unavailable'), snapshotAt: this._claudeUsageSnapshotAt,
        statusline: this.claudeStatusline?.status?.() || null };
    };
    const official = this.claudeDesktop?.latestOfficialUsage?.(now);
    if (official !== undefined) return snapshot(officialDesktopUsageState({ ...official,
      latestActivity: this.claudeLastActivityAt?.() || 0,
      refreshResultAt: this._claudeUsageRefreshResultAt || 0,
      refreshUnavailableReason: this._claudeUsageRefreshUnavailableReason || null,
    }, now));
    const sample = this.claudeDesktop?.latestUsageSample?.() || null;
    const org = sample?.org || this.claudeDesktop?.usageOrg || this._claudeCliOrg || null;
    const stored = this.readClaudeUsageEvent();
    return snapshot(usageFromObservations({
      sample,
      event: !this.claudeProfileLock?.managed() && org && stored?.org === org ? stored : null,
      latestActivity: this.claudeLastActivityAt?.() || 0,
      refreshResultAt: this._claudeUsageRefreshResultAt || 0,
      refreshUnavailableReason: this._claudeUsageRefreshUnavailableReason || null,
    }, now));
  },

  // Which organisation the command-line `claude` is signed in to, from the
  // official `claude auth status` (no credential file is read). Cached.
  async refreshClaudeCliOrg() {
    if (this.claudeProfileLock?.managed()) return null;
    if (this._claudeCliOrgAt && Date.now() - this._claudeCliOrgAt < (this._claudeCliOrg ? 10 : 5) * 60_000) return this._claudeCliOrg || null;
    this._claudeCliOrgAt = Date.now();
    const bin = this.currentClaudeBin?.(); if (!bin || !fs.existsSync(bin)) return null;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)));
    const out = await new Promise((resolve) => {
      require('node:child_process').execFile(bin, ['auth', 'status'], { env, windowsHide: true, timeout: 60_000 }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
    });
    try { const auth = JSON.parse(out); this._claudeCliOrg = auth.loggedIn === true ? auth.orgId || null : null; } catch { this._claudeCliOrg = null; }
    return this._claudeCliOrg || null;
  },

  // A usage request through the command line only says something about the
  // desktop's windows when both use the same organisation.
  async claudeCliMatchesDesktop() {
    const desktopOrg = this.claudeDesktop?.latestUsageSample?.()?.org || this.claudeDesktop?.usageOrg || null;
    const cliOrg = await this.refreshClaudeCliOrg();
    return Boolean(cliOrg && desktopOrg && cliOrg === desktopOrg);
  },

  publishClaudeUsage(force = false) {
    const state = this.claudeUsageState();
    // A read before the relay/direct channel opens was not delivered. Leave
    // it eligible for the next poll instead of caching it as already sent.
    if (this.isConnected && !this.isConnected()) { this._claudeUsageKey = null; return state; }
    const key = JSON.stringify([state.fiveHour, state.sevenDay, state.observedAt, state.status, state.refreshResultAt, state.refreshUnavailableReason, state.accountFingerprint, state.accountState]);
    if (!force && key === this._claudeUsageKey) return state;
    this._claudeUsageKey = key;
    this.emit('claude.usage', null, state);
    return state;
  },

  // When a Claude session (desktop or ours) last wrote to its transcript.
  claudeLastActivityAt() {
    let latest = 0;
    for (const meta of this.claudeThreads?.values?.() || []) latest = Math.max(latest, Number(meta.transcriptLastEventAt) || 0);
    return latest;
  },

  // Compatibility entry point: no installation may create a model turn to
  // discover usage. Automatic refresh only observes existing local records.
  async maybeRefreshFiveHourReset() { return false; },

  async refreshClaudeUsage() {
    this.claudeDesktop?.latestOfficialUsage?.(Date.now(), { force: true });
    if (this.claudeDesktop) this.claudeDesktop.usageSampleCache = null;
    this._claudeUsageRefreshResultAt = Date.now();
    this._claudeUsageRefreshUnavailableReason = 'desktop_refresh_required';
    this._claudeUsageKey = null;
    return this.publishClaudeUsage();
  },

  // A turn is running in this session's transcript (typically on the desktop).
  claudeDesktopBusy(threadId) {
    const meta = this.claudeThreads?.get(threadId);
    if (!meta) return false;
    if (meta.desktopTurnSince && Date.now() - meta.desktopTurnSince < DESKTOP_BUSY_STALE_MS && meta.transcriptLastEvent !== 'end_turn') return true;
    // Just handed a message over, and the transcript has not recorded it yet:
    // still busy (so the next queued message waits), for at most two minutes.
    if (meta.desktopTurnSince && (meta.transcriptLastEventAt || 0) < meta.desktopTurnSince && Date.now() - meta.desktopTurnSince < 2 * 60_000) return true;
    if (!meta.transcriptLastEvent || meta.transcriptLastEvent === 'end_turn') return false;
    return Date.now() - (meta.transcriptLastEventAt || 0) < DESKTOP_BUSY_STALE_MS;
  },

  // Rebuild the desktop's own pending queue from transcript queue-operations
  // (enqueue / dequeue FIFO / remove by content) and mirror it to the phone.
  applyClaudeDesktopQueue(threadId, ops, { fromStart = false, rebuiltQueue = null } = {}) {
    if (!ops.length && !fromStart && !rebuiltQueue) return;
    const meta = this.claudeThreads.get(threadId);
    const before = meta.desktopQueue || [];
    // Replaying the whole transcript rebuilds the queue from nothing.
    const { queue, receipts } = rebuiltQueue || reduceQueue(fromStart ? [] : before, ops, fromStart ? [] : meta.desktopQueueReceipts || []);
    // Internal entries (harness notifications) keep their FIFO slot but are never shown.
    const visible = queue.filter((item) => !item.internal);
    this.setClaudeThreadFields(threadId, { desktopQueue: queue.slice(-50), desktopQueueReceipts: receipts, desktopQueueSchema: 2 });
    const beforeIds = new Set(before.filter((item) => !item.internal).map((item) => item.id));
    const afterIds = new Set(visible.map((item) => item.id));
    for (const item of visible) if (!beforeIds.has(item.id)) this.emit('followup.queued', threadId, { ...item, threadId });
    for (const id of beforeIds) if (!afterIds.has(id)) this.emit('followup.cancelled', threadId, { id, threadId });
  },

  // One image from a transcript, in chunks the relay can carry (the phone asks
  // for the next offset until eof). The decoded picture is kept briefly so the
  // chunks do not each re-read the transcript.
  claudeTranscriptImage(args) {
    const meta = this.claudeThreads.get(args.threadId);
    if (!meta) throw new Error('找不到这个 Claude 会话');
    const file = meta.transcriptFile && fs.existsSync(meta.transcriptFile) ? meta.transcriptFile : transcriptPath(meta.workdir, meta.sessionId, this.claudeDesktop?.projectsRoot);
    if (!file) throw new Error('找不到这个会话的记录文件');
    const key = `${args.threadId}|${args.ref}`;
    let image = this._claudeImageCache?.key === key ? this._claudeImageCache.image : null;
    if (!image) { image = readTranscriptImage(file, args.ref); this._claudeImageCache = { key, image }; }
    const offset = Math.max(0, Number(args.offset) || 0);
    const size = Math.min(512 * 1024, Number(args.size) || 512 * 1024);
    const chunk = image.bytes.subarray(offset, offset + size);
    const eof = offset + chunk.length >= image.bytes.length;
    if (eof) this._claudeImageCache = null;
    return { mimeType: image.mimeType, total: image.bytes.length, offset, eof, data: chunk.toString('base64') };
  },

  async uploadClaudeHistoryItems(threadId, items) {
    const rows = await Promise.all(items.map(async (item) => ({
      id: item.id, order: item.order, createdAt: item.at,
      ...await this.historyItemFrame(threadId, item.id, { type: item.type, text: item.text, tool: item.tool, createdAt: item.at,
        ...(item.status ? { status: item.status } : {}),
        ...(item.images ? { images: item.images } : {}), ...(item.imageRefs ? { imageRefs: item.imageRefs } : {}),
        ...(item.nextStep ? { nextStep: item.nextStep } : {}), ...(item.files ? { files: item.files } : {}),
        ...(item.taskList ? { taskList: item.taskList } : {}) }),
    })));
    // Batches of up to 100 rows, but a batch carrying images stays small.
    let batch = []; let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.putHistoryItems(threadId, batch);
      batch = []; size = 0;
    };
    for (const row of rows) {
      const rowSize = (row.ciphertext || '').length;
      if (batch.length && (batch.length >= 100 || size + rowSize > 3_000_000)) await flush();
      batch.push(row); size += rowSize;
    }
    await flush();
  },

  // ---- attachments -----------------------------------------------------------
  // Phone uploads arrive as files. Images go to Claude as image blocks (or are
  // pasted into the desktop composer); other files are referenced by path so
  // Claude Code can read them itself.
  claudeAttachmentParts(args) {
    const attachments = (typeof this.resolveAttachments === 'function' ? this.resolveAttachments(args.threadId, args.attachments) : []) || [];
    const images = []; const imagePaths = []; const notes = [];
    for (const item of attachments) {
      if (item?.data || item?.base64) { images.push({ mediaType: item.mediaType || item.mimeType || 'image/png', data: item.data || item.base64 }); continue; }
      if (!item?.path) continue;
      let bytes = null; let size = 0;
      try {
        size = fs.statSync(item.path).size;
        if (size <= CLAUDE_IMAGE_MAX_BYTES) bytes = fs.readFileSync(item.path);
      } catch {
        if (isImageAttachment(item)) throw Object.assign(new Error('图片无法读取，请重新选择后再发送。'), { delivery: 'not_sent' });
      }
      const mime = bytes ? detectImageMime(bytes) : null;
      if (isImageAttachment(item) && !mime) {
        const reason = size > CLAUDE_IMAGE_MAX_BYTES ? '图片超过 5 MB，请压缩后重新选择。' : '图片格式不受支持或文件已损坏，请重新选择。';
        throw Object.assign(new Error(reason), { delivery: 'not_sent' });
      }
      if (mime) { images.push({ mediaType: mime, data: bytes.toString('base64') }); imagePaths.push(item.path); }
      else notes.push(`[附件] ${item.name || path.basename(item.path)}\n路径：${item.path}`);
    }
    const base = String(args.text || '').trim();
    const text = notes.length ? [base, ...notes].filter(Boolean).join('\n\n') : base;
    return { text, images, imagePaths };
  },

  // ---- desktop delivery ----------------------------------------------------
  async claudeLiveSnapshot() {
    const now = Date.now();
    if (!this._claudeLive || now - this._claudeLive.at > LIVE_CACHE_MS) { const fresh = await this.claudeDesktop.liveDesktopSessions(); this._claudeLive = { at: now, verified: !fresh.failed, unattributed: !!fresh.unattributed, ids: keepLiveOnFailure(fresh, this._claudeLive?.ids) }; }
    return this._claudeLive.ids;
  },

  async desktopHoldsClaudeSession(cliSessionId) {
    if (!cliSessionId || !this.claudeDesktop) return false;
    return (await this.claudeLiveSnapshot()).has(cliSessionId);
  },

  // A desktop session should run on the desktop whenever the app is open, even
  // if it has no Claude Code process right now (the desktop stops idle ones).
  // Resuming it here instead would use the command-line login in ~/.claude,
  // which can be a different account from the desktop app's.
  async desktopShouldTakeClaudeSession(cliSessionId) {
    if (!cliSessionId || !this.claudeDesktop) return false;
    const live = await this.claudeLiveSnapshot();
    return live.has(cliSessionId) || !!live.appRunning;
  },

  // Scripts load precompiled interop before any UI action. Unknown failures
  // must never replay input; the receipt/transcript flow reconciles them.
  async runDesktopSend(desktopId, text, restoreId, options = {}) {
    return this.runDesktopSendOnce(desktopId, text, restoreId, options);
  },

  async runDesktopSendOnce(desktopId, text, restoreId, { mode = 'send', imagePaths = [] } = {}) {
    const script = this.claudeDesktopSendScript || SEND_SCRIPT;
    if (!(await claudeDesktopAssetsPresent(script))) return { ok: false, reason: 'adapter_missing', delivery: 'not_sent' };
    const file = path.join(os.tmpdir(), `kh-link-claude-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, text || '', { encoding: 'utf8', mode: 0o600 });
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-SessionId', desktopId, '-TextFile', file, '-Mode', mode];
    if (restoreId) args.push('-RestoreId', restoreId);
    // A send waits until the window's header shows this session's title.
    const title = mode === 'send' ? this.claudeDesktopTitle(desktopId) : '';
    if (title) args.push('-TitleB64', Buffer.from(title, 'utf8').toString('base64'));
    if (imagePaths.length) args.push('-ImageFiles', imagePaths.join('|'));
    const exec = this.execFileFn || execFile;
    return new Promise((resolve) => {
      exec('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 45_000 }, (error, stdout) => {
        fs.rm(file, { force: true }, () => {});
        resolve(parseDesktopResult(error, stdout));
      });
    });
  },

  // The title the desktop shows for a session: its own, else what we last saw.
  claudeDesktopTitle(desktopId) {
    let own = ''; try { own = this.desktopSession?.(desktopId)?.title || ''; } catch { /* store being rewritten */ }
    if (own) return own;
    for (const meta of this.claudeThreads?.values?.() || []) if (meta.desktopId === desktopId && meta.title) return meta.title;
    return '';
  },

  // Returns a turn result when the desktop took the message, or null when the
  // connector should run the turn itself.
  async deliverClaudeToDesktop(threadId, args) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta?.desktopId || !meta.sessionId || !(await this.desktopShouldTakeClaudeSession(meta.sessionId))) return null;
    const { text, imagePaths } = this.claudeAttachmentParts(args);
    if (!text && !imagePaths.length) throw new Error('消息为空');
    if (!this._claudeDesktopSendChain) this._claudeDesktopSendChain = Promise.resolve();
    const run = this._claudeDesktopSendChain.then(async () => {
      // A model / effort chosen while the previous turn ran goes first.
      if (meta.pendingDesktopSettings) await this.flushClaudeDesktopSettings(threadId);
      else if (meta.effortOverride && !(await this.desktopHoldsClaudeSession(meta.sessionId))) {
        // The desktop stopped the idle process; a new one starts at the
        // desktop's recorded level, so the phone's level is set again first.
        const restore = this.claudeDesktop.focusedSessionId();
        const again = await this.runDesktopSend(meta.desktopId, `/effort ${meta.effortOverride.value}`, restore && restore !== meta.desktopId ? restore : '');
        if (!again.ok) this.log(new Error(`effort not re-applied: ${again.reason}`));
      }
      const restoreId = this.claudeDesktop.focusedSessionId();
      const result = await this.runDesktopSend(meta.desktopId, text, restoreId && restoreId !== meta.desktopId ? restoreId : '', { imagePaths });
      if (!result.ok) this.log(`Claude desktop send failed: reason=${desktopReasonCode(result.reason)} delivery=${result.delivery || 'unknown'}`);
      if (!result.ok) throw Object.assign(new Error(DESKTOP_SEND_ERRORS[result.reason] || `发送到电脑端失败：${result.reason}`), {
        delivery: result.delivery === 'not_sent' || ['desktop_draft_present', 'composer_not_found', 'session_not_shown', 'paste_failed', 'window_not_foreground', 'image_needs_foreground', 'image_missing'].includes(result.reason) ? 'not_sent' : 'uncertain',
      });
      // Only one process should hold the session: drop our idle one, if any.
      try { this.claude?.releaseSession?.(threadId); } catch (error) { this.log(error); }
      this.setClaudeThreadFields(threadId, { desktopTurnSince: Date.now() - 1000, transcriptWatched: true, updatedAt: Date.now() });
      this.saveClaudeThreads();
      this.emit('thread.status', threadId, { threadId, status: 'desktop_running', backend: 'claude', updatedAt: Date.now() });
      this.scheduleClaudeTranscriptSync(threadId, 1200);
      return { turnId: `desktop-${Date.now()}`, deliveredTo: 'desktop', backend: 'claude' };
    });
    this._claudeDesktopSendChain = run.catch(() => {});
    return run;
  },

  // Model / effort of a session the desktop runs. The desktop keeps its own
  // per-session choice, so the phone's choice is applied there with Claude
  // Code's own slash commands (`/model`, `/effort`), which the desktop then
  // records in the session (seen: `/model` → session model updated). They run
  // locally and start no turn. While a turn runs they wait and are sent just
  // before the next message from the phone.
  claudeDesktopSettingCommands(pending = {}) {
    const commands = [];
    if (Object.prototype.hasOwnProperty.call(pending, 'model')) {
      const model = String(pending.model || '');
      if (model && !/^[A-Za-z0-9._[\]-]{1,80}$/.test(model)) throw new Error('模型名称无效');
      commands.push(`/model ${model || 'default'}`);
    }
    if (Object.prototype.hasOwnProperty.call(pending, 'effort')) {
      const effort = String(pending.effort || '');
      if (effort && !CLAUDE_EFFORT_LEVELS.has(effort)) throw new Error('思考强度无效');
      commands.push(`/effort ${effort || 'auto'}`);
    }
    return commands;
  },

  async setClaudeDesktopSettings(threadId, changes) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta?.desktopId) throw new Error('这个会话不在电脑端');
    const pending = { ...(meta.pendingDesktopSettings || {}) };
    for (const key of ['model', 'effort']) if (changes[key] !== undefined) pending[key] = String(changes[key] || '');
    this.claudeDesktopSettingCommands(pending); // validate before storing
    this.setClaudeThreadFields(threadId, { pendingDesktopSettings: Object.keys(pending).length ? pending : null });
    this.saveClaudeThreads();
    if (this.claudeDesktopBusy(threadId)) return { applied: false, pending: true };
    this._claudeDesktopSendChain ||= Promise.resolve();
    const run = this._claudeDesktopSendChain.then(() => this.flushClaudeDesktopSettings(threadId));
    this._claudeDesktopSendChain = run.catch(() => {});
    return run;
  },

  // Permission mode of a session the desktop runs. Claude Code has no slash
  // command for it, so the mode is picked from the desktop's own mode menu
  // under the composer, which also works while a turn runs. The desktop then
  // records it in the session, which the sync reads back.
  async setClaudeDesktopPermissionMode(threadId, mode) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta?.desktopId) throw new Error('这个会话不在电脑端');
    const label = DESKTOP_PERMISSION_LABELS[mode];
    if (!label) throw new Error('权限模式无效');
    this._claudeDesktopSendChain ||= Promise.resolve();
    const run = this._claudeDesktopSendChain.then(async () => {
      const restoreId = this.claudeDesktop.focusedSessionId();
      const result = await this.runDesktopSend(meta.desktopId, label, restoreId && restoreId !== meta.desktopId ? restoreId : '', { mode: 'permission' });
      if (!result.ok) {
        const code = desktopReasonCode(result.reason);
        // What the menu showed is kept in the log, so a menu the script could not read can be fixed.
        if (code !== result.reason) this.log(`desktop permission mode ${mode} not applied: ${String(result.reason).slice(0, 400)}`);
        throw new Error(DESKTOP_SEND_ERRORS[code] || `没能在电脑端切换权限模式：${code}`);
      }
      this.setClaudeThreadFields(threadId, { approveMode: mode });
      this.saveClaudeThreads();
      return { applied: true, pending: false };
    });
    this._claudeDesktopSendChain = run.catch(() => {});
    return run;
  },

  // Send the stored settings commands; called inside the desktop send chain.
  async flushClaudeDesktopSettings(threadId) {
    const meta = this.claudeThreads.get(threadId);
    const pending = meta?.pendingDesktopSettings;
    if (!meta?.desktopId || !pending || !Object.keys(pending).length) return { applied: true, pending: false };
    const restoreId = this.claudeDesktop.focusedSessionId();
    for (const command of this.claudeDesktopSettingCommands(pending)) {
      const result = await this.runDesktopSend(meta.desktopId, command, restoreId && restoreId !== meta.desktopId ? restoreId : '');
      if (!result.ok) throw new Error(DESKTOP_SEND_ERRORS[result.reason] || `没能在电脑端切换设置：${result.reason}`);
    }
    const fields = { pendingDesktopSettings: null };
    if (Object.prototype.hasOwnProperty.call(pending, 'model')) fields.model = pending.model;
    if (Object.prototype.hasOwnProperty.call(pending, 'effort')) {
      fields.effort = pending.effort;
      // /effort lasts only for the session's current process; the desktop's
      // own record keeps the old level. Remember the phone's choice until
      // that record changes (the user then chose on the desktop).
      const desktopEffort = this.claudeDesktop?.listSessions?.().find((session) => session.desktopId === meta.desktopId)?.effort || '';
      fields.effortOverride = pending.effort && pending.effort !== desktopEffort ? { value: pending.effort, desktopEffort } : null;
    }
    this.setClaudeThreadFields(threadId, fields);
    this.saveClaudeThreads();
    return { applied: true, pending: false };
  },

  // Stop a turn the desktop is running, the same way as pressing Esc there.
  async interruptClaudeOnDesktop(threadId) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta?.desktopId || !(await this.desktopHoldsClaudeSession(meta.sessionId))) return null;
    const restoreId = this.claudeDesktop.focusedSessionId();
    const result = await this.runDesktopSend(meta.desktopId, '', restoreId && restoreId !== meta.desktopId ? restoreId : '', { mode: 'interrupt' });
    if (!result.ok) throw new Error(DESKTOP_SEND_ERRORS[result.reason] || `没能在电脑端停止：${result.reason}`);
    return { interrupted: true, on: 'desktop' };
  },

  // Answer a desktop prompt from the phone:
  //  - permission: choice allow | deny
  //  - question:   answers [{ labels: [...], other: 'free text' }], one per question
  //                (legacy: choices ['label', ...] for single-choice questions)
  //  - plan:       choice accept | accept_auto | reject | revise (+ feedback)
  // Only the prompt the phone was shown, still unanswered, with choices it
  // actually offers; the desktop then has to log the response.
  async answerClaudeOnDesktop(threadId, { requestId, choice, choices, answers, feedback } = {}) {
    // Approval and sends both navigate the desktop; serialize them together.
    this._claudeDesktopSendChain ||= Promise.resolve();
    const run = this._claudeDesktopSendChain.then(() => this.answerClaudeOnDesktopNow(threadId, { requestId, choice, choices, answers, feedback }));
    this._claudeDesktopSendChain = run.catch(() => {});
    return run;
  },

  inspectClaudeDesktopPermission(desktopId) {
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ANSWER_SCRIPT, '-SessionId', desktopId, '-Kind', 'inspect', '-NoNavigate'];
    const exec = this.execFileFn || execFile;
    return new Promise((resolve) => {
      exec('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 15_000 }, (error, stdout) => {
        resolve(parseDesktopResult(error, stdout));
      });
    });
  },

  // Start a phone-created task inside Claude Desktop's authenticated Code
  // session. The standalone bundled claude.exe is deliberately not given the
  // desktop app's credentials, so it cannot be used for a new task on machines
  // where the desktop injects OAuth state. The script opens the official
  // claude://code/new?folder=... deep link and submits the prompt through UI
  // Automation, then this method links the newly-created desktop session to
  // the KH Link thread by its read-only local session metadata.
  async startClaudeDesktopNewSession(threadId, args = {}) {
    if (!this.claudeDesktop?.available?.()) return null;
    const live = await this.claudeLiveSnapshot();
    if (!live?.appRunning) return null;
    const script = this.claudeDesktopNewScript || NEW_SEND_SCRIPT;
    if (!(await claudeDesktopAssetsPresent(script))) throw Object.assign(new Error(ADAPTER_ERRORS.adapter_missing), { delivery: 'not_sent' });
    const text = String(args.text || '').trim();
    const imagePaths = Array.isArray(args.imagePaths) ? args.imagePaths.filter((file) => file && fs.existsSync(file)) : [];
    if (!text && !imagePaths.length) throw new Error('消息为空');
    const before = new Set((this.claudeDesktop.listSessions?.() || []).map((session) => session.desktopId));
    const startedAt = Date.now();
    const restoreId = args.confirmTrust ? String(args.restoreId || '') : (this.claudeDesktop.focusedSessionId?.() || '');
    const file = path.join(os.tmpdir(), `kh-link-claude-new-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    const folder = args.cwd || args.workdir || this.config.workspace || '';
    const psArgs = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-TextFile', file];
    if (folder) psArgs.push('-Folder', folder);
    if (restoreId) psArgs.push('-RestoreId', restoreId);
    // The desktop asks "Trust this workspace?" on every deep-link launch, even
    // for a folder trusted a minute earlier. The owner chose (2026-10-09) that
    // every task KH Link creates is approved automatically.
    psArgs.push('-ConfirmTrust');
    if (imagePaths.length) psArgs.push('-ImageFiles', imagePaths.join('|'));
    const exec = this.execFileFn || execFile;
    let result;
    try {
      result = await new Promise((resolve) => {
        exec('powershell.exe', psArgs, { windowsHide: true, encoding: 'utf8', timeout: 75_000 }, (error, stdout) => {
          resolve(parseDesktopResult(error, stdout));
        });
      });
    } finally { fs.rm(file, { force: true }, () => {}); }
    if (!result?.ok) {
      if (result?.reason === 'trust_required') {
        this.pendingClaudeWorkspaceTrust ||= new Map();
        this.pendingClaudeWorkspaceTrust.set(threadId, {
          text,
          imagePaths,
          cwd: folder,
          model: args.model,
          effort: args.effort,
          permissionMode: args.permissionMode || args.mode,
          restoreId,
          requestedAt: startedAt,
        });
        return {
          requiresConfirmation: {
            kind: 'workspaceTrust',
            folder: result.detail?.folder || folder,
          },
        };
      }
      const reasons = {
        ...ADAPTER_ERRORS,
        desktop_not_running: '电脑端 Claude 没有在运行。',
        folder_not_found: '选择的 Claude 工作目录不存在。',
        composer_not_found: '没能在电脑端 Claude 的新任务页面找到输入框。',
        new_page_not_open: '电脑端没有打开这个文件夹的新会话页面，为免发到别的会话，已取消。',
        desktop_draft_present: '电脑端 Claude 新任务输入框已有草稿，为避免误发已取消。',
        paste_failed: '没能把消息填入电脑端 Claude 新任务输入框。',
        image_needs_foreground: '图片需要电脑端 Claude 窗口切到前台，已取消发送。',
        image_missing: '图片文件已不可用，新任务消息没有发出；请重新选择图片。',
        send_not_ready: '电脑端 Claude 新任务的发送按钮尚未就绪。',
        not_sent: '消息已填入电脑端 Claude，但发送没有生效。',
      };
      this.log(`Claude desktop new task failed: reason=${desktopReasonCode(result?.reason)} delivery=${result?.delivery || 'unknown'}`);
      const beforeSend = ['desktop_not_running', 'folder_not_found', 'empty_text', 'composer_not_found', 'new_page_not_open', 'desktop_draft_present', 'paste_failed', 'image_needs_foreground', 'image_missing', 'send_not_ready'].includes(result?.reason);
      throw Object.assign(new Error(reasons[result?.reason] || `电脑端 Claude 新任务失败：${result?.reason || 'unknown'}`), {
        delivery: result?.delivery === 'not_sent' || beforeSend ? 'not_sent' : 'uncertain',
      });
    }
    // The desktop writes its local_<id>.json record shortly after the deep
    // link is submitted. Match by a new id and the requested folder; never
    // infer a session id from command output or any credential-bearing file.
    const wanted = folder ? path.resolve(folder).toLowerCase() : '';
    let found = null;
    for (let i = 0; i < 80 && !found; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const sessions = this.claudeDesktop.listSessions?.() || [];
      const candidates = sessions.filter((session) => !before.has(session.desktopId) && session.cliSessionId &&
        (!wanted || path.resolve(session.cwd || '').toLowerCase() === wanted || (session.createdAt || 0) >= startedAt - 2_000));
      found = candidates.sort((a, b) => (b.focusedAt || 0) - (a.focusedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
    }
    if (!found) throw Object.assign(new Error('电脑端 Claude 新任务已发送，但暂时没有找到对应会话。'), { delivery: 'uncertain' });
    this.setClaudeThreadFields(threadId, {
      desktopId: found.desktopId, sessionId: found.cliSessionId, desktopLive: true,
      transcriptWatched: true, desktopTurnSince: Date.now() - 1_000,
      updatedAt: Date.now(), activityAt: Date.now(),
    });
    this.saveClaudeThreads();
    this.emit('thread.status', threadId, { threadId, status: 'desktop_running', backend: 'claude', updatedAt: Date.now() });
    this.scheduleClaudeTranscriptSync(threadId, 1_200);
    this.pendingClaudeWorkspaceTrust?.delete(threadId);
    return { turnId: `desktop-${Date.now()}`, deliveredTo: 'desktop', backend: 'claude', desktopId: found.desktopId, sessionId: found.cliSessionId };
  },

  // Older phone builds still answer a workspace-trust request explicitly.
  async confirmClaudeWorkspaceTrust(threadId) {
    const pending = this.pendingClaudeWorkspaceTrust?.get(threadId);
    if (!pending) throw new Error('这个工作目录的确认已过期，请重新新建任务。');
    const result = await this.startClaudeDesktopNewSession(threadId, { ...pending, confirmTrust: true });
    if (result?.requiresConfirmation) throw new Error('电脑端的信任确认框仍未完成，请稍后重试。');
    return { threadId, turn: result, backend: 'claude' };
  },

  // Leave the desktop safety dialog untouched. The phone cancellation forgets
  // the pending request immediately and never caches a trust decision.
  cancelClaudeWorkspaceTrust(threadId) {
    const existed = Boolean(this.pendingClaudeWorkspaceTrust?.delete(threadId));
    return { threadId, cancelled: true, existed };
  },

  async answerClaudeOnDesktopNow(threadId, { requestId, choice, choices, answers, feedback } = {}) {
    const meta = this.claudeThreads.get(threadId);
    const detail = meta?.waitingDetail;
    if (!meta?.desktopId || !detail || !requestId || detail.requestId !== requestId) throw new Error('这个提示已经处理过或已经变了，请刷新后再看。');
    if (detail.source === 'session-offer' || detail.source === 'workspace-trust') return this.answerClaudeDesktopCard(threadId, meta, detail, { choice, choices, answers });
    const pending = this.claudeDesktop?.pendingPrompts?.(Date.now());
    const logRequestId = detail.source === 'desktop-ui' ? detail.logRequestId : requestId;
    if (pending && pending.get(meta.desktopId)?.requestId !== logRequestId) throw new Error('这个提示已经处理过了。');
    const temp = [];
    const tempFile = (content) => { const file = path.join(os.tmpdir(), `kh-link-claude-${crypto.randomUUID()}.txt`); fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 }); temp.push(file); return file; };
    let kind; let picked; const extra = [];
    if (detail.kind === 'permission') {
      if (!['allow', 'deny', 'allow_auto'].includes(choice)) throw new Error('只能选择允许、拒绝或允许并切到自动模式');
      kind = 'permission'; picked = choice; extra.push('-ExpectFile', tempFile(String(detail.summary || '')), '-RequestId', logRequestId);
      if (detail.source === 'desktop-ui') extra.push('-PromptFile', tempFile(JSON.stringify(detail.desktopPrompt)));
    } else if (detail.kind === 'question') {
      const questions = detail.questions || [];
      const given = Array.isArray(answers) ? answers : (Array.isArray(choices) ? choices.map((label) => ({ labels: [label] })) : []);
      if (!questions.length || given.length !== questions.length) throw new Error('回答和问题对不上');
      // Desktop 2.42304 uses unnumbered toggle controls for single choice too;
      // older builds used numbered buttons. Pass each page's identity as well
      // as its choices so repeated labels on different pages cannot skip one.
      const pages = questions.map((question, i) => {
        const labels = (Array.isArray(given[i]?.labels) ? given[i].labels : []).map(String);
        const other = String(given[i]?.other || '').trim().slice(0, 2000);
        if (other && question.allowOther === false) throw new Error('这个提示只能从给出的选项里选');
        if (labels.some((label) => !question.options.some((o) => o.label === label))) throw new Error('选项和问题对不上');
        if (question.multiSelect ? !labels.length && !other : labels.length + (other ? 1 : 0) !== 1) throw new Error(`「${question.question}」需要${question.multiSelect ? '至少选一项' : '选一项'}`);
        return {
          question: String(question.question || ''), multi: !!question.multiSelect, other: other || null,
          // A card read from the window carries each button's own name.
          options: question.options.map((o) => ({ name: o.name || `${o.label} ${o.description || `Choose ${o.label}`}`.replace(/\s+/g, ' '), chosen: labels.includes(o.label) })),
        };
      });
      kind = 'question'; picked = tempFile(JSON.stringify(pages)); extra.push('-ExpectFile', tempFile(String(questions[0].question || '')), '-RequestId', logRequestId);
    } else if (detail.kind === 'plan') {
      if (!['accept', 'accept_auto', 'reject', 'revise'].includes(choice)) throw new Error('计划只能接受、拒绝或提修改意见');
      const text = String(feedback || '').trim().slice(0, 4000);
      if (choice === 'revise' && !text) throw new Error('请写下修改意见');
      kind = 'plan'; picked = choice;
      if (choice === 'revise') extra.push('-FeedbackFile', tempFile(text));
    } else throw new Error('这个提示需要在电脑上处理');
    const restoreId = this.claudeDesktop.focusedSessionId?.();
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ANSWER_SCRIPT, '-SessionId', meta.desktopId, '-Kind', kind, '-Choice', picked, ...extra];
    if (restoreId && restoreId !== meta.desktopId) args.push('-RestoreId', restoreId);
    const exec = this.execFileFn || execFile;
    const runOnce = () => new Promise((resolve) => {
      exec('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 60_000 }, (error, stdout) => {
        resolve(parseDesktopResult(error, stdout));
      });
    });
    let result;
    try {
      result = await runOnce();
      // The first try often lands while Claude's window is still coming to the
      // front and redrawing the card: the page is not found yet, or the click
      // is not taken. The phone's second tap then worked. Do that second try
      // here, only while the desktop still shows this same unanswered prompt;
      // if it no longer does, the first click went through after all.
      if (!result.ok && desktopAnswerRetryable(kind, result.reason)) {
        await new Promise((resolve) => setTimeout(resolve, this.answerRetryMs ?? 1200));
        const pendingNow = this.claudeDesktop?.pendingPrompts?.(Date.now());
        if (pendingNow && pendingNow.get(meta.desktopId)?.requestId !== logRequestId) result = { ok: true };
        else {
          this.log(`desktop prompt answer retry after ${result.reason}`);
          result = await runOnce();
        }
      }
      // A scheduled task's dialog has no "Allow and switch to Auto" (only
      // "Always allow" for the task, 2026-11-06). Do what was asked in two
      // steps: allow this request once, then switch the session to Auto below.
      if (!result.ok && kind === 'permission' && picked === 'allow_auto' && result.reason === 'auto_not_offered') {
        args[args.indexOf('-Choice') + 1] = 'allow';
        result = await runOnce();
        if (result.ok) result.switchModeAfter = true;
      }
    } finally { for (const file of temp) fs.rm(file, { force: true }, () => {}); }
    if (!result.ok && ['prompt_mismatch', 'request_stale'].includes(result.reason)) {
      const current = this.claudeDesktop?.pendingPrompts?.(Date.now())?.get(meta.desktopId);
      const refreshed = kind === 'permission' ? desktopPermissionDetail(result.prompt, current, meta.desktopId) : null;
      if (refreshed) {
        this.setClaudeThreadFields(threadId, { waitingCategory: 'prompt', waitingRequestId: current.requestId, waitingDetail: refreshed, waitingText: promptLabel(refreshed.tool), waitingAt: Date.now() });
        this.saveClaudeThreads();
        await this.syncClaudeThreadMetadata(threadId, true);
        this.emit('thread.status', threadId, { threadId, status: 'desktop_waiting', backend: 'claude', updatedAt: Date.now() });
        this.emit('threads.updated', null, { backend: 'claude', count: 1, updatedAt: Date.now() });
        // The original choice must never carry over to the replacement card.
        return { answered: false, refreshed: true, kind };
      }
    }
    if (!result.ok) throw new Error(DESKTOP_ANSWER_ERRORS[result.reason] || `没能在电脑端操作：${result.reason}`);
    // The desktop logs the response; wait briefly for it, then refresh states.
    for (let i = 0; i < 10; i++) {
      const now = this.claudeDesktop?.pendingPrompts?.(Date.now());
      if (!now || now.get(meta.desktopId)?.requestId !== logRequestId) break;
      await new Promise((resolve) => setTimeout(resolve, this.answerPollMs ?? 500));
    }
    await this.syncClaudeDesktopSessions?.().catch?.((e) => this.log(e));
    if (result.switchModeAfter) {
      // After the reply: two script runs and the mode menu together can pass
      // the phone's 60 s wait. The new mode reaches the phone with the session
      // sync (thread.settings); a menu that refuses it is only logged.
      this.setClaudeDesktopPermissionMode(threadId, 'auto')
        .then(() => this.log(`allow_auto fallback: ${threadId} allowed once and switched to Auto`))
        .catch((error) => this.log(`allow_auto fallback: ${threadId} allowed once, mode not switched: ${error.message}`));
    }
    return { answered: true, kind, choice: kind === 'question' ? undefined : picked, ...(result.switchModeAfter ? { modeSwitch: 'auto' } : {}) };
  },

  // ---- sidebar: pin / unpin / rename from the phone ----------------------
  // `archived`: which sidebar list the row is in (Active, or Archived while unarchiving).
  claudeSidebarTarget(threadId, { archived = false } = {}) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta?.desktopId) throw new Error('这个会话还没有出现在电脑端');
    const sessions = this.claudeDesktop?.listSessions?.() || [];
    const current = sessions.find(session => session.desktopId === meta.desktopId);
    if (!current) throw sidebarError('row_not_found');
    const title = String(current.title || '').trim();
    if (!title) throw sidebarError('bad_title');
    // The sidebar row is found by title. When other sessions share it (a
    // scheduled task's daily runs), rename and archive open this very session
    // and use the toolbar menu above it instead; pin is only in the sidebar.
    const shared = sessions.some((other) => other.desktopId !== meta.desktopId && !!other.archived === archived && String(other.title || '').trim() === title);
    return { meta, title, viaToolbar: shared, sessionId: meta.desktopId };
  },

  desktopSession(desktopId) { return (this.claudeDesktop?.listSessions?.() || []).find((session) => session.desktopId === desktopId) || null; },

  async pinClaudeOnDesktop(threadId, pinned) {
    const { meta, title, viaToolbar } = this.claudeSidebarTarget(threadId);
    if (Boolean(this.desktopSession(meta.desktopId)?.pinned) === pinned) return { pinned, changed: false };
    if (viaToolbar) throw sidebarError('ambiguous_pin');
    const result = await runSidebarScript({ app: 'claude', action: pinned ? 'pin' : 'unpin', title, execFileFn: this.execFileFn });
    if (!result.ok) throw sidebarError(result.reason);
    if (!(await waitUntil(() => Boolean(this.desktopSession(meta.desktopId)?.pinned) === pinned))) throw sidebarError('not_applied');
    await this.syncClaudeDesktopSessions?.().catch?.((e) => this.log(e));
    return { pinned, changed: true };
  },

  async renameClaudeOnDesktop(threadId, name) {
    const wanted = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!wanted) throw new Error('名字不能为空');
    const { meta, title, viaToolbar, sessionId } = this.claudeSidebarTarget(threadId);
    if (wanted === title) return { renamed: true, changed: false };
    const result = await runSidebarScript({ app: 'claude', action: 'rename', title, name: wanted, viaToolbar, sessionId, execFileFn: this.execFileFn });
    if (!result.ok) throw sidebarError(result.reason);
    if (!(await waitUntil(() => this.desktopSession(meta.desktopId)?.title === wanted))) throw sidebarError('not_applied');
    await this.syncClaudeDesktopSessions?.().catch?.((e) => this.log(e));
    return { renamed: true, changed: true };
  },

  // The sync takes `archived` from the desktop's own record, so archiving only
  // in our list would be undone on the next pass: it is done on the desktop.
  async archiveClaudeOnDesktop(threadId, archived) {
    const desktopId = this.claudeThreads.get(threadId)?.desktopId;
    const current = desktopId ? this.desktopSession(desktopId) : null;
    if (desktopId && !current) throw new Error('电脑端找不到这个会话，请在电脑上操作');
    if (current && Boolean(current.archived) === archived) {
      this.upsertClaudeThread(threadId, { archived });
      return { archived, changed: false };
    }
    const { meta, title, viaToolbar, sessionId } = this.claudeSidebarTarget(threadId, { archived: !archived });
    // Archived sessions are not opened from the toolbar route: unarchive keeps the title rule.
    if (viaToolbar && !archived) throw sidebarError('ambiguous_title');
    const result = await runSidebarScript({ app: 'claude', action: archived ? 'archive' : 'unarchive', title, viaToolbar, sessionId, execFileFn: this.execFileFn });
    if (!result.ok) throw sidebarError(result.reason);
    if (!(await waitUntil(() => Boolean(this.desktopSession(meta.desktopId)?.archived) === archived))) throw sidebarError('not_applied');
    await this.syncClaudeDesktopSessions?.().catch?.((e) => this.log(e));
    const notRestored = /^status_not_restored:/.test(String(result.state || ''));
    return { archived, changed: true, ...(notRestored ? { reason: '电脑端侧边栏的筛选停在了「已归档」，请在电脑上切回' } : {}) };
  },

  // Bring a session up on the desktop (e.g. to answer a permission prompt).
  async openClaudeOnDesktop(threadId) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta?.desktopId) throw new Error('这个会话还没有出现在电脑端');
    const result = await this.runDesktopSend(meta.desktopId, '', '', { mode: 'open' });
    if (!result.ok) throw new Error(DESKTOP_SEND_ERRORS[result.reason] || `没能在电脑上打开：${result.reason}`);
    return { opened: true };
  },

  // A prompt in a session the desktop is not showing (a question card that is
  // not in the transcript, a permission dialog): open it, read the card, and
  // return to the session that was in view, so the phone can show the choices.
  async readClaudeDesktopPrompt(threadId) {
    const meta = this.claudeThreads.get(threadId);
    if (!meta?.desktopId) throw new Error('这个会话还没有出现在电脑端');
    const prompt = this.claudeDesktop.pendingPrompts?.(Date.now())?.get(meta.desktopId);
    if (!prompt?.requestId) throw new Error('电脑端这个会话现在没有在等你回答');
    const restoreId = this.claudeDesktop.focusedSessionId?.();
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ANSWER_SCRIPT, '-SessionId', meta.desktopId, '-Kind', 'inspect'];
    if (restoreId && restoreId !== meta.desktopId) args.push('-RestoreId', restoreId);
    const exec = this.execFileFn || execFile;
    const result = await new Promise((resolve) => {
      exec('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 60_000 }, (error, stdout) => resolve(parseDesktopResult(error, stdout)));
    });
    if (!result?.ok) throw new Error(DESKTOP_ANSWER_ERRORS[result?.reason] || `没能读取电脑上的提示：${result?.reason || 'unknown'}`);
    // The user may have answered on the computer meanwhile.
    if (this.claudeDesktop.pendingPrompts?.(Date.now())?.get(meta.desktopId)?.requestId !== prompt.requestId) return { read: false, reason: '这个提示已经处理过了' };
    const detail = desktopPermissionDetail(result.prompt, prompt, meta.desktopId) || desktopQuestionDetail(result.prompt, prompt, meta.desktopId);
    if (!detail) throw new Error('电脑上没找到这个提示的选项，请在电脑上处理');
    this.setClaudeThreadFields(threadId, { waitingRequestId: prompt.requestId, waitingDetail: detail });
    this.saveClaudeThreads();
    this.emit('thread.status', threadId, { threadId, status: this.claudeThreadStatus(threadId), backend: 'claude', updatedAt: Date.now() });
    await this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
    return { read: true };
  },

  // ---- phone → desktop sidebar -------------------------------------------
  // A session created on the phone is imported into the desktop app (its
  // sidebar shows it right away). The desktop's own session record is then
  // picked up by the sync loop and linked to this thread via the session id.
  registerClaudeThreadOnDesktop(threadId) {
    if (this.claudeProfileLock?.switching()) return; // The next normal sync retries after switching.
    const meta = this.claudeThreads.get(threadId);
    if (!meta || meta.desktopId || meta.desktopImportRequestedAt || !meta.sessionId || meta.origin === 'desktop' || !this.claudeDesktop?.available?.()) return;
    this.setClaudeThreadFields(threadId, { desktopImportRequestedAt: Date.now() }); this.saveClaudeThreads();
    const restore = this.claudeDesktop.focusedSessionId?.();
    // Keep the lease for the whole asynchronous import, not just its dispatch.
    const importSession = () => this.claudeDesktop.importSession(meta.sessionId, restore);
    return (this.claudeProfileLock ? this.claudeProfileLock.withLease(importSession) : importSession()).then((ok) => {
      if (!ok) { this.setClaudeThreadFields(threadId, { desktopImportRequestedAt: null }); this.saveClaudeThreads(); return; }
      // Let the desktop own it; our idle process would otherwise hold it too.
      setTimeout(() => { try { this.claude?.releaseSession?.(threadId); } catch (error) { this.log(error); } }, 5_000).unref?.();
    }).catch((error) => {
      this.setClaudeThreadFields(threadId, { desktopImportRequestedAt: null }); this.saveClaudeThreads();
      this.log(error);
    });
  },

  claudeModelDisplay(value) {
    const found = (this.claudeModels || []).find((model) => model.value === value);
    return found ? found.label : prettyModelId(value);
  },
};

// Hold an OS-visible lease throughout every Desktop operation, including work
// queued behind an earlier message. The switcher refuses to exit while leased.
for (const name of [
  'runDesktopSendOnce', 'deliverClaudeToDesktop', 'setClaudeDesktopSettings',
  'setClaudeDesktopPermissionMode', 'flushClaudeDesktopSettings', 'interruptClaudeOnDesktop',
  'answerClaudeOnDesktop', 'answerClaudeOnDesktopNow', 'startClaudeDesktopNewSession',
  'confirmClaudeWorkspaceTrust', 'pinClaudeOnDesktop', 'renameClaudeOnDesktop',
  'archiveClaudeOnDesktop', 'openClaudeOnDesktop', 'readClaudeDesktopPrompt',
]) {
  const original = methods[name];
  methods[name] = function (...args) {
    const action = () => original.apply(this, args);
    return this.claudeProfileLock ? this.claudeProfileLock.withLease(action) : action();
  };
}
function install(Connector) { Object.assign(Connector.prototype, methods); }

module.exports = {
  claudeBlockedForUser, claudeBlockedText, claudeWaiting, install, methods, DESKTOP_SEND_ERRORS, keepLiveOnFailure };
