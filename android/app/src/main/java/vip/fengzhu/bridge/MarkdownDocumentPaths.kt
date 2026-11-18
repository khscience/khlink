package vip.fengzhu.bridge

/** The source of an image referenced by a Markdown file from a computer. */
internal sealed interface MarkdownImageSource {
    data class Computer(val path: String) : MarkdownImageSource
    data class Web(val url: String) : MarkdownImageSource
}

internal const val MAX_MARKDOWN_IMAGE_BYTES = 24L * 1024 * 1024

private val windowsAbsolutePath = Regex("^[A-Za-z]:[\\\\/]")
private val uriScheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")
private val documentImageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "svg")

/** Resolve a Markdown file's local link against the *document*, not the chat's working folder. */
internal fun resolveMarkdownComputerPath(reference: String, documentPath: String): String? {
    var value = reference.trim().removePrefix("<").removeSuffix(">").trim()
    if (value.isBlank() || value.startsWith('#') || value.startsWith("//") || value.startsWith("\\\\")) return null
    val isFileUrl = value.startsWith("file://", ignoreCase = true)
    if (isFileUrl) {
        // Do not interpret a remote file authority or a phone content URI as a computer file.
        value = value.substring("file://".length)
        if (!value.startsWith('/')) return null
    } else if (uriScheme.containsMatchIn(value) && !windowsAbsolutePath.containsMatchIn(value)) return null
    value = value.substringBefore('#').substringBefore('?')
    value = runCatching { java.net.URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") }.getOrNull() ?: return null
    if (value.isBlank() || '\u0000' in value) return null

    val doc = documentPath.trim()
    if (windowsAbsolutePath.containsMatchIn(doc)) {
        val directory = doc.substringBeforeLast('\\', "").let { backslashParent ->
            val slashParent = doc.substringBeforeLast('/', "")
            if (slashParent.length > backslashParent.length) slashParent else backslashParent
        }
        if (directory.isBlank()) return null
        // file:///C:/... has one leading slash after removing the file scheme.
        val windowsValue = if (Regex("^/[A-Za-z]:/").containsMatchIn(value)) value.drop(1) else value
        // The common chat-link helper decodes once itself; preserve percent signs
        // already decoded above so paths such as a%2520b.png are not decoded twice.
        return computerPathFromLink(windowsValue.replace("%", "%25"), directory)
    }
    if (!doc.startsWith('/')) return null
    val root = doc.substringBeforeLast('/', "")
    val absolute = if (value.startsWith('/')) value else "$root/$value"
    val parts = ArrayDeque<String>()
    for (part in absolute.split('/')) when (part) {
        "", "." -> Unit
        ".." -> if (parts.isNotEmpty()) parts.removeLast()
        else -> parts.addLast(part)
    }
    return if (parts.isEmpty()) null else "/" + parts.joinToString("/")
}

/** Web images are fetched by the phone; local images use the existing protected file channel. */
internal fun markdownImageSource(reference: String, documentPath: String): MarkdownImageSource? {
    val value = reference.trim().removePrefix("<").removeSuffix(">").trim()
    if (value.startsWith("http://", true) || value.startsWith("https://", true)) {
        val uri = runCatching { java.net.URI(value) }.getOrNull() ?: return null
        if (uri.host.isNullOrBlank() || uri.userInfo != null) return null
        return MarkdownImageSource.Web(value)
    }
    val path = resolveMarkdownComputerPath(value, documentPath) ?: return null
    val extension = path.substringAfterLast('.', "").lowercase(java.util.Locale.ROOT)
    return if (extension in documentImageExtensions) MarkdownImageSource.Computer(path) else null
}
