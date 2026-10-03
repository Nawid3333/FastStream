# How updates reach FastStream

Nothing merges itself (your choice, 2026-10-02): every update arrives as a PR and waits for
your merge. `update-prs.yml` runs after every completed CI run for this repository's
`dependabot/*`, `toolchain/*`, `patched/*` and `sync/upstream` branches and comments
on the PR, assigned to you: **ready to merge** once CI is green and its checks hold (only
that bot's commits, only the files that kind of update changes, the dependency review
passed, no package version under 7 days old in its lockfile, and the build unchanged when
it is not meant to ship), or what to look at before merging, or why CI failed. The comment
says whether your merge releases: an update that ships starts CI on `main` with your merge,
and a green run there releases it to Firefox. The mpv pin comes as one PR that keeps up with
shinchiro's builds. Updates without a PR - a runner image, a new Firefox - are watched by
their own workflows, which stay silent while they pass. Until 2026-10-02 green updates
merged themselves.

## Every update source

| What | How it arrives | What happens on green | What reaches you |
| ---- | -------------- | ---------------------- | ---------------- |
| npm tooling, minor/patch | one grouped Dependabot PR a week (`tooling-minor-and-patch`) | "ready to merge"; your merge releases nothing (the build is unchanged) | the PR |
| npm shipped libraries (fuse.js, mediabunny, onnxruntime-web, pako, sortablejs), minor/patch | one grouped Dependabot PR a week (`shipped-minor-and-patch`) | "ready to merge"; your merge starts CI on `main`, and a green run there releases it | the PR; GitHub emails you when CI on `main` fails after your merge |
| npm major | a Dependabot PR of its own (after the 5-day cooldown) | "ready to merge": a tooling major when the build is unchanged; a shipped library's releases after your merge, as for the shipped group | the PR |
| fsaunpack (express) | a Dependabot PR for `fsaunpack/`, the helper that unpacks and serves a saved `.fsa` archive; not part of the extension | "ready to merge" when it changes only `fsaunpack/package.json` and `fsaunpack/package-lock.json` and every version that lockfile adds is 7 days old; CI installs it (scripts off) and starts its test server on a recorded archive (`pnpm run verify:fsaunpack`). | the PR |
| GitHub Actions | one grouped Dependabot PR a week (minor/patch), a major on its own | "ready to merge" when it changes only workflow and action files; `update-prs.yml` brings its branch up to date with your token `UPDATE_PRS_TOKEN` (below) | the PR |
| pnpm 11.x | a PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/pnpm-<version>`, changing only `packageManager`, once the release is 5 days old; one in conflict with `main` is rebuilt on it weekly | "ready to merge" | the PR |
| pnpm next major | a PR from `toolchain-updates.yml`, once dependabot/dependabot-core#15904 is closed | as for 11.x; one that wants the lockfile rewritten fails CI, and the comment says so | the PR |
| Node LTS | a PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/node-<major>`, changing `.nvmrc` | "ready to merge" when the build is unchanged | the PR |
| WSL, on your PC | `wsl-releases.yml` (daily) looks up WSL's newest release; nothing in the repository changes | nothing to merge: GitHub can't update your PC | an issue per release, "WSL update: <version>", with the commands; close it once you have updated (a newer release closes it for you) |
| patched libraries, minor/patch | a PR from `patched-libraries.yml` on `patched/<name>-<version>` with the re-cut patch, CI dispatched on it | "ready to merge"; your merge releases as for the shipped libraries | the PR |
| patched libraries, major | the same (a re-cut that is not clean comes as an issue instead) | as for minor/patch | the PR |
| upstream sync | a PR from `sync-upstream.yml` (daily; a push to `main` only closes it once nothing is left), with CI dispatched on it | "ready to merge" when it has no conflict, changes nothing under `.github/`, brings back no file this project deleted, and every commit on it is upstream's own; merge it with **Create a merge commit** (keeping upstream's commits), and it releases as for the shipped libraries | the PR |
| mpv build | one PR from `mpv-updates.yml` on branch `mpv-update`, which moves to each newer build of shinchiro's that passes CI | "ready to merge"; your merge releases nothing (only CI installs this mpv) | the PR (one, not one a day); an issue on failure |
| runner images | `runner-images.yml` runs `ci.yml` on the new image | the run is recorded, so the same image is not retested | nothing; an issue per image on failure |
| actionlint and zizmor images | a Dependabot PR (docker, weekly) changing the tag and digest in `.github/actionlint/Dockerfile` or `.github/zizmor/Dockerfile` (or only the digest, when the same tag was pushed again: dependabot/dependabot-core#15081), which `ci.yml`'s workflows job and the WSL verify read | "ready to merge" when it changes only those files: CI ran every workflow file through the new checks | the PR |
| Firefox stable, beta | `firefox-stable.yml` (daily) and `firefox-beta.yml` (Mon, Thu) run the e2e suites on that Firefox | a stable version is recorded as tested, so later days skip it | nothing; an issue on failure, closed by the next green run |
| adapted copies of other projects' code (knob, StreamSaver, fft.js, vad-web) | `vendored-updates.yml` (daily) checks the upstream file each came from (`tools/vendored-sources.json`) | nothing to merge: the copies are changed here, so a person ports upstream's changes | an issue per copy and upstream change, "Vendored source changed upstream: <name> (...)", with the commits; it closes once `tools/vendored-sources.json` has the copy at that commit |
| security alerts | a Dependabot alert on the Security tab, and a Dependabot PR that fixes it (the rows above), skipping the cooldown; `security-alerts.yml` (daily) watches for an alert with no such PR | as the PR's row says | GitHub's alert email; for an alert over 6 hours old with no Dependabot PR, an issue per package, "Security alert: <package>", closed once its alerts are fixed on `main` or dismissed |

Dependabot proposes a release once it is 5 days old (`cooldown` in `.github/dependabot.yml`);
security updates skip the wait. The cooldown covers only the packages it bumps, not what
the new lockfile brings in with them, so `update-prs.yml` looks up every package version a
Dependabot PR adds to `pnpm-lock.yaml` on the npm registry: one under 7 days old, or whose
age the registry does not give, keeps the PR from "ready to merge", even a tooling one. A poisoned
release is usually found and pulled within days. The patched libraries are ignored by
Dependabot on purpose: they arrive from `patched-libraries.yml`
(`docs/updating-patched-libraries.md`). The other libraries the extension ships come in the
weekly shipped group, `onnxruntime-web` and `mediabunny` among them since 2026-09-30 (until
then the first was held for its custom wasm, and `mp4-muxer`, which Mediabunny replaced, for
a last release that crashed). A PR from that group changes the extension, so CI runs on `main` after its
merge and decides the release; CI's `tests/e2e/ext-specs/vad.e2e.mjs` and `tests/e2e/specs/modules.e2e.mjs` are what
check those two. Mediabunny releases every few days, so expect it in most of them.
A security update Dependabot cannot make itself leaves its alert open with no PR: a
package the lockfile holds at several majors, as brace-expansion was (1.x, 2.x and 5.x,
2026-09-30), fails in its "Dependabot Updates" run, which emails no one. So
`security-alerts.yml` opens the "Security alert: <package>" issue for it, with its alerts
and these steps. `pnpm update <package>` on a branch moves every major to its patched
release within the ranges that ask for it (in `fsaunpack/`, `npm update <package>` does the
same for its `package-lock.json`); check `git diff` touches nothing else, and open a PR.
The issue closes itself once none of its alerts is open: GitHub marks an alert fixed once
the fix is on `main`, and a push that changes a lockfile waits up to 10 minutes for that
(the daily run closes it otherwise). Dismissing an alert on the Security tab closes it too.
Closing the issue yourself skips the alerts it lists; a new alert for that package still
opens a new one.
In the table, "ready to merge" means one comment that @mentions you - CI is green and
every check holds - with the PR assigned to you; a comment with the same verdict as the
last one is edited in place, so a repeat sends no second email.

## Your PC

GitHub can't update your PC, so one double-click checks it: `update-local.cmd` in the
repository's root. It compares your tools with what CI uses, by CI's rule (a release counts
once it is 5 days old), and changes nothing without asking:

- Node.js of the major `.nvmrc` names: whether a newer eligible release is on nodejs.org.
- npm's newest release, and the pnpm version `package.json` pins (inside the repository
  pnpm switches to that one by itself).
