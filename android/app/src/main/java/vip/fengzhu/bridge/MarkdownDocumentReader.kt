package vip.fengzhu.bridge

import android.content.Context
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.isUnspecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.ImageLoader
import coil.compose.AsyncImagePainter
import coil.compose.rememberAsyncImagePainter
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import coil.decode.SvgDecoder
import coil.request.ImageRequest
import com.mikepenz.markdown.model.ImageData
import com.mikepenz.markdown.model.ImageTransformer
import com.mikepenz.markdown.model.PlaceholderConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.ResponseBody
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

internal enum class MarkdownReaderTheme(val title: String, val description: String) {
    FOLLOW_APP("跟随应用", "使用 khLink 当前的界面颜色"),
    PAPER("素白", "干净明亮，适合阅读技术文档"),
    WARM("暖纸", "暖色纸面，适合长文阅读"),
    NIGHT("夜间", "深色背景，适合暗光环境");

    companion object {
        fun fromId(value: String?): MarkdownReaderTheme = entries.firstOrNull { it.name == value } ?: FOLLOW_APP
    }
}

internal data class MarkdownReaderStyle(
    val paper: Color,
    val ink: Color,
    val muted: Color,
    val accent: Color,
    val code: Color,
    val table: Color,
    val divider: Color,
    val font: FontFamily,
)

internal val LocalMarkdownReaderStyle = staticCompositionLocalOf<MarkdownReaderStyle?> { null }

internal data class MarkdownReaderConfig(
    val view: ComputerFileView,
    val vm: BridgeViewModel,
    val style: MarkdownReaderStyle,
    val images: MarkdownDocumentImageTransformer,
)

@Composable
internal fun markdownReaderStyle(theme: MarkdownReaderTheme): MarkdownReaderStyle = when (theme) {
    MarkdownReaderTheme.FOLLOW_APP -> KhThemeState.current.palette.let {
        MarkdownReaderStyle(it.paper, it.ink, it.muted, it.accent, it.codeBlock, it.surfaceAlt, it.divider, FontFamily.SansSerif)
    }
    MarkdownReaderTheme.PAPER -> MarkdownReaderStyle(Color(0xFFFFFFFF), Color(0xFF202733), Color(0xFF677282), Color(0xFF285DA8), Color(0xFFF2F4F7), Color(0xFFF4F6F8), Color(0xFFDCE1E7), FontFamily.SansSerif)
    MarkdownReaderTheme.WARM -> MarkdownReaderStyle(Color(0xFFF8F2E5), Color(0xFF342E26), Color(0xFF746A59), Color(0xFF875629), Color(0xFFEDE4D3), Color(0xFFF0E7D7), Color(0xFFD8CEBD), FontFamily.Serif)
    MarkdownReaderTheme.NIGHT -> MarkdownReaderStyle(Color(0xFF181C23), Color(0xFFE6EAF0), Color(0xFFA8B2BF), Color(0xFF92BEFF), Color(0xFF292F39), Color(0xFF252C36), Color(0xFF46505E), FontFamily.SansSerif)
}

private sealed interface MarkdownImageLoad {
    data object Loading : MarkdownImageLoad
    data class Ready(val data: Any) : MarkdownImageLoad
    data class Failed(val reason: String) : MarkdownImageLoad
}

/** A compact, accessible placeholder instead of an empty block on errors. */
private class MarkdownImageNoticePainter(private val label: String, private val dark: Boolean) : Painter() {
    override val intrinsicSize: Size = Size(700f, 140f)
    override fun DrawScope.onDraw() {
        drawRoundRect(if (dark) Color(0xFF303945) else Color(0xFFECEFF3), cornerRadius = androidx.compose.ui.geometry.CornerRadius(8f))
        drawIntoCanvas { canvas ->
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                color = if (dark) android.graphics.Color.LTGRAY else android.graphics.Color.DKGRAY
                textSize = size.height * 0.34f
            }
            canvas.nativeCanvas.drawText(label, size.height * 0.18f, size.height * 0.63f, paint)
        }
    }
}

/** Limit both advertised and streamed HTTP bodies, including chunked responses. */
private fun markdownImageHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .callTimeout(35, TimeUnit.SECONDS)
    .addInterceptor { chain ->
        val response = chain.proceed(chain.request())
        val original = response.body ?: return@addInterceptor response
        if (original.contentLength() > MAX_MARKDOWN_IMAGE_BYTES) {
            response.close()
            throw IOException("图片过大")
        }
        val bounded = object : ResponseBody() {
            override fun contentType(): MediaType? = original.contentType()
            override fun contentLength(): Long = original.contentLength()
            private val limitedSource: BufferedSource = object : ForwardingSource(original.source()) {
                private var received = 0L
                override fun read(sink: okio.Buffer, byteCount: Long): Long {
                    val count = super.read(sink, byteCount)
                    if (count > 0) {
                        received += count
                        if (received > MAX_MARKDOWN_IMAGE_BYTES) throw IOException("图片过大")
                    }
                    return count
                }
            }.buffer()
            override fun source(): BufferedSource = limitedSource
        }
        response.newBuilder().body(bounded).build()
    }.build()

