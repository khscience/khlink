"""Build a logged-out, separate PJA QA package and its instrumentation.

Never targets or installs the signed app. The temporary Gradle and Android test
source changes are restored only if their contents still match this script.
"""
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[3]
gradle = repo / "android" / "app" / "build.gradle.kts"
source = repo / "ops" / "test" / "manual" / "pja-codex-preboot" / "src" / "vip" / "fengzhu" / "bridge" / "PjaCodexPrebootStatusTest.kt"
staged = repo / "android" / "app" / "src" / "androidTest" / "kotlin" / "vip" / "fengzhu" / "bridge" / source.name
if staged.exists():
    raise SystemExit("Temporary test path already exists; refusing to overwrite")
source_bytes = source.read_bytes()
original = gradle.read_bytes()
newline = "\r\n" if b"\r\n" in original else "\n"
text = original.decode("utf-8").replace("\r\n", "\n")
checks = {
    '    buildTypes {\n': '    buildTypes {\n        debug { applicationIdSuffix = ".safeqa20261102" }\n',
    '    androidTestImplementation(composeBom)\n': '    androidTestImplementation(composeBom)\n    androidTestImplementation("androidx.test:runner:1.7.0")\n    androidTestImplementation("junit:junit:4.13.2")\n',
}
for old, new in checks.items():
    if text.count(old) != 1 or new in text:
        raise SystemExit("Unexpected Gradle contents; refusing to modify")
    text = text.replace(old, new, 1)
temporary = text.replace("\n", newline).encode("utf-8")
code = 1
try:
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_bytes(source_bytes)
    gradle.write_bytes(temporary)
    result = subprocess.run(
        ["cmd.exe", "/d", "/c", "gradlew.bat", ":app:assembleDebug", ":app:assembleDebugAndroidTest", "--offline", "--no-daemon", "--console=plain"],
        cwd=repo / "android", check=False,
    )
    code = result.returncode
finally:
    if gradle.read_bytes() == temporary:
        gradle.write_bytes(original)
    else:
        print("Gradle file changed concurrently; not overwriting", file=sys.stderr)
        code = 1
    if staged.exists():
        if staged.read_bytes() == source_bytes:
            staged.unlink()
        else:
            print("Temporary test changed concurrently; not removing", file=sys.stderr)
            code = 1
sys.exit(code)
