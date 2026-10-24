#!/usr/bin/env bash
# live-streams.yml's hand-off job, "Start update-prs.yml for the CI run on this commit": on the
# player libraries' rolling update branch, once the live suite ended, it starts update-prs.yml
# again with the CI run on the same commit - only when that run passed (one still running or
# red decides through ci.yml's own hand-off). Tried three times; when GitHub refuses all
# three it opens the issue "Update PRs hand-off failed" that ci.yml's hand-off uses, or
# comments on it while it is open.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script live-streams.yml 'Start update-prs.yml for the CI run on this commit' > "$here/hand-off.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
filter=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then filter=${args[i + 1]}; fi
done
case "$1 $2" in
  'run list')
    case " $* " in *" --workflow ci.yml --commit $SHA "*) ;; *) echo "unexpected run list: $*" >&2; exit 99 ;; esac
    jq -r "$filter" <<< "${CI_RUNS:-[]}" ;;
  'workflow run')
    n=$(( $(cat "$FIX/starts" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FIX/starts"
    [ "$n" -gt "${START_FAILS:-0}" ] ;;
  'issue list')
    jq -r "$filter" <<< "${OPEN_ISSUES:-[]}" ;;
  'issue create'|'issue comment')
    kind=${2#issue }
    while [ $# -gt 0 ]; do
      if [ "$1" = --body-file ]; then cp "$2" "$FIX/$kind"; fi
      shift
    done ;;
  *) echo "unexpected gh $*" >&2; exit 99 ;;
esac
EOF
cat > "$here/bin/sleep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/sleeps"
EOF
chmod +x "$here/bin/gh" "$here/bin/sleep"

BRANCH=toolchain/player-libraries
SHA=abc1234abc1234abc1234abc1234abc1234abc12
SELF_URL=https://github.com/o/r/actions/runs/900

scenario() {
  echo "$1"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$FIX/calls"
  : > "$FIX/sleeps"
  GH_REPO=o/r OWNER=owner BRANCH=$BRANCH SHA=$SHA SELF_URL=$SELF_URL TITLE='Update PRs hand-off failed' \
    PATH="$here/bin:$PATH" run_step "$here/hand-off.sh" > "$FIX/out" 2>&1
  status=$?
}
starts() { grep -c '^workflow run' "$FIX/calls"; }

check 'live-streams.yml shares the issue with ci.yml' contains "$WORKFLOWS_DIR/live-streams.yml" "TITLE: 'Update PRs hand-off failed'"
check 'and runs the hand-off on that branch only, whatever the live suite concluded' contains "$WORKFLOWS_DIR/live-streams.yml" \
  "if: always() && (github.head_ref || github.ref_name) == 'toolchain/player-libraries'"

export START_FAILS=0 OPEN_ISSUES='[]'
export CI_RUNS='[{"databaseId": 700, "status": "completed", "conclusion": "failure"}, {"databaseId": 777, "status": "completed", "conclusion": "success"}]'
scenario 'CI passed on the commit'
check 'succeeds' test "$status" -eq 0
check 'starts update-prs.yml once, with the newest CI run and the branch' \
  contains "$FIX/calls" "workflow run update-prs.yml --ref main -f run_id=777 -f branch=$BRANCH"
check 'once' test "$(starts)" -eq 1
check 'opens no issue' lacks "$FIX/calls" 'issue'

export CI_RUNS='[{"databaseId": 777, "status": "completed", "conclusion": "success"}, {"databaseId": 781, "status": "completed", "conclusion": "action_required"}]'
scenario 'a newer pull_request run waits for an approval and never ran'
check 'succeeds' test "$status" -eq 0
check 'starts update-prs.yml with the CI run that ran' \
  contains "$FIX/calls" "workflow run update-prs.yml --ref main -f run_id=777 -f branch=$BRANCH"

export CI_RUNS='[{"databaseId": 777, "status": "completed", "conclusion": "success"}, {"databaseId": 780, "status": "in_progress", "conclusion": null}]'
scenario 'CI runs again on the commit'
check 'succeeds' test "$status" -eq 0
check 'starts nothing: the running one decides' test "$(starts)" -eq 0
check 'says so' contains "$FIX/out" 'CI run 780 on abc1234a is in_progress -: its own hand-off decides.'

export CI_RUNS='[{"databaseId": 777, "status": "completed", "conclusion": "failure"}]'
scenario 'CI failed on the commit'
check 'succeeds' test "$status" -eq 0
check 'starts nothing' test "$(starts)" -eq 0

export CI_RUNS='[]'
scenario 'no CI run on the commit yet'
check 'succeeds' test "$status" -eq 0
check 'starts nothing' test "$(starts)" -eq 0
check 'says so' contains "$FIX/out" 'No CI run on abc1234a'

export CI_RUNS='[{"databaseId": 777, "status": "completed", "conclusion": "success"}]' START_FAILS=2
scenario 'refused twice, started on the third try'
check 'succeeds' test "$status" -eq 0
check 'waits 30 s, then 120 s' test "$(tr '\n' ' ' < "$FIX/sleeps")" = '30 120 '

export START_FAILS=3
scenario 'refused three times'
check 'fails' test "$status" -ne 0
check 'tries three times' test "$(starts)" -eq 3
check 'opens the issue, assigned' contains "$FIX/calls" 'issue create --title Update PRs hand-off failed --assignee owner'
check 'the issue says how to start it by hand' contains "$FIX/create" \
  "Start it from the Actions tab: Update PRs, Run workflow, run_id 777 and branch $BRANCH."

export OPEN_ISSUES='[{"number":9,"title":"Update PRs hand-off failed"}]'
scenario 'refused three times, the issue already open'
check 'fails' test "$status" -ne 0
check 'comments on it' contains "$FIX/calls" 'issue comment 9 --body-file'
check 'opens no second issue' lacks "$FIX/calls" 'issue create'

finish
