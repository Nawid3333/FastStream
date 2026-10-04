#!/usr/bin/env bash
# amo-signing-failsafe.yml:
#   already_reported, which its three "tell the owner" steps ask before opening an issue: an
#   open issue with the title counts, and a closed one when a person closed it; one the
#   workflow closed itself (the problem was gone) does not, so the same thing breaking
#   again is reported again.
#   "Start release.yml again for a tag it did not publish": only the release.yml runs since
#   the tag was made count toward its two restarts, so a tag made again starts afresh; and a
#   run still going when the wait ends is left to finish, never doubled.
#   "Look at the newest tag and the latest release": a latest release that cannot be read
#   stops the run, rather than going on with no tag.
#   "Report this workflow's own failure": one issue, then comments on it.
# gh and git are stubs answering from $FIX; calls are logged to $LOG.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script amo-signing-failsafe.yml 'Define already_reported' > "$here/define.sh" || exit 1
step_script amo-signing-failsafe.yml 'Start release.yml again for a tag it did not publish' > "$here/restart.sh" || exit 1
step_script amo-signing-failsafe.yml 'Look at the newest tag and the latest release' > "$here/look.sh" || exit 1
step_script amo-signing-failsafe.yml "Report this workflow's own failure" > "$here/report.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LOG"
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]-}; fi
done
case "$1 $2" in
  'issue list') jq -r "$jqf" "$FIX/issues.json" ;;
  'api --paginate')
    n=${3#repos/me/fs/issues/}; n=${n%/events}
    [ -f "$FIX/events-$n.json" ] || { echo 'stub gh: HTTP 502' >&2; exit 1; }
    jq -r "$jqf" "$FIX/events-$n.json" ;;
  'run list') jq -r "$jqf" "$FIX/runs.json" ;;
  'release view')
    # With --json: the latest release, or with a tag that one's assets, from latest.json.
    # A fail-first file makes the first such call fail, as a hiccup of the API would.
    # Without --json: whether a tag has a release; none has.
    case " $* " in
      *' --json '*)
        if [ -f "$FIX/fail-first" ]; then rm "$FIX/fail-first"; echo 'stub gh: HTTP 502' >&2; exit 1; fi
        [ -f "$FIX/latest.json" ] || { echo 'stub gh: release not found' >&2; exit 1; }
        jq -r "$jqf" "$FIX/latest.json" ;;
      *) exit 1 ;;
    esac ;;
  'workflow run') ;;
  'issue create') ;;
  'issue comment') ;;
  *) echo "stub gh: unexpected: $*" >&2; exit 2 ;;
esac
EOF
cat > "$here/bin/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  # git tag -l 'v*': the repository's tags.
  tag) cat "$FIX/tags" 2> /dev/null || true ;;
  # git for-each-ref --format='%(creatordate:unix)' refs/tags/<tag>: when the tag was made.
  *) cat "$FIX/tagged" ;;
esac
EOF
printf '#!/usr/bin/env bash\n' > "$here/bin/sleep"
chmod +x "$here/bin/gh" "$here/bin/git" "$here/bin/sleep"

export GITHUB_REPOSITORY=me/fs OWNER=nawid GITHUB_SERVER_URL=https://github.com
fresh() {
  export FIX=$here/fix LOG=$here/fix/log RUNNER_TEMP=$here/fix/tmp
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"
}

# reported <title>: already_reported's answer, after the step that defines it ran.
reported() {
  (PATH="$here/bin:$PATH" run_step "$here/define.sh" && PATH="$here/bin:$PATH" bash -c \
    'set -euo pipefail; source "$RUNNER_TEMP/already-reported.sh"; already_reported "$1"' _ "$1") > "$FIX/out" 2>&1
}
not_reported() { ! reported "$1"; }
issue() { # <number> <state> [closed by]
  jq --argjson n "$1" --arg s "$2" '. + [{number: $n, state: $s, title: "Release v1.3.82.49 failed"}]' \
    "$FIX/issues.json" > "$FIX/i.tmp" && mv "$FIX/i.tmp" "$FIX/issues.json"
  if [ -n "${3-}" ]; then
    jq -n --arg who "$3" '[{event: "labeled", actor: {login: "someone"}}, {event: "closed", actor: {login: $who}}]' > "$FIX/events-$1.json"
  fi
}

echo 'no issue with the title'
fresh; echo '[]' > "$FIX/issues.json"
check 'not reported' not_reported 'Release v1.3.82.49 failed'

echo 'an open one'
fresh; echo '[]' > "$FIX/issues.json"; issue 7 OPEN
check 'reported' reported 'Release v1.3.82.49 failed'

echo 'closed by the workflow (the problem was gone): it broke again'
fresh; echo '[]' > "$FIX/issues.json"; issue 7 CLOSED 'github-actions[bot]'
check 'not reported' not_reported 'Release v1.3.82.49 failed'

echo 'closed by the owner: stop telling him'
fresh; echo '[]' > "$FIX/issues.json"; issue 7 CLOSED nawid
check 'reported' reported 'Release v1.3.82.49 failed'

