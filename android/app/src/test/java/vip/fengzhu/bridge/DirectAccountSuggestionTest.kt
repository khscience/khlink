package vip.fengzhu.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectAccountSuggestionTest {
    @Test fun suggestsAccountLoginOnceAfterRepeatedFailures() {
        assertFalse(shouldSuggestAccountLogin(DIRECT_SUGGEST_ACCOUNT_AFTER - 1, phoneOnline = true, alreadyShown = false, accountLoginAvailable = true))
        assertTrue(shouldSuggestAccountLogin(DIRECT_SUGGEST_ACCOUNT_AFTER, phoneOnline = true, alreadyShown = false, accountLoginAvailable = true))
        assertFalse("shown once per run of failures", shouldSuggestAccountLogin(10, phoneOnline = true, alreadyShown = true, accountLoginAvailable = true))
    }

    @Test fun staysQuietWithoutNetworkOrWithoutAccountLogin() {
        assertFalse("the relay cannot help a phone without network", shouldSuggestAccountLogin(10, phoneOnline = false, alreadyShown = false, accountLoginAvailable = true))
        assertFalse("builds without the official service", shouldSuggestAccountLogin(10, phoneOnline = true, alreadyShown = false, accountLoginAvailable = false))
    }
}
