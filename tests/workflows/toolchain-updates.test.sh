#!/usr/bin/env bash
# toolchain-updates.yml's step that opens, rebuilds and closes the toolchain update pull
# requests. Real git (a local bare origin), jq and node; gh and sleep stubbed, and node's
# `tools/check-toolchain.mjs` calls answered from a canned plan (they go to the network).
# Every gh call is logged to $STATE/gh.log. This test keeps its own check and run_step.
source "$(dirname "$0")/lib.sh"
STEP=$(mktemp)
step_script toolchain-updates.yml 'Open, and close, the toolchain update pull requests' > "$STEP" || exit 1
checks=0
fails=0
TDIRS=()
REAL_NODE=$(command -v node)
REPO=$(cd "$(dirname "$0")/../.." && pwd)
cleanup() { rm -rf "$STEP" "${TDIRS[@]}"; }
trap cleanup EXIT

check() {
  local desc=$1
  shift
  checks=$((checks + 1))
  if "$@"; then
    printf 'PASS %s: %s\n' "$scenario" "$desc"
  else
    printf 'FAIL %s: %s\n' "$scenario" "$desc"
    tail -n 20 "$T/out"
    tail -n 20 "$STATE/gh.log"
    fails=$((fails + 1))
  fi
}
has_call() { grep -qF -- "$1" "$STATE/gh.log"; }
n_calls() { grep -c -- "$1" "$STATE/gh.log" || true; }
origin() { git -C "$T/origin.git" "$@"; }

write_stubs() {
  cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STATE/gh.log"
ORIG=("$@")
opt() { local flag=$1 prev= a; shift; for a in "$@"; do if [ "$prev" = "$flag" ]; then printf '%s\n' "$a"; return 0; fi; prev=$a; done; return 1; }
jqout() { local e; if e=$(opt --jq "${ORIG[@]}"); then jq -r "$e" "$1"; else cat "$1"; fi; }
case "$1 $2" in
  'pr list'|'issue list')
    # Only open ones: the fixtures hold no others.
    [[ " $* " == *' --state open --limit 200 '* ]] || { echo "stub gh: not a list of all open ones: $*" >&2; exit 99; }
    jqout "$STATE/${1}s.json"
    ;;
  'label create') [ -f "$STATE/label_exists" ] && { echo 'label already exists' >&2; exit 1; }; exit 0 ;;
  'pr create')
    opt --title "$@" > "$STATE/created.title"
    cp "$(opt --body-file "$@")" "$STATE/created.body"
    echo 'https://github.com/me/fs/pull/100'
    ;;
  'workflow run')
    n=$(cat "$STATE/dispatch_fails" 2> /dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$STATE/dispatch_fails"; echo 'HTTP 500' >&2; exit 1; fi
    ;;
  'pr view')
    n=$3
    case $(opt --json "$@") in
      state) [ -f "$STATE/pr-$n-state" ] || { echo "no pull request $n" >&2; exit 1; }; cat "$STATE/pr-$n-state" ;;
      mergeable) cat "$STATE/pr-$n-mergeable" 2> /dev/null || echo MERGEABLE ;;
      commits)
        [ -f "$STATE/pr-$n-commits.json" ] || echo '{"commits":[{"authors":[{"login":"github-actions[bot]"}]}]}' > "$STATE/pr-$n-commits.json"
        jqout "$STATE/pr-$n-commits.json"
        ;;
      body)
        [ -f "$STATE/pr-$n-body" ] || { echo "no pull request $n" >&2; exit 1; }
        cat "$STATE/pr-$n-body"
        ;;
      *) echo "stub gh: unhandled: $*" >&2; exit 99 ;;
    esac
    ;;
  'issue view') cat "$STATE/issue-$3-state" ;;
  'pr close'|'issue close') if [ -f "$STATE/close-$3-fails" ]; then echo 'already merged' >&2; exit 1; fi ;;
  'pr edit') cp "$(opt --body-file "$@")" "$STATE/pr-$3-edited" ;;
  'issue create')
    opt --title "$@" > "$STATE/issue-created.title"
    cp "$(opt --body-file "$@")" "$STATE/issue-created.body"
    echo 'https://github.com/me/fs/issues/50'
    ;;
  'issue edit') cp "$(opt --body-file "$@")" "$STATE/issue-$3-edited" ;;
  'issue reopen') : ;;
  'run list')
    # The live suite's runs apart from CI's: one commit can have a CI run and no live one.
    case $(opt --workflow "$@") in
      live-streams.yml) f="$STATE/live-runs-$(opt --commit "$@")" ;;
      *) f="$STATE/runs-$(opt --commit "$@")" ;;
    esac
    [ -s "$f" ] || echo '[]' > "$f"
    jqout "$f"
    ;;
  'api --paginate')
    case "$3" in
      # The rolling branch's closed pull requests.
      *'/pulls?state=closed&head='*) f="$STATE/closed-prs.json"; [ -s "$f" ] || echo '[]' > "$f"; jqout "$f" ;;
      # The issues this workflow's token opened: GitHub filters by creator, as here.
      *'/issues?state=all&creator=github-actions%5Bbot%5D&'*)
        jq '[.[] | select(.user.login == "github-actions[bot]")]' "$STATE/issues.rest.json" > "$STATE/issues.mine.json"
        jqout "$STATE/issues.mine.json" ;;
      *) jqout "$STATE/all.json" ;;
    esac
    ;;
  *) echo "stub gh: unhandled: $*" >&2; exit 99 ;;
esac
EOF
  cat > "$BIN/node" <<EOF
#!/usr/bin/env bash
if [ "\${1-}" = tools/check-toolchain.mjs ]; then
  printf 'node %s\n' "\$*" >> "\$STATE/gh.log"
  # The recipes' own calls read and write files only: the work tree's copy runs for real.
  case "\${2-}" in --apply-addon|--addon-version|--apply-players) exec "$REAL_NODE" "\$@" ;; esac
  if [ "\${2-}" = --plan ]; then cp "\$3" "\$STATE/open.seen"; cp "\$4" "\$STATE/titles.seen"; cat "\$STATE/plan.json"; else echo 'UPDATE  (canned)'; fi
  exit 0
fi
exec "$REAL_NODE" "\$@"
EOF
  printf '#!/usr/bin/env bash\necho "$*" >> "$STATE/sleeps"\n' > "$BIN/sleep"
  # The add-on's download: the bytes in $STATE/addon.xpi, the URL logged.
  cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
out=''
prev=''
for a in "$@"; do
  if [ "$prev" = -o ]; then out=$a; fi
  prev=$a
done
printf 'curl %s\n' "${!#}" >> "$STATE/gh.log"
[ -f "$STATE/addon.xpi" ] || { echo 'curl: (22) 404' >&2; exit 22; }
cp "$STATE/addon.xpi" "$out"
EOF
  chmod +x "$BIN/gh" "$BIN/node" "$BIN/sleep" "$BIN/curl"
}

