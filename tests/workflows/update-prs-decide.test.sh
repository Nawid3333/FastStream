#!/usr/bin/env bash
# update-prs.yml's Decide step: when a pull request merges, waits, or is reported red.
# gh, curl, sleep and unzip are stubbed (unzip by python's zipfile, curl by canned npm
# registry answers); jq, awk, sed, sha1sum and diff run for real. Every gh call is logged
# to $STATE/gh.log, every curl call to $STATE/curl.log. KEEP=1 keeps the scenarios' temp
# folders. This test keeps its own check and run_step, which also print the step's output
# and gh calls when a check fails.
source "$(dirname "$0")/lib.sh"
KEEP=${KEEP:-0}
STEP=$(mktemp)
step_script update-prs.yml Decide > "$STEP" || exit 1
checks=0
fails=0
TDIRS=()
scenario=
rc=0

cleanup() { rm -f "$STEP"; if [ "$KEEP" != 1 ]; then rm -rf "${TDIRS[@]}"; fi; }
trap cleanup EXIT

check() {
  local desc=$1
  shift
  checks=$((checks + 1))
  if "$@"; then
    printf 'PASS %s: %s\n' "$scenario" "$desc"
  else
    printf 'FAIL %s: %s\n' "$scenario" "$desc"
    tail -n 25 "$T/out"
    tail -n 25 "$STATE/gh.log"
    fails=$((fails + 1))
  fi
}

run_step() {
  rc=0
  (cd "$T" && timeout 60 bash -e "$STEP") > "$T/out" 2>&1 || rc=$?
}

mutations() { grep -E '^(pr (comment|edit|merge)|api -X (PATCH|PUT)|run rerun|workflow run|label create|issue )' "$STATE/gh.log" || true; }
n_mut() { mutations | wc -l | tr -d '[:space:]'; }
has_call() { grep -qF -- "$1" "$STATE/gh.log"; }
comments_n() { jq length "$STATE/comments.json"; }
last_comment() { jq -r '.[-1].body' "$STATE/comments.json"; }
merged() { [ -f "$STATE/merged" ]; }

write_stubs() {
  cat > "$BIN/gh" <<'GHSTUB'
#!/usr/bin/env bash
set -e
printf '%s\n' "$*" >> "$STATE/gh.log"
ORIG=("$@")
unhandled() { echo "stub gh: unhandled: ${ORIG[*]}" >&2; exit 99; }
opt() { local flag=$1 prev= a; shift; for a in "$@"; do if [ "$prev" = "$flag" ]; then printf '%s\n' "$a"; return 0; fi; prev=$a; done; return 1; }
jqout() { # <file>: print it, through --jq if given
  local e
  if e=$(opt --jq "${ORIG[@]}"); then jq -r "$e" "$1"; else cat "$1"; fi
}
case "$1 $2" in
  'pr list')
    [ "$(opt --head "$@")" = "$BRANCH" ] || { echo '[]'; exit 0; }
    cat "$STATE/prs.json"
    ;;
  'pr view')
    fields=$(opt --json "$@")
    case $fields in
      files,commits) cat "$STATE/prview.json" ;;
      mergeable)
        n=$(cat "$STATE/mergeable_calls" 2> /dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STATE/mergeable_calls"
        m=$(cat "$STATE/mergeable")
        if [ "$n" -le "$(cat "$STATE/mergeable_unknown" 2> /dev/null || echo 0)" ]; then m=UNKNOWN; fi
        jq -n --arg m "$m" '{mergeable: $m}' > "$STATE/m.json"
        jqout "$STATE/m.json"
        ;;
      headRefOid)
        head=$SHA
        if [ -f "$STATE/head_moved" ] || { [ -f "$STATE/updated" ] && [ ! -f "$STATE/head_stuck" ]; }; then head=ffffffffffffffffffffffffffffffffffffffff; fi
        jq -n --arg h "$head" '{headRefOid: $h}' > "$STATE/h.json"
        jqout "$STATE/h.json"
        ;;
      state)
        jq -n --arg s "$(cat "$STATE/pr_state" 2> /dev/null || echo OPEN)" '{state: $s}' > "$STATE/s.json"
        jqout "$STATE/s.json"
        ;;
      state,headRefOid)
        head=$SHA
        if [ -f "$STATE/head_moved" ] || { [ -f "$STATE/updated" ] && [ ! -f "$STATE/head_stuck" ]; }; then head=ffffffffffffffffffffffffffffffffffffffff; fi
        jq -n --arg s "$(cat "$STATE/pr_state" 2> /dev/null || echo OPEN)" --arg h "$head" '{state: $s, headRefOid: $h}' > "$STATE/sh.json"
        jqout "$STATE/sh.json"
        ;;
      mergeCommit)
        echo '{"mergeCommit":{"oid":"cccccccccccccccccccccccccccccccccccccccc"}}' > "$STATE/mc.json"
        jqout "$STATE/mc.json"
        ;;
      *) unhandled ;;
    esac
    ;;
  'pr comment')
    body=$(cat "$(opt --body-file "$@")")
    id=$(( 1000 + $(jq length "$STATE/comments.json") ))
    jq --arg b "$body" --argjson id "$id" '. + [{id: $id, user: {login: "github-actions[bot]"}, body: $b}]' \
      "$STATE/comments.json" > "$STATE/c.tmp" && mv "$STATE/c.tmp" "$STATE/comments.json"
    ;;
  'pr edit')
    if a=$(opt --add-assignee "$@"); then echo "$a" >> "$STATE/assignees"; fi
    if l=$(opt --add-label "$@"); then echo "$l" >> "$STATE/labels"; fi
    if l=$(opt --remove-label "$@"); then echo "removed $l" >> "$STATE/labels"; fi
    ;;
  'pr merge')
    if [ -f "$STATE/merge_fails" ]; then echo 'stub gh: merge refused' >&2; exit 1; fi
    opt --match-head-commit "$@" > "$STATE/merged"
    ;;
  'run rerun')
    if [ -f "$STATE/rerun_fails" ]; then echo 'stub gh: rerun refused' >&2; exit 1; fi
    ;;
  'run view')
    if printf '%s\n' "$@" | grep -qx -- --log-failed; then cat "$STATE/failed.log"; else jqout "$STATE/jobs.json"; fi
    ;;
  'run list')
    if [ "$(opt --event "$@")" = workflow_dispatch ]; then
      # CI's dispatched runs on main: the one started after a merge that ships, when a
      # scenario gives it.
      [ -f "$STATE/dispatched.json" ] || echo '[]' > "$STATE/dispatched.json"
      jqout "$STATE/dispatched.json"
    elif c=$(opt --commit "$@"); then
      # CI's runs on a commit: this one alone unless a scenario says otherwise.
      [ "$c" = "$SHA" ] || { echo "stub gh: run list for another commit $c" >&2; exit 98; }
      [ -f "$STATE/commit_runs.json" ] || jq -n --argjson id "$RUN_ID" '[{databaseId: $id, conclusion: "failure"}]' > "$STATE/commit_runs.json"
      jqout "$STATE/commit_runs.json"
    else
      echo '[{"conclusion":"success","url":"https://github.com/me/fs/actions/runs/77"}]' > "$STATE/mainrun.json"
      jqout "$STATE/mainrun.json"
    fi
    ;;
  'run download')
    d=$(opt --dir "$@"); mkdir -p "$d"
    if [ ! -f "$STATE/new.zip" ]; then echo 'stub gh: no artifact' >&2; exit 1; fi
    cp "$STATE/new.zip" "$d/firefox-github-1.3.82.40.zip"
    ;;
  'release view')
    [ -f "$STATE/tag" ] || { echo 'release not found' >&2; exit 1; }
    cat "$STATE/tag"
    ;;
  'release download')
    d=$(opt --dir "$@"); mkdir -p "$d"
    cp "$STATE/old.zip" "$d/firefox-github-1.3.82.40.zip"
    ;;
  'label create') ;;
  'workflow run')
    if [ -f "$STATE/dispatch_fails" ]; then echo 'stub gh: dispatch refused' >&2; exit 1; fi
    ;;
  *)
    [ "$1" = api ] || unhandled
    shift
    method=GET
    if [ "$1" = -X ]; then method=$2; shift 2; fi
    if [ "$1" = -H ]; then shift 2; fi
    [ "$1" = --paginate ] && shift
    path=$1
    case "$method $path" in
      "GET repos/me/fs/issues/"*/comments) jqout "$STATE/comments.json" ;;
      "PATCH repos/me/fs/issues/comments/"*)
        id=${path##*/}
        f=$(opt -F "${ORIG[@]}"); f=${f#body=@}
        jq --arg b "$(cat "$f")" --argjson id "$id" 'map(if .id == $id then .body = $b else . end)' \
          "$STATE/comments.json" > "$STATE/c.tmp" && mv "$STATE/c.tmp" "$STATE/comments.json"
        echo '{}'
        ;;
      "GET repos/me/fs/commits/"*/check-runs*)
        n=$(cat "$STATE/review_calls" 2> /dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STATE/review_calls"
        if [ "$n" -le "$(cat "$STATE/review_errors" 2> /dev/null || echo 0)" ]; then
          echo 'stub gh: HTTP 502' >&2; exit 1
        elif [ "$n" -le "$(cat "$STATE/review_pending" 2> /dev/null || echo 0)" ]; then
          # checkruns.early.json: the runs until then, when not one run still going.
          cat "$STATE/checkruns.early.json" 2> /dev/null > "$STATE/cr.json" ||
            echo '{"check_runs":[{"conclusion":null}]}' > "$STATE/cr.json"
        else
          cp "$STATE/checkruns.json" "$STATE/cr.json"
        fi
        jqout "$STATE/cr.json"
        ;;
      "GET repos/me/fs/commits/cccccccccccccccccccccccccccccccccccccccc")
        jq -n --arg p "$(cat "$STATE/merge_parent" 2> /dev/null || echo 1111111111111111111111111111111111111111)" '{parents: [{sha: $p}]}' > "$STATE/commit.json"
        jqout "$STATE/commit.json"
        ;;
      "GET repos/me/fs/contents/package.json?ref=main"|"GET repos/me/fs/contents/package.json?ref=1111111111111111111111111111111111111111")
        cat "$STATE/main-package.json"
        ;;
      "GET repos/me/fs/contents/package.json?ref=$SHA")
        if [ -f "$STATE/head-package.json" ]; then
          cat "$STATE/head-package.json"
        else
          jq --arg v "${BRANCH#toolchain/pnpm-}" '.packageManager = "pnpm@\($v)"' "$STATE/main-package.json"
        fi
        ;;
      "GET repos/me/fs/contents/pnpm-lock.yaml?ref="*)
        # The merge base's lockfile, or the pull request's (lock.head, when a scenario
        # gives one; the same as the base's otherwise).
        ref=${path##*ref=}
        if [ -f "$STATE/lock_unreadable_$ref" ]; then echo 'stub gh: HTTP 404' >&2; exit 1; fi
        if [ "$ref" = "$SHA" ] && [ -f "$STATE/lock.head" ]; then cat "$STATE/lock.head"; else cat "$STATE/lock.base"; fi
        ;;
      "GET repos/me/fs/compare/"*) jq -n --argjson a "$(cat "$STATE/behind")" '{ahead_by: $a, merge_base_commit: {sha: "1111111111111111111111111111111111111111"}}' > "$STATE/cmp.json"; jqout "$STATE/cmp.json" ;;
      "DELETE repos/me/fs/git/refs/heads/"*) : > "$STATE/branch_deleted" ;;
      "PUT repos/me/fs/pulls/"*/update-branch)
        if [ -f "$STATE/update_fails" ]; then echo 'stub gh: expected_head_sha does not match' >&2; exit 1; fi
        : > "$STATE/updated"; echo '{}'
        ;;
      *) unhandled ;;
    esac
    ;;
