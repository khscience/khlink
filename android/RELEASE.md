# Android release builds

The phone's installed production APK is signed with the private release keystore. A
debug APK must not be installed over it because Android will reject the signature.
Keep the keystore outside this repository and provide these environment variables
only in the release build environment:

```powershell
$env:FENGZHU_RELEASE_STORE = 'C:\path\to\fengzhu-release.jks'
$env:FENGZHU_RELEASE_STORE_PASSWORD = '...'
$env:FENGZHU_RELEASE_KEY_PASSWORD = '...'
./gradlew.bat clean assembleRelease
```

`node ops/build-android-release.js` does the same from the repository root, reading
the keystore and its passwords from the git-ignored `.secrets/` folder (see the
script's header).

A signed release also needs `android/khlink-official.properties`, the official
service's relay, account login and update key; the build stops without it. A
build of your own without the official update key should drop `updatePublicKey`
from that file, or the app offers official updates it cannot install.

When those variables are absent, `assembleRelease` remains a valid unsigned build
for CI checks, while `assembleDebug` uses the normal debug key. Never uninstall a
production APK just to install a debug build: uninstalling removes the app's local
pairing and encrypted history.
