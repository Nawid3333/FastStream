#!/usr/bin/env bash
# flaky-specs.yml: the weekly "Flaky e2e specs: week to <date>" issue it folds from the
# last 7 days' e2e-retried artifacts, the older issues it closes, and the issue it opens
# when it fails. Fixtures stand in for the repository's artifact list, each artifact's
# zip and its issues; the stub gh records what the steps create, edit and close.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
fold_step=$here/fold.sh
report_step=$here/report.sh
step_script flaky-specs.yml "Fold the week's retried specs into one issue" > "$fold_step" || exit 1
step_script flaky-specs.yml "Report this workflow's own failure" > "$report_step" || exit 1

# gh: the artifact lists and the issue list through the real jq, each artifact's zip from
# $FIX/zip/<id>.zip; issue create, edit, close and comment logged to $LOG, with the
# bodies; anything unexpected fails, a zip that is not there too (an artifact the step
# should not have opened).
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
    case "$3" in
      "repos/$GH_REPO/actions/artifacts?name=e2e-retried&per_page=100") jq -r "$jqf" "$FIX/linux.json" ;;
      "repos/$GH_REPO/actions/artifacts?name=e2e-retried-windows&per_page=100") jq -r "$jqf" "$FIX/windows.json" ;;
      "repos/$GH_REPO/issues?state=all&per_page=100") jq -r "$jqf" "$FIX/issues.json" ;;
      *) echo "stub gh: unexpected api path $3" >&2; exit 2 ;;
    esac ;;
  "api repos/$GH_REPO/actions/artifacts/"*)
    id=${2#"repos/$GH_REPO/actions/artifacts/"}
    id=${id%/zip}
    echo "ZIP [$id]" >> "$LOG"
    [ -f "$FIX/zip/$id.zip" ] || { echo "stub gh: no artifact $id" >&2; exit 2; }
    cat "$FIX/zip/$id.zip" ;;
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

# GitHub's runners have unzip; a WSL Ubuntu may not. Then `unzip -p <zip> <member>`, the
# one form the step uses, through python3.
if ! command -v unzip > /dev/null; then
  cat > "$here/bin/unzip" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -p ] || { echo "unzip stand-in: only -p" >&2; exit 2; }
exec python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$2" "$3"
EOF
  chmod +x "$here/bin/unzip"
fi

export GH_TOKEN=stub GITHUB_SERVER_URL='https://github.com'
export GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333' PREFIX='Flaky e2e specs: week to '
RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
TITLE='Flaky specs workflow failed'
export -n RUN_URL TITLE
check "the job's env: gives the prefix" contains "$WORKFLOWS_DIR/flaky-specs.yml" "PREFIX: '$PREFIX'"
check "the report step's env: gives the title" contains "$WORKFLOWS_DIR/flaky-specs.yml" "TITLE: '$TITLE'"
check 'ci.yml uploads the Linux list' contains "$WORKFLOWS_DIR/ci.yml" 'name: e2e-retried'
check 'ci.yml uploads the Windows list' contains "$WORKFLOWS_DIR/ci.yml" 'name: e2e-retried-windows'

today=$(date -u +%F)
recent=$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)
old=$(date -u -d '9 days ago' +%Y-%m-%dT%H:%M:%SZ)
bot='{"login":"github-actions[bot]"}'
human='{"login":"Nawid3333"}'

# artifact <id> <created_at> <run id> <branch> [expired] [head repository id]: one entry of
# the artifact list, its workflow_run as the API gives it (a run of this repository's own
# branch has head_repository_id == repository_id; a fork's pull request's, the fork's id).
artifact() {
  printf '{"id":%s,"name":"e2e-retried","expired":%s,"created_at":"%s","workflow_run":{"head_branch":"%s","head_repository_id":%s,"head_sha":"10414ba5e2b583d85f0cbc7e71dec9b980b2faae","id":%s,"repository_id":1354827019}}' \
    "$1" "${5:-false}" "$2" "$4" "${6:-1354827019}" "$3"
}
# rec <spec> <suite> <os> <passed>: one line of retried.jsonl.
rec() {
  printf '{"suite":"%s","spec":"tests/e2e/specs/%s.e2e.mjs","attempts":2,"passed":%s,"os":"%s"}\n' "$2" "$1" "$4" "$3"
}
# zip_list <id> <text>: the artifact's zip, holding retried.jsonl.
zip_list() {
  mkdir -p "$FIX/zip"
  printf '%s' "$2" > "$FIX/retried.jsonl"
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1], "w").write(sys.argv[2], "retried.jsonl")' \
    "$FIX/zip/$1.zip" "$FIX/retried.jsonl"
}