esac
GHSTUB
  cat > "$BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  # curl -fsSL ... https://registry.npmjs.org/<name, / as %2F>: the package's document from
  # $STATE/registry/<that name>.json; a 404 (curl -f fails) for one not there.
  cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
url=${!#}
printf '%s\n' "$url" >> "$STATE/curl.log"
case $url in
  https://registry.npmjs.org/*) f=$STATE/registry/${url#https://registry.npmjs.org/}.json ;;
  *) echo "stub curl: unhandled: $*" >&2; exit 99 ;;
esac
[ -f "$f" ] || { echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22; }
cat "$f"
EOF
  cat > "$BIN/unzip" <<'EOF'
#!/usr/bin/env bash
# unzip -q <zip> -d <dir>
zip=$2 dir=$4
exec python3 -m zipfile -e "$zip" "$dir"
EOF
  chmod +x "$BIN/gh" "$BIN/sleep" "$BIN/unzip" "$BIN/curl"
}

# --- Fixtures.
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
dep_meta='---
updated-dependencies:
- dependency-name: eslint
  dependency-version: 10.12.0
  dependency-type: direct:development
  update-type: version-update:semver-minor
  dependency-group: tooling-minor-and-patch
...'

pr() { # <author> [draft] [labels json]
  jq -n --arg sha "$sha" --arg author "$1" --argjson draft "${2:-false}" --argjson labels "${3:-[]}" \
    '[{number: 42, headRefOid: $sha, baseRefName: "main", author: {login: $author}, title: "build(deps-dev): bump eslint", isDraft: $draft, labels: $labels}]' \
    > "$STATE/prs.json"
}
prview() { # <files json> <commits json>
  jq -n --argjson files "$1" --argjson commits "$2" '{files: [$files[] | {path: .}], commits: $commits}' > "$STATE/prview.json"
}
commit() { # <login> <headline> [body]
  jq -cn --arg l "$1" --arg h "$2" --arg b "${3-}" --arg oid "$(printf '%s' "$1$2" | sha1sum | cut -c1-40)" \
    '{oid: $oid, authors: [{login: $l}], messageHeadline: $h, messageBody: $b}'
}
# The merge base's pnpm-lock.yaml; a pull request's is the same unless lock_adds makes one.
lock_base() {
  cat > "$STATE/lock.base" <<'EOF'
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      eslint:
        specifier: ^10.11.0
        version: 10.11.0

packages:

  '@eslint/js@10.11.0':
    resolution: {integrity: sha512-x}

  eslint@10.11.0:
    resolution: {integrity: sha512-x}

snapshots:

  '@eslint/js@10.11.0': {}

  eslint@10.11.0:
    dependencies:
      '@eslint/js': 10.11.0
EOF
}
lock_adds() { # <key>...: the pull request's lockfile: the base's, with these package keys added
  awk -v extra="$*" '{print} /^packages:/ {n = split(extra, e, " "); for (i = 1; i <= n; i++) printf "\n  %s:\n    resolution: {integrity: sha512-x}\n", e[i]}' \
    "$STATE/lock.base" > "$STATE/lock.head"
}
published() { # <name> <version> <ISO time>: when the npm registry says that version came out
  local f="$STATE/registry/${1/\//%2F}.json"
  mkdir -p "$STATE/registry"
  [ -f "$f" ] || echo '{"time":{}}' > "$f"
  jq --arg v "$2" --arg t "$3" '.time[$v] = $t' "$f" > "$f.new" && mv "$f.new" "$f"
}
days_ago() { date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%S.000Z; }
hours_ago() { date -u -d "$1 hours ago" +%Y-%m-%dT%H:%M:%S.000Z; }

