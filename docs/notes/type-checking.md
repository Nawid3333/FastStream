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

### strict (2026-10-23)

`tsconfig.json` has `"strict": true` since 2026-10-23: `pnpm run typecheck` (CI's lint job)
fails on any value TypeScript would check as `any`, a caught value read without saying what
it is, a callback typed narrower than what calls it, and the rest of `--strict`. Every
opted-in file (`// @ts-check`, below) is held to it, so new code is typed as it is written.

How it got there, for the record. On 2026-10-22 there were 2809 untyped places and, beyond
them, 51 more `--strict` errors. They were typed file by file in batches (#530, #535, #539,
#541, #543, #547, #548, #550-#555), almost all with comments only: JSDoc and
`/** @type {T} */ (x)` casts, proven by hashing each file's syntax tree before and after
(positions and comments left out, so only comments may change). Until the count reached 0, a
ratchet (`tools/check-implicit-any.mjs` against a recorded count per file, removed with the
switch) let a file's count only fall. A handful of code lines changed where no comment could
say the truth, each doing what it did before (#555: `String()` for a `setItem`, `'0'` and
`'false'` where the browser converted a number or a boolean, two property writes no player
had), and one bug was fixed on the way (`getDataByteSize` measured a `Uint8Array` as 0).

Conventions the typing settled on, for code written from here:
- A value of one of the extension's classes gets that class (`import('./X.mjs').X`), never a
  shape made up for one file's needs; glm-5.3-flash's answers did that, and such shapes were
  wrong (a `Map` typed as an array, a player as an `HTMLVideoElement`).
- A cast states something true at that point, with the reason beside it when that is not
  obvious: "set: fragments are asked for once the player has its source", "a level ID of
  null reads the key \"null\", which no level has".
- The five players share one API: `createPlayer` returns the client's `Player` union; each
  declares its element `HTMLVideoElement` (an `<audio>` for an audio-only player, used only as
  a media element); level setters take `string|number|null`, what the client passes.
- A caught value is `unknown`: cast to `Error` where the code reads it as one, to
  `NodeJS.ErrnoException` for `.code`, to `Error|undefined` where it already guards.
- In a JS file, a field only ever `null` is widened to `any` whatever its JSDoc says (give it
  its real type, or drop it if it is never read); a field set only in a method gets
  `| undefined` unless that assignment carries a `@type`; a `@type` before the second
  declaration of a line is not seen.
- `tsconfig.json`'s lib is ES2024: Firefox 153, the floor, has all of it.

Beyond `strict`, `tsconfig.json` has `noImplicitReturns` (a function that returns a value
returns one on every path: six ended without, each meaning undefined, and say so now),
`noImplicitOverride` (a method that overrides one has `@override`), `noFallthroughCasesInSwitch`
and `noUnusedLocals` (both at 0 already). Measured and left off, as style more than bugs:
`noUnusedParameters` (249, callback parameters), `noPropertyAccessFromIndexSignature` (177),
`exactOptionalPropertyTypes` (58), `noUncheckedIndexedAccess` (687). ESLint has `eqeqeq`
(smart: `==` only against null) and `array-callback-return` since the same day; the 13
comparisons and 4 callbacks they found compared the same types, or returned nothing on
purpose, and were changed to say so.

The mpv host (`native-host/faststream-mpv-host.mjs`) was typed on 2026-10-23 (76 to 1
untyped places) with `HostVersion` 20 and `RequiredHostVersion` left at 19: a change
that alters no behaviour raises only the host's own version, so installed helpers go on
working and nobody is asked to reinstall for comments (the owner's choice).

### The libraries' own types (2026-10-22)

Each vendored library's declaration (`chrome/player/modules/*.d.mts`) re-exports the npm
package's own types (`export * from 'hls.js'`, `dashjs`, `fuse.js`, `mp4box`,
`mediabunny`); Sortable, Coloris and gif.js ship none and stay `any`. Where a package's
types fall short of its code, `types/vendor-patches.d.ts` adds the rest, each with its
reason: the APIs FastStream's patches add (dash.js's `getStreamController` and
`setCustomBitrateSelectionFunction`, mp4box's `getSampleList`), and members the code has
but the types lack (dash.js accepts an async capabilities filter, `MediaInfo.representations`,
`StreamProcessor.getRepresentation`, `getSegmentsController` and `getDashHandler`,
`SegmentsController.getAllSegments`, `DashHandler._getRequestForSegment`, a Representation's
`hasInitialization` and `hasSegments`, a FragmentRequest's `range` and `representation`;
mp4box's `seek` without `useRap`, and a sample entry's `write` into a plain DataStream, which
its code allows and its types do not). The fields FastStream's own code sets on a library's
objects are declared there too: a Representation's `processor` and a FragmentRequest's `level`
(DashPlayer), an hls.js fragment's `trackID` and `levelIdentifier` (HLSFragmentStore) and its
level details' `trackID` (HLSPlayer). hls.js's internals
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
