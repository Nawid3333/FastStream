#!/usr/bin/env bash
# update-prs.yml's "Wait for the CI run" step: on workflow_dispatch, the run it is pointed
# at, checked to be a CI run of an update branch of this repository, once it has ended.
# gh and sleep are stubbed (gh with a fake runs API serving $STATE/run.json, with
# pending-poll / never / api_fails modes, and sleep with a recorder); jq, timeout and the
# rest of coreutils run for real. Every gh call is logged to $STATE/gh.log. KEEP=1 keeps
# the scenarios' temp folders. This test keeps its own check and run_step.
source "$(dirname "$0")/lib.sh"
KEEP=${KEEP:-0}
STEP=$(mktemp)
step_script update-prs.yml 'Wait for the CI run' > "$STEP" || exit 1
base_path=$PATH
checks=0
fails=0
TDIRS=()
scenario=
rc=0
T=
STATE=
BIN=
RUNNER_TEMP=
GITHUB_OUTPUT=

cleanup() { rm -f "$STEP"; if [ "$KEEP" != 1 ]; then rm -rf "${TDIRS[@]}"; fi; }
trap cleanup EXIT

check() {
  local desc=$1
  shift
  checks=$((checks + 1))
  if "$@"; then
    printf 'PASS %s: %s\n' "$scenario" "$desc"
  else
    printf 'FAIL %s: %s\n' "$scenario" "$desc"
    tail -n 25 "$T/out"
    tail -n 25 "$STATE/gh.log"
    fails=$((fails + 1))
  fi
}

run_step() {
  rc=0
  (cd "$T" && timeout 60 bash -e "$STEP") > "$T/out" 2>&1 || rc=$?
}

gh_calls() { wc -l < "$STATE/gh.log" | tr -d '[:space:]'; }
four_output_lines() { # the step's GITHUB_OUTPUT for the default completed successful run
  printf 'attempt=1\nurl=https://github.com/me/fs/actions/runs/555\nconclusion=success\nsha=07df6bfe1ba4072bc694c038868a36d209870bb0\n'
}

RUN_JSON='{"id":555,"path":".github/workflows/ci.yml","status":"completed","conclusion":"success","run_attempt":1,"html_url":"https://github.com/me/fs/actions/runs/555","head_branch":"toolchain/pnpm-11.27.1","head_sha":"07df6bfe1ba4072bc694c038868a36d209870bb0","head_repository":{"full_name":"me/fs"}}'

set_run() { # <filter> [jq options...]: rewrite fields of $STATE/run.json, e.g. set_run '.head_branch = "x"'
  jq "$@" "$STATE/run.json" > "$STATE/run.json.new" && mv "$STATE/run.json.new" "$STATE/run.json"
}

write_stubs() {
  cat > "$BIN/gh" <<'GHSTUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STATE/gh.log"
if [ "${1-}" != api ] || [[ ! ${2-} =~ ^repos/me/fs/actions/runs/[0-9]+$ ]]; then
  echo "stub gh: unhandled: $*" >&2
  exit 99
fi
if [ -e "$STATE/api_fails" ]; then
  echo "stub gh: the runs API failed (api_fails exists)" >&2
  exit 1
fi
n=0
if [ -s "$STATE/polls" ]; then n=$(cat "$STATE/polls"); fi
case $n in ''|*[!0-9]*) n=0;; esac
n=$((n + 1))
printf '%s\n' "$n" > "$STATE/polls"
p=0
if [ -s "$STATE/pending_polls" ]; then p=$(cat "$STATE/pending_polls"); fi
case $p in ''|*[!0-9]*) p=0;; esac
if [ -e "$STATE/never" ] || [ "$n" -le "$p" ]; then
  jq '.status = "in_progress" | .conclusion = null' "$STATE/run.json"
else
  cat "$STATE/run.json"
