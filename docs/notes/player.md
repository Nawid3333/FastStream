# The player

> Why the code in this area is as it is. A date on an entry is when it was learned; where
> the code and its tests say otherwise, they win. A section named in quotes may be in
> another file: [README.md](README.md) lists every section.

Sections, by area:

- Player core: "Player core: what the loaders tell the libraries", "Which version of a height gets picked", "A quality lowered when the computer drops frames", "The audio output", "The qualities a page's own player offers".
- Player engines: "Player engines: reasons behind the code", "MP4Player and its MediaSource", "MP4 from servers that do not answer ranges", "An MP4 paused, at its end, and played again", "An MP4's audio tracks", "A file is what its bytes are, and Firefox's own player keeps the page's headers", "AAC in a channel layout of its own, on Windows".
- Downloads and network: "Downloads between players, after seeks and errors", "Players in several tabs take turns", "Loading through the page", "Firefox VPN", "A copy-protected video stays in the page's player".
- Background: "Background: reasons behind the code", "The background's questions to a frame have a time limit", "The background analyses and hostile subtitle files", "A page loaded again keeps FastStream's player".
- Content scripts: "Content scripts: reasons behind the code".
- Utils and options: "Utils, options, enums, dash2mp4: reasons behind the code".
- Measuring: "Measuring two builds: tools/bench-ab.mjs".

What each review and audit found, fixed and rejected is in
[../history/reviews.md](../history/reviews.md); read it before raising a finding again.

## Architecture facts that are easy to get wrong

- **Measured cheap, so left alone (2026-10-01, PF1-PF4).** In the e2e Firefox, on the
  Guardian, BBC, Spiegel and CNN front pages (20 s each):
  - **PF1:** the webRequest listeners ran 49-115 times per page, about 1-6 ms of handler
    time in all. A `types` filter would drop 65-85% of the calls (script, image,
    imageset, font, stylesheet, beacon) but saves no measurable time; not worth risking
    a stream of a type nobody thought of.
  - **PF2:** overlay-guard.js's check took 1.3 ms a second on a 1,500-element page,
    2.3 ms on 5,000, 9.5 ms on 20,000 and 23 ms on 50,000; dropping its per-element
    array spread saved only 5-25%. Since 2026-10-06 it rests while the tab is hidden and
    looks at once when the tab shows (visibilitychange).
  - **PF3:** content.js sends 3 messages per frame per page load, 9-12 on those pages.
  - **PF4:** `querySelectorAllIncludingShadows` took 0.2-3 ms per call, and one-walk
    rewrites were no faster. What it did have was a bug (searching an element's own
    shadow root), fixed and tested in content-cleanup.e2e.mjs.
  - PF1 was looked at again on 2026-10-06 and still left alone, for the same reasons.

