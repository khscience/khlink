package vip.fengzhu.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class DshPermissionTest {
    @Test
    fun parsesPermissionCatalogWithModels() {
        val catalog = JSONObject(
            """{"groups":[{"id":"magpie","name":"Magpie","models":[{"id":"workbuddy","name":"WorkBuddy","reasoning":{"defaultEffort":"high","efforts":[{"id":"high","name":"High"}]}}]}],"default":{"provider":"magpie","model":"workbuddy"}}""",
        )
        val permissions = JSONObject(
            """{"options":[{"value":"read-only","name":"read-only"},{"value":"workspace-write","name":"workspace-write"},{"value":"danger-full-access","name":"danger-full-access"},{"value":"auto","name":"auto"}],"defaultPreset":"workspace-write"}""",
        )
        val parsed = parseDshCatalog(catalog, permissions)
        assertNotNull(parsed)
        assertEquals("magpie/workbuddy", parsed!!.defaultKey)
        assertEquals(listOf("read-only", "workspace-write", "danger-full-access", "auto"), parsed.permissions.map { it.value })
        assertEquals("workspace-write", parsed.defaultPermission)
    }

    @Test
    fun keepsModelCatalogUsableWithoutPermissionCatalog() {
        val catalog = JSONObject("""{"groups":[{"id":"p","name":"P","models":[{"id":"m","name":"M"}]}]}""")
        val parsed = parseDshCatalog(catalog)
        assertNotNull(parsed)
        assertEquals(emptyList<DshPermissionOption>(), parsed!!.permissions)
        assertEquals(null, parsed.defaultPermission)
    }
}
