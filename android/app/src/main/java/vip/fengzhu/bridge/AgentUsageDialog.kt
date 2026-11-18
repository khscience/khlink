package vip.fengzhu.bridge

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.util.Locale

@Composable
internal fun AgentUsageDialog(vm: BridgeViewModel, backend: String, connectorId: String?, unit: TokenDisplayUnit, dismiss: () -> Unit) {
    val palette = KhThemeState.current.palette
    val snapshot by vm.agentUsage.collectAsState()
    val liveThreads by vm.threads.collectAsState()
    val phoneArchived by vm.phoneArchivedIds.collectAsState()
    val archiving by vm.archivingIds.collectAsState()
    var period by rememberSaveable(backend) { mutableStateOf(AgentUsagePeriod.TODAY) }
    DisposableEffect(backend, connectorId) {
        vm.loadAgentUsage(backend)
        onDispose { vm.dismissAgentUsage() }
    }
    val current = snapshot?.takeIf { it.backend == backend }
    val threads = remember(current?.threads, liveThreads, phoneArchived, archiving) {
        agentUsageLiveThreads(current?.threads.orEmpty(), liveThreads, phoneArchived, archiving)
    }
    val slices = remember(current?.entries, threads, period) { current?.let { agentUsageSlices(threads, it.entries, period) }.orEmpty() }
    val total = slices.sumOf { it.amount.total.toDouble() }.coerceAtMost(Long.MAX_VALUE.toDouble()).toLong()
    val unknownThreads = current?.let { state -> threads.filter { state.entries[it.id]?.amount(period) == null } }.orEmpty()
    val unknown = unknownThreads.size
    // Unread rows are not evidence of missing data while the scan is running.
    val partial = slices.any { it.amount.partial } || (unknown > 0 && current?.loading == false)
    val completed = current?.let { state -> threads.count { state.entries[it.id]?.status in setOf("ready", "unavailable") } } ?: 0
    val colors = listOf(palette.accent, Color(0xff27a887), Color(0xffe89948), Color(0xff9369d2), Color(0xff508eca), Color(0xffd77289), Color(0xff7ea34b), Color(0xff72aaa5))
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = palette.paper) {
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(dismiss) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = palette.ink) }
                    Column(Modifier.weight(1f)) {
                        Text("对话 Token 用量", color = palette.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text("${homeTabLabel(backend, 6)} · 当前电脑", color = palette.muted, style = MaterialTheme.typography.labelSmall)
                    }
                    IconButton({ vm.loadAgentUsage(backend) }) { Icon(Icons.Default.Refresh, "刷新用量", tint = palette.ink) }
                }
                HorizontalDivider(color = palette.divider)
                LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(0.dp)) {
                    item {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                                AgentUsagePeriod.entries.forEachIndexed { index, option ->
                                    SegmentedButton(selected = period == option, onClick = { period = option },
                                        shape = SegmentedButtonDefaults.itemShape(index, AgentUsagePeriod.entries.size)) { Text(option.label) }
                                }
                            }
                            Spacer(Modifier.height(22.dp))
                            Box(Modifier.size(180.dp), contentAlignment = Alignment.Center) {
                                Canvas(Modifier.fillMaxSize()) {
                                    val stroke = 17.dp.toPx()
                                    val diameter = size.minDimension - stroke
                                    drawArc(palette.surfaceAlt, -90f, 360f, false,
                                        topLeft = androidx.compose.ui.geometry.Offset(stroke / 2, stroke / 2),
                                        size = Size(diameter, diameter), style = Stroke(stroke, cap = StrokeCap.Butt))
                                    var angle = -90f
                                    slices.forEachIndexed { index, slice ->
                                        val sweep = (slice.fraction * 360).toFloat()
                                        if (sweep > 0f) drawArc(if (index < colors.size) colors[index] else palette.muted.copy(alpha = 0.55f),
                                            angle, sweep, false, topLeft = androidx.compose.ui.geometry.Offset(stroke / 2, stroke / 2),
                                            size = Size(diameter, diameter), style = Stroke(stroke, cap = StrokeCap.Butt))
                                        angle += sweep
                                    }
                                }
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text(if (partial) "已记录" else "Token 总量", color = palette.muted, style = MaterialTheme.typography.labelMedium)
                                    Text(if (slices.isEmpty() || (partial && total == 0L)) "—" else formatTokenDisplay(total, unit), color = palette.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                    Text("${slices.count { it.amount.total > 0 }} 个对话", color = palette.muted, style = MaterialTheme.typography.labelSmall)
                                }
                            }
                            Spacer(Modifier.height(18.dp))
                            Text("统计当前电脑未归档的对话，按手机本地时间划分。", color = palette.muted,
                                style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
                            if (backend == "claude") Text("Claude 用量不含子代理。", color = palette.muted, style = MaterialTheme.typography.bodySmall)
                            if (backend == "hermes" && period != AgentUsagePeriod.ALL) Text("跨时间范围的 Hermes 会话缺少逐次记录，显示为部分数据。", color = palette.muted, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
                            if (partial && threads.isNotEmpty()) Text("部分对话缺少完整记录，图表占比按已记录数据计算。", color = palette.warm,
                                style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                            current?.reason?.let { Text(it, color = palette.muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp), textAlign = TextAlign.Center) }
                            if (current?.loading == true) Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = palette.accent)
                                Spacer(Modifier.width(8.dp))
                                Text(if (threads.isEmpty()) "正在同步对话…" else "正在读取 $completed / ${threads.size} 个对话", color = palette.muted, style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                    if (current != null && !current.loading && slices.none { it.amount.total > 0 }) item {
                        Text(if (partial) "这一时段的记录不完整，暂无法计算占比" else "这个时间范围没有已记录的用量",
                            Modifier.fillMaxWidth().padding(20.dp), color = palette.muted, textAlign = TextAlign.Center)
                    }
                    if (slices.isNotEmpty() || (unknownThreads.isNotEmpty() && current?.loading == false)) item {
                        Text("对话明细", Modifier.padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 6.dp),
                            color = palette.ink, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    }
                    itemsIndexed(slices, key = { _, item -> item.thread.id }) { index, item ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(10.dp).background(if (index < colors.size) colors[index] else palette.muted.copy(alpha = 0.55f), CircleShape))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(item.thread.title.ifBlank { "未命名对话" }, color = palette.ink, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (item.amount.partial) Text("部分记录", color = palette.warm, style = MaterialTheme.typography.labelSmall)
                            }
                            Spacer(Modifier.width(8.dp))
                            Column(horizontalAlignment = Alignment.End) {
                                Text(formatAgentUsageAmount(item.amount, unit), color = palette.ink, style = MaterialTheme.typography.bodySmall)
                                Text(if (item.amount.partial && item.amount.total == 0L) "—" else formatAgentUsagePercent(item.fraction), color = palette.muted, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                        HorizontalDivider(Modifier.padding(start = 40.dp, end = 20.dp), color = palette.divider.copy(alpha = 0.5f))
                    }
                    if (current?.loading == false) itemsIndexed(unknownThreads, key = { _, item -> "unknown:${item.id}" }) { _, thread ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(10.dp).background(palette.muted.copy(alpha = 0.35f), CircleShape))
                            Spacer(Modifier.width(10.dp))
                            Text(thread.title.ifBlank { "未命名对话" }, Modifier.weight(1f), color = palette.ink,
                                style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("暂无数据", color = palette.muted, style = MaterialTheme.typography.labelSmall)
                        }
                        HorizontalDivider(Modifier.padding(start = 40.dp, end = 20.dp), color = palette.divider.copy(alpha = 0.5f))
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

internal fun formatAgentUsagePercent(fraction: Double): String = when {
    !fraction.isFinite() || fraction <= 0 -> "0%"
    fraction < 0.001 -> "<0.1%"
    else -> String.format(Locale.US, "%.1f%%", fraction.coerceIn(0.0, 1.0) * 100)
}

internal fun formatAgentUsageAmount(amount: AgentUsageAmount, unit: TokenDisplayUnit): String =
    if (amount.partial && amount.total == 0L) "暂无法统计" else formatTokenDisplay(amount.total, unit)
