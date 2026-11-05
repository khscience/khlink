package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class ShortModelNameTest {
    @Test
    fun dropsTheVendorWordOnly() {
        assertEquals("Opus 5.5", shortModelName("Claude Opus 5.5"))
        assertEquals("5.5", shortModelName("gpt-5.5"))
        assertEquals("5.3 Codex", shortModelName("GPT-5.3-codex"))
        assertEquals("3.8 Flash High", shortModelName("gemini-3.8-flash-high"))
        assertEquals("6 Sol", shortModelName("gpt-6-sol"))
        assertEquals("5.6 Terra", shortModelName("gpt-5.6-terra"))
        assertEquals("codex-auto-review", shortModelName("codex-auto-review"))
        assertEquals("deepseek-v4", shortModelName("deepseek-v4"))
        assertEquals("gpt", shortModelName("gpt"))
    }
}
