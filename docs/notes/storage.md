# Network layer and storage

> Why the code in this area is as it is. A date on an entry is when it was learned; where
> the code and its tests say otherwise, they win. A section named in quotes may be in
> another file: [README.md](README.md) lists every section.

## Network layer: fetch() + OPFS

`chrome/player/network/FetchLoader.mjs` — the single loader shared by HLS,
DASH and MP4 fragment/playlist/manifest fetching (`DownloadManager.mjs` →
`StandardDownloader.mjs` → this file) — was rewritten from `XMLHttpRequest`
to `fetch()` + a `response.body.getReader()` loop. Same public interface
(`load`/`abort`/`destroy`, callback shapes), same retry/backoff/timeout
state machine, but the stall timeout now genuinely re-arms on every chunk
(the old XHR version could time out mid-transfer on a large, slow-but-
progressing body — armed once per `readyState` transition, not per byte).
Fixed along the way: a latent bug where tearing down an attempt to retry it
(`retry()`) also permanently marked `stats.aborted = true`, silently
swallowing the retried attempt's own outcome. 13 unit tests in
`tests/unit/FetchLoader.test.mjs` (the file had zero coverage before).

**When the network comes back (2026-11-16).** Offline, every attempt fails at once and the
wait between them doubles: 1, 2, 4 ... 32 s (StandardDownloader's config, DashLoader's for
segments), six retries, about a minute. A retry waiting out its backoff went up to 32 s after the
connection returned, and the video waited with it when playback needed that download. A download
whose retries ran out while offline left its fragment failed for good: `onDownloaderFinished`
resets failed fragments only after a failure while `navigator.onLine`, and the predownloader
takes only waiting ones, so nothing of them was downloaded ahead again until playback reached
each (MP4Player's `retryFailedRange`, hls.js's own retries). Now the window's `online` event
(fired when the browser regains network access; MDN calls it a hint, and a wrong one costs at
most an early retry) makes `DownloadManager.onNetworkBack`
send each waiting retry at once (`FetchLoader.retryNow`, which counts it as before; only one after
no answer at all, not a wait a server asked for with a 5xx or 429, nor one after a stall) and,
when a download failed while offline (`failedOffline`), set the failed fragments waiting again
(`FastStreamClient.resetFailed`). Not otherwise: a link failed for good online (a 403) would be
tried again at each return of a flapping Wi-Fi, each failure taking a downloader away (glm's
review). hls.js's own segment retries,
and DashLoader's loaders outside the store, are left to their own backoff. Unit tests only: an
e2e cannot take Firefox offline without privileged calls, and a refused connection does not
fire `online`. `FetchLoader.test.mjs`, `DownloadManager.test.mjs`.

**A download cut on the way (2026-11-18).** A body that broke off (the connection dropped, or
stalled past the timeout) was asked for whole again: on a slow, unstable line a range cut at
90 % cost it all. Now `FetchLoader` keeps what an attempt received and asks for the rest only
(`Range: bytes=<next>-<end>`), when the answer allows it: a 206 that starts at the range asked
for and gives the file's size, or a 200 for the whole file that says `Accept-Ranges: bytes` and its
`Content-Length`; never a compressed one (`fetch()` hands back other bytes than the server's). The
rest is taken only when it continues the same file: a 206 from the next byte to the same end, of
the same size, with the same strong ETag and Last-Modified when the first had them. Anything else
(a 200, another range or size, a 416, a changed file) drops what was kept and loads the range
whole, as before. The pieces go to MP4Player's `onChunk` at their place in the first answer, and
the finished load carries the first answer's status, headers and address. Text (manifests,
subtitles), and a range a server sent inside a longer body (it ignored the Range), are read whole
every attempt. A resume counts as one
retry. `FetchLoader.test.mjs` ("a download cut on the way"), `cut-answer.e2e.mjs` (a server
offering ranges is asked for the second half only).

`chrome/player/modules/FSBlob.mjs` gained an OPFS backend
(`chrome/player/network/OPFSManager.mjs` + a dedicated module worker,
`opfs-worker.mjs`, since `FileSystemSyncAccessHandle` only exists inside a
worker) as a third option alongside the existing Cache-API/IndexedDB/memory
chain — preferred wherever `OPFSManager.isSupported()` is true, which today
means Firefox specifically (Chrome's existing `BrowserCanAutoOffloadBlobs`
shortcut is untouched, and IndexedDB stays the fallback). **Firefox does not
expose `FileSystemFileHandle` as a global constructor** the way Chrome does
— `isSupported()` must not duck-type against it, only check
`navigator.storage.getDirectory`, or OPFS silently never activates on
Firefox despite being fully supported there. All OPFS filesystem ops
(including a 1s heartbeat) funnel through one `OpQueue` (`OpQueue.mjs`,
Node-testable, `tests/unit/OpQueue.test.mjs`) inside the worker, because
`createSyncAccessHandle()` throws if a handle on the same file is already
open — unlike an IndexedDB transaction, there's no free serialization to
lean on. `tests/e2e/specs/storage.e2e.mjs` verifies OPFS is actually
selected and actually round-trips bytes correctly under concurrent load, by
reading files directly out of `navigator.storage.getDirectory()` rather
than trusting `FSBlob`'s own self-report.

**Fixed 2026-09-30 (`tests/unit/opfsStorage.test.mjs`, `SecureMemory.test.mjs`, and
`storage.e2e.mjs` on real Firefox):**
- `OPFSManager.getFile` returns the file on disk (`getSavedFile`, a main-thread
  `getFile()`). It read each fragment back through the worker into an `ArrayBuffer`
  wrapped in a Blob, so every "offloaded" fragment was in RAM as well. A stored fragment
  is now deleted from disk on eviction, as the Cache backend's always were.
- A worker that answers nothing for 30 s while calls wait counts as a crash
  (`CallTimeoutMs`, one watchdog re-armed by every answer: it runs calls one at a time, so
  timing each call from its post counted a write backlog as a crash), and a dead worker
  moves FSBlob on to its next backend instead of keeping every later fragment in RAM.
