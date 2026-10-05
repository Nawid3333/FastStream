#!/usr/bin/env bash
# sync-upstream.yml: the merge of upstream into the sync branch, the pull request it opens or
# updates (and CI and the dependency review it starts on the branch), and the failure issue.
# Real git: upstream's repository, this project's bare origin and the job's checkout of main;
# gh is a stub that answers from fixture files (pull requests, issues), applies --jq as gh
# does (a string raw, null as an empty line) and logs what the steps create, edit, close and
# start.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
identity_step=$here/identity.sh
fetch_step=$here/fetch.sh
merge_step=$here/merge.sh
pr_step=$here/pr.sh
close_step=$here/close.sh
notify_step=$here/notify.sh
step_script sync-upstream.yml 'Configure git identity' > "$identity_step" || exit 1
step_script sync-upstream.yml 'Fetch upstream' > "$fetch_step" || exit 1
step_script sync-upstream.yml 'Merge upstream into the sync branch' > "$merge_step" || exit 1
step_script sync-upstream.yml 'Open or update the pull request' > "$pr_step" || exit 1
step_script sync-upstream.yml 'Close the failure issue' > "$close_step" || exit 1
step_script sync-upstream.yml 'Notify on failure' > "$notify_step" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIX/gh.log"
args=("$@")
opt() { local i; for ((i = 0; i < ${#args[@]} - 1; i++)); do if [ "${args[i]}" = "$1" ]; then printf '%s\n' "${args[i + 1]}"; return 0; fi; done; return 1; }
out() { local f; if f=$(opt --jq); then jq -r "($f) | if . == null then \"\" else . end" "$1"; else cat "$1"; fi; }
logged() {
  { printf '%s' "$1"; shift; printf ' [%s]' "$@"; printf '\n'
    if f=$(opt --body-file); then echo '--- body:'; cat "$f"; echo '--- end body'; fi; } >> "$LOG"
}
case "$1 $2" in
  'pr list')
    jq --arg h "$(opt --head)" --arg s "$(opt --state)" '[.[] | select(.headRefName == $h and .state == $s)]' \
      "$FIX/prs.json" > "$FIX/list.json"
    out "$FIX/list.json" ;;
  'pr view')
    if [ -f "$FIX/pr_view_fails" ]; then echo 'stub gh: HTTP 502' >&2; exit 1; fi
    jq --argjson n "$3" '.[] | select(.number == $n)' "$FIX/prs.json" > "$FIX/view.json"
    out "$FIX/view.json" ;;
  'pr create') logged PR_CREATE "${@:3}"; echo "https://github.com/$GH_REPO/pull/7" ;;
  'pr edit') logged PR_EDIT "${@:3}" ;;
  'pr comment') logged PR_COMMENT "${@:3}" ;;
  'pr close') logged PR_CLOSE "${@:3}" ;;
  'issue create') logged ISSUE_CREATE "${@:3}" ;;
  'issue comment') logged ISSUE_COMMENT "${@:3}" ;;
  'issue close') logged ISSUE_CLOSE "${@:3}" ;;
  'workflow run') logged DISPATCH "${@:3}" ;;
  'issue list')
    # The search index lags behind a new issue: search.json, not issues.json.
    if opt --search > /dev/null; then out "$FIX/search.json"; else out "$FIX/issues.json"; fi ;;
  'api repos/Andrews54757/FastStream/releases/tags/'*)
    echo 'stub gh: HTTP 404' >&2; exit 1 ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

export GH_TOKEN=stub GH_REPO='Nawid3333/FastStream'

