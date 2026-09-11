# FastStream modernisation — checkpoint

**Date:** 2026-09-07 (MPV section added 2026-09-09)
**Fork:** https://github.com/Nawid3333/FastStream
**Branch:** `dev/mv3-modernization` (also the fork's default branch);
`Mpv-feature` carried the MPV work and was **merged** on 2026-09-09
**Base:** upstream `d5fe931` (V1.3.77)
**CI:** green — https://github.com/Nawid3333/FastStream/actions
**Plan doc:** https://claude.ai/code/artifact/830a4dd8-e6ab-4429-a4ac-b5541f9a3224

Everything in this checkpoint reflects a verified state: the full suite
(lint, typecheck, 58 unit tests, all 4 builds, both addons-linter runs, e2e
playback, extension e2e, and every provenance check) was run green on
2026-09-07 at the commits listed below. Check the git status before relying
on any "current" claim here.

The MPV section near the end was added on 2026-09-09 from work on the
`Mpv-feature` branch. Its own claims were verified on that branch (lint 0,
tsc 0, 87 unit tests, ext e2e 4/4, Firefox e2e 12/12, 4 builds, AMO lint
0/0/3) — the rest of this document was **not** re-run that day.

---

## Folders

| Path | Role |
|---|---|
| `FastStream/` | Pristine upstream clone. **Never edit.** Diff target. |
| `Faststream version 4/` | The working fork. All work happens here. |
| `baseline/` | Unpacked reference build + `MANIFEST.sha256` (644 files). |
| `MODERNIZATION_PLAN.html` | The published plan document. |

---

## Where the plan stands

Original phases 0–10. Executed out of order where evidence justified it.
Current as of 2026-09-07, after a full verify run (lint, typecheck, 58 unit
tests, 4 builds, both lints, e2e playback, extension e2e, all provenance
checks — everything green).

| Phase | State | Notes |
|---|---|---|
| 0 · Baseline | **done** | 644-file build baseline captured |
| 1 · pnpm | **done** | Proven output-neutral |
| 2 · Dev harness | **done** | `--keep`, web-ext 10.6, ESLint 2352→0 (flat config, v10), CLAUDE.md |
| 3 · Vite vendor | **superseded** | `pnpm patch` + `tools/sync-vendor.mjs` instead — see below |
| 4 · Unit tests | **done** | 58 tests, all mutation-verified |
| 5 · E2E (WebdriverIO) | **done** | Real playback (HLS/DASH/MP4) + extension-loaded suites, both in CI |
| 6 · CI | **done** | Green; runs lint, typecheck, unit, builds, both lints, both e2e suites |
| 7 · Unbundle libs | **done** | Every JS library generated from a pinned npm release/git commit + patch; only vtt.js, knob, the wasm/ort binaries and (libre-only) yt.mjs/googlevideo.mjs stay vendored, each with re-runnable provenance checks |
| 8 · AMO sweep | **done** | firefox-amo: 0 errors, 0 notices, **3 warnings** (was 24; each remaining one documented in `docs/amo-linter-warnings.md`) |
| 9 · Signing | **done (unlisted)** | Own add-on ID `thanatus@Nawid`; `pnpm run sign:amo` signs unlisted, `sign:amo:listed` exists for when the license question is settled |
| 10 · Upstream PRs | **done — open, awaiting response** | #548 Windows fix, #549 permissions, #550 `.gitattributes`, #551 vendor recipes (+ recipes comment on #547, hls.js recipe comment on #546); issue #547 carries the license ask |
| — · TypeScript | **done** | Opt-in `tsc --noEmit` |
| — · Upstream sync | **done** | Weekly workflow, opens a PR, never auto-merges |

**Licensing is the one thing that gates a *listed* store release.** Upstream
`LICENSE.md` is **all rights reserved** — "You must receive permission before
using my code." — and the GPL-3.0 claim that used to live in `CLAUDE.md` was
wrong (corrected 2026-09-07). Unlisted self-distribution is wired and works;
publishing publicly as your own requires Andrew's written permission or a
rewrite of the proprietary parts. AMO reviewers check license claims.

---

## Commits on the branch

The branch has grown well past the original thirteen commits — see
`git log --oneline d5fe931..HEAD` for the full list (~95 commits as of
2026-09-07; base `d5fe931 V1.3.77` is upstream). Recent highlights:

```
f72b3b1 Update dev dependencies, migrate ESLint to flat config for v10
d8733dc Measure dash.js 5.2.1 upgrade scope, shelve it
d143eab Document sizing up mp4box 2.4.1 and shelving the upgrade
397faac Document pako 3.0.1 status and the mp4-muxer 5.2.2 attempt/revert
64c359d Update pako 2.1.0 -> 3.0.1, drop the UMD wrapper it no longer needs
e65ecd1 Update sweetalert2 11.12.4 -> 11.26.25
5ba90bc Update fuse.js 7.1.0 -> 7.5.0 and sortablejs 1.15.2 -> 1.15.7
8d19bee Upgrade hls.js 1.6.9 -> 1.7.2, shrink the patch to 4 hunks
cd177ae docs: add privacy policy and AMO reviewer build instructions
573262b fix(amo): restore the cookies permission, drop only contextualIdentities
570db9c fix(sweetalert2): remove the eval path, proven dead in this build
aafb5f4 fix(gif.js): rename a shadowed local var to clear an addons-linter false positive
b452227 ci: fix sync PR CI gating, add failure emails, add AMO auto-publish
06ba311 build(amo): drop a dead web-accessible directory and the YouTube injector
349e83c build(amo): claim our own add-on id and add unlisted signing
4044213 fix(reencoder): point libsamplerate at the wasm that is actually shipped
209b189 build(hls): source hls.js from npm plus a reviewable patch
ab0719d fix(build): repair Windows builds broken by volumeNameLen shadowing
d5fe931 V1.3.77   <- upstream
```

---

## Findings that changed the plan

1. **Already Manifest V3.** No MV2 migration exists to do. Deleted that whole workstream.
2. **`web-ext lint` reports 0 errors** on the unmodified build. Mozilla's automated linter already passes; the rejection was human policy review of the vendored libraries. This is not a "fix the lint errors" project.
3. **Two real upstream bugs**, both fixed here:
   - `miniglob.mjs` shadowed `volumeNameLen` with a parameter, then called it — **every Windows build failed**. Andrew has only ever built on Linux.
   - No `.gitattributes`, so Windows checkouts got CRLF and ESLint reported 2352 errors.
4. **`CENSORYT` does not strip YouTube** — it only disables *downloading* (`canSave()` returns `cantSave`). Playback still runs and still ships the `new Function` eval. I stated the opposite earlier and you approved a plan on that false premise; corrected.
5. **The wasm/ort blobs are identifiable**: ONNX Runtime Web v1.20.0 (MIT), Silero VAD, libsamplerate-js (MIT). `ort.wasm.mjs` was **hand-minified by Andrew** ("Minified to reduce loading time"), which is itself the AMO problem.
6. **hls.js was 1.6.9 with only 466 divergent lines** (1.3%, 22 hunks) — not a fork, and much had already landed upstream. This finding drove the whole "pinned npm release + patch" strategy; the subsequent upgrade to 1.7.2 confirmed it, shrinking the patch to 4 hunks / 62 lines.

---

## Strategy change: `pnpm patch`, not Vite wrappers

The original Phase 3/7 plan was Vite vendor bundles plus wrapper classes. The hls.js measurement showed that cannot work:

- `hls2mp4/transmuxer.mjs` imports six demuxer/remuxer classes that **stock hls.js does not export in any release**, and the package's `exports` map offers no deep-import path.
- The remuxer's `outputSamples` return field is also absent upstream.

Reimplementing a demuxer to avoid a one-line export change adds far more risk than it removes. So: ship the **official npm release plus a committed patch file** via `pnpm patch`.

That satisfies what AMO actually wants — a hash-verifiable upstream base and a human-sized, auditable diff — instead of today's 1.3 MB file with no stated version or provenance.

Full analysis: `Faststream version 4/docs/vendored-libraries.md`
Historical raw diff: `Faststream version 4/docs/hls.js-1.6.9-faststream.patch`
(current patch: `patches/hls.js@1.7.3.patch`)

---

## YouTube removed from the AMO build (firefox-amo) — superseded 2026-09-10

**Superseded.** YouTube support was removed entirely on 2026-09-10, from
every target (not just `firefox-amo`) — `NO_YOUTUBE` and `CENSORYT` are gone
from `build.mjs`, and `YTPlayer.mjs`/`yt.mjs`/`googlevideo.mjs`/
`yt_runner.js`/`custom/yt_content.js`/`YoutubeClients.mjs` are deleted
outright, not spliced. See `CLAUDE.md`'s "YouTube removal" section for the
current state. Kept below for the historical reasoning (why `yt.mjs` could
never get provenance, the AMO-only warning-count math at the time), which is
still accurate as a record of *why* AMO needed this first.

`firefox-amo` was spliced with a `NO_YOUTUBE` target. Chrome targets and
`firefox-github` were untouched.

**Why, in one line:** `yt.mjs` is the one library that can never get the
hash-verifiable npm base every other library now has.

Its base was determined empirically, not assumed: diffing the in-tree file
against every youtubei.js release from 15.0.0 to 18.0.0 gives a clear minimum
at **17.0.1** (11,089 differing lines against 11,516 for 16.0.1 and 13,537 for
17.1.0), which matches a `version: "17.0.1"` string embedded in the bundle.

The fork is genuinely **maintained**, not merely stripped. It removes ~9,500
lines of unused modules, but it also *adds* current user-agent strings
(Chrome 141) - and YouTube rejects stale user agents, so stock 17.0.1 would
not work. No npm release corresponds to it. `googlevideo.mjs` (170 KB) is
bundled from LuanRT/googlevideo's sources and has the same problem.

**Results on firefox-amo:**

| | Before | After |
|---|---|---|
| `web-ext lint` | 0 errors, 15 warnings | 0 errors, **13 warnings** (later reduced further — see "AMO position") |
| YouTube libraries | 1.41 MB shipped | removed |
| `yt_runner.js` eval | present | **gone** |
| `userScripts` permission | optional_permissions | **dropped entirely** |
| Build size | 15 MB | **13 MB** |

Dropping the permission outright, rather than moving it to
`optional_permissions` as the other targets do, matters: the userscript that
needed it is no longer in the build, and requesting a permission nothing uses
is what reviewers ask about. That userscript was also the only reason this
build called `chrome.userScripts.configureWorld` with a
`script-src 'unsafe-eval'` CSP.

The NO_YOUTUBE splice itself remains in place; the subsequent warning
reduction work (gif.js rename, Coloris innerHTML rewrites, sweetalert2 eval
removal, permission hygiene) then took the AMO target from those 13
warnings to the current **3** — see "AMO position" for the breakdown.

**libre is unaffected**, verified file by file against the baseline build. Its
only changes are the splice comments plus an `if (false)` block that is
unreachable there, following the same idiom `CENSORYT` already uses.

**Testing the store build:** `pnpm run start:ff:amo` launches firefox-amo in
the isolated dev profile (`pnpm run start:ff` still launches libre).

---

## Verified playback baseline

Confirmed working by you on the firefox-github build, 2026-09-02, and
re-verified repeatedly since — most recently 2026-09-07 via the automated
e2e suite (`pnpm run test:e2e` plays real HLS/DASH/MP4 streams and asserts
`currentTime` advances). **Re-run after every change to the player, loaders
or vendored libraries.**

| Format | URL | Status |
|---|---|---|
| DASH | `https://reference.dashif.org/dash.js/v4.4.0/samples/getting-started/auto-load-single-video-src.html` | works |
| HLS | `https://tracylocalschool.com/gquzbcolcgom` | works |
| MP4 | `https://video.nie.edu.sg/media/Sample-Video-File-For-Testing.mp4/0_9311zvk2/22238` | works |

Also in `Faststream version 4/tests/manual-playback-urls.txt`.

---

## Commands

```bash
cd "V:\Faststream modernisation\Faststream version 4"

pnpm install
pnpm run build          # 4 targets -> built/*.zip
pnpm run build:keep     # keeps build_*/ for web-ext (needed by lint:amo, start:ff)
pnpm run lint           # ESLint — must stay at 0
pnpm run typecheck      # tsc --noEmit
pnpm test               # 58 vitest tests
pnpm run lint:amo       # web-ext lint on the AMO build (the store target)
pnpm run lint:github    # web-ext lint on the self-install build
pnpm run test:e2e       # real playback (HLS/DASH/MP4) in Firefox
pnpm run test:ext       # extension-loaded checks (CSP, wasm, VAD)
pnpm run verify         # everything above + all provenance checks

pnpm run profile:setup  # once — builds .dev-profile with uBlock Origin
pnpm run start:ff       # launches an ISOLATED Firefox (never touches your own)
pnpm run start:ff:amo   # same, with the AMO build
```

---

## AMO position

`firefox-amo` (the store target): **0 errors, 0 notices, 3 warnings** —
down from upstream's 24 warnings + 1 notice.

Each remaining warning is in vendored code and individually explained in
`docs/amo-linter-warnings.md`: vtt.js's textarea entity-decoding (safe by
construction, RCDATA), ort.wasm.mjs's ONNX dynamic import (generated, official
build), and dash.mjs's webpack bootstrap eval (unreachable under this build's
CSP). The position is deliberate — editing generated files to silence
advisory warnings would weaken the provenance story that got this far.

