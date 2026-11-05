package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadNotificationsTest {
    @Test fun tagsKeepThreadsSeparateEvenWhenNotificationIdsCollide() {
        assertEquals(threadNoticeId("Aa"), threadNoticeId("BB"))
        assertNotEquals(threadNoticeTag("Aa"), threadNoticeTag("BB"))
        assertTrue(taggedTerminalNoticeMatches(threadNoticeTag("Aa"), threadNoticeId("Aa"), "TERMINAL", "Aa"))
        assertFalse(taggedTerminalNoticeMatches(threadNoticeTag("Aa"), threadNoticeId("Aa"), "PROMPT", "Aa"))
        assertFalse(taggedTerminalNoticeMatches(threadNoticeTag("BB"), threadNoticeId("Aa"), "TERMINAL", "Aa"))
        assertFalse(taggedTerminalNoticeMatches(threadNoticeTag("Aa"), threadNoticeId("Aa"), null, "Aa"))
    }

    @Test fun legacyCleanupRequiresTheSameIntentAndAnExactTerminalTitle() {
        val id = "test-thread"
        fun matches(tag: String? = null, noticeId: Int = threadNoticeId(id), title: String? = "Codex 已完成 · 测试任务", sameIntent: Boolean = true) =
            legacyTerminalNoticeMatches(tag, noticeId, title, sameIntent, id, "测试任务", "Codex")
        assertTrue(matches())
        assertTrue(matches(title = "Codex 已停止 · 测试任务"))
        assertTrue(matches(title = "Codex 运行失败 · 测试任务"))
        assertFalse(matches(title = "Codex 等待批准 · 测试任务"))
        assertFalse(matches(title = "Codex 已完成 · 其他任务"))
        assertFalse(matches(tag = threadNoticeTag(id)))
        assertFalse(matches(noticeId = threadNoticeId(id) + 1))
        assertFalse(matches(sameIntent = false))
    }
}