bundle() { # <dir name> <version> <player.js content>: a firefox-github zip
  local d=$STATE/$1
  mkdir -p "$d"
  printf '{"name":"FastStream","version":"%s","manifest_version":3}\n' "$2" > "$d/manifest.json"
  printf '%s\n' "$3" > "$d/player.js"
  (cd "$d" && python3 -m zipfile -c "$STATE/$1.zip" manifest.json player.js)
}

setup() {
  scenario=${FUNCNAME[1]}
  T=$(mktemp -d)
  TDIRS+=("$T")
  STATE=$T/state
  BIN=$T/bin
  mkdir -p "$STATE" "$BIN" "$T/tmp"
  export STATE
  export PATH="$BIN:$PATH"
  export RUNNER_TEMP="$T/tmp"
  export GH_TOKEN=x GH_REPO=me/fs OWNER=nawid
  export GITHUB_OUTPUT=$T/output GITHUB_SERVER_URL=https://github.com
  : > "$T/output"
  export SELF_URL='https://github.com/me/fs/actions/runs/9000'
  export RUN_ID=555 RUN_ATTEMPT=1 RUN_URL='https://github.com/me/fs/actions/runs/555'
  export CONCLUSION=success
  export BRANCH='dependabot/npm_and_yarn/tooling-minor-and-patch-0123abcd'
  export SHA=$sha
  write_stubs
  : > "$STATE/gh.log"
  echo '[]' > "$STATE/comments.json"
  echo MERGEABLE > "$STATE/mergeable"
  echo 0 > "$STATE/behind"
  echo v1.3.82.40 > "$STATE/tag"
  echo '{"check_runs":[{"conclusion":"success"}]}' > "$STATE/checkruns.json"
  echo '{"name":"faststream","packageManager":"pnpm@11.22.0"}' > "$STATE/main-package.json"
  lock_base
  : > "$STATE/curl.log"
  bundle old 1.3.82.40 'play()'
  bundle new 1.3.82.40 'play()'
  pr app/dependabot
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'dependabot[bot]' 'build(deps-dev): bump eslint' "$dep_meta")]"
  printf 'Lint, test and build\tUnit tests\n' > "$STATE/failed.tsv.want"
  jq -n '{jobs: [
      {name: "Lint workflows", conclusion: "success", steps: [{name: "actionlint", conclusion: "success"}]},
      {name: "Lint, test and build", conclusion: "failure", steps: [{name: "ESLint", conclusion: "success"}, {name: "Unit tests", conclusion: "failure"}, {name: "Build all targets", conclusion: "skipped"}]},
      {name: "e2e (Windows)", conclusion: "success", steps: []}]}' > "$STATE/jobs.json"
  printf 'Lint, test and build\tUnit tests\t\xef\xbb\xbf2026-09-29T10:00:00.0000000Z ##[group]Run pnpm test\nLint, test and build\tUnit tests\t2026-09-29T10:00:01.0000000Z \x1b[31mFAIL\x1b[0m tests/unit/x.test.mjs > it breaks\nLint, test and build\tUnit tests\t2026-09-29T10:00:02.0000000Z ##[error]Process completed with exit code 1.\n' > "$STATE/failed.log"
  printf '\n=== %s ===\n' "$scenario"
}

# --- Scenarios.

no_pr() {
  setup
  jq '.[0].headRefOid = "bbbb"' "$STATE/prs.json" > "$STATE/p" && mv "$STATE/p" "$STATE/prs.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'no mutations' test "$(n_mut)" -eq 0
}

other_branch_name() {
  # The job's condition keeps such a branch out; the step on its own still never merges it.
  setup
  export BRANCH='feature/x'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says so' grep -qF 'not one this workflow merges' <(last_comment)
}

red_first() {
  setup
  export CONCLUSION=failure
  run_step
  check 'exit 0' test "$rc" -eq 0
  check "looks for earlier runs on this commit" has_call "run list --workflow ci.yml --commit $sha"
  check 'starts CI once more on the branch' has_call "workflow run ci.yml --ref $BRANCH"
  check 'no re-run (its end would reach no workflow)' bash -c '! grep -q "run rerun" "$0"' "$STATE/gh.log"
  check 'no comment yet' test "$(comments_n)" -eq 0
  check 'only the new run' test "$(n_mut)" -eq 1
}

red_dispatch_refused() {
  setup
  export CONCLUSION=failure
  : > "$STATE/dispatch_fails"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'one comment' test "$(comments_n)" -eq 1
  check 'says CI fails, without the second try' grep -qF 'CI fails on this pull request (failure)' <(last_comment)
}

red_earlier_failed() {
  # The second try: the first run on this commit failed.
  setup
  export CONCLUSION=failure RUN_ID=556
  echo '[{"databaseId":556,"conclusion":"failure"},{"databaseId":555,"conclusion":"failure"}]' > "$STATE/commit_runs.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'no third run' bash -c '! grep -q "workflow run" "$0"' "$STATE/gh.log"
  check 'one comment' test "$(comments_n)" -eq 1
  check 'says it failed again' grep -qF 'It failed twice on this commit, so a flaky test is an unlikely cause.' <(last_comment)
  check 'labelled ci-failed' grep -qx 'ci-failed' "$STATE/labels"
}

red_earlier_timed_out() {
  setup
  export CONCLUSION=failure RUN_ID=556
  echo '[{"databaseId":556,"conclusion":"failure"},{"databaseId":555,"conclusion":"timed_out"}]' > "$STATE/commit_runs.json"
  run_step
  check 'no third run' bash -c '! grep -q "workflow run" "$0"' "$STATE/gh.log"
  check 'says it failed twice' grep -qF 'failed twice' <(last_comment)
}

red_earlier_not_failed() {
  # Earlier runs on the commit that were cancelled, passed or still run are no first try.
  setup
  export CONCLUSION=failure RUN_ID=556
  echo '[{"databaseId":557,"conclusion":""},{"databaseId":556,"conclusion":"failure"},{"databaseId":555,"conclusion":"cancelled"},{"databaseId":554,"conclusion":"success"},{"databaseId":553,"conclusion":"skipped"}]' > "$STATE/commit_runs.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'starts CI once more' has_call "workflow run ci.yml --ref $BRANCH"
  check 'no comment yet' test "$(comments_n)" -eq 0
}

