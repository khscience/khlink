package vip.fengzhu.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateMirrorTest {
    private val relay = "https://khsci.vip/fengzhu-bridge/downloads"
    private val github = "https://github.com/khscience/khlink-releases/releases/latest/download"
    private val jsdelivr = "https://cdn.jsdelivr.net/gh/khscience/khlink-releases@dist"

    @Test
    fun theManifestIsLookedForOnGithubThenJsdelivrThenTheRelay() {
        assertEquals(listOf(github, jsdelivr, relay), updateManifestSources("$github/, $jsdelivr", relay))
        assertEquals(listOf(github, relay), updateManifestSources("$github/", relay))
        // A build without a mirror (or a fork) keeps the relay only.
        assertEquals(listOf(relay), updateManifestSources("", relay))
    }

    @Test
    fun downloadsTryGithubFirstAndAlwaysKeepTheRelay() {
        val apk = "https://github.com/khscience/khlink/releases/download/v2026.10.31.2/khLink-android-0.1.290.apk"
        val own = "$relay/fengzhu-codex-0.1.290.apk"
        val entry = JSONObject().put("url", own).put("urls", JSONArray(listOf(apk, own)))
        assertEquals(listOf(apk, own), updateDownloadUrls(entry))
        // An older manifest has only the relay.
        assertEquals(listOf(own), updateDownloadUrls(JSONObject().put("url", own)))
        // Never anything but https.
        assertEquals(listOf(own), updateDownloadUrls(JSONObject().put("url", own).put("urls", JSONArray(listOf("http://example.com/a.apk")))))
        // The relay's old hosts are moved to the current one.
        val moved = updateDownloadUrls(JSONObject().put("url", "https://old.example/x.apk")) { it.replace("old.example", "khsci.vip") }
        assertEquals(listOf("https://khsci.vip/x.apk"), moved)
    }

    @Test
    fun allFourExternalSourcesFitBeforeTheRelayFallback() {
        val own = "$relay/app.apk"
        val sources = listOf(
            "https://gcore.jsdelivr.net/gh/khscience/khlink-releases@v1-dist/app.apk",
            "https://github.com/khscience/khlink-releases/releases/download/v1/app.apk",
            "https://fastly.jsdelivr.net/gh/khscience/khlink-releases@v1-dist/app.apk",
            "https://cdn.jsdelivr.net/gh/khscience/khlink-releases@v1-dist/app.apk",
            own,
        )
        val entry = JSONObject().put("url", own).put("urls", JSONArray(sources))
        assertEquals(sources, updateDownloadUrls(entry))
        assertEquals(5, updateDownloadUrls(entry).size)
    }

    @Test
    fun aMirrorThatLagsBehindLosesToTheNewerManifest() {
        val older = JSONObject().put("android", JSONObject().put("versionCode", 289))
        val newer = JSONObject().put("android", JSONObject().put("versionCode", 290))
        assertEquals(290, newestAndroidManifest(listOf(older, newer))!!.getJSONObject("android").getInt("versionCode"))
        assertEquals(290, newestAndroidManifest(listOf(newer, older))!!.getJSONObject("android").getInt("versionCode"))
        assertNull(newestAndroidManifest(emptyList()))
    }

    @Test
    fun onlyGithubGetsTheShortMirrorTimeouts() {
        assertTrue(isUpdateMirrorUrl("https://github.com/khscience/khlink/releases/download/v1/a.apk"))
        assertTrue(isUpdateMirrorUrl("https://objects.githubusercontent.com/github-production-release-asset/1"))
        assertTrue(isUpdateMirrorUrl("https://cdn.jsdelivr.net/gh/khscience/khlink@v2026.10.31.3-dist/khLink-android-0.1.291.apk"))
        assertFalse(isUpdateMirrorUrl("https://khsci.vip/fengzhu-bridge/downloads/a.apk"))
        assertFalse(isUpdateMirrorUrl("https://evilgithub.com/a.apk"))
    }

    @Test
    fun downloadChannelsIdentifyActualHostsWithoutExposingPathsOrQueryParameters() {
        assertEquals("GitHub", updateDownloadChannel("https://github.com/khscience/khlink/releases/a.apk"))
        assertEquals("GitHub", updateDownloadChannel("https://release-assets.githubusercontent.com/a?token=private"))
        assertEquals("jsDelivr", updateDownloadChannel("https://cdn.jsdelivr.net/gh/project/a.apk"))
        assertEquals("jsDelivr · Gcore", updateDownloadChannel("https://gcore.jsdelivr.net/gh/project/a.apk"))
        assertEquals("jsDelivr · Fastly", updateDownloadChannel("https://fastly.jsdelivr.net/gh/project/a.apk"))
        assertEquals("khLink 官方服务器", updateDownloadChannel("https://khsci.vip/fengzhu-bridge/downloads/a.apk"))
        assertEquals("下载服务器 · example.com", updateDownloadChannel("https://user:secret@EXAMPLE.COM/private?token=secret"))
        assertEquals("下载服务器 · github.com.example.org", updateDownloadChannel("https://github.com.example.org/a.apk"))
        assertEquals("未知渠道", updateDownloadChannel("not a URL"))
    }
}
