#!/usr/bin/env bash
# auto-release.yml's "Bump version, commit, tag, push": the next build number, past any
# whose tag exists (in the checkout, or only on the remote: a reverted release leaves its
# tag behind), and the commit and its tag in one atomic push, so a refused push leaves
# neither. The step runs in a folder of its own with the two version files; git is a
# stub that records its calls and answers `tag -l` and `ls-remote --tags` from $TAGS and
# $REMOTE_TAGS (or fails, with LS_REMOTE_FAILS).
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script auto-release.yml 'Bump version, commit, tag, push' > "$here/bump.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/git" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIX/calls"
case $1 in
  tag)
    if [ "$2" = -l ]; then
      for t in ${TAGS:-}; do case $t in $3) echo "$t" ;; esac; done
    fi ;;
  ls-remote)
    if [ -n "${LS_REMOTE_FAILS-}" ]; then echo 'fatal: unable to access' >&2; exit 128; fi
    for t in ${REMOTE_TAGS:-}; do
      case refs/tags/$t in $4) printf '0123abcd\trefs/tags/%s\n0123abce\trefs/tags/%s^{}\n' "$t" "$t" ;; esac
    done ;;
  add|commit|push) ;;
  *) echo "unexpected git $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$here/bin/git"

# scenario <name>: runs the step on package.json and chrome/manifest.json at 1.3.82.44.
scenario() {
  echo "$1"
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP" "$FIX/repo/chrome"
  : > "$FIX/calls"
  : > "$FIX/env"
  for f in package.json chrome/manifest.json; do
    printf '{\n  "name": "faststream",\n  "version": "1.3.82.44"\n}\n' > "$FIX/repo/$f"
  done
  (cd "$FIX/repo" && GITHUB_ENV=$FIX/env PATH="$here/bin:$PATH" run_step "$here/bump.sh") > "$FIX/out" 2>&1
  status=$?
}
version() { node -p "require('$FIX/repo/$1').version"; }

export TAGS='v1.3.82.43 v1.3.82.44' REMOTE_TAGS='v1.3.82.43 v1.3.82.44' LS_REMOTE_FAILS=''
scenario 'no tag in the way'
check 'succeeds' test "$status" -eq 0
check 'bumps both files to 1.3.82.45' test "$(version package.json) $(version chrome/manifest.json)" = '1.3.82.45 1.3.82.45'
check 'tags v1.3.82.45' contains "$FIX/calls" 'tag -a v1.3.82.45 -m FastStream 1.3.82.45'
check 'pushes the commit and the tag in one atomic push' contains "$FIX/calls" 'push --atomic origin HEAD:main refs/tags/v1.3.82.45'
check 'pushes nothing else' test "$(grep -c '^push' "$FIX/calls")" -eq 1
check 'hands the tag on' contains "$FIX/env" 'NEW_TAG=v1.3.82.45'

export TAGS='v1.3.82.44 v1.3.82.45'
scenario 'a reverted release: its tag is in the checkout'
check 'succeeds' test "$status" -eq 0
check 'says it skips it' contains "$FIX/out" 'v1.3.82.45 is taken; skipping it.'
check 'tags v1.3.82.46' contains "$FIX/calls" 'tag -a v1.3.82.46 -m FastStream 1.3.82.46'
check 'hands the tag on' contains "$FIX/env" 'NEW_TAG=v1.3.82.46'

export TAGS='v1.3.82.44' REMOTE_TAGS='v1.3.82.44 v1.3.82.45 v1.3.82.46'
scenario 'tags only on the remote'
check 'succeeds' test "$status" -eq 0
check 'tags v1.3.82.47' contains "$FIX/calls" 'tag -a v1.3.82.47 -m FastStream 1.3.82.47'
check 'bumps package.json to 1.3.82.47' test "$(version package.json)" = '1.3.82.47'

export TAGS='v1.3.82.44 v1.3.82.450' REMOTE_TAGS='v1.3.820.45'
scenario 'tags that only start or end like the next one'
check 'tags v1.3.82.45' contains "$FIX/calls" 'tag -a v1.3.82.45 -m FastStream 1.3.82.45'

export TAGS='v1.3.82.44' REMOTE_TAGS='' LS_REMOTE_FAILS=1
scenario 'the remote cannot be asked'
check 'fails' test "$status" -ne 0
check 'commits nothing' lacks "$FIX/calls" 'commit'
check 'pushes nothing' lacks "$FIX/calls" 'push'

finish
