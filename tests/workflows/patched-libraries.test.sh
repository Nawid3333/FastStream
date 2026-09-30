#!/usr/bin/env bash
# patched-libraries.yml's supersede() sweep: a newer update for a library closes the older
# pull requests and issues for it. The function alone, taken out of its step, with a stub
# gh (jq for real). This test keeps its own check.
source "$(dirname "$0")/lib.sh"
set -e
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
awk '/^          supersede\(\) \{/ {f=1} f {print substr($0, 11)} f && /^          }$/ {exit}' \
  "$WORKFLOWS_DIR/patched-libraries.yml" > "$T/supersede.sh"
if [ ! -s "$T/supersede.sh" ]; then
  echo 'no supersede() function in patched-libraries.yml'
  exit 1
fi
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$T/gh.log"
jqarg() { local p a; for a; do [ "${p-}" = --jq ] && printf '%s' "$a"; p=$a; done; }
case "$1 $2" in
  'issue list'|'pr list')
    [[ " $* " == *' --state open --limit 200 '* ]] || { echo "not a list of all open ones: $*" >&2; exit 99; }
    jq -r "$(jqarg "$@")" "$T/${1}s.json" ;;
  'issue close'|'pr close') if [ -f "$T/close_fails" ]; then exit 1; fi ;;
  *) echo "unhandled: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$T/bin/gh"
export T PATH="$T/bin:$PATH" RUNNER_TEMP=$T
PREFIX='Patched library update: '
fails=0
check() { if "${@:2}"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
# The author as `gh pr/issue list --json author` gives it: app/github-actions for the
# workflow's token (the REST API, which the workflow reads the titles from, says
# github-actions[bot]).
item() { # <number> <title> [author] -> json
  printf '{"number": %s, "title": "%s", "url": "https://github.com/me/fs/x/%s", "author": {"login": "%s"}}' "$1" "$2" "$1" "${3:-app/github-actions}"
}
export PREFIX
# Its own bash, as in the workflow: set -e is off inside a subshell whose status is tested.
run() { : > "$T/gh.log"; rc=0; bash -c 'set -euo pipefail; source "$T/supersede.sh"; supersede' > "$T/out" 2>&1 || rc=$?; }

# PRs for hls.js 1.6.10, 1.6.12 and 1.6.11, an older issue, and other libraries.
echo "[$(item 1 'Patched library update: hls.js 1.6.9'), $(item 2 'Patched library update: hls.js-extra 1.0.0'), $(item 3 'Patched library update: dashjs 5.1.0'), $(item 4 'Something else hls.js 1.0.0')]" > "$T/issues.json"
echo "[$(item 10 'Patched library update: hls.js 1.6.10'), $(item 11 'Patched library update: hls.js 1.6.12'), $(item 12 'Patched library update: hls.js 1.6.11'), $(item 20 'Patched library update: hls.js 1.6.20' stranger)]" > "$T/prs.json"
run
check 'exit 0' test "$rc" -eq 0
check 'older issue closed by the newest pr' grep -qxF 'issue close 1 --comment Superseded by hls.js 1.6.12: https://github.com/me/fs/x/11' "$T/gh.log"
check 'older pr closed with its branch' grep -qxF 'pr close 10 --delete-branch --comment Superseded by hls.js 1.6.12: https://github.com/me/fs/x/11' "$T/gh.log"
check 'middle pr closed by the newest' grep -qxF 'pr close 12 --delete-branch --comment Superseded by hls.js 1.6.12: https://github.com/me/fs/x/11' "$T/gh.log"
check 'a stranger neither replaces nor is closed' bash -c '! grep -q "x/20\|close 20 " "$0"' "$T/gh.log"
check 'newest kept' bash -c '! grep -q "close 11 " "$0"' "$T/gh.log"
check 'other libraries kept' bash -c '! grep -qE "close (2|3|4) " "$0"' "$T/gh.log"

# A newer issue replaces older issues only.
echo "[$(item 1 'Patched library update: hls.js 1.6.9'), $(item 13 'Patched library update: hls.js 1.6.11')]" > "$T/issues.json"
echo "[$(item 10 'Patched library update: hls.js 1.6.10')]" > "$T/prs.json"
run
check 'issue: exit 0' test "$rc" -eq 0
check 'issue: older issue closed' grep -qxF 'issue close 1 --comment Superseded by hls.js 1.6.11: https://github.com/me/fs/x/13' "$T/gh.log"
check 'issue: older pr kept' bash -c '! grep -q "^pr close" "$0"' "$T/gh.log"
check 'issue: newer issue kept' bash -c '! grep -q "close 13 " "$0"' "$T/gh.log"

# Nothing to supersede: an issue never replaces a pull request, and nothing is newer than the issue.
echo "[$(item 1 'Patched library update: hls.js 1.6.11')]" > "$T/issues.json"
echo "[$(item 10 'Patched library update: hls.js 1.6.10')]" > "$T/prs.json"
run
check 'nothing: exit 0' test "$rc" -eq 0
check 'nothing closed' bash -c '! grep -q close "$0"' "$T/gh.log"

# A failed close warns and goes on with the rest; the next run retries.
echo "[$(item 1 'Patched library update: hls.js 1.6.9'), $(item 5 'Patched library update: dashjs 5.0.0')]" > "$T/issues.json"
echo "[$(item 10 'Patched library update: hls.js 1.6.10'), $(item 14 'Patched library update: dashjs 5.2.0'), $(item 15 'Patched library update: hls.js 1.6.13')]" > "$T/prs.json"
: > "$T/close_fails"
run
rm "$T/close_fails"
check 'close failure: exit 0' test "$rc" -eq 0
check 'close failure: both issues tried' test "$(grep -c '^issue close' "$T/gh.log")" = 2
check 'close failure: and the pull request' test "$(grep -c '^pr close 10 ' "$T/gh.log")" = 1
check 'close failure: warns' grep -qF '::warning::Could not close #1 as superseded by hls.js 1.6.13; the next run tries again.' "$T/out"
check 'close failure: warns for the pull request' grep -qF '::warning::Could not close #10 as superseded by hls.js 1.6.13; the next run tries again.' "$T/out"

# A list failure fails the step.
mv "$T/prs.json" "$T/prs.gone"
run
check 'list failure fails' test "$rc" -ne 0
echo "$fails failed"
[ "$fails" = 0 ]