setup() {
  scenario=${FUNCNAME[1]}
  T=$(mktemp -d)
  TDIRS+=("$T")
  STATE=$T/state
  BIN=$T/bin
  mkdir -p "$STATE" "$BIN" "$T/tmp"
  export STATE PATH="$BIN:$PATH" RUNNER_TEMP="$T/tmp"
  export GH_TOKEN=x OWNER=nawid EVENT=schedule PREFIX='Toolchain update: ' GITHUB_REPOSITORY=me/fs
  export RUN_URL='https://github.com/me/fs/actions/runs/9'
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
  write_stubs
  : > "$STATE/gh.log"
  git init -q --bare -b main "$T/origin.git"
  git init -q -b main "$T/work"
  (
    cd "$T/work" || exit 1
    printf '{\n  "name": "fs",\n  "devDependencies": {\n    "x": "1.0.0"\n  },\n  "packageManager": "pnpm@11.22.0"\n}\n' > package.json
    echo 22 > .nvmrc
    # The recipes' own scripts, as main has them.
    mkdir -p tools tests/e2e/live-specs
    cp "$REPO/tools/check-toolchain.mjs" "$REPO/tools/check-patched-updates.mjs" "$REPO/tools/setup-dev-profile.mjs" tools/
    # The player libraries, as main has them: two, at old releases.
    printf '{\n  "plyr": "3.8.5",\n  "dplayer": "1.27.1"\n}\n' > tests/e2e/live-specs/player-libraries.json
    git add -A && git commit -q -m init && git remote add origin "$T/origin.git" && git push -q origin main
  )
  echo '[]' > "$STATE/prs.json"
  echo '[]' > "$STATE/issues.json"
  echo '[]' > "$STATE/issues.rest.json"
  echo '[]' > "$STATE/closed-prs.json"
  echo '[{"title": "Toolchain update: Node.js 24", "user": {"login": "github-actions[bot]"}}, {"title": "chore: release", "user": {"login": "Nawid3333"}}, {"title": "Toolchain update: Node.js 30", "user": {"login": "stranger"}}]' > "$STATE/all.json"
  plan '[]' '[]'
  printf '\n=== %s ===\n' "$scenario"
}
plan() { jq -n --argjson r "$1" --argjson c "$2" '{raise: $r, close: $c}' > "$STATE/plan.json"; }
pnpm_update() { # <latest> [routine]
  jq -cn --arg l "$1" --argjson a "${2:-true}" '{name: "pnpm", current: "11.22.0", latest: $l, behind: true, routine: $a, note: "n", title: "Toolchain update: pnpm \($l)"}'
}
run_step() {
  rc=0
  (cd "$T/work" && env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL timeout 60 bash -e "$STEP") > "$T/out" 2>&1 || rc=$?
}
branch_diff() { origin diff --name-only "main...$1"; }
ublock_update() { # <latest> <sha256>
  jq -cn --arg l "$1" --arg s "$2" '{name: "uBlock Origin", current: "1.75.0", latest: $l, behind: true, routine: true, note: "n",
    title: "Toolchain update: uBlock Origin \($l)", file: {url: "https://addons.mozilla.org/firefox/downloads/file/5100000/ublock_origin-\($l).xpi", sha256: $s}}'
}

# --- Scenarios.

players_new_set() {
  # A new set: the rolling pull request is raised off main, holding only the player libraries.
  setup
  players_plan "$A" "$CHANGES"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'branch pushed' origin show-ref -q --verify refs/heads/toolchain/player-libraries
  check 'only the player libraries' test "$(branch_diff toolchain/player-libraries)" = "$PFILE"
  check 'at the set' test "$(origin show "toolchain/player-libraries:$PFILE")" = "$(printf '{\n  "plyr": "3.8.6",\n  "dplayer": "1.27.2"\n}')"
  check 'off main' test "$(origin rev-parse toolchain/player-libraries~1)" = "$(origin rev-parse main)"
  check 'commit message' test "$(origin log -1 --format=%s toolchain/player-libraries)" = 'build: player libraries (plyr 3.8.6, dplayer 1.27.2)'
  check 'as github-actions[bot]' test "$(origin log -1 --format=%an toolchain/player-libraries)" = 'github-actions[bot]'
  check 'pull request' has_call 'pr create --base main --head toolchain/player-libraries --title Toolchain update: player libraries --label dependencies'
  check 'its marker' grep -qF "<!-- player-libraries: $A -->" "$STATE/created.body"
  check 'the change table' grep -qF '| [plyr](https://www.npmjs.com/package/plyr?activeTab=versions) | 3.8.5 | 3.8.6 |' "$STATE/created.body"
  check 'names the live suite' grep -qF '`live-streams.yml`' "$STATE/created.body"
  check 'says it releases nothing' grep -qF 'a merge then releases nothing' "$STATE/created.body"
  check 'CI started once' test "$(n_calls '^workflow run ci.yml --ref toolchain/player-libraries$')" = 1
  check 'live suite started once' test "$(n_calls '^workflow run live-streams.yml --ref toolchain/player-libraries$')" = 1
  check 'started before the pull request' test "$(grep -n '^workflow run live-streams.yml' "$STATE/gh.log" | cut -d: -f1)" -lt "$(grep -n '^pr create' "$STATE/gh.log" | cut -d: -f1)"
  check 'main untouched' test "$(origin rev-list --count main)" = 1
}

players_held_and_unresolved() {
  # The text names a library held back by a range, and a range that does not hold on main.
  setup
  players_plan "$A" "[$(player dplayer 1.27.1 1.27.2)]" '[]' '[{"name": "plyr", "version": "3.8.5", "newest": "3.8.6"}]'
  jq '.players.unresolved = [{name: "dplayer", version: "1.27.2", needs: "plyr", range: "^3.9.0"}]' "$STATE/plan.json" > "$STATE/p" && mv "$STATE/p" "$STATE/plan.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'the held one' grep -qF -- '- plyr: 3.8.6 is out, and it stays at 3.8.5 until the ranges allow it' "$STATE/created.body"
  check 'the range that does not hold' grep -qF -- '- dplayer 1.27.2 asks for plyr `^3.9.0`' "$STATE/created.body"
  check 'nothing reads null' bash -c '! grep -qw null "$0"' "$STATE/created.body"
}

players_same_set_live_never_ran() {
  # Only a pull_request run waiting for an approval (action_required): it never ran.
  setup
  players_open "$A"
  echo '[{"status": "completed", "conclusion": "success"}]' > "$STATE/runs-$head"
  echo '[{"status": "completed", "conclusion": "action_required"}]' > "$STATE/live-runs-$head"
  players_plan "$A" "$CHANGES"
  run_step
  check 'the live suite started once' test "$(n_calls '^workflow run live-streams.yml --ref toolchain/player-libraries$')" = 1
}

