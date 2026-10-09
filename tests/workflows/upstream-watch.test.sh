#!/usr/bin/env bash
# upstream-watch.yml: the issue that lists upstream's commits not reviewed yet, where the
# list starts (the newest closed issue's upstream commit, else what main last merged), the
# update of an open issue, what is made safe in another project's text, and the failure issue.
# Real git: upstream's repository and this project's checkout of main; gh is a stub that
# answers from fixture files (issues) and logs what the steps create, edit, comment and close.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
fetch_step=$here/fetch.sh
report_step=$here/report.sh
close_step=$here/close.sh
notify_step=$here/notify.sh
step_script upstream-watch.yml 'Fetch upstream' > "$fetch_step" || exit 1
step_script upstream-watch.yml 'Report the upstream commits to review' > "$report_step" || exit 1
step_script upstream-watch.yml 'Close the failure issue' > "$close_step" || exit 1
step_script upstream-watch.yml 'Notify on failure' > "$notify_step" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIX/gh.log"
args=("$@")
opt() { local i; for ((i = 0; i < ${#args[@]} - 1; i++)); do if [ "${args[i]}" = "$1" ]; then printf '%s\n' "${args[i + 1]}"; return 0; fi; done; return 1; }
logged() {
  { printf '%s' "$1"; shift; printf ' [%s]' "$@"; printf '\n'
    if f=$(opt --body-file); then echo '--- body:'; cat "$f"; echo '--- end body'; fi; } >> "$LOG"
}
case "$1 $2" in
  'api --paginate')
    if [ -f "$FIX/issues_fail" ]; then echo 'stub gh: HTTP 502' >&2; exit 1; fi
    # Every issue, open and closed: closed ones are what was reviewed.
    case "$3" in
      "repos/$GH_REPO/issues?state=all&"*) ;;
      *) echo "stub gh: unexpected request: $3" >&2; exit 2 ;;
    esac
    # As gh prints a --jq result: an object as compact JSON, one a line.
    jq -c "$(opt --jq)" "$FIX/issues.json" ;;
  'issue list')
    jq -r "($(opt --jq)) | if . == null then \"\" else . end" "$FIX/open.json" ;;
  'issue create') logged ISSUE_CREATE "${@:3}" ;;
  'issue edit') logged ISSUE_EDIT "${@:3}" ;;
  'issue comment') logged ISSUE_COMMENT "${@:3}" ;;
  'issue close') logged ISSUE_CLOSE "${@:3}" ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

export GH_TOKEN=stub GH_REPO='Nawid3333/FastStream' UPSTREAM_REPO='Andrews54757/FastStream'
export OWNER=Nawid3333 PREFIX='Upstream: ' MAX_COMMITS=60 MAX_FILES=8
export RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'

