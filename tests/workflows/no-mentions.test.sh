#!/usr/bin/env bash
# No workflow emails the owner (2026-11-09; the daily digest that was the one exception went
# 2026-11-11). Every workflow writes its issues, pull requests and comments without an @mention and
# assigns no one, since GitHub emails both. Fails on any workflow that does either again.
source "$(dirname "$0")/lib.sh"
checks=0
fails=0
expect() { # <description> <file with offending lines>
  checks=$((checks + 1))
  if [ -s "$2" ]; then
    printf '  FAIL  %s:\n' "$1"; sed 's/^/        /' "$2"; fails=$((fails + 1))
  else
    printf '  ok    %s\n' "$1"
  fi
}
here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
cd "$WORKFLOWS_DIR" || exit 1
others=(*.yml)
grep -nE -- '--(add-)?assignee([ =]|$)|--add-reviewer' "${others[@]}" > "$here/assign" || true
expect 'no workflow assigns anyone' "$here/assign"
# An @ before a format's %s or an $OWNER/${OWNER}/${{ github.repository_owner }}, in a script
# or a string. (date's "@<seconds>", "body=@<file>" and package@version are no mentions.)
grep -nE "@(%s|\\\$OWNER|\\\$\{OWNER\}|\\\$\{\{ *github\.(repository_owner|actor)|Nawid3333)" "${others[@]}" > "$here/mention" || true
expect 'no workflow @mentions anyone' "$here/mention"
printf '%s checks, %s failed\n' "$checks" "$fails"
[ "$fails" = 0 ]
