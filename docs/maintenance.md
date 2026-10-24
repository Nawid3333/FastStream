# How updates reach FastStream

Nothing merges itself (your choice, 2026-10-02): every update arrives as a PR and waits for
your merge. `update-prs.yml` runs after every completed CI run for this repository's
`dependabot/*`, `toolchain/*` and `patched/*` branches and comments
on the PR, assigned to you: **ready to merge** once CI is green and its checks hold (only
that bot's commits, only the files that kind of update changes, the dependency review
passed, no package version under 3 days old in its lockfile (a security fix aside), and the
build unchanged when it is not meant to ship), or what to look at before merging, or why CI
failed; red twice, it is parked with a migration issue that says what to do. The comment
says whether your merge releases: an update that ships starts CI on `main` with your merge,
and a green run there releases it to Firefox. The mpv pin comes as one PR that keeps up with
shinchiro's builds. Updates without a PR - a runner image, a new Firefox - are watched by
their own workflows, which stay silent while they pass. Until 2026-10-02 green updates
merged themselves.

## Every update source

| What | How it arrives | What happens on green | What reaches you |
| ---- | -------------- | ---------------------- | ---------------- |
| npm tooling, minor/patch | one grouped Dependabot PR a week (`tooling-minor-and-patch`) | "ready to merge"; your merge releases nothing (the build is unchanged) | the PR |
| npm shipped libraries (fuse.js, mediabunny, sortablejs), minor/patch | one grouped Dependabot PR a week (`shipped-minor-and-patch`) | "ready to merge"; your merge starts CI on `main`, and a green run there releases it | the PR; GitHub emails you when CI on `main` fails after your merge |
| npm major | a Dependabot PR of its own (after the 3-day cooldown) | "ready to merge": a tooling major when the build is unchanged; a shipped library's releases after your merge, as for the shipped group | the PR |
| fsaunpack (express) | a Dependabot PR for `fsaunpack/`, the helper that unpacks and serves a saved `.fsa` archive; not part of the extension | "ready to merge" when it changes only `fsaunpack/package.json` and `fsaunpack/package-lock.json` and every version that lockfile adds is 3 days old; CI installs it (scripts off) and starts its test server on a recorded archive (`pnpm run verify:fsaunpack`). | the PR |
| GitHub Actions | one grouped Dependabot PR a week (minor/patch), a major on its own, each release once it is 3 days old | "ready to merge" when it changes only workflow and action files; `update-prs.yml` brings its branch up to date with your token `UPDATE_PRS_TOKEN` (below) | the PR |
| pnpm 12.x | a PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/pnpm-<version>`, changing only `packageManager`, once the release is 3 days old; one in conflict with `main` is rebuilt on it weekly | "ready to merge" | the PR |
| pnpm next major | a PR from `toolchain-updates.yml` | as for the same major; one that wants the lockfile rewritten fails CI, and the comment says so | the PR |
| Node LTS | a PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/node-<major>`, changing `.nvmrc` | "ready to merge" when the build is unchanged | the PR |
| the live suite's player libraries (`tests/e2e/live-specs/player-libraries.json`), minor/patch | ONE rolling PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/player-libraries`, rebuilt in place when the set changes or it conflicts with `main`: each library at its newest release of its pinned major that is 3 days old and fits the ranges they declare on each other (and on our hls.js); CI and the live suite are started on it | "ready to merge" once CI and the live suite passed on its commit, it changes only that file, its branch holds `main` and the build is unchanged. A failed live suite is named with its run (a public stream may be down): re-run it, and its end decides again. Closing the PR skips that set; the next set comes as a new PR | the PR |
| the live suite's player libraries, a newer major | not taken: the issue "Player libraries: newer majors" lists them (a page in `players.e2e.mjs` may need changing); closed by hand, it stays closed until another major comes | move the pin by hand, adapt the page, run the live suite | the issue |
| uBlock Origin in the dev profile | a PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/ublock-origin-<version>`, changing its entry in `tools/setup-dev-profile.mjs` (version, file, SHA-256), once the AMO release is 3 days old; the run downloads the file and checks it against AMO's SHA-256 first | "ready to merge" when the build is unchanged; nothing in CI uses the add-on | the PR |
| WSL, on your PC | `update-local.cmd` compares your WSL with WSL's latest release (once it is 3 days old); nothing in the repository changes | nothing to merge: answer Y, and it runs `wsl --update` and `wsl --shutdown` | no e-mail: you see it when you run `update-local.cmd` |
| patched libraries, minor/patch | a PR from `patched-libraries.yml` on `patched/<name>-<version>` with the re-cut patch, CI dispatched on it | "ready to merge"; your merge releases as for the shipped libraries | the PR |
| patched libraries, major | the same (a re-cut that is not clean comes as an issue instead) | as for minor/patch | the PR |
| upstream (Andrews54757/FastStream) | nothing to merge any more: this fork no longer follows upstream (your decision, 2026-10-09). `upstream-watch.yml` (daily) lists upstream's commits you have not reviewed yet, the files each touches and which of them this fork still has, and marks the likely fixes | nothing merges; port a fix by hand if it helps this fork | one issue, "Upstream: N commit(s) to review", updated in place; close it once reviewed |
| mpv build | one PR from `mpv-updates.yml` on branch `mpv-update`, which moves to each newer build of shinchiro's that passes CI | "ready to merge"; your merge releases nothing (only CI installs this mpv) | the PR (one, not one a day); an issue on failure |
| runner images | `runner-images.yml` runs `ci.yml` on the new image | the run is recorded, so the same image is not retested | nothing; an issue per image on failure |
| actionlint and zizmor images | a Dependabot PR (docker, weekly) changing the tag and digest in `.github/actionlint/Dockerfile` or `.github/zizmor/Dockerfile` (or only the digest, when the same tag was pushed again: dependabot/dependabot-core#15081), which `ci.yml`'s workflows job and the WSL verify read | "ready to merge" when it changes only those files: CI ran every workflow file through the new checks | the PR |
| Firefox stable, beta | `firefox-stable.yml` (daily) and `firefox-beta.yml` (Mon, Thu) run the e2e suites on that Firefox | a stable version is recorded as tested, so later days skip it | nothing; an issue on failure, closed by the next green run |
| security alerts | a Dependabot alert on the Security tab, and a Dependabot PR that fixes it (the rows above), skipping both 3-day waits; `security-alerts.yml` (daily) watches for an alert with no such PR | as the PR's row says | GitHub's alert email; for an alert over 6 hours old with no Dependabot PR, an issue per package, "Security alert: <package>", closed once its alerts are fixed on `main` or dismissed |
| security alerts Dependabot cannot fix, when an override floor fixes them | ONE rolling PR from `security-alerts.yml` (daily) on `security/overrides`, "Security fixes: override floors": a floor per package and major in `pnpm-workspace.yaml`'s `overrides` (raised, or added with a comment), and `pnpm-lock.yaml` rewritten for it (`--lockfile-only --ignore-scripts`, in a job with no write token), checked to fix every alert it takes and to move nothing else; CI and the dependency review are started on it | "ready to merge" when CI and the dependency review pass and it changes only those two files; no 3-day wait (a security fix). An alert it cannot take (no patched version, the fix a new major, a floor `main` has already, a parent-scoped override, two overrides reaching the same major) gets the issue above, with the reason. Closing the PR unmerged hands its alerts to you as issues | the PR |

Dependabot proposes a release once it is 3 days old (`cooldown` in `.github/dependabot.yml`;
your call of 2026-10-20, after none from 2026-10-11). Green CI cannot see a compromised
release - malware passes the tests - and most npm supply-chain compromises of 2025 were found
and pulled within hours to days: the wait lets that happen before a release reaches your
merge (Renovate's best-practice preset waits 3 days for npm too). The cooldown covers only
the packages Dependabot bumps, not what the new lockfile brings in with them, so
`update-prs.yml` looks up every package version a Dependabot or patched-library PR adds to
its lockfile on the npm registry: one under 3 days old, or whose age the registry does not
give, keeps the PR from "ready to merge", even a tooling one. The comment says when the
youngest is 3 days old (for an age the registry did not give, or a lockfile that could not
be read, a day later: that may have been a moment's failure); within a day after that, `security-alerts.yml`'s daily watch has
`update-prs.yml` decide again, and the PR becomes "ready to merge" by itself. A security fix
waits for neither: Dependabot gives its security updates no cooldown, and `update-prs.yml`
skips the age check for a Dependabot security update (the line "You can disable automated
security fix PRs" in its description) and for a PR every package of which has an open
Dependabot alert (a grouped update with one such package waits: that package's fix comes as
a security update of its own). `toolchain-updates.yml` takes a pnpm release once it is 3 days old;
pnpm's own `minimumReleaseAge` default is untouched. The patched libraries are ignored by
Dependabot on purpose: they arrive from `patched-libraries.yml`
(`docs/updating-patched-libraries.md`). The other libraries the extension ships come in the
weekly shipped group, `mediabunny` among them since 2026-09-30 (until then `mp4-muxer`,
which Mediabunny replaced, was held for a last release that crashed; `onnxruntime-web` was
in it until the speech detector went, 2026-10-10). A PR from that group changes the
extension, so CI runs on `main` after its merge and decides the release;
`tests/e2e/specs/modules.e2e.mjs` is what checks Mediabunny, and
`tests/e2e/specs/toolbar-reorder.e2e.mjs` sortablejs (a tool dragged along the player's control
bar, across it and into the "more" menu, saved, and in place in the next player). Mediabunny releases every few days, so expect it in most of them.
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
once it is 3 days old), and changes nothing without asking:

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

WSL itself is checked too (`pnpm run verify:linux` runs in it): a newer release is
installed with `wsl --update`, then `wsl --shutdown`, which stops every running distro, so
do not answer Y while a `verify:linux` run is going.

It never touches Firefox (it updates itself, and FastStream from the releases), mpv
(`C:\Program Files\mpv` has its own repository and updater) or the Ubuntu releases inside
WSL (`pnpm run verify:linux` updates them). Run the
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
label and is assigned to you.

Failed twice, the new version most likely needs changes to the code here, which no rerun
or rebase brings (your call, 2026-10-20). So the PR is also labelled `hold`, and one issue,
"Migration: <package or group> <version>", carries the same diagnosis and what to do:

- An agent session (or you) changes the code on a branch of its own off `main`,
  `migrate/<name>-<version>`, with a test that pins the new behaviour, and opens a PR for it.
- Once that is merged: if it took the new version itself, Dependabot (or the workflow that
  opened the PR) closes the update PR; otherwise `@dependabot rebase` (**Update branch** for
  a toolchain or patched-library PR) runs CI on it again.
- Meanwhile `@dependabot ignore this major version` parks a Dependabot PR.

The issue closes itself when CI passes on the PR, which also takes off the `hold` label the
workflow set (one you set yourself stays), or when the PR is merged or closed (checked once
a day). Failing twice again edits the same issue: no second email.

Or, by hand:

- Push a fix to the branch: the next CI run decides again. A fix you push makes the
  PR yours, so the comment then asks you to look at it even when CI is green.
- Or close the PR. For this repository's own update PRs (toolchain, patched
  libraries) a title is never used twice, so closing skips that version for good.
  For a Dependabot PR, tell Dependabot: `@dependabot ignore this minor version` (or
  `this major version`, `this dependency`). `@dependabot rebase` rebuilds its branch
  on the newest `main`.

### CI green: ready, or look first

"Ready to merge": merge it when you like.
Otherwise the comment names the check the PR failed - a tooling update whose build differs
from the latest release, a file that kind of update does not change, a package version
under 3 days old, a GitHub
Actions update while `UPDATE_PRS_TOKEN` is missing, the `hold` label - and the PR is
assigned to you. Look at that, then merge it or close it as above. A PR held back only for
a young package version needs nothing from you: the comment says when it is old enough, and
within a day after that it is decided again. The comment is
edited in place while the PR keeps waiting, even if the reasons change: a new email
comes when it turns red, turns green, is merged, or fails at a different step.

A CI run that was cancelled or skipped decides nothing. The next completed run
does: rerun it from the Actions tab, or push. (The weekly toolchain run starts CI on
its own pull requests when their head has no run that decides.)

A pull request a workflow opened - toolchain, patched library - shows
its CI and Dependency review runs as "approval required": GitHub holds the
`pull_request` runs of a pull request its own token opened. You can leave them: the
workflow that opened the pull request starts CI on its branch itself, and that run
decides. For a patched-library PR (it changes `pnpm-lock.yaml`) it
starts `dependency-review.yml` there too, and "Review dependency changes" appears among
the PR's checks; when it did not pass, `update-prs.yml`'s comment names that. A
toolchain PR leaves the lockfile alone.

### An issue from a watcher

Some failures arrive as an issue rather than a red PR: the mpv build, a runner
image, a Firefox version, the upstream watch, a patched library whose patch could
not be cut. Each names what failed. The Firefox, runner-image and upstream-watch issues
close themselves on the next green run, a patched-library one when the patch is
cut against that version or newer, a "Security alert" one when its alerts are fixed or
dismissed. If `update-prs.yml`, `toolchain-updates.yml` or `security-alerts.yml` itself
fails, it opens one issue, "Update PRs workflow failed", "Toolchain updates workflow
failed" or "Security alerts workflow failed" ("Update PR watch failed" for its daily watch,
below), while that one is open.

Once a day, `security-alerts.yml` also watches the open update PRs. Dependabot opens no more
PRs for an entry of `.github/dependabot.yml` once it has that entry's
`open-pull-requests-limit` open - not even for a new release - and says nothing. So
"Update pull requests piling up" opens when an entry has its limit minus 2 open, at least 2
(npm 8 of 10, fsaunpack 3 of 5, GitHub Actions 3 of 5, docker 2 of 2), or when an update PR
has been red for more than 14 days. It lists them, is updated in place each day, and closes
itself once neither holds. Merge what is ready and close what you will not take; for a red
one, its comment and its "Migration" issue say what to do.

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

## What update-prs.yml checks before it says "ready to merge"

Nothing merges itself (the owner's choice, 2026-10-02; from 2026-10-01 every kind of update
merged itself once CI was green, and before that the routine ones that ship nothing). The
comment says "ready to merge" only when all of this holds:

- the PR was opened by its bot, targets `main`, is not a draft and has no `hold` label;
- its commits are that bot's, or the merges of `main` this workflow makes when it updates
  the branch;
- it changes only what that kind of update changes: `package.json` and `pnpm-lock.yaml`
  (Dependabot npm; for pnpm, only the `packageManager` line); `fsaunpack/package.json` and
  `fsaunpack/package-lock.json`; `.nvmrc` (Node); workflow and action files (GitHub
  Actions); the two Dockerfiles (actionlint, zizmor); a re-cut's files (patched libraries);
- its dependency review passed, and every package version it adds to its lockfile is 3 days
  old on the npm registry (Dependabot's cooldown covers only what it bumps). Not for a
  security fix: a Dependabot security update, or a PR every package of which has an open
  Dependabot alert. Held back only for that, it is decided again once the youngest version
  is 3 days old (`security-alerts.yml`'s daily watch starts `update-prs.yml` again);
- an update not meant to ship (tooling, toolchain, workflows, fsaunpack): CI's build of the
  extension is file-for-file the latest release's, the version number aside, so it releases
  nothing. A shipped library or a patched library is meant to ship: CI
  then runs on `main` and a green run releases;
- last: the PR is mergeable and the branch contains the newest `main`, so what you merge is
  what CI tested; if it does not, the workflow runs GitHub's update-branch, CI starts again
  and that run decides, at most 3 times.

The `hold` label the workflow sets on a PR that failed twice (with its "Migration" issue,
above) comes off again when CI passes on it; a `hold` you set stays until you take it off.

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

One file the extension ships comes from another project without a package manager:
`vendored-updates.yml` (daily) watches it.

- **vtt.js** (`chrome/player/modules/vtt.mjs`, from dash.js): a dash.js release that changes
  the file opens an issue, "vtt.js changed in dash.js <tag>". Move the tag in
  `tools/verify-vtt.mjs` and run `pnpm run verify:vtt`, which says where FastStream's changes
  no longer apply.

The issue closes itself once the pin reaches the release; a newer release closes the older one.
If the workflow itself fails, it opens "Vendored updates workflow failed (vtt.js)".
(Until 2026-10-22 it also watched StreamSaver.js for `StreamSaver.mjs`, whose body is now
FastStream's own: an upstream change had nothing to port.)

## Quiet upstreams: what stays, and why

Checked on 2026-10-24: every direct dependency's newest release, its npm deprecation, and its
source repository (archived or not, last commit, open issues). Everything not named here is
current and actively maintained. Look again when one of these changes.

- **gif.js** (shipped: the loop menu's GIF): no release since 0.2.0 (2016), no commit since
  2019. It stays. Its input is only the player's own canvas, so its state carries no security
  risk, and no maintained encoder makes GIFs as close to the video. Measured on two 1-second
  scenes of Tears of Steel (30 frames, 1280x534), one thread each. PSNR is of the decoded GIF
  (omggif) against the frames; higher is closer to the video:

  | Encoder | ms per frame | Size | PSNR |
  |---|---|---|---|
  | gif.js 0.2.0 (as the player sets it: quality 4, no dither) | 215 / 275 | 9.7 / 9.6 MB | 42.7 / 36.7 dB |
  | gifenc 1.0.3 | 20 / 110 | 6.7 / 8.1 MB | 39.3 / 34.9 dB |
  | modern-gif 2.1.0 | 101 / 176 | 6.4 / 5.1 MB | 40.7 / 32.3 dB |

  - gifenc is the most used encoder (about 390,000 downloads a week). It is faster and
    smaller, but it loses 1.8-3.4 dB, and it has had no release since 2021 either.
  - modern-gif is the only active one, with one maintainer and about 7,000 downloads a week.
    It uses one palette for every frame, and on the colourful scene it loses 4.4 dB.
- **Coloris** (shipped: the subtitle colour fields): its last release was 2025-06, but its
  maintainer still answers issues (2025-11, 2026-09). It is finished, not abandoned. Firefox's
  own `<input type="color">` has no alpha channel, which the subtitle colours need.
- **eslint 9.39.4**, inside addons-linter (`web-ext lint`): npm marks it unsupported.
  addons-linter pins it exactly, so that it lints as addons.mozilla.org does, and its
  maintainers have turned eslint 10 down since 2026-06. An override would make our lint differ
  from AMO's. FastStream's own eslint is 10.
- **whatwg-encoding** (deprecated, its repository archived): gone since 2026-10-24.
  - The override `encoding-sniffer@0: ^1.0.2` in `pnpm-workspace.yaml` brings in the release
    that uses @exodus/bytes instead. cheerio's own main branch made the same move.
  - Before and after: addons-linter printed the same, and cheerio decoded 7 encodings the same.
- **The live suite's players**: plyr and vidstack are deprecated (security fixes only;
  vidstack's until January 2028), and DPlayer's last release is from 2023. They stay as long
  as sites run them: their pages check FastStream against what sites use, and nothing of
  theirs ships. Video.js 10, which replaces both, has pages of its own.

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
6. In the repository: **Settings**, **Environments**, **update-prs**, under
   **Environment secrets** **Add Secret**. Name `UPDATE_PRS_TOKEN`, paste the token,
   **Add secret**. (Not a repository secret: see "Secrets in environments" below.)

An Actions update changes nothing the extension ships, so your merge of one releases
nothing.

## Secrets in environments

The three secrets that can do harm live in GitHub Environments, not as repository secrets
(#163, 2026-10-03): `AMO_API_KEY` and `AMO_API_SECRET` (they sign and publish the add-on) in
**release**, which only `main` and tags `v*` may use, and `UPDATE_PRS_TOKEN` in
**update-prs**, which only `main` may use. A workflow file on any other branch - an upstream
sync's, a pull request's - runs with this repository's token but cannot read them: GitHub
hands a job an environment's secrets only when the job names that environment and its
branch or tag is allowed there. `release.yml`, the release failsafe and `update-prs.yml` name
them (`environment:` with `deployment: false`, so no deployment is recorded);
`tests/unit/workflowSecrets.test.mjs` fails for a job that reads one of these secrets
without its environment.

To set them up (or check them): **Settings**, **Environments**. (A workflow run that names
an environment that does not exist creates it, with no rules and no secrets: if `release`
or `update-prs` is listed already, click it instead of **New environment**.)

1. **New environment**, name `release`, **Configure environment**. In the **Deployment
   branches** dropdown pick **Selected branches and tags**. **Add deployment branch or tag
   rule**: Ref type **Branch**, name pattern `main`, **Add rule**. Again: Ref type **Tag**,
   name pattern `v*`, **Add rule**. Leave reviewers and wait timer off.
2. Under **Environment secrets**, **Add Secret** twice: `AMO_API_KEY` (AMO's "JWT issuer")
   and `AMO_API_SECRET` (its "JWT secret"), with the same values as before. GitHub never
   shows a secret again: if you no longer have them, make new credentials on AMO's API key
   page, https://addons.mozilla.org/developers/addon/api/key/ (the old ones stop working).
3. **New environment**, name `update-prs`, **Configure environment**. **Selected branches
   and tags**, one rule: Ref type **Branch**, `main`. Under **Environment secrets** add
   `UPDATE_PRS_TOKEN`: a new token, made as in "A token for workflow updates" above, or the
   old one's **Regenerate token** on GitHub's token page.
4. Then **Settings**, **Secrets and variables**, **Actions**, **Repository secrets**: delete
   `AMO_API_KEY`, `AMO_API_SECRET` and `UPDATE_PRS_TOKEN` there. Until they are deleted, any
   branch's workflow can still read those copies.
