# FastStream — working notes

Fork of [Andrews54757/FastStream](https://github.com/Andrews54757/FastStream),
branched from `d5fe931` (V1.3.77). GPL-3.0-or-later; any derivative must stay
GPL-3.0-or-later with public source.

Goal: an AMO-compliant Firefox build with a modern, testable dev workflow,
without breaking Chrome and without making upstream merges painful.

## Commands

```bash
pnpm install              # pnpm 11, pinned via packageManager
pnpm run build            # 4 targets -> built/*.zip, unpacked dirs deleted
pnpm run build:keep       # same, but keeps build_*/ for web-ext
pnpm run lint             # eslint (must stay at 0)
pnpm run lint:amo         # web-ext lint on build_firefox_libre
pnpm run start:ff         # web-ext run — launches Firefox with the extension
pnpm test                 # vitest
```

`build:keep` must run before any `lint:amo` or `start:ff` — those need an
unpacked directory, and a plain build leaves only zips.

## Manual playback testing

```bash
pnpm run profile:setup   # once: builds .dev-profile with uBlock Origin
pnpm run build:keep
pnpm run start:ff        # persistent profile, uBO enabled
pnpm run start:ff:clean  # throwaway profile, FastStream only
```

The dev profile exists because real streaming sites are dense with ads and
overlay players, which makes "FastStream failed to replace the player"
indistinguishable from "an ad iframe got in the way". `.dev-profile/` is
gitignored.

**How FastStream picks up a stream URL.** `background.mjs:913`
`setupRedirectRule` installs a declarativeNetRequest rule matching
`^.+\.(m3u8|mpd)([?#].*)?$` on `main_frame` and redirects to the player with
the URL in the hash. So pasting a manifest URL into the address bar opens it
in FastStream — **but only when the matching option is on, and both default
to `false`** (`DefaultOptions.mjs:13-14`):

- `playMP4URLs` → rule 1, `.mp4`
- `playStreamURLs` → rule 2, `.m3u8` and `.mpd`

Enable them in the extension's options page before testing by URL. Without
them, use a page that embeds the stream and click the FastStream toolbar
icon instead.

### The playback checklist

**This is the reference baseline. Re-run it after every change to the player,
the loaders or the vendored libraries.** Confirmed working on upstream
`d5fe931` + the tooling commits, firefox-libre build, 2026-09-02:

| Format | Page | Status |
|---|---|---|
| DASH | `https://reference.dashif.org/dash.js/v4.4.0/samples/getting-started/auto-load-single-video-src.html` | works |
| HLS | `https://tracylocalschool.com/gquzbcolcgom` | works |
| MP4 | `https://video.nie.edu.sg/media/Sample-Video-File-For-Testing.mp4/0_9311zvk2/22238` | works |

These are **pages that embed a stream**, so they exercise the content-script
detection path — the one real users hit. That is the more valuable test than
a pasted manifest URL, which only exercises the declarativeNetRequest
redirect.

Direct manifests for testing the redirect path instead (all verified
`200 application/dash+xml`), which need `playStreamURLs` enabled first:

- `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` (DASH-IF reference vector)
- `https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd`

Real sites serving DASH: Bilibili (has a dedicated content script at
`chrome/custom/bilibili_content.js`), and most large video platforms.

YouTube is a separate path again (`YTPlayer` + the sandboxed evaluator) and
is not covered by the three above.

## Architecture facts that are easy to get wrong

- **Already Manifest V3.** `chrome/manifest.json` is `manifest_version: 3`
  with a `service_worker`. `build.mjs` rewrites that to `background.scripts`
  (a non-persistent event page) for Firefox. There is no MV2 migration to do.
- **Nothing is bundled.** The browser loads all 166 `.mjs` files natively as
  ES modules. `build.mjs` is a file-copier plus a conditional-compilation
  preprocessor — not a bundler. Introducing whole-tree bundling is a
  behaviour change, not a refactor.
- **The hls.js/dash.js hooks are already the official public APIs.**
  `HLSPlayer.mjs:68` passes `loader: HLSLoaderFactory(this)` (hls.js's
  documented config option) and `DashPlayer.mjs:153` calls
  `dash.extend('XHRLoader', DASHLoaderFactory(this), false)` (dash.js's
  public extension point). The AMO problem is that the vendored *bytes*
  aren't an official release — not that the integration is hacked.
- **Vendored library versions are current**, not stale: dash.js reports
  `VERSION = '5.1.0'`, hls.js carries 1.6.x branches.

## The SPLICER preprocessor

`build.mjs` strips or injects code per build target using comment directives:

```js
// SPLICER:<TARGET>:REMOVE_LINE      drop this line
// SPLICER:<TARGET>:REMOVE_START     drop everything until REMOVE_END
// SPLICER:<TARGET>:REMOVE_END
// SPLICER:<TARGET>:REMOVE_FILE      drop the whole file
// SPLICER:<TARGET>:INSERT_LOCALE    inline all _locales messages
// SPLICER:<TARGET>:INSERT_VERSION   inline the package.json version
```

**It only processes `.mjs` and `.js`.** Move code into a `.ts` file and it
silently stops being spliced — no error, wrong code ships. Stay on `.mjs`
plus JSDoc.

Targets: `EXTENSION`, `FIREFOX`, `WEB`, `CENSORYT`, `NO_PROMO`,
`NO_UPDATE_CHECKER`.

## Build targets

| Target | Splices | Notes |
|---|---|---|
| `chrome-libre` | EXTENSION, NO_PROMO | manual install, full features |
| `chrome-dist` | EXTENSION, CENSORYT, NO_UPDATE_CHECKER | Chrome Web Store; YouTube **downloading** disabled (not playback) |
| `firefox-libre` | EXTENSION, FIREFOX, NO_PROMO | manual install |
| `firefox-dist` | EXTENSION, FIREFOX, CENSORYT, NO_UPDATE_CHECKER | AMO target; min version 142, declares data_collection_permissions |
| `web` | WEB, NO_UPDATE_CHECKER | faststream.online, no extension APIs |

`buildFirefoxDist()` was written but never invoked (commit "Remove firefox
dist build for now"). Re-enabled in `7ed4723`.

## Rules

- **Never hand-edit `chrome/player/modules/*`** — vendored third-party code
  (dash.mjs 3.5 MB, hls.mjs 1.3 MB, yt.mjs 1.3 MB). Excluded from eslint and
  tsconfig; they stall the language server otherwise.
- **`build.mjs` rewrites `chrome/manifest.json` in place** on every run to
  sync the version from `package.json`. The tree is dirty after each build.
  Don't sweep it into an unrelated commit.
- `incognito: "split"` is deliberately deleted for Firefox builds — Gecko
  doesn't support split mode. Not a bug.
- Branches: `main` mirrors upstream, `dev/mv3-modernization` is the work
  branch, `pr/*` branches get cut fresh off `upstream/main`.

## AMO lint (firefox-dist, current: 0 errors / 15 warnings)

Upstream firefox-libre baseline was 0 errors, 24 warnings, 1 notice. After
re-enabling firefox-dist with data_collection_permissions and min version
142, the AMO target sits at **0 errors, 15 warnings** - the version bump
alone cleared 8 API-compat warnings. 13 of the 15 remaining live in vendored
libraries and go away with the Phase 7 npm migration; the only first-party
hits are `background.mjs:619` (UNSUPPORTED_API) and `PlayerLoader.mjs:16`
(UNSAFE_VAR_ASSIGNMENT), plus `yt_runner.js:14`.

### Original upstream baseline (firefox-libre)

**0 errors, 24 warnings, 1 notice.** The automated linter already passes.
The 2023 store rejection was a *human policy* call about the customized
hls.js/dash.js/youtube.js, which `web-ext lint` cannot detect.

| Count | Code | Where |
|---|---|---|
| 1 | `MISSING_DATA_COLLECTION_PERMISSIONS` | `manifest.json` — new AMO requirement, must fix before submitting |
| 5 | `ANDROID_INCOMPATIBLE_API` | `perms.mjs`, `background.mjs`, `BackgroundUtils.mjs` — no mobile support by design |
| 3 | `INCOMPATIBLE_API` | `background.mjs:603,607`, `BackgroundUtils.mjs:87` |
| 2 | `UNSUPPORTED_API` | `background.mjs:619`, `gif/gif.mjs:294` |
| 3 | `DANGEROUS_EVAL` | `userscripts/yt_runner.js:14` (**real blocker**), `sweetalert.mjs:3705`, `dash.mjs:85152` (both vendored) |
| 10 | `UNSAFE_VAR_ASSIGNMENT` | 7× `coloris.mjs`, `vtt.mjs:1065`, `vad/ort.wasm.mjs:8` (vendored); `players/PlayerLoader.mjs:16` (**ours**) |

Two of the three `DANGEROUS_EVAL` hits are inside vendored libraries —
another reason unbundling to stock npm releases helps: reviewers accept
known-good upstream releases they can verify.

`yt_runner.js:14` runs `new Function(...argNames, body)` on YouTube's
signature-decipher function, fetched at runtime. That is remotely-hosted
code execution.

### CENSORYT does NOT disable YouTube

Easy to get wrong. `YTPlayer.mjs` `canSave()` is the only thing it touches —
it forces `cantSave: true`, blocking **downloading** YouTube videos. Playback
still works, `ENSURE_YT_USERSCRIPT` still registers `yt_runner.js`, and the
`new Function` call still ships. Removing YouTube entirely would need a new
splice target covering `YTPlayer`, the `registerYTUserScript()` body in
`background.mjs:689`, and `yt_runner.js` itself.

Note `userScripts` is already an **optional** permission in the Firefox
builds, and `YTPlayer.setSource` degrades gracefully when it is declined
(`AlertPolyfill.ytUserscriptError`, then an ERROR event).

## The binary blobs are identifiable published artifacts

Not mystery blobs — every one has a known upstream, version and licence, so
they belong in the Phase 7 npm migration rather than being removed:

| File | What it is | npm |
|---|---|---|
| `vad/ort-wasm-simd-threaded.wasm` + `ort.wasm.mjs` | **ONNX Runtime Web v1.20.0**, Microsoft, MIT | `onnxruntime-web@1.20.0` |
| `vad/silero_vad_half.ort` | Silero VAD model, ORT format, MIT | published model |
| `reencoder/libsamplerate.wasm` + `.mjs` | `aolsenjazz/libsamplerate-js`, MIT | `@alexanderolsen/libsamplerate-js` |

`vad/LICENSE.md` is already in-tree. **`ort.wasm.mjs` carries the comment
"Minified to reduce loading time (https://minify-js.com/)"** — Andrew
minified it by hand, which is precisely the modified-third-party-library
problem AMO objects to. Shipping the unminified npm dist fixes it.

VAD is lazily loaded via dynamic `import()` from
`analyzer/AudioAnalyzerNode.mjs:63`, so it only costs anything when the
audio analyzer runs.

## Type checking

`tsconfig.json` type checks without emitting. `checkJs` is off; files opt in
with `// @ts-check` on line 1. `pnpm run typecheck` is gated in CI, so the
opted-in set is a ratchet.

Opted in: `BackgroundUtils`, `MultiRegexMatcher`, `SponsorBlockIntegration`,
`TabTracker`. Not yet: `background.mjs` (23 errors), `StreamSaverBackend`
(3), `NetRequestRuleManager` (1) — mostly nullability and API-shape issues
in the header-spoofing and download paths, where a wrong guard causes silent
403s. Fix those only with the playback checklist to hand.

`types/messages.d.ts` describes the cross-context message contracts. Add a
message only after reading its real payload; an inaccurate type is worse
than an absent one.

Use `@types/chrome` — the codebase uses `chrome.*` in 136 places and does
not use webextension-polyfill at all.

## Baseline verification

Any change claiming to be output-neutral must reproduce the upstream build
exactly. Use `tools/hash-build.mjs`, which collapses CRLF to LF for text
files before hashing:

```bash
pnpm run build:keep                                  # --keep is required
node tools/hash-build.mjs build_firefox_libre > after.txt
diff baseline.txt after.txt                          # must be empty
```

**Always normalise line endings when comparing builds.** A build made on
Windows before `.gitattributes` existed has CRLF throughout; Andrew's Linux
CI produces LF. Comparing raw bytes across the two makes all 620 text files
look changed when nothing is. Verified for the pnpm migration: 611 text
files and 9 SVGs content-identical, 24 png/wasm/ort byte-identical, 644
total. The LF output this fork now produces is what upstream CI already
ships; the CRLF build was the local anomaly.

## Known upstream bugs fixed here

- `miniglob.mjs` `cleanGlobPath` shadowed the module-level `volumeNameLen`
  with a parameter of the same name, then called it. Callers pass a number,
  so **every Windows build failed** with `TypeError: volumeNameLen is not a
  function`. Fixed in `ab0719d`; candidate for upstream PR.
- No `.gitattributes`, so Windows checkouts got CRLF and eslint's
  `linebreak-style` reported 2352 errors. Fixed in `e81b036`.
