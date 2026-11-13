#!/usr/bin/env bash
# release.yml's "Check the tag is on main": a release is built and signed only from a commit
# of main. auto-release.yml pushes main and the tag together, tools/cut-release.mjs is run on
# main; a tag on any other commit (cut on a branch by mistake) stops the release before the
# install, the build and the signing. Runs the step in a real git repository, as the
# checkout leaves it: the tag's commit checked out, main as refs/remotes/origin/main.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script release.yml 'Check the tag is on main' > "$here/check.sh" || exit 1

repo=$here/repo
git init -q -b main "$repo"
g() { git -C "$repo" -c user.name=t -c user.email=t@example.invalid "$@"; }
g commit -q --allow-empty -m one
g tag -a v1.0.0.1 -m one
g commit -q --allow-empty -m two
g switch -q -c side
g commit -q --allow-empty -m side
g tag -a v1.0.0.2 -m side
g switch -q main
g update-ref refs/remotes/origin/main main

# at <tag>: runs the step with that tag checked out; its status is the test's.
at() {
  g checkout -q --detach "$1"
  (cd "$repo" && TAG=$1 run_step "$here/check.sh") > "$here/out" 2>&1
}
not() { ! "$@"; }

echo 'a tag on main'
check 'the step passes' at v1.0.0.1

echo 'a tag on a commit main does not have'
check 'the step fails' not at v1.0.0.2
check 'says why' contains "$here/out" 'v1.0.0.2'
check 'and what to do' contains "$here/out" 'not on main'

finish
