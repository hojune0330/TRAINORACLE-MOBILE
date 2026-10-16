#!/usr/bin/env bash
# Run only AFTER assembling/copying the debug APK. This is installed WebView QA,
# not a source regression suite. Never point this script at a personal device.
set -Eeuo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Requires an ephemeral standard GitHub-hosted Linux x86_64 runner' >&2; exit 1; }
[[ $# == 0 ]] || { echo 'No arguments accepted' >&2; exit 1; }
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APK="$ROOT/output/TrainOracle-android-test.apk"
PACKAGE=io.trainoracle.app.debug
[[ -s "$APK" ]] || { echo 'Build output/TrainOracle-android-test.apk first' >&2; exit 1; }
command -v timeout >/dev/null
command -v node >/dev/null
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
[[ -d "$SDK" ]] || { echo 'Android SDK is required' >&2; exit 1; }
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$SDK/cmdline-tools/latest/bin/avdmanager"
[[ -x "$SDKMANAGER" && -x "$AVDMANAGER" ]] || { echo 'SDK command-line tools latest are required' >&2; exit 1; }
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
IMAGE='system-images;android-36;google_apis;x86_64'
if [[ ! -s "$SDK/system-images/android-36/google_apis/x86_64/package.xml" || ! -x "$SDK/emulator/emulator" || ! -x "$SDK/platform-tools/adb" ]]; then
  # sdkmanager may stop reading stdin before yes does; check sdkmanager, not yes.
  set +e
  yes | timeout 600 "$SDKMANAGER" --sdk_root="$SDK" --install "$IMAGE" emulator platform-tools
  sdk_status=${PIPESTATUS[1]}
  set -e
  [[ "$sdk_status" == 0 ]] || exit "$sdk_status"
fi
ADB="$SDK/platform-tools/adb"
EMULATOR="$SDK/emulator/emulator"
[[ -c /dev/kvm ]] || { echo 'Hosted runner has no KVM device' >&2; exit 1; }
KVM_MODE="$(stat -c '%a' /dev/kvm)"
WORK="$(mktemp -d "${RUNNER_TEMP:?}/trainoracle-android-runtime.XXXXXX")"
export ANDROID_AVD_HOME="$WORK/avd"
mkdir -p "$ANDROID_AVD_HOME" "$ROOT/output"
AVD="trainoracle_ci_${GITHUB_RUN_ID:-run}_${GITHUB_RUN_ATTEMPT:-1}_$$"
SERIAL=''
EMU_PID=''
KVM_CHANGED=false
capture_screen() {
  [[ -n "$SERIAL" ]] || return 1
  timeout 15 "$ADB" -s "$SERIAL" shell screencap -p /sdcard/trainoracle-native-ci.png >/dev/null &&
    timeout 15 "$ADB" -s "$SERIAL" pull /sdcard/trainoracle-native-ci.png "$ROOT/output/trainoracle-android-actual.png" >/dev/null
}
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "$SERIAL" ]]; then
    if [[ "$status" != 0 ]]; then capture_screen || true; fi
    timeout 5 "$ADB" -s "$SERIAL" forward --remove tcp:9222 >/dev/null 2>&1 || true
    timeout 8 "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
  fi
  if [[ -n "$EMU_PID" ]] && kill -0 "$EMU_PID" 2>/dev/null; then kill "$EMU_PID" 2>/dev/null || true; fi
  if [[ "$KVM_CHANGED" == true ]]; then sudo -n chmod "$KVM_MODE" /dev/kvm || true; fi
  # Only our unique ephemeral AVD directory, never SDKs or existing devices.
  rm -rf -- "$WORK"
  exit "$status"
}
trap cleanup EXIT
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  sudo -n chmod 666 /dev/kvm
  KVM_CHANGED=true
fi
printf 'no\n' | timeout 90 "$AVDMANAGER" create avd --name "$AVD" --package "$IMAGE" --device pixel_6
# Pick an unused emulator console/ADB pair, never connect to an existing device.
PORT=''
for candidate in $(seq 5580 2 5680); do
  if [[ -z "$(ss -ltnH "sport = :$candidate")" && -z "$(ss -ltnH "sport = :$((candidate + 1))")" ]]; then PORT="$candidate"; break; fi
done
[[ -n "$PORT" ]] || { echo 'No available emulator port' >&2; exit 1; }
SERIAL="emulator-$PORT"
"$EMULATOR" -avd "$AVD" -port "$PORT" -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -accel on -cores 2 -memory 3072 -camera-back none -camera-front none >"$ROOT/output/android-emulator.log" 2>&1 &
EMU_PID=$!
boot_deadline=$((SECONDS + 180))
booted=false
while (( SECONDS < boot_deadline )); do
  kill -0 "$EMU_PID" 2>/dev/null || { echo 'Emulator exited before boot' >&2; exit 1; }
  if [[ "$(timeout 5 "$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then booted=true; break; fi
  sleep 2
done
[[ "$booted" == true ]] || { echo 'Emulator boot timed out (180s)' >&2; exit 1; }
timeout 15 "$ADB" -s "$SERIAL" shell input keyevent 82 >/dev/null
# A new named AVD guarantees the first install starts with no user data.
timeout 90 "$ADB" -s "$SERIAL" install "$APK"
launch_and_forward() {
  local component pid socket deadline
  component="$(timeout 15 "$ADB" -s "$SERIAL" shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "$PACKAGE" | tr -d '\r' | tail -n 1)"
  [[ "$component" == "$PACKAGE/"* && "$component" != *' '* ]] || { echo 'Cannot resolve installed package launcher' >&2; return 1; }
  timeout 30 "$ADB" -s "$SERIAL" shell am start -W -n "$component" >/dev/null
  deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    pid="$(timeout 5 "$ADB" -s "$SERIAL" shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' | awk '{print $1}')" || pid=''
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      socket="$(timeout 5 "$ADB" -s "$SERIAL" shell cat /proc/net/unix 2>/dev/null | tr -d '\r' | awk -v socket="@webview_devtools_remote_$pid" '$NF == socket {print substr($NF,2); exit}')" || socket=''
      if [[ -n "$socket" ]]; then
        timeout 10 "$ADB" -s "$SERIAL" forward --no-rebind tcp:9222 "localabstract:$socket"
        export TRAINORACLE_ANDROID_SERIAL="$SERIAL" TRAINORACLE_ANDROID_PID="$pid" TRAINORACLE_ANDROID_SOCKET="$socket"
        return 0
      fi
    fi
    sleep 1
  done
  echo 'App PID or matching WebView debug socket timed out' >&2
  return 1
}
launch_and_forward
timeout 150 node scripts/android-runtime-probe.mjs --phase write
timeout 15 "$ADB" -s "$SERIAL" shell am force-stop "$PACKAGE"
timeout 10 "$ADB" -s "$SERIAL" forward --remove tcp:9222
# This exact same APK is updated in place. NEVER uninstall or clear app data.
timeout 90 "$ADB" -s "$SERIAL" install -r "$APK"
launch_and_forward
timeout 150 node scripts/android-runtime-probe.mjs --phase read
capture_screen
printf '%s\n' 'Installed Android WebView runtime and same-APK persistence probes passed.'
