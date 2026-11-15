#!/usr/bin/env bash
# patched-libraries.yml's publish job: what the re-cut job handed on becomes a branch, a pull
# request and CI runs (a clean re-cut), or an issue (a stopped one). The re-cut job ran a new
# release's code, so what it hands on is checked first: a patch that changes anything a re-cut
# may not change, or a library name that is no npm name, stops the run with nothing pushed or
# opened. The step's script, a real git repository with a bare one as origin, and stubs for
# gh and for node (the update checker).
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script patched-libraries.yml 'Sync update pull requests and issues with the patched versions' > "$here/publish.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
case "$1 $2" in
  'issue list'|'pr list') ;;
  'pr create'|'issue create'|'workflow run'|'issue close'|'pr close') ;;
  'api repos/o/r/issues?state=all&per_page=100') ;;
  *) echo "unexpected gh $*" >&2; exit 99 ;;
esac
EOF
# The update checker: nothing is behind any more (the re-cut job decided what to do).
cat > "$here/bin/node" <<'EOF'
#!/usr/bin/env bash
if [ "${2-}" = --json ]; then
  printf '{"name":"hls.js","current":"1.7.4","latest":"1.7.5","behind":true}\n'
else
  echo 'hls.js 1.7.4 (latest 1.7.5)'
fi
EOF
chmod +x "$here/bin/gh" "$here/bin/node"

# repo: main with the files a re-cut changes, and a bare origin.
make_repo() {
  rm -rf "$here/origin.git" "$here/repo"
  git init -q --bare "$here/origin.git"
  git init -q -b main "$here/repo"
  (
    cd "$here/repo" || exit 1
    git config user.name t
    git config user.email t@example.invalid
    mkdir -p patches .github/workflows tools
    echo '{}' > package.json
    echo 'lock 1' > pnpm-lock.yaml
    echo 'patched: 1' > pnpm-workspace.yaml
    echo 'old' > patches/hls.js@1.7.4.patch
    echo 'on: push' > .github/workflows/ci.yml
    git add -A
    git commit -q -m main
    git remote add origin "$here/origin.git"
    git push -q origin main
  )
}

# recut <n> <library json> <outcome> [files to change...]: what the re-cut job hands on.
recut() {
  local n=$1 library=$2 outcome=$3
  shift 3
  local dir="$here/fix/tmp/recuts/$n"
  mkdir -p "$dir"
  printf '%s\n' "$library" > "$dir/library.json"
  echo "report of $n" > "$dir/report.txt"
  echo "$outcome" > "$dir/outcome"
  if [ "$outcome" = cut ]; then
    (
      cd "$here/repo" || exit 1
      git checkout -q -b tmp
      for file in "$@"; do echo "changed $n" > "$file"; git add -A -- "$file"; done
      git commit -q -m "deps: re-cut $n"
      git format-patch -1 --stdout > "$dir/change.patch"
      git checkout -q main
      git branch -q -D tmp
    )
  fi
}

reset() {
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$FIX/calls"
  make_repo
}

run() {
  echo "$1"
  (cd "$here/repo" && GH_TOKEN=t GITHUB_REPOSITORY=o/r GITHUB_SHA=abc PREFIX='Patched library update: ' EVENT=${EVENT:-schedule} \
    RUN_URL=https://github.com/o/r/actions/runs/9 PATH="$here/bin:$PATH" run_step "$here/publish.sh") > "$FIX/out" 2>&1
  status=$?
}
pushed() { git --git-dir="$here/origin.git" rev-parse -q --verify "refs/heads/$1" > /dev/null; }
not_pushed() { ! pushed "$1"; }

HLS='{"name":"hls.js","current":"1.7.4","latest":"1.7.5","url":"https://example.invalid/hls","behind":true}'
DASH='{"name":"dashjs","current":"5.3.0","latest":"5.4.0","url":"https://example.invalid/dash","behind":true}'

reset
recut 1 "$HLS" cut pnpm-lock.yaml patches/hls.js@1.7.4.patch
recut 2 "$DASH" stopped
run 'a clean re-cut and a stopped one'
check 'succeeds' test "$status" -eq 0
check 'pushes the branch with the re-cut' pushed 'patched/hls.js-1.7.5'
check 'the branch holds the change' test "$(git --git-dir="$here/origin.git" show 'patched/hls.js-1.7.5:pnpm-lock.yaml')" = 'changed 1'
check 'opens the pull request' contains "$FIX/calls" 'pr create --base main --head patched/hls.js-1.7.5 --title Patched library update: hls.js 1.7.5'
check 'starts CI and the dependency review on it' contains "$FIX/calls" 'workflow run ci.yml --ref patched/hls.js-1.7.5'
check 'opens the issue for the stopped one' contains "$FIX/calls" 'issue create --title Patched library update: dashjs 5.4.0'
check 'pushes nothing for the stopped one' not_pushed 'patched/dashjs-5.4.0'

reset
recut 1 "$HLS" cut pnpm-lock.yaml .github/workflows/ci.yml
run 'a re-cut that changes a workflow'
check 'fails' test "$status" -ne 0
check 'says what it changed' contains "$FIX/out" '.github/workflows/ci.yml'
check 'pushes nothing' not_pushed 'patched/hls.js-1.7.5'
check 'opens nothing' lacks "$FIX/calls" 'create'

reset
recut 1 '{"name":"hls.js;touch x","current":"1.7.4","latest":"1.7.5","url":"u"}' stopped
run 'a library name that is no npm name'
check 'fails' test "$status" -ne 0
check 'opens nothing' lacks "$FIX/calls" 'create'

reset
recut 1 '{"name":"@scope/lib","current":"1.0.0","latest":"1.0.1-beta.2","url":"u"}' stopped
run 'a scoped name and a pre-release'
check 'succeeds' test "$status" -eq 0
check 'opens the issue' contains "$FIX/calls" 'issue create --title Patched library update: @scope/lib 1.0.1-beta.2'

reset
run 'nothing handed on'
check 'succeeds' test "$status" -eq 0
check 'opens nothing' lacks "$FIX/calls" 'create'

reset
recut 1 "$HLS" cut pnpm-lock.yaml
EVENT=push run 'a push: only closes'
check 'succeeds' test "$status" -eq 0
check 'publishes nothing' lacks "$FIX/calls" 'create'

finish
