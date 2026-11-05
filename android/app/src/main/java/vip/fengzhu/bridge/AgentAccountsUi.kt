package vip.fengzhu.bridge

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay

@Composable private fun accountClock(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(15_000); now = System.currentTimeMillis() } }
    return now
}

@Composable internal fun ClaudeConsentDialog(accept: () -> Unit, decline: () -> Unit) {
    AlertDialog(onDismissRequest = decline, title = { Text("开启 Claude 远程控制") }, text = { Text(CLAUDE_REMOTE_NOTICE) },
        confirmButton = { TextButton(accept) { Text("我已了解，开启") } }, dismissButton = { TextButton(decline) { Text("暂不使用") } })
}
@Composable internal fun ClaudeDisabledPanel(enable: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Claude 远程控制尚未开启", style = MaterialTheme.typography.titleMedium)
        Text("请先阅读使用提示，由你决定是否开启。", style = MaterialTheme.typography.bodyMedium)
        Button(enable) { Text("查看提示并开启") }
    }
}
private fun quotaText(value: AgentQuotaWindow?): String {
    if (value == null) return "暂时无法获取"
    val prefix = if (value.estimated) "预计剩余" else if (value.historical) "历史剩余" else "剩余"
    val number = if (value.remaining % 1.0 == 0.0) value.remaining.toInt().toString() else String.format(Locale.ROOT, "%.1f", value.remaining)
    return "$prefix $number%"
}
private fun accountTime(at: Long) = SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(Date(at))
@Composable internal fun AgentAccountsButton(state: AgentAccountsState?, open: () -> Unit) {
    IconButton(open, Modifier.size(48.dp).semantics {
        contentDescription = "切换账号"
        stateDescription = if (state?.switching == true) state.operation?.message ?: "正在切换账号" else state?.active?.name ?: "查看电脑账号"
    }) {
        if (state?.switching == true) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        else Icon(Icons.Default.SwapHoriz, null, tint = MaterialTheme.colorScheme.primary)
    }
}

@Composable private fun CompactAgentProfile(profile: AgentAccountProfile, backend: String, canSwitch: Boolean, switch: () -> Unit) {
    val windows = listOf("5 小时" to profile.fiveHour, "本周" to profile.week).filter { it.second != null || backend == "claude" }
    val observations = windows.mapNotNull { it.second?.observedAt?.takeIf { at -> at > 0 } }.distinct()
    val commonObservation = observations.singleOrNull()?.takeIf { at -> windows.all { it.second?.observedAt == at } }
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = if (profile.active) BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)) else null) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(profile.name, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (profile.active) "当前" else if (profile.running) "已打开" else "未打开", style = MaterialTheme.typography.labelSmall,
                    color = if (profile.active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                if (backend == "claude" && !profile.active) TextButton(switch, enabled = canSwitch, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("切换") }
            }
            if (windows.isEmpty()) Text("暂无额度记录", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                windows.forEach { (label, quota) ->
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(quotaText(quota), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End)
                        }
                        val reset = quota?.let { q -> q.resetsAt?.let { if (q.estimated) "预计已重置，待确认" else "重置 ${accountTime(it)}" } ?: "重置时间未知" } ?: "重置时间未知"
                        val inlineObservation = windows.size == 1 && quota != null && quota.observedAt > 0
                        Text(reset + if (inlineObservation) " · 数据 ${accountTime(quota!!.observedAt)}" else "",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (!inlineObservation && commonObservation == null && quota != null && quota.observedAt > 0) Text("数据 ${accountTime(quota.observedAt)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (windows.size > 1) commonObservation?.let { Text("数据 ${accountTime(it)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@Composable internal fun AgentAccountsDialog(vm: BridgeViewModel, backend: String, close: () -> Unit) {
    val states by vm.agentAccounts.collectAsState()
    val state = states[backend]?.displayAt(accountClock())
    val readErrors by vm.accountReadErrors.collectAsState()
    val connection by vm.connection.collectAsState()
    var target by remember { mutableStateOf<AgentAccountProfile?>(null) }
    var operation by remember { mutableStateOf("switch") }
    val pending by vm.accountRequestPending.collectAsState()
    val busy = state?.switching == true || pending
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
      Surface(Modifier.padding(horizontal = 20.dp).widthIn(max = 440.dp).fillMaxWidth(), shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.heightIn(max = 520.dp)) {
          Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(if (backend == "codex") "Codex 账号" else "Claude 账号", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
              if (backend == "codex") Text("只读", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
              IconButton(close) { Icon(Icons.Default.Close, "关闭账号面板", Modifier.size(20.dp)) }
          }
          Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (backend == "codex") Text("手机使用默认账号，其他账号仅供查看。", Modifier.padding(horizontal = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (readErrors[backend] != null) Text(readErrors.getValue(backend), color = MaterialTheme.colorScheme.error)
            if (state == null && readErrors[backend] == null) Text("正在读取电脑账号…")
            if (state != null && (!state.configured || state.profiles.isEmpty())) Text("请先在电脑 khLink 中配置账号，并安装支持手机账号面板的桌面版本。")
            state?.operation?.takeIf { it.busy || it.phase == "failed" || it.blockers.isNotEmpty() || it.recovery.isNotEmpty() }?.let { op ->
                Text((if (op.busy && op.origin == "desktop") "电脑正在操作：" else "") + op.message, color = if (op.phase == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                op.blockers.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                if ("repair" in op.recovery && !pending && connection == ConnectionState.Online && backend == "claude") TextButton({ target = state.profiles.firstOrNull { it.id == op.from }; operation = "repair" }) { Text("恢复原账号链接") }
                if (!busy && connection == ConnectionState.Online && backend == "claude") Row {
                    if ("reopen" in op.recovery) TextButton({ target = state.active; operation = "reopen" }) { Text("重新打开 Claude") }
                    if ("switch_back" in op.recovery) TextButton({ target = state.profiles.firstOrNull { it.id == op.from }; operation = "switch" }) { Text("切回原账号") }
                }
            }
            state?.profiles?.forEach { profile ->
                CompactAgentProfile(profile, backend, !busy && connection == ConnectionState.Online) { target = profile; operation = "switch" }
            }
          }
          Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
              Text("${state?.profiles?.size ?: 0} 个账号", Modifier.weight(1f).padding(start = 4.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
              TextButton({ vm.refreshAgentAccounts(backend) }, enabled = connection == ConnectionState.Online) { Icon(Icons.Default.Refresh, null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("刷新") }
          }
        }
      }
    }
    target?.let { profile -> AlertDialog(onDismissRequest = { target = null }, title = { Text(if (operation == "reopen") "重新打开 Claude" else "切换到 ${profile.name}") },
        text = { Text(if (operation == "repair") "在 Claude 及其辅助进程都已退出的前提下，恢复上一次切换前的账号链接，再尝试打开 Claude。不会强制结束进程。" else if (operation == "reopen") "以当前账号重新打开电脑上的 Claude。" else "电脑上的 Claude 会正常关闭，并以所选账号重新打开。切换期间无法给 Claude 发消息。所有任务需先完成，耗时取决于电脑退出与启动速度。") },
        confirmButton = { TextButton({ vm.switchAgentAccount(profile.id, operation); target = null }, enabled = !pending && (!busy || operation == "repair")) { Text("确认并继续") } },
        dismissButton = { TextButton({ target = null }) { Text("取消") } }) }
}