red_second() {
  setup
  export CONCLUSION=failure RUN_ATTEMPT=2
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'a run run again by hand gets no third try' bash -c '! grep -qE "run rerun|workflow run" "$0"' "$STATE/gh.log"
  check 'one comment' test "$(comments_n)" -eq 1
  check '@mentions the owner' grep -qF '@nawid CI fails' <(last_comment)
  check 'says the rerun failed too' grep -qF 'failed twice' <(last_comment)
  check 'table row: job, step, meaning' grep -qF '| Lint, test and build | Unit tests | the unit tests (Vitest) |' <(last_comment)
  check 'a job that passed is not listed' bash -c '! grep -qF "| Lint workflows |" <<< "$0"' "$(last_comment)"
  check 'log excerpt, colour codes out' grep -qF 'FAIL tests/unit/x.test.mjs > it breaks' <(last_comment)
  check 'no timestamp in the excerpt' bash -c '! grep -qF "2026-09-29T" <<< "$0"' "$(last_comment)"
  check 'no job/step prefix in the excerpt' bash -c '! grep -qP "^Lint, test and build\t" <<< "$0"' "$(last_comment)"
  check "names main's CI" grep -qF 'main, the latest push: success: https://github.com/me/fs/actions/runs/77' <(last_comment)
  check 'carries a red key' grep -qE '<!-- update-prs: red [0-9a-f]{12} -->' <(last_comment)
  check 'labelled ci-failed' grep -qx 'ci-failed' "$STATE/labels"
  check 'assigned to the owner' grep -qx 'nawid' "$STATE/assignees"
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'Dependabot hint' grep -qF '@dependabot ignore' <(last_comment)
}

red_same_again() {
  setup
  export CONCLUSION=failure RUN_ATTEMPT=2
  run_step
  first=$(last_comment)
  : > "$STATE/gh.log"
  export RUN_URL='https://github.com/me/fs/actions/runs/556'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'still one comment' test "$(comments_n)" -eq 1
  check 'edited in place' has_call 'api -X PATCH repos/me/fs/issues/comments/1000'
  check 'the first comment named the first run' grep -qF 'runs/555' <<< "$first"
  check 'the edit carries the new run' grep -qF 'runs/556' <(last_comment)
  check 'no pr comment call' test "$(grep -c '^pr comment' "$STATE/gh.log")" -eq 0
}

red_different() {
  setup
  export CONCLUSION=failure RUN_ATTEMPT=2
  run_step
  jq '.jobs[1].steps[1].name = "Type check"' "$STATE/jobs.json" > "$STATE/j" && mv "$STATE/j" "$STATE/jobs.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'a second comment' test "$(comments_n)" -eq 2
  check 'names the new step' grep -qF '| Type check |' <(last_comment)
}

cancelled() {
  setup
  export CONCLUSION=cancelled
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'no mutations' test "$(n_mut)" -eq 0
}

timed_out() {
  setup
  export CONCLUSION=timed_out RUN_ATTEMPT=1
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'a second try first' has_call "workflow run ci.yml --ref $BRANCH"
  check 'no comment yet' test "$(comments_n)" -eq 0
}

green_merge() {
  setup
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'merged at the tested commit' test "$(cat "$STATE/merged" 2> /dev/null)" = "$sha"
  # Only the review's own check run: without the name, CI's green run would pass for it.
  check 'asks for the review check by name' has_call 'check-runs?check_name=Review%20dependency%20changes'
  check 'squash' has_call "pr merge 42 --squash --match-head-commit $sha"
  check 'a merged comment' grep -qF '<!-- update-prs: merged -->' <(last_comment)
  check 'no @mention when merged' bash -c '! grep -qF "@nawid" <<< "$0"' "$(last_comment)"
  check 'not assigned' test ! -s "$STATE/assignees"
  check 'no branch update' bash -c '! grep -q update-branch "$0"' "$STATE/gh.log"
  check 'branch deleted' has_call "api -X DELETE repos/me/fs/git/refs/heads/$BRANCH"
  check 'starts no CI on main' bash -c '! grep -qF "workflow run ci.yml --ref main" "$0"' "$STATE/gh.log"
  check 'nothing for watch-main' test ! -s "$T/output"
}

green_version_only() {
  setup
  bundle new 1.3.82.41 'play()'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'merged: only the version differs' merged
}

green_ships() {
  setup
  bundle new 1.3.82.40 'play(); pwn()'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says it changes what ships' grep -qF 'changes what the extension ships' <(last_comment)
  check '@mentions and assigns' grep -qF '@nawid CI passes' <(last_comment)
  check 'assigned' grep -qx nawid "$STATE/assignees"
  check 'green key' grep -qF '<!-- update-prs: green -->' <(last_comment)
}

green_manifest_other_field() {
  setup
  printf '{"name":"FastStream","version":"1.3.82.40","manifest_version":3,"permissions":["<all_urls>"]}\n' > "$STATE/new/manifest.json"
  (cd "$STATE/new" && rm -f "$STATE/new.zip" && python3 -m zipfile -c "$STATE/new.zip" manifest.json player.js)
  run_step
  check 'not merged: a manifest field besides version differs' bash -c '! test -f "$0/merged"' "$STATE"
}

green_extra_file() {
  setup
  (cd "$STATE/new" && printf 'x\n' > extra.js && rm -f "$STATE/new.zip" && python3 -m zipfile -c "$STATE/new.zip" manifest.json player.js extra.js)
  run_step
  check 'not merged: a file was added' bash -c '! test -f "$0/merged"' "$STATE"
}

green_no_release() {
  setup
  rm "$STATE/tag"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says it could not compare' grep -qF 'could not be compared' <(last_comment)
}

green_no_artifact() {
  setup
  rm "$STATE/new.zip"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says it could not compare' grep -qF 'could not be compared' <(last_comment)
}

green_major() {
  setup
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'dependabot[bot]' 'bump eslint' "${dep_meta/semver-minor/semver-major}")]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says major' grep -qF 'major version' <(last_comment)
}

green_other_file() {
  setup
  prview '["package.json","pnpm-lock.yaml",".github/workflows/ci.yml"]' "[$(commit 'dependabot[bot]' 'bump' "$dep_meta")]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'names the file' grep -qF '.github/workflows/ci.yml' <(last_comment)
  check 'no artifact downloaded' bash -c '! grep -q "run download" "$0"' "$STATE/gh.log"
}

green_foreign_commit() {
  setup
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'dependabot[bot]' 'bump' "$dep_meta"), $(commit 'Nawid3333' 'fix the lint')]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says someone else committed' grep -qF 'commits from someone else' <(last_comment)
}

green_actions_merge_commit_is_not_a_merge_of_main() {
  setup
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'dependabot[bot]' 'bump' "$dep_meta"), $(commit 'github-actions[bot]' 'sneak in a change')]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
}

green_with_update_merges() {
  setup
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'dependabot[bot]' 'bump' "$dep_meta"), $(commit 'github-actions[bot]' "Merge branch 'main' into $BRANCH")]"
  run_step
  check 'merged' merged
}

green_wrong_author() {
  setup
  pr Nawid3333
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says who opened it' grep -qF 'Nawid3333 opened it' <(last_comment)
}

green_draft() {
  setup
  pr app/dependabot true
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says draft' grep -qF 'draft' <(last_comment)
}

