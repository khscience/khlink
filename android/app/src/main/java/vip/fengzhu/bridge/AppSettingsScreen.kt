package vip.fengzhu.bridge

import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Button
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/** Global settings have their own page, with a fixed back button and grouped
 * controls. Thread model/permission settings remain in the thread itself. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AppSettingsScreen(
    account: AccountUiState?, v2: Boolean, scrollState: ScrollState,
    visibleAgents: Set<String>, agentOrder: List<String>, unit: TokenDisplayUnit, unitChanged: (TokenDisplayUnit) -> Unit,
    close: () -> Unit, agentSettings: () -> Unit, devices: () -> Unit, fetchedFiles: () -> Unit,
    update: () -> Unit, password: () -> Unit, markAllRead: () -> Unit, logout: () -> Unit,
    direct: () -> Unit, restoreServer: () -> Unit, piSettings: (() -> Unit)?,
    theme: () -> Unit, legal: () -> Unit, replayGuide: () -> Unit = {},
    claudeEnabled: Boolean = false, claudeNotice: () -> Unit = {}, disableClaude: () -> Unit = {},
    lightMode: Boolean = false, lightModeChanged: (Boolean) -> Unit = {},
    showPcLoad: Boolean = false, showPcLoadChanged: (Boolean) -> Unit = {},
    claudeStatusline: ClaudeStatuslineState? = null, claudeStatuslineChanged: (Boolean) -> Unit = {},
    autoDownloadUpdates: Boolean = true, autoDownloadUpdatesChanged: (Boolean) -> Unit = {},
) {
    val context = LocalContext.current
    var membershipDetails by rememberSaveable { mutableStateOf(false) }
    val directMode = account?.effectiveSource == "direct"
    val notifications = remember { context.getSystemService(android.app.NotificationManager::class.java) }
    val notificationsEnabled = notifications?.areNotificationsEnabled() != false
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Scaffold(topBar = {
                TopAppBar(title = { Text("设置", fontWeight = FontWeight.SemiBold) }, navigationIcon = {
                    IconButton(close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回首页") }
                })
            }) { padding ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    Column(Modifier.align(Alignment.TopCenter).widthIn(max = 640.dp).fillMaxSize()
                        .verticalScroll(scrollState).padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = MaterialTheme.shapes.large) {
                            Column(Modifier.fillMaxWidth().animateContentSize().padding(16.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    UserAvatar(account?.displayName ?: "KH", account?.avatarUrl, 48)
                                    Spacer(Modifier.width(14.dp))
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Text(account?.displayName ?: if (v2) "正在读取账户" else "自己的服务器", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(when {
                                            directMode -> "二维码直连 · 数据不经服务器"; account == null -> "正在同步账户"
                                            account.traffic?.exhausted == true && account.effectiveSource == "free" -> "账户连接 · 本月免费流量已用完"
                                            account.canWrite && account.effectiveSource == "free" -> "账户连接 · 免费额度"
                                            account.canWrite -> "账户连接 · 远程操作可用"; else -> "账户连接 · 当前为只读模式" },
                                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                // Traffic through the official server this month; direct
                                // links and self-hosted servers are never counted.
                                val traffic = account?.traffic
                                if (v2 && !directMode && traffic != null) TrafficCard(traffic, member = account.effectiveSource != "free")
                                if (v2 && !directMode && account != null && !account.canWrite) {
                                    Button({ context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PairingErrorMessage.MEMBERSHIP_URL))) }, Modifier.fillMaxWidth().padding(top = 12.dp)) {
                                        Text("去开通会员")
                                    }
                                }
                                if (v2 && !directMode) {
                                    TextButton({ membershipDetails = !membershipDetails }, Modifier.fillMaxWidth()) {
                                        Text(if (membershipDetails) "收起会员详情" else "查看会员详情", Modifier.weight(1f))
                                        Icon(if (membershipDetails) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
                                    }
                                    if (membershipDetails) {
                                        listOf("khquant" to "khQuant VIP", "kh_link" to "khLink VIP").forEach { (product, name) ->
                                            val membership = account?.memberships?.firstOrNull { it.product == product }
                                            MembershipLine(name, membershipStateLabel(membership?.state.orEmpty()), membershipExpiry(membership?.expiresAt))
                                        }
                                    }
                                }
                            }
                        }
                        SettingsGroup("显示与统计") {
                            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Icon(Icons.Default.BarChart, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                                    Column {
                                        Text("Token 显示单位", fontWeight = FontWeight.Medium)
                                        Text("适用于所有对话的用量统计", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    listOf(TokenDisplayUnit.TenThousands, TokenDisplayUnit.Millions).forEach { option ->
                                        val chosen = unit == option
                                        Surface(Modifier.weight(1f).heightIn(min = 52.dp).selectable(chosen, role = Role.RadioButton) { unitChanged(option) },
                                            shape = MaterialTheme.shapes.medium,
                                            color = if (chosen) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh) {
                                            Row(Modifier.padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                                RadioButton(chosen, onClick = null)
                                                Column {
                                                    Text(option.label, fontWeight = FontWeight.SemiBold)
                                                    Text(if (option == TokenDisplayUnit.Millions) "百万 tokens" else "一万 tokens", style = MaterialTheme.typography.labelSmall)
                                                }
                                            }
                                        }
                                    }
                                }
                                Text("预览：${formatTokenDisplay(57_937_285, unit)} · 详情保留精确总数", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            SettingsDivider()
                            SettingsSwitch(Icons.Default.Memory, "显示电脑负载",
                                if (showPcLoad) "已开启 · 点列表标题时显示 CPU、GPU 和内存占用" else "未开启 · 列表顶部只显示电脑和额度",
                                showPcLoad, showPcLoadChanged)
                            SettingsDivider()
                            SettingsEntry(Icons.Default.Palette, "主题", KhThemeState.current.name, theme)
                            SettingsDivider()
                            SettingsEntry(Icons.Default.Autorenew, "重新查看新手引导", "主题、智能体、提醒和后台运行", replayGuide)
                            SettingsDivider()
                            SettingsEntry(Icons.Default.Psychology, "显示的 Agent", visibleHomeAgents(visibleAgents, agentOrder).joinToString(" · ") { homeTabLabel(it, 4) }, agentSettings)
                        }
                        SettingsGroup("连接与账号") {
                            SettingsEntry(Icons.Default.Psychology, "Claude 远程控制", if (claudeEnabled) "已开启 · 查看使用提示" else "未开启 · 阅读提示后开启", claudeNotice)
                            if (claudeEnabled) TextButton(disableClaude, Modifier.padding(horizontal = 12.dp)) { Text("关闭 Claude 远程控制") }
                            // Only offered by connectors that have the option.
                            if (claudeStatusline != null) {
                                SettingsDivider()
                                SettingsSwitch(Icons.Default.Speed, "终端 Claude Code 实时额度", claudeStatuslineSummary(claudeStatusline),
                                    claudeStatusline.enabled, claudeStatuslineChanged)
                            }
                            SettingsDivider()
                            SettingsEntry(Icons.Default.Devices, "已绑定设备", "管理当前电脑与手机", devices)
                            SettingsDivider()
                            SettingsEntry(Icons.Default.QrCodeScanner, "二维码直连", "扫描电脑连接码，不经过业务服务器", direct)
                            if (directMode) { SettingsDivider(); SettingsEntry(Icons.Default.Autorenew, "返回账户连接", "恢复之前保存的账户会话", restoreServer) }
                            if (v2 && !directMode) {
                                SettingsDivider()
                                SettingsEntry(Icons.Default.Autorenew, "会员与续费", "在官网会员中心开通或续费 khLink 会员") {
                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PairingErrorMessage.MEMBERSHIP_URL)))
                                }
                            }
                            if (!v2) { SettingsDivider(); SettingsEntry(Icons.Default.Build, "服务器密码", "修改登录这台服务器的密码", password) }
                        }
                        SettingsGroup("任务与文件") {
                            SettingsEntry(Icons.Default.NotificationsActive, "任务通知", if (notificationsEnabled) "已开启 · 完成、审批与离线提醒" else "未开启 · 前往系统设置", {
                                context.startActivity(Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName))
                            })
                            SettingsDivider()
                            SettingsSwitch(Icons.Default.Speed, "轻量模式",
                                if (lightMode) "已开启 · 命令、工具输出和截图留在电脑上，点开时再取回" else "未开启 · 执行过程连同截图全部同步",
                                lightMode, lightModeChanged)
                            SettingsDivider()
                            SettingsEntry(Icons.Default.DoneAll, "全部标记为已读", "清除当前任务的未读标记", markAllRead)
                            SettingsDivider()
                            SettingsEntry(Icons.Default.Folder, "电脑取回的文件", "查看、保存或删除手机上的取回文件", fetchedFiles)
                            if (piSettings != null) { SettingsDivider(); SettingsEntry(Icons.Default.Settings, "Pi 设置", "中转服务商、接口地址与模型", piSettings) }
                        }
                        SettingsGroup("关于与支持") {
                            SettingsEntry(Icons.Default.SystemUpdate, "检查更新", "当前版本 ${BuildConfig.VERSION_NAME}", update)
                            SettingsDivider()
                            SettingsSwitch(Icons.Default.Autorenew, "后台下载更新",
                                if (autoDownloadUpdates) "已开启 · 发现新版本时在后台自动下载，下好后提醒你安装" else "未开启 · 发现新版本时只提醒，打开后再下载",
                                autoDownloadUpdates, autoDownloadUpdatesChanged)
                            SettingsDivider()
                            SettingsEntry(Icons.Default.Settings, "隐私、协议与支持", "协议、数据权利与连接帮助", legal)
                        }
                        TextButton(logout, Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                            Icon(Icons.Default.Logout, null, tint = MaterialTheme.colorScheme.error)
                            Spacer(Modifier.width(8.dp))
                            Text("退出登录", color = MaterialTheme.colorScheme.error)
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, Modifier.padding(start = 4.dp), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) { Column(content = content) }
    }
}

@Composable
private fun SettingsDivider() = HorizontalDivider(Modifier.padding(start = 60.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f))

@Composable
private fun SettingsSwitch(icon: ImageVector, title: String, subtitle: String, checked: Boolean, changed: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable { changed(!checked) }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(8.dp))
        Switch(checked, onCheckedChange = changed)
    }
}

@Composable
private fun SettingsEntry(icon: ImageVector, title: String, subtitle: String, action: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(onClick = action).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(8.dp))
        Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
    }
}

/** What the terminal quota option does, as the settings row's second line. */
internal fun claudeStatuslineSummary(state: ClaudeStatuslineState): String = when {
    state.error != null -> "无法修改电脑上的 Claude Code 设置：${state.error}"
    state.enabled && state.chained -> "已开启 · 终端里每聊一轮就更新额度，原来的状态栏照常显示"
    state.enabled -> "已开启 · 终端里每聊一轮就更新额度"
    else -> "未开启 · 只对终端里的 Claude Code 生效；桌面端约 15 分钟更新一次"
}

