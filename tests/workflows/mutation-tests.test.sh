#!/usr/bin/env bash
# mutation-tests.yml: the weekly "Mutation testing: week to <date>" issue it opens when the
# unit tests missed mutants, the older issues it closes, the issues a week with every
# mutant caught closes, and the issue it opens when it fails. The step runs the real
# tools/mutation-report.mjs on a fixture report; the stub gh records what it creates,
# edits and closes.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
issue_step=$here/issue.sh
report_step=$here/report.sh
step_script mutation-tests.yml "Open, update or close the week's issue" > "$issue_step" || exit 1
step_script mutation-tests.yml "Report this workflow's own failure" > "$report_step" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]-}; fi
done
logbody() {
  while [ $# -gt 0 ]; do
    if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
    shift
  done
}
case "$1 $2" in
  'api --paginate')
    [ "$3" = "repos/$GH_REPO/issues?state=all&per_page=100" ] || { echo "stub gh: unexpected api path $3" >&2; exit 2; }
    jq -r "$jqf" "$FIX/issues.json" ;;
  'issue create')
    { printf 'CREATE'; printf ' [%s]' "${@:3}"; printf '\n'; logbody "$@"; } >> "$LOG"
    echo "https://github.com/$GH_REPO/issues/99" ;;
  'issue edit')
    { printf 'EDIT'; printf ' [%s]' "${@:3}"; printf '\n'; logbody "$@"; } >> "$LOG" ;;
  'issue close')
    { printf 'CLOSE'; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG" ;;
  'issue comment')
    { printf 'COMMENT'; printf ' [%s]' "${@:3}"; printf '\n'; logbody "$@"; } >> "$LOG" ;;
  'issue list')
    [[ " $* " == *' --state open --limit 200 '* ]] || { echo "stub gh: not a list of all open issues: $*" >&2; exit 2; }
    jq -r "$jqf" "$FIX/open.json" ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

export GH_TOKEN=stub GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333' PREFIX='Mutation testing: week to '
export RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
TITLE='Mutation tests workflow failed'
export -n TITLE
check "the job's env: gives the prefix" contains "$WORKFLOWS_DIR/mutation-tests.yml" "PREFIX: '$PREFIX'"
check "the report step's env: gives the title" contains "$WORKFLOWS_DIR/mutation-tests.yml" "TITLE: '$TITLE'"

today=$(date -u +%F)
bot='{"login":"github-actions[bot]"}'
human='{"login":"Nawid3333"}'
script="$(cd "$(dirname "$0")/../.." && pwd)/tools/mutation-report.mjs"

# A mutant of Stryker's report.
m() { printf '{"status":"%s","mutatorName":"%s","replacement":"%s","location":{"start":{"line":%s,"column":1}}}' "$1" "$2" "$3" "$4"; }
missing="{\"files\":{\"chrome/player/utils/StreamPick.mjs\":{\"mutants\":[$(m Killed EqualityOperator 'a <= b' 3),$(m Survived ConditionalExpression true 9)]},\"chrome/background/DownloadFilename.mjs\":{\"mutants\":[$(m NoCoverage StringLiteral '' 20)]}}}"
allcaught="{\"files\":{\"chrome/player/utils/StreamPick.mjs\":{\"mutants\":[$(m Killed EqualityOperator 'a <= b' 3),$(m Timeout BlockStatement '{}' 4)]}}}"

# run <name> <step> <report json> <issues json> [open json]: the step, in a folder holding
# the report and the real report script, as in the job's checkout.
run() {
  echo "$1"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP" "$FIX/work/reports/mutation" "$FIX/work/tools"
  : > "$LOG"
  cp "$script" "$FIX/work/tools/"
  printf '%s' "$3" > "$FIX/work/reports/mutation/mutation.json"
  printf '%s' "$4" > "$FIX/issues.json"
  printf '%s' "${5:-[]}" > "$FIX/open.json"
  (
    cd "$FIX/work" || exit 9
    if [ "$2" = "$report_step" ]; then export TITLE; fi
    PATH="$here/bin:$PATH" run_step "$2"
  ) > "$FIX/out" 2>&1
  status=$?
}

run 's1 mutants not caught -> opens this week'"'"'s issue, closes last week'"'"'s' "$issue_step" "$missing" \
  "[{\"number\":5,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-01\",\"user\":$bot},{\"number\":3,\"state\":\"closed\",\"title\":\"${PREFIX}2026-08-25\",\"user\":$bot},{\"number\":6,\"state\":\"open\",\"title\":\"${PREFIX}notes\",\"user\":$human},{\"number\":8,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-08\",\"user\":$bot,\"pull_request\":{}}]"
check 'succeeds' test "$status" -eq 0
check "opens \"${PREFIX}$today\", assigned to the owner" contains "$LOG" "CREATE [--title] [${PREFIX}$today] [--assignee] [Nawid3333]"
check 'mentions the owner and the count' contains "$LOG" "@Nawid3333 The unit tests did not catch 2 of this week's mutants"
check 'links the run' contains "$LOG" "Run: $RUN_URL"
check 'lists the survivor' contains "$LOG" '- line 9: survived - ConditionalExpression: `true`'
check 'and the line no test reaches' contains "$LOG" '- line 20: no test reaches it - StringLiteral: `(removed)`'
check "closes last week's #5, pointing at the new one" contains "$LOG" "CLOSE [5] [--reason] [completed] [--comment] [#99 lists the week to $today.]"
check 'leaves closed #3 alone' lacks "$LOG" 'CLOSE [3]'
check "leaves a person's issue alone" lacks "$LOG" 'CLOSE [6]'
check 'leaves a pull request alone' lacks "$LOG" 'CLOSE [8]'