players_same_set_timed_out() {
  # A live run that timed out decides nothing: the weekly run starts one.
  setup
  players_open "$A"
  echo '[{"status": "completed", "conclusion": "success"}]' > "$STATE/runs-$head"
  echo '[{"status": "completed", "conclusion": "timed_out"}]' > "$STATE/live-runs-$head"
  players_plan "$A" "$CHANGES"
  run_step
  check 'the live suite started once' test "$(n_calls '^workflow run live-streams.yml --ref toolchain/player-libraries$')" = 1
}

players_same_set_both_ran() {
  # The same set, open and mergeable, with a run of each on its head: nothing done.
  setup
  players_open "$A"
  echo '[{"status": "completed", "conclusion": "success"}]' > "$STATE/runs-$head"
  echo '[{"status": "in_progress", "conclusion": null}]' > "$STATE/live-runs-$head"
  players_plan "$A" "$CHANGES"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not rebuilt' test "$(origin rev-parse toolchain/player-libraries)" = "$head"
  check 'nothing started or edited' bash -c '! grep -qE "^(workflow run|pr edit|pr create)" "$0"' "$STATE/gh.log"
}

players_same_set_starts_live() {
  # CI decided on its head, the live suite never ran there (or only a cancelled run did).
  setup
  players_open "$A"
  echo '[{"status": "completed", "conclusion": "success"}]' > "$STATE/runs-$head"
  echo '[{"status": "completed", "conclusion": "cancelled"}]' > "$STATE/live-runs-$head"
  players_plan "$A" "$CHANGES"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'the live suite started once' test "$(n_calls '^workflow run live-streams.yml --ref toolchain/player-libraries$')" = 1
  check 'CI not again' bash -c '! grep -q "workflow run ci.yml" "$0"' "$STATE/gh.log"
  check 'not rebuilt' test "$(origin rev-parse toolchain/player-libraries)" = "$head"
}

players_same_set_starts_ci() {
  setup
  players_open "$A"
  echo '[{"status": "completed", "conclusion": "failure"}]' > "$STATE/live-runs-$head"
  players_plan "$A" "$CHANGES"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'CI started once' test "$(n_calls '^workflow run ci.yml --ref toolchain/player-libraries$')" = 1
  check 'a failed live run is not started again here' bash -c '! grep -q "workflow run live-streams.yml" "$0"' "$STATE/gh.log"
}

players_changed_set() {
  # The set changed: rebuilt in place, force-pushed, its text moved to the new marker.
  setup
  players_open "$B"
  players_plan "$A" "[$(player plyr 3.8.5 3.8.7)]"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'rebuilt off main' test "$(origin rev-parse toolchain/player-libraries~1)" = "$(origin rev-parse main)"
  check 'the head moved' test "$(origin rev-parse toolchain/player-libraries)" != "$head"
  check 'at the new set' test "$(origin log -1 --format=%s toolchain/player-libraries)" = 'build: player libraries (plyr 3.8.7)'
  check 'its text edited' grep -qF "<!-- player-libraries: $A -->" "$STATE/pr-9-edited"
  check 'CI started' test "$(n_calls '^workflow run ci.yml --ref toolchain/player-libraries$')" = 1
  check 'the live suite started' test "$(n_calls '^workflow run live-streams.yml --ref toolchain/player-libraries$')" = 1
  check 'runs started before the text' test "$(grep -n '^workflow run live-streams.yml' "$STATE/gh.log" | cut -d: -f1)" -lt "$(grep -n '^pr edit 9' "$STATE/gh.log" | cut -d: -f1)"
  check 'no new pull request' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
}

players_conflicting() {
  setup
  players_open "$A"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  players_plan "$A" "$CHANGES"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'rebuilt off main' test "$(origin rev-parse toolchain/player-libraries~1)" = "$(origin rev-parse main)"
  check 'says why' grep -qF "rebuilt on main for the set $A." "$T/out"
}

players_other_commits() {
  setup
  players_open "$B"
  echo '{"commits":[{"authors":[{"login":"github-actions[bot]"}]},{"authors":[{"login":"nawid"}]}]}' > "$STATE/pr-9-commits.json"
  players_plan "$A" "$CHANGES"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'left as it was' test "$(origin rev-parse toolchain/player-libraries)" = "$head"
  check 'nothing started or edited' bash -c '! grep -qE "^(workflow run|pr edit|pr create)" "$0"' "$STATE/gh.log"
  check 'says why' grep -qF "holds someone else's commits: left to them" "$T/out"
}

players_caught_up() {
  # Not behind: closed with its branch, its marker taken out first (a skip keeps its marker).
  setup
  players_open "$A"
  players_plan "$A" '[]' '[]' '[]' false
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'marker out first' test "$(grep -n '^pr edit 9 --body-file' "$STATE/gh.log" | cut -d: -f1)" -lt "$(grep -n '^pr close 9' "$STATE/gh.log" | cut -d: -f1)"
  check 'reads caught up' grep -qF '<!-- player-libraries: caught up -->' "$STATE/pr-9-edited"
  check 'no longer names the set' bash -c '! grep -qF "$1" "$0"' "$STATE/pr-9-edited" "$A"
  check 'closed with its branch' has_call 'pr close 9 --delete-branch --comment Every player library is at its newest release of its major on main, as far as the ranges they declare allow. Closing.'
}

players_caught_up_others() {
  # Caught up, but someone pushed to it: left, branch and all.
  setup
  players_open "$A"
  echo '{"commits":[{"authors":[{"login":"nawid"}]}]}' > "$STATE/pr-9-commits.json"
  players_plan "$A" '[]' '[]' '[]' false
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not closed' bash -c '! grep -qE "^(pr close|pr edit)" "$0"' "$STATE/gh.log"
  check 'says why' grep -qF "main has caught up, but it holds someone else's commits" "$T/out"
}

players_skipped() {
  setup
  players_closed
  players_plan "$A" "$CHANGES"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'asks for the closed ones of the branch' has_call 'api --paginate repos/me/fs/pulls?state=closed&head=me:toolchain/player-libraries&per_page=100'
  check 'not raised again' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
  check 'says why' grep -qF 'was offered and closed unmerged: skipped.' "$T/out"
}

players_next_set() {
  # Another set: the skip was for that set only, and a merged one never skips.
  setup
  players_closed
  players_plan "$B" "[$(player dplayer 1.27.1 1.27.2)]"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'raised for the next set' grep -qF "<!-- player-libraries: $B -->" "$STATE/created.body"
}

players_no_players() {
  setup
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'says so' grep -qF 'The plan names no player libraries.' "$T/out"
  check 'nothing of it asked' bash -c '! grep -qE "pulls\?state=closed|creator=" "$0"' "$STATE/gh.log"
}

