#!/usr/bin/env bash
# security-alerts.yml's job "watch", the daily look at the update pull requests (2026-10-20):
# it closes the migration issues of pull requests merged or closed since, starts
# update-prs.yml again on a pull request it held back for new releases once they are 3 days
# old, and opens, updates or closes the one issue "Update pull requests piling up" (a
# Dependabot entry at its open-pull-requests-limit minus 2, or an update red for over 14
# days). Fixtures stand in for the issues, pull requests, comments, events and
# .github/dependabot.yml; the stub gh logs what the steps create, edit, close and start.
source "$(dirname "$0")/lib.sh"

here=$(mktemp -d)
trap 'rm -rf "$here"' EXIT
repo=$(cd "$(dirname "$0")/../.." && pwd)
close_step=$here/close.sh
again_step=$here/again.sh
pile_step=$here/pile.sh
report_step=$here/report.sh
step_script security-alerts.yml 'Close the migration issues of closed pull requests' > "$close_step" || exit 1
step_script security-alerts.yml 'Decide again on update pull requests held for new releases' > "$again_step" || exit 1
step_script security-alerts.yml 'Open, update or close the piling-up issue' > "$pile_step" || exit 1
step_script security-alerts.yml "Report the watch's own failure" > "$report_step" || exit 1

# gh: FX_ISSUES (the open ones), FX_PRS, FX_COMMENTS_<n>, FX_EVENTS_<n> and the file
# FX_DEPENDABOT, through the real jq; a pull request's state is STATE_PR_<n> (OPEN if unset).
# What changes something is logged to $LOG, with the body file; anything unexpected fails.
mkdir -p "$here/bin"
cat > "$here/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
jqf=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --jq ]; then jqf=${args[i + 1]}; fi
done
answer() {
  if [ -n "$jqf" ]; then jq -r "$jqf" <<< "$1"; else printf '%s\n' "$1"; fi
}
logged() {
  printf '%s' "$1"; shift; printf ' [%s]' "$@"; printf '\n'
  while [ $# -gt 0 ]; do
    if [ "$1" = --body-file ]; then echo '--- body:'; cat "$2"; echo '--- end body'; fi
    shift
  done
}
case "$1 $2" in
  'issue list') answer "$(jq -c '[.[] | select(.state == "open")]' <<< "$FX_ISSUES")" ;;
  'issue create')
    logged CREATE "${@:3}" >> "$LOG"
    echo "https://github.com/$GH_REPO/issues/99" ;;
  'issue edit') logged EDIT "${@:3}" >> "$LOG" ;;
  'issue close')
    logged CLOSE "${@:3}" >> "$LOG"
    if [ -n "${FX_CLOSE_FAILS:-}" ]; then echo 'stub gh: could not close' >&2; exit 1; fi ;;
  'issue comment') logged COMMENT "${@:3}" >> "$LOG" ;;
  'pr list') answer "$FX_PRS" ;;
  'pr view')
    echo "PRVIEW $3" >> "$LOG"
    state=STATE_PR_$3
    if [ "${!state:-}" = FAIL ]; then echo 'stub gh: HTTP 502' >&2; exit 1; fi
    answer "{\"state\": \"${!state:-OPEN}\"}" ;;
  'workflow run') logged DISPATCH "${@:3}" >> "$LOG" ;;
  'api -H')
    [ "$4" = "repos/$GH_REPO/contents/.github/dependabot.yml?ref=main" ] || { echo "stub gh: unexpected api path $4" >&2; exit 2; }
    if [ -n "${FX_DEPENDABOT_FAIL:-}" ]; then echo 'stub gh: HTTP 502' >&2; exit 1; fi
    cat "$FX_DEPENDABOT" ;;
  'api --paginate')
    case "$3" in
      "repos/$GH_REPO/issues/"*/comments)
        n=${3#"repos/$GH_REPO/issues/"}; n=${n%/comments}
        echo "COMMENTS $n" >> "$LOG"
        v=FX_COMMENTS_$n
        answer "${!v:-[]}" ;;
      "repos/$GH_REPO/issues/"*"/events?per_page=100")
        n=${3#"repos/$GH_REPO/issues/"}; n=${n%/events*}
        echo "EVENTS $n" >> "$LOG"
        v=FX_EVENTS_$n
        answer "${!v:-[]}" ;;
      *) echo "stub gh: unexpected api path $3" >&2; exit 2 ;;
    esac ;;
  *)
    echo "stub gh: unexpected call: $*" >&2; exit 2 ;;
