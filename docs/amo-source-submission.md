# Build instructions for AMO reviewers

This add-on is assembled by a build script, so AMO's source-code submission
requirement applies. This document is the reviewer-facing half of that: it
describes how to reproduce the submitted package from the source archive.

Everything below was run on the exact commit the submission was built from.

## Build environment

| | |
|---|---|
| Operating system | Any of Linux, macOS or Windows. CI builds on `ubuntu-latest`. |
| Node.js | 22 (CI). Anything `>=20` works - see `engines` in `package.json`. |
| Package manager | pnpm 11.22.0, pinned by the `packageManager` field in `package.json`. |
| Network access | Needed for `pnpm install` only. The build itself is offline. |

No compilers, native toolchains or system libraries are required. The
WebAssembly binaries in the tree are prebuilt and are **not** compiled by
this build - see "Prebuilt binaries" below.

## Reproducing the submitted package

From the root of the source archive:

```sh
corepack enable                 # or: npm i -g pnpm@11.22.0
pnpm install --frozen-lockfile
pnpm run build:keep
```

That produces the submitted add-on at:

```
build_firefox_amo/amo/faststream_video_player-<version>.zip
```

and leaves the same content unpacked in `build_firefox_amo/` for inspection.

To confirm it is clean:

```sh
pnpm run lint:amo               # web-ext lint against build_firefox_amo
```

Expected result: **0 errors, 0 notices, 3 warnings.** Each of the three
warnings is in third-party library code and is explained individually in
`docs/amo-linter-warnings.md`.

## What the build actually does

`pnpm run build:keep` runs three steps in order:

1. **`node tools/sync-vendor.mjs`** - copies the media libraries out of
   `node_modules/` into `chrome/player/modules/`. These are ordinary npm
   packages; where this project needed changes, they are applied by pnpm as
   patch files rather than by hand-editing the vendored copy. The patches
   are declared in `pnpm-workspace.yaml` under `patchedDependencies` and
   live in `patches/`:

   ```
   Coloris@0.21.1     dashjs@5.1.0      gif.js@0.2.0     hls.js@1.7.2
   jswebm@0.1.2       mp4box@0.5.3      sweetalert2@11.12.4
   ```

   This is the key point for review: every bundled library is a **pinned
   npm release plus a readable diff**, not an opaque vendored blob. The
   version in the lockfile is the version that ships.

2. **`node localescript.mjs`** - combines the per-locale message files in
   `chrome/_locales/`.

3. **`node build.mjs`** - copies `chrome/` into each target's build
   directory, runs the source splicer, adjusts the manifest per target, and
   packages the result with `web-ext`.

### The splicer

`build.mjs` preprocesses sources using `SPLICER:<TARGET>:` comments embedded
in the code. For the AMO target the active tags are:

```
EXTENSION  FIREFOX  NO_UPDATE_CHECKER
```

YouTube support was removed from the source tree entirely (not just this
target) - `yt.mjs`, `googlevideo.mjs`, `YTPlayer.mjs`, the sandboxed
evaluator and `yt_runner.js` are deleted, not spliced out. You can confirm
this in the built output:

```sh
find build_firefox_amo -iname 'yt*.mjs' -o -iname 'googlevideo.mjs'   # no matches
```

`NO_UPDATE_CHECKER` likewise removes `player/utils/UpdateChecker.mjs`, so
this build makes no version-check request.

## Prebuilt binaries

Two WebAssembly artifacts ship prebuilt rather than being compiled here.
Both can be checked against their upstream origin without trusting this
repository:

| Artifact | Verify with |
|---|---|
| ONNX Runtime (`ort-wasm-simd-threaded.wasm`) | `pnpm run verify:ort` - reads the build metadata out of the binary itself and checks it matches the documented upstream build (onnxruntime 1.20.0 @ `5c74539ab7`, MinSizeRel, reduced/ORT-format). |
| libsamplerate | `tools/reproduce-libsamplerate-wasm.sh` - rebuilds it from upstream source and compares. |

Additional provenance checks for non-npm vendored files:

```sh
pnpm run verify:vtt      pnpm run verify:vad      pnpm run verify:knob
```

Full narrative provenance for every third-party file - what it is, which
upstream release it came from, and exactly what was changed - is in
`docs/vendored-libraries.md`.

## Full verification (optional)

The complete suite the project gates commits on:

```sh
pnpm run verify
```

This runs eslint, TypeScript type-checking, unit tests, all four builds,
addons-linter against both Firefox targets, browser end-to-end tests
(WebDriver + Firefox), extension-loaded end-to-end tests, and the ONNX
Runtime provenance check.

The end-to-end tests require a Firefox binary and will download WebDriver
components on first run; they are not needed to reproduce the package.
