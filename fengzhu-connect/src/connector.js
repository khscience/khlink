const crypto = require('node:crypto');
const CONNECTOR_VERSION = require('../package.json').version;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeDataDirs } = require('./backends/claude-desktop-paths');
const { StringDecoder } = require('node:string_decoder');
const WebSocket = require('ws');
const { BridgeApi } = require('./api');
const { loadConfig, relayEnabled } = require('./config');
const { wrapAccountKey } = require('./device-key');
const { CodexClient } = require('./codex-client');
const { CodexBackend } = require('./backends/codex-backend');
const { ClaudeBackend, normalizePermissionMode } = require('./backends/claude-backend');
const claudeDesktopSync = require('./backends/claude-desktop-sync');
const piSync = require('./backends/pi-sync');
const antigravitySync = require('./backends/antigravity-sync');
const dshSync = require('./backends/dsh-sync');
const hermesSync = require('./backends/hermes-sync');
const { encryptJson, decryptJson, blobFields, FILE_BLOB } = require('./crypto');
const { LightMode, accountThreadTag } = require('./light-mode');
const { ClaudeStatusline, rateLimitInfo } = require('./claude-statusline');
// Mobile turn/queue actions a Claude thread handles itself (never via the Codex/Desktop queue).
const CLAUDE_QUEUE_ACTIONS = new Set(['turn.start', 'turn.steer', 'followup.enqueue', 'followup.cancel', 'followup.steer', 'followup.steer_all']);
// 2026-10-18: Claude Desktop account switching is temporarily closed after the
// remote-control compliance review. Profiles, usage records and switches under
// G:\Apps\ClaudeSwitch stay; only the phone-facing commands are gated. Set
// KH_LINK_CLAUDE_ACCOUNT_SWITCH=1 only when the feature is deliberately restored.
const CLAUDE_ACCOUNT_SWITCH_ENABLED = process.env.KH_LINK_CLAUDE_ACCOUNT_SWITCH === '1';
const { DesktopAdapter } = require('./desktop-adapter');
const { CodexDesktopSteer } = require('./codex-desktop-steer');
const { CodexDesktopAnswer, canAnswerDesktopQuestion, desktopQuestionAnswer, questionRolloutState, questionAnswerMatches, pendingDesktopQuestion } = require('./codex-desktop-answer');
const { AttachmentStore, isImageAttachment } = require('./attachment-store');
const { FollowupStore, normalizeText, publicItem } = require('./followup-store');
const { runSidebarScript, sidebarError, waitUntil } = require('./desktop-sidebar');
const { ThreadOwnershipStore } = require('./thread-ownership-store');
const { ProcessLock } = require('./process-lock');
const files = require('./files');
const { takeSyncTally } = require('./sync-probe');
const { PcLoad } = require('./pc-load');
const { LatestFileWriter } = require('./latest-file-writer');
const { SendReceipts, UNCERTAIN: SEND_RECEIPT_UNCERTAIN } = require('./send-receipts');
const { clip, extractInlineImages, hasGeneratedImageMarker, stripLocalImageMarkup, stripProposedPlanMarkup, isInternalContextText, normalizeThread, normalizeItems, readDesktopPinState, applyDesktopPin } = require('./history');
const { sanitizeUploadReferences, publicAttachments } = require('./attachment-privacy');
const { LightDetailTransfers, LEGACY_DETAIL_JSON_BYTES } = require('./light-detail-transfer');
const { readConversationActivityAt } = require('./codex-activity');
const { withRequestMarker, requestMarkerId, stripRequestMarker } = require('./request-marker');
const { ConversationUsageReader } = require('./conversation-usage');
const { CodexQuestionTracker, questionEvent, isCodexQuestionReply } = require('./codex-questions');
const { transcriptPath: usageTranscriptPath } = require('./backends/claude-desktop');

const STALE_ACTIVE_ROLLOUT_MS = 24 * 60 * 60_000;
// A quiet old rollout alone is not enough to restore a live state at startup.
// A thread/list absence or an elapsed period is never an end event.
const STALE_ORPHAN_ROLLOUT_MS = 10 * 60_000;
// Kept as a compatibility constant for older status tests.
const DESKTOP_STATUS_IDLE_GRACE_MS = 20_000;
// The 2s thread/list poll can still report a just-completed thread as
// active for one more cycle. Suppress a spurious 'desktop_running'
// re-publish only for a short window after the terminal status was
// recorded (this.desktopStatusAt), then allow a genuinely new turn on the
// same (commonly pinned/reused) thread to be reported as running again.
// This only guards terminal-to-running transitions; silence and list absence
// never end a turn.
const DESKTOP_STATUS_REACTIVATE_GRACE_MS = 4_000;
const RELAY_GAP_BOOTSTRAP_MS = 7 * 86_400_000;
const ROLLOUT_LOOKUP_RETRY_MS = 5 * 60_000;
// Bump this when the rollout-to-history mapping changes so existing files are
// replayed once instead of being treated as already fully synchronized.
const HISTORY_BACKFILL_VERSION = 9;   // 9: restore visible proposed_plan output after blocking answers
// Keep enough of the live rollout tail to include a complete Codex
// image_generation_call JSONL record. Generated images can be several MB;
// the previous one-megabyte tail started in the middle of the JSON line and
// silently dropped the image until a manual full-history reload.
const LIVE_ROLLOUT_TAIL_BYTES = 8 * 1024 * 1024;
// Never allocate a buffer for the whole unread rollout. A single old Codex
// session can grow to several gigabytes; reading that range synchronously
// blocks the connector event loop and can exhaust its memory before the phone
// receives the newest history. Ranges larger than this are streamed below.
const ROLLOUT_STREAM_CHUNK_BYTES = 512 * 1024;
// A history-sync request must make the newest conversation visible first. The
// remaining file is replayed in the background after this bounded tail.
const HISTORY_RECENT_TAIL_BYTES = 32 * 1024 * 1024;
const HISTORY_BATCH_MAX_BYTES = 1_500_000;
const HISTORY_BATCH_MAX_ITEMS = 100;
// The replay itself is fully streaming (bounded 512 KiB reads and 1.5 MB
// uploads), so a large rollout must not be treated as permanently tail-only:
// that leaves hundreds of older turns absent from the server. Keep a generous
// ceiling as a last-resort guard for pathological files, while the normal
// multi-gigabyte sessions are allowed to finish in the background after the
// newest tail has been published.
const HISTORY_FULL_REPLAY_MAX_BYTES = 4 * 1024 * 1024 * 1024;
// A full historical replay must not consume a current pending mobile message
// merely because an old turn has the same text. Follow-up reconciliation is
// still allowed for the recent tail and for records from this short window.
const FOLLOWUP_RECONCILE_MAX_AGE_MS = 10 * 60_000;
const MAX_ROLLOUT_USER_INDEX_EVENTS = 100_000;
// When a bounded tail starts in the middle of a very large JSONL record, keep
// walking backwards in bounded chunks until its line boundary is found. If a
// malformed record exceeds this guard, the cursor backs up by the scanned
// amount and retries on the next watcher tick instead of advancing to EOF.
const MAX_PARTIAL_ROLLOUT_SCAN_BYTES = 128 * 1024 * 1024;
// Relay socket liveness: ping every 25 s; two missed pongs (plus slack) mean the
// connection is half-open and must be replaced.
const SOCKET_PING_INTERVAL_MS = 25_000;
const SOCKET_STALE_MS = 70_000;
const AUTH_RETRY_MS = 60_000;
// Agent tabs are UI hints, not a command-routing probe. Poll the persistent
// desktop adapter every five seconds so a close/reopen reaches the phone in
// roughly one heartbeat window without starting PowerShell per frame.
const AGENT_PRESENCE_POLL_MS = 5_000;

// Relay auth failures surface as "401 {...}" / "403 {...}" from BridgeApi.request,
// or as a missing refresh token.
function isAuthFailure(error) {
  const message = String(error?.message || error || '');
  return /^(401|403)\b/.test(message) || /login required/i.test(message);
}

const LOG_REPEAT_WINDOW_MS = 10 * 60_000;

class Connector {
  constructor(config) {
    // Agent backends live behind a neutral seam (see backends/agent-backend.js).
    // Codex is the default backend; its client stays exposed as this.codex so the
    // existing Codex code paths and tests are unchanged. A second backend (Claude
    // Code) will be registered here and selected per thread via threadBackendId().
    this.config = config; this.api = new BridgeApi(config);
    // Tests never share the user's light-mode setting or stored details.
    this.lightMode = new LightMode(process.env.NODE_TEST_CONTEXT ? fs.mkdtempSync(path.join(os.tmpdir(), 'khlink-light-')) : require('./config').home, {
      // Account-bound tags keep identically named threads isolated across
      // account-key changes without decrypting every newly written row.
      threadTagFor: (threadId) => accountThreadTag(this.config.accountKey, threadId),
      // Legacy files have no thread tag. The AEAD context contains the exact
      // thread and item IDs, allowing ambiguous old rows to be skipped safely.
      acceptsLegacyRow: (threadId, row) => {
        try { decryptJson(this.config.accountKey, { kind: 'history.item', threadId, id: row.id, nonce: row.nonce, ciphertext: row.ciphertext }); return true; }
        catch { return false; }
      },
    });
    try { this.lightMode.prune(); } catch { /* best effort */ }
    // Shrink detail files bloated before 0.2.152 (rows re-appended on every
    // restart), in the background once the connector has settled.
    if (!process.env.NODE_TEST_CONTEXT) {
      setTimeout(() => this.lightMode.compactAll({ log: (message) => (message instanceof Error ? this.log(message) : console.log(`[fengzhu-connect] ${message}`)) }).catch((error) => this.log(error)), 120_000).unref?.();
    }
    this.backend = new CodexBackend(config); this.codex = this.backend.client;
    this.claude = new ClaudeBackend(config);
    this.backends = new Map([[this.backend.id, this.backend], [this.claude.id, this.claude]]);
    this.defaultBackendId = this.backend.id;
    this.ws = null;
    this.threadState = new Map();
    // Persisted thread -> backend map + Claude thread metadata (id, title, workdir,
    // sessionId, settings), so Claude threads survive a connector restart.
    this.claudeThreadsFile = path.join(path.dirname(config.configFile), 'claude-threads.json');
    this.claudeThreads = this.readClaudeThreads();
    for (const [id, meta] of this.claudeThreads) this.threadState.set(id, { backendId: 'claude', model: meta.model, permissionMode: meta.approveMode });
    // Workspace trust is deliberately one-shot and in-memory. A desktop
    // trust prompt is never accepted automatically, and a phone decision is
    // never persisted or reused after this pending request is cleared.
    this.pendingClaudeWorkspaceTrust = new Map();
    this.uploads = new Map(); this.reconnectMs = 1000; this.stopping = false;
    this.lifecycle = 'starting'; this.inFlightCommands = new Set(); this.shutdownPromise = null;
    this.codexRecoveryPromise = null; this.codexRecoveryAttempts = 0; this.codexLastError = null;
    this.idleHostRecyclePromise = null;
    this.sequenceFile = path.join(path.dirname(config.configFile), 'sequence.json');
    this.lastSequence = this.readSequence(); this.heartbeat = null; this.statusHeartbeat = null;
    this.statusFile = path.join(path.dirname(config.configFile), 'status.json');
    // The old connector writes its live snapshot just before a soft reload.
    // These IDs are untrusted hints until the current account's index confirms
    // ownership; they must be captured before start() replaces status.json.
    // A short-lived, local repair request may preserve an observed live hint
    // across a previous connector restart. It is just as untrusted as status.json
    // and must pass the same account and rollout checks before publishing.
    const prebootRequest = path.join(path.dirname(config.configFile), 'codex-status-recovery.request.json');
    this.prebootStatusHints = process.platform === 'win32'
      ? this.readPrebootStatusHints(this.statusFile, prebootRequest) : new Set();
    this.prebootStatusHintsNextAt = 0; this.prebootStatusHintsCheckPromise = null;
    this.processLock = new ProcessLock(path.join(path.dirname(config.configFile), 'connector.lock'));
    this.historyDigestFile = path.join(path.dirname(config.configFile), 'history-digests.json');
    const savedDigests = this.readHistoryDigests();
    this.threadDigests = new Map(savedDigests.threads || []); this.threadItemDigests = new Map(savedDigests.items || []);
    this.historyBackfills = new Map(savedDigests.backfills || []);
    this.historyBackfillPromises = new Map();
    this.threadSyncPromises = new Map(); this.realtimeThreads = new Map();
    this.realtimeSyncTimer = null; this.realtimeSyncRunning = false;
    this.sessionWatcher = null; this.desktopSyncTimers = new Map(); this.desktopSyncRunning = false;
    this.pendingDesktopThreads = new Set(); this.desktopSyncAt = new Map();
    this.rolloutOffsets = new Map(); this.rolloutPartialOffsets = new Map();
    this.rolloutFilesByThread = new Map(); this.rolloutStatusScans = new Map();
    // The last terminal rollout marker published for each thread.  A watcher
    // callback can finish after a newer callback and hand us an older slice of
    // the JSONL file; that slice must never reopen the finished turn.
    this.rolloutTerminalWatermarks = new Map();
    // Rollout files repeat the same thread settings record frequently (and a
    // full replay can contain thousands of historical copies). Keep the last
    // rollout snapshot per thread so a replay can publish at most one event
    // for a given effective value, and never let an older historical record
    // overwrite a newer live setting.
    this.rolloutSettingsSnapshots = new Map();
    this.rolloutLookupAt = new Map();
    this.hiddenRollouts = new Set();
    this.desktopMetadataAt = new Map();
    this.followups = new FollowupStore();
    this.followups.onSaveError = (error) => this.log(new Error(`Follow-up queue persistence deferred: ${error.message}`));
    this.recoverInterruptedFollowups();
    this.attachmentStore = new AttachmentStore();
    this.threadOwnership = new ThreadOwnershipStore(path.join(path.dirname(config.configFile), 'thread-ownership.json'), {
      // The ownership store is advisory, but its lease must follow the
      // persistent Codex host rather than wall-clock idleness. The native
      // Desktop probe sees the host's legitimate writer lock too; retaining
      // ownership while this exact host is ready prevents that lock from
      // being misclassified as a Desktop takeover.
      keepLease: (record) => this.isCurrentCodexHostOwner(record),
    });
    this.bridgeInstanceId = crypto.randomUUID();
    this.questionLiveSince = Date.now();
    this.desktopAdapter = new DesktopAdapter({ ...config, log: (message) => this.log(message) }); this.followupRetryRunning = false;
    this.codexDesktopSteer = process.platform === 'win32' ? new CodexDesktopSteer() : null;
    this.codexDesktopAnswer = process.platform === 'win32' ? new CodexDesktopAnswer() : null;
    // `null` means the first lightweight desktop-window scan has not completed
    // yet. Android renders that as Unknown instead of briefly claiming that a
    // closed application is definitely available.
    this.desktopAgentPresence = { codex: null, claude: null, antigravity: null };
    this.desktopAgentPresenceAt = 0;
    this.desktopAgentPresencePromise = null;
    this.desktopAgentPresenceTimer = null;
    this.defaultModelId = null;
    this.mobileOwnedThreads = new Set();
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.desktopStateFile = path.join(codexHome, '.codex-global-state.json');
    this.desktopPins = null; this.desktopPinSignature = null; this.desktopStatuses = new Map(); this.desktopActiveThreads = new Set();
    this.desktopStatusAt = new Map(); this.desktopLastActiveAt = new Map();
    this.desktopActivitySnapshotAt = 0; this.desktopActivitySnapshotHealthy = false;
    // A pre-boot rollout without an end record may be replayed as "running"
    // indefinitely. Keep the boot estimate fixed for this connector lifetime;
    // it is only one of several checks before retiring such an orphan.
    this.systemBootAt = Date.now() - Math.round(os.uptime() * 1_000);
    this.codexPrebootRecoveryEnabled = process.platform === 'win32';
    this.desktopQueueItems = new Map();
  }

  recoverInterruptedFollowups() {
    // Read-only probes can be retried. Interrupted protocol/UI writes have
    // unknown delivery; history/queue receipts may confirm them later, but
    // missing receipts never authorize a second message write.
    const nextRetryAt = Date.now() + 5_000;
    for (const item of this.followups.items || []) {
      if (item.state !== 'dispatching') continue;
      const uncertainDesktopSend = ['queue', 'background', 'steer'].includes(item.mode) && !['probe', 'settings'].includes(item.deliveryPhase);
      this.followups.update(item.id, {
        state: uncertainDesktopSend ? 'uncertain' : 'pending',
        reason: uncertainDesktopSend ? '电脑端发送回执未确认，正在核对对话；不会自动重发' : '连接器重启后正在核对发送结果',
        nextRetryAt: uncertainDesktopSend ? null : nextRetryAt,
        blocking: true,
      });
    }
  }

  async start() {
    this.lifecycle = 'starting';
    this.processLock.acquire();
    if (this.prebootStatusHints?.size) this.log(`preboot status recovery: ${this.prebootStatusHints.size} unverified hint(s)`);
    try {
      this.sendReceipts = new SendReceipts(this.config?.configFile ? path.join(path.dirname(this.config.configFile), 'send-receipts.dat') : null);
      await this.codex.start();
    } catch (error) {
      // No Codex on this computer: run every other agent and pick Codex up
      // once it is installed (watchCodexInstall).
      if (error?.code === 'CODEX_NOT_INSTALLED') {
        this.codexMissing = true; this.codexLastError = error.message;
        this.log('Codex is not installed; the other agents start without it');
      } else {
        this.processLock.release();
        this.lifecycle = 'offline';
        throw error;
      }
    }
    this.writeStatus(false, 'starting');
    this.cleanUploads();
    this.attachmentStore.clean();
    this.codex.on('notification', (m) => {
      if (/^account\/(updated|rateLimits\/updated)$/.test(m.method || '')) {
        this.codexAccountUsage?.invalidate();
        this.pushCodexUsage(true).catch((e) => this.log(e));
      }
      const threadId = m.params?.threadId || m.params?.thread?.id || null;
      if (threadId && /turn\/started$/i.test(m.method || '')) {
        this.protocolTerminalTurns?.delete(threadId);
        this.threadState.set(threadId, { ...(this.threadState.get(threadId) || {}), activeTurnId: m.params?.turn?.id || m.params?.turnId });
      }
      const liveStatus = notificationStatus(m.method, m.params);
      if (threadId && liveStatus && isTerminalRolloutStatus(liveStatus)) this.rememberProtocolTerminalTurn(threadId, m.params?.turn?.id || m.params?.turnId);
      if (threadId && liveStatus) this.publishThreadStatus(threadId, this.turnStatus(threadId, liveStatus), false, {
        turnId: m.params?.turn?.id || m.params?.turnId || null,
      });
      const compactionStatus = contextCompactionStatus(m.method, m.params);
      if (threadId && compactionStatus) this.noteCodexCompaction(threadId, compactionStatus, m.params);
      if (threadId && liveStatus === 'failed') {
        const error = notificationErrorText(m);
        if (error) this.emit('codex.error', threadId, { threadId, error, terminal: true,
          turnId: m.params?.turn?.id || m.params?.turnId || null, updatedAt: Date.now() });
      }
      if (threadId && /thread\/settings\/updated$/i.test(m.method || '')) {
        const settings = publicThreadSettings(m.params?.threadSettings || m.params?.settings);
        if (settings) this.emit('thread.settings', threadId, { threadId, settings, updatedAt: Date.now(), source: 'codex' });
      }
      if (/^item\/started$/i.test(m.method || '') && m.params?.item?.id) {
        this.codexItems.set(String(m.params.item.id), m.params.item);
        if (this.codexItems.size > 200) this.codexItems.delete(this.codexItems.keys().next().value);
      }
      if (/^serverRequest\/resolved$/i.test(m.method || '')) {
        const rpcId = m.params?.requestId ?? m.params?.id;
        if (rpcId !== undefined) this.emit('approval.resolved', threadId, { rpcId: String(rpcId), threadId });
      }
      // The phone only reads turn-level methods; token/output deltas would
      // flood the relay and its replay log.
      if (/^(turn|thread)\//i.test(m.method || '')) this.emit('codex.event', threadId, m);
      if (threadId && /turn\/(completed|failed|cancelled|aborted)$/i.test(m.method || '')) {
        this.emit('approval.resolved', threadId, { rpcId: null, threadId });
        this.threadState.set(threadId, { ...(this.threadState.get(threadId) || {}), activeTurnId: null });
        this.emit('control.release', threadId, { reason: m.method });
        this.afterMobileTurn(threadId).catch((e) => this.log(e));
        this.pushCodexUsage().catch((e) => this.log(e));
      }
    });
    this.codexItems = new Map();
    this.codex.on('approval', (m) => this.onApproval(m));
    this.codex.on('diagnostic', (error) => { this.codexLastError = String(error?.message || error || 'Codex app-server error'); this.writeStatus(this.ws?.readyState === WebSocket.OPEN); });
    this.codex.on('offline', (m) => {
      this.codexLastError = String(m?.reason || 'Codex app-server disconnected');
      this.emit('connector.offline', null, { ...m, reason: this.codexLastError, relayOnline: this.ws?.readyState === WebSocket.OPEN });
      if (typeof this.codex?.restart === 'function') this.recoverCodex(m).catch((error) => this.log(error));
    });
    // A failed first connection used to reject start(): main() then gave up while
    // the Codex host and timers kept the process alive, so it never connected
    // and the scheduler never replaced it. Treat it like any later disconnect.
    if (!process.env.NODE_TEST_CONTEXT) {
      const { DirectHistory } = require('./direct-history');
      const namespace = crypto.createHash('sha256').update(this.config.accountKey).digest('hex').slice(0, 16);
      this.directHistory = new DirectHistory(path.join(path.dirname(this.config.configFile), 'direct-history', namespace), this.config);
      this.api.localHistory = this.directHistory;
      if (this.directHistory.fresh) { this.threadDigests.clear(); this.threadItemDigests.clear(); this.historyBackfills.clear(); }
      // A damaged conversation file was dropped: forget what was already
      // mirrored so the next sync writes every conversation again.
      this.directHistory.onDamage = () => { this.threadItemDigests.clear(); this.historyBackfills.clear(); this.syncHistory().catch((e) => this.log(e)); };
      const { DirectHub } = require('./direct-hub');
      this.direct = new DirectHub(this); await this.direct.start();
    }
    this.prepareRelayGap();
    if (this.api) this.api.relayStandby = () => this.relayStandby();
    try { await this.connect(); }
    catch (error) { this.noteConnectFailure(error); this.scheduleReconnect(); }
    this.followupRetryTimer = setInterval(() => this.retryFollowups().catch((e) => this.log(e)), 3000);
    this.followupRetryTimer.unref();
    // Deliver the account key to any phone that logged in with the khsci.com
    // account and is waiting for it (see device-key.js). Runs on a slow poll
    // plus once right after each (re)connect.
    this.phoneKeyTimer = setInterval(() => this.provisionPhoneKeys().catch((e) => this.log(e)), 10_000);
    this.phoneKeyTimer.unref();
    this.startStallWatch();
    // CPU / GPU / memory for the phone's load rings (cheap; see pc-load.js).
    if (!this.pcLoad && !process.env.NODE_TEST_CONTEXT) { this.pcLoad = new PcLoad({ log: (e) => this.log(e) }); this.pcLoad.start(); }
    this.watchCodexInstall();
    this.startCodexUsageWatch();
    this.startRealtimeSync();
    this.startSessionWatcher();
    this.startAgentAvailabilityWatch();
    // Claude backend: subscribe to its events and start its idle reaper. No
    // claude process is spawned until a Claude turn actually runs.
    this.wireClaudeBackend();
    this.claude?.start?.().catch?.((e) => this.log(e));
    // Claude desktop app: same binary / model list, sessions + pins, transcripts.
    if (this.claude) {
      this.useDesktopClaudeBinary();
      this.startClaudeModelRefresh();
      this.startClaudeDesktopSync();
    }
    // Pi Coding Agent, through the local PI WEB server.
    this.startPiSync();
    // DeepSeek Harness desktop Host, through the KH Link bridge plugin.
    this.startDshSync();
    // Hermes Agent (Linux/WSL), through `hermes acp` and its session store.
    this.startHermesSync();
    setTimeout(() => this.archiveRolloutPageRows().catch((error) => this.log(error)), 60_000).unref?.();
    // Google Antigravity: read-only mirror of its local conversations.
    this.startAntigravitySync();
    this.startClaudeStatusline();
  }

  // Quota from terminal Claude Code's statusLine, when the user turned that on
  // (src/claude-statusline.js). It goes through the same path as a
  // rate_limit_event, so it only counts for the desktop account when the
  // command-line login belongs to the same organisation.
  startClaudeStatusline() {
    this.claudeStatusline = new ClaudeStatusline({ dataDir: path.dirname(this.config?.configFile || require('./config').file) });
    this._claudeStatuslineTimer = setInterval(() => this.pollClaudeStatusline().catch((e) => this.log(e)), 5_000);
    this._claudeStatuslineTimer.unref?.();
  }

  async pollClaudeStatusline() {
    const snapshot = this.claudeStatusline?.snapshot();
    if (!snapshot || snapshot.at <= (this._claudeStatuslineSeenAt || 0)) return;
    this._claudeStatuslineSeenAt = snapshot.at;
    await this.refreshClaudeCliOrg?.();
    this.onClaudeRateLimit?.(rateLimitInfo(snapshot), snapshot.at);
  }

  async provisionPhoneKeys() {
    if (this.stopping || this.ws?.readyState !== WebSocket.OPEN) return;
    if (!this.config.accountKey) return;
    let pending;
    try { pending = await this.api.request(this.api.path('/connector/devices/pending-keys')); }
    catch (error) { if (!isAuthFailure(error)) this.log(error); return; }
    const devices = Array.isArray(pending?.devices) ? pending.devices : [];
    for (const device of devices) {
      if (!device?.deviceId || !device?.publicKey) continue;
      try {
        const envelope = wrapAccountKey(this.config.accountKey, device.publicKey, this.api.config.accountId || this.config.accountId, device.deviceId);
        await this.api.request(this.api.path('/connector/devices/key'), { method: 'POST', body: { deviceId: device.deviceId, keyEnvelope: JSON.stringify(envelope) } });
        console.log(`[fengzhu-connect] delivered account key to ${device.type === 'desktop' ? 'computer' : 'phone'} ${device.name || device.deviceId}`);
      } catch (error) { this.log(new Error(`phone key delivery failed for ${device.deviceId}: ${error.message || error}`)); }
    }
  }

  createWebSocket(url, options) { return new WebSocket(url, options); }

  isConnected() { return this.ws?.readyState === WebSocket.OPEN || this.direct?.connected === true; }

  // ---- relay gap ---------------------------------------------------------
  // While the relay is off (direct mode without an account), history goes only
  // to the local direct copy. Remember since when, and once the relay is back
  // upload what changed from that copy, so an account login shows no hole.
  relayGapFile() { return path.join(path.dirname(this.config.configFile), 'relay-gap.json'); }
  readRelayGap() { try { return JSON.parse(fs.readFileSync(this.relayGapFile(), 'utf8')); } catch { return null; } }
  writeRelayGap(value) { try { fs.writeFileSync(this.relayGapFile(), JSON.stringify(value)); } catch (error) { this.log(error); } }
  noteRelayOff() { if (!(this.readRelayGap()?.since > 0)) this.writeRelayGap({ since: Date.now() }); }
  prepareRelayGap() {
    if (!this.config?.configFile || !this.config.directOnly) return;
    // A computer already in direct mode before the relay was kept as the
    // fallback: its relay copy may lag by days. Catch up the last week once.
    if (relayEnabled(this.config) && !this.readRelayGap()) this.writeRelayGap({ since: Date.now() - RELAY_GAP_BOOTSTRAP_MS });
    this.noteRelayOff();
  }
  /**
   * Direct mode with an account keeps the relay on standby: connected, with
   * presence only (not counted as traffic), history kept locally. A phone that
   * switches to the account login sends its first command through the relay;
   * from then on everything is relayed again, after a catch-up.
   */
  relayStandby() { return Boolean(this.config?.directOnly && relayEnabled(this.config) && !this.relayPhoneSeen); }
  noteRelayFrame(raw) {
    if (!this.relayStandby()) return;
    let kind; try { kind = JSON.parse(raw).kind; } catch { return; }
    if (kind !== 'command' && kind !== 'approval.resolve') return;
    this.relayPhoneSeen = true;
    console.log('[fengzhu-connect] a phone signed in through the relay: leaving standby');
    this.replayRelayGap();
    this.flushPendingStatusFrames();
    this.republishActiveThreadStatuses();
  }
  async replayRelayGap() {
    const gap = this.readRelayGap();
    if (!(gap?.since > 0) || !this.directHistory || this.relayGapReplay || this.relayStandby()) return this.relayGapReplay;
    this.relayGapReplay = (async () => {
      const startedAt = Date.now();
      const changes = await this.directHistory.changedSince(gap.since - 60_000);
      let threads = 0; let items = 0;
      for (const { thread, items: rows } of changes) {
        if (this.stopping || this.ws?.readyState !== WebSocket.OPEN) throw new Error('relay closed during the catch-up');
        await this.api.request(this.api.path('/history/threads'), { method: 'PUT', body: thread, skipLocal: true }); threads++;
        for (const batch of chunkByEncodedSize(rows)) {
          await this.api.request(this.api.path(`/history/threads/${encodeURIComponent(thread.id)}/items`), { method: 'PUT', body: { items: batch }, skipLocal: true });
          items += batch.length;
        }
      }
      // Only a gap that did not grow meanwhile is closed.
      if (this.readRelayGap()?.since === gap.since && relayEnabled(this.config) && !this.relayStandby()) this.writeRelayGap({ since: null, caughtUpAt: Date.now() });
      console.log(`[fengzhu-connect] relay caught up after direct mode: ${threads} conversations, ${items} items in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      // Phones on the relay re-read the list, which may show states from before the gap.
      if (threads) this.emit('threads.updated', null, { updatedAt: Date.now() });
    })().catch((error) => this.log(`relay catch-up stopped, retried on the next connection: ${error.message}`))
      .finally(() => { this.relayGapReplay = null; });
    return this.relayGapReplay;
  }

  async setDirectMode(enabled) {
    const { saveConfig } = require('./config');
    if (!enabled) this.reloadCredentialsFromDisk();
    if (!enabled && !this.config.refreshToken) throw new Error('请先在电脑端登录账户，再使用服务器模式');
    this.config.directOnly = enabled; this.api.config.directOnly = enabled;
    // Signed in, the relay stays as the fallback (see relayEnabled).
    const relay = relayEnabled(this.config);
    if (!relay) this.api.serverAbort.abort(); else if (this.api.serverAbort.signal.aborted) this.api.serverAbort = new AbortController();
    // Preserve the newest refresh token when the cloud refreshed concurrently.
    const current = loadConfig(); saveConfig({ ...current, directOnly: enabled });
    if (enabled) { this.relayPhoneSeen = false; this.noteRelayOff(); }
    if (!relay) {
      clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
      clearInterval(this.heartbeat); this.heartbeat = null;
      clearInterval(this.statusHeartbeat); this.statusHeartbeat = null;
      const socket = this.ws; this.ws = null; socket?.close(1000, 'direct mode');
    } else if (!this.ws) {
      // Entering direct mode with the relay kept as the fallback must not fail
      // the pairing when the relay is unreachable: it is retried in the background.
      if (enabled) await this.connect().catch((error) => { this.noteConnectFailure?.(error); this.scheduleReconnect(); });
      else await this.connect();
    }
    this.lifecycle = 'running'; this.writeStatus(this.isConnected());
  }

  // Poll cached account snapshots cheaply; the shared reader refreshes at most
  // every 30 seconds. The task-owning host must not supply an old login's quota.
  startCodexUsageWatch(periodMs = 5_000) {
    if (this.codexUsageTimer) return;
    this.codexUsageTimer = setInterval(() => {
      this.pushCodexUsage().catch((e) => this.log(e));
      if (!this._lastFollowDesktopAt || Date.now() - this._lastFollowDesktopAt >= 3 * 60_000) {
        this._lastFollowDesktopAt = Date.now();
        this.followDesktopCodex().catch((e) => this.log(e));
      }
    }, periodMs);
    this.codexUsageTimer.unref?.();
  }

  async pushCodexUsage(force = false) {
    if (this.stopping || !this.isConnected() || !this.codex?.request || this.codex.ready === false) return false;
    const result = await this.readCodexUsage();
    if (!result || this.stopping || !this.isConnected()) return false;
    const signature = JSON.stringify(result);
    if (!force && signature === this.codexUsageSignature) return false;
    if (this.emit('codex.usage', null, result) === false) return false;
    this.codexUsageSignature = signature;
    return true;
  }

  readCodexUsage() {
    if (!this.codexAccountUsage) {
      const { AccountUsagePoller, readAccount } = require('./codex-account-usage');
      const { findCodexBinary } = require('./codex-client');
      const home = path.dirname(this.desktopStateFile || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json'));
      this.codexAccountUsage = new AccountUsagePoller({ read: () => readAccount(findCodexBinary(this.config.codexBin), { home }) });
    }
    return this.codexAccountUsage.get();
  }

  // Timers once fired 26 and 40 minutes late while the process used almost no
  // CPU, so the relay went unanswered that long. Record such stalls (and the
  // relay state around them) to find what holds the process up.
  startStallWatch(periodMs = 5_000, reportMs = 15_000) {
    if (this.stallTimer) return;
    let expected = Date.now() + periodMs;
    this.stallTimer = setInterval(() => {
      const late = Date.now() - expected;
      expected = Date.now() + periodMs;
      // What blocked the thread in this interval (sync-probe.js), cleared every tick.
      const blocking = takeSyncTally();
      const blockedMs = blocking.reduce((sum, row) => sum + Number((/ ([\d.]+)s \(/.exec(row) || [])[1] || 0) * 1000, 0);
      if (late <= reportMs && blockedMs >= 3_000) console.log(`[fengzhu-connect] slow sync work ${Math.round(blockedMs / 1000)}s in ${Math.round((periodMs + late) / 1000)}s: ${blocking.join('; ')}`);
      if (late > reportMs) this.log(new Error(`event loop stalled for ${Math.round(late / 1000)}s (relay ${this.ws?.readyState === WebSocket.OPEN ? 'open' : 'not open'}, in-flight commands ${this.inFlightCommands?.size || 0}); blocking work: ${blocking.join('; ') || 'none measured'}`));
    }, periodMs);
    this.stallTimer.unref?.();
  }

  async connect() {
    if (this.stopping || !relayEnabled(this.config)) return;
    let token;
    try { token = await this.api.token(); }
    catch (error) {
      // The desktop console writes a fresh refresh token into config.json after
      // the user signs in again. Pick it up here instead of relying on a task
      // restart, which the scheduler ignores while this process is running.
      if (!isAuthFailure(error) || !this.reloadCredentialsFromDisk()) throw error;
      token = await this.api.token();
    }
    this.authFailed = false;
    const url = this.config.serverUrl.replace(/^http/, 'ws') + this.api.webSocketPath();
    // Without a handshake timeout a connect that stalls mid-way never closes,
    // so no reconnect is ever scheduled.
    const ws = this.createWebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 20_000 });
    this.ws = ws;
    this.lastSocketActivity = Date.now();
    const connectStartedAt = Date.now();
    // Every handler checks that its socket is still the current one. After a
    // reconnect the old socket can still emit close/message late; without the
    // guard a late close scheduled a second reconnect and left two sockets open.
    ws.on('pong', () => { if (ws === this.ws) this.lastSocketActivity = Date.now(); });
    ws.on('open', () => {
      if (ws !== this.ws) return;
      this.lifecycle = 'running';
      this.reconnectMs = 1000;
      this.lastSocketActivity = Date.now();
      console.log(`[fengzhu-connect] relay connected in ${Date.now() - connectStartedAt}ms`);
      this.flushPendingStatusFrames();
      this.republishActiveThreadStatuses();
      this.provisionPhoneKeys().catch((e) => this.log(e));
      this.replayRelayGap();
      this.pushCodexUsage(true).catch((e) => this.log(e));
      try { this.publishClaudeUsage(true); } catch (error) { this.log(error); }
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.checkSocketLiveness(ws), SOCKET_PING_INTERVAL_MS);
      this.heartbeat.unref();
      clearInterval(this.statusHeartbeat);
      this.statusHeartbeat = setInterval(() => {
        const connected = this.ws?.readyState === WebSocket.OPEN;
        this.writeStatus(connected);
        if (connected) {
          this.publishPresence();
          this.republishActiveThreadStatuses();
        }
      }, 1000);
      this.statusHeartbeat.unref();
    });
    ws.on('message', (raw) => {
      if (ws !== this.ws) return;
      this.lastSocketActivity = Date.now();
      this.noteRelayFrame(raw.toString());
      this.onFrame(raw.toString());
    });
    ws.on('close', (code, reason) => {
      if (ws !== this.ws) return;
      console.log(`[fengzhu-connect] relay disconnected code=${code}${reason?.length ? ` reason=${reason}` : ''}${this.stopping ? ' (stopping)' : ''}`);
      clearInterval(this.heartbeat); this.heartbeat = null;
      clearInterval(this.statusHeartbeat); this.statusHeartbeat = null;
      this.writeStatus(false, this.stopping ? 'draining' : 'offline'); this.scheduleReconnect();
    });
    ws.on('error', (e) => this.log(e));
  }

  // Called on every heartbeat tick. The relay answers each ping with a pong, so
  // a socket that has been silent for SOCKET_STALE_MS is half-open (typical
  // after sleep, a network change or a VPN node switch): it still reports OPEN
  // but nothing gets through. Terminate it so the close handler reconnects.
  checkSocketLiveness(ws, now = Date.now()) {
    if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) return 'ignored';
    const silentMs = now - (this.lastSocketActivity || 0);
    if (silentMs > SOCKET_STALE_MS) {
      this.log(new Error(`relay socket silent for ${Math.round(silentMs / 1000)}s, reconnecting`));
      ws.terminate();
      return 'terminated';
    }
    ws.ping();
    return 'pinged';
  }

  // While Codex is missing, look for it once a minute and start it as soon as
  // it appears, without restarting the connector.
  watchCodexInstall(periodMs = 60_000) {
    if (!this.codexMissing || this.codexInstallTimer) return;
    const { resolveCodexBinary } = require('./codex-client');
    this.codexInstallTimer = setInterval(() => {
      if (this.stopping || !resolveCodexBinary(this.config?.codexBin)) return;
      clearInterval(this.codexInstallTimer); this.codexInstallTimer = null;
      this.codexMissing = false;
      this.log('Codex was installed; starting it');
      this.recoverCodex({ reason: 'codex_installed' }).catch((error) => this.log(error));
    }, periodMs);
    this.codexInstallTimer.unref?.();
  }

  async recoverCodex(reason = {}) {
    if (this.stopping) return false;
    if (this.codexRecoveryPromise) return this.codexRecoveryPromise;
    this.codexRecoveryPromise = (async () => {
      this.lifecycle = 'recovering_codex';
      this.codexRecoveryAttempts += 1;
      this.writeStatus(this.ws?.readyState === WebSocket.OPEN, this.lifecycle, {
        codexReady: false,
        codexRecovery: 'restarting',
        codexReason: String(reason?.reason || this.codexLastError || 'app-server disconnected'),
      });
      try {
        await this.codex.restart();
        this.codexLastError = null;
        this.codexRecoveryAttempts = 0;
        this.lifecycle = 'running';
        this.writeStatus(this.ws?.readyState === WebSocket.OPEN, this.lifecycle, { codexRecovery: 'recovered' });
        if (this.ws?.readyState === WebSocket.OPEN && this.config?.deviceName) {
          this.publishPresence({ full: true });
          this.republishActiveThreadStatuses();
        }
        return true;
      } catch (error) {
        this.codexLastError = error?.message || String(error);
        this.lifecycle = 'running';
        this.writeStatus(this.ws?.readyState === WebSocket.OPEN, this.lifecycle, {
          codexReady: false,
          codexRecovery: 'failed',
          codexReason: this.codexLastError,
        });
        throw error;
      } finally { this.codexRecoveryPromise = null; }
    })();
    return this.codexRecoveryPromise;
  }

  scheduleReconnect() {
    if (this.stopping || !relayEnabled(this.config)) return;
    // While the login is expired, retrying fast cannot help; check once a minute
    // so a new sign-in from the desktop console is still picked up quickly.
    const delay = this.authFailed ? AUTH_RETRY_MS : this.reconnectMs;
    this.reconnectTimer = setTimeout(() => this.connect().catch((e) => { this.noteConnectFailure(e); this.scheduleReconnect(); }), delay);
    this.reconnectTimer.unref?.();
    this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
  }

  noteConnectFailure(error) {
    const auth = isAuthFailure(error);
    if (auth && this.authFailed) return; // already reported; stay quiet while waiting for a new sign-in
    this.authFailed = auth;
    this.log(auth ? new Error(`relay login expired, waiting for a new sign-in in the khLink desktop console: ${error?.message || error}`) : error);
    this.writeStatus(false, auth ? 'login_required' : 'offline', { relayReason: String(error?.message || error).slice(0, 300) });
  }

  // Re-read config.json; returns true when it holds a different refresh token.
  reloadCredentialsFromDisk(load = loadConfig) {
    let fresh;
    try { fresh = load(); } catch (error) { this.log(error); return false; }
    if (!fresh?.refreshToken || fresh.refreshToken === this.api?.config?.refreshToken) return false;
    const picked = {};
    for (const key of ['refreshToken', 'accountId', 'deviceId', 'accountKey', 'protocolVersion', 'serverUrl']) if (fresh[key] !== undefined) picked[key] = fresh[key];
    this.config = { ...this.config, ...picked };
    this.api.config = { ...this.api.config, ...picked };
    this.api.accessToken = null; this.api.expiresAt = 0;
    console.log('[fengzhu-connect] loaded new relay credentials from config.json');
    return true;
  }

  send(kind, threadId, value, targetDeviceId = null) {
    const directSent = this.direct?.send(kind, threadId, value, targetDeviceId) || false;
    if (this.ws?.readyState !== WebSocket.OPEN || (this.relayStandby() && kind !== 'connector.presence' && kind !== 'connector.offline')) {
      // The phone ends "waiting"/"running" only on an explicit status frame (a
      // heartbeat that leaves a session out is not one). A change made while the
      // relay is down, e.g. the first desktop scan right after a restart, would
      // otherwise leave the phone showing the old state: keep the latest per
      // session and send it once connected.
      if (kind === 'thread.status' && threadId && !targetDeviceId) {
        this.pendingStatusFrames ||= new Map();
        this.pendingStatusFrames.delete(threadId);
        this.pendingStatusFrames.set(threadId, value);
        if (this.pendingStatusFrames.size > 500) this.pendingStatusFrames.delete(this.pendingStatusFrames.keys().next().value);
      }
      return directSent;
    }
    const id = crypto.randomUUID(); const encrypted = encryptJson(this.config.accountKey, kind, threadId, id, value);
    this.ws.send(JSON.stringify({ id, kind, threadId: threadId || null, targetDeviceId, createdAt: Date.now(), ...encrypted,
      ...blobFields(this.config.accountKey, id, value) })); return true;
  }

  // Status changes made while the relay was down; the active ones are sent
  // again right after with their current value.
  flushPendingStatusFrames() {
    const pending = this.pendingStatusFrames; this.pendingStatusFrames = null;
    for (const [threadId, value] of pending || []) this.send('thread.status', threadId, value);
  }

  emit(kind, threadId, value, targetDeviceId = null) {
    if (kind.startsWith('followup.') && Array.isArray(value?.attachments)) {
      value = { ...value, attachments: publicAttachments(value.attachments) };
    }
    try { this.sendReceipts?.event(kind, threadId, value); } catch (error) { this.log(error); }
    this.send(kind, threadId, value, targetDeviceId);
    // A direct/queued Codex receipt can reach the phone before the slower
    // history uploader has matched the recorded user message. Track that
    // receipt independently so its actual rollout end is not missed.
    if (kind === 'followup.started' && /^[0-9a-f-]{36}$/i.test(String(threadId || '')) &&
        this.followups?.get?.(value?.id)?.state === 'started') {
      this.startedRolloutChecks ||= new Map();
      this.startedRolloutChecks.set(threadId, Date.now() + 30_000);
    }
  }

  publishRolloutThreadSettings(threadId, settings, updatedAt) {
    if (!threadId || !settings) return false;
    this.rolloutSettingsSnapshots ||= new Map();
    const eventAt = Number.isFinite(Number(updatedAt)) && Number(updatedAt) > 0 ? Number(updatedAt) : Date.now();
    const signature = JSON.stringify(settings);
    const previous = this.rolloutSettingsSnapshots.get(threadId);
    // A full replay walks old records after the live tail has already been
    // published. Do not let those records roll the phone back to an earlier
    // model/mode. Equal settings are also intentionally silent: the timestamp
    // is advanced for ordering, but mobile only needs the latest value.
    if (previous && eventAt < previous.updatedAt) return false;
    if (previous && signature === previous.signature) {
      if (eventAt > previous.updatedAt) {
        previous.updatedAt = eventAt;
        this.rolloutSettingsSnapshots.set(threadId, previous);
      }
      return false;
    }
    this.rolloutSettingsSnapshots.set(threadId, { updatedAt: eventAt, signature });
    this.emit('thread.settings', threadId, {
      threadId,
      settings,
      updatedAt: eventAt,
      source: 'rollout',
    });
    return true;
  }

  async onFrame(raw, options = {}) {
    let frame; try { frame = JSON.parse(raw); } catch { return; }
    if (frame.type === 'ready') {
      const latestSequence = Number(frame.latestSequence) || 0;
      if (!options.direct) {
        if (this.lastSequence === null || this.lastSequence > latestSequence) this.saveSequence(latestSequence);
        else await this.replayEvents();
      }
      const sentAt = Date.now();
      this.emit('connector.online', null, { deviceName: this.config.deviceName, sentAt });
      this.publishPresence({ full: true, sentAt });
      this.republishActiveThreadStatuses();
      this.emit('followup.snapshot', null, { items: this.phoneQueueItems() });
      this.writeStatus(true);
      return;
    }
    if (frame.type) return;
    // One account may have several computers sharing the account key. A frame
    // addressed to another computer is that computer's to run, never ours.
    if (frame.targetDeviceId && this.config?.deviceId && frame.targetDeviceId !== this.config.deviceId) {
      if (!options.direct) this.saveSequence(frame.sequence);
      return;
    }
    let payload;
    try { payload = decryptJson(options.key || this.config.accountKey, frame); }
    catch (e) { this.log(e); if (!options.direct) this.saveSequence(frame.sequence); return; }
    if (frame.kind === 'command' || frame.kind === 'command.control' || frame.kind === 'file.command') {
      const resultKind = frame.kind === 'file.command' ? 'file.result' : 'command.result';
      const requestId = payload.requestId || payload.args?.requestId || frame.id || crypto.randomUUID();
      if (this.stopping) {
        this.emit(resultKind, frame.threadId, { requestId, ok: false, error: '连接器正在安全排空，新的操作会在重连后重试' }, frame.sourceDeviceId);
        this.saveSequence(frame.sequence);
        return;
      }
      this.inFlightCommands.add(String(requestId));
      try {
        assertCommandThread(frame.threadId, payload.args?.threadId);
        const result = await this.command(payload, frame.sourceDeviceId);
        this.emit(resultKind, frame.threadId, { requestId, ok: true, result }, frame.sourceDeviceId);
      }
      catch (e) {
        // The phone shows the message; keep a line here so a failure can be traced
        // afterwards, with the task and the agent it belongs to.
        const failedThread = frame.threadId || payload.args?.threadId || null;
        const failedBackend = failedThread ? this.threadBackendId(failedThread) : null;
        this.log(`command ${payload.action} failed${failedThread ? ` for ${failedThread} (${failedBackend})` : ''}: ${e.message}`);
        this.emit(resultKind, frame.threadId, { requestId, ok: false, error: phoneErrorText(e.message, e.code) }, frame.sourceDeviceId);
        if (frame.kind === 'command.control' && frame.threadId) this.emit('control.release', frame.threadId, { reason: 'command_failed' });
      } finally { this.inFlightCommands.delete(String(requestId)); }
    } else if (frame.kind === 'approval.resolve') this.resolveApproval(payload);
    if (!options.direct) this.saveSequence(frame.sequence);
  }

  async replayEvents() {
    let page;
    do {
      page = await this.api.request(`${this.api.path('/events')}?after=${this.lastSequence || 0}&limit=500`);
      for (const frame of page.items || []) await this.onFrame(JSON.stringify(frame));
    } while ((page.items || []).length === 500);
  }

  async command(payload, sourceDeviceId = null) {
    const threadId = payload.args?.threadId;
    // Existing phones use the Claude desktop-answer command for all waiting
    // cards. Route a Codex card to its original Desktop question, not Claude.
    if (payload.action === 'claude.desktop.answer' && threadId && this.threadBackendId(threadId) === 'codex') {
      return this.answerCodexOnDesktop(threadId, payload.args);
    }
    // Local history details belong to the connector for every backend. These
    // reads are independent of an agent's running turn and writer lock.
    if (payload.action === 'history.details' || payload.action === 'file.historyDetailPart') return this.executeCommand(payload);
    if (payload.action === 'thread.usage.read') return this.readConversationUsage(threadId, sourceDeviceId, payload.args?.historyFrom);
    const hasAttachments = Array.isArray(payload.args?.attachments) && payload.args.attachments.length > 0;
    const queueDispatch = Boolean(payload.args?._queueDispatch);
    // Attachments use the same single-writer decision as text.  They are
    // deliberately never routed through DesktopAdapter, whose UI Automation
    // path focuses the Codex window while attaching a file.  Resolve and
    // validate the opaque attachment ids once, then use the background
    // app-server when this task is idle or queue durably when it is owned.
    if (hasAttachments && threadId) {
      payload = { ...payload, args: { ...(payload.args || {}), attachments: this.resolveAttachments(threadId, payload.args.attachments) } };
    }
    // Pi sessions live in PI WEB; everything about them goes there.
    // File browsing and uploads are the connector's own, whatever agent the
    // thread runs on (a Pi image upload used to be refused as a Pi command).
    const connectorOwn = /^file\./.test(payload.action || '');
    if (this.pi && !connectorOwn && ((threadId && this.piThreads?.has(threadId)) || /^pi\./.test(payload.action || '') ||
      (payload.args?.backend === 'pi' && /^thread\.new/.test(payload.action || '')))) return this.deliverOnce(payload, () => this.piCommand(payload), 'pi');
    // DeepSeek Harness phone and desktop share the same live Host sessions; the
    // bridge plugin publishes that Host API, so no second DSH process is started.
    if (!connectorOwn && this.dsh && this.dshThreads && ((threadId && this.dshThreads.has(threadId)) || /^dsh\./.test(payload.action || '') ||
      (payload.args?.backend === 'dsh' && /^thread\.new/.test(payload.action || '')))) return this.deliverOnce(payload, () => this.dshCommand(payload), 'dsh');
    // Hermes Agent: reads come from its session store, writes go through `hermes acp`.
    if (!connectorOwn && this.hermesTransport && this.hermesThreads && ((threadId && this.hermesThreads.has(threadId)) || /^hermes\./.test(payload.action || '') ||
      (payload.args?.backend === 'hermes' && /^thread\.new/.test(payload.action || '')))) return this.deliverOnce(payload, () => this.hermesCommand(payload), 'hermes');
    // Antigravity records its send receipts durably, including uncertain
    // window actions, so replays also remain safe across connector restarts.
    if (threadId && !connectorOwn && this.antigravityThreads?.has(threadId)) return this.antigravityCommand(payload);
    if (threadId && CLAUDE_QUEUE_ACTIONS.has(payload.action) && this.threadBackendId(threadId) === 'claude') {
      this.wireClaudeBackend();
      return this.claudeQueueCommand(payload);
    }
    const requestId = payload.requestId || payload.args?.requestId;
    const existingTransaction = requestId && this.followups?.get?.(requestId);
    if (!queueDispatch && existingTransaction && ['turn.start', 'turn.steer'].includes(payload.action)) {
      // A replayed mobile frame is an idempotent query, never a second Codex
      // turn.  A dispatching background item may still be in the original RPC
      // and is therefore reported as uncertain until rollout reconciliation.
      if (existingTransaction.state === 'dispatching') {
        return { accepted: true, uncertain: true, duplicate: true, requestId, item: publicItem(existingTransaction) };
      }
      if (['started', 'steered', 'desktop_queued', 'pending', 'uncertain', 'failed'].includes(existingTransaction.state)) {
        return { accepted: existingTransaction.state !== 'failed', queued: true, duplicate: true, requestId, item: publicItem(existingTransaction) };
      }
    }
    // _queueDispatch is connector-internal and must never be forwarded to the
    // app-server command payload.  It only bypasses the outer idempotency
    // guard for the original durable queue item.
    if (queueDispatch) {
      const { _queueDispatch, ...commandArgs } = payload.args;
      payload = { ...payload, args: commandArgs };
    }
    const desktopStatus = threadId ? this.desktopStatuses?.get(threadId) : null;
    // `desktopStatuses` intentionally has a short idle grace period. It is
    // useful for rendering, but it is unsafe as the routing decision for
    // “立即发送”: a stale running badge would send the message through the
    // Desktop UI queue even after the turn had already ended. Once a healthy
    // thread/list snapshot exists, use that fresh set for routing.
    const desktopTurnActive = threadId ? this.desktopTurnIsActive(threadId, desktopStatus) : false;
    if (payload.action === 'followup.list') return { items: this.phoneQueueItems(threadId || null) };
    if (payload.action === 'followup.cancel') return this.cancelFollowup(payload.args?.id, sourceDeviceId, threadId);
    if (payload.action === 'followup.steer') return this.steerFollowup(payload.args?.id, sourceDeviceId, threadId);
    if (payload.action === 'followup.steer_all') return this.steerAllFollowups(threadId, payload.args?.ids, sourceDeviceId);
    if (payload.action === 'followup.enqueue') return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
    if (payload.action === 'turn.steer' && threadId && !this.isBridgeOwnedThread(threadId) &&
        !(await this.confirmCodexHostThread(threadId))) {
      if (hasAttachments) return this.enqueueFollowup({ ...payload, action: 'turn.start' }, sourceDeviceId, 'queue');
      if (this.desktopAdapter?.probe) {
        // thread/list on our app-server reports Desktop's tasks as notLoaded,
        // even while its separate writer is running them. A false idle list
        // must not turn an immediate steer into a background turn/start.
        // Queue once, then use the exact existing row's native Steer button.
        const queued = await this.routeTurnThroughDesktop(payload, sourceDeviceId);
        if (queued) return queued;
      } else if (desktopTurnActive) return this.steerDesktop(payload, sourceDeviceId);
    }
    if (payload.action === 'turn.start' && isDesktopTaskBusy(desktopStatus) &&
        this.threadState?.get(threadId)?.pendingDesktopSettings) {
      return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
    }
    // An embedded/older adapter without targeted probing can only honor the
    // connector's live status snapshot. Keep its Desktop-owned text queue
    // behavior rather than guessing that the background writer is safe.
    if (payload.action === 'turn.start' && !hasAttachments && desktopTurnActive &&
        !this.desktopAdapter?.probe) return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
    // A Desktop list/status snapshot can be one poll behind the GUI. Before
    // writing an existing titled task through the background app-server, ask
    // the native adapter whether the Desktop composer is present. If it is,
    // use the Desktop's own queue as the single writer. This closes the race
    // where Desktop starts a turn between the 2-second status polls and the
    // connector's turn/start RPC, which otherwise makes Codex show the
    // "already open in another application" takeover dialog.
    // The thread id is the authoritative identity.  Mobile image turns can
    // arrive without a usable title while the task list is still refreshing;
    // gating this probe on title let those turns race the Desktop writer and
    // surface Codex's "already open in another application" lock dialog.
    if (payload.action === 'turn.start' && threadId && !hasAttachments && this.desktopAdapter?.probe) {
      const desktopRoute = await this.routeTurnThroughDesktop(payload, sourceDeviceId);
      if (desktopRoute) return desktopRoute;
    }
    // Attachments follow the same targeted single-writer probe.  A stale
    // status snapshot used to let an image race a visible Desktop task and
    // reach app-server directly, where the agent loop could die while the
    // Desktop writer still owned the thread.  Keep the image durable on the
    // original task before attempting any background turn.
    if (payload.action === 'turn.start' && threadId && hasAttachments && this.desktopAdapter?.probe) {
      const desktopRoute = await this.routeTurnThroughDesktop(payload, sourceDeviceId);
      if (desktopRoute) return desktopRoute;
    }
    // A stale global Desktop status must not force a message into UI
    // Automation after the targeted probe says this thread is not the active
    // writer. Attachments stay durable and are consumed by the background
    // branch below; plain text can continue directly through app-server.
    if (payload.action === 'turn.start' && hasAttachments && desktopTurnActive) {
      return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
    }
    // When the Desktop window is absent, an idle existing task can be started
    // through the background protocol. If the status snapshot is stale and
    // Desktop is actually writing the task, the guarded route above prevents
    // a competing writer; the explicit active-writer fallback below remains
    // as a final race-safe backstop.
    try {
      if (payload.action === 'turn.start' && threadId) {
        const pendingSettings = this.threadState?.get(threadId)?.pendingDesktopSettings;
        if (pendingSettings) {
          await this.applyPendingDesktopSettings({
            threadId,
            title: payload.args?.title || pendingSettings.title || null,
            sourceDeviceId,
          });
        }
      }
      return await this.executeMobileTurn(payload, sourceDeviceId);
    }
    catch (error) {
      // The write may already be in the rollout. Never turn a lost receipt or
      // a dead agent loop into another turn/start/queue/add automatically.
      if (error.delivery === 'uncertain' && ['turn.start', 'turn.steer'].includes(payload.action)) {
        const item = this.followups?.get?.(requestId);
        return { accepted: false, uncertain: true, requestId, ...(item ? { item: publicItem(item) } : {}) };
      }
      // "立即发送" into a turn that ended meanwhile (it can end while the
      // request waits behind the thread's turn lock): the message is still
      // meant to go, so it starts the next turn instead of failing.
      if (payload.action === 'turn.steer' && /No active turn is available|no active turn|not running/i.test(String(error?.message || ''))) {
        this.log(`steer for ${threadId} found no running turn; sending it as a new turn`);
        return this.command({ ...payload, action: 'turn.start' }, sourceDeviceId);
      }
      if (payload.action === 'turn.start' && isDesktopWriterBusyError(error)) {
        this.markDesktopThread(threadId, error.message || 'Codex Desktop 持有当前任务写入权');
        this.removeDirectFollowup(payload.requestId || payload.args?.requestId);
        return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
      }
      if (isCodexAgentLoopError(error) && ['turn.start', 'turn.steer'].includes(payload.action)) {
        // A durable queue dispatch is already represented by `existingTransaction`.
        // Let dispatchFollowup retain it as pending and retry after recovery;
        // re-enqueuing here would be treated as a duplicate and the caller
        // could incorrectly advance the item to `desktop_queued`.
        if (queueDispatch) throw error;
        // The request may have reached app-server before its worker died. Do
        // not surface the internal error or issue a blind second turn. Remove
        // the transient direct row, restart our isolated Codex host, and put
        // the exact requestId into the durable queue. Rollout reconciliation
        // will turn it into `started` if the first attempt was accepted.
        this.removeDirectFollowup(payload.requestId || payload.args?.requestId);
        try { if (typeof this.recoverCodex === 'function') await this.recoverCodex({ reason: 'agent_loop_died' }); }
        catch (recoveryError) { this.log(new Error(`Codex host recovery deferred: ${recoveryError.message || recoveryError}`)); }
        const queuedPayload = payload.action === 'turn.steer' ? { ...payload, action: 'turn.start' } : payload;
        return this.enqueueFollowup(queuedPayload, sourceDeviceId, 'background');
      }
      if (!payload.args?.threadId || !/thread not found/i.test(String(error?.message || error))) throw error;
      this.log(new Error(`Loading Codex task ${payload.args.threadId}`));
      try {
        if (hasAttachments) await this.resumeThreadForBackground(payload.args);
        else await this.codex.request('thread/resume', { threadId: payload.args.threadId, excludeTurns: true }, 15_000);
      } catch (resumeError) {
        if (isDesktopWriterBusyError(resumeError)) {
          this.markDesktopThread(threadId, resumeError.message || 'Codex Desktop 持有当前任务写入权');
          if (payload.action === 'turn.steer') return this.steerDesktop(payload, sourceDeviceId);
          if (payload.action === 'turn.start') {
            this.removeDirectFollowup(payload.requestId || payload.args?.requestId);
            return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
          }
          if (payload.action === 'settings.set') return this.queuePendingSettings(payload.args || {}, '电脑端当前轮正在运行，设置将在当前轮完成后通过后台协议应用');
          throw new Error('电脑端正在控制这个任务，当前操作不能在另一个 Codex 进程中执行');
        }
        if (payload.action === 'settings.set' && isThreadNotFoundError(resumeError)) {
          return this.queuePendingSettings(payload.args || {}, '电脑端当前任务尚未被后台连接器加载，设置将在可用后通过后台协议应用');
        }
        if (payload.action === 'turn.start' && hasAttachments && isThreadLoadRetryableError(resumeError)) {
          this.removeDirectFollowup(payload.requestId || payload.args?.requestId);
          return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
        }
        throw resumeError;
      }
      return this.executeMobileTurn(payload, sourceDeviceId);
    }
  }

  registerDirectFollowup(payload, sourceDeviceId) {
    if (!['turn.start', 'turn.steer'].includes(payload.action)) return null;
    if (!this.followups?.get || !this.followups?.add) return null;
    const args = payload.args || {};
    if (!args.threadId) return null;
    const requestId = payload.requestId || args.requestId || crypto.randomUUID();
    const attachments = this.resolveAttachments(args.threadId, args.attachments);
    const displayText = String(args.text || '').trim();
    const text = withAttachmentContext(displayText, attachments);
    const existing = this.followups.get(requestId);
    // A queued item is already the durable history-matching transaction.  Its
    // retry path may call executeCommand directly; do not convert it into a
    // second background transaction or emit a duplicate started event.
    if (existing?.mode === 'queue') return null;
    const item = existing || this.followups.add({
      id: requestId, requestId, threadId: args.threadId, title: args.title || null,
      text, displayText, attachments, cwd: args.cwd || null, model: args.model || null,
      effort: args.effort || null, serviceTier: args.serviceTier || null,
      permissionMode: args.permissionMode || null, mode: 'background', sourceDeviceId,
      state: 'dispatching', deliveryPhase: 'probe', createdAt: Date.now(), attempts: 0,
      rolloutOffset: this.currentRolloutOffset(args.threadId), blocking: false,
    });
    if (existing) {
      this.followups.update(requestId, { text, displayText, attachments, mode: 'background', state: 'dispatching', deliveryPhase: 'probe', reason: null, sourceDeviceId, blocking: false });
    }
    // This is an acceptance event for a durable mobile transaction, not a
    // Desktop UI queue event. It lets the phone recover the row after a
    // connector/app restart while the rollout is still catching up.
    this.emit('followup.queued', item.threadId, publicItem(this.followups.get(requestId) || item), sourceDeviceId);
    return this.followups.get(requestId) || item;
  }

  removeDirectFollowup(requestId) {
    if (!requestId) return;
    const item = this.followups.get(requestId);
    if (item?.mode === 'background' && !['completed', 'cancelled'].includes(item.state)) this.followups.remove(requestId);
  }

  async withThreadTurnLock(threadId, task) {
    if (!threadId) return task();
    this.mobileTurnChains ||= new Map();
    const previous = this.mobileTurnChains.get(threadId) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.mobileTurnChains.set(threadId, run);
    try {
      return await run;
    } finally {
      if (this.mobileTurnChains.get(threadId) === run) this.mobileTurnChains.delete(threadId);
    }
  }

  async executeSerializedCommand(payload) {
    return this.withThreadTurnLock(payload.args?.threadId, () => this.executeCommand(payload));
  }

  isCurrentCodexHostOwner(record) {
    if (!record || record.owner !== 'khlink') {
      // Expired records are marked `unknown` before this callback is used for
      // recovery. They are eligible only when they carry the old lease marker.
      if (!record || record.owner !== 'unknown' || record.source !== 'lease') return false;
    }
    if (this.codex?.mode !== 'host' || !this.codex?.ready) return false;
    const hostPid = Number(this.codex?.host?.state?.pid);
    return Number.isInteger(hostPid) && hostPid > 0 && Number(record.hostPid) === hostPid;
  }

  threadOwner(threadId) {
    return this.threadOwnership?.get(threadId) || null;
  }

  isBridgeOwnedThread(threadId) {
    const record = this.threadOwner(threadId);
    return record?.owner === 'khlink' && (!record.hostPid || this.codex?.mode !== 'host' || this.isCurrentCodexHostOwner(record));
  }

  setThreadOwner(threadId, owner, changes = {}) {
    if (!threadId || !this.threadOwnership) return null;
    let record;
    try {
      if (owner === 'khlink') {
        record = this.threadOwnership.claim(threadId, {
          ...changes,
          bridgeId: this.bridgeInstanceId,
          hostPid: Number(this.codex?.host?.state?.pid) || null,
        });
      } else if (owner === 'desktop') {
        record = this.threadOwnership.markDesktop(threadId, changes);
      } else {
        record = this.threadOwnership.release(threadId, changes);
      }
    } catch (error) {
      this.log(error);
      return null;
    }
    // Some protocol-only test doubles and recovery paths intentionally omit
    // the event sink. Ownership is still persisted and returned to the
    // caller; an absent sink must never turn a successful claim into a
    // command failure.
    this.emit?.('thread.ownership', threadId, {
      threadId,
      owner: record.owner,
      mode: record.owner === 'khlink' ? 'managed' : record.owner === 'desktop' ? 'desktop' : 'unknown',
      source: record.source,
      reason: record.reason,
      stateVersion: record.stateVersion,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  claimBridgeThread(threadId, changes = {}) {
    return this.setThreadOwner(threadId, 'khlink', { source: changes.source || 'mobile', ...changes });
  }

  markDesktopThread(threadId, reason = null) {
    return this.setThreadOwner(threadId, 'desktop', { source: 'probe', reason });
  }

  releaseThreadOwner(threadId, reason = null) {
    return this.setThreadOwner(threadId, 'unknown', { source: 'release', reason });
  }

  async executeMobileTurn(payload, sourceDeviceId) {
    return this.withThreadTurnLock(payload.args?.threadId, () => this.executeMobileTurnUnlocked(payload, sourceDeviceId));
  }

  async executeMobileTurnUnlocked(payload, sourceDeviceId) {
    const tracked = this.registerDirectFollowup(payload, sourceDeviceId);
    let wrote = false;
    try {
      const result = await this.executeCommand(payload, { beforeWrite: () => {
        if (tracked) this.followups.update(tracked.id, { deliveryPhase: 'write' });
        wrote = true;
      } });
      if (tracked) {
        const started = this.followups.update(tracked.id, { state: 'started', startedAt: Date.now(), reason: null });
        this.emit('followup.started', tracked.threadId, { ...publicItem(started || tracked), startedAt: started?.startedAt || Date.now() }, sourceDeviceId);
      }
      return result;
    } catch (error) {
      if (!wrote && error.delivery === 'uncertain') error.delivery = 'not_sent';
      if (tracked) {
        // A steer that found the turn over is retried as a new turn (see command()).
        const steerTurnOver = payload.action === 'turn.steer' && /No active turn is available|no active turn|not running/i.test(String(error?.message || ''));
        if (error.delivery === 'uncertain') {
          const uncertain = this.followups.update(tracked.id, { state: 'uncertain', reason: error.message || String(error) });
          this.emit('followup.failed', tracked.threadId, { ...publicItem(uncertain || tracked), needsConfirmation: true }, sourceDeviceId);
        } else if (steerTurnOver || isDesktopWriterBusyError(error) || isCodexAgentLoopError(error) || isThreadLoadRetryableError(error)) {
          this.followups.remove(tracked.id);
        } else {
          const failed = this.followups.update(tracked.id, { state: 'failed', reason: error.message || String(error) });
          this.emit('followup.failed', tracked.threadId, { ...publicItem(failed || tracked), needsConfirmation: error.delivery === 'uncertain' }, sourceDeviceId);
        }
      }
      throw error;
    }
  }

  async startAttachmentTurnInBackground(payload, attachments, sourceDeviceId) {
    const request = { ...payload, args: { ...(payload.args || {}), attachments } };
    try {
      return await this.executeCommand(request);
    } catch (error) {
      if (isDesktopWriterBusyError(error)) return this.enqueueFollowup(request, sourceDeviceId, 'background');
      if (!isThreadNotFoundError(error)) throw error;
      // A task can be absent from the connector's app-server cache after a
      // restart. Resume it through the protocol, then retry the same request;
      // this remains entirely background and never opens the Desktop picker.
      try {
        await this.resumeThreadForBackground(request.args);
        return await this.executeCommand(request);
      } catch (resumeError) {
        if (isDesktopWriterBusyError(resumeError)) return this.enqueueFollowup(request, sourceDeviceId, 'background');
        throw resumeError;
      }
    }
  }

  async steerAttachmentInBackground(payload, attachments, sourceDeviceId) {
    const request = { ...payload, args: { ...(payload.args || {}), attachments } };
    try {
      return await this.executeCommand(request);
    } catch (error) {
      if (isDesktopWriterBusyError(error) || /no active turn|not currently running/i.test(String(error?.message || error))) {
        return this.enqueueFollowup({ ...request, action: 'turn.start' }, sourceDeviceId, 'background');
      }
      if (!isThreadNotFoundError(error)) throw error;
      try {
        await this.resumeThreadForBackground(request.args);
        return await this.executeCommand(request);
      } catch (resumeError) {
        if (isDesktopWriterBusyError(resumeError)) return this.enqueueFollowup({ ...request, action: 'turn.start' }, sourceDeviceId, 'background');
        throw resumeError;
      }
    }
  }

  async routeTurnThroughDesktop(payload, sourceDeviceId) {
    // A KH Link-owned thread is already served by the connector's persistent
    // app-server. Its writer lock is expected and must not be mistaken for a
    // Codex Desktop writer by the native probe.
    if (this.isBridgeOwnedThread(payload.args?.threadId) || await this.confirmCodexHostThread(payload.args?.threadId)) return null;
    try {
      const probe = await this.probeDesktopThread(payload.args?.threadId, payload.args?.title);
      // Being on another task (or still loading its composer) is not consent
      // to take an existing Desktop conversation over with a second writer.
      // Open it in Desktop before queuing, so it remains usable on the computer.
      if (isDesktopPresentProbe(probe)) {
        if (probe.code === 'task_active') this.markDesktopThread(payload.args?.threadId, 'Codex Desktop 持有当前任务写入权');
        return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
      }
      if (this.threadOwner(payload.args?.threadId)?.owner === 'desktop') {
        this.releaseThreadOwner(payload.args?.threadId, 'Desktop writer 已释放，等待 khLink 接管');
      }
      return null;
    } catch (error) {
      // A probe timeout is uncertain ownership: keep the message durable and
      // let the retry sweep probe again rather than risking a competing
      // writer.  A definite adapter-unavailable error means Desktop is not
      // the writer, so the background protocol is safe.
      if (isDesktopAdapterUnavailableError(error)) return null;
      return this.enqueueFollowup(payload, sourceDeviceId, 'queue');
    }
  }

  async probeDesktopThread(threadId, title) {
    try { return await this.desktopAdapter.probe(threadId, title); }
    catch (error) {
      // The native adapter reports these positive presence observations as
      // errors because the requested composer is not yet ready. They are not
      // evidence that Desktop is absent or that a background writer is safe.
      if (isDesktopPresentProbe(error)) return { code: error.code };
      throw error;
    }
  }

  async openCodexThreadOnDesktop(item) {
    if (!this.desktopAdapter?.openThread) {
      const error = new Error('等待电脑端打开此对话，消息尚未发送');
      error.delivery = 'not_sent'; throw error;
    }
    let title = item.title || this.desktopTitles?.get(item.threadId);
    if (!title) {
      const detail = await this.codex.request('thread/read', { threadId: item.threadId, includeTurns: false }, 5_000);
      title = normalizeThread(detail.thread || detail).title;
    }
    if (!title) throw Object.assign(new Error('暂时无法确认电脑端的目标对话，消息尚未发送'), { delivery: 'not_sent' });
    return this.desktopAdapter.openThread({ ...item, title });
  }

  followupBlocking(threadId) {
    // this.desktopActiveThreads is rebuilt fresh on every 2s poll directly
    // from Desktop's own thread/list. It reflects whether Desktop is showing
    // the thread as active right now; the status badge's rollout grace does
    // not leak into queue blocking decisions.
    return Boolean(this.desktopActiveThreads?.has(threadId));
  }

  desktopTurnIsActive(threadId, status = this.desktopStatuses?.get(threadId)) {
    if (!threadId) return false;
    if (this.desktopActivitySnapshotHealthy) return this.desktopActiveThreads?.has(threadId) === true;
    return isDesktopTaskBusy(status);
  }

  async enqueueFollowup(payload, sourceDeviceId, mode = 'queue') {
    const args = payload.args || {}; const requestId = payload.requestId || args.requestId || crypto.randomUUID();
    const displayText = String(args.text || '').trim();
    if (!args.threadId || (!displayText && !Array.isArray(args.attachments))) throw new Error('待发送指令缺少任务或正文');
    const attachments = this.resolveAttachments(args.threadId, args.attachments);
    if (!displayText && attachments.length === 0) throw new Error('待发送指令缺少任务或正文');
    const text = withAttachmentContext(displayText, attachments);
    const alreadyQueued = this.followups.get(requestId);
    if (alreadyQueued) return { queued: true, duplicate: true, item: publicItem(alreadyQueued), position: this.followups.list(args.threadId).findIndex((value) => value.id === alreadyQueued.id) + 1 };
    let item = this.followups.add({ id: requestId, requestId, threadId: args.threadId, title: args.title || null, text,
      displayText, attachments, cwd: args.cwd || null, model: args.model || null,
      effort: args.effort || null, serviceTier: args.serviceTier || null, permissionMode: args.permissionMode || null,
      // Older phones send a historical question card as turn.start once its
      // live pending state clears. Native Codex always uses send-now for an
      // answer. Preserve that intent across queue fallback, but never change
      // an explicit user request to queue an ordinary message.
      mode, queueRequested: payload.action === 'followup.enqueue',
      steerRequested: payload.action === 'turn.steer' || payload.action === 'turn.start' && isCodexQuestionReply(displayText),
      sourceDeviceId, state: 'pending', createdAt: Date.now(), attempts: 0, rolloutOffset: this.currentRolloutOffset(args.threadId),
      blocking: payload.action === 'followup.enqueue' || this.followupBlocking(args.threadId) });
    // Persistence is the acceptance boundary. Publish it before UI Automation
    // starts so every phone sees the queue state without waiting for Desktop.
    this.emit('followup.queued', item.threadId, publicItem(item), item.sourceDeviceId);
    if (item.state === 'pending') {
      const dispatched = await this.dispatchFollowup(item);
      // History reconciliation may have matched and removed the item while
      // UI dispatch was in flight. That is a successful delivery, not a new
      // queue row; returning a synthetic item here would make Android add the
      // already-delivered message back to its queue.
      if (!dispatched) return { queued: false, accepted: true, delivered: true, requestId };
      item = dispatched;
    }
    if (item.state === 'started' && (item.mode === 'steer' || item.desktopWindowSent)) return { accepted: true, queued: false, ...(item.mode === 'steer' ? { steered: true } : {}), requestId };
    if (item.state === 'uncertain') return { accepted: false, uncertain: true, queued: true, requestId, item: publicItem(item) };
    if (item.state === 'failed') return { accepted: false, failed: true, requestId, item: publicItem(item) };
    if (item.steerRequested && item.reason) return { accepted: false, deferred: true, queued: true, requestId, item: publicItem(item) };
    return { queued: true, item: publicItem(item), position: this.followups.list(args.threadId).findIndex((value) => value.id === item.id) + 1 };
  }

  async executeQueuedBackgroundTurn(item) {
    const request = { action: item.steerRequested ? 'turn.steer' : 'turn.start', args: {
      _queueDispatch: true,
      requestId: item.requestId, threadId: item.threadId, title: item.title || null, text: item.displayText || item.text,
      attachments: item.attachments || [], cwd: item.cwd || undefined, model: item.model || undefined,
      effort: item.effort || undefined, serviceTier: item.serviceTier || undefined,
      permissionMode: item.permissionMode || undefined,
    } };
    const execute = async () => {
      try { return await this.executeSerializedCommand(request); }
      catch (error) {
        // A historical async question or a racing turn completion has no
        // turn left to steer. A definite no-active-turn rejection is safe to
        // start once; uncertain writes must never be replayed.
        if (!item.steerRequested || error.delivery === 'uncertain' ||
            !/No active turn is available|no active turn|not running/i.test(String(error.message))) throw error;
        return this.executeSerializedCommand({ ...request, action: 'turn.start' });
      }
    };
    try {
      return await execute();
    } catch (error) {
      if (!isThreadNotFoundError(error) || !this.codex?.request) throw error;
      // A task created from the phone may not be loaded by the connector's
      // fresh app-server after a restart. Resume it through the same
      // background protocol, then retry the exact idempotent request.
      await this.resumeThreadForBackground(item);
      return execute();
    }
  }

  async enqueueCodexThreadQueue(item) {
    if (!item?.threadId || !item?.requestId) throw new Error('Codex 队列缺少任务或请求标识');
    // Codex app-server owns the queue for a Desktop-loaded thread.  This is a
    // protocol write to the queue, not a second turn writer: it is safe while
    // Desktop is holding the thread and, unlike the native adapter, it never
    // focuses the window or opens the Windows file picker. The client id
    // identifies a receipt; Codex 0.160.1 does NOT deduplicate queue/add by
    // that id (confirmed with an isolated three-call test on 2026-10-08).
    // Once a write may have happened, only positive receipts allow recovery.
    let result;
    try {
      result = await this.codex.request('thread/queue/add', {
        threadId: item.threadId,
        input: codexInput(item.displayText || item.text, item.attachments || [], item.requestId),
        clientUserMessageId: item.requestId,
      }, 30_000);
    } catch (error) {
      if (!error.delivery) error.delivery = isThreadNotFoundError(error) || isDesktopWriterBusyError(error) || /invalid params|unknown method|method not found/i.test(error.message) ? 'not_sent' : 'uncertain';
      throw error;
    }
    if (!result?.queuedSubmission?.id || (result.queuedSubmission.clientUserMessageId && result.queuedSubmission.clientUserMessageId !== item.requestId)) {
      const error = new Error('电脑队列未返回这条消息的有效回执'); error.delivery = 'uncertain'; throw error;
    }
    return result;
  }

  async confirmCodexHostThread(threadId) {
    if (!threadId || this.codex?.mode !== 'host' || !this.codex.ready || !this.codex.request) return false;
    // A lock identifies a loaded app-server thread, not the Desktop app.
    // After host recovery the persisted owner can be stale. Ask our host
    // before trying to find a Desktop composer for a thread it already owns.
    try {
      let cursor = null;
      do {
        const page = await this.codex.request('thread/loaded/list', { cursor, limit: 100 }, 5_000);
        if (page.data?.includes(threadId)) {
          this.claimBridgeThread(threadId, { source: 'host_loaded' });
          return true;
        }
        cursor = page.nextCursor || null;
      } while (cursor);
    } catch (error) { this.log(error); }
    return false;
  }

  async dispatchFollowup(item) {
    if (!item?.id || !this.followups?.update) return null;
    // Small protocol test doubles and older embedded stores only expose
    // `update`; when `get` exists it is the authoritative removal check.
    const present = () => typeof this.followups.get !== 'function' || Boolean(this.followups.get(item.id));
    if (!present()) return null;
    const update = (changes) => present() ? this.followups.update(item.id, changes) : null;
    await this.confirmCodexHostThread(item.threadId);
    // A phone "立即发送" can claim a still-local queued item while the
    // read-only host probe is in flight. Do not subsequently dispatch it again.
    const current = this.followups.get?.(item.id);
    if (current?.state && current.state !== 'pending') return current;
    const state = this.threadState?.get(item.threadId) || {};
    const pendingSettings = item.steerRequested ? null : state.pendingDesktopSettings;
    const blocking = item.queueRequested === true || this.followupBlocking(item.threadId);
    if (pendingSettings && this.desktopTurnIsActive(item.threadId)) {
      const waiting = update({
        state: 'pending',
        reason: '等待当前轮完成后应用设置',
        nextRetryAt: Date.now() + 3000,
        blocking: true,
      });
      if (!waiting) return null;
      this.emit('followup.queued', item.threadId, publicItem(waiting), item.sourceDeviceId);
      return waiting;
    }
    // "排队": a thread whose turn the connector itself is running waits for that
    // turn to end. turn/start on a busy thread puts the message into the
    // running turn (that is what "立即发送" is for), and the reply to it then
    // ends the turn before the first request is answered.
    const ownTurn = this.threadOwner(item.threadId)?.owner === 'khlink' || this.isBridgeOwnedThread?.(item.threadId);
    // Never for ever: a running badge that failed to clear must not strand it.
    const waitedTooLong = Date.now() - (item.createdAt || Date.now()) > 30 * 60_000;
    if (item.mode === 'queue' && !item.steerRequested && ownTurn && !waitedTooLong && isLiveThreadStatus(this.desktopStatuses?.get(item.threadId))) {
      const waiting = update({ state: 'pending', reason: '等当前这一轮结束后发送', nextRetryAt: Date.now() + 2000, blocking: true });
      if (!waiting) return null;
      if (item.state !== 'pending' || item.reason !== waiting.reason) this.emit('followup.queued', item.threadId, publicItem(waiting), item.sourceDeviceId);
      return waiting;
    }
    const dispatching = update({ state: 'dispatching', deliveryPhase: 'probe', attempts: (item.attempts || 0) + 1, lastAttemptAt: Date.now(), blocking });
    if (!dispatching) return null;
    this.emit('followup.queued', item.threadId, publicItem(dispatching), item.sourceDeviceId);
    let deliveryPhase = 'probe';
    const enterPhase = (phase) => { deliveryPhase = phase; update({ deliveryPhase: phase, ...(phase === 'codex_queue' ? { queueTransport: 'codex' } : {}) }); };
    try {
      if (pendingSettings) {
        enterPhase('settings');
        await this.applyPendingDesktopSettings(item);
        enterPhase('probe');
      }
      let desktopOwnsThread = false;
      const knownOwner = this.threadOwner(item.threadId)?.owner;
      if (knownOwner === 'khlink') {
        // The connector's own app-server is the single writer for managed
        // threads. Its lock is intentional; never route these items through
        // Desktop UI Automation or classify them as Desktop-owned.
        desktopOwnsThread = false;
      } else if (item.mode === 'queue' && !this.desktopAdapter?.probe) {
        // Test doubles and older embedded adapters do not expose probing; in
        // that case retain their explicit Desktop-queue contract. Attachments
        // are still never sent through this fallback because it would open a
        // foreground file picker.
        desktopOwnsThread = true;
      } else if (item.mode === 'queue' && this.desktopAdapter?.probe) {
        try {
          const probe = await this.probeDesktopThread(item.threadId, item.title);
          desktopOwnsThread = probe?.code === 'task_active';
          if (!desktopOwnsThread && isDesktopPresentProbe(probe)) {
            enterPhase('desktop_open');
            await this.openCodexThreadOnDesktop(item);
            desktopOwnsThread = true;
            enterPhase('probe');
          }
          if (desktopOwnsThread) this.markDesktopThread(item.threadId, 'Codex Desktop 持有当前任务写入权');
          else if (knownOwner === 'desktop') this.releaseThreadOwner(item.threadId, 'Desktop writer 已释放，等待 khLink 接管');
        } catch (probeError) {
          // An uncertain probe must not race a visible Desktop writer. Keep
          // the item pending so the next sweep can ask again; a definite
          // adapter failure means the background protocol is the safe owner.
          if (!isDesktopAdapterUnavailableError(probeError)) throw probeError;
          desktopOwnsThread = false;
        }
      }
      if (desktopOwnsThread && this.codex?.request) {
        // Text and images both use the protocol queue and durable receipts.
        // Switching a huge Desktop conversation through UI Automation can
        // take longer than the dispatch timeout and leave delivery unknown.
        enterPhase('codex_queue');
        const queued = await this.enqueueCodexThreadQueue(item);
        // queue/add confirms it is waiting, NOT that Desktop has consumed it.
        // Recent-list activity can omit a running thread. Only a real start,
        // steer receipt or rollout user-message match can move it inline.
        const accepted = update({ state: 'desktop_queued', reason: null, nextRetryAt: null, queueTransport: 'codex', codexQueueId: queued?.queuedSubmission?.id || null,
          codexQueueText: queued?.queuedSubmission?.input?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || null, blocking: true });
        if (!accepted) return null;
        this.emit('followup.queued', item.threadId, publicItem(accepted), item.sourceDeviceId);
        // Desktop's app-server does not consume our host's protocol queue.
        // Hand text to the Desktop's own queue, or Send if it is already idle.
        // A normal queued message must never press the Steer control.
        if (item.steerRequested || (this.codexDesktopSteer && !(item.attachments || []).some(isImageAttachment))) {
          await this.steerFollowup(item.id, item.sourceDeviceId, item.threadId, { retainReceipt: true, queueOnly: !item.steerRequested });
          return this.followups.get(item.id) || null;
        }
        return accepted;
      }
      if (!desktopOwnsThread && (item.mode === 'background' || item.attachments?.length || item.mode === 'queue')) {
        enterPhase('background');
        await this.executeQueuedBackgroundTurn(item);
      } else {
        enterPhase('desktop_dispatch');
        await this.desktopAdapter.dispatch(item);
      }
      // The background app-server path (desktopOwnsThread === false) starts
      // the turn immediately, regardless of Desktop's own busy state. The
      // Desktop UI-automation path (desktopOwnsThread === true) hands off to
      // Desktop's own composer, which only runs it immediately if Desktop
      // was not already busy — reflect the real busy signal there instead.
      const steered = !desktopOwnsThread && item.steerRequested;
      const accepted = update({ state: !desktopOwnsThread ? 'started' : 'desktop_queued', ...(!desktopOwnsThread ? { startedAt: Date.now() } : {}),
        ...(steered ? { mode: 'steer', steerRequested: false } : {}), reason: null, blocking: desktopOwnsThread ? blocking : false });
      if (!accepted) return null;
      this.emit('followup.queued', item.threadId, publicItem(accepted), item.sourceDeviceId);
      if (steered) this.emit('steer.accepted', item.threadId, { requestId: item.requestId, queuedItemId: item.id }, item.sourceDeviceId);
      return accepted;
    } catch (error) {
      if (isDesktopWriterBusyError(error)) {
        this.markDesktopThread(item.threadId, error.message || 'Codex Desktop 持有当前任务写入权');
        // A targeted UI probe can report “another task” even while Desktop's
        // app-server still retains this thread in memory. In that case the
        // background turn is rejected by the single-writer guard, but the
        // formal Codex queue remains writable. Prefer it for all messages before
        // falling back to a retry state.
        if (this.codex?.request) {
          try {
            enterPhase('codex_queue');
            const queued = await this.enqueueCodexThreadQueue(item);
            // This branch is only reached after a definite writer-busy error,
            // so the item is genuinely waiting behind Desktop's current turn.
            const accepted = update({ state: 'desktop_queued', reason: null, nextRetryAt: null, queueTransport: 'codex', codexQueueId: queued?.queuedSubmission?.id || null,
              codexQueueText: queued?.queuedSubmission?.input?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || null, blocking: true });
            if (!accepted) return null;
            this.emit('followup.queued', item.threadId, publicItem(accepted), item.sourceDeviceId);
            // A writer-busy fallback must preserve the original immediate
            // answer/steer intent, just like the successful Desktop probe.
            if (item.steerRequested || (this.codexDesktopSteer && !(item.attachments || []).some(isImageAttachment))) {
              await this.steerFollowup(item.id, item.sourceDeviceId, item.threadId, { retainReceipt: true, queueOnly: !item.steerRequested });
              return this.followups.get(item.id) || null;
            }
            return accepted;
          } catch (queueError) {
            this.log(queueError);
            // The original writer-busy error proves the turn/start was
            // rejected. It says nothing about the queue/add attempted after
            // it: a lost queue ACK must not fall back to pending and repeat.
            error = queueError;
          }
        }
      }
      if (error.delivery === 'uncertain') {
        if (['probe', 'desktop_open', 'settings'].includes(deliveryPhase)) {
          const pending = update({ state: 'pending', reason: '电脑端任务状态暂时未响应，等待重试', nextRetryAt: Date.now() + 3000 });
          if (pending) this.emit('followup.queued', item.threadId, publicItem(pending), item.sourceDeviceId);
          return pending;
        }
        // A UI send or queue write can time out after acceptance. Never
        // conflate it with a read-only probe or replay it on the next scan.
        const uncertain = update({
          state: 'uncertain',
          reason: '电脑端发送回执未确认，正在核对对话；不会自动重发',
          nextRetryAt: null,
        });
        if (!uncertain) return null;
        this.emit('followup.failed', item.threadId, { ...publicItem(uncertain), needsConfirmation: true }, item.sourceDeviceId);
        return uncertain;
      }
      // A modal or unavailable chat must not keep navigating the user's
      // Desktop hundreds of times and blocking newer replies. Nothing was
      // written in this phase; retain the input for an explicit retry.
      if (error.code === 'task_identity_unconfirmed' && deliveryPhase === 'desktop_open' && (item.attempts || 0) >= 3) {
        const failed = update({ state: 'failed', reason: '未能确认电脑上的目标对话，请关闭遮挡弹窗后重试；内容已保留', nextRetryAt: null, blocking: true });
        if (failed) this.emit('followup.failed', item.threadId, { ...publicItem(failed), needsConfirmation: false }, item.sourceDeviceId);
        return failed;
      }
      const pending = update({
        state: 'pending',
        reason: followupRetryReason(error),
        nextRetryAt: Date.now() + 3000,
        blocking: true,
      });
      if (!pending) return null;
      this.emit('followup.queued', item.threadId, publicItem(pending), item.sourceDeviceId);
      return pending;
    }
  }

  async resumeThreadForBackground(args = {}) {
    const threadId = args.threadId;
    if (!threadId) throw new Error('缺少任务标识，无法恢复任务');
    const state = this.threadState?.get(threadId) || {};
    const mode = args.permissionMode || args.mode || state.permissionMode || state.mode || 'manual';
    const params = {
      threadId,
      excludeTurns: true,
      // An existing task keeps its own directory; never impose the connector's.
      ...(args.cwd || state.cwd ? { cwd: args.cwd || state.cwd } : {}),
      approvalPolicy: mode === 'yolo' ? 'never' : 'untrusted',
      sandbox: mode === 'yolo' ? 'danger-full-access' : 'workspace-write',
    };
    const model = args.model || state.model;
    if (model) params.model = model;
    const effort = args.effort || state.effort;
    if (effort) params.effort = effort;
    const serviceTier = args.serviceTier || state.serviceTier;
    if (serviceTier) params.serviceTier = serviceTier;
    return this.codex.request('thread/resume', params, 30_000);
  }

  async applyPendingDesktopSettings(item) {
    const state = this.threadState?.get(item.threadId) || {};
    const pending = state.pendingDesktopSettings;
    if (!pending) return null;
    const request = {
      ...pending,
      threadId: item.threadId,
      title: item.title || pending.title || null,
    };
    // A task already owned by the Desktop app must be changed through that
    // app's own controls. Sending thread/settings/update from the connector
    // creates a second writer and makes Desktop show “already open in another
    // application”. The adapter preserves the current draft and restores the
    // previous foreground window after changing the mode. Only fall back to
    // the background protocol when Desktop itself is unavailable.
    let result;
    if (pending.collaborationMode) {
      const changed = {};
      for (const key of ['model', 'effort', 'serviceTier', 'permissionMode', 'collaborationMode']) {
        if (Object.prototype.hasOwnProperty.call(pending, key) && pending[key] !== undefined) changed[key] = pending[key];
      }
      const update = await this.buildThreadSettingsUpdate(item.threadId, state, changed);
      result = await this.applyCollaborationModeSettings(request, update, item.threadId);
    } else {
      result = await this.desktopAdapter.settings(request);
    }
    const effectiveMode = result?.effectiveCollaborationMode || pending.collaborationMode || publicThreadSettings(state).effectiveCollaborationMode;
    const nextState = {
      ...state,
      collaborationMode: effectiveMode,
      effectiveCollaborationMode: effectiveMode,
      desiredCollaborationMode: pending.collaborationMode || effectiveMode,
      modeSyncSource: pending.collaborationMode ? (result?.modeSyncSource || 'protocol') : state.modeSyncSource,
      modeSyncState: pending.collaborationMode ? (result?.modeSyncState || 'applied') : state.modeSyncState,
      modeSyncReason: null,
      pendingDesktopSettings: null,
      pendingDesktopSettingsNextRetryAt: null,
      pendingDesktopSettingsAttempts: 0,
    };
    this.threadState.set(item.threadId, nextState);
    const settings = publicThreadSettings({ ...nextState, nextTurn: true });
    this.emit('thread.settings', item.threadId, {
      threadId: item.threadId,
      settings,
      nextTurn: true,
      applied: true,
      updatedAt: Date.now(),
    }, item.sourceDeviceId);
    return result;
  }

  async updateThreadSettingsInBackground(update, threadId = update.threadId) {
    let lastError;
    // Collaboration-mode writes are safe to retry and can be deferred when a
    // Desktop writer holds the task. Do not make the phone wait through the
    // generic 30-second RPC timeout before showing the pending state.
    const timeoutMs = update?.collaborationMode ? 8_000 : 30_000;
    // A connector reconnect can race the first request after wake/resume. A
    // single short retry removes that transient without making a mode switch
    // feel hung or duplicating a successful update.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        try {
          return await this.codex.request('thread/settings/update', update, timeoutMs);
        } catch (error) {
          // A task can be present on disk but not loaded in this app-server.
          // Once the Desktop writer releases its lock, resume it in the
          // background and retry the idempotent settings update.
          if (isThreadNotFoundError(error) && attempt === 0) {
            await this.codex.request('thread/resume', { threadId, excludeTurns: true }, 15_000);
            return await this.codex.request('thread/settings/update', update, timeoutMs);
          }
          throw error;
        }
      } catch (error) {
        lastError = error;
        if (isDesktopWriterBusyError(error) || attempt === 1 || !isBackgroundSettingsRetryableError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }

  // A task started from the phone runs in the connector's own app-server;
  // Codex Desktop's window has no settings controls for it (its settings menu
  // does not offer the phone's options), so it is set by protocol.
  connectorRunsThread(threadId) {
    const owner = this.threadOwner?.(threadId)?.owner;
    if (owner === 'khlink') return true;
    // Codex Desktop may open a phone task and take its writer: it runs there then.
    if (owner === 'desktop') return false;
    // The ownership lease expires; the rollout's first line says for good who
    // created the task (the connector's app-server runs as "Fengzhu Mobile").
    this.rolloutOriginators ||= new Map();
    if (!this.rolloutOriginators.has(threadId)) {
      let originator = null;
      try {
        const file = this.rolloutFilesByThread?.get(threadId) || this.findRolloutFile?.(threadId);
        if (file) {
          const fd = fs.openSync(file, 'r');
          try {
            const buffer = Buffer.alloc(64 * 1024); const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
            originator = buffer.subarray(0, n).toString('utf8').match(/"originator":"([^"]*)"/)?.[1] || null;
          } finally { fs.closeSync(fd); }
        }
      } catch { /* unknown */ }
      this.rolloutOriginators.set(threadId, originator);
    }
    return this.rolloutOriginators.get(threadId) === 'Fengzhu Mobile';
  }

  async applyCollaborationModeSettings(request, update, threadId = update.threadId) {
    // A title is supplied for existing Desktop tasks. Use the native adapter
    // first so the GUI's single writer remains authoritative. Mobile-created
    // tasks without a Desktop title continue to use the background protocol.
    if (request?.title && this.desktopAdapter?.settings && !this.connectorRunsThread(threadId)) {
      try {
        const result = await this.desktopAdapter.settings(request);
        return { ...(result || {}), modeSyncSource: 'desktop' };
      } catch (error) {
        // If Desktop is not running at all, the background app-server is the
        // safe owner. UI identity/control failures remain queued instead of
        // opening a competing protocol writer while Desktop is present.
        if (isDesktopAdapterUnavailableError(error)) {
          const result = await this.updateThreadSettingsInBackground(update, threadId);
          return { ...(result || {}), modeSyncSource: 'protocol' };
        }
        throw error;
      }
    }
    const result = await this.updateThreadSettingsInBackground(update, threadId);
    return { ...(result || {}), modeSyncSource: 'protocol' };
  }

  async buildThreadSettingsUpdate(threadId, state, changed) {
    let next = { ...state, ...changed };
    // Codex requires collaborationMode.settings.model even when the phone
    // displays “默认”. Resolve the account default only for this protocol
    // update; an explicit model always wins.
    if (changed.collaborationMode && !next.model) {
      next = { ...next, model: await this.resolveDefaultModel() };
    }
    return threadSettingsUpdateParams(threadId, next, changed);
  }

  queuePendingSettings(args, reason) {
    const current = this.threadState.get(args.threadId) || {};
    const currentPublic = publicThreadSettings(current);
    const changed = { ...(args.settings || {}) };
    const desiredMode = changed.collaborationMode || currentPublic.effectiveCollaborationMode;
    const pending = {
      threadId: args.threadId,
      title: args.title || args.threadTitle || null,
      model: changed.model,
      effort: changed.effort,
      serviceTier: Object.prototype.hasOwnProperty.call(args.settings || {}, 'serviceTier') ? args.settings.serviceTier ?? 'default' : undefined,
      permissionMode: changed.permissionMode,
      collaborationMode: changed.collaborationMode,
    };
    const pendingState = {
      ...current,
      collaborationMode: currentPublic.effectiveCollaborationMode,
      effectiveCollaborationMode: currentPublic.effectiveCollaborationMode,
      desiredCollaborationMode: desiredMode,
      modeSyncSource: changed.collaborationMode ? 'protocol' : current.modeSyncSource,
      modeSyncState: changed.collaborationMode ? 'pending' : currentPublic.modeSyncState,
      modeSyncReason: reason || '电脑端当前轮正在运行，设置将在当前轮完成后通过后台协议应用',
      pendingDesktopSettings: pending,
      pendingDesktopSettingsNextRetryAt: Date.now() + 3000,
      pendingDesktopSettingsAttempts: 0,
    };
    this.threadState.set(args.threadId, pendingState);
    const effective = publicThreadSettings({ ...pendingState, nextTurn: true });
    const message = reason || pendingState.modeSyncReason;
    this.emit('thread.settings', args.threadId, {
      threadId: args.threadId,
      settings: effective,
      nextTurn: true,
      queued: true,
      reason: message,
      updatedAt: Date.now(),
    });
    return { ...effective, applied: false, queued: true, nextTurn: true, reason: message };
  }

  async steerDesktop(payload, sourceDeviceId) {
    const args = payload.args || {}; const requestId = payload.requestId || args.requestId || crypto.randomUUID();
    const displayText = String(args.text || '').trim();
    const attachments = this.resolveAttachments(args.threadId, args.attachments);
    const item = { id: requestId, requestId, threadId: args.threadId, title: args.title || null,
      text: withAttachmentContext(displayText, attachments), displayText, attachments,
      mode: 'steer', sourceDeviceId, createdAt: Date.now() };
    // Native steering is also a write. Persist its identity before invoking
    // the window so a reconnect/replayed phone frame cannot click Send again.
    this.followups.add({ ...item, state: 'dispatching', deliveryPhase: 'write', blocking: false,
      rolloutOffset: this.currentRolloutOffset(args.threadId) });
    try {
      const result = await this.desktopAdapter.dispatch(item);
      if (result.code === 'steer_deferred') {
        const queued = this.followups.update(item.id, { mode: 'queue', state: 'desktop_queued', reason: '当前阶段不能调整方向，已保留为同一任务的待发送消息', blocking: true });
        this.emit('followup.queued', item.threadId, publicItem(queued), sourceDeviceId);
        this.emit('steer.deferred', item.threadId, { requestId, reason: result.message, item: publicItem(queued) }, sourceDeviceId);
        return { deferred: true, queued: true, requestId, item: publicItem(queued) };
      }
      this.followups.update(item.id, { state: 'steered', startedAt: Date.now(), reason: null });
      this.emit('steer.accepted', item.threadId, { requestId }, sourceDeviceId);
      return { accepted: true, requestId };
    } catch (error) {
      if (error.delivery !== 'not_sent') {
        const uncertain = this.followups.update(item.id, { state: 'uncertain', blocking: true,
          reason: '调整方向的回执尚未确认，正在核对对话；不会自动重发', nextRetryAt: null });
        this.emit('followup.failed', item.threadId, { ...publicItem(uncertain), needsConfirmation: true }, sourceDeviceId);
        return { accepted: false, uncertain: true, requestId, item: publicItem(uncertain) };
      }
      this.followups.remove(item.id);
      const queued = await this.enqueueFollowup({ requestId, args }, sourceDeviceId, 'queue');
      this.emit('steer.deferred', item.threadId, { requestId, reason: error.code || error.message, item: queued.item }, sourceDeviceId);
      return { deferred: true, ...queued };
    }
  }

  async cancelFollowup(id, sourceDeviceId, expectedThreadId = null) {
    // A cancellation cannot overtake a window transfer that may already
    // have removed the protocol row or pressed Send.
    if (this.followupSteerRequests?.has(id)) await this.followupSteerRequests.get(id).catch(() => {});
    const item = this.followups.get(id); if (!item) return { cancelled: false, missing: true };
    assertCommandThread(expectedThreadId, item.threadId);
    if (['started', 'steered'].includes(item.state)) return { cancelled: false, reason: '消息已开始执行，不能再取消排队' };
    if (item.queueTransport === 'codex' && item.state === 'desktop_queued') {
      let queueId = item.codexQueueId;
      if (!queueId) {
        let cursor = null;
        do {
          const page = await this.codex.request('thread/queue/list', { threadId: item.threadId, cursor, limit: 100 }, 15_000);
          queueId = page.data?.find((row) => row.clientUserMessageId === item.requestId)?.id;
          cursor = page.nextCursor || null;
        } while (!queueId && cursor);
      }
      if (queueId) await this.codex.request('thread/queue/delete', { threadId: item.threadId, queuedSubmissionId: queueId }, 15_000);
    } else if (item.state === 'desktop_queued' && item.queueTransport === 'desktop') {
      try { await this.desktopAdapter.cancel(item); }
      catch (error) {
        const reason = '未能确认从电脑队列移除，请在电脑检查；消息仍可能执行';
        const retained = this.followups.update(item.id, { reason });
        if (retained) this.emit('followup.failed', item.threadId, { ...publicItem(retained), needsConfirmation: false }, sourceDeviceId || item.sourceDeviceId);
        return { cancelled: false, reason };
      }
    } else if (item.state === 'desktop_queued' || item.state === 'uncertain') {
      // The Desktop queue may already have consumed the item or may no longer
      // expose its remove control after a task switch. The user explicitly
      // asked to cancel this mobile queue item, so local state must still be
      // removed; never leave a permanent ghost item because the best-effort
      // Desktop cleanup could not find its button.
      try { await this.desktopAdapter.cancel(item); }
      catch (error) { this.log(new Error(`Desktop queue cleanup skipped: ${error.message}`)); }
    }
    this.releaseFollowupAttachments(item);
    this.followups.remove(item.id);
    this.emit('followup.cancelled', item.threadId, { id: item.id, requestId: item.requestId }, sourceDeviceId || item.sourceDeviceId);
    return { cancelled: true, id: item.id };
  }

  async steerFollowup(id, sourceDeviceId, expectedThreadId = null, { retainReceipt = false, queueOnly = false } = {}) {
    const current = this.followups.get(id);
    if (current) assertCommandThread(expectedThreadId, current.threadId);
    // The retry sweep can run while the initial native lookup is awaiting
    // UIA. Share that lookup's receipt instead of queuing a second click.
    this.followupSteerRequests ||= new Map();
    if (this.followupSteerRequests.has(id)) return this.followupSteerRequests.get(id);
    const operation = this.steerFollowupOnce(id, sourceDeviceId, expectedThreadId, { retainReceipt, queueOnly });
    this.followupSteerRequests.set(id, operation);
    try { return await operation; }
    finally { if (this.followupSteerRequests.get(id) === operation) this.followupSteerRequests.delete(id); }
  }

  async steerFollowupOnce(id, sourceDeviceId, expectedThreadId = null, { retainReceipt = false, queueOnly = false } = {}) {
    const item = this.followups.get(id);
    if (!item) return { accepted: false, missing: true };
    assertCommandThread(expectedThreadId, item.threadId);
    if (item.state === 'pending' && item.mode === 'queue' && this.isBridgeOwnedThread(item.threadId)) {
      return this.steerPendingFollowup(item, sourceDeviceId);
    }
    if (item.state !== 'desktop_queued') {
      return { accepted: false, unavailable: true, reason: '这条消息尚未进入电脑队列' };
    }
    if (item.queueTransport === 'codex' && this.codexDesktopSteer && !(item.attachments || []).some(isImageAttachment)) {
      // One visible Desktop window serves all conversations: do not let two
      // concurrent sends switch its selected task or edit its composer at once.
      return this.withCodexDesktopWindowLock(async () => {
        const current = this.followups.get(id);
        if (!current || current.state !== 'desktop_queued' || current.queueTransport !== 'codex') return { accepted: false, unavailable: true };
        return this.steerCodexQueueThroughWindow(current, sourceDeviceId, { retainReceipt, queueOnly });
      });
    }
    const steerRequestedAt = Date.now();
    try {
      const result = await this.desktopAdapter.steer(item);
      this.log?.(`Desktop queue steer ${item.threadId} request=${item.requestId} result=${result?.code || 'accepted'} elapsed=${Date.now() - steerRequestedAt}ms`);
      if (result?.code === 'steer_deferred') {
        const deferred = this.followups.update(item.id, { reason: result.message || '当前阶段不能调整方向', blocking: true });
        if (!deferred) return { accepted: false, missing: true };
        this.emit('steer.deferred', item.threadId, { requestId: item.requestId, reason: deferred.reason, item: publicItem(deferred) }, sourceDeviceId || item.sourceDeviceId);
        return { accepted: false, deferred: true, item: publicItem(deferred) };
      }
      if (retainReceipt) this.followups.update(item.id, { state: 'started', mode: 'steer', steerRequested: false, startedAt: Date.now(), reason: null, blocking: false });
      else this.followups.remove(item.id);
      this.emit('steer.accepted', item.threadId, { requestId: item.requestId, queuedItemId: item.id }, sourceDeviceId || item.sourceDeviceId);
      return { accepted: true, requestId: item.requestId, result };
    } catch (error) {
      this.log?.(`Desktop queue steer ${item.threadId} request=${item.requestId} result=${error.code || error.action || 'error'} delivery=${error.delivery || 'not_sent'} elapsed=${Date.now() - steerRequestedAt}ms`);
      if (error.delivery === 'uncertain') {
        const uncertain = this.followups.update(item.id, { state: 'uncertain', reason: error.message });
        if (!uncertain) return { accepted: false, missing: true };
        this.emit('followup.failed', item.threadId, { ...publicItem(uncertain), needsConfirmation: true }, sourceDeviceId || item.sourceDeviceId);
        return { accepted: false, uncertain: true, item: publicItem(uncertain) };
      }
      if (error.code === 'queue_paused') {
        const reason = steerFailureText({ code: 'queue_paused' });
        const unchanged = this.followups.update(item.id, { reason, blocking: true, steerRequested: false, steerRetryAt: null });
        if (!unchanged) return { accepted: false, missing: true };
        this.emit('steer.deferred', item.threadId, { requestId: item.requestId, reason, item: publicItem(unchanged) }, sourceDeviceId || item.sourceDeviceId);
        return { accepted: false, deferred: true, item: publicItem(unchanged) };
      }
      const unchanged = this.followups.update(item.id, { reason: error.message, blocking: true, steerRetryAt: Date.now() + 3000, steerAttempts: (item.steerAttempts || 0) + 1 });
      if (!unchanged) return { accepted: false, missing: true };
      this.emit('steer.deferred', item.threadId, { requestId: item.requestId, reason: error.message, item: publicItem(unchanged) }, sourceDeviceId || item.sourceDeviceId);
      return { accepted: false, deferred: true, item: publicItem(unchanged) };
    }
  }

  async withCodexDesktopWindowLock(task) {
    const previous = this.codexDesktopWindowChain || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    this.codexDesktopWindowChain = operation;
    try { return await operation; }
    finally { if (this.codexDesktopWindowChain === operation) this.codexDesktopWindowChain = null; }
  }

  /**
   * A message in the Codex protocol queue of a task Codex Desktop runs. Its
   * window does not show that queue (26.1027), so the message leaves it and
   * goes through the window's own Queue and Steer controls instead. If the
   * window cannot take it, it goes back into the protocol queue unchanged.
   */
  async steerCodexQueueThroughWindow(item, sourceDeviceId, { retainReceipt = false, queueOnly = false } = {}) {
    const started = Date.now();
    const deviceId = sourceDeviceId || item.sourceDeviceId;
    const title = item.title || this.desktopTitles?.get(item.threadId) || null;
    if (!title) return this.deferCodexSteer(item, deviceId, '电脑端还不知道这个任务的标题，消息仍在等待', { queueOnly });
    let queueId = item.codexQueueId;
    try {
      if (!queueId) queueId = await this.findCodexQueueId(item);
      // Gone from the queue: the turn ended meanwhile and Codex started it.
      if (!queueId) return { accepted: false, unavailable: true, reason: '这条消息已开始执行' };
      // Persist before removing the receipt: a crash after this point must
      // not silently retry a transfer whose destination may have accepted it.
      this.followups.update(item.id, { state: 'dispatching', deliveryPhase: 'queue_transfer' });
      await this.codex.request('thread/queue/delete', { threadId: item.threadId, queuedSubmissionId: queueId }, 15_000);
    } catch (error) {
      const uncertain = this.followups.update(item.id, { state: 'uncertain', reason: '电脑队列回执未确认，正在核对；不会自动重发', nextRetryAt: null });
      if (uncertain) this.emit('followup.failed', item.threadId, { ...publicItem(uncertain), needsConfirmation: true }, deviceId);
      return { accepted: false, uncertain: true, ...(uncertain ? { item: publicItem(uncertain) } : {}) };
    }
    const text = withRequestMarker(withAttachmentContext(item.displayText || item.text, normalizeAttachments(item.attachments).filter((a) => !isImageAttachment(a))), item.requestId);
    let result;
    try { result = await this.codexDesktopSteer.steer({ threadId: item.threadId, title, text, mode: queueOnly ? 'queue' : 'steer' }); }
    catch (error) { result = { code: 'script_failed', delivery: 'uncertain', message: String(error.message || error) }; }
    this.log?.(`Codex window steer ${item.threadId} request=${item.requestId} result=${result.code} delivery=${result.delivery} elapsed=${Date.now() - started}ms`);
    if (result.code === 'steer_accepted' || result.code === 'sent') {
      if (retainReceipt) this.followups.update(item.id, { state: 'started', ...(queueOnly ? { desktopWindowSent: true } : { mode: 'steer' }), steerRequested: false, windowQueueRequested: false, startedAt: Date.now(), reason: null, blocking: false });
      else this.followups.remove(item.id);
      if (queueOnly) this.emit('followup.started', item.threadId, publicItem(this.followups.get(item.id) || item), deviceId);
      else this.emit('steer.accepted', item.threadId, { requestId: item.requestId, queuedItemId: item.id }, deviceId);
      return { accepted: true, requestId: item.requestId, result };
    }
    if (result.code === 'queued') {
      const kept = this.followups.update(item.id, { state: 'desktop_queued', queueTransport: 'desktop', codexQueueId: null,
        steerRequested: false, windowQueueRequested: false, blocking: true, reason: null });
      if (!kept) return { accepted: false, missing: true };
      this.emit('followup.queued', item.threadId, publicItem(kept), deviceId);
      return { accepted: false, deferred: true, item: publicItem(kept) };
    }
    if (result.code === 'steer_deferred') {
      // In the window's own queue now: it runs after this turn, like any queued message.
      const kept = this.followups.update(item.id, { state: 'desktop_queued', queueTransport: 'desktop', codexQueueId: null, steerRequested: false, windowQueueRequested: false, blocking: true,
        reason: '电脑上这一轮暂时不能插入，已排在这一轮之后' });
      if (!kept) return { accepted: false, missing: true };
      this.emit('steer.deferred', item.threadId, { requestId: item.requestId, reason: kept.reason, item: publicItem(kept) }, deviceId);
      return { accepted: false, deferred: true, item: publicItem(kept) };
    }
    if (result.delivery === 'uncertain') {
      const uncertain = this.followups.update(item.id, { state: 'uncertain', codexQueueId: null, reason: result.code === 'composer_write_unconfirmed' || result.code === 'control_not_found'
        ? '电脑输入框可能留有这条消息，请在电脑检查；系统不会自动重发' : '发送结果尚未确认，正在核对对话；不会自动重发' });
      if (!uncertain) return { accepted: false, missing: true };
      this.emit('followup.failed', item.threadId, { ...publicItem(uncertain), needsConfirmation: true }, deviceId);
      return { accepted: false, uncertain: true, item: publicItem(uncertain) };
    }
    // Not sent: back into the protocol queue, so it still runs after this turn.
    try {
      const queued = await this.enqueueCodexThreadQueue(item);
      this.followups.update(item.id, { codexQueueId: queued?.queuedSubmission?.id || null });
    } catch (error) {
      const uncertain = this.followups.update(item.id, { state: 'uncertain', codexQueueId: null, reason: `消息没能放回电脑队列：${error.message || error}` });
      if (uncertain) this.emit('followup.failed', item.threadId, { ...publicItem(uncertain), needsConfirmation: true }, deviceId);
      return { accepted: false, uncertain: true };
    }
    return this.deferCodexSteer(item, deviceId, steerFailureText(result), { retry: result.code !== 'queue_paused', queueOnly });
  }

  deferCodexSteer(item, deviceId, reason, { retry = true, queueOnly = false } = {}) {
    const unchanged = this.followups.update(item.id, { state: 'desktop_queued', reason, blocking: true,
      steerRequested: retry ? item.steerRequested : false, steerRetryAt: retry ? Date.now() + 3000 : null,
      windowQueueRequested: Boolean(retry && queueOnly),
      steerAttempts: (item.steerAttempts || 0) + 1 });
    if (!unchanged) return { accepted: false, missing: true };
    this.emit('steer.deferred', item.threadId, { requestId: item.requestId, reason, item: publicItem(unchanged) }, deviceId);
    return { accepted: false, deferred: true, item: publicItem(unchanged) };
  }

  async findCodexQueueId(item) {
    let cursor = null;
    do {
      const page = await this.codex.request('thread/queue/list', { threadId: item.threadId, cursor, limit: 100 }, 15_000);
      const found = page.data?.find((row) => row.clientUserMessageId === item.requestId)?.id;
      if (found) return found;
      cursor = page.nextCursor || null;
    } while (cursor);
    return null;
  }

  async steerAllFollowups(threadId, ids, sourceDeviceId) {
    if (!threadId || !Array.isArray(ids) || ids.length === 0) {
      return { accepted: false, acceptedCount: 0, reason: '没有可引导的待发送消息' };
    }
    this.steerAllInFlight ||= new Set();
    if (this.steerAllInFlight.has(threadId)) {
      return { accepted: false, acceptedCount: 0, busy: true, reason: '该任务正在处理批量引导' };
    }
    this.steerAllInFlight.add(threadId);
    try {
      const wanted = new Set(ids.map((id) => String(id)));
      const items = this.followups.items
        .filter((item) => item.threadId === threadId && wanted.has(String(item.id)) &&
          (item.state === 'desktop_queued' || (item.state === 'pending' && item.mode === 'queue' && this.isBridgeOwnedThread(threadId))))
        .sort((a, b) => a.createdAt - b.createdAt);
      const accepted = [];
      for (const item of items) {
        const result = await this.steerFollowup(item.id, sourceDeviceId, threadId);
        if (!result.accepted) break;
        accepted.push(item.requestId);
      }
      return {
        accepted: accepted.length > 0,
        acceptedCount: accepted.length,
        requestIds: accepted,
        remaining: this.followups.list(threadId).filter((item) => wanted.has(String(item.id))),
      };
    } finally {
      this.steerAllInFlight.delete(threadId);
    }
  }

  async retryFollowups() {
    if (this.followupRetryRunning || this.stopping) return;
    this.followupRetryRunning = true;
    try {
      await this.reconcileCodexProtocolFollowups();
      await this.retryPendingDesktopSettings();
      // Only pending items are safe to send again. Uncertain UI dispatches
      // await a history receipt or a deliberate user action.
      for (const item of this.followups.items.filter((value) =>
        value.state === 'pending' && (value.nextRetryAt || 0) <= Date.now())) {
        await this.dispatchFollowup(item);
      }
      for (const item of this.followups.items.filter(value => value.state === 'desktop_queued' &&
        (value.steerRequested || value.windowQueueRequested) && (value.steerRetryAt || 0) <= Date.now() && (value.steerAttempts || 0) < 3)) {
        // Only retry a read-only failed lookup, and only while its exact
        // accepted queue row still exists. Never submit the input again.
        const page = await this.codex.request('thread/queue/list', { threadId: item.threadId, limit: 100 }, 5_000);
        if (page.data?.some(row => row.id === item.codexQueueId && row.clientUserMessageId === item.requestId)) {
          await this.steerFollowup(item.id, item.sourceDeviceId, item.threadId, { retainReceipt: true, queueOnly: Boolean(item.windowQueueRequested && !item.steerRequested) });
        } else this.followups.update(item.id, { steerRequested: false, windowQueueRequested: false });
      }
      if (this.idleHostReleaseRequested && !this.hasActiveMobileWork()) await this.recycleIdleCodexHost();
    } finally { this.followupRetryRunning = false; }
  }

  async steerPendingFollowup(item, sourceDeviceId) {
    return this.withThreadTurnLock(item.threadId, async () => {
      const current = this.followups.get(item.id);
      if (!current || current.state !== 'pending') return { accepted: false, unavailable: true };
      this.followups.update(item.id, { state: 'dispatching', deliveryPhase: 'probe', blocking: true });
      let wrote = false;
      const beforeWrite = () => { this.followups.update(item.id, { deliveryPhase: 'write' }); wrote = true; };
      const args = { requestId: item.requestId, threadId: item.threadId, text: item.displayText || item.text,
        attachments: item.attachments || [], model: item.model || undefined, effort: item.effort || undefined };
      try {
        let result;
        try { result = await this.executeCommand({ action: 'turn.steer', args }, { beforeWrite }); }
        catch (error) {
          if (error.delivery === 'uncertain' || !/No active turn is available|no active turn|not running/i.test(String(error.message))) throw error;
          result = await this.executeCommand({ action: 'turn.start', args }, { beforeWrite });
        }
        this.followups.remove(item.id);
        this.emit('steer.accepted', item.threadId, { requestId: item.requestId, queuedItemId: item.id }, sourceDeviceId || item.sourceDeviceId);
        return { accepted: true, requestId: item.requestId, result };
      } catch (error) {
        const uncertain = wrote && error.delivery === 'uncertain';
        const row = this.followups.update(item.id, { state: uncertain ? 'uncertain' : 'pending', reason: error.message,
          nextRetryAt: uncertain ? null : Date.now() + 2000 });
        this.emit(uncertain ? 'followup.failed' : 'steer.deferred', item.threadId,
          { ...publicItem(row), requestId: item.requestId, item: publicItem(row), needsConfirmation: uncertain }, sourceDeviceId || item.sourceDeviceId);
        return { accepted: false, uncertain, deferred: !uncertain, item: publicItem(row) };
      }
    });
  }

  async reconcileCodexProtocolFollowups() {
    if (this.codex?.mode !== 'host' || !this.codex.ready || !this.codex.request) return;
    const waiting = (this.followups?.items || []).filter((item) => item.state === 'uncertain' || (item.state === 'desktop_queued' && item.queueTransport === 'codex'));
    for (const item of waiting) {
      try {
        const page = await this.codex.request('thread/queue/list', { threadId: item.threadId, limit: 100 }, 5_000);
        const queued = page.data?.find((row) => row.clientUserMessageId === item.requestId);
        // Positive proof of queue acceptance. Absence never allows a resend.
        if (!queued || !this.followups.get(item.id)) continue;
        if (item.state === 'uncertain' || item.blocking === false) {
          this.followups.update(item.id, { state: 'desktop_queued', reason: null, nextRetryAt: null, blocking: true, queueTransport: 'codex', codexQueueId: queued.id,
            codexQueueText: queued.input?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || null });
          this.emit('followup.queued', item.threadId, publicItem(item), item.sourceDeviceId);
        }
        if (!(await this.confirmCodexHostThread(item.threadId))) continue;
        const thread = await this.codex.request('thread/read', { threadId: item.threadId, includeTurns: false }, 5_000);
        if (isDesktopTaskBusy(normalizeThread(thread.thread || thread).status)) continue;
        // Only our own loaded host can start its queue; never acquire another
        // writer for a Desktop thread in order to consume a queued message.
        await this.codex.request('thread/queue/start', { threadId: item.threadId, queuedSubmissionId: queued.id }, 30_000);
        const started = this.followups.update(item.id, { state: 'started', startedAt: Date.now(), reason: null, blocking: false });
        if (started) this.emit('followup.started', item.threadId, publicItem(started), item.sourceDeviceId);
      } catch (error) { this.log(error); }
    }
  }

  // A setting kept for the next turn is applied once that turn has ended (the
  // same test that holds a message back while the turn runs). A transient
  // failure is retried a few times, then reported: every try may bring the
  // Desktop window to the front.
  async retryPendingDesktopSettings() {
    this.threadState ||= new Map();
    for (const [threadId, state] of this.threadState) {
      const pending = state.pendingDesktopSettings;
      if (!pending || (state.pendingDesktopSettingsNextRetryAt || 0) > Date.now()) continue;
      if (this.desktopTurnIsActive(threadId)) continue;
      try {
        await this.applyPendingDesktopSettings({
          threadId,
          title: pending.title || null,
          sourceDeviceId: null,
        });
      } catch (error) {
        const attempts = (state.pendingDesktopSettingsAttempts || 0) + 1;
        const retryable = isDesktopSettingsRetryableError(error) || isBackgroundSettingsRetryableError(error) || isDesktopModeUiRetryableError(error) || isThreadNotFoundError(error);
        if (retryable && attempts < DESKTOP_SETTINGS_MAX_ATTEMPTS) {
          const waiting = {
            ...state,
            modeSyncState: pending.collaborationMode ? 'pending' : state.modeSyncState,
            modeSyncReason: settingsFailureText(error),
            pendingDesktopSettingsAttempts: attempts,
            pendingDesktopSettingsNextRetryAt: Date.now() + 3000,
          };
          this.threadState.set(threadId, waiting);
          continue;
        }
        const reason = settingsFailureText(error);
        const failed = {
          ...state,
          collaborationMode: publicThreadSettings(state).effectiveCollaborationMode,
          desiredCollaborationMode: pending.collaborationMode || publicThreadSettings(state).effectiveCollaborationMode,
          modeSyncState: pending.collaborationMode ? 'failed' : state.modeSyncState,
          modeSyncReason: reason,
          pendingDesktopSettings: null,
          pendingDesktopSettingsNextRetryAt: null,
          pendingDesktopSettingsAttempts: 0,
        };
        this.threadState.set(threadId, failed);
        this.log(`settings for ${threadId} not applied: ${error.message}`);
        this.emit('thread.settings', threadId, {
          threadId,
          settings: publicThreadSettings(failed),
          nextTurn: true,
          applied: false,
          reason,
          updatedAt: Date.now(),
        });
      }
    }
  }

  async afterMobileTurn(threadId) {
    // A light reload loses this set while the persistent host carries on.
    // Its durable PID-bound ownership still proves which writer must release
    // the task when that turn ends.
    if (!this.mobileOwnedThreads.has(threadId) && !this.isCurrentCodexHostOwner(this.threadOwner(threadId))) return;
    this.mobileOwnedThreads.delete(threadId);
    this.idleHostReleaseRequested = true;
    try { await this.codex.request('thread/unsubscribe', { threadId }, 30_000); }
    catch (error) { this.log(error); }
    // Codex keeps an unsubscribed thread loaded for up to 30 minutes. That
    // delayed unload is useful for interactive reconnects, but it leaves the
    // connector's writer lock visible to Codex Desktop after a mobile turn
    // has already completed. Recycle only our isolated host when it is truly
    // idle; the connector/relay stays online and the next command recreates
    // the host transparently.
    try { await this.recycleIdleCodexHost(); }
    catch (error) { this.log(error); }
  }

  hasActiveMobileWork() {
    if (this.mobileOwnedThreads?.size) return true;
    for (const state of this.threadState?.values?.() || []) {
      if (state?.activeTurnId) return true;
    }
    return (this.followups?.items || []).some((item) =>
      item.state === 'dispatching' && item.mode === 'background');
  }

  // The desktop app updates its bundled codex.exe in place (new models such as
  // a new GPT arrive that way). Once idle, move our host onto the same build,
  // so the phone's model list follows the desktop's.
  async followDesktopCodex() {
    if (this.codex?.mode !== 'host' || !this.codex?.ready) return false;
    const { readState, STREAM_VERSION } = require('./codex-host');
    const { findCodexBinary } = require('./codex-client');
    const hostState = readState(this.config);
    const running = hostState?.bin || null;
    const wanted = findCodexBinary(this.config.codexBin);
    const streamCurrent = hostState?.streamVersion === STREAM_VERSION;
    if (streamCurrent && running && path.resolve(running).toLowerCase() === path.resolve(wanted).toLowerCase()) return false;
    if (this.hasActiveMobileWork()) return false;
    this.log(streamCurrent ? `codex host moves to the desktop's build: ${wanted}` : 'codex host stream update scheduled once its actual loaded tasks are idle');
    this.defaultModelId = null;
    return this.recycleIdleCodexHost();
  }

  // Pin or unpin a task in the Codex desktop sidebar (its pins live only in
  // the desktop app). The row is found by title, so the title must be unique
  // among recent tasks; done only once the desktop has saved the change.
  async pinCodexOnDesktop(threadId, pinned) {
    const isPinned = () => Boolean(readDesktopPinState(this.desktopStateFile)?.ids?.includes(threadId));
    if (isPinned() === pinned) return { pinned, changed: false };
    const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000);
    const title = normalizeThread(detail.thread || detail).title;
    const recent = await this.codex.request('thread/list', { limit: 100, archived: false }, 30_000).catch(() => null);
    const rows = recent?.data || recent?.threads || [];
    if (rows.filter((row) => row?.id !== threadId && normalizeThread(row).title === title).length) throw sidebarError('ambiguous_title');
    const result = await runSidebarScript({ app: 'codex', action: pinned ? 'pin' : 'unpin', title, execFileFn: this.execFileFn });
    if (!result.ok) throw sidebarError(result.reason);
    if (!(await waitUntil(() => isPinned() === pinned))) throw sidebarError('not_applied');
    // The phone learns the new pins from the next activity scan (every 2 s).
    return { pinned, changed: true };
  }

  // Rename a task: through the Codex desktop's own rename (the running app does
  // not pick up a name written by another app-server), then in ours so the
  // phone's list has it at once. Without the desktop app, ours alone.
  async renameCodexOnDesktop(threadId, name) {
    const wanted = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!wanted) throw new Error('名字不能为空');
    const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000);
    const title = normalizeThread(detail.thread || detail).title;
    const result = await runSidebarScript({ app: 'codex', action: 'rename', title, name: wanted, threadId, execFileFn: this.execFileFn });
    if (!result.ok && result.reason !== 'desktop_not_running') throw sidebarError(result.reason);
    try { await this.codex.request('thread/name/set', { threadId, name: wanted }); }
    catch (error) {
      // The desktop holds the task and has already saved the new name itself.
      if (!result.ok || !isDesktopWriterBusyError(error)) throw isDesktopWriterBusyError(error) ? new Error('这个任务正在电脑端 Codex 里打开，请在电脑上改名。') : error;
    }
    await this.refreshCodexThreadIndex(threadId);
    return { renamed: true, desktop: Boolean(result.ok) };
  }

  async recycleIdleCodexHost() {
    if (this.idleHostRecyclePromise) return this.idleHostRecyclePromise;
    this.idleHostRecyclePromise = (async () => {
      // Let the completed-turn notification and its durable reconciliation
      // settle before deciding whether another mobile turn is still active.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.hasActiveMobileWork()) return false;
      if (this.codex?.mode !== 'host' || !this.codex?.ready || typeof this.codex?.restart !== 'function') return false;
      if (await this.codexHostHasActiveWork()) return false;
      // History/settings RPCs may still be finishing after turn/completed.
      // Let them drain instead of failing the phone's reads on host shutdown.
      const deadline = Date.now() + 2_000;
      while (this.codex.pending?.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.hasActiveMobileWork() || this.stopping) return false;
      if (this.codex.pending?.size) {
        if (!this.idleHostRecycleTimer) this.idleHostRecycleTimer = setTimeout(() => {
          this.idleHostRecycleTimer = null;
          if (!this.stopping) this.recycleIdleCodexHost().catch((error) => this.log(error));
        }, 1_000).unref?.();
        return false;
      }
      const previousHostPid = this.codex.host?.state?.pid;
      await this.codex.restart();
      // The advisory lease must not outlive the actual writer: otherwise a
      // send immediately after release would reclaim a Desktop task before
      // its two-minute lease had expired.
      if (previousHostPid) for (const record of this.threadOwnership?.list?.() || []) {
        if (record.owner === 'khlink' && Number(record.hostPid) === Number(previousHostPid)) {
          this.releaseThreadOwner(record.threadId, '当前轮已结束，后台写入进程已释放');
        }
      }
      this.idleHostReleaseRequested = false;
      this.codexLastError = null;
      this.codexRecoveryAttempts = 0;
      this.writeStatus(this.ws?.readyState === WebSocket.OPEN, 'running');
      return true;
    })();
    try { return await this.idleHostRecyclePromise; }
    finally { this.idleHostRecyclePromise = null; }
  }

  async executeCommand(payload, { beforeWrite = () => {} } = {}) {
    const args = payload.args || {}; const action = payload.action;
    if (action === 'accounts.read' || action === 'accounts.switch') {
      if (args.backend === 'claude' && !CLAUDE_ACCOUNT_SWITCH_ENABLED) {
        if (action === 'accounts.switch') throw Object.assign(new Error('Claude 账号切换功能已暂时关闭'), { code: 'account_switch_disabled' });
        return { backend: 'claude', snapshotAt: Date.now(), configured: false, readonly: false, switching: false, profiles: [], lastSwitch: null, disabled: true };
      }
      this.agentAccounts ||= new (require('./agent-accounts').AgentAccounts)(this);
      if (action === 'accounts.read') return this.agentAccounts.state(args.backend);
      return this.agentAccounts.switch(args);
    }
    // Per-backend capability map so the phone can gate UI (P5/P6).
    if (action === 'claude.usage') return this.claudeUsageState();
    if (action === 'claude.usage.refresh') return this.refreshClaudeUsage();
    if (action === 'claude.statusline.set') {
      if (!this.claudeStatusline) throw new Error('电脑上的连接器还不支持终端实时额度');
      this.claudeStatusline.set(Boolean(args?.enabled));
      this._claudeUsageKey = null;
      return this.claudeUsageState();
    }
    if (action === 'claude.image') return this.claudeTranscriptImage(args);
    // Light mode is the account's, sent to every connector; details are the
    // full rows of placeholders this computer uploaded.
    if (action === 'connector.lightMode') {
      const before = this.lightMode.enabled();
      if (typeof args.enabled === 'boolean' && this.lightMode.set(args.enabled, Number(args.changedAt) || Date.now()) && before !== args.enabled) {
        this.log(`light mode ${args.enabled ? 'on' : 'off'}`);
        if (this.isConnected?.()) this.publishPresence({ full: true });
      }
      return { enabled: this.lightMode.enabled(), changedAt: this.lightMode.changedAt() };
    }
    if (action === 'history.details') {
      const ids = (Array.isArray(args.ids) ? args.ids : []).filter((id) => typeof id === 'string').slice(0, 200);
      const result = { threadId: args.threadId, items: await this.lightMode.details(args.threadId, ids) };
      // Old phones request whole rows. Refuse oversized replies rather than
      // disconnecting the shared relay socket with websocket close 1009.
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LEGACY_DETAIL_JSON_BYTES) throw new Error('详细过程较大，请更新手机端后再取回');
      return result;
    }
    if (action === 'file.historyDetailPart') {
      this.lightDetailTransfers ||= new LightDetailTransfers((threadId, ids) => this.lightMode.details(threadId, ids));
      try { return await this.lightDetailTransfers.read(args); }
      catch (error) {
        // New phones can poll the bounded scan without treating a deadline as
        // a missing row. Older phones retain the explicit retry message.
        if (error.code === 'LIGHT_DETAILS_RETRY' && args.resumeSearch === true) return { id: args.id, found: false, pending: true };
        throw error;
      }
    }
    // These are connector-owned operations for every backend. They must not
    // wait for, or attempt to restart, an unrelated Codex app-server.
    if (action === 'file.list') return files.list(args.path, Number(args.cursor) || 0, Math.min(args.limit || 100, 200));
    if (action === 'file.read') return this.readFile(args);
    if (action === 'file.upload.begin') return this.beginUpload(args);
    if (action === 'file.upload.chunk') return this.writeUpload(args);
    if (action === 'file.upload.finish') return this.finishUpload(args);
    if (action === 'file.upload.abort') return this.abortUpload(args);
    if (action === 'backends.capabilities') {
      const backends = {};
      for (const [id, backend] of this.backends) backends[id] = { displayName: backend.displayName, capabilities: id === 'claude' && typeof this.claudeCapabilities === 'function' ? this.claudeCapabilities(backend.capabilities()) : backend.capabilities() };
      return { backends, default: this.defaultBackendId };
    }
    // Route Claude-backed threads (or an explicit Claude creation) to the Claude
    // handler. Everything below is the unchanged Codex path.
    const backendId = args.backend || (args.threadId ? this.threadBackendId(args.threadId) : this.defaultBackendId);
    // File browsing and phone uploads are the connector's own, whatever agent
    // the thread runs on.
    if (backendId === 'claude' && !action.startsWith('file.')) { this.wireClaudeBackend(); return this.executeClaudeCommand(action, args); }
    if (this.idleHostRecyclePromise) await this.idleHostRecyclePromise;
    // Without Codex the Codex tab is simply empty; anything else Codex would
    // do gets a plain answer instead of a recovery attempt.
    if (this.codexMissing && action !== 'capabilities') {
      if (action === 'thread.list') return { data: [], nextCursor: null };
      throw Object.assign(new Error('这台电脑没有安装 Codex。装好 Codex 后 khLink 会自动接上。'), { code: 'CODEX_NOT_INSTALLED', delivery: 'not_sent' });
    }
    // Unit-test doubles and older connector integrations may not expose the
    // CodexClient readiness/restart surface. Only enter recovery when the
    // real client explicitly reports a dead app-server and can restart it.
    if (action !== 'capabilities' && this.codex?.ready === false && typeof this.codex.restart === 'function') {
      await this.recoverCodex({ reason: 'command_requires_codex' });
      if (this.codex?.ready === false) throw new Error('Codex app-server 正在恢复，请稍后重试');
    }
    if (action === 'capabilities') {
      // Sent by a phone that just connected or switched to this computer:
      // give it the whole presence on the next tick.
      this.presenceFullDue = true;
      const read = (method) => this.codex.request(method, {}).catch((error) => ({ error: error.message || String(error) }));
      return Promise.all([read('model/list'), this.readCodexUsage(),
        { codexVersion: this.codex.version, dangerousOperationsEnabled: this.codex.dangerousOperationsEnabled, sandboxShellBlocked: codexSandboxShellBlocked(), accounts: 'accounts.v1' },
        read('collaborationMode/list')]);
    }
    if (action === 'thread.settings.read') {
      // The rollout is the durable source of truth for the effective model
      // and reasoning effort.  `threadState` is an in-memory projection and
      // can legitimately lag behind it (for example after a desktop restart
      // or while a settings notification is being replayed).  Previously we
      // spread the cache last, allowing an old low/high effort value to
      // overwrite the newer rollout value and making the phone label appear
      // to flip between strengths.  Keep cached fields only as fallbacks for
      // values that are genuinely absent from the durable record.
      const latest = this.readThreadSettings(args.threadId) || {};
      const cached = this.threadState.get(args.threadId) || {};
      const merged = { ...cached };
      for (const [key, value] of Object.entries(latest)) {
        if (value !== null && value !== undefined && value !== '') merged[key] = value;
      }
      return publicThreadSettings(merged);
    }
    if (action === 'thread.list') return this.codex.request('thread/list', { limit: Math.min(args.limit || 30, 100), cursor: args.cursor || null, archived: args.archived || false });
    if (action === 'thread.read') return this.readRecentCodexThread(args.threadId);
    if (action === 'history.sync') return this.requestHistoryBackfill(args.threadId);
    if (action === 'thread.new') {
      const started = await this.codex.request('thread/start', await this.threadParams(args));
      const threadId = started?.thread?.id || started?.id || started?.threadId;
      if (threadId) this.claimBridgeThread(threadId, { source: 'mobile_new' });
      return started;
    }
    if (action === 'thread.newWithTurn') {
      const model = args.model || await this.resolveDefaultModel();
      const started = await this.codex.request('thread/start', await this.threadParams({ ...args, model }));
      const threadId = started.thread?.id || started.id;
      if (!threadId) throw new Error('Codex did not return a thread id');
      this.threadState.set(threadId, { model, effort: args.effort, serviceTier: args.serviceTier,
        permissionMode: args.permissionMode || args.mode || 'manual', collaborationMode: args.collaborationMode || 'default' });
      const turn = await this.startTurn({ ...args, model, threadId });
      return { threadId, turn };
    }
    if (action === 'thread.resume') {
      try {
        const resumed = await this.codex.request('thread/resume', { threadId: args.threadId, ...await this.threadParams(args), excludeTurns: true });
        this.claimBridgeThread(args.threadId, { source: 'mobile_resume' });
        return resumed;
      } catch (error) {
        if (isDesktopWriterBusyError(error)) this.markDesktopThread(args.threadId, error.message || 'Codex Desktop 持有当前任务写入权');
        throw error;
      }
    }
    if (action === 'thread.ownership.read') return this.threadOwner(args.threadId) || {
      threadId: args.threadId,
      owner: 'unknown',
      mode: 'unknown',
      stateVersion: 0,
      updatedAt: 0,
    };
    if (action === 'thread.ownership.claim') {
      if (!args.threadId) throw new Error('缺少任务 ID');
      const currentOwner = this.threadOwner(args.threadId)?.owner;
      if (currentOwner === 'desktop' && isDesktopTaskBusy(this.desktopStatuses?.get(args.threadId))) {
        throw new Error('Codex Desktop 正在使用此任务，请先完全退出或等待任务结束');
      }
      if (this.desktopAdapter?.probe) {
        const probe = await this.desktopAdapter.probe(args.threadId, args.title || null);
        if (probe?.code === 'task_active') {
          this.markDesktopThread(args.threadId, 'Codex Desktop 持有当前任务写入权');
          throw new Error('Codex Desktop 正在使用此任务，请先完全退出或等待任务结束');
        }
      }
      return this.claimBridgeThread(args.threadId, { source: 'mobile_claim' });
    }
    if (action === 'thread.ownership.release') {
      if (!args.threadId) throw new Error('缺少任务 ID');
      if (this.threadState.get(args.threadId)?.activeTurnId) throw new Error('当前任务仍在运行，不能释放 khLink 管理权');
      // Unsubscribe before releasing the advisory ownership record. This
      // gives the isolated app-server a chance to drop its in-memory writer
      // for a later Desktop takeover. Failure is non-fatal: the persisted
      // owner is still changed to `unknown`, and the native writer lock
      // remains the final safety boundary.
      try { await this.codex?.request?.('thread/unsubscribe', { threadId: args.threadId }, 15_000); } catch (error) { this.log?.(error); }
      return this.releaseThreadOwner(args.threadId, '用户主动释放 khLink 管理权');
    }
    if (action === 'turn.start') return this.startTurn(args, beforeWrite);
    if (action === 'turn.steer') {
      const expectedTurnId = await this.activeTurnId(args.threadId, args.turnId);
      const input = codexInput(args.text, this.resolveAttachments(args.threadId, args.attachments), args.requestId);
      beforeWrite();
      return this.codex.request('turn/steer', { threadId: args.threadId, input, expectedTurnId,
        ...(args.requestId ? { clientUserMessageId: args.requestId } : {}) });
    }
    if (action === 'turn.stop') {
      // A turn Codex Desktop runs lives in its own app-server: stop it with
      // the Desktop window's Stop button. Our own turns stop over the protocol.
      const desktopTurn = !this.isBridgeOwnedThread(args.threadId) &&
        (this.threadOwner?.(args.threadId)?.owner === 'desktop' ||
          /^desktop_/i.test(String(this.desktopStatuses?.get(args.threadId) || '')));
      const stopOnDesktop = () => this.desktopAdapter.interrupt({ threadId: args.threadId, title: args.title || this.desktopTitles?.get(args.threadId) || null });
      if (desktopTurn && this.desktopAdapter?.interrupt) return stopOnDesktop();
      try {
        return await this.codex.request('turn/interrupt', { threadId: args.threadId, turnId: await this.activeTurnId(args.threadId, args.turnId) });
      } catch (error) {
        if (this.desktopAdapter?.interrupt) return stopOnDesktop();
        throw error;
      }
    }
    if (action === 'thread.compact') {
      const threadId = args.threadId;
      if (!threadId) throw new Error('缺少任务 ID');
      // Announced only once Codex has taken it: a refused request (Codex Desktop
      // holds the task) never began, so it must not leave the task marked failed.
      let result;
      try { result = await this.codex.request('thread/compact/start', { threadId }); }
      catch (error) {
        if (isDesktopWriterBusyError(error)) throw new Error('这个任务正在电脑端 Codex 里打开，请在电脑上整理上下文。');
        throw error;
      }
      this.emit('context.compaction', threadId, { threadId, status: 'started', updatedAt: Date.now() });
      return result;
    }
    if (action === 'thread.fork') return this.codex.request('thread/fork', { threadId: args.threadId });
    if (action === 'thread.rollback') return this.codex.request('thread/rollback', { threadId: args.threadId, numTurns: args.numTurns || 1 });
    if (action === 'thread.rename') return this.renameCodexOnDesktop(args.threadId, args.name);
    if (action === 'thread.pin') return this.pinCodexOnDesktop(args.threadId, Boolean(args.pinned));
    if (action === 'thread.archive') {
      let result;
      try { result = await this.codex.request(args.archived ? 'thread/archive' : 'thread/unarchive', { threadId: args.threadId }); }
      catch (error) {
        // Codex Desktop holds the task. Its sidebar archive button belongs to
        // whichever row is hovered, not reliably this task, so never click it.
        if (isDesktopWriterBusyError(error)) throw new Error('这个任务正在电脑端 Codex 里打开，请在电脑上归档。');
        throw error;
      }
      await this.refreshCodexThreadIndex(args.threadId, Boolean(args.archived));
      return result;
    }
    if (action === 'settings.set') {
      // After a restart the in-memory settings are empty; start from what the
      // task last ran with, or unchanged fields (the model) would read as "默认".
      if (!this.threadState.get(args.threadId)?.model) {
        let saved = null; try { saved = this.readThreadSettings(args.threadId); } catch { /* none */ }
        if (saved) {
          const restored = {};
          for (const key of ['permissionMode', 'model', 'effort', 'serviceTier']) if (saved[key]) restored[key] = saved[key];
          this.threadState.set(args.threadId, { ...restored, ...(this.threadState.get(args.threadId) || {}) });
        }
      }
      const current = this.threadState.get(args.threadId) || {};
      // A task the connector runs takes its settings with every turn/start, so
      // when Codex Desktop holds the task's write lock (it may load a task it
      // shows) the change is simply kept for the next turn, not queued.
      const nextTurnOnly = (error) => this.connectorRunsThread(args.threadId) && isDesktopWriterBusyError(error);
      const currentPublic = publicThreadSettings(current);
      const changedSettings = { ...(args.settings || {}) };
      if (!changedSettings.model && current.model) changedSettings.model = current.model;
      const next = { ...current, ...changedSettings };
      const title = args.title || args.threadTitle || null;
      const desktopServiceTier = Object.prototype.hasOwnProperty.call(args.settings || {}, 'serviceTier')
        ? args.settings.serviceTier ?? 'default'
        : undefined;
      const desktopRequest = {
        threadId: args.threadId,
        title,
        // The background protocol may require the current model even when it
        // was not changed. Do not send that fallback to Desktop UI controls.
        model: args.settings?.model || undefined,
        effort: changedSettings.effort,
        serviceTier: desktopServiceTier,
        permissionMode: changedSettings.permissionMode,
        collaborationMode: changedSettings.collaborationMode,
      };
      const queueForNextDesktopTurn = (reason) => {
        return this.queuePendingSettings({ ...args, settings: desktopRequest }, reason);
      };
      // A Desktop task that is running takes the change with its next turn, as a
      // message sent while it runs does: its settings controls cannot be used
      // mid-turn. A task the connector runs itself is not affected.
      if (!this.connectorRunsThread(args.threadId) && this.desktopTurnIsActive(args.threadId)) {
        return queueForNextDesktopTurn('电脑上正在运行，下一轮开始时切换');
      }
      // Codex requires collaborationMode.settings.model even when the phone
      // displays “默认”. Resolve the account default for this protocol-only
      // update, while keeping the user's explicit model selection untouched.
      let update;
      try {
        update = await this.buildThreadSettingsUpdate(args.threadId, next, changedSettings);
      } catch (error) {
        if (desktopRequest.collaborationMode && (isDesktopWriterBusyError(error) || isBackgroundSettingsRetryableError(error))) {
          return queueForNextDesktopTurn('连接器正在恢复，模式将在后台自动同步');
        }
        throw error;
      }
      let result;
      if (desktopRequest.collaborationMode) {
        try {
          result = await this.applyCollaborationModeSettings(desktopRequest, update, args.threadId);
        } catch (protocolError) {
          if (nextTurnOnly(protocolError)) result = { modeSyncSource: 'next_turn' };
          // Keep the desired mode durable and retry through the same Desktop
          // owner. Never fall back to a second protocol writer after a UI
          // control/identity conflict.
          else if (isDesktopWriterBusyError(protocolError) || isBackgroundSettingsRetryableError(protocolError) || isDesktopModeUiRetryableError(protocolError)) {
            this.log(`settings for ${args.threadId} queued: ${protocolError.message}`);
            return queueForNextDesktopTurn('桌面端当前任务暂时无法切换，计划模式已保留并将自动重试');
          } else {
          const failedState = {
            ...current,
            desiredCollaborationMode: desktopRequest.collaborationMode,
            effectiveCollaborationMode: currentPublic.effectiveCollaborationMode,
            collaborationMode: currentPublic.effectiveCollaborationMode,
            modeSyncState: 'failed',
            modeSyncReason: settingsFailureText(protocolError),
          };
          this.threadState.set(args.threadId, failedState);
          this.emit('thread.settings', args.threadId, {
            threadId: args.threadId,
            settings: publicThreadSettings(failedState),
            nextTurn: true,
            reason: settingsFailureText(protocolError),
            updatedAt: Date.now(),
          });
          throw protocolError;
          }
        }
      } else if (title && !this.connectorRunsThread(args.threadId)) {
        try {
          // Existing Desktop tasks must be changed through the same visible
          // controls that own the task. This also makes unsupported modes
          // fail explicitly instead of being silently accepted by a second
          // protocol writer.
          result = await this.desktopAdapter.settings(desktopRequest);
        } catch (adapterError) {
          if (!desktopRequest.collaborationMode) {
            if (isDesktopWriterBusyError(adapterError)) return queueForNextDesktopTurn();
            try {
              result = await this.codex.request('thread/settings/update', update, 30_000);
            } catch (protocolError) {
              if (isDesktopWriterBusyError(protocolError)) return queueForNextDesktopTurn();
              throw protocolError;
            }
          }
        }
      } else {
        try {
          result = await this.codex.request('thread/settings/update', update, 30_000);
        } catch (protocolError) {
          if (nextTurnOnly(protocolError)) result = { modeSyncSource: 'next_turn' };
          else if (isDesktopWriterBusyError(protocolError)) return queueForNextDesktopTurn();
          else throw protocolError;
        }
      }
      const confirmedMode = result?.effectiveCollaborationMode || desktopRequest.collaborationMode || currentPublic.effectiveCollaborationMode;
      const confirmedState = {
        ...next,
        collaborationMode: confirmedMode,
        effectiveCollaborationMode: confirmedMode,
        desiredCollaborationMode: desktopRequest.collaborationMode || confirmedMode,
        modeSyncSource: desktopRequest.collaborationMode ? (result?.modeSyncSource || 'protocol') : current.modeSyncSource,
        modeSyncState: desktopRequest.collaborationMode ? (result?.modeSyncState || 'applied') : currentPublic.modeSyncState,
        modeSyncReason: null,
        pendingDesktopSettings: null,
        pendingDesktopSettingsNextRetryAt: null,
      };
      this.threadState.set(args.threadId, confirmedState);
      const effective = publicThreadSettings({ ...confirmedState, ...update, nextTurn: true });
      this.emit('thread.settings', args.threadId, { threadId: args.threadId, settings: effective, nextTurn: true, updatedAt: Date.now() });
      return { ...effective, applied: true, nextTurn: true, result };
    }
    throw new Error(`Unsupported action: ${action}`);
  }

  async threadParams(args) {
    const mode = args.permissionMode || args.mode || 'manual';
    const model = args.model || await this.resolveDefaultModel();
    return { cwd: args.cwd || this.config.workspace, model, effort: args.effort || null,
      // Same mapping as startTurn: "帮我批准" (auto) asks only when needed.
      serviceTier: args.serviceTier || null, approvalPolicy: mode === 'yolo' ? 'never' : mode === 'auto' ? 'on-request' : 'untrusted',
      sandbox: mode === 'yolo' ? 'danger-full-access' : 'workspace-write',
      ...(args.collaborationMode ? { collaborationMode: { mode: args.collaborationMode === 'plan' ? 'plan' : 'default', settings: modeSettings(model, args.effort) } } : {}) };
  }

  async resolveDefaultModel() {
    if (this.defaultModelId) return this.defaultModelId;
    const result = await this.codex.request('model/list', {});
    const rows = result?.data || result?.models || [];
    const selected = rows.find((row) => row?.isDefault && (row.id || row.model)) || rows.find((row) => row?.id || row?.model);
    const model = selected?.id || selected?.model;
    if (!model) throw new Error('无法确认当前账号可用的默认模型，已取消新建任务');
    this.defaultModelId = String(model);
    return this.defaultModelId;
  }

  async startTurn(args, beforeWrite = () => {}) {
    let state = this.threadState.get(args.threadId) || {};
    // threadState lives in memory: after a connector restart it is empty, and
    // the permissions below would then quietly turn a full-access task into
    // "请求批准" (and a chosen model into the default). The rollout keeps what
    // the task last ran with; start from that.
    if (!state.permissionMode && !state.mode) {
      let saved = null; try { saved = this.readThreadSettings?.(args.threadId); } catch { /* no rollout yet */ }
      if (saved) {
        const restored = {};
        for (const key of ['permissionMode', 'model', 'effort', 'serviceTier']) if (saved[key] && state[key] == null) restored[key] = saved[key];
        state = { ...state, ...restored };
        this.threadState.set(args.threadId, state);
      }
    }
    const mode = state.permissionMode || state.mode || 'manual';
    if (mode === 'yolo' && !this.codex.dangerousOperationsEnabled) throw new Error('Codex protocol compatibility is unknown; YOLO is disabled');
    const permissions = mode === 'yolo'
      ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
      : { approvalPolicy: mode === 'auto' ? 'on-request' : 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
          ...(mode === 'auto' ? { approvalsReviewer: 'auto_review' } : {}) };
    const model = state.model || args.model || await this.resolveDefaultModel();
    const input = codexInput(args.text, this.resolveAttachments(args.threadId, args.attachments), args.requestId);
    beforeWrite();
    const result = await this.codex.request('turn/start', { threadId: args.threadId, input,
      // cwd overrides the thread's own directory for this and later turns, so
      // it is only sent when the phone asked for one.
      ...(args.cwd ? { cwd: args.cwd } : {}), model,
      effort: state.effort || args.effort || null, serviceTier: state.serviceTier || args.serviceTier || null,
      ...(state.collaborationMode ? { collaborationMode: { mode: state.collaborationMode === 'plan' ? 'plan' : 'default', settings: modeSettings(model, state.effort || args.effort) } } : {}),
      ...permissions }, 45_000);
    const activeTurnId = result.turn?.id || result.id;
    if (activeTurnId) {
      this.threadState.set(args.threadId, { ...state, activeTurnId });
      this.mobileOwnedThreads.add(args.threadId);
      this.claimBridgeThread(args.threadId, { source: 'mobile_turn' });
    }
    return result;
  }

  async activeTurnId(threadId, supplied) {
    if (supplied) return supplied;
    const cached = this.threadState.get(threadId)?.activeTurnId;
    if (cached) return cached;
    // Only the newest turn's ID/status is needed. Full history can contain
    // gigabytes of embedded images and must never precede a send/interrupt.
    let turns;
    try {
      const page = await this.codex.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, 15_000);
      turns = page.data || [];
    } catch (error) {
      if (!/unknown method|method not found|unsupported/i.test(String(error.message))) throw error;
      const file = this.rolloutFilesByThread?.get(threadId) || localCodexThread(threadId).path;
      const evidence = readRolloutEvidence(file, 16 * 1024 * 1024);
      const id = evidence?.statusTurnId || evidence?.turnStartTurnId;
      turns = evidence?.status === 'running' && id ? [{ id, status: 'inProgress' }] : [];
    }
    const active = turns.find((turn) => /progress|running|active/i.test(String(turn.status?.type || turn.status || '')));
    if (!active?.id) throw new Error('No active turn is available for this task');
    this.threadState.set(threadId, { ...(this.threadState.get(threadId) || {}), activeTurnId: active.id });
    return active.id;
  }

  async readRecentCodexThread(threadId) {
    const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000);
    const page = await this.codex.request('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'summary' }, 30_000);
    const thread = detail.thread || detail;
    return { ...detail, thread: { ...thread, turns: [...(page.data || [])].reverse() }, nextCursor: page.nextCursor || null };
  }

  readThreadSettings(threadId) {
    if (!threadId) return null;
    const mapped = this.rolloutFilesByThread?.get(threadId);
    if (mapped) {
      const settings = readLatestThreadSettings(mapped);
      if (settings) return settings;
    }
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const root = path.join(codexHome, 'sessions');
    for (const file of recentRolloutFiles(root, 100)) {
      if (sessionThreadId(file) !== threadId) continue;
      const settings = readLatestThreadSettings(file);
      if (settings) return settings;
    }
    const cached = this.threadState.get(threadId);
    return cached ? publicThreadSettings(cached) : null;
  }

  onApproval(message) {
    const threadId = message.params?.threadId || null;
    const request = describeApproval(message.method, message.params, this.codexItems?.get(String(message.params?.itemId)));
    if (threadId && request.blocking !== false) this.publishThreadStatus(threadId, 'mobile_waiting_input');
    if (request.kind === 'user_input') this.log(`Codex input transport=connector rpc=${String(message.id)} blocking=${request.blocking !== false} questions=${request.questions.length}`);
    this.emit('approval.request', threadId, {
      rpcId: String(message.id),
      method: message.method,
      // Raw params stay in the connector; mobile receives a stable public shape.
      params: message.params,
      request,
      // Pending requests are cleared by serverRequest/resolved. A local
      // ten-minute timer must not invalidate a genuinely blocking question.
      expiresAt: 0,
    });
  }

  resolveApproval(payload) {
    // Claude approvals/questions are keyed by threadId + requestId, not a Codex rpcId.
    if (payload.backend === 'claude' || (payload.threadId && this.threadBackendId(payload.threadId) === 'claude')) {
      if (payload.answers || payload.semanticAnswer) return this.claude.answerQuestion(payload.threadId, payload.requestId, payload.answers || payload.semanticAnswer);
      return this.claude.resolveApproval(payload.threadId, payload.requestId, payload.decision === 'accept' || payload.decision === 'allow' || payload.approved === true);
    }
    const pending = this.codex.serverRequests.get(String(payload.rpcId));
    // An answer the app-server is no longer waiting for (answered elsewhere, turn over) is dropped; say so.
    if (!pending) {
      this.log(`approval ${payload.rpcId} (${payload.decision || 'answer'}) has no pending request`);
      this.emit('approval.result', payload.threadId || null, { rpcId: String(payload.rpcId), accepted: false, expired: true, message: '这个请求已结束或已由其他设备处理，请刷新对话。' });
      return;
    }
    const threadId = pending.params?.threadId || null;
    if (payload.threadId && threadId && payload.threadId !== threadId) {
      this.emit('approval.result', payload.threadId, { rpcId: String(payload.rpcId), accepted: false, message: '问题所属对话不一致，未提交回答。' });
      return;
    }
    if (payload.semanticAnswer) {
      this.codex.respond(pending.id, semanticAnswerResult(pending, payload.semanticAnswer));
      if (threadId) this.publishThreadStatus(threadId, 'mobile_running');
      return;
    }
    if (payload.result) {
      this.codex.respond(pending.id, payload.result);
      if (threadId) this.publishThreadStatus(threadId, 'mobile_running');
      return;
    }
    const session = payload.decision === 'acceptForSession';
    const accept = payload.decision === 'accept' || session; let result;
    if (pending.method === 'item/permissions/requestApproval') result = accept ? { permissions: pending.params?.permissions || {}, scope: 'session' } : { permissions: {}, scope: 'turn' };
    else if (pending.method === 'applyPatchApproval' || pending.method === 'execCommandApproval') result = { decision: accept ? (session ? 'approved_for_session' : 'approved') : 'denied' };
    // Declining a question means answering nothing, not an approval decision.
    else if (pending.method === 'item/tool/requestUserInput' || Array.isArray(pending.params?.questions)) result = { answers: {} };
    else result = { decision: accept ? (session ? 'acceptForSession' : 'accept') : 'decline' };
    console.log(`[fengzhu-connect] approval ${pending.method} -> ${JSON.stringify(result).slice(0, 120)}`);
    this.codex.respond(pending.id, result);
    if (threadId) this.publishThreadStatus(threadId, 'mobile_running');
  }

  readFile(args) {
    const target = files.assertReadable(files.validateLocalPath(args.path)); const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('Not a file');
    const offset = Math.max(0, Number(args.offset) || 0); const size = Math.min(512 * 1024, Number(args.size) || 512 * 1024);
    const fd = fs.openSync(target, 'r'); const buffer = Buffer.alloc(Math.min(size, Math.max(0, stat.size - offset)));
    try { fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
    const result = { path: target, offset, total: stat.size, eof: offset + buffer.length >= stat.size };
    // A phone that asks for binary gets the bytes beside the JSON (see encryptBlob); older phones get base64 data.
    if (args.binary) return { ...result, size: buffer.length, [FILE_BLOB]: buffer };
    return { ...result, data: buffer.toString('base64') };
  }

  uploadRoot(threadId) {
    const safeThread = String(threadId || 'unassigned').replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(os.tmpdir(), 'FengzhuAgentBridge', 'uploads', safeThread);
  }

  beginUpload(args) {
    if (!args.threadId || !args.name) throw new Error('threadId and file name are required');
    const name = path.basename(String(args.name));
    if (!name || name === '.' || name === '..') throw new Error('Invalid file name');
    const requestedId = args.uploadId ? String(args.uploadId) : '';
    if (requestedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)) {
      throw new Error('Invalid upload id');
    }
    const uploadId = requestedId || crypto.randomUUID();
    if (this.uploads.has(uploadId)) throw new Error('Upload already exists');
    const dir = this.uploadRoot(args.threadId);
    fs.mkdirSync(dir, { recursive: true }); const target = path.join(dir, `${uploadId}-${name}`);
    const fd = fs.openSync(target, 'wx'); this.uploads.set(uploadId, {
      fd, target, offset: 0, threadId: args.threadId, name, mimeType: args.mimeType ? String(args.mimeType) : null,
      createdAt: Date.now(),
    });
    return { uploadId, chunkSize: 512 * 1024, expiresAt: Date.now() + 24 * 60 * 60_000 };
  }

  writeUpload(args) {
    const item = this.uploads.get(args.uploadId); if (!item) throw new Error('Upload expired or unknown');
    const data = Buffer.from(args.data || '', 'base64');
    if (!data.length || data.length > 512 * 1024) throw new Error('Invalid upload chunk');
    const offset = Number(args.offset); if (offset !== item.offset) throw new Error(`Expected offset ${item.offset}`);
    fs.writeSync(item.fd, data, 0, data.length, item.offset); item.offset += data.length;
    return { uploadId: args.uploadId, offset: item.offset };
  }

  finishUpload(args) {
    const item = this.uploads.get(args.uploadId); if (!item) throw new Error('Upload expired or unknown');
    fs.closeSync(item.fd); this.uploads.delete(args.uploadId);
    if (item.offset <= 0) {
      try { fs.unlinkSync(item.target); } catch {}
      throw new Error('Uploaded file is empty');
    }
    const expiresAt = Date.now() + 24 * 60 * 60_000;
    const attachment = this.attachmentStore?.register({
      id: args.uploadId, threadId: item.threadId, name: item.name, path: item.target,
      size: item.offset, mimeType: item.mimeType, expiresAt,
    });
    if (args.omitLocalPath === true && attachment?.id !== args.uploadId) {
      try { fs.unlinkSync(item.target); } catch { /* cleanup will retry */ }
      throw new Error('电脑无法安全登记附件，请稍后重试');
    }
    return { uploadId: args.uploadId, attachmentId: attachment?.id || args.uploadId,
      ...(args.omitLocalPath === true ? {} : { path: item.target }), size: item.offset, expiresAt };
  }

  abortUpload(args) {
    const item = this.uploads.get(args.uploadId);
    if (!item) return { uploadId: args.uploadId, aborted: false };
    try { fs.closeSync(item.fd); } catch {}
    this.uploads.delete(args.uploadId);
    try { fs.unlinkSync(item.target); } catch {}
    return { uploadId: args.uploadId, aborted: true };
  }

  resolveAttachments(threadId, value) {
    return normalizeAttachments(value).map((item) => {
      if (!item.attachmentId || !this.attachmentStore) return item;
      const stored = this.attachmentStore.resolve(item.attachmentId, threadId);
      return { ...item, ...stored, attachmentId: stored.id };
    });
  }

  releaseFollowupAttachments(item) {
    for (const attachment of item?.attachments || []) {
      if (attachment?.attachmentId) {
        try { this.attachmentStore?.remove(attachment.attachmentId); } catch (error) { this.log(error); }
      }
    }
  }

  cleanUploads() {
    const root = path.join(os.tmpdir(), 'FengzhuAgentBridge', 'uploads'); if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const [uploadId, item] of this.uploads) {
      if ((item.createdAt || 0) >= cutoff) continue;
      this.abortUpload({ uploadId });
    }
    for (const thread of fs.readdirSync(root, { withFileTypes: true })) {
      if (!thread.isDirectory()) continue;
      const dir = path.join(root, thread.name);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue; const target = path.join(dir, entry.name);
        try { if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target); } catch {}
      }
    }
  }

  async syncHistory() {
    for (const archived of [false, true]) {
      let cursor = null;
      do {
        while (this.desktopSyncRunning && !this.stopping) await new Promise((r) => setTimeout(r, 1000));
        const page = await this.codex.request('thread/list', { limit: 30, cursor, archived, useStateDbOnly: true }, 120_000);
        for (const thread of page.data || []) await this.syncThreadMetadata(thread, archived);
        cursor = page.nextCursor || null;
        await new Promise((r) => setTimeout(r, 750));
      } while (cursor && !this.stopping);
    }
  }

  async syncOneThread(threadId) {
    const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000);
    const thread = detail.thread || detail;
    return this.syncThread(thread, Boolean(thread.archived), null, true);
  }

  // Codex asking the user something (request_user_input) in a desktop turn.
  // Only the narrowly supported single-choice form can be answered through
  // the Desktop UI; other forms remain explicitly desktop-only.
  trackCodexWaiting(threadId, record) {
    this.codexQuestionTracker ||= new CodexQuestionTracker();
    const questionChanged = this.codexQuestionTracker.consume(threadId, record);
    this.codexWaiting ||= new Map();
    const payload = record?.payload || {};
    const current = this.codexWaiting.get(threadId);
    if (record?.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type) && /(?:^|[.\/])request_user_input$/i.test(payload.name || '')) {
      // Our host answers these via its original RPC. Replaying the same
      // rollout must not create a second, Desktop-only question card.
      if (this.isBridgeOwnedThread?.(threadId)) return questionChanged;
      let args = {}; try { args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : (payload.arguments || {}); } catch { /* keep empty */ }
      const questions = (Array.isArray(args.questions) ? args.questions : []).map((question) => ({
        id: String(question?.id ?? ''),
        question: String(question?.question ?? question?.title ?? question?.prompt ?? ''),
        header: String(question?.header ?? ''),
        multiSelect: Boolean(question?.multiSelect ?? question?.multiple),
        secret: Boolean(question?.isSecret ?? question?.secret),
        options: (Array.isArray(question?.options) ? question.options : []).map((option) => (
          typeof option === 'string' ? { label: option, description: '' } : { label: String(option?.label ?? option?.value ?? ''), description: String(option?.description ?? '') })),
      }));
      const first = questions[0]?.header || questions[0]?.question || '';
      const waiting = { kind: 'question', tool: 'request_user_input', requestId: String(payload.call_id || payload.id || ''),
        summary: first ? `Codex 在问你：${first.slice(0, 60)}` : 'Codex 在等你回答', description: '', questions,
        waitingAt: Date.parse(record.timestamp) || Date.now() };
      waiting.answerable = Boolean(this.codexDesktopAnswer) && canAnswerDesktopQuestion(waiting);
      this.codexWaiting.set(threadId, waiting);
      return true;
    }
    if (!current) return questionChanged;
    const answered = record?.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type) && String(payload.call_id || '') === current.requestId;
    const ended = record?.type === 'event_msg' && /^(task_complete|turn_aborted|turn_cancelled|turn_interrupted)$/i.test(payload.type || '');
    if (answered || ended) { this.codexWaiting.delete(threadId); return true; }
    return questionChanged;
  }

  codexQuestionThreadInfo(threadId) {
    try {
      const { DatabaseSync } = require('./backends/antigravity').loadSqlite();
      const db = new DatabaseSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state_5.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('select name, title, rollout_path, archived from threads where id = ?').get(threadId);
        const title = String(row?.name || row?.title || '').trim();
        if (!row || row.archived || !title || !row.rollout_path) return null;
        // The UIA tree exposes the visible title, not the thread ID. Refuse
        // duplicate titles rather than risk answering another conversation.
        const matches = db.prepare('select count(*) as n from threads where name = ? or title = ?').get(title, title);
        return Number(matches.n) === 1 ? { title, file: row.rollout_path } : null;
      } finally { db.close(); }
    } catch { return null; }
  }

  async answerCodexOnDesktop(threadId, args) {
    if (!this.codexDesktopAnswer) throw new Error('这台电脑暂不支持在手机回答此问题，请在电脑上操作');
    return this.withCodexDesktopWindowLock(async () => {
      const waiting = this.codexWaiting?.get(threadId);
      const answer = desktopQuestionAnswer(waiting, args);
      if (!waiting.answerable) throw new Error('这个问题暂不支持在手机回答，请在电脑上操作');
      const info = this.codexQuestionThreadInfo(threadId);
      if (!info || questionRolloutState(info.file, waiting.requestId).state !== 'waiting') throw new Error('电脑上的问题已变化，请刷新后检查');
      const key = crypto.createHash('sha256').update(JSON.stringify([threadId, waiting.requestId])).digest('hex');
      const receiptFile = this.config?.configFile ? path.join(path.dirname(this.config.configFile), 'codex-question-receipts.dat') : null;
      this.codexQuestionReceipts ||= new SendReceipts(receiptFile);
      let receipt = this.codexQuestionReceipts.get(key);
      if (receipt && receipt.state !== 'failed') throw new Error('上次回答结果尚未确认，请检查电脑；系统不会自动重发');
      if (receipt) this.codexQuestionReceipts.update(key, { state: 'dispatching', reason: null });
      else receipt = this.codexQuestionReceipts.begin(key, 'codex-question', { threadId, text: '' });
      let result;
      try { result = await this.codexDesktopAnswer.answer({ threadId, title: info.title, question: waiting.questions[0], answer }); }
      catch { result = { delivery: 'uncertain' }; }
      // Even a successful UIA invocation is not proof the original RPC was
      // answered. Only the matching call_id and value are a positive receipt.
      let observed = questionRolloutState(info.file, waiting.requestId);
      if (result.delivery !== 'not_sent') {
        for (let i = 0; i < 20 && observed.state === 'waiting'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          observed = questionRolloutState(info.file, waiting.requestId);
        }
      }
      if (questionAnswerMatches(observed, answer)) {
        this.codexQuestionReceipts.update(key, { state: 'started', startedAt: Date.now(), reason: null });
        return { answered: true, backend: 'codex' };
      }
      const uncertain = result.delivery !== 'not_sent';
      this.codexQuestionReceipts.update(key, { state: uncertain ? 'uncertain' : 'failed' });
      if (observed.state === 'answered') throw new Error('电脑上的问题已被回答，请刷新后检查');
      if (uncertain) throw new Error('回答结果尚未确认，请检查电脑；系统不会自动重发');
      if (result.code === 'draft_present') throw new Error('电脑上的问题已有未发送的回答，请先处理电脑上的内容');
      throw new Error('电脑上的问题暂时无法安全回答，请在电脑上检查');
    });
  }

  recoverCodexDesktopWaiting(threadId, file) {
    const record = pendingDesktopQuestion(file);
    if (!record) { this.codexWaiting?.delete(threadId); return null; }
    if (this.codexWaiting?.get(threadId)?.requestId !== record.payload.call_id) this.trackCodexWaiting(threadId, record);
    return this.codexWaiting?.get(threadId) || null;
  }

  announceCodexQuestion(threadId, record, value) {
    // Historical ranges can contain both an ask and its later answer/end.
    // Announce only the reconciled state after the current tail is read.
    this.codexQuestionTracker ||= new CodexQuestionTracker();
    this.codexQuestionTracker.consume(threadId, record);
  }

  publishCodexQuestionState(threadId, evidence = null) {
    this.codexQuestionTracker ||= new CodexQuestionTracker();
    for (const event of evidence?.questionEvents || []) this.codexQuestionTracker.apply(threadId, event);
    const rawStatus = this.desktopStatuses?.get(threadId);
    const state = this.codexQuestionTracker.snapshot(threadId, { running: rawStatus === undefined ? undefined : isLiveThreadStatus(rawStatus) });
    if (!state || !state.updatedAt) return;
    state.silent = state.askedAt < (this.questionLiveSince || 0);
    this.codexQuestionPublished ||= new Map();
    const signature = JSON.stringify(state);
    if (this.codexQuestionPublished.get(threadId) === signature) return;
    this.codexQuestionPublished.set(threadId, signature);
    this.codexQuestionPendingPublished ||= new Set();
    if (state.pending) this.codexQuestionPendingPublished.add(threadId);
    else if (!this.codexQuestionPendingPublished.delete(threadId)) return;
    this.emit?.('codex.question.state', threadId, state);
    if (!state.pending || state.silent) return;
    this.announcedQuestions ||= new Set();
    const itemId = `${threadId}:${state.questions.map(q => q.id).join('|')}`;
    if (this.announcedQuestions.has(itemId)) return;
    this.announcedQuestions.add(itemId);
    if (this.announcedQuestions.size > 200) this.announcedQuestions.delete(this.announcedQuestions.values().next().value);
    this.emit?.('codex.question', threadId, state); // compatibility with pre-0.1.219 phones
  }

  // Every history item's encrypted value. In light mode a tool row goes up as
  // a placeholder and the full row stays on this computer (history.details).
  async historyItemFrame(threadId, itemId, value) {
    const publicValue = value?.type === 'userMessage' && typeof value.text === 'string'
      ? { ...value, text: sanitizeUploadReferences(value.text) } : value;
    const full = encryptJson(this.config.accountKey, 'history.item', threadId, itemId, publicValue);
    const placeholder = this.lightMode?.placeholder(publicValue);
    if (!placeholder) return full;
    // The encryption nonce changes every time even when the underlying tool
    // row is identical. An in-memory digest lets LightMode avoid appending an
    // identical copy while retaining every genuine update to the same id.
    // Include the account key and encryption context: an identical row for a
    // different account or thread cannot be reused. The digest stays in memory.
    const key = Buffer.isBuffer(this.config.accountKey) ? this.config.accountKey : Buffer.from(this.config.accountKey, 'base64');
    const contentHash = crypto.createHmac('sha256', key).update('khlink-light-detail-v1\0').update(JSON.stringify([threadId, itemId, publicValue])).digest('base64');
    try { await this.lightMode.save(threadId, { id: itemId, ...full }, contentHash); } catch (error) { this.log(error); return full; }
    return encryptJson(this.config.accountKey, 'history.item', threadId, itemId, placeholder);
  }

  // Every history item upload. The relay stores items only for a thread it
  // already has (a foreign key): when that row is missing it answers 500, so
  // upload the thread's index row and try once more.
  async putHistoryItems(threadId, items) {
    const put = () => this.api.request(this.api.path(`/history/threads/${encodeURIComponent(threadId)}/items`), { method: 'PUT', body: { items } });
    try { return await put(); }
    catch (error) {
      if (!/^500\b/.test(String(error?.message || '')) || !(await this.ensureThreadIndexed(threadId))) throw error;
      try { return await put(); }
      catch (retryError) { throw new Error(`history items for ${threadId} refused even after uploading its thread row: ${retryError.message}`); }
    }
  }

  async ensureThreadIndexed(threadId) {
    try {
      if (this.claudeThreads?.has(threadId)) { await this.syncClaudeThreadMetadata(threadId); return true; }
      if (this.piThreads?.has(threadId)) { await this.uploadPiIndex(threadId, this.piThreads.get(threadId)); return true; }
      let thread = null;
      try { const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000); thread = detail.thread || detail; }
      catch { thread = localCodexThread(threadId); }
      // Unknown to Codex too: do not invent an empty "Codex task" row for it.
      if (!thread?.updatedAt && !thread?.title && !thread?.name) return false;
      await this.syncThreadMetadata(applyDesktopPin(thread, this.desktopPins || { ids: [], orderById: {} }), Boolean(thread.archived));
      return true;
    } catch (error) { this.log(error); return false; }
  }

  async syncThreadMetadata(thread, archived, indexChanged = false) {
    // All upload paths (including full history and opening a conversation)
    // must preserve Desktop pins. Raw app-server threads have no pin fields.
    const pins = readDesktopPinState(this.desktopStateFile) || this.desktopPins;
    const decorated = archived || isSubagentThread(thread)
      ? applyDesktopPin(thread, null)
      : pins ? applyDesktopPin(thread, pins) : thread;
    const meta = normalizeThread({ ...decorated, archived }); const id = meta.id;
    const file = this.rolloutFilesByThread?.get(id) || thread.path || localCodexThread(id).path;
    const activityAt = readConversationActivityAt(file);
    if (activityAt !== null) { meta.activityAt = activityAt; meta.updatedAt = activityAt; }
    const evidence = readRolloutEvidence(file);
    const waiting = evidence?.status === 'waiting_input' || this.codexWaiting?.has(id)
      ? this.recoverCodexDesktopWaiting(id, file) : null;
    if (waiting) { meta.waiting = waiting; meta.note = waiting.summary; }
    this.publishCodexQuestionState(id, evidence);
    const rawStatus = this.desktopStatuses?.get(id);
    const questions = this.codexQuestionTracker?.snapshot(id, { running: rawStatus === undefined ? undefined : isLiveThreadStatus(rawStatus) });
    if (questions) meta.codexQuestions = questions;
    const encrypted = encryptJson(this.config.accountKey, 'history.thread', id, id, meta);
    const indexUpdatedAt = indexChanged || meta.pinned || meta.unread ? Date.now() : meta.updatedAt;
    await this.api.request(this.api.path('/history/threads'), { method: 'PUT', body: { id, archived, updatedAt: indexUpdatedAt, ...encrypted } });
  }

  async syncThread(thread, archived, suppliedDetail = null, notify = false) {
    const id = thread.id;
    const existing = this.threadSyncPromises.get(id);
    if (existing) return existing;
    const promise = this.performThreadSync(thread, archived, suppliedDetail, notify);
    this.threadSyncPromises.set(id, promise);
    try { return await promise; } finally { this.threadSyncPromises.delete(id); }
  }

  async performThreadSync(thread, archived, suppliedDetail = null, notify = false) {
    await this.syncThreadMetadata(thread, archived); const id = thread.id;
    const file = this.rolloutFilesByThread?.get(id) || thread.path || localCodexThread(id).path;
    if (file && fs.existsSync(file)) {
      this.rolloutFilesByThread ||= new Map(); this.rolloutFilesByThread.set(id, file);
      // Existing bounded rollout streaming/backfill preserves all history
      // without blocking the send RPC channel with a full thread hydration.
      return this.syncDesktopRollout(id, file);
    }
    let detail = suppliedDetail; try { detail ||= await this.readRecentCodexThread(id); } catch (error) { this.log(error); return; }
    const normalized = normalizeItems(detail.thread || detail, 90);
    const previousItems = new Map(this.threadItemDigests.get(id) || []);
    const nextItems = new Map();
    const recentStart = Math.max(0, normalized.length - 60);
    const changedCandidates = normalized.filter((item, index) => {
      const prior = previousItems.get(item.id);
      const itemDigest = index < recentStart && (!prior || prior.startsWith('stable:'))
        ? `stable:${item.order}:${item.id}`
        : crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
      nextItems.set(item.id, itemDigest);
      return prior !== itemDigest;
    });
    const digest = crypto.createHash('sha256').update(JSON.stringify([...nextItems])).digest('hex');
    if (this.threadDigests.get(id) === digest) return false;
    const changed = previousItems.size ? changedCandidates : changedCandidates.slice(-60);
    const items = await Promise.all(changed.map(async (item) => ({ id: item.id, order: item.order, createdAt: item.createdAt,
      ...await this.historyItemFrame(id, item.id, item.value) })));

    for (const batch of chunkByEncodedSize(items)) {
      await this.putHistoryItems(id, batch);
    }
    this.threadDigests.set(id, digest); this.threadItemDigests.set(id, [...nextItems]); this.saveHistoryDigests();
    if (notify) this.emit('history.updated', id, { threadId: id, itemCount: items.length,
      updatedAt: readConversationActivityAt(this.rolloutFilesByThread?.get(id) || thread.path || localCodexThread(id).path) ?? normalizeThread(thread).updatedAt });
    return true;
  }

  startRealtimeSync() {
    if (this.realtimeSyncTimer) return;
    const poll = () => this.pollRealtimeSync().catch((e) => this.log(e));
    setTimeout(poll, 1000).unref();
    this.realtimeSyncTimer = setInterval(poll, 2000);
    this.realtimeSyncTimer.unref();
  }

  async pollRealtimeSync() {
    // A Desktop list/queue request can remain in flight for a long time. Its
    // delay must not prevent an already-known rollout from reporting an end.
    // This is a fallback only while the ordinary poll is still running.
    if (!this.stopping && this.isConnected() && this.codex?.ready) {
      try { this.reconcileStartedRolloutChecks(); } catch (error) { this.log(error); }
      if (this.realtimeSyncRunning) {
        try { this.reconcileLiveStatusesFromRollouts(); } catch (error) { this.log(error); }
      }
    }
    return this.syncDesktopActivity();
  }

  async syncDesktopActivity() {
    if (this.stopping || this.realtimeSyncRunning || !this.isConnected() || !this.codex.ready) return;
    this.realtimeSyncRunning = true;
    try {
      const nextPins = readDesktopPinState(this.desktopStateFile) || this.desktopPins || { ids: [], orderById: {} };
      // Keep the ordinal map in the signature too. Desktop can reorder an
      // unchanged membership set without changing pinned-thread-ids.
      const pinSignature = JSON.stringify({ ids: nextPins.ids, orderById: nextPins.orderById || {}, unreadIds: nextPins.unreadIds || [] });
      const pinChanged = pinSignature !== this.desktopPinSignature;
      const previousPinnedIds = this.desktopPins?.ids || [];
      const previousUnreadIds = this.desktopPins?.unreadIds || [];
      // A Desktop task can remain active while a newer task is selected. Keep
      // enough rows to see every active task instead of treating pagination as
      // a completion signal.
      const page = await this.codex.request('thread/list', { limit: 30, archived: false, useStateDbOnly: true }, 30_000);
      if (!Array.isArray(page?.data)) {
        // A malformed reply is not a healthy snapshot of an empty desktop.
        this.desktopActivitySnapshotHealthy = false;
        return;
      }
      const rows = page.data;
      // Record every positive observation before processing any row. A slow
      // metadata upload for an earlier row must not let a parallel fallback
      // retire a later active row while the page is still being processed.
      const activeThreads = new Set(rows.filter(isActiveThread).map((thread) => thread.id).filter(Boolean));
      this.desktopPollingActiveThreads = activeThreads;
      const visibleDesktopThreads = [];
      for (let index = 0; index < rows.length; index += 1) {
        const thread = applyDesktopPin(rows[index], nextPins);
        const meta = normalizeThread(thread);
        this.desktopThreadUpdatedAt ||= new Map();
        this.desktopThreadUpdatedAt.set(thread.id, meta.updatedAt);
        visibleDesktopThreads.push({ id: meta.id, title: meta.title });
        const active = isActiveThread(thread);
        if (active) {
          activeThreads.add(thread.id);
        }
        this.reconcileDesktopThreadStatus(thread, active);
        // A rename (on the desktop or the phone) of any listed task.
        this.desktopTitles ||= new Map();
        const titleChanged = this.desktopTitles.has(thread.id) && this.desktopTitles.get(thread.id) !== meta.title;
        this.desktopTitles.set(thread.id, meta.title);
        if (index !== 0 && !active && !thread._fengzhuPinned && !titleChanged) continue;
        const signature = threadPollSignature(thread);
        const previous = this.realtimeThreads.get(thread.id);
        if (!previous || previous.signature !== signature || titleChanged) {
          this.realtimeThreads.set(thread.id, { signature, lastReadAt: Date.now() });
          await this.syncThreadMetadata(thread, Boolean(thread.archived));
        }
      }
      this.desktopActiveThreads = activeThreads;
      this.desktopActivitySnapshotAt = Date.now();
      this.desktopActivitySnapshotHealthy = true;
      // This account-scoped recovery runs in the background; a slow relay
      // must not hold up the normal desktop/status poll.
      this.reconcilePrebootStatusHints().catch(() => this.log('preboot status recovery delayed'));
      this.sweepStaleDesktopStatuses(new Set(visibleDesktopThreads.map((t) => t.id)));
      // Codex Desktop only queues messages behind a running turn. Walking its
      // window takes ~1 s, so scan every tick only while a task runs there or
      // a phone message waits in its queue; otherwise now and then.
      const queueMayExist = activeThreads.size > 0 || (this.followups?.items || []).some((item) => item.state === 'desktop_queued');
      if (queueMayExist || Date.now() - (this.queueScanAt || 0) >= 30_000) {
        this.queueScanAt = Date.now();
        await this.syncNativeDesktopQueues(visibleDesktopThreads);
      }
      await this.syncArchivedDesktopThreads();
      this.reconcileLiveStatusesFromRollouts();
      if (pinChanged) {
        await this.syncPinnedMetadata(nextPins, previousPinnedIds, previousUnreadIds, rows);
        this.desktopPins = nextPins;
        this.desktopPinSignature = pinSignature;
        this.emit('threads.updated', null, { updatedAt: Date.now() });
      }
    } catch (error) {
      // A failed poll cannot be used as fresh evidence for orphan recovery.
      this.desktopActivitySnapshotHealthy = false;
      throw error;
    } finally {
      this.desktopPollingActiveThreads = null;
      this.realtimeSyncRunning = false;
    }
  }

  // Tasks archived on the desktop disappear from the archived:false list the
  // poll reads; mark the recently archived ones archived on the phone too.
  async syncArchivedDesktopThreads(force = false) {
    if (!force && Date.now() - (this.archivedSyncAt || 0) < 60_000) return;
    this.archivedSyncAt = Date.now();
    this.archivedSynced ||= new Set();
    let page; try { page = await this.codex.request('thread/list', { limit: 20, archived: true, useStateDbOnly: true }, 30_000); } catch (error) { this.log(error); return; }
    for (const row of page?.data || []) {
      if (!row?.id || this.archivedSynced.has(row.id)) continue;
      try { await this.syncThreadMetadata(applyDesktopPin(row, this.desktopPins || { ids: [], orderById: {} }), true); this.archivedSynced.add(row.id); } catch (error) { this.log(error); }
    }
  }

  // Older versions read the page id of a paginated rollout
  // ("…-<thread>_<page>.jsonl") as a task of its own and could leave an
  // empty "Codex task" on the phone. Archive any such row (no deletion).
  async archiveRolloutPageRows() {
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    const pages = new Set(); const pending = [root];
    while (pending.length) {
      const directory = pending.pop();
      let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory()) { pending.push(path.join(directory, entry.name)); continue; }
        const page = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name)?.[1];
        if (page) pages.add(page);
      }
    }
    for (const page of pages) {
      if (localCodexThread(page).updatedAt) continue;   // a real task after all
      try { await this.syncThreadMetadata({ id: page, title: '', updatedAt: 0 }, true); } catch (error) { this.log(error); }
    }
  }

  // After a rename/archive from the phone, re-upload the index row at once.
  async refreshCodexThreadIndex(threadId, archived) {
    try {
      const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000);
      const thread = applyDesktopPin(detail.thread || detail, this.desktopPins || { ids: [], orderById: {} });
      const isArchived = archived ?? Boolean(thread.archived);
      await this.syncThreadMetadata(thread, isArchived);
      if (isArchived) this.archivedSynced?.add(threadId); else this.archivedSynced?.delete(threadId);
      this.desktopTitles?.set(threadId, normalizeThread(thread).title);
      this.emit('threads.updated', null, { updatedAt: Date.now() });
    } catch (error) { this.log(error); }
  }

  reconcileDesktopThreadStatus(thread, active = isActiveThread(thread)) {
    if (!thread?.id) return;
    this.desktopStatuses ||= new Map();
    this.desktopStatusAt ||= new Map();
    this.desktopLastActiveAt ||= new Map();
    const current = this.desktopStatuses.get(thread.id);
    if (active) {
      // A host that can see this thread may expose the approval flag directly;
      // absent flags are unknown, not evidence that an approval disappeared.
      const flags = thread.status && typeof thread.status === 'object' ? thread.status.activeFlags : null;
      if (Array.isArray(flags)) {
        const pending = flags.some((flag) => /^waitingOnApproval$/i.test(String(flag)));
        this.applyDesktopApprovalObservation?.(thread.id, pending ? 'desktop_approval_pending' : 'desktop_approval_clear', 'protocol');
      }
      this.desktopLastActiveAt.set(thread.id, Date.now());
      // The Desktop app-server may keep `thread/list` active for a while
      // after the rollout has already written task_complete.  In that case
      // the rollout is authoritative, but only when the thread metadata is
      // not newer than the completed rollout.  A genuinely new turn updates
      // the thread timestamp first and remains running until its start marker
      // is written, avoiding a false completion during the start race.
      if (isLiveThreadStatus(current)) {
        const rolloutFile = this.rolloutFilesByThread?.get(thread.id);
        if (rolloutFile) {
          try {
            const evidence = readRolloutEvidence(rolloutFile);
            const rolloutState = evidence?.status;
            const threadUpdatedAt = normalizeThread(thread).updatedAt;
            // `mtimeMs` is not reliable while Codex holds the JSONL handle
            // open. Compare the Desktop metadata with the last dated
            // conversation record instead.
            const metadataMatchesRollout = threadUpdatedAt > 0 && evidence?.activityAt > 0 &&
              threadUpdatedAt <= evidence.activityAt + 2_000;
            if (metadataMatchesRollout && isTerminalRolloutStatus(rolloutState)) {
              this.publishRolloutStatus(thread.id, this.turnStatus(thread.id, rolloutState), rolloutFile, evidence);
              return;
            }
          } catch {}
        }
      }
      // Keep a more specific waiting/mobile-owned state when one was observed
      // from the rollout or app-server notification stream.
      // The Desktop list can lag behind the rollout by one poll. Do not turn
      // a confirmed terminal event back into "running" until that lag window
      // has passed — but once it has, a genuinely new turn on this thread
      // must still be reported as running, or a long-lived pinned/reused
      // thread would show idle forever after its first completion.
      const terminalAt = isTerminalThreadStatusValue(current) ? (this.desktopStatusAt.get(thread.id) || 0) : 0;
      const pastReactivateGrace = !terminalAt || (Date.now() - terminalAt >= DESKTOP_STATUS_REACTIVATE_GRACE_MS);
      if (!isLiveThreadStatus(current) && pastReactivateGrace) {
        // An old thread whose last turn never wrote its end (the app was
        // closed mid-turn) is reported active again whenever it gets loaded.
        // Nothing touched it for a long time: not a new turn, so no "running"
        // badge and, a moment later, no false "completed" notification.
        const file = this.rolloutFilesByThread?.get(thread.id) || thread.path;
        const evidence = readRolloutEvidence(file);
        const threadUpdatedAt = normalizeThread(thread).updatedAt;
        if ((!evidence || !evidence.activityAt) && threadUpdatedAt > 0 &&
            Date.now() - threadUpdatedAt >= STALE_ORPHAN_ROLLOUT_MS) return;
        // An unlisted thread is not proof that a turn ended. Keep it live when
        // the rollout has a recent non-terminal record; only the explicit
        // terminal marker or the long (>=10 minute) orphan grace may reclaim
        // it. Unknown/absent rollout evidence stays live rather than guessing.
        if (evidence?.status && isTerminalRolloutStatus(evidence.status)) {
          // A historical task_complete must not be reused for a newer
          // Desktop turn whose metadata timestamp is later than the rollout
          // tail (the common "settings changed, then thread loaded" case).
          if (!threadUpdatedAt || !evidence.activityAt || threadUpdatedAt <= evidence.activityAt + 2_000) {
            this.publishRolloutStatus(thread.id, this.turnStatus(thread.id, evidence.status), file, evidence);
          }
          return;
        }
        if (evidence?.activityAt > 0 && Date.now() - evidence.activityAt >= STALE_ORPHAN_ROLLOUT_MS) return;
        if (evidence?.status && !isTerminalRolloutStatus(evidence.status)) {
          this.publishRolloutStatus(thread.id, desktopOwnedStatus(evidence.status), file, evidence);
          return;
        }
        this.publishRolloutStatus(thread.id, 'desktop_running', file, evidence);
      }
      return;
    }
    // A separate app-server commonly reports Desktop-owned tasks as notLoaded.
    // Explicit terminal states clear immediately; an idle-list snapshot or a
    // quiet rollout alone cannot prove that the turn has finished.
    if (isLiveThreadStatus(current)) {
      // Desktop's thread/list can briefly report an active rollout as
      // idle/notLoaded while the app-server catches up. A fresh rollout with
      // a live marker is stronger evidence than that lagging list snapshot;
      // keep the mobile running badge until the rollout becomes old or ends.
      const rolloutFile = this.rolloutFilesByThread?.get(thread.id);
      if (rolloutFile) {
        try {
          const evidence = readRolloutEvidence(rolloutFile);
          if (evidence?.status && isTerminalRolloutStatus(evidence.status)) {
            const threadUpdatedAt = normalizeThread(thread).updatedAt;
            // If Desktop has a newer turn timestamp than this terminal tail,
            // the terminal marker belongs to the previous turn. Keep the live
            // observation until that turn's own marker arrives.
            if (!threadUpdatedAt || !evidence.activityAt || threadUpdatedAt <= evidence.activityAt + 2_000) {
              this.publishRolloutStatus(thread.id, this.turnStatus(thread.id, evidence.status), rolloutFile, evidence);
            }
            return;
          }
          // A model step or tool can remain silent for any length of time.
          // `notLoaded` and list absence are not terminal evidence.
          if (!isExplicitTerminalThreadStatus(thread)) return;
        } catch { if (!isExplicitTerminalThreadStatus(thread)) return; }
      } else {
        // Without a rollout we have no per-turn evidence. The explicit
        // Desktop status below is still authoritative, but idle grace alone
        // must never manufacture a completion.
        if (!isExplicitTerminalThreadStatus(thread)) return;
      }
      if (isExplicitTerminalThreadStatus(thread)) {
        this.publishThreadStatus(thread.id, 'completed');
      }
    }
  }

  // A thread that scrolls out of Desktop's own most-recently-used
  // thread/list page stops being visited by reconcileDesktopThreadStatus
  // entirely, so a live badge for it can never be swept back to idle by the
  // normal inactive-branch grace period above. Sweep those separately using
  // the same idle grace window.
  sweepStaleDesktopStatuses(visibleIds) {
    for (const [threadId, status] of this.desktopStatuses) {
      if (!isLiveThreadStatus(status) || visibleIds.has(threadId)) continue;
      const file = this.rolloutFilesByThread?.get(threadId);
      const evidence = readRolloutEvidence(file);
      if (!evidence) continue;
      if (evidence.status && isTerminalRolloutStatus(evidence.status)) {
        // A stale live status can outlive the Desktop list page. If Desktop
        // has already advanced this thread's metadata beyond the rollout
        // tail, the terminal marker belongs to the previous turn; wait for
        // that newer turn's own marker instead of sweeping it to completed.
        const desktopUpdatedAt = Number(this.desktopThreadUpdatedAt?.get(threadId)) || 0;
        if (desktopUpdatedAt > 0 && evidence.activityAt > 0 && desktopUpdatedAt > evidence.activityAt + 2_000) continue;
        this.publishRolloutStatus(threadId, this.turnStatus(threadId, evidence.status), file, evidence);
        continue;
      }
      // Falling out of thread/list and silence are not evidence of an end.
      // Keep the last live state until the rollout has a terminal record.
    }
  }

  async codexHostHasActiveWork() {
    if (!this.codex?.request) return false; // legacy integrations/test doubles
    try {
      let cursor = null;
      do {
        const page = await this.codex.request('thread/loaded/list', { cursor, limit: 100 }, 5_000);
        if (!Array.isArray(page.data)) return true;
        for (const threadId of page.data) {
          const result = await this.codex.request('thread/read', { threadId, includeTurns: false }, 5_000);
          const raw = (result.thread || result).status;
          const status = String(raw?.type || raw || '').toLowerCase();
          // A connector reload loses its in-memory activeTurnId set while the
          // persistent host continues running. Only an explicitly idle host
          // permits recycling; waiting, loading and unknown states protect it.
          if (!['idle', 'notloaded', 'completed', 'cancelled', 'stopped', 'failed'].includes(status)) return true;
        }
        cursor = page.nextCursor || null;
      } while (cursor);
      return false;
    } catch (error) { this.log(error); return true; }
  }

  reconcileLiveStatusesFromRollouts() {
    this.rolloutFilesByThread ||= new Map(); this.rolloutStatusScans ||= new Map(); this.rolloutLookupAt ||= new Map(); this.threadState ||= new Map();
    const liveIds = new Set([...this.desktopStatuses]
      .filter(([threadId, status]) => isLiveThreadStatus(status) ||
        (this.desktopActiveThreads?.has(threadId) && isTerminalThreadStatusValue(status)))
      .map(([threadId]) => threadId));
    if (!liveIds.size) return;
    const now = Date.now();
    const unresolved = new Set([...liveIds].filter((threadId) => !this.rolloutFilesByThread.has(threadId) &&
      now - (this.rolloutLookupAt.get(threadId) || 0) >= ROLLOUT_LOOKUP_RETRY_MS));
    if (unresolved.size) {
      const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
      for (const threadId of unresolved) this.rolloutLookupAt.set(threadId, now);
      for (const [threadId, file] of findRolloutFilesForThreads(root, unresolved)) this.rolloutFilesByThread.set(threadId, file);
    }
    for (const threadId of liveIds) {
      const file = this.rolloutFilesByThread.get(threadId);
      if (!file) continue;
      const evidence = readRolloutEvidence(file);
      if (!evidence) continue;
      const { stat, activityAt, status } = evidence;
      // The rollout does not need to change when a healthy desktop snapshot
      // arrives or the reboot grace expires. Check before the scan cache.
      if (this.retirePrebootCodexStatus(threadId, file, evidence)) continue;
      const signature = `${stat.size}:${activityAt}`;
      if (this.rolloutStatusScans.get(file) === signature) continue;
      this.rolloutStatusScans.set(file, signature);
      if (!status) continue;
      // Some Desktop rollouts end without a terminal task_complete record.
      // Do not require the Desktop thread/list snapshot to also say "active":
      // that snapshot can be stale in the opposite direction and otherwise
      // leaves historical running badges blocking safe maintenance forever.
      const staleActive = activityAt > 0 && now - activityAt > STALE_ACTIVE_ROLLOUT_MS;
      const current = this.desktopStatuses.get(threadId);
      const desktopUpdatedAt = Number(this.desktopThreadUpdatedAt?.get(threadId)) || 0;
      if (isTerminalRolloutStatus(status) && isLiveThreadStatus(current) && desktopUpdatedAt > 0 &&
          activityAt > 0 && desktopUpdatedAt > activityAt + 2_000) continue;
      // A turn KH Link ran in a Codex host process that no longer exists
      // (connector/host restarted) cannot still be running: its app-server is gone.
      const owner = this.threadOwnership?.get?.(threadId);
      const hostPid = this.codex?.host?.state?.pid;
      const deadBridgeTurn = status !== 'completed' && owner?.hostPid && hostPid && owner.hostPid !== hostPid &&
        (owner.owner === 'khlink' || owner.source === 'lease' || owner.source === 'mobile_turn');
      if (deadBridgeTurn) {
        this.publishThreadStatus(threadId, 'cancelled');
        this.emit('codex.error', threadId, { threadId, error: '电脑上的 khLink 重启过，这一轮已中断，可以重新发送。', terminal: true, updatedAt: Date.now() });
        this.releaseThreadOwner(threadId, 'bridge host restarted');
        continue;
      }
      if (status === 'running' && isInteractiveThreadStatus(current)) continue;
      // Elapsed silence, an absent list entry or a completed tool call does
      // not prove that a turn finished. Only its actual terminal record can.
      if (!staleActive && this.desktopActiveThreads?.has(threadId) && isTerminalRolloutStatus(status) && !rolloutHasTurnStartMarker(file, stat.size)) continue;
      this.publishRolloutStatus(threadId, this.turnStatus(threadId, status), file, evidence);
    }
  }

  async syncPinnedMetadata(pins, previousPinnedIds, previousUnreadIds, recentRows) {
    const recent = new Map(recentRows.map((thread) => [thread.id, thread]));
    const targets = [...new Set([...(pins.ids || []), ...previousPinnedIds, ...(pins.unreadIds || []), ...previousUnreadIds])];
    for (const id of targets) {
      let thread = recent.get(id);
      if (!thread) {
        try { const detail = await this.codex.request('thread/read', { threadId: id, includeTurns: false }, 30_000); thread = detail.thread || detail; }
        catch { continue; }
      }
      // Sub-agent threads carry their own unread flag on the desktop but are
      // listed under their parent there, never as tasks: keep them hidden.
      const subagent = isSubagentThread(thread);
      // Unpinning an old thread must also reach the phone's newest-page
      // refresh; keep its real activity timestamp inside encrypted metadata.
      await this.syncThreadMetadata(applyDesktopPin(thread, subagent ? { ids: [], orderById: {}, unreadIds: [] } : pins), subagent || Boolean(thread.archived), true);
    }
  }

  startSessionWatcher() {
    if (this.sessionWatcher) return;
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    if (!fs.existsSync(root)) return;
    this.bootstrapRecentRolloutStatuses(root).catch((error) => this.log(error));
    try {
      this.sessionWatcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        const threadId = sessionThreadId(filename);
        if (!threadId || this.desktopSyncTimers.has(threadId)) return;
        const wait = Math.max(100, 500 - (Date.now() - (this.desktopSyncAt.get(threadId) || 0)));
        const timer = setTimeout(() => {
          this.desktopSyncTimers.delete(threadId); this.desktopSyncAt.set(threadId, Date.now());
          this.syncDesktopRollout(threadId, path.join(root, String(filename))).catch((e) => this.log(e));
        }, wait);
        timer.unref(); this.desktopSyncTimers.set(threadId, timer);
      });
      this.sessionWatcher.unref?.();
    } catch (error) { this.log(error); }
  }

  async bootstrapRecentRolloutStatuses(root) {
    this.rolloutFilesByThread ||= new Map();
    // Windows can keep an actively appended file's mtime old. The Desktop
    // thread index supplies extra candidates, but never proves a live turn:
    // the rollout records below still decide status and freshness.
    const files = [...new Set([...recentIndexedRolloutFiles(root, 30), ...await recentRolloutFilesAsync(root, 20)])];
    const toSync = [];
    for (const file of files) {
      // Evidence parsing still uses bounded synchronous reads. Give relay
      // heartbeats and commands a turn between files during startup.
      await new Promise((resolve) => setImmediate(resolve));
      if (this.stopping) return;
      if (isHiddenRollout(file)) { this.hiddenRollouts.add(file); continue; }
      const threadId = sessionThreadId(file);
      if (!threadId) continue;
      // `recentRolloutFiles` is newest-first. A paginated thread can have
      // several files, so an older page must never replace the live file in
      // the per-thread index while this loop walks the list.
      const currentFile = this.rolloutFilesByThread.get(threadId);
      if (!currentFile || isNewerRolloutFile(file, currentFile)) this.rolloutFilesByThread.set(threadId, file);
      this.reconcileStartedFollowups(threadId, file);
      const evidence = readRolloutEvidence(file);
      const stat = evidence?.stat || fs.statSync(file);
      const status = evidence?.status;
      const activityAt = evidence?.activityAt || 0;
      // Startup history sync must not turn an old terminal result into the
      // task's current live badge. Real-time events and recent rollouts still
      // publish their status; older records remain available in history.
      // Windows can keep stat.mtimeMs unchanged while Codex appends. Only a
      // dated conversation record can establish that this rollout is old.
      if (activityAt > 0 && Date.now() - activityAt > STALE_ORPHAN_ROLLOUT_MS) continue;
      if (status && !isTerminalRolloutStatus(status)) this.publishRolloutStatus(threadId, desktopOwnedStatus(status), file, evidence);
      toSync.push([threadId, file]);
    }
    // Publish all observed statuses before potentially slow history uploads.
    for (const [threadId, file] of toSync) await this.syncDesktopRollout(threadId, file);
  }

  // Re-reading many rollouts in a short time floods the phone with updates
  // (seen once: ~100 old tasks a few minutes apart, cause unknown). When it
  // happens again, say which code path is doing it, once a minute at most.
  // Counted per task: one running task alone is tailed twice a second.
  noteRolloutRead(threadId) {
    const now = Date.now();
    if (!this._rolloutReads || now - this._rolloutReads.since > 60_000) this._rolloutReads = { since: now, threads: new Set(), callers: new Map(), reported: false };
    const reads = this._rolloutReads;
    if (reads.threads.has(threadId)) return;
    reads.threads.add(threadId);
    const caller = (new Error().stack || '').split('\n').slice(3, 5).map((line) => line.trim().replace(/^at /, '').replace(/ \(.*\)$/, '')).join(' <- ');
    reads.callers.set(caller, (reads.callers.get(caller) || 0) + 1);
    if (reads.threads.size > 20 && !reads.reported) {
      reads.reported = true;
      const top = [...reads.callers].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${count}× ${name}`).join('; ');
      this.log(new Error(`${reads.threads.size} tasks' rollouts read in under a minute: ${top}`));
    }
  }

  // Multiple watcher callbacks can arrive while the previous range is still
  // being encrypted or uploaded. Serialize a thread's reads so each observes
  // the cursor committed by its predecessor. Coalesce only queued ordinary
  // watcher reads for the same path; explicit backfills keep their order.
  syncDesktopRollout(threadId, file, options = {}) {
    this.rolloutSyncTails ||= new Map();
    this.rolloutPendingLiveReads ||= new Map();
    const key = String(threadId);
    const previous = this.rolloutSyncTails.get(key);
    const ordinary = !options.allowBackfill && options.startOffset === undefined && !options.backfillStage;
    const resolvedFile = ordinary ? path.resolve(String(file)) : '';
    const pendingKey = ordinary ? `${key}\0${process.platform === 'win32' ? resolvedFile.toLowerCase() : resolvedFile}` : null;
    const pending = pendingKey && this.rolloutPendingLiveReads.get(pendingKey);
    // A backfill may have been queued after an earlier watcher read. A new
    // watcher must run after that backfill instead of joining the older read.
    if (previous && pending && pending === previous) return pending;
    const work = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => {
      if (pendingKey && this.rolloutPendingLiveReads.get(pendingKey) === work) this.rolloutPendingLiveReads.delete(pendingKey);
      return this.performDesktopRolloutSync(threadId, file, options);
    });
    this.rolloutSyncTails.set(key, work);
    if (previous && pendingKey) this.rolloutPendingLiveReads.set(pendingKey, work);
    const cleanup = () => {
      if (this.rolloutSyncTails.get(key) === work) this.rolloutSyncTails.delete(key);
      if (pendingKey && this.rolloutPendingLiveReads.get(pendingKey) === work) this.rolloutPendingLiveReads.delete(pendingKey);
    };
    work.then(cleanup, cleanup);
    return work;
  }

  async performDesktopRolloutSync(threadId, file, options = {}) {
    // A user-triggered full backfill owns this thread's rollout reader. Ignore
    // watcher callbacks until it has reached EOF; the final callback below
    // catches any bytes appended while the backfill was running.
    if (!options.allowBackfill && this.historyBackfillPromises?.has(threadId)) return false;
    this.rolloutFilesByThread ||= new Map();
    const indexedFile = this.rolloutFilesByThread.get(threadId);
    // Desktop's database can name the same Windows file through the G: real
    // path while fs.watch reports the C: junction. Use one cursor and identity.
    if (indexedFile && sameRolloutFile(indexedFile, file)) file = indexedFile;
    const statusSource = !indexedFile || isNewerRolloutFile(file, indexedFile);
    if (statusSource) this.rolloutFilesByThread.set(threadId, file);
    this.rolloutPartialOffsets ||= new Map();
    this.hiddenRollouts ||= new Set();
    if (this.hiddenRollouts.has(file)) return false;
    if (isHiddenRollout(file)) { this.hiddenRollouts.add(file); return false; }
    let stat; try { stat = fs.statSync(file); } catch { return false; }
    const savedPartialOffset = this.rolloutPartialOffsets.get(file);
    let offset = options.startOffset !== undefined ? Number(options.startOffset) : this.rolloutOffsets.get(file);
    if (Number.isFinite(savedPartialOffset) && (offset === undefined || offset > savedPartialOffset)) offset = savedPartialOffset;
    const firstRead = options.startOffset !== undefined || Number.isFinite(savedPartialOffset) || offset === undefined || offset > stat.size;
    if (offset === undefined || offset > stat.size) offset = Math.max(0, stat.size - LIVE_ROLLOUT_TAIL_BYTES);
    const discardPartialLine = shouldDiscardPartialRolloutLine(firstRead, offset) && needsPartialRolloutLineDiscard(file, offset);
    const partialBoundary = Number.isFinite(savedPartialOffset) || discardPartialLine;
    if (offset === stat.size && !partialBoundary) return true;
    // Watchers can report unchanged files. Count actual tail reads so these
    // notifications do not produce a false history-flood diagnostic.
    this.noteRolloutRead(threadId);
    let text = '';
    let trailingCursor = null;
    const fd = fs.openSync(file, 'r');
    let actualSize;
    try {
      actualSize = Math.max(0, Number(fs.fstatSync(fd).size) || 0);
      if (offset >= actualSize) {
        if (partialBoundary) {
          this.rolloutPartialOffsets.set(file, Math.max(0, Math.min(offset, actualSize)));
          this.rolloutOffsets.set(file, Math.max(0, Math.min(offset, actualSize)));
          return { partial: true, threadId, offset: Math.max(0, Math.min(offset, actualSize)) };
        }
        this.rolloutOffsets.set(file, actualSize);
        return true;
      }
      let partialCursor = null;
      if (partialBoundary) {
        if (discardPartialLine) {
          const boundary = findRolloutLineStart(file, offset);
          if (!boundary.exact) {
            this.rolloutPartialOffsets.set(file, boundary.offset);
            this.rolloutOffsets.set(file, boundary.offset);
            return { partial: true, threadId, offset: boundary.offset };
          }
          offset = boundary.offset;
          partialCursor = offset;
        } else if (Number.isFinite(savedPartialOffset)) {
          partialCursor = offset;
        }
        // Do not advance a cursor while the boundary record is still missing
        // its newline. A later watcher tick will retry from the saved line
        // start after Codex finishes appending that record.
        if (!rolloutRangeHasNewline(file, offset, actualSize)) {
          this.rolloutPartialOffsets.set(file, partialCursor ?? offset);
          this.rolloutOffsets.set(file, partialCursor ?? offset);
          return { partial: true, threadId, offset: partialCursor ?? offset };
        }
      }
      const length = actualSize - offset;
      if (!rolloutEndsWithNewline(file, actualSize)) {
        trailingCursor = findTrailingRolloutLineStart(file, offset, actualSize);
      }
      // Keep the established small-range path for normal watcher updates, but
      // hand large reads to the streaming implementation before allocating a
      // buffer proportional to the rollout size. The surrounding finally block
      // closes this descriptor before the helper starts reading.
      if (length > ROLLOUT_STREAM_CHUNK_BYTES) {
        return this.syncDesktopRolloutStreaming(threadId, file, {
          ...options,
          offset,
          actualSize,
          firstRead: firstRead || partialBoundary,
          discardPartialLine: partialBoundary && partialCursor === null ? discardPartialLine : false,
          partialBoundary,
          partialCursor,
          trailingCursor,
          holdTrailingPartial: trailingCursor !== null,
          stat,
        });
      }
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      stat = { ...stat, size: actualSize };
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
    if (partialBoundary && text.indexOf('\n') < 0) {
      const cursor = Number.isFinite(partialCursor) ? partialCursor : offset;
      this.rolloutPartialOffsets.set(file, cursor);
      this.rolloutOffsets.set(file, cursor);
      return { partial: true, threadId, offset: cursor };
    }
    if (discardPartialLine && !Number.isFinite(partialCursor)) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    if (trailingCursor !== null) {
      // `trailingCursor` is a byte offset while `text` is UTF-8 decoded; use
      // the decoded newline position instead of slicing with a byte index.
      const newline = text.lastIndexOf('\n');
      text = newline >= 0 ? text.slice(0, newline + 1) : '';
    }
    const lines = text.split(/\r?\n/);
    let waitingChanged = false;
    // Codex writes a user turn twice in many rollouts: the canonical
    // `event_msg/user_message` record and a protocol `response_item` copy.
    // Prefer the canonical event (it does not contain injected context) and
    // suppress the copy when both records are present.
    const eventUsers = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      const payload = record?.payload || {};
      if (record?.type !== 'event_msg' || payload.type !== 'user_message') continue;
      const message = String(payload.message ?? payload.text ?? '').trim();
      const localImages = Array.isArray(payload.local_images) ? payload.local_images : [];
      if (!message && !localImages.length) continue;
      eventUsers.push({ at: Date.parse(record.timestamp) || 0, message, localImages });
    }
    // A watcher callback can begin in the middle of a rollout, where the
    // first record is only a tool result. Keep the last published state as
    // the base so that a completed turn cannot be resurrected by that result.
    const items = []; let sameTime = 0; let lastTime = 0;
    let status = normalizeRolloutStatusValue(this.desktopStatuses?.get(threadId));
    let latestRolloutSettings = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (isDuplicateRolloutUserCopy(record, eventUsers)) continue;
      status = advanceRolloutStatus(status, record);
      const settings = rolloutThreadSettings(record);
      if (settings) {
        const updatedAt = Date.parse(record.timestamp) || Date.now();
        if (!latestRolloutSettings || updatedAt >= latestRolloutSettings.updatedAt) {
          latestRolloutSettings = { settings, updatedAt };
        }
      }
      const userText = rolloutUserText(record);
      const localImagePaths = Array.isArray(record?.payload?.local_images) ? record.payload.local_images : [];
      let started = null;
      if (userText || localImagePaths.length) {
        const startedAt = Date.parse(record.timestamp) || Date.now();
        const allowFollowupMatch = options.backfillStage !== 'full' || startedAt >= Date.now() - FOLLOWUP_RECONCILE_MAX_AGE_MS;
        if (allowFollowupMatch) {
          started = userText
            ? this.followups.matchStarted(threadId, userText, startedAt)
            : this.followups.matchStartedByLocalImagePaths?.(threadId, localImagePaths, startedAt);
        }
        if (started) {
          this.emit('followup.started', threadId, { ...publicItem(started), startedAt }, started.sourceDeviceId);
          this.noteMatchedRolloutFollowupStarted(threadId, file, startedAt);
        }
      }
      if (this.trackCodexWaiting(threadId, record)) waitingChanged = true;
      const value = rolloutItem(record) || (options.backfillStage && legacyVisibleRecord(record) ? HIDDEN_ITEM : null); if (!value) continue;
      if (value.type === 'codexQuestion' && !options.backfillStage) this.announceCodexQuestion(threadId, record, value);
      if (value.type === 'userMessage' && started?.attachments?.length) {
        const images = readHistoryAttachmentPreviews(started.attachments);
        if (images.length) value.images = images;
        this.releaseFollowupAttachments(started);
      } else if (value.type === 'userMessage' && localImagePaths.length) {
        // The canonical event contains the upload path even when the
        // follow-up record was already reconciled by another watcher. Read a
        // bounded preview directly from that path so the canonical history
        // item remains image-bearing; the path itself is never serialized.
        const images = readHistoryAttachmentPreviews(localImagePaths.map((localPath) => ({
          name: String(localPath || '').split(/[\\/]/).pop()?.replace(/^[0-9a-f-]{36}-/i, '') || '图片附件',
          path: String(localPath || ''),
          mimeType: 'image/png',
        })));
        if (images.length) value.images = images;
      }
      const time = Date.parse(record.timestamp) || Date.now(); sameTime = time === lastTime ? sameTime + 1 : 0; lastTime = time;
      const itemId = record.payload?.id || crypto.createHash('sha256').update(line).digest('hex');
      items.push({ id: itemId, order: time * 1000 + sameTime, createdAt: time,
        ...await this.historyItemFrame(threadId, itemId, value) });
    }
    // The range may have been captured while Codex was appending. Re-read the
    // current tail before publishing so a previous task_complete in the
    // streamed range cannot win a race with this task's later task_started.
    // Keep the original `stat.size` for the cursor: bytes appended during this
    // read must be handled by the next watcher tick, not skipped here.
    const authoritative = readRolloutEvidence(file, 16 * 1024 * 1024);
    if (authoritative?.status) status = authoritative.status;
    const statusSize = authoritative?.size || stat.size;
    if (!status && firstRead) status = latestRolloutStatus(file, statusSize);
    if ((items.length && Date.now() - (this.desktopMetadataAt.get(threadId) || 0) >= 15_000) || waitingChanged) {
      try {
        const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000);
        const thread = applyDesktopPin(detail.thread || detail, this.desktopPins || { ids: [], orderById: {} });
        await this.syncThreadMetadata(thread, Boolean(thread.archived));
        this.desktopMetadataAt.set(threadId, Date.now());
      } catch (error) {
        // History is sourced from the rollout file. A stale/notLoaded desktop
        // metadata read must not discard otherwise valid conversation items.
        this.log(error);
      }
    }
    for (const batch of chunkByEncodedSize(items)) {
      await this.putHistoryItems(threadId, batch);
    }
    if (latestRolloutSettings) {
      this.publishRolloutThreadSettings(threadId, latestRolloutSettings.settings, latestRolloutSettings.updatedAt);
    }
    const completedOffset = trailingCursor ?? stat.size;
    this.rolloutOffsets.set(file, completedOffset);
    if (trailingCursor !== null) {
      this.rolloutPartialOffsets.set(file, trailingCursor);
    } else {
      this.rolloutPartialOffsets.delete(file);
    }
    if (status) {
      if (this.desktopActiveThreads?.has(threadId) && isTerminalRolloutStatus(status) && !rolloutHasTurnStartMarker(file, statusSize)) {
        if (items.length) this.emit('history.updated', threadId, { threadId, itemCount: items.length, updatedAt: latestItemAt(items) });
        return trailingCursor !== null ? { partial: true, threadId, offset: trailingCursor } : true;
      }
      // A stale page of a paginated rollout may still be read for history, but
      // it must not publish a status over the newest page's live state.
      if (sameRolloutFile(this.rolloutFilesByThread.get(threadId), file)) this.publishRolloutStatus(threadId, this.turnStatus(threadId, status), file, authoritative, false, { quiet: this.rolloutInheritedQuiet(threadId, status, authoritative) });
    }
    if (items.length) this.emit('history.updated', threadId, { threadId, itemCount: items.length, updatedAt: latestItemAt(items) });
    return trailingCursor !== null ? { partial: true, threadId, offset: trailingCursor } : true;
  }

  // Replay a large rollout without ever materializing the unread range in one
  // Buffer/string. The first pass only keeps the small canonical-user index
  // needed to suppress Codex's duplicate response_item copy. The second pass
  // turns records into encrypted history items and uploads bounded batches;
  // readRolloutLines yields to the event loop between every 512 KiB chunk so a
  // multi-gigabyte historical file cannot starve heartbeats or command RPCs.
  async syncDesktopRolloutStreaming(threadId, file, options = {}) {
    if (!options.allowBackfill && this.historyBackfillPromises?.has(threadId)) return false;
    this.rolloutFilesByThread ||= new Map();
    const indexedFile = this.rolloutFilesByThread.get(threadId);
    if (indexedFile && sameRolloutFile(indexedFile, file)) file = indexedFile;
    const statusSource = !indexedFile || isNewerRolloutFile(file, indexedFile);
    if (statusSource) this.rolloutFilesByThread.set(threadId, file);
    this.rolloutPartialOffsets ||= new Map();
    this.hiddenRollouts ||= new Set();
    if (this.hiddenRollouts.has(file) || isHiddenRollout(file)) return false;

    let stat;
    try { stat = fs.statSync(file); } catch { return false; }
    const start = Math.max(0, Math.min(Number(options.offset) || 0, stat.size));
    const end = Math.max(start, Math.min(Number(options.actualSize) || stat.size, stat.size));
    if (start >= end) {
      if (options.partialBoundary) {
        const cursor = Number.isFinite(options.partialCursor) ? options.partialCursor : start;
        this.rolloutPartialOffsets.set(file, cursor);
        this.rolloutOffsets.set(file, cursor);
        return { partial: true, threadId, offset: cursor };
      }
      this.rolloutOffsets.set(file, end);
      return true;
    }
    const firstRead = options.firstRead ?? (start > 0);
    const discardPartialLine = options.discardPartialLine ?? (firstRead && start > 0 && needsPartialRolloutLineDiscard(file, start));
    const trailingCursor = options.trailingCursor ?? findTrailingRolloutLineStart(file, start, end);
    const holdTrailingPartial = options.holdTrailingPartial ?? trailingCursor !== null;
    if (options.partialBoundary && !rolloutRangeHasNewline(file, start, end)) {
      const cursor = Number.isFinite(options.partialCursor) ? options.partialCursor : start;
      this.rolloutPartialOffsets.set(file, cursor);
      this.rolloutOffsets.set(file, cursor);
      return { partial: true, threadId, offset: cursor };
    }

    const eventUsers = createRolloutUserIndex();
    for await (const line of readRolloutLines(file, start, end, { discardPartialLine, holdTrailingPartial })) {
      if (this.stopping && options.backfillStage === 'full') return false;
      if (this.stopping) return false;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record?.payload || {};
      if (record?.type !== 'event_msg' || payload.type !== 'user_message') continue;
      const message = String(payload.message ?? payload.text ?? '').trim();
      const localImages = Array.isArray(payload.local_images) ? payload.local_images : [];
      if (!message && !localImages.length) continue;
      addRolloutUserIndex(eventUsers, { at: Date.parse(record.timestamp) || 0, message, localImages });
    }

    let status = normalizeRolloutStatusValue(this.desktopStatuses?.get(threadId)); let sameTime = 0; let lastTime = 0; let itemCount = 0;
    let streamWaitingChanged = false;
    let latestRolloutSettings = null;
    let lastLiveTailAt = Date.now();
    let pending = []; let pendingBytes = 12; let metadataSynced = false;
    this.desktopMetadataAt ||= new Map();
    const flush = async () => {
      if (!pending.length) return;
      if (this.stopping) { pending = []; pendingBytes = 12; return; }
      await this.putHistoryItems(threadId, pending);
      pending = []; pendingBytes = 12;
      // Let connector heartbeats, websocket receives, and mobile commands run
      // between network batches even when the API responds immediately.
      await yieldToEventLoop();
      // A multi-gigabyte historical pass can run for minutes while Codex keeps
      // appending the active task. Catch a bounded recent tail periodically so
      // the phone never waits for the old prefix before seeing new messages.
      if (options.backfillStage === 'full' && !this.stopping && Date.now() - lastLiveTailAt >= 5_000) {
        lastLiveTailAt = Date.now();
        // The live-tail pass uses the same rollout cursor maps as the full
        // replay. Preserve the full replay's checkpoint while it runs: a tail
        // may advance (or rewind) those maps, and if the full pass then fails
        // its watcher must resume from the historical cursor rather than skip
        // directly to the newest tail.
        const hadFullOffset = this.rolloutOffsets.has(file);
        const fullOffset = this.rolloutOffsets.get(file);
        const hadFullPartialOffset = this.rolloutPartialOffsets.has(file);
        const fullPartialOffset = this.rolloutPartialOffsets.get(file);
        try {
          await this.syncRecentRolloutTailDuringBackfill(threadId, file);
        } finally {
          if (hadFullOffset) this.rolloutOffsets.set(file, fullOffset);
          else this.rolloutOffsets.delete(file);
          if (hadFullPartialOffset) this.rolloutPartialOffsets.set(file, fullPartialOffset);
          else this.rolloutPartialOffsets.delete(file);
        }
      }
    };
    const addItem = async (item) => {
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (pending.length && (pending.length >= HISTORY_BATCH_MAX_ITEMS || pendingBytes + itemBytes > HISTORY_BATCH_MAX_BYTES)) await flush();
      pending.push(item); pendingBytes += itemBytes;
    };
    const syncMetadata = async () => {
      if (metadataSynced || Date.now() - (this.desktopMetadataAt.get(threadId) || 0) < 15_000) return;
      metadataSynced = true;
      try {
        const detail = await this.codex.request('thread/read', { threadId, includeTurns: false }, 30_000);
        const thread = applyDesktopPin(detail.thread || detail, this.desktopPins || { ids: [], orderById: {} });
        await this.syncThreadMetadata(thread, Boolean(thread.archived));
        this.desktopMetadataAt.set(threadId, Date.now());
      } catch (error) {
        // History is sourced from the rollout file. A stale/notLoaded metadata
        // read must not discard valid conversation items.
        this.log(error);
      }
    };

    for await (const line of readRolloutLines(file, start, end, { discardPartialLine, holdTrailingPartial })) {
      if (this.stopping && options.backfillStage === 'full') return false;
      if (this.stopping) return false;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (isDuplicateRolloutUserCopyIndexed(record, eventUsers)) continue;
      status = advanceRolloutStatus(status, record);
      const settings = rolloutThreadSettings(record);
      if (settings) {
        const updatedAt = Date.parse(record.timestamp) || Date.now();
        if (!latestRolloutSettings || updatedAt >= latestRolloutSettings.updatedAt) {
          latestRolloutSettings = { settings, updatedAt };
        }
      }
      const userText = rolloutUserText(record);
      const localImagePaths = Array.isArray(record?.payload?.local_images) ? record.payload.local_images : [];
      let started = null;
      if (userText || localImagePaths.length) {
        const startedAt = Date.parse(record.timestamp) || Date.now();
        const allowFollowupMatch = options.backfillStage !== 'full' || startedAt >= Date.now() - FOLLOWUP_RECONCILE_MAX_AGE_MS;
        if (allowFollowupMatch) {
          started = userText
            ? this.followups.matchStarted(threadId, userText, startedAt)
            : this.followups.matchStartedByLocalImagePaths?.(threadId, localImagePaths, startedAt);
        }
        if (started) {
          this.emit('followup.started', threadId, { ...publicItem(started), startedAt }, started.sourceDeviceId);
          this.noteMatchedRolloutFollowupStarted(threadId, file, startedAt);
        }
      }
      if (this.trackCodexWaiting(threadId, record)) streamWaitingChanged = true;
      const value = rolloutItem(record) || (options.backfillStage && legacyVisibleRecord(record) ? HIDDEN_ITEM : null);
      if (!value) continue;
      if (value.type === 'codexQuestion' && !options.backfillStage) this.announceCodexQuestion(threadId, record, value);
      if (value.type === 'userMessage' && started?.attachments?.length) {
        const images = readHistoryAttachmentPreviews(started.attachments);
        if (images.length) value.images = images;
        this.releaseFollowupAttachments(started);
      } else if (value.type === 'userMessage' && localImagePaths.length) {
        const images = readHistoryAttachmentPreviews(localImagePaths.map((localPath) => ({
          name: String(localPath || '').split(/[\\/]/).pop()?.replace(/^[0-9a-f-]{36}-/i, '') || '图片附件',
          path: String(localPath || ''), mimeType: 'image/png',
        })));
        if (images.length) value.images = images;
      }
      const time = Date.parse(record.timestamp) || Date.now();
      sameTime = time === lastTime ? sameTime + 1 : 0; lastTime = time;
      const itemId = record.payload?.id || crypto.createHash('sha256').update(line).digest('hex');
      const item = { id: itemId, order: time * 1000 + sameTime, createdAt: time,
        ...await this.historyItemFrame(threadId, itemId, value) };
      await syncMetadata();
      await addItem(item);
      itemCount += 1;
    }
    await flush();
    if (streamWaitingChanged) { this.desktopMetadataAt.set(threadId, 0); metadataSynced = false; await syncMetadata(); }
    if (latestRolloutSettings) {
      this.publishRolloutThreadSettings(threadId, latestRolloutSettings.settings, latestRolloutSettings.updatedAt);
    }
    const completedOffset = trailingCursor ?? end;
    this.rolloutOffsets.set(file, completedOffset);
    if (trailingCursor !== null) this.rolloutPartialOffsets.set(file, trailingCursor);
    else this.rolloutPartialOffsets.delete(file);
    // A streaming replay can spend seconds reading an old range while Codex
    // appends the current turn. The range may end on the previous turn's
    // task_complete, which used to overwrite the live state. Re-read the
    // complete current tail and make that the only status authority. The
    // replay cursor remains `end`, so newly appended bytes are processed by
    // the watcher rather than skipped.
    const authoritative = readRolloutEvidence(file, 16 * 1024 * 1024);
    if (authoritative?.status) status = authoritative.status;
    const statusSize = authoritative?.size || end;
    if (!status && firstRead) status = latestRolloutStatus(file, statusSize);
    if (status) {
      if (this.desktopActiveThreads?.has(threadId) && isTerminalRolloutStatus(status) && !rolloutHasTurnStartMarker(file, statusSize)) {
        if (itemCount) this.emit('history.updated', threadId, { threadId, itemCount, updatedAt: lastTime || Date.now() });
        return trailingCursor !== null ? { partial: true, threadId, offset: trailingCursor } : true;
      }
      if (sameRolloutFile(this.rolloutFilesByThread.get(threadId), file)) this.publishRolloutStatus(threadId, this.turnStatus(threadId, status), file, authoritative, false, { quiet: this.rolloutInheritedQuiet(threadId, status, authoritative) });
    }
    if (itemCount) this.emit('history.updated', threadId, { threadId, itemCount, updatedAt: lastTime || Date.now() });
    return trailingCursor !== null ? { partial: true, threadId, offset: trailingCursor } : true;
  }

  async syncRecentRolloutTailDuringBackfill(threadId, file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (!stat.size) return;
    const startOffset = Math.max(0, stat.size - LIVE_ROLLOUT_TAIL_BYTES);
    // The full replay already owns this thread's serialized rollout queue.
    // Re-enter the worker directly: queueing another sync here would make the
    // full replay wait for a tail that is itself waiting for the full replay.
    const partials = this.rolloutPartialOffsets ||= new Map();
    const hadPartial = partials.has(file);
    const fullPartial = partials.get(file);
    partials.delete(file); // The full replay's boundary must not rewind this tail.
    try {
      await this.performDesktopRolloutSync(threadId, file, {
        allowBackfill: true,
        startOffset,
        actualSize: stat.size,
        backfillStage: 'live-tail',
      });
    } finally {
      if (hadPartial) partials.set(file, fullPartial);
      else partials.delete(file);
    }
  }

  requestHistoryBackfill(threadId) {
    if (!validThreadId(threadId)) throw new Error('缺少有效任务 ID');
    const file = this.rolloutFilesByThread?.get(threadId) || this.findRolloutFile(threadId);
    if (!file) return { synced: false, queued: false, threadId, mode: 'unavailable' };
    let stat;
    try { stat = fs.statSync(file); } catch { return { synced: false, queued: false, threadId, mode: 'unavailable' }; }
    const previous = this.historyBackfills.get(threadId);
    const activityAt = Number(readConversationActivityAt(file)) || 0;
    const previousIsFresh = previous?.version >= HISTORY_BACKFILL_VERSION &&
      previous.file === file && previous.size >= stat.size && Number(previous.activityAt) === activityAt;
    if (previousIsFresh && previous.stage === 'full') {
      return { synced: true, queued: false, threadId, mode: 'full-history', already: true };
    }
    // Very large rollouts intentionally stop after their bounded recent tail.
    // Once that tail is known to be current, do not reparse the same 32 MiB on
    // every conversation open.  A size/activity change invalidates this fast path
    // so the next request (or watcher) picks up appended records normally.
    if (previousIsFresh && previous.stage === 'recent-tail-only' && stat.size > HISTORY_FULL_REPLAY_MAX_BYTES) {
      return { synced: true, queued: false, threadId, mode: 'recent-tail', already: true };
    }
    if (this.historyBackfillPromises.has(threadId)) {
      return { synced: false, queued: true, threadId, mode: 'full-history' };
    }
    this.rolloutFilesByThread?.set(threadId, file);
    // Open the newest bounded tail first. The old implementation set offset=0
    // and let syncDesktopRollout allocate the entire unread range; a single
    // multi-gigabyte rollout could therefore stop the connector before the
    // phone ever received the latest messages. The full replay below is still
    // durable, but it starts only after this fast tail has been published.
    const tailStart = Math.max(0, stat.size - HISTORY_RECENT_TAIL_BYTES);
    const deferFullReplay = stat.size > HISTORY_FULL_REPLAY_MAX_BYTES;
    const promise = (async () => {
      let fullCompleted = tailStart === 0;
      const tailResult = await this.syncDesktopRollout(threadId, file, {
        allowBackfill: true,
        startOffset: tailStart,
        backfillStage: 'tail',
      });
      if (tailResult?.partial) {
        // The rollout currently ends in an incomplete JSONL record. Keep the
        // saved cursor at that record's line start; the file watcher will retry
        // after Codex appends its terminating newline. Do not mark the digest
        // complete while the tail is still partial.
        this.emit('history.updated', threadId, {
          threadId,
          itemCount: 0,
          updatedAt: Date.now(),
          recentHistory: true,
          historyPartial: true,
        });
        return;
      }
      if (tailResult !== true) {
        // A hidden/removed rollout can make the bounded sync a no-op. Do not
        // persist a recent-tail-only digest in that case: the next request
        // must remain retryable instead of being reported as already synced.
        this.emit('history.sync.failed', threadId, {
          threadId,
          reason: '最近历史同步未完成',
          retryAt: Date.now() + 5_000,
        });
        return;
      }
      if (this.stopping) return;
      this.emit('history.updated', threadId, { threadId, itemCount: 0, updatedAt: Date.now(), recentHistory: true });
      // Give websocket heartbeats and any newly arrived command a scheduling
      // turn before beginning the potentially long historical replay.
      await yieldToEventLoop();
      if (tailStart > 0 && deferFullReplay) {
        // Keep the connector responsive for very large sessions. The live
        // watcher will continue syncing appended records, while the server's
        // already-cached pages provide older history on demand.
        const deferred = fs.statSync(file);
        this.historyBackfills.set(threadId, {
          version: HISTORY_BACKFILL_VERSION,
          file,
          size: deferred.size,
          activityAt: Number(readConversationActivityAt(file)) || 0,
          stage: 'recent-tail-only',
        });
        this.saveHistoryDigests();
        this.emit('history.updated', threadId, {
          threadId,
          itemCount: 0,
          updatedAt: Date.now(),
          recentHistory: true,
          historyDeferred: true,
        });
        return;
      }
      if (tailStart > 0) {
        // A graceful shutdown may happen after the recent tail has been
        // published. Do not mark the digest complete unless the full pass
        // really ran; the next connector must repair the historical prefix.
        if (this.stopping) return;
        // Keep the retry cursor at the beginning while full replay is in
        // flight. If the API or connector fails halfway through, the final
        // watcher callback will re-enter the bounded streaming path instead of
        // advancing past the unsaved historical prefix.
        this.rolloutOffsets.set(file, 0);
        const fullResult = await this.syncDesktopRollout(threadId, file, { allowBackfill: true, startOffset: 0, backfillStage: 'full' });
        if (fullResult !== true) return;
        fullCompleted = true;
      }
      if (!fullCompleted || this.stopping) return;
      const done = fs.statSync(file);
      this.historyBackfills.set(threadId, { version: HISTORY_BACKFILL_VERSION, file, size: done.size, activityAt: Number(readConversationActivityAt(file)) || 0, stage: 'full' });
      this.saveHistoryDigests();
      this.emit('history.updated', threadId, { threadId, itemCount: 0, updatedAt: Date.now(), fullHistory: true });
    })().catch((error) => {
      // A queued history.sync must not become a silent dead end when a
      // transient file/API error interrupts the background replay. Let the
      // phone clear its in-flight marker and present a retryable state.
      this.emit('history.sync.failed', threadId, {
        threadId,
        reason: String(error?.message || error || '历史同步失败'),
        retryAt: Date.now() + 5_000,
      });
      this.log(error);
    }).finally(() => {
      this.historyBackfillPromises.delete(threadId);
      if (!this.stopping) this.syncDesktopRollout(threadId, file).catch((error) => this.log(error));
    });
    this.historyBackfillPromises.set(threadId, promise);
    return { synced: false, queued: true, threadId, mode: 'full-history' };
  }

  findRolloutFile(threadId) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const root = path.join(codexHome, 'sessions');
    for (const file of recentRolloutFiles(root, 1000)) if (sessionThreadId(file) === threadId) return file;
    return null;
  }

  currentRolloutOffset(threadId) {
    const file = this.rolloutFilesByThread?.get(threadId);
    if (!file) return null;
    try { return fs.statSync(file).size; } catch { return null; }
  }

  reconcileStartedRolloutChecks() {
    for (const [threadId, deadline] of this.startedRolloutChecks || []) {
      if (Date.now() > deadline) {
        this.startedRolloutChecks.delete(threadId);
        continue;
      }
      if (!(this.followups?.items || []).some((item) => item.threadId === threadId && item.state === 'started')) {
        this.startedRolloutChecks.delete(threadId);
        continue;
      }
      const file = this.rolloutFilesByThread?.get(threadId) || localCodexThread(threadId).path;
      if (!file) continue;
      this.rolloutFilesByThread ||= new Map();
      this.rolloutFilesByThread.set(threadId, file);
      try { this.reconcileStartedFollowups(threadId, file, { onlyStarted: true, maxTailBytes: 16 * 1024 * 1024 }); }
      catch (error) { this.log(error); }
    }
  }

  reconcileStartedFollowups(threadId, file, options = {}) {
    if (!this.followups?.items) return;
    const candidates = this.followups.items.filter((item) => item.threadId === threadId &&
      (options.onlyStarted ? item.state === 'started' : ['desktop_queued', 'dispatching', 'pending', 'uncertain', 'started'].includes(item.state)));
    if (!candidates.length) return;
    const start = Math.max(0, Math.min(...candidates.map((item) => Number.isFinite(item.rolloutOffset) ? item.rolloutOffset : 0)));
    const fd = fs.openSync(file, 'r'); const chunkSize = 1024 * 1024; const decoder = new StringDecoder('utf8'); let position = start; let carry = '';
    try {
      const initialSize = Math.max(0, Number(fs.fstatSync(fd).size) || 0);
      if (options.maxTailBytes) position = Math.max(position, initialSize - options.maxTailBytes);
      if (position > initialSize) position = initialSize;
      if (position > 0) {
        const previous = Buffer.alloc(1);
        fs.readSync(fd, previous, 0, 1, position - 1);
        if (previous[0] !== 0x0a) {
          const probeLength = Math.max(0, Math.min(chunkSize, initialSize - position));
          if (!probeLength) return;
          const probe = Buffer.alloc(probeLength);
          const read = fs.readSync(fd, probe, 0, probe.length, position); const newline = probe.subarray(0, read).indexOf(0x0a);
          position += newline >= 0 ? newline + 1 : read;
        }
      }
      while (candidates.length) {
        const currentSize = Math.max(0, Number(fs.fstatSync(fd).size) || 0);
        if (position >= currentSize) break;
        const bufferLength = Math.max(0, Math.min(chunkSize, currentSize - position));
        if (!bufferLength) break;
        const buffer = Buffer.alloc(bufferLength);
        const read = fs.readSync(fd, buffer, 0, buffer.length, position); if (!read) break; position += read;
        const lines = `${carry}${decoder.write(buffer.subarray(0, read))}`.split(/\r?\n/); carry = lines.pop() || '';
        for (const line of lines) {
          let record; try { record = JSON.parse(line); } catch { continue; }
          const text = rolloutUserText(record); if (!text) continue;
          const startedAt = Date.parse(record.timestamp) || Date.now();
          // The display-text helpers intentionally remove the invisible
          // request marker. Inspect the original record for identity instead.
          const marker = options.onlyStarted ? requestMarkerId(JSON.stringify(record.payload || {})) : null;
          const exact = marker && candidates.find((item) => item.requestId === marker);
          const started = options.onlyStarted ? (exact && this.followups.remove(exact.id)) : this.followups.matchStarted(threadId, text, startedAt);
          if (!started) continue;
          const index = candidates.findIndex((item) => item.id === started.id); if (index >= 0) candidates.splice(index, 1);
          if (!options.onlyStarted) this.emit('followup.started', threadId, { ...publicItem(started), startedAt }, started.sourceDeviceId);
          this.noteMatchedRolloutFollowupStarted(threadId, file, startedAt);
        }
      }
    } finally { fs.closeSync(fd); }
  }

  // The phone treats a matched follow-up as running immediately. Register the
  // same state here before history upload or Desktop queue scans can block;
  // otherwise this thread is absent from the independent live-status poll.
  // If the turn already finished while the history read was delayed, publish
  // its actual terminal record instead of resurrecting it as running.
  noteMatchedRolloutFollowupStarted(threadId, file, startedAt) {
    if (!sameRolloutFile(this.rolloutFilesByThread?.get(threadId), file)) return;
    const evidence = readRolloutEvidence(file, 16 * 1024 * 1024);
    const terminalAt = Number(evidence?.statusMarker?.at) || 0;
    const watermarkAt = Number(this.rolloutTerminalWatermarks?.get(threadId)?.marker?.at) || 0;
    if (isTerminalRolloutStatus(evidence?.status) && terminalAt >= startedAt) {
      this.publishRolloutStatus(threadId, this.turnStatus(threadId, evidence.status), file, evidence, true);
    } else if (watermarkAt >= startedAt && isTerminalThreadStatusValue(this.desktopStatuses?.get(threadId))) {
      this.publishThreadStatus(threadId, this.desktopStatuses.get(threadId), true);
    } else if (evidence?.status && !isTerminalRolloutStatus(evidence.status)) {
      this.publishRolloutStatus(threadId, this.turnStatus(threadId, evidence.status), file, evidence);
    } else {
      this.publishThreadStatus(threadId, this.turnStatus(threadId, 'running'));
    }
    this.rolloutStatusScans?.delete(file);
  }

  publishThreadStatus(threadId, status, force = false, meta = null) {
    this.desktopStatuses ||= new Map();
    this.desktopQuietStatuses ||= new Set();
    if (threadId && isTerminalThreadStatusValue(status)) this.desktopApprovalPending?.delete(threadId);
    const quiet = meta?.quiet === true;
    // A silent completion (see publishRolloutStatus) only lifts the running
    // badge. The turn's real end still has to be published afterwards, even
    // though the status already reads completed.
    const replacesQuiet = !quiet && this.desktopQuietStatuses.has(threadId);
    if (!threadId || (!force && this.desktopStatuses.get(threadId) === status && !replacesQuiet)) return;
    this.desktopStatusAt ||= new Map();
    const updatedAt = Date.now();
    // Every running <-> finished change, with the code path that decided it:
    // the phone rings on each end, so a flicker here is a false reminder there.
    const previous = this.desktopStatuses.get(threadId);
    if (isLiveThreadStatus(previous) !== isLiveThreadStatus(status)) {
      const caller = (new Error().stack || '').split('\n').slice(2, 4).map((line) => line.trim().replace(/^at /, '').replace(/ \(.*\)$/, '')).join(' <- ');
      this.log(`status ${String(threadId).slice(0, 8)} ${previous || '-'} -> ${status} (${caller})`);
    }
    this.desktopStatuses.set(threadId, status);
    if (quiet) this.desktopQuietStatuses.add(threadId); else this.desktopQuietStatuses.delete(threadId);
    this.desktopStatusAt.set(threadId, updatedAt);
    const payload = { threadId, status, updatedAt };
    if (meta?.turnId) payload.turnId = String(meta.turnId);
    // The phone announces a turn's end, but not a completion inferred from silence.
    if (quiet) payload.quiet = true;
    this.emit('thread.status', threadId, payload);
    if (!isLiveThreadStatus(status) && this.codexQuestionTracker) this.publishCodexQuestionState(threadId);
    // A message queued behind this turn goes now, not at the next 3-second sweep.
    // Unknown is not proof of a turn end; do not accelerate queued retries
    // merely because of this transition. The ordinary retry rules still apply.
    const waiting = !isLiveThreadStatus(status) && !/(?:^|_)unknown$/i.test(String(status))
      ? (this.followups?.items || []).filter((item) => item.threadId === threadId && item.state === 'pending') : [];
    if (waiting.length) {
      for (const item of waiting) this.followups.update(item.id, { nextRetryAt: 0 });
      setTimeout(() => this.retryFollowups().catch((error) => this.log(error)), 300).unref?.();
    }
  }

  // The rollout status state machine starts from the last published status. When
  // that is a silent completion and the tail gives no status of its own, the
  // completion is inherited, not read from an end event: keep it quiet.
  rolloutInheritedQuiet(threadId, status, authoritative) {
    return !authoritative?.status && this.desktopQuietStatuses?.has(threadId) === true &&
      normalizeRolloutStatusValue(status) === 'completed';
  }

  codexStatusMetadata(threadId) {
    // Only these fields are needed to establish local ownership and recency;
    // no title, message text, credential or account information is read here.
    try {
      const { DatabaseSync } = require('./backends/antigravity').loadSqlite();
      const db = new DatabaseSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state_5.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT rollout_path,updated_at_ms,updated_at,originator FROM threads WHERE id=?').get(threadId);
        if (!row) return null;
        return { path: row.rollout_path, updatedAt: Number(row.updated_at_ms) || Number(row.updated_at) * 1_000 || 0, originator: row.originator };
      } finally { db.close(); }
    } catch { return null; }
  }

  readPrebootStatusHints(statusFile, requestFile) {
    return new Set([...this.readPreviousActiveThreadHints(statusFile), ...this.readPreviousActiveThreadHints(requestFile)]);
  }

  readPreviousActiveThreadHints(file) {
    try {
      if (!file || fs.statSync(file).size > 2 * 1024 * 1024) return new Set();
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = Number(snapshot.updatedAt) || 0; const now = Date.now();
      if (!at || at > now + 5_000 || now - at > 120_000) return new Set();
      const rows = snapshot.activeThreads;
      if (!Array.isArray(rows)) return new Set();
      return new Set(rows.filter((row) => typeof row?.threadId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.threadId) &&
        isLiveThreadStatus(row.status)).slice(0, 256).map((row) => row.threadId));
    } catch { return new Set(); }
  }

  async reconcilePrebootStatusHints() {
    if (!this.codexPrebootRecoveryEnabled || !this.prebootStatusHints?.size || !relayEnabled(this.config) ||
        Number(this.config?.protocolVersion) !== 2 || !this.config?.accountId || !this.config?.deviceId || !this.api?.request ||
        !this.desktopActivitySnapshotHealthy) return;
    if (this.prebootStatusHintsCheckPromise) return this.prebootStatusHintsCheckPromise;
    const now = Date.now();
    const snapshotAt = Number(this.desktopActivitySnapshotAt) || 0;
    if (!snapshotAt || snapshotAt > now + 5_000 || now - snapshotAt > 30_000) return;
    if (now < (this.prebootStatusHintsNextAt || 0)) return;
    this.prebootStatusHintsNextAt = now + 10_000;
    // Never publish IDs from an old account's local status to a new account.
    // The relay already scopes this index to the current account; additionally
    // require the row to belong to this connector and recheck identity after IO.
    const ticket = { accountId: this.config.accountId, deviceId: this.config.deviceId,
      accountKey: this.config.accountKey, serverUrl: this.config.serverUrl };
    const check = (async () => {
      const sameAccount = () => relayEnabled(this.config) && this.config?.accountId === ticket.accountId &&
        this.config?.deviceId === ticket.deviceId && this.config?.accountKey === ticket.accountKey && this.config?.serverUrl === ticket.serverUrl;
      const pending = new Set(this.prebootStatusHints);
      const found = new Map();
      let before = null; let pagesRead = 0;
      // A user's old thread can be beyond the first page. Limit both the page
      // count and each request; never conclude ownership from local data alone.
      for (let pages = 0; pages < 20 && pending.size && sameAccount(); pages += 1) {
        let page;
        try {
          const suffix = `/history/threads?limit=100${before === null ? '' : `&before=${before}`}`;
          page = await this.api.request(this.api.path(suffix), { timeoutMs: 5_000 });
          pagesRead += 1;
        } catch { return; }
        if (!sameAccount() || !Array.isArray(page?.items)) return;
        for (const row of page.items) {
          if (row && pending.has(row.id)) { found.set(row.id, row); pending.delete(row.id); }
        }
        if (page.items.length < 100 || !pending.size) break;
        const times = page.items.map((row) => Number(row?.updatedAt)).filter((value) => Number.isFinite(value) && value > 0);
        if (!times.length) break;
        const next = Math.min(...times);
        if (before !== null && next >= before) break;
        before = next;
      }
      if (!sameAccount()) return;
      const scanSummary = `preboot status recovery: pages=${pagesRead} found=${found.size} unresolved=${pending.size}`;
      if (this.prebootLastScanSummary !== scanSummary) { this.prebootLastScanSummary = scanSummary; this.log(scanSummary); }
      // Missing from a bounded or timestamp-tied page is not evidence of
      // ownership (or of its absence). Retry later without a hot scan loop.
      if (pending.size) this.prebootStatusHintsNextAt = Math.max(this.prebootStatusHintsNextAt, Date.now() + 5 * 60_000);
      for (const [threadId, row] of found) {
        if (row.connectorId !== ticket.deviceId || row.archived || isTerminalThreadStatusValue(this.desktopStatuses?.get(threadId))) {
          this.prebootStatusHints.delete(threadId); continue;
        }
        const meta = this.codexStatusMetadata(threadId);
        if (!meta?.path || String(meta.originator || '').toLowerCase() !== 'codex desktop') {
          this.prebootStatusHints.delete(threadId); continue;
        }
        const file = this.rolloutFilesByThread?.get(threadId) || meta.path;
        const evidence = readRolloutEvidence(file);
        if (!evidence) continue; // transient read error: try again later
        if (!isLiveThreadStatus(evidence.status)) { this.prebootStatusHints.delete(threadId); continue; }
        if (this.retirePrebootCodexStatus(threadId, file, evidence, meta)) {
          this.prebootStatusHints.delete(threadId); continue;
        }
        const bootAt = Number(this.systemBootAt) || 0;
        if (bootAt && (evidence.activityAt >= bootAt - STALE_ORPHAN_ROLLOUT_MS || meta.updatedAt >= bootAt - STALE_ORPHAN_ROLLOUT_MS)) {
          this.prebootStatusHints.delete(threadId); // newer work owns this status
        }
      }
    })();
    this.prebootStatusHintsCheckPromise = check;
    try { await check; } finally { if (this.prebootStatusHintsCheckPromise === check) this.prebootStatusHintsCheckPromise = null; }
  }

  // Only a local Desktop rollout last touched well before this machine's
  // current boot can be treated as abandoned. Mere silence, a missing list
  // entry or an old mtime must never turn a live task into a completion.
  // `unknown` removes the misleading running state without claiming success.
  retirePrebootCodexStatus(threadId, file, evidence, suppliedMetadata = null) {
    if (!this.codexPrebootRecoveryEnabled || !threadId || !file || !evidence || !isLiveThreadStatus(evidence.status)) return false;
    const now = Date.now(); const bootAt = Number(this.systemBootAt) || 0;
    const activityAt = Number(evidence.activityAt) || 0;
    if (!bootAt || !activityAt || now - activityAt < STALE_ACTIVE_ROLLOUT_MS ||
        bootAt - activityAt < STALE_ORPHAN_ROLLOUT_MS || now - bootAt < STALE_ORPHAN_ROLLOUT_MS) return false;
    const snapshotAt = Number(this.desktopActivitySnapshotAt) || 0;
    if (!this.desktopActivitySnapshotHealthy || !snapshotAt || snapshotAt > now + 5_000 || now - snapshotAt > 30_000) return false;
    if (this.desktopActiveThreads?.has(threadId) || this.desktopPollingActiveThreads?.has(threadId) ||
        this.threadState?.get(threadId)?.activeTurnId || this.mobileOwnedThreads?.has(threadId)) return false;
    const observedAt = Number(this.desktopThreadUpdatedAt?.get(threadId)) || 0;
    if (observedAt && observedAt >= bootAt - STALE_ORPHAN_ROLLOUT_MS) return false;
    const meta = suppliedMetadata || this.codexStatusMetadata(threadId);
    if (!meta || String(meta.originator || '').toLowerCase() !== 'codex desktop' || !sameRolloutFile(meta.path, file) ||
        !Number.isFinite(meta.updatedAt) || meta.updatedAt <= 0 || meta.updatedAt >= bootAt - STALE_ORPHAN_ROLLOUT_MS) return false;
    // The database lookup can race a newly appended turn. Re-read the current
    // tail immediately before publishing, never the older watcher slice.
    const latest = readRolloutEvidence(file);
    if (!latest || latest.size !== evidence.size || latest.activityAt !== activityAt || latest.status !== evidence.status) return false;
    this.publishThreadStatus(threadId, 'unknown', false, { quiet: true });
    this.log(`preboot status recovery: quiet unknown published for ${String(threadId).slice(0, 8)}`);
    return true;
  }

  // Publish a status observed in a rollout only when its marker is newer than
  // the last terminal marker.  This is the guard against out-of-order fs.watch
  // reads: a stale range may say "running", but without a newer task_started
  // (or user message) it still belongs to the completed turn.
  // options.quiet: the completion was inferred from a silent rollout (no end
  // event for the turn), not read from one. It clears the badge; the phone
  // does not announce it as the turn's end.
  publishRolloutStatus(threadId, status, file, evidence = null, force = false, options = null) {
    if (!threadId || !status) return false;
    if (isLiveThreadStatus(status) && this.retirePrebootCodexStatus(threadId, file, evidence)) return false;
    this.publishCodexQuestionState(threadId, evidence);
    const normalized = normalizeRolloutStatusValue(status) || status;
    this.rolloutTerminalWatermarks ||= new Map();
    const watermark = this.rolloutTerminalWatermarks.get(threadId);
    const current = normalizeRolloutStatusValue(this.desktopStatuses?.get(threadId));
    const terminalMarker = evidence?.statusMarker || null;
    const turnStartMarker = evidence?.turnStartMarker || null;
    // A fast turn can start and finish between watcher reads. If both the new
    // start and end follow the last terminal record, deliver its end once even
    // when the previous published status was also "completed".
    const completedNewTurn = Boolean(watermark && isTerminalRolloutStatus(current) &&
      isTerminalRolloutStatus(normalized) && isTerminalRolloutStatus(evidence?.status) &&
      turnStartMarker && terminalMarker &&
      compareRolloutMarkers(turnStartMarker, watermark.marker) > 0 &&
      compareRolloutMarkers(terminalMarker, watermark.marker) > 0);
    const protocolTerminalTurn = this.protocolTerminalTurns?.get(threadId);
    // A turn/completed notification can beat fs.watch's final read. The
    // protocol's explicit turn ID already proves that a range from that same
    // turn is old, even before its task_complete becomes a rollout watermark.
    if (isLiveThreadStatus(normalized) && protocolTerminalTurn &&
        (!evidence?.turnStartTurnId || evidence.turnStartTurnId === protocolTerminalTurn)) {
      this.log(`status suppressed ${String(threadId).slice(0, 8)} ${current || '-'} -> ${status} (completed protocol turn)`);
      return false;
    }
    if (watermark) {
      if (isLiveThreadStatus(normalized)) {
        // A live state is a new turn only when the rollout contains a marker
        // after the terminal record. Missing/older markers are stale reads.
        if (!turnStartMarker || compareRolloutMarkers(turnStartMarker, watermark.marker) <= 0) {
          this.log(`status suppressed ${String(threadId).slice(0, 8)} ${current || '-'} -> ${status} (stale rollout range)`);
          return false;
        }
      } else if (isTerminalRolloutStatus(normalized) && terminalMarker &&
          compareRolloutMarkers(terminalMarker, watermark.marker) <= 0 && isLiveThreadStatus(current)) {
        // An old task_complete must not close a newer live turn.
        return false;
      }
    }
    if (isTerminalRolloutStatus(normalized) && isTerminalRolloutStatus(evidence?.status) && terminalMarker) {
      const previous = this.rolloutTerminalWatermarks.get(threadId);
      if (!previous || compareRolloutMarkers(terminalMarker, previous.marker) > 0) {
        this.rolloutTerminalWatermarks.set(threadId, {
          file: file || null,
          marker: { at: terminalMarker.at || 0, ordinal: terminalMarker.ordinal || 0 },
          turnId: evidence?.statusTurnId || null,
        });
      }
    }
    this.publishThreadStatus(threadId, status, force || completedNewTurn, {
      turnId: evidence?.statusTurnId || evidence?.turnStartTurnId || null,
      quiet: options?.quiet === true,
    });
    return true;
  }

  rememberProtocolTerminalTurn(threadId, turnId) {
    if (!threadId || !turnId) return;
    this.protocolTerminalTurns ||= new Map();
    this.protocolTerminalTurns.set(threadId, String(turnId));
  }

  // A compaction Codex runs by itself (or one the phone asked for) shows a line
  // on the phone while it runs: the 'compacting' status. It does not end the
  // turn. Its end, and a failed one, only lift the line; the turn's own
  // terminal event still decides whether the turn is over.
  noteCodexCompaction(threadId, compactionStatus, params = null) {
    const turnId = params?.turn?.id || params?.turnId || null;
    if (compactionStatus === 'started') {
      this.publishThreadStatus(threadId, this.turnStatus(threadId, 'compacting'), false, { turnId });
      return;
    }
    this.emit('context.compaction', threadId, { threadId, status: compactionStatus, turnId, updatedAt: Date.now() });
    this.publishThreadStatus(threadId, this.turnStatus(threadId, 'running'), false, { turnId });
  }

  turnStatus(threadId, status) {
    // Desktop approvals belong to Desktop's app-server, so the connector's
    // separate host does not receive that approval RPC. Keep the observed
    // waiting state while the same selected Desktop task shows its prompt.
    if (status === 'running' && this.desktopApprovalPending?.has(threadId)) return 'desktop_waiting_approval';
    // connectorRunsThread also covers a phone task after a connector restart.
    return this.mobileOwnedThreads?.has(threadId) || this.isBridgeOwnedThread(threadId) || this.connectorRunsThread(threadId)
      ? mobileOwnedStatus(status)
      : desktopOwnedStatus(status);
  }

  republishActiveThreadStatuses() {
    for (const [threadId, status] of this.desktopStatuses) {
      if (isLiveThreadStatus(status)) {
        this.emit('thread.status.snapshot', threadId, { threadId, status, updatedAt: Date.now() });
      }
    }
  }

  startAgentAvailabilityWatch(periodMs = AGENT_PRESENCE_POLL_MS) {
    if (this.desktopAgentPresenceTimer) return;
    const poll = () => this.refreshAgentAvailability().catch((error) => this.log(error));
    poll();
    this.desktopAgentPresenceTimer = setInterval(poll, periodMs);
    this.desktopAgentPresenceTimer.unref?.();
  }

  async refreshAgentAvailability() {
    if (this.stopping || !this.desktopAdapter?.agentPresence) return false;
    // The adapter is serialized. Never put a presence request behind a long
    // send/probe, and never time out an in-flight command just to refresh a
    // decorative tab color.
    if (this.desktopAdapter.busy) return false;
    if (this.desktopAgentPresencePromise) return this.desktopAgentPresencePromise;
    this.desktopAgentPresencePromise = this.desktopAdapter.agentPresence().then((response) => {
      const raw = response?.agentPresence || response?.agents || {};
      const next = {
        // An app with no window but still running counts as open; see
        // desktopAppsRunning().
        codex: raw.codex === true || (raw.codex === false && this.desktopAppsRunning().codex) ? true : typeof raw.codex === 'boolean' ? raw.codex : null,
        claude: typeof raw.claude === 'boolean' ? raw.claude : null,
        antigravity: raw.antigravity === true || (raw.antigravity === false && this.desktopAppsRunning().antigravity) ? true : typeof raw.antigravity === 'boolean' ? raw.antigravity : null,
      };
      if (next.codex === null || next.claude === null || next.antigravity === null) return false;
      this.codexProfileIsolation = raw.codexProfileIsolation === true;
      const previous = this.desktopAgentPresence || {};
      const changed = ['codex', 'claude', 'antigravity'].some((id) => previous[id] !== next[id]);
      this.desktopAgentPresence = next;
      this.desktopAgentPresenceAt = Date.now();
      // The next presence tick would carry this too. Push a change
      // immediately so closing or reopening an app does not wait for a
      // phone reconnect or a slower integration-specific sync.
      if (changed && this.isConnected()) this.publishPresence({ full: true });
      return changed;
    }).catch((error) => {
      // Keep the last good snapshot across a transient adapter restart. A
      // temporary scan failure must not gray all tabs for one polling tick.
      // Log the first failure only: on a PC where the adapter cannot run it
      // would otherwise fill the log every poll.
      if (!this.desktopAgentPresenceErrorLogged && typeof this.log === 'function') {
        this.desktopAgentPresenceErrorLogged = true;
        this.log(new Error(`desktop app detection unavailable: ${error?.message || error}`));
      }
      return false;
    }).finally(() => { this.desktopAgentPresencePromise = null; });
    return this.desktopAgentPresencePromise;
  }

  // The whole presence (about 17 KB with every thread's owner) went out every
  // second, ~1 MB a minute to each phone. Now it goes out only when it changed,
  // when a phone asks (capabilities) and every PRESENCE_FULL_MS; the other
  // seconds carry a beat of who and when plus the PC load (the phone drops a
  // load reading after 20 s). The phone skips any field a beat leaves out.
  publishPresence({ full = false, sentAt = Date.now() } = {}) {
    const payload = this.presencePayload(sentAt);
    const signature = presenceSignature(payload);
    const due = full || this.presenceFullDue || signature !== this.presenceSignature
      || !(sentAt - (this.presenceFullAt || 0) < PRESENCE_FULL_MS);
    if (due) {
      this.presenceFullDue = false; this.presenceSignature = signature; this.presenceFullAt = sentAt;
      this.emit('connector.presence', null, payload);
    } else {
      this.emit('connector.presence', null, { deviceName: payload.deviceName, connectorId: payload.connectorId, sentAt, pcLoad: payload.pcLoad });
    }
    return due;
  }

  presencePayload(sentAt = Date.now()) {
    const pins = readDesktopPinState(this.desktopStateFile) || this.desktopPins;
    const claudePins = this.claudePinSnapshot?.();
    return {
      deviceName: this.config?.deviceName || null,
      connectorId: this.config?.deviceId || null,
      sentAt,
      agents: this.agentAvailabilityPayload(),
      installed: this.agentInstalledPayload(),
      // A full set clears old cached pins even if they changed while the
      // connector/phone was offline or their history row is on an old page.
      codexPins: pins ? { connectorId: this.config?.deviceId, ids: pins.ids } : null,
      claudePins: claudePins ? { connectorId: this.config?.deviceId, ids: claudePins } : null,
      pcLoad: this.pcLoad?.snapshot() || null,
      // New content cannot reach the relay (null when it can): the phone says
      // so instead of only showing the computer as connected.
      uploadIssue: this.api?.uploadIssue?.(sentAt) || null,
      lightMode: this.lightMode?.enabled() === true, lightModeAt: this.lightMode?.changedAt() || 0,
      // The phone needs an authoritative live-task set to retire cached badges
      // after a completed Desktop task is no longer present in the snapshot.
      activeThreads: this.activeThreadSnapshot(),
      // Ownership is an advisory routing projection. The native writer lock
      // remains authoritative, but replaying this snapshot lets a resumed
      // phone understand that a thread is managed by KH Link and avoid
      // mistaking the connector's own lock for a Desktop lock.
      // Only who owns each thread: the phone reads nothing else, and this is
      // the bulk of the presence.
      threadOwners: this.threadOwnership?.list?.().map((record) => ({ threadId: record.threadId, owner: record.owner })) || [],
    };
  }

  // Desktop-agent availability means that the corresponding desktop window is
  // really open. The persistent Rust adapter identifies Codex Desktop by its
  // visible OpenAI.Codex ChatGPT.exe window, Claude by the WindowsApps Claude
  // window, and Antigravity by the installed Antigravity.exe window. This is
  // deliberately separate from connector integrations: the connector's own
  // Codex app-server, an installed Claude binary, or a discovered Antigravity
  // history file must not make a closed desktop app look available.
  // Whether each agent is installed on this computer at all (not whether its
  // window is open): a phone on a fresh PC shows "install X first" instead of
  // an empty list. Cheap existence checks, cached for a minute.
  agentInstalledPayload(now = Date.now()) {
    if (this._agentInstalled && now - this._agentInstalledAt < 60_000) return this._agentInstalled;
    const home = os.homedir();
    const exists = (file) => { try { return fs.existsSync(file); } catch { return false; } };
    let claude = exists(path.join(home, '.claude'));
    if (!claude) { try { claude = claudeDataDirs().some((dir) => exists(dir)); } catch {} }
    this._agentInstalled = {
      codex: !this.codexMissing,
      claude,
      dsh: Boolean(this.dshOnline) || exists(process.env.DSH_HOME || path.join(home, '.dsh')),
      hermes: Boolean(this.hermesTransport),
      pi: Boolean(this.piOnline) || exists(path.join(home, '.pi')),
      // Antigravity keeps its conversations under ~/.gemini/antigravity.
      antigravity: exists(path.join(home, '.gemini', 'antigravity'))
        || exists(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe')),
    };
    this._agentInstalledAt = now;
    return this._agentInstalled;
  }

  // Whether a desktop app runs at all, window or tray: the Codex desktop app
  // (OpenAI.Codex's ChatGPT.exe, not the ChatGPT app) and Antigravity. The
  // window check misses both when they sit in the tray or keep no main window
  // (2026-11-07: the owner wants them shown as open). Answers from a cache and
  // refreshes it in the background at most every 30 s, so the 5 s presence
  // poll never waits for the process query.
  desktopAppsRunning(now = Date.now()) {
    if (process.platform !== 'win32') return { codex: false, antigravity: false };
    if (!this._desktopAppsCheck || now - this._desktopAppsCheck.at > 30_000) {
      this._desktopAppsCheck = { at: now, running: this._desktopAppsCheck?.running ?? { codex: false, antigravity: false } };
      const query = "$p = Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe' or Name='Antigravity.exe'\" | ForEach-Object { $_.ExecutablePath }; "
        + "'codex=' + [int][bool]($p | Where-Object { $_ -like '*\OpenAI.Codex_*' }) + ';antigravity=' + [int][bool]($p | Where-Object { $_ -like '*\Antigravity.exe' })";
      (this.desktopAppsQuery || ((done) => require('node:child_process').execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, timeout: 15_000 },
        (error, stdout) => {
          const text = String(stdout || '');
          done(error || !/codex=\d;antigravity=\d/.test(text) ? null
            : { codex: /codex=1/.test(text), antigravity: /antigravity=1/.test(text) });
        })))((running) => {
        if (running && this._desktopAppsCheck) this._desktopAppsCheck.running = running;
      });
    }
    return this._desktopAppsCheck.running;
  }

  agentAvailabilityPayload() {
    const desktop = this.desktopAgentPresence || {};
    return {
      codex: typeof desktop.codex === 'boolean' ? desktop.codex : null,
      claude: typeof desktop.claude === 'boolean' ? desktop.claude : null,
      pi: Boolean(this.piOnline),
      antigravity: typeof desktop.antigravity === 'boolean' ? desktop.antigravity : null,
      dsh: Boolean(this.dshOnline),
      ...(this.hermesTransport ? { hermes: Boolean(this.hermesOnline) } : {}),
    };
  }

  activeThreadSnapshot() {
    return [...this.desktopStatuses]
      .filter(([, status]) => isLiveThreadStatus(status))
      // Carry the desktop observation time with the snapshot. Android uses
      // this timestamp to order heartbeat snapshots against the more specific
      // thread.status events; using the phone's receive time made a stale
      // snapshot look newer than a real terminal/waiting transition.
      .map(([threadId, status]) => ({
        threadId,
        status,
        updatedAt: this.desktopStatusAt?.get(threadId) || Date.now(),
      }))
      // Claude threads with a turn in progress (run by the connector or the
      // desktop). Without them the phone's authoritative snapshot would retire
      // their running badge every heartbeat.
      .concat(this.claudeActiveThreadRows?.() || [])
      // And Pi's: without them the running badge and stop button of a Pi turn
      // were cleared on every heartbeat, a second after being set.
      .concat(this.piActiveThreadRows?.() || [])
      .concat(this.antigravityActiveThreadRows?.() || [])
      .concat(this.dshActiveThreadRows?.() || [])
      .concat(this.hermesActiveThreadRows?.() || [])
      .sort((left, right) => left.threadId.localeCompare(right.threadId));
  }

  // Every agent's waiting messages. The phone replaces its whole queue list
  // with a snapshot, so a snapshot of Codex's alone wiped Claude's and Pi's.
  phoneQueueItems(threadId = null) {
    return [...this.allFollowupItems(threadId), ...this.claudeQueueItems(threadId), ...(this.piQueueItems?.(threadId) || []), ...(this.antigravityQueueItems?.(threadId) || []), ...(this.sendReceipts?.visible(threadId) || [])]
      .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  }

  allFollowupItems(threadId = null) {
    const local = this.followups.list(threadId || null);
    const mirrored = [...(this.desktopQueueItems || new Map()).values()]
      .filter((item) => !threadId || item.threadId === threadId);
    return [...local, ...mirrored].sort((left, right) => left.createdAt - right.createdAt);
  }

  async syncNativeDesktopQueues(activeThreads) {
    if (!activeThreads.length || !this.desktopAdapter?.listQueued) return;
    this.threadState ||= new Map();
    const byTitle = new Map();
    for (const thread of activeThreads) {
      if (!thread.title) continue;
      const matches = byTitle.get(thread.title) || [];
      matches.push(thread); byTitle.set(thread.title, matches);
    }
    const unique = [...byTitle.entries()]
      .filter(([, threads]) => threads.length === 1)
      .map(([, threads]) => threads[0]);
    if (!unique.length) return;
    // The adapter answers one request at a time; while it is sending or
    // switching tasks a scan would only time out behind it. Try next tick.
    if (this.desktopAdapter.busy) return;
    let snapshot;
    try { snapshot = await this.desktopAdapter.listQueued(unique); this.queueScanFailures = 0; }
    catch (error) {
      // A single slow scan is harmless; report only when it keeps failing.
      this.queueScanFailures = (this.queueScanFailures || 0) + 1;
      if (this.queueScanFailures === 3) this.log(new Error(`Desktop queue scan keeps failing: ${error.message}`));
      return;
    }
    const activeTitle = String(snapshot?.activeTitle || '');
    const matching = activeTitle ? byTitle.get(activeTitle) || [] : [];
    if (matching.length !== 1) return;
    const thread = matching[0];
    this.applyDesktopApprovalObservation?.(thread.id, snapshot?.reason);
    const desktopMode = String(snapshot?.effectiveCollaborationMode || '').toLowerCase();
    if (desktopMode === 'plan' || desktopMode === 'default') {
      const state = this.threadState.get(thread.id) || {};
      const currentSettings = publicThreadSettings(state);
      const pendingMode = state.pendingDesktopSettings?.collaborationMode;
      // The background thread/settings response is authoritative for a mode
      // selected from mobile. The native adapter is only a best-effort
      // observer and may still report the old foreground value for one or
      // more polling cycles; never let that revert a confirmed protocol mode.
      if (!pendingMode && state.modeSyncSource !== 'protocol' && currentSettings.effectiveCollaborationMode !== desktopMode) {
        const nextState = {
          ...state,
          collaborationMode: desktopMode,
          effectiveCollaborationMode: desktopMode,
          desiredCollaborationMode: desktopMode,
          modeSyncSource: 'desktop',
          modeSyncState: 'applied',
          modeSyncReason: null,
        };
        this.threadState.set(thread.id, nextState);
        this.emit('thread.settings', thread.id, {
          threadId: thread.id,
          settings: publicThreadSettings(nextState),
          nextTurn: true,
          source: 'desktop',
          updatedAt: Date.now(),
        });
      }
    }
    const current = this.desktopQueueItems || new Map(); const next = new Map(current);
    for (const [id, item] of next) if (item.threadId === thread.id) next.delete(id);
    const localItems = this.followups.list(thread.id);
    for (const row of Array.isArray(snapshot?.items) ? snapshot.items : []) {
      const text = String(row?.text || '').trim(); const normalized = normalizeText(text);
      // The native queue can echo the same message with Desktop's injected
      // context/request marker. Match it against the durable mobile row before
      // mirroring; otherwise the phone briefly shows one local row and one
      // `desktop:` row while the queue scanner catches up.
      if (!normalized || localItems.some((item) => queuedTextsMatch(item.text, text))) continue;
      const id = `desktop:${thread.id}:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
      const previous = current.get(id);
      next.set(id, {
        id, requestId: id, threadId: thread.id, title: thread.title, text,
        mode: 'queue', state: 'desktop_queued', origin: 'desktop', reason: null,
        createdAt: previous?.createdAt || Date.now() + Number(row?.order || 0),
      });
    }
    const before = JSON.stringify([...current.values()]); const after = JSON.stringify([...next.values()]);
    this.desktopQueueItems = next;
    if (before !== after) this.emit('followup.snapshot', null, { items: this.phoneQueueItems() });
  }

  // Only a snapshot of a uniquely identified, currently visible Desktop task
  // can set or clear this state. Missing/old adapter responses are not proof.
  applyDesktopApprovalObservation(threadId, reason, source = 'desktop_ui') {
    const current = this.desktopStatuses?.get(threadId);
    if (reason === 'desktop_approval_pending') {
      // After a connector restart an approval may have been waiting longer
      // than the rollout bootstrap window, so there may be no cached status.
      // A fresh, uniquely matched Desktop observation is positive evidence;
      // however, never reopen an explicitly completed/failed turn from it.
      if (current && !/^desktop_(running|waiting_approval)$/i.test(String(current))) return;
      this.desktopApprovalPending ||= new Map();
      const sources = this.desktopApprovalPending.get(threadId) || new Set();
      sources.add(source); this.desktopApprovalPending.set(threadId, sources);
      this.publishThreadStatus(threadId, 'desktop_waiting_approval');
    } else if (reason === 'desktop_approval_clear') {
      const sources = this.desktopApprovalPending?.get(threadId);
      if (!sources?.delete(source)) return;
      if (!sources.size) {
        this.desktopApprovalPending.delete(threadId);
        if (current === 'desktop_waiting_approval') this.publishThreadStatus(threadId, 'desktop_running');
      }
    }
  }

  async syncDesktopSession(threadId) {
    if (this.desktopSyncRunning) { this.pendingDesktopThreads.add(threadId); return; }
    this.desktopSyncRunning = true;
    let current = threadId;
    try {
      while (current && !this.stopping) {
        try {
          // Reuse the connector's single Codex transport. Starting a second
          // app-server for a history read can become a competing writer and
          // is exactly the class of restart failure this lifecycle protects.
          const detail = await this.codex.request('thread/read', { threadId: current, includeTurns: false }, 30_000);
          const thread = detail.thread || detail;
          await this.syncThread(thread, Boolean(thread.archived), null, true);
        } catch (error) { this.log(error); }
        current = this.pendingDesktopThreads.values().next().value || null;
        if (current) this.pendingDesktopThreads.delete(current);
      }
    } finally { this.desktopSyncRunning = false; }
  }

  log(error) {
    // Keep the top of the stack: it is the only trail left in the background log
    // when a turn or sync fails. Many call sites log informational Errors, so a
    // few frames are enough to locate the source without flooding the file.
    let detail = error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : String(error?.message ?? error);
    if (detail.length > 4000) detail = `${detail.slice(0, 4000)}…`;
    // The same failure repeating every poll is logged once per 10 minutes,
    // with a count of what was left out.
    const key = detail.split('\n')[0].slice(0, 200);
    this._logSeen ||= new Map();
    const now = Date.now(); const seen = this._logSeen.get(key);
    if (seen && now - seen.at < LOG_REPEAT_WINDOW_MS) { seen.skipped += 1; return; }
    if (this._logSeen.size > 500) this._logSeen.clear();
    this._logSeen.set(key, { at: now, skipped: 0 });
    if (seen?.skipped) detail = `${detail}\n  (前 10 分钟内同样的消息又出现 ${seen.skipped} 次，已省略)`;
    console.error('[fengzhu-connect]', detail);
  }

  // Which backend owns a thread. Threads created before backends were tracked,
  // and all Codex threads, resolve to the default (codex). A thread's backendId
  // is recorded in threadState when it is created by a specific backend.
  threadBackendId(threadId) {
    // threadState is in-memory; after a connector restart the persisted Claude
    // thread index is what keeps a Claude thread off the Codex path.
    return this.threadState?.get(threadId)?.backendId
      || (this.claudeThreads?.has(threadId) ? 'claude'
        : this.piThreads?.has(threadId) ? 'pi' : this.antigravityThreads?.has(threadId) ? 'antigravity'
          : this.dshThreads?.has(threadId) ? 'dsh' : this.hermesThreads?.has(threadId) ? 'hermes' : this.defaultBackendId);
  }

  async readConversationUsage(threadId, sourceDeviceId = null, historyFrom = 0) {
    if (!threadId) throw new Error('缺少对话 ID');
    const backend = this.threadBackendId(threadId) || 'codex';
    let file = null;
    if (backend === 'codex') file = this.rolloutFilesByThread?.get(threadId) || localCodexThread(threadId).path;
    if (backend === 'claude') {
      const meta = this.claudeThreads?.get(threadId);
      file = meta?.transcriptFile || (meta?.sessionId ? usageTranscriptPath(meta.workdir, meta.sessionId, this.claudeDesktop?.projectsRoot) : null);
    }
    if (backend === 'pi') file = this.piThreads?.get(threadId)?.sessionFile || null;
    this.conversationUsageReader ||= new ConversationUsageReader();
    const work = this.conversationUsageReader.read(backend, file, { historyFrom }).catch(error => {
      this.log(error);
      return { schemaVersion: 1, backend, status: 'unavailable', reason: '对话用量记录暂时无法读取，请稍后重试' };
    });
    // Large Claude/Pi histories must not hold up a phone command or the
    // connector's heartbeat. Finish asynchronously and send the same encrypted
    // per-device result; future reads reuse the ongoing scan or byte offset.
    let timer;
    const result = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), 3_000); })]);
    clearTimeout(timer);
    const connectorId = this.config?.deviceId || this.api?.config?.deviceId || null;
    if (result) return { ...result, connectorId };
    work.then(value => { if (!this.stopping) this.emit('thread.usage', threadId, { ...value, connectorId }, sourceDeviceId); });
    return { schemaVersion: 1, backend, connectorId, status: 'scanning', reason: '正在整理此对话的用量记录' };
  }

  backendForThread(threadId) {
    return this.backends.get(this.threadBackendId(threadId)) || this.backend;
  }

  // ---- Claude thread persistence ----
  readClaudeThreads() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.claudeThreadsFile, 'utf8'));
      return new Map(Array.isArray(raw?.threads) ? raw.threads.map((t) => [t.id, t]) : []);
    } catch { return new Map(); }
  }

  // Transcript reads mark the metadata dirty several times a second while a
  // session is being written; coalesce them into at most one write a second
  // (each write is ~60 KB plus a rename, slow on a busy disk).
  saveClaudeThreads() {
    if (this._claudeThreadsSaveTimer) return;
    this._claudeThreadsSaveTimer = setTimeout(() => {
      this._claudeThreadsSaveTimer = null;
      this._claudeThreadsWrite = (this._claudeThreadsWrite || Promise.resolve())
        .then(() => this.writeClaudeThreadsAsync()).catch((error) => this.log(error));
    }, 1000);
    this._claudeThreadsSaveTimer.unref?.();
  }

  // The periodic save runs off the event loop: a synchronous write + rename
  // once took 25 s on a busy disk and stalled the connector (2026-10-09 05:18).
  async writeClaudeThreadsAsync() {
    if (this._claudeThreadsClosing) return;
    const temporary = `${this.claudeThreadsFile}.${process.pid}.async.tmp`;
    const body = JSON.stringify({ threads: [...this.claudeThreads.values()] });
    await fs.promises.writeFile(temporary, body, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      // A synchronous shutdown flush wrote newer data meanwhile: keep it.
      if (this._claudeThreadsClosing) { await fs.promises.rm(temporary, { force: true }); return; }
      try { await fs.promises.rename(temporary, this.claudeThreadsFile); return; } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) {
          await fs.promises.rm(temporary, { force: true });
          if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) return this.flushClaudeThreads();
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  }

  flushClaudeThreads({ required = false } = {}) {
    clearTimeout(this._claudeThreadsSaveTimer); this._claudeThreadsSaveTimer = null;
    try {
      const temporary = `${this.claudeThreadsFile}.${process.pid}.tmp`;
      const body = JSON.stringify({ threads: [...this.claudeThreads.values()] });
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      // Windows refuses the rename (EPERM/EBUSY) while another process briefly
      // holds the target open; retry, then fall back to writing it in place.
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(temporary, this.claudeThreadsFile); return; } catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
          if (attempt >= 4) { fs.writeFileSync(this.claudeThreadsFile, body, { mode: 0o600 }); try { fs.unlinkSync(temporary); } catch { /* gone */ } return; }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
        }
      }
    } catch (error) { if (required) throw error; this.log(error); }
  }

  upsertClaudeThread(threadId, changes) {
    const meta = { id: threadId, title: '', workdir: '', model: '', approveMode: 'manual', sessionId: null, archived: false, updatedAt: Date.now(), ...(this.claudeThreads.get(threadId) || {}), ...changes, updatedAt: Date.now() };
    this.claudeThreads.set(threadId, meta);
    this.saveClaudeThreads();
    return meta;
  }

  // Subscribe to ClaudeBackend's normalized events and forward them as frames.
  // Claude threads are always mobile-owned. Frames carry backend:'claude' (P5) so
  // the phone can tell them apart; item/error use neutral agent.* kinds.
  wireClaudeBackend() {
    if (!this.claude || this._claudeWired) return;
    this._claudeWired = true;
    const c = this.claude;
    c.on('status', ({ threadId, status }) => {
      const meta = this.claudeThreads.get(threadId);
      if (meta) this.upsertClaudeThread(threadId, { lastStatus: status, lastStatusAt: Date.now(), activityAt: Date.now() });
      const state = this.threadState.get(threadId) || {};
      this.threadState.set(threadId, { ...state, activeTurnId: status === 'running' ? (state.activeTurnId || 'claude-turn') : null });
      this.emit('thread.status', threadId, { threadId, status: mobileOwnedStatus(status), backend: 'claude', updatedAt: Date.now() });
    });
    c.on('item', ({ threadId, item }) => {
      this.emit('agent.event', threadId, { threadId, backend: 'claude', item, updatedAt: Date.now() });
      // History comes from the Claude Code transcript (same source the desktop
      // uses); threads persisted item-by-item before that keep the old path.
      if (this.isLegacyLiveClaudeThread(this.claudeThreads.get(threadId))) this.persistClaudeItem(threadId, item).catch((e) => this.log(e));
      else this.scheduleClaudeTranscriptSync(threadId);
    });
    c.on('rateLimit', ({ info }) => { try { this.onClaudeRateLimit(info); } catch (error) { this.log(error); } });
    c.on('session', ({ threadId, sessionId }) => {
      if (!sessionId || this.claudeThreads.get(threadId)?.sessionId === sessionId) return;
      this.setClaudeThreadFields(threadId, { sessionId, transcriptWatched: true }); this.saveClaudeThreads();
    });
    c.on('approval', ({ threadId, requestId, tool, input, summary }) =>
      this.emit('approval.request', threadId, { threadId, backend: 'claude', requestId, method: 'claude/can_use_tool', request: { type: 'tool', tool, input, summary }, updatedAt: Date.now() }));
    c.on('question', ({ threadId, requestId, questions }) =>
      this.emit('approval.request', threadId, { threadId, backend: 'claude', requestId, method: 'claude/ask_user_question', request: { type: 'question', questions }, updatedAt: Date.now() }));
    c.on('error', ({ threadId, message, terminal }) => this.emit('agent.error', threadId, { threadId, backend: 'claude', error: message, terminal: !!terminal, updatedAt: Date.now() }));
    c.on('turnComplete', ({ threadId, sessionId }) => {
      if (sessionId) this.upsertClaudeThread(threadId, { sessionId });
      this.registerClaudeThreadOnDesktop(threadId);
      this.scheduleClaudeTranscriptSync(threadId, 300);
      const state = this.threadState.get(threadId) || {};
      this.threadState.set(threadId, { ...state, activeTurnId: null });
      this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
      this.emit('control.release', threadId, { reason: 'turn/completed', backend: 'claude' });
      // Send the next queued mobile instruction once the turn has settled.
      setImmediate(() => this.drainClaudeQueue(threadId));
    });
  }

  // Re-attach a persisted Claude thread to the backend (e.g. after a restart).
  ensureClaudeSession(threadId) {
    if (!threadId || typeof this.claude?.hasThread !== 'function' || this.claude.hasThread(threadId)) return;
    const meta = this.claudeThreads.get(threadId);
    if (!meta) throw new Error('找不到这个 Claude 任务（可能已在其他电脑创建）');
    this.claude.adoptThread({ threadId, workdir: meta.workdir, sessionId: meta.sessionId, approveMode: meta.approveMode, model: meta.model, effort: meta.effort });
  }

  claudeSettingsResult(threadId) {
    const meta = this.claudeThreads.get(threadId) || {};
    // A choice still waiting for the desktop's running turn to end is shown
    // as the setting, so the phone does not appear to have dropped it.
    const pending = meta.pendingDesktopSettings || {};
    const pick = (key) => (Object.prototype.hasOwnProperty.call(pending, key) ? pending[key] : meta[key]) || '';
    return { model: pick('model'), effort: pick('effort'), permissionMode: normalizePermissionMode(meta.approveMode), backend: 'claude',
      pendingDesktop: Object.keys(pending).length > 0, updatedAt: Date.now() };
  }

  // Route a command that targets a Claude thread. Codex behaviour is untouched.
  async executeClaudeCommand(action, args) {
    const workdir = args.cwd || args.workdir || this.config.workspace;
    if (args.threadId && !['thread.new', 'thread.newWithTurn', 'thread.list'].includes(action)) this.ensureClaudeSession(args.threadId);
    switch (action) {
      case 'thread.new':
      case 'thread.newWithTurn': {
        const { threadId } = this.claude.newThread({ workdir, approveMode: args.permissionMode || args.mode || 'manual', model: args.model, effort: args.effort });
        this.threadState.set(threadId, { backendId: 'claude', model: args.model, permissionMode: args.permissionMode || args.mode || 'manual' });
        this.upsertClaudeThread(threadId, { origin: 'phone', createdAt: Date.now(), title: args.title || String(args.text || '').trim().slice(0, 40) || 'Claude 任务', workdir, model: args.model || '', effort: args.effort || '', approveMode: args.permissionMode || args.mode || 'manual' });
        this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
        if (action === 'thread.new') return { thread: { id: threadId }, threadId, backend: 'claude' };
        const parts = this.claudeAttachmentParts(args); const images = parts.images;
        // A current Claude Desktop owns the authenticated session. Route a
        // new phone task through its official Code deep link so this machine's
        // desktop-injected login is used without reading or copying tokens.
        // Attachments supplied as local paths are supported by the UI script;
        // in-memory image data still falls back to the existing CLI path.
        if (images.length === parts.imagePaths.length && typeof this.startClaudeDesktopNewSession === 'function') {
          let desktopTurn;
          try { desktopTurn = await this.startClaudeDesktopNewSession(threadId, { ...args, text: parts.text, imagePaths: parts.imagePaths, cwd: workdir }); }
          catch (error) {
            // Nothing reached the desktop: the row made for this task would
            // stay in the phone's list as an empty task. Put it away.
            if (error?.delivery === 'not_sent') {
              this.setClaudeThreadFields?.(threadId, { archived: true, pinned: false, pinOrder: -1 });
              this.syncClaudeThreadMetadata(threadId).catch((e) => this.log(e));
            }
            throw error;
          }
          if (desktopTurn?.requiresConfirmation) return { threadId, requiresConfirmation: desktopTurn.requiresConfirmation, backend: 'claude' };
          if (desktopTurn) return { threadId, turn: desktopTurn, backend: 'claude' };
        }
        const turn = this.claude.startTurn(threadId, { text: parts.text, images, approveMode: args.permissionMode || args.mode, model: args.model, effort: args.effort });
        this.persistClaudeUserMessage(threadId, parts.text, images);
        return { threadId, turn, backend: 'claude' };
      }
      case 'turn.start': {
        // Held open on the desktop: type it into the desktop session (no fork).
        const viaDesktop = await this.deliverClaudeToDesktop(args.threadId, args);
        if (viaDesktop) return viaDesktop;
        const meta = this.claudeThreads.get(args.threadId) || {};
        const parts = this.claudeAttachmentParts(args); const images = parts.images;
        const turn = this.claude.startTurn(args.threadId, { text: parts.text, images, approveMode: meta.approveMode, model: meta.model, effort: meta.effort });
        this.persistClaudeUserMessage(args.threadId, parts.text, images);
        this.upsertClaudeThread(args.threadId, {});
        this.syncClaudeThreadMetadata(args.threadId).catch((e) => this.log(e));
        return turn;
      }
      case 'turn.steer': {
        const viaDesktop = await this.deliverClaudeToDesktop(args.threadId, args);
        if (viaDesktop) return viaDesktop;
        const parts = this.claudeAttachmentParts(args); const images = parts.images;
        const turn = this.claude.steerTurn(args.threadId, { text: parts.text, images });
        this.persistClaudeUserMessage(args.threadId, parts.text, images);
        return turn;
      }
      case 'turn.stop': {
        if (!this.claude.isRunning?.(args.threadId)) {
          const viaDesktop = await this.interruptClaudeOnDesktop(args.threadId);
          if (viaDesktop) return viaDesktop;
        }
        return { interrupted: this.claude.interruptTurn(args.threadId) };
      }
      case 'claude.desktop.answer': {
        console.log(`[fengzhu-connect] desktop prompt answer requested: ${args.choice || (args.answers ? `${args.answers.length} question(s)` : (args.choices || []).join('|'))}`);
        try {
          const answered = await this.answerClaudeOnDesktop(args.threadId, args);
          console.log(answered?.refreshed ? '[fengzhu-connect] desktop prompt refreshed; no action taken' : '[fengzhu-connect] desktop prompt answered');
          return answered;
        } catch (error) { this.log(`desktop prompt answer refused: ${error.message}`); throw error; }
      }
      case 'claude.desktop.trust':
        return this.confirmClaudeWorkspaceTrust(args.threadId);
      case 'claude.desktop.trust.cancel':
        return this.cancelClaudeWorkspaceTrust(args.threadId);
      case 'claude.desktop.open':
        return this.openClaudeOnDesktop(args.threadId);
      case 'claude.desktop.read':
        return this.readClaudeDesktopPrompt(args.threadId);
      case 'thread.list': {
        const threads = [...this.claudeThreads.values()].filter((t) => args.archived ? t.archived : !t.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, backend: 'claude' }));
        return { threads };
      }
      case 'thread.read':
        await this.syncClaudeTranscript(args.threadId, { watch: true }).catch((e) => this.log(e));
        return { threadId: args.threadId, backend: 'claude', items: [], thread: this.claudeThreads.get(args.threadId) || null };
      case 'thread.settings.read':
        return this.claudeSettingsResult(args.threadId);
      case 'settings.set': {
        const s = args.settings || {};
        const changes = {};
        // For Claude an explicit '' means "use the CLI default", so presence (not truthiness) matters.
        if (Object.prototype.hasOwnProperty.call(s, 'model')) changes.model = String(s.model || '');
        const effort = s.effort ?? s.reasoningEffort;
        if (effort !== undefined) changes.effort = String(effort || '');
        if (s.permissionMode) changes.approveMode = s.permissionMode;
        const claudeMeta = this.claudeThreads.get(args.threadId);
        if (claudeMeta?.desktopId && await this.desktopShouldTakeClaudeSession(claudeMeta.sessionId)) {
          // The desktop runs this session: switch model / effort / permission
          // mode there, in the desktop's own session.
          const desktopChanges = {};
          if (changes.model !== undefined && changes.model !== (claudeMeta.model || '')) desktopChanges.model = changes.model;
          if (changes.effort !== undefined && changes.effort !== (claudeMeta.effort || '')) desktopChanges.effort = changes.effort;
          // Each part is tried on its own: a permission mode the desktop refuses
          // must not stop the model and effort, and the phone is told which
          // part did not change.
          const failed = {};
          const mode = changes.approveMode ? normalizePermissionMode(changes.approveMode) : null;
          if (mode && mode !== normalizePermissionMode(claudeMeta.approveMode)) {
            try { await this.setClaudeDesktopPermissionMode(args.threadId, mode); }
            catch (error) { failed.permissionMode = error.message; this.log(error); }
          }
          let outcome = { applied: true, pending: false };
          if (Object.keys(desktopChanges).length) {
            try { outcome = await this.setClaudeDesktopSettings(args.threadId, desktopChanges); }
            catch (error) {
              // The model and the effort are saved and sent to the desktop together.
              for (const key of Object.keys(desktopChanges)) failed[key] = error.message;
              this.log(error);
            }
          }
          const settings = this.claudeSettingsResult(args.threadId);
          const reasons = [];
          if (Object.keys(failed).length) reasons.push(claudeSettingsFailureText(failed));
          if (outcome.pending) reasons.push(CLAUDE_DESKTOP_PENDING_TEXT);
          this.emit('thread.settings', args.threadId, { threadId: args.threadId, settings, nextTurn: Boolean(outcome.pending), updatedAt: Date.now(), source: 'claude' });
          return { ...settings, desktop: true, ...outcome, ...(Object.keys(failed).length ? { failed } : {}), ...(reasons.length ? { reason: reasons.join('；') } : {}) };
        }
        const applied = this.claude.updateSettings(args.threadId, { model: changes.model, effort: changes.effort, approveMode: changes.approveMode });
        const meta = this.upsertClaudeThread(args.threadId, { model: applied.model, effort: applied.effort, approveMode: applied.approveMode });
        this.threadState.set(args.threadId, { ...(this.threadState.get(args.threadId) || {}), backendId: 'claude', model: meta.model, permissionMode: meta.approveMode });
        return this.claudeSettingsResult(args.threadId);
      }
      case 'thread.pin':
        return this.pinClaudeOnDesktop(args.threadId, Boolean(args.pinned));
      case 'thread.rename': {
        // A desktop session is renamed on the desktop; the sync brings the title back.
        if (this.claudeThreads.get(args.threadId)?.desktopId) return this.renameClaudeOnDesktop(args.threadId, args.name);
        const renamed = !!this.upsertClaudeThread(args.threadId, { title: args.name });
        await this.syncClaudeThreadMetadata(args.threadId).catch((e) => this.log(e));
        return { renamed };
      }
      case 'thread.archive': {
        // A desktop session is archived on the desktop; the sync brings the state back.
        if (this.claudeThreads.get(args.threadId)?.desktopId) return this.archiveClaudeOnDesktop(args.threadId, !!args.archived);
        const archived = !!this.upsertClaudeThread(args.threadId, { archived: !!args.archived });
        await this.syncClaudeThreadMetadata(args.threadId).catch((e) => this.log(e));
        return { archived };
      }
      // Opening a thread on the phone: pull its transcript and keep it current.
      case 'history.sync': {
        const synced = await this.syncClaudeTranscript(args.threadId, { watch: true }).catch((e) => { this.log(e); return { items: 0 }; });
        return { queued: false, backend: 'claude', items: synced.items };
      }
      case 'thread.ownership.read':
        return { threadId: args.threadId, owner: 'khlink', backend: 'claude' };
      case 'thread.compact':
      case 'thread.fork':
      case 'thread.rollback':
        throw new Error('Claude Code 暂不支持该操作');
      default:
        throw new Error(`Claude 后端不支持的操作: ${action}`);
    }
  }

  // ---- Claude mobile instruction queue ----
  // Claude Code has no server-side turn queue, so the connector keeps a small
  // in-memory one: an instruction sent while a turn runs waits here and is
  // started when that turn completes. It deliberately never touches the Codex
  // follow-up store or the Desktop adapter.
  // Messages the phone queued behind a running Claude turn. Kept in the
  // thread's saved record too, so a connector restart does not lose them
  // while the phone keeps showing them as "待发送".
  claudeQueue(threadId) {
    if (!this._claudeQueues) this._claudeQueues = new Map();
    if (!this._claudeQueues.has(threadId)) {
      const saved = this.claudeThreads?.get(threadId)?.mobileQueue;
      this._claudeQueues.set(threadId, Array.isArray(saved) ? saved.map((item) => ({ ...item })) : []);
    }
    return this._claudeQueues.get(threadId);
  }

  saveClaudeQueue(threadId, { required = false } = {}) {
    if (!this.claudeThreads?.has(threadId)) return;
    this.setClaudeThreadFields?.(threadId, { mobileQueue: (this._claudeQueues?.get(threadId) || []).map((item) => ({ ...item })) });
    this.saveClaudeThreads?.();
    if (required && this.claudeThreadsFile) this.flushClaudeThreads({ required: true });
  }

  // After a restart: load every saved queue and send what can go now.
  restoreClaudeQueues() {
    for (const [threadId, meta] of this.claudeThreads || []) {
      if (!Array.isArray(meta.mobileQueue) || !meta.mobileQueue.length) continue;
      const queue = this.claudeQueue(threadId);
      // Never replay a dispatch interrupted by a connector restart.
      this._claudeQueues.set(threadId, queue.filter((item) =>
        (!item.state || item.state === 'desktop_queued') && !['uncertain', 'failed', 'started', 'cancelled'].includes(this.sendReceipts?.get(item.id)?.state)));
      this.saveClaudeQueue(threadId);
      setTimeout(() => this.drainClaudeQueue(threadId).catch?.((error) => this.log(error)), 5_000);
    }
  }

  claudeQueueItems(threadId = null) {
    if (threadId) this.claudeQueue(threadId);
    const rows = !this._claudeQueues ? [] : threadId ? [[threadId, this._claudeQueues.get(threadId) || []]] : [...this._claudeQueues];
    const mine = rows.flatMap(([, items]) => items.map((item) => ({ ...item, attachments: publicAttachments(item.attachments) })));
    // Messages waiting in the desktop's own queue (typed on the computer or
    // delivered from the phone while the desktop was busy).
    const desktop = [];
    for (const [id, meta] of this.claudeThreads || []) {
      if (threadId && id !== threadId) continue;
      for (const item of meta.desktopQueue || []) if (!item.internal) desktop.push({ ...item, threadId: id, attachments: publicAttachments(item.attachments) });
    }
    return [...mine, ...desktop];
  }

  // state/blocking follow the phone's queue panel: blocking rows are listed,
  // 'desktop_queued' rows offer cancel and send-now.
  claudeQueueItem(threadId, requestId, args, state = 'desktop_queued') {
    return { id: requestId, requestId, threadId, text: String(args.text || '').trim(), attachments: args.attachments || [],
      title: args.title || null, createdAt: Date.now(), state, origin: 'mobile', blocking: state === 'desktop_queued', backend: 'claude' };
  }

  // The phone resends a message it has no answer for (it went to the
  // background, the socket dropped) with the same request id. The queue check
  // below only covers messages still waiting; one already handed over would
  // be sent a second time (seen: the same question answered twice). Remember
  // what was delivered and answer a repeat with the first result.
  async claudeQueueCommand(payload) { return this.deliverOnce(payload, () => this.claudeQueueCommandOnce(payload), 'claude'); }

  // Claude/Pi mutations of the same session are serialized. Different
  // sessions can proceed independently; read-only commands never wait.
  async deliverOnce(payload, run, backend = 'claude') {
    if (!['turn.start', 'turn.steer', 'followup.enqueue', 'followup.cancel', 'followup.steer', 'followup.steer_all'].includes(payload.action)) return run();
    return this.serializeAgentMutation(backend, payload.args?.threadId, () => this.deliverAgentOnce(payload, run, backend));
  }

  async serializeAgentMutation(backend, threadId, operation) {
    this._agentCommandChains ||= new Map();
    const key = `${backend}:${threadId || ''}`;
    const next = (this._agentCommandChains.get(key) || Promise.resolve()).then(operation, operation);
    this._agentCommandChains.set(key, next);
    try { return await next; } finally { if (this._agentCommandChains.get(key) === next) this._agentCommandChains.delete(key); }
  }

  async deliverAgentOnce(payload, run, backend) {
    if (payload.action === 'followup.cancel') {
      const dismissed = this.sendReceipts?.get(payload.args?.id);
      if (dismissed && dismissed.threadId === payload.args?.threadId && ['failed', 'uncertain'].includes(dismissed.state)) {
        this.sendReceipts.update(dismissed.id, { state: 'cancelled', reason: null });
        this.emit('followup.cancelled', dismissed.threadId, { id: dismissed.id, threadId: dismissed.threadId });
        return { cancelled: true, dismissed: true, backend };
      }
    }
    const requestId = payload.requestId || payload.args?.requestId;
    const once = requestId && ['turn.start', 'turn.steer', 'followup.enqueue'].includes(payload.action);
    if (!once) return run();
    this.sendReceipts ||= new SendReceipts();
    const args = payload.args || {};
    const existing = this.sendReceipts.get(requestId);
    if (existing) {
      if (existing.fingerprint !== this.sendReceipts.fingerprint(backend, args)) throw new Error('重复请求的内容不一致，已取消发送');
      return { ...this.sendReceipts.result(existing), duplicate: true };
    }
    const row = this.sendReceipts.begin(requestId, backend, args);
    this.emit('followup.queued', args.threadId, this.sendReceipts.item(row));
    try {
      const result = await run();
      const updated = this.sendReceipts.update(requestId, { state: result?.queued ? 'desktop_queued' : 'started',
        reason: null, startedAt: result?.queued ? null : Date.now(), result: result && typeof result === 'object' ? result : {} });
      // A direct send has no later backend event to retire the phone's
      // optimistic row; announce that it started here. Queued sends announce
      // when the backend promotes them.
      if (!result?.queued && updated) this.emit('followup.started', args.threadId, this.sendReceipts.item(updated));
      return this.sendReceipts.result(row);
    } catch (error) {
      const uncertain = error.delivery !== 'not_sent';
      this.sendReceipts.update(requestId, { state: uncertain ? 'uncertain' : 'failed', reason: uncertain ? SEND_RECEIPT_UNCERTAIN : String(error.message || error) });
      this.emit('followup.failed', args.threadId, { ...this.sendReceipts.item(row), needsConfirmation: uncertain });
      return this.sendReceipts.result(row);
    }
  }

  reconcileSendReceipts(backend, threadId, items) {
    const resolved = this.sendReceipts?.reconcile(backend, threadId, items) || [];
    for (const item of resolved) this.emit('followup.started', threadId, item);
    return resolved.length;
  }

  async claudeQueueCommandOnce(payload) {
    const args = payload.args || {}; const threadId = args.threadId;
    const requestId = payload.requestId || args.requestId || crypto.randomUUID();
    const queue = this.claudeQueue(threadId);
    const running = (typeof this.claude?.isRunning === 'function' && this.claude.isRunning(threadId)) || this.claudeDesktopBusy(threadId);
    switch (payload.action) {
      case 'turn.start':
      case 'followup.enqueue': {
        if (queue.some((item) => item.id === requestId)) return { queued: true, duplicate: true, backend: 'claude', item: queue.find((item) => item.id === requestId) };
        if (!running && !queue.length) {
          const viaDesktop = await this.deliverClaudeToDesktop(threadId, args);
          if (viaDesktop) {
            this.emit('followup.started', threadId, { ...this.claudeQueueItem(threadId, requestId, args, 'started'), startedAt: Date.now() });
            return { ...viaDesktop, accepted: true };
          }
        }
        if (running || queue.length) {
          const item = this.claudeQueueItem(threadId, requestId, args);
          queue.push(item);
          this.saveClaudeQueue(threadId, { required: true });
          this.emit('followup.queued', threadId, item);
          return { queued: true, backend: 'claude', item, position: queue.length };
        }
        const result = await this.executeClaudeCommand('turn.start', args);
        this.emit('followup.started', threadId, { ...this.claudeQueueItem(threadId, requestId, args, 'started'), startedAt: Date.now() });
        return { ...result, accepted: true, backend: 'claude' };
      }
      case 'turn.steer':
        return this.executeClaudeCommand('turn.steer', args);
      case 'followup.cancel': {
        const index = queue.findIndex((item) => item.id === args.id);
        if (index >= 0) queue.splice(index, 1);
        this.saveClaudeQueue(threadId);
        this.emit('followup.cancelled', threadId, { id: args.id, threadId });
        return { cancelled: index >= 0, backend: 'claude' };
      }
      case 'followup.steer':
      case 'followup.steer_all': {
        const ids = payload.action === 'followup.steer' ? [args.id] : (Array.isArray(args.ids) && args.ids.length ? args.ids : queue.map((item) => item.id));
        const picked = queue.filter((item) => ids.includes(item.id));
        if (!picked.length) return { steered: false, backend: 'claude' };
        const text = picked.map((item) => item.text).filter(Boolean).join('\n\n');
        const attachments = picked.flatMap((item) => item.attachments || []);
        this.sendReceipts ||= new SendReceipts();
        for (const item of picked) {
          if (!this.sendReceipts.get(item.id)) this.sendReceipts.begin(item.id, 'claude', { ...item, threadId });
          this.sendReceipts.update(item.id, { state: 'dispatching' }); item.state = 'dispatching';
        }
        this.saveClaudeQueue(threadId, { required: true });
        try {
          const result = await this.executeClaudeCommand('turn.steer', { threadId, text, attachments });
          for (const item of picked) {
            this.sendReceipts.update(item.id, { state: 'steered', startedAt: Date.now(), reason: null });
            this.emit('followup.started', threadId, this.sendReceipts.item(this.sendReceipts.get(item.id)));
          }
          return { ...result, steered: true, backend: 'claude' };
        } catch (error) {
          const uncertain = error.delivery !== 'not_sent';
          for (const item of picked) {
            const row = this.sendReceipts.update(item.id, { state: uncertain ? 'uncertain' : 'failed', reason: uncertain ? SEND_RECEIPT_UNCERTAIN : String(error.message || error) });
            this.emit('followup.failed', threadId, { ...this.sendReceipts.item(row), needsConfirmation: uncertain });
          }
          return { steered: false, uncertain, failed: !uncertain, backend: 'claude' };
        } finally {
          for (const item of picked) queue.splice(queue.indexOf(item), 1);
          this.saveClaudeQueue(threadId);
        }
      }
      default:
        throw new Error(`Claude 后端不支持的操作: ${payload.action}`);
    }
  }

  async drainClaudeQueue(threadId) {
    const queue = this.claudeQueue(threadId);
    // One at a time: while a message is being handed over (seconds, on the
    // desktop) the session does not look busy yet, and the next one must wait.
    this._claudeDraining ||= new Set();
    if (this._claudeDraining.has(threadId)) return;
    if (!queue.length || this.claude?.isRunning?.(threadId) || this.claudeDesktopBusy(threadId)) return;
    this._claudeDraining.add(threadId);
    try {
      await this.serializeAgentMutation('claude', threadId, async () => {
        if (!queue.length || this.claude?.isRunning?.(threadId) || this.claudeDesktopBusy(threadId)) return;
        const item = queue[0];
        if (item.state && item.state !== 'desktop_queued') return;
        this.sendReceipts ||= new SendReceipts();
        let receipt = this.sendReceipts.get(item.id);
        if (receipt && ['uncertain', 'failed', 'started', 'cancelled'].includes(receipt.state)) {
          queue.shift(); this.saveClaudeQueue(threadId); return;
        }
        if (!receipt) receipt = this.sendReceipts.begin(item.id, 'claude', { ...item, threadId });
        this.sendReceipts.update(item.id, { state: 'dispatching' });
        item.state = 'dispatching'; this.saveClaudeQueue(threadId, { required: true });
        this.emit('followup.queued', threadId, this.sendReceipts.item(receipt));
        try {
          const result = await this.executeClaudeCommand('turn.start', { threadId, text: item.text, attachments: item.attachments, title: item.title, requestId: item.id });
          this.sendReceipts.update(item.id, { state: 'started', reason: null, startedAt: Date.now(), result });
          queue.shift(); this.saveClaudeQueue(threadId);
          this.emit('followup.started', threadId, this.sendReceipts.item(receipt));
        } catch (error) {
          const uncertain = error.delivery !== 'not_sent';
          this.sendReceipts.update(item.id, { state: uncertain ? 'uncertain' : 'failed', reason: uncertain ? SEND_RECEIPT_UNCERTAIN : String(error?.message || error) });
          queue.shift(); this.saveClaudeQueue(threadId);
          this.emit('followup.failed', threadId, { ...this.sendReceipts.item(receipt), needsConfirmation: uncertain });
        }
      });
    } finally { this._claudeDraining.delete(threadId); }
  }

  // Persist a Claude thread's index entry so it appears in the phone's history list.
  async syncClaudeThreadMetadata(threadId, indexChanged = false) {
    if (!this.config.accountKey) return;
    const meta = this.claudeThreads.get(threadId); if (!meta) return;
    const value = this.claudeThreadIndexValue(threadId);
    const encrypted = encryptJson(this.config.accountKey, 'history.thread', threadId, threadId, value);
    const indexUpdatedAt = indexChanged ? Date.now() : value.updatedAt;
    await this.api.request(this.api.path('/history/threads'), { method: 'PUT', body: { id: threadId, archived: !!meta.archived, updatedAt: indexUpdatedAt, ...encrypted } });
  }

  // Append one Claude conversation item to the encrypted history store so a phone
  // reloading the thread sees it (agent.event only covers the live connection).
  async persistClaudeItem(threadId, item) {
    if (!this.config.accountKey || !item) return;
    const meta = this.claudeThreads.get(threadId) || this.upsertClaudeThread(threadId, {});
    const order = Number.isFinite(meta.nextOrder) ? meta.nextOrder : 0;
    this.upsertClaudeThread(threadId, { nextOrder: order + 1 });
    const value = { type: item.type, text: item.text, tool: item.tool, input: item.input, createdAt: item.at || Date.now() };
    const id = item.id || crypto.randomUUID();
    const encrypted = await this.historyItemFrame(threadId, id, value);
    await this.putHistoryItems(threadId, [{ id, order, createdAt: value.createdAt, ...encrypted }]);
    // Nudge the phone to pull the freshly persisted item (mirrors the Codex path).
    this.emit('history.updated', threadId, { threadId, itemCount: 1, updatedAt: Date.now(), backend: 'claude' });
  }

  persistClaudeUserMessage(threadId, text, images) {
    // Transcript-backed threads get the user turn from the transcript itself.
    if (!this.isLegacyLiveClaudeThread(this.claudeThreads.get(threadId))) { this.scheduleClaudeTranscriptSync(threadId, 800); return; }
    const hasImage = Array.isArray(images) && images.length > 0;
    const label = String(text || (hasImage ? '[图片]' : '')).trim();
    if (!label) return;
    this.persistClaudeItem(threadId, { id: crypto.randomUUID(), type: 'userMessage', text: label, at: Date.now() }).catch((e) => this.log(e));
  }

  resolveClaudeImages(args) {
    return this.claudeAttachmentParts(args).images;
  }

  hasActiveTurns() {
    for (const state of this.threadState?.values?.() || []) if (state?.activeTurnId) return true;
    // `desktop_*` is an observation of Codex Desktop, whose process is not
    // owned by this connector. Restarting the connector must not be blocked by
    // an unrelated Desktop task; only connector-owned mobile turns can be
    // interrupted here. Desktop tasks continue in Codex Desktop and are
    // recovered from the next presence/history sync.
    for (const status of this.desktopStatuses?.values?.() || []) if (/^mobile_/i.test(String(status || '')) && isLiveThreadStatus(status)) return true;
    return false;
  }

  canShutdownSafely() {
    return !this.inFlightCommands?.size && !this.hasActiveTurns();
  }

  async waitForIdle(timeoutMs = 0) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Date.now();
    while (!this.canShutdownSafely()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(50, deadline - Date.now()))));
    }
    return true;
  }

  // Before a new connector takes over (supervisor reload): keep what is only in
  // memory, go offline cleanly and free the single-instance lock. The Codex
  // host is left running for the next connector to take over.
  async prepareReload() {
    this.stopping = true;
    clearInterval(this.desktopAgentPresenceTimer); this.desktopAgentPresenceTimer = null;
    await this.direct?.close();
    await this.directHistory?.flush();
    if (this._claudeThreadsSaveTimer || this._claudeThreadsWrite) { this._claudeThreadsClosing = true; this.flushClaudeThreads(); }
    await this.writeStatus(false, 'reloading');
    try { this.ws?.close(1012, 'connector update'); } catch { /* already closed */ }
    try { this.processLock?.release?.(); } catch { /* the next one handles a stale lock */ }
  }

  async shutdown({ requireIdle = true, waitForIdleMs = 0 } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      if (requireIdle && !(await this.waitForIdle(waitForIdleMs))) {
        await this.writeStatus(this.ws?.readyState === WebSocket.OPEN, 'running', { shutdownBlocked: true });
        return { ok: false, code: 'active_tasks', activeThreads: this.activeThreadSnapshot(), inFlight: this.inFlightCommands.size };
      }
      this.stopping = true; this.lifecycle = 'draining';
      await this.direct?.close();
      await this.directHistory?.flush();
      clearInterval(this.heartbeat); this.heartbeat = null;
      clearInterval(this.statusHeartbeat); this.statusHeartbeat = null;
      clearInterval(this.followupRetryTimer); this.followupRetryTimer = null;
      clearInterval(this.phoneKeyTimer); this.phoneKeyTimer = null;
      clearInterval(this.codexInstallTimer); this.codexInstallTimer = null;
      clearInterval(this.desktopAgentPresenceTimer); this.desktopAgentPresenceTimer = null;
      clearInterval(this._claudeStatuslineTimer); this._claudeStatuslineTimer = null;
      try { this.agentAccounts?.stop(); this.stopClaudeDesktopSync?.(); this.claude?.stop(); } catch (error) { this.log(error); }
      clearInterval(this.realtimeSyncTimer); this.realtimeSyncTimer = null;
      clearTimeout(this.reconnectTimer); this.reconnectTimer = null; clearInterval(this.stallTimer); this.stallTimer = null; clearInterval(this.codexUsageTimer); this.codexUsageTimer = null; this.pcLoad?.stop(); if (this._claudeThreadsSaveTimer || this._claudeThreadsWrite) { this._claudeThreadsClosing = true; this.flushClaudeThreads(); }
      for (const timer of this.desktopSyncTimers.values()) clearTimeout(timer);
      this.desktopSyncTimers.clear();
      try { this.sessionWatcher?.close?.(); } catch {}
      this.sessionWatcher = null;
      this.followups?.save?.();
      await this.writeStatus(false, 'draining');
      const socket = this.ws; this.ws = null;
      try { socket?.close?.(1000, 'connector maintenance'); } catch {}
      await this.codex.stop();
      this.lifecycle = 'offline'; await this.writeStatus(false, 'offline');
      this.processLock?.release();
      return { ok: true, code: 'stopped' };
    })();
    try { return await this.shutdownPromise; }
    finally { if (this.lifecycle !== 'draining') this.shutdownPromise = null; }
  }

  codexProfileIsolationReady(now = Date.now()) {
    const at = this.desktopAgentPresenceAt || 0;
    return this.codexProfileIsolation === true && at > 0 && at <= now && now - at < 30_000;
  }

  writeStatus(connected, lifecycle = null, extra = {}) {
    try {
      const status = {
        version: CONNECTOR_VERSION,
        connected: connected || this.direct?.connected === true,
        connectionMode: this.config.directOnly ? 'direct' : 'server',
        relayConnected: this.ws?.readyState === WebSocket.OPEN,
        directConnected: this.direct?.connected === true,
        lifecycle: lifecycle || this.lifecycle || (connected ? 'running' : 'offline'),
        updatedAt: Date.now(),
        deviceName: this.config.deviceName,
        activeThreads: this.activeThreadSnapshot(),
        restartSafe: this.canShutdownSafely(),
        inFlightCommands: this.inFlightCommands?.size || 0,
        connectorPid: process.pid,
        codexReady: Boolean(this.codex?.ready),
        codexInstalled: !this.codexMissing,
        codexProfileIsolation: this.codexProfileIsolationReady(),
        codexMode: this.codex?.mode || null,
        codexVersion: this.codex?.version || null,
        codexRecoveryAttempts: this.codexRecoveryAttempts || 0,
        codexReason: this.codexLastError || null,
        ...extra,
      };
      this._statusWriter ||= new LatestFileWriter(this.statusFile, { onError: (error) => this.log(error) });
      return this._statusWriter.write(JSON.stringify(status));
    } catch (error) { this.log(error); }
  }

  readSequence() {
    try {
      const value = Number(JSON.parse(fs.readFileSync(this.sequenceFile, 'utf8')).lastSequence);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  }

  saveSequence(sequence) {
    const value = Number(sequence);
    if (!Number.isSafeInteger(value) || value <= (this.lastSequence || 0)) return;
    this.lastSequence = value;
    try { fs.writeFileSync(this.sequenceFile, JSON.stringify({ lastSequence: value })); }
    catch (error) { this.log(error); }
  }

  readHistoryDigests() {
    try {
      const value = JSON.parse(fs.readFileSync(this.historyDigestFile, 'utf8'));
      return { threads: Array.isArray(value.threads) ? value.threads : [], items: Array.isArray(value.items) ? value.items : [], backfills: Array.isArray(value.backfills) ? value.backfills : [] };
    } catch { return { threads: [], items: [] }; }
  }

  saveHistoryDigests() {
    try {
      fs.writeFileSync(this.historyDigestFile, JSON.stringify({ threads: [...this.threadDigests], items: [...this.threadItemDigests], backfills: [...this.historyBackfills] }));
    } catch (error) { this.log(error); }
  }
}

function isDesktopTaskBusy(status) {
  return /^desktop_(running|waiting|input|approval)/i.test(String(status || ''));
}

function isDesktopWriterBusyError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '');
  // Codex has used several equivalent messages for the same single-writer
  // guard across CLI releases. In particular, newer builds say that the
  // thread is already open in another application instead of mentioning an
  // "active writer". Treat all of them as a Desktop-owned task so mobile can
  // queue/defer the operation instead of exposing the raw Codex error.
  return /active[_ -]?writer|desktop[_ -]?busy|settings[_ -]?controlled|writer[_ -]?busy|already[_ -]?(open|in[_ -]?use)|thread[_ -]?(already[_ -]?)?open/.test(code) ||
    /active writer|currently controlling|another codex|already\s+(?:being\s+)?open|open(?:ed)?\s+in\s+(?:another|a different)\s+(?:app|application)|already\s+in\s+use|电脑端正在控制|任务正在运行|已在另一个应用中打开|已在.*(?:应用|程序).*(?:打开|使用)|codex.*busy|writer.*busy/i.test(message);
}

function isThreadNotFoundError(error) {
  return /thread not found/i.test(String(error?.message || error || ''));
}

function isCodexAgentLoopError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '');
  return /agent[_ -]?loop|turn[_ -]?input/.test(code) ||
    /failed to submit turn input|agent loop (?:died|exited|crashed)|internal error.*agent loop/i.test(message);
}

function isThreadLoadRetryableError(error) {
  const message = String(error?.message || error || '');
  return /thread not found|thread\/resume timed out|thread-store conflict|failed to initialize thread persistence/i.test(message);
}

function followupRetryReason(error) {
  if (isDesktopWriterBusyError(error)) {
    return '电脑端正在使用此对话，消息已排队，释放后将自动后台发送';
  }
  if (isCodexAgentLoopError(error)) {
    return 'Codex 后台任务刚刚异常退出，消息和图片已保存，连接器会自动恢复并重试';
  }
  const message = String(error?.message || error || '');
  if (isThreadLoadRetryableError(error)) {
    return '任务正在恢复或尚未加载，消息已保存在队列中，连接器会自动重试';
  }
  return message || '后台发送暂时未完成，连接器会自动重试';
}

function isDesktopSettingsRetryableError(error) {
  if (isDesktopWriterBusyError(error)) return true;
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '');
  // If Desktop is closed or the requested task cannot be located, the
  // protocol writer can still apply an idempotent thread setting. Treat these
  // as transport/visibility failures, while keeping explicit mode-control
  // failures (for example plan_command_not_found) visible to the user. A menu
  // that did not open or a category not yet drawn is retried; an option the
  // desktop does not offer is not (see *_option_not_matched).
  return /desktop_not_ready|task_identity_unconfirmed|composer_unavailable|settings_control_not_found|plan_mode_state_unknown|adapter.*timed_out|settings_button_not_found|settings_menu_not_opened|_category_not_found/.test(code) ||
    /desktop adapter timed out|composer.*not available|desktop.*not ready/i.test(message);
}

function isDesktopAdapterUnavailableError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '');
  return /desktop_not_ready/.test(code) || /codex desktop was not found|desktop.*not ready/i.test(message);
}

function isDesktopModeUiRetryableError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '');
  return /desktop_busy|task_identity_unconfirmed|composer_(busy|unavailable)|plan_mode_(state_unknown|control_not_found|toggle_failed|unverified)|plan_command_not_found|draft_restore_failed|adapter.*timed_out/.test(code) ||
    /desktop.*(running|busy|not available)|plan.*(not found|unverified|could not)|composer.*(busy|unavailable)|draft.*restore/i.test(message);
}

function isBackgroundSettingsRetryableError(error) {
  if (isDesktopWriterBusyError(error)) return false;
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error || '');
  return /timeout|timed[_ -]?out|econnreset|econnrefused|socket|transport|not connected|connection closed|disconnected|initializ/i.test(`${code} ${message}`);
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && (item.path || item.attachmentId)).map((item) => ({
    name: String(item.name || path.basename(item.path || 'attachment')),
    path: item.path ? String(item.path) : null,
    attachmentId: item.attachmentId ? String(item.attachmentId) : null,
    size: Number(item.size) || 0,
    mimeType: item.mimeType ? String(item.mimeType) : null,
  }));
}

function codexInput(text, attachments, requestId = null) {
  const normalized = normalizeAttachments(attachments);
  const images = normalized.filter(isImageAttachment);
  const remaining = normalized.filter((item) => !isImageAttachment(item));
  const input = [{ type: 'text', text: withRequestMarker(withAttachmentContext(text, remaining), requestId) }];
  for (const image of images) input.push({ type: 'localImage', path: image.path });
  return input;
}

// Why the Codex window could not take a message right now, in the phone's words.
function steerFailureText(result) {
  switch (result?.code) {
    case 'composer_unavailable': return '电脑上这个任务暂时不能输入（可能在等你批准），已排在这一轮之后';
    case 'draft_present': return '电脑上这个任务的输入框里已有草稿，消息仍在等待；请先处理电脑上的草稿';
    case 'queue_paused': return '电脑端队列因中断而暂停，请在电脑上处理；消息仍在队列中';
    case 'task_identity_unconfirmed': return '电脑上没能打开这个任务，已排在这一轮之后';
    case 'desktop_not_ready': return '电脑上的 Codex 没有打开，已排在这一轮之后';
    default: return '电脑上没能立即发送，已排在这一轮之后';
  }
}

function isDesktopPresentProbe(value) {
  return ['task_active', 'desktop_other_task', 'desktop_present', 'ready'].includes(String(value?.code || '').toLowerCase());
}

function queuedTextForMatch(text) {
  return normalizeText(stripRequestMarker(stripLocalImageMarkup(String(text || '')))
    .replace(/^<environment_context>[\s\S]*?<\/environment_context>\s*/i, ''));
}

function queuedTextsMatch(left, right) {
  const a = queuedTextForMatch(left); const b = queuedTextForMatch(right);
  if (!a || !b) return false;
  return a === b || (a.length >= 12 && b.includes(a)) || (b.length >= 12 && a.includes(b));
}

function withAttachmentContext(text, attachments) {
  const value = String(text || '').trim();
  const rows = normalizeAttachments(attachments).map((item) => {
    const size = item.size > 0 ? ` (${item.size} bytes)` : '';
    if (isImageAttachment(item) && item.attachmentId) {
      // The image is now sent as a first-class input (localImage for the
      // background protocol or a native UI attachment for Desktop).  Keep
      // the opaque id for history/debugging, but do not instruct the model to
      // call an MCP tool that may not be loaded in an already-open window.
      return `[khLink 图片附件] ${item.name}${size}\n附件编号：${item.attachmentId}`;
    }
    return `[风筑附件] ${item.name}${size}\n路径：${item.path}`;
  });
  if (!rows.length) return value;
  return value ? `${value}\n\n${rows.join('\n\n')}` : rows.join('\n\n');
}

const MAX_HISTORY_ATTACHMENT_BYTES = 650 * 1024;
const HISTORY_IMAGE_MIME_BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp',
};

function readHistoryAttachmentPreviews(attachments) {
  const result = [];
  for (const item of normalizeAttachments(attachments)) {
    const extension = path.extname(item.name || item.path).slice(1).toLowerCase();
    const mimeType = String(item.mimeType || HISTORY_IMAGE_MIME_BY_EXTENSION[extension] || '').toLowerCase();
    if (!mimeType.startsWith('image/') || !HISTORY_IMAGE_MIME_BY_EXTENSION[extension]) continue;
    try {
      const stat = fs.statSync(item.path);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_HISTORY_ATTACHMENT_BYTES) continue;
      const data = fs.readFileSync(item.path);
      result.push({ data: `data:${mimeType};base64,${data.toString('base64')}`, mimeType });
    } catch {
      // The temporary upload may have been cleaned up; the text/path remains available.
    }
  }
  return result;
}

function publicThreadSettings(value = {}) {
  const source = value || {};
  const collaboration = source.effectiveCollaborationMode || source.effective_collaboration_mode ||
    source.collaborationMode || source.collaboration_mode;
  const collaborationMode = typeof collaboration === 'string' ? collaboration : collaboration?.mode;
  const effectiveCollaborationMode = /plan/i.test(collaborationMode || '') ? 'plan' : 'default';
  const desiredSource = source.desiredCollaborationMode || source.desired_collaboration_mode || effectiveCollaborationMode;
  const desiredValue = typeof desiredSource === 'string' ? desiredSource : desiredSource?.mode;
  const desiredCollaborationMode = /plan/i.test(desiredValue || '') ? 'plan' : 'default';
  const modeSyncState = source.modeSyncState || source.mode_sync_state ||
    (source.pendingDesktopSettings?.collaborationMode ? 'pending' : 'applied');
  const approvalPolicy = source.approvalPolicy ?? source.approval_policy ?? null;
  const sandbox = source.sandboxPolicy ?? source.sandbox_policy ?? source.sandbox ?? null;
  const sandboxType = typeof sandbox === 'string' ? sandbox : sandbox?.type || null;
  const permissionMode = source.permissionMode || source.permission_mode || source.mode ||
    (approvalPolicy === 'never' || /dangerfullaccess|danger-full-access/i.test(sandboxType || '') ? 'yolo' :
      approvalPolicy === 'on-request' ? 'auto' : 'manual');
  return {
    model: source.model ?? null,
    effort: source.effort ?? source.reasoningEffort ?? source.reasoning_effort ?? null,
    serviceTier: source.serviceTier ?? source.service_tier ?? null,
    approvalPolicy,
    approvalsReviewer: source.approvalsReviewer ?? source.approvals_reviewer ?? null,
    sandboxPolicy: sandboxType,
    permissionMode,
    collaborationMode: effectiveCollaborationMode,
    effectiveCollaborationMode,
    desiredCollaborationMode,
    modeSyncState,
    reason: source.modeSyncReason || source.reason || null,
    nextTurn: Boolean(source.nextTurn),
  };
}

// A collaboration mode's settings. Codex applies the mode's reasoning effort
// over the turn's own, so the effort goes in here too whenever it is known.
function modeSettings(model, effort) {
  return { model, ...(effort != null && String(effort).trim() ? { reasoning_effort: effort } : {}) };
}

function threadSettingsUpdateParams(threadId, next, changed) {
  const update = { threadId };
  for (const key of ['model', 'effort', 'serviceTier']) {
    // The desktop protocol rejects explicit JSON nulls for optional string
    // settings.  Omitting a default value preserves the current desktop-owned
    // setting and is also how the initial thread params are encoded.
    if (Object.prototype.hasOwnProperty.call(changed, key) && changed[key] != null && String(changed[key]).trim()) {
      update[key] = changed[key];
    }
  }
  // A cleared speed turns fast mode off; omitting it would leave fast mode on.
  if (Object.prototype.hasOwnProperty.call(changed, 'serviceTier') && !update.serviceTier) update.serviceTier = 'default';
  const permissionMode = changed.permissionMode ?? changed.permission_mode ?? changed.mode;
  if (permissionMode != null) {
    const mode = String(permissionMode).toLowerCase();
    if (mode === 'yolo') {
      update.approvalPolicy = 'never';
      update.sandboxPolicy = { type: 'dangerFullAccess' };
    } else if (mode === 'auto') {
      update.approvalPolicy = 'on-request';
      update.approvalsReviewer = 'auto_review';
      update.sandboxPolicy = { type: 'workspaceWrite', writableRoots: [], networkAccess: false };
    } else {
      update.approvalPolicy = 'untrusted';
      update.approvalsReviewer = 'user';
      update.sandboxPolicy = { type: 'workspaceWrite', writableRoots: [], networkAccess: false };
    }
  }
  if (Object.prototype.hasOwnProperty.call(changed, 'collaborationMode') || Object.prototype.hasOwnProperty.call(changed, 'collaboration_mode')) {
    const mode = String(changed.collaborationMode ?? changed.collaboration_mode ?? 'default').toLowerCase() === 'plan' ? 'plan' : 'default';
    const settings = {};
    if (next.model != null && String(next.model).trim()) settings.model = next.model;
    // The mode carries its own reasoning effort and replaces the thread's: left
    // out, the effort chosen with it (or kept across a model change) is reset.
    const effort = next.effort ?? next.reasoningEffort;
    if (effort != null && String(effort).trim()) settings.reasoning_effort = effort;
    // `settings` itself is required by Codex even when it has no optional
    // fields; only the fields with real string values may be omitted.
    update.collaborationMode = { mode, settings };
  }
  return update;
}

function rolloutThreadSettings(record) {
  const payload = record?.payload || {};
  if (record?.type !== 'event_msg') return null;
  if (!/thread_settings_(applied|updated)/i.test(String(payload.type || ''))) return null;
  return publicThreadSettings(payload.thread_settings || payload.threadSettings || payload.settings || payload);
}

function readLatestThreadSettings(file, maxBytes = 8 * 1024 * 1024) {
  let stat; try { stat = fs.statSync(file); } catch { return null; }
  const length = Math.min(stat.size, maxBytes); const start = stat.size - length;
  let fd; try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!/thread_settings_(applied|updated)/i.test(lines[index])) continue;
      try {
        const settings = rolloutThreadSettings(JSON.parse(lines[index]));
        if (settings) return settings;
      } catch {}
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

function approvalOptions(method, params) {
  return normalizeMobileInputRequest(method, params).questions.flatMap((question) => question.options);
}

function normalizeMobileChoice(value, index) {
  if (typeof value === 'string') return { value, label: value, description: '', custom: false };
  const raw = value && typeof value === 'object' ? value : {};
  const label = String(raw.label ?? raw.title ?? raw.text ?? raw.value ?? raw.id ?? `选项 ${index + 1}`);
  return {
    value: String(raw.value ?? raw.id ?? raw.label ?? label),
    label,
    description: String(raw.description ?? raw.detail ?? raw.help ?? ''),
    custom: Boolean(raw.custom ?? raw.isOther ?? raw.allowCustomInput),
  };
}

function normalizeMobileQuestion(value, index) {
  const raw = value && typeof value === 'object' ? value : { question: String(value || '') };
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const allowCustomInput = Boolean(raw.allowCustomInput ?? raw.allowFreeform ?? raw.customInput ?? raw.allowOther ?? raw.isOther) || rawOptions.length === 0;
  const options = rawOptions.map(normalizeMobileChoice);
  if (allowCustomInput && !options.some((option) => option.custom)) {
    options.push({ value: '__custom__', label: '其他', description: '', custom: true });
  }
  return {
    id: String(raw.id ?? raw.questionId ?? `question-${index + 1}`),
    title: String(raw.question ?? raw.header ?? raw.title ?? raw.prompt ?? `问题 ${index + 1}`),
    description: String(raw.description ?? raw.detail ?? raw.help ?? ''),
    options,
    required: raw.required !== false,
    multiple: Boolean(raw.multiple ?? raw.multiSelect ?? raw.multiselect),
    allowCustomInput,
    secret: raw.isSecret === true,
  };
}

function normalizeMobileInputRequest(method, params = {}) {
  const rawQuestions = Array.isArray(params?.questions) ? params.questions : [];
  if (rawQuestions.length) {
    return {
      kind: 'user_input', blocking: params.isBlocking !== false, title: String(params.title ?? params.header ?? '需要你的输入'),
      detail: String(params.description ?? params.reason ?? params.message ?? ''),
      questions: rawQuestions.map(normalizeMobileQuestion),
    };
  }
  if (Array.isArray(params?.options)) {
    return {
      kind: 'user_input', blocking: params.isBlocking !== false, title: String(params.title ?? params.header ?? '需要你的选择'),
      detail: String(params.description ?? params.reason ?? params.message ?? ''),
      questions: [normalizeMobileQuestion({ id: 'decision', question: params.question ?? params.prompt ?? '请选择', options: params.options, required: true }, 0)],
    };
  }
  // The Android approval dialog already renders the method as the compact
  // technical detail. Do not also use it as the explanatory detail, or a
  // generic commandExecution/requestApproval appears twice on the phone.
  return { kind: 'approval', title: '需要你的确认', detail: String(params?.reason ?? params?.message ?? ''), questions: [] };
}

// What the phone shows for a Codex approval: which command or which files.
function describeApproval(method, params = {}, item = null) {
  const request = normalizeMobileInputRequest(method, params);
  if (request.kind !== 'approval') return request;
  const reason = String(params?.reason ?? params?.message ?? '').trim();
  const lines = [];
  let title = request.title; let kind = 'approval';
  if (/commandExecution|execCommand/i.test(method)) {
    title = '允许运行这条命令？'; kind = 'command';
    const command = params.command ?? item?.command;
    const text = commandLine(command);
    if (text) lines.push(text);
    const cwd = params.cwd ?? item?.cwd;
    if (cwd) lines.push(`目录：${String(cwd).replace(/^file:\/\/\//i, '')}`);
  } else if (/fileChange|applyPatch/i.test(method)) {
    title = '允许修改这些文件？'; kind = 'file';
    const changes = item?.changes ?? params.changes ?? params.fileChanges;
    const entries = Array.isArray(changes)
      ? changes.map((change) => [change?.path, change?.kind?.type ?? change?.kind ?? change?.type])
      : Object.entries(changes || {}).map(([file, change]) => [file, change?.type]);
    for (const [file, type] of entries) if (file) lines.push(`${FILE_CHANGE_LABELS[String(type || '').toLowerCase()] || '修改'} ${file}`);
  } else if (/permissions/i.test(method)) {
    title = '允许扩大权限？'; kind = 'permission';
  }
  if (reason) lines.push(`原因：${reason}`);
  return { ...request, kind, title, detail: lines.join('\n'), allowSession: kind === 'command' || kind === 'file' };
}

function semanticAnswerResult(pending, semanticAnswer) {
  const rawQuestions = Array.isArray(pending.params?.questions) ? pending.params.questions : [];
  const answers = semanticAnswer?.answers || {};
  if (pending.method === 'item/tool/requestUserInput' || rawQuestions.length || Array.isArray(pending.params?.options)) {
    const questions = rawQuestions.length ? rawQuestions : [{ id: 'decision', options: pending.params?.options || [] }];
    const mapped = {};
    questions.forEach((question, index) => {
      const id = String(question?.id ?? question?.questionId ?? `question-${index + 1}`);
      const value = answers[id] || {};
      const selected = Array.isArray(value.selected) ? value.selected.map(String).filter((answer) => answer && answer !== '__custom__') : [];
      const customText = String(value.customText ?? '').trim();
      if (customText) selected.push(customText);
      mapped[id] = { answers: selected };
    });
    return { answers: mapped };
  }
  return { decision: 'decline' };
}

function threadStatus(thread) {
  const status = thread?.status;
  return typeof status === 'object' && status ? status.type || status.state || JSON.stringify(status) : String(status || '');
}

function isActiveThread(thread) {
  return /^(active|running|progress|inprogress|in_progress|waiting|input|approval|compacting)$/i.test(threadStatus(thread));
}

function isTerminalThreadStatus(thread) { return /idle|completed|failed|cancelled|aborted|interrupted/i.test(threadStatus(thread)); }

// `idle` is used by app-server for tasks whose live state is not loaded into
// this process. It is not proof that a Desktop-owned turn has finished; the
// rollout tail or an explicit terminal status provides that confirmation.
function isExplicitTerminalThreadStatus(thread) { return /completed|failed|cancelled|aborted|interrupted/i.test(threadStatus(thread)); }

function threadPollSignature(thread) {
  return JSON.stringify([thread?.updatedAt || 0, threadStatus(thread), thread?.name || '', thread?.preview || '',
    Boolean(thread?._fengzhuPinned), Number(thread?._fengzhuPinOrder) || 0, Boolean(thread?._fengzhuUnread)]);
}

function notificationStatus(method, params = {}) {
  const value = String(method || '');
  if (/turn\/(started|resumed)$/i.test(value)) return 'running';
  if (/turn\/(completed)$/i.test(value)) {
    // Codex reports successful, failed and interrupted turns through the
    // same completion notification. The method alone loses that outcome.
    const status = params?.turn?.status || params?.status;
    const terminal = typeof status === 'string' ? status : status?.type || status?.kind || '';
    if (/fail|error/i.test(terminal)) return 'failed';
    if (/cancel|abort|interrupt/i.test(terminal)) return 'cancelled';
    return 'completed';
  }
  if (/turn\/(failed)$/i.test(value)) return 'failed';
  if (/turn\/(cancelled|aborted|interrupted)$/i.test(value)) return 'cancelled';
  return null;
}

function contextCompactionStatus(method, params = {}) {
  // Codex's own lifecycle for the compaction item (ThreadItem::ContextCompaction):
  // item/started when it begins, item/completed when it ends. The legacy
  // thread/compacted notification is sent once a compaction has finished.
  const item = params?.item;
  if (/^contextcompaction$/i.test(String(item?.type || ''))) {
    if (/^item\/started$/i.test(String(method || ''))) return 'started';
    if (/^item\/completed$/i.test(String(method || ''))) {
      return /(fail|error|abort|cancel)/i.test(String(item.status || '')) ? 'failed' : 'completed';
    }
    return null;
  }
  if (/^thread\/compacted$/i.test(String(method || ''))) return 'completed';
  const marker = [method, params?.type, params?.event, params?.stage, params?.status]
    .filter(Boolean).join(' ');
  if (!/(context[_ -]?compaction|thread[/_. -]?compact|compact[_ -]?context)/i.test(marker)) return null;
  if (/(fail|error|abort|cancel)/i.test(marker)) return 'failed';
  if (/(complete|completed|finish|finished|done|success)/i.test(marker)) return 'completed';
  if (/(start|started|begin|progress|running|compact)/i.test(marker)) return 'started';
  return null;
}

function mobileOwnedStatus(status) {
  return /running|waiting|input|approval|compact/i.test(status) ? `mobile_${status}` : status;
}

function desktopOwnedStatus(status) {
  return /running|waiting|input|approval|compact/i.test(status) ? `desktop_${status}` : status;
}

function isLiveThreadStatus(status) {
  return /running|waiting|input|approval|compact/i.test(String(status || ''));
}

function isInteractiveThreadStatus(status) {
  return /waiting|input|approval/i.test(String(status || ''));
}

function isTerminalThreadStatusValue(status) {
  return /^(completed|failed|cancelled|aborted|interrupted)$/i.test(String(status || ''));
}

function isTerminalRolloutStatus(status) {
  return /^(completed|failed|cancelled|aborted|interrupted)$/i.test(String(status || ''));
}

function rolloutTurnId(record) {
  const payload = record?.payload || {};
  return String(payload.turn_id || payload.turnId || record?.turn_id || record?.turnId || '').trim() || null;
}

function rolloutMarker(record) {
  const at = Date.parse(record?.timestamp) || 0;
  const ordinal = Number(record?.ordinal);
  return {
    at,
    ordinal: Number.isFinite(ordinal) ? ordinal : 0,
    turnId: rolloutTurnId(record),
  };
}

function compareRolloutMarkers(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return (Number(left.at) || 0) - (Number(right.at) || 0) ||
    (Number(left.ordinal) || 0) - (Number(right.ordinal) || 0) ||
    (Number(left.offset) || 0) - (Number(right.offset) || 0);
}

// A rollout's directory mtime is not a reliable activity clock on Windows:
// Codex can keep the JSONL file open and append for tens of minutes without
// updating the directory entry.  Keep status and activity together so every
// reconciliation path uses the same evidence. `activityAt` is the timestamp
// of the last conversation record, or 0 when the file contains no dated
// conversation record yet.  The marker fields are a monotonic watermark for
// status publication; unlike a watcher range they describe the record that
// actually caused the state.
function readRolloutEvidence(file, maxStatusBytes = 4 * 1024 * 1024) {
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    const activityAt = Number(readConversationActivityAt(file)) || 0;
    const evidence = latestRolloutStatusEvidence(file, stat.size, maxStatusBytes);
    return {
      stat,
      size: stat.size,
      activityAt,
      status: evidence?.status || null,
      statusMarker: evidence?.statusMarker || null,
      turnStartMarker: evidence?.turnStartMarker || null,
      statusTurnId: evidence?.statusTurnId || null,
      turnStartTurnId: evidence?.turnStartTurnId || null,
      questionEvents: evidence?.questionEvents || [],
    };
  } catch {
    return null;
  }
}

function normalizeRolloutStatusValue(status) {
  const value = String(status || '').trim();
  return value.replace(/^(?:desktop|mobile)_/i, '') || null;
}

// A tool result is progress inside a turn, not a new turn by itself. It is
// common for Codex to append bookkeeping/tool-output records after
// `task_complete`; treating those records as `running` made the same finished
// task oscillate between completed and desktop_running on every history read.
function isRolloutTurnStartRecord(record) {
  const payload = record?.payload || {};
  if (record?.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'task_started')) return true;
  return record?.type === 'response_item' && payload.type === 'message' && payload.role === 'user';
}

function isRolloutProgressRecord(record) {
  const payload = record?.payload || {};
  return record?.type === 'response_item' &&
    (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output');
}

function advanceRolloutStatus(current, record) {
  const next = rolloutStatus(record);
  if (!next) return current;
  const normalized = normalizeRolloutStatusValue(current);
  // Once a terminal marker has been observed, a bare tool output cannot
  // reopen that turn. A real user/task-start marker still can start a new one.
  if (isTerminalRolloutStatus(normalized) && next === 'running' &&
      isRolloutProgressRecord(record) && !isRolloutTurnStartRecord(record)) return normalized;
  return next;
}

function rolloutStatus(record) {
  const payload = record?.payload || {};
  if (rolloutCompactionStatus(record) === 'started') return 'running';
  if (record?.type === 'event_msg') {
    if (rolloutErrorText(record)) return 'failed';
    if (payload.type === 'user_message') return 'running';
    if (payload.type === 'task_started') return 'running';
    if (payload.type === 'task_complete') return 'completed';
    if (/aborted|cancelled|interrupted/i.test(payload.type || '')) return 'cancelled';
    if (/error|failed/i.test(payload.type || '')) return 'failed';
  }
  if (record?.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return 'running';
  if (record?.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call') && /request_user_input|requestapproval/i.test(payload.name || '') && !ASYNC_QUESTION_TOOL.test(payload.name || '')) return 'waiting_input';
  // A tool result means the turn moved on (e.g. the question was answered).
  if (record?.type === 'response_item' && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) return 'running';
  return null;
}

function rolloutUserText(record) {
  const payload = record?.payload || {};
  if (record?.type === 'event_msg' && payload.type === 'user_message') return stripLocalImageMarkup(payload.message || payload.text || '');
  if (record?.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return stripLocalImageMarkup(extractRolloutText(payload));
  return '';
}

// Full-history replay can contain millions of records. The original duplicate
// check scanned every canonical user event for every response_item (O(N²)).
// Index canonical events by their 250 ms timestamp bucket so a streaming pass
// only compares the handful of records that could actually be duplicates.
function createRolloutUserIndex() {
  return { byTime: new Map(), timeless: [], all: [], count: 0 };
}

function addRolloutUserIndex(index, event) {
  if (index.count >= MAX_ROLLOUT_USER_INDEX_EVENTS) return;
  index.count += 1;
  // Timestamped records are resolved through byTime. Keep only a small
  // fallback sample for malformed records with no timestamp so a corrupt
  // rollout cannot turn the index itself into another unbounded allocation.
  if (index.all.length < 4096) index.all.push(event);
  if (!event.at) { if (index.timeless.length < 4096) index.timeless.push(event); return; }
  const bucket = Math.floor(event.at / 250);
  const rows = index.byTime.get(bucket) || [];
  rows.push(event); index.byTime.set(bucket, rows);
}

function isDuplicateRolloutUserCopyIndexed(record, index) {
  const payload = record?.payload || {};
  if (record?.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') return false;
  const message = extractRolloutText(payload).trim();
  const imageCopy = extractInlineImages(payload).length > 0 || /<\/?image\b/i.test(message);
  const at = Date.parse(record.timestamp) || 0;
  const candidates = [];
  if (at) {
    const bucket = Math.floor(at / 250);
    for (let delta = -1; delta <= 1; delta += 1) candidates.push(...(index.byTime.get(bucket + delta) || []));
    // A malformed/zero-timestamp canonical event is still eligible under the
    // legacy rule, but this path is rare and bounded to that small side list.
    candidates.push(...index.timeless);
  } else {
    candidates.push(...index.all);
  }
  return candidates.some((event) => {
    if (at && event.at && Math.abs(at - event.at) > 250) return false;
    if (imageCopy && Array.isArray(event.localImages) && event.localImages.length) return true;
    if (!message) return false;
    return message === event.message || message.includes(event.message) || event.message.includes(message);
  });
}

function isDuplicateRolloutUserCopy(record, eventUsers) {
  const payload = record?.payload || {};
  if (record?.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') return false;
  const message = extractRolloutText(payload).trim();
  const imageCopy = extractInlineImages(payload).length > 0 || /<\/?image\b/i.test(message);
  const at = Date.parse(record.timestamp) || 0;
  return eventUsers.some((event) => {
    if (at && event.at && Math.abs(at - event.at) > 250) return false;
    if (imageCopy && Array.isArray(event.localImages) && event.localImages.length) return true;
    if (!message) return false;
    return message === event.message || message.includes(event.message) || event.message.includes(message);
  });
}

function rolloutErrorText(record) {
  if (record?.type !== 'event_msg') return '';
  const payload = record?.payload || {};
  const type = String(payload.type || '').toLowerCase();
  const explicitFailure = /^(error|failed|failure|exception|fatal_error|stream_error|task_failed|turn_failed)$/.test(type);
  const terminalFailure = type === 'task_complete' && Boolean(payload.error ?? payload.failure ?? payload.exception ?? payload.errorMessage);
  if (!explicitFailure && !terminalFailure) return '';
  const error = payload.error ?? payload.failure ?? payload.exception;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = error.message || error.detail || error.reason;
    if (typeof message === 'string' && message.trim()) return message.trim();
    try { return JSON.stringify(error); } catch {}
  }
  const message = payload.errorMessage ?? (explicitFailure ? payload.message : null);
  return typeof message === 'string' && message.trim() ? message.trim() : '';
}

function notificationErrorText(notification) {
  const params = notification?.params || {};
  const error = params.error ?? params.failure ?? params.exception;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = error.message || error.detail || error.reason;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  const message = params.message || params.reason;
  return typeof message === 'string' && message.trim() ? message.trim() : '';
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function needsPartialRolloutLineDiscard(file, offset) {
  if (!Number.isFinite(offset) || offset <= 0) return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const probe = Buffer.alloc(1);
    const read = fs.readSync(fd, probe, 0, 1, offset - 1);
    return read > 0 && probe[0] !== 0x0a;
  } catch {
    // If the boundary cannot be probed, discarding the first partial line is
    // safer than emitting a truncated JSON record.
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findRolloutLineStart(file, offset, maxBytes = MAX_PARTIAL_ROLLOUT_SCAN_BYTES) {
  const target = Math.max(0, Number(offset) || 0);
  if (!target) return { offset: 0, exact: true };
  const chunkSize = Math.min(ROLLOUT_STREAM_CHUNK_BYTES, maxBytes);
  let fd;
  let position = target;
  let scanned = 0;
  try {
    fd = fs.openSync(file, 'r');
    while (position > 0 && scanned < maxBytes) {
      const length = Math.min(chunkSize, position, maxBytes - scanned);
      const start = position - length;
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, start);
      if (!read) break;
      const newline = buffer.lastIndexOf(0x0a, read - 1);
      if (newline >= 0) return { offset: start + newline + 1, exact: true };
      position = start;
      scanned += read;
    }
  } catch {
    return { offset: Math.max(0, target - scanned), exact: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { offset: Math.max(0, target - scanned), exact: false };
}

function rolloutRangeHasNewline(file, start, end) {
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || from);
  if (from >= to) return false;
  // This probe is only used for a partial-boundary guard. Never scan an
  // unbounded malformed single-line rollout synchronously; a later retry can
  // re-check the bounded window after the record eventually closes.
  const limit = Math.min(to, from + MAX_PARTIAL_ROLLOUT_SCAN_BYTES);
  const chunkSize = ROLLOUT_STREAM_CHUNK_BYTES;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    for (let position = from; position < limit;) {
      const length = Math.min(chunkSize, limit - position);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, position);
      if (!read) break;
      if (buffer.indexOf(0x0a, 0) >= 0) return true;
      position += read;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return false;
}

function rolloutEndsWithNewline(file, end) {
  const position = Math.max(0, Number(end) || 0);
  if (!position) return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(1);
    return fs.readSync(fd, buffer, 0, 1, position - 1) === 1 && buffer[0] === 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findTrailingRolloutLineStart(file, start, end, maxBytes = MAX_PARTIAL_ROLLOUT_SCAN_BYTES) {
  const from = Math.max(0, Number(start) || 0);
  const target = Math.max(from, Number(end) || from);
  if (target <= from || rolloutEndsWithNewline(file, target)) return null;
  const chunkSize = Math.min(ROLLOUT_STREAM_CHUNK_BYTES, maxBytes);
  let fd;
  let position = target;
  let scanned = 0;
  try {
    fd = fs.openSync(file, 'r');
    while (position > from && scanned < maxBytes) {
      const length = Math.min(chunkSize, position - from, maxBytes - scanned);
      const chunkStart = position - length;
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, chunkStart);
      if (!read) break;
      const newline = buffer.lastIndexOf(0x0a, read - 1);
      if (newline >= 0) return chunkStart + newline + 1;
      position = chunkStart;
      scanned += read;
    }
  } catch {
    return Math.max(from, target - scanned);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return Math.max(from, target - scanned);
}

/**
 * Read complete JSONL lines from a bounded byte range. The returned generator
 * never retains more than one read chunk plus one in-progress line and yields
 * to the event loop after each chunk. `discardPartialLine` is used when the
 * range starts in the middle of an existing record (the normal tail case),
 * while `holdTrailingPartial` leaves an unterminated final record for the next
 * watcher tick instead of advancing its cursor to EOF.
 */
async function* readRolloutLines(file, start, end, options = {}) {
  const chunkSize = Math.max(4 * 1024, Number(options.chunkSize) || ROLLOUT_STREAM_CHUNK_BYTES);
  let fd;
  let position = Math.max(0, Number(start) || 0);
  const limit = Math.max(position, Number(end) || position);
  // Keep incomplete-line chunks as segments. Codex tool/image records can be
  // tens of megabytes long; repeatedly interpolating `carry + chunk` copies
  // the whole prefix on every read and creates huge transient allocations.
  // Join only once, when that line's newline arrives.
  let carryParts = [];
  let carryLength = 0;
  let discard = Boolean(options.discardPartialLine);
  const decoder = new StringDecoder('utf8');
  try {
    fd = fs.openSync(file, 'r');
    while (position < limit) {
      const length = Math.min(chunkSize, limit - position);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, position);
      if (!read) break;
      position += read;
      let text = decoder.write(buffer.subarray(0, read));
      if (carryParts.length && text.indexOf('\n') >= 0) {
        text = carryParts.join('') + text;
        carryParts = [];
        carryLength = 0;
      } else if (carryParts.length) {
        if (text) { carryParts.push(text); carryLength += text.length; }
        await yieldToEventLoop();
        continue;
      }
      let lineStart = 0;
      while (lineStart < text.length) {
        const newline = text.indexOf('\n', lineStart);
        if (newline < 0) {
          const tail = text.slice(lineStart);
          if (tail) { carryParts.push(tail); carryLength += tail.length; }
          break;
        }
        let line = text.slice(lineStart, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (discard) discard = false;
        else if (line.trim()) yield line;
        lineStart = newline + 1;
      }
      await yieldToEventLoop();
    }
    const finalText = decoder.end();
    if (finalText) { carryParts.push(finalText); carryLength += finalText.length; }
    if (!discard && carryLength > 0 && !options.holdTrailingPartial) {
      const line = carryParts.join('').replace(/\r$/, '');
      if (line.trim()) yield line;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function shouldDiscardPartialRolloutLine(firstRead, offset) { return firstRead && offset > 0; }

function latestRolloutStatusEvidence(file, size, maxBytes = 16 * 1024 * 1024) {
  const chunkSize = 512 * 1024; let end = size; let suffix = ''; let scanned = 0;
  let sawProgress = false;
  let statusEvidence = null;
  let turnStartEvidence = null;
  const questionEvents = [];
  while (end > 0 && scanned < maxBytes) {
    const length = Math.min(chunkSize, end, maxBytes - scanned); const start = end - length;
    const buffer = Buffer.alloc(length); const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
    const lines = `${buffer.toString('utf8')}${suffix}`.split(/\r?\n/);
    suffix = start > 0 ? (lines.shift() || '') : '';
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!/task_(started|complete)|turn_(aborted|cancelled|interrupted)|"type"\s*:\s*"(error|failed|user_message|function_call_output|custom_tool_call_output)"|"role"\s*:\s*"user"|request_user_input/i.test(line)) continue;
      try {
        const record = JSON.parse(line);
        const question = questionEvent(record);
        if (question) questionEvents.push(question);
        const marker = rolloutMarker(record);
        if (!turnStartEvidence && isRolloutTurnStartRecord(record)) {
          turnStartEvidence = { ...marker, record };
        }
        const status = rolloutStatus(record);
        if (!status || statusEvidence) continue;
        // Search past progress-only records for the last real turn boundary.
        // If the boundary is terminal, the tool output belongs to that
        // finished turn and must not revive it.
        if (status === 'running' && isRolloutProgressRecord(record)) {
          sawProgress = true;
          continue;
        }
        statusEvidence = { ...marker, status, record };
      } catch {}
    }
    // Both markers are monotonic and the first ones found while walking
    // backwards are the newest. Once both are known, older chunks cannot
    // change the answer and need not be read.
    if (statusEvidence && turnStartEvidence) break;
    end = start; scanned += length;
  }
  if (!statusEvidence && sawProgress) return { status: 'running', statusMarker: null, turnStartMarker: turnStartEvidence, questionEvents: questionEvents.reverse() };
  if (!statusEvidence) return questionEvents.length ? { status: null, questionEvents: questionEvents.reverse() } : null;
  return {
    status: statusEvidence.status,
    statusMarker: { at: statusEvidence.at, ordinal: statusEvidence.ordinal },
    turnStartMarker: turnStartEvidence ? { at: turnStartEvidence.at, ordinal: turnStartEvidence.ordinal } : null,
    statusTurnId: statusEvidence.turnId,
    turnStartTurnId: turnStartEvidence?.turnId || null,
    questionEvents: questionEvents.reverse(),
  };
}

function latestRolloutStatus(file, size, maxBytes = 16 * 1024 * 1024) {
  return latestRolloutStatusEvidence(file, size, maxBytes)?.status || null;
}

function rolloutHasTurnStartMarker(file, size, maxBytes = 4 * 1024 * 1024) {
  const chunkSize = 512 * 1024; let end = size; let suffix = ''; let scanned = 0;
  while (end > 0 && scanned < maxBytes) {
    const length = Math.min(chunkSize, end, maxBytes - scanned); const start = end - length;
    const buffer = Buffer.alloc(length); const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
    const lines = `${buffer.toString('utf8')}${suffix}`.split(/\r?\n/);
    suffix = start > 0 ? (lines.shift() || '') : '';
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index]); const payload = record?.payload || {};
        if ((record?.type === 'event_msg' && (payload.type === 'task_started' || payload.type === 'user_message')) ||
            (record?.type === 'response_item' && payload.type === 'message' && payload.role === 'user')) return true;
      } catch {}
    }
    end = start; scanned += length;
  }
  return false;
}

function recentIndexedRolloutFiles(root, limit = 30) {
  const dbFile = path.join(path.dirname(root), 'state_5.sqlite');
  if (!fs.existsSync(dbFile)) return [];
  let db;
  try {
    const { DatabaseSync } = require('./backends/antigravity').loadSqlite();
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare('select id, rollout_path from threads where archived = 0 order by updated_at_ms desc limit ?').all(limit);
    return rows.map((row) => ({ id: row.id, file: String(row.rollout_path || '') }))
      .filter(({ id, file }) => file && sessionThreadId(file) === id && fs.existsSync(file))
      .map(({ file }) => file);
  } catch {
    // Older Codex installs may not have this database or schema.
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function recentRolloutFiles(root, limit = 20) {
  const found = []; const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (/\.jsonl$/i.test(entry.name)) {
        try { found.push({ file: target, modifiedAt: fs.statSync(target).mtimeMs }); } catch {}
      }
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit).map((item) => item.file);
}

// Startup can traverse a large history tree. Keep the synchronous helper for
// existing callers, but never block the relay while discovering startup files.
async function recentRolloutFilesAsync(root, limit = 20) {
  const found = []; const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries; try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (/\.jsonl$/i.test(entry.name)) files.push(target);
    }
    // Limit outstanding disk requests on slower devices and network drives.
    for (let i = 0; i < files.length; i += 16) {
      const stats = await Promise.all(files.slice(i, i + 16).map(async (file) => {
        try { return { file, modifiedAt: (await fs.promises.stat(file)).mtimeMs }; } catch { return null; }
      }));
      for (const item of stats) if (item) found.push(item);
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit).map((item) => item.file);
}

function canonicalRolloutPath(file) {
  const resolved = path.resolve(String(file));
  try {
    // The production sync probe wraps realpathSync and does not retain its
    // .native property. The regular implementation also resolves junctions.
    const realpath = fs.realpathSync.native || fs.realpathSync;
    const real = path.resolve(realpath(resolved));
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    // A file may appear during an active write; do not cache a missing path.
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function sameRolloutFile(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  // Different filenames cannot be the same rollout page; avoid filesystem
  // resolution for the common pagination case.
  const a = path.basename(left); const b = path.basename(right);
  if (process.platform === 'win32' ? a.toLowerCase() !== b.toLowerCase() : a !== b) return false;
  return canonicalRolloutPath(left) === canonicalRolloutPath(right);
}

function isNewerRolloutFile(candidate, current) {
  if (!current) return true;
  if (sameRolloutFile(candidate, current)) return true;
  try {
    const candidateStat = fs.statSync(candidate);
    const currentStat = fs.statSync(current);
    if (candidateStat.mtimeMs !== currentStat.mtimeMs) return candidateStat.mtimeMs > currentStat.mtimeMs;
  } catch {
    // If the old page disappeared while a watcher callback is running, let
    // the callback replace it with the file that still exists.
    return true;
  }
  // Files written in the same timestamp tick are ordered by their Codex
  // filename; continuation pages carry the later suffix.
  return path.basename(candidate).localeCompare(path.basename(current)) > 0;
}

function findRolloutFilesForThreads(root, threadIds) {
  const wanted = new Set(threadIds || []); const found = new Map(); const pending = [root];
  while (pending.length && found.size < wanted.size) {
    const directory = pending.pop();
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else {
        const threadId = sessionThreadId(entry.name);
        // A paginated thread has several files; the newest is the live one.
        if (threadId && wanted.has(threadId) && (!found.has(threadId) || entry.name > path.basename(found.get(threadId)))) found.set(threadId, target);
      }
    }
  }
  return found;
}

// "rollout-<time>-<thread>.jsonl", or "rollout-<time>-<thread>_<page>.jsonl"
// once Codex continues a long (paginated) thread in a new file.
// When the newest record happened (not when it was read): re-reading an old
// rollout must not make the phone think the task has just been active.
function latestItemAt(items) {
  return items.reduce((latest, item) => Math.max(latest, Number(item.createdAt) || 0), 0) || Date.now();
}

function sessionThreadId(filename) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const match = String(filename || '').match(new RegExp(`(${uuid})(?:_${uuid})?\\.jsonl$`, 'i'));
  return match?.[1] || null;
}

function validThreadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function isSubagentThread(thread) {
  if (!thread) return false;
  const source = thread.source;
  if (thread.threadSource === 'subagent' || thread.thread_source === 'subagent') return true;
  if (source && typeof source === 'object' && (source.subagent || source.subAgent)) return true;
  if (typeof source === 'string' && /sub_?agent/i.test(source)) return true;
  if (thread.agentPath || thread.agent_path || thread.parentThreadId) return true;
  return Boolean(thread.path) && isHiddenRollout(thread.path);
}

// A thread's list entry from Codex's own local state (read-only), for when
// the app-server cannot read it: title, folder and last activity.
// Errors from Codex or the desktop adapter arrive in English; the phone shows
// them as they are, so the common ones are said in Chinese.
const PHONE_ERROR_TEXT = [
  [/already has an active writer/i, '这个任务正被电脑端 Codex 占用，请稍后再试'],
  [/Desktop adapter timed out/i, '电脑端 Codex 窗口没有及时响应，请稍后再试'],
  [/Codex Desktop shows no running turn in this task/i, '电脑端未检测到可停止的任务，请在电脑上检查这个对话的状态'],
  [/failed to archive (?:thread|session).*?(?:os error (?:17|18)|EXDEV|cross-device)/i, 'Codex 的归档目录和会话文件不在同一磁盘，暂时无法归档；请在电脑检查归档目录设置。'],
  [/thread not found/i, '电脑上找不到这个任务（可能已被删除）'],
  [/spawn .*claude(\.exe)? ENOENT/i, '电脑上找不到 Claude Code 程序（Claude 桌面端可能正在更新它），请稍等片刻再发一次'],
  [/Invalid thinking level/i, '这个模型不支持所选的思考强度，请换一个强度'],
  [/Model not found/i, '找不到这个模型，请在 PI WEB 里确认它仍然可用'],
];
// The Codex Desktop adapter names what failed with a code. The phone is told the
// code's meaning, which does not depend on the English wording of the message.
const DESKTOP_SETTINGS_ERROR_TEXT = {
  settings_button_not_found: '没能在电脑端 Codex 里找到任务设置按钮，稍后会自动重试',
  settings_menu_not_opened: '电脑端 Codex 的设置菜单没有打开，稍后会自动重试',
  model_category_not_found: '电脑端 Codex 的设置菜单里没有「模型」，稍后会自动重试',
  effort_category_not_found: '电脑端 Codex 的设置菜单里没有「推理强度」，稍后会自动重试',
  service_tier_category_not_found: '电脑端 Codex 的设置菜单里没有「速度」，稍后会自动重试',
  model_option_not_matched: '电脑端 Codex 里没有这个模型，请在电脑上选择',
  effort_option_not_matched: '电脑端 Codex 里没有这个推理强度，请在电脑上选择',
  effort_confirmation_required: '此推理强度需要在电脑端确认，请在电脑上选择',
  service_tier_option_not_matched: '电脑端 Codex 里没有这个速度选项，请在电脑上选择',
  settings_control_not_found: '电脑端 Codex 里没有找到权限按钮，请在电脑上处理',
  approval_option_not_found: '电脑端 Codex 的权限菜单里没有这个选项，请在电脑上处理',
  approval_confirmation_failed: '电脑端没有确认完全访问权限，权限没有改',
  invalid_permission_mode: '权限模式无效',
  invalid_collaboration_mode: '工作模式无效',
  empty_settings: '没有要切换的设置',
  plan_mode_unverified: '电脑端没有确认切换后的工作模式，请在电脑上确认',
  plan_mode_state_unknown: '读不出电脑端当前的工作模式，请在电脑上确认',
  plan_mode_control_not_found: '电脑端没有找到计划模式按钮，请在电脑上处理',
  plan_mode_toggle_failed: '电脑端的计划模式按钮没有响应，请在电脑上处理',
  plan_draft_present: '电脑端有未发送的草稿，请先处理后再切换计划模式',
  task_identity_unconfirmed: '没能确认电脑端打开的是这个任务，设置没有改',
  desktop_busy: '电脑上正在运行，下一轮开始时切换',
};
// A pending Desktop setting is tried this many times for transient failures before it is reported.
const DESKTOP_SETTINGS_MAX_ATTEMPTS = 6;

function phoneErrorText(message, code) {
  const byCode = DESKTOP_SETTINGS_ERROR_TEXT[String(code || '')];
  if (byCode) return byCode;
  const text = String(message || '操作失败');
  const hit = PHONE_ERROR_TEXT.find(([pattern]) => pattern.test(text));
  return hit ? hit[1] : text;
}

// Why a settings change did not apply, in Chinese: by code when the adapter gave one.
function settingsFailureText(error) {
  const byCode = DESKTOP_SETTINGS_ERROR_TEXT[String(error?.code || '')];
  if (byCode) return byCode;
  const text = phoneErrorText(error?.message);
  return /[一-鿿]/.test(text) ? text : '电脑端的设置没有完成，请在电脑上确认';
}

// Said to the phone while a Claude session is running on the desktop: the model
// and effort wait for the running turn to end.
const CLAUDE_DESKTOP_PENDING_TEXT = '电脑上正在运行，模型和强度会在下一条消息发出前切换';
// Names the Claude settings that did not change; settings that failed the same
// way are named together.
function claudeSettingsFailureText(failed) {
  const names = { permissionMode: '权限模式', model: '模型', effort: '思考强度' };
  const groups = new Map();
  for (const [key, message] of Object.entries(failed)) {
    if (!groups.has(message)) groups.set(message, []);
    groups.get(message).push(names[key] || key);
  }
  return [...groups].map(([message, labels]) => `${labels.join('和')}没有切换成功：${message}`).join('；');
}

// Codex runs commands through pwsh. When the only pwsh on this computer is the
// Microsoft Store one, PATH finds its App Execution Alias
// (...\WindowsApps\pwsh.exe), which Codex's sandbox cannot start
// ("CreateProcessAsUserW failed: 5"); in the app-server the command then just
// hangs. Only full access works then; the phone warns before a sandboxed mode.
let sandboxShellBlocked = null;
function codexSandboxShellBlocked() {
  if (sandboxShellBlocked !== null || process.platform !== 'win32') return Boolean(sandboxShellBlocked);
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
  // Listed, not stat()ed: an App Execution Alias is a reparse point stat() reports as missing.
  const has = (dir) => { try { return fs.readdirSync(dir).some((name) => name.toLowerCase() === 'pwsh.exe'); } catch { return false; } };
  const first = dirs.find(has) || '';
  const installed = ['ProgramFiles', 'ProgramW6432'].map((name) => process.env[name]).filter(Boolean)
    .some((base) => { try { return fs.readdirSync(path.join(base, 'PowerShell')).some((v) => fs.existsSync(path.join(base, 'PowerShell', v, 'pwsh.exe'))); } catch { return false; } });
  sandboxShellBlocked = /\\WindowsApps\\?$/i.test(first) && !installed;
  return sandboxShellBlocked;
}

function localCodexThread(threadId) {
  const fallback = { id: threadId, name: sessionIndexTitle(threadId) || null };
  try {
    const { DatabaseSync } = require('./backends/antigravity').loadSqlite();
    const db = new DatabaseSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state_5.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('select name, title, preview, first_user_message, cwd, rollout_path, updated_at_ms, created_at_ms, archived from threads where id = ?').get(threadId);
      if (!row) return fallback;
      const firstLine = String(row.first_user_message || row.preview || '').trim().split(/\r?\n/)[0].slice(0, 60);
      return { id: threadId, name: row.name || fallback.name || row.title || firstLine || null, cwd: String(row.cwd || '').replace(/^\\\\\?\\/, ''),
        path: row.rollout_path, updatedAt: Number(row.updated_at_ms) || 0, createdAt: Number(row.created_at_ms) || 0, archived: Boolean(row.archived) };
    } finally { db.close(); }
  } catch { return fallback; }
}

// The title Codex Desktop shows for a thread, from its session index (used
// when the thread cannot be read through the app-server).
function sessionIndexTitle(threadId) {
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'session_index.jsonl');
    let title = null;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.includes(threadId)) continue;
      try { const row = JSON.parse(line); if (row.id === threadId && row.thread_name) title = row.thread_name; } catch { /* skip */ }
    }
    return title;
  } catch { return null; }
}

function isHiddenRollout(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, length).toString('utf8').split(/\r?\n/)) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== 'session_meta') continue;
      const payload = record.payload || {};
      return payload.thread_source === 'subagent' || Boolean(payload.source?.subagent);
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return false;
}

function chunkByEncodedSize(items, maxBytes = 1_500_000, maxItems = 100) {
  const batches = []; let batch = []; let bytes = 12;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (batch.length && (batch.length >= maxItems || bytes + itemBytes > maxBytes)) { batches.push(batch); batch = []; bytes = 12; }
    batch.push(item); bytes += itemBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Codex asks without stopping (request_user_input_async): the call is accepted
// at once and the turn goes on. Codex Desktop shows the options on a click and
// sends the choice as a user message (see questionReplyText); the phone does the same.
const ASYNC_QUESTION_TOOL = /(?:^|[.\/])request_user_input_async$/i;

function asyncQuestions(payload) {
  let args = {};
  try { args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : (payload.arguments || {}); } catch { return []; }
  const callId = String(payload.call_id || payload.id || '');
  return (Array.isArray(args.questions) ? args.questions : []).map((question, index) => ({
    // The id Codex Desktop uses for this question in its reply.
    id: JSON.stringify(['request_user_input_async', callId, index]),
    question: String(question?.title ?? question?.question ?? question?.prompt ?? '').trim(),
    options: (Array.isArray(question?.options) ? question.options : [])
      .map((option) => String(typeof option === 'string' ? option : option?.label ?? option?.value ?? '').trim()).filter(Boolean),
  })).filter((question) => question.question);
}

function rolloutItem(record) {
  const compaction = rolloutCompactionStatus(record);
  if (compaction) {
    const payload = record.payload || {};
    const text = extractRolloutText(payload) || (compaction === 'started' ? '正在整理上下文' : compaction === 'completed' ? '上下文整理完成' : '上下文整理失败');
    return { type: 'contextCompaction', ...clip(text), status: compaction === 'started' ? 'running' : compaction };
  }
  if (record?.type === 'event_msg') {
    // The Desktop image tool currently writes completed images as an
    // `event_msg/image_generation_end` record (rather than a response_item).
    // Treat it as a first-class history item so the large base64 result is
    // retained in `images` and never flattened into visible text.
    const payload = record.payload || {};
    if (/image[_-]?generation/i.test(String(payload.type || ''))) {
      const images = extractInlineImages(payload);
      return {
        type: 'imageGeneration',
        text: images.length ? '图片已生成' : '图片生成完成',
        truncated: false,
        ...(images.length ? { images } : {}),
        status: payload.status || (images.length ? 'completed' : 'running'),
      };
    }
    const error = rolloutErrorText(record);
    if (error) return { type: 'turnError', ...clip(error), status: 'failed' };
    if (payload.type === 'item_completed') return typedRolloutItem(payload.item, payload);
    if (payload.type === 'user_message') {
      const text = stripRequestMarker(stripLocalImageMarkup(payload.message || payload.text || ''));
      const localImages = Array.isArray(payload.local_images) ? payload.local_images : [];
      const imageRows = localImages.map((value) => {
        const rawName = String(value || '').split(/[\\/]/).pop() || '图片附件';
        const match = rawName.match(/^([0-9a-f-]{36})-(.+)$/i);
        const name = match?.[2] || rawName;
        return match ? `[khLink 图片附件] ${name}\n附件编号：${match[1]}` : `[khLink 图片附件] ${name}`;
      });
      const visible = text.trim() || (imageRows.length ? imageRows.join('\n\n') : '');
      return visible ? { type: 'userMessage', ...clip(visible), status: null } : null;
    }
    return null;
  }
  if (record?.type !== 'response_item') return null;
  const payload = record.payload || {}; const type = payload.type;
  const text = extractRolloutText(payload);
  // developer/system messages are instructions Codex gives the model.
  if (type === 'message' && (payload.role === 'developer' || payload.role === 'system' || isInternalContextText(text))) return null;
  if (type === 'message') {
    const images = extractInlineImages(payload);
    const user = payload.role === 'user';
    const visible = stripProposedPlanMarkup(stripRequestMarker(stripLocalImageMarkup(text)));
    const fallback = user && images.length ? '图片附件' : '';
    return visible || fallback ? { type: user ? 'userMessage' : 'agentMessage', ...clip(visible || fallback), ...(images.length ? { images } : {}), status: null } : null;
  }
  if (type === 'reasoning') return { type: 'reasoning', ...clip(text || payload.summary || ''), status: null };
  // Codex app-server records built-in image generation as an
  // image_generation_call/imageGeneration response item.  Keep the result as
  // an image-bearing history item instead of serializing its multi-megabyte
  // base64 payload into the visible text.
  if (/image[_-]?generation/i.test(String(type))) {
    const images = extractInlineImages(payload);
    return { type: 'imageGeneration', text: images.length ? '图片已生成' : '图片生成完成', truncated: false, ...(images.length ? { images } : {}), status: payload.status || 'completed' };
  }
  // Tool calls: the typed item_completed events (typedRolloutItem) describe
  // what actually ran, the way Codex Desktop shows it. The raw calls are the
  // code-mode `exec` script / apply_patch wrapper, so they are only used for
  // older rollouts' plain shell calls, which have no typed counterpart.
  if (type === 'function_call' && SHELL_FUNCTION_NAMES.has(payload.name)) {
    const command = shellCallCommand(payload.arguments);
    return command ? { type: 'commandExecution', ...clip(command), status: 'completed' } : null;
  }
  if (type === 'function_call' && ASYNC_QUESTION_TOOL.test(payload.name || '')) {
    const questions = asyncQuestions(payload);
    return questions.length ? { type: 'codexQuestion', ...clip(questions.map((question) => question.question).join('\n')), questions, status: null } : null;
  }
  if (type === 'custom_tool_call' || type === 'function_call') return null;
  if (type === 'custom_tool_call_output' || type === 'function_call_output') {
    const images = extractInlineImages(payload.output);
    if (images.length) {
      const generated = hasGeneratedImageMarker(payload.output);
      return { type: generated ? 'imageGeneration' : 'imageView', text: generated ? '图片已生成' : (text || '在电脑端查看了图片'), truncated: false, images, status: 'completed' };
    }
    return null;
  }
  if (/patch|file_change/i.test(type)) return { type: 'fileChange', ...clip(text || payload), status: payload.status || null };
  return null;
}

// History items the phone should drop. There is no delete on the relay, so a
// record that older connectors uploaded as visible (developer instructions,
// the code-mode exec script and its raw output) is overwritten under its old
// id with this during a history rebuild.
const HIDDEN_ITEM = Object.freeze({ type: 'hidden', text: '', truncated: false, status: null });

function legacyVisibleRecord(record) {
  if (record?.type !== 'response_item') return false;
  const payload = record.payload || {};
  if (payload.type === 'message') return payload.role === 'developer' || payload.role === 'system' || isInternalContextText(extractRolloutText(payload));
  return payload.type === 'custom_tool_call' || payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output';
}

const SHELL_FUNCTION_NAMES = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec']);

function shellCallCommand(args) {
  let value = args;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return value; } }
  const command = value?.command ?? value?.cmd;
  if (Array.isArray(command)) return commandLine(command);
  return typeof command === 'string' ? command : '';
}

// ['pwsh.exe', '-Command', 'Get-Content x'] or '"C:\...\pwsh.exe" -Command 'Get-Content x''
// -> 'Get-Content x': the shell wrapper is noise on a phone screen.
function commandLine(command) {
  if (!Array.isArray(command)) {
    const text = String(command || '');
    const match = text.match(/^\s*(?:"[^"]*"|\S+)(?:\s+-(?!c\s|command\s)\S+)*\s+-(?:c|command)\s+([\s\S]+)$/i);
    if (!match) return text;
    const body = match[1].trim();
    const quoted = body.match(/^(['"])([\s\S]*)\1$/);
    return quoted ? quoted[2] : body;
  }
  const flag = command.findIndex((part) => /^-(c|command)$/i.test(String(part)) || String(part) === '/c');
  if (flag >= 0 && flag < command.length - 1) return command.slice(flag + 1).join(' ');
  return command.join(' ');
}

function durationMs(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') return Math.round((Number(value.secs) || 0) * 1000 + (Number(value.nanos) || 0) / 1e6);
  return null;
}

const FILE_CHANGE_LABELS = { add: '新增', create: '新增', delete: '删除', remove: '删除', update: '修改', modify: '修改', rename: '重命名', move: '移动' };

// Codex's own typed item (event_msg/item_completed), as shown in its UI.
function typedRolloutItem(item, event = {}) {
  if (!item || typeof item !== 'object') return null;
  const failed = item.status === 'failed' || item.status === 'declined';
  switch (item.type) {
    case 'CommandExecution': {
      const command = commandLine(item.command) || (Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map((part) => part?.cmd).filter(Boolean).join('\n') : '');
      const output = String(item.aggregated_output ?? item.formatted_output ?? item.stdout ?? '').trim();
      const exit = item.exit_code ?? item.exitCode;
      const nonZero = exit !== undefined && exit !== null && Number(exit) !== 0;
      const body = [command, output].filter(Boolean).join('\n\n');
      const took = durationMs(item.duration);
      return { type: 'commandExecution', ...clip(body || '命令'), status: failed || nonZero ? 'failed' : (item.status || 'completed'),
        ...(nonZero ? { exitCode: Number(exit) } : {}), ...(took !== null ? { durationMs: took } : {}) };
    }
    case 'FileChange': {
      const changes = item.changes && typeof item.changes === 'object' ? Object.entries(item.changes) : [];
      const lines = changes.map(([file, change]) => `${FILE_CHANGE_LABELS[String(change?.type || '').toLowerCase()] || '修改'} ${file}`);
      return { type: 'fileChange', ...clip(lines.join('\n') || String(item.stdout || '文件变更')), status: failed ? 'failed' : (item.status || 'completed') };
    }
    case 'McpToolCall': {
      const title = item.arguments?.title || item.title || '';
      const name = [item.server, item.tool].filter(Boolean).join(' · ');
      return { type: 'mcpToolCall', ...clip([name, title].filter(Boolean).join('\n') || '工具调用'), status: failed ? 'failed' : (item.status || 'completed') };
    }
    case 'WebSearch': {
      const query = item.query || item.action?.query || '';
      return { type: 'webSearch', ...clip(query || '网络搜索'), status: item.status || 'completed' };
    }
    case 'CollabAgentToolCall':
      return { type: 'collabAgentToolCall', ...clip(`协作：${item.tool || 'agent'}`), status: item.status || 'completed' };
    case 'ContextCompaction': {
      // Codex Desktop writes compaction only once it has finished, with its start and end times.
      const started = Number(event.started_at_ms); const completed = Number(event.completed_at_ms);
      const took = started > 0 && completed >= started ? completed - started : null;
      return { type: 'contextCompaction', ...clip('上下文已自动压缩'), status: 'completed', ...(took !== null ? { durationMs: took } : {}) };
    }
    default:
      return null;
  }
}

function rolloutCompactionStatus(record) {
  const payload = record?.payload || {};
  const marker = [payload.type, payload.method, payload.event, payload.stage, payload.status]
    .filter(Boolean).join(' ');
  if (!/(context[_ -]?compaction|thread[/_. -]?compact|compact[_ -]?context)/i.test(marker)) return null;
  if (/(fail|error|abort|cancel)/i.test(marker)) return 'failed';
  if (/(complete|completed|finish|finished|done|success)/i.test(marker)) return 'completed';
  return 'started';
}

function extractRolloutText(payload) {
  const content = payload.content || payload.output || payload.summary;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
}

const PRESENCE_FULL_MS = 60_000;

// What a presence says, without what changes every second on its own: the
// time, the PC load, and each live thread's observation time (a running Claude
// turn moves it with every event; status events carry the exact moment).
function presenceSignature(payload) {
  const { sentAt, pcLoad, activeThreads, ...rest } = payload || {};
  return JSON.stringify({ ...rest, activeThreads: (activeThreads || []).map((row) => [row.threadId, row.status]) });
}

function assertCommandThread(envelopeThreadId, payloadThreadId) {
  if (envelopeThreadId && payloadThreadId && String(envelopeThreadId) !== String(payloadThreadId)) {
    throw new Error('任务标识不一致，已拒绝可能串线的操作');
  }
}

claudeDesktopSync.install(Connector);
piSync.install(Connector);
antigravitySync.install(Connector);
dshSync.install(Connector);
hermesSync.install(Connector);

module.exports = { Connector, threadSettingsUpdateParams, modeSettings, presenceSignature, PRESENCE_FULL_MS, phoneErrorText, typedRolloutItem, describeApproval, approvalOptions, normalizeMobileInputRequest, semanticAnswerResult, assertCommandThread, isActiveThread, isTerminalThreadStatus, isExplicitTerminalThreadStatus, threadPollSignature, sessionThreadId, isHiddenRollout, chunkByEncodedSize, rolloutItem, rolloutStatus, rolloutUserText, isDuplicateRolloutUserCopy, rolloutErrorText, notificationErrorText, shouldDiscardPartialRolloutLine, notificationStatus, contextCompactionStatus, rolloutCompactionStatus, mobileOwnedStatus, desktopOwnedStatus, latestRolloutStatus, latestRolloutStatusEvidence, readRolloutEvidence, recentRolloutFiles, readHistoryAttachmentPreviews, codexInput, withAttachmentContext, stripLocalImageMarkup, readRolloutLines, HISTORY_RECENT_TAIL_BYTES, HISTORY_BACKFILL_VERSION, HISTORY_FULL_REPLAY_MAX_BYTES, ROLLOUT_STREAM_CHUNK_BYTES, DESKTOP_STATUS_REACTIVATE_GRACE_MS, DESKTOP_STATUS_IDLE_GRACE_MS };