run 's2 run again the same day -> updates today'"'"'s issue' "$issue_step" "$missing" \
  "[{\"number\":7,\"state\":\"open\",\"title\":\"${PREFIX}$today\",\"user\":$bot},{\"number\":5,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-01\",\"user\":$bot}]"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check "updates #7" contains "$LOG" 'EDIT [7] [--body-file]'
check 'closes #5, pointing at #7' contains "$LOG" "CLOSE [5] [--reason] [completed] [--comment] [#7 lists the week to $today.]"
check 'leaves #7 open' lacks "$LOG" 'CLOSE [7]'

run 's3 every mutant caught -> opens nothing, closes the open one' "$issue_step" "$allcaught" \
  "[{\"number\":5,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-01\",\"user\":$bot},{\"number\":6,\"state\":\"open\",\"title\":\"${PREFIX}notes\",\"user\":$human}]"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'closes #5, saying why' contains "$LOG" "CLOSE [5] [--reason] [completed] [--comment] [The unit tests caught every mutant in the week to $today: $RUN_URL]"
check "leaves a person's issue alone" lacks "$LOG" 'CLOSE [6]'

export MISSING_SHARDS=tools
run 's3b every mutant of the reports caught, but a shard wrote none -> closes nothing' "$issue_step" "$allcaught" \
  "[{\"number\":5,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-01\",\"user\":$bot}]"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'leaves #5 open: the missing shard said nothing of its mutants' lacks "$LOG" 'CLOSE [5]'
check 'says which shard wrote none' contains "$FIX/out" 'no report from: tools'
run 's3c mutants not caught, and a shard wrote none -> still opens the issue' "$issue_step" "$missing" '[]'
check 'succeeds' test "$status" -eq 0
check 'opens the week'"'"'s issue' contains "$LOG" "CREATE [--title] [${PREFIX}$today]"
export -n MISSING_SHARDS
unset MISSING_SHARDS

# The report job's merge: the shards' reports from their artifacts, one each, into one.
merge_step=$here/merge.sh
step_script mutation-tests.yml "Put the shards' reports together" > "$merge_step" || exit 1
merge() {
  echo "$1"
  export FIX="$here/fix" GITHUB_ENV="$here/fix/env"
  rm -rf "$FIX"
  mkdir -p "$FIX/work/tools"
  : > "$GITHUB_ENV"
  cp "$script" "$(dirname "$script")/merge-mutation-reports.mjs" "$FIX/work/tools/"
  shift
  while [ $# -gt 0 ]; do
    mkdir -p "$FIX/work/shards/mutation-reports-$1"
    printf '%s' "$2" > "$FIX/work/shards/mutation-reports-$1/mutation.json"
    shift 2
  done
  (cd "$FIX/work" && run_step "$merge_step") > "$FIX/out" 2>&1
  status=$?
}
network="{\"files\":{\"chrome/player/network/XHRLoader.mjs\":{\"mutants\":[$(m Survived ConditionalExpression true 4)]}}}"
merge 's6 two shards of three -> one report of both, the third named missing' core "$missing" network "$network"
check 'succeeds' test "$status" -eq 0
check 'names the missing shard' contains "$GITHUB_ENV" 'MISSING_SHARDS=tools'
check 'the report has both shards'"'"' files' contains "$FIX/work/reports/mutation/mutation.json" 'chrome/player/network/XHRLoader.mjs'
check '... and the first shard'"'"'s' contains "$FIX/work/reports/mutation/mutation.json" 'chrome/player/utils/StreamPick.mjs'
merge 's7 every shard -> none missing' core "$missing" network "$network" tools '{"files":{}}'
check 'succeeds' test "$status" -eq 0
check 'names none missing' contains "$GITHUB_ENV" 'MISSING_SHARDS='
check '... and no shard' lacks "$GITHUB_ENV" 'MISSING_SHARDS=core'
merge 's8 no shard wrote a report -> no report, all three missing'
check 'succeeds' test "$status" -eq 0
check 'names all three' contains "$GITHUB_ENV" 'MISSING_SHARDS=core network tools'
check 'writes no report' test ! -e "$FIX/work/reports/mutation/mutation.json"

run 's4 failure report, none open -> opens the failure issue' "$report_step" '{}' '[]' '[{"title":"Other"}]'
check 'succeeds' test "$status" -eq 0
check 'opens "Mutation tests workflow failed", assigned to the owner' contains "$LOG" \
  'CREATE [--title] [Mutation tests workflow failed] [--assignee] [Nawid3333]'

run 's5 failure report, already open -> a comment on it' "$report_step" '{}' '[]' '[{"number":12,"title":"Mutation tests workflow failed"}]'
check 'succeeds' test "$status" -eq 0
check 'comments on the open one' contains "$LOG" 'COMMENT [12] [--body-file]'
check 'creates nothing' lacks "$LOG" 'CREATE'

finish
