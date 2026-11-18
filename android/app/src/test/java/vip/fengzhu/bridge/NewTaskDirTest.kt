package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NewTaskDirTest {
    private val recent = listOf("I:\\work", "/home/kh/hermes", "/Users/cz/proj")

    @Test fun windowsStartsInNewestWindowsFolderOrDriveRoot() {
        assertEquals("I:\\work", defaultNewTaskDir(recent, unixPaths = false, unixHome = null))
        assertEquals("C:\\", defaultNewTaskDir(listOf("/home/kh"), unixPaths = false, unixHome = null))
    }

    @Test fun macStartsInNewestUnixFolderOrHome() {
        assertEquals("/home/kh/hermes", defaultNewTaskDir(recent, unixPaths = true, unixHome = "/Users/cz"))
        assertEquals("/Users/cz", defaultNewTaskDir(listOf("I:\\work"), unixPaths = true, unixHome = "/Users/cz"))
        // Hermes in WSL with no Linux folder yet: empty means its home.
        assertEquals("", defaultNewTaskDir(listOf("I:\\work"), unixPaths = true, unixHome = null))
    }

    @Test fun systemKind() {
        assertTrue(ComputerSystem("darwin", "/Users/cz").unix)
        assertTrue(ComputerSystem("linux").unix)
        assertFalse(ComputerSystem("win32", "C:\\Users\\alice").unix)
        // Hermes: WSL on a Windows computer unless it runs Hermes's Windows install.
        assertFalse(ComputerSystem("win32", hermes = "wsl").hermesLocal)
        assertFalse(ComputerSystem("win32").hermesLocal)
        assertTrue(ComputerSystem("win32", hermes = "windows").hermesLocal)
        assertTrue(ComputerSystem("darwin", hermes = "local").hermesLocal)
    }
}
