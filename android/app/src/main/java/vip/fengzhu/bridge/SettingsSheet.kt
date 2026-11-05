package vip.fengzhu.bridge

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/*
 * The settings sheet for model, thinking strength and permission switches.
 * One layout, drawn in the language of the chosen theme:
 *  - default (sand): warm paper sheet, soft white cards, pill segments;
 *  - Codex: compact desktop panel, 8dp corners, blue checks;
 *  - minimal: black on white, hairlines, no fills;
 *  - chat app: grey sheet, full-width white cell groups, green checks.
 */
internal enum class SheetLook { Sand, Codex, Minimal, Chat }

private val Look: SheetLook
    get() {
        val skin = KhThemeState.current
        return when {
            skin.chatLayout -> SheetLook.Chat
            skin.codexLayout -> SheetLook.Codex
            skin.flatLayout -> SheetLook.Minimal
            else -> SheetLook.Sand
        }
    }
private val Pal: KhPalette get() = KhThemeState.current.palette

/** Side padding of the sheet body; chat-app groups run edge to edge. */
private val bodyPadding: Dp get() = when (Look) { SheetLook.Chat -> 0.dp; SheetLook.Minimal -> 20.dp; else -> 16.dp }

internal data class SheetOption(val key: String, val title: String, val detail: String = "", val risky: Boolean = false)

internal enum class SheetTone { Info, Waiting, Danger }

@Composable
internal fun SettingsSheet(
    title: String,
    subtitle: String?,
    close: () -> Unit,
    saveEnabled: Boolean,
    save: () -> Unit,
    saveLabel: String = "保存",
    content: @Composable ColumnScope.() -> Unit,
) {
    val look = Look
    val p = Pal
    val shown = remember { MutableTransitionState(false).apply { targetState = true } }
    val dismiss = { shown.targetState = false }
    // Close once the slide-out has finished.
    LaunchedEffect(shown.currentState, shown.targetState) { if (!shown.targetState && !shown.currentState) close() }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier.fillMaxSize().clickable(remember { MutableInteractionSource() }, null, onClick = dismiss),
            contentAlignment = Alignment.BottomCenter,
        ) {
            AnimatedVisibility(
                shown,
                enter = slideInVertically(tween(240)) { it / 2 } + fadeIn(tween(200)),
                exit = slideOutVertically(tween(180)) { it / 2 } + fadeOut(tween(160)),
            ) {
                val radius = when (look) { SheetLook.Sand -> 26.dp; SheetLook.Codex -> 14.dp; SheetLook.Minimal -> 4.dp; SheetLook.Chat -> 12.dp }
                Surface(
                    Modifier.fillMaxWidth()
                        .heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.88f).dp)
                        // Taps inside the sheet must not close it.
                        .clickable(remember { MutableInteractionSource() }, null) {},
                    shape = RoundedCornerShape(topStart = radius, topEnd = radius),
                    color = when (look) { SheetLook.Sand, SheetLook.Chat -> p.paper; else -> p.surface },
                    border = if (look == SheetLook.Codex) BorderStroke(0.5.dp, p.divider) else null,
                ) {
                    Column {
                        SheetHeader(title, subtitle, dismiss)
                        Column(
                            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                                .padding(horizontal = bodyPadding).padding(top = if (look == SheetLook.Chat) 0.dp else 4.dp, bottom = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(if (look == SheetLook.Codex) 14.dp else 18.dp),
                            content = content,
                        )
                        SheetActions(dismiss, saveEnabled, saveLabel, save)
                    }
                }
            }
        }
    }
}

