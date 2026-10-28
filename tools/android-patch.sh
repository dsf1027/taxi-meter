#!/usr/bin/env bash
# Customise the Capacitor Android project that `npx cap add android` generates into ./android:
#   - location permission (the meter measures distance with GPS), portrait only, screen stays on
#   - launcher icon, dark splash
#   - a fixed signing key, so a new build installs over the previous one (keeps your trip history)
# Every edit asserts that the pattern it expects exists, so a changed template fails loudly.
#   VERSION_CODE / VERSION_NAME can be set by CI (defaults: 1 / 1.0).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d android/app/src/main ] || { echo "android/ not found - run: npx cap add android" >&2; exit 1; }

cp -r android-res/. android/app/src/main/res/
cp tools/taxi-debug.keystore android/app/taxi-debug.keystore

python3 - <<'PY'
import os, pathlib

def edit(path, fn):
    p = pathlib.Path(path)
    p.write_text(fn(p.read_text(encoding="utf-8")), encoding="utf-8")

def must_replace(s, old, new, what):
    if old not in s:
        raise SystemExit(f"android-patch: expected {what!r} was not found - the Capacitor template changed")
    return s.replace(old, new, 1)

# --- manifest: location + portrait -----------------------------------------------
def manifest(s):
    if "ACCESS_FINE_LOCATION" not in s:
        s = must_replace(
            s,
            '<uses-permission android:name="android.permission.INTERNET" />',
            '<uses-permission android:name="android.permission.INTERNET" />\n'
            '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n'
            '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n'
            '    <uses-feature android:name="android.hardware.location.gps" android:required="false" />',
            "INTERNET permission line",
        )
    return must_replace(s, 'android:launchMode="singleTask"', 'android:launchMode="singleTask"\n            android:screenOrientation="portrait"', "launchMode attribute")
edit("android/app/src/main/AndroidManifest.xml", manifest)

# --- keep the screen on while the meter is in the foreground ---------------------
java = next(pathlib.Path("android/app/src/main/java").rglob("MainActivity.java"))
def activity(s):
    s = must_replace(s, "public class MainActivity extends BridgeActivity {}",
        "public class MainActivity extends BridgeActivity {\n"
        "    @Override\n"
        "    public void onCreate(android.os.Bundle savedInstanceState) {\n"
        "        super.onCreate(savedInstanceState);\n"
        "        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);\n"
        "    }\n"
        "}", "empty MainActivity class")
    return s
edit(str(java), activity)

# --- launch theme: dark splash instead of the Capacitor logo ----------------------
edit("android/app/src/main/res/values/styles.xml", lambda s: must_replace(
    s, '<item name="android:background">@drawable/splash</item>',
    '<item name="android:background">@color/splash_bg</item>\n        <item name="windowSplashScreenBackground">@color/splash_bg</item>',
    "splash background item"))

# --- gradle: fixed signing key, version -------------------------------------------
def gradle(s):
    s = must_replace(s, "android {\n",
        "android {\n"
        "    signingConfigs {\n"
        "        taxi {\n"
        '            storeFile file("taxi-debug.keystore")\n'
        '            storePassword "android"\n'
        '            keyAlias "taxi"\n'
        '            keyPassword "android"\n'
        "        }\n"
        "    }\n", "android block")
    s = must_replace(s, "    buildTypes {\n", "    buildTypes {\n        debug {\n            signingConfig signingConfigs.taxi\n        }\n", "buildTypes block")
    s = must_replace(s, "versionCode 1", f"versionCode {int(os.environ.get('VERSION_CODE', '1'))}", "versionCode")
    s = must_replace(s, 'versionName "1.0"', f'versionName "{os.environ.get("VERSION_NAME", "1.0")}"', "versionName")
    return s
edit("android/app/build.gradle", gradle)
print("android-patch: ok")
PY
