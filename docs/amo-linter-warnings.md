# The addons-linter warnings, one by one

`pnpm run lint:amo` reports **0 errors, 0 notices, 4 warnings** against
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
change vendored code through `patches/` where the fix is genuinely safe and
worth the audit cost, explain the rest.

## Fixed rather than explained

| Was | File | What changed |
|---|---|---|
| `UNSAFE_VAR_ASSIGNMENT` | `player/players/PlayerLoader.mjs` | `import(this.players[mode])` over a path registry became a `switch` with literal specifiers |
| `UNSUPPORTED_API` | `player/modules/gif/gif.mjs` line 26 | renamed a function-scoped variable that happened to be called `browser` (see below) |
| `UNSAFE_VAR_ASSIGNMENT` x5 | `player/modules/coloris.mjs` lines 143, 152, 164, 180, 181 | `innerHTML` → `textContent` for four static-label writes (see below) |
| `UNSAFE_VAR_ASSIGNMENT` | `player/modules/coloris.mjs` line 116 | the swatch-list builder rewritten to `createElement`/`setAttribute`/`textContent` (see below) |
| `DANGEROUS_EVAL` | `player/modules/sweetalert.mjs` line 3685 | the `new Function(...)` call replaced with an explanatory `throw` (see below) |

**gif.js's `UNSUPPORTED_API` was a scope-blind false positive, not a
workaround.** The flagged line was `browser.platform[browser.platform.name] =
true` inside a bundled UA-sniffing helper that declares its own
function-scoped `var browser`, entirely unrelated to the WebExtensions
`browser` global. Whatever powers addons-linter's
`webextension-unsupported-api` check does not appear to do scope analysis, so
it matched the property chain regardless. Confirmed empirically: renaming the
local variable to `browserInfo` (a plain word-boundary rename, scoped to just
that one bundled module in `patches/gif.js@0.2.0.patch`) made the warning
disappear on a real `lint:amo` run, with the count dropping by exactly one and
nothing else changing. `module.exports` still returns the same shaped object,
so nothing downstream can observe the rename.

**Coloris's five label writes were genuinely static, not just low-risk.**
`clearButton.innerHTML = settings.clearLabel`, `closeButton.innerHTML =
settings.closeLabel`, and the two `a11y.open`/`a11y.swatch` writes all read
Coloris's own built-in defaults — confirmed by checking
`InterfaceController.mjs`'s actual `Coloris({...})` call, which passes
`parent`, `theme`, `themeMode`, `formatToggle`, `swatches`, `alpha`, and
`focusInput`, never `clearLabel`, `closeLabel`, or `a11y`. `textContent` is an
exact behavioural match for plain-text labels and strictly safer if a future
caller ever does pass something dynamic through them. Patched in
`patches/Coloris@0.21.1.patch`.

Making this patch caught a real mistake: recreating it via a second `pnpm
patch`/`pnpm patch-commit` cycle from a **pristine** copy silently dropped the
existing patch (the one that lets the picker render inside the player at
all), since `pnpm patch` hands back the pristine package, not the
already-patched one — confirmed by checking, not assumed, since it did the
opposite the very next time it was used for a different package. `pnpm run
test:e2e` caught the resulting breakage immediately: not just the
colour-picker test but all three playback tests failed too, because
`InterfaceController` calls `Coloris(...)` during its own construction and an
uncaught error there aborted the rest of player setup.

