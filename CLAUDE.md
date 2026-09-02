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
| `chrome-dist` | EXTENSION, CENSORYT, NO_UPDATE_CHECKER | Chrome Web Store; **YouTube stripped** |
| `firefox-libre` | EXTENSION, FIREFOX, NO_PROMO | manual install |
| `firefox-dist` | EXTENSION, FIREFOX, NO_UPDATE_CHECKER | **written but never called** by `runAll()`, and **missing `CENSORYT`** |
| `web` | WEB, NO_UPDATE_CHECKER | faststream.online, no extension APIs |

`buildFirefoxDist()` exists in `build.mjs` but `runAll()` doesn't invoke it
(commit "Remove firefox dist build for now"). Re-enabling it *and* adding
`CENSORYT` to its splice list is the AMO deliverable.

## Rules

- **Never hand-edit `chrome/player/modules/*`** — vendored third-party code
  (dash.mjs 3.5 MB, hls.mjs 1.3 MB, yt.mjs 1.3 MB). Excluded from eslint and
  jsconfig; they stall the language server otherwise.
- **`build.mjs` rewrites `chrome/manifest.json` in place** on every run to
  sync the version from `package.json`. The tree is dirty after each build.
  Don't sweep it into an unrelated commit.
- `incognito: "split"` is deliberately deleted for Firefox builds — Gecko
  doesn't support split mode. Not a bug.
- Branches: `main` mirrors upstream, `dev/mv3-modernization` is the work
  branch, `pr/*` branches get cut fresh off `upstream/main`.

## AMO lint baseline (upstream d5fe931, firefox-libre)

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
code execution and no wrapper makes it AMO-legal — hence `CENSORYT`.

## Binary blobs (unresolved AMO risk)

3.0 MB of binaries with no build script in the repo:

- `chrome/player/modules/vad/ort-wasm-simd-threaded.wasm` — 1.04 MB
- `chrome/player/modules/vad/silero_vad_half.ort` — 1.86 MB
- `chrome/player/modules/reencoder/libsamplerate.wasm` — 0.12 MB

Reviewers ask for reproducible sources. Either document a build, or splice
them out of the dist target.

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
