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
    limit). An HTTP 429 or 503 halves the downloaders for good (one stays), stops the test
    and holds every download for its Retry-After (30 s at most); the player starts its next
    video with one.
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
  its `cancel()`, which aborts what is still downloading for the save.
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
  do, measured), which is why the e2e stand-in has no token. mpv cannot use Firefox VPN at
  all.
- **Tests.** `tests/unit/VpnProxyMirror.test.mjs`; `tests/e2e/ext-specs/firefox-vpn.e2e.mjs`
  (a helper add-on plays the VPN: page requests only, through a local proxy, to a host no DNS
  answers). With `proxyFor` disabled, its two playback tests fail.
