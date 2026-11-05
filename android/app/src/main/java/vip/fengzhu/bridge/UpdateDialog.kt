package vip.fengzhu.bridge

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.util.Locale

/** A single action area: download, installation and deferral never share duplicate controls. */
@Composable
internal fun UpdateDialog(
    update: UpdateInfo,
    download: UpdateDownloadState,
    start: (UpdateInfo) -> Unit,
    cancel: () -> Unit,
    install: () -> Boolean,
    postpone: () -> Unit,
    skip: () -> Unit,
) {
    // A package of another version (a newer one was published meanwhile) is
    // not this update: offer to download this one instead.
    val download = if (download is UpdateDownloadState.Ready && download.versionName != update.versionName) UpdateDownloadState.Idle else download
    val colors = LocalKhLinkSkin.current.palette
    val downloading = download is UpdateDownloadState.Downloading
    val title = when (download) {
        UpdateDownloadState.Idle -> "发现新版本"
        is UpdateDownloadState.Downloading -> "正在下载更新"
        is UpdateDownloadState.Ready -> "更新已下载"
        is UpdateDownloadState.Failed -> "下载未完成"
    }
    Dialog(
        onDismissRequest = { if (!downloading) postpone() },
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnBackPress = !downloading,
            dismissOnClickOutside = !downloading,
        ),
    ) {
        Surface(
            modifier = Modifier.padding(horizontal = 20.dp).widthIn(max = 420.dp).fillMaxWidth()
                .heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.88f).dp),
            shape = RoundedCornerShape(24.dp),
            color = colors.surface,
            contentColor = colors.ink,
        ) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Surface(shape = RoundedCornerShape(14.dp), color = colors.surfaceAlt) {
                            Icon(Icons.Default.SystemUpdate, contentDescription = null,
                                modifier = Modifier.padding(12.dp).size(24.dp), tint = colors.accent)
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                            Text("khLink ${update.versionName}", style = MaterialTheme.typography.bodyMedium, color = colors.muted)
                        }
                    }
                    when (download) {
                        UpdateDownloadState.Idle -> {
                            Text("当前版本 ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = colors.muted)
                            if (update.notes.isNotEmpty()) UpdateNotes(update.notes)
                            Text("更新会保留登录信息和聊天记录，安装前由系统请你确认。", style = MaterialTheme.typography.bodyMedium)
                        }
                        is UpdateDownloadState.Downloading -> {
                            val progress = if (download.totalBytes > 0) {
                                (download.downloadedBytes.toDouble() / download.totalBytes).coerceIn(0.0, 1.0).toFloat()
                            } else null
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text(
                                    if (download.connecting) "正在连接…"
                                    else if (progress != null) "${(progress * 100).toInt()}%"
                                    else if (download.downloadedBytes > 0) "正在下载" else "正在连接…",
                                    style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold,
                                )
                                if (progress == null) {
                                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(6.dp),
                                        color = colors.accent, trackColor = colors.surfaceAlt, strokeCap = StrokeCap.Round)
                                } else {
                                    LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().height(6.dp),
                                        color = colors.accent, trackColor = colors.surfaceAlt, strokeCap = StrokeCap.Round)
                                }
                                Text(
                                    if (download.totalBytes > 0) "${updateSize(download.downloadedBytes)} / ${updateSize(download.totalBytes)}"
                                    else if (download.downloadedBytes > 0) "已下载 ${updateSize(download.downloadedBytes)}" else "正在获取安装包大小",
                                    style = MaterialTheme.typography.bodySmall, color = colors.muted,
                                )
                                Text(
                                    "${if (download.connecting) "正在连接" else "下载渠道"}：${download.channel}",
                                    style = MaterialTheme.typography.bodySmall, color = colors.muted,
                                )
                            }
                            UpdateNotes(update.notes)
                            Text("请保持 khLink 打开，下载完成后会打开系统安装页面。", style = MaterialTheme.typography.bodyMedium)
                        }
                        is UpdateDownloadState.Ready -> Text(
                            "安装包已校验，可以继续安装。如果系统要求授权，请允许 khLink 安装应用后返回。",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        is UpdateDownloadState.Failed -> {
                            Text("暂时没能完成下载，可以重试或稍后再试。", style = MaterialTheme.typography.bodyMedium)
                            Surface(color = colors.dangerContainer, shape = RoundedCornerShape(12.dp)) {
                                Text(download.message, Modifier.padding(12.dp), color = colors.danger,
                                    style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    when (download) {
                        UpdateDownloadState.Idle, is UpdateDownloadState.Failed -> {
                            Button(onClick = { start(update) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                                shape = RoundedCornerShape(12.dp)) {
                                Text(if (download is UpdateDownloadState.Failed) "重新下载" else "立即更新")
                            }
                            UpdateSecondaryButton(if (download is UpdateDownloadState.Failed) "稍后重试" else "稍后提醒", postpone)
                            if (download is UpdateDownloadState.Idle) UpdateSecondaryButton("跳过此版本", skip)
                        }
                        is UpdateDownloadState.Downloading -> UpdateSecondaryButton("取消下载", cancel)
                        is UpdateDownloadState.Ready -> {
                            Button(onClick = { install() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                                shape = RoundedCornerShape(12.dp)) { Text("继续安装") }
                            UpdateSecondaryButton("稍后安装", postpone)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun UpdateSecondaryButton(label: String, onClick: () -> Unit) {
    val colors = LocalKhLinkSkin.current.palette
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        border = BorderStroke(1.dp, colors.muted.copy(alpha = 0.55f)), shape = RoundedCornerShape(12.dp)) {
        Text(label, color = colors.ink)
    }
}

private fun updateSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> String.format(Locale.getDefault(), "%.1f MB", bytes / 1048576.0)
    bytes >= 1024 -> String.format(Locale.getDefault(), "%.1f KB", bytes / 1024.0)
    else -> "${bytes.coerceAtLeast(0)} B"
}

/** "这次更新": the version's changes, one row per line. */
@Composable
private fun UpdateNotes(notes: List<String>) {
    val colors = LocalKhLinkSkin.current.palette
    Surface(shape = RoundedCornerShape(14.dp), color = colors.surfaceAlt) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("这次更新", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            if (notes.isEmpty()) Text("暂无更新说明", style = MaterialTheme.typography.bodyMedium, color = colors.muted)
            notes.forEach { line ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("•", style = MaterialTheme.typography.bodyMedium, color = colors.accent)
                    Text(line, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}
