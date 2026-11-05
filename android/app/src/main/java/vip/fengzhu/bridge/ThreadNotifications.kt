package vip.fengzhu.bridge

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

internal enum class ThreadNoticeKind { TERMINAL, PROMPT }

internal fun threadNoticeId(threadId: String): Int = 2000 + (threadId.hashCode() and 0xFFFFF)
internal fun threadNoticeTag(threadId: String): String = "thread:$threadId"
internal const val THREAD_NOTICE_KIND = "vip.fengzhu.bridge.threadNoticeKind"
internal val threadNoticeLock = Any()

internal fun taggedTerminalNoticeMatches(actualTag: String?, actualId: Int, actualKind: String?, threadId: String): Boolean =
    actualTag == threadNoticeTag(threadId) && actualId == threadNoticeId(threadId) && actualKind == ThreadNoticeKind.TERMINAL.name

// PendingIntent ignores extras for identity, so include the full thread ID in
// the action. Different threads can otherwise share a hash and open the wrong one.
internal fun threadNoticeIntent(context: Context, threadId: String): Intent =
    Intent(context, MainActivity::class.java).setAction("vip.fengzhu.bridge.OPEN_THREAD:$threadId")
        .putExtra(MainActivity.EXTRA_OPEN_THREAD, threadId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)

internal fun legacyTerminalNoticeMatches(
    actualTag: String?, actualId: Int, actualTitle: String?, sameIntent: Boolean,
    threadId: String, threadTitle: String, agent: String,
): Boolean = actualTag == null && actualId == threadNoticeId(threadId) && sameIntent &&
    listOf("已完成", "已停止", "运行失败").any { actualTitle == "$agent $it · $threadTitle" }

/** Opening a conversation clears only its terminal reminder, never a prompt. */
internal fun clearReadTerminalNotice(context: Context, threadId: String, threadTitle: String?, agent: String?) {
    runCatching {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val id = threadNoticeId(threadId)
        synchronized(threadNoticeLock) {
            val tagged = manager.activeNotifications.firstOrNull { notice ->
                taggedTerminalNoticeMatches(notice.tag, notice.id,
                    notice.notification.extras?.getString(THREAD_NOTICE_KIND), threadId)
            }
            if (tagged != null) manager.cancel(threadNoticeTag(threadId), id)
        }
        if (threadTitle == null || agent == null) return
        // Versions before tags used an untagged ID. Verify both the displayed
        // terminal title and the original PendingIntent before clearing it.
        val intent = Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_THREAD, threadId)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val expected = PendingIntent.getActivity(context, threadId.hashCode(), intent,
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) ?: return
        val legacy = manager.activeNotifications.firstOrNull { notice ->
            legacyTerminalNoticeMatches(notice.tag, notice.id,
                notice.notification.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
                notice.notification.contentIntent == expected, threadId, threadTitle, agent)
        }
        if (legacy != null) manager.cancel(id)
    }
}