# fixtures <linux list json> <windows list json> <issues json> [open json]: a new
# scenario's fixtures, before its zips; run: runs the step.
fixtures() {
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"
  printf '{"total_count":0,"artifacts":%s}' "$1" > "$FIX/linux.json"
  printf '{"total_count":0,"artifacts":%s}' "$2" > "$FIX/windows.json"
  printf '%s' "$3" > "$FIX/issues.json"
  printf '%s' "${4:-[]}" > "$FIX/open.json"
}
run() {
  echo "$1"
  (
    if [ "$2" = "$report_step" ]; then export RUN_URL TITLE; fi
    PATH="$here/bin:$PATH" run_step "$2"
  ) > "$FIX/out" 2>&1
  status=$?
}

fixtures "[$(artifact 11 "$recent" 501 main),$(artifact 12 "$old" 400 main),$(artifact 13 "$recent" 502 claude/x true),$(artifact 14 "$recent" 504 main false 999)]" \
  "[$(artifact 21 "$recent" 501 main),$(artifact 22 "$recent" 503 'claude/y')]" \
  "[{\"number\":5,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-01\",\"user\":$bot},{\"number\":3,\"state\":\"closed\",\"title\":\"${PREFIX}2026-08-25\",\"user\":$bot},{\"number\":6,\"state\":\"open\",\"title\":\"${PREFIX}notes\",\"user\":$human},{\"number\":8,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-08\",\"user\":$bot,\"pull_request\":{}}]"
zip_list 11 "$(rec download-names ext-amo linux true)"
zip_list 21 "$(rec download-names ext-amo win32 true)
$(rec save-fmp4 web win32 false)"
zip_list 22 "$(rec download-names pbm-github win32 true)
{\"suite\":\"web\",\"sp"
zip_list 14 "$(rec 'fork | @Nawid3333 ready to merge' web linux true)"
run "s1 three lists this week (and a fork's) -> opens this week's issue, closes last week's" "$fold_step"
check 'succeeds' test "$status" -eq 0
check "opens \"${PREFIX}$today\", assigned to the owner" contains "$LOG" \
  "CREATE [--title] [${PREFIX}$today] [--assignee] [Nawid3333]"
check 'mentions the owner' contains "$LOG" "@Nawid3333 E2e spec files that failed once and were run again in the CI runs of the 7 days to $today"
check 'download-names: run again 3 times, passed 3, failed twice 0, both OSes, both branches, 3 runs' contains "$LOG" \
  '| `tests/e2e/specs/download-names.e2e.mjs` | 3 | 3 | 0 | ext-amo (linux), ext-amo (win32), pbm-github (win32) | claude/y, main | [501](https://github.com/Nawid3333/FastStream/actions/runs/501) [503](https://github.com/Nawid3333/FastStream/actions/runs/503) |'
check 'save-fmp4: run again once, failed twice once' contains "$LOG" \
  '| `tests/e2e/specs/save-fmp4.e2e.mjs` | 1 | 0 | 1 | web (win32) | main | [501](https://github.com/Nawid3333/FastStream/actions/runs/501) |'
check 'the most retried spec comes first' test "$(grep -n 'download-names' "$LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n 'save-fmp4' "$LOG" | head -1 | cut -d: -f1)"
check 'skips the half-written line' lacks "$LOG" '"sp'
check 'opens no list from before the week' lacks "$LOG" 'ZIP [12]'
check 'opens no expired list' lacks "$LOG" 'ZIP [13]'
check "opens no list from a fork's pull request" lacks "$LOG" 'ZIP [14]'
check "nothing of the fork's list in the issue" lacks "$LOG" 'ready to merge'
check "closes last week's #5, pointing at the new one" contains "$LOG" \
  "CLOSE [5] [--reason] [completed] [--comment] [#99 lists the 7 days to $today.]"
