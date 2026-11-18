package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateNotesTest {
    @Test
    fun notesAreOneTrimmedLinePerChange() {
        assertEquals(listOf("第一条", "第二条"), updateNotes("  第一条 \n\n第二条\n"))
    }

    @Test
    fun anOlderManifestHasNoNotes() {
        assertEquals(emptyList<String>(), updateNotes(null))
        assertEquals(emptyList<String>(), updateNotes(""))
    }

    @Test
    fun aLongListIsCut() {
        assertEquals(12, updateNotes((1..20).joinToString("\n") { "第 $it 条" }).size)
    }

    private val history = listOf(
        "0.1.350" to "Hermes 能用了\n修了提问",
        "0.1.349" to "反重力可以切模型",
        "0.1.348" to "备用 DNS",
        "0.1.347" to "置顶修复",
    )

    @Test
    fun everySkippedVersionIsListedNewestFirst() {
        val groups = updateNoteGroups("0.1.350", listOf("Hermes 能用了", "修了提问"), history, current = "0.1.347")
        assertEquals(listOf("0.1.350", "0.1.349", "0.1.348"), groups.map { it.version })
        assertEquals(listOf("Hermes 能用了", "修了提问"), groups.first().notes)
    }

    @Test
    fun oneVersionBehindShowsOnlyThatVersion() {
        assertEquals(listOf("0.1.350"), updateNoteGroups("0.1.350", listOf("Hermes 能用了"), history, "0.1.349").map { it.version })
    }

    @Test
    fun aManifestWithoutHistoryStillShowsTheLatestNotes() {
        val groups = updateNoteGroups("0.1.350", listOf("Hermes 能用了"), emptyList(), "0.1.300")
        assertEquals(listOf(UpdateNoteGroup("0.1.350", listOf("Hermes 能用了"))), groups)
        assertTrue(updateNoteGroups("0.1.350", emptyList(), emptyList(), "0.1.300").isEmpty())
    }

    @Test
    fun missingNewestHistoryUsesLatestNotesAndKeepsOnlySkippedVersions() {
        val history = listOf("0.1.353" to "旧版", "0.1.355" to "中间更新", "0.1.358" to "未来版本")
        val groups = updateNoteGroups("0.1.357", listOf("本次更新"), history, current = "0.1.353")
        assertEquals(listOf("0.1.357", "0.1.355"), groups.map { it.version })
        assertEquals(listOf("本次更新"), groups.first().notes)
    }

    @Test
    fun versionsCompareNumberByNumber() {
        assertTrue(compareVersionNames("0.1.349", "0.1.99") > 0)
        assertTrue(compareVersionNames("0.2.0", "0.1.999") > 0)
        assertEquals(0, compareVersionNames("0.1.5", "0.1.5"))
    }
}
