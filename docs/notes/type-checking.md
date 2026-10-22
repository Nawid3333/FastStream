# Type checking

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Type checking

`tsconfig.json` type checks without emitting. `checkJs` is off; files opt in
with `// @ts-check` on line 1 (line 2 after a shebang). `pnpm run typecheck` is
gated in CI, and `tests/unit/typeChecked.test.mjs` lists the opted-in files: taking
the comment out of one, or opting one in without listing it, fails it (T5's ratchet).

Opted in: `background.mjs` (2026-10-01) and the rest of `chrome/background/` but
`NetRequestRuleManager` (1 error), `DownloadFilename` (1) and `StreamLengths` (3),
`StreamLength`, and the mpv host (`native-host/faststream-mpv-host.mjs`). Since
2026-10-04 also the files of `chrome/player/enums`, `network` and `utils` that checked
clean as they were: the six enums, `DownloadEntry`, `OpQueue`, `AudioUtils`,
`SubtitleSyncUtils` and `URLUtils` (22 files in all). The rest of those folders have 1 to
18 errors each, mostly values that may be null (`FastStreamArchiveUtils` 4, which
TypeScript 7 reports and 6 did not); `UpdateChecker` is clean but starts with a SPLICER
directive and was left alone. The types are Chrome's (`@types/chrome`,
which matches the `chrome.*` calls, callbacks included) plus Node's (the host, tests
and tools), and `types/firefox-chrome.d.ts` adds the Firefox-only fields read here
(`cookieStoreId`). background.mjs's own fixes were JSDoc, a few
`undefined` checks that return what the code returned before (through a throw), and
one guard: a message from a page outside any tab is no longer handled as a tab's. The
player's files are next; fix what tsc reports only with the playback suites to hand.

Since 2026-10-22 (#523) every own script under `chrome/`, `native-host/` and `tools/` has
`// @ts-check`: 192 files, counted that day with `head -2 | grep @ts-check` over
`git ls-files`, the vendored libraries left out.

### noImplicitAny, file by file (2026-10-22)

`noImplicitAny` stays off in `tsconfig.json`: with it, 2725 places were untyped on
2026-10-22 once the first 29 files were typed, each a value TypeScript checks as `any`. They are typed with comments only
(JSDoc and `/** @type {T} */ (x)` casts), proven by hashing each file's syntax tree
before and after (positions and comments left out, so only comments may change).
`pnpm run typecheck:strict` (`tools/check-implicit-any.mjs`, a step of CI's lint job) is
the ratchet: it runs `tsc --noEmit --noImplicitAny` and compares each file's error count
with `types/implicit-any.json`. A count above the record fails, and so does a file the
record leaves out (at 0, or new) with any error; a count below it fails until the record
is lowered with `pnpm run typecheck:strict -- --update`, so a typed file cannot go back
unnoticed. `tests/unit/checkImplicitAny.test.mjs` covers the rules (each broken once, and
caught), and an untyped parameter planted in a file at 0 failed the check with its line.

The mpv host (`native-host/faststream-mpv-host.mjs`, 76 untyped places) is left out on
purpose: any change to it raises `HostVersion` and `RequiredHostVersion`, and the add-on
then has every user reinstall the helper, for comments that change no behaviour. It is
typed the next time it changes for a real reason; until then the ratchet holds its count.

### The libraries' own types (2026-10-22)

Each vendored library's declaration (`chrome/player/modules/*.d.mts`) re-exports the npm
package's own types (`export * from 'hls.js'`, `dashjs`, `fuse.js`, `mp4box`,
`mediabunny`); Sortable, Coloris and gif.js ship none and stay `any`. Where a package's
types fall short of its code, `types/vendor-patches.d.ts` adds the rest, each with its
reason: the APIs FastStream's patches add (dash.js's `getStreamController` and
`setCustomBitrateSelectionFunction`, mp4box's `getSampleList`), and members the code has
but the types lack (dash.js accepts an async capabilities filter, `MediaInfo.representations`,
`StreamProcessor.getRepresentation`; mp4box's `seek` without `useRap`). hls.js's internals
that the patch exports (`TSDemuxer` and the other demuxers and remuxers) are not in its
types and stay `any`. A class the package declares but does not export by name is reached
through one it does: mp4box's trak box is `ISOFile['moov']['traks'][number]`. With the
real types, 44 places failed the normal check, none of them a bug: dash.js and mp4box
fields set at runtime, values the code knows are set (a stream is active in dash.js's
stream events), and members hls.js's types call private or protected. They were fixed with
casts and declarations only (syntax trees unchanged), and 51 untyped places went with
them (2597 to 2546).

What the review of glm-5.3-flash's typing answers found (2026-10-22): its types pass
the checks and can still be false. It wrote its own shape for another file's class (a
`Client` with the members one file uses) where the real class is the type
(`import('../../FastStreamClient.mjs').FastStreamClient`), and such a shape had a `Map`
of `VideoLevel`s as an array and FastStreamClient's player as an `HTMLVideoElement`;
`{Object}` in JSDoc is `any` without the flag and `Object` with it. A parameter's type
is read from its callers too: `setStatusMessage(key, null)` makes it `string|null`.

`types/messages.d.ts` describes the cross-context message contracts. Add a
message only after reading its real payload; an inaccurate type is worse
than an absent one.

Use `@types/chrome` — the codebase uses `chrome.*` in 136 places and does
not use webextension-polyfill at all.