esac
EOF
# date -u +%s is $NOW; anything else, the real date.
cat > "$here/bin/date" <<EOF
#!/usr/bin/env bash
if [ "\$*" = '-u +%s' ]; then echo "\$NOW"; else exec $(command -v date) "\$@"; fi
EOF
chmod +x "$here/bin/gh" "$here/bin/date"

# The job's env: block, as GitHub would set it.
export GH_TOKEN=stub GH_REPO='Nawid3333/FastStream' OWNER='Nawid3333'
export RUN_URL='https://github.com/Nawid3333/FastStream/actions/runs/1'
export NOW=1792500000   # 2026-10-20T12:40:00Z
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
other=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# iss <number> <title> <body> [author] [state]: an issue as gh issue list gives it.
iss() {
  jq -nc --argjson n "$1" --arg t "$2" --arg b "$3" --arg a "${4:-app/github-actions}" --arg s "${5:-open}" \
    '{number: $n, title: $t, body: $b, author: {login: $a}, state: $s}'
}
# pull <number> <branch> [author] [labels, comma-separated] [cross-repository] [head]: an
# open pull request as gh pr list gives it.
pull() {
  jq -nc --argjson n "$1" --arg b "$2" --arg a "${3:-app/dependabot}" --arg l "${4-}" --argjson x "${5:-false}" --arg h "${6:-$sha}" \
    '{number: $n, headRefName: $b, headRefOid: $h, author: {login: $a}, isCrossRepository: $x,
      labels: [$l | split(",")[] | select(. != "") | {name: .}]}'
}
# cmt <login> <body>: an issue comment.
cmt() {
  jq -nc --arg u "$1" --arg b "$2" '{user: {login: $u}, body: $b}'
}
# ev <event> <label> <created_at>: an issue event.
ev() {
  jq -nc --arg e "$1" --arg l "$2" --arg c "$3" '{event: $e, label: {name: $l}, created_at: $c, actor: {login: "github-actions[bot]"}}'
}
arr() {
  local IFS=,
  echo "[$*]"
}
# count <file> <text> <n>: whether the text is on exactly n of the file's lines.
count() {
  [ "$(grep -cF -- "$2" "$1")" = "$3" ]
}
# n Dependabot pull requests from number <first> on, on <prefix><i>.
prs() { # <first> <n> <branch prefix>
  local i out=()
  for ((i = 0; i < $2; i++)); do out+=("$(pull $(($1 + i)) "$3$i-1.0.0")"); done
  local IFS=,
  echo "${out[*]}"
}

# A dependabot.yml shaped as the real one, with each way of naming directories and a limit.
fixture_yml=$here/dependabot.yml
cat > "$fixture_yml" <<'EOF'
version: 2
updates:
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
    open-pull-requests-limit: 10
    groups:
      tooling:
        patterns: ['*']
    ignore:
      - dependency-name: 'hls.js'

  # fsaunpack: its own lockfile
  - package-ecosystem: npm
    directory: "/fsaunpack"  # the helper
    open-pull-requests-limit: 5

  - package-ecosystem: 'github-actions'
    directories:
      - '/'
      - '/.github/actions/*'  # composite actions
    labels:
      - 'dependencies'

  - package-ecosystem: 'docker'
    directories:
      - '/.github/actionlint'
      # a comment inside the list, which ended it (glm's review, 2026-10-22)
      - '/.github/zizmor'
    open-pull-requests-limit: 2
