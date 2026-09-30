#!/usr/bin/env bash
# security-alerts.yml: the "Security alert: <package>" issue it opens for Dependabot alerts
# with no pull request, the alerts it adds to an open one, the issues it closes once their
# alerts are fixed or dismissed (on a push, waiting for GitHub to mark them), and the issue
# it opens when it fails. Fixtures stand in for the open alerts, this repository's issues
# and open pull requests; the stub gh records what the steps create, edit, comment on and
# close, and a stub sleep records the waits. The real gh applies --jq with gojq, built in;
# the stub uses jq, as the step's own jq calls do, so the filters avoid what the two treat
# differently (jq 1.7 splits "" into [], gojq into [""]).
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
main_step=$here/main.sh
report_step=$here/report.sh
step_script security-alerts.yml 'Open, update and close the issues' > "$main_step" || exit 1
step_script security-alerts.yml "Report this workflow's own failure" > "$report_step" || exit 1

# gh: canned JSON from the FX_* fixtures through the real jq; the alerts from the
# FX_FROM_CALL-th read on are FX_ALERTS2, and alert <n> read by itself has the state in
# STATE_<n> (fixed if unset). Issue create, edit, comment and close are logged to $LOG,
# with the body file; anything unexpected fails.
mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]}; fi
done
answer() {
  if [ -n "$jqf" ]; then jq -r "$jqf" <<< "$1"; else printf '%s\n' "$1"; fi
}
logged() {
  printf '%s' "$1"; shift; printf ' [%s]' "$@"; printf '\n'
  while [ $# -gt 0 ]; do
    if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
    shift
  done
}
case "$1 $2" in
  'api --paginate')
    case "$3" in
      "repos/$GH_REPO/dependabot/alerts?state=open&per_page=100")
        n=$(( $(cat "$FIX/alert-calls" 2> /dev/null || echo 0) + 1 ))
        echo "$n" > "$FIX/alert-calls"
        if [ -n "$FX_FROM_CALL" ] && [ "$n" -ge "$FX_FROM_CALL" ]; then
          answer "$FX_ALERTS2"
        else
          answer "$FX_ALERTS"
        fi ;;
      "repos/$GH_REPO/issues?state=all&per_page=100") answer "$FX_ISSUES" ;;
      "repos/$GH_REPO/pulls?state=open&per_page=100") answer "$FX_PULLS" ;;
      *) echo "stub gh: unexpected api path $3" >&2; exit 2 ;;
    esac ;;
  "api repos/$GH_REPO/dependabot/alerts/"*)
    n=${2##*/}
    state=STATE_$n
    answer "{\"number\":$n,\"state\":\"${!state:-fixed}\"}" ;;
  'issue create')
    logged CREATE "${@:3}" >> "$LOG"
    echo "https://github.com/$GH_REPO/issues/99" ;;
  'issue edit') logged EDIT "${@:3}" >> "$LOG" ;;
  'issue comment') logged COMMENT "${@:3}" >> "$LOG" ;;
  'issue close') logged CLOSE "${@:3}" >> "$LOG" ;;
  'issue list') answer "$FX_OPEN" ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
cat > "$here/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "SLEEP [$*]" >> "$LOG"
EOF
# date -u +%s is $NOW; anything else, the real date.
cat > "$here/bin/date" <<EOF
#!/usr/bin/env bash
if [ "\$*" = '-u +%s' ]; then echo "\$NOW"; else exec $(command -v date) "\$@"; fi
EOF
chmod +x "$here/bin/gh" "$here/bin/sleep" "$here/bin/date"

# The workflow's env: blocks, as GitHub would set them.
export GH_TOKEN=stub
export GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333' PREFIX='Security alert: '
export RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
export TITLE='Security alerts workflow failed'
base=https://github.com/Nawid3333/FastStream/security/dependabot

export NOW=1790000000              # 2026-09-21T14:13:20Z
old=2026-09-20T00:00:00Z           # a day and a half before NOW
young=2026-09-21T12:00:00Z         # 2 hours before NOW
edge_in=2026-09-21T08:13:19Z       # 6 hours and 1 second before NOW
edge_out=2026-09-21T08:13:21Z      # 1 second under 6 hours before NOW

