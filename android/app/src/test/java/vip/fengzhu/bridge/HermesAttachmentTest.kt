package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HermesAttachmentTest {
    private fun attachment(name: String, type: String?) =
        AttachmentUpload(id = "test", name = name, localUri = "content://test", mimeType = type, state = "uploaded")

    @Test fun runningHermesImagesMustBeQueuedInsteadOfSteered() {
        val image = listOf(attachment("图片.png", "image/png"))
        assertTrue(hermesImageCannotSteer("hermes", true, true, image))
        assertTrue(hermesImageCannotSteer("hermes", true, true, listOf(attachment("相片.JPG", null))))
        assertFalse(hermesImageCannotSteer("hermes", true, false, image))
        assertFalse(hermesImageCannotSteer("hermes", false, true, image))
        assertFalse(hermesImageCannotSteer("codex", true, true, image))
        assertFalse(hermesImageCannotSteer("hermes", true, true, listOf(attachment("说明.txt", "text/plain"))))
    }
}
