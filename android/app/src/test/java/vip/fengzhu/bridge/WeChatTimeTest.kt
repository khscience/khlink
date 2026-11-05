package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class WeChatTimeTest {
    private val zone = TimeZone.getTimeZone("Asia/Shanghai")
    private fun at(y: Int, m: Int, d: Int, h: Int, min: Int) = Calendar.getInstance(zone).apply { clear(); set(y, m - 1, d, h, min) }.timeInMillis
    private val now = at(2026, 10, 21, 9, 30) // a Wednesday

    @Test fun labelsReadLikeWeChat() {
        assertEquals("08:05", wechatTimeLabel(at(2026, 10, 21, 8, 5), now, zone))
        assertEquals("昨天 23:50", wechatTimeLabel(at(2026, 10, 20, 23, 50), now, zone))
        assertEquals("星期日 10:00", wechatTimeLabel(at(2026, 10, 18, 10, 0), now, zone))
        assertEquals("10月12日 13:13", wechatTimeLabel(at(2026, 10, 12, 13, 13), now, zone))
        assertEquals("2025年12月31日 22:00", wechatTimeLabel(at(2025, 12, 31, 22, 0), now, zone))
        assertEquals("08:05", wechatListTime(at(2026, 10, 21, 8, 5), now, zone))
        assertEquals("昨天", wechatListTime(at(2026, 10, 20, 23, 50), now, zone))
        assertEquals("星期日", wechatListTime(at(2026, 10, 18, 10, 0), now, zone))
        assertEquals("10/12", wechatListTime(at(2026, 10, 12, 13, 13), now, zone))
        assertEquals("2025/12/31", wechatListTime(at(2025, 12, 31, 22, 0), now, zone))
    }

    @Test fun aTimeShowsOnlyAfterFiveQuietMinutes() {
        fun msg(id: String, order: Long, type: String, minute: Int) = HistoryItem(id, order, type, id, null, false, createdAt = at(2026, 10, 21, 9, minute))
        val items = listOf(
            msg("a", 1, "userMessage", 0), msg("tool", 2, "commandExecution", 1), msg("b", 3, "agentMessage", 2),
            msg("c", 4, "userMessage", 4), msg("d", 5, "agentMessage", 12),
        )
        assertEquals(setOf("a", "d"), chatTimeMarks(items) { it.createdAt })
    }
}