- On `main` with nothing uncommitted: how many commits it is behind origin, and whether the
  locked dependencies (`pnpm install --frozen-lockfile`, fsaunpack's `npm ci`, scripts off)
  need a run: only when a lockfile changed after the last install.
- The mpv helper: whether the repository's differs from the installed one.

When it finds something out of date it asks "Update these now?", and Y applies all of it
(the same as `tools/update-local.ps1 -Apply`), by the same rule as the check: Node comes as nodejs.org's installer, checked against its
`SHASUMS256.txt` (Windows asks for admin rights; say yes), npm and pnpm install with
scripts off, the pull is `--ff-only` on a clean `main`, and the mpv helper keeps your mpv
and Node paths.

It never touches Firefox (it updates itself, and FastStream from the releases), mpv
(`C:\Program Files\mpv` has its own repository and updater) or WSL (`pnpm run verify:linux`
updates its distros; a "WSL update" issue says when WSL itself has a new release). Run the
check whenever you like: it changes nothing, and lists everything out of date with what to
do about it.

## When you get an email

### CI red on an update PR

CI has already failed twice on the same commit by the time you read this: after a
first failure `update-prs.yml` starts CI once more, in case a test was flaky, and the
comment says it failed twice. (If GitHub refused to start that second run, the comment
reports the one failure.) It holds a table of
each failed job, the step that failed and what that step checks, the last 40 lines
of each failed log, and `main`'s latest CI status; the PR carries the `ci-failed`
label and is assigned to you. Then:

- Push a fix to the branch: the next CI run decides again. A fix you push makes the
  PR yours, so the comment then asks you to look at it even when CI is green.
- Or close the PR. For this repository's own update PRs (toolchain, patched
  libraries) a title is never used twice, so closing skips that version for good.
  For a Dependabot PR, tell Dependabot: `@dependabot ignore this minor version` (or
  `this major version`, `this dependency`). `@dependabot rebase` rebuilds its branch
  on the newest `main`.

