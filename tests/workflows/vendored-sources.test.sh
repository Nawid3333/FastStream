#!/usr/bin/env bash
# vendored-updates.yml, job sources: an issue when upstream changes the file an adapted copy
# (tools/vendored-sources.json) came from after its ref; none while the ref holds upstream's
# newest change, which closes the open one; never the same change twice; a newer change
# replaces the older issue. gh is a stub that answers from fixture files and logs the calls.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step=$here/sources.sh
step_script vendored-updates.yml 'Open the issue for a changed upstream source' > "$step" || exit 1
step_script vendored-updates.yml "Report the sources job's own failure" > /dev/null || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'GH %s\n' "$*" >> "$LOG"
# As gh.exe through WSL did: it reads whatever standard input it is given.
cat > /dev/null
jqf='' path='' sha=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --jq) jqf=${args[i + 1]-} ;;
    -f) case "${args[i + 1]-}" in path=*) path=${args[i + 1]#path=} ;; sha=*) sha=${args[i + 1]#sha=} ;; esac ;;
  esac
done
out() { if [ -n "$jqf" ]; then jq -r "$jqf" "$1"; else cat "$1"; fi; }
key() { printf '%s' "$1" | tr '/' '_'; }
if [ "$1 $2" = 'api --paginate' ]; then
  [ "$3" = "repos/$GH_REPO/issues?state=all&per_page=100" ] || { echo "stub gh: unexpected api path $3" >&2; exit 2; }
  out "$FIX/issues.json"
  exit 0
fi
case "$1 $2" in
  'issue create')
    {
      printf 'CREATE'; printf ' [%s]' "${@:3}"; printf '\n'
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
        shift
      done
    } >> "$LOG"
    echo "https://github.com/$GH_REPO/issues/99"
    exit 0 ;;
  'issue close')
    { printf 'CLOSE'; printf ' [%s]' "${@:3}"; printf '\n'; } >> "$LOG"
    exit 0 ;;
