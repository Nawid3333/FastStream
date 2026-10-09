# Workflows

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Workflows (reworked 2026-09-25)

- **`ci.yml`** runs what `pnpm run verify` runs (including `test:pbm` and,
  since 2026-09-25, `verify:vtt`/`verify:knob`/`verify:vad` - `verify:vtt` had been red
  for three days when nothing ran it - and since 2026-09-30 `verify:fsaunpack`, which
  installs fsaunpack's own npm lockfile and starts its express test server;
  `verify:ort` left the chain on 2026-09-30 with the custom ONNX Runtime wasm it
  stamped), plus a
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
  the owner. (2) A push by `GITHUB_TOKEN` starts no CI (until 2026-10-02 `mpv-updates.yml`'s
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
  one issue while it fails. Also on a PR that changes the live suite or the e2e setup.
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
  5 days old, changes `packageManager` in `package.json` and nothing else, and waits
  for the owner's merge. Nothing from npm runs in that job, beside its write token: CI
  installs the lockfile unchanged with the new pnpm (`--frozen-lockfile`), so one that
  wants it rewritten fails CI and reaches the owner. A newer pnpm major waits
  for dependabot-core#15904 to close, then comes the same way (pnpm 12's two-document
  lockfile hides every dependency from GitHub's dependency graph; 12.6.0 otherwise
  passed the full verify on 2026-09-25).
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
  October 2026). The decision logic is `plan()` in `tools/check-toolchain.mjs`,
  unit-tested. Dependencies stay pinned by the lockfile on purpose (patches, AMO
  reproducibility); Dependabot's weekly grouped PRs are how they move, each release
  proposed once it is 5 days old (`cooldown` in `.github/dependabot.yml`; security
  updates skip the wait): npm minor/patch is split into `shipped-minor-and-patch`
  (fuse.js, mediabunny, onnxruntime-web, pako, sortablejs - the unpatched libraries
  `tools/sync-vendor.mjs` copies into the extension) and `tooling-minor-and-patch`
  (everything else), so a tooling update is not held back by a shipped one;
  `update-prs.yml` merges both when green (the shipped one then releases, see below).
