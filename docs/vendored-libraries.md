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
| sortablejs | 1.15.2 | mounts Swap + MultiDrag plugins; exports the function directly instead of `export default` | measured |
| sweetalert2 | 11.12.4 | injects `import {DOMElements}`; replaces the UMD global assignment with `export const SweetAlert = swl;` | measured |
| sweetalert2 | 11.12.4 | see below - includes a payload that must stay stripped | **migrated** |
| sortablejs | 1.15.2 | named export only; plugins already mounted upstream | **migrated** |
| mp4-muxer | 4.3.3 | none - AST identical to the vendored copy | **migrated** |
| gif.js (worker) | 0.2.0 | none - AST identical; the vendored copy was only beautified | **migrated** |
| gif.js (main) | 0.2.0 | ESM wrapper + worker URL resolved from `import.meta.url` | **migrated** |
| mp4box | 0.5.3 (base) | **reverted** - 0.5.3 breaks MP4 playback | vendored |
| vtt.js | dash.js contrib | **proven** - AST-identical to dash.js's bundle plus 3 changes | **verified** |
| coloris | not pinned | upstream unwrapped from its IIFE; no release matches exactly | **open** |
| libsamplerate-js | **none** | built on the author's own laptop - see below | **blocker** |
| jswebm | src, not dist | `webm.mjs` is the **source** concatenated, not the published bundle | **open** |
| knob | — | `jherrm/knobs`; npm `knob` is a different project | documented |
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

### libsamplerate is the remaining provenance blocker

`reencoder/libsamplerate.mjs` matches no published artifact, and there is
direct evidence why. Its emscripten glue carries the absolute path of the
machine that produced it:

```js
var _scriptName = "file:///Users/andrews/Desktop/fs/libsamplerate-js/src/glue.js";
```

It was built on the author's own computer. The wasm beside it is consistent
with that: 117,508 bytes against the 1,501,929 bytes that
`@alexanderolsen/libsamplerate-js` publishes for the same library.

This is the hardest remaining AMO problem in the tree - harder than coloris or
knob, which are readable JavaScript from public repositories. It is a **binary
blob with no published counterpart**, which is precisely what a reviewer
cannot verify. It needs a decision rather than more measurement:

1. **Use the published package.** Full provenance, at roughly +1.4 MB, since
   the npm wasm is a much less optimised build.
2. **Reproduce the build.** Keep the size, and publish the exact emscripten
   version and flags so a reviewer can rebuild it. Cheaper in bytes, more work
   to document, and only as good as the reproducibility.

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

### coloris: base pinned to v0.21.1, and the adaptation is enumerable

An earlier note here said the base was "closest to v0.22.0 by statement
matching" and that none of v0.19.0-v0.25.0 matched. Two corrections.

First, the search was looking at the wrong file. The vendored copy uses `var`
and ends `}();`, which is babel output - so it comes from `dist/coloris.js`,
not `src/coloris.js`. mdbassit/Coloris builds its dist with babel and gulp.

Second, ranking by AST size gets this one wrong. Size put v0.25.0 first, but
only because the vendored file is larger than *every* release, which makes
"newest" and "nearest" the same answer for the wrong reason. Matching
**declaration by declaration** separates them properly:

| Release | Declarations identical |
|---|---|
| v0.19.0 | 29 |
| v0.20.0 | 30 |
| **v0.21.1** | **31** |
| v0.22.0 | 31 |
| v0.23.0 | 30 |
| v0.24.0 | 30 |
| v0.25.0 | 29 |

v0.21.1 and v0.22.0 tie, and one line breaks the tie: v0.22.0 added
`ready: DOMReady` to the exported object, which the vendored file does not
have. So the base is **mdbassit/Coloris v0.21.1, `dist/coloris.js`**.

The remainder is small and entirely accounted for: **31 declarations
identical, 10 differing, 2 added, and none of upstream's missing.** The ten
are all the same adaptation - `document` rebound to a `container` element so
the picker queries and listens inside FastStream's own subtree:
`getEl`, `addListener`, `DOMReady`, `updatePickerPosition`, `wrapFields`,
`bindFields`, `pickColor`, `updateColor`, `init`, `configure` (which also
gained the `container` setting). The two additions are the export shape:
`bindElement` exposed, and `Coloris` itself.

That is a documentable provenance rather than an unexplained blob, which is
what AMO asks for. Going further - a pinned git dependency plus a patch, as
webm.mjs now has - is possible because the repository carries a `package.json`
with `main: dist/coloris.js`, so pnpm would record the commit hash. It is
worth doing: coloris accounts for **7 of the 15 remaining addons-linter
warnings**, more than any other file. What it needs first is a test, because
nothing in the suite currently touches the colour picker.

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

## The three that stay vendored

vtt.js, coloris and knob total 153 KB. None can be generated from an npm
release, and each for a different reason. Documenting their provenance
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

### coloris — 40 KB

Base pinned: **mdbassit/Coloris v0.21.1, `dist/coloris.js`**. See
"coloris: base pinned to v0.21.1" above for how it was settled and what the
remaining ten functions change.

Upstream: https://github.com/mdbassit/Coloris

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
