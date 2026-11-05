package vip.fengzhu.bridge

import kotlinx.coroutines.delay
import kotlinx.coroutines.Job

internal const val MAX_LIGHT_DETAIL_CHARS = 16 * 1024 * 1024
private const val MAX_LIGHT_DETAIL_PART_CHARS = 256 * 1024

internal data class LightDetailPart(
    val id: String,
    val offset: Int,
    val total: Int,
    val nonce: String,
    val transferId: String?,
    val chunk: String,
    val eof: Boolean,
)

/** Reject mixed snapshots, gaps and oversized data before storing a detail. */
internal class LightDetailAssembler(private val id: String, private val maxChars: Int = MAX_LIGHT_DETAIL_CHARS) {
    private val content = StringBuilder()
    private var expectedTotal: Int? = null
    private var expectedNonce: String? = null
    private var expectedTransferId: String? = null
    var complete: Boolean = false
        private set
    val offset: Int get() = content.length
    val transferId: String? get() = expectedTransferId
    val nonce: String get() = expectedNonce.orEmpty()
    val ciphertext: String get() = content.toString()

    fun add(part: LightDetailPart) {
        require(!complete && part.id == id && part.offset == content.length) { "详细过程分片顺序不正确" }
        require(part.total in 1..maxChars && part.nonce.isNotBlank()) { "详细过程大小或校验信息无效" }
        require(part.chunk.length <= MAX_LIGHT_DETAIL_PART_CHARS && part.chunk.isNotEmpty()) { "详细过程分片无效" }
        require(part.chunk.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '+' || it == '/' || it == '=' }) { "详细过程分片无效" }
        if (expectedTotal == null) {
            expectedTotal = part.total
            expectedNonce = part.nonce
            expectedTransferId = part.transferId
        } else {
            require(part.total == expectedTotal && part.nonce == expectedNonce && part.transferId == expectedTransferId) { "详细过程传输已变化，请重试" }
        }
        require(part.offset + part.chunk.length <= part.total) { "详细过程分片超出范围" }
        val final = part.offset + part.chunk.length == part.total
        require(part.eof == final && (final || !part.transferId.isNullOrBlank())) { "详细过程分片不完整" }
        content.append(part.chunk)
        complete = final
    }
}

internal fun unsupportedLightDetailParts(message: String): Boolean =
    message.contains("file.historyDetailPart") &&
        (message.contains("Unsupported action", ignoreCase = true) || message.contains("不支持"))

internal fun legacyLightDetailSafe(item: HistoryItem): Boolean =
    item.type !in setOf("imageGeneration", "imageView", "toolImages")

/** Continue a bounded computer-side scan while keeping cancellation effective. */
internal suspend fun <T> retryPendingLightDetail(
    maxAttempts: Int = 40,
    pause: suspend () -> Unit = { delay(2_000) },
    request: suspend () -> Pair<Boolean, T>,
): T {
    require(maxAttempts > 0)
    repeat(maxAttempts) { attempt ->
        val (pending, result) = request()
        if (!pending) return result
        if (attempt + 1 < maxAttempts) pause()
    }
    error("历史详情仍在检索，请稍后重试")
}

/** Leaving a conversation cancels only that conversation's pending fetches. */
internal class LightDetailFetchJobs {
    private val jobs = mutableMapOf<String, MutableSet<Job>>()

    fun add(threadId: String, job: Job) {
        synchronized(jobs) { jobs.getOrPut(threadId) { mutableSetOf() }.add(job) }
        job.invokeOnCompletion {
            synchronized(jobs) { jobs[threadId]?.let { group -> group.remove(job); if (group.isEmpty()) jobs.remove(threadId) } }
        }
    }

    fun cancel(threadId: String) {
        val cancelled = synchronized(jobs) { jobs.remove(threadId)?.toList().orEmpty() }
        cancelled.forEach { it.cancel() }
    }
}
