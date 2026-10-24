# Workflows

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Workflows (reworked 2026-09-25)

- **`ci.yml`** runs what `pnpm run verify` runs (including `test:pbm` and,
  since 2026-09-25, `verify:vtt` - it had been red for three days when nothing ran it -
  and since 2026-09-30 `verify:fsaunpack`, which installs fsaunpack's own npm lockfile
  and starts its express test server; `verify:ort` left the chain on 2026-09-30 with the
  custom ONNX Runtime wasm it stamped, `verify:vad` and `verify:knob` on 2026-10-10 with
  the speech detector and the audio settings), plus a
  `workflows` job: actionlint with its
  bundled shellcheck over every workflow.
- **Run it here before pushing, the way CI runs it** (2026-09-25; PR #20 passed locally
  and failed on CI). The e2e fixtures are built with the machine's ffmpeg: CI's has
  libx264, a local LGPL build only libopenh264, and only libx264 makes B-frames. The
  fixtures no longer depend on that (the DASH and HLS ones are encoded with `-bf 0
  -sc_threshold 0`; the B-frame one is copied from `sample.mp4`). Before a push, run
  both halves of CI here: `pnpm run verify` (Windows), and **`pnpm run verify:linux`**,
  which runs CI's Linux verify job and its workflows job (actionlint, zizmor, and the `run:`
  scripts' tests in `tests/workflows`) in WSL, once on each Ubuntu
  release CI uses: the one `ubuntu-latest` gives and the newest GitHub offers (24.04 and
  26.04 until `ubuntu-latest` has moved, rolled out Oct 19 - Nov 19 2026), read from the runner image table
  `runner-images.yml` reads, so the pair follows GitHub; a release WSL lacks is
  installed, `--distro Ubuntu-26.04` picks one. Every run first brings the distro up to
  date, as a freshly built runner image is: `tools/linux/setup.sh` runs apt update +
  full-upgrade, installs the newest release of the Node major `.nvmrc` names
  (so it moves with CI) with the `packageManager` pnpm through its npm (not corepack, which
  Node 25+ lacks; Node 26 also needs apt's libatomic1, #238), and the current stable Firefox
  (its SHA-512 from the SHA512SUMS Mozilla's release key signs, the key pinned by fingerprint
  in setup.sh, #248; Node's sum is still only from nodejs.org itself), apt ffmpeg
  with libx264, and the actionlint and shellcheck binaries out of the image digest
  `.github/actionlint/Dockerfile` pins (apt's shellcheck is 0.9.0 on 24.04, the image's 0.11.0),
  and zizmor's out of the one `.github/zizmor/Dockerfile` pins (#239). Then
  `tools/linux/verify.sh` runs on a copy of the working tree with fresh fixtures. wsl.exe
  writes stdout and stderr to a redirected file at separate offsets, one over the other,
  so both scripts merge them. The Windows build of actionlint hangs driving shellcheck on
  some scripts; use the Linux one. On CI, `-latest` picks the OS release and GitHub
  rebuilds each image about weekly; what the tests use is fetched fresh every run: ffmpeg
  (apt-get update + install), Firefox `latest`, and Node from `.nvmrc` in every workflow
  (`node-version-file: .nvmrc`, `check-latest` - without it setup-node took the image's
  cached 22.23.2 two days after 22.23.3).
  CI does not apt-upgrade the whole image: minutes per run, for packages the tests do not
  touch. For CI's Windows encoder, delete everything in `tests/e2e/fixtures/` except
  `sample.mp4` and run `pnpm run verify` with a GPL ffmpeg first on `PATH` (on this
  machine: winget's `Gyan.FFmpeg`, gyan.dev 9.0.2 full; Chocolatey gives the Windows
  runner the same version as the essentials build, both with libx264).
- **`auto-release.yml`** only acts on a CI run that was a `push` to this repository's
  `main`. Before, `branches: [main]` matched a fork PR's branch named `main` too, and the
  job would have checked out that commit with a write token, pushed it and released it.
  When `main` has moved past the commit while CI ran, it stops with a notice (2026-09-28):
  the later push's run releases both, and pushing the bump would only be refused.
- **Main's CI after a merge already tested in its pull request** (2026-10-24, his choice:
  measured on #558/#559, the push run on main took ~8 minutes and the release waited for it).
  `ci.yml`'s first job, `tested-in-pr`, runs only on a push to main by CI itself. It answers
  skip=yes only when all of this holds:
  - the commit is a squash merge (one parent) of a pull request of this repository into main;
  - its tree is the tree of that pull request's last commit;
  - main's commit before it is an ancestor of that last commit (`compare ... behind_by` 0),
    so the merge the pull request's run tested is that last commit itself;
  - that commit has a green `ci.yml` run on `pull_request` from the last 6 hours.
  Then the e2e jobs and the Windows unit tests are skipped. The workflow lint and `verify` still
  run, and verify's `faststream-bundles` is what auto-release compares and releases from, so
  `auto-release.yml` is unchanged: it still releases from a green push run on main. Any failed
  look, or anything else, is skip=no and runs everything; the e2e jobs' and unit-windows' `if:
  !cancelled() && ... != 'yes'` also runs them when the job is skipped (a pull request's run, a
  dispatch, runner-images.yml's call) or fails. What is no longer done on such a push: the same
  tree's e2e suites a second time, minutes later, on a runner fetched anew.
  `tests/workflows/ci-tested-in-pr.test.sh` covers each condition; runner-images.yml's calls grant
  `pull-requests: read`, which GitHub requires of a caller even for a job that is skipped there.
- **Two ways `main`'s changes went unreleased with no one told** (fixed 2026-09-30).
  (1) A late CI run can cancel the run of `main`'s newest commit: on 2026-09-29 GitHub
  delivered the push of 3b74403c a second time, after `main` had moved to 477bcd59;
  through `ci.yml`'s `cancel-in-progress` that run cancelled 477bcd59's, went green, and was
  rightly not released, being behind `main`. 477bcd59 had no run and no release until it
  was re-run by hand. `auto-release.yml`'s `restart-cancelled-ci` job now runs after every
  CI push run on `main`: it finds the newest commit on `main` with a CI run, back to the
  last release bump, and re-runs that run when it was cancelled and a CI run on `main`
  started after it did. A run cancelled by hand is left alone; after a third cancelled
  attempt, or when GitHub refuses the re-run, the issue "CI on main needs a re-run" goes to
  the owner. Since 2026-10-21 no later run cancels a run on `main`: `ci.yml` cancels only a
  pull request's older run, and any other run has a concurrency group of its own (a
  cancelled run shows on its commit as a red X, which the owner read as a failure). (2) A push by `GITHUB_TOKEN` starts no CI (until 2026-10-02 `mpv-updates.yml`'s
  pin and `update-prs.yml`'s merges were such pushes), so one landing while CI ran on a commit left that commit's
  run seeing `main` moved on, to a commit whose run never comes. "Is this commit still
  main's newest?" now waits a minute for a later commit's CI run on `main` and, with none,
  starts CI on `main` by dispatch (a release bump after the commit means it is released).
  Both kinds of run are `GITHUB_TOKEN`'s and send no `workflow_run`: `ci.yml`'s
  `release-hand-off` job starts `auto-release.yml` by `workflow_dispatch` with the run's
  id and commit, whatever the run concluded, and "Which CI run?" waits for it to end and
  checks it as the job condition checks the event. A red one, a failed release, or a
  hand-off GitHub refuses opens "Auto release failed", since no one is emailed for a run
  the token started; a failed release on the `workflow_run` path too, since no failed run
  there has shown that it emails the pusher (2026-09-30). The hand-off takes a run either
  of whose actors is the token: the owner's re-run of such a run keeps the token as its
  actor and sends no `workflow_run` either (CI run 36618653582, attempt 2), and released
  nothing while only the triggering actor was checked. Each failure issue here and in the
  other workflows' "Report this workflow's own failure" is one issue while it is open, and
  a failure while it is open adds a comment with its run's link (before, it was dropped).
  The concurrency group is per commit, at job level: a workflow-wide
  group keeps one pending run and cancels it when another arrives, which could have
  dropped the newest commit's release behind a stale one's. The three scripts ran against
  a fake `gh` in WSL, 47 cases, each of eight mutations caught, and a GLM review before they
  went in. Not covered: a push GitHub never delivers.
- **`release.yml`** checks the tag against `package.json` and `chrome/manifest.json` before
  building, and runs lint + unit tests (a hand-cut tag reaches it without CI). Only
  lowercase `v` tags: the 106 capital-`V` tags in the repository are upstream's, copied at
  the fork. Run again for a tag that has a release, it replaces the files. Its last step,
  whatever happened, starts the failsafe.
- **`amo-signing-failsafe.yml`** ("Release failsafe"; after every release run, and every
  3 h): completes a release whose AMO signing did not finish, re-runs one that did not
  publish, checks the update path; see "AMO signing no longer depends on a timer" and
  "Every release is checked to reach Firefox" above.
- **`live-streams.yml`** (Mondays; 2026-09-28): `pnpm run test:live` on Linux and Windows,
  one issue while it fails. Also on a PR that changes the live suite or the e2e setup, and on
  the player libraries' rolling update PR (dispatched there; 2026-10-24), where a last job,
  hand-off, starts `update-prs.yml` again with the CI run on the same commit once that run
  passed: CI does not play the libraries, and `update-prs.yml` calls that PR ready only once
  the live suite passed on its commit too (`always()`: a failed or timed-out run is decided on
  as well; a cancelled one is started again only while its commit has fewer than two).
- **`.github/actions/e2e-setup`** (2026-09-28): ffmpeg, the e2e port reservation and the
  Firefox to test (`firefox-version`, exported as `FIREFOX_BINARY`), for every e2e job - the
  four copies differed already. Each download (Chocolatey, apt, Mozilla) is retried before
  the job fails. A change to it runs Firefox Beta and the live suite on the PR. Since
  2026-10-03 also `sample.mp4` from the Actions cache, keyed on its pinned SHA-256 and
  checked like a download (`tests/e2e/mp4FixtureCli.mjs`, #256), and on Linux a PulseAudio
  null sink as Firefox's sound device (`PULSE_SERVER`, `E2E_SOUND_SINK`; #265). The
  Windows runner has no audio endpoint. Its scripts: `tests/workflows/e2e-setup.test.sh`,
  `tests/unit/e2eSetupAction.test.mjs`.
- **Artifacts** (2026-09-28): `faststream-bundles` is kept 7 days (auto-release reads it
  minutes after the run; the 90-day default had piled up 57 copies, 469 MB), failure logs
  30 days.
- **`toolchain-updates.yml`** (weekly, Mondays 07:00 UTC; a push to `main` touching
  `.nvmrc`/`package.json` only closes) + `tools/check-toolchain.mjs`: a pull request
  per update, "Toolchain update: <name> <version>", on `toolchain/node-<major>` or
  `toolchain/pnpm-<version>`, with CI started on the branch by `gh workflow run ci.yml`
  (a `GITHUB_TOKEN` push starts no workflow). A newer Node LTS major changes `.nvmrc`
  and waits for the owner's merge (nothing merges itself since 2026-10-02).
  `.nvmrc` is the one place the Node major is named, so a
  Node update is a one-file change: the toolchain workflow's `GITHUB_TOKEN` may not
  push changes to `.github/workflows/*`. `tests/unit/checkToolchain.test.mjs` fails
  if a workflow names its own `node-version` or a setup-node step lacks
  `node-version-file: .nvmrc`. pnpm's newest release of the pinned major, once it is
  3 days old (`MIN_AGE_DAYS`; none from 2026-10-11 to 2026-10-20), changes `packageManager` in `package.json` and nothing else, and waits
  for the owner's merge. Nothing from npm runs in that job, beside its write token: CI
  installs the lockfile unchanged with the new pnpm (`--frozen-lockfile`), so one that
  wants it rewritten fails CI and reaches the owner. A newer pnpm major comes
  the same way. pnpm 12 came by hand on 2026-10-11, with `pmOnFail: ignore` in
  pnpm-workspace.yaml: pnpm's own version switching wrote a first lockfile document that
  hides every dependency from GitHub's dependency graph (dependabot-core#15904), and
  without it pnpm-lock.yaml stays one document, byte for byte what pnpm 11 wrote.
  A title is never used twice (issue or PR, open or closed): closing one skips that
  version for good. An open PR closes itself when the project reaches that version,
  or when a newer one on the same track gets its own PR (on a push, which raises
  nothing, only an open one counts: `--close-only`). The weekly run also rebuilds on
  `main` an open one `main` has moved into conflict with (the two pnpm tracks change
  the same line) when all its commits are the bot's, rebuilt on a freshly fetched
  `main`, and starts CI on one whose head has no run that decides (a lost dispatch, or
  only cancelled runs). Only the bot's own titles and pull requests count (author
  `github-actions[bot]`, never a fork's): anyone's PR with such a title neither blocks
  an update nor is closed or rebuilt; `patched-libraries.yml` filters the same way. A
  failed run opens one issue "Toolchain updates workflow failed". Node 24 was skipped on
  purpose (issue #11 closed); Node 26 arrives as a PR when it becomes LTS (late
  October 2026). uBlock Origin, which `tools/setup-dev-profile.mjs` puts into the
  developer's Firefox profile (2026-10-24; Dependabot cannot see an add-on pin): AMO's
  newest public listed release at least 3 days old, on `toolchain/ublock-origin-<version>`,
  changing only its entry there. Nothing in CI downloads the add-on, so the run downloads
  the file and checks it against AMO's SHA-256 before it pushes; a mismatch is a red run
  and no pull request. The plan's output carries every track (`updates`), so an open one
  that conflicts with `main` is rebuilt with its file, or left for the plan to replace
  when a newer release is out. The player libraries the live suite plays
  (`tests/e2e/live-specs/player-libraries.json`; 2026-10-24; a Dependabot entry for that
  folder was ruled out, since Dependabot's npm fetcher takes `pnpm-lock.yaml` and
  `pnpm-workspace.yaml` from a parent folder when the folder has none) come as ONE rolling PR,
  "Toolchain update: player libraries" on `toolchain/player-libraries`, rebuilt in place on
  `main` when the set changes or it conflicts with `main`: each library at its newest release of its pinned major (the
  caret range) that is 3 days old and fits the ranges they declare on each other and on the
  repository's hls.js (`playerTargets()`: xgplayer-hls asks for its exact xgplayer,
  hls-video-element for a custom-media-element). The PR's body marks its set; closed unmerged
  by hand, that set is skipped (this workflow's own close takes the marker out first). A newer
  major is not taken: the issue "Player libraries: newer majors" lists them, keyed by name and
  major, so it stays closed once closed until another major comes. CI and the live suite are
  started on each new head. The tracks' decision logic is `plan()` in
  `tools/check-toolchain.mjs`, the players' set `playerTargets()` beside it, both unit-tested. Dependencies stay pinned by the lockfile on purpose (patches, AMO
  reproducibility); Dependabot's weekly grouped PRs are how they move, each release
  proposed once it is 3 days old (`cooldown` in `.github/dependabot.yml`, the owner's call
  of 2026-10-20 after none from 2026-10-11; security updates skip it): npm minor/patch is split into `shipped-minor-and-patch`
  (fuse.js, mediabunny, sortablejs - the unpatched libraries
  `tools/sync-vendor.mjs` copies into the extension) and `tooling-minor-and-patch`
  (everything else), so a tooling update is not held back by a shipped one;
  `update-prs.yml` reports on both when CI has run; the owner merges (the shipped one then
  releases, see below).
- **`update-prs.yml`** (2026-09-29) runs after every completed CI run (`workflow_run`;
  for a run a workflow's token started, which sends none, `ci.yml`'s hand-off starts it by
  `workflow_dispatch`, and opens "Update PRs hand-off failed" when GitHub refuses all three
  tries) for this repository's `dependabot/*`, `toolchain/*` and `patched/*` branches
  (`sync/upstream` too until 2026-10-09), and never checks out PR code. `gh pr list --head`
  lists a fork's pull request from a branch of the same name too: it and `mpv-updates.yml`
  drop those (`isCrossRepository`, #169; `tests/unit/workflowGh.test.mjs`
  fails for a `--head` list that does not ask). CI red: CI is started once more
  on the same commit, and that run decides (a new run, not a re-run: a re-run by this
  workflow's token would reach no workflow when it ends); not when CI already failed on
  that commit (an earlier run, or this run was re-run by hand), and when GitHub refuses
  to start it, this run decides. Still red, one comment @mentions the owner with a
  table of failed job, step and what the step checks, the last 40 lines of each failed
  log and `main`'s latest CI status, and the PR is labelled `ci-failed` and assigned to them. CI green:
  **nothing merges itself** (the owner's choice, 2026-10-02; from 2026-10-01 every kind
  did). One comment @mentions the owner, assigned: "ready to merge" for any kind (Dependabot
  npm, fsaunpack, GitHub Actions, the actionlint/zizmor images, toolchain Node and pnpm,
  patched libraries) when it is not labelled `hold`, and only when its
  bot opened it (not a draft,
  against `main`) and its commits are the bot's or this workflow's merges of `main` (the
  owner's, made with their token; Dependabot's and those merges also signed by GitHub, as
  an author login is only the commit's e-mail, #170), it changes only what its kind
  changes (`package.json` + `pnpm-lock.yaml`; for pnpm only `packageManager`, the lockfile
  untouched; fsaunpack's two files; `.nvmrc`; `.github/workflows` + `.github/actions`;
  the two Dockerfiles; a re-cut's `pnpm-workspace.yaml`, `patches/`, `tools/sync-vendor.mjs`), the
  dependency review passed, every version its lockfile adds is 3 days old (fsaunpack's
  `package-lock.json` read with jq; a security fix exempt; see "Update guards" below), it is mergeable, it contains the newest `main`
  (otherwise GitHub's update-branch runs, CI restarts and that run decides, at most 3
  times), and, for an update that must not ship (all but the shipped and the patched
  libraries), CI's build of the extension (the `faststream-bundles`
  artifact, both zips) is file-for-file identical to the latest release's zip and xpi
  apart from `manifest.json`'s version - `auto-release.yml`'s own test, so such a merge
  releases nothing. A shipped library's major comes on its own branch: it ships when one of
  its `dependency-name`s is in the `shipped-minor-and-patch` patterns of main's
  `.github/dependabot.yml` (unreadable: treated as tooling, whose build must not differ).
  GitHub Actions updates change workflow files, which `GITHUB_TOKEN` may not merge or
  update: that is done with the owner's fine-grained token, secret `UPDATE_PRS_TOKEN` of the
  `update-prs` environment
  (Contents, Pull requests, Workflows: write; docs/maintenance.md, "A token for workflow
  updates"), used only to bring such a branch up to date. His merge is his
  push: CI runs on `main`, and a green run of a merge that ships releases. A green PR that
  fails a check gets one comment @mentioning the owner - CI is green, and what to look at
  before merging - and is assigned to them. A comment with the same verdict
  as the last one is edited in place, so it sends no new mail: the owner hears when a
  verdict changes. The "behind main" check is the last one: a branch behind `main` is
  brought up to date and CI decides again, so what he merges is what CI tested. A branch
  update refused because the branch moved on meanwhile (Dependabot rebased it), or the PR
  was closed, is no failure: the new commit's CI run decides, or there is nothing to
  decide. A cancelled or skipped CI run decides nothing. The comment keeps one key per
  verdict, so a changed reason edits it without a new email. GitHub deletes a merged
  branch. `main`'s ruleset blocks force-pushes and deletion only, no required checks. If `update-prs.yml` itself fails, it
  opens one issue "Update PRs workflow failed" (the decide step has its own
  `timeout-minutes` under the job's, so running out of time fails the step and still
  reaches the report).
- **Update guards** (2026-10-20, the owner's three calls, so that a green update PR can be
  merged without a second look). (1) **A 3-day release wait**, back after 2026-10-11's
  removal (351bd7de; it was 5 days for the cooldown and the toolchain, 7 for the lockfile
  check): Dependabot's `cooldown` (`default-days: 3`, every entry; zizmor's
  `dependabot-cooldown` audit asks for 3), `MIN_AGE_DAYS = 3` in `tools/check-toolchain.mjs`
  (pnpm; `tools/newest-release.mjs` and so update-local.cmd too), and update-prs.yml's
  registry lookup of every version a Dependabot or patched-library PR adds to its lockfile.
  Why: green CI cannot see a compromised release, and most npm compromises of 2025 were
  pulled within hours to days (the owner's reasoning; Renovate's best-practice preset waits
  3 days for npm). Not measured here: no compromised release has reached this repository.
  The Node LTS major track has no wait, as before: `.nvmrc` names a major, and setup-node
  takes its newest release at every run anyway. A security fix is not held back: Dependabot
  gives its security updates no cooldown, and update-prs.yml skips the lookup for a PR whose
  body has "You can disable automated security fix PRs for this repo" (measured on all 35
  Dependabot PRs here: #6, #7, #8, #352 and #353, security updates, have it; none of the
  other 30 does, #95 among them) or
  every package of which has an open Dependabot alert on that lockfile (#95, a security update
  of 2026-09-30 whose body lacks the line, is why the body alone is not enough; every package,
  or a grouped version update with one alerted member would waive the wait for the rest too;
  the job asks
  for `vulnerability-alerts: read`, which actionlint 1.7.12 does not know, see
  `.github/actionlint.yaml`). Unreadable alerts: the wait applies. Held back only by age, a
  PR would sit at "look" until its next CI run, so the comment carries
  `<!-- update-prs-recheck: <time> <run> <commit> -->` (when the youngest version is 3 days
  old; a day later, at the latest, when an age is unknown or the lockfile could not be read,
  which may be a moment's failure: GLM's review found the marker lost otherwise), and security-alerts.yml's daily `watch` job starts
  update-prs.yml by `workflow_dispatch` on that run once the time has passed and the PR is
  still at that commit (the CI artifact it compares lives 7 days). (2) **Red twice: hold + a
  migration issue.** When the second try fails too (again=1) on a dependabot/, toolchain/
  or patched/ branch, the PR also gets `hold` (only when it has none: an existing one stays
  the owner's) and one issue "Migration: <what>" - Dependabot's commit metadata gives
  `<name> <version>` (a scoped name loses its quotes), a group "<group> (first three and N
  more)", a toolchain or patched PR its title less the prefix - with the diagnosis the red
  comment has, the branch `migrate/<slug>`, how to run CI again and how to park it. Found
  again by its `<!-- migration-pr: N -->` marker (or an open bot issue with the same title,
  which it takes over), it is edited, not opened twice. A green run closes it and takes off
  `hold` when the last `labeled hold` event's actor is github-actions[bot] (unreadable
  events: it stays); the daily watch closes the issues of PRs merged or closed. (3) **The
  piling-up issue**, in the daily watch (security-alerts.yml, not ci.yml, which takes no
  `schedule:`; not update-prs.yml either, which a `schedule:` would expose to GitHub's
  60-day disabling): each entry of main's `.github/dependabot.yml` (read with awk as it is
  written: entries at two spaces, keys at four, directory items at six; a file it cannot read
  so fails the job) against the open Dependabot PRs, a branch counting for the entry of its
  package manager whose directory it names (`dependabot/npm_and_yarn/fsaunpack/...`), else
  the root one. It warns at the limit minus 2, at least 2 (or the limit, if lower): docker's
  limit is 2, and minus 2 would always warn. Security updates count too (GitHub keeps a
  separate limit for them, so this warns early, never late). Red for more than 14 days: since
  the `ci-failed` label last went on after it last came off (issue events). One issue,
  "Update pull requests piling up", edited daily while it holds, closed when neither holds.
  Dependabot's branch names write a leading dot of a directory "dot-" (git refuses a path
  segment that starts with a dot), so `/.github/zizmor` is matched as `dot-github/zizmor/`;
  no docker or composite-action PR has come here yet to show it. Tests:
  `tests/workflows/update-prs-decide.test.sh` (413 -> 621 checks; 22 mutations of the new
  logic, each caught), `tests/workflows/update-watch.test.sh` (86 checks, its p1 on the real
  `.github/dependabot.yml`; 21 mutations, each caught), and `tests/unit/checkToolchain.test.mjs`
  keeps the cooldown, zizmor's setting, update-prs.yml's cutoff and `MIN_AGE_DAYS` at one
  number (a cooldown of 5 in one entry fails it).
- **`firefox-beta.yml`** (Monday and Thursday, and on PRs touching it or the e2e configs): `test:e2e` and
  `test:ext` against Firefox Beta (`browser-actions/setup-firefox`, `latest-beta`) through
  the `FIREFOX_BINARY` env var the wdio configs honour. A scheduled failure opens one issue
  naming the Beta version - about two weeks before that Firefox reaches users (two-week
  release cycle since Firefox 155, September 2026) - and the
  next green run closes it. Not part of CI; it never blocks a release.
- **`firefox-stable.yml`** (daily): reads the current stable version from
  product-details.mozilla.org (Mozilla sends no notification) and, once per version, runs
  `test:e2e` + `test:ext` against exactly that version; a green run records it as an Actions
  cache key `firefox-stable-tested-<version>`, so later days skip it (a manual run always
  tests). A failure opens one issue per version; a green run closes it. Read release dates
  from that file rather than computing them - it said 157 is due 2026-10-09, not the
  2026-09-29 two-week arithmetic from 155 suggested.
- **`runner-images.yml`** (daily, 2026-09-25; the same file is in every repo of the owner
  except mpv and KytyPS5): reads the actions/runner-images README for the image behind
  `ubuntu-latest`/`windows-latest` and the newest GA one, and calls `ci.yml` (which takes
  `linux-runner`/`windows-runner` inputs for this) once on the newest image when it is
  newer than `-latest` - a warning before GitHub switches, as `ubuntu-latest` does to 26.04
  rolled out October 19 - November 19, 2026 - and once more when `-latest` moves. Green runs are recorded as cache
  keys `runner-image-{next,latest}-<images>`; a failure opens one issue per image, closed by
  the next green run. A called CI run is not a "CI" run, so it never releases. Both calls
  grant the most any ci.yml job asks for (`contents: read`, `actions: write`,
  `issues: write`): GitHub refuses the whole run at startup when a called job asks for
  more, even one whose `if:` skips it, and as no job runs, no issue says so (#77's release
  hand-off stopped it so, 2026-09-30). A permission added to a ci.yml job goes in both
  calls; `tests/unit/workflowPermissions.test.mjs` fails until it does, and follows a
  called workflow's own calls down the chain. The image list is read by label shape
  (`ubuntu-NN.NN`, `windows-NNNN`); a new Ubuntu or Windows Server image with no label of
  that shape fails the run by name, as it would otherwise go unseen. Never put a
  `schedule:` in `ci.yml`: GitHub disables a public repo's scheduled workflows after 60 days
  without a commit, and it disables the whole file, push trigger included.
- **Keepalive** (2026-09-30): `keepalive.yml` (Wednesdays 09:20 UTC) keeps the scheduled
  workflows on without committing anything. Once main's last commit is 45 days old (or a
  dispatch sets `force`), it calls the API's enable endpoint for every workflow whose file
  has a `schedule:` trigger (read from the checkout, itself included) and whose state is
  `active` or `disabled_inactivity`; never one the owner disabled (`disabled_manually`).
  That the call restarts GitHub's 60-day count is not documented by GitHub; it is what the
  former keepalive-workflow action's API mode relied on. If they are disabled anyway:
  Actions tab, each workflow, "Enable workflow". A failed run opens "Keepalive failed".
- **Windows e2e** (2026-09-25): CI runs the e2e suites on windows-latest as well as
  Linux, and auto-release waits for the whole workflow, so a release ships only when
  Windows passes too. `firefox-beta.yml` and `firefox-stable.yml` run their e2e jobs on
  ubuntu-latest and windows-latest; the stable version is recorded as tested only when
  all pass (a separate `record` job).
- **e2e side by side** (2026-10-05): CI ran a platform's four e2e suites one after another
  in one job - 30 minutes on Linux, 45 on Windows (run 37347420774: Windows playback 15,
  each extension suite 13), and the run took the Windows job's 45. Now `verify` keeps
  lint, types, unit tests, the build, the linters and `faststream-bundles` (about 4
  minutes), `unit-windows` runs the unit suite on Windows, and the matrix job `e2e` runs
  os [Linux, Windows] x suite [playback, extension (with private browsing), github], six
  jobs side by side, each with its own setup and build (about 2 minutes): 17 minutes (PR
  #350's run 37382065299; each Windows suite about 15, the longest spec file,
  content-cleanup, 127 s). Then each suite was cut into groups of about the same running
  time, `E2E_SHARD=<i>/<n>` (`tests/e2e/shardSpecs.mjs`): three a suite on Windows, two on
  Linux, so each job takes about 5 to 7.5 minutes, the run about 7.5. WebdriverIO's own
  `--shard` cuts by the number of files, and the long spec files sit together (527 s and
  402 s for the halves of the Windows extension suite); the groups here come from each
  spec file's time on the Windows runner, `tests/e2e/specWeights.json`, the longest first,
  each to the group with the least so far; a spec file not in it counts as the median.
  Refresh it from a run's logs: `node tools/e2e-spec-weights.mjs <CI run id>` (each weight
  moves halfway to the run's time, timed from WebdriverIO's "Execution of" line, not the step's
  start: gh can give a log with every step "UNKNOWN STEP"). Refreshed on 2026-10-23 from
  four green runs (39879683023, 39880280436, 39881236737, 39959410952): new spec files had
  counted as the median, and Windows playback 2/3 was the longest job in three of the four
  (542, 512 and 600 s, the other groups 338-554 s). Taken by the new weights, the longest
  playback group goes from 369 to 323 s and the longest extension group (ext-specs and
  classic-specs together) from 325 to 306 s; one run's group times vary by more than that
  (338 to 600 s for the same group), so the gain shows only on average. Without
  E2E_SHARD a config runs all its spec files (local `pnpm run verify`). The private
  browsing suite (one spec file) runs in the first extension group only. A run is 18 jobs
  at once of the account's 20, so more groups would only queue.
  `fail-fast: false`, so one failing group does not cancel the others and their lists of
  retried specs. Per-job artifacts: `e2e-retried-<os>-<suite>-<group>`,
  `e2e-logs-<os>-<suite>-<group>`; `e2e-moz-logs-windows-<suite>-<group>` only from the Windows
  jobs (the ones that set `E2E_MOZ_LOG`). firefox-beta.yml and firefox-stable.yml
  split the same way (playback, extension; three groups on Windows, two on Linux).
- **e2e setup, faster** (2026-10-06, `.github/actions/e2e-setup`): Linux installs ffmpeg and
  PulseAudio in one apt run without recommended packages (the separate runs took 29 s and
  ~5 s, 105 MB for ffmpeg); Windows takes ffmpeg.exe and ffprobe.exe from the Actions
  cache, keyed by the ISO week (`e2e-ffmpeg-windows-<year>-W<week>`), instead of
  Chocolatey's 23 s on each of the nine Windows jobs. Firefox, Node and pnpm stay uncached:
  a restore costs about what their download does (the 142 MB pnpm store takes ~14 s to
  restore on Windows). A spec's retry (about 4 minutes on Windows) costs a run more than
  all of this; the weekly flaky-specs issue lists them. Windows Firefox decodes through
  Media Foundation where Linux uses ffmpeg, so playback can differ. Both CI jobs install
  the current stable Firefox (`browser-actions/setup-firefox`, `latest`) instead of the
  image's (Windows had 155.0.1 when 156.0.1 was out). Windows gets ffmpeg from
  Chocolatey for the fixtures. Do not call `firefox.exe --version` there: it does not
  print to a console on Windows. The first Windows runs exposed timing races in
  specs that had always won on fast machines, fixed in the specs: capabilities picked the
  last window handle (sometimes the http:// opener, where WebCodecs/AudioWorklet do not
  exist) - now found by URL; options-mpv clicked before the saved options loaded and read
  storage once - now waits for `data-options-loaded` on the options page's `<html>` and
  for storage to hold the change; sources-browser checked auto-hide once after 150 ms -
  now re-queues until hidden (mutation-checked: a never-hiding bar still fails).
  keybinds (frame step) and storage (OPFS) log where they were on a failure; save-fmp4
  logs each phase's time (ready, downloaded, saved) and the download state if it stalls.
  The Windows runner also exposed a real player bug: hiding a focused control sometimes
  moves focus to `<body>` with no `focusout` there (logged `{"focusouts":0,"flag":true}`;
  on a desktop it does fire, so it never reproduced locally), which left
  `InterfaceController.focusingControls` stuck true and the control bar up for good.
  `isFocusInControls()` now checks the flag against `document.activeElement`; the
  sources-browser spec forces the stale flag, so it fails without the fix on any machine.
  A second one: SweetAlert2 removes a closing dialog only on the popup's `animationend`,
  which on the runner once never fired, leaving an invisible `swal2-hide` popup over the
  save button. `AlertPolyfill` dialogs close without a hide animation (a `Dialog` mixin
  with empty `hideClass`, sweetalert2#1841); `specs/dialogs.e2e.mjs` makes the animation
  last an hour and fails without the fix. (The dialogs are Firefox's own `<dialog>` since
  2026-10-09: it leaves the page as it closes, and the spec checks that.) Failing save/storage specs log the page and
  every unanswered OPFS worker call (`specs/diagnostics.mjs`, `OPFSManager.pendingCalls()`).
  The MPV-mode specs joined the Windows job on 2026-09-28, after three five-job trials;
  the third, with the fix below, passed every MPV spec on the first attempt.
  The first two showed `toolbar-cycle-mpv` racing: its Off -> On step allowed no new CDN
  request, but the in-page player it opens loads the detected stream, on the runner from
  1.3 s before the iframe was found to 0.5 s after. It now checks what a reload changes
  (the page is loaded again, and the page cache-busts its stream URL on every load) and
  fails when `chrome.tabs.reload()` is added to that branch.
- **The web and extension specs of #501** (2026-10-20, the week to 2026-10-19), from both
  attempts' logs: ram-budget's retries were a real bug, a fragment let go of while it was
  being written (storage.md, "RAM first"). dialogs read the colour theme before main.mjs had
  applied the stored options, which put the default back: a spec that changes what
  `setOptions` sets waits for `window.fastStream.optionsApplied` first, as client-setup and
  player-controls did. autoplay-next-episode read `windowedFullscreen` the moment
  `carriedFullscreen` was set, but the background's second answer sets it: wait for an
  async flow's last effect, not its first. Not explained by the logs, so their failures say
  more now: storage (the OPFS worker silent for 28 s, once the Cache API and the page too)
  probes OPFS from the page, the Cache API and IndexedDB when a step never settles;
  iframe-redirect (OPEN_PLAYER sent, no player) prints the frame's videos and what an
  IntersectionObserver reports of them, and the background logs content.js's answer to
  OPEN_PLAYER ("Player opening answered"); player-peers-bfcache (Back reloaded the page once,
  on Linux) records pagehide's `persisted`: cached and dropped, or never cached.
- **The classic specs of #501** (2026-10-20). Their logs said what failed, not why, so two
  CI runs on the branch traced them first (`it.only` loops of the cases with their events
  recorded, dispatched with `gh workflow run ci.yml --ref <branch>`; the probe commits never
  reach the pull request). content-overlays' fullscreen case (13 retries): content.js hides
  the player's iframe while it measures the page's element, 8 times in the player's first
  2 s and after every resize (leaving fullscreen is one), and the player lays itself out at
  an iframe's default 300x150 meanwhile (player.md). Marionette takes an element click's
  point in the frame's layout and dispatches it a moment later; every traced miss came at
  (274, 132), the button's centre at 300x150, and went to the video, which a single click
  pauses (run 39473761807, 4 of 100 clicks). Its sign in a driver log: "TimedPromise timed
  out after 500 ms" from `interaction.flushEventLoop`, the click that never reached its
  element. The case now clicks once the iframe's style attribute has been quiet for 500 ms
  and the player is at the iframe's size (`playerAtRest`); 25 rounds on each runner, every
  click on the button (run 39476690456). page-media-hold played as soon as
  `fastStream.source` was set, which setSource does before it builds the player: "No source
  is loaded!" in all three failed attempts' driver logs; wait for the player's video. The
  stray preview in mpv-shortcut was a product bug (mpv.md, "The shortcut's own
  activation"). content-cleanup's Back cases were not explained by the logs (Linux: the page
  loaded again; Windows: the source waited on OPFS for over 15 s, as storage.e2e's worker
  stood still): they say more now, Firefox's own bfcache log included, set through
  `logging.*` preferences in the chrome context, which reach every process and work on
  Linux, where CI sets no MOZ_LOG. That log caught the Linux case on this pull request's
  own CI (run 39483183549): "Save of .../cleanup blocked because document has request
  .../clip.mp4" - NETWORK_IDLE, which pageMediaIdle waited for, is also a download Firefox
  only suspended, its request still open; it waits for the whole clip buffered too now. Not flakes of main: a WIP branch's merged case
  (wip/fs-prune, failed twice), and the pre-15 host's PowerShell start of mpv taking 46 s
  (fix/open-items). One mpv-shortcut attempt hung for two minutes with nothing logged (run
  38628691870).
- **e2e config, 2026-09-25:** `autoXvfb: false` - Firefox runs `-headless`, and WebdriverIO
  otherwise spawns workers through `xvfb-run`, whose Ubuntu 26.04 version closes fd 3, the
  worker IPC channel: every worker died with `write EINVAL` (webdriverio#15685, unfixed in
  9.32.0; found by runner-images.yml before `ubuntu-latest` moves, from October 19).
  `specFileRetries: 1` - a failed spec file runs once more in a fresh browser: after the two
  bugs above were fixed, 3 x 12 parallel Windows runs showed only rare timing-budget
  overruns (a 6 s streamSaver write, a 30 s player start) with nothing pending. A real bug
  fails twice and still blocks the release. Since 2026-10-01 a retry leaves a trace
  (W5): each config's `onWorkerEnd` is `recordRetriedSpecs` (`tests/e2e/retriedSpecs.mjs`),
  which appends a spec file that was run again to `logs/retried.jsonl`; ci.yml lists them
  in the run's summary with a warning for each that passed only on its retry
  (`tests/e2e/reportRetried.mjs`), uploads the list as `e2e-retried-<os>-<suite>-<group>`
  (14 days; `e2e-retried`/`e2e-retried-windows` before 2026-10-05), and uploads
  `e2e-logs-<os>-<suite>-<group>` for such a green job too, so the failed attempt's driver
  log is there. `flaky-specs.yml` (Mondays 06:20 UTC) folds a week of lists into one issue.
- **e2e harness, 2026-10-01 (F1, F4-F6):** a config's `before` hook runs its setup
  through `guardSetup` (`tests/e2e/setupGuard.mjs`): WebdriverIO only logs a hook's
  error, so a failed add-on install let every spec run without the extension (a probe
  test passed that way); now the mocha root hook fails each test with the setup's reason.
  Each spec file's attempt starts with an empty `.e2e-downloads` (a retry's save went to
  `name(1).png` and the spec read the first attempt's file). download-names keeps its
  extension page open until Firefox reports the download `complete`: closed at once, the
  page took its blob with it before Firefox read it, the CI flake. Single-file fixtures are
  written under `.partial` and renamed (`writeFixture`); `sample.mp4` is pinned by size and
  SHA-256 (`mp4Fixture.mjs`), and the fixtures made from it (`buildFixtures.mjs`) keep the
  recipe they were built by and are built again when it changes (2026-10-03, #256/#263);
  the extension config makes them too, so `pnpm run test:ext` works on a fresh clone.
  Both test servers answer a bad `%` escape with 400, end a response whose read fails, and
  read `bytes=-N` as the last N bytes (`serveFile.mjs`). A retried test's screenshot is
  numbered, not written over the first attempt's.
- **e2e test cap, 2026-09-30:** mocha stops a test at 120 s (the live suite at 300 s), and a
  test's own `this.timeout()` did not lift that under WebdriverIO. For a long local run (a
  timing sweep, a loop waiting for a rare race) set `E2E_TEST_TIMEOUT_MS`
  (`tests/e2e/testTimeout.mjs`); CI keeps the caps, so a hang there still ends the test.
- **No HTML5 drag and drop through WebDriver, 2026-10-20:** Firefox's WebDriver starts a native
  drag and never ends it. Its pointer actions gave the page dragstart, dragenter, dragover and
  dragleave; letting go gave no drop, no dragend and no mouseup (Firefox 158.0.1 on CI's Linux
  and Windows, run 39477097683; Mozilla's bug 1515879). A spec that needs one dispatches the
  drag's events in the page, in Firefox's order, to what is under the pointer:
  `tests/e2e/toolbarDrag.mjs` (libraries.md, "sortablejs: what checks it").
- **The extension's console in the driver logs, 2026-10-01 (W6):** background.mjs's debug
  lines (`if (Logging)`) are on for a temporary install (`management.getSelf()` says
  `development`: the e2e suites' `installAddOn(xpi, true)`, `web-ext run`, about:debugging)
  and off for an installed release. The extension suites set
  `devtools.console.stdout.content`, so the background's and the player's console go to
  Firefox's stdout and into each spec's `geckodriver-<suite>-<spec>-<worker>-attempt<N>.log`
  (`e2e-logs-<os>-<suite>-<group>` artifact on CI): grep `console.log:` for what the background detected
  (`Found source`), opened, and sent to mpv. About 13 KB per spec.
  `ext-specs/background-log.e2e.mjs` fails without either half.
- **Firefox's network log on CI, 2026-09-30:** with `E2E_MOZ_LOG=1` (CI's Windows playback
  step), the specs listed in `tests/e2e/mozLog.mjs` run with `MOZ_LOG` (cache2 and nsHttp),
  and an attempt with a failed test keeps its log under `logs-moz/`, uploaded as
  `e2e-moz-logs-windows-<suite>-<group>` for 7 days; a passing attempt deletes its own. For loader-retry's
  "stalls before its body", which failed twice on the Windows runner with every retry stalled
  before reaching the server, and never locally. Since 2026-10-09 also the Windows extension
  and GitHub-build steps, for `player-peers-bfcache` (SHIPBFCache: what took a page out of the
  back-forward cache; it failed there 4 of 4 times and passed locally, PR #366).
- **e2e ports, 2026-09-27:** every fixed port a test server listens on is in
  41800-41999 (`tests/unit/e2ePorts.test.mjs` fails otherwise). Linux hands 32768-60999
  out to outgoing connections, and one that gets a test's port makes that server's
  `listen()` fail with `EADDRINUSE` - mpv-suspend's 41996 did on PR #40's CI. The Linux
  jobs (`ci.yml`, `firefox-beta.yml`, `firefox-stable.yml`) and `tools/linux/setup.sh`
  reserve the range (`net.ipv4.ip_local_reserved_ports`); measured here, 47 of 8,000
  OS-picked ports landed in it without the reservation and none with it. Windows hands
  out 49152-65535 and needs nothing.
- **One e2e run per machine at a time** (2026-09-28). The ports are fixed, and WSL's
  mirrored networking shares them with Windows, so a second run - another checkout, or
  `verify:linux` - finds its ports taken. wdio only logs an error thrown in `onPrepare`
  and runs the specs anyway, so they were answered by the other run's server and tested
  its build (a keybind spec saw a fix it was checking missing; with a port held by
  another process, a spec passed and wdio exited 0). The suites' servers now start
  through `tests/e2e/listen-or-stop.mjs`, which ends the run with "Port N is already in
  use" instead.
- **Every action is pinned to a commit SHA** with the exact version as a comment (and the
  actionlint image by digest, in `.github/actionlint/Dockerfile`, since Dependabot does
  not update a `docker://` line); Dependabot bumps them, the workflows' and the composite
  actions' (`/.github/actions/*`), minor/patch grouped weekly, and wait for the owner's
  merge like every update.
  `tests/unit/checkToolchain.test.mjs` fails for a pin in a form Dependabot does not update. Checked
  against `git ls-remote` when pinned; `dependency-review-action`'s `v5` is a branch.
- **No CVE watch for the vendored components outside the lockfile** (vtt.js; StreamSaver
  until its body became FastStream's own, knob until 2026-10-10): measured 2026-09-25, OSV has
  never recorded a vulnerability for any of them, so a workflow could never fire. They are
  covered by the provenance checks instead. The lockfile-backed libraries are covered by
  Dependabot alerts (OSV's only hls.js record, MAL-2026-3019, is two canary builds, not 1.7.3).
- **No `reminders.yml` any more** (removed 2026-10-04): it commented on open issues
  labelled `reminder: <month>` on the 1st of that month. The only issue that ever carried
  such a label (#10) was closed, so it had nothing to do.
- **No `mpv-host-changed.yml` any more** (removed 2026-10-04; it emailed "run install.ps1
  again" through issue #73 after a push that changed the host). The host now sends its
  version with every answer, and the extension says when the installed copy is older: see
  "The host's version" under "MPV mode and the native host". `update-local.cmd` installs
  it again.
- **No `wsl-releases.yml` any more** (removed 2026-10-04; it opened an issue "WSL update:
  <version>" for each microsoft/WSL release, which the owner closed by hand, GitHub not
  seeing the PC). `update-local.cmd` checks WSL itself now: see "Commands".
- **`flaky-specs.yml`** (Mondays, 06:20 UTC), 2026-10-01: the spec files CI ran again
  (every artifact named `e2e-retried*`, all of this repository's branches, the
  last 7 days; never a fork's pull request, whose CI run writes the list with its own code,
  and the texts are cut down to a path's characters, #166) in one
  issue "Flaky e2e specs: week to <date>", assigned + @mention: per spec, how often it was
  run again, how often its retry passed, suites, branches and runs. It finds the artifacts
  through the repository's artifact list (`actions/artifacts?name=`), not run by run. The
  next week's issue closes it, and so does a week with no retry. Permissions: `actions:
  read`, `issues: write`; no checkout. Tested by `tests/workflows/flaky-specs.test.sh`.
- **`security-alerts.yml`** (daily, 06:30 UTC; and on a push to `main` that changes a
  lockfile, closing only), 2026-09-30: Dependabot could not make the security fix for
  brace-expansion (three majors in the lockfile), its failed run emailed no one, and 12
  alerts sat on the Security tab unseen. For an open alert over 6 hours old with no open
  Dependabot PR naming the package (title, the links before the first `<details>`, a
  grouped update's "Updates" lines), it opens "Security alert: <package>", assigned +
  @mention; a later alert edits it and comments. The body's `<!-- alerts: ... -->` line
  records what it listed: a listed alert is never raised again, so closing by hand skips.
  The advisory summary's `<` is escaped in the table, as a marker in it would hide that
  line from the next run (which would comment every day). Closes itself when no alert for the package is open. `vulnerability-alerts: read` is
  what lets `GITHUB_TOKEN` list the alerts (403 without it, checked on a probe branch);
  actionlint 1.7.12, the latest, does not know that permission, so
  `.github/actionlint.yaml` ignores that one message for that one file
  (rhysd/actionlint#666). `tests/workflows/security-alerts.test.sh`: 37 scenarios, and 25
  mutations of the workflow each fail it. Its stub `gh` applies `--jq` with jq, as CI has
  it; the real gh uses gojq, built in, and the filters avoid the one difference found
  (jq 1.7 splits `""` into `[]`, gojq into `[""]`). The test passed with gojq 0.12.19
  swapped in too. Since 2026-10-20 a second job, `watch` (daily and by hand, not on a push),
  looks after the update pull requests: see "Update guards" above. Each job asks for its own
  permissions (zizmor flags a workflow-wide `issues: write` once there are two jobs).
  Since 2026-10-24 it tries the fix itself where an override floor makes it, as #564 did by
  hand (`tools/security-overrides.mjs`, its plan replayed on the state before #564 writes the
  same four floors, and its lockfile came out the same, the order of two keys in its overrides
  copy aside). Three jobs: `check` plans the floors (`plan`: a floor per package and major the
  lockfile holds vulnerable, `^` the newest first patched version; declined, with the reason in
  the issue, when there is no patched version, the fix is a new major, the package is pnpm-
  patched, a parent-scoped or unreadable override governs it, or `main` has the floor already
  while the lockfile is still vulnerable) and keeps the alerts it takes out of the issues (out
  of both `$new` and `$list`: a listed alert is never raised again); `install` (only
  `contents: read`, no token in it) runs `pnpm install --lockfile-only --ignore-scripts
  --no-frozen-lockfile` with the floors and `verify`: every alert taken is fixed, every floor
  holds, and nothing but the floored packages moved; `publish`, the only writer, builds the
  commit through the API on the planned main (main moved meanwhile: the next day), keeps ONE
  rolling PR on `security/overrides` and starts CI and the dependency review on it (not when
  a run that ran covers its head: a `pull_request` run of a PR this token opened waits for an
  approval, `action_required`). A PR closed unmerged by hand declines its alerts (issues);
  this workflow's own closes carry `<!-- security-overrides: closed-by-run -->`. pnpm saying no
  version fits (`ERR_PNPM_NO_MATCHING_VERSION`, `ETARGET`) demotes those alerts to issues;
  any other install failure fails the run (the report job opens "Security override route
  failed"). The fsaunpack lockfile stays on the issue route. `update-prs.yml` reports on the
  PR as the kind `security`.
- **The Security tab's count also holds CodeQL code scanning** (2026-10-03). GitHub's
  default setup runs it on every push to `main` (Actions shows it as "CodeQL",
  `dynamic/github-code-scanning/codeql`; there is no workflow file), JavaScript and
  Actions, and security-alerts.yml does not see its alerts. It runs 105 JavaScript queries
  (read off a CodeQL job log's `Loaded .../javascript-queries/...` lines;
  `javascript-code-scanning.qls` has only 89) with **local sources on**: environment
  variables, files read, command-line arguments and stdin count as untrusted. The API is not
  reachable from a session without `gh`, so reproduce a scan: the CodeQL bundle from
  github/codeql-action's releases, `codeql database create --language=javascript-typescript`
  on `git archive origin/main`, then `database analyze` with those 105 queries,
  `--threat-model=local` and `--rerun` (a cached result from a run without it is reused
  silently). On `main` at c6372bc that gives 70 results, nearly all in tools and tests and
  dismissed on the Security tab, so compare a branch against `main`, never against zero, and
  ask the owner which alerts are open. On 2026-10-04 the open ones were 2 Dependabot
  (node-forge, braces: dev-only, no fixed release) and 5 CodeQL: `FASTSTREAM_MPV_PATH` into
  the mpv host's `statSync` (the variable is gone; `config.json`'s `mpvPath` does the same),
  `FS_EXT_BUILD` into e2e log names (`BUILD` is now one of the two constants),
  instagramInject.test.mjs running a file read (now a `?raw` import), and the MP4 fixture
  download in `mp4Fixture.mjs` (js/http-to-file-access; checked against its pinned SHA-256
  before it is written, so dismissed as a false positive). #320's five fixes (the direct
  player's `video.src`, the fsaunpack rate limiter, firefox.e2e.mjs) were real but were not
  open alerts: the count matched by chance, a mistake not to repeat.
- **`vendored-updates.yml`** (daily, 06:45 UTC), 2026-10-01, U1: the two vendored files no
  other workflow watches. (The silero VAD model's job, which opened a PR on
  `vendored/silero-vad-<tag>` for a newer model, went with the speech detector on
  2026-10-10.) **vtt.js:** a dash.js release that changes `contrib/videojs-vtt.js/vtt.js` gets an issue,
  "vtt.js changed in dash.js <tag>", with the changed-line count and a compare link: a
  person moves `tools/verify-vtt.mjs`'s tag and re-runs `verify:vtt`. Each item is assigned
  + @mention, is never raised twice (closing it skips that release), closes itself once its
  pin reaches its tag, and a newer release's item closes older ones. On 2026-10-01 both
  were current in effect: silero-vad v6.2.3 and dash.js v5.2.1 publish the same bytes as
  the pins (v6.2.1, v5.1.0). `tests/workflows/vendored-updates.test.sh`: 10 scenarios
  (real git pushing to a local bare origin), and 7 undone rules each fail it.
  **Adapted copies** (job `sources`, 2026-10-01 to 2026-10-22, removed): it watched the
  upstream file of each copy in `tools/vendored-sources.json` (knob.mjs, crosstalk/fft.mjs and
  vad/vad.mjs until 2026-10-10, when they went with the audio settings and the speech
  detector; StreamSaver.mjs last) and opened "Vendored source changed upstream: ..." when
  upstream changed it after the copy's ref. StreamSaver.mjs keeps only StreamSaver.js's API
  name (`streamSaver.createWriteStream`): its body is FastStream's own OPFS and memory sinks
  (every save uses them since 9ef061b1; the ServiceWorker transport it was taken for is gone,
  `StreamSaver.mjs`'s `createWriteStream` comment says why), so an upstream change had
  nothing to port, and the job, its list and `tests/workflows/vendored-sources.test.sh` went.
- **`dependency-review.yml`** fails a PR that adds a package with a high-severity advisory.
  Since 2026-09-30 it also runs on `workflow_dispatch`, which `patched-libraries.yml` sends
  next to CI's: its PRs are opened by the workflow token, so the `pull_request` run waits
  for an approval, and a lockfile change from outside Dependabot went unreviewed (the
  upstream sync's too, until 2026-10-09). A dispatched run compares `main` with
  the commit's hash (`base-ref`/`head-ref`; the compare API answers 404 for an unencoded
  branch name with a `/`). Checked on two probe branches off `main`: brace-expansion
  2.1.4 -> 2.1.3 failed on its three high advisories, the fixed lockfile passed.
  `update-prs.yml` names a review that did not pass in its comment on those PRs.
- **`build.yml` was removed**: CI already builds and uploads the same zips.
- **The fork no longer follows upstream (2026-10-09, the owner's decision).** FastStream here
  is Firefox-only and maintained on its own, ahead of upstream (Andrews54757/FastStream,
  Chrome first); an upstream change matters only as a fix this fork's code may need too,
  ported by hand. `sync-upstream.yml` (2026-09-10 to 2026-10-09: upstream merged into a
  `sync/upstream` PR daily, and `update-prs.yml` judged it) was removed, with its tests and
  every `sync/upstream` case in `update-prs.yml`, `ci.yml`'s hand-off and
  `dependency-review.yml`. The last sync PR (#368) was closed: of its 18 commits, 13 were the
  owner's own upstream PRs, the security fix came from his report and was here already, "Fix
  yt" has no code to apply to, V1.3.78 is a version bump; the aspect-ratio option (#552) is a
  feature for his decision. `docs/upstream-sync-log.md` keeps the record of the merge years.
- **`upstream-watch.yml`** (2026-10-09) runs daily (06:00 UTC) and lists upstream's commits
  not reviewed yet in one issue, "Upstream: N commit(s) to review", assigned to the owner
  and @mentioning him; when upstream moves again the issue is updated and a comment with
  the mention says how many came. Each commit names its files, those this fork still has in
  bold, and "fix?" when its message speaks of a fix, a bug, a crash, a leak or security; a
  commit touching only files this fork does not have is listed apart. **Closing the issue
  marks its commits reviewed**: the next run starts at the closed issues' upstream commit
  (`<!-- upstream-head: ... -->`) nearest upstream's head, whatever order they were closed
  in, leaving out one upstream no longer has (a force-push); without one, at what `main`
  last merged. Nothing is committed for it (a push to main releases). Opening an issue again
  means "not reviewed after all": its commits are listed again. Another project's text is made safe: `<`
  escaped (a fake marker in a subject was read first), `@` defused, `#123` written as
  upstream's. At most 60 commits and 8 files a commit are listed. Permissions: contents read,
  issues write. "Upstream watch failed" is opened on a failure and closed by the next clean
  run. `tests/workflows/upstream-watch.test.sh` (real git, stub `gh`; the escaping and
  where the list starts each fail a check when undone).
- **The secrets** that can do harm are no repository secrets any more: the AMO keys are the `release`
  environment's (main and tags `v*` only), `UPDATE_PRS_TOKEN` the `update-prs` one's (main
  only), so no other branch's workflow can read them; the jobs that use them name the
  environment with `deployment: false` (no deployment records), and
  `tests/unit/workflowSecrets.test.mjs` fails for a job that reads one without it
  (docs/maintenance.md, "Secrets in environments").
- **`patched-libraries.yml`** + `tools/check-patched-updates.mjs` + `tools/recut-patch.mjs`
  (2026-09-25): Dependabot ignores the six libraries in `patchedDependencies` (a bump
  leaves the patch unapplied), so for each new version this re-cuts the patch itself.
  Clean, checks passed: a PR from `patched/<name>-<version>`, with CI dispatched on it (a
  push by `GITHUB_TOKEN` starts no workflow; `gh workflow run` does). Conflict or failed
  check: an issue with the tool's report. Too new for pnpm's `minimumReleaseAge`
  (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`): nothing until the next daily run. Both
  assigned + @mention, never raised twice (issue or PR titles, any state), closed when
  the patch is cut against that version or newer; closing one by hand skips the
  version. Runbook: `docs/updating-patched-libraries.md`. The tool reproduces every
  current patch byte for byte and replays the hand-cut hls.js 1.7.2 -> 1.7.3 upgrade
  exactly; the workflow step was dry-run in WSL with a stub `gh` and stub tools (every
  path: PR, issue, too new, already raised, caught up, no longer patched, push).
  `tests/unit/checkPatchedUpdates.test.mjs` fails if Dependabot's ignore list and
  `patchedDependencies` drift apart; `tests/unit/recutPatch.test.mjs` covers the tool.
- All of it was dry-run with a stub `gh` against the real upstream history (sync: adopted
  -> closed, push -> no rebuild, new release named, comment only on upstream movement;
  patched libraries: open once, no duplicates, close when caught up or unpatched).
- **`mutation-tests.yml`** (2026-10-01 to 2026-10-22): Stryker over the unit-tested modules,
  weekly. Removed with Stryker: its reports (about 4,700 mutants not caught, 64.6% to 68%)
  were closed by hand each week and no fix came from them, while it carried a 131-line patch
  of its vitest runner, an override and 34 MB of packages. The fixes kept their own check: a
  hand-made mutation of each one, which its test must catch.