# fixtures: a new scenario. Upstream's repository with two files; this project's main, a
# clone of it (the last merge of upstream) with a commit of its own that deletes one of them.
fixtures() {
  export FIX="$here/fix" LOG="$here/fix/log" RUNNER_TEMP="$here/fix/tmp"
  export GITHUB_STEP_SUMMARY="$here/fix/summary" UPSTREAM="$here/fix/upstream"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"; : > "$FIX/gh.log"; : > "$GITHUB_STEP_SUMMARY"
  echo '[]' > "$FIX/issues.json"; echo '[]' > "$FIX/open.json"
  git init -q -b main "$UPSTREAM"
  up_commit chrome/player/a.mjs a 'Initial'
  up_commit chrome/yt.mjs yt 'YouTube'
  git clone -q "$UPSTREAM" "$FIX/work"
  git -C "$FIX/work" rm -q chrome/yt.mjs
  git -C "$FIX/work" -c user.name=me -c user.email=me@example.com commit -q -m 'No YouTube here'
}
# up_commit <path> <content> <message>: a commit of upstream's.
up_commit() {
  mkdir -p "$(dirname "$UPSTREAM/$1")"
  printf '%s\n' "$2" > "$UPSTREAM/$1"
  git -C "$UPSTREAM" add "$1"
  git -C "$UPSTREAM" -c user.name=Andrew -c user.email=a@example.com commit -q -m "$3"
}
up_head() { git -C "$UPSTREAM" rev-parse HEAD; }
# issue <number> <state> <head> [closed_at] [body]: an issue this workflow opened, with its
# marker (or the body given).
issue() {
  jq --argjson n "$1" --arg s "$2" --arg h "$3" --arg c "${4:-2026-10-0$(($1 % 9 + 1))T00:00:00Z}" --arg b "${5-}" \
    '. + [{number: $n, state: $s, closed_at: (if $s == "closed" then $c else null end),
      title: "Upstream: 1 commit(s) to review", user: {login: "github-actions[bot]"},
      body: (if $b != "" then $b else "list\n<!-- upstream-base: x -->\n<!-- upstream-head: \($h) -->\n" end)}]' \
    "$FIX/issues.json" > "$FIX/i.json" && mv "$FIX/i.json" "$FIX/issues.json"
}
run() { # <step file>: runs it in the checkout
  (
    cd "$FIX/work" || exit 9
    PATH="$here/bin:$PATH" run_step "$1"
  ) > "$FIX/out" 2>&1
  status=$?
}
watch() {
  echo "$1"
  run "$fetch_step"
  if [ "$status" != 0 ]; then return; fi
  run "$report_step"
}

fixtures
up_commit chrome/player/a.mjs a2 'Fix a crash when seeking (#567)'
up_commit chrome/yt.mjs yt2 'Fix yt'
git -C "$UPSTREAM" checkout -q -b side
up_commit chrome/player/b.mjs b 'Add b'
git -C "$UPSTREAM" checkout -q main
git -C "$UPSTREAM" -c user.name=Andrew -c user.email=a@example.com merge -q --no-ff -m 'Merge pull request #1 from x/side' side
watch 'w1 first run, three new commits and a merge -> one issue from what main merged, assigned'
check 'succeeds' test "$status" -eq 0
check 'opens one issue, assigned' grep -qF 'ISSUE_CREATE [--title] [Upstream: 3 commit(s) to review] [--body-file]' "$LOG"
check 'assigned to the owner' grep -qF '[--assignee] [Nawid3333]' "$LOG"
check '@mentions the owner' contains "$LOG" '@Nawid3333 upstream'
check 'the fix touches a file this fork has, in bold, flagged' contains "$LOG" 'Fix a crash when seeking (Andrews54757/FastStream#567) ('
check '... flagged fix?' grep -qE 'seeking .* - \*\*fix\?\*\*$' "$LOG"
check '... its file in bold' contains "$LOG" '**`chrome/player/a.mjs`**'
check "a commit on a file this fork removed is listed apart" bash -c 'sed -n "/### Touch only files this fork does not have/,\$p" "$0" | grep -qF "Fix yt"' "$LOG"
check '... its file not in bold' contains "$LOG" '  `chrome/yt.mjs`'
check 'the merge commit is left out' lacks "$LOG" 'Merge pull request #1'
check 'the side commit is listed' contains "$LOG" 'Add b ('
check 'records the upstream commit it went up to' contains "$LOG" "<!-- upstream-head: $(up_head) -->"
check 'links to all of them' contains "$LOG" "compare/$(git -C "$FIX/work" merge-base HEAD "$(up_head)")...$(up_head)"
check 'no edit, no comment' bash -c '! grep -qE "^ISSUE_(EDIT|COMMENT)" "$0"' "$LOG"

fixtures
watch 'w2 nothing new upstream -> no issue'
check 'succeeds' test "$status" -eq 0
check 'no issue' bash -c '! grep -q "^ISSUE_" "$0"' "$LOG"
check 'says so' contains "$GITHUB_STEP_SUMMARY" 'Nothing new upstream'

