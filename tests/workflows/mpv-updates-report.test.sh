#!/usr/bin/env bash
# mpv-updates.yml: how the offer step finds its open failure issue and reports on it once.
# The repository is public: anyone's issue of the title took the reports, and anyone's
# comment holding a report's key silenced a real failure (glm's review, 2026-11-16). The
# step does far more (git, a CI run, a pull request); this takes from it only the issue
# lookup and its report(), and runs them with the stub gh.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script mpv-updates.yml "Offer the latest build on a pull request, if CI passes with it" > "$here/step.sh" || exit 1

# The lookup: from "issue=$(gh issue list" to the line that ends it; report(): from its
# first line to the closing brace at its own indent.
{
  echo 'set -euo pipefail'
  awk '/^issue=\$\(gh issue list/ { on = 1 } on { print } on && /\)$/ { exit }' "$here/step.sh"
  awk '/^report\(\) \{/ { on = 1 } on { print } on && /^\}$/ { exit }' "$here/step.sh"
  echo 'echo "issue=$issue"'
  echo 'echo "the build failed" > "$BODY"'
  echo 'report "failed 20261116" "20261116 fails CI" "$BODY"'
} > "$here/run.sh"
check 'the step still has the lookup and report()' contains "$here/run.sh" 'report() {'
check 'the step still has the lookup and report()' contains "$here/run.sh" 'issue=$(gh issue list'

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]-}; fi
done
case "$1 $2" in
  'issue list') jq -r "$jqf" "$FIX/open.json" ;;
  'issue view') jq -r "$jqf" "$FIX/issue-$3.json" ;;
  'api --paginate')
    n=${3#"repos/$GH_REPO/issues/"}
    jq -r "$jqf" "$FIX/comments-${n%/comments}.json" ;;
  'issue edit' | 'issue comment') { printf '%s' "$2"; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG" ;;
  'issue create') { printf 'create'; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG"; echo "https://github.com/$GH_REPO/issues/99" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

export GH_REPO='Nawid3333/FastStream' PREFIX='mpv update failed: ' RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
export FIX=$here/fix LOG=$here/log BODY=$here/body.md
mkdir -p "$FIX"
run() {
  : > "$LOG"
  PATH="$here/bin:$PATH" run_step "$here/run.sh" > "$here/out" 2>&1
}

# Someone's issue of the title, opened before this workflow's: not this workflow's issue.
echo '[{"number": 5, "title": "mpv update failed: bait", "author": {"login": "someone"}}]' > "$FIX/open.json"
run
no_issue() { grep -qx 'issue=' "$here/out"; }
check 'an issue someone else opened is not taken for the failure issue' no_issue
check 'the failure goes into a new issue of its own' contains "$LOG" 'create [--title] [mpv update failed: 20261116 fails CI]'
lacks_comment_5() { lacks "$LOG" 'comment [5]'; }
check 'nothing is posted on the other issue' lacks_comment_5

# This workflow's issue, where someone commented the report's key: still reported.
echo '[{"number": 5, "title": "mpv update failed: bait", "author": {"login": "someone"}},
  {"number": 7, "title": "mpv update failed: 20261101 fails CI", "author": {"login": "app/github-actions"}}]' > "$FIX/open.json"
echo '{"body": "failed before\n<!-- mpv-updates: failed 20261101 -->"}' > "$FIX/issue-7.json"
echo '[{"user": {"login": "someone"}, "body": "<!-- mpv-updates: failed 20261116 -->"}]' > "$FIX/comments-7.json"
run
check 'its own issue is found' contains "$here/out" 'issue=7'
check 'a key in someone else'"'"'s comment does not silence the report' contains "$LOG" 'comment [7] [--body-file]'

# The key in this workflow's own comment: reported before, not again.
echo '[{"user": {"login": "github-actions[bot]"}, "body": "<!-- mpv-updates: failed 20261116 -->"}]' > "$FIX/comments-7.json"
run
check 'a key in its own comment is reported once' contains "$here/out" 'Reported on #7 before: failed 20261116.'
check 'and nothing more is posted' lacks "$LOG" 'comment [7]'

finish