**Every JS library is now generated from a pinned, hash-verifiable base:**
hls.js 1.7.3 (+ worker, + 62-line patch), dashjs 5.1.0 (patch), pako 3.0.1,
fuse.js 7.5.0, sortablejs 1.15.7, sweetalert2 11.26.25 (patch), mp4box
0.5.3 (five-change patch), mp4-muxer 4.3.3, gif.js 0.2.0 (patch), jswebm
0.1.2 (patch), Coloris 0.25.0 (git-pinned commit + patch), and
onnxruntime-web 1.20.0's unminified loader.

**Still vendored, each with a re-runnable provenance check:** vtt.js
(`verify:vtt` — dash.js contrib + 3 documented changes), knob
(`verify:knob` — jherrm/knobs @ cf2db70f + 10 enumerated changes), the
Silero VAD model (`verify:vad` — 96.60% byte-identity to the published
.onnx), the ORT wasm (`verify:ort` — build stamp matches; reproduction
command documented), and the libsamplerate wasm (reproduced from public
source with documented flags). yt.mjs and googlevideo.mjs remain in the
libre build only — no npm base corresponds to them, which is why they are
spliced out of the AMO target.

**mp4box is closed.** The earlier "breaks MP4 playback" rejection of npm
0.5.3 was real but localized: the bisect found `getSampleList` and
`buildTrakSampleLists` are FastStream additions the stock build lacks, and
`items`/`entity_groups` were 0.5.2-era leftovers. mp4box.mjs is now
generated from `mp4box@0.5.3` plus `patches/mp4box@0.5.3.patch`, with the
patch verified against real e2e MP4 playback. (2.4.1 was measured
2026-09-06 and shelved: rolldown-minified names make the fork's functions
unfindable in the new bundle.)

