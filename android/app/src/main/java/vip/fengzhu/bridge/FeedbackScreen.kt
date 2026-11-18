package vip.fengzhu.bridge

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import kotlinx.coroutines.launch
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FeedbackScreen(close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var category by rememberSaveable { mutableStateOf("problem") }
    var message by rememberSaveable { mutableStateOf("") }
    var images by rememberSaveable { mutableStateOf(emptyList<String>()) }
    var requestId by rememberSaveable { mutableStateOf(UUID.randomUUID().toString()) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    var sent by rememberSaveable { mutableStateOf(false) }
    fun changed() { requestId = UUID.randomUUID().toString(); error = null }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_FEEDBACK_IMAGES)) { picked ->
        if (picked.isNotEmpty()) { images = (images + picked.map { it.toString() }).distinct().take(MAX_FEEDBACK_IMAGES); changed() }
    }
    Dialog(onDismissRequest = { if (!sending) close() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize().imePadding(), color = MaterialTheme.colorScheme.surface) {
            Scaffold(topBar = {
                TopAppBar(title = { Text("问题反馈", fontWeight = FontWeight.SemiBold) }, navigationIcon = {
                    IconButton(onClick = close, enabled = !sending) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回设置") }
                })
            }, bottomBar = {
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Button(onClick = {
                        val id = requestId
                        val selected = images.map(android.net.Uri::parse)
                        sending = true; error = null
                        scope.launch {
                            try { FeedbackClient.submit(context, id, category, message, selected); sent = true }
                            catch (e: Exception) { error = e.message?.takeIf { it.length < 100 } ?: "提交未成功，请稍后重试" }
                            finally { sending = false }
                        }
                    }, enabled = !sending && !sent && validFeedback(message, images.size),
                        modifier = Modifier.widthIn(max = 600.dp).fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) {
                        if (sending) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                            Spacer(Modifier.width(8.dp)); Text("正在提交…", style = MaterialTheme.typography.titleSmall)
                        }
                        else Text("提交反馈", style = MaterialTheme.typography.titleSmall)
                    }
                }
            }) { insets ->
                Column(Modifier.fillMaxSize().padding(insets).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("告诉我们你的想法", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                        Text("反馈会发送至 khsci.vip，供我们查看，不属于端到端加密聊天。", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("反馈类型", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("problem" to "遇到问题", "suggestion" to "功能建议", "other" to "其他").forEach { (value, label) ->
                                FilterChip(selected = category == value, onClick = { category = value; changed() },
                                    label = { Text(label) }, enabled = !sending && !sent,
                                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.13f),
                                        selectedLabelColor = MaterialTheme.colorScheme.primary))
                            }
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("具体内容", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        OutlinedTextField(value = message, onValueChange = { if (it.length <= MAX_FEEDBACK_TEXT) { message = it; changed() } },
                            modifier = Modifier.fillMaxWidth(), enabled = !sending && !sent, minLines = 5, maxLines = 9,
                            placeholder = { Text("可以描述操作步骤、遇到的情况，或你希望增加的功能") },
                            supportingText = { Text("${message.length}/$MAX_FEEDBACK_TEXT", Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.End) },
                            shape = RoundedCornerShape(16.dp))
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("添加图片", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Text("${images.size}/$MAX_FEEDBACK_IMAGES", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text("截图可以帮助我们更快理解问题。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            itemsIndexed(images) { index, image ->
                                Box(Modifier.size(88.dp).clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
                                    AsyncImage(model = android.net.Uri.parse(image), contentDescription = "所选图片 ${index + 1}", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                                    IconButton(onClick = { images = images.filterIndexed { i, _ -> i != index }; changed() },
                                        enabled = !sending && !sent, modifier = Modifier.align(Alignment.TopEnd).size(32.dp).background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f), RoundedCornerShape(bottomStart = 12.dp))) {
                                        Icon(Icons.Default.Close, "移除图片 ${index + 1}", Modifier.size(18.dp))
                                    }
                                }
                            }
                            if (images.size < MAX_FEEDBACK_IMAGES) item {
                                OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                                    enabled = !sending && !sent, modifier = Modifier.size(88.dp), shape = RoundedCornerShape(14.dp),
                                    contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp)) {
                                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                        Icon(Icons.Default.AddPhotoAlternate, null, Modifier.size(23.dp)); Text("选择图片", style = MaterialTheme.typography.labelSmall)
                                    }
                                }
                            }
                        }
                    }
                    Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                        Text("反馈文字、所选图片和应用版本将发送至 khsci.vip，供我们查看；这些内容不属于端到端加密的聊天。图片会压缩并移除原始位置信息，请不要提交密码或密钥。",
                            Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
    }
    if (sent) AlertDialog(onDismissRequest = close, icon = { Icon(Icons.Default.CheckCircle, null, tint = MaterialTheme.colorScheme.primary) },
        title = { Text("反馈已收到") }, text = { Text("感谢你的反馈，我们会查看并评估。") },
        confirmButton = { TextButton(close) { Text("完成") } })
}