check 'leaves closed #3 alone' lacks "$LOG" 'CLOSE [3]'
check "leaves a person's issue with the same prefix alone" lacks "$LOG" 'CLOSE [6]'
check 'leaves a pull request alone' lacks "$LOG" 'CLOSE [8]'

fixtures "[$(artifact 12 "$old" 400 main)]" '[]' \
  "[{\"number\":5,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-01\",\"user\":$bot},{\"number\":6,\"state\":\"open\",\"title\":\"${PREFIX}notes\",\"user\":$human}]"
run "s2 a week with no retry -> opens nothing, closes last week's" "$fold_step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'closes #5, saying why' contains "$LOG" \
  "CLOSE [5] [--reason] [completed] [--comment] [No spec file was run again in the 7 days to $today.]"
check "leaves a person's issue alone" lacks "$LOG" 'CLOSE [6]'

fixtures "[$(artifact 11 "$recent" 501 main)]" '[]' \
  "[{\"number\":7,\"state\":\"open\",\"title\":\"${PREFIX}$today\",\"user\":$bot},{\"number\":5,\"state\":\"open\",\"title\":\"${PREFIX}2026-09-01\",\"user\":$bot}]"
zip_list 11 "$(rec download-names ext-amo linux true)"
run "s3 run again the same day -> updates today's issue, opens no second one" "$fold_step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check "updates today's #7" contains "$LOG" 'EDIT [7] [--body-file]'
check 'with the rows' contains "$LOG" '| `tests/e2e/specs/download-names.e2e.mjs` | 1 | 1 | 0 |'
check "closes #5, pointing at #7" contains "$LOG" "CLOSE [5] [--reason] [completed] [--comment] [#7 lists the 7 days to $today.]"
check 'leaves #7 open' lacks "$LOG" 'CLOSE [7]'

fixtures "[$(artifact 11 "$recent" 501 main)]" '[]' '[]'
zip_list 11 'not json
{"suite":"web"}
'
run 's4 a list with no record in it -> as a quiet week: opens nothing' "$fold_step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'

fixtures "[$(artifact 11 "$recent" 501 'claude/a|b')]" '[]' '[]'
zip_list 11 '{"suite":{"x":1},"spec":"tests/e2e/specs/a|`b`\n@Nawid3333.e2e.mjs","attempts":2,"passed":true,"os":"<img src=x>"}
'
run "s4b a record whose texts would break the table -> one row, only a path's characters" "$fold_step"
check 'succeeds' test "$status" -eq 0
check 'the row, each odd character an underscore' contains "$LOG" \
  '| `tests/e2e/specs/a__b___Nawid3333.e2e.mjs` | 1 | 1 | 0 | __x__1_ (_img_src_x_) | claude/a_b | [501](https://github.com/Nawid3333/FastStream/actions/runs/501) |'
check 'no mention from the record' lacks "$LOG" '@Nawid3333.e2e'

fixtures "[$(artifact 11 "$recent" 501 main)]" '[]' '[]'
run 's5 an artifact that cannot be downloaded -> fails, opens nothing' "$fold_step"
check 'fails' test "$status" -ne 0
check 'opens nothing' lacks "$LOG" 'CREATE'

fixtures '[]' '[]' '[]' '[{"title":"Other"}]'
run 's6 failure report, none open -> opens the failure issue' "$report_step"
check 'succeeds' test "$status" -eq 0
check 'opens "Flaky specs workflow failed", assigned to the owner' contains "$LOG" \
  'CREATE [--title] [Flaky specs workflow failed] [--assignee] [Nawid3333]'
check 'mentions the owner and the run URL' contains "$LOG" \
  '@Nawid3333 flaky-specs.yml failed: https://github.com/Nawid3333/FastStream/actions/runs/1'

fixtures '[]' '[]' '[]' '[{"number":3,"title":"Other"},{"number":12,"title":"Flaky specs workflow failed"}]'
run 's7 failure report, already open -> a comment on it' "$report_step"
check 'succeeds' test "$status" -eq 0
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'comments on the open one' contains "$LOG" 'COMMENT [12] [--body-file]'

finish
