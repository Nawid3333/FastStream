# The player: architecture, MP4Player, the loaders

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

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
  the player wait for the measurements to end (content-overlays' `playerAtRest`).

- **Measured and changed (2026-10-06).**
  - A video under five minutes is redrawn every animation frame (`progressLoop`); the loop
    ran on while the video was paused, 144 times a second on a 144 Hz screen. It stops
    while paused (unless the fine time controls are open), and `play()` starts it again
    (player-controls.e2e.mjs counts the updates).
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

## MP4Player and its MediaSource (2026-09-27)

`MP4Player` (accelerated MP4) feeds mp4box-extracted samples into a
MediaSource through one `SourceBufferWrapper` queue per SourceBuffer; `mainLoop()` runs
`runLoad()` every **1 ms**. Three things that were wrong, and what now holds:

- **`endOfStream()` is called** (`checkEndOfStream`) once every fragmented track's
  `nextSample` has reached its sample count and both queues are idle. Without it Firefox
  waited for data after the last frame: playback at the end sat buffering and never fired
  `ended` (`FastStreamClient`'s WAITING handler papers over it for autoplay-next only:
  waiting in the last second counts as the end), and a seek to exactly the duration never completed. An append or a
  removal after it reopens the MediaSource by itself (MSE spec), so seeking back just works.
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

`video.buffered` shows only what the queue has applied, not what is queued: a test that
waits for a range to be buffered after a reset can see stale appends that a queued removal
is about to delete; wait for idle queues (`toDo` empty, not `updating`) as well.
`tests/e2e/specs/mp4-seek.e2e.mjs` covers the above.

## MP4 from servers that do not answer ranges (2026-10-09)

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
  stream). An answer longer than the range is cut to it. Firefox's own player refuses a 206
  without `Content-Range`, so it is no way out there. Saving before the end is known counts as
  incomplete.

`mp4-without-ranges.e2e.mjs`: each kind of server, a small and a big file, a fragmented file
played a minute in, and one padded to whole ranges that must fire `ended` with no request past
the one after its end (without `endsAt`: 11 ranges past the end and no end, or 6 retries of the
416 and the load error).

## A file is what its bytes are, and Firefox's own player keeps the page's headers (2026-10-28)

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
  element's rule now lives 30 s and is renewed every 10 s while the player has the source
  (`SET_HEADERS`' `lifetimeMs`, capped at 60 s); a request's rule stays 5 s. After the player
  is gone the rule lasts at most 30 s, limited to the extension's own requests in that tab.

The background's 64 KB read of the file (`StreamLengths`) sees the same bytes and could pick
the player before MP4Player tries; not done yet: the hand-over costs one range.

`mislabelled-file.e2e.mjs`: a Matroska film served as `video/mp4` from an `.mp4` URL by a server
that sends a request without the page's Referer to a decoy, at 400 KB/s; the player plays it in
Firefox's own player, plays on after a seek 12 s in, and no request lacks the Referer. On main it
failed with the mp4box error; with the hand-over alone, the request 12 s in had no Referer.

The e2e web build (`wdio.conf.mjs`) serves the player with COOP/COEP: Firefox's own player there
loads only files whose server sends `Cross-Origin-Resource-Policy`, which every spec's server
does. The extension's player page is not cross-origin isolated: measure DIRECT there.

## AAC in a channel layout of its own, on Windows (2026-10-12)

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

## The qualities a page's own player offers (2026-10-12)

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

## Player core: what the loaders tell the libraries (2026-09-28)

- **hls.js's playlist loader has no `onAbort`** (`hls.mjs`, `PlaylistLoader.load` passes
  `onSuccess`/`onError`/`onTimeout`). `HLSLoader` reports a failed playlist with `onError`
  and `FetchLoader`'s `stats.error` (`{code, text}`). A fragment or key that fails gets
  `onAbort` after 1 s, and hls.js picks it again: upstream's design, on top of
  `FetchLoader`'s own six retries. From the third failure in a row of the same one it gets
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
  the video after the first one (`hls2mp4.test.mjs`, "discontinuities").
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
- **`SubtitleTrack.equals`** (`SubtitlesManager.addTrack` keeps one of two equal tracks): the
  same cues are one track unless the name *and* the language differ, as upstream has it. The
  2026-09-11 review took that `&&` for a typo, and the same file under another name was listed
  twice (restored 2026-10-15, `tests/unit/SubtitleTrack.test.mjs`).
- **`setSourceInternal`'s progress chain returns if another source came in**, both before
  it switches progress saving off and after it waits for the player. The wait ends when
  whichever player is current is ready, which may be the next source's.

## Which version of a height gets picked (2026-10-04)

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

## A quality lowered when the computer drops frames (2026-10-24)

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

## The audio output (2026-10-24)

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

## Firefox VPN (2026-10-06)

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

## Downloads between players, after seeks and errors (2026-10-09)

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