players_malformed() {
  # A set of another shape is refused, never read as "caught up".
  setup
  players_open "$A"
  jq '. + {players: {behind: "no"}}' "$STATE/plan.json" > "$STATE/p" && mv "$STATE/p" "$STATE/plan.json"
  run_step
  check 'fails' test "$rc" -eq 1
  check 'says why' grep -qF "The plan's player libraries are not a set this workflow reads" "$T/out"
  check 'the pull request untouched' bash -c '! grep -qE "^(pr close|pr edit)" "$0"' "$STATE/gh.log"
}

players_apply_refuses() {
  # A version that would go back: the run is red, nothing pushed or started.
  setup
  players_plan "$A" "[$(player plyr 3.8.5 3.8.4)]"
  run_step
  check 'fails, not stopped by the timeout' test "$rc" -eq 1
  check 'says why' grep -qF 'plyr would go back from 3.8.5 to 3.8.4' "$T/out"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
  check 'nothing started' bash -c '! grep -q "^workflow run" "$0"' "$STATE/gh.log"
}

players_new_major() {
  # A new major is taken like any release, and the pull request names it: its page may need a
  # change. No issue is raised for it.
  setup
  players_plan "$A" "[$(player plyr 3.8.5 4.0.1), $(player dplayer 1.27.1 1.27.2)]" "[$(player plyr 3.8.5 4.0.1)]"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'at the set' test "$(origin show "toolchain/player-libraries:$PFILE")" = "$(printf '{\n  "plyr": "4.0.1",\n  "dplayer": "1.27.2"\n}')"
  check 'names the new major' grep -qF 'A new major, whose page in `tests/e2e/live-specs/players.e2e.mjs` may need a change (the live suite shows it): plyr 3.8.5 to 4.0.1' "$STATE/created.body"
  check 'no issue' bash -c '! grep -qE "^issue (create|edit|reopen|close)|creator=" "$0"' "$STATE/gh.log"
}

players_kept() {
  # A library a hold keeps on its major: the text says what is out and why.
  setup
  players_plan "$A" "[$(player plyr 3.8.5 3.8.6)]" '[]' '[]' true \
    '[{"name": "dplayer", "version": "1.27.2", "latest": "2.0.0", "below": "2.0.0", "reason": "its 2 holds no player"}]'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'the kept one' grep -qF -- '- dplayer stays below 2.0.0 (2.0.0 is out): its 2 holds no player' "$STATE/created.body"
  check 'no new major named' bash -c '! grep -qF "A new major" "$0"' "$STATE/created.body"
  check 'nothing reads null' bash -c '! grep -qw null "$0"' "$STATE/created.body"
}

players_hold_problem() {
  # A hold to look at again: the set goes ahead, then the run fails and names it, not as a
  # source it could not read.
  setup
  players_plan "$A" "$CHANGES" '[]' '[]' true '[]' '["video.js below 9.0.0 has had no release for over 365 days (newest 8.24.2, 2026-10-06): look at it"]'
  run_step
  check 'fails' test "$rc" -eq 1
  check 'the set raised all the same' has_call 'pr create --base main --head toolchain/player-libraries'
  check 'names it' grep -qF '::error::video.js below 9.0.0 has had no release for over 365 days' "$T/out"
  check 'not as unread' bash -c '! grep -qF "Could not read video.js" "$0"' "$T/out"
}

players_malformed_no_majors() {
  # A set from an older checker, without newMajors and kept, is refused, never half read.
  setup
  players_plan "$A" "$CHANGES"
  jq '.players |= del(.newMajors, .kept)' "$STATE/plan.json" > "$STATE/p" && mv "$STATE/p" "$STATE/plan.json"
  run_step
  check 'fails' test "$rc" -eq 1
  check 'says why' grep -qF "The plan's player libraries are not a set this workflow reads" "$T/out"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
}

weekly_ublock() {
  setup
  printf 'an add-on\n' > "$STATE/addon.xpi"
  sha=$(sha256sum "$STATE/addon.xpi" | cut -d ' ' -f 1)
  plan "[$(ublock_update 1.76.0 "$sha")]" '[]'
  run_step
  b=toolchain/ublock-origin-1.76.0
  check 'exit 0' test "$rc" -eq 0
  check 'branch pushed' origin show-ref -q --verify "refs/heads/$b"
  check 'only the profile setup' test "$(branch_diff "$b")" = tools/setup-dev-profile.mjs
  check 'its version, file and SHA-256, nothing else' test "$(origin diff main "$b" | grep -c '^[-+] ')" = 6
  check 'the new SHA-256' bash -c 'git -C "$0" show "$1:tools/setup-dev-profile.mjs" | grep -qF "    sha256: '"'"'$2'"'"',"' "$T/origin.git" "$b" "$sha"
  check 'the new file' bash -c 'git -C "$0" show "$1:tools/setup-dev-profile.mjs" | grep -qF "file/5100000/ublock_origin-1.76.0.xpi"' "$T/origin.git" "$b"
  check 'downloaded' has_call 'curl https://addons.mozilla.org/firefox/downloads/file/5100000/ublock_origin-1.76.0.xpi'
  check 'before the pull request' test "$(grep -n '^curl ' "$STATE/gh.log" | cut -d: -f1)" -lt "$(grep -n '^pr create' "$STATE/gh.log" | cut -d: -f1)"
  check 'commit message' test "$(origin log -1 --format=%s "$b")" = 'build: uBlock Origin 1.75.0 -> 1.76.0'
  check 'pull request' has_call "pr create --base main --head $b --title Toolchain update: uBlock Origin 1.76.0 --label dependencies"
  check 'CI started once' test "$(n_calls "^workflow run ci.yml --ref $b\$")" = 1
  check 'names the change' grep -qF "changes only uBlock Origin's entry in \`tools/setup-dev-profile.mjs\`" "$STATE/created.body"
  check 'says the file was checked' grep -qF 'checked it against the SHA-256 AMO gives for it' "$STATE/created.body"
  check 'no lockfile hint' bash -c '! grep -qF "lockfile" "$0"' "$STATE/created.body"
  check 'main untouched' test "$(origin rev-list --count main)" = 1
}

ublock_wrong_file() {
  # AMO serves other bytes than its SHA-256 says: nothing is pushed, and the run is red.
  setup
  printf 'other bytes\n' > "$STATE/addon.xpi"
  plan "[$(ublock_update 1.76.0 "$(printf 'a%.0s' {1..64})")]" '[]'
  run_step
  check 'fails, not stopped by the timeout' test "$rc" -eq 1
  check 'says why' grep -qF "does not have AMO's SHA-256" "$T/out"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
  check 'no pull request' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
}

