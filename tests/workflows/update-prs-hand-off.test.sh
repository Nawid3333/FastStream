#!/usr/bin/env bash
# ci.yml's hand-off job, "Start update-prs.yml for this run": for a CI run the repository's
# token started, which sends no workflow_run, it starts update-prs.yml, trying three times.
# A run of the token's emails no one, so when GitHub refuses all three it opens the issue
# "Update PRs hand-off failed", saying how to start update-prs.yml by hand, and while that
# is open, comments on it instead.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script ci.yml 'Start update-prs.yml for this run' > "$here/hand-off.sh" || exit 1

# gh and sleep as in release-hand-off.test.sh.
mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
case "$1 $2" in
  'workflow run')
    n=$(( $(cat "$FIX/starts" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FIX/starts"
    [ "$n" -gt "${START_FAILS:-0}" ] ;;
  'issue list')
    if [ -n "${LIST_FAILS-}" ]; then exit 1; fi
    filter=''
    while [ $# -gt 0 ]; do
      if [ "$1" = --jq ]; then filter=$2; fi
      shift
    done
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

BRANCH=toolchain/pnpm-11.28.0
START="workflow run update-prs.yml --ref main -f run_id=777 -f branch=$BRANCH"
SELF_URL=https://github.com/o/r/actions/runs/777

scenario() {
  echo "$1"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$FIX/calls"
  : > "$FIX/sleeps"
  GH_REPO=o/r OWNER=owner RUN_ID=777 BRANCH=$BRANCH SELF_URL=$SELF_URL TITLE='Update PRs hand-off failed' \
    PATH="$here/bin:$PATH" run_step "$here/hand-off.sh" > "$FIX/out" 2>&1
  status=$?
}
starts() { grep -cxF "$START" "$FIX/calls"; }

check "ci.yml names the issue 'Update PRs hand-off failed'" contains "$WORKFLOWS_DIR/ci.yml" "TITLE: 'Update PRs hand-off failed'"

export START_FAILS=0 OPEN_ISSUES='[]' LIST_FAILS=''
scenario 'started at once'
check 'succeeds' test "$status" -eq 0
check 'starts update-prs.yml once, for this run and branch' test "$(starts)" -eq 1
check 'opens no issue' lacks "$FIX/calls" 'issue'

export START_FAILS=2
scenario 'refused twice, started on the third try'
check 'succeeds' test "$status" -eq 0
check 'waits 30 s, then 120 s' test "$(tr '\n' ' ' < "$FIX/sleeps")" = '30 120 '
check 'opens no issue' lacks "$FIX/calls" 'issue'

export START_FAILS=3
scenario 'refused three times'
check 'fails' test "$status" -ne 0
check 'tries three times' test "$(starts)" -eq 3
check 'opens the issue, assigned' contains "$FIX/calls" 'issue create --title Update PRs hand-off failed --assignee owner'
check 'the issue says how to start update-prs.yml by hand' contains "$FIX/create" \
  "Start it from the Actions tab: Update PRs, Run workflow, run_id 777 and branch $BRANCH."
check 'and links the run' contains "$FIX/create" "@owner GitHub refused three times to start update-prs.yml for CI run 777 on $BRANCH ($SELF_URL)"

export OPEN_ISSUES='[{"number":4,"title":"Update PRs workflow failed"},{"number":9,"title":"Update PRs hand-off failed"}]'
scenario 'refused three times, the issue already open'
check 'fails' test "$status" -ne 0
check 'opens no second issue' lacks "$FIX/calls" 'issue create'
check 'comments on the open one, not on update-prs.yml'"'"'s own' contains "$FIX/calls" 'issue comment 9 --body-file'
check 'the comment says how to start it' contains "$FIX/comment" \
  "@owner GitHub refused three times again, for CI run 777 on $BRANCH ($SELF_URL): start update-prs.yml by hand with run_id 777 and branch $BRANCH."

export OPEN_ISSUES='[]' LIST_FAILS=1
scenario 'refused three times, the open issues unreadable'
check 'fails' test "$status" -ne 0
check 'opens the issue anyway' contains "$FIX/calls" 'issue create --title Update PRs hand-off failed'

finish
