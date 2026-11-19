#!/usr/bin/env bash
# mpv-updates.yml: a build whose pull request the owner closed unmerged is not offered again
# (#634 and #755 closed mpv 20261111, and #768 offered it once more), nor is any build not
# newer than it. The closed pull request is the record; mpv-update-closed.yml deletes its
# branch. This takes the offer step's lookup of that record and its check that the pull
# request is still open before it is retitled, and the whole step of mpv-update-closed.yml,
# and runs them with a stub gh (and git pushing to a local repository).
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script mpv-updates.yml "Offer the latest build on a pull request, if CI passes with it" > "$here/step.sh" || exit 1
step_script mpv-update-closed.yml 'Delete mpv-update' > "$here/closed.sh" || exit 1

# The lookup: from "rejected=$(gh api" to the "fi" that ends the declined check.
{
  echo 'set -euo pipefail'
  awk '/^rejected=\$\(gh api/ { on = 1 } on { print } on && /^fi$/ { exit }' "$here/step.sh"
  echo 'echo "declined=$declined"'
} > "$here/lookup.sh"
check 'the step still has the lookup' contains "$here/lookup.sh" 'declined=${rejected##* }'
check 'and skips a rejected build' contains "$here/step.sh" 'closed unmerged: $latest is not newer, so it is skipped.'
check 'and retitles its own close, so it is not a rejection' contains "$here/step.sh" 'gh pr edit "$pr" --title "ci: mpv offer closed, main pins $pinned"'

# The check before the offer: from its comment to the "fi" that ends it, unindented.
{
  echo 'set -euo pipefail'
  awk '/# Closed while CI ran:/ { on = 1 } on { sub(/^ +/, ""); print; if ($0 == "fi") exit }' "$here/step.sh"
  echo 'echo "pr=$pr"'
} > "$here/still-open.sh"
check 'the step still checks the pull request before retitling it' contains "$here/still-open.sh" 'state=$(gh pr view "$pr"'

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
  "api --paginate repos/$GH_REPO/pulls?state=closed&base=main&head=Nawid3333:mpv-update&per_page=100 "*)
    for page in "$FIX"/closed-*.json; do jq -r "$jqf" "$page"; done ;;
  'pr view 768 --json state '*) jq -r "$jqf" "$FIX/state.json" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
REAL_GIT=$(command -v git)
cat > "$here/bin/git" <<EOF
#!/usr/bin/env bash
args=()
for a in "\$@"; do
  if [ "\$a" = "https://github.com/\$GH_REPO.git" ]; then a=\$REMOTE; fi
  args+=("\$a")
done
exec "$REAL_GIT" "\${args[@]}"
EOF
chmod +x "$here/bin/gh" "$here/bin/git"

export GH_REPO='Nawid3333/FastStream' PR_BRANCH='mpv-update' GH_TOKEN='token'
export FIX=$here/fix RUNNER_TEMP=$here/tmp REMOTE=$here/remote.git
mkdir -p "$FIX" "$RUNNER_TEMP"
run() { # <script> [latest]
  rm -rf "$RUNNER_TEMP/repo"
  latest=${2-} pr=768 PATH="$here/bin:$PATH" run_step "$1" > "$here/out" 2>&1
}

# This repository's closed pull requests from mpv-update, as GitHub's REST API pages them.
cat > "$FIX/closed-1.json" <<'EOF'
[
  {"number": 901, "title": "ci: mpv 20261121 (shinchiro)", "merged_at": null, "user": {"login": "someone"}},
  {"number": 900, "title": "ci: mpv offer closed, main pins 20261120", "merged_at": null, "user": {"login": "github-actions[bot]"}},
  {"number": 755, "title": "ci: mpv 20261111 (shinchiro)", "merged_at": null, "user": {"login": "github-actions[bot]"}}
]
EOF
cat > "$FIX/closed-2.json" <<'EOF'
[
  {"number": 634, "title": "ci: mpv 20261111 (shinchiro)", "merged_at": null, "user": {"login": "github-actions[bot]"}},
  {"number": 624, "title": "ci: mpv 20261125 (shinchiro)", "merged_at": "2026-11-26T10:00:00Z", "user": {"login": "github-actions[bot]"}},
  {"number": 610, "title": "ci: mpv 20261101 (shinchiro)", "merged_at": null, "user": {"login": "github-actions[bot]"}}
]
EOF
lookup() { # <latest> <expected>
  run "$here/lookup.sh" "$1" && grep -qx "declined=$2" "$here/out"
}
check 'a build closed unmerged is rejected, by its newest close' lookup 20261111 755
check 'so is an older build, should it become the latest again' lookup 20261110 755
check 'a newer build is offered' lookup 20261112 ''
check 'a merged build is no rejection' lookup 20261125 ''
check 'nor the workflow'"'"'s own close when main pinned the build' lookup 20261120 ''
check 'nor someone else'"'"'s pull request from a branch of that name' lookup 20261121 ''

echo '{"state": "OPEN"}' > "$FIX/state.json"
run "$here/still-open.sh"
check 'an open pull request is retitled to the new build' contains "$here/out" 'pr=768'
echo '{"state": "CLOSED"}' > "$FIX/state.json"
run "$here/still-open.sh"
check 'one closed while CI ran keeps its title: a new one is opened' grep -qx 'pr=' "$here/out"

# mpv-update-closed.yml: deletes the branch only while it holds the commit the pull request offered.
git init -q --bare "$REMOTE"
git init -q "$here/src"
git -C "$here/src" -c user.name=t -c user.email=t@t commit -q --allow-empty -m a
a=$(git -C "$here/src" rev-parse HEAD)
git -C "$here/src" -c user.name=t -c user.email=t@t commit -q --allow-empty -m b
b=$(git -C "$here/src" rev-parse HEAD)
branch_at() { [ "$(git -C "$REMOTE" rev-parse -q --verify refs/heads/mpv-update)" = "$1" ]; }

git -C "$here/src" push -q -f "$REMOTE" "$a:refs/heads/mpv-update"
SHA=$a run "$here/closed.sh"
check 'the closed pull request'"'"'s branch is deleted' branch_at ''
check 'and says so' contains "$here/out" "Deleted mpv-update ($a)."
git -C "$here/src" push -q -f "$REMOTE" "$b:refs/heads/mpv-update"
SHA=$a run "$here/closed.sh"
check 'a newer build pushed there meanwhile is kept' branch_at "$b"
check 'and says so' contains "$here/out" 'holds a newer build now: kept.'
git -C "$REMOTE" update-ref -d refs/heads/mpv-update
SHA=$a run "$here/closed.sh"
check 'a branch gone already is fine' contains "$here/out" 'gone already'

finish
