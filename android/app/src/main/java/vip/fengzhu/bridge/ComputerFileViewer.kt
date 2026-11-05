package vip.fengzhu.bridge

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.net.Uri
import android.util.Base64
import android.view.Surface
import android.view.TextureView
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image as ComposeImage
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AudioFile
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.FolderZip
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.foundation.clickable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

// Colors come from the chosen theme, as in MainActivity.
private val ViewerPalette: KhPalette get() = KhThemeState.current.palette

/** The most of a text file the viewer reads (a preview; the whole file can still be saved). */
private const val VIEWER_TEXT_LIMIT = 2L * 1024 * 1024

private class ViewerText(val text: String, val truncated: Boolean)

/**
 * A computer file fetched to the phone, shown inside KH Link: Markdown is
 * rendered, HTML is shown as a page, both with their source a tap away;
 * other text shows as source. Anything can be saved to the phone's
 * Download folder or handed to another app (a video player, for example).
 */
@Composable
internal fun ComputerFileViewer(vm: BridgeViewModel) {
    val view by vm.computerFileView.collectAsState()
    val current = view ?: return
    val saving by vm.savingFile.collectAsState()
    val kind = remember(current.file) { computerFileKind(current.file.name) }
    var source by rememberSaveable(current.path) { mutableStateOf(false) }
    val content by produceState<ViewerText?>(null, current.file) {
        value = if (kind == ComputerFileKind.MARKDOWN || kind == ComputerFileKind.HTML || kind == ComputerFileKind.TEXT) {
            withContext(Dispatchers.IO) { readViewerText(current.file) }
        } else null
    }
    Dialog(onDismissRequest = vm::closeComputerFileView, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = ViewerPalette.paper) {
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(current.file.name, color = ViewerPalette.ink, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(current.path, color = ViewerPalette.muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton({ vm.saveToDownloads(current.file) }, enabled = !saving) {
                        if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = ViewerPalette.accent)
                        else Icon(Icons.Default.Download, "保存到手机", tint = ViewerPalette.ink)
                    }
                    IconButton({ vm.openWithOtherApp(current.file) }) { Icon(Icons.Default.OpenInNew, "用其他应用打开", tint = ViewerPalette.ink) }
                    IconButton(vm::closeComputerFileView) { Icon(Icons.Default.Close, "关闭", tint = ViewerPalette.ink) }
                }
                if (kind == ComputerFileKind.MARKDOWN || kind == ComputerFileKind.HTML) {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                        SegmentedButton(!source, { source = false }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("预览") }
                        SegmentedButton(source, { source = true }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("源码") }
                    }
                }
                HorizontalDivider(color = ViewerPalette.divider)
                Box(Modifier.fillMaxSize().weight(1f)) {
                    val text = content
                    when {
                        kind == ComputerFileKind.OTHER -> OtherFileBody(current.file, saving, { vm.saveToDownloads(current.file) }, { vm.openWithOtherApp(current.file) }, { vm.installApk(current.file) })
                        kind == ComputerFileKind.IMAGE && current.file.extension.equals("svg", true) -> SvgBody(current.file, saving, { vm.saveToDownloads(current.file) }, { vm.openWithOtherApp(current.file) })
                        kind == ComputerFileKind.IMAGE -> ImageBody(current.file, saving, { vm.saveToDownloads(current.file) }, { vm.openWithOtherApp(current.file) })
                        kind == ComputerFileKind.VIDEO -> VideoBody(current.file, saving, { vm.saveToDownloads(current.file) }, { vm.openWithOtherApp(current.file) })
                        text == null -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = ViewerPalette.accent)
                        source || kind == ComputerFileKind.TEXT -> SourceBody(text)
                        kind == ComputerFileKind.MARKDOWN -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                            if (text.truncated) TruncatedNote()
                            SelectionContainer { KhLinkMarkdown(text.text) }
                        }
                        else -> HtmlBody(text.text)
                    }
                }
            }
        }
    }
}

