# Vendored libraries

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Vendored libraries

hls.js is the npm release, **1.7.3**, plus `patches/hls.js@1.7.3.patch` (the extra
demuxer exports, `outputSamples` on the remux result and the VTT part-loading guard),
which pnpm applies at install; dash.js is `dashjs@5.2.1` with its patch the same way. The
in-tree hls.js they replaced was 1.6.9 with 466 lines of divergence across 22 hunks (1.3%),
not a fork; that diff is kept as `docs/hls.js-1.6.9-faststream.patch`. See
[docs/vendored-libraries.md](docs/vendored-libraries.md) for the hunk classification.

Do not try to replace these with wrapper classes — the extra demuxer exports
that `hls2mp4/transmuxer.mjs` needs have no public-API equivalent in any
hls.js release, including 1.7.1.

## The binary blobs are identifiable published artifacts

Not mystery blobs — every one has a known upstream, version and licence, so
they belong in the Phase 7 npm migration rather than being removed:

| File | What it is | npm |
|---|---|---|
| `vad/ort.wasm.mjs` + `ort-wasm-simd-threaded.mjs` + `ort-wasm-simd-threaded.wasm` | **ONNX Runtime Web 1.30.0**, Microsoft, MIT | `onnxruntime-web@1.30.0` |
| `vad/silero_vad_half.onnx` | Silero VAD model, `.onnx`, MIT | published model, silero-vad tag v6.2.1 |
| `remux/mediabunny.mjs` | **Mediabunny 1.60.0**, MPL-2.0 (file-level: shipped unmodified, its licence header kept) | `mediabunny@1.60.0` |

`vad/LICENSE.md` is already in-tree. **`ort.wasm.mjs` carried the comment
"Minified to reduce loading time (https://minify-js.com/)"** — Andrew
minified it by hand, which is precisely the modified-third-party-library
problem AMO objects to. It has shipped as the npm dist since (all three ONNX
Runtime files, since 2026-09-30).

VAD is lazily loaded via dynamic `import()` from
`analyzer/AudioAnalyzerNode.mjs:63`, so it only costs anything when the
audio analyzer runs.
