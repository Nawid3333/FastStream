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
| 7 · Unbundle libs | **analysed, not started** | hls.js measured; dash.js and yt.js not yet |
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

## Verified playback baseline

Confirmed working by you on the firefox-libre build, 2026-09-02. **Re-run after every change to the player, loaders or vendored libraries.**

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

`firefox-dist` (the store target): **0 errors, 15 warnings.**

13 of the 15 are inside vendored libraries and disappear with the npm migration. Only two are first-party: `background.mjs:619` (UNSUPPORTED_API) and `PlayerLoader.mjs:16` (UNSAFE_VAR_ASSIGNMENT), plus `yt_runner.js:14` (the YouTube eval).

---

## Open decisions

1. **YouTube in the AMO build.** `yt_runner.js:14` evaluates code fetched from YouTube at runtime. `web-ext lint` treats it as a *warning*, not an error, and `userScripts` is already an optional permission that degrades gracefully — so an unlisted submission should pass. My recommendation: build the removal switch, leave it off, submit, and flip it only if a human reviewer objects. Your daily driver keeps YouTube either way (it runs the libre build).
2. **Gecko extension ID.** Still `faststream@andrews`, hardcoded in `build.mjs`. Must change before any signing — it is Andrew's identity and would collide with his signed builds.
3. **E2E timing.** Still deferred by your choice.

---

## Next steps, in order

1. **Phase 7 for hls.js** — upgrade to 1.7.1, drop the hunks that landed upstream, move the ABR change into a `FastStreamAbrController` subclass (public API, no patch), patch only the exports + `outputSamples` + two unlanded fixes. Re-run the playback checklist.
2. **Same measurement for dash.js** (base `5.1.0`, already known) and youtube.js.
3. **Phase 10 PR 1** — two clean upstream candidates already exist and are worth submitting regardless of the rest:
   - the `miniglob.mjs` Windows build fix (one line, obviously correct)
   - `.gitattributes` (fixes 2352 phantom lint errors for Windows contributors)
4. Phase 9 signing, once the gecko ID is settled.