echo 'closed by the workflow once, by the owner later'
fresh; echo '[]' > "$FIX/issues.json"; issue 7 CLOSED 'github-actions[bot]'; issue 9 CLOSED nawid
check 'reported' reported 'Release v1.3.82.49 failed'

echo "who closed it can't be read"
fresh; echo '[]' > "$FIX/issues.json"; issue 7 CLOSED
check 'counts as a person: reported' reported 'Release v1.3.82.49 failed'

# restart <tag age, minutes>: runs the restart step on v1.3.82.49 with $FIX/runs.json.
restart() {
  echo $(( $(date +%s) - $1 * 60 )) > "$FIX/tagged"
  # The job defines already_reported first.
  (PATH="$here/bin:$PATH" run_step "$here/define.sh" &&
    ORPHAN=v1.3.82.49 PATH="$here/bin:$PATH" run_step "$here/restart.sh") > "$FIX/out" 2>&1
}
run_at() { # <minutes ago> <status>: a release.yml run for the tag
  jq --arg t "$(date -u -d "$1 minutes ago" +%Y-%m-%dT%H:%M:%SZ)" --arg s "$2" '. + [{status: $s, createdAt: $t}]' \
    "$FIX/runs.json" > "$FIX/r.tmp" && mv "$FIX/r.tmp" "$FIX/runs.json"
}

echo 'a tag made again: the two failed runs were for the one before'
fresh; echo '[]' > "$FIX/issues.json"; echo '[]' > "$FIX/runs.json"
run_at 300 completed; run_at 290 completed
restart 30
check 'starts release.yml again' contains "$LOG" 'workflow run release.yml --repo me/fs --ref v1.3.82.49'
check 'opens no issue' lacks "$LOG" 'issue create'

echo 'two failed runs since the tag was made'
fresh; echo '[]' > "$FIX/issues.json"; echo '[]' > "$FIX/runs.json"
run_at 20 completed; run_at 10 completed
restart 30
check 'starts nothing more' lacks "$LOG" 'workflow run'
check 'tells the owner' contains "$LOG" 'issue create'

echo 'release.yml still signing when the wait ends (the schedule came during the release)'
fresh; echo '[]' > "$FIX/issues.json"; echo '[]' > "$FIX/runs.json"
run_at 24 in_progress
check 'the step passes' restart 25
check 'says the next run looks again' contains "$FIX/out" 'still running for v1.3.82.49 after 15 minutes'
check 'starts no second release.yml beside it' lacks "$LOG" 'workflow run'
check 'opens no issue' lacks "$LOG" 'issue create'

not() { ! "$@"; }

# look: runs "Look at the newest tag and the latest release"; its status is the test's.
look() {
  export GITHUB_OUTPUT=$FIX/output
  : > "$GITHUB_OUTPUT"
  PATH="$here/bin:$PATH" run_step "$here/look.sh" > "$FIX/out" 2>&1
}
latest() { # <tag>: the latest release, published two hours ago, complete
  jq -n --arg tag "$1" --arg at "$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
    '{tagName: $tag, publishedAt: $at, assets: [{name: "firefox-github-\($tag).zip"}, {name: "faststream.xpi"}, {name: "updates.json"}]}' \
    > "$FIX/latest.json"
}

echo 'the latest release, complete, and the newest tag is its own'
fresh; latest v1.3.82.57; printf 'v1.3.82.56\nv1.3.82.57\nV1.3.77\n' > "$FIX/tags"
check 'the step passes' look
check 'names the tag' grep -qx 'tag=v1.3.82.57' "$FIX/output"
check 'complete' grep -qx 'complete=true' "$FIX/output"
check 'no orphan' grep -qx 'orphan=' "$FIX/output"

echo 'reading the latest release fails once (the API hiccups), then answers'
fresh; latest v1.3.82.57; printf 'v1.3.82.57\n' > "$FIX/tags"; : > "$FIX/fail-first"
check 'the step fails' not look
check 'with no tag handed on' lacks "$FIX/output" 'tag='

echo 'the latest release reads as no tag'
fresh; latest ''; printf 'v1.3.82.57\n' > "$FIX/tags"
check 'the step fails' not look
check 'says why' contains "$FIX/out" 'no tag or no publication date'
check 'with no tag handed on' lacks "$FIX/output" 'tag='

# report <issues.json>: runs "Report this workflow's own failure" against those open issues.
report() {
  echo "$1" > "$FIX/issues.json"
  RUN_URL=https://github.com/me/fs/actions/runs/7 TITLE='Release failsafe failed' \
    PATH="$here/bin:$PATH" run_step "$here/report.sh" > "$FIX/out" 2>&1
}

echo 'the failsafe failed, no issue open'
fresh
check 'the step passes' report '[{"number": 3, "title": "Other"}]'
check 'opens "Release failsafe failed"' contains "$LOG" 'issue create --repo me/fs --title Release failsafe failed --assignee nawid'

echo 'the failsafe failed again, its issue open'
fresh
check 'the step passes' report '[{"number": 3, "title": "Other"}, {"number": 12, "title": "Release failsafe failed"}]'
check 'comments on it' contains "$LOG" 'issue comment 12 --repo me/fs'
check 'opens no second one' lacks "$LOG" 'issue create'

finish