esac
[ "$1" = api ] || { echo "stub gh: unexpected call: $*" >&2; exit 2; }
shift
[ "$1" = -X ] && shift 2
url=$1
case $url in
  repos/*/*/commits)
    repo=${url#repos/}; repo=${repo%/commits}
    if [ -n "$sha" ]; then
      # Upstream's history of the path, from the newest commit down.
      f=$FIX/commits_$(key "$repo").json
      [ -f "$f" ] || echo '[]' > "$f"
      out "$f"
    else
      # The newest one.
      sha=$(cat "$FIX/newest_$(key "$repo")" 2> /dev/null || true)
      if [ -n "$sha" ]; then jq -n --arg s "$sha" '[{sha: $s}]' > "$FIX/n.json"; else echo '[]' > "$FIX/n.json"; fi
      out "$FIX/n.json"
    fi ;;
  repos/*/*/compare/*)
    repo=${url#repos/}; repo=${repo%/compare/*}
    # The status, and the commits after the base (after_<repo>.json: their shas).
    a=$FIX/after_$(key "$repo").json
    [ -f "$a" ] || echo '[]' > "$a"
    jq -n --arg s "$(cat "$FIX/status_$(key "$repo")" 2> /dev/null || echo identical)" --slurpfile a "$a" '{status: $s, commits: [$a[0][] | {sha: .}]}' > "$FIX/c.json"
    out "$FIX/c.json" ;;
  repos/*/*/commits/*)
    echo '{"commit":{"committer":{"date":"2020-01-01T00:00:00Z"}}}' > "$FIX/d.json"
    out "$FIX/d.json" ;;
  *) echo "stub gh: unexpected api call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

export GH_TOKEN=stub GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333' PREFIX='Vendored source changed upstream: '
export RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
bot='{"login":"github-actions[bot]"}'
KREF=1111111111111111111111111111111111111111
VREF=2222222222222222222222222222222222222222
NEW=3333333333333333333333333333333333333333
NEWER=4444444444444444444444444444444444444444

# fixtures <issues json>: a fresh scenario, with two sources, both up to date.
fixtures() {
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP" "$FIX/work/tools"
  : > "$LOG"
  printf '%s' "$1" > "$FIX/issues.json"
  jq -n --arg k "$KREF" --arg v "$VREF" '{sources: [
    {name: "knob", copy: "chrome/player/modules/knob.mjs", repo: "jherrm/knobs", path: "Knob.js", ref: $k},
    {name: "vad-web", copy: "chrome/player/modules/vad/vad.mjs", repo: "ricky0123/vad", path: "packages/web/src", ref: $v}]}' \
    > "$FIX/work/tools/vendored-sources.json"
  echo "$KREF" > "$FIX/newest_jherrm_knobs"
  echo "$VREF" > "$FIX/newest_ricky0123_vad"
}
# changed <repo key> <newest sha>: upstream changed the path after the ref.
changed() {
  echo "$2" > "$FIX/newest_$1"
  echo behind > "$FIX/status_$1"
  jq -n --arg n "$2" '[$n]' > "$FIX/after_$1.json"
  jq -n --arg n "$2" --arg r "$KREF" '[
    {sha: $n, html_url: "https://github.com/x/y/commit/\($n)", commit: {committer: {date: "2022-11-08T10:00:00Z"}, message: "Fix the rotation\n\nlong text"}},
    {sha: $r, html_url: "https://github.com/x/y/commit/\($r)", commit: {committer: {date: "2020-01-01T00:00:00Z"}, message: "the ref itself"}}]' \
    > "$FIX/commits_$1.json"
}
run() {
  echo "$1"
  (
    cd "$FIX/work" || exit 9
    PATH="$here/bin:$PATH" run_step "$step"
  ) < /dev/null > "$FIX/out" 2>&1
  status=$?
}

fixtures "[{\"number\":70,\"state\":\"open\",\"title\":\"${PREFIX}knob (jherrm/knobs 99999999)\",\"user\":$bot},{\"number\":76,\"state\":\"open\",\"title\":\"${PREFIX}knob (jherrm/knobs 88888888)\",\"user\":$bot}]"
run 's1 both up to date -> nothing raised; an open issue closes' "$step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'asks whether the ref holds the newest change' contains "$LOG" "GH api repos/jherrm/knobs/compare/$KREF...$KREF --jq .status"
check 'closes #76 too' contains "$LOG" 'CLOSE [76]'
check 'closes #70, saying why' contains "$LOG" "CLOSE [70] [--comment] [tools/vendored-sources.json has knob at ${KREF:0:8}, which holds jherrm/knobs's newest change to Knob.js.]"

fixtures '[]'
changed jherrm_knobs "$NEW"
run 's2 knob changed upstream -> one issue with the commits' "$step"
check 'succeeds' test "$status" -eq 0
check 'opens it for the newest change, assigned' contains "$LOG" "CREATE [--title] [${PREFIX}knob (jherrm/knobs ${NEW:0:8})] [--assignee] [Nawid3333]"
check 'one issue only (vad-web is up to date)' test "$(grep -c '^CREATE' "$LOG")" -eq 1
check '@mentions, naming the file and the copy' contains "$LOG" "@Nawid3333 jherrm/knobs changed \`Knob.js\` after the commit \`chrome/player/modules/knob.mjs\` was taken from (${KREF:0:8}):"
check 'lists the change, first line only' contains "$LOG" "- [${NEW:0:8}](https://github.com/x/y/commit/$NEW) 2022-11-08 Fix the rotation"
check 'not the ref itself' lacks "$LOG" 'the ref itself'
check 'links all of it' contains "$LOG" "All of it: https://github.com/jherrm/knobs/compare/$KREF...$NEW"
check 'says how it closes' contains "$LOG" "set the \`ref\` of knob in \`tools/vendored-sources.json\` to \`$NEW\`"
check 'asks for the commits after the ref' contains "$LOG" "GH api repos/jherrm/knobs/compare/$KREF...$NEW --jq [.commits[].sha]"
check 'and the history of the file' contains "$LOG" "GH api -X GET repos/jherrm/knobs/commits -f path=Knob.js -f sha=$NEW -f per_page=100"

fixtures "[{\"number\":71,\"state\":\"closed\",\"title\":\"${PREFIX}knob (jherrm/knobs ${NEW:0:8})\",\"user\":$bot},{\"number\":72,\"state\":\"open\",\"title\":\"${PREFIX}knob (jherrm/knobs 99999999)\",\"user\":$bot}]"
changed jherrm_knobs "$NEW"
run 's3 raised before (closed: skipped) -> nothing new; an older open one closes' "$step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'closes the older #72' contains "$LOG" "CLOSE [72] [--comment] [jherrm/knobs changed Knob.js again: the issue for ${NEW:0:8} replaces this one.]"
check 'leaves #71 alone' lacks "$LOG" 'CLOSE [71]'

fixtures "[{\"number\":75,\"state\":\"open\",\"title\":\"${PREFIX}knob (jherrm/knobs ${NEW:0:8})\",\"user\":$bot}]"
changed jherrm_knobs "$NEW"
run 's3b raised before and still open -> left open, nothing new' "$step"
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$LOG" 'CREATE'
check 'closes nothing' lacks "$LOG" 'CLOSE'

fixtures "[{\"number\":73,\"state\":\"open\",\"title\":\"${PREFIX}knob (jherrm/knobs ${NEW:0:8})\",\"user\":$bot},{\"number\":74,\"state\":\"open\",\"title\":\"${PREFIX}vad-web (ricky0123/vad ${NEW:0:8})\",\"user\":$bot}]"
changed jherrm_knobs "$NEWER"
run 's4 a newer change -> a new issue replaces the older one, of that source only' "$step"
check 'succeeds' test "$status" -eq 0
check 'opens the newer one' contains "$LOG" "CREATE [--title] [${PREFIX}knob (jherrm/knobs ${NEWER:0:8})]"
check 'closes #73 for it' contains "$LOG" "CLOSE [73] [--comment] [jherrm/knobs changed Knob.js again: https://github.com/Nawid3333/FastStream/issues/99 replaces this one.]"
check "closes #74 only as vad-web's (up to date)" contains "$LOG" 'CLOSE [74] [--comment] [tools/vendored-sources.json has vad-web at'
check "not with knob's comment" lacks "$LOG" 'CLOSE [74] [--comment] [jherrm/knobs'

fixtures '[]'
changed ricky0123_vad "$NEW"
echo diverged > "$FIX/status_ricky0123_vad"
run 's5 diverged from the ref -> raised as a change' "$step"
check 'succeeds' test "$status" -eq 0
check 'opens it' contains "$LOG" "CREATE [--title] [${PREFIX}vad-web (ricky0123/vad ${NEW:0:8})]"

fixtures '[]'
: > "$FIX/newest_jherrm_knobs"
run 's6 no upstream commit for the path -> fails (the report step tells the owner)' "$step"
check 'fails' test "$status" -ne 0
check 'says so' contains "$FIX/out" 'jherrm/knobs has no commit that changed Knob.js.'

fixtures '[]'
echo '{"sources": []}' > "$FIX/work/tools/vendored-sources.json"
run 's7 an empty list -> fails' "$step"
check 'fails' test "$status" -ne 0
check 'says so' contains "$FIX/out" 'tools/vendored-sources.json lists no sources.'

finish
