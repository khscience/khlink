package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionConfiguredTest {
    @Test
    fun aSelfHostedPasswordLoginConnectsWithoutAnAccount() {
        assertTrue(sessionConfigured(1, hasAccountKey = true, directMode = false, hasRefresh = true, accountId = null))
    }

    @Test
    fun accountLoginStillNeedsItsAccount() {
        assertTrue(sessionConfigured(2, hasAccountKey = true, directMode = false, hasRefresh = true, accountId = "acct"))
        assertFalse(sessionConfigured(2, hasAccountKey = true, directMode = false, hasRefresh = true, accountId = null))
        assertFalse(sessionConfigured(2, hasAccountKey = true, directMode = false, hasRefresh = true, accountId = " "))
    }

    @Test
    fun noKeyOrNoWayInIsNotConfigured() {
        assertFalse(sessionConfigured(1, hasAccountKey = false, directMode = false, hasRefresh = true, accountId = null))
        assertFalse(sessionConfigured(1, hasAccountKey = true, directMode = false, hasRefresh = false, accountId = null))
        assertTrue(sessionConfigured(2, hasAccountKey = true, directMode = true, hasRefresh = false, accountId = "acct"))
    }
}
