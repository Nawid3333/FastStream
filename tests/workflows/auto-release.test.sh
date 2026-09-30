#!/usr/bin/env bash
# auto-release.yml's decisions around a CI run on main, three of its steps:
#   restart  job restart-cancelled-ci, "Was a CI run on main cancelled by a later one?"
#   which    job auto-release, "Which CI run?"
#   head     job auto-release, "Is this commit still main's newest?"
# The stub gh answers from the scenario's JSON (COMMITS, RUNS, RUN, COMPARE, ISSUES) and
# applies each --jq filter with the real jq, so the steps' own filters are what is
# tested; git answers `ls-remote origin refs/heads/main` with $MAIN; sleep returns at
# once. A scenario names what the step must print (EXPECT=a|b), must not (LACKS=c|d),
# and its exit status (EXIT, 0 if not given); the step's outputs print as "out: k=v".
# This test keeps its own scenario and count.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
restart=$here/restart.sh which=$here/which.sh head=$here/head.sh
step_script auto-release.yml 'Was a CI run on main cancelled by a later one?' > "$restart" || exit 1
step_script auto-release.yml 'Which CI run?' > "$which" || exit 1
step_script auto-release.yml "Is this commit still main's newest?" > "$head" || exit 1
# The workflow's env, as GitHub sets it; INPUT_SHA is empty on a workflow_run event.
export GH_REPO=o/r GITHUB_REPOSITORY=o/r OWNER=owner GITHUB_SERVER_URL=https://github.com
export TITLE='CI on main needs a re-run' INPUT_SHA=''

