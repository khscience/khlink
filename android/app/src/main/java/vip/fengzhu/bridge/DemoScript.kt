package vip.fengzhu.bridge

import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Demo build only (-PkhlinkDemo): plays the computer's side. Every command the
 * phone sends lands here instead of the network, and the answers go back as
 * the same frames a connector sends, through the repository's normal frame
 * handling, so the screens react exactly as they do in the real app.
 */
internal class DemoScript(private val scope: CoroutineScope, private val host: Host) {
    interface Host {
        /** Applies a decrypted frame as if the computer had sent it. */
        fun emit(kind: String, threadId: String?, payload: JSONObject)
        fun thread(id: String): ThreadSummary?
        fun addThread(thread: ThreadSummary)
        fun updateThread(id: String, change: (ThreadSummary) -> ThreadSummary)
        fun showItems(threadId: String, items: List<HistoryItem>)
        fun heartbeat()
    }

    private class Step(val type: String, val text: String)
    private fun agent(text: String) = Step("agentMessage", text)
    private fun command(text: String) = Step("commandExecution", text)
    private fun change(text: String) = Step("fileChange", text)

    private val lock = Any()
    private val history = mutableMapOf<String, MutableList<HistoryItem>>()
    private val queued = mutableMapOf<String, Pair<String, String>>()
    private val settings = mutableMapOf<String, JSONObject>()
    private val turns = mutableMapOf<String, Job>()
    private var newThreads = 0

    fun items(threadId: String): List<HistoryItem> = synchronized(lock) {
        history.getOrPut(threadId) { DemoData.items(threadId).toMutableList() }.toList()
    }

    /** Once per app start: the list changes by itself, for the opening shot. */
    fun start() {
        scope.launch { while (true) { host.heartbeat(); delay(10_000) } }
        scope.launch {
            delay(5_000)
            host.updateThread("demo-2") { it.copy(note = "等你批准：删除 17 万条一周前的测试订单", unread = true) }
            status("demo-2", "desktop_waiting_approval")
            delay(3_000)
            append("demo-5", command("npm test\n Tests: 128 passed, 128 total"))
            append("demo-5", agent("升级完成：12 个依赖升到了最新的小版本，128 个测试全部通过，没有需要改的代码。"))
            host.updateThread("demo-5") { it.copy(unread = true) }
            status("demo-5", "completed")
        }
    }

    fun handle(requestId: String, action: String, threadId: String?, args: JSONObject) {
        scope.launch {
            delay(250)
            runCatching { dispatch(requestId, action, threadId, args) }
                .onFailure { reply(requestId, threadId, false, error = it.message ?: "演示操作失败") }
        }
    }