EOF

# scenario <name> <step file> [NAME=value]...: runs the step with those fixtures; $status is
# its exit status, $LOG the stub's log, $FIX/out the step's output.
scenario() {
  echo "$1"
  local step=$2
  shift 2
  export FIX="$here/fix" RUNNER_TEMP="$here/fix/tmp" LOG="$here/fix/log"
  rm -rf "$FIX"
  mkdir -p "$RUNNER_TEMP"
  : > "$LOG"
  (
    export FX_ISSUES='[]' FX_PRS='[]' FX_DEPENDABOT="$fixture_yml" TITLE='Update pull requests piling up'
    for kv in "$@"; do export "${kv?}"; done
    PATH="$here/bin:$PATH" run_step "$step"
  ) > "$FIX/out" 2>&1
  status=$?
}

# --- Closing the migration issues of pull requests merged or closed since.

scenario 'm1 merged, closed, still open, no marker, someone else'"'"'s, not a migration issue' "$close_step" \
  FX_ISSUES="$(arr "$(iss 700 'Migration: eslint 11.0.0' $'x\n\n<!-- migration-pr: 42 -->')" \
    "$(iss 701 'Migration: pnpm 13.0.0' '<!-- migration-pr: 43 -->')" \
    "$(iss 702 'Migration: vitest 6.0.0' '<!-- migration-pr: 44 -->')" \
    "$(iss 703 'Migration: x 1.0.0' 'no marker')" \
    "$(iss 704 'Migration: y 1.0.0' '<!-- migration-pr: 45 -->' Nawid3333)" \
    "$(iss 705 'Something else' '<!-- migration-pr: 46 -->')" \
    "$(iss 706 'Migration: z 1.0.0' '<!-- migration-pr: 47 -->' app/github-actions closed)")" \
  STATE_PR_42=MERGED STATE_PR_43=CLOSED STATE_PR_45=MERGED STATE_PR_46=MERGED STATE_PR_47=CLOSED
check 'succeeds' test "$status" -eq 0
check 'closes #700: its pull request was merged' contains "$LOG" \
  'CLOSE [700] [--reason] [completed] [--comment] [#42 was merged. Closing.]'
check 'closes #701: its pull request was closed' contains "$LOG" \
  "CLOSE [701] [--reason] [not planned] [--comment] [#43 was closed without a merge. Closing.]"
check 'closes nothing else' count "$LOG" 'CLOSE [' 2
check 'asks only about the pull requests of its open migration issues' test "$(grep '^PRVIEW' "$LOG" | tr '\n' ' ')" = 'PRVIEW 42 PRVIEW 43 PRVIEW 44 '

scenario 'm1b a pull request that cannot be read, a close refused -> the others all the same' "$close_step" \
  FX_ISSUES="$(arr "$(iss 700 'Migration: a 1.0.0' '<!-- migration-pr: 42 -->')" "$(iss 701 'Migration: b 1.0.0' '<!-- migration-pr: 43 -->')" \
    "$(iss 702 'Migration: c 1.0.0' '<!-- migration-pr: 44 -->')")" \
  STATE_PR_42=FAIL STATE_PR_43=MERGED STATE_PR_44=CLOSED FX_CLOSE_FAILS=1
check 'succeeds' test "$status" -eq 0
check 'warns about #42' contains "$FIX/out" '#42 could not be read; #700 waits for the next run.'
check 'tries #701 and #702' count "$LOG" 'CLOSE [' 2

scenario 'm2 no migration issue -> nothing' "$close_step"
check 'succeeds' test "$status" -eq 0
check 'touches nothing' test ! -s "$LOG"

# --- Deciding again on a pull request held back for package versions under 3 days old.

