package vip.fengzhu.bridge

import android.content.Context
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Every color the screens use, by role. A theme is one of these; screens never
 * write a color literal of their own, so switching themes recolors everything.
 */
data class KhPalette(
    val ink: Color,
    val accent: Color,
    val warm: Color,
    val info: Color,
    val paper: Color,
    val surface: Color,
    val surfaceAlt: Color,
    val surfaceHigh: Color,
    val divider: Color,
    val muted: Color,
    val danger: Color,
    val dangerContainer: Color,
    val success: Color,
    val brand: Color,
    val brandLight: Color,
    // Backend and selection
    val claudeInk: Color,
    val claudeContainer: Color,
    val claudeBorder: Color,
    val selected: Color,
    val selectedMuted: Color,
    val selectedGreen: Color,
    val selectedGreenInk: Color,
    // Running turn
    val runningContainer: Color,
    val runningBorder: Color,
    val runningInk: Color,
    val runningChip: Color,
    val stoppedContainer: Color,
    val queued: Color,
    // Waiting for the user (mirrors the desktop's amber dot)
    val waitingContainer: Color,
    val waitingBorder: Color,
    val waitingDot: Color,
    val waitingInk: Color,
    val waitingChip: Color,
    val waitingNote: Color,
    val waitingNoteBorder: Color,
    val waitingPanel: Color,
    val waitingSelected: Color,
    // Unread dots, same colors as the desktop apps
    val unreadClaude: Color,
    val unreadCodex: Color,
    // Composer and conversation
    val composerRunning: Color,
    val composerRunningBorder: Color,
    val composerRunningInk: Color,
    val scrollTrack: Color,
    val scrollThumb: Color,
    val userBubble: Color,
    val userBorder: Color,
    val thinking: Color,
    val collapsible: Color,
    val codeBlock: Color,
    val activity: Color,
    val detail: Color,
    val chipAlt: Color,
    val thumb: Color,
    val planBody: Color,
    // Activity item icons
    val reasoning: Color,
    val command: Color,
    val webSearch: Color,
    val compaction: Color,
    val itemOther: Color,
)

/**
 * Visual contract for KH Link. Keep product behavior outside this object so a
 * future skin can change the whole visual language, not only a few colors.
 */
data class KhLinkSkin(
    val id: String,
    val name: String,
    val description: String,
    val palette: KhPalette,
    val shapes: Shapes,
    val typography: Typography,
    val messageRadius: Dp,
    val contentHorizontalPadding: Dp,
    /**
     * Chat-app layout instead of cards: a bottom tab bar, list rows with
     * square avatars, speech bubbles with avatars, a flat input bar.
     */
    val chatLayout: Boolean = false,
    /** A compact desktop-inspired rail and document-like conversation. */
    val codexLayout: Boolean = false,
    /** No cards: flat list rows and a document-like conversation, without the Codex rail. */
    val flatLayout: Boolean = false,
) {
    val colors: ColorScheme = lightColorScheme(
        primary = palette.accent,
        onPrimary = Color.White,
        secondary = palette.warm,
        tertiary = palette.info,
        background = palette.paper,
        surface = palette.surface,
        surfaceVariant = palette.surfaceAlt,
        surfaceContainerLowest = palette.surface,
        surfaceContainerLow = palette.surface,
        surfaceContainer = palette.surface,
        surfaceContainerHigh = palette.surfaceHigh,
        surfaceContainerHighest = palette.surfaceAlt,
        onSurface = palette.ink,
        onSurfaceVariant = palette.muted,
        outline = palette.divider,
        error = palette.danger,
    )
}

object KhLinkSkinCatalog {
    private val shapes = Shapes(
        extraSmall = RoundedCornerShape(6.dp),
        small = RoundedCornerShape(10.dp),
        medium = RoundedCornerShape(14.dp),
        large = RoundedCornerShape(18.dp),
        extraLarge = RoundedCornerShape(24.dp),
    )