ublock_download_fails() {
  # AMO does not serve the file: nothing is pushed, and the run is red.
  setup
  plan "[$(ublock_update 1.76.0 "$(printf 'a%.0s' {1..64})")]" '[]'
  run_step
  check 'fails, not stopped by the timeout' test "$rc" -eq 1
  check 'tried' has_call 'curl https://addons.mozilla.org/firefox/downloads/file/5100000/ublock_origin-1.76.0.xpi'
  check 'says why' grep -qF 'uBlock Origin 1.76.0: https://addons.mozilla.org/firefox/downloads/file/5100000/ublock_origin-1.76.0.xpi could not be downloaded.' "$T/out"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
  check 'no pull request' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
}

ublock_repair_main_has_it() {
  # An open one conflicts with main, which has its version by now (moved by hand): the plan
  # closes it; it is not rebuilt.
  setup
  (
    cd "$T/work" || exit 1
    git checkout -q -b toolchain/ublock-origin-1.76.0
    sed -i "s/version: '1.75.0'/version: '1.76.0'/" tools/setup-dev-profile.mjs
    git commit -q -am old && git push -q origin toolchain/ublock-origin-1.76.0
    git checkout -q main
    sed -i "s/version: '1.75.0'/version: '1.76.0'/; s/sha256: '[0-9a-f]*'/sha256: '$(printf 'd%.0s' {1..64})'/" tools/setup-dev-profile.mjs
    git commit -q -am 'uBlock Origin 1.76.0 by hand' && git push -q origin main
  )
  old=$(origin rev-parse toolchain/ublock-origin-1.76.0)
  open_pr 9 'Toolchain update: uBlock Origin 1.76.0' toolchain/ublock-origin-1.76.0 "$old"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  run_step
  check 'exit 0: no red run' test "$rc" -eq 0
  check 'not rebuilt' test "$(origin rev-parse toolchain/ublock-origin-1.76.0)" = "$old"
  check 'says why' grep -qF 'main has uBlock Origin 1.76.0 by now' "$T/out"
}

unread_source_fails_after() {
  # A source the checker could not read (AMO, say): the other tracks go ahead, then the run
  # fails and names it.
  setup
  plan "[$(pnpm_update 11.27.1)]" '[]'
  jq '. + {errors: ["uBlock Origin: https://addons.mozilla.org/x: HTTP 503"]}' "$STATE/plan.json" > "$STATE/p" && mv "$STATE/p" "$STATE/plan.json"
  run_step
  check 'fails' test "$rc" -eq 1
  check 'pnpm raised all the same' has_call 'pr create --base main --head toolchain/pnpm-11.27.1'
  check 'and its CI started' has_call 'workflow run ci.yml --ref toolchain/pnpm-11.27.1'
  check 'names what it could not read' grep -qF '::error::Could not read uBlock Origin: https://addons.mozilla.org/x: HTTP 503' "$T/out"
}

ublock_no_file() {
  setup
  plan "[$(ublock_update 1.76.0 x | jq -c 'del(.file)')]" '[]'
  run_step
  check 'fails, not stopped by the timeout' test "$rc" -eq 1
  check 'says why' grep -qF 'The plan gives no file for uBlock Origin 1.76.0.' "$T/out"
  check 'nothing downloaded' bash -c '! grep -q "^curl" "$0"' "$STATE/gh.log"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
}

ublock_repair_not_newest() {
  # An open one conflicts with main, and the checker names a newer release by now: it is
  # left for the plan, which raises the newer one; nothing is rebuilt without its file.
  setup
  (
    cd "$T/work" || exit 1
    git checkout -q -b toolchain/ublock-origin-1.76.0
    sed -i "s/version: '1.75.0'/version: '1.76.0'/" tools/setup-dev-profile.mjs
    git commit -q -am old && git push -q origin toolchain/ublock-origin-1.76.0
    git checkout -q main
  )
  old=$(origin rev-parse toolchain/ublock-origin-1.76.0)
  open_pr 9 'Toolchain update: uBlock Origin 1.76.0' toolchain/ublock-origin-1.76.0 "$old"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  jq --argjson u "$(ublock_update 1.77.0 "$(printf 'a%.0s' {1..64})")" '. + {updates: [$u]}' "$STATE/plan.json" > "$STATE/p" && mv "$STATE/p" "$STATE/plan.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not rebuilt' test "$(origin rev-parse toolchain/ublock-origin-1.76.0)" = "$old"
  check 'says why' grep -qF 'uBlock Origin 1.76.0 is not the newest any more' "$T/out"
}

ublock_repair_rebuilds() {
  # An open one conflicts with main, and is still the newest: rebuilt on main with its file.
  setup
  printf 'an add-on\n' > "$STATE/addon.xpi"
  sha=$(sha256sum "$STATE/addon.xpi" | cut -d ' ' -f 1)
  (
    cd "$T/work" || exit 1
    git checkout -q -b toolchain/ublock-origin-1.76.0
    sed -i "s/version: '1.75.0'/version: '1.76.0'/" tools/setup-dev-profile.mjs
    git commit -q -am old && git push -q origin toolchain/ublock-origin-1.76.0
    git checkout -q main
    echo x > later.txt && git add later.txt && git commit -q -m later && git push -q origin main
  )
  old=$(origin rev-parse toolchain/ublock-origin-1.76.0)
  open_pr 9 'Toolchain update: uBlock Origin 1.76.0' toolchain/ublock-origin-1.76.0 "$old"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  jq --argjson u "$(ublock_update 1.76.0 "$sha")" '. + {updates: [$u]}' "$STATE/plan.json" > "$STATE/p" && mv "$STATE/p" "$STATE/plan.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'rebuilt on main' test "$(origin rev-parse toolchain/ublock-origin-1.76.0~1)" = "$(origin rev-parse main)"
  check 'with its file' bash -c 'git -C "$0" show toolchain/ublock-origin-1.76.0:tools/setup-dev-profile.mjs | grep -qF "    sha256: '"'"'$1'"'"',"' "$T/origin.git" "$sha"
  check 'CI started' has_call 'workflow run ci.yml --ref toolchain/ublock-origin-1.76.0'
}

unexpected_file() {
  setup
  echo x > "$T/work/stray.txt"
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'fails, not stopped by the timeout' test "$rc" -eq 1
  check 'says why' grep -qF 'Unexpected change for pnpm 11.27.1: stray.txt' "$T/out"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
}