### CI green: ready, or look first

"Ready to merge": merge it when you like (an upstream sync with **Create a merge commit**).
Otherwise the comment names the check the PR failed - a tooling update whose build differs
from the latest release, a file that kind of update does not change, a package version
under 7 days old, an upstream sync with a conflict or a file this project deleted, a GitHub
Actions update while `UPDATE_PRS_TOKEN` is missing, the `hold` label - and the PR is
assigned to you. Look at that, then merge it or close it as above. The comment is
edited in place while the PR keeps waiting, even if the reasons change: a new email
comes when it turns red, turns green, is merged, or fails at a different step.

A CI run that was cancelled or skipped decides nothing. The next completed run
does: rerun it from the Actions tab, or push. (The weekly toolchain run starts CI on
its own pull requests when their head has no run that decides.)

A pull request a workflow opened - toolchain, patched library, upstream sync - shows
its CI and Dependency review runs as "approval required": GitHub holds the
`pull_request` runs of a pull request its own token opened. You can leave them: the
workflow that opened the pull request starts CI on its branch itself, and that run
decides. For a patched-library or upstream-sync PR (both change `pnpm-lock.yaml`) it
starts `dependency-review.yml` there too, and "Review dependency changes" appears among
the PR's checks; when it did not pass, `update-prs.yml`'s comment names that. A
toolchain PR leaves the lockfile alone.

### An issue from a watcher