# fixtures: a new scenario. Upstream's repository with its first commit; this project's
# origin, a copy of it plus a commit of its own that changes its CI workflow; and the job's
# checkout of origin's main, with the identity the workflow gives it.
fixtures() {
  export FIX="$here/fix" LOG="$here/fix/log" RUNNER_TEMP="$here/fix/tmp"
  export GITHUB_OUTPUT="$here/fix/output" GITHUB_STEP_SUMMARY="$here/fix/summary"
  export UPSTREAM="$here/fix/upstream" WORK_BRANCH=main SYNC_BRANCH=sync/upstream GITHUB_EVENT_NAME=schedule
  export OWNER=Nawid3333 TITLE='Upstream sync workflow failed' RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"; : > "$FIX/gh.log"; : > "$GITHUB_OUTPUT"; : > "$GITHUB_STEP_SUMMARY"
  echo '[]' > "$FIX/prs.json"; echo '[]' > "$FIX/issues.json"; echo '[]' > "$FIX/search.json"
  git init -q -b main "$UPSTREAM"
  up_commit chrome/a.txt a 'Initial'
  up_commit .github/workflows/ci.yml 'name: upstream CI' 'Add CI'
  git clone -q --bare "$UPSTREAM" "$FIX/origin.git"
  git clone -q "$FIX/origin.git" "$FIX/work"
  (cd "$FIX/work" && bash -e "$identity_step")
  printf 'name: CI\n' > "$FIX/work/.github/workflows/ci.yml"
  git -C "$FIX/work" commit -q -am 'Our own CI'
  git -C "$FIX/work" push -q origin main
}
# up_commit <path> <content> <message>: a commit of upstream's.
up_commit() {
  mkdir -p "$(dirname "$UPSTREAM/$1")"
  printf '%s\n' "$2" > "$UPSTREAM/$1"
  git -C "$UPSTREAM" add "$1"
  git -C "$UPSTREAM" -c user.name=Andrew -c user.email=a@example.com commit -q -m "$3"
}
short() { git -C "$1" rev-parse --short=10 "$2"; }
# pr_json <number> <state> <body>: the pull requests on the sync branch.
prs() { printf '%s' "$1" > "$FIX/prs.json"; }
marker() { printf '<!-- sync-upstream base=%s upstream=%s -->' "$1" "$2"; }

run() { # <step file>: runs it in the checkout
  (
    cd "$FIX/work" || exit 9
    PATH="$here/bin:$PATH" run_step "$1"
  ) > "$FIX/out" 2>&1
  status=$?
}
output() { sed -n "s/^$1=//p" "$GITHUB_OUTPUT" | tail -n 1; }
# sync <description>: the job's steps in order, as GitHub runs them: Fetch, Merge, and with
# the merge's outputs, Open or update.
sync() {
  echo "$1"
  run "$fetch_step"
  if [ "$status" != 0 ]; then return; fi
  run "$merge_step"
  if [ "$status" != 0 ] || [ "$(output action)" != update ]; then return; fi
  BEHIND=$(output behind) BASE_SHA=$(output base_sha) UP_SHA=$(output up_sha) \
    CONFLICTS=$(output conflicts) RELEASES=$(output releases) HEAD_SHA=$(output head)
  export BEHIND BASE_SHA UP_SHA CONFLICTS RELEASES HEAD_SHA
  run "$pr_step"
}
pushed() { git -C "$FIX/origin.git" rev-parse -q --verify "refs/heads/$SYNC_BRANCH" > /dev/null; }
dispatched() { grep -c '^DISPATCH' "$LOG"; }

fixtures
up_commit chrome/b.txt b 'Bug fixes'
sync 's1 a new upstream commit -> the merge pushed, a PR assigned to the owner, CI and the review started'
check 'succeeds' test "$status" -eq 0
check 'pushes the sync branch with the merge' bash -c 'git -C "$0" show sync/upstream:chrome/b.txt | grep -qx b' "$FIX/origin.git"
check 'opens the PR, assigned' grep -qF 'PR_CREATE [--base] [main] [--head] [sync/upstream] [--title] [Sync upstream (1 commits)] [--body-file]' "$LOG"
check '@mentions the owner' contains "$LOG" '@Nawid3333 Clean merge of upstream/main into main.'
check 'lists the commit' contains "$LOG" "- $(git -C "$UPSTREAM" rev-parse --short HEAD) Bug fixes"
check 'carries the marker' contains "$LOG" "$(marker "$(short "$FIX/work" main)" "$(short "$UPSTREAM" HEAD)")"
check 'records the head it pushed' contains "$LOG" "<!-- sync-upstream-head=$(git -C "$FIX/origin.git" rev-parse sync/upstream) -->"
check 'starts CI on the branch' contains "$LOG" 'DISPATCH [ci.yml] [--ref] [sync/upstream]'
check 'starts the dependency review on the branch' contains "$LOG" 'DISPATCH [dependency-review.yml] [--ref] [sync/upstream]'

