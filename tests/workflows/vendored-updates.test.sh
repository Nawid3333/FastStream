#!/usr/bin/env bash
# vendored-updates.yml: the vtt.js issue, which ones close, and what is never raised
# twice (the silero-vad model job went with the speech detector, 2026-10-10). gh and curl
# are stubs that answer from fixture files and log what they are asked.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
vtt_step=$here/vtt.sh
step_script vendored-updates.yml 'Open the issue for a changed vtt.js' > "$vtt_step" || exit 1
step_script vendored-updates.yml "Report the vtt.js job's own failure" > /dev/null || exit 1

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
  "api repos/$UPSTREAM/releases/latest")
    if [ -n "$jqf" ]; then jq -r "$jqf" "$FIX/release.json"; else cat "$FIX/release.json"; fi ;;
  'api --paginate')
    [ "$3" = "repos/$GH_REPO/issues?state=all&per_page=100" ] || { echo "stub gh: unexpected api path $3" >&2; exit 2; }
    jq -r "$jqf" "$FIX/issues.json" ;;
  'issue create' | 'pr create')
    {
      printf '%s' "$(printf '%s' "$1" | tr a-z A-Z)CREATE"; printf ' [%s]' "${@:3}"; printf '\n'
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
        shift
      done
    } >> "$LOG"
    echo "https://github.com/$GH_REPO/issues/99" ;;
  'issue close' | 'pr close')
    { printf '%s' "$(printf '%s' "$1" | tr a-z A-Z)CLOSE"; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG" ;;
  'workflow run')
    { printf 'DISPATCH'; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG" ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
# curl: -o FILE -w '%{http_code}' URL, answered from $FIX/urls/<URL with / as _>, or 404.
cat > "$here/bin/curl" <<'EOF'
#!/usr/bin/env bash
out='' url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w|--max-time) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "CURL [$url]" >> "$LOG"
f="$FIX/urls/$(printf '%s' "$url" | tr '/:' '__')"
if [ -f "$f" ]; then cp "$f" "$out"; printf 200; else : > "$out"; printf 404; fi
EOF
chmod +x "$here/bin/gh" "$here/bin/curl"

export GH_TOKEN=stub GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333'
export RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
bot='{"login":"github-actions[bot]"}'
human='{"login":"Nawid3333"}'

# fixtures <latest tag> <issues json>: a fresh scenario.
fixtures() {
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP" "$FIX/urls"
  : > "$LOG"
  printf '{"tag_name":"%s"}' "$1" > "$FIX/release.json"
  printf '%s' "$2" > "$FIX/issues.json"
}
# serve <url> <content>: what curl gets for that URL.
serve() { printf '%s' "$2" > "$FIX/urls/$(printf '%s' "$1" | tr '/:' '__')"; }

# A checkout of this repository as the vtt.js job has it: the pin, a bare origin.
repo() {
  local work=$FIX/work
  git init -q -b main "$work"
  mkdir -p "$work/tools"
  printf "const UPSTREAM =\n  'https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.1.0/' +\n  'contrib/videojs-vtt.js/vtt.js';\n" > "$work/tools/verify-vtt.mjs"
  git -C "$work" -c user.name=t -c user.email=t@t add -A
  git -C "$work" -c user.name=t -c user.email=t@t commit -q -m init
  git init -q --bare "$FIX/origin.git"
  git -C "$work" remote add origin "$FIX/origin.git"
}
run() {
  echo "$1"
  (
    cd "$FIX/work" || exit 9
    PATH="$here/bin:$PATH" run_step "$2"
  ) > "$FIX/out" 2>&1
  status=$?
}
vtt_env() { export UPSTREAM='Dash-Industry-Forum/dash.js' VTT_PATH='contrib/videojs-vtt.js/vtt.js' PREFIX='vtt.js changed in dash.js '; }
vtt_url() { echo "https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/$1/contrib/videojs-vtt.js/vtt.js"; }

vtt_env
fixtures v5.3.0 "[{\"number\":60,\"state\":\"open\",\"title\":\"vtt.js changed in dash.js v5.2.0\",\"user\":$bot},{\"number\":61,\"state\":\"open\",\"title\":\"vtt.js changed in dash.js v5.0.0\",\"user\":$bot}]"
repo
serve "$(vtt_url v5.1.0)" $'a\nb\nc\n'
serve "$(vtt_url v5.3.0)" $'a\nB\nc\nd\n'
run 'v1 dash.js changed vtt.js -> an issue with the change, older ones closed' "$vtt_step"
check 'succeeds' test "$status" -eq 0
check 'opens "vtt.js changed in dash.js v5.3.0"' contains "$LOG" 'ISSUECREATE [--title] [vtt.js changed in dash.js v5.3.0] [--assignee] [Nawid3333]'
check 'counts the changed lines and links the compare' contains "$LOG" 'changes 3 lines of it: https://github.com/Dash-Industry-Forum/dash.js/compare/v5.1.0...v5.3.0'
check 'closes the older #60, pointing at the new one' contains "$LOG" "ISSUECLOSE [60] [--reason] [not planned] [--comment] [dash.js v5.3.0 is out: https://github.com/Nawid3333/FastStream/issues/99 replaces this one.]"
check 'closes #61, whose release the pin has passed' contains "$LOG" 'ISSUECLOSE [61] [--comment] [tools/verify-vtt.mjs pins dash.js v5.1.0 now.]'

fixtures v5.3.0 '[]'
repo
serve "$(vtt_url v5.1.0)" $'a\nb\n'
serve "$(vtt_url v5.3.0)" $'a\nb\n'
run 'v2 the same vtt.js -> nothing' "$vtt_step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'

fixtures v5.3.0 '[]'
repo
serve "$(vtt_url v5.1.0)" $'a\n'
run 'v3 vtt.js gone from the new release -> an issue saying so' "$vtt_step"
check 'succeeds' test "$status" -eq 0
check 'says it is gone' contains "$LOG" 'dash.js v5.3.0 is out and no longer has it at contrib/videojs-vtt.js/vtt.js.'

fixtures v5.3.0 "[{\"number\":62,\"state\":\"closed\",\"title\":\"vtt.js changed in dash.js v5.3.0\",\"user\":$bot}]"
repo
run 'v4 raised before -> nothing, nothing fetched' "$vtt_step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'fetches nothing' lacks "$LOG" 'CURL'

finish
