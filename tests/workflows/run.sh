#!/usr/bin/env bash
# Runs every workflow script test in this folder (*.test.sh; see lib.sh), and fails if
# any fails. `pnpm run test:workflows`; CI runs it in its workflows job.
#
# Each test has TestSeconds: a hung one fails here, named, with the log kept. The job's
# own time limit cancels the run instead, and auto-release takes a cancelled run on main
# for one cancelled by hand: nothing was released and no one was told.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
TestSeconds=120
failed=()
for test in *.test.sh; do
  echo "== $test"
  timeout "$TestSeconds" bash "$test" < /dev/null
  status=$?
  [ "$status" -eq 124 ] && echo "$test did not end within $TestSeconds s"
  [ "$status" -eq 0 ] || failed+=("$test")
done
if [ ${#failed[@]} -ne 0 ]; then
  echo "Failed: ${failed[*]}"
  exit 1
fi
echo 'All workflow script tests passed.'
