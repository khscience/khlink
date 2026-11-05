// Builds the signed Android release APK (android/app/build/outputs/apk/release).
// The keystore and its passwords stay outside git, in .secrets/:
//   .secrets/android-signing.json                { "storeFile": "<name>.jks", "storePassword": "...", "keyPassword": "..." }
//   .secrets/<storeFile>                         the release keystore (alias fengzhu-bridge);
//                                                without storeFile, fengzhu-bridge-release.jks
// They are passed to Gradle only through the child's environment, never printed
// or written anywhere. Without .secrets the build is unsigned; see android/RELEASE.md.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const secretsDir = path.join(root, '.secrets');
const env = { ...process.env };
if (fs.existsSync(path.join(secretsDir, 'android-signing.json'))) {
  const secrets = require(path.join(secretsDir, 'android-signing.json'));
  env.FENGZHU_RELEASE_STORE = path.join(secretsDir, path.basename(secrets.storeFile || 'fengzhu-bridge-release.jks'));
  env.FENGZHU_RELEASE_STORE_PASSWORD = secrets.storePassword;
  env.FENGZHU_RELEASE_KEY_PASSWORD = secrets.keyPassword;
}
const result = spawnSync('bash', ['gradlew', '--no-daemon', '-q', 'assembleRelease'], { cwd: path.join(root, 'android'), env, stdio: 'inherit' });
process.exit(result.status ?? 1);
