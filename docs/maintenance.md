# How updates reach FastStream

Nothing merges itself without a green CI run. `update-prs.yml` runs after every
completed CI run for this repository's `dependabot/*`, `toolchain/*`, `patched/*` and
`sync/upstream` branches: it merges the PRs that change nothing the extension
ships, and hands every other one to the owner with one comment. Updates without a
PR - the mpv pin, a runner image, a new Firefox - are watched by their own
workflows, which stay silent while they pass.

## Every update source

| What | How it arrives | What happens on green | What reaches you |
| ---- | -------------- | ---------------------- | ---------------- |
| npm tooling, minor/patch | one grouped Dependabot PR a week (`tooling-minor-and-patch`) | merged by `update-prs.yml` | nothing (a comment on the PR records the merge) |
| npm shipped libraries (fuse.js, pako, sortablejs) | one grouped Dependabot PR a week (`shipped-minor-and-patch`) | waits for you: the build copies them into the extension, so its bundle differs from the release's | one comment, and the assignment |
| npm major | a Dependabot PR of its own | waits for you | one comment, and the assignment |
| GitHub Actions | one grouped Dependabot PR a week (minor/patch), a major on its own | waits for you: it changes workflow files | one comment, and the assignment |
| pnpm 11.x | a PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/pnpm-<version>`, changing only `packageManager`, once the release is 5 days old; one in conflict with `main` is rebuilt on it weekly | merged by `update-prs.yml` | nothing (a comment on the PR records the merge) |
| pnpm next major | a PR from `toolchain-updates.yml`, once dependabot/dependabot-core#15904 is closed | waits for you | one comment, and the assignment |
| Node LTS | a PR from `toolchain-updates.yml` (Mondays 07:00 UTC) on `toolchain/node-<major>`, changing `.nvmrc` | waits for you | one comment, and the assignment |
| patched libraries | a PR from `patched-libraries.yml` on `patched/<name>-<version>`, with CI dispatched on it | waits for you | one comment, and the assignment |
| upstream sync | a PR from `sync-upstream.yml`, daily and on every push to `main` | waits for you | one comment, and the assignment |
| mpv build | `mpv-updates.yml`; no PR - the pin lands on `main` by itself once CI is green | the pin is on `main` | nothing; an issue on failure |
| runner images | `runner-images.yml` runs `ci.yml` on the new image | the run is recorded, so the same image is not retested | nothing; an issue per image on failure |
| actionlint image | a Dependabot PR (docker, weekly) changing the tag and digest in `.github/actionlint/Dockerfile`, which `ci.yml`'s workflows job and the WSL verify read | waits for you: it changes the check every workflow file has to pass | one comment, and the assignment |
| Firefox stable, beta | `firefox-stable.yml` (daily) and `firefox-beta.yml` (Mon, Thu) run the e2e suites on that Firefox | a stable version is recorded as tested, so later days skip it | nothing; an issue on failure, closed by the next green run |

Dependabot proposes a release once it is 5 days old (`cooldown` in `.github/dependabot.yml`);
security updates skip the wait. The patched libraries, `onnxruntime-web` and `mp4-muxer`
are ignored by Dependabot on purpose: the patched ones arrive from `patched-libraries.yml`
(`docs/updating-patched-libraries.md`), `onnxruntime-web` only moves with its wasm
rebuilt (`docs/vendored-libraries.md`), and `mp4-muxer` is deprecated, its last release
crashing where the pinned 4.3.3 does not.
In the table, "waits for you" means one comment that @mentions you - CI is green,
and why the PR is not merged - with the PR assigned to you; a comment with the same
verdict as the last one is edited in place, so a repeat sends no second email.

## When you get an email

### CI red on an update PR

`update-prs.yml` has already rerun the failed jobs once by the time you read this
(unless GitHub refused the rerun; the comment says so). The comment holds a table of
each failed job, the step that failed and what that step checks, the last 40 lines
of each failed log, and `main`'s latest CI status; the PR carries the `ci-failed`
label and is assigned to you. Then:

- Push a fix to the branch: the next CI run decides again. A fix you push makes the
  PR yours, so it then waits for you even when CI is green: a person's change is
  merged by a person.
- Or close the PR. For this repository's own update PRs (toolchain, patched
  libraries) a title is never used twice, so closing skips that version for good.
  For a Dependabot PR, tell Dependabot: `@dependabot ignore this minor version` (or
  `this major version`, `this dependency`). `@dependabot rebase` rebuilds its branch
  on the newest `main`.

### CI green and waiting for you

The comment names the reasons the PR waits - it ships something, it is a major, it
changes workflow files, it is the upstream sync - and the PR is assigned to you.
Merge it, or close it as above; a Node major is a PR you merge. The comment is
edited in place while the PR keeps waiting, even if the reasons change: a new email
comes when it turns red, turns green, is merged, or fails at a different step.

A CI run that was cancelled or skipped decides nothing. The next completed run
does: rerun it from the Actions tab, or push. (The weekly toolchain run starts CI on
its own pull requests when their head has no run that decides.)

### An issue from a watcher

Some failures arrive as an issue rather than a red PR: the mpv build, a runner
image, a Firefox version, the upstream sync, a patched library whose patch could
not be cut. Each names what failed. The Firefox, runner-image and sync issues
close themselves on the next green run, a patched-library one when the patch is
cut against that version or newer. If `update-prs.yml` or `toolchain-updates.yml`
itself fails, it opens one issue, "Update PRs workflow failed" or "Toolchain
updates workflow failed", while that one is open.

## Why nothing that ships merges itself

`update-prs.yml` merges only two kinds of PR - a Dependabot npm minor/patch PR,
and the toolchain pnpm same-major PR - and only when all of this holds:

- the PR was opened by that bot, targets `main` and is not a draft;
- its commits are that bot's, or the merges of `main` this workflow makes when it
  updates the branch;
- only `package.json` and `pnpm-lock.yaml` change; for pnpm, only the
  `packageManager` line of `package.json`, to the version the branch is named for;
- there is no major;
- Dependabot's dependency review passed;
- CI's build of the extension (the `faststream-bundles` artifact, firefox-github
  zip) is file-for-file identical to the latest release's zip apart from
  `manifest.json`'s version (if either cannot be fetched, the PR waits);
- last, just before the merge: the PR is mergeable and the branch contains the
  newest `main`; if it does not, the workflow runs GitHub's update-branch, CI
  starts again and that run decides, at most 3 times.

The build check is `auto-release.yml`'s own test for whether a merge ships
anything, run on the PR's build. A PR that changes what the extension ships
fails it and waits for you; a PR that passes it can only change tools. The merge
is made with `GITHUB_TOKEN`, which starts no workflow - no CI on `main`, no
release - and that is fine, because the merged tree is exactly the one CI tested
and nothing shipped changed. (Should another merge land on `main` in the moment
between that last check and the merge, the merged comment @mentions you: that
combination was not built.) Nothing reaches Firefox that you did not merge on
purpose. This was decided on 2026-09-29: only updates that ship nothing merge
themselves, and a Node major is a PR you merge. `main` carries a ruleset that
blocks force-pushes and deletion only, with no required checks, so direct pushes
and `mpv-updates.yml`'s pin commits keep working.

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
  PR on `toolchain/node-<major>` for a newer LTS major, with CI on it; merge it
  when you are ready.

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
