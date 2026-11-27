# Reviews and audits

What each review and audit of the code found, in the order they ran: the fixes (each names
the test that fails without it) and the findings that were checked and rejected, with the
reason. Read the rejections before raising a finding again. The design these fixes left is
described in `docs/notes/`, by area.

## Optimisation review of the whole player, 2026-11-07

glm-5.3-flash reviewed the network layer and client, the players, the interface's playback-time
code and the background script for speed on Windows 11 and Firefox (Codex was asked too, and
stopped at its usage limit). Each finding was checked against the code before anything was
changed.

Changed:

- **A queued download that was removed stayed in the queue** (`DownloadManager.removeFile`,
  as on a level switch freeing the old level's downloads ahead): `canGetFile` says no while
  the queue holds anything, so the new level's downloads ahead waited until a finished
  download let `queueNext` drop it. Now taken out, as the other ways a queued download ends do.
- **MP4Player's main loop** re-armed every 1 ms (4 ms in Firefox) for as long as an MP4
  played, about 250 rounds a second per player (the seek preview is a second one). Now 1 ms
  only while it starts, seeks or has run out of media, 50 ms while it plays with media ahead
  (`STEADY_LOOP_MS`): measured about 20 rounds a second per player while playing. First frame
  and seek times: the interleaved comparison in the pull request.
- **Header rules**: the expiry round called `declarativeNetRequest.updateSessionRules` every
  second with nothing to remove while any rule was held; now only when one ran out. The same
  rule asked for again (an MP4's every range, a direct video's renewals) is kept longer
  instead of added again - each add made Firefox compile the session rules anew - and a
  second request waits until the browser took the first.
- **A stream detected with no player tab to send it to** queried every tab
  (`sendSourcesToMainFramePlayers`, for each segment a page's own player fetched).
- **Heartbeats every 5 s, not 1 s** (opfs-worker, IndexedDB temporary databases): a file
  opened, written and closed, or a transaction, each second for every player page's life.
  Only `prune`'s 60 s staleness window reads them.
- Small: an IndexedDB request's timeout timer is cleared once answered; `chooseToRelease`'s
  second pass uses a Set (it was quadratic over the held fragments); the progress loop and
  the MP4 main loop reuse one bound function instead of making one per round.

Checked and not changed (the reason each time):

- **Update the toolbar icon only when a tab's URL changes** (`tabs.onUpdated`): Firefox resets
  a tab's own action title, badge and icon when the tab navigates; setting them on every
  update is what puts FastStream's state back whenever that reset lands. Changed on 2026-11-13
  after all, with the reset still covered: the listener hears `url` and `status` changes only
  (a reload's event need not carry the address), not every title, favicon and sound change
  (the review below).
- **Renew DirectVideoPlayer's header rule every 30 s instead of 10 s**: its comment's reason
  holds - a hidden tab's timer can be up to 50 s late, and the renewal has to land within the
  60 s rule.
- **Filter the detection listener by request type**: subtitle and file-extension detection run
  for every type before the type checks (a video in `<embed>`/`<object>` is type `object`), and
  `onBeforeRequest` has to see every request anyway (the frame tree, the VPN mirror), so the
  background is woken all the same. Not worth the risk of missing a source.
- **Run the start-up's storage estimate and buffer take-back while the player is built**
  (`setSourceInternal`): the order is what keeps adoption before the first download; not
  measured to be slow.
- **Re-index a fragmented MP4's samples only every 4th range**, **run the subtitle bounds
  check only when something changed**, **skip the silence skipper's checks while paused**,
  **cache each tracked source's URL shape** (`trimTracked`: a split and a replace, well under
  a millisecond per detected segment): small or unmeasured gains, each with a way to go wrong.
- HLSPlayer.currentFragment's fallback to `hls.loadLevel`: part of the start-up change measured
  and reverted on 2026-11-06 (above); the glm knowledge-base entry that described it is retired.

Second round (the save and storage modules, the repository's CI and tests, what runs on every
page; 2026-11-07):

- Changed: `MP4Merger.finalize` handed each chunk of the file to the OPFS worker through
  `toStandaloneBuffer`, which copied it once more - the whole file over, after the progress
  showed 100 %. `Blob.arrayBuffer()` gives a fresh buffer of its own, which goes as it is.
  Superseded on 2026-11-13: `MP4Merger` writes nothing at `finalize` any more. Each fragment's
  media goes into the save's file as it is read (`SaveFile`, as the HLS save below), and
  `finalize` only puts the moov in front (storage.md, "Storage in a private window").
- **An HLS save's chunks wait in RAM while the disk is slower than the conversion**
  (`hls2mp4.pushChunk` -> `FSBlob.saveBlob`, not awaited): measured and changed in the third
  round below (one file on disk as it goes). Reading the next fragment while the current one
  converts: done then too. Not changed: awaiting in-flight offloads in `FSBlob.clear()` (an
  orphan lives only until the session's directory is pruned).
- CI: the lint/test/build job takes 68 s. `verify:vtt` runs first since the third round;
  running lint and typecheck in parallel would save seconds, not worth interleaved logs; the e2e jobs (7-8 min) spend 17 s before the first
  spec, fixtures included, so caching fixtures or building one target per job is not worth
  the workflow. `isolate: false` for vitest would share module state and mocks between test
  files, for the Windows unit job that runs beside the e2e jobs and sets nothing's pace.
- Every page: `overlay-guard`'s second check spends its time in `getBoundingClientRect` per
  element (the comment's measurement), not in the allocations around it; `PLAYLIST_POLL`'s two
  walks of the page's links run ten times when a player starts; the gesture scan's 2 s cadence
  is load-bearing for the 5 s activation window.

Third round (2026-11-07): the trade-offs measured in Firefox (dev build, Windows 11, local
server) before deciding. Interleaved runs, a brief try before each long run.

- **HLS save of a long stream** (30 minutes of a 2 Mbit/s HLS stream, 1000 fragments, a
  458.5 MB file; RAM = what the save's blob stores held, sampled every 100 ms). Medians of 6:
  as Blobs until the end (before) 1118 ms, 454 MB held; one OPFS file written as it goes,
  flushed at its end, 1770 ms; the same without the flush, 1259 ms, nothing held but at most
  8 pieces on their way (`SAVE_APPENDS_AHEAD`, about 0.5 MB each here). Waiting for each
  Blob's write to the disk instead (backpressure): 1983 ms for a 90 s stream that took 74 ms -
  dropped after the brief try. Kept: one file, no flush (`saveEnd`: the file is only read
  back in this session; the flush served nothing and slowed the DASH and other saves too).
  Since 2026-11-13 a DASH or fMP4 save writes the same way, through the same code (`SaveFile`,
  taken out of `HLS2MP4`), and a save's copy on disk goes once Firefox reports its download
  over, not at the next player's start (storage.md).
- **The RAM budget stopped downloads ahead for good** (found by that measurement: the stream
  stopped downloading at 70 %, 153 of 200 MB held, nothing being written). Full from HIGH
  until back at LOW, it let go only over HIGH; the downloads that were running when it let
  go came in after and left it a little over LOW. While full it now lets go down to LOW
  (`keepWithinMemoryBudget`). With it, all 1000 fragments came in within 10 s.
- **A seek that loads afresh drops the MP4 appends still queued** (`dropQueuedMedia`). A seek
  far ahead with about 685 one-frame appends queued, n=8: playing again after 198 ms against
  232 ms (medians), first frame 117 against 129 ms. Queue peaks while playing: 2,000-3,000.
- **Build the seek preview's player lazily or alongside the start**, instead of before
  `play()`: no start-up gain, kept as it is. First frame / playing in ms, means of 4, network
  A (1.5 MB/s shared) and B (500 kB/s per connection):
  A mp4 487/581 eager, 512/606 alongside, 511/603 lazy; A ts 1005/1097, 1021/1114, 999/1092;
  A fmp4 1017/1103, 1013/1107, 998/1045; B mp4 1000/1109, 1001/1116, 1022/1116;
  B ts 2135/2229, 2153/2247, 2110/2204; B fmp4 2074/2167, 2072/2166, 2074/2167.
  The preview is ready 75-120 ms after `addSource`, long before the first frame.
- **Preview thumbnails only after their seek ended**: 32 frames in 12 s and none taken during
  a pending seek, old and new alike (Firefox's `readyState` gated it already); kept for the
  `toBlob` encoding.

## What an independent review of the player, background and content scripts found (2026-11-13)

Two Claude agents read the player's lifecycle and the background/content scripts for bugs of the
kind above; each finding was checked against the code and, where fixed, shown by a test that
failed before. Fixed:

- **The next episode's instructions reached a later, unrelated player.** After FastStream went on
  to the next episode by itself, its continuation (autoplay, the carried fullscreen, no
  remembered place) stayed on the tab until some player took it. A next page with no player (a
  failed hoster), then a page the user went to himself, and the next video opened there - minutes
  later - went fullscreen, played by itself and skipped its place. It now holds only for the first
  page after the click (`continuationArrived`; what counts as a page: the second round, below);
  MPV's own (`mpvNext`) is unchanged. The opposite
  case too: a next episode on another hostname lost it to the new site's reset; it goes along now.
  `backgroundFullscreen.test.mjs`.
- **Escape could not end a carried fullscreen whose player's frame went or reloaded.** The
  background passed Escape on to that frame, which was gone or held a new player that had never
  taken it over; the window stayed fullscreen. The player now answers whether it ended it
  (`exitCarriedFullscreen` returns true), and the background ends it otherwise.
- **The page around an embed kept its own menu hidden after the player left the embed** (the
  embed's page went elsewhere or took its player out, the iframe stayed): only the player's
  leaving page released the overlay guard. On a player frame's `FRAME_REMOVED` the background now
  tells each frame above to let go of the iframe on the way (`RELEASE_OVERLAY_GUARD`), unless
  another player still lives under it. `content-overlays.e2e.mjs` (failed on main),
  `backgroundOverlayGuard.test.mjs`, `contentScript.test.mjs`.
- **A player gone with its page was counted gone twice.** A frame that goes takes the frames
  inside it along; a player inside sends its own `FRAME_REMOVED` too, and it can come last. Its
  entry in `playerPageFrames` was still there, so it was taken for a player lost while Firefox
  had unloaded the background (`restorePlayerFrame`): made again with its page frame, and
  counted gone a second time. With two players in a tab, the next one to open was told it was
  the tab's main player. Every frame forgotten with the removed one now leaves
  `playerPageFrames` and `playingPlayers`. `backgroundFrameRemoved.test.mjs`.
- **Toolbar calls for a closed tab were rejected unhandled** (the "Off" badge's second, a start
  that waited for its page). They go through `setAction` (`BackgroundUtils.mjs`), which takes
  the rejection. `backgroundRobustness.test.mjs`.
- **A start by address was lost when only the part after `#` changed during its half-second
  wait** (a page setting `#t=...` at once): the wait checked the address string. The same page
  (`isSamePageUrlChange`) keeps it; a `#/` or `#!` route still cancels it. `backgroundMpv.test.mjs`.

A second round the same day went through the background, the content scripts, the options page,
the player and the saves area by area. What it fixed is recorded with its subject where the notes
have one (keybinds.md, storage.md, mpv.md, build-and-release.md, libraries.md, the sections above);
the rest is here:

- **The next episode's instructions count pages, not address changes.** The continuation (and,
  since 2026-10-11, the carried fullscreen's handover) ended at the second address change after
  the click, and a `pushState` or `replaceState` counts as one; only a `#` change was the same
  page. A next episode whose page set its own address before its player asked (`?server=`, a
  canonical slug) played with no autoplay and its remembered place, and the carried fullscreen
  went back to a window. The pages are now the documents frame 0 names (`FRAME_ADDED`,
  `noteContinuationPage`). The first after the click's address change is the next page, also
  when it named itself before its address came; a different one after it (the user went on, or
  back) ends the instructions and gives back a fullscreen no player took over. An address change
  still ends them while the next page has not named itself (an error page, a PDF: no content
  script), so the user's page after such a page gets none. The window follows the instructions:
  it stays fullscreen while they wait for the next page's player. `backgroundFullscreen.test.mjs`.
- **A player kept over a restart of the background counts as the tab's player.** After Firefox
  unloaded the idle event page while a player played, a second player in the same tab was told
  it was the main player and played without a click: `restorePlayerFrame` made the frame a
  player's again but did not count it in `tab.playerCount`, which `acceptPlayer`'s `isMainPlayer`
  goes by (its leaving still counted it gone). Both now count the frame when it becomes a
  player's, so a frame restored and then loading its player anew is counted once.
  `backgroundFrameRemoved.test.mjs`.
- **`tabs.onUpdated` hears the address and the load's status only** (`{properties: ['url',
  'status']}`; `url` since Firefox 88, the floor is 153). Unfiltered, every title, favicon and
  sound change of every tab (a site's title counting its player's time up) set the toolbar
  button's title, icon and badge again and kept the event page awake. Firefox resets a tab's
  own button state on a new document, which comes with its address; `status` stays in because a
  reload resets the button too, and its event need not carry the address it already had (with
  the address alone the button could stay reset). The test harness's stand-in honours a
  listener's filter. `backgroundRobustness.test.mjs`.
- **What the background fetched for a private window's or a container's tab** went with the
  normal window's cookies, cache and proxy: FreshLink gives no link there now, and the length
  reads keep nothing in the HTTP cache (`cache: 'no-store'`). storage.md, "Storage in a private
  window".
- **A crafted manifest could hold the event page.** `StreamLengths` reads up to 4 MB on the event
  page's thread, where `SourceLengthWaitMs` cannot stop a parse, and its patterns looked from
  every tag (every character of a name) to the end of the text: an MPD of `<AdaptationSet>` tags
  never closed, of `<MPD` or `<Period` never ended, a tag of a megabyte of name characters, or a
  master playlist of thousands of `EXT-X-STREAM-INF` lines and one URI. 1 MB took 1.6-8 s, a run
  of names of 80 KB 4-7 s. Tags are now found one after the other with `indexOf` from where the
  last ended (none after one that has no end), a name is read from its first character only (a
  lookbehind, the same matches), and the STREAM-INF tags before one URI share one search for it
  (each copied the lines after it). 1 MB of each takes under 12 ms. A differential fuzz against
  the old code agreed on 200,000 inputs for each function. `StreamLength.test.mjs`.
- **URL lists: a plain entry matches the page's host, not a user name.** A plain entry
  `example.com` on the Auto-enable URLs list or the MPV allowlist matched
  `https://example.com:x@evil.com/`, a page of evil.com: the entry was compared with the raw text
  after the scheme, and the ':' after the user name read as the start of a port. The page is now
  read through `URL`, its user name and password taken off, and compared from its host on as
  before; for every address without a user name the result is the same (checked against the old
  code on 580,000 address and entry pairs, addresses as Firefox writes them). **Behaviour
  change:** a page of the site itself with a user name before its host (`https://u:p@example.com/`)
  now matches the site's entry; it did not before. And a site typed in Unicode (`bücher.example`)
  matched no page, as Firefox gives a tab's address with its host in punycode
  (`https://xn--bcher-kva.example/`): a plain entry's site (the part before its first `/ ? # :`
  or `@`) now goes through `URL`'s hostname when it holds a non-ASCII character. An ASCII site,
  one that does not parse, and the rest of the entry (port, path, query) stay as written; a
  `-domain` entry went through `URL` already. `UrlMatchList.test.mjs`.
- **A stream's pieces are not read, nor scraped for captions, one by one.** A page whose own
  player fetches a stream's pieces named `.mp4` (`seg-14.mp4`, thousands in an evening) made each
  piece a source. In a tab that is on, each was read in the background (a 64 KB range request,
  and a session header rule added and taken away), though `lengthsOf` already counts an unread
  file of a piece's shape as a piece; in any tab each asked the page for its `<track>` captions,
  and content.js walked the page and fetched every `<track>` file again. A file `lengthsOf`
  counts as a piece is not read when it is detected; a pick that waits for the lengths
  (`settle`) still reads it then, as for any unread source. A file of the shape of one the frame
  holds already waits for the captions' answer asked at the first, in the same page; a stream of
  another shape, or the next page, asks again, and the player still opens only after that
  answer. `backgroundDetection.test.mjs`.
- **An options save gives Firefox the redirect rules only when they change.** Every save made
  the background load the options again, and each load set both "use the player for stream
  links" rules again (`declarativeNetRequest.updateDynamicRules`), unchanged: some 120 updates
  of the browser's rules for a slider dragged for two seconds. The background keeps each rule as
  it last gave it, for as long as it runs (`RedirectRulesMade`: the rule's JSON, or removed), and
  leaves out an update that would give the same. The first load of each background still gives
  both, and a failed update is forgotten, so the next load tries again.
  `backgroundRobustness.test.mjs`.
- **A link the page handles itself keeps the player** (content.js). A click on a link to another
  page of the site took the player down before the page's own listeners ran, so a same-site link
  the page cancels (a "Sign in" that opens a dialog, comments paged in place) removed the player
  though the page never left. The decision now waits one task, as the cancelled-shortcut
  listener does: the player stays only when the page cancelled the click and did not change its
  address meanwhile (a single-page site's router still takes it down). `contentScript.test.mjs`,
  `content-cleanup.e2e.mjs`.
- **The resource observer keeps the newest 1,000 requests, manifests last** (content.js; added
  2026-10-03 for #231, so that the recovery after a background restart finds a stream past the
  first 250 requests the page's Resource Timing keeps). It kept the first 1,000 stream-like
  requests and nothing after them: on a page that lives long (a single-page site going on to its
  next episode) the recovery found no stream, or the previous episode's. When full it now drops
  the oldest request that names no manifest (by its path, or by an address a proxy's query
  names), so a manifest asked for once stays past the thousands of segments its player asks for
  after it. `contentScript.test.mjs`.
- **Fullscreen of a linked iframe in a shadow root** (open or closed: the frame links find embeds
  there) is asked of its own root. `document.fullscreenElement` is the root's host there, not the
  iframe: the toggle entered fullscreen again instead of leaving it, and `fullscreenchange` told
  the player it had left as it entered, so it left at once. Each of the three checks asks
  `getRootNode().fullscreenElement`, which is the document for any other iframe.
  `contentScript.test.mjs`, `content-cleanup.e2e.mjs`.
- **The miniplayer's placeholder is a `<div>` for an iframe or a custom element.** It was made
  with the miniplayer element's own tag: for the player's iframe itself (the usual soft replace)
  a new iframe, a browsing context of its own, for each miniplayer; for a site's custom element
  wrapper the site's constructor and `connectedCallback` ran again, a second copy of its player.
  `transferStyles` sizes the div as before. Any other wrapper keeps its tag, so the page's rules
  for it still hold the layout. `contentScript.test.mjs`.
- **Typing in a shadow root or in a chat's iframe counts as typing.** After FastStream goes on to
  the next episode by itself, the new player takes the keyboard (`REQUEST_KEYBOARD`, main.mjs;
  reported 2026-10-11: F, Space and the arrows did nothing on the next episode until a click in
  the player) unless the user types in the page or looks at another tab (content.js
  `PAGE_TYPING`, asked of the top frame). It looked at `document.activeElement` only: typing in
  a web component's field (`activeElement` is its host) or in a chat's or comment box's iframe
  counted as not typing, and the player took the keyboard mid-word. It now asks the overlay
  guard's `focused()`, which goes into open and closed shadow roots, and counts an iframe with
  the focus as typing unless it is a FastStream player's or one a player plays in.
  `contentEpisodeNavigation.test.mjs`.

Found and not changed yet:

- MP4 and DASH seek previews restart the hovered range's download on every pointer move while it
  loads (HLS has a guard: `HLSPlayer`, "a pointer still inside the segment that is loading");
  the DASH preview buffers 10-18 s at each hovered place, HLS's 1 s. Not a copy of HLS's guard:
  skipping `resetHLS` for a place inside the range on its way leaves mp4box at the last place's
  sync sample, so a place before it in the same range would get no samples. Needs its own
  design (mp4box's seek point) and a slow-line A/B (`tools/bench-ab.mjs --rate`); on a local
  file the preview is ready in about 35 ms.
- An iframe the page takes out (no `beforeunload`) never sends `FRAME_REMOVED`: its frame and
  sources stay in the background until the page navigates. Memory only; nothing acts on them.
- Synced audio (a video delay set) follows play, pause and seek made on the element itself -
  Firefox's picture-in-picture window - only at the next `watcherLoop` round, about a second
  later; media keys go through the client and are followed at once. Forwarding the element's
  own events has to keep the resync guards (`SyncedAudioPlayer.test.mjs`: a pause during a
  resync, a resync after destroy) and wants a test of its own.

## What a third review found (2026-11-14)

Six agents read the branch against main (buffering, the background and content scripts, the
player core, the interface, the tools and workflows, and the reload report above). Each finding
was checked against the code; what was fixed has a test that failed before.

Regressions of this branch against main, fixed:

- **A player opened on a page that had played for a while read up to 19 stream pieces first.**
  The branch stopped reading each `.mp4` piece as it is detected (below, "A stream's pieces are
  not read ... one by one"), and `StreamLengths.settle`, which a player's request for the page's
  streams waits on, then read every one of them, four at a time. It reads only the newest unread
  file of a shape that was read as a piece (`unreadOf`): the one that would play, were it a film
  after all. `StreamLengths.test.mjs`.
- **A second video named like the first got the first one's captions.** The captions on the
  page are asked for once per stream, and "the same stream" was any file of the same shape
  (`lesson-1.mp4`, `lesson-2.mp4`). Now not when one of that shape was read as a film; where none
  was read (a tab that is off), a file counts as the next piece only within 15 s of the last
  (`isRepeatPiece`). `backgroundDetection.test.mjs`.
- **A carried fullscreen stayed on a page that never names itself.** The next episode's page
  named itself, no player took the fullscreen, and the user went on to a PDF or an error page
  (no content script): the window stayed fullscreen. The instructions now end when their page
  leaves the tab (`FRAME_REMOVED`) or at the first address without it, whichever comes first
  (`endContinuation`). `backgroundFullscreen.test.mjs`.
- **MP4: a start set before the element had data reset the player twice.** The mark that tells
  a seek made through the setter from one the element makes itself (`ownSeek`) was no longer set
  at `readyState` 0, so the element's seek to that start, once it had its metadata, was taken for
  a foreign one and aborted the range just asked for (a seek preview pointed at while it loads, a
  sound set to start late). Set again for a start past 0; a start at 0 still sets none (no seek
  follows, and the stale mark was the bug fixed on 2026-11-13); dropped at `loadeddata` if no
  seek came. `mp4OwnSeek.test.mjs`.

On main as well, fixed:

- **A fragmented MP4 in a download window stopped downloading ahead after 19 s.** A player that
  does not keep the whole video (a private window, "download all" off, a video too large) keeps a
  window around the playhead, by the fragments' times. A fragmented MP4's ranges have times only
  once parsed; those downloaded ahead have none (-1), and counted as long behind the playhead
  once that passed 19 s: no download ahead started any more, and each range downloaded ahead was
  let go of at the next tick. The file came on the player's own connection only. Such a range is
  now placed between its parsed neighbours, or after them at the pace they had
  (`network/UntimedSpans.mjs`); one nothing places yet is downloaded and kept. The RAM budget's
  branch for them asked for "not finite" and never ran (-1 is finite): `isTimed` now.
  `UntimedSpans.test.mjs`, `FastStreamClient.test.mjs`.
- **An HLS segment whose connection went dead held playback for two minutes.** hls.js gives its
  loader the longest a whole load may take as `timeout` (120 s for a segment), and `FetchLoader`
  takes `timeout` for how long nothing may come. `HLSLoader` caps it at the 30 s every other
  download has (`STALL_TIMEOUT_MS`). The retries are as they were, and not as this file said
  above until today: a segment hls.js asks for itself goes with hls.js's `maxRetry: 0`, so
  `FetchLoader` does not retry it; `HLSLoader` reports each failure to hls.js, which asks again
  (twice as an abort, then as an error, its own policy from there). The six retries are those
  of a download ahead and of DASH and MP4. `HLSLoader.test.mjs`.
- **A player whose disk folder another player deleted stored nothing on disk any more.** A live
  session with no heartbeat for a minute (the computer slept) is a dead one to the next player
  that starts, which deletes its OPFS directory (`prune`). Every write of the session failed
  from then on. Its directory is made again at the next write or heartbeat (`sessionFile`); what
  was in it is downloaded again as it is needed (lost data was handled already).
  `opfsStorage.test.mjs`.
- **Escape did nothing in a dropdown's name field** (the sound profiles'): it goes on to the
  player now, as from its other fields. `playerFieldKeys.test.mjs`.
- **A link opened by the web player had the player as its opener**: `noopener`, as the update
  notice's link had before it came through `EnvUtils.openExternalURL`. `EnvUtils.test.mjs`.
- Tools: `verify-linux.mjs` ended with 0 when its script could not be started or was ended by
  a signal; the dev launchers the same; `cut-release.mjs` refuses another branch than main
  before it commits (release.yml refused the tag only once it was on GitHub); the launchers say
  so on a newer Node than `.nvmrc`, where web-ext could not connect to Firefox (Node 27).
  `localeKeys.test.mjs` now reads `data-i18n-placeholder` too.

Two fuzz tests came with it (fast-check). `backgroundMessages.property.test.mjs`: any sequence
of the messages a content script may send, with any contents, from any frame or tab, throws
nothing in the background, and a page that plays a stream afterwards still gets its player; no
message that only FastStream's own pages may send does anything from a content script; and
`backgroundMessages.test.mjs` now says a type is open to content scripts only when one sends it.
`untrustedInput.property.test.mjs`: the small parsers of a file's first bytes, an answer's
headers, an address, the user's site entries and a page's title take any input, answer in the
shape their callers read, and take no time on 100,000 characters made to backtrack. Neither
found a bug; a throw planted in `FRAME_ADDED` was found at the first try.

Looked at and left:

- Starting the downloads ahead at once after a seek, not at the next tick or finished
  download (up to 1 s later): started before the player's own request for the segment at the
  new place, they would make that segment a download ahead (`'auto'`, not `'high'`).
- The key a kept buffer waits under (`BufferStash`) has no tab in it: of two tabs with the same
  video on the same page, loaded again within the same 20 s, one takes the other's buffer and
  the other downloads again. With the tab in the key, a tab closed and opened again (a new tab
  to Firefox) would never get its buffer back, which is the commoner case.
- The disk space a player plans with is read once, when its video starts, and each player
  plans with 60 % of what was free then: several large videos on a nearly full disk could plan
  for more than there is. Not reproduced; a write that fails is handled (the fragment is
  downloaded again when needed).
- After the event page was started again, the first player of a tab is counted only at the
  tab's next message, not at its `PING` (a reviewer's finding, on main as well; its effect was
  not looked into, and nothing was changed).
- The progress bar's width is written at every video frame of a video under 5 minutes (so a
  short clip's bar moves evenly), four times a second for a longer one: by design.
- Loading `sortable.mjs`, the subtitle search and `gif.mjs` only when first used (176 KB of
  1.4 MB the player loads at its start): not measured and not built. Each is a way for a menu
  to open late, and what it could save is the parsing of an eighth of the player's code.

## The polish round (2026-11-15)

What the review of 2026-11-14 left open, done or measured on main, before the review round of
2026-11-17.

- **An MP4 start that gets nowhere no longer runs its loop every millisecond.** While the
  player waits for its first frame (`needsInit`) the main loop ran at the urgent pace (1 ms,
  4 ms in Firefox) for as long as it took, and for good when the element could not decode the
  data. It runs so only for 2 s after the start last got somewhere - an append (`updateend`), a
  seek, a play - and then at the steady 50 ms; `loadeddata` and each append wake it at once.
  `LoopPace.mjs` holds the choice (`LoopPace.test.mjs`). A/B against main
  (`tools/bench-ab.mjs --scenarios mp4`, 7 rounds), with the files local and on a 12 Mbit/s
  line with 150 ms to the first byte: every measure "same" (first frame 562/561 ms local,
  887/879 ms slow; seek to 80 s and playing past it 349/350 and 1839/1851 ms; wake-ups while
  playing, paused and ended 25.0/9.5/9.4 a second on both). The change is for a start that
  never gets its first frame, which the benchmark does not play.
- **A fragmented MP4's keyframe index takes in only the new samples.** `refreshSampleIndex`
  filtered and sorted every sample of every track again after each range: 7.7 ms a range on a
  2-hour file (Node, synthetic samples: 216,000 video, 338,000 audio, every audio sample a
  keyframe), on the player's thread. `addKeyframes` (`SampleIndex.mjs`) sorts in only what
  mp4box added since: appended when it all comes later (a file played on: about nothing),
  merged in otherwise (an earlier part read after a seek back: 0.75 ms). mp4box builds a
  track's list once, at the moov, and only appends to it, so the result is the full sort's,
  ties included (`SampleIndex.test.mjs`, a property test). `setFragmentTimes`, run with it,
  stays linear in the samples (a binary search per range, then the range's samples).
- **One fragment status for the three requesters.** DASH's, HLS's and MP4's fragment requesters
  kept a fragment's status in three copies of the same 40 lines; `players/FragmentStatus.mjs`
  holds it (`FragmentStatus.test.mjs`). DASH's `preProcessFragment`/`postProcessFragment`
  hooks, which no player had, are gone from `DashFragmentRequester` and `DashLoader`. Their
  postProcessor stays as one that changes nothing: a download with none keeps its pieces for a
  watcher that might join on the way (`DownloadEntry.onChunk`), and nothing reads a DASH
  download's, so it held a second copy of each while it loaded (`DashLoader.test.mjs`).
- **A dropped `.fsa` archive is read from the File.** `parseFSAFile` fetched the file's own
  object URL in Range requests (`RequestUtils.httpGetLarge`, its only use, now gone) and read
  the length back from `Content-Range`; it reads `file.slice()` chunks now, the next one
  ahead as before.
- **PC-4, measured and not built.** A body read in 64 KiB pieces and joined at the end holds
  its bytes twice at the peak; one buffer the size of the `Content-Length`, written in place,
  was to hold them once. Measured in Node with a 64 MB body: the peak was 128 MB as it is and
  123.8 MB written in place, the time the same. The pieces are freed only at the next garbage
  collection, which comes after the copy either way, so the body is in memory twice all the
  same.
- **CS-7, measured and left.** The content script walks the page and its shadow roots on a
  click or key (at most every 2 s, in the frame that got it). In the page's own realm the walk
  takes under 1 ms for 10,000 elements, 2 ms for 50,000 and 15 ms for 200,000; from the
  content script (through Xray wrappers) 3, 17 and 72 ms. Asking only for open-or-closed shadow
  roots, or a live `getElementsByTagName` list, changes nothing (4/18/80 and 3/17/69 ms): the
  cost is the iteration. A walk spread over idle time could miss a play that comes right
  after the click, which is what the walk is for.
- **Zero motion, in the stylesheet itself.** `fluidplayer.css` declared 20 transitions and 2
  animations (and the "shaking" keyframes) that the global override cancelled; they are gone,
  with the rules and selectors nothing in the player uses (`.no_volume_bar`, the playback-rate
  menu's, the pseudo poster, `.freeze`'s buffered bar), and `options.css`'s `#submitter`.
  `playerA11y.test.mjs` now fails on any transition, animation or `@keyframes` that is not
  `none`. The locale key `options_general_vischangeaction_pip` (a choice removed long ago) is
  gone from the 16 locales.
- **SEC-3**: `patched-libraries.yml` in two jobs (`docs/notes/workflows.md`, "Patched libraries:
  two jobs").
- **R-1** was done already: `update-prs.yml`'s concurrency is per job.
- **A second review of the round's diff** (the Claude API, with the changed files): seven
  claims, each checked against the code and each real - the rename, cache and pull-request read
  of SEC-3 above, the DASH pieces above, two in `tools/same-code.mjs` (a template's raw text, a
  name not in ASCII) and a motion check that saw shorthands only. All fixed, with a test each
  that fails without its fix. Writing `same-code`'s own test found one more: a removed
  statement was reported at the enclosing node's line.

The second pass: the three largest files, each reviewed whole through the Claude API (with
line numbers), every claim checked against the code. Fixed, each with a test that fails
without its fix (but one):

- `FastStreamClient`: `wantsNetwork` read a fragment without times as -1, behind the
  playhead, where `predownloadFragments` places it (`windowSpan`): a background player told
  its peers it wanted nothing it would download. "Buffer ahead" is taken anew each tick in a
  private window, for a live stream and without a bitrate: the fit in the RAM share only
  lowered it. The seek preview's context is stored with the preview it belongs to: a build for
  a replaced video took it over, and its error destroyed the shown preview. A player that
  could not take its source lets go of its listeners and its once-a-second wait for a picture.
- `content.js`: an exit asked of a windowed fullscreen or miniplayer never entered entered it;
  the pop-up guard missed a player in a shadow root, the pending-player watch missed one taken
  out of a shadow root, and the link-click check missed a link inside one (composedPath);
  "Display", "Autoplay", "Replay", "Playlist", "Playback speed" and any "player-..." class were
  clicked as play buttons (`saysPlay` takes those words out, in any case, and looks for "play"
  in what is left: "playbtn", "bigPlay" stay); a redirect to the player that did not happen
  stopped every later leave report (the redirect now owns only the first `beforeunload` after
  it, not a time: an old page that unloads slowly must not report itself gone);
  `pauseAllWithin` and `loadedMedia` skipped closed shadow roots. The test page
  (`contentDom.mjs`) now runs an observer only for its own tree, as Firefox does.
- `background.mjs`: "Clear Sources" in a player tab was undone by the next stream another tab
  found (the tab keeps the entries other tabs held at the clear, not a time: a page's report
  keeps its request's time); "Open link in player" went to MPV on an allowlisted site, also
  through a first `about:blank`; an Off whose question to the tab outlasted an On clicked
  meanwhile reloaded that On's player away (no test: the question waits only after a restart);
  the next-episode request of a player in a top frame was asked of the player itself.

The fixes themselves went through a second API review. Kept from it: the play-button words, the
clear by entries, the redirect's `beforeunload`, the `about:blank` step, and the preview's
context let go of when the preview is switched off. Dropped: a next-season link put into the
page so it could navigate. A link out of the page navigates by the HTML spec (only other
elements must be in the document), and in the page it passed through the page's click handlers.

Checked and not real: page qualities and fresh links carrying a source's headers elsewhere
(the background keeps both to the source's host); a `resetPlayer` that rejects (`FSBlob.clear`
never does); the container download's 30 s timeout during a save (the player answers at once,
`forceDirect`); unguarded `localStorage` (only the unhosted web build could refuse it).

Looked at and left:

- Two parent walks in `content.js` differ (`getParentElement` the light tree, `flatTreeParents`
  the flat one): which element the miniplayer takes would change with them, a behaviour change.
- A tab closed in the milliseconds of a cold start's storage read can have its state saved
  back once: a stale entry, nothing more.

- `SaveFile.add` copies a view of a fragment (`slice()`) before handing it to the OPFS worker:
  the worker takes the buffer (transferred), and the fragment's buffer holds more than the
  mdat. Writing a view in the worker would spare one copy of each fragment, a memcpy of a few
  MB, for a change to the worker's protocol.
- The progress bar reads every fragment of the level per fragment event (about two a
  fragment) and writes the DOM only where something changed.
- Skipping a `saveTabState` write whose state is the one written last: most writes come with
  an address change, and the address is part of the state.
- The settings sliders save once a frame while dragged (OP-6) - not at every input event, as
  the review of 2026-11-14 had it.
- `content.js` keeps a copy of `SubtitleUtils.decodeSubtitleBytes` and `MpvTarget.mjs` builds
  what the mpv helper built until host 14, byte for byte: a classic script cannot import a
  module, and the helper is a program of its own. Each copy has a test that keeps it the same
  (`decodeSubtitleBytes.test.mjs`, `MpvTarget.test.mjs`).
- The site scripts in `chrome/custom/` (bilibili, Facebook, Instagram) are still in the
  manifest. Retiring them once the general detection is shown to play those sites (the owner's
  rule of 2026-10-28) needs those sites tested, signed in: for the owner.

## What glm's review of MPV mode found (2026-11-16)

- **MPV autoplay leaves a tab that went on to another site alone.** The user can take the tab
  of mpv's stream to another site while mpv plays. The episode's end (or mpv's next key) then
  asked that site's page for its "next" link and clicked it: the user's page went away under
  them, and its video replaced the series in mpv. The watch now keeps the site the stream went
  from (`MpvWatch.site`, its host). On another site, the episode the series' page linked to
  opens in a tab that is not shown, as for a closed tab (his wish of 2026-10-27,
  `goToEpisodeFromSiteLeft`), and the countdown does not ask the foreign page either. A host,
  not a page: the series' next page, a reload, and an address the site's script changes all
  stay on it. Tests: `backgroundMpv.test.mjs`, "goes on the same way when the tab went on to
  another site" and its control.
- **`mpvStandInPage` and `mpvPage` are kept over a wake** (`PersistedTabFields`). Without them, a
  woken background took the toolbar's click on an On that stands in for MPV (#671) for On -> MPV:
  the page reloaded, and Off came one click late. Test: "turns the tab off at the toolbar's next
  click after Firefox stopped the event page too".
- Left as they are: the episode links read at a hand-off are dropped when the tab closes during
  the read (a second at most, before mpv's window is even up); a hand-off that throws keeps
  `mpvAutoOpened` (no reachable throw: `tabTitle` catches, and the hand-off answers `{ok: false}`);
  `watchNextEpisodeArrives`' timer dies with the event page (only its "no stream" note is lost).

## The whole-repository review, second part (2026-11-16)

The rest of the repository read through by me and, file group by file group, by glm (UI,
menus, subtitles, utils, options, players, release tools, workflows, storage, the saves'
remuxers, vtt.js). Kept only what the code proved; each fix has a test that fails without it.

- **A source's headers stay on its own site.** The headers captured with a source (its Cookie
  among them: Firefox's webRequest gives it) went with every request the loaders made for it,
  also to a segment, key or playlist on another site (a CDN, a key server). Now
  `sourceHeadersFor(source, url)` (`VideoSource.mjs`) gives them only for a URL on the
  source's own site (`siteOfHost`: the last two labels, three under a public second level such
  as `co.uk`, a trailing dot dropped first), and the headers without credentials otherwise. Used by `HLSLoader`,
  `HLSFragmentRequester` (segments and keys), `DashLoader` and `DashFragmentRequester`.
  Test: `sourceHeaders.test.mjs`.
- **The settings file:** the export left out nothing, the mpv path too (it names the Windows
  account); an imported `keybindsVersion` above this build's was kept, and no later layout change
  ever applied; an imported number only had to be a number (-5 GB of RAM, an Infinity of
  buffer, a zoom of 1e9). `options/SettingsFile.mjs` does all three. Test: `SettingsFile.test.mjs`.
- **Long or hostile input:** `page-qualities.js` built a URL for every `<source>` of a page
  (now it stops past its maximum); `xml2vtt` sliced the rest of the cue list for each cue with no
  end (150,000 cues: 7.7 s, now 0.1 s). The error report put the whole stack into the issue's
  address (52,777 characters, which GitHub refuses) with the extension's install id; it is
  clipped, and the id replaced.
- **UI:** a click on a source that is still loading started it a second time
  (`SourcesBrowser`); a volume changed before the stored one was read was overwritten by it
  (`VolumeControls`); GIF recording in a background tab never ended (no rAF there) and a
  tainted canvas threw out of the loop (`LoopMenu`); the subtitle syncer drew bars before the
  video had a length (`SubtitleSyncer`).
- **The saves:** data no demuxer takes failed with "Cannot read properties of undefined
  (reading 'demux')" (the transmuxer dropped its own error).
- Not changed, and why: an fMP4 HLS level never reaches `samplesFromMoof` (HLSPlayer routes it
  to DASH2MP4), so a packager's trun flags cannot fail there; dash.js's `processCues` (vtt.js's
  `determineBidi` recursion) runs only with a rendering div, and none is attached. (vtt.js's
  parse per text and its region scan: fixed the next day, below.)
- **Dead code and repeats** (a scan of every first-party export and file, and of runs of 8+
  repeated code lines): gone are `npmLockVersions` (security-overrides; no caller, the repo's
  lockfile is pnpm's), `compareFiles` (ast-compare; every user imports `compare`) and the host's
  `allowedIpcCommand` (only a test called it; host 23). One function each now does what two
  copies did: the language filter of `LevelManager` (`bestLanguageMatches`) and the host's
  answer for an open mpv (`answerOfOpenMpv`, launchMpv and playMpv). Kept as copies on purpose:
  the BOM/charset sniff in `content.js` and `SubtitleUtils` (a classic script imports nothing),
  `withFragmentTag` in `MpvTarget` and the host (the host is a program of its own). No file is
  unreferenced. (The two analyzers' start: shared the next day, below.)

## What glm's review of the download layer found (2026-11-16)

- **A queued download whose last request gives it up leaves the queue at once**
  (`DownloadManager.letGo`). hls.js and dash.js give up their segment at a seek. When that
  segment was still waiting in the queue, `abortWatcher` marked it failed but left it there, and
  `canGetFile` refused every download ahead until a finished download moved it to the head.
  `removeFile` already took entries out this way. Test: `DownloadManager.test.mjs`, "leaves it
  when its last request gives it up".
- **An error answer's unread body is cancelled at once** (`FetchLoader.loadInternal`). A
  retry's teardown aborts its attempt, but a final error (a 4xx, the last try) held the body,
  and with it the connection, until garbage collection: once per fragment of a link that ran
  out. Test: `FetchLoader.test.mjs`, "lets a final error's unread body go at once".
- **What was pinned when the room ran out still goes to disk.** `updateHasDownloadSpace` pins
  every downloaded fragment (GRANDFATHERED) so that it is not deleted. `keepWithinMemoryBudget`
  then skipped those fragments entirely, so the ones held in RAM never left it, "full" stayed on,
  and nothing more was downloaded ahead for the rest of the video. Now they are spilled
  (written to disk), never freed. A fragment a save holds (SAVER) stays in RAM as before.
  Test: `FastStreamClient.test.mjs`, "writes what was kept for good ... to disk".
- Checked and left as they are: the MP4 player halving its read-ahead after a
  QuotaExceededError and never growing it back (the quota is fixed for the file's bitrate, so
  growing back would only hit it again); a Content-Range total over `MAX_FILE_LENGTH`
  (`lengthFromAnswer` already answers 0 for one).

## What the second review found in storage (2026-11-16)

- **The memory sink's save** (`StreamSaver.mjs`, a private window's streamed save) put a chunk
  the Cache API had let go of into the file as the word "undefined", behind a "Save complete":
  the guard `SaveFile` got for the same fault was missing there. Now the save fails ("A piece
  of the saved file is gone"). Test: `StreamSaver.test.mjs`.
- **`FSBlob.deleteBlob`** waits for the blob's write to end, then cleared the identifier again;
  a fragment downloaded anew under it in that time was lost and downloaded a third time. Now a
  blob saved again meanwhile is the new save's, and stays. Test: `opfsStorage.test.mjs`, "does
  not let a delete take away a fragment saved again while it waited".
- **IndexedDB at unload:** the beforeunload loop closed the databases over the list `close()`
  splices, and skipped every second one. It runs over a copy. Test: `IndexedDBUnload.test.mjs`.

## The background audit, MPV mode (2026-11-17)

- **A hand-off still being prepared sends nothing once its page, its tab or MPV went.**
  `openInMpv` waits up to 1.5 s for a master playlist's read (`hlsQualityChoice`), and the
  allowlist sends a page's first stream at once. mpv then started for a page the user had left,
  a tab they had closed, or after they turned MPV off. The caller notes the tab as the hand-off
  begins (`handOffStillWanted`, before its first await), and `openInMpv` asks right before
  `Mpv.openStream`; the player's own button has no such check. The page counts as left only
  with a new document in frame 0: an address the page sets itself (pushState, `?t=`) counts a
  new `mpvPage` too, and its stream was dropped (the Claude API review of #738). The answer
  `{ok: false, dropped: true}` is dropped by the callers: shown, Off put a "!" on the button.
  Tests: `backgroundMpv.test.mjs`, "a hand-off still being prepared ...".
- **A repeat play during an unanswered send no longer pauses the page.** The MPV key's repeat
  rule paused at once; when mpv then failed (no helper, copy-protected, Firefox VPN), the page
  stayed paused. A success pauses the page anyway (`pauseAfterHandOff`). The mark is kept in
  memory only: after a wake, a repeat pauses as before. Test: "the same video played again
  while its send is answered".
- **MPV autoplay's next episode on another allowlisted site goes through its pick.** The
  allowlist's start by address (500 ms after the address change) sent the newest stream, an
  ad's, before `pickNextEpisodeForMpv` had the lengths; the episode was then dropped. Test:
  "sends the longest stream of a next page on another allowlisted site too, not its ad".
- Rejected: the player button's 3 s repeat guard ignoring the tab and start time (a repeat
  click on the same stream within 3 s is what it guards against); a stale `time-remaining`
  reply ending the next file (the helper relays commands and events over one mpv connection,
  and mpv answers `get_property` synchronously, before any later event).

## The final review of the whole repository (2026-11-17)

Codex read the MP4 player and the tab turns, Claude's API reviewer the diff. Each fix has a test
that fails without it.

- **A range's whole answer gets the same start check as its pieces.** `feedPiece` refused a 206
  whose `Content-Range` starts elsewhere than the range asked for, but the finished range's
  handler then appended the whole answer at the asked place (its fed bytes were 0). It now plays
  the file directly (`RangeAnswers.startsElsewhere`; `mp4FileLength.test.mjs`).
- **A file that ends without a moov is an error**, not a wait for good: mp4box reached the end
  without metadata, the last range was counted as read, and `runLoad` found nothing more to do
  (an interrupted recording: `ftyp` and `mdat` only).
- **A fragmented file without `mehd` ends where its last sample ends** (`sampledDuration`): the
  summed sample lengths left out the first moof's `tfdt`, so a file cut from a longer recording
  (10 s to 12 s) said 2 s. The edit list's start is taken off, as Firefox's demuxer does
  (`Edts::mMediaStart` in `MoofParser.cpp`); its empty-edit delay is not added.
- **A regular MP4 that keeps its audio apart from its video plays directly** (`apartBy`, more than
  5 s apart at the start). The ranges take their times from the video and are read no further
  than `maxBufferLength` past the playhead, so the audio stored after all the video was never
  read, and nothing played. Reading each track's ranges by its own times would let FastStream
  load such a file in ranges too; no such file has been reported, so it plays directly. Only the
  audio track chosen at the start is checked: a file whose other language track alone is stored
  apart still stalls after a switch to it.
- **Only a finished speed test tells the other players a server limits each connection**
  (`DownloadManager.perConnectionFound`): a test cut short by failures or a removed downloader
  kept the guess of its last round (follow-up of the tab-turns fix above).
- **Two `DownloadManager.reset()` calls that overlap add the downloaders of the newest only**:
  both waited for the storage to clear, then both added theirs.
- **content-cleanup's bfcache tests try a round up to three times** (`untilCached`). Firefox keeps
  a replaced load's request in the docshell's load group ("Save of .../cleanup blocked because
  document has request .../clip.mp4", CI run 44121075279), so now and then the page is not cached
  through no fault of the extension's. A repeated round goes into `logs/retried.jsonl` as suite
  `classic-<build>-bfcache`, so the weekly flaky-specs issue counts it.

## The background audit, player (2026-11-17)

- **Length reads send login headers only to the master's own site** (`sourceHeadersFor`, as the
  player does): a variant on another host got the master's Cookie and Authorization.
- **A refused header rule no longer fails a length read.** Firefox refuses a `set` with no value
  (`header-rules.e2e.mjs`); the read then went unread, and the stream was never marked
  copy-protected or page-only. It reads without the headers now, as `MpvSubtitles` does.
- **A header rule's `#fragment` is harmless.** Firefox 160 matches `urlFilter` against the URL
  with its fragment (`header-rules.e2e.mjs`, "a URL with a #fragment"), though the request
  never sends it.
- **Firefox VPN: a host whose proxy changes kind is listened for again.** The listener only
  covers hosts behind a proxy FastStream can copy (http, https); a host that went from MASQUE to
  https stayed out of it. Test: `VpnProxyMirror.test.mjs`.
- **TabTracker: a frame already forgotten is not forgotten again.** Firefox keeps a frame's id
  across navigations, so a late FRAME_REMOVED removed the frame's next document
  (`isTracked`). The saved states read at a wake no longer drop a player page frame noted
  meanwhile. Tests: `TabTracker.test.mjs`.
- Rejected: `DETECTED_SOURCE` without an address check (pages cannot send it; site scripts
  send only `data:` URLs); length reads shared across containers (the same URL, and the data
  stays in FastStream); an unbounded read queue (each URL is read once, pieces are skipped,
  every fetch ends within 8 s); `tabs.onUpdated` re-creating a closed tab (only the first
  `ensureOptions` after a wake, and the next wake prunes it); the container download's 30 s
  timer (the player answers right after its anchor click).

## The content-script audit (2026-11-18)

Three reviews (Claude API, Codex, glm in six parts) of `content.js`, the site scripts and the
small content scripts; each claim checked against the code, each real one fixed with a test
that fails without it.

- **Next episode by an "Episode N" list** needs this page's own link in the list. When none
  matched, every "Episode N" link was taken for the current one, and the first one's neighbour
  (episode 2) was followed from any episode.
- **The page's own `beforeunload`, `pagehide` and `pageshow`** (`dispatchEvent`, `isTrusted`
  false) are ignored: a page could make the background forget its frame and its streams.
- **The replaced element itself is paused** when it is the page's `<video>` (`pauseAllWithin`):
  `querySelectorAll` lists only what is below it, and the hidden original played on.
- **Leaving windowed fullscreen** gives an element its old `display` only while it still has
  the fill's `none !important`: a menu the page closed meanwhile came back.
- **The player's iframe is `box-sizing: border-box`**: it gets the element's outer size and its
  border, which made it larger by the border.
- **Page qualities resolve against `document.baseURI`** (`<base href>`), as the page's own player
  does, not against the page's address. A `<video>` with more `<source>` elements than a menu
  holds is not read at all (each read goes through Xray on the page's thread).
- **Episode words that are not ASCII** (`épisode`, `episódio`, `bölüm`) are matched in the
  decoded path (`decodeURI`, reserved characters stay encoded): the address gives them
  percent-encoded, and the series guard and the season's rollover were off on such sites.
  One back from episode 10 is tried as 9 and as 09. The changed number is written into the
  address's own path (`rawIndex` finds the same run of digits there), never the decoded one:
  the URL setter encodes again its own way (`%c3%a9` came back as `%C3%A9`, `%27` as `'`), and
  the candidates are compared with the page's links as they are.
- **The overlay guard** protects a layer only for a dialog in it that is shown: a closed one kept
  in the page (`display: none`) protected an ad layer for good. Shown is a box of its own or of a
  child, as an open `display: contents` dialog has only the latter. A dialog closed with
  `visibility: hidden` still counts: the guard hides layers that way itself, so a dialog opened
  in a layer it hid reads as hidden too, and must still give that layer back.
- **Instagram's fetch hook** copies no stream (`text/event-stream`, NDJSON, `json-seq`,
  `stream+json`): the copy of one that never ends was read and held for the page's life.
- Left as it is: a page that closes a menu with `display: none !important` during windowed
  fullscreen gets it back on leaving (the value is the fill's own; telling them apart needs a
  watcher on every element for a rare case).
- **REMOVE_PLAYERS' "no receiver"** is not logged: it goes to frame 0 at every address change,
  often before the next page's content script runs. This was the `Object { message }` seen in
  the console next to `remove_players`.
- Rejected, with the reason: the player iframe's entry kept after the page removed it
  (deliberate, `removePlayers` reports it; small); a click on a same-site link taking the player
  down before the page leaves (it lets the page into the back-forward cache; a link that only
  downloads gives the page its own video back); the closed-shadow-root video not taken over
  (the player goes only where open roots are, by design); Facebook and Instagram reporting the
  first new manifest of a batch (which one the player opens on a feed needs live tests);
  a descendant with `visibility: visible` in a hidden layer, media re-created inside a known
  shadow root, the opener key visible in the iframe's `src`, no flow control on page fetches
  (requests are segments or ranges), the hold released per frame (reverted design of
  2026-10-04), a hard-replaced bare `<video>` measured in place (hard replace only on twitch and
  vimeo, whose videos are wrapped), the miniplayer's whole-style restore (`updateMiniPlayer`
  rewrites it), and the input-time root scan (throttled to 2 s, and it must come before the
  play it is for).

## The player-core audit (2026-11-18)

Three reviews (Claude API, Codex, glm in seven parts) of `FastStreamClient.mjs`, `main.mjs`,
`VideoSource.mjs` and `SubtitleTrack.mjs`. Each claim was checked against the code, and each
real one is fixed with a test that fails without it.

- **A source change that a later one replaced while it waited its turn is skipped**
  (`setSource`). Before, it built its player, took the stashed buffer and could autoplay, only
  to be torn down.
- **What a rebuild keeps is armed by its own request** (`SourceStart`: `keepStorage`,
  `keepChoice`, `relink`, `rebuild`), in `setSourceInternal` before its reset. Armed by
  the caller, a rebuild that a pick replaced left them for the picked video's reset: its
  storage kept, the old version choice kept.
- **Autoplay and the remembered time.**
  - Autoplay that started at `canplay` while the player was still being set up was started
    again at the end of the setup, after the user had paused it.
  - A source with a remembered time (`storeProgress`) autoplayed from 0 and then jumped. It now
    holds like a source with its own time (`startPending`) until the lookup answers. The hold is
    at most `RememberedWaitMs` (3 s), because a blocked IndexedDB open never answers. A lookup
    that answers later is still applied, unless the user has sought meanwhile; skipped, the next
    save wrote the time played since 0 over it.
  - `disableLoadProgress` is now taken by the one source set for an episode the player went on
    to, and by the streams tried after it (`fallbacks.skipRemembered`). Before, it stayed for
    the client's life, and a source picked by hand later ignored its remembered time.
- **The reload without a failed codec** (`reloadWithoutFailedCodec`) builds the player again the
  way `recoverPlayer` does: at the second it was at, keeping what was downloaded
  (`keepStorageOnce`), with the audio track, and playing if it played. A codec that failed at a
  quality switch an hour in started the video over, paused, with the download deleted.
- **A player built again that fails before its first frame** is built again once more
  (`hasPlayed`). This is the "same broken place again" case that `BrokenMedia` skips past, which
  it never reached because the new source had not shown a frame yet. A source picked anew is
  not a rebuild: `playedSource` is cleared for it.
- **Live HLS.** hls.js gives a live stream a finite duration, so only `isLive()` tells.
  - `updateHasDownloadSpace` took a live HLS stream for a video that fits, so with "Download
    all" on nothing behind playback was ever freed.
  - Waiting at the live edge in its "last second" asked for the next video.
- **`play()` and `pause()` across a source change.** `resetPlayer` advances `playPauseTurn`, so a
  play that waited on the last source's player does not show "playing" over the new source.
  `pause()` pauses the separate audio only for its own turn.
- **A refused play in the interface is handled.** This covers the play button, the speed-up
  key, the loop menu, a dropped file and a pick in the Sources browser. Test:
  `uiPlayRefused.test.mjs`.
- **Web storage refused** (`dom.storage.enabled` off makes `localStorage` null). It goes through
  `utils/WebStorage.mjs`. `LevelManager`'s constructor read it unguarded, and the whole player
  failed to start. `setOptions` stopped halfway.
- **A seek preview that reports an error while its build still runs** is let go by that build.
  Before, the reload joined the same build, which then stored the broken player, and the preview
  showed "loading" for the whole video.
- **Login headers.**
  - They no longer go from an https source to plain http, its own site included: Firefox sends a
    Secure cookie over https only.
  - A link's `faststream-headers` is taken only as names with text values.
- **`main.mjs`.**
  - The carried fullscreen's Escape is answered once.
  - A `detectLanguage` that answers with an error (no result) threw in its callback. The promise
    never settled, and the background never got its answer.
  - The carried fullscreen and the keyboard now come before the subtitles are fetched.
- **A player tab is torn down at `pagehide`, not `beforeunload`.** A navigation answered with a
  download or a 204 left it dead, and a player tab does not load again by itself (a slow
  navigation there is the user's). A player in a page's frame still goes at `beforeunload`, for
  the back-forward cache, and loads again if the page stayed.

Rejected, with the reason:

- **Already guarded:**
  - Every failure route of the old player: the `ERROR` and `PLAY_DIRECTLY` handlers ask
    `isCurrentAttempt` before `playDirectly` and `reloadWithoutFailedCodec`.
  - `disableProgressSave` and the artwork state: `resetPlayer` clears them.
  - `fallbacks.next`: each request has its own fallbacks object.
  - The main context: `resetPlayer` destroys it before the next `bindPlayer`.
  - `autoplayNextVideo` is synchronous.
  - `autoNextRequested` after a 'clicked' that never navigated: `play()` clears it.
- **Not reachable:**
  - `BUFFER_TAKE` is answered synchronously by the background.
  - `StreamPick.played` never returns `[]`, and `pick` gets a non-empty list.
  - `SubtitleTrack.loadText` runs twice on one track: every caller builds a new track.
- **From the review of the fixes:**
  - The decode failures carried over a reload keyed on `source.url`: `withTimestamp` is a
    string edit, and adding then removing the time gives the URL back exactly (`?a=b%20c`,
    `?flag`, `?`, `#t=5` checked).
  - The new tests' fake timers and stubbed globals: the file's `afterEach` restores both.
  - `preload.mjs` with an `import`: `index.html` loads it as a module.
- **Small, and as designed:**
  - Work left after `destroy`: it runs only as the document goes, or before a frame's reload.
  - The object URL of an opened file is not revoked: it is a reference to the file on disk,
    freed with the page.
  - A superseded source's subtitles: they are the page's, not the stream's.
  - Asks past `AutoNextTries`: each needs a new `waiting` or stall at the end, so there is no
    loop.
  - Credentials on a shared host's other tenants (`*.github.io`): Firefox's public suffix list is
    not open to extensions, and the site rule stays as it is.

## The player-engine audit (2026-11-18)

Two Claude API reviews (MP4Player; the other engines), Codex, and glm in eleven parts, of
`chrome/player/players/`. Each claim was checked against the code. Fixed, each with a test that
fails without it:

- **MP4: a start time set before the metadata** (a resume, a seek preview) began segmenting at
  the sample there, and Firefox dropped the frames up to the next keyframe. `startSegmentation`
  seeks to the keyframe before it, as `resetHLS` does. Test: `mp4TrackEnd.test.mjs`.
- **MP4 save of a file read range by range** said nothing of streaming, and SaveManager opened
  no stream for `saveVideo` to write to (`canSave` gives `canStream`). A file found shorter while
  it saves (`endsAt` drops the ranges past it) threw on the missing range; it ends there now and
  stops the downloads it had started ahead. Tests: `mp4FileLength.test.mjs`,
  `saveDownloadsAhead.test.mjs`.
- **MP4 audio track chosen before the SourceBuffers exist** (at `MANIFEST_PARSED`) was ignored,
  and the first track was set up. Test: `mp4AudioOnly.test.mjs`.
- **A stopped or destroyed MP4 player** went on loading (`runLoad`), and `mainLoop` read the
  video after a listener of its own event had destroyed the player. Tests:
  `mp4FileLength.test.mjs`, `StallWatchdog.test.mjs`.
- **DirectVideoPlayer** set `src` on a player destroyed, or given another source, while its
  header rule was being set. Test: `DirectVideoPlayer.test.mjs`.
- **A separate audio player handed to Firefox's own player** (PLAY_DIRECTLY) kept running; it
  is dropped as on an error, and a refused `play()` of it is no unhandled rejection. Test:
  `SyncedAudioPlayer.test.mjs`.
- **DASH manifest and xlink URLs** were decoded before they were fetched: a signed link's `%25`
  became `%`, another URL. They are fetched as dash.js has them. Test: `DashLoader.test.mjs`.
- **DASH failures** were counted per representation and index, which start again in each period:
  the next period's segment failing once was taken for its third failure. They are counted per
  segment's bytes. Test: `DashLoader.test.mjs`.
- **An open byte range** ("first-", which a DASH `mediaRange` may be) had a NaN end: no Range
  header was sent and the file from its first byte came back as the range. It goes as
  `bytes=first-`, and a server that ignores Range has the rest of the file cut out. Tests:
  `DashLoader.test.mjs`, `FetchLoader.test.mjs`.
- **HLS AES key failure** while nothing awaited it (a segment aborted, or answered from the
  store) was an unhandled rejection. Test: `HLSDecrypt.test.mjs`.
- **HLS live segment tokens:** a stored segment not downloaded yet kept the URL of the playlist
  that first listed it; a live playlist renews its tokens, and the old one may have expired. It
  takes the latest URL while it is waiting. Test: `HLSFragmentStore.test.mjs`.
- **MP4 sample times for ranges** of a file whose samples are not in offset order searched the
  unsorted list. A copy sorted by offset is searched. Test: `SampleIndex.test.mjs`.
- **The remembered audio codec** was the exact string of the last hand pick: picking HE-AAC
  (`mp4a.40.5`) held every later pick, on every site, to that profile. It is matched by family.
  Test: `decodingAwareQuality.test.mjs`.
- **A separate audio MP4 player destroyed inside its own append** (its PLAY_DIRECTLY, answered
  by SyncedAudioPlayer at once) went on with the range: held it for good, or threw on the gone
  mp4box. Test: `mp4FileLength.test.mjs`.
- **A whole save of a file whose length is not known yet** (a 206 without Content-Range) wrote
  the ranges made so far and said it was complete. Such a player says `onlyLoaded`, and
  SaveManager saves what is loaded, after the partial save's question. Test:
  `SaveManager.test.mjs`.
- **DirectVideoPlayer** given the same source twice while its header rule was set started two
  renewals, one never stopped. Test: `DirectVideoPlayer.test.mjs`.

Rejected:

- A DASH segment failing for good raising ERROR twice: dash.js's own error after the start is
  not the player's (`isCurrentAttempt`, DashErrors).
- Codecs of an unknown family resetting dash.js for ever: Firefox's MSE refuses those codecs
  before they reach the decoder, and dash.js filters them.
- HLS `forgetPassed` walking from 0 each refresh: negligible next to the playlist parse.
- The decrypter failing pending decrypts at destroy: the entry fails and is downloaded anew.
- Short 206 bodies taken as whole: Firefox fails a transfer cut short.
- A failed decrypt storing a detached buffer: a post-processor that throws fails the entry,
  and nothing is stored.
- Low-latency HLS parts answered with whole segments: `lowLatencyMode` is off.
- An HLS loader reused without an abort: hls.js makes a new loader for each load.
- An HLS save declaring audio it has no init segment for: the merger is given none, and the
  remuxer reads the audio side only with its init segment.
- DASH representation ids repeated across AdaptationSets: the standard makes them unique
  within a Period.
- Save cancels overwriting each other: SaveManager chains every registered cancel.
- Dropped-frame samples spanning a hidden tab: a hidden tab is not steady, and that clears them.
- A save's fetcher retrying aborts for ever after a source change: resetPlayer cancels the save
  first.
- Live DASH storing fragments at indexes near now / segment duration: extraction gets no
  segments of a `$Number$` template (dash.js lists from index 0, which a live stream no longer
  has, and the patched `getAllSegments` gives none past 100000), and a SegmentTimeline's indexes
  count within the listed window. Requests for the rest go through the loader's fallback.

## The utils and options audit (2026-11-18)

A Claude API review and glm in three parts, of `chrome/player/utils/` and
`chrome/player/options/`. Each claim was checked against the code. Fixed, each with a test that
fails without it:

- **`OptionsStore.replace` wrote the page's whole copy.** A settings page holds the options it
  read; a save made elsewhere since (a player's settings, the background's mpv switches) reaches
  it only through UPDATE_OPTIONS, which the background sends to the tabs it knows, and through
  the visibility observer, which a tab switch does not fire. Its next save put the other save
  back. A save now writes only the keys that differ from what the page last read or saved, over
  the options as stored now, one save after the other; when the stored ones differed, the page
  takes and shows them. A reload waits for the saves on their way: read before one was written,
  the page showed the value it had just replaced. The store keeps a copy (`#saved`): the page
  changes the object it was given in place.
- **The error report** scrubbed the extension's address (it names the install) from the stack
  only; Firefox's message for a module that failed to load holds it too.
- **An archive's source headers** were taken as the file had them. A crafted `.fsa` could have
  the player send a Cookie or Authorization of its choosing, which a crafted link cannot
  (`withoutCredentials`); the reader strips them as the writer does.
- **The options page's fields** got `role="button"` (`setupTabIndex`): a screen reader said
  "button" for every check box, without whether it is ticked, and for every text field. They
  get Enter only (`setupKeyPress`).
- **`StreamLength.fromMp4`** pointed past the end of a file that had ended with no movie
  header: one more request for nothing.

Rejected:

- Two saves in the same millisecond taken for one echo: harmless now that a save writes only
  its own keys; the page shows the other save at its next reload.
- `MediaTitle` dropping a title word like the site's name ("Max Payne | Max" on max.com
  became "Payne"): keeping it where the site names itself apart kept "FMovies" in "FMovies Dune
  | FMovies". The two cannot be told apart, and the search's title can be edited.
- Typed text lost to a reload during the 400 ms save wait: needs a save elsewhere inside those
  400 ms.
- `dashProtected` and a self-closing AdaptationSet: the entry it makes holds the next set's own
  tag and content, and the verdict is the same as without the empty set.
- `xml2vtt` and TTML: it reads timed-text XML (`<text start dur>`); TTML comes only as a
  dropped `.xml` or a subtitle URL, and parses to no cue, which the player reports as no
  subtitles. Reading TTML would be a feature (the doc comment no longer claims it).
- Its O(n²) look for the next start: it stops at the first later start, which in a file in
  order is the next cue.
- `downloadURL` and `lastError`: the background is gone only while the extension reloads, when
  the player page goes too.
- `RequestUtils.request` and an empty body: no caller sends one.
- Two `#EXT-X-STREAM-INF` tags before one URI sharing it: a playlist RFC 8216 does not allow,
  read as the comment says.
- The archive's sizes: `LargeBuffer.read` checks a length against the file before allocating.
- `closeWindows` clicking the close buttons of closed windows: each only hides its window.
- `formatDuration(Infinity)`: both callers pass only finite times.
- Decimal aspect ratios: the list holds none.
- `copyText`'s fallback result: it runs in the web build only.
- Imported subtitle and tool settings written after the broadcast: open players read them only
  when they start.
- A failed first options read, an unparsable `updateData`, prototype pollution and imported
  key bindings: the read fails only on a broken profile; `updateData` is only ever written by
  `JSON.stringify`; `mergeOptions` walks only the defaults' own keys and checks every binding
  with `isKeyString`.

## The UI audit (2026-11-18)

Two Claude API reviews and glm in five parts, of `chrome/player/ui/`. Each claim was checked
against the code; picture-in-picture was run in Firefox 160 (`picture-in-picture.e2e.mjs`).
Fixed, each with a test that fails without it (most in `interfaceControllerAudit.test.mjs`,
which imports the UI modules with their page as stand-ins and calls their real methods):

- **"Download paused" for good:** paused once everything was in, then resumed, the line stayed;
  the pause now clears what "all buffered" was shown for.
- **The visibility action** noted the visibility it acted on only after its play or pause was
  answered: a change during it was lost, and the video played on in a hidden tab.
- **Hiding the player and the visibility action** shared one "play again" flag: hidden, then the
  tab switched away and back, the player did not play again when shown.
- **Picture-in-picture and fullscreen refused** (a fullscreen the background could not give, a
  PiP request rejected) were unhandled rejections in every click and key: they are said on the
  console.
- **The progress loop on audio alone** waited for video frames, which never come; it uses
  screen frames when the video has no picture.
- **A live stream's progress bar** (a DASH live stream's duration is Infinity) previewed and
  dragged to Infinity, and a media element throws on such a seek. The bar does nothing there
  (no preview, no drag: `ProgressBar.hasEnd`), and the client's `currentTime` refuses a
  non-finite time.
- **Saving:** a question answered after the next video came started a save on it; a second
  click while a finished save's name was asked revoked that save's file; the mpv button
  clicked twice sent the stream twice. The button waits for the background's answer, but no
  longer than 15 s, and a send that throws (the extension reloaded) frees it at once: either
  left the button dead for the life of the page.
- **A subtitle URL** that answered after the next video came was added to it.
- **The silence skipper** turned on again within 100 ms of a new video ran two loops.
- **OpenSubtitles:** a refused request (a throttle) beside a title search that found nothing
  said "no results" instead of why.
- **The audio channel count:** an older counter failing to start after a newer one had
  counted set the output back to stereo.
- **"Choose an output…"** passed the chosen device to `selectAudioOutput`, which Firefox may
  answer with that device without showing its chooser; it asks with none now.
- **GIF:** the last frame drawn was never added (each was added when the next was drawn), and a
  loop shorter than one frame threw in gif.js; it is dropped and says so. The last frame lasts
  until the loop's end as it was during the recording: ending it turns a loop that was off
  before the GIF off again, and with it its end.
- **The resync tool's double click** edited the track the tool had when the prompt answered.

Rejected:

- Picture-in-picture throwing in Firefox: `requestPictureInPicture` is there since 153, and
  Document Picture-in-Picture since 151 (MDN's compatibility data, the floor is 153).
- Moving the player into the Document Picture-in-Picture window pausing it: run in Firefox
  160, it plays on into the window and back.
- `getAudioLevels()` undefined in the audio menu: the client answers an empty Map.
- `copySourceLink`, the subtitle save, `releaseWhenDownloaded` and the speed menu's storage
  calls rejecting: `copyText`, `downloadURL`, `whenDownloaded` and `setConfig` never reject.
- The fine time controls on a long video not starting the progress loop: their `start()` does.
- `dumpBuffer` leaving its stream open: `writeFSAToStream` aborts it on a failure.
- The subtitles menu's first click doing nothing: it starts with an inline `display: none`.
- An unbounded outline width: `SubtitleUtils.outlineWidth` caps it at 64.
- Subtitle settings saved at each key: a few small storage writes while typing.
- The subtitle bounds read on each time update: the reads are cheap while nothing changed.
- A sources row's Play going on after the row was deleted: the player is loading that source.
- Headers applied while typed: lines without a colon are left out, as intended.
- The media-session seek keys with no player: the client's `currentTime` does nothing then.

## The network-layer audit (2026-11-18)

A Claude API review of `chrome/player/network/`, each claim checked against the code.

Fixed, each with a test that fails without it:

- **RAM budget and a file under a new link:** a download taken over under a new link (`stored`,
  after a hand-off or FreshLink) keeps its data under the old key (`blobId`). `ramBytesOf`,
  `isInRam`, `isSpilling` and `spill` looked under the new key, found nothing, and the budget
  could neither spill nor free those bytes. They go through `blobKey` now.
  Test: `DownloadManagerHandOff.test.mjs`, "counts a file found under the new link in its RAM".
- **A downloader given back past the limit:** after a failure took one away, the speed test went
  on adding up to `downloaderLimit()`, and the one given back on a later success made one more
  than the option allows. Test: `DownloadManager.test.mjs`, "gives none back past the most
  downloaders allowed".
- **Hand-off moves after a new source:** `adoptOne` checked the storage generation only after
  the move, so every disk file of a long video was moved and then deleted while the next source
  started. It returns at once now, and `dropSession` takes the old session's files.
- **IndexedDB:** a `setup()` whose database did not open left its 5 s heartbeat running for the
  page (FSBlob drops the manager and goes on), and a failed request's own promise in `transact`
  was an unhandled rejection (the call itself rejects through `onerror`).

Rejected:

- A joining request replacing a running download's processors: every caller of one key goes
  through the same fragment requester, with the same processors.
- Archiving racing a removal: `saveBlobAsync` with `deferred` keeps the Blob synchronously.
- `record.blob instanceof Blob` across realms: BufferStash's hand-off is structured-cloned into
  the player's realm (`takeBackBuffer`).
- Stripping a signature parameter only for the link's own values (two files told apart by a
  parameter of the same name): after a FreshLink renewal the hand-off's link is the latest issue,
  and files under the earlier issue carry other values, so they were no longer found. No host
  is known whose files are told apart by a parameter of a name the link's signature changes.

## Firefox for Android, step 1 (2026-11-20)

Codex reviewed the change that lets the same build run on Firefox for Android ("Firefox for
Android" in `docs/notes/build-and-release.md`). It found no API Android lacks still used
unguarded in the background's start, the manifest's content scripts or the options page, and
nothing in `gecko_android` that signing or `updates.json` would trip over. Fixed:

- The options page hid MPV mode, and made no MPV suggestion, by the user agent alone: a desktop
  whose user agent says Android lost them for good, though Firefox answers `win`. Both pages
  now decide again once `runtime.getPlatformInfo` answers, either way, and the suggestion waits
  for it (`optionsMpvSuggestion.test.mjs`, "shows MPV mode and offers it once Firefox says
  Windows").
- The player never asked Firefox for the platform, so in Android's desktop-site mode, with MPV
  mode from a desktop's settings, it showed an MPV button that only fails. `ToolManager` asks
  and redraws (not covered by a test: the fake DOM cannot hold the player page).
- Two test assertions proved nothing: no helper message could be recorded once Android's API
  set had removed `sendNativeMessage`, and a message without an answer is `undefined` anyway.
  The tests now record each look for `sendNativeMessage` and each unhandled rejection; each
  fails without its guard.

## The cross-repository audit, FastStream and mpv-config (2026-11-19/20)

Both repositories as one system, from FastStream `bcff3dec` (1.3.82.218, helper 27) and
mpv-config `032984d`, mostly the path that hands a stream to mpv: the background's detection,
the play message, the helper's HLS package in `faststream-mpv-hls-XXXXXX` (`-p-` for a private
window), mpv-config's scripts reading `target.txt` and the `#fs-...` tags. Reviewed by
glm-5.3-flash (every change), Codex (gpt-6.1-sol) and the Claude API reviewer; each claim was
measured or read in the code before it was acted on. Merged as FastStream #772-#777 and
mpv-config #49 (2026-11-20), and the owner's decisions D1-D4 as FastStream #783 (helper 29)
and mpv-config #50, #51. Baseline: eslint 0, tsc 0, 4402 unit tests; mpv-config 216 static
and 1216 headless.

Fixed, each with a test that fails without it:
- **X1** A subtitle track over the helper's 1,048,576 UTF-16 units refused the whole stream
  (a 16 MB message since helper 27 has room for one): it is left out, with a warning (#772).
- **X3** A busy mpv (no answer within 6 s) had the helper remove the package while mpv's load
  of it waited: mpv lost the new stream and the one it played. The folder now stays, removed by
  its age, on the three paths that report busy (#773; private windows by D1, #783).
- **X4, X7** ffmpeg cuts a playlist's own address at `#` before resolving names relative to it:
  under a temp folder like `user#1` every master playlist failed after the helper had answered
  ok, and ffmpeg opened playlists planted beside the cut folder. Such a master is written with
  whole paths and read back as ffmpeg reads it, or refused (#773).
- **X5, X8, X10** The playlist check read lines unlike ffmpeg (measured with the ffmpeg
  program): whole lines where ffmpeg reads 4095 bytes, every kind of space trimmed where ffmpeg
  trims ASCII spaces only, any first line starting `#EXTM3U` accepted (#773).
- **X6, X12, X13** Faults in the audit's own fixes, found before any merge: a rewritten line
  past 4095 bytes, a relative temp folder resolved twice, and refusals of URI spellings and of a
  line cut inside a character that refused playlists ffmpeg plays (Codex; taken back, #773).
- **N1** The TTML reader rendered a paragraph once per time range its parts cut it into, with
  no limit: 16 000 spans (0.9 MB) took 31 s in Firefox, a 32 KB file of chained styles 29 s,
  0.9 MB became 32 MB of cue text. A work count (16 million units, about 2 s), a 5 s clock and
  16 MB of cue text bound it (#775; `subtitle-ttml` e2e). A file near the limit may be refused
  on a machine three times slower: the trade was accepted.
- **N2** An HLS package's size was checked after its whole text was built (one grew to 39.8 MB
  before the 12 MB refusal): it is counted while written, inside a line too (#776).
- **N4** The mpv notes described two refusals of master playlists the code does not make;
  corrected, with three assertions (#773).
- **T-1** `hidden-streams.e2e` took a player frame inserted between its two looks for the
  page's frame (11 of 30 CI jobs failed their first try); not a product fault (#774).
- **S-1, S-2** On a site whose player sits in `display: contents` wrappers (no box, 0 x 0), the
  player took the highest same-size parent and showed in a 100 px box or not at all. It takes
  the highest parent with a box (a test page 0 x 0 -> 640 x 360, a page of that site 0 x 0 ->
  894 x 503); the resize watch follows the nearest parent with a box, and the miniplayer lifts
  the player alone (unit tests only) (#777).
- **M1, M2** (mpv-config #49) A stream from the helper's package was buffered as a local file
  (at most 150 MB ahead, no predownload), and with `#` in the temp path its tags were not read
  (no resume, episodes or Auto upscale). After: `storage: ram`, `mode: predownload` in real mpv.
- **M3, M8, D1** A private window's package and subtitles could stay on disk with no time
  limit: mpv-config's `faststream-private.lua` removes them when mpv moves on or closes, the
  age rule as the fallback (helper 29, #783; mpv-config #51).
- **M4-M7, D2-D4** (mpv-config #50) Package streams draw the buffer and fetch no thumbnails
  (thumbfast fetched the stream three times without the page's Referer); the source menu shows
  "Stream URL", not "Local file"; the episode keys say FastStream is not connected to this
  window instead of the wrong reason.

Disproved, do not raise again: a quality switch losing the tags (no quality list goes with a
package); tags injected through a quality address (`MpvTarget` strips the fragment); a control
character in a title refused (cleaned first); non-ASCII temp paths breaking playback (measured:
spaces, umlauts, CJK, `%&+=;,`, quotes and brackets play); the rest of an overlong line read as
a new line (ffmpeg drops it; measured and read in its source); `RequiredHostVersion` 19 against
`HostVersion` 27 (intended); the response filter stalling a request 10 s (glm; measured: same
timing and contents without it); a late player frame address (`content.js` sets it first);
re-sent chunks corrupting consumers (glm C-F4: already-had bytes are skipped); an http segment
served as a playlist opening local files (ffmpeg's `nested_io_open` refuses it; read, not
measured).

Measured and left as is: the response listener for streams that hide their type adds about
0.3-0.45 ms per request at the median and under 1 ms at p95 (headless Firefox 160, three
rounds), +15 ms once on the request that wakes the background; while a stream plays, about
+0.4 ms median and +1-2 ms at p99. Recommendation: leave it.

Still open, by decision or for want of a case:
- **N5** Bytes of a playlist line after 4095 are not checked: ffmpeg drops them, and checking
  them refused lines ffmpeg plays (two tests pin those as accepted).
- **X9, X11** The check lists more addresses than ffmpeg reads and requires all of them
  allowed: a master that names a playlist only where ffmpeg does not read plays without it. No
  real stream of that shape is known.
- **X2** (suspected) Playlists the extension can send and the helper refuses: a backslash, an
  unquoted `URI=`, a `data:` key, blank lines before `#EXTM3U`. None seen in a real stream.
- **S-3** (suspected, older than #777) A zero-height wrapper around an absolutely positioned
  player is still taken: the player gets 100 px. Changing it left the page's controls above
  the player (the Claude reviewer, from the code): only with a page that shows it.
- **S-4** A boxless shadow host whose video sits in a named slot would hide the player frame;
  media beside the player in a boxless wrapper is neither paused nor hidden. No such page known.
- **N3** A resumed download (206) is joined without a strong ETag or Last-Modified: the
  recorded design in `docs/notes/storage.md`.
- **O-1** The wait for a stream's qualities before the hand-off (up to 1.5 s) might stop once
  the needed stream's qualities are known: analysed, not measured.
- Two mpv windows writing the resume file at once can lose a position (heals within 5 s).
- glm's C-F2 (a TTML `seq` child without `end`) was not settled against the standard.
- Test gaps: no test runs a real helper package through real mpv (G-1; every helper finding
  above sat there), the 4095-byte contract with ffmpeg is measured but not in CI, no e2e
  checks that a body passes the response filter unchanged (G-3), and the DASH case of
  `hidden-streams` does not check that the player was linked.

## MPV mode: several mpv windows and the offer (2026-11-20)

Helper 30 (#785) gives each mpv window an id; #786 follows several windows and asks in the
window ("Play here" / "Play in a new window", mpv-config #55's `faststream-offer.lua`) before a
stream replaces what it plays (`docs/notes/mpv.md`, "Several mpv windows in the extension", "The
offer"). Fixed from the reviews, each with a test that fails without it
(`backgroundMpvThin.test.mjs` unless named):
- The Claude API reviewer: a send the tab had sent already answered with no window, which moved
  the tab to the default window and took that one from its tab; a closed episode window left
  the tab's 60 s episode wait on, so its next video was dropped unsent; every end of a relay
  counted as the window's mpv gone, though only "mpv closed" and "no mpv" mean that.
- Codex: a page gone during the window's 2 s answer still sent its stream (`wanted()` is now
  checked on every path); two tabs asking one idle window at once both played, the second
  replacing the first unasked (one question per window at a time, a chain on its watch). Its
  second round: a stream queued behind another, whose window closed while MPV was turned off,
  started over, found no window and was sent, opening mpv; `wanted()` is now checked first after
  every wait in the queue.
- Kept: mpv closed during the ask makes the play answer `closed` and a fresh window plays it,
  as a hand-off with no mpv running does.
- mpv-config #55: Codex found a double click whose second press landed on the other script's
  banner (one guard for every script's banners, `user-data/banner-click/until`); the Claude API
  reviewer found a click meant for an offer that a newer one replaced taking the new one's
  choice (`hold()` on a replaced offer, in both scripts).

## Firefox for Android: the room to predownload (2026-11-20)

The owner's phone played but kept only a few minutes buffered, with the storage warning. The
emulator measured why (`docs/notes/storage.md`, "The room to predownload"): Firefox's quota is a
tenth of the device's storage, and the room counted the disk's part alone. #787 counts the RAM
share too, and a private window predownloads what fits in its RAM share. Codex then found that
a room that moves with the share can end mid-video and pin fragments a full disk cannot take:
RAM stayed "full" for the rest of the video. A fragment pinned only for good that the disk
refuses is now let go of (`FastStreamClient.test.mjs`, "lets go of what was kept for good when
the disk is full"). Its second round: the fit counted the video's bitrate alone, while RAM holds a
separate audio track too, so a DASH stream "fitted" and the budget let go of what predownload
fetched again, round and round (5.97 GB moved for a 1.85 GB stream); older for "Keep video on
disk" off, reached by private windows now. The audio level's bitrate counts too ("fits the
video and its separate audio track together"). Rejected from the Claude API reviewer: repeated pinning (`addReference` adds
an id once) and an unset `bufferBehind` in a private window (it is only ever the option).

## The translations of the November strings (2026-11-21)

The 33 strings added since 2026-11-01 (MPV offer and hand-off, cloud settings, subtitle messages,
permissions page) had only machine translations. Two models reviewed each of the 15 locales
(kimi-k3.1-pro and mistral-large-4), each claim checked against the rest of its locale.

Changed (37 strings, 13 locales):

- **The mpv helper's name as the rest of the locale has it**, in the newest string
  (`player_mpv_needs_hls_helper`): es "programa de conexión", it "programma di supporto", nl
  "mpv-hulpje", pl "host mpv", ru "mpv-хост", id "program penghubung", zh_CN 辅助程序, zh_TW
  主機 (each had a word of its own there); pt_BR "stream" (the locale's word, not
  "transmissão"); tr "daha yeni" (newer).
- **zh_CN/zh_TW 放大器** (an amplifier) for the upscaler: 放大算法 / 放大演算法.
- **One spelling per locale**: id "subtitle" (37 times, against "subtitel" in the new strings), ms
  "sarikata" (26 against 9).
- Wording: fr "juste le temps de", pt_BR "API webRequest bloqueante", zh_TW 阻斷式, tr and ja
  `player_mpv_declined`, ru `welcome_page_keybinds_content27` (the tool), ru/id/ms
  `options_general_cyclesubs` (says what goes off), id/ms `perms_page_breakdown_perm12d`
  ("menunjukkan"), id `options_cloud_quota`, ms `welcome_page_keybinds_content27`.

Rejected: Turkish title case on `options_cloud_export`/`import` (every Turkish button is title
case); a missing space in es `options_cloud_hint` (it is there); es "los desactiva" and it "li
disattiva" (the pronoun is the subtitles); the content type "Nativ"/"Natif"/"Nativo"/"Native"
left as it is (Movie is translated, Anime and Native are names); zh_TW 您 in the cloud strings
(the locale uses 您 in its dialog-style strings); ko "$1은(는)" (the usual form for a
placeholder); ms "Sync Sekarang" (Firefox's own Malay label could not be checked).

## The audit of the player's messages (2026-11-21)

Messages that stopped the user without telling them what to do:

- **"Please select a player mode!"** A new row in the Sources window starts on "Auto", which takes
  the mode from the address when the address field is left. Play with the field still being typed
  in (a tap on Android need not leave it) found "Auto" and said only that. Play now takes the mode
  from the address too, and the message is gone. glm-5.3-flash's review of that: Play skipped the rest of
  what leaving the field does, so a link copied with the Copy button and played at once went out with
  its headers and mode unread in its query. Play now reads the address the same way. Rejected: a throw
  from `getModeFromURL` (string work only, it cannot throw).
- **"Turn FastStream off with its toolbar button"** (a load error in a page, DRM). Firefox for
  Android has no toolbar: FastStream's button is in Firefox's menu, under Extensions, and Android
  now says so.

## The area reviews by kimi-k3.1-pro and deepseek-v4-pro (2026-11-21)

Read-only agents reviewed the mpv helper, the background script's message handlers and the header
rules. Each finding was checked against the code.

Changed:

- **A play's subtitle files no mpv reads are removed** (host 31, `docs/notes/mpv.md`): a private
  window's stayed a day when mpv was not found or the load failed, and a failed write left its
  folder. Tests: `mpvHlsHelper.test.mjs` ("removes the subtitle files of a play that did not go"),
  `MpvNativeHost.test.mjs` ("removes a private window's folders after two minutes", "leaves no
  folder when a file cannot be written").

Rejected:

- **install.ps1's wrapper escapes only `%`**: inside double quotes cmd takes `& | < > ( ) ^`
  literally; `%` is the one character it still expands there.
- **A bare `mpv` looked up on a UNC entry of PATH**: PATH is the user's own setting, not anything a
  page sends; `NetworkOrDevicePath` guards the path a message names.
- **Header rules match http as well as https, and as a prefix** (`NetRequestRuleManager`): the
  trade recorded in `docs/notes/player.md` - one tab, the extension's own requests, five seconds;
  the https-to-http case needs the stream's own server to redirect to plain http.
- **The manual MPV repeat-click guard is keyed by the URL only**: two tabs sending the same stream
  within three seconds is no real flow, and one mpv window for both is what the guard is for.

## Codex's area reviews (2026-11-21)

Codex reviewed areas of the code while Ollama's usage window was used up; each finding was checked
against the code.

Changed:

- **A rebuild played a video the user had paused** (`FastStreamClient.setSourceInternal`): after an
  automatic continuation turned autoplay on, another page quality or a recovery started the paused
  video again. Test: `FastStreamClient.test.mjs`, "a video built again after autoplay".
- **The remembered time undid a seek made while the player got ready** (MP4: the seek bar comes
  before the first frame). Test: "does not seek to it over a seek the user made while the player got
  ready".

## Area reviews of MPV mode, the background modules, and #800 (2026-11-21)

Codex read MPV mode and the background modules, deepseek-v4.1-flash tried to refute each finding from the code, and
the confirmed ones were fixed with a test each that fails without the fix:

- **A countdown went on after the user opened another file in that mpv.** `onMpvWatchEvent` had no branch for the
  `path` event: 5 s later the next episode replaced the file the user had just opened. A path that is not the tab's
  stream now cancels it.
- **A stream queued behind another went to mpv after its page or MPV went.** `openInMpv` checked `wanted` before
  the backend's queue, not at its turn. The backend now asks again when the send's turn comes.
- **youtu.be/<id>/ and /watch/?v= were no YouTube video.** A trailing slash, as some pages write links, made
  `youTubeVideo` return null, and the link opened as a tab instead of going to mpv.

DeepSeek's review of #800 (no autoplay where a stream broke off): an end-file "eof" is still an end, so an mpv that
does not keep the file open (a helper before 24 cannot keep it open) still told an end at the break. Not fixed
there: helpers before the current one are no longer supported (the owner, 2026-11-21: only the latest helper and
Firefox), which leaves only a file shorter than the keep-open answer's round trip.

## Codex's reviews of #802 and #803 (2026-11-21)

Fixed (#803): **a queued send's check was the first asker's only.** The page after a navigation
asking for the same stream got the pending send back, and when the old page's check said no,
both were dropped. A first fix let the send go while any asker wanted it; Codex's next pass found
that this sends the old page's payload, placed in an mpv window the user may have filled since
(no offer). Now a page given a send dropped as another page's, and still wanting it, hands the
stream off itself (`openInMpv` again): placed anew, with its own page. Codex's third pass: the
retry started from `url`, by then the quality the first try picked, and a disguised stream's keyed
playlist package is built only from the detected address, so mpv got the bare quality address and a
403. It starts from `detected` now (Codex reproduced it in the background harness; the unit test
covers the retry from a master playlist, whose qualities still go along).

Rejected (#802): **the Shift+A test mocks the on-screen display it checks.** The test checks what
the key asks the display to show; showing it is the display's own job, shared by every key.

## DeepSeek's review of #797 (2026-11-21)

deepseek-v4.1-flash read the diff against main. Two of its three points were real and are fixed in
the PR, with a test each that fails without the fix:

- **A blocked autoplay, then the user's play and pause.** Only autoplay set `autoPlayTriggered`, so
  a rebuild with `play: false` (a quality switch, a recovery) played the paused video again. The
  video's `play` event now marks it too.
- **A late autoplay of the video before.** Its `play()` settling after the next source was set marked
  the new one as autoplayed. Each write now checks it is still its own source. Unlikely (the old
  player's pending `play()` usually rejects when it is torn down), but a one-line guard.
- Rejected: **an undone seek lets the remembered time land.** `undoSeek` empties `pastSeeks`, so a
  remembered time arriving after a seek and its undo would apply. That needs the seek and the undo
  within the first seconds of loading (the lookup waits at most `RememberedWaitMs`), and the
  remembered time then replaces a position the user has just undone.

## Codex's area review of the network code (2026-11-21)

Confirmed by deepseek-v4.1-flash and fixed with a test that fails without the fix: **a part downloaded again lost its
file when the old one's move ended.** A handed-over file let go of before its move was deleted by key when the move
ended (`DownloadManager.adoptOne`); the same part downloaded again meanwhile is saved under that key, so its new file
went and it was downloaded a third time. The delete now leaves a key another entry keeps its data under.

Codex's review of the fix: the first check looked at the entry under the key only. A new download moved on to a new
link keeps its data under the old key (`blobId`), so its file was still deleted; and an entry under the key with its
data elsewhere kept the moved file from being deleted. The check now follows `blobId` (`keepsDataUnder`), and the
test's move ends after the new download, as a real move can.

## DeepSeek's review of #799 (2026-11-21)

deepseek-v4.1-flash read the diff against main. Fixed in the PR, with a test each that fails without
the fix:

- **Said again as the bitrate moved.** The message came on each change from "fits" to "does not fit",
  and a measured bitrate or another quality crosses that line back and forth. It is now said once
  per video (`roomWarnedFor`); the old test called it three times with nothing changed.
- **The disk figure was the whole quota.** Only 60 % of it is used, beside the RAM share, so a 7 GB
  video could be "larger than" 10 GB free. The message now gives what the video may fill.

Rejected:

- **No message for the second video once no disk backend works.** `player_outofstorage` is said once
  per page, and the cause does not change between videos.
- **The RAM messages give a share, not the setting.** They say "the share of 'RAM for buffered
  video' FastStream may use for it", which is that number (other players' shares and the 25 % margin
  taken off).
- **The locale strings and `perm13` are missing.** They are in the PR; the review was given part of
  the diff.

## Codex's pass over the cloud settings (#789, 2026-11-21)

Rejected:

- **Two exports at once can delete each other's chunks** (`CloudSettings.mjs`, the cleanup after
  `set()`): it needs two exports interleaved on one device (Sync merges devices minutes apart), and
  the copy's hash turns the damage into "incomplete" on import, never into wrong settings.
- **A half-failed import says it worked** (`applyImportedSettings`): the file import and every option
  on the page save the same way (`Utils.setConfig` logs a refused `storage.local` write); such a
  write fails only on a broken or full profile.
- **An imported regex can hang the URL lists** (`autoEnableURLs`, custom source patterns): the cloud
  copy is the user's own, from their own Mozilla account, as if typed into the options.

## Codex's review of #801 (2026-11-21)

Fixed:

- **The speed-limit notice blamed the limit on a line slower than it.** The gate holds downloads only
  while their measured speed is above the limit, so the notice now names the limit only while the
  downloads reach 80% of it (`WaitNotice.LimitReachedShare`).
- **The notice replaced the download-pause message**, which names the key that resumes. It now stays
  quiet while the downloads are paused.
- **A lone AltGr never fired where a window stops keys from bubbling** (sources, options, subtitle
  search), and a held AltGr fired after `@` was typed into such a window's field. The release, the
  keys typed meanwhile and clicks are now listened for in the capture phase.

Rejected: **the five new strings are missing.** They are in all 16 locales; the review saw a cut diff.

Codex's next pass, with #804 (the resume and subtitles notices) folded in, found three notices on one
status level: each set ended another's time, the wait notice still covered the pause message when
the pause came after it, and "Resumed at 0:30" stayed over the next video. Each has its own level
now; the wait notice goes when the downloads are paused, and `reset()` takes the resume and wait
notices down. The subtitles notice came again each time the frame's list came with a new stream:
only tracks the player did not have count now.

glm-5.3-flash's pass over that (2026-11-21): the subtitles notice was the one `reset()` left up, so
the last video's "subtitles available" stood over the next for up to 8 s; it goes with the others
now (the next video's own notice comes later, with its subtitles). Its test harness matched tracks
by label; it uses `SubtitleTrack.equals`, as the player does.

## The flash models' area reviews and their checks (2026-11-21/22)

glm-5.3-flash and deepseek-v4.1-flash read areas of the background, the players, the save, the
subtitles and the options. A second model, told to refute it, checked each finding.

Fixed:

- **Subtitles fetched for one video came over the next** (`main.mjs`): a SOURCES message's subtitle
  files are fetched and sorted by language before they are added. When the list was cleared
  meanwhile (the next video set, or the user's "clear"), they went to the new video. They are
  dropped now (`FastStreamClient.subtitlesGeneration`, the counter the URL and OpenSubtitles
  downloads already went by).
- The same round's other confirmed findings went into #803 (a queued hand-off sent after MPV was
  turned off, the countdown after another file was loaded, a YouTube link ending in a slash),
  #805 (a stale adoption deleting a newer download's data) and #809 (a cancelled Save As).

Rejected:

- **The options page stops in about:addons** (`parent.document` of a cross-origin parent): Firefox
  shows inline options in a `<browser type="content">`, a top-level browsing context of its own,
  where `parent` is the page itself.
- **A partial MP4 save pads its last fragment to 1 MB**: the save ends at the last complete
  fragment. **It keeps savers when it stops at a dropped fragment**: only `endsAt` drops one, and
  it frees them.
- **The settings export revokes its URL too early**: an `<a download>` click reads it at once; the
  delay is for `downloads.download()` (storage.md, "A download's `blob:` URL must outlive the
  download").
- **The Sources window's Play redraws the list and loses its loading mark** (#807): `updateSources`
  changes the rows in place and leaves a loading source alone.

Left as it is: **the toolbar cannot be reordered on Android.** A hold starts the reordering only
with a mouse (a touch's mouse events come after the finger lifts) and Sortable is off on phones;
touch controls are among what is not done yet for touchscreens (build-and-release.md).

## Codex's and glm-5.3-flash's reviews of #810 (2026-11-22)

Rejected: **a helper put back by hand while Firefox runs gets one hand-off** (Codex). The helper's
version is known from its last answer. The first stream after an older helper was installed over a
current one is therefore sent: that helper plays it, and the player says to update the helper while
the page goes on playing. `streamResult` answers it with the update text ("an older helper put
back"), and the next send pings first. Only an old helper installed by hand during a session gets
there: "Update mpv" installs the release's helper, and an add-on update restarts the background. A
ping before every hand-off would start the helper twice per send.

glm-5.3-flash found nothing: every message the extension still sends (`ping`, `play`, `ipc`,
`raise`, the relay port's) has its handler in helper 32 with the fields the extension reads, a helper
below 32 is sent nothing but a ping, and no removed name is used.

## DeepSeek's review of the API watch's "never calls" (2026-11-25)

deepseek-v4.1-flash read the diff that lowers a fix to a WebExtensions part the code never calls.
Fixed, with a test that fails without it:

- **A part reached without its dotted name counted as uncalled.** `const {discard} = browser.tabs`
  never contains `tabs.discard`; FastStream's own `background.mjs` reaches
  `(chrome.webRequest).filterResponseData` through a cast. The part's name in a file that names the
  namespace now counts as a call.

It found no crash and no unsafe text: a part's name is an identifier of a namespace the code uses.
The dry run over Firefox 150-161 found one more before the review: an MDN note about a new part fell
to low through its confidence (only "used" counted as medium). A new part keeps its priority now.

## DeepSeek's review of the Coloris 0.26.0 re-cut (#852, 2026-11-26)

deepseek-v4.1-flash read the new patch, upstream's 0.25.2 -> 0.26.0 diff and the merged
`configure()`/`init()`. Rejected:

- **"`Coloris.bindElement` is never exported, so the subtitle colour inputs throw."** The patch
  never carried the export: `tools/sync-vendor.mjs` appends `Coloris.bindElement = bindElement;`
  when it unwraps the UMD (`docs/vendored-libraries.md`, "The module shape"), and the generated
  `coloris.mjs` has it as before. The model was not given sync-vendor.mjs.

It checked and cleared the rest: upstream's nested `configure()` runs after `case 'parent'` has
set `container`, `formatChoice` is set before that call, and the DOMParser nodes and the unit
test's stand-in for them behave as a browser's `append` does.

## DeepSeek's review of the settings export fix (#868, 2026-11-28)

deepseek-v4.1-flash read the diff, `Utils.downloadBlob`/`downloadURL` and the background's download
paths. Taken: the about:addons test could click some other options page that was open; it now
clicks only when one options page is open and no tab shows it. Rejected, each measured on Firefox
161:

- **"Private windows: the background cannot read a blob URL made in a private page."** The new spec
  passes under `wdio.pbm.conf.mjs` (every window private): the background takes the hidden-tab path
  for `firefox-private`, and the file is saved from the framed player, the options tab and
  about:addons.
- **"Container tabs: the hidden player tab's link click hits the same partition key."** A framed
  player's settings in a container tab (GitHub build, `contextualIdentities.create`) saved the
  export through that path, as a player-frame `downloadBlob` did.
- **"A fixed port fails when it is taken."** Fixed ports are the suites' rule, kept apart by
  `e2ePorts.test.mjs`.

## DeepSeek's review of the buffer found again under another link (2026-11-27)

deepseek-v4.1-flash read the diff of the kept buffer found by the tab's page with the files it touches.
Fixed:

- **A buffer found by the tab's page whose query alone changed was used unchecked.** On another
  hoster page a query may name another video: every buffer found that way is checked now.
- **A failed check deleted the buffer of the video it belonged to.** The other language of a
  hoster on the same page took the first one's buffer and let it go: going back to the first
  downloaded all of it again. Such a buffer is lent now and back in the stash when it is another
  video's (`BufferStash.lendNear`/`endLend`, measured in `keep-buffer-ways-back.e2e.mjs`,
  "switch-frame"). Found with it: the first video's player got the newest buffer of the page, the
  other's; one from the same hoster page goes first now.
- **A check ended before its word left the unchecked parts in the player** (a new link would take
  them for its own): they go now.

Rejected:

- **"Disk parts miss the check: `adoptDiskFiles` has not put them in the storage yet, so `checked`
  never settles."** `adopt` puts every part in the storage at once, a disk one with a function that
  reads it (`keepAdopted`); only its file moves later. A check whose parts are never asked for stays
  open as a buffer under its own link does, unused until a part is asked for.

Its second pass, over the lend. Fixed: the stash's answer is tied to the check that asked
(`confirmLent(check, …)`; a yes for a check a new source ended deletes the files nobody has now); a
lent check that never compares a part (none asked for, its twin unreadable) gives up after
`LentCheckMs`, before the stash has it back; a lent buffer counts as on the disk when room is made,
and one put back sets the alarm again. Rejected:

- **"Take a buffer of the same place whose query alone changed at once, unlent."** That is the
  first pass's finding: on another hoster page the query may name another video.
- **"A record lent while the event page restarts is handed out again."** The lend lasts the
  seconds of one check, while its player's messages keep the event page up; and the player moves
  nothing before the stash's word, so a second taker finds every file in place, and the first one's
  check at worst gives up.

## DeepSeek's reviews of the kept-buffer notice and the menu quality before start (2026-11-27)

deepseek-v4.1-flash read each diff with the files it touches.

The notice apart from the status line (#867): its finding that the pointer leaving dropped the hold
while the focus stayed on the button was fixed (one flag each). Rejected:

- **"The new strings are missing from the other locales."** All 16 have them; the locale files were
  left out of the diff it was sent.

The menu quality chosen before the start (`PageMenuQuality.mjs`): fixed were a listener that throws
leaving the tab's switch wait unsettled (every later play of the tab dropped), and the switched file
dropped as "the switch's" when the file it was switched from was not in the same batch (the list
cleared, or FastStream off and on while the page played it). Rejected:

- **"A play of another video in the tab waits for the switch, up to 10 s; wait only when the play
  is the choice's file."** The file the page loads is unknown until the switch answers, so a play of
  it cannot be told from another video's: waiting only for the choice's own file would send the
  switched file to mpv a second time (the case the wait is for). The wait is bounded and now always
  settles; another video in the same tab within the seconds of a switch is rare.