**Library upgrades measured and deliberately shelved, with evidence** (see
`docs/vendored-libraries.md`): dashjs 5.2.1 (0 of 68 customized modules
landed upstream — the upgrade would mean redoing the vendoring analysis),
mp4box 2.4.1 (minified internal names break patching; API changed), and
mp4-muxer 5.2.2 (real regression: crashes finalizing an empty video track;
package deprecated upstream in favor of Mediabunny). onnxruntime-web 1.29.0
is **not** upgradeable alone — the shipped wasm is a custom reduced build
paired with the 1.20.0 loader. 5.1.0 / 0.5.3 / 4.3.3 / 1.20.0 stay pinned.

**Library upgrades done (2026-09-11).** Checked every pinned version against
npm/GitHub: pako, fuse.js, sortablejs, sweetalert2, gif.js and jswebm were
already current; the shelved four above were re-checked and are still
correctly shelved (no new evidence since 2026-09-07). Two real candidates
were found and executed:
- **hls.js 1.7.2 → 1.7.3** — the existing patch applied unmodified against a
  pristine 1.7.3 tarball (`git apply --check`, then a real `pnpm patch`/
  `patch-commit` rebase). See "hls.js migration" above.
- **Coloris 0.21.1 → 0.25.0** — a real re-port, not a rebase; upstream
  restructured the exact functions the patch customizes. See
  `docs/vendored-libraries.md`'s "Re-ported to 0.25.0" section for the full
  breakdown (what changed, what upstream now does for us, what didn't need
  touching at all).

