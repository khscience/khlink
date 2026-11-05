package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTableTest {
    @Test fun narrowTableStretchesColumnsInProportionToContent() {
        val widths = tableColumnWidths(listOf(50f, 50f), listOf(100f, 300f), 800f)
        assertEquals(200f, widths[0], 0.01f)
        assertEquals(600f, widths[1], 0.01f)
    }

    @Test fun wideTableShrinksLongColumnsToFitInsteadOfScrolling() {
        // A short id column, a date column and a long text column on a 900px screen.
        val widths = tableColumnWidths(listOf(120f, 100f, 80f), listOf(120f, 100f, 2000f), 900f)
        assertEquals(120f, widths[0], 0.01f)
        assertEquals(100f, widths[1], 0.01f)
        assertEquals(680f, widths[2], 0.01f)
        assertEquals(900f, widths.sum(), 0.01f)
    }

    @Test fun overflowingMinimumsShrinkOnlyTheWidestColumns() {
        val widths = tableColumnWidths(listOf(180f, 200f, 320f, 320f), listOf(180f, 200f, 2000f, 1500f), 956f, floor = 140f)
        assertEquals(listOf(180f, 200f, 288f, 288f), widths)
    }

    @Test fun tableScrollsOnlyWhenColumnsDoNotFitEvenAtTheFloor() {
        assertEquals(listOf(500f, 600f), tableColumnWidths(listOf(500f, 600f), listOf(900f, 900f), 800f, floor = 400f))
    }
}
