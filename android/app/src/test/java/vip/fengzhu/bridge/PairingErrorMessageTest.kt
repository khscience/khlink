package vip.fengzhu.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingErrorMessageTest {
    @Test
    fun membershipFailuresOfferTheMemberCenter() {
        val noMembership = PairingErrorMessage.fromAccountLogin(IllegalStateException("403: {\"message\":\"An active khLink membership is required for phone login\"}"))
        org.junit.Assert.assertTrue(PairingErrorMessage.needsMembership(noMembership))
        org.junit.Assert.assertTrue(PairingErrorMessage.needsMembership("本月免费流量已用完，远程操作暂停到下月 1 日。扫码直连不计流量，可以改用直连"))
        org.junit.Assert.assertFalse(PairingErrorMessage.needsMembership("二维码无效或已过期，请在电脑端重新生成"))
        assertEquals("https://khsci.com/khlink/account#membership", PairingErrorMessage.MEMBERSHIP_URL)
    }

    @Test
    fun distinguishesAccountLoginFailuresFromQrPairingFailures() {
        assertEquals(
            "本月免费流量已用完，暂时不能在手机登录；下月 1 日恢复，也可以改用扫码直连（不计流量）",
            PairingErrorMessage.fromAccountLogin(IllegalStateException("403: {\"message\":\"An active khLink membership is required for phone login\"}")),
        )
        assertEquals(
            "此账号暂未获准在手机登录，请联系管理员",
            PairingErrorMessage.fromAccountLogin(IllegalStateException("403: {\"message\":\"This khLink account is not allowed to use phone login\"}")),
        )
        assertEquals(
            "此 khLink 账号已停用，请联系支持",
            PairingErrorMessage.fromAccountLogin(IllegalStateException("400: {\"message\":\"This khLink account is disabled\"}")),
        )
        assertEquals(
            "账号登录失败，请检查账号状态后重试",
            PairingErrorMessage.fromAccountLogin(IllegalStateException("400: invalid request")),
        )
        assertEquals(
            "网络连接失败，请检查网络后重试",
            PairingErrorMessage.fromAccountLogin(IllegalStateException("Failed to connect")),
        )
    }

    @Test
    fun mapsMissingAndExpiredPairingCodes() {
        val expected = "二维码无效或已过期，请在电脑端重新生成"
        assertEquals(expected, PairingErrorMessage.from(IllegalStateException("400: {\"message\":\"Pairing code not found\"}")))
        assertEquals(expected, PairingErrorMessage.from(IllegalStateException("配对二维码已过期，请在电脑端重新生成")))
    }

    @Test
    fun keepsFriendlyLocalValidationMessages() {
        assertEquals(
            "图片中没有识别到 KH Link 二维码",
            PairingErrorMessage.from(IllegalArgumentException("图片中没有识别到 KH Link 二维码"), imageSource = true),
        )
    }

    @Test
    fun hidesUnknownServerResponses() {
        assertEquals(
            "配对服务暂时不可用，请稍后重试",
            PairingErrorMessage.from(IllegalStateException("500: internal server error")),
        )
        assertEquals(
            "二维码无效或已过期，请在电脑端重新生成",
            PairingErrorMessage.from(IllegalStateException("400: invalid request"), imageSource = true),
        )
    }
}
