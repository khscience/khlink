package vip.fengzhu.bridge

/**
 * A direct link that keeps failing to come back (the computer restarted and
 * its tunnel address changed, it moved to another network, or the network
 * blocks direct links) suggests the account login once: the official relay
 * reaches the computer from anywhere. Retries go on underneath; the
 * suggestion comes back only after a successful reconnect and a new run of
 * failures.
 */
internal const val DIRECT_SUGGEST_ACCOUNT_AFTER = 4

internal fun shouldSuggestAccountLogin(failedAttempts: Int, phoneOnline: Boolean, alreadyShown: Boolean, accountLoginAvailable: Boolean): Boolean =
    accountLoginAvailable && phoneOnline && !alreadyShown && failedAttempts >= DIRECT_SUGGEST_ACCOUNT_AFTER
