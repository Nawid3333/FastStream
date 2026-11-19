#!/usr/bin/env bash
# mpv-updates.yml: a build whose pull request the owner closed unmerged is not offered again
# (#634 and #755 closed mpv 20261111, and #768 offered it once more). The closed pull request
# is the record; mpv-update-closed.yml deletes its branch. This takes the offer step's lookup
# of such a pull request, and the whole step of mpv-update-closed.yml, and runs them with a
# stub gh.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script mpv-updates.yml "Offer the latest build on a pull request, if CI passes with it" > "$here/step.sh" || exit 1
step_script mpv-update-closed.yml 'Delete mpv-update' > "$here/closed.sh" || exit 1

{
  echo 'set -euo pipefail'
  awk '/^declined=\$\(gh pr list/ { on = 1 } on { print } on && /\)$/ { exit }' "$here/step.sh"
  echo 'echo "declined=$declined"'
} > "$here/run.sh"
check 'the step still has the lookup' contains "$here/run.sh" 'declined=$(gh pr list'
check 'and skips a declined build' contains "$here/step.sh" 'closed unmerged: skipped until a newer build.'

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]-}; fi
done
case "$*" in
  'pr list --state closed --head mpv-update --base main '*) jq -r "$jqf" "$FIX/closed.json" ;;
  "api repos/$GH_REPO/git/ref/heads/mpv-update --jq .object.sha")
    if [ -f "$FIX/ref" ]; then cat "$FIX/ref"; else echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi ;;
  "api -X DELETE repos/$GH_REPO/git/refs/heads/mpv-update") echo delete >> "$LOG" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

export GH_REPO='Nawid3333/FastStream' PR_BRANCH='mpv-update'
export FIX=$here/fix LOG=$here/log RUNNER_TEMP=$here
mkdir -p "$FIX"
run() { # <script> [latest]
  : > "$LOG"
  latest=${2-} PATH="$here/bin:$PATH" run_step "$1" > "$here/out" 2>&1
}

# This repository's pull requests from mpv-update, as gh lists them.
cat > "$FIX/closed.json" <<'EOF'
[
  {"number": 900, "title": "ci: mpv 20261120 (shinchiro)", "mergedAt": null, "isCrossRepository": true, "author": {"login": "app/github-actions"}},
  {"number": 901, "title": "ci: mpv 20261121 (shinchiro)", "mergedAt": null, "isCrossRepository": false, "author": {"login": "someone"}},
  {"number": 755, "title": "ci: mpv 20261111 (shinchiro)", "mergedAt": null, "isCrossRepository": false, "author": {"login": "app/github-actions"}},
  {"number": 634, "title": "ci: mpv 20261111 (shinchiro)", "mergedAt": null, "isCrossRepository": false, "author": {"login": "app/github-actions"}},
  {"number": 624, "title": "ci: mpv 20261106 (shinchiro)", "mergedAt": "2026-11-07T10:00:00Z", "isCrossRepository": false, "author": {"login": "app/github-actions"}}
]
EOF
lookup() { # <latest> <expected>
  run "$here/run.sh" "$1" && grep -qx "declined=$2" "$here/out"
}
check 'a build closed unmerged is found' lookup 20261111 755
check 'a merged build is not declined' lookup 20261106 ''
check 'a build never offered is not declined' lookup 20261112 ''
check 'a fork'"'"'s pull request does not decline a build' lookup 20261120 ''
check 'nor someone else'"'"'s from a branch of that name' lookup 20261121 ''

# mpv-update-closed.yml: deletes the branch only while it holds the commit the pull request offered.
export SHA=abc123
echo abc123 > "$FIX/ref"
run "$here/closed.sh"
check 'the closed pull request'"'"'s branch is deleted' contains "$LOG" delete
echo def456 > "$FIX/ref"
run "$here/closed.sh"
check 'a newer build pushed there meanwhile is kept' lacks "$LOG" delete
check 'and says so' contains "$here/out" 'mpv-update moved on to def456: kept.'
rm "$FIX/ref"
run "$here/closed.sh"
check 'a branch gone already is fine' contains "$here/out" 'mpv-update is gone already.'

finish
