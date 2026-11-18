package vip.fengzhu.bridge

import java.security.MessageDigest

/** Local names contain no account id, computer id or source path. */
internal fun fetchedCacheHash(vararg parts: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    parts.forEach { part ->
        val bytes = part.toByteArray(Charsets.UTF_8)
        digest.update(byteArrayOf((bytes.size ushr 24).toByte(), (bytes.size ushr 16).toByte(), (bytes.size ushr 8).toByte(), bytes.size.toByte()))
        digest.update(bytes)
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

internal fun fetchedAccountScope(server: String, accountId: String?): String =
    fetchedCacheHash("account-v1", server, accountId ?: "legacy")

internal fun fetchedFileScope(accountScope: String, connectorId: String?): String? =
    connectorId?.takeIf(String::isNotBlank)?.let { fetchedCacheHash("computer-v1", accountScope, it) }

internal fun fetchedFileKey(scope: String, path: String): String = fetchedCacheHash("file-v1", scope, path)

/** A legacy document or a document from another account cannot silently acquire companion files. */
internal fun trustedMarkdownDocumentScope(storedScope: String, storedAccount: String, currentAccount: String): String? =
    storedScope.takeIf { it.isNotBlank() && storedAccount.isNotBlank() && storedAccount == currentAccount }

internal fun canFetchMarkdownCompanion(documentScope: String, currentScope: String?): Boolean =
    documentScope.isNotBlank() && currentScope == documentScope

/** Old downloads lack computer identity and must not be silently matched. */
internal fun fetchedFileMatches(path: String, scope: String, storedPath: String, storedScope: String): Boolean =
    storedScope.isNotEmpty() && storedScope == scope && storedPath == path

/**
 * Whether a cached copy still matches the file on the computer. [stored] is
 * what the copy's record says (size and modification time when it was
 * fetched; older records have neither), [remote] what the computer reports
 * now. A copy is out of date when its size differs, or the file was modified
 * after it (by its recorded time, else after the copy was fetched). The
 * computer's clock is compared with the phone's only for those older records.
 */
internal fun fetchedCopyIsCurrent(localLength: Long, storedTotal: Long?, storedModifiedAt: Long?, fetchedAt: Long?,
    remoteTotal: Long, remoteModifiedAt: Long?): Boolean {
    if (remoteTotal != (storedTotal ?: localLength)) return false
    remoteModifiedAt ?: return true // an older connector reports no time: the size is all there is
    if (storedModifiedAt != null) return remoteModifiedAt == storedModifiedAt
    return fetchedAt == null || remoteModifiedAt <= fetchedAt
}

/** Match only a complete indexed file; an unscoped legacy entry stays manual. */
internal fun findFetchedCopy(root: java.io.File, path: String, scope: String?, metadataName: String): java.io.File? {
    scope ?: return null
    val folder = java.io.File(root, fetchedFileKey(scope, path))
    val meta = runCatching { org.json.JSONObject(java.io.File(folder, metadataName).readText()) }.getOrNull() ?: return null
    if (!fetchedFileMatches(path, scope, meta.optString("path"), meta.optString("scope"))) return null
    val name = meta.optString("name")
    if (name.isBlank() || name in setOf(".", "..", metadataName) || name != name.trimEnd('\\', '/').substringAfterLast('\\').substringAfterLast('/')) return null
    return java.io.File(folder, name).takeIf { it.isFile }
}