/** One cache per app process; switching documents or themes must not create competing disk caches. */
private object MarkdownImageLoader {
    @Volatile private var instance: ImageLoader? = null

    fun get(context: Context): ImageLoader = instance ?: synchronized(this) {
        instance ?: ImageLoader.Builder(context.applicationContext)
            .okHttpClient(markdownImageHttpClient())
            .components {
                if (Build.VERSION.SDK_INT >= 28) add(ImageDecoderDecoder.Factory()) else add(GifDecoder.Factory())
                add(SvgDecoder.Factory())
            }
            .build().also { instance = it }
    }
}

/** Image source is scoped to the computer which supplied this document. */
internal class MarkdownDocumentImageTransformer(
    context: Context,
    private val vm: BridgeViewModel,
    private val view: ComputerFileView,
    private val dark: Boolean,
) : ImageTransformer {
    private val appContext = context.applicationContext
    private val localSlots = Semaphore(3)
    private val imageLoader = MarkdownImageLoader.get(appContext)

    @Composable
    override fun transform(link: String): ImageData {
        var retry by remember(link) { mutableIntStateOf(0) }
        var preview by remember(link) { mutableStateOf(false) }
        val result by produceState<MarkdownImageLoad>(MarkdownImageLoad.Loading, link, retry, view.file, view.threadId) {
            value = try {
                when (val source = markdownImageSource(link, view.path)) {
                    is MarkdownImageSource.Computer -> MarkdownImageLoad.Ready(localSlots.withPermit { vm.loadMarkdownImage(view.file, source.path, view.threadId) })
                    is MarkdownImageSource.Web -> MarkdownImageLoad.Ready(source.url)
                    null -> MarkdownImageLoad.Failed("图片地址不可用")
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val reason = error.message.orEmpty()
                MarkdownImageLoad.Failed(when {
                    reason.contains("切回文档所属电脑") -> "请切回原电脑"
                    reason.contains("文档来源无法确认") -> "请重新取回文档"
                    reason.contains("过大") -> "图片过大"
                    else -> "图片无法加载"
                })
            }
        }
        val data = (result as? MarkdownImageLoad.Ready)?.data
        val request = remember(data, retry) { ImageRequest.Builder(appContext).data(data).size(2048).build() }
        val painter = rememberAsyncImagePainter(model = request, imageLoader = imageLoader)
        val loading = result is MarkdownImageLoad.Loading || (data != null && painter.state is AsyncImagePainter.State.Loading)
        val failure = result is MarkdownImageLoad.Failed || (data != null && painter.state is AsyncImagePainter.State.Error)
        val reason = (result as? MarkdownImageLoad.Failed)?.reason ?: "图片加载失败"
        val shown = if (loading || failure || data == null) remember(loading, failure, reason, dark) {
            MarkdownImageNoticePainter(if (loading) "正在加载图片…" else "$reason，点按重试", dark)
        } else painter

        if (preview && data != null && !loading && !failure) {
            Dialog(onDismissRequest = { preview = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
                var scale by remember { mutableFloatStateOf(1f) }
                var offset by remember { mutableStateOf(Offset.Zero) }
                Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
                    Image(painter, "文档图片", Modifier.fillMaxSize().pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 6f)
                            offset = if (scale == 1f) Offset.Zero else offset + pan
                        }
                    }.graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y }, contentScale = ContentScale.Fit)
                    IconButton({ preview = false }, Modifier.align(Alignment.TopEnd).padding(8.dp)) { Icon(Icons.Default.Close, "关闭图片", tint = Color.White) }
                }
            }
        }
        return ImageData(
            painter = shown,
            modifier = Modifier.fillMaxWidth().clickable(enabled = !loading) { if (failure) retry++ else preview = true },
            contentDescription = if (loading) "正在加载文档图片" else if (failure) "$reason，点击重试" else "文档图片，点击放大",
            contentScale = ContentScale.Fit,
        )
    }

    override fun placeholderConfig(density: Density, containerSize: Size, intrinsicImageSize: Size): PlaceholderConfig = with(density) {
        if (containerSize.isUnspecified || intrinsicImageSize.isUnspecified || intrinsicImageSize.width <= 0 || intrinsicImageSize.height <= 0) {
            return@with PlaceholderConfig(Size(180f, 48f))
        }
        val scale = minOf(1f, containerSize.width / intrinsicImageSize.width, 520.dp.toPx() / intrinsicImageSize.height)
        PlaceholderConfig(Size((intrinsicImageSize.width * scale).toSp().value, (intrinsicImageSize.height * scale).toSp().value))
    }
}
