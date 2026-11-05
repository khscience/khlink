package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KhLinkSkinCatalogTest {
    @Test
    fun codexThemeCanBeRestoredWithoutChangingExistingThemes() {
        val theme = KhLinkSkinCatalog.byId("codex")
        assertEquals("Codex 风格主题", theme.name)
        assertTrue(theme.codexLayout)
        assertFalse(theme.chatLayout)
        assertEquals(KhLinkSkinCatalog.wechat, KhLinkSkinCatalog.byId(null))
        assertEquals(KhLinkSkinCatalog.wechat, KhLinkSkinCatalog.byId("wechat"))
        assertEquals(KhLinkSkinCatalog.sand, KhLinkSkinCatalog.byId("sand"))
        assertEquals(KhLinkSkinCatalog.minimal, KhLinkSkinCatalog.byId("minimal"))
        assertEquals(KhLinkSkinCatalog.all.size, KhLinkSkinCatalog.all.map { it.id }.toSet().size)
    }

    @Test
    fun themesAreListedInTheChosenOrderAndEachLooksDifferent() {
        assertEquals(listOf("sand", "codex", "minimal", "wechat"), KhLinkSkinCatalog.all.map { it.id })
        // Minimal is not just the default theme in grey: it drops the cards.
        assertTrue(KhLinkSkinCatalog.minimal.flatLayout)
        assertFalse(KhLinkSkinCatalog.sand.flatLayout)
        assertFalse(KhLinkSkinCatalog.minimal.codexLayout)
    }
}
