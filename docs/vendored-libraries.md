# Vendored libraries: what was actually changed

Mozilla's stated objection to FastStream on AMO is that it ships "heavily
customized" copies of hls.js, dash.js and youtube.js rather than official
releases. This file measures that claim rather than assuming it.

Method: fetch every candidate npm release, diff each against the in-tree
copy, and take the smallest diff as the base version. Reproduce with
`docs/hls.js-1.6.9-faststream.patch`.

## hls.js

**Base version: 1.6.9.** Determined empirically — the in-tree file has
`const version = undefined` (the build strips it), so the version is not
recorded anywhere. Diff sizes against candidate releases:

| Release | Diff lines |
|---|---|
| **1.6.9** | **466** |
| 1.6.8 | 691 |
| 1.6.11 | 1031 |
| 1.6.12 | 1472 |
| 1.6.7 | 2984 |
| 1.6.0 | 5090 |
| 1.7.0 | 22599 |
| 1.5.x | ~38000 |

**466 lines across 22 hunks** — 276 added, 185 removed, out of 36,165 lines.
That is a 1.3% divergence, not a fork. The full patch is in
`docs/hls.js-1.6.9-faststream.patch`.

### What the 22 hunks are

**Build noise (3 hunks)** — an `/* eslint-disable */` header, `version` set
to `undefined` in two places, and the sourcemap comment removed. Not
behavioural.

**Extra exports (1 hunk, and the hardest one).** The export list is widened
to include `AACDemuxer`, `MP3Demuxer`, `MP4Demuxer`, `TSDemuxer`,
`MP4Remuxer`, `PassThroughRemuxer`, `AvcVideoParser` and `ExpGolomb`.
`chrome/player/modules/hls2mp4/transmuxer.mjs:1` imports six of these to
convert HLS to MP4 for the save-to-disk feature. **None are exported by
stock hls.js, including 1.7.1**, and the package's `exports` map only
exposes `.`, `./light` and `./dist/*` — so there is no deep-import escape
hatch to the internal modules.

**ABR abandon-rules disabled (1 very large hunk).**
`AbrController._abandonRulesCheck` is commented out wholesale. hls.js
normally watches for a fragment loading too slowly and drops quality; that
heuristic fights FastStream's whole premise of pre-buffering far ahead at up
to 6x. **This one does not need a patch** — hls.js's config accepts an
`abrController` class, so a subclass overriding `_abandonRulesCheck` with a
no-op achieves the same thing through the public API.

**`outputSamples` on the remux result (2 hunks).** The muxer's returned
object gains `outputSamples` alongside `nb`. hls2mp4 needs the samples
themselves, not just the count. **Not in 1.7.1** — `nb:
outputSamples.length` is upstream but the field is not returned.

**Upstream fixes, several already landed.** Checked against 1.7.1:

| Patch | In 1.7.1? |
|---|---|
| `notEqualAfterStrippingQueries` — tolerate CDN token rotation in segment URLs instead of erroring "media sequence mismatch" | **yes** |
| `userAgent` config plumbed through `getAudioConfig` / `initTrackConfig` | **yes** |
| `details.fragmentEnd` instead of `frag.end` for part selection | **yes** |
| `mapDateRanges` PDT fallback, `mergeDateRanges` restructure | likely |
| `ExpGolomb` scan-loop optimisation | likely |
| VTT subtitle part-loading guard (upstream #7460) | **no** |
| `httpStatus !== 0` guard before treating a fragment as a gap | **no** |

Andrew has evidently been upstreaming; the README's "I work with the
original developers" is accurate.

## Recommended approach: `pnpm patch`, not wrappers

Do **not** try to reimplement these through wrapper classes. The exports and
`outputSamples` changes have no public-API equivalent, and reimplementing a
demuxer to avoid a one-line export change would add far more risk than it
removes.

Instead ship the **official npm release plus a committed patch file**, via
`pnpm patch`. This is what pnpm's patching exists for and it satisfies what
AMO actually wants — a verifiable upstream base and an auditable,
human-sized diff:

- today: a 1.3 MB file with no stated version and no provenance
- after: `hls.js@1.7.1` from npm, hash-verifiable, plus a patch of roughly
  three hunks that a reviewer reads in ten minutes

Sequence:

1. Upgrade the base to 1.7.1 and drop every hunk that landed upstream.
2. Move the ABR change out of the patch into a `FastStreamAbrController`
   subclass passed via hls.js config — public API, no patch needed.
3. Patch only what is left: the extra exports, `outputSamples`, and the two
   unlanded fixes.
4. Offer the export change upstream. "Please export the demuxers" is a small
   ask, and if accepted the patch shrinks again.

Re-run the playback checklist in `CLAUDE.md` after each step. The HLS entry
covers this library.

## hls.worker.js

`HLSPlayer.mjs:29` sets hls.js's `workerPath` config option (official API,
default `null`) to `modules/hls.worker.js`. That file is **required**: hls.js
normally builds its worker at runtime from a `blob:` URL, and Manifest V3's
extension CSP blocks blob workers, so the worker has to be a real file inside
the package.

