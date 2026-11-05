package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class HistoryTextSanitizationTest {
    @Test
    fun removesLocalImageMarkupAndRequestMarker() {
        val raw = "<image name=[Image #1] path=\"C:\\\\Users\\me\\Temp\\photo.png\">\n</image>\n\n[KH_LINK_REQUEST_ID:01234567-89ab-cdef-0123-456789abcdef]"

        assertEquals("", sanitizeHistoryText(raw))
        assertFalse(sanitizeHistoryText(raw).contains("C:\\"))
        assertFalse(containsLocalImageMarkup(sanitizeHistoryText(raw)))
    }

    @Test
    fun keepsSafeAttachmentContext() {
        val raw = "<image name=[Image #1] path=\"C:\\\\Temp\\photo.png\">\n</image>\n\n[KH Link 图片附件] photo.png\n附件编号：attachment-1"

        assertEquals("[KH Link 图片附件] photo.png\n附件编号：attachment-1", sanitizeHistoryText(raw))
    }
}
