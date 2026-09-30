#!/usr/bin/env bash
# Runs every workflow script test in this folder (*.test.sh; see lib.sh), and fails if
# any fails. `pnpm run test:workflows`; CI runs it in its workflows job.
set -uo pipefail
cd "$(dirname "$0")"
failed=()
for test in *.test.sh; do
  echo "== $test"
  bash "$test" || failed+=("$test")
done
if [ ${#failed[@]} -ne 0 ]; then
  echo "Failed: ${failed[*]}"
  exit 1
fi
echo 'All workflow script tests passed.'