The old in-tree file was 325 KB with no recorded version. It was **built from
hls.js source with minification off** — not beautified from npm's minified
`dist/hls.worker.js`, since it retains meaningful names
(`requireEventemitter3`, `getDefaultExportFromCjs`) that minification destroys
and beautifying cannot restore.

It is now generated by `tools/sync-vendor.mjs` from npm's **unminified UMD**
build, `node_modules/hls.js/dist/hls.js`, applying the same transform hls.js
applies to itself: that bundle is wrapped in a
`__HLS_WORKER_BUNDLE__(__IN_WORKER__)` function which self-invokes with
`false`, and hls.js's own blob path re-invokes it with `true` behind a small
CommonJS/AMD shim. So the generator prepends that shim, flips the trailing
`(false)` to `(true)`, and drops the sourcemap reference.

Trade-off: the worker grows from 325 KB to ~1.42 MB, because the UMD bundle is
all of hls.js rather than a worker-only bundle. This is the same bundle hls.js
would use for its own blob worker. In exchange the file has a verifiable npm
base, keeps its real `version = "1.6.9"` string, and stays readable.

### Only three hunks were needed in the UMD

Of the 22 hunks patched into `dist/hls.mjs`, only code that actually executes
in the worker matters — the demuxers, remuxers and parsers. The UMD build is
ES5-transpiled, so hunks had to be ported by hand rather than reused. Three
were real:

- the `BaseVideoParser` NAL scan-loop optimisation (labelled `l1:` loop)
- `MP4Remuxer` video: `outputSamples` added to the remux result
- `MP4Remuxer` audio: the same

The rest are main-thread only (`AbrController`, `M3U8Parser`,
`BaseStreamController`, `defaultLoadPolicy`, the widened export list) and are
dead code inside a worker.

### The `userAgent` plumbing is dead code

Four of the hunks thread a `userAgent` parameter through `getAudioConfig`,
`initTrackConfig`, `AACDemuxer` and `TSDemuxer`. **It is never read.**
`userAgent` appears exactly once in `getAudioConfig`'s 71-line body — the
signature — and `initTrackConfig` accepts the parameter but calls
`getAudioConfig(observer, data, offset, audioCodec)` without passing it on.

Andrew appears to have started backporting an upstream change and stopped
half way. These hunks were therefore **not** ported to the UMD, and they
should simply be dropped when the base moves to 1.7.1, where the real version
of this change already exists.

## dash.js

**Base version: 5.1.0**, confirmed rather than assumed. The npm package is
`dashjs`, not `dash.js`, and the artifact is
`dist/modern/esm/dash.all.debug.js`. Diff sizes against candidates:

| Release | Diff lines |
|---|---|
| **5.1.0** | **3887** |
| 5.0.3 | 4286 |
| 5.1.1 | 14511 |
| 5.2.0 | 35824 |

The `dash.mediaplayer.debug.js` variant is much further away (11571), so
`dash.all.debug.js` is the right artifact.

### The divergence is real, and much larger than hls.js's

The bundle is webpack output, so every module carries its source path and can
be compared individually. That gives an exact answer instead of a line count:

| | Count |
|---|---|
| Modules in npm 5.1.0 | 432 |
| Modules in-tree | 415 |
| **Byte-identical** | **331** |
| Differing | 79 |
| Only in npm | 22 |
| Only in-tree | 5 |

Of dash.js's **own** 251 source modules, **188 are byte-identical** and 60
differ. That 75% identical figure is the important control: if the in-tree
bundle had been built with a different toolchain, *every* module would differ.
It did not, so the 60 differing modules are genuine FastStream modifications,
not build noise.

Most-modified modules, by removed lines: `MediaController` (203),
`DashManifestModel` (192), `AbrController` (183), `TimelineSegmentsGetter`
(167), `SegmentsUtils` (166), `StreamProcessor` (98), `HTTPLoader` (90),
`DashHandler` (88), `StreamController` (83), `ScheduleController` (76).
`HTTPLoader._internalLoad` is rewritten wholesale to hook FastStream's own
downloader, in the same spirit as the hls.js loader change.

The 22 modules present only in npm and 5 only in-tree are **not** FastStream
changes: they are a different version of the transitive dependency
`@svta/common-media-library`. npm's 5.1.0 bundles CMCD v2
(`CMCD_COMMON_KEYS`); the in-tree build has the older `CmcdFormatters`. That
is dependency drift baked into a bundle, and it is left alone - npm's newer
copy is kept.

### Status: migrated, provably inert