Both re-verified with the full suite: lint, typecheck, 144 unit tests, a
full build, both addons-linter gates (unchanged), and real e2e playback
(HLS specifically for hls.js; the colour-picker test on both Firefox and
Chromium/Edge for Coloris).

---

## Open decisions

1. **License — the active blocker for a listed release.** Upstream is
   all-rights-reserved; publishing publicly as your own needs Andrew's
   written permission or a clean-room rewrite. The wrong GPL claim in
   `CLAUDE.md` was removed 2026-09-07. Unlisted self-distribution works
   today (`pnpm run sign:amo`).
2. ~~YouTube in the AMO build~~ — **superseded 2026-09-10: removed from every
   target entirely**, not just AMO. Originally decided via the `NO_YOUTUBE`
   splice (AMO only); libre/github builds have not kept YouTube since.
3. ~~Gecko extension ID~~ — **done**: `thanatus@Nawid` in both Firefox
   targets, with `strict_min_version` 136 (github) / 142 (amo, for
   `data_collection_permissions`).
4. ~~E2E timing~~ — **done**: playback and extension suites exist, run in
   CI, and caught real regressions (mp4box twice, Coloris patch loss).

---

## hls.js migration — complete (three steps)

`chrome/player/modules/hls.mjs` is no longer in git. It is generated at build
time by `tools/sync-vendor.mjs` from `hls.js@1.7.3` on npm plus
`patches/hls.js@1.7.3.patch`.

