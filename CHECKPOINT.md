# FastStream modernisation — checkpoint

**Date:** 2026-09-02
**Fork:** https://github.com/Nawid3333/FastStream
**Branch:** `dev/mv3-modernization` (also the fork's default branch)
**Base:** upstream `d5fe931` (V1.3.77)
**CI:** green — https://github.com/Nawid3333/FastStream/actions
**Plan doc:** https://claude.ai/code/artifact/830a4dd8-e6ab-4429-a4ac-b5541f9a3224

Everything below is committed and pushed. Nothing is in an unfinished state.

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

| Phase | State | Notes |
|---|---|---|
| 0 · Baseline | **done** | 644-file build baseline captured |
| 1 · pnpm | **done** | Proven output-neutral |
| 2 · Dev harness | **done** | `--keep`, web-ext 10.6, ESLint 2352→0, CLAUDE.md |
| 3 · Vite vendor | **not started** | Superseded — see "strategy change" below |
| 4 · Unit tests | **done** | 58 tests, all mutation-verified |
| 5 · E2E (WebdriverIO) | **deferred** | Your call: after Firefox passes lint |
| 6 · CI | **done** | Green in ~35s |
| 7 · Unbundle libs | **7 of ~13 done** | hls.js `.mjs` only. ~18 libs + 3 MB of wasm/ort still vendored — see below |
| 8 · AMO sweep | **part done** | firefox-dist live: 0 errors, 24→15 warnings |
| 9 · Signing | **not started** | Needs gecko ID change first |
| 10 · Upstream PRs | **not started** | Two strong candidates ready |
| — · TypeScript | **done** | Not in the original plan; you requested it |
| — · Upstream sync | **done** | Weekly workflow, opens a PR, never auto-merges |

---

## Commits on the branch

```
89bef83 docs: measure the hls.js divergence instead of assuming it
411c966 build(dev): fix the dev-profile launcher and record the playback baseline
d47309f build(dev): add a persistent test profile with uBlock Origin preinstalled
75ce249 docs: correct CENSORYT scope and record what the binary blobs actually are
7ed4723 fix(firefox-dist): re-enable the store build and make it AMO-submittable
0176208 types: add opt-in type checking and cross-context message contracts
ffa233e build(tools): add EOL-normalising build hasher for output-neutrality checks
d922563 ci: add weekly upstream sync that opens a PR instead of auto-merging
65daf55 test(vitest): add unit suite for stream detection and buffer maths
6032284 docs: add CLAUDE.md working notes
e81b036 build(harness): add --keep flag, web-ext scripts, lint scope and LF normalisation
30625bb build(pnpm): migrate from npm to pnpm
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
6. **hls.js is 1.6.9 with only 466 divergent lines** (1.3%, 22 hunks) — not a fork. Much has already landed upstream.

---

## Strategy change: `pnpm patch`, not Vite wrappers

The original Phase 3/7 plan was Vite vendor bundles plus wrapper classes. The hls.js measurement showed that cannot work:

- `hls2mp4/transmuxer.mjs` imports six demuxer/remuxer classes that **stock hls.js does not export in any release**, and the package's `exports` map offers no deep-import path.
- The remuxer's `outputSamples` return field is also absent upstream.

Reimplementing a demuxer to avoid a one-line export change adds far more risk than it removes. So: ship the **official npm release plus a committed patch file** via `pnpm patch`.

That satisfies what AMO actually wants — a hash-verifiable upstream base and a human-sized, auditable diff — instead of today's 1.3 MB file with no stated version or provenance.

Full analysis: `Faststream version 4/docs/vendored-libraries.md`
Raw diff: `Faststream version 4/docs/hls.js-1.6.9-faststream.patch`

---

## YouTube removed from the AMO build (firefox-dist)

`firefox-dist` is now spliced with a `NO_YOUTUBE` target. Chrome targets and
`firefox-libre` are untouched.

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

**Results on firefox-dist:**

| | Before | After |
|---|---|---|
| `web-ext lint` | 0 errors, 15 warnings | 0 errors, **13 warnings** |
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

Remaining 13 warnings: 10 UNSAFE_VAR_ASSIGNMENT, 2 DANGEROUS_EVAL, 1
UNSUPPORTED_API - almost all inside vendored libraries that now have a
verifiable npm base.

**libre is unaffected**, verified file by file against the baseline build. Its
only changes are the splice comments plus an `if (false)` block that is
unreachable there, following the same idiom `CENSORYT` already uses.

**Testing the store build:** `pnpm run start:ff:dist` launches firefox-dist in
the isolated dev profile (`pnpm run start:ff` still launches libre).

---

## Verified playback baseline

Confirmed working by you on the firefox-libre build, 2026-09-02, and
re-confirmed 2026-09-03 after hls.worker.js became a generated file. **Re-run after every change to the player, loaders or vendored libraries.**

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
pnpm run lint:amo:dist  # web-ext lint on the AMO build

pnpm run profile:setup  # once — builds .dev-profile with uBlock Origin
pnpm run start:ff       # launches an ISOLATED Firefox (never touches your own)
```

---

## AMO position

`firefox-dist` (the store target): **0 errors, 13 warnings.**

Breakdown: 10 UNSAFE_VAR_ASSIGNMENT, 2 DANGEROUS_EVAL, 1 UNSUPPORTED_API,
almost all inside vendored libraries that now have a hash-verifiable npm base.
`yt_runner.js:14` (the YouTube eval) is **gone** - firefox-dist is spliced with
NO_YOUTUBE, which also removed the `userScripts` permission and the
`configureWorld` call that set a `script-src 'unsafe-eval'` CSP.

**Vendored libraries now generated from npm:** hls.js (+ worker), dash.js,
pako, fuse.js, sortablejs, sweetalert2. Only hls.js and dash.js need patches;
the rest are stock or stock plus a documented few-line transform.

**Still vendored:** mp4box, vtt.js (npm ships no bundle), coloris (from
mdbassit/Coloris, not the @melloware npm fork), knob (GitHub only), and the
wasm/ort blobs. yt.mjs and googlevideo.mjs remain in the libre build only.

mp4box is a correction of a correction, and the reason is worth keeping. An
earlier note here claimed "no published dist matches"; that was wrong, because
the version search only covered the 2.x line, which was a rewrite. The 0.x line
does match closely - but generating `mp4box.mjs` from npm 0.5.3 **breaks MP4
playback**, which the e2e suite caught and a file swap confirmed. The vendored
copy predates 0.5.3 (it lacks the `lhvC` box parser and the `fLaC` sample
entry). So the npm base exists and is still rejected, on evidence. Finishing it
means bisecting mp4box between 0.5.2 and 0.5.3 to find what breaks FastStream's
MP4 path; until then `mp4box` is deliberately **not** a devDependency, so that
package.json cannot imply a provenance the build does not use.

---

## Open decisions

1. **YouTube in the AMO build.** `yt_runner.js:14` evaluates code fetched from YouTube at runtime. `web-ext lint` treats it as a *warning*, not an error, and `userScripts` is already an optional permission that degrades gracefully — so an unlisted submission should pass. My recommendation: build the removal switch, leave it off, submit, and flip it only if a human reviewer objects. Your daily driver keeps YouTube either way (it runs the libre build).
2. **Gecko extension ID.** Still `faststream@andrews`, hardcoded in `build.mjs`. Must change before any signing — it is Andrew's identity and would collide with his signed builds.
3. **E2E timing.** Still deferred by your choice.

---

## hls.js migration — done, step 1 of 2

`chrome/player/modules/hls.mjs` is no longer in git. It is generated at build
time by `tools/sync-vendor.mjs` from `hls.js@1.6.9` on npm plus
`patches/hls.js@1.6.9.patch`, applied by pnpm on install.

- **Before:** 1.3 MB file, `const version = undefined`, no provenance.
- **After:** hash-verifiable npm base + a 22-hunk patch a reviewer reads in ten minutes.

Verified inert: a clean `pnpm install` reproduces the previously vendored
file byte-for-byte, and `player/modules/hls.mjs` in the build output hashes
identically to the upstream baseline (`8702f2b3`). Across the whole
firefox-libre target the only differing files are the four background
modules carrying `// @ts-check`, each by exactly that one line.

**Still to do for hls.js (step 2):** upgrade the base to 1.7.1 and drop the
hunks that landed upstream; move the ABR change into a
`FastStreamAbrController` subclass passed via hls.js config (public API, no
patch needed); keep only the extra demuxer exports, `outputSamples`, and the
two unlanded fixes. Expected to shrink the patch from 22 hunks to about
three. **Re-run the playback checklist after this** — step 2 is the first
change that can actually alter behaviour.

---

## Phase 7 is the bulk of the remaining work

The checkpoint previously framed this as "hls.js, dash.js, youtube.js". A full
inventory of `chrome/player/modules/` shows that undercounts it badly. Still
vendored, still tracked in git, none with a recorded version:

| File | Size | Notes |
|---|---|---|
| `dash.mjs` | 3.5 MB | base `5.1.0`, known from in-tree `VERSION` — not yet measured |
| `vad/silero_vad_half.ort` | 1.8 MB | Silero VAD model blob |
| `yt.mjs` | 1.2 MB | youtube.js — not yet measured |
| `vad/ort-wasm-simd-threaded.wasm` | 1.0 MB | ONNX Runtime Web v1.20.0 (MIT) |
| `mp4box.mjs` | 318 KB | |
| `pako.mjs` | 275 KB | |
| `googlevideo.mjs` | 170 KB | |
| `sweetalert.mjs` | 152 KB | |
| `sortable.mjs` | 120 KB | |
| `reencoder/libsamplerate.wasm` | 118 KB | libsamplerate-js (MIT) |
| `reencoder/webm.mjs` | 106 KB | |
| `vtt.mjs` | 88 KB | |
| `reencoder/mp4-muxer.mjs` | 62 KB | |
| `reencoder/libsamplerate.mjs` | 51 KB | |
| `vad/ort.wasm.mjs` | 47 KB | **hand-minified by Andrew** — itself the AMO problem |
| `fuse.mjs` | 45 KB | |
| `coloris.mjs` | 38 KB | |
| `gif/gif.worker.js` + `gif/gif.mjs` | 58 KB | |
| `knob.mjs` | 27 KB | |

**`hls.worker.js` — CLOSED.** Now generated from npm's unminified UMD build
by `tools/sync-vendor.mjs`; see `docs/vendored-libraries.md`. Original note
kept below for context.

~~**`hls.worker.js` is an unclosed gap.**~~ `hls.mjs` now comes from npm, but
`HLSPlayer.mjs:29` also loads `modules/hls.worker.js`, which is still a
325 KB tracked file. npm ships it too (`node_modules/hls.js/dist/hls.worker.js`,
102 KB) — the in-tree copy is the same code **unminified**. Unminified is
better for AMO review, so the fix is to generate it from the npm source via
`tools/sync-vendor.mjs` rather than to ship npm's minified build verbatim.
Until that is done the hls.js migration is not actually complete.

Not every library needs the full `pnpm patch` treatment — several are likely
unmodified stock copies, where a plain npm dependency plus a `sync-vendor.mjs`
entry is enough. The measurement decides which.

---

## Next steps, in order

1. ~~Close the hls.js gap~~ — **done**, `hls.worker.js` is generated from npm.
2. **hls.js step 2** (above) — the first behaviour-affecting change. Playback checklist required.
3. **Same measurement for dash.js** (base `5.1.0`, already known from `VERSION` in-tree), youtube.js, then the smaller libraries.
4. Phase 8 remainder — the two first-party lint warnings, and the YouTube decision.
5. Phase 9 signing — the gecko ID is `faststream@andrews` in **two** places in `build.mjs` (lines 335 and 369); both must change.
6. **Phase 10 PRs — held until the fork is complete**, by your decision, so Andrew can integrate them one at a time and still have a working program. Each `pr/*` branch will be cut fresh from `upstream/main` and verified green on its own before you see it. Two candidates are already clean: the `miniglob.mjs` Windows build fix and `.gitattributes`.
