package vip.fengzhu.bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class BridgeService : Service() {
    private val repository get() = (application as FengzhuApplication).repository
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var foregroundType: Int? = null
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_CONNECTION, "连接状态", NotificationManager.IMPORTANCE_LOW))
            KhVibration.createEventChannel(this, manager)
        }
        // The ongoing notification a foreground service must show: one steady
        // line, changed only to say the computer is offline and back (silently).
        // Promote first: initializing the repository, database and keystore can
        // otherwise exceed Android's foreground-service startup deadline.
        promoteForeground(if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0)
        ensureForeground()
        var shownConnection = "khLink" to CONNECTED_NOTICE
        repository.notificationSink = sink@{ title, text, approval ->
            val connectionStatus = title == "khLink" || title == "电脑离线"
            val channel = if (connectionStatus) CHANNEL_CONNECTION else CHANNEL_EVENTS
            if (connectionStatus && shownConnection == (title to text)) return@sink
            if (connectionStatus) shownConnection = title to text
            val id = when { connectionStatus -> 1001; approval -> 1101; else -> (System.currentTimeMillis() % 100000).toInt() }
            manager.notify(id, notification(title, text, approval, channel, if (approval) repository.approval.value else null))
        }
        // Per-session reminders (a prompt waiting on the desktop, a finished
        // turn): one notification per session, tapping it opens the session.
        repository.threadNotificationSink = { threadId, title, text, urgent, kind ->
            val open = threadNoticeIntent(this, threadId)
            val tap = PendingIntent.getActivity(this, threadId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val built = NotificationCompat.Builder(this, CHANNEL_EVENTS).setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text)).setContentIntent(tap).setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPriority(if (urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT).build()
            built.extras.putString(THREAD_NOTICE_KIND, kind.name)
            // Keep the existing one-reminder-per-thread replacement behavior.
            // Serialize with read cleanup so a new prompt cannot be cancelled.
            synchronized(threadNoticeLock) { manager.notify(threadNoticeTag(threadId), threadNoticeId(threadId), built) }
        }
        // Question reminders have their own tag: resolving an answer must not
        // cancel a completion/approval notification for the same conversation.
        repository.codexQuestionNotificationSink = { threadId, title, text, urgent ->
            val tag = "codex-question:$threadId"
            val id = 2000 + (threadId.hashCode() and 0xFFFFF)
            if (title == null) manager.cancel(tag, id)
            else if (urgent || manager.activeNotifications.any { it.tag == tag }) {
                val open = threadNoticeIntent(this, threadId)
                val tap = PendingIntent.getActivity(this, threadId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                manager.notify(tag, id, NotificationCompat.Builder(this, CHANNEL_EVENTS).setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title).setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text)).setContentIntent(tap)
                    .setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setSilent(!urgent)
                    .setPriority(NotificationCompat.PRIORITY_HIGH).build())
            }
        }
        repository.resumeConnection()
        serviceScope.launch {
            while (isActive) {
                runCatching { if (repository.directMode()) null else repository.checkForUpdate() }.getOrNull()?.let { update ->
                    // Downloaded ahead when 后台下载更新 is on: the
                    // notification then only asks to install it. A stopped
                    // service cancels here instead of posting a notice.
                    val ready = repository.prepareUpdateInBackground(update)
                    manager.notify(1201, if (ready) notification("新版本 ${update.versionName} 已下载", "点按打开 khLink 安装", false, CHANNEL_EVENTS)
                        else notification("发现新版本 ${update.versionName}", update.notes.firstOrNull() ?: "点按打开 khLink 下载更新", false, CHANNEL_EVENTS))
                }
                delay(6 * 60 * 60 * 1000L)
            }
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureForeground()
        repository.resumeConnection()
        return START_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun ensureForeground() {
        val type = when {
            repository.directMode() -> ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            Build.VERSION.SDK_INT >= 34 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            else -> 0
        }
        promoteForeground(type)
    }

    private fun promoteForeground(type: Int) {
        if (foregroundType == type) return
        val notice = notification("khLink", CONNECTED_NOTICE, false, CHANNEL_CONNECTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(1001, notice, type)
        else startForeground(1001, notice)
        foregroundType = type
    }

    private fun notification(title: String, text: String, approval: Boolean, channel: String, request: ApprovalRequest? = null) =
        NotificationCompat.Builder(this, channel).setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(text)
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOngoing(channel == CHANNEL_CONNECTION)
            .setSilent(channel == CHANNEL_CONNECTION).setOnlyAlertOnce(channel == CHANNEL_CONNECTION).setShowWhen(channel != CHANNEL_CONNECTION)
            .setPriority(if (approval) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT).apply {
                if (approval) {
                    addAction(0, "拒绝", approvalIntent(false, request))
                    addAction(0, "允许", approvalIntent(true, request))
                }
            }.build()

    private fun approvalIntent(accept: Boolean, request: ApprovalRequest?) = PendingIntent.getBroadcast(
        this,
        ((request?.rpcId?.hashCode() ?: 0) * 31 + if (accept) 1 else 2),
        Intent(this, ApprovalReceiver::class.java)
            .putExtra("accept", accept)
            .putExtra("rpcId", request?.rpcId)
            .putExtra("threadId", request?.threadId),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT,
    )

    companion object { const val CHANNEL_CONNECTION = "bridge_connection"; const val CHANNEL_EVENTS = "bridge_events_gentle_v1" }
}