green_review_failed() {
  setup
  echo '{"check_runs":[{"conclusion":"failure"}]}' > "$STATE/checkruns.json"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says the review' grep -qF 'dependency review is failure' <(last_comment)
}

green_review_missing() {
  setup
  echo '{"check_runs":[]}' > "$STATE/checkruns.json"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says missing' grep -qF 'dependency review is missing' <(last_comment)
}

green_review_pending_then_success() {
  setup
  echo 3 > "$STATE/review_pending"
  run_step
  check 'merged after the review finished' merged
  check 'asked four times' test "$(cat "$STATE/review_calls")" -eq 4
}

green_review_rerun_success() {
  setup
  echo '{"check_runs":[{"conclusion":"failure"},{"conclusion":"success"}]}' > "$STATE/checkruns.json"
  run_step
  check 'merged: one review passed' merged
}

green_review_unreadable_then_success() {
  setup
  echo 2 > "$STATE/review_errors"
  run_step
  check 'merged once the review could be read' merged
  check 'asked three times' test "$(cat "$STATE/review_calls")" -eq 3
}

green_review_no_dependabot_commit() {
  setup
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'Nawid3333' 'bump by hand' "$dep_meta")]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says missing' grep -qF "Dependabot's dependency review is missing" <(last_comment)
  check 'asks about no commit' bash -c '! grep -qF check-runs "$0"' "$STATE/gh.log"
}

green_conflict() {
  setup
  echo CONFLICTING > "$STATE/mergeable"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says conflict' grep -qF 'conflicts with main' <(last_comment)
}

green_mergeable_unknown_then_ok() {
  setup
  echo 2 > "$STATE/mergeable_unknown"
  run_step
  check 'merged once GitHub knew' merged
}

green_behind() {
  setup
  echo 2 > "$STATE/behind"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'updates the branch at the tested commit' has_call "api -X PUT repos/me/fs/pulls/42/update-branch -f expected_head_sha=$sha"
  check 'starts CI on the branch' has_call "workflow run ci.yml --ref $BRANCH"
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'no comment' test "$(comments_n)" -eq 0
}

green_behind_stuck() {
  setup
  echo 2 > "$STATE/behind"
  : > "$STATE/head_stuck"
  run_step
  check 'fails (the failure step reports it)' test "$rc" -ne 0
  check 'no CI started' bash -c '! grep -q "workflow run" "$0"' "$STATE/gh.log"
}

green_behind_three_times() {
  setup
  echo 1 > "$STATE/behind"
  m="Merge branch 'main' into $BRANCH"
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'dependabot[bot]' 'bump' "$dep_meta"), $(commit 'github-actions[bot]' "$m"), $(commit 'github-actions[bot]' "$m x"), $(commit 'github-actions[bot]' "$m y")]"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'no fourth update' bash -c '! grep -q update-branch "$0"' "$STATE/gh.log"
  check 'waits for the owner' grep -qF 'main moved on 3 times' <(last_comment)
}

green_behind_main_shipped() {
  # Behind main, which shipped since: the branch's build lacks main's change, which the
  # latest release has, and that must not count as the update's own (#95, 2026-09-30).
  setup
  echo 2 > "$STATE/behind"
  bundle old 1.3.82.40 'play(); fromMain()'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not called a change to what ships' bash -c '! grep -qF "changes what the extension ships" "$0"' "$STATE/comments.json"
  check 'no comment' test "$(comments_n)" -eq 0
  check 'updates the branch at the tested commit' has_call "api -X PUT repos/me/fs/pulls/42/update-branch -f expected_head_sha=$sha"
  check 'starts CI on the branch' has_call "workflow run ci.yml --ref $BRANCH"
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
}

green_again_same() {
  setup
  bundle new 1.3.82.40 'changed()'
  run_step
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'one comment, edited' test "$(comments_n)" -eq 1
  check 'edited' has_call 'api -X PATCH repos/me/fs/issues/comments/1000'
}

red_then_green() {
  setup
  bundle new 1.3.82.40 'changed()'
  export CONCLUSION=failure RUN_ATTEMPT=2
  run_step
  pr app/dependabot false '[{"name":"ci-failed"}]'
  export CONCLUSION=success
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'a second comment for the new verdict' test "$(comments_n)" -eq 2
  check 'label removed' grep -qx 'removed ci-failed' "$STATE/labels"
}

green_label_removed_then_merged() {
  setup
  pr app/dependabot false '[{"name":"ci-failed"}]'
  run_step
  check 'label removed' grep -qx 'removed ci-failed' "$STATE/labels"
  check 'merged' merged
}

pnpm_same_major() {
  setup
  export BRANCH='toolchain/pnpm-11.27.1'
  pr app/github-actions
  prview '["package.json"]' "[$(commit 'github-actions[bot]' 'build: pnpm 11.22.0 -> 11.27.1')]"
  echo '{"check_runs":[]}' > "$STATE/checkruns.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'merged' merged
  check 'no dependency review asked' bash -c '! grep -q check-runs "$0"' "$STATE/gh.log"
  check "main's pnpm read, as the raw file" has_call 'api -H Accept: application/vnd.github.raw repos/me/fs/contents/package.json?ref=main'
  check 'package.json read at the merge base, raw' has_call 'api -H Accept: application/vnd.github.raw repos/me/fs/contents/package.json?ref=1111111111111111111111111111111111111111'
  check "and the pull request's, raw" has_call "api -H Accept: application/vnd.github.raw repos/me/fs/contents/package.json?ref=$sha"
  check 'no lockfile read: that check is for Dependabot pull requests' bash -c '! grep -q pnpm-lock.yaml "$0"' "$STATE/gh.log"
}

pnpm_package_json_more() {
  # A dependency added beside packageManager: not routine.
  setup
  export BRANCH='toolchain/pnpm-11.27.1'
  pr app/github-actions
  prview '["package.json"]' "[$(commit 'github-actions[bot]' 'build: pnpm 11.22.0 -> 11.27.1')]"
  jq '.packageManager = "pnpm@11.27.1" | .devDependencies = {"evil": "1.0.0"}' "$STATE/main-package.json" > "$STATE/head-package.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says so' grep -qF 'its package.json changes more than packageManager to pnpm@11.27.1' <(last_comment)
}

pnpm_package_manager_mismatch() {
  # The branch name and the change disagree.
  setup
  export BRANCH='toolchain/pnpm-11.27.1'
  pr app/github-actions
  prview '["package.json"]' "[$(commit 'github-actions[bot]' 'build: pnpm 11.22.0 -> 11.27.1')]"
  jq '.packageManager = "pnpm@11.99.0"' "$STATE/main-package.json" > "$STATE/head-package.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says so' grep -qF 'changes more than packageManager' <(last_comment)
}

pnpm_lockfile_changed() {
  setup
  export BRANCH='toolchain/pnpm-11.27.1'
  pr app/github-actions
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'github-actions[bot]' 'build: pnpm 11.22.0 -> 11.27.1')]"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says so' grep -qF 'it changes pnpm-lock.yaml' <(last_comment)
}

pnpm_major() {
  setup
  export BRANCH='toolchain/pnpm-12.6.0'
  pr app/github-actions
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'github-actions[bot]' 'build: pnpm 11.22.0 -> 12.6.0')]"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says another major' grep -qF 'pnpm 12.6.0 is another major' <(last_comment)
}

