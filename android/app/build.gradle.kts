import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

// The distribution's relay and update key; see khlink-official.properties.
val distribution = Properties().apply {
    rootProject.file("khlink-official.properties").takeIf { it.isFile }?.reader(Charsets.UTF_8)?.use { load(it) }
}
fun distributionField(name: String): String =
    "\"" + distribution.getProperty(name, "").trim().replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "vip.fengzhu.bridge"
    compileSdk = 36

    defaultConfig {
        applicationId = "vip.fengzhu.bridge"
        minSdk = 24
        targetSdk = 36
        versionCode = 330
        versionName = "0.1.329"
        // The production phone is arm64-v8a.  WebRTC ships four native
        // architectures in its universal AAR; keeping only the device ABI
        // avoids putting unused x86/32-bit libraries in the release APK.
        ndk { abiFilters += setOf("arm64-v8a") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "BRIDGE_SERVER", distributionField("bridgeServer"))
        buildConfigField("String", "LEGACY_BRIDGE_SERVERS", distributionField("legacyBridgeServers"))
        buildConfigField("boolean", "ACCOUNT_LOGIN", distribution.getProperty("accountLogin", "false").trim().toBoolean().toString())
        buildConfigField("String", "TRUSTED_BRIDGE_SERVERS", distributionField("trustedBridgeServers"))
        buildConfigField("String", "UPDATE_PUBLIC_KEY", distributionField("updatePublicKey"))
        buildConfigField("String", "UPDATE_MIRRORS", distributionField("updateMirrors"))
    }
    val releaseStore = System.getenv("FENGZHU_RELEASE_STORE")
    // A release signed with the official key must carry the official service.
    check(releaseStore.isNullOrBlank() || !distribution.isEmpty) { "khlink-official.properties is missing for the official release build" }
    if (!releaseStore.isNullOrBlank()) signingConfigs {
        create("release") {
            storeFile = file(releaseStore)
            storePassword = System.getenv("FENGZHU_RELEASE_STORE_PASSWORD")
            keyAlias = "fengzhu-bridge"
            keyPassword = System.getenv("FENGZHU_RELEASE_KEY_PASSWORD")
        }
    }
    // -PkhlinkDemo builds a separate debug app (vip.fengzhu.bridge.demo) that
    // shows made-up sessions for screenshots and never connects anywhere.
    val demo = project.hasProperty("khlinkDemo")
    buildTypes {
        debug {
            buildConfigField("boolean", "DEMO", demo.toString())
            if (demo) applicationIdSuffix = ".demo"
        }
        release {
            buildConfigField("boolean", "DEMO", "false")
            isMinifyEnabled = true
            isShrinkResources = true
            if (!releaseStore.isNullOrBlank()) signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*") }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.05.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.exifinterface:exifinterface:1.4.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.9.3")
    implementation("androidx.room:room-runtime:2.8.4")
    implementation("androidx.room:room-ktx:2.8.4")
    ksp("androidx.room:room-compiler:2.8.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:0.37.0")
    implementation("com.goterl:lazysodium-android:5.2.0@aar")
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("io.github.webrtc-sdk:android:150.7871.01")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