# al <number> <package> <created_at> [manifest] [fixed in, '' for none] [summary]: an
# alert as the API returns it.
al() {
  jq -nc --argjson n "$1" --arg p "$2" --arg c "$3" --arg m "${4:-pnpm-lock.yaml}" --arg f "${5-1.2.3}" \
    --arg s "${6:-A flaw in $2}" \
    '{number: $n, state: "open", created_at: $c, html_url: "https://github.com/Nawid3333/FastStream/security/dependabot/\($n)",
      dependency: {package: {ecosystem: "npm", name: $p}, manifest_path: $m, scope: "development"},
      security_advisory: {severity: "high", summary: $s},
      security_vulnerability: {vulnerable_version_range: "< 1.2.3",
        first_patched_version: (if $f == "" then null else {identifier: $f} end)}}'
}
# is <number> <state> <title> <body> [author]: an issue as the issues list returns it.
is() {
  jq -nc --argjson n "$1" --arg s "$2" --arg t "$3" --arg b "$4" --arg u "${5:-github-actions[bot]}" \
    '{number: $n, state: $s, title: $t, body: $b, user: {login: $u}}'
}
# pr <author> <title> <body>: an open pull request.
pr() {
  jq -nc --arg u "$1" --arg t "$2" --arg b "$3" '{user: {login: $u}, title: $t, body: $b}'
}
arr() {
  local IFS=,
  echo "[$*]"
}
marker() {
  printf 'text\n\n<!-- alerts: %s -->\n' "$*"
}
# count <file> <text> <n>: whether the text is on exactly n of the file's lines.
count() {
  [ "$(grep -cF -- "$2" "$1")" = "$3" ]
}

# scenario <name> <step file> [NAME=value]...: runs the step with those fixtures (FX_ALERTS,
# FX_ALERTS2 with FX_FROM_CALL, FX_ISSUES, FX_PULLS, FX_OPEN, STATE_<n>) and EVENT
# (schedule if not given); $status is its exit status, $LOG the stub's log, $FIX/out the
# step's output.
scenario() {
  echo "$1"
  local step=$2
  shift 2
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"
  (
    export EVENT=schedule FX_ALERTS='[]' FX_ALERTS2='[]' FX_FROM_CALL='' FX_ISSUES='[]' FX_PULLS='[]' FX_OPEN='[]'
    for kv in "$@"; do export "${kv?}"; done
    PATH="$here/bin:$PATH" run_step "$step"
  ) > "$FIX/out" 2>&1
  status=$?
}

b43=$(al 43 brace-expansion $old)
b44=$(al 44 brace-expansion $old)
b45=$(al 45 brace-expansion $old)
ip52=$(al 52 ip-address $old)

# --- The daily run: raising.

scenario 's1 no alert -> nothing' "$main_step"
check 'succeeds' test "$status" -eq 0
check 'touches no issue' test ! -s "$LOG"

scenario 's2 the 2026-09-30 case: two packages, no pull request -> one issue each' "$main_step" \
  FX_ALERTS="$(arr "$b43" "$b44" "$b45" "$ip52")"
check 'succeeds' test "$status" -eq 0
check 'opens "Security alert: brace-expansion", assigned to the owner' contains "$LOG" \
  'CREATE [--title] [Security alert: brace-expansion] [--assignee] [Nawid3333] [--body-file]'
check 'opens "Security alert: ip-address"' contains "$LOG" \
  'CREATE [--title] [Security alert: ip-address] [--assignee] [Nawid3333] [--body-file]'
check 'opens two issues' count "$LOG" 'CREATE [' 2
check 'mentions the owner' contains "$LOG" \
  '@Nawid3333 Dependabot has open security alerts for `brace-expansion` and no pull request that fixes them:'
check 'a table row per alert, linked' contains "$LOG" \
  "| [43]($base/43) | high | \`pnpm-lock.yaml\` | \`< 1.2.3\` | 1.2.3 | A flaw in brace-expansion |"
