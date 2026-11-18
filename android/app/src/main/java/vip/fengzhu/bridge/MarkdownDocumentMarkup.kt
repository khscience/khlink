package vip.fengzhu.bridge

import org.intellij.markdown.IElementType
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.parser.MarkdownParser

private data class MarkdownReplacement(val start: Int, val end: Int, val text: String)

private fun markdownLabel(value: String): String = value.removePrefix("[").removeSuffix("]")
    .trim().replace(Regex("\\s+"), " ").lowercase(java.util.Locale.ROOT)

private fun ASTNode.findMarkdownChild(type: IElementType): ASTNode? =
    if (this.type == type) this else children.firstNotNullOfOrNull { it.findMarkdownChild(type) }

private fun markdownImageSyntax(alt: String, destination: String): String {
    val label = alt.removePrefix("[").removeSuffix("]").replace("[", "\\[").replace("]", "\\]")
    val target = destination.trim().removePrefix("<").removeSuffix(">").replace("<", "%3C").replace(">", "%3E")
    return "![$label](<$target>)"
}

/**
 * Renderer 0.37 cannot display reference-style images, and skips standalone HTML
 * images. Normalize only actual AST image / HTML nodes; examples inside code
 * fences and inline code must remain untouched.
 */
internal fun normalizeMarkdownDocumentImages(markdown: String): String {
    if (!markdown.contains("![") && !markdown.contains("<img", ignoreCase = true)) return markdown
    val tree = MarkdownParser(GFMFlavourDescriptor()).buildMarkdownTreeFromString(markdown)
    fun text(node: ASTNode): String = markdown.substring(node.startOffset, node.endOffset)
    val references = mutableMapOf<String, String>()
    fun collect(node: ASTNode) {
        if (node.type == MarkdownElementTypes.LINK_DEFINITION) {
            val label = node.findMarkdownChild(MarkdownElementTypes.LINK_LABEL)?.let(::text)
            val destination = node.findMarkdownChild(MarkdownElementTypes.LINK_DESTINATION)?.let(::text)
            if (label != null && destination != null) references.putIfAbsent(markdownLabel(label), destination)
            return
        }
        node.children.forEach(::collect)
    }
    collect(tree)
    val htmlImage = Regex("(?is)^\\s*<img\\b(?:[^>\\\"']|\\\"[^\\\"]*\\\"|'[^']*')*/?>\\s*$")
    val attributes = Regex("(?i)\\b(src|alt)\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)'|([^\\s>]+))")
    val replacements = mutableListOf<MarkdownReplacement>()
    fun visit(node: ASTNode) {
        when (node.type) {
            MarkdownElementTypes.CODE_FENCE, MarkdownElementTypes.CODE_BLOCK, MarkdownElementTypes.CODE_SPAN -> return
            MarkdownElementTypes.IMAGE -> {
                if (node.findMarkdownChild(MarkdownElementTypes.LINK_DESTINATION) == null) {
                    val label = node.findMarkdownChild(MarkdownElementTypes.LINK_LABEL)?.let(::text)
                    val alt = node.findMarkdownChild(MarkdownElementTypes.LINK_TEXT)?.let(::text) ?: label
                    val destination = label?.let { references[markdownLabel(it)] }
                    if (alt != null && destination != null) replacements += MarkdownReplacement(node.startOffset, node.endOffset, markdownImageSyntax(alt, destination))
                }
                return
            }
            MarkdownElementTypes.HTML_BLOCK, MarkdownTokenTypes.HTML_TAG -> {
                val raw = text(node)
                if (htmlImage.matches(raw)) {
                    val attrs = attributes.findAll(raw).associate { match ->
                        match.groupValues[1].lowercase(java.util.Locale.ROOT) to match.groupValues.drop(2).firstOrNull { it.isNotEmpty() }.orEmpty()
                    }
                    val src = attrs["src"]?.replace("&amp;", "&")
                    if (!src.isNullOrBlank()) replacements += MarkdownReplacement(node.startOffset, node.endOffset, markdownImageSyntax(attrs["alt"].orEmpty(), src))
                }
                return
            }
        }
        node.children.forEach(::visit)
    }
    visit(tree)
    val output = StringBuilder(markdown)
    replacements.sortedByDescending { it.start }.forEach { output.replace(it.start, it.end, it.text) }
    return output.toString()
}