fixtures
for i in $(seq 45); do up_commit "chrome/f$i.txt" "$i" "Change $i"; done
sync 's2 45 upstream commits -> the PR lists the newest 40'
check 'succeeds' test "$status" -eq 0
check 'says 45 commits' contains "$LOG" '[Sync upstream (45 commits)]'
check 'lists 40' test "$(grep -c '^- [0-9a-f]* Change ' "$LOG")" -eq 40
check 'the newest first' contains "$LOG" "- $(git -C "$UPSTREAM" rev-parse --short HEAD) Change 45"

fixtures
up_commit chrome/b.txt b 'Bug fixes'
old_up=$(short "$UPSTREAM" HEAD~1)
prs "[{\"number\":5,\"state\":\"open\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"x\n\n$(marker 1111111111 "$old_up")\n\"}]"
sync 's3 upstream moved past the open PR -> the PR rebuilt, a comment says upstream moved'
check 'succeeds' test "$status" -eq 0
check 'edits #5, assigned' grep -qF 'PR_EDIT [5] [--title] [Sync upstream (1 commits)] [--body-file]' "$LOG"
check 'comments that upstream moved' contains "$LOG" "PR_COMMENT [5] [--body] [@Nawid3333 upstream moved (now $(short "$UPSTREAM" HEAD)): this PR carries 1 commits.]"
check 'opens no second PR' lacks "$LOG" 'PR_CREATE'

fixtures
up_commit chrome/b.txt b 'Bug fixes'
prs "[{\"number\":5,\"state\":\"open\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"x\r\n\r\n$(marker 1111111111 "$(short "$UPSTREAM" HEAD)")\r\n\"}]"
sync 's4 main moved, upstream did not (a body edited in the browser, CRLF) -> the PR rebuilt, no comment'
check 'succeeds' test "$status" -eq 0
check 'edits #5' grep -qF 'PR_EDIT [5]' "$LOG"
check 'no comment: upstream did not move' lacks "$LOG" 'PR_COMMENT'

fixtures
up_commit chrome/b.txt b 'Bug fixes'
# The branch as someone left it - their conflict resolution - not the head this workflow
# recorded when it pushed.
git -C "$FIX/work" push -q origin main:refs/heads/sync/upstream
theirs=$(git -C "$FIX/origin.git" rev-parse sync/upstream)
prs "[{\"number\":5,\"state\":\"open\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"x\n\n$(marker 1111111111 "$(short "$UPSTREAM" HEAD)")\n<!-- sync-upstream-head=0123456789abcdef0123456789abcdef01234567 -->\n\"}]"
sync 's4b main moved, and someone pushed to the branch -> not rebuilt over their commits'
check 'succeeds' test "$status" -eq 0
check 'leaves their commits' test "$(git -C "$FIX/origin.git" rev-parse sync/upstream)" = "$theirs"
check 'edits nothing' lacks "$LOG" 'PR_EDIT'
check 'says why' grep -qF 'not rebuilt over them' "$GITHUB_STEP_SUMMARY"

fixtures
up_commit chrome/b.txt b 'Bug fixes'
git -C "$FIX/work" push -q origin main:refs/heads/sync/upstream
ours=$(git -C "$FIX/origin.git" rev-parse sync/upstream)
prs "[{\"number\":5,\"state\":\"open\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"x\n\n$(marker 1111111111 "$(short "$UPSTREAM" HEAD)")\n<!-- sync-upstream-head=$ours -->\n\"}]"
sync 's4c main moved, the branch as this workflow pushed it -> rebuilt, as before'
check 'succeeds' test "$status" -eq 0
check 'edits #5' grep -qF 'PR_EDIT [5]' "$LOG"
check 'pushes the merge' bash -c 'git -C "$0" show sync/upstream:chrome/b.txt | grep -qx b' "$FIX/origin.git"

