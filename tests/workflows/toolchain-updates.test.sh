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
  'pr list') jqout "$STATE/prs.json" ;;
  'issue list') jqout "$STATE/issues.json" ;;
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
      *) echo "stub gh: unhandled: $*" >&2; exit 99 ;;
    esac
    ;;
  'issue view') cat "$STATE/issue-$3-state" ;;
  'pr close'|'issue close') if [ -f "$STATE/close-$3-fails" ]; then echo 'already merged' >&2; exit 1; fi ;;
  'run list') f="$STATE/runs-$(opt --commit "$@")"; [ -s "$f" ] || echo '[]' > "$f"; jqout "$f" ;;
  'api --paginate') jqout "$STATE/all.json" ;;
  *) echo "stub gh: unhandled: $*" >&2; exit 99 ;;
esac
EOF
  cat > "$BIN/node" <<EOF
#!/usr/bin/env bash
if [ "\${1-}" = tools/check-toolchain.mjs ]; then
  printf 'node %s\n' "\$*" >> "\$STATE/gh.log"
  if [ "\${2-}" = --plan ]; then cp "\$3" "\$STATE/open.seen"; cp "\$4" "\$STATE/titles.seen"; cat "\$STATE/plan.json"; else echo 'UPDATE  (canned)'; fi
  exit 0
fi
exec $(command -v node) "\$@"
EOF
  printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"
  chmod +x "$BIN/gh" "$BIN/node" "$BIN/sleep"
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
    git add -A && git commit -q -m init && git remote add origin "$T/origin.git" && git push -q origin main
  )
  echo '[]' > "$STATE/prs.json"
  echo '[]' > "$STATE/issues.json"
  echo '[{"title": "Toolchain update: Node.js 24", "user": {"login": "github-actions[bot]"}}, {"title": "chore: release", "user": {"login": "Nawid3333"}}, {"title": "Toolchain update: Node.js 30", "user": {"login": "stranger"}}]' > "$STATE/all.json"
  plan '[]' '[]'
  printf '\n=== %s ===\n' "$scenario"
}
plan() { jq -n --argjson r "$1" --argjson c "$2" '{raise: $r, close: $c}' > "$STATE/plan.json"; }
pnpm_update() { # <latest> [automerge]
  jq -cn --arg l "$1" --argjson a "${2:-true}" '{name: "pnpm", current: "11.22.0", latest: $l, behind: true, automerge: $a, note: "n", title: "Toolchain update: pnpm \($l)"}'
}
run_step() {
  rc=0
  (cd "$T/work" && env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL timeout 60 bash -e "$STEP") > "$T/out" 2>&1 || rc=$?
}
branch_diff() { origin diff --name-only "main...$1"; }

# --- Scenarios.

unexpected_file() {
  setup
  echo x > "$T/work/stray.txt"
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'fails' test "$rc" -ne 0
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
  check 'routine body' grep -qF 'Routine: `update-prs.yml` merges it' "$STATE/created.body"
  check 'names the change' grep -qF 'changes only `packageManager` in `package.json`' "$STATE/created.body"
  check 'lockfile hint' grep -qF 'The lockfile is left as it is' "$STATE/created.body"
  check 'every title, paginated' has_call 'api --paginate repos/me/fs/issues?state=all&per_page=100'
  check 'titles reach the plan' grep -qxF 'Toolchain update: Node.js 24' "$STATE/titles.seen"
  check 'not close-only' bash -c '! grep -q -- --close-only "$0"' "$STATE/gh.log"
}

weekly_node() {
  setup
  plan '[{"name": "Node.js", "current": "22", "latest": "26", "behind": true, "automerge": false, "note": "n", "title": "Toolchain update: Node.js 26"}]' '[]'
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
  check 'fails: a red scheduled run is emailed' test "$rc" -ne 0
  check 'no pull request' bash -c '! grep -q "^pr create" "$0"' "$STATE/gh.log"
  check 'says why' grep -qF 'changes nothing here' "$T/out"
}

dispatch_retried() {
  setup
  echo 1 > "$STATE/dispatch_fails"
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'dispatched twice' test "$(n_calls '^workflow run ci.yml')" = 2
}

dispatch_fails() {
  setup
  echo 2 > "$STATE/dispatch_fails"
  plan "[$(pnpm_update 11.27.1)]" '[]'
  run_step
  check 'fails' test "$rc" -ne 0
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
}
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
  # A cancelled or broken run decides nothing; a queued one will.
  setup
  open_pr 9 'Toolchain update: Node.js 26' toolchain/node-26 abc123
  open_pr 10 'Toolchain update: pnpm 11.27.1' toolchain/pnpm-11.27.1 def456
  echo '[{"status": "completed", "conclusion": "cancelled"}, {"status": "completed", "conclusion": "startup_failure"}]' > "$STATE/runs-abc123"
  echo '[{"status": "queued", "conclusion": null}]' > "$STATE/runs-def456"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'CI on the cancelled one' has_call 'workflow run ci.yml --ref toolchain/node-26'
  check 'none on the queued one' bash -c '! grep -q "ref toolchain/pnpm-11.27.1" "$0"' "$STATE/gh.log"
}

only_own() {
  # Anyone's pull request or issue with such a title neither blocks an update, nor is
  # closed, rebuilt or given CI.
  setup
  open_pr 9 'Toolchain update: pnpm 12.7.0' toolchain/pnpm-12.7.0 abc stranger
  open_pr 10 'Toolchain update: Node.js 26' toolchain/node-26 def app/github-actions true
  open_pr 11 'Toolchain update: Node.js 24' toolchain/node-24 fff
  echo CONFLICTING > "$STATE/pr-9-mergeable"
  echo CONFLICTING > "$STATE/pr-10-mergeable"
  echo '[{"status": "completed", "conclusion": "success"}]' > "$STATE/runs-fff"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check "a stranger's open one is not planned" jq -e 'all(.[]; .number != 9) and any(.[]; .number == 11)' "$STATE/open.seen"
  check "a stranger's title is not used" bash -c '! grep -qF "Node.js 30" "$0"' "$STATE/titles.seen"
  check 'its own title is' grep -qxF 'Toolchain update: Node.js 24' "$STATE/titles.seen"
  check 'nothing done to the others' bash -c '! grep -qE "^(workflow run|pr view (9|10) )" "$0"' "$STATE/gh.log"
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
  plan '[]' '[{"number": 5, "comment": "c5"}, {"number": 7, "comment": "c7"}]'
  echo OPEN > "$STATE/pr-5-state"
  : > "$STATE/close-5-fails"
  echo OPEN > "$STATE/issue-7-state"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'warns' grep -qF '::warning::Could not close #5' "$T/out"
  check 'goes on' has_call 'issue close 7 --comment c7'
}

repair_skips_raised() {
  setup
  plan "[$(pnpm_update 11.27.1)]" '[]'
  open_pr 100 'Toolchain update: pnpm 11.27.1' toolchain/pnpm-11.27.1 fff
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'CI started once' test "$(n_calls '^workflow run ci.yml')" = 1
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
only_own
repair_on_fresh_main
repair_main_has_it
close_fails_continues

printf '%d checks, %d failed\n' "$checks" "$fails"
[ "$fails" -eq 0 ]