- **Before:** 1.3 MB file, `const version = undefined`, no provenance.
- **After:** hash-verifiable npm base + a **4-hunk, 62-line patch** (down from
  22 hunks / 466 lines against the 1.6.9 base).

Step 2 is done (2026-09-06): the base moved to 1.7.2, most of the original
patch had landed upstream byte-identically, the ABR abandon-rules change
moved out of the patch entirely into a `FastStreamAbrController` subclass
passed via hls.js's public `abrController` config option, and what remains
is only the extra demuxer exports, `outputSamples` on the remux result, and
the upstream-issue-#7460 subtitle part-loading guard. Verified by lint,
typecheck, unit tests, both lints, and real e2e playback of HLS.

Step 3 is done (2026-09-11): bumped to 1.7.3. `git apply --check` against a
pristine 1.7.3 tarball took the 1.7.2 patch completely unmodified (`pnpm
patch`/`patch-commit` rebased it clean), so nothing in the patch itself
changed — only `hls.js@1.7.2` → `hls.js@1.7.3` in `package.json` and
`pnpm-workspace.yaml`'s `patchedDependencies`. Re-verified the same way:
lint, typecheck, 144 unit tests, both addons-linter gates, and real e2e HLS
playback (`playback.e2e.mjs`) plus the HLS save/mux path
(`save-video.e2e.mjs`), on both the web build and the installed extension.

**Next step if revisited:** offer the export change upstream — "please
export the demuxers" would shrink the patch to 3 hunks.

---

## Phase 7 — closed

This section previously listed ~18 vendored libraries with "no recorded
version" as the bulk of remaining work. All of them are now either generated
from a pinned npm release/git commit (with `patches/` applied by pnpm, see
`docs/vendored-libraries.md` for every measurement) or verified vendored
(`vtt.mjs`, `knob.mjs`, the wasm/ort binaries) with re-runnable provenance
checks. `yt.mjs` and `googlevideo.mjs` are the exception and ship only in
the libre/github targets, never the AMO one.

