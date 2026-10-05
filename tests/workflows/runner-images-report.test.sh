#!/usr/bin/env bash
# runner-images.yml's "Open or close the runner image issues": one issue per image set CI
# fails on, closed by a green run on that set - and closed once no run tests its set any
# more (2026-10-05): a newer image took one of its places, and the issue stayed open for
# good, though it said it would close itself.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script runner-images.yml 'Open or close the runner image issues' > "$here/report.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
opt() { local i; for ((i = 0; i < ${#args[@]} - 1; i++)); do if [ "${args[i]}" = "$1" ]; then printf '%s\n' "${args[i + 1]}"; return 0; fi; done; return 1; }
case "$1 $2" in
  'issue list')
    if f=$(opt --jq); then jq -r "($f) | if . == null then \"\" else . end" "$FIX/issues.json"; else cat "$FIX/issues.json"; fi ;;
  'issue close') printf 'CLOSE %s %s\n' "$3" "$(opt --comment)" >> "$LOG" ;;
  'issue create') printf 'CREATE %s\n' "$(opt --title)" >> "$LOG" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

failures=0
export FIX="$here" LOG="$here/log" RUNNER_TEMP="$here" GH_TOKEN=stub GITHUB_REPOSITORY=Nawid3333/FastStream
export OWNER=Nawid3333 RUN_URL=https://example.test/run DETECT=success
export LATEST_IMAGES='ubuntu-24.04, windows-2025' NEXT_IMAGES='ubuntu-26.04, windows-2025'

# report <latest result> <next result> <open issues as JSON>
report() {
  printf '%s' "$3" > "$FIX/issues.json"
  : > "$LOG"
  LATEST=$1 NEXT=$2 PATH="$here/bin:$PATH" run_step "$here/report.sh" > "$here/out" 2>&1
  status=$?
}

echo 'an issue for a set no run tests any more -> closed; the current ones and other titles stay'
report success failure '[{"number":3,"title":"CI fails on runner image ubuntu-24.04, windows-2022"},{"number":4,"title":"CI fails on runner image ubuntu-26.04, windows-2025"},{"number":5,"title":"Something else"}]'
check 'succeeds' test "$status" -eq 0
check 'closes #3, saying what is tested now' grep -qF 'CLOSE 3 No run tests ubuntu-24.04, windows-2022 any more: the images tested now are ubuntu-24.04, windows-2025 and ubuntu-26.04, windows-2025.' "$LOG"
check 'leaves the failing current set (#4) open' lacks "$LOG" 'CLOSE 4'
check 'opens no second issue for it' lacks "$LOG" 'CREATE'
check 'leaves another title alone' lacks "$LOG" 'CLOSE 5'

echo 'a green run on the set an issue names -> closed once, as before'
report success success '[{"number":6,"title":"CI fails on runner image ubuntu-24.04, windows-2025"}]'
check 'succeeds' test "$status" -eq 0
check 'closes #6 once' test "$(grep -c '^CLOSE 6' "$LOG")" -eq 1

finish