check 'the last alert has its row too' contains "$LOG" "| [45]($base/45) |"
check 'records the alerts it lists' contains "$LOG" '<!-- alerts: 43 44 45 -->'
check "and the other issue's" contains "$LOG" '<!-- alerts: 52 -->'
check 'says how to fix it by hand' contains "$LOG" \
  '`pnpm update brace-expansion` for `pnpm-lock.yaml`, or `npm update brace-expansion` in `fsaunpack/`'
check 'says a new alert is raised again' contains "$LOG" 'a new one for `ip-address` is.'
check 'edits, comments on and closes nothing' lacks "$LOG" 'EDIT'
check '(comments)' lacks "$LOG" 'COMMENT'
check '(closes)' lacks "$LOG" 'CLOSE'
check 'never writes an alert as #43 (issue 43)' lacks "$LOG" '#43'

scenario 's3 alerts under 6 hours old -> wait for Dependabot' "$main_step" \
  FX_ALERTS="$(arr "$(al 60 brace-expansion $young)" "$(al 61 x $edge_out)")"
check 'succeeds' test "$status" -eq 0
check 'touches no issue' test ! -s "$LOG"

scenario 's4 an alert just over 6 hours old -> raised' "$main_step" FX_ALERTS="$(arr "$(al 61 x $edge_in)")"
check 'opens "Security alert: x"' contains "$LOG" 'CREATE [--title] [Security alert: x]'

scenario 's5 a young and an old alert -> the issue lists only the old one' "$main_step" \
  FX_ALERTS="$(arr "$b43" "$(al 60 brace-expansion $young)")"
check 'lists 43' contains "$LOG" '<!-- alerts: 43 -->'
check 'has no row for 60' lacks "$LOG" '[60]'

scenario 's6 a Dependabot pull request for the package -> nothing' "$main_step" FX_ALERTS="$(arr "$b43")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump brace-expansion from 1.1.18 to 1.1.21' \
    'Bumps [brace-expansion](https://github.com/juliangruber/brace-expansion) from 1.1.18 to 1.1.21.')")"
check 'succeeds' test "$status" -eq 0
check 'touches no issue' test ! -s "$LOG"

scenario 's7 one in /fsaunpack, its pull request naming it in the title only -> nothing' "$main_step" \
  FX_ALERTS="$(arr "$(al 70 ms $old fsaunpack/package-lock.json)")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump ms from 2.1.2 to 2.1.3 in /fsaunpack' '')")"
check 'touches no issue' test ! -s "$LOG"

scenario 's8 a grouped update names one on an "Updates" line -> that one waits, the other is raised' "$main_step" \
  FX_ALERTS="$(arr "$b43" "$ip52")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump the tooling-minor-and-patch group with 2 updates' \
    "$(printf 'Bumps the tooling group with 2 updates:\n\n| Package | From | To |\n\n<details>\n<summary>x</summary>\n</details>\n\nUpdates `ip-address` from 10.7.0 to 10.7.2\n<details>\n<summary>Release notes</summary>\n</details>\n')")")"
check 'opens "Security alert: brace-expansion"' contains "$LOG" 'CREATE [--title] [Security alert: brace-expansion]'
check 'not "Security alert: ip-address"' lacks "$LOG" 'Security alert: ip-address'

scenario 's9 a security update that updates an ancestor too names both in links -> nothing' "$main_step" \
  FX_ALERTS="$(arr "$b43" "$(al 71 minimatch $old)")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump brace-expansion and minimatch' \
    'Bumps [brace-expansion](https://x/b) and [minimatch](https://x/m). These dependencies needed to be updated together.')")"
check 'touches no issue' test ! -s "$LOG"

scenario 's10 a package named only in the quoted release notes and commits -> raised' "$main_step" \
  FX_ALERTS="$(arr "$b43")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump minimatch from 3.0.4 to 3.1.2' \
    "$(printf 'Bumps [minimatch](https://x/m) from 3.0.4 to 3.1.2.\n<details>\n<summary>Commits</summary>\n<ul>\n<li>Bumps [brace-expansion](https://x/b) to 1.1.21</li>\n<li>Bump brace-expansion from 1.1.18 to 1.1.21</li>\n<li>Updates `brace-expansion` from 1.1.18</li>\n</ul>\n</details>\n')")")"
