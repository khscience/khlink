package vip.fengzhu.bridge

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** UI acknowledgement is separate from the computer's actual turn status. */
internal class StopFeedback {
    private data class Attempt(val requestId: String, val awaiting: Boolean)
    private val attempts = mutableMapOf<String, Attempt>()
    private val _stopping = MutableStateFlow<Set<String>>(emptySet())
    val stopping: StateFlow<Set<String>> = _stopping
    private val _confirmed = MutableStateFlow<Set<String>>(emptySet())
    val confirmed: StateFlow<Set<String>> = _confirmed

    @Synchronized fun begin(threadId: String, requestId: String): Boolean {
        if (attempts[threadId]?.awaiting == true) return false
        attempts[threadId] = Attempt(requestId, true)
        _confirmed.value = _confirmed.value - threadId
        _stopping.value = _stopping.value + threadId
        return true
    }

    /** A missing reply isn't a rejection. Permit retry, but keep tracking the turn. */
    @Synchronized fun uncertain(threadId: String, requestId: String): Boolean {
        if (attempts[threadId]?.requestId != requestId) return false
        attempts[threadId] = Attempt(requestId, false)
        _stopping.value = _stopping.value - threadId
        return true
    }

    @Synchronized fun rejected(threadId: String, requestId: String): Boolean {
        if (attempts[threadId]?.requestId != requestId) return false
        attempts.remove(threadId)
        _stopping.value = _stopping.value - threadId
        return true
    }

    /** True only for an observed terminal event, never a quiet inferred ending. */
    @Synchronized fun terminal(threadId: String, status: String, quiet: Boolean): Boolean {
        if (quiet || status.lowercase() !in setOf("completed", "cancelled", "canceled", "aborted", "interrupted", "failed")) return false
        if (attempts.remove(threadId) == null) return false
        _stopping.value = _stopping.value - threadId
        if (status.equals("failed", true)) return false
        _confirmed.value = _confirmed.value + threadId
        return true
    }

    @Synchronized fun newTurn(threadId: String) { _confirmed.value = _confirmed.value - threadId }

    @Synchronized fun clear() {
        attempts.clear()
        _stopping.value = emptySet()
        _confirmed.value = emptySet()
    }
}
