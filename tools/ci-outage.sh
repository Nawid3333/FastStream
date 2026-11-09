#!/usr/bin/env bash
# ci-outage.sh <jobs.json> <failed.log>: whether a CI run failed only because GitHub or a
# download host did not answer, not because of the code. Prints one word:
#   outage   every failed job failed on an outage, by one of the signatures below
#   red      at least one failed job failed for another reason: an ordinary failure
#   unknown  no failed job, or a failed job whose log could not be read (a runner that was lost
#            leaves none): neither an outage to wait out nor a failure to blame on the update
# jobs.json is `gh run view --json jobs`; failed.log is `gh run view --log-failed` (a line is
# "<job>\t<step>\t<text>"). Cancelled jobs count for nothing: fail-fast or a newer run cancels
# them, and they have no failed log.
#
# Used by update-prs.yml (an outage starts CI again hours later instead of parking the update as
# needing code changes) and firefox-beta.yml (an outage opens no "Firefox Beta breaks" issue).
# On 2026-11-09 GitHub answered 504 for about ten minutes, and four update pull requests were
# parked as migrations, all four for nothing.
#
# The signatures, only from download steps, never a bare "504": the e2e specs test HTTP error
# answers themselves.
#   - "##[error]FS-OUTAGE ...": the runner's form of the ::error:: line our download steps print
#     once their tries are spent, and only for no answer, a 5xx, 408 or 429 (e2e-setup's
#     geckodriver, ci.yml's mpv). A 404, a wrong checksum or an archive that does not unpack is
#     an ordinary failure, printed without it.
#   - geckodriver's own download, should it run (the e2e setup gives it a cached copy): its
#     "Failed to download binary (statusCode 5xx)" or "Failed to fetch the latest Geckodriver
#     version (statusCode 5xx)".
#   - pnpm's "ERR_PNPM_FETCH_5xx": the npm registry's 5xx, after pnpm's own tries.
set -uo pipefail
jobs_json=$1
failed_log=$2
signature='##\[error\]FS-OUTAGE |Failed to download binary \(statusCode 5[0-9][0-9]\)|Failed to fetch the latest Geckodriver version \(statusCode 5[0-9][0-9]\)|ERR_PNPM_FETCH_5[0-9][0-9]'

mapfile -t failed < <(jq -r '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | .name' "$jobs_json")
if [ ${#failed[@]} = 0 ]; then
  echo unknown
  exit 0
fi
verdict=outage
for job in "${failed[@]}"; do
  text=$(awk -F '\t' -v job="$job" '$1 == job { sub(/^[^\t]*\t[^\t]*\t/, ""); print }' "$failed_log" 2> /dev/null)
  if [ -z "$text" ]; then
    verdict=unknown
  elif ! grep -qE "$signature" <<< "$text"; then
    echo red
    exit 0
  fi
done
echo "$verdict"
