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

`types/messages.d.ts` describes the cross-context message contracts. Add a
message only after reading its real payload; an inaccurate type is worse
than an absent one.

Use `@types/chrome` — the codebase uses `chrome.*` in 136 places and does
not use webextension-polyfill at all.
