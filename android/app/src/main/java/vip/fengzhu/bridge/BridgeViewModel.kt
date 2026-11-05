package vip.fengzhu.bridge

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.Job
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import java.net.SocketTimeoutException

internal fun userFacingUiError(cause: Throwable, fallback: String): String {
    val message = cause.message?.trim().orEmpty()
    return when {
        isRetryableCodexAgentLoopError(message) -> "Codex 后台正在恢复，消息和图片已保存，稍后会自动重试"
        cause is SocketTimeoutException ||
            message.equals("timeout", ignoreCase = true) ||
            message.contains("timed out", ignoreCase = true) -> "连接超时，请稍后重试"
        message.isBlank() -> fallback
        else -> message
    }
}

class BridgeViewModel(application: Application) : AndroidViewModel(application) {
    val repository = (application as FengzhuApplication).repository
    val connection = repository.connection
    val threads = repository.threads
    val executionStatuses = repository.liveStatuses
    val codexQuestionStates = repository.codexQuestionStates
    val liveStatuses = combine(executionStatuses, codexQuestionStates, repository.threads) { statuses, questions, threads ->
        statuses + questions.filterValues { it.pending }.mapValues { (id, question) ->
            codexQuestionDisplayStatus(statuses[id] ?: threads.firstOrNull { it.id == id }?.status.orEmpty(), question)
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyMap())
    val agentOpenStates = repository.agentOpenStates
    val agentOpenStatesByConnector = repository.agentOpenStatesByConnector
    private val _visibleAgents = MutableStateFlow(repository.visibleAgents())
    val visibleAgents: StateFlow<Set<String>> = _visibleAgents
    private val _agentOrder = MutableStateFlow(repository.visibleAgentOrder())
    val agentOrder: StateFlow<List<String>> = _agentOrder
    val queuedInstructions = repository.queuedInstructions
    val items = repository.items
    val historyLoadState = repository.historyLoadState
    val approval = repository.approval
    val statusText = repository.statusText
    val phoneNetworkAvailable = repository.phoneNetworkAvailable
    val capabilities = repository.capabilities
    val claudeConsent = repository.claudeConsent
    val accountsAvailable = repository.accountsAvailable
    val agentAccounts = repository.agentAccounts
    val accountRequestPending = repository.accountRequestPending
    val accountReadErrors = repository.accountReadErrors
    fun setClaudeConsent(enabled: Boolean) = repository.setClaudeConsent(enabled)
    fun refreshAgentAccounts(backend: String) = viewModelScope.launch { runCatching { repository.refreshAgentAccounts(backend) } }
    fun switchAgentAccount(target: String, operation: String) = viewModelScope.launch {
        runCatching { repository.switchAgentAccount(target, operation) }.onFailure { _uiError.value = userFacingUiError(it, "账号切换暂时不可用") }
    }
    val claudeModels = repository.claudeModels
    /** Conversations whose model / mode switch has not been answered yet. */
    val switchingSettings = repository.switchingSettings
    val historySyncing = repository.historySyncing
    val threadSettings = repository.threadSettings
    val conversationUsage = repository.conversationUsage
    val tokenDisplayUnit = repository.tokenDisplayUnit
    fun saveTokenDisplayUnit(unit: TokenDisplayUnit) = repository.saveTokenDisplayUnit(unit)
    val lightMode = repository.lightMode
    fun saveLightMode(enabled: Boolean) = repository.saveLightMode(enabled)
    val showPcLoad = repository.showPcLoad
    val autoDownloadUpdates = repository.autoDownloadUpdates
    fun saveAutoDownloadUpdates(enabled: Boolean) = repository.saveAutoDownloadUpdates(enabled)
    fun saveShowPcLoad(enabled: Boolean) = repository.saveShowPcLoad(enabled)
    val lightDetails = repository.lightDetails
    val lightFetching = repository.lightFetching
    private val lightFetchJobs = LightDetailFetchJobs()
    fun loadLightDetails(threadId: String) = viewModelScope.launch { runCatching { repository.loadLightDetails(threadId) } }
    fun fetchLightDetails(threadId: String, placeholders: List<HistoryItem>): Job {
        val job = viewModelScope.launch(start = CoroutineStart.LAZY) {
            repository.fetchLightDetails(threadId, placeholders)?.let { _uiError.value = "详细过程没有取回：$it" }
        }
        lightFetchJobs.add(threadId, job)
        job.start()
        return job
    }
    fun cancelLightDetails(threadId: String) {
        lightFetchJobs.cancel(threadId)
    }
    val usageLoading = repository.usageLoading
    val turnDurations = repository.turnDurations
    val attachments = repository.attachments
    val message = repository.message
    val files = repository.files
    val filePath = repository.filePath
    val devices = repository.devices
    val selectedConnectorId = repository.selectedConnectorId
    val agentConnectorIds = repository.agentConnectorIds
    val updateAvailable = repository.updateAvailable
    val updateDownload = repository.updateDownload
    val pairingLogin = repository.pairingLogin
    val account = repository.account
    val createdThreadId = repository.createdThreadId
    val claudeWorkspaceTrust = repository.claudeWorkspaceTrust
    private var updateJob: Job? = null
    private var pairingJob: Job? = null
    private var pairingGeneration = 0
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    private val _authenticated = MutableStateFlow(false)
    val authenticated: StateFlow<Boolean> = _authenticated
    private val _authReady = MutableStateFlow(false)
    val authReady: StateFlow<Boolean> = _authReady
    private val _legalAccepted = MutableStateFlow(BuildConfig.DEMO || repository.legalAccepted())
    private val _onboardingPending = MutableStateFlow(!BuildConfig.DEMO && repository.onboardingState() == OnboardingState.Pending)
    val onboardingPending: StateFlow<Boolean> = _onboardingPending
    val legalAccepted: StateFlow<Boolean> = _legalAccepted
    private val _uiError = MutableStateFlow<String?>(null)
    val uiError: StateFlow<String?> = _uiError
    private val _claudeTrustWorking = MutableStateFlow(false)
    val claudeTrustWorking: StateFlow<Boolean> = _claudeTrustWorking
    private val _threadModes = MutableStateFlow<Map<String, String>>(emptyMap())
    val threadModes: StateFlow<Map<String, String>> = _threadModes

    init {
        // A mode the phone set is shown until the computer reports a change of
        // its own: "Allow and switch to Auto", or a switch made on the computer,
        // used to stay hidden behind the phone's last choice.
        viewModelScope.launch {
            var previous: Map<String, String> = emptyMap()
            repository.threadSettings.collect { settings ->
                val modes = settings.mapValues { it.value.permissionMode }
                val changed = modes.filter { (id, mode) -> previous.containsKey(id) && previous[id] != mode }.keys
                previous = modes
                if (changed.isNotEmpty() && _threadModes.value.keys.any { it in changed }) _threadModes.value = _threadModes.value - changed
            }
        }
        viewModelScope.launch {
            val restored = repository.recoverSessionOnStartup()
            _authenticated.value = restored
            if (restored) startService()
            _authReady.value = true
        }
        if (!repository.directMode()) {
            checkForUpdate()
            viewModelScope.launch {
                while (true) {
                    kotlinx.coroutines.delay(10 * 60_000)
                    // Found while the app is open: downloaded in the background too.
                    runCatching { repository.checkForUpdate() }.getOrNull()?.let { repository.prepareUpdateInBackground(it) }
                }
            }
        }
        viewModelScope.launch {
            repository.sessionExpired.collect { expired ->
                if (expired) {
                    _authenticated.value = false
                    _uiError.value = "登录已失效，请重新登录"
                    getApplication<Application>().stopService(Intent(getApplication(), BridgeService::class.java))
                }
            }
        }
    }

    fun login(server: String, password: String) = viewModelScope.launch {
        _busy.value = true
        runCatching { repository.login(server.trim(), password.toCharArray()); _authenticated.value = true; startService() }
            .onFailure { repository.disconnect(); error(it.message ?: "登录失败") }
        _busy.value = false
    }
    private fun startPairing(imageSource: Boolean = false, operation: suspend () -> Unit): Job {
        val generation = ++pairingGeneration
        pairingJob?.cancel(); repository.resetPairing()
        _busy.value = true
        return viewModelScope.launch {
            try {
                operation()
                currentCoroutineContext().ensureActive()
                if (generation == pairingGeneration) { _authenticated.value = true; startService() }
            } catch (error: Exception) {
                if (generation == pairingGeneration && (error !is kotlinx.coroutines.CancellationException || error is kotlinx.coroutines.TimeoutCancellationException))
                    repository.pairingFailed(PairingErrorMessage.from(error, imageSource))
            } finally { if (generation == pairingGeneration) _busy.value = false }
        }.also { pairingJob = it }
    }
    fun pairFromQr(payload: String) = startPairing { repository.pairFromQr(payload) }
    fun pairFromQrImage(uri: android.net.Uri) = startPairing(imageSource = true) {
            val payload = withContext(Dispatchers.IO) { QrImageDecoder.decode(getApplication(), uri) }
            repository.pairFromQr(payload)
    }
    // khsci.com account login (no QR). beginKhsciLogin returns the authorization
    // URL to open in the browser; the khlink://oauth/callback deep link then calls
    // completeKhsciLogin.
    private val _khsciAuthUrl = MutableStateFlow<String?>(null)
    val khsciAuthUrl: StateFlow<String?> = _khsciAuthUrl
    fun consumeKhsciAuthUrl() { _khsciAuthUrl.value = null }

    fun beginKhsciLogin() = viewModelScope.launch {
        _busy.value = true
        runCatching { repository.beginKhsciLogin() }
            .onSuccess { _khsciAuthUrl.value = it }
            .onFailure { repository.pairingFailed(PairingErrorMessage.fromAccountLogin(it)) }
        _busy.value = false
    }
    fun completeKhsciLogin(code: String, state: String) = viewModelScope.launch {
        _busy.value = true
        runCatching { repository.completeKhsciLogin(code, state) }
            .onSuccess { _authenticated.value = true; startService() }
            .onFailure { repository.pairingFailed(PairingErrorMessage.fromAccountLogin(it)) }
        _busy.value = false
    }
    fun resetPairing() {
        pairingGeneration++; pairingJob?.cancel(); pairingJob = null
        repository.resetPairing(); _busy.value = false
    }
    fun directMode(): Boolean = repository.directMode()
    fun enterDirectPairing() {
        resetPairing(); repository.disconnect()
        _authenticated.value = false
        getApplication<Application>().stopService(Intent(getApplication(), BridgeService::class.java))
    }
    val suggestAccountLogin = repository.suggestAccountLogin
    fun dismissAccountSuggestion() = repository.dismissAccountSuggestion()
    /** Leaves the failing direct link for the official relay: the saved account session, else a new login. */
    fun switchToAccountLogin() {
        repository.dismissAccountSuggestion()
        if (repository.hasSavedAccountSession()) restoreServerConnection()
        else { enterDirectPairing(); beginKhsciLogin() }
    }
    fun restoreServerConnection() = viewModelScope.launch {
        runCatching { check(repository.restoreServerConnection()) { "没有保存的账户会话，请登录 khLink 账号" } }
            .onSuccess { _authenticated.value = true; startService() }
            .onFailure { error(it.message ?: "恢复账户连接失败") }
    }
    fun refreshAccount(showError: Boolean = true) = viewModelScope.launch {
        runCatching { repository.refreshAccount() }
            .onFailure { reportFailure(it, "账户信息读取失败", showError) }
    }
    fun logout() {
        repository.logout()
        _authenticated.value = false
        getApplication<Application>().stopService(Intent(getApplication(), BridgeService::class.java))
    }
    fun usingV2(): Boolean = repository.usingV2()
    fun resumeConnection() = repository.resumeConnection()
    fun noteAppBackgrounded() = repository.noteAppBackgrounded()
    fun lastViewedThreadId(): String? = repository.lastViewedThreadId()
    fun saveLastViewedThreadId(threadId: String) = repository.saveLastViewedThreadId(threadId)
    fun homeBackend(): String = repository.homeBackend()
    fun saveHomeBackend(value: String) = repository.saveHomeBackend(value)
    fun saveVisibleAgents(values: Set<String>) {
        repository.saveVisibleAgents(values)
        _visibleAgents.value = repository.visibleAgents()
        _agentOrder.value = repository.visibleAgentOrder()
    }
    fun saveAgentOrder(order: List<String>) {
        repository.saveAgentOrder(order)
        _visibleAgents.value = repository.visibleAgents()
        _agentOrder.value = repository.visibleAgentOrder()
    }
    fun clearLastViewedThreadId() = repository.clearLastViewedThreadId()
    fun finishOnboarding() { repository.finishOnboarding(); _onboardingPending.value = false }
    fun restartOnboarding() { repository.restartOnboarding(); _onboardingPending.value = true }
    fun acceptLegal(agreement: Boolean, privacy: Boolean, diagnostics: Boolean, analytics: Boolean) {
        if (agreement && privacy) {
            repository.acceptLegal(diagnostics, analytics)
            _legalAccepted.value = true
            _onboardingPending.value = repository.onboardingState() == OnboardingState.Pending
        }
    }

    fun refresh(showError: Boolean = true, full: Boolean = false): Job = viewModelScope.launch {
        runCatching { repository.refreshThreads(full) }
            .onFailure { reportFailure(it, "刷新失败", showError) }
    }
    private val _pendingNewTask = kotlinx.coroutines.flow.MutableStateFlow<PendingNewTask?>(null)
    /** A task the phone asked the computer to create and is waiting for. */
    val pendingNewTask: kotlinx.coroutines.flow.StateFlow<PendingNewTask?> = _pendingNewTask
    fun newTask(cwd: String, prompt: String, mode: String, collaborationMode: String = "default", backend: String = "codex", model: String = "", effort: String = "") = viewModelScope.launch {
        val pending = PendingNewTask(backend, cwd, prompt, System.currentTimeMillis())
        _pendingNewTask.value = pending
        runCatching { repository.createTask(cwd, prompt, mode, collaborationMode, backend, model, effort) }
            // Blank: the computer asks to trust the folder first; its dialog takes over.
            .onSuccess { id -> if (id.isBlank() && _pendingNewTask.value == pending) _pendingNewTask.value = null }
            .onFailure { failure ->
                if (_pendingNewTask.value == pending) _pendingNewTask.value = pending.copy(error = failure.message ?: "新建任务失败")
                else error(failure.message ?: "新建任务失败")
            }
    }
    fun dismissPendingNewTask() { _pendingNewTask.value = null }
    fun confirmClaudeWorkspaceTrust() = viewModelScope.launch {
        if (_claudeTrustWorking.value) return@launch
        _claudeTrustWorking.value = true
        runCatching { repository.confirmClaudeWorkspaceTrust() }
            .onFailure { error(it.message ?: "电脑端没能完成工作区确认") }
        _claudeTrustWorking.value = false
    }
    fun cancelClaudeWorkspaceTrust() = viewModelScope.launch {
        if (_claudeTrustWorking.value) return@launch
        _claudeTrustWorking.value = true
        repository.cancelClaudeWorkspaceTrust()
        _claudeTrustWorking.value = false
    }
    fun clearCreatedThreadId() = repository.clearCreatedThreadId()
    fun currentThreadId(): String? = repository.currentThreadId()
    fun open(threadId: String) = viewModelScope.launch {
        repository.watchThread(threadId)
        repository.markThreadRead(threadId)
        runCatching { repository.loadThread(threadId) }
            // Opening during a reconnect is expected to be transient; the thread view keeps its inline retry state.
            .onFailure { reportFailure(it, "加载失败", showError = false) }
    }
    fun closeTask() {
        repository.markActiveThreadRead()
        repository.watchThread(null)
    }
    fun markAllThreadsRead() = repository.markAllThreadsRead()
    fun older(threadId: String) = viewModelScope.launch {
        val state = historyLoadState.value
        if (state.loading || (!state.hasMore && state.error == null)) return@launch
        val before = items.value.firstOrNull()?.order
        runCatching { repository.loadThread(threadId, before) }.onFailure { reportFailure(it, "更早内容加载失败") }
    }
    fun send(threadId: String, title: String, text: String, attachments: List<AttachmentUpload> = emptyList()): Boolean = runCatching {
        repository.sendInstruction(threadId, title, text, attachments)
    }.onFailure { error(it.message ?: "发送失败") }.isSuccess
    fun queue(threadId: String, title: String, text: String, attachments: List<AttachmentUpload> = emptyList()): Boolean = runCatching {
        repository.queueInstruction(threadId, title, text, attachments)
    }.onFailure { error(it.message ?: "加入待发送失败") }.isSuccess
    fun removeQueued(threadId: String, instructionId: String) = repository.removeQueuedInstruction(threadId, instructionId)
    fun steerQueued(threadId: String, instructionId: String) = repository.steerQueuedInstruction(threadId, instructionId)
    fun steerQueuedAll(threadId: String, instructionIds: List<String>) = repository.steerQueuedInstructions(threadId, instructionIds)
    fun steer(threadId: String, title: String, text: String, attachments: List<AttachmentUpload> = emptyList()): Boolean = runCatching {
        repository.steerInstruction(threadId, title, text, attachments)
    }.onFailure { error(it.message ?: "调整方向失败") }.isSuccess
    val codexQuestion = repository.codexQuestion
    fun dismissCodexQuestion() = repository.dismissCodexQuestion()
    /** Native questions always use send-now, including cards reopened after a
     * turn ends. The connector starts a new turn if the old one already ended. */
    fun answerCodexQuestion(thread: ThreadSummary, question: CodexQuestion, answer: String): Boolean =
        submitCodexQuestionAnswer(question, answer, repository.queuedInstructions.value[thread.id].orEmpty()) {
            steer(thread.id, thread.title, it)
        }
    fun openCodexQuestion(threadId: String) = repository.openCodexQuestion(threadId)
    private val _answering = kotlinx.coroutines.flow.MutableStateFlow<Set<String>>(emptySet())
    /** Threads whose desktop prompt is being answered from the phone right now. */
    val answering: kotlinx.coroutines.flow.StateFlow<Set<String>> = _answering
    private val _answered = kotlinx.coroutines.flow.MutableStateFlow<Map<String, String>>(emptyMap())
    /** Thread → the desktop prompt answered from the phone. Its banner closes at
     * once; the computer works on the answer in the background, and the banner
     * comes back only if that fails. */
    val answered: kotlinx.coroutines.flow.StateFlow<Map<String, String>> = _answered
    fun forgetAnswered(threadId: String) { _answered.value = _answered.value - threadId }
    fun answerOnDesktop(threadId: String, requestId: String, choice: String? = null, answers: List<QuestionAnswer>? = null, feedback: String? = null) = viewModelScope.launch {
        _answering.value = _answering.value + threadId
        _answered.value = _answered.value + (threadId to requestId)
        runCatching { repository.answerDesktopPrompt(threadId, requestId, choice, answers, feedback) }
            .onFailure {
                forgetAnswered(threadId)
                error(it.message ?: "电脑端没能处理")
            }
        _answering.value = _answering.value - threadId
    }
    fun answerDshQuestion(threadId: String, choice: String?, answers: List<QuestionAnswer>?, requestId: String? = null) {
        val option = choice?.takeIf { it.isNotBlank() } ?: answers?.firstOrNull()?.labels?.firstOrNull()
        if (option.isNullOrBlank()) {
            error("DSH 的自定义文字答案需要在桌面输入")
            return
        }
        // An approval folds away at once; it comes back if the computer did
        // not take the answer (the failure itself is reported as usual).
        if (requestId != null && requestId.startsWith("ap:")) {
            _answered.value = _answered.value + (threadId to requestId)
            // A timeout is not a refusal: the click may still land, and the
            // card goes once the computer reports the approval decided.
            viewModelScope.launch { runCatching { repository.answerDshAwait(threadId, option) }.onFailure { if (it !is CommandTimeoutException) forgetAnswered(threadId) } }
            return
        }
        repository.answerDsh(threadId, option)
    }
    /** Reads the choices of a prompt in a session the desktop is not showing (it switches there and back). */
    fun readDesktopPrompt(threadId: String) = viewModelScope.launch {
        runCatching { repository.command("claude.desktop.read", threadId, JSONObject().put("threadId", threadId)) }
            .onFailure { error(it.message ?: "没能读取电脑上的选项") }
    }
    fun openOnDesktop(threadId: String) = runCatching { repository.command("claude.desktop.open", threadId, JSONObject().put("threadId", threadId)) }.onFailure { error(it.message ?: "没能在电脑上打开") }
    fun stop(threadId: String) = runCatching { repository.command("turn.stop", threadId, JSONObject().put("threadId", threadId)) }.onFailure { error(it.message ?: "停止失败") }
    fun compact(threadId: String) = action("thread.compact", threadId)
    fun fork(threadId: String) = action("thread.fork", threadId)
    fun rollback(threadId: String) = action("thread.rollback", threadId)
    fun rename(threadId: String, name: String) = runCatching { repository.command("thread.rename", threadId, JSONObject().put("threadId", threadId).put("name", name)) }.onFailure { error(it.message ?: "重命名失败") }
    fun pin(threadId: String, pinned: Boolean) = runCatching { repository.command("thread.pin", threadId, JSONObject().put("threadId", threadId).put("pinned", pinned)) }.onFailure { error(it.message ?: if (pinned) "置顶失败" else "取消置顶失败") }
    fun pinSelection(changes: List<Pair<String, Boolean>>) {
        changes.forEach { (threadId, pinned) ->
            runCatching { repository.command("thread.pin", threadId, JSONObject().put("threadId", threadId).put("pinned", pinned)) }
        }
    }
    val phoneArchivedIds = repository.phoneArchivedIds
    val archivingIds = repository.archivingIds
    /** Archive (or bring back) one or several sessions and say how it went. */
    fun archiveThreads(items: List<ThreadSummary>, archived: Boolean) = viewModelScope.launch {
        if (items.isEmpty()) return@launch
        val verb = if (archived) "归档" else "取消归档"
        repository.showMessage("正在${verb} ${items.size} 个会话…")
        val failed = runCatching { repository.archiveThreads(items, archived) }.getOrElse { listOf(it.message ?: "操作失败") }
        repository.showMessage(if (failed.isEmpty()) "已${verb} ${items.size} 个会话" else "${failed.size} 个没能${verb}：${failed.take(3).joinToString("、")}")
    }
    fun archive(threadId: String, archived: Boolean, title: String = "") = runCatching { repository.command("thread.archive", threadId, JSONObject().put("threadId", threadId).put("archived", archived).put("title", title)) }.onFailure { error(it.message ?: "操作失败") }
    internal fun settings(threadId: String, title: String, changes: CodexSettingsChanges) {
        if (changes.isEmpty()) return
        val value = JSONObject()
        changes.permissionMode?.let { value.put("permissionMode", it) }
        changes.collaborationMode?.let { value.put("collaborationMode", it) }
        // "默认" means leave the desktop-owned value unchanged. Sending an
        // explicit JSON null makes Codex reject the protocol request with
        // `invalid type: null` instead of applying the mode selection.
        changes.model?.let { value.put("model", it) }
        changes.effort?.let { value.put("effort", it) }
        changes.serviceTier?.let { value.put("serviceTier", it) }
        // Back to standard speed from fast: the connector turns a null tier into Codex's "default".
        if (changes.clearTier) value.put("serviceTier", JSONObject.NULL)
        runCatching { repository.switchSettings(threadId, JSONObject().put("threadId", threadId).put("title", title).put("settings", value)) }.onFailure { error(it.message ?: "设置失败") }
            .onSuccess { changes.permissionMode?.let { _threadModes.value = _threadModes.value + (threadId to it) } }
    }
    // Claude Code: model / effort are always sent; "" means the CLI default.
    fun claudeSettings(threadId: String, title: String, model: String, effort: String, permissionMode: String) {
        val value = JSONObject().put("permissionMode", permissionMode).put("model", model).put("effort", effort)
        runCatching { repository.switchSettings(threadId, JSONObject().put("threadId", threadId).put("title", title).put("settings", value)) }.onFailure { error(it.message ?: "设置失败") }
            .onSuccess { _threadModes.value = _threadModes.value + (threadId to permissionMode) }
    }
    suspend fun piModels(threadId: String): PiModelChoice = repository.piModels(threadId)
    suspend fun loadClaudeImage(threadId: String, ref: HistoryImageRef): HistoryImage = repository.loadClaudeImage(threadId, ref)

    // A computer file (text, image, video …) a reply links to, fetched only
    // after the user confirms, then opened with the phone's app for it.
    private val _computerFile = MutableStateFlow<ComputerFileLoad?>(null)
    val computerFile: StateFlow<ComputerFileLoad?> = _computerFile
    private var computerFileJob: Job? = null

    fun askComputerFile(path: String) { computerFileJob?.cancel(); _computerFile.value = ComputerFileLoad(path, confirmed = false) }

    fun openComputerFile(path: String) {
        computerFileJob?.cancel()
        _computerFile.value = ComputerFileLoad(path, confirmed = true)
        computerFileJob = viewModelScope.launch {
            val startedAt = System.currentTimeMillis()
            runCatching {
                repository.fetchComputerFile(path) { received, total ->
                    // Average speed so far, shown once there's a second's worth to go on.
                    val elapsed = System.currentTimeMillis() - startedAt
                    _computerFile.value = ComputerFileLoad(path, true, received, total, bytesPerSecond = if (elapsed >= 1_000) received * 1_000 / elapsed else 0)
                }
            }
                .onSuccess { file ->
                    _computerFile.value = null
                    _computerFileView.value = ComputerFileView(path, file)
                    refreshFetchedFiles()
                }
                .onFailure { failure ->
                    if (failure !is kotlinx.coroutines.CancellationException) _computerFile.value = ComputerFileLoad(path, true, error = failure.message ?: "打开失败")
                }
        }
    }

    fun dismissComputerFile() { computerFileJob?.cancel(); _computerFile.value = null }

    // Inline markdown images/videos reuse the fetched-file cache so a message
    // does not fetch the same computer file again on every recomposition.
    private val inlineFiles = java.util.concurrent.ConcurrentHashMap<String, java.io.File>()
    suspend fun loadInlineComputerFile(path: String, progress: (Long, Long) -> Unit = { _, _ -> }): java.io.File {
        inlineFiles[path]?.takeIf { it.isFile }?.let { return it }
        // Fetched once before (this run or an earlier one): no second transfer.
        withContext(Dispatchers.IO) { repository.fetchedFiles() }.firstOrNull { it.path == path && it.file.isFile }?.let { inlineFiles[path] = it.file; return it.file }
        val file = withContext(Dispatchers.IO) { repository.fetchComputerFile(path, progress) }
        inlineFiles[path] = file
        refreshFetchedFiles()
        return file
    }

    // A fetched computer file shown inside the app (Markdown, HTML, text …).
    private val _computerFileView = MutableStateFlow<ComputerFileView?>(null)
    val computerFileView: StateFlow<ComputerFileView?> = _computerFileView
    fun closeComputerFileView() { _computerFileView.value = null }

    // Every file fetched from the computer, on the 电脑取回的文件 page.
    private val _fetchedFiles = MutableStateFlow<List<FetchedFile>>(emptyList())
    val fetchedFiles: StateFlow<List<FetchedFile>> = _fetchedFiles
    fun refreshFetchedFiles() { viewModelScope.launch { _fetchedFiles.value = withContext(Dispatchers.IO) { repository.fetchedFiles() } } }
    fun showFetchedFile(item: FetchedFile) { _computerFileView.value = ComputerFileView(item.path, item.file) }
    fun deleteFetchedFile(item: FetchedFile) {
        viewModelScope.launch { withContext(Dispatchers.IO) { repository.deleteFetched(item.file) }; refreshFetchedFiles() }
    }
    fun clearFetchedFiles() {
        viewModelScope.launch { withContext(Dispatchers.IO) { repository.clearFetched() }; refreshFetchedFiles() }
    }
    fun installApk(file: java.io.File) { if (!repository.installApk(file)) repository.showMessage("请先在系统设置里允许 khLink 安装应用，再点一次安装") }
    fun openWithOtherApp(file: java.io.File) { if (!repository.openFetchedFile(file)) error("手机上没有能打开这类文件的应用") }
    private val _savingFile = MutableStateFlow(false)
    val savingFile: StateFlow<Boolean> = _savingFile
    fun saveToDownloads(file: java.io.File) {
        if (_savingFile.value) return
        _savingFile.value = true
        viewModelScope.launch {
            runCatching { repository.saveToDownloads(file) }
                .onSuccess { repository.showMessage("已保存到 $it") }
                .onFailure { error(it.message ?: "保存失败") }
            _savingFile.value = false
        }
    }

    // A web link straight to a video: download it or open it in the browser.
    private val _webVideo = MutableStateFlow<String?>(null)
    val webVideo: StateFlow<String?> = _webVideo
    fun askWebVideo(url: String) { _webVideo.value = url }
    fun dismissWebVideo() { _webVideo.value = null }
    fun downloadWebVideo(url: String) {
        _webVideo.value = null
        runCatching { repository.downloadWebFile(url) }
            .onSuccess { repository.showMessage("开始下载，完成后在 $it") }
            .onFailure { error(it.message ?: "下载失败") }
    }
    fun cachedClaudeImage(threadId: String, ref: String): HistoryImage? = repository.cachedClaudeImage(threadId, ref)
    fun piSettings(threadId: String, model: String, thinkingLevel: String) {
        val value = JSONObject().put("model", model).put("thinkingLevel", thinkingLevel)
        runCatching { repository.switchSettings(threadId, JSONObject().put("threadId", threadId).put("settings", value)) }.onFailure { error(it.message ?: "设置失败") }
    }
    suspend fun piProviders(): List<PiProvider> = repository.piProviders()
    suspend fun savePiProvider(provider: PiProvider, apiKey: String) = repository.savePiProvider(provider, apiKey)
    fun startPiWeb() { runCatching { repository.command("pi.start") }.onFailure { error(it.message ?: "启动失败") } }
    fun loadSettings(threadId: String) = viewModelScope.launch {
        runCatching { repository.loadThreadSettings(threadId) }
            .onFailure { reportFailure(it, "设置读取失败", showError = false) }
    }
    fun loadConversationUsage(threadId: String, historyFrom: Long = 0L) = repository.loadConversationUsage(threadId, historyFrom)
    fun backendCapabilities() { runCatching { repository.command("backends.capabilities") } }
    val claudeUsage = repository.claudeUsage
    val dshUsage = repository.dshUsage
    val dshCatalog = repository.dshCatalog
    val hermesCatalog = repository.hermesCatalog
    val dshPending = repository.dshPending
    val dshPendingLoading = repository.dshPendingLoading
    val pcLoad = repository.pcLoad
    val uploadIssue = repository.uploadIssue
    fun claudeUsage() { runCatching { repository.command("claude.usage") } }
    fun refreshClaudeUsage() { runCatching { repository.command("claude.usage.refresh") } }
    fun setClaudeStatusline(enabled: Boolean) { runCatching { repository.command("claude.statusline.set", args = org.json.JSONObject().put("enabled", enabled)) } }
    fun dshUsage() { runCatching { repository.command("dsh.usage") } }
    fun loadDshSettings(threadId: String) {
        runCatching { repository.command("thread.settings.read", threadId, JSONObject().put("threadId", threadId)) }
    }
    fun loadDshPending(threadId: String) = repository.loadDshPending(threadId)
    fun answerDsh(threadId: String, option: String) = repository.answerDsh(threadId, option)
    fun dshSettings(threadId: String, model: String, effort: String, permissionMode: String = "") {
        runCatching {
            val args = JSONObject().put("threadId", threadId).put("model", model).put("effort", effort)
            if (permissionMode.isNotBlank()) args.put("permissionMode", permissionMode)
            repository.switchSettings(threadId, args)
        }.onFailure { error(it.message ?: "设置失败") }
    }
    fun capabilities(showError: Boolean = true) {
        runCatching { repository.command("capabilities") }
            .onFailure { if (showError) error(it.message ?: "能力读取失败") }
    }
    fun listFiles(path: String = "") = repository.listFiles(path)
    fun download(path: String) = viewModelScope.launch { runCatching { repository.download(path) }.onFailure { error(it.message ?: "下载失败") } }
    fun upload(uri: android.net.Uri, threadId: String) = viewModelScope.launch {
        runCatching { repository.upload(uri, threadId) }
    }
    fun uploadImages(uris: List<android.net.Uri>, threadId: String) = viewModelScope.launch {
        uris.forEach { uri -> runCatching { repository.upload(repository.compressImage(uri), threadId) } }
    }
    fun removeAttachment(threadId: String, id: String) = repository.removeAttachment(threadId, id)
    fun clearAttachments(threadId: String) = repository.clearAttachments(threadId)
    suspend fun loadDraft(threadId: String): String = repository.loadDraft(threadId)
    fun saveDraft(threadId: String, text: String) = repository.saveDraft(threadId, text)
    fun clearDraft(threadId: String) = repository.clearDraft(threadId)
    fun refreshDevices() = viewModelScope.launch { runCatching { repository.refreshDevices() }.onFailure { error(it.message ?: "设备读取失败") } }
    fun selectConnector(deviceId: String) = repository.selectConnector(deviceId)
    fun selectConnectorForAgent(agent: String, deviceId: String, otherAgents: Collection<String>) = repository.selectConnectorForAgent(agent, deviceId, otherAgents)
    fun showAgentConnector(agent: String, available: Set<String>) = repository.showAgentConnector(agent, available)
    val connectorSeenAt = repository.connectorSeenAt
    fun currentDeviceId(): String = repository.currentDeviceId()
    fun revokeDevice(id: String) = viewModelScope.launch { runCatching { repository.revokeDevice(id) }.onFailure { error(it.message ?: "撤销失败") } }
    fun changePassword(value: String) = viewModelScope.launch { runCatching { repository.changePassword(value.toCharArray()) }.onFailure { error(it.message ?: "修改密码失败") } }
    fun approve(value: Boolean, rpcId: String? = null, threadId: String? = null, forSession: Boolean = false) = repository.resolveApproval(value, rpcId, threadId, forSession)
    fun approve(answers: Map<String, UserInputAnswer>, rpcId: String? = null, threadId: String? = null) = repository.resolveApproval(answers, rpcId, threadId)
    fun clearMessage() = repository.clearMessage()
    fun showMessage(value: String) = repository.showMessage(value)
    fun dismissUpdate() = repository.dismissUpdate()
    fun postponeUpdate() = repository.postponeUpdate()
    fun skipUpdate() = repository.skipUpdate()
    fun downloadUpdate(update: UpdateInfo) {
        if (updateJob?.isActive == true) return
        // Already downloaded in the background: install it.
        if (repository.updateReadyFor(update)) { repository.installDownloadedUpdate(); return }
        // Being downloaded in the background: show it and install when done.
        if (repository.promoteBackgroundDownload(update)) {
            updateJob = viewModelScope.launch {
                val end = repository.updateDownload.first { state -> state !is UpdateDownloadState.Downloading }
                if (end is UpdateDownloadState.Ready && end.versionName == update.versionName) repository.installDownloadedUpdate()
            }
            return
        }
        updateJob = viewModelScope.launch {
            runCatching { repository.downloadUpdate(update) }
                .onSuccess { repository.installDownloadedUpdate() }
        }
    }
    fun cancelUpdateDownload() {
        updateJob?.cancel()
        updateJob = null
        repository.resetUpdateDownload()
    }
    fun installDownloadedUpdate() = repository.installDownloadedUpdate()
    fun checkForUpdate(manual: Boolean = false) = viewModelScope.launch {
        runCatching { repository.checkForUpdate(manual = manual) }
            .onSuccess { if (manual && it == null) repository.showMessage("当前已是最新版") }
            .onSuccess { found -> if (!manual && found != null) repository.prepareUpdateInBackground(found) }
            .onFailure { if (manual) error(it.message ?: "检查更新失败") }
    }
    private fun action(name: String, threadId: String) = runCatching { repository.command(name, threadId, JSONObject().put("threadId", threadId)) }.onFailure { error(it.message ?: "操作失败") }
    fun clearError() { _uiError.value = null }
    private fun error(value: String) { _uiError.value = value }
    private fun reportFailure(cause: Throwable, fallback: String, showError: Boolean = true) {
        if (repository.sessionExpired.value) {
            _authenticated.value = false
            _uiError.value = "登录已失效，请重新登录"
        } else if (showError) {
            error(userFacingUiError(cause, fallback))
        }
    }
    private fun startService() = ContextCompat.startForegroundService(getApplication(), Intent(getApplication(), BridgeService::class.java))
}
