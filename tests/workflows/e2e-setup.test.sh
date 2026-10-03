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
  cp "$here/stubs/sudo" "$here/stubs/apt-get" "$here/stubs/sleep" "$FIX/bin/"
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
check 'installs PulseAudio and pactl' contains "$FIX/calls" 'sudo apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils'
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

echo 'the MP4 fixture pin'
pin=$(sed -n "s/^ *sha256: '\([0-9a-f]\{64\}\)',\$/\1/p" "$root/tests/e2e/mp4Fixture.mjs")
: > "$here/output"
(cd "$root" && GITHUB_OUTPUT=$here/output run_step "$here/pin.sh") > "$here/pin.out" 2>&1
check 'succeeds' test $? -eq 0
check 'mp4Fixture.mjs pins one SHA-256' test "${#pin}" -eq 64
check 'the cache key is that SHA-256' contains "$here/output" "sha256=$pin"
check 'logs it' contains "$here/pin.out" "sample.mp4 is pinned to SHA-256 $pin"

finish