    private suspend fun dispatch(requestId: String, action: String, threadId: String?, args: JSONObject) {
        val id = threadId ?: args.optString("threadId").takeIf { it.isNotBlank() }
        when (action) {
            "turn.start" -> {
                val target = id ?: return
                reply(requestId, target, true, JSONObject().put("accepted", true))
                startTurn(target, args.optString("text"), firstMessage = true)
            }
            "turn.steer" -> {
                val target = id ?: return
                reply(requestId, target, true, JSONObject().put("delivered", true))
                steered(target, args.optString("text"))
            }
            "followup.enqueue" -> {
                val target = id ?: return
                val text = args.optString("text")
                synchronized(lock) { queued[requestId] = target to text }
                val backend = host.thread(target)?.backend
                val item = JSONObject().put("id", requestId).put("threadId", target).put("text", text)
                    .put("state", if (backend == "codex") "pending" else "desktop_queued").put("origin", "mobile")
                    .put("createdAt", System.currentTimeMillis()).put("blocking", true).put("queueRequested", true)
                reply(requestId, target, true, JSONObject().put("queued", true).put("item", item))
            }
            "followup.steer", "followup.steer_all" -> {
                val target = id ?: return
                reply(requestId, target, true, JSONObject().put("ok", true))
                val ids = args.optJSONArray("ids")?.let { array -> (0 until array.length()).map(array::optString) }
                    ?: listOf(args.optString("id"))
                val texts = ids.mapNotNull { queuedId ->
                    val text = synchronized(lock) { queued.remove(queuedId)?.second } ?: return@mapNotNull null
                    host.emit("steer.accepted", target, JSONObject().put("requestId", queuedId).put("queuedItemId", queuedId))
                    text
                }
                if (texts.isNotEmpty()) steered(target, texts.joinToString("\n"))
            }
            "followup.cancel" -> {
                val queuedId = args.optString("id")
                synchronized(lock) { queued.remove(queuedId) }
                reply(requestId, id, true, JSONObject().put("cancelled", true))
                host.emit("followup.cancelled", id, JSONObject().put("id", queuedId))
            }
            "followup.list" -> reply(requestId, null, true, JSONObject().put("items", JSONArray()))
            "turn.stop" -> {
                val target = id ?: return
                synchronized(lock) { turns.remove(target) }?.cancel()
                reply(requestId, target, true, JSONObject().put("stopped", true))
                status(target, "interrupted")
            }
            "claude.desktop.answer" -> answer(requestId, id ?: return, args)
            "thread.newWithTurn", "thread.new" -> newThread(requestId, args)
            "capabilities" -> reply(requestId, null, true, codexCapabilities())
            "backends.capabilities" -> reply(requestId, null, true, claudeCapabilities())
            "thread.settings.read" -> reply(requestId, id, true, settingsOf(id ?: return).put("updatedAt", System.currentTimeMillis()))
            "settings.set" -> saveSettings(requestId, id ?: return, args)
            "pi.models" -> reply(requestId, id, true, piModels(id))
            "file.read" -> reply(requestId, id, true, fileChunk(args.optString("path"), args.optLong("offset"), args.optInt("size", 256 * 1024)))
            "file.list" -> reply(requestId, null, true, JSONObject().put("path", args.optString("path")).put("items", JSONArray()))
            "thread.pin" -> reply(requestId, id, true, JSONObject().put("pinned", args.optBoolean("pinned")).put("pinOrder", if (args.optBoolean("pinned")) 0 else -1))
            "thread.rename" -> {
                val name = args.optString("name").trim()
                if (id != null && name.isNotBlank()) host.updateThread(id) { it.copy(title = name) }
                reply(requestId, id, true, JSONObject().put("renamed", true))
            }
            "thread.archive" -> {
                if (id != null) host.updateThread(id) { it.copy(archived = args.optBoolean("archived")) }
                reply(requestId, id, true, JSONObject().put("archived", args.optBoolean("archived")))
            }
            // Statistics are not part of the demo; their panels say so inline.
            "thread.usage.read" -> reply(requestId, id, false, error = "演示版不统计用量")
            // Readings the demo leaves to its fixed values: no answer at all.
            "claude.usage", "claude.usage.refresh" -> reply(requestId, null, true, claudeUsage())
            "dsh.usage" -> reply(requestId, null, true, dshUsage())
            "dsh.pending" -> reply(requestId, id, true, JSONObject())
            "accounts.read", "history.sync" -> Unit
            else -> reply(requestId, id, true, JSONObject().put("ok", true))
        }
    }

    // ---- frames

    private fun reply(requestId: String, threadId: String?, ok: Boolean, result: Any? = null, error: String? = null) {
        val payload = JSONObject().put("requestId", requestId).put("ok", ok)
        if (result != null) payload.put("result", result)
        if (error != null) payload.put("error", error)
        host.emit("command.result", threadId, payload)
    }

    private fun status(threadId: String, value: String) {
        val now = System.currentTimeMillis()
        // The status frame first: it compares with the old status (an approval rings only on the change).
        host.emit("thread.status", threadId, JSONObject().put("status", value).put("updatedAt", now))
        host.updateThread(threadId) { it.copy(status = value, updatedAt = maxOf(it.updatedAt, now), activityAt = now) }
    }