`chrome/player/modules/dash.mjs` is no longer in git. It is generated from
`dashjs@5.1.0` plus `patches/dashjs@5.1.0.patch`. A clean install reproduces
the previously vendored file **byte for byte**, and the file does not appear
in a build-output diff against the upstream baseline at all.

The patch is 354 KB, against hls.js's 31 KB. That is honest about the size of
the divergence rather than hiding it, and it still gives AMO what today's tree
does not: a hash-verifiable upstream base and a diff a reviewer can read.
Shrinking it - by checking which of the 60 modules can move to dash.js's
public extension points, or which changes have landed upstream by 5.2.1 - is
worthwhile later, but is a behaviour-affecting change and needs the playback
checklist each time.

One wrinkle worth recording: npm's bundle embeds 428 stray CR characters
inside a vendored BSD licence comment, because a bundled dependency ships CRLF
source. Diff formats cannot carry a trailing-CR-only change, so
`tools/sync-vendor.mjs` normalises line endings and guarantees a trailing
newline instead. Without that the generated file differs from the vendored one
by exactly those 428 bytes plus a final newline.

## The smaller libraries

Measuring these turned up a pattern that changes how they should be handled.
They are **stock npm builds that Andrew ran the project's own `eslint --fix`
over**, plus a small edit at the module boundary where a UMD build had to
become an ES module. The huge textual diffs are almost entirely lint autofix:
`let`->`const`, `var`->`const`, added semicolons, ternary line breaks, quote
style, and split combined `var` declarations.

Comparing **ASTs** rather than text separates the two, and is the right tool
here: it ignores whitespace, comments and quote style, so what remains is only
what can actually change behaviour.

| Library | Version | Real change beyond lint autofix | Status |
|---|---|---|---|
| pako | 2.1.0 | one line: `export const Pako = window.pako;` | **migrated** |
| fuse.js | 7.1.0 | none at all | **migrated** |
| sortablejs | 1.15.2 | named export only; plugins already mounted upstream | **migrated** |
| sweetalert2 | 11.12.4 | ESM boundary; includes a payload that must stay stripped | **migrated** |
| mp4-muxer | 4.3.3 | none - AST identical to the vendored copy | **migrated** |
| gif.js (worker) | 0.2.0 | none - AST identical; the vendored copy was only beautified | **migrated** |
| gif.js (main) | 0.2.0 | ESM wrapper + worker URL resolved from `import.meta.url` | **migrated** |
| coloris | 0.21.1, pinned commit | 9 KB patch; one deliberate bug fix on top | **migrated** |
| jswebm | 0.1.2 | generated from `src/`, 23 KB patch | **migrated** |
| vtt.js | dash.js contrib | **proven** - AST-identical to dash.js's bundle plus 3 changes | **verified** |
| mp4box | 0.5.3 (base) | **reverted** - 0.5.3 breaks MP4 playback | vendored |
| libsamplerate-js | **none published** | a wasm-filename bug fixed; see below | build not yet reproduced |
| knob | - | `jherrm/knobs`; npm `knob` is a different project | documented |
| googlevideo | ? | `LuanRT/googlevideo` | pending |

`eventemitter.mjs` is **not** a vendored library - it is FastStream's own
code and should stay in git.

### Worked examples

**pako** was stock 2.1.0 with a single appended export line. The generated
file (npm build + that line) parses to an **AST identical** to the vendored
copy, so the replacement needed no patch and no playback test - the parsed
program is provably the same.

**fuse.js** needed nothing at all: 34 AST differences, every one of them lint
autofix, and identical exports.

This is a strictly better outcome than a patch. A patch of `eslint --fix`
noise would be a thousand lines of diff that tells a reviewer nothing; using
the npm file as published, with any real change expressed as a few lines in a
documented transform, is exactly what AMO is asking for.

### mp4-muxer and gif.js: proven, not argued

These two are worth separating from the "measured" cases because the evidence
is stronger. Their vendored copies are **AST-identical** to the published
builds once the transformations the project's own `eslint --fix` performs are
normalised away:

| Normalised | What it changes |
|---|---|
| `one-var` | `var a, b` into `var a; var b` |
| `curly` | `if (x) stmt;` into `if (x) { stmt; }` |
| `quotes` | a literal's raw text, not its value |
| `no-var` / `prefer-const` | the declaration keyword |
| `indent` | whitespace *inside* a multi-line template literal |

Nothing else differed. That is a stronger claim than "the diff looks
additive", which is exactly the reasoning that shipped the mp4box regression:
the parsed program is the same program.

Finding the base for mp4-muxer needed the AST size as a search key rather than
the line count, since the vendored copy is reformatted. 4.3.3 sits between
4.3.2 and 5.0.0 by that measure and matches exactly; a line-count search would
have pointed at 5.0.0.

