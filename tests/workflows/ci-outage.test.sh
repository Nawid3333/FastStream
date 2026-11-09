#!/usr/bin/env bash
# tools/ci-outage.sh: whether a failed CI run failed only on an outage (outage), on anything else
# (red), or cannot tell (unknown). Fixtures in the shapes gh gives: `run view --json jobs` and
# `run view --log-failed` (job<TAB>step<TAB>timestamp text), the lines from real runs of 2026-11-09.
source "$(dirname "$0")/lib.sh"
here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
classify=$(cd "$(dirname "$0")/../.." && pwd)/tools/ci-outage.sh
checks=0
fails=0

jobs() { # <name>=<conclusion>...
  local args=() pair
  for pair in "$@"; do args+=("{\"name\": \"${pair%=*}\", \"conclusion\": \"${pair##*=}\", \"steps\": []}"); done
  local IFS=,
  printf '{"jobs": [%s]}\n' "${args[*]}" > "$here/jobs.json"
}
log() { # <job> <text>: one line of a failed job's log
  printf '%s\tUNKNOWN STEP\t2026-11-09T07:35:02.1966082Z %s\n' "$1" "$2" >> "$here/failed.log"
}
expect() { # <description> <verdict>
  checks=$((checks + 1))
  local got
  got=$(bash "$classify" "$here/jobs.json" "$here/failed.log")
  if [ "$got" = "$2" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s: expected %s, got %s\n' "$1" "$2" "$got"
    fails=$((fails + 1))
  fi
  : > "$here/failed.log"
}
: > "$here/failed.log"

GECKO='Error: Failed to download binary (statusCode 504): '
jobs 'e2e (Windows, playback 3/3)=failure' 'e2e (Linux, extension 1/2)=failure' 'Lint workflows=success'
log 'e2e (Windows, playback 3/3)' "$GECKO"
log 'e2e (Linux, extension 1/2)' 'Error: Failed to fetch the latest Geckodriver version (statusCode 502): Bad Gateway'
expect "geckodriver's own download got a 5xx in every failed job" outage

jobs 'e2e (Windows, extension 1/3)=failure' 'e2e (Linux, playback 1/2)=failure'
log 'e2e (Windows, extension 1/3)' '##[error]FS-OUTAGE mpv: https://github.com/shinchiro/x.7z did not download: 504 Gateway Time-out'
log 'e2e (Linux, playback 1/2)' '##[error]FS-OUTAGE geckodriver: GitHub did not answer, and the runner image has none'
expect 'our download steps said FS-OUTAGE' outage

jobs 'Lint, test and build=failure'
log 'Lint, test and build' 'ERR_PNPM_FETCH_503 GET https://registry.npmjs.org/eslint: Service Unavailable - 503'
expect "pnpm's registry fetch got a 5xx" outage

jobs 'e2e (Windows, playback 3/3)=failure' 'e2e (Linux, playback 1/2)=failure'
log 'e2e (Windows, playback 3/3)' "$GECKO"
log 'e2e (Linux, playback 1/2)' '[0-13] FAILED in firefox - progress-loop.e2e.mjs (1 retries)'
log 'e2e (Linux, playback 1/2)' 'Expected: > 10'
expect 'one job an outage, one a test failure: red' red

jobs 'e2e (Linux, playback 1/2)=failure'
log 'e2e (Linux, playback 1/2)' 'Error: Failed to download binary (statusCode 404): Not Found'
expect 'a 404 is no outage' red

jobs 'e2e (Linux, playback 1/2)=failure'
log 'e2e (Linux, playback 1/2)' '[0-4] Error: the server answered 504 Gateway Time-out'
log 'e2e (Linux, playback 1/2)' 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/no-such: Not Found - 404'
expect 'a spec that tests a 504, and a 404 from the registry: red' red

jobs 'e2e (Linux, playback 1/2)=failure'
log 'e2e (Linux, playback 1/2)' "[36;1m  echo '::error::FS-OUTAGE geckodriver: GitHub did not answer'[0m"
log 'e2e (Linux, playback 1/2)' '##[error]geckodriver: https://github.com/x.tar.gz did not unpack to geckodriver, and the runner image has none'
expect 'the script text naming FS-OUTAGE, and an archive that did not unpack: red' red

jobs 'e2e (Windows, playback 3/3)=failure' 'e2e (Linux, playback 2/2)=cancelled'
log 'e2e (Windows, playback 3/3)' "$GECKO"
expect 'a cancelled job counts for nothing' outage

jobs 'e2e (Windows, playback 3/3)=timed_out'
log 'e2e (Windows, playback 3/3)' '[0-5] RUNNING in firefox - mp4-files.e2e.mjs'
expect 'a job that ran out of time with no signature: red' red

jobs 'e2e (Windows, playback 3/3)=failure' 'e2e (Linux, playback 2/2)=failure'
log 'e2e (Windows, playback 3/3)' "$GECKO"
expect 'one failed job without a log (a lost runner): unknown' unknown

jobs 'e2e (Windows, playback 3/3)=failure' 'e2e (Linux, playback 2/2)=failure'
log 'e2e (Linux, playback 2/2)' 'Expected: > 1'
expect 'one job without a log, one a test failure: red' red

jobs 'Lint workflows=success' 'e2e (Linux, playback 2/2)=cancelled'
expect 'no failed job at all: unknown' unknown

jobs 'e2e (Windows, playback 3/3)=failure'
rm -f "$here/failed.log"
expect 'no log file at all: unknown' unknown

printf '%s checks, %s failed\n' "$checks" "$fails"
[ "$fails" = 0 ]