    private fun append(threadId: String, step: Step) {
        val now = System.currentTimeMillis()
        val list = synchronized(lock) {
            val items = history.getOrPut(threadId) { DemoData.items(threadId).toMutableList() }
            val order = (items.maxOfOrNull { it.order } ?: 0L) + 1
            items += HistoryItem("$threadId-$order", order, step.type, step.text,
                if (step.type == "userMessage") null else "completed", false, createdAt = now)
            items.toList()
        }
        host.showItems(threadId, list)
    }

    /** Plays [steps] about one per 1–1.5 s, then ends the turn and sends what waited in the queue. */
    private fun play(threadId: String, steps: List<Step>, first: Long = 1_000) {
        val job = scope.launch {
            var pause = first
            for (step in steps) {
                delay(pause)
                append(threadId, step)
                pause = 1_000L + (step.text.length.coerceAtMost(200) * 2L)
            }
            delay(600)
            synchronized(lock) { turns.remove(threadId) }
            status(threadId, "completed")
            drainQueue(threadId)
        }
        synchronized(lock) { turns.put(threadId, job) }?.cancel()
    }

    private fun drainQueue(threadId: String) {
        val next = synchronized(lock) {
            queued.entries.firstOrNull { it.value.first == threadId }?.also { queued.remove(it.key) }
        } ?: return
        scope.launch {
            delay(800)
            host.emit("followup.started", threadId, JSONObject().put("id", next.key).put("threadId", threadId)
                .put("text", next.value.second).put("state", "started").put("startedAt", System.currentTimeMillis()))
            startTurn(threadId, next.value.second, firstMessage = false)
        }
    }

    // ---- conversations

    private fun startTurn(threadId: String, text: String, firstMessage: Boolean) {
        append(threadId, Step("userMessage", text))
        status(threadId, "running")
        val backend = host.thread(threadId)?.backend.orEmpty()
        play(threadId, turnSteps(backend), first = if (firstMessage) 1_200 else 1_000)
    }

    /** A message sent at once into a running turn: it shows up and the agent picks it up. */
    private fun steered(threadId: String, text: String) {
        scope.launch {
            delay(600)
            append(threadId, Step("userMessage", text))
            status(threadId, "running")
            play(threadId, if (threadId == "demo-8") loggingSteerSteps() else genericSteerSteps(text))
        }
    }

    private fun turnSteps(backend: String): List<Step> = listOf(
        agent("好的，我先看一下商品详情接口和订单缓存是怎么写的，照同样的方式加。"),
        command("rg -n \"getProduct\" src\n src/products/service.ts:18  export async function getProduct(id: string)\n src/products/routes.ts:9   router.get('/products/:id', getProduct)"),
        change("src/products/cache.ts  新增 +32\nsrc/products/service.ts  +5 −1\nsrc/orders/cache.ts  +3 −8"),
        command("npm test\n Tests: 52 passed, 52 total"),
        agent("改好了：\n1. 新增 [src/products/cache.ts](src/products/cache.ts)，商品详情缓存 60 秒；\n2. 商品改价、下架时清掉对应缓存；\n3. 和订单缓存共用 [src/orders/cache.ts](src/orders/cache.ts) 里的过期逻辑；\n4. 52 个测试全部通过。" +
            if (backend == "claude") "\n\n需要的话我可以再补一组缓存命中率的监控。" else "\n\n要我顺便提交吗？"),
    )

    private fun loggingSteerSteps() = listOf(
        agent("收到，每条日志都带上请求 ID，方便按一次请求串起来看。"),
        change("src/log/logger.ts  +6 −1\nsrc/http/middleware.ts  +9"),
        command("npm test\n Tests: 61 passed, 61 total"),
        agent("全部改完了：\n1. 37 处日志都换成了 JSON 格式，字段有 `time`、`level`、`requestId`、`msg`；\n2. 请求 ID 在中间件里生成，一次请求里的日志都能串起来；\n3. 61 个测试全部通过。"),
    )