pnpm_by_dependabot_author() {
  setup
  export BRANCH='toolchain/pnpm-11.27.1'
  pr app/dependabot
  prview '["package.json"]' "[$(commit 'github-actions[bot]' 'build: pnpm')]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
}

node_waits() {
  setup
  export BRANCH='toolchain/node-26'
  pr app/github-actions
  prview '[".nvmrc"]' "[$(commit 'github-actions[bot]' 'build: Node.js 22 -> 26')]"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says Node is a decision' grep -qF 'new Node.js major is your decision' <(last_comment)
  check '@mentions' grep -qF '@nawid CI passes' <(last_comment)
  check 'assigned' grep -qx nawid "$STATE/assignees"
  check 'skip hint' grep -qF 'skips this version for good' <(last_comment)
}

docker_waits() {
  setup
  export BRANCH='dependabot/docker/actionlint-1234'
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says the check image' grep -qF 'it changes the image of a check every workflow file has to pass (actionlint or zizmor), which a person reviews' <(last_comment)
}

upstream_green() {
  # Reviewed and green: still the owner's to take.
  setup
  export BRANCH='sync/upstream'
  pr app/github-actions
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says why' grep -qF "taking upstream's commits is your decision" <(last_comment)
  check 'assigned' grep -qx nawid "$STATE/assignees"
}

other_base() {
  setup
  jq '.[0].baseRefName = "release"' "$STATE/prs.json" > "$STATE/p.json" && mv "$STATE/p.json" "$STATE/prs.json"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says why' grep -qF 'it does not target main' <(last_comment)
}

actions_waits() {
  setup
  export BRANCH='dependabot/github_actions/actions-minor-and-patch-1234'
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says workflow files' grep -qF 'workflow files' <(last_comment)
}

patched_waits() {
  setup
  export BRANCH='patched/hls.js-1.7.4'
  pr app/github-actions
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says main has no such library' grep -qF "patched/hls.js-1.7.4 names no library of main's package.json" <(last_comment)
}

# --- Updates that ship (D1): Dependabot's shipped group, and patched libraries, minor and
# patch. They merge on green CI, with no build comparison (they are meant to change the
# build), and CI is then started on main; watch-main follows that run.
patched_setup() { # <branch version> [main's version]: a clean patch re-cut of hls.js
  setup
  scenario=${FUNCNAME[1]}
  export BRANCH="patched/hls.js-$1"
  printf '{"name":"faststream","packageManager":"pnpm@11.22.0","devDependencies":{"hls.js":"%s","mp4box":"2.4.1"}}\n' "${2:-1.7.3}" \
    > "$STATE/main-package.json"
  pr app/github-actions
  prview "[\"package.json\",\"pnpm-lock.yaml\",\"pnpm-workspace.yaml\",\"patches/hls.js@$1.patch\",\"tools/sync-vendor.mjs\"]" \
    "[$(commit 'github-actions[bot]' "deps: hls.js 1.7.3 -> $1, patch re-cut by tools/recut-patch.mjs")]"
  bundle new 1.3.82.40 'play(); hls174()'
  jq -n '[{databaseId: 777, headSha: "cccccccccccccccccccccccccccccccccccccccc"}]' > "$STATE/dispatched.json"
}

patched_patch_merges() {
  patched_setup 1.7.4
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'merged at the tested commit' test "$(cat "$STATE/merged" 2> /dev/null)" = "$sha"
  check 'no build comparison' bash -c '! grep -qF "release download" "$0"' "$STATE/gh.log"
  check 'starts CI on main' has_call 'workflow run ci.yml --ref main'
  check 'names the run on main' grep -qF 'https://github.com/me/fs/actions/runs/777' <(last_comment)
  check 'hands it to watch-main' grep -qx 'main-run-id=777' "$T/output"
  check 'with the pull request' grep -qx 'pr-number=42' "$T/output"
}

patched_minor_merges() {
  patched_setup 1.8.0
  run_step
  check 'merged' merged
}

patched_major_waits() {
  patched_setup 2.0.0
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says major' grep -qF 'hls.js 1.7.3 -> 2.0.0 is a major version' <(last_comment)
  check 'starts no CI on main' bash -c '! grep -qF "workflow run ci.yml --ref main" "$0"' "$STATE/gh.log"
}

patched_same_version_waits() {
  patched_setup 1.7.3
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says main has it' grep -qF 'main has hls.js 1.7.3 already' <(last_comment)
}

patched_unparseable_waits() {
  patched_setup 1.8 1.7.3
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says it cannot tell' grep -qF 'hls.js 1.7.3 -> 1.8 cannot be told apart' <(last_comment)
}

patched_range_on_main_waits() {
  patched_setup 1.7.4 '^1.7.3'
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says it cannot tell' grep -qF 'cannot be told apart as a minor or patch step' <(last_comment)
}

patched_extra_file_waits() {
  patched_setup 1.7.4
  prview '["package.json","pnpm-lock.yaml","patches/hls.js@1.7.4.patch","tests/e2e/specs/x.e2e.mjs"]' \
    "[$(commit 'github-actions[bot]' 'deps: hls.js 1.7.3 -> 1.7.4')]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'names the file' grep -qF 'it changes tests/e2e/specs/x.e2e.mjs, not only what a patch re-cut changes' <(last_comment)
}

patched_young_package_waits() {
  patched_setup 1.7.4
  lock_adds 'hls.js@1.7.4'
  published hls.js 1.7.4 "$(days_ago 2)"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'names it' grep -qF 'hls.js@1.7.4 (published' <(last_comment)
}

patched_foreign_commit_waits() {
  patched_setup 1.7.4
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'github-actions[bot]' 'deps: hls.js'),$(commit 'someone' 'tweak')]"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says someone else' grep -qF 'it has commits from someone else' <(last_comment)
}

shipped_setup() {
  setup
  scenario=${FUNCNAME[1]}
  export BRANCH='dependabot/npm_and_yarn/shipped-minor-and-patch-0123abcd'
  prview '["package.json","pnpm-lock.yaml"]' "[$(commit 'dependabot[bot]' 'build(deps): bump mediabunny' "${1:-$dep_meta}")]"
  bundle new 1.3.82.40 'play(); mediabunny161()'
  jq -n '[{databaseId: 777, headSha: "cccccccccccccccccccccccccccccccccccccccc"}]' > "$STATE/dispatched.json"
}

shipped_merges() {
  shipped_setup
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'merged, though the build differs' merged
  check 'no build comparison' bash -c '! grep -qF "release download" "$0"' "$STATE/gh.log"
  check 'starts CI on main' has_call 'workflow run ci.yml --ref main'
  check 'says a green run releases' grep -qF 'A green run there releases it' <(last_comment)
  check 'hands it to watch-main' grep -qx 'main-run-id=777' "$T/output"
}

shipped_major_waits() {
  shipped_setup "${dep_meta/semver-minor/semver-major}"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says major' grep -qF 'it holds a major version' <(last_comment)
  check 'starts no CI on main' bash -c '! grep -qF "workflow run ci.yml --ref main" "$0"' "$STATE/gh.log"
}

