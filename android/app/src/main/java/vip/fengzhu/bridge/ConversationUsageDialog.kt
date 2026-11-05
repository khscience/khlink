package vip.fengzhu.bridge

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
internal fun ConversationUsageDialog(
    threadId: String, usage: ConversationTokenUsage?, loading: Boolean, online: Boolean, unit: TokenDisplayUnit,
    refresh: () -> Unit, dismiss: () -> Unit,
) {
    var selected by remember(threadId) { mutableIntStateOf(0) }
    val counts = when (selected) { 1 -> usage?.turn; 2 -> usage?.latest; else -> usage?.totals }
    val labels = listOf("累计", if (usage?.turnActive == true) "本轮" else "最近一轮", "最近调用")
    AlertDialog(
        onDismissRequest = dismiss,
        title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Token 用量", Modifier.weight(1f))
                if (loading || usage?.status == "scanning") CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            }
        },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (usage?.totals != null) {
                    Row(Modifier.fillMaxWidth()) {
                        labels.forEachIndexed { index, label ->
                            TextButton({ selected = index }, Modifier.weight(1f)) {
                                Text(label, fontWeight = if (selected == index) FontWeight.Bold else FontWeight.Normal,
                                    color = if (selected == index) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(when (selected) { 1 -> if (usage.turnActive) "本轮已记录" else "最近一轮已记录"; 2 -> "最近一次模型调用"; else -> "已记录累计" }, style = MaterialTheme.typography.labelLarge)
                            Text(formatTokenDisplay(counts?.total, unit), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                            Text("精确值 ${formatTokenCount(counts?.total)} tokens", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(4.dp))
                            TokenUsageRow("输入", counts?.input, unit)
                            TokenUsageRow("输出", counts?.output, unit)
                            TokenUsageRow("其中缓存读取", counts?.cacheRead, unit)
                            TokenUsageRow("其中缓存写入", counts?.cacheWrite, unit)
                            TokenUsageRow("其中推理输出", counts?.reasoning, unit)
                        }
                    }
                    if (counts == null) Text(if (selected == 1) "未找到完整的本轮边界，请查看累计或最近调用。" else "暂无最近调用记录。", style = MaterialTheme.typography.bodySmall)
                    if (usage.partial) Text("部分记录缺失，仅统计已读取的用量。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    usage.model?.let { Text("最近调用模型：$it", style = MaterialTheme.typography.bodySmall) }
                    val time = usage.usageUpdatedAt.takeIf { it > 0 }?.let { SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA).format(Date(it)) } ?: "未知"
                    Text("日志更新于 $time", style = MaterialTheme.typography.bodySmall)
                    if (!online) Text("当前离线，显示上次记录。", style = MaterialTheme.typography.bodySmall)
                    else if (usage.fromCache) Text("显示上次记录，等待电脑更新。", style = MaterialTheme.typography.bodySmall)
                    usage.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                } else {
                    Text(when {
                        !online -> "当前离线，暂无已缓存的用量。"
                        loading -> "正在读取此对话的用量记录…"
                        else -> usage?.reason ?: "此对话尚无可读取的 token 用量记录"
                    })
                }
                Text("缓存已包含在输入中，推理已包含在输出中；“—”表示日志未提供。累计是反复调用的总用量，不是当前上下文长度，也不能换算成订阅剩余额度。",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("按此会话主日志统计，不含子代理用量。分叉可能包含继承记录。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { TextButton(dismiss) { Text("关闭") } },
        dismissButton = { TextButton(refresh, enabled = online && !loading) { Text("刷新") } },
    )
}

@Composable
private fun TokenUsageRow(label: String, value: Long?, unit: TokenDisplayUnit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        Text(formatTokenDisplay(value, unit), style = MaterialTheme.typography.bodyMedium)
    }
}
