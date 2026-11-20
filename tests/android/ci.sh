#!/bin/bash
# The Android workflow's step inside the running emulator (.github/workflows/android.yml): installs Firefox for
# Android, starts geckodriver and runs smoke.mjs on the build. One command, as android-emulator-runner runs each
# line of its script in a shell of its own.
#   tests/android/ci.sh <fenix.apk> <geckodriver> <out folder>
set -euo pipefail
apk=$1
geckodriver=$2
out=$3
mkdir -p "$out"
adb install -r "$apk"
"$geckodriver" --port 4444 --allow-system-access > "$out/geckodriver.log" 2>&1 &
geckodriver_pid=$!
trap 'kill "$geckodriver_pid" 2> /dev/null || true; timeout 30 adb logcat -d > "$out/logcat.txt" 2> /dev/null || true' EXIT
node tests/android/smoke.mjs --build build_firefox_github --media tests/e2e/fixtures/sample.mp4 \
  --geckodriver http://127.0.0.1:4444 --device emulator-5554 --out "$out"