    private val sandPalette = KhPalette(
        ink = Color(0xFF1A1D21),
        accent = Color(0xFF3B4E63),
        warm = Color(0xFFD97706),
        info = Color(0xFF3E6F8E),
        paper = Color(0xFFFAF8F5),
        surface = Color(0xFFFFFFFF),
        surfaceAlt = Color(0xFFF0ECE4),
        surfaceHigh = Color(0xFFF7F4EE),
        divider = Color(0xFFE5E0D6),
        muted = Color(0xFF686E78),
        danger = Color(0xFFDC2626),
        dangerContainer = Color(0xFFFEE2E2),
        success = Color(0xFF059669),
        brand = Color(0xFF2447F0),
        brandLight = Color(0xFF6F86F7),
        claudeInk = Color(0xFF6D28D9),
        claudeContainer = Color(0xFFEDE9FE),
        claudeBorder = Color(0xFF7C3AED),
        selected = Color(0xFFE0E7FF),
        selectedMuted = Color(0xFFEAE4ED),
        selectedGreen = Color(0xFFDCEFE5),
        selectedGreenInk = Color(0xFF2E7654),
        runningContainer = Color(0xFFFEF9EE),
        runningBorder = Color(0xFFFDE68A),
        runningInk = Color(0xFFB45309),
        runningChip = Color(0xFFFEF3C7),
        stoppedContainer = Color(0xFFF3F4F6),
        queued = Color(0xFFE07A1F),
        waitingContainer = Color(0xFFFFF7E6),
        waitingBorder = Color(0xFFF5B642),
        waitingDot = Color(0xFFF59E0B),
        waitingInk = Color(0xFF9A5B00),
        waitingChip = Color(0xFFFEF3C7),
        waitingNote = Color(0xFFFDEBC8),
        waitingNoteBorder = Color(0xFFE08A00),
        waitingPanel = Color(0xFFFDF0D5),
        waitingSelected = Color(0xFFFDE7B8),
        unreadClaude = Color(0xFF22A06B),   // Claude desktop: green = finished, not yet viewed
        unreadCodex = Color(0xFF1D4ED8),
        composerRunning = Color(0xFFF1F2F3),
        composerRunningBorder = Color(0xFFD1D4D8),
        composerRunningInk = Color(0xFF59616A),
        scrollTrack = Color(0xFFD5D7DB),
        scrollThumb = Color(0xFF7D848C),
        userBubble = Color(0xFFEAF2F7),
        userBorder = Color(0xFFD5E3EC),
        thinking = Color(0xFFF8F6F1),
        collapsible = Color(0xFFF4F1EA),
        codeBlock = Color(0xFFF3ECE1),
        activity = Color(0xFFF6F3ED),
        detail = Color(0xFFF5F1E8),
        chipAlt = Color(0xFFE7DED3),
        thumb = Color(0xFFEDE7DC),
        planBody = Color(0xFFF5F5F4),
        reasoning = Color(0xFF6B62B5),
        command = Color(0xFF52606D),
        webSearch = Color(0xFF3178C6),
        compaction = Color(0xFF7A6652),
        itemOther = Color(0xFF67757D),
    )

    // Black, white and gray. Color is kept only where it carries meaning:
    // errors (red), online (green), "waiting for you" (amber, like the
    // desktop's dot) and the desktop apps' unread dots.
    private val minimalPalette = sandPalette.copy(
        ink = Color(0xFF111111),
        accent = Color(0xFF262626),
        warm = Color(0xFF6B6B6B),
        info = Color(0xFF555555),
        paper = Color(0xFFF7F7F7),
        surface = Color(0xFFFFFFFF),
        surfaceAlt = Color(0xFFEEEEEE),
        surfaceHigh = Color(0xFFF4F4F4),
        divider = Color(0xFFE3E3E3),
        muted = Color(0xFF6E6E6E),
        brand = Color(0xFF111111),
        brandLight = Color(0xFF7A7A7A),
        claudeInk = Color(0xFF333333),
        claudeContainer = Color(0xFFEBEBEB),
        claudeBorder = Color(0xFF9E9E9E),
        selected = Color(0xFFE6E6E6),
        selectedMuted = Color(0xFFE6E6E6),
        selectedGreen = Color(0xFFE6E6E6),
        selectedGreenInk = Color(0xFF222222),
        runningContainer = Color(0xFFF4F4F4),
        runningBorder = Color(0xFFD6D6D6),
        runningInk = Color(0xFF444444),
        runningChip = Color(0xFFEBEBEB),
        stoppedContainer = Color(0xFFF0F0F0),
        composerRunning = Color(0xFFF0F0F0),
        composerRunningBorder = Color(0xFFD0D0D0),
        composerRunningInk = Color(0xFF5A5A5A),
        scrollTrack = Color(0xFFD6D6D6),
        scrollThumb = Color(0xFF7A7A7A),
        userBubble = Color(0xFFEDEDED),
        userBorder = Color(0xFFDADADA),
        thinking = Color(0xFFF7F7F7),
        collapsible = Color(0xFFF2F2F2),
        codeBlock = Color(0xFFEFEFEF),
        activity = Color(0xFFF4F4F4),
        detail = Color(0xFFF2F2F2),
        chipAlt = Color(0xFFE4E4E4),
        thumb = Color(0xFFEAEAEA),
        planBody = Color(0xFFF4F4F4),
        reasoning = Color(0xFF5E5E5E),
        command = Color(0xFF4A4A4A),
        webSearch = Color(0xFF5E5E5E),
        compaction = Color(0xFF6E6E6E),
        itemOther = Color(0xFF777777),
    )

