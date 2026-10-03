# Build instructions for AMO reviewers

This add-on is assembled by a build script, so AMO's source-code submission
requirement applies. This document is the reviewer-facing half of that: it
describes how to reproduce the submitted package from the source archive.

Everything below was run on the exact commit the submission was built from.

## Build environment

| | |
|---|---|
| Operating system | Any of Linux, macOS or Windows. CI builds on `ubuntu-latest`. |
| Node.js | 22 or newer. `localescript.mjs` uses `Set.prototype.difference`, which Node 20 lacks; `engines` in `package.json` says `>=22`. CI uses the major in `.nvmrc`. |
| Package manager | pnpm 11, the exact version pinned by the `packageManager` field in `package.json` (installed with npm, or with corepack on Node 24 and older). |
| Network access | Needed for `pnpm install` only. The build itself is offline. |

No compilers, native toolchains or system libraries are required. The
WebAssembly binaries in the tree are prebuilt and are **not** compiled by
this build - see "Prebuilt binaries" below.

## Reproducing the submitted package

From the root of the source archive:

```sh
npm i -g pnpm@<the version in packageManager>   # or, on Node 24 and older: corepack enable
pnpm install --frozen-lockfile
pnpm run build:keep
```

That produces the submitted add-on at:

```
built/firefox-amo-faststream_video_player-<version>.zip
```

`build.mjs` moves it there from web-ext's artifacts folder
(`build_firefox_amo/amo/`). `build:keep` also leaves the same content
unpacked in `build_firefox_amo/` for inspection.

To confirm it is clean:

```sh
pnpm run lint:amo               # web-ext lint against build_firefox_amo
```

Expected result: **0 errors, 0 notices, 3 warnings.** Each of the three
warnings is in third-party library code and is explained individually in
`docs/amo-linter-warnings.md`.

To compare a rebuild with the submitted package, unzip the submitted package
and run `node tools/hash-build.mjs <dir>` on it and on `build_firefox_amo`,
then diff the two lists. It hashes file contents (text with line endings
collapsed), so it shows real differences; the zips themselves also store
file times.

## What the build actually does

`pnpm run build:keep` runs three steps in order:

1. **`node tools/sync-vendor.mjs`** - copies the media libraries out of
   `node_modules/` into `chrome/player/modules/`. These are ordinary npm
   packages; where this project needed changes, they are applied by pnpm as
   patch files rather than by hand-editing the vendored copy. The patches
   are declared in `pnpm-workspace.yaml` under `patchedDependencies` and
   live in `patches/`:

   ```
   Coloris@0.25.0     dashjs@5.2.1      gif.js@0.2.0     hls.js@1.7.3
   mp4box@2.4.1       sweetalert2@11.26.25
   ```

   Besides the patches, `sync-vendor.mjs` itself makes a few small
   mechanical changes on the way (a UMD wrapper turned into an ES module,
   an added export, an inline source map stripped). The changes are in that script, not in an
   edited copy.

   This is the key point for review: every bundled library is a **pinned
   npm release plus a readable diff**, not an opaque vendored blob. The
   one exception is Coloris, which is not on npm: it is pinned to its git
   tag in `package.json` (`github:mdbassit/Coloris#v0.25.0`), and the
   lockfile records the commit and the tarball's hash. The version in the
   lockfile is the version that ships.

2. **`node localescript.mjs`** - with no arguments, it checks that every
   locale in `chrome/_locales/` has the English locale's keys and lists
   any missing or extra ones. It writes nothing (combining the message
   files is `pnpm run combine-locales`, not part of the build).

3. **`node build.mjs --keep`** - copies `chrome/` into each target's build
   directory, runs the source splicer, adjusts the manifest per target, and
   packages the result with `web-ext`. Without `--keep` the unpacked
   directories are deleted and only the zips in `built/` remain.

### The splicer

`build.mjs` preprocesses sources using `SPLICER:<TARGET>:` comments embedded
in the code (`tools/splicer.mjs`). Apart from the lines those comments remove or
insert, every script ships as it is in the tree (a missing final newline is
added). For the AMO target the
active tags are:

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

On Windows, in PowerShell:

```powershell
Get-ChildItem build_firefox_amo -Recurse -Include yt*.mjs,googlevideo.mjs   # no matches
```

`NO_UPDATE_CHECKER` likewise removes `player/utils/UpdateChecker.mjs`, so
the add-on itself makes no version-check request; Firefox checks for
updates through the manifest's `update_url`, as for any self-hosted add-on.

## Prebuilt binaries

One WebAssembly artifact ships prebuilt rather than being compiled here,
and the VAD's model is likewise a file published by its upstream. Both
can be checked against their origins without trusting this repository:

| Artifact | Verify with |
|---|---|
| ONNX Runtime (`vad/ort-wasm-simd-threaded.wasm`, its glue and the loader) | the stock npm files - `tools/sync-vendor.mjs` copies all three exactly as `onnxruntime-web@1.30.0` publishes them (gitignored; the loader's inline source map is stripped, nothing else); a reviewer can install that version and diff. |
| Silero VAD model (`vad/silero_vad_half.onnx`) | `pnpm run verify:vad` - hashes the file in the tree against the file snakers4/silero-vad publishes at tag v6.2.1. |

Additional provenance checks for non-npm vendored files:

```sh
pnpm run verify:vtt
pnpm run verify:vad
pnpm run verify:knob
```

Full narrative provenance for every third-party file - what it is, which
upstream release it came from, and exactly what was changed - is in
`docs/vendored-libraries.md`.

## Full verification (optional)

The complete suite the project gates commits on:

```sh
pnpm run verify
```

This runs eslint, TypeScript type-checking, unit tests, all three builds
(the GitHub zip, the AMO build and the web player), addons-linter against
both Firefox targets, browser end-to-end tests (WebDriver + Firefox),
extension-loaded end-to-end tests (including the VAD reference check,
`tests/e2e/ext-specs/vad.e2e.mjs`), and the VAD model hash check
(`pnpm run verify:vad`).

The end-to-end tests require a Firefox binary and will download WebDriver
components on first run; they are not needed to reproduce the package.
