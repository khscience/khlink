package vip.fengzhu.bridge

import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode

/**
 * The code inside a fenced (```) or indented code block, without the fences,
 * the language name or the indent: what the copy button copies.
 */
fun markdownCodeText(node: ASTNode, content: String): String = when (node.type) {
    MarkdownElementTypes.CODE_FENCE -> {
        val lines = node.children.filter { it.type == MarkdownTokenTypes.CODE_FENCE_CONTENT }
        if (lines.isEmpty()) "" else content.substring(lines.first().startOffset, lines.last().endOffset)
    }
    MarkdownElementTypes.CODE_BLOCK -> {
        val lines = node.children.filter { it.type == MarkdownTokenTypes.CODE_LINE }
        if (lines.isEmpty()) "" else content.substring(lines.first().startOffset, lines.last().endOffset)
            .lines().joinToString("\n") { line -> line.removePrefix("    ").removePrefix("\t") }
    }
    else -> content.substring(node.startOffset, node.endOffset)
}.trimEnd('\n', '\r')