check 'opens "Security alert: brace-expansion"' contains "$LOG" 'CREATE [--title] [Security alert: brace-expansion]'

scenario "s11 Dependabot's boilerplate does not name a package called long -> raised" "$main_step" \
  FX_ALERTS="$(arr "$(al 72 long $old)")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump x from 1 to 2' \
    "$(printf 'Bumps [x](https://x/x) from 1 to 2.\n\nDependabot will resolve any conflicts with this PR as long as you do not alter it yourself.')")")"
check 'opens "Security alert: long"' contains "$LOG" 'CREATE [--title] [Security alert: long]'

scenario "s12 someone else's pull request does not count -> raised" "$main_step" FX_ALERTS="$(arr "$b43")" \
  FX_PULLS="$(arr "$(pr 'Nawid3333' 'Bump brace-expansion from 1.1.18 to 1.1.21' 'Bumps [brace-expansion](https://x/b)')")"
check 'opens "Security alert: brace-expansion"' contains "$LOG" 'CREATE [--title] [Security alert: brace-expansion]'

scenario 's13 a package whose name is part of another one updated -> raised' "$main_step" \
  FX_ALERTS="$(arr "$(al 75 fast-uri $old)")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump fast-uri-template from 1 to 2' 'Bumps [fast-uri-template](https://x/f) from 1 to 2.')")"
check 'opens "Security alert: fast-uri"' contains "$LOG" 'CREATE [--title] [Security alert: fast-uri]'

scenario 's14 a scoped package -> raised, the fix names it' "$main_step" FX_ALERTS="$(arr "$(al 73 @types/node $old)")"
check 'opens "Security alert: @types/node"' contains "$LOG" 'CREATE [--title] [Security alert: @types/node]'
check 'the fix names it' contains "$LOG" '`pnpm update @types/node`'

scenario 's15 a scoped package with its Dependabot pull request -> nothing' "$main_step" \
  FX_ALERTS="$(arr "$(al 73 @types/node $old)")" \
  FX_PULLS="$(arr "$(pr 'dependabot[bot]' 'Bump @types/node from 24.1.0 to 24.1.1' '')")"
check 'touches no issue' test ! -s "$LOG"

scenario "s16 an advisory's | and line breaks, no fix yet -> kept inside its table cell" "$main_step" \
  FX_ALERTS="$(arr "$(al 74 evil $old pnpm-lock.yaml '' "$(printf 'a | b\nc')")")"
check 'escapes the |, joins the lines, says none yet' contains "$LOG" '| none yet | a \| b c |'
check 'no bare |' lacks "$LOG" 'a | b'

spoof=$(al 76 spoof $old pnpm-lock.yaml 1.2.3 'Hidden <!-- alerts: 999 --> list')
scenario "s17 an advisory with the issue's marker in it -> its < escaped" "$main_step" FX_ALERTS="$(arr "$spoof")"
check 'escapes the <' contains "$LOG" '| Hidden &lt;!-- alerts: 999 --> list |'
check 'records the real list' contains "$LOG" '<!-- alerts: 76 -->'
check 'writes no other marker' count "$LOG" '<!-- alerts:' 1
spoof_body=$(sed -n '/^--- body:$/,/^--- end body$/p' "$LOG" | sed '1d;$d')

scenario 's18 the next day, the issue s17 opened -> nothing' "$main_step" FX_ALERTS="$(arr "$spoof")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: spoof' "$spoof_body")")"
check 'succeeds' test "$status" -eq 0
check 'touches no issue' test ! -s "$LOG"

# --- The daily run: raised before.

scenario 's19 an open issue lists them all -> nothing' "$main_step" FX_ALERTS="$(arr "$b43" "$b44")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43 44)")")"
check 'succeeds' test "$status" -eq 0
check 'touches no issue' test ! -s "$LOG"

