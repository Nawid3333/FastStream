# FastStream — working notes

Fork of [Andrews54757/FastStream](https://github.com/Andrews54757/FastStream),
branched from `d5fe931` (V1.3.77).

**LICENSING — read this before publishing anything.** The upstream
`LICENSE.md` is **not** GPL and grants **no redistribution right**: it is
"All rights reserved. You must receive permission before using my code."
The `GPL-3.0-or-later` claim that used to sit in this file was wrong; the
upstream repo carries no LICENSE file granting GPL, and `package.json` in the
fork deliberately declares **no** `license` field for exactly this reason.
Practical consequence: this fork is a derivative of proprietary code made
without Andrew's written permission. Fixing that (getting permission or
rewriting) is a **hard prerequisite for any listed AMO submission** — AMO
reviewers check add-on license claims, and "I assert GPL over someone
else's all-rights-reserved code" does not survive that.

Goal: a Firefox-only extension (Chrome was dropped on 2026-09-20 — see
`docs/notes/build-and-release.md`, "Build targets") with a modern, testable dev workflow.
Since 2026-10-09 upstream no longer constrains the code (the owner's decision): restructure,
rewrite and modernise freely, and use what Firefox offers (Fetch Priority, Web Locks, OPFS,
`browser.*`) without Chrome fallbacks. An upstream change is reviewed for fixes that also apply
here, and the fix is ported, not merged.

## This file is the short part

It holds what applies to every change. What was learned about each area - why the code is
as it is, what shipped broken once, how each workflow decides - is in `docs/notes/`, which
is **not** loaded by itself. **Read the note for the area you are about to change before
changing it**, and write what you learn into that note, not here. (Until 2026-10-04 it was
all in this file: 128 KB, read into every session.)

| Before you touch | Read |
|---|---|
| keyboard shortcuts, the options page's keybind menu, locale strings | `docs/notes/keybinds.md` |
| the player, `MP4Player`, the HLS/DASH loaders, saving a video | `docs/notes/player.md` |
| `FetchLoader`, `FSBlob`, OPFS, IndexedDB, anything in a private window | `docs/notes/storage.md` |
| MPV mode, `native-host/`, the toolbar button's states, `TabTracker`, shortcuts a page cancels | `docs/notes/mpv.md` |
| `build.mjs`, SPLICER directives, build targets, releases, AMO signing and lint | `docs/notes/build-and-release.md` |
| anything under `.github/`, the e2e harness and its configs, `tests/workflows` | `docs/notes/workflows.md` |
| `chrome/player/modules/`, patches, the binary blobs | `docs/notes/libraries.md`, `docs/vendored-libraries.md` |
| `// @ts-check`, `tsconfig.json`, `types/` | `docs/notes/type-checking.md` |
| `update-local.cmd`, `tools/update-local*.ps1`, `tools/newest-release.mjs` | `docs/notes/local-pc.md` |
| testing playback by hand or against live streams | `docs/notes/playback-testing.md` |
| YouTube code that seems to be missing, a bug that looks like upstream's | `docs/notes/history.md` |

`docs/notes/README.md` maps each old section title to its file; `docs/maintenance.md` is the
owner's guide to the PRs and e-mails the workflows send.

## Reading big generated files

`.claude/settings.json` denies the Read tool on `pnpm-lock.yaml`, `node_modules/`,
`combined-locales.json`, the vendored libraries under `chrome/player/modules/` (generated from npm
by the build and gitignored), source maps and build output. `.ignore` keeps the committed ones out
of Grep and Glob results. (A `.claudeignore` repeated the list until 2026-10-04; Claude Code
reads no file with that name, checked against 2.1.278.) The rules load when a session starts,
so an already-open session keeps reading them.

When one of those files has to be consulted, do not read it whole: run `grep -n` or `sed -n`
through Bash, or have the ollama helper (`glm-5.3-flash:cloud`, through its HTTP API) pull out the
lines that matter, and check what it reports against the source.

## Commands

```bash
pnpm install              # pnpm 11, pinned via packageManager
pnpm run build            # 3 targets -> built/firefox-*.zip + built/web, unpacked dirs deleted
pnpm run build:keep       # same, but keeps build_*/ for web-ext
pnpm run lint             # eslint (must stay at 0), plus eslint.modules.config.js:
                          # undefined/unused names in chrome/player/modules, which the main
                          # config skips entirely (first-party code lives there next to vendored libs)
pnpm run lint:amo         # web-ext lint on build_firefox_amo (--self-hosted)
pnpm run start:ff         # rebuilds, then web-ext run on the dev profile (tools/launch-ff.mjs)
pnpm test                 # vitest
pnpm run test:ext         # installed extension, ordinary windows
pnpm run test:ext:github  # the same, against the GitHub self-host build
pnpm run test:pbm         # installed extension, private windows
```

`build:keep` must run before any `lint:amo` or `start:ff:clean` — those need an
unpacked directory, and a plain build leaves only zips. (`start:ff` and `start:ff:fresh`
rebuild by themselves.)

`update-local.cmd` brings the owner's PC to what CI uses (Node, npm, pnpm, the checkout, the
mpv host's installed copy, WSL): `docs/notes/local-pc.md`.

## How a change reaches users

- **Every pull request waits for the owner.** Nothing merges itself (2026-10-02); the bots
  only say whether a PR is ready.
- **A green push to `main` releases by itself** when it changes anything that ships
  (`auto-release.yml` compares CI's build with the last release). A push that touches only
  tools, tests, workflows or docs releases nothing.
- **Run CI's checks here before pushing**: `pnpm run verify` (Windows) and
  `pnpm run verify:linux` (WSL). When the tools cannot be installed in a session, say so in
  the PR and let its CI be the first full run.
- **A fix comes with a test that fails without it**, and a claim in a note comes with how
  it was measured.

## Rules

- **Never hand-edit `chrome/player/modules/*`** — vendored third-party code
  (dash.mjs 3.3 MB, hls.mjs 1.5 MB). Excluded from eslint and
  tsconfig; they stall the language server otherwise. Those two and a dozen more are
  copied from `node_modules` by `tools/sync-vendor.mjs` on every build and gitignored, so
  a change to one of them goes into a pnpm patch (`docs/updating-patched-libraries.md`).
  CI runs the unit tests before the build makes those copies, so `vitest.config.mjs` points
  the ones copied unchanged (hls.mjs, dash.mjs, mp4box, Mediabunny) at their npm builds: a
  unit test can run the save's real demuxer and MP4 writers (`tests/unit/hls2mp4.test.mjs`).
- **Property tests for what a page feeds in** (2026-10-01, T8): `tests/unit/*.property.test.mjs`
  run fast-check against SubtitleUtils (SRT/VTT/XML), StreamLength (m3u8/mpd), URLUtils,
  DownloadFilename and the host's `readMessage`: no throw on arbitrary text, round trips,
  and models (an HLS length is the sum of its finite positive EXTINFs). Random text rarely
  hits the cases that matter, so each rule has a targeted generator too (device names,
  emoji at the 200-character cut, broken EXTINF values); 7 broken rules were each caught.
  A failure prints its seed and shrunk input: reproduce with `fc.assert(..., {seed})`.
- **`build.mjs` rewrites `chrome/manifest.json` in place** on every run to
  sync the version from `package.json`. The tree is dirty after each build.
  Don't sweep it into an unrelated commit.
- `incognito: "split"` is deliberately deleted for Firefox builds — Gecko
  doesn't support split mode. Not a bug.
- **Private windows are their own platform.** Firefox will not run an
  extension in a private window until the user ticks "Run in Private
  Windows" in `about:addons` - there is no manifest key that asks for it,
  and a temporary install gets it no more automatically than a signed one.
  Before that tick the extension is genuinely inert there (its
  `web_accessible_resources` aren't even reachable: a private-window page
  loading the player URL gets "Access to moz-extension://... from script
  denied"), so "nothing happens in a private tab" is the expected state and
  not a bug to chase. After it, `tests/e2e/wdio.pbm.conf.mjs` is the suite
  that covers what actually runs there - see "Storage in a private window"
  in `docs/notes/storage.md` for the bug that hid behind this for months.
- Branches: `main` is the project and the only long-lived branch. It was
  `dev/mv3-modernization` until 2026-09-19, when that was merged into `main`
  and deleted. Upstream is never mirrored: `sync-upstream.yml` opens one PR
  from `sync/upstream` when Andrew has commits `main` lacks. It waits for the owner like
  every PR (`update-prs.yml` only says whether it is ready). Since 2026-10-09 it is a list of
  upstream changes to review for fixes that apply here (port the fix, then close it), not
  something to merge. `docs/upstream-sync-log.md` records what was decided by hand and why. `pr/*`
  branches, if ever needed, get cut fresh off `upstream/main`.
- **A new string needs all 16 locales.** The 16 `chrome/_locales/*/messages.json` files are
  the source (4-space indent); edit those, then `pnpm run combine-locales`. Never
  `split-locales` unless `combined-locales.json` is the file you edited.
  `tests/unit/localeKeys.test.mjs` fails on a missing key or placeholder.
- **SPLICER only processes `.mjs` and `.js`.** Code moved into a `.ts` file silently stops
  being spliced. Stay on `.mjs` plus JSDoc.
- **A change to `native-host/faststream-mpv-host.mjs` or `install.ps1` raises the host's
  version**: `HostVersion` there, `RequiredHostVersion` in `MpvBackend.mjs`, and the record
  in `tests/unit/mpvHostVersion.test.mjs`, which fails until they agree.
- **A file with `// @ts-check` keeps it**, and is listed in
  `tests/unit/typeChecked.test.mjs`. `types/messages.d.ts` gets a message only after its
  real payload was read.
- **Workflows:** every action is pinned to a commit SHA; no `schedule:` in `ci.yml` (GitHub
  disables the whole file after 60 quiet days); a workflow's `run:` scripts are tested in
  `tests/workflows`; a job that reads a secret names its environment.
- **e2e:** fixed ports are in 41800-41999, and only one e2e run per machine at a time (WSL
  shares the ports with Windows).
