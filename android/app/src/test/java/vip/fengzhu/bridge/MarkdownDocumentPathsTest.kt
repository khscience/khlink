package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownDocumentPathsTest {
    private val windowsDoc = "I:\\项目资料\\文章\\介绍.md"
    private val linuxDoc = "/home/kh/项目/文章/介绍.md"

    @Test fun windowsImagesAreResolvedFromTheDocumentFolder() {
        assertEquals(MarkdownImageSource.Computer("I:\\项目资料\\文章\\图文素材\\截图.png"),
            markdownImageSource("图文素材/截图.png", windowsDoc))
        assertEquals(MarkdownImageSource.Computer("I:\\项目资料\\共享\\a b+图.png"),
            markdownImageSource("<../共享/a%20b+图.png>", windowsDoc))
        assertEquals(MarkdownImageSource.Computer("D:\\images\\图.jpg"),
            markdownImageSource("file:///D:/images/%E5%9B%BE.jpg", windowsDoc))
        assertEquals(MarkdownImageSource.Computer("D:\\images\\a%20b.png"),
            markdownImageSource("File:///D:/images/a%2520b.png", windowsDoc))
    }

    @Test fun unixImagesKeepUnixSeparatorsAndSupportParentDirectories() {
        assertEquals(MarkdownImageSource.Computer("/home/kh/项目/images/截图.png"),
            markdownImageSource("../images/截图.png", linuxDoc))
        assertEquals(MarkdownImageSource.Computer("/tmp/figure.gif"),
            markdownImageSource("file:///tmp/figure.gif", linuxDoc))
    }

    @Test fun webImagesKeepTheirUrlsAndRejectUnsafeSources() {
        assertEquals(MarkdownImageSource.Web("https://example.com/a.png?x=1#view"),
            markdownImageSource("https://example.com/a.png?x=1#view", windowsDoc))
        for (value in listOf("javascript:alert(1)", "content://private/data.png", "file://server/a.png",
            "//server/a.png", "../../token.json", "https://user:password@example.com/a.png", "a%00.png")) {
            assertNull(value, markdownImageSource(value, windowsDoc))
        }
    }

    @Test fun ordinaryLinksCanPointToOtherFilesAlongsideTheDocument() {
        assertEquals("I:\\项目资料\\文章\\附件\\说明.pdf", resolveMarkdownComputerPath("附件/说明.pdf", windowsDoc))
        assertEquals("/home/kh/项目/README.md", resolveMarkdownComputerPath("../README.md", linuxDoc))
        assertNull(resolveMarkdownComputerPath("https://example.com/a.md", windowsDoc))
    }

    @Test fun companionImagesStayOnTheDocumentsAccountAndComputer() {
        val account = fetchedAccountScope("https://relay.example", "account-a")
        val otherAccount = fetchedAccountScope("https://relay.example", "account-b")
        val computer = fetchedFileScope(account, "computer-a")!!
        val otherComputer = fetchedFileScope(account, "computer-b")!!
        assertEquals(computer, trustedMarkdownDocumentScope(computer, account, account))
        assertNull(trustedMarkdownDocumentScope("", account, account))
        assertNull(trustedMarkdownDocumentScope(computer, account, otherAccount))
        assertTrue(canFetchMarkdownCompanion(computer, computer))
        assertFalse(canFetchMarkdownCompanion(computer, otherComputer))
        assertFalse(canFetchMarkdownCompanion(computer, null))
    }
}
