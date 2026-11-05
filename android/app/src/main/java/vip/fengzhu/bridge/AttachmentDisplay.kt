package vip.fengzhu.bridge

private const val UPLOAD_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
private val attachmentMetadata = Regex(
    """(^\[(?:风筑附件|附件)] [^\r\n]*)(?:\r?\n)(?:路径：([^\r\n]+)|附件编号：($UPLOAD_UUID)(?=\r?$))""",
    setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE),
)
private val internalUploadPath = Regex(
    """^(?:[a-z]:[\\/]|\\\\|/).*?[\\/]FengzhuAgentBridge[\\/]uploads[\\/].+[\\/]$UPLOAD_UUID-[^\\/]+$""",
    RegexOption.IGNORE_CASE,
)

/** Hide only khLink's generated upload metadata; ordinary user paths stay visible. */
internal fun displayUploadReferences(text: String): String = attachmentMetadata.replace(text) { match ->
    val path = match.groupValues[2].trim()
    val id = match.groupValues[3]
    if (id.isNotEmpty() || internalUploadPath.matches(path)) match.groupValues[1] else match.value
}

/** An attachment-only queued message still needs an identifiable row. */
internal fun queuedInstructionDisplay(item: QueuedInstruction): String {
    val text = displayUploadReferences(questionReplyDisplay(item.text) ?: item.text)
    if (text.isNotBlank()) return text
    return item.attachments.joinToString("、") { it.name.ifBlank { "附件" } }
        .takeIf { it.isNotBlank() }?.let { "附件：$it" }.orEmpty()
}