@Composable
private fun SheetHeader(title: String, subtitle: String?, close: () -> Unit) {
    val p = Pal
    when (Look) {
        SheetLook.Sand -> Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 10.dp, bottom = 12.dp)) {
            Box(Modifier.align(Alignment.CenterHorizontally).size(36.dp, 4.dp).clip(CircleShape).background(p.divider))
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, color = p.ink, fontSize = 19.sp, fontWeight = FontWeight.SemiBold)
                    if (!subtitle.isNullOrBlank()) Text(subtitle, color = p.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                }
                Box(Modifier.size(34.dp).clip(CircleShape).background(p.surfaceAlt).clickable(onClick = close).semantics { contentDescription = "关闭" }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Close, null, Modifier.size(18.dp), tint = p.muted)
                }
            }
        }
        SheetLook.Codex -> Column {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 6.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, color = p.ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    if (!subtitle.isNullOrBlank()) Text(subtitle, color = p.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Box(Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = close).semantics { contentDescription = "关闭" }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Close, null, Modifier.size(18.dp), tint = p.muted)
                }
            }
            Box(Modifier.fillMaxWidth().height(0.5.dp).background(p.divider))
            Spacer(Modifier.height(10.dp))
        }
        SheetLook.Minimal -> Column {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 18.dp, bottom = 14.dp), verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(title, color = p.ink, fontSize = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.2).sp)
                    if (!subtitle.isNullOrBlank()) Text(subtitle, color = p.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                }
                Box(Modifier.size(36.dp).clickable(onClick = close).semantics { contentDescription = "关闭" }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Close, null, Modifier.size(20.dp), tint = p.ink)
                }
            }
            Box(Modifier.padding(horizontal = 20.dp).fillMaxWidth().height(1.dp).background(p.ink))
            Spacer(Modifier.height(8.dp))
        }
        SheetLook.Chat -> Box(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
            Box(Modifier.align(Alignment.CenterStart).padding(start = 8.dp).size(36.dp).clip(CircleShape).clickable(onClick = close).semantics { contentDescription = "关闭" }, contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Close, null, Modifier.size(20.dp), tint = p.ink)
            }
            Column(Modifier.align(Alignment.Center).padding(horizontal = 52.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(title, color = p.ink, fontSize = 17.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!subtitle.isNullOrBlank()) Text(subtitle, color = p.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun SheetActions(cancel: () -> Unit, enabled: Boolean, label: String, save: () -> Unit) {
    val p = Pal
    val look = Look
    if (look == SheetLook.Codex || look == SheetLook.Minimal) Box(Modifier.fillMaxWidth().height(if (look == SheetLook.Minimal) 1.dp else 0.5.dp).background(p.divider))
    val pad = when (look) { SheetLook.Codex -> Modifier.padding(horizontal = 16.dp, vertical = 10.dp); SheetLook.Minimal -> Modifier.padding(horizontal = 20.dp, vertical = 14.dp); else -> Modifier.padding(horizontal = 16.dp, vertical = 12.dp) }
    Row(Modifier.fillMaxWidth().then(pad), horizontalArrangement = Arrangement.spacedBy(10.dp, if (look == SheetLook.Codex) Alignment.End else Alignment.Start), verticalAlignment = Alignment.CenterVertically) {
        when (look) {
            SheetLook.Sand -> {
                SheetButton("取消", Modifier.weight(1f).height(48.dp), RoundedCornerShape(14.dp), p.surfaceAlt, p.ink, null, true, cancel)
                SheetButton(label, Modifier.weight(1.6f).height(48.dp), RoundedCornerShape(14.dp), p.accent, Color.White, null, enabled, save)
            }
            SheetLook.Codex -> {
                SheetButton("取消", Modifier.height(36.dp), RoundedCornerShape(8.dp), Color.Transparent, p.ink, BorderStroke(0.5.dp, p.divider), true, cancel, 16.dp)
                SheetButton(label, Modifier.height(36.dp), RoundedCornerShape(8.dp), p.accent, Color.White, null, enabled, save, 20.dp)
            }
            SheetLook.Minimal -> {
                SheetButton("取消", Modifier.weight(1f).height(48.dp), RoundedCornerShape(2.dp), Color.Transparent, p.ink, BorderStroke(1.dp, p.ink), true, cancel)
                SheetButton(label, Modifier.weight(1f).height(48.dp), RoundedCornerShape(2.dp), p.ink, Color.White, null, enabled, save)
            }
            SheetLook.Chat -> {
                SheetButton("取消", Modifier.weight(1f).height(46.dp), RoundedCornerShape(6.dp), p.surface, p.ink, null, true, cancel)
                SheetButton(label, Modifier.weight(1f).height(46.dp), RoundedCornerShape(6.dp), p.accent, Color.White, null, enabled, save)
            }
        }
    }
}

@Composable
private fun SheetButton(
    label: String, modifier: Modifier, shape: RoundedCornerShape, fill: Color, ink: Color,
    border: BorderStroke?, enabled: Boolean, onClick: () -> Unit, horizontal: Dp = 0.dp,
) {
    Surface(
        modifier.clip(shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        shape = shape,
        color = if (enabled) fill else fill.copy(alpha = 0.35f),
        border = border,
    ) {
        Box(Modifier.padding(horizontal = horizontal), contentAlignment = Alignment.Center) {
            Text(label, color = if (enabled) ink else ink.copy(alpha = 0.7f), fontSize = 15.sp, fontWeight = if (fill == Color.Transparent || fill == Pal.surfaceAlt || fill == Pal.surface) FontWeight.Normal else FontWeight.Medium)
        }
    }
}

/** A titled block of the sheet. */
@Composable
internal fun SheetSection(title: String, trailing: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val p = Pal
    val look = Look
    Column {
        Row(
            Modifier.fillMaxWidth().padding(
                start = if (look == SheetLook.Chat) 16.dp else if (look == SheetLook.Sand) 4.dp else 0.dp,
                end = if (look == SheetLook.Chat) 16.dp else 4.dp,
                top = if (look == SheetLook.Chat) 14.dp else 0.dp,
                bottom = if (look == SheetLook.Codex) 6.dp else 8.dp,
            ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (look) {
                SheetLook.Minimal -> Text(title.uppercase(), Modifier.weight(1f), color = p.ink, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
                SheetLook.Codex -> Text(title, Modifier.weight(1f), color = p.muted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                SheetLook.Chat -> Text(title, Modifier.weight(1f), color = p.muted, fontSize = 13.sp)
                SheetLook.Sand -> Text(title, Modifier.weight(1f), color = p.muted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.4.sp)
            }
            if (!trailing.isNullOrBlank()) Text(trailing, color = p.muted, fontSize = 12.sp, maxLines = 1)
        }
        content()
    }
}

/** A single-choice list: cards, compact rows, hairline rows or chat-app cells, by theme. */
@Composable
internal fun SheetOptionList(options: List<SheetOption>, current: String, choose: (String) -> Unit) {
    val p = Pal
    val look = Look
    when (look) {
        SheetLook.Sand, SheetLook.Chat -> Surface(
            Modifier.fillMaxWidth(),
            shape = if (look == SheetLook.Sand) RoundedCornerShape(16.dp) else RoundedCornerShape(0.dp),
            color = p.surface,
            border = if (look == SheetLook.Sand) BorderStroke(0.5.dp, p.divider) else null,
        ) {
            Column {
                options.forEachIndexed { index, option ->
                    if (index > 0) Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(p.divider))
                    SheetOptionRow(option, option.key == current) { choose(option.key) }
                }
            }
        }
        SheetLook.Codex -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            options.forEach { option -> SheetOptionRow(option, option.key == current) { choose(option.key) } }
        }
        SheetLook.Minimal -> Column {
            options.forEachIndexed { index, option ->
                if (index > 0) Box(Modifier.fillMaxWidth().height(0.5.dp).background(p.divider))
                SheetOptionRow(option, option.key == current) { choose(option.key) }
            }
        }
    }
}

@Composable
private fun SheetOptionRow(option: SheetOption, picked: Boolean, onClick: () -> Unit) {
    val p = Pal
    val look = Look
    val tint = if (option.risky) p.danger else if (look == SheetLook.Minimal) p.ink else p.accent
    val fill by animateColorAsState(
        when {
            !picked -> Color.Transparent
            look == SheetLook.Codex -> if (option.risky) p.dangerContainer else p.selected
            look == SheetLook.Sand -> if (option.risky) p.dangerContainer.copy(alpha = 0.55f) else p.selected.copy(alpha = 0.45f)
            else -> Color.Transparent
        },
        tween(160), label = "sheet-option",
    )
    val shape = if (look == SheetLook.Codex) RoundedCornerShape(8.dp) else RoundedCornerShape(0.dp)
    val padding = when (look) {
        SheetLook.Codex -> Modifier.padding(horizontal = 10.dp, vertical = 8.dp)
        SheetLook.Minimal -> Modifier.padding(vertical = 13.dp)
        else -> Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
    }
    Row(
        Modifier.fillMaxWidth().clip(shape).background(fill)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { selected = picked }
            .then(padding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    option.title,
                    Modifier.weight(1f, fill = false),
                    color = if (option.risky) p.danger else if (picked && look != SheetLook.Chat) (if (look == SheetLook.Minimal) p.ink else p.accent) else p.ink,
                    fontSize = if (look == SheetLook.Codex) 14.sp else 15.sp,
                    fontWeight = if (picked) (if (look == SheetLook.Minimal) FontWeight.Bold else FontWeight.SemiBold) else FontWeight.Normal,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (option.risky) {
                    Spacer(Modifier.width(6.dp))
                    RiskTag()
                }
            }
            if (option.detail.isNotBlank()) Text(
                option.detail, color = p.muted, fontSize = if (look == SheetLook.Codex) 12.sp else 12.5.sp, lineHeight = 17.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp),
            )
        }
        Spacer(Modifier.width(10.dp))
        when (look) {
            SheetLook.Sand -> if (picked) Icon(Icons.Default.CheckCircle, null, Modifier.size(22.dp), tint = tint)
                else Box(Modifier.size(20.dp).border(1.5.dp, p.divider, CircleShape))
            SheetLook.Codex -> Box(Modifier.size(18.dp)) { if (picked) Icon(Icons.Default.Check, null, Modifier.size(18.dp), tint = tint) }
            SheetLook.Minimal -> Box(Modifier.size(18.dp).border(1.dp, if (picked) p.ink else p.divider, CircleShape), contentAlignment = Alignment.Center) {
                if (picked) Box(Modifier.size(10.dp).clip(CircleShape).background(if (option.risky) p.danger else p.ink))
            }
            SheetLook.Chat -> Box(Modifier.size(22.dp)) { if (picked) Icon(Icons.Default.Check, null, Modifier.size(22.dp), tint = tint) }
        }
    }
}

@Composable
private fun RiskTag() {
    val p = Pal
    val shape = when (Look) { SheetLook.Minimal -> RoundedCornerShape(1.dp); SheetLook.Codex, SheetLook.Chat -> RoundedCornerShape(4.dp); SheetLook.Sand -> RoundedCornerShape(50) }
    Box(
        Modifier.clip(shape).then(if (Look == SheetLook.Minimal) Modifier.border(0.75.dp, p.danger, shape) else Modifier.background(p.dangerContainer))
            .padding(horizontal = 6.dp, vertical = 1.dp),
    ) { Text("高风险", color = p.danger, fontSize = 10.sp, fontWeight = FontWeight.Medium) }
}

/**
 * Few short choices (thinking strength, speed, work mode): a segmented control
 * when they fit, else a row of chips that scrolls sideways.
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun SheetSegments(options: List<SheetOption>, current: String, choose: (String) -> Unit) {
    val p = Pal
    val look = Look
    val fits = options.size <= 4 && options.all { it.title.length <= 6 }
    val outer = if (look == SheetLook.Chat) Modifier.padding(horizontal = 16.dp) else Modifier
    if (fits && look != SheetLook.Chat) {
        val trackShape = when (look) { SheetLook.Sand -> RoundedCornerShape(14.dp); SheetLook.Codex -> RoundedCornerShape(8.dp); else -> RoundedCornerShape(2.dp) }
        val thumbShape = when (look) { SheetLook.Sand -> RoundedCornerShape(11.dp); SheetLook.Codex -> RoundedCornerShape(6.dp); else -> RoundedCornerShape(0.dp) }
        Row(
            outer.fillMaxWidth().clip(trackShape)
                .then(if (look == SheetLook.Minimal) Modifier.border(1.dp, p.ink, trackShape) else Modifier.background(p.surfaceAlt))
                .padding(if (look == SheetLook.Minimal) 0.dp else 3.dp),
        ) {
            options.forEachIndexed { index, option ->
                val picked = option.key == current
                val bg by animateColorAsState(
                    when {
                        !picked -> Color.Transparent
                        look == SheetLook.Minimal -> p.ink
                        else -> p.surface
                    }, tween(160), label = "segment",
                )
                if (look == SheetLook.Minimal && index > 0) Box(Modifier.width(1.dp).height(40.dp).background(p.ink))
                Box(
                    Modifier.weight(1f).height(if (look == SheetLook.Codex) 32.dp else if (look == SheetLook.Minimal) 40.dp else 36.dp)
                        .clip(thumbShape).background(bg)
                        .then(if (picked && look == SheetLook.Codex) Modifier.border(0.5.dp, p.divider, thumbShape) else Modifier)
                        .clickable(role = Role.RadioButton) { choose(option.key) }
                        .semantics { selected = picked },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        option.title,
                        color = when { look == SheetLook.Minimal && picked -> Color.White; picked -> p.accent; else -> p.muted },
                        fontSize = if (look == SheetLook.Codex) 13.sp else 14.sp,
                        fontWeight = if (picked) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1,
                    )
                }
            }
        }
    } else {
        // Wraps onto more lines instead of hiding choices off the edge.
        FlowRow(outer.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { option ->
                val picked = option.key == current
                val shape = when (look) { SheetLook.Sand -> RoundedCornerShape(50); SheetLook.Codex -> RoundedCornerShape(8.dp); SheetLook.Minimal -> RoundedCornerShape(2.dp); SheetLook.Chat -> RoundedCornerShape(4.dp) }
                val (bg, ink, border) = when (look) {
                    SheetLook.Sand -> Triple(if (picked) p.accent else p.surface, if (picked) Color.White else p.ink, if (picked) null else BorderStroke(0.5.dp, p.divider))
                    SheetLook.Codex -> Triple(if (picked) p.selected else Color.Transparent, if (picked) p.accent else p.ink, BorderStroke(0.5.dp, if (picked) p.accent.copy(alpha = 0.5f) else p.divider))
                    SheetLook.Minimal -> Triple(if (picked) p.ink else Color.Transparent, if (picked) Color.White else p.ink, BorderStroke(0.75.dp, if (picked) p.ink else p.ink.copy(alpha = 0.3f)))
                    SheetLook.Chat -> Triple(if (picked) p.accent else p.surface, if (picked) Color.White else p.ink, null)
                }
                Surface(
                    Modifier.clip(shape).clickable(role = Role.RadioButton) { choose(option.key) }.semantics { selected = picked },
                    shape = shape, color = bg, border = border,
                ) {
                    Text(
                        option.title,
                        Modifier.padding(horizontal = 14.dp, vertical = if (look == SheetLook.Codex) 6.dp else 8.dp),
                        color = ink, fontSize = if (look == SheetLook.Codex) 13.sp else 14.sp,
                        fontWeight = if (picked) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1,
                    )
                }
            }
        }
    }
}

/** A short note: plain for info, tinted for "waiting" and "danger". */
@Composable
internal fun SheetNote(text: String, tone: SheetTone = SheetTone.Info) {
    val p = Pal
    val look = Look
    val ink = when (tone) { SheetTone.Info -> p.muted; SheetTone.Waiting -> p.waitingInk; SheetTone.Danger -> p.danger }
    val horizontal = if (look == SheetLook.Chat) 16.dp else 0.dp
    if (tone == SheetTone.Info) {
        Text(text, Modifier.fillMaxWidth().padding(horizontal = horizontal + if (look == SheetLook.Sand) 4.dp else 0.dp), color = ink, fontSize = 12.5.sp, lineHeight = 18.sp)
        return
    }
    val bg = if (tone == SheetTone.Waiting) p.waitingContainer else p.dangerContainer
    when (look) {
        SheetLook.Minimal, SheetLook.Codex -> Row(Modifier.fillMaxWidth().padding(horizontal = horizontal).height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(ink))
            Text(text, Modifier.padding(start = 10.dp), color = ink, fontSize = 12.5.sp, lineHeight = 18.sp)
        }
        else -> Surface(
            Modifier.fillMaxWidth().padding(horizontal = if (look == SheetLook.Chat) 16.dp else 0.dp),
            shape = RoundedCornerShape(if (look == SheetLook.Sand) 12.dp else 6.dp),
            color = bg,
        ) { Text(text, Modifier.padding(horizontal = 12.dp, vertical = 9.dp), color = ink, fontSize = 12.5.sp, lineHeight = 18.sp) }
    }
}

@Composable
internal fun SheetLoading(text: String) {
    val p = Pal
    Row(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = if (Look == SheetLook.Minimal) p.ink else p.accent)
        Spacer(Modifier.width(10.dp))
        Text(text, color = p.muted, fontSize = 13.sp)
    }
}
