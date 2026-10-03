# Updating a patched library

Six libraries ship with a pnpm patch - FastStream's changes to them, as a diff a
reviewer can read (`pnpm-workspace.yaml`, `patchedDependencies`; why:
`docs/vendored-libraries.md`). A patch is keyed to one exact version, so Dependabot leaves
these alone and the **Patched libraries** workflow watches them instead, once a day.

## When a new version comes out

The workflow tries the update itself, with `tools/recut-patch.mjs`, and tells you by
email (assigned to you, with an @mention) in one of two ways:

- **A pull request, "Patched library update: `<name>` `<version>`"** - the patch moved
  onto the new release cleanly and passed the tool's checks. The workflow starts CI on
  it, which runs everything `pnpm run verify` runs. Green: `update-prs.yml` comments
  "ready to merge" (or what to look at first), and it waits for you; merge it, and CI on
  `main` releases it once green. Red: fix it on the branch (below), or close
  it to skip that version.
- **An issue with the same title** - the tool stopped: a conflict, or a check failed. The
  issue lists where. Take it by hand (below), or close it to skip that version.

A release younger than pnpm's `minimumReleaseAge` cannot be installed yet; the workflow
says nothing that day and tries again the next. Either way the pull request or issue is
closed by itself once the library is patched at that version or newer, or no longer
patched at all, however that happened, and a version you closed is never raised again.
Besides the daily run, the workflow runs on a push to main that changes
`pnpm-workspace.yaml` or `package.json`, only to close items early (re-cutting stays
the daily run's job).

## By hand

The tool compares `node_modules` with the current patch first, and stops with
"run pnpm install" when they differ - so run `pnpm install` before starting.

```
node tools/recut-patch.mjs dashjs 5.3.0
```

reports what it did per patched file - for a webpack bundle like dash.js, per module - and
leaves everything in an output directory it names: `base/` (the old release), `ours/`
(the old release patched: what ships today), `theirs/` (the new release) and `merged/`.
Conflicts are marked in `merged/` in diff3 style: `ours (FastStream)`, `base`,
`theirs (new release)`. Keep FastStream's change on top of the new release's code; where
FastStream deliberately removed code upstream then kept editing, keep the removal.
A problem ending in "pass --map <old>=<new path>" is a file the new release renamed
and the tool cannot match on its own: `--map <old path>=<new path>` tells it where the
file went. Then:

```
node tools/recut-patch.mjs dashjs 5.3.0 --out <that directory> --resume --apply
pnpm run verify
pnpm run verify:linux
```

A run with the same `--out` but without `--resume` deletes `merged/`, the resolved
files included. Always add `--resume` once files have been resolved.

`--resume` runs the resolved files through the same checks, and `--apply` takes the
update: `package.json`, the `patchedDependencies` entry, the lockfile, the new patch
through `pnpm patch-commit`, renamed chunk names in `tools/sync-vendor.mjs`, and the
regenerated files in `chrome/player/modules/`. Then commit on a branch and open a pull
request (the regenerated files are git-ignored, so they are not part of the commit).

When every one of FastStream's changes has landed upstream, `--apply` drops the
patch instead of committing one, and says to remove the `patched: true` marks in
`tools/sync-vendor.mjs` and the library from `.github/dependabot.yml`'s ignore list.
If `tools/sync-vendor.mjs` then fails (an unpatched file renamed too), the tool
exits 2 with the version, lockfile and patch already changed: fix `sync-vendor.mjs`,
then run `pnpm run verify`.

## What the tool checks, and what it cannot

It merges module by module where it can, finds a content-hashed file under its new name
(mp4box's rolldown chunks), and keeps the stray CR characters a release ships (dash.js
has 428), so the patch holds only real changes. Each merged JavaScript file
(`.js`/`.mjs`/`.cjs`) must parse, and ESLint's `no-undef`/`no-unused-vars` must find no
name that neither the new release nor the current patch has. A clean merge is not a correct one: on the dash.js 5.2.1 upgrade two
merged cleanly and would have thrown on every stream of their kind - a helper upstream
deleted, a webpack import upstream renumbered - and that check is what finds them.

It cannot see behaviour: upstream can change what a function means without changing its
name. Only the end-to-end suite proves the library still works, which is why a pull
request waits for CI and a hand update for `pnpm run verify`. What covers each one:

| Library | End-to-end coverage |
|---|---|
| hls.js | `playback.e2e.mjs` (HLS), the HLS saves in `save-video.e2e.mjs` and `save-fmp4.e2e.mjs` |
| dash.js | `playback.e2e.mjs` (a public stream, and one local stream per segment getter with its fragment list checked), the DASH saves |
| mp4box | `playback.e2e.mjs` (MP4), the DASH and fMP4 saves |
| gif.js | `modules.e2e.mjs` |
| Coloris | `modules.e2e.mjs` |
| sweetalert2 | `dialogs.e2e.mjs`, and the extension save-dialog specs |

## When a re-cut conflicts everywhere

Then the patch was probably not cut against the release it names. FastStream's vendored
copies were often built from a library's development branch between releases - dash.js
from a commit three weeks before 5.1.0, mp4box from one between 0.5.2 and 0.5.3 - so part
of the "patch" was upstream code in reverse. Rebuild the library at that commit from its
own lockfile, check that the same build reproduces a published release, and diff against
it: `docs/vendored-libraries.md`, dash.js, "Status".

Three tools were made for this: `tools/find-base.mjs` finds which upstream release or
commit a vendored file was built from (its listing calls hit GitHub's limit of 60
unauthenticated requests an hour; set `GITHUB_TOKEN`, for example
`GITHUB_TOKEN=$(gh auth token)`), `tools/ast-compare.mjs` checks that a build reproduces
a published release, and `tools/compare-decls.mjs` compares single declarations.

## Checking the tool

`tests/unit/recutPatch.test.mjs` covers its pieces. To check it against real history,
replay an upgrade done by hand and compare:

```
git show 8d19beef:patches/hls.js@1.7.2.patch > old.patch
node tools/recut-patch.mjs hls.js 1.7.3 --from 1.7.2 --patch old.patch --out replay
```

`replay/merged/dist/hls.mjs` and `hls.js` are then byte-identical to what
`patches/hls.js@1.7.3.patch` installs. Re-cutting any current patch onto its own version
(`--from` and the target the same) reproduces the installed files byte for byte too.
