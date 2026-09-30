#!/usr/bin/env bash
# keepalive.yml: the enable calls it makes for the repository's scheduled workflows once
# main has been quiet for 45 days (or a dispatch forces them), the workflows it leaves
# alone - the owner-disabled one, the ones whose file has no schedule: trigger - and the
# issue it opens when it fails. Fixtures stand in for main's last commit, the
# repository's workflows and the open issues' titles; the stub gh records every enable
# call. The schedule: triggers are read from a fake checkout the step runs in:
# keepalive.yml is the workflow's own file, copied in.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
enable_step=$here/enable.sh
report_step=$here/report.sh
step_script keepalive.yml 'Re-enable the scheduled workflows' > "$enable_step" || exit 1
step_script keepalive.yml "Report this workflow's own failure" > "$report_step" || exit 1

# gh: canned JSON from $FIX through the real jq; enable calls, issue create and issue
# comment logged to $LOG, with the created body; anything unexpected fails. An enable
# whose workflow id is in $FAIL_ENABLE exits 1, as a refused or failing call would.
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
  'api -X')
    # gh api -X PUT <path>: here always the enable endpoint of one workflow by id.
    [ "$3" = PUT ] || { echo "stub gh: unexpected method $3" >&2; exit 2; }
    id=${4#repos/$GH_REPO/actions/workflows/}
    id=${id%/enable}
    [ "$4" = "repos/$GH_REPO/actions/workflows/$id/enable" ] || { echo "stub gh: unexpected PUT path $4" >&2; exit 2; }
    if [ "${FAIL_ENABLE:-}" ] && [ "$id" = "$FAIL_ENABLE" ]; then
      echo "stub gh: enable failed for $id" >&2
      exit 1
    fi
    printf 'ENABLE [%s]\n' "$id" >> "$LOG" ;;
  "api repos/$GH_REPO/commits/main") jq -r "$jqf" "$FIX/commit.json" ;;
  'api --paginate')
    case "$3" in
      "repos/$GH_REPO/actions/workflows") jq -r "$jqf" "$FIX/workflows.json" ;;
      *) echo "stub gh: unexpected api path $3" >&2; exit 2 ;;
    esac ;;
  'issue create')
    {
      printf 'CREATE'; printf ' [%s]' "${@:3}"; printf '\n'
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
        shift
      done
    } >> "$LOG"
    echo "https://github.com/$GH_REPO/issues/99" ;;
  'issue comment')
    {
      printf 'COMMENT'; printf ' [%s]' "${@:3}"; printf '\n'
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
        shift
      done
    } >> "$LOG" ;;
  'issue list')
    [[ " $* " == *' --state open --limit 200 '* ]] || { echo "stub gh: not a list of all open issues: $*" >&2; exit 2; }
    jq -r "$jqf" "$FIX/open.json" ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

# The workflow's env: blocks, as GitHub would set them: the job's for both steps, the
# enable step's FORCE and the report step's (RUN_URL, TITLE) only for their own step.
export GH_TOKEN=stub
export GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333'
RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
TITLE='Keepalive failed'
export -n RUN_URL TITLE
check "the enable step's env: gives the force input" contains "$WORKFLOWS_DIR/keepalive.yml" \
  'FORCE: ${{ inputs.force || false }}'
check "the report step's env: gives the title" contains "$WORKFLOWS_DIR/keepalive.yml" "TITLE: '$TITLE'"
check 'and the run URL' contains "$WORKFLOWS_DIR/keepalive.yml" \
  'RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}'

# A fake checkout for the enable step's working directory: six workflow files, four of
# them with a schedule: trigger. The schedule: in commented.yml is commented out, so it
# must not count, and keepalive.yml is the real file of this workflow.
repo=$here/repo
mkdir -p "$repo/.github/workflows"
cp "$WORKFLOWS_DIR/keepalive.yml" "$repo/.github/workflows/keepalive.yml"
cat > "$repo/.github/workflows/sync-upstream.yml" <<'EOF'
on:
  schedule:
    - cron: '0 6 * * *'