- **content.js's measurements re-lay out the in-page player (2026-10-20).**
  `updateReplacedPlayer` sets the player's iframe to `display: none` while it measures the
  page's element: 8 times in the first 2 s of a soft replace, and after every resize. Each
  time, the player gets a resize event and, for a moment, the layout of an iframe's default
  300x150 (traced on CI, runs 39473761807 and 39476690456: a click whose point was taken
  then went to the video). Input in that moment lands in the wrong place, and the player's
  size-dependent parts (its media queries, subtitles) run twice. Left as it is for now
  (#501's fix was the spec's): measuring the page's element without taking the iframe out
  of the layout needs another way to measure, not tried yet. The e2e cases that click in
  the player wait for the measurements to end (content-overlays' `playerAtRest`), and the
  prompt's OK and the bar's click check the layout in the same task as the click (#697,
  `tests/e2e/confirmPrompt.mjs`).
  Only taking the element's styles showed the player again: a throw while measuring (the
  page's DOM refusing a node, a page script the measurement starts) left the player hidden for
  good, a soft replace's element shown and a hard one's stand-in in the page (glm's review,
  2026-11-16). `updateReplacedPlayer` now puts the player's style and id back, hides the element
  again and takes out what it put in, and returns null, which the soft-to-hard check does not
  read as a collapsed element (`contentScript.test.mjs`, "a player whose box keeps changing").

- **Measured and changed (2026-10-06).**
  - A video under five minutes is redrawn every animation frame (`progressLoop`); the loop
    ran on while the video was paused, 144 times a second on a 144 Hz screen. It stops
    while paused (unless the fine time controls are open), and `play()` starts it again
    (player-controls.e2e.mjs counts the updates).
  - The same pattern twice more, fixed 2026-11-13 (a review). With the A-B loop on, its check
    asked for every animation frame, a paused video too: 60 to 144 wake-ups a second for
    nothing. It stops while the video is paused (a GIF being recorded keeps it) and starts
    again with every play (`InterfaceController.play`); a seek made while paused is still kept
    within the loop by the video's `timeupdate`, which already did that in a background tab
    (`loopMenuFrames.test.mjs`, `player-menus.e2e.mjs`). And `AudioAnalyzerNode.volumeLoop`
    re-armed every 64 ms / playbackRate although `recordVolume` returns at once while paused:
    the page woke 125 times a second for the whole video while the background analysis
    (silence skipper, fine-time tool) ran - it plays at 8x and waits paused whenever it is more
    than 60 s ahead of the player, most of the time - and 15 times a second for the main
    player's while paused, hidden tabs included. Paused, the loop now looks every 250 ms; a
    `play` runs its next round at once (the 8x analysis would lose up to 2 s otherwise), and a
    stop clears the next round, so `destroy()` leaves no timer behind
    (`backgroundAnalyzers.test.mjs`).
  - Downloads (#359): a video starts with three downloaders and the speed test decides per
    two samples (per sample since 2026-10-22: "How many at once while short"): playable 0.45 s after the player appears instead of 0.68 s, six
    connections at 1.8 s instead of 3.3 s, the full preload no faster (the line is the
    limit). An HTTP 429 or 503 halves the downloaders (one stays), stops the test and holds
    every download for its Retry-After (30 s at most); the player starts its next video with
    one. Changed the same evening (the user: "as fast as the server allows"): FetchLoader
    retries a 429 too and tells each 429/503 at once (onSlowDown); answers of one burst
    (2 s) halve once; a downloader taken away mid-fetch hands its download back to the
    queue, one delivering a finished download finishes first (StandardDownloader.retire -
    before, the player heard "aborted" and a finished piece was thrown away); after a calm
    period (15 s or the Retry-After, doubling per slow-down in a row, 2 min at most) the
    speed test probes again, and a probe that climbs without a slow-down ends the caution.
    The next video's speed test after a slow-down is such a probe.
  - A decoder Firefox cannot create (its error names InitIPDL) leaves its codec out after
    one decode error, not two (LevelManager.noteVideoDecodeFailure): HEVC on a GPU-less
    Windows Firefox left a live DASH stream at "Failed to load video!".

- **`play()` does not wait for the audio (2026-10-01).** With no sound device (CI's Linux
  runner) the player's AudioContext stays suspended and `resume()` never settles; `play()`
  waited for it, so it never finished, and autoplay's `autoPlayTriggered` was never set.
  `startAudio()` now starts the context once, without waiting, and starts the background
  analyzer when the audio runs (client-setup.e2e.mjs fakes the never-settling resume).
  Specs that need actual sound (firefox.e2e.mjs's 8x pin; audio-tools.e2e.mjs until the audio
  settings went, 2026-10-10) check for it; without it they skip, except on Linux CI, which has a PulseAudio null sink since
  2026-10-03 and fails them there (`tests/e2e/soundCheck.mjs`, #265).

- **Nothing else in the tab plays while FastStream's player does (2026-10-04).** Opening
  the player pauses what is inside the box it takes over (content.js `pauseAllWithin`,
  content-cleanup.e2e.mjs). A site's player outside that box, or in another frame, played
  on under FastStream's, and the user heard both, typically a video started before
  FastStream was turned on. Now the player reports its play and pause (`PLAYER_PLAYING`,
  `FastStreamClient.reportPlaying`; also "stopped" when its context goes with a source
  change). The background keeps `tab.playingPlayers` and sends every frame
  `HOLD_PAGE_MEDIA` (`sendPageMediaHold`). While held, a frame pauses its media and pauses
  again whatever the page starts (`pauseHeldMedia`, a `play` capture listener on the
  document and on the shadow roots content.js listens in). The hold ends when the player
  pauses, when its frame goes (`FRAME_REMOVED` from the player, or from the page naming
  its iframe), and with `REMOVE_PLAYERS`; a frame that loads meanwhile gets it too.
  - **Fails open:** a player frame the tab no longer knows counts as stopped, and a
    restarted background releases on the player's `FRAME_REMOVED`, so the page is never
    left unable to play.
  - **Not reached:** media never in the document (`new Audio()` kept detached), and Web
    Audio. Their `play` events reach no listener, and hooking the page's
    `HTMLMediaElement.prototype.play` was judged too intrusive.
  - **Tests:** page-media-hold.e2e.mjs (another video in the page and a sound in a
    cross-origin frame; it fails on the code before), backgroundPageMediaHold.test.mjs, and
    contentScript.test.mjs `HOLD_PAGE_MEDIA`.

- **Already Manifest V3.** `chrome/manifest.json` is `manifest_version: 3`
  with a `service_worker`. `build.mjs` rewrites that to `background.scripts`
  (a non-persistent event page) for Firefox. There is no MV2 migration to do.
- **Nothing is bundled.** The browser loads every `.mjs` file natively as
  ES modules. `build.mjs` is a file-copier plus a conditional-compilation
  preprocessor — not a bundler. Introducing whole-tree bundling is a
  behaviour change, not a refactor.
- **The hls.js/dash.js hooks are already the official public APIs.**
  `HLSPlayer.mjs` passes `loader: HLSLoaderFactory(this)` (hls.js's
  documented config option) and `DashPlayer.mjs` calls
  `dash.extend('XHRLoader', DASHLoaderFactory(this), false)` (dash.js's
  public extension point). The AMO problem is that the vendored *bytes*
  aren't an official release — not that the integration is hacked.
- **Vendored library versions are current**, not stale: dash.js reports
  `VERSION = '5.2.1'`, hls.js is 1.7.3 (`package.json`). The vendored dash.js
  was a pre-release `development` build, not 5.1.0 - measure a patched
  bundle against the commit it was built from, not the nearest release
  (`docs/vendored-libraries.md`, dash.js "Status").

## Player core: what the loaders tell the libraries

- **hls.js's playlist loader has no `onAbort`** (`hls.mjs`, `PlaylistLoader.load` passes
  `onSuccess`/`onError`/`onTimeout`). `HLSLoader` reports a failed playlist with `onError`
  and `FetchLoader`'s `stats.error` (`{code, text}`). A fragment or key that fails gets
  `onAbort` after 1 s, and hls.js picks it again: upstream's design. (`FetchLoader` itself
  does not retry a segment hls.js asks for: hls.js's `maxRetry` for it is 0. The six retries
  are those of a download ahead, and of DASH and MP4; corrected 2026-11-14.) From the third
  failure in a row of the same one it gets
  `onError` (`SEGMENT_FAILURES_BEFORE_ERROR`), so hls.js retries it by its own policy and
  fails the player once it gives up; for good, a dead segment (an expired token's 403) spun
  forever. `DashLoader` counts the same way and then gives dash.js `onFail` and the player an
  error (2026-09-30). `MP4Player` asks a failed range again after 2, 4 and 8 s, then shows
  the error once playback reaches it (`retryFailedRange`).
- **`<video>` fires no `error` for a manifest that never loaded.** `HLSPlayer` passes a
  fatal `Hls.Events.ERROR` on as `DefaultPlayerEvents.ERROR` (after a fatal error hls.js
  loads nothing more). `DashPlayer` does the same for dash.js's manifest codes
  (`MediaPlayer.errors` 10, 11, 25) until `initialInit`. Before that, a dead `.m3u8` or
  `.mpd` spun forever (`failed-load.e2e.mjs`).
- **`DownloadManager.getFile` answers a finished download from its store** (keyed by URL,
  range and type). So a playlist or manifest that gets loaded again must be removed once
  loaded, and `HLSLoader` and `DashLoader` do that. Before, a live HLS stream stopped
  where its first window ended: one request reached the server in 30 s
  (`hls-live.e2e.mjs`). dash.js reloads a live manifest only once playback has started
  (`ManifestUpdater`'s `isPaused`), and a local live MPD never got that far in the web
  player. So the DASH side is covered only by `tests/unit/manifestReload.test.mjs`, which
  runs the real loaders and download manager.
- **`HLSPlayer.trackUpdated` starts at `levelDetails.fragments[0].start`.** hls.js has
  aligned a live playlist to its timeline before `LEVEL_UPDATED`; a VOD playlist's first
  fragment is at 0.
- **mp4box 2.x's `info.fragment_duration` is a `{num, den}` fraction.** Without a `mehd`
  box it is also only what had been parsed when the metadata was read. So
  `MP4Player.calculateDuration` reads `mehd` itself, and otherwise the tracks as they grow.
  Dividing the fraction gave NaN, and every fragmented MP4 died at the start. A long
  fragmented MP4 still stops after about 3 s in `MP4Player` (not fixed).
- **A save pins its fragments (`ReferenceTypes.SAVER`) last**, just before the `try` whose
  `catch` unpins them. Anything that throws in between leaves them pinned for the session.
  It downloads them through `players/SaveFragmentFetcher.mjs`: the next few (the user's
  downloader limit) while the converter reads the current one, in order; the `catch` calls
  its `cancel()`, which aborts what is still downloading for the save. They go at priority -1,
  and nothing else cancels or holds them: not the network yield, not a paused player's hold
  (2026-10-09, "Downloads between players").
- **A partial save keeps the time of the fragments it lacks** (2026-10-04, #224). Both
  writers place samples one after the other, so a hole would close up. `MP4Merger` (DASH)
  and `HLS2MP4` (HLS) stretch the last sample before a hole until the next fragment's
  decode time. In HLS that is only within one timeline (same `cc`, a jump in `sn`): at an
  `EXT-X-DISCONTINUITY` the clock starts over, and the pieces are written back to back. An
  audio rendition has holes of its own, and without the padding it played out of step with
  the video after the first one (`hls2mp4.test.mjs`, "discontinuities"). **Since 2026-11-13 (a
  review) it also says how long it is.** An Alt-click save of 10 minutes of an hour-long stream
  said it lasted an hour (Firefox takes `video.duration` from the moov), with a seek bar to
  match: both converters wrote the whole stream's length into mdhd, tkhd and mvhd (`HLS2MP4`
  hls.js's level `totalduration`, `MP4Merger` the DASH period's). In both `finalize()`s the
  media's length (mdhd) is now the sum of its sample durations, the track's (tkhd) what its edits
  present, and the movie's (mvhd) the longest track's; `MP4Generator` rounds the three to its
  ticks and takes tkhd/mvhd from the new `presentedDuration`. `hls2mp4.test.mjs`,
  `mp4merger.test.mjs`.
- **Fast playback needs no bigger forward buffer** (measured 2026-10-04, #214). hls.js keeps
  10 s ahead (`maxBufferLength`), which at 8x is 1.25 s of wall time. In the e2e Firefox on
  the owner's PC: a 10 min 720p HLS at 3 Mbit/s with 4 s segments, a 15 s pre-buffer, then
  30 s of wall time at 1x, 4x and 8x (the player's limit; 16x is clamped to 8x). There were
  no `waiting` events and no time at `readyState` < 3, and the forward buffer never fell
  below 9.1 s. With the buffer at 10 s × rate (at most 60 s), the result was the same.
  hls.js reads the next fragment from the download manager's store, which is filled ahead
  by `DownloadManager`, not by this buffer; on a network slower than 8x the bitrate, a
  bigger MSE buffer would not help either. "Auto" quality stays "the highest level", as
  decided on #316 (D5).
- **`DownloadEntry.notifyWatchers`**: a watcher that throws neither silences the others
  nor skips the cleanup. `StandardDownloader.onSuccess` cleans up in `finally`, or the
  downloader stays busy for good - but only while it still holds the entry it delivered
  (upstream #568, ported 2026-10-15): an abort during the delivery (a watcher giving up on an
  AES-128 segment during its decryption, the downloads paused) has cleaned up already, the
  manager may have given the downloader its next entry, and a second cleanup ended that one,
  left "downloading" for good. `cleanup()` also resets `delivering`.
- **An HLS segment hls.js aborts leaves `HLSPlayer.activeRequests`** (2026-11-13). A loader
  leaves the list in its download's `onSuccess`, `onFail` or `onAbort`, and a download with other
  watchers tells only its last watcher that it was aborted (`DownloadEntry.abortWatcher`): an
  aborted loader that was not the last heard nothing and stayed in the list for the session, its
  loader and callbacks kept in memory, and the seek preview, the list's only reader, took it for
  a segment still loading. `HLSLoader.abort()` takes its loader out itself. `DownloadEntry` is
  unchanged: telling every watcher would reach the other players' and the saves' handlers.
  `HLSLoader.test.mjs`.
- **`SubtitleTrack.equals`** (`SubtitlesManager.addTrack` keeps one of two equal tracks): the
  same cues are one track unless the name *and* the language differ, as upstream has it. The
  2026-09-11 review took that `&&` for a typo, and the same file under another name was listed
  twice (restored 2026-10-15, `tests/unit/SubtitleTrack.test.mjs`).
- **`setSourceInternal`'s progress chain returns if another source came in**, both before
  it switches progress saving off and after it waits for the player. The wait ends when
  whichever player is current is ready, which may be the next source's.

## Which version of a height gets picked

`LevelManager.pickVideoLevel` used to take the highest bitrate among the versions of the
chosen height and never looked at the codec: 1080p AV1 at 2.5 Mbit/s lost to 1080p H.264 at
5 Mbit/s, and on a GPU without AV1 decoding a higher-bitrate AV1 version was decoded in
software. Now the players ask Firefox first (`players/DecodingCapabilities.mjs`, the Media
Capabilities API's `decodingInfo`) and `rankHeightGroup` orders the versions of that height
by, in turn: playable, no HDR the screen cannot show, decoded in hardware (`powerEfficient`,
which in Firefox means a hardware decoder), smooth, HDR when screen and decoder both can,
frame rate, codec efficiency (AV1 > VP9 = HEVC > H.264), bitrate.

- **It only reorders, and only within the height.** `matchQuality` still decides the height
  (the user's setting), so no answer ever lowers the resolution; nothing is removed. A
  version without an answer (no codec in the playlist, a probe that timed out) sits between
  hardware and software ones.
- **Frame rate and codec count only between hardware-decoded versions.** Between software
  ones, or ones without an answer, the bitrate decides as before: a deviation from the old
  pick needs a known hardware decoder behind it.
- **The answers are in before the first pick.** The pick is synchronous (dash.js calls it
  from its track selection). HLS: the `MANIFEST_PARSED` handler awaits the probes before it
  emits, picks and calls `load()` (`autoStartLoad` is off). DASH:
  `registerCustomCapabilitiesFilter` - dash.js 5.2 awaits custom capability filters
  (`CapabilitiesFilter._applyCustomFilters`, after its own codec filter) before selecting
  tracks. The filter always answers true. It gets the representation as parsed, with the
  AdaptationSet's `codecs`, `mimeType`, `frameRate` and `EssentialProperty` pushed down
  (dash.js's objectiron `commonProperties`). A probe gives up after 1.5 s, and a timed-out
  one is asked again next time, not remembered as unknown.
- **The container priority still runs after it**: with the default `mp4`, a WebM VP9 version
  of the same height loses to the MP4 ones unless the user picked WebM. Unchanged.
- **HLS audio levels store a whole MIME type** (`audio/mp4; codecs="..."`) in `audioCodec`,
  DASH a bare codec; `bareCodec` reads both.
- **A codec picked by hand is now a family per site** (`videoCodecFamilyBySite`, the 200 most
  recent sites; the site is the source's Referer or Origin, else the stream's host, without
  "www."). It was one global exact string (`prioritizedVideoCodec`, "avc1.640028"), which
  seldom matched anywhere else and, where it did, overrode every site. The old value is
  ignored.
- The option `decodingAwareQuality` (on) switches the ranking and "playable audio first" off.
  The quality menu shows HW/SW (`getDecodingLabel`) and the codec name of each version.
- **Measured:** unit tests only (`tests/unit/decodingAwareQuality.test.mjs`,
  `DecodingCapabilities.test.mjs`, the `setOptions` test in `FastStreamClient.test.mjs`); 20
  of the ranking tests failed against the old `LevelManager`. Not yet run in a real Firefox:
  check a stream with AV1 and H.264 at one height, the menu's labels against
  `about:support`'s codec table, and the start-up delay the probes add.
- mpv still picks its own version (`--hls-bitrate`, highest): issue #330.

## A quality lowered when the computer drops frames

His wish: a version this computer cannot decode in time is stepped down, and never without a
word. `DroppedFrameWatch.mjs` reads Firefox's `getVideoPlaybackQuality()` once a second at the
time updates (`watchDroppedFrames`).
- **When**: a fifth of the frames dropped over 10 s of steady playback, after a version's first
  4 s, and only with 100 frames or more in the stretch. Steady means playing at 0.5x-1.25x, not
  seeking or starving, in a visible tab or in picture-in-picture. A seek, a change of speed, a
  stall and its end start the stretch again (the counts run on through them).
- **Where to**: the best version of the next smaller height, else the same height at a lower
  frame rate (`lowerLevel`); nothing lighter, nothing done and nothing said.
- **Said**: the status line, 15 s: "Quality lowered to 720p: this computer dropped 30% of the
  frames at 1080p. Choose 1080p in the quality menu to keep it." A height that comes at two
  frame rates is named with its rate (720p60).
- **A version picked by hand** in the quality menu is never stepped down from, also through
  the new player another of the page's files plays in (`keepChoiceOnce`); a new video forgets
  it. Nothing steps back up by itself.
- Off with the option `lowerOnDroppedFrames` ("Lower the video quality when this computer
  cannot show all frames in time").
- **Measured:** unit tests (`DroppedFrameWatch.test.mjs`, `FastStreamClient.test.mjs`,
  `statusLevels.test.mjs`) and `page-qualities.e2e.mjs` in Firefox 158, where the video's
  count is stood in for (a third dropped): 720p stepped down to 360p with the message, and
  720p picked again stayed. Red without each part. Not measured: a real slow computer.

## The audio output

His wish: the sound on another device than the system's default (headphones, say).
`AudioOutputDevice.mjs`; the audio button's list has an "Audio output" part: Default output,
the device chosen, "Choose an output...".
- **How**: all of the player's sound runs through Web Audio, and Firefox has no
  `AudioContext.setSinkId`. For a chosen device the graph's end goes into a
  `MediaStreamAudioDestinationNode`, whose stream a hidden `<audio>` plays with
  `setSinkId(device)`; the graph moves over only once that plays. For the default output
  nothing changes: the graph ends at the context's destination, as before.
- **Measured on Firefox 158** (extension pages; the harness answers the chooser with
  `media.navigator.permission.disabled`):
  - `selectAudioOutput` and the element's `setSinkId` exist; in a page's iframe only with
    `allow="speaker-selection"` (else `NotAllowedError`, "Document's Permissions Policy does
    not allow..."). content.js gives the player's iframe that token.
  - `selectAudioOutput` needs a click, also with a known `deviceId` (`InvalidStateError`
    without one).
  - A device is usable only in the document it was chosen in: the next video's player
    (a new document) gets `NotFoundError` for the saved id.
- **So**: the choice is kept (`chrome.storage.local`, `audioOutputDevice`), and each new
  video starts on the default output and says so in the status line: "click here to play it
  on <device>". The click opens Firefox's chooser with that device picked (or nothing picked,
  when it is gone). A device unplugged while it plays (`devicechange`, gone from
  `enumerateDevices`) sends the sound back to the default output, with the same notice.
- **Not established**: whether a real prompt can be remembered so that the chooser no longer
  shows; the latency the detour adds (A/V sync); whether more than two channels get through it.
- **Tests**: `AudioOutputDevice.test.mjs` (20, drafted by glm-5.3-flash and checked; each
  review fix red without it), `statusLevels.test.mjs` (the clickable status message),
  `audio-output.e2e.mjs` in a page's iframe (chooses, the next video's notice and its click,
  back to the default; skips on a machine with no audio output).

## The qualities a page's own player offers

His report (a film on a film site, its hoster): the player showed one quality and played the
lowest, though the page's player offers three; MPV mode sent the lowest too. The hoster's
Playerjs is set up with `file: "[360p]<get_file link>,[720p]...,[1080p]..."` and
`default_quality: "360p"`; the page's video asks for the 360p link, which answers with a 302 to
the CDN (`remote_control.php?time=...`). That one request was all FastStream saw. Measured in the
test Firefox: `player.api("qualities")` gives only the labels (`["360p","720p","1080p"]`); the
links are only in the page's script. FastStream had the 360p file twice (the link, from the
video's `loadedmetadata`, and the CDN's address) and played the CDN's.

- **Reading them** (`chrome/page-qualities.js`, a content script before content.js; the
  background asks with `GET_PAGE_QUALITIES`): `<source>` lists with a quality attribute (Plyr's
  `size`, Video.js's `label`/`res`, Fluid Player's `title`, OpenPlayerJS's and MediaElement's
  `data-quality`), Artplayer's instances (`option.quality`, checked against its 5.4.0 typings),
  JW Player's playlist item (`sources` with labels), a DPlayer in a page variable (it keeps no
  list of its instances), and Playerjs's file string in the page's scripts. Only what the page
  holds; no guessed sibling URLs. A list counts with 2 to 12 files.
- **Tying them to the stream** (`PageQualityPick.listForSource`): the stream's URL, or the address
  its request was first made to (`TabHolder.noteRedirect`, from `webRequest.onBeforeRedirect`; the
  source keeps it as `requestedUrl`). `sendSources` asks each frame the streams came from
  (`attachPageQualities`, 1 s at most) and sends the list as `qualities`.
- **Playing them** (main.mjs): the stream played is the entry the quality setting asks for
  (`pickQuality`: the smallest at or above it, Auto the highest; none when no entry says its
  height). The quality menu lists them (`FastStreamClient.getMenuVideoLevels`, ids
  `page-quality:<i>`); the player's own levels stay as they were, for the analyzers, the
  downloads and the embed API. A pick plays the file from the same time, nothing of its start
  first (`playPageQuality`, the start-time path of #465). The remembered time goes by the list's
  first file (`VideoSource.setQualities`): it went by the URL played, and the CDN's
  `remote_control.php` was the same for every film on its node.
- **MPV mode** (`openInMpv`): the same pick, asked of the page at the hand-off; the list goes in
  the host message as `qualities` (`MpvBackend.relayQualities`). Host 11 ignores the field; mpv
  offering the list is the next step (docs/notes/mpv.md). The player's own mpv button is not
  overridden.
- **Tests:** `pageQualities.test.mjs` (the hoster's real file string, each player's shape),
  `PageQualityPick.test.mjs`, the menu and the switch in `FastStreamClient.test.mjs`, MPV in
  `backgroundMpv.test.mjs` (the hoster's redirect; two fail without the pick), and
  `page-qualities.e2e.mjs`: the hoster rebuilt locally (a cross-origin frame, the file string,
  302s to a "CDN") - the 720p file plays, the menu offers both, a switch at 4 s goes on at 4 s.
  Live, on the real hoster (the same file): 1080p (1920x816) played, 360p/720p/1080p listed, the
  switch to 720p went on from where it was.

## Player engines: reasons behind the code

- **`hls2mp4/transmuxer.mjs`** - hls.js reads `chunkMeta.iframe` unconditionally at the top of
  `demux`, `resetInitSegment` and `remux`. Outside hls.js's own pipeline nothing builds a
  `ChunkMetadata`, so one inert instance (with the level's duration) is passed to all three. In
  `demux` the flag after it is `isSampleAes`, then `flush`: without the flush, the PES data at the
  end of the last segment is never parsed, and a save loses the video's last frames and the
  audio's last packet.
- **`Transmuxer` typeSupported** - The output is an MP4 file, not something MSE has to take: MP3
  goes in as MP3 in MP4 (bare MPEG audio has no mdat for HLS2MP4 to place and no sample entry in
  MP4Generator), and AC-3 is declared supported, else hls.js drops the track; MP4Generator writes
  it as `ac-3` with its `dac3`. TSDemuxer logs through the logger it is given, and without one its
  first report (HEVC found, AC-3 skipped, a damaged packet) throws and fails the save.
- **`HLS2MP4.pushChunk`** - Each transmuxer (the level's, the audio rendition's) counts from its
  own stream's first timestamp (the initPTS hls.js picks after each reset). The chunks keep the
  stream's clock instead, which both renditions share, so the tracks start as far apart as they
  played.
- **`HLS2MP4.setup` edit lists** - An edit's media time is measured on the samples as they are
  written, one after the other: across an EXT-X-DISCONTINUITY the stream's timestamps start over
  (or jump past a fragment a partial save lacks), and an edit worked out from them shows only the
  first piece of a stream with ad breaks in players that follow edit lists (mpv, VLC, ffmpeg).
  The edit lasts as long as the track's media, its last presented end included: a stream cut in
  decode order (a recording stopped inside a group of pictures) shows a frame past the decode
  timeline's end.
- **`HLS2MP4.setup` video sample entry** - The `avc1`/`hvc1` entry with its parameter sets comes
  from hls.js's own MP4 writer, so hls.js's changes to it come with hls.js. It is made here and
  handed to MP4Generator as `codecBuffer`, not made inside MP4Generator: a DASH save would then
  load hls.js.
- **`HLSFragmentStore`** - A level's segments are stored from its first one, at `sn - snBase`. A
  live stream may start its media sequence numbers anywhere (millions, a timestamp), and the
  client walks each level's array every second (freeing, the next download, the buffer bar):
  indexed by sn, every hole below it was walked each time (52 ms a walk at 2 million in Node).
- **`SegmentAppender`** - A SourceBuffer refuses an append by throwing (QuotaExceededError when
  full, InvalidStateError when its MediaSource is gone). MP4Player releases a segment's samples
  from mp4box as soon as it is queued, so a refused segment is gone: the player loads again from
  the playhead (reading less ahead when the SourceBuffer was full), and the third refusal in a row
  is its error. Refusals of segments appended before the last reload, or of SourceBuffers no
  longer in use, are that reload's business.
- **`HLSDecrypter`** - `decrypter-worker.js` answers a failure (a wrong key, an IV that is not 16
  bytes, a download cut short) with 0 bytes and an error. No data is a failure, never a result:
  stored, it would be the segment, complete and empty. A worker that fails to load or throws
  answers nothing: what waits fails, and the next decrypt starts a new worker.
- **`SourceBufferWrapper`** - An operation that throws starts no update, so no `updateend` follows
  it: the wrapper must not stay marked updating, nor keep the operation at the head of the queue.
  `remove()` resolves once the removal has started, not once the range is gone: `buffered` holds
  it until the removal's `updateend`. `removalPending` exists for that: a seek decides from
  `buffered` whether to load anew, and a seek to 0 just after a jump to the end found the start
  still buffered (the removal of everything waited behind the end's appends), did not reload, and
  the removal then took the start away with nothing loading it again.
- **`SampleIndex.RangeTimes`** - Each range's earliest time is kept and worked out again only for
  the ranges new samples fall in (working out every range from every sample at each moof took
  10 ms a call on a 2-hour file, once per megabyte read). It is kept only while the sample list
  stays sorted by offset, which `minTimeIn`'s binary search needs; a list that gets an earlier
  part after a later one (a seek back) is worked out whole each time.
- **`StallWatchdog`** - Firefox sometimes stops a video that says it is playing after a seek back
  into what is buffered: not paused, not seeking, readyState 2 with minutes buffered, its time and
  frame count still. `play()` restarts it at the time its clock has run on to, a minute later; a
  seek starts it where it was sought to, so a stuck video is sought a little forward, as hls.js
  does.
- **`LevelManager.rememberVideoChoice`** - A version picked by hand stores its codec family only
  when the click chose between codecs (`isCodecChoice`). A quality with one version, or versions
  that differ only in bitrate, says nothing about codecs: the family stored from such a click
  outranked hardware decoding at every height on that site.
- **`HLSPlayer`'s hls.js config** - `_abandonRulesCheck` (hls.js dropping quality mid-fragment)
  fights pre-buffering far ahead; it is an instance property set in the base constructor, so it
  is reassigned after `super()`. hls.js's text tracks and metadata cues are off: FastStream shows
  none of them, and hls.js otherwise decodes CEA-608 captions and makes ID3, emsg and DATERANGE
  cues for every fragment. Interstitials are off: hls.js plays each in a player of its own made
  from this config, which FastStream does not drive (measured: a replacing break skipped the
  stream's start and ended inside the break). `preserveManualLevelOnError`: hls.js's error
  controller otherwise resets a pinned level to auto on a load failure, and its bandwidth ABR
  settles lower while LevelManager believes the user's quality is in effect.
- **`HLSPlayer.saveVideo`** - A level is fMP4 exactly when its playlist names an init segment, and
  those go to the merger (through DASH2MP4, for its remux fallback); HLS2MP4 demuxes transport
  streams only. A level that carries its own audio goes there too: the audio side is handed over
  only when it is a rendition of its own.
- **`HLSPlayer.saveVideo`, `DashPlayer.saveVideo` (keepPinned)** - A fragment is let go of once
  read, except for the remuxer: it reads the store's own Blobs as it writes, after reading them
  all, and a fragment freed before that reads nothing. Those stay pinned until the save ends.
- **`HLSLoader`** - hls.js's `timeout` is the longest a whole load may take (120 s for a segment),
  FetchLoader's how long nothing may come; it is capped at `STALL_TIMEOUT_MS`, else a dead
  connection held playback for two minutes. A stored segment answers a request only for its own
  place (`isSamePlace`): a live stream that starts its numbering again gives a new segment a
  stored one's number, and only when both its address without the query (a rotating token) and
  its place (start, duration) differ is it another. hls.js's playlist loader passes no `onAbort`,
  so a failed playlist is reported as an error, which hls.js retries.
- **`DashLoader`** - The loader dash.js extends has `resetInitialSettings`: HTTPLoader calls it
  when a decode error resets the MediaSource, and without it the reset threw and the stream never
  recovered. A segment it downloads itself gets the download manager's retries (dash.js retries
  nothing); a manifest fails at the first error, so a source that is down shows so at once.

## MP4Player and its MediaSource

`MP4Player` (accelerated MP4) feeds mp4box-extracted samples into a
MediaSource through one `SourceBufferWrapper` queue per SourceBuffer; `mainLoop()` runs
`runLoad()` every **1 ms**. Three things that were wrong, and what now holds:

- **`endOfStream()` is called** (`checkEndOfStream`) once every fragmented track's
  `nextSample` has reached its sample count and both queues are idle. Without it Firefox
  waited for data after the last frame: playback at the end sat buffering and never fired
  `ended` (`FastStreamClient`'s WAITING handler papers over it for autoplay-next only:
  waiting in the last second counts as the end), and a seek to exactly the duration never completed. An append or a
  removal after it reopens the MediaSource by itself (MSE spec), so seeking back just works.
- **A seek past one track's end completes** (2026-11-13). mp4box's seek skips a track the time
  is past the end of (`ISOFile.seek`: `if (time > this.getTrackDuration(trak)) continue`). In a
  file whose sound ends a little before its picture (or the other way round), a seek into that
  last stretch (the End key, the end of the seek bar) left the shorter track at its old place,
  whose bytes the reset had thrown away and nothing loaded again: it never finished,
  `checkEndOfStream` never ended the stream, and the video stood seeking for good, the main loop
  running every millisecond. `MP4Player.seekMp4box` (from `resetHLS` and `startSegmentation`)
  puts such a track at its own last keyframe (mp4box's `seekTrack`), whose range `runLoad` reads
  anyway; it is appended, the track finishes, the stream ends. Tracks the time is inside stay
  where mp4box put them. `mp4TrackEnd.test.mjs`, `mp4-seek.e2e.mjs`.
- **The back buffer is trimmed only when it is worth it** (`removeBackBuffer`): while the
  SourceBuffer is idle and holds more than 1 s beyond the 10 s kept. It used to call
  `remove(0, time - 11)` on both SourceBuffers on every loop - measured ~2,300 removals in
  5 s of playback, almost all of nothing - which kept the queues busy, starved appends on
  a slow CPU (tens of thousands queued) and reopened the MediaSource after `endOfStream()`.
  What stays behind the playhead is unchanged (MSE drops video up to the next keyframe).
- **`SourceBuffer.abort()` and `mediaSource.duration =` throw unless the MediaSource is
  `open`.** `destroy()` and `updateDuration()` check it; a throw in `destroy()` left the
  player half destroyed without `DESTROYED`, which the background audio analyzer then
  retried every animation frame.
- **A destroyed player's SourceBuffer queues stop at once** (2026-11-13). `destroy()` let go of
  a held duration first (`DurationSync.clear`), which started the next queued append on the
  dying player; the abort's `updateend` then ran every queued operation (peaks of 2,000-3,000
  one-frame appends are measured) against a SourceBuffer the MediaSource had let go of, and
  each threw and logged an `InvalidStateError`. `SourceBufferWrapper.dispose()` drops the queue,
  starts nothing more and takes its `updateend` listener off; `destroy()` calls it on both
  wrappers before anything else. The dropped operations' promises stay unsettled on purpose:
  nothing awaits them, and a rejection would have their handlers report errors about a player
  that is gone. Only `MP4Player` uses `SourceBufferWrapper` (hls.js and dash.js have their own
  buffer code). `SourceBufferWrapper.test.mjs`.

`video.buffered` shows only what the queue has applied, not what is queued: a test that
waits for a range to be buffered after a reset can see stale appends that a queued removal
is about to delete; wait for idle queues (`toDo` empty, not `updating`) as well.
`tests/e2e/specs/mp4-seek.e2e.mjs` covers the above.

- **Each video frame goes to the SourceBuffer as soon as its bytes are in (2026-11-06).**
  mp4box's segment option `rapAlignement` (on by default) lets a segment boundary fire only on
  a keyframe, and `createFragment(start, end)` includes `end`: with `nbSamples: 1` the first
  frame went alone, and every frame from there to the next keyframe went in one segment, once
  the last of them was downloaded. The video showed its first frame and stood there for the
  whole keyframe interval - and the same after every seek and every stall. It is off for the
  video track now. Where a run of segments starts is unchanged: a seek's `mp4box.seek(time,
  true)` starts at a keyframe, and segments started after a keyframe (not on one) before too,
  so Firefox already took segments that start on an ordinary frame (glm's review agreed); new
  is only that they are one frame each. Measured in the e2e Firefox, long-av.mp4
  (keyframes 8.3 s apart), a local server with 150 ms to the first byte, builds served by turns
  (4 rounds, medians): playback started 1.9 s sooner on a shared 12 Mbit/s line (3880 -> 2015
  ms) and 3.3 s sooner at 4 Mbit/s per connection (7359 -> 4047 ms), a resume at 6 s 1.7 s
  sooner (3827 -> 2176 ms, separate runs); a seek to 80 s / 85 s about 1 s sooner on the
  shared line (4469 -> 3405, 4580 -> 3530 ms), the same per connection; first frames and the
  requests at the start unchanged.
  `tests/e2e/specs/mp4-first-frames.e2e.mjs`: the server holds back every range after the
  first, and the video must play from the first one.
  - **Not done: joining queued appends into one `appendBuffer` call.** With one append per frame
    a range queues hundreds; joined (up to 2 MiB) they were measured slower, not faster -
    Firefox uses none of a joined append's frames before it has parsed all of it: playback
    70-100 ms later, a seek per connection 90 ms later, by turns with the same builds.
- **A range goes to mp4box as it downloads (2026-11-07).** It went only once all of its 1 MB was
  in: the first frame waited for the whole first range though it needs only the moov and its own
  bytes, and a seek for the whole range holding its keyframe. FetchLoader now tells each piece of
  a range's own answer as it comes (a 206 with its Content-Range; not a whole file cut to the
  range, not text), StandardDownloader and DownloadEntry pass it on (the entry keeps the pieces
  so far for a watcher that joins on the way, and gives them to it in order a microtask later;
  none for an answer processed before it is stored, an encrypted segment), and
  `MP4Player.feedPiece` gives mp4box each piece at its place in the file, for its own request
  only: from the range's start, without a hole, never a byte twice (a retried download starts
  over), only an answer whose Content-Range starts where the range does; before the moov only
  the file's first range, an MP4's, whose answer gives the file's length (set first: mp4box
  needs it before it parses the moov). When the range is in, its handler appends what was not
  fed and runs its checks as before; a seek's reset forgets what was fed. Same measurement as
  the entry above (4 rounds by turns): first frame 1889 -> 1065 ms on the shared line, 3921 ->
  1567 ms at 4 Mbit/s per connection; playing 2029 -> 1205 and 4053 -> 1708 ms; a seek to 80 s
  3431 -> 2642 and 3435 -> 2726 ms; a seek to 85 s the same (3538/3527 -> 3487/3542, within the
  runs' spread); buffered at 8 s 29.9 -> 36.3 and 31.9 -> 38.9 s. glm's reviews found no
  double-fed byte; its three points (a snapshot of the metadata state used only when bytes were
  fed, the Content-Range start check, a piece counted only once mp4box took it) are in.
  `tests/unit/mp4Progressive.test.mjs`, and the piece relay in the FetchLoader and DownloadEntry
  tests.
- **The seek preview of a fragmented MP4 without a `mehd` box shows the place pointed at
  (2026-11-13).** For such a file (ffmpeg's `frag_keyframe+empty_moov`, live recorders) it
  showed the frame at about 9 s for every place past 9 s. Its duration is known only as far as
  its moofs have been parsed ("mp4box 2.x's `info.fragment_duration`", below), and the preview
  reads only up to its first frame (`runLoad` stops at readyState 2): its MediaSource duration
  stayed at about 9 s while the main player knew 160 s, the element landed a seek to 120 s on
  9 s, which was buffered, and nothing loaded. A preview's place past the duration it knows is
  now held (`previewSeek`, which `currentTime` returns) while the preview reads on past its
  first frame, and `runLoad` seeks there once the duration reaches it or the last range is in.
  What it reads on the way is not appended (the seek's reset would remove it), only its
  duration kept, and the ranges behind the held place are let go of as it reads on, as those
  behind the playhead are while a video plays: held, a far hover into a long file kept most of
  it in RAM, which the memory budget cannot let go of, and stopped the main player's downloads
  ahead. The request loop starts at the range of the last keyframe known before the place, so
  none is asked for again. `FastStreamClient.updatePreview` shows the preview only when its
  element is at the player's time, so the old frame is hidden meanwhile (every other player's
  time is its element's). `mp4PreviewPastDuration.test.mjs`, `FastStreamClient.test.mjs`,
  `mp4-seek-preview.e2e.mjs`.
- **A player for sound only plays no picture (2026-11-13).** With a video delay set on an MP4,
  the two extra audio players (and the audio analyzer's player) each buffered and appended the
  video too, frame by frame: the MediaSource memory (about 30 s ahead and 10 s behind of video
  in each) and the per-frame work three times over. `MP4Player` looked at `isAudioOnly` only to
  make an `<audio>`. `playedVideoTrack()` gives no video track to a player for sound only of a
  file with sound; `makeSourceBuffers`, `startSegmentation` and the keyframe index
  (`currentFragment`) use it, as the seek preview leaves out the sound. The ranges' times still
  come from the video track, as the main player's do (the fragment store is shared). A file
  without sound keeps its picture in such a player, as before. `mp4AudioOnly.test.mjs`,
  `video-delay.e2e.mjs`.

## MP4 from servers that do not answer ranges

`MP4Player` loads a file in 1 MB ranges and takes its length from `Content-Range`
(`RangeAnswers.mjs` reads the first answer). Two kinds of server broke that:

- **A server that ignores `Range`** answers 200 with the whole file. `FetchLoader` cuts the range
  out and stops reading, so every range downloaded the file from byte 0 again up to its end:
  18 whole-file requests for a 17 MB file, about 2 TB for a 2 GB one. Unless the whole file came
  in that first answer (its `Content-Length`, or fewer bytes than asked), the source goes to
  Firefox's own player (`PlayerModes.DIRECT`, `FastStreamClient.playDirectly`) at the time it was
  at, once per source; 3 requests in all. The page's headers go on the element's requests
  through the background's rule for the URL (`DirectVideoPlayer.setHeaderRule`), minus `Range`
  and the connection's own (`elementHeaderCommands`). Lost there: FastStream's buffering ahead,
  the RAM budget, saving the parts already downloaded. A 200 exactly as long as the range is
  read on, as below: it may be the whole file or only the range.
- **A 206 without `Content-Range`** (a broken server or proxy) tells no length. A regular MP4's
  comes from its sample table; a fragmented file's only from the fragments parsed so far, so it
  ended after the first range (~9 s of 160). It is now read on, range by range, until a range
  comes back short; a file whose length is a multiple of 1 MB ends at the range after it, which
  comes back empty or 416 (`MP4Player.endsAt` drops the ranges made past it and ends the
  stream). An answer longer than the range is cut to it: since 2026-11-13 (a review) by
  `FetchLoader`, which reads such a 206 from the range's start up to the range's length and
  cancels the rest. A server that answered each range with the rest of the file had the whole
  rest read for every 1 MB range, held in RAM as one buffer and stored in the RAM budget before
  `MP4Player` cut the range out; that cut stays, as a safety net (`FetchLoader.test.mjs`).
  Firefox's own player refuses a 206 without `Content-Range`, so it is no way out there. Saving
  before the end is known counts as incomplete.
- **A length past 256 GiB goes to Firefox's own player** (2026-11-13, a review). `MP4Player`
  makes all of a file's 1 MB ranges at once as soon as it knows the length, and took any length
  it was told: a first answer with `Content-Range: bytes 0-999999/9007199254740991` made nine
  billion fragments and hung the player's page - and every add-on with it, as Firefox runs all
  add-ons' pages in one process. `RangeAnswers.MAX_FILE_LENGTH` is 2^38 bytes (256 GiB, 274,878
  ranges, about 40 MB and 30 ms of fragments, measured in Node). A `Content-Range` past it hands
  the source to Firefox's own player (`lengthFromAnswer`'s `tooLong`, with a message of its own),
  and so does a box before the moov that ends past it (read on without a length, mp4box reads
  next where that box says it ends); a sample table past it gives no length, and the file is
  read on range by range, as without one. `mp4FileLength.test.mjs`, `RangeAnswers.test.mjs`.

`mp4-without-ranges.e2e.mjs`: each kind of server, a small and a big file, a fragmented file
played a minute in, and one padded to whole ranges that must fire `ended` with no request past
the one after its end (without `endsAt`: 11 ranges past the end and no end, or 6 retries of the
416 and the load error).

## An MP4 paused, at its end, and played again

Found with the A/B benchmark below (its `--where` lists which place in the player's code asked
for each timer callback), on main and the branch alike:

- **The main loop woke the page while there was nothing to do.** `MP4Player.mainLoop` ran every
  50 ms while paused - in each MP4 player, and the seek preview is a second one that is always
  paused - and every 1 ms (4 in Firefox) once the video had ended: an ended video's `readyState`
  stays below 3 with nothing ahead, which counted as urgent. 41 timer callbacks a second paused,
  250 a second ended, for as long as the tab stayed open. Paused or ended it now runs every
  250 ms (`PAUSED_LOOP_MS`); a seek (the setter, and the element's `seeking`) and a `play` run
  its next round at once (`wakeLoop`), so nothing that matters waits: downloads go on by
  themselves (`onSuccess` runs `runLoad`), the stall watchdog does nothing while paused, the end
  of the stream, a duration to set or a range to retry can wait a quarter second. A round that
  seeks by itself (the start's seek to the buffered start) does not wake the loop a second time:
  `loopTimeout` is null while a round runs. Measured: 9.3 callbacks a second paused and ended
  (the two players at 4 a second and the client's one-second loop); a seek while paused landed
  62-109 ms after it was asked for.
- **Played again after its end, an MP4 never started.** `play()` on an ended element seeks it to
  0 by itself, past `MP4Player`'s `currentTime` setter - the only place that called `resetHLS`,
  which takes mp4box to the new place. mp4box went on from the end, the start had left the
  buffer (10 s of back buffer), and the video stood seeking at 0 for good: the play button after
  the end of any MP4 longer than about 40 s. Firefox's picture-in-picture seek controls seek the
  element the same way. `onElementSeeking` now checks a seek the element made itself as the
  setter checks its own (`reloadUnlessBuffered`); one made through the setter is recognised by
  where it took the element (`ownSeek`) and not checked twice. The mark is cleared only by a
  `seeked` after which the element no longer seeks (a later fix the same day): cleared on any
  `seeked`, two quick seeks, the first into what was buffered, reset the player twice - the
  first seek's `seeked`, queued before the second began, cleared the second's mark, whose
  `seeking` was then taken for one the element made itself, and the range the second had just
  asked for was aborted and asked for again (`mp4OwnSeek.test.mjs`). The stall
  watchdog's nudge is such a seek too: it lands in what is buffered, so nothing is reloaded.
  `ownSeek` is set only when the element started a seek (`video.seeking` right after the
  assignment): the client sets the start right after `setSource`, at readyState 0, where no seek
  runs and no `seeked` ever came - a video played to its end without a seek was then still stuck
  at the replay (an independent review found it; the first version of the test sought first).
- **An audio-only MP4's seek preview woke the page every 4 ms.** The preview plays no audio, so
  for a file without a picture it made no SourceBuffer, its element never left HAVE_NOTHING, and
  its loop waited for a first frame (`needsInit`) at 1 ms for the tab's life: 236 callbacks a
  second. Such a preview now stops once the metadata is in (`nothingToPreview`), and loads
  nothing: 6.7 a second.

`tests/e2e/specs/mp4-loop-pace.e2e.mjs`: wake-ups paused and ended under 20 a second (failed on
the old build at 41), a seek while paused lands, play after the end starts the video over
(failed on main and the old build: seeking at 0, readyState 1), also after a play-through
without a seek, and an audio-only MP4 under 20 a second (236 before).

## An MP4's audio tracks

- **Before:** MP4Player played audio track 0, always, and offered it as the only audio level. A
  film whose first track is Dolby AC-3/E-AC-3 (Firefox decodes neither) failed with "Failed to
  create SourceBuffers: Codec not supported" though an AAC track sat next to it, and a second
  language could not be chosen. HLS and DASH had their languages already.
- **Now** (`players/mp4/AudioTracks.mjs`): every track `MediaSource.isTypeSupported` takes is a
  level (`1:<index>`, 'und' as no language, the hdlr name as its label unless a muxer's default).
  The start track: the one LevelManager remembers for this video, else the preferred language's,
  else the one the file enables (tkhd flag 1), else the first; only playable ones. The language
  and audio menus then work as for HLS. A track Firefox cannot play is left out, not greyed.
- **The switch** (`switchAudioTrack`): the same audio SourceBuffer goes on - `resetHLS(true)`
  empties both SourceBuffers and mp4box, a queued `changeType()` follows when the codec differs
  (SourceBufferWrapper: it fires no updateend, so the next operation runs at once), then
  `startSegmentation({audioOnly: true})` appends only the new audio init segment and mp4box seeks
  to the keyframe before the playhead. Both tracks load again from there, from the RAM/disk
  cache, as after a seek. No second SourceBuffer: Firefox may refuse one once media is in.
- **Labels:** AudioLevel has a `label` (HLS: the rendition's NAME), shown first in the audio menu,
  so two tracks in one language (film and commentary) read differently.
- **Tests:** `AudioTracks.test.mjs`, `SourceBufferWrapper.test.mjs` (changeType in the queue);
  `mp4-files.e2e.mjs` plays an AC-3-first file from its AAC track and switches a two-language
  file mid-play, then seeks - both failed on main (the AC-3 file did not play through
  MP4Player; one audio level).
- **Not covered:** Firefox's own player (DIRECT: WebM, MKV, servers without ranges) plays the
  file's default track. `HTMLMediaElement.audioTracks` is behind the `media.track.enabled`
  preference in Firefox (MDN's compatibility data, 2026-11-11), which an extension cannot set.

## A file is what its bytes are, and Firefox's own player keeps the page's headers

A hoster served a Matroska file (H.264, AAC, SRT; written by mkvmerge) as `video/mp4`, from a
URL ending in `.mp4`, beside an MP4 of the same video on another link. Measured on the installed
extension with a local copy of that shape:

- **The page's own `<video>` played it, FastStream's player failed.** The type and the URL
  picked `ACCELERATED_MP4`, mp4box stopped at the first bytes ("Invalid data found while
  parsing box of type '£B' at position 0"), and the player showed the load error. Firefox's
  element reads a file by its bytes: served as `video/mp4`, `application/octet-stream` or
  `video/x-matroska`, it played the Matroska file every time. `MP4Player` now looks at the
  first range's first 8 bytes (`ContainerSniff.startsLikeMp4`: a box's size, then four
  printable characters) and hands a file that cannot be an MP4 to Firefox's own player
  (`playDirectly`), one range in. Every real MP4 and QuickTime file starts with a box, so none
  leaves MP4Player; HTML that happens to start like one fails in mp4box, as before.
- **Firefox's own player lost the page's headers after 5 s.** That server answered a request
  without the page's Referer with a 302 to a decoy. `DirectVideoPlayer` set its header rule
  once, and every rule lived 5 s (`RuleEntry`): the element's first request after that (the
  Matroska index at the file's end, read 12 s in, or a seek) went out with no Referer, to the
  decoy, and the client's recovery reloaded the source (the buffer fell from 39 s to 9 s). The
  element's rule now lives 60 s, the cap (`SET_HEADERS`' `lifetimeMs`), and is renewed every
  10 s while the player has the source: Firefox may hold a hidden tab's timers back, and a
  renewal up to 50 s late still comes in time (glm's review). A request's rule stays 5 s. After
  the player is gone the rule lasts at most 60 s, limited to the extension's own requests to
  that URL in that tab.

The background's 64 KB read of the file (`StreamLengths`) sees the same bytes and could pick
the player before MP4Player tries; not done yet: the hand-over costs one range.

`mislabelled-file.e2e.mjs`: a Matroska film served as `video/mp4` from an `.mp4` URL by a server
that sends a request without the page's Referer to a decoy, at 400 KB/s; the player plays it in
Firefox's own player, plays on after a seek 12 s in, and no request lacks the Referer. On main it
failed with the mp4box error; with the hand-over alone, the request 12 s in had no Referer.

The e2e web build (`wdio.conf.mjs`) serves the player with COOP/COEP: Firefox's own player there
loads only files whose server sends `Cross-Origin-Resource-Policy`, which every spec's server
does. The extension's player page is not cross-origin isolated: measure DIRECT there.

**A failure, and what the user sees (2026-10-28).** An MP4 file whose player reports an error that
neither the next source nor a rebuild (`recoverPlayer`, for a video that showed a picture) gets
past - and not a refused request (`isNetworkFailure`: a range or the first fragment that failed to
load), which Firefox's own player would send just the same while the page's new link may be on its
way (`renewSourceLink`) - is tried once in Firefox's own player inside FastStream, at the time it
was at (`playDirectly`, from the client's `ERROR` handler): it reads files mp4box cannot parse and
codecs MSE refuses. (A first version tried it only before the first picture; glm's review found
that test, by identifier, took a later episode at the same URL path for the one that had played.)
Only then the load error shows, and in a page it ends with how to watch the
video in the site's own player: "Turn FastStream off with its toolbar button..." (`player_error_turn_off`,
the DRM error's second sentence in every locale). FastStream does not step aside by itself: a
version that gave the page its player back when nothing had shown was built and dropped unmerged on
the owner's word ("if Faststream does that automatically, that is unwanted behavior"): the Off is
the user's to click.

## AAC in a channel layout of its own, on Windows

Reported on a film site (its hoster: one MP4 per quality, `[360p]url,...`
in a Playerjs page; the site itself is behind Cloudflare's challenge, the hoster is not): the
player buffered and never played. Measured on a film (one file on that hoster), all three qualities:
33 s buffered, `readyState` 1, 0 frames for minutes - and the same in Firefox's own player
(`PlayerModes.DIRECT`), so not FastStream's MSE path.

- **The cause.** Its sound is AAC LC with `channelConfiguration` 0 and a PCE (6.0, written by
  Lavc62.4.100: front pair and centre, a lone side channel, the back pair). Firefox on Windows
  decodes AAC with WMF (the utility process' `WMFDecoderModule`); MOZ_LOG
  `PlatformDecoderModule:5` showed it take 12,501 packets with "0 decoded data ... decoder has
  latency" and no error, and Firefox waits for the first audio before the first frame. Through
  WebCodecs (the same decoder): a PCE with the front centre after the front pair gives no output,
  as does one with a lone side channel (Windows has no speaker for it); stereo with a PCE, 5.1 by
  `channelConfiguration` 6, and 6.0 relabelled front centre first with the single at the back
  decode. The ffmpeg here (Lavc62.30, a 2026-04 build) and Ubuntu 24.04's (Lavc60.31) write 6.0
  front pair first: it fails too. CI's Windows ffmpeg (Lavc63.1, 2026-10) writes it centre first,
  as the relabel does, so there only the film-labelled e2e fixture exercises the fix.
- **The fix** (`players/mp4/AacLayout.mjs`, from `MP4Player.setupHLS`): the PCE in the esds box
  mp4box writes into the audio init segment is relabelled in place - the front centre first, a
  lone side channel to the back centre where there is none. A decoder finds each element of a
  packet by type and tag, so the packets stay as they are: each of the six channels WebCodecs
  gave back matched one of ffmpeg's decode of the original sample for sample (correlation 1.0).
  It runs on every platform: ffmpeg, which Firefox decodes AAC with on Linux, gives the same six
  channels from the relabelled config (correlation 1.0 each) and names its layout hexagonal, where
  the original's was unknown.
  The esds bytes are mp4box's copy: a save writes the file as downloaded. Firefox's own player
  (DIRECT) cannot be helped: there is no init segment to change. Not relabelled either: HLS and
  DASH, whose init segments hls.js and dash.js make (no such stream seen yet).
- **Tests:** `AacLayout.test.mjs` (the film's and that ffmpeg's configs, layouts left alone);
  `mp4-files.e2e.mjs` plays 160 s of 6.0 AAC as the machine's ffmpeg writes it and relabelled as
  the film had it - on main both sat at 0 with `readyState` 1 on Windows. Short files hide it: a
  20 s clip played, because its audio reached the end of the stream and Firefox went on without.
- **The same hoster's stereo files** (an episode, 499 MB) played clean for 12 minutes in the
  test Firefox: the whole file downloaded in about 50 s, seeks to 40:00 and back, 4x - no stall,
  no nudge, no rebuild, 4 dropped frames of 11,970 at 1x.

## Downloads between players, after seeks and errors

Firefox opens six connections to a host for all tabs together (per kind of window), and each
player page downloads on its own, up to six at once. Measured on a throttled local server at
4x the stream's rate (12 Mbit/s, a 3 Mbit/s stream, 4 s segments): a seek to 5:00 in HLS
played after 4.9 s alone and after 17-21 s with three paused background players loading
ahead; the watched one got about a third of the bandwidth, and its next fragment downloaded
side by side with the two after it (MP4: a 3 s stall right after the seek).

- **HLS downloads from the seek time** (`HLSPlayer.currentFragment`). The client downloads
  ahead from the player's current fragment; for HLS that was hls.js's `currentFrag`, the
  fragment that plays, which stays the old one after a seek until the first fragment at the new
  time plays. `seek-downloads.e2e.mjs`: after a seek to place 166 the server was asked for
  166, 4, 5, 6, 7, 167; now 166, 167, 168. The fragment comes from the time (at the very end or
  in a gap, the last one that starts before it), the level from hls.js.
- **Fetch Priority.** A playback library's request (priority 1000: `HLSLoader`, `DashLoader`,
  `MP4Player`) goes out `'high'` (Firefox 132); a download ahead `'auto'`, a yielding player's
  `'low'`. It reorders only the waiting requests and cannot change one already sent; the
  priority is asked at each attempt, so a retry of a download playback started waiting for goes
  out `'high'`. Same measurement: the fragment a seek needed reached the server 0.6 s after the
  seek instead of 7.5 s.
- **`PlayerPeers` and `DownloadManager.setYield`.** Players tell each other over a
  `BroadcastChannel` whether they are seen, play, and are short of video (under 10 s ahead, under
  20 s just after a seek: `BufferAhead`). A player the user cannot see steps aside while one the
  user watches is short: no downloads ahead, the queued ones dropped, running ones under half
  done cancelled (their fragments back to waiting), the rest `'low'`; when it is also paused
  (`holdPlayback`) even its own playback's requests wait. It reacts when the message comes - a
  hidden page's timers run up to 15 s late - and goes on 3 s after the last needy word; nobody
  short, everyone downloads to the end at full speed. A bug that made every player alone at
  first: `start()` announced while the player was still being built, reading its state threw, and
  the channel was taken for missing (`readState` now never throws).
- **The back-forward cache.** Firefox takes a page out of that cache when a message reaches a
  `BroadcastChannel` the page has open (`BroadcastChannel::MessageReceived`:
  `CheckCurrentGlobalCorrectness` fails for a window in the cache - `IsCurrentInnerWindow` is
  false there - and it calls `RemoveDocFromBFCache`), and the other players announce every
  second: Back loaded a page with a player again.
  `player-peers-bfcache.e2e.mjs` failed on the Windows runner in 4 of 4 attempts and passed
  locally (first taken there for proof that messages do not evict). A player leaves the channel on
  `pagehide` (with a goodbye) and joins again on `pageshow` when the page came from the cache;
  `pagehide` comes before the page is marked as cached, in the same task
  (`BrowsingContext::DeactivateDocuments`), so the goodbye does not take it out. `close()`
  lets go of the channel a task later (`CloseRunnable`, then `BroadcastChannelChild` has no
  channel to give messages to): a message already queued then can still take the page out. A
  few milliseconds against the whole time in the cache; Firefox offers a page no way to leave
  sooner.
- **The seek preview loads what the pointer is on (2026-10-09).** Pointing at the timeline
  downloads the segment there into the store the player plays from, so a click there plays at
  once: 0.56 s instead of 3.45 s on a 12 Mbit/s line (one segment per place pointed at; moving
  on drops the one under way). The HLS preview dropped the old place's segment by aborting its
  loaders behind hls.js's back, and hls.js resets after an abort only once its first segment
  has loaded (`handleFragLoadAborted` needs its transmuxer): pointing before that - a video
  that opens at its saved position, on a slow line - left the preview on its first segment
  until that finished (4.8 s in `seek-preview.e2e.mjs`, more than 10 s on a shared 12 Mbit/s
  line), loading nothing meanwhile. `HLSPlayer`'s preview seek now goes through
  `hls.stopLoad()`/`startLoad(time)`: the segment is asked for within milliseconds (37 ms; the
  old code 9.2 s with 8 s segments). A pointer still inside the segment that is loading leaves
  it loading: each move started it over. And the segment was downloaded twice: the client's
  level check (`checkLevelChange`, on the main loop) told the preview the level it was on, and
  `HLSPlayer.setCurrentVideoLevelID` set `hls.currentLevel`, which makes hls.js switch at once
  even to the same level - drop the segment loading and the buffer (traced: aborted 0.4 s in,
  downloaded again 9 s later). A level already loading or playing is now only pinned
  (`hls.loadLevel`); a real change still switches at once.
- **`PlayheadFirst`.** Under 10 s ahead a player runs at most two downloads, only within 30 s of
  the playhead, and cancels the cheap ones outside (`cancelIfCheap`); from 20 s on it
  downloads ahead in parallel as before. A seek does the same at once.
- **The half-done check held nothing, and is gone (2026-11-13).** A seek and a yield were to
  spare a running download at least half in. The check read the downloader's stats, which were
  null until FetchLoader's progress, and FetchLoader gives that once, after the whole body: every
  seek (arrow keys, frame step, a click on the timeline) and every yield to a watched player
  cancelled the running downloads ahead, nearly finished ones too. A review made the check work
  (the downloader took FetchLoader's stats as its request went out). The A/B of the finished
  branch then showed a seek to 80 s in an MP4 on a 12 Mbit/s line a second slower, 1557 -> 2547
  ms in 7 of 7 rounds, and on local files no change (348 -> 345 ms): the spared downloads,
  outside the new place's window, shared the line with the ones the seek waited for. With the
  check off, the same build seeks as main did: 2370 -> 1543 ms, 5 of 5 rounds, p 0.008. So the check went: a running download
  ahead is cancelled however far in, as it always was in practice, and its first half comes again
  only if the user goes back there. A later idea, measured first: spare one that would end within
  a fraction of a second at its own speed. `DownloadManager.test.mjs`.
- **Result**, same measurement, three background players: HLS 4.4 s (alone 3.9 s), MP4 3.4 s
  (alone 3.1 s), no stalls; the background players resumed about 13-20 s after the seek and
  buffered to the end.
- **How many at once while short (2026-10-22).** The two of `PlayheadFirst` held whatever the
  server, and most video hosts limit each connection: there one more download beside the next
  one does not slow it. And the speed test's round needs every downloader heard: with the third
  idle it never closed, so the test stood still while the player was short. Measured in the
  headless e2e Firefox on the web build, a local server capping each connection, a 15-minute
  720p video at 3.1 Mbit/s (HLS in 4 s segments, and MP4), 60 s per run: at 500 kB/s per
  connection six downloaders came at 37 s (HLS; upstream 47 s), two downloads running until the
  player was 20 s ahead; at 200 kB/s per connection (half the video's rate) the player never got
  10 s ahead and ran two downloads for the whole video, stalling - 94 s of video delivered in
  100 s, upstream (one downloader at the start, no `PlayheadFirst`) 141 s.
  `DownloadManager.urgentParallel()` now: every downloader while the speed test runs, and
  afterwards when each downloader the test added brought at least half its share of speed
  (`perConnection`, a server that limits each connection); two on a line the downloads share
  (one more added nothing or little), after a 429/503 until a probe finds more, and when the
  test could not tell. Every step must gain: a one-off jump (other players stepping aside in the
  middle of the test) does not count. Only a sample with exactly one downloader more than the
  last one's is judged (`lastSpeedCount`): one dropped for a failure in between made the next
  gain read as one more's share, and with a single one left that share was 0.5 / 0, so "they
  share the line" stuck for the rest of the video (glm's review, 2026-10-23; the unit test went
  from 6 downloaders run at once to 2 without the fix). The test decides after each sample, not two (with the
  rates of each connection jumping ±30% every second, three runs of each: six at 14 s instead of
  25 s, the same verdict). Same runs, after: six downloaders at 14 s (HLS) and 9 s (MP4) at
  500 kB/s per connection; seconds of video delivered after 10/30/60 s 30/171/388 instead of
  19/90/300 (HLS) and 40/189/410 instead of 20/111/334 (MP4); at 200 kB/s per connection 249 s
  in 100 s instead of 94. A line the downloads share (1.5 MB/s for all): the same throughput
  (it is the line), and `PlayheadFirst`'s seek measurement above again (three paused players
  loading, seek to 5:00): 2.69 and 2.68 s, before 2.70 and 2.70 s; two downloads at the seek,
  as before. A server answering 429 above three connections: two slow-downs in 60 s before and
  after, each halving, the Retry-After held, the probe after the calm period as before.
- **Not done: the first frame's fragments alone at the start (measured 2026-11-06).** While a
  video starts, an HLS player downloads nothing ahead (`HLSPlayer.currentFragment` follows
  hls.js's `currentFrag`, null until the first segment is appended): segment 0 alone, segment
  1 alone, then the downloads ahead. DASH downloads ahead from the start, beside its first
  segment. Tried: an HLS fallback to `hls.loadLevel` and the store's fragment at the playhead,
  and, until the playhead's fragments were in, no other download (then all at once, on their
  `FRAGMENT_UPDATE`). Same e2e Firefox and server as the MP4 entry above (150 ms to the first
  byte), 3 runs each: DASH's first frame 2087 -> 1546 ms on a shared 12 Mbit/s line, HLS's
  buffer at 8-12 s up to 8 s more - but on a server limiting each connection DASH had one
  segment less ahead at every point (4.5 -> 0.6 s at 4 s), fMP4 HLS on the shared line one
  less at 4 s and 16 s, and a resume (HLS) 1.1 s slower: the downloads started at the end of
  segment 0, before the remembered time was applied, and the resume's segment shared the line
  with three others. Holding back helps only where the downloads share a line, and the player
  cannot tell which kind of server it has before the speed test: left out (the owner: no
  regressions). The patch and runs: kept by the 2026-11-06 session, not in the repository.
- **While the video waits, on a line the downloads share: playback's request alone
  (2026-11-15).** Traced in the A/B benchmark (`stall-hls`, a 6 Mbit/s line, 100 ms to the first
  byte, 2 s segments of 525 kB): a seek's segment came in 1.6 s, sharing the line with the next
  one, where alone it takes 0.8 s. Two causes, both general:
  - `PlayheadFirst` runs two downloads while short, and nothing told the one playback waits for
    from the one after it. Now, while the element waits (seeking, or playing without data ahead,
    as `LoopPace` has it), once it has played (its `played` ranges), and the speed test is done
    and found a line the downloads share (`DownloadManager.sharesLine`), nothing downloads
    beside playback's own request (`playbackAsked`), and until it asks only the fragments the
    playhead is in. The element tells, not the store: at a segment's edge hls.js asked for the
    one before the playhead while the store held those after it, and counted them as video
    ahead. The start is left as it was (the entry above). A first version held back from the
    test's verdict on, also before the first frame: on the e2e's local server the test decides
    within the first burst, and `ram-budget.e2e`'s stream ("writes what does not fit to disk")
    then came in after its 2 MB budget held it and never finished, 3 of 3 runs (main 3 of 3
    passed). That spec leans on the burst: paused with the near window (KEEP_ON_DISK_WINDOW) over
    the budget, a player downloads nothing more until it plays on, by design.
  - A download that playback asked for and gave up kept playback's priority. hls.js and dash.js
    give up their segment at a seek; the download ahead that held the same segment then ran on
    at playback's priority, the seek's `cancelIfCheap` spared it, and it took the line from the
    new place's segment for 1.2 s. A watcher now keeps its own priority, and a download falls
    back to the highest of those left (`DownloadManager.letGo`); one that drops below playback's
    is cancelled with the other far ones while the player keeps to its window.
  - A/B, 5 rounds a build, main against the first version (held back from the test's verdict
    on): on the 6 Mbit/s line the HLS seek (median of 3) 2452 -> 1218 ms, on the same line with
    20 % of answers cut 2102 -> 1216 ms (p 0.008, 5 of 5 each); on a server capping each
    connection at 3 Mbit/s 1819 -> 1821 ms; on a 3 Mbit/s line falling to a quarter every other
    5 s, 150 ms to the first byte, 30 s played, 6795 -> 2004 ms (p 0.008, with the benchmark's
    jitter pattern starting at each run: see Buffering). Every other measure (MP4, HLS, DASH and
    idle start, playback, stalls) the same on all four. The final version, again: 2448 -> 1213 ms
    on the 6 Mbit/s line (every scenario run, all else the same) and 6168 -> 2020 ms on the
    falling 3 Mbit/s line (stalls, starts and the other seeks the same), p 0.008, 5 of 5 each.
  - DASH's seeks did not change: the benchmark's manifest has a Period every 9 s, and the store
    holds only the first Period's segments (DashLoader.loadFragmentInternal: a later Period's
    have no place there), so dash.js fetches those itself, at the default priority, not
    playback's. Since #702 (2026-11-16) they go at playback's priority (DashLoader's fallback,
    and the manifest with them): no longer cancelled by a seek's `cancelIfCheap` or by
    `setYield`, and counted by `playbackAsked`. The A/B was the same on three lines: the store
    holds nothing of a later Period, so nothing competed with them there. Still open: a later
    Period's segments in the store itself.
  - A seek in the first seconds, while the speed test still ran four downloads, took 3.1 s on the
    6 Mbit/s line. Since #704 (2026-11-16), while the test runs a seek (not a stall) is held as
    above, and the test is held meanwhile (`DownloadManager.holdTest`): idle downloaders read
    slower for 10 s (`SpeedTracker`), and a round taken then read as a line they share, which on
    a server limiting each connection would have meant two downloads for the rest of the video.
    Nothing measured while held counts; on release the round starts again and every downloader
    measures afresh. A/B, seek at 2 s: HLS 3140 -> 1217 ms, MP4 3556 -> 1606 ms (6 Mbit/s),
    3047 -> 1922 / 3512 -> 2696 ms with each connection capped at 3 Mbit/s, 2194 -> 1171 /
    2954 -> 1529 ms with 20 % of answers cut, MP4 6802 -> 3932 ms on a steady 3 Mbit/s line
    (p 0.008 / 0.029). Holding stalls too, as a first version did, gave 3 -> 5 HLS stalls on a
    3 Mbit/s line falling to a quarter every other 5 s: there the test lasts long and the video
    stalls often. Accepted trade-off (the owner, 2026-11-16): right after such a seek a hover
    preview ~40 s ahead can come later, as downloading ahead starts after the seek instead of
    during it (traced piece by piece): on a steady line it is still ready sooner counted from
    the seek, on the falling 3 Mbit/s line 6-10 s later.
  - Downloads ahead already running inside the new place's window were spared at a seek
    (`cancelFarDownloads` cancels only outside it): an MP4 seek from 45 s to 72 s on a steady
    3 Mbit/s line had the next fragment, started before the seek at priority 0, beside the seek's
    own for the whole wait (traced 0.3 s and 1.5 s after it), 4.5-4.7 s where a seek without it
    took 3.3-3.7 s. Since 2026-11-16 a seek held as above also cancels the running downloads ahead
    that do not hold the playhead (`PlayheadFirst.cancelBesidePlayhead`; playback's own and a
    save's are left, as by `cancelIfCheap`); the next fragment comes again from its first
    byte. A/B, 5 rounds twice, steady 3 Mbit/s: the MP4 seek 3643-3699 -> 2882-2913 ms in each of
    the 6 rounds where the next fragment ran beside it, the others (a start phase where it did
    not) the same; HLS and DASH the same there, and every measure the same on the 6 Mbit/s line,
    with 3 connections capped, with 20 % of answers cut, and on the 3 Mbit/s line falling to a
    quarter (preview, stalls and seeks). A first DASH +21 ms (p 0.032) did not repeat.
- **The download line counts the connections again (2026-10-22, the owner's wish):**
  "3C ↓9.6 Mbit/s 50%", as upstream showed until 2026-10-09, now with the speed in Mbit/s
  (`DownloadStatusText.mjs`). The count is the downloads running at that moment
  (`DownloadManager.runningCount`), not the downloaders there (upstream's): those are what the
  speed comes from - two while `PlayheadFirst` holds them, none while the player yields or has
  everything.
- **`recoverPlayer`.** An error after the source had shown something (a fatal hls.js error, the
  `<video>` element's `MediaError`, `MP4Player`'s stall watchdog) ended it for good, and only a
  tab reload - which downloaded everything again - played it again. Seeks were the usual
  trigger: Firefox can fail to decode what a seek appends late (bug 2069633), and only a new
  `MediaSource` plays again. The player is built again for the same source at the time it was
  at (not for a live stream), with its quality and audio track, keeping every downloaded
  fragment (`DownloadManager.keepStorageOnce`, apart from the save manager's `resetOverride`),
  resuming only if the user was playing; at most 3 times per source in 2 minutes, then the
  load error with its reason (`player-recovery.e2e.mjs`). Not for a network failure
  (`isNetworkFailure`: a new player asks the same server for the same fragment): the full web
  e2e run caught that, `mp4-loading.e2e.mjs`'s error came a minute late.
  - **Nothing of the start plays first (2026-10-12, a film site).** The new player started at 0:00
    at once (autoplay, and `recoverPlayer`'s own `play()` once `setSource` resolved), and its
    time came after the remembered-time lookup (two 600,000-round PBKDF2 hashes) and the init
    hook's next 1 s poll: the user saw the film start from the beginning, then jump back. A
    source with a time of its own (`faststream-timestamp`: a rebuild, `playDirectly`, a page's
    timestamp) now has it applied at `loadedmetadata`, before any frame, without waiting for the
    lookup (made afterwards), and nothing plays before (`startPending`, which the `canplay`
    autoplay checks too; `setSource(..., {play})` resumes after it). `player-recovery.e2e.mjs`
    notes every time a rebuilt player plays at: on main the MP4 one played at 0 before 101 s;
    the HLS one did not show it (hls.js loads nothing at 0), so there it only guards.
- **The load error names its reason** (`describePlayerError`): the client's handler read a
  second argument that nothing passes, so every failure said only "Failed to load video!".
  Now e.g. "Failed to load video! (manifestLoadError (HTTP 404))" (`failed-load.e2e.mjs`).
- **A segment that does not decode costs that segment (2026-10-09).** A DASH stream whose 4-6 s
  segment had garbage sample sizes failed at 3.64 s (Firefox decodes ahead): `recoverPlayer` built
  the player again three times in 1.5 s at the same place, then "Failed to load video!". Now the
  first decode error (`MEDIA_ERR_DECODE` on the element) builds it again at the same time - right
  for Firefox's late-append bug 2069633, where the segment is fine - and the same place failing
  again right after (within 1.5 s of video and 20 s of time, same source; the audio decoder's
  failure too: on Linux the broken HLS segment, both tracks in one, fails there first) builds it
  past that segment
  (`BrokenMedia.pastBrokenMedia`: the end of the segment that begins within 1 s, else of the one
  playing; whole seconds rounded up): it plays on from 6 s. Measured for DASH and HLS (fMP4):
  main ended both after three rebuilds (3.66 s, 3.9 s). For every player kind; not live.
  dash.js's own recovery skips a segment only when the SourceBuffer reports the error (it
  blacklists the segment appended last); a decode error on the element only resets its
  MediaSource, and the same segment failed again. Garbage inside a NAL unit Firefox decodes as
  garbage, without an error (measured). `dash-broken-segment.e2e.mjs`.
- **dash.js errors once the stream is up (2026-10-09).** Every one was dropped, and a stream
  stuck after one sat behind a spinner for ever. `DashErrors.stuckAfterStart` names those it stays
  stuck after (a download out of retries, an unusable manifest, no stream, a muxed track, a type
  MSE refuses, no usable key): DashPlayer reports them; the downloads count as network failures
  (`isNetworkFailure`, no rebuild); before the start too (a manifest that loads but has no usable
  stream waited for ever). Left to dash.js: a live refresh that did not parse or load (the next
  may), the clock sync, a subtitle. FastStream's own segment loader reports a dead segment itself
  (`DashLoader`, after three tries). The seek preview, with no client to rebuild it, gives dash.js's
  decode recovery 5 tries instead of a million.

**Invariants.** A save's downloads (priority -1) are never cancelled or held by a yield; a
player's own playback requests are never held unless it is paused and yielding. Yield is
re-evaluated on each peer message and on the client's tick, play, pause, seek and
visibilitychange. A scrub sends the same state at most every 250 ms.

## Players in several tabs take turns

The owner's question: with FastStream loading videos in several tabs, how does the tab he looks
at get its video first, and when do the others load - one after the other, or all at once?

**What it was.** A player in a background tab stepped aside only while a watched one was short
of video (under 10 s ahead: `PlayerPeers.shouldYield`, above). Past that every player downloaded
its whole video ahead at once, on up to six connections each. Measured with the benchmark below:
three players paused in background tabs and one playing in front, each video on a host of its
own, all on one 8 Mbit/s line, 90 s of video at 2.1 Mbit/s each. The one in front had its first
10 s as fast as alone, and then a quarter of the line: its whole video after 66 s, where 24 s is
what the line gives one player.

**On one host Firefox does it already.** The same run with all four videos on one host: the
player in front had its whole video after 29.5 s on main as well. Firefox gives the active tab's
requests its six connections to a host before the other tabs'; the background players' requests
waited in Firefox's queue. Tabs on different sites (different hosts) get nothing of that, and
those are what the turns are for; the benchmark and the e2e spec give each tab a host of its own
for that reason (`BENCH_TABS_HOSTS=same` puts them on one).

**The rule** (`network/PlayerTurns.mjs`, pure; `PlayerPeers.shouldWait`;
`DownloadManager.setWaiting`):

- A player the user can see never waits.
- One in a background tab waits while a player that goes before it still downloads and does not
  leave room. The order: visible ones, then one that plays unseen (music in a background tab),
  then the rest - the one seen last first (the tab just left is the likeliest to be come back
  to), and of those never seen the oldest. The order is total (rank, seen, born, id), so of the
  players that want the network the first never waits: no deadlock, and a fast-check property
  says so for any set of players.
- A player leaves room when its line is fast: it downloads at 4 times the rate its video plays
  at, or more (`JOIN_FACTOR`); the next one then downloads beside it, until the first is down to
  2 times (`LEAVE_FACTOR`: the gap keeps them from starting and stopping). A visible player asks
  twice as much before it shares (`SEEN_FACTOR`). So on a fast line all download at once, on a
  slow one in turns, with no setting and no site list: each player measures its own speed (the
  bytes it received over the last 5 s) and its video's rate (measured from what it downloaded,
  else the level's bitrate) and tells the others.
- A player whose server limits each connection (the speed test's verdict, `perConnection`)
  leaves room for players on other hosts: its speed is the server's, not the line's. On the same
  host they share Firefox's six connections and still take turns. Only the finished test's verdict counts
  (`DownloadManager.limitedPerConnection`): one gain early in the test set `perConnection`, a flat
  round after it took it back, and a background tab told in between started segments ahead on a
  slow line (tab-turns.e2e.mjs on CI, 2026-11-16: 6, 7 and 8 again and a new 9 in 3 ms; Codex
  found it, 2026-11-17).
- "Still downloads" (`wants`) ends when the player has its video, its RAM share is full, the
  user paused its downloads or set the speed limit to 0, it is offline or waits for a click, and
  when nothing arrived for 15 s though something should have (`STUCK_MS`: a dead server). A live
  stream never counts: it takes what its server makes. A save is never held back.
- Waiting is soft: the downloads already running finish, no new ones ahead start, new requests
  go out `'low'`, and what the player's own playback asks for goes as always. Nothing is
  cancelled, so a wait that ends a second later cost nothing. Stepping aside for a watched player
  that is short of video stays the hard rule (it cancels).
- A hidden page's timers run late, so a player decides when a peer's message arrives
  (`receive` calls `onChange` when its answer changed) and when one of its downloads finishes
  (`DownloadManager.onDownloaderFinished` tells the client), not only on its tick.

**Who counts as short of video** (`PlayerPeers.needy`) had four holes, each of which stopped
every background player for as long as the tab in front stayed as it was: a live stream (never
10 s ahead of its edge: now only while it buffers or has under 3 s), a looping clip shorter than
10 s and the last seconds of any video (all there is to have is ahead: `room`), and a video whose
server stopped answering (`isStuck`). `PlayerTurns.test.mjs` has each.

**Measured** (`node tools/bench-ab.mjs --scenarios tabs --rate 8`, 7 rounds, main against this):

| | main | turns |
|---|---:|---:|
| the player in front has its whole video | 66.1 s | 29.6 s |
| all four players have theirs | 109.1 s | 92.3 s |
| seconds ahead in front, 10 s in | 18.8 s | 19.1 s |
| first frame in front, from its first request for the video | 1.17 s | 1.08 s |

Each of the first, second and fourth in 7 rounds of 7 (p < 0.001). All four have their videos
sooner as well; why was not looked into.

That it is the turns, and nothing else on the branch: main against the branch as it was before
them, the same benchmark, 3 rounds: 64.0 s and 63.6 s in front, 109.9 s and 110.0 s for all four.
And on a fast line nothing changes, since everyone downloads at once there (`--rate 40`, 5
rounds): 6.5 s and 6.5 s in front, 18.3 s and 18.2 s for all four.

**The page's own start is not in these numbers, and cannot be compared in this benchmark.** A
new tab's "player modules ready" came in two speeds, about 0.25 s and 0.6 s, by the Firefox
session and the server a build was given, not by the build: main had 0.25 s in every round of the
7-round run and 0.6 s in every round of the 3-round run after it; the branch had 0.6 s in the
first and 0.28 s on the fast line, where main had 0.57 s; two copies of main gave 0.36 to 0.69 s.
Counted from the navigation, the first frame in front therefore read 0.27 s later for the branch
in the first run of this benchmark, 7 rounds of 7. It is counted from the page's first request
for its video now (`tabsFirstFrame`), the page's start is reported beside it
(`tabsModules`), and that measure's floor is 0.5 s, above the distance of the two speeds. What
makes the two speeds was not found (the page's modules come from the benchmark's own server, not
over the slow line).

Tests: `PlayerTurns.test.mjs` (the rule, its properties, the peers' side),
`DownloadManager.test.mjs` (a wait cancels nothing; `received`), and in a real Firefox
`tests/e2e/specs/tab-turns.e2e.mjs`: two tabs, two hosts, one 6 Mbit/s line; the background tab
asks for nothing while the one in front still has segments to ask for, and gets its video after.

**Sites that buffer at different speeds** (the owner's other question: one buffering system, or
one per site?). There is one already, and it adapts by measuring, not by site: every player
starts with three connections, tries six, and keeps what was faster (`DownloadManager`'s speed
test); a server that limits each connection is recognised and then gets all six; a server that
answers 429 or 503 is slowed down; under 10 s ahead the next seconds come first on two
connections (`PlayheadFirst`). What differs between sites is the server: its speed per
connection, how many it allows, how large its segments are, and whether the file can be asked
for in ranges at all. A list of sites with settings of their own would have to be kept up by
hand and is what the "no site-specific code" rule keeps out. What a measurement could still add
is remembering a host's verdict for the next video from it (it is measured again for each video
now, which costs the first seconds on three connections): a behaviour change, asked of the owner.

## Loading through the page

abyss.to's player (abyssplayer.com, embedded as an iframe) played in the page and never in
FastStream. The video's address (`https://player.abyssplayer.com/#mp4/<video>/<quality>`) is
answered only by the page's service worker, which reads the part after `#`. Anywhere else it is
the player's HTML ("Video not found"). FastStream's player loads from its extension page: no
service worker of the page, none of the page's cookies as they are now, and only approximations of
the page's Referer and Origin (header rules). Upstream closed the same report as not planned
(Andrews54757/FastStream#386).

What changed, for every site (no site's name in the code). FastStream's own player still plays.
Only where its bytes come from changes, and only after FastStream's own request was refused:

- **`page-fetch.js`** (content script, every frame): in Manifest V3 a content script's `fetch()`
  is the page's own request. Measured, Firefox 160: it goes through the page's service worker,
  carries the page's cookies, Referer and Origin, works cross-origin under the host permission,
  and is answered 206 for a range. It serves a port named `faststream-page-fetch`, only to this
  extension (the sender's id and extension URL are checked), and streams each answer back: head,
  pieces, done or error. Requests can be aborted one by one, and closing the port stops all of
  them. A request may name only `Range`, `Accept` and `If-Range`. A Response's URL drops the
  fragment; the head keeps the request's own address unless it was redirected. `content.fetch`
  (MV2 only) is not used, and the page's own functions are not touched.
- **`PageFetchRelay.mjs`** (background): the player in a page's iframe has **no `chrome.tabs`**
  (measured: undefined there). It opens `runtime.connect({name: 'faststream-page-fetch-relay:<frameId>'})`,
  and the background joins it to `tabs.connect` into that frame of the sender's own tab, never
  another tab. Either side closing closes both. A player whose port broke (an event page that
  went idle, a page that navigated) connects again at its next request. The same holds for
  opening a web page (2026-11-13): `EnvUtils.openExternalURL` called `chrome.tabs`, so in a
  framed player the subtitle search's "open it on OpenSubtitles", the error dialog's "send
  report" and the settings page's report and update buttons (the settings page is an iframe in
  the player, without `chrome.tabs` too) did nothing. Without `chrome.tabs` it asks the
  background (`OPEN_EXTERNAL_URL`), as the VPN button does. Only FastStream's own pages may send
  it (`MessageSenders`); the background opens only for the player page and the settings page
  (matched by their exact address, not by its start) and only an http or https address
  (`tabs.create` also opens the extension's own pages), and it creates the tab with no opener,
  as the player's own call does, so the popup guard leaves it alone. The settings page's two
  buttons go through `openExternalURL` since then (the report button used `window.open`, the
  update banner `chrome.tabs.create`). `backgroundRobustness.test.mjs`, `EnvUtils.test.mjs`.
- **`PageFetch.mjs`** (player): the channel and the routes. `FastStreamClient.setSourceInternal`
  points it at the frame the source came from (`VideoSource.pageFrameId`, else the player's page
  from `acceptPlayer`'s `tabId`/`pageFrameId`). A player that is its tab's page itself gets none:
  it also lists other tabs' streams. **A port message's `Uint8Array` is another realm's**
  (measured: `[object Uint8Array]`, `instanceof Uint8Array` false), and a first version dropped
  every piece: the body was empty, and mp4box never found the movie. Pieces are taken by
  `ArrayBuffer.isView` and copied into the player's own realm.
- **`FetchLoader`**, the one loader of HLS (playlists and fragments), DASH, MP4 and saving, tries
  a request once more through the page when FastStream's own is refused: 401, 403, 404, 410, or
  a web page where media was asked for (`isRefusal`). The page's answer is taken when it is 2xx
  and no web page, for a playlist too: a site's "not found" page or an app's fallback page in
  place of a refused playlist would hide the 403 that the link's renewal (FreshLink) waits for.
  A host whose **media** the page could load goes through the page from then on (by origin; a
  playlist alone proves less). Routes start empty for each source (another episode's links may
  load directly), and a routed host goes direct again as soon as the page fails it: page gone,
  network error, refusal, or a web page where media was asked for. A refusal then goes on to
  the link's renewal as before. With no page (a player on its own tab, the web build), nothing
  changes. A server error, 429, 416 or a playlist answered as `text/html` is no refusal.
  (glm's review found the route-on-playlist, the routes kept across sources, and the head
  timeout that did not tell the page to stop.) A download that fails both ways keeps both
  causes (`stats.error.page`), and a range's error names them:
  `Range 2 failed to load (HTTP 403; through the page: The page did not answer)` (#732).
- **abyss.to's addresses** are `abysscdn.com/#mp4/r2/1/<size>/<size>/<quality>/h264?maxChunkSize=5242880`
  since about 2026-11-17. Measured then: 403 direct, 206 for each 1 MB range through the page.
- **#732 on the reporter's page (2026-11-17, 1.3.82.198).** Its "Voir 2" is abyss:
  - It plays, every range 206 through the page, also with the reporter's options (144p, 11 s
    ahead, download-all off).
  - Some videos have `#mp4/chunk/<n>/<size>/2097152/<quality>/h264` instead of `r2`: the file
    is in 2 MB pieces on the CDN. The page's service worker (`sw.import.v3.js`) answers both kinds
    from 5 MB ranges of the CDN.
  - A 416 asked directly for such an address is the site's own page refusing a range (the
    fragment never reaches a server), not the video.

  Its "Voir 1" is another hoster, HLS with segments named `seg_*.woff`:
  - Its CDN answers segment 0, asked for with no Range, with `206 bytes 0-4095/<size>`, to the
    page as well, and asked for the rest it sends those 4 KB again.
  - hls.js took the 4 KB as the segment, found no audio in it, made no audio SourceBuffer, and
    the next segment failed (`bufferAppendError` on the audio buffer).
  - The site's own player fails there too.
  - A FetchLoader change that asked for the rest of a short answer was built and dropped (the
    owner, 2026-11-17): from this CDN it only changed the error.
- **Detection** needed nothing new. Firefox tells add-ons nothing of an answer a service worker
  gives (webRequest fires `onBeforeRequest` only, Mozilla bugs 1626831 and 1817450), but
  content.js reports the file a page's `<video>` got (`loadedmetadata`, `LOADED_MEDIA` live) by
  its `currentSrc`, fragment and all, and the background takes it in as an MP4. A watch of
  unanswered media requests that asked the page about them (PageMedia) was built and dropped:
  the e2e found the video by the report first, every time.
- **`VideoSource.identifier`** (`URLUtils.mediaIdentifier`) keeps a fragment that is a path
  (`#mp4/<video>/<quality>`). On abyss every video has the same address, and without it each one
  resumed at the last one's time (measured in the e2e: the second video started at 122 s). Every
  other fragment is dropped as before (`#t=30`, `#hls`, `#.mp4`, `#autoplay`, `#/route`): the
  request for a file has no fragment and the page's element may have one, and the two must give
  the same identifier, or the remembered time and the buffer hand-over miss (glm's review; a
  first version kept every fragment but media fragments).

Saving uses the same loader (FetchLoader, through StandardDownloader), so it takes the same way
through the page (the owner's choice: saving allowed everywhere). Measured end to end since
2026-11-13 (`page-fetch.e2e.mjs`): a service-worker video and a current-cookie video, saved through
the Save button and the name prompt, are the film byte for byte (SHA-256), their far end asked
for through the page; a save cancelled at about a quarter says "Save cancelled!" with no
"failed, save what there is?" question, leaves no file, and the next save is whole. Two things
the first version of those tests ran into: a player takes over what the previous player of the
same video loaded (the save then asked for nothing, so each save test has a video of its own),
and Firefox's cache answered ranges an earlier test had loaded (the film is sent `no-store`).

Limits, known:

- **DIRECT** (Firefox's own `<video>` in FastStream's page: WebM and other files MSE can't take)
  loads by itself. A service-worker-only WebM does not play.
- **DRM** stays in the page's player (see "A copy-protected video stays in the page's player").
- **MPV mode** cannot hand mpv what only the page loads: mpv asks the server itself, got
  "Video not found", and its window opened and closed at once (his report, 2026-11-12). Since
  then the length's read (`StreamLengths`, which runs when a stream is detected) notes a file
  (MP4 or DIRECT) whose first answer is a 2xx `text/html` (`servesWebPage`; never a playlist or
  a manifest, which some servers send as `text/html`). `openInMpv` waits for that answer (up to
  `HlsQualitiesWaitMs`, alongside its other reads) and refuses such a file (`pageOnly`). The
  allowlist's MPV, the MPV key's play and the toolbar's MPV then put the tab over to
  FastStream's own player, as the toolbar's MPV -> On does (`MpvMode.playHereInstead`: On, not
  the user's Off), and that player says why (`tab.playerNotice`, a message key sent once with
  the sources; the player shows only keys it knows, as the page's iframe messager brings
  SOURCES too). On that page the On stands in for MPV (`tab.mpvStandInPage`): the toolbar
  cycle's next click is MPV -> Off (as On -> MPV it reloaded the page, was refused again and
  came back On, and Off was never reached: glm's review). The player's mpv button gets the
  reason as its answer. Passing the page's
  bytes on to mpv would need a local server in the helper (a new host version installed by
  hand, and a port on the PC): the owner chose this instead.
- **A stream built in the page's memory** (`blob:` from MediaSource) has no request to repeat.
  Its manifest or file, when FastStream finds that, plays instead.

Tests: `PageFetch.test.mjs` (channel and routes, another realm's pieces),
`PageFetchRelay.test.mjs`, `pageFetchScript.test.mjs` (the content script in a vm: senders,
headers, streaming, abort, the fragment), `backgroundPageFetch.test.mjs`, the "FetchLoader through
the page" block of `FetchLoader.test.mjs`, `URLUtils.mediaIdentifier`, and
`ext-specs/page-fetch.e2e.mjs` on the installed extension: a video only the page's service worker
serves (its id in the fragment, "Video not found" to anyone else), a video only the page's current
session cookie opens (renewed by its first answer), and a second worker video at the same address
in a cross-origin iframe, which starts from 0 and loads through that frame. Each plays, and the
first two seek to 120 s. Then the saves above: the worker's video and the cookie's video whole,
and a cancelled save followed by a whole one.

## Firefox VPN

Reported on a VOE page: "Failed to load video!" in the player and "could not open the stream"
in mpv, while the site's own player played. The cause was Firefox VPN (Firefox's built-in
"IP protection", 149+), not FastStream's downloads: with the VPN off, the same build played.

- **What Firefox does.** Its channel filter proxies a request only when the loading
  principal is http(s) (or a null principal): `IPPExceptionsManager.getPrincipalRule`
  returns EXCLUDED for every other scheme, moz-extension:// among them (Firefox 157,
  `toolkit/components/ipprotection`). So the page reaches the CDN through the VPN, and
  FastStream's player and background reach it from the user's own address.
- **Why the site refuses.** VOE ties the stream URL to the address that asked for the page:
  `…&i=63.245&asn=54113` with the VPN (Fastly's network), `i=95.91&asn=3209` without. The
  mpv host's debug log showed the VPN-bound URL handed to mpv, which asks from the user's
  address too.
- **The fix** (`chrome/background/VpnProxyMirror.mjs`): FastStream's own requests to a host go
  the way the page's latest request to it went. Measured in Firefox 157: webRequest's
  `details.proxyInfo` reports type, host, port, `proxyAuthorizationHeader` and
  `connectionIsolationKey` (not `masqueTemplate`), and `proxy.onRequest` applies to an
  extension's own requests. The VPN's servers are CONNECT proxies over TLS (Remote Settings'
  `vpn-serverlist` names no other protocol), so the copy is exact; a MASQUE proxy would not be
  copied. Firefox gives every proxied channel one `proxyInfo` (one token, one isolation key),
  so the newest seen on any page request is the one to use.
- **The tab's proxy is guessed only for Firefox VPN's** (a `proxyAuthorizationHeader` on
  every request; 2026-10-21). A host the page was not seen asking goes the way the tab's
  page went (`noteOwnRequest`); a proxy of the network settings or a PAC file applies to an
  extension's own requests by itself, chosen per host, and with a PAC file that sends the
  page through a proxy and an intranet CDN directly, FastStream's request to the CDN was
  forced through the page's proxy, which could not reach it. A host the page itself reached
  through a proxy is still copied, token or not: for that host a PAC file answers alike, and
  `firefox-vpn.e2e.mjs`'s VPN stand-in is a plain http proxy (Firefox sends the token only to
  an https one). The first version of this fix dropped every proxy without a token, and that
  spec failed. `tests/unit/VpnProxyMirror.test.mjs` fails without it.
- **Only where needed.** Hosts are added when FastStream fetches them (a detected source, its
  own request in a tab whose page went through the VPN), at most 200; the listener asks for
  those hosts only. A host goes off the list once its tab's page, loaded again, reaches it
  directly (the VPN off, or off for the site); a content script's fetch, which always goes
  direct, does not count, nor does another tab.
- **The permission.** `proxy` is optional. A player in a page has no `chrome.permissions`
  (undefined there, measured), so its "Play through Firefox VPN" button opens
  `perms.html#proxy`; once granted, the page closes itself and the background sends
  `VPN_ALLOWED` to the tabs, and the player loads the source again.
- **Limits.** The mirror lives in the background's memory. An open player keeps the event
  page running (measured 2026-09-28), but a background that is terminated or crashes while a
  video plays starts with nothing, and the player's requests go direct until the page asks
  again. A plain http proxy gets no `Proxy-Authorization` from Firefox (only https proxies
  do, measured), which is why the e2e stand-in has no token.
- **mpv** cannot use Firefox VPN at all: it runs outside Firefox (confirmed by the user on
  1.3.82.67). So a stream whose page request went through the VPN - a proxy with a bearer
  token, as IPProtection's `pass.asBearerToken()` makes it - is not handed off
  (`openInMpv` in background.mjs, every hand-off path); the toolbar's "!" and the player's
  status line say to turn the VPN off for the site. Which hosts count follows the tab's
  private-window flag (the VPN can be on for private windows only). A proxy without a token
  (one set in Firefox's network settings) does not block mpv.
- **Tests.** `tests/unit/VpnProxyMirror.test.mjs`; `tests/e2e/ext-specs/firefox-vpn.e2e.mjs`
  (a helper add-on plays the VPN: page requests only, through a local proxy, to a host no DNS
  answers). With `proxyFor` disabled, its two playback tests fail.

## A copy-protected video stays in the page's player

Found while testing upstream #456 (saving from vimeo.com/863362136 looped a part, 1.3.70): that
video is copy-protected now. FastStream took it over, its player loaded the manifest and sat at
readyState 0 behind "This video is copy-protected (DRM)…", where Vimeo's own player plays it.

- **What Vimeo sends** (Firefox 159, measured): a master playlist with no key at all, and
  variant and audio playlists with two keys each, both `METHOD=SAMPLE-AES-CTR`: Widevine
  (`KEYFORMAT="urn:uuid:edef8ba9-…"`, the PSSH as a `data:` URI) and PlayReady. The URL names
  `/drm/cenc,derivedv2,…/`, which the rule does not go by.
- **Where it is told.** The background already reads a stream's master and its first variant
  for the length (StreamLengths, `MAX_PLAYLIST_READS = 2`), so the variant's keys come with no
  request of their own. `StreamLength.hlsProtected` keeps the keys in force as hls.js does (one
  per KEYFORMAT until `METHOD=NONE`), and a segment plays when the identity key is one FastStream
  decrypts (`Decryptable.mjs`: AES-128, AES-256), which is the rule
  `HLSFragmentRequester.takeOverDecryption` goes by too: `HLSEncryptedPlaylists.test.mjs` runs
  both on the same playlists through hls.js's parser. One deliberate difference: a key format
  hls.js does not know, which it drops and plays as clear (still encrypted, it shows nothing).
  `EXT-X-SESSION-KEY` decides nothing: it may name a key no variant uses. DASH:
  `StreamLength.dashProtected`, every video adaptation set under ContentProtection (a clear one
  beside them plays).
- **What changes.** `hasVideoSource` (every in-page open: auto-enable, the toolbar's On, a
  stream found while on) opens no player when the stream the player would play is protected:
  that one, as main.mjs picks (the longest, `StreamPick.pick`), not any protected one, or a
  film's clear ad won the pick. It now waits for DASH manifests' reads too, as for HLS. The
  toolbar button shows "DRM" and why (`tab.protectedVideo`, cleared on a new page and at Off).
  `openInMpv` refuses a protected stream as it refuses a Firefox VPN one ("!" and the reason in
  the tooltip), after waiting for an unread manifest (`HlsQualitiesWaitMs`); the allowlist's MPV
  then sends the page's next stream neither (an ad's, or a piece of the film); since 2026-11-13
  the toolbar's MPV and a start by address neither (mpv.md, "One latch for every automatic
  hand-off"). A read sets the mark either way, and none for a URL forgotten while it was read
  (`noteProtection`).
- **Left as it was.** A stream the background could not tell (its variant's read failed, a key
  that comes later in a live playlist) still opens the player, which says DRM on hls.js's or
  dash.js's word (NEED_KEY), as before.
- **Live, 2026-10-28:** player.vimeo.com/video/863362136 kept Vimeo's player, badge "DRM";
  vimeo.com/22439234 (clear) was still taken over and played.

## Background: reasons behind the code

- **`LocalAddress.mjs`** - Local is told by the host alone, with no DNS lookup (that needs the
  `dns` permission), so a public name that resolves to a local address (`192.168.1.1.nip.io`)
  counts as public. 100.64/10 (carrier-grade NAT, Tailscale) counts as local.
- **`ManifestTypes.mjs`** - Many servers name a manifest only by its Content-Type, with no
  extension in the URL. Only manifest types are listed: a segment's type (`video/mp4`,
  `video/mp2t`) taken for the stream opens the player on a few seconds of it.
  `modeFromMediaType` returns null for audio (a notification sound, a podcast MP3) and for an
  HTML page (a hoster's "link expired" answer), which are no video.
- **`DownloadFilename.mjs`** - Firefox rejects a `downloads.download()` call whose filename
  holds a character it refuses (the colon in `clip@00:05.png`), and the user then sees nothing
  happen; every measured refusal is mapped to a close safe name.
- **`KeyShortcut.keyName`** - The typed character decides, as in Firefox's own key matching
  (the key labelled Z on a German layout is "Z"); when it is no Latin letter or digit
  (Shift+1's "!", a Cyrillic letter), the key's position stands in, as Firefox falls back to
  the Latin character.
- **`FreshLink.mjs`** - Firefox, on Back, gives a page's frame its old document from its cache
  without asking the server, however stale (measured, Firefox 158), and so the signed stream
  link it had; a page left for hours plays on until that link runs out. A hoster's every page
  load issues a new link for the same video (same host and path, new signature and issue time),
  so the page is fetched anew (`cache: 'no-store'`, with its site's cookies) and the link that
  kept most of the refused one's parameters is taken.
- **`StreamDetection.classifyResponse`** - A CORS preflight (OPTIONS, which Firefox shows
  add-ons) or a HEAD is never taken for the stream: its headers lack the page's own (a token),
  and the server refused the player. An HTML page is never a stream, whatever its address or
  query names (an embed page, a hoster's "expired" answer at `.../clip.mp4`). A stream named in
  a query counts only for a player's fetch or a page load: tracking pixels, scripts and beacons
  name the media they report on in their query.
- **`StreamDetection.isRedirect`** - A redirect is no stream, though its address may name one:
  taken for the stream, each request of the player went through the redirect without the page's
  Referer (refused by a CDN that checks it), and a link that ran out opened a player on the
  hoster's "expired" page.
- **`NetRequestRuleManager.addHeaderRule`** - `urlFilter` has no escape character: a `\` is a
  literal character to match (Firefox's CompiledUrlFilter), so escaping a `*` made the rule
  demand a backslash no URL has (an Akamai `acl=/*` token got no Referer). The URL goes in
  unescaped: a `*`, `^` or `|` from it can only widen the match, and the rule is held to one
  tab and a few seconds. A `|` at the very end would anchor the end, so a `*` follows it. Rules
  whose removal failed three times are removed again in the same call that adds a new one, as
  the browser may still hold their ids.
- **`TabTracker.trimTracked`** - A page that is never left grew its frame's source and subtitle
  lists without end: an HLS or DASH player's pieces are detected one by one, thousands in an
  evening, and each went to every player tab. A list keeps at most `SameShapeLimit` files of
  one shape (the first stays, so the shape is still known as a stream's pieces) and
  `TrackedLimit` in all, files going before manifests.
- **`TabHolder.requestHeaders`** - Kept per tab and not cleared by `reset()`: a request (a
  preload, 103 Early Hints) can be sent before its page named itself or before the reset on a
  new site, and answered after; a stream found without the Referer its CDN checks got a 403 in
  the player.
- **`TabHolder.noteHandedToPlayer`** - `sendSources` takes what it hands a player out of the
  frames, so a player loading again in its frame ("Reload Frame") asked again and got nothing;
  what it was handed is kept for that.
- **`TabHolder.forgetRemovedFrame`** - A page's FRAME_REMOVED can arrive after the next page in
  that frame named itself (the two race across a navigation). A known name that is not the
  frame's is that late message, and must not forget the new page's frame and streams.
- **`background.mjs` popup guard** (`PopupGuardArmMs`, `PopupGuardChainMs`, `tabs.onCreated`) -
  Ad scripts open a popup or popunder from the top window's `blur` that a click into a player
  iframe causes; a tab opened within 700 ms of such a click is closed, and the guard re-arms
  for 400 ms after a close, as one click often chains two or three tabs. The windows are short
  because a deliberate new tab within them is closed too, and on a cold event page a
  `window.open()` in the same blur can come before the arm message.
- **`background.mjs` `isTablessRequest`** - Requests of no tab (a service worker's, the
  background's own length reads) are not tracked: no tab event ever reset the holder of tab -1,
  which collected every such stream for the session and sent the growing list, with the
  requests' headers, to every player tab, private windows and containers included.
- **`background.mjs` `recoverFrameSources`** - A page's report of what it loaded is the page's
  to write: an internet page that named a local-network address in it had the length read and
  mpv ask that address, blind requests outside Firefox's own checks. A page on the local
  network still plays from it.
- **`background.mjs` `takeScrapedCaptions`** - content.js reads at most 64 MB of `<track>` text
  at a time but asks again for each new stream, so a page naming new track files each time had
  them all kept and copied to its players without end; past `ScrapedCaptionsKeptMax` the oldest
  readings go, the current answer's last.
- **`background.mjs` DOWNLOAD in a container** - The save tab opens in the playing tab's
  window: Firefox refuses a private tab's cookie store in a normal window (and a container's in
  a private one), and the save was answered null when the user had switched windows. Its player
  may never load or answer, so a timeout answers the caller; the download info is taken at
  once, as that timeout can end it while the player saves.
- **`background.mjs` `saveOption`** - An option the background changes itself (mpv's autoplay
  switch) is announced with UPDATE_OPTIONS, which an open options page hears; LOAD_OPTIONS
  reached only the background, and the page went on showing the old value and wrote it back at
  its next save.
- **`background.mjs` `noteProblem`** - Not for a private window's tab: the problem list is kept
  on disk and shown on the options page, so a private window's sites stayed listed there for
  good.

## The background's questions to a frame have a time limit

A content script shares its page's event loop, so a page that never lets go of it never answers
`tabs.sendMessage`. Every question the background asks a frame goes through `askFrame`, which
answers `undefined` (as a frame without a content script does) after `FrameAnswerWaitMs`
(3 s). glm's review of 2026-11-16 found three that still waited with no limit, each holding a
player for good:

- `isPlayerParentProven`'s IS_PLAYER_OPENER: the player's PLAYER_LOADED was never answered, and
  the player never started. No answer is now no proof: no page's player, as when the page says no.
- `linkToParentFrame` (FRAME_LINK_RECEIVER, then FRAME_LINK_SENDER), awaited by `getPageFrame`
  in `acceptPlayer`: the same, for a page that is the player's parent. It now resolves after
  `FrameAnswerWaitMs`, and the introduction still goes on when the parent answers later.
- `cascadedFullscreen`: the player's fullscreen, windowed fullscreen and miniplayer requests.
  The first question waits `3 * FrameAnswerWaitMs`, because content.js answers a fullscreen
  request only once Firefox has entered it (`requestFullscreen`'s promise), after the
  transition. The windowed-fullscreen steps of the frames in between wait the usual time.

`backgroundJammedFrame.test.mjs` jams each one (an answer that never settles). All three
tests fail without the limits.

The same review's look at `content.js`:

- **Leaving windowed fullscreen keeps what the page wrote meanwhile.** Each element that holds
  the player gets its whole style attribute back (`undoFillScreenIframe`). A page whose
  framework drew such an element again while the player filled the screen lost that change.
  Now the old attribute goes back whole only when the attribute is still exactly what the fill
  set (`filled`). Otherwise it goes back property by property: what the fill set returns to
  what was there before, and what the page wrote stays. Test: `contentScript.test.mjs`, "keeps
  what the page wrote to it meanwhile".
- Not changed: the frame-link key posted with `'*'` reaches only the parent window, which owns
  the iframe anyway, so it can take nothing from it. A Shift-only shortcut cannot exist (Firefox
  asks for Ctrl or Alt), so `couldBeExtensionShortcut` has nothing to add.

## The background analyses and hostile subtitle files

What the review of 2026-11-16 left open. Each fix has a test that fails without it.

- **The analyses share one module**, `modules/analyzer/BackgroundAnalysis.mjs`: the status
  values, the start of the background player (`startBackgroundPlayer`: only the latest start
  keeps its player, an end before the load returned is no "running" player), the end rule and
  the error handling. Before, both analyzers had their own copy of the start, and the audio
  analyzer's lacked the end-while-loading guard the frame extractor got on 2026-10-13.
- **An analysis player's error ends its analysis as failed** (`failOnError`). The preview player
  had an ERROR handler; the analysis players had none, and an error (a link that expired, a
  manifest that failed) left the analysis "running" with a dead player. A start needs it idle,
  so that video's volume strip or seek previews never came. Tests: `backgroundAnalyzers.test.mjs`,
  "ends the analysis as failed on an error before its metadata ..." and "keeps no player that
  failed while it loaded", for both analyzers. An analysis player is destroyed once
  (`destroyPlayer`, which `failOnError`'s DESTROYED listener feeds): an error, a stop and a stale
  start can each reach the same player, and HLSPlayer's second `destroy()` hands `destroyVideo` a
  null video. An error after the player was destroyed ends nothing more (Claude's review of #715).
- **A short video is analysed to its end** (`coversVideo`): an analysis is done at all but the
  last 5 s, or the last tenth for a video under 50 s. With the 5 s alone, a video of 5 s or less
  was done at its first frame, and its strip stayed empty. A long video ends as before.
- **vtt.js decodes a cue's texts in one parse** (`unescapeAll`): a parse per text with an `&` let
  a cue of many short texts (`&a<i></i>` x 5000) parse a document for every one. Checked in
  Firefox against the old way, text by text, by `modules.e2e.mjs`. And a cue's region is found
  in a Map, not by a scan of every region: 40,000 regions and cues took 4.9 s, now 0.4 s
  (`vtt.test.mjs`, which compares the same file without region names on the same machine:
  a fixed 1.5 s limit failed on a slow CI runner, 2026-11-17). The unused `TEXTAREA_ELEMENT` is gone. All in `tools/verify-vtt.mjs`'s list
  and `docs/vendored-libraries.md`'s table, which had missed the DOMParser change.
- **Facebook: one manifest per scan stays.** glm read it as losing a second new video found in
  the same scan. On the page as recorded (live, 2026-11-15) the reels Facebook preloads sit under
  `viewer.lasso_blue_feed`, outside any `video` key, so they are never candidates; the one on
  screen is the one reported, which `customSiteScripts.test.mjs` pins. Reporting more would put
  preloaded videos into the sources. No page with two `video`-path manifests in one scan is
  known; if one turns up, the test gets that page's shape first.
- **The maintenance scan of the same day** found little else to remove. All 445 locale strings
  are used (the ones built at run time, `prefix + '_' + value`, checked against the enums they are
  built from; `options_general_vischangeaction_miniplayer` is live: only the web build drops that
  value). Every skipped unit test is a platform one that CI runs on the other OS. No test helper
  is unused. Every path the docs name exists or is written as history. One dead CSS rule went:
  fluidplayer's `.pseudo_fullscreen`, which nothing ever set (`vtt.test.mjs`'s #292 test tries
  every class the player has instead). Left as they are: 58 exports used only in their own file
  (removing `export` gains nothing).
- **The privacy policy against the code (same day).** Checking `docs/privacy-policy.md` line by
  line found one request it said never happens: dash.js's `initialize` adds its own time server,
  `https://time.akamai.com/?iso&ms`, after the `UTCTiming` sources of a live manifest, and asks it
  with its own `XMLHttpRequest` (not through DashLoader) when the manifest names none or none of
  them answers; the
  extension's CSP has no `connect-src`, so the request went out. `DashPlayer.setSource` now calls
  `clearDefaultUTCTimingSources()` after `initialize` (nothing in dash.js adds it again: only the
  first `initialize` does, and `reset` empties the list). Such a stream's clock then comes from the
  `Date` header dash.js recorded from the manifest's own response
  (`useManifestDateHeaderTimeSource`, no extra request), or the computer's. A manifest's own
  sources are still asked first. `dashTimeSource.test.mjs` runs the installed dash.js's
  MediaPlayer and fails without the call. The policy also lacked the optional `proxy` permission
  (VpnProxyMirror), the options page's problem list (host and path in `storage.local`), the two
  report buttons (a prefilled GitHub issue the user submits), and the same-site rule for a page
  request's cookies (`sourceHeadersFor`); all are in it now.

## A page loaded again keeps FastStream's player

The owner's report: FastStream is on, the page is loaded again, and sometimes the site's own
player stays - and playing it does not bring FastStream back.

**Cause.** The background opens the player about half a second after the page's first stream
request (`replaceDelay`). content.js then looks for the page's largest visible video and answers
`'no_video'` when there is none: a page whose own player is still starting has no video on the
screen yet, and neither has one whose video is below what the window shows. Which of the two a
reload makes more likely than a first load was not measured on a real site; both are covered.
Nothing tried again. Every later request was for a stream the background knew
already (`onSourceRecieved` returns for a known URL), and a play the user starts was heard only
in MPV mode.

**Now** (`background.mjs`: `noteOpenMissed`, `reopenMissed`, `reopenOnUserPlay`):

- An open that ended with no player (`'no_video'`, `'error'`) is tried again by itself 1, 2 and
  4 s later (`ReopenMissedTimes`).
- After that, a request of the page for a stream it already has tries again, at most every 2,
  4, 8 ... 60 s since the last try (a player that fetches a segment every few seconds would
  otherwise ask the page every time).
- A play the user starts in the page (content.js reports every trusted one: `MPV_USER_PLAY`)
  tries again at once, from the frame that played or the nearest frame above it that missed.
- A player the page itself took out again (`PLAYER_OPEN_GONE`, or its frame removed while the
  page stays) is not put back by the page's own requests - it would be taken out again - but a
  play the user starts does (`openGone`).
- Two more ways a page's player stayed after the event page had been unloaded and started
  again: a video file told by the page (`LOADED_MEDIA`) was dropped when the frame had not named
  itself to the new background yet; and a player accepted after its frame was forgotten (the
  page was asked whose it is meanwhile) left its page marked as opening for good.

Tests: `backgroundReloadTakeover.test.mjs` (fourteen cases), and in Firefox
`tests/e2e/ext-specs/reload-takes-over.e2e.mjs`: a page whose player has its video on the page
2.5 s late after a reload, and a video three screens down that the user scrolls to and plays.

## Content scripts: reasons behind the code

- **`custom/bilibili_content.js` `loadDashTracks`** - Bilibili lists one quality in up to three
  codecs (H.264, HEVC, AV1) under one id (32 for 480p). Put in one AdaptationSet, the player saw
  one level per id, all of the set's first codec; where Firefox could not start that codec's
  decoder it reset the video about 125 times a second and never tried the others. So there is
  one set per codec, and each Representation id is unique in the manifest.
- **`custom/bilibili_content.js` `jsonObjectAt`** - The play info is cut at its own closing
  brace: a regex to the line's last `}` took the next statement along
  (`...};window.__INITIAL_STATE__={...}`) and stopped at a line break.
- **`custom/facebook_content.js` `manifestOf`** - A reel opened signed out has no playlist; its
  manifest is only in `videoDeliveryLegacyFields.dash_manifest_xml_string`. Without it only one
  of the separate files the page fetches played (the sound of the next preloaded reel).
- **Site scripts, address changes** - Bilibili and Facebook move to the next video without a
  page load, and a content script runs once per load. For ten seconds after the address changes,
  the script tags that were not there before are read each second; the ones read before are
  not read again, or the first video would come back under the new address. Each script keeps
  the manifests it reported: the background keeps every report as another source of the tab.
- **`episode-links.js`** - Before it, content.js knew only an English "next"/"next episode"
  link, the neighbour of this page's link in a list, and "Episode N" lists; a German "Nächste
  Folge", an icon link with only an `aria-label`, and the plain `.../episode-12` ->
  `.../episode-13` of most hosters went unseen.
- **`episode-links.js` `stripMarks`** - The marks are taken off both ends by a loop: a regex
  anchored at the end (`[…]+$`) took a second for 60,000 dashes inside a text, at every poll
  for the next episode.
- **`episode-links.js` `normalize`** - Lower-casing is the same in every locale, and Turkish
  i's become a plain i: in a Turkish Firefox "NEXT EPISODE" became "next epısode", and in any,
  "SONRAKİ BÖLÜM" got a combining dot. No phrase in the list has a dotless ı of its own.
- **`episode-links.js` `neighbourEpisodeUrls`** - The order tried: the number after an episode
  word (`episode-12`, `folge12`, `ep_12`), `S01E12`, `1x12`, an `ep=` in the query, then the
  path's last number (`/watch/12`). Only the number changes, so the series stays the same.
- **`episode-links.js` `seriesOf` / `inSeries`** - After a season's last episode, autoplay went
  to another series on an anime site. The series is the path up to its first season or episode
  segment (or up to the episode in a segment that names the show too); a sequel that only
  starts the same (`one-piece-2/...` beside `one-piece-episode-1000`) is another series.
- **`overlay-guard.js`** - The player is an iframe in the frame whose video it replaced, and
  each frame above sees it through the iframe of the frame below; whatever a site lays over its
  video (control bar, play button, "server" menu, ad layer) lay over the player, and on sites
  that embed their player in a full-page iframe the embedding page's bar stayed on top. While a
  player is up, each frame of its chain hides what it paints over the iframe it holds, and gives
  it back when the player goes (`releaseAll`) or the iframe does. An element counts as the
  player's when it is painted above the iframe and at least 80% of it lies inside the iframe's
  box, or it covers half of that box: a bar or a layer, not a page header overlapping the top
  edge. The box is the whole iframe's, on screen or not (by its visible part, a header over a
  player scrolled mostly away covered "half"). Hiding uses `visibility`, so the element keeps
  its box and is given back as soon as it no longer covers the player.
- **`overlay-guard.js` `isSiteDialog`** - A site's own dialog (sign-in, cookie consent,
  settings) covers the player as an ad layer does, but hidden, the user saw no dialog and
  clicks went through its backdrop. It is told by its role or by a focused field in it, never
  by a focused link or button: those keep the focus after a click, so an ad layer clicked once
  (or a click-to-play cover) stayed over the player for good.
- **`overlay-guard.js` `overlaysOf`** - Every element is looked at, not only the body's: ad
  layers are often put straight into `<html>`. A pick's ancestors go with it while they are
  painted above the iframe too; a layout wrapper under the player (that also holds the page's
  nav) stays. An element missing from `elementsFromPoint` (`pointer-events: none`, as a
  see-through veil holding a clickable ad) goes by its size.
- **`page-qualities.js` `toList`** - The list is dropped as soon as it passes `MAX_ENTRIES`: a
  page of 50,000 `<source>` elements had each compared with all before it, minutes on the
  page's main thread.
- **`content.js` `elementsChangedByFillscreen`** - A Map, as each element is looked up in it:
  an array took seconds on a page of 30,000 elements (a lookup per element, a splice per undo).
  What holds the player gets its whole style attribute back (property by property when the page
  wrote to it meanwhile); a hidden element only its `display`: its whole old attribute also put
  back the overlay guard's `visibility: hidden`, which the guard had given back meanwhile, and the
  element stayed hidden for good.
- **`content.js` `pendingPlayers` / `watchRemovalOf`** - A page that takes a player iframe out
  before its player links up (a re-render) runs nothing in it to say so, and the background kept
  that frame's player opening: no player opened there again until the page navigated. The
  shadow roots the iframe is in are observed too, as a web component that re-renders its own
  tree took the player out unseen. A player the page took out before or after it linked up gives
  its element back, its miniplayer and windowed fullscreen go, and its media are free again;
  otherwise the page's video paused itself on every play until FastStream was turned off.
- **`content.js` `episodeLinkAddress`** - The link's address is followed rather than clicked:
  hosters hang ad scripts on their links (a popup, the episode in a new tab), and the chain
  broke. A link meant for another frame (`_top`, `_parent`, a name, also by `<base target>`) and
  a button keep their click; one into a new tab (`<base target="_blank">`) opens here.
- **`content.js` `readEpisodeLinks`** - Only links within the page's own origin: the background
  opens one later in a tab nobody looks at, and a link to another site (an ad's) went there with
  the tab's cookies.
- **`content.js` `handlePlayerOpen`** - The video is found by its visibility, which can take a
  second (a background tab's IntersectionObserver); `PlayersEpoch` stops a player going in when
  `removePlayers` ran meanwhile (the page went to another address and was given back).
- **`content.js` `RedirectingToPlayer`** - The frame sent to the player is not going away: the
  player loads in it and asks for the sources detected there, so the redirect's
  `beforeunload` sends no `FRAME_REMOVED`. It is a state, not a timer: an unload slower than
  the timer sent `FRAME_REMOVED` and the player got no sources. A second `beforeunload` is a
  leave of the page's own (the redirect was cancelled by a "Leave page?").
- **`content.js` beforeunload and `LeaveSettledMs`** - Firefox fires `beforeunload` for a
  navigation that then never happens (a download, a 204, a "Leave page?" answered no); the
  background forgot the page's frames and refused its later players as a gone page's, until a
  reload. A page still there `LeaveSettledMs` later names itself again and from then on reports
  its leave on `pagehide` too. The first report stays at `beforeunload`: the next page's own
  load can be its stream, detected before the old page's `pagehide`, and a frame still holding a
  player dropped it. A page the back-forward cache gives back names itself again (`pageshow`),
  which gets back what the background had detected on it, and drops a page-media hold that may
  have ended while it was cached.
- **`content.js` `handleCaptionsScrape` / `httpRequest`** - The background opens the player only
  once the page's tracks are read, so a track request is given up after `HttpRequestStallMs`
  without a byte (before the headers or between pieces), not after a fixed total: a large
  track on a slow line still loads, up to `HttpRequestTimeoutMs` and the shared byte budget
  (a subtitle file is kilobytes, a typeset one a few megabytes). Past the budget a track is
  given up as a failed request, and a failed one gives its bytes back. All tracks are counted
  before any is asked for: a request that fails at once answered inside the loop, and the
  tracks after it were never asked for.
- **`content.js` `hideSoft` / `showSoft`** - The element's own inline values are kept in a
  WeakMap, not in its DOM (`data-old-width`): a page that changed the attribute could leave its
  element hidden for good. Every value is saved with its priority, including one equal to the
  hidden one (`overflow: hidden`, `margin: 0 !important`); a value the page set while its
  element was hidden is its newest wish and is kept. The hidden element also gets no flex share:
  on bilibili (`flex: 1 1 0%` in a column) it kept half the box. The page's own `transition`
  comes back with the element (it stayed `none !important` for good).
- **`content.js` `updateReplacedPlayer` stand-in** - Putting the page's element back into the
  page for every measurement (every resize) ran its observers and custom-element callbacks, and
  a `<video autoplay>` in it loaded again. An empty stand-in with the same tag and attributes is
  measured instead, once it measured as the element did; media, frames, images and custom
  elements never get one. The element is measured with its id, as `transferStyles` gave it to the
  iframe: without it, the page's `#id` rules no longer sized it, and from the second update on the
  player took the element's unstyled box. Updates run at most every 100 ms and once after the
  last call: changes skipped inside a burst (a sidebar sliding shut) were never made up.
- **`content.js` `PausedHolds`** - One WeakSet a player: a page that adds and drops media while
  the player is up (ads, previews on hover) had each kept alive with its buffers. A WeakSet, not
  WeakRefs: Firefox keeps an entry keyed by the content script's wrapper of a page element for
  as long as the element lives.
- **`content.js` `updateMiniPlayer`** - The miniplayer fits its share of the screen both ways: by
  the wider side alone, a portrait player came out 853 px high on a 1920x1080 screen.
- **`content.js` `startPagePlayer`** - Once per page: the background asks every 2 s, and a page
  whose player does not load at once was clicked again each time. One ask looks for the video at
  a time (a background tab answers visibility only every second or so; a second click paused
  the player). The video is not muted: when FastStream did not take its stream after all, the
  site's player stayed silent. A refused `play()` is tried again at the next ask.
- **`content.js` `boxVisibleRatio`** - A box placed absolutely or fixed escapes the clips between
  it and its containing block (for a fixed one a transform, a filter or containment, else the
  viewport), as CSS draws it. A frame made in a hidden tab has a 0x0 viewport at first: until its
  real one comes, what lies below and right of its top left corner counts. The clip is each
  box's border box.
- **`content.js` next episode** - `listsThisSeason` needs the previous episode, or two other
  episodes of the season, linked: a season's first episode has no previous, and one other link
  alone ("latest episode: 5") is no list. At a season's last episode, step 1b takes the next
  season's episode 1 where the page links it, its episode this one +1 where the site numbers on
  across seasons, else (where the page links the season or one of its episodes) this address with
  the season one on; a linked "continue watching" episode 5 is no first. A later episode of this
  season linked (a gap) is not a season's end. Step 3 leaves out links into a new tab: the next
  episode there broke the chain.
- **`content.js` `reportedVideoFiles`** - Firefox can play a file without a request the
  background sees (a file an earlier page of the site played, served from its cache), and on a
  site FastStream was already on for nothing asked the page, so the player never opened. Each
  video's file is reported once at `loadedmetadata`; a blob: URL is no file. A video in a shadow
  root not found yet is not heard (media events stay in their root); `loadedMedia` still finds it.
- **`content.js` `listenedRoots`** - Media events are not composed, so a play inside a shadow root
  never reached the document and the MPV shortcut ignored such players. The roots on the way to
  what was clicked get the listener at once, every root on the page at most every 2 s.

## Utils, options, enums, dash2mp4: reasons behind the code

- **`EnvUtils.os`** - The system comes from `chrome.runtime.getPlatformInfo`: with
  `privacy.resistFingerprinting` on, `navigator.platform` says "Win32" on every system, and the
  mpv helper's Windows steps would show on Linux. `navigator.platform` serves only without a
  runtime (the web build, tests).
- **`WebUtils.getKeyString`** - A key that types nothing goes by `KeyboardEvent.key` ('ArrowLeft',
  'Home', 'Enter'), so the numpad's arrows, Home, PageUp, Delete and Enter fire their keys'
  bindings. Modifiers and 'Unidentified' keys go by position ('ShiftLeft'): 'Shift' alone would
  read as a modifier with no key. Control+Alt counts as AltGr only on Windows: on Linux and macOS
  it is a shortcut of its own, and their AltGr reports `AltGraph`.
- **`AlertPolyfill.mjs`** - `<dialog>` (`showModal`) and popover open in the top layer, so they
  show over a fullscreen player. They are children of `<body>`, not of the player, and stop their
  keys: the player's Escape handler cancels the key (which would keep a dialog open), and its
  keybinds would act on keys meant for the dialog. A dialog leaves the page the moment it closes,
  with no hide animation, so no invisible dialog stays over the page taking clicks. Texts go in as
  `textContent`: an error's message can quote markup.
- **`AlertPolyfill.errorReportURL`** - GitHub refuses a new-issue address past about 8 kB (414), so
  the stack and message are clipped by their encoded length (a character can take 9 bytes), after
  `toWellFormed`: `encodeURIComponent` throws on a lone surrogate. The `moz-extension://` id is
  taken out: it names the install, and the issue is public.
- **`Utils.migrateSizes`** - Options saved before the MB/GB picker hold the maximum size as a bare
  number meant as megabytes: a saved size below 1 MB is multiplied up, once (`sizesVersion`), and
  only from the value as saved, since a size below 1 MB chosen in the picker is meant. A size or
  speed limit of 0 saved then becomes -1 (no limit); 0 means "none" for a value chosen since.
- **`Utils.mergeOptions`** - A list option takes only a list of strings (an imported `null` broke
  the options page for good), and otherwise gets a copy of the default's list, so a caller that
  changes its list in place cannot change the defaults.
- **`Utils.measuredBitrate`** - Null until five fragments are downloaded: an MP4's ranges start on
  whole seconds, so on a high-bitrate file the first few share a second and last 0 s, which gives
  Infinity and a false "not enough storage" warning.
- **`Utils.downloadURL`** - Saves go through the background's `downloads.download`: Firefox does not
  download a blob: URL from a link click in a sandboxed iframe (blob URL partitioning, gecko's
  `BlobURLProtocolHandler.cpp`).
- **`options.mjs` limit fields** (`readLimit`, `showSize`, `saveWhileTyping`) - Speed and sizes are
  saved as bytes a second and bytes, -1 for no limit: an empty field is no limit and 0 is none,
  since users type 0 to turn a thing off. A comma is a decimal point, and a value is read to the
  three decimals the field shows, so what is saved is what it says. A field's change event comes
  only when it is left, so a field is also saved 400 ms after typing (else a value typed before
  the settings close is lost); it is written back only on a trusted change, never while typing,
  where it would fight the keys. An emptied or half-typed field ("1.", "-") is saved only when the
  field or the page is left. A size shows in GB only when three decimals hold it exactly, else in
  MB; after a change, in the unit the user picked.
- **`options.mjs` `saveOnLeavingPage`** - List fields are not saved while typing: half a line would
  be an entry of its own ("https://" in the auto-enable list would match every site).
- **`options.mjs` `ownSave`** - The store tells its listeners about the page's own saves too; a
  redraw then would rebuild the keybind rows (the box a key was just pressed in loses focus), move
  a number field's caret and undo a search, so the page skips the options it saved last.

## Measuring two builds: tools/bench-ab.mjs

The by-turns comparisons above were each made with a harness thrown away afterwards. This one
stays: `node tools/bench-ab.mjs --a main` builds main in a worktree of its own (outside the
checkout, node_modules linked; both need the same lockfile), builds this checkout, and runs
`tests/e2e/wdio.bench.conf.mjs`: one server per build on its own port, the same fixtures, both in
one e2e Firefox, ABBA order per round, one warm-up round thrown away. `--rate`/`--ttfb` put the
media (not the player's own files) on one shared slow line. A probe added before the page's
scripts (`browser.addInitScript`) records the moments (player modules ready, first frame,
playing, a seek to 80 s, a seek preview at 120 s) and counts timer, interval, animation-frame
and idle callbacks, DOM changes, frames more than 50 ms apart and dropped video frames while
playing, paused, after a seek preview, once ended, and in an idle player. The report
(`logs/bench/ab-<time>.md` and `.json`) gives medians, the spread (MAD) and a verdict only where
the medians differ by more than twice the larger spread and the measure's floor (a timeupdate's
250 ms, one frame). `--where` adds, per phase, the places in the player's code that asked for
the callbacks. `--clean` removes the worktrees (the node_modules link first). It measures; it
never fails on a number, only when a build cannot play.

**The settings page loads after the first frame** (2026-11-13, measured with it). The player's
settings page is an iframe in every player, and it loaded with the player: its scripts ran beside
the player's own as it started. 7 rounds, MP4: the first frame came 137 ms later with it (945 ms
against 808 ms without, p 0.004, 7 of 7 rounds); seeks, wake-ups and frame drops the same. It
loads now when the page is idle after the first frame (`OptionsWindow.loadFrameWhenIdle`, from
the client), at once when the settings window opens, and after 5 s in a player that shows
nothing, so the GitHub build's update check, which runs in it, still runs and shows its mark on
the settings button. `optionsWindowFrame.test.mjs`.

**Several tabs** (2026-11-14). `--scenarios tabs` (not in the default set: it takes two minutes
a run on a slow line) opens three players, paused, in background tabs and one playing in front,
each video on a loopback host of its own (`BENCH_TABS_HOSTS=same`: all on one), and tells when
the one in front has its whole video, when all four have, the seconds ahead in front 10 s in, the
first frame from the page's first request for the video, and the page's start.
`BENCH_TABS_VIDEO_S` is the videos' length (90). `BENCH_TRACE=1` writes a line of JSON for each
media request's start, end and cut to `logs/bench/trace-<time>.jsonl`: the address and port the
server was asked on (a tab's host, a build), playlist or segment, its count there, and the time:
who had the line when. Nothing the request sends goes into the file or its name (CodeQL found
both in the first version, which took the file's name from the variable and wrote the request's
address and headers).

**Buffering** (2026-11-15). `--scenarios stall-mp4,stall-hls,stall-dash` play a long video (the
long MP4, a looped HLS playlist, a looped DASH manifest - the dash-template fixture Period after
Period, `looped.mpd`) for `--stall-ms` (60 s), then seek three times far into it: how often and
how long it waited for media while playing (`waiting` not caused by a seek), the seconds it played,
the megabytes it fetched, and the median time from a seek to playing past the place. The line can
be made like real ones: `--jitter P` drops it to `--jitter-factor` (0.25) of its rate every other
P ms, from each run's start (full first), so every run of both builds meets the same line - on
one clock for all, main's HLS first frames came at 4.1 s three times in 5 rounds and the other
build's at 6.7-7.7 s each time, the same requests in the line's slow half or not; `--conn C` caps each answer at C Mbit/s, as servers that throttle a connection do; `--drop D`
cuts D % of the media answers part-way, at the byte chosen - the same requests for both builds
(by path, place and where the range ends, not the run), and only a run's first ask, so a retry
gets through, also one that goes on from where the cut stopped. The megabytes count requests
finished in the playing time. The long MP4 (17 MB) is often all loaded after a minute on a fast
line: its seeks then time a seek into what is there (after `--stall-ms 5000`, 4 MB in, mostly not). A trial, main against
itself, 1 round, 3 Mbit/s with jitter 5000, 150 ms to the first byte, 5 % cut: first frame 9-10 s
(MP4), 6-7 s (HLS, DASH); seeks 2.4-7.9 s.