    // Looks like a familiar chat app at a glance: light gray canvas, white
    // rows, green own bubbles, red unread badges.
    private val wechatPalette = sandPalette.copy(
        ink = Color(0xFF191919),
        accent = Color(0xFF07C160),
        warm = Color(0xFFFA9D3B),
        info = Color(0xFF576B95),
        paper = Color(0xFFEDEDED),
        surface = Color(0xFFFFFFFF),
        surfaceAlt = Color(0xFFF7F7F7),
        surfaceHigh = Color(0xFFF7F7F7),
        divider = Color(0xFFE5E5E5),
        muted = Color(0xFF8C8C8C),
        danger = Color(0xFFFA5151),
        dangerContainer = Color(0xFFFFECEC),
        success = Color(0xFF07C160),
        brand = Color(0xFF07C160),
        brandLight = Color(0xFF6ED49B),
        claudeInk = Color(0xFF576B95),
        claudeContainer = Color(0xFFF0F2F7),
        claudeBorder = Color(0xFF576B95),
        selected = Color(0xFFE8F8EF),
        selectedMuted = Color(0xFFEDEDED),
        selectedGreen = Color(0xFFE8F8EF),
        selectedGreenInk = Color(0xFF06AD56),
        runningContainer = Color(0xFFFFFFFF),
        runningBorder = Color(0xFFFFFFFF),
        runningInk = Color(0xFF576B95),
        runningChip = Color(0xFFF0F2F7),
        stoppedContainer = Color(0xFFF7F7F7),
        waitingContainer = Color(0xFFFFFFFF),
        waitingBorder = Color(0xFFFFFFFF),
        waitingDot = Color(0xFFFA5151),
        waitingInk = Color(0xFFFA5151),
        waitingChip = Color(0xFFFFECEC),
        waitingNote = Color(0xFFFFF3F3),
        waitingNoteBorder = Color(0xFFFA5151),
        waitingPanel = Color(0xFFFFF7F7),
        waitingSelected = Color(0xFFFFE3E3),
        unreadClaude = Color(0xFFFA5151),
        unreadCodex = Color(0xFFFA5151),
        composerRunning = Color(0xFFFFFFFF),
        composerRunningBorder = Color(0xFFE5E5E5),
        composerRunningInk = Color(0xFF576B95),
        scrollTrack = Color(0xFFDDDDDD),
        scrollThumb = Color(0xFFB2B2B2),
        userBubble = Color(0xFF95EC69),
        userBorder = Color(0xFF95EC69),
        thinking = Color(0xFFFFFFFF),
        collapsible = Color(0xFFFFFFFF),
        codeBlock = Color(0xFFF5F5F5),
        activity = Color(0xFFFFFFFF),
        detail = Color(0xFFF5F5F5),
        chipAlt = Color(0xFFEDEDED),
        thumb = Color(0xFFEDEDED),
        planBody = Color(0xFFF7F7F7),
        reasoning = Color(0xFF576B95),
        command = Color(0xFF576B95),
        webSearch = Color(0xFF576B95),
        compaction = Color(0xFF8C8C8C),
        itemOther = Color(0xFF8C8C8C),
    )

