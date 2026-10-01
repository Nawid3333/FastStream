#!/usr/bin/env bash
# update-prs.yml's watch-main: after an update that ships merged itself, it waits for the CI
# run decide started on main. Green, or cancelled by a newer run: nothing to do. Red: one
# issue for the owner, or a comment on the open one. A run that never ends fails the step.
# The stub gh answers the run from $FIX/run.json (status and conclusion) and the open
# issues from $FIX/issues.json, and logs what it creates to $LOG; sleep is stubbed.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script update-prs.yml 'Wait for CI on main, and report a red run' > "$here/watch.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]-}; fi
done
case "$1 $2" in
  "api repos/$GH_REPO/actions/runs/$MAIN_RUN") cat "$FIX/run.json" ;;
  'issue list') jq -r "$jqf" "$FIX/issues.json" ;;
  'issue create')
    {
      printf 'CREATE'; printf ' [%s]' "${@:3}"; printf '\n'
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then cat "$2"; fi
        shift
      done
    } >> "$LOG" ;;
  'issue comment')
    {
      printf 'COMMENT [%s]\n' "$3"
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then cat "$2"; fi
        shift
      done
    } >> "$LOG" ;;
  *) echo "stub gh: unexpected: $*" >&2; exit 2 ;;
esac
EOF
printf '#!/usr/bin/env bash\n' > "$here/bin/sleep"
chmod +x "$here/bin/gh" "$here/bin/sleep"

# scenario <name> <status> <conclusion> [open issue title]: runs the step.
scenario() {
  echo "$1"
  export FIX=$here/fix LOG=$here/fix/log RUNNER_TEMP=$here/fix/tmp
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"
  jq -n --arg s "$2" --arg c "$3" '{status: $s, conclusion: (if $c == "" then null else $c end), html_url: "https://github.com/me/fs/actions/runs/777"}' > "$FIX/run.json"
  if [ -n "${4-}" ]; then jq -n --arg t "$4" '[{number: 12, title: $t}]' > "$FIX/issues.json"; else echo '[]' > "$FIX/issues.json"; fi
  (GH_REPO=me/fs OWNER=nawid MAIN_RUN=777 PR_NUMBER=42 TITLE='CI failed on main after an update merged itself' \
    PATH="$here/bin:$PATH" run_step "$here/watch.sh") > "$FIX/out" 2>&1
  status=$?
}

scenario 'green' completed success
check 'succeeds' test "$status" -eq 0
check 'says it releases' contains "$FIX/out" 'auto-release.yml releases it'
check 'reports nothing' test ! -s "$LOG"

scenario 'cancelled by a newer run' completed cancelled
check 'succeeds' test "$status" -eq 0
check 'reports nothing' test ! -s "$LOG"

scenario 'red' completed failure
check 'succeeds' test "$status" -eq 0
check 'opens the issue' contains "$LOG" 'CREATE [--title] [CI failed on main after an update merged itself] [--assignee] [nawid]'
check 'mentions the owner, the run and the pull request' contains "$LOG" '@nawid CI failed on main (https://github.com/me/fs/actions/runs/777) after #42'
check 'says nothing was released or reverted' contains "$LOG" 'Nothing was released, and nothing was reverted'

scenario 'red, the issue open' completed failure 'CI failed on main after an update merged itself'
check 'comments on it' contains "$LOG" 'COMMENT [12]'
check 'opens no second one' lacks "$LOG" 'CREATE'

scenario 'timed out' completed timed_out
check 'reported as red' contains "$LOG" 'CREATE'

scenario 'never ends' in_progress ''
check 'fails, for the failure report' test "$status" -ne 0
check 'reports nothing itself' test ! -s "$LOG"

finish
