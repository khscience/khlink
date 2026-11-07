package vip.fengzhu.bridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import android.provider.Settings
import android.net.Uri
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.TimeUnit
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.SocketTimeoutException
import java.security.MessageDigest

internal enum class AuthFailureAction { REFRESH_ACCESS, REQUIRE_REAUTH, KEEP_SESSION }

internal fun websocketAuthFailureAction(statusCode: Int?): AuthFailureAction = when (statusCode) {
    401 -> AuthFailureAction.REFRESH_ACCESS
    else -> AuthFailureAction.KEEP_SESSION
}

internal fun refreshAuthFailureAction(statusCode: Int?): AuthFailureAction = when (statusCode) {
    401, 403 -> AuthFailureAction.REQUIRE_REAUTH
    else -> AuthFailureAction.KEEP_SESSION
}

internal fun shouldRetryPairingPoll(statusCode: Int?): Boolean = statusCode == null || statusCode >= 500

/** The computer did not answer a command in time; the action may still finish there. */
internal class CommandTimeoutException(timeoutMs: Long) :
    IOException("电脑端 ${timeoutMs / 1000} 秒内没有回应，操作可能还在进行。请先看看电脑或这条对话，再决定要不要重试")

internal fun isRetryableTransferFailure(cause: Throwable): Boolean {
    if (cause is CancellationException) return false
    val message = cause.message.orEmpty()
    return cause is IOException ||
        message.contains("timeout", ignoreCase = true) ||
        message.contains("timed out", ignoreCase = true) ||
        message.contains("连接", ignoreCase = true) ||
        message.contains("socket", ignoreCase = true)
}

internal fun isRetryableCodexAgentLoopError(message: String): Boolean =
    message.contains("failed to submit turn input", ignoreCase = true) ||
        message.contains("agent loop died", ignoreCase = true) ||
        message.contains("agent loop exited", ignoreCase = true) ||
        message.contains("agent loop crashed", ignoreCase = true)

private class HttpStatusException(val statusCode: Int, message: String) : IllegalStateException(message)

/** The ongoing service notification's line while the computer is connected. */
const val CONNECTED_NOTICE = "后台保持与电脑的连接"

// A session can connect once it has the account key and a way in (a refresh
// token, or a direct link). Account login (v2) also needs its account; a
// self-hosted relay's password login (v1) has none.
internal fun sessionConfigured(protocolVersion: Int, hasAccountKey: Boolean, directMode: Boolean, hasRefresh: Boolean, accountId: String?): Boolean =
    hasAccountKey && (directMode || hasRefresh) && (protocolVersion != 2 || !accountId.isNullOrBlank())

class BridgeRepository(private val context: Context) {
    private val crypto = CryptoStore(context)
    private val database = BridgeDatabase.get(context)
    private val historyCachePrefs = context.getSharedPreferences("history-cache-state", Context.MODE_PRIVATE)
    private val tokenUsagePrefs = context.getSharedPreferences("conversation-token-usage", Context.MODE_PRIVATE)
    private val displayPrefs = context.getSharedPreferences("display-preferences", Context.MODE_PRIVATE)
    private val _claudeConsent = MutableStateFlow(ClaudeConsent.fromStored(displayPrefs.getString("claude_remote_consent_v1", null)))
    val claudeConsent: StateFlow<ClaudeConsent> = _claudeConsent
    fun setClaudeConsent(enabled: Boolean) {
        val value = if (enabled) ClaudeConsent.Enabled else ClaudeConsent.Disabled
        displayPrefs.edit().putString("claude_remote_consent_v1", value.stored).apply()
        _claudeConsent.value = value
    }
    private val _accountsAvailable = MutableStateFlow(false)
    val accountsAvailable: StateFlow<Boolean> = _accountsAvailable
    private val _agentAccounts = MutableStateFlow<Map<String, AgentAccountsState>>(emptyMap())
    val agentAccounts: StateFlow<Map<String, AgentAccountsState>> = _agentAccounts
    private val _accountRequestPending = MutableStateFlow(false)
    val accountRequestPending: StateFlow<Boolean> = _accountRequestPending
    private val _accountReadErrors = MutableStateFlow<Map<String, String>>(emptyMap())
    val accountReadErrors: StateFlow<Map<String, String>> = _accountReadErrors
    private fun applyAgentAccounts(payload: JSONObject) {
        val next = parseAgentAccounts(payload) ?: return
        val previous = _agentAccounts.value[next.backend]
        val merged = mergeAgentAccounts(previous, next).withClaudeUsage(_claudeUsage.value)
        _agentAccounts.value = _agentAccounts.value + (next.backend to merged)
        if (previous != null && (previous.active?.id != merged.active?.id || previous.switching && !merged.switching)) refreshAfterAgentAccountChange(next.backend)
        val key = "account-switch:${selectedConnector().orEmpty()}"
        val pending = displayPrefs.getString(key, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (pending?.optString("requestId") == merged.operation?.requestId && merged.operation?.busy == false) displayPrefs.edit().remove(key).apply()
    }
    suspend fun refreshAgentAccounts(backend: String) {
        if (!_accountsAvailable.value || backend !in setOf("claude", "codex") || backend == "claude" && !_claudeConsent.value.enabled) return
        val sessionTicket = sessionSnapshotGuard.capture()
        val connector = selectedConnector()
        try {
            val response = commandResult(requestCommand("accounts.read", null, JSONObject().put("backend", backend), 25_000))
            sessionSnapshotGuard.publish(sessionTicket) {
                if (connector == selectedConnector()) { applyAgentAccounts(response); _accountReadErrors.value = _accountReadErrors.value - backend }
            }
        } catch (e: Exception) {
            sessionSnapshotGuard.publish(sessionTicket) {
                if (connector == selectedConnector()) _accountReadErrors.value = _accountReadErrors.value + (backend to "暂时无法读取电脑账号，请检查连接后刷新")
            }
            throw e
        }
    }
    suspend fun switchAgentAccount(target: String, operation: String = "switch") {
        check(_claudeConsent.value.enabled) { "请先确认开启 Claude 远程控制" }
        check(!usingV2() || _account.value?.canWrite == true) { "当前账户为只读，不能切换电脑账号" }
        check(!_accountRequestPending.value) { "正在确认上一次请求" }
        val key = "account-switch:${selectedConnector().orEmpty()}"
        val old = displayPrefs.getString(key, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        val id = if (old?.optString("to") == target && old.optString("operation") == operation) old.optString("requestId") else UUID.randomUUID().toString()
        val args = JSONObject().put("backend", "claude").put("to", target).put("operation", operation).put("requestId", id)
        displayPrefs.edit().putString(key, args.toString()).apply()
        _accountRequestPending.value = true
        try {
            val response = commandResult(requestCommand("accounts.switch", null, args, 30_000))
            if (!response.optBoolean("accepted")) {
                displayPrefs.edit().remove(key).apply()
                val reasons = response.optJSONArray("blockers")
                error((0 until (reasons?.length() ?: 0)).mapNotNull { reasons?.optJSONObject(it)?.optString("message") }.joinToString("；").ifBlank { "电脑暂时不能切换账号" })
            }
            refreshAgentAccounts("claude")
        } finally { _accountRequestPending.value = false }
    }
    private val _tokenDisplayUnit = MutableStateFlow(TokenDisplayUnit.fromStored(displayPrefs.getString("token_unit", null)))
    val tokenDisplayUnit: StateFlow<TokenDisplayUnit> = _tokenDisplayUnit
    fun saveTokenDisplayUnit(unit: TokenDisplayUnit) {
        displayPrefs.edit().putString("token_unit", unit.id).apply()
        _tokenDisplayUnit.value = unit
    }
    // This phone's own choice: the computer's CPU, GPU and memory at the top of the list.
    private val _showPcLoad = MutableStateFlow(displayPrefs.getBoolean("show_pc_load", false))
    val showPcLoad: StateFlow<Boolean> = _showPcLoad
    fun saveShowPcLoad(enabled: Boolean) {
        displayPrefs.edit().putBoolean("show_pc_load", enabled).apply()
        _showPcLoad.value = enabled
    }
    // 后台下载更新 (on by default): a new version found in the background is
    // downloaded on any network (not only on Wi-Fi), so the
    // notification only asks to install it.
    private val _autoDownloadUpdates = MutableStateFlow(displayPrefs.getBoolean("auto_download_updates", true))
    val autoDownloadUpdates: StateFlow<Boolean> = _autoDownloadUpdates
    fun saveAutoDownloadUpdates(enabled: Boolean) {
        displayPrefs.edit().putBoolean("auto_download_updates", enabled).apply()
        _autoDownloadUpdates.value = enabled
    }

    /**
     * The package of [update] already downloaded and checked (by the
     * background, or before the app was restarted): ready to install at once.
     */
    fun restoreDownloadedUpdate(update: UpdateInfo): Boolean {
        val target = File(File(context.cacheDir, "updates"), "fengzhu-codex-${update.versionCode}.apk")
        if (!target.isFile) return false
        if (!fileSha256(target).equals(update.sha256, ignoreCase = true)) { target.delete(); return false }
        synchronized(updateDownloadLock) {
            // Never over a download in progress: it owns the state.
            if (_updateDownload.value is UpdateDownloadState.Downloading) return false
            downloadedUpdate = target
            _updateDownload.value = UpdateDownloadState.Ready(update.versionName)
        }
        return true
    }

    // Light mode (轻量模式) is the account's: every connector keeps it, and the
    // newest change wins, so two phones never undo each other in a loop.
    private val _lightMode = MutableStateFlow(displayPrefs.getBoolean("light_mode", false))
    val lightMode: StateFlow<Boolean> = _lightMode
    private var lightModeAt = displayPrefs.getLong("light_mode_at", 0L)
    private val lightModeSentAt = mutableMapOf<String, Long>()
    fun saveLightMode(enabled: Boolean) {
        lightModeAt = System.currentTimeMillis()
        displayPrefs.edit().putBoolean("light_mode", enabled).putLong("light_mode_at", lightModeAt).apply()
        _lightMode.value = enabled
        lightModeSentAt.clear()
        val connectors = _devices.value.filter { !it.revoked && it.type.equals("connector", true) }.map { it.id }
        if (connectors.isEmpty()) sendLightMode(null) else connectors.forEach(::sendLightMode)
    }
    private fun sendLightMode(target: String?) {
        runCatching {
            val args = JSONObject().put("enabled", _lightMode.value).put("changedAt", lightModeAt)
            sendFrame("command", null, JSONObject().put("requestId", UUID.randomUUID().toString()).put("action", "connector.lightMode").put("args", args), target)
        }.onFailure { Log.w(LOG_TAG, "light mode not sent: " + it.message) }
    }
    /** A connector reports its light mode with each heartbeat: adopt a newer choice, or send ours. */
    private fun reconcileLightMode(source: String?, payload: JSONObject) {
        if (source == null || !payload.has("lightMode")) return
        val theirs = payload.optBoolean("lightMode"); val theirAt = payload.optLong("lightModeAt")
        if (theirs == _lightMode.value) return
        if (theirAt > lightModeAt) {
            lightModeAt = theirAt; _lightMode.value = theirs
            displayPrefs.edit().putBoolean("light_mode", theirs).putLong("light_mode_at", theirAt).apply()
            return
        }
        val now = System.currentTimeMillis()
        if (now - (lightModeSentAt[source] ?: 0L) < 30_000L) return
        lightModeSentAt[source] = now
        sendLightMode(source)
    }

    // Details of light-mode placeholders for the open conversation, by item id.
    private val _lightDetails = MutableStateFlow<Map<String, HistoryItem>>(emptyMap())
    val lightDetails: StateFlow<Map<String, HistoryItem>> = _lightDetails
    private val _lightFetching = MutableStateFlow<Set<String>>(emptySet())
    val lightFetching: StateFlow<Set<String>> = _lightFetching
    private var lightDetailsThread: String? = null

    suspend fun loadLightDetails(threadId: String) = withContext(Dispatchers.IO) {
        val sessionTicket = sessionSnapshotGuard.capture()
        val rows = database.cache().lightDetails(threadId)
        val decoded = rows.mapNotNull { row -> decodeLightDetail(threadId, row.id, row.itemOrder, row.nonce, row.ciphertext) }
        sessionSnapshotGuard.publish(sessionTicket) {
            lightDetailsThread = threadId
            _lightDetails.value = decoded.associateBy { it.id }
        }
        Unit
    }

    private fun decodeLightDetail(threadId: String, id: String, order: Long, nonce: String, ciphertext: String): HistoryItem? =
        decodeItem(threadId, JSONObject().put("id", id).put("itemOrder", order).put("nonce", nonce).put("ciphertext", ciphertext))

    /** Fetch the full rows of these placeholders from the computer and keep them. Null when done, else why not. */
    suspend fun fetchLightDetails(threadId: String, placeholders: List<HistoryItem>): String? = withContext(Dispatchers.IO) {
        val key = placeholders.firstOrNull()?.id ?: return@withContext null
        if (key in _lightFetching.value) return@withContext null
        _lightFetching.value = _lightFetching.value + key
        try {
            val now = System.currentTimeMillis()
            var legacyConnector = false
            val saved = mutableListOf<LightDetail>()
            val decoded = mutableListOf<HistoryItem>()
            for (placeholder in placeholders.distinctBy { it.id }.take(200)) {
                var first: JSONObject? = null
                if (!legacyConnector) {
                    val response = retryPendingLightDetail {
                        val reply = requestCommand("file.historyDetailPart", threadId,
                            JSONObject().put("threadId", threadId).put("id", placeholder.id).put("offset", 0).put("resumeSearch", true), 45_000)
                        val part = if (reply.optBoolean("ok", true)) commandResult(reply) else null
                        val pending = part?.optBoolean("pending") == true
                        if (pending) check(part?.optString("id") == placeholder.id && part?.optBoolean("found") == false) { "电脑返回的检索状态无效" }
                        pending to reply
                    }
                    if (!response.optBoolean("ok", true) && unsupportedLightDetailParts(response.optString("error"))) legacyConnector = true
                    else first = commandResult(response)
                }
                val detail = if (legacyConnector) {
                    // Older connectors can send a single small text row safely,
                    // but an image can exceed the relay's frame limit.
                    check(legacyLightDetailSafe(placeholder)) { "电脑连接器版本较旧，请更新后再取回图片" }
                    val result = commandResult(requestCommand("history.details", threadId,
                        JSONObject().put("threadId", threadId).put("ids", JSONArray().put(placeholder.id)), 45_000))
                    val row = result.optJSONArray("items")?.optJSONObject(0)
                    if (row == null || row.optString("id") != placeholder.id) null
                    else LightDetail(threadId, placeholder.id, placeholder.order, row.optString("nonce"), row.optString("ciphertext"), now)
                } else {
                    var result = requireNotNull(first)
                    check(result.has("found")) { "电脑返回的详细过程不完整" }
                    if (!result.optBoolean("found")) null else {
                        val assembler = LightDetailAssembler(placeholder.id)
                        while (true) {
                            assembler.add(LightDetailPart(
                                id = result.optString("id"), offset = result.optInt("offset", -1), total = result.optInt("total", -1),
                                nonce = result.optString("nonce"), transferId = result.optString("transferId").takeIf { it.isNotBlank() && it != "null" },
                                chunk = result.optString("chunk"), eof = result.optBoolean("eof"),
                            ))
                            if (assembler.complete) break
                            result = commandResult(requestCommand("file.historyDetailPart", threadId,
                                JSONObject().put("threadId", threadId).put("id", placeholder.id)
                                    .put("transferId", assembler.transferId).put("offset", assembler.offset), 45_000))
                        }
                        LightDetail(threadId, placeholder.id, placeholder.order, assembler.nonce, assembler.ciphertext, now)
                    }
                }
                if (detail != null) {
                    val value = decodeLightDetail(threadId, detail.id, detail.itemOrder, detail.nonce, detail.ciphertext)
                        ?: error("详细过程校验失败，请重试")
                    saved += detail
                    decoded += value
                }
            }
            if (saved.isEmpty()) return@withContext "电脑上没有找到这些详细过程"
            database.cache().putLightDetails(saved)
            if (lightDetailsThread == threadId) {
                _lightDetails.value = _lightDetails.value + decoded.associateBy { it.id }
            }
            null
        } catch (error: CommandTimeoutException) {
            "电脑离线或没有响应，暂时取不回"
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            error.message ?: "取回失败"
        } finally {
            _lightFetching.value = _lightFetching.value - key
        }
    }

    private val tokenUsageLock = Any()
    private val _conversationUsage = MutableStateFlow<Map<String, ConversationTokenUsage>>(emptyMap())
    val conversationUsage: StateFlow<Map<String, ConversationTokenUsage>> = _conversationUsage
    private val _usageLoading = MutableStateFlow<Set<String>>(emptySet())
    val usageLoading: StateFlow<Set<String>> = _usageLoading
    private val followupNoticePrefs = context.getSharedPreferences("followup-failure-notices", Context.MODE_PRIVATE)
    private val followupFailureNotices = FollowupFailureNotices(followupNoticePrefs.getStringSet("seen", emptySet()).orEmpty())
    private val startFeedbackPrefs = context.getSharedPreferences("message-start-feedback", Context.MODE_PRIVATE)
    private val startFeedback = MessageStartFeedback(runCatching {
        val saved = JSONObject(startFeedbackPrefs.getString("pending", "{}").orEmpty())
        saved.keys().asSequence().associateWith { saved.optLong(it) }
    }.getOrDefault(emptyMap()))
    private val desktopCodexPins = java.util.concurrent.ConcurrentHashMap<String, List<String>>()
    private val desktopCodexPinsAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val desktopClaudePins = java.util.concurrent.ConcurrentHashMap<String, List<String>>()
    private val desktopClaudePinsAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private var desktopPinOwnershipRefresh: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // The default OkHttp read timeout is only 10 seconds.  History/event replay can
    // legitimately take longer while the relay is catching up after a phone resume.
    // Keep the WebSocket alive and give those idempotent reads enough time to finish.
    private val client = OkHttpClient.Builder()
        // Do not leave a foreground resume stuck on a dead network route,
        // while still allowing slow history reads to finish after the socket is up.
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    // APK downloads run for over a minute on a slow overseas VPN. Over HTTP/2
    // the long-lived stream was being reset mid-transfer ("stream was reset:
    // PROTOCOL_ERROR"), truncating the file. Force HTTP/1.1 (which downloads the
    // full file reliably on the same network) and allow generous idle gaps; the
    // per-attempt Range resume in downloadUpdate handles any drop that still happens.
    private val downloadClient = client.newBuilder()
        .protocols(listOf(Protocol.HTTP_1_1))
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()
    // GitHub Releases is tried first for updates but may be slow or blocked:
    // give up on it quickly so the relay takes over.
    private val updateCheckClient = client.newBuilder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()
    private val mirrorDownloadClient = downloadClient.newBuilder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()
    private val authClient = client.newBuilder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .writeTimeout(12, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()
    private var socket: WebSocket? = null
    private var reconnect = true
    @Volatile private var relayConnected = false
    @Volatile private var connectInFlight = false
    @Volatile private var connectorHeartbeatAt = 0L
    @Volatile private var connectorConnectedAt = 0L
    private var connectorWatchdogJob: Job? = null
    private var connectWatchdogJob: Job? = null
    private var reconnectJob: Job? = null
    @Volatile private var socketStartedAt = 0L
    @Volatile private var activityBackgrounded = false
    private var reconnectAttempt = 0
    private var lastSequence = crypto.sequence()
    private data class PendingAction(
        val action: String,
        val threadId: String?,
        val args: JSONObject,
        val createdAt: Long = System.currentTimeMillis(),
    )
    private val pendingActions = java.util.concurrent.ConcurrentHashMap<String, PendingAction>()
    private val pendingInstructionRetries = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val pendingInstructionRetryAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val pendingInstructionTimeouts = java.util.concurrent.ConcurrentHashMap<String, Job>()
    private val pendingRequests = java.util.concurrent.ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    // A rollout file is initially uploaded from its tail for fast startup.
    // Keep the last request time instead of a process-lifetime boolean.  A
    // connector restart, a queued/failed request, or a later desktop update
    // must be able to request the missing history again without flooding the
    // relay on every Compose recomposition.
    private val historyBackfillRequestedAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    // Threads whose history the computer is still preparing (history.sync sent,
    // no history.updated yet). Drives the conversation loading animation.
    private val _historySyncing = MutableStateFlow<Set<String>>(emptySet())
    val historySyncing: StateFlow<Set<String>> = _historySyncing
    private fun markHistorySyncing(threadId: String, syncing: Boolean) {
        _historySyncing.value = if (syncing) _historySyncing.value + threadId else _historySyncing.value - threadId
        if (syncing) scope.launch {
            delay(HISTORY_SYNC_INDICATOR_TIMEOUT_MS)
            _historySyncing.value = _historySyncing.value - threadId
        }
    }
    @Volatile private var activeThreadId: String? = null
    /** The conversation currently watched by the repository, if any. */
    fun currentThreadId(): String? = activeThreadId
    /** Whether the app is on screen (a session open there needs no reminder). */
    @Volatile var appVisible: Boolean = false
    private fun onScreen(threadId: String) = appVisible && threadId == activeThreadId
    // A load can outlive the screen that started it (especially while Room
    // decrypts a large cached conversation).  Incrementing this generation on
    // every watchThread call prevents that stale coroutine from writing its
    // result into a newly opened conversation, including a quick close/reopen
    // of the same thread.
    @Volatile private var historyLoadGeneration = 0L
    private var historyRefreshJob: Job? = null
    // history.updated can arrive in bursts while a desktop rollout is being
    // replayed.  Cancelling the in-flight HTTP read for every event leaves the
    // UI permanently on the old Room snapshot.  Coalesce the burst instead:
    // keep one refresh alive and run one more pass when an event arrived while
    // that pass was fetching.
    private val historyRefreshPending = AtomicBoolean(false)
    private val historyRefreshLock = Any()
    private var historyRefreshGeneration = 0L
    private var capabilitiesRetryJob: Job? = null
    private var capabilitiesRetryCount = 0
    private val tokenMutex = Mutex()
    private val historyMutex = Mutex()
    private val draftMutex = Mutex()
    // One list refresh at a time: with a cursor, an older copy merged last
    // would stay until that conversation changes again.
    private val threadsMutex = Mutex()
    private val sessionSnapshotGuard = SessionSnapshotGuard()
    // The relay's change stamp of the conversation rows this phone has; later
    // refreshes fetch only rows stored after it. Null until a relay that
    // stamps rows answers (older relays and direct links send whole pages).
    @Volatile private var threadsCursor: Long? = null
    private val draftVersions = java.util.concurrent.ConcurrentHashMap<String, AtomicLong>()

    // A configured session is expected to reconnect during startup. Show that
    // transitional state instead of briefly claiming that the computer is offline.
    private val _connection = MutableStateFlow(if (configured()) ConnectionState.Connecting else ConnectionState.Offline)
    val connection: StateFlow<ConnectionState> = _connection
    private val _threads = MutableStateFlow<List<ThreadSummary>>(emptyList())
    val threads: StateFlow<List<ThreadSummary>> = _threads
    private val _liveStatuses = MutableStateFlow<Map<String, String>>(emptyMap())
    val liveStatuses: StateFlow<Map<String, String>> = _liveStatuses
    private val _agentOpenStates = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val agentOpenStates: StateFlow<Map<String, Boolean>> = _agentOpenStates
    private val agentSnapshots = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Map<String, Boolean>>>()
    private val _agentOpenStatesByConnector = MutableStateFlow<Map<String, Map<String, Boolean>>>(emptyMap())
    val agentOpenStatesByConnector: StateFlow<Map<String, Map<String, Boolean>>> = _agentOpenStatesByConnector
    // Which agents each computer has installed at all (connector 0.2.148+);
    // missing for an older connector, which then shows the old empty list.
    private val _agentInstalledByConnector = MutableStateFlow<Map<String, Map<String, Boolean>>>(emptyMap())
    val agentInstalledByConnector: StateFlow<Map<String, Map<String, Boolean>>> = _agentInstalledByConnector
    // One account may have several computers. Each connector's last heartbeat,
    // so the PC switcher can show which computer is online.
    private val _connectorSeenAt = MutableStateFlow<Map<String, Long>>(emptyMap())
    val connectorSeenAt: StateFlow<Map<String, Long>> = _connectorSeenAt
    private val _threadOwners = MutableStateFlow<Map<String, String>>(emptyMap())
    val threadOwners: StateFlow<Map<String, String>> = _threadOwners
    // Durable events can be replayed after a fresh realtime snapshot. Keep
    // per-thread ordering so an old completion cannot replace a newer active state.
    private val liveStatusUpdatedAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    // First fresh heartbeat that left out a still-busy task (see retireLongAbsentBusyStatuses).
    private val liveAbsentSince = java.util.concurrent.ConcurrentHashMap<String, Long>()
    // The phone owns the user-facing latency measurement. Keep the start in
    // memory while a turn is live and persist the completed value below so it
    // survives leaving the conversation or restarting the app.
    private val turnStartedAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val turnStartedTurnId = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val lastCompletedTurnId = java.util.concurrent.ConcurrentHashMap<String, String>()
    // A turn's end is announced after a pause: the computer's view of a long
    // turn can flip to "done" for a moment (a quiet stretch, a reconnect) and
    // back, which rang "已完成" again and again. Running again within the pause
    // means it was the same turn: no reminder, and it keeps its first start.
    private val pendingTurnEnds = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, kotlinx.coroutines.Job>>()
    // Threads whose last word was a completion read from silence (isSilentCompletion).
    // The turn may still be running: its timer is kept, and a different turn
    // starting after it is timed from its own start.
    private val silentlyEnded = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    // Settings notifications may be replayed after a reconnect. Keep their
    // source timestamp so an older model/effort snapshot cannot replace the
    // effective value currently shown in the conversation header.
    private val threadSettingsUpdatedAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val _queuedInstructions = MutableStateFlow<Map<String, List<QueuedInstruction>>>(emptyMap())
    val queuedInstructions: StateFlow<Map<String, List<QueuedInstruction>>> = _queuedInstructions
    private val _items = MutableStateFlow<List<HistoryItem>>(emptyList())
    val items: StateFlow<List<HistoryItem>> = _items
    private val _historyLoadState = MutableStateFlow(HistoryLoadState())
    val historyLoadState: StateFlow<HistoryLoadState> = _historyLoadState
    private val _approval = MutableStateFlow<ApprovalRequest?>(null)
    val approval: StateFlow<ApprovalRequest?> = _approval
    private val _statusText = MutableStateFlow(if (configured()) "正在连接电脑" else "电脑离线")
    val statusText: StateFlow<String> = _statusText
    private val _capabilities = MutableStateFlow(
        crypto.quotaSnapshot()?.current(System.currentTimeMillis())?.let { cached ->
            CapabilityState(
                weeklyRemainingPercent = cached.remainingPercent,
                weeklyResetAt = cached.resetAt,
                quotaState = "cached",
            )
        } ?: CapabilityState()
    )
    val capabilities: StateFlow<CapabilityState> = _capabilities
    private val _claudeUsage = MutableStateFlow<ClaudeUsage?>(null)
    val claudeUsage: StateFlow<ClaudeUsage?> = _claudeUsage
    private val _dshUsage = MutableStateFlow<DshUsage?>(null)
    val dshUsage: StateFlow<DshUsage?> = _dshUsage
    private val _dshCatalog = MutableStateFlow<DshCatalog?>(null)
    val dshCatalog: StateFlow<DshCatalog?> = _dshCatalog
    private val _hermesCatalog = MutableStateFlow<DshCatalog?>(null)
    val hermesCatalog: StateFlow<DshCatalog?> = _hermesCatalog
    private val _dshPending = MutableStateFlow<DshPending?>(null)
    val dshPending: StateFlow<DshPending?> = _dshPending
    private val _dshPendingLoading = MutableStateFlow(false)
    val dshPendingLoading: StateFlow<Boolean> = _dshPendingLoading
    // The computer's CPU / GPU / memory load, from each presence heartbeat.
    private val _uploadIssue = MutableStateFlow<UploadIssue?>(null)
    val uploadIssue: StateFlow<UploadIssue?> = _uploadIssue
    private val _pcLoad = MutableStateFlow<PcLoad?>(null)
    val pcLoad: StateFlow<PcLoad?> = _pcLoad
    private fun parseClaudeUsage(value: JSONObject?) {
        value ?: return
        fun window(key: String): ClaudeUsageWindow {
            val row = value.optJSONObject(key) ?: return ClaudeUsageWindow()
            return ClaudeUsageWindow(
                row.opt("remainingPercent").let { if (it is Number) it.toInt() else null },
                row.opt("resetsAt").let { if (it is Number && it.toLong() > 0) it.toLong() else null },
                row.optBoolean("resetEstimated"),
                row.opt("observedAt").let { if (it is Number && it.toLong() > 0) it.toLong() else null },
                row.optBoolean("stale") || row.optBoolean("staleWhileActive"),
                row.optBoolean("atMost"),
                row.opt("lastKnownRemainingPercent").let { if (it is Number && it.toInt() in 0..100) it.toInt() else null },
            )
        }
        val before = _claudeUsage.value
        val next = mergeClaudeUsage(before, ClaudeUsage(
            window("fiveHour"), window("sevenDay"), value.optLong("updatedAt", 0), value.optLong("refreshResultAt", 0),
            value.optString("refreshUnavailableReason").takeIf { it.isNotBlank() && it != "null" },
            value.optString("accountFingerprint").takeIf { it.isNotBlank() && it != "null" },
            value.optLong("snapshotAt", 0), value.optString("accountState").takeIf { it.isNotBlank() && it != "null" },
            value.optJSONObject("statusline")?.let { ClaudeStatuslineState(it.optBoolean("enabled"), it.optBoolean("chained"), it.optString("error").takeIf { e -> e.isNotBlank() && e != "null" }) },
        ))
        _claudeUsage.value = next
        _agentAccounts.value["claude"]?.let { state ->
            _agentAccounts.value = _agentAccounts.value + ("claude" to state.withClaudeUsage(next))
        }
        if (next.accountState == "ready" && next.accountFingerprint != null && before?.accountFingerprint != next.accountFingerprint) {
            refreshAfterAgentAccountChange("claude")
        }
    }
    private fun applyDshUsage(value: JSONObject?) {
        parseDshUsage(value)?.let { _dshUsage.value = it }
    }
    private fun applyDshCatalog(value: JSONObject?) {
        // Hermes answers in the same catalog shape; its models are its own list.
        val target = if (value?.optString("backend") == "hermes") _hermesCatalog else _dshCatalog
        parseDshCatalog(value?.optJSONObject("catalog"), value?.optJSONObject("permissionCatalog"))?.let { target.value = it }
    }

    fun loadDshPending(threadId: String) {
        _dshPending.value = null
        _dshPendingLoading.value = true
        runCatching {
            command("dsh.pending", threadId, JSONObject().put("threadId", threadId))
        }.onFailure {
            _dshPendingLoading.value = false
            _message.value = it.message ?: "读取 DSH 等待项失败"
        }
    }

    /** Answers a DSH card and waits for the computer: throws when it did not take it. */
    suspend fun answerDshAwait(threadId: String, option: String): JSONObject =
        commandResult(requestCommand("dsh.answer", threadId, JSONObject().put("threadId", threadId).put("option", option), 45_000))

    fun answerDsh(threadId: String, option: String) {
        runCatching {
            command("dsh.answer", threadId, JSONObject().put("threadId", threadId).put("option", option))
        }.onFailure { _message.value = it.message ?: "提交到 DSH 失败" }
    }
    private val _claudeModels = MutableStateFlow<List<ClaudeModel>>(emptyList())
    val claudeModels: StateFlow<List<ClaudeModel>> = _claudeModels
    private val _threadSettings = MutableStateFlow<Map<String, ThreadSettings>>(emptyMap())
    val threadSettings: StateFlow<Map<String, ThreadSettings>> = _threadSettings
    private val _turnDurations = MutableStateFlow<Map<String, TurnDuration>>(emptyMap())
    val turnDurations: StateFlow<Map<String, TurnDuration>> = _turnDurations
    private val _attachments = MutableStateFlow<Map<String, List<AttachmentUpload>>>(emptyMap())
    val attachments: StateFlow<Map<String, List<AttachmentUpload>>> = _attachments
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    private val _files = MutableStateFlow<List<FileEntry>>(emptyList())
    val files: StateFlow<List<FileEntry>> = _files
    private val _filePath = MutableStateFlow("")
    val filePath: StateFlow<String> = _filePath
    private val _devices = MutableStateFlow<List<DeviceEntry>>(emptyList())
    val devices: StateFlow<List<DeviceEntry>> = _devices
    private val _selectedConnectorId = MutableStateFlow(crypto.selectedConnectorId())
    val selectedConnectorId: StateFlow<String?> = _selectedConnectorId
    private fun savedAgentConnectorIds(): Map<String, String> = HOME_AGENT_IDS.mapNotNull { agent ->
        crypto.agentConnectorId(agent)?.takeIf(String::isNotBlank)?.let { agent to it }
    }.toMap()
    private val _agentConnectorIds = MutableStateFlow(savedAgentConnectorIds())
    val agentConnectorIds: StateFlow<Map<String, String>> = _agentConnectorIds
    private fun refreshAgentConnectorIds() { _agentConnectorIds.value = savedAgentConnectorIds() }
    private fun saveAgentConnectorId(agent: String, deviceId: String) {
        crypto.saveAgentConnectorId(agent, deviceId)
        _agentConnectorIds.update { it + (agent to deviceId) }
    }
    private val _sessionExpired = MutableStateFlow(false)
    // A direct link that keeps failing: suggest the account login (see DirectAccountSuggestion).
    private val _suggestAccountLogin = MutableStateFlow(false)
    val suggestAccountLogin: StateFlow<Boolean> = _suggestAccountLogin
    @Volatile private var accountSuggestionShown = false
    fun dismissAccountSuggestion() { _suggestAccountLogin.value = false }
    fun hasSavedAccountSession(): Boolean = crypto.hasCloudSessionBackup()
    val sessionExpired: StateFlow<Boolean> = _sessionExpired
    private val _updateAvailable = MutableStateFlow<UpdateInfo?>(null)
    val updateAvailable: StateFlow<UpdateInfo?> = _updateAvailable
    private val postponedUpdates = mutableSetOf<Int>()
    private val _updateDownload = MutableStateFlow<UpdateDownloadState>(UpdateDownloadState.Idle)
    val updateDownload: StateFlow<UpdateDownloadState> = _updateDownload
    private val updateDownloadLock = Any()
    private var updateDownloadGeneration = 0L
    private var updateDownloadCall: okhttp3.Call? = null
    private val _pairingLogin = MutableStateFlow<PairingLoginState>(PairingLoginState.Idle)
    val pairingLogin: StateFlow<PairingLoginState> = _pairingLogin
    private val _account = MutableStateFlow<AccountUiState?>(null)
    val account: StateFlow<AccountUiState?> = _account
    private val _createdThreadId = MutableStateFlow<String?>(null)
    val createdThreadId: StateFlow<String?> = _createdThreadId
    private val _claudeWorkspaceTrust = MutableStateFlow<ClaudeWorkspaceTrustRequest?>(null)
    val claudeWorkspaceTrust: StateFlow<ClaudeWorkspaceTrustRequest?> = _claudeWorkspaceTrust
    @Volatile private var downloadedUpdate: File? = null

    private fun serverUrl(value: String = crypto.server()): String = normalizeBridgeServer(value)

    var notificationSink: ((String, String, Boolean) -> Unit)? = null
    // A question Codex just asked without stopping, offered on the phone right away.
    private val _codexQuestion = MutableStateFlow<CodexQuestionPrompt?>(null)
    val codexQuestion: StateFlow<CodexQuestionPrompt?> = _codexQuestion
    private val _codexQuestionStates = MutableStateFlow<Map<String, CodexQuestionState>>(emptyMap())
    val codexQuestionStates: StateFlow<Map<String, CodexQuestionState>> = _codexQuestionStates
    private val codexQuestionLock = Any()
    private val questionLiveSince = System.currentTimeMillis()
    fun dismissCodexQuestion() { _codexQuestion.value = null }
    fun openCodexQuestion(threadId: String) { _codexQuestionStates.value[threadId]?.takeIf { it.pending }?.let { _codexQuestion.value = it.prompt() } }

    private fun applyCodexQuestionState(next: CodexQuestionState, notify: Boolean = true) = synchronized(codexQuestionLock) {
        val old = _codexQuestionStates.value[next.threadId]
        val state = mergeCodexQuestionState(old, next)
        if (state !== next) return@synchronized
        _codexQuestionStates.value = (_codexQuestionStates.value + (state.threadId to state)).entries.toList().takeLast(256).associate { it.toPair() }
        if (!state.pending) {
            if (_codexQuestion.value?.threadId == state.threadId) _codexQuestion.value = null
            codexQuestionNotificationSink?.invoke(state.threadId, null, null, false)
            return@synchronized
        }
        if (_codexQuestion.value?.threadId == state.threadId) _codexQuestion.value = state.prompt()
        val namespace = usageCacheKey(state.threadId)
        val unseen = unannouncedCodexQuestions(state, namespace) { historyCachePrefs.getBoolean(it, false) }
        val title = _threads.value.firstOrNull { it.id == state.threadId }?.title.orEmpty()
        val noticeTitle = "Codex 等待你回答${if (title.isBlank()) "" else " · $title"}"
        if (unseen.isEmpty()) {
            if (old?.pending == true && old.questions != state.questions)
                codexQuestionNotificationSink?.invoke(state.threadId, noticeTitle, state.questions.first().question, false)
            return@synchronized
        }
        val edit = historyCachePrefs.edit()
        unseen.forEach { edit.putBoolean(codexQuestionNoticeKey(namespace, it.id), true) }
        historyCachePrefs.all.keys.filter { it.startsWith("codexQuestionNotice:") }.dropLast(511).forEach(edit::remove)
        edit.apply()
        if (!shouldAlertCodexQuestion(state.askedAt, questionLiveSince, notify)) return@synchronized
        if (onScreen(state.threadId)) _codexQuestion.value = state.prompt()
        codexQuestionNotificationSink?.invoke(state.threadId, noticeTitle, unseen.first().question, true)
            ?: threadNotificationSink?.invoke(state.threadId, noticeTitle, unseen.first().question, true, ThreadNoticeKind.PROMPT)
            ?: notificationSink?.invoke("Codex 等待你回答", unseen.first().question, true)
    }
    /** (threadId, title, text, urgent, kind): a reminder about one session. */
    internal var threadNotificationSink: ((String, String, String, Boolean, ThreadNoticeKind) -> Unit)? = null
    /** Null title dismisses only this question reminder, preserving task completion notices. */
    var codexQuestionNotificationSink: ((String, String?, String?, Boolean) -> Unit)? = null
    // Desktop prompts already announced (by request id), so each rings once.
    private val announcedPrompts = java.util.Collections.synchronizedSet(LinkedHashSet<String>())
    private var promptsSeeded = false

    // The phone's own network: with none, the problem is here, not on the
    // computer, and there is nothing to retry until one comes back.
    private val connectivity = context.getSystemService(android.net.ConnectivityManager::class.java)
    private fun phoneHasNetwork(): Boolean = runCatching {
        connectivity?.getNetworkCapabilities(connectivity.activeNetwork)
            ?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }.getOrDefault(true)
    private val _phoneNetworkAvailable = MutableStateFlow(phoneHasNetwork())
    val phoneNetworkAvailable: StateFlow<Boolean> = _phoneNetworkAvailable
    private fun offlineText() = if (phoneHasNetwork()) "电脑离线" else "手机没有网络"
    private fun reconnectingText() = if (phoneHasNetwork()) "正在重连电脑" else "手机没有网络，联网后自动重连"

    init {
        // A network coming back (Wi-Fi rejoined, airplane mode off) reconnects
        // at once instead of at the next back-off step.
        // Registered once construction is over: the first onAvailable arrives at once.
        scope.launch { delay(1_000); runCatching {
            connectivity?.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) {
                    _phoneNetworkAvailable.value = phoneHasNetwork()
                    scope.launch {
                        if (directMode()) { if (directPeer == null && !directPairing) { directResumeJob?.cancel(); directResumeJob = null; connect() } }
                        else if (!relayConnected && configured()) scheduleReconnect(0L)
                    }
                }
                override fun onLost(network: android.net.Network) {
                    _phoneNetworkAvailable.value = phoneHasNetwork()
                    scope.launch {
                        delay(100)
                        _phoneNetworkAvailable.value = phoneHasNetwork()
                        if (!relayConnected) _statusText.value = if (_connection.value == ConnectionState.Offline) offlineText() else reconnectingText()
                    }
                }
                override fun onCapabilitiesChanged(network: android.net.Network, caps: android.net.NetworkCapabilities) {
                    _phoneNetworkAvailable.value = phoneHasNetwork()
                }
            })
        }.onFailure { Log.w(LOG_TAG, "network callback unavailable", it) } }
        // Hydrate the last known thread index immediately. The network refresh
        // still wins shortly afterwards, but a cold process can show the home
        // screen and reopen the last conversation from encrypted local state
        // instead of making the user wait for the first HTTPS round trip.
        scope.launch { restoreCachedThreads() }
    }

