# Firefox API watch, optimisation and UI review (2026-11-13)

## Where things stand (2026-11-16)

This document records three rounds of work on FastStream: the review and modernisation of
2026-11-13/14 (sections 1 to 7, all merged with #679), the review round on main of 2026-11-15
(section 9), and the buffering and reliability round of 2026-11-15/16 (section 10). Section 8
is the one part still open: changes that are the owner's to decide, each with a
recommendation. Nothing in it is built unless it says so.

- Built and released: everything in sections 4, 9 and 10, except where a line says otherwise.
- Dropped by the owner: the rename to "FastStream for Firefox" (2026-11-14); from the
  2026-11-15 review, "the MPV link waits for the video to play" and "skip CI's re-run for merge
  commits too" (2026-11-16).
- Waiting on others, merged by the owner himself when they come: the mpv update pull requests
  and the deepmerge alert (#614, a fix upstream).
- Open: section 8.

The sections below are as written at the time; later rounds add to them rather than rewrite them.

The owner's two briefs of 2026-11-13: a watcher for what each Firefox release changes, research into
Firefox-only improvements, and an incremental modernisation of the player's and settings' UI. His
follow-up asked for the same work to be proven: benchmarks, regression tests, and validation that each
change is an improvement. It also asked for bugs to be looked for and fixed, CodeQL's findings to be
fixed, and the add-on renamed "FastStream for Firefox". A review of the whole code followed, with
its fixes (section 4).

**2026-11-14.** The owner's decision: no hand test. `test/all-prs` holds all of it and the work
of 2026-11-14 on top (players in several tabs take turns; a page loaded again keeps the player; a
third review's fixes; two fuzz tests: `docs/history/reviews.md` and `docs/notes/player.md`),
and goes to main in one merge (PR #679) while the releases are turned off (the owner's
decision, 2026-11-15); a second review round on main followed (section 9), and the owner
turned the releases on again on 2026-11-15, to test each release as it comes. **The rename is dropped** (his word, 2026-11-14): the add-on
and the repository stay "FastStream"; #676's changes were reverted on `test/all-prs`. The table
and sections 1 to 6 are as written on 2026-11-13, when three draft pull requests waited for his
test.

| Branch | Draft PR | Ships to users |
|---|---|---|
| `feature/firefox-api-watch` | #674 | no (a workflow and its tool; `auto-release.yml` skips it) |
| `feature/firefox-optimization-ui-modernization` | #675 | yes, once merged (a merge to main releases) |
| `feature/rename-faststream-for-firefox` | #676 | dropped on 2026-11-14 (no rename) |

#676 conflicts with #675 in one place (section 7). Every open pull request but the mpv update was
merged into a test branch, `test/all-prs`, built and tested as the main the merges would make
(section 5); the owner's decisions are in section 8.

## 1. Firefox API watch (branch `feature/firefox-api-watch`)

`.github/workflows/firefox-api-watch.yml` runs daily and by hand. For each new Firefox Stable
release it reads MDN's notes for developers, browser-compat-data, Bugzilla's fixed bugs and the
add-ons blog. It keeps what touches FastStream, measured against the code: names searched in
`chrome/`, the manifest's keys and permissions. It posts one section per release to one review
issue, "Firefox API Watch: starting with Firefox N", which holds a checkbox per finding.

The issue's life, as asked:

| Case | What the watcher does | Test |
|---|---|---|
| A: no open issue | opens one with the first release | unit, workflow r1 |
| B: an open issue | one comment per release, in version order; a release not yet posted holds back the later ones | unit, workflow r5 |
| C: ticks and edits | never edits or deletes anything it posted (write-once) | unit; the workflow test fails on any PATCH/edit |
| D: a closed issue | never touched; its markers still count, so the next issue copies nothing | unit, workflow r6 |
| E: nothing relevant | no post; the run's summary says "reviewed, nothing new" | unit, workflow r7 |

- **Recovery and repeats:** missed releases are caught up (the current release and the two before
  it). A second run posts nothing twice, and a partial failure posts the rest on the next run.
  Notes Mozilla adds later come as "added after its first review".
- **Waiting:** a release waits up to 10 days for MDN's notes, then is reviewed without them.
- **When it fails:** a source that answers wrongly fails the run, and so does the newest release
  still unreviewed after 10 days. A failure opens "Firefox API watch failed", which the next clean
  run closes.
- **Safety:** `permissions: {}` for the workflow, and `contents: read` + `issues: write` for the job.
  There is no secret. The workflow never pushes or dispatches, so it cannot start a release.
- **Posted text:** outside text can mention no one, reference none of this repository's issues or
  commits, link only to Mozilla/MDN and the specs' GitHub, and cannot forge a marker
  (property-tested).
- **Independent review:** a separate agent reviewed the watcher. It found eight real problems:
  - a marker could be forged inside a code span;
  - a merged note was hidden;
  - a later change to a reported feature was never reported;
  - sections could be posted out of version order;
  - false failure alarms, and a long outage of a shared source that never failed the run;
  - links to any github.com repository were allowed;
  - the folding counted `<details>` inside code;
  - a lagging issue list.

  All eight are fixed, each with a test; see the commit "what an independent review found".
  `docs/notes/workflows.md` holds the rules.
- **CodeQL:** the repository's CodeQL runs the extended suite with the remote-and-local threat
  model, so the command line, the environment and files read at run time count as untrusted. It
  found 13 alerts in the watcher's first version, one of them critical. Each is fixed where it
  starts, not dismissed:
  - Requests go only to https URLs on the five sources' hosts. The environment variable that
    could point a source at any URL or file is gone; the test names a fixtures folder instead.
  - The npm tarball's URL is built from its file name, not taken from the registry's answer.
  - Every folder or file the runner names (memo, fixtures, the job summary, the step outputs)
    must lie in the runner's temporary folder.
  - The topic patterns are `RegExp` literals in `firefox-api-watch.topics.mjs`; all 186 were
    checked identical to the JSON strings before.
  - HTML comments are stripped until none is left.

  CodeQL on #674 is green, and main has no open code-scanning alert.

**Live dry run** over Firefox 153-160 (the releases since the floor): 96 findings, of which 6 high,
43 medium and 47 low. The six high ones, checked by hand:

| Firefox | Change | FastStream | Verdict |
|---|---|---|---|
| 153 | `requestPictureInPicture()` and its events ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestPictureInPicture)) | `ToolManager.mjs` shows the PiP button when `document.pictureInPictureEnabled`; `InterfaceController.enterPip` | Already used through the feature check: needs a hand test (checklist) |
| 153 | Range requests pass through a service worker ([bug 1465074](https://bugzil.la/1465074)) | the page transport (`page-fetch.js`) depends on it | Verified: the new save tests below get 206 ranges through a page's worker |
| 154 | WebCodecs audio encoder buffer overflow ([bug 2050988](https://bugzil.la/2050988)) | no `AudioEncoder` in FastStream's own code; the vendored Mediabunny (saving, remuxing) can use one | Nothing to do: the fix is Firefox's (the watcher matched comments in `AacLayout.mjs`) |
| 154 | `storage.local` resets itself on a corrupted IndexedDB ([bug 1992973](https://bugzil.la/1992973)) | options live in `storage.local` | Nothing to do: after such a corruption the options start from their defaults instead of failing |
| 157 | `ImageDecoder` returned a broken frame ([bug 2066911](https://bugzil.la/2066911)) | not used | Nothing to do (the watcher rated the area, not a use) |
| 159 | `mediaCapabilities.decodingInfo()` never resolved on Windows ([bug 2082265](https://bugzil.la/2082265)) | `DecodingCapabilities.mjs` | Verified safe on 153-158 too: FastStream's probe gives up after 1.5 s (`PROBE_TIMEOUT_MS`, unit-tested); hls.js starts the call without waiting on it; dash.js has it off (`useMediaCapabilitiesApi: false`) |

## 2. Research

Floor: `strict_min_version` 153 (ESR 153); current Stable 160, 161 due 2026-11-20 (product-details).

- **documentId** (Firefox 153, [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_documentId),
  [bug 1891478](https://bugzil.la/1891478)). Available at the floor, so it needs no feature check:
  `runtime.MessageSender.documentId`, `tabs.sendMessage`/`tabs.connect` options, `webNavigation`,
  `webRequest`, `scripting`. `documentLifecycle` is not supported.
  - The sends that name a frame but no document: `OPEN_PLAYER`, `PLAYLIST_NAVIGATION`/`POLL` in
    `background.mjs`, and the page transport's `tabs.connect` in `PageFetchRelay.mjs`. A frame that
    navigated in between could get a message meant for its previous document.
  - No such misdelivery has been seen: `DocumentKey` in `content.js` and the bfcache handling
    already cover the known cases.
  - Recommendation: **needs more evidence**. Probe first: is `sender.documentId` stable across a
    bfcache restore, and does a stale id reject? Then target those sends with it.
- **The replaced player's measurement** (`content.js`, `updateReplacedPlayer`). The player is
  measured with `display: none`, which the notes count as up to 8 player resizes and 300x150
  flashes in a soft replace's first 2 s (`docs/notes/player.md`).
  - Candidate fix: take the iframe out of flow at its current size instead, and skip the style
    write when nothing changed.
  - **Recommended for later**, measure first: a baseline e2e of resize events and style writes,
    interleaved builds, the replace/miniplayer/fullscreen specs kept green. Not done in this round.
- **The page transport and MPV** (commits b581563, ec8d546). Saving through the page was the
  recorded gap. It is now tested end to end (section 4) and works.
  - MPV mode's refusal of a page-only file is unchanged here. Its e2e specs start a real mpv and
    run only on CI.
- **Media APIs** (BCD, notes for 153-160):
  - MSE in dedicated workers (`MediaSource.canConstructInDedicatedWorker`, `MediaSourceHandle`) is
    not in Firefox Stable: **monitor**. The watcher reports it when it ships.
  - WebCodecs (`VideoDecoder`, `AudioDecoder`) is at the floor. FastStream's players feed MSE
    through hls.js, dash.js and mp4box, and nothing measured asks for WebCodecs: **rejected for
    now**, no problem it would solve.
  - MediaCapabilities is already used, with a timeout.
  - OPFS (`createSyncAccessHandle` in workers) is used already (`storage.md`).
- **UI.** The player's controls are `div`s with ARIA (32 of them). Swapping them for `<button>`s
  would touch every control's CSS and keyboard handling: **recommended for later**, as a change of
  its own.
  - The menus are children of their buttons, so a screen reader cannot reach their items. A
  `role="button"`'s children are presentational. Moving each menu out of its button, with
  `role="menu"` items, is **recommended for later**: the menus' CSS positions them inside the
  button.

## 3. Backlog

| Item | Status |
|---|---|
| Firefox API watch (workflow, tool, tests, docs) | Implemented and verified |
| Saving through the page transport: worker video and current-cookie video byte for byte; cancel half-way, then a whole save | Implemented and verified |
| Space presses a control the keyboard went to; after a click it stays play/pause; form fields keep their Space | Implemented and verified |
| Menu buttons say `aria-haspopup`/`aria-expanded` (six menus) | Implemented and verified |
| Seek bar: a named slider in the tab order with live values; arrows seek from it; focus ring | Implemented and verified |
| Picture-in-Picture button on Firefox 153+ | Implemented but requires manual testing (no change made: the feature check picks the API up) |
| Screen-reader announcement of the menus and the slider | Implemented but requires manual testing (no screen reader in the e2e) |
| documentId on the frame-addressed sends | Needs more evidence |
| Replaced player measured without `display: none` | Recommended for later (measure first) |
| Menus out of their buttons, `role="menu"` | Recommended for later |
| `<button>` elements instead of ARIA `div`s | Recommended for later |
| `<label for>` on the settings page | Rejected: each row already ticks its box or focuses its field on a click anywhere in it, and every field has an accessible name (`aria-label`). A label would toggle a box twice |
| Transitions, "subtle animations" | Rejected: the owner's zero-motion rule (`playerA11y.test.mjs` enforces it) |
| A/B benchmark that stays (`tools/bench-ab.mjs`): two builds by turns, slow-line option, rank-sum verdicts | Implemented and verified (section 4) |
| MP4 player's loop paced while paused or ended; woken at once by a seek or play | Implemented and verified: measured, with e2e limits |
| MP4 played again after its end never started (on main) | Fixed and verified (e2e fails on main) |
| Audio-only MP4's seek preview busy-looped for the tab's life (on main) | Fixed and verified (e2e fails on main) |
| Six background/content-script bugs found by a review (section 4) | Fixed and verified (each test fails on main) |
| The whole-code review: 52 fix commits in seven code areas, and the workflows' hardening (section 4) | Fixed and verified (51 of the 52 with a test; the other corrects a comment) |
| Settings page loaded after the player's first frame | Implemented and verified (A/B: first frame 1005 → 882 ms) |
| Type annotations: elements and `window.fastStream` typed once (1,384 → 1,001 casts) | Implemented and verified (minified code the same) |
| PE-7: a sample budget for crafted MP4s | Needs the owner's decision (section 8) |
| PC-4 (a fragment's peak copies), CS-7 (the page walk on input), the MP4 loop's 1 ms pace in error states | Recommended for later: measure first; the next round, after the owner's test |
| Other performance ideas (modulepreload, earlier player choice, RAM budget for two players) | Recommended for later: each needs its own A/B with the harness. The recorded rejections in `docs/notes/player.md` still stand |
| MP4/DASH seek preview restarting its download on every pointer move | Recommended for later: a guard like HLS's would leave mp4box at the wrong sync sample; needs its own design and a slow-line A/B |
| HLS first frame on a slow line in two modes (about 1.47 s or 2.0 s by the round, both builds) | Needs more evidence: seen in the 12 Mbit/s runs on main as well; a guess is the seek preview's first segment sharing the line with the video's |
| Synced audio following Firefox's PiP controls about a second late (with an audio delay set) | Recommended for later (needs a test for its resync guards) |
| MSE in workers | Recommended for later (monitor: not in Stable) |
| WebCodecs players | Rejected for now (no measured problem it solves) |

## 4. What changed, and the numbers

On `feature/firefox-optimization-ui-modernization` (from main `4813fbee`, 1.3.82.180), in four
rounds: the brief's work (saving through the page, accessibility, the benchmark, the MP4 loop),
a review of the whole code with its fixes, the settings page loaded after the first frame, and a
cleanup of the type annotations.

### Saving through the page, and accessibility

- `tests/e2e/ext-specs/page-fetch.e2e.mjs` gets three new tests:
  - a service-worker video and a current-cookie video, saved through the Save button and the name
    prompt, are the film byte for byte (SHA-256), their far end asked for through the page;
  - a save cancelled about a quarter in says "Save cancelled!", with no "failed, save what there
    is?" question; it leaves no file, and the next save is whole.

  What the first version of the tests ran into is in `docs/notes/player.md`: the player's buffer
  hand-over, and Firefox's cache.
- Player accessibility (`WebUtils.setupTabIndex`, `setExpanded`, the six menus, `ProgressBar`,
  `InterfaceController.timeUpdated`, the focus-ring CSS). One new string, `player_seekbar_label`
  ("Playback position"), is in all 16 locales and `combined-locales.json`.
  - A regression made on the way and fixed: the first Space rule swallowed spaces typed in the
    settings' fields. "1 2" became "12" on that build; now tested.
  - Space presses a control only when the keyboard went to it (`:focus-visible`); after a mouse
    click it stays play/pause.

### The benchmark

`node tools/bench-ab.mjs` (method: `docs/notes/player.md`, "Measuring two builds"). It builds
two versions, serves each from its own port, and plays the same fixtures in one e2e Firefox, the
builds by turns (ABBA), one warm-up round thrown away. A probe added before the page's scripts
records the moments and counts callbacks, DOM changes, long frames and dropped frames.

A verdict needs three things: the medians differ by more than twice the larger spread (MAD), by
more than the measure's floor, and a rank-sum (Mann-Whitney) test gives p < 0.05. Five runs a
side reach p = 0.008 at best. The rank-sum test was added after a 12 Mbit/s run called HLS's
first frame 475 ms faster. Its rounds fell into two modes on both builds (about 1.47 s or 2.0 s);
the medians had landed in different modes. With the test it is "same" (p = 0.42).
`--render <report>` prints an earlier report again with today's verdicts.

**Final numbers**: main `4813fbee` against the test branch (section 5), which is this branch with
the other open pull requests. Firefox 160, Windows 11, 7 rounds a build. Each cell: main → test
branch. The slow-line column is of the test branch's last commit; the local one of the commit
before, whose only difference (the half-done check below) changed nothing on local files.

| Measure | local files | 12 Mbit/s line, 150 ms to first byte | Verdict |
|---|---|---|---|
| MP4: timer/animation callbacks a second, playing | 40.9 → 25.0 | 40.9 → 24.8 | better (p < 0.001) |
| ... paused | 41.3 → 9.5 | 41.3 → 9.5 | better (p < 0.001) |
| ... paused after a seek preview | 41.2 → 9.4 | 41.3 → 9.4 | better (p < 0.001) |
| ... once the video has ended | 255 → 9.4 | 254 → 9.4 | better (p < 0.001) |
| MP4: player modules ready | 271 → 245 ms | 280 → 245 ms | same locally (inside the noise), better on the line (p 0.002) |
| MP4: first frame | 569 → 536 ms | 875 → 864 ms | same |
| MP4: seek to 80 s, then playing past it | 348 → 345 ms | 1856 → 1852 ms | same |
| MP4: seek preview at 120 s shown | 40.7 → 32.8 ms | 38.0 → 29.9 ms | same (inside the measure's floor) |
| MP4: DOM changes a second, playing | 28.0 → 31.1 | 56.5 → 59.6 | worse (p < 0.001): the seek slider's three ARIA values, once a second |
| HLS: player modules ready | 262 → 246 ms | 293 → 247 ms | same locally, better on the line (p 0.007) |
| HLS: first frame | 915 → 1009 ms | 1530 → 1975 ms | same (p 0.90, 0.81) |
| HLS: callbacks a second, playing | 45.9 → 45.4 | 49.8 → 48.4 | same |
| DASH: player modules ready | 292 → 250 ms | | better (p 0.011) |
| DASH: first frame | 1372 → 1330 ms | | same |
| DASH: callbacks a second, playing | 64.3 → 64.5 | | same |
| Idle player: modules ready | 292 → 233 ms | | better (p 0.002) |
| Idle player: callbacks a second | 1 → 1.4 | | same (inside the floor) |
| Frames more than 50 ms apart, dropped frames (all) | 0 → 0 | 0 → 0 | same |

HLS's first frame on the line falls into two modes on both builds, about 1.45 s or 2.0 s by the
round (main 4 fast and 3 slow, the branch 3 and 4; within each mode the branch is a little
faster); one round in the other mode moves the median by half a second. The idle player's extra
0.4 callbacks a second are two that come once: the 5 s timer that loads the settings page for a
player with no picture, and its idle callback (`--where`).

What the numbers mean for a user: a paused or finished MP4 tab no longer wakes the CPU 40 to 250
times a second for as long as it stays open; a tab in the background with a finished video was the
worst case.

**The settings page after the first frame.** Every player loaded the settings page in a hidden
iframe as it started; its scripts ran beside the player's own. Measured first with the iframe left
out altogether: the first frame of an MP4 came 945 → 808 ms (7 of 7 rounds). The iframe now gets
its address when the first frame is shown and the page is next idle (at the latest a second
later), when the settings window opens, or 5 s after the start for a player that shows no picture
(the GitHub build's update check runs in it). A/B of that change alone, 7 rounds: first frame
1005 → 882 ms (p 0.017), player modules ready 684 → 607 ms, no long or dropped frames.

### Bugs found and fixed: first round

Each was shown by a test that fails on main's code and passes on the branch:

| Bug on main | What the user saw | Test |
|---|---|---|
| An MP4 played again after its end never started (any MP4 over about 40 s) | the play button after the end: spinner for good | `mp4-loop-pace.e2e.mjs` |
| ... also after a play-through without a seek (a fix's own hole, found by review) | the same | same |
| An audio-only MP4's seek preview woke the page 236 times a second | CPU use for the tab's life | same |
| The MP4 loop ran every 50 ms while paused, every 4 ms once ended | CPU use (above) | same, and the benchmark |
| The next episode's instructions waited on the tab until some player took them | a video opened minutes later on another page went fullscreen, played by itself and skipped its place | `backgroundFullscreen.test.mjs` |
| A next episode on another hostname lost them | no fullscreen or autoplay carried there | same |
| Escape could not end a carried fullscreen whose player's frame was gone or new | the window stayed fullscreen | same |
| The page around an embed kept its own menu hidden after the player left the embed | the site's menu over the embed missing until reload | `content-overlays.e2e.mjs`, `backgroundOverlayGuard.test.mjs`, `contentScript.test.mjs` |
| A player gone with its page was counted gone twice | with two players in a tab, the next one took itself for the main player | `backgroundFrameRemoved.test.mjs` |
| A start by address was lost when the page changed only its `#` within half a second | MPV allowlist or auto-enable did not start | `backgroundMpv.test.mjs` |
| Toolbar calls for a closed tab were rejected unhandled | errors in the background's console | `backgroundRobustness.test.mjs` |

### Bugs found and fixed: the whole-code review

Eight reviewers read the whole code by area (background, content scripts, player core, saving and
audio modules, settings and utilities, player UI, playback engines; the workflows and the helper).
Each finding
was checked against the code before it was fixed. Each fix has its own commit: 51 of the 52 carry
a test, and the other corrects a comment. The nearest e2e specs ran after each area's merge. **Bold** rows change behaviour on purpose.

| Area | What the user saw on main | Now |
|---|---|---|
| Background | After MPV refused a DRM stream, the next stream (often an ad) went to MPV and the page stayed paused | the refusal does not re-arm the hand-off; three copies of the answer handling are one |
| | A next-episode page that changes its address with `pushState` lost autoplay and fullscreen | counted by documents, not by address changes |
| | A player brought back from the back-forward cache was not counted: the next one took itself for the main player | counted |
| | **The "fresh link" fetch used the normal cookie jar for private-window and container tabs** | **no fresh link in those tabs** |
| | Stream-length probes could put a private window's streams into Firefox's disk cache | `cache: 'no-store'` |
| | Each piece of a split MP4 started a probe and a captions scrape | once per page and shape |
| | `tabs.onUpdated` woke the background for every tab change (title, icon, sound) | only the address and load state |
| Content scripts | **A same-site link the page handles itself (a "Sign in" dialog) took the player down** | **the player stays; the decision waits one task** |
| | The media list kept the first 1000 entries, so recovery missed the current stream | the newest 1000 |
| | Fullscreen of a player in a shadow root: the toggle entered fullscreen again instead of leaving | asked of the element's own root |
| | The miniplayer's placeholder copied an iframe's or custom element's tag | a `div` for those |
| | Typing in a shadow-root field or a chat iframe let the next episode's player take the keys | counted as typing |
| | **`instagram_inject.js` was web-accessible to every site** | **to Instagram's pages only (manifest)** |
| | The OpenSubtitles link and the error-report button did nothing in a player inside a page | open through the background |
| Player core | A 206 answer without `Content-Range` was read to the end of the file for every 1 MB range | stops at the range's length |
| | Closing a page during a hand-off deleted the files just handed to the next player | the hand-off's files kept; the player's own deleted first |
| Saving, audio | DASH and fragmented-HLS saves could keep pieces of stored data freed meanwhile: a "successful", broken file; RAM above the budget | written as the save goes (`SaveFile.mjs`); **a write failure in the middle now fails a DASH save, as it did an HLS save** |
| | A partial save's headers gave the whole stream's duration | the saved part's |
| | Switching the audio track after the analysis destroyed the main analyser | kept |
| | **A saved video stayed a second time in the extension's storage until another player started** | **deleted when Firefox's download ends** |
| | The audio analyser's volume loop woke the page 125 times a second while the background analysis (silence skipper) waited paused, and 15 times while the player was paused | every 250 ms while paused; at once on play |
| Settings, utilities | Keybinds with `+` never fired | fire |
| | International domain names in a list never matched | matched as the browser writes them (punycode) |
| | A malformed settings import broke or froze the settings page | checked value by value |
| | A page could hold the background for seconds with a crafted manifest (1 MB: 1.6-8 s) | read in one pass; fuzzed with 200,000 inputs |
| | **`example.com` in a list matched `https://example.com:x@evil.com/`** | **the host is matched; `user@example.com` pages still match** |
| | Dragging a slider on the settings page now and then put it back mid-drag and redrew every keybind row; each save set the redirect rules twice (about 120 updates for a two-second drag) | each save's own echo is known; a rule is set only when it changes |
| | The update check wrote the storage at every player start; after one failed check, every player asked GitHub again at once | a check every 12 hours, failed or not; a failure keeps the known version |
| Player UI | The silence skipper undid speed changes from keys, a held key or a GIF | kept |
| | Escape did nothing in five panels | closes them |
| | Hovering a dropdown took the focus from the address field: typed letters fired shortcuts | focus stays |
| | Space on the captions, quality and language buttons played or paused | presses the button |
| | An OpenSubtitles result's page address went to a new tab unchecked | only https pages on opensubtitles.com or .org |
| | The A-B loop ran animation frames while paused | stops while paused |
| Engines | A fragmented MP4 with no total duration previewed the 9 s frame for every place past 9 s | the right frame, or no preview while the length is unknown |
| | A seek past the end of the shorter track (sound ends before the picture) never completed | completes |
| | A stale `seeked` made a second HLS reset abort its range | ignored |
| | A destroyed player's SourceBuffer queue ran on, one exception per queued operation | stopped |
| | **A server's claimed length was trusted: `Content-Range: .../9007199254740991` hung every add-on (one shared process)** | **over 256 GiB, Firefox's own player plays the file** |
| | The DASH patch built an unbounded segment list (`PT100000000H`) | at most 100,000 segments |
| | Audio-only MP4 players for a delayed sound track appended the video too (three MSE pipelines) | sound only |

Measured and taken back: a seek and a yield to a watched player were meant to spare a running
download at least half in, but the check read stats that were null until the whole body was in,
so it never held. The review made it work. The final A/B (below) then showed a seek to 80 s in an
MP4 on a 12 Mbit/s line a second slower, 1557 → 2547 ms in 7 of 7 rounds, as the spared downloads
shared the line with the ones the seek waited for. With only the check switched off, the same
build seeks as main: 2370 → 1543 ms, 5 of 5 rounds, p 0.008. The check is gone; a seek behaves as on main
(`docs/notes/player.md`).

Also removed: dead code in the background, content script, player core, modules and options
(each removal grepped across the repository and checked in the built zip), an `isAnalyzer` flag
nothing read, and a `case undefined` in the visibility switch.

Found and not fixed:

- **PE-7 (security, owner's decision)**: a crafted MP4 can claim billions of samples in a few
  bytes, and mp4box makes one object per sample (4 million samples = 2.2 GB, measured) in the
  shared add-on process. No cap protects without refusing real long files (24 h at 60 fps = 9
  million samples). Recommendation in section 8.
- PC-4, three copies of each fragment at the peak while a body is read: needs a measurement first
  (a gzip `Content-Length` is not the body's length).
- CS-7, the content script's walk of the whole page on a click or key (at most every 2 s): needs a
  measurement on a big page first.
- The MP4 loop's 1 ms pace while `needsInit` is set (error states only).
- MO-8, a retry of a save's failed piece: not reproduced.

These four are the next round's, after the owner's test.

### Workflows

None of the review's points is exploitable today; all are hardening:

- `release.yml` refuses a tag that is not on main (`git merge-base --is-ancestor`), before the
  install, build and signing. The check lives in the tag's own copy of the workflow, so it guards
  against a mistake, not an attacker. The AMO signing fail-safe, which runs main's copy, neither
  restarts nor builds or signs a release that is not on main. A tag ruleset closes the rest
  (section 8).
- The fail-safe's GitHub token is given to the steps that call `gh`, not to the whole job, so
  installs and builds beside the AMO keys run without it (`workflowSecrets.test.mjs`).
- `update-prs.yml`: its concurrency group sat on the workflow, which every CI run starts; the
  runs whose job is skipped queued too, and GitHub cancels a pending run when another arrives. The
  group is on the job now, as in `auto-release.yml`.
- New tests: `tests/workflows/release-provenance.test.sh` (real git), two new fail-safe scenarios.

### Type annotations

The code is JavaScript checked by TypeScript (`// @ts-check`, JSDoc). Its clutter was casts:
1,384 inline casts before this round. `DOMElements.mjs` now types each of its 80 elements once,
and `window.fastStream` is declared once (`types/player-window.d.ts`), which removed 383: 1,001
are left, most at a `querySelector` (JSDoc has no non-null element type there without one).
Every changed file was minified as it was and as it is (`esbuild`, comments dropped): the same
code in all 22. A switch to `.ts` files was not made: it would put a compile step between the
source and every shipped file, and gives no check the current setup lacks.

### Size and interfaces

| Measure | main 4813fbee | this branch | test branch |
|---|---|---|---|
| GitHub zip | 2,577,753 B | 2,597,572 B (+19,819 B) | 2,597,769 B |
| Unpacked, files | 10,846,345 B, 289 | 10,893,928 B, 290 (`SaveFile.mjs`) | 10,894,326 B, 290 |
| Manifest | | `instagram_inject.js` web-accessible to Instagram only; permissions unchanged | the same, and the rename |
| Settings, storage format, locales | | unchanged; one new string in all 16 | the same |
| Unit tests | 3552 passed, 6 skipped | 3734 passed, 6 skipped | 3791 passed, 6 skipped |

Most of the growth is comments: the files grew most where the fixes explain themselves
(`background.mjs` +12.9 KB, `MP4Player.mjs` +10.0 KB).

## 5. Verification

**The test branch** `test/all-prs` is main with every open pull request except
the mpv update #634, merged in this order: #674 (watcher), #675 (this branch), #676 (rename; one
conflict with this branch, resolved), #673 (player libraries), #672 (`express-rate-limit`). It is
the main the merges would make, and the build to test.

Run on this PC (Windows 11, Firefox 160), on the test branch's last commit unless noted:

- `pnpm run lint`, `pnpm run typecheck`: clean.
- Unit suite: 244 files passed, 1 skipped; 3791 tests passed, 6 skipped.
- `build:keep`, `lint:github`, `lint:amo` (0 errors, 0 warnings, 0 notices), `verify:vtt`,
  `verify:fsaunpack`: pass.
- Workflow tests in WSL (Ubuntu 26.04): all pass.
- e2e, every suite except the mpv specs, which are never run on this PC (they start a real mpv):
  extension 26/26, private browsing 1/1 and github 3/3 spec files in the full run; web 48 of 49
  and classic 9 of 10 there. The two failures were the tests', and both specs passed after
  their fixes:
  - `player-controls`: a test focused a button by script, which is not keyboard focus, so Space
    played the video (the new focus-visible rule). It now focuses with `focusVisible: true`; 26/26.
  - `content-cleanup`, the shadow-root fullscreen test: Firefox leaves fullscreen when another tab
    comes to the front, and the test switched to the extension's tab to read each answer. Both
    toggles now go out while the site's tab stays in front; 24/24. With main's compare put back
    for one run, the test fails (`enter, enter`): it checks what it should.
  - `mp4-loop-pace` passed on its retry once here and once on CI ("did not reach its end at
    8x"). The test set 8x on the video element, and the client put its own 1x back at the next
    `canplay`, which comes after every stall. It sets the rate through the client now; 3/3.
- The log was checked for an mpv spec name and for "did not match": none.
- After the half-done check was taken out: lint, typecheck, the unit suite (the two new tests
  fail with the check back), and the e2e specs nearest to it: `parallel-downloads`,
  `seek-downloads`, `mp4-seek`, `seek-preview`, `mp4-seek-preview`, `mp4-loop-pace`,
  `player-peers-bfcache`, `reload-keeps-buffer`, all passed with no retry. The slow-line A/B
  above is of that build.
- CI (GitHub, Windows and Linux, the mpv specs included): green on this branch and on the test
  branch, and Firefox Beta green on this branch. The runs before showed three flaky tests, each
  passing on its retry, and each was looked at:
  - `content-cleanup`, "opens the player on a page Back brought back from another site" (Linux):
    Firefox kept the test page out of the back-forward cache because the page's own video
    request was still open, though the clip was buffered whole. Seen on main before; not
    changed.
  - `page-qualities`, "switches to another where the video is" (Linux, a test from main): it
    looked before its watcher had noted the new video's first time. It now waits for that.
  - `page-fetch`, the worker save (Linux, a test of this branch): the save never began, and
    nothing in the log says why. A timeout now reports the open dialog and where the save
    stood.
- CodeQL: three alerts in new tests fixed in the tests; two more (`UrlMatchList.test.mjs`, test
  input taken for a regular expression) dismissed as false positives with the reason, as ten of the
  same rule were on main.
- Not done: the usual glm-5.3-flash reviews (Ollama was not available). Independent Claude
  reviewers covered each area instead, and each of their claims was checked against the code.

**2026-11-14, the release branch** with that day's work (the commit before this report's last
change, which changes nothing else), on the same PC:

- `pnpm run lint`, `pnpm run typecheck`: clean. Unit suite: 249 files passed, 1 skipped; 3867
  tests passed, 6 skipped. `build:keep`, `lint:github`, `lint:amo` (0 errors, 0 warnings, 0
  notices), `verify:vtt`, `verify:fsaunpack`: pass. Workflow tests in WSL: 29 files, all pass.
- e2e, every spec but the five mpv ones, each suite with its specs listed by name: web 50 of 50,
  extension 27 of 27, classic 10 of 10, private browsing 1 of 1, the GitHub build's smoke set 3
  of 3. No spec was retried; the logs name no mpv spec and no pattern that matched nothing.
- CI on GitHub (Windows and Linux, the mpv specs included) and the Firefox Beta run: green, and
  neither retried a spec.
- A/B against main, 7 rounds each (`tools/bench-ab.mjs`), on local files and on a 12 Mbit/s line
  with 150 ms to the first byte. Nothing is slower. The verdicts other than "same":

  | | main | branch | |
  |---|---:|---:|---|
  | MP4, local: player modules ready | 673 ms | 607 ms | better |
  | MP4, local: first frame | 997 ms | 915 ms | better |
  | MP4, local: seek preview shown | 68 ms | 31 ms | better |
  | MP4: wake-ups a second, playing | 40.9 | 25.0 | better |
  | MP4: wake-ups a second, paused | 41.3 | 9.5 | better |
  | MP4: wake-ups a second, ended | 253 | 9.4 | better |
  | HLS: player modules ready (local; slow line) | 705; 686 ms | 608; 587 ms | better |
  | Idle player: modules ready | 736 ms | 581 ms | better |
  | MP4: DOM changes a second, playing (local; slow line) | 28.1; 56.3 | 31.1; 59.4 | worse: the seek slider's ARIA values, accepted |
  | DASH: DOM changes a second, playing | 37.5 | 41.2 | worse: the same |

  Seeks on the slow line: 1572 and 1581 ms to `seeked`, 1856 and 1864 ms to playing: the same.
  No frame was dropped or more than 50 ms late on either build.
- Several tabs (`--scenarios tabs`, 8 Mbit/s, three players in background tabs and one in front,
  7 rounds): the player in front has its whole video after 29.6 s, was 66.1 s; all four after
  92.3 s, was 109.1 s; its first frame 0.09 s sooner. On a 40 Mbit/s line both builds are the
  same. `docs/notes/player.md`, "Players in several tabs take turns", has the control runs.
- Size: the GitHub zip is 2,610,553 B, was 2,577,753 B on main (1.3 % more). The manifest asks
  for the same permissions.
- Not done, again: the glm reviews (Ollama could not be reached). Six Claude reviewers read the
  branch against main before the last fixes; each claim was checked against the code.

## 6. Manual test (the owner)

`pnpm run start:ff` in the test branch's worktree builds it and opens its own development
profile; `pnpm run start:ff` in the main checkout is the comparison. The zips are in the
worktree's `built` folder.

1. Play an MP4, an HLS and a DASH video and a live stream; seek; change quality, audio and speed.
2. Play an MP4 longer than a minute to its end, then press play: it starts over. Pause it and
   check Firefox's task manager (`about:processes`): the tab's CPU stays near 0.
3. Seek far ahead in a long MP4 on a slow site: it plays there as quickly as on main.
4. Keyboard: Tab through the controls. The seek bar gets a ring, and ArrowLeft/Right seek 5 s
   from it. Tab to the speed button (its menu opens), press Space (it closes), and the video does
   not start. Escape closes a panel.
5. Mouse: click the speed button, then press Space. The video plays; the menu stays open.
6. Settings: open them from the player (the page loads at once); tick a box with Space, type a
   space in the mpv path field (it must stay); a keybind with `+` works.
7. A screen reader (NVDA, or Firefox's accessibility inspector): the seek bar reads as "Playback
   position, slider" with the time. A menu button says collapsed or expanded.
8. Picture-in-Picture: the PiP button shows on a playing video, and PiP opens.
9. Save an MP4, an HLS and a DASH video, and one from a site that only plays in its own page (a
   service-worker player). Each file plays in another player. Cancel a save half-way; no file is
   left, and the next save is whole.
10. MPV mode on such a page: FastStream plays it and says why, as before.
11. A site with an embedded player and a menu over it: after the embed goes to another video, the
    site's menu over it shows again. A "Sign in" link on a page with the player: the player stays.
12. Next episode in fullscreen: let it go on by itself, then press Escape; the window leaves
    fullscreen. Open an unrelated video later in the same tab: it does not start fullscreen.
13. A private window: a video plays and saves as in a normal one.
14. Watcher, after its PR is merged: Actions, "Firefox API watch", Run workflow with `dry_run`; the
    run's summary lists what it would post. Locally: `node tools/firefox-api-watch.mjs --dry-run
    --no-github --from 158 --to 160`.

## 7. Merging and git

Order, as decided on 2026-11-14 (one merge of `test/all-prs`, not one per pull request):

1. The owner turned off Release, Auto release and Release failsafe (2026-11-15), so a merge
   into main released nothing; CI's hand-off to Auto release said so and stopped. (Done: on
   again since the evening of 2026-11-15; v1.3.82.181 was the first release of the round's
   work, and every merge into main releases again.)
2. Merge `test/all-prs` into main (PR #679) with a merge commit, not a squash: each area keeps
   its history, and the commits of #672 to #675 are in main as they were reviewed (those pull
   requests were closed on 2026-11-14 and their branches deleted, since this branch holds
   them).
3. The review round on main (section 9); each fix a pull request. (Done.)
4. The owner turns the releases on again. (Done, 2026-11-15.) The first release run after that: watch "Check the
   tag is on main" (new in it), then the signed file and `updates.json`.
5. #634 (the mpv update) stays open, as decided.

No rename: #676 was merged into `test/all-prs` and reverted there (2026-11-14), so its commits
and their revert are both in the history; the files are as on main.

| Branch | What it holds (on main 4813fbee) |
|---|---|
| `feature/firefox-api-watch` | the watcher: tool, workflow, tests, docs, the review's fixes |
| `feature/firefox-optimization-ui-modernization` | saving through the page (tests); Space, menus and the seek slider; the MP4 loop's pace and its bugs; the A/B benchmark; the first round's background fixes; the review's fixes (eight area branches, merged with their history); the settings page after the first frame; the workflow hardening; the type cleanup; this report |
| `feature/rename-faststream-for-firefox` | the rename: merged into `test/all-prs` and reverted there, dropped |
| `test/all-prs` | the release branch: the merges above, the work of 2026-11-14, the rename's revert |

The three feature branches are deleted already (their commits are in `test/all-prs`), and
`test/all-prs` goes after the merge: only `main` stays, and `mpv-update` for #634.

## 8. Decisions for the owner

Nothing here is built (except where it says so); each is a recommendation.

**Behaviour changes already built** (in the review table, bold): no fresh link in private and
container tabs; a page-handled same-site link keeps the player; a mid-save write failure fails a
DASH save; a saved video's copy is deleted after its
download; `user@site` addresses match the site's entry; files over 256 GiB play in Firefox's own
player; the settings page loads after the first frame. Two more that this list missed until
2026-11-14: a next episode on another host name keeps autoplay and the carried fullscreen (it
was the same host only); a frame of the page with the focus (a chat, a comment box) counts as
typing, so the next episode's player does not take the keyboard from it.

Built on 2026-11-14, each asked for by the owner: players in background tabs wait for their turn
to download ahead on a slow line; a page whose player missed its video is asked again (1, 2 and
4 s later, at the page's next requests, and at a play the user starts).

Playback and engines

- A segment that keeps failing: MP4 retries (2, 4, 8 s) and shows the error only when playback
  reaches the gap; DASH shows it at the third failure, with 10 s still buffered; HLS leaves it to
  hls.js. Recommended: MP4's way everywhere.
- With an audio delay set, HLS and DASH audio players load the video too (MP4 fixed).
  Recommended: audio-only renditions where the stream has them.
- Every seek cancels downloads more than 30 s ahead, even inside a part already downloaded.
  Recommended: keep a download that continues what is buffered at the new place.
- PE-7 (security): a per-file sample budget (about 4 million, 13 h at 30 fps); beyond it Firefox
  plays the file itself, as it now does a file over 256 GiB.

Added on 2026-11-14

- The next episode through a page in between. The next episode's instructions (autoplay, the
  carried fullscreen) are for the first page after the click and end at a second one. A site
  that shows a check page between episodes, or sets the address twice without a new page, loses
  them: the episode waits for a click. On main they stayed until some player took them, which
  made a video opened minutes later play by itself. Recommended: carry them on to a second page
  for 20 s after the click, the time the page is asked to start its player. The price: a page
  the user opens on their own within those 20 s would start by itself too. (Since 2026-11-15,
  #688: instructions no player took end 2 minutes after the click, so a video opened later no
  longer plays by itself; the 20 s carry-over is still open.)
- The silence skipper sets the speed every 100 ms, so holding a key for 2x and the GIF
  recorder's 4x last a tenth of a second while it is on. Recommended: the held or recording
  speed wins for as long as it lasts.
- After a mouse click on the volume button or bar, the Left and Right keys change the volume,
  not the time, until the focus goes elsewhere. Recommended: only when the focus came by keyboard.
- A toast's time is a bar that runs out: the one animation left in the player. Recommended:
  the toast without the bar, gone after the same time.
- Every video starts on three connections, tries six, and keeps what was faster. A host's
  verdict could be remembered until Firefox closes (in memory, nothing stored), so the next video
  from it starts with what was faster. Recommended: yes, once measured on real sites.
- More than six connections to a server that speaks HTTP/2 or HTTP/3 (one connection carries
  them all there). Recommended: not without a measurement that shows servers allow it.

Background and MPV

- "Open link in FastStream" on an MPV-allowlisted site goes to MPV. Recommended: an explicit
  FastStream choice wins.
- An update installed in the middle of a film reloads the extension and breaks the page's player.
  Recommended: `runtime.onUpdateAvailable`, applying the update when no player is open.
- Players in `about:blank` or `srcdoc` frames are not replaced (no `match_about_blank`).
  Recommended: turn it on, with the content specs as the test.
- The `moz-extension://` address is visible to pages through the player's iframe (a fingerprint).
  Firefox has no `use_dynamic_url` yet. Recommended: watch it (a watcher topic).

Settings

- Settings are stored whole at the first save, so later default improvements never reach that
  user. Recommended: store only what the user changed.
- `-domain` in Auto-enable excludes that host only, not its subdomains. Recommended: subdomains
  too.
- Import replaces every setting. Recommended: keep it (a backup restore), and say so on the button.
  Except the mpv path since 2026-11-15 (#690): it is this computer's, and the one program the helper
  starts, so an import keeps the current one.

Player UI

- Quality, speed and language menus stay open after a choice. Recommended: close on a mouse
  choice, stay open for the keyboard.
- Subtitle rows take the focus on hover and react to keys. Recommended: focus on a click or the
  keyboard only.
- The Document Picture-in-Picture code is Chromium-only. Recommended: remove it.

Saving

- Private-window saves are staged in the Cache API and read back; the RAM peak is the same as in
  memory. Recommended: keep for now.

Workflows and the helper (hardening; none exploitable today)

- A tag ruleset (only the owner and the workflows create `v*` tags) closes what the new provenance
  check cannot.
- `patched-libraries.yml` installs a new npm release in a job with a write token. Since #701
  (2026-11-16) no install script runs in that job and no code of the new release runs at all
  (it is only diffed and patched). Still recommended, for the rest:
  install and test in a read-only job, push from a second one.
- The helper starts any `mpv*.exe` path the extension names (relative ones too) and passes `fs-*`
  tags unchecked. Recommended: absolute paths only, tags checked (a new helper version).
- The fail-safe attaches AMO's signed file without comparing it with the built zip. Recommended:
  compare the files inside.
- `fsaunpack` answers with `Access-Control-Allow-Origin: *`; the signing job also runs the tests
  (dev tooling beside the AMO keys). Recommended: split the build and signing jobs.

## 9. The review round on main (2026-11-15)

The second round, on main after #679, with the releases off until its end. Its brief
(`docs/review-2026-11-14.md`) was deleted when it was done; its benchmark summary is in
`docs/bench/2026-11-14/README.md`. Each fix below is a pull request with a test that fails
before it (#691 and the guard tests of #687 guard what already worked), an A/B run where it touches loading, and a Claude API review of its diff, every
claim of which was checked before anything was changed.

**Built**

| PR | What |
|---|---|
| #682 | Instagram and Facebook reels again (their pages' data moved), bilibili's half-height player |
| #683 | `SaveFile.add` takes a fragment's own buffer as it is (one copy less per fragment) |
| #684 | After the event page restarted, a player is counted at its keep-alive `PING`: a second player in the tab was the main one and autoplayed |
| #685 | `RangeTimes`: a fragmented MP4's range times worked out again only where new samples fall (1.65 ms a call to 0.07-0.13 ms at 2 h) |
| #686 | A page's `<track>` files: at most 64 tracks and 64 MB a reading, a frame keeps at most 64M characters; `episode-links.js`'s title clean-up linear (11.7 s on 200k dashes before) |
| #687 | A reload whose page takes over 3 s keeps the buffer (an e2e that also checks the old page's player came back); guard tests |
| #688 | Next-episode instructions no player took end 2 minutes after the click (the owner's pick) |
| #689 | A public page's report after an event-page restart names no local-network address (`LocalAddress.mjs`; the owner's pick). Not caught: a public name that resolves to a local address (no DNS lookup without the `dns` permission) |
| #690 | A settings import keeps this computer's mpv path |
| #691 | Property tests of the background's length reads (what a server sends): nothing found, a guard |

**Checked, nothing to change**

- A start time set before the video loads holds in Firefox 160: with the MediaSource's duration set first, a start time
  set at `readyState` 0 is kept, and `seeking` fires twice after `loadedmetadata`; without a
  duration it is dropped silently; a plain file keeps it.
- A full disk: a write past the disk's space fails cleanly (`writeAll` throws on a short write) and the
  fragment stays in RAM. Two tabs with one page and video reloaded within 20 s share a
  buffer key; the second hand-off flushes the first, the other tab downloads again. Nothing
  crosses a container or a private window.
- Security: a page's quality lists count only with the file the browser itself requested, and
  only entries on its host; the page transport fetches in the frame the stream was detected in;
  `fs-*` tags a page puts in a URL are dropped; subtitle text is drawn from an allowlist of tags;
  the mpv helper passes each value as its own argument, quoted for Windows, titles without
  control characters, headers by fixed patterns, subtitles in a random folder; header rules hold
  one tab, the extension's own requests and one URL's host, for seconds; no option but the mpv
  path names a path, command or key.
- The turns between tabs: a dead server holds the players after it for `STUCK_MS` (15 s) at most;
  a finished download announces at once (`onDownloaderFinished`, tested). The reload retry needs
  the user's play after a page took the player out. Two windows side by side are both seen.
- Measured: the page transport carries 170 MB/s against 375 MB/s direct (17 MB, medians of 5),
  about 3 ms a MB more, far above any video's rate. A `SET_HEADERS` round trip: 5 ms median,
  16 ms p90 for a new rule, about 1 ms for a kept one. The startup modules (sortable, the subtitle
  search, gif): 3-7 ms each warm against a 37-49 ms page load; sortable and the search are made at
  startup, gif's 3-4 ms is below what the bench tells apart.

**Left as they are, with the reason**

- A server that trickles a byte now and then keeps its player "not stuck", and the hidden
  players after it wait (the owner: too rare for more logic).
- A regex the user types in `UrlMatchList` runs on every address (the owner: only the user can
  type one).
- MP4Player's loop at 50 ms while playing with media ahead: at 250 ms it would notice up to 250 ms
  later that the video ran dry, for 16 fewer tiny wake-ups a second.
- Downloads ahead start at the client's tick after a seek: started earlier, they would take
  the player's own request's priority.
- The version is read from `runtime.getManifest()`: `runtime.getVersion()` would need Firefox
  158, and the floor is 153.
- bilibili.tv's own player (MSE) after the first visit: new site code, against the rule of core
  fixes.

## 10. Buffering and reliability round (2026-11-15/16)

The owner's brief: buffering improvements for every site and player, lasting, with no
regression; then "stable, secure, fast". Each change is a pull request with a test that fails
without it, an A/B run of `tools/bench-ab.mjs` (5 rounds a build, several kinds of line) where
it touches loading, and a review of its diff (Claude API or glm-5.3-flash), each claim checked
before acting. The measurements and the reasoning are in `docs/notes/player.md` ("While the
video waits...", "Buffering").

**Built**

| PR | What | Measured |
|---|---|---|
| #694 | The benchmark's stall scenarios and line options (`--jitter`, `--conn`, `--drop`, `--stall-ms`) | - |
| #695 | A DASH segment outside the fragment store gets the download manager's retries | a seek into a later Period no longer sits there for good when an answer is cut |
| #696 | While the video waits on a line the downloads share, only playback's own request downloads | HLS seek 2448 -> 1213 ms (6 Mbit/s), 6168 -> 2020 ms (a falling 3 Mbit/s line) |
| #702 | DASH: a later Period's segments and the manifest at playback's priority | the same on 3 lines; a seek or a background tab no longer cancels them |
| #704 | A seek in the first seconds, while the speed test runs, gets the line; the test waits for it | HLS 3140 -> 1217 ms, MP4 3556 -> 1606 ms (6 Mbit/s); 3047 -> 1922 ms where each connection is capped; MP4 10975 -> 7710 ms on a falling 3 Mbit/s line. Accepted trade-off (the owner, 2026-11-16): a hover preview ~40 s ahead right after such a seek can come later on a slow line that keeps falling (downloading ahead starts after the seek) |
| #700 | README up to date; `SECURITY.md` (private reports through GitHub's vulnerability reporting) | - |
| #701 | No install scripts in the patched-libraries re-cut job | - |
| #706 | A seek also cancels the downloads ahead already running beside the playhead's fragment, inside the new place's window | MP4 seek on a steady 3 Mbit/s line 3643-3699 -> 2882-2913 ms in each of the 6 rounds where the next fragment ran beside it; all else the same on 5 lines |
| #707 | When the network is back (`online`), a retry waiting out its backoff goes at once, and fragments that failed offline are downloaded again | unit tests (an e2e cannot take Firefox offline); up to 32 s sooner after an outage |

**Flaky tests (#697)**

- `page-fetch` and `autoplay-next-episode` failed on CI for the same reason: at the moment of
  the test's click, the player's document had no layout (width 0, no boxes) while the page
  showed its iframe at 640x360. Firefox ignores a click on a button there; `requestSubmit`
  still works. #699 and #703 make each failure report the player document's and the page's
  state; the next step records the timeline of the frame's style and the sizes its document is
  told.
- Ruled out with a cross-process probe (page on 127.0.0.1, frame on localhost, 20 cycles):
  content.js's size measurement, which hides the iframe and forces a layout for a moment. The
  frame saw no resize and every click worked.

**Benchmark trap found:** `bench-ab`'s B (this checkout) started DASH about 60-110 ms later than
A with no change at all (an A/A run, 10 rounds). A small first-frame gap in one direction is the
harness until an A/A run says otherwise.

**Still open (buffering)**

- Earlier ideas, not measured yet: resume a cut download from the byte it reached; remember a
  host's speed until Firefox closes (section 8); preconnect; `preload=auto` for files Firefox
  plays itself.

**Closed by measurement**

- "The speed test never decides on a line that swings": traced over 90 s of play (2026-11-16), it
  decided in 11-38 s on a steady 3 Mbit/s line and on one falling to a quarter every other 5 s,
  MP4 and HLS (a line the downloads share). The test seen running at 85-125 s was the benchmark's
  seek 5 s into play: a seek holds the test (#704), and its round starts again after.
- MP4 seeks on slow lines: the slow ones had the next fragment downloading beside the seek's
  (#706).
