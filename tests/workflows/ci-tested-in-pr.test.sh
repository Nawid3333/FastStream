#!/usr/bin/env bash
# ci.yml's "Was this tree tested green in its pull request?": on a push to main, skip=yes
# only when the pull request merged as this commit had a green run of CI, from the last
# MAX_AGE_HOURS, on a last commit with this commit's tree that main's previous commit is an
# ancestor of. Anything else, a failed look included, is skip=no and the step still passes:
# everything then runs as before.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script ci.yml 'Was this tree tested green in its pull request?' > "$here/decide.sh" || exit 1

SHA=1111111111111111111111111111111111111111
PARENT=2222222222222222222222222222222222222222
HEAD=3333333333333333333333333333333333333333

# gh: records its calls, answers `gh api <path> [--jq F]` from the fixture file for the
# path (with the real jq), and fails for the one FAILS names.
mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
if [ "$1" != api ]; then echo "unexpected gh $*" >&2; exit 99; fi
path=$2
shift 2
filter=''
while [ $# -gt 0 ]; do
  if [ "$1" = --jq ]; then filter=$2; fi
  shift
done
case "$path" in
  "repos/o/r/commits/$SHA/pulls") file=pulls ;;
  "repos/o/r/commits/$SHA") file=commit ;;
  "repos/o/r/commits/$HEAD") file=head ;;
  "repos/o/r/compare/$PARENT...$HEAD") file=compare ;;
  "repos/o/r/actions/workflows/ci.yml/runs?event=pull_request&head_sha=$HEAD&per_page=20") file=runs ;;
  *) echo "unexpected path $path" >&2; exit 98 ;;
esac
if [ "${FAILS:-}" = "$file" ]; then exit 1; fi
if [ -n "$filter" ]; then jq -r "$filter" "$FIX/$file.json"; else cat "$FIX/$file.json"; fi
EOF
chmod +x "$here/bin/gh"

hours_ago() { date -u -d "$1 hours ago" +%Y-%m-%dT%H:%M:%SZ; }

# The fixtures of a pull request #7 that was tested and merged as SHA; each scenario changes
# one thing, through these variables.
good() {
  TREE=aaaa HEAD_TREE=aaaa PARENTS="[{\"sha\":\"$PARENT\"}]" MERGED_AS=$SHA HEAD_REPO=o/r BASE=main
  BEHIND=0 CONCLUSION=success RUN_REPO=o/r UPDATED=$(hours_ago 1) PULLS='' FAILS=''
}

scenario() {
  echo "$1"
  export FIX="$here/fix"
  rm -rf "$FIX"
  mkdir -p "$FIX"
  : > "$FIX/calls"
  printf '{"commit":{"tree":{"sha":"%s"}},"parents":%s}\n' "$TREE" "$PARENTS" > "$FIX/commit.json"
  if [ -n "$PULLS" ]; then
    printf '%s\n' "$PULLS" > "$FIX/pulls.json"
  else
    printf '[{"number":7,"merged_at":"2026-10-24T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"%s"},"head":{"sha":"%s","repo":{"full_name":"%s"}}}]\n' \
      "$MERGED_AS" "$BASE" "$HEAD" "$HEAD_REPO" > "$FIX/pulls.json"
  fi
  printf '{"commit":{"tree":{"sha":"%s"}}}\n' "$HEAD_TREE" > "$FIX/head.json"
  printf '{"behind_by":%s,"ahead_by":3}\n' "$BEHIND" > "$FIX/compare.json"
  printf '{"workflow_runs":[{"status":"completed","conclusion":"%s","head_repository":{"full_name":"%s"},"updated_at":"%s","html_url":"https://github.com/o/r/actions/runs/55"}]}\n' \
    "$CONCLUSION" "$RUN_REPO" "$UPDATED" > "$FIX/runs.json"
  export SHA PARENT HEAD FAILS
  GH_REPO=o/r MAX_AGE_HOURS=6 GITHUB_OUTPUT="$FIX/output" GITHUB_STEP_SUMMARY="$FIX/summary" \
    PATH="$here/bin:$PATH" run_step "$here/decide.sh" > "$FIX/out" 2>&1
  status=$?
}

skips() { [ "$status" -eq 0 ] && [ "$(cat "$FIX/output")" = 'skip=yes' ]; }
runs_all() { [ "$status" -eq 0 ] && [ "$(cat "$FIX/output")" = 'skip=no' ]; }

# The jobs' conditions, which no step here runs.
check 'the decision asks only on a push to main by CI itself' contains "$WORKFLOWS_DIR/ci.yml" \
  "if: github.event_name == 'push' && github.workflow == 'CI' && github.ref == 'refs/heads/main'"
check 'e2e and the Windows unit tests run unless it said skip=yes (also when it was skipped or failed)' test \
  "$(grep -cF "if: \${{ !cancelled() && needs.tested-in-pr.outputs.skip != 'yes' }}" "$WORKFLOWS_DIR/ci.yml")" -eq 2

good; scenario 'tested in its pull request, the same tree, main among its ancestors, green an hour ago'
check 'says skip=yes' skips
check 'names the pull request and its run in the summary' contains "$FIX/summary" \
  'Tested in #7: https://github.com/o/r/actions/runs/55 passed on its last commit'

good; HEAD_TREE=bbbb; scenario "the pull request's last commit has another tree"
check 'runs everything' runs_all
check 'says why' contains "$FIX/summary" "the tree of #7's last commit is not this commit's"

good; BEHIND=2; scenario 'the last commit lacks commits of main (its run tested another merge)'
check 'runs everything' runs_all
check 'says why' contains "$FIX/summary" 'lacks 2 commit(s) of main'

good; PULLS='[]'; scenario 'no pull request was merged as this commit (a direct push)'
check 'runs everything' runs_all
check 'says why' contains "$FIX/summary" 'no pull request of this repository was merged as this commit'

good; HEAD_REPO=someone/fork; scenario "a fork's pull request"
check 'runs everything' runs_all

good; MERGED_AS=4444444444444444444444444444444444444444; scenario 'the pull request was merged as another commit'
check 'runs everything' runs_all

good; BASE=release; scenario 'a pull request into another branch'
check 'runs everything' runs_all

good; CONCLUSION=failure; scenario 'its last run failed'
check 'runs everything' runs_all
check 'says why' contains "$FIX/summary" 'has no green run of this workflow from the last 6 hours'

good; RUN_REPO=someone/fork; scenario "the green run is a fork's"
check 'runs everything' runs_all

good; UPDATED=$(hours_ago 7); scenario 'its green run is older than 6 hours'
check 'runs everything' runs_all

good; PARENTS="[{\"sha\":\"$PARENT\"},{\"sha\":\"5555555555555555555555555555555555555555\"}]"; scenario 'a merge commit with two parents'
check 'runs everything' runs_all
check 'asks nothing more' lacks "$FIX/calls" 'pulls'

for what in commit pulls head compare runs; do
  good; FAILS=$what; scenario "the look at $what fails"
  check 'runs everything, and the step passes' runs_all
done

finish