scenario 's20 closed by hand -> never raised again' "$main_step" FX_ALERTS="$(arr "$b43" "$b44")" \
  FX_ISSUES="$(arr "$(is 5 closed 'Security alert: brace-expansion' "$(marker 43 44)")")"
check 'touches no issue' test ! -s "$LOG"

scenario 's21 a new alert for an open issue -> the issue edited, one comment' "$main_step" \
  FX_ALERTS="$(arr "$b43" "$b44" "$b45")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43 44)")")"
check 'succeeds' test "$status" -eq 0
check 'edits #5' contains "$LOG" 'EDIT [5] [--body-file]'
check 'its list gains 45' contains "$LOG" '<!-- alerts: 43 44 45 -->'
check 'comments, mentioning the owner and linking the alert' contains "$LOG" \
  "COMMENT [5] [--body] [@Nawid3333 Another security alert for \`brace-expansion\`, with no pull request that fixes it: [alert 45]($base/45). The list above now includes it.]"
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's22 two new alerts -> one comment naming both' "$main_step" FX_ALERTS="$(arr "$b43" "$b44" "$b45")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43)")")"
check 'names both' contains "$LOG" \
  "More security alerts for \`brace-expansion\`, with no pull request that fixes it: [alert 44]($base/44) [alert 45]($base/45). The list"
check 'one comment' count "$LOG" 'COMMENT [' 1

scenario 's23 a listed alert fixed meanwhile -> kept in the list, out of the table' "$main_step" \
  FX_ALERTS="$(arr "$b44" "$b45")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43 44)")")"
check 'the list keeps 43' contains "$LOG" '<!-- alerts: 43 44 45 -->'
check 'a row for 44' contains "$LOG" "| [44]($base/44) |"
check 'a row for 45' contains "$LOG" "| [45]($base/45) |"
check 'no row for 43' lacks "$LOG" '[43]('
check 'closes nothing' lacks "$LOG" 'CLOSE'

scenario 's24 a new alert after an issue closed by hand -> a new issue, listing the old one too' "$main_step" \
  FX_ALERTS="$(arr "$b43" "$b45")" \
  FX_ISSUES="$(arr "$(is 5 closed 'Security alert: brace-expansion' "$(marker 43)")")"
check 'opens an issue' contains "$LOG" 'CREATE [--title] [Security alert: brace-expansion]'
check 'listing 43 and 45' contains "$LOG" '<!-- alerts: 43 45 -->'
check 'edits nothing' lacks "$LOG" 'EDIT'

scenario "s25 another author's issue with that title is not this workflow's -> raised" "$main_step" \
  FX_ALERTS="$(arr "$b43")" \
  FX_ISSUES="$(arr "$(is 5 closed 'Security alert: brace-expansion' "$(marker 43)" Nawid3333)")"
check 'opens an issue' contains "$LOG" 'CREATE [--title] [Security alert: brace-expansion]'

scenario 's26 an issue without the marker lists nothing -> edited to list the alert' "$main_step" \
  FX_ALERTS="$(arr "$b43")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' 'no marker')")"
check 'edits #5' contains "$LOG" 'EDIT [5]'
check 'to list 43' contains "$LOG" '<!-- alerts: 43 -->'
check 'opens nothing' lacks "$LOG" 'CREATE'

scenario 's27 a pull request in the issues list is not an issue -> raised' "$main_step" FX_ALERTS="$(arr "$b43")" \
  FX_ISSUES='[{"number":5,"state":"closed","title":"Security alert: brace-expansion","body":"<!-- alerts: 43 -->","user":{"login":"github-actions[bot]"},"pull_request":{}}]'
check 'opens an issue' contains "$LOG" 'CREATE [--title] [Security alert: brace-expansion]'

# --- Closing.

scenario 's28 no alert left for an open issue -> closed, naming what became of each' "$main_step" \
  FX_ALERTS="$(arr "$ip52")" STATE_44=dismissed \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43 44)")" \
    "$(is 6 open 'Security alert: ip-address' "$(marker 52)")")"