The one generated file that was still tracked in git, `mp4box.mjs`, was
untracked on 2026-09-07 and added to `.gitignore` alongside the other
generated vendor files — otherwise an upstream merge could have silently
reverted it to the stale vendored copy.

---

## MPV mode — working, merged into `dev/mv3-modernization`

Hands a detected stream to mpv on the user's machine instead of the in-page
player, on allowlisted sites. Started as a WIP commit that was end-to-end
broken; now verified working on a real site from a **clean install** of the
native host.

**State on 2026-09-09:** works on aniworld — auto-detect, single mpv window,
correct headers, fullscreen, focus, episode switching. Verified from a fresh
`install.ps1` run (install dir and registry key deleted first), not from the
hand-copied host used during development.

| Commit | What it fixed |
|---|---|
| `5ce5f3ec` | The original WIP. Not functional. |
| `b839054a` | Job object, header loss, `libmpv` UA, duplicate launches |
| `9beec583` | Focus, single instance, fullscreen |
| `8a54ff33` | Second video on the same site |

Four independent breakages, each measured rather than reasoned about — the
detail is in `CLAUDE.md` under "MPV mode and the native host", and every one
is worth reading before touching this code:

1. **mpv was killed the instant it appeared.** Firefox's job object takes
   every descendant of the native host with it. Measured: `detached`+`unref`
   killed, `cmd /c start` killed, WMI `Win32_Process.Create` survives.
2. **Referer/Origin never reached the CDN** — read after the first `await`,
   by which point the sibling `onHeadersReceived` listener had cleared them.
   This was also a silent regression on the ordinary player path.
3. **mpv announced itself as `libmpv`** and UA-gated CDNs refused it.
4. **One page opened an mpv window per detected source** — a real session
   produced 14 launches of a single URL.

**Docs:** `README-MPV.md` is the user-facing setup guide (install, options,
troubleshooting, uninstall); `native-host/README.md` is the reference for how
the host works and how to set it up without the script.

**Options** (Settings → MPV Mode): `mpvMode`, `mpvAllowlist`, `mpvPath`,
`mpvFullscreen` (default off), `mpvPausePage` (default on),
`mpvSingleInstance` (default on).

**Coverage.** `tests/e2e/ext-specs/mpv.e2e.mjs` asserts the three relayed
headers, a single launch, that the page is paused, and that a second video
reaches mpv. Each assertion was checked against the broken code first, so
none of them can pass vacuously. The suite skips when the host is not
installed. The native host itself has **no automated coverage** — it is
verified by hand, driving the `.bat` with framed messages and checking
survival inside a real kill-on-close job object.

**Not done:**

- **Locales.** Every new option string is English-only; other locales fall
  back to English. `build.mjs` substitutes the English string for a missing
  key so the web build no longer renders blanks, and the extension builds get
  the same fallback from the browser via `default_locale`. The cost is noise:
  `localescript.mjs` prints all 17 keys for each of the 15 non-English
  locales on every build.
- **`nativeMessaging` is a required permission, but the code is written for an
  optional one.** The manifest lists it under `permissions`, so every install
  asks for "Exchange messages with programs other than Firefox" whether or not
  the user ever enables MPV mode — and `chrome.permissions.contains()` in
  `loadOptions` and in the options page's Test button can never be false, so
  the `chrome.permissions.request()` branch already written there is dead.
  Moving the entry to `optional_permissions` would make that flow live and
  drop the permission for everyone who does not use mpv; the cost is that the
  user must press **Test connection** once to grant it, or MPV mode fails
  silently. Not changed here because it alters the install prompt.
- **Windows only.** The WMI launcher and the focus step are
  `process.platform === 'win32'`; other platforms fall back to a plain
  detached spawn, which is correct there (no job object) but untested.
- **Chrome.** `install.ps1` supports `-ExtensionId` for Chrome-family
  browsers, but MPV mode has only ever been run in Firefox.
- **Windows-only host, still true.** See above.

**Fixed on 2026-09-09, after the branch was first written up:**

