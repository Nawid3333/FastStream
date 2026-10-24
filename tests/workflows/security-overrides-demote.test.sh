#!/usr/bin/env bash
# security-alerts.yml's publish step "Demote the alerts pnpm refused": when pnpm says no
# version fits a floor, the alerts the run took go back to the issue route - one "Security
# alert: <package>" issue each, with the alerts marker that keeps them there - and an open
# rolling override pull request is marked closed-by-run and closed. The plan and the install
# report are fixtures in the shape the check and install jobs write them; gh is stubbed and
# logs what the step creates, edits and closes.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
step_script security-alerts.yml 'Demote the alerts pnpm refused' > "$here/demote.sh" || exit 1

mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]}; fi
done
answer() { if [ -n "$jqf" ]; then jq -r "$jqf" <<< "$1"; else printf '%s\n' "$1"; fi; }
logged() {
  printf '%s' "$1"; shift; printf ' [%s]' "$@"; printf '\n'
  while [ $# -gt 0 ]; do
    if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
    shift
  done
}
case "$1 $2" in
  'issue list') answer "${FX_OPEN:-[]}" ;;
  'issue create') logged CREATE "${@:3}" >> "$LOG"; echo "https://github.com/o/r/issues/99" ;;
  'issue view') answer "{\"body\": $(jq -Rs . <<< "${FX_ISSUE_BODY:-}")}" ;;
  'issue edit') logged EDIT "${@:3}" >> "$LOG" ;;
  'issue comment') logged COMMENT "${@:3}" >> "$LOG" ;;
  'pr view') answer "{\"state\": \"${FX_PR_STATE:-OPEN}\", \"body\": \"the rolling pull request\"}" ;;
  'pr edit') logged PREDIT "${@:3}" >> "$LOG" ;;
  'pr close') logged PRCLOSE "${@:3}" >> "$LOG" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$here/bin/gh"

# The plan as check writes it (an object: alerts under .alerts), and install's report.
plan_json='{"lockfile": "pnpm-lock.yaml", "base_sha": "abc", "handled": [60, 61],
  "floors": [{"name": "minimist", "selector": "minimist", "floor": "^1.2.3", "alerts": [60, 61], "action": "add"}],
  "declined": [], "versions": {"minimist": ["1.2.2"]},
  "alerts": [{"number": 60, "package": "minimist", "manifest": "pnpm-lock.yaml", "severity": "high", "summary": "A flaw", "range": "< 1.2.3", "patched": "1.2.3"},
             {"number": 61, "package": "minimist", "manifest": "pnpm-lock.yaml", "severity": "low", "summary": "Another", "range": "< 1.2.3", "patched": "1.2.3"}]}'
report_json='{"failure_class": "deterministic", "failed": [{"package": "minimist", "selector": "minimist", "floor": "^1.2.3", "alerts": [60, 61], "reason": "nothing published satisfies it"}]}'

scenario() { # <name> <old pull request number> [NAME=value]...
  echo "$1"
  export FIX="$here/fix" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$FIX/tmp" "$FIX/work/plan" "$FIX/work/result"
  : > "$LOG"
  printf '%s\n' "$plan_json" > "$FIX/work/result/plan.json"
  printf '%s\n' "$report_json" > "$FIX/work/result/report.json"
  printf '{"number": %s, "head_sha": "", "alerts": []}\n' "$2" > "$FIX/work/plan/old-pr.json"
  shift 2
  (
    export GH_TOKEN=stub GH_REPO=o/r OWNER=owner PREFIX='Security alert: ' RUNNER_TEMP="$FIX/tmp"
    export ALERTS_URL=https://github.com/o/r/security/dependabot RUN_URL=https://github.com/o/r/actions/runs/1
    for kv in "$@"; do export "${kv?}"; done
    cd "$FIX/work" || exit 1
    PATH="$here/bin:$PATH" run_step "$here/demote.sh"
  ) > "$FIX/out" 2>&1
  status=$?
}

scenario 'd1 pnpm cannot install the floor -> the alerts get their issue, with the marker' 0
check 'succeeds' test "$status" -eq 0
check 'opens "Security alert: minimist", assigned' contains "$LOG" 'CREATE [--title] [Security alert: minimist] [--assignee] [owner]'
check 'a row per alert, from the plan' contains "$LOG" '| [60](https://github.com/o/r/security/dependabot/60) | high |'
check '(the second too)' contains "$LOG" '| [61](https://github.com/o/r/security/dependabot/61) | low |'
check 'says why' contains "$LOG" 'Why: nothing published satisfies it'
check 'the marker that keeps them there' contains "$LOG" '<!-- alerts: 60 61 -->'
check 'no pull request to close' lacks "$LOG" 'PRCLOSE'

scenario 'd2 with the rolling pull request open -> it is marked closed-by-run, then closed' 7
check 'succeeds' test "$status" -eq 0
check 'marks it' contains "$LOG" '<!-- security-overrides: closed-by-run -->'
check 'closes it' contains "$LOG" 'PRCLOSE [7]'

scenario 'd3 an open issue for the package already -> the alerts join its marker, with a comment' 0 \
  FX_OPEN='[{"number": 12, "title": "Security alert: minimist"}]' FX_ISSUE_BODY="$(printf 'text\n\n<!-- alerts: 55 -->')"
check 'succeeds' test "$status" -eq 0
check 'no second issue' lacks "$LOG" 'CREATE'
check 'the marker holds both' contains "$LOG" '<!-- alerts: 55 60 61 -->'
check 'and a comment says so' contains "$LOG" 'COMMENT [12]'

finish
