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
| mp4box | 0.5.3 | ESM exports; drops the trailing CommonJS block | **migrated** |
| vtt.js | 0.13.0 | browserify bundle; npm ships no bundle | documented |
| coloris | ~0.21.x | from mdbassit/Coloris, not the npm fork | documented |
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

### mp4box - a correction

An earlier pass here concluded mp4box "is not a published dist" and was
concatenated from source. **That was wrong**, and the error is worth recording
because of how it happened: the version search only tested the ten most recent
releases, which are all 2.x. mp4box was rewritten for 2.0, so every one of
those differs from the in-tree copy by ~16,000 lines, and the search reported
a floor rather than a match.

Testing the 0.x line gives an unambiguous answer. **Base version: 0.5.3**, at
238 differing lines against 617 for 0.5.2 and 711 for 0.5.4.

The divergence is the same shape as the other small libraries: an
eslint-disable header, `eslint --fix` reformatting, `var DataStream` and
`var MP4Box` turned into ES exports, and the trailing CommonJS
`exports.createFile` block removed. `players/mp4/MP4Player.mjs` and
`modules/dash2mp4/mp4merger.mjs` both import `{MP4Box, DataStream}`.

One asymmetry worth knowing: the vendored copy was built from a commit
slightly **before** the 0.5.3 release - it lacks the `lhvC` box parser and the
`fLaC` sample entry that 0.5.3 ships. Moving to the release therefore *adds*
two box types rather than removing anything, which is why this is a low-risk
change, but it is still a behavioural one and needs the playback checklist.

## The three that stay vendored

vtt.js, coloris and knob total 153 KB. None can be generated from an npm
release, and each for a different reason. Documenting their provenance
precisely is what a reviewer actually needs; adding a bundler to the build to
produce them from pinned commits would replace one unverifiable artifact with
another, since the reviewer would then have to trust our build pipeline
instead of Andrew's.

### vtt.js — 88 KB

Base: **0.13.0**, the best match across all 22 published releases (2121
differing lines, against 2241 for 0.12.x). The gap is structural rather than
modification: the in-tree file is 88 KB where npm's `lib/vtt.js` is 45 KB,
because it is a **browserify bundle** of the package - `vtt.js` plus
`vttcue.js` and `vttregion.js` - wrapped in browserify's UMD preamble.
npm publishes only the individual `lib/*` modules, never a bundle.

Upstream: https://github.com/videojs/vtt.js
Imported by `SubtitleTrack.mjs` and `ui/subtitles/SubtitlesManager.mjs`.

To regenerate: browserify `lib/index.js` from `vtt.js@0.13.0`.

### coloris — 38 KB

From **mdbassit/Coloris**, the original project, which is not published to
npm. The npm name `coloris` is an unrelated package, and
`@melloware/coloris` is a maintained *fork* that wraps the source in a
factory function and adds npm packaging - comparing against it gives 243
differing lines at its closest release (0.21.1), most of that wrapper.

FastStream's one change is that the trailing `DOMReady(init)` call is
commented out; `ui/InterfaceController.mjs` and
`ui/subtitles/SubtitlesSettingsManager.mjs` drive initialisation themselves.

Upstream: https://github.com/mdbassit/Coloris

### knob — 27 KB

From **jherrm/knobs**, GitHub only. The npm package named `knob` is
`mmckegg/knob`, an unrelated canvas-based widget. Exports a single
`Knob` constructor used by `ui/components/Knob.mjs`.

Upstream: https://github.com/jherrm/knobs

### If this is ever revisited

The stronger version of this is to add each as a pinned git dependency, so
the lockfile records a commit hash, and bundle at build time. That gives a
reviewer a hash to check rather than a prose description. It costs a bundler
in the build and is worth doing only if a reviewer asks - for 153 KB across
three small, stable libraries, the documentation above is the better trade.

## youtube.js

Not yet measured. Apply the same method.