fixtures
up_commit chrome/b.txt b 'Bug fixes'
prs "[{\"number\":5,\"state\":\"open\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"x\n\n$(marker 1111111111 "$(short "$UPSTREAM" HEAD~1)")\n\"}]"
: > "$FIX/pr_view_fails"
sync "s5 the open PR's body cannot be read -> fails, says nothing about upstream moving"
check 'fails (the failure step reports it)' test "$status" -eq 1
check 'no "upstream moved" comment' lacks "$LOG" 'PR_COMMENT'

fixtures
up_commit chrome/b.txt b 'Bug fixes'
prs "[{\"number\":5,\"state\":\"open\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"x\n\n$(marker "$(short "$FIX/work" main)" "$(short "$UPSTREAM" HEAD)")\n\"}]"
sync 's6 the open PR is current -> nothing pushed, edited or started'
check 'succeeds' test "$status" -eq 0
check 'says so' contains "$GITHUB_STEP_SUMMARY" 'The open sync PR is already current.'
check 'pushes nothing' bash -c '! git -C "$0" rev-parse -q --verify refs/heads/sync/upstream' "$FIX/origin.git"
check 'starts nothing' test "$(dispatched)" -eq 0

fixtures
up_commit chrome/b.txt b 'Bug fixes'
prs "[{\"number\":4,\"state\":\"closed\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"$(marker 1111111111 "$(short "$UPSTREAM" HEAD)")\"}]"
sync 's7 the PR for this upstream commit was closed unmerged -> skipped'
check 'succeeds' test "$status" -eq 0
check 'pushes nothing' bash -c '! git -C "$0" rev-parse -q --verify refs/heads/sync/upstream' "$FIX/origin.git"
check 'opens nothing' lacks "$LOG" 'PR_CREATE'

fixtures
prs '[{"number":5,"state":"open","headRefName":"sync/upstream","isCrossRepository":false,"mergedAt":null,"body":"x"}]'
sync 's8 main holds every upstream commit -> the open PR closed'
check 'succeeds' test "$status" -eq 0
check 'closes #5' grep -qF 'PR_CLOSE [5] [--comment] [Closing: main' "$LOG"

fixtures
up_commit chrome/b.txt b 'Bug fixes'
export GITHUB_EVENT_NAME=push
sync 's9 a push to main with upstream commits to take -> nothing rebuilt'
check 'succeeds' test "$status" -eq 0
check 'pushes nothing' bash -c '! git -C "$0" rev-parse -q --verify refs/heads/sync/upstream' "$FIX/origin.git"
check 'starts nothing' test "$(dispatched)" -eq 0

# gh pr list --head lists a fork's pull request from a branch named sync/upstream too (#169).
fork_prs() { # <this repository's PRs, comma-separated JSON>: they, and a fork's open and closed one
  printf '[%s{"number":9,"state":"open","headRefName":"sync/upstream","isCrossRepository":true,"mergedAt":null,"body":"x %s"},{"number":8,"state":"closed","headRefName":"sync/upstream","isCrossRepository":true,"mergedAt":null,"body":"%s"}]' \
    "${1:+$1,}" "$(marker "$(short "$FIX/work" main)" "$(short "$UPSTREAM" HEAD)")" "$(marker 1111111111 "$(short "$UPSTREAM" HEAD)")" > "$FIX/prs.json"
}
fixtures
up_commit chrome/b.txt b 'Bug fixes'
fork_prs ''
sync "s16 a fork's PRs from a branch named sync/upstream (one with this sync's marker, one closed) -> this repository's own PR"
check 'succeeds' test "$status" -eq 0
check 'pushes the sync branch' pushed
check 'opens its own PR' grep -qF 'PR_CREATE [--base] [main] [--head] [sync/upstream]' "$LOG"
check "edits or comments on no fork's PR" bash -c '! grep -qE "^PR_(EDIT|COMMENT|CLOSE) \[(8|9)\]" "$0"' "$LOG"
check 'starts CI' contains "$LOG" 'DISPATCH [ci.yml] [--ref] [sync/upstream]'

fixtures
fork_prs '{"number":5,"state":"open","headRefName":"sync/upstream","isCrossRepository":false,"mergedAt":null,"body":"x"}'
sync "s17 main holds every upstream commit, a fork's PR open too -> closes only this repository's"
check 'succeeds' test "$status" -eq 0
check 'closes #5' grep -qF 'PR_CLOSE [5]' "$LOG"
check "leaves the fork's #9 alone" lacks "$LOG" 'PR_CLOSE [9]'

