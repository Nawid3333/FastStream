#!/usr/bin/env bash
# firefox-api-watch.yml: the review step as the workflow runs it (its arguments from the dispatch
# inputs, the cache memo, the outputs that decide whether the memo is saved), with the real
# tools/firefox-api-watch.mjs reading Mozilla's sources from fixture files (FFW_URLS) and GitHub
# through a stub gh; and the failure issue's two steps. The watcher's own rules (what is
# relevant, the issue's life) are tested in tests/unit/firefoxApiWatch.test.mjs.
source "$(dirname "$0")/lib.sh"

repo=$(cd "$(dirname "$0")/../.." && pwd)
here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
review_step=$here/review.sh
close_step=$here/close.sh
notify_step=$here/notify.sh
step_script firefox-api-watch.yml 'Review the new Firefox releases' > "$review_step" || exit 1
step_script firefox-api-watch.yml 'Close the failure issue' > "$close_step" || exit 1
step_script firefox-api-watch.yml 'Notify on failure' > "$notify_step" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIX/gh.log"
args=("$@")
opt() { local i; for ((i = 0; i < ${#args[@]} - 1; i++)); do if [ "${args[i]}" = "$1" ]; then printf '%s\n' "${args[i + 1]}"; return 0; fi; done; return 1; }
case "$1" in
  api)
    if [ "$2" = --method ]; then
      # A post: its body comes on stdin (--input -), logged whole.
      { printf 'POST %s\n' "$4"; cat; printf '\n--- end post\n'; } >> "$LOG"
      echo '{"number": 42}'
      exit 0
    fi
    case "$2" in
      "repos/$GH_REPO/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=1") cat "$FIX/issues.json" ;;
      "repos/$GH_REPO/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page="*) echo '[]' ;;
      "repos/$GH_REPO/issues/"*"/comments?per_page=100&page="*) echo '[]' ;;
      "repos/$GH_REPO/issues/"*) jq -c --argjson n "${2##*/}" '.[] | select(.number == $n)' "$FIX/issues.json" ;;
      *) echo "stub gh: unexpected request: $2" >&2; exit 2 ;;
    esac ;;
  issue)
    case "$2" in
      list) jq -r "($(opt --jq)) | if . == null then \"\" else . end" "$FIX/open.json" ;;
      create|comment|close) { printf 'ISSUE_%s' "${2^^}"; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG" ;;
      *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
    esac ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

export GH_TOKEN=stub GH_REPO='owner/FastStream' FFW_TODAY=2026-11-21
export RUN_URL='https://github.com/owner/FastStream/actions/runs/1'

# fixtures: a new scenario. Firefox 161 is the current release; its notes name an API the
# extension uses (tabs.sendMessage), so it has a finding.
fixtures() {
  export FIX="$here/fix" LOG="$here/fix/log" RUNNER_TEMP="$here/fix/tmp"
  export GITHUB_STEP_SUMMARY="$here/fix/summary" GITHUB_OUTPUT="$here/fix/output"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP" "$FIX/src"
  : > "$LOG"; : > "$FIX/gh.log"; : > "$GITHUB_STEP_SUMMARY"; : > "$GITHUB_OUTPUT"
  echo '[]' > "$FIX/issues.json"; echo '[]' > "$FIX/open.json"
  echo '{"LATEST_FIREFOX_VERSION": "161.0", "LAST_RELEASE_DATE": "2026-11-20"}' > "$FIX/src/versions.json"
  echo '{"160.0": "2026-11-10", "161.0": "2026-11-20"}' > "$FIX/src/majors.json"
  printf '%s\n' '---' 'title: Firefox 161 release notes for developers (Stable)' '---' '' '## Changes for add-on developers' '' \
    '- {{WebExtAPIRef("tabs.sendMessage()")}} now rejects for a closed frame, instead of never settling. Thanks @someone, see #12. ([Firefox bug 161003](https://bugzil.la/161003))' \
    > "$FIX/src/161.md"
  echo '{"__meta": {"version": "9.9.9"}, "browsers": {}, "webextensions": {"api": {"tabs": {}}}}' > "$FIX/src/bcd.json"
  echo '{"bugs": []}' > "$FIX/src/webextensions-161.json"
  echo '{"bugs": []}' > "$FIX/src/core-161.json"
  echo '<rss><channel></channel></rss>' > "$FIX/src/feed.xml"
  export FFW_BCD_FILE="$FIX/src/bcd.json"
  FFW_URLS=$(node -e '
    const d = "file://" + process.argv[1];
    console.log(JSON.stringify({versions: d + "/versions.json", majors: d + "/majors.json", mdn: d + "/{version}.md",
      bugzilla: d, feed: d + "/feed.xml"}));' "$FIX/src")
  export FFW_URLS
  unset DRY_RUN FROM
}

# review <what>: runs the review step from the repository's root, as the job does.
review() {
  echo "-- $1"
  (cd "$repo" && PATH="$here/bin:$PATH" run_step "$review_step") > "$FIX/out" 2>&1
  status=$?
}

fixtures
review 'r1 first run, a release with a finding -> one issue, the memo saved'
check 'succeeds' test "$status" -eq 0
check 'opens one issue' test "$(grep -c '^POST repos/owner/FastStream/issues$' "$LOG")" -eq 1
check 'titled for the release' contains "$LOG" '"title":"Firefox API Watch: starting with Firefox 161"'
check 'the finding, as a box to tick' contains "$LOG" '- [ ] **Compatibility risk: '
check 'mentions no one' lacks "$LOG" '@someone'
check 'references none of our issues' lacks "$LOG" ' #12'
check 'never edits anything' bash -c '! grep -qE "PATCH|issue edit|ISSUE_EDIT" "$0" "$1"' "$LOG" "$FIX/gh.log"
check 'asks no one' lacks "$FIX/gh.log" 'assignee'
check 'memo: the reviewed version' contains "$GITHUB_OUTPUT" 'memo=161'
check 'memo: saved' contains "$GITHUB_OUTPUT" 'memo_changed=true'
check 'the memo file' test "$(cat "$RUNNER_TEMP/firefox-api-watch/reviewed")" = 161
check 'the summary says where' contains "$GITHUB_STEP_SUMMARY" 'Firefox 161: 1 finding(s) posted to #42.'

fixtures
mkdir -p "$RUNNER_TEMP/firefox-api-watch"
echo 161 > "$RUNNER_TEMP/firefox-api-watch/reviewed"
review 'r2 the memo says 161 was reviewed -> stops after the version check'
check 'succeeds' test "$status" -eq 0
check 'asks GitHub nothing' test ! -s "$FIX/gh.log"
check 'posts nothing' test ! -s "$LOG"
check 'memo: not saved again' contains "$GITHUB_OUTPUT" 'memo_changed=false'
check 'says so' contains "$GITHUB_STEP_SUMMARY" 'was reviewed already'

fixtures
export DRY_RUN=true
review 'r3 a dry run -> reads, posts nothing, saves no memo'
check 'succeeds' test "$status" -eq 0
check 'posts nothing' bash -c '! grep -q "^POST" "$0"' "$LOG"
check 'reads the issues' contains "$FIX/gh.log" 'issues?state=all'
check 'shows the section' contains "$FIX/out" '### Firefox 161 — release review'
check 'memo: not saved' contains "$GITHUB_OUTPUT" 'memo_changed=false'

fixtures
export FROM='160; touch /tmp/ffw-injected'
review 'r4 a "from" input that is not a version -> refused, nothing run'
check 'fails' test "$status" -ne 0
check 'says why' contains "$FIX/out" 'needs a Firefox major version'
check 'posts nothing' test ! -s "$LOG"
check 'ran nothing from the input' test ! -e /tmp/ffw-injected

fixtures
cat > "$FIX/issues.json" <<'EOF'
[{"number": 7, "state": "open", "title": "Firefox API Watch: starting with Firefox 160", "body": "- [x] ticked by the owner", "user": {"login": "github-actions[bot]"}}]
EOF
review 'r5 an open review issue -> the release is a comment on it, the issue is not edited'
check 'succeeds' test "$status" -eq 0
check 'comments on #7' grep -qF 'POST repos/owner/FastStream/issues/7/comments' "$LOG"
check 'opens no issue' bash -c '! grep -q "^POST repos/owner/FastStream/issues$" "$0"' "$LOG"

fixtures
cat > "$FIX/issues.json" <<'EOF'
[{"number": 7, "state": "closed", "title": "Firefox API Watch: starting with Firefox 160", "body": "<!-- ffw-item bug:161003 -->", "user": {"login": "github-actions[bot]"}}]
EOF
review 'r6 the finding is in a closed issue -> reviewed already, nothing posted'
check 'succeeds' test "$status" -eq 0
check 'posts nothing' test ! -s "$LOG"
check 'says so' contains "$GITHUB_STEP_SUMMARY" 'all reported before'

fixtures
rm "$FIX/src/161.md"
export FFW_TODAY=2026-12-05
review 'r7 the notes are still missing 15 days after the release -> reviewed from the other sources'
check 'succeeds' test "$status" -eq 0
check 'says so' contains "$GITHUB_STEP_SUMMARY" 'Firefox 161: reviewed, nothing new'
check 'posts nothing (nothing relevant in the other sources)' test ! -s "$LOG"
check 'memo: saved' contains "$GITHUB_OUTPUT" 'memo_changed=true'
export FFW_TODAY=2026-11-21

fixtures
echo 'not json' > "$FIX/src/webextensions-161.json"
review 'r8 a source answers with something that is no answer -> the run fails, posts nothing'
check 'fails' test "$status" -ne 0
check 'posts nothing' test ! -s "$LOG"
check 'memo: not saved' bash -c '! grep -q "memo_changed=true" "$0"' "$GITHUB_OUTPUT"

# The failure issue's steps take its title from their env:, as the workflow sets it.
export TITLE='Firefox API watch failed'

fixtures
echo '[{"number": 3, "title": "Firefox API watch failed"}]' > "$FIX/open.json"
(PATH="$here/bin:$PATH" run_step "$close_step") > "$FIX/out" 2>&1
check 'c1 a clean run closes the failure issue' grep -qF 'ISSUE_CLOSE [3] [--comment]' "$LOG"

fixtures
(PATH="$here/bin:$PATH" run_step "$notify_step") > "$FIX/out" 2>&1
check 'n1 a failure with none open opens the failure issue' grep -qF 'ISSUE_CREATE [--title] [Firefox API watch failed]' "$LOG"
check '... mentions no one' bash -c '! grep -q "@" "$0"' "$LOG"

fixtures
echo '[{"number": 3, "title": "Firefox API watch failed"}]' > "$FIX/open.json"
(PATH="$here/bin:$PATH" run_step "$notify_step") > "$FIX/out" 2>&1
check 'n2 a failure with one open comments on it' grep -qF 'ISSUE_COMMENT [3] [--body]' "$LOG"
check '... and opens no second one' lacks "$LOG" 'ISSUE_CREATE'

finish
