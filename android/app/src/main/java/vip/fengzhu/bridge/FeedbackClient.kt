package vip.fengzhu.bridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit

internal const val MAX_FEEDBACK_IMAGES = 3
internal const val MAX_FEEDBACK_TEXT = 4000
internal const val MAX_FEEDBACK_IMAGE_BYTES = 1024 * 1024

internal fun validFeedback(message: String, imageCount: Int): Boolean =
    message.isNotBlank() && message.length <= MAX_FEEDBACK_TEXT && imageCount in 0..MAX_FEEDBACK_IMAGES

internal fun feedbackError(status: Int): String = when (status) {
    413 -> "图片太大，请换几张后重试"
    429 -> "提交过于频繁，请稍后再试"
    in 500..599 -> "反馈服务暂时不可用，请稍后重试"
    else -> "提交未成功，请检查内容后重试"
}

/** Only the text, selected pictures and app version leave this device. */
internal object FeedbackClient {
    private const val ENDPOINT = "https://khsci.vip/khlink-feedback/v1/feedback"
    private val client = OkHttpClient.Builder().dns(FallbackDns()).connectTimeout(15, TimeUnit.SECONDS)
        .callTimeout(90, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()

    suspend fun submit(context: Context, id: String, category: String, message: String, uris: List<Uri>): String = withContext(Dispatchers.IO) {
        require(validFeedback(message, uris.size)) { "请填写反馈内容，最多选择三张图片" }
        val images = JSONArray()
        for (uri in uris) {
            val bytes = try { jpegWithoutMetadata(context, uri) } catch (e: Exception) {
                throw IOException(if (e.message == "图片过大") "图片过大，请换一张后重试" else "图片无法读取，请重新选择")
            }
            images.put(JSONObject().put("mime", "image/jpeg").put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }
        val data = JSONObject().put("id", id).put("category", category).put("message", message.trim())
            .put("appVersion", BuildConfig.VERSION_NAME).put("images", images)
        val request = Request.Builder().url(ENDPOINT).post(data.toString().toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw IOException(feedbackError(response.code))
                val result = JSONObject(response.body?.string().orEmpty())
                if (!result.optString("id").equals(id, ignoreCase = true)) throw IOException("提交结果未确认，请重试")
                id
            }
        } catch (e: IOException) {
            if (e.message?.startsWith("提交") == true || e.message?.startsWith("图片") == true ||
                e.message?.startsWith("反馈") == true) throw e
            throw IOException("网络连接不稳定，未能确认发送结果；可以重试", e)
        }
    }

    private fun jpegWithoutMetadata(context: Context, uri: Uri): ByteArray {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
        require(bounds.outWidth in 1..32768 && bounds.outHeight in 1..32768)
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (longest / (sample * 2) >= 1920) sample *= 2
        val decoded = resolver.openInputStream(uri).use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: throw IOException("图片无法读取")
        try {
            val orientation = runCatching {
                resolver.openInputStream(uri).use { stream ->
                    ExifInterface(requireNotNull(stream)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                }
            }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
            val matrix = Matrix().apply {
                when (orientation) {
                    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
                    ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
                    ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
                    ExifInterface.ORIENTATION_TRANSPOSE -> { postScale(-1f, 1f); postRotate(270f) }
                    ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
                    ExifInterface.ORIENTATION_TRANSVERSE -> { postScale(-1f, 1f); postRotate(90f) }
                    ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f)
                }
                val scale = minOf(1f, 1920f / maxOf(decoded.width, decoded.height))
                postScale(scale, scale)
            }
            val transformed = if (!matrix.isIdentity) Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true) else decoded
            try {
                for (quality in listOf(88, 76, 64, 52, 40)) {
                    val output = ByteArrayOutputStream()
                    check(transformed.compress(Bitmap.CompressFormat.JPEG, quality, output))
                    if (output.size() <= MAX_FEEDBACK_IMAGE_BYTES) return output.toByteArray()
                }
                throw IOException("图片过大")
            } finally { if (transformed !== decoded) transformed.recycle() }
        } finally { decoded.recycle() }
    }
}
