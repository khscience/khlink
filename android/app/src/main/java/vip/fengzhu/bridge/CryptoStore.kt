package vip.fengzhu.bridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

// The distribution's relay (khlink-official.properties for the official build,
// see build.gradle.kts). An open-source build has none: the user enters or scans one.
internal val DEFAULT_BRIDGE_SERVER: String = BuildConfig.BRIDGE_SERVER
private fun configList(value: String) = value.split(',').map(String::trim).filter(String::isNotEmpty)
// Earlier addresses of the same relay: same accounts and sessions.
private val LEGACY_BRIDGE_SERVERS = configList(BuildConfig.LEGACY_BRIDGE_SERVERS).toSet()
private val TRUSTED_BRIDGE_SERVERS = configList(BuildConfig.TRUSTED_BRIDGE_SERVERS)

/** Relay hosts the app accepts from a QR code or login; any https relay when the build names none. */
internal fun isTrustedBridgeServer(value: String, trusted: List<String> = TRUSTED_BRIDGE_SERVERS): Boolean =
    if (trusted.isEmpty()) value.startsWith("https://") else trusted.any(value::startsWith)

internal fun normalizeBridgeServer(value: String, default: String = DEFAULT_BRIDGE_SERVER,
    legacy: Set<String> = LEGACY_BRIDGE_SERVERS): String {
    val raw = value.trim().ifBlank { default }
    val normalized = raw.replace("://", "\u0000").replace(Regex("/+"), "/").replace("\u0000", "://").trimEnd('/')
    return if (normalized in legacy) default else normalized
}

/**
 * The signed update manifest may name its packages on a legacy address
 * (connectors read it too). The phone fetches them from the same relay at its
 * current address; the SHA-256 in the manifest is still checked.
 */
internal fun rehomeBridgeUrl(value: String, default: String = DEFAULT_BRIDGE_SERVER,
    legacy: Set<String> = LEGACY_BRIDGE_SERVERS): String =
    legacy.firstOrNull { value.startsWith("$it/") }?.let { default + value.removePrefix(it) } ?: value

internal fun isRetryableKeystoreOperationFailure(error: Throwable): Boolean =
    generateSequence(error) { it.cause }.any { cause ->
        val message = cause.message.orEmpty()
        message.contains("Invalid operation handle", ignoreCase = true) ||
            message.contains("Call on finalized operation", ignoreCase = true) ||
            (message.contains("KeystoreOperation::finish", ignoreCase = true) &&
                message.contains("Pruned", ignoreCase = true))
    }

// The login a direct connection hands back to. Backups from before 0.1.282
// carry no version: an account login (v2) always has an account, a
// self-hosted relay's password login (v1) never does.
internal fun restoredProtocolVersion(stored: Int?, accountId: String?): Int =
    stored?.takeIf { it == 1 || it == 2 } ?: if (accountId.isNullOrBlank()) 1 else 2

class CryptoStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("secure", Context.MODE_PRIVATE)
    private val sodium = LazySodiumAndroid(SodiumAndroid())
    private val keystoreLock = Any()
    private val readStateLock = Any()
    @Volatile private var cachedAccountKey: ByteArray? = null
    @Volatile private var cachedDevicePrivateKey: ByteArray? = null
    @Volatile private var cachedKeystoreKey: SecretKey? = null

    fun derive(password: CharArray, salt: ByteArray, iterations: Int): ByteArray =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            .generateSecret(PBEKeySpec(password, salt, iterations, 256)).encoded

    fun proof(key: ByteArray, challengeId: String, nonce: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return b64(mac.doFinal("$challengeId|$nonce".toByteArray()))
    }

    fun saveAccountKey(key: ByteArray) {
        val stored = protectLocal(key)
        synchronized(keystoreLock) {
            prefs.edit().putString("account_key", stored).apply()
            cachedAccountKey = key.copyOf()
        }
    }

    fun accountKey(): ByteArray? {
        cachedAccountKey?.let { return it }
        return synchronized(keystoreLock) {
            cachedAccountKey?.let { return@synchronized it }
            val stored = prefs.getString("account_key", null) ?: return@synchronized null
            runCatching { unprotectLocalLocked(stored) }
                .onFailure { Log.e(LOG_TAG, "Unable to unwrap account key", it) }
                .getOrNull()
                ?.also { cachedAccountKey = it }
        }
    }

    private fun protectLocal(value: ByteArray): String {
        return synchronized(keystoreLock) { protectLocalLocked(value) }
    }

    private fun protectLocalLocked(value: ByteArray): String {
        return withKeystoreRetryLocked("wrap local value") {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, keystoreKeyLocked())
            b64(cipher.iv + cipher.doFinal(value))
        }
    }

    private fun unprotectLocal(value: String): ByteArray {
        return synchronized(keystoreLock) { unprotectLocalLocked(value) }
    }

    private fun unprotectLocalLocked(value: String): ByteArray {
        val packed = unb64(value)
        require(packed.size > 12) { "Invalid protected value" }
        return withKeystoreRetryLocked("unwrap local value") {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, keystoreKeyLocked(), GCMParameterSpec(128, packed.copyOfRange(0, 12)))
            cipher.doFinal(packed.copyOfRange(12, packed.size))
        }
    }

    fun devicePublicKey(): String {
        val privateKey = devicePrivateKey()
        val publicKey = ByteArray(32)
        check(sodium.cryptoScalarMultBase(publicKey, privateKey)) { "无法生成设备公钥" }
        return b64(publicKey)
    }

    private fun devicePrivateKey(): ByteArray {
        cachedDevicePrivateKey?.let { return it }
        return synchronized(keystoreLock) {
            cachedDevicePrivateKey?.let { return@synchronized it }
            val privateKey = prefs.getString("v2_device_private", null)
                ?.let(::unprotectLocalLocked)
                ?: ByteArray(32).also(SecureRandom()::nextBytes).also {
                    prefs.edit().putString("v2_device_private", protectLocalLocked(it)).apply()
                }
            cachedDevicePrivateKey = privateKey
            privateKey
        }
    }

    fun unwrapPairingEnvelope(pairingId: String, envelopeValue: String): ByteArray {
        val envelope = JSONObject(envelopeValue)
        check(envelope.optInt("version") == 2) { "不支持的配对密钥版本" }
        val shared = ByteArray(32)
        check(sodium.cryptoScalarMult(shared, devicePrivateKey(), unb64(envelope.getString("desktopPublicKey")))) { "设备密钥协商失败" }
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("KH Link pairing v2".toByteArray(StandardCharsets.UTF_8))
        digest.update(shared)
        digest.update(pairingId.toByteArray(StandardCharsets.UTF_8))
        val key = digest.digest()
        val ciphertext = unb64(envelope.getString("ciphertext"))
        val output = ByteArray(ciphertext.size - 16)
        val aad = "kh-link-pairing-v2|$pairingId|${deviceId()}".toByteArray(StandardCharsets.UTF_8)
        val outputLength = LongArray(1)
        val ok = sodium.cryptoAeadXChaCha20Poly1305IetfDecrypt(
            output, outputLength, null, ciphertext, ciphertext.size.toLong(), aad, aad.size.toLong(),
            unb64(envelope.getString("nonce")), key,
        )
        check(ok) { "配对密钥验证失败" }
        return output
    }

    // Unwrap the account key the connector sealed to this phone after a khsci.com
    // login (device-key v3). Mirrors fengzhu-connect/src/device-key.js.
    fun unwrapDeviceKeyEnvelope(accountId: String, deviceId: String, envelopeValue: String): ByteArray {
        val envelope = JSONObject(envelopeValue)
        check(envelope.optInt("version") == 3) { "不支持的密钥信封版本" }
        val shared = ByteArray(32)
        check(sodium.cryptoScalarMult(shared, devicePrivateKey(), unb64(envelope.getString("senderPublicKey")))) { "设备密钥协商失败" }
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("KH Link device-key v3".toByteArray(StandardCharsets.UTF_8))
        digest.update(shared)
        digest.update(deviceId.toByteArray(StandardCharsets.UTF_8))
        val key = digest.digest()
        val ciphertext = unb64(envelope.getString("ciphertext"))
        val output = ByteArray(ciphertext.size - 16)
        val aad = "kh-link-device-key-v3|$accountId|$deviceId".toByteArray(StandardCharsets.UTF_8)
        val outputLength = LongArray(1)
        val ok = sodium.cryptoAeadXChaCha20Poly1305IetfDecrypt(
            output, outputLength, null, ciphertext, ciphertext.size.toLong(), aad, aad.size.toLong(),
            unb64(envelope.getString("nonce")), key,
        )
        check(ok) { "密钥信封验证失败" }
        return output
    }

    fun encrypt(kind: String, threadId: String?, id: String, value: JSONObject): Pair<String, String> {
        return encryptWithKey(requireNotNull(accountKey()), kind, threadId, id, value)
    }

    internal fun encryptWithKey(key: ByteArray, kind: String, threadId: String?, id: String, value: JSONObject): Pair<String, String> {
        val nonce = ByteArray(24).also(SecureRandom()::nextBytes)
        val plain = value.toString().toByteArray(StandardCharsets.UTF_8)
        val aad = "v1|$kind|${threadId.orEmpty()}|$id".toByteArray(StandardCharsets.UTF_8)
        val output = ByteArray(plain.size + 16)
        val outputLength = LongArray(1)
        val ok = sodium.cryptoAeadXChaCha20Poly1305IetfEncrypt(output, outputLength, plain, plain.size.toLong(), aad,
            aad.size.toLong(), null, nonce, key)
        check(ok) { "Encryption failed" }
        return b64(nonce) to b64(output)
    }

    fun wrapAccountKey(passwordKey: ByteArray): Pair<String, String> = encryptWithKey(passwordKey, "account.envelope", null, "master",
        JSONObject().put("key", b64(requireNotNull(accountKey()))))

    fun unwrapAccountKey(passwordKey: ByteArray, envelope: JSONObject): ByteArray {
        val cipher = unb64(envelope.getString("ciphertext")); val output = ByteArray(cipher.size - 16)
        val aad = "v1|account.envelope||master".toByteArray(StandardCharsets.UTF_8); val length = LongArray(1)
        val ok = sodium.cryptoAeadXChaCha20Poly1305IetfDecrypt(output, length, null, cipher, cipher.size.toLong(), aad,
            aad.size.toLong(), unb64(envelope.getString("nonce")), passwordKey)
        check(ok) { "密码或密钥信封无效" }
        return unb64(JSONObject(String(output, StandardCharsets.UTF_8)).getString("key"))
    }

    fun decrypt(kind: String, threadId: String?, id: String, nonce: String, ciphertext: String): JSONObject {
        return decryptWithKey(requireNotNull(accountKey()), kind, threadId, id, nonce, ciphertext)
    }

    internal fun decryptWithKey(key: ByteArray, kind: String, threadId: String?, id: String, nonce: String, ciphertext: String): JSONObject {
        val cipher = unb64(ciphertext)
        val output = ByteArray(cipher.size - 16)
        val aad = "v1|$kind|${threadId.orEmpty()}|$id".toByteArray(StandardCharsets.UTF_8)
        val outputLength = LongArray(1)
        val ok = sodium.cryptoAeadXChaCha20Poly1305IetfDecrypt(output, outputLength, null, cipher, cipher.size.toLong(), aad,
            aad.size.toLong(), unb64(nonce), key)
        check(ok) { "Authentication failed" }
        return JSONObject(String(output, StandardCharsets.UTF_8))
    }

    /** A file chunk sent beside a frame's JSON as raw bytes, sealed with the frame id (see the connector's encryptBlob). */
    fun decryptBlob(id: String, nonce: String, blob: String): ByteArray {
        val cipher = unb64(blob)
        val output = ByteArray(cipher.size - 16)
        val aad = "v1|file.blob|$id".toByteArray(StandardCharsets.UTF_8)
        val ok = sodium.cryptoAeadXChaCha20Poly1305IetfDecrypt(output, LongArray(1), null, cipher, cipher.size.toLong(), aad,
            aad.size.toLong(), unb64(nonce), requireNotNull(accountKey()))
        check(ok) { "Authentication failed" }
        return output
    }

    fun verifyUpdateSignature(message: ByteArray, signature: ByteArray): Boolean = runCatching {
        // Production historically served the detached Ed25519 signature as
        // raw 64 bytes, while some mirrors expose Base64 text. Accept both
        // encodings so an updater check cannot silently fail on a valid release.
        val raw = signature.takeIf { it.size == 64 } ?: run {
            val text = String(signature, StandardCharsets.UTF_8).trim()
            Base64.decode(text, Base64.DEFAULT).takeIf { it.size == 64 }
                ?: error("Invalid update signature")
        }
        sodium.cryptoSignVerifyDetached(raw, message, message.size, unb64(BuildConfig.UPDATE_PUBLIC_KEY))
    }.getOrDefault(false)

    fun verifyUpdateSignature(message: ByteArray, signature: String): Boolean =
        verifyUpdateSignature(message, signature.toByteArray(StandardCharsets.UTF_8))

    fun saveSession(server: String, deviceId: String, access: String, refresh: String, expiresAt: Long) {
        prefs.edit().putString("server", normalizeBridgeServer(server)).putString("device_id", deviceId)
            .putString("access", access).putString("refresh", refresh).putLong("expires", expiresAt)
            .putInt("protocol_version", 1).remove("account_id").apply()
    }
    fun saveV2Session(server: String, accountId: String, deviceId: String, access: String, refresh: String, expiresAt: Long, resetSequence: Boolean = true) {
        val edit = prefs.edit().putString("server", normalizeBridgeServer(server)).putString("account_id", accountId)
            .putString("device_id", deviceId).putString("access", access).putString("refresh", refresh)
            .putLong("expires", expiresAt).putInt("protocol_version", 2).putBoolean("direct_mode", false)
        if (resetSequence) edit.putLong("event_sequence", 0)
        edit.apply()
    }
    fun directMode(): Boolean = prefs.getBoolean("direct_mode", false)
    fun saveDirectSession(pcId: String, pcName: String, key: ByteArray) {
        if (!directMode() && refresh() != null) {
            val backup = JSONObject()
            listOf("server", "account_id", "device_id", "access", "refresh", "account_key").forEach { name -> backup.put(name, prefs.getString(name, null)) }
            backup.put("expires", expires()).put("event_sequence", sequence()).put("protocol_version", protocolVersion())
            prefs.edit().putString("cloud_session_backup", protectLocal(backup.toString().toByteArray())).apply()
        }
        saveAccountKey(key)
        prefs.edit().putBoolean("direct_mode", true).putInt("protocol_version", 2).remove("direct_resume")
            .putString("account_id", "direct:$pcId").putString("direct_pc_name", pcName)
            .remove("access").remove("refresh").putLong("event_sequence", 0).apply()
        saveSelectedConnectorId(pcId)
    }
    /** The paired computer's id while in direct mode. */
    fun directPcId(): String? = prefs.getString("account_id", null)?.takeIf { directMode() && it.startsWith("direct:") }?.removePrefix("direct:")
    /** Where a paired computer listens for a LAN reconnect; kept with the pairing key. */
    data class DirectResumeInfo(val hosts: List<String>, val port: Int, val tunnel: String?)
    /**
     * A null port keeps the last known one; the tunnel is replaced by what the
     * computer reports (null when it no longer runs one).
     */
    fun saveDirectResume(hosts: List<String>, port: Int?, tunnel: String?) {
        val previous = directResume()
        val rows = org.json.JSONArray(); (hosts + previous?.hosts.orEmpty()).distinct().take(8).forEach { rows.put(it) }
        val value = JSONObject().put("port", port ?: previous?.port ?: 0).put("hosts", rows)
        if (tunnel != null) value.put("tunnel", tunnel)
        prefs.edit().putString("direct_resume", value.toString()).apply()
    }
    fun directResume(): DirectResumeInfo? {
        val value = runCatching { JSONObject(prefs.getString("direct_resume", null) ?: return null) }.getOrNull() ?: return null
        val rows = value.optJSONArray("hosts") ?: org.json.JSONArray()
        val tunnel = value.optString("tunnel").takeIf { it.isNotBlank() }
        val port = value.optInt("port")
        if (port !in 1024..65535 && tunnel == null) return null
        return DirectResumeInfo((0 until rows.length()).map { rows.getString(it) }, port, tunnel)
    }
    fun directPcName(): String? = prefs.getString("direct_pc_name", null)
    fun hasCloudSessionBackup(): Boolean = prefs.contains("cloud_session_backup")
    fun restoreCloudSession(): Boolean {
        val stored = prefs.getString("cloud_session_backup", null) ?: return false
        val backup = JSONObject(String(unprotectLocal(stored)))
        val version = restoredProtocolVersion(if (backup.has("protocol_version")) backup.optInt("protocol_version") else null,
            if (backup.isNull("account_id")) null else backup.optString("account_id"))
        val edit = prefs.edit().putBoolean("direct_mode", false).putInt("protocol_version", version).remove("direct_resume")
        listOf("server", "account_id", "device_id", "access", "refresh", "account_key").forEach { name ->
            if (backup.isNull(name)) edit.remove(name) else edit.putString(name, backup.getString(name))
        }
        edit.putLong("expires", backup.optLong("expires")).putLong("event_sequence", backup.optLong("event_sequence"))
            .remove("cloud_session_backup").apply()
        cachedAccountKey = null
        return true
    }
    fun server(): String {
        val stored = prefs.getString("server", DEFAULT_BRIDGE_SERVER)
            ?: DEFAULT_BRIDGE_SERVER
        val normalized = normalizeBridgeServer(stored)
        if (stored != normalized) prefs.edit().putString("server", normalized).apply()
        return normalized
    }
    fun deviceId(): String = prefs.getString("device_id", null) ?: java.util.UUID.randomUUID().toString().also { prefs.edit().putString("device_id", it).apply() }
    fun access(): String? = prefs.getString("access", null)
    fun refresh(): String? = prefs.getString("refresh", null)
    fun expires(): Long = prefs.getLong("expires", 0)
    fun protocolVersion(): Int = prefs.getInt("protocol_version", 1)
    fun accountId(): String? = prefs.getString("account_id", null)
    fun lastViewedThreadId(): String? = prefs.getString("last_viewed_thread:${accountId() ?: "v1"}", null)
    fun homeBackend(): String = prefs.getString("home_backend", "codex")?.takeIf { it in HOME_AGENT_IDS } ?: "codex"
    fun saveHomeBackend(value: String) { prefs.edit().putString("home_backend", value.takeIf { it in HOME_AGENT_IDS } ?: "codex").apply() }
    fun skippedUpdateVersion(): Int = prefs.getInt("skipped_update_version", 0)
    fun saveSkippedUpdateVersion(versionCode: Int) = prefs.edit().putInt("skipped_update_version", versionCode).apply()
    fun visibleAgents(): Set<String> = visibleAgentOrder().toSet()
    fun visibleAgentOrder(): List<String> {
        val savedOrder = prefs.getString("visible_agents_order", null)
            ?.split(',')?.map(String::trim)?.filter(String::isNotEmpty)
        if (!savedOrder.isNullOrEmpty()) {
            // Hermes arrived with 0.1.264: shown once in a saved order, in
            // Antigravity's place (a read-only mirror) or in a free slot.
            if (!prefs.getBoolean("hermes_tab_added", false)) {
                val migrated = withHermesTab(normalizeHomeAgentOrder(savedOrder))
                prefs.edit().putBoolean("hermes_tab_added", true)
                    .putString("visible_agents_order", migrated.joinToString(","))
                    .putStringSet("visible_agents", migrated.toSet()).apply()
                return migrated
            }
            return normalizeHomeAgentOrder(savedOrder)
        }
        val saved = prefs.getStringSet("visible_agents", null)
        // New installs and untouched old defaults move to the four-tab default
        // (Pi is no longer shown until the user adds it from the tab menu).
        if (saved == null || saved == HOME_AGENT_IDS.toSet() || saved == setOf("codex", "claude", "pi", "antigravity")
            || saved == setOf("codex", "dsh", "claude", "antigravity")) {
            return DEFAULT_HOME_AGENT_ORDER
        }
        return normalizeHomeAgentOrder(HOME_AGENT_IDS.filter { it in saved })
    }
    fun saveAgentOrder(order: List<String>) {
        val normalized = normalizeHomeAgentOrder(order)
        prefs.edit()
            .putString("visible_agents_order", normalized.joinToString(","))
            .putStringSet("visible_agents", normalized.toSet())
            .apply()
    }
    fun saveVisibleAgents(values: Set<String>) {
        val current = visibleAgentOrder()
        saveAgentOrder(current.filter { it in values } + HOME_AGENT_IDS.filter { it in values && it !in current })
    }
    fun saveLastViewedThreadId(threadId: String) {
        prefs.edit().putString("last_viewed_thread:${accountId() ?: "v1"}", threadId).apply()
    }
    fun clearLastViewedThreadId() {
        prefs.edit().remove("last_viewed_thread:${accountId() ?: "v1"}").apply()
    }
    fun sequence(): Long = prefs.getLong("event_sequence", 0)
    fun saveSequence(value: Long) { prefs.edit().putLong("event_sequence", value).apply() }
    fun selectedConnectorId(): String? = prefs.getString("selected_connector_id:${accountId() ?: "v1"}", null)
    /** Sessions archived on this phone only (agents whose computer side has no archive). */
    fun phoneArchivedIds(): Set<String> = prefs.getStringSet("phone_archived:${accountId() ?: "v1"}", emptySet())?.toSet().orEmpty()
    fun savePhoneArchivedIds(ids: Set<String>) { prefs.edit().putStringSet("phone_archived:${accountId() ?: "v1"}", ids).apply() }
    /** The computer each agent tab looks at: a pick on one tab does not move the others. */
    fun agentConnectorId(agent: String): String? = prefs.getString("selected_connector_id:${accountId() ?: "v1"}:agent:$agent", null)
    fun saveAgentConnectorId(agent: String, value: String) {
        prefs.edit().putString("selected_connector_id:${accountId() ?: "v1"}:agent:$agent", value).apply()
    }
    fun saveSelectedConnectorId(value: String?) {
        val key = "selected_connector_id:${accountId() ?: "v1"}"
        if (value.isNullOrBlank()) prefs.edit().remove(key).apply() else prefs.edit().putString(key, value).apply()
    }
    fun quotaSnapshot(): QuotaSnapshot? {
        val namespace = accountId() ?: return null
        val value = prefs.getString("quota_snapshot:$namespace", null) ?: return null
        return runCatching {
            val json = JSONObject(value)
            QuotaSnapshot(
                json.getInt("remainingPercent").coerceIn(0, 100),
                json.optLong("resetAt").takeIf { it > 0 },
            )
        }.getOrNull()
    }
    fun saveQuotaSnapshot(snapshot: QuotaSnapshot) {
        val namespace = accountId() ?: return
        prefs.edit().putString("quota_snapshot:$namespace", JSONObject()
            .put("remainingPercent", snapshot.remainingPercent.coerceIn(0, 100))
            .put("resetAt", snapshot.resetAt ?: JSONObject.NULL)
            .toString()).apply()
    }
    fun clearQuotaSnapshot() {
        val namespace = accountId() ?: return
        prefs.edit().remove("quota_snapshot:$namespace").apply()
    }
    fun legalAccepted(version: String): Boolean = prefs.getString("legal_version", null)
        .let { it == version || (version == LegalCopy.VERSION && it in LegalCopy.STILL_ACCEPTED) }
    /** Any version was ever accepted on this install. */
    fun legalConsentedBefore(): Boolean = prefs.getString("legal_version", null) != null
    fun saveLegalConsent(version: String, diagnostics: Boolean, analytics: Boolean) {
        prefs.edit().putString("legal_version", version)
            .putBoolean("diagnostics_opt_in", diagnostics)
            .putBoolean("analytics_opt_in", analytics)
            .apply()
    }

    fun threadReadSnapshot(): ThreadReadSnapshot = synchronized(readStateLock) {
        val values = prefs.getString(threadReadWatermarksKey(), null)?.let { encoded ->
            runCatching {
                val json = JSONObject(encoded)
                json.keys().asSequence().associateWith { id -> json.optLong(id) }
            }.getOrDefault(emptyMap())
        }.orEmpty()
        ThreadReadSnapshot(
            allReadAt = prefs.getLong(allThreadsReadAtKey(), 0),
            byThread = values,
        )
    }

    fun markThreadRead(threadId: String, updatedAt: Long) = synchronized(readStateLock) {
        if (threadId.isBlank() || updatedAt <= 0) return@synchronized
        val snapshot = threadReadSnapshot()
        val updated = (snapshot.byThread + (threadId to maxOf(snapshot.byThread[threadId] ?: 0, updatedAt)))
            .entries.sortedByDescending { it.value }.take(MAX_THREAD_READ_WATERMARKS)
        val json = JSONObject()
        updated.forEach { (id, value) -> json.put(id, value) }
        prefs.edit().putString(threadReadWatermarksKey(), json.toString()).apply()
    }

    fun markAllThreadsRead(updatedAt: Long) = synchronized(readStateLock) {
        prefs.edit().putLong(allThreadsReadAtKey(), maxOf(prefs.getLong(allThreadsReadAtKey(), 0), updatedAt)).apply()
    }
    fun clear() {
        synchronized(keystoreLock) {
            cachedAccountKey = null
            cachedDevicePrivateKey = null
            cachedKeystoreKey = null
            prefs.edit().clear().apply()
        }
    }

    fun clearSession() {
        synchronized(keystoreLock) {
            cachedAccountKey = null
            prefs.edit()
                .remove("account_key")
                .remove("access")
                .remove("refresh")
                .remove("expires")
                .remove("account_id")
                .remove("protocol_version")
                .remove("direct_mode")
                .remove("direct_resume")
                .remove("cloud_session_backup")
                .apply()
        }
    }

    fun invalidateAccessToken() {
        prefs.edit()
            .remove("access")
            .remove("expires")
            .apply()
    }

    private inline fun <T> withKeystoreRetryLocked(operation: String, block: () -> T): T {
        return try {
            block()
        } catch (error: Exception) {
            if (!isRetryableKeystoreOperationFailure(error)) throw error
            Log.w(LOG_TAG, "Android Keystore pruned $operation; retrying once", error)
            cachedKeystoreKey = null
            block()
        }
    }

    private fun keystoreKeyLocked(): SecretKey {
        cachedKeystoreKey?.let { return it }
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("fengzhu_account_wrap", null) as? SecretKey)?.let {
            cachedKeystoreKey = it
            return it
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder("fengzhu_account_wrap", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return generator.generateKey().also { cachedKeystoreKey = it }
    }

    companion object {
        private const val LOG_TAG = "KHLinkCrypto"
        private const val MAX_THREAD_READ_WATERMARKS = 1_000
        fun b64(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP)
        fun unb64(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)
        fun b64Url(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)
    }

    private fun readStateNamespace(): String = accountId() ?: "v1"
    private fun threadReadWatermarksKey(): String = "thread_read_watermarks:${readStateNamespace()}"
    private fun allThreadsReadAtKey(): String = "all_threads_read_at:${readStateNamespace()}"
}