gif.js needed one real change. The npm build spawns its worker from
`options.workerScript`, a bare `'gif.worker.js'` that the browser resolves
against the **document**, and the extension's player page is not in that
directory. `toGifModule` rewrites the single `new Worker(...)` call to resolve
from `import.meta.url` instead. Both anchors it edits are asserted, so a
future gif.js that changes either fails the build rather than silently
shipping a module that exports nothing or spawns a worker from a 404.

Neither is covered by the playback suite - GIF export and remuxing are not on
the path a video takes - so `tests/e2e/specs/modules.e2e.mjs` drives both
directly: gif.js encodes two frames and the test checks for a `GIF89a` header,
mp4-muxer writes a container and the test checks for an `ftyp` box at offset
4. Breaking the worker URL on purpose fails the gif test and only that test.

### libsamplerate: a shipped bug, and why npm is the wrong answer

This section used to say the answer here was "use the published package".
Measuring it says the opposite, and on the way to that measurement the
resampler turned out to have never worked at all.

#### The resampler was broken in every build, including upstream's

The vendored `libsamplerate.mjs` is webpack output, and webpack emitted the
wasm reference under its content-hashed name:

```js
module.exports = __webpack_require__.p + "625941a851f0440e1705.wasm";
```

The file vendored beside it is called `libsamplerate.wasm`. Nothing sets
`Module.locateFile` or `Module.wasmBinary`, so the request 404s. The glue is
built with `BINARYEN_ASYNC_COMPILATION=0`, which means it instantiates
synchronously through a blocking `XMLHttpRequest` rather than
`WebAssembly.instantiateStreaming` - so the 404 response body was handed
straight to `WebAssembly.Module`, which rejected it:

```
at offset 4: failed to match magic number
```

Every call to `create()` threw. The same mismatch is present in upstream
v1.3.77, so this is not something the fork introduced.

It went unnoticed because of where the code sits: the resampler is reached
only from `reencoder.mjs`, which needs WebCodecs and therefore runs on Chrome
only, and only when a user re-encodes a download. Nothing on the playback path
touches it, and no test did either.

The fix is the one string literal, and it is annotated in place. With it
applied, 1 second of a 440 Hz sine resampled 48000 -> 44100 comes back as
44054 samples at peak 1.0, RMS 0.7071 and still 440 Hz.
`tests/e2e/specs/modules.e2e.mjs` now asserts exactly that, and it was watched
failing with the magic-number error before the fix.

#### Do not replace it with the npm package

The earlier recommendation assumed npm's build was the same thing with better
provenance. It is not the same thing. Measured, not estimated:

