package vip.fengzhu.bridge

import java.io.IOException
import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Test

class UiErrorMessageTest {
    @Test
    fun `translates transport timeouts for manual actions`() {
        assertEquals("连接超时，请稍后重试", userFacingUiError(SocketTimeoutException("timeout"), "刷新失败"))
        assertEquals("连接超时，请稍后重试", userFacingUiError(IllegalStateException("timed out"), "刷新失败"))
    }

    @Test
    fun `uses fallback only when the exception has no message`() {
        assertEquals("刷新失败", userFacingUiError(IllegalStateException(), "刷新失败"))
        assertEquals("具体错误", userFacingUiError(IllegalStateException("具体错误"), "刷新失败"))
    }

    @Test
    fun `a command the computer did not answer reads in Chinese`() {
        val timeout = CommandTimeoutException(60_000)
        assertEquals("电脑端 60 秒内没有回应，操作可能还在进行。请先看看电脑或这条对话，再决定要不要重试", timeout.message)
        assertEquals(timeout.message, userFacingUiError(timeout, "操作失败"))
    }

    @Test
    fun `retries transport failures but not coroutine cancellation`() {
        assertEquals(true, isRetryableTransferFailure(IOException("socket closed")))
        assertEquals(true, isRetryableTransferFailure(IllegalStateException("Timed out waiting")))
        assertEquals(false, isRetryableTransferFailure(kotlinx.coroutines.CancellationException("cancelled")))
        assertEquals(false, isRetryableTransferFailure(IllegalArgumentException("bad file")))
    }
}
