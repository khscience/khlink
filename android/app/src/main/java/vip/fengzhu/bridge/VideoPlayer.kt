package vip.fengzhu.bridge

import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.view.Surface
import android.view.TextureView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Where each video was left, so the conversation's player and the full-screen
 * one pick up from each other instead of starting over (in memory only).
 */
object VideoPositions {
    private val positions = ConcurrentHashMap<String, Long>()
    fun of(file: File): Long = positions[file.absolutePath] ?: 0L
    fun set(file: File, ms: Long) { positions[file.absolutePath] = ms.coerceAtLeast(0L) }
}

/** "1:05", or "1:02:05" past an hour. */
fun formatVideoTime(ms: Long): String {
    val total = (ms.coerceAtLeast(0L) + 500) / 1000
    val h = total / 3600; val m = (total % 3600) / 60; val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/**
 * A video with the controls a phone player has: tap shows or hides them, the
 * middle button plays and pauses (replays at the end), the bar shows the time
 * and seeks by dragging, and [onFullscreen] adds a full-screen button. They
 * hide by themselves while playing. [suspended] pauses it (another player of
 * the same video is open); it resumes where that one stopped, paused.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun KhVideoPlayer(
    file: File,
    modifier: Modifier = Modifier,
    autoPlay: Boolean = true,
    suspended: Boolean = false,
    onFullscreen: (() -> Unit)? = null,
    onAspect: (Float) -> Unit = {},
    onFailed: () -> Unit = {},
) {
    var player by remember(file) { mutableStateOf<MediaPlayer?>(null) }
    var prepared by remember(file) { mutableStateOf(false) }
    var playing by remember(file) { mutableStateOf(false) }
    var ended by remember(file) { mutableStateOf(false) }
    var duration by remember(file) { mutableLongStateOf(0L) }
    var position by remember(file) { mutableLongStateOf(VideoPositions.of(file)) }
    var dragging by remember(file) { mutableStateOf<Float?>(null) }
    var controls by remember(file) { mutableStateOf(true) }
    var aspect by remember(file) { mutableFloatStateOf(16f / 9f) }
    // Taps restart the hide timer.
    var touchedAt by remember(file) { mutableLongStateOf(0L) }

    fun play() {
        val p = player ?: return
        if (!prepared) return
        if (ended) { runCatching { p.seekTo(0) }; position = 0; ended = false }
        runCatching { p.start() }.onSuccess { playing = true; touchedAt = System.currentTimeMillis() }
    }
    fun pause() {
        val p = player ?: return
        runCatching { if (p.isPlaying) p.pause() }
        playing = false
        runCatching { position = p.currentPosition.toLong(); VideoPositions.set(file, position) }
    }

    LaunchedEffect(playing, controls, touchedAt) { if (playing && controls) { delay(2_800); controls = false } }
    LaunchedEffect(player, playing) {
        while (playing) {
            val p = player ?: break
            runCatching { if (dragging == null) { position = p.currentPosition.toLong(); VideoPositions.set(file, position) } }
            delay(200)
        }
    }
    // Another player of this video took over: stop here, then continue from where it stopped.
    LaunchedEffect(suspended, prepared) {
        if (!prepared) return@LaunchedEffect
        if (suspended) { pause(); controls = true }
        else {
            val at = VideoPositions.of(file)
            if (at != position) runCatching { player?.seekTo(at.toInt()); position = at }
        }
    }
    DisposableEffect(file) { onDispose { player?.let { runCatching { VideoPositions.set(file, it.currentPosition.toLong()) } } } }

    BoxWithConstraints(
        modifier.background(Color.Black)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { controls = !controls; touchedAt = System.currentTimeMillis() },
        contentAlignment = Alignment.Center,
    ) {
        val containerAspect = if (maxHeight.value > 0f) maxWidth.value / maxHeight.value else aspect
        val videoModifier = if (aspect >= containerAspect) Modifier.fillMaxWidth().aspectRatio(aspect) else Modifier.fillMaxHeight().aspectRatio(aspect)
        // TextureView composites into the Compose dialog (unlike VideoView's
        // SurfaceView, which can stay behind the dialog and render black).
        AndroidView(
            factory = { context ->
                TextureView(context).apply {
                    val media = MediaPlayer()
                    tag = media
                    player = media
                    media.setOnPreparedListener { ready ->
                        if (ready.videoWidth > 0 && ready.videoHeight > 0) { aspect = ready.videoWidth.toFloat() / ready.videoHeight; onAspect(aspect) }
                        duration = ready.duration.toLong().coerceAtLeast(0L)
                        val start = VideoPositions.of(file).takeIf { it in 1 until duration - 500 } ?: 0L
                        if (start > 0) ready.seekTo(start.toInt())
                        position = start
                        prepared = true
                        if (autoPlay && !suspended) { ready.start(); playing = true; touchedAt = System.currentTimeMillis() }
                        else ready.seekTo(start.toInt()) // shows the first frame
                    }
                    media.setOnCompletionListener { playing = false; ended = true; controls = true; position = duration; VideoPositions.set(file, 0L) }
                    media.setOnErrorListener { _, _, _ -> onFailed(); true }
                    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                        override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
                            runCatching {
                                media.setSurface(Surface(surfaceTexture))
                                media.setDataSource(file.absolutePath)
                                media.prepareAsync()
                            }.onFailure { onFailed() }
                        }
                        override fun onSurfaceTextureSizeChanged(surfaceTexture: SurfaceTexture, width: Int, height: Int) = Unit
                        override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
                            runCatching { VideoPositions.set(file, media.currentPosition.toLong()); media.release() }
                            tag = null; player = null; prepared = false; playing = false
                            return true
                        }
                        override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) = Unit
                    }
                }
            },
            modifier = videoModifier,
            onRelease = { view -> (view.tag as? MediaPlayer)?.let { runCatching { it.release() } } },
        )
        val shown = controls || !playing
        AnimatedVisibility(shown && prepared, enter = fadeIn(tween(150)), exit = fadeOut(tween(220))) {
            Box(
                Modifier.size(64.dp).background(Color.Black.copy(alpha = 0.45f), CircleShape)
                    .clickable { if (playing) pause() else play(); controls = true; touchedAt = System.currentTimeMillis() }
                    .semantics { contentDescription = if (playing) "暂停" else if (ended) "重新播放" else "播放" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (playing) Icons.Default.Pause else if (ended) Icons.Default.Replay else Icons.Default.PlayArrow, null, Modifier.size(38.dp), tint = Color.White)
            }
        }
        AnimatedVisibility(shown && prepared, Modifier.align(Alignment.BottomCenter), enter = fadeIn(tween(150)), exit = fadeOut(tween(220))) {
            Row(
                Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.6f))))
                    .padding(start = 10.dp, end = if (onFullscreen != null) 0.dp else 10.dp, top = 14.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val shownPosition = dragging?.let { (it * duration).toLong() } ?: position
                Text(formatVideoTime(shownPosition), color = Color.White, fontSize = 11.sp)
                Spacer(Modifier.width(6.dp))
                Slider(
                    value = if (duration > 0) (dragging ?: (position.toFloat() / duration)).coerceIn(0f, 1f) else 0f,
                    onValueChange = { dragging = it; controls = true; touchedAt = System.currentTimeMillis() },
                    onValueChangeFinished = {
                        val target = ((dragging ?: 0f) * duration).toLong()
                        runCatching { player?.seekTo(target.toInt()) }
                        position = target; VideoPositions.set(file, target); ended = false; dragging = null
                    },
                    modifier = Modifier.weight(1f).height(32.dp).semantics { contentDescription = "播放进度" },
                    // A thin line and a small dot, as video players draw it.
                    thumb = { Box(Modifier.size(12.dp).background(Color.White, CircleShape)) },
                    track = { state ->
                        val fraction = ((state.value - state.valueRange.start) / (state.valueRange.endInclusive - state.valueRange.start)).coerceIn(0f, 1f)
                        androidx.compose.foundation.Canvas(Modifier.fillMaxWidth().height(3.dp)) {
                            val y = size.height / 2
                            drawLine(Color.White.copy(alpha = 0.35f), androidx.compose.ui.geometry.Offset(0f, y), androidx.compose.ui.geometry.Offset(size.width, y), size.height, androidx.compose.ui.graphics.StrokeCap.Round)
                            drawLine(Color.White, androidx.compose.ui.geometry.Offset(0f, y), androidx.compose.ui.geometry.Offset(size.width * fraction, y), size.height, androidx.compose.ui.graphics.StrokeCap.Round)
                        }
                    },
                )
                Spacer(Modifier.width(6.dp))
                Text(formatVideoTime(duration), color = Color.White.copy(alpha = 0.85f), fontSize = 11.sp)
                onFullscreen?.let { open ->
                    Box(
                        Modifier.size(40.dp).clickable { pause(); open() }.semantics { contentDescription = "全屏播放" },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Default.Fullscreen, null, Modifier.size(22.dp), tint = Color.White) }
                }
            }
        }
    }
}