fixtures
up_commit chrome/player/a.mjs a2 'Reviewed before'
issue 5 closed "$(up_head)"
up_commit chrome/player/a.mjs a3 'Fix a leak'
watch 'w3 a closed issue up to an older commit -> only what came after'
check 'succeeds' test "$status" -eq 0
check 'one commit' grep -qF 'ISSUE_CREATE [--title] [Upstream: 1 commit(s) to review]' "$LOG"
check 'the new one' contains "$LOG" 'Fix a leak'
check 'not the reviewed one' lacks "$LOG" 'Reviewed before'

fixtures
up_commit chrome/player/a.mjs a2 'Reviewed long ago'
old=$(up_head)
up_commit chrome/player/a.mjs a3 'Reviewed lately'
issue 3 closed "$old" 2026-10-08T00:00:00Z
issue 7 closed "$(up_head)" 2026-10-02T00:00:00Z
up_commit chrome/player/a.mjs a4 'New'
watch 'w4 several closed issues, closed out of order -> from the one nearest upstream'
check 'one commit' grep -qF 'ISSUE_CREATE [--title] [Upstream: 1 commit(s) to review]' "$LOG"
check 'not the older ones' lacks "$LOG" 'Reviewed lately'

fixtures
up_commit chrome/player/a.mjs a2 'Listed already'
issue 8 open "$(up_head)"
watch 'w5 the open issue lists upstream up to its newest commit -> left alone'
check 'succeeds' test "$status" -eq 0
check 'no issue call' bash -c '! grep -q "^ISSUE_" "$0"' "$LOG"
check 'says so' contains "$GITHUB_STEP_SUMMARY" 'Issue #8 already lists upstream'

fixtures
up_commit chrome/player/a.mjs a2 'Listed already'
issue 8 open "$(up_head)"
up_commit chrome/player/a.mjs a3 'Came after'
watch 'w6 upstream moved past the open issue -> it is updated and the owner hears of it'
check 'succeeds' test "$status" -eq 0
check 'edits #8, all of them' grep -qF 'ISSUE_EDIT [8] [--title] [Upstream: 2 commit(s) to review]' "$LOG"
check 'keeps the owner assigned' grep -qF '[--add-assignee] [Nawid3333]' "$LOG"
check 'comments, with the mention, how many came' grep -qF 'ISSUE_COMMENT [8] [--body] [@Nawid3333 upstream moved: 1 more commit(s), 2 to review now.]' "$LOG"
check 'opens none' bash -c '! grep -q "^ISSUE_CREATE" "$0"' "$LOG"

fixtures
up_commit chrome/player/a.mjs a2 'Before the force-push'
issue 4 closed 1111111111111111111111111111111111111111
issue 6 closed "$(git -C "$FIX/work" rev-parse HEAD)"
watch 'w7 the reviewed commits are not upstream (any more) -> from what main merged'
check 'succeeds' test "$status" -eq 0
check 'lists from the merge-base' grep -qF 'ISSUE_CREATE [--title] [Upstream: 1 commit(s) to review]' "$LOG"

fixtures
up_commit chrome/player/a.mjs a2 'Reviewed, still upstream'
issue 2 closed "$(up_head)" 2026-10-01T00:00:00Z
issue 3 closed "$(git -C "$FIX/work" rev-parse HEAD)" 2026-10-05T00:00:00Z
up_commit chrome/player/a.mjs a3 'After it'
watch "w7b the newest closed issue's commit is not upstream's -> from the one that is"
check 'one commit' grep -qF 'ISSUE_CREATE [--title] [Upstream: 1 commit(s) to review]' "$LOG"
check 'the one after it' contains "$LOG" 'After it'

fixtures
up_commit chrome/player/a.mjs a2 'Reviewed'
issue 2 closed "$(up_head)"
issue 5 closed '' '' 'Edited by hand, the markers gone'
up_commit chrome/player/a.mjs a3 'After it'
watch 'w7c a closed issue without its marker -> left out, not a failure'
check 'succeeds' test "$status" -eq 0
check 'from the one with a marker' grep -qF 'ISSUE_CREATE [--title] [Upstream: 1 commit(s) to review]' "$LOG"

