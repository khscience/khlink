package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
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
}