weekly_pnpm() {
  setup
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'branch pushed' origin show-ref -q --verify refs/heads/toolchain/pnpm-11.27.1
  check 'only package.json' test "$(branch_diff toolchain/pnpm-11.27.1)" = package.json
  check 'only the packageManager line' test "$(origin diff main toolchain/pnpm-11.27.1 | grep -c '^[-+] ')" = 2
  check 'to the new version' bash -c 'git -C "$0" show toolchain/pnpm-11.27.1:package.json | grep -qF "\"packageManager\": \"pnpm@11.27.1\""' "$T/origin.git"
  check 'commit message' test "$(origin log -1 --format=%s toolchain/pnpm-11.27.1)" = 'build: pnpm 11.22.0 -> 11.27.1'
  check 'as github-actions[bot]' test "$(origin log -1 --format=%an toolchain/pnpm-11.27.1)" = 'github-actions[bot]'
  check 'branch off main' test "$(origin rev-parse toolchain/pnpm-11.27.1~1)" = "$(origin rev-parse main)"
  check 'main untouched' test "$(origin rev-list --count main)" = 1
  check 'pull request' has_call 'pr create --base main --head toolchain/pnpm-11.27.1 --title Toolchain update: pnpm 11.27.1 --label dependencies'
  check 'CI started once' test "$(n_calls '^workflow run ci.yml --ref toolchain/pnpm-11.27.1$')" = 1
  check 'routine body' grep -qF 'Routine: `update-prs.yml` tells @nawid once CI has run whether it is ready to merge' "$STATE/created.body"
  check 'names the change' grep -qF 'changes only `packageManager` in `package.json`' "$STATE/created.body"
  check 'lockfile hint' grep -qF 'The lockfile is left as it is' "$STATE/created.body"
  check 'every title, paginated' has_call 'api --paginate repos/me/fs/issues?state=all&per_page=100'
  check 'titles reach the plan' grep -qxF 'Toolchain update: Node.js 24' "$STATE/titles.seen"
  check 'not close-only' bash -c '! grep -q -- --close-only "$0"' "$STATE/gh.log"
}

weekly_node() {
  setup
  plan '[{"name": "Node.js", "current": "22", "latest": "26", "behind": true, "routine": false, "note": "n", "title": "Toolchain update: Node.js 26"}]' '[]'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'only .nvmrc' test "$(branch_diff toolchain/node-26)" = .nvmrc
  check '.nvmrc is 26' test "$(origin show toolchain/node-26:.nvmrc)" = 26
  check 'commit message' test "$(origin log -1 --format=%s toolchain/node-26)" = 'build: Node.js 22 -> 26'
  check 'a decision' grep -qF 'A decision: `update-prs.yml` tells @nawid' "$STATE/created.body"
  check 'no lockfile hint' bash -c '! grep -qF "lockfile" "$0"' "$STATE/created.body"
}

push_closes_only() {
  setup
  export EVENT=push
  plan "[$(pnpm_update 11.27.1)]" '[{"number": 5, "comment": "The project now uses pnpm 11.27.1. Closing."}]'
  echo OPEN > "$STATE/pr-5-state"
  open_pr 9 'Toolchain update: Node.js 26' toolchain/node-26 abc
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'planned close-only' has_call 'node tools/check-toolchain.mjs --plan'
  check 'close-only flag' grep -qE -- '--plan .* --close-only$' "$STATE/gh.log"
  check 'nothing raised' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
  check 'closed' has_call 'pr close 5 --delete-branch --comment The project now uses pnpm 11.27.1. Closing.'
  check 'no repair pass' bash -c '! grep -qE "^(run list|workflow run)" "$0"' "$STATE/gh.log"
}

close_states() {
  setup
  plan '[]' '[{"number": 5, "comment": "c5"}, {"number": 6, "comment": "c6"}, {"number": 7, "comment": "c7"}, {"number": 8, "comment": "c8"}]'
  echo OPEN > "$STATE/pr-5-state"
  echo MERGED > "$STATE/pr-6-state"
  echo OPEN > "$STATE/issue-7-state"
  echo CLOSED > "$STATE/issue-8-state"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'open pr closed with its branch' has_call 'pr close 5 --delete-branch --comment c5'
  check 'merged pr left' bash -c '! grep -q "close 6" "$0"' "$STATE/gh.log"
  check 'open issue closed' has_call 'issue close 7 --comment c7'
  check 'closed issue left' bash -c '! grep -q "close 8" "$0"' "$STATE/gh.log"
}

nothing_changes() {
  setup
  plan "[$(pnpm_update 11.22.0)]" '[]'
  run_step
  check 'fails: a red scheduled run is emailed (not stopped by the timeout)' test "$rc" -eq 1
  check 'no pull request' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
  check 'says why' grep -qF 'changes nothing here' "$T/out"
}

dispatch_retried() {
  setup
  echo 1 > "$STATE/dispatch_fails"
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'dispatched twice' test "$(n_calls '^workflow run ci.yml --ref toolchain/pnpm-11.27.1$')" = 2
  check 'waiting 30 s between' test "$(cat "$STATE/sleeps")" = 30
}

dispatch_fails() {
  setup
  echo 2 > "$STATE/dispatch_fails"
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'fails, not stopped by the timeout' test "$rc" -eq 1
}

label_exists() {
  setup
  : > "$STATE/label_exists"
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'pull request' has_call 'pr create'
}

open_pr() { # <number> <title> <branch> <head sha> [author login] [cross-repository]
  jq --argjson n "$1" --arg t "$2" --arg b "$3" --arg h "$4" --arg a "${5:-app/github-actions}" --argjson x "${6:-false}" \
    '. + [{number: $n, title: $t, headRefName: $b, headRefOid: $h, author: {login: $a}, isCrossRepository: $x}]' \
    "$STATE/prs.json" > "$STATE/p" && mv "$STATE/p" "$STATE/prs.json"
  [ -f "$STATE/pr-$1-body" ] || : > "$STATE/pr-$1-body"
}