| Artifact | JS | wasm | Real WebAssembly? | Zipped total |
|---|---|---|---|---|
| vendored (Andrew's build) | 50,636 | 117,508, separate file | **yes** | **110,601** |
| npm 1.4.3 | 24,714 | 1,501,929, separate file | yes | 1,352,606 |
| npm 2.1.0 - 2.1.2 | 2,016,428, wasm inlined | none | **no** | 1,470,718 |

`@alexanderolsen/libsamplerate-js` has shipped **no WebAssembly at all** since
2.1.0. The string `WebAssembly` does not appear anywhere in its published
bundles; what is there is a wasm2js shim whose `instantiate` returns a
thenable. Upstream's own build script says why:

```sh
-s WASM=0 \        # don't generate a separate .wasm file
-s SINGLE_FILE=1 \ # inline the generated wasm
```

So migrating to npm would mean shipping **+1.36 MB compressed** - a 32%
increase on the 4.28 MB AMO zip - to replace working WebAssembly with
asm.js. That is a worse product in exchange for provenance, and the size lands
on every user whether or not they ever re-encode anything.

Version 1.4.3 is the last release with real wasm in a separate file, and it is
no cheaper: its wasm is 1.5 MB and barely compresses, because sinc coefficient
tables are incompressible float data.

#### The 117 KB is not free, and now we know what it costs

Probing each converter with a full second of audio - rather than merely
constructing one - shows where the 12x size difference went:

| Converter | Frames out for 48000 in |
|---|---|
| `SRC_SINC_MEDIUM_QUALITY` | 44054 |
| `SRC_SINC_BEST_QUALITY` | **2** |
| `SRC_SINC_FASTEST` | **2** |
| `SRC_ZERO_ORDER_HOLD` | 44100 |
| `SRC_LINEAR` | 44100 |

Two of the five sinc converters construct without error and then emit almost
nothing, which is what an absent coefficient table looks like from
JavaScript - and libsamplerate's sinc tables are exactly the megabyte-scale
static float data missing from this build. Probing them in a different order
gives the same result, so it is the build and not leaked state between
instances.

The 46-frame shortfall on the medium converter is different in kind and is not
a defect: a sinc converter cannot emit the tail it has no future input for.
`SRC_ZERO_ORDER_HOLD` and `SRC_LINEAR`, which need no lookahead, return 44100
exactly.

FastStream only ever asks for `SRC_SINC_MEDIUM_QUALITY`, so none of this
affects the product - but it does mean the vendored wasm is **not**
interchangeable with a stock build, and swapping it would silently change
resampling quality. The e2e suite now pins the three that work.

So Andrew's build is not sloppy, it is a deliberate trade: `-O3`, `-g0`, real
WebAssembly, one converter's tables, and 12x smaller than the published one.

#### What is actually left to do

Only provenance, and it is a narrower problem than it looked. The glue carries
the machine that produced it:

```js
var _scriptName = "file:///Users/andrews/Desktop/fs/libsamplerate-js/src/glue.js";
```

Mozilla's requirement for compiled code is source plus build instructions, and
those instructions are now known: upstream's `scripts/build_emscripten.sh`
with `WASM=0` changed to `WASM=1` and `SINGLE_FILE=1` to `SINGLE_FILE=0`,
against `libsamplerate.a` from `scripts/library/build_library.sh`. The
remaining work is to pin an emscripten version, run that build, and ship a
`verify:libsamplerate` that reproduces the artifact and compares hashes - the
same shape as `verify:vtt`, which is already how vtt.js is handled.

That needs Docker or an emsdk install, neither of which is set up on this
machine yet. Until it is, the honest status is: the wasm works, is proven to
work by test, and its build is documented but not yet reproduced.

### The VAD blobs: 2.8 MB, and the same problem twice

`vad/` holds the two largest files left in the tree, and both are binaries a
reviewer cannot read:

| File | Size | Status |
|---|---|---|
| `silero_vad_half.ort` | 1,856,120 B | converted from a published `.onnx` |
| `ort-wasm-simd-threaded.wasm` | 1,037,262 B | custom build; npm ships 11,241,642 B |
| `ort-wasm-simd-threaded.mjs` | 24 KB | hand-minified emscripten glue |
| `ort.wasm.mjs` | 126 KB | **generated** from onnxruntime-web@1.20.0 |

**The model.** snakers4/silero-vad publishes only ONNX - `silero_vad.onnx`,
`silero_vad_half.onnx` and four variants, plus a `.jit` and a
`.safetensors`. There is no `.ort` anywhere in that repository, and there is
no reason to expect one: `.ort` is ONNX Runtime's own serialised format,
produced by converting a `.onnx` with `convert_onnx_models_to_ort`. So the
provenance path is a two-step one, and the honest form of it is:
`silero_vad_half.onnx` (published, hash-verifiable) plus the exact conversion
command. That is the same shape as libsamplerate's problem - a published base
and a documented build - and unlike libsamplerate the base is a file anyone
can download and hash.

**The runtime.** The wasm is a tenth the size of the one onnxruntime-web
publishes, so it is a custom minimal build, and its glue was hand-minified.
Neither has a published counterpart.

**The glue's own upstream.** `vad/vad.mjs` is not first-party either: the
`Silero` class, `modelFetcher`, `frameSamples: 512`,
`positiveSpeechThreshold: 0.5` and `redemptionFrames: 8` are
ricky0123/vad-web's. That project ships `.onnx` too, never `.ort`, which
confirms the conversion is FastStream's own step - and means the JavaScript
side has a verifiable base of its own if it is ever worth pinning.

**Untested pairing.** `ort.wasm.mjs` now comes from onnxruntime-web 1.20.0
while the glue and wasm beside it do not, and nothing in the suite exercises
the VAD path. That combination has never been run end to end. It should be,
before any of the above is treated as settled.

### vtt.js: provenance proven, and re-checkable on demand

This one was expected to be the awkward case and turned out to be the
cleanest. The starting assumption in this document was wrong twice over: the
file is not a bundle of videojs/vtt.js's published `lib/`, and it is not
0.13.0.

The bundle's internal module map gives it away. It requires
`./process/parse-content.js`, `./parser/parser.js`, `./box-position.js` and
eighteen others - a nested layout that videojs/vtt.js does not have; its `lib/`
is six flat files. The layout belongs to the build **dash.js** maintains at
`contrib/videojs-vtt.js/vtt.js`, which is byte-identical across dash.js v4.7.4
through v5.1.0.

`chrome/player/modules/vtt.mjs` is that file with exactly three changes:

| Change | Why |
|---|---|
| `FONT_SIZE_PERCENT` 0.25 -> 0.05 | subtitles rendered at a fifth of dash.js's default size relative to the container |
| `processCues(window, cues, overlay, parentId)` loses `parentId` | dash.js added that parameter for its own container; FastStream did not take it |
| `if (parentId) { paddedOverlay.id = parentId; }` removed | the body of the same dash.js addition |

plus `export const WebVTT = window.WebVTT;` appended so a bundle that assigns
to a global can be imported. Note that two of the three are *removals* of
dash.js's additions - FastStream's copy is closer to videojs/vtt.js than
dash.js's own is.

Apply those to the upstream file and the result parses to the **same program**
as the vendored one.

It cannot be generated at build time: videojs/vtt.js publishes only `lib/*` to
npm, and dash.js's npm package ships only the minified `vtt.min.js`, not this
bundle. So it is *verified* instead of generated. `pnpm run verify:vtt` fetches
the upstream file, applies the three changes and asserts AST equality, and
fails with the exact point of divergence if anything moves. That is the
difference between a claim in a document and a claim a reviewer can re-run -
and it is mutation-tested, so a wrong expectation fails rather than passing
quietly.

`tools/ast-compare.mjs` is the shared normaliser this uses, now a real module
rather than a throwaway script: it undoes `one-var`, `curly`, `quotes`,
`no-var`/`prefer-const` and template-literal re-indentation, so what survives
is only what can change behaviour.

### webm.mjs is generated from jswebm's published sources

`reencoder/webm.mjs` was readable `class Track { ... }` source ending in
`window.JsWebm = JsWebm;`, whereas jswebm's npm package ships a minified
webpack bundle in `dist/`. So the vendored file was jswebm's `src/` directory
concatenated into one ES module - the same shape as mp4box.

That turned out to be good news, because jswebm publishes `src/` in the npm
tarball alongside the bundle. Comparing declaration by declaration with
`tools/compare-decls.mjs` settled it immediately: **30 of the 35 top-level
declarations were already byte-for-byte identical** to jswebm@0.1.2's sources
once eslint's autofixes were normalised away. Nothing about that is a
judgement call - either a declaration parses to the same tree or it does not.

So webm.mjs is now generated, on the same model as hls.js: the npm tarball
plus `patches/jswebm@0.1.2.patch`. Five changes are FastStream's, and a
reviewer reads them in the patch instead of taking a 104 KB file on trust:

| Change | Where | Why it matters |
|---|---|---|
| `MasteringData` and `Colour` classes added | `Track.js` | parses Matroska colour metadata, which upstream skips over |
| `case 0x55B0` builds a `Colour` | `VideoTrack.js` | upstream read the element as an integer and discarded it |
| `initVp8Headers` / `initVp9Headers` added | `JsWebm.js` | derives a full `vp09.00.10.08…` codec string; WebCodecs rejects a bare `vp9` |
| the three Vorbis setup headers are not pushed as packets | `JsWebm.js` | FastStream hands `codecPrivate` to WebCodecs itself |
| `demux()` returns whether it advanced | `JsWebm.js` | `WebMDemuxer.process()` is `while (this.demuxer.demux())` |
| `keyframe` → `keyFrame`, track looked up by number, frame length validated, `isKeyframe` on audio packets | `SimpleBlock.js` | upstream *writes* `this.keyframe` and *reads* `this.keyFrame`, so every chunk was `delta` |

The last two rows are upstream bugs rather than product changes, which is
worth saying plainly: this is a maintained fork, not a mangled copy.

After the migration all 35 declarations match. The generated file additionally
contains upstream's `UNSET` constant, which the hand-made concatenation had
dropped; it appears exactly once in the file - its own declaration - so it is
dead code, and keeping upstream's own line is preferable to inventing a rule
that deletes it.

One cost worth stating: jswebm lists `@babel/preset-env`, `lodash`,
`circular-json` and `eslint-utils` as *runtime* dependencies rather than dev
ones, which is a packaging mistake on its author's part and pulls about a
hundred packages into the dev tree. None of it ships - the build reads
`node_modules/jswebm/src/*.js` as text and nothing ever imports the package -
and the lockfile still passes the supply-chain check. It is a slower install
in exchange for a hash-verified base, which is the right way round.

`src/Chapters.js` and `src/Queue.js` stay out: the vendored file never
included them and nothing references them.

**Tested, not assumed.** `tests/e2e/specs/modules.e2e.mjs` demuxes a real VP9
file through `WebMDemuxer` and asserts the codec string, the dimensions, the
chunk count and that at least one chunk is a keyframe - which covers every
row of the table above. Removing `demux()`'s return makes it fail, verified
by doing exactly that. The fixture is transcoded from the MP4 one with ffmpeg
on first run, so no binary enters the repository.

### coloris: generated from a pinned commit, with a 9 KB patch

Two earlier claims here were wrong, and both came from searching the wrong
thing rather than from ranking the results wrongly.

First, the base was searched against `src/coloris.js`. The vendored copy uses
`var` and ends `}();`, which is babel output - it comes from
**`dist/coloris.js`**, which mdbassit builds with babel and gulp.

Second, ranking by whole-file AST size put v0.25.0 first. That is the key
failing: the vendored file is larger than *every* release, so "newest" and
"nearest" become the same answer for the wrong reason. Matching
**declaration by declaration** separates them:

| Release | Declarations identical |
|---|---|
| v0.19.0 | 29 |
| v0.20.0 | 30 |
| **v0.21.1** | **31** |
| v0.22.0 | 31 |
| v0.23.0 | 30 |
| v0.24.0 | 30 |
| v0.25.0 | 29 |

v0.21.1 and v0.22.0 tie, and one line breaks it: v0.22.0 added
`ready: DOMReady` to the exported object, which the vendored file does not
have.

**mdbassit/Coloris is not on npm** - the package literally named `coloris` is
an unrelated project and `@melloware/coloris` is a different fork - so it is
pinned as a git dependency instead. pnpm records the commit and a tarball
integrity hash in the lockfile:

```
Coloris@https://codeload.github.com/mdbassit/Coloris/tar.gz/0898dae84c3b5c538edafc557c2a671b7f230825
  integrity: sha512-pWMXd/4JNXN2L4+oY3m9KPcxf+yVQCE0f1zyLltOjG2596I++b4HnnX9gxc6csbidjwDJ0oJZESOVoLtIKZGug==
```

That is the same guarantee a registry version gives a reviewer: a fixed
artifact they can fetch and hash themselves.

FastStream's changes are in `patches/Coloris@0.21.1.patch`, 9 KB, and they
are not the cosmetic rebinding the earlier note described. They are three
features:

| Change | What it is |
|---|---|
| `document` → `container` at 19 call sites, plus `container.ownerDocument` where a real Document is needed | scopes the picker to the player's own subtree instead of the page |
| `init()` moved into `configure`'s `case 'parent'`, `container = undefined` dropped from `init`, `DOMReady(init)` disabled | the picker is built into its container when configured, not at DOMReady |
| a new `bindElement(element)`, and `case 'el'` removed from `configure` | binds one element directly instead of a selector, which is what `SubtitlesSettingsManager` needs |
| keyboard control for the hue and alpha sliders, `stopPropagation` on trapped keys, and capture-phase delegated listeners | the picker lives inside a video player that binds arrow keys and Tab of its own |

The module shape - unwrapping the UMD and exporting `Coloris` and
`bindElement` - is in `sync-vendor.mjs`, not the patch, so the package in
`node_modules` stays a valid script.

Applying all of it reproduces the vendored file exactly: **43 of 43
declarations identical, and the whole file parses to the same program.**

**One bug fixed on top.** The fork had rewritten `DOMReady` to attach its
`DOMContentLoaded` listener to `container` rather than `document`. An element
never receives `DOMContentLoaded`, and `container` is `undefined` until a
parent is configured, so any Coloris call made while the document was still
parsing would throw `TypeError: container is undefined`. It survived because
FastStream's scripts run after parsing, which makes the branch unreachable in
practice - a latent crash rather than a live one. That line is restored to
`document`, and it is now the single deliberate difference from the file this
replaces: **42 of 43 declarations identical, one fixed.**

**Tested.** `tests/e2e/specs/modules.e2e.mjs` drives the player's own picker
the way `InterfaceController` does, and asserts it renders into `.mainplayer`
rather than the document, opens on click, and writes the chosen colour back
to the bound input. Removing the patched `init()` call makes it fail,
verified by doing exactly that.

**It does not change the warning count, and that is worth being exact
about.** coloris still accounts for 7 of the 13 addons-linter warnings after
the migration; they are `UNSAFE_VAR_ASSIGNMENT` on the picker's own
`innerHTML` writes, which are upstream's code and are there whether the file
is vendored or generated. addons-linter grades the code, not where it came
from.

What the migration changes is the thing that actually got the add-on
refused: a reviewer can now fetch a pinned commit, hash it, and read a 9 KB
diff, instead of being asked to trust 40 KB of unattributed JavaScript.

### sweetalert2 ships a payload that must stay removed

Worth stating plainly, because taking the npm file naively would have
reintroduced it. Upstream sweetalert2 contains:

```js
if (typeof window !== 'undefined' && /^ru\b/.test(navigator.language) &&
    location.host.match(/\.(ru|su|by|xn--p1ai)$/)) {
  ...
  document.body.style.pointerEvents = 'none';
  var ukrainianAnthem = document.createElement('audio');
  ukrainianAnthem.src = 'https://flag-gimn.ru/wp-content/uploads/2021/09/Ukraina.mp3';
  ukrainianAnthem.loop = true;
```

For users whose browser language is Russian on a .ru/.su/.by/.xn--p1ai host,
it makes the page unusable and loops remote audio. Andrew had removed it from
the vendored copy. Three separate reasons it must stay removed: it loads
remote media from a third-party host at runtime, which fails AMO review on its
own; it disables interaction with whatever page the extension is injected
into; and it triggers on the user's locale rather than on anything they did.

`tools/sync-vendor.mjs` strips it by brace matching rather than a line range,
so it survives upstream reformatting, and the build is checked for its
absence.

### mp4box - measured, migrated, then reverted

Two corrections happened here, and both are worth recording.

**First**, an early pass concluded mp4box "is not a published dist" and was
concatenated from source. That was wrong: the version search had only tested
the ten most recent releases, which are all 2.x, and mp4box was rewritten for
2.0, so every one differs by ~16,000 lines. The search reported a floor and it
was read as a match. Testing the 0.x line is unambiguous - **base is 0.5.3**,
at 238 differing lines against 617 for 0.5.2 and 711 for 0.5.4.

**Second**, migrating to 0.5.3 was committed on the strength of that
measurement and a claim that it was safe because it only *added* two box
parsers. The end-to-end suite then failed MP4 playback, and swapping the two
files back and forth confirmed it: **the vendored copy plays, 0.5.3 does
not.** The migration was reverted.

The intermediate "the old file fails too, so the migration is exonerated"
conclusion was itself wrong - it was confounded by a 416 bug in the test
server, which was answering FastStream's overshooting Range requests with
"Range Not Satisfiable" instead of clamping them. Both files failed for that
unrelated reason, which looked like exoneration.

So mp4box stays vendored for now. What is known:

- base is 0.5.3, established by diff
- the vendored copy predates that release: it lacks the `lhvC` box parser and
  the `fLaC` sample entry
- something between that commit and the release breaks FastStream's MP4 path.
  Bisecting mp4box's history between 0.5.2 and 0.5.3 would identify it, and is
  the way to finish this migration properly
- `players/mp4/MP4Player.mjs` and `modules/dash2mp4/mp4merger.mjs` import
  `{MP4Box, DataStream}`; the vendored file exports them directly and drops
  the trailing CommonJS block

The lesson generalises: a library migration is not "provably inert" because
its diff looks additive. Only the end-to-end suite settles it.

## The two that stay vendored

vtt.js and knob total 116 KB. Neither can be generated from a published
artifact, and each for a different reason. Documenting their provenance
precisely is what a reviewer actually needs; adding a bundler to the build to
produce them from pinned commits would replace one unverifiable artifact with
another, since the reviewer would then have to trust our build pipeline
instead of Andrew's.

### vtt.js — 88 KB

Provenance is **proven and re-runnable**; see
"vtt.js: provenance proven, and re-checkable on demand" above, and run
`pnpm run verify:vtt`.

Two claims this document previously made here were wrong, and are recorded
because they show how the wrong answer was reached. It said the base was
**0.13.0** and that the file was a browserify bundle of videojs/vtt.js's
`lib/`. Both came from a line-count search across videojs/vtt.js releases,
which will always return a nearest release even when the true base is not in
the set at all. The bundle's own module map settles it: it requires
`./process/parse-content.js`, `./parser/parser.js` and eighteen more nested
paths that videojs/vtt.js's six flat `lib/` files do not have. The file is
**dash.js's `contrib/videojs-vtt.js/vtt.js`**, byte-identical across dash.js
v4.7.4 through v5.1.0, plus three changes and an export line.

Imported by `SubtitleTrack.mjs` and `ui/subtitles/SubtitlesManager.mjs`.

### knob — 28 KB

Base pinned: **jherrm/knobs `Knob.js` at `cf2db70f`** (2012-05-16), found with
`tools/find-base.mjs --commits`. Not the repository's head: the 2022 commit is
a third larger and matches far worse.

The npm package named `knob` is `mmckegg/knob`, an unrelated canvas widget,
and jherrm/knobs is not published to npm at all.

Almost all of the 278-line diff is this project's eslint autofix. The real
changes are ten, and they make it an adapted, maintained fork rather than a
transformed copy:

- the IIFE wrapper is removed and `Knob` is exported
- the constructor takes `(inputEl, callback)` instead of `(callback, options)`,
  stores the element, and throws without one; the options-merge loop and the
  `valueMin < valueMax` check are dropped with it
- a scroll gesture is added: `gestureScrollEnabled`, `angleScrollRatio`, and
  `doMouseScroll` honouring both
- HTML-slider defaults: `valueMin: 0`, `valueMax: 100`, a new `value: 0`, and
  `angleSlideRatio` 1 → 2
- `val(value)` sets by value rather than by angle, and accepts `0`
- `__determineValue` becomes `__valueFromAngles`, with a new `__validateValue`
- `__publish` writes `element.value` and dispatches a `change` event, and the
  callback loses its `angle, value` arguments
- `__angleFromValue` is a genuine **upstream bug fix**: the original tested
  `isFinite` on the angle bounds while mapping the value bounds, and
  referenced an undefined `valueMax`

Upstream: https://github.com/jherrm/knobs

### If this is ever revisited

The stronger version of this is to add each as a pinned git dependency, so
the lockfile records a commit hash, and bundle at build time. That gives a
reviewer a hash to check rather than a prose description. It costs a bundler
in the build and is worth doing only if a reviewer asks - for 153 KB across
three small, stable libraries, the documentation above is the better trade.

## youtube.js

Not yet measured. Apply the same method.
