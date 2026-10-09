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

- **Measured and changed (2026-10-06).**
  - A video under five minutes is redrawn every animation frame (`progressLoop`); the loop
    ran on while the video was paused, 144 times a second on a 144 Hz screen. It stops
    while paused (unless the fine time controls are open), and `play()` starts it again
    (player-controls.e2e.mjs counts the updates).
  - Downloads (#359): a video starts with three downloaders and the speed test decides per
    two samples: playable 0.45 s after the player appears instead of 0.68 s, six
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
  Specs that need actual sound check for it with audio-tools.e2e.mjs's `skipWithoutSound`;
  without it they skip, except on Linux CI, which has a PulseAudio null sink since
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
  downloader stays busy for good.
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