due=$((NOW - 60))
later=$((NOW + 3600))
look() { # <time> <run> <commit>: update-prs.yml's comment holding a pull request back
  printf '@Nawid3333 CI passes on this pull request. Look at this before merging:\n\n- its lockfile adds package versions under 3 days old\n\nThe youngest ...\n<!-- update-prs-recheck: %s %s %s -->\n\n<sub>x</sub>\n<!-- update-prs: look -->\n' "$1" "$2" "$3"
}
p42=$(pull 42 dependabot/npm_and_yarn/tooling-minor-and-patch-0123abcd)

scenario 'r1 old enough now, same commit -> update-prs.yml starts again on that run' "$again_step" \
  FX_PRS="$(arr "$p42")" \
  FX_COMMENTS_42="$(arr "$(cmt 'github-actions[bot]' $'red\n<!-- update-prs: red 0123456789ab -->')" "$(cmt 'github-actions[bot]' "$(look $due 555 $sha)")")"
check 'succeeds' test "$status" -eq 0
check 'starts update-prs.yml on main, with the run and the branch' contains "$LOG" \
  'DISPATCH [update-prs.yml] [--ref] [main] [-f] [run_id=555] [-f] [branch=dependabot/npm_and_yarn/tooling-minor-and-patch-0123abcd]'
check 'once' count "$LOG" 'DISPATCH' 1

scenario 'r2 exactly at its time -> starts it' "$again_step" \
  FX_PRS="$(arr "$p42")" FX_COMMENTS_42="$(arr "$(cmt 'github-actions[bot]' "$(look $NOW 555 $sha)")")"
check 'starts it' count "$LOG" 'DISPATCH' 1

scenario 'r3 not old enough yet -> nothing' "$again_step" \
  FX_PRS="$(arr "$p42")" FX_COMMENTS_42="$(arr "$(cmt 'github-actions[bot]' "$(look $later 555 $sha)")")"
check 'succeeds' test "$status" -eq 0
check 'starts nothing' lacks "$LOG" 'DISPATCH'
check 'says when' contains "$FIX/out" '#42: its youngest new package version is 3 days old at 2026-10-20 13:40 UTC.'

scenario 'r4 the branch moved on -> its own CI run decides' "$again_step" \
  FX_PRS="$(arr "$p42")" FX_COMMENTS_42="$(arr "$(cmt 'github-actions[bot]' "$(look $due 555 $other)")")"
check 'starts nothing' lacks "$LOG" 'DISPATCH'
check 'says why' contains "$FIX/out" '#42 moved on from bbbbbbbb'

scenario 'r5 a later verdict without the marker -> nothing' "$again_step" \
  FX_PRS="$(arr "$p42")" \
  FX_COMMENTS_42="$(arr "$(cmt 'github-actions[bot]' "$(look $due 555 $sha)")" "$(cmt 'github-actions[bot]' $'ready\n<!-- update-prs: ready -->')")"
check 'starts nothing' lacks "$LOG" 'DISPATCH'

scenario "r6 the marker in someone else's comment, or in one not update-prs.yml's -> nothing" "$again_step" \
  FX_PRS="$(arr "$p42")" \
  FX_COMMENTS_42="$(arr "$(cmt 'github-actions[bot]' $'look\n<!-- update-prs: look -->')" "$(cmt Nawid3333 "$(look $due 556 $sha)")" \
    "$(cmt 'github-actions[bot]' "$(look $due 557 $sha | sed '/<!-- update-prs: look -->/d')")")"
check 'starts nothing' lacks "$LOG" 'DISPATCH'

scenario "r7 a fork's pull request, a branch that is no update -> not looked at" "$again_step" \
  FX_PRS="$(arr "$(pull 43 dependabot/npm_and_yarn/x-1.0.0 mallory '' true)" "$(pull 44 feature/x Nawid3333)")" \
  FX_COMMENTS_43="$(arr "$(cmt 'github-actions[bot]' "$(look $due 555 $sha)")")" \
  FX_COMMENTS_44="$(arr "$(cmt 'github-actions[bot]' "$(look $due 555 $sha)")")"
