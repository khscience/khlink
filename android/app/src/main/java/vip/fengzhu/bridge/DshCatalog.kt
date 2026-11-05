package vip.fengzhu.bridge

import org.json.JSONObject

data class DshEffort(val id: String, val name: String)

data class DshPermissionOption(val value: String, val name: String, val description: String = "")

data class DshModelOption(
    val provider: String,
    val providerName: String,
    val id: String,
    val name: String,
    val efforts: List<DshEffort>,
    val defaultEffort: String = "",
) {
    val key: String get() = "$provider/$id"
}

data class DshCatalog(
    val models: List<DshModelOption>,
    val defaultKey: String?,
    val permissions: List<DshPermissionOption> = emptyList(),
    val defaultPermission: String? = null,
) {
    fun model(key: String?): DshModelOption? = models.firstOrNull { it.key == key }
}

private fun parseDshPermissions(value: JSONObject?): List<DshPermissionOption> {
    val options = value?.optJSONArray("options") ?: return emptyList()
    val result = mutableListOf<DshPermissionOption>()
    for (index in 0 until options.length()) {
        val item = options.optJSONObject(index) ?: continue
        val id = item.optString("value").takeIf { it.isNotBlank() } ?: continue
        val name = item.optString("name").takeIf { it.isNotBlank() } ?: id
        result += DshPermissionOption(id, name, item.optString("description").orEmpty())
    }
    return result
}

internal fun parseDshCatalog(value: JSONObject?, permissionCatalog: JSONObject? = null): DshCatalog? {
    value ?: return null
    val groups = value.optJSONArray("groups") ?: return null
    val models = mutableListOf<DshModelOption>()
    for (index in 0 until groups.length()) {
        val group = groups.optJSONObject(index) ?: continue
        val provider = group.optString("id").takeIf { it.isNotBlank() } ?: continue
        val providerName = group.optString("name").takeIf { it.isNotBlank() } ?: provider
        val rows = group.optJSONArray("models") ?: continue
        for (rowIndex in 0 until rows.length()) {
            val model = rows.optJSONObject(rowIndex) ?: continue
            val id = model.optString("id").takeIf { it.isNotBlank() } ?: continue
            val name = model.optString("name").takeIf { it.isNotBlank() } ?: id
            val efforts = mutableListOf<DshEffort>()
            val reasoning = model.optJSONObject("reasoning")
            val defaultEffort = reasoning?.optString("defaultEffort").orEmpty()
            val list = reasoning?.optJSONArray("efforts")
            if (list != null) for (effortIndex in 0 until list.length()) {
                val effort = list.optJSONObject(effortIndex) ?: continue
                val effortId = effort.optString("id").takeIf { it.isNotBlank() } ?: continue
                efforts += DshEffort(effortId, effort.optString("name").takeIf { it.isNotBlank() } ?: effortId)
            }
            models += DshModelOption(provider, providerName, id, name, efforts, defaultEffort)
        }
    }
    if (models.isEmpty()) return null
    val default = value.optJSONObject("default")
    val defaultKey = default?.let {
        val provider = it.optString("provider")
        val model = it.optString("model")
        if (provider.isNotBlank() && model.isNotBlank()) "$provider/$model" else null
    }
    return DshCatalog(
        models = models,
        defaultKey = defaultKey,
        permissions = parseDshPermissions(permissionCatalog),
        defaultPermission = permissionCatalog?.optString("defaultPreset")?.takeIf { it.isNotBlank() },
    )
}
