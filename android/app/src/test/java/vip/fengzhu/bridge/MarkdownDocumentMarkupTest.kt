package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownDocumentMarkupTest {
    @Test fun referenceImagesAndStandaloneHtmlImagesBecomeRenderable() {
        val source = "![封面][cover]\n\n[cover]: images/封面.png\n\n<img src=\"images/示意图.png\" alt=\"示意图\" width=\"300\">"
        val actual = normalizeMarkdownDocumentImages(source)
        assertTrue(actual, actual.contains("![封面](<images/封面.png>)"))
        assertTrue(actual, actual.contains("![示意图](<images/示意图.png>)"))
        assertTrue(actual, actual.contains("[cover]: images/封面.png"))
    }

    @Test fun codeAndAlreadyInlineImagesAreNotRewritten() {
        val tick = 96.toChar().toString()
        val source = "![图](images/a.png)\n\n" + tick + "![演示][ref]" + tick +
            "\n\n" + tick.repeat(3) + "\n<img src=\"inside.png\">\n" + tick.repeat(3) + "\n\n[ref]: images/b.png"
        assertEquals(source, normalizeMarkdownDocumentImages(source))
    }

    @Test fun themeNamesRemainStableAndUnknownPreferenceFallsBack() {
        assertEquals(MarkdownReaderTheme.NIGHT, MarkdownReaderTheme.fromId("NIGHT"))
        assertEquals(MarkdownReaderTheme.FOLLOW_APP, MarkdownReaderTheme.fromId("no-longer-installed"))
    }
}
