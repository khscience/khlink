package vip.fengzhu.bridge

import org.json.JSONObject
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** One DeepSeek Platform wallet row. */
data class DshWallet(val currency: String, val balance: String)

/** Balance and today's token usage reported by the DSH desktop Host. */
data class DshUsage(
    val day: String = "",
    val input: Long = 0,
    val output: Long = 0,
    val cacheRead: Long = 0,
    val cacheWrite: Long = 0,
    val total: Long = 0,
    val balance: List<DshWallet> = emptyList(),
    val bonus: List<DshWallet> = emptyList(),
    val status: String = "",
    val name: String? = null,
    val contact: String? = null,
    val spent: Double? = null,
    val spentCurrency: String = "CNY",
    val spentSince: Long = 0,
    val updatedAt: Long = 0,
)

internal fun parseDshUsage(value: JSONObject?): DshUsage? {
    value ?: return null
    fun wallets(array: org.json.JSONArray?): List<DshWallet> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val row = array.optJSONObject(index) ?: return@mapNotNull null
            val currency = row.optString("currency").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            DshWallet(currency, row.optString("balance"))
        }
    }
    val today = value.optJSONObject("today")
    val account = value.optJSONObject("account")
    return DshUsage(
        day = value.optString("day"),
        input = today?.optLong("input", 0) ?: 0,
        output = today?.optLong("output", 0) ?: 0,
        cacheRead = today?.optLong("cacheRead", 0) ?: 0,
        cacheWrite = today?.optLong("cacheWrite", 0) ?: 0,
        total = today?.optLong("total", 0) ?: 0,
        balance = wallets(account?.optJSONArray("balance")),
        bonus = wallets(account?.optJSONArray("bonusWallets")),
        status = account?.optString("status").orEmpty(),
        name = account?.optString("name")?.takeIf { it.isNotBlank() && it != "null" },
        contact = account?.optString("contact")?.takeIf { it.isNotBlank() && it != "null" },
        spent = if (value.has("spent") && !value.isNull("spent")) value.optDouble("spent") else null,
        spentCurrency = value.optString("spentCurrency").takeIf { it.isNotBlank() } ?: "CNY",
        spentSince = value.optLong("spentSince", 0),
        updatedAt = value.optLong("updatedAt", 0),
    )
}

internal fun dshSpentText(usage: DshUsage?): String {
    val amount = usage?.spent ?: return "—"
    val symbol = when (usage.spentCurrency) {
        "CNY" -> "¥"
        "USD" -> "$"
        else -> "${usage.spentCurrency} "
    }
    return "$symbol%.2f".format(Locale.US, amount)
}

/** "今日累计" once the baseline is midnight; otherwise the reading's start. */
internal fun dshSpentLabel(usage: DshUsage?): String {
    val since = usage?.spentSince ?: return "今日累计"
    val midnight = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis
    if (since <= midnight + 60_000) return "今日累计"
    return "自 ${SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(since))}"
}

internal fun dshBalanceText(usage: DshUsage?): String {
    val wallet = usage?.balance?.firstOrNull() ?: return "—"
    val symbol = when (wallet.currency) {
        "CNY" -> "¥"
        "USD" -> "$"
        else -> "${wallet.currency} "
    }
    val amount = wallet.balance.toDoubleOrNull()
    return if (amount == null) "$symbol${wallet.balance}" else "$symbol%.2f".format(Locale.US, amount)
}

internal fun compactDshTokens(value: Long): String = when {
    value >= 1_000_000 -> String.format(Locale.US, "%.2fM", value / 1_000_000.0)
    value >= 1_000 -> String.format(Locale.US, "%.1fK", value / 1_000.0)
    else -> NumberFormat.getIntegerInstance(Locale.US).format(value)
}