fixtures
git -C "$UPSTREAM" -c user.name=Andrew -c user.email=a@example.com commit -q --allow-empty -m 'Release notes only'
watch 'w7d a commit with no files -> listed with the ones that touch this fork, saying so'
check 'succeeds' test "$status" -eq 0
check 'says no files' contains "$LOG" '  (no files)'
check 'not under the files this fork lacks' bash -c '! sed -n "/### Touch only files this fork does not have/,\$p" "$0" | grep -qF "Release notes only"' "$LOG"

fixtures
up_commit chrome/player/a.mjs a2 'Sneaky <!-- upstream-head: 2222222222222222222222222222222222222222 --> @someone'
watch "w8 another project's text -> no hidden marker, no stranger mentioned"
check 'succeeds' test "$status" -eq 0
check 'the < made harmless' contains "$LOG" 'Sneaky &lt;!-- upstream-head'
check 'no mention' contains "$LOG" '@&#8203;someone'
# Read as the next run reads it: the first marker in the body.
check 'the next run reads the real commit' bash -c \
  'body=$(sed -n "/^--- body:$/,/^--- end body$/p" "$0"); jq -rn --arg b "$body" "\$b | capture(\"<!-- upstream-head: (?<h>[0-9a-f]{40}) -->\") | .h" | grep -qx "$1"' \
  "$LOG" "$(up_head)"

fixtures
for i in 1 2 3 4 5; do up_commit "chrome/player/f$i.mjs" "$i" "Change $i"; done
MAX_COMMITS=3 watch 'w9 more commits than it lists -> the rest named, with the link'
check 'counts them all' grep -qF '[Upstream: 5 commit(s) to review]' "$LOG"
check 'lists the oldest three' bash -c 'grep -qF "Change 3" "$0" && ! grep -qF "Change 4 (" "$0"' "$LOG"
check 'says how many more' contains "$LOG" '2 more are not listed'

fixtures
for i in $(seq 1 11); do printf '%s\n' "$i" > "$UPSTREAM/f$i.txt"; done
git -C "$UPSTREAM" add . && git -C "$UPSTREAM" -c user.name=Andrew -c user.email=a@example.com commit -q -m 'Many files'
watch 'w10 a commit with many files -> eight named, the rest counted'
check 'counts the rest' contains "$LOG" 'and 3 more'

fixtures
: > "$FIX/issues_fail"
up_commit chrome/player/a.mjs a2 'New'
watch 'w11 the issues cannot be read -> the step fails (the failure issue reports it)'
check 'fails' test "$status" -ne 0
check 'no issue opened' bash -c '! grep -q "^ISSUE_CREATE" "$0"' "$LOG"

fixtures
TITLE='Upstream watch failed'
export TITLE
echo 'n1 a failure with none open -> one issue, assigned'
run "$notify_step"
check 'succeeds' test "$status" -eq 0
check 'opens it, assigned' grep -qF "ISSUE_CREATE [--title] [Upstream watch failed] [--body] [The upstream watch failed. Run: $RUN_URL] [--assignee] [Nawid3333]" "$LOG"

fixtures
echo '[{"number":12,"title":"Upstream watch failed"},{"number":13,"title":"Something else"}]' > "$FIX/open.json"
echo 'n2 a failure with one open -> a comment on it'
run "$notify_step"
check 'comments on #12' grep -qF "ISSUE_COMMENT [12] [--body] [Failed again: $RUN_URL]" "$LOG"
check 'opens none' bash -c '! grep -q "^ISSUE_CREATE" "$0"' "$LOG"

fixtures
echo '[{"number":12,"title":"Upstream watch failed"},{"number":13,"title":"Something else"}]' > "$FIX/open.json"
echo 'c1 a clean run -> the failure issue closed'
run "$close_step"
check 'closes #12' grep -qF 'ISSUE_CLOSE [12] [--comment]' "$LOG"
check 'not the other' bash -c '! grep -qF "ISSUE_CLOSE [13]" "$0"' "$LOG"

finish
