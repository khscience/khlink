package vip.fengzhu.bridge

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * A session's own avatar in the chat layout, as a chat app gives each contact
 * a picture: one of the bundled photos (landscapes, animals, streets; see
 * AVATAR_PHOTOS.md), fixed per session, or the one the user picked.
 */
data class AvatarSpec(val photo: Int)

/** The bundled photos, in res/drawable-nodpi. */
internal val AVATAR_PHOTOS = listOf(
    R.drawable.avatar_photo_00, R.drawable.avatar_photo_01, R.drawable.avatar_photo_02, R.drawable.avatar_photo_03,
    R.drawable.avatar_photo_04, R.drawable.avatar_photo_05, R.drawable.avatar_photo_06, R.drawable.avatar_photo_07,
    R.drawable.avatar_photo_08, R.drawable.avatar_photo_09, R.drawable.avatar_photo_10, R.drawable.avatar_photo_11,
    R.drawable.avatar_photo_12, R.drawable.avatar_photo_13, R.drawable.avatar_photo_14, R.drawable.avatar_photo_15,
    R.drawable.avatar_photo_16, R.drawable.avatar_photo_17, R.drawable.avatar_photo_18, R.drawable.avatar_photo_19,
    R.drawable.avatar_photo_20, R.drawable.avatar_photo_21, R.drawable.avatar_photo_22, R.drawable.avatar_photo_23,
    R.drawable.avatar_photo_24, R.drawable.avatar_photo_25, R.drawable.avatar_photo_26, R.drawable.avatar_photo_27,
    R.drawable.avatar_photo_28, R.drawable.avatar_photo_29, R.drawable.avatar_photo_30, R.drawable.avatar_photo_31,
    R.drawable.avatar_photo_32, R.drawable.avatar_photo_33, R.drawable.avatar_photo_34, R.drawable.avatar_photo_35,
    R.drawable.avatar_photo_36, R.drawable.avatar_photo_37, R.drawable.avatar_photo_38, R.drawable.avatar_photo_39,
    R.drawable.avatar_photo_40, R.drawable.avatar_photo_41, R.drawable.avatar_photo_42, R.drawable.avatar_photo_43,
    R.drawable.avatar_photo_44, R.drawable.avatar_photo_45, R.drawable.avatar_photo_46, R.drawable.avatar_photo_47,
)
internal const val AVATAR_PHOTO_COUNT = 48

/** Where a session's automatic photo search starts: fixed by its id. */
fun autoAvatarPhoto(id: String): Int = Math.floorMod(id.fold(7) { acc, c -> acc * 131 + c.code }, AVATAR_PHOTO_COUNT)

/**
 * A new session's automatic photo: from [autoAvatarPhoto] onward, the first
 * one no other session has yet (repeats only once all of them are in use).
 */
fun nextFreeAvatarPhoto(id: String, taken: Collection<Int>): Int {
    val start = autoAvatarPhoto(id)
    val used = taken.toSet()
    return (0 until AVATAR_PHOTO_COUNT).map { (start + it) % AVATAR_PHOTO_COUNT }.firstOrNull { it !in used } ?: start
}

/**
 * Session avatars on this phone only: "photo:<n>" the user picked, or
 * "auto:<n>" given once and kept, so a session never changes picture and
 * two sessions do not share one while photos are left.
 */
object SessionAvatarStore {
    private const val PREFS = "session-avatars"
    private val saved = mutableStateMapOf<String, String>()
    @Volatile private var loaded = false
    private var prefs: android.content.SharedPreferences? = null

    fun ensureLoaded(context: Context) {
        if (loaded) return
        synchronized(this) {
            if (loaded) return
            val store = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            store.all.forEach { (key, value) -> if (value is String) saved[key] = value }
            prefs = store
            loaded = true
        }
    }

    private fun photoOf(value: String?): Int? = value?.substringAfter(':')?.toIntOrNull()?.takeIf { it in 0 until AVATAR_PHOTO_COUNT }
        ?.takeIf { value.startsWith("photo:") || value.startsWith("auto:") }

    fun spec(id: String, title: String): AvatarSpec {
        photoOf(saved[id])?.let { return AvatarSpec(it) }
        synchronized(this) {
            photoOf(saved[id])?.let { return AvatarSpec(it) }
            val photo = nextFreeAvatarPhoto(id, saved.values.mapNotNull(::photoOf))
            val value = "auto:$photo"
            saved[id] = value
            prefs?.edit()?.putString(id, value)?.apply()
            return AvatarSpec(photo)
        }
    }

    /** [photo] null: back to an automatic one, given afresh. */
    fun choose(context: Context, id: String, photo: Int?) {
        ensureLoaded(context)
        val edit = prefs?.edit() ?: return
        if (photo == null) { saved.remove(id); edit.remove(id) } else { val value = "photo:$photo"; saved[id] = value; edit.putString(id, value) }
        edit.apply()
    }
}

@Composable
internal fun AvatarTile(spec: AvatarSpec, size: Dp, modifier: Modifier = Modifier) {
    androidx.compose.foundation.Image(
        androidx.compose.ui.res.painterResource(AVATAR_PHOTOS[spec.photo]), null,
        modifier.size(size).clip(RoundedCornerShape(size * 0.12f)),
        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
    )
}

/** A session's avatar, as a contact's picture: no agent mark on it. */
@Composable
internal fun SessionAvatar(id: String, title: String, size: Dp) {
    SessionAvatarStore.ensureLoaded(LocalContext.current)
    Box(Modifier.semantics { contentDescription = "$title 的头像" }) { AvatarTile(SessionAvatarStore.spec(id, title), size) }
}

/** The picker: the bundled photos, plus going back to the automatic one. */
@Composable
internal fun AvatarPickerDialog(id: String, title: String, close: () -> Unit) {
    val context = LocalContext.current
    SessionAvatarStore.ensureLoaded(context)
    val current = SessionAvatarStore.spec(id, title)
    AlertDialog(
        onDismissRequest = close,
        title = { Text("更换头像", fontWeight = FontWeight.Medium) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AvatarTile(current, 48.dp)
                    Spacer(Modifier.size(12.dp))
                    Column {
                        Text(title.ifBlank { "未命名任务" }, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
                        Text("只在这台手机上生效", color = Color(0xFF8C8C8C), style = MaterialTheme.typography.labelSmall)
                    }
                }
                LazyVerticalGrid(GridCells.Fixed(6), Modifier.fillMaxWidth().heightIn(max = 320.dp), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    itemsIndexed(AVATAR_PHOTOS) { index, _ ->
                        val picked = current.photo == index
                        Box(
                            Modifier.clip(RoundedCornerShape(8.dp)).then(if (picked) Modifier.border(2.dp, Color(0xFF07C160), RoundedCornerShape(8.dp)) else Modifier)
                                .clickable { SessionAvatarStore.choose(context, id, index); close() }.padding(2.dp)
                                .semantics { contentDescription = "头像 ${index + 1}" },
                            contentAlignment = Alignment.Center,
                        ) { AvatarTile(AvatarSpec(index), 40.dp) }
                    }
                }
                Spacer(Modifier.height(0.dp))
            }
        },
        confirmButton = { TextButton({ SessionAvatarStore.choose(context, id, null); close() }) { Text("恢复默认") } },
        dismissButton = { TextButton(close) { Text("取消") } },
    )
}
