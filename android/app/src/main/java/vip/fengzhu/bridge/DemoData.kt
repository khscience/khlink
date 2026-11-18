package vip.fengzhu.bridge

/**
 * Made-up sessions for website and README screenshots. Only a debug build made
 * with -PkhlinkDemo (package vip.fengzhu.bridge.demo) uses them: the real
 * screens render this data and nothing touches the network.
 */
internal object DemoData {
    /** Ready drafts for screen recordings (the emulator keyboard has no Chinese). */
    fun draft(threadId: String): String = when (threadId) {
        "demo-1" -> "商品详情接口也加上缓存，同样 60 秒"
        "demo-8" -> "顺便给每条日志带上请求 ID"
        else -> ""
    }

    const val PC = "demo-pc.connector"
    const val PC2 = "demo-pc2.connector"

    /** Two computers on the demo account; the home screen switches between them. */
    val COMPUTERS = listOf(
        DeviceEntry(PC, "家里的电脑", "connector", false),
        DeviceEntry(PC2, "公司电脑", "connector", false),
    )

    fun threads(now: Long = System.currentTimeMillis()): List<ThreadSummary> = listOf(
        // ---- 家里的电脑 · Codex
        ThreadSummary("demo-1", "给订单接口加一层缓存", "D:\\work\\shop-api", "completed", now - 60_000, false, PC, backend = "codex"),
        // Turns into "等你批准" about 5 s after the app starts (DemoScript).
        ThreadSummary("demo-2", "清理旧的测试数据", "D:\\work\\reports", "completed", now - 4 * 60_000, false, PC, pinned = true, pinOrder = 1, backend = "codex"),
        ThreadSummary("demo-3", "整理本周的工作周报", "D:\\work\\reports", "completed", now - 35 * 60_000, false, PC, pinned = true, pinOrder = 2, unread = true, backend = "codex"),
        ThreadSummary("demo-4", "修复登录页闪退", "D:\\work\\shop-android", "completed", now - 2 * 3_600_000, false, PC, pinned = true, pinOrder = 0, backend = "codex"),
        // Finishes about 8 s after the app starts (DemoScript).
        ThreadSummary("demo-5", "升级依赖并跑一遍测试", "D:\\work\\blog", "running", now - 20_000, false, PC, backend = "codex"),
        // Keeps running: messages sent here are queued, then sent at once with 引导.
        ThreadSummary("demo-8", "把日志改成结构化格式", "D:\\work\\shop-api", "running", now - 90_000, false, PC, backend = "codex"),
        ThreadSummary("demo-6", "首页改成响应式布局", "D:\\work\\site", "completed", now - 50 * 3_600_000, false, PC, backend = "codex"),
        ThreadSummary("demo-7", "写一个导出 Excel 的脚本", "D:\\work\\tools", "completed", now - 75 * 3_600_000, false, PC, backend = "codex"),
        ThreadSummary("demo-archived", "已归档的示例对话", "D:\\work\\archive", "completed", now - 95 * 3_600_000, true, PC, backend = "codex"),
        // ---- 家里的电脑 · Claude
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
        // ---- 家里的电脑 · DeepSeek (DSH)
        ThreadSummary("demo-d1", "分析上个月的销售数据", "D:\\work\\reports", "completed", now - 25 * 60_000, false, PC, unread = true, backend = "dsh"),
        ThreadSummary("demo-d2", "给 README 补一版英文", "D:\\work\\blog", "completed", now - 3 * 3_600_000, false, PC, backend = "dsh"),
        ThreadSummary("demo-d3", "排查定时任务没有执行", "D:\\work\\tools", "completed", now - 26 * 3_600_000, false, PC, backend = "dsh"),
        // ---- 家里的电脑 · Hermes
        ThreadSummary("demo-h1", "每天早上汇总服务器告警", "D:\\work\\ops", "completed", now - 40 * 60_000, false, PC, backend = "hermes"),
        ThreadSummary("demo-h2", "整理周会纪要", "D:\\work\\reports", "completed", now - 6 * 3_600_000, false, PC, backend = "hermes"),
        // ---- 家里的电脑 · Pi
        ThreadSummary("demo-p1", "写一个批量重命名照片的脚本", "D:\\photos", "completed", now - 90 * 60_000, false, PC, backend = "pi", model = "deepseek/deepseek-chat"),
        ThreadSummary("demo-p2", "解释这段正则表达式", "D:\\work\\tools", "completed", now - 28 * 3_600_000, false, PC, backend = "pi", model = "deepseek/deepseek-chat"),
        // ---- 家里的电脑 · 反重力
        ThreadSummary("demo-a1", "做一个番茄钟网页", "D:\\work\\pomodoro", "completed", now - 2 * 3_600_000, false, PC, backend = "antigravity"),
        ThreadSummary("demo-a2", "给落地页加深色模式", "D:\\work\\site", "completed", now - 30 * 3_600_000, false, PC, backend = "antigravity"),
        // ---- 公司电脑
        ThreadSummary("work-1", "排查线上接口偶发 502", "E:\\projects\\gateway", "completed", now - 15 * 60_000, false, PC2, unread = true, backend = "codex"),
        ThreadSummary("work-2", "给后台加操作日志导出", "E:\\projects\\admin", "completed", now - 4 * 3_600_000, false, PC2, backend = "codex"),
        ThreadSummary("work-c1", "审查合同模块的合并请求", "E:\\projects\\contracts", "completed", now - 50 * 60_000, false, PC2, backend = "claude"),
        ThreadSummary("work-d1", "整理季度数据报表", "E:\\projects\\bi", "completed", now - 2 * 3_600_000, false, PC2, backend = "dsh"),
        ThreadSummary("work-h1", "下午三点提醒我参加评审", "E:\\projects", "completed", now - 3 * 3_600_000, false, PC2, backend = "hermes"),
        ThreadSummary("work-p1", "根据接口代码生成文档", "E:\\projects\\gateway", "completed", now - 7 * 3_600_000, false, PC2, backend = "pi", model = "deepseek/deepseek-chat"),
        ThreadSummary("work-a1", "原型页面加一个筛选栏", "E:\\projects\\prototype", "completed", now - 9 * 3_600_000, false, PC2, backend = "antigravity"),
    )

