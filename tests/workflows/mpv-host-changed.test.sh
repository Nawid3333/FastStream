#!/usr/bin/env bash
# mpv-host-changed.yml: the comment on the reminder issue after a push that changes the
# mpv helper or its installer.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script mpv-host-changed.yml 'Comment on the reminder issue' > "$here/step.sh" || exit 1

# gh: records its arguments and the comment body; fails when the test says so.
mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
while [ $# -gt 0 ]; do
  if [ "$1" = --body-file ]; then cp "$2" "$FIX/body"; fi
  shift
done
[ -z "${GH_FAILS-}" ]
EOF
chmod +x "$here/bin/gh"

HOST=native-host/faststream-mpv-host.mjs
INSTALL=native-host/install.ps1

# scenario <name> <commits json>: runs the step on a push event with those commits.
scenario() {
  echo "$1"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  printf '{"commits": %s}' "$2" > "$FIX/event.json"
  GITHUB_EVENT_PATH="$FIX/event.json" GITHUB_SHA=ffff0000 GH_REPO=o/r OWNER=Nawid3333 ISSUE=73 \
    PATH="$here/bin:$PATH" run_step "$here/step.sh" > "$FIX/out" 2>&1
  status=$?
}

commit() { # <sha> <added json> <modified json> <removed json>
  printf '{"id": "%s", "added": %s, "modified": %s, "removed": %s}' "$1" "$2" "$3" "$4"
}

scenario 'the helper changed in one commit' "[$(commit aaaa1111 '[]' "[\"$HOST\"]" '[]')]"
check 'succeeds' test "$status" -eq 0
check 'comments on #73' contains "$FIX/calls" 'issue comment 73 --body-file'
check 'mentions the owner' contains "$FIX/body" '@Nawid3333 The mpv helper changed on `main`'
check 'names the helper' contains "$FIX/body" "- \`$HOST\`"
check 'not the installer' lacks "$FIX/body" "- \`$INSTALL\`"
check 'names the commit' contains "$FIX/body" 'in aaaa1111.'
check 'gives the command, backslash and all' contains "$FIX/body" \
  'powershell -ExecutionPolicy Bypass -File native-host\install.ps1'
check 'and the restart' contains "$FIX/body" 'Then restart Firefox.'

scenario 'the installer added in one of two commits, the other elsewhere' \
  "[$(commit bbbb2222 "[\"$INSTALL\"]" '[]' '[]'), $(commit cccc3333 '[]' '["README.md"]' '[]')]"
check 'succeeds' test "$status" -eq 0
check 'names the installer' contains "$FIX/body" "- \`$INSTALL\`"
check 'not the helper' lacks "$FIX/body" "- \`$HOST\`"
check 'names only the commit that changed it' contains "$FIX/body" 'in bbbb2222.'

scenario 'both, in two commits, one of them removing the installer' \
  "[$(commit dddd4444 '[]' "[\"$HOST\"]" '[]'), $(commit eeee5555 '[]' '[]' "[\"$INSTALL\"]")]"
check 'names the helper' contains "$FIX/body" "- \`$HOST\`"
check 'and the installer' contains "$FIX/body" "- \`$INSTALL\`"
check 'names both commits' contains "$FIX/body" 'in dddd4444 eeee5555.'

scenario 'a push event that lists neither file (the path filter matched anyway)' '[]'
check 'succeeds' test "$status" -eq 0
check 'names the helper' contains "$FIX/body" "- \`$HOST\`"
check 'and the installer' contains "$FIX/body" "- \`$INSTALL\`"
check 'names the pushed commit' contains "$FIX/body" 'in ffff0000.'

export GH_FAILS=1
scenario 'gh cannot comment' "[$(commit aaaa1111 '[]' "[\"$HOST\"]" '[]')]"
unset GH_FAILS
check 'fails the run' test "$status" -ne 0

finish
