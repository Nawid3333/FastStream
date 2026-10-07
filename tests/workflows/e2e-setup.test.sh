#!/usr/bin/env bash
# .github/actions/e2e-setup's own scripts (the action every e2e job uses).
#
# "Give Firefox a sound device" (#265): on a runner with no sound server it installs
# PulseAudio when it is missing, starts it, loads a null sink, makes it the default and
# exports PULSE_SERVER and E2E_SOUND_SINK for Firefox and the specs; a server already
# running is used as it is; a daemon or sink that does not come up fails the step by
# name. pactl, pulseaudio, sudo, apt-get and sleep are stubs; PATH holds nothing else but
# bash and sed, so the runner's own tools (or WSL's) never answer for them.
#
# "Install ffmpeg": see its scenarios below.
#
# "Read the MP4 fixture's pin" (#256): the cache key is the SHA-256 mp4Fixture.mjs pins.
source "$(dirname "$0")/lib.sh"

root=$(cd "$(dirname "$0")/../.." && pwd)
here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script ../actions/e2e-setup/action.yml 'Give Firefox a sound device' > "$here/sound.sh" || exit 1
step_script ../actions/e2e-setup/action.yml "Read the MP4 fixture's pin" > "$here/pin.sh" || exit 1

# Stubs. Each records its call in $FIX/calls; the scenario's files in $FIX decide what
# it answers.
mkdir -p "$here/stubs" "$here/sys"
for tool in bash sed; do
  ln -s "$(command -v "$tool")" "$here/sys/$tool"
done

cat > "$here/stubs/pactl" <<'EOF'
#!/bin/bash
echo "pactl $*" >> "$FIX/calls"
case "$1" in
  info)
    [ -e "$FIX/running" ] || exit 1
    printf 'Server String: /run/user/1001/pulse/native\nServer Name: pulseaudio\nDefault Sink: %s\n' \
      "$(cat "$FIX/default" 2>/dev/null)"
    ;;
  load-module)
    [ -e "$FIX/running" ] && [ ! -e "$FIX/sink-fails" ] || exit 1
    echo 536870913
    ;;
  set-default-sink)
    printf '%s' "$2" > "$FIX/default"
    ;;
  list)
    echo '1	faststream_e2e	module-null-sink.c	s16le 2ch 44100Hz	IDLE'
    ;;
esac
EOF
cat > "$here/stubs/pulseaudio" <<'EOF'
#!/bin/bash
echo "pulseaudio $*" >> "$FIX/calls"
[ -e "$FIX/start-fails" ] && exit 1
: > "$FIX/running"
EOF
cat > "$here/stubs/sudo" <<'EOF'
#!/bin/bash
echo "sudo $*" >> "$FIX/calls"
"$@"
EOF
# timeout runs the command, past its options; with apt-hangs-once, the first apt-get
# update is one that fell silent: timeout kills it at the limit and exits 124.
cat > "$here/stubs/timeout" <<'EOF'
#!/bin/bash
echo "timeout $*" >> "$FIX/calls"
[ "$1" = -k ] && shift 2
shift
if [ -e "$FIX/apt-hangs-once" ] && [ ! -e "$FIX/hung" ] && [ "$1 $2" = 'apt-get update' ]; then
  : > "$FIX/hung"
  echo 'apt-get update (fell silent, killed at the limit)' >> "$FIX/calls"
  exit 124
fi
"$@"
EOF
# apt-get "installs" pulseaudio and pactl: copies their stubs into the scenario's bin.
cat > "$here/stubs/apt-get" <<'EOF'
#!/bin/bash
echo "apt-get $*" >> "$FIX/calls"
[ -e "$FIX/apt-fails" ] && exit 100
if [ "$1" = install ]; then
  cp "$STUBS/pulseaudio" "$STUBS/pactl" "$FIX/bin/"
fi
EOF
cat > "$here/stubs/sleep" <<'EOF'
#!/bin/bash
echo "sleep $*" >> "$FIX/calls"
EOF
chmod +x "$here/stubs/"*