check 'succeeds' test "$status" -eq 0
check 'reads no comments' lacks "$LOG" 'COMMENTS'
check 'starts nothing' lacks "$LOG" 'DISPATCH'

scenario 'r8 two held back, one due -> one start' "$again_step" \
  FX_PRS="$(arr "$p42" "$(pull 50 patched/hls.js-1.8.0 app/github-actions)" "$(pull 51 toolchain/pnpm-13.0.0 app/github-actions)")" \
  FX_COMMENTS_42="$(arr "$(cmt 'github-actions[bot]' "$(look $later 555 $sha)")")" \
  FX_COMMENTS_50="$(arr "$(cmt 'github-actions[bot]' "$(look $due 600 $sha)")")"
check 'starts the due one' contains "$LOG" 'DISPATCH [update-prs.yml] [--ref] [main] [-f] [run_id=600] [-f] [branch=patched/hls.js-1.8.0]'
check 'only that one' count "$LOG" 'DISPATCH' 1
check 'reads each update branch' test "$(grep -c '^COMMENTS' "$LOG")" -eq 3

# --- The issue "Update pull requests piling up".

scenario 'p1 the real .github/dependabot.yml is read as the step expects' "$pile_step" \
  FX_DEPENDABOT="$repo/.github/dependabot.yml"
check 'succeeds' test "$status" -eq 0
grep -P '^[a-z-]+\t' "$FIX/out" > "$here/entries.tsv" || true
check 'an entry per package-ecosystem' \
  test "$(wc -l < "$here/entries.tsv")" -eq "$(grep -c '^  - package-ecosystem:' "$repo/.github/dependabot.yml")"
