package vip.fengzhu.bridge

import javax.crypto.AEADBadTagException
import javax.crypto.IllegalBlockSizeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CryptoStoreRetryTest {
    private val current = "https://relay.example.test/bridge"
    private val legacy = setOf("https://old.example.test/bridge")

    @Test
    fun normalizesDuplicateBridgeSlashesWithoutChangingHttpsScheme() {
        assertEquals(current, normalizeBridgeServer(" https://relay.example.test//bridge/// ", current, legacy))
        // A saved legacy address is read as the current one: same relay.
        assertEquals(current, normalizeBridgeServer("https://old.example.test/bridge/", current, legacy))
        assertEquals(current, normalizeBridgeServer(" ", current, legacy))
        assertEquals("https://example.test/relay", normalizeBridgeServer("https://example.test//relay/", current, legacy))
    }

    @Test
    fun acceptsTheBuildsRelaysOrAnyHttpsRelayWhenItNamesNone() {
        val trusted = listOf("https://relay.example.test/", "https://old.example.test/")
        // QR codes from connectors may still name a legacy address and stay accepted.
        assertTrue(isTrustedBridgeServer("https://old.example.test/bridge", trusted))
        assertFalse(isTrustedBridgeServer("https://other.example.test/bridge", trusted))
        assertTrue(isTrustedBridgeServer("https://self-hosted.example.test/bridge", emptyList()))
        assertFalse(isTrustedBridgeServer("http://self-hosted.example.test/bridge", emptyList()))
    }

    @Test
    fun updateDownloadsNamedOnALegacyAddressComeThroughTheCurrentOne() {
        assertEquals("$current/downloads/fengzhu-codex-0.1.268.apk",
            rehomeBridgeUrl("https://old.example.test/bridge/downloads/fengzhu-codex-0.1.268.apk", current, legacy))
        assertEquals("https://example.test/app.apk", rehomeBridgeUrl("https://example.test/app.apk", current, legacy))
    }

    @Test
    fun retriesPrunedAndroidKeystoreOperation() {
        val error = IllegalBlockSizeException("provider failed").apply {
            initCause(IllegalStateException("Invalid operation handle"))
        }

        assertTrue(isRetryableKeystoreOperationFailure(error))
    }

    @Test
    fun retriesFinalizedPrunedOperation() {
        assertTrue(
            isRetryableKeystoreOperationFailure(
                IllegalStateException("KeystoreOperation::finish: Call on finalized operation with outcome: Pruned"),
            ),
        )
    }

    @Test
    fun doesNotRetryDamagedCiphertext() {
        assertFalse(isRetryableKeystoreOperationFailure(AEADBadTagException("Tag mismatch")))
        assertFalse(isRetryableKeystoreOperationFailure(IllegalBlockSizeException("Invalid protected value")))
    }
}