jobs:
  sync:
    runs-on: ubuntu-latest
EOF
cat > "$repo/.github/workflows/reminders.yml" <<'EOF'
on:
  schedule:
    - cron: '0 10 * * 1'
jobs:
  remind:
    runs-on: ubuntu-latest
EOF
cat > "$repo/.github/workflows/live-streams.yml" <<'EOF'
on:
  schedule:
    - cron: '0 12 * * 1'
jobs:
  watch:
    runs-on: ubuntu-latest
EOF
cat > "$repo/.github/workflows/no-schedule.yml" <<'EOF'
on:
  workflow_dispatch:
jobs:
  once:
    runs-on: ubuntu-latest
EOF
cat > "$repo/.github/workflows/commented.yml" <<'EOF'
# The commented-out schedule: below is not a trigger.
#   schedule:
#     - cron: '0 8 * * *'
on:
  workflow_dispatch:
jobs:
  once:
    runs-on: ubuntu-latest
EOF

# The repository's workflows, as actions/workflows lists them: three scheduled ones that
# are active or disabled_inactivity, this workflow's own file, one the owner disabled,
# one without a schedule, one with only a commented-out schedule, one whose file is gone.
workflows='{"total_count":7,"workflows":[
  {"id":101,"name":"Sync upstream","path":".github/workflows/sync-upstream.yml","state":"active"},
  {"id":102,"name":"Reminders","path":".github/workflows/reminders.yml","state":"disabled_inactivity"},
  {"id":103,"name":"On demand","path":".github/workflows/no-schedule.yml","state":"active"},
  {"id":104,"name":"Commented","path":".github/workflows/commented.yml","state":"active"},
  {"id":105,"name":"Live streams","path":".github/workflows/live-streams.yml","state":"disabled_manually"},
  {"id":106,"name":"Keepalive","path":".github/workflows/keepalive.yml","state":"active"},
  {"id":107,"name":"Gone","path":".github/workflows/gone.yml","state":"deleted"}
]}'

# commit <days>: the commits/main response, its committer date that many days ago; the
# step compares it against the real clock, so the date is computed when the test runs.
commit() { printf '{"commit":{"committer":{"date":"%s"}}}' "$(date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%SZ)"; }

# scenario <name> <step file> <commit json> <force> <workflows json> <open-issues json>
#   <failing enable id>: writes the fixtures, then runs the step in the fake checkout
#   with FORCE set; $status is the step's exit status, $LOG the stub's log, $FIX/out
#   its output.
scenario() {
  echo "$1"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"
  printf '%s' "$3" > "$FIX/commit.json"
  printf '%s' "$5" > "$FIX/workflows.json"
  printf '%s' "$6" > "$FIX/open.json"
  (
    if [ "$2" = "$report_step" ]; then export RUN_URL TITLE; fi
    export FORCE=$4
    if [ "$7" != '' ]; then export FAIL_ENABLE=$7; fi
    cd "$repo" && PATH="$here/bin:$PATH" run_step "$2"
  ) > "$FIX/out" 2>&1
  status=$?
}

scenario 's1 44 days old, not forced: nothing to do, no enable call' \
  "$enable_step" "$(commit 44)" false "$workflows" '[]' ''
check 'succeeds' test "$status" -eq 0
check 'has no enable call' lacks "$LOG" 'ENABLE'
check 'says the age' contains "$FIX/out" 'Last commit on main: 44 day(s) ago'
check 'says why it stopped' contains "$FIX/out" 'Under the 45-day threshold and not forced: nothing to do.'
check 'never got to the workflow list' lacks "$FIX/out" 'Scheduled workflow files:'

scenario 's2 45 days old: enables exactly the scheduled active and disabled_inactivity ones' \
  "$enable_step" "$(commit 45)" false "$workflows" '[]' ''