/** This month's traffic through the official server, and what happens at the limit. */
@Composable
private fun TrafficCard(traffic: TrafficUsage, member: Boolean) {
    val resets = java.text.SimpleDateFormat("M 月 d 日", java.util.Locale.CHINA).format(java.util.Date(traffic.resetsAt))
    Column(Modifier.fillMaxWidth().padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("本月流量", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text(if (member || !traffic.free) "已用 ${formatTraffic(traffic.usedBytes)}" else "${formatTraffic(traffic.usedBytes)} / ${formatTraffic(traffic.limitBytes)}",
                style = MaterialTheme.typography.bodyMedium,
                color = if (!member && traffic.exhausted) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        }
        if (!member && traffic.free) LinearProgressIndicator(progress = { traffic.fraction }, Modifier.fillMaxWidth(),
            color = if (traffic.exhausted || traffic.fraction >= 0.8f) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
        Text(when {
            member -> "会员不限流量。只统计经官方服务器的数据，直连和自建服务器不计。"
            traffic.exhausted -> "本月免费流量已用完，远程操作已暂停；开通会员后立即恢复，$resets 重新计算。直连和自建服务器不受影响。"
            else -> "官方服务器每月免费 ${formatTraffic(traffic.limitBytes)}，$resets 重新计算；直连和自建服务器不计流量。"
        }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
