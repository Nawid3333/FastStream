#!/usr/bin/env bash
# patched-libraries.yml's first pass: an open update issue or pull request for a version main
# has caught up with, or for a library that is no longer patched, is closed - a pull request
# with its branch, which stayed behind on the remote (the supersede pass deletes its own).
# The pass alone, taken out of its step, with a stub gh (jq for real). This test keeps its
# own check.
source "$(dirname "$0")/lib.sh"
set -e
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
awk '/^          # --- Close what has been caught up with/ {f=1} /^          # --- Supersede/ {exit} f {print substr($0, 11)}' \
  "$WORKFLOWS_DIR/patched-libraries.yml" > "$T/close.sh"
if ! grep -q 'gh "\$kind" list' "$T/close.sh"; then
  echo 'no caught-up close pass in patched-libraries.yml'
  exit 1
fi
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$T/gh.log"
jqarg() { local p a; for a; do [ "${p-}" = --jq ] && printf '%s' "$a"; p=$a; done; }
case "$1 $2" in
  'issue list'|'pr list') jq -r "$(jqarg "$@")" "$T/${1}s.json" ;;
  'issue close')
    for a; do
      if [ "$a" = --delete-branch ]; then echo 'issue close takes no --delete-branch' >&2; exit 99; fi
    done ;;
  'pr close') ;;
  *) echo "unhandled: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$T/bin/gh"
export T PATH="$T/bin:$PATH" RUNNER_TEMP=$T GITHUB_SHA=abc123
PREFIX='Patched library update: '
export PREFIX
fails=0
check() { if "${@:2}"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
item() { # <number> <title> -> json
  printf '{"number": %s, "title": "%s", "author": {"login": "app/github-actions"}}' "$1" "$2"
}

# main's patch is cut against hls.js 1.6.12; dashjs is patched no more.
printf '%s\n' '{"name": "hls.js", "current": "1.6.12"}' > "$T/libraries.jsonl"
echo "[$(item 1 'Patched library update: hls.js 1.6.11')]" > "$T/issues.json"
echo "[$(item 10 'Patched library update: hls.js 1.6.12'), $(item 11 'Patched library update: hls.js 1.6.13'), $(item 12 'Patched library update: dashjs 5.1.0')]" > "$T/prs.json"
: > "$T/gh.log"
rc=0
bash -c 'set -euo pipefail; source "$T/close.sh"' > "$T/out" 2>&1 || rc=$?
check 'exit 0' test "$rc" -eq 0
check 'caught-up issue closed' grep -qxF 'issue close 1 --comment The patch is now cut against hls.js 1.6.12 (commit abc123). Closing.' "$T/gh.log"
check 'caught-up pull request closed with its branch' \
  grep -qxF 'pr close 10 --delete-branch --comment The patch is now cut against hls.js 1.6.12 (commit abc123). Closing.' "$T/gh.log"
check 'pull request of a library no longer patched closed with its branch' \
  grep -qxF 'pr close 12 --delete-branch --comment dashjs is no longer a patched library. Closing.' "$T/gh.log"
check 'newer pull request kept' bash -c '! grep -q "close 11 " "$0"' "$T/gh.log"

if [ "$fails" -ne 0 ]; then
  cat "$T/out"
  exit 1
fi