    // The reference uses a neutral workspace, blue outgoing bubbles and
    // unboxed replies. Keep semantic status colors for real task state.
    private val codexPalette = minimalPalette.copy(
        ink = Color(0xFF1C2025),
        accent = Color(0xFF326A9B),
        warm = Color(0xFFF59E0B),
        info = Color(0xFF326A9B),
        paper = Color(0xFFFCFCFB),
        surface = Color(0xFFFCFCFB),
        surfaceAlt = Color(0xFFF2F2F1),
        surfaceHigh = Color(0xFFF7F7F6),
        divider = Color(0xFFE4E5E5),
        muted = Color(0xFF85898D),
        selected = Color(0xFFE7E9E9),
        userBubble = Color(0xFFE6F1FC),
        userBorder = Color(0xFFE6F1FC),
        activity = Color(0xFFFCFCFB),
        collapsible = Color(0xFFFCFCFB),
        thinking = Color(0xFFFCFCFB),
        codeBlock = Color(0xFFF0F1F1),
        detail = Color(0xFFF5F5F4),
        composerRunning = Color(0xFFFCFCFB),
        composerRunningBorder = Color(0xFFE0E1E1),
        composerRunningInk = Color(0xFF676D72),
        runningContainer = Color(0xFFFCFCFB),
        runningBorder = Color(0xFFE4E5E5),
        runningInk = Color(0xFF8D681E),
        runningChip = Color(0xFFFFF5DD),
    )

    // Android's system sans supplies the local CJK fallback; the image itself
    // does not identify a font file, so do not pretend to ship its exact font.
    private val codexTypography = Typography(
        bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 15.sp, lineHeight = 24.sp),
        bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 22.sp),
        bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 13.sp, lineHeight = 20.sp),
        titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
        titleSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
        labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
        labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.Medium),
        labelSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 11.sp, lineHeight = 16.sp),
    )

    val sand = KhLinkSkin(
        id = "sand",
        name = "默认主题",
        description = "暖白底色，蓝灰与琥珀点缀",
        palette = sandPalette,
        shapes = shapes,
        typography = Typography(),
        messageRadius = 16.dp,
        contentHorizontalPadding = 16.dp,
    )

    val minimal = sand.copy(
        id = "minimal",
        name = "极简主题",
        description = "黑白灰，没有卡片：平铺的列表和文档式对话",
        palette = minimalPalette,
        flatLayout = true,
    )

    val wechat = sand.copy(
        id = "wechat",
        name = "聊天软件主题",
        description = "像常用的聊天软件：底部导航、头像列表、绿色气泡",
        palette = wechatPalette,
        messageRadius = 4.dp,
        chatLayout = true,
    )

    val codex = sand.copy(
        id = "codex",
        name = "Codex 风格主题",
        description = "浅色工作区、蓝色消息和紧凑的操作过程",
        palette = codexPalette,
        typography = codexTypography,
        messageRadius = 18.dp,
        contentHorizontalPadding = 16.dp,
        codexLayout = true,
    )

    val all = listOf(sand, codex, minimal, wechat)

    /** The WeChat theme is the default since 0.1.263; a theme someone picked stays picked. */
    fun byId(id: String?) = all.firstOrNull { it.id == id } ?: wechat
}

/** The chosen theme, remembered across launches. Reads are Compose state. */
object KhThemeState {
    private const val PREFS = "ui-preferences"
    private const val KEY = "theme"
    var current by mutableStateOf(KhLinkSkinCatalog.sand)
        private set

    fun load(context: Context) {
        current = KhLinkSkinCatalog.byId(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null))
    }

    fun select(context: Context, skin: KhLinkSkin) {
        current = skin
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, skin.id).apply()
    }
}

val LocalKhLinkSkin = staticCompositionLocalOf { KhLinkSkinCatalog.sand }

@Composable
fun KhLinkTheme(
    skin: KhLinkSkin = KhThemeState.current,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalKhLinkSkin provides skin) {
        androidx.compose.material3.MaterialTheme(
            colorScheme = skin.colors,
            shapes = skin.shapes,
            typography = skin.typography,
            content = content,
        )
    }
}