check 'succeeds' test "$status" -eq 0
check 'enables the active sync-upstream' contains "$LOG" 'ENABLE [101]'
check 're-enables reminders, disabled by inactivity' contains "$LOG" 'ENABLE [102]'
check 'enables its own keepalive workflow' contains "$LOG" 'ENABLE [106]'
check 'leaves the owner-disabled live-streams alone' lacks "$LOG" 'ENABLE [105]'
check 'and names it in the log' contains "$FIX/out" \
  'Skipped .github/workflows/live-streams.yml (#105): disabled_manually - the owner turned it off on purpose.'
check 'leaves the workflow without a schedule alone' lacks "$LOG" 'ENABLE [103]'
check 'and says so' contains "$FIX/out" 'Skipped .github/workflows/no-schedule.yml (#103)'
check 'leaves the deleted workflow alone' lacks "$LOG" 'ENABLE [107]'
check 'with its state named' contains "$FIX/out" "(#107): state 'deleted' is neither active nor disabled_inactivity."
check 'the commented-out schedule does not count' lacks "$LOG" 'ENABLE [104]'
check 'four scheduled files found in the checkout' contains "$FIX/out" 'Scheduled workflow files: 4'
check 'the active one is logged as the keepalive' contains "$FIX/out" \
  'Enabled .github/workflows/keepalive.yml (#106): was active'
check 'the disabled_inactivity one as re-enabled' contains "$FIX/out" \
  'Re-enabled .github/workflows/reminders.yml (#102): was disabled_inactivity.'
check 'the summary counts 2 + 1 enabled, 4 skipped' contains "$FIX/out" \
  'Done: 2 from active, 1 from disabled_inactivity, 4 skipped.'

scenario 's3 3 days old but force: enables anyway' \
  "$enable_step" "$(commit 3)" true "$workflows" '[]' ''
check 'succeeds' test "$status" -eq 0
check 'says it was forced' contains "$FIX/out" \
  'Under the 45-day threshold, but dispatched with force: enabling anyway.'
check 'enables the scheduled active one' contains "$LOG" 'ENABLE [101]'
check 'and the disabled_inactivity one' contains "$LOG" 'ENABLE [102]'
check 'and its own' contains "$LOG" 'ENABLE [106]'

scenario 's4 45 days old, the enable for reminders fails: the step stops and fails' \
  "$enable_step" "$(commit 45)" false "$workflows" '[]' 102
check 'fails' test "$status" -ne 0
check 'the earlier enable went out' contains "$LOG" 'ENABLE [101]'
check 'the failing enable is not logged' lacks "$LOG" 'ENABLE [102]'
check 'the ones after it never happened' lacks "$LOG" 'ENABLE [106]'
check 'the stub named the failure' contains "$FIX/out" 'stub gh: enable failed for 102'

scenario 's5 failure report, none open: opens "Keepalive failed"' \
  "$report_step" '{}' false '{}' '[{"title":"Other"}]' ''
check 'succeeds' test "$status" -eq 0
check 'opens it assigned to the owner' contains "$LOG" \
  'CREATE [--title] [Keepalive failed] [--assignee] [Nawid3333]'
check 'mentions the owner and links this run' contains "$LOG" \
  '@Nawid3333 keepalive.yml failed: https://github.com/Nawid3333/FastStream/actions/runs/1'

scenario 's6 failure report, already open: comments on it' \
  "$report_step" '{}' false '{}' '[{"number":3,"title":"Other"},{"number":12,"title":"Keepalive failed"}]' ''
check 'succeeds' test "$status" -eq 0
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'comments on the open one' contains "$LOG" 'COMMENT [12] [--body-file]'
check 'the comment mentions the owner and links this run' contains "$LOG" \
  '@Nawid3333 Failed again: https://github.com/Nawid3333/FastStream/actions/runs/1'

scenario 's7 a committer date that is not an ISO date: refused, nothing enabled' \
  "$enable_step" '{"commit":{"committer":{"date":"whenever the wind blows"}}}' false "$workflows" '[]' ''
check 'fails' test "$status" -ne 0
check 'refuses the date' contains "$FIX/out" \
  "The committer date of main's last commit came back as 'whenever the wind blows', not an ISO date."
check 'has no enable call' lacks "$LOG" 'ENABLE'

finish
