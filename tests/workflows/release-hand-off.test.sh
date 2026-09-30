#!/usr/bin/env bash
# The two steps that open the "Auto release failed" issue, one issue while it is open:
#   hand-off  ci.yml's release-hand-off job starts auto-release.yml for a CI run on main
#             that the repository's token started, trying three times, and opens the
#             issue when GitHub refuses all three;
#   report    auto-release.yml's "Report this workflow's own failure", for such a run
#             that failed.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script ci.yml 'Start auto-release.yml for this run' > "$here/hand-off.sh" || exit 1
step_script auto-release.yml "Report this workflow's own failure" > "$here/report.sh" || exit 1

# gh: records its calls; `workflow run` fails its first $START_FAILS times, `issue list`
# applies its --jq to $OPEN_ISSUES with the real jq (or fails, with LIST_FAILS), `issue
# create` keeps the body. sleep records how long it was asked to wait.
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
  'issue create')
    while [ $# -gt 0 ]; do
      if [ "$1" = --body-file ]; then cp "$2" "$FIX/body"; fi
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

SHA=abcdef1234567890abcdef1234567890abcdef12
START="workflow run auto-release.yml --ref main -f run_id=777 -f sha=$SHA"
LIST='issue list --state open --limit 200 --json title --jq .[].title'
SELF_URL=https://github.com/o/r/actions/runs/888

# scenario <step> <name>: runs the step with the environment the caller set, and the
# step's own env from its workflow.
scenario() {
  echo "$2"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$FIX/calls"
  : > "$FIX/sleeps"
  GH_REPO=o/r OWNER=owner RUN_ID=777 SHA=$SHA SELF_URL=$SELF_URL TITLE='Auto release failed' \
    PATH="$here/bin:$PATH" run_step "$here/$1.sh" > "$FIX/out" 2>&1
  status=$?
}
starts() { grep -cxF "$START" "$FIX/calls"; }

# Both steps look for the same open issue, so they must give it the same title.
for f in ci.yml auto-release.yml; do
  check "$f names the issue 'Auto release failed'" contains "$WORKFLOWS_DIR/$f" "TITLE: 'Auto release failed'"
done

export START_FAILS=0 OPEN_ISSUES='[]' LIST_FAILS=''
scenario hand-off 'started at once'
check 'succeeds' test "$status" -eq 0
check 'starts auto-release.yml once, for this run and commit' test "$(starts)" -eq 1
check 'waits for nothing' test ! -s "$FIX/sleeps"
check 'opens no issue' lacks "$FIX/calls" 'issue'

export START_FAILS=2
scenario hand-off 'refused twice, started on the third try'
check 'succeeds' test "$status" -eq 0
check 'tries three times' test "$(starts)" -eq 3
check 'waits 30 s, then 120 s' test "$(tr '\n' ' ' < "$FIX/sleeps")" = '30 120 '
check 'opens no issue' lacks "$FIX/calls" 'issue'

export START_FAILS=3
scenario hand-off 'refused three times'
check 'fails' test "$status" -ne 0
check 'tries three times' test "$(starts)" -eq 3
check 'looks for the issue among all open ones' contains "$FIX/calls" "$LIST"
check 'opens the issue, assigned' contains "$FIX/calls" 'issue create --title Auto release failed --assignee owner'
check 'the issue names the run, the commit and how to start it' contains "$FIX/body" \
  '@owner GitHub refused three times to start auto-release.yml for CI run 777 on main (abcdef12), a run this repository started. Start it from the Actions tab: Auto release, Run workflow, run_id 777.'

export OPEN_ISSUES='[{"title":"Other"},{"title":"Auto release failed"}]'
scenario hand-off 'refused three times, the issue already open'
check 'fails' test "$status" -ne 0
check 'opens no second issue' lacks "$FIX/calls" 'issue create'

export OPEN_ISSUES='[{"title":"Auto release failed again"}]'
scenario hand-off 'refused three times, an issue with a longer title open'
check 'opens the issue' contains "$FIX/calls" 'issue create --title Auto release failed'

export OPEN_ISSUES='[]' LIST_FAILS=1
scenario hand-off 'refused three times, the open issues unreadable'
check 'fails' test "$status" -ne 0
check 'opens the issue anyway' contains "$FIX/calls" 'issue create --title Auto release failed'

export START_FAILS=0 OPEN_ISSUES='[{"title":"Other"}]' LIST_FAILS=''
scenario report 'auto-release failed, no issue open'
check 'succeeds' test "$status" -eq 0
check 'looks for the issue among all open ones' contains "$FIX/calls" "$LIST"
check 'opens the issue, assigned' contains "$FIX/calls" 'issue create --title Auto release failed --assignee owner'
check 'the issue names the owner and links the failed run' contains "$FIX/body" \
  "@owner A CI run on main that this repository started (a re-run, or a run for pushes that start none) did not lead to a release: $SELF_URL"

export OPEN_ISSUES='[{"title":"Auto release failed"}]'
scenario report 'auto-release failed, the issue already open'
check 'succeeds' test "$status" -eq 0
check 'says so' contains "$FIX/out" 'Already reported in the open issue "Auto release failed".'
check 'opens no second issue' lacks "$FIX/calls" 'issue create'

finish
