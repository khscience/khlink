package vip.fengzhu.bridge

import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.getValue
import android.view.View
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp

/**
 * The one set of motion values the app uses, so every animation feels like the
 * same hand moved it: springs rather than fixed-length curves, short enough
 * never to make anyone wait.
 */
object KhMotion {
    /** Screen-sized moves: list <-> conversation. Settles in ~350 ms, no visible bounce. */
    fun <T> screen(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.9f, stiffness = 380f)
    /** Things that appear or change size: cards, banners, sections. */
    fun <T> element(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.82f, stiffness = Spring.StiffnessMediumLow)
    /** Small emphasis: a badge popping in, a pressed button. A little bounce. */
    fun <T> pop(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.55f, stiffness = Spring.StiffnessMedium)
    /** Indicators sliding between fixed slots (tabs, segmented toggles). */
    fun <T> slide(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.78f, stiffness = 500f)

    val screenBounds = BoundsTransform { _: Rect, _: Rect -> spring(dampingRatio = 0.9f, stiffness = 380f) }
    val offsetSpring = spring(dampingRatio = 0.9f, stiffness = 380f, visibilityThreshold = IntOffset(1, 1))
    val sizeSpring = spring(dampingRatio = 0.9f, stiffness = 380f, visibilityThreshold = IntSize(1, 1))
}

/**
 * A touch that gives: the element settles to [pressed] scale while held and
 * springs back on release, on the same interaction source as its click so the
 * ripple and the scale move together.
 */
fun Modifier.pressScale(interaction: androidx.compose.foundation.interaction.InteractionSource, pressed: Float = 0.975f): Modifier = composed {
    val down by interaction.collectIsPressedAsState()
    val scale by androidx.compose.animation.core.animateFloatAsState(
        if (down) pressed else 1f,
        if (down) spring(dampingRatio = 1f, stiffness = 1400f) else spring(dampingRatio = 0.6f, stiffness = 520f),
        label = "press-scale",
    )
    graphicsLayer { scaleX = scale; scaleY = scale }
}

/** Haptic feedback on the view the user is touching; silent where the system has it off. */
class KhHaptics(private val view: View) {
    /** An approval or a turn finishing. Sending waits for its real receipt. */
    fun confirm() = KhVibration.touch(view, GentleCue.Confirm)
    /** Something failed. */
    fun reject() = KhVibration.touch(view, GentleCue.Reject)
    /** A light tick: switching tabs, stepping along the message rail. */
    fun tick() = KhVibration.touch(view, GentleCue.Tick)
    /** Needs you now: the computer is waiting for an answer. */
    fun attention() = KhVibration.touch(view, GentleCue.Attention)
}

/** Compose's built-in long press/selection feedback uses the same gentle cue. */
@Composable
fun GentleHapticProvider(content: @Composable () -> Unit) {
    val haptics = rememberHaptics()
    val feedback = remember(haptics) { object : androidx.compose.ui.hapticfeedback.HapticFeedback {
        override fun performHapticFeedback(hapticFeedbackType: androidx.compose.ui.hapticfeedback.HapticFeedbackType) = haptics.tick()
    } }
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalHapticFeedback provides feedback, content = content)
}

@Composable
fun rememberHaptics(): KhHaptics {
    val view = LocalView.current
    return remember(view) { KhHaptics(view) }
}

// The list <-> conversation transition shares a card's bounds and its title
// with the conversation screen. The scopes travel down as locals so the list
// row and the screen can take part without threading them through every call.
@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedScope = compositionLocalOf<SharedTransitionScope?> { null }
val LocalNavVisibilityScope = compositionLocalOf<AnimatedVisibilityScope?> { null }

/** Id of the conversation just closed: its row flashes once when the list comes back. */
val LocalReturnedThreadId = compositionLocalOf<String?> { null }
/** Messages that get a centered time above them in the chat layout. */
val LocalChatTimeMarks = compositionLocalOf<Set<String>> { emptySet() }
/** Your name and avatar address, for your bubbles in the chat layout. */
val LocalSelfAvatar = compositionLocalOf<Pair<String, String?>> { "我" to null }
/** The open conversation's session (id to title), whose avatar the agent's bubbles carry. */
val LocalChatPeer = compositionLocalOf<Pair<String, String>?> { null }

/** The card that grows into a conversation (and shrinks back into it). */
@OptIn(ExperimentalSharedTransitionApi::class)
fun Modifier.sharedThreadCard(threadId: String): Modifier = composed {
    val shared = LocalSharedScope.current ?: return@composed this
    val visibility = LocalNavVisibilityScope.current ?: return@composed this
    with(shared) {
        this@composed.sharedBounds(
            rememberSharedContentState("thread-card-$threadId"),
            visibility,
            boundsTransform = KhMotion.screenBounds,
            resizeMode = SharedTransitionScope.ResizeMode.RemeasureToBounds,
            clipInOverlayDuringTransition = OverlayClip(RoundedCornerShape(12.dp)),
        )
    }
}

/** The title that travels between the card and the top bar. */
@OptIn(ExperimentalSharedTransitionApi::class)
fun Modifier.sharedThreadTitle(threadId: String): Modifier = composed {
    val shared = LocalSharedScope.current ?: return@composed this
    val visibility = LocalNavVisibilityScope.current ?: return@composed this
    with(shared) {
        this@composed.sharedBounds(
            rememberSharedContentState("thread-title-$threadId"),
            visibility,
            boundsTransform = KhMotion.screenBounds,
            resizeMode = SharedTransitionScope.ResizeMode.scaleToBounds(),
        )
    }
}