shipped_young_package_waits() {
  shipped_setup
  lock_adds 'mediabunny@1.61.0'
  published mediabunny 1.61.0 "$(hours_ago 5)"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'names it' grep -qF 'mediabunny@1.61.0 (published' <(last_comment)
}

shipped_main_run_not_found() {
  shipped_setup
  echo '[]' > "$STATE/dispatched.json"
  run_step
  check 'merged' merged
  check 'asks the owner to start CI on main' grep -qF '@nawid CI could not be started on main' <(last_comment)
  check 'nothing for watch-main' test ! -s "$T/output"
}

shipped_dispatch_refused() {
  shipped_setup
  : > "$STATE/dispatch_fails"
  run_step
  check 'merged' merged
  check 'asks the owner to start CI on main' grep -qF '@nawid CI could not be started on main' <(last_comment)
}

# A tooling update whose build differs still waits: only the shipped group ships.
# The owner's hold label stops a merge that everything else allows.
held_waits() {
  setup
  pr app/dependabot false '[{"name":"hold"}]'
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says hold' grep -qF 'it is labelled hold' <(last_comment)
}

tooling_that_ships_waits() {
  setup
  bundle new 1.3.82.40 'play(); pwn()'
  jq -n '[{databaseId: 777, headSha: "cccccccccccccccccccccccccccccccccccccccc"}]' > "$STATE/dispatched.json"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'starts no CI on main' bash -c '! grep -qF "workflow run ci.yml --ref main" "$0"' "$STATE/gh.log"
}

upstream_red() {
  setup
  export BRANCH='sync/upstream' CONCLUSION=failure RUN_ATTEMPT=2
  pr app/github-actions
  run_step
  check 'reported' grep -qF '@nawid CI fails' <(last_comment)
  check 'upstream hint' grep -qF 'sync-upstream.yml' <(last_comment)
}

# The sync and patched-library pull requests: sync-upstream.yml and patched-libraries.yml
# start the dependency review on the branch's head, which is the run's SHA.
patched_review_passed() {
  patched_setup 1.7.4
  run_step
  check 'merged' merged
  check "asked about the run's commit" has_call "repos/me/fs/commits/$sha/check-runs?check_name=Review%20dependency%20changes"
}

patched_review_failed() {
  patched_setup 1.7.4
  echo '{"check_runs":[{"conclusion":"failure"}]}' > "$STATE/checkruns.json"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says the review' grep -qF 'its dependency review ("Review dependency changes", started on this branch) is failure' <(last_comment)
}

upstream_review_missing() {
  setup
  export BRANCH='sync/upstream'
  pr app/github-actions
  echo '{"check_runs":[]}' > "$STATE/checkruns.json"
  run_step
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says missing' grep -qF 'its dependency review ("Review dependency changes", started on this branch) is missing' <(last_comment)
}

upstream_review_pending_then_failed() {
  setup
  export BRANCH='sync/upstream'
  pr app/github-actions
  echo 2 > "$STATE/review_pending"
  echo '{"check_runs":[{"conclusion":"failure"}]}' > "$STATE/checkruns.json"
  run_step
  check 'waited for it' test "$(cat "$STATE/review_calls")" -eq 3
  check 'says the review' grep -qF 'dependency review ("Review dependency changes", started on this branch) is failure' <(last_comment)
}

# Several runs of the review on one commit (run again): the newest decides, in whatever
# order the API lists them, and while it is still going it is waited for.
patched_review_newest_decides() {
  setup
  export BRANCH='patched/hls.js-1.7.4'
  pr app/github-actions
  echo '{"check_runs":[{"id":9,"conclusion":"failure"},{"id":12,"conclusion":"cancelled"},{"id":10,"conclusion":"failure"}]}' > "$STATE/checkruns.json"
  run_step
  check 'names the newest run' grep -qF 'started on this branch) is cancelled' <(last_comment)
}

upstream_review_rerun_pending_then_success() {
  setup
  export BRANCH='sync/upstream'
  pr app/github-actions
  echo 2 > "$STATE/review_pending"
  echo '{"check_runs":[{"id":9,"conclusion":"failure"},{"id":12,"conclusion":null}]}' > "$STATE/checkruns.early.json"
  echo '{"check_runs":[{"id":9,"conclusion":"failure"},{"id":12,"conclusion":"success"}]}' > "$STATE/checkruns.json"
  run_step
  check 'waited for the newer run' test "$(cat "$STATE/review_calls")" -eq 3
  check 'names no review' bash -c '! grep -qF "dependency review" <<< "$0"' "$(last_comment)"
}

upstream_review_unreadable() {
  setup
  export BRANCH='sync/upstream'
  pr app/github-actions
  echo 99 > "$STATE/review_errors"
  run_step
  check 'asked ten times' test "$(cat "$STATE/review_calls")" -eq 10
  check 'says unreadable' grep -qF 'started on this branch) is unreadable' <(last_comment)
}

toolchain_not_reviewed() {
  setup
  export BRANCH='toolchain/node-26'
  pr app/github-actions
  run_step
  check 'no review asked for' bash -c '! grep -qF check-runs "$0"' "$STATE/gh.log"
}

merge_refused() {
  setup
  : > "$STATE/merge_fails"
  run_step
  check 'fails (the failure step reports it)' test "$rc" -ne 0
  check 'no merged comment' test "$(comments_n)" -eq 0
}

merge_refused_pr_closed() {
  # Closed (replaced by a newer version, say) while this ran.
  setup
  : > "$STATE/merge_fails"
  echo CLOSED > "$STATE/pr_state"
  run_step
  check 'exit 0: no false alarm' test "$rc" -eq 0
  check 'no comment' test "$(comments_n)" -eq 0
}

closed_before_verdict() {
  setup
  bundle new 1.3.82.40 'changed()'
  echo CLOSED > "$STATE/pr_state"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'no comment on a closed pull request' test "$(comments_n)" -eq 0
  check 'not assigned' test ! -s "$STATE/assignees"
}
merge_refused_head_moved() {
  # Dependabot rebased the branch while this ran: the new commit's CI run decides.
  setup
  : > "$STATE/merge_fails"
  : > "$STATE/head_moved"
  run_step
  check 'exit 0: no false alarm' test "$rc" -eq 0
  check 'no comment' test "$(comments_n)" -eq 0
  check 'says why' grep -qF 'moved on to ffffffff' "$T/out"
}

update_refused_head_moved() {
  setup
  echo 2 > "$STATE/behind"
  : > "$STATE/update_fails"
  : > "$STATE/head_moved"
  run_step
  check 'exit 0: no false alarm' test "$rc" -eq 0
  check 'no CI started' bash -c '! grep -q "workflow run" "$0"' "$STATE/gh.log"
}

update_refused() {
  setup
  echo 2 > "$STATE/behind"
  : > "$STATE/update_fails"
  run_step
  check 'fails (the failure step reports it)' test "$rc" -ne 0
  check 'no CI started' bash -c '! grep -q "workflow run" "$0"' "$STATE/gh.log"
}

merged_onto_moved_main() {
  # Another merge landed between the check and this merge.
  setup
  echo 2222222222222222222222222222222222222222 > "$STATE/merge_parent"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'merged' merged
  check '@mentions the owner' grep -qF '@nawid main moved on between the last check (11111111) and the merge (onto 22222222)' <(last_comment)
  check 'its own key' grep -qF '<!-- update-prs: merged untested -->' <(last_comment)
}

