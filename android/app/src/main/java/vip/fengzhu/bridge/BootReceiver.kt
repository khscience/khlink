package vip.fengzhu.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext as FengzhuApplication
        if (app.repository.configured()) ContextCompat.startForegroundService(context, Intent(context, BridgeService::class.java))
    }
}