    private fun genericSteerSteps(text: String) = listOf(
        agent("收到，按你补充的「${text.take(24)}」调整。"),
        command("npm test\n Tests: 52 passed, 52 total"),
        agent("已经按你的补充改好，测试都通过了。"),
    )

    private suspend fun answer(requestId: String, threadId: String, args: JSONObject) {
        val waiting = host.thread(threadId)?.waiting
        reply(requestId, threadId, true, JSONObject().put("ok", true))
        host.updateThread(threadId) { it.copy(waiting = null, note = "", unread = false) }
        status(threadId, "running")
        val choice = args.optString("choice").takeIf { it.isNotBlank() && it != "null" }
        val answer = args.optJSONArray("answers")?.optJSONObject(0)
        val picked = answer?.optJSONArray("labels")?.optString(0)?.takeIf { it.isNotBlank() }
            ?: answer?.optString("other")?.takeIf { it.isNotBlank() }
        val steps = when (waiting?.kind) {
            "question" -> refactorPlan(picked.orEmpty())
            "permission" -> if (choice == "deny") listOf(
                agent("好的，这次不删。8 月的 3 个备份还留在 `backups` 目录里，共 1.2 GB。\n\n要不要改成先打包挪到移动硬盘，再从电脑上删掉？"),
            ) else listOf(
                command("Remove-Item backups\\2026-08-*.zip\n 已删除 3 个文件，释放 1.2 GB"),
                agent("清理完了：删除了 8 月的 3 个备份，释放 1.2 GB。11 月的备份保留着，备份目录现在只占 420 MB。" +
                    if (choice == "allow_auto") "\n\n已切到自动模式，之后类似的清理不再逐个询问。" else ""),
            )
            else -> listOf(agent("收到，继续处理。"))
        }
        play(threadId, steps, first = 1_200)
    }

    private fun refactorPlan(picked: String): List<Step> = when (picked) {
        "回调处理" -> listOf(
            agent("好，先从支付回调开始，这部分改动最小、收益最快。我再细看一下回调相关的代码。"),
            command("rg -n \"handleCallback\" src/payment\n src/payment/callback.ts:12  export async function handleCallback(req)\n src/payment/notify.ts:40    handleCallback(payload)"),
            agent("回调处理的重构方案：\n1. 把 `callback.ts` 拆成**验签**、**记账**、**发通知**三个函数；\n2. 记账改成幂等写入，同一个订单号重复回调只记一次；\n3. 发通知放进队列，失败自动重试，不再拖慢回调响应；\n4. 先补 8 个回调测试，再动代码。\n\n详细步骤写在 [docs/payment-refactor-plan.md](docs/payment-refactor-plan.md)，你看过没问题我再开始改。"),
        )
        "对账脚本" -> listOf(
            agent("好，先重写对账脚本。我先对比一下脚本和线上代码的计算逻辑。"),
            command("diff <(rg -n \"fee\" scripts/reconcile.py) <(rg -n \"fee\" src/payment)\n 手续费计算有 3 处不一致"),
            agent("对账脚本的重构方案：\n1. 对账直接调用线上的金额计算函数，不再自己写一套；\n2. 手续费的 3 处差异先统一，以线上为准；\n3. 对账结果写进数据库，差异超过 1 元自动提醒；\n4. 用上个月的数据回放一遍，结果一致再上线。\n\n详细步骤写在 [docs/payment-refactor-plan.md](docs/payment-refactor-plan.md)。"),
        )
        "退款流程" -> listOf(
            agent("好，先处理退款流程。我先看一下最近两次线上问题的记录。"),
            command("git log --grep=refund --oneline -5\n a91c2e4 fix: partial refund rounding\n 7d03b1f fix: duplicate refund on retry"),
            agent("退款流程的重构方案：\n1. 先补测试：部分退款、重复退款、退款失败重试各 3 个用例；\n2. 退款请求加幂等键，重试不会退两次；\n3. 金额统一按分计算，避免小数误差；\n4. 测试补齐后再拆分 `refund.ts`。\n\n详细步骤写在 [docs/payment-refactor-plan.md](docs/payment-refactor-plan.md)。"),
        )
        else -> listOf(
            agent("明白，按你说的「${picked.take(30)}」来安排。"),
            agent("方案已经整理好，写在 [docs/payment-refactor-plan.md](docs/payment-refactor-plan.md)，你看过没问题我再开始改。"),
        )
    }