fi
GHSTUB
  chmod +x "$BIN/gh"
  cat > "$BIN/sleep" <<'SLEEPSTUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STATE/sleeps"
SLEEPSTUB
  chmod +x "$BIN/sleep"
}

setup() { # <dir-tag> [scenario label]: a fresh temp dir with STATE, stubs, env and run.json
  scenario=${2:-$1}
  T=$(mktemp -d "${TMPDIR:-/tmp}/wait-step-$1.XXXXXX")
  TDIRS+=("$T")
  STATE=$T/state
  BIN=$T/bin
  RUNNER_TEMP=$T/runner-temp
  GITHUB_OUTPUT=$T/github-output
  GH_TOKEN=x
  GH_REPO=me/fs
  RUN_ID=555
  BRANCH='toolchain/pnpm-11.27.1'
  export STATE RUNNER_TEMP GITHUB_OUTPUT GH_TOKEN GH_REPO RUN_ID BRANCH
  PATH=$BIN:$base_path
  export PATH
  mkdir -p "$STATE" "$BIN" "$RUNNER_TEMP"
  : > "$STATE/gh.log"
  : > "$STATE/sleeps"
  printf '0\n' > "$STATE/polls"
  : > "$GITHUB_OUTPUT"
  write_stubs
  printf '%s\n' "$RUN_JSON" > "$STATE/run.json"
}

setup_done_at_once() {
  setup done_at_once
  run_step
  check 'exit code 0' [ "$rc" -eq 0 ]
  check 'GITHUB_OUTPUT is exactly the four lines, in order' diff -u <(four_output_lines) "$GITHUB_OUTPUT"
  check 'exactly one gh call' [ "$(gh_calls)" -eq 1 ]
  check "the gh call is 'api repos/me/fs/actions/runs/555'" [ "$(cat "$STATE/gh.log")" = 'api repos/me/fs/actions/runs/555' ]
  check 'no sleep' [ ! -s "$STATE/sleeps" ]
}

setup_done_after_two_polls() {
  setup done_after_two_polls
  printf '2\n' > "$STATE/pending_polls"
  run_step
  check 'exit code 0' [ "$rc" -eq 0 ]
  check 'three gh calls' [ "$(gh_calls)" -eq 3 ]
  check 'two sleeps, each 10' diff -u <(printf '10\n10\n') "$STATE/sleeps"
  check 'GITHUB_OUTPUT as in done_at_once' diff -u <(four_output_lines) "$GITHUB_OUTPUT"
}

setup_never_done() {
  setup never_done
  : > "$STATE/never"
  run_step
  check 'exit code 1' [ "$rc" -eq 1 ]
  check 'exactly 30 gh calls' [ "$(gh_calls)" -eq 30 ]
  check 'output says the run did not end within five minutes' grep -F 'did not end within five minutes' "$T/out"
  check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
}

setup_failed_run() {
  setup failed_run
  set_run '.conclusion = "failure" | .run_attempt = 2'
  run_step
  check 'exit code 0' [ "$rc" -eq 0 ]
  check 'GITHUB_OUTPUT has conclusion=failure' grep -Fx 'conclusion=failure' "$GITHUB_OUTPUT"
  check 'GITHUB_OUTPUT has attempt=2' grep -Fx 'attempt=2' "$GITHUB_OUTPUT"
}

BAD_RUN_IDS=('abc' '' '12a' '12; touch pwned' '-1' ' 12' '$(touch pwned)' $'12\n456')

setup_bad_run_ids() {
  local rid
  for rid in "${BAD_RUN_IDS[@]}"; do
    setup bad_run_ids "bad_run_ids: RUN_ID '$rid'"
    export RUN_ID="$rid"
    run_step
    check 'exit code 1' [ "$rc" -eq 1 ]
    check 'no gh call at all' [ ! -s "$STATE/gh.log" ]
    check 'no file named pwned anywhere in the scenario dir' [ -z "$(find "$T" -name pwned -print -quit)" ]
    check "output says the run id is not a run's number" grep -F "is not a run's number" "$T/out"
    check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
  done
}

