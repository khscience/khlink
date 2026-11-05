package vip.fengzhu.bridge

import android.app.Application

class FengzhuApplication : Application() {
    val repository by lazy { BridgeRepository(this) }
}