# scenario <name> <what the runner has: none|installed|running> [flag files...]
scenario() {
  echo "$1"
  export FIX="$here/fix" STUBS="$here/stubs"
  rm -rf "$FIX"
  mkdir -p "$FIX/bin"
  cp "$here/stubs/sudo" "$here/stubs/timeout" "$here/stubs/apt-get" "$here/stubs/sleep" "$FIX/bin/"
  case "$2" in
    installed) cp "$here/stubs/pulseaudio" "$here/stubs/pactl" "$FIX/bin/" ;;
    running) cp "$here/stubs/pulseaudio" "$here/stubs/pactl" "$FIX/bin/"; : > "$FIX/running" ;;
  esac
  shift 2
  for flag in "$@"; do : > "$FIX/$flag"; done
  # cp is the stubs' own (apt-get's); the step itself gets only bash and sed.
  ln -s "$(command -v cp)" "$FIX/bin/cp"
  ln -s "$(command -v cat)" "$FIX/bin/cat"
  : > "$FIX/calls"
  : > "$FIX/env"
  GITHUB_ENV=$FIX/env PATH="$FIX/bin:$here/sys" run_step "$here/sound.sh" > "$FIX/out" 2>&1
  status=$?
}

scenario 'a runner with no sound server: GitHub Ubuntu' none
check 'succeeds' test "$status" -eq 0
check 'installs PulseAudio and pactl' contains "$FIX/calls" 'apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils'
check '... each apt run under a hard limit' contains "$FIX/calls" 'sudo timeout -k 10 300 apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils'
check '... the update too' contains "$FIX/calls" 'sudo timeout -k 10 120 apt-get update'
check 'starts the daemon, with no idle exit' contains "$FIX/calls" 'pulseaudio --start --exit-idle-time=-1'
check 'loads the null sink' contains "$FIX/calls" 'pactl load-module module-null-sink sink_name=faststream_e2e sink_properties=device.description=FastStream-e2e'
check 'makes it the default' contains "$FIX/calls" 'pactl set-default-sink faststream_e2e'
check 'gives Firefox the server' contains "$FIX/env" 'PULSE_SERVER=unix:/run/user/1001/pulse/native'
check 'tells the specs the sink' contains "$FIX/env" 'E2E_SOUND_SINK=faststream_e2e'
check 'logs pactl info, the default sink included' contains "$FIX/out" 'Default Sink: faststream_e2e'
check 'logs the sinks' contains "$FIX/out" 'faststream_e2e	module-null-sink.c'
check 'reports nothing' lacks "$FIX/out" '::error::'

scenario 'PulseAudio installed, not running' installed
check 'succeeds' test "$status" -eq 0
check 'installs nothing' lacks "$FIX/calls" 'apt-get'
check 'starts the daemon' contains "$FIX/calls" 'pulseaudio --start'
check 'gives Firefox the server' contains "$FIX/env" 'PULSE_SERVER=unix:/run/user/1001/pulse/native'

scenario 'a sound server running already' running
check 'succeeds' test "$status" -eq 0
check 'installs nothing' lacks "$FIX/calls" 'apt-get'
check 'starts nothing' lacks "$FIX/calls" 'pulseaudio'
check 'says so' contains "$FIX/out" 'A sound server is running already; using it.'
check 'still loads the null sink' contains "$FIX/calls" 'pactl load-module module-null-sink'
check 'gives Firefox the server' contains "$FIX/env" 'PULSE_SERVER=unix:/run/user/1001/pulse/native'

scenario 'a daemon that does not start' installed start-fails
check 'fails' test "$status" -ne 0
check 'says why' contains "$FIX/out" '::error::PulseAudio did not start.'
check 'exports nothing' test ! -s "$FIX/env"

