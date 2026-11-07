@file:Suppress("DEPRECATION")

package vip.fengzhu.bridge

import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.composed
import androidx.compose.runtime.SideEffect
import androidx.compose.animation.ExperimentalSharedTransitionApi
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings as AndroidSettings
import android.util.Base64
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream
import androidx.activity.compose.BackHandler
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.ArrowBackIos
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.CallSplit
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Compress
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.ScheduleSend
import androidx.compose.material.icons.filled.AltRoute
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Shapes
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.semantics.Role
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.setValue
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeOut
import androidx.compose.animation.expandVertically
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.LocalIndication
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownTypography
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import kotlin.math.sin

// Colors come from the chosen theme (KhThemeState), read as Compose state.
private val P: KhPalette get() = KhThemeState.current.palette
/** The chat-app layout (bottom tabs, avatar rows, bubbles) of the chosen theme. */
private val ChatLayout: Boolean get() = KhThemeState.current.chatLayout
private val CodexLayout: Boolean get() = KhThemeState.current.codexLayout
// Flat rows and document-like messages: the Codex theme and the minimal one.
private val FlatLayout: Boolean get() = KhThemeState.current.codexLayout || KhThemeState.current.flatLayout
private val Ink: Color get() = P.ink
private val Accent: Color get() = P.accent
private val Warm: Color get() = P.warm
private val Info: Color get() = P.info
private val Paper: Color get() = P.paper
private val SurfaceBase: Color get() = P.surface
private val SurfaceAlt: Color get() = P.surfaceAlt
private val Divider: Color get() = P.divider
private val Muted: Color get() = P.muted
private val Danger: Color get() = P.danger
private const val HISTORY_PAGING_KEY = "history-paging"
private const val HISTORY_PREFETCH_DISTANCE = 8
private const val MESSAGE_RAIL_LIMIT = 20

private data class UserMessageAnchor(
    val key: String,
    val renderedIndex: Int,
    val ordinal: Int,
)

class MainActivity : ComponentActivity() {
    private val deepLink = mutableStateOf<Uri?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        // Light bars with dark icons, as the app's surfaces are light in every theme.
        enableEdgeToEdge(
            statusBarStyle = androidx.activity.SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = androidx.activity.SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        KhThemeState.load(this)
        deepLink.value = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data
        intent?.getStringExtra(EXTRA_OPEN_THREAD)?.let { OpenThreadRequests.pending.value = it }
        setContent {
            GentleHapticProvider { KhLinkTheme { BridgeApp(deepLink = deepLink.value, onDeepLinkHandled = { deepLink.value = null }) } }
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == Intent.ACTION_VIEW) deepLink.value = intent.data
        intent.getStringExtra(EXTRA_OPEN_THREAD)?.let { OpenThreadRequests.pending.value = it }
    }
    override fun onResume() { super.onResume(); (application as FengzhuApplication).repository.appVisible = true }
    override fun onPause() { (application as FengzhuApplication).repository.appVisible = false; super.onPause() }
    companion object { const val EXTRA_OPEN_THREAD = "openThreadId" }
}

private enum class AppSurface { Legal, Recovering, Login, Onboarding, Home }

@Composable
private fun BridgeApp(vm: BridgeViewModel = viewModel(), deepLink: Uri? = null, onDeepLinkHandled: () -> Unit = {}) {
    // The khlink://oauth/callback deep link returns from the khsci.com login page.
    LaunchedEffect(deepLink) {
        val uri = deepLink ?: return@LaunchedEffect
        if (uri.scheme == "khlink" && uri.host == "oauth") {
            val code = uri.getQueryParameter("code")
            val state = uri.getQueryParameter("state")
            if (!code.isNullOrBlank() && !state.isNullOrBlank()) vm.completeKhsciLogin(code, state)
        }
        onDeepLinkHandled()
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val authenticated by vm.authenticated.collectAsState()
    val authReady by vm.authReady.collectAsState()
    val legalAccepted by vm.legalAccepted.collectAsState()
    val onboardingPending by vm.onboardingPending.collectAsState()
    // A new install asks for notifications inside the first-run guide, after
    // saying what they are for, not before the first screen.
    LaunchedEffect(Unit) { if (Build.VERSION.SDK_INT >= 33 && !vm.onboardingPending.value && vm.legalAccepted.value) permission.launch(Manifest.permission.POST_NOTIFICATIONS) }
    val update by vm.updateAvailable.collectAsState()
    val updateDownload by vm.updateDownload.collectAsState()
    val surface = when {
        !legalAccepted -> AppSurface.Legal
        !authReady -> AppSurface.Recovering
        !authenticated -> AppSurface.Login
        onboardingPending -> AppSurface.Onboarding
        else -> AppSurface.Home
    }
    AnimatedContent(
        targetState = surface,
        transitionSpec = {
            (fadeIn(animationSpec = tween(260)) + slideInVertically(animationSpec = tween(320), initialOffsetY = { it / 24 })) togetherWith
                (fadeOut(animationSpec = tween(180)) + slideOutVertically(animationSpec = tween(220), targetOffsetY = { -it / 32 }))
        },
        label = "kh-link-surface-transition",
    ) { current ->
        when (current) {
            AppSurface.Legal -> LegalConsentScreen(vm)
            AppSurface.Recovering -> StartupRecoveryScreen()
            AppSurface.Login -> LoginScreen(vm)
            AppSurface.Onboarding -> OnboardingScreen(vm)
            AppSurface.Home -> HomeScreen(vm)
        }
    }
    update?.let { UpdateDialog(it, updateDownload, vm::downloadUpdate, vm::cancelUpdateDownload, vm::installDownloadedUpdate, vm::postponeUpdate, vm::skipUpdate) }
    val suggestAccount by vm.suggestAccountLogin.collectAsState()
    if (suggestAccount && surface == AppSurface.Home) DirectAccountSuggestionDialog(vm::switchToAccountLogin, vm::dismissAccountSuggestion)
}

@Composable
private fun DirectAccountSuggestionDialog(useAccount: () -> Unit, keepWaiting: () -> Unit) {
    AlertDialog(
        onDismissRequest = keepWaiting,
        title = { Text("直连一直连不上") },
        text = {
            Text("已经重试了好几次，还是连不上电脑。可能是电脑重启过、换了网络，或者当前网络不支持直连。\n\n" +
                "建议改用 khLink 账号登录，通过官方服务器中继连接，在哪儿都能连上，更稳定。每月有免费流量，khQuant VIP 不限。")
        },
        confirmButton = { TextButton(useAccount) { Text("用账号登录", color = Accent, fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(keepWaiting) { Text("继续等待直连") } },
    )
}

// "KH Link" wordmark drawn as text (sharp at any size), using the logo's
// deep and light blues.
private val BrandBlue: Color get() = P.brand
private val BrandBlueLight: Color get() = P.brandLight

@Composable
private fun KhLinkWordmark(size: androidx.compose.ui.unit.TextUnit) {
    Text(
        androidx.compose.ui.text.buildAnnotatedString {
            pushStyle(androidx.compose.ui.text.SpanStyle(color = BrandBlue, fontWeight = FontWeight.ExtraBold)); append("kh"); pop()
            pushStyle(androidx.compose.ui.text.SpanStyle(color = BrandBlueLight, fontWeight = FontWeight.SemiBold)); append("Link"); pop()
        },
        fontSize = size,
        letterSpacing = (-0.3).sp,
        maxLines = 1,
        modifier = Modifier.semantics { contentDescription = "khLink" },
    )
}

@Composable
private fun StartupRecoveryScreen() {
    Box(Modifier.fillMaxSize().background(Paper).systemBarsPadding(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Image(
                painter = painterResource(R.drawable.khlink_logo),
                contentDescription = "khLink",
                modifier = Modifier.size(84.dp),
                contentScale = ContentScale.Fit,
            )
            CircularProgressIndicator(color = Accent)
            Text("正在恢复 khLink 连接", style = MaterialTheme.typography.titleMedium)
            Text("正在验证本机安全密钥，请稍候", color = Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

// First-run guide for a fresh install, between login and the home screen.
// Every choice is the same setting the "我" page changes later; skipping keeps
// the defaults.
@Composable
private fun OnboardingScreen(vm: BridgeViewModel) {
    var step by rememberSaveable { mutableStateOf(OnboardingStep.Theme) }
    var trying by rememberSaveable { mutableStateOf(false) }
    if (trying) { ThemeTryOut(vm) { trying = false }; return }
    Column(Modifier.fillMaxSize().background(Paper).systemBarsPadding().padding(horizontal = 20.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OnboardingStep.entries.forEach {
                    Box(Modifier.height(4.dp).width(if (it == step) 22.dp else 8.dp).background(if (it.ordinal <= step.ordinal) Accent else Divider, CircleShape))
                }
            }
            // Kept in place (invisible) on the last step so the title does not jump.
            val last = step == OnboardingStep.Finish
            TextButton({ vm.finishOnboarding() }, Modifier.alpha(if (last) 0f else 1f), enabled = !last) { Text("跳过", color = Muted) }
        }
        Text(step.title, Modifier.padding(top = 16.dp, bottom = 6.dp), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = Ink)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AnimatedContent(step, label = "onboarding-step") { current ->
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    when (current) {
                        OnboardingStep.Theme -> OnboardingTheme { trying = true }
                        OnboardingStep.Agents -> OnboardingAgents(vm)
                        OnboardingStep.Alerts -> OnboardingAlerts(vm)
                        OnboardingStep.Finish -> OnboardingFinish()
                    }
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            step.previous?.let { back ->
                OutlinedButton({ step = back }, Modifier.weight(1f).height(48.dp), shape = RoundedCornerShape(12.dp)) { Text("上一步", color = Ink) }
            }
            Button({ step.next?.let { step = it } ?: vm.finishOnboarding() }, Modifier.weight(1f).height(48.dp), shape = RoundedCornerShape(12.dp)) {
                Text(if (step.next == null) "开始使用" else "下一步", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun OnboardingTheme(tryIt: () -> Unit) {
    val context = LocalContext.current
    Text("点一下就能看到效果，之后也可以在“我 → 主题”里换。", color = Muted, style = MaterialTheme.typography.bodyMedium)
    KhLinkSkinCatalog.all.chunked(2).forEach { pair ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            pair.forEach { skin ->
                val chosen = skin.id == KhThemeState.current.id
                Surface(Modifier.weight(1f).clickable { KhThemeState.select(context, skin) }, shape = RoundedCornerShape(14.dp),
                    color = if (chosen) P.selected else SurfaceBase, border = BorderStroke(if (chosen) 1.5.dp else 1.dp, if (chosen) Accent else Divider)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            listOf(skin.palette.paper, skin.palette.userBubble, skin.palette.accent, skin.palette.runningBorder).forEach {
                                Box(Modifier.size(14.dp).background(it, CircleShape).border(0.5.dp, skin.palette.divider, CircleShape))
                            }
                        }
                        Text(skin.name, fontWeight = FontWeight.SemiBold, color = Ink, style = MaterialTheme.typography.bodyMedium)
                        Text(skin.description, color = Muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
    // A sample conversation in the picked theme, so the choice shows at once
    // (a new account has no conversations of its own to look at yet).
    ThemePreviewChat()
    // The real app, not a drawing of it: the home list and any conversation,
    // in whichever theme is picked on the bar at the bottom.
    OutlinedButton(tryIt, Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, Accent)) {
        Text("看看实际效果", color = Accent, fontWeight = FontWeight.SemiBold)
    }
    Text("会打开真实的首页，也可以点进对话看看；底部可以切换主题，看完点“完成”。", color = Muted, style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun ThemePreviewChat() {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = P.paper, border = BorderStroke(1.dp, P.divider)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("效果预览", color = P.muted, style = MaterialTheme.typography.labelMedium)
            // A row of the conversation list, with a running task.
            Surface(shape = RoundedCornerShape(12.dp), color = P.runningContainer, border = BorderStroke(1.dp, P.runningBorder)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("整理周末出游计划", color = P.ink, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                        Text("正在查看天气和路线…", color = P.muted, style = MaterialTheme.typography.bodySmall)
                    }
                    Surface(shape = RoundedCornerShape(50), color = P.runningChip) {
                        Text("运行中", Modifier.padding(horizontal = 8.dp, vertical = 3.dp), color = P.runningInk, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            // A short exchange inside a conversation.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Surface(shape = RoundedCornerShape(14.dp, 4.dp, 14.dp, 14.dp), color = P.userBubble) {
                    Text("周六想去爬山，帮我看看天气", Modifier.padding(horizontal = 12.dp, vertical = 8.dp), color = P.ink, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Row(Modifier.fillMaxWidth()) {
                Surface(Modifier.fillMaxWidth(0.85f), shape = RoundedCornerShape(4.dp, 14.dp, 14.dp, 14.dp), color = P.surface, border = BorderStroke(0.5.dp, P.divider)) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                        Text("周六晴，最高 22℃，适合爬山。", color = P.ink, style = MaterialTheme.typography.bodyMedium)
                        Text("建议早上八点前出发，带一件薄外套。", color = P.ink, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Surface(shape = RoundedCornerShape(14.dp, 4.dp, 14.dp, 14.dp), color = P.userBubble) {
                    Text("好，那就定周六", Modifier.padding(horizontal = 12.dp, vertical = 8.dp), color = P.ink, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

// Theme try-out from the guide: the real home screen (and any conversation
// opened from it), with a floating bar to switch themes and go back.
@Composable
private fun ThemeTryOut(vm: BridgeViewModel, back: () -> Unit) {
    val context = LocalContext.current
    // Back from the home screen returns to the guide; inside a conversation
    // the home screen's own back handling comes first.
    BackHandler(onBack = back)
    Box(Modifier.fillMaxSize()) {
        CompositionLocalProvider(LocalThemePreview provides true) { HomeScreen(vm) }
        // A new account has no conversations yet: lay the sample over the
        // empty list so the theme still shows on the real screen.
        val threads by vm.threads.collectAsState()
        if (threads.isEmpty()) {
            Box(Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(start = 12.dp, end = 12.dp, top = 120.dp)) { ThemePreviewChat() }
        }
        Surface(Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(start = 12.dp, end = 12.dp, bottom = 84.dp).fillMaxWidth(),
            shape = RoundedCornerShape(16.dp), color = SurfaceBase, shadowElevation = 10.dp, border = BorderStroke(1.dp, Divider)) {
            // One row, so it covers as little of the real screen as possible.
            Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    KhLinkSkinCatalog.all.forEach { skin ->
                        val on = skin.id == KhThemeState.current.id
                        Surface(Modifier.clickable { KhThemeState.select(context, skin) }, shape = RoundedCornerShape(10.dp),
                            color = if (on) P.selected else SurfaceBase, border = BorderStroke(if (on) 1.5.dp else 1.dp, if (on) Accent else Divider)) {
                            Text(skin.name.removeSuffix("主题").removeSuffix(" 风格"), Modifier.padding(horizontal = 10.dp, vertical = 7.dp), color = Ink, style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
                Spacer(Modifier.width(6.dp))
                Button(back, Modifier.height(38.dp), shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(horizontal = 14.dp)) { Text("完成", fontWeight = FontWeight.SemiBold) }
            }
        }
    }
}

@Composable
private fun OnboardingAgents(vm: BridgeViewModel) {
    val consent by vm.claudeConsent.collectAsState()
    val visible by vm.visibleAgents.collectAsState()
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = SurfaceBase, border = BorderStroke(1.dp, Divider)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Claude 远程控制", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, color = Ink)
                Switch(consent.enabled, { vm.setClaudeConsent(it) })
            }
            Text(CLAUDE_REMOTE_NOTICE, color = Muted, style = MaterialTheme.typography.bodySmall)
            Text(if (consent.enabled) "已开启：可以在手机上查看和操作电脑上的 Claude。" else "未开启：不显示也不操作 Claude，其他智能体不受影响。",
                color = if (consent.enabled) Accent else Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
    Text("首页显示的智能体", Modifier.padding(top = 4.dp), fontWeight = FontWeight.SemiBold, color = Ink)
    Text("只留你在用的，切换更快；最多 $MAX_HOME_AGENTS 个，至少 1 个。", color = Muted, style = MaterialTheme.typography.bodySmall)
    HOME_AGENT_IDS.forEach { id ->
        val on = id in visible
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable {
            val next = if (on) visible - id else visible + id
            if (next.isNotEmpty() && next.size <= MAX_HOME_AGENTS) vm.saveVisibleAgents(next)
        }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(on, null)
            Text(onboardingAgentName(id), color = Ink)
        }
    }
}

private fun onboardingAgentName(id: String) = when (id) {
    "codex" -> "Codex"; "claude" -> "Claude"; "dsh" -> "DeepSeek Harness"; "hermes" -> "Hermes"; "pi" -> "Pi"; "antigravity" -> "反重力"; else -> id
}

@Composable
private fun OnboardingAlerts(vm: BridgeViewModel) {
    val context = LocalContext.current
    val power = remember { context.getSystemService(android.os.PowerManager::class.java) }
    fun notificationsOn() = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
    fun backgroundOn() = runCatching { power?.isIgnoringBatteryOptimizations(context.packageName) == true }.getOrDefault(true)
    var notifications by remember { mutableStateOf(notificationsOn()) }
    var background by remember { mutableStateOf(backgroundOn()) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) { notifications = notificationsOn(); background = backgroundOn() } }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notifications = notificationsOn() }
    val light by vm.lightMode.collectAsState()
    OnboardingSettingRow("任务提醒", "智能体请求批准、向你提问或跑完一轮时通知你。", if (notifications) "已开启" else null, "开启") {
        if (Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else runCatching { context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    OnboardingSettingRow("后台运行", "离开 khLink 后仍能收到提醒、发出排队的消息。ColorOS 还要在应用设置的“耗电管理”里允许后台行为。", if (background) "已允许" else null, "允许") {
        runCatching {
            @Suppress("BatteryLife")
            context.startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { runCatching { context.startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
    }
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = SurfaceBase, border = BorderStroke(1.dp, Divider)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("轻量模式", fontWeight = FontWeight.SemiBold, color = Ink)
                Text("命令、工具输出和截图留在电脑上，点开时再取回，省流量。", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.width(10.dp))
            Switch(light, { vm.saveLightMode(it) })
        }
    }
    val autoUpdate by vm.autoDownloadUpdates.collectAsState()
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = SurfaceBase, border = BorderStroke(1.dp, Divider)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("后台下载更新", fontWeight = FontWeight.SemiBold, color = Ink)
                Text("发现新版本时在后台自动下载，下好后提醒你安装。", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.width(10.dp))
            Switch(autoUpdate, { vm.saveAutoDownloadUpdates(it) })
        }
    }
}

@Composable
private fun OnboardingSettingRow(title: String, text: String, doneLabel: String?, action: String, onAction: () -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = SurfaceBase, border = BorderStroke(1.dp, Divider)) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, fontWeight = FontWeight.SemiBold, color = Ink)
                Text(text, color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.width(10.dp))
            if (doneLabel != null) Text(doneLabel, color = Accent, style = MaterialTheme.typography.labelLarge)
            else FilledTonalButton(onAction, colors = ButtonDefaults.filledTonalButtonColors(containerColor = P.selected, contentColor = Accent)) { Text(action, fontWeight = FontWeight.SemiBold) }
        }
    }
}

@Composable
private fun OnboardingFinish() {
    Image(painterResource(R.drawable.khlink_logo), "khLink", Modifier.size(72.dp).padding(top = 8.dp), contentScale = ContentScale.Fit)
    Text("设置好了。电脑上正在跑的会话会出现在首页，点开就能接着聊、批准操作、回答问题。", color = Ink, style = MaterialTheme.typography.bodyLarge)
    Text("主题、智能体、提醒、轻量模式和后台下载更新以后都能在“我”页面里改。", color = Muted, style = MaterialTheme.typography.bodyMedium)
}

@Composable
private fun LegalConsentScreen(vm: BridgeViewModel) {
    var agreement by rememberSaveable { mutableStateOf(false) }
    var privacy by rememberSaveable { mutableStateOf(false) }
    var diagnostics by rememberSaveable { mutableStateOf(false) }
    var analytics by rememberSaveable { mutableStateOf(false) }
    var document by rememberSaveable { mutableStateOf<String?>(null) }
    Column(
        Modifier.fillMaxSize().background(Paper).systemBarsPadding().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(
                    painter = painterResource(R.drawable.khlink_logo),
                    contentDescription = "khLink",
                    modifier = Modifier.size(52.dp),
                    contentScale = ContentScale.Fit,
                )
                Spacer(Modifier.width(12.dp))
                KhLinkWordmark(30.sp)
            }
            Text("使用前请阅读并同意以下文件。诊断与产品分析可单独选择，默认不会启用。", color = Muted)
            ConsentRow("我已阅读并同意《khLink 用户协议》", agreement, change = { agreement = it }, open = { document = "agreement" })
            ConsentRow("我已阅读并同意《khLink 隐私政策》", privacy, change = { privacy = it }, open = { document = "privacy" })
            ConsentRow("允许发送脱敏崩溃诊断", diagnostics, change = { diagnostics = it }, open = {})
            ConsentRow("允许匿名产品分析", analytics, change = { analytics = it }, open = {})
            Text("协议和隐私政策已内置在 App 中，版本更新时会在启动阶段提示重新确认。", color = Muted, style = MaterialTheme.typography.bodySmall)
            Button(
                onClick = { vm.acceptLegal(agreement, privacy, diagnostics, analytics) },
                modifier = Modifier.fillMaxWidth().height(48.dp),
                enabled = agreement && privacy,
                shape = RoundedCornerShape(12.dp),
            ) { Text("继续") }
        }
    }
    document?.let { LegalDocumentDialog(it) { document = null } }
}

@Composable
private fun ConsentRow(text: String, checked: Boolean, change: (Boolean) -> Unit, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { change(!checked) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.Checkbox(checked = checked, onCheckedChange = change)
        Spacer(Modifier.width(8.dp)); Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        TextButton(open) { Text("查看") }
    }
}

@Composable
private fun LegalDocumentDialog(kind: String, close: () -> Unit) {
    val title = when {
        kind == "agreement" -> "khLink 用户协议"
        kind == "privacy" -> "khLink 隐私政策"
        else -> "隐私、协议与支持"
    }
    val text = when (kind) {
        "agreement" -> LegalCopy.agreement
        "privacy" -> LegalCopy.privacy
        else -> LegalCopy.support
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            Modifier.fillMaxWidth(0.92f).heightIn(max = 620.dp),
            shape = RoundedCornerShape(18.dp),
            color = SurfaceBase,
            border = BorderStroke(1.dp, Divider.copy(alpha = 0.7f)),
        ) {
            Column(Modifier.padding(22.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = Ink)
                Spacer(Modifier.height(12.dp))
                Text(text, Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), style = MaterialTheme.typography.bodySmall, lineHeight = 19.sp, color = Ink)
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextButton(close) { Text("关闭") } }
            }
        }
    }
}

private fun formatPercent(value: Float) = "${(value.coerceIn(0f, 1f) * 100).toInt()}%"

@Composable
private fun LoginScreen(vm: BridgeViewModel) {
    var ownServer by rememberSaveable { mutableStateOf(!BuildConfig.ACCOUNT_LOGIN) }
    var pasteMode by rememberSaveable { mutableStateOf(false) }
    var pairingLink by rememberSaveable { mutableStateOf("") }
    var server by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    val busy by vm.busy.collectAsState()
    val error by vm.uiError.collectAsState()
    val pairing by vm.pairingLogin.collectAsState()
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let(vm::pairFromQr) }
    val imageScanner = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(vm::pairFromQrImage)
    }
    (pairing as? PairingLoginState.DirectConnecting)?.let { connecting ->
        Dialog(onDismissRequest = vm::resetPairing) {
            Surface(shape = RoundedCornerShape(16.dp), color = SurfaceBase) {
                Column(Modifier.padding(24.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    CircularProgressIndicator(Modifier.size(32.dp), color = Accent)
                    Text("正在直连 ${connecting.pcName}", color = Ink, fontWeight = FontWeight.SemiBold)
                    Text("扫码已完成，手机正在自动连接电脑。", color = Muted, style = MaterialTheme.typography.bodySmall)
                    TextButton(vm::resetPairing) { Text("取消连接") }
                }
            }
        }
    }
    // The developer fallback adds two extra fields and is taller than the
    // smallest supported phone viewport. Keeping this column centered with a
    // fixed height made AnimatedVisibility place the server and password
    // fields on top of each other; a bad server value then produced paths
    // such as /api/v1/auth/api/v1/history/... and looked like a relay error.
    // Let the whole login surface scroll instead, while retaining a compact
    // top-aligned layout that behaves predictably with the IME open.
    Box(Modifier.fillMaxSize().background(Paper).systemBarsPadding().imePadding().padding(horizontal = 28.dp), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    Modifier.size(52.dp),
                    shape = RoundedCornerShape(14.dp),
                    color = Color.Transparent,
                    shadowElevation = 0.dp,
                ) {
                    Image(
                        painter = painterResource(R.drawable.khlink_logo),
                        contentDescription = "khLink",
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit,
                    )
                }
                Spacer(Modifier.width(14.dp))
                Column {
                    KhLinkWordmark(28.sp)
                    Text("连接你的桌面工作区", color = Muted, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Spacer(Modifier.height(12.dp))
            Text(
                if (BuildConfig.ACCOUNT_LOGIN) "登录 khLink 账号即可使用官方服务（免费，每月有免费流量），也可以使用自己的服务器。电脑端 khLink 连接器需保持运行。"
                else "用自己的服务器地址和密码登录，或扫描电脑上的二维码。电脑端 khLink 连接器需保持运行。",
                color = Muted,
                lineHeight = MaterialTheme.typography.bodyMedium.lineHeight,
                style = MaterialTheme.typography.bodyMedium,
            )
            // Open the authorization page in the browser when the URL is ready.
            val loginContext = LocalContext.current
            val khsciAuthUrl by vm.khsciAuthUrl.collectAsState()
            LaunchedEffect(khsciAuthUrl) {
                khsciAuthUrl?.let { url ->
                    runCatching { loginContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    vm.consumeKhsciAuthUrl()
                }
            }
            if (BuildConfig.ACCOUNT_LOGIN) Button(
                onClick = { vm.resetPairing(); vm.beginKhsciLogin() },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = !busy,
                shape = RoundedCornerShape(12.dp),
            ) {
                Text("登录 khLink 账号", fontWeight = FontWeight.SemiBold)
            }
            OutlinedButton(
                onClick = {
                    vm.resetPairing()
                    scanner.launch(ScanOptions().setPrompt("扫描电脑上的 khLink 二维码").setBeepEnabled(false).setOrientationLocked(false))
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = !busy,
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, Divider),
            ) {
                Icon(Icons.Default.QrCodeScanner, null, tint = Accent, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("扫描电脑二维码（账户／直连）", color = Ink, fontWeight = FontWeight.SemiBold)
            }
            OutlinedButton(
                onClick = {
                    vm.resetPairing()
                    imageScanner.launch(arrayOf("image/*"))
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                enabled = !busy,
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, Divider),
            ) {
                Icon(Icons.Default.PhotoLibrary, null, tint = Accent, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("从相册选择二维码", color = Ink, fontWeight = FontWeight.SemiBold)
            }
            AnimatedContent(targetState = pairing, label = "pairing-state") { state ->
                when (state) {
                    is PairingLoginState.Claiming -> Text("正在准备登录…", color = Accent, fontWeight = FontWeight.Medium)
                    is PairingLoginState.WaitingForDesktop -> Text("登录成功，正在从电脑接收密钥…", color = Accent, fontWeight = FontWeight.Medium)
                    is PairingLoginState.DirectConnecting -> Text("扫码已完成，正在自动连接电脑…", color = Accent)
                    is PairingLoginState.Complete -> Text("已连接 ${state.displayName}", color = Accent, fontWeight = FontWeight.Medium)
                    is PairingLoginState.Failed -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(state.message, color = Danger, style = MaterialTheme.typography.bodySmall)
                        if (PairingErrorMessage.needsMembership(state.message)) TextButton({
                            runCatching { loginContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PairingErrorMessage.MEMBERSHIP_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        }) { Text("查看流量说明", color = Accent, fontWeight = FontWeight.SemiBold) }
                    }
                    PairingLoginState.Idle -> Text("账户主密钥只在你的设备之间加密传递。", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (vm.directMode()) TextButton({ vm.restoreServerConnection() }, Modifier.align(Alignment.CenterHorizontally)) {
                Text("返回原账户连接", color = Accent)
            }
            TextButton({ pasteMode = !pasteMode }, Modifier.align(Alignment.CenterHorizontally)) {
                Text(if (pasteMode) "收起配对链接" else "无法扫码？粘贴配对链接", color = Accent)
            }
            AnimatedVisibility(
                visible = pasteMode,
                enter = fadeIn(tween(180)) + expandVertically(tween(220)),
                exit = fadeOut(tween(120)) + shrinkVertically(tween(160)),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        pairingLink,
                        { pairingLink = it },
                        Modifier.fillMaxWidth(),
                        label = { Text("配对链接") },
                        shape = RoundedCornerShape(10.dp),
                        minLines = 2,
                        maxLines = 3,
                    )
                    OutlinedButton(
                        { vm.pairFromQr(pairingLink) },
                        Modifier.fillMaxWidth(),
                        enabled = pairingLink.isNotBlank() && !busy,
                        shape = RoundedCornerShape(10.dp),
                    ) { Text("继续配对") }
                }
            }
            // A self-hosted relay's password login (v1). Without account login it is the way in, so it is always shown.
            if (BuildConfig.ACCOUNT_LOGIN) TextButton({ ownServer = !ownServer }, Modifier.align(Alignment.CenterHorizontally)) {
                Text(if (ownServer) "收起自己的服务器" else "使用自己的服务器", color = Muted)
            }
            AnimatedVisibility(
                visible = ownServer,
                enter = fadeIn(tween(180)) + expandVertically(tween(220)),
                exit = fadeOut(tween(120)) + shrinkVertically(tween(160)),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    HorizontalDivider(color = Divider.copy(alpha = 0.5f))
                    OutlinedTextField(
                        server,
                        { server = it },
                        Modifier.fillMaxWidth(),
                        label = { Text("服务器地址") },
                        shape = RoundedCornerShape(10.dp),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        password,
                        { password = it },
                        Modifier.fillMaxWidth(),
                        label = { Text("服务器密码") },
                        shape = RoundedCornerShape(10.dp),
                        visualTransformation = PasswordVisualTransformation(),
                        singleLine = true,
                        keyboardActions = KeyboardActions(onDone = { vm.login(server, password) }),
                    )
                    OutlinedButton(
                        { vm.login(server, password) },
                        Modifier.fillMaxWidth().height(48.dp),
                        enabled = !busy && password.isNotBlank() && server.isNotBlank(),
                        shape = RoundedCornerShape(10.dp),
                    ) {
                        if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Text("登录")
                    }
                }
            }
            AnimatedVisibility(visible = error != null, enter = fadeIn(tween(180)) + expandVertically(), exit = fadeOut(tween(120)) + shrinkVertically()) {
                error?.let { Text(it, color = Danger, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalSharedTransitionApi::class)
@Composable
private fun HomeScreen(vm: BridgeViewModel) {
    val rawThreads by vm.threads.collectAsState(); val connection by vm.connection.collectAsState(); val status by vm.statusText.collectAsState()
    val claudeConsent by vm.claudeConsent.collectAsState()
    val connectorId by vm.selectedConnectorId.collectAsState()
    // With several computers on the account the list shows the chosen one's
    // sessions; each computer's sessions stay with it.
    // Archived on this phone (Antigravity), or being archived / brought back
    // right now: shown in its new place at once, before the computer confirms.
    val phoneArchived by vm.phoneArchivedIds.collectAsState(); val archiving by vm.archivingIds.collectAsState()
    val allThreads = remember(rawThreads, phoneArchived, archiving) {
        rawThreads.map { thread ->
            val target = archiving[thread.id] ?: if (thread.id in phoneArchived) true else null
            if (target != null && target != thread.archived) thread.copy(archived = target) else thread
        }
    }
    val accountDevices by vm.devices.collectAsState()
    val computers = accountDevices.filter { !it.revoked && it.type.equals("connector", true) }
    val computerIds = computers.map { it.id }.toSet()
    val multiPc = computers.size > 1
    val consented = if (claudeConsent.enabled) allThreads else allThreads.filter { it.backend != "claude" }
    val threads = consented.filter { !multiPc || it.connectorId.isBlank() || it.connectorId == connectorId }
    val agentConnectorIds by vm.agentConnectorIds.collectAsState()
    val tabThreads = remember(consented, connectorId, agentConnectorIds, computerIds) {
        threadsForHomeAgentTabs(consented.filterNot { it.archived }, connectorId, agentConnectorIds, computerIds)
    }
    var claudeNotice by rememberSaveable { mutableStateOf(false) }
    val accountsAvailable by vm.accountsAvailable.collectAsState()
    val agentAccounts by vm.agentAccounts.collectAsState()
    var accountBackend by rememberSaveable { mutableStateOf<String?>(null) }
    val liveStatuses by vm.liveStatuses.collectAsState()
    val visibleAgents by vm.visibleAgents.collectAsState()
    val agentOpenStates by vm.agentOpenStates.collectAsState()
    val agentSnapshots by vm.agentOpenStatesByConnector.collectAsState()
    val agentInstalled by vm.agentInstalledByConnector.collectAsState()
    // Known to be missing on the selected computer (not merely closed).
    // With one computer no connector may be selected: use its report.
    val notInstalled: (String) -> Boolean = { agent ->
        (connectorId?.let { agentInstalled[it] } ?: agentInstalled.values.singleOrNull())?.get(agent) == false
    }
    val connectorSeenAt = vm.connectorSeenAt.collectAsState()
    val agentOrder by vm.agentOrder.collectAsState()
    val agentTabs = normalizeHomeAgentOrder(agentOrder)
    val agentStates by remember(connectorId, agentConnectorIds, computerIds, agentOpenStates, agentSnapshots, connection) {
        derivedStateOf { homeAgentStatesByConnector(connectorId, agentConnectorIds, computerIds, agentOpenStates, agentSnapshots, connectorSeenAt.value, connection) }
    }
    val capabilities by vm.capabilities.collectAsState()
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    // A process death (or "don't keep activities") restores selectedId from
    // rememberSaveable but creates a new repository. Re-open that one
    // conversation once so its watcher and history load start again.
    LaunchedEffect(Unit) {
        val id = selectedId ?: return@LaunchedEffect
        if (vm.currentThreadId() != id) vm.open(id)
    }
    var restoreId by remember { mutableStateOf<String?>(vm.lastViewedThreadId()) }
    var create by remember { mutableStateOf(false) }
    var homeBackend by rememberSaveable { mutableStateOf(vm.homeBackend()) }
    // Each agent tab looks at its own computer (2026-10-25): switching tabs
    // switches to the computer last picked on that tab.
    LaunchedEffect(homeBackend, multiPc, computerIds) { if (multiPc) vm.showAgentConnector(homeBackend, computerIds) }
    val lifecycleOwner = LocalLifecycleOwner.current
    var accountSheet by remember { mutableStateOf(false) }
    val accountScroll = rememberScrollState()
    val tokenDisplayUnit by vm.tokenDisplayUnit.collectAsState()
    val lightMode by vm.lightMode.collectAsState()
    val showPcLoad by vm.showPcLoad.collectAsState()
    var agentSettings by remember { mutableStateOf(false) }
    var agentSettingsReturnAccount by remember { mutableStateOf(false) }
    var devices by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val refreshScope = rememberCoroutineScope()
    val account by vm.account.collectAsState()
    val createdThreadId by vm.createdThreadId.collectAsState()
    val pendingNewTask by vm.pendingNewTask.collectAsState()
    val claudeWorkspaceTrust by vm.claudeWorkspaceTrust.collectAsState()
    val claudeTrustWorking by vm.claudeTrustWorking.collectAsState()
    LaunchedEffect(homeBackend, claudeConsent) {
        if (homeBackend == "claude" && claudeConsent.promptOnFirstUse) claudeNotice = true
        if (!claudeConsent.enabled && allThreads.any { it.id == selectedId && it.backend == "claude" }) { vm.closeTask(); selectedId = null; homeBackend = "claude" }
    }
    LaunchedEffect(accountsAvailable, homeBackend, connection, connectorId) {
        // 2026-10-18: Claude Desktop account switching is temporarily closed.
        // Only the read-only Codex account list is polled from the phone.
        if (accountsAvailable && connection == ConnectionState.Online && homeBackend == "codex") {
            while (true) {
                if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) vm.refreshAgentAccounts(homeBackend).join()
                delay(3_000)
            }
        }
    }
    accountBackend?.let { backend -> if (backend == "codex") AgentAccountsDialog(vm, backend) { accountBackend = null } else accountBackend = null }
    LaunchedEffect(visibleAgents, agentOrder) {
        if (homeBackend !in agentTabs) {
            homeBackend = agentTabs.firstOrNull { agentStates[it] == HomeAgentState.Open } ?: agentTabs.first()
            vm.saveHomeBackend(homeBackend)
        }
    }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> vm.resumeConnection()
                Lifecycle.Event.ON_STOP -> vm.noteAppBackgrounded()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(Unit) {
        vm.refresh(showError = false)
        if (vm.usingV2()) vm.refreshAccount(showError = false)
    }
    // A tapped notification names the session to open.
    val openRequest by OpenThreadRequests.pending.collectAsState()
    LaunchedEffect(openRequest) {
        val id = openRequest ?: return@LaunchedEffect
        OpenThreadRequests.pending.value = null
        selectedId = null
        restoreId = id
    }
    LaunchedEffect(allThreads, claudeConsent, restoreId, connectorId) {
        val id = restoreId ?: return@LaunchedEffect
        if (allThreads.any { it.id == id && it.backend == "claude" } && !claudeConsent.enabled) {
            homeBackend = "claude"; claudeNotice = true; return@LaunchedEffect
        }
        // A notification can name another computer's session. Remember that
        // computer for its agent before navigating, so its tab and badge agree.
        allThreads.firstOrNull { it.id == id }?.let { thread ->
            val owner = thread.connectorId.takeIf { multiPc && it.isNotBlank() }
            val agent = backendTab(thread.backend)
            if (owner != null && (owner != connectorId || agentConnectorIds[agent] != owner)) {
                vm.selectConnectorForAgent(agent, owner, agentTabs)
                if (owner != connectorId) return@LaunchedEffect
            }
        }
        if (threads.any { it.id == id }) {
            threads.firstOrNull { it.id == id }?.backend?.let { homeBackend = it }
            selectedId = id
            restoreId = null
            vm.open(id)
        }
    }
    LaunchedEffect(createdThreadId, threads) {
        val id = createdThreadId ?: return@LaunchedEffect
        allThreads.firstOrNull { it.id == id }?.let { thread ->
            val owner = thread.connectorId.takeIf { multiPc && it.isNotBlank() }
            val agent = backendTab(thread.backend)
            if (owner != null && (owner != connectorId || agentConnectorIds[agent] != owner)) {
                vm.selectConnectorForAgent(agent, owner, agentTabs)
                if (owner != connectorId) return@LaunchedEffect
            }
        }
        if (threads.any { it.id == id }) {
            threads.firstOrNull { it.id == id }?.backend?.let { homeBackend = it }
            selectedId = id
            vm.saveLastViewedThreadId(id)
            vm.open(id)
            vm.clearCreatedThreadId()
            vm.dismissPendingNewTask()
        }
    }
    LaunchedEffect(connection) { if (connection == ConnectionState.Online) { vm.capabilities(showError = false); vm.backendCapabilities() } }
    // The open conversation's computer is the chosen one, so going back lands
    // in its list and new work goes to the same computer.
    LaunchedEffect(selectedId, allThreads, multiPc) {
        val thread = allThreads.firstOrNull { it.id == selectedId }
        val owner = thread?.connectorId
        if (multiPc && thread != null && !owner.isNullOrBlank() && owner != connectorId) vm.selectConnectorForAgent(backendTab(thread.backend), owner, agentTabs)
    }
    val claudeModels by vm.claudeModels.collectAsState()
    // The conversation just closed: its card flashes once when the list is back.
    var returnedId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(returnedId) { if (returnedId != null) { delay(1600); returnedId = null } }
    // One scroll position per tab.
    val listStates = remember { HashMap<String, LazyListState>() }
    val haptics = rememberHaptics()
    // Quota and load fold away while the list scrolls up, and come back on the way down.
    val fold = remember { FoldState() }
    val closeThread = {
        returnedId = selectedId
        vm.closeTask(); vm.clearLastViewedThreadId(); selectedId = null
        // Back from a conversation, the list starts at its top again (as asked
        // 2026-10-29), with the folded quota line shown.
        listStates.values.forEach { it.requestScrollToItem(0) }
        fold.fraction = 0f
    }
    // Long press on a Codex or Claude task: rename / pin, done on the desktop too.
    var menuThread by remember { mutableStateOf<ThreadSummary?>(null) }
    var renameThread by remember { mutableStateOf<ThreadSummary?>(null) }
    var pinPicker by remember { mutableStateOf(false) }
    var avatarThread by remember { mutableStateOf<ThreadSummary?>(null) }
    var chatStatsShown by rememberSaveable { mutableStateOf(false) }
    // Multi-select in the chat list: tick several sessions, then archive them together.
    var selecting by remember { mutableStateOf(false) }
    var selectedIds by remember { mutableStateOf(emptySet<String>()) }
    // The archived sessions of the open tab, listed at the end, to bring one back.
    var showArchived by remember { mutableStateOf(false) }
    LaunchedEffect(homeBackend) { selecting = false; selectedIds = emptySet(); showArchived = false }
    BackHandler(enabled = selecting) { selecting = false; selectedIds = emptySet() }
    val homeContext = LocalContext.current
    // Every agent's sessions have a long-press menu now: archiving works for all.
    val threadMenu: (ThreadSummary) -> (() -> Unit)? = { thread -> { haptics.tick(); menuThread = thread } }
    // Claude account switching is temporarily closed; the account button is the
    // read-only Codex list only. The Claude entry returns with the feature.
    val showAccountsButton = accountsAvailable && homeBackend == "codex"
    val listPane: @Composable () -> Unit = { Scaffold(containerColor = if (ChatLayout) SurfaceBase else Paper, bottomBar = {
        if ((ChatLayout || CodexLayout) && selecting) {
            val chosen = allThreads.filter { it.id in selectedIds }
            val bringBack = chosen.isNotEmpty() && chosen.all { it.archived }
            ChatSelectionBar(chosen.size, if (bringBack) "取消归档" else "归档",
                cancel = { selecting = false; selectedIds = emptySet() }) {
                vm.archiveThreads(chosen.filter { it.archived == bringBack }, !bringBack)
                selecting = false; selectedIds = emptySet()
            }
        } else if (ChatLayout) ChatBottomTabs(homeBackend, agentTabs, agentStates, tabThreads, liveStatuses, { homeBackend = it; vm.saveHomeBackend(it) }, settings = { agentSettingsReturnAccount = false; agentSettings = true }) { accountSheet = true }
    }, topBar = {
        if (ChatLayout) {
            // A centered title with the waiting count, and "(未连接)" while the
            // computer is away, as a chat app shows its own connection state.
            // The title folds away while the list scrolls up, as on the other themes (2026-11-01).
            Column(Modifier.fillMaxWidth().background(Paper).statusBarsPadding()) {
                FoldAway(fold, "chat-title") {
                Column(Modifier.fillMaxWidth().animateContentSize(KhMotion.sizeSpring)) {
                    // A clean title bar, as WeChat has: quota and the computer's load
                    // stay hidden until the title is tapped (tap again to hide).
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 4.dp)
                        .clickable(interactionSource = null, indication = null) { haptics.tick(); chatStatsShown = !chatStatsShown }
                        .semantics { contentDescription = if (chatStatsShown) "收起额度和电脑负载" else "显示额度和电脑负载" },
                        verticalAlignment = Alignment.CenterVertically) {
                        val attention = attentionCount(threads, liveStatuses, homeBackend)
                        val suffix = when (connection) {
                            ConnectionState.Online -> if (attention > 0) "($attention)" else ""
                            ConnectionState.Connecting -> "(连接中…)"
                            ConnectionState.Offline -> "(未连接)"
                        }
                        // Same width as the buttons on the right, so the title stays centered.
                        Spacer(Modifier.width(if (showAccountsButton) 96.dp else 48.dp))
                        Text(homeTabLabel(homeBackend, 3) + suffix, Modifier.weight(1f), textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = Ink, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                        Row {
                            if (showAccountsButton) AgentAccountsButton(agentAccounts[homeBackend]) { accountBackend = homeBackend }
                            // No refresh button, as WeChat has none: the list updates live.
                            IconButton({ create = true }) { Icon(Icons.Outlined.AddCircleOutline, "新任务", tint = Ink) }
                        }
                    }
                    // Folded with the quota and the load: shown when the title is tapped.
                    if (chatStatsShown) {
                        ChatStatsCard(vm, computers, connectorId, homeBackend, agentTabs, connection, showPcLoad, capabilities, claudeConsent.enabled)
                    }
                }
                }
            }
            return@Scaffold
        }
        // Everything above the list folds away while it scrolls up (asked
        // 2026-11-01); a slim bar with the agent, the computer and "+" takes its
        // place, and a tap on it (or scrolling back down) brings it all back.
        Column(Modifier.fillMaxWidth().background(SurfaceBase).statusBarsPadding()) {
            FoldIn(fold, "folded-bar") {
                FoldedHomeBar(
                    agent = homeBackend,
                    count = tabThreads.count { backendTab(it.backend) == homeBackend },
                    computer = if (multiPc) computers.firstOrNull { it.id == connectorId }?.let(::computerLabel) else null,
                    connection = connection,
                    expand = { refreshScope.launch { fold.expand() } },
                ) { create = true }
            }
            FoldAway(fold, "title") {
                HomeTitleBar(
                    status = status,
                    connection = connection,
                    refreshing = refreshing,
                    accounts = if (showAccountsButton) ({ AgentAccountsButton(agentAccounts[homeBackend]) { accountBackend = homeBackend } }) else null,
                    refresh = {
                        if (!refreshing) {
                            refreshing = true
                            refreshScope.launch {
                                // A manual tap is the user's explicit "find it for
                                // me" signal — page through full thread history so
                                // an old pinned thread that a light refresh cannot
                                // reach has a way to surface.
                                vm.refresh(full = true).join()
                                delay(350)
                                refreshing = false
                            }
                        }
                    },
                    create = { create = true },
                    avatar = { UserAvatar(account?.displayName ?: "KH", account?.avatarUrl, 30) },
                ) { accountSheet = true }
            }
            if (multiPc) FoldAway(fold, "computers") { PcSwitcher(vm, computers, connectorId, homeBackend, agentTabs) }
            FoldAway(fold, "tabs") {
                BackendTabs(homeBackend, agentTabs, agentStates, tabThreads, liveStatuses, settings = { agentSettingsReturnAccount = false; agentSettings = true }) { homeBackend = it; vm.saveHomeBackend(it) }
            }
            if (showPcLoad) FoldAway(fold, "load") { PcLoadBar(vm, connection) }
            UploadIssueBar(vm)
            FoldAway(fold, "quota") {
                if (notInstalled(homeBackend)) Unit
                else if (homeBackend == "codex") WeeklyQuotaStrip(capabilities)
                else if (homeBackend == "claude" && claudeConsent.enabled) ClaudeQuotaStrip(vm)
                else if (homeBackend == "dsh") DshQuotaStrip(vm)
            }
            HorizontalDivider(color = Divider.copy(alpha = 0.6f), thickness = 0.5.dp)
        }
    }) { pad ->
        // Do not depend on the server response order. The connector persists
        // the exact Desktop sidebar ordinal as pinOrder; render that order
        // explicitly so a pin removal/addition cannot reshuffle the section.
        // Archived sessions (e.g. archived in the desktop app) leave the list.
        // Swiping left/right on the list moves between tabs, like tapping them.
        val tabOrder = agentTabs
        fun switchTab(step: Int) {
            val next = nextHomeAgent(homeBackend, step, tabOrder, agentStates) ?: return
            haptics.tick(); homeBackend = next; vm.saveHomeBackend(next)
        }
        Box(Modifier.fillMaxSize().padding(pad).nestedScroll(fold.connection).pointerInput(homeBackend, agentTabs, agentStates) {
            var dragged = 0f
            detectHorizontalDragGestures(
                onDragStart = { dragged = 0f },
                onHorizontalDrag = { _, amount -> dragged += amount },
                onDragEnd = { if (dragged < -140f) switchTab(1) else if (dragged > 140f) switchTab(-1) },
            )
        }) {
        AnimatedContent(
            targetState = homeBackend,
            transitionSpec = {
                val forward = tabOrder.indexOf(targetState) > tabOrder.indexOf(initialState)
                (slideInHorizontally(KhMotion.offsetSpring) { if (forward) it / 5 else -it / 5 } + fadeIn(tween(200))) togetherWith
                    (slideOutHorizontally(KhMotion.offsetSpring) { if (forward) -it / 5 else it / 5 } + fadeOut(tween(140)))
            },
            label = "home-tab",
        ) { tab ->
        if (tab == "claude" && !claudeConsent.enabled) {
            ClaudeDisabledPanel { claudeNotice = true }
            return@AnimatedContent
        }
        val scoped = threads.filter { !it.archived && backendTab(it.backend) == tab }
        // Recent highlights stay available without changing Codex's or
        // Claude's Desktop pinned membership or ordering when a chat starts or finishes.
        val recentHighlights = recentThreadHighlights(scoped) { thread -> liveStatuses[thread.id] ?: thread.status }
        // DSH can have many unopened finished sessions; keep live work at the
        // top of Recent so a running turn is never buried by them. The other
        // tabs keep their established attention-first order.
        val recentRows = if (tab == "dsh") {
            recentHighlights.sortedWith(compareByDescending { thread -> isRunningThreadStatus(liveStatuses[thread.id] ?: thread.status) })
        } else recentHighlights
        val recentIds = recentHighlights.mapTo(HashSet()) { it.id }
        val pinned = homePinnedThreads(scoped, recentIds, tab)
        val recentChats = scoped.filterNot { it.pinned }
        val listState = remember(tab) { listStates.getOrPut(tab) { LazyListState() } }
        if (ChatLayout || CodexLayout) {
            // One flat list, as a chat app has: what is going on now first
            // (running, waiting for you, just finished and unseen), then the
            // pinned chats (gray rows) and the rest, each by latest activity.
            val ordered = wechatListOrder(scoped, recentHighlights)
            // A chat moving to the top of a list shown from its top stays in
            // view: the list otherwise keeps its old first row in place and
            // the new one lands just above the screen. Read during this
            // composition, the position is still the one before the change.
            val firstId = ordered.firstOrNull()?.id
            val shownFirst = remember(tab) { arrayOf(firstId) }
            if (firstId != shownFirst[0]) {
                shownFirst[0] = firstId
                val atTop = androidx.compose.runtime.snapshots.Snapshot.withoutReadObservation {
                    listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0
                }
                if (atTop) listState.requestScrollToItem(0)
            }
            // No stretch at the ends: pulled past the top it only showed the
            // blank page behind the list.
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.foundation.LocalOverscrollFactory provides null) {
            Column(Modifier.fillMaxSize()) {
            // Outside the list: as its first item, usually empty (zero height),
            // a pull at the top flipped the first visible item every frame and
            // every row's placement animation chased it, sliding the list down.
            Box(Modifier.padding(horizontal = 12.dp)) { BackgroundRunNote() }
            LazyColumn(Modifier.fillMaxSize(), state = listState, overscrollEffect = null) {
                if (agentStates[tab] == HomeAgentState.Closed) item { Box(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { AgentClosedNote(tab) } }
                if (scoped.isEmpty() && notInstalled(tab)) item { AgentNotInstalledState(tab) }
                else if (scoped.isEmpty() && tab == "pi") item { PiEmptyState(connection, vm::startPiWeb) }
                else if (scoped.isEmpty() && tab == "claude") item { ClaudeEmptyState(connection) { create = true } }
                else if (scoped.isEmpty() && tab == "dsh") item { DshEmptyState(connection) }
                else if (scoped.isEmpty()) item { EmptyState(connection) }
                if (tab == "antigravity") item { Box(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { AntigravityNote() } }
                val archivedHere = threads.filter { it.archived && backendTab(it.backend) == tab }.sortedByDescending(::threadActivityTime)
                val toggleSelected: (ThreadSummary) -> Unit = { thread ->
                    haptics.tick(); selectedIds = if (thread.id in selectedIds) selectedIds - thread.id else selectedIds + thread.id
                }
                val chatRow: @Composable (ThreadSummary) -> Unit = { thread ->
                    SelectableChatRow(selecting, thread.id in selectedIds, dim = thread.archived, toggle = { toggleSelected(thread) }) {
                        // Only the pinned block is gray; a pin that leads the list with what is
                        // going on would stripe the top rows.
                        val open: () -> Unit = {
                            if (selecting) toggleSelected(thread)
                            else { selectedId = thread.id; vm.saveLastViewedThreadId(thread.id); vm.open(thread.id) }
                        }
                        if (CodexLayout) ThreadRow(thread, liveStatuses[thread.id] ?: thread.status, shared = false, onLongPress = if (selecting) null else threadMenu(thread), open = open)
                        else ChatThreadRow(thread, liveStatuses[thread.id] ?: thread.status, if (selecting) null else threadMenu(thread), gray = thread.pinned && thread.id !in recentIds, open = open)
                    }
                }
                items(ordered, key = { it.id }) { thread ->
                    Box(Modifier.animateItem(fadeInSpec = tween(180), placementSpec = KhMotion.offsetSpring, fadeOutSpec = tween(120)).sharedThreadCard(thread.id)) { chatRow(thread) }
                }
                if (archivedHere.isNotEmpty()) {
                    item(key = "archived-header") {
                        Row(Modifier.fillMaxWidth().clickable { haptics.tick(); showArchived = !showArchived }.padding(horizontal = 16.dp, vertical = 14.dp)
                            .semantics { contentDescription = if (showArchived) "收起已归档的会话" else "显示已归档的会话" },
                            verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Archive, null, Modifier.size(18.dp), tint = Muted)
                            Spacer(Modifier.width(8.dp))
                            Text("已归档（${archivedHere.size}）", Modifier.weight(1f), color = Muted, fontSize = 14.sp)
                            Icon(if (showArchived) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(18.dp), tint = Muted)
                        }
                    }
                    if (showArchived) items(archivedHere, key = { "archived-${it.id}" }) { thread ->
                        Box(Modifier.animateItem(fadeInSpec = tween(180), placementSpec = KhMotion.offsetSpring, fadeOutSpec = tween(120))) { chatRow(thread) }
                    }
                }
            }
            }
            }
            return@AnimatedContent
        }
        // The background note sits outside the list: as a usually empty first
        // item it made the rows slide when pulled at the top (see the chat layout).
        Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp)) { BackgroundRunNote() }
        // Each section is one rounded group of slim rows (2026-11-01: denser
        // than a card per session, so about twice as many fit on a screen).
        LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 16.dp)) {
            if (agentStates[tab] == HomeAgentState.Closed) item { AgentClosedNote(tab) }
            if (scoped.isEmpty() && notInstalled(tab)) item { AgentNotInstalledState(tab) }
            else if (scoped.isEmpty() && tab == "pi") item { PiEmptyState(connection, vm::startPiWeb) }
            else if (scoped.isEmpty() && tab == "claude") item { ClaudeEmptyState(connection) { create = true } }
            else if (scoped.isEmpty() && tab == "dsh") item { DshEmptyState(connection) }
            else if (scoped.isEmpty()) item { EmptyState(connection) }
            if (tab == "antigravity") item { AntigravityNote() }
            val openThread: (ThreadSummary) -> Unit = { thread -> selectedId = thread.id; vm.saveLastViewedThreadId(thread.id); vm.open(thread.id) }
            if (recentRows.isNotEmpty()) {
                item { ThreadSection("最近", Icons.Default.Schedule, recentRows.size) }
                itemsIndexed(recentRows, key = { _, thread -> "recent-${thread.id}" }) { index, thread ->
                    Box(Modifier.animateItem(fadeInSpec = tween(180), placementSpec = KhMotion.offsetSpring, fadeOutSpec = tween(120))) {
                        ThreadRow(thread, liveStatuses[thread.id] ?: thread.status, groupPosition(index, recentRows.size), shared = tab !in DESKTOP_MIRRORED_PIN_TABS || !thread.pinned, onLongPress = threadMenu(thread)) { openThread(thread) }
                    }
                }
            }
            if (pinned.isNotEmpty()) {
                item { ThreadSection("置顶", Icons.Default.PushPin, pinned.size) }
                itemsIndexed(pinned, key = { _, thread -> thread.id }) { index, thread ->
                    Box(Modifier.animateItem(fadeInSpec = tween(180), placementSpec = KhMotion.offsetSpring, fadeOutSpec = tween(120))) {
                        ThreadRow(thread, liveStatuses[thread.id] ?: thread.status, groupPosition(index, pinned.size), showPin = false, onLongPress = threadMenu(thread)) { openThread(thread) }
                    }
                }
            }
            if (recentChats.isNotEmpty()) {
                item { ThreadSection("最近对话", Icons.Default.Forum, recentChats.size) }
                itemsIndexed(recentChats, key = { _, thread -> thread.id }) { index, thread ->
                    Box(Modifier.animateItem(fadeInSpec = tween(180), placementSpec = KhMotion.offsetSpring, fadeOutSpec = tween(120))) {
                        // Already shown under "最近": that card is the one that grows into the conversation.
                        ThreadRow(thread, liveStatuses[thread.id] ?: thread.status, groupPosition(index, recentChats.size), shared = thread.id !in recentIds, onLongPress = threadMenu(thread)) { openThread(thread) }
                    }
                }
            }
        }
        }
        }
        }
    } }

    // List <-> conversation. The transition is seekable so the predictive back
    // gesture can drag it: the conversation shrinks toward its card while the
    // finger moves, and springs back if the gesture is cancelled.
    val navState = remember { SeekableTransitionState(selectedId) }
    val navTransition = rememberTransition(navState, label = "list-conversation")
    LaunchedEffect(selectedId) { if (navState.targetState != selectedId || navState.currentState != selectedId) navState.animateTo(selectedId) }
    PredictiveBackHandler(enabled = selectedId != null) { progress ->
        val open = selectedId
        try {
            progress.collect { event -> navState.seekTo(event.progress * 0.92f, targetState = null) }
            closeThread()
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            navState.animateTo(open)
            throw cancelled
        }
    }
    Row(Modifier.fillMaxSize()) {
    if (CodexLayout) CodexNavigationRail(
        home = { if (selectedId != null) closeThread() },
        create = { if (selectedId != null) closeThread(); create = true },
        devices = { if (selectedId != null) closeThread(); devices = true; vm.refreshDevices() },
        settings = { if (selectedId != null) closeThread(); accountSheet = true },
        avatar = { UserAvatar(account?.displayName ?: "KH", account?.avatarUrl, 28) },
    )
    Box(Modifier.weight(1f).fillMaxHeight()) {
    SharedTransitionLayout {
        navTransition.AnimatedContent(
            transitionSpec = {
                when {
                    initialState == null && targetState != null ->
                        fadeIn(tween(260, delayMillis = 40)) togetherWith (fadeOut(tween(260)) + scaleOut(tween(300), targetScale = 0.94f))
                    targetState == null ->
                        (fadeIn(tween(260)) + scaleIn(tween(300), initialScale = 0.94f)) togetherWith fadeOut(tween(200))
                    else -> fadeIn(tween(220)) togetherWith fadeOut(tween(150))
                }.using(SizeTransform(clip = false))
            },
        ) { shownId ->
            androidx.compose.runtime.CompositionLocalProvider(
                LocalSharedScope provides this@SharedTransitionLayout,
                LocalNavVisibilityScope provides this,
                LocalReturnedThreadId provides returnedId,
            ) {
                if (shownId == null) listPane()
                // An open conversation stays open whichever computer is chosen
                // (its computer can change while it is open).
                else consented.firstOrNull { it.id == shownId }?.let { target ->
                    androidx.compose.runtime.CompositionLocalProvider(
                        LocalAgentBackend provides target.backend,
                        LocalAgentName provides when (target.backend) { "claude" -> "Claude"; "pi" -> "Pi"; "antigravity" -> "反重力"; "dsh" -> "DeepSeek"; "hermes" -> "Hermes"; else -> "Codex" },
                        // Kept per session: a new instance each time the thread list
                        // changed made every part of the open conversation recompose.
                        LocalToolImages provides remember(target.id) { ToolImageSource(target.id, vm) },
                        LocalSelfAvatar provides ((account?.displayName ?: "我") to account?.avatarUrl),
                        LocalChatPeer provides (target.id to target.title),
                        LocalComputerFiles provides remember(target.id, target.cwd) { ComputerFileSource(target.cwd, vm) },
                    ) {
                        ThreadScreen(vm, target, closeThread)
                        ComputerFileDialog(vm)
                        ComputerFileViewer(vm)
                        WebVideoDialog(vm)
                    }
                }
            }
        }
    }
    }
    }
    // Started from the phone: the conversation shows at once, with the first
    // message, while the computer creates it (it used to wait on the list).
    AnimatedVisibility(
        selectedId == null && pendingNewTask != null,
        enter = fadeIn(tween(180)) + slideInHorizontally(tween(240)) { it / 6 },
        exit = fadeOut(tween(180)),
    ) {
        pendingNewTask?.let { pending -> PendingNewTaskScreen(pending, back = vm::dismissPendingNewTask) }
    }
    if (selectedId != null) {
        GlobalMessage(vm)
        claudeWorkspaceTrust?.let { request -> ClaudeWorkspaceTrustDialog(request, claudeTrustWorking, vm::confirmClaudeWorkspaceTrust, vm::cancelClaudeWorkspaceTrust) }
        return
    }
    if (create) NewTaskDialog(homeBackend, claudeModels, recentWorkdirs(threads), capabilities.codexSandboxBlocked, claudeConsent.enabled, { claudeNotice = true }, { create = false }) { cwd, prompt, mode, collaborationMode, backend, model, effort ->
        vm.newTask(cwd, prompt, mode, collaborationMode, backend, model, effort)
        // Show the tab the new task lands in.
        if (backend in visibleAgents && backend != homeBackend) { homeBackend = backend; vm.saveHomeBackend(backend) }
        create = false
    }
    var piProviders by remember { mutableStateOf(false) }
    var fetchedFiles by rememberSaveable { mutableStateOf(false) }
    val settingsClaudeUsage by vm.claudeUsage.collectAsState()
    LaunchedEffect(accountSheet) { if (accountSheet) vm.claudeUsage() }
    if (accountSheet) AccountDialog(account, vm.usingV2(), close = { accountSheet = false },
        claudeEnabled = claudeConsent.enabled, claudeNotice = { claudeNotice = true }, disableClaude = { vm.setClaudeConsent(false) },
        unit = tokenDisplayUnit, unitChanged = vm::saveTokenDisplayUnit, scrollState = accountScroll,
        lightMode = lightMode, lightModeChanged = vm::saveLightMode,
        showPcLoad = showPcLoad, showPcLoadChanged = vm::saveShowPcLoad,
        claudeStatusline = settingsClaudeUsage?.statusline, claudeStatuslineChanged = vm::setClaudeStatusline,
        fetchedFiles = { accountSheet = false; fetchedFiles = true; vm.refreshFetchedFiles() },
        visibleAgents = visibleAgents, agentOrder = agentOrder, agentSettings = { agentSettingsReturnAccount = true; accountSheet = false; agentSettings = true },
        devices = { accountSheet = false; devices = true; vm.refreshDevices() },
        update = { vm.checkForUpdate(true) }, password = { accountSheet = false; password = true },
        markAllRead = { vm.markAllThreadsRead(); accountSheet = false },
        logout = { accountSheet = false; vm.logout() },
        direct = { accountSheet = false; vm.enterDirectPairing() },
        restoreServer = { accountSheet = false; vm.restoreServerConnection() },
        piSettings = if (threads.any { it.backend == "pi" }) ({ accountSheet = false; piProviders = true }) else null)
    if (agentSettings) AgentVisibilityDialog(visibleAgents, agentOrder, agentStates, {
        agentSettings = false
        if (agentSettingsReturnAccount) accountSheet = true
    }) {
        vm.saveAgentOrder(it)
        agentSettings = false
        if (agentSettingsReturnAccount) accountSheet = true
    }
    if (piProviders) PiProvidersDialog(vm) { piProviders = false; accountSheet = true }
    if (devices) DevicesDialog(vm, homeBackend, agentTabs) { devices = false; accountSheet = true }
    if (fetchedFiles) { FetchedFilesPage(vm) { fetchedFiles = false; accountSheet = true }; ComputerFileDialog(vm); ComputerFileViewer(vm) }
    claudeWorkspaceTrust?.let { request -> ClaudeWorkspaceTrustDialog(request, claudeTrustWorking, vm::confirmClaudeWorkspaceTrust, vm::cancelClaudeWorkspaceTrust) }
    menuThread?.let { thread ->
        ThreadActionDialog(thread, close = { menuThread = null }, rename = { menuThread = null; renameThread = thread },
            choosePins = if (thread.backend == "dsh") ({ menuThread = null; pinPicker = true }) else null,
            changeAvatar = if (ChatLayout || CodexLayout) ({ menuThread = null; avatarThread = thread }) else null,
            archive = { menuThread = null; vm.archiveThreads(listOf(thread), !thread.archived) },
            multiSelect = if (ChatLayout || CodexLayout) ({ menuThread = null; selecting = true; selectedIds = setOf(thread.id) }) else null) {
            menuThread = null
            vm.pin(thread.id, !thread.pinned)
            Toast.makeText(homeContext, if (thread.pinned) "正在电脑端取消置顶…" else "正在电脑端置顶…", Toast.LENGTH_SHORT).show()
        }
    }
    avatarThread?.let { thread -> AvatarPickerDialog(thread.id, thread.title) { avatarThread = null } }
    if (pinPicker) {
        val dshThreads = threads.filter { backendTab(it.backend) == "dsh" && !it.archived }
        PinSelectionDialog(dshThreads, close = { pinPicker = false }) { selected ->
            pinPicker = false
            val changes = dshThreads.mapNotNull { thread ->
                val want = thread.id in selected
                if (thread.pinned == want) null else thread.id to want
            }
            if (changes.isNotEmpty()) {
                vm.pinSelection(changes)
                Toast.makeText(homeContext, "正在把置顶选择同步到 DSH 桌面端…", Toast.LENGTH_SHORT).show()
            }
        }
    }
    renameThread?.let { thread ->
        RenameDialog(thread.title, { renameThread = null }) { name ->
            renameThread = null
            if (name != thread.title) {
                vm.rename(thread.id, name)
                Toast.makeText(homeContext, "正在电脑端改名…", Toast.LENGTH_SHORT).show()
            }
        }
    }
    if (password) PasswordDialog({ password = false; accountSheet = true }) { vm.changePassword(it); password = false; accountSheet = true }
    if (claudeNotice) ClaudeConsentDialog(
        accept = { vm.setClaudeConsent(true); claudeNotice = false },
        decline = { vm.setClaudeConsent(false); claudeNotice = false; restoreId = null },
    )
    GlobalMessage(vm)
}

/** The reference's narrow workspace rail, with only real khLink actions. */
@Composable
private fun CodexNavigationRail(
    home: () -> Unit,
    create: () -> Unit,
    devices: () -> Unit,
    settings: () -> Unit,
    avatar: @Composable () -> Unit,
) {
    Column(
        Modifier.width(50.dp).fillMaxHeight().background(P.surfaceAlt)
            .statusBarsPadding().navigationBarsPadding().padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        IconButton(home, Modifier.size(48.dp).background(P.selected, RoundedCornerShape(12.dp))) {
            Icon(Icons.Default.Home, "会话列表", Modifier.size(21.dp), tint = Ink)
        }
        Spacer(Modifier.height(8.dp))
        IconButton(create, Modifier.size(48.dp)) { Icon(Icons.Outlined.Edit, "新建对话", Modifier.size(20.dp), tint = Muted) }
        IconButton(devices, Modifier.size(48.dp)) { Icon(Icons.Outlined.Devices, "电脑和设备", Modifier.size(20.dp), tint = Muted) }
        // Account and settings: only the avatar at the bottom (2026-11-05:
        // a gear here and an avatar at the top right did the same).
        Spacer(Modifier.weight(1f))
        IconButton(settings, Modifier.size(48.dp).semantics { contentDescription = "账户和设置" }) { avatar() }
    }
}

@Composable
private fun WeeklyQuotaStrip(caps: CapabilityState) {
    val remaining = caps.weeklyRemainingPercent
    val quotaLabel = when {
        caps.quotaAccountState == "signed_out" -> "未登录"
        remaining == null && caps.quotaState == "loading" -> "读取中"
        remaining == null -> "暂不可用"
        caps.quotaState == "cached" -> "缓存 $remaining%"
        else -> "剩余 $remaining%"
    }
    val quotaLabelColor = when {
        remaining == null -> Muted
        remaining < 20 -> Danger
        caps.quotaState == "cached" -> Warm
        else -> Accent
    }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, bottom = 6.dp),
        color = SurfaceAlt.copy(alpha = 0.62f),
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(0.5.dp, Divider.copy(alpha = 0.8f)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("周额度", style = MaterialTheme.typography.labelMedium, color = Ink, fontWeight = FontWeight.SemiBold)
            capsResetLabel(caps)?.let { reset ->
                Spacer(Modifier.width(6.dp))
                Text("重置 $reset", style = MaterialTheme.typography.labelSmall, color = Muted, maxLines = 1)
            }
            Spacer(Modifier.width(10.dp))
            QuotaBar(remaining, caps.quotaState == "loading", Modifier.weight(1f))
            Spacer(Modifier.width(10.dp))
            Surface(shape = RoundedCornerShape(50), color = quotaLabelColor.copy(alpha = 0.11f)) {
                Text(
                    quotaLabel,
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
                    color = quotaLabelColor,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
            }
        }
    }
}

// DeepSeek Harness is pay-as-you-go, not a subscription: show the Platform
// wallet balance and today's token usage instead of a weekly percentage.
@Composable
private fun DshQuotaStrip(vm: BridgeViewModel, inCard: Boolean = false) {
    val observed by vm.dshUsage.collectAsState()
    val connection by vm.connection.collectAsState()
    LaunchedEffect(connection) { if (connection == ConnectionState.Online) vm.dshUsage() }
    LaunchedEffect(Unit) {
        while (true) {
            delay(300_000)
            if (vm.connection.value == ConnectionState.Online) vm.dshUsage()
        }
    }
    val usage = observed
    val online = connection == ConnectionState.Online
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = if (inCard) 4.dp else 12.dp).padding(top = if (inCard) 4.dp else 0.dp, bottom = if (inCard) 4.dp else 6.dp),
        color = if (inCard) Color.Transparent else SurfaceAlt.copy(alpha = 0.46f),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("余额", style = MaterialTheme.typography.labelSmall, color = Muted, maxLines = 1)
            Spacer(Modifier.width(4.dp))
            Text(
                if (online) dshBalanceText(usage) else "—",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = if (usage?.balance?.isNotEmpty() == true) Accent else Muted,
                maxLines = 1,
            )
            Spacer(Modifier.width(10.dp))
            Box(Modifier.width(1.dp).height(13.dp).background(Divider))
            Spacer(Modifier.width(10.dp))
            Text("今日", style = MaterialTheme.typography.labelSmall, color = Muted, maxLines = 1)
            Spacer(Modifier.width(4.dp))
            Text(
                if (online) dshSpentText(usage) else "—",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = Ink,
                maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            Text(
                if (online) dshSpentLabel(usage) else "离线",
                style = MaterialTheme.typography.labelSmall,
                color = Muted,
                maxLines = 1,
            )
        }
    }
}

// Claude plan usage: five-hour and weekly windows, remaining share + reset.
@Composable
private fun ClaudeQuotaStrip(vm: BridgeViewModel, inCard: Boolean = false) {
    val observedUsage by vm.claudeUsage.collectAsState()
    val connection by vm.connection.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var refreshingSince by remember { mutableStateOf(0L) }
    var refreshHelp by remember { mutableStateOf(false) }
    var refreshResultBefore by remember { mutableStateOf(0L) }
    val usage = observedUsage?.displayAt(now)
    LaunchedEffect(connection) { if (connection == ConnectionState.Online) vm.claudeUsage() }
    // Keep the strip filled: re-read the connector's cached usage (no model
    // request) until it arrives, then every five minutes.
    LaunchedEffect(Unit) {
        var lastRead = 0L
        while (true) {
            delay(30_000); now = System.currentTimeMillis()
            if (vm.connection.value == ConnectionState.Online && (vm.claudeUsage.value == null || now - lastRead > 300_000)) { vm.claudeUsage(); lastRead = now }
        }
    }
    LaunchedEffect(usage?.updatedAt) { if (refreshingSince > 0 && (usage?.updatedAt ?: 0L) >= refreshingSince) refreshingSince = 0L }
    LaunchedEffect(usage?.refreshResultAt) {
        if (refreshingSince > 0 && (usage?.refreshResultAt ?: 0L) != refreshResultBefore) {
            refreshHelp = usage?.refreshUnavailableReason != null
            refreshingSince = 0L
        }
    }
    if (refreshHelp) AlertDialog(
        onDismissRequest = { refreshHelp = false },
        title = { Text("额度没有更新") },
        text = { Text(usage?.refreshHelp(now) ?: "暂时无法获取新的 Claude 额度。") },
        confirmButton = { TextButton(onClick = { refreshHelp = false }) { Text("知道了") } },
    )
    LaunchedEffect(refreshingSince) { if (refreshingSince > 0) { delay(60_000); refreshingSince = 0L } }
    val refreshing = refreshingSince > 0
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = if (inCard) 4.dp else 12.dp).padding(top = if (inCard) 6.dp else 0.dp, bottom = 6.dp),
        color = if (inCard) Color.Transparent else SurfaceAlt.copy(alpha = 0.62f),
        shape = RoundedCornerShape(12.dp),
        border = if (inCard) null else BorderStroke(0.5.dp, Divider.copy(alpha = 0.8f)),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    usage?.freshnessLabel(now) ?: "暂时无法获取",
                    style = MaterialTheme.typography.labelSmall,
                    // An old figure kept as an upper bound is still useful: only
                    // flag red when a stale window has no figure at all.
                    color = if (listOfNotNull(usage?.fiveHour, usage?.sevenDay).any { it.stale && it.remainingPercent == null }) Danger else Muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { contentDescription = usage?.freshnessLabel(now) ?: "暂时无法获取" },
                )
                ClaudeQuotaRow("5小时", usage?.fiveHour, fiveHourResetLabel(usage?.fiveHour?.resetsAt, now, usage?.fiveHour?.remainingPercent, usage?.fiveHour?.resetEstimated == true), usage == null, now)
                ClaudeQuotaRow("本周", usage?.sevenDay, weeklyResetLabel(usage?.sevenDay?.resetsAt, now, usage?.sevenDay?.resetEstimated == true), usage == null, now)
            }
            IconButton(
                onClick = { if (!refreshing) { refreshResultBefore = usage?.refreshResultAt ?: 0L; refreshingSince = System.currentTimeMillis(); vm.refreshClaudeUsage() } },
                enabled = connection == ConnectionState.Online && !refreshing && usage?.accountState != "switching",
                modifier = Modifier.size(40.dp).semantics { contentDescription = "刷新 Claude 额度" },
            ) {
                if (refreshing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
                else Icon(Icons.Default.Refresh, null, Modifier.size(18.dp), tint = Accent)
            }
        }
    }
}

/**
 * Header parts that fold away while the list scrolls up and unfold while it
 * scrolls down, following the finger pixel for pixel; on release they settle
 * fully open or closed, continuing the way the finger last moved.
 */
@Stable
private class FoldState {
    var fraction by mutableFloatStateOf(0f) // 0 = open, 1 = folded
    val heights = HashMap<String, Int>()
    private var lastDy = 0f
    val connection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            val total = heights.values.sum().toFloat()
            if (total <= 0f || available.y == 0f) return Offset.Zero
            lastDy = available.y
            val before = fraction
            fraction = (before - available.y / total).coerceIn(0f, 1f)
            return Offset(0f, (before - fraction) * total)
        }

        override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
            val target = if (lastDy < 0f) (if (fraction > 0.15f) 1f else 0f) else (if (fraction < 0.85f) 0f else 1f)
            if (fraction != target) {
                androidx.compose.animation.core.animate(fraction, target, animationSpec = androidx.compose.animation.core.spring(dampingRatio = 1f, stiffness = 500f)) { value, _ -> fraction = value }
            }
            return Velocity.Zero
        }
    }

    /** Opens everything again, as when the list is pulled back down. */
    suspend fun expand() {
        androidx.compose.animation.core.animate(fraction, 0f, animationSpec = androidx.compose.animation.core.spring(dampingRatio = 1f, stiffness = 500f)) { value, _ -> fraction = value }
    }
}

/**
 * The opposite of [FoldAway]: grows in while the rest folds. Its height counts
 * negatively, so the list still moves exactly with the finger.
 */
@Composable
private fun FoldIn(state: FoldState, key: String, content: @Composable () -> Unit) {
    DisposableEffect(key) { onDispose { state.heights.remove(key) } }
    Box(
        Modifier.fillMaxWidth().clipToBounds().layout { measurable, constraints ->
            val placeable = measurable.measure(constraints.copy(minHeight = 0))
            state.heights[key] = -placeable.height
            val f = state.fraction
            val height = (placeable.height * f).roundToInt()
            layout(placeable.width, height) {
                placeable.placeWithLayer(0, height - placeable.height) { alpha = ((f - 0.35f) / 0.65f).coerceIn(0f, 1f) }
            }
        },
    ) { content() }
}

/** A computer's name without the "后台连接器" the connector adds to it. */
private fun computerLabel(pc: DeviceEntry): String =
    pc.name.removeSuffix(" 后台连接器").removeSuffix(" Connector").ifBlank { pc.name }

private fun connectionColor(connection: ConnectionState): Color = when (connection) {
    ConnectionState.Online -> P.success
    ConnectionState.Connecting -> P.warm
    ConnectionState.Offline -> P.danger
}

/** The home header's first line: logo, connection, refresh, new task and the account. */
@Composable
private fun HomeTitleBar(
    status: String,
    connection: ConnectionState,
    refreshing: Boolean,
    accounts: (@Composable () -> Unit)?,
    refresh: () -> Unit,
    create: () -> Unit,
    avatar: @Composable () -> Unit,
    openAccount: () -> Unit,
) {
    val spin = rememberInfiniteTransition(label = "home-refresh")
    val rotation by spin.animateFloat(0f, 360f, infiniteRepeatable(tween(800), RepeatMode.Restart), label = "home-refresh-rotation")
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(R.drawable.khlink_logo), null, Modifier.size(24.dp), contentScale = ContentScale.Fit)
        Spacer(Modifier.width(5.dp))
        Column(Modifier.weight(1f)) {
            KhLinkWordmark(18.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).background(connectionColor(connection), CircleShape))
                Spacer(Modifier.width(5.dp))
                Text(status, style = MaterialTheme.typography.labelSmall, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        accounts?.invoke()
        IconButton(refresh, Modifier.size(40.dp), enabled = !refreshing) {
            Icon(Icons.Default.Refresh, "刷新", Modifier.size(20.dp).graphicsLayer { rotationZ = if (refreshing) rotation else 0f }, tint = Ink)
        }
        IconButton(create, Modifier.size(40.dp)) { Icon(Icons.Default.Add, "新任务", Modifier.size(22.dp), tint = Ink) }
        // The Codex theme has the avatar at the bottom of its rail instead.
        if (!CodexLayout) IconButton(openAccount, Modifier.size(44.dp)) { avatar() }
    }
}

/** What is left of the header when it is folded: where you are, and "+". Tap to open it again. */
@Composable
private fun FoldedHomeBar(agent: String, count: Int, computer: String?, connection: ConnectionState, expand: () -> Unit, create: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(44.dp).clickable(onClickLabel = "展开顶部") { expand() }.padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The computer's name gets all the room left of the buttons, not half of it.
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            AgentLogo(agent, 18.dp)
            Spacer(Modifier.width(7.dp))
            Text(homeTabLabel(agent, 3), color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            if (count > 0) Text(" $count", color = Muted, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            if (computer != null) {
                Text("  ·  ", color = Muted.copy(alpha = 0.6f), style = MaterialTheme.typography.labelMedium)
                Text(computer, Modifier.weight(1f, fill = false), color = Muted, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(8.dp))
            Box(Modifier.size(6.dp).background(connectionColor(connection), CircleShape))
        }
        Icon(Icons.Default.UnfoldMore, null, Modifier.size(18.dp), tint = Muted)
        IconButton(create, Modifier.size(40.dp)) { Icon(Icons.Default.Add, "新任务", Modifier.size(22.dp), tint = Ink) }
    }
}

/** Where a row sits in its rounded group: its corners and whether a divider follows it. */
private enum class GroupPos { Single, First, Middle, Last }

private fun groupPosition(index: Int, size: Int): GroupPos = when {
    size <= 1 -> GroupPos.Single
    index == 0 -> GroupPos.First
    index == size - 1 -> GroupPos.Last
    else -> GroupPos.Middle
}

private val GroupRadius = 14.dp

private fun groupShape(pos: GroupPos): androidx.compose.ui.graphics.Shape = when (pos) {
    GroupPos.Single -> RoundedCornerShape(GroupRadius)
    GroupPos.First -> RoundedCornerShape(topStart = GroupRadius, topEnd = GroupRadius)
    GroupPos.Last -> RoundedCornerShape(bottomStart = GroupRadius, bottomEnd = GroupRadius)
    GroupPos.Middle -> androidx.compose.ui.graphics.RectangleShape
}

/**
 * The group's hairline outline, drawn row by row: the rounded outline of a
 * taller box, clipped to this row, so only its own edges and corners show.
 */
private fun Modifier.groupOutline(pos: GroupPos, color: Color): Modifier = drawWithContent {
    drawContent()
    val stroke = 0.75.dp.toPx()
    val radius = GroupRadius.toPx()
    val top = if (pos == GroupPos.First || pos == GroupPos.Single) 0f else -radius * 2
    val bottom = if (pos == GroupPos.Last || pos == GroupPos.Single) size.height else size.height + radius * 2
    clipRect {
        drawRoundRect(
            color,
            topLeft = Offset(stroke / 2, top + stroke / 2),
            size = androidx.compose.ui.geometry.Size(size.width - stroke, bottom - top - stroke),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius - stroke / 2),
            style = androidx.compose.ui.graphics.drawscope.Stroke(stroke),
        )
    }
}

@Composable
private fun FoldAway(state: FoldState, key: String, content: @Composable () -> Unit) {
    DisposableEffect(key) { onDispose { state.heights.remove(key) } }
    Box(
        Modifier.fillMaxWidth().clipToBounds().layout { measurable, constraints ->
            val placeable = measurable.measure(constraints.copy(minHeight = 0))
            state.heights[key] = placeable.height
            val f = state.fraction
            val height = (placeable.height * (1f - f)).roundToInt()
            // Slides up under the part above while fading, rather than being cut off.
            layout(placeable.width, height) {
                placeable.placeWithLayer(0, height - placeable.height) { alpha = (1f - f * 1.3f).coerceIn(0f, 1f) }
            }
        },
    ) { content() }
}

private data class RailQuota(val short: String, val label: String, val remaining: Int?, val reset: String?, val color: Color, val remainingText: String? = null) {
    val displayRemaining: String get() = remainingText ?: "剩余 ${remaining?.let { "$it%" } ?: "—"}"
}

/** Conversation's left edge: remaining quota as slim vertical gauges (Claude 5 h + week, Codex week). Tap for details. */
@Composable
private fun QuotaRail(vm: BridgeViewModel, tab: String, caps: CapabilityState, modifier: Modifier = Modifier) {
    val connection by vm.connection.collectAsState()
    val observedUsage by vm.claudeUsage.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    val usage = observedUsage?.displayAt(now)
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() } }
    LaunchedEffect(connection, tab) { if (tab == "claude" && connection == ConnectionState.Online && vm.claudeUsage.value == null) vm.claudeUsage() }
    val weekColor = Color(0xFF3B82F6)
    val bars = when (tab) {
        "claude" -> listOf(
            RailQuota("5h", "5小时", usage?.fiveHour?.remainingPercent, fiveHourResetLabel(usage?.fiveHour?.resetsAt, now, usage?.fiveHour?.remainingPercent, usage?.fiveHour?.resetEstimated == true), Color(0xFFD97757), usage?.fiveHour.remainingLabel(now)),
            RailQuota("周", "本周", usage?.sevenDay?.remainingPercent, weeklyResetLabel(usage?.sevenDay?.resetsAt, now, usage?.sevenDay?.resetEstimated == true), weekColor, usage?.sevenDay.remainingLabel(now)),
        )
        "codex" -> listOf(RailQuota("周", "本周", caps.weeklyRemainingPercent, capsResetLabel(caps)?.let { "重置 $it" }, weekColor))
        else -> return
    }
    // Hairline gauges hugging the screen edge (colour tells them apart); the
    // numbers are one tap away so the conversation keeps its width.
    val density = androidx.compose.ui.platform.LocalDensity.current
    var details by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier.fillMaxHeight().padding(start = 3.dp, top = 8.dp, bottom = 8.dp)
                .clickable(interactionSource = null, indication = null) { details = !details }
                .semantics(mergeDescendants = true) { contentDescription = bars.joinToString("，") { "${it.label}额度 ${it.displayRemaining}" } },
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            bars.forEach { bar ->
                val low = bar.remaining != null && bar.remaining < 20
                VerticalGauge(bar.remaining, if (low) Danger else bar.color, Modifier.width(3.dp).fillMaxHeight())
            }
        }
        if (details) {
            Popup(
                alignment = Alignment.CenterStart,
                offset = androidx.compose.ui.unit.IntOffset(with(density) { 16.dp.roundToPx() }, 0),
                onDismissRequest = { details = false },
                properties = PopupProperties(focusable = true),
            ) {
                Surface(shape = RoundedCornerShape(14.dp), color = Paper, shadowElevation = 6.dp, border = BorderStroke(0.5.dp, Divider)) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (tab == "claude") Text(usage?.freshnessLabel(now) ?: "暂时无法获取", style = MaterialTheme.typography.labelSmall, color = Muted)
                        bars.forEach { bar ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(8.dp).background(bar.color, CircleShape))
                                Spacer(Modifier.width(8.dp))
                                Text("${bar.label}  ${bar.displayRemaining}", style = MaterialTheme.typography.labelMedium, color = Ink, fontWeight = FontWeight.SemiBold)
                                bar.reset?.let { Spacer(Modifier.width(8.dp)); Text(it, style = MaterialTheme.typography.labelSmall, color = Muted) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A slim vertical bar filling from the bottom with the remaining share. */
@Composable
private fun VerticalGauge(remaining: Int?, color: Color, modifier: Modifier) {
    val level by animateFloatAsState((remaining ?: 0).coerceIn(0, 100) / 100f, tween(700), label = "quota-gauge")
    val track = Divider.copy(alpha = 0.7f)
    androidx.compose.foundation.Canvas(modifier) {
        val radius = androidx.compose.ui.geometry.CornerRadius(size.width / 2, size.width / 2)
        drawRoundRect(track, cornerRadius = radius)
        if (remaining != null && level > 0f) {
            val h = (size.height * level).coerceAtLeast(size.width)
            drawRoundRect(
                androidx.compose.ui.graphics.Brush.verticalGradient(listOf(color.copy(alpha = 0.55f), color), startY = size.height - h, endY = size.height),
                topLeft = Offset(0f, size.height - h),
                size = androidx.compose.ui.geometry.Size(size.width, h),
                cornerRadius = radius,
            )
        }
    }
}

/** The computer's load samples, null while offline or stale (no sample for 20 s). */
@Composable
private fun freshPcLoad(vm: BridgeViewModel, connection: ConnectionState): PcLoad? {
    val load by vm.pcLoad.collectAsState()
    // Re-check freshness when no new sample arrives (computer gone quiet).
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(load) { now = System.currentTimeMillis(); delay(21_000); now = System.currentTimeMillis() }
    // A new sample arrives before the effect below refreshes `now`: judge it
    // against whichever is later, or every sample blinks grey for a frame.
    return load.takeIf { connection == ConnectionState.Online && it != null && it.isFresh(maxOf(now, it.receivedAt)) }
}

private val PcLoadColors = listOf(Color(0xFF3B82F6), Color(0xFF16A34A), Color(0xFFF59E0B))

/** The computer's new content cannot reach the relay: say so (home list and conversation). */
@Composable
private fun UploadIssueBar(vm: BridgeViewModel) {
    val issue by vm.uploadIssue.collectAsState()
    AnimatedVisibility(issue != null, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        val shown = issue ?: return@AnimatedVisibility
        Surface(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), color = P.waitingContainer, shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, P.waitingBorder)) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.CloudOff, null, Modifier.size(18.dp), tint = WaitingInk)
                Spacer(Modifier.width(8.dp))
                Text(uploadIssueText(shown), color = WaitingInk, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Home row under the header: CPU, GPU and memory, each a small ring and its percentage. */
@Composable
private fun PcLoadBar(vm: BridgeViewModel, connection: ConnectionState) {
    val load = freshPcLoad(vm, connection)
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        listOf("CPU" to load?.cpu, "GPU" to load?.gpu, "内存" to load?.mem).forEachIndexed { index, (label, value) ->
            Row(
                Modifier.weight(1f).semantics(mergeDescendants = true) { contentDescription = "电脑$label 占用 ${value?.let { "$it%" } ?: "未知"}" },
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                LoadArc(value, PcLoadColors[index], Modifier.size(16.dp), 2.5.dp)
                Spacer(Modifier.width(6.dp))
                Text(label, style = MaterialTheme.typography.labelMedium, color = Muted, maxLines = 1)
                Spacer(Modifier.width(4.dp))
                Text(value?.let { "$it%" } ?: "—", style = MaterialTheme.typography.labelMedium, color = if (value != null) Ink else Muted, fontWeight = FontWeight.SemiBold, maxLines = 1)
            }
        }
    }
}

@Composable
private fun LoadArc(value: Int?, color: Color, modifier: Modifier, strokeWidth: androidx.compose.ui.unit.Dp) {
    val sweep by animateFloatAsState((value ?: 0) / 100f, tween(600), label = "load-ring")
    val track = Divider.copy(alpha = 0.8f)
    val stroke = with(androidx.compose.ui.platform.LocalDensity.current) { strokeWidth.toPx() }
    androidx.compose.foundation.Canvas(modifier) {
        val inset = stroke / 2
        val topLeft = androidx.compose.ui.geometry.Offset(inset, inset)
        val arcSize = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
        drawArc(track, 0f, 360f, false, topLeft, arcSize, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
        if (value != null) drawArc(color, -90f, 360f * sweep, false, topLeft, arcSize,
            style = androidx.compose.ui.graphics.drawscope.Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
    }
}

// iOS system colours for the load columns: blue, green, orange.
private val StatsLoadColors = listOf(Color(0xFF007AFF), Color(0xFF34C759), Color(0xFFFF9500))

/**
 * What the list title folds out, as a compact iOS inset grouped card: the
 * computer, its load (only when turned on in the settings) and the quota,
 * each one short row divided by a hairline.
 */
@Composable
private fun ChatStatsCard(
    vm: BridgeViewModel, computers: List<DeviceEntry>, selectedId: String?, agent: String, agents: List<String>,
    connection: ConnectionState, showLoad: Boolean, caps: CapabilityState, claudeEnabled: Boolean,
) {
    Surface(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
        shape = RoundedCornerShape(12.dp),
        color = SurfaceBase,
    ) {
        Column {
            if (computers.size > 1) StatsComputerPicker(vm, computers, selectedId, agent, agents)
            else StatsComputerRow(computers.firstOrNull()?.name, connection)
            if (showLoad) {
                StatsHairline()
                StatsLoadRow(freshPcLoad(vm, connection))
            }
            val quota: (@Composable () -> Unit)? = when {
                agent == "codex" -> { { StatsCodexQuota(caps) } }
                agent == "claude" && claudeEnabled -> { { ClaudeQuotaStrip(vm, inCard = true) } }
                agent == "dsh" -> { { DshQuotaStrip(vm, inCard = true) } }
                else -> null
            }
            quota?.let { StatsHairline(); it() }
        }
    }
}

@Composable
private fun StatsHairline() = HorizontalDivider(Modifier.padding(start = 12.dp), thickness = 0.5.dp, color = Divider)

/** One computer: an icon, its name and whether it is online, on one short line. */
@Composable
private fun StatsComputerRow(name: String?, connection: ConnectionState) {
    val (label, color) = when (connection) {
        ConnectionState.Online -> "在线" to P.success
        ConnectionState.Connecting -> "连接中" to P.warm
        ConnectionState.Offline -> "离线" to Muted
    }
    Row(Modifier.fillMaxWidth().heightIn(min = 38.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(22.dp).clip(RoundedCornerShape(6.dp)).background(Accent), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.Computer, null, Modifier.size(14.dp), tint = Color.White)
        }
        Spacer(Modifier.width(8.dp))
        Text(computerLabel(name) ?: "这台电脑", Modifier.weight(1f), color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.size(6.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(5.dp))
        Text(label, color = Muted, fontSize = 12.sp, maxLines = 1)
    }
}

private fun computerLabel(name: String?) = name?.removeSuffix(" 后台连接器")?.removeSuffix(" Connector")?.takeIf(String::isNotBlank)

/** Several computers: a slim iOS segmented control, a dot on each telling whether it is online. */
@Composable
private fun StatsComputerPicker(vm: BridgeViewModel, computers: List<DeviceEntry>, selectedId: String?, agent: String, agents: List<String>) {
    val seenAt by vm.connectorSeenAt.collectAsState()
    val phoneNetworkAvailable by vm.phoneNetworkAvailable.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(5_000); now = System.currentTimeMillis() } }
    val haptics = rememberHaptics()
    val scroll = computers.size > 3
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Ink.copy(alpha = 0.06f)).padding(2.dp)
                .then(if (scroll) Modifier.horizontalScroll(rememberScrollState()) else Modifier),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            computers.forEach { pc ->
                val chosen = pc.id == selectedId
                val presence = computerPresence(phoneNetworkAvailable, seenAt[pc.id], now)
                val online = presence == ComputerPresence.Online
                Surface(
                    (if (scroll) Modifier else Modifier.weight(1f)).heightIn(min = 26.dp).clip(RoundedCornerShape(6.dp))
                        .clickable { if (!chosen) { haptics.tick(); vm.selectConnectorForAgent(agent, pc.id, agents) } }
                        .semantics { contentDescription = "电脑 ${pc.name} ${computerPresenceLabel(presence)}${if (chosen) "，当前" else ""}" },
                    shape = RoundedCornerShape(6.dp),
                    color = if (chosen) SurfaceBase else Color.Transparent,
                    shadowElevation = if (chosen) 1.dp else 0.dp,
                ) {
                    Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(if (online) P.success else Muted.copy(alpha = 0.5f)))
                        Spacer(Modifier.width(5.dp))
                        Text(computerLabel(pc.name) ?: pc.name, color = Ink, fontSize = 12.sp, fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** CPU, GPU and memory side by side: label and figure on one line, a thin capsule under it. */
@Composable
private fun StatsLoadRow(load: PcLoad?) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        listOf("CPU" to load?.cpu, "GPU" to load?.gpu, "内存" to load?.mem).forEachIndexed { index, (label, value) ->
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) { contentDescription = "电脑$label 占用 ${value?.let { "$it%" } ?: "未知"}" }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(label, Modifier.weight(1f), color = Muted, fontSize = 12.sp, maxLines = 1)
                    Text(value?.let { "$it%" } ?: "—", color = if (value != null) Ink else Muted, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
                Spacer(Modifier.height(4.dp))
                StatsCapsule(value, StatsLoadColors[index], 3.dp)
            }
        }
    }
}

/** A thin rounded bar filled to [value] percent. */
@Composable
private fun StatsCapsule(value: Int?, color: Color, height: androidx.compose.ui.unit.Dp, loading: Boolean = false) {
    val fraction by animateFloatAsState((value ?: 0).coerceIn(0, 100) / 100f, tween(600), label = "stats-capsule")
    Box(Modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(50)).background(Ink.copy(alpha = 0.07f))) {
        if (loading) LinearProgressIndicator(Modifier.fillMaxSize(), color = Muted.copy(alpha = 0.6f), trackColor = Color.Transparent)
        else if (value != null && fraction > 0f) Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().clip(RoundedCornerShape(50)).background(color))
    }
}

/** Codex's weekly quota: title and reset time on the left, what is left on the right, a capsule under them. */
@Composable
private fun StatsCodexQuota(caps: CapabilityState) {
    val remaining = caps.weeklyRemainingPercent
    val label = when {
        caps.quotaAccountState == "signed_out" -> "未登录"
        remaining == null && caps.quotaState == "loading" -> "读取中"
        remaining == null -> "暂不可用"
        caps.quotaState == "cached" -> "缓存 $remaining%"
        else -> "剩余 $remaining%"
    }
    val color = when {
        remaining == null -> Muted
        remaining < 20 -> Danger
        caps.quotaState == "cached" -> Warm
        else -> Accent
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("本周额度", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1)
            Text(capsResetLabel(caps)?.let { " · $it 重置" }.orEmpty(), Modifier.weight(1f), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(label, color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
        Spacer(Modifier.height(5.dp))
        StatsCapsule(remaining, color, 4.dp, loading = remaining == null && caps.quotaState == "loading")
    }
}

@Composable
private fun ClaudeQuotaRow(label: String, window: ClaudeUsageWindow?, reset: String, loading: Boolean, now: Long) {
    val remaining = window?.remainingPercent
    val color = when { remaining == null -> Muted; remaining < 20 -> Danger; else -> P.claudeInk }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(38.dp), style = MaterialTheme.typography.labelMedium, color = Ink, fontWeight = FontWeight.SemiBold)
        QuotaBar(remaining, loading, Modifier.width(64.dp))
        Spacer(Modifier.width(8.dp))
        Text(window.remainingLabel(now), style = MaterialTheme.typography.labelSmall, color = color, fontWeight = FontWeight.SemiBold, maxLines = 1)
        Spacer(Modifier.width(8.dp))
        Text(reset, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun QuotaBar(remaining: Int?, loading: Boolean, modifier: Modifier = Modifier) {
    val trackColor = Divider.copy(alpha = 0.48f)
    if (loading) {
        LinearProgressIndicator(
            modifier = modifier.height(8.dp),
            color = Muted.copy(alpha = 0.8f),
            trackColor = trackColor,
            strokeCap = StrokeCap.Butt,
        )
        return
    }
    val fraction = (remaining ?: 0).coerceIn(0, 100) / 100f
    val fillColor = when {
        remaining == null -> Muted.copy(alpha = 0.65f)
        remaining < 20 -> Danger
        else -> Accent
    }
    Box(
        modifier
            .height(8.dp)
            .clip(RoundedCornerShape(50))
            .background(trackColor),
    ) {
        if (fraction > 0f) {
            Box(
                Modifier
                    .fillMaxWidth(fraction)
                    .fillMaxSize()
                    .background(fillColor),
            )
        }
    }
}

private fun capsResetLabel(caps: CapabilityState): String? = caps.weeklyResetAt?.let { formatTime(it) }

@Composable
private fun ThreadSection(label: String, image: ImageVector, count: Int) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 6.dp, end = 6.dp, top = 12.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(image, null, Modifier.size(13.dp), tint = Muted)
        Spacer(Modifier.width(5.dp))
        Text(label, fontSize = 12.sp, color = Muted, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
        Spacer(Modifier.width(5.dp))
        Text("$count", fontSize = 11.sp, color = Muted.copy(alpha = 0.7f))
    }
}

@Composable
private fun NewTaskDialog(initialBackend: String, claudeModels: List<ClaudeModel>, recentDirs: List<String>, codexSandboxBlocked: Boolean, claudeEnabled: Boolean, claudeNotice: () -> Unit, close: () -> Unit, create: (String, String, String, String, String, String, String) -> Unit) {
    // The permission mode chosen last time, per agent, is where the next task starts.
    val modePrefs = LocalContext.current.getSharedPreferences("new-task", android.content.Context.MODE_PRIVATE)
    // On a computer where Codex's sandbox cannot start PowerShell, every mode
    // but full access hangs, so a new Codex task starts in full access.
    fun lastMode(agent: String) = if (agent == "codex" && codexSandboxBlocked) "yolo"
        else modePrefs.getString("mode.$agent", null) ?: if (agent == "claude") "default" else "manual"
    var cwd by remember { mutableStateOf(recentDirs.firstOrNull() ?: "C:\\") }; var prompt by remember { mutableStateOf("") }; var collaborationMode by remember { mutableStateOf("default") }
    var backend by remember { mutableStateOf(if (initialBackend == "claude" && !claudeEnabled) "codex" else backendTab(initialBackend)) }
    var mode by remember { mutableStateOf(lastMode(backendTab(initialBackend))) }
    var claudeModel by remember { mutableStateOf("") }; var claudeEffort by remember { mutableStateOf("") }
    val agentLabel = when (backend) { "claude" -> "Claude Code"; "pi" -> "Pi"; "dsh" -> "DeepSeek"; "hermes" -> "Hermes"; else -> "Codex" }
    // Hermes works in Linux folders, the others in Windows ones.
    LaunchedEffect(backend) {
        val linux = backend == "hermes"
        if (linux != cwd.startsWith("/")) cwd = recentDirs.firstOrNull { it.startsWith("/") == linux } ?: if (linux) "" else "C:\\"
    }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("新建任务", fontWeight = FontWeight.Bold, color = Ink) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("智能体", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = Ink)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("codex" to "Codex", "dsh" to "DSH", "claude" to "Claude", "hermes" to "Hermes", "pi" to "Pi").forEach { (id, label) ->
                        val isSelected = backend == id
                        OutlinedButton(
                            onClick = { if (id == "claude" && !claudeEnabled) claudeNotice() else { backend = id; mode = lastMode(id); if (id == "claude") collaborationMode = "default" } },
                            modifier = Modifier.weight(1f).heightIn(min = 72.dp),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 8.dp),
                            shape = RoundedCornerShape(10.dp),
                            border = BorderStroke(1.dp, if (isSelected) Accent else Divider),
                            colors = ButtonDefaults.outlinedButtonColors(containerColor = if (isSelected) P.selected else Color.Transparent),
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                AgentLogo(id, 24.dp)
                                Text(label, color = if (isSelected) Accent else Ink, fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
                OutlinedTextField(
                    cwd,
                    { cwd = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("工作目录") },
                    shape = RoundedCornerShape(10.dp),
                    singleLine = true,
                )
                // Folders used recently on this computer, newest first.
                if (recentDirs.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    recentDirs.take(12).forEach { dir ->
                        val chosen = dir.equals(cwd, ignoreCase = true)
                        Surface(
                            Modifier.clickable { cwd = dir },
                            shape = RoundedCornerShape(50),
                            color = if (chosen) P.selected else Color.Transparent,
                            border = BorderStroke(0.5.dp, if (chosen) Accent else Divider),
                        ) {
                            Text(folderName(dir), Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = if (chosen) Accent else Ink, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                        }
                    }
                }
                OutlinedTextField(
                    prompt,
                    { prompt = it },
                    Modifier.fillMaxWidth(),
                    label = { Text("第一条指令") },
                    shape = RoundedCornerShape(10.dp),
                    minLines = 3,
                    maxLines = 7,
                )
                if (backend == "claude") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.weight(1f)) { Choice("模型", claudeModelLabel(claudeModel, claudeModels), claudeModelOptions(claudeModels)) { claudeModel = it; if (claudeEffort.isNotBlank() && claudeEffort !in claudeEffortsFor(it, claudeModels)) claudeEffort = "" } }
                        Box(Modifier.weight(1f)) { Choice("强度", claudeEffortLabel(claudeEffort), claudeEffortOptions(claudeModel, claudeModels)) { claudeEffort = it } }
                    }
                }
                // Pi's model, thinking level and tools are set in PI WEB / its settings.
                if (backend == "pi") Text("Pi 会话在电脑上的 PI WEB 里运行；模型和思考强度建好后在会话顶部设置。", color = Muted, style = MaterialTheme.typography.bodySmall)
                else if (backend == "dsh") Text("DeepSeek Harness 会话在电脑上的 DSH 桌面端里运行；新会话使用桌面端当前的模型和权限，创建后可在会话设置里修改。", color = Muted, style = MaterialTheme.typography.bodySmall)
                else if (backend == "hermes") Text("Hermes 在这台电脑的 Linux（WSL）里运行，工作目录填 Linux 路径，留空用家目录。可以直接发 /goal、/loop、/kanban 等命令；模型和专家会诊建好后在会话顶部切换。", color = Muted, style = MaterialTheme.typography.bodySmall)
                else PermissionModePicker(if (backend == "claude") "claude" else "codex", mode) { mode = it; modePrefs.edit().putString("mode.$backend", it).apply() }
                if (backend == "codex" && codexSandboxBlocked && mode != "yolo") Text(
                    "这台电脑的 PowerShell 是微软商店版，Codex 在沙箱里启动不了它：选这个模式时命令会一直卡住。请选「完全访问权限」，或在电脑上安装 PowerShell 的安装包版（msi）。",
                    color = Danger, style = MaterialTheme.typography.bodySmall,
                )
                // Claude Code has no plan/execute collaboration mode; only Codex exposes it.
                if (backend == "codex") {
                    Text("工作模式", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = Ink)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("default" to "执行", "plan" to "计划").forEach { (id, label) ->
                            val isSelected = collaborationMode == id
                            OutlinedButton(
                                onClick = { collaborationMode = id },
                                shape = RoundedCornerShape(10.dp),
                                border = BorderStroke(1.dp, if (isSelected) Accent else Divider),
                                colors = ButtonDefaults.outlinedButtonColors(containerColor = if (isSelected) P.selected else Color.Transparent),
                            ) {
                                Text(label, color = if (isSelected) Accent else Ink, fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal)
                            }
                        }
                    }
                    if (collaborationMode == "plan") Text("计划模式会先整理方案，确认后再执行。", color = Accent, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        dismissButton = { TextButton(close) { Text("取消", color = Muted) } },
        confirmButton = {
            Button(
                onClick = { create(cwd, prompt, mode, collaborationMode, backend, if (backend == "claude") claudeModel else "", if (backend == "claude") claudeEffort else "") },
                enabled = cwd.isNotBlank() && prompt.isNotBlank(),
                shape = RoundedCornerShape(10.dp),
            ) { Text("开始") }
        },
    )
}

// The selected computer does not have this agent at all (a new user's PC):
// say so instead of "no tasks yet" and a quota that can never load.
@Composable
private fun AgentNotInstalledState(agent: String) {
    val name = homeTabLabel(agent, 4)
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 80.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("这台电脑还没有安装 $name", fontWeight = FontWeight.SemiBold)
        Text("在电脑上装好 $name 后，khLink 会自动接上；也可以在设置里换成别的 Agent。",
            color = Color.Gray, style = MaterialTheme.typography.bodySmall, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun EmptyState(connection: ConnectionState) {
    Column(Modifier.fillMaxWidth().padding(vertical = 80.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        val connecting = connection == ConnectionState.Connecting
        Text(when (connection) {
            ConnectionState.Online -> "还没有同步到任务"
            ConnectionState.Connecting -> "正在连接电脑"
            ConnectionState.Offline -> "电脑当前离线"
        }, fontWeight = FontWeight.SemiBold)
        Text(when (connection) {
            ConnectionState.Online -> "桌面任务会在这里出现"
            ConnectionState.Connecting -> "正在恢复实时同步，请稍候"
            ConnectionState.Offline -> "唤醒电脑后会自动重连"
        }, color = Color.Gray, style = MaterialTheme.typography.bodySmall)
        if (connecting) CircularProgressIndicator(Modifier.padding(top = 12.dp).size(20.dp), strokeWidth = 2.dp, color = Accent)
    }
}

@Composable
private fun ThreadRow(thread: ThreadSummary, status: String, position: GroupPos = GroupPos.Single, shared: Boolean = true, showPin: Boolean = true, onLongPress: (() -> Unit)? = null, open: () -> Unit) {
    val running = isRunningStatus(status)
    val waiting = isWaitingThreadStatus(status)
    val unknown = isUnknownThreadStatus(status)
    // Finished and not yet seen: unread on the computer, or new since opened on the phone.
    val finished = !running && !waiting && isFinishedHighlight(thread, status)
    // Coming back from this conversation: a soft flash says "you were here".
    val returned = LocalReturnedThreadId.current == thread.id
    val flash by animateColorAsState(if (returned) Accent.copy(alpha = 0.10f) else Color.Transparent, tween(if (returned) 260 else 900), label = "thread-row-return")
    val containerColor = if (running) P.runningContainer else if (waiting) P.waitingContainer else SurfaceBase
    val animatedContainerColor by animateColorAsState(containerColor, tween(220), label = "thread-row-background")
    // Running or waiting: a short colored edge on the left, the rest of the row stays calm.
    val edge by animateColorAsState(if (waiting) P.waitingDot else if (running) P.warm else Color.Transparent, tween(220), label = "thread-row-edge")
    val rowInteraction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }

    // One row of a rounded group (2026-11-01): no card of its own, a hairline
    // divider under it, the group's outline drawn around the whole section.
    Box(
        Modifier
            .fillMaxWidth()
            .then(if (shared) Modifier.sharedThreadCard(thread.id) else Modifier)
            .clip(if (FlatLayout) RoundedCornerShape(0.dp) else groupShape(position))
            .background(animatedContainerColor)
            .then(if (FlatLayout) Modifier else Modifier.groupOutline(position, Divider))
            .combinedClickable(interactionSource = rowInteraction, indication = LocalIndication.current, onLongClick = onLongPress, onClick = open),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(flash)
                .animateContentSize(KhMotion.sizeSpring)
                .padding(start = 14.dp, end = 12.dp, top = if (FlatLayout) 8.dp else 9.dp, bottom = if (FlatLayout) 8.dp else 9.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    Text(
                        thread.title.ifBlank { "未命名任务" },
                        (if (shared) Modifier.sharedThreadTitle(thread.id) else Modifier),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = if (FlatLayout) 14.sp else 15.sp,
                        fontWeight = if (FlatLayout) FontWeight.Medium else FontWeight.SemiBold,
                        color = Ink,
                    )
                }
                Spacer(Modifier.width(8.dp))
                Text(formatTime(thread.updatedAt), color = Muted.copy(alpha = 0.8f), fontSize = 11.sp, maxLines = 1)
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                // While waiting, say what the computer needs instead of the folder.
                val waitingLine = if (waiting) waitingPreview(thread.waiting) ?: thread.note else ""
                val showNote = waiting && waitingLine.isNotBlank()
                Text(
                    if (showNote) waitingLine else thread.cwd,
                    Modifier.weight(1f),
                    maxLines = if (showNote) 2 else 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (showNote) P.waitingInk else Muted,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                )
                if (!running && !waiting && (unknown || status.contains("failed", true) || status.contains("stopped", true))) {
                    Spacer(Modifier.width(8.dp))
                    Text(statusLabel(status), color = statusColor(status), fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                }
                // Not in the pinned section itself, where every row would carry one.
                if (thread.pinned && showPin) {
                    Spacer(Modifier.width(6.dp))
                    Icon(Icons.Default.PushPin, "置顶", Modifier.size(12.dp), tint = Muted.copy(alpha = 0.7f))
                }
                // Status as a light only, no words: running and waiting breathe,
                // finished-and-unseen stays lit (green, as the desktop shows it).
                AnimatedVisibility(
                    visible = running || waiting || finished || unknown,
                    enter = fadeIn(tween(160)) + scaleIn(KhMotion.pop(), initialScale = 0.4f),
                    exit = fadeOut(tween(120)) + scaleOut(tween(160)),
                ) {
                    Row { Spacer(Modifier.width(8.dp)); ThreadStatusLight(running, waiting, unknown = unknown) }
                }
                AnimatedVisibility(
                    visible = !running && !waiting && !finished && thread.unread,
                    enter = fadeIn(tween(140)) + scaleIn(KhMotion.pop(), initialScale = 0.2f),
                    exit = fadeOut(tween(100)) + scaleOut(tween(140)),
                ) {
                    Row {
                        Spacer(Modifier.width(8.dp))
                        Box(
                            Modifier
                                .size(8.dp)
                                // Same colour as the desktop app's dot: Claude amber, Codex blue.
                                .background(if (thread.backend == "claude") P.unreadClaude else P.unreadCodex, CircleShape)
                                .semantics { contentDescription = "未读" }
                        )
                    }
                }
            }
        }
        Box(Modifier.matchParentSize()) {
            Box(Modifier.align(Alignment.CenterStart).padding(start = 1.5.dp).width(3.dp).fillMaxHeight(0.56f).background(edge, RoundedCornerShape(50)))
            if (CodexLayout || position == GroupPos.First || position == GroupPos.Middle) {
                Box(Modifier.align(Alignment.BottomStart).padding(start = 14.dp).fillMaxWidth().height(0.5.dp).background(Divider))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThreadScreen(vm: BridgeViewModel, thread: ThreadSummary, back: () -> Unit) {
    // Back (including the predictive gesture) is handled by HomeScreen.
    val haptics = rememberHaptics()
    // WeChat layout: the connection and model line, shown by tapping the title.
    var headerDetails by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val messages by vm.items.collectAsState(); val approval by vm.approval.collectAsState(); val caps by vm.capabilities.collectAsState()
    val claudeModels by vm.claudeModels.collectAsState()
    val connection by vm.connection.collectAsState(); val connectionStatus by vm.statusText.collectAsState()
    val settingsState by vm.threadSettings.collectAsState(); val currentSettings = settingsState[thread.id] ?: ThreadSettings()
    val dshCatalog by vm.dshCatalog.collectAsState()
    val hermesCatalog by vm.hermesCatalog.collectAsState()
    val dshPending by vm.dshPending.collectAsState()
    val dshPendingLoading by vm.dshPendingLoading.collectAsState()
    var dshAnswerOpen by remember { mutableStateOf(false) }
    val usageState by vm.conversationUsage.collectAsState()
    val tokenDisplayUnit by vm.tokenDisplayUnit.collectAsState()
    val usageLoading by vm.usageLoading.collectAsState()
    var showTokenUsage by remember(thread.id) { mutableStateOf(false) }
    val attachments by vm.attachments.collectAsState(); val threadAttachments = attachments[thread.id].orEmpty()
    val answering by vm.answering.collectAsState()
    val answeredPrompts by vm.answered.collectAsState()
    val historyState by vm.historyLoadState.collectAsState()
    val historyLoading = historyState.threadId == thread.id && historyState.loading
    val historySyncing by vm.historySyncing.collectAsState()
    val syncingFromComputer = thread.id in historySyncing
    val liveStatuses by vm.liveStatuses.collectAsState(); val taskStatus = liveStatuses[thread.id] ?: thread.status
    val promptAnswered = desktopPromptAnswered(answeredPrompts[thread.id], thread.waiting?.requestId)
    // Once the computer has moved on, a new question must show again.
    LaunchedEffect(thread.id, thread.waiting?.requestId, isWaitingThreadStatus(taskStatus)) {
        if (answeredPrompts[thread.id] != null && !promptAnswered) vm.forgetAnswered(thread.id)
        if (thread.waiting == null && !isWaitingThreadStatus(taskStatus)) vm.forgetAnswered(thread.id)
    }
    val executionStatuses by vm.executionStatuses.collectAsState(); val executionStatus = executionStatuses[thread.id] ?: thread.status
    val codexQuestionStates by vm.codexQuestionStates.collectAsState()
    val pendingCodexQuestion = codexQuestionStates[thread.id]?.takeIf { it.pending }
    val turnDurations by vm.turnDurations.collectAsState(); val turnDuration = turnDurations[thread.id]
    val queuedInstructions by vm.queuedInstructions.collectAsState(); val allOutgoing = queuedInstructions[thread.id].orEmpty()
    // A message just sent that the computer passes through its queue stays in the
    // conversation for a moment; re-check once that moment is over.
    var queueClock by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(allOutgoing) {
        queueClock = System.currentTimeMillis()
        while (allOutgoing.any { isSettlingInQueue(it, System.currentTimeMillis()) }) { delay(300); queueClock = System.currentTimeMillis() }
        queueClock = System.currentTimeMillis()
    }
    val queued = allOutgoing.filter { showInstructionInQueue(it, queueClock) }
    val steerableQueued = queued.filter { canSteerQueuedInstruction(thread.backend, it.state, it.origin, isTurnBusyStatus(taskStatus)) }
    val modes by vm.threadModes.collectAsState(); val activeMode = modes[thread.id] ?: currentSettings.permissionMode
    val switchingIds by vm.switchingSettings.collectAsState(); val switching = thread.id in switchingIds
    var text by remember(thread.id) { mutableStateOf("") }; var draftLoaded by remember(thread.id) { mutableStateOf(false) }
    // While a turn runs: false = queue for after it (default), true = hand it to the running turn.
    var steerMode by remember(thread.id) { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }; var more by remember { mutableStateOf(false) }; var rename by remember { mutableStateOf(false) }
    var queuedExpanded by remember { mutableStateOf(false) }
    var previewAttachment by remember { mutableStateOf<AttachmentUpload?>(null) }
    var previewHistoryImage by remember { mutableStateOf<HistoryImage?>(null) }
    val messageListState = rememberLazyListState()
    val scrollScope = rememberCoroutineScope()
    var jumpJob by remember(thread.id) { mutableStateOf<Job?>(null) }
    var followLatest by rememberSaveable(thread.id) { mutableStateOf(true) }
    var automaticScroll by remember(thread.id) { mutableStateOf(false) }
    val lightDetails by vm.lightDetails.collectAsState()
    val lightFetching by vm.lightFetching.collectAsState()
    LaunchedEffect(thread.id) { vm.loadLightDetails(thread.id) }
    DisposableEffect(vm, thread.id) { onDispose { vm.cancelLightDetails(thread.id) } }
    val outgoingInline = remember(allOutgoing, queueClock) { allOutgoing.filterNot { showInstructionInQueue(it, queueClock) }.map { it.id }.toSet() }
    val displayMessages = remember(messages, allOutgoing, lightDetails, outgoingInline) {
        // An answer to a Codex question shows as the choice, not the reply block Codex reads.
        // Light mode: a tool step fetched from the computer replaces its placeholder.
        val visible = mergeTransientUserInstructions(messages, allOutgoing, queueClock).map { item ->
            if (item.type.contains("user", true)) {
                val text = displayUploadReferences(questionReplyDisplay(item.text) ?: item.text)
                if (text != item.text) item.copy(text = text) else item
            } else item
        }
        hydrateLightDetailsAndPlaceImages(visible, lightDetails)
    }
    val questionAnswers = remember(messages, allOutgoing) { confirmedCodexAnswers(messages, allOutgoing) }
    val pendingAnswers = remember(allOutgoing) { pendingCodexAnswers(allOutgoing) }
    val activeNextSteps = remember(displayMessages, thread.backend) {
        if (thread.backend == "claude") activeClaudeNextSteps(displayMessages).map { it.id }.toSet() else emptySet()
    }
    val historyBlocks = remember(displayMessages, thread.backend) { groupHistoryItems(displayMessages, inlineReasoning = thread.backend == "claude") }
    val chatMarks = remember(displayMessages) { chatTimeMarks(displayMessages, ::historyItemTimestamp) }
    val turnFooters = remember(displayMessages, usageState[thread.id]) { completedTurnFooters(displayMessages, usageState[thread.id]) }
    val usageHistoryFrom = remember(displayMessages) { displayMessages.mapNotNull(::historyItemTimestamp).minOrNull() ?: 0L }
    LaunchedEffect(thread.id, connection, taskStatus, usageHistoryFrom, showTokenUsage) {
        if (thread.backend == "antigravity" && !showTokenUsage) return@LaunchedEffect
        vm.loadConversationUsage(thread.id, usageHistoryFrom)
        if (connection != ConnectionState.Online) return@LaunchedEffect
        // A terminal status can arrive a little before the last transcript row.
        // Refresh twice to settle it, then poll only while a turn/panel is active.
        repeat(2) { delay(2_000); vm.loadConversationUsage(thread.id, usageHistoryFrom) }
        while (isTurnBusyStatus(taskStatus) || showTokenUsage) {
            delay(8_000); vm.loadConversationUsage(thread.id, usageHistoryFrom)
        }
    }
    val askedNow by vm.codexQuestion.collectAsState()
    // Blocks on screen when the history first arrived do not animate; later ones rise in.
    val seenHistoryKeys = remember(thread.id) { HashSet<String>() }
    SideEffect { historyBlocks.forEach { seenHistoryKeys += it.key } }
    val latestPreview = remember(displayMessages) { latestExecutionPreview(displayMessages) }
    // The task list of the turn now running (none once a newer message follows it).
    val liveTaskListId = remember(displayMessages) {
        val index = displayMessages.indexOfLast { it.type == "claudeTaskList" }
        displayMessages.getOrNull(index)?.takeIf { displayMessages.drop(index + 1).none { later -> later.type.contains("user", true) } }?.id
    }
    val userMessageAnchors = remember(historyBlocks) {
        historyBlocks.reversed().mapIndexedNotNull { renderedIndex, block ->
            (block as? HistoryBlock.Single)
                ?.takeIf { it.item.type.contains("user", true) }
                ?.let { UserMessageAnchor(it.key, renderedIndex, 0) }
        // The conversation uses reverseLayout, so rendered index 0 is the
        // newest message at the bottom. The rail is laid out top-to-bottom;
        // keep the oldest anchor at the top and the newest at the bottom.
        }.reversed().mapIndexed { ordinal, anchor -> anchor.copy(ordinal = ordinal) }
    }
    val activeUserMessageIndex by remember(userMessageAnchors) {
        derivedStateOf {
            if (userMessageAnchors.isEmpty()) {
                -1
            } else {
                val firstVisible = messageListState.firstVisibleItemIndex
                val visible = messageListState.layoutInfo.visibleItemsInfo.map { it.index }.toSet()
                userMessageAnchors.indexOfFirst { it.renderedIndex in visible }.takeIf { it >= 0 }
                    ?: userMessageAnchors.minByOrNull { abs(it.renderedIndex - firstVisible) }?.ordinal
                    ?: 0
            }
        }
    }
    val atLatestContent by remember {
        derivedStateOf {
            isAtLatestContent(messageListState.firstVisibleItemIndex, messageListState.firstVisibleItemScrollOffset)
        }
    }
    suspend fun jumpToLatest(smooth: Boolean = true) {
        followLatest = true
        automaticScroll = true
        try {
            if (smooth) messageListState.animateScrollToItem(0) else messageListState.scrollToItem(0)
        } finally {
            automaticScroll = false
        }
    }
    fun requestJumpToLatest(smooth: Boolean = true) {
        // Keep all programmatic scrolling in the same scope. A new request
        // cancels the previous one instead of letting several scroll jobs race
        // while streamed history is being appended.
        jumpJob?.cancel()
        jumpJob = scrollScope.launch { jumpToLatest(smooth) }
    }
    fun requestJumpToMessage(renderedIndex: Int) {
        jumpJob?.cancel()
        jumpJob = scrollScope.launch {
            followLatest = false
            automaticScroll = true
            try {
                messageListState.animateScrollToItem(renderedIndex)
            } finally {
                automaticScroll = false
            }
        }
    }
    // Anything new at the bottom: another block, or the newest one growing
    // (a streamed reply, one more step in a tool group).
    // Only the newest content: older pages arriving at the top must not move
    // the view (counting all blocks made each such page re-jump to the bottom).
    val latestSignature = historyBlocks.lastOrNull()?.key to displayMessages.lastOrNull()?.let { it.id to it.text.length }
    LaunchedEffect(latestSignature) {
        if (
            historyBlocks.isNotEmpty() &&
            followLatest &&
            !messageListState.isScrollInProgress
        ) {
            // Route through the single cancellable job so rapid live updates
            // cannot stack competing scroll operations.
            requestJumpToLatest(smooth = false)
        }
    }
    LaunchedEffect(messageListState, thread.id) {
        snapshotFlow {
            Triple(
                messageListState.firstVisibleItemIndex,
                messageListState.firstVisibleItemScrollOffset,
                messageListState.isScrollInProgress,
            )
        }.distinctUntilChanged().collect { (index, offset, scrolling) ->
            if (automaticScroll) return@collect
            // Scrolled up by hand: stay put. Back at the bottom by hand: follow again.
            if (isAtLatestContent(index, offset)) { if (!scrolling) followLatest = true }
            else if (scrolling) followLatest = false
        }
    }
    // Older history arrives ahead of the reader: scrolling up to within a few
    // items of the oldest one loaded fetches the next page, so it is there by
    // the time it is reached. Pages go on at the top, out of view, and the
    // list keeps its place, so what is on screen does not move.
    LaunchedEffect(thread.id, historyState.hasMore, historyState.error, historyState.loading, historyState.loadedPages) {
        snapshotFlow {
            val info = messageListState.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            val nearOldest = info.totalItemsCount > 0 && lastVisible >= info.totalItemsCount - HISTORY_PREFETCH_DISTANCE
            val pagingVisible = info.visibleItemsInfo.any { it.key == HISTORY_PAGING_KEY }
            nearOldest to pagingVisible
        }.distinctUntilChanged().collect { (nearOldest, pagingVisible) ->
            if (historyState.loading) return@collect
            if ((nearOldest && historyState.hasMore) || (pagingVisible && historyState.error != null)) vm.older(thread.id)
        }
    }
    // Older history loads only when scrolled up to it (the effect above); a
    // conversation opened at the bottom keeps just its newest page, instead of
    // fetching page after page in the background and redrawing each time.
    val attachment = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let {
            runCatching {
                context.contentResolver.takePersistableUriPermission(it, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            vm.upload(it, thread.id)
        }
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(6)) { uris ->
        if (uris.isNotEmpty()) vm.uploadImages(uris, thread.id)
    }
    LaunchedEffect(thread.id) {
        text = vm.loadDraft(thread.id)
        draftLoaded = true
    }
    LaunchedEffect(thread.id, connection) {
        if (connection == ConnectionState.Online && backendHasThreadSettings(thread.backend)) vm.loadSettings(thread.id)
    }
    val mobileRunning = isMobileRunningStatus(executionStatus); val turnBusy = isTurnBusyStatus(executionStatus)
    val agentAccountStates by vm.agentAccounts.collectAsState()
    val accountSwitching = thread.backend == "claude" && agentAccountStates["claude"]?.switching == true
    val taskExecuting = isRunningStatus(executionStatus) || mobileRunning
    val hasUploadingAttachment = threadAttachments.any { it.state == "uploading" }
    val uploadedAttachments = threadAttachments.filter { it.state == "uploaded" }
    val submitInstruction: (Boolean) -> Boolean = { sendNow ->
        if (hermesImageCannotSteer(thread.backend, turnBusy, sendNow, uploadedAttachments)) {
            android.widget.Toast.makeText(context, "Hermes 运行中请使用排队发送图片", android.widget.Toast.LENGTH_LONG).show()
            false
        } else when {
            !turnBusy -> vm.send(thread.id, thread.title, text, uploadedAttachments)
            sendNow -> vm.steer(thread.id, thread.title, text, uploadedAttachments)
            else -> vm.queue(thread.id, thread.title, text, uploadedAttachments)
        }
    }
    Scaffold(Modifier.sharedThreadCard(thread.id), containerColor = Paper, topBar = {
        Column(Modifier.fillMaxWidth().background(if (ChatLayout) Paper else SurfaceBase).statusBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!CodexLayout) IconButton(back, Modifier.size(48.dp)) {
                    if (ChatLayout) Icon(Icons.AutoMirrored.Filled.ArrowBackIos, "返回", Modifier.size(20.dp), tint = Ink)
                    else Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                }
                // WeChat's title bar is the name alone, centered. The line with
                // the connection and the model stays folded until the title is
                // tapped; a small light after the title tells the state meanwhile.
                if (CodexLayout) {
                    Spacer(Modifier.width(10.dp))
                    Icon(Icons.Outlined.Folder, null, Modifier.size(19.dp), tint = Ink)
                    Spacer(Modifier.width(10.dp))
                } else if (!ChatLayout) { AgentLogo(thread.backend, 24.dp); Spacer(Modifier.width(8.dp)) }
                Box(
                    Modifier.weight(1f).then(
                        if (ChatLayout || CodexLayout) Modifier.clickable(interactionSource = null, indication = null) { haptics.tick(); headerDetails = !headerDetails }
                            .semantics { contentDescription = if (headerDetails) "收起连接和模型" else "显示连接和模型" }
                        else Modifier
                    ),
                    contentAlignment = if (ChatLayout) Alignment.Center else Alignment.CenterStart,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            thread.title,
                            Modifier.weight(1f, fill = false).sharedThreadTitle(thread.id),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = if (ChatLayout) MaterialTheme.typography.titleMedium.copy(fontSize = 17.sp) else MaterialTheme.typography.titleMedium,
                            fontWeight = if (ChatLayout || CodexLayout) FontWeight.Medium else FontWeight.SemiBold,
                            color = Ink,
                        )
                        if (ChatLayout || CodexLayout) { Spacer(Modifier.width(6.dp)); HeaderLight(connection, taskStatus) }
                    }
                }
                if (activeMode == "yolo" || activeMode == "bypassPermissions") {
                    Spacer(Modifier.width(6.dp))
                    Text(if (thread.backend == "claude") "Bypass" else "完全访问", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = Danger)
                }
                val collaborationLabel = when (currentSettings.modeSyncState) {
                    "pending" -> if (currentSettings.desiredCollaborationMode == "plan") "计划待同步" else "执行待同步"
                    "failed" -> "模式同步失败"
                    else -> if (currentSettings.effectiveCollaborationMode == "plan") "计划" else null
                }
                if (collaborationLabel != null) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        collaborationLabel,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                        color = when (currentSettings.modeSyncState) { "pending" -> Warm; "failed" -> Danger; else -> Accent },
                    )
                }
                Box {
                    IconButton({ more = true }, Modifier.size(48.dp)) { Icon(if (ChatLayout || CodexLayout) Icons.Default.MoreHoriz else Icons.Default.MoreVert, "更多", tint = Ink) }
                    DropdownMenu(more, { more = false }) {
                    DropdownMenuItem({ Text("Token 用量") }, { showTokenUsage = true; more = false }, leadingIcon = { Icon(Icons.Default.BarChart, null) })
                    if (thread.backend == "antigravity") {
                        DropdownMenuItem({ Text("重新同步对话") }, { vm.open(thread.id); more = false }, leadingIcon = { Icon(Icons.Default.Refresh, null) })
                    }
                    // Claude Code and Antigravity expose none of Codex's context/fork/rollback ops.
                    if (thread.backend == "codex") {
                        DropdownMenuItem({ Text("整理上下文") }, { vm.compact(thread.id); more = false }, leadingIcon = { Icon(Icons.Default.Compress, null) })
                        DropdownMenuItem({ Text("分叉任务") }, { vm.fork(thread.id); more = false }, leadingIcon = { Icon(Icons.Default.CallSplit, null) })
                        DropdownMenuItem({ Text("回滚一轮") }, { vm.rollback(thread.id); more = false }, leadingIcon = { Icon(Icons.Default.Refresh, null) })
                    }
                    if (thread.backend != "antigravity") {
                    DropdownMenuItem({ Text("重命名") }, { rename = true; more = false }, leadingIcon = { Icon(Icons.Default.Edit, null) })
                    DropdownMenuItem({ Text(if (thread.archived) "取消归档" else "归档") }, {
                        val archiving = !thread.archived
                        vm.archive(thread.id, archiving, thread.title); more = false
                        // The computer confirms (or says why not) a moment later; go back to the list meanwhile.
                        if (archiving) { vm.showMessage("正在归档「${thread.title.take(20)}」…"); back() }
                    }, leadingIcon = { Icon(Icons.Default.Archive, null) })
                    }
                    }
                }
            }
            // Felt, not only seen: a turn ends, fails, or the computer needs you.
            var lastStatus by remember(thread.id) { mutableStateOf(taskStatus) }
            LaunchedEffect(taskStatus) {
                val before = lastStatus; lastStatus = taskStatus
                if (before == taskStatus) return@LaunchedEffect
                when {
                    isWaitingStatus(taskStatus) && !isWaitingStatus(before) -> haptics.attention()
                    isRunningStatus(before) && (taskStatus.contains("fail", true) || taskStatus.contains("error", true)) -> haptics.reject()
                    isRunningStatus(before) && isCompletedThreadStatus(taskStatus) -> haptics.confirm()
                }
            }
            AnimatedVisibility(
                visible = !(ChatLayout || CodexLayout) || headerDetails,
                enter = expandVertically(KhMotion.sizeSpring, expandFrom = Alignment.Top) + fadeIn(tween(160)),
                exit = shrinkVertically(tween(180), shrinkTowards = Alignment.Top) + fadeOut(tween(120)),
            ) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 34.dp).clickable(enabled = thread.backend != "antigravity") {
                    settings = true
                    // Pi's dialog loads its own model catalog from PI WEB.
                    if (thread.backend == "codex") vm.capabilities()
                    if (backendHasThreadSettings(thread.backend)) vm.loadSettings(thread.id)
                }.padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ConnectionBadge(connection, connectionStatus)
                Spacer(Modifier.width(10.dp))
                Text(
                    when (thread.backend) {
                        "claude" -> claudeSettingsSummary(currentSettings, claudeModels)
                        "pi" -> "Pi · " + shortModelName(thread.model.substringAfter('/')).ifBlank { "默认模型" }
                        "antigravity" -> "反重力 · " + shortModelName(thread.model).ifBlank { "电脑上的模型设置" }
                        "dsh" -> "DeepSeek · " + shortModelName(thread.model.substringAfter('/')).ifBlank { "电脑上的模型设置" }
                        "hermes" -> "Hermes · " + hermesModelLabel(currentSettings.model ?: thread.model)
                        else -> taskSettingsSummary(currentSettings, caps)
                    },
                    Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (ChatLayout) Muted else Accent,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = if (ChatLayout) FontWeight.Normal else FontWeight.SemiBold,
                )
                if (thread.backend == "dsh") {
                    TextButton(
                        onClick = { dshAnswerOpen = true; vm.loadDshPending(thread.id) },
                        contentPadding = PaddingValues(horizontal = 6.dp),
                        modifier = Modifier.height(30.dp),
                    ) { Text("回答", color = if (ChatLayout) Muted else Accent, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold) }
                }
                // Sent, not yet answered by the computer: say so until the result dialog.
                if (switching) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = Accent)
                    Spacer(Modifier.width(6.dp))
                    Text("切换中…", color = Accent, style = MaterialTheme.typography.labelMedium, maxLines = 1)
                    Spacer(Modifier.width(4.dp))
                }
                if (thread.backend != "antigravity") Icon(Icons.Default.ExpandMore, "设置模型、强度和速度", Modifier.size(20.dp), tint = if (ChatLayout) Muted else Accent)
                AnimatedVisibility(
                    visible = showTaskStatusInToolbar(taskStatus),
                    enter = fadeIn(tween(160)) + scaleIn(KhMotion.pop(), initialScale = 0.7f),
                    exit = fadeOut(tween(140)),
                ) {
                    Row { Spacer(Modifier.width(10.dp)); StatusBadge(taskStatus) }
                }
                val shownDurationMs = (if (thread.backend == "claude" || thread.backend == "pi") lastTurnDurationFromHistory(displayMessages) else null) ?: turnDuration?.durationMs ?: 0L
                if (!taskExecuting && shownDurationMs > 0L) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "本轮 ${formatTurnDuration(shownDurationMs)}",
                        color = Muted,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                    )
                }
            }
            }
            // Cached messages are already usable. Keep the background latest
            // page refresh invisible instead of making the header look like a
            // blocking reload every time the user re-enters a task.
            // No banner while opening: the empty conversation already shows one loading state.
            // Kept up while the prompt is known, so a brief status flicker cannot drop
            // the answer being typed.
            UploadIssueBar(vm)
            // Drops in from the top when the computer starts waiting for you.
            pendingCodexQuestion?.let { pending ->
                Surface(color = P.waitingChip, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.NotificationsActive, null, Modifier.size(20.dp), tint = Warm)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text("等待你回答${if (pending.questions.size > 1) " · ${pending.questions.size} 个问题" else ""}", style = MaterialTheme.typography.labelMedium, color = Ink)
                            Text(pending.questions.first().question, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = Muted)
                        }
                        TextButton({ vm.openCodexQuestion(thread.id) }) { Text("回答") }
                    }
                }
            }
            AnimatedVisibility(
                // A DSH approval answered here folds away at once (promptAnswered).
                visible = (isDesktopApprovalStatus(taskStatus) && !(thread.backend == "dsh" && thread.waiting?.kind == "permission" && promptAnswered))
                    || (((thread.backend == "claude" && isWaitingThreadStatus(taskStatus)) || thread.waiting != null) && !promptAnswered),
                enter = expandVertically(KhMotion.sizeSpring, expandFrom = Alignment.Top) + fadeIn(tween(180)) + slideInVertically(KhMotion.offsetSpring) { -it / 3 },
                exit = shrinkVertically(tween(200), shrinkTowards = Alignment.Top) + fadeOut(tween(150)),
            ) {
                // A DSH approval comes with its tool and reason, and the phone can
                // click 允许一次 / 拒绝 on the desktop card; other approvals
                // (Codex Desktop) can only be handled on the computer.
                val phoneApproval = thread.waiting?.takeIf { thread.backend == "dsh" && it.kind == "permission" }
                DesktopWaitingBanner(
                    if (isDesktopApprovalStatus(taskStatus)) (if (phoneApproval != null) "DeepSeek 正在等待批准" else "电脑端正在等待批准，请在电脑上处理。") else thread.note,
                    if (isDesktopApprovalStatus(taskStatus)) phoneApproval else thread.waiting, thread.id in answering,
                    // Codex Desktop has no link to open one task; the banner says to answer there.
                    open = if (thread.backend == "claude") ({ vm.openOnDesktop(thread.id) }) else null,
                    readOptions = if (thread.backend == "claude" && taskStatus.equals("desktop_waiting", true)) ({ vm.readDesktopPrompt(thread.id) }) else null,
                    answer = { choice, answers, feedback ->
                        // A DSH question (uq:<call>) is answered through DSH's own API with
                        // every page's answer; clicking the desktop card took only the
                        // first option and failed on cards with several questions.
                        val waiting = thread.waiting
                        if (thread.backend == "dsh" && (waiting == null || !waiting.requestId.startsWith("uq:") || answers.isNullOrEmpty())) vm.answerDshQuestion(thread.id, choice, answers, waiting?.requestId)
                        else waiting?.let { vm.answerOnDesktop(thread.id, it.requestId, choice, answers, feedback) }
                    },
                )
            }
            HorizontalDivider(color = Divider.copy(alpha = 0.5f))
        }
    }, bottomBar = {
        Column(Modifier.fillMaxWidth().background(if (ChatLayout) P.surfaceAlt else SurfaceBase).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
            HorizontalDivider(color = Divider.copy(alpha = 0.5f))
            Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 5.dp)) {
            // Hermes commands run by its gateway: a plain one is sent at once,
            // one that takes words asks for them first.
            if (thread.backend == "hermes" && text.isBlank()) HermesCommandChips { command ->
                vm.send(thread.id, thread.title, command, emptyList())
                requestJumpToLatest()
            }
            if (threadAttachments.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    threadAttachments.forEach { item ->
                        AttachmentChip(
                            item = item,
                            remove = { vm.removeAttachment(thread.id, item.id) },
                            open = { previewAttachment = item },
                        )
                    }
                }
            }
            queued.firstOrNull()?.let { first ->
                Surface(
                    Modifier.fillMaxWidth().padding(bottom = 6.dp),
                    color = P.surfaceHigh,
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, Divider.copy(alpha = 0.6f)),
                ) {
                    Column {
                        Row(
                            Modifier.fillMaxWidth().clickable { queuedExpanded = !queuedExpanded }
                                .padding(start = 12.dp, top = 6.dp, bottom = 6.dp, end = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Default.ScheduleSend, null, Modifier.size(16.dp), tint = Accent)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                when {
                                    first.state == "uncertain" -> "需确认"
                                    first.state == "failed" -> "失败"
                                    first.origin == "desktop" -> "电脑待发"
                                    first.state == "desktop_queued" -> "待发送"
                                    else -> "待发送"
                                } + if (queued.size > 1) " · ${queued.size}条" else "",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = if (first.state == "uncertain") Danger else Accent,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                queuedInstructionDisplay(first),
                                Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodySmall,
                                color = Ink,
                            )
                            IconButton(
                                onClick = { copyQueuedText(context, displayUploadReferences(first.text).ifBlank { queuedInstructionDisplay(first) }) },
                                modifier = Modifier.size(36.dp).semantics { contentDescription = "复制待发送内容" },
                            ) { Icon(Icons.Default.ContentCopy, "复制", Modifier.size(16.dp), tint = Muted) }
                            if (steerableQueued.isNotEmpty()) TextButton({
                                if (steerableQueued.size > 1) vm.steerQueuedAll(thread.id, steerableQueued.map { it.id })
                                else vm.steerQueued(thread.id, steerableQueued.first().id)
                            }, Modifier.height(36.dp).semantics { contentDescription = if (steerableQueued.size > 1) "全部引导" else "立即引导" }) {
                                Icon(Icons.Default.AltRoute, null, Modifier.size(16.dp)); Spacer(Modifier.width(3.dp)); Text(if (steerableQueued.size > 1) "全部引导" else "引导", style = MaterialTheme.typography.labelSmall)
                            }
                            Icon(if (queuedExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (queuedExpanded) "收起待发送" else "展开待发送", Modifier.size(20.dp), tint = Muted)
                            if (first.origin != "desktop" || first.state in setOf("failed", "uncertain")) IconButton({ vm.removeQueued(thread.id, first.id) }, Modifier.size(36.dp)) { Icon(Icons.Default.Close, if (first.state in setOf("failed", "uncertain")) "关闭发送提示" else "取消待发送", Modifier.size(16.dp), tint = Muted) }
                        }
                        if (queuedExpanded) Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState())) {
                          queued.forEachIndexed { index, instruction ->
                            Column {
                            HorizontalDivider(color = Divider.copy(alpha = 0.5f))
                            Row(Modifier.fillMaxWidth().padding(start = 32.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("${index + 1}", Modifier.width(20.dp), color = Muted, style = MaterialTheme.typography.labelSmall)
                                Text(queuedInstructionDisplay(instruction), Modifier.weight(1f), maxLines = Int.MAX_VALUE, overflow = TextOverflow.Clip, style = MaterialTheme.typography.bodySmall, color = Ink)
                                IconButton(
                                    onClick = { copyQueuedText(context, displayUploadReferences(instruction.text).ifBlank { queuedInstructionDisplay(instruction) }) },
                                    modifier = Modifier.size(36.dp).semantics { contentDescription = "复制待发送 ${index + 1}" },
                                ) { Icon(Icons.Default.ContentCopy, "复制", Modifier.size(16.dp), tint = Muted) }
                                if (canSteerQueuedInstruction(thread.backend, instruction.state, instruction.origin, turnBusy)) TextButton({ vm.steerQueued(thread.id, instruction.id) }, Modifier.height(36.dp).semantics { contentDescription = "立即引导 ${index + 1}" }) {
                                    Icon(Icons.Default.AltRoute, null, Modifier.size(16.dp)); Spacer(Modifier.width(3.dp)); Text("引导", style = MaterialTheme.typography.labelSmall)
                                }
                                if (instruction.origin != "desktop" || instruction.state in setOf("failed", "uncertain")) IconButton({ vm.removeQueued(thread.id, instruction.id) }, Modifier.size(36.dp)) { Icon(Icons.Default.Close, if (instruction.state in setOf("failed", "uncertain")) "关闭发送提示 ${index + 1}" else "取消待发送 ${index + 1}", Modifier.size(16.dp), tint = Muted) }
                            }
                            visibleQueuedInstructionReason(instruction.state, instruction.reason)?.let { reason ->
                                Text(reason, Modifier.fillMaxWidth().padding(start = 32.dp, end = 8.dp, bottom = 6.dp),
                                    color = if (instruction.state in setOf("uncertain", "failed")) Danger else Muted,
                                    style = MaterialTheme.typography.bodySmall)
                            }
                            }
                          }
                        }
                        val queueNotice = if (!queuedExpanded) queued.firstNotNullOfOrNull {
                            visibleQueuedInstructionReason(it.state, it.reason)?.let { reason -> it.state to reason }
                        } else null
                        if (queueNotice != null) {
                            Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(queueNotice.second, Modifier.weight(1f),
                                    color = if (queueNotice.first in setOf("uncertain", "failed")) Danger else Muted,
                                    style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
            val canSend = (text.isNotBlank() || uploadedAttachments.isNotEmpty()) && !hasUploadingAttachment && !accountSwitching
            if (accountSwitching) Text("电脑正在切换 Claude 账号，草稿已保留", color = Muted, style = MaterialTheme.typography.labelMedium)
            // Running and something to send: choose how it goes.
            AnimatedVisibility(
                visible = thread.backend != "antigravity" && turnBusy && canSend,
                enter = expandVertically(KhMotion.sizeSpring) + fadeIn(tween(160)),
                exit = shrinkVertically(tween(160)) + fadeOut(tween(120)),
            ) {
                SendModeToggle(steerMode, Modifier.padding(start = 44.dp, top = 2.dp)) { haptics.tick(); steerMode = it }
            }
            if (CodexLayout) {
                val sendNow = turnBusy && steerMode
                val modelLabel = when (thread.backend) {
                    "claude" -> claudeSettingsSummary(currentSettings, claudeModels)
                    "pi" -> shortModelName(thread.model.substringAfter('/')).ifBlank { "默认模型" }
                    "antigravity" -> shortModelName(thread.model).ifBlank { "电脑上的模型" }
                    "dsh" -> shortModelName(thread.model.substringAfter('/')).ifBlank { "电脑上的模型" }
                    "hermes" -> hermesModelLabel(currentSettings.model ?: thread.model)
                    else -> taskSettingsSummary(currentSettings, caps).split(" · ").take(2).joinToString(" · ")
                }
                CodexComposer(
                    text = text,
                    onTextChange = { value -> text = value; if (draftLoaded) vm.saveDraft(thread.id, value) },
                    hint = if (activeNextSteps.isNotEmpty() && !turnBusy) "输入你的反馈…" else "和 ${LocalAgentName.current} 一起工作",
                    model = modelLabel,
                    modelEnabled = thread.backend != "antigravity",
                    openModel = {
                        settings = true
                        if (thread.backend == "codex") vm.capabilities()
                        if (backendHasThreadSettings(thread.backend)) vm.loadSettings(thread.id)
                    },
                    attachmentEnabled = !hasUploadingAttachment,
                    canAttach = thread.backend != "antigravity",
                    chooseImage = { imagePicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    chooseFile = { attachment.launch(arrayOf("*/*")) },
                    busy = turnBusy,
                    queue = turnBusy && !sendNow,
                    canSend = canSend,
                    stop = { haptics.tick(); vm.stop(thread.id) },
                    send = {
                        val accepted = submitInstruction(sendNow)
                        if (accepted) {
                            vm.clearAttachments(thread.id); vm.clearDraft(thread.id); text = ""; requestJumpToLatest()
                        }
                    },
                )
            } else Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.Bottom) {
                // One compact "+" for pictures and files, leaving the width to the text.
                // The chat layout puts it at the end, where a chat app has it.
                var attachMenu by remember { mutableStateOf(false) }
                val attachButton: @Composable () -> Unit = { Box {
                    IconButton({ attachMenu = true }, enabled = !hasUploadingAttachment, modifier = Modifier.size(40.dp)) {
                        if (ChatLayout) Icon(Icons.Outlined.AddCircleOutline, "添加图片或文件", Modifier.size(28.dp), tint = Ink)
                        else Icon(Icons.Default.Add, "添加图片或文件", tint = Accent)
                    }
                    DropdownMenu(attachMenu, { attachMenu = false }) {
                      if (thread.backend == "antigravity") {
                        DropdownMenuItem({ Text("图片与文件请在电脑端操作") }, {}, enabled = false)
                      } else {
                        DropdownMenuItem(
                            { Text("图片") },
                            { attachMenu = false; imagePicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                            leadingIcon = { Icon(Icons.Outlined.Image, null, tint = Accent) },
                        )
                        DropdownMenuItem(
                            { Text("文件") },
                            { attachMenu = false; attachment.launch(arrayOf("*/*")) },
                            leadingIcon = { Icon(Icons.Default.AttachFile, null, tint = Accent) },
                        )
                      }
                    }
                } }
                if (!ChatLayout) { attachButton(); Spacer(Modifier.width(2.dp)) }
                // WeChat's input is a low white box, about 40 dp. The Material
                // field cannot go below 56 dp, so the chat layout draws its own.
                if (ChatLayout) androidx.compose.foundation.text.BasicTextField(
                    value = text,
                    onValueChange = {
                        text = it
                        if (draftLoaded) vm.saveDraft(thread.id, it)
                    },
                    modifier = Modifier.weight(1f).semantics { contentDescription = "输入消息" },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = Ink, lineHeight = 22.sp),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                    minLines = 1,
                    maxLines = 4,
                    decorationBox = { field ->
                        Box(
                            Modifier.fillMaxWidth().heightIn(min = 40.dp).background(Color.White, RoundedCornerShape(4.dp)).padding(horizontal = 10.dp, vertical = 9.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) { field() }
                    },
                ) else OutlinedTextField(
                    value = text,
                    onValueChange = {
                        text = it
                        if (draftLoaded) vm.saveDraft(thread.id, it)
                    },
                    modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                    shape = RoundedCornerShape(if (ChatLayout) 4.dp else 20.dp),
                    placeholder = { if (!ChatLayout) Text(if (activeNextSteps.isNotEmpty() && !turnBusy) "直接输入你的反馈…" else if (turnBusy) "输入下一条指令…" else "输入消息…", color = Muted.copy(alpha = 0.7f), style = MaterialTheme.typography.bodyMedium) },
                    minLines = 1,
                    maxLines = 4,
                    colors = if (ChatLayout) OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = Color.White, unfocusedContainerColor = Color.White,
                        focusedBorderColor = Color.Transparent, unfocusedBorderColor = Color.Transparent, cursorColor = Accent,
                    ) else OutlinedTextFieldDefaults.colors(),
                )
                Spacer(Modifier.width(6.dp))
                // While a turn runs, one send button does what the mode above
                // the input says: queue it for after this turn (default), or
                // hand it to the current turn right away.
                val sendNow = turnBusy && steerMode
                val sendPress = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
                val sendPressed by sendPress.collectIsPressedAsState()
                val sendScale by animateFloatAsState(if (sendPressed) 0.86f else 1f, KhMotion.pop(), label = "send-press")
                val sendColor by animateColorAsState(if (turnBusy && !sendNow) Warm else Accent, tween(220), label = "send-color")
                val submit = {
                    if (canSend) {
                        val accepted = submitInstruction(sendNow)
                        if (accepted) {
                            vm.clearAttachments(thread.id)
                            vm.clearDraft(thread.id)
                            text = ""
                            requestJumpToLatest()
                        }
                    }
                }
                // Keep Send at the right edge when a running status arrives.
                // Appending Stop there could turn a tap on Send into Stop.
                AnimatedVisibility(
                    visible = turnBusy,
                    enter = fadeIn(tween(160)) + scaleIn(KhMotion.pop(), initialScale = 0.5f),
                    exit = fadeOut(tween(120)) + scaleOut(tween(160), targetScale = 0.6f),
                ) {
                    Row {
                        OutlinedIconButton(
                            onClick = { haptics.tick(); vm.stop(thread.id) },
                            shape = CircleShape,
                            border = BorderStroke(1.dp, Danger.copy(alpha = 0.6f)),
                            modifier = Modifier.size(36.dp),
                        ) { Icon(Icons.Default.Stop, "停止", Modifier.size(17.dp), tint = Danger) }
                        Spacer(Modifier.width(4.dp))
                    }
                }
                if (ChatLayout) {
                    // Keep attachments available after typing, including while
                    // another turn is running and the send action queues a message.
                    attachButton()
                    if (canSend) Button(
                        onClick = submit,
                        shape = RoundedCornerShape(4.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Color.White),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp),
                        modifier = Modifier.height(36.dp).padding(bottom = 2.dp),
                    ) { Text(if (turnBusy && !sendNow) "排队" else "发送", fontSize = 15.sp) }
                } else FilledIconButton(
                    interactionSource = sendPress,
                    onClick = {
                        if (canSend) {
                            val accepted = submitInstruction(sendNow)
                            if (accepted) {
                                vm.clearAttachments(thread.id)
                                vm.clearDraft(thread.id)
                                text = ""
                                // A new instruction always brings the latest into view.
                                requestJumpToLatest()
                            }
                        }
                    },
                    enabled = canSend,
                    shape = CircleShape,
                    colors = IconButtonDefaults.filledIconButtonColors(
                        containerColor = sendColor,
                        contentColor = Color.White,
                    ),
                    modifier = Modifier.size(42.dp).graphicsLayer { scaleX = sendScale; scaleY = sendScale },
                ) {
                    AnimatedContent(
                        targetState = turnBusy && !sendNow,
                        transitionSpec = { (fadeIn(tween(160)) + scaleIn(KhMotion.pop(), initialScale = 0.6f)) togetherWith fadeOut(tween(100)) },
                        label = "send-icon",
                    ) { queued ->
                        Icon(
                            if (queued) Icons.Default.ScheduleSend else Icons.Default.Send,
                            when { !turnBusy -> "发送"; sendNow -> "立即发送"; else -> "排队" },
                            Modifier.size(19.dp),
                        )
                    }
                }
            }
            }
        }
    }) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            val executingRoom by androidx.compose.animation.core.animateDpAsState(if (taskExecuting) 66.dp else 10.dp, KhMotion.element(), label = "executing-room")
            val railTab = backendTab(thread.backend)
            val railWidth = when (railTab) { "claude" -> 11.dp; "codex" -> 6.dp; else -> 0.dp }
            if (railWidth > 0.dp) QuotaRail(vm, railTab, caps, Modifier.align(Alignment.CenterStart).padding(bottom = executingRoom))
            LazyColumn(
                Modifier.fillMaxSize().padding(start = railWidth),
                state = messageListState,
                reverseLayout = true,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = if (CodexLayout) 12.dp else if (ChatLayout) (if (railWidth > 0.dp) 0.dp else 10.dp) else if (railWidth > 0.dp) 4.dp else 12.dp,
                    top = 10.dp,
                    end = if (CodexLayout) 16.dp else if (ChatLayout) 10.dp else 12.dp,
                    bottom = executingRoom,
                ),
                verticalArrangement = Arrangement.spacedBy(if (CodexLayout) 14.dp else 8.dp),
            ) {
                // In this reversed list the first item sits at the bottom: the line for a compaction now running.
                if (isCompactingThreadStatus(taskStatus)) item(key = "live-compaction") { LiveCompactionNotice() }
                items(historyBlocks.reversed(), key = { it.key }) { block ->
                    Box(Modifier.animateItem(fadeInSpec = null, placementSpec = KhMotion.offsetSpring, fadeOutSpec = tween(120)).riseInIfNew(block.key, seenHistoryKeys).animateContentSize(KhMotion.sizeSpring)) {
                    androidx.compose.runtime.CompositionLocalProvider(LocalChatTimeMarks provides chatMarks) {
                    when (block) {
                        is HistoryBlock.Single -> when (block.item.type) {
                            "contextCompaction" -> CompactionNotice(block.item)
                            "claudeWrapUp" -> ClaudeNextStepCard(block.item, block.item.id in activeNextSteps && !turnBusy, text.isNotBlank()) { action ->
                                text = claudeNextStepDraft(text, action)
                                if (draftLoaded) vm.saveDraft(thread.id, text)
                                requestJumpToLatest()
                            }
                            "sentFiles" -> SentFilesBlock(block.item)
                            "toolImages" -> if (block.item.light) LightDetailsNotice("工具返回的图片留在电脑上", block.item.id in lightFetching) {
                                vm.fetchLightDetails(thread.id, listOf(block.item))
                            } else MessageBlock(block.item, showGeneratedImages = !taskExecuting, turnUsage = turnFooters[block.item.id], tokenUnit = tokenDisplayUnit) { previewHistoryImage = it }
                            "claudeTaskList" -> block.item.taskList?.let { ClaudeTaskListCard(block.item, it, taskExecuting && block.item.id == liveTaskListId) }
                            "codexQuestion" -> CodexQuestionCard(block.item.questions, questionAnswers, pendingAnswers) { question, answer ->
                                vm.answerCodexQuestion(thread, question, answer)
                            }
                            else -> MessageBlock(
                                block.item,
                                showGeneratedImages = !taskExecuting,
                                turnUsage = turnFooters[block.item.id],
                                tokenUnit = tokenDisplayUnit,
                            ) { previewHistoryImage = it }
                        }
                        is HistoryBlock.ActivityGroup -> ActivityGroupBlock(
                            block.items,
                            active = taskExecuting && block.key == latestActivityGroupKey(historyBlocks),
                            showGeneratedImages = !taskExecuting,
                            onImageClick = { previewHistoryImage = it },
                            fetchingDetails = block.items.firstOrNull { it.light }?.id in lightFetching,
                            onFetchDetails = { vm.fetchLightDetails(thread.id, block.items.filter { it.light }) },
                        )
                    }
                    }
                    }
                }
                // Only for older pages above content already shown; a first load has the centre indicator.
                if (historyBlocks.isNotEmpty() || (historyState.threadId == thread.id && historyState.trimmed)) item(key = HISTORY_PAGING_KEY) { HistoryPagingIndicator(historyState) }
            }
            if (taskExecuting || !atLatestContent) {
                LatestContentAnchor(
                    running = taskExecuting && pendingCodexQuestion == null,
                    preview = pendingCodexQuestion?.let { "等待你回答 · ${it.questions.size} 个问题" } ?: latestPreview,
                    onClick = { if (pendingCodexQuestion != null) vm.openCodexQuestion(thread.id) else requestJumpToLatest() },
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp).semantics {
                        contentDescription = if (pendingCodexQuestion != null) "回答 Codex 的问题" else if (taskExecuting) "跳至最新执行内容并跟随" else "跳至最新内容"
                    },
                )
            }
            // Opening a conversation: animate until the first content arrives,
            // then keep a slim bar while newer content is still being pulled.
            val waitingForFirstContent = historyBlocks.isEmpty() &&
                (historyLoading || syncingFromComputer || historyState.threadId != thread.id)
            AnimatedVisibility(
                visible = waitingForFirstContent,
                modifier = Modifier.fillMaxSize(),
                enter = fadeIn(tween(160)),
                exit = fadeOut(tween(220)),
            ) {
                ConversationLoading(
                    when {
                        connection != ConnectionState.Online -> "正在连接电脑…"
                        syncingFromComputer && !historyLoading -> "电脑正在准备对话记录…"
                        else -> "正在加载对话…"
                    },
                )
            }
            AnimatedVisibility(
                // Only a first load (nothing shown yet) or a sync from the computer;
                // loading older pages has its own indicator at the top of the list.
                visible = !waitingForFirstContent && (syncingFromComputer || (historyLoading && historyState.loadedCount == 0)),
                modifier = Modifier.align(Alignment.TopCenter),
                enter = fadeIn(tween(160)),
                exit = fadeOut(tween(300)),
            ) {
                LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = Accent, trackColor = Color.Transparent, strokeCap = StrokeCap.Round)
            }
            // The chat layout has avatars at the right edge: the rail shows only
            // while scrolling (and briefly after), like a chat app's fast scroller.
            val scrolling = messageListState.isScrollInProgress
            var railShown by remember { mutableStateOf(false) }
            LaunchedEffect(scrolling) { if (scrolling) railShown = true else { delay(2000); railShown = false } }
            AnimatedVisibility(
                visible = userMessageAnchors.isNotEmpty() && (if (CodexLayout) railShown else !ChatLayout || railShown),
                modifier = Modifier.align(Alignment.CenterEnd),
                enter = fadeIn(tween(160)),
                exit = fadeOut(tween(400)),
            ) {
                ConversationMessageRail(
                    // At most the newest MESSAGE_RAIL_LIMIT dots, so they stay
                    // far enough apart to tap; older messages are reached by scrolling.
                    anchors = userMessageAnchors.takeLast(MESSAGE_RAIL_LIMIT),
                    activeIndex = activeUserMessageIndex,
                    onSelect = { requestJumpToMessage(it.renderedIndex) },
                    modifier = Modifier.padding(end = 2.dp, top = 12.dp, bottom = 12.dp),
                )
            }
        }
    }
    // A question Codex just asked here; another task's shows as a notification.
    askedNow?.takeIf { it.threadId == thread.id }?.let { prompt ->
        CodexQuestionDialog(prompt, questionAnswers, pendingAnswers, { question, answer -> vm.answerCodexQuestion(thread, question, answer) }, vm::dismissCodexQuestion)
    }
    // Only this conversation's request; another task's shows as a notification.
    // Closed as soon as it is answered; it comes back only if the computer does not confirm.
    approval?.takeIf { (it.threadId == null || it.threadId == thread.id) && !it.submitting }?.let { request ->
        ApprovalDialog(
            request,
            { vm.approve(false, request.rpcId, request.threadId) },
            { vm.approve(true, request.rpcId, request.threadId) },
            { answers -> vm.approve(answers, request.rpcId, request.threadId) },
            { vm.approve(true, request.rpcId, request.threadId, forSession = true) },
        )
    }
    if (settings && thread.backend == "claude") ClaudeSettingsDialog(currentSettings, claudeModels, thread.desktopLive, { settings = false }) { model, effort, permissionMode -> vm.claudeSettings(thread.id, thread.title, model, effort, permissionMode); settings = false }
    else if (settings && thread.backend == "dsh") DshSettingsDialog(currentSettings, dshCatalog, { settings = false }) { model, effort, permission -> vm.dshSettings(thread.id, model, effort, permission); settings = false }
    else if (settings && thread.backend == "hermes") DshSettingsDialog(currentSettings, hermesCatalog, { settings = false }, title = "Hermes 模型与专家会诊", loading = "正在读取 Hermes 模型…") { model, effort, _ -> vm.dshSettings(thread.id, model, effort); settings = false }
    else if (settings && thread.backend == "pi") PiSettingsDialog(vm, thread.id) { settings = false }
    else if (settings) SettingsDialog(caps, currentSettings, { settings = false }) { changes -> vm.settings(thread.id, thread.title, changes); settings = false }
    if (dshAnswerOpen) DshAnswerDialog(dshPending, dshPendingLoading, close = { dshAnswerOpen = false }) { option ->
        dshAnswerOpen = false
        vm.answerDsh(thread.id, option)
    }
    LaunchedEffect(thread.id, thread.backend) { if (thread.backend == "claude") { vm.loadSettings(thread.id); if (claudeModels.isEmpty()) vm.backendCapabilities() } }
    if (rename) RenameDialog(thread.title, { rename = false }) { vm.rename(thread.id, it); rename = false }
    if (showTokenUsage) ConversationUsageDialog(thread.id, usageState[thread.id], thread.id in usageLoading, connection == ConnectionState.Online, tokenDisplayUnit,
        refresh = { vm.loadConversationUsage(thread.id) }, dismiss = { showTokenUsage = false })
    previewAttachment?.let { AttachmentPreviewDialog(it) { previewAttachment = null } }
    previewHistoryImage?.let { HistoryImagePreviewDialog(it) { previewHistoryImage = null } }
    GlobalMessage(vm)
}

private fun copyQueuedText(context: android.content.Context, text: String) {
    val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("khLink 待发送消息", text))
    Toast.makeText(context, "已复制待发送内容", Toast.LENGTH_SHORT).show()
}

@Composable
private fun LatestContentAnchor(
    running: Boolean,
    preview: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    Surface(
        modifier = modifier.clickable(
            interactionSource = interactionSource,
            indication = null,
            onClick = onClick,
        ).animateContentSize(tween(240)),
        color = if (running) P.composerRunning else SurfaceBase.copy(alpha = 0.94f),
        shape = if (running) RoundedCornerShape(23.dp) else CircleShape,
        border = BorderStroke(1.dp, if (running) P.composerRunningBorder else Divider.copy(alpha = 0.7f)),
        shadowElevation = if (running) 0.dp else 1.dp,
    ) {
        AnimatedContent(
            targetState = running,
            transitionSpec = { fadeIn(tween(160)) + scaleIn(tween(180)) togetherWith fadeOut(tween(100)) + scaleOut(tween(120)) },
            label = "latest-content-anchor",
        ) { isRunning ->
            if (isRunning) {
                Row(
                    Modifier
                        .widthIn(min = 144.dp, max = 210.dp)
                        .padding(horizontal = 11.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    RunningScanBand()
                    Text(
                        preview,
                        Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = P.composerRunningInk,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            } else {
                Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.ArrowDownward, "跳至最新内容", tint = Accent, modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

private fun latestExecutionPreview(items: List<HistoryItem>): String {
    // Only what this turn has produced: before its first output, the previous
    // turn's reply is not what is happening now.
    val turn = items.drop(items.indexOfLast { it.type.contains("user", true) } + 1)
    val candidates = turn.filter { it.type !in setOf("userMessage", "queuedInstruction", "claudeTaskList") }
    val item = candidates.lastOrNull { it.text.isNotBlank() } ?: candidates.lastOrNull()
    if (item == null) return "正在思考"
    val prefix = when (item.type) {
        "reasoning" -> "思考"
        "plan" -> "计划"
        "commandExecution" -> "命令"
        "fileChange" -> "变更"
        "imageGeneration" -> "生图"
        "imageView" -> "图片"
        "agentMessage" -> "回复"
        "mcpToolCall", "webSearch", "collabAgentToolCall" -> "操作"
        "workflow" -> "Workflow"
        else -> "处理中"
    }
    val detail = item.text.replace(Regex("\\s+"), " ").trim()
    return if (detail.isBlank()) prefix else "$prefix · ${detail.take(18)}"
}

@Composable
private fun ConversationMessageRail(
    anchors: List<UserMessageAnchor>,
    activeIndex: Int,
    onSelect: (UserMessageAnchor) -> Unit,
    modifier: Modifier = Modifier,
) {
    val railHeight = (anchors.size * 24).coerceIn(64, 360).dp
    var lastDragIndex by remember(anchors) { mutableStateOf(-1) }
    fun selectByPosition(y: Float, height: Float) {
        if (anchors.isEmpty() || height <= 0f) return
        val padding = (height * 0.08f).coerceAtMost(18f)
        val fraction = ((y - padding) / (height - padding * 2f)).coerceIn(0f, 1f)
        val index = (fraction * anchors.lastIndex).roundToInt().coerceIn(0, anchors.lastIndex)
        if (index != lastDragIndex) {
            lastDragIndex = index
            onSelect(anchors[index])
        }
    }
    Surface(
        modifier = modifier
            .width(30.dp)
            .height(railHeight)
            .semantics { contentDescription = "对话用户消息导航，共 ${anchors.size} 条" }
            .pointerInput(anchors) {
                detectDragGestures(
                    onDragStart = { position ->
                        lastDragIndex = -1
                        selectByPosition(position.y, size.height.toFloat())
                    },
                    onDrag = { change, _ ->
                        selectByPosition(change.position.y, size.height.toFloat())
                    },
                    onDragEnd = { lastDragIndex = -1 },
                    onDragCancel = { lastDragIndex = -1 },
                )
            },
        color = SurfaceBase.copy(alpha = 0.9f),
        shape = RoundedCornerShape(15.dp),
        border = BorderStroke(1.dp, Divider.copy(alpha = 0.72f)),
        shadowElevation = 2.dp,
    ) {
        Box(Modifier.fillMaxSize().padding(vertical = 5.dp)) {
            Box(
                Modifier
                    .align(Alignment.Center)
                    .width(1.dp)
                    .fillMaxHeight()
                    .background(Divider.copy(alpha = 0.9f)),
            )
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceEvenly) {
                anchors.forEach { anchor ->
                    val selected = anchor.ordinal == activeIndex
                    val scale by animateFloatAsState(if (selected) 1.65f else 1f, tween(180), label = "message-rail-dot")
                    val color by animateColorAsState(if (selected) Accent else Muted.copy(alpha = 0.56f), tween(180), label = "message-rail-color")
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            .clickable { onSelect(anchor) }
                            .semantics { contentDescription = "跳转到第 ${anchor.ordinal + 1} 条用户消息" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .graphicsLayer { scaleX = scale; scaleY = scale }
                                .background(color, CircleShape),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RunningScanBand() {
    val transition = rememberInfiniteTransition(label = "task-running")
    val offset by transition.animateFloat(
        initialValue = -1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1100), RepeatMode.Restart),
        label = "task-running-scan-offset",
    )
    Box(
        Modifier
            .width(26.dp)
            .height(4.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(P.scrollTrack),
    ) {
        Box(
            Modifier
                .offset(x = (offset * 17f).dp)
                .width(9.dp)
                .fillMaxHeight()
                .background(P.scrollThumb, RoundedCornerShape(4.dp)),
        )
    }
}

// Placeholder conversation that breathes while the first page loads.
@Composable
private fun ConversationLoading(label: String) {
    val transition = rememberInfiniteTransition(label = "conversation-loading")
    val pulse by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 0.85f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "conversation-loading-pulse",
    )
    Column(
        Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        listOf(0.62f to true, 0.86f to false, 0.48f to true, 0.74f to false).forEachIndexed { index, (width, mine) ->
            val alpha = (pulse - index * 0.08f).coerceIn(0.2f, 0.9f)
            Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
                Surface(
                    Modifier.fillMaxWidth(width).height(if (mine) 44.dp else 76.dp).graphicsLayer { this.alpha = alpha },
                    shape = RoundedCornerShape(14.dp),
                    color = if (mine) P.userBubble else SurfaceAlt,
                ) {}
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
            Spacer(Modifier.width(10.dp))
            Text(label, color = Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun HistoryPagingIndicator(state: HistoryLoadState) {
    // Nothing older to load because the relay cleared it: say so, quietly.
    if (!state.loading && state.error == null && state.trimmed && !state.hasMore) {
        Text("更早的记录已清理", Modifier.fillMaxWidth().padding(vertical = 10.dp), color = Muted,
            style = MaterialTheme.typography.labelMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        return
    }
    AnimatedVisibility(
        visible = state.loading || state.error != null,
        enter = fadeIn(tween(180)) + expandVertically(tween(220)),
        exit = fadeOut(tween(120)) + shrinkVertically(tween(160)),
    ) {
        Surface(
            Modifier.fillMaxWidth().padding(vertical = 4.dp).animateContentSize(tween(180)),
            color = P.surfaceHigh,
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(0.5.dp, Divider.copy(alpha = 0.6f)),
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                if (state.loading) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
                    Spacer(Modifier.width(10.dp))
                    Text(if (state.recovering) "正在补齐中间内容…" else "正在同步历史…", Modifier.weight(1f), color = Muted, style = MaterialTheme.typography.bodySmall)
                } else {
                    Icon(Icons.Default.Error, null, Modifier.size(16.dp), tint = Danger)
                    Spacer(Modifier.width(10.dp))
                    Text("继续上拉以重试历史加载", Modifier.weight(1f), color = Danger, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

/** Long-press menu of a task: rename, and pin / unpin, mirrored on the desktop. */
@Composable
private fun ThreadActionDialog(thread: ThreadSummary, close: () -> Unit, rename: () -> Unit, choosePins: (() -> Unit)? = null, changeAvatar: (() -> Unit)? = null,
    archive: (() -> Unit)? = null, multiSelect: (() -> Unit)? = null, togglePin: () -> Unit) {
    AlertDialog(
        onDismissRequest = close,
        title = { Text(thread.title.ifBlank { "未命名任务" }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column {
                // Rename and pin are done on the desktop, which only some agents have.
                val desktopActions = backendTab(thread.backend) in setOf("codex", "claude", "dsh", "hermes")
                if (desktopActions) Text(
                    if (thread.backend == "dsh") "会同步到 DSH 桌面端。" else if (thread.backend == "hermes") "会同步到 Hermes。" else "会同步到电脑端；电脑端窗口会短暂切到前台。",
                    style = MaterialTheme.typography.bodySmall, color = Muted,
                )
                Spacer(Modifier.height(12.dp))
                if (desktopActions) ThreadActionItem(Icons.Default.Edit, "重命名", rename)
                changeAvatar?.let { ThreadActionItem(Icons.Default.Face, "更换头像（只在这台手机上）", it) }
                if (desktopActions && !thread.archived) ThreadActionItem(Icons.Default.PushPin, if (thread.pinned) "取消置顶" else "置顶", togglePin)
                choosePins?.let { ThreadActionItem(Icons.Default.PushPin, "选择要置顶的会话…", it) }
                // Antigravity has no archive on the computer: there it only leaves this phone's list.
                archive?.let { ThreadActionItem(Icons.Default.Archive, if (thread.archived) "取消归档" else if (backendTab(thread.backend) == "antigravity") "归档（只在这台手机上）" else "归档", it) }
                multiSelect?.let { ThreadActionItem(Icons.Default.Checklist, "多选", it) }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(close) { Text("取消") } },
    )
}

@Composable
private fun PinSelectionDialog(threads: List<ThreadSummary>, close: () -> Unit, save: (Set<String>) -> Unit) {
    var selected by remember(threads) { mutableStateOf(threads.filter { it.pinned }.map { it.id }.toSet()) }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("选择要置顶的会话", fontWeight = FontWeight.Bold, color = Ink) },
        text = {
            if (threads.isEmpty()) Text("还没有 DeepSeek Harness 会话", color = Muted)
            else Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
                threads.sortedWith(compareByDescending<ThreadSummary> { it.pinned }.thenByDescending { it.updatedAt }).forEach { thread ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable {
                            selected = if (thread.id in selected) selected - thread.id else selected + thread.id
                        }.padding(horizontal = 4.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = thread.id in selected, onCheckedChange = null)
                        Column(Modifier.weight(1f)) {
                            Text(thread.title.ifBlank { "未命名任务" }, color = Ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(thread.cwd, color = Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton({ save(selected) }, enabled = threads.isNotEmpty()) { Text("保存") } },
        dismissButton = { TextButton(close) { Text("取消", color = Muted) } },
    )
}

@Composable
private fun ThreadActionItem(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = Ink)
        Spacer(Modifier.width(14.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = Ink)
    }
}

@Composable
private fun RenameDialog(current: String, close: () -> Unit, save: (String) -> Unit) {
    var value by remember { mutableStateOf(current) }
    AlertDialog(onDismissRequest = close, title = { Text("重命名任务") }, text = { OutlinedTextField(value, { value = it }, Modifier.fillMaxWidth(), singleLine = true) },
        dismissButton = { TextButton(close) { Text("取消") } }, confirmButton = { Button({ save(value.trim()) }, enabled = value.isNotBlank()) { Text("保存") } })
}

@Composable
internal fun UserAvatar(name: String, avatarUrl: String?, size: Int, shape: androidx.compose.ui.graphics.Shape = CircleShape) {
    val context = LocalContext.current
    val bitmap by produceState<ImageBitmap?>(initialValue = null, avatarUrl) {
        val url = avatarUrl?.takeIf { it.startsWith("https://") } ?: return@produceState
        val cached = withContext(Dispatchers.IO) { avatarCacheFile(context, url) }
        value = withContext(Dispatchers.IO) { decodeAvatarFile(cached) }
        val stale = !cached.exists() || System.currentTimeMillis() - cached.lastModified() > AVATAR_REFRESH_INTERVAL_MS
        if (stale) {
            withContext(Dispatchers.IO) { refreshAvatarCache(url, cached) }
            value = withContext(Dispatchers.IO) { decodeAvatarFile(cached) }
        }
    }
    Surface(Modifier.size(size.dp).clip(shape), shape = shape, color = if (shape == CircleShape) Accent else Color(0xFFC7C7CC)) {
        if (bitmap != null) Image(requireNotNull(bitmap), "账户头像", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Box(contentAlignment = Alignment.Center) { Text(accountInitials(name), color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium) }
    }
}

private const val AVATAR_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000L

private fun avatarCacheFile(context: android.content.Context, url: String): File {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
        .digest(url.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
    return File(context.cacheDir, "avatars/$digest.img")
}

private fun decodeAvatarFile(file: File): ImageBitmap? = runCatching {
    if (!file.isFile) return@runCatching null
    file.inputStream().use { BitmapFactory.decodeStream(it)?.asImageBitmap() }
}.getOrNull()

private fun refreshAvatarCache(url: String, target: File) {
    runCatching {
        target.parentFile?.mkdirs()
        val connection = java.net.URL(url).openConnection().apply {
            connectTimeout = 5_000
            readTimeout = 8_000
            useCaches = true
        }
        val temporary = File(target.parentFile, "${target.name}.tmp")
        connection.getInputStream().use { input -> FileOutputStream(temporary).use { output -> input.copyTo(output) } }
        if (temporary.length() > 0L) {
            if (!temporary.renameTo(target)) {
                target.delete()
                temporary.renameTo(target)
            }
        } else temporary.delete()
    }.onFailure { target.parentFile?.mkdirs() }
}

private fun accountInitials(value: String): String {
    val name = value.trim().ifBlank { "KH" }
    return if (name.all { it.code < 128 }) name.take(2).uppercase() else name.takeLast(2)
}

internal fun membershipStateLabel(value: String): String = when (value) {
    "active" -> "有效"
    "expiring" -> "即将到期"
    "expired" -> "已到期"
    "payment_pending" -> "支付处理中"
    "account_exception" -> "账户异常"
    "unavailable" -> "暂不可用"
    else -> "未开通"
}

internal fun membershipExpiry(value: Long?): String = value?.takeIf { it > 0 }?.let {
    "有效期至 ${SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(Date(it))}"
} ?: "暂无到期信息"

@Composable
private fun AccountDialog(
    account: AccountUiState?, v2: Boolean, close: () -> Unit,
    visibleAgents: Set<String>, agentOrder: List<String>, agentSettings: () -> Unit, devices: () -> Unit,
    fetchedFiles: () -> Unit, update: () -> Unit, password: () -> Unit, markAllRead: () -> Unit,
    logout: () -> Unit, direct: () -> Unit, restoreServer: () -> Unit, piSettings: (() -> Unit)? = null,
    unit: TokenDisplayUnit, unitChanged: (TokenDisplayUnit) -> Unit,
    scrollState: androidx.compose.foundation.ScrollState,
    claudeEnabled: Boolean, claudeNotice: () -> Unit, disableClaude: () -> Unit,
    lightMode: Boolean = false, lightModeChanged: (Boolean) -> Unit = {},
    showPcLoad: Boolean = false, showPcLoadChanged: (Boolean) -> Unit = {},
    claudeStatusline: ClaudeStatuslineState? = null, claudeStatuslineChanged: (Boolean) -> Unit = {},
) {
    var themeOpen by remember { mutableStateOf(false) }
    var legalDocument by rememberSaveable { mutableStateOf<String?>(null) }
    val guideVm: BridgeViewModel = viewModel()
    val autoDownloadUpdates by guideVm.autoDownloadUpdates.collectAsState()
    AppSettingsScreen(account, v2, scrollState, visibleAgents, agentOrder, unit, unitChanged, close,
        agentSettings, devices, fetchedFiles, update, password, markAllRead, logout,
        direct, restoreServer, piSettings, theme = { themeOpen = true }, legal = { legalDocument = "support" },
        replayGuide = { close(); guideVm.restartOnboarding() },
        claudeEnabled = claudeEnabled, claudeNotice = claudeNotice, disableClaude = disableClaude,
        lightMode = lightMode, lightModeChanged = lightModeChanged,
        showPcLoad = showPcLoad, showPcLoadChanged = showPcLoadChanged,
        claudeStatusline = claudeStatusline, claudeStatuslineChanged = claudeStatuslineChanged,
        autoDownloadUpdates = autoDownloadUpdates, autoDownloadUpdatesChanged = guideVm::saveAutoDownloadUpdates)
    if (themeOpen) ThemeDialog { themeOpen = false }
    legalDocument?.let { LegalDocumentDialog(it) { legalDocument = null } }
}

@Composable
internal fun MembershipLine(title: String, state: String, detail: String) {
    val positive = state == "有效" || state == "即将到期"
    val badgeColor = when {
        state == "即将到期" -> Warm
        positive -> Accent
        state == "已到期" || state == "账户异常" -> Danger
        else -> Muted
    }
    Surface(
        Modifier.fillMaxWidth().padding(vertical = 5.dp),
        shape = RoundedCornerShape(14.dp),
        color = SurfaceAlt.copy(alpha = 0.42f),
        border = BorderStroke(0.5.dp, Divider.copy(alpha = 0.65f)),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(32.dp).clip(RoundedCornerShape(10.dp)).background(badgeColor.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (positive) Icons.Default.CheckCircle else Icons.Default.Error,
                    contentDescription = null,
                    tint = badgeColor,
                    modifier = Modifier.size(17.dp),
                )
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.SemiBold, color = Ink)
                Text(detail, color = Muted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(8.dp))
            Surface(shape = RoundedCornerShape(50), color = badgeColor.copy(alpha = 0.12f)) {
                Text(
                    state,
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                    color = badgeColor,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}


@Composable
private fun ThemeDialog(close: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = close,
        title = { Text("主题") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                KhLinkSkinCatalog.all.forEach { skin ->
                    val chosen = skin.id == KhThemeState.current.id
                    Surface(
                        Modifier.fillMaxWidth().clickable { KhThemeState.select(context, skin) },
                        shape = RoundedCornerShape(12.dp),
                        color = if (chosen) P.selected else SurfaceBase,
                        border = BorderStroke(if (chosen) 1.5.dp else 1.dp, if (chosen) Accent else Divider),
                    ) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = chosen, onClick = { KhThemeState.select(context, skin) })
                            Column(Modifier.weight(1f)) {
                                Text(skin.name, fontWeight = FontWeight.SemiBold, color = Ink)
                                Text(skin.description, color = Muted, style = MaterialTheme.typography.bodySmall)
                            }
                            // A few of the theme's own colors as a preview.
                            Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                                listOf(skin.palette.paper, skin.palette.userBubble, skin.palette.accent, skin.palette.runningBorder).forEach {
                                    Box(Modifier.size(14.dp).background(it, CircleShape).border(0.5.dp, skin.palette.divider, CircleShape))
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(close) { Text("完成") } },
    )
}

@Composable
private fun SettingsRow(icon: ImageVector, title: String, subtitle: String, action: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = action)
            .padding(vertical = 10.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = Accent)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold, color = Ink, style = MaterialTheme.typography.bodyMedium)
            Text(subtitle, color = Muted, style = MaterialTheme.typography.bodySmall)
        }
        Icon(Icons.Default.ChevronRight, null, Modifier.size(18.dp), tint = Muted)
    }
}

@Composable
private fun DevicesDialog(vm: BridgeViewModel, agent: String, agents: List<String>, close: () -> Unit) {
    val devices by vm.devices.collectAsState()
    val selectedConnectorId by vm.selectedConnectorId.collectAsState()
    AlertDialog(
        onDismissRequest = close,
        title = { Text("已绑定设备", fontWeight = FontWeight.Bold) },
        text = {
            val selfId = remember { vm.currentDeviceId() }
            // Revoking signs a phone out of the account for good: ask first.
            var revoking by remember { mutableStateOf<DeviceEntry?>(null) }
            revoking?.let { target ->
                AlertDialog(
                    onDismissRequest = { revoking = null },
                    title = { Text("撤销这台手机？") },
                    text = { Text("「${target.name}」会退出 khLink，要再用需要重新扫码绑定。") },
                    dismissButton = { TextButton({ revoking = null }) { Text("取消") } },
                    confirmButton = { TextButton({ vm.revokeDevice(target.id); revoking = null }) { Text("撤销", color = Danger) } },
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                devices.filterNot { it.revoked }.forEach { device ->
                    val type = device.type.lowercase()
                    val isConnector = type == "connector"
                    val isSelected = isConnector && selectedConnectorId == device.id
                    Surface(
                        Modifier.fillMaxWidth().then(if (isConnector) Modifier.clickable { vm.selectConnectorForAgent(agent, device.id, agents) } else Modifier),
                        color = P.surfaceHigh,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, if (isSelected) Accent.copy(alpha = 0.65f) else Divider.copy(alpha = 0.6f)),
                    ) {
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(device.name, fontWeight = FontWeight.SemiBold, color = Ink)
                                Text(
                                    when (type) {
                                        "connector" -> "电脑连接器 · ${device.id.removeSuffix(".connector").takeLast(6)}"
                                        "desktop" -> "桌面客户端 · ${device.id.takeLast(6)}"
                                        "android" -> (if (device.id == selfId) "本机 · " else "") + "Android 手机 · ${device.id.takeLast(6)}"
                                        else -> device.type
                                    },
                                    color = Muted,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            if (isConnector) {
                                Surface(
                                    color = if (isSelected) P.selectedGreen else P.selected,
                                    shape = RoundedCornerShape(12.dp),
                                ) {
                                    Text(
                                        if (isSelected) "当前新对话电脑" else "设为新对话电脑",
                                        color = if (isSelected) P.selectedGreenInk else Accent,
                                        style = MaterialTheme.typography.labelSmall,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                    )
                                }
                            } else if (type == "android" && device.id != selfId) {
                                TextButton({ revoking = device }) {
                                    Text("撤销", color = Danger, style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(close) { Text("关闭") } },
    )
}

@Composable
private fun PasswordDialog(close: () -> Unit, save: (String) -> Unit) {
    var first by remember { mutableStateOf("") }; var second by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = close, title = { Text("更新开发环境访问密钥") }, text = { Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        OutlinedTextField(first, { first = it }, Modifier.fillMaxWidth(), label = { Text("新密码（至少 16 位）") }, visualTransformation = PasswordVisualTransformation())
        OutlinedTextField(second, { second = it }, Modifier.fillMaxWidth(), label = { Text("再次输入") }, visualTransformation = PasswordVisualTransformation())
        Text("主密钥只会重新包装，已有加密历史无需迁移。", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
    } }, dismissButton = { TextButton(close) { Text("取消") } }, confirmButton = { Button({ save(first) }, enabled = first.length >= 16 && first == second) { Text("修改") } })
}

@Composable
private fun GlobalMessage(vm: BridgeViewModel) {
    val message by vm.message.collectAsState(); val error by vm.uiError.collectAsState(); val value = error ?: message
    value?.let { AlertDialog(onDismissRequest = { vm.clearError(); vm.clearMessage() }, text = { Text(it) }, confirmButton = { TextButton({ vm.clearError(); vm.clearMessage() }) { Text("知道了") } }) }
}

@Composable
private fun ClaudeWorkspaceTrustDialog(
    request: ClaudeWorkspaceTrustRequest,
    working: Boolean,
    confirm: () -> Unit,
    cancel: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!working) cancel() },
        title = { Text("Claude 需要确认工作区") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("电脑上的 Claude 请求信任这个目录：", color = Ink)
                Text(request.folder, color = Accent, style = MaterialTheme.typography.bodySmall)
                Text(
                    "信任后，Claude 可能读取并执行该目录中的项目配置、脚本和钩子。只有你确认后，khLink 才会继续发送这次新任务；本次选择不会被记住。",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        },
        dismissButton = { TextButton(onClick = cancel, enabled = !working) { Text("取消") } },
        confirmButton = { Button(onClick = confirm, enabled = !working) { if (working) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("信任并继续") } },
    )
}

@Composable
private fun MessageBlock(
    item: HistoryItem,
    showGeneratedImages: Boolean = true,
    turnUsage: CompletedTurnTokenUsage? = null,
    tokenUnit: TokenDisplayUnit = TokenDisplayUnit.TenThousands,
    onImageClick: (HistoryImage) -> Unit,
) {
    if (item.type == "toolImages") { Box(Modifier.padding(start = if (ChatLayout) ChatIndent else 0.dp)) { ToolImagesCard(item, onImageClick) }; return }
    val user = item.type.contains("user", true)
    // Claude threads show thinking inline (as the desktop does), not folded.
    val inlineThinking = item.type == "reasoning" && LocalAgentName.current == "Claude"
    val collapsible = (item.type == "reasoning" && !inlineThinking) || isActivityItem(item)
    if (FlatLayout && !collapsible) {
        CodexMessage(item, user, inlineThinking, showGeneratedImages, turnUsage, tokenUnit, onImageClick)
        return
    }
    if (ChatLayout && !collapsible && !inlineThinking) { ChatBubble(item, user, showGeneratedImages, turnUsage, tokenUnit, onImageClick); return }
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    val label = itemLabel(item, LocalAgentName.current)
    val panelColor = when {
        user -> P.userBubble
        inlineThinking -> P.thinking
        collapsible -> P.collapsible
        else -> SurfaceBase
    }
    val contentColor = if (user) Ink else Ink
    val borderColor = if (user) P.userBorder else Divider.copy(alpha = 0.6f)

    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = if (ChatLayout) ChatIndent else 2.dp, end = 2.dp, top = 3.dp, bottom = 3.dp),
        horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(if (user) 0.86f else 0.94f),
            color = panelColor,
            shape = if (user) {
                RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomEnd = 4.dp, bottomStart = 16.dp)
            } else {
                RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomEnd = 16.dp, bottomStart = 16.dp)
            },
            border = BorderStroke(1.dp, borderColor),
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = if (collapsible) 7.dp else 8.dp)) {
                if (!user) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .then(if (collapsible) Modifier.clickable { expanded = !expanded } else Modifier)
                            .padding(vertical = if (collapsible) 4.dp else 0.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (collapsible) Icon(if (expanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight, if (expanded) "收起" else "展开", Modifier.size(18.dp), tint = Muted)
                        if (collapsible || inlineThinking) Icon(itemIcon(item), null, Modifier.padding(start = if (inlineThinking) 0.dp else 4.dp).size(16.dp), tint = if (inlineThinking) Muted else itemAccent(item))
                        if (collapsible || inlineThinking) Spacer(Modifier.width(6.dp))
                        if (!collapsible && !inlineThinking) {
                            AgentLogo(LocalAgentBackend.current, 18.dp)
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(
                            label,
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.labelMedium,
                            color = if (inlineThinking) Muted else if (collapsible) itemAccent(item) else Accent,
                        )
                        Spacer(Modifier.weight(1f))
                        item.status?.let { Text(itemStatusLabel(it), style = MaterialTheme.typography.labelSmall, color = statusColor(it), maxLines = 1) }
                    }
                }
                if (!collapsible || expanded) {
                    if (!user) Spacer(Modifier.height(6.dp))
                    SelectionContainer {
                        if (inlineThinking) {
                            Text(
                                item.text,
                                color = Muted,
                                style = MaterialTheme.typography.bodySmall,
                                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                                lineHeight = 19.sp,
                            )
                        } else if (isActivityItem(item)) {
                            Surface(
                                color = P.codeBlock,
                                shape = RoundedCornerShape(8.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    item.text.ifBlank { "（无可见内容）" },
                                    Modifier.padding(8.dp),
                                    fontFamily = FontFamily.Monospace,
                                    style = MaterialTheme.typography.bodySmall,
                                    lineHeight = MaterialTheme.typography.bodySmall.lineHeight,
                                    color = Ink,
                                )
                            }
                        } else if (user) {
                            Text(
                                item.text,
                                color = contentColor,
                                style = MaterialTheme.typography.bodyMedium,
                                lineHeight = 20.sp,
                            )
                        } else {
                            KhLinkMarkdown(item.text.ifBlank { "（无可见内容）" }, modifier = Modifier.fillMaxWidth())
                        }
                    }
                    if (item.images.isNotEmpty()) HistoryImageStrip(item.images, onImageClick)
                    if (showGeneratedImages && item.generatedImages.isNotEmpty()) {
                        GeneratedImageSection(item.generatedImages, onImageClick)
                    }
                    if (item.truncated) Text("内容较长，已保留摘要与首尾片段", color = Warm, style = MaterialTheme.typography.labelSmall)
                } else {
                    Text(itemPreview(item), maxLines = 2, overflow = TextOverflow.Ellipsis, color = Muted, style = MaterialTheme.typography.bodySmall)
                }
                historyItemTimestamp(item)?.let { timestamp ->
                    Row(
                        Modifier.fillMaxWidth().padding(top = 4.dp),
                        horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
                    ) {
                        if (user && item.status in setOf("sending", "waiting", "sent", "steered")) {
                            Text(
                                itemStatusLabel(item.status!!),
                                color = if (isOutboundInFlight(item.status)) Muted else statusColor(item.status!!),
                                style = MaterialTheme.typography.labelSmall,
                            )
                            Spacer(Modifier.width(6.dp))
                        }
                        if (user && item.text.isNotBlank()) { CopyMessageButton(item.text); Spacer(Modifier.width(4.dp)) }
                        if (user) Text(formatMessageTime(timestamp), color = Muted, style = MaterialTheme.typography.labelSmall)
                        else MessageTimeAndUsage(timestamp, turnUsage, tokenUnit, Modifier.weight(1f, fill = false))
                    }
                }
                // On its way: a thin bar under the text until the computer has it.
                if (user) OutboundProgress(isOutboundInFlight(item.status), Modifier.padding(top = 6.dp).fillMaxWidth())
            }
        }
    }
}

/** Codex-like conversation: blue outgoing bubbles and unboxed, selectable replies. */
@Composable
private fun CodexMessage(
    item: HistoryItem,
    user: Boolean,
    inlineThinking: Boolean,
    showGeneratedImages: Boolean,
    turnUsage: CompletedTurnTokenUsage?,
    tokenUnit: TokenDisplayUnit,
    onImageClick: (HistoryImage) -> Unit,
) {
    if (user) {
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
            val bubbleWidth = maxWidth * 0.87f
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Column(Modifier.widthIn(max = bubbleWidth), horizontalAlignment = Alignment.End) {
                    Surface(color = P.userBubble, shape = RoundedCornerShape(14.dp)) {
                        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                            if (item.text.isNotBlank()) SelectionContainer {
                                Text(item.text, color = Ink, style = MaterialTheme.typography.bodyMedium)
                            }
                            if (item.images.isNotEmpty()) HistoryImageStrip(item.images, onImageClick)
                            else if (item.localImages.isNotEmpty()) ChatPictures(item, onImageClick)
                            if (item.truncated) Text("内容较长，已保留摘要与首尾片段", color = Warm, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (item.status in setOf("sending", "waiting", "sent", "steered")) {
                            Text(itemStatusLabel(item.status!!), color = Muted, style = MaterialTheme.typography.labelSmall)
                            Spacer(Modifier.width(4.dp))
                        }
                        if (item.text.isNotBlank()) CopyMessageButton(item.text)
                        historyItemTimestamp(item)?.let { Text(formatMessageTime(it), color = Muted, style = MaterialTheme.typography.labelSmall) }
                    }
                    OutboundProgress(isOutboundInFlight(item.status), Modifier.padding(top = 2.dp).fillMaxWidth())
                }
            }
        }
        return
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        SelectionContainer {
            if (inlineThinking) Text(item.text, color = Muted, style = MaterialTheme.typography.bodySmall, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic)
            else if (item.text.isNotBlank()) KhLinkMarkdown(item.text, Modifier.fillMaxWidth())
        }
        if (item.images.isNotEmpty()) HistoryImageStrip(item.images, onImageClick)
        if (showGeneratedImages && item.generatedImages.isNotEmpty()) GeneratedImageSection(item.generatedImages, onImageClick)
        if (item.truncated) Text("内容较长，已保留摘要与首尾片段", color = Warm, style = MaterialTheme.typography.labelSmall)
        item.status?.takeIf { it.contains("fail", true) || it.contains("error", true) || it.contains("cancel", true) }?.let {
            Text(itemStatusLabel(it), color = statusColor(it), style = MaterialTheme.typography.labelSmall)
        }
        val timestamp = historyItemTimestamp(item)
        if (item.text.isNotBlank() || timestamp != null || turnUsage != null) {
            Row(Modifier.padding(top = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                if (item.text.isNotBlank()) { CopyMessageButton(item.text); Spacer(Modifier.width(4.dp)) }
                if (timestamp != null) MessageTimeAndUsage(timestamp, turnUsage, tokenUnit)
                else if (turnUsage != null) Text(completedTurnTokenLabel(turnUsage, tokenUnit), color = Muted, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun CodexComposer(
    text: String,
    onTextChange: (String) -> Unit,
    hint: String,
    model: String,
    modelEnabled: Boolean,
    openModel: () -> Unit,
    attachmentEnabled: Boolean,
    canAttach: Boolean,
    chooseImage: () -> Unit,
    chooseFile: () -> Unit,
    busy: Boolean,
    queue: Boolean,
    canSend: Boolean,
    stop: () -> Unit,
    send: () -> Unit,
) {
    var attachMenu by remember { mutableStateOf(false) }
    Surface(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        color = SurfaceBase,
        shape = RoundedCornerShape(20.dp),
        border = BorderStroke(1.dp, Divider),
        shadowElevation = 1.dp,
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 6.dp, end = 6.dp, top = 3.dp, bottom = 4.dp)) {
            androidx.compose.foundation.text.BasicTextField(
                value = text,
                onValueChange = onTextChange,
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "输入消息" },
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = Ink),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                minLines = 1,
                maxLines = 5,
                decorationBox = { field ->
                    Box(Modifier.fillMaxWidth().heightIn(min = 50.dp).padding(horizontal = 10.dp, vertical = 10.dp)) {
                        if (text.isEmpty()) Text(hint, color = Muted, style = MaterialTheme.typography.bodyMedium)
                        field()
                    }
                },
            )
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box {
                    IconButton({ attachMenu = true }, Modifier.size(42.dp), enabled = attachmentEnabled) {
                        Icon(Icons.Default.Add, "添加图片或文件", Modifier.size(22.dp), tint = Ink)
                    }
                    DropdownMenu(attachMenu, { attachMenu = false }) {
                        if (!canAttach) DropdownMenuItem({ Text("图片与文件请在电脑端操作") }, {}, enabled = false)
                        else {
                            DropdownMenuItem({ Text("图片") }, { attachMenu = false; chooseImage() }, leadingIcon = { Icon(Icons.Outlined.Image, null) })
                            DropdownMenuItem({ Text("文件") }, { attachMenu = false; chooseFile() }, leadingIcon = { Icon(Icons.Default.AttachFile, null) })
                        }
                    }
                }
                Row(
                    Modifier.weight(1f).heightIn(min = 42.dp).clip(RoundedCornerShape(9.dp))
                        .then(if (modelEnabled) Modifier.clickable(onClick = openModel).semantics { contentDescription = "设置模型、强度和速度" } else Modifier)
                        .padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.End,
                ) {
                    Text(model, Modifier.weight(1f, fill = false), color = Ink, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (modelEnabled) Icon(Icons.Default.ExpandMore, null, Modifier.size(16.dp), tint = Muted)
                }
                if (busy) {
                    OutlinedIconButton(stop, Modifier.size(38.dp), shape = CircleShape, border = BorderStroke(1.dp, Danger.copy(alpha = 0.6f))) {
                        Icon(Icons.Default.Stop, "停止", Modifier.size(17.dp), tint = Danger)
                    }
                    Spacer(Modifier.width(4.dp))
                }
                FilledIconButton(
                    onClick = send,
                    enabled = canSend,
                    modifier = Modifier.size(40.dp),
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = Accent, contentColor = Color.White),
                ) {
                    Icon(if (queue) Icons.Default.ScheduleSend else Icons.Default.ArrowUpward,
                        if (queue) "排队" else if (busy) "立即发送" else "发送", Modifier.size(19.dp))
                }
            }
        }
    }
}

@Composable
private fun PendingNewTaskScreen(pending: PendingNewTask, back: () -> Unit) {
    BackHandler(onBack = back)
    val context = LocalContext.current
    val agent = when (pending.backend) { "claude" -> "Claude"; "pi" -> "Pi"; "antigravity" -> "反重力"; "dsh" -> "DeepSeek"; "hermes" -> "Hermes"; else -> "Codex" }
    var elapsed by remember(pending.startedAt) { mutableStateOf(0L) }
    LaunchedEffect(pending.startedAt, pending.error) {
        while (pending.error == null) { elapsed = System.currentTimeMillis() - pending.startedAt; delay(1_000) }
    }
    Surface(Modifier.fillMaxSize(), color = Paper) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).background(if (ChatLayout) Paper else SurfaceBase).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(back, Modifier.size(48.dp)) {
                    if (ChatLayout) Icon(Icons.AutoMirrored.Filled.ArrowBackIos, "返回", Modifier.size(20.dp), tint = Ink)
                    else Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回")
                }
                if (!ChatLayout) { AgentLogo(pending.backend, 24.dp); Spacer(Modifier.width(8.dp)) }
                Text(pending.prompt.lineSequence().firstOrNull().orEmpty().ifBlank { "新任务" }, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = if (ChatLayout) TextAlign.Center else TextAlign.Start,
                    style = if (ChatLayout) MaterialTheme.typography.titleMedium.copy(fontSize = 17.sp) else MaterialTheme.typography.titleMedium,
                    fontWeight = if (ChatLayout) FontWeight.Medium else FontWeight.SemiBold, color = Ink)
                Spacer(Modifier.width(if (ChatLayout) 48.dp else 12.dp))
            }
            if (pending.error == null) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = Accent, trackColor = Divider.copy(alpha = 0.3f))
            else HorizontalDivider(color = Divider.copy(alpha = 0.5f))
            Text(
                pending.error?.let { "没有建成：$it" }
                    ?: ("正在电脑上新建 $agent 任务" + if (elapsed >= 3_000) " · ${elapsed / 1000} 秒" else ""),
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                color = if (pending.error != null) Danger else Muted, style = MaterialTheme.typography.labelMedium,
            )
            Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalAlignment = Alignment.End) {
                Surface(
                    color = if (ChatLayout || CodexLayout) P.userBubble else P.surfaceHigh,
                    shape = if (CodexLayout) RoundedCornerShape(18.dp) else if (ChatLayout) RoundedCornerShape(4.dp) else RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomEnd = 4.dp, bottomStart = 16.dp),
                    border = if (ChatLayout || CodexLayout) null else BorderStroke(1.dp, Divider.copy(alpha = 0.6f)),
                    modifier = Modifier.widthIn(max = 320.dp),
                ) {
                    Text(pending.prompt, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), color = Ink, style = MaterialTheme.typography.bodyMedium, lineHeight = 20.sp)
                }
                Text(pending.cwd, Modifier.padding(top = 6.dp), color = Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (pending.error != null) Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.End) {
                TextButton({ copyQueuedText(context, pending.prompt) }) { Text("复制内容") }
                Spacer(Modifier.width(8.dp))
                Button(back) { Text("返回") }
            }
        }
    }
}

@Composable
private fun OutboundSpinner(active: Boolean, modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(active) { if (active) { delay(250); shown = true } else shown = false }
    Box(modifier.size(16.dp), contentAlignment = Alignment.Center) {
        AnimatedVisibility(shown && active, enter = fadeIn(tween(160)), exit = fadeOut(tween(160))) {
            CircularProgressIndicator(Modifier.size(14.dp), color = Color(0xFFB2B2B2), strokeWidth = 1.6.dp)
        }
    }
}

/** A thin indeterminate bar that fades in only if sending takes a moment, so
 * a fast acknowledgement never flashes it. */
@Composable
private fun OutboundProgress(active: Boolean, modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(active) { if (active) { delay(250); shown = true } else shown = false }
    AnimatedVisibility(shown && active, enter = fadeIn(tween(160)), exit = fadeOut(tween(160))) {
        LinearProgressIndicator(modifier.height(2.dp).clip(RoundedCornerShape(1.dp)), color = Accent.copy(alpha = 0.7f), trackColor = Divider.copy(alpha = 0.35f))
    }
}

/**
 * A message as a chat bubble, as WeChat draws it: yours green on the right,
 * the agent's white on the left, each with a small tail toward its avatar; a
 * centered time only when five minutes have passed since the last one.
 */
@Composable
private fun ChatBubble(item: HistoryItem, user: Boolean, showGeneratedImages: Boolean, turnUsage: CompletedTurnTokenUsage?, tokenUnit: TokenDisplayUnit, onImageClick: (HistoryImage) -> Unit) {
    val backend = LocalAgentBackend.current
    val showTime = item.id in LocalChatTimeMarks.current
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        if (showTime) historyItemTimestamp(item)?.let { at ->
            Text(wechatTimeLabel(at), Modifier.align(Alignment.CenterHorizontally).padding(top = 4.dp, bottom = 12.dp), color = Color(0xFFB2B2B2), fontSize = 12.sp)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start, verticalAlignment = Alignment.Top) {
            if (!user) { ChatPeerAvatar(ChatAvatarSize); Spacer(Modifier.width(ChatAvatarGap)) } else Spacer(Modifier.width(ChatIndent))
            // WeChat shows a small spinner beside a message still on its way.
            if (user) OutboundSpinner(isOutboundInFlight(item.status), Modifier.align(Alignment.CenterVertically).padding(end = 4.dp))
            Column(Modifier.weight(1f, fill = false), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
                val shape = remember(user) { WeChatBubbleShape(tailOnRight = user) }
                // Pictures sent alone show as pictures, without a bubble, as in WeChat.
                if (user && item.text.isBlank() && (item.images.isNotEmpty() || item.localImages.isNotEmpty())) ChatPictures(item, onImageClick)
                else Surface(color = if (user) P.userBubble else Color.White, shape = shape) {
                    // A one-line bubble is as tall as the avatar beside it, as in WeChat.
                    Column(Modifier.padding(start = if (user) 11.dp else 11.dp + WeChatTail, end = if (user) 11.dp + WeChatTail else 11.dp, top = 7.dp, bottom = 7.dp)) {
                        SelectionContainer {
                            if (user) Text(item.text, color = Color(0xFF191919), fontSize = 16.sp, lineHeight = 22.sp)
                            else KhLinkMarkdown(item.text.ifBlank { "（无可见内容）" })
                        }
                        if (item.images.isNotEmpty()) HistoryImageStrip(item.images, onImageClick)
                        if (showGeneratedImages && item.generatedImages.isNotEmpty()) GeneratedImageSection(item.generatedImages, onImageClick)
                        if (item.truncated) Text("内容较长，已保留摘要与首尾片段", color = Warm, style = MaterialTheme.typography.labelSmall)
                    }
                }
                // WeChat says nothing once a message is through; only waiting is worth words.
                if (user && (item.status == "waiting" || item.status == "steered")) {
                    Text(itemStatusLabel(item.status!!), Modifier.padding(top = 3.dp, end = WeChatTail), color = Color(0xFFB2B2B2), fontSize = 11.sp)
                }
                if (!user && turnUsage != null) Text(
                    completedTurnTokenLabel(turnUsage, tokenUnit),
                    Modifier.padding(top = 3.dp, start = WeChatTail + 2.dp),
                    color = Color(0xFFB2B2B2), fontSize = 11.sp,
                )
            }
            if (user) { Spacer(Modifier.width(ChatAvatarGap)); ChatSelfAvatar() } else Spacer(Modifier.width(ChatIndent))
        }
    }
}

/**
 * Your pictures in the chat layout, each at most 150 x 200 dp with its own
 * proportions: from the history once the computer has them, from this phone
 * while they are on their way.
 */
@Composable
private fun ChatPictures(item: HistoryItem, onImageClick: (HistoryImage) -> Unit) {
    val context = LocalContext.current
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item.images.forEachIndexed { index, image ->
            val bitmap by produceState<ImageBitmap?>(null, image.data) { value = withContext(Dispatchers.Default) { decodeDataUri(image.data, 720) } }
            ChatPicture(bitmap, "你发的图片 ${index + 1}，点击查看") { onImageClick(image) }
        }
        if (item.images.isEmpty()) item.localImages.forEachIndexed { index, uri ->
            val bitmap by produceState<ImageBitmap?>(null, uri) { value = withContext(Dispatchers.IO) { decodePreview(context.contentResolver, uri, 720) } }
            ChatPicture(bitmap, "你发的图片 ${index + 1}", null)
        }
    }
}

@Composable
private fun ChatPicture(bitmap: ImageBitmap?, description: String, open: (() -> Unit)?) {
    val shape = RoundedCornerShape(4.dp)
    if (bitmap == null) {
        Box(Modifier.size(120.dp).clip(shape).background(P.chipAlt).semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Accent)
        }
        return
    }
    val aspect = (bitmap.width.toFloat() / bitmap.height.coerceAtLeast(1)).coerceIn(0.4f, 2.5f)
    val width = if (aspect >= 150f / 200f) 150.dp else 200.dp * aspect
    Image(
        bitmap, description,
        Modifier.width(width).aspectRatio(aspect).clip(shape).then(if (open != null) Modifier.clickable(onClick = open) else Modifier),
        contentScale = ContentScale.Crop,
    )
}

/** How far the bubble's tail reaches out toward the avatar. */
private val WeChatTail = 6.dp

// WeChat's measures (test phone, 2026-10-22): a 36 dp avatar about 10 dp from the
// screen edge, the bubble's body 10 dp past it (tail included), and cards
// without an avatar lined up with the bubbles' body.
private const val ChatAvatarSize = 36
private val ChatAvatarGap = 4.dp
private val ChatIndent = ChatAvatarSize.dp + ChatAvatarGap + WeChatTail

/** WeChat's bubble: a 4dp rounded box with a small triangle pointing at the avatar, near the top. */
private class WeChatBubbleShape(private val tailOnRight: Boolean) : androidx.compose.ui.graphics.Shape {
    override fun createOutline(size: androidx.compose.ui.geometry.Size, layoutDirection: androidx.compose.ui.unit.LayoutDirection, density: androidx.compose.ui.unit.Density): androidx.compose.ui.graphics.Outline {
        val tail = with(density) { WeChatTail.toPx() }
        val radius = with(density) { 4.dp.toPx() }
        val tipY = with(density) { (ChatAvatarSize / 2).dp.toPx() }.coerceAtMost(size.height / 2)
        val half = with(density) { 6.dp.toPx() }
        val path = androidx.compose.ui.graphics.Path()
        val left = if (tailOnRight) 0f else tail
        val right = if (tailOnRight) size.width - tail else size.width
        path.addRoundRect(androidx.compose.ui.geometry.RoundRect(left, 0f, right, size.height, androidx.compose.ui.geometry.CornerRadius(radius)))
        val tailPath = androidx.compose.ui.graphics.Path().apply {
            if (tailOnRight) { moveTo(right - 1f, tipY - half); lineTo(size.width, tipY); lineTo(right - 1f, tipY + half) }
            else { moveTo(left + 1f, tipY - half); lineTo(0f, tipY); lineTo(left + 1f, tipY + half) }
            close()
        }
        return androidx.compose.ui.graphics.Outline.Generic(androidx.compose.ui.graphics.Path.combine(androidx.compose.ui.graphics.PathOperation.Union, path, tailPath))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MessageTimeAndUsage(timestamp: Long, turn: CompletedTurnTokenUsage?, unit: TokenDisplayUnit, modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(formatMessageTime(timestamp), color = Muted.copy(alpha = 0.65f), style = MaterialTheme.typography.labelSmall)
        turn?.let {
            Text(completedTurnTokenLabel(it, unit), color = Muted, style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.semantics { contentDescription = "本轮 Token ${if (it.partial) "已记录" else "消耗"} ${formatTokenCount(it.usage.total)}，含输入和输出" })
        }
    }
}

/** A small copy button under one of your messages: copies its text. */
@Composable
private fun CopyMessageButton(text: String) {
    val context = LocalContext.current
    Icon(
        Icons.Default.ContentCopy, "复制这条消息",
        Modifier.size(22.dp).clip(CircleShape).clickable {
            val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return@clickable
            clipboard.setPrimaryClip(ClipData.newPlainText("khLink 消息", text))
            Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
        }.padding(4.dp),
        tint = Muted,
    )
}

/** Your own square avatar in the chat layout: your account picture, as WeChat shows yours. */
@Composable
private fun ChatSelfAvatar() {
    val (name, url) = LocalSelfAvatar.current
    UserAvatar(name, url, ChatAvatarSize, RoundedCornerShape(4.dp))
}

@Composable
private fun ActivityGroupBlock(
    items: List<HistoryItem>,
    active: Boolean = false,
    showGeneratedImages: Boolean = true,
    onImageClick: (HistoryImage) -> Unit,
    fetchingDetails: Boolean = false,
    onFetchDetails: () -> Unit = {},
) {
    // Images in thinking/tool activity are details, not generated answers.
    // Keep the activity group collapsed until the user explicitly opens it.
    var expanded by rememberSaveable("activity-group-v2:${items.first().id}") { mutableStateOf(false) }
    val groupStatus = aggregateStatus(items, forceRunning = active)
    val entries = remember(items) { activityEntries(items) }
    val isRunning = groupStatus?.let { isRunningStatus(it) } ?: active

    if (CodexLayout) {
        Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 40.dp).clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val summary = activityGroupSummary(entries)
                val title = when {
                    isRunning -> "正在处理"
                    groupStatus?.contains("fail", true) == true -> "运行错误"
                    else -> "执行过程"
                }
                Text(if (summary.isBlank()) title else "$title · $summary", Modifier.weight(1f),
                    color = if (isRunning) P.runningInk else Muted, style = MaterialTheme.typography.bodySmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(if (expanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight,
                    if (expanded) "收起操作" else "展开操作", Modifier.size(20.dp), tint = Muted)
            }
            HorizontalDivider(color = Divider)
            if (expanded) {
                val waiting = items.count { it.light }
                if (waiting > 0) LightDetailsNotice("$waiting 项操作的详细过程留在电脑上", fetchingDetails, onFetchDetails)
                val shown = entries.filterNot { it.primary.light }
                shown.forEachIndexed { index, entry ->
                    ActivityRow(entry, showGeneratedImages, onImageClick)
                    if (index != shown.lastIndex) HorizontalDivider(Modifier.padding(start = 24.dp), color = Divider.copy(alpha = 0.6f))
                }
            }
        }
        return
    }

    Surface(
        modifier = Modifier.fillMaxWidth(0.94f).padding(start = if (ChatLayout) ChatIndent else 2.dp, end = 12.dp, top = 1.dp, bottom = 1.dp),
        color = if (isRunning) P.runningContainer else P.activity,
        shape = RoundedCornerShape(if (ChatLayout) 4.dp else 12.dp),
        border = if (ChatLayout) null else BorderStroke(1.dp, if (isRunning) P.runningBorder else Divider.copy(alpha = 0.5f)),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 3.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (expanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight, if (expanded) "收起操作" else "展开操作", Modifier.size(18.dp), tint = Muted)
                Spacer(Modifier.width(6.dp))
                Icon(Icons.Default.Build, null, Modifier.size(16.dp), tint = Accent)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(activityGroupTitle(entries), fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium, color = Ink)
                    Text(activityGroupSummary(entries), color = Muted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                groupStatus?.let {
                    StatusBadge(it)
                }
            }
            if (expanded) {
                HorizontalDivider(Modifier.padding(vertical = 2.dp), color = Divider.copy(alpha = 0.7f))
                // Light mode: steps whose details stayed on the computer.
                val waiting = items.count { it.light }
                if (waiting > 0) LightDetailsNotice("$waiting 项操作的详细过程留在电脑上", fetchingDetails, onFetchDetails)
                val shown = entries.filterNot { it.primary.light }
                shown.forEachIndexed { index, entry ->
                    ActivityRow(entry, showGeneratedImages, onImageClick)
                    if (index != shown.lastIndex) HorizontalDivider(Modifier.padding(start = 28.dp, top = 2.dp, bottom = 2.dp), color = Divider.copy(alpha = 0.4f))
                }
            }
        }
    }
}

/** Light mode: details left on the computer, fetched (and kept on the phone) on request. */
@Composable
private fun LightDetailsNotice(text: String, fetching: Boolean, fetch: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 28.dp, top = 2.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (fetching) "正在查找，较旧的详情可能需要几分钟" else text, Modifier.weight(1f), color = Muted, style = MaterialTheme.typography.bodySmall)
        if (fetching) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
        else TextButton(fetch, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
            Text("从电脑取回", style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
internal fun KhLinkMarkdown(content: String, modifier: Modifier = Modifier) {
    val body = MaterialTheme.typography.bodyMedium
    val bodySmall = MaterialTheme.typography.bodySmall
    val heading1 = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold)
    val heading2 = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold)
    val heading3 = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold)
    val heading4 = body.copy(fontWeight = FontWeight.Bold)
    val code = bodySmall.copy(fontFamily = FontFamily.Monospace)
    // A link to a file on the computer asks before fetching it; web links open as before.
    val files = LocalComputerFiles.current
    val web = androidx.compose.ui.platform.LocalUriHandler.current
    val context = LocalContext.current
    val uriHandler = remember(files, web, context) {
        object : androidx.compose.ui.platform.UriHandler {
            override fun openUri(uri: String) {
                // A link to another desktop session ("#local_…") opens that conversation here.
                val session = sessionLinkId(uri)
                if (session != null) {
                    val target = files?.vm?.threads?.value?.let { linkedThread(it, session) }
                    if (target != null) OpenThreadRequests.pending.value = target.id
                    else android.widget.Toast.makeText(context, "这个对话还没同步到手机", android.widget.Toast.LENGTH_SHORT).show()
                    return
                }
                val path = files?.let { computerPathFromLink(uri, it.cwd) }
                when {
                    path != null -> files.vm.askComputerFile(path)
                    files != null && isWebVideoLink(uri) -> files.vm.askWebVideo(uri)
                    else -> runCatching { web.openUri(uri) }
                }
            }
        }
    }
    // Parse synchronously, with one flavour and parser kept for the app's
    // life. The library's defaults build a new parser on every recomposition,
    // which re-created the parsed state: each bubble went blank for a frame
    // (the blink every few seconds) and, blank, lost its height, so the list
    // shifted by itself.
    // Paths written as inline code, local links the renderer cannot read and a
    // code block holding one path become tappable file links in a conversation.
    // Windows line endings (a .md file fetched from the computer) stop the parser from seeing tables.
    val shown = remember(content, files != null) {
        val text = compactLocalMarkdownImages(content.replace("\r\n", "\n"))
        fixCjkEmphasis(if (files != null) linkifyComputerPaths(linkifyLocalFileLinks(text)) else text)
    }
    val markdownState = com.mikepenz.markdown.model.rememberMarkdownState(
        content = shown,
        flavour = MarkdownFlavour,
        parser = MarkdownParserShared,
        immediate = true,
    )
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalUriHandler provides uriHandler) {
    Markdown(
        markdownState,
        typography = markdownTypography(
            text = body,
            code = code,
            inlineCode = code,
            h1 = heading1,
            h2 = heading2,
            h3 = heading3,
            h4 = heading4,
            h5 = heading4,
            h6 = heading4,
            quote = body,
            paragraph = body,
            ordered = body,
            bullet = body,
            list = body,
            table = body,
        ),
        components = KhLinkMarkdownComponents,
        modifier = modifier,
    )
    }
}

// Tables: the library's default gives every column the same width and cuts each
// cell to one line, so long text was elided while short columns left wide gaps.
// Here columns are laid out like a browser's auto table layout: each column is
// at least as wide as its longest unbreakable word, the remaining width goes to
// the columns with more text, and cells wrap instead of eliding. A table only
// scrolls sideways when it has too many columns to fit even at 64 dp each.
// 64 dp keeps three or four characters a line; narrower, a cell in a chat
// bubble read one character per line ("预/计/）", 2026-10-22), so a table that
// needs more room scrolls sideways instead.
private val TableMinColumn = 64.dp
private val TableMaxWord = 72.dp
private val TableMaxHeader = 96.dp
private val TableCellPadding = 8.dp

private enum class TableCellKind(val margin: Float) { Plain(1.03f), Bold(1.08f), Link(1.22f) }

private fun tableRows(table: org.intellij.markdown.ast.ASTNode): List<List<org.intellij.markdown.ast.ASTNode>> =
    table.children
        .filter { it.type == org.intellij.markdown.flavours.gfm.GFMElementTypes.HEADER || it.type == org.intellij.markdown.flavours.gfm.GFMElementTypes.ROW }
        .map { row -> row.children.filter { it.type == org.intellij.markdown.flavours.gfm.GFMTokenTypes.CELL } }

// Plain text of a cell, for measuring its natural width.
private fun tableCellPlainText(content: String, cell: org.intellij.markdown.ast.ASTNode): String =
    content.substring(cell.startOffset, cell.endOffset)
        .replace(Regex("\\[([^\\]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("[*_`~]"), "")
        .trim()

// Runs that a line break can't split: Latin words and numbers. CJK text breaks between any two characters.
private val TableWord = Regex("[^\\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]+")

/**
 * Column widths from each column's minimum (longest word) and natural (unwrapped) width.
 * Natural widths that fit are stretched to fill [available]; otherwise columns are raised from
 * their minimum towards one common width, so short columns are shown whole. When even
 * the minimums overflow, they shrink towards [floor] (long words then break mid-word); only when
 * every column at [floor] still overflows are the minimums returned and the table scrolls.
 */
internal fun tableColumnWidths(min: List<Float>, natural: List<Float>, available: Float, floor: Float = 0f): List<Float> {
    if (min.isEmpty()) return min
    val max = natural.mapIndexed { index, width -> maxOf(width, min[index]) }
    val maxTotal = max.sum()
    if (maxTotal <= available) {
        if (maxTotal <= 0f) return max
        val extra = available - maxTotal
        return max.map { it + extra * (it / maxTotal) }
    }
    val minTotal = min.sum()
    if (minTotal >= available) {
        // Cap the widest columns at one common width so short columns (ids, dates) keep theirs.
        if (floor * min.size >= available) return min
        val sorted = min.sorted()
        var below = 0f
        for ((index, width) in sorted.withIndex()) {
            val cap = (available - below) / (sorted.size - index)
            if (cap <= width) return min.map { minOf(it, maxOf(cap, floor)) }
            below += width
        }
        return min
    }
    // Raise every column towards one common width (never past its natural width), so short
    // columns are shown whole and the long ones share what's left.
    var low = 0f
    var high = max.max()
    repeat(30) {
        val level = (low + high) / 2
        if (min.indices.sumOf { minOf(max[it], maxOf(min[it], level)).toDouble() } > available) high = level else low = level
    }
    return min.indices.map { minOf(max[it], maxOf(min[it], low)) }
}

@Composable
private fun KhLinkMarkdownTable(model: com.mikepenz.markdown.compose.components.MarkdownComponentModel) {
    val content = model.content
    val rows = remember(content, model.node) { tableRows(model.node) }
    if (rows.isEmpty()) return
    val columns = rows.maxOf { it.size }
    val style = model.typography.table
    val headerStyle = style.copy(fontWeight = FontWeight.Bold)
    val measurer = androidx.compose.ui.text.rememberTextMeasurer()
    val density = androidx.compose.ui.platform.LocalDensity.current
    val annotator = com.mikepenz.markdown.annotator.annotatorSettings()
    val (minWidths, naturalWidths) = remember(content, model.node, style) {
        with(density) {
            val padding = (TableCellPadding * 2).toPx()
            val floor = TableMinColumn.toPx()
            val wordCap = TableMaxWord.toPx()
            val headerCap = TableMaxHeader.toPx()
            val texts = rows.map { row -> row.map { tableCellPlainText(content, it) } }
            // Headers, emphasis and links render bold. Links also render wider than plain bold text
            // measures, so they get a bigger margin, which keeps short ids like "#212" on one line.
            val kind = rows.mapIndexed { index, row ->
                row.map { cell ->
                    val raw = content.substring(cell.startOffset, cell.endOffset)
                    when {
                        "](" in raw -> TableCellKind.Link
                        index == 0 || "**" in raw || "__" in raw -> TableCellKind.Bold
                        else -> TableCellKind.Plain
                    }
                }
            }
            fun width(text: String, kind: TableCellKind) =
                measurer.measure(text, if (kind == TableCellKind.Plain) style else headerStyle, softWrap = false).size.width * kind.margin
            // Widest value of [measure] over the cells of one column.
            fun widest(column: Int, measure: (String, TableCellKind) -> Float) =
                texts.indices.maxOfOrNull { row -> texts[row].getOrNull(column)?.let { measure(it, kind[row][column]) } ?: 0f } ?: 0f
            val min = (0 until columns).map { column ->
                val word = widest(column) { text, cellKind -> TableWord.findAll(text).maxOfOrNull { width(it.value, cellKind) } ?: 0f }
                // Keep a short header on one line, e.g. "实际转发量" rather than "实际转发" / "量".
                val header = texts.firstOrNull()?.getOrNull(column)?.let { width(it, TableCellKind.Bold) }?.takeIf { it <= headerCap } ?: 0f
                maxOf(floor, maxOf(minOf(word, wordCap), header) + padding + 1f)
            }
            val natural = (0 until columns).map { column -> widest(column, ::width) + padding + 1f }
            min to natural
        }
    }
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        // Leave room for the outer border and the column dividers so a stretched table doesn't clip its right edge.
        val available = with(density) { (maxWidth - 1.dp - 0.5.dp * (columns - 1)).toPx() }
        val widths = tableColumnWidths(minWidths, naturalWidths, available, with(density) { TableMinColumn.toPx() }).map { with(density) { it.toDp() } }
        Surface(
            Modifier.horizontalScroll(rememberScrollState()),
            shape = RoundedCornerShape(6.dp),
            border = BorderStroke(0.5.dp, Divider),
            color = Color.Transparent,
        ) {
            Column {
                rows.forEachIndexed { index, row ->
                    if (index > 0) HorizontalDivider(Modifier.width(widths.fold(0.5.dp * (columns - 1)) { sum, width -> sum + width }), color = Divider.copy(alpha = 0.6f))
                    Row(Modifier.then(if (index == 0) Modifier.background(SurfaceAlt) else Modifier).height(androidx.compose.foundation.layout.IntrinsicSize.Min)) {
                        for (column in 0 until columns) {
                            if (column > 0) Box(Modifier.width(0.5.dp).fillMaxHeight().background(Divider.copy(alpha = 0.6f)))
                            Box(Modifier.width(widths[column]).padding(horizontal = TableCellPadding, vertical = 6.dp)) {
                                row.getOrNull(column)?.let { cell ->
                                    com.mikepenz.markdown.compose.elements.MarkdownTableBasicText(
                                        content, cell, if (index == 0) headerStyle else style, Int.MAX_VALUE, TextOverflow.Clip, annotator,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private val inlineMediaPattern = Regex("""!\[([^\]]*)]\(([^)\s]+)""")

@Composable
private fun InlineMarkdownMedia(raw: String) {
    val files = LocalComputerFiles.current ?: return InlineMediaCaption(raw)
    val match = inlineMediaPattern.find(raw)
    val alt = match?.groupValues?.get(1).orEmpty()
    val url = match?.groupValues?.get(2) ?: raw.trim()
    val path = computerPathFromLink(url, files.cwd) ?: return InlineMediaCaption(raw)
    when (computerFileKind(path)) {
        ComputerFileKind.IMAGE -> InlineComputerImage(files, path, alt)
        ComputerFileKind.VIDEO -> InlineComputerVideo(files, path, alt)
        else -> InlineMediaCaption(raw)
    }
}

@Composable
private fun InlineMediaCaption(raw: String) {
    val match = inlineMediaPattern.find(raw)
    val alt = match?.groupValues?.get(1).orEmpty().ifBlank { "媒体" }
    Text("🖼 $alt", color = Muted, style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun InlineComputerImage(source: ComputerFileSource, path: String, alt: String) {
    val file by produceState<java.io.File?>(null, path) {
        value = runCatching { source.vm.loadInlineComputerFile(path) }.getOrNull()
    }
    val bitmap by produceState<Bitmap?>(null, file) {
        value = withContext(Dispatchers.IO) { file?.let { decodeInlineBitmap(it) } }
    }
    val loaded = file
    val image = bitmap
    when {
        image != null && loaded != null -> Image(
            image.asImageBitmap(),
            alt.ifBlank { "对话图片" },
            Modifier.fillMaxWidth().heightIn(max = 360.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black)
                .clickable { source.vm.showFetchedFile(FetchedFile(loaded, path, System.currentTimeMillis())) },
            contentScale = ContentScale.Fit,
        )
        loaded == null -> Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
            Spacer(Modifier.width(8.dp))
            Text("正在加载图片…", color = Muted, style = MaterialTheme.typography.bodySmall)
        }
        else -> Text("图片加载失败：${alt.ifBlank { path }}", color = Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun InlineComputerVideo(source: ComputerFileSource, path: String, alt: String) {
    var expanded by rememberSaveable(path) { mutableStateOf(false) }
    if (!expanded) {
        Surface(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { expanded = true },
            color = SurfaceAlt,
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(0.5.dp, Divider),
        ) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("🎬", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(alt.ifBlank { "视频" }, color = Ink, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("点击加载视频", color = Muted, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        return
    }
    val file by produceState<java.io.File?>(null, path) {
        value = runCatching { source.vm.loadInlineComputerFile(path) }.getOrNull()
    }
    val loaded = file
    if (loaded == null) {
        Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
            Spacer(Modifier.width(8.dp))
            Text("正在加载视频…", color = Muted, style = MaterialTheme.typography.bodySmall)
        }
    } else {
        InlineVideo(source, loaded, path, RoundedCornerShape(12.dp))
    }
}

/**
 * Files the agent sent (Claude's SendUserFile), as the desktop shows them on
 * the reply: pictures straight away, a video as a still card that loads and
 * plays only when tapped (with 放大 for full screen), other files as a row.
 */
@Composable
private fun SentFilesBlock(item: HistoryItem) {
    val source = LocalComputerFiles.current
    val backend = LocalAgentBackend.current
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp, horizontal = if (ChatLayout) 0.dp else 2.dp), verticalAlignment = Alignment.Top) {
        if (ChatLayout) { ChatPeerAvatar(ChatAvatarSize); Spacer(Modifier.width(ChatAvatarGap + WeChatTail)) }
        Column(Modifier.widthIn(max = 300.dp).weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (item.text.isNotBlank()) Text(item.text, color = if (ChatLayout) Color(0xFF7F7F7F) else Muted, style = MaterialTheme.typography.bodySmall)
            item.files.forEach { file ->
                when {
                    source == null -> SentFileRow(file, null)
                    file.kind == "image" -> InlineComputerImage(source, file.path, file.name)
                    file.kind == "video" -> SentVideoCard(source, file)
                    else -> SentFileRow(file, source)
                }
            }
            if (item.status == "failed") Text("电脑端没有发出这些文件", color = Danger, style = MaterialTheme.typography.labelSmall)
        }
        if (ChatLayout) Spacer(Modifier.width(48.dp))
    }
}

@Composable
private fun SentFileRow(file: SentFile, source: ComputerFileSource?) {
    Surface(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(if (ChatLayout) 4.dp else 12.dp)).then(if (source != null) Modifier.clickable { source.vm.askComputerFile(file.path) } else Modifier),
        color = if (ChatLayout) Color.White else SurfaceAlt, shape = RoundedCornerShape(if (ChatLayout) 4.dp else 12.dp),
        border = if (ChatLayout) null else BorderStroke(0.5.dp, Divider),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(file.name, color = Ink, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                if (file.size > 0) Text(formatBytes(file.size), color = Muted, style = MaterialTheme.typography.labelSmall)
            }
            Spacer(Modifier.width(10.dp))
            Icon(Icons.Default.InsertDriveFile, null, Modifier.size(36.dp), tint = Accent.copy(alpha = 0.8f))
        }
    }
}

/** A video: nothing is fetched until tapped; then it comes over with progress and plays here, with a full-screen button. */
@Composable
private fun SentVideoCard(source: ComputerFileSource, file: SentFile) {
    var requested by rememberSaveable(file.path) { mutableStateOf(false) }
    var progress by remember(file.path) { mutableStateOf(0L to file.size) }
    var loaded by remember(file.path) { mutableStateOf<java.io.File?>(null) }
    var failed by remember(file.path) { mutableStateOf<String?>(null) }
    LaunchedEffect(requested, file.path) {
        if (!requested || loaded != null) return@LaunchedEffect
        failed = null
        runCatching { source.vm.loadInlineComputerFile(file.path) { got, total -> progress = got to total } }
            .onSuccess { loaded = it }
            .onFailure { if (it !is kotlinx.coroutines.CancellationException) { failed = it.message ?: "视频取回失败"; requested = false } }
    }
    val shape = RoundedCornerShape(if (ChatLayout) 4.dp else 12.dp)
    // Loaded: the player takes the video's own shape (a portrait clip stands taller).
    loaded?.let { video -> InlineVideo(source, video, file.path, shape); return }
    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(shape).background(Color.Black)) {
        run {
            Column(Modifier.fillMaxSize().clickable(enabled = !requested) { requested = true }, verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                if (requested) {
                    val (got, total) = progress
                    if (total > 0) CircularProgressIndicator({ (got.toFloat() / total).coerceIn(0f, 1f) }, Modifier.size(44.dp), color = Color.White, trackColor = Color.White.copy(alpha = 0.25f), strokeWidth = 3.dp)
                    else CircularProgressIndicator(Modifier.size(44.dp), color = Color.White, strokeWidth = 3.dp)
                    Spacer(Modifier.height(8.dp))
                    Text(if (total > 0) "正在取回 ${formatBytes(got)} / ${formatBytes(total)}" else "正在取回视频…", color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelSmall)
                } else {
                    Box(Modifier.size(56.dp).background(Color.White.copy(alpha = 0.18f), CircleShape).border(1.5.dp, Color.White.copy(alpha = 0.85f), CircleShape), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.PlayArrow, "加载并播放", Modifier.size(34.dp), tint = Color.White)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(failed ?: "点击加载播放", color = if (failed != null) Color(0xFFFF8A80) else Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelSmall)
                }
            }
            Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().background(Color.Black.copy(alpha = 0.35f)).padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Movie, null, Modifier.size(14.dp), tint = Color.White.copy(alpha = 0.9f))
                Spacer(Modifier.width(6.dp))
                Text(file.name, Modifier.weight(1f), color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
                if (file.size > 0) Text(formatBytes(file.size), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

/**
 * A video playing inside the conversation, with a full-screen button. While
 * the full-screen viewer shows the same video this one is paused, and it
 * continues from where the viewer stopped once that closes.
 */
@Composable
private fun InlineVideo(source: ComputerFileSource, file: java.io.File, path: String, shape: androidx.compose.ui.graphics.Shape, modifier: Modifier = Modifier) {
    val viewing by source.vm.computerFileView.collectAsState()
    var aspect by remember(file) { mutableFloatStateOf(16f / 9f) }
    KhVideoPlayer(
        file,
        modifier.fillMaxWidth().aspectRatio(aspect.coerceIn(0.75f, 2.4f)).clip(shape),
        autoPlay = true,
        suspended = viewing?.file?.absolutePath == file.absolutePath,
        onFullscreen = { source.vm.showFetchedFile(FetchedFile(file, path, System.currentTimeMillis())) },
        onAspect = { aspect = it },
    )
}

private fun decodeInlineBitmap(file: java.io.File): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 3600) sample *= 2
    return runCatching { BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) }.getOrNull()
}

private val KhLinkMarkdownComponents = com.mikepenz.markdown.compose.components.markdownComponents(
    table = { model -> KhLinkMarkdownTable(model) },
    codeFence = { model -> KhLinkCodeBlock(markdownCodeText(model.node, model.content), model.typography.code) },
    codeBlock = { model -> KhLinkCodeBlock(markdownCodeText(model.node, model.content), model.typography.code) },
)

/**
 * A code block in a reply: long lines wrap instead of scrolling sideways (a
 * command could not be read whole on the phone), and the button at the top
 * right copies the code alone, without the fences.
 */
@Composable
private fun KhLinkCodeBlock(code: String, style: androidx.compose.ui.text.TextStyle) {
    val context = LocalContext.current
    Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(8.dp)).background(P.codeBlock)) {
        Text(code, Modifier.fillMaxWidth().padding(start = 10.dp, top = 8.dp, bottom = 8.dp, end = 34.dp), style = style, color = Ink, softWrap = true)
        Icon(
            Icons.Default.ContentCopy, "复制代码",
            Modifier.align(Alignment.TopEnd).padding(2.dp).size(30.dp).clip(CircleShape).clickable {
                val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return@clickable
                clipboard.setPrimaryClip(ClipData.newPlainText("khLink 代码", code))
                Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
            }.padding(7.dp),
            tint = Muted,
        )
    }
}

private val MarkdownFlavour = org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor()
private val MarkdownParserShared = org.intellij.markdown.parser.MarkdownParser(MarkdownFlavour)

@Composable
private fun ActivityRow(
    entry: ActivityEntry,
    showGeneratedImages: Boolean = true,
    onImageClick: (HistoryImage) -> Unit,
) {
    val item = entry.primary
    var expanded by rememberSaveable("activity-detail-v2:${item.id}") { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 5.dp), verticalAlignment = Alignment.Top) {
            Icon(if (expanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight, if (expanded) "收起详情" else "展开详情", Modifier.size(16.dp), tint = Muted)
            Spacer(Modifier.width(4.dp))
            Icon(itemIcon(item), null, Modifier.padding(top = 1.dp).size(15.dp), tint = itemAccent(item))
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(itemLabel(item, LocalAgentName.current), fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium, color = Ink)
                    Spacer(Modifier.weight(1f))
                    entry.status?.let { Text(itemStatusLabel(it), color = statusColor(it), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium) }
                }
                Text(itemPreview(item), maxLines = if (expanded) 1 else 2, overflow = TextOverflow.Ellipsis, color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (expanded) {
            Surface(
                Modifier.fillMaxWidth().padding(start = 26.dp, bottom = 6.dp),
                color = SurfaceBase,
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(0.5.dp, Divider.copy(alpha = 0.6f)),
            ) {
                Column(Modifier.padding(8.dp)) {
                    SelectionContainer {
                        if (item.type == "reasoning" || item.type == "plan") {
                            KhLinkMarkdown(activityDetailText(item), modifier = Modifier.fillMaxWidth())
                        } else {
                            Surface(
                                color = P.detail,
                                shape = RoundedCornerShape(6.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    activityDetailText(item),
                                    Modifier.padding(8.dp),
                                    fontFamily = FontFamily.Monospace,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Ink,
                                )
                            }
                        }
                    }
                    entry.outputs.forEach { output ->
                        HorizontalDivider(Modifier.padding(vertical = 8.dp), color = Divider.copy(alpha = 0.6f))
                        Text("执行结果", fontWeight = FontWeight.SemiBold, color = Muted, style = MaterialTheme.typography.labelSmall)
                        Spacer(Modifier.height(4.dp))
                        SelectionContainer {
                            Surface(
                                color = P.detail,
                                shape = RoundedCornerShape(6.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    output.text.ifBlank { "（无可见输出）" },
                                    Modifier.padding(8.dp),
                                    fontFamily = FontFamily.Monospace,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Ink,
                                )
                            }
                        }
                        if (output.images.isNotEmpty()) HistoryImageStrip(output.images, onImageClick)
                    }
                    if (item.images.isNotEmpty()) HistoryImageStrip(item.images, onImageClick)
                    if (showGeneratedImages && item.generatedImages.isNotEmpty()) {
                        GeneratedImageSection(item.generatedImages, onImageClick)
                    }
                    if (item.truncated) Text("内容较长，已保留摘要与首尾片段", color = Warm, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun HistoryImageStrip(images: List<HistoryImage>, onImageClick: (HistoryImage) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        images.forEachIndexed { index, image ->
            HistoryImageThumbnail(image, index, onImageClick)
        }
    }
}

@Composable
private fun GeneratedImageSection(images: List<HistoryImage>, onImageClick: (HistoryImage) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 10.dp)) {
        Text("生成的图片", color = Accent, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium)
        HistoryImageStrip(images, onImageClick)
    }
}

@Composable
private fun HistoryImageThumbnail(image: HistoryImage, index: Int, onClick: (HistoryImage) -> Unit) {
    data class DecodeState(val bitmap: ImageBitmap? = null, val finished: Boolean = false)
    val state by produceState<DecodeState>(initialValue = DecodeState(), image.data) {
        value = DecodeState(withContext(Dispatchers.Default) { decodeDataUri(image.data, 900) }, finished = true)
    }
    Surface(
        Modifier.fillMaxWidth().height(190.dp).clickable(
            enabled = state.bitmap != null,
            onClick = { onClick(image) },
        ).semantics { contentDescription = "电脑端图像 ${index + 1}，点击查看" },
        color = P.chipAlt,
        shape = RoundedCornerShape(6.dp),
    ) {
        if (state.bitmap != null) {
            Image(state.bitmap!!, "电脑端图像 ${index + 1}", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        } else if (!state.finished) {
            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = Accent)
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("图像加载失败", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/**
 * A full-screen image you can pinch to zoom (1× to 6×), drag around while
 * zoomed, and double-tap to zoom in or back out. Panning stops at the edges.
 */
@Composable
private fun ZoomableImage(bitmap: ImageBitmap, description: String) {
    var scale by remember(bitmap) { mutableStateOf(1f) }
    var offset by remember(bitmap) { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    var size by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    fun clamp(value: androidx.compose.ui.geometry.Offset, zoom: Float): androidx.compose.ui.geometry.Offset {
        val maxX = size.width * (zoom - 1f) / 2f; val maxY = size.height * (zoom - 1f) / 2f
        return androidx.compose.ui.geometry.Offset(value.x.coerceIn(-maxX, maxX), value.y.coerceIn(-maxY, maxY))
    }
    Image(
        bitmap, description,
        Modifier.fillMaxSize()
            .onSizeChanged { size = it }
            .pointerInput(bitmap) {
                detectTapGestures(onDoubleTap = { tap ->
                    if (scale > 1.05f) { scale = 1f; offset = androidx.compose.ui.geometry.Offset.Zero }
                    else {
                        // Zoom toward the tapped point.
                        val zoom = 2.5f
                        val center = androidx.compose.ui.geometry.Offset(size.width / 2f, size.height / 2f)
                        offset = clamp((center - tap) * (zoom - 1f), zoom); scale = zoom
                    }
                })
            }
            .pointerInput(bitmap) {
                detectTransformGestures { centroid, pan, zoomChange, _ ->
                    val zoom = (scale * zoomChange).coerceIn(1f, 6f)
                    val center = androidx.compose.ui.geometry.Offset(size.width / 2f, size.height / 2f)
                    // Keep the point under the fingers where it is while zooming.
                    val next = (offset + center - centroid) * (zoom / scale) - center + centroid + pan
                    scale = zoom
                    offset = if (zoom <= 1f) androidx.compose.ui.geometry.Offset.Zero else clamp(next, zoom)
                }
            }
            .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
        contentScale = ContentScale.Fit,
    )
}

@Composable
private fun HistoryImagePreviewDialog(image: HistoryImage, close: () -> Unit) {
    val bitmap by produceState<ImageBitmap?>(initialValue = null, image.data) {
        value = withContext(Dispatchers.Default) { decodeDataUri(image.data, 4096) }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().padding(12.dp), color = Color(0xFF111315), shape = RoundedCornerShape(8.dp)) {
            Column {
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 5.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("电脑端图像", Modifier.weight(1f), color = Color.White, style = MaterialTheme.typography.titleSmall)
                    IconButton(close) { Icon(Icons.Default.Close, "关闭图像", tint = Color.White) }
                }
                Box(Modifier.fillMaxSize().weight(1f), contentAlignment = Alignment.Center) {
                    if (bitmap != null) ZoomableImage(bitmap!!, "电脑端图像")
                    else CircularProgressIndicator(color = Accent)
                }
            }
        }
    }
}

private fun isActivityItem(item: HistoryItem) = item.type in setOf("commandExecution", "fileChange", "mcpToolCall", "webSearch", "imageView", "imageGeneration", "collabAgentToolCall", "error", "turnError")

/** A context compaction, shown as a line across the conversation as Codex Desktop does. */
@Composable
private fun CompactionNotice(item: HistoryItem) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = Divider.copy(alpha = 0.7f))
        Icon(Icons.Default.Compress, null, Modifier.padding(horizontal = 6.dp).size(14.dp), tint = Muted)
        Text(item.text.ifBlank { "上下文已自动压缩" } + (if (item.durationMs > 0) " · 用时 ${formatTurnDuration(item.durationMs)}" else ""),
            color = Muted, style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.width(6.dp))
        HorizontalDivider(Modifier.weight(1f), color = Divider.copy(alpha = 0.7f))
    }
}

/** A context compaction running now: the line a finished one leaves, with a spinner until it ends. */
@Composable
private fun LiveCompactionNotice() {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = Divider.copy(alpha = 0.7f))
        CircularProgressIndicator(Modifier.padding(horizontal = 6.dp).size(12.dp), strokeWidth = 1.5.dp, color = Muted)
        Text("正在压缩上下文…", color = Muted, style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.width(6.dp))
        HorizontalDivider(Modifier.weight(1f), color = Divider.copy(alpha = 0.7f))
    }
}

/** Claude's next-step box: suggestions fill the ordinary composer for review. */
@Composable
private fun ClaudeNextStepCard(item: HistoryItem, active: Boolean, hasDraft: Boolean, choose: (ClaudeNextStepAction) -> Unit) {
    val step = item.nextStep
    Surface(
        Modifier.fillMaxWidth().padding(start = if (ChatLayout) ChatIndent else 2.dp, end = 2.dp, top = 3.dp, bottom = 3.dp),
        shape = RoundedCornerShape(14.dp), color = SurfaceBase,
        border = BorderStroke(1.dp, if (active) Accent.copy(alpha = 0.55f) else Divider),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(claudeNextStepHeading(step, active), color = if (active) Accent else Muted,
                fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
            if (step == null) Text(item.text, color = Ink, style = MaterialTheme.typography.bodyMedium)
            else {
                if (step.recap.isNotBlank()) Text(step.recap, color = Muted, style = MaterialTheme.typography.bodyMedium)
                if (step.ask.isNotBlank()) Text(step.ask, color = Ink, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyLarge)
                step.actions.forEach { action ->
                    OutlinedButton(onClick = { choose(action) }, enabled = active && !hasDraft, modifier = Modifier.fillMaxWidth()) {
                        Text(action.label)
                    }
                }
                if (active) Text(if (hasDraft) "按你的想法修改下方内容，再点发送。" else if (step.actions.isEmpty()) "可在下方输入回复，再点发送。" else "可点选填入，也可直接在下方输入反馈，再点发送。",
                    color = Muted, style = MaterialTheme.typography.labelMedium)
                else if (item.status == "failed") Text("卡片未显示成功，可在输入框继续对话。", color = Muted, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

/**
 * Claude Desktop's task list for a turn. Open while that turn runs, folded to
 * one line (progress and the step now running) otherwise; a tap toggles it.
 */
@Composable
private fun ClaudeTaskListCard(item: HistoryItem, list: ClaudeTaskList, running: Boolean) {
    var expanded by rememberSaveable(item.id, running) { mutableStateOf(running) }
    val progress by animateFloatAsState(list.done.toFloat() / list.steps.size, KhMotion.element(), label = "task-progress")
    Surface(
        Modifier.fillMaxWidth().padding(start = if (ChatLayout) ChatIndent else 2.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
        shape = RoundedCornerShape(14.dp), color = SurfaceBase,
        border = BorderStroke(if (running) 1.dp else 0.5.dp, if (running) Accent.copy(alpha = 0.35f) else Divider),
    ) {
        Column(Modifier.clickable { expanded = !expanded }.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
                    if (list.finished) Icon(Icons.Default.CheckCircle, null, Modifier.size(18.dp), tint = Accent)
                    else CircularProgressIndicator(progress = { progress }, modifier = Modifier.size(15.dp), color = Accent, trackColor = Divider, strokeWidth = 2.dp)
                }
                Spacer(Modifier.width(8.dp))
                Text("任务清单", color = Ink, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.width(6.dp))
                Text("${list.done}/${list.steps.size}", color = Muted, style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.width(10.dp))
                Text(
                    if (expanded) "" else list.current?.content ?: if (list.finished) "全部完成" else "",
                    Modifier.weight(1f), color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium,
                )
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (expanded) "收起任务清单" else "展开任务清单", Modifier.size(18.dp), tint = Muted)
            }
            AnimatedVisibility(expanded, enter = expandVertically(KhMotion.element()) + fadeIn(), exit = shrinkVertically(KhMotion.element()) + fadeOut()) {
                Column(Modifier.padding(top = 10.dp, start = 1.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    list.steps.forEach { step -> ClaudeTaskStepRow(step, running) }
                }
            }
        }
    }
}

@Composable
private fun ClaudeTaskStepRow(step: ClaudeTaskStep, running: Boolean) {
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 2.dp).size(16.dp), contentAlignment = Alignment.Center) {
            when (step.status) {
                "completed" -> Icon(Icons.Default.CheckCircle, null, Modifier.size(15.dp), tint = Accent.copy(alpha = 0.8f))
                "in_progress" -> if (running) {
                    val pulse = rememberInfiniteTransition(label = "task-step")
                    val alpha by pulse.animateFloat(0.35f, 1f, infiniteRepeatable(tween(800), RepeatMode.Reverse), label = "task-step-alpha")
                    Box(Modifier.size(9.dp).graphicsLayer { this.alpha = alpha }.background(Warm, CircleShape))
                } else Icon(Icons.Default.RadioButtonChecked, null, Modifier.size(15.dp), tint = Warm)
                else -> Icon(Icons.Default.RadioButtonUnchecked, null, Modifier.size(15.dp), tint = Muted.copy(alpha = 0.45f))
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(
            step.content,
            color = when (step.status) { "in_progress" -> Ink; "completed" -> Muted; else -> Muted.copy(alpha = 0.85f) },
            fontWeight = if (step.status == "in_progress") FontWeight.SemiBold else FontWeight.Normal,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

/** A non-blocking Codex question, answered with the desktop's original reply format. */
@Composable
private fun CodexQuestionCard(questions: List<CodexQuestion>, answers: Map<String, String>, pending: Map<String, String>, answer: (CodexQuestion, String) -> Unit) {
    if (questions.isEmpty()) return
    Surface(
        Modifier.fillMaxWidth().padding(start = if (ChatLayout) ChatIndent else 2.dp, end = 2.dp, top = 3.dp, bottom = 3.dp),
        shape = RoundedCornerShape(14.dp),
        color = SurfaceBase,
        border = BorderStroke(1.dp, if (questions.all { answers.containsKey(it.id) }) Divider.copy(alpha = 0.6f) else Accent.copy(alpha = 0.55f)),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Filled.HelpOutline, null, Modifier.size(18.dp), tint = Accent)
                Spacer(Modifier.width(6.dp))
                Text("Codex 在问你", fontWeight = FontWeight.SemiBold, color = Ink, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.weight(1f))
                Text("不影响任务继续执行", color = Muted, style = MaterialTheme.typography.labelSmall)
            }
            questions.forEach { question -> CodexQuestionBody(question, answers[question.id], pending[question.id]) { answer(question, it) } }
        }
    }
}

@Composable
private fun CodexQuestionBody(question: CodexQuestion, answered: String?, pending: String? = null, answer: (String) -> Unit) {
    var writing by remember(question.id) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(question.question, color = Ink, style = MaterialTheme.typography.bodyMedium)
        if (answered != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.CheckCircle, null, Modifier.size(16.dp), tint = Accent)
                Spacer(Modifier.width(6.dp))
                Text("已回答：$answered", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        } else if (pending != null) {
            Text(pending, color = Muted, style = MaterialTheme.typography.bodySmall)
        } else {
            question.options.forEach { option ->
                OutlinedButton({ answer(option) }, Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp)) {
                    Text(option, Modifier.fillMaxWidth(), color = Ink, style = MaterialTheme.typography.bodyMedium)
                }
            }
            TextButton({ writing = true }) { Text(if (question.options.isEmpty()) "回答" else "其他回答…") }
        }
    }
    if (writing) {
        var text by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { writing = false },
            title = { Text("回答 Codex") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(question.question, color = Muted, style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), placeholder = { Text("你的回答") })
                }
            },
            confirmButton = { TextButton({ writing = false; answer(text.trim()) }, enabled = text.isNotBlank()) { Text("发送") } },
            dismissButton = { TextButton({ writing = false }) { Text("取消") } },
        )
    }
}

/** Codex has just asked something: its options, offered at once over the conversation. */
@Composable
private fun CodexQuestionDialog(prompt: CodexQuestionPrompt, answers: Map<String, String>, pending: Map<String, String>, answer: (CodexQuestion, String) -> Unit, dismiss: () -> Unit) {
    // An answer on its way counts: the dialog closes at once, the card in the chat shows how sending goes.
    val open = prompt.questions.filter { !answers.containsKey(it.id) && !pending.containsKey(it.id) }
    if (open.isEmpty()) { LaunchedEffect(prompt) { dismiss() }; return }
    AlertDialog(
        onDismissRequest = dismiss,
        icon = { Icon(Icons.AutoMirrored.Filled.HelpOutline, null, tint = Accent) },
        title = { Text("Codex 在问你") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Codex 需要你回答。可以现在填写，也可以稍后从对话里的“回答”按钮打开；稍后不会清除待回答提示。", color = Muted, style = MaterialTheme.typography.bodySmall)
                open.forEach { question -> CodexQuestionBody(question, null, pending[question.id]) { answer(question, it) } }
            }
        },
        confirmButton = { TextButton(dismiss) { Text("稍后") } },
    )
}

// Name of the agent that owns the open thread ("Codex" / "Claude"), for message labels.
// Use the backend identity for artwork; translated display names are not IDs.
private val LocalAgentBackend = androidx.compose.runtime.staticCompositionLocalOf { "codex" }
private val LocalAgentName = androidx.compose.runtime.staticCompositionLocalOf { "Codex" }

/** Links in the conversation on screen that point at computer files, relative to its folder. */
private class ComputerFileSource(val cwd: String, val vm: BridgeViewModel)
private val LocalComputerFiles = androidx.compose.runtime.staticCompositionLocalOf<ComputerFileSource?> { null }

/**
 * Asks before fetching a linked computer file (nothing is downloaded until
 * then), shows progress while it comes over, and hands it to the phone's app.
 */
@Composable
internal fun ComputerFileDialog(vm: BridgeViewModel) {
    val state by vm.computerFile.collectAsState()
    val load = state ?: return
    val name = computerFileName(load.path)
    val loading = load.confirmed && load.error == null
    AlertDialog(
        onDismissRequest = vm::dismissComputerFile,
        // A stray tap outside must not throw away a long download (a video).
        properties = DialogProperties(dismissOnClickOutside = !loading),
        title = { Text(if (load.error != null) "没能打开" else if (load.confirmed) "正在从电脑取回" else "打开电脑上的文件？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(name, fontWeight = FontWeight.SemiBold)
                Text(load.path, color = Muted, style = MaterialTheme.typography.bodySmall)
                when {
                    load.error != null -> Text(load.error, color = Danger, style = MaterialTheme.typography.bodySmall)
                    load.confirmed -> {
                        if (load.total > 0) LinearProgressIndicator({ (load.received.toFloat() / load.total).coerceIn(0f, 1f) }, Modifier.fillMaxWidth())
                        else LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text(if (load.total > 0) "${imageSizeLabel(load.received)} / ${imageSizeLabel(load.total)}" + (if (load.bytesPerSecond > 0) " · ${imageSizeLabel(load.bytesPerSecond)}/s" else "") else "连接中…", color = Muted, style = MaterialTheme.typography.labelSmall)
                    }
                    else -> Text("文件会从电脑取回到手机，在 khLink 里打开；也可以保存到手机或用其他应用打开。", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            if (!load.confirmed || load.error != null) TextButton({ vm.openComputerFile(load.path) }) { Text(if (load.error != null) "重试" else "下载并打开") }
        },
        dismissButton = { TextButton(vm::dismissComputerFile) { Text(if (load.confirmed && load.error == null) "取消" else "关闭") } },
    )
}

/** Where the conversation on screen loads images a tool returned. */
private class ToolImageSource(val threadId: String, val vm: BridgeViewModel)
private val LocalToolImages = androidx.compose.runtime.staticCompositionLocalOf<ToolImageSource?> { null }

internal fun imageSizeLabel(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1024.0 / 1024.0)
    bytes > 0 -> "${(bytes + 1023) / 1024} KB"
    else -> ""
}

/**
 * Screenshots and other images a Claude tool returned. They stay on the
 * computer until asked for, so a session full of screenshots does not load
 * them all; each loads with one tap and is then kept for this app session.
 */
@Composable
private fun ToolImagesCard(item: HistoryItem, onImageClick: (HistoryImage) -> Unit) {
    val source = LocalToolImages.current
    val scope = rememberCoroutineScope()
    val loaded = remember(item.id) { androidx.compose.runtime.mutableStateMapOf<String, HistoryImage>() }
    val loading = remember(item.id) { androidx.compose.runtime.mutableStateMapOf<String, Boolean>() }
    var error by remember(item.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(item.id, source) {
        if (source != null) item.imageRefs.forEach { ref -> source.vm.cachedClaudeImage(source.threadId, ref.ref)?.let { loaded[ref.ref] = it } }
    }
    fun load(refs: List<HistoryImageRef>) {
        val target = source ?: return
        refs.filter { it.ref !in loaded && loading[it.ref] != true }.forEach { ref ->
            loading[ref.ref] = true; error = null
            scope.launch {
                runCatching { target.vm.loadClaudeImage(target.threadId, ref) }
                    .onSuccess { loaded[ref.ref] = it }
                    .onFailure { error = it.message ?: "图片加载失败" }
                loading.remove(ref.ref)
            }
        }
    }
    Surface(Modifier.fillMaxWidth(), color = P.activity, shape = RoundedCornerShape(12.dp), border = BorderStroke(0.5.dp, Divider)) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val pending = item.imageRefs.filter { it.ref !in loaded }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.AttachFile, null, Modifier.size(15.dp), tint = Muted)
                Spacer(Modifier.width(6.dp))
                val total = item.imageRefs.sumOf { it.bytes }
                Text(
                    "工具返回了 ${item.imageRefs.size} 张图片" + imageSizeLabel(total).takeIf { it.isNotEmpty() }?.let { "（共 $it）" }.orEmpty(),
                    Modifier.weight(1f), color = Muted, style = MaterialTheme.typography.labelMedium,
                )
                if (pending.isNotEmpty()) {
                    val busy = pending.any { loading[it.ref] == true }
                    TextButton({ load(pending) }, enabled = !busy && source != null) {
                        Text(if (busy) "加载中…" else if (loaded.isEmpty()) "加载图片" else "加载其余", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            val shown = item.imageRefs.mapNotNull { loaded[it.ref] }
            if (shown.isNotEmpty()) HistoryImageStrip(shown, onImageClick)
            error?.let { Text(it, color = Danger, style = MaterialTheme.typography.labelSmall) }
        }
    }
}

private fun itemLabel(item: HistoryItem, agent: String = "Codex") = when (item.type) {
    "userMessage" -> "你"
    "agentMessage" -> agent
    "plan" -> "计划"
    "reasoning" -> "思考过程"
    "commandExecution" -> "命令执行"
    "fileChange" -> "文件变更"
    "mcpToolCall" -> "MCP 工具"
    "webSearch" -> "网页搜索"
    "imageView" -> "查看图片"
    "imageGeneration" -> "生成图片"
    "collabAgentToolCall" -> "协作任务"
    "contextCompaction" -> "上下文整理"
    "error", "turnError" -> "运行错误"
    // A Claude Code workflow: many sub-agents in phases, progress kept updated.
    "workflow" -> "Workflow 进度"
    else -> item.type.ifBlank { agent }
}

private fun itemIcon(item: HistoryItem): ImageVector = when (item.type) {
    "reasoning" -> Icons.Default.Psychology
    "commandExecution" -> Icons.Default.Terminal
    "fileChange" -> Icons.Default.InsertDriveFile
    "webSearch" -> Icons.Default.Search
    "imageView", "imageGeneration" -> Icons.Default.AttachFile
    "error", "turnError" -> Icons.Default.Error
    "collabAgentToolCall" -> Icons.Default.Devices
    "contextCompaction" -> Icons.Default.Compress
    "workflow" -> Icons.Default.Devices
    else -> Icons.Default.Build
}

private fun itemAccent(item: HistoryItem) = when (item.type) {
    "reasoning" -> P.reasoning
    "fileChange" -> Accent
    "commandExecution" -> P.command
    "error", "turnError" -> Danger
    "webSearch" -> P.webSearch
    "contextCompaction" -> P.compaction
    else -> P.itemOther
}

private fun itemPreview(item: HistoryItem): String {
    val raw = item.text.lineSequence().map { it.trim() }.firstOrNull { it.isNotBlank() }.orEmpty()
    return when {
        raw.isBlank() || raw == "[]" || raw == "{}" -> "暂无可见摘要"
        raw.startsWith("{") || raw.startsWith("[") -> when (item.type) {
            "fileChange" -> "文件变更详情"
            "commandExecution" -> "命令与执行结果"
            else -> "结构化执行详情"
        }
        else -> raw.removePrefix("$ ").removePrefix("> ")
    }
}

private fun activityDetailText(item: HistoryItem): String {
    val value = item.text.trim()
    return if ((item.type == "reasoning" || item.type == "plan") && value in setOf("[]", "{}")) {
        "（无可见内容）"
    } else {
        item.text.ifBlank { "（无可见内容）" }
    }
}

private fun activityGroupTitle(entries: List<ActivityEntry>): String = when {
    entries.any { it.primary.type == "error" || it.primary.type == "turnError" } -> "运行错误"
    entries.any { it.primary.type == "reasoning" || it.primary.type == "plan" } -> "思考与操作"
    else -> "执行了 ${entries.size} 项操作"
}

private fun activityGroupSummary(entries: List<ActivityEntry>): String {
    val labels = listOf(
        "reasoning" to "次思考",
        "plan" to "项计划",
        "commandExecution" to "条命令",
        "fileChange" to "次文件变更",
        "mcpToolCall" to "次 MCP 调用",
        "webSearch" to "次网页搜索",
        "imageView" to "次图片查看",
        "imageGeneration" to "次图片生成",
        "collabAgentToolCall" to "个协作任务",
        "error" to "条错误",
        "turnError" to "条错误",
    )
    return labels.mapNotNull { (type, label) -> entries.count { it.primary.type == type }.takeIf { it > 0 }?.let { "$it $label" } }.joinToString(" · ")
}

private fun aggregateStatus(items: List<HistoryItem>, forceRunning: Boolean = false): String? {
    val statuses = items.mapNotNull { it.status }
    val failed = { status: String -> status.contains("fail", true) || status.contains("error", true) }
    return when {
        // Red only when the group ended on a failure; a call that failed midway
        // and was worked around is still noted, in amber.
        statuses.lastOrNull()?.let(failed) == true -> "failed"
        forceRunning -> "running"
        statuses.any { isRunningStatus(it) } -> "running"
        statuses.any(failed) -> "partial"
        statuses.any { it.contains("cancel", true) || it.contains("abort", true) || it.contains("interrupt", true) } -> "cancelled"
        statuses.isNotEmpty() -> "completed"
        else -> null
    }
}

private fun itemStatusLabel(status: String) = when {
    status.contains("fail", true) || status.contains("error", true) -> "失败"
    status.equals("unknown", true) -> "状态未知"
    status.equals("sent", true) -> "已发送"
    status.contains("sending", true) -> "发送中"
    status.equals("waiting", true) -> "等这一轮接收"
    status.contains("steered", true) -> "已调整方向"
    status.contains("compact", true) -> "整理中"
    isRunningStatus(status) -> "执行中"
    status.contains("cancel", true) || status.contains("abort", true) || status.contains("interrupt", true) -> "已停止"
    else -> "已完成"
}

@Composable
private fun ApprovalDialog(
    request: ApprovalRequest,
    decline: () -> Unit,
    accept: () -> Unit,
    answer: (Map<String, UserInputAnswer>) -> Unit,
    acceptForSession: () -> Unit = {},
) {
    var answers by remember(request.threadId, request.rpcId) { mutableStateOf<Map<String, UserInputAnswer>>(emptyMap()) }
    val dynamic = request.questions.isNotEmpty()
    fun update(questionId: String, transform: (UserInputAnswer) -> UserInputAnswer) {
        answers = answers + (questionId to transform(answers[questionId] ?: UserInputAnswer()))
    }
    fun valid(question: ApprovalQuestion): Boolean {
        val value = answers[question.id] ?: UserInputAnswer()
        if (!question.required) return true
        val customSelected = value.selected.any { selected -> question.options.any { it.id == selected && it.custom } }
        return when {
            question.options.isEmpty() -> value.customText.isNotBlank()
            customSelected -> value.customText.isNotBlank()
            else -> value.selected.isNotEmpty()
        }
    }
    AlertDialog(
        onDismissRequest = {},
        title = { Text(request.title.ifBlank { if (dynamic) "需要你的输入" else "需要你的确认" }) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (request.detail.isNotBlank()) {
                    if (dynamic) Text(request.detail, color = Muted, style = MaterialTheme.typography.bodySmall)
                    // The command or the files being approved, as Codex will run them.
                    else Surface(Modifier.fillMaxWidth(), color = P.codeBlock, shape = RoundedCornerShape(8.dp)) {
                        Text(request.detail, Modifier.padding(10.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = Ink)
                    }
                }
                if (!dynamic && request.allowSession) TextButton(acceptForSession, Modifier.fillMaxWidth(), enabled = !request.submitting) {
                    Text(if (request.kind == "file") "本会话内修改文件都允许" else "本会话内同类命令都允许")
                }
                if (dynamic) request.questions.forEach { question ->
                    val value = answers[question.id] ?: UserInputAnswer()
                    val customSelected = value.selected.any { selected -> question.options.any { it.id == selected && it.custom } }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(question.text, fontWeight = FontWeight.SemiBold)
                        if (question.detail.isNotBlank()) Text(question.detail, color = Muted, style = MaterialTheme.typography.bodySmall)
                        question.options.forEach { option ->
                            val selected = option.id in value.selected
                            OutlinedButton(
                                {
                                    val next = if (question.multiple) {
                                        if (selected) value.selected - option.id else value.selected + option.id
                                    } else setOf(option.id)
                                    update(question.id) { it.copy(selected = next, customText = if (option.custom && !selected) it.customText else if (!option.custom) "" else it.customText) }
                                },
                                Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.outlinedButtonColors(containerColor = if (selected) P.selectedMuted else Color.Transparent),
                                enabled = !request.submitting,
                            ) {
                                Column(Modifier.fillMaxWidth()) {
                                    Text(option.label)
                                    if (option.detail.isNotBlank()) Text(option.detail, color = Muted, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                        if (question.options.isEmpty() || customSelected) {
                            OutlinedTextField(
                                value = value.customText,
                                onValueChange = { text -> update(question.id) { it.copy(customText = text) } },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text(if (question.options.isEmpty()) "请输入回复" else "请输入自定义内容") },
                                minLines = 2,
                                enabled = !request.submitting,
                                visualTransformation = if (question.secret) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                            )
                        }
                    }
                } else if (request.detail.isBlank()) Text(request.method, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        },
        dismissButton = { OutlinedButton(decline, enabled = !request.submitting) { Text("拒绝") } },
        confirmButton = {
            Button(
                { if (dynamic) answer(answers) else accept() },
                enabled = !request.submitting && (!dynamic || request.questions.all(::valid)),
            ) { Text(if (request.submitting) "提交中…" else if (dynamic) "提交" else "允许") }
        },
    )
}

@Composable
private fun SettingsDialog(caps: CapabilityState, current: ThreadSettings, close: () -> Unit, save: (CodexSettingsChanges) -> Unit) {
    var model by remember(current.model) { mutableStateOf(current.model) }
    var effort by remember(current.effort) { mutableStateOf(current.effort) }
    // Codex records fast mode as "priority"; the model list calls it "fast".
    val currentTier = current.serviceTier?.lowercase()?.takeUnless { it in setOf("", "default", "standard", "auto") }?.let { if (it == "priority") "fast" else it }
    var tier by remember(current.serviceTier) { mutableStateOf(currentTier) }
    var permissionMode by remember(current.permissionMode) { mutableStateOf(current.permissionMode) }
    var collaborationMode by remember(current.desiredCollaborationMode) { mutableStateOf(current.desiredCollaborationMode) }
    SettingsSheet(
        title = "Codex 设置",
        subtitle = taskSettingsSummary(current, caps),
        close = close,
        saveEnabled = true,
        save = { save(codexSettingsChanges(current, model, effort, tier, permissionMode, collaborationMode)) },
    ) {
        if (caps.rateLimit.isNotBlank()) SheetNote("额度：${caps.rateLimit}")
        val availableEfforts = caps.effortsByModel[model ?: caps.codexDefaultModel()] ?: caps.efforts
        // "默认" says what it is, so the task's real model and effort are always visible.
        val defaultModel = caps.codexDefaultModel()
        val defaultEffort = caps.codexEffectiveEffort(model, null)?.let(::reasoningEffortLabel)
        // Codex model ids are short: chips that wrap keep the whole sheet in view.
        SheetSection("模型", defaultModel?.let { "默认为 $it" }) {
            SheetSegments(
                listOf(SheetOption("", "默认")) + caps.models.map { SheetOption(it, it) },
                model.orEmpty(),
            ) {
                val selected = it.ifBlank { null }
                effort = caps.effortAfterModelChange(model, selected, effort)
                if (tier != null && tier !in caps.codexSpeedTiers(selected)) tier = null
                model = selected
            }
        }
        SheetSection("推理强度", defaultEffort?.let { "默认为$it" }) {
            SheetSegments(listOf(SheetOption("", "默认")) + availableEfforts.map { SheetOption(it, reasoningEffortLabel(it)) }, effort.orEmpty()) { effort = it.ifBlank { null } }
        }
        val speeds = caps.codexSpeedTiers(model)
        if (speeds.isNotEmpty() || tier != null) SheetSection("速度") {
            SheetSegments(listOf(SheetOption("", "标准")) + speeds.map { SheetOption(it, serviceTierLabel(it)) }, tier.orEmpty()) { tier = it.ifBlank { null } }
        }
        SheetSection("权限模式") {
            SheetOptionList(permissionModeOptions("codex").map { SheetOption(it.id, it.label, it.detail, it.risky) }, permissionMode) { permissionMode = it }
        }
        if (permissionMode == "yolo") SheetNote("完全访问只对当前任务生效，异常或重启后恢复为请求批准。", SheetTone.Danger)
        val availableModes = caps.collaborationModes.toSet()
        SheetSection("工作模式") {
            if (availableModes.isEmpty()) SheetNote("当前 Codex 版本未提供计划模式")
            else SheetSegments(
                listOf(SheetOption("default", "执行"), SheetOption("plan", "计划")).filter { it.key in availableModes },
                collaborationMode,
            ) { collaborationMode = it }
        }
        when (current.modeSyncState) {
            "pending" -> SheetNote("${if (current.desiredCollaborationMode == "plan") "计划" else "执行"}模式正在等待桌面确认", SheetTone.Waiting)
            "failed" -> SheetNote(current.modeSyncReason ?: "工作模式同步失败，桌面仍保持原模式", SheetTone.Danger)
        }
        SheetNote("设置与桌面端同步；正在执行的这一轮不变，下一轮生效。" + (current.approvalPolicy?.let { "\n桌面审批策略：$it" } ?: ""))
    }
}

@Composable
private fun AttachmentChip(item: AttachmentUpload, remove: () -> Unit, open: () -> Unit) {
    val (label, color, icon) = when (item.state) {
        "uploaded" -> Triple("已上传", P.success, Icons.Default.CheckCircle)
        "failed" -> Triple("上传失败", Danger, Icons.Default.Error)
        else -> Triple("上传中", Warm, Icons.Default.Schedule)
    }
    val image = isImageAttachment(item)
    Surface(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = image && item.state == "uploaded", onClick = open),
        color = P.surfaceHigh,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, Divider.copy(alpha = 0.6f)),
    ) {
        Row(Modifier.padding(start = 8.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (image) AttachmentThumbnail(item) else Icon(icon, null, Modifier.size(22.dp), tint = color)
            Spacer(Modifier.width(10.dp))
            Text(item.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = Ink, fontWeight = FontWeight.Medium)
            Text(label, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
            IconButton(remove, Modifier.size(32.dp)) { Icon(Icons.Default.Close, "移除 ${item.name}", Modifier.size(16.dp), tint = Muted) }
        }
        if (item.state == "failed" && !item.error.isNullOrBlank()) {
            Text(
                item.error!!,
                Modifier.fillMaxWidth().padding(start = 40.dp, end = 8.dp, bottom = 6.dp),
                color = Danger,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun AttachmentThumbnail(item: AttachmentUpload) {
    val context = LocalContext.current
    val preview by produceState<ImageBitmap?>(null, item.localUri) {
        value = withContext(Dispatchers.IO) { decodePreview(context.contentResolver, item.localUri, 256) }
    }
    Surface(Modifier.size(40.dp), shape = RoundedCornerShape(8.dp), color = P.thumb) {
        if (preview != null) {
            Image(preview!!, item.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.InsertDriveFile, null, Modifier.size(20.dp), tint = Muted)
            }
        }
    }
}

@Composable
private fun AttachmentPreviewDialog(item: AttachmentUpload, close: () -> Unit) {
    val context = LocalContext.current
    val preview by produceState<ImageBitmap?>(null, item.localUri) {
        value = withContext(Dispatchers.IO) { decodePreview(context.contentResolver, item.localUri, 2560) }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().padding(12.dp), color = Color(0xFF111315), shape = RoundedCornerShape(8.dp)) {
            Column {
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 5.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(item.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, color = Color.White, style = MaterialTheme.typography.titleSmall)
                    IconButton(close) { Icon(Icons.Default.Close, "关闭图片", tint = Color.White) }
                }
                Box(Modifier.fillMaxSize().weight(1f), contentAlignment = Alignment.Center) {
                    if (preview != null) ZoomableImage(preview!!, item.name)
                    else CircularProgressIndicator(color = Accent)
                }
            }
        }
    }
}

private fun isImageAttachment(item: AttachmentUpload): Boolean {
    if (item.mimeType?.startsWith("image/") == true) return true
    return item.name.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif")
}

private fun decodePreview(resolver: android.content.ContentResolver, rawUri: String, maxSide: Int): ImageBitmap? = runCatching {
    val uri = Uri.parse(rawUri)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (bounds.outWidth / sample > maxSide || bounds.outHeight / sample > maxSide) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample.coerceAtLeast(1) }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options)?.asImageBitmap() }
}.getOrNull()

private fun decodeDataUri(raw: String, maxSide: Int): ImageBitmap? = runCatching {
    val comma = raw.indexOf(',')
    if (comma <= 0 || !raw.startsWith("data:image/", true)) return@runCatching null
    val bytes = Base64.decode(raw.substring(comma + 1), Base64.DEFAULT)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / sample > maxSide || bounds.outHeight / sample > maxSide) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample.coerceAtLeast(1) }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
}.getOrNull()

private data class SettingOption(val id: String, val label: String)

// ---- Permission modes, named exactly as each desktop app names them ----
private data class PermissionModeOption(val id: String, val label: String, val detail: String, val risky: Boolean = false)

private fun permissionModeOptions(backend: String): List<PermissionModeOption> = if (backend == "claude") listOf(
    // Claude desktop (Code tab) permission modes.
    PermissionModeOption("default", "Manual", "每次改文件、跑命令前都先问你"),
    PermissionModeOption("acceptEdits", "Accept edits", "自动接受文件修改，其他操作仍然询问"),
    PermissionModeOption("plan", "Plan", "只调研和出方案，不改动任何东西"),
    PermissionModeOption("auto", "Auto", "由 Claude 判断哪些操作需要你确认"),
    PermissionModeOption("bypassPermissions", "Bypass permissions", "跳过所有确认，完全放手执行", risky = true),
) else listOf(
    // Codex desktop approval modes.
    PermissionModeOption("manual", "请求批准", "每次操作前都先问你"),
    PermissionModeOption("auto", "帮我批准", "常规操作自动批准，敏感操作仍询问"),
    PermissionModeOption("yolo", "完全访问权限", "不再询问，完全信任 Codex", risky = true),
)

// Older KH Link values for Claude threads (manual / yolo) -> desktop modes.
private fun claudePermissionValue(value: String?): String = when (value) {
    null, "", "manual" -> "default"
    "yolo" -> "bypassPermissions"
    else -> value
}

@Composable
private fun PermissionModePicker(backend: String, selected: String, choose: (String) -> Unit) {
    val options = permissionModeOptions(backend)
    val current = if (backend == "claude") claudePermissionValue(selected) else selected
    Text("权限模式", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = Ink)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        options.forEach { option ->
            val isSelected = current == option.id
            val tint = if (option.risky) Danger else Accent
            Surface(
                Modifier.fillMaxWidth().clickable { choose(option.id) },
                shape = RoundedCornerShape(10.dp),
                color = if (isSelected) (if (option.risky) P.dangerContainer else P.selected) else Color.Transparent,
                border = BorderStroke(1.dp, if (isSelected) tint else Divider),
            ) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(option.label, color = if (option.risky || isSelected) tint else Ink, fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                        Text(option.detail, color = Muted, style = MaterialTheme.typography.bodySmall)
                    }
                    if (isSelected) Icon(Icons.Default.CheckCircle, null, Modifier.size(18.dp), tint = tint)
                }
            }
        }
    }
}

private val WaitingInk: Color get() = P.waitingInk

// The desktop is waiting on the user for this session — a tool permission, a
// question (single / multiple choice, or free "other" text) or a plan — with
// what it asks and the answer controls.
@Composable
private fun DesktopWaitingBanner(
    note: String,
    waiting: DesktopWaiting?,
    busy: Boolean,
    open: (() -> Unit)?,
    answer: (choice: String?, answers: List<QuestionAnswer>?, feedback: String?) -> Unit,
    readOptions: (() -> Unit)? = null,
) {
    var confirm by remember(waiting?.requestId) { mutableStateOf<String?>(null) }
    var reading by remember(waiting?.requestId) { mutableStateOf(false) }
    // A failed read reports its error; let the button come back for a retry.
    LaunchedEffect(reading) { if (reading) { delay(60_000); reading = false } }
    // Per question: picked labels, whether "other" is picked, and its text.
    val picked = remember(waiting?.requestId) { mutableStateMapOf<Int, Set<String>>() }
    val otherOn = remember(waiting?.requestId) { mutableStateMapOf<Int, Boolean>() }
    val otherText = remember(waiting?.requestId) { mutableStateMapOf<Int, String>() }
    var revising by remember(waiting?.requestId) { mutableStateOf(false) }
    var collapsed by remember(waiting?.requestId) { mutableStateOf(false) }
    // At most about half the screen, so the conversation stays visible.
    val bodyMaxHeight = (androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp * 0.42f).dp
    var feedback by remember(waiting?.requestId) { mutableStateOf("") }
    fun answerOf(index: Int) = QuestionAnswer(picked[index].orEmpty().toList(), if (otherOn[index] == true) otherText[index].orEmpty().trim() else "")
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        color = P.waitingContainer,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, P.waitingBorder),
    ) {
        Column(Modifier.padding(start = 12.dp, end = 2.dp, top = 2.dp, bottom = if (collapsed) 2.dp else 8.dp)) {
            // The header stays put; tapping it (or the chevron) folds the
            // prompt away so the conversation above can be read.
            Row(Modifier.fillMaxWidth().clickable { collapsed = !collapsed }, verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).background(P.waitingDot, CircleShape))
                Spacer(Modifier.width(8.dp))
                Text(
                    if (collapsed) waitingPreview(waiting) ?: note.ifBlank { "电脑端在等你处理" } else note.ifBlank { "电脑端在等你处理" },
                    Modifier.weight(1f), color = WaitingInk, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium,
                    maxLines = if (collapsed) 1 else 2, overflow = TextOverflow.Ellipsis,
                )
                if (!collapsed && open != null) TextButton(open) { Text("在电脑上打开", color = WaitingInk, style = MaterialTheme.typography.labelMedium) }
                IconButton({ collapsed = !collapsed }, Modifier.size(36.dp)) {
                    Icon(if (collapsed) Icons.Default.ExpandMore else Icons.Default.ExpandLess, if (collapsed) "展开提示" else "收起提示", tint = WaitingInk)
                }
            }
            if (!collapsed) Column(Modifier.padding(end = 4.dp).heightIn(max = bodyMaxHeight).verticalScroll(rememberScrollState())) {
            when (waiting?.kind) {
                "permission" -> {
                    Surface(Modifier.fillMaxWidth().padding(end = 6.dp, top = 2.dp), color = P.waitingPanel, shape = RoundedCornerShape(8.dp)) {
                        Column(Modifier.padding(10.dp)) {
                            Text(waiting.tool, color = WaitingInk, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
                            Text(waiting.summary, color = Ink, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 8, overflow = TextOverflow.Ellipsis)
                            if (waiting.description.isNotBlank() && waiting.description != waiting.summary) Text(waiting.description, color = Muted, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    if (waiting.answerable) WaitingActions(busy) {
                        OutlinedButton({ answer("deny", null, null) }, enabled = !busy, shape = RoundedCornerShape(10.dp)) { Text("拒绝") }
                        Button({ confirm = "allow" }, enabled = !busy, shape = RoundedCornerShape(10.dp)) { Text("允许一次") }
                    }
                    if (waiting.answerable && waiting.autoOption) TextButton({ confirm = "allow_auto" }, Modifier.align(Alignment.End), enabled = !busy) {
                        Text("允许并切到自动模式", color = WaitingInk, style = MaterialTheme.typography.labelMedium)
                    }
                }
                "question" -> {
                    waiting.questions.forEachIndexed { index, question ->
                        Text(question.question, Modifier.padding(top = 6.dp, end = 6.dp), color = Ink, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        if (question.multiSelect) Text("可多选", color = Muted, style = MaterialTheme.typography.labelSmall)
                        question.options.forEach { option ->
                            val selected = option.label in picked[index].orEmpty()
                            // "Choose <label>" is the desktop's filler, not a real description.
                            WaitingChoice(option.label, option.description.takeUnless { it.equals("Choose ${option.label}", ignoreCase = true) }.orEmpty(), selected, question.multiSelect, enabled = waiting.answerable && !busy) {
                                if (question.multiSelect) picked[index] = if (selected) picked[index].orEmpty() - option.label else picked[index].orEmpty() + option.label
                                else { picked[index] = setOf(option.label); otherOn[index] = false }
                            }
                        }
                        val otherSelected = otherOn[index] == true
                        if (question.allowOther) WaitingChoice("其他", "自己写答案", otherSelected, question.multiSelect, enabled = waiting.answerable && !busy) {
                            otherOn[index] = !otherSelected || !question.multiSelect
                            if (!question.multiSelect) picked[index] = emptySet()
                        }
                        if (otherSelected) OutlinedTextField(
                            otherText[index].orEmpty(), { otherText[index] = it },
                            Modifier.fillMaxWidth().padding(end = 6.dp, top = 6.dp),
                            placeholder = { Text("写下你的回答") }, shape = RoundedCornerShape(8.dp), enabled = !busy,
                        )
                    }
                    if (waiting.answerable) WaitingActions(busy) {
                        Button(
                            { answer(null, waiting.questions.indices.map(::answerOf), null) },
                            enabled = !busy && waiting.questions.indices.all { isCompleteAnswer(waiting.questions[it], answerOf(it)) },
                            shape = RoundedCornerShape(10.dp),
                        ) { Text("提交回答") }
                    }
                }
                "plan" -> {
                    if (waiting.summary.isNotBlank()) Surface(Modifier.fillMaxWidth().padding(end = 6.dp, top = 2.dp), color = SurfaceBase, shape = RoundedCornerShape(8.dp), border = BorderStroke(0.5.dp, Divider)) {
                        Box(Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()).padding(10.dp)) { KhLinkMarkdown(waiting.summary, modifier = Modifier.fillMaxWidth()) }
                    }
                    if (revising) OutlinedTextField(
                        feedback, { feedback = it },
                        Modifier.fillMaxWidth().padding(end = 6.dp, top = 6.dp),
                        placeholder = { Text("告诉 Claude 计划要怎么改") }, shape = RoundedCornerShape(8.dp), enabled = !busy, minLines = 2,
                    )
                    if (waiting.answerable) WaitingActions(busy) {
                        if (revising) {
                            TextButton({ revising = false }, enabled = !busy) { Text("取消") }
                            Button({ answer("revise", null, feedback.trim()) }, enabled = !busy && feedback.isNotBlank(), shape = RoundedCornerShape(10.dp)) { Text("发送修改意见") }
                        } else {
                            TextButton({ answer("reject", null, null) }, enabled = !busy) { Text("拒绝") }
                            OutlinedButton({ revising = true }, enabled = !busy, shape = RoundedCornerShape(10.dp)) { Text("修改") }
                            Button({ confirm = "accept" }, enabled = !busy, shape = RoundedCornerShape(10.dp)) { Text("接受") }
                        }
                    }
                    if (waiting.answerable && !revising) TextButton({ confirm = "accept_auto" }, Modifier.align(Alignment.End), enabled = !busy) {
                        Text("接受并切到自动模式", color = WaitingInk, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            // The computer is waiting but its choices are not known here yet (a
            // card in a session the desktop is not showing): read them from it.
            if (waiting == null && readOptions != null) Row(Modifier.padding(top = 4.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("选项在电脑上，读过来就能在手机上选", Modifier.weight(1f), color = Muted, style = MaterialTheme.typography.labelSmall)
                if (reading) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = WaitingInk)
                else TextButton({ reading = true; readOptions() }) { Text("读取选项", color = WaitingInk, style = MaterialTheme.typography.labelMedium) }
            }
            // Answering switches the desktop to this session for a moment.
            if (waiting?.answerable == true && open != null) Text(
                "回答时电脑上会短暂切到这个会话，点完自动切回你原来在看的会话",
                Modifier.padding(top = 6.dp, end = 6.dp),
                color = Muted,
                style = MaterialTheme.typography.labelSmall,
            ) else if (waiting?.phoneCanAnswer == false) Text(
                "这个问题在电脑上的 Codex 里，需要到电脑上回答",
                Modifier.padding(top = 6.dp, end = 6.dp),
                color = Muted,
                style = MaterialTheme.typography.labelSmall,
            )
            }
        }
    }
    if (confirm != null && waiting != null) {
        val choice = confirm!!
        val (title, body) = when (choice) {
            "allow" -> "在电脑上允许执行？" to "只允许这一次：\n${waiting.tool}\n${waiting.summary}"
            "allow_auto" -> "允许并切到自动模式？" to "允许这一次：\n${waiting.tool}\n${waiting.summary}\n\n之后这个会话切到自动模式，由自动审核决定，不再逐个问你。"
            "accept_auto" -> "接受计划并切到自动模式？" to "Claude 会按计划开始执行，之后的操作不再逐个询问你。"
            else -> "接受这个计划？" to "Claude 会按计划开始执行，需要批准的操作仍会先问你。"
        }
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(title) },
            text = {
                Surface(Modifier.fillMaxWidth(), color = P.planBody, shape = RoundedCornerShape(8.dp)) {
                    Text(body, Modifier.padding(10.dp).heightIn(max = 240.dp).verticalScroll(rememberScrollState()), style = MaterialTheme.typography.bodySmall, fontFamily = if (choice.startsWith("allow")) FontFamily.Monospace else FontFamily.Default)
                }
            },
            confirmButton = { Button({ confirm = null; answer(choice, null, null) }, shape = RoundedCornerShape(10.dp)) { Text(when (choice) { "allow" -> "允许一次"; "allow_auto" -> "允许并切换"; else -> "接受" }) } },
            dismissButton = { TextButton({ confirm = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun WaitingActions(busy: Boolean, content: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().padding(end = 6.dp, top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = WaitingInk)
        content()
    }
}

@Composable
private fun WaitingChoice(label: String, description: String, selected: Boolean, multi: Boolean, enabled: Boolean, toggle: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth().padding(end = 6.dp, top = 6.dp).clickable(enabled = enabled, onClick = toggle),
        color = if (selected) P.waitingSelected else SurfaceBase,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(if (selected) 1.5.dp else 0.5.dp, if (selected) P.waitingDot else Divider),
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (multi) (if (selected) Icons.Default.CheckBox else Icons.Default.CheckBoxOutlineBlank)
                else (if (selected) Icons.Default.RadioButtonChecked else Icons.Default.RadioButtonUnchecked),
                null, Modifier.size(18.dp), tint = if (selected) P.waitingDot else Muted,
            )
            Spacer(Modifier.width(8.dp))
            Column {
                Text(label, color = Ink, style = MaterialTheme.typography.bodySmall, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
                if (description.isNotBlank()) Text(description, color = Muted, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}


// ---- Claude Code (second agent backend) ----
// Fallback when the computer has not reported its catalogue yet.
private val ClaudeFallbackModels = listOf(ClaudeModel("opus", "Opus", AllClaudeEfforts), ClaudeModel("sonnet", "Sonnet", AllClaudeEfforts), ClaudeModel("haiku", "Haiku", emptyList()))
private val AllClaudeEfforts get() = listOf("low", "medium", "high", "xhigh", "max")
private fun catalogue(models: List<ClaudeModel>) = models.ifEmpty { ClaudeFallbackModels }
// "" = the desktop default (the catalogue's "default" row describes it).
private fun claudeModelOptions(models: List<ClaudeModel>): List<SettingOption> {
    val list = catalogue(models)
    val defaultLabel = list.firstOrNull { it.value == "default" }?.label ?: "默认"
    return listOf(SettingOption("", defaultLabel)) + list.filter { it.value != "default" }.map { SettingOption(it.value, it.label) }
}
// "claude-opus-5-5" -> "Opus 5.5" for ids the desktop stored that are not catalogue aliases.
private fun prettyClaudeModel(value: String): String {
    val m = Regex("^claude-([a-z]+)-(\\d+)(?:-(\\d+))?", RegexOption.IGNORE_CASE).find(value) ?: return value
    val family = m.groupValues[1].replaceFirstChar { it.uppercase() }
    return family + " " + m.groupValues[2] + (m.groupValues[3].takeIf { it.isNotBlank() }?.let { "." + it } ?: "") + (if (value.contains("[1m]", true)) " (1M)" else "")
}
private fun claudeModelLabel(value: String?, models: List<ClaudeModel>): String {
    val v = value.orEmpty()
    return claudeModelOptions(models).firstOrNull { it.id == v }?.label ?: prettyClaudeModel(v)
}
private fun claudeEffortsFor(model: String, models: List<ClaudeModel>): List<String> {
    val list = catalogue(models)
    return (list.firstOrNull { it.value == model.ifBlank { "default" } } ?: list.firstOrNull { it.value == "default" })?.efforts
        ?: if (models.isEmpty()) AllClaudeEfforts else emptyList()
}
private fun claudeEffortOptions(model: String, models: List<ClaudeModel>): List<SettingOption> =
    listOf(SettingOption("", "默认")) + claudeEffortsFor(model, models).map { SettingOption(it, reasoningEffortLabel(it)) }
private fun claudeEffortLabel(value: String?): String = if (value.isNullOrBlank()) "默认" else reasoningEffortLabel(value)
private fun claudeSettingsSummary(settings: ThreadSettings, models: List<ClaudeModel>): String {
    val model = settings.model?.ifBlank { null }?.let { shortModelName(claudeModelLabel(it, models)) } ?: "默认模型"
    val effort = settings.effort?.ifBlank { null }?.let(::reasoningEffortLabel) ?: "默认强度"
    val mode = permissionModeOptions("claude").firstOrNull { it.id == claudePermissionValue(settings.permissionMode) }?.label ?: "Manual"
    return "Claude · $model · $effort · $mode"
}

internal fun homeTabLabel(id: String, tabCount: Int) = when (id) {
    "claude" -> if (tabCount > 2) "Claude" else "Claude Code"
    "pi" -> "Pi"
    "antigravity" -> "反重力"
    "dsh" -> "DSH"
    "hermes" -> "Hermes"
    else -> "Codex"
}

private fun homeAgentStateLabel(state: HomeAgentState) = when (state) {
    HomeAgentState.Open -> "已开启"
    HomeAgentState.Closed -> "未开启"
    HomeAgentState.Unknown -> "检测中"
    HomeAgentState.Offline -> "电脑离线"
}

@Composable
private fun AgentVisibilityDialog(visible: Set<String>, order: List<String>, states: Map<String, HomeAgentState>, close: () -> Unit, save: (List<String>) -> Unit) {
    var chosen by remember(visible, order) {
        mutableStateOf(normalizeHomeAgentOrder(order.filter { it in visible } + HOME_AGENT_IDS.filter { it in visible && it !in order }))
    }
    fun move(id: String, step: Int) {
        val index = chosen.indexOf(id)
        val target = index + step
        if (index < 0 || target !in chosen.indices) return
        chosen = chosen.toMutableList().apply { add(target, removeAt(index)) }
    }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("显示与排序", fontWeight = FontWeight.Bold) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val defaults = DEFAULT_HOME_AGENT_ORDER.joinToString(" · ") { homeTabLabel(it, DEFAULT_HOME_AGENT_ORDER.size) }
                Text("最多显示 $MAX_HOME_AGENTS 个。勾选后可用 ↑ ↓ 调整标签顺序；默认 $defaults。", color = Muted, style = MaterialTheme.typography.bodySmall)
                (chosen + HOME_AGENT_IDS.filter { it !in chosen }).forEach { id ->
                    val checked = id in chosen
                    val canToggle = (checked && chosen.size > 1) || (!checked && chosen.size < MAX_HOME_AGENTS)
                    val state = states[id] ?: HomeAgentState.Unknown
                    Surface(
                        Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        color = if (checked) P.selected else SurfaceBase,
                        border = BorderStroke(1.dp, if (checked) Accent.copy(alpha = 0.45f) else Divider),
                    ) {
                        Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            AgentLogo(id, 28.dp, dimmed = state == HomeAgentState.Closed || state == HomeAgentState.Offline)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(homeTabLabel(id, 4), color = Ink, fontWeight = FontWeight.Medium)
                                Text(homeAgentStateLabel(state), color = if (state == HomeAgentState.Open) P.success else Muted, style = MaterialTheme.typography.labelSmall)
                            }
                            if (checked) {
                                Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).clickable(enabled = chosen.indexOf(id) > 0) { move(id, -1) }, contentAlignment = Alignment.Center) {
                                    Text("↑", color = if (chosen.indexOf(id) > 0) Ink else Divider, fontWeight = FontWeight.Bold)
                                }
                                Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).clickable(enabled = chosen.indexOf(id) < chosen.lastIndex) { move(id, 1) }, contentAlignment = Alignment.Center) {
                                    Text("↓", color = if (chosen.indexOf(id) < chosen.lastIndex) Ink else Divider, fontWeight = FontWeight.Bold)
                                }
                            }
                            Checkbox(
                                checked,
                                onCheckedChange = { enabled ->
                                    if (enabled && chosen.size < MAX_HOME_AGENTS) chosen = chosen + id
                                    else if (!enabled && chosen.size > 1) chosen = chosen - id
                                },
                                enabled = canToggle,
                            )
                        }
                    }
                }
                Text("至少保留一个 Agent。隐藏不会关闭电脑上的程序。", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        },
        dismissButton = { TextButton(close) { Text("取消") } },
        confirmButton = { Button({ save(chosen) }) { Text("保存") } },
    )
}

@Composable
private fun AgentClosedNote(id: String) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), color = SurfaceAlt) {
        Text(if (id == "hermes") "这台电脑上的 Hermes 没有响应（WSL 未启动或 hermes-gateway 没运行）。可查看已同步的历史，恢复后状态会自动更新。" else "电脑上的 ${homeTabLabel(id, 2)} 未开启。可查看已同步的历史，打开后状态会自动恢复。", Modifier.padding(12.dp), color = Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun BackendTabs(selected: String, tabs: List<String>, states: Map<String, HomeAgentState>, threads: List<ThreadSummary>, liveStatuses: Map<String, String>, settings: () -> Unit, choose: (String) -> Unit) {
    // Per tab: how many wait for you and how many have something new.
    fun ofTab(id: String) = threads.filter { backendTab(it.backend) == id }
    fun waitingIn(id: String) = ofTab(id).count { isWaitingThreadStatus(liveStatuses[it.id] ?: it.status) }
    fun unreadIn(id: String) = ofTab(id).count { homeTabHasUnread(it, liveStatuses[it.id] ?: it.status) }
    fun unavailable(id: String) = states[id] in setOf(HomeAgentState.Closed, HomeAgentState.Offline)
    val haptics = rememberHaptics()
    val selectedIndex = tabs.indexOf(selected).coerceAtLeast(0)
    // Logos only (asked 2026-11-01): the logo says which agent it is. One
    // segmented track; a raised thumb slides to the chosen agent, and the
    // amber (waiting for you) or unread dot sits on the logo's corner.
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
    androidx.compose.foundation.layout.BoxWithConstraints(
        Modifier.weight(1f).height(36.dp).background(SurfaceAlt.copy(alpha = 0.75f), RoundedCornerShape(11.dp)).padding(3.dp),
    ) {
        val tabWidth = maxWidth / tabs.size
        val slide by androidx.compose.animation.core.animateDpAsState(tabWidth * selectedIndex, KhMotion.slide(), label = "tab-slide")
        Box(
            Modifier.offset(x = slide).width(tabWidth).fillMaxHeight()
                .shadow(1.dp, RoundedCornerShape(8.dp), clip = false)
                .background(SurfaceBase, RoundedCornerShape(8.dp))
                .border(0.5.dp, Divider, RoundedCornerShape(8.dp)),
        )
        Row(Modifier.fillMaxSize()) {
            tabs.forEach { id ->
                val isSelected = selected == id
                val waitingCount = waitingIn(id); val unreadCount = unreadIn(id)
                val count = ofTab(id).size
                val logoScale by animateFloatAsState(if (isSelected) 1f else 0.88f, KhMotion.pop(), label = "tab-logo")
                Box(
                    Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp))
                        .clickable { if (!isSelected) { haptics.tick(); choose(id) } }
                        .semantics {
                            contentDescription = buildString {
                                append(homeTabLabel(id, 3)); append("，$count 个会话")
                                if (waitingCount > 0) append("，$waitingCount 个等你处理")
                                if (unreadCount > 0) append("，$unreadCount 个未读")
                                if (unavailable(id)) append("，电脑上未开启")
                                if (isSelected) append("，当前")
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    // The dot sits outside the faded logo's layer: a layer with
                    // alpha is drawn offscreen at the logo's size, which cut the
                    // corner dot of every unselected tab in half.
                    Box {
                        Box(Modifier.graphicsLayer { scaleX = logoScale; scaleY = logoScale; alpha = if (isSelected || unavailable(id)) 1f else 0.82f }) {
                            AgentLogo(id, 20.dp, dimmed = unavailable(id))
                        }
                        val dot = when { waitingCount > 0 -> P.waitingDot; unreadCount > 0 -> if (id == "claude") P.unreadClaude else P.unreadCodex; else -> null }
                        androidx.compose.animation.AnimatedVisibility(dot != null, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-4).dp), enter = fadeIn(tween(140)) + scaleIn(KhMotion.pop(), initialScale = 0.5f), exit = fadeOut(tween(120))) {
                            Box(Modifier.size(10.dp).background(SurfaceBase, CircleShape).padding(1.5.dp).background(dot ?: Color.Transparent, CircleShape))
                        }
                    }
                }
            }
        }
    }
        IconButton(settings, Modifier.size(40.dp)) {
            Icon(Icons.Default.Settings, "选择显示的 Agent", Modifier.size(18.dp), tint = Muted)
        }
    }
}

// ---- Chat-app layout (the WeChat-like theme) ----

/** Sessions of a tab that want attention: waiting for you, unread, or just finished. */
private fun attentionCount(threads: List<ThreadSummary>, liveStatuses: Map<String, String>, tab: String): Int =
    threads.count { thread ->
        val status = liveStatuses[thread.id] ?: thread.status
        backendTab(thread.backend) == tab && !thread.archived &&
            (isWaitingThreadStatus(status) || wantsRedDot(thread, status))
    }

/** A red count badge (a dot when there is no number to show). */
@Composable
private fun ChatBadge(count: Int, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Box(
        modifier.heightIn(min = 17.dp).widthIn(min = 17.dp).background(P.danger, RoundedCornerShape(50)).padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (count > 99) "···" else count.toString(), color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Medium, maxLines = 1, lineHeight = 12.sp)
    }
}

/** Square avatar standing for an agent: its logo. */
@Composable
private fun ChatAvatar(backend: String, size: Int = 48) = AgentLogo(backend, size.dp)

/** The other side of the open conversation, as a contact: this session's own avatar. */
@Composable
private fun ChatPeerAvatar(size: Int = 40) {
    val peer = LocalChatPeer.current
    if (peer == null) ChatAvatar(LocalAgentBackend.current, size)
    else SessionAvatar(peer.first, peer.second, size.dp)
}

/** An agent's logo as a rounded tile (Codex, Claude Code, Pi, Antigravity). */
@Composable
private fun AgentLogo(backend: String, size: androidx.compose.ui.unit.Dp, dimmed: Boolean = false, dimAlpha: Float = 0.45f) {
    val (image, name) = when (backendTab(backend)) {
        "claude" -> R.drawable.agent_claude to "Claude"
        "pi" -> R.drawable.agent_pi to "Pi"
        "antigravity" -> R.drawable.agent_antigravity to "反重力"
        "dsh" -> R.drawable.agent_dsh to "DeepSeek"
        "hermes" -> R.drawable.agent_hermes to "Hermes"
        else -> R.drawable.agent_codex to "Codex"
    }
    val shape = RoundedCornerShape(size * 0.22f)
    Image(
        painterResource(image), name,
        // A hairline keeps a white tile (Antigravity) apart from a white card.
        Modifier.size(size).clip(shape).border(0.5.dp, Divider, shape),
        contentScale = ContentScale.Fit,
        colorFilter = if (dimmed) ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }) else null,
        alpha = if (dimmed) dimAlpha else 1f,
    )
}

/** A chat-list row with a round tick in front while choosing several. */
@Composable
private fun SelectableChatRow(selecting: Boolean, selected: Boolean, dim: Boolean = false, toggle: () -> Unit, row: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().background(SurfaceBase), verticalAlignment = Alignment.CenterVertically) {
        AnimatedVisibility(selecting, enter = expandHorizontally() + fadeIn(), exit = shrinkHorizontally() + fadeOut()) {
            Box(Modifier.padding(start = 14.dp).size(24.dp).clip(CircleShape).clickable(onClick = toggle)
                .background(if (selected) Accent else Color.Transparent, CircleShape)
                .border(1.5.dp, if (selected) Accent else Muted.copy(alpha = 0.6f), CircleShape)
                .semantics { contentDescription = if (selected) "已选" else "未选" },
                contentAlignment = Alignment.Center) {
                if (selected) Icon(Icons.Default.Check, null, Modifier.size(16.dp), tint = Color.White)
            }
        }
        // An archived session is dimmed; its tick stays clear.
        Box(Modifier.weight(1f).graphicsLayer { alpha = if (dim) 0.6f else 1f }) { row() }
    }
}

/** The bar that replaces the bottom tabs while choosing: cancel, the count, and the action. */
@Composable
private fun ChatSelectionBar(count: Int, action: String, cancel: () -> Unit, act: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(P.surfaceAlt).navigationBarsPadding()) {
        HorizontalDivider(color = Divider)
        Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(cancel) { Text("取消", color = Ink) }
            Text("已选 $count 个", Modifier.weight(1f), textAlign = TextAlign.Center, color = Muted, fontSize = 14.sp)
            Button(act, enabled = count > 0, shape = RoundedCornerShape(4.dp), colors = ButtonDefaults.buttonColors(containerColor = Accent)) {
                Icon(Icons.Default.Archive, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(action)
            }
        }
    }
}

/** A plain icon per agent for the bottom bar. */

private val ChatTabIconSize = 25.dp

/** Bottom navigation: one entry per agent, plus "我" for the account. */
@Composable
private fun ChatBottomTabs(selected: String, tabs: List<String>, states: Map<String, HomeAgentState>, threads: List<ThreadSummary>, liveStatuses: Map<String, String>, choose: (String) -> Unit, settings: () -> Unit, openMe: () -> Unit) {
    val haptics = rememberHaptics()
    Column(Modifier.fillMaxWidth().background(P.surfaceAlt).navigationBarsPadding()) {
        HorizontalDivider(color = Divider)
        // The bottom bar keeps navigation-bar insets outside this compact
        // 48dp content row. Icons only, one size, each centered in an equal
        // slot, so they sit on one line; the name is read out, not shown.
        // A closed agent is dimmed, so state changes never change the height.
        Row(Modifier.fillMaxWidth().height(48.dp)) {
            (tabs + "settings" + "me").forEach { id ->
                if (id == "settings") {
                    Box(
                        Modifier.weight(1f).fillMaxHeight().clickable { haptics.tick(); settings() },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Outlined.Settings, "选择显示的 Agent", Modifier.size(ChatTabIconSize), tint = Muted) }
                    return@forEach
                }
                val active = id == selected
                val state = states[id] ?: HomeAgentState.Unknown
                val unavailable = id != "me" && state in setOf(HomeAgentState.Closed, HomeAgentState.Offline)
                val tint = if (unavailable) Muted else if (active) Accent else Ink
                val scale by animateFloatAsState(if (active) 1f else 0.9f, KhMotion.pop(), label = "chat-tab-logo")
                Box(
                    Modifier.weight(1f).fillMaxHeight().clickable {
                        haptics.tick()
                        if (id == "me") openMe() else if (!active) choose(id)
                    },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.semantics(mergeDescendants = true) { contentDescription = if (id == "me") "我" else homeTabLabel(id, 3) + if (active) "，当前" else "" }) {
                        // The agents by their logos (2026-11-01): in color when open,
                        // gray when not, fainter still when it is closed on the computer.
                        if (id == "me") Icon(if (active) Icons.Filled.Person else Icons.Outlined.Person, null, Modifier.size(ChatTabIconSize), tint = tint)
                        else Box(Modifier.graphicsLayer { scaleX = scale; scaleY = scale }) { AgentLogo(id, 24.dp, dimmed = !active || unavailable, dimAlpha = if (unavailable) 0.3f else 0.6f) }
                        if (id != "me") ChatBadge(attentionCount(threads, liveStatuses, id), Modifier.align(Alignment.TopEnd).offset(x = 10.dp, y = (-6).dp))
                    }
                }
            }
        }
    }
}

/**
 * A session as a chat-list row: avatar, title and time, then one gray line
 * with the state in brackets, as a chat app shows "[草稿]".
 */
/** The thread list's status light: breathing while running or waiting, lit when finished. */
private val DoneDotGreen = Color(0xFF22D35E)

@Composable
private fun ThreadStatusLight(running: Boolean, waiting: Boolean, failed: Boolean = false, unknown: Boolean = false) {
    val label = when { waiting -> "等你处理"; running -> "运行中"; failed -> "运行失败"; unknown -> "状态待确认"; else -> "已完成" }
    Box(Modifier.semantics { contentDescription = label }) {
        when {
            waiting -> BreathingDot(P.waitingDot, 9.dp)
            running -> BreathingDot(P.warm, 9.dp)
            failed -> Box(Modifier.size(9.dp).background(P.danger, CircleShape))
            unknown -> Box(Modifier.size(9.dp).background(Muted, CircleShape))
            // Done: a vivid green, brighter than the theme's text green.
            else -> Box(Modifier.size(9.dp).background(DoneDotGreen, CircleShape))
        }
    }
}

@Composable
private fun ChatThreadRow(thread: ThreadSummary, status: String, onLongPress: (() -> Unit)? = null, gray: Boolean = thread.pinned, open: () -> Unit) {
    val running = isRunningStatus(status)
    val waiting = isWaitingThreadStatus(status)
    val unknown = isUnknownThreadStatus(status)
    val finished = !running && !waiting && isFinishedHighlight(thread, status)
    val returned = LocalReturnedThreadId.current == thread.id
    val flash by animateColorAsState(if (returned) Color(0x14000000) else Color.Transparent, tween(if (returned) 260 else 900), label = "chat-row-return")
    val background = if (gray) P.surfaceAlt else SurfaceBase
    val rowInteraction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    Column(Modifier.fillMaxWidth().pressScale(rowInteraction, 0.985f).background(background).background(flash)
        .combinedClickable(interactionSource = rowInteraction, indication = LocalIndication.current, onLongClick = onLongPress, onClick = open)) {
        // Modeled on WeChat's list (measured 2026-10-22: 42 dp avatar, rows
        // about 63 dp apart), made tighter on 2026-11-01: a 38 dp avatar and
        // rows about 55 dp apart, the divider still starting under the title.
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 8.5.dp, bottom = 8.5.dp), verticalAlignment = Alignment.CenterVertically) {
            Box {
                SessionAvatar(thread.id, thread.title, 38.dp)
                when {
                    waiting -> ChatBadge(1, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp))
                    wantsRedDot(thread, status) -> Box(Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-4).dp).size(10.dp).background(P.danger, CircleShape))
                }
            }
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // WeChat marks a pinned chat by its shaded row, not an icon.
                    Text(thread.title.ifBlank { "未命名任务" }, Modifier.weight(1f).semantics { if (thread.pinned) contentDescription = "${thread.title} 已置顶" }, color = Ink, fontSize = 15.5.sp, lineHeight = 19.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.width(8.dp))
                    Text(wechatListTime(thread.updatedAt), color = Color(0xFFB2B2B2), fontSize = 12.sp, maxLines = 1)
                }
                Spacer(Modifier.height(1.dp))
                val waitingLine = if (waiting) waitingPreview(thread.waiting) ?: thread.note else ""
                val failed = status.contains("failed", true)
                // The folder by its name, as a chat app shows a short preview line.
                val line = if (unknown) "状态待确认" else waitingLine.ifBlank { thread.cwd.trimEnd('\\', '/').substringAfterLast('\\').substringAfterLast('/').ifBlank { thread.cwd } }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (waiting || running || finished || failed || unknown) {
                        ThreadStatusLight(running, waiting, failed, unknown)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(line, color = Color(0xFF999999), fontSize = 13.sp, lineHeight = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        HorizontalDivider(Modifier.padding(start = 63.dp), color = Divider, thickness = 0.5.dp)
    }
}

// Measured on ColorOS: once KH Link leaves the screen the whole process is
// paused (no thread runs, the connection's heartbeat stops) unless the app may
// run in the background. Then no "done" reminder comes and queued messages
// wait until the app is opened again. Say so, with the two settings to change;
// the card goes away once the phone lets KH Link run.
// True inside the guide's theme preview: notes that ask for something (here
// background running) belong to a later guide step, not to choosing colors.
internal val LocalThemePreview = staticCompositionLocalOf { false }

@Composable
private fun BackgroundRunNote() {
    if (LocalThemePreview.current) return
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("background-note", android.content.Context.MODE_PRIVATE) }
    val power = remember { context.getSystemService(android.os.PowerManager::class.java) }
    fun allowed() = runCatching { power?.isIgnoringBatteryOptimizations(context.packageName) == true }.getOrDefault(true)
    var ok by remember { mutableStateOf(allowed()) }
    var hidden by remember { mutableStateOf(prefs.getBoolean("hidden", false)) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) ok = allowed() }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    if (ok || hidden) return
    Surface(Modifier.fillMaxWidth().padding(bottom = 8.dp), color = P.surfaceHigh, shape = RoundedCornerShape(12.dp), border = BorderStroke(0.5.dp, Warm.copy(alpha = 0.6f))) {
        Column(Modifier.padding(12.dp)) {
            Text("手机会在后台暂停 khLink", fontWeight = FontWeight.SemiBold, color = Ink, style = MaterialTheme.typography.bodyMedium)
            Text("离开 khLink 后收不到「已完成」提醒，排队的消息也要等再打开才发。请允许它在后台运行；ColorOS 还需要在应用设置的「耗电管理」里打开「允许后台行为」。",
                color = Muted, style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton({ prefs.edit().putBoolean("hidden", true).apply(); hidden = true }) { Text("不再提示", color = Muted) }
                TextButton({
                    runCatching { context.startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }) { Text("应用设置") }
                TextButton({
                    runCatching {
                        @Suppress("BatteryLife")
                        context.startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }.onFailure { runCatching { context.startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
                }) { Text("允许后台运行") }
            }
        }
    }
}

// Antigravity: messages from the phone are put into its window on the computer.
@Composable
private fun AntigravityNote() {
    Surface(Modifier.fillMaxWidth().padding(bottom = 8.dp), color = P.surfaceHigh, shape = RoundedCornerShape(12.dp), border = BorderStroke(0.5.dp, Divider)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("反重力", fontWeight = FontWeight.SemiBold, color = Ink, style = MaterialTheme.typography.bodyMedium)
                Text("电脑保持反重力打开，即可在这里同步对话、发送文字和停止任务。新建会话、模型设置和文件附件请在电脑端操作。", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun DshEmptyState(connection: ConnectionState) {
    Column(Modifier.fillMaxWidth().padding(vertical = 80.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("还没有 DeepSeek Harness 会话", fontWeight = FontWeight.SemiBold)
        Text("已有会话会自动同步到这里", color = Muted, style = MaterialTheme.typography.bodySmall)
        if (connection == ConnectionState.Online) Text("也可以在右下角新建一个会话", color = Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun PiEmptyState(connection: ConnectionState, start: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 80.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("还没有 Pi 会话", fontWeight = FontWeight.SemiBold)
        Text("Pi 会话来自电脑上的 PI WEB；它没运行时可以在这里启动", color = Muted, style = MaterialTheme.typography.bodySmall)
        if (connection == ConnectionState.Online) Button(start, shape = RoundedCornerShape(10.dp)) { Text("启动 PI WEB") }
    }
}

// Pi: model (grouped by provider, as PI WEB offers them) and thinking level.
@Composable
private fun PiSettingsDialog(vm: BridgeViewModel, threadId: String, close: () -> Unit) {
    var choice by remember { mutableStateOf<PiModelChoice?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var model by remember { mutableStateOf("") }
    var level by remember { mutableStateOf("") }
    LaunchedEffect(threadId) {
        runCatching { vm.piModels(threadId) }
            .onSuccess { choice = it; model = it.current; level = it.thinkingLevel }
            .onFailure { failure = it.message ?: "读取失败" }
    }
    val loaded = choice
    SettingsSheet(
        title = "Pi 模型与思考强度",
        subtitle = loaded?.let { l -> l.models.firstOrNull { it.key == l.current }?.name?.let { "当前：$it · ${piThinkingLabel(l.thinkingLevel)}" } },
        close = close,
        saveEnabled = loaded != null && model.isNotBlank(),
        save = { vm.piSettings(threadId, model, level); close() },
    ) {
        // Picking a model keeps the thinking level only when the model can use it; a model that
        // does not reason is set to "off", and an unknown level stays unknown.
        val choose: (PiModel) -> Unit = { picked ->
            model = picked.key
            level = when {
                !picked.reasoning -> "off"
                level.isBlank() -> level
                else -> piNearestThinkingLevel(level, piThinkingLevelsFor(picked, choice?.thinkingLevels.orEmpty()))
            }
        }
        when {
            failure != null -> SheetNote(failure.orEmpty(), SheetTone.Danger)
            loaded == null -> SheetLoading("正在读取 PI WEB 的模型…")
            else -> {
                // Only the levels the chosen model can use: a model that does not reason has just "off".
                val chosenModel = loaded.models.firstOrNull { it.key == model }
                val levels = piThinkingLevelsFor(chosenModel, loaded.thinkingLevels)
                if (levels.isNotEmpty()) SheetSection("思考强度") {
                    SheetSegments(levels.map { SheetOption(it, piThinkingLabel(it)) }, level) { level = it }
                    if (chosenModel?.reasoning == false) { Spacer(Modifier.height(6.dp)); SheetNote("这个模型不支持思考，强度固定为关闭") }
                }
                // The provider of the model in use first, so the choice is in view without scrolling.
                val current = loaded.models.firstOrNull { it.key == loaded.current }?.provider
                loaded.models.groupBy { it.provider }.entries.sortedBy { if (it.key == current) 0 else 1 }.forEach { (provider, models) ->
                    SheetSection(provider, "${models.size} 个模型") {
                        SheetOptionList(
                            models.map { item -> SheetOption(item.key, item.name, if (item.contextWindow > 0) "上下文 ${item.contextWindow / 1000}K" + if (item.reasoning) " · 支持思考" else "" else "") },
                            model,
                        ) { key -> models.firstOrNull { it.key == key }?.let(choose) }
                    }
                }
            }
        }
    }
}

// Pi relay providers: PI WEB's own provider manager, driven from the phone.
@Composable
private fun PiProvidersDialog(vm: BridgeViewModel, close: () -> Unit) {
    var providers by remember { mutableStateOf<List<PiProvider>?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<PiProvider?>(null) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(reload) {
        failure = null
        runCatching { vm.piProviders() }.onSuccess { providers = it }.onFailure { failure = it.message ?: "读取失败" }
    }
    editing?.let { current -> PiProviderEditDialog(vm, current, { editing = null }) { editing = null; reload++ } }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("Pi 设置", fontWeight = FontWeight.Bold, color = Ink) },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("中转服务商保存在电脑上的 Pi 配置里。API Key 只能写入，手机上看不到已保存的 Key。", color = Muted, style = MaterialTheme.typography.bodySmall)
                val list = providers
                when {
                    failure != null -> Text(failure.orEmpty(), color = Danger, style = MaterialTheme.typography.bodySmall)
                    list == null -> Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)); Text("正在读取…", color = Muted) }
                    else -> list.forEach { provider ->
                        Surface(Modifier.fillMaxWidth().clickable { editing = provider }, shape = RoundedCornerShape(12.dp), color = SurfaceBase, border = BorderStroke(0.5.dp, Divider)) {
                            Column(Modifier.padding(12.dp)) {
                                Text(provider.name.ifBlank { provider.id }, fontWeight = FontWeight.SemiBold, color = Ink)
                                Text(provider.baseUrl, color = Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("${PI_API_TYPES.firstOrNull { it.first == provider.api }?.second ?: provider.api} · ${provider.models.size} 个模型 · " + if (provider.hasKey) "已保存 Key" else "未填 Key",
                                    color = if (provider.hasKey) Muted else Danger, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
                TextButton({ editing = PiProvider("", "", "https://", "openai-completions", false, listOf(PiProviderModel("")), "") }) { Text("＋ 新增中转服务商") }
            }
        },
        confirmButton = { TextButton(close) { Text("完成") } },
    )
}

@Composable
private fun PiProviderEditDialog(vm: BridgeViewModel, original: PiProvider, close: () -> Unit, saved: () -> Unit) {
    val isNew = original.revision.isBlank()
    var name by remember { mutableStateOf(original.name) }
    var baseUrl by remember { mutableStateOf(original.baseUrl) }
    var api by remember { mutableStateOf(original.api.ifBlank { "openai-completions" }) }
    var apiKey by remember { mutableStateOf("") }
    var models by remember { mutableStateOf(original.models.ifEmpty { listOf(PiProviderModel("")) }) }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) close() },
        title = { Text(if (isNew) "新增中转服务商" else "编辑 ${original.name.ifBlank { original.id }}", fontWeight = FontWeight.Bold, color = Ink) },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("名称") }, singleLine = true, shape = RoundedCornerShape(10.dp))
                OutlinedTextField(baseUrl, { baseUrl = it }, Modifier.fillMaxWidth(), label = { Text("Base URL") }, singleLine = true, shape = RoundedCornerShape(10.dp))
                Text("接口类型", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = Ink)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PI_API_TYPES.forEach { (id, label) ->
                        val chosen = api == id
                        Surface(Modifier.clickable { api = id }, shape = RoundedCornerShape(50), color = if (chosen) P.selected else Color.Transparent, border = BorderStroke(0.5.dp, if (chosen) Accent else Divider)) {
                            Text(label, Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = if (chosen) Accent else Ink, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                OutlinedTextField(apiKey, { apiKey = it }, Modifier.fillMaxWidth(), singleLine = true, shape = RoundedCornerShape(10.dp),
                    label = { Text(if (original.hasKey) "API Key（已保存，留空保持原值）" else "API Key") },
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                Text("模型（价格单位：美元 / 百万 token）", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = Ink)
                models.forEachIndexed { index, model ->
                    fun update(next: PiProviderModel) { models = models.toMutableList().also { it[index] = next } }
                    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), color = P.surfaceHigh) {
                        Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(model.id, { update(model.copy(id = it)) }, Modifier.weight(1f), label = { Text("模型标识") }, singleLine = true)
                                if (models.size > 1) IconButton({ models = models.toMutableList().also { it.removeAt(index) } }) { Icon(Icons.Default.Close, "删除模型", tint = Muted) }
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                OutlinedTextField(model.inputCost, { update(model.copy(inputCost = it)) }, Modifier.weight(1f), label = { Text("输入价") }, singleLine = true)
                                OutlinedTextField(model.outputCost, { update(model.copy(outputCost = it)) }, Modifier.weight(1f), label = { Text("输出价") }, singleLine = true)
                                OutlinedTextField(model.contextWindow, { update(model.copy(contextWindow = it)) }, Modifier.weight(1f), label = { Text("上下文") }, singleLine = true)
                            }
                        }
                    }
                }
                TextButton({ models = models + PiProviderModel("") }) { Text("＋ 添加模型") }
                failure?.let { Text(it, color = Danger, style = MaterialTheme.typography.bodySmall) }
            }
        },
        dismissButton = { TextButton(close, enabled = !busy) { Text("取消", color = Muted) } },
        confirmButton = {
            Button({
                busy = true; failure = null
                val provider = original.copy(id = if (isNew) piProviderId(name) else original.id, name = name, baseUrl = baseUrl, api = api, models = models)
                scope.launch {
                    runCatching { vm.savePiProvider(provider, apiKey) }
                        .onSuccess { apiKey = ""; saved() }
                        .onFailure { failure = it.message ?: "保存失败"; busy = false }
                }
            }, enabled = !busy && name.isNotBlank() && baseUrl.isNotBlank() && models.any { it.id.isNotBlank() } && (!isNew || apiKey.isNotBlank()),
                shape = RoundedCornerShape(10.dp)) { Text(if (busy) "保存中…" else "保存") }
        },
    )
}

private fun piThinkingLabel(level: String): String = when (level) {
    "off" -> "关闭"; "minimal" -> "最低"; "low" -> "低"; "medium" -> "中"; "high" -> "高"; "xhigh" -> "极高"; "max" -> "最高"; else -> level
}

@Composable
private fun ClaudeEmptyState(connection: ConnectionState, create: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 80.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("还没有 Claude Code 任务", fontWeight = FontWeight.SemiBold)
        Text(if (connection == ConnectionState.Online) "在电脑上用本机已登录的 Claude Code 执行" else "电脑离线，连接后才能新建", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
        if (connection == ConnectionState.Online) Button(create, shape = RoundedCornerShape(10.dp)) { Text("新建 Claude 任务") }
    }
}

@Composable
private fun DshAnswerDialog(pending: DshPending?, loading: Boolean, close: () -> Unit, answer: (String) -> Unit) {
    AlertDialog(
        onDismissRequest = close,
        title = {
            Text(
                if (pending?.kind == "approval") "DSH 桌面端等待审批" else "DSH 桌面端等待回答",
                fontWeight = FontWeight.Bold, color = Ink,
            )
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when {
                    loading -> Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("正在读取 DSH 桌面端…", color = Muted, style = MaterialTheme.typography.bodySmall)
                    }
                    pending == null -> Text("桌面端现在没有等待回答的问题或审批。", color = Muted, style = MaterialTheme.typography.bodySmall)
                    else -> {
                        if (pending.prompt.isNotBlank()) Text(pending.prompt, color = Ink, style = MaterialTheme.typography.bodyMedium)
                        pending.options.forEach { option ->
                            OutlinedButton(
                                onClick = { answer(option) },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(option, color = Ink) }
                        }
                        Text("会直接点按已经打开的 DSH 桌面窗口；请保持 DSH 在最前。", color = Muted, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(close) { Text("关闭", color = Muted) } },
    )
}

@Composable
private fun DshSettingsDialog(current: ThreadSettings, catalog: DshCatalog?, close: () -> Unit, title: String = "DeepSeek Harness 设置", loading: String = "正在读取 DSH 模型…", save: (String, String, String) -> Unit) {
    var model by remember(current.model, catalog) {
        mutableStateOf(current.model?.takeIf { catalog?.model(it) != null } ?: catalog?.defaultKey ?: catalog?.models?.firstOrNull()?.key ?: "")
    }
    val selected = catalog?.model(model)
    val efforts = selected?.efforts.orEmpty()
    var effort by remember(current.effort, model, catalog) {
        mutableStateOf(current.effort?.takeIf { value -> efforts.any { it.id == value } }
            ?: selected?.defaultEffort?.takeIf { value -> efforts.any { it.id == value } }
            ?: efforts.firstOrNull()?.id.orEmpty())
    }
    val permissionOptions = catalog?.permissions.orEmpty()
    var permission by remember(current.permissionMode, catalog) {
        mutableStateOf(current.permissionMode.takeIf { value -> permissionOptions.any { it.value == value } }
            ?: catalog?.defaultPermission?.takeIf { value -> permissionOptions.any { it.value == value } }
            ?: permissionOptions.firstOrNull()?.value.orEmpty())
    }
    LaunchedEffect(model, catalog) {
        if (efforts.isNotEmpty() && efforts.none { it.id == effort }) {
            effort = selected?.defaultEffort?.takeIf { value -> efforts.any { it.id == value } } ?: efforts.first().id
        }
    }
    val currentModel = current.model?.let { raw -> catalog?.model(raw) ?: catalog?.models?.firstOrNull { it.id == raw } }
    val currentEffort = currentModel?.efforts?.firstOrNull { it.id == current.effort }?.name ?: current.effort?.ifBlank { null }
    val currentLabel = listOfNotNull(
        currentModel?.name ?: current.model?.ifBlank { null },
        currentEffort,
        permissionOptions.firstOrNull { o -> o.value == current.permissionMode }?.let(::dshPermissionLabel),
    )
    SettingsSheet(
        title = title,
        subtitle = currentLabel.takeIf { it.isNotEmpty() }?.joinToString(" · ", prefix = "当前："),
        close = close,
        saveEnabled = catalog != null && model.isNotBlank(),
        save = { save(model, effort, permission) },
    ) {
        if (catalog == null) {
            SheetLoading(loading)
        } else {
            // The short choices first: the model list can be long.
            if (efforts.isNotEmpty()) SheetSection("思考强度") {
                SheetSegments(efforts.map { SheetOption(it.id, it.name) }, effort) { effort = it }
            }
            if (permissionOptions.isNotEmpty()) SheetSection("权限模式") {
                SheetOptionList(
                    permissionOptions.map { SheetOption(it.value, dshPermissionLabel(it), dshPermissionDetail(it), risky = it.value == "danger-full-access") },
                    permission,
                ) { permission = it }
            }
            catalog.models.groupBy { it.providerName }.forEach { (provider, models) ->
                SheetSection(provider.ifBlank { "模型" }, if (models.size > 1) "${models.size} 个模型" else null) {
                    SheetOptionList(models.map { SheetOption(it.key, it.name, it.id.takeIf { id -> id != it.name }.orEmpty()) }, model) { model = it }
                }
            }
            SheetNote(
                if (permissionOptions.isNotEmpty()) "权限切换立即生效，正在执行的操作由 DSH 按新权限继续或拦截；模型和强度下一轮生效。"
                else "模型和强度下一轮生效；正在运行的这一轮不受影响。",
            )
        }
    }
}

private fun dshPermissionLabel(option: DshPermissionOption): String = when (option.value) {
    "read-only" -> "只读"
    "workspace-write" -> "工作区可写"
    "danger-full-access" -> "完全权限"
    "auto" -> "自动审查"
    else -> option.name
}

private fun dshPermissionDetail(option: DshPermissionOption): String = when (option.value) {
    "read-only" -> "只能读取，不能修改文件或执行有副作用的操作"
    "workspace-write" -> "可以修改工作区文件，敏感操作先询问"
    "danger-full-access" -> "不再询问，完全信任 DSH；风险最高"
    "auto" -> "由 DSH 自动审查按策略决定"
    else -> option.description.ifBlank { option.value }
}

@Composable
private fun ClaudeSettingsDialog(current: ThreadSettings, claudeModels: List<ClaudeModel>, desktopLive: Boolean, close: () -> Unit, save: (String, String, String) -> Unit) {
    var model by remember(current.model) { mutableStateOf(current.model.orEmpty()) }
    var effort by remember(current.effort) { mutableStateOf(current.effort.orEmpty()) }
    var permissionMode by remember(current.permissionMode) { mutableStateOf(claudePermissionValue(current.permissionMode)) }
    SettingsSheet(
        title = "Claude Code 设置",
        subtitle = "当前：" + claudeSettingsSummary(current, claudeModels).removePrefix("Claude · "),
        close = close,
        saveEnabled = true,
        save = { save(model, effort, permissionMode) },
    ) {
        // A model or effort chosen while the desktop runs a turn is kept until that turn ends.
        if (current.pendingDesktop) SheetNote("待生效：电脑上正在运行，模型和强度会在下一条消息发出前切换", SheetTone.Waiting)
        val modelOptions = claudeModelOptions(claudeModels).distinctBy { it.id }
        // The desktop may store a full id ("claude-opus-5-5") where the list has its alias.
        val shownModel = modelOptions.firstOrNull { it.id == model }?.id
            ?: modelOptions.firstOrNull { it.id.isNotBlank() && it.label == prettyClaudeModel(model) }?.id
            ?: model
        SheetSection("模型") {
            SheetOptionList(modelOptions.map { option ->
                // "默认 · Use the default model (currently …)" -> title and detail.
                val title = option.label.substringBefore(" · ")
                SheetOption(option.id, title, option.label.substringAfter(" · ", ""))
            }, shownModel) {
                model = it; if (effort.isNotBlank() && effort !in claudeEffortsFor(it, claudeModels)) effort = ""
            }
        }
        val efforts = claudeEffortsFor(model, claudeModels)
        SheetSection("思考强度") {
            if (efforts.isEmpty()) SheetNote("这个模型不支持调节思考强度")
            else SheetSegments(claudeEffortOptions(model, claudeModels).map { SheetOption(it.id, it.label) }, effort) { effort = it }
        }
        // For a session the desktop runs, the connector picks the mode in the desktop's own mode menu.
        SheetSection("权限模式") {
            SheetOptionList(permissionModeOptions("claude").map { SheetOption(it.id, it.label, it.detail, it.risky) }, permissionMode) { permissionMode = it }
        }
        SheetNote(
            if (desktopLive) "这个会话在电脑端运行，保存后在电脑上同一会话里切换：权限立即生效；模型和强度空闲时立即生效，运行中则从下一轮开始。"
            else "下一轮生效；运行中的这一轮不受影响。切换后会自动接续原会话。",
        )
    }
}

// The top bar already says which agent it is: "Claude Opus 5.5" -> "Opus 5.5",
// "gpt-5.5" -> "5.5", "gpt-6-sol" -> "6 Sol".
/** The account's computers as chips: tap one to see its sessions; a dot shows it is online. */
@Composable
private fun PcSwitcher(vm: BridgeViewModel, computers: List<DeviceEntry>, selectedId: String?, agent: String, agents: List<String>) {
    val seenAt by vm.connectorSeenAt.collectAsState()
    val phoneNetworkAvailable by vm.phoneNetworkAvailable.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(5_000); now = System.currentTimeMillis() } }
    val haptics = rememberHaptics()
    // Slim chips (2026-11-01): the chosen computer filled with ink, the others outlined.
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 14.dp, end = 12.dp, top = 0.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Default.Computer, null, Modifier.size(14.dp), tint = Muted)
        computers.forEach { pc ->
            val chosen = pc.id == selectedId
            val presence = computerPresence(phoneNetworkAvailable, seenAt[pc.id], now)
            val online = presence == ComputerPresence.Online
            val fill by animateColorAsState(if (chosen) Ink else Color.Transparent, tween(200), label = "pc-chip")
            Surface(
                Modifier.height(26.dp).clip(RoundedCornerShape(50)).clickable { if (!chosen) { haptics.tick(); vm.selectConnectorForAgent(agent, pc.id, agents) } }
                    .semantics { contentDescription = "电脑 ${pc.name} ${computerPresenceLabel(presence)}${if (chosen) "，当前" else ""}" },
                shape = RoundedCornerShape(50),
                color = fill,
                border = if (chosen) null else BorderStroke(0.5.dp, Divider),
            ) {
                Row(Modifier.padding(horizontal = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(6.dp).clip(CircleShape).background(if (online) P.success else Muted.copy(alpha = 0.5f)))
                    Spacer(Modifier.width(5.dp))
                    Text(computerLabel(pc), color = if (chosen) SurfaceBase else Ink, fontSize = 12.sp, fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
                }
            }
        }
    }
}

/** A Hermes slash command: no [hint] means it is sent as is; else a dialog asks for its words. */
private data class HermesCommand(val command: String, val label: String, val hint: String? = null, val quick: List<Pair<String, String>> = emptyList())

private val HermesCommands = listOf(
    HermesCommand("/goal", "目标", "要 Hermes 一直做到完成的目标", listOf("status" to "查看", "pause" to "暂停", "resume" to "继续", "clear" to "清除")),
    HermesCommand("/loop", "循环", "间隔和要重复做的事，例如：30m 看看内存", listOf("status" to "查看", "pause" to "暂停", "resume" to "继续", "stop" to "停止")),
    HermesCommand("/kanban", "看板", "看板子命令，例如：list，或 create 标题", listOf("list" to "任务列表", "stats" to "统计", "boards" to "看板")),
    HermesCommand("/moa", "会诊", "请专家会诊（MoA）回答的问题"),
    HermesCommand("/status", "状态"), HermesCommand("/usage", "用量"), HermesCommand("/compress", "压缩"),
)

/** Hermes slash commands as chips; /goal, /loop, /kanban and /moa run on the Hermes gateway. */
@Composable
private fun HermesCommandChips(send: (String) -> Unit) {
    var asking by remember { mutableStateOf<HermesCommand?>(null) }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        HermesCommands.forEach { command ->
            Surface(Modifier.clip(RoundedCornerShape(50)).clickable { if (command.hint == null) send(command.command) else asking = command },
                shape = RoundedCornerShape(50), color = Color.Transparent, border = BorderStroke(0.5.dp, Divider)) {
                Text("${command.label} ${command.command}", Modifier.padding(horizontal = 10.dp, vertical = 5.dp), color = Ink, style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
        }
    }
    asking?.let { command ->
        var words by remember(command) { mutableStateOf("") }
        val go = { value: String -> asking = null; send("${command.command} ${value.trim()}".trim()) }
        AlertDialog(
            onDismissRequest = { asking = null },
            title = { Text("${command.label} ${command.command}", fontWeight = FontWeight.Bold, color = Ink) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(words, { words = it }, Modifier.fillMaxWidth(), label = { Text(command.hint.orEmpty()) }, shape = RoundedCornerShape(10.dp), minLines = 2, maxLines = 5)
                    if (command.quick.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        command.quick.forEach { (arg, label) ->
                            OutlinedButton({ go(arg) }, shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(horizontal = 10.dp)) { Text(label) }
                        }
                    }
                }
            },
            dismissButton = { TextButton({ asking = null }) { Text("取消") } },
            confirmButton = { TextButton({ go(words) }, enabled = words.isNotBlank()) { Text("发送") } },
        )
    }
}

/** A Hermes model as the header shows it: "专家会诊 · panel" for a MoA preset, else the model's short name. */
internal fun hermesModelLabel(model: String?): String {
    val raw = model.orEmpty().trim()
    if (raw.isBlank()) return "默认模型"
    val bare = raw.substringAfterLast('/').substringAfterLast(':')
    if (raw.startsWith("moa/") || raw.startsWith("moa:") || bare in setOf("panel", "quick")) return "专家会诊 · $bare"
    return shortModelName(bare)
}

internal fun shortModelName(name: String): String {
    val short = name.replaceFirst(Regex("^(claude|gpt|gemini)[ _-]+", RegexOption.IGNORE_CASE), "").ifBlank { return name }
    val versioned = Regex("^(\\d[\\d.]*)-([a-z][a-z0-9-]*)$", RegexOption.IGNORE_CASE).find(short) ?: return short
    val words = versioned.groupValues[2].split('-').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
    return versioned.groupValues[1] + " " + words
}

// Codex's service tier ids, in the words the header uses.
private fun serviceTierLabel(id: String) = when (id.lowercase()) {
    "priority", "fast" -> "快速"
    "flex" -> "经济"
    "default", "standard", "auto" -> "标准速度"
    else -> id
}

private fun taskSettingsSummary(settings: ThreadSettings, caps: CapabilityState = CapabilityState()): String {
    // A setting left at "默认" is shown as what Codex really uses.
    val model = (settings.model ?: caps.codexDefaultModel())?.substringAfterLast('/')?.let(::shortModelName)?.ifBlank { null } ?: "默认模型"
    val effort = caps.codexEffectiveEffort(settings.model, settings.effort)?.let(::reasoningEffortLabel) ?: "默认强度"
    val speed = when (settings.serviceTier?.lowercase()) {
        "priority", "fast" -> "快速"
        "flex" -> "经济"
        null, "", "default", "standard" -> "标准速度"
        else -> settings.serviceTier
    }
    return "$model · $effort · $speed"
}

@Composable
private fun Choice(label: String, value: String, options: List<SettingOption>, choose: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column { Text(label, style = MaterialTheme.typography.labelMedium); Box { OutlinedButton({ open = true }, Modifier.fillMaxWidth()) { Text(value, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis) }; DropdownMenu(open, { open = false }) { options.distinctBy { it.id }.forEach { option -> DropdownMenuItem({ Text(option.label) }, { choose(option.id); open = false }) } } } }
}

@Composable
private fun TaskStatusIcon(status: String, modifier: Modifier = Modifier, tintOverride: Color? = null) {
    val image = when {
        isUnknownThreadStatus(status) -> Icons.Default.MoreHoriz
        status.contains("queued", true) -> Icons.Default.ScheduleSend
        isRunningStatus(status) -> Icons.Default.Autorenew
        isWaitingStatus(status) -> Icons.Default.NotificationsActive
        status.contains("fail", true) || status.contains("error", true) -> Icons.Default.Error
        status.contains("cancel", true) || status.contains("abort", true) || status.contains("interrupt", true) -> Icons.Default.StopCircle
        else -> Icons.Default.CheckCircle
    }
    Icon(image, statusLabel(status), modifier, tint = tintOverride ?: statusColor(status))
}

@Composable
private fun StatusBadge(status: String) {
    val color = statusColor(status)
    val container = when {
        isUnknownThreadStatus(status) -> P.surfaceAlt
        isWaitingStatus(status) || status.contains("queued", true) -> P.waitingChip
        isRunningStatus(status) -> P.runningChip
        status.contains("fail", true) || status.contains("error", true) -> P.dangerContainer
        status.contains("cancel", true) || status.contains("abort", true) || status.contains("interrupt", true) -> P.stoppedContainer
        else -> P.selected
    }
    val failed = status.contains("fail", true) || status.contains("error", true)
    val done = !failed && isCompletedThreadStatus(status)
    val shake = remember { androidx.compose.animation.core.Animatable(0f) }
    var shown by remember { mutableStateOf(status) }
    // Drawn only when it changes here, not when a finished task is opened.
    val drawCheck = remember { androidx.compose.animation.core.Animatable(1f) }
    LaunchedEffect(status) {
        if (shown == status) return@LaunchedEffect
        shown = status
        if (failed) shake.animateTo(0f, androidx.compose.animation.core.keyframes { durationMillis = 360; 6f at 50; -6f at 110; 4f at 170; -3f at 230; 0f at 360 })
        if (done) { drawCheck.snapTo(0f); drawCheck.animateTo(1f, tween(420, easing = androidx.compose.animation.core.FastOutSlowInEasing)) }
    }
    val containerColor by animateColorAsState(container, tween(220), label = "status-badge")
    Surface(Modifier.graphicsLayer { translationX = shake.value.dp.toPx() }, color = containerColor, shape = RoundedCornerShape(12.dp)) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 3.dp).animateContentSize(KhMotion.sizeSpring),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isRunningStatus(status)) {
                BreathingDot(color, 8.dp)
            } else if (done) {
                DrawnCheck(color, drawCheck.value, Modifier.size(12.dp))
            } else {
                TaskStatusIcon(status, Modifier.size(12.dp))
            }
            Spacer(Modifier.width(5.dp))
            Text(statusLabel(status), color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

/**
 * The light after a conversation's title in the WeChat layout, while the line
 * with the connection and the model is folded: orange and breathing while a
 * turn runs, red when the computer waits for you or is offline, amber while
 * connecting, green when all is well.
 */
@Composable
private fun HeaderLight(connection: ConnectionState, status: String) {
    val (color, label) = when {
        connection == ConnectionState.Offline -> Danger to "电脑离线"
        isWaitingStatus(status) -> Danger to "等你回复"
        isRunningStatus(status) || isMobileRunningStatus(status) -> P.warm to "正在运行"
        connection == ConnectionState.Connecting -> P.warm to "连接中"
        else -> P.success to "电脑在线"
    }
    Box(Modifier.semantics { contentDescription = label }) {
        if (isRunningStatus(status) || isMobileRunningStatus(status)) BreathingDot(color, 7.dp)
        else Box(Modifier.size(7.dp).background(color, CircleShape))
    }
}

@Composable
private fun ConnectionBadge(connection: ConnectionState, statusText: String) {
    val (label, color) = when (connection) {
        ConnectionState.Online -> "电脑在线" to P.success
        ConnectionState.Connecting -> "连接中" to P.warm
        ConnectionState.Offline -> when (statusText) { "登录已失效" -> "登录失效" to Danger; "手机没有网络" -> "手机没网" to Danger; else -> "电脑离线" to Danger }
    }
    Row(
        Modifier.semantics { contentDescription = statusText },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Spacer(Modifier.width(5.dp))
        Text(label, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

private fun isRunningStatus(status: String) = isRunningThreadStatus(status)
private fun isMobileRunningStatus(status: String) = status.contains("mobile_running", true)
private fun isWaitingStatus(status: String) = isNeedsReplyStatus(status) || status.contains("waiting", true) || status.contains("input", true) || status.contains("approval", true)
private fun showTaskStatusInToolbar(status: String) =
    isUnknownThreadStatus(status) ||
        status.contains("compact", true) ||
        status.contains("queued", true) ||
        isWaitingStatus(status) ||
        isRunningStatus(status) ||
        status.contains("fail", true) ||
        status.contains("error", true) ||
        status.contains("cancel", true) ||
        status.contains("abort", true) ||
        status.contains("interrupt", true)
private fun statusLabel(status: String) = when {
    isUnknownThreadStatus(status) -> "状态待确认"
    isDesktopApprovalStatus(status) -> "电脑端等待审批"
    status == "desktop_waiting_answer" -> "电脑端等待回答"
    status == "waiting_answer" -> "等待你回答"
    isNeedsReplyStatus(status) -> "等你回复"
    status == "partial" -> "完成（部分失败）"
    status.contains("compact", true) -> "上下文整理中"
    status.contains("queued", true) -> "待发送"
    status.contains("desktop_waiting", true) || status.contains("desktop_input", true) -> "电脑端需要输入"
    status.contains("mobile_waiting", true) || status.contains("mobile_input", true) -> "手机端需要输入"
    status.contains("desktop_running", true) -> "电脑端运行中"
    status.contains("mobile_running", true) -> "手机端运行中"
    isWaitingStatus(status) -> "需要输入"
    isRunningStatus(status) -> "正在运行"
    status.contains("fail", true) || status.contains("error", true) -> "运行失败"
    status.contains("cancel", true) || status.contains("abort", true) || status.contains("interrupt", true) -> "已停止"
    else -> "运行完成"
}
private fun statusColor(status: String) = when {
    isUnknownThreadStatus(status) -> Muted
    status == "partial" -> P.queued
    status.contains("compact", true) -> P.compaction
    status.contains("queued", true) -> P.queued
    isWaitingStatus(status) -> P.queued
    isRunningStatus(status) -> Warm
    status.contains("fail", true) || status.contains("error", true) -> Danger
    status.contains("cancel", true) || status.contains("abort", true) || status.contains("interrupt", true) -> Color.Gray
    else -> Accent
}
private fun formatTime(epoch: Long): String = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epoch))

internal fun formatTurnDuration(durationMs: Long): String {
    val totalSeconds = (durationMs.coerceAtLeast(0L) + 999L) / 1_000L
    val seconds = totalSeconds % 60L
    val minutes = (totalSeconds / 60L) % 60L
    val hours = totalSeconds / 3_600L
    return when {
        hours > 0L -> "${hours}小时${minutes.toString().padStart(2, '0')}分"
        minutes > 0L -> "${minutes}分${seconds.toString().padStart(2, '0')}秒"
        else -> "${seconds}秒"
    }
}
private fun formatMessageTime(epoch: Long): String = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epoch))
private fun formatBytes(value: Long): String = when { value >= 1024 * 1024 -> "%.1f MB".format(value / 1024.0 / 1024.0); value >= 1024 -> "%.1f KB".format(value / 1024.0); else -> "$value B" }

// A small two-line toggle for how a message goes while a turn is running.
@Composable
private fun SendModeChip(label: String, hint: String, selected: Boolean, tint: Color, choose: () -> Unit) {
    Surface(
        Modifier.clickable(onClick = choose),
        shape = RoundedCornerShape(10.dp),
        color = if (selected) tint.copy(alpha = 0.12f) else Color.Transparent,
        border = BorderStroke(if (selected) 1.dp else 0.5.dp, if (selected) tint else Divider),
    ) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = if (selected) tint else Ink, style = MaterialTheme.typography.labelMedium, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
            Spacer(Modifier.width(4.dp))
            Text(hint, color = Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1)
        }
    }
}


// Running: a soft pulse instead of a spinner.
@Composable
private fun BreathingDot(color: Color, size: androidx.compose.ui.unit.Dp) {
    val pulse = rememberInfiniteTransition(label = "breathing")
    val scale by pulse.animateFloat(0.7f, 1.15f, infiniteRepeatable(tween(900, easing = androidx.compose.animation.core.FastOutSlowInEasing), RepeatMode.Reverse), label = "breathing-scale")
    val alpha by pulse.animateFloat(0.55f, 1f, infiniteRepeatable(tween(900, easing = androidx.compose.animation.core.FastOutSlowInEasing), RepeatMode.Reverse), label = "breathing-alpha")
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Box(Modifier.size(size).graphicsLayer { scaleX = scale * 1.6f; scaleY = scale * 1.6f; this.alpha = (1f - alpha) * 0.6f }.background(color.copy(alpha = 0.35f), CircleShape))
        Box(Modifier.size(size).graphicsLayer { scaleX = scale; scaleY = scale; this.alpha = alpha }.background(color, CircleShape))
    }
}

// Done: a ring and a check drawn in one stroke.
@Composable
private fun DrawnCheck(color: Color, progress: Float, modifier: Modifier = Modifier) {
    androidx.compose.foundation.Canvas(modifier) {
        val stroke = size.minDimension * 0.14f
        val ring = (progress / 0.5f).coerceIn(0f, 1f)
        val tick = ((progress - 0.45f) / 0.55f).coerceIn(0f, 1f)
        drawArc(color, -90f, 360f * ring, useCenter = false, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
        if (tick > 0f) {
            val w = size.width; val h = size.height
            val a = androidx.compose.ui.geometry.Offset(w * 0.28f, h * 0.52f)
            val b = androidx.compose.ui.geometry.Offset(w * 0.44f, h * 0.68f)
            val c = androidx.compose.ui.geometry.Offset(w * 0.73f, h * 0.36f)
            val path = androidx.compose.ui.graphics.Path().apply {
                moveTo(a.x, a.y)
                if (tick < 0.4f) lineTo(a.x + (b.x - a.x) * tick / 0.4f, a.y + (b.y - a.y) * tick / 0.4f)
                else { lineTo(b.x, b.y); val t = (tick - 0.4f) / 0.6f; lineTo(b.x + (c.x - b.x) * t, b.y + (c.y - b.y) * t) }
            }
            drawPath(path, color, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
        }
    }
}

// How a message goes while a turn runs: queue it, or send it into this turn.
// One control with a selection that slides between the two halves.
@Composable
private fun SendModeToggle(steer: Boolean, modifier: Modifier = Modifier, choose: (Boolean) -> Unit) {
    val options = listOf(false to ("排队" to "本轮结束后发"), true to ("立即发送" to "插入当前这一轮"))
    val tint by animateColorAsState(if (steer) Accent else Warm, tween(220), label = "send-mode-tint")
    androidx.compose.foundation.layout.BoxWithConstraints(modifier.fillMaxWidth()) {
        val half = (maxWidth - 4.dp) / 2
        val offset by androidx.compose.animation.core.animateDpAsState(if (steer) half + 2.dp else 0.dp, KhMotion.slide(), label = "send-mode-slide")
        Surface(shape = RoundedCornerShape(11.dp), color = Color.Transparent, border = BorderStroke(0.5.dp, Divider)) {
            Box(Modifier.fillMaxWidth().padding(2.dp)) {
                Box(Modifier.offset(x = offset).width(half).height(30.dp).background(tint.copy(alpha = 0.13f), RoundedCornerShape(9.dp)).border(1.dp, tint.copy(alpha = 0.7f), RoundedCornerShape(9.dp)))
                Row(Modifier.fillMaxWidth()) {
                    options.forEach { (value, text) ->
                        val selected = value == steer
                        Row(
                            Modifier.width(half).height(30.dp).clip(RoundedCornerShape(9.dp)).clickable { if (!selected) choose(value) },
                            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(text.first, color = if (selected) tint else Ink, style = MaterialTheme.typography.labelMedium, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
                            Spacer(Modifier.width(4.dp))
                            Text(text.second, color = Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                        }
                        if (!value) Spacer(Modifier.width(4.dp))
                    }
                }
            }
        }
    }
}

// A block that arrives while the conversation is open fades in and rises a
// little; blocks already there when it opened stay still.
private fun Modifier.riseInIfNew(key: String, seen: Set<String>): Modifier = composed {
    val fresh = remember(key) { seen.isNotEmpty() && key !in seen }
    if (!fresh) return@composed this
    val progress = remember(key) { androidx.compose.animation.core.Animatable(0f) }
    LaunchedEffect(key) { progress.animateTo(1f, KhMotion.element()) }
    this.graphicsLayer {
        alpha = progress.value.coerceIn(0f, 1f)
        translationY = (1f - progress.value) * 18.dp.toPx()
    }
}
