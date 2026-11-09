#!/usr/bin/env bash
# daily-digest.yml's "Post the digest": one comment a day on the pinned "Daily digest" issue,
# @mentioning the owner once, with what happened since its last comment; nothing on a quiet
# day. gh and date's "now" are real but gh is stubbed: it answers from $STATE and logs calls.
source "$(dirname "$0")/lib.sh"
STEP=$(mktemp)
step_script daily-digest.yml 'Post the digest' > "$STEP" || exit 1
TDIRS=()
cleanup() { rm -f "$STEP"; rm -rf "${TDIRS[@]}"; }
trap cleanup EXIT
checks=0
fails=0
scenario=

check() {
  local desc=$1
  shift
  checks=$((checks + 1))
  if "$@"; then
    printf 'PASS %s: %s\n' "$scenario" "$desc"
  else
    printf 'FAIL %s: %s\n' "$scenario" "$desc"
    tail -n 20 "$T/out"
    fails=$((fails + 1))
  fi
}

setup() {
  scenario=${FUNCNAME[1]}
  T=$(mktemp -d)
  TDIRS+=("$T")
  STATE=$T/state BIN=$T/bin
  mkdir -p "$STATE" "$BIN" "$T/tmp"
  export STATE PATH="$BIN:$PATH" RUNNER_TEMP=$T/tmp GH_TOKEN=x GH_REPO=me/fs OWNER=nawid
  export GITHUB_SERVER_URL=https://github.com GITHUB_WORKFLOW='Daily digest'
  export SELF_URL=https://github.com/me/fs/actions/runs/9000
  # An hour ago, two days ago: times inside and outside the window of a digest a day ago.
  HOUR_AGO=$(date -u -d '-1 hour' '+%Y-%m-%dT%H:%M:%SZ')
  OLD=$(date -u -d '-2 days' '+%Y-%m-%dT%H:%M:%SZ')
  DAY_AGO=$(date -u -d '-1 day' '+%Y-%m-%dT%H:%M:%SZ')
  echo '[{"number": 900, "title": "Daily digest", "author": {"login": "app/github-actions"}, "state": "OPEN"}]' > "$STATE/issues.json"
  jq -n --arg t "$DAY_AGO" '[{user: {login: "github-actions[bot]"}, created_at: $t, body: "yesterday\n<!-- daily-digest: \($t) -->"}]' > "$STATE/comments-900.json"
  echo '[]' > "$STATE/runs.json"
  echo '[]' > "$STATE/review-comments.json"
  echo '[]' > "$STATE/prs.json"
  echo '[]' > "$STATE/closed-prs.json"
  echo '[]' > "$STATE/created-issues.json"
  echo '[]' > "$STATE/closed-issues.json"
  echo '[]' > "$STATE/releases.json"
  echo '[]' > "$STATE/all-comments.json"
  echo '[]' > "$STATE/dependabot.json"
  echo '[]' > "$STATE/code-scanning.json"
  : > "$STATE/gh.log"
  cat > "$BIN/gh" <<'GHSTUB'
#!/usr/bin/env bash
set -e
printf '%s\n' "$*" >> "$STATE/gh.log"
ORIG=("$@")
opt() { local flag=$1 prev= a; shift; for a in "$@"; do if [ "$prev" = "$flag" ]; then printf '%s\n' "$a"; return 0; fi; prev=$a; done; return 1; }
out() { local e; if e=$(opt --jq "${ORIG[@]}"); then jq -r "$e" "$1"; else cat "$1"; fi; }
case "$1 $2" in
  'issue list')
    s=$(opt --search "$@" || true)
    case $s in
      created:*) out "$STATE/created-issues.json" ;;
      closed:*) out "$STATE/closed-issues.json" ;;
      *'in:title') out "$STATE/issues.json" ;;
      *) jq '[.[] | select(.state == "OPEN")]' "$STATE/issues.json" > "$STATE/il.json"; out "$STATE/il.json" ;;
    esac
    ;;
  'issue create')
    jq --arg t "$(opt --title "$@")" '. + [{number: 901, title: $t, author: {login: "app/github-actions"}, state: "OPEN"}]' \
      "$STATE/issues.json" > "$STATE/i" && mv "$STATE/i" "$STATE/issues.json"
    echo '[]' > "$STATE/comments-901.json"
    echo 'https://github.com/me/fs/issues/901'
    ;;
  'issue pin') : > "$STATE/pinned-$3" ;;
  'issue comment') cp "$(opt --body-file "$@")" "$STATE/posted-$3.md" ;;
  'pr list')
    if [ "$(opt --state "$@")" = closed ]; then out "$STATE/closed-prs.json"; else out "$STATE/prs.json"; fi
    ;;
  'release list') out "$STATE/releases.json" ;;
  *)
    [ "$1" = api ] || { echo "stub gh: unhandled: $*" >&2; exit 99; }
    path=$2; [ "$path" = --paginate ] && path=$3
    case $path in
      repos/me/fs/issues/comments\?*) out "$STATE/all-comments.json" ;;
      repos/me/fs/issues/*/comments\?*)
        n=${path#repos/me/fs/issues/}; n=${n%%/*}
        [ -f "$STATE/comments-$n.json" ] || echo '[]' > "$STATE/comments-$n.json"
        out "$STATE/comments-$n.json"
        ;;
      repos/me/fs/pulls/comments\?*) out "$STATE/review-comments.json" ;;
      repos/me/fs/actions/runs\?*)
        # ?status=<conclusion>&created=>=...: the runs that ended so.
        c=${path#*status=}; c=${c%%&*}
        jq --arg c "$c" '{workflow_runs: [.[] | select(.conclusion == $c)]}' "$STATE/runs.json" > "$STATE/r.json"; out "$STATE/r.json"
        ;;
      repos/me/fs/actions/workflows/*/runs\?*)
        # One workflow's newest run on a branch (?branch=<uri-encoded>&per_page=1).
        w=${path#repos/me/fs/actions/workflows/}; w=${w%%/*}
        b=''; case $path in *branch=*) b=${path#*branch=}; b=${b%%&*} ;; esac
        jq --argjson w "$w" --arg b "$b" '{workflow_runs: [.[] | select(.workflow_id == $w and ($b == "" or (.head_branch | @uri) == $b))] | sort_by(-.id)}' \
          "$STATE/runs.json" > "$STATE/w.json"; out "$STATE/w.json"
        ;;
      repos/me/fs/dependabot/alerts\?*) [ -f "$STATE/alerts_unreadable" ] && exit 1; out "$STATE/dependabot.json" ;;
      repos/me/fs/code-scanning/alerts\?*) out "$STATE/code-scanning.json" ;;
      *) echo "stub gh: unhandled api: $*" >&2; exit 99 ;;
    esac
    ;;