scenario 'a null sink that does not load' installed sink-fails
check 'fails' test "$status" -ne 0
check 'names the sink' contains "$FIX/out" '::error::PulseAudio would not load the null sink faststream_e2e.'
check 'logs pactl info' contains "$FIX/out" 'Server String: /run/user/1001/pulse/native'
check 'exports nothing' test ! -s "$FIX/env"

scenario 'apt that keeps failing' none apt-fails
check 'fails' test "$status" -ne 0
check 'tried three times' test "$(grep -c '^apt-get update' "$FIX/calls")" -eq 3
check 'warned each time' test "$(grep -c '::warning::Installing PulseAudio failed' "$FIX/out")" -eq 3
check 'says the daemon did not start' contains "$FIX/out" '::error::PulseAudio did not start.'

# "Install ffmpeg" (2026-10-06): Linux installs ffmpeg and PulseAudio in one apt run with
# no recommended packages; Windows takes ffmpeg.exe and ffprobe.exe from the week's cache
# entry, and on a miss installs through Chocolatey and copies the two programs out for the
# save step. choco, cygpath and ffmpeg are stubs as well; find, dirname and mkdir are the
# system's.
step_script ../actions/e2e-setup/action.yml 'Install ffmpeg' > "$here/ffmpeg.sh" || exit 1
cat > "$here/stubs/ffmpeg" <<'EOF'
#!/bin/bash
echo "ffmpeg $* ($0)" >> "$FIX/calls"
echo 'ffmpeg version 9.0.2-essentials_build-www.gyan.dev'
EOF
# choco "installs" ffmpeg where Chocolatey puts it, and its shim on PATH; with the flag
# file choco-no-bin, without the programs under bin/ (a changed package layout).
cat > "$here/stubs/choco" <<'EOF'
#!/bin/bash
echo "choco $*" >> "$FIX/calls"
[ -e "$FIX/choco-fails" ] && exit 1
bin="$ChocolateyInstall/lib/ffmpeg/tools/ffmpeg/bin"
mkdir -p "$bin"
[ -e "$FIX/choco-no-bin" ] || printf 'exe' > "$bin/ffmpeg.exe"
[ -e "$FIX/choco-no-bin" ] || printf 'exe' > "$bin/ffprobe.exe"
cp "$STUBS/ffmpeg" "$FIX/bin/ffmpeg"
EOF
# cygpath: -u leaves the path (the stub's ChocolateyInstall is a POSIX path already), -w
# marks it, so the test sees which form went to GITHUB_PATH.
cat > "$here/stubs/cygpath" <<'EOF'
#!/bin/bash
case "$1" in
  -u) printf '%s\n' "$2" ;;
  -w) printf 'WIN:%s\n' "$2" ;;
  *) exit 2 ;;
esac
EOF
# tee "writes" the apt settings file: kept in the scenario's folder, by its name.
cat > "$here/stubs/tee" <<'EOF'
#!/bin/bash
echo "tee $*" >> "$FIX/calls"
cat > "$FIX/tee-${1##*/}"
EOF
chmod +x "$here/stubs/"*
for tool in find dirname mkdir; do
  ln -sf "$(command -v "$tool")" "$here/sys/$tool"
done