- **Until 2026-10-03 no playback fragment was ever stored in OPFS** (#132): their
  identifiers are URLs, and Firefox refuses a name with a `/` (and `\` on Windows). The
  worker now only sees names `OPFSManager.fileName()` hands out (`f0`, `f1`, ...), so a
  file on disk is found by `opfsManager.fileName(identifier)`, not by its identifier. A
  sync access handle's `write()` reports a disk-full write only by a short count (Gecko
  never throws), which the worker checks (`writeAll`).
- `prune()` in the worker leaves a session directory younger than `STALE_MS` alone
  (it exists before its first heartbeat: two players starting together deleted each
  other's), and a heartbeat that exists but cannot be read (its owner is writing it) means
  alive. Only a stale or missing heartbeat on an older directory is pruned.
- **Tried and reverted (2026-10-09): a Web Lock per session as exact liveness.** A
  heartbeat is only as punctual as a timer (a busy worker, a computer back from sleep, a page
  frozen in the back-forward cache), so a live player's directory can be pruned. Each worker
  held a lock for its lifetime, and prune kept a sibling whose lock was held - but a lock held
  by a dedicated worker blocks the back-forward cache for its page (Firefox
  `LockManagerChild::NotifyBFCacheOnMainThread`, `BFCacheStatus::ACTIVE_LOCK` on the
  worker's ancestor window), and `content-cleanup.e2e.mjs`'s bfcache case failed. Do not hold
  a lock for a page's lifetime. A pruned session now costs a re-download, not a failure: a
  stored fragment that cannot be read is dropped and downloaded again (`onDataLost`, below).
- `clear()` bumps a generation, so an offload that finishes after it does not put its
  blob back.
- The progress store: `pruneOld` never rejects or hangs (the player's setup awaits it),
  salts are created with `IndexedDBManager.addValue` (IndexedDB `add()`, first writer
  wins, `ConstraintError` answered with `preventDefault` so the transaction completes),
  and a record that does not decrypt is marked `unusableRecord`: only then does the
  client start at 0 and save over it. A read that merely failed keeps no progress for that
  video, instead of overwriting the intact record from 0 a second later.

## Storage in a private window

**OPFS exists and does not work in a Firefox private window.**
`navigator.storage.getDirectory` is present there and throws
`SecurityError: Security error when calling GetDirectory` the moment it is
called. The Cache API and `navigator.storage.estimate()` work normally
(10 GB quota reported); `indexedDB.open` fails with `InvalidStateError` on
an extension page. So "is the API there" answers nothing in a private
window, and `OPFSManager.isSupported()` — which by design only checks
`navigator.storage.getDirectory` — said yes.

That single wrong yes killed the extension outright in every private
window, via a path worth remembering because none of it looks like storage
code: `FSBlob` committed to OPFS, its `setup()` rejected, and `FSBlob.clear()`
awaited the OPFS manager with nothing catching it, so the rejection
travelled `FSBlob.clear()` → `DownloadManager.clearStorage()` →
`DownloadManager.reset()` → `FastStreamClient.resetPlayer()` →
`FastStreamClient.setSource()`, whose `catch` logged it and returned. The
player was never constructed: no `<video>` element, no playback, no visible
error — just a permanent "Welcome to FastStream" status. The whole
`ext-specs` suite was green the entire time, because it only ever ran in
ordinary windows.

What that fix put in place, and the invariants to keep:

- `FSBlob` holds an **ordered backend chain** (`['opfs', 'cache',
  'indexeddb']`) instead of three module-level booleans.
  `ready()` awaits the active backend's `setup()` and, on rejection, moves
  to the next one — a backend that claims support and then fails costs one
  step down the chain, not a drop to RAM. A private window therefore lands
  on the Cache API, which is disk-backed, rather than buffering every
  fragment in memory. (Superseded 2026-10-09 for the player's own store: in a private
  window it is `memoryOnly` and nothing of it reaches the disk - see "RAM first, a
  budget, and private windows in RAM only". The chain and its fall-through still hold for
  every other `FSBlob`, the save converters' among them.)
- **No async `FSBlob` entry point may reject because of its backend.**
  `clear()` and `deleteBlob()` are best-effort by contract: the in-memory
  maps are emptied first, so the caller's invariant already holds, and a
  backend that refuses gets a `console.warn`. `reset()`/`setSource()` are
  on that path and treat a rejection as "loading the video failed".
- Anything reading `blobManager.opfsManager` **synchronously** is a bug in
  waiting — at construction time OPFS setup cannot have settled yet.
  `StreamSaver.mjs` picks its sink on first write via `ready()` for exactly
  this reason. So does `SaveFile.mjs`, which since 2026-11-13 keeps the media
  of both converters (`mp4merger`, `hls2mp4`): it decides at the first piece
  whether the save's OPFS file began, and stages its own copies of the pieces
  in the converter's blob store when it did not. Until then `mp4merger.mjs`'s
  `finalize()` fell back to Blob accumulation whenever an OPFS write threw;
  once a piece is on disk, a failed write now fails the save (below).
- **A download's `blob:` URL must outlive the download** (2026-10-01).
  `downloads.download()` resolves before Firefox has read the URL: revoked at once, 8 of
  60 small downloads were interrupted (`CRASH`) with no file and no message - a subtitle
  saved from the menu, the end of a StreamSaver save. Pass what `Utils.downloadURL`
  resolved with to `Utils.revokeWhenDownloaded(url, download)`, which revokes once
  `downloads.onChanged` says the download is over (a minute without an id). A link click
  (`<a download>`) reads the blob at once: 40 of 40 survived a revoke right after it.
  `ext-specs/download-blob-lifetime.e2e.mjs`; found through download-names' CI flake, whose
  test page closed with its blob before Firefox read it.
- **A link click saves nothing in a player inside a web page** (2026-11-28, #868). Firefox
  partitions a framed extension page's `blob:` URLs by the site around it, and refuses a link
  click on one ("Cannot access blob URL ... with a different partition key"): "Export Settings To
  File" in such a player's settings did nothing, while the options tab and about:addons saved.
  The export now saves through `Utils.downloadBlob` (the background's downloads API), which reads
  those URLs; the link click came from upstream's #402 fix, made while the URL was still revoked
  before the background had it. `ext-specs/settings-export.e2e.mjs`.
- **A saved video's copy on disk goes once its download is over** (2026-11-13, a review).
  Closing a save's blob store ended its OPFS worker and kept the session's folder on purpose
  (a finished file may still be downloading), and only `prune()` in a later worker deleted
  it: every saved video stayed a second time in the extension's storage (OPFS, persisted)
  until some other FastStream player started - for days, for someone who saves and closes
  the tab. `OPFSManager.close(true)` (through `FSBlob.close(true)`) now also removes
  `fsblob/<session>` once the worker has ended, best-effort; the prune stays the safety net.
  `Utils.whenDownloaded` tells whether Firefox said the download is over (complete,
  interrupted, gone) or the wait stopped without knowing (a link click, the 30 min cap):
  `SaveManager` passes "every download over" to the converters' `release()`, and
  `StreamSaver`'s `closeWhenDownloaded` passes it to `close()`. A failed or cancelled save
  deletes its files at once (nothing reads them). **Behaviour change:** the copy goes right
  after Firefox reports the download finished, instead of at the next player's start.
- `OPFSManager.isSupported()` additionally refuses up front when
  `EnvUtils.isIncognito()`, purely to avoid spawning
  a worker and logging a `SecurityError` per player open. It is not the
  safety net — the runtime fall-through is, and it has to be, because the
  web build has no `chrome.extension` to read `inIncognitoContext` from and
  still reaches OPFS in a private window.

`tests/e2e/wdio.pbm.conf.mjs` + `tests/e2e/pbm-specs/` (`pnpm run
test:pbm`) cover this: a permanently private session
(`browser.privatebrowsing.autostart`) with the add-on's private-browsing
permission granted through `ExtensionPermissions` in the `before` hook,
asserting the blob backend of a bare `FSBlob` is neither `memory` nor `opfs` (the
player's own store there is memory-only on purpose since 2026-10-09, a separate case), that
`clear()`/`deleteBlob()`/`downloadManager.reset()` resolve, and that an MP4
actually reaches `HAVE_CURRENT_DATA`. Verified to fail on the pre-fix tree
(4 of 6 specs) and pass after.

Two things about that harness. It needs **WebDriver classic**
(`wdio:enforceWebDriverClassic`), because granting the permission goes
through `browser.setMozContext('chrome')`, which the BiDi session the other
suites use ignores silently. Under classic, an `ArrayBuffer` built inside a
`browser.execute` body is cross-realm, so a library that checks `instanceof
ArrayBuffer` rejects it — that is why `ext-specs/vad.e2e.mjs` (ORT; gone with the
speech detector, 2026-10-10) could not move into this suite, and why an ORT `TypeError: Unexpected argument[0]:
must be 'path' or 'buffer'` here means the harness, not private browsing.
Second, the `addon.reload()` that applies the permission re-fires
`runtime.onInstalled`, so a `welcome.html` tab appears at the end of the
window-handle list; specs pick their window **by URL**, never by taking the
last handle.

**One more thing the same fix uncovered.** Making OPFS failure fall through
made `mp4merger.mjs`'s non-OPFS `finalize()` reachable on Firefox for the
first time, and it was broken: upstream pushed
`blobManager.saveBlob(slice)` into `this.datas`, `9ef061b1` changed the push
to the raw mdat Blob slice for the new OPFS path, and the Blob-accumulation
path below it kept mapping those slices through `FSBlob.getBlob()`, which
takes an *identifier*. Every chunk came back `undefined`, and
`new Blob([initSeg, ...undefined])` stringifies - so a DASH save produced a
**13 KB** file consisting of a valid init segment followed by the word
"undefined" once per fragment. It now builds the output from the slices
directly.

**Since 2026-11-13 it keeps no slices** (a review). A slice of the player's own
stored fragment reads nothing once the player has freed that fragment (a quality
change, the automatic lowering on dropped frames, the buffer moving on: the OPFS
file is removed). `finalize()`'s copy then failed, its `catch` took every error
for an OPFS failure and returned a Blob of the same dead slices: "Save complete",
and then Firefox's download failed. Slices of RAM Blobs kept their parents alive,
so a save bigger than the RAM budget held up to the whole video in RAM, and wrote
every byte only after the progress showed 100 %. Now each fragment's mdat goes
into the save's own OPFS file as it is read (`SaveFile`, taken from `hls2mp4`,
`SAVE_APPENDS_AHEAD` on their way at once), or is staged as the converter's own
Blob where that file cannot begin (a private window); `finalize()` puts the moov
in front of it. A failed read or write fails the save, so does a staged piece the
store no longer has (it used to become the word "undefined" again), and a failed
save drops its file (`saveAbort`), as an HLS save does. **Behaviour change:**
once media is on disk, a write that fails mid-save (disk or quota full) fails a
DASH or fMP4 save, as it already failed an HLS one, instead of falling back to
RAM; only a save that cannot begin on disk stages in memory.

`tests/e2e/specs/save-video.e2e.mjs` had been passing on that file the whole
time, on Chromium, where the web build always takes this path:
`decodeOk` and `duration` are both read out of the `moov`, so a header with
no media behind it satisfies them, and the DASH case asserted nothing about
size. It now requires >1 MB (a real save of that clip is 55-75 MB). Measured
both ways before and after: 13,563 bytes with the old mapping, 75,046,520
with the fix.

`SaveManager` also treated any incognito context the way Chrome's does:
`shouldAskForName` was `!isIncognito()`, on the rationale that "incognito
always opens the file picker anyway". Firefox private-window downloads open
no picker — they land in the download directory under whatever name they are
given — so both the video and screenshot saves silently used the page title
instead of asking. Both now always ask (they skipped it only for
`isChrome() && isIncognito()` until Chrome was dropped).

A private window predownloads as a normal window with "Keep video on disk" off does
(2026-11-20): what fits in its RAM share is downloaded whole, in RAM, and nothing goes to
the disk. Until then `updateHasDownloadSpace()` refused any predownload there and kept only
"Buffer behind" + "Buffer ahead" (5:20 by default), saying "Not enough room" also when the
RAM budget held the video; that refusal dated from a disk-backed private store, gone since
2026-10-09. A private window's message (`player_buffer_private_warning` since 2026-11-21) now says only that a video does not fit.

**The background is no private window and in no container** (2026-11-13, a review): what
it fetches for such a tab goes with the normal window's cookies, cache and proxy. Two of
its requests did:

- **FreshLink** (`REQUEST_FRESH_LINK`) fetched a refused stream's page again, credentials
  included: what the page set landed in the normal cookie jar, a container's own login was
  not the one sent, and the request missed a private window's proxy (`VpnProxyMirror`). The
  background now answers no link to a player in a private window's tab or a container tab
  (a cookie store other than `firefox-default`). **Behaviour change:** fresh links are off
  there; the player handles the refusal as it did before FreshLink.
  `backgroundRobustness.test.mjs`.
- **The length reads** (`StreamLengths.get`): a private window's playlists and the first
  64 KB of its files stayed in the normal disk cache after the window closed. They passed
  `credentials: 'omit'` and no cache option; now `cache: 'no-store'` too, as `MpvSubtitles`'
  reads already did for the same reason. `StreamLengths.test.mjs`.

## RAM first, a budget, and private windows in RAM only

Every downloaded fragment was written to disk at once - 44 ms for a 1.5 MB piece on OPFS,
measured in Firefox 157 - even for a video that fits in RAM many times over. A private window
paid twice: each fragment went to the Cache API (encrypted on disk, `storage/private`) and a
copy of it stayed in RAM as well, because Firefox keeps a private `Response.blob()` in memory
(`dom/fetch/Fetch.cpp`, `MutableBlobStorage::eOnlyInMemory`). Reading a 1.5 MB piece takes
0.24 ms from RAM, 1.5 ms from OPFS and 5.6 ms from the Cache API (same measurement, 40 reads
each): reads are not the bottleneck at one piece per 4 s of video; the writes were.

- **The budget.** `ramBudget`, 1 GB by default (2 GB until 2026-11-22, "Where downloaded video is
  kept" below), for all FastStream players together: automatic with the disk on, picked only with
  "RAM only" (512 MB to 4 GB), 0 for Disk only ("The options page, rebuilt" below).
  Firefox tells an extension
  nothing of the computer's RAM (no `navigator.deviceMemory`). Players announce their RAM over
  `PlayerPeers`; a player's share (`MemoryBudget.shareOf`) is its weight's part of the budget
  (the one the user watches and that plays weighs 4, others 1), or all the others leave free,
  whichever is more. Each kind of window has its own budget: `BroadcastChannel` is kept apart
  between private and normal windows. The count is the sizes of the Blobs held, an estimate,
  not resident memory; MSE SourceBuffers (Firefox caps them at 150 MiB video / 20 MiB audio each,
  and the players keep only 20-40 s there) are not counted.
- **Too much for the computer** (issue #798, 2026-11-21: an 8 GB laptop froze with the budget at
  20 GB, and nothing on the page said that was too much). Since 2026-11-27 nothing can be picked
  above 4 GB, and the question below is gone (the owner: "no RAM question"). Until then, with no
  RAM size to read, the user was asked: once on the welcome page, and in Options > General right before the budget ("This
  computer's memory", `computerMemory` in GB, 0 when not given). An answer sets the budget to an
  eighth of it, at most 4 GB (`StorageMode.recommendedRamBudget`: 4 GB -> 500 MB, 8 -> 1 GB,
  16 -> 2 GB, 32 or more -> 4 GB); where the rest goes is the storage mode's (it turned "Keep
  video on disk" on until 2026-11-22). The budget's field warns (`ramBudgetRisky`,
  `options_general_rambudget_high`) above 4 GB, or above a quarter of the memory given, names the
  recommended amount, and offers it on a button. Not chosen (the owner, 2026-11-21): taking "no
  limit" away; since 2026-11-22 it is offered only with "RAM only".
- **No guard while playing** (measured 2026-11-21; the owner chose not to build one). The one
  sign an extension has of a computer running out of memory is its own timers running late.
  Measured with the web player in headless Firefox 160 under a systemd scope (WSL Ubuntu 26.04:
  3 GB RAM, 2 GB swap; Firefox and the driver took ~2 GB of it), downloading a 60 Mbit/s stream
  at 20 MB/s, a 50 ms timer's worst lateness per second: with no limit, as the scope filled its
  RAM and then all its swap, 874 ms once when swapping began, ~200 ms for 20 s, then under 100 ms
  again; unpaced (~75 MB/s) under 0.5 s until the swap was full, then 13 s and 62 s: frozen.
  Controls: a 1 GB limit with the disk on, 34 ms at worst (0.75-0.93 GB held, no swap); every core
  busy, 105 ms; Firefox stopped 5 s (as a laptop asleep), 4993 ms once. The lateness comes only
  with the freeze, and one late tick looks like a wake from sleep: a guard on it would act too
  late, or for nothing. The limit itself is what kept the same video smooth.
- **Release.** Fragments stay in RAM (`FSBlob` deferred saves). Over `HIGH` (90 %) of its share a
  player lets go of fragments until it is back at `LOW` (75 %): furthest behind the playhead
  first, then furthest ahead, never [-10 s, +60 s] around it (private: [-5 s, +30 s]); if that
  window alone is bigger than the share, all but the next 10 s may go. Fragments without times
  (a fragmented MP4's ranges before they are parsed) are placed by their distance from the
  fragment playing; init segments are never released. Until it is back at `LOW` it starts no
  downloads ahead (`DownloadManager.memoryFull`); playback's own requests still go.
- **Normal windows** write what they let go of to disk (`FSBlob.spill`) and read it from there;
  one that cannot be written (the disk full) is let go of instead.
- **0 is straight to disk** (the owner's decision of 2026-10-09; it stopped every download
  ahead before, like a download speed of 0). A share of 0 lets go of all but the next 10 s, so a
  normal window writes the rest to disk as it comes, and downloads ahead go on while the player
  holds under `MemoryBudget.DISK_ONLY_ROOM_BYTES` (64 MB): what is on its way to disk. Where
  nothing goes to disk (a private window, the disk gone) 0 is that 64 MB in RAM
  (`FastStreamClient.memoryShare`, since 2026-11-22: before, nothing was downloaded ahead and the
  video waited for each part). (ram-budget.e2e: 4 MB of a 33 MB stream in RAM, the rest on disk;
  the old client never finished the download.)
- **Private windows keep nothing on disk** (`FSBlob` `memoryOnly`): the owner's decision of
  2026-10-09, after Firefox's own design (`browser.privatebrowsing.forceMediaMemoryCache` keeps a
  private window's media in RAM). What a private player lets go of is downloaded again when
  needed. A save is the user's own request to write the video to disk: its converters
  (`hls2mp4`, `mp4merger`, `remuxer`, `StreamSaver`) still stage in Firefox's encrypted
  private storage.
- **"Keep video on disk when this RAM is full"** (the owner's decision of 2026-10-10, for those
  who want no SSD writes for buffering; since 2026-11-22 the "RAM only" mode of "Where to keep
  downloaded video", below, and no checkbox of its own): `bufferToDisk`, on by default, as
  before. Off, a normal window's player works like a private one's: what does not
  fit is let go of and downloaded again when needed (`DownloadManager.setBufferToDisk` ->
  `FSBlob.setMemoryOnly`, at once, also mid-video; what is on disk already is read from there
  until it is deleted). Only the buffer: watch progress (`SecureMemory`, IndexedDB) and saves
  keep their storage. Every budget works with it: what is kept has to fit below `LOW` of the
  budget (`updateHasDownloadSpace`, `ramAheadSeconds`), so a video that fits (2 GB, 8 GB...)
  is predownloaded whole, a bigger one keeps what fits ahead with the storage warning and
  nothing pinned (grandfathered fragments could not be let go of), 0 keeps the 64 MB above (the
  options page no longer makes that pair: saved, it is read as RAM only with the recommended
  amount, `StorageMode.migrateStorage`), and an empty field is no limit, all in RAM, as with the
  disk. Kept beyond the budget, the far end was let go of and fetched again
  by the downloads ahead, round and round - private windows did that with "Buffer ahead" (300 s)
  in a small budget; they get the same cap. (ram-budget.e2e: with the switch off and a 2 MB
  budget, 64 fragments let go, 2.9 MB in RAM, 0 files, and the start downloaded again and
  played.)
- **The room to predownload, with the disk on** (2026-11-20), is the player's RAM share below
  `LOW` plus 60 % of the disk's free quota (`navigator.storage.estimate()`, quota less usage):
  RAM is filled first, and the disk takes only what goes beyond it. The disk's part alone was
  counted before, which a small quota made visible: Firefox gives an origin a tenth of the
  device's storage in best-effort mode (measured on Firefox for Android 160 in the emulator:
  quota 622 811 545 bytes on a 6 082 144 KiB `/data`, exactly 10 %), so on a small phone a
  long video "did not fit" (`player_buffer_storage_warning`, 5:20 kept) though the 2 GB RAM
  budget held it, and an empty RAM field (no limit) did not help either. On the desktop the
  quota is 10 GB (the group limit), which hid it. The room now moves with the share: another
  player taking RAM can end it mid-video, which pins what was downloaded (GRANDFATHERED) to
  keep it on disk. A pinned fragment the disk cannot take (full) is let go of like any other
  (`keepWithinMemoryBudget`); kept pinned in RAM, it held RAM "full" and nothing more was
  downloaded ahead for the rest of the video.
- **`unlimitedStorage`: no quota of Firefox's below the settings** (2026-11-21, #798). Without it the
  extension's origin is best-effort storage: measured in Firefox 160 (headless, a fresh profile, the
  player page top-level and framed in a web page alike) `navigator.storage.estimate()` gave a quota of
  exactly 10 GiB, `persisted()` false, and `persist()` never answered on the top-level page (a prompt
  waiting) and false in the frame. So even with no limit in any setting, 60 % of 10 GiB and the RAM
  share held no 3-hour 1080p movie (13.5 GB at 10 Mbit/s), and FastStream said "the predownload
  limits". With `unlimitedStorage` the same pages got `persisted()` true and a quota of 900 GB (a
  share of the disk). Firefox 160 shows no prompt for it: it is not in
  `ExtensionPermissionMessages.sys.mjs`'s `PERMISSIONS_WITH_MESSAGE`, so the update installs without
  asking. Persistent storage is not cleared under disk pressure: a session left by a crash goes by
  the heartbeat prune (`opfs-worker.mjs` `prune`), as before.
- **The persisted quota needs a `persist()` from a top-level page** (2026-11-22, #798 again). The
  quota is half the size of the file system the Firefox profile is on, not of its free space
  (Windows: 899.6 GB of a 1,799 GB drive; Linux, WSL Ubuntu 26.04: 540.55 GB of a 1007 GiB ext4, and
  12.63 GB for a profile on a 24 GiB tmpfs). The framed player shares the extension's storage (no
  partition per site). But `unlimitedStorage` alone persisted it only when a top-level extension page
  opened the storage first, or after a Firefox restart: with the player framed in a web page opened
  first (a site, right after an install), the storage kept the 10 GiB of best-effort storage for the
  whole session, on Windows and Linux alike, and the frame's own `persist()` answers false. A
  `persist()` from a top-level page answers true in a few ms, and the framed player has the full quota
  at once. The background (a top-level page) asks at every start (`background.mjs`): measured with
  the built extension, framed first, 899.6 GB on Windows and 540.55 GB on Linux at once, where 229
  had 10.74 GB. An update (227 to 229) with only framed players after it, as when watching on
  sites, kept 10.74 GB too (still 36 s on; a top-level page opened in between had persisted it);
  with the background's `persist()`, 540.55 GB one second after the update (Firefox 153.7 ESR with
  `xpinstall.signatures.required` off, so the unsigned build installs as an update). The same in
  Firefox 153.0, 153.7 ESR and 160.0.1. Settings: with `privacy.resistFingerprinting` the persisted
  quota reads 53.69 GB (50 GiB) whatever the disk; fingerprinting protection, strict tracking
  protection, blocked third-party cookies and clearing data on close change nothing; with
  `privacy.firstparty.isolate` the storage is never persisted, not after a restart and not with the
  background's `persist()`: 10 GiB stays. `storage-quota.e2e.mjs` opens the framed player first in
  its session and fails without the call.
- **Why a video is not predownloaded whole** (2026-11-21, #798): `roomWarning` names the cause, once
  per video, as an info for 12 s, and each message says it still plays and how far ahead it keeps
  loading. The maximum size setting (`player_buffer_size_warning`; none for a maximum of 0, which
  asks for nothing predownloaded), a private window's RAM (`player_buffer_private_warning`),
  "Keep video on disk" off (`player_buffer_ram_warning`), and the disk Firefox gives
  (`player_buffer_disk_warning`, now only a nearly full disk; its figure is what the video may fill,
  the RAM share and 60 % of the quota, not the whole quota). With no disk backend
  `player_outofstorage` has said it already. Nothing either when nothing is kept ahead (a RAM share
  of 0): "plays normally" would not hold. Before, one message, "does not fit in the predownload
  limits (size, disk space or RAM)", was read as an error and became an issue.
- **The Cache API backend** (a normal window without OPFS, the save converters) checks what it
  stored without reading it back (`match()`, body cancelled) and reads it when asked
  (`getBlob` then answers a promise; every caller awaits it).
- **Stored data that can no longer be read** (an OPFS file deleted or rewritten under its
  `File` - a File from `getFile()` reads the file as it is on disk now -, a Cache API entry gone)
  drops its entry (`DownloadEntry.onDataLost`), so the next request downloads it again, instead
  of failing the same way every time. Only for a `DOMException` or data that is not there: a
  `TypeError` is a bug, and dropping on it would download for ever.

**Invariants.** Every `FSBlob` path keeps `inRam` in step with `blobStore` (the budget reads the
count). What a backend stored replaces the RAM blob only while that blob is still the one held
(`replaceIfStill`): a fragment let go of and downloaded again while its first copy was being
written got the old data back. `enforceMemoryBudget` runs on the client's tick and must not
throw (it is wrapped). Saves are never cancelled or held by the network yield (player.md).
A fragment on its way to disk (`FSBlob.isSpilling`) is not chosen again (2026-10-20): what to
free is counted net of those (`held - leaving`), and chosen again on a tick while its write
still ran, its `spill()` answered false at once and the client let go of it as one that could
not be stored. With a budget of 0 that was every tick (the next 10 s are never let go of, so
the bytes asked for always reached into the ones being written): on CI's Windows runner, whose
OPFS writes queue for more than a second, RAM stayed at 7-13 MB for 30 s (CI runs 38301048814,
38626511584) and a 2 MB budget's stream had 26-56 fragments to go after 60 s (38301048814,
38498488742, 38625482765), while the same runner had written most of a 14 MB spill in 5-8 s in
the test before: not a slow disk alone (ram-budget.e2e, #501). `FastStreamClient.test.mjs` "the RAM
budget while writes to disk are slow" fails without it; ram-budget.e2e counts the fragments
let go of (`letGo`, 0 with the disk on) and the files of the player's own OPFS session only
(counted over every session, the earlier tests' files counted for this player's: 53-120 files
were logged at the budget-0 check, with about 52 from the test before).

**Tests.** `ram-budget.e2e.mjs` (a two-minute stream that fits stays in RAM, no file written;
with a 2 MB budget 64 fragments went to disk, 2.9 MB stayed, and the start played again from
disk; the same with "Keep video on disk" off: let go, no file, played again);
`FastStreamClient.test.mjs` "the RAM budget with nothing on disk" (2 GB, 8 GB, 500 MB, 100 MB,
0, empty, a private window); `options-fields.e2e.mjs` (the pickers, the storage modes, the changed marker and reset);
`StorageMode.test.mjs`, `SettingSteps.test.mjs` (the modes, the steps, the migration); `private-browsing.e2e.mjs` (the player's store is memory-only and holds the video);
`MemoryBudget.test.mjs`; `opfsStorage.test.mjs` (deferred saves, spill, `memoryOnly`, an old
write racing a new save); `DownloadEntry.test.mjs`, `DownloadManager.test.mjs` (lost data).

## Where downloaded video is kept: three modes

The owner (2026-11-22): settings were piling up and could work against each other. "RAM for
buffered video" and "Keep video on disk when this RAM is full" made three ways of keeping video
and two pairs that contradicted themselves: no limit with the disk on (the disk never used: all in
RAM), and 0 with the disk off (nothing kept ahead, the video waiting for each part).

- **"Where to keep downloaded video"** (Options > General): RAM, then disk / RAM only / Disk only,
  with a line under it saying what the chosen one does. No option of its own: `StorageMode.mjs`
  reads it from `ramBudget` and `bufferToDisk` (`storageModeOf`) and sets the two for a mode
  (`optionsForStorageMode`): Disk only is 0, RAM, then disk the automatic amount, RAM only its
  picked limit (the automatic amount when it held none). Cloud copies, files and older builds read
  the same two keys.
- **The contradicting pairs, saved before**, are read as what they did (`migrateStorage`, on every
  load in `Utils.getOptionsFromStorage` and on an import): no limit with the disk on is RAM only
  with no limit; 0 with the disk off is RAM only with the recommended amount (it did not work).
  Since 2026-11-27 both end on a step, once ("The options page, rebuilt").
- **Until 2026-11-27, the RAM field took what its mode used.** 0 (Disk only's) and an empty field (no limit, RAM
  only's) are refused in the other modes, on leaving the field: it shows its amount again and says
  why (`options_general_rambudget_refused`); the 400 ms save while typing takes neither. Under it,
  the recommended amount for the memory given (`options_general_rambudget_recommended`), the
  warning when the amount can freeze the computer, and a button that puts the recommended amount
  in. Picking the memory sets the amount only: where the rest goes stays the user's mode.
- **Until 2026-11-27, "Seconds to keep buffered ahead" took a number, 0 to 3600.** Empty was no limit and downloaded
  the whole video with predownload off, which made the predownload checkbox mean nothing. Empty is
  its default (300) now; a saved no limit is read as predownload on with no maximum size, which
  downloads the same.
- **"Downloads at the same time"** stays in the hidden developer options (`#dev`): moving it next to
  the speed limit, as first proposed, would have shown it to everyone.

**Measured (2026-11-22)** to pick the numbers, with a scratch bench (the web player, a 6-minute
1080p HLS video at 16 Mbit/s, 710 MB, from a local server, played while it downloads at full
speed; four modes, three rounds each, interleaved). Windows 11, NVMe SSD, Firefox 160.0.1:

| | All in RAM (4 GB) | RAM 200 MB, then disk | Disk only | RAM only, 200 MB |
|---|---|---|---|---|
| Whole video downloaded in | 3.2-3.9 s | 5.2-6.2 s | 4.2-6.7 s | - (keeps what fits) |
| A 50 ms timer's worst lateness | 49-55 ms | 21-37 ms | 14-97 ms | 13-84 ms |
| Dropped frames | 0 | 0 | 0 | 0 |
| Eight far seeks to `seeked`, median | 335 ms | 351 ms | 350 ms | 390 ms |
| Firefox's private memory | 1.7-2.1 GB | 1.2-1.3 GB | 1.0-1.2 GB | 1.1-1.4 GB |

The same on Linux (Ubuntu 26.04 in WSL 2, ext4 on its virtual disk, Firefox 160.0.1, headless):

| | All in RAM (4 GB) | RAM 200 MB, then disk | Disk only | RAM only, 200 MB |
|---|---|---|---|---|
| Whole video downloaded in | 4.3-5.6 s | 8.3-9.3 s | 8.3-11.1 s | - (keeps what fits) |
| A 50 ms timer's worst lateness | 32-82 ms | 79-80 ms | 38-125 ms | 28-116 ms |
| Dropped frames (of ~1790) | 10-40 | 8-19 | 17-45 | 8-41 |
| Eight far seeks to `seeked`, median | 193 ms | 178 ms | 190 ms | 247 ms |
| Firefox's private memory | 1.6-1.7 GB | 1.0-1.1 GB | 0.8-0.9 GB | 0.9-1.2 GB |

Frames dropped in every mode, RAM's too: software decoding in a headless VM, not the disk. The
virtual disk wrote 65-85 MB/s, still five times a 100 Mbit/s line.

- The disk costs nothing that shows: as smooth, no more dropped frames, at most 15 ms more per seek, and written
  at 100+ MB/s, beyond any line (100 Mbit/s is 12.5 MB/s).
- The budget is real memory, about one to one (600 MB more video in RAM, ~650 MB more Firefox).
- More RAM buys only fewer SSD writes ("What goes to the disk, measured": nothing within the
  budget, the overflow once). RAM only costs downloads again (39-48 fragments let go of per run).
- The spill rule (over 90 % of the share, down to 75 %, furthest behind first, never the next
  minute) made no stutter: unchanged.
- So the default (no memory given) is 1 GB, not 2 GB: half a 4 GB laptop's memory bought nothing
  but fewer writes. The recommended amount for a memory given stays an eighth, at most 4 GB: a
  typical episode stays whole in RAM (no writes) on 8 GB and more.

## The options page, rebuilt (2026-11-27)

The owner: the General section had grown one row per finding, badly explained, some rows
redundant, others conflicting; design it once so it is not reworked again. Upstream added each row
for one issue (#1 a 6 GB PC out of memory, #194 a maximum size "just to be safe", #202, #208) and
ordered them "by importance", never grouped; a request for tabs (#426) got the search box instead.
What was taken from other settings pages (Microsoft's app-settings guidelines, Firefox's own, mpv,
uBlock Origin): smart defaults; a dependent setting greyed with its reason, not hidden; five or fewer
exclusive choices as radio buttons with a line each; plain units instead of raw numbers; an
explicit "No limit" instead of 0 or an empty field; a marker on what differs from the default.

- **Sections.** General became Video (with the colour theme), Playback, Download and storage,
  Subtitles, Mouse and window, and Opening videos; the seek step went to Keyboard, the takeover
  delay to Auto-enable URLs. Every row has a line saying what it does (`*_desc`). A row's
  `data-keys` names its options: a dot after the label marks one that differs from the default
  (`options_changed`), and "Reset this section" (shown only then) puts the section's keys back.
- **Pickers, not numbers.** `SettingSteps.mjs`: Load ahead (30 s to 1 h, or Whole video, which is
  `downloadAll`), Largest video loaded whole (1-20 GB or No limit, greyed unless Whole video),
  Keep video already played (20 s to 30 min, or All), Download speed limit (No limit, 2-100
  Mbit/s), RAM only's limit (512 MB to 4 GB). Each of 0 ahead, 0 speed and a 0 maximum size had
  stopped the video or meant "predownload off" a second way; none can be set now.
  `migrateStorage` moves a saved value to its nearest step (by ratio; no limit to No limit where
  there is one, else the largest), also on an import and from a cloud copy. Once (`storageVersion`):
  run on every load, it also turned the small RAM budgets the e2e specs save with the disk on
  (`many-tabs`, `reload-keeps-buffer`: 60 MB, 2 MB) into 1 GB, and nothing reached the disk.
  An import runs it always, whatever version the file names: a file comes from outside, and a
  hand-edited one could bring back "0 ahead". It also does what `holdImportedNumbers` did for these
  five values.
- **No RAM question.** `computerMemory` (options and welcome page) and `RamGuard` are gone: with
  the disk on, more RAM only saves SSD writes (the bench above), so the amount is automatic
  (`AutomaticRamBudget`, 1 GB) and an amount set before becomes it. Only RAM only, where RAM is all
  there is, asks; without "no limit", since a long video could then fill the memory.
- **Stored now** (#853): `StoredNow.mjs` sums the files of FastStream's OPFS session directories
  (`fsblob/*`) and the RAM the players announce on `PlayerPeers`' channel, every 5 s while the
  section is on screen. Read-only: a player's directory goes when its tab closes, and a closed
  Firefox's leftovers a minute after its next start; a delete button was not wanted.
- **The autoplay problem list is gone** (`ProblemLog`, "Sites where autoplay got stuck" and its
  GitHub report): used twice, both times by the owner. `forgetRemovedSettings` removes its
  `siteProblems` key on the update.

## A full disk (2026-11-27)

Firefox's quota is no measure of free space: persisted, it is half the drive whatever is on it, so a nearly full
drive looks roomy. When the drive is full, OPFS writes fail with `UnknownError` ("Unknown failure"), the first ones
part-way (`opfs-worker`: "wrote 31049 of 334640 bytes"); not with `QuotaExceededError`.

**Measured** in WSL (Ubuntu 26.04, Firefox 160.0.1, headless): the profile on a 3 GB tmpfs, the page persisted
(quota 1.61 GB), the tmpfs then filled to 50 MB free; a 30-minute HLS stream (1,000 segments, ~475 MB) loaded whole with a
64 MB RAM budget and the disk on, played for two minutes, with a seek back to the start after 72 s.

| Two minutes | Before: each write tried | After: RAM only after the first failure |
|---|---|---|
| Failed writes | 23,162 | 1 |
| Segments downloaded again | 22,523 | 91 (mostly the seek back) |
| RAM held, at most | 217 MB (3.4 x the budget) | 48 MB |
| Message | none | one, 2.3 s after the disk filled |
| Playback waits / seek back | none / 4.1 s | none / 4.0 s |

Before, a fragment whose write failed was let go of as one that could not be stored, downloaded again, and failed again:
the "downloaded" figure climbed to 82 % and fell back to 23 % every three seconds, for good, without a word. On a real
line that is the whole connection, for the whole video.

**Repeated**, before and after taking turns: three runs each from an unlimited local server, two each over a shared
40 Mbit/s line (median, range in brackets; "sent" is what the server sent in the two minutes):

| Two minutes | Unlimited, before | Unlimited, after | 40 Mbit/s, before | 40 Mbit/s, after |
|---|---|---|---|---|
| Segments downloaded again | 22,458 (12,072-23,051) | 91 (91-92) | 1,013 (1,001-1,025) | 85 (85-85) |
| Sent | 6.7 GB (3.7-6.9) | 136 MB (126-137) | 372 MB (367-378) | 85 MB (85-85) |
| RAM held, at most | 219 MB (178-223) | 48 MB (48-49) | 62 MB (62-62) | 51 MB (51-51) |
| Playback waits / seek back | none / 4.1 s | none / 4.0 s | none / 4.0 s | none / 4.0 s |

On the slower line the loop runs only as fast as the line, and still takes four times what the video needs.

- **`FSBlob.writeFailed`**: the first write that fails with its backend working (OPFS, the Cache API or IndexedDB; a
  Cache API write that kept nothing too) sets `diskFull` and `diskGone`. Nothing more is written for this video; what
  is on the disk stays readable. The player then works as with "RAM only" (`keepsNothingOnDisk`, `canSpill`): the
  time ahead capped to its RAM share, and fragments outside the window let go of, their files deleted, which gave the
  full disk back 16 MB in the measurement.
- **One message a video** (`player_disk_full`), none of the "not loaded whole" ones beside it (`roomWarning`).
- **The next video tries the disk again** (`FSBlob.clear`): this one's files go, and space may have been freed.
- **A write `clear()` cut short** (its files deleted under it) says nothing of the disk: the generation the save began
  with (`offloadBlob`) must still be the store's.
- Tests: `opfsStorage.test.mjs` ("writes nothing more for this video once a write fails", "a write that clear() cut
  short"), `FastStreamClient.test.mjs` ("when the disk is full").

## What goes to the disk, measured

Three player tabs, a 241 MB HLS video each, from a local server, in a test profile; the
system-wide bytes written to physical disks (`Win32_PerfRawData_PerfDisk_PhysicalDisk`),
against an idle baseline of the same length:

- **Within the RAM budget nothing of the video is written.** 723 MB downloaded with a 4 GB
  budget: all of it in RAM, Firefox's temp files 0 MB (FetchLoader reads the body into its
  own buffers and fetches with `cache: 'no-store'`, so neither `Response.blob()`'s temp files
  nor Firefox's HTTP cache take a copy); the ~80 MB above the idle baseline is the profile's
  own activity, the same with any video size.
- **Over it, the overflow is written once, plus the file system's overhead.** With a 300 MB
  budget ~500 MB went to OPFS, and Windows wrote ~1.2 GB for it while every file and every
  heartbeat was flushed (a forced sync). Plain Node, writing the same 501 MB as 313 files,
  each flushed: 800 MB; not flushed, 423 MB after 30 s. Since then no fragment and no
  heartbeat is flushed (`opfs-worker.mjs`; a save's file is, once, when complete): in total
  ~1.0-1.2 GB instead of ~1.36 GB for the same spill (the lazy writer writes the data a little
  later), and no forced sync every second per open player.
- **What it means for an SSD:** rated endurance is in hundreds of TB written (a 1 TB drive
  typically 600 TBW); 10 GB of spilled video a day is ~9 TB a year with the overhead, about 1.5 %
  of that. The budget is what decides how much is written: the overflow beyond it.

## A reload keeps the buffer (20 s, or the time the user picks)

His wish: a reload of the page must not throw away what was buffered; what nobody takes back is let
go of 20 s later, in RAM and on the disk alike. `ext-specs/reload-keeps-buffer.e2e.mjs`. Since
2026-11-22 the time is an option (`bufferKeep`, "How long the downloaded video is kept after a reload or a closed tab": Off,
20 s, 1, 5, 15, 30 min, 1 h; default 20 s), below.

- **The hand-off.** At the player's `beforeunload`, before `destroy()`, the client sends its finished
  video files to the background (`BUFFER_STASH`, `FastStreamClient.handOffBuffer` ->
  `DownloadManager.handOff`): RAM ones as their Blobs, disk ones as their OPFS file names plus the
  session directory. Plain records only (no `DownloadEntry`, no functions); no playlist or
  manifest (text: they carry the old signatures, a live one moves on), no key (raw), nothing in
  the Cache API or IndexedDB. Measured: 256 MB of Blobs sent in 1 ms, the data shared, not copied,
  and intact after the sender's page was gone. Since 2026-11-13 (a review) the hand-off keeps its
  files from the player's reset (`DownloadManager.keepStorageOnce`), and `destroy()` closes the
  download manager only once the reset is over. Before, `destroy()` did not await the reset: its
  clear of the files on disk (`FSBlob.clear` waits for its store first) reached the OPFS worker
  after the store's close, so it ran after the worker's `destroy` and deleted the files just
  handed over (the next player downloaded them again), or did not run at all as the page went,
  leaving the player's own files for another player's prune. Without a hand-off, a player that
  goes now deletes its own files before its store closes. A reset that first waited for a
  running save then ran on the destroyed manager and threw; a destroyed manager's reset does
  nothing now. `DownloadManager.test.mjs`, `FastStreamClient.test.mjs`.
- **`runtime.getBackgroundPage()` is not there in a player iframe inside a web page** (it is in an
  extension tab), so the hand-off is a runtime message; from such an iframe, messages and ports
  still go out at `beforeunload` and `pagehide` as its page reloads (measured).
- **The key is the page as `BUFFER_TAKE` told the player.** By the hand-off the tab's frames are
  the next page's already: the page frame's address is empty, the player's frame a new object
  (measured). The background answers `BUFFER_TAKE` with the page, and the player names it in its
  hand-off. Key: page + source identifier + private or not + container (`bufferKey`): two videos on
  one address (`hls.php?v=1`, `?v=2`) never take each other's files.
- **The stash** (`chrome/background/BufferStash.mjs`) keeps a hand-off `BufferKeepMs` (20 s), then
  lets its Blobs go and deletes its session directory (the background sees the iframe's OPFS:
  measured). A newer hand-off of the same key replaces an older one. If the event page itself
  goes first, its RAM goes with it, and the directory waits for the 60 s prune. Measured: a stash
  in the event page survives 25 s with nothing else happening. Each record's timer lets go of that record
  (`BufferStash.timerFor`), not of whatever `Date.now()` says is due: until 2026-11-23 it called `expire()`,
  and with the wall clock behind the timer nothing was due, no timer was left, and the files waited for the
  prune (`BufferStash.test.mjs`, a clock 50 ms behind). The likely cause, not proven, of `reload-keeps-buffer.e2e`
  finding the directory still there at 22 s on CI (33 retries in the week to 2026-11-23, 30 green on the retry). `expire()` is the alarm's, for an event page loaded again.
- **Kept longer than 20 s, it goes to the disk** (`KeptBufferDisk.mjs`), because the event page does
  not live that long. Measured in Firefox 159 (an add-on probe): an idle event page is stopped after
  `extensions.background.idle.timeout` (30 s; stopped at 29.8 s while it wrote OPFS files and called
  no extension API); one that calls an extension API after each write (`storage.session.set`) is
  still running after 50 s; a stopped one wakes as a new document, its memory and timers gone. So
  the stash writes the hand-off's RAM Blobs into a session directory of its own (`fsblob-<ms>-kept…`,
  files `k<n>`, raw bytes like any other) with a `_kept.json` record (key, link, the files, until
  when, this Firefox's id) and calls `storage.session.set` after each file. A new event page reads
  the records back (`BufferStash.restore`, before any take), and an alarm (`buffer-keep`, the
  `alarms` permission) wakes it when the first one is due. `ext-specs/keep-buffer-long.e2e.mjs`:
  5 minutes picked, the tab closed, the event page stopped (idle timeout lowered to 2 s), 25 s
  later the page opened again took all 21 parts back from the disk and asked for none again; the
  build before failed it (nothing taken back).
- **Hard limits.** At most 1 h (`BufferKeepMaxMs`; a record further ahead is not believed). The
  kept buffers together stay under a quarter of the storage quota (`limitBytes`): the oldest goes
  first, and one larger than that on its own is kept 20 s in RAM only. A private window keeps 20 s
  in RAM only, never on the disk (`ramOnly`). Firefox closed: the id in `storage.session` is gone
  with it, so a record from before is not this Firefox's and is deleted at the next start, with its
  files; the OPFS prune (`SessionPrune.mjs`, 60 s heartbeat) leaves a directory alone while its
  `_kept.json` says it is kept, at most 1 h. Off: the player hands nothing over and the reset
  deletes its files at once. `BufferKeep.test.mjs`, `opfsStorage.test.mjs`.
- **Firefox closed with players open** (#798, 2026-11-22): their session directories stayed, as
  their players never deleted them and the stash's timers went with the event page, until a player
  started again (only its start pruned): a user found 18.3 GB in `fs` after a restart. Reproduced
  in Firefox 160 on Linux with 1.3.82.233 installed for good: 438 MB stayed 90 s after the restart
  with no video opened, and went once one opened. Now the background prunes too, on an alarm
  (`fsblob-prune`) 65 s after `runtime.onStartup` and `runtime.onInstalled`: every earlier run's
  heartbeat is past `STALE_MS` by then, and every live player's is not, also one restored with its
  tab at the start. The background sees the default OPFS partition only: a container's leftovers
  wait for its next player. The alarm listener returns the prune, so Firefox keeps the event page up
  until it is done (a Codex review). `backgroundSessionPrune.test.mjs`.
- **The keep time, measured in Firefox 160.0.1 on Linux** (a scratch check: FastStream installed for
  good in a fresh profile, a 710 MB video from a local 100 Mbit/s line, Disk only, the tab closed after
  ~310 MB, the `fs` folder measured on the disk, the sessions listed from an extension page): Off
  emptied it at once (usage 1 MB, the folder 0 MB 3 s later); 20 s kept the files 18-21 s, then the
  directory went; 1 minute kept them with their `_kept.json` past the event page's unload and deleted
  them 50-60 s after the close; RAM only with 1 minute wrote nothing to the disk and let go of it after
  20 s. Firefox closed with the video open: 422 MB stayed, and went 60-70 s after the next start with no
  video opened (1.3.82.233: until a video opened). The fix build ran on the unbranded 160.0.1 (the
  shipped release's source; it installs an unsigned add-on for good), 1.3.82.233 on the release build.
  A pitfall of such checks: after an install, WebdriverIO's `newWindow` answered with the welcome tab's
  handle, and the check closed the welcome tab while the video played on; find the tab by its address.
- **A moved file whose part was let go of** is deleted (`adoptOne`), but not when the same part was downloaded
  again meanwhile: that download is saved under the same key, and deleting it lost it (an area review, 2026-11-21).
  "Its data under the key" is `entry.blobId ?? key` (`keepsDataUnder`): a download moved on to a new link keeps its
  data under the old key.
- **Taking it back.** `FastStreamClient.takeBackBuffer` runs in `setSourceInternal` after the reset
  and before the player is built. The answer is `structuredClone`d into the player's realm first:
  its Blobs were not `instanceof Blob` there, and none was taken (measured). RAM Blobs go into the
  player's FSBlob as deferred saves (in its RAM budget); disk files are moved into its own session
  (`FileSystemFileHandle.move` on the main thread: 4 ms for 1 MB in Firefox 159), 8 at a time,
  then the old directory is deleted. Each disk file is a finished download from the start, its
  data read once its file is moved: in its turn, or at once when the player reads it first
  (`DownloadManager.adoptOne`). The player asks for where it starts or resumes before those files'
  turn, and they were downloaded again (`reload-keeps-buffer.e2e`, twice in the week to
  2026-11-02, #620); one that cannot be moved is dropped as lost data and downloaded then.
- **A new signed link** (vidmoly: `?t=&s=` new at every load): `LinkSignature.linkChange` names
  the query parameters whose values differ between the old and the new source link, and a request
  under the new link finds the file with those left out (`looseLink`; `DownloadManager.stored`, an
  alias: the entry's data stays under its old store id, `entry.blobId`). Parameters that did not
  change still tell files apart. FreshLink uses the same (`DownloadManager.relink`, the query only):
  a refused link's fresh one no longer downloads everything again. (FreshLink gives no link in a
  private window or a container tab since 2026-11-13: "Storage in a private window".)
- **Every way back, and links issued anew in other forms** (the owner, 2026-11-27: "it does not even
  keep it for those 5 minutes, the whole video buffers again", on most hosters; a reload on one HLS
  hoster did keep it). Measured with `ext-specs/keep-buffer-ways-back.e2e.mjs`, an episode page
  framing a hoster page, 5 minutes picked. With links signed in the query alone, every way back
  already took everything back: reload 71/71, Back 85/85, the tab closed and opened again 91/91,
  Firefox unloading the tab (`gBrowser.discardBrowser`, then the tab chosen again) 100/100. What
  failed was the link: a token in the path (`/v/<token>/...`), another host (a CDN's next node), or
  the hoster's frame under a new address took back nothing and downloaded all of it again (83, 79,
  100 parts). The key was the frame's page and the stream's address without its query, and a file
  was found only under the same host and path. Now:
  - The background keeps each buffer under the tab's page too (`nearKey`, sent back by the player
    in its hand-off as BUFFER_TAKE told it, and in the record on the disk); a player whose own key
    finds none gets the one of the same tab page (`BufferStash.takeNear`: a link of the same shape
    first, else the newest).
  - `linkChange` also names a changed host and the path segments that changed in place (the same
    depth), and `looseLink` leaves them out of the old parts' links and the new requests' alike;
    the stream's own link stands for itself, so a single file whose whole link changed keeps its
    ranges.
  - Beyond the query nothing of it is used until one part downloaded anew is the same, byte for
    byte (`DownloadManager.checkAdopted`): the parts asked for meanwhile download anew, and the
    first one done decides. Other bytes: another video's, all of it let go of. The notice of a
    buffer taken back waits for that (`checked`).
  - After: path token 67/67 taken back, 5 parts downloaded again (those asked for before the
    check); another host 97/97, 1 again; the frame's new address 84/84, 0 again. Another video on
    the same page under a new link (each segment one TS null packet longer): not used, all of it
    downloaded, playback fine. The red runs before the change are the measurement above.
  - Not covered: a hoster whose segments each carry a path token of their own, unrelated to the
    stream's link (no part lines up: downloaded again, as before), and a playlist whose variant
    links change differently from its master's.
- **Downloading the video again** (the owner, 2026-11-22): a reload to mend a load that went wrong
  keeps what it downloaded, broken parts too. A buffer taken back says so for 15 s, with its size
  (`DownloadManager.adopt` counts the bytes of RAM and disk); its button, or the more menu's
  (`redownload`, any stream from the network), runs `FastStreamClient.downloadAgain`: the same
  source again at the current second, quality and audio track kept, playing if it played, without
  `keepStorage`, so the reset deletes everything downloaded, in RAM and on the disk.
  `FastStreamClient.test.mjs` ("downloading the video again", "a buffer taken back").
- **How it says so** (`ui/BufferKeptNotice.mjs`, the owner, 2026-11-27): until then a status message,
  "Reusing 1.4 GB that was already downloaded. Click here to download it all again.", in the place
  where a failed load's errors show: long, and a click there looked like the way to mend anything. Now
  it is apart from the status line, in the middle of the bar's free space: "Reused 1.4 GB" and a
  quiet "↻ Download again" button, each explained by its title, in the bar's own colours with no
  animation (nothing that draws a click from someone who does not know what it does). It stays while
  the pointer or the focus is on it. It takes only the room the status line leaves (`flex: 1 1 0`
  beside a left part that no longer grows): when the room shrinks (a narrow player, a long error),
  the size goes first, then the button's word, then the button (`fit`, on a `ResizeObserver`); the
  more menu's button is always there. Looked at in the web build at 1280, 760, 700, 600 and 520 px
  wide, with an error and with the download line. `BufferKeptNotice.test.mjs`.

## Players in many tabs

The owner (2026-11-22): a stress test of FastStream buffering in several tabs at once, to see what
breaks or interferes. `ext-specs/many-tabs.e2e.mjs`: FastStream's player in four tabs of its own, a
70 MB video each from one 200 Mbit/s line, one RAM budget of 60 MB for all and the rest on the disk,
"Off" for the closed tabs. Every tab reports over a BroadcastChannel to the others; the server
holds the segments until all four report (a burst before a tab's probe went unseen: a Codex review).

- **A closed tab left most of its files.** Its player clears them as it goes (no hand-off with
  "Off"), and the worker deleted one file at a time after listing them; beside three other players
  Firefox stopped it part way: 229-253 of ~330 files stayed (one player alone, in the keep check:
  none). The directory stayed with its last heartbeat until the next player's start, or the next
  Firefox start (`fsblob-prune`). `clearStorage` now deletes the session's directory in one call
  (`removeEntry(name, {recursive: true})`), which Firefox finishes after the page is gone, and the
  player goes on in a new directory under a new name, which `OPFSManager.clearStorage` takes from
  the answer: made again under the old name, another player's prune could take it between the
  making and its first heartbeat, and delete files written meanwhile (a Codex review); a new name is
  younger than `STALE_MS`, no prune's. One file at a time only when the directory cannot go (a save
  holds a file open). The spec failed before (237-253 files) and passes after;
  `opfsStorage.test.mjs` ("opfs-worker: clear").
- **A page that goes leaves an empty directory.** A clear as the page goes makes the new directory
  too; it holds nothing and is pruned like any other. A spec that took "the newest directory" as the
  player's found such a one (the extension page the specs set options from): ask the player for its
  session (`reload-keeps-buffer.e2e.mjs` `playerSession`). Tried and dropped: making the new
  directory only at its first file. Taking a hand-off back moves files into the player's directory
  on the main thread before the worker writes anything, so it needed the directory made there too.
- **The budget holds, with a second of the line on top.** It is kept on the client's tick, once a
  second: the four held 46-56 MB in RAM together once done and written (`ramBytes()`, what is on its
  way to the disk included), and at most 73-88 MB on the 200 Mbit/s line. From a local server,
  unpaced (hundreds of MB/s), the most was 100-163 MB (1.7-2.7 budgets), for a moment: on a real
  line it is at most a second of the line per player.
- **Nothing froze.** The tab in front's 50 ms timer was at most 2-17 ms late; all four played and
  downloaded their whole video; the one left had the whole budget once the others closed, and
  played on.
- **A flake that was there before.** `reload-keeps-buffer.e2e.mjs` "keeps what was buffered in RAM"
  failed 1 run in 3 without its retry, with the old worker as with the new: the segments still
  downloading as the page reloads (2-6) are asked for again.

## Network layer: reasons behind the code

- **`OPFSManager.setFile`** - The Blob itself goes to the worker, which reads it in its turn: a
  Blob crosses to a worker without a copy. Read on the main thread first, every fragment a memory
  budget spilled at once sat in RAM twice before the first was written.
- **`DownloadManager.adopt`** - One file under two issues of the link (a FreshLink renewal
  downloaded it again) is taken once, the twin left out: both were otherwise handed on at every
  later reload.
- **`DownloadManager.onDownloaderFinished`** - A speed-test round counts each downloader once,
  heard with a speed: counted by their place in the list, a downloader dropped meanwhile moved the
  next onto a place already heard, and a sample without a speed (a cache hit) marked its place
  heard without counting it, so the round never closed. Only a round with exactly one more
  downloader than the last sample tells whether one more adds speed.
- **`DownloadManager.reset`** - A reset begun while another waits for its storage owns the
  downloaders (both adding theirs ran twice the limit), and what was queued during the reset's
  await is started at its end: a player set up meanwhile (a seek preview being built) queued its
  manifest then, and nothing else started it.
