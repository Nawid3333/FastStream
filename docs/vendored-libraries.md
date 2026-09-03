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

## dash.js and youtube.js

Not yet measured. dash.js reports `VERSION = '5.1.0'` in-tree, so its base
is known without searching. Apply the same method.
