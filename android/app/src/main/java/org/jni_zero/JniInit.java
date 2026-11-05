package org.jni_zero;

import java.util.Collections;

/** Compatibility entry point required by the WebRTC M150 JNI loader. */
public final class JniInit {
    private JniInit() {}

    private static Object[] init() {
        return new Object[] {Collections.emptyList(), Collections.emptyMap()};
    }
}
