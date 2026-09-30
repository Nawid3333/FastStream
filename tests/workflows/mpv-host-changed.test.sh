#!/usr/bin/env bash
# mpv-host-changed.yml: the comment on the reminder issue after a push that changes the
# mpv helper or its installer.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script mpv-host-changed.yml 'Comment on the reminder issue' > "$here/step.sh" || exit 1

# gh: records its arguments, one line a call. A commit read answers its --jq from $FIX/files-<sha> (none:
# the call fails); a comment keeps its body, and fails when the test says so. Any other
# call fails.
mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
all=$*
printf '%s\n' "${all//$'\n'/ }" >> "$FIX/calls"
case "$1 $2" in
  'api repos/o/r/commits/'*)
    sha=${2##*/} jqf=''
    args=("$@")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]}; fi
    done
    [ -n "$jqf" ] || { echo 'stub gh: no --jq' >&2; exit 99; }
    [ -f "$FIX/files-$sha" ] || { echo "stub gh: HTTP 404 for $sha" >&2; exit 1; }
    jq -r "$jqf" "$FIX/files-$sha" ;;
  'issue comment')
    while [ $# -gt 0 ]; do
      if [ "$1" = --body-file ]; then cp "$2" "$FIX/body"; fi
      shift
    done
    [ -z "${GH_FAILS-}" ] ;;
  *) echo "unexpected gh $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$here/bin/gh"

HOST=native-host/faststream-mpv-host.mjs
INSTALL=native-host/install.ps1

# scenario <name> [<sha>=<file>,<file>...]...: runs the step on a push of those commits.
# The event lists them as Actions has it, with no files (and no commits at all with
# NO_COMMITS=1); the commits API gives each one's files (a sha written without = is not
# found there).
scenario() {
  echo "$1"
  shift
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  local ids=() c
  for c in "$@"; do
    ids+=("${c%%=*}")
    if [ "$c" != "${c%%=*}" ]; then
      jq -n --arg f "${c#*=}" '{sha: "x", files: ($f | split(",") | map({filename: ., status: "modified"}))}' \
        > "$FIX/files-${c%%=*}"
    fi
  done
  jq -n '{before: "b", after: "a", commits: [$ARGS.positional[] | {id: ., message: "m", distinct: true}]}' \
    --args "${ids[@]}" > "$FIX/event.json"
  if [ -n "${NO_COMMITS-}" ]; then jq 'del(.commits)' "$FIX/event.json" > "$FIX/e" && mv "$FIX/e" "$FIX/event.json"; fi
  GITHUB_EVENT_PATH="$FIX/event.json" GITHUB_SHA=ffff0000 GH_REPO=o/r OWNER=Nawid3333 ISSUE=73 \
    PATH="$here/bin:$PATH" run_step "$here/step.sh" > "$FIX/out" 2>&1
  status=$?
}

scenario 'the helper changed in one commit' "aaaa1111=$HOST"
check 'succeeds' test "$status" -eq 0
check 'reads the commit from the commits API' contains "$FIX/calls" 'api repos/o/r/commits/aaaa1111 --paginate --jq'
check 'comments on #73, once' test "$(grep -c '^issue comment 73 --body-file ' "$FIX/calls")" -eq 1
check 'and calls gh for nothing else' test "$(wc -l < "$FIX/calls")" -eq 2
check 'mentions the owner' contains "$FIX/body" '@Nawid3333 The mpv helper changed on `main`'
check 'names the helper' contains "$FIX/body" "- \`$HOST\`"
check 'not the installer' lacks "$FIX/body" "- \`$INSTALL\`"
check 'and no empty line in the list' lacks "$FIX/body" '- ``'
check 'names the commit' contains "$FIX/body" 'in aaaa1111.'
check 'gives the command, backslash and all' contains "$FIX/body" \
  'powershell -ExecutionPolicy Bypass -File native-host\install.ps1'
check 'and the restart' contains "$FIX/body" 'Then restart Firefox.'

scenario 'the 2026-09-30 merge: one commit, the installer among other files' \
  "b31eaced=CLAUDE.md,native-host/README.md,$INSTALL,pnpm-lock.yaml"
check 'succeeds' test "$status" -eq 0
check 'names the installer' contains "$FIX/body" "- \`$INSTALL\`"
check 'not the helper' lacks "$FIX/body" "- \`$HOST\`"
check 'nor the files beside it' lacks "$FIX/body" 'README'
check 'names the commit' contains "$FIX/body" 'in b31eaced.'

scenario 'the installer changed in one of two commits, the other elsewhere' \
  "bbbb2222=$INSTALL" 'cccc3333=README.md'
check 'succeeds' test "$status" -eq 0
check 'reads both commits' test "$(grep -c '^api repos/o/r/commits/' "$FIX/calls")" -eq 2
check 'names the installer' contains "$FIX/body" "- \`$INSTALL\`"
check 'not the helper' lacks "$FIX/body" "- \`$HOST\`"
check 'names only the commit that changed it' contains "$FIX/body" 'in bbbb2222.'
check 'not the other one' lacks "$FIX/body" 'cccc3333'

scenario 'both, in two commits, the installer first' "dddd4444=$INSTALL" "eeee5555=$HOST,README.md"
check 'succeeds' test "$status" -eq 0
check 'names the helper' contains "$FIX/body" "- \`$HOST\`"
check 'and the installer' contains "$FIX/body" "- \`$INSTALL\`"
check 'each once' test "$(grep -c '^- `native-host/' "$FIX/body")" -eq 2
check 'names both commits, in push order' contains "$FIX/body" 'in dddd4444 eeee5555.'

scenario 'both in one commit, and one of them again in the next' "abab1212=$HOST,$INSTALL" "cdcd3434=$HOST"
check 'names each file once' test "$(grep -c '^- `native-host/' "$FIX/body")" -eq 2
check 'names both commits' contains "$FIX/body" 'in abab1212 cdcd3434.'

scenario 'commits that change neither file (the path filter matched anyway)' 'f0f0f0f0=README.md'
check 'succeeds' test "$status" -eq 0
check 'names the helper' contains "$FIX/body" "- \`$HOST\`"
check 'and the installer' contains "$FIX/body" "- \`$INSTALL\`"
check 'names the pushed commit' contains "$FIX/body" 'in ffff0000.'

scenario 'an event with no commits listed'
check 'succeeds' test "$status" -eq 0
check 'reads no commit' lacks "$FIX/calls" 'api '
check 'names both files' test "$(grep -c '^- `native-host/' "$FIX/body")" -eq 2
check 'and the pushed commit' contains "$FIX/body" 'in ffff0000.'

export NO_COMMITS=1
scenario 'an event without the commits list'
unset NO_COMMITS
check 'succeeds' test "$status" -eq 0
check 'names both files' test "$(grep -c '^- `native-host/' "$FIX/body")" -eq 2
check 'and the pushed commit' contains "$FIX/body" 'in ffff0000.'

scenario 'a commit the API cannot read' "aaaa1111=$HOST" 'dead0000'
check 'fails the run' test "$status" -ne 0
check 'comments on nothing' lacks "$FIX/calls" 'issue comment'

export GH_FAILS=1
scenario 'gh cannot comment' "aaaa1111=$HOST"
unset GH_FAILS
check 'fails the run' test "$status" -ne 0

finish