    private class Line(val type: String, val text: String)
    private fun user(text: String) = Line("userMessage", text)
    private fun agent(text: String) = Line("agentMessage", text)
    private fun command(text: String) = Line("commandExecution", text)
    private fun change(text: String) = Line("fileChange", text)

    private fun conversation(threadId: String): List<Line> = when (threadId) {
        "demo-c1" -> listOf(
            user("支付模块越改越乱，帮我梳理一下重构方案，先别动代码。"),
            agent("我先读一遍支付模块的代码和最近的提交记录。"),
            command("git log --oneline -20 -- src/payment\n 18 commits, 11 touch callback.ts"),
            agent("看完了，问题主要在三处：\n1. **回调处理**：`callback.ts` 里校验、记账、发通知混在一个函数里；\n2. **对账脚本**：每天跑一次，逻辑和线上代码各写了一套；\n3. **退款流程**：没有测试，最近两次线上问题都在这里。\n\n三处都能改，但最好一次只动一处。"),
        )
        "demo-c3" -> listOf(
            user("备份目录快满了，把 3 个月前的备份清掉。"),
            command("Get-ChildItem backups | Sort-Object LastWriteTime\n 2026-08-03.zip  410 MB\n 2026-08-17.zip  395 MB\n 2026-08-31.zip  402 MB\n 2026-11-02.zip  420 MB"),
            agent("8 月的 3 个备份已经超过 3 个月，共 1.2 GB，11 月的保留。删除前需要你确认。"),
        )
        "demo-c2" -> listOf(
            user("用这几周的周报数据画一张需求完成数的趋势图。"),
            command("python scripts/trend.py --weeks 8\n 已生成 charts/weekly-trend.png"),
            agent("画好了：[charts/weekly-trend.png](charts/weekly-trend.png)。最近 8 周平均每周完成 14 个需求，W44 最多（19 个）。"),
        )
        "demo-2" -> listOf(
            user("测试库里堆了很多旧数据，帮我清理一下，只留最近一周的。"),
            command("npm run db:stats\n orders_test   182,340 行\n users_test     12,906 行"),
            agent("一周以前的测试订单有 17 万多条。清理脚本已经写好，执行前会请你在电脑上批准。"),
        )
        "demo-3" -> listOf(
            user("把这周的提交记录和需求单整理成一份周报。"),
            agent("好的，我先看一下这周的提交和已关闭的需求。"),
            command("git log --since=\"last monday\" --oneline | wc -l\n 41"),
            change("docs/weekly-2026-W45.md  新增 +46"),
            agent("周报写好了：[docs/weekly-2026-W45.md](docs/weekly-2026-W45.md)\n\n- 本周完成 9 个需求，修复 6 个问题；\n- 订单接口加了缓存，平均响应从 420 ms 降到 85 ms；\n- 下周重点：支付模块重构。"),
        )
        "demo-4" -> listOf(
            user("登录页在安卓 14 上一打开就闪退，帮我看看。"),
            command("adb logcat -d | grep FATAL\n FATAL EXCEPTION: main  java.lang.IllegalStateException: Fragment not attached"),
            change("app/src/main/java/com/shop/LoginFragment.kt  +4 −1"),
            agent("原因是登录回调回来时页面已经关闭了。改成只在页面还在时更新界面，已经在安卓 14 上验证不再闪退。"),
        )
        "demo-5" -> listOf(
            user("把项目依赖都升级到最新的小版本，然后跑一遍测试。"),
            agent("好的，我先看看哪些依赖可以升级。"),
            command("npm outdated\n 12 个依赖有新的小版本"),
            change("package.json  +12 −12\npackage-lock.json  +418 −396"),
            agent("依赖已经升级，正在跑测试……"),
        )
        "demo-8" -> listOf(
            user("把日志改成结构化的 JSON 格式，所有模块都要改。"),
            agent("好的，我先统计一下现在有多少处日志调用。"),
            command("rg -c \"console.log\" src\n 共 37 处，分布在 12 个文件"),
            change("src/log/logger.ts  新增 +54"),
            agent("logger 已经写好，正在逐个模块替换……"),
        )
        "demo-6" -> listOf(
            user("首页在手机上排版是乱的，改成响应式布局。"),
            change("src/styles/home.css  +36 −12"),
            agent("改好了：宽度小于 768 px 时卡片改成单列，导航收进菜单按钮。"),
        )
        "demo-7" -> listOf(
            user("写个脚本，把订单表导出成 Excel，按月份分 sheet。"),
            change("scripts/export_orders.py  新增 +64"),
            command("python scripts/export_orders.py --year 2026\n 已导出 orders-2026.xlsx（10 个工作表）"),
            agent("脚本在 [scripts/export_orders.py](scripts/export_orders.py)，导出的文件按月份分了 10 个工作表。"),
        )
        "demo-d1" -> listOf(
            user("分析一下上个月的销售数据，看看哪些商品卖得最好。"),
            command("python analysis/monthly.py --month 2026-10\n 读取 8,214 条订单"),
            agent("10 月销量前三：\n1. 无线耳机 1,206 件\n2. 保温杯 984 件\n3. 机械键盘 731 件\n\n保温杯比 9 月涨了 62%，主要来自降温后的周末。"),
        )
        "demo-d2" -> listOf(
            user("README 只有中文，帮我补一版英文的。"),
            change("README.en.md  新增 +88"),
            agent("英文版写在 [README.en.md](README.en.md)，中文版顶部加了切换链接。"),
        )
        "demo-d3" -> listOf(
            user("每天凌晨的备份任务这两天没执行，帮我查一下。"),
            command("schtasks /query /tn NightlyBackup /v\n 上次结果: 0x1  下次运行: 2026-11-09 02:00"),
            agent("任务在跑，但脚本路径还是旧的 `D:\\old\\backup.ps1`。已经改成新路径，今晚会正常执行。"),
        )
        "demo-h1" -> listOf(
            user("每天早上 8 点把服务器告警汇总发给我。"),
            agent("已设好定时任务：每天 8:00 汇总前 24 小时的告警，按严重程度排序后发给你。今天的汇总：2 条警告，0 条严重。"),
        )
        "demo-h2" -> listOf(
            user("把周会录音转成纪要，列出待办。"),
            agent("纪要整理好了：\n- 下周三发布 2.3 版本；\n- 小王负责支付回调压测；\n- 客服反馈的退款问题周五前给结论。"),
        )
        "demo-p1" -> listOf(
            user("写个脚本把照片按拍摄日期重命名。"),
            change("rename_photos.py  新增 +41"),
            agent("脚本读取照片的拍摄时间，把文件改成 `2026-10-03_142501.jpg` 这样的名字，重名会自动加序号。"),
        )
        "demo-p2" -> listOf(
            user("解释一下 ^(?=.*\\d)(?=.*[a-z]).{8,}$ 是什么意思。"),
            agent("它检查密码：至少 8 位，至少有一个数字和一个小写字母。两个 `(?=…)` 只做检查，不消耗字符。"),
        )
        "demo-a1" -> listOf(
            user("做一个番茄钟网页，25 分钟专注、5 分钟休息。"),
            change("index.html  新增 +62\nstyle.css  新增 +48\napp.js  新增 +77"),
            agent("做好了，打开 `index.html` 就能用：开始、暂停、重置，结束时会响铃提醒。"),
        )
        "demo-a2" -> listOf(
            user("落地页加一个深色模式，跟随系统设置。"),
            change("src/styles/theme.css  +54 −3"),
            agent("已加上深色模式：默认跟随系统，右上角可以手动切换。"),
        )
        "work-1" -> listOf(
            user("网关偶尔返回 502，帮我查一下原因。"),
            command("grep \"502\" logs/gateway-2026-11-08.log | wc -l\n 37"),
            agent("502 都出现在上游连接被复用超过 60 秒以后。上游的空闲超时是 60 秒，网关是 75 秒。把网关的空闲超时改成 55 秒就能避免。"),
        )
        "work-2" -> listOf(
            user("后台加一个导出操作日志的按钮。"),
            change("src/pages/audit/Export.tsx  新增 +58\nsrc/api/audit.ts  +14"),
            agent("加好了：可以按日期范围和操作人筛选后导出 CSV。"),
        )
        "work-c1" -> listOf(
            user("帮我审查一下合同模块的这个合并请求。"),
            agent("看完了，有两点建议：\n1. 合同金额用了浮点数，建议改成以分为单位的整数；\n2. 到期提醒没有考虑时区，海外客户会提前一天收到。"),
        )
        "work-d1" -> listOf(
            user("把第三季度的数据整理成报表。"),
            agent("Q3 报表已生成：营收同比增长 18%，新客占比 34%。明细在 `reports/2026-Q3.xlsx`。"),
        )
        "work-h1" -> listOf(
            user("下午三点提醒我参加设计评审。"),
            agent("好的，14:50 会提醒你，评审在 3 楼会议室。"),
        )
        "work-p1" -> listOf(
            user("根据网关的接口代码生成一份接口文档。"),
            agent("文档写好了，共 23 个接口，按模块分组，每个接口都附了请求示例。"),
        )
        "work-a1" -> listOf(
            user("原型页面加一个筛选栏，可以按状态和日期筛选。"),
            agent("筛选栏加好了，选择后列表会立刻刷新。"),
        )
        else -> listOf(
            user("订单列表接口最近很慢，帮我加一层缓存，缓存 60 秒就行，改完跑一下测试。"),
            agent("好的。我先看一下订单列表接口的实现和现有测试。"),
            command("rg -n \"listOrders\" src\n src/orders/service.ts:42  export async function listOrders(userId: string)"),
            change("src/orders/cache.ts  新增 +38\nsrc/orders/service.ts  +6 −2"),
            command("npm test\n Tests: 46 passed, 46 total"),
            agent("改好了：\n1. 新增 [src/orders/cache.ts](src/orders/cache.ts)，按用户缓存订单列表 60 秒；\n2. 下单和取消订单时清掉这个用户的缓存，避免看到旧数据；\n3. 46 个测试全部通过。\n\n要不要顺便把商品详情接口也加上缓存？"),
            user("先不用，帮我提交一下。"),
            agent("已提交：`feat(orders): cache order lists for 60 s`。"),
        )
    }

    fun items(threadId: String, now: Long = System.currentTimeMillis()): List<HistoryItem> {
        val lines = conversation(threadId)
        val base = now - 6 * 60_000
        return lines.mapIndexed { index, line ->
            val order = index + 1
            HistoryItem("$threadId-$order", order.toLong(), line.type, line.text, if (line.type == "userMessage") null else "completed", false, createdAt = base + order * 45_000L)
        }
    }
}
