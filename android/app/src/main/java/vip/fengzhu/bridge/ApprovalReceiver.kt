package vip.fengzhu.bridge

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class ApprovalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        (context.applicationContext as FengzhuApplication).repository.resolveApproval(
            intent.getBooleanExtra("accept", false),
            intent.getStringExtra("rpcId"),
            intent.getStringExtra("threadId"),
        )
        context.getSystemService(NotificationManager::class.java).cancel(1101)
    }
}
