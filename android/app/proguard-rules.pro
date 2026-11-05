-keep class com.sun.jna.** { *; }
# WebRTC loads Java classes and callbacks by their original names from JNI.
# Its AAR does not retain all native entry points under release R8 shrinking.
-keep class org.webrtc.** { *; }
# These JNI Zero methods are looked up by name during native library loading.
# Do not keep its unused setJniClassLoader API: the AAR omits that JNI wrapper.
-keep class org.jni_zero.JniZero {
    private static java.lang.Object[] init();
    private static void crashIfMultiplexingMisaligned(long, long);
}
# WebRTC M150's native JNI loader looks this class up during System.loadLibrary.
# The published AAR omits the Java source, so keep the compatibility shim below.
-keep class org.jni_zero.JniInit {
    private static java.lang.Object[] init();
}
-keep class com.goterl.lazysodium.** { *; }
-dontwarn java.awt.Component
-dontwarn java.awt.GraphicsEnvironment
-dontwarn java.awt.HeadlessException
-dontwarn java.awt.Window
-keep class com.goterl.lazysodium.** { *; }
-keep class com.sun.jna.** { *; }