    private fun newThread(requestId: String, args: JSONObject) {
        val backend = args.optString("backend").ifBlank { "codex" }
        val text = args.optString("text").trim()
        val id = synchronized(lock) { "demo-new-${++newThreads}" }
        val connector = DemoData.PC
        host.addThread(ThreadSummary(id, text.lineSequence().firstOrNull().orEmpty().take(24).ifBlank { "新任务" },
            args.optString("cwd"), "running", System.currentTimeMillis(), false, connector, backend = backend))
        synchronized(lock) { history[id] = mutableListOf() }
        reply(requestId, id, true, JSONObject().put("threadId", id))
        if (text.isNotBlank()) startTurn(id, text, firstMessage = true)
    }

    // ---- settings

    private fun settingsOf(threadId: String): JSONObject = synchronized(lock) {
        val backend = host.thread(threadId)?.backend ?: "codex"
        JSONObject(settings.getOrPut(threadId) {
            when (backend) {
                "claude" -> JSONObject().put("backend", "claude").put("model", "opus").put("effort", "high").put("permissionMode", "acceptEdits")
                "dsh", "hermes" -> JSONObject().put("backend", backend).put("model", "deepseek/deepseek-chat").put("effort", "")
                    .put("permissionMode", "workspace-write")
                "pi" -> JSONObject().put("backend", "pi").put("model", host.thread(threadId)?.model?.ifBlank { null } ?: "deepseek/deepseek-chat").put("thinkingLevel", "medium")
                else -> JSONObject().put("model", "gpt-5.5").put("effort", "medium").put("permissionMode", "auto")
                    .put("approvalPolicy", "on-request").put("collaborationMode", "default")
            }
        }.toString()).also { value ->
            if (backend == "dsh" || backend == "hermes") value.put("catalog", deepSeekCatalog()).put("permissionCatalog", dshPermissions())
        }
    }

    private fun saveSettings(requestId: String, threadId: String, args: JSONObject) {
        val backend = host.thread(threadId)?.backend ?: "codex"
        val changes = args.optJSONObject("settings") ?: JSONObject(args.toString()).apply { remove("threadId"); remove("title") }
        settingsOf(threadId)
        val saved = synchronized(lock) {
            val current = settings.getValue(threadId)
            changes.keys().forEach { key ->
                if (changes.isNull(key)) current.remove(key) else current.put(key, changes.get(key))
            }
            if (changes.has("collaborationMode")) current.put("effectiveCollaborationMode", changes.optString("collaborationMode"))
            JSONObject(current.toString())
        }
        if (backend == "pi") saved.optString("model").takeIf { it.isNotBlank() }?.let { model -> host.updateThread(threadId) { it.copy(model = model) } }
        val result = saved.put("backend", if (backend == "codex") "" else backend).put("updatedAt", System.currentTimeMillis())
        if (backend == "pi") result.put("note", "Pi 设置已保存")
        reply(requestId, threadId, true, result)
    }

    private fun efforts(vararg values: String) = JSONArray().apply {
        values.forEach { put(JSONObject().put("reasoningEffort", it)) }
    }