# The player libraries' rolling pull request.
A=aaaaaaaa1111
B=bbbbbbbb2222
players_plan() { # <state> <changes> [newMajors] [held] [behind] [kept] [holdProblems]: the plan's "players", its target from main's file
  local pins
  pins=$(git -C "$T/work" show main:tests/e2e/live-specs/player-libraries.json)
  jq --arg s "$1" --argjson c "$2" --argjson m "${3:-[]}" --argjson h "${4:-[]}" --argjson b "${5:-true}" --argjson kp "${6:-[]}" \
    --argjson p "${7:-[]}" --argjson pins "$pins" \
    '. + {players: {state: $s, behind: $b, changes: $c, newMajors: $m, kept: $kp, held: $h, holdProblems: $p,
      target: ($pins | with_entries(.key as $k | .value = ([$c[] | select(.name == $k) | .to][0] // .value)))}}' \
    "$STATE/plan.json" > "$STATE/p" && mv "$STATE/p" "$STATE/plan.json"
}
player() { jq -cn --arg n "$1" --arg f "$2" --arg t "$3" '{name: $n, from: $f, to: $t}'; }
players_body() { printf 'The player libraries the live suite plays.\n<!-- player-libraries: %s -->\n' "$1" > "$STATE/pr-9-body"; }
players_branch() { # <plyr> <dplayer>: toolchain/player-libraries on origin, holding those
  (
    cd "$T/work" || exit 1
    git checkout -q -B toolchain/player-libraries
    printf '{\n  "plyr": "%s",\n  "dplayer": "%s"\n}\n' "$1" "$2" > tests/e2e/live-specs/player-libraries.json
    git commit -q -am "build: player libraries" && git push -q -f origin toolchain/player-libraries
    git checkout -q main
  )
}
players_open() { # the rolling pull request open, as #9, on a branch with these versions, marked <state>
  players_branch 3.8.6 1.27.2
  head=$(origin rev-parse toolchain/player-libraries)
  open_pr 9 'Toolchain update: player libraries' toolchain/player-libraries "$head"
  players_body "$1"
}
players_closed() { # closed ones on the branch: $A closed unmerged, $B merged
  jq -n --arg a "$A" --arg b "$B" '[{merged_at: null, user: {login: "github-actions[bot]"}, body: "old <!-- player-libraries: \($a) -->"},
    {merged_at: "2026-01-01T10:00:00Z", user: {login: "github-actions[bot]"}, body: "old <!-- player-libraries: \($b) -->"}]' > "$STATE/closed-prs.json"
}
CHANGES="[$(player plyr 3.8.5 3.8.6), $(player dplayer 1.27.1 1.27.2)]"
PFILE=tests/e2e/live-specs/player-libraries.json
old_branch() { # <branch> <packageManager>: a stale branch on origin, off an older main
  (
    cd "$T/work" || exit 1
    git checkout -q -b "$1"
    sed -i "s/pnpm@11.22.0/$2/" package.json
    git commit -q -am "old $1" && git push -q origin "$1"
    git checkout -q main
    # main moves on
    sed -i 's/pnpm@11.22.0/pnpm@11.27.1/' package.json
    git commit -q -am 'build: pnpm 11.22.0 -> 11.27.1' && git push -q origin main
  )
}

repair_conflict() {
  setup
  old_branch toolchain/pnpm-12.7.0 pnpm@12.7.0
  old=$(origin rev-parse toolchain/pnpm-12.7.0)
  open_pr 9 'Toolchain update: pnpm 12.7.0' toolchain/pnpm-12.7.0 "$old"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'rebuilt' test "$(origin rev-parse toolchain/pnpm-12.7.0)" != "$old"
  check 'on the new main' test "$(origin rev-parse toolchain/pnpm-12.7.0~1)" = "$(origin rev-parse main)"
  check 'from the new main version' test "$(origin log -1 --format=%s toolchain/pnpm-12.7.0)" = 'build: pnpm 11.27.1 -> 12.7.0'
  check 'CI started' has_call 'workflow run ci.yml --ref toolchain/pnpm-12.7.0'
  check 'no new pull request' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
}

repair_conflict_others() {
  setup
  old_branch toolchain/pnpm-12.7.0 pnpm@12.7.0
  old=$(origin rev-parse toolchain/pnpm-12.7.0)
  open_pr 9 'Toolchain update: pnpm 12.7.0' toolchain/pnpm-12.7.0 "$old"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  echo '{"commits":[{"authors":[{"login":"github-actions[bot]"}]},{"authors":[{"login":"nawid"}]}]}' > "$STATE/pr-9-commits.json"
  : > "$STATE/runs-$old"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'left alone' test "$(origin rev-parse toolchain/pnpm-12.7.0)" = "$old"
  check 'no CI' bash -c '! grep -q "^workflow run" "$0"' "$STATE/gh.log"
}

repair_no_ci() {
  setup
  open_pr 9 'Toolchain update: Node.js 26' toolchain/node-26 abc123
  open_pr 10 'Toolchain update: pnpm 11.27.1' toolchain/pnpm-11.27.1 def456
  echo '[{"status": "completed", "conclusion": "success"}]' > "$STATE/runs-def456"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'CI on the one without' has_call 'workflow run ci.yml --ref toolchain/node-26'
  check 'none on the one with' bash -c '! grep -q "ref toolchain/pnpm-11.27.1" "$0"' "$STATE/gh.log"
}

repair_run_conclusions() {
  # A cancelled or broken run decides nothing; a queued one will, as a failed or timed-out
  # one did.
  setup
  open_pr 9 'Toolchain update: Node.js 26' toolchain/node-26 abc123
  open_pr 10 'Toolchain update: pnpm 11.27.1' toolchain/pnpm-11.27.1 def456
  open_pr 11 'Toolchain update: Node.js 25' toolchain/node-25 aaa111
  open_pr 12 'Toolchain update: pnpm 12.7.0' toolchain/pnpm-12.7.0 bbb222
  echo '[{"status": "completed", "conclusion": "cancelled"}, {"status": "completed", "conclusion": "startup_failure"}]' > "$STATE/runs-abc123"
  echo '[{"status": "queued", "conclusion": null}]' > "$STATE/runs-def456"
  echo '[{"status": "completed", "conclusion": "failure"}]' > "$STATE/runs-aaa111"
  echo '[{"status": "completed", "conclusion": "timed_out"}]' > "$STATE/runs-bbb222"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'CI on the cancelled one' has_call 'workflow run ci.yml --ref toolchain/node-26'
  check 'none on the queued one' bash -c '! grep -q "ref toolchain/pnpm-11.27.1" "$0"' "$STATE/gh.log"
  check 'none on the failed one' bash -c '! grep -q "ref toolchain/node-25" "$0"' "$STATE/gh.log"
  check 'none on the timed-out one' bash -c '! grep -q "ref toolchain/pnpm-12.7.0" "$0"' "$STATE/gh.log"
}

only_own() {
  # Anyone's pull request or issue with such a title neither blocks an update, nor is
  # closed, rebuilt or given CI; nor is this workflow's own without the title prefix.
  setup
  open_pr 9 'Toolchain update: pnpm 12.7.0' toolchain/pnpm-12.7.0 abc stranger
  open_pr 10 'Toolchain update: Node.js 26' toolchain/node-26 def app/github-actions true
  open_pr 11 'Toolchain update: Node.js 24' toolchain/node-24 fff
  open_pr 12 'pnpm 12.8.0' toolchain/pnpm-12.8.0 ggg
  echo '[{"number": 13, "title": "Toolchain update: Node.js 23", "author": {"login": "app/github-actions"}}, {"number": 14, "title": "Toolchain update: Node.js 21", "author": {"login": "stranger"}}]' > "$STATE/issues.json"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  echo CONFLICTING > "$STATE/pr-10-mergeable"
  echo CONFLICTING > "$STATE/pr-12-mergeable"
  echo '[{"status": "completed", "conclusion": "success"}]' > "$STATE/runs-fff"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'the open ones planned: its own, with the prefix' jq -e '[.[].number] | sort == [10, 11, 13]' "$STATE/open.seen"
  check "a stranger's title is not used" bash -c '! grep -qF "Node.js 30" "$0"' "$STATE/titles.seen"
  check 'its own title is' grep -qxF 'Toolchain update: Node.js 24' "$STATE/titles.seen"
  check 'nothing done to the others' bash -c '! grep -qE "^(workflow run|pr view (9|10|12) )" "$0"' "$STATE/gh.log"
  check 'nothing pushed' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
}

repair_on_fresh_main() {
  # main moves on while the run works: the rebuild is made on today's main.
  setup
  old_branch toolchain/pnpm-12.7.0 pnpm@12.7.0
  old=$(origin rev-parse toolchain/pnpm-12.7.0)
  open_pr 9 'Toolchain update: pnpm 12.7.0' toolchain/pnpm-12.7.0 "$old"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  git clone -q "$T/origin.git" "$T/other"
  (cd "$T/other" && echo x > later.txt && git add later.txt && git commit -q -m later && git push -q origin main)
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'rebuilt on the newest main' test "$(origin rev-parse toolchain/pnpm-12.7.0~1)" = "$(origin rev-parse main)"
  check 'which has the later commit' test "$(origin log -1 --format=%s main)" = later
}

repair_main_has_it() {
  setup
  old_branch toolchain/pnpm-12.7.0 pnpm@12.7.0
  old=$(origin rev-parse toolchain/pnpm-12.7.0)
  open_pr 9 'Toolchain update: pnpm 12.7.0' toolchain/pnpm-12.7.0 "$old"
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  git clone -q "$T/origin.git" "$T/other"
  (cd "$T/other" && sed -i 's/pnpm@11.27.1/pnpm@12.7.0/' package.json && git commit -q -am 'pnpm 12.7.0 by hand' && git push -q origin main)
  run_step
  check 'exit 0: no red run' test "$rc" -eq 0
  check 'not rebuilt' test "$(origin rev-parse toolchain/pnpm-12.7.0)" = "$old"
  check 'says why' grep -qF 'main has pnpm 12.7.0 by now' "$T/out"
}

close_fails_continues() {
  setup
  plan '[]' '[{"number": 5, "comment": "c5"}, {"number": 7, "comment": "c7"}, {"number": 8, "comment": "c8"}]'
  echo OPEN > "$STATE/pr-5-state"
  : > "$STATE/close-5-fails"
  echo OPEN > "$STATE/issue-7-state"
  : > "$STATE/close-7-fails"
  echo OPEN > "$STATE/issue-8-state"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'warns: the pull request' grep -qF '::warning::Could not close #5 (merged meanwhile?); the next run tries again.' "$T/out"
  check 'goes on' has_call 'issue close 7 --comment c7'
  check 'warns: the issue' grep -qF '::warning::Could not close #7; the next run tries again.' "$T/out"
  check 'goes on' has_call 'issue close 8 --comment c8'
}

repair_skips_raised() {
  # The pull request raised in this run is in the repair pass's list, and gets no second CI
  # run. (The plan is canned: the real one never raises a title that is open.)
  setup
  plan "[$(pnpm_update 11.27.1)]" '[]'
  open_pr 100 'Toolchain update: pnpm 11.27.1' toolchain/pnpm-11.27.1 fff
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'CI started once' test "$(n_calls '^workflow run ci.yml --ref toolchain/pnpm-11.27.1$')" = 1
}

weekly_two() {
  # Each update gets its own branch off main, with only its own change.
  setup
  plan "[{\"name\": \"Node.js\", \"current\": \"22\", \"latest\": \"26\", \"behind\": true, \"routine\": false, \"note\": \"n\", \"title\": \"Toolchain update: Node.js 26\"}, $(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'Node.js: only .nvmrc' test "$(branch_diff toolchain/node-26)" = .nvmrc
  check 'pnpm: only package.json' test "$(branch_diff toolchain/pnpm-11.27.1)" = package.json
  check 'Node.js off main' test "$(origin rev-parse toolchain/node-26~1)" = "$(origin rev-parse main)"
  check 'pnpm off main' test "$(origin rev-parse toolchain/pnpm-11.27.1~1)" = "$(origin rev-parse main)"
  check 'two pull requests' test "$(n_calls '^pr create')" = 2
  check 'one for Node.js' has_call 'pr create --base main --head toolchain/node-26 --title Toolchain update: Node.js 26 --label dependencies'
  check 'one for pnpm' has_call 'pr create --base main --head toolchain/pnpm-11.27.1 --title Toolchain update: pnpm 11.27.1 --label dependencies'
  check 'CI on each, once' test "$(n_calls '^workflow run ci.yml --ref toolchain/node-26$') $(n_calls '^workflow run ci.yml --ref toolchain/pnpm-11.27.1$')" = '1 1'
}

repair_mergeable_unknown() {
  # GitHub never works out whether it merges: after ten tries, CI is started if the head
  # has no run that decides.
  setup
  open_pr 9 'Toolchain update: Node.js 26' toolchain/node-26 abc123
  echo UNKNOWN > "$STATE/pr-9-mergeable"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'asks ten times' test "$(n_calls '^pr view 9 --json mergeable')" = 10
  check 'six seconds apart' test "$(grep -cx 6 "$STATE/sleeps")" = 10
  check 'then starts CI' has_call 'workflow run ci.yml --ref toolchain/node-26'
  check 'not rebuilt' test "$(origin for-each-ref --format=x refs/heads | wc -l)" = 1
}

repair_leaves_strangers() {
  setup
  open_pr 9 'Toolchain update: foo 1.0' toolchain/foo-1.0 abc
  open_pr 10 'Toolchain update: pnpm 11.27.1' feature/mine abc
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  echo CONFLICTING > "$STATE/pr-10-mergeable"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'nothing done to them' bash -c '! grep -qE "^(workflow run|pr view)" "$0"' "$STATE/gh.log"
}

weekly_pnpm
weekly_node
weekly_two
players_new_set
players_same_set_both_ran
players_same_set_starts_live
players_held_and_unresolved
players_same_set_timed_out
players_same_set_live_never_ran
players_same_set_starts_ci
players_changed_set
players_conflicting
players_other_commits
players_caught_up
players_caught_up_others
players_skipped
players_next_set
players_no_players
players_malformed
players_apply_refuses
players_new_major
players_kept
players_hold_problem
players_malformed_no_majors
weekly_ublock
ublock_wrong_file
ublock_download_fails
ublock_no_file
ublock_repair_main_has_it
unread_source_fails_after
ublock_repair_not_newest
ublock_repair_rebuilds
unexpected_file
push_closes_only
close_states
nothing_changes
dispatch_retried
dispatch_fails
label_exists
repair_conflict
repair_conflict_others
repair_no_ci
repair_skips_raised
repair_leaves_strangers
repair_run_conclusions
repair_mergeable_unknown
only_own
repair_on_fresh_main
repair_main_has_it
close_fails_continues

printf '%d checks, %d failed\n' "$checks" "$fails"
[ "$fails" -eq 0 ]
