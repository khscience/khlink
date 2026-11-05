package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OnboardingStateTest {
    @Test
    fun aFreshInstallIsDecidedAtLegalConsent() {
        assertNull(OnboardingState.resolve(stored = null, consentedBefore = false))
    }

    @Test
    fun anInstallThatConsentedBeforeTheGuideExistedNeverSeesIt() {
        assertEquals(OnboardingState.Done, OnboardingState.resolve(stored = null, consentedBefore = true))
    }

    @Test
    fun aPendingGuideSurvivesARestartUntilFinished() {
        assertEquals(OnboardingState.Pending, OnboardingState.resolve(stored = "pending", consentedBefore = true))
        assertEquals(OnboardingState.Done, OnboardingState.resolve(stored = "done", consentedBefore = false))
        assertEquals(OnboardingState.Done, OnboardingState.resolve(stored = "garbage", consentedBefore = false))
    }

    @Test
    fun stepsRunInOrder() {
        assertEquals(listOf("选一个主题", "智能体", "提醒与后台", "准备好了"), OnboardingStep.entries.map { it.title })
        assertEquals(OnboardingStep.Agents, OnboardingStep.Theme.next)
        assertNull(OnboardingStep.Finish.next)
        assertNull(OnboardingStep.Theme.previous)
    }
}
