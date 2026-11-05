package vip.fengzhu.bridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import kotlin.math.max

object QrImageDecoder {
    private const val MAX_IMAGE_EDGE = 2_048

    fun decode(context: Context, uri: Uri): String {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val boundsRead = resolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
            true
        } ?: false
        check(boundsRead) { "无法读取所选图片" }
        check(bounds.outWidth > 0 && bounds.outHeight > 0) { "所选文件不是有效图片" }

        var sampleSize = 1
        while (max(bounds.outWidth, bounds.outHeight) / sampleSize > MAX_IMAGE_EDGE) sampleSize *= 2
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val source = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
            ?: error("无法打开所选图片")
        try {
            decodeBitmap(source)?.let { return it }
            for (degrees in listOf(90f, 180f, 270f)) {
                val rotated = Bitmap.createBitmap(source, 0, 0, source.width, source.height, Matrix().apply { postRotate(degrees) }, true)
                try {
                    decodeBitmap(rotated)?.let { return it }
                } finally {
                    if (rotated !== source) rotated.recycle()
                }
            }
        } finally {
            source.recycle()
        }
        error("图片中没有识别到 khLink 二维码")
    }

    private fun decodeBitmap(bitmap: Bitmap): String? {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return decodePixels(bitmap.width, bitmap.height, pixels)
    }

    internal fun decodePixels(width: Int, height: Int, pixels: IntArray): String? {
        if (width <= 0 || height <= 0 || pixels.size < width * height) return null
        val source = RGBLuminanceSource(width, height, pixels)
        val hints: Map<DecodeHintType, Any> = mapOf(
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER to true,
            DecodeHintType.CHARACTER_SET to "UTF-8",
        )
        val reader = MultiFormatReader()
        return runCatching { reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text }.getOrNull()
            ?: runCatching { reader.decode(BinaryBitmap(GlobalHistogramBinarizer(source)), hints).text }.getOrNull()
    }
}