- **Leave-site gap — fixed, and it was wider than this document said.** The
  auto-start condition was `mpvSite && !regexMatched && !mpvMatched`. The
  `!regexMatched` half meant that *any* tab the ordinary auto-enable list had
  already claimed never switched to mpv when it later reached an allowlisted
  site: the stream just played in the page. It is now `mpvSite && !mpvMatched`,
  with `mpvMatched` cleared on a hostname change in the `tabs.onUpdated`
  handler (not in `tab.reset()`, which also runs on the toolbar's Off path,
  where re-arming would undo the click). Covered by a second e2e case that was
  confirmed to fail against the old condition.
- **A failed launch is retryable again.** `MpvBackend.openStream` recorded the
  URL in `tab.mpvSentUrls` before the host replied and only removed it when
  the *host* was unreachable — not when the host answered `{ok: false}`
  (no mpv installed, bad path). Retrying the same video then reported success,
  paused the page, and played nothing. Unit-tested, mutation-checked.
- **Locale files no longer fight their generator.** Both locale files had been
  reindented to 2 spaces while `localescript.mjs` and upstream write 4, so
  `node localescript.mjs --combine` produced a 14,288-line diff on a clean
  tree. Regenerated at 4 spaces: the branch's locale diff went from 16,654
  lines to 102 added ones, content verified unchanged.

- **Not pushed.** Merged into `dev/mv3-modernization` on 2026-09-09.

---

## Next steps, in order

0. ~~**Decide what to do with `Mpv-feature`.**~~ **Merged** into
   `dev/mv3-modernization` on 2026-09-09 after a review pass that fixed the
   leave-site gap, a non-retryable failed launch, and a locale reindent that
   fought its own generator. Still Windows-only and English-only, and the
   `nativeMessaging` permission question above is still open. Not pushed.
1. ~~Settle the license.~~ **Asked** (issue #547, PR #551) — now waiting on
   Andrew's response. Listed distribution stays blocked until/unless he
   grants permission; unlisted self-distribution works today.
2. ~~First real AMO submission (unlisted)~~ — **done 2026-09-07**: signed
   locally (`99f1b8e844554f46b28a-1.3.78.0.xpi`) and again via the
   `publish-amo.yml` workflow, end to end green.
3. ~~Send the upstream PRs (Phase 10)~~ — **done 2026-09-07**: #548
   (Windows, pre-existing), #549 (permissions, pre-existing), #550
   (`.gitattributes`), #551 (vendor recipes). Follow-ups posted on #547
   (PR index) and #546 (hls.js 1.7.2 recipe, where it was requested — the
   fork has since moved on to 1.7.3, see "hls.js migration" below).
   If Andrew responds, the most likely next PR is a ready-to-merge hls.js
   1.7.3 bump off a fresh `pr/*` branch.
4. ~~Close the last unverified-feature gap: Chrome e2e.~~ **Moot 2026-09-11**:
   Chrome is no longer a build target at all (Nawid only uses this fork on
   Firefox) — `chrome-github`/`chrome-webstore` were removed from
   `build.mjs` and the release workflow. See CLAUDE.md's "Build targets".
   (YouTube e2e is moot too — YouTube support was removed entirely
   2026-09-10.)
5. **If a human AMO reviewer asks for more:** the remaining candidates are
   the three warnings in `docs/amo-linter-warnings.md` (all currently
   defended as safer-left-alone) and pinning vtt/knob as git dependencies
   bundled at build time — documented as the "if revisited" option.
6. **Library upgrades stay shelved** unless new evidence arrives
   (dashjs >5.2.1 with the customized modules landed upstream, a
   name-preserving mp4box build, a fixed mp4-muxer release, or a new
   reduced ORT wasm pairing). Re-run `pnpm run verify` after any of them.
7. ~~Baseline refresh~~ — **done 2026-09-07**: `baseline/` now holds the
   modernised fork's four targets (852 files, `MANIFEST.sha256` regenerated
   and spot-verified) captured from commit `cd728ab`; the original V1.3.77
   upstream build moved to `baseline-v1.3.77-upstream-archive/` for
   upstream-relative archaeology only.