private fun readViewerText(file: File): ViewerText {
    val length = file.length()
    val bytes = file.inputStream().use { input -> ByteArray(minOf(length, VIEWER_TEXT_LIMIT).toInt()).also { var read = 0; while (read < it.size) { val n = input.read(it, read, it.size - read); if (n < 0) break; read += n } } }
    // A UTF-8 byte-order mark would show up as a stray character.
    val start = if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) 3 else 0
    return ViewerText(String(bytes, start, bytes.size - start, Charsets.UTF_8), length > VIEWER_TEXT_LIMIT)
}

@Composable
private fun TruncatedNote() {
    Text("文件较大，这里只显示前 2 MB；完整内容可以保存到手机后查看。", color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 8.dp))
}

@Composable
private fun SourceBody(text: ViewerText) {
    val lines = remember(text) { text.text.split('\n') }
    SelectionContainer {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
            if (text.truncated) item { TruncatedNote() }
            itemsIndexed(lines) { index, line ->
                Row {
                    Text("${index + 1}", Modifier.width(40.dp).padding(end = 8.dp), color = ViewerPalette.muted, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    Text(line.trimEnd('\r'), color = ViewerPalette.ink, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

/**
 * The page in a plain WebView: no access to the phone's files or to the
 * app, links out of the page open in the browser.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun HtmlBody(html: String) {
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.builtInZoomControls = true
                settings.displayZoomControls = false
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url
                        if (request.isForMainFrame && (url.scheme == "http" || url.scheme == "https")) {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        }
                        return true
                    }
                }
            }
        },
        update = { web -> if (web.tag != html) { web.tag = html; web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null) } },
        onRelease = { it.destroy() },
        modifier = Modifier.fillMaxSize(),
    )
}

@Composable
private fun ImageBody(file: File, saving: Boolean, save: () -> Unit, openElsewhere: () -> Unit) {
    var failed by remember(file) { mutableStateOf(false) }
    val bitmap by produceState<Bitmap?>(null, file) {
        value = withContext(Dispatchers.IO) { decodeViewerBitmap(file) }
        if (value == null) failed = true
    }
    val image = bitmap
    when {
        image != null -> {
            var scale by remember(file) { mutableFloatStateOf(1f) }
            var offset by remember(file) { mutableStateOf(Offset.Zero) }
            Box(
                Modifier.fillMaxSize().background(Color.Black)
                    .pointerInput(file) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 6f)
                            offset += pan
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                ComposeImage(
                    image.asImageBitmap(),
                    file.name,
                    Modifier.fillMaxSize().graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
                    contentScale = ContentScale.Fit,
                )
            }
        }
        failed -> MediaErrorBody(file, "无法解码这张图片（格式可能不受手机支持）。", saving, save, openElsewhere)
        else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = ViewerPalette.accent)
        }
    }
}

@Composable
private fun SvgBody(file: File, saving: Boolean, save: () -> Unit, openElsewhere: () -> Unit) {
    val html = remember(file) {
        runCatching {
            val encoded = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
            "<html><body style='margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100%'>" +
                "<img style='max-width:100%;max-height:100%' src='data:image/svg+xml;base64,$encoded'></body></html>"
        }.getOrNull()
    }
    if (html == null) {
        MediaErrorBody(file, "无法读取这张 SVG 图片。", saving, save, openElsewhere)
    } else {
        AndroidView(
            factory = { context ->
                WebView(context).apply {
                    setBackgroundColor(android.graphics.Color.BLACK)
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    settings.builtInZoomControls = true
                    settings.displayZoomControls = false
                    loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
                }
            },
            modifier = Modifier.fillMaxSize(),
            onRelease = { it.destroy() },
        )
    }
}

/**
 * H.264 High 4:4:4 (yuv444p, what ffmpeg makes from PNG frames unless told
 * otherwise): most phone decoders play it with wrong colors, mostly green.
 */
internal fun isAvc444(file: File): Boolean = runCatching {
    val extractor = android.media.MediaExtractor()
    try {
        extractor.setDataSource(file.absolutePath)
        (0 until extractor.trackCount).any { index ->
            val format = extractor.getTrackFormat(index)
            format.getString(android.media.MediaFormat.KEY_MIME) == "video/avc" &&
                format.containsKey(android.media.MediaFormat.KEY_PROFILE) &&
                format.getInteger(android.media.MediaFormat.KEY_PROFILE) == android.media.MediaCodecInfo.CodecProfileLevel.AVCProfileHigh444
        }
    } finally { extractor.release() }
}.getOrDefault(false)

@Composable
internal fun VideoBody(file: File, saving: Boolean, save: () -> Unit, openElsewhere: () -> Unit) {
    var failed by remember(file) { mutableStateOf(false) }
    val colorWarning by androidx.compose.runtime.produceState(false, file) {
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { isAvc444(file) }
    }
    if (failed) {
        MediaErrorBody(file, "这个视频的编码手机播放器不支持，可以保存后用其他播放器打开。", saving, save, openElsewhere)
    } else Box(Modifier.fillMaxSize()) {
        KhVideoPlayer(file, Modifier.fillMaxSize(), autoPlay = true, onFailed = { failed = true })
        if (colorWarning) Text(
            "4:4:4 编码，手机上会偏色；请用 yuv420p 导出",
            Modifier.align(Alignment.TopCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 8.dp, vertical = 3.dp),
            color = Color.White, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun MediaErrorBody(file: File, message: String, saving: Boolean, save: () -> Unit, openElsewhere: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(if (computerFileKind(file.name) == ComputerFileKind.VIDEO) Icons.Default.Movie else Icons.Default.Image, null, Modifier.size(48.dp), tint = ViewerPalette.muted)
        Spacer(Modifier.height(12.dp))
        Text(file.name, color = ViewerPalette.ink, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(imageSizeLabel(file.length()), color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(8.dp))
        Text(message, color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(20.dp))
        Button(save, enabled = !saving) { Text(if (saving) "正在保存…" else "保存到手机") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(openElsewhere) { Text("用其他应用打开") }
    }
}

private fun decodeViewerBitmap(file: File): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 4096) sample *= 2
    return runCatching {
        BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()
}

@Composable
private fun OtherFileBody(file: File, saving: Boolean, save: () -> Unit, openElsewhere: () -> Unit, install: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.InsertDriveFile, null, Modifier.size(48.dp), tint = ViewerPalette.muted)
        Spacer(Modifier.height(12.dp))
        Text(file.name, color = ViewerPalette.ink, fontWeight = FontWeight.SemiBold)
        Text(imageSizeLabel(file.length()), color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(8.dp))
        // An Android app package: installing it is what it was fetched for.
        if (file.extension.equals("apk", true)) {
            Text("这是一个安卓安装包，点安装交给系统安装器。", color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(20.dp))
            Button(install) { Text("安装") }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(save, enabled = !saving) { Text(if (saving) "正在保存…" else "保存到手机") }
            return@Column
        }
        Text("这类文件不能在 khLink 里预览。", color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(20.dp))
        Button(save, enabled = !saving) { Text(if (saving) "正在保存…" else "保存到手机") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(openElsewhere) { Text("用其他应用打开") }
    }
}

/** A web link straight to a video: download it to the phone or play it in the browser. */
@Composable
internal fun WebVideoDialog(vm: BridgeViewModel) {
    val state by vm.webVideo.collectAsState()
    val url = state ?: return
    val context = androidx.compose.ui.platform.LocalContext.current
    val name = remember(url) { runCatching { java.net.URLDecoder.decode(Uri.parse(url).lastPathSegment.orEmpty(), "UTF-8") }.getOrDefault(url) }
    AlertDialog(
        onDismissRequest = vm::dismissWebVideo,
        title = { Text("下载这个视频？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(name, fontWeight = FontWeight.SemiBold)
                Text(url, color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Text("下载会保存到手机的「下载/khLink」文件夹，进度显示在通知栏。", color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton({ vm.downloadWebVideo(url) }) { Text("下载到手机") } },
        dismissButton = {
            TextButton({
                vm.dismissWebVideo()
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            }) { Text("在浏览器打开") }
        },
    )
}

/**
 * Every file fetched from the computer, newest first: tap to open it in KH Link,
 * or from its menu save it to the phone, hand it to another app, fetch it again
 * (the computer's copy may have changed) or delete it. The header shows how much
 * space they take, with a way to clear them all.
 */
@Composable
internal fun FetchedFilesPage(vm: BridgeViewModel, close: () -> Unit) {
    val items by vm.fetchedFiles.collectAsState()
    var clearAll by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize(), color = ViewerPalette.paper) {
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = ViewerPalette.ink) }
                    Column(Modifier.weight(1f)) {
                        Text("电脑取回的文件", color = ViewerPalette.ink, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                        Text(if (items.isEmpty()) "还没有取回过文件" else "${items.size} 个文件 · 共 ${imageSizeLabel(items.sumOf { it.file.length() }).ifBlank { "0 KB" }}",
                            color = ViewerPalette.muted, style = MaterialTheme.typography.labelSmall)
                    }
                    if (items.isNotEmpty()) TextButton({ clearAll = true }) { Text("全部清除", color = ViewerPalette.danger) }
                }
                HorizontalDivider(color = ViewerPalette.divider)
                if (items.isEmpty()) {
                    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.InsertDriveFile, null, Modifier.size(48.dp), tint = ViewerPalette.muted)
                        Spacer(Modifier.height(12.dp))
                        Text("在对话里点电脑上的文件链接，取回后会出现在这里。", color = ViewerPalette.muted, style = MaterialTheme.typography.bodySmall)
                    }
                } else LazyColumn(Modifier.fillMaxSize()) {
                    itemsIndexed(items, key = { _, item -> item.file.absolutePath }) { index, item ->
                        if (index > 0) HorizontalDivider(Modifier.padding(start = 60.dp), color = ViewerPalette.divider)
                        FetchedFileRow(item, vm)
                    }
                }
            }
        }
    }
    if (clearAll) AlertDialog(
        onDismissRequest = { clearAll = false },
        title = { Text("清除全部取回的文件？") },
        text = { Text("只删除手机上的副本，电脑上的文件不受影响；已经保存到「下载」文件夹的也会保留。") },
        confirmButton = { TextButton({ clearAll = false; vm.clearFetchedFiles() }) { Text("全部清除", color = ViewerPalette.danger) } },
        dismissButton = { TextButton({ clearAll = false }) { Text("取消") } },
    )
}

@Composable
private fun FetchedFileRow(item: FetchedFile, vm: BridgeViewModel) {
    var menu by remember { mutableStateOf(false) }
    val time = remember(item.fetchedAt) { java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.ROOT).format(java.util.Date(item.fetchedAt)) }
    Row(
        Modifier.fillMaxWidth().clickable { vm.showFetchedFile(item) }.padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(fetchedFileIcon(item.file.name), null, Modifier.size(28.dp), tint = ViewerPalette.muted)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(item.file.name, color = ViewerPalette.ink, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${imageSizeLabel(item.file.length()).ifBlank { "0 KB" }} · $time 取回", color = ViewerPalette.muted, style = MaterialTheme.typography.labelSmall)
            Text(item.path, color = ViewerPalette.muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        }
        Box {
            IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, "更多", tint = ViewerPalette.muted) }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem({ Text("保存到手机") }, { menu = false; vm.saveToDownloads(item.file) }, leadingIcon = { Icon(Icons.Default.Download, null) })
                DropdownMenuItem({ Text("用其他应用打开") }, { menu = false; vm.openWithOtherApp(item.file) }, leadingIcon = { Icon(Icons.Default.OpenInNew, null) })
                DropdownMenuItem({ Text("重新从电脑取回") }, { menu = false; vm.openComputerFile(item.path) }, leadingIcon = { Icon(Icons.Default.Refresh, null) })
                DropdownMenuItem({ Text("删除", color = ViewerPalette.danger) }, { menu = false; vm.deleteFetchedFile(item) }, leadingIcon = { Icon(Icons.Default.Delete, null, tint = ViewerPalette.danger) })
            }
        }
    }
}

private fun fetchedFileIcon(name: String) = when (name.substringAfterLast('.', "").lowercase()) {
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic" -> Icons.Default.Image
    "mp4", "mov", "mkv", "avi", "webm", "m4v" -> Icons.Default.Movie
    "mp3", "wav", "m4a", "flac", "aac", "ogg" -> Icons.Default.AudioFile
    "zip", "rar", "7z", "gz", "tgz", "tar" -> Icons.Default.FolderZip
    else -> if (computerFileKind(name) == ComputerFileKind.OTHER) Icons.Default.InsertDriveFile else Icons.Default.Description
}
