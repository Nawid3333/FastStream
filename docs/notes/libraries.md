# Vendored libraries

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Vendored libraries

hls.js is the npm release, **1.7.3**, plus `patches/hls.js@1.7.3.patch` (the extra
demuxer exports, `outputSamples` on the remux result and the VTT part-loading guard, all in
`dist/hls.mjs`), which pnpm applies at install; the playback worker is hls.js's own
`dist/hls.worker.js`, unpatched (2026-10-22); dash.js is `dashjs@5.2.1` with its patch the same way. The
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
| `remux/mediabunny.mjs` | **Mediabunny 1.60.0**, MPL-2.0 (file-level: shipped unmodified, its licence header kept) | `mediabunny@1.60.0` |

Until 2026-10-10 the table also had ONNX Runtime Web (`vad/ort.wasm.mjs` and its wasm)
and the Silero VAD model, the speech detector's: they went with it. (`ort.wasm.mjs` had
carried the comment "Minified to reduce loading time (https://minify-js.com/)" - minified
by hand, the modified-third-party-library problem AMO objects to - and shipped as the
npm dist from 2026-09-30.)

## sortablejs: what checks it (2026-10-20)

The control bar is three sortablejs lists in one group (`ui/ToolManager.mjs`: left, right and
the "more" menu); its onEnd saves the order as `toolSettings`, and the next player sorts the
tools by it. sortablejs ships as npm publishes it (`tools/sync-vendor.mjs` adds only the named
export) and moves with Dependabot's weekly `shipped-minor-and-patch` group. Until this date
nothing dragged a tool in any test, so that group's PR could be green with the rearranging
broken. `tests/e2e/specs/toolbar-reorder.e2e.mjs` (the web suite) drags a tool along the right
list, from the right list to the left one, and into the "more" menu in the reorder mode a long
press opens (a real WebDriver press, held until the mode shows), and checks the bar, the saved
`toolSettings` and the next player's bar.

- **Firefox's WebDriver starts a drag and never ends it.** sortablejs uses native drag and
  drop on desktop Firefox (the press sets `draggable`; dragstart, dragover, then drop or
  dragend). Measured on CI run 39477097683 (Firefox 158.0.1, Linux and Windows, a temporary
  probe spec, three ways: one move of 1 s, small steps, the button let go in a later action):
  WebDriver's pointer actions gave the page pointerdown, mousedown, pointermove, dragstart,
  pointercancel and then dragenter, dragover and dragleave as the pointer moved, and sortablejs
  moved the tool; letting go gave no drop, no dragend and no mouseup. ToolManager stayed in its
  drag (`userIsReordering`) and nothing was saved. Where the tool had got to depended on the
  pointer's path (one move: before the target; small steps: after it). Mozilla's bug 1515879
  (open) is this. So `tests/e2e/toolbarDrag.mjs` dispatches the drag's events in the page, in
  that order, at the points on screen, to what is under them, and lets go with drop and
  dragend. A spec that needs another HTML5 drag can use it the same way.
- **The player keeps dragover and drop to itself.** `.mainplayer` stops every dragenter and
  dragover (InterfaceController) and every drop (SaveManager's file drop) from bubbling, so
  sortablejs's listeners on `document` never hear them: its list elements take the dragovers
  first, and a toolbar drag ends on dragend on the tool. Measured with the mutation run below:
  with dragend ignored, no drag ended.
- **What it catches, measured** (CI runs 39477097683 and 39478781184, Linux and Windows, a
  temporary spec: sortablejs's functions replaced in the page one way at a time, the spec's
  steps run along and across the bar): dragover doing nothing (the order check), dragend
  ignored and onEnd never called ("never ended the drag"), a press that prepares no drag ("not
  draggable"), a drop on the pointercancel that comes with every native drag's start ("never
  started the drag"), and a group that takes nothing from another list (across the bar only;
  along it there is nothing to catch). Each failed the spec's steps; none was retried. Not
  tried, read from the imports: a release whose module does not load stops the whole player
  (main.mjs reaches ToolManager.mjs through FastStreamClient and InterfaceController), and
  every spec that opens it fails. Not caught: a break only in Firefox's own turning of mouse
  moves into drag events, or only in the dragovers of a long pointer path.
