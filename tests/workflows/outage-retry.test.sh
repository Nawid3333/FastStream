#!/usr/bin/env bash
# outage-retry.yml: waits, then starts CI on an update branch again, only while its open pull
# request is still at the commit; a call that fails is tried again; when CI cannot be started,
# its second step comments on the pull request. gh and sleep are stubbed.
source "$(dirname "$0")/lib.sh"
here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script outage-retry.yml 'Wait, then start CI' > "$here/step.sh" || exit 1
step_script outage-retry.yml 'Tell the owner CI did not start' > "$here/tell.sh" || exit 1
checks=0
fails=0
mkdir -p "$here/bin"
# gh: `pr list` answers from $here/prs.json; a call fails while $here/fail-<pr|workflow> holds
# a count above 0 (each failure takes one off), or always when it holds "always".
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HERE/gh.log"
what=$1
f=$HERE/fail-$what
if [ -f "$f" ]; then
  n=$(cat "$f")
  if [ "$n" = always ]; then echo "stub gh: HTTP 504" >&2; exit 1; fi
  if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$f"; echo "stub gh: HTTP 504" >&2; exit 1; fi
fi
case "$1 $2" in
  'pr list')
    e=''; prev=''; for a in "$@"; do if [ "$prev" = --jq ]; then e=$a; fi; prev=$a; done
    jq -r "$e" "$HERE/prs.json"
    ;;
  'workflow run'|'pr comment') ;;
  *) echo "stub gh: unhandled: $*" >&2; exit 99 ;;
esac
EOF
printf '#!/usr/bin/env bash\necho "sleep $1" >> "$HERE/gh.log"\n' > "$here/bin/sleep"
chmod +x "$here/bin/gh" "$here/bin/sleep"
export HERE=$here PATH="$here/bin:$PATH" GH_TOKEN=x GH_REPO=me/fs OWNER=nawid SELF_URL=https://github.com/me/fs/actions/runs/9

sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
setup() { # <branch> <sha> <delay> [the pull request's head]
  rm -f "$here"/fail-* "$here/gh.log" "$here/out" "$here/output"
  : > "$here/gh.log"; : > "$here/output"
  export BRANCH=$1 SHA=$2 DELAY=$3 GITHUB_OUTPUT=$here/output RUNNER_TEMP=$here
  jq -n --arg h "${4:-$sha}" '[{headRefOid: $h, isCrossRepository: false}]' > "$here/prs.json"
}
run() { rc=0; (cd "$here" && timeout 30 bash -e "$1") > "$here/out" 2>&1 || rc=$?; }
expect() { # <description> <command...>
  checks=$((checks + 1))
  if "${@:2}"; then printf '  ok    %s\n' "$1"; else
    printf '  FAIL  %s\n' "$1"; sed 's/^/        /' "$here/out" "$here/gh.log"; fails=$((fails + 1)); fi
}
called() { grep -qxF -- "$1" "$here/gh.log"; }
not_called() { ! grep -qF -- "$1" "$here/gh.log"; }
valid() { grep -qx 'valid=true' "$here/output"; }

branch=dependabot/npm_and_yarn/tooling-minor-and-patch-0123abcd
setup "$branch" "$sha" 10800
run "$here/step.sh"
expect 'still at the commit: exit 0' test "$rc" = 0
expect 'waits the delay' called 'sleep 10800'
expect 'starts CI on the branch' called "workflow run ci.yml --ref $branch"

setup "$branch" "$sha" 10800 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
run "$here/step.sh"
expect 'moved on: exit 0' test "$rc" = 0
expect 'moved on: no CI' not_called 'workflow run'

setup "$branch" "$sha" 10800
jq -n --arg h "$sha" '[{headRefOid: $h, isCrossRepository: true}]' > "$here/prs.json"
run "$here/step.sh"
expect "only a fork's pull request at the commit: no CI" not_called 'workflow run'

setup "$branch" "$sha" 10800
echo 2 > "$here/fail-pr"
echo 1 > "$here/fail-workflow"
run "$here/step.sh"
expect 'calls that fail are tried again: exit 0' test "$rc" = 0
expect 'after a minute, then two' bash -c 'grep -qx "sleep 60" "$0" && grep -qx "sleep 120" "$0"' "$here/gh.log"
expect 'starts CI in the end' test "$(grep -c '^workflow run ci.yml' "$here/gh.log")" = 2
expect 'warns of each failed call' grep -qF '::warning::gh pr list failed; trying again in 60 s.' "$here/out"

setup "$branch" "$sha" 10800
echo always > "$here/fail-workflow"
run "$here/step.sh"
expect 'CI never starts: the step fails' test "$rc" != 0
expect 'five tries' test "$(grep -c '^workflow run ci.yml' "$here/gh.log")" = 5
expect 'valid inputs: the comment step runs' valid
run "$here/tell.sh"
expect 'the comment is posted' called "pr comment $branch --body-file $here/body.md"
expect 'it @mentions the owner and says what to do' grep -qF '@nawid CI was to run again on this pull request after an outage, but could not be started (https://github.com/me/fs/actions/runs/9). Start it on this branch' "$here/body.md"

for bad in 'main' 'feature/x' 'dependabot/../main' 'dependabot/x y' 'dependabot/$(id)' '42'; do
  setup "$bad" "$sha" 10800
  run "$here/step.sh"
  expect "branch '$bad' refused, nothing called, no comment step" bash -c '[ "$0" != 0 ] && ! [ -s "$1/gh.log" ] && ! grep -q valid "$1/output"' "$rc" "$here"
done
for bad in "${sha:0:39}" "${sha}0" 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; do
  setup "$branch" "$bad" 10800
  run "$here/step.sh"
  expect "sha '$bad' refused" bash -c '[ "$0" != 0 ] && ! [ -s "$1/gh.log" ]' "$rc" "$here"
done
for bad in 18001 -1 '' 1e3; do
  setup "$branch" "$sha" "$bad"
  run "$here/step.sh"
  expect "delay '$bad' refused" bash -c '[ "$0" != 0 ] && ! [ -s "$1/gh.log" ]' "$rc" "$here"
done

printf '%s checks, %s failed\n' "$checks" "$fails"
[ "$fails" = 0 ]