check 'their ecosystems, in order' test "$(cut -f1 "$here/entries.tsv" | tr '\n' ' ')" = \
  "$(sed -n "s/^  - package-ecosystem: *['\"]\{0,1\}\([a-z-]*\).*/\1/p" "$repo/.github/dependabot.yml" | tr '\n' ' ')"
check 'their limits, in order (every entry names one)' test "$(cut -f3 "$here/entries.tsv" | tr '\n' ' ')" = \
  "$(sed -n 's/^    open-pull-requests-limit: *\([0-9]*\).*/\1/p' "$repo/.github/dependabot.yml" | tr '\n' ' ')"
check 'every entry has a directory' bash -c '! cut -f2 "$0" | grep -qx ""' "$here/entries.tsv"
check 'the root npm entry' grep -qxP 'npm\t/\t\d+' "$here/entries.tsv"
check 'the github-actions one, both directories' grep -qxP "github-actions\t/ /\.github/actions/\*\t\d+" "$here/entries.tsv"
check 'nothing open -> no issue' test ! -s "$LOG"

scenario 'p2 the fixture: quotes, comments, a list of directories, no limit' "$pile_step"
check 'npm /, 10' contains "$FIX/out" $'npm\t/\t10'
check 'npm /fsaunpack, 5, its comment left out' contains "$FIX/out" $'npm\t/fsaunpack\t5'
check "github-actions, Dependabot's default 5" contains "$FIX/out" $'github-actions\t/ /.github/actions/*\t5'
check 'docker, 2' contains "$FIX/out" $'docker\t/.github/actionlint /.github/zizmor\t2'
check 'ignore list and labels are no directories' lacks "$FIX/out" 'dependency-name'

scenario 'p3 npm / at its limit minus 2 -> one issue' "$pile_step" \
  FX_PRS="[$(prs 1 8 dependabot/npm_and_yarn/pkg)]"
check 'succeeds' test "$status" -eq 0
check 'opens the issue, assigned to the owner' contains "$LOG" \
  'CREATE [--title] [Update pull requests piling up] [--assignee] [Nawid3333] [--body-file]'
check 'once' count "$LOG" 'CREATE [' 1
check 'mentions the owner' contains "$LOG" '@Nawid3333 Update pull requests are piling up'
check 'the row' contains "$LOG" '| npm | `/` | 8 | 10 | #1, #2, #3, #4, #5, #6, #7, #8 |'
check 'says what Dependabot does at the limit' contains "$LOG" 'Dependabot opens no more for it, not even for a new release'
check 'no red table' lacks "$LOG" 'Red for more than 14 days'

scenario 'p4 npm / at 7 -> nothing' "$pile_step" FX_PRS="[$(prs 1 7 dependabot/npm_and_yarn/pkg)]"
check 'succeeds' test "$status" -eq 0
check 'touches no issue' test ! -s "$LOG"

scenario "p5 fsaunpack's own, a group of it, and a root package named like it" "$pile_step" \
  FX_PRS="[$(prs 1 7 dependabot/npm_and_yarn/pkg),$(pull 20 dependabot/npm_and_yarn/fsaunpack/express-5.3.0),$(pull 21 dependabot/npm_and_yarn/fsaunpack/npm_and_yarn-261303d76f),$(pull 22 dependabot/npm_and_yarn/fsaunpack-tools-1.0.0)]"
check 'fsaunpack has 2: no row' lacks "$LOG" '`/fsaunpack`'
check 'the root has 8 with the look-alike' contains "$LOG" '| npm | `/` | 8 | 10 | #1, #2, #3, #4, #5, #6, #7, #22 |'

scenario 'p6 fsaunpack at 3 of 5' "$pile_step" \
  FX_PRS="[$(pull 20 dependabot/npm_and_yarn/fsaunpack/express-5.3.0),$(pull 21 dependabot/npm_and_yarn/fsaunpack/npm_and_yarn-261303d76f),$(pull 23 dependabot/npm_and_yarn/fsaunpack/qs-6.15.0)]"
check 'its row' contains "$LOG" '| npm | `/fsaunpack` | 3 | 5 | #20, #21, #23 |'
check 'no row for the root' lacks "$LOG" '| npm | `/` |'

scenario 'p7 github-actions: the root, a composite action and a group, 3 of 5' "$pile_step" \
  FX_PRS="[$(pull 30 dependabot/github_actions/actions/checkout-7.0.2),$(pull 31 dependabot/github_actions/dot-github/actions/e2e-setup/browser-actions/setup-firefox-1.8.0),$(pull 32 dependabot/github_actions/actions-minor-and-patch-c673fd7efc)]"
check 'its row' contains "$LOG" '| github-actions | `/`, `/.github/actions/*` | 3 | 5 | #30, #31, #32 |'

scenario 'p8 docker: 1 of 2 -> nothing; its limit is where it warns' "$pile_step" \
  FX_PRS="[$(pull 40 dependabot/docker/dot-github/actionlint/rhysd/actionlint-1.7.13)]"
check 'touches no issue' test ! -s "$LOG"

scenario 'p9 docker: 2 of 2' "$pile_step" \
  FX_PRS="[$(pull 40 dependabot/docker/dot-github/actionlint/rhysd/actionlint-1.7.13),$(pull 41 dependabot/docker/dot-github/zizmor/zizmorcore/zizmor-1.31.0)]"
check 'its row' contains "$LOG" '| docker | `/.github/actionlint`, `/.github/zizmor` | 2 | 2 | #40, #41 |'

# Two entries of one package manager, told apart by a directory with a leading dot, which
# Dependabot's branch names write "dot-" (git refuses a path segment starting with a dot).
split_yml=$here/split.yml
printf '%s\n' 'version: 2' 'updates:' \
  "  - package-ecosystem: 'docker'" "    directory: '/.github/actionlint'" '    open-pull-requests-limit: 2' \
  "  - package-ecosystem: 'docker'" "    directory: '/.github/zizmor'" '    open-pull-requests-limit: 2' > "$split_yml"
scenario 'p9b a docker entry for each directory: each counts its own' "$pile_step" FX_DEPENDABOT="$split_yml" \
  FX_PRS="[$(pull 40 dependabot/docker/dot-github/actionlint/rhysd/actionlint-1.7.13),$(pull 41 dependabot/docker/dot-github/zizmor/zizmorcore/zizmor-1.31.0),$(pull 42 dependabot/docker/dot-github/zizmor/zizmorcore/zizmor-1.32.0)]"
check 'zizmor at 2 of 2' contains "$LOG" '| docker | `/.github/zizmor` | 2 | 2 | #41, #42 |'
check 'actionlint at 1: no row' lacks "$LOG" '`/.github/actionlint`'

scenario "p10 a fork's, someone else's and a toolchain pull request do not count" "$pile_step" \
  FX_PRS="[$(prs 1 7 dependabot/npm_and_yarn/pkg),$(pull 8 dependabot/npm_and_yarn/x-1.0.0 mallory '' true),$(pull 9 dependabot/npm_and_yarn/y-1.0.0 Nawid3333),$(pull 10 toolchain/pnpm-13.0.0 app/github-actions)]"
check 'touches no issue' test ! -s "$LOG"

# Red: the ci-failed label's events (NOW is 2026-10-20T12:40:00Z).
scenario 'p11 red for over 14 days, and the ones that are not' "$pile_step" \
  FX_PRS="$(arr "$(pull 50 toolchain/pnpm-13.0.0 app/github-actions ci-failed)" "$(pull 51 dependabot/npm_and_yarn/a-1.0.0 app/dependabot dependencies,ci-failed)" \
    "$(pull 52 dependabot/npm_and_yarn/b-1.0.0 app/dependabot ci-failed)" "$(pull 53 patched/hls.js-1.8.0 app/github-actions ci-failed,hold)" \
    "$(pull 54 dependabot/npm_and_yarn/c-1.0.0)" "$(pull 55 dependabot/npm_and_yarn/d-1.0.0 mallory ci-failed true)" \
    "$(pull 56 feature/x Nawid3333 ci-failed)" "$(pull 57 dependabot/npm_and_yarn/e-1.0.0 app/dependabot ci-failed)" \
    "$(pull 58 dependabot/npm_and_yarn/f-1.0.0 app/dependabot ci-failed)")" \
  FX_EVENTS_50="$(arr "$(ev labeled dependencies 2026-09-01T00:00:00Z)" "$(ev labeled ci-failed 2026-10-05T12:00:00Z)")" \
  FX_EVENTS_51="$(arr "$(ev labeled ci-failed 2026-10-07T13:00:00Z)")" \
  FX_EVENTS_52="$(arr "$(ev labeled ci-failed 2026-09-20T00:00:00Z)" "$(ev unlabeled ci-failed 2026-10-10T00:00:00Z)" "$(ev labeled ci-failed 2026-10-15T00:00:00Z)")" \
  FX_EVENTS_53="$(arr "$(ev labeled ci-failed 2026-09-30T08:00:00Z)" "$(ev labeled hold 2026-09-30T08:00:01Z)" "$(ev labeled ci-failed 2026-10-10T00:00:00Z)")" \
  FX_EVENTS_54="$(arr "$(ev labeled ci-failed 2026-09-01T00:00:00Z)")" \
  FX_EVENTS_57="$(arr "$(ev labeled ci-failed 2026-10-06T12:40:00Z)")" \
  FX_EVENTS_58="$(arr "$(ev labeled ci-failed 2026-10-06T12:39:59Z)")"
check 'succeeds' test "$status" -eq 0
check 'opens the issue' count "$LOG" 'CREATE [--title] [Update pull requests piling up]' 1
check 'red since 2026-10-05: listed' contains "$LOG" '| #50 | 2026-10-05 (15 days) |'
check '13 days: not' lacks "$LOG" '| #51 |'
check 'red again since 2026-10-15: not' lacks "$LOG" '| #52 |'
check 'labelled twice, red since the first: listed' contains "$LOG" '| #53 | 2026-09-30 (20 days) |'
check 'exactly 14 days: not' lacks "$LOG" '| #57 |'
check 'a second more: listed' contains "$LOG" '| #58 | 2026-10-06 (14 days) |'
check 'no events read without the label, for a fork or another branch' \
  test "$(grep '^EVENTS' "$LOG" | tr '\n' ' ')" = 'EVENTS 50 EVENTS 51 EVENTS 52 EVENTS 53 EVENTS 57 EVENTS 58 '
check 'no limit table' lacks "$LOG" 'Near the limit'

scenario 'p12 the open issue, still piling -> edited, not a second' "$pile_step" \
  FX_PRS="[$(prs 1 8 dependabot/npm_and_yarn/pkg)]" \
  FX_ISSUES="$(arr "$(iss 90 'Update pull requests piling up' 'old')" "$(iss 91 'Update pull requests piling up' 'by hand' Nawid3333)")"
check 'succeeds' test "$status" -eq 0
check 'edits #90' contains "$LOG" 'EDIT [90] [--body-file]'
check 'opens none' lacks "$LOG" 'CREATE'
check 'leaves #91 alone' lacks "$LOG" '[91]'

scenario 'p13 nothing piles up any more -> the open issue closes' "$pile_step" \
  FX_PRS="[$(prs 1 3 dependabot/npm_and_yarn/pkg)]" FX_ISSUES="$(arr "$(iss 90 'Update pull requests piling up' 'old')")"
check 'succeeds' test "$status" -eq 0
check 'closes #90' contains "$LOG" 'CLOSE [90] [--reason] [completed] [--comment] [No Dependabot entry is near its limit any more, and no update pull request has been red for more than 14 days. Closing.]'
check 'nothing else' count "$LOG" '[' 1

scenario "p14 someone else's issue of that title is not this one -> a new one" "$pile_step" \
  FX_PRS="[$(prs 1 8 dependabot/npm_and_yarn/pkg)]" FX_ISSUES="$(arr "$(iss 91 'Update pull requests piling up' 'by hand' Nawid3333)")"
check 'opens one' count "$LOG" 'CREATE [' 1

garbage=$here/garbage.yml
printf 'version: 2\nupdates: []\n' > "$garbage"
scenario 'p15 a dependabot.yml without entries -> fails, rather than watch nothing' "$pile_step" FX_DEPENDABOT="$garbage"
check 'fails' test "$status" -ne 0
check 'says why' contains "$FIX/out" "main's .github/dependabot.yml could not be read as this step expects"

scenario 'p16 dependabot.yml unreadable -> fails' "$pile_step" FX_DEPENDABOT_FAIL=1
check 'fails' test "$status" -ne 0
check 'touches no issue' test ! -s "$LOG"

# --- The job's own failure.

scenario 'f1 failure -> opens "Update PR watch failed"' "$report_step" TITLE='Update PR watch failed'
check 'succeeds' test "$status" -eq 0
check 'opens it, assigned' contains "$LOG" 'CREATE [--title] [Update PR watch failed] [--assignee] [Nawid3333] [--body-file]'
check 'with the run' contains "$LOG" 'https://github.com/Nawid3333/FastStream/actions/runs/1'

scenario 'f2 failure while it is open -> a comment' "$report_step" TITLE='Update PR watch failed' \
  FX_ISSUES="$(arr "$(iss 95 'Update PR watch failed' 'x')")"
check 'comments on #95' contains "$LOG" 'COMMENT [95] [--body-file]'
check 'opens none' lacks "$LOG" 'CREATE'

finish