setup_other_workflow() {
  setup other_workflow
  set_run '.path = ".github/workflows/release.yml"'
  run_step
  check 'exit code 1' [ "$rc" -eq 1 ]
  check 'output says the run is not a CI run' grep -F 'is not a CI run' "$T/out"
  check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
}

setup_path_with_ref() {
  setup path_with_ref
  set_run '.path = ".github/workflows/ci.yml@refs/heads/main"'
  run_step
  check 'exit code 0 (a path with a ref is accepted)' [ "$rc" -eq 0 ]
}

LOOKALIKE_PATHS=('.github/workflows/xci.yml' '.github/workflows/ci.yml.bak' 'x/.github/workflows/ci.yml' '.github/workflows/ci.yml2@refs/heads/main')

setup_lookalike_paths() {
  local p
  for p in "${LOOKALIKE_PATHS[@]}"; do
    setup lookalike_paths "lookalike_paths: path '$p'"
    set_run '.path = $p' --arg p "$p"
    run_step
    check 'exit code 1' [ "$rc" -eq 1 ]
    check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
  done
}

setup_other_repo() {
  setup other_repo
  set_run '.head_repository.full_name = "evil/fs"'
  run_step
  check 'exit code 1' [ "$rc" -eq 1 ]
  check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
}

setup_branch_mismatch() {
  setup branch_mismatch
  set_run '.head_branch = "toolchain/pnpm-11.28.0"'
  run_step
  check 'exit code 1' [ "$rc" -eq 1 ]
  check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
}

UPDATE_BRANCHES=('dependabot/npm_and_yarn/x-1' 'dependabot/github_actions/y' 'toolchain/node-26' 'patched/hls.js-1.7.0' 'sync/upstream')

setup_update_branches_accepted() {
  local br
  for br in "${UPDATE_BRANCHES[@]}"; do
    setup update_branches "update_branches_accepted: BRANCH '$br'"
    export BRANCH="$br"
    set_run '.head_branch = $b' --arg b "$br"
    run_step
    check 'exit code 0' [ "$rc" -eq 0 ]
  done
}

OTHER_BRANCHES=('feature/x' 'main' 'sync/upstream-2' 'xdependabot/a' 'my/toolchain/a' 'sync/upstreamx')

setup_other_branches_refused() {
  local br
  for br in "${OTHER_BRANCHES[@]}"; do
    setup other_branches "other_branches_refused: BRANCH '$br'"
    export BRANCH="$br"
    set_run '.head_branch = $b' --arg b "$br"
    run_step
    check 'exit code 1' [ "$rc" -eq 1 ]
    check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
  done
}

setup_api_fails() {
  setup api_fails
  : > "$STATE/api_fails"
  run_step
  check 'exit code 1, not stopped by the timeout' [ "$rc" -eq 1 ]
  check 'at once: one gh call' [ "$(gh_calls)" -eq 1 ]
  check 'no sleep' [ ! -s "$STATE/sleeps" ]
  check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
}

setup_null_head_repository() {
  setup null_head_repository
  set_run '.head_repository = null'
  run_step
  check 'exit code 1 (a deleted fork is refused)' [ "$rc" -eq 1 ]
  check 'GITHUB_OUTPUT empty' [ ! -s "$GITHUB_OUTPUT" ]
}

setup_done_at_once
setup_done_after_two_polls
setup_never_done
setup_failed_run
setup_bad_run_ids
setup_other_workflow
setup_path_with_ref
setup_lookalike_paths
setup_other_repo
setup_branch_mismatch
setup_update_branches_accepted
setup_other_branches_refused
setup_api_fails
setup_null_head_repository

printf '%d checks, %d failed\n' "$checks" "$fails"
[ "$fails" -eq 0 ]
