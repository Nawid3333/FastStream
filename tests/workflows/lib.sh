# Shared by the tests in this folder: sourced, not run.
#
# A test takes one step's `run:` script out of a workflow file and runs it as GitHub
# does (bash --noprofile --norc -eo pipefail), with `gh` (and `curl`, where a step calls
# it) replaced by a stub from the test's own folder. The stub answers from files the
# test writes and records every call, so a test checks what the step decided: which
# comment, issue or merge it asked for, and its exit status. Nothing reaches GitHub.
#
# Needs bash, awk and jq, as GitHub's Ubuntu runners have them: CI runs these in its
# workflows job, and on Windows they run in WSL (`bash tests/workflows/run.sh`).

set -uo pipefail

WORKFLOWS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.github/workflows" && pwd)
failures=0

# step_script <workflow file> <step name>: that step's `run: |` block, unindented.
# The step is found by its `- name:` line; the block ends at the first line indented
# less than its own first line. Fails when there is no such step, so a renamed step
# fails its test rather than testing nothing.
step_script() {
  local out
  out=$(awk -v name="$2" '
    !found && $0 ~ /^ +- name: / && substr($0, index($0, "- name: ") + 8) == name { found = 1; next }
    found && !block && /^ +- name: / { exit }
    found && !block && /^ +run: \|$/ { block = 1; next }
    block {
      if ($0 ~ /^ *$/) { print ""; next }
      match($0, /^ */)
      if (!indent) indent = RLENGTH
      if (RLENGTH < indent) exit
      print substr($0, indent + 1)
    }' "$WORKFLOWS_DIR/$1")
  if [ -z "$out" ]; then
    echo "no step \"$2\" with a run: | block in $1" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

# run_step <script file>: runs it as GitHub runs a step; its output and status are the
# caller's.
run_step() {
  bash --noprofile --norc -eo pipefail "$1"
}

# check <what> <command...>: runs the command, and counts a failure when it fails.
check() {
  local what=$1
  shift
  if "$@"; then
    echo "  ok    $what"
  else
    echo "  FAIL  $what"
    failures=$((failures + 1))
  fi
}

# contains <file> <text>: whether the file holds the text, literally; lacks: whether not.
contains() {
  grep -qF -- "$2" "$1"
}

lacks() {
  ! grep -qF -- "$2" "$1"
}

# finish: the test's exit status, from its checks.
finish() {
  if [ "$failures" -ne 0 ]; then
    echo "$failures check(s) failed"
    exit 1
  fi
}
