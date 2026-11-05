package vip.fengzhu.bridge

/**
 * First-run guide state. Stored as "onboarding_v1" in display-preferences:
 * "pending" from the first legal consent of a fresh install until the guide is
 * finished or skipped ("done"). An install that consented before this version
 * existed (any stored legal version, or a chosen theme) is an existing user
 * and never sees the guide.
 */
enum class OnboardingState(val stored: String) {
    Pending("pending"), Done("done");
    companion object {
        fun resolve(stored: String?, consentedBefore: Boolean): OnboardingState? = when {
            stored != null -> entries.firstOrNull { it.stored == stored } ?: Done
            consentedBefore -> Done
            // Nothing yet: a fresh install, decided when legal consent is given.
            else -> null
        }
    }
}

/** The guide's steps, in order. */
enum class OnboardingStep(val title: String) {
    Theme("选一个主题"), Agents("智能体"), Alerts("提醒与后台"), Finish("准备好了");
    val next get() = entries.getOrNull(ordinal + 1)
    val previous get() = entries.getOrNull(ordinal - 1)
}