    /** Same shape as Codex's model/list, rate limits, features and collaboration modes. */
    private fun codexCapabilities(): JSONArray {
        val now = System.currentTimeMillis() / 1000
        val models = JSONArray()
            .put(JSONObject().put("id", "gpt-5.5").put("isDefault", true).put("defaultReasoningEffort", "medium")
                .put("supportedReasoningEfforts", efforts("low", "medium", "high", "xhigh")).put("additionalSpeedTiers", JSONArray().put("fast")))
            .put(JSONObject().put("id", "gpt-5.4").put("defaultReasoningEffort", "high")
                .put("supportedReasoningEfforts", efforts("low", "medium", "high", "xhigh")).put("additionalSpeedTiers", JSONArray().put("fast")))
            .put(JSONObject().put("id", "gpt-5.3-codex").put("defaultReasoningEffort", "medium")
                .put("supportedReasoningEfforts", efforts("low", "medium", "high", "xhigh")))
        val limits = JSONObject().put("rateLimits", JSONObject()
            .put("primary", JSONObject().put("usedPercent", 18).put("windowDurationMins", 300).put("resetsAt", now + 3 * 3600))
            .put("secondary", JSONObject().put("usedPercent", 32).put("windowDurationMins", 10080).put("resetsAt", now + 3 * 86400))
            .put("planType", "plus"))
        val modes = JSONObject().put("data", JSONArray()
            .put(JSONObject().put("name", "Default").put("mode", "default"))
            .put(JSONObject().put("name", "Plan").put("mode", "plan")))
        return JSONArray().put(JSONObject().put("data", models)).put(limits).put(JSONObject()).put(modes)
    }

    /** Claude's model list as the connector reads it from the desktop app. */
    private fun claudeCapabilities(): JSONObject {
        fun model(value: String, label: String, vararg efforts: String) =
            JSONObject().put("value", value).put("label", label).put("efforts", JSONArray().apply { efforts.forEach(::put) })
        val models = JSONArray()
            .put(model("default", "默认 · Opus 5.5 (1M)", "low", "medium", "high", "xhigh", "max"))
            .put(model("opus", "Opus 5.5", "low", "medium", "high", "xhigh", "max"))
            .put(model("sonnet", "Sonnet 5", "low", "medium", "high"))
            .put(model("haiku", "Haiku 4.5"))
        return JSONObject().put("backends", JSONObject().put("claude", JSONObject().put("capabilities", JSONObject().put("models", models))))
    }

    private fun claudeUsage(): JSONObject {
        val now = System.currentTimeMillis()
        return JSONObject().put("updatedAt", now).put("snapshotAt", now)
            .put("fiveHour", JSONObject().put("remainingPercent", 74).put("resetsAt", now + 2 * 3_600_000L + 12 * 60_000L).put("observedAt", now))
            .put("sevenDay", JSONObject().put("remainingPercent", 58).put("resetsAt", now + 4 * 86_400_000L).put("observedAt", now))
    }