esac
GHSTUB
  chmod +x "$BIN/gh"
  printf '\n=== %s ===\n' "$scenario"
}
run_step() { rc=0; (cd "$T" && timeout 60 bash -e "$STEP") > "$T/out" 2>&1 || rc=$?; }
posted() { cat "$STATE/posted-900.md"; }
has() { grep -qF -- "$1" "$STATE/posted-900.md"; }

run() { # <workflow name> <branch> <conclusion> <id> [ended at] [workflow id] [status]: a run
  local file=${1,,}
  jq --arg n "$1" --arg b "$2" --arg c "$3" --argjson id "$4" --arg u "${5:-$HOUR_AGO}" \
    --argjson w "${6:-$(printf '%s' "$1" | cksum | cut -d' ' -f1)}" --arg s "${7:-completed}" --arg p ".github/workflows/${file// /-}.yml" \
    '. + [{id: $id, workflow_id: $w, name: $n, path: $p, head_branch: $b, event: "push", status: $s, conclusion: (if $s == "completed" then $c else null end),
      updated_at: $u, html_url: "https://github.com/me/fs/actions/runs/\($id)"}]' \
    "$STATE/runs.json" > "$STATE/x" && mv "$STATE/x" "$STATE/runs.json"
}
pr() { # <number> <title> <createdAt> [labels json]
  jq --argjson n "$1" --arg t "$2" --arg c "$3" --argjson l "${4:-[]}" \
    '. + [{number: $n, title: $t, url: "https://github.com/me/fs/pull/\($n)", createdAt: $c, labels: $l}]' \
    "$STATE/prs.json" > "$STATE/x" && mv "$STATE/x" "$STATE/prs.json"
}
verdict() { # <pr> <key> <created_at> [updated_at]: update-prs.yml's comment
  [ -f "$STATE/comments-$1.json" ] || echo '[]' > "$STATE/comments-$1.json"
  jq --arg k "$2" --arg c "$3" --arg u "${4:-$3}" '. + [{user: {login: "github-actions[bot]"}, created_at: $c, updated_at: $u, body: "text\n<!-- update-prs: \($k) -->"}]' \
    "$STATE/comments-$1.json" > "$STATE/x" && mv "$STATE/x" "$STATE/comments-$1.json"
}