# ffmpeg_scenario <name> <Linux|Windows> <cache hit: true|empty> [flag files...]
ffmpeg_scenario() {
  echo "$1"
  export FIX="$here/fix" STUBS="$here/stubs"
  rm -rf "$FIX"
  mkdir -p "$FIX/bin" "$FIX/home" "$FIX/choco"
  cp "$here/stubs/sudo" "$here/stubs/timeout" "$here/stubs/apt-get" "$here/stubs/sleep" "$here/stubs/choco" "$here/stubs/cygpath" "$here/stubs/tee" "$FIX/bin/"
  ln -s "$(command -v cp)" "$FIX/bin/cp"
  ln -sf "$(command -v cat)" "$FIX/bin/cat"
  # apt-get's "install" gives ffmpeg too, as the package does.
  [ "$2" = Linux ] && cp "$here/stubs/ffmpeg" "$FIX/bin/ffmpeg"
  local os=$2 hit=$3
  shift 3
  for flag in "$@"; do : > "$FIX/$flag"; done
  # A cache hit: the two programs in ~/ffmpeg-e2e, and an ffmpeg there that bash finds
  # (on Windows it finds ffmpeg.exe by that name).
  if [ -e "$FIX/cache-has" ]; then
    mkdir -p "$FIX/home/ffmpeg-e2e"
    printf 'exe' > "$FIX/home/ffmpeg-e2e/ffmpeg.exe"
    printf 'exe' > "$FIX/home/ffmpeg-e2e/ffprobe.exe"
    cp "$here/stubs/ffmpeg" "$FIX/home/ffmpeg-e2e/ffmpeg"
  fi
  # A cache entry from before ffprobe was in it: ffmpeg.exe alone.
  if [ -e "$FIX/cache-ffmpeg-only" ]; then
    mkdir -p "$FIX/home/ffmpeg-e2e"
    printf 'exe' > "$FIX/home/ffmpeg-e2e/ffmpeg.exe"
  fi
  : > "$FIX/calls"
  : > "$FIX/output"
  : > "$FIX/path"
  RUNNER_OS=$os CACHE_HIT=$hit HOME=$FIX/home ChocolateyInstall=$FIX/choco \
    GITHUB_OUTPUT=$FIX/output GITHUB_PATH=$FIX/path PATH="$FIX/bin:$here/sys" \
    run_step "$here/ffmpeg.sh" > "$FIX/out" 2>&1
  status=$?
}

ffmpeg_scenario 'Linux: ffmpeg and PulseAudio, one apt run' Linux ''
check 'succeeds' test "$status" -eq 0
check 'updates the package lists once' test "$(grep -c '^apt-get update' "$FIX/calls")" -eq 1
check 'installs both, nothing only recommended' contains "$FIX/calls" \
  'apt-get install -y --no-install-recommends ffmpeg pulseaudio pulseaudio-utils'
# A mirror that fell silent with nothing to time out held both Linux playback jobs for 19
# minutes (2026-10-07).
check 'each apt run under a hard limit' contains "$FIX/calls" \
  'sudo timeout -k 10 300 apt-get install -y --no-install-recommends ffmpeg pulseaudio pulseaudio-utils'
check '... the update too' contains "$FIX/calls" 'sudo timeout -k 10 120 apt-get update'
check 'logs the version' contains "$FIX/out" 'ffmpeg version'
check 'no Chocolatey' lacks "$FIX/calls" 'choco'
check 'adds nothing to PATH' test ! -s "$FIX/path"
check 'saves nothing' test ! -s "$FIX/output"
# A mirror that stopped sending held the step for 19 minutes (2026-10-06).
check 'sets apt to give up on a stalled download' contains "$FIX/calls" 'sudo tee /etc/apt/apt.conf.d/99-faststream-e2e-timeouts'
check '... after 30 s without data' contains "$FIX/tee-99-faststream-e2e-timeouts" 'Acquire::http::Timeout "30";'
check '... and to retry it' contains "$FIX/tee-99-faststream-e2e-timeouts" 'Acquire::Retries "3";'
check '... before apt runs' test "$(grep -n -m1 '^tee ' "$FIX/calls" | cut -d: -f1)" -lt "$(grep -n -m1 '^apt-get update' "$FIX/calls" | cut -d: -f1)"

ffmpeg_scenario 'Linux: an apt update that falls silent is cut off, and the next attempt runs' Linux '' apt-hangs-once
check 'succeeds' test "$status" -eq 0
check 'the first update was killed at its limit' contains "$FIX/calls" 'apt-get update (fell silent, killed at the limit)'
check 'warned once' test "$(grep -c '::warning::Installing ffmpeg failed' "$FIX/out")" -eq 1
check 'waited 30 s' contains "$FIX/calls" 'sleep 30'
check 'then updated again' test "$(grep -c '^apt-get update$' "$FIX/calls")" -eq 1
check 'installed once' test "$(grep -c '^apt-get install' "$FIX/calls")" -eq 1
check 'logs the version' contains "$FIX/out" 'ffmpeg version'

