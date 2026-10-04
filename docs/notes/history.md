# What was removed, and upstream bugs fixed here

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## YouTube removal

Removed entirely (2026-09-10), from every build target, not just
`firefox-amo`'s old `NO_YOUTUBE` splice. Deleted outright: `YTPlayer.mjs`,
`SandboxedEvaluator.mjs`, `yt.mjs`, `googlevideo.mjs`, `yt_runner.js`,
`custom/yt_content.js`, `YoutubeClients.mjs`. Stripped from shared files:
`PlayerModes.ACCELERATED_YT` and every branch on it (`PlayerLoader.mjs`'s
`switch` — the only one over `PlayerModes` in the codebase — plus guards in
`URLUtils.mjs`, `main.mjs`, `FastStreamClient.mjs`, `background.mjs`,
`SourcesBrowser.mjs`, `InterfaceController.mjs`, `DownloadManager.mjs`,
`AlertPolyfill.mjs`), the `userScripts` permission and its
`chrome.userScripts.configureWorld(...)` runtime CSP grant, and the YouTube
autoplay/player-ID options UI. `CENSORYT` and `NO_YOUTUBE` splice targets are
gone from `build.mjs` — both only ever guarded YouTube-only content, so
they're dead once that content doesn't exist.

One accepted behavior change: `background.mjs`'s `onSourceRecieved` used to
return early on youtube.com pages unless the detected mode was
`ACCELERATED_YT`, to keep generic HLS/DASH detection from misfiring on
YouTube's own internal manifests. That guard is gone too — generic detection
now runs unmodified on youtube.com pages like any other site. Low-stakes:
YouTube's real manifest URLs are signed/obfuscated, not the plain URLs this
detection looks for.

## Known upstream bugs fixed here

- **"Auto-enable URLs" parsing** (review, 2026-09-28): the background had its own
  parser for the list. A `-domain` line - "You can now exclude specific domains by
  prepending -" (upstream #241, still open there) - set `domain` but left `match`
  null and was dropped, so the site was neither excluded from auto-enable nor from the
  "Use player to load" redirect rule's `excludedRequestDomains`; a lone `~` became the
  empty regex and auto-enabled every site. The list is now a
  `UrlMatchList({domainEntriesExclude: true})` (a `-domain` entry is an exclusion there,
  a plain hostname match in the MPV allowlist), matched case-insensitively like the
  allowlist, and `options_autourl_body` documents `-`. A unit test keeps a second parser
  from coming back. Candidate for upstream PR ("fixes #241").
- **Custom source patterns** (review, 2026-09-28): `loadCustomPatternsFile` took the
  text between the first character and the last slash whatever it was, so `hls` alone
  was the empty regex and every response became an HLS source. Parsed by
  `CustomSourcePatterns.mjs` now (`<type> /<regex>/<flags>`, bad lines reported and left
  out); `MultiRegexMatcher` refuses the empty regex and drops `g`/`y`, with which a
  pattern never matched. Candidate for upstream PR.
- **A frame stuck "opening a player"** (review, 2026-09-28): `openPlayer` cleared
  `frame.playerOpening` only on `'no_video'`; a failed `OPEN_PLAYER` (frame navigated
  away, no content script) left it set, and that frame never got a player again.
  `BackgroundUtils.isPlayerOpeningResponse` names the answers that keep it, and a unit
  test ties them to what `content.js` sends. Candidate for upstream PR.
- `miniglob.mjs` `cleanGlobPath` shadowed the module-level `volumeNameLen`
  with a parameter of the same name, then called it. Callers pass a number,
  so **every Windows build failed** with `TypeError: volumeNameLen is not a
  function`. Fixed in `ab0719d`; candidate for upstream PR.
- No `.gitattributes`, so Windows checkouts got CRLF and eslint's
  `linebreak-style` reported 2352 errors. Fixed in `e81b036`.
- **The subtitle resync tool** (`SubtitleSyncer.mjs`, the hourglass on a
  track; all three from upstream's 2023 code, fixed 2026-09-27):
  `renderTracks()` picked the cues in view with `start <= max || end >= min`,
  true for every cue, so the whole track sat in the DOM and every cue was
  repositioned on each frame (300 elements instead of ~18 in the spec);
  `shiftSubtitles()` (the ShiftSubtitlesLater/Earlier keys while the tool is
  open) ended with a call to an `onVideoTimeUpdate()` that SubtitleSyncer does
  not have - the TypeError never showed because `EventEmitter.emit` catches a
  handler's error and only logs it; and the track row started a drag on any
  button, so after a right-click (whose context menu swallows the mouseup) the
  cues followed the pointer. The tool now also shows the track's total shift
  (`SubtitleTrack.shiftTotal`, "Shifted subtitles +1.40s"). Pure helpers in
  `utils/SubtitleSyncUtils.mjs` (unit-tested); `tests/e2e/specs/subtitle-sync.e2e.mjs`
  fails on each of the three against the old code. A port of this tool lives
  in Nawid's mpv config (`subtitle-sync.lua`), with the audio drawn by a second
  mpv instead of the VAD model.