# Upstream's changes under .github/ would run with this repository's token and secrets in a
# CI run on the branch (#163): a person reads them first, and nothing is started.
fixtures
up_commit chrome/b.txt b 'Bug fixes'
up_commit .github/ISSUE_TEMPLATE/bug.md 'a template' 'Update bug template'
sync 's13 upstream changes .github/ (a clean merge) -> the PR, saying why CI was not started; nothing started'
check 'succeeds' test "$status" -eq 0
check 'opens the PR' grep -qF 'PR_CREATE [--base] [main] [--head] [sync/upstream] [--title] [Sync upstream (2 commits)]' "$LOG"
check 'says CI and the review were not started' contains "$LOG" '**CI and the dependency review were not started.** Upstream changes .github/ISSUE_TEMPLATE/bug.md, under `.github/`'
check 'starts nothing' test "$(dispatched)" -eq 0
check 'the summary says so' contains "$GITHUB_STEP_SUMMARY" 'Upstream changes .github/ISSUE_TEMPLATE/bug.md: CI and the dependency review were not started'

fixtures
up_commit .github/workflows/ci.yml 'name: upstream CI, changed' 'Fix CI'
sync "s14 upstream changes a workflow this project rewrote (a conflict) -> the PR with the markers; nothing started"
check 'succeeds' test "$status" -eq 0
check 'opens the conflict PR' grep -qF '[Sync upstream (1 commits) - CONFLICTS]' "$LOG"
check 'names the workflow' contains "$LOG" 'Upstream changes .github/workflows/ci.yml, under `.github/`'
check 'starts nothing' test "$(dispatched)" -eq 0

fixtures
up_commit chrome/b.txt b 'Bug fixes'
prs "[{\"number\":5,\"state\":\"open\",\"headRefName\":\"sync/upstream\",\"isCrossRepository\":false,\"mergedAt\":null,\"body\":\"x\n\n$(marker 1111111111 "$(short "$UPSTREAM" HEAD)")\n\"}]"
up_commit .github/workflows/release.yml 'name: upstream release' 'Release workflow'
sync 's15 upstream moved past the open PR with a .github/ change -> the comment says CI was not started; nothing started'
check 'succeeds' test "$status" -eq 0
check 'the comment says so' contains "$LOG" 'this PR carries 2 commits. It changes files under .github/, so CI was not started: see the description.]'
check 'starts nothing' test "$(dispatched)" -eq 0

fixtures
printf '[{"number":12,"title":"%s"},{"number":3,"title":"Other"}]' "$TITLE" > "$FIX/issues.json"
echo "s10 a failure while the failure issue is open (newer than the search index) -> a comment on it"
run "$notify_step"
check 'succeeds' test "$status" -eq 0
check 'comments on #12' contains "$LOG" "ISSUE_COMMENT [12] [--body] [Failed again: $RUN_URL]"
check 'opens no second issue' lacks "$LOG" 'ISSUE_CREATE'

fixtures
printf '[{"number":3,"title":"Other"},{"number":4,"title":"%s, again"}]' "$TITLE" > "$FIX/issues.json"
echo 's11 a failure with no failure issue open -> one, assigned to the owner'
run "$notify_step"
check 'succeeds' test "$status" -eq 0
check 'opens it, assigned' contains "$LOG" "ISSUE_CREATE [--title] [$TITLE] [--body] [The sync-upstream workflow failed. Run: $RUN_URL] [--assignee] [Nawid3333]"

fixtures
printf '[{"number":12,"title":"%s"},{"number":4,"title":"%s, again"}]' "$TITLE" "$TITLE" > "$FIX/issues.json"
echo 's12 a clean run -> closes the failure issue, by its exact title'
run "$close_step"
check 'succeeds' test "$status" -eq 0
check 'closes #12' contains "$LOG" "ISSUE_CLOSE [12] [--comment] [The sync ran cleanly again: $RUN_URL]"
check 'leaves another title alone' lacks "$LOG" 'ISSUE_CLOSE [4]'

finish