    private fun dshUsage(): JSONObject {
        val now = System.currentTimeMillis()
        val day = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date(now))
        return JSONObject().put("day", day).put("updatedAt", now)
            .put("today", JSONObject().put("input", 182_400).put("output", 46_100).put("cacheRead", 521_000).put("cacheWrite", 0).put("total", 749_500))
            .put("account", JSONObject().put("status", "active").put("balance", JSONArray().put(JSONObject().put("currency", "CNY").put("balance", "86.40"))))
            .put("spent", 3.62).put("spentCurrency", "CNY").put("spentSince", now - 86_400_000L)
    }

    private fun deepSeekCatalog(): JSONObject {
        val reasoning = JSONObject().put("defaultEffort", "medium").put("efforts", JSONArray()
            .put(JSONObject().put("id", "low").put("name", "低"))
            .put(JSONObject().put("id", "medium").put("name", "中"))
            .put(JSONObject().put("id", "high").put("name", "高")))
        val models = JSONArray()
            .put(JSONObject().put("id", "deepseek-chat").put("name", "DeepSeek Chat"))
            .put(JSONObject().put("id", "deepseek-reasoner").put("name", "DeepSeek Reasoner").put("reasoning", reasoning))
        return JSONObject().put("groups", JSONArray().put(JSONObject().put("id", "deepseek").put("name", "DeepSeek").put("models", models)))
            .put("default", JSONObject().put("provider", "deepseek").put("model", "deepseek-chat"))
    }

    private fun dshPermissions(): JSONObject = JSONObject().put("defaultPreset", "workspace-write").put("options", JSONArray()
        .put(JSONObject().put("value", "read-only").put("name", "只读").put("description", "只能读文件，不改动任何东西"))
        .put(JSONObject().put("value", "workspace-write").put("name", "工作区可写").put("description", "可以改工作目录里的文件"))
        .put(JSONObject().put("value", "danger-full-access").put("name", "完全权限").put("description", "不再询问，完全放手执行")))

    private fun piModels(threadId: String?): JSONObject {
        val current = threadId?.let(::settingsOf)
        val model = current?.optString("model")?.takeIf { it.contains('/') } ?: "deepseek/deepseek-chat"
        val models = JSONArray()
            .put(JSONObject().put("provider", "deepseek").put("id", "deepseek-chat").put("name", "DeepSeek Chat").put("contextWindow", 128_000).put("reasoning", false))
            .put(JSONObject().put("provider", "deepseek").put("id", "deepseek-reasoner").put("name", "DeepSeek Reasoner").put("contextWindow", 128_000).put("reasoning", true))
        return JSONObject().put("catalog", JSONObject().put("models", models))
            .put("thinkingLevels", JSONObject().put("levels", JSONArray().put("off").put("low").put("medium").put("high")))
            .put("status", JSONObject().put("model", JSONObject().put("provider", model.substringBefore('/')).put("id", model.substringAfter('/')))
                .put("thinkingLevel", current?.optString("thinkingLevel")?.ifBlank { null } ?: "medium"))
    }

    // ---- files

    private fun fileChunk(path: String, offset: Long, size: Int): JSONObject {
        val bytes = fileText(path).toByteArray(Charsets.UTF_8)
        val start = offset.coerceIn(0, bytes.size.toLong()).toInt()
        val end = minOf(bytes.size, start + size.coerceAtLeast(1))
        val chunk = bytes.copyOfRange(start, end)
        return JSONObject().put("data", Base64.encodeToString(chunk, Base64.NO_WRAP)).put("total", bytes.size).put("eof", end >= bytes.size)
    }

    private fun fileText(path: String): String {
        val name = path.substringAfterLast('\\').substringAfterLast('/')
        val ext = name.substringAfterLast('.', "").lowercase()
        return when {
            name == "cache.ts" && path.contains("products") -> DemoFiles.productCache
            ext in setOf("ts", "tsx", "js") -> DemoFiles.orderCache
            name.startsWith("weekly") -> DemoFiles.weeklyReport
            name.startsWith("payment-refactor") -> DemoFiles.refactorPlan
            ext == "md" -> DemoFiles.readme
            ext == "py" -> DemoFiles.exportScript
            else -> "这是演示文件：$name\n"
        }
    }
}

/** Contents of the computer files the demo conversations link to. */
private object DemoFiles {
    val orderCache = """
        |import { redis } from '../lib/redis';
        |import type { Order } from './types';
        |
        |/** Order lists are cached per user for 60 seconds. */
        |const TTL_SECONDS = 60;
        |const key = (userId: string) => `orders:list:${'$'}{userId}`;
        |
        |export async function getCachedOrders(userId: string): Promise<Order[] | null> {
        |  const raw = await redis.get(key(userId));
        |  if (!raw) return null;
        |  try {
        |    return JSON.parse(raw) as Order[];
        |  } catch {
        |    // A broken entry is dropped and read again from the database.
        |    await redis.del(key(userId));
        |    return null;
        |  }
        |}
        |
        |export async function cacheOrders(userId: string, orders: Order[]): Promise<void> {
        |  await redis.set(key(userId), JSON.stringify(orders), 'EX', TTL_SECONDS);
        |}
        |
        |/** Called after an order is placed or cancelled. */
        |export async function invalidateOrders(userId: string): Promise<void> {
        |  await redis.del(key(userId));
        |}
        |
        |export async function withOrderCache(
        |  userId: string,
        |  load: () => Promise<Order[]>,
        |): Promise<Order[]> {
        |  const cached = await getCachedOrders(userId);
        |  if (cached) return cached;
        |  const fresh = await load();
        |  await cacheOrders(userId, fresh);
        |  return fresh;
        |}
        |""".trimMargin()

