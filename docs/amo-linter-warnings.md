# The addons-linter warnings, one by one

`pnpm run lint:amo` reports **0 errors, 0 notices, 12 warnings** against
`build_firefox_amo`. Errors block automated validation; warnings do not. They
are advisory, and every one of them is listed here with what it is and why the
file has not been changed to silence it.

This document exists because the alternative was worse. Every remaining
warning is inside a vendored library that is now **generated from a pinned
release** or **verified against upstream**, and editing those files to quiet a
linter would undo the property this fork was built to establish: that a
reviewer can fetch the published artifact and check it. A patch that removes
an `innerHTML` write is indistinguishable, in a diff, from a patch that adds
something. The more we change, the more there is to audit, and the weaker the
claim gets.

So the position is: change first-party code where the warning has a point,
explain the rest.

## Fixed rather than explained

| Was | File | What changed |
|---|---|---|
| `UNSAFE_VAR_ASSIGNMENT` | `player/players/PlayerLoader.mjs` | `import(this.players[mode])` over a path registry became a `switch` with literal specifiers |

That one was ours, and the linter had a fair point: nothing static could see
which modules were reachable. The rewrite keeps the loading lazy — dash.js is
3.5 MB and hls.js 1.2 MB, so importing every player eagerly would pull both
into the first page load whatever the video turns out to be.

## The remaining 12

### `UNSAFE_VAR_ASSIGNMENT` x7 — `player/modules/coloris.mjs`

Lines 116, 143, 152, 164, 180, 181, 810.

`innerHTML` writes in Coloris's own UI construction: the picker skeleton, the
swatch buttons and the alpha/hue markup. The strings are template literals
built from Coloris's own configuration, not from page content or anything a
remote source controls. FastStream instantiates the picker itself with a fixed
set of swatches, so no untrusted value reaches any of them.

The file is generated from `mdbassit/Coloris` at a pinned commit plus
`patches/Coloris@0.21.1.patch`. Rewriting seven call sites to
`createElement`/`textContent` would roughly double that patch, and the patch is
the thing a reviewer reads to decide whether to trust the file.

### `UNSAFE_VAR_ASSIGNMENT` x1 — `player/modules/vtt.mjs` line 1065

`TEXTAREA_ELEMENT.innerHTML = s`, the standard idiom for decoding HTML
entities in subtitle cue text: assign to a detached `<textarea>` and read back
`.value`. A `<textarea>` does not execute or even parse markup as elements —
its content model is raw text — so this cannot run script.

This is the one file that **cannot be regenerated**: it is dash.js's
`contrib/videojs-vtt.js/vtt.js`, which dash.js publishes only minified. Its
provenance is instead proven on demand by `pnpm run verify:vtt`, which fetches
upstream, applies the three documented changes, and asserts the two parse to
the same program. Editing this line would add a fourth change to that list and
move the file further from the artifact whose identity we can demonstrate.

### `UNSAFE_VAR_ASSIGNMENT` x1 — `player/modules/vad/ort.wasm.mjs` line 1599

ONNX Runtime's own dynamic `import(url)` for its worker. The file is
**generated unmodified** from `onnxruntime-web@1.20.0` by
`tools/sync-vendor.mjs`; a reviewer can install that version and diff. Patching
it would destroy exactly that property, for a warning about a library loading
its own worker.

### `DANGEROUS_EVAL` x1 — `player/modules/dash.mjs` line 85152

webpack's runtime global detection, in full:

```js
if (typeof globalThis === 'object') return globalThis;
try {
  return this || new Function('return this')();
} catch (e) {
  if (typeof window === 'object') return window;
}
```

Unreachable twice over. `globalThis` has existed in every Firefox since 65, so
the first line returns. Even if it did not, `this` is truthy at module scope in
a classic script, and the `new Function` is inside a `try` whose `catch` falls
back to `window` — which is what would happen under this extension's CSP,
since `script-src 'self' 'wasm-unsafe-eval'` does not permit `eval`.

Verified, not assumed: this is the only eval-like construct in a 3.5 MB
bundle, and DASH playback is covered end to end by
`tests/e2e/specs/playback.e2e.mjs`.

### `DANGEROUS_EVAL` x1 — `player/modules/sweetalert.mjs` line 3685

```js
result[paramName] = new Function('return '.concat(value))();
```

sweetalert2's parser for its declarative `data-swal-*` HTML attribute API,
which reads attribute values off elements the *page author* wrote. FastStream
never uses that API — every dialog is constructed programmatically — so the
function containing this line is never called. Under the extension CSP it
would throw rather than evaluate anything.

Generated unmodified from `sweetalert2@11.12.4`.

### `UNSUPPORTED_API` x1 — `player/modules/gif/gif.mjs` line 26

`platform.name`, from the browser-detection shim bundled inside gif.js 0.2.0.
`UNSUPPORTED_API` means the linter does not recognise the property, not that
anything is broken; it is reading a bundled library's own object, not a
WebExtension API. GIF export is covered by
`tests/e2e/specs/modules.e2e.mjs`, which encodes a real GIF and checks its
header.

## Why not just patch them all

Because the count is not the goal. Upstream FastStream passed the automated
linter and was rejected anyway, over vendored libraries a reviewer could not
verify. Twelve advisory warnings on files that are now pinned, generated and
diffable is a far better position than zero warnings on files that have been
hand-edited again — which is where the last submission started.