Some failures arrive as an issue rather than a red PR: the mpv build, a runner
image, a Firefox version, the upstream sync, a patched library whose patch could
not be cut. Each names what failed. The Firefox, runner-image and sync issues
close themselves on the next green run, a patched-library one when the patch is
cut against that version or newer, a "Security alert" one when its alerts are fixed or
dismissed. If `update-prs.yml`, `toolchain-updates.yml`, `wsl-releases.yml` or
`security-alerts.yml` itself fails, it opens one issue, "Update PRs workflow failed",
"Toolchain updates workflow failed", "WSL releases workflow failed" or "Security alerts
workflow failed", while that one is open.

Once a week, `flaky-specs.yml` opens "Flaky e2e specs: week to <date>" when a CI run in
those 7 days had to run a spec file again: a test that failed once and passed on its
retry leaves a green run, so this is the only place it shows up besides that run's
summary. The next week's issue closes it, and so does a week with no retry.

A push to `main` is released even when a late run cancelled its CI run (GitHub once
delivered an older push a second time), or when a push landed while
it ran and nothing started CI after it: `auto-release.yml` restarts the run, or starts CI
on `main` itself, and you hear nothing. "CI on main needs a re-run" arrives only when a
third attempt was cancelled too or GitHub refused the re-run: re-run it from the Actions
tab, and the issue closes at the next green CI run on `main`. "Auto release failed" means
such a run was red or its release failed; the issue links the run.

Once a week, `mutation-tests.yml` changes the code the unit tests cover one thing at a
time and checks the tests notice. When they miss some, "Mutation testing: week to <date>"
lists them: each is a place a fix could ship without a test that fails without it. Nothing
waits on it; the next week's issue replaces it, and a week with every change caught closes
it.

## What update-prs.yml checks before it says "ready to merge"

Nothing merges itself (the owner's choice, 2026-10-02; from 2026-10-01 every kind of update
merged itself once CI was green, and before that the routine ones that ship nothing). The
comment says "ready to merge" only when all of this holds:

- the PR was opened by its bot, targets `main`, is not a draft and has no `hold` label;
- its commits are that bot's, or the merges of `main` this workflow makes when it updates
  the branch; an upstream sync's are upstream's own, checked against upstream's repository;
- it changes only what that kind of update changes: `package.json` and `pnpm-lock.yaml`
  (Dependabot npm; for pnpm, only the `packageManager` line); `fsaunpack/package.json` and
  `fsaunpack/package-lock.json`; `.nvmrc` (Node); workflow and action files (GitHub
  Actions); the two Dockerfiles (actionlint, zizmor); a re-cut's files (patched libraries);
  anything but `.github/` (upstream sync, which must also have no conflict and bring back no
  file this project deleted);
