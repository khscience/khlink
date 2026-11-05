package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComputerPathTest {
    private val cwd = "D:\\work\\khlink"

    @Test
    fun absoluteAndEncodedPaths() {
        assertEquals("I:\\a\\b.md", computerPathFromLink("I:\\a\\b.md", cwd))
        assertEquals("I:\\a\\b.md", computerPathFromLink("/I:/a/b.md", cwd))
        assertEquals("I:\\a\\b c.md", computerPathFromLink("file:///I:/a/b%20c.md", cwd))
        assertEquals("C:\\Users\\me\\视频.mp4", computerPathFromLink("C:/Users/me/%E8%A7%86%E9%A2%91.mp4", cwd))
    }

    @Test
    fun relativePathsAndLineMarkers() {
        assertEquals("D:\\work\\khlink\\src\\a.ts", computerPathFromLink("src/a.ts:42", cwd))
        assertEquals("D:\\work\\khlink\\src\\a.ts", computerPathFromLink("src/a.ts#L42", cwd))
        assertEquals("D:\\work\\b.md", computerPathFromLink("../b.md", cwd))
        assertEquals("D:\\work\\khlink\\README.md", computerPathFromLink("./README.md", cwd))
    }

    @Test
    fun webLinksAndAnchorsAreNotFiles() {
        assertNull(computerPathFromLink("https://example.com/a.png", cwd))
        assertNull(computerPathFromLink("mailto:a@b.c", cwd))
        assertNull(computerPathFromLink("#section", cwd))
        assertNull(computerPathFromLink("src/a.ts", ""))
    }

    @Test
    fun fileNameOfAWindowsPath() {
        assertEquals("b.md", computerFileName("I:\\a\\b.md"))
        assertEquals("b.md", computerFileName("/x/b.md"))
    }
}