check 'succeeds' test "$status" -eq 0
check 'closes #5 as completed' contains "$LOG" 'CLOSE [5] [--reason] [completed] [--comment] [No Dependabot alert for `brace-expansion` is open any more:'
check 'alert 43 was fixed' contains "$LOG" "- [alert 43]($base/43): fixed"
check 'alert 44 was dismissed' contains "$LOG" "- [alert 44]($base/44): dismissed"
check 'leaves #6 open: 52 is still open' lacks "$LOG" 'CLOSE [6]'
check 'never writes an alert as #43' lacks "$LOG" '#43'

scenario 's29 a closed issue -> not closed again' "$main_step" \
  FX_ISSUES="$(arr "$(is 5 closed 'Security alert: brace-expansion' "$(marker 43)")")"
check 'touches no issue' test ! -s "$LOG"

scenario "s30 the package's alert from the other lockfile -> keeps the issue open" "$main_step" \
  FX_ALERTS="$(arr "$(al 80 brace-expansion $young fsaunpack/package-lock.json)")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43)")")"
check 'touches no issue' test ! -s "$LOG"

# --- A push to main: closes only, waiting for GitHub to mark the alerts fixed.

scenario 's31 push, no open issue -> done at once' "$main_step" EVENT=push FX_ALERTS="$(arr "$b43")"
check 'succeeds' test "$status" -eq 0
check 'touches no issue and waits for nothing' test ! -s "$LOG"

scenario 's32 push, alerts due and never raised -> raises nothing' "$main_step" EVENT=push \
  FX_ALERTS="$(arr "$b43" "$ip52")" \
  FX_ISSUES="$(arr "$(is 6 closed 'Security alert: ip-address' "$(marker 52)")")"
check 'succeeds' test "$status" -eq 0
check 'touches no issue and waits for nothing' test ! -s "$LOG"

scenario 's33 push, the alerts marked fixed on the third look -> closed after two waits' "$main_step" EVENT=push \
  FX_ALERTS="$(arr "$b43")" FX_FROM_CALL=3 \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43)")")"
check 'succeeds' test "$status" -eq 0
check 'says what it waits for' contains "$FIX/out" '1 open issue(s) still have an open alert; looking again in 30 seconds.'
check 'waits 30 seconds twice' count "$LOG" 'SLEEP [30]' 2
check 'closes #5' contains "$LOG" 'CLOSE [5] [--reason] [completed]'
check 'opens nothing' lacks "$LOG" 'CREATE'

scenario 's34 push, never marked fixed -> gives up after 10 minutes' "$main_step" EVENT=push \
  FX_ALERTS="$(arr "$b43")" \
  FX_ISSUES="$(arr "$(is 5 open 'Security alert: brace-expansion' "$(marker 43)")")"
check 'succeeds' test "$status" -eq 0
check 'waits 30 seconds 20 times' count "$LOG" 'SLEEP [30]' 20
check 'closes nothing' lacks "$LOG" 'CLOSE'
check 'opens nothing' lacks "$LOG" 'CREATE'

# --- Failures.

scenario 's35 the alerts cannot be read -> fails, touches no issue' "$main_step" FX_ALERTS='not json'
check 'fails' test "$status" -ne 0
check 'touches no issue' test ! -s "$LOG"

scenario 's36 failure report, none open -> opens the failure issue' "$report_step" FX_OPEN='[{"title":"Other"}]'
check 'succeeds' test "$status" -eq 0
check 'opens "Security alerts workflow failed", assigned to the owner' contains "$LOG" \
  'CREATE [--title] [Security alerts workflow failed] [--assignee] [Nawid3333]'
check 'mentions the owner and the run URL' contains "$LOG" \
  '@Nawid3333 security-alerts.yml failed: https://github.com/Nawid3333/FastStream/actions/runs/1'

scenario 's37 failure report, already open -> opens nothing' "$report_step" \
  FX_OPEN='[{"title":"Security alerts workflow failed"}]'
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'says already reported' contains "$FIX/out" \
  'Already reported in the open issue "Security alerts workflow failed".'

finish