ffmpeg_scenario 'Windows, a cache hit: the cached programs, no Chocolatey' Windows true cache-has
check 'succeeds' test "$status" -eq 0
check 'says so' contains "$FIX/out" "ffmpeg from the cache ($FIX/home/ffmpeg-e2e)."
check 'no Chocolatey' lacks "$FIX/calls" 'choco'
check 'puts the folder on PATH for the later steps, as a Windows path' contains "$FIX/path" "WIN:$FIX/home/ffmpeg-e2e"
check 'runs the cached ffmpeg itself' contains "$FIX/calls" "($FIX/home/ffmpeg-e2e/ffmpeg)"
check 'saves nothing' test ! -s "$FIX/output"

ffmpeg_scenario 'Windows, a hit that lacks ffprobe: installs as on a miss' Windows true cache-ffmpeg-only
check 'succeeds' test "$status" -eq 0
check 'installs through Chocolatey' contains "$FIX/calls" 'choco install ffmpeg -y --no-progress'
check 'and caches both programs this time' contains "$FIX/output" 'save=true'

ffmpeg_scenario 'Windows, a miss: Chocolatey, then the programs copied out for the save' Windows ''
check 'succeeds' test "$status" -eq 0
check 'installs through Chocolatey' contains "$FIX/calls" 'choco install ffmpeg -y --no-progress'
check 'no apt' lacks "$FIX/calls" 'apt-get'
check 'no apt settings' lacks "$FIX/calls" 'tee '
check 'copies ffmpeg.exe' test -f "$FIX/home/ffmpeg-e2e/ffmpeg.exe"
check 'copies ffprobe.exe' test -f "$FIX/home/ffmpeg-e2e/ffprobe.exe"
check 'asks the save step to save' contains "$FIX/output" 'save=true'
check 'puts the folder on PATH' contains "$FIX/path" "WIN:$FIX/home/ffmpeg-e2e"
check 'logs the version' contains "$FIX/out" 'ffmpeg version'

ffmpeg_scenario 'Windows, a miss where the programs are not under bin/: the shims, no save' Windows '' choco-no-bin
check 'succeeds' test "$status" -eq 0
check 'warns' contains "$FIX/out" "::warning::Chocolatey's ffmpeg.exe and ffprobe.exe were not found"
check 'saves nothing' test ! -s "$FIX/output"
check 'adds nothing to PATH' test ! -s "$FIX/path"
check 'still runs ffmpeg (the shim)' contains "$FIX/calls" "($FIX/bin/ffmpeg)"

ffmpeg_scenario 'Windows, Chocolatey that keeps failing' Windows '' choco-fails
check 'fails' test "$status" -ne 0
check 'tried three times' test "$(grep -c '^choco install' "$FIX/calls")" -eq 3
check 'warned each time' test "$(grep -c '::warning::Installing ffmpeg failed' "$FIX/out")" -eq 3
check 'saves nothing' test ! -s "$FIX/output"

echo 'the MP4 fixture pin'
pin=$(sed -n "s/^ *sha256: '\([0-9a-f]\{64\}\)',\$/\1/p" "$root/tests/e2e/mp4Fixture.mjs")
: > "$here/output"
(cd "$root" && GITHUB_OUTPUT=$here/output run_step "$here/pin.sh") > "$here/pin.out" 2>&1
check 'succeeds' test $? -eq 0
check 'mp4Fixture.mjs pins one SHA-256' test "${#pin}" -eq 64
check 'the cache key is that SHA-256' contains "$here/output" "sha256=$pin"
check 'logs it' contains "$here/pin.out" "sample.mp4 is pinned to SHA-256 $pin"

finish