    val productCache = """
        |import { redis } from '../lib/redis';
        |import type { Product } from './types';
        |
        |const TTL_SECONDS = 60;
        |const key = (id: string) => `products:detail:${'$'}{id}`;
        |
        |export async function getProductCached(id: string, load: () => Promise<Product>): Promise<Product> {
        |  const raw = await redis.get(key(id));
        |  if (raw) return JSON.parse(raw) as Product;
        |  const product = await load();
        |  await redis.set(key(id), JSON.stringify(product), 'EX', TTL_SECONDS);
        |  return product;
        |}
        |
        |/** Price changes and delisting clear the cached detail at once. */
        |export async function invalidateProduct(id: string): Promise<void> {
        |  await redis.del(key(id));
        |}
        |""".trimMargin()

    val weeklyReport = """
        |# 工作周报 · 2026 年第 45 周
        |
        |> 11 月 2 日 — 11 月 8 日 · 商城后端组
        |
        |## 本周完成
        |
        || 类别 | 数量 | 说明 |
        ||---|---:|---|
        || 需求 | 9 | 订单缓存、导出 Excel、首页响应式等 |
        || 问题修复 | 6 | 登录页闪退、退款金额取整等 |
        || 提交 | 41 | 3 个仓库 |
        |
        |### 重点
        |
        |1. **订单接口缓存**：订单列表按用户缓存 60 秒，平均响应从 420 ms 降到 85 ms。
        |2. **登录页闪退**：安卓 14 上登录回调时页面已关闭导致闪退，已修复并验证。
        |3. **测试数据清理**：测试库只保留最近一周的数据，库体积减少 70%。
        |
        |## 数据
        |
        |- 接口 P95 延迟：**180 ms**（上周 510 ms）
        |- 线上错误率：0.12%（上周 0.31%）
        |- 测试用例：128 个，全部通过
        |
        |## 下周计划
        |
        |- [ ] 支付模块重构：先从回调处理开始
        |- [ ] 商品详情接口加缓存
        |- [ ] 日志改成结构化格式，接入日志平台
        |
        |## 风险
        |
        |支付回调重构期间需要灰度发布，预计周三上线 10% 流量。
        |""".trimMargin()

    val refactorPlan = """
        |# 支付模块重构方案
        |
        |## 目标
        |
        |把支付模块拆成边界清楚的几部分，每次只改一处，改完都能独立上线。
        |
        |## 步骤
        |
        |1. **补测试**：回调、对账、退款各补一组用例，覆盖重复请求和失败重试。
        |2. **拆回调**：`callback.ts` 拆成验签、记账、发通知三个函数。
        |3. **幂等记账**：按订单号去重，重复回调只记一次。
        |4. **通知进队列**：失败自动重试，不阻塞回调响应。
        |5. **灰度上线**：先放 10% 流量，观察一天再全量。
        |
        |## 不在这次范围
        |
        |- 更换支付渠道
        |- 改动数据库表结构
        |""".trimMargin()

    val readme = """
        |# Shop Blog
        |
        |A small blog for the shop team, built with Astro.
        |
        |## Getting started
        |
        |```bash
        |npm install
        |npm run dev
        |```
        |
        |Open http://localhost:4321 to see it.
        |""".trimMargin()

    val exportScript = """
        |import pandas as pd
        |from db import connect
        |
        |
        |def export_orders(year: int) -> str:
        |    # Export a year's orders to Excel, one sheet per month.
        |    frame = pd.read_sql("select * from orders where extract(year from created_at) = %s", connect(), params=[year])
        |    path = f"orders-{year}.xlsx"
        |    with pd.ExcelWriter(path) as writer:
        |        for month, rows in frame.groupby(frame.created_at.dt.month):
        |            rows.to_excel(writer, sheet_name=f"{month} 月", index=False)
        |    return path
        |""".trimMargin()
}
