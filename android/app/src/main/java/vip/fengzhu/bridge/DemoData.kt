package vip.fengzhu.bridge

/**
 * Made-up sessions for website and README screenshots. Only a debug build made
 * with -PkhlinkDemo (package vip.fengzhu.bridge.demo) uses them: the real
 * screens render this data and nothing touches the network.
 */
internal object DemoData {
    const val PC = "demo-pc.connector"

    fun threads(now: Long = System.currentTimeMillis()): List<ThreadSummary> = listOf(
        ThreadSummary("demo-1", "给订单接口加一层缓存", "D:\\work\\shop-api", "completed", now - 60_000, false, PC, backend = "codex"),
        ThreadSummary("demo-2", "清理旧的测试数据", "D:\\work\\reports", "desktop_waiting_approval", now - 4 * 60_000, false, PC, unread = true, backend = "codex",
            note = "等你批准：删除 3 个过期的备份文件"),
        ThreadSummary("demo-3", "整理本周的工作周报", "D:\\work\\reports", "completed", now - 35 * 60_000, false, PC, unread = true, backend = "codex"),
        ThreadSummary("demo-4", "修复登录页闪退", "D:\\work\\shop-android", "completed", now - 2 * 3_600_000, false, PC, pinned = true, pinOrder = 0, backend = "codex"),
        ThreadSummary("demo-5", "升级依赖并跑一遍测试", "D:\\work\\blog", "running", now - 20_000, false, PC, backend = "codex"),
        ThreadSummary("demo-6", "首页改成响应式布局", "D:\\work\\site", "completed", now - 50 * 3_600_000, false, PC, backend = "codex"),
        ThreadSummary("demo-7", "写一个导出 Excel 的脚本", "D:\\work\\tools", "completed", now - 75 * 3_600_000, false, PC, backend = "codex"),
        // A question with options, answered from the phone.
        ThreadSummary("demo-c1", "梳理支付模块的重构方案", "D:\\work\\shop-api", "desktop_waiting", now - 2 * 60_000, false, PC, unread = true, backend = "claude",
            note = "等你回答：先重构哪一部分？",
            waiting = DesktopWaiting("question", "AskUserQuestion", "demo-q1", questions = listOf(WaitingQuestion(
                "支付模块先从哪一部分开始重构？", header = "重构顺序", options = listOf(
                    WaitingOption("回调处理", "先把支付回调拆成独立的服务，改动最小"),
                    WaitingOption("对账脚本", "对账逻辑最乱，先重写它"),
                    WaitingOption("退款流程", "退款最常出问题，先补测试再重构"),
                ))))),
        // A command waiting for permission.
        ThreadSummary("demo-c3", "清理过期的备份文件", "D:\\work\\reports", "desktop_waiting", now - 6 * 60_000, false, PC, unread = true, backend = "claude",
            note = "等你批准：删除 3 个过期的备份文件",
            waiting = DesktopWaiting("permission", "Bash", "demo-p1", summary = "Remove-Item backups\\2026-08-*.zip",
                description = "删除 8 月的 3 个备份压缩包，共 1.2 GB")),
        ThreadSummary("demo-c2", "给周报生成一张趋势图", "D:\\work\\reports", "completed", now - 5 * 3_600_000, false, PC, backend = "claude"),
    )

    fun items(threadId: String, now: Long = System.currentTimeMillis()): List<HistoryItem> {
        val base = now - 6 * 60_000
        fun item(order: Int, type: String, text: String, status: String? = "completed") =
            HistoryItem("$threadId-$order", order.toLong(), type, text, status, false, createdAt = base + order * 45_000L)
        if (threadId == "demo-c1") return listOf(
            item(1, "userMessage", "支付模块越改越乱，帮我梳理一下重构方案，先别动代码。", null),
            item(2, "agentMessage", "我先读一遍支付模块的代码和最近的提交记录。"),
            item(3, "commandExecution", "git log --oneline -20 -- src/payment\n 18 commits, 11 touch callback.ts"),
            item(4, "agentMessage", "看完了，问题主要在三处：\n1. **回调处理**：`callback.ts` 里校验、记账、发通知混在一个函数里；\n2. **对账脚本**：每天跑一次，逻辑和线上代码各写了一套；\n3. **退款流程**：没有测试，最近两次线上问题都在这里。\n\n三处都能改，但最好一次只动一处。"),
        )
        if (threadId == "demo-c3") return listOf(
            item(1, "userMessage", "备份目录快满了，把 3 个月前的备份清掉。", null),
            item(2, "commandExecution", "Get-ChildItem backups | Sort-Object LastWriteTime\n 2026-08-03.zip  410 MB\n 2026-08-17.zip  395 MB\n 2026-08-31.zip  402 MB\n 2026-11-02.zip  420 MB"),
            item(3, "agentMessage", "8 月的 3 个备份已经超过 3 个月，共 1.2 GB，11 月的保留。删除前需要你确认。"),
        )
        return listOf(
            item(1, "userMessage", "订单列表接口最近很慢，帮我加一层缓存，缓存 60 秒就行，改完跑一下测试。", null),
            item(2, "agentMessage", "好的。我先看一下订单列表接口的实现和现有测试。"),
            item(3, "commandExecution", "rg -n \"listOrders\" src\n src/orders/service.ts:42  export async function listOrders(userId: string)"),
            item(4, "fileChange", "src/orders/cache.ts  新增 +38\nsrc/orders/service.ts  +6 −2"),
            item(5, "commandExecution", "npm test\n Tests: 46 passed, 46 total"),
            item(6, "agentMessage", "改好了：\n1. 新增 `src/orders/cache.ts`，按用户缓存订单列表 60 秒；\n2. 下单和取消订单时清掉这个用户的缓存，避免看到旧数据；\n3. 46 个测试全部通过。\n\n要不要顺便把商品详情接口也加上缓存？"),
            item(7, "userMessage", "先不用，帮我提交一下。", null),
            item(8, "agentMessage", "已提交：`feat(orders): cache order lists for 60 s`。"),
        )
    }
}
