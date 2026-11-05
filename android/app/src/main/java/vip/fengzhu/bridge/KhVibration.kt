package vip.fengzhu.bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Build
import android.os.SystemClock
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import android.view.View
import androidx.core.app.NotificationManagerCompat

/** One restrained pulse for all app feedback; system switches and DND still win. */
object KhVibration {
    private var lastPlayedAt = -1_000L

    private fun vibrator(context: Context): Vibrator? = if (Build.VERSION.SDK_INT >= 31)
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    else context.getSystemService(Vibrator::class.java)

    fun touch(view: View, cue: GentleCue) {
        if (view.isHapticFeedbackEnabled) play(view.context, cue, notification = false)
    }

    fun started(context: Context, appVisible: Boolean) = play(context, GentleCue.Started, notification = !appVisible)

    @Synchronized
    private fun play(context: Context, cue: GentleCue, notification: Boolean) {
        runCatching {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL) return
            if (notification) {
                if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
                if (context.getSystemService(AudioManager::class.java)?.ringerMode == AudioManager.RINGER_MODE_SILENT) return
                if (Build.VERSION.SDK_INT >= 26) {
                    val channel = manager.getNotificationChannel(BridgeService.CHANNEL_EVENTS) ?: return
                    if (channel.importance == NotificationManager.IMPORTANCE_NONE || !channel.shouldVibrate()) return
                }
            } else if (Settings.System.getInt(context.contentResolver, Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) == 0) return
            val device = vibrator(context) ?: return
            // Without amplitude control a nonzero amplitude may become 100%.
            // Silence is preferable to surprising the user with a strong pulse.
            if (Build.VERSION.SDK_INT < 26 || !device.hasAmplitudeControl()) return
            val now = SystemClock.elapsedRealtime()
            if (now - lastPlayedAt < 120L) return
            lastPlayedAt = now
            val effect = VibrationEffect.createOneShot(cue.durationMs, cue.amplitude)
            if (Build.VERSION.SDK_INT >= 33) device.vibrate(effect, VibrationAttributes.Builder()
                .setUsage(if (notification) VibrationAttributes.USAGE_NOTIFICATION else VibrationAttributes.USAGE_TOUCH).build())
            else device.vibrate(effect, AudioAttributes.Builder()
                .setUsage(if (notification) AudioAttributes.USAGE_NOTIFICATION else AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            Log.i("KhHaptics", "cue=${cue.name} durationMs=${cue.durationMs} amplitude=${cue.amplitude}")
        }
    }

    fun createEventChannel(context: Context, manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < 26) return
        // Vibration behavior of an existing channel is immutable. Keep its
        // importance, sound and disabled vibration preference in the new one.
        if (manager.getNotificationChannel(BridgeService.CHANNEL_EVENTS) != null) return
        val old = manager.getNotificationChannel("bridge_events")
        val channel = NotificationChannel(BridgeService.CHANNEL_EVENTS, "任务与审批", old?.importance ?: NotificationManager.IMPORTANCE_HIGH).apply {
            lockscreenVisibility = old?.lockscreenVisibility ?: android.app.Notification.VISIBILITY_PRIVATE
            if (old != null) {
                setSound(old.sound, old.audioAttributes)
                setShowBadge(old.canShowBadge())
                enableLights(old.shouldShowLights())
                lightColor = old.lightColor
            }
            if (Build.VERSION.SDK_INT >= 35 && vibrator(context)?.hasAmplitudeControl() == true) {
                setVibrationEffect(VibrationEffect.createOneShot(GentleCue.Attention.durationMs, GentleCue.Attention.amplitude))
                enableVibration(old?.shouldVibrate() ?: true)
            } else {
                // Pre-35 notification channels can specify timings, not
                // amplitude. Do not substitute the default-strength pattern.
                enableVibration(false)
            }
        }
        manager.createNotificationChannel(channel)
    }
}