quiet_day() {
  setup
  pr 42 'Bump eslint' "$OLD"
  verdict 42 ready "$OLD"
  run CI main success 1
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'no comment' test ! -f "$STATE/posted-900.md"
  check 'says so' grep -qF 'Nothing new since the last digest' "$T/out"
}

busy_day() {
  setup
  run CI main failure 10
  run CI main success 11
  run CI dependabot/npm_and_yarn/x failure 12
  run CI dependabot/npm_and_yarn/x failure 13
  run 'Daily digest' main failure 14
  pr 42 'Bump eslint' "$OLD"
  verdict 42 'red 0123456789ab' "$HOUR_AGO"
  pr 43 'Toolchain update: pnpm 12.18.0' "$HOUR_AGO"
  verdict 43 ready "$HOUR_AGO"
  pr 44 'Bump mediabunny' "$OLD" '[{"name": "hold"}]'
  verdict 44 "outage aaaaaaaaaaaa" "$OLD"
  pr 45 'ci: mpv' "$OLD"
  jq -n --arg t "$HOUR_AGO" --arg o "$OLD" '[{number: 40, title: "Bump x", url: "https://github.com/me/fs/pull/40", mergedAt: $t, closedAt: $t},
    {number: 39, title: "Bump y, closed before the window", url: "u", mergedAt: null, closedAt: $o}]' > "$STATE/closed-prs.json"
  jq -n --arg t "$HOUR_AGO" '[{number: 900, title: "Daily digest", url: "u", state: "OPEN", createdAt: $t},
    {number: 50, title: "Bug", url: "https://github.com/me/fs/issues/50", state: "OPEN", createdAt: $t}]' > "$STATE/created-issues.json"
  jq -n --arg t "$HOUR_AGO" '[{number: 48, title: "Migration: x", url: "https://github.com/me/fs/issues/48", closedAt: $t}]' > "$STATE/closed-issues.json"
  jq -n --arg t "$HOUR_AGO" '[{user: {login: "bob", type: "User"}, created_at: $t, pull_request_url: "https://api.github.com/repos/me/fs/pulls/43", html_url: "https://github.com/me/fs/pull/43#r1"}]' > "$STATE/review-comments.json"
  jq -n --arg t "$HOUR_AGO" '[{tagName: "v1.3.82.176", publishedAt: $t, isDraft: false}, {tagName: "v1.3.82.175", publishedAt: "2026-01-01T00:00:00Z", isDraft: false}]' > "$STATE/releases.json"
  jq -n --arg t "$HOUR_AGO" '[{user: {login: "alice", type: "User"}, created_at: $t, issue_url: "https://api.github.com/repos/me/fs/issues/50", html_url: "https://github.com/me/fs/issues/50#c1"},
    {user: {login: "nawid", type: "User"}, created_at: $t, issue_url: "x/51", html_url: "h"},
    {user: {login: "dependabot[bot]", type: "Bot"}, created_at: $t, issue_url: "x/52", html_url: "h"}]' > "$STATE/all-comments.json"
  jq -n --arg t "$HOUR_AGO" --arg o "$OLD" '[{created_at: $t}, {created_at: $o}]' > "$STATE/dependabot.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'one comment on the digest issue' test -f "$STATE/posted-900.md"
  check '@mentions the owner once' test "$(grep -o '@nawid' "$STATE/posted-900.md" | wc -l)" -eq 1
  check 'its marker: where the next one goes on from' grep -qE '^<!-- daily-digest: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z -->$' "$STATE/posted-900.md"
  check 'a review comment on a line' has 'bob on [#43](https://github.com/me/fs/pull/43#r1)'
  check 'not a PR closed before the window' bash -c '! grep -qF "Bump y" "$0"' "$STATE/posted-900.md"
  check 'main failed, passed since' has '| CI | `main` | 1 | [passed since](https://github.com/me/fs/actions/runs/11) |'
  check 'the branch failed twice, still failing' has '| CI | `dependabot/npm_and_yarn/x` | 2 | [failure](https://github.com/me/fs/actions/runs/13) |'
  check 'not its own runs' bash -c '! grep -qF "| Daily digest |" "$0"' "$STATE/posted-900.md"
  check 'red PR, verdict changed' has '[#42](https://github.com/me/fs/pull/42) Bump eslint: **CI fails** (verdict changed)'
  check 'new PR, ready' has '[#43](https://github.com/me/fs/pull/43) Toolchain update: pnpm 12.18.0: **ready to merge** (new)'
  check 'outage, with its label' has '[#44](https://github.com/me/fs/pull/44) Bump mediabunny: **outage: CI runs again later** [hold]'
  check 'no verdict yet' has '**no verdict yet**'
  check 'merged PR' has '[#40](https://github.com/me/fs/pull/40) Bump x: merged'
  check 'new issue, not the digest' bash -c 'grep -qF "[#50](https://github.com/me/fs/issues/50) Bug" "$0" && ! grep -qF "Daily digest" <(grep "^- " "$0")' "$STATE/posted-900.md"
  check 'closed issue' has '[#48](https://github.com/me/fs/issues/48) Migration: x'
  check 'the new release only' bash -c 'grep -qF "v1.3.82.176" "$0" && ! grep -qF "v1.3.82.175" "$0"' "$STATE/posted-900.md"
  check "alice's comment only" bash -c 'grep -qF "alice on [#50]" "$0" && ! grep -qE "(nawid|dependabot\[bot\]) on" "$0"' "$STATE/posted-900.md"
  check 'alerts: 2 open, 1 new' has '- Dependabot alerts: 2 open, 1 new'
  check 'no line for no code scanning alerts' bash -c '! grep -qF "Code scanning" "$0"' "$STATE/posted-900.md"
}

