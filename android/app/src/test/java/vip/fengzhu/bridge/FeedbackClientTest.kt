package vip.fengzhu.bridge

import org.junit.Assert.*
import org.junit.Test

class FeedbackClientTest {
    @Test fun validatesTextAndAttachmentCount() {
        assertFalse(validFeedback(" ", 0))
        assertTrue(validFeedback("建议增加搜索", 0))
        assertTrue(validFeedback("问题", 3))
        assertFalse(validFeedback("问题", 4))
        assertFalse(validFeedback("问".repeat(4001), 0))
    }

    @Test fun explainsServerErrors() {
        assertTrue(feedbackError(429).contains("频繁"))
        assertTrue(feedbackError(503).contains("暂时不可用"))
        assertTrue(feedbackError(413).contains("图片"))
    }
}