# A CI run: id sha event HH:MM(run_started_at) status conclusion attempt
mk() {
  printf '{"id":%s,"head_sha":"%s","event":"%s","run_started_at":"2026-09-30T%s:00Z","status":"%s","conclusion":%s,"run_attempt":%s}' "$@"
}
arr() { local IFS=,; echo "[$*]"; }
# A commit as the commits and compare APIs give it: sha subject
cm() { printf '{"sha":"%s","commit":{"message":"%s\\n\\nbody"}}' "$1" "$2"; }

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
gh() {
  if [ "$1" = api ]; then
    local path=$2 filter='' body n
    shift 2
    while [ $# -gt 0 ]; do
      case $1 in --jq) filter=$2; shift 2 ;; *) shift ;; esac
    done
    case $path in
      'repos/o/r/commits?sha=main&per_page=30') body=$COMMITS ;;
      'repos/o/r/actions/workflows/ci.yml/runs?'*)
        [[ $path == *branch=main* ]] || { echo "runs query without branch=main: $path" >&2; return 1; }
        n=$(( $(cat "$RUNNER_TEMP/runs-calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$RUNNER_TEMP/runs-calls"
        if [ -f "$RUNNER_TEMP/rerun-called" ] && [ -n "${RUNS2:-}" ]; then body=$RUNS2
        elif [ -n "${RUNS_FROM_CALL:-}" ] && [ "$n" -ge "$RUNS_FROM_CALL" ]; then body=$RUNS2
        else body=$RUNS; fi
        body="{\"workflow_runs\":$body}" ;;
      repos/o/r/actions/runs/*)
        n=$(( $(cat "$RUNNER_TEMP/polls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$RUNNER_TEMP/polls"
        if [ "$n" = 1 ] && [ -n "${FAIL_FIRST:-}" ]; then echo 'HTTP 502' >&2; return 1; fi
        if [ "$n" -lt "${DONE_AT:-1}" ]; then body='{"status":"in_progress","conclusion":null}'; else body=$RUN; fi ;;
      "repos/o/r/compare/$HEAD_SHA...$MAIN") body=$COMPARE ;;
      *) echo "unexpected gh api $path" >&2; return 1 ;;
    esac
    if [ -n "$filter" ]; then jq -r "$filter" <<< "$body"; else echo "$body"; fi
    return
  fi
  case "$1 $2" in
    'issue list')
      [[ " $* " == *' --state open --limit 200 '* ]] || { echo "issue list not of all open issues: $*" >&2; return 1; }
      local filter=''
      while [ $# -gt 0 ]; do case $1 in --jq) filter=$2; shift 2 ;; *) shift ;; esac; done
      jq -r "$filter" <<< "${ISSUES:-[]}" ;;
    'issue create') echo ">> issue create ${*:3}"; sed 's/^/>> | /' "$RUNNER_TEMP/body.md" ;;
    'issue close') echo ">> issue close ${*:3}" ;;
    'run rerun') echo ">> rerun $3"; touch "$RUNNER_TEMP/rerun-called"; return "${RERUN_RC:-0}" ;;
    'workflow run') echo ">> workflow run ${*:3}" ;;
    *) echo "unexpected gh $*" >&2; return 1 ;;
  esac
}
gh "$@"
EOF
cat > "$here/bin/git" <<'EOF'
#!/usr/bin/env bash
[ "$*" = 'ls-remote origin refs/heads/main' ] || { echo "unexpected git $*" >&2; exit 1; }
printf '%s\trefs/heads/main\n' "$MAIN"
EOF
printf '#!/usr/bin/env bash\n' > "$here/bin/sleep"
chmod +x "$here/bin/gh" "$here/bin/git" "$here/bin/sleep"

pass=0 fail=0
# scenario <script var> <title> [EXPECT=a|b] [LACKS=c|d] [EXIT=n] [VAR=value]...
scenario() {
  local script=${!1} title=$2 expect='' lacks='' want=0 kv out code ok=1 e
  shift 2
  for kv in "$@"; do
    case $kv in EXPECT=*) expect=${kv#EXPECT=} ;; LACKS=*) lacks=${kv#LACKS=} ;; EXIT=*) want=${kv#EXIT=} ;; esac
  done
  out=$(
    exec 2>&1
    for kv in "$@"; do case $kv in EXPECT=*|LACKS=*|EXIT=*) ;; *) export "${kv?}" ;; esac; done
    RUNNER_TEMP=$(mktemp -d); GITHUB_OUTPUT=$RUNNER_TEMP/out; export RUNNER_TEMP GITHUB_OUTPUT
    trap 'if [ -s "$GITHUB_OUTPUT" ]; then sed "s/^/out: /" "$GITHUB_OUTPUT"; fi; rm -rf "$RUNNER_TEMP"' EXIT
    PATH="$here/bin:$PATH" run_step "$script"
  )
  code=$?
  [ "$code" = "$want" ] || ok=0
  if [ -n "$expect" ]; then IFS='|' read -ra list <<< "$expect"; for e in "${list[@]}"; do [[ $out == *"$e"* ]] || ok=0; done; fi
  if [ -n "$lacks" ]; then IFS='|' read -ra list <<< "$lacks"; for e in "${list[@]}"; do [[ $out != *"$e"* ]] || ok=0; done; fi
  if [ $ok = 1 ]; then
    pass=$((pass + 1)); echo "ok   $title"
  else
    fail=$((fail + 1)); echo "FAIL $title (exit $code, want $want)"; sed 's/^/     /' <<< "$out"
  fi
}

A=aaaa1111 B=bbbb2222 P=pppp3333 R=rrrr4444
bump=$(cm $R 'chore: release 1.3.82.44')
on_main() { arr "$@" "$bump"; }  # commits newest first, down to the last release bump
old_green=$(mk 1 $B push 10:00 completed '"success"' 1)

echo '######## restart-cancelled-ci'
scenario restart 'main is a release bump: nothing since' COMMITS="$(on_main)" RUNS="$(arr "$old_green")" \
  EXPECT='No commit on main since the last release has a CI run' LACKS='>> rerun'
scenario restart 'only run-less token pushes since the bump' COMMITS="$(on_main "$(cm $P 'ci: mpv 20260930')" "$(cm $A 'chore(deps): bump x (#80)')")" \
  RUNS="$(arr "$old_green")" EXPECT='No commit on main since the last release has a CI run' LACKS='>> rerun'
scenario restart 'its run is going' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 2 $A push 10:05 in_progress null 1)" "$old_green")" EXPECT='has one going' LACKS='>> rerun'
scenario restart 'its run is queued behind a cancelled one' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 3 $A push 10:06 queued null 1)" "$(mk 2 $A push 10:05 completed '"cancelled"' 1)")" EXPECT='has one going' LACKS='>> rerun'
scenario restart 'green, with the issue open: closed' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 2 $A push 10:05 completed '"success"' 1)")" ISSUES='[{"number":7,"title":"CI on main needs a re-run"},{"number":8,"title":"Other"}]' \
  EXPECT='has a green one|>> issue close 7 --comment CI on main is green again, on aaaa1111. Closing.' LACKS='>> issue close 8|>> rerun'
scenario restart 'red' COMMITS="$(on_main "$(cm $A 'fix: a')")" RUNS="$(arr "$(mk 2 $A push 10:05 completed '"failure"' 1)")" \
  EXPECT='concluded failure. Red is the release gate' LACKS='>> rerun'
scenario restart 'cancelled by hand: no run started after it' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 2 $A push 10:05 completed '"cancelled"' 1)" "$old_green")" EXPECT='cancelled by hand, so left alone' LACKS='>> rerun'
scenario restart 'the incident: a late push run of an older commit cancelled it' \
  COMMITS="$(on_main "$(cm $A 'feat: a (#70)')" "$(cm $B 'fix: b (#68)')")" \
  RUNS="$(arr "$(mk 3 $B push 10:06 in_progress null 1)" "$(mk 2 $A push 10:05 completed '"cancelled"' 1)" "$old_green")" \
  EXPECT='>> rerun 2' LACKS='issue create'
scenario restart 'only a fork PR run from a branch called main started later' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 3 cccc5555 pull_request 10:06 completed '"success"' 1)" "$(mk 2 $A push 10:05 completed '"cancelled"' 1)")" \
  EXPECT='cancelled by hand' LACKS='>> rerun'
scenario restart 'a dispatched CI run on main started later' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 3 $B workflow_dispatch 10:06 in_progress null 1)" "$(mk 2 $A push 10:05 completed '"cancelled"' 1)")" EXPECT='>> rerun 2' LACKS='issue create'
scenario restart 'attempt 2 cancelled by hand; the late run is from before attempt 2' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 3 $B push 10:06 completed '"cancelled"' 1)" "$(mk 2 $A push 10:09 completed '"cancelled"' 2)")" \
  EXPECT='cancelled by hand' LACKS='>> rerun'
scenario restart 'attempt 2 cancelled by another late run' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 4 $B push 10:10 in_progress null 1)" "$(mk 2 $A push 10:09 completed '"cancelled"' 2)")" EXPECT='(attempt 2)|>> rerun 2' LACKS='issue create'
scenario restart 'attempt 3 cancelled by a late run: issue' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 5 $B push 10:12 in_progress null 1)" "$(mk 2 $A push 10:11 completed '"cancelled"' 3)")" \
  EXPECT='>> issue create --title CI on main needs a re-run --assignee owner|@owner CI on main for aaaa1111 cannot finish: its attempt 3 was cancelled by a later run too|/actions/runs/2' LACKS='>> rerun'
scenario restart 'attempt 3 cancelled, the issue already open' COMMITS="$(on_main "$(cm $A 'fix: a')")" ISSUES='[{"number":7,"title":"CI on main needs a re-run"}]' \
  RUNS="$(arr "$(mk 5 $B push 10:12 in_progress null 1)" "$(mk 2 $A push 10:11 completed '"cancelled"' 3)")" \
  EXPECT='Already reported' LACKS='issue create|>> rerun'
scenario restart 'rerun refused, but started meanwhile' RERUN_RC=1 COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 3 $B push 10:06 in_progress null 1)" "$(mk 2 $A push 10:05 completed '"cancelled"' 1)")" \
  RUNS2="$(arr "$(mk 2 $A push 10:07 queued null 2)")" EXPECT='>> rerun 2|started meanwhile' LACKS='issue create'
scenario restart 'rerun refused, still cancelled: issue' RERUN_RC=1 COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 3 $B push 10:06 in_progress null 1)" "$(mk 2 $A push 10:05 completed '"cancelled"' 1)")" \
  EXPECT='>> rerun 2|GitHub refused to start run 2 again'
scenario restart 'an older green run and a newer cancelled one' COMMITS="$(on_main "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 4 $B push 10:07 in_progress null 1)" "$(mk 3 $A push 10:06 completed '"cancelled"' 1)" "$(mk 2 $A push 10:05 completed '"success"' 1)")" \
  EXPECT='has a green one' LACKS='>> rerun'
scenario restart 'a pin on top of a commit a late run cancelled: that commit is restarted' \
  COMMITS="$(on_main "$(cm $P 'ci: mpv 20260930')" "$(cm $A 'fix: a')" "$(cm $B 'fix: b')")" \
  RUNS="$(arr "$(mk 3 $B push 10:06 in_progress null 1)" "$(mk 2 $A push 10:05 completed '"cancelled"' 1)")" EXPECT='>> rerun 2|on aaaa1111' LACKS='issue create'
scenario restart 'a pin on top of a green commit' COMMITS="$(on_main "$(cm $P 'ci: mpv 20260930')" "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 2 $A push 10:05 completed '"success"' 1)")" EXPECT='aaaa1111, the newest commit on main with a CI run, has a green one' LACKS='>> rerun'
scenario restart 'CI dispatched on a pin, going' COMMITS="$(on_main "$(cm $P 'ci: mpv 20260930')" "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 3 $P workflow_dispatch 10:20 in_progress null 1)" "$(mk 2 $A push 10:05 completed '"success"' 1)")" EXPECT='pppp3333, the newest commit on main with a CI run, has one going'
scenario restart 'CI dispatched on a pin, cancelled by a late run' COMMITS="$(on_main "$(cm $P 'ci: mpv 20260930')" "$(cm $A 'fix: a')")" \
  RUNS="$(arr "$(mk 4 $B push 10:21 in_progress null 1)" "$(mk 3 $P workflow_dispatch 10:20 completed '"cancelled"' 1)" "$(mk 2 $A push 10:05 completed '"success"' 1)")" EXPECT='>> rerun 3' LACKS='issue create'

echo '######## Which CI run?'
good='{"status":"completed","conclusion":"success","path":".github/workflows/ci.yml","event":"push","head_branch":"main","head_repository":{"full_name":"o/r"},"head_commit":{"message":"fix: x"},"head_sha":"dddd4444"}'
with() { jq -c "$1" <<< "$good"; }
scenario which 'workflow_run event' EVENT=workflow_run EVENT_RUN_ID=11 EVENT_SHA=eeee5555 EXPECT='out: ok=yes|out: id=11|out: sha=eeee5555'
scenario which 'dispatch, run_id not a number' EVENT=workflow_dispatch INPUT_RUN_ID='12; echo pwned' EXIT=1 EXPECT="run_id is '12; echo pwned', not a CI run's id." LACKS='ok=yes'
scenario which 'dispatch, empty run_id' EVENT=workflow_dispatch INPUT_RUN_ID= EXIT=1 EXPECT="run_id is '', not a CI run's id." LACKS='ok=yes'
scenario which 'dispatch, a green push run on main' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$good" EXPECT='out: ok=yes|out: id=12|out: sha=dddd4444'
scenario which 'dispatch, a green dispatched CI run on main' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.event = "workflow_dispatch"')" EXPECT='out: ok=yes'
scenario which 'dispatch, the right commit given' EVENT=workflow_dispatch INPUT_RUN_ID=12 INPUT_SHA=dddd4444 RUN="$good" EXPECT='out: ok=yes|out: sha=dddd4444'
scenario which 'dispatch, another commit given' EVENT=workflow_dispatch INPUT_RUN_ID=12 INPUT_SHA=ffff9999 RUN="$good" EXIT=1 EXPECT='is not on ffff9999' LACKS='ok=yes'
scenario which 'dispatch, the first look fails' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$good" FAIL_FIRST=1 EXPECT='out: ok=yes'
scenario which 'dispatch, ended after 3 polls' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$good" DONE_AT=3 EXPECT='out: ok=yes'
scenario which 'dispatch, never ends' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$good" DONE_AT=99 EXIT=1 EXPECT='has not ended after 400 s' LACKS='ok=yes'
scenario which 'dispatch, red' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.conclusion = "failure"')" EXIT=1 EXPECT='concluded failure; nothing is released' LACKS='ok=yes'
scenario which 'dispatch, timed out' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.conclusion = "timed_out"')" EXIT=1 LACKS='ok=yes'
scenario which 'dispatch, cancelled' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.conclusion = "cancelled"')" EXPECT='it concluded cancelled|out: ok=no'
scenario which 'dispatch, another workflow' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.path = ".github/workflows/release.yml"')" EXPECT='it is not a CI run|out: ok=no'
scenario which 'dispatch, a pull request run' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.event = "pull_request"')" EXPECT='pull_request event|out: ok=no'
scenario which 'dispatch, another branch' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.head_branch = "dev"')" EXPECT='it ran on dev|out: ok=no'
scenario which 'dispatch, a fork' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.head_repository.full_name = "x/r"')" EXPECT='it ran on x/r|out: ok=no'
scenario which 'dispatch, a release bump' EVENT=workflow_dispatch INPUT_RUN_ID=12 RUN="$(with '.head_commit.message = "chore: release 1.3.82.45"')" EXPECT='release bump|out: ok=no'

echo "######## Is this commit still main's newest?"
X=xxxx6666 Y=yyyy7777
ahead() { printf '{"status":"ahead","commits":%s}' "$(arr "$@")"; }
scenario head 'main is this commit' HEAD_SHA=$X MAIN=$X EXPECT='out: current=yes' LACKS='workflow run'
scenario head 'this commit is not on main any more' HEAD_SHA=$X MAIN=$Y COMPARE='{"status":"diverged","commits":[]}' \
  EXPECT='not on main any more|out: current=no' LACKS='workflow run'
scenario head 'a release bump after it' HEAD_SHA=$X MAIN=$P COMPARE="$(ahead "$(cm $R 'chore: release 1.3.82.45')" "$(cm $P 'ci: mpv 20260930')")" \
  EXPECT='has released it already|out: current=no' LACKS='workflow run'
scenario head "a later push with its own run" HEAD_SHA=$X MAIN=$Y COMPARE="$(ahead "$(cm $Y 'fix: y')")" \
  RUNS="$(arr "$(mk 3 $Y push 10:10 in_progress null 1)")" EXPECT="A later commit's CI run releases both|out: current=no" LACKS='workflow run'
scenario head "a later push whose run appears on the third look" HEAD_SHA=$X MAIN=$Y COMPARE="$(ahead "$(cm $Y 'fix: y')")" \
  RUNS='[]' RUNS2="$(arr "$(mk 3 $Y push 10:10 queued null 1)")" RUNS_FROM_CALL=3 EXPECT="A later commit's CI run releases both" LACKS='workflow run'
scenario head 'a pin landed while CI ran: CI started on main' HEAD_SHA=$X MAIN=$P COMPARE="$(ahead "$(cm $P 'ci: mpv 20260930')")" \
  RUNS="$(arr "$(mk 2 $X push 10:00 completed '"success"' 1)")" EXPECT='by pushes that start no CI|>> workflow run ci.yml --ref main|out: current=no'
scenario head 'a pin, then only a fork PR run from main' HEAD_SHA=$X MAIN=$P COMPARE="$(ahead "$(cm $P 'ci: mpv 20260930')")" \
  RUNS="$(arr "$(mk 3 $P pull_request 10:10 completed '"success"' 1)")" EXPECT='>> workflow run ci.yml --ref main'
scenario head 'a pin that already has CI dispatched on it' HEAD_SHA=$X MAIN=$P COMPARE="$(ahead "$(cm $P 'ci: mpv 20260930')")" \
  RUNS="$(arr "$(mk 3 $P workflow_dispatch 10:10 in_progress null 1)")" EXPECT="A later commit's CI run releases both" LACKS='workflow run'

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