same_verdict_edited() {
  # update-prs.yml edited its old "ready" comment again (same verdict): nothing new.
  setup
  pr 42 'Bump eslint' "$OLD"
  verdict 42 ready "$OLD" "$HOUR_AGO"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'no comment' test ! -f "$STATE/posted-900.md"
}

runs_by_when_they_ended() {
  setup
  # Ended in the window, though started before it (it was running at the last digest).
  run CI main failure 10 "$HOUR_AGO"
  # Ended before the window: the last digest had it.
  run CI feature/x failure 11 "$OLD"
  # Renamed since: the same workflow (id 7), "CI" failed and "Build" passed after.
  run CI fix/y failure 12 "$HOUR_AGO" 7
  run Build fix/y success 13 "$HOUR_AGO" 7
  # Its newest run on the branch is still going.
  run Live dependabot/z failure 14 "$HOUR_AGO" 8
  run Live dependabot/z failure 15 "$HOUR_AGO" 8 in_progress
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'the run that ended in the window' has '| CI | `main` | 1 | [failure](https://github.com/me/fs/actions/runs/10) |'
  check 'not the one that ended before' bash -c '! grep -qF "feature/x" "$0"' "$STATE/posted-900.md"
  check 'a renamed workflow is one: passed since' has '| CI | `fix/y` | 1 | [passed since](https://github.com/me/fs/actions/runs/13) |'
  check 'its newest run still going' has '| Live | `dependabot/z` | 1 | [running](https://github.com/me/fs/actions/runs/15) |'
}