- its dependency review passed, and every package version it adds to its lockfile is 7 days
  old on the npm registry (Dependabot's cooldown covers only what it bumps);
- an update not meant to ship (tooling, toolchain, workflows, fsaunpack): CI's build of the
  extension is file-for-file the latest release's, the version number aside, so it releases
  nothing. A shipped library, a patched library or an upstream sync is meant to ship: CI
  then runs on `main` and a green run releases;
- last: the PR is mergeable and the branch contains the newest `main`, so what you merge is
  what CI tested; if it does not, the workflow runs GitHub's update-branch, CI starts again
  and that run decides, at most 3 times.

Your merge is a push of yours, so CI runs on `main` after it, and a green run releases what
ships (auto-release.yml); GitHub emails you when that run fails. A red `main` releases
nothing, and nothing is reverted on its own. `main` carries a ruleset that blocks
force-pushes and deletion only, with no required checks.

## Moving Node by hand

`.nvmrc` is the one place the Node major is named. Every workflow's setup-node
reads it (`node-version-file: .nvmrc`, with `check-latest`), and so does
`tools/linux/setup.sh`, which keeps the WSL verify on the same major as CI. A
Node update is therefore a one-file change: the toolchain workflow's
`GITHUB_TOKEN` may not push changes to `.github/workflows/*`, and
`tests/unit/checkToolchain.test.mjs` fails if a workflow names its own
`node-version` or a setup-node step lacks `node-version-file: .nvmrc`.

- Edit `.nvmrc`, run `pnpm run verify` and `pnpm run verify:linux` (the same two
  halves CI runs), then push. `toolchain-updates.yml` runs on a push to `main` that
  touches `.nvmrc` or `package.json`, and closes any open PR the project has
  just reached.
- Or run the Toolchain updates workflow (Actions, Run workflow), which opens the
  PR on `toolchain/node-<major>` for a newer LTS major, with CI on it; it waits
  for your merge.

## Pinning a new tool

A version written down somewhere needs something that updates it, or it stays on that
version and nobody hears. `tests/unit/checkToolchain.test.mjs` fails for an action or an
image pinned in a form Dependabot does not update:

- An action, in a workflow or in a composite action under `.github/actions/<name>/`:
  pinned to its commit, with the version as a comment (`uses: owner/repo@<sha> # v1.2.3`).
  Dependabot's github-actions entry watches `/` (which means `.github/workflows` only) and
  `/.github/actions/*`.
- A container image: not a `docker://` line in a workflow, which Dependabot leaves alone,
  but a `FROM <image>:<tag>@sha256:<digest>` line in a Dockerfile of its own under
  `.github/`, with a docker entry for that directory in `.github/dependabot.yml`; the
  workflow reads the line from there, as `ci.yml` does with `.github/actionlint/Dockerfile`.
- Node only in `.nvmrc`, pnpm only in `package.json`'s `packageManager`, npm packages in
  `package.json` and `pnpm-lock.yaml`, mpv in `.github/mpv-build.json`: each has its
  updater in the table above.

## Vendored files

Two files the extension ships come from another project without a package manager:
`vendored-updates.yml` (daily) watches them.

- **The voice detector's model** (`chrome/player/modules/vad/silero_vad_half.onnx`, from
  snakers4/silero-vad): a newer release with a different model opens a pull request,
  "Vendored model update: silero-vad <tag>", with the model and its pin in
  `tools/verify-vad.mjs` replaced, and starts CI on it. The voice detector's reference test
  decides; merge it when green, close it to skip that release. If the model is not where
  the release used to keep it, an issue tells you so instead.
- **vtt.js** (`chrome/player/modules/vtt.mjs`, from dash.js): a dash.js release that changes
  the file opens an issue, "vtt.js changed in dash.js <tag>". Move the tag in
  `tools/verify-vtt.mjs` and run `pnpm run verify:vtt`, which says where FastStream's changes
  no longer apply.

Each closes itself once its pin reaches the release; a newer release closes the older one.
If the workflow itself fails, it opens "Vendored updates workflow failed (model)" or
"(vtt.js)".

## A token for workflow updates

GitHub's own token in a workflow may not push a change to a workflow file, so bringing
Dependabot's GitHub Actions PRs up to date with `main` needs one of yours. `update-prs.yml`
uses it only for that (it merges nothing); nothing else sees it, and it never runs the PR's
code. Without it the comment asks you to use **Update branch** on such a PR yourself.

1. On GitHub: your picture, **Settings**, **Developer settings**, **Personal access tokens**,
   **Fine-grained tokens**, **Generate new token**.
2. Name it `FastStream update-prs`. Expiration: the longest offered (GitHub emails you a week
   before it runs out; an expired token fails `update-prs.yml`, which opens an issue).
3. **Repository access**: Only select repositories, `Nawid3333/FastStream`.
4. **Permissions**, Repository permissions: **Contents**, **Pull requests** and **Workflows**,
   each Read and write. (Metadata: read-only is added by itself.)
5. **Generate token**, and copy it.
6. In the repository: **Settings**, **Secrets and variables**, **Actions**,
   **New repository secret**. Name `UPDATE_PRS_TOKEN`, paste the token, **Add secret**.

An Actions update changes nothing the extension ships, so your merge of one releases
nothing.
