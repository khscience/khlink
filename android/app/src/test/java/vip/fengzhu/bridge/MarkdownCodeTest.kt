package vip.fengzhu.bridge

import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.parser.MarkdownParser
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownCodeTest {
    private fun code(markdown: String): String {
        val tree = MarkdownParser(GFMFlavourDescriptor()).buildMarkdownTreeFromString(markdown)
        fun find(node: ASTNode): ASTNode? =
            if (node.type == MarkdownElementTypes.CODE_FENCE || node.type == MarkdownElementTypes.CODE_BLOCK) node
            else node.children.firstNotNullOfOrNull(::find)
        return markdownCodeText(find(tree)!!, markdown)
    }

    @Test fun fenceDropsFencesAndLanguage() {
        assertEquals("wsl -d Ubuntu -u root bash -c \"mkdir -p /run/sshd\"",
            code("补上再跑：\n\n```powershell\nwsl -d Ubuntu -u root bash -c \"mkdir -p /run/sshd\"\n```\n\n好了。"))
    }

    @Test fun fenceKeepsBlankLinesAndIndent() {
        assertEquals("if true; then\n  echo a\n\n  echo b\nfi", code("```sh\nif true; then\n  echo a\n\n  echo b\nfi\n```"))
    }

    @Test fun emptyFence() {
        assertEquals("", code("```\n```"))
    }

    @Test fun indentedBlockDropsIndent() {
        assertEquals("ls -la\n  cd x", code("文字\n\n    ls -la\n      cd x\n"))
    }
}
