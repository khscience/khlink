package vip.fengzhu.bridge

/** Prevent a request from a previous account from publishing into a new one. */
internal class SessionSnapshotGuard {
    private var generation = 0L

    @Synchronized fun capture(): Long = generation

    @Synchronized fun isCurrent(ticket: Long): Boolean = ticket == generation

    @Synchronized fun publish(ticket: Long, action: () -> Unit): Boolean {
        if (ticket != generation) return false
        action()
        return true
    }

    @Synchronized fun invalidate(action: () -> Unit = {}) {
        generation += 1
        action()
    }
}