merged_parent_unreadable() {
  setup
  echo '' > "$STATE/merge_parent"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'says it could not confirm' grep -qF 'could not be read to confirm' <(last_comment)
  check 'no alarm' bash -c '! grep -qF "@nawid" <<< "$0"' "$(last_comment)"
}

green_mergeable_stays_unknown() {
  setup
  echo 99 > "$STATE/mergeable_unknown"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'waits for the owner' grep -qF 'GitHub cannot say whether it merges (UNKNOWN)' <(last_comment)
}

compare_after_bundle() {
  # The behind-main check is the last call before the merge.
  setup
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'compare right before the merge' bash -c 'grep -E "^(api repos/me/fs/compare|pr merge|release download|run download)" "$0" | tail -n 2 | head -n 1 | grep -q "^api repos/me/fs/compare"' "$STATE/gh.log"
}

# --- Every package version a Dependabot pull request adds to pnpm-lock.yaml must be 7 days
# old on the npm registry (Dependabot's cooldown holds back only what it bumps).

lock_nothing_added() {
  setup
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'reads the merge base lockfile' has_call 'api -H Accept: application/vnd.github.raw repos/me/fs/contents/pnpm-lock.yaml?ref=1111111111111111111111111111111111111111'
  check "and the pull request's" has_call "api -H Accept: application/vnd.github.raw repos/me/fs/contents/pnpm-lock.yaml?ref=$sha"
  check 'asks the registry nothing' test ! -s "$STATE/curl.log"
  check 'merged' test "$(cat "$STATE/merged" 2> /dev/null)" = "$sha"
}

lock_old_packages() {
  setup
  lock_adds left-pad@1.3.0 "'@babel/core@7.0.0'"
  published left-pad 1.3.0 2018-04-09T00:00:00.000Z
  published @babel/core 7.0.0 "$(days_ago 8)"
  run_step
  check 'looks up the added package' grep -qx 'https://registry.npmjs.org/left-pad' "$STATE/curl.log"
  check 'and the scoped one, its / escaped' grep -qx 'https://registry.npmjs.org/@babel%2Fcore' "$STATE/curl.log"
  check 'nothing else' test "$(wc -l < "$STATE/curl.log")" -eq 2
  check 'merged' test "$(cat "$STATE/merged" 2> /dev/null)" = "$sha"
}

lock_young_package() {
  setup
  lock_adds left-pad@1.3.0 pnpm@11.28.2
  published left-pad 1.3.0 2018-04-09T00:00:00.000Z
  pub=$(days_ago 6)
  published pnpm 11.28.2 "$pub"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'names the young one and its date' grep -qF "pnpm@11.28.2 (published ${pub:0:10})" <(last_comment)
  check 'not the old one' bash -c '! grep -qF left-pad <<< "$0"' "$(last_comment)"
  check 'assigned' grep -qx nawid "$STATE/assignees"
}

lock_just_under_7_days() {
  setup
  lock_adds pnpm@11.28.2
  published pnpm 11.28.2 "$(hours_ago 167)"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'names it' grep -qF 'pnpm@11.28.2 (published' <(last_comment)
}

lock_just_over_7_days() {
  setup
  lock_adds pnpm@11.28.2
  published pnpm 11.28.2 "$(hours_ago 169)"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'merged' test "$(cat "$STATE/merged" 2> /dev/null)" = "$sha"
}

lock_changed_version() {
  # A bump replaces a key: only the new version is new.
  setup
  sed 's/eslint@10\.11\.0/eslint@10.12.0/' "$STATE/lock.base" > "$STATE/lock.head"
  published eslint 10.12.0 "$(days_ago 1)"
  run_step
  check 'looks up only eslint' test "$(cat "$STATE/curl.log")" = 'https://registry.npmjs.org/eslint'
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'names it' grep -qF 'eslint@10.12.0 (published' <(last_comment)
}

lock_unknown_age() {
  # A package the registry does not have, and a version it does not list.
  setup
  lock_adds no-such-pkg-fs-zz9@1.0.0 left-pad@9.9.9
  published left-pad 1.3.0 2018-04-09T00:00:00.000Z
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'the missing package, age unknown' grep -qF 'no-such-pkg-fs-zz9@1.0.0 (age unknown)' <(last_comment)
  check 'the missing version, age unknown' grep -qF 'left-pad@9.9.9 (age unknown)' <(last_comment)
}

lock_base_unreadable() {
  setup
  lock_adds left-pad@1.3.0
  : > "$STATE/lock_unreadable_1111111111111111111111111111111111111111"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says so' grep -qF 'its pnpm-lock.yaml could not be read' <(last_comment)
}

lock_head_unreadable() {
  setup
  : > "$STATE/lock_unreadable_$sha"
  run_step
  check 'exit 0' test "$rc" -eq 0
  check 'not merged' bash -c '! test -f "$0/merged"' "$STATE"
  check 'says so' grep -qF 'its pnpm-lock.yaml could not be read' <(last_comment)
}

no_pr
other_branch_name
red_first
red_dispatch_refused
red_earlier_failed
red_earlier_timed_out
red_earlier_not_failed
red_second
red_same_again
red_different
cancelled
timed_out
green_merge
green_version_only
green_ships
green_manifest_other_field
green_extra_file
green_no_release
green_no_artifact
green_major
green_other_file
green_foreign_commit
green_actions_merge_commit_is_not_a_merge_of_main
green_with_update_merges
green_wrong_author
green_draft
green_review_failed
green_review_missing
green_review_pending_then_success
green_review_rerun_success
green_review_unreadable_then_success
green_review_no_dependabot_commit
green_conflict
green_mergeable_unknown_then_ok
green_behind
green_behind_stuck
green_behind_three_times
green_behind_main_shipped
green_again_same
red_then_green
green_label_removed_then_merged
pnpm_same_major
pnpm_package_json_more
pnpm_package_manager_mismatch
pnpm_lockfile_changed
pnpm_major
pnpm_by_dependabot_author
node_waits
actions_waits
docker_waits
upstream_green
other_base
patched_waits
patched_patch_merges
patched_minor_merges
patched_major_waits
patched_same_version_waits
patched_unparseable_waits
patched_range_on_main_waits
patched_extra_file_waits
patched_young_package_waits
patched_foreign_commit_waits
shipped_merges
shipped_major_waits
shipped_young_package_waits
shipped_main_run_not_found
shipped_dispatch_refused
tooling_that_ships_waits
held_waits
upstream_red
patched_review_passed
patched_review_failed
upstream_review_missing
upstream_review_pending_then_failed
patched_review_newest_decides
upstream_review_rerun_pending_then_success
upstream_review_unreadable
toolchain_not_reviewed
merge_refused
merge_refused_head_moved
merge_refused_pr_closed
closed_before_verdict
update_refused_head_moved
update_refused
merged_onto_moved_main
merged_parent_unreadable
green_mergeable_stays_unknown
compare_after_bundle
lock_nothing_added
lock_old_packages
lock_young_package
lock_just_under_7_days
lock_just_over_7_days
lock_changed_version
lock_unknown_age
lock_base_unreadable
lock_head_unreadable

printf '%d checks, %d failed\n' "$checks" "$fails"
[ "$fails" -eq 0 ]