    private fun isDurableInstructionAction(action: String): Boolean =
        action in setOf("turn.start", "turn.steer", "followup.enqueue")

    private fun persistPendingAction(id: String, pending: PendingAction) {
        if (!isDurableInstructionAction(pending.action) || !configured()) return
        runCatching {
            val encrypted = crypto.encrypt("outbound.command", pending.threadId, id, JSONObject(pending.args.toString()))
            runBlocking(Dispatchers.IO) {
                database.cache().putPendingCommand(
                    PendingCommandEntry(id, pending.action, pending.threadId, encrypted.first, encrypted.second, pending.createdAt),
                )
            }
        }.onFailure { Log.w(LOG_TAG, "pending command persistence failed", it) }
    }

    private fun deletePendingAction(id: String) {
        scope.launch { runCatching { database.cache().deletePendingCommand(id) } }
    }

    private suspend fun restorePendingCommands() {
        if (!configured()) return
        val sessionTicket = sessionSnapshotGuard.capture()
        runCatching {
            database.cache().pendingCommands().forEach { row ->
                if (!sessionSnapshotGuard.isCurrent(sessionTicket)) return@forEach
                // Rows from a different account remain encrypted in the local
                // cache. Skip them individually, so they cannot be retried or
                // prevent this account's later rows from being restored.
                val args = runCatching { crypto.decrypt("outbound.command", row.threadId, row.id, row.nonce, row.ciphertext) }.getOrNull() ?: return@forEach
                val pending = PendingAction(row.action, row.threadId, args, row.createdAt)
                val threadId = row.threadId ?: args.optString("threadId").takeIf { it.isNotBlank() }
                sessionSnapshotGuard.publish(sessionTicket) {
                    if (threadId != null) {
                        val text = args.optString("text").trim()
                        val attachments = queuedAttachments(args.optJSONArray("attachments"))
                        upsertOptimisticFollowup(
                            threadId,
                            QueuedInstruction(row.id, text.ifBlank { "图片附件" }, row.createdAt, if (row.action == "followup.enqueue") "pending" else "sending", attachments = attachments, blocking = row.action == "followup.enqueue", historyAfterOrder = if (args.has("historyAfterOrder")) args.optLong("historyAfterOrder") else null, queueRequested = row.action == "followup.enqueue"),
                        )
                    }
                    pendingActions.putIfAbsent(row.id, pending)
                    pendingInstructionRetries += row.id
                }
            }
        }.onFailure { Log.w(LOG_TAG, "pending command restore failed", it) }
    }

    fun configured(): Boolean = sessionConfigured(crypto.protocolVersion(), crypto.accountKey() != null, crypto.directMode(), crypto.refresh() != null, crypto.accountId())
    fun directMode(): Boolean = crypto.directMode()
    @Volatile private var directPeer: DirectTransport? = null
    @Volatile private var directPairing = false
    private var directWelcome: kotlinx.coroutines.CompletableDeferred<Unit>? = null
    private var directHeartbeat: kotlinx.coroutines.Job? = null
    private val directReads = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.CompletableDeferred<JSONObject>>()
    fun usingV2(): Boolean = crypto.protocolVersion() == 2
    fun lastViewedThreadId(): String? = crypto.lastViewedThreadId()
    fun saveLastViewedThreadId(threadId: String) = crypto.saveLastViewedThreadId(threadId)
    fun homeBackend(): String = crypto.homeBackend()
    fun saveHomeBackend(value: String) = crypto.saveHomeBackend(value)
    fun visibleAgents(): Set<String> = crypto.visibleAgents()
    fun visibleAgentOrder(): List<String> = crypto.visibleAgentOrder()
    fun saveVisibleAgents(values: Set<String>) = crypto.saveVisibleAgents(values)
    fun saveAgentOrder(order: List<String>) = crypto.saveAgentOrder(order)
    fun clearLastViewedThreadId() = crypto.clearLastViewedThreadId()
    fun selectedConnector(): String? = _selectedConnectorId.value
    /** A frame sent by a computer other than the one this phone is looking at. */
    private fun fromOtherConnector(frame: JSONObject): Boolean {
        val source = frame.optString("sourceDeviceId").takeIf { it.isNotBlank() && it != "null" } ?: return false
        val selected = _selectedConnectorId.value?.takeIf { it.isNotBlank() } ?: return false
        return source != selected && _devices.value.any { it.id == source && it.type.equals("connector", true) }
    }
    fun selectConnector(deviceId: String) {
        if (deviceId.isBlank()) return
        crypto.saveSelectedConnectorId(deviceId)
        _selectedConnectorId.value = deviceId
        _conversationUsage.value = emptyMap()
        // The warning was about the previous computer; the new one's presence says its own.
        _uploadIssue.value = null
        _agentAccounts.value = emptyMap(); _accountReadErrors.value = emptyMap(); _accountsAvailable.value = false
        // Questions belong to their threads, including threads on other
        // computers. Keep them for the other agent tabs' waiting indicators;
        // only close the currently displayed question when changing computer.
        _codexQuestion.value = null
        _agentOpenStates.value = agentSnapshots[deviceId]?.second.orEmpty()
        // Per-computer readings belong to the computer they came from.
        _pcLoad.value = null
        _dshUsage.value = null; _dshCatalog.value = null; _hermesCatalog.value = null
        runCatching { command("capabilities") }
        runCatching { command("backends.capabilities") }
        runCatching { command("followup.list") }
    }
    private val _phoneArchivedIds = MutableStateFlow(crypto.phoneArchivedIds())
    /** Archived on this phone only: Antigravity has no archive on the computer. */
    val phoneArchivedIds: StateFlow<Set<String>> = _phoneArchivedIds
    private val _archivingIds = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    /** Sessions being archived (true) or brought back (false): shown that way right away. */
    val archivingIds: StateFlow<Map<String, Boolean>> = _archivingIds

    /**
     * Archive or bring back sessions, one at a time: on Claude each one drives
     * the desktop's sidebar, so two at once would collide. Agents without an
     * archive on the computer (Antigravity) are archived on this phone only.
     * Returns the titles that did not go through.
     */
    suspend fun archiveThreads(items: List<ThreadSummary>, archived: Boolean): List<String> {
        if (usingV2() && _account.value?.canWrite != true) error(readOnlyReason())
        _archivingIds.value = _archivingIds.value + items.associate { it.id to archived }
        val failed = mutableListOf<String>()
        for (thread in items) {
            if (backendTab(thread.backend) == "antigravity") {
                val next = if (archived) _phoneArchivedIds.value + thread.id else _phoneArchivedIds.value - thread.id
                crypto.savePhoneArchivedIds(next); _phoneArchivedIds.value = next
                continue
            }
            runCatching {
                val response = requestCommand("thread.archive", thread.id,
                    JSONObject().put("threadId", thread.id).put("archived", archived).put("title", thread.title), 120_000)
                check(response.optBoolean("ok")) { response.optString("error", "操作失败") }
                // The computer has applied it and synced the list: follow the list again.
                delay(1_500); _archivingIds.value = _archivingIds.value - thread.id
            }.onFailure {
                Log.w(LOG_TAG, "archive failed thread=${thread.id}: ${it.message}")
                failed += thread.title.ifBlank { "未命名任务" }
                _archivingIds.value = _archivingIds.value - thread.id
            }
        }
        return failed
    }

    /**
     * A computer picked on one agent tab: remembered for that tab only. The
     * other tabs that never picked one keep the computer shown until now.
     */
    fun selectConnectorForAgent(agent: String, deviceId: String, otherAgents: Collection<String> = emptyList()) {
        if (deviceId.isBlank()) return
        _selectedConnectorId.value?.takeIf(String::isNotBlank)?.let { current ->
            otherAgents.filter { it != agent && crypto.agentConnectorId(it) == null }.forEach { saveAgentConnectorId(it, current) }
        }
        saveAgentConnectorId(agent, deviceId)
        if (deviceId != _selectedConnectorId.value) selectConnector(deviceId)
    }

    /**
     * Opening an agent tab: look at the computer that tab last used. A tab
     * without one keeps the current computer and remembers it from now on,
     * so nothing moves when this arrives as an update.
     */
    fun showAgentConnector(agent: String, available: Set<String>) {
        val current = _selectedConnectorId.value ?: return
        val remembered = crypto.agentConnectorId(agent)?.takeIf { it in available }
        if (remembered == null) { saveAgentConnectorId(agent, current); return }
        if (remembered != current) selectConnector(remembered)
    }
    fun clearCreatedThreadId() { _createdThreadId.value = null }

    private suspend fun restoreCachedThreads() {
        val sessionTicket = sessionSnapshotGuard.capture()
        runCatching {
            val readSnapshot = crypto.threadReadSnapshot()
            val decoded = database.cache().threads().mapNotNull { cached ->
                decodeThread(
                    JSONObject()
                        .put("id", cached.id)
                        .put("updatedAt", cached.updatedAt)
                        .put("nonce", cached.nonce)
                        .put("ciphertext", cached.ciphertext),
                    readSnapshot,
                )
            }
            sessionSnapshotGuard.publish(sessionTicket) {
                if (decoded.isNotEmpty() && _threads.value.isEmpty()) {
                    _threads.value = sortThreadSummaries(withDesktopPinSnapshots(decoded))
                    decoded.mapNotNull { it.codexQuestions }.forEach { applyCodexQuestionState(it, notify = false) }
                }
            }
        }.onFailure { error ->
            Log.d(LOG_TAG, "cached thread index unavailable during startup", error)
        }
    }

    suspend fun createTask(cwd: String, prompt: String, mode: String, collaborationMode: String = "default", backend: String = "codex", model: String = "", effort: String = ""): String = withContext(Dispatchers.IO) {
        val args = JSONObject().put("cwd", cwd).put("text", prompt).put("mode", mode)
            .put("collaborationMode", if (collaborationMode.equals("plan", true)) "plan" else "default")
        if (backend.isNotBlank() && backend != "codex") args.put("backend", backend)
        if (backend == "claude") {
            if (model.isNotBlank()) args.put("model", model)
            if (effort.isNotBlank()) args.put("effort", effort)
        }
        val payload = requestCommand("thread.newWithTurn", null, args, 120_000)
        // A refusal carries the computer's own reason (e.g. a draft left in the new-task box); show that.
        val result = commandResult(payload).takeIf { payload.has("result") } ?: error("电脑没有返回新任务信息")
        val confirmation = result.optJSONObject("requiresConfirmation")
        if (confirmation?.optString("kind") == "workspaceTrust") {
            val threadId = result.optString("threadId").takeIf { it.isNotBlank() }
                ?: error("电脑没有返回待确认任务 ID")
            val folder = confirmation.optString("folder").trim()
            check(folder.isNotBlank()) { "电脑没有返回待确认目录" }
            _claudeWorkspaceTrust.value = ClaudeWorkspaceTrustRequest(threadId, folder)
            return@withContext ""
        }
        val threadId = result.optString("threadId").takeIf { it.isNotBlank() }
            ?: error("电脑没有返回新任务 ID")
        // This suspending request completes once; replayed frames have no
        // waiter. A trust prompt or queue-only receipt must not claim a start.
        if (prompt.isNotBlank() && confirmsNewTaskStart(result)) KhVibration.started(context, appVisible)
        // The conversation opens with the first message already in it; the real
        // history row replaces this one as soon as it is read.
        if (prompt.isNotBlank()) {
            val started = confirmsNewTaskStart(result)
            // A new conversation has no earlier message: its first stored user
            // row is this one, even when the agent wrote it before this reply
            // arrived (Hermes does), so match by order, not by time.
            upsertOptimisticFollowup(threadId, QueuedInstruction("newtask:$threadId", prompt.trim(), System.currentTimeMillis(),
                if (started) "started" else "desktop_queued", blocking = !started, startedAt = if (started) System.currentTimeMillis() else null,
                historyAfterOrder = -1L))
        }
        refreshThreads()
        _createdThreadId.value = threadId
        threadId
    }

    suspend fun confirmClaudeWorkspaceTrust(): String = withContext(Dispatchers.IO) {
        val request = _claudeWorkspaceTrust.value ?: error("没有待确认的 Claude 工作目录")
        val payload = requestCommand(
            "claude.desktop.trust",
            request.threadId,
            JSONObject().put("threadId", request.threadId),
            120_000,
        )
        val result = payload.optJSONObject("result") ?: error("电脑没有返回确认结果")
        val threadId = result.optString("threadId").takeIf { it.isNotBlank() }
            ?: error("电脑没有返回新任务 ID")
        _claudeWorkspaceTrust.value = null
        refreshThreads()
        _createdThreadId.value = threadId
        threadId
    }

    suspend fun cancelClaudeWorkspaceTrust() = withContext(Dispatchers.IO) {
        val request = _claudeWorkspaceTrust.value ?: return@withContext
        runCatching {
            requestCommand(
                "claude.desktop.trust.cancel",
                request.threadId,
                JSONObject().put("threadId", request.threadId),
                30_000,
            )
        }.onFailure { Log.w(LOG_TAG, "Claude workspace trust cancellation could not reach connector", it) }
        _claudeWorkspaceTrust.value = null
        _message.value = "已取消 Claude 工作区信任，新任务没有发送"
    }

    /** Demo build only: show the made-up sessions as an online computer, offline. */
    private fun startDemo() {
        if (!crypto.legalAccepted(LEGAL_VERSION)) crypto.saveLegalConsent(LEGAL_VERSION, false, false)
        finishOnboarding()
        val now = System.currentTimeMillis()
        relayConnected = true; reconnect = false
        connectorHeartbeatAt = now; connectorConnectedAt = now
        _selectedConnectorId.value = DemoData.PC
        _connectorSeenAt.value = mapOf(DemoData.PC to now)
        _agentOpenStates.value = mapOf("codex" to true, "claude" to true)
        _agentOpenStatesByConnector.value = mapOf(DemoData.PC to _agentOpenStates.value)
        _threads.value = DemoData.threads(now)
        _capabilities.value = CapabilityState(weeklyRemainingPercent = 68, weeklyResetAt = now + 3 * 86_400_000L, quotaState = "live", quotaSnapshotAt = now)
        _connection.value = ConnectionState.Online
        _statusText.value = "电脑在线 · 实时同步"
    }

    suspend fun recoverSessionOnStartup(): Boolean = withContext(Dispatchers.IO) {
        if (BuildConfig.DEMO) { startDemo(); return@withContext true }
        if (directMode()) {
            // A paired computer is found again on the LAN: open the cached
            // home screen and reconnect in the background, no new scan.
            if (crypto.directPcId() != null && crypto.directResume() != null && crypto.accountKey() != null) {
                connect()
                return@withContext true
            }
            _pairingLogin.value = PairingLoginState.Failed("上次直连已结束，请重新扫描电脑连接码")
            return@withContext false
        }
        repeat(4) { attempt ->
            if (configured()) {
                connect()
                return@withContext true
            }
            if (attempt < 3) delay(250)
        }
        false
    }

    fun legalAccepted(): Boolean = crypto.legalAccepted(LEGAL_VERSION)

    fun acceptLegal(diagnostics: Boolean, analytics: Boolean) {
        // A first consent on a fresh install queues the first-run guide.
        if (onboardingState() == null) displayPrefs.edit().putString(ONBOARDING_KEY, OnboardingState.Pending.stored).apply()
        crypto.saveLegalConsent(LEGAL_VERSION, diagnostics, analytics)
    }

    fun onboardingState(): OnboardingState? = OnboardingState.resolve(displayPrefs.getString(ONBOARDING_KEY, null),
        crypto.legalConsentedBefore() || context.getSharedPreferences("ui-preferences", Context.MODE_PRIVATE).contains("theme"))

    fun finishOnboarding() { displayPrefs.edit().putString(ONBOARDING_KEY, OnboardingState.Done.stored).apply() }

    fun restartOnboarding() { displayPrefs.edit().putString(ONBOARDING_KEY, OnboardingState.Pending.stored).apply() }

    suspend fun login(server: String, password: CharArray) = withContext(Dispatchers.IO) {
        val base = serverUrl(server)
        val challenge = post("$base/api/v1/auth/challenge", JSONObject(), null)
        val key = crypto.derive(password, CryptoStore.unb64(challenge.getString("salt")), challenge.getInt("iterations"))
        password.fill('\u0000')
        val body = JSONObject().put("challengeId", challenge.getString("challengeId"))
            .put("proof", crypto.proof(key, challenge.getString("challengeId"), challenge.getString("nonce")))
            .put("deviceId", crypto.deviceId()).put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("deviceType", "android")
        val result = post("$base/api/v1/auth/login", body, null)
        val accountKey = crypto.unwrapAccountKey(key, result.getJSONObject("keyEnvelope"))
        disconnect(); resetSessionView()
        try { crypto.saveAccountKey(accountKey) } finally { accountKey.fill(0) }
        crypto.saveSession(base, result.getString("deviceId"), result.getString("accessToken"),
            result.getString("refreshToken"), result.getLong("expiresAt"))
        crypto.saveSequence(0L)
        refreshAgentConnectorIds()
        _sessionExpired.value = false
        connect()
    }

    suspend fun pairFromQr(payload: String) = withContext(Dispatchers.IO) {
        if (DirectQr.isDirect(payload.trim())) {
            pairDirect(payload.trim())
            return@withContext
        }
        val uri = Uri.parse(payload.trim())
        check(uri.scheme == "khlink" && uri.host == "pair" && uri.getQueryParameter("v") == "2") { "这不是有效的 khLink 配对二维码" }
        val server = uri.getQueryParameter("server")?.let(::normalizeBridgeServer) ?: error("二维码缺少服务器地址")
        check(isTrustedBridgeServer(server)) { "二维码里的服务器不受信任" }
        val id = uri.getQueryParameter("id") ?: error("二维码缺少配对编号")
        val secret = uri.getQueryParameter("secret") ?: error("二维码缺少配对密钥")
        // The desktop includes the server-issued deadline in v2 links. Use it
        // to keep polling aligned with the actual one-time credential instead
        // of ending at a client-side hard-coded 90 seconds.
        val pairingDeadline = uri.getQueryParameter("expiresAt")?.toLongOrNull()
            ?.takeIf { it > System.currentTimeMillis() }
            ?: (System.currentTimeMillis() + PAIRING_FALLBACK_TIMEOUT_MS)
        val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        _pairingLogin.value = PairingLoginState.Claiming(deviceName)
        post("$server/api/v2/pairing/claim", JSONObject()
            .put("id", id).put("secret", secret).put("deviceId", crypto.deviceId())
            .put("deviceName", deviceName).put("publicKey", crypto.devicePublicKey()), null)
        _pairingLogin.value = PairingLoginState.WaitingForDesktop(deviceName)
        while (System.currentTimeMillis() < pairingDeadline) {
            delay(900)
            val result = try {
                post("$server/api/v2/pairing/$id/poll", JSONObject().put("secret", secret), null)
            } catch (error: Exception) {
                if (!shouldRetryPairingPoll((error as? HttpStatusException)?.statusCode)) throw error
                Log.w(LOG_TAG, "pairing poll temporarily unavailable; retrying", error)
                continue
            }
            if (result.optString("status") != "confirmed") continue
            val session = result.getJSONObject("session")
            val accountKey = crypto.unwrapPairingEnvelope(id, result.getString("keyEnvelope"))
            disconnect(); resetSessionView()
            try { crypto.saveAccountKey(accountKey) } finally { accountKey.fill(0) }
            crypto.saveV2Session(server, session.getString("accountId"), session.getString("deviceId"),
                session.getString("accessToken"), session.getString("refreshToken"), session.getLong("expiresAt"))
            refreshAgentConnectorIds()
            _sessionExpired.value = false
            val profile = result.optJSONObject("profile")
            _pairingLogin.value = PairingLoginState.Complete(profile?.optString("displayName").orEmpty().ifBlank { "khLink 用户" })
            connect()
            refreshAccount()
            return@withContext
        }
        error("配对二维码已过期，请在电脑端重新生成")
    }

    // ---- khsci.com account login (no QR) ----
    // The phone logs in with its khQuant account via OAuth 2.1 + PKCE. The relay
    // registers this phone's public key; the always-online connector then wraps
    // the account key to it (device-key v3), which we fetch and unwrap below.
    private data class KhsciLogin(val server: String, val state: String, val codeVerifier: String, val redirectUri: String)
    @Volatile private var pendingKhsciLogin: KhsciLogin? = null
    private val khsciRedirectUri = "khlink://oauth/callback"

    // Step 1: ask the relay for a PKCE authorization URL to open in the browser.
    suspend fun beginKhsciLogin(server: String = crypto.server()): String = withContext(Dispatchers.IO) {
        val base = serverUrl(server)
        check(isTrustedBridgeServer(base)) { "这个服务器不受信任" }
        val verifier = pkceVerifier()
        val challenge = CryptoStore.b64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        _pairingLogin.value = PairingLoginState.Claiming(deviceName)
        val result = post("$base/api/v2/session/oauth/authorization",
            JSONObject().put("codeChallenge", challenge).put("redirectUri", khsciRedirectUri), null)
        pendingKhsciLogin = KhsciLogin(base, result.getString("state"), verifier, khsciRedirectUri)
        result.getString("authorizationUrl")
    }

