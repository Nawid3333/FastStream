#!/usr/bin/env bash
# wsl-releases.yml: the "WSL update: <version>" issue it opens for a new microsoft/WSL
# release, closing the open one for an older version and leaving the rest alone, and the
# issue it opens when it fails. Fixtures stand in for the release, this repository's
# issues and its open issues' titles; the stub gh records what the steps create and close.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
open_step=$here/open.sh
report_step=$here/report.sh
step_script wsl-releases.yml 'Open the issue for a new release' > "$open_step" || exit 1
step_script wsl-releases.yml "Report this workflow's own failure" > "$report_step" || exit 1

# gh: canned JSON from $FIX through the real jq; issue create and issue close logged to
# $LOG, with the created body; anything unexpected fails.
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
  'api repos/microsoft/WSL/releases/latest')
    cat "$FIX/release.json" ;;
  'api --paginate')
    case "$3" in
      "repos/$GH_REPO/issues?state=all&per_page=100") jq -r "$jqf" "$FIX/issues.json" ;;
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
  'issue close')
    { printf 'CLOSE'; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG" ;;
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
# report step's own (RUN_URL, TITLE) only for it, by scenario.
export GH_TOKEN=stub
export GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333' PREFIX='WSL update: '
RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
TITLE='WSL releases workflow failed'
export -n RUN_URL TITLE
check "the report step's env: gives the title" contains "$WORKFLOWS_DIR/wsl-releases.yml" "TITLE: '$TITLE'"
check "and the run's URL" contains "$WORKFLOWS_DIR/wsl-releases.yml" \
  'RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}'

# rel <tag json> <published json>: a microsoft/WSL release, as releases/latest returns it.
rel() { printf '{"tag_name":%s,"published_at":%s,"html_url":"https://example.invalid/x"}' "$1" "$2"; }
r301=$(rel '"3.0.1"' '"2026-09-20T10:00:00Z"')
bot='{"login":"github-actions[bot]"}'
human='{"login":"Nawid3333"}'

# scenario <name> <step file> <release json> <issues json> <open-titles json>: runs the
# step on those fixtures; $status is its exit status, $LOG the stub's create/close log.
scenario() {
  echo "$1"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"
  printf '%s' "$3" > "$FIX/release.json"
  printf '%s' "$4" > "$FIX/issues.json"
  printf '%s' "$5" > "$FIX/open.json"
  (
    if [ "$2" = "$report_step" ]; then export RUN_URL TITLE; fi
    PATH="$here/bin:$PATH" run_step "$2"
  ) > "$FIX/out" 2>&1
  status=$?
}

scenario 's1 fresh: no WSL issue yet -> creates "WSL update: 3.0.1", closes nothing' \
  "$open_step" "$r301" \
  "[{\"number\":5,\"state\":\"open\",\"title\":\"Something else\",\"user\":$human}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates "WSL update: 3.0.1", assigned to the owner' contains "$LOG" \
  'CREATE [--title] [WSL update: 3.0.1] [--assignee] [Nawid3333]'
check 'mentions the owner, the version and the date' contains "$LOG" \
  '@Nawid3333 WSL 3.0.1 is out (2026-09-20)'
check 'has the wsl --update command' contains "$LOG" 'wsl --update'
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's2 already told, issue open -> creates nothing, closes nothing' \
  "$open_step" "$r301" \
  "[{\"number\":81,\"state\":\"open\",\"title\":\"WSL update: 3.0.1\",\"user\":$bot}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'closes nothing' lacks "$LOG" 'CLOSE'
check 'says already told' contains "$FIX/out" 'Already told in #81, "WSL update: 3.0.1".'

scenario 's3 already told, issue closed -> creates nothing, closes nothing' \
  "$open_step" "$r301" \
  "[{\"number\":81,\"state\":\"closed\",\"title\":\"WSL update: 3.0.1\",\"user\":$bot}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'closes nothing' lacks "$LOG" 'CLOSE'
check 'says already told' contains "$FIX/out" 'Already told in #81, "WSL update: 3.0.1".'

scenario 's4 newer release: closes only the open older one -> creates 3.0.1, closes #80' \
  "$open_step" "$r301" \
  "[{\"number\":80,\"state\":\"open\",\"title\":\"WSL update: 2.7.14\",\"user\":$bot},{\"number\":50,\"state\":\"closed\",\"title\":\"WSL update: 2.6.0\",\"user\":$bot},{\"number\":7,\"state\":\"open\",\"title\":\"WSL update: notes\",\"user\":$human}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates "WSL update: 3.0.1"' contains "$LOG" 'CREATE [--title] [WSL update: 3.0.1]'
check 'mentions the owner, the version and the date' contains "$LOG" \
  '@Nawid3333 WSL 3.0.1 is out (2026-09-20)'
check 'has the wsl --update command' contains "$LOG" 'wsl --update'
check 'closes #80 as not planned' contains "$LOG" 'CLOSE [80] [--reason] [not planned]'
check 'the close points at the new issue' contains "$LOG" \
  'WSL 3.0.1 is out: https://github.com/Nawid3333/FastStream/issues/99 replaces this issue.'
check 'leaves closed #50 alone' lacks "$LOG" 'CLOSE [50]'
check 'leaves the human issue #7 alone' lacks "$LOG" 'CLOSE [7]'

scenario 's5 same title by a person, and a bot PR: neither counts -> still creates 3.0.1' \
  "$open_step" "$r301" \
  "[{\"number\":60,\"state\":\"open\",\"title\":\"WSL update: 3.0.1\",\"user\":$human},{\"number\":61,\"state\":\"open\",\"title\":\"WSL update: 3.0.1\",\"user\":$bot,\"pull_request\":{}}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates "WSL update: 3.0.1"' contains "$LOG" 'CREATE [--title] [WSL update: 3.0.1]'
check 'mentions the owner, the version and the date' contains "$LOG" \
  '@Nawid3333 WSL 3.0.1 is out (2026-09-20)'
check 'has the wsl --update command' contains "$LOG" 'wsl --update'
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's6 hostile tag ("3.0.1; echo pwned") -> refused: fails, creates and closes nothing' \
  "$open_step" "$(rel '"3.0.1; echo pwned"' '"2026-09-20T10:00:00Z"')" '[]' '[]'
check 'fails' test "$status" -ne 0
check 'refuses the tag' contains "$FIX/out" "tagged '3.0.1; echo pwned', not a version number."
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's7 v-prefixed tag ("v3.0.1") -> refused: fails, creates and closes nothing' \
  "$open_step" "$(rel '"v3.0.1"' '"2026-09-20T10:00:00Z"')" '[]' '[]'
check 'fails' test "$status" -ne 0
check 'refuses the tag' contains "$FIX/out" "tagged 'v3.0.1', not a version number."
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's8 no published date -> creates 3.0.2 with (date unknown), closes nothing' \
  "$open_step" "$(rel '"3.0.2"' 'null')" '[]' '[]'
check 'succeeds' test "$status" -eq 0
check 'creates "WSL update: 3.0.2"' contains "$LOG" 'CREATE [--title] [WSL update: 3.0.2]'
check 'says the date is unknown' contains "$LOG" '@Nawid3333 WSL 3.0.2 is out (date unknown)'
check 'has the wsl --update command' contains "$LOG" 'wsl --update'
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's9 empty repo issue list -> creates 3.0.1, closes nothing' \
  "$open_step" "$r301" '[]' '[]'
check 'succeeds' test "$status" -eq 0
check 'creates "WSL update: 3.0.1"' contains "$LOG" 'CREATE [--title] [WSL update: 3.0.1]'
check 'mentions the owner, the version and the date' contains "$LOG" \
  '@Nawid3333 WSL 3.0.1 is out (2026-09-20)'
check 'has the wsl --update command' contains "$LOG" 'wsl --update'
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's10 failure report, none open -> opens the failure issue' \
  "$report_step" '{}' '[]' '[{"title":"Other"}]'
check 'succeeds' test "$status" -eq 0
check 'opens "WSL releases workflow failed", assigned to the owner' contains "$LOG" \
  'CREATE [--title] [WSL releases workflow failed] [--assignee] [Nawid3333]'
check 'mentions the owner and the run URL' contains "$LOG" \
  '@Nawid3333 wsl-releases.yml failed: https://github.com/Nawid3333/FastStream/actions/runs/1'

scenario 's11 failure report, already open -> a comment on it' \
  "$report_step" '{}' '[]' '[{"number":3,"title":"Other"},{"number":12,"title":"WSL releases workflow failed"}]'
check 'succeeds' test "$status" -eq 0
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'comments on the open one' contains "$LOG" 'COMMENT [12] [--body-file]'
check 'the comment mentions the owner and links this run' contains "$LOG" \
  '@Nawid3333 Failed again: https://github.com/Nawid3333/FastStream/actions/runs/1'

scenario 's12 already told, an older one still open (its close failed) -> creates nothing, closes #80' \
  "$open_step" "$r301" \
  "[{\"number\":81,\"state\":\"open\",\"title\":\"WSL update: 3.0.1\",\"user\":$bot},{\"number\":80,\"state\":\"open\",\"title\":\"WSL update: 2.7.14\",\"user\":$bot}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'closes #80, saying #81 replaces it' contains "$LOG" \
  'CLOSE [80] [--reason] [not planned] [--comment] [WSL 3.0.1 is out: #81 replaces this issue.]'
check 'the told 3.0.1 issue #81 stays alone' lacks "$LOG" 'CLOSE [81]'

scenario 's13 latest went back to 3.0.1 (told, closed) -> creates nothing, the open 3.0.2 issue #82 stays' \
  "$open_step" "$r301" \
  "[{\"number\":82,\"state\":\"open\",\"title\":\"WSL update: 3.0.2\",\"user\":$bot},{\"number\":81,\"state\":\"closed\",\"title\":\"WSL update: 3.0.1\",\"user\":$bot}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates nothing' lacks "$LOG" 'CREATE'
check 'closes nothing' lacks "$LOG" 'CLOSE'
check 'says already told' contains "$FIX/out" 'Already told in #81, "WSL update: 3.0.1".'

scenario 's14 version order is numeric, not text: 2.10.0 open, latest 2.9.1 -> creates 2.9.1, #83 stays' \
  "$open_step" "$(rel '"2.9.1"' '"2026-09-20T10:00:00Z"')" \
  "[{\"number\":83,\"state\":\"open\",\"title\":\"WSL update: 2.10.0\",\"user\":$bot}]" '[]'
check 'succeeds' test "$status" -eq 0
check 'creates "WSL update: 2.9.1"' contains "$LOG" 'CREATE [--title] [WSL update: 2.9.1]'
check 'mentions the owner, the version and the date' contains "$LOG" \
  '@Nawid3333 WSL 2.9.1 is out (2026-09-20)'
check 'has the wsl --update command' contains "$LOG" 'wsl --update'
check 'the open 2.10.0 issue #83 stays open' lacks "$LOG" 'CLOSE [83]'

finish
