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

- **The budget.** A setting (Options > General, "RAM for buffered video", 16 locales), 2 GB by
  default, for all FastStream players together; an empty field is no limit, 0 is none (below):
  Firefox tells an extension
  nothing of the computer's RAM (no `navigator.deviceMemory`). Players announce their RAM over
  `PlayerPeers`; a player's share (`MemoryBudget.shareOf`) is its weight's part of the budget
  (the one the user watches and that plays weighs 4, others 1), or all the others leave free,
  whichever is more. Each kind of window has its own budget: `BroadcastChannel` is kept apart
  between private and normal windows. The count is the sizes of the Blobs held, an estimate,
  not resident memory; MSE SourceBuffers (Firefox caps them at 150 MiB video / 20 MiB audio each,
  and the players keep only 20-40 s there) are not counted.
- **Too much for the computer** (issue #798, 2026-11-21: an 8 GB laptop froze with the budget at
  20 GB, and nothing on the page said that was too much). With no RAM size to read, the user is
  asked: once on the welcome page, and in Options > General right before the budget ("This
  computer's memory", `computerMemory` in GB, 0 when not given). An answer sets the budget to an
  eighth of it, at most 4 GB (`RamGuard.ramBudgetFor`: 4 GB -> 500 MB, 8 -> 1 GB, 16 -> 2 GB,
  32 or more -> 4 GB), and turns "Keep video on disk" on. The budget's field warns
  (`ramBudgetRisky`, `options_general_rambudget_high`) above 4 GB, or above a quarter of the
  memory given, and the no-limit hint names the freeze. Not chosen (the owner, 2026-11-21):
  taking "no limit" away.
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
  holds under `MemoryBudget.DISK_ONLY_ROOM_BYTES` (64 MB): what is on its way to disk. A
  private window, with no disk, downloads nothing ahead at 0. (ram-budget.e2e: 4 MB of a 33 MB
  stream in RAM, the rest on disk; the old client never finished the download.)
- **Private windows keep nothing on disk** (`FSBlob` `memoryOnly`): the owner's decision of
  2026-10-09, after Firefox's own design (`browser.privatebrowsing.forceMediaMemoryCache` keeps a
  private window's media in RAM). What a private player lets go of is downloaded again when
  needed. A save is the user's own request to write the video to disk: its converters
  (`hls2mp4`, `mp4merger`, `remuxer`, `StreamSaver`) still stage in Firefox's encrypted
  private storage.
- **"Keep video on disk when this RAM is full"** (Options > General, under the budget; the
  owner's decision of 2026-10-10, for those who want no SSD writes for buffering): on by
  default, as before. Off, a normal window's player works like a private one's: what does not
  fit is let go of and downloaded again when needed (`DownloadManager.setBufferToDisk` ->
  `FSBlob.setMemoryOnly`, at once, also mid-video; what is on disk already is read from there
  until it is deleted). Only the buffer: watch progress (`SecureMemory`, IndexedDB) and saves
  keep their storage. Every budget works with it: what is kept has to fit below `LOW` of the
  budget (`updateHasDownloadSpace`, `ramAheadSeconds`), so a video that fits (2 GB, 8 GB...)
  is predownloaded whole, a bigger one keeps what fits ahead with the storage warning and
  nothing pinned (grandfathered fragments could not be let go of), 0 keeps nothing ahead (its
  hint says so, `options_general_rambudget_zero_nodisk`), and an empty field is no limit, all
  in RAM, as with the disk. Kept beyond the budget, the far end was let go of and fetched again
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
  of 0): "plays normally" would not hold, and the options page warns about that 0. Before, one message, "does not fit in the predownload
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
0, empty, a private window); `options-fields.e2e.mjs` (the switch is saved, the 0 hint follows it); `private-browsing.e2e.mjs` (the player's store is memory-only and holds the video);
`MemoryBudget.test.mjs`; `opfsStorage.test.mjs` (deferred saves, spill, `memoryOnly`, an old
write racing a new save); `DownloadEntry.test.mjs`, `DownloadManager.test.mjs` (lost data).

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
  in the event page survives 25 s with nothing else happening.
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
  files; the OPFS prune (`opfs-worker.mjs`, 60 s heartbeat) leaves a directory alone while its
  `_kept.json` says it is kept, at most 1 h. Off: the player hands nothing over and the reset
  deletes its files at once. `BufferKeep.test.mjs`, `opfsStorage.test.mjs`.
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
- **A new signed link** (vidmoly: `?t=&s=` new at every load): `LinkSignature.signatureParams` names
  the query parameters whose values differ between the old and the new source link, and a request
  under the new link finds the file with those left out (`DownloadManager.stored`, an alias: the
  entry's data stays under its old store id, `entry.blobId`). Parameters that did not change still
  tell files apart. FreshLink uses the same (`DownloadManager.relink`): a refused link's fresh one
  no longer downloads everything again. (FreshLink gives no link in a private window or a
  container tab since 2026-11-13: "Storage in a private window".)
- **Downloading the video again** (the owner, 2026-11-22): a reload to mend a load that went wrong
  keeps what it downloaded, broken parts too. A buffer taken back says so for 10 s, with its size
  (`player_buffer_reused`, status level `REUSED`; `DownloadManager.adopt` counts the bytes of RAM
  and disk); a click on it, or the more menu's button (`redownload`, any stream from the network),
  runs `FastStreamClient.downloadAgain`: the same source again at the current second, quality and
  audio track kept, playing if it played, without `keepStorage`, so the reset deletes everything
  downloaded, in RAM and on the disk. `FastStreamClient.test.mjs` ("downloading the video again",
  "a buffer taken back").

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