    // Step 2: the khlink://oauth/callback deep link returns here with code+state.
    suspend fun completeKhsciLogin(code: String, state: String) = withContext(Dispatchers.IO) {
        val login = pendingKhsciLogin ?: error("没有正在进行的登录，请重新开始")
        check(state == login.state) { "登录状态校验失败，请重试" }
        val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        _pairingLogin.value = PairingLoginState.WaitingForDesktop(deviceName)
        val body = JSONObject().put("state", state).put("code", code).put("codeVerifier", login.codeVerifier)
            .put("deviceId", crypto.deviceId()).put("deviceName", deviceName)
            .put("publicKey", crypto.devicePublicKey()).put("deviceType", "android")
        val result = post("${login.server}/api/v2/session/oauth/complete", body, null)
        val session = result.getJSONObject("session")
        val accountId = session.getString("accountId")
        val deviceId = session.getString("deviceId")
        // Wait for the connector to seal the account key to this phone.
        // Use the pending login's token without replacing the saved session:
        // an unsuccessful key handoff must not leave tokens with an old key.
        val deadline = System.currentTimeMillis() + KEY_WAIT_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val envelope = try {
                val request = Request.Builder().url("${login.server}/api/v2/session/key-envelope")
                    .header("Authorization", "Bearer ${session.getString("accessToken")}").build()
                client.newCall(request).execute().use(::parse)
            } catch (error: Exception) {
                if (!shouldRetryPairingPoll((error as? HttpStatusException)?.statusCode)) throw error
                delay(1500); continue
            }
            if (envelope.optBoolean("pending") || !envelope.has("keyEnvelope")) { delay(1500); continue }
            val accountKey = crypto.unwrapDeviceKeyEnvelope(accountId, deviceId, envelope.getString("keyEnvelope"))
            disconnect(); resetSessionView()
            try { crypto.saveAccountKey(accountKey) } finally { accountKey.fill(0) }
            crypto.saveV2Session(login.server, accountId, deviceId, session.getString("accessToken"),
                session.getString("refreshToken"), session.getLong("expiresAt"))
            refreshAgentConnectorIds()
            pendingKhsciLogin = null
            _sessionExpired.value = false
            val profile = result.optJSONObject("profile")
            _pairingLogin.value = PairingLoginState.Complete(profile?.optString("displayName").orEmpty().ifBlank { "khLink 用户" })
            connect()
            refreshAccount()
            return@withContext
        }
        error("电脑端连接器未在线，未能完成登录。请确认电脑上的 khLink 连接器正在运行后重试")
    }

    private fun pkceVerifier(): String {
        val bytes = ByteArray(48).also(java.security.SecureRandom()::nextBytes)
        return CryptoStore.b64Url(bytes)
    }

    fun pairingFailed(message: String) { _pairingLogin.value = PairingLoginState.Failed(message) }
    fun resetPairing() {
        pendingKhsciLogin = null
        if (directPairing) {
            directPairing = false; directWelcome?.cancel(); directWelcome = null
            val previous = directPeer; directPeer = null; previous?.close()
        }
        _pairingLogin.value = PairingLoginState.Idle
    }

    private suspend fun pairDirect(payload: String) {
        val offer = DirectQr.decode(payload)
        disconnect()
        val key = CryptoStore.unb64(offer.getString("key"))
        val tunnel = offer.optString("tunnel").takeIf { validDirectTunnel(it) }
        // Not on the computer's network (mobile data, another Wi-Fi): WebRTC
        // cannot get through, so go straight to the cross-network tunnel.
        if (tunnel != null && !onComputerNetwork(offer)) { joinDirect(offer, key, resumed = false, via = DirectVia.Tunnel); return }
        try {
            joinDirect(offer, key, resumed = false)
        } catch (error: Exception) {
            if (tunnel == null || error is kotlinx.coroutines.CancellationException) throw error
            Log.i(LOG_TAG, "direct WebRTC failed, trying the tunnel: ${error.message}")
            joinDirect(offer, key, resumed = false, via = DirectVia.Tunnel)
        }
    }

    private enum class DirectVia { WebRtc, Tunnel, TunnelResume }

    /** Whether this phone shares a LAN with one of the computer's addresses in the QR. */
    private fun onComputerNetwork(offer: JSONObject): Boolean {
        val hosts = runCatching { DirectSignaling.endpoints(offer).map { it.host } }.getOrDefault(emptyList())
        return phoneLinks().any { (address, prefix) -> hosts.any { sameIpv4Network(it, address, prefix) } }
    }

    /** IPv4 addresses on Wi-Fi or Ethernet, never mobile data, with their prefix length. */
    private fun phoneLinks(): List<Pair<String, Int>> = runCatching {
        val cm = connectivity ?: return emptyList()
        cm.allNetworks.filter { network ->
            val caps = cm.getNetworkCapabilities(network) ?: return@filter false
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)
        }.mapNotNull { cm.getLinkProperties(it) }.flatMap { it.linkAddresses }
            .filter { it.address is java.net.Inet4Address && !it.address.isLoopbackAddress }
            .map { (it.address.hostAddress ?: "") to it.prefixLength }
    }.getOrDefault(emptyList())

    /**
     * One handshake with a computer: WebRTC from a scanned QR or a LAN
     * reconnect, or the cross-network tunnel. Reconnects reuse the pairing
     * key and keep the cached view.
     */
    private suspend fun joinDirect(offer: JSONObject, key: ByteArray, resumed: Boolean, via: DirectVia = DirectVia.WebRtc) {
        if (resumed) offer.put("key", CryptoStore.b64(key))
        directPairing = true
        val pcId = offer.getString("pcId"); val pcName = offer.optString("pcName", "电脑")
        val welcome = kotlinx.coroutines.CompletableDeferred<Unit>(); directWelcome = welcome
        val phoneId = crypto.deviceId(); val phoneName = "${Build.MANUFACTURER} ${Build.MODEL}".take(120)
        if (!resumed) _pairingLogin.value = PairingLoginState.DirectConnecting(pcName)
        var established = false
        val onReceive = fun(raw: String) {
            if (welcome.isCancelled || directWelcome !== welcome) return
            runCatching {
                val frame = JSONObject(raw)
                val kind = frame.optString("kind")
                if (!established) {
                    check(kind == "direct.welcome") { "直连握手顺序错误" }
                    val value = crypto.decryptWithKey(key, kind, null, frame.getString("id"), frame.getString("nonce"), frame.getString("ciphertext"))
                    check(value.getString("pcId") == pcId) { "电脑身份与连接码不匹配" }
                    if (!resumed) {
                        resetSessionView()
                        crypto.saveDirectSession(pcId, pcName, key)
                        refreshAgentConnectorIds()
                        lastSequence = 0L
                        _threads.value = emptyList(); _account.value = null; _items.value = emptyList(); threadsCursor = null; itemsCursors.clear()
                    }
                    _selectedConnectorId.value = pcId
                    // Remember where this computer listens (LAN port, cross-network
                    // tunnel), so a restart or an app kill needs no new scan.
                    val port = value.optJSONObject("resume")?.optInt("port")?.takeIf { it in 1024..65535 }
                    val hosts = if (offer.has("signaling")) runCatching { DirectSignaling.endpoints(offer).map { it.host } }.getOrDefault(emptyList()) else emptyList()
                    crypto.saveDirectResume(hosts, port, value.optString("tunnel").takeIf { validDirectTunnel(it) })
                    directResumeAttempt = 0
                    accountSuggestionShown = false; _suggestAccountLogin.value = false
                    relayConnected = true; reconnect = false; established = true
                    directPairing = false; _message.value = null
                    connectorHeartbeatAt = System.currentTimeMillis(); connectorConnectedAt = connectorHeartbeatAt
                    _sessionExpired.value = false
                    if (!resumed) _pairingLogin.value = PairingLoginState.Complete(pcName)
                    _connection.value = ConnectionState.Online
                    _statusText.value = if (via == DirectVia.WebRtc) "已直连电脑" else "已跨网络直连电脑"
                    startConnectorWatchdog()
                    directHeartbeat?.cancel()
                    directHeartbeat = scope.launch {
                        // An Agent can briefly go offline while the peer transport stays open.
                        while (directPeer != null && directMode()) {
                            runCatching { sendFrame("direct.ping", null, JSONObject().put("sentAt", System.currentTimeMillis())) }
                                .onFailure { directFailed("直连心跳发送失败") }
                            delay(5_000)
                        }
                    }
                    scope.launch { runCatching { refreshAccount(); refreshThreads(full = true); command("followup.list") } }
                    welcome.complete(Unit)
                } else if (kind == "direct.response") {
                    val value = crypto.decrypt(kind, null, frame.getString("id"), frame.getString("nonce"), frame.getString("ciphertext"))
                    val request = directReads.remove(value.getString("requestId"))
                    if (value.optBoolean("ok")) request?.complete(value.getJSONObject("result"))
                    else request?.completeExceptionally(IllegalStateException(value.optString("error", "直连读取失败")))
                } else if (kind != "direct.pong") handleFrameSafely(raw, "direct")
            }.onFailure { error -> welcome.completeExceptionally(error); directFailed(error.message ?: "直连数据验证失败") }
        }
        val onOpened = fun() {
            if (welcome.isCancelled || directWelcome !== welcome) return
            val id = UUID.randomUUID().toString()
            val raw = if (via == DirectVia.TunnelResume) {
                // A paired phone asks again on the tunnel, sealed with the pairing key.
                val encrypted = crypto.encryptWithKey(key, "direct.resume", null, id,
                    JSONObject().put("pcId", pcId).put("deviceId", phoneId).put("sentAt", System.currentTimeMillis()))
                JSONObject().put("v", 1).put("kind", "direct.resume").put("id", id).put("deviceId", phoneId)
                    .put("nonce", encrypted.first).put("ciphertext", encrypted.second).toString()
            } else {
                val encrypted = crypto.encryptWithKey(key, "direct.hello", null, id,
                    JSONObject().put("id", offer.getString("id")).put("deviceId", phoneId).put("name", phoneName))
                JSONObject().put("id", id).put("kind", "direct.hello").put("nonce", encrypted.first).put("ciphertext", encrypted.second).toString()
            }
            directPeer?.send(raw)
        }
        val onFailed = fun(reason: String) {
            if (!welcome.isCancelled && directWelcome === welcome) { welcome.completeExceptionally(IllegalStateException(reason)); directFailed(reason) }
        }
        val peer: DirectTransport = if (via == DirectVia.WebRtc) DirectPeer(context, onReceive, onOpened, onFailed) else {
            val target = if (via == DirectVia.TunnelResume) "resume" else offer.getString("id")
            DirectTunnelPeer(client, directTunnelUrl(offer.getString("tunnel"), target), onReceive, onOpened, onFailed)
        }
        directPeer = peer
        try {
            if (peer is DirectPeer) {
                val sdp = peer.answer(offer)
                try {
                    DirectSignaling.submit(offer, DirectQr.answer(offer, phoneId, phoneName, sdp), crypto) { directPeer !== peer || welcome.isCancelled }
                } catch (error: Exception) { if (!established) throw error }
            } else (peer as DirectTunnelPeer).connect()
            kotlinx.coroutines.withTimeout(if (via == DirectVia.WebRtc) 20_000 else 30_000) { welcome.await() }
        } catch (error: Exception) {
            if (directPeer === peer) { directPairing = false; directPeer = null }
            welcome.cancel(); peer.close()
            if (error is kotlinx.coroutines.TimeoutCancellationException) throw IllegalStateException(
                if (via == DirectVia.WebRtc) "当前网络无法自动直连，请换用同一 Wi-Fi／热点或账户连接" else "跨网络直连超时，请稍后重试或换用账户连接", error)
            throw error
        }
    }

    @Volatile private var directResumeJob: kotlinx.coroutines.Job? = null
    @Volatile private var directResumeAttempt = 0

    /** Phone and computer were paired before: find the computer on the LAN and reconnect without a scan. */
    private fun startDirectResume(delayMs: Long = 0L): Boolean {
        if (!directMode() || directPeer != null || directPairing) return directResumeJob?.isActive == true
        val pcId = crypto.directPcId() ?: return false
        if (crypto.directResume() == null) return false
        val key = crypto.accountKey() ?: return false
        if (directResumeJob?.isActive == true) return true
        directResumeJob = scope.launch {
            delay(delayMs)
            while (directMode() && directPeer == null && !directPairing) {
                _connection.value = ConnectionState.Connecting
                _statusText.value = if (phoneHasNetwork()) "正在重新直连电脑" else "手机没有网络，联网后自动重连"
                // A welcome may have updated where the computer listens.
                val info = crypto.directResume() ?: break
                val failure = runCatching {
                    // On Wi-Fi the computer is usually on the same LAN; on mobile data it never is.
                    val lan = if (info.port in 1024..65535 && phoneLinks().isNotEmpty()) runCatching {
                        val offer = DirectSignaling.resume(pcId, crypto.deviceId(), key, directResumeTargets(info.hosts, info.port, lanBroadcasts()), crypto)
                        joinDirect(offer, key, resumed = true)
                    } else Result.failure(IllegalStateException("不在电脑所在的局域网"))
                    lan.exceptionOrNull()?.let { error ->
                        if (error is kotlinx.coroutines.CancellationException) throw error
                        val tunnel = info.tunnel ?: throw error
                        joinDirect(JSONObject().put("pcId", pcId).put("pcName", crypto.directPcName() ?: "电脑").put("tunnel", tunnel),
                            key, resumed = true, via = DirectVia.TunnelResume)
                    }
                }.exceptionOrNull() ?: return@launch
                if (failure is kotlinx.coroutines.CancellationException) throw failure
                directResumeAttempt++
                Log.i(LOG_TAG, "direct resume attempt $directResumeAttempt failed: ${failure.message}")
                if (shouldSuggestAccountLogin(directResumeAttempt, phoneHasNetwork(), accountSuggestionShown, BuildConfig.ACCOUNT_LOGIN)) {
                    accountSuggestionShown = true; _suggestAccountLogin.value = true
                }
                _connection.value = ConnectionState.Offline
                _statusText.value = if (directResumeAttempt >= 3) "直连电脑暂时连不上，自动重试中；电脑重启过请重新扫码" else "电脑离线，正在重试直连"
                delay(listOf(2_000L, 4_000L, 8_000L, 15_000L, 30_000L)[(directResumeAttempt - 1).coerceIn(0, 4)])
            }
        }
        return true
    }

    private fun lanBroadcasts(): List<String> = runCatching {
        val cm = connectivity ?: return emptyList()
        cm.allNetworks.mapNotNull { cm.getLinkProperties(it) }.flatMap { it.linkAddresses }
            .filter { it.address is java.net.Inet4Address && !it.address.isLoopbackAddress }
            .mapNotNull { ipv4Broadcast(it.address.hostAddress ?: "", it.prefixLength) }.distinct()
    }.getOrDefault(emptyList())

    private fun directFailed(reason: String) {
        directPairing = false
        directHeartbeat?.cancel(); directHeartbeat = null
        relayConnected = false; reconnect = false; connectorWatchdogJob?.cancel()
        _connection.value = ConnectionState.Offline; _statusText.value = "直连已断开，重新扫码连接"
        _message.value = reason
        directReads.values.forEach { it.completeExceptionally(IllegalStateException(reason)) }; directReads.clear()
        val previous = directPeer; directPeer = null
        scope.launch { previous?.close() }
        // A paired computer is retried on the LAN instead of asking for a new scan.
        if (startDirectResume(1_000L)) _message.value = null
    }

    suspend fun restoreServerConnection(): Boolean = withContext(Dispatchers.IO) {
        disconnect()
        if (!crypto.restoreCloudSession()) return@withContext false
        resetSessionView()
        refreshAgentConnectorIds()
        _message.value = null; _sessionExpired.value = false
        _pairingLogin.value = PairingLoginState.Idle
        lastSequence = crypto.sequence()
        _threads.value = emptyList(); _items.value = emptyList(); _account.value = null; threadsCursor = null; itemsCursors.clear()
        _selectedConnectorId.value = crypto.selectedConnectorId()
        connect(); true
    }

    fun connect() {
        if (BuildConfig.DEMO) return
        if (directPairing) return
        if (directMode()) { if (directPeer == null && !startDirectResume()) directFailed("请重新扫描电脑连接码"); return }
        if (!configured() || relayConnected || socket != null) return
        if (connectInFlight) { reconnect = true; return }
        val sessionTicket = sessionSnapshotGuard.capture()
        connectInFlight = true
        reconnect = true; _connection.value = ConnectionState.Connecting; _statusText.value = if (phoneHasNetwork()) "正在连接" else reconnectingText()
        scope.launch {
            try {
                val token = token()
                if (!sessionSnapshotGuard.isCurrent(sessionTicket)) return@launch
                val wsPath = if (usingV2()) "/bridge/v2/ws" else "/bridge/ws"
                val request = Request.Builder().url(serverUrl().replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + wsPath)
                    .header("Authorization", "Bearer $token").build()
                val startedAt = System.currentTimeMillis()
                sessionSnapshotGuard.publish(sessionTicket) {
                    socketStartedAt = startedAt
                    socket = client.newWebSocket(request, Listener())
                    startConnectWatchdog(startedAt)
                }
            } catch (error: Exception) {
                sessionSnapshotGuard.publish(sessionTicket) {
                    socket = null
                    socketStartedAt = 0L
                    onOffline(error.message ?: "连接失败")
                }
            }
            finally {
                connectInFlight = false
                if (!sessionSnapshotGuard.isCurrent(sessionTicket) && reconnect && configured() && socket == null) scheduleReconnect(0L)
            }
        }
    }

    /** Called when the app returns to the foreground or the sticky service is restarted. */
    fun resumeConnection() {
        if (BuildConfig.DEMO) return
        if (directPairing) return
        if (directMode()) { if (directPeer == null && !startDirectResume()) directFailed("请重新扫描电脑连接码"); return }
        if (!configured()) return
        reconnect = true
        val now = System.currentTimeMillis()
        val resumedFromBackground = activityBackgrounded
        activityBackgrounded = false
        if (resumedFromBackground) {
            val heartbeatAt = connectorHeartbeatAt.takeIf { it > 0L } ?: connectorConnectedAt
            val heartbeatAge = if (heartbeatAt > 0L) now - heartbeatAt else Long.MAX_VALUE
            // The foreground service keeps the WebSocket and one-second connector
            // heartbeat alive while the Activity is backgrounded. Reusing a fresh
            // transport makes a normal app switch return immediately. ColorOS can
            // still invalidate the socket without notifying OkHttp; in that case
            // the short grace window below detects the stale heartbeat and replaces
            // the transport without waiting for the 12-second watchdog.
            if (relayConnected && socket != null && heartbeatAge < RESUME_HEARTBEAT_GRACE_MS) {
                return
            }
            // The activity can resume while OkHttp is still completing the
            // existing handshake. Do not cancel that socket and start another
            // one; repeated ON_START callbacks otherwise create a handshake
            // timeout loop and leave the phone in "正在连接" for a long time.
            if (!relayConnected && socket != null && socketStartedAt > 0L && now - socketStartedAt < CONNECT_ATTEMPT_TIMEOUT_MS) {
                return
            }
            if (relayConnected || socket != null) {
                restartTransport("从后台返回，刷新连接通道")
            } else {
                reconnectAttempt = 0
                scheduleReconnect(0L)
            }
            return
        }
        val heartbeatAt = connectorHeartbeatAt.takeIf { it > 0L } ?: connectorConnectedAt
        val heartbeatAge = if (heartbeatAt > 0L) now - heartbeatAt else Long.MAX_VALUE
        // ON_START is also delivered after opening a task. Never tear down a
        // live or still-handshaking socket merely because the UI resumed.
        if (relayConnected && socket != null && heartbeatAge < CONNECTOR_HEARTBEAT_TIMEOUT_MS) {
            return
        }
        if (socket != null && !relayConnected && socketStartedAt > 0L && now - socketStartedAt < CONNECT_ATTEMPT_TIMEOUT_MS) return
        if (relayConnected && socket != null) {
            // A stale presence must not leave the old socket in place. connect()
            // deliberately refuses to create a second socket while this field is
            // non-null, so merely changing the UI to Offline would permanently
            // strand the session after a short radio/network pause.
            restartTransport("电脑连接器心跳超时")
            return
        }
        if (socket != null) restartTransport("连接通道已失效")
        reconnectAttempt = 0
        scheduleReconnect(0L)
    }

    fun noteAppBackgrounded() {
        activityBackgrounded = true
    }

    fun disconnect() {
        agentSnapshots.clear()
        _agentOpenStates.value = emptyMap()
        _agentOpenStatesByConnector.value = emptyMap(); _agentInstalledByConnector.value = emptyMap()
        directPairing = false
        directResumeJob?.cancel(); directResumeJob = null; directResumeAttempt = 0
        directHeartbeat?.cancel(); directHeartbeat = null
        directWelcome?.cancel(); directWelcome = null
        directPeer?.close(); directPeer = null
        directReads.values.forEach { it.cancel() }; directReads.clear()
        reconnect = false
        reconnectJob?.cancel(); reconnectJob = null
        connectWatchdogJob?.cancel(); connectWatchdogJob = null
        socketStartedAt = 0L
        relayConnected = false
        connectorWatchdogJob?.cancel()
        socket?.close(1000, "user")
        socket = null
        _connection.value = ConnectionState.Offline
    }

    fun clearMessage() { _message.value = null }
    fun showMessage(value: String) { _message.value = value }
    fun dismissUpdate() { _updateAvailable.value = null }
    /** Silence automatic prompts for this run; manual checks can still show this version. */
    fun postponeUpdate() {
        _updateAvailable.value?.let { postponedUpdates += it.versionCode; stopBackgroundDownload(it.versionCode) }
        _updateAvailable.value = null
    }
    /** Persistently silence automatic prompts for this version, without blocking manual checks. */
    fun skipUpdate() {
        _updateAvailable.value?.let { crypto.saveSkippedUpdateVersion(it.versionCode); stopBackgroundDownload(it.versionCode) }
        _updateAvailable.value = null
    }

    // Versions whose download the user cancelled: not downloaded again in the
    // background during this run.
    private val cancelledBackgroundVersions = java.util.Collections.synchronizedSet(mutableSetOf<Int>())

    /** The user said no to this version: stop its background download, if one runs. */
    private fun stopBackgroundDownload(versionCode: Int) {
        cancelledBackgroundVersions += versionCode
        val call = synchronized(updateDownloadLock) {
            if (quietDownloadGeneration != updateDownloadGeneration || backgroundDownloadVersion > versionCode) return
            updateDownloadGeneration++
            quietDownloadGeneration = -1L
            updateDownloadCall.also { updateDownloadCall = null }
        }
        call?.cancel()
    }
    fun resetUpdateDownload() {
        _updateAvailable.value?.let { cancelledBackgroundVersions += it.versionCode }
        val call = synchronized(updateDownloadLock) {
            updateDownloadGeneration++
            val previous = updateDownloadCall
            updateDownloadCall = null
            downloadedUpdate?.delete()
            downloadedUpdate = null
            _updateDownload.value = UpdateDownloadState.Idle
            File(context.cacheDir, "updates").listFiles()?.filter { it.name.endsWith(".part") }?.forEach(File::delete)
            previous
        }
        call?.cancel()
    }

    // A background download (后台下载更新) shows nothing until its package is
    // ready: progress, failure and cancellation stay out of the update dialog,
    // which would otherwise turn into an undismissable "downloading" modal.
    private var quietDownloadGeneration = -1L
    @Volatile private var backgroundDownloadVersion = -1
    private val backgroundUpdateMutex = Mutex()
    private fun publishUpdateDownload(generation: Long, state: UpdateDownloadState): Boolean = synchronized(updateDownloadLock) {
        if (generation != updateDownloadGeneration) false
        else { if (generation != quietDownloadGeneration || state is UpdateDownloadState.Ready) _updateDownload.value = state; true }
    }

    /**
     * A download ended without a package: a shown one says so; a quiet one says
     * nothing, and stops counting as running under the same lock, so a tap on
     * download in between never joins a download that has already ended.
     */
    private fun endUpdateDownload(generation: Long, state: UpdateDownloadState) = synchronized(updateDownloadLock) {
        if (generation != updateDownloadGeneration) return@synchronized
        if (quietDownloadGeneration == generation) quietDownloadGeneration = -1L
        else _updateDownload.value = state
    }

    // A failed background download is not retried for an hour: every attempt
    // starts from zero, and it may be on mobile data.
    private val backgroundFailedAt = java.util.concurrent.ConcurrentHashMap<Int, Long>()

    /** The package of [update] is downloaded, checked and ready to install. */
    fun updateReadyFor(update: UpdateInfo): Boolean =
        (_updateDownload.value as? UpdateDownloadState.Ready)?.versionName == update.versionName && downloadedUpdate?.isFile == true

    /**
     * A background download of this version is running: show it from here on
     * (the user tapped download) instead of starting again from zero.
     */
    fun promoteBackgroundDownload(update: UpdateInfo): Boolean = synchronized(updateDownloadLock) {
        if (quietDownloadGeneration != updateDownloadGeneration || backgroundDownloadVersion != update.versionCode) return@synchronized false
        quietDownloadGeneration = -1L
        _updateDownload.value = UpdateDownloadState.Downloading(0, 0, "", connecting = true)
        true
    }

    /**
     * 后台下载更新: download [update] quietly when the setting is on and the
     * user is not downloading it themselves. True
     * when its package is ready to install.
     */
    suspend fun prepareUpdateInBackground(update: UpdateInfo): Boolean {
        if (updateReadyFor(update)) return true
        if (!_autoDownloadUpdates.value || update.versionCode in cancelledBackgroundVersions) return false
        if (System.currentTimeMillis() - (backgroundFailedAt[update.versionCode] ?: 0L) < 60 * 60_000L) return false
        if (_updateDownload.value is UpdateDownloadState.Downloading) return false
        return backgroundUpdateMutex.withLock {
            if (updateReadyFor(update)) return@withLock true
            if (_updateDownload.value is UpdateDownloadState.Downloading) return@withLock false
            try {
                downloadUpdate(update, quiet = true)
                updateReadyFor(update)
            } catch (cancelled: CancellationException) {
                // The service stopping is a real cancellation; a newer download
                // replacing this one is not.
                currentCoroutineContext().ensureActive()
                false
            } catch (error: Exception) {
                Log.w(LOG_TAG, "background update download failed: ${error.message}")
                false
            } finally {
                backgroundDownloadVersion = -1
            }
        }
    }

    /** Keeps only the package that may still be installed, and downloads still being written. */
    private fun pruneUpdateFiles(keep: UpdateInfo?) = synchronized(updateDownloadLock) {
        // A download (shown or quiet) is still writing or renaming its file.
        if (_updateDownload.value is UpdateDownloadState.Downloading || quietDownloadGeneration == updateDownloadGeneration) return@synchronized
        val keepName = keep?.let { "fengzhu-codex-${it.versionCode}.apk" }
        val now = System.currentTimeMillis()
        File(context.cacheDir, "updates").listFiles()?.forEach { file ->
            val stale = if (file.name.endsWith(".part")) now - file.lastModified() > 30 * 60_000L else file.name != keepName
            if (stale && file != downloadedUpdate) file.delete()
        }
    }
    fun watchThread(threadId: String?) {
        historyLoadGeneration++
        if (threadId != null && activeThreadId != threadId) {
            synchronized(historyRefreshLock) {
                historyRefreshGeneration++
                historyRefreshPending.set(false)
                historyRefreshJob?.cancel()
                historyRefreshJob = null
            }
            _items.value = emptyList()
            _historyLoadState.value = HistoryLoadState(threadId = threadId, loading = true)
        }
        activeThreadId = threadId
        if (threadId == null) {
            synchronized(historyRefreshLock) {
                historyRefreshGeneration++
                historyRefreshPending.set(false)
                historyRefreshJob?.cancel()
                historyRefreshJob = null
            }
        }
    }

    fun markThreadRead(threadId: String) {
        val thread = _threads.value.firstOrNull { it.id == threadId }
        clearReadTerminalNotice(context, threadId, thread?.title, thread?.let { agentName(it.backend) })
        if (thread == null) return
        crypto.markThreadRead(threadId, thread.updatedAt)
        _threads.value = sortThreadSummaries(_threads.value.map { item ->
            if (item.id == threadId) item.copy(unread = false, phoneReadAt = maxOf(item.phoneReadAt, thread.updatedAt)) else item
        })
    }

    fun markActiveThreadRead() {
        activeThreadId?.let(::markThreadRead)
    }

    fun markAllThreadsRead() {
        _threads.value.forEach { clearReadTerminalNotice(context, it.id, it.title, agentName(it.backend)) }
        val readAt = maxOf(System.currentTimeMillis(), _threads.value.maxOfOrNull { it.updatedAt } ?: 0)
        crypto.markAllThreadsRead(readAt)
        _threads.value = withAllThreadsRead(_threads.value, readAt)
    }

    suspend fun checkForUpdate(manual: Boolean = false): UpdateInfo? = withContext(Dispatchers.IO) {
        // A build without an update key (open source) has no update channel.
        if (BuildConfig.UPDATE_PUBLIC_KEY.isBlank()) {
            check(!manual) { "这个版本没有配置更新渠道" }
            return@withContext null
        }
        val relay = (if (directMode()) DEFAULT_BRIDGE_SERVER else serverUrl()) + "/downloads"
        // Ask the mirrors (GitHub, jsDelivr) and the relay at once; a mirror that
        // lags behind loses. Once the relay has answered, a slow or blocked
        // mirror (often the case in mainland China) gets only a short grace.
        val pending = updateManifestSources(BuildConfig.UPDATE_MIRRORS, relay).map { base ->
            base to scope.async(Dispatchers.IO) { runCatching { fetchVerifiedManifest(base) } }
        }
        val (relayBase, relayJob) = pending.last()
        val relayResult = relayJob.await()
        val results = pending.dropLast(1).map { (base, job) ->
            base to (withTimeoutOrNull(if (relayResult.isSuccess) 2_500L else 16_000L) { job.await() }
                ?: Result.failure(IllegalStateException("超时")))
        } + (relayBase to relayResult)
        results.forEach { (base, result) -> result.exceptionOrNull()?.let { Log.w(LOG_TAG, "update manifest from $base: ${it.message}") } }
        val manifest = newestAndroidManifest(results.mapNotNull { it.second.getOrNull() })
            ?: throw (results.lastOrNull()?.second?.exceptionOrNull() ?: IllegalStateException("更新清单读取失败"))
        val android = manifest.getJSONObject("android")
        val urls = updateDownloadUrls(android, ::rehomeBridgeUrl)
        check(urls.isNotEmpty()) { "更新清单里没有下载地址" }
        val update = UpdateInfo(android.getString("versionName"), android.getInt("versionCode"), urls.first(), android.getString("sha256"),
            updateNotes(android.optString("notes")), urls)
        val skipped = crypto.skippedUpdateVersion()
        val offered = update.takeIf {
            shouldOfferUpdate(it.versionCode, BuildConfig.VERSION_CODE, skipped, postponedUpdates, manual)
        }
        // A suppressed background check must not close a prompt opened by a
        // manual check, or report that visible prompt as a new automatic alert.
        // A lagging mirror's older manifest, while a newer package is already
        // downloaded: keep that package and its prompt, and change nothing.
        val downloadedCode = synchronized(updateDownloadLock) {
            downloadedUpdate?.name?.let { Regex("""fengzhu-codex-(\d+)\.apk""").find(it)?.groupValues?.get(1)?.toIntOrNull() } ?: -1
        }
        if (offered != null && downloadedCode > offered.versionCode) return@withContext null
        if (offered != null) _updateAvailable.value = offered
        if (offered != null) {
            // A package of an older version must not be installed under this one's name.
            synchronized(updateDownloadLock) {
                val ready = _updateDownload.value as? UpdateDownloadState.Ready
                // Older only: a lagging mirror must not throw away a newer package.
                val readyCode = downloadedUpdate?.name?.let { Regex("""fengzhu-codex-(\d+)\.apk""").find(it)?.groupValues?.get(1)?.toIntOrNull() } ?: -1
                if (ready != null && ready.versionName != offered.versionName && readyCode < offered.versionCode) {
                    downloadedUpdate?.delete(); downloadedUpdate = null
                    _updateDownload.value = UpdateDownloadState.Idle
                }
            }
            if (_updateDownload.value !is UpdateDownloadState.Ready) restoreDownloadedUpdate(offered)
        }
        // Installed, skipped or replaced packages do not stay in the cache.
        pruneUpdateFiles(offered ?: _updateAvailable.value)
        offered
    }

    private fun fetchVerifiedManifest(base: String): JSONObject {
        val manifestBytes = updateCheckClient.newCall(Request.Builder().url("$base/update-manifest.json").build()).execute().use {
            check(it.isSuccessful) { "更新清单读取失败: ${it.code}" }
            it.body?.bytes() ?: error("更新清单为空")
        }
        val signature = updateCheckClient.newCall(Request.Builder().url("$base/update-manifest.sig").build()).execute().use {
            check(it.isSuccessful) { "更新签名读取失败: ${it.code}" }
            it.body?.bytes() ?: error("更新签名为空")
        }
        check(crypto.verifyUpdateSignature(manifestBytes, signature)) { "更新签名验证失败" }
        return JSONObject(String(manifestBytes, Charsets.UTF_8))
    }

    suspend fun downloadUpdate(update: UpdateInfo, quiet: Boolean = false) = withContext(Dispatchers.IO) {
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }
        // Each run owns its partial file: a cancelled run cannot remove a new retry.
        val name = "fengzhu-codex-${update.versionCode}.apk"
        val temporary = File(directory, "$name.${UUID.randomUUID()}.part")
        val target = File(directory, name)
        val (generation, previousCall) = synchronized(updateDownloadLock) {
            // The user's own download (shown) is never replaced by a background one.
            if (quiet && _updateDownload.value is UpdateDownloadState.Downloading) throw CancellationException("用户正在下载")
            updateDownloadGeneration++
            quietDownloadGeneration = if (quiet) updateDownloadGeneration else -1L
            backgroundDownloadVersion = if (quiet) update.versionCode else -1
            val previous = updateDownloadGeneration to updateDownloadCall
            updateDownloadCall = null
            downloadedUpdate?.delete()
            downloadedUpdate = null
            // The package it replaces is gone: the dialog must not offer it.
            if (quiet && _updateDownload.value !is UpdateDownloadState.Downloading) _updateDownload.value = UpdateDownloadState.Idle
            previous
        }
        previousCall?.cancel()
        val maxAttempts = 5
        try {
            var lastError: Exception? = null
            val sources = update.urls.ifEmpty { listOf(update.url) }
            for (attempt in 1..maxAttempts) {
                currentCoroutineContext().ensureActive()
                // Take turns between the sources (GitHub, then the relay). The
                // same bytes sit at each, so a partial file resumes across them.
                val url = sources[(attempt - 1) % sources.size]
                if (!publishUpdateDownload(generation, UpdateDownloadState.Downloading(
                    temporary.length(), 0, updateDownloadChannel(url), connecting = true,
                ))) throw CancellationException("下载已取消")
                try {
                    downloadUpdateAttempt(url, temporary, generation)
                    lastError = null
                    break
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    // Keep the partial file so the next attempt resumes from where the
                    // stream dropped instead of restarting the whole 7 MB transfer.
                    lastError = error
                    Log.w(LOG_TAG, "update download attempt $attempt/$maxAttempts from ${updateDownloadChannel(url)} failed at ${temporary.length()} bytes: ${error.javaClass.simpleName}")
                    // Moving on to another source needs no back-off.
                    if (attempt < maxAttempts && sources.size == 1) delay(2000L * attempt)
                }
            }
            if (lastError != null) throw lastError
            currentCoroutineContext().ensureActive()
            check(fileSha256(temporary).equals(update.sha256, ignoreCase = true)) { "更新包校验失败，文件已删除" }
            currentCoroutineContext().ensureActive()
            synchronized(updateDownloadLock) {
                if (generation != updateDownloadGeneration) throw CancellationException("下载已取消")
                check(temporary.renameTo(target)) { "无法保存更新包" }
                downloadedUpdate = target
                _updateDownload.value = UpdateDownloadState.Ready(update.versionName)
                // Under the same lock: a tap on download now installs, never joins it.
                if (quietDownloadGeneration == generation) quietDownloadGeneration = -1L
            }
        } catch (cancelled: CancellationException) {
            temporary.delete()
            endUpdateDownload(generation, UpdateDownloadState.Idle)
            throw cancelled
        } catch (error: Exception) {
            temporary.delete()
            if (quiet) backgroundFailedAt[update.versionCode] = System.currentTimeMillis()
            endUpdateDownload(generation, UpdateDownloadState.Failed(error.message ?: "更新下载失败"))
            throw error
        } finally {
            // Ended: a tap on download now starts or installs, never joins it.
            synchronized(updateDownloadLock) {
                if (quietDownloadGeneration == generation) quietDownloadGeneration = -1L
                if (quiet && generation == updateDownloadGeneration) backgroundDownloadVersion = -1
            }
        }
    }

    // One download attempt that appends to `temporary`, resuming with a Range
    // header when a partial file already exists. Progress is reported against the
    // total (existing bytes + Content-Length of this response).
    private suspend fun downloadUpdateAttempt(url: String, temporary: File, generation: Long) {
        val coroutine = currentCoroutineContext()
        coroutine.ensureActive()
        val existing = if (temporary.isFile) temporary.length() else 0L
        val request = Request.Builder().url(url)
            .apply { if (existing > 0) header("Range", "bytes=$existing-") }
            .build()
        val call = (if (isUpdateMirrorUrl(url)) mirrorDownloadClient else downloadClient).newCall(request)
        synchronized(updateDownloadLock) {
            if (generation != updateDownloadGeneration) throw CancellationException("下载已取消")
            updateDownloadCall = call
        }
        try {
            coroutine.ensureActive()
            call.execute().use { response ->
                coroutine.ensureActive()
                check(response.isSuccessful) { "更新包下载失败: ${response.code}" }
                // 206 = resumed; 200 = server ignored Range, so restart from zero.
                val resuming = response.code == 206
                if (existing > 0 && !resuming) temporary.delete()
                val body = response.body ?: error("更新包为空")
                val startAt = if (resuming) existing else 0L
                val total = (body.contentLength().coerceAtLeast(0)).let { if (it > 0) startAt + it else 0L }
                // OkHttp follows redirects; show the host actually serving bytes.
                val channel = updateDownloadChannel(response.request.url.toString())
                if (!publishUpdateDownload(generation, UpdateDownloadState.Downloading(startAt, total, channel))) throw CancellationException("下载已取消")
                var downloaded = startAt
                var lastReported = -1L
                body.byteStream().use { input ->
                    FileOutputStream(temporary, resuming).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            coroutine.ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            coroutine.ensureActive()
                            output.write(buffer, 0, count)
                            downloaded += count
                            if (lastReported < 0 || downloaded - lastReported >= 128 * 1024) {
                                if (!publishUpdateDownload(generation, UpdateDownloadState.Downloading(downloaded, total, channel))) throw CancellationException("下载已取消")
                                lastReported = downloaded
                            }
                        }
                        output.flush()
                    }
                }
            }
        } finally {
            synchronized(updateDownloadLock) { if (updateDownloadCall === call) updateDownloadCall = null }
        }
    }

    private fun fileSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun installDownloadedUpdate(): Boolean {
        val file = downloadedUpdate?.takeIf { it.isFile }
        if (file == null) {
            _updateDownload.value = UpdateDownloadState.Failed("更新包不存在，请重新下载")
            return false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        return true
    }

    /**
     * Hands an app package fetched from the computer to the system installer
     * (no app chooser). False when khLink may not install apps yet: the
     * system page to allow it is opened instead, for the user to decide.
     */
    fun installApk(file: File): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        return runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        }.isSuccess
    }

    /** Opens a fetched computer file with the app for its type; false when none can. */
    /**
     * Copies a fetched computer file into the phone's public Download/KH Link
     * folder (visible in the Files app), and returns where it went.
     */
    suspend fun saveToDownloads(file: File): String = withContext(Dispatchers.IO) {
        val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            val resolver = context.contentResolver
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, file.name)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
                put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/khLink")
                put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("无法在下载文件夹里新建文件")
            try {
                resolver.openOutputStream(uri).use { output -> file.inputStream().use { it.copyTo(requireNotNull(output)) } }
                resolver.update(uri, android.content.ContentValues().apply { put(android.provider.MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            } catch (failure: Throwable) {
                resolver.delete(uri, null, null); throw failure
            }
            "下载/khLink/${file.name}"
        } else {
            val directory = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir, "khLink")
            val target = uniqueFile(directory, file.name)
            file.copyTo(target)
            target.absolutePath
        }
    }

    /** Hands a web video link to the system downloader (with its own notification). */
    fun downloadWebFile(url: String): String {
        val name = runCatching { java.net.URLDecoder.decode(Uri.parse(url).lastPathSegment.orEmpty(), "UTF-8") }.getOrNull()
            ?.replace(Regex("[\\\\/:*?\"<>|]"), "_")?.ifBlank { null } ?: "video.mp4"
        val request = android.app.DownloadManager.Request(Uri.parse(url))
            .setTitle(name)
            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        val where = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "khLink/$name"); "下载/khLink/$name"
        } else {
            request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, "khLink/$name"); name
        }
        context.getSystemService(android.app.DownloadManager::class.java).enqueue(request)
        return where
    }

    fun openFetchedFile(file: File): Boolean {
        val extension = file.extension.lowercase()
        val mime = when (extension) {
            "html", "htm" -> "text/html"
            in TEXT_EXTENSIONS -> "text/plain"
            else -> android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "*/*"
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return runCatching {
            context.startActivity(Intent.createChooser(view, "打开 ${file.name}").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        }.isSuccess
    }

    // A single page is the server's newest-100-by-updatedAt threads, with no
    // concept of "pinned" at all (that status is decoded client-side from
    // ciphertext). Routine event-triggered refreshes only need this one
    // cheap page: whatever changed is, almost by definition, recent enough
    // to be in it, and the merge below keeps every already-known thread
    // visible either way. [full] pages through the `before` cursor until the
    // server runs out of threads (or the safety cap), for the cases where the
    // single most-recent page genuinely is not enough — a fresh install with
    // no local cache yet, or the user explicitly asking to find something
    // that a light refresh cannot reach: a pinned thread nobody has touched
    // in a long time can otherwise never be discovered on a new device, since
    // it may never be new enough to land in the newest-100 page.
    // Events from the computer can arrive many per second; fetch the thread
    // list once for a burst of them instead of once per event.
    private var threadsRefreshJob: Job? = null
    private fun requestThreadsRefresh() {
        synchronized(this) {
            if (threadsRefreshJob?.isActive == true) return
            threadsRefreshJob = scope.launch { delay(1_500); runCatching { refreshThreads() } }
        }
    }

    suspend fun refreshThreads(full: Boolean = false) = withContext(Dispatchers.IO) { if (BuildConfig.DEMO) return@withContext; threadsMutex.withLock {
        val sessionTicket = sessionSnapshotGuard.capture()
        val readSnapshot = crypto.threadReadSnapshot()
        val cache = mutableListOf<CachedThread>(); val decoded = mutableListOf<ThreadSummary>()
        var page = 0
        var deleted = emptyMap<String, Long>()
        fun take(rows: org.json.JSONArray) {
            for (i in 0 until rows.length()) {
                val row = rows.getJSONObject(i); val id = row.getString("id")
                cache += CachedThread(id, row.getLong("updatedAt"), row.getString("nonce"), row.getString("ciphertext"))
                decodeThread(row, readSnapshot)?.let(decoded::add)
            }
        }
        val v2 = usingV2()
        val since = threadsCursor.takeIf { !full && v2 }
        var nextCursor: Long? = null
        if (since != null) {
            // Only the rows changed since the last look: one active
            // conversation no longer re-downloads the newest hundred rows.
            var at: Long = since
            while (true) {
                val response = get("/api/v2/history/threads?since=$at&limit=$FULL_THREAD_SYNC_PAGE_SIZE")
                deleted = deleted + parseDeletedThreads(response.optJSONArray("deleted"))
                take(response.getJSONArray("items"))
                // A relay that no longer filters sent its newest page instead.
                if (!response.has("cursor")) { nextCursor = null; break }
                at = response.getLong("cursor"); nextCursor = at; page += 1
                if (!response.optBoolean("more") || page >= FULL_THREAD_SYNC_MAX_PAGES) break
            }
        } else {
            var before: Long? = null
            while (true) {
                val query = "/api/${if (v2) "v2" else "v1"}/history/threads?limit=100" +
                    (before?.let { "&before=$it" } ?: "")
                val response = get(query)
                if (before == null) {
                    deleted = parseDeletedThreads(response.optJSONArray("deleted"))
                    if (response.has("cursor")) nextCursor = response.getLong("cursor")
                }
                val rows = response.getJSONArray("items")
                take(rows)
                page += 1
                if (!full || rows.length() < FULL_THREAD_SYNC_PAGE_SIZE || page >= FULL_THREAD_SYNC_MAX_PAGES) break
                before = rows.getJSONObject(rows.length() - 1).getLong("updatedAt")
            }
        }
        if (!sessionSnapshotGuard.isCurrent(sessionTicket)) return@withLock
        Log.d(LOG_TAG, "threads refresh ${if (since != null) "since" else if (full) "full" else "page"} rows=${cache.size} pages=$page cursor=${nextCursor != null}")
        database.cache().putThreads(cache)
        if (!sessionSnapshotGuard.isCurrent(sessionTicket)) return@withLock
        // Merge instead of replace so an already-visible thread never
        // disappears just because this particular page didn't include it.
        // What the phone has seen since (newer activity, a later read mark,
        // read state) wins over the relay's older copy; otherwise every
        // refresh flipped those fields back and the next event flipped them
        // forward again, redrawing the list and the open conversation.
        var removed: Set<String> = emptySet()
        val published = sessionSnapshotGuard.publish(sessionTicket) {
            val current = _threads.value.associateBy { it.id }
            val merged = (current + decoded.associateBy { it.id }.mapValues { (id, fresh) ->
                val known = current[id] ?: return@mapValues fresh
                val readAt = maxOf(fresh.phoneReadAt, known.phoneReadAt)
                val updatedAt = mergeThreadActivityAt(fresh, known)
                fresh.copy(updatedAt = updatedAt, activityAt = if (fresh.activityAt != null) updatedAt else known.activityAt,
                    phoneReadAt = readAt, unread = fresh.unread && updatedAt > readAt)
            }).values.toList()
        // Conversations deleted on the relay leave this phone too, with their
        // cached history; one active again since then is kept.
            removed = threadsDeletedOnRelay(deleted, merged)
            _threads.value = sortThreadSummaries(withDesktopPinSnapshots(merged.filterNot { it.id in removed }))
            decoded.filter { it.backend == "codex" }.mapNotNull { it.codexQuestions }.forEach { applyCodexQuestionState(it) }
            announceWaitingPrompts(merged)
        }
        if (!published) return@withLock
        removed.forEach { id ->
            if (!sessionSnapshotGuard.isCurrent(sessionTicket)) return@withLock
            database.cache().deleteThread(id); database.cache().deleteItems(id)
        }
        sessionSnapshotGuard.publish(sessionTicket) {
            // Only acknowledge the change cursor after all cache deletions
            // succeed, so a failed local write can be retried next time.
            threadsCursor = if (v2) nextCursor else null
            if (full) historyCachePrefs.edit().putBoolean(FULL_THREAD_SYNC_DONE_KEY, true).apply()
        }
        schedulePrefetch()
    } }

    private fun agentName(backend: String) = when (backend) { "claude" -> "Claude"; "pi" -> "Pi"; "antigravity" -> "反重力"; "dsh" -> "DeepSeek"; "hermes" -> "Hermes"; else -> "Codex" }

    // One reminder per finished turn, naming the session and how it ended.
    private fun announceTurnEnd(threadId: String, status: String, durationMs: Long) {
        if (onScreen(threadId)) return
        val thread = _threads.value.firstOrNull { it.id == threadId } ?: return
        if (thread.backend == "claude" && !_claudeConsent.value.enabled) return
        val agent = agentName(thread.backend)
        val outcome = when (status) {
            "failed" -> "运行失败"
            "cancelled", "canceled" -> "已停止"
            else -> "已完成"
        }
        threadNotificationSink?.invoke(threadId, "$agent $outcome · ${thread.title}", "本轮用时 ${formatTurnDuration(durationMs)}，点按查看", status == "failed", ThreadNoticeKind.TERMINAL)
    }

    // A Claude session that starts waiting on a desktop prompt rings once per
    // prompt. Prompts already waiting when the app starts are not announced.
    private fun announceWaitingPrompts(threads: List<ThreadSummary>) {
        val waiting = threads.filter { !it.archived && it.waiting != null && it.waiting.requestId.isNotBlank() }
        if (!promptsSeeded) { promptsSeeded = true; waiting.forEach { announcedPrompts += it.waiting!!.requestId }; return }
        for (thread in waiting) {
            val prompt = thread.waiting!!
            if (!announcedPrompts.add(prompt.requestId)) continue
            if (thread.backend == "claude" && !_claudeConsent.value.enabled) continue
            Log.i(LOG_TAG, "desktop prompt reminder thread=${thread.id} onScreen=${onScreen(thread.id)} sink=${threadNotificationSink != null}")
            if (onScreen(thread.id)) continue
            val who = agentName(thread.backend)
            threadNotificationSink?.invoke(thread.id, "$who 在等你 · ${thread.title}", waitingPreview(prompt) ?: thread.note.ifBlank { "打开看看要处理什么" }, true, ThreadNoticeKind.PROMPT)
        }
        while (announcedPrompts.size > 200) announcedPrompts.remove(announcedPrompts.first())
    }

    private data class DecodedHistoryPage(
        val items: List<HistoryItem>,
        val cache: List<CachedItem>,
        val hasMore: Boolean,
        // Rows the server now holds as not shown (a live reply replaced by the
        // stored one): any copy already on screen goes too.
        val removed: Set<String> = emptySet(),
        // Items below this order were cleared on the relay.
        val trimmedBefore: Long? = null,
        // The relay's item stamp at this read (newer relays): the next refresh
        // asks only for what was stored after it.
        val cursor: Long? = null,
    )

    // Per conversation, the relay's item stamp when this phone last had all of
    // its newest items on screen. In memory: a reopened app starts with a page.
    private val itemsCursors = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /**
     * The open conversation's changes since its cursor, merged into the screen
     * and the cache. False when there is no cursor yet, the relay is older, or
     * so much changed that the newest page is the better read.
     */
    private suspend fun mergeChangedItems(threadId: String, loadGeneration: Long): Boolean {
        val since = itemsCursors[threadId] ?: return false
        if (_historyLoadState.value.threadId != threadId) return false
        val page = fetchHistoryPage(threadId, "?changedSince=$since&limit=100")
        val cursor = page.cursor ?: return false
        if (page.hasMore) { itemsCursors.remove(threadId); return false }
        if (activeThreadId != threadId || historyLoadGeneration != loadGeneration) return true
        val cut = page.trimmedBefore
        if (cut != null) database.cache().deleteItemsBefore(threadId, cut)
        val before = _items.value.filterNot { cut != null && it.order < cut }
        if (before.isEmpty()) { itemsCursors.remove(threadId); return false }
        // Items older than the screen (a backfill of old history) go to the
        // cache only: on screen they would sit above a gap that scrolling up
        // then skips, because older pages start below the lowest item shown.
        val lowest = before.minOf { it.order }
        val merged = mergeChangedHistoryItems(before, page.items.filter { it.order >= lowest }, page.removed)
        val dropped = before.map { it.id }.toSet() - merged.map { it.id }.toSet()
        database.cache().putItems(page.cache)
        if (dropped.isNotEmpty()) database.cache().deleteItemIds(threadId, dropped.toList())
        // An older change replacing another item at its position: the cache
        // must not show both when scrolling up later.
        page.items.filter { it.order < lowest }.forEach { database.cache().deleteItemsAtOrder(threadId, it.order, it.id) }
        itemsCursors[threadId] = cursor
        if (activeThreadId != threadId || historyLoadGeneration != loadGeneration) return true
        _items.value = merged
        if (turnStartedAt[threadId] == null && isTurnBusyStatus(_liveStatuses.value[threadId].orEmpty())) {
            merged.asSequence().filter { it.type == "userMessage" }.mapNotNull(::historyItemTimestamp).maxOrNull()?.let { turnStartedAt.putIfAbsent(threadId, it) }
        }
        reconcileDeliveredInstructions(threadId, merged)
        _historyLoadState.value = _historyLoadState.value.copy(loadedCount = merged.size, error = null,
            trimmed = _historyLoadState.value.trimmed || cut != null)
        Log.d(LOG_TAG, "history changes merged thread=$threadId changed=${page.items.size} removed=${page.removed.size + dropped.size}")
        return true
    }

    private suspend fun fetchHistoryPage(threadId: String, query: String): DecodedHistoryPage {
        val response = get("/api/${if (usingV2()) "v2" else "v1"}/history/threads/${java.net.URLEncoder.encode(threadId, "UTF-8")}/items$query")
        val rows = response.getJSONArray("items")
        val cache = mutableListOf<CachedItem>()
        val decoded = mutableListOf<HistoryItem>()
        val removed = mutableSetOf<String>()
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i); val id = row.getString("id")
            cache += CachedItem(threadId, id, row.getLong("itemOrder"), row.getString("nonce"), row.getString("ciphertext"), System.currentTimeMillis(), row.optLong("createdAt"))
            decodeItem(threadId, row)?.let(decoded::add) ?: removed.add(id)
        }
        return DecodedHistoryPage(
            items = decoded.distinctBy { it.id }.sortedBy { it.order },
            cache = cache,
            hasMore = if (response.has("hasMore")) response.optBoolean("hasMore") else if (response.has("more")) response.optBoolean("more") else rows.length() >= HISTORY_PAGE_SIZE,
            removed = removed,
            trimmedBefore = if (response.has("trimmedBefore")) response.optLong("trimmedBefore") else null,
            cursor = if (response.has("cursor")) response.optLong("cursor") else null,
        )
    }

    // Conversations with new activity are fetched into the local cache while
    // the list is open, and in the background while the service keeps the
    // socket: opening one then shows its newest messages at once. One at a
    // time, never the open conversation, never a history.sync to the computer.
    private val prefetchMutex = Mutex()
    private val prefetchQueue = java.util.concurrent.ConcurrentLinkedDeque<String>()
    private var prefetchJob: Job? = null

    private fun historyPrefetchedAtKey(threadId: String) = "prefetchedAt:$threadId"

    private fun schedulePrefetch() {
        val candidates = prefetchCandidates(_threads.value, activeThreadId,
            { historyCachePrefs.getLong(historyPrefetchedAtKey(it), 0L) }, HISTORY_PREFETCH_THREADS)
        if (candidates.isEmpty()) return
        candidates.forEach { if (it !in prefetchQueue) prefetchQueue.add(it) }
        synchronized(this) {
            if (prefetchJob?.isActive == true) return
            prefetchJob = scope.launch(Dispatchers.IO) {
                while (true) {
                    val id = prefetchQueue.poll() ?: break
                    if (_connection.value != ConnectionState.Online) { prefetchQueue.clear(); break }
                    runCatching { prefetchThread(id) }.onFailure { Log.w(LOG_TAG, "history prefetch failed thread=$id", it) }
                }
            }
        }
    }

    private suspend fun prefetchThread(threadId: String) = prefetchMutex.withLock {
        if (threadId == activeThreadId) return@withLock
        val sessionTicket = sessionSnapshotGuard.capture()
        val startedAt = System.currentTimeMillis()
        val cachedMax = database.cache().maxItemOrder(threadId)
        val latest = fetchHistoryPage(threadId, "?limit=$HISTORY_PAGE_SIZE")
        // A cache that stops short of the newest page would otherwise keep a
        // hole the open screen cannot see: fill the middle as opening does.
        val recovered = if (cachedMax != null && latest.items.isNotEmpty() && latest.items.minOf { it.order } > cachedMax) {
            recoverForwardHistory(threadId, cachedMax, latest.items.maxOf { it.order }, 0)
        } else null
        if (!sessionSnapshotGuard.isCurrent(sessionTicket) || threadId == activeThreadId) return@withLock
        latest.trimmedBefore?.let { database.cache().deleteItemsBefore(threadId, it) }
        database.cache().putItems(latest.cache + (recovered?.cache ?: emptyList()))
        historyCachePrefs.edit().putLong(historyPrefetchedAtKey(threadId), startedAt).apply()
        Log.d(LOG_TAG, "history prefetched thread=$threadId latest=${latest.items.size} recovered=${recovered?.items?.size ?: 0}")
    }

    private suspend fun recoverForwardHistory(threadId: String, startAfter: Long, targetOrder: Long, baseCount: Int): DecodedHistoryPage {
        var cursor = startAfter
        val recovered = mutableListOf<HistoryItem>()
        val cache = mutableListOf<CachedItem>()
        val removed = mutableSetOf<String>()
        var hasMore = true
        var loadedPages = 0
        // A stalled cursor must not trap reconnect in an endless request loop.
        repeat(128) {
            if (!hasMore || cursor >= targetOrder) return@repeat
            val page = fetchHistoryPage(threadId, "?limit=100&after=$cursor")
            loadedPages += 1
            val forward = page.items.filter { it.order > cursor }
            if (forward.isEmpty()) {
                hasMore = false
                return@repeat
            }
            recovered += forward
            removed += page.removed
            cache += page.cache.filter { it.itemOrder > cursor }
            val nextCursor = forward.maxOf { it.order }
            if (nextCursor <= cursor) {
                hasMore = false
                return@repeat
            }
            cursor = nextCursor
            hasMore = page.hasMore
            if (activeThreadId == threadId) {
                _historyLoadState.value = _historyLoadState.value.copy(
                    threadId = threadId,
                    loading = true,
                    loadedCount = baseCount + recovered.distinctBy { it.id }.size,
                    loadedPages = loadedPages,
                    hasMore = hasMore,
                    recovering = true,
                    error = null,
                )
            }
        }
        return DecodedHistoryPage(recovered.distinctBy { it.id }.sortedBy { it.order }, cache, hasMore, removed)
    }

    suspend fun loadThread(threadId: String, before: Long? = null, mergeLatest: Boolean = false) = withContext(Dispatchers.IO) {
        if (BuildConfig.DEMO) {
            _items.value = DemoData.items(threadId)
            _historyLoadState.value = _historyLoadState.value.copy(threadId = threadId, loading = false, error = null)
            return@withContext
        }
        historyMutex.withLock {
            val loadGeneration = historyLoadGeneration
            val previousState = _historyLoadState.value
            if (activeThreadId != threadId || historyLoadGeneration != loadGeneration) return@withLock
            if (!mergeLatest) _historyLoadState.value = previousState.copy(threadId = threadId, loading = true, error = null)
            restoreTurnDuration(threadId)
            var visibleState = _historyLoadState.value
            val initialOpen = before == null && !mergeLatest
            // A fresh open (also one that falls back to the cache) reads the
            // newest page, which sets the cursor again.
            if (initialOpen) itemsCursors.remove(threadId)
            // Show what this phone already has at once (prefetch keeps it
            // current); the newest page from the relay merges in after.
            val early = if (initialOpen) readCachedHistory(threadId) else emptyList()
            if (early.isNotEmpty() && activeThreadId == threadId && historyLoadGeneration == loadGeneration) {
                _items.value = early
                reconcileDeliveredInstructions(threadId, early)
                visibleState = HistoryLoadState(threadId, loading = true, loadedCount = early.size, loadedPages = 1,
                    hasMore = historyCachePrefs.getBoolean(historyCacheHasMoreKey(threadId), early.size >= HISTORY_PAGE_SIZE))
                _historyLoadState.value = visibleState
                Log.d(LOG_TAG, "history cache displayed thread=$threadId count=${early.size}")
            }
            try {
                // A refresh of the open conversation asks only for the items
                // stored since the last look; the newest page again on every
                // update was most of a phone's history traffic (2026-11-05).
                if (mergeLatest && before == null && mergeChangedItems(threadId, loadGeneration)) return@withLock
                // On a normal conversation open, fetch the newest page first and
                // expose it immediately. Older cached rows are merged only after
                // the latest server state has had a chance to render.
                val suffix = before?.let { "?limit=$HISTORY_PAGE_SIZE&before=$it" } ?: "?limit=$HISTORY_PAGE_SIZE"
                val latestPage = try {
                    fetchHistoryPage(threadId, suffix)
                } catch (error: Exception) {
                    // A transient offline/timeout open still gets a useful local
                    // view instead of an empty conversation.
                    if (initialOpen && activeThreadId == threadId && historyLoadGeneration == loadGeneration) {
                        val fallback = early.ifEmpty { readCachedHistory(threadId) }
                        if (fallback.isNotEmpty()) {
                            val hasMore = historyCachePrefs.getBoolean(historyCacheHasMoreKey(threadId), fallback.size >= HISTORY_PAGE_SIZE)
                            _items.value = fallback
                            reconcileDeliveredInstructions(threadId, fallback)
                            visibleState = HistoryLoadState(threadId, loading = false, loadedCount = fallback.size, loadedPages = 1, hasMore = hasMore)
                            _historyLoadState.value = visibleState
                            Log.d(LOG_TAG, "history latest unavailable; cache fallback thread=$threadId count=${fallback.size}")
                            trimCache()
                            return@withLock
                        }
                    }
                    throw error
                }
                var cached = emptyList<HistoryItem>()
                if (initialOpen && early.isNotEmpty()) {
                    cached = early
                } else if (initialOpen && activeThreadId == threadId && historyLoadGeneration == loadGeneration) {
                    _items.value = latestPage.items
                    visibleState = HistoryLoadState(
                        threadId = threadId,
                        loading = true,
                        loadedCount = latestPage.items.size,
                        loadedPages = 1,
                        hasMore = latestPage.hasMore,
                        error = null,
                    )
                    _historyLoadState.value = visibleState
                    Log.d(LOG_TAG, "history latest displayed thread=$threadId count=${latestPage.items.size}")
                    // Give Compose one scheduling turn so the newest messages are
                    // visible before Room decrypts and merges older cache rows.
                    yield()
                    if (activeThreadId != threadId || historyLoadGeneration != loadGeneration) return@withLock
                    cached = readCachedHistory(threadId)
                }
                val latestPreview = if (before == null && !mergeLatest) {
                    (cached + latestPage.items).distinctBy { it.id }.size
                } else {
                    (_items.value + latestPage.items).distinctBy { it.id }.size
                }
                if (activeThreadId == threadId && before == null) {
                    _historyLoadState.value = _historyLoadState.value.copy(
                        threadId = threadId,
                        // A background refresh of the open conversation (each new
                        // message of a running turn) is not a load: showing the
                        // progress bar for it made the screen blink.
                        loading = if (mergeLatest) _historyLoadState.value.loading else true,
                        loadedCount = maxOf(_historyLoadState.value.loadedCount, latestPreview),
                        loadedPages = maxOf(_historyLoadState.value.loadedPages, 1),
                        hasMore = latestPage.hasMore,
                        error = null,
                    )
                }
                if (before == null && !mergeLatest && shouldRequestHistoryBackfill(threadId, cached, latestPage.items)) {
                    requestHistoryBackfill(threadId)
                }
                // Older history cleared on the relay leaves this phone too.
                val cut = latestPage.trimmedBefore
                if (cut != null) database.cache().deleteItemsBefore(threadId, cut)
                val base = (if (initialOpen) cached else _items.value).filterNot { it.id in latestPage.removed || (cut != null && it.order < cut) }
                val recoveredPage = if (before == null && historyNeedsForwardRecovery(base, latestPage.items)) {
                    if (activeThreadId == threadId) {
                        _historyLoadState.value = HistoryLoadState(threadId, loading = true, loadedCount = base.size, loadedPages = 1, hasMore = true, recovering = true)
                    }
                    recoverForwardHistory(threadId, base.maxOf { it.order }, latestPage.items.maxOf { it.order }, base.size)
                } else null
                if (activeThreadId != threadId || historyLoadGeneration != loadGeneration) return@withLock
                database.cache().putItems(latestPage.cache + (recoveredPage?.cache ?: emptyList()))
                if (before == null) latestPage.cursor?.let { itemsCursors[threadId] = it }
                val decoded = latestPage.items + (recoveredPage?.items ?: emptyList())
                val gone = recoveredPage?.removed.orEmpty()
                val latestMerge = if (before == null) mergeLatestHistoryPage(base.filterNot { it.id in gone }, decoded) else null
                val merged = latestMerge?.items ?: (decoded + base).distinctBy { it.id }.sortedBy { it.order }
                if (activeThreadId != threadId || historyLoadGeneration != loadGeneration) return@withLock
                _items.value = merged
                if (turnStartedAt[threadId] == null && isTurnBusyStatus(_liveStatuses.value[threadId].orEmpty())) {
                    merged.asSequence().filter { it.type == "userMessage" }.mapNotNull(::historyItemTimestamp).maxOrNull()?.let { turnStartedAt.putIfAbsent(threadId, it) }
                }
                if (initialOpen) Log.d(LOG_TAG, "history latest merged thread=$threadId latest=${latestPage.items.size} cache=${cached.size} total=${merged.size}")
                reconcileDeliveredInstructions(threadId, merged)
                val pageHasMore = latestPage.hasMore
                val hasMore = if (latestMerge?.resetToLatest == true) pageHasMore
                else if (initialOpen && cached.size >= HISTORY_CACHE_LIMIT) true
                else if (mergeLatest && previousState.threadId == threadId && previousState.loadedCount > 30)
                    previousState.hasMore else pageHasMore
                if (before == null) saveHistoryCacheState(threadId, hasMore)
                else historyCachePrefs.edit().putBoolean(historyCacheHasMoreKey(threadId), hasMore).apply()
                if (activeThreadId != threadId || historyLoadGeneration != loadGeneration) return@withLock
                _historyLoadState.value = HistoryLoadState(threadId, loading = false, loadedCount = merged.size, loadedPages = maxOf(previousState.loadedPages, 1), hasMore = hasMore, recovering = false,
                    trimmed = cut != null || (previousState.threadId == threadId && previousState.trimmed))
                trimCache()
            } catch (error: Exception) {
                if (!mergeLatest || visibleState.loadedCount > 0) {
                    val message = if (error is SocketTimeoutException || error.message.orEmpty().contains("timeout", ignoreCase = true) || error.message.orEmpty().contains("timed out", ignoreCase = true))
                        "连接超时，请稍后重试"
                    else error.message ?: "历史同步失败，保留已加载内容"
                    _historyLoadState.value = visibleState.copy(threadId = threadId, loading = false, recovering = false, error = message)
                }
                throw error
            }
        }
    }

    // Conversations whose model / mode switch was sent and has no answer yet:
    // the header shows "切换中", and the result (or a timeout) is said in a dialog.
    private val _switchingSettings = MutableStateFlow<Set<String>>(emptySet())
    val switchingSettings: StateFlow<Set<String>> = _switchingSettings
    private val settingsSwitchTimeouts = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.Job>()

    fun switchSettings(threadId: String, args: JSONObject): String {
        val requestId = command("settings.set", threadId, args)
        _switchingSettings.value = _switchingSettings.value + threadId
        settingsSwitchTimeouts.remove(threadId)?.cancel()
        settingsSwitchTimeouts[threadId] = scope.launch {
            delay(SETTINGS_SWITCH_TIMEOUT_MS)
            if (threadId in _switchingSettings.value) {
                _switchingSettings.value = _switchingSettings.value - threadId
                _message.value = "电脑还没回复切换结果，可能在等当前这一轮结束；请稍后在电脑上确认是否已经切换"
            }
        }
        return requestId
    }

    private fun finishSettingsSwitch(threadId: String) {
        settingsSwitchTimeouts.remove(threadId)?.cancel()
        _switchingSettings.value = _switchingSettings.value - threadId
    }

    fun command(action: String, threadId: String? = null, args: JSONObject = JSONObject()): String {
        val readOnlyAllowed = action in setOf("accounts.read", "capabilities", "backends.capabilities", "claude.usage", "claude.usage.refresh", "dsh.usage", "dsh.pending", "followup.list", "thread.list", "thread.read", "thread.settings.read", "thread.usage.read", "thread.ownership.read", "history.sync")
        if (usingV2() && _account.value?.canWrite != true && !readOnlyAllowed) error(readOnlyReason())
        val requestId = UUID.randomUUID().toString()
        sendCommand(requestId, action, threadId, args)
        return requestId
    }

    fun queueInstruction(threadId: String, title: String, text: String, attachments: List<AttachmentUpload> = emptyList()) {
        val value = text.trim()
        if (value.isBlank() && attachments.none { it.state == "uploaded" }) return
        sendInstructionWithOptimisticState(
            action = "followup.enqueue",
            threadId = threadId,
            title = title,
            value = value,
            attachments = attachments,
            state = "pending",
        )
    }

    fun sendInstruction(threadId: String, title: String, text: String, attachments: List<AttachmentUpload> = emptyList()) {
        val value = text.trim(); if (value.isBlank() && attachments.none { it.state == "uploaded" }) return
        // A turn short enough to end before any "running" status arrives (or one
        // whose status is missed in the background) still gets its reminder.
        markTurnStarted(threadId)
        sendInstructionWithOptimisticState(
            action = "turn.start",
            threadId = threadId,
            title = title,
            value = value,
            attachments = attachments,
            state = "sending",
        )
    }

    fun steerInstruction(threadId: String, title: String, text: String, attachments: List<AttachmentUpload> = emptyList()) {
        val value = text.trim(); if (value.isBlank() && attachments.none { it.state == "uploaded" }) return
        sendInstructionWithOptimisticState(
            action = "turn.steer",
            threadId = threadId,
            title = title,
            value = value,
            attachments = attachments,
            state = "sending",
        )
    }

    private fun sendInstructionWithOptimisticState(
        action: String,
        threadId: String,
        title: String,
        value: String,
        attachments: List<AttachmentUpload>,
        state: String,
    ) {
        // Persist the local row before sending the frame. A fast connector
        // response can otherwise arrive before the optimistic row exists,
        // leaving the message stuck in "发送中" forever.
        val requestId = UUID.randomUUID().toString()
        val attachmentsPreview = attachments.map { QueuedAttachment(it.name, it.size, it.mimeType, it.attachmentId, it.localUri) }
        synchronized(startFeedback) {
            startFeedback.register(startFeedbackKey(threadId, requestId), System.currentTimeMillis())
            persistStartFeedback()
        }
        val boundary = if (activeThreadId == threadId) queuedInstructionHistoryBoundary(
            threadId, _items.value, _historyLoadState.value, syncing = threadId in _historySyncing.value,
        ) else null
        upsertOptimisticFollowup(threadId, QueuedInstruction(requestId, value.ifBlank { "图片附件" }, System.currentTimeMillis(), state, attachments = attachmentsPreview, blocking = state != "sending", historyAfterOrder = boundary, queueRequested = action == "followup.enqueue", sentAt = System.currentTimeMillis()))
        if (state == "sending") markTurnStarted(threadId, System.currentTimeMillis())
        val args = JSONObject().put("threadId", threadId).put("title", title).put("text", value).put("attachments", attachmentJson(attachments))
        if (boundary != null) args.put("historyAfterOrder", boundary)
        try {
            sendCommand(requestId, action, threadId, args)
            if (state == "sending") {
                scheduleInstructionAckTimeout(requestId, threadId)
            }
        } catch (error: Exception) {
            if (isTransientTransportError(error)) {
                // Keep the optimistic row and pending action alive while the
                // websocket reconnects. A temporary transport gap should not
                // force the user to retype the message.
                pendingInstructionRetries += requestId
                _message.value = "电脑连接恢复后将自动重试发送"
            } else {
                pendingInstructionRetries.remove(requestId)
                pendingActions.remove(requestId)
                deletePendingAction(requestId)
                markFollowupState(threadId, requestId, "failed", error.message ?: "发送失败")
                _message.value = error.message ?: "发送失败"
            }
        }
    }

    fun loadThreadSettings(threadId: String) {
        if (!backendHasThreadSettings(_threads.value.firstOrNull { it.id == threadId }?.backend)) return
        command("thread.settings.read", threadId, JSONObject().put("threadId", threadId))
    }

    private fun usageCacheKey(threadId: String): String {
        val namespace = "${crypto.server()}|${crypto.accountId() ?: "v1"}|${targetConnectorForThread(threadId).orEmpty()}|$threadId"
        return MessageDigest.getInstance("SHA-256").digest(namespace.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    fun loadConversationUsage(threadId: String, historyFrom: Long = 0L) {
        val key = usageCacheKey(threadId)
        synchronized(tokenUsageLock) {
            if (_conversationUsage.value[threadId] == null) runCatching {
                tokenUsagePrefs.getString(key, null)?.let { cached ->
                    _conversationUsage.value += threadId to ConversationTokenUsage.fromJson(JSONObject(cached)).copy(fromCache = true)
                }
            }
            if (_connection.value != ConnectionState.Online || threadId in _usageLoading.value) return
            _usageLoading.value += threadId
        }
        scope.launch {
            try {
                val response = requestCommand("thread.usage.read", threadId,
                    JSONObject().put("threadId", threadId).put("historyFrom", historyFrom), timeoutMs = 20_000)
                check(response.optBoolean("ok")) { response.optString("error", "暂时无法读取用量") }
                val result = response.optJSONObject("result") ?: error("电脑尚未提供用量数据，请更新连接器")
                if (key == usageCacheKey(threadId)) applyConversationUsage(threadId, result)
            } catch (error: Exception) {
                if (key == usageCacheKey(threadId)) synchronized(tokenUsageLock) {
                    val old = _conversationUsage.value[threadId]
                    _conversationUsage.value += threadId to (old?.copy(fromCache = true, reason = "暂时无法更新用量，请稍后重试")
                        ?: ConversationTokenUsage(_threads.value.firstOrNull { it.id == threadId }?.backend.orEmpty(), "unavailable", reason = "暂时无法读取用量，请稍后重试"))
                }
            } finally {
                synchronized(tokenUsageLock) { _usageLoading.value -= threadId }
            }
        }
    }

    private fun applyConversationUsage(threadId: String, result: JSONObject) {
        val source = result.optString("connectorId").takeIf { it.isNotBlank() && it != "null" }
        val expected = targetConnectorForThread(threadId)
        if (source != null && expected != null && source != expected) return
        val next = ConversationTokenUsage.fromJson(result)
        synchronized(tokenUsageLock) {
            val old = _conversationUsage.value[threadId]
            val merged = mergeConversationUsage(old, next)
            _conversationUsage.value = (_conversationUsage.value + (threadId to merged)).entries.toList().takeLast(100).associate { it.toPair() }
            if (next.status == "ready" && merged.updatedAt == next.updatedAt && merged.usageUpdatedAt == next.usageUpdatedAt) {
                val key = usageCacheKey(threadId)
                val cached = JSONObject(result.toString()).put("completedTurns", org.json.JSONArray().apply {
                    merged.completedTurns.forEach { put(JSONObject(it.toFields())) }
                })
                val edit = tokenUsagePrefs.edit().putString(key, cached.toString())
                // Small metadata only, bounded independently of chat history.
                tokenUsagePrefs.all.keys.filter { it != key }.dropLast(59).forEach(edit::remove)
                edit.apply()
            }
        }
    }

    private fun attachmentJson(items: List<AttachmentUpload>): org.json.JSONArray {
        val result = org.json.JSONArray()
        items.filter { it.state == "uploaded" && (!it.path.isNullOrBlank() || !it.attachmentId.isNullOrBlank()) }.forEach { item ->
            result.put(JSONObject().put("name", item.name).put("path", item.path).put("attachmentId", item.attachmentId).put("size", item.size).put("mimeType", item.mimeType))
        }
        return result
    }

    private fun queuedAttachments(items: org.json.JSONArray?): List<QueuedAttachment> {
        if (items == null) return emptyList()
        val result = mutableListOf<QueuedAttachment>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            result += QueuedAttachment(
                name = item.optString("name", "附件"),
                size = item.optLong("size"),
                mimeType = item.optString("mimeType").takeIf { it.isNotBlank() && it != "null" },
                attachmentId = item.optString("attachmentId").takeIf { it.isNotBlank() && it != "null" },
                localUri = item.optString("localUri").takeIf { it.isNotBlank() && it != "null" },
            )
        }
        return result
    }

    fun removeQueuedInstruction(threadId: String, instructionId: String) {
        command("followup.cancel", threadId, JSONObject().put("threadId", threadId).put("id", instructionId))
    }

    fun steerQueuedInstruction(threadId: String, instructionId: String) {
        command("followup.steer", threadId, JSONObject().put("threadId", threadId).put("id", instructionId))
    }

    fun steerQueuedInstructions(threadId: String, instructionIds: List<String>) {
        if (instructionIds.isEmpty()) return
        val ids = org.json.JSONArray().also { instructionIds.forEach(it::put) }
        command("followup.steer_all", threadId, JSONObject().put("threadId", threadId).put("ids", ids))
    }

    private fun sendCommand(requestId: String, action: String, threadId: String?, args: JSONObject) {
        val pending = PendingAction(action, threadId, JSONObject(args.toString()))
        pendingActions[requestId] = pending
        persistPendingAction(requestId, pending)
        sendPendingAction(requestId, pending)
    }

    private fun sendPendingAction(requestId: String, pending: PendingAction) {
        val claude = pending.args.optString("backend") == "claude" || _threads.value.any { it.id == pending.threadId && it.backend == "claude" }
        val writes = pending.action.startsWith("turn.") || pending.action.startsWith("followup.") && pending.action != "followup.list" || pending.action in setOf("thread.new", "thread.newWithTurn", "thread.settings.set")
        if (claude && writes) {
            check(_claudeConsent.value.enabled) { "请先确认开启 Claude 远程控制" }
            check(_agentAccounts.value["claude"]?.switching != true) { "电脑正在切换 Claude 账号，请稍后发送" }
        }
        val controlled = pending.action.startsWith("turn.") || pending.action in setOf("thread.compact", "thread.fork", "thread.rollback", "thread.archive", "thread.rename", "thread.pin")
        val kind = if (pending.action.startsWith("file.")) "file.command" else if (controlled) "command.control" else "command"
        sendFrame(kind, pending.threadId, JSONObject().put("requestId", requestId).put("action", pending.action).put("args", pending.args))
    }

    private fun retryPendingInstructionActions() {
        val now = System.currentTimeMillis()
        pendingActions.entries
            .filter { pendingInstructionRetries.contains(it.key) }
            .filter { it.value.action in setOf("turn.start", "turn.steer", "followup.enqueue") }
            .filter { now - (pendingInstructionRetryAt[it.key] ?: 0L) >= 1_000L }
            .forEach { (requestId, pending) ->
                pendingInstructionRetryAt[requestId] = now
                runCatching { sendPendingAction(requestId, pending) }
                    .onSuccess {
                        pendingInstructionRetries.remove(requestId)
                        pendingInstructionRetryAt.remove(requestId)
                        if (pending.action in setOf("turn.start", "turn.steer")) {
                            pending.threadId?.let { scheduleInstructionAckTimeout(requestId, it) }
                        }
                    }
                    .onFailure { pendingInstructionRetryAt.remove(requestId) }
            }
    }

    private fun acknowledgePendingInstruction(requestId: String) {
        val pending = pendingActions[requestId] ?: return
        if (pending.action !in setOf("turn.start", "turn.steer", "followup.enqueue")) return
        pendingInstructionRetries.remove(requestId)
        pendingInstructionRetryAt.remove(requestId)
        pendingInstructionTimeouts.remove(requestId)?.cancel()
        pendingActions.remove(requestId)
        deletePendingAction(requestId)
    }

    private fun scheduleInstructionAckTimeout(requestId: String, threadId: String) {
        pendingInstructionTimeouts.remove(requestId)?.cancel()
        pendingInstructionTimeouts[requestId] = scope.launch {
            val antigravity = _threads.value.firstOrNull { it.id == threadId }?.backend == "antigravity"
            delay(if (antigravity) 90_000L else SEND_ACK_TIMEOUT_MS)
            pendingInstructionTimeouts.remove(requestId)
            // A disconnected socket keeps the optimistic row pending; the
            // next connector.online event will retry it instead of failing it.
            if (pendingInstructionRetries.contains(requestId)) return@launch
            val pending = pendingActions.remove(requestId)
            if (pending != null) {
                deletePendingAction(requestId)
                val state = instructionAckTimeoutState(pending.action)
                val reason = if (state == "uncertain") "发送回执尚未确认，正在核对对话；请勿重复发送" else "电脑端响应超时"
                markFollowupState(threadId, requestId, state, reason)
                notifyFollowupFailure(threadId, requestId, reason)
            }
        }
    }

    private fun markPendingInstructionRetries() {
        pendingActions.entries
            .filter { it.value.action in setOf("turn.start", "turn.steer", "followup.enqueue") }
            .forEach {
                pendingInstructionRetries += it.key
                pendingInstructionRetryAt.remove(it.key)
            }
    }

    private fun isTransientTransportError(error: Throwable): Boolean {
        val message = error.message.orEmpty()
        return message.contains("连接当前不可用", true) ||
            message.contains("连接已中断", true) ||
            message.contains("socket", true) ||
            message.contains("websocket", true)
    }

    /** The command's own result; throws with the computer's error when it failed. */
    private fun commandResult(response: JSONObject): JSONObject {
        check(response.optBoolean("ok", true)) { response.optString("error").takeIf { it.isNotBlank() && it != "null" } ?: "电脑端没能处理" }
        return response.optJSONObject("result") ?: response
    }

    private suspend fun requestCommand(action: String, threadId: String?, args: JSONObject, timeoutMs: Long = 60_000): JSONObject {
        val id = UUID.randomUUID().toString(); val deferred = CompletableDeferred<JSONObject>(); pendingRequests[id] = deferred
        // withTimeoutOrNull, not catching the timeout: an outer timeout or a
        // cancellation still has to cancel the caller.
        try { sendCommand(id, action, threadId, args); return withTimeoutOrNull(timeoutMs) { deferred.await() } ?: throw CommandTimeoutException(timeoutMs) }
        finally { pendingRequests.remove(id); pendingActions.remove(id) }
    }

    private fun failPendingRequests(reason: String) {
        val failure = IOException(reason.ifBlank { "连接已中断" })
        pendingRequests.entries.forEach { (id, deferred) ->
            if (pendingRequests.remove(id, deferred)) {
                pendingActions.remove(id)
                deferred.completeExceptionally(failure)
            }
        }
    }

    // Images a Claude tool returned, fetched from the computer when asked for
    // and kept for this app session (a few screenshots, not the whole history).
    private val claudeImages = object : LinkedHashMap<String, HistoryImage>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, HistoryImage>) = size > 24
    }

    fun cachedClaudeImage(threadId: String, ref: String): HistoryImage? = synchronized(claudeImages) { claudeImages["$threadId|$ref"] }

    suspend fun loadClaudeImage(threadId: String, ref: HistoryImageRef): HistoryImage = withContext(Dispatchers.IO) {
        cachedClaudeImage(threadId, ref.ref)?.let { return@withContext it }
        val bytes = java.io.ByteArrayOutputStream()
        var offset = 0L; var mimeType = ref.mimeType
        do {
            val response = requestCommand("claude.image", threadId,
                JSONObject().put("threadId", threadId).put("ref", ref.ref).put("offset", offset).put("size", 512 * 1024))
            check(response.optBoolean("ok")) { response.optString("error", "图片加载失败") }
            val result = commandResult(response)
            val chunk = Base64.decode(result.getString("data"), Base64.DEFAULT)
            bytes.write(chunk); offset += chunk.size
            mimeType = result.optString("mimeType", mimeType)
            val done = result.optBoolean("eof") || chunk.isEmpty()
        } while (!done)
        val image = HistoryImage("data:$mimeType;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP), mimeType)
        synchronized(claudeImages) { claudeImages["$threadId|${ref.ref}"] = image }
        image
    }

    fun listFiles(path: String = "") { runCatching { command("file.list", null, JSONObject().put("path", path).put("limit", 100)) }.onFailure { _message.value = it.message } }

    /**
     * A computer file a reply links to, fetched only when asked for and kept
     * in the app's files until deleted on the 电脑取回的文件 page, so the phone
     * can open it again without fetching. Several chunks are in flight at once,
     * so the transfer isn't held up by each round trip to the computer.
     * Progress is (received, total).
     */
    suspend fun fetchComputerFile(path: String, progress: (Long, Long) -> Unit = { _, _ -> }): File = withContext(Dispatchers.IO) {
        val name = computerFileName(path).ifBlank { "file" }
        // One folder per source path, so two files with the same name do not collide.
        val folder = File(fetchedRoot(), Integer.toHexString(path.lowercase().hashCode())).apply { mkdirs() }
        val target = File(folder, name); val partial = File(folder, "$name.part")
        partial.delete()
        val first = readComputerChunk(path, 0)
        val total = first.total
        var received = first.bytes.size.toLong()
        java.io.RandomAccessFile(partial, "rw").use { output ->
            output.write(first.bytes); progress(received, total)
            val step = first.bytes.size.toLong()
            if (!first.eof && step > 0) {
                val lock = kotlinx.coroutines.sync.Mutex(); val gate = kotlinx.coroutines.sync.Semaphore(FETCH_PARALLEL)
                kotlinx.coroutines.coroutineScope {
                    (step until total step step).map { offset ->
                        async {
                            gate.withPermit {
                                val chunk = readComputerChunk(path, offset)
                                check(chunk.total == total) { "文件在取回过程中被修改了，请重试" }
                                lock.withLock { output.seek(offset); output.write(chunk.bytes); received += chunk.bytes.size; progress(received, total) }
                            }
                        }
                    }.awaitAll()
                }
            }
        }
        // An older copy of this source (fetched under another name) gives way to the new one.
        folder.listFiles()?.filter { it != partial }?.forEach { it.delete() }
        check(partial.renameTo(target)) { "保存文件失败" }
        File(folder, FETCHED_META).writeText(JSONObject().put("path", path).put("name", name).put("fetchedAt", System.currentTimeMillis()).toString())
        target
    }

    private class ComputerChunk(val bytes: ByteArray, val total: Long, val eof: Boolean)

    // Asks for the chunk as binary (sent beside the JSON, base64-encoded once);
    // a connector from before 0.2.56 ignores that and sends base64 data inside it.
    private suspend fun readComputerChunk(path: String, offset: Long): ComputerChunk {
        val response = requestCommand("file.read", null, JSONObject().put("path", path).put("offset", offset).put("size", FETCH_CHUNK).put("binary", true), FETCH_CHUNK_TIMEOUT_MS)
        val result = commandResult(response)
        val bytes = response.opt(FILE_BLOB_FIELD) as? ByteArray ?: Base64.decode(result.optString("data"), Base64.DEFAULT)
        return ComputerChunk(bytes, result.optLong("total", offset + bytes.size), result.optBoolean("eof") || bytes.isEmpty())
    }

    private fun fetchedRoot() = File(context.filesDir, "fetched")

    /** Files fetched from the computer, newest first. */
    fun fetchedFiles(): List<FetchedFile> = fetchedRoot().listFiles().orEmpty().mapNotNull { folder ->
        val meta = runCatching { JSONObject(File(folder, FETCHED_META).readText()) }.getOrNull() ?: return@mapNotNull null
        val file = File(folder, meta.optString("name")).takeIf { it.isFile } ?: return@mapNotNull null
        FetchedFile(file, meta.optString("path"), meta.optLong("fetchedAt", file.lastModified()))
    }.sortedByDescending { it.fetchedAt }

    fun deleteFetched(file: File) { file.parentFile?.takeIf { it.parentFile == fetchedRoot() }?.deleteRecursively() }

    fun clearFetched() {
        fetchedRoot().deleteRecursively()
        // Files opened before 0.1.209 were kept in the cache.
        File(context.cacheDir, "opened").deleteRecursively()
    }

    suspend fun download(path: String) = withContext(Dispatchers.IO) {
        val directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
        val target = uniqueFile(directory, computerFileName(path)); FileOutputStream(target).use { output ->
            var offset = 0L
            do {
                val chunk = readComputerChunk(path, offset)
                output.write(chunk.bytes); offset += chunk.bytes.size
            } while (!chunk.eof)
        }
        _message.value = "已下载到 ${target.absolutePath}"
    }

    /**
     * A picked photo is shrunk before upload (long edge 2048 px, JPEG), so it
     * stays well under Claude's per-image limit and uploads quickly over the
     * relay. Falls back to the original file when it cannot be decoded.
     */
    suspend fun compressImage(uri: Uri): Uri = withContext(Dispatchers.IO) {
        runCatching {
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.contentResolver.openInputStream(uri).use { android.graphics.BitmapFactory.decodeStream(it, null, bounds) }
            val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
            require(longEdge > 0)
            var sample = 1; while (longEdge / (sample * 2) >= 2048) sample *= 2
            val decoded = context.contentResolver.openInputStream(uri).use {
                android.graphics.BitmapFactory.decodeStream(it, null, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
            } ?: error("decode failed")
            val rotation = context.contentResolver.openInputStream(uri).use { input ->
                when (androidx.exifinterface.media.ExifInterface(requireNotNull(input)).getAttributeInt(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION, 1)) {
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                    else -> 0f
                }
            }
            val scale = minOf(1f, 2048f / maxOf(decoded.width, decoded.height))
            val matrix = android.graphics.Matrix().apply { postScale(scale, scale); postRotate(rotation) }
            val bitmap = if (scale < 1f || rotation != 0f) android.graphics.Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true) else decoded
            val dir = java.io.File(context.cacheDir, "upload-images").apply { mkdirs() }
            dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000L }?.forEach { it.delete() }
            val out = java.io.File(dir, "image-" + java.text.SimpleDateFormat("MMdd-HHmmss", java.util.Locale.US).format(java.util.Date()) + "-" + UUID.randomUUID().toString().take(4) + ".jpg")
            out.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, it) }
            Uri.fromFile(out)
        }.getOrElse { uri }
    }

    suspend fun upload(uri: Uri, threadId: String) = withContext(Dispatchers.IO) {
        val metadata = if (uri.scheme == "file") uri.path?.let { java.io.File(it) }?.let { it.name to it.length() } ?: ("attachment.bin" to 0L)
        else context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) to if (cursor.isNull(1)) 0L else cursor.getLong(1) else null
        } ?: ("attachment.bin" to 0L)
        val name = metadata.first.ifBlank { "attachment.bin" }
        val mimeType = if (uri.scheme == "file" && name.endsWith(".jpg")) "image/jpeg" else context.contentResolver.getType(uri)
        require(metadata.second <= MAX_ATTACHMENT_BYTES) { "附件超过 25 MB 限制" }
        val id = UUID.randomUUID().toString()
        Log.i(LOG_TAG, "attachment upload start name=$name size=${metadata.second} thread=$threadId")
        updateAttachment(threadId, AttachmentUpload(id, name, uri.toString(), size = metadata.second, mimeType = mimeType, state = "uploading"))
        try {
            withTimeout(UPLOAD_OPERATION_TIMEOUT_MS) {
                var lastError: Exception? = null
                repeat(2) { attempt ->
                    val uploadId = UUID.randomUUID().toString()
                    try {
                        val begun = requestCommand("file.upload.begin", threadId, JSONObject().put("uploadId", uploadId)
                            .put("threadId", threadId).put("name", name).put("mimeType", mimeType), 20_000)
                        Log.i(LOG_TAG, "attachment upload session accepted thread=$threadId")
                        check(begun.optBoolean("ok")) { begun.optString("error", "上传失败") }
                        check(begun.getJSONObject("result").getString("uploadId") == uploadId) { "上传会话不匹配" }
                        var offset = 0L
                        context.contentResolver.openInputStream(uri).use { input ->
                            requireNotNull(input)
                            val buffer = ByteArray(UPLOAD_CHUNK_BYTES)
                            while (true) {
                                var count = try {
                                    withTimeout(UPLOAD_READ_TIMEOUT_MS) { input.read(buffer) }
                                } catch (timeout: TimeoutCancellationException) {
                                    throw IOException("读取附件超时", timeout)
                                }
                                // Some vendor ContentProviders legally return 0
                                // without EOF. Fall back to a one-byte read so a
                                // provider cannot leave the UI in “上传中” forever.
                                if (count == 0) {
                                    val single = try {
                                        withTimeout(UPLOAD_READ_TIMEOUT_MS) { input.read() }
                                    } catch (timeout: TimeoutCancellationException) {
                                        throw IOException("读取附件超时", timeout)
                                    }
                                    if (single < 0) break
                                    buffer[0] = single.toByte(); count = 1
                                }
                                if (count < 0) break
                                val data = Base64.encodeToString(buffer.copyOf(count), Base64.NO_WRAP)
                                val chunk = requestCommand("file.upload.chunk", threadId,
                                    JSONObject().put("uploadId", uploadId).put("offset", offset).put("data", data), 20_000)
                                check(chunk.optBoolean("ok")) { chunk.optString("error", "上传失败") }
                                offset += count
                            }
                        }
                        check(offset > 0) { "附件内容为空" }
                        val done = requestCommand("file.upload.finish", threadId, JSONObject().put("uploadId", uploadId).put("omitLocalPath", true), 20_000)
                        check(done.optBoolean("ok")) { done.optString("error", "上传失败") }
                        val result = done.optJSONObject("result") ?: JSONObject()
                        updateAttachment(threadId, AttachmentUpload(
                            id = id,
                            name = name,
                            localUri = uri.toString(),
                            path = result.optString("path").takeIf { it.isNotBlank() },
                            size = result.optLong("size", metadata.second),
                            mimeType = mimeType,
                            state = "uploaded",
                            attachmentId = result.optString("attachmentId").takeIf { it.isNotBlank() },
                        ))
                        Log.i(LOG_TAG, "attachment upload complete name=$name size=${result.optLong("size", metadata.second)}")
                        return@withTimeout
                    } catch (error: Exception) {
                        lastError = error
                        if (attempt == 0 && isRetryableTransferFailure(error)) {
                            runCatching { requestCommand("file.upload.abort", threadId, JSONObject().put("uploadId", uploadId), 10_000) }
                            reconnectForTransfer()
                        } else {
                            if (relayConnected && _connection.value == ConnectionState.Online) {
                                runCatching { requestCommand("file.upload.abort", threadId, JSONObject().put("uploadId", uploadId), 5_000) }
                            }
                            throw error
                        }
                    }
                }
                throw lastError ?: IOException("上传失败")
            }
        } catch (error: Exception) {
            Log.e(LOG_TAG, "attachment upload failed name=$name", error)
            updateAttachment(threadId, AttachmentUpload(id, name, uri.toString(), size = metadata.second, mimeType = mimeType, state = "failed", error = userFacingUiError(error, "上传失败")))
            throw error
        }
    }

    private suspend fun waitForConnectorOnline() {
        withTimeout(30_000) {
            while (!relayConnected || _connection.value != ConnectionState.Online) delay(250)
        }
    }

    private suspend fun reconnectForTransfer() {
        val staleSocket = socket
        socket = null
        relayConnected = false
        connectorWatchdogJob?.cancel()
        _connection.value = ConnectionState.Offline
        staleSocket?.cancel()
        connect()
        waitForConnectorOnline()
    }

    fun removeAttachment(threadId: String, id: String) {
        val remaining = _attachments.value[threadId].orEmpty().filterNot { it.id == id }
        _attachments.value = if (remaining.isEmpty()) _attachments.value - threadId else _attachments.value + (threadId to remaining)
    }

    fun clearAttachments(threadId: String) {
        _attachments.value = _attachments.value - threadId
    }

    suspend fun loadDraft(threadId: String): String = withContext(Dispatchers.IO) {
        draftMutex.withLock {
            val row = database.cache().draft(threadId) ?: return@withLock ""
            runCatching {
                crypto.decrypt("draft", threadId, threadId, row.nonce, row.ciphertext).optString("text")
            }.getOrDefault("")
        }
    }

    fun saveDraft(threadId: String, text: String) {
        val version = draftVersions.computeIfAbsent(threadId) { AtomicLong() }.incrementAndGet()
        scope.launch {
            draftMutex.withLock {
                if (draftVersions[threadId]?.get() != version) return@withLock
                runCatching {
                    if (text.isEmpty()) {
                        database.cache().deleteDraft(threadId)
                    } else {
                        val encrypted = crypto.encrypt("draft", threadId, threadId, JSONObject().put("text", text))
                        database.cache().putDraft(DraftEntry(threadId, encrypted.first, encrypted.second, System.currentTimeMillis()))
                    }
                }.onFailure { Log.w(LOG_TAG, "draft persistence failed", it) }
            }
        }
    }

    fun clearDraft(threadId: String) = saveDraft(threadId, "")

    private fun updateAttachment(threadId: String, item: AttachmentUpload) {
        val current = _attachments.value[threadId].orEmpty().filterNot { it.id == item.id } + item
        _attachments.value = _attachments.value + (threadId to current)
    }

    suspend fun refreshDevices() = withContext(Dispatchers.IO) {
        val sessionTicket = sessionSnapshotGuard.capture()
        val v2 = usingV2()
        val response = if (v2) get("/api/v2/account") else get("/api/v1/devices")
        val rows = response.getJSONArray(if (v2) "devices" else "items"); val result = mutableListOf<DeviceEntry>()
        for (i in 0 until rows.length()) rows.getJSONObject(i).let { result += DeviceEntry(it.getString("id"), it.getString("name"), it.getString("type"), !it.isNull("revokedAt")) }
        sessionSnapshotGuard.publish(sessionTicket) { _devices.value = result; ensureSelectedConnector(result) }
        Unit
    }

    fun currentDeviceId(): String = crypto.deviceId()

    suspend fun revokeDevice(id: String) = withContext(Dispatchers.IO) {
        if (directMode()) { check(id == crypto.deviceId()) { "直连设备请在电脑端断开" }; disconnect(); return@withContext }
        val path = if (usingV2()) "/api/v2/devices/revoke" else "/api/v1/devices/revoke"
        post("${serverUrl()}$path", JSONObject().put("deviceId", id), token()); refreshDevices(); if (usingV2()) refreshAccount()
    }

    suspend fun refreshAccount() = withContext(Dispatchers.IO) {
        if (BuildConfig.DEMO) return@withContext
        val sessionTicket = sessionSnapshotGuard.capture()
        if (!usingV2()) return@withContext
        val response = get("/api/v2/account")
        val profile = response.optJSONObject("profile") ?: JSONObject()
        val entitlements = response.optJSONArray("entitlements")
        val memberships = mutableListOf<MembershipEntry>()
        if (entitlements != null) for (i in 0 until entitlements.length()) entitlements.getJSONObject(i).let { item ->
            memberships += MembershipEntry(item.optString("product"), item.optString("state"),
                item.optString("plan").takeIf(String::isNotBlank), item.optLong("expiresAt").takeIf { value -> value > 0 })
        }
        val devices = response.optJSONArray("devices"); val deviceEntries = mutableListOf<DeviceEntry>()
        if (devices != null) for (i in 0 until devices.length()) devices.getJSONObject(i).let { item ->
            deviceEntries += DeviceEntry(item.getString("id"), item.getString("name"), item.getString("type"), !item.isNull("revokedAt"))
        }
        val effective = response.optJSONObject("effectiveEntitlement") ?: JSONObject()
        sessionSnapshotGuard.publish(sessionTicket) {
            _devices.value = deviceEntries
            ensureSelectedConnector(deviceEntries)
            _account.value = AccountUiState(profile.optString("displayName").ifBlank { "khLink 用户" },
                profile.optString("avatarUrl").takeIf(String::isNotBlank), profile.optString("khQuantSubject"),
                memberships, effective.optString("source", "none"), effective.optBoolean("canWrite"), deviceEntries,
                parseTrafficUsage(effective.optJSONObject("traffic")))
        }
        noteTrafficThresholds(effective.optString("source", "none"), parseTrafficUsage(effective.optJSONObject("traffic")))
        Unit
    }

    /** Tells a free account once a month at 80% and again when its allowance is used up. */
    private fun noteTrafficThresholds(source: String, traffic: TrafficUsage?) {
        if (source != "free" || traffic == null || !traffic.free || traffic.month.isBlank()) return
        val level = when { traffic.exhausted -> 100; traffic.fraction >= 0.8f -> 80; else -> return }
        val key = "traffic_notice_${traffic.month}"
        if (displayPrefs.getInt(key, 0) >= level) return
        displayPrefs.edit().putInt(key, level).apply()
        _message.value = if (level == 100) "本月免费流量（${formatTraffic(traffic.limitBytes)}）已用完，远程操作暂停到下月 1 日；直连和自建服务器不受影响"
            else "本月免费流量已用 ${formatTraffic(traffic.usedBytes)}，共 ${formatTraffic(traffic.limitBytes)}；用完后远程操作暂停到下月 1 日"
    }

    /** Why remote actions are read-only: a used-up free month, or no membership. */
    private fun readOnlyReason(): String = if (_account.value?.traffic?.exhausted == true && _account.value?.effectiveSource == "free")
        "本月免费流量已用完，远程操作暂停到下月 1 日。扫码直连不计流量，可以改用直连"
        else "账户当前不能远程操作，已切换为只读。可以在“我 → 流量说明”查看原因，或改用扫码直连"

    private fun ensureSelectedConnector(items: List<DeviceEntry>) {
        val connectors = items.filter { !it.revoked && it.type.equals("connector", true) }
        if (connectors.isEmpty()) return
        val current = _selectedConnectorId.value
        if (current.isNullOrBlank() || connectors.none { it.id == current }) {
            val next = connectors.first().id
            crypto.saveSelectedConnectorId(next)
            _selectedConnectorId.value = next
            _agentOpenStates.value = agentSnapshots[next]?.second.orEmpty()
        }
    }

    private fun resetSessionView() {
        watchThread(null)
        sessionSnapshotGuard.invalidate {
            _threads.value = emptyList(); _items.value = emptyList(); _historyLoadState.value = HistoryLoadState()
            _liveStatuses.value = emptyMap(); _queuedInstructions.value = emptyMap(); _historySyncing.value = emptySet()
            _threadOwners.value = emptyMap(); _connectorSeenAt.value = emptyMap(); _selectedConnectorId.value = null
            _approval.value = null; _claudeUsage.value = null; _dshUsage.value = null; _pcLoad.value = null; _account.value = null
            _agentAccounts.value = emptyMap(); _accountReadErrors.value = emptyMap(); _accountsAvailable.value = false; _accountRequestPending.value = false
            _agentOpenStates.value = emptyMap(); _agentOpenStatesByConnector.value = emptyMap(); _agentInstalledByConnector.value = emptyMap(); agentSnapshots.clear()
            _dshCatalog.value = null; _hermesCatalog.value = null; _dshPending.value = null; _dshPendingLoading.value = false
            _claudeModels.value = emptyList(); _threadSettings.value = emptyMap(); _turnDurations.value = emptyMap()
            _lightDetails.value = emptyMap(); _lightFetching.value = emptySet(); lightDetailsThread = null
            _attachments.value = emptyMap(); _usageLoading.value = emptySet(); _devices.value = emptyList()
            _files.value = emptyList(); _filePath.value = ""; _createdThreadId.value = null; _claudeWorkspaceTrust.value = null
            waitingSeenAt.clear(); lightModeSentAt.clear()
            _capabilities.value = CapabilityState(); threadsCursor = null; itemsCursors.clear(); lastSequence = 0L
            pendingActions.clear(); pendingInstructionRetries.clear(); pendingInstructionRetryAt.clear()
            pendingInstructionTimeouts.values.forEach { it.cancel() }; pendingInstructionTimeouts.clear()
            pendingRequests.values.forEach { it.cancel() }; pendingRequests.clear()
            historyBackfillRequestedAt.clear()
            pendingTurnEnds.values.forEach { it.second.cancel() }; pendingTurnEnds.clear()
            liveStatusUpdatedAt.clear(); liveAbsentSince.clear(); turnStartedAt.clear(); turnStartedTurnId.clear()
            lastCompletedTurnId.clear(); silentlyEnded.clear(); threadSettingsUpdatedAt.clear()
        }
        synchronized(tokenUsageLock) {
            _conversationUsage.value = emptyMap()
            _codexQuestionStates.value = emptyMap(); _codexQuestion.value = null
        }
        desktopCodexPins.clear()
        desktopCodexPinsAt.clear()
        desktopClaudePins.clear()
        desktopClaudePinsAt.clear()
        desktopPinOwnershipRefresh?.cancel()
        desktopPinOwnershipRefresh = null
        historyCachePrefs.edit().remove(FULL_THREAD_SYNC_DONE_KEY).apply()
    }

    fun logout() {
        resetSessionView()
        synchronized(tokenUsageLock) { tokenUsagePrefs.edit().clear().apply() }
        disconnect()
        crypto.clearSession()
        crypto.saveSequence(0L)
        refreshAgentConnectorIds()
        _account.value = null
        _pairingLogin.value = PairingLoginState.Idle
    }

    suspend fun changePassword(password: CharArray) = withContext(Dispatchers.IO) {
        val salt = ByteArray(16).also(java.security.SecureRandom()::nextBytes); val iterations = 310_000
        val verifier = crypto.derive(password, salt, iterations); password.fill('\u0000'); val envelope = crypto.wrapAccountKey(verifier)
        post("${serverUrl()}/api/v1/auth/change-password", JSONObject().put("salt", CryptoStore.b64(salt))
            .put("verifier", CryptoStore.b64(verifier)).put("iterations", iterations)
            .put("keyEnvelope", JSONObject().put("nonce", envelope.first).put("ciphertext", envelope.second)), token())
        _message.value = "密码已修改，历史主密钥保持不变"
    }

    fun resolveApproval(accept: Boolean, expectedRpcId: String? = null, expectedThreadId: String? = null, forSession: Boolean = false) {
        val value = _approval.value ?: return
        if (value.submitting) return
        if ((expectedRpcId != null && value.rpcId != expectedRpcId) ||
            (expectedThreadId != null && value.threadId != expectedThreadId) ||
            (value.expiresAt > 0 && value.expiresAt < System.currentTimeMillis())) {
            _message.value = "这个审批请求已过期或已由其他设备处理"
            _approval.value = null
            return
        }
        val decision = when { !accept -> "decline"; forSession -> "acceptForSession"; else -> "accept" }
        submitApproval(value, JSONObject().put("rpcId", value.rpcId).put("requestId", value.rpcId).put("threadId", value.threadId).put("decision", decision))
    }

    fun resolveApproval(answers: Map<String, UserInputAnswer>) {
        val value = _approval.value ?: return
        resolveApproval(answers, value.rpcId, value.threadId)
    }

    fun resolveApproval(answers: Map<String, UserInputAnswer>, expectedRpcId: String?, expectedThreadId: String?) {
        val value = _approval.value ?: return
        if (value.submitting) return
        if ((expectedRpcId != null && value.rpcId != expectedRpcId) ||
            (expectedThreadId != null && value.threadId != expectedThreadId)) {
            _message.value = "这个审批请求已过期或已由其他设备处理"
            return
        }
        val mapped = JSONObject()
        answers.forEach { (question, answer) ->
            val selected = org.json.JSONArray()
            answer.selected.forEach(selected::put)
            mapped.put(question, JSONObject().put("selected", selected).put("customText", answer.customText))
        }
        submitApproval(value, JSONObject().put("rpcId", value.rpcId).put("requestId", value.rpcId).put("threadId", value.threadId)
            .put("semanticAnswer", JSONObject().put("answers", mapped)))
    }

    private fun submitApproval(value: ApprovalRequest, payload: JSONObject) {
        _approval.value = value.copy(submitting = true)
        runCatching { sendFrame("approval.resolve", value.threadId, payload) }.onFailure {
            if (_approval.value?.rpcId == value.rpcId && _approval.value?.threadId == value.threadId) _approval.value = value
            _message.value = it.message ?: "电脑连接当前不可用，回答尚未提交"
            return
        }
        // Keep the question and selection until the original server confirms.
        // Sending an encrypted frame does not prove the tool accepted a reply.
        scope.launch {
            delay(15_000)
            val current = _approval.value
            if (current?.rpcId == value.rpcId && current.threadId == value.threadId && current.submitting) {
                _approval.value = current.copy(submitting = false)
                _message.value = "电脑端尚未确认回答，请检查连接后重试；已保留选择"
            }
        }
    }

    private fun sendFrame(kind: String, threadId: String?, payload: JSONObject, target: String? = targetConnectorForThread(threadId)) {
        val id = UUID.randomUUID().toString(); val encrypted = crypto.encrypt(kind, threadId, id, payload)
        val frame = JSONObject().put("id", id).put("kind", kind).put("threadId", threadId)
            .put("nonce", encrypted.first).put("ciphertext", encrypted.second).put("createdAt", System.currentTimeMillis())
        target?.let { frame.put("targetDeviceId", it) }
        val sent = if (directMode()) directPeer?.send(frame.toString()) else socket?.send(frame.toString())
        check(sent == true) { "电脑连接当前不可用" }
    }

    private fun targetConnectorForThread(threadId: String?): String? =
        threadId?.let { id -> _threads.value.firstOrNull { it.id == id }?.connectorId?.takeIf(String::isNotBlank) }
            ?: _selectedConnectorId.value?.takeIf(String::isNotBlank)

    private inner class Listener : WebSocketListener() {
        private val replayBuffer = OrderedReplayBuffer<JSONObject>()
        private val readySequence = CompletableDeferred<Long?>()
        private val sessionTicket = sessionSnapshotGuard.capture()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (socket !== webSocket) return
            Log.i(LOG_TAG, "websocket open")
            connectWatchdogJob?.cancel(); connectWatchdogJob = null
            socketStartedAt = 0L
            relayConnected = true
            val openedAt = System.currentTimeMillis()
            connectorHeartbeatAt = openedAt
            connectorConnectedAt = openedAt
            reconnectAttempt = 0
            // Relay authentication only proves that the phone reached the
            // server. The computer is online only after connector.online or a
            // connector.presence frame arrives.
            _connection.value = ConnectionState.Connecting
            _statusText.value = "正在同步电脑"
            startConnectorWatchdog()
            scope.launch {
                restorePendingCommands()
                // Buffer durable live frames until all older pages have been
                // replayed. Presence and other ephemeral frames stay live.
                val snapshotSequence = withTimeoutOrNull(3_000L) { readySequence.await() }
                if (socket !== webSocket || !sessionSnapshotGuard.isCurrent(sessionTicket)) return@launch
                val failures = mutableListOf<Throwable>()
                try {
                    val current = sessionSnapshotGuard.publish(sessionTicket) {
                        if (socket === webSocket && snapshotSequence != null && snapshotSequence < lastSequence) {
                            // A restored relay database can legitimately rewind its
                            // sequence. Start again rather than dropping all events.
                            lastSequence = 0L; crypto.saveSequence(0L)
                        }
                    }
                    if (!current || socket !== webSocket) return@launch
                    replayEvents(snapshotSequence, replayBuffer, webSocket) { applyCurrentFrame(webSocket, it, "replay") }
                    if (!replayBuffer.finish { applyCurrentFrame(webSocket, it, "websocket") }) return@launch
                } catch (error: Exception) {
                    replayBuffer.abort()
                    if (socket === webSocket) {
                        Log.w(LOG_TAG, "event replay interrupted; reconnecting", error)
                        webSocket.cancel()
                    }
                    return@launch
                }
                // A page a light refresh can't reach (e.g. an old pinned
                // thread on a new device) would otherwise never surface at
                // all. Page through the full history once per install; every
                // later reconnect stays on the cheap single-page refresh.
                val needsFullSync = !historyCachePrefs.getBoolean(FULL_THREAD_SYNC_DONE_KEY, false)
                runCatching { refreshThreads(full = needsFullSync) }.onFailure { failures += it }
                if (usingV2()) runCatching { refreshAccount() }.onFailure { failures += it }
                runCatching { command("followup.list") }.onFailure { failures += it }
                if (socket === webSocket && relayConnected) {
                    if (failures.isNotEmpty()) Log.w(LOG_TAG, "initial sync deferred: ${failures.first().message}")
                }
            }
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (socket !== webSocket || !sessionSnapshotGuard.isCurrent(sessionTicket)) return
            val frame = runCatching { JSONObject(text) }.getOrElse { handleFrameSafely(text, "websocket"); return }
            if (frame.optString("type") == "ready") {
                readySequence.complete(if (frame.has("latestSequence") && !frame.isNull("latestSequence")) frame.optLong("latestSequence").coerceAtLeast(0L) else null)
            }
            // The relay limits a frame to 2 MiB. Bound the whole backlog too;
            // reconnecting leaves the last replayed cursor intact.
            if (!replayBuffer.offer(frame.optLong("sequence"), frame, text.length * 2) { applyCurrentFrame(webSocket, it, "websocket") }) {
                replayBuffer.abort()
                webSocket.cancel()
            }
        }
        private fun applyCurrentFrame(webSocket: WebSocket, frame: JSONObject, source: String) {
            sessionSnapshotGuard.publish(sessionTicket) {
                if (socket === webSocket) handleFrameSafely(frame, source)
            }
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            replayBuffer.abort()
            if (socket !== webSocket) return
            connectWatchdogJob?.cancel(); connectWatchdogJob = null
            socketStartedAt = 0L
            socket = null
            relayConnected = false; onOffline(reason)
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            replayBuffer.abort()
            if (socket !== webSocket) return
            connectWatchdogJob?.cancel(); connectWatchdogJob = null
            socketStartedAt = 0L
            socket = null
            relayConnected = false
            when (websocketAuthFailureAction(response?.code)) {
                AuthFailureAction.REFRESH_ACCESS -> onAccessTokenRejected("401: 访问令牌已失效")
                AuthFailureAction.REQUIRE_REAUTH -> onRefreshTokenRejected("登录需要重新验证")
                AuthFailureAction.KEEP_SESSION -> {
                    if (response?.code == 403) onPermissionDenied("当前账户暂时无权连接")
                    else onOffline(t.message ?: "连接中断")
                }
            }
        }
    }

    private fun onOffline(reason: String) {
        connectWatchdogJob?.cancel(); connectWatchdogJob = null
        socketStartedAt = 0L
        connectorWatchdogJob?.cancel()
        markPendingInstructionRetries()
        failPendingRequests(reason)
        // Most transport failures are transient while Android resumes the
        // radio or the relay completes a new handshake. Keep the UI in a
        // reconnecting state during the scheduled recovery instead of
        // flashing "电脑离线" on an otherwise idle screen. Expose Offline
        // only when recovery remains unsuccessful for a meaningful interval.
        _connection.value = ConnectionState.Connecting
        _statusText.value = reconnectingText()
        scope.launch {
            delay(CONNECT_ATTEMPT_TIMEOUT_MS)
            if (!relayConnected && _connection.value == ConnectionState.Connecting) {
                _connection.value = ConnectionState.Offline
                _statusText.value = offlineText()
                // No notification for the phone's own missing network: the user can see that.
                if (phoneHasNetwork()) notificationSink?.invoke("电脑离线", reason, false)
            }
        }
        scheduleReconnect()
    }

    /**
     * Drop a transport that no longer represents a live connector and start a
     * fresh handshake. This is intentionally a Connecting state, rather than
     * an Offline blip, because the relay socket may still be recoverable and
     * the user is usually just opening a conversation or resuming the app.
     */
    private fun restartTransport(reason: String) {
        if (directMode()) { directFailed(reason); return }
        connectorWatchdogJob?.cancel(); connectorWatchdogJob = null
        connectWatchdogJob?.cancel(); connectWatchdogJob = null
        socketStartedAt = 0L
        relayConnected = false
        connectorHeartbeatAt = 0L
        connectorConnectedAt = 0L
        val staleSocket = socket
        socket = null
        staleSocket?.cancel()
        markPendingInstructionRetries()
        failPendingRequests(reason)
        _connection.value = ConnectionState.Connecting
        _statusText.value = reconnectingText()
        scheduleReconnect(0L)
    }

    private fun scheduleReconnect(delayMs: Long? = null) {
        if (directMode()) return
        if (!reconnect || !configured()) return
        if (reconnectJob?.isActive == true && delayMs == null) return
        reconnectJob?.cancel()
        val wait = delayMs ?: (500L shl reconnectAttempt.coerceAtMost(3)).also { reconnectAttempt++ }.coerceAtMost(4_000L)
        reconnectJob = scope.launch {
            delay(wait)
            reconnectJob = null
            connect()
        }
    }

    private fun onAccessTokenRejected(reason: String) {
        connectorWatchdogJob?.cancel()
        failPendingRequests(reason)
        relayConnected = false
        socket?.cancel()
        socket = null
        crypto.invalidateAccessToken()
        _connection.value = ConnectionState.Offline
        _statusText.value = "正在刷新登录状态"
        Log.w(LOG_TAG, reason)
        scheduleReconnect(250L)
    }

    private fun onRefreshTokenRejected(reason: String) {
        if (BuildConfig.DEMO) return
        connectorWatchdogJob?.cancel()
        failPendingRequests(reason)
        reconnect = false
        socket?.cancel()
        socket = null
        _sessionExpired.value = true
        _connection.value = ConnectionState.Offline
        _statusText.value = "登录需要重新验证"
        Log.w(LOG_TAG, reason)
    }

    private fun onPermissionDenied(reason: String) {
        connectorWatchdogJob?.cancel()
        failPendingRequests(reason)
        _connection.value = ConnectionState.Offline
        _statusText.value = "账户权限暂时不可用"
        Log.w(LOG_TAG, reason)
        scheduleReconnect(10_000L)
    }

    private fun startConnectorWatchdog() {
        connectorWatchdogJob?.cancel()
        connectorWatchdogJob = scope.launch {
            while (relayConnected) {
                delay(1_000)
                val lastSeen = connectorHeartbeatAt
                val baseline = if (lastSeen == 0L) connectorConnectedAt else lastSeen
                if (baseline > 0L && System.currentTimeMillis() - baseline > CONNECTOR_HEARTBEAT_TIMEOUT_MS) {
                    Log.w(LOG_TAG, "connector heartbeat timed out; restarting websocket")
                    restartTransport("电脑连接器心跳已中断")
                }
            }
        }
    }

    private fun startConnectWatchdog(startedAt: Long) {
        connectWatchdogJob?.cancel()
        connectWatchdogJob = scope.launch {
            delay(CONNECT_ATTEMPT_TIMEOUT_MS)
            if (socketStartedAt == startedAt && socket != null && !relayConnected) {
                Log.w(LOG_TAG, "websocket handshake timed out after ${CONNECT_ATTEMPT_TIMEOUT_MS}ms")
                socket?.cancel()
                socket = null
                onOffline("连接握手超时")
            }
        }
    }

    private fun noteConnectorOnline(sentAt: Long, livePresence: Boolean = false) {
        // A presence frame arrived on the authenticated live socket. Its relay timestamp
        // may be older than the device clock after resume, so transport liveness wins here.
        if (!livePresence && !isFreshConnectorPresence(sentAt)) return
        if (directMode() && directPeer != null) {
            relayConnected = true
            if (connectorWatchdogJob?.isActive != true) startConnectorWatchdog()
        }
        connectorHeartbeatAt = System.currentTimeMillis()
        val wasOnline = _connection.value == ConnectionState.Online
        _connection.value = ConnectionState.Online
        _statusText.value = "电脑在线 · 实时同步"
        // Being connected is the normal state: no "connected" notice. This only
        // puts the ongoing service notification back from a "电脑离线" text.
        if (!wasOnline) notificationSink?.invoke("khLink", CONNECTED_NOTICE, false)
        if (!wasOnline) {
            // A history.sync command is intentionally fire-and-forget. If the
            // socket dropped immediately after it was sent, no command.result
            // or history.updated frame is guaranteed to arrive. Probe the
            // currently open thread once after the transport is usable again;
            // the same per-thread cooldown used by initialOpen prevents a
            // reconnect storm.
            scope.launch {
                delay(HISTORY_SYNC_RECONNECT_PROBE_DELAY_MS)
                val id = activeThreadId ?: return@launch
                if (_connection.value == ConnectionState.Online &&
                    System.currentTimeMillis() - (historyBackfillRequestedAt[id] ?: 0L) >= HISTORY_BACKFILL_REQUEST_INTERVAL_MS) {
                    requestHistoryBackfill(id)
                }
            }
        }
    }

    private fun markConnectorOffline(notify: Boolean = true) {
        val changed = _connection.value != ConnectionState.Offline
        // Offline says it all; the next presence reports the line again.
        _uploadIssue.value = null
        connectorWatchdogJob?.cancel(); connectorWatchdogJob = null
        connectWatchdogJob?.cancel(); connectWatchdogJob = null
        socketStartedAt = 0L
        relayConnected = false
        markPendingInstructionRetries()
        activeThreadId?.let { historyBackfillRequestedAt.remove(it) }
        val staleSocket = socket
        socket = null
        staleSocket?.cancel()
        _connection.value = ConnectionState.Offline
        _statusText.value = offlineText()
        if (changed && notify && phoneHasNetwork()) notificationSink?.invoke("电脑离线", "电脑连接器心跳已中断", false)
        scheduleReconnect()
    }

    private fun handleFrameSafely(text: String, source: String) {
        try {
            handleFrame(JSONObject(text), source != "replay")
        } catch (error: Exception) {
            Log.e(LOG_TAG, "ignored invalid $source frame", error)
        }
    }

    private fun handleFrameSafely(frame: JSONObject, source: String) {
        try {
            handleFrame(frame, source != "replay")
        } catch (error: Exception) {
            Log.e(
                LOG_TAG,
                "ignored invalid $source frame kind=${frame.optString("kind", "-")} sequence=${frame.optLong("sequence")}",
                error,
            )
        }
    }

    private fun handleFrame(frame: JSONObject, logFrame: Boolean = true) {
        if (frame.has("type")) {
            if (frame.optString("type") == "error") _message.value = frame.optString("message", "请求失败")
            return
        }
        // Direct connections start a fresh, ordered channel on every QR pair.
        // Their counters must never be compared with the cloud replay cursor.
        val sequence = if (directMode()) 0L else frame.optLong("sequence")
        // WebSocket delivery and event replay can overlap when the app
        // resumes.  A replayed frame that has already been acknowledged must
        // never be applied a second time: an older thread.settings event can
        // otherwise overwrite the current model/effort and make the label
        // appear to alternate between high and low.
        if (sequence > 0L && sequence <= lastSequence) {
            if (logFrame) Log.d(LOG_TAG, "ignored duplicate/stale frame sequence=$sequence latest=$lastSequence")
            return
        }
        val kind = frame.getString("kind"); val threadId = frame.optString("threadId").takeIf { it.isNotBlank() && it != "null" }
        val payload = crypto.decrypt(kind, threadId, frame.getString("id"), frame.getString("nonce"), frame.getString("ciphertext"))
        if (kind == "file.result" && frame.has("blob")) payload.put(FILE_BLOB_FIELD, crypto.decryptBlob(frame.getString("id"), frame.getString("blobNonce"), frame.getString("blob")))
        // Invalid or undecryptable frames must not move the durable cursor and
        // cause later authenticated messages to be skipped on reconnect.
        if (sequence > lastSequence) { lastSequence = sequence; crypto.saveSequence(lastSequence) }
        if (logFrame) Log.d(LOG_TAG, "frame kind=$kind thread=${threadId ?: "-"} status=${payload.optString("status", "-")}")
        // A reply from the connector proves it is alive as much as a presence beat does.
        // Fetching a large file fills the socket with chunks, and the beats queued behind
        // them can arrive later than CONNECTOR_HEARTBEAT_TIMEOUT_MS on a slow network.
        if ((kind == "file.result" || kind == "command.result") && connectorHeartbeatAt > 0L) connectorHeartbeatAt = System.currentTimeMillis()
        when (kind) {
            "approval.request" -> {
                if (!_claudeConsent.value.enabled && (payload.optString("backend") == "claude" || _threads.value.any { it.id == threadId && it.backend == "claude" })) return
                val request = payload.optJSONObject("request")
                val params = payload.optJSONObject("params")
                val questions = mutableListOf<ApprovalQuestion>(); val source = request?.optJSONArray("questions") ?: params?.optJSONArray("questions")
                if (source != null) for (i in 0 until source.length()) {
                    val question = source.optJSONObject(i) ?: continue
                    val options = mutableListOf<ApprovalChoice>(); val rawOptions = question.optJSONArray("options")
                    if (rawOptions != null) for (j in 0 until rawOptions.length()) {
                        when (val raw = rawOptions.opt(j)) {
                            is JSONObject -> options += ApprovalChoice(
                                raw.optString("value", raw.optString("id", raw.optString("label"))),
                                raw.optString("label", raw.optString("value", raw.optString("id"))),
                                raw.optString("description", raw.optString("detail")),
                                raw.optBoolean("custom") || raw.optBoolean("isOther"),
                            )
                            is String -> options += ApprovalChoice(raw, raw)
                        }
                    }
                    questions += ApprovalQuestion(
                        question.optString("id", "question-$i"),
                        question.optString("title", question.optString("question", question.optString("header"))),
                        question.optString("description", question.optString("detail")),
                        options,
                        question.optBoolean("required", true),
                        question.optBoolean("multiple") || question.optBoolean("multiSelect"),
                        question.optBoolean("allowCustomInput") || question.optBoolean("customInput"),
                        question.optBoolean("secret") || question.optBoolean("isSecret"),
                    )
                }
                val expiresAt = payload.optLong("expiresAt")
                // A replayed request that has already expired is not shown again.
                if (expiresAt > 0 && expiresAt < System.currentTimeMillis()) return
                // Codex requests carry an rpcId; connector-run Claude ones a requestId.
                val approval = ApprovalRequest(payload.optString("rpcId").ifBlank { payload.optString("requestId") }, payload.optString("method"), threadId,
                    request?.optString("title")?.takeIf { it.isNotBlank() }
                        ?: params?.optString("reason")?.takeIf { it.isNotBlank() }
                        ?: "需要确认",
                    request?.optString("detail", "") ?: "",
                    expiresAt, questions, request?.optString("kind", "approval") ?: "approval",
                    request?.optBoolean("allowSession") == true,
                    request?.optBoolean("blocking", true) ?: params?.optBoolean("isBlocking", true) ?: true)
                val repeat = matchesApproval(_approval.value, approval.rpcId, approval.threadId)
                _approval.value = mergeApprovalReplay(_approval.value, approval)
                if (approval.blocking) threadId?.let { setLiveStatus(it, "waiting_input", frame.optLong("createdAt")) }
                if (!repeat) {
                    val owner = _threads.value.firstOrNull { it.id == threadId }
                    val title = owner?.title
                    val who = agentName(owner?.backend.orEmpty())
                    if (threadId != null && threadNotificationSink != null) {
                        if (!onScreen(threadId)) threadNotificationSink?.invoke(threadId, "$who 在等你 · ${title ?: "任务"}", approval.detail.lineSequence().firstOrNull()?.takeIf { it.isNotBlank() } ?: approval.title, true, ThreadNoticeKind.PROMPT)
                    } else notificationSink?.invoke("khLink 等待输入", approval.title, true)
                }
            }
            "approval.result" -> {
                val current = _approval.value
                if (current?.rpcId == payload.optString("rpcId") && current.threadId == threadId && !payload.optBoolean("accepted")) {
                    _approval.value = if (payload.optBoolean("expired")) null else current.copy(submitting = false)
                    _message.value = payload.optString("message").ifBlank { "回答未被接受，已保留选择" }
                }
            }
            "approval.resolved" -> {
                // Answered elsewhere (desktop, another phone) or its turn ended.
                val rpcId = payload.optString("rpcId").takeIf { it.isNotBlank() && it != "null" }
                val current = _approval.value
                if (matchesApproval(current, rpcId, threadId)) _approval.value = null
            }
            "connector.online", "connector.presence" -> {
                (frame.optString("sourceDeviceId").takeIf { it.isNotBlank() && it != "null" }
                    ?: payload.optString("connectorId").takeIf { it.isNotBlank() && it != "null" })?.let { source ->
                    _connectorSeenAt.value = _connectorSeenAt.value + (source to System.currentTimeMillis())
                }
                noteConnectorOnline(
                    frame.optLong("createdAt", payload.optLong("sentAt")),
                    livePresence = kind == "connector.presence",
                )
                if (kind == "connector.presence") {
                    reconcileAgentOpenStates(payload)
                    reconcileLiveStatusSnapshot(payload)
                    reconcileDesktopCodexPins(payload)
                    reconcileDesktopClaudePins(payload)
                    reconcileLightMode(frame.optString("sourceDeviceId").takeIf { it.isNotBlank() && it != "null" } ?: payload.optString("connectorId").takeIf { it.isNotBlank() && it != "null" }, payload)
                    if (!fromOtherConnector(frame)) parsePcLoad(payload.optJSONObject("pcLoad"), System.currentTimeMillis())?.let { _pcLoad.value = it }
                    // Only a full presence (with agents) carries it; null there clears it.
                    if (!fromOtherConnector(frame) && payload.has("agents")) {
                        _uploadIssue.value = payload.optJSONObject("uploadIssue")?.let { issue ->
                            issue.optString("reason").takeIf { it.isNotBlank() && it != "null" }?.let { UploadIssue(it, issue.optLong("since")) }
                        }
                    }
                    val ownerRows = payload.optJSONArray("threadOwners")
                    if (ownerRows != null) {
                        val owners = _threadOwners.value.toMutableMap()
                        for (index in 0 until ownerRows.length()) {
                            val row = ownerRows.optJSONObject(index) ?: continue
                            val ownerThreadId = row.optString("threadId").takeIf { it.isNotBlank() } ?: continue
                            val owner = row.optString("owner", "unknown").ifBlank { "unknown" }
                            owners[ownerThreadId] = owner
                        }
                        _threadOwners.value = owners
                    }
                    // A resume can replay presence without a second
                    // connector.online frame. Presence is sufficient to
                    // safely retry mobile instructions that hit a transport
                    // gap.
                    retryPendingInstructionActions()
                } else {
                    // Refresh the queue once when the authenticated connector
                    // session comes online. Do not issue a request for every
                    // presence heartbeat; at a 1s heartbeat that would flood
                    // the relay and delay real command acknowledgements.
                    retryPendingInstructionActions()
                    runCatching { command("followup.list") }
                    // A worker upgrade does not reconnect the phone's relay
                    // socket. Refresh capabilities once on connector online.
                    runCatching { command("capabilities") }
                    runCatching { command("backends.capabilities") }
                }
            }
            // Another computer's agent going down must not take this phone's
            // socket (and the selected computer) offline.
            "connector.offline" -> if (!fromOtherConnector(frame)) markConnectorOffline()
            "history.updated" -> {
                threadId?.let { markHistorySyncing(it, false) }
                val updatedAt = payload.optLong("updatedAt", System.currentTimeMillis())
                scope.launch {
                    if (payload.optBoolean("fullHistory", false) && threadId != null) {
                        // Keep the durable cache visible across reconnects and
                        // app upgrades. A full-history event marks it stale;
                        // the active conversation refreshes in the background
                        // instead of blanking the screen and downloading again.
                        historyCachePrefs.edit().putBoolean(historyCacheForceRefreshKey(threadId), true).apply()
                        // A rebuilt Claude conversation gained items in its
                        // middle (images from tools). Only the newest page is
                        // ever re-fetched, so drop the cached copy and reopen.
                        if (payload.optString("backend") == "claude") {
                            itemsCursors.remove(threadId)
                            database.cache().deleteItems(threadId)
                            if (activeThreadId == threadId) runCatching { loadThread(threadId) }
                        }
                    }
                    requestThreadsRefresh()
                    // Backfill progress (re-reading old history) is not new
                    // activity: it must not move an old task into "最近".
                    val backfill = payload.optBoolean("recentHistory") || payload.optBoolean("fullHistory") || payload.optBoolean("older") ||
                        payload.optBoolean("historyDeferred") || payload.optInt("itemCount", 1) == 0
                    if (!backfill) updateThreadActivity(threadId, updatedAt)
                }
                if (threadId != null && activeThreadId == threadId) {
                    scheduleActiveHistoryRefresh(threadId)
                }
            }
            "history.sync.failed" -> {
                threadId?.let { id -> historyBackfillRequestedAt.remove(id); markHistorySyncing(id, false) }
                val reason = payload.optString("reason", "历史同步失败，请稍后重试")
                // Shown inline in the thread; a history sync is never asked for by the user.
                if (threadId == activeThreadId) {
                    _historyLoadState.value = _historyLoadState.value.copy(error = reason, loading = false)
                }
            }
            "threads.updated" -> {
                requestThreadsRefresh()
                if (payload.optBoolean("accountChanged")) refreshAfterAgentAccountChange(payload.optString("backend"))
            }
            "thread.usage" -> threadId?.let { applyConversationUsage(it, payload) }
            "thread.settings" -> threadId?.let { id ->
                val settings = payload.optJSONObject("settings") ?: payload
                applyThreadSettings(id, settings, payload.optLong("updatedAt", frame.optLong("createdAt")))
                // A setting kept for the next turn that could not be applied is said once, in the connector's words.
                if (payload.has("applied") && !payload.optBoolean("applied", true)) {
                    payload.optString("reason").takeIf { it.isNotBlank() && it != "null" }?.let { _message.value = it }
                }
            }
            "thread.ownership" -> threadId?.let { id ->
                val owner = payload.optString("owner", "unknown").ifBlank { "unknown" }
                _threadOwners.value = _threadOwners.value + (id to owner)
            }
            "thread.status", "thread.status.snapshot" -> threadId?.let { id ->
                val status = payload.optString("status", "idle")
                val updatedAt = payload.optLong("updatedAt", frame.optLong("createdAt"))
                val turnId = payload.optString("turnId").takeIf { it.isNotBlank() && it != "null" }
                val previous = _liveStatuses.value[id] ?: _threads.value.firstOrNull { it.id == id }?.status.orEmpty()
                setLiveStatus(id, status, updatedAt, turnId, quiet = payload.optBoolean("quiet", false))
                val owner = _threads.value.firstOrNull { it.id == id }
                val approvalNoticeKey = "desktopApprovalNotice:${owner?.connectorId.orEmpty()}:$id"
                val lastApprovalNotice = historyCachePrefs.getLong(approvalNoticeKey, 0L)
                if (shouldNotifyDesktopApproval(previous, status, kind, _liveStatuses.value[id] == status, updatedAt, lastApprovalNotice, System.currentTimeMillis())) {
                    historyCachePrefs.edit().putLong(approvalNoticeKey, updatedAt).apply()
                    if (!onScreen(id)) threadNotificationSink?.invoke(id, "Codex 等待批准 · ${owner?.title ?: "任务"}", "请在电脑上查看并处理", true, ThreadNoticeKind.PROMPT)
                }
                noteWaiting(id, status, updatedAt)
                // A heartbeat for an existing turn does not acknowledge a
                // new message. Only the request's own receipt may do that.
                // New activity is a turn starting, running or waiting, or one that
                // was running ending now. The computer re-announces "completed"
                // for old finished tasks when it re-reads them; that must not
                // make them look just finished.
                if (kind == "thread.status" && updatedAt > 0 && isStatusActivity(previous, status)) _threads.value = sortThreadSummaries(_threads.value.map { item ->
                    if (item.id == id && backendTab(item.backend) !in setOf("codex", "antigravity")) item.copy(updatedAt = maxOf(item.updatedAt, updatedAt)) else item
                })
            }
            "codex.event" -> {
                val method = payload.optString("method")
                val params = payload.optJSONObject("params")
                val rawStatus = params?.optJSONObject("turn")?.opt("status") ?: params?.opt("status")
                val turnStatus = if (rawStatus is JSONObject) rawStatus.optString("type", rawStatus.optString("kind")) else (rawStatus as? String).orEmpty()
                val status = codexEventStatus(method, turnStatus)
                val turnId = params?.optJSONObject("turn")?.optString("id")?.takeIf { it.isNotBlank() }
                    ?: params?.optString("turnId")?.takeIf { it.isNotBlank() }
                threadId?.let { id -> status?.let { setLiveStatus(id, it, frame.optLong("createdAt"), turnId) } }
                // Turn ends are announced once, with the session, by updateTurnDuration.
            }
            "codex.question", "codex.question.state" -> {
                val id = threadId ?: payload.optString("threadId").takeIf { it.isNotBlank() }
                if (id != null) parseCodexQuestionState(id, payload)?.let { applyCodexQuestionState(it, notify = !payload.optBoolean("silent")) }
            }
            "context.compaction" -> {
                val status = payload.optString("status", "started")
                threadId?.let { id ->
                    // A failed compaction lifts the line but does not fail the turn:
                    // the turn's own terminal event says how it ended.
                    compactionLiveStatus(status)?.let { live ->
                        setLiveStatus(id, live, payload.optLong("updatedAt", frame.optLong("createdAt")), payload.optString("turnId").takeIf { it.isNotBlank() })
                    }
                }
                // Only a compaction the phone asked for rings; one Codex runs by itself shows its line and no reminder.
                if (status == "started") notificationSink?.invoke("上下文整理", "正在整理当前任务上下文", false)
            }
            "codex.error" -> {
                if (!payload.optBoolean("terminal", false)) return
                val error = payload.optString("error", "任务执行失败")
                threadId?.let { id ->
                    setLiveStatus(id, "failed", payload.optLong("updatedAt", frame.optLong("createdAt")))
                    if (activeThreadId == id) {
                        scheduleActiveHistoryRefresh(id)
                    }
                }
                _message.value = error
                notificationSink?.invoke("任务失败", error, false)
            }
            // A second backend (Claude Code) reuses the Codex item/status
            // vocabulary via the neutral agent.* frames. Live status arrives on
            // thread.status and content on history.updated (the connector
            // persists each item), so agent.event only drives notifications and
            // keeps the active thread fresh.
            "claude.usage" -> if (!fromOtherConnector(frame)) parseClaudeUsage(payload)
            "dsh.usage" -> if (!fromOtherConnector(frame)) applyDshUsage(payload)
            "accounts.state" -> if (!fromOtherConnector(frame)) applyAgentAccounts(payload)
            "codex.usage" -> if (!fromOtherConnector(frame)) applyCodexUsage(payload)
            "agent.event" -> {
                val item = payload.optJSONObject("item")
                val itemType = item?.optString("type").orEmpty()
                threadId?.let { id ->
                    if (activeThreadId == id) scheduleActiveHistoryRefresh(id)
                }
                // Replies are not announced one by one; the end of the turn is.
            }
            "agent.error" -> {
                if (!payload.optBoolean("terminal", false)) return
                val error = payload.optString("error", "任务执行失败")
                threadId?.let { id ->
                    setLiveStatus(id, "failed", payload.optLong("updatedAt", frame.optLong("createdAt")))
                    // The message this turn was for never ran: say so on it, not "已发送",
                    // so it can be copied and sent again.
                    _queuedInstructions.value[id].orEmpty()
                        .filter { it.state == "sent" || it.state == "sending" }
                        .forEach { markFollowupState(id, it.id, "failed", error) }
                    if (activeThreadId == id) scheduleActiveHistoryRefresh(id)
                }
                _message.value = error
                notificationSink?.invoke("任务失败", error, false)
            }
            "command.result", "file.result" -> {
                val requestId = payload.optString("requestId"); pendingInstructionRetries.remove(requestId); pendingInstructionRetryAt.remove(requestId); pendingInstructionTimeouts.remove(requestId)?.cancel(); val pending = pendingActions.remove(requestId); deletePendingAction(requestId)
                pendingRequests.remove(requestId)?.complete(payload)
                // Statistics results/failures are handled inline in the panel;
                // background reads must never open a global alert.
                if (pending?.action == "thread.usage.read") return
                if (!payload.optBoolean("ok")) {
                    val error = payload.optString("error", "操作失败")
                    if (pending?.action in setOf("dsh.pending", "dsh.answer")) _dshPendingLoading.value = false
                    val retryableAgentLoop = isRetryableCodexAgentLoopError(error)
                    if (pending?.action == "capabilities") {
                        _capabilities.value = _capabilities.value.copy(quotaState = "unavailable", quotaError = error)
                    }
                    if (pending?.threadId != null && pending.action in setOf("turn.start", "turn.steer", "followup.enqueue", "followup.steer", "followup.steer_all")) {
                        markFollowupState(
                            pending.threadId,
                            requestId,
                            if (retryableAgentLoop) "pending" else "failed",
                            if (retryableAgentLoop) "Codex 后台正在恢复，消息和图片已保存，连接器会自动重试" else error,
                        )
                    }
                    if (shouldShowCommandFailure(pending?.action)) {
                        _message.value = if (retryableAgentLoop)
                            "Codex 后台正在恢复，消息和图片已保存，稍后会自动重试"
                        else if (error.contains("thread not found", true))
                            "这个任务已不在电脑的任务索引中，请返回任务列表并刷新后重试。"
                        else error
                    }
                    if (pending?.action == "history.sync" && pending.threadId != null) {
                        historyBackfillRequestedAt.remove(pending.threadId)
                        markHistorySyncing(pending.threadId, false)
                    }
                    if (pending?.action == "settings.set" && pending.threadId != null) {
                        finishSettingsSwitch(pending.threadId)
                        _message.value = "切换失败：$error"
                    }
                    return
                }
                val result = payload.opt("result")
                if (pending?.action == "thread.archive") _message.value = archiveDoneMessage(pending.args.optBoolean("archived"), pending.args.optString("title"), (result as? JSONObject)?.optString("reason"))
                if (result is JSONObject && pending?.action == "followup.list") {
                    replaceFollowups(result.optJSONArray("items") ?: org.json.JSONArray())
                }
                if (result is JSONObject && (result.optBoolean("queued") || result.optBoolean("uncertain") || result.optBoolean("failed") ||
                    (result.optBoolean("accepted") && result.has("item")))) {
                    result.optJSONObject("item")?.let(::upsertFollowup)
                    if (result.optBoolean("uncertain") || result.optBoolean("failed")) {
                        val row = result.optJSONObject("item")
                        val target = row?.optString("threadId")?.takeIf { it.isNotBlank() } ?: pending?.threadId
                        if (target != null && row != null) notifyFollowupFailure(target, row.optString("id"),
                            row.optString("reason").takeIf { it.isNotBlank() } ?: "发送结果需要确认，请检查电脑上的对话")
                    }
                } else if (result is JSONObject && result.optBoolean("delivered") && pending?.threadId != null &&
                    pending.action in setOf("turn.start", "turn.steer", "followup.enqueue", "followup.steer", "followup.steer_all")) {
                    // History reconciliation can remove the connector row
                    // while the command response is still in flight. Keep the
                    // optimistic bubble as started/steered until history
                    // catches up, but never leave it in the waiting queue or
                    // create a second synthetic queue row on the phone.
                    markFollowupState(
                        pending.threadId,
                        requestId,
                        if (pending.action == "turn.steer") "steered" else "started",
                        confirmedAt = frame.optLong("createdAt"),
                    )
                } else if (pending?.action == "turn.start" && pending.threadId != null) {
                    markFollowupState(pending.threadId, requestId, "started", confirmedAt = frame.optLong("createdAt"))
                }
                if (result is JSONObject && pending?.threadId != null && pending.action in setOf("thread.settings.read", "settings.set")) {
                    applyThreadSettings(
                        pending.threadId,
                        result,
                        result.optLong("updatedAt", payload.optLong("updatedAt", System.currentTimeMillis())),
                    )
                    if (pending.action == "settings.set") {
                        finishSettingsSwitch(pending.threadId)
                        // The connector says in Chinese what waits for a running turn or what did not change.
                        val reason = result.optString("reason").takeIf { it.isNotBlank() && it != "null" }
                        _message.value = if (result.optString("backend") == "pi") {
                            // PI WEB applies the change at once; a level the new model does not offer is explained here.
                            result.optString("note").ifBlank { "Pi 设置已保存" }
                        } else if (result.optString("backend") == "claude") {
                            // A desktop-run session is switched there at once; a model or effort waits while a turn runs.
                            reason ?: if (result.optBoolean("desktop")) "已在电脑上的会话里切换设置" else "Claude 设置已保存，下一轮生效"
                        } else if (reason != null) {
                            reason
                        } else if (result.optString("backend") == "dsh") {
                            // DSH applies a model or permission at once; say what it is now.
                            val model = result.optString("model").substringAfter('/').takeIf { it.isNotBlank() && it != "null" }
                            val permission = mapOf("read-only" to "只读", "workspace-write" to "工作区可写", "danger-full-access" to "完全权限")[result.optString("permissionMode")]
                                ?: result.optString("permissionMode").takeIf { it.isNotBlank() && it != "null" }
                            "DSH 已切换，立即生效" + listOfNotNull(model, permission).joinToString(" · ").let { if (it.isBlank()) "" else "：$it" }
                        } else if (result.optBoolean("queued")) "设置已排队，当前轮完成后通过后台协议生效" else "设置已同步到桌面，下一轮生效"
                    }
                }
                if (result is org.json.JSONArray && result.length() >= 2) parseCapabilities(result)
                if (result is JSONObject && pending?.action == "backends.capabilities") parseBackendCapabilities(result)
                if (result is JSONObject && pending?.action in setOf("claude.usage", "claude.usage.refresh", "claude.statusline.set")) parseClaudeUsage(result)
                if (result is JSONObject && pending?.action == "dsh.usage") applyDshUsage(result)
                if (result is JSONObject && pending?.action == "thread.pin" && pending.threadId != null) {
                    val pinned = result.optBoolean("pinned", pending.args.optBoolean("pinned"))
                    val order = result.optInt("pinOrder", -1)
                    _threads.value = sortThreadSummaries(_threads.value.map { thread ->
                        if (thread.id == pending.threadId) thread.copy(pinned = pinned, pinOrder = order) else thread
                    })
                }
                if (pending?.action == "dsh.pending") {
                    _dshPending.value = parseDshPending(result as? JSONObject)
                    _dshPendingLoading.value = false
                }
                if (pending?.action == "dsh.answer") {
                    _dshPending.value = null
                    _dshPendingLoading.value = false
                    _message.value = (result as? JSONObject)?.optString("clicked")?.takeIf { it.isNotBlank() }?.let { "已在 DSH 桌面端选择：$it" } ?: "已提交到 DSH 桌面端"
                }
                if (result is JSONObject && pending?.action == "thread.settings.read") applyDshCatalog(result)
                if (pending?.action == "history.sync" && pending.threadId != null && (result as? JSONObject)?.optBoolean("queued", false) != true) {
                    val id = pending.threadId
                    scope.launch { delay(1_500); markHistorySyncing(id, false) }
                }
                if (pending?.action == "history.sync" && pending.threadId != null) {
                    val queued = (result as? JSONObject)?.optBoolean("queued", false) == true
                    // Merge the newest page into the visible cache. A normal
                    // reload here could display the stale Room snapshot again
                    // when the connector has just completed a backfill.
                    val id = pending.threadId
                    val generation = historyLoadGeneration
                    scope.launch {
                        runCatching { loadThread(id, mergeLatest = true) }
                        if (queued) {
                            // `queued=true` is only an acceptance receipt; the
                            // connector may still be replaying a large JSONL
                            // file. Give it a few bounded chances even when a
                            // realtime history.updated event is lost. This is
                            // deliberately finite so a broken relay cannot
                            // turn one open into a polling loop.
                            for (waitMs in HISTORY_SYNC_MERGE_RETRY_DELAYS_MS) {
                                delay(waitMs)
                                if (activeThreadId != id || historyLoadGeneration != generation || _connection.value != ConnectionState.Online) break
                                runCatching { loadThread(id, mergeLatest = true) }
                            }
                        }
                    }
                }
                if (pending?.action == "file.list" && result is JSONObject) {
                    _filePath.value = result.optString("path", pending.args.optString("path")); val rows = result.optJSONArray("items") ?: org.json.JSONArray(); val entries = mutableListOf<FileEntry>()
                    for (i in 0 until rows.length()) rows.optJSONObject(i)?.let { entries += FileEntry(it.optString("name"), it.optString("path"), it.optBoolean("directory"), it.optLong("size"), it.optLong("modifiedAt")) }
                    _files.value = entries
                }
            }
            "followup.snapshot" -> replaceFollowups(payload.optJSONArray("items") ?: org.json.JSONArray(), frame.optString("sourceDeviceId").takeIf { it.isNotBlank() && it != "null" })
            "followup.queued" -> upsertFollowup(payload)
            "followup.started" -> {
                threadId?.let { id ->
                    val item = parseFollowup(payload)
                    if (item != null) upsertFollowup(id, item.copy(state = "started", startedAt = payload.optLong("startedAt", frame.optLong("createdAt"))))
                    markTurnStarted(id)
                    setLiveStatus(id, "desktop_running")
                    reconcileDeliveredInstructions(id, _items.value)
                }
            }
            "followup.cancelled" -> removeFollowup(payload.optString("id"))
            "followup.failed" -> {
                upsertFollowup(payload)
                val target = payload.optString("threadId").ifBlank { threadId.orEmpty() }
                notifyFollowupFailure(target, payload.optString("id"),
                    if (payload.optBoolean("needsConfirmation")) "发送结果尚未确认，请检查这条对话；系统不会自动重发"
                    else payload.optString("reason", "待发送指令失败"))
            }
            "steer.accepted" -> {
                threadId?.let { id ->
                    val requestId = payload.optString("requestId")
                    val queuedId = payload.optString("queuedItemId").ifBlank { requestId }
                    confirmStartFeedback(id, queuedId, "steered", frame.optLong("createdAt"))
                    markFollowupState(id, requestId, "steered", confirmedAt = frame.optLong("createdAt"))
                    setLiveStatus(id, "desktop_running")
                }
                _message.value = null
            }
            "steer.deferred" -> {
                payload.optJSONObject("item")?.let(::upsertFollowup)
                val requestId = payload.optString("requestId")
                if (pendingActions[requestId]?.action == "turn.steer") {
                    // The answer card already shows its actual queue state.
                    // A delayed Desktop repaint is not a failed answer and
                    // must not open a contradictory global error dialog.
                    val text = pendingActions[requestId]?.args?.optString("text").orEmpty()
                    if (parseQuestionReplies(text).isEmpty()) _message.value = "当前阶段不能调整方向，已改为同一任务的下一条指令"
                }
            }
            "steer.uncertain" -> {
                val requestId = payload.optString("requestId")
                if (pendingActions[requestId]?.action == "turn.steer") {
                    _message.value = "调整方向是否送达无法确认，请在电脑端确认"
                }
            }
        }
    }

    private fun parseBackendCapabilities(result: JSONObject) {
        parseClaudeUsage(result.optJSONObject("backends")?.optJSONObject("claude")?.optJSONObject("capabilities")?.optJSONObject("usage"))
        val rows = result.optJSONObject("backends")?.optJSONObject("claude")?.optJSONObject("capabilities")?.optJSONArray("models") ?: return
        val models = (0 until rows.length()).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            val value = row.optString("value").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val efforts = row.optJSONArray("efforts")?.let { array -> (0 until array.length()).map { array.optString(it) }.filter { it.isNotBlank() } }.orEmpty()
            ClaudeModel(value, row.optString("label").ifBlank { value }, efforts)
        }
        if (models.isNotEmpty()) _claudeModels.value = models
    }

    // The longest Codex window (the weekly one) as remaining share and reset time.
    private fun weeklyQuotaFrom(limits: JSONObject?): QuotaSnapshot? {
        val weekly = limits?.optJSONObject("weekly") ?: listOfNotNull(limits?.optJSONObject("primary"), limits?.optJSONObject("secondary"))
            .maxByOrNull { it.optInt("windowDurationMins", 0) } ?: return null
        val remaining = weekly.optDouble("remainingPercent", Double.NaN)?.takeUnless(Double::isNaN)?.let { it.coerceIn(0.0, 100.0).toInt() }
            ?: weekly.optDouble("usedPercent", Double.NaN)?.takeUnless(Double::isNaN)?.let { (100.0 - it).coerceIn(0.0, 100.0).toInt() }
            ?: return null
        val resetRaw = weekly.optLong("resetsAt", weekly.optLong("resetAt", 0L))
        return QuotaSnapshot(remaining, resetRaw.takeIf { it > 0 }?.let { if (it < 10_000_000_000L) it * 1000 else it })
    }

    // Pushed by the connector whenever Codex's quota changes (also from turns
    // run on the desktop), so the bar follows use instead of the last app open.
    private fun applyCodexUsage(payload: JSONObject) {
        val limits = payload.optJSONObject("rateLimitsByLimitId")?.optJSONObject("codex") ?: payload.optJSONObject("rateLimits")
        val quota = weeklyQuotaFrom(limits)
        val at = payload.optLong("snapshotAt", 0)
        // Old connectors may omit a window on a transient error. New snapshots
        // explicitly clear it, including logout/no-quota/account-read failure.
        if (at == 0L && quota == null) return
        val before = _capabilities.value
        val next = before.withCodexQuota(CodexQuotaUpdate(quota, at,
            payload.optString("accountFingerprint").takeIf { it.isNotBlank() && it != "null" },
            payload.optString("accountState").takeIf { it.isNotBlank() && it != "null" },
            payload.optString("error").takeIf { it.isNotBlank() && it != "null" },
            limits?.optString("planType")?.uppercase().orEmpty()))
        if (next == before) return
        _capabilities.value = next
        if (quota != null) crypto.saveQuotaSnapshot(quota) else crypto.clearQuotaSnapshot()
        if (next.quotaAccountFingerprint != before.quotaAccountFingerprint) refreshAfterAgentAccountChange("codex")
    }

    private fun parseCapabilities(result: org.json.JSONArray) {
        _accountsAvailable.value = result.optJSONObject(2)?.optString("accounts") == "accounts.v1"
        val modelRoot = result.optJSONObject(0) ?: JSONObject()
        val rows = modelRoot.optJSONArray("data") ?: modelRoot.optJSONArray("models") ?: org.json.JSONArray()
        val models = mutableListOf<String>(); val efforts = linkedSetOf<String>(); val tiers = linkedSetOf<String>()
        val effortsByModel = linkedMapOf<String, List<String>>()
        var defaultModel: String? = null
        val defaultEffortByModel = linkedMapOf<String, String>(); val tiersByModel = linkedMapOf<String, List<String>>()
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val modelId = row.optString("id", row.optString("model")).takeIf(String::isNotBlank)
            modelId?.let(models::add)
            val modelEfforts = mutableListOf<String>()
            val effortRows = row.optJSONArray("supportedReasoningEfforts")
            if (effortRows != null) for (j in 0 until effortRows.length()) {
                val value = effortRows.opt(j)
                val effort = if (value is JSONObject) value.optString("reasoningEffort") else value.toString()
                efforts += effort
                modelEfforts += effort
            }
            if (modelId != null) effortsByModel[modelId] = orderedReasoningEfforts(modelEfforts)
            if (modelId != null && row.optBoolean("isDefault")) defaultModel = modelId
            row.optString("defaultReasoningEffort").takeIf { it.isNotBlank() && it != "null" }?.let { if (modelId != null) defaultEffortByModel[modelId] = it }
            // Newer Codex lists fast mode in additionalSpeedTiers; older ones used serviceTiers.
            // Some list it in both, as "fast" and "priority": that is one choice.
            val modelTiers = linkedSetOf<String>()
            for (key in listOf("additionalSpeedTiers", "serviceTiers")) {
                val tierRows = row.optJSONArray(key) ?: continue
                for (j in 0 until tierRows.length()) {
                    val value = tierRows.opt(j)
                    (if (value is JSONObject) value.optString("id") else value.toString()).takeIf { it.isNotBlank() }?.let(modelTiers::add)
                }
            }
            if ("fast" in modelTiers) modelTiers -= "priority"
            tiers += modelTiers
            if (modelId != null) tiersByModel[modelId] = modelTiers.toList()
        }
        val limitsRoot = result.optJSONObject(1)
        val limits = limitsRoot?.optJSONObject("rateLimits")
        val quotaError = limitsRoot?.optString("error")?.takeIf { it.isNotBlank() }
        val liveQuota = weeklyQuotaFrom(limits)
        if (liveQuota != null || quotaError == null) {
            capabilitiesRetryCount = 0
            capabilitiesRetryJob?.cancel()
        } else if (capabilitiesRetryCount < 3) {
            val attempt = capabilitiesRetryCount++
            capabilitiesRetryJob?.cancel()
            capabilitiesRetryJob = scope.launch {
                delay(2_000L shl attempt)
                if (relayConnected && _connection.value == ConnectionState.Online) runCatching { command("capabilities") }
            }
        }
        val collaborationRows = result.optJSONObject(3)?.optJSONArray("data") ?: org.json.JSONArray()
        val collaborationModes = buildList {
            for (i in 0 until collaborationRows.length()) {
                val row = collaborationRows.optJSONObject(i)
                val mode = row?.optString("mode")?.ifBlank { row.optString("name") }
                    ?: collaborationRows.optString(i)
                if (mode.equals("plan", true) || mode.equals("default", true)) add(mode.lowercase())
            }
        }.distinct()
        _capabilities.value = _capabilities.value.copy(
            models = models.distinct(),
            efforts = orderedReasoningEfforts(efforts),
            tiers = tiers.distinct(),
            effortsByModel = effortsByModel,
            collaborationModes = collaborationModes,
            codexSandboxBlocked = result.optJSONObject(2)?.optBoolean("sandboxShellBlocked") == true,
            defaultModel = defaultModel,
            defaultEffortByModel = defaultEffortByModel,
            tiersByModel = tiersByModel,
        )
        limitsRoot?.let(::applyCodexUsage)
    }

    private fun parseThreadSettings(value: JSONObject): ThreadSettings {
        fun text(vararg keys: String): String? = keys.asSequence()
            .map { value.optString(it) }
            .firstOrNull { it.isNotBlank() && it != "null" }
        val approval = text("approvalPolicy", "approval_policy")
        val sandboxValue = value.opt("sandboxPolicy").takeUnless { it == null || it == JSONObject.NULL }
            ?: value.opt("sandbox_policy")
        val sandbox = when (sandboxValue) {
            is JSONObject -> sandboxValue.optString("type").takeIf { it.isNotBlank() }
            else -> sandboxValue?.toString()?.takeIf { it.isNotBlank() && it != "null" }
        }
        val permission = text("permissionMode", "permission_mode", "mode") ?: when {
            approval == "never" || sandbox?.contains("danger", true) == true -> "yolo"
            approval == "on-request" -> "auto"
            else -> "manual"
        }
        fun collaborationMode(key: String): String? {
            val collaborationValue = value.opt(key)
            return when (collaborationValue) {
            is JSONObject -> collaborationValue.optString("mode")
            else -> collaborationValue?.toString().orEmpty()
            }.takeIf { it.isNotBlank() && it != "null" }
                ?.let { if (it.equals("plan", true)) "plan" else "default" }
        }
        val collaboration = collaborationMode("effectiveCollaborationMode")
            ?: collaborationMode("collaborationMode")
            ?: "default"
        val desiredCollaboration = collaborationMode("desiredCollaborationMode") ?: collaboration
        return ThreadSettings(
            model = text("model"),
            effort = text("effort", "reasoningEffort", "reasoning_effort"),
            serviceTier = text("serviceTier", "service_tier"),
            approvalPolicy = approval,
            approvalsReviewer = text("approvalsReviewer", "approvals_reviewer"),
            sandboxPolicy = sandbox,
            permissionMode = permission,
            collaborationMode = collaboration,
            effectiveCollaborationMode = collaboration,
            desiredCollaborationMode = desiredCollaboration,
            modeSyncState = text("modeSyncState", "mode_sync_state") ?: "applied",
            modeSyncReason = text("reason", "modeSyncReason", "mode_sync_reason"),
            nextTurn = value.optBoolean("nextTurn"),
            pendingDesktop = value.optBoolean("pendingDesktop"),
        )
    }

    private fun applyThreadSettings(threadId: String, value: JSONObject, updatedAt: Long) {
        val eventAt = updatedAt.takeIf { it > 0L } ?: System.currentTimeMillis()
        val previousAt = threadSettingsUpdatedAt[threadId] ?: Long.MIN_VALUE
        if (eventAt < previousAt) {
            Log.d(LOG_TAG, "ignored stale settings thread=$threadId at=$eventAt latest=$previousAt")
            return
        }
        val incoming = parseThreadSettings(value)
        val current = _threadSettings.value[threadId]
        // While either mode switch is queued behind a Desktop-owned turn,
        // rollout polling can replay the previous mode with a newer timestamp.
        // Do not let that observer snapshot erase the user's pending choice;
        // an explicit pending/failed event or a matching confirmed event may
        // still replace it.
        val desired = current?.desiredCollaborationMode
        val incomingMode = incoming.effectiveCollaborationMode
        if (current?.modeSyncState == "pending" &&
            !desired.isNullOrBlank() &&
            incoming.modeSyncState == "applied" &&
            incomingMode != desired &&
            incoming.desiredCollaborationMode != desired) {
            Log.d(LOG_TAG, "ignored stale settings while $desired is pending thread=$threadId incoming=$incomingMode")
            return
        }
        threadSettingsUpdatedAt[threadId] = eventAt
        _threadSettings.value = _threadSettings.value + (threadId to incoming)
    }

    private suspend fun trimCache() {
        val file = context.getDatabasePath("fengzhu-cache.db")
        if (file.exists() && file.length() > 500L * 1024 * 1024) database.cache().trimItems(300)
    }

    private fun historyCacheTimestampKey(threadId: String) = "syncedAt:$threadId"
    private fun historyCacheHasMoreKey(threadId: String) = "hasMore:$threadId"
    private fun historyCacheForceRefreshKey(threadId: String) = "forceRefresh:$threadId"

    private fun refreshAfterAgentAccountChange(backend: String) {
        requestThreadsRefresh()
        val id = activeThreadId ?: return
        if (_threads.value.firstOrNull { it.id == id }?.backend != backend) return
        Log.d(LOG_TAG, "agent account changed: refreshing current $backend conversation")
        // Read the computer again, not only its already-cached relay page.
        // These commands preserve the draft, scrollback and pending messages.
        requestHistoryBackfill(id)
        runCatching { loadThreadSettings(id) }
        scheduleActiveHistoryRefresh(id)
    }

    /**
     * Refresh the active conversation without cancelling an in-flight read.
     *
     * The connector may emit several history.updated frames while it is
     * tailing a large rollout.  The old implementation cancelled the current
     * HTTP request for every frame; on a busy thread that meant no request ever
     * reached the merge step and the phone stayed on its old cache forever.
     * Coalescing keeps one read alive and schedules a second pass when a frame
     * arrives during that read.
     */
    private fun scheduleActiveHistoryRefresh(threadId: String) {
        synchronized(historyRefreshLock) {
            if (activeThreadId != threadId) return
            historyRefreshPending.set(true)
            if (historyRefreshJob?.isActive == true) return
            val generation = ++historyRefreshGeneration
            historyRefreshJob = scope.launch {
                try {
                    while (isActive && activeThreadId == threadId) {
                        if (!historyRefreshPending.compareAndSet(true, false)) break
                        delay(250)
                        if (!isActive || activeThreadId != threadId) break
                        try {
                            loadThread(threadId, mergeLatest = true)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Exception) {
                            Log.w(LOG_TAG, "active history refresh failed thread=$threadId", error)
                        }
                    }
                } finally {
                    val restart = synchronized(historyRefreshLock) {
                        val current = historyRefreshGeneration == generation
                        if (current) historyRefreshJob = null
                        current && activeThreadId == threadId && historyRefreshPending.get()
                    }
                    if (restart) scheduleActiveHistoryRefresh(threadId)
                }
            }
        }
    }

    private fun shouldRequestHistoryBackfill(
        threadId: String,
        cached: List<HistoryItem>,
        latest: List<HistoryItem>,
    ): Boolean {
        val now = System.currentTimeMillis()
        val lastRequested = historyBackfillRequestedAt[threadId] ?: 0L
        if (now - lastRequested < HISTORY_BACKFILL_REQUEST_INTERVAL_MS) return false
        val cacheSyncedAt = historyCachePrefs.getLong(historyCacheTimestampKey(threadId), 0L)
        val cacheExpired = now - cacheSyncedAt >= HISTORY_CACHE_REFRESH_INTERVAL_MS
        val forced = historyCachePrefs.getBoolean(historyCacheForceRefreshKey(threadId), false)
        val cachedLatestAt = cached.maxOfOrNull { historyItemTimestamp(it) ?: 0L } ?: 0L
        val serverLatestAt = latest.maxOfOrNull { historyItemTimestamp(it) ?: 0L } ?: 0L
        val serverHasNewerItem = serverLatestAt > cachedLatestAt + 1_000L
        // The relay's thread summary and the history page are eventually
        // consistent.  A thread can therefore look fresh in Room while the
        // connector has appended newer rollout records that have not emitted
        // a history.updated event (for example after a phone resume).  The
        // first open while the socket is online is a cheap, idempotent probe:
        // the connector de-duplicates unchanged digests and only tails a file
        // that actually grew.  The per-thread cooldown above prevents a
        // Compose re-entry or a burst of lifecycle callbacks from flooding
        // history.sync.
        val onlineProbe = _connection.value == ConnectionState.Online
        return onlineProbe || forced || cacheExpired || cached.isEmpty() || latest.isEmpty() || serverHasNewerItem || historyCacheNeedsLatest(threadId, cached)
    }

    private fun requestHistoryBackfill(threadId: String) {
        val requestedAt = System.currentTimeMillis()
        historyBackfillRequestedAt[threadId] = requestedAt
        markHistorySyncing(threadId, true)
        runCatching {
            command("history.sync", threadId, JSONObject().put("threadId", threadId))
        }.onFailure {
            markHistorySyncing(threadId, false)
            historyBackfillRequestedAt.remove(threadId, requestedAt)
            Log.w(LOG_TAG, "history backfill request failed thread=$threadId", it)
        }
    }

    private fun historyCacheNeedsLatest(threadId: String, cached: List<HistoryItem>): Boolean {
        val threadUpdatedAt = _threads.value.firstOrNull { it.id == threadId }?.updatedAt ?: return false
        val cachedLatestAt = cached.maxOfOrNull { historyItemTimestamp(it) ?: 0L } ?: return false
        return threadUpdatedAt > cachedLatestAt + 1_000L
    }

    private fun saveHistoryCacheState(threadId: String, hasMore: Boolean) {
        historyCachePrefs.edit()
            .putLong(historyCacheTimestampKey(threadId), System.currentTimeMillis())
            .putBoolean(historyCacheHasMoreKey(threadId), hasMore)
            .putBoolean(historyCacheForceRefreshKey(threadId), false)
            .apply()
    }

    private suspend fun replayEvents(snapshotSequence: Long?, buffer: OrderedReplayBuffer<JSONObject>, webSocket: WebSocket, apply: (JSONObject) -> Unit) {
        val pageLimit = 500
        // A fresh install (or a reset sequence) used to replay every event the
        // relay still keeps, days of them, before anything new or any command
        // result could show. History and the thread list come from their own
        // APIs; only recent events (pending approvals, questions, live state)
        // matter here.
        var cursor = freshReplayStart(lastSequence, snapshotSequence, FRESH_REPLAY_EVENTS)
        if (cursor != lastSequence) Log.i(LOG_TAG, "event replay starts near the snapshot after=$cursor snapshot=$snapshotSequence")
        var pages = 0
        var processed = 0
        val startedAt = android.os.SystemClock.elapsedRealtime()
        fun completed() = Log.i(LOG_TAG, "event replay completed pages=$pages frames=$processed elapsedMs=${android.os.SystemClock.elapsedRealtime() - startedAt}")
        if (snapshotSequence != null && cursor >= snapshotSequence) return
        while (true) {
            if (socket !== webSocket) throw CancellationException("连接已切换")
            val response = get("/api/${if (usingV2()) "v2" else "v1"}/events?after=$cursor&limit=$pageLimit")
            pages += 1
            val array = response.getJSONArray("items")
            for (i in 0 until array.length()) {
                val frame = array.getJSONObject(i)
                val sequence = frame.optLong("sequence")
                check(sequence > cursor) { "事件回放顺序无效" }
                if (snapshotSequence != null && sequence > snapshotSequence) { completed(); return }
                if (!buffer.replay(frame, apply)) throw CancellationException("连接已切换")
                cursor = sequence
                processed += 1
            }
            if (replayPageFinished(array.length(), pageLimit, cursor, snapshotSequence)) { completed(); return }
            yield()
        }
    }

    private fun decodeThread(row: JSONObject, readSnapshot: ThreadReadSnapshot): ThreadSummary? = runCatching {
        val id = row.getString("id"); val value = crypto.decrypt("history.thread", id, id, row.getString("nonce"), row.getString("ciphertext"))
        val activityAt = if (value.has("activityAt") && !value.isNull("activityAt")) value.optLong("activityAt").coerceAtLeast(0L) else null
        val updatedAt = activityAt ?: value.optLong("updatedAt")
        ThreadSummary(id, value.optString("title", "Codex task"), value.optString("cwd"), value.opt("status")?.toString() ?: "idle",
            updatedAt, value.optBoolean("archived"), row.optString("connectorId"),
            value.optBoolean("pinned"), value.optInt("pinOrder", -1),
            effectiveUnread(value.optBoolean("unread"), updatedAt, readSnapshot.readAt(id)),
            value.optString("backend", "codex").ifBlank { "codex" },
            value.optString("note").takeIf { it != "null" }.orEmpty(),
            value.optBoolean("desktopLive"),
            parseDesktopWaiting(value.optJSONObject("waiting")),
            value.optString("model").takeIf { it != "null" }.orEmpty(),
            readSnapshot.readAt(id),
            activityAt, codexQuestions = parseCodexQuestionState(id, value.optJSONObject("codexQuestions")),
            desktopId = value.optString("desktopId").takeIf { it != "null" }.orEmpty())
    }.getOrNull()

    private fun parseDesktopWaiting(value: JSONObject?): DesktopWaiting? = value?.let { w ->
        fun JSONObject.text(key: String) = optString(key).takeIf { it != "null" }.orEmpty()
        val questions = w.optJSONArray("questions")?.let { array ->
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }.map { q ->
                val options = q.optJSONArray("options")?.let { opts ->
                    (0 until opts.length()).mapNotNull { opts.optJSONObject(it) }.map { WaitingOption(it.text("label"), it.text("description")) }
                }.orEmpty()
                WaitingQuestion(q.text("question"), q.text("header"), q.optBoolean("multiSelect"), options, q.optBoolean("allowOther", true))
            }
        }.orEmpty()
        DesktopWaiting(w.text("kind"), w.text("tool"), w.text("requestId"), w.text("summary"), w.text("description"), questions,
            phoneCanAnswer = w.optBoolean("answerable", true), autoOption = w.optBoolean("autoOption", true))
    }

    /** Pi: the models PI WEB offers for this session, and its current model / thinking level. */
    suspend fun piModels(threadId: String): PiModelChoice = withContext(Dispatchers.IO) {
        val result = commandResult(requestCommand("pi.models", threadId, JSONObject().put("threadId", threadId), 75_000))
        val models = result.optJSONObject("catalog")?.optJSONArray("models")?.let { array ->
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }.filter { it.optBoolean("enabled", true) }.map {
                PiModel(it.optString("provider"), it.optString("id"), it.optString("name").ifBlank { it.optString("id") }, it.optLong("contextWindow"), it.optBoolean("reasoning"))
            }
        }.orEmpty()
        val levels = result.optJSONObject("thinkingLevels")?.optJSONArray("levels")?.let { array -> (0 until array.length()).map { array.optString(it) } }.orEmpty()
        val status = result.optJSONObject("status")
        val model = status?.optJSONObject("model")
        PiModelChoice(models, levels, model?.let { "${it.optString("provider")}/${it.optString("id")}" }.orEmpty(), status?.optString("thinkingLevel").orEmpty())
    }

    /** Pi relay providers from PI WEB (no API keys, only whether one is saved). */
    suspend fun piProviders(): List<PiProvider> = withContext(Dispatchers.IO) {
        val array = commandResult(requestCommand("pi.providers.list", null, JSONObject(), 30_000)).optJSONArray("providers") ?: return@withContext emptyList()
        (0 until array.length()).mapNotNull { array.optJSONObject(it) }.map { p ->
            val models = p.optJSONArray("models")?.let { m -> (0 until m.length()).mapNotNull { m.optJSONObject(it) } }.orEmpty().map { m ->
                val cost = m.optJSONObject("cost")
                fun price(key: String) = cost?.opt(key)?.takeIf { it is Number }?.toString()?.removeSuffix(".0").orEmpty()
                PiProviderModel(m.optString("id"), price("input"), price("output"), m.optLong("contextWindow").takeIf { it > 0 }?.toString().orEmpty())
            }
            PiProvider(p.optString("id"), p.optString("name"), p.optString("baseUrl"), p.optString("api"), p.optBoolean("hasKey"), models, p.optString("revision"))
        }
    }

    /**
     * Save a Pi relay provider. [apiKey] blank keeps the saved key; it is sent
     * end-to-end encrypted to the computer, which hands it to PI WEB only.
     */
    suspend fun savePiProvider(provider: PiProvider, apiKey: String) = withContext(Dispatchers.IO) {
        val models = org.json.JSONArray()
        provider.models.filter { it.id.isNotBlank() }.forEach { m ->
            val cost = JSONObject()
            m.inputCost.toDoubleOrNull()?.let { cost.put("input", it) }
            m.outputCost.toDoubleOrNull()?.let { cost.put("output", it) }
            models.put(JSONObject().put("id", m.id.trim()).apply {
                if (cost.length() > 0) put("cost", cost)
                m.contextWindow.toLongOrNull()?.takeIf { it > 0 }?.let { put("contextWindow", it) }
            })
        }
        val body = JSONObject().put("id", provider.id).put("name", provider.name.trim()).put("baseUrl", provider.baseUrl.trim())
            .put("api", provider.api).put("models", models)
        if (provider.revision.isNotBlank()) body.put("revision", provider.revision)
        if (apiKey.isNotBlank()) body.put("apiKey", apiKey)
        val result = commandResult(requestCommand("pi.providers.save", null, JSONObject().put("provider", body), 30_000))
        check(result.optBoolean("saved")) { result.optString("error").ifBlank { "保存失败" } }
    }

    /** Answer a desktop prompt; throws with the computer's reason when it could not. */
    suspend fun answerDesktopPrompt(threadId: String, requestId: String, choice: String?, answers: List<QuestionAnswer>?, feedback: String?) {
        val args = JSONObject().put("threadId", threadId).put("requestId", requestId)
        if (choice != null) args.put("choice", choice)
        if (answers != null) args.put("answers", org.json.JSONArray(answers.map { JSONObject().put("labels", org.json.JSONArray(it.labels)).put("other", it.other) }))
        if (!feedback.isNullOrBlank()) args.put("feedback", feedback)
        val result = requestCommand("claude.desktop.answer", threadId, args, 60_000)
        check(result.optBoolean("ok")) { result.optString("error").takeIf { it.isNotBlank() && it != "null" } ?: "电脑端没能处理" }
    }

    // updatedAt is the computer's time for the change. null = the phone's own
    // optimistic guess (it just sent something): shown at once, but it does
    // not move the watermark. The phone clock can run seconds ahead of the
    // computer's (seen: 6 s), and a guess stamped with it made the computer's
    // own "completed" for a quick turn look stale: the task stayed "running"
    // and no reminder came.
    private fun setLiveStatus(threadId: String, status: String, updatedAt: Long? = null, turnId: String? = null, quiet: Boolean = false) {
        if (updatedAt == null) {
            updateTurnDuration(threadId, status, System.currentTimeMillis(), turnId, quiet)
            if (_liveStatuses.value[threadId] != status) _liveStatuses.value = _liveStatuses.value + (threadId to status)
            return
        }
        val eventAt = updatedAt.takeIf { it > 0 } ?: System.currentTimeMillis()
        val previousAt = liveStatusUpdatedAt[threadId] ?: Long.MIN_VALUE
        if (eventAt < previousAt) {
            Log.d(LOG_TAG, "ignored stale status thread=$threadId status=$status at=$eventAt latest=$previousAt")
            return
        }
        if (shouldIgnoreBusyStatusReplay(status, lastCompletedTurnId[threadId], turnId)) {
            // The connector may finish a turn, then an older watcher slice
            // arrives with that same turn's progress records. Keep the
            // terminal state and do not schedule a second reminder.
            Log.d(LOG_TAG, "ignored terminal-turn replay thread=$threadId turn=$turnId status=$status")
            return
        }
        // Keep the terminal identity even when the phone did not observe the
        // matching start (for example, it was backgrounded). This still lets
        // a same-turn running replay be discarded without manufacturing a
        // second duration or completion reminder.
        // A silent completion is not a terminal identity: the same turn may still resume.
        if (!quiet && status.lowercase() in setOf("completed", "failed", "cancelled", "canceled", "aborted", "interrupted") &&
            turnStartedAt[threadId] == null && !turnId.isNullOrBlank()) {
            lastCompletedTurnId[threadId] = turnId
        }
        liveStatusUpdatedAt[threadId] = eventAt
        if (!quiet && status.lowercase() in setOf("completed", "failed", "cancelled", "canceled", "aborted", "interrupted")) {
            _codexQuestionStates.value[threadId]?.takeIf { question ->
                question.pending && eventAt >= question.askedAt && (turnId.isNullOrBlank() || question.turnId == null || question.turnId == turnId)
            }?.let { applyCodexQuestionState(it.copy(questions = emptyList(), updatedAt = maxOf(it.updatedAt, eventAt)), notify = false) }
        }
        updateTurnDuration(threadId, status, eventAt, turnId, quiet)
        if (_liveStatuses.value[threadId] == status) return
        Log.d(LOG_TAG, "live status thread=$threadId status=$status at=$eventAt")
        _liveStatuses.value = _liveStatuses.value + (threadId to status)
    }

    private fun withDesktopPinSnapshots(items: List<ThreadSummary>): List<ThreadSummary> =
        withDesktopPins(withDesktopCodexPins(items, desktopCodexPins), desktopClaudePins, "claude")

    private fun reconcileDesktopCodexPins(payload: JSONObject) =
        reconcileDesktopPins(payload, "codexPins", "codex", desktopCodexPins, desktopCodexPinsAt)

    private fun reconcileDesktopClaudePins(payload: JSONObject) =
        reconcileDesktopPins(payload, "claudePins", "claude", desktopClaudePins, desktopClaudePinsAt)

    private fun reconcileDesktopPins(
        payload: JSONObject,
        key: String,
        backend: String,
        pins: MutableMap<String, List<String>>,
        pinsAt: MutableMap<String, Long>,
    ) {
        // Missing means an older/offline connector; an explicit empty list
        // means Desktop has no pins. Do not turn missing data into an unpin.
        val snapshot = payload.optJSONObject(key) ?: return
        val connectorId = snapshot.optString("connectorId").takeIf { it.isNotBlank() && it != "null" } ?: return
        val array = snapshot.optJSONArray("ids") ?: return
        val at = payload.optLong("sentAt")
        if (at <= 0 || at < (pinsAt[connectorId] ?: 0)) return
        val ids = (0 until array.length()).map { array.opt(it) }
        if (ids.any { it !is String || it.isBlank() }) return
        val next = ids.filterIsInstance<String>().distinct()
        pinsAt[connectorId] = at
        // Legacy CachedThread rows omit connectorId. Fetch their ownership
        // once after startup so an old page's pins can be reconciled too,
        // without guessing that another computer's tasks belong to this one.
        if (desktopPinOwnershipRefresh == null && _threads.value.any { backendTab(it.backend) == backend && it.connectorId.isBlank() }) {
            desktopPinOwnershipRefresh = scope.launch {
                runCatching { refreshThreads(full = true) }
                    .onFailure { desktopPinOwnershipRefresh = null }
            }
        }
        if (pins.put(connectorId, next) == next) return
        _threads.value = sortThreadSummaries(withDesktopPinSnapshots(_threads.value))
        requestThreadsRefresh()
    }

    private fun reconcileAgentOpenStates(payload: JSONObject) {
        val agents = payload.optJSONObject("agents") ?: return
        val connectorId = payload.optString("connectorId").takeIf { it.isNotBlank() && it != "null" } ?: return
        payload.optJSONObject("installed")?.let { installed ->
            val map = installed.keys().asSequence().mapNotNull { id -> (installed.opt(id) as? Boolean)?.let { id to it } }.toMap()
            _agentInstalledByConnector.update { it + (connectorId to map) }
        }
        val at = payload.optLong("sentAt")
        if (at <= 0 || at < (agentSnapshots[connectorId]?.first ?: 0)) return
        val states = HOME_AGENT_IDS.mapNotNull { id -> (agents.opt(id) as? Boolean)?.let { id to it } }.toMap()
        agentSnapshots[connectorId] = at to states
        _agentOpenStatesByConnector.update { it + (connectorId to states) }
        if (_selectedConnectorId.value.isNullOrBlank() || _selectedConnectorId.value == connectorId) _agentOpenStates.value = states
    }

    private fun reconcileLiveStatusSnapshot(payload: JSONObject) {
        val rows = payload.optJSONArray("activeThreads") ?: return
        val active = buildMap {
            for (index in 0 until rows.length()) {
                val row = rows.optJSONObject(index) ?: continue
                val threadId = row.optString("threadId").takeIf { it.isNotBlank() } ?: continue
                val status = row.optString("status").takeIf { it.isNotBlank() } ?: continue
                put(threadId, status)
            }
        }
        val snapshotAt = payload.optLong("sentAt", 0L)
        val activeAt = buildMap {
            for (index in 0 until rows.length()) {
                val row = rows.optJSONObject(index) ?: continue
                val threadId = row.optString("threadId").takeIf { it.isNotBlank() } ?: continue
                val updatedAt = row.optLong("updatedAt", snapshotAt)
                if (updatedAt > 0L) put(threadId, updatedAt)
            }
        }
        val current = _liveStatuses.value
        // A delayed heartbeat must not roll a newer event back. Preserve any
        // currently-live row that is absent from an older snapshot; it can be
        // retired only by a snapshot observed at/after its last event time.
        val effectiveActive = buildMap {
            active.forEach { (threadId, status) ->
                val eventAt = activeAt[threadId] ?: snapshotAt
                val previousAt = liveStatusUpdatedAt[threadId]
                if (previousAt == null || eventAt <= 0L || eventAt >= previousAt) {
                    put(threadId, status)
                } else {
                    // Keep a newer local status, if one exists; otherwise the
                    // stale snapshot is ignored rather than resurrecting it.
                    current[threadId]?.let { put(threadId, it) }
                }
            }
        }.toMutableMap()
        current.forEach { (threadId, status) ->
            if (threadId in active || !isTurnBusyStatus(status)) return@forEach
            val previousAt = liveStatusUpdatedAt[threadId]
            val canRetire = snapshotAt <= 0L || previousAt == null || snapshotAt >= previousAt
            if (!canRetire) effectiveActive[threadId] = status
        }
        val knownThreads = _threads.value.associate { it.id to it.status }
        var next = reconcileLiveStatusSnapshot(current, effectiveActive, knownThreads)
        // Only this computer's tasks: other computers have their own snapshot.
        // A missing Codex row is not proof its turn finished; show unknown
        // until an explicit terminal event or a later live snapshot arrives.
        val connectorId = payload.optString("connectorId").takeIf { it.isNotBlank() && it != "null" }
        if (connectorId != null) {
            val ownThreads = _threads.value.filter { it.connectorId == connectorId }
            val ownIds = ownThreads.mapTo(HashSet()) { it.id }
            val retired = retireLongAbsentBusyStatuses(next.filterKeys { it in ownIds }, active.keys, liveAbsentSince, snapshotAt, liveStatusUpdatedAt)
            if (retired.isNotEmpty()) {
                Log.d(LOG_TAG, "retired stale running statuses ${retired.joinToString()}")
                next = applyAbsentStatusRetirement(next, retired, ownThreads.associate { it.id to it.backend })
            }
        }
        // Do not stamp snapshots with the phone receive time. A heartbeat can
        // be delivered after a newer status event, and that local timestamp
        // would make the event look stale forever. Keep the desktop's
        // observation time as the ordering source instead.
        activeAt.forEach { (threadId, updatedAt) ->
            val previousAt = liveStatusUpdatedAt[threadId] ?: Long.MIN_VALUE
            if (updatedAt >= previousAt) liveStatusUpdatedAt[threadId] = updatedAt
        }
        // Absence from a heartbeat is intentionally not a terminal event. The
        // connector may be between polls, may send a partial snapshot while it
        // is recovering, or may have raced a status frame. Only an explicit
        // thread.status/codex terminal event should announce completion and
        // close the duration; otherwise a running task briefly looked finished
        // and then reappeared on the next heartbeat.
        if (next != current) _liveStatuses.value = next
        active.forEach { (id, status) -> noteWaiting(id, status, activeAt[id] ?: 0L) }
    }

    // A waiting status newer than the last look (the connector stamps it with
    // the time the prompt appeared): fetch what the prompt asks, which also
    // raises the reminder (announceWaitingPrompts). Once per prompt.
    private val waitingSeenAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    @Volatile private var waitingFetch: kotlinx.coroutines.Job? = null
    private fun noteWaiting(threadId: String, status: String, updatedAt: Long) {
        if (!isWaitingThreadStatus(status) || updatedAt <= 0L) return
        if (updatedAt <= (waitingSeenAt[threadId] ?: 0L)) return
        waitingSeenAt[threadId] = updatedAt
        if (waitingFetch?.isActive == true) return
        waitingFetch = scope.launch { delay(1_500); runCatching { refreshThreads() } }
    }

    private fun turnDurationStartedKey(threadId: String) = "turnStarted:$threadId"
    private fun turnDurationCompletedKey(threadId: String) = "turnCompleted:$threadId"
    private fun turnDurationMsKey(threadId: String) = "turnDurationMs:$threadId"
    private fun turnDurationStatusKey(threadId: String) = "turnDurationStatus:$threadId"

    private fun restoreTurnDuration(threadId: String) {
        if (_turnDurations.value.containsKey(threadId)) return
        val duration = historyCachePrefs.getLong(turnDurationMsKey(threadId), 0L)
        if (duration <= 0L) return
        _turnDurations.value = _turnDurations.value + (threadId to TurnDuration(
            startedAt = historyCachePrefs.getLong(turnDurationStartedKey(threadId), 0L),
            completedAt = historyCachePrefs.getLong(turnDurationCompletedKey(threadId), 0L),
            durationMs = duration,
            terminalStatus = historyCachePrefs.getString(turnDurationStatusKey(threadId), "completed") ?: "completed",
        ))
    }

    private fun markTurnStarted(threadId: String, at: Long = System.currentTimeMillis(), turnId: String? = null) {
        if (threadId.isBlank() || at <= 0L) return
        if (isSameTurnStatusReplay(lastCompletedTurnId[threadId], turnId)) return
        val afterSilence = silentlyEnded.remove(threadId)
        pendingTurnEnds.remove(threadId)?.let { (start, job) ->
            job.cancel()
            Log.d(LOG_TAG, "turn end withdrawn thread=$threadId (running again)")
            turnStartedAt[threadId] = start
            if (!turnId.isNullOrBlank()) turnStartedTurnId[threadId] = turnId
            return
        }
        // After a silent end, a different turn id is a new turn: time it from now,
        // not from the older turn whose end was never seen.
        val timed = turnStartedTurnId[threadId]
        if (afterSilence && !turnId.isNullOrBlank() && timed != null && timed != turnId) {
            turnStartedAt.remove(threadId)
            turnStartedTurnId.remove(threadId)
        }
        turnStartedAt.putIfAbsent(threadId, at)
        if (!turnId.isNullOrBlank()) turnStartedTurnId.putIfAbsent(threadId, turnId)
    }

    private fun updateTurnDuration(threadId: String, status: String, eventAt: Long, turnId: String? = null, quiet: Boolean = false) {
        if (threadId.isBlank()) return
        val normalized = status.lowercase()
        if (shouldClearUnknownTurnTracking(normalized, quiet)) {
            // A turn abandoned before the computer reboot has no proven end.
            // Drop its old timer and any delayed notice; a later real turn
            // starts a fresh timer and can still announce its actual end.
            pendingTurnEnds.remove(threadId)?.second?.cancel()
            turnStartedAt.remove(threadId)
            turnStartedTurnId.remove(threadId)
            silentlyEnded.remove(threadId)
            return
        }
        // After a reconnect the relay replays old status events (seen: days
        // old, a "running" then a "completed" for every pinned task). Timed on
        // arrival they looked like one-second turns and rang a false
        // "已完成" for each. An old "running" must not start a turn; an old
        // end still closes a turn the phone saw start live (it may have
        // finished while the phone was away).
        if ((isTurnBusyStatus(status) || normalized == "compacting") && isStaleStatusEvent(eventAt, System.currentTimeMillis())) return
        // Both ends are timed on the phone's clock, when the status arrives: the
        // computer's clock can differ by seconds, and a start and an end from
        // different clocks gave zero or negative turns (no reminder at all).
        if (isTurnBusyStatus(status) || normalized == "compacting") {
            if (shouldIgnoreBusyStatusReplay(status, lastCompletedTurnId[threadId], turnId)) return
            markTurnStarted(threadId, turnId = turnId)
            return
        }
        if (normalized !in setOf("completed", "failed", "cancelled", "canceled", "idle")) return
        // A completion read from silence (no end event: a long command or a quiet
        // model step) only clears the badge. The turn may still be running, so its
        // start is kept, nothing is timed, and no reminder is made. Its real end,
        // when it comes, is announced as usual.
        if (isSilentCompletion(normalized, quiet)) { silentlyEnded.add(threadId); return }
        silentlyEnded.remove(threadId)
        // The persisted turnDurationStartedKey only ever holds the start time
        // of the LAST turn this function already computed a duration for — it
        // is written here, not when a turn starts. Falling back to it for a
        // stray/duplicate terminal event (no in-memory turnStartedAt entry,
        // e.g. a status replay after a connector reconnect) recomputed a
        // larger and larger bogus duration against that same old start time
        // every time, without ever converging. Only a live-tracked start
        // (markTurnStarted, or the busy-inference above) is trustworthy here.
        val started = turnStartedAt[threadId] ?: return
        val completedTurnId = turnId?.takeIf { it.isNotBlank() } ?: turnStartedTurnId[threadId]
        if (isSameTurnStatusReplay(lastCompletedTurnId[threadId], completedTurnId)) return
        val completed = maxOf(System.currentTimeMillis(), started)
        val duration = completed - started
        if (duration <= 0L) return
        turnStartedAt.remove(threadId)
        turnStartedTurnId.remove(threadId)
        if (!completedTurnId.isNullOrBlank()) lastCompletedTurnId[threadId] = completedTurnId
        historyCachePrefs.edit()
            .putLong(turnDurationStartedKey(threadId), started)
            .putLong(turnDurationCompletedKey(threadId), completed)
            .putLong(turnDurationMsKey(threadId), duration)
            .putString(turnDurationStatusKey(threadId), normalized)
            .apply()
        _turnDurations.value = _turnDurations.value + (threadId to TurnDuration(started, completed, duration, normalized))
        pendingTurnEnds.remove(threadId)?.second?.cancel()
        // A failure is said at once; a turn of a second or two is a replayed or
        // flickering status, not work done (seen after a connector restart).
        if (normalized == "failed") { announceTurnEnd(threadId, normalized, duration); return }
        if (duration < MIN_ANNOUNCED_TURN_MS) return
        val job = scope.launch {
            delay(TURN_END_SETTLE_MS)
            if (pendingTurnEnds[threadId]?.first == started) pendingTurnEnds.remove(threadId)
            announceTurnEnd(threadId, normalized, duration)
        }
        pendingTurnEnds[threadId] = started to job
    }

    private companion object {
        const val LOG_TAG = "FengzhuBridge"
        // A file.read chunk's bytes, put on the decrypted payload (never serialised).
        private const val FILE_BLOB_FIELD = "_blob"
        private const val FETCH_CHUNK = 512 * 1024
        // Three chunks keep a fast link busy; more only queue on a slow computer upload
        // (~70 KB/s seen), where each waits behind the others for its reply.
        private const val FETCH_PARALLEL = 3
        // Long enough for a chunk queued behind the others on such an upload.
        private const val FETCH_CHUNK_TIMEOUT_MS = 120_000L
        private const val FETCHED_META = ".khlink-fetched.json"
        const val TURN_END_SETTLE_MS = 20_000L
        const val MIN_ANNOUNCED_TURN_MS = 3_000L
        const val MAX_ATTACHMENT_BYTES = 25L * 1024L * 1024L
        const val UPLOAD_CHUNK_BYTES = 64 * 1024
        const val UPLOAD_READ_TIMEOUT_MS = 30_000L
        const val UPLOAD_OPERATION_TIMEOUT_MS = 180_000L
        const val HISTORY_CACHE_LIMIT = 6_000
        const val HISTORY_PAGE_SIZE = 30
        // Recently active conversations kept warm in the local cache.
        const val HISTORY_PREFETCH_THREADS = 8
        const val ONBOARDING_KEY = "onboarding_v1"
        // Events a fresh install replays before going live.
        const val FRESH_REPLAY_EVENTS = 500L
        // Opened as plain text: phones rarely have a viewer registered for these.
        val TEXT_EXTENSIONS = setOf("txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
            "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "kt", "kts", "java", "rs", "go", "c", "h", "cpp", "hpp",
            "cs", "sh", "ps1", "bat", "cmd", "sql", "gradle", "properties", "vue", "svelte", "rb", "php", "swift", "dart", "lua", "r", "tex")
        const val FULL_THREAD_SYNC_PAGE_SIZE = 100
        // 50 pages * 100 threads = 5000, comfortably above any real account's
        // thread count while still bounding a full paginated refresh's worst
        // case (a broken/never-ending `before` cursor) to a fixed number of
        // requests instead of looping forever.
        const val FULL_THREAD_SYNC_MAX_PAGES = 50
        const val FULL_THREAD_SYNC_DONE_KEY = "fullThreadSyncDone"
        // Keep the Room cursor well below Android's per-window limit. Large
        // assistant/tool records remain available through the online history
        // API and are deliberately not used as startup cache rows.
        // Keep a 6000-row cache bounded in memory; very large tool blobs are
        // still available from the online history endpoint when opened.
        const val HISTORY_CACHE_ITEM_MAX_CHARS = 64 * 1024
        const val HISTORY_CACHE_REFRESH_INTERVAL_MS = 30_000L
        const val HISTORY_BACKFILL_REQUEST_INTERVAL_MS = 10_000L
        const val HISTORY_SYNC_INDICATOR_TIMEOUT_MS = 45_000L
        const val HISTORY_SYNC_RECONNECT_PROBE_DELAY_MS = 250L
        val HISTORY_SYNC_MERGE_RETRY_DELAYS_MS = longArrayOf(1_500L, 5_000L, 12_000L)
        const val LEGAL_VERSION = LegalCopy.VERSION
        // A Claude desktop switch drives its window and can take 20-30 s; allow some room.
        const val SETTINGS_SWITCH_TIMEOUT_MS = 90_000L
        // The connector publishes a one-second presence heartbeat. Allow a
        // longer grace window because Android can suspend an IO dispatcher or
        // briefly pause the radio while an idle screen is open; a real dead
        // connection is still detected promptly enough for automatic recovery.
        const val CONNECTOR_HEARTBEAT_TIMEOUT_MS = 30_000L
        // Mobile radio resume and relay TLS handshakes can legitimately take
        // longer than twelve seconds. Allow one slow handshake to complete
        // before declaring a transport outage and starting another socket.
        const val CONNECT_ATTEMPT_TIMEOUT_MS = 20_000L
        // ColorOS can pause delivery of the one-second heartbeat for several
        // seconds while an activity is backgrounded, even though the
        // foreground service keeps the same socket alive. Do not tear down a
        // healthy transport on every short app switch; the 30s watchdog still
        // replaces a genuinely dead socket.
        const val RESUME_HEARTBEAT_GRACE_MS = 15_000L
        const val SEND_ACK_TIMEOUT_MS = 30_000L
        const val PAIRING_FALLBACK_TIMEOUT_MS = 10 * 60_000L
        const val KEY_WAIT_TIMEOUT_MS = 3 * 60_000L
    }

    private fun replaceFollowups(rows: org.json.JSONArray, sourceConnector: String? = null) {
        val grouped = mutableMapOf<String, MutableList<QueuedInstruction>>()
        // Each computer sends its own whole queue; another computer's rows stay.
        if (sourceConnector != null) {
            val owners = _threads.value.associate { it.id to it.connectorId }
            _queuedInstructions.value.forEach { (threadId, values) ->
                val owner = owners[threadId]
                if (!owner.isNullOrBlank() && owner != sourceConnector) grouped.getOrPut(threadId) { mutableListOf() }.addAll(values)
            }
        }
        for (i in 0 until rows.length()) rows.optJSONObject(i)?.let { row ->
            parseFollowup(row)?.let { grouped.getOrPut(row.optString("threadId")) { mutableListOf() }.add(it) }
        }
        val now = System.currentTimeMillis()
        // Keep locally-created rows that have not reached terminal state when
        // the connector refreshes its snapshot. The desktop may briefly omit a
        // mobile item while it is being dispatched; replacing the whole map
        // used to make a visible "待发送" message disappear when the user
        // left and re-entered the conversation.
        val transient = _queuedInstructions.value.flatMap { (threadId, values) ->
            values.filter { it.origin != "desktop" && it.state in setOf("pending", "dispatching", "desktop_queued", "sending", "started", "steered") }.map { item ->
                val antigravity = _threads.value.firstOrNull { it.id == threadId }?.backend == "antigravity"
                val expired = item.state == "sending" && now - item.createdAt >= if (antigravity) 90_000L else SEND_ACK_TIMEOUT_MS
                threadId to if (expired) item.copy(state = if (antigravity) "uncertain" else "failed",
                    reason = if (antigravity) "发送结果尚未确认，请检查电脑上的对话；请勿重复发送" else "发送回执超时，请重试") else item
            }
        }
        transient.forEach { (threadId, item) -> grouped.getOrPut(threadId) { mutableListOf() }.add(item) }
        _queuedInstructions.value = grouped.mapValues { (_, value) ->
            value.groupBy { it.id }.values.map { variants -> variants.reduce(::mergeQueuedInstruction) }
                .sortedBy { it.createdAt }
        }
        // A reconnect can deliver the follow-up snapshot after history.updated.
        // Reconcile once more so an already visible user message cannot be
        // reintroduced as a stale pending queue row.
        activeThreadId?.let { threadId -> reconcileDeliveredInstructions(threadId, _items.value) }
    }

    private fun upsertFollowup(row: JSONObject) {
        val item = parseFollowup(row) ?: return; val threadId = row.optString("threadId")
        upsertFollowup(threadId, item)
    }

    private fun upsertFollowup(threadId: String, item: QueuedInstruction) {
        confirmStartFeedback(threadId, item.id, item.state, item.startedAt)
        // The queued event is emitted at the desktop persistence boundary,
        // before UI dispatch. It is therefore a valid acknowledgement even
        // when the command.result frame is delayed or lost during reconnect.
        acknowledgePendingInstruction(item.id)
        val previous = _queuedInstructions.value[threadId].orEmpty().firstOrNull { it.id == item.id }
        val merged = previous?.let { mergeQueuedInstruction(it, item) } ?: item
        val current = _queuedInstructions.value[threadId].orEmpty().filterNot { it.id == item.id } + merged
        _queuedInstructions.value = _queuedInstructions.value + (threadId to current.sortedBy { it.createdAt })
    }

    private fun upsertOptimisticFollowup(threadId: String, item: QueuedInstruction) {
        if (_queuedInstructions.value[threadId].orEmpty().any { it.id == item.id }) return
        upsertFollowup(threadId, item)
    }

    private fun markFollowupState(threadId: String, id: String, state: String, reason: String? = null, confirmedAt: Long? = null) {
        if (id.isBlank()) return
        // History can retire the optimistic row before its receipt arrives.
        // Feedback is keyed by the submitted request, not by the visible row.
        val startedAt = confirmedAt ?: System.currentTimeMillis()
        confirmStartFeedback(threadId, id, state, startedAt)
        val item = _queuedInstructions.value[threadId].orEmpty().firstOrNull { it.id == id } ?: return
        upsertFollowup(threadId, item.copy(state = state, reason = reason,
            blocking = if (state in setOf("started", "steered")) false else item.blocking,
            startedAt = if (state in setOf("started", "steered")) startedAt else item.startedAt))
    }

    private fun startFeedbackKey(threadId: String, requestId: String) = "${usageCacheKey(threadId)}:$requestId"

    private fun persistStartFeedback() {
        // Identifiers/times only: no message, account identity or local path.
        startFeedbackPrefs.edit().putString("pending", JSONObject(startFeedback.snapshot()).toString()).apply()
    }

    private fun confirmStartFeedback(threadId: String, requestId: String, state: String, startedAt: Long?) {
        if (requestId.isBlank() || state !in setOf("started", "steered")) return
        val shouldPlay = synchronized(startFeedback) {
            val confirmed = startFeedback.confirm(startFeedbackKey(threadId, requestId), state, startedAt, System.currentTimeMillis())
            persistStartFeedback()
            confirmed
        }
        if (shouldPlay) KhVibration.started(context, appVisible)
    }

    private fun notifyFollowupFailure(threadId: String, id: String, reason: String) {
        val item = _queuedInstructions.value[threadId].orEmpty().firstOrNull { it.id == id } ?: return
        if (activeThreadId == threadId && isQueuedInstructionDelivered(item, _items.value)) {
            reconcileDeliveredInstructions(threadId, _items.value)
            return
        }
        val show = followupFailureNotices.claim(threadId, item, activeThreadId)
        followupNoticePrefs.edit().putStringSet("seen", followupFailureNotices.snapshot()).apply()
        if (show) _message.value = reason
    }

    private fun removeFollowup(id: String) {
        if (id.isBlank()) return
        _queuedInstructions.value = _queuedInstructions.value.mapValues { (_, value) -> value.filterNot { it.id == id } }.filterValues { it.isNotEmpty() }
    }

    private fun parseFollowup(row: JSONObject): QueuedInstruction? {
        val id = row.optString("id"); val text = row.optString("text"); val attachments = queuedAttachments(row.optJSONArray("attachments"))
        if (id.isBlank() || (text.isBlank() && attachments.isEmpty())) return null
        return QueuedInstruction(id, text, row.optLong("createdAt", System.currentTimeMillis()), row.optString("state", "pending"),
            row.optString("reason").takeIf { it.isNotBlank() && it != "null" }, row.optLong("startedAt").takeIf { it > 0 },
            row.optString("origin", "mobile"), attachments, row.optLong("stateVersion"),
            row.optBoolean("blocking", true), row.optLong("historyAfterOrder").takeIf { row.has("historyAfterOrder") && !row.isNull("historyAfterOrder") }, row.optBoolean("queueRequested", false))
    }

    private fun reconcileDeliveredInstructions(threadId: String, history: List<HistoryItem>) {
        val delivered = history.asSequence().filter { it.type == "userMessage" }.map { normalizeInstructionText(it.text) }.toSet()
        if (delivered.isEmpty()) return
        // Desktop-queued items are already accepted by the connector. Once the
        // corresponding user message is visible in history, remove the queue row
        // regardless of whether the started event was missed during reconnect.
        val remaining = _queuedInstructions.value[threadId].orEmpty().filterNot { isQueuedInstructionDelivered(it, history) }
        _queuedInstructions.value = if (remaining.isEmpty()) _queuedInstructions.value - threadId
            else _queuedInstructions.value + (threadId to remaining)
    }

    private fun updateThreadActivity(threadId: String?, updatedAt: Long) {
        if (threadId == null) return
        _threads.value = sortThreadSummaries(_threads.value.map { item ->
            if (item.id == threadId) item.copy(updatedAt = maxOf(item.updatedAt, updatedAt),
                activityAt = item.activityAt?.let { maxOf(it, updatedAt) }) else item
        })
    }

    private fun decodeItem(threadId: String, row: JSONObject): HistoryItem? = runCatching {
        val value = crypto.decrypt("history.item", threadId, row.getString("id"), row.getString("nonce"), row.getString("ciphertext"))
        if (isInternalContextMessage(value.optString("text"))) return@runCatching null
        // Items an older connector uploaded that should never have been shown.
        if (value.optString("type") == "hidden") return@runCatching null
        // Connector 0.1.14 mislabeled normal rollout event messages as errors.
        if (isLegacyMisclassifiedRolloutError(value.optString("type"), row.getLong("itemOrder"))) return@runCatching null
        val images = mutableListOf<HistoryImage>()
        value.optJSONArray("images")?.let { array ->
            for (index in 0 until array.length()) {
                val image = array.optJSONObject(index) ?: continue
                val data = image.optString("data").takeIf { it.startsWith("data:image/", true) } ?: continue
                images += HistoryImage(data, image.optString("mimeType").takeIf { it.isNotBlank() && it != "null" })
            }
        }
        value.optString("imageData").takeIf { it.startsWith("data:image/", true) }?.let {
            if (images.none { image -> image.data == it }) images += HistoryImage(it, value.optString("mimeType").takeIf(String::isNotBlank))
        }
        val rawText = value.optString("text")
        val type = value.optString("type")
        val text = sanitizeHistoryText(rawText).ifBlank {
            if (containsLocalImageMarkup(rawText) && type.contains("user", true)) "图片附件" else ""
        }
        val imageRefs = mutableListOf<HistoryImageRef>()
        value.optJSONArray("imageRefs")?.let { array ->
            for (index in 0 until array.length()) {
                val ref = array.optJSONObject(index) ?: continue
                val id = ref.optString("ref").takeIf { it.isNotBlank() } ?: continue
                imageRefs += HistoryImageRef(id, ref.optString("mimeType", "image/png"), ref.optLong("bytes"))
            }
        }
        val questions = parseCodexQuestions(value.optJSONArray("questions"))
        HistoryItem(row.getString("id"), row.getLong("itemOrder"), type, text,
            value.optString("status").takeIf { it.isNotBlank() && it != "null" }, value.optBoolean("truncated"), images,
            value.optLong("createdAt", 0L).takeIf { it > 0L } ?: row.optLong("createdAt", 0L),
            imageRefs = imageRefs, questions = questions, durationMs = value.optLong("durationMs"),
            sourceMessageId = value.optString("sourceMessageId").takeIf { it.isNotBlank() && it != "null" },
            nextStep = if (type == "claudeWrapUp") parseClaudeNextStep(value.optJSONObject("nextStep")) else null,
            taskList = if (type == "claudeTaskList") parseClaudeTaskList(value.optJSONObject("taskList")) else null,
            files = if (type == "sentFiles") parseSentFiles(value.optJSONArray("files")) else emptyList(),
            light = value.optBoolean("light"))
    }.getOrNull()

    private fun decodeCachedItem(threadId: String, row: CachedItem): HistoryItem? = decodeItem(threadId,
        JSONObject().put("id", row.id).put("itemOrder", row.itemOrder).put("nonce", row.nonce).put("ciphertext", row.ciphertext).put("createdAt", row.createdAt))

    private suspend fun readCachedHistory(threadId: String): List<HistoryItem> {
        // Keep large image/tool payloads out of CursorWindow. They remain in the
        // database for bookkeeping and are fetched from the latest online page.
        return database.cache()
            .items(threadId, HISTORY_CACHE_LIMIT, HISTORY_CACHE_ITEM_MAX_CHARS)
            .mapNotNull { decodeCachedItem(threadId, it) }
            .sortedBy { it.order }
    }

    // The demo build has no session: every request fails quietly instead of
    // reaching a server or marking a login as expired.
    private suspend fun token(): String = if (BuildConfig.DEMO) throw kotlinx.coroutines.CancellationException("demo") else tokenMutex.withLock {
        val sessionTicket = sessionSnapshotGuard.capture()
        crypto.access()?.takeIf { crypto.expires() > System.currentTimeMillis() + 30_000 }?.let { return@withLock it }
        val body = JSONObject().put("deviceId", crypto.deviceId()).put("refreshToken", crypto.refresh())
        if (usingV2()) body.put("accountId", crypto.accountId())
        val refreshPath = if (usingV2()) "/api/v2/session/refresh" else "/api/v1/auth/refresh"
        val result = try {
            post("${serverUrl()}$refreshPath", body, null, authClient)
        } catch (error: Exception) {
            if (refreshAuthFailureAction((error as? HttpStatusException)?.statusCode) == AuthFailureAction.REQUIRE_REAUTH) {
                sessionSnapshotGuard.publish(sessionTicket) { onRefreshTokenRejected(error.message ?: "登录需要重新验证") }
            }
            throw error
        }
        val saved = sessionSnapshotGuard.publish(sessionTicket) {
            if (usingV2()) crypto.saveV2Session(crypto.server(), requireNotNull(crypto.accountId()), crypto.deviceId(),
                result.getString("accessToken"), result.getString("refreshToken"), result.getLong("expiresAt"), resetSequence = false)
            else crypto.saveSession(crypto.server(), crypto.deviceId(), result.getString("accessToken"), result.getString("refreshToken"), result.getLong("expiresAt"))
        }
        if (!saved) throw CancellationException("会话已切换")
        result.getString("accessToken")
    }

    private suspend fun get(path: String): JSONObject = withContext(Dispatchers.IO) {
        val sessionTicket = sessionSnapshotGuard.capture()
        if (directMode()) {
            val id = UUID.randomUUID().toString(); val result = kotlinx.coroutines.CompletableDeferred<JSONObject>()
            directReads[id] = result
            try {
                sendFrame("direct.request", null, JSONObject().put("requestId", id).put("path", path))
                return@withContext kotlinx.coroutines.withTimeout(45_000) { result.await() }
            } finally { directReads.remove(id) }
        }
        var lastError: IOException? = null
        repeat(2) { attempt ->
            try {
                val server = serverUrl()
                val access = token()
                if (!sessionSnapshotGuard.isCurrent(sessionTicket)) throw CancellationException("会话已切换")
                val request = Request.Builder().url(server + path).header("Authorization", "Bearer $access").build()
                return@withContext client.newCall(request).execute().use { response ->
                    if (!sessionSnapshotGuard.isCurrent(sessionTicket)) throw CancellationException("会话已切换")
                    if (response.code == 401) sessionSnapshotGuard.publish(sessionTicket) { onAccessTokenRejected("401: 访问令牌已失效") }
                    parse(response)
                }
            } catch (error: IOException) {
                lastError = error
                if (attempt < 1) delay(600L) else throw error
            }
        }
        throw lastError ?: IOException("网络读取失败")
    }

    private fun post(url: String, body: JSONObject, token: String?, httpClient: OkHttpClient = client): JSONObject {
        val builder = Request.Builder().url(normalizeRequestUrl(url)).post(body.toString().toRequestBody("application/json".toMediaType()))
        token?.let { builder.header("Authorization", "Bearer $it") }
        httpClient.newCall(builder.build()).execute().use {
            if (token != null && it.code == 401) onAccessTokenRejected("401: 访问令牌已失效")
            return parse(it)
        }
    }

    private fun normalizeRequestUrl(value: String): String {
        val scheme = when {
            value.startsWith("https://", ignoreCase = true) -> "https://"
            value.startsWith("http://", ignoreCase = true) -> "http://"
            else -> return value
        }
        val remainder = value.substring(scheme.length).replace(Regex("/+"), "/")
        return scheme + remainder
    }

    private fun parse(response: Response): JSONObject {
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) throw HttpStatusException(response.code, "${response.code}: $text")
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    private fun uniqueFile(directory: File, name: String): File {
        directory.mkdirs(); val safe = name.ifBlank { "download.bin" }; var target = File(directory, safe); var index = 1
        while (target.exists()) { val stem = safe.substringBeforeLast('.', safe); val ext = safe.substringAfterLast('.', ""); target = File(directory, "$stem-${index++}${if (ext.isBlank()) "" else ".$ext"}") }
        return target
    }
}