- **`update-prs.yml`** (2026-09-29) runs after every completed CI run (`workflow_run`;
  for a run a workflow's token started, which sends none, `ci.yml`'s hand-off starts it by
  `workflow_dispatch`, and opens "Update PRs hand-off failed" when GitHub refuses all three
  tries) for this repository's `dependabot/*`, `toolchain/*`, `patched/*` and
  `sync/upstream` branches, and never checks out PR code. `gh pr list --head` lists a fork's
  pull request from a branch of the same name too: it, `sync-upstream.yml` and
  `mpv-updates.yml` drop those (`isCrossRepository`, #169; `tests/unit/workflowGh.test.mjs`
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
  patched libraries, the upstream sync) when it is not labelled `hold`, and only when its
  bot opened it (not a draft,
  against `main`) and its commits are the bot's or this workflow's merges of `main` (the
  owner's, made with their token; Dependabot's and those merges also signed by GitHub, as
  an author login is only the commit's e-mail, #170; an upstream sync's: in the history of
  upstream's `main`, `compare/<sha>...main` with `behind_by` 0 - not
  `repos/Andrews54757/FastStream/commits/<sha>`, which finds any commit of the fork network,
  this repository's own included), it changes only what its kind
  changes (`package.json` + `pnpm-lock.yaml`; for pnpm only `packageManager`, the lockfile
  untouched; fsaunpack's two files; `.nvmrc`; `.github/workflows` + `.github/actions`;
  the two Dockerfiles; a re-cut's `pnpm-workspace.yaml`, `patches/`, `tools/sync-vendor.mjs`;
  an upstream sync anything but `.github/`, with no "(CONFLICTS - resolve before merging)"
  commit and no added file that main's history has, i.e. one this project deleted), the
  dependency review passed, every version its lockfile adds is 7 days old (fsaunpack's
  `package-lock.json` read with jq), it is mergeable, it contains the newest `main`
  (otherwise GitHub's update-branch runs, CI restarts and that run decides, at most 3
  times), and, for an update that must not ship (all but the shipped libraries, patched
  libraries and the upstream sync), CI's build of the extension (the `faststream-bundles`
  artifact, both zips) is file-for-file identical to the latest release's zip and xpi
  apart from `manifest.json`'s version - `auto-release.yml`'s own test, so such a merge
  releases nothing. A shipped library's major comes on its own branch: it ships when one of
  its `dependency-name`s is in the `shipped-minor-and-patch` patterns of main's
  `.github/dependabot.yml` (unreadable: treated as tooling, whose build must not differ).
  GitHub Actions updates change workflow files, which `GITHUB_TOKEN` may not merge or
  update: that is done with the owner's fine-grained token, secret `UPDATE_PRS_TOKEN` of the
  `update-prs` environment
  (Contents, Pull requests, Workflows: write; docs/maintenance.md, "A token for workflow
  updates"), used only to bring such a branch up to date. The comment tells the owner to
  merge an upstream sync with a merge commit, keeping upstream's commits. His merge is his
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
  start: gh can give a log with every step "UNKNOWN STEP"). Without
  E2E_SHARD a config runs all its spec files (local `pnpm run verify`). The private
  browsing suite (one spec file) runs in the first extension group only. A run is 18 jobs
  at once of the account's 20, so more groups would only queue; the weekly mutation run
  (Mondays, 7 jobs for hours) leaves 13, and a push during it runs in two waves.
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
- **No CVE watch for the vendored components outside the lockfile** (vtt.js, knob,
  StreamSaver): measured 2026-09-25, OSV has
  never recorded a vulnerability for any of them, so a workflow could never fire. They are
  covered by the provenance checks instead. The lockfile-backed libraries are covered by
  Dependabot alerts (OSV's only hls.js record, MAL-2026-3019, is two canary builds, not 1.7.3);
  since 2026-09-30 that includes the ONNX Runtime wasm, which ships as `onnxruntime-web`
  publishes it.
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
  swapped in too.
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
  other workflow watches. **The silero VAD model:** a newer snakers4/silero-vad release whose
  half-precision model has other bytes gets a PR on `vendored/silero-vad-<tag>` with the
  model replaced and TAG/SHA256 moved in `tools/verify-vad.mjs`, and CI dispatched on it
  (the reference e2e decides); update-prs.yml leaves `vendored/` branches to the owner. A
  model missing at its path gets an issue, "Silero VAD <tag>: the model file moved".
  **vtt.js:** a dash.js release that changes `contrib/videojs-vtt.js/vtt.js` gets an issue,
  "vtt.js changed in dash.js <tag>", with the changed-line count and a compare link: a
  person moves `tools/verify-vtt.mjs`'s tag and re-runs `verify:vtt`. Each item is assigned
  + @mention, is never raised twice (closing it skips that release), closes itself once its
  pin reaches its tag, and a newer release's item closes older ones. On 2026-10-01 both
  were current in effect: silero-vad v6.2.3 and dash.js v5.2.1 publish the same bytes as
  the pins (v6.2.1, v5.1.0). `tests/workflows/vendored-updates.test.sh`: 10 scenarios
  (real git pushing to a local bare origin), and 7 undone rules each fail it.
  **Adapted copies** (job `sources`, 2026-10-01): `tools/vendored-sources.json` lists code
  copied from other projects and changed here (knob.mjs from jherrm/knobs, StreamSaver.mjs,
  crosstalk/fft.mjs from indutny/fft.js, vad/vad.mjs from ricky0123/vad), each with the
  upstream path and the commit it was taken from. When upstream's newest commit to that path
  is not in the ref (compare status behind or diverged), an issue "Vendored source changed
  upstream: <name> (<repo> <sha8>)" lists the commits after the ref that changed it; port by
  hand, move the ref, and it closes itself. The lists are read on fds 3/4 (gh.exe via WSL
  swallowed stdin and ended the loop after the first source). On 2026-10-01 knob (16 commits
  after its 2012 pin) and vad-web (37 since 2023-03-30) were behind, StreamSaver and fft.js
  current. `tests/workflows/vendored-sources.test.sh`: 8 scenarios, 10 undone rules caught.
- **`dependency-review.yml`** fails a PR that adds a package with a high-severity advisory.
  Since 2026-09-30 it also runs on `workflow_dispatch`, which `sync-upstream.yml` and
  `patched-libraries.yml` send next to CI's: their PRs are opened by the workflow token, so
  the `pull_request` run waits for an approval, and the two PR kinds that change the
  lockfile from outside Dependabot went unreviewed. A dispatched run compares `main` with
  the commit's hash (`base-ref`/`head-ref`; the compare API answers 404 for an unencoded
  branch name with a `/`). Checked on two probe branches off `main`: brace-expansion
  2.1.4 -> 2.1.3 failed on its three high advisories, the fixed lockfile passed.
  `update-prs.yml` names a review that did not pass in its comment on those PRs.
- **`build.yml` was removed**: CI already builds and uploads the same zips.
- **`sync-upstream.yml`** runs daily (06:00 UTC) and on every push to `main`. The PR is
  assigned to the owner and @mentions them (a bot PR alone is not emailed); a comment
  with the mention follows only when upstream itself moved. Upstream release tags on the
  incoming commits are named in the title (tags fetched to `refs/upstream-tags/`, never
  `refs/tags/`). A push-triggered run only closes the PR once `main` holds every upstream
  commit; it never rebuilds it. The failure issue closes on the next clean run.
  `update-prs.yml` calls the PR ready to merge (with a merge commit) once CI is green when
  it is clean (no conflict, nothing under `.github/`, no deleted file back, only upstream's
  commits); otherwise it says what to look at. **A merge that changes anything under
  `.github/` gets no CI and no dependency review** (#163, 2026-10-03): a dispatched run
  takes its workflow file from the branch, so upstream's workflow would run with this
  repository's token and secrets; the PR says so, and the owner starts both after reading
  the change. `tests/workflows/sync-upstream.test.sh` (real git, stub `gh`). And the secrets
  that can do harm are no repository secrets any more: the AMO keys are the `release`
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
- **`mutation-tests.yml`** (Mondays 06:40 UTC), 2026-10-01, T4: Stryker
  (`stryker.config.mjs`, `pnpm run test:mutation`) over 25 pure-logic modules with unit
  tests (10 small ones added 2026-10-03, #253; the config says which wait, and why). A report, not a gate: the run summary gets a table per file
  (`tools/mutation-report.mjs`), the HTML report is the `mutation-reports` artifact, and when
  the unit tests missed mutants (survived, or no test reaches them), one issue "Mutation
  testing: week to <date>" lists them, assigned + @mention; next week's replaces it, a week
  with all caught closes it. **The command runner**, not the vitest one: every mutant runs the
  whole unit suite (`__STRYKER_ACTIVE_MUTANT__`), about 1.2 s each with 4 workers locally - on
  CI a mutant the tests miss runs the whole ~18 s suite, and one job per area ran out of its
  240 minutes at 51-74% with no report (#349, 2026-10-05): since then the three areas are
  seven shards (`PARTS` in the config, split by file size), each in a job of 350 minutes, and
  a shard that runs out of time (it ends cancelled) is reported as a failure. **Since
  2026-10-06 the vitest runner** with per-test coverage: a mutant runs only the tests that
  reached its code, in a Vitest that stays up (143 mutants in 31 s locally, ~12.5 tests a
  mutant). Its 10.0.0 release (August 2026) predates vitest 5, which joins a test's suite
  chain with ' > ', so its test filter matched nothing and every mutant "survived"
  (stryker-js #6210); FastStream carries the fix, stryker-js PR #6214, as a pnpm patch
  (`patches/@stryker-mutator__vitest-runner@10.0.0.patch`, the compiled files). When a
  release has it, the Patched libraries workflow opens the pull request that drops the patch,
  moves @stryker-mutator/core along (LOCKSTEP in `tools/check-patched-updates.mjs`: the runner
  requires its core's exact version) and hands both back to Dependabot, whose `stryker` group
  then keeps all of Stryker's packages in one pull request. A test that runs a module as a
  process of its own (mpvHostVersion's host; the Windows-only installer and update-local
  tests) does not see a mutant there. Compared mutant by mutant (command-runner run
  37384050152, 4.7 hours; vitest-runner run 37393654214, 10 minutes): 11,313 of 11,370 alike.
  The rest: each tool's entry line (`if (process.argv[1] ...`) a crashed run where the command
  runner caught, two swapped on one line of SubtitleUtils - and the mpv host's message loop
  (`main()`, `sendMessage()`), 24 mutants with no test reaching them. So the host is an area of
  its own on the command runner (`COMMAND_AREAS`, `host-1`, about an hour and a half), and core,
  network and tools are one vitest-runner shard each: four jobs. The sandbox leaves out `tsconfig.json`: Stryker rewrites it through
  TypeScript's JS API, which TypeScript 7 does not have. `tests/workflows/mutation-tests.test.sh`.
  Baseline, 2026-10-01 (73 min locally): 71.8% of 3,614 mutants caught; the weakest are the
  mpv host (47.7%), MpvBackend (58.4%), SubtitleUtils (63.2%) and TabTracker (68.4%), the
  best SubtitleSyncUtils (96%), MultiRegexMatcher, UrlMatchList and StreamPick (92%).