odd_runs_and_late_issue() {
  setup
  # A run with no branch, and a workflow whose name has a |.
  run Nightly '' failure 20
  jq '(.[] | select(.id == 20) | .head_branch) = null' "$STATE/runs.json" > "$STATE/x" && mv "$STATE/x" "$STATE/runs.json"
  run 'build | prod' main failure 21
  # Closed five minutes ago: the next digest's (GitHub's search may not have it yet).
  jq -n --arg t "$(date -u -d '-5 minutes' '+%Y-%m-%dT%H:%M:%SZ')" '[{number: 47, title: "Late", url: "u47", closedAt: $t}]' > "$STATE/closed-issues.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'no branch: a "-", its newest run anywhere' has '| Nightly | `-` | 1 | [failure](https://github.com/me/fs/actions/runs/20) |'
  check 'the | escaped' has '| build \| prod | `main` | 1 |'
  check 'not the issue closed five minutes ago' bash -c '! grep -qF "Late" "$0"' "$STATE/posted-900.md"
}

closed_digest_issue() {
  # The digest issue was closed by hand after a digest three days ago: a new one goes on
  # from there.
  setup
  three=$(date -u -d '-3 days' '+%Y-%m-%dT%H:%M:%SZ')
  echo '[{"number": 900, "title": "Daily digest", "author": {"login": "app/github-actions"}, "state": "CLOSED"}]' > "$STATE/issues.json"
  jq -n --arg t "$three" '[{user: {login: "github-actions[bot]"}, created_at: $t, body: "<!-- daily-digest: \($t) -->"}]' > "$STATE/comments-900.json"
  pr 42 'Bump eslint' "$OLD"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'a new issue' grep -q '^issue create --title Daily digest' "$STATE/gh.log"
  check 'the two-day-old PR is new: the window starts three days back' grep -qF '(new)' "$STATE/posted-901.md"
}

only_a_new_alert() {
  setup
  jq -n --arg t "$HOUR_AGO" '[{created_at: $t}]' > "$STATE/dependabot.json"
  run_step
  check 'a comment' test -f "$STATE/posted-900.md"
  check 'the alert' has '- Dependabot alerts: 1 open, 1 new'
}

alerts_unreadable() {
  setup
  : > "$STATE/alerts_unreadable"
  run CI main failure 10
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'says so' has '- Dependabot alerts: could not be read'
}

no_issue_yet() {
  setup
  echo '[]' > "$STATE/issues.json"
  run CI main failure 10
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'makes the issue' grep -q '^issue create --title Daily digest' "$STATE/gh.log"
  check 'pins it' test -f "$STATE/pinned-901"
  check 'comments on it' test -f "$STATE/posted-901.md"
}

window_from_last_digest() {
  # The last digest was three days ago (two were skipped): the window starts there.
  setup
  jq -n --arg t "$(date -u -d '-3 days' '+%Y-%m-%dT%H:%M:%SZ')" '[{user: {login: "github-actions[bot]"}, created_at: $t, body: "<!-- daily-digest: \($t) -->"}]' > "$STATE/comments-900.json"
  pr 42 'Bump eslint' "$OLD"
  run_step
  check 'the two-day-old PR is new' has '(new)'
}

FAILED_STEP=$(mktemp)
step_script daily-digest.yml 'Say the digest failed' > "$FAILED_STEP" || exit 1
run_failed_step() { rc=0; (cd "$T" && timeout 60 bash -e "$FAILED_STEP") > "$T/out" 2>&1 || rc=$?; }
digest_failed() {
  setup
  run_failed_step
  check 'exit 0' test "$rc" -eq 0
  check 'comments on the digest issue, @mentioning the owner' grep -qF '@nawid The daily digest failed: https://github.com/me/fs/actions/runs/9000.' "$STATE/posted-900.md"
}
digest_failed_no_issue() {
  setup
  echo '[]' > "$STATE/issues.json"
  run_failed_step
  check 'exit 0' test "$rc" -eq 0
  check 'opens "Daily digest failed"' grep -q '^issue create --title Daily digest failed' "$STATE/gh.log"
}

quiet_day
busy_day
only_a_new_alert
alerts_unreadable
no_issue_yet
window_from_last_digest
same_verdict_edited
runs_by_when_they_ended
closed_digest_issue
odd_runs_and_late_issue
digest_failed
digest_failed_no_issue
rm -f "$FAILED_STEP"

printf '%d checks, %d failed\n' "$checks" "$fails"
[ "$fails" -eq 0 ]
