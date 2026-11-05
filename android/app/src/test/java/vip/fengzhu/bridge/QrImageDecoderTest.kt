package vip.fengzhu.bridge

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Test

class QrImageDecoderTest {
    @Test
    fun decodesPairingPayloadFromImagePixels() {
        val payload = "khlink://pair?v=2&server=https%3A%2F%2Frelay.example.test%2Fbridge&id=test&secret=test"
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, 640, 640)
        val pixels = IntArray(matrix.width * matrix.height) { index ->
            if (matrix[index % matrix.width, index / matrix.width]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
        }

        assertEquals(payload, QrImageDecoder.decodePixels(matrix.width, matrix.height, pixels))
    }
}
