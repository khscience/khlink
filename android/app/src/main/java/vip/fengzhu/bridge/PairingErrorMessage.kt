package vip.fengzhu.bridge

object PairingErrorMessage {
    /** Where a phone user opens or renews khLink membership (the website member center). */
    const val MEMBERSHIP_URL = "https://khsci.com/khlink/account#membership"

    /** Failures a membership fixes: the screen then offers a way to open one. */
    fun needsMembership(message: String): Boolean = message.contains("免费流量已用完")

    /** Account login does not use a pairing QR; keep its failures distinct. */
    fun fromAccountLogin(error: Throwable): String {
        val message = error.message.orEmpty()
        return when {
            message.contains("active khLink membership is required for phone login", ignoreCase = true) ->
                "本月免费流量已用完，暂时不能在手机登录；下月 1 日恢复，也可以改用扫码直连（不计流量）"
            message.contains("not allowed to use phone login", ignoreCase = true) ->
                "此账号暂未获准在手机登录，请联系管理员"
            message.contains("khLink account is disabled", ignoreCase = true) ->
                "此 khLink 账号已停用，请联系支持"
            message.contains("already has ten phones", ignoreCase = true) ->
                "此账号已绑定 10 部手机，请先在设备管理中移除不再使用的手机"
            message.contains("Unable to resolve host", ignoreCase = true) ||
                message.contains("Failed to connect", ignoreCase = true) ||
                message.contains("timeout", ignoreCase = true) -> "网络连接失败，请检查网络后重试"
            message.trimStart().startsWith("4") -> "账号登录失败，请检查账号状态后重试"
            message.trimStart().startsWith("5") -> "登录服务暂时不可用，请稍后重试"
            message.isNotBlank() -> message
            else -> "账号登录失败，请重试"
        }
    }

    fun from(error: Throwable, imageSource: Boolean = false): String {
        val message = error.message.orEmpty()
        return when {
            message.contains("Pairing code not found", ignoreCase = true) ||
                message.contains("Pairing code expired", ignoreCase = true) ||
                message.contains("Pairing code has expired", ignoreCase = true) ||
                message.contains("Invalid pairing secret", ignoreCase = true) ||
                message.contains("配对二维码已过期") -> "二维码无效或已过期，请在电脑端重新生成"
            message.contains("Pairing was already consumed", ignoreCase = true) ->
                "这个二维码已使用，请在电脑端重新生成"
            message.contains("Unable to resolve host", ignoreCase = true) ||
                message.contains("Failed to connect", ignoreCase = true) ||
                message.contains("timeout", ignoreCase = true) -> "网络连接失败，请检查网络后重试"
            message.isNotBlank() && !message.trimStart().startsWith("4") &&
                !message.trimStart().startsWith("5") -> message
            message.trimStart().startsWith("4") -> "二维码无效或已过期，请在电脑端重新生成"
            message.trimStart().startsWith("5") -> "配对服务暂时不可用，请稍后重试"
            imageSource -> "二维码图片识别失败，请选择电脑端生成的完整二维码"
            else -> "配对失败，请在电脑端重新生成二维码"
        }
    }
}
