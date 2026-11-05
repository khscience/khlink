package vip.fengzhu.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SentFilesTest {
    @Test fun sentFilesKeepPathsSizesAndKinds() {
        val video = "J:\\mov\\ep1\\video.mp4"
        val array = JSONArray()
            .put(JSONObject().put("path", video).put("name", "video.mp4").put("kind", "video").put("size", 39147024L).put("mimeType", "video/mp4"))
            .put(JSONObject().put("path", "J:\\mov\\ep1\\cover.jpg").put("size", 405166L))
            .put(JSONObject().put("path", "J:\\mov\\ep1\\notes.txt").put("kind", "unknown"))
            .put(JSONObject().put("name", "no path"))
        val files = parseSentFiles(array)
        assertEquals(listOf("video", "image", "file"), files.map { it.kind })
        assertEquals("cover.jpg", files[1].name)
        assertEquals(39147024L, files[0].size)
        assertEquals(video, files[0].path)
    }
}
