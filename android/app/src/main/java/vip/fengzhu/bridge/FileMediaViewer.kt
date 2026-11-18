package vip.fengzhu.bridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File

/** Audio is scoped to this viewer, pauses in background, and releases audio focus. */
@Composable
internal fun AudioBody(file: File, saving: Boolean, save: () -> Unit, openElsewhere: () -> Unit) {
    val palette = KhThemeState.current.palette
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var player by remember(file) { mutableStateOf<MediaPlayer?>(null) }
    var ready by remember(file) { mutableStateOf(false) }
    var playing by remember(file) { mutableStateOf(false) }
    var ended by remember(file) { mutableStateOf(false) }
    var failed by remember(file) { mutableStateOf(false) }
    var duration by remember(file) { mutableLongStateOf(0) }
    var position by remember(file) { mutableLongStateOf(0) }
    var dragging by remember(file) { mutableStateOf<Float?>(null) }
    var focus by remember(file) { mutableStateOf<ViewerAudioFocus?>(null) }

    fun pause() {
        player?.let { media -> runCatching { if (media.isPlaying) media.pause(); position = media.currentPosition.toLong() } }
        playing = false
        focus?.abandon()
    }
    fun play() {
        val media = player ?: return
        if (!ready || focus?.request() != true) return
        runCatching {
            if (ended) { media.seekTo(0); position = 0; ended = false }
            media.start(); playing = true
        }.onFailure { failed = true; focus?.abandon() }
    }

    DisposableEffect(file, lifecycle) {
        val media = MediaPlayer()
        val audioFocus = ViewerAudioFocus(context) {
            runCatching { if (media.isPlaying) media.pause() }
            playing = false
        }
        player = media; focus = audioFocus
        media.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        media.setOnPreparedListener {
            duration = it.duration.toLong().coerceAtLeast(0)
            ready = true
            if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) play()
        }
        media.setOnCompletionListener { playing = false; ended = true; position = duration; audioFocus.abandon() }
        media.setOnErrorListener { _, _, _ -> failed = true; playing = false; audioFocus.abandon(); true }
        runCatching { media.setDataSource(file.absolutePath); media.prepareAsync() }.onFailure { failed = true }
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) pause() }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            audioFocus.abandon()
            runCatching { media.release() }
            player = null; focus = null
        }
    }
    LaunchedEffect(playing, file) {
        while (playing) {
            if (dragging == null) runCatching { position = player?.currentPosition?.toLong() ?: position }
            delay(250)
        }
    }
    if (failed) {
        MediaErrorBody(file, "这段音频无法播放，可尝试使用其他应用打开。", saving, save, openElsewhere)
        return
    }
    Column(Modifier.fillMaxSize().background(palette.surface).padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(148.dp).background(palette.accent.copy(alpha = 0.10f), RoundedCornerShape(38.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.MusicNote, null, Modifier.size(70.dp), tint = palette.accent)
        }
        Spacer(Modifier.height(28.dp))
        Text(file.name, color = palette.ink, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(6.dp))
        Text("本机音频 · ${imageSizeLabel(file.length())}", color = palette.muted, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(30.dp))
        Slider(value = if (duration > 0) (dragging ?: position.toFloat() / duration).coerceIn(0f, 1f) else 0f,
            onValueChange = { dragging = it }, onValueChangeFinished = {
                val target = ((dragging ?: 0f) * duration).toLong()
                runCatching { player?.seekTo(target.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()) }
                position = target; ended = false; dragging = null
            }, enabled = ready && duration > 0,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "音频播放进度" })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatVideoTime(dragging?.let { (it * duration).toLong() } ?: position), color = palette.muted, style = MaterialTheme.typography.labelMedium)
            Text(formatVideoTime(duration), color = palette.muted, style = MaterialTheme.typography.labelMedium)
        }
        Spacer(Modifier.height(20.dp))
        if (!ready) CircularProgressIndicator(Modifier.size(36.dp), color = palette.accent)
        else FilledIconButton(onClick = { if (playing) pause() else play() }, modifier = Modifier.size(64.dp), shape = CircleShape) {
            Icon(if (playing) Icons.Default.Pause else if (ended) Icons.Default.Replay else Icons.Default.PlayArrow,
                if (playing) "暂停音频" else if (ended) "重新播放音频" else "播放音频", Modifier.size(34.dp))
        }
    }
}

private class ViewerAudioFocus(context: Context, private val onLoss: () -> Unit) {
    private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) onLoss()
    }
    private val request = if (Build.VERSION.SDK_INT >= 26) AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        .setOnAudioFocusChangeListener(listener).build() else null
    @Suppress("DEPRECATION")
    fun request(): Boolean = (if (Build.VERSION.SDK_INT >= 26) manager.requestAudioFocus(requireNotNull(request))
        else manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    @Suppress("DEPRECATION")
    fun abandon() { if (Build.VERSION.SDK_INT >= 26) request?.let(manager::abandonAudioFocusRequest) else manager.abandonAudioFocus(listener) }
}

/** Renders only visible pages and keeps each bitmap bounded for large PDFs. */
@Composable
internal fun PdfBody(file: File, saving: Boolean, save: () -> Unit, openElsewhere: () -> Unit) {
    val palette = KhThemeState.current.palette
    var renderer by remember(file) { mutableStateOf<PdfRenderer?>(null) }
    var failed by remember(file) { mutableStateOf(false) }
    DisposableEffect(file) {
        val opened = runCatching {
            val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            try { PdfRenderer(descriptor) } catch (e: Exception) { descriptor.close(); throw e }
        }
        renderer = opened.getOrNull()
        failed = opened.isFailure
        onDispose { renderer = null; opened.getOrNull()?.let { pdf -> runCatching { synchronized(pdf) { pdf.close() } } } }
    }
    val pdf = renderer
    if (failed) {
        MediaErrorBody(file, "这个 PDF 无法预览，可能已损坏或需要密码。", saving, save, openElsewhere)
    } else if (pdf == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = palette.accent) }
    } else {
        LazyColumn(Modifier.fillMaxSize().background(palette.surfaceAlt).padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Spacer(Modifier.height(2.dp)) }
            items(pdf.pageCount, key = { it }) { index -> PdfPage(pdf, index) }
            item { Spacer(Modifier.height(2.dp)) }
        }
    }
}

@Composable
private fun PdfPage(pdf: PdfRenderer, index: Int) {
    val rendered by produceState<Result<Bitmap>?>(null, pdf, index) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                synchronized(pdf) {
                    pdf.openPage(index).use { page ->
                        val scale = minOf(1400f / page.width.coerceAtLeast(1), 2200f / page.height.coerceAtLeast(1))
                        val width = (page.width * scale).toInt().coerceAtLeast(1)
                        val height = (page.height * scale).toInt().coerceAtLeast(1)
                        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        try {
                            bitmap.eraseColor(AndroidColor.WHITE)
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            bitmap
                        } catch (error: Exception) { bitmap.recycle(); throw error }
                    }
                }
            }
        }
    }
    val image = rendered?.getOrNull()
    DisposableEffect(image) { onDispose { image?.recycle() } }
    when {
        image != null -> Image(image.asImageBitmap(), "第 ${index + 1} 页", Modifier.fillMaxWidth())
        rendered?.isFailure == true -> Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) { Text("第 ${index + 1} 页无法预览") }
        else -> Box(Modifier.fillMaxWidth().height(220.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
    }
}