**sweetalert2's eval was real but dead code.** `new Function("return
".concat(value))()` only runs when a `Swal` is configured through a
`<template>`-based `swal-function-param` element instead of the JS options
object. FastStream never uses that API — zero matches anywhere in the
codebase for the markup it requires — and `getTemplateParams` bails to `{}`
before reaching it unless `params.template` is set. Even if that were wrong,
`build_firefox_amo/manifest.json`'s CSP is `script-src 'self'
'wasm-unsafe-eval'` with no `unsafe-eval`, so the call would throw a CSP
violation the moment it executed, regardless of caller. Patched (in
`patches/sweetalert2@11.12.4.patch`) to throw an explanatory error instead —
the same unreachability as before, with the AST pattern the linter flags
removed and the reason made explicit for anyone who goes looking.

**The swatch list needed real DOM construction, not a property swap, and got
it.** The original built one `<button>` per configured swatch color by string
concatenation — `swatch` (a literal like `'rgb(255,255,255)'`) landed in both
the `style="color: ..."` attribute and the button's text — then joined and
assigned the lot to `innerHTML`. `textContent` cannot replace this the way it
could for the five label sites, since the assignment is real markup, not
text. Rewritten instead to build each button with `createElement`,
`setAttribute` for `type`/`id`/`aria-labelledby`, direct `.style.color`
assignment (which the CSSOM validates rather than parses as markup), and
`.textContent` for the visible label, replacing the wrapper's children with
`replaceChildren` instead of an `innerHTML` join. Patched in
`patches/Coloris@0.21.1.patch`.

`tests/e2e/specs/modules.e2e.mjs`'s colour-picker test was extended to check
this directly — it now asserts all 6 of FastStream's configured swatches
render as buttons, and that the first one's text and `style.color` match
`rgb(255,255,255)` — rather than relying on "the picker still opens" to imply
the swatch row rendered correctly too.

## The remaining 4

### `UNSAFE_VAR_ASSIGNMENT` x1 — `player/modules/coloris.mjs` line 810

The picker's own ~40-line template literal — the inputs, sliders, buttons and
a11y labels that make up the whole widget skeleton, assigned to `innerHTML`
in one `picker.innerHTML = "..." + "..." + ...` statement. `textContent` is
not a valid swap here either, for the same reason as the swatch list: this
assigns real structure, not text. Unlike the swatch list, rewriting this one
into `createElement` calls means reproducing roughly 40 elements' worth of
tags, classes, ids and attributes by hand, for code that renders the entire
widget rather than one repeated, easily-verified pattern — a meaningfully
bigger and more error-prone change for the same single warning. Left rather
than rushed; a candidate for a future, dedicated pass with its own test
coverage rather than folded into cleanup that also touched five other sites.

### `UNSAFE_VAR_ASSIGNMENT` x1 — `player/modules/vtt.mjs` line 1065

`TEXTAREA_ELEMENT.innerHTML = s`, the standard idiom for decoding HTML
entities in subtitle cue text: assign to a detached `<textarea>` and read
back `.textContent`. This is safe by construction, not just low-risk: the
HTML spec gives `<textarea>` an RCDATA content model, so assigning to its
`innerHTML` can never create an element or run a script no matter what the
string contains — the entire value always becomes exactly one text node.

Confirmed that addons-linter cannot be told this either: an inline `//
eslint-disable-next-line no-unsanitized/property` on this exact line was
tested and made no difference to the warning count, so whatever runs this
check does not honour inline directives — a sensible choice for a review
tool, since otherwise a maintainer could always just disable the finding.
`DOMParser().parseFromString(s, 'text/html')` was considered as a rewrite and
rejected: unlike a textarea's RCDATA parsing, `'text/html'` parsing genuinely
constructs real elements (just detached from any document), which is a
weaker guarantee resting on browsers not fetching resources for a detached
document, rather than on what the parser is spec-required to produce. That
would be a safety downgrade dressed up as a fix.

This is also the one file that **cannot be regenerated**: it is dash.js's
`contrib/videojs-vtt.js/vtt.js`, which dash.js publishes only minified. Its
provenance is instead proven on demand by `pnpm run verify:vtt`, which fetches
upstream, applies the three documented changes, and asserts the two parse to
the same program. Editing this line would add a fourth change to that list
for a warning that isn't pointing at a real problem.

### `UNSAFE_VAR_ASSIGNMENT` x1 — `player/modules/vad/ort.wasm.mjs` line 1599

ONNX Runtime's own `await import(url)` (`webpackIgnore`d), part of its
proxy-worker mechanism: `dynamicImportDefault` imports a module from a URL
that was itself built two lines earlier from a same-origin `fetch` and
`URL.createObjectURL`. The file is **generated unmodified** from
`onnxruntime-web@1.20.0` by `tools/sync-vendor.mjs`; a reviewer can install
that version and diff. Generated emscripten/onnxruntime-web glue is not
something to hand-patch line by line — the correct lever, if this needed to
change, is the build flags in `tools/reproduce-ort-wasm.sh` and the npm
release pin, not this file.

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

Unreachable twice over. `globalThis` has existed in every Firefox since 65,
so the first line returns. Even if it did not, `this` is truthy at module
scope in a classic script, and the `new Function` is inside a `try` whose
`catch` falls back to `window` — which is what would happen under this
extension's CSP, since `script-src 'self' 'wasm-unsafe-eval'` does not permit
`eval`. This is webpack's own generated bootstrap preamble (the `/******/`
comment prefix is webpack's own marker, not this project's), present
verbatim in effectively every webpack bundle ever shipped.

Verified, not assumed: this is the only eval-like construct in a 3.5 MB
bundle, and DASH playback is covered end to end by
`tests/e2e/specs/playback.e2e.mjs`.

## Why not just patch them all

Because the count is not the goal. Upstream FastStream passed the automated
linter and was rejected anyway, over vendored libraries a reviewer could not
verify. Four advisory warnings on files that are pinned, generated, diffable,
or safe by construction is a far better position than zero warnings on files
that have been hand-edited past the point of easy review — which is where the
last submission started. Where a fix was genuinely safe and worth that audit
cost (gif.js, six of Coloris's seven sites, sweetalert2), it was made; where
it was not, the reasoning is written down instead of a diff nobody asked for.

## The GitHub self-host build has more, and does not need fewer

`pnpm run lint:github` — the build distributed outside AMO, which is the one
target that keeps YouTube support — currently reports **0 errors, 0 notices,
10 warnings**. It is not held to the same bar as `lint:amo` on purpose: this
build is never submitted to Mozilla, so nothing here affects AMO review. It
is worth a short note anyway, since some of it looks alarming out of context.

- **4 of the 10** are the coloris/vtt/ort.wasm/dash items above, present in
  both builds for the same reasons (patches apply to the shared
  `chrome/player/modules/` source both targets splice from).
- **3 `ANDROID_INCOMPATIBLE_API`** (`permissions.request`, `userScripts.*`) —
  expected. This extension has no `gecko_android` entry and does not target
  Firefox for Android; these fire because the desktop APIs used simply are
  not implemented there, not because of anything to fix.
- **1 `UNSUPPORTED_API`** on `userScripts.register` (`background.mjs` line
  627) is a false positive from an overloaded API name, confirmed by reading
  addons-linter's own compat schema: it defines two `register` entries, one
  `max_manifest_version: 2` (single object, callback-based) and one
  `min_manifest_version: 3` (array argument, promise-based). FastStream's
  call — `await chrome.userScripts.register([script])` — matches the MV3
  shape exactly, but the static scanner flags the name against the MV2 entry
  regardless of which overload the call site actually matches.
- **1 `DANGEROUS_EVAL`** in `userscripts/yt_runner.js` is real, active, and
  necessary: it is a `postMessage`-driven bridge that runs
  `new Function(...argNames, body)()` inside an isolated `USER_SCRIPT` world
  injected into a same-origin `youtube.com` frame, used by
  `SandboxedEvaluator`/`chrome/player/modules/yt.mjs` to execute YouTube's own
  obfuscated challenge-solving JavaScript — the same requirement every
  third-party YouTube client (yt-dlp, youtube.js, etc.) has, since YouTube
  deliberately makes this undecipherable without running their code. It is
  scoped as tightly as that requirement allows: `configureWorld` sets
  `'unsafe-eval'` only for this one isolated world (not the extension's own
  CSP, which stays eval-free), and the listener only accepts messages whose
  `event.source` is the frame's own parent. **This entire code path is
  already spliced out of the AMO build** by the pre-existing
  `SPLICER:NO_YOUTUBE` markers — `dropYoutubeContentScript` in `build.mjs`
  removes it from `build_firefox_amo` outright, which is why none of this
  shows up in `lint:amo`'s 4. It is documented here rather than in the AMO
  section above because it never reaches AMO review at all.
- **`MISSING_DATA_COLLECTION_PERMISSIONS`** is deliberately not added to this
  build. Adding `data_collection_permissions` was tested directly: it needs
  Firefox 140+ (142+ for Android), higher than the 136 this build's manifest
  actually requires for `userScripts`, and adding it while staying at 136
  replaced one warning with two version-mismatch ones instead — a net
  increase in the warning count, not a decrease. The field only matters for
  AMO's own submission policy — Firefox itself does not require it to load a
  self-hosted `.xpi` — so bumping the floor
  just to add a field this build gets no benefit from was rejected in favour
  of keeping the wider compatibility range.
