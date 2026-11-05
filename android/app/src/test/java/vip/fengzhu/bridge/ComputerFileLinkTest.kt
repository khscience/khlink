package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComputerFileLinkTest {
    private fun target(markdown: String) = Regex("\\]\\(([^)]+)\\)").find(markdown)!!.groupValues[1]

    @Test
    fun localLinksDesktopAppsAcceptBecomeFileLinksThePhoneCanFetch() {
        // Seen from DSH: an angle-bracket destination with backslashes and Chinese.
        val apk = "I:\\work\\local-center\\风筑本地中心-手机版-2.4.0.apk"
        val linked = linkifyLocalFileLinks("给你的下载链接： [风筑本地中心-手机版-2.4.0.apk](<$apk>) 如果你要")
        assertTrue(linked, linked.startsWith("给你的下载链接： [风筑本地中心-手机版-2.4.0.apk](file:///I:/"))
        assertFalse(target(linked).contains(' ') || target(linked).contains('\\'))
        assertEquals(apk, computerPathFromLink(target(linked), ""))
        assertEquals("I:\\a b\\c.apk", computerPathFromLink(target(linkifyLocalFileLinks("[c](file:///I:/a%20b/c.apk)")), ""))
        // Web links, relative links and images are left alone.
        for (kept in listOf("[web](https://example.com/a.apk)", "[rel](docs/a.md)", "![img](I:\\a\\b.png)")) assertEquals(kept, linkifyLocalFileLinks(kept))
    }

    @Test
    fun aCodeBlockHoldingOnlyAPathGetsAFetchLinkUnderIt() {
        val block = "地址：\n\n```\nfile:///I:/work/a/风筑-2.4.0.apk\n```\n后文"
        val lines = linkifyLocalFileLinks(block).split('\n')
        assertEquals("```", lines[4])
        assertTrue(lines[5], lines[5].startsWith("[在手机上取回 风筑\\-2\\.4\\.0\\.apk](file:///I:/"))
        assertEquals("I:\\work\\a\\风筑-2.4.0.apk", computerPathFromLink(target(lines[5]), ""))
        assertEquals("", lines[6])
        assertEquals("后文", lines[7])
        val windows = linkifyLocalFileLinks("```\nI:\\a\\app-debug.apk\n```")
        assertEquals("I:\\a\\app-debug.apk", computerPathFromLink(target(windows), ""))
        // A block with code, or a folder, gets nothing.
        for (kept in listOf("```\nI:\\a\\b.apk\necho hi\n```", "```\nI:\\a\\folder\n```")) assertEquals(kept, linkifyLocalFileLinks(kept))
    }

    @Test
    fun inlineCodePathsBecomeFileLinksThatResolveBackToThePath() {
        val text = "成片在 `I:\\qmt5\\code\\article\\video\\Jev动画小课 配音版.mp4`，脚本见 `render.py`。"
        val linked = linkifyComputerPaths(text)
        val url = Regex("\\]\\(([^)]+)\\)").find(linked)!!.groupValues[1]
        assertTrue(linked, linked.startsWith("成片在 [I\\:\\\\qmt5\\\\code\\\\article\\\\video\\\\Jev动画小课 配音版\\.mp4]("))
        assertFalse(url.contains(' '))
        assertEquals("I:\\qmt5\\code\\article\\video\\Jev动画小课 配音版.mp4", computerPathFromLink(url, ""))
        assertTrue("relative names stay plain code", linked.endsWith("脚本见 `render.py`。"))
    }

    @Test
    fun lineMarkersFencedBlocksAndExistingLinksAreRespected() {
        val linked = linkifyComputerPaths("`I:/a/b.kt:12`")
        assertEquals("I:\\a\\b.kt", computerPathFromLink(Regex("\\]\\(([^)]+)\\)").find(linked)!!.groupValues[1], ""))
        val fenced = "```\n`I:\\a\\b.md`\n```\n`I:\\a\\c.md`"
        val lines = linkifyComputerPaths(fenced).split('\n')
        assertEquals("`I:\\a\\b.md`", lines[1])
        assertTrue(lines[3], lines[3].startsWith("[I\\:\\\\a\\\\c\\.md]("))
        // Tildes and dots stay visible (not strikethrough, not eaten as escapes).
        assertTrue(linkifyComputerPaths("`C:\\Users\\me\\CLAUDE~1\\CREDEN~1.JSO`").startsWith("[C\\:\\\\Users\\\\me\\\\CLAUDE\\~1\\\\CREDEN\\~1\\.JSO]("))
        val already = "[`I:\\a\\b.md`](I:\\a\\b.md)"
        assertEquals(already, linkifyComputerPaths(already))
        assertEquals("`I:\\folder`", linkifyComputerPaths("`I:\\folder`"))
    }

    @Test
    fun chineseBoldNextToPunctuationGetsAHairSpace() {
        val h = "\u200A"
        assertEquals("**GPT 已经发布，但取决于客户端。**${h}我这边", fixCjkEmphasis("**GPT 已经发布，但取决于客户端。**我这边"))
        assertEquals("你说的是${h}**「重点」**", fixCjkEmphasis("你说的是**「重点」**"))
        assertEquals("普通 **加粗** 文本", fixCjkEmphasis("普通 **加粗** 文本"))
        assertEquals("中文**加粗**中文", fixCjkEmphasis("中文**加粗**中文"))
        assertEquals("`a。**b` 与 x", fixCjkEmphasis("`a。**b` 与 x"))
        val fenced = "```\n**说明。**然后\n```"
        assertEquals(fenced, fixCjkEmphasis(fenced))
    }

    @Test
    fun viewerKindsAndWebVideoLinks() {
        assertEquals(ComputerFileKind.MARKDOWN, computerFileKind("README.MD"))
        assertEquals(ComputerFileKind.HTML, computerFileKind("report.htm"))
        assertEquals(ComputerFileKind.TEXT, computerFileKind("a.json"))
        assertEquals(ComputerFileKind.IMAGE, computerFileKind("photo.PNG"))
        assertEquals(ComputerFileKind.IMAGE, computerFileKind("icon.svg"))
        assertEquals(ComputerFileKind.VIDEO, computerFileKind("clip.mp4"))
        assertEquals(ComputerFileKind.OTHER, computerFileKind("archive.zip"))
        assertTrue(isWebVideoLink("https://example.com/media/demo-1080p.mp4"))
        assertTrue(isWebVideoLink("https://example.com/v/clip.WEBM?token=1#t=3"))
        assertFalse(isWebVideoLink("https://example.com/page.html"))
        assertFalse(isWebVideoLink("I:\\a\\clip.mp4"))
    }
}
