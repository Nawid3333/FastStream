# Network layer and storage

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Network layer: fetch() + OPFS (2026-09-10)

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

## Storage in a private window (2026-09-17)

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
  this reason, and `mp4merger.mjs`'s `finalize()` falls back to Blob
  accumulation if its OPFS writes throw.
- **A download's `blob:` URL must outlive the download** (2026-10-01).
  `downloads.download()` resolves before Firefox has read the URL: revoked at once, 8 of
  60 small downloads were interrupted (`CRASH`) with no file and no message - a subtitle
  saved from the menu, the end of a StreamSaver save. Pass what `Utils.downloadURL`
  resolved with to `Utils.revokeWhenDownloaded(url, download)`, which revokes once
  `downloads.onChanged` says the download is over (a minute without an id). A link click
  (`<a download>`) reads the blob at once: 40 of 40 survived a revoke right after it.
  `ext-specs/download-blob-lifetime.e2e.mjs`; found through download-names' CI flake, whose
  test page closed with its blob before Firefox read it.
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
ArrayBuffer` rejects it — that is why `ext-specs/vad.e2e.mjs` (ORT) cannot
move into this suite, and why an ORT `TypeError: Unexpected argument[0]:
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

Deliberately left alone: `FastStreamClient.updateHasDownloadSpace()` still
refuses to predownload a whole video in a private session
(`player_buffer_incognito_warning`) and caps buffering to the configured
window. With a disk-backed Cache backend the original RAM rationale is
weaker, but not writing an entire video to disk during a private session is
a defensible privacy stance, and changing it is a behaviour change rather
than a fix. (2026-10-09: a private window now keeps nothing on disk at all, and its
buffering is bounded by the RAM budget as well as by this window.)

## RAM first, a budget, and private windows in RAM only (2026-10-09)

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

**Tests.** `ram-budget.e2e.mjs` (a two-minute stream that fits stays in RAM, no file written;
with a 2 MB budget 64 fragments went to disk, 2.9 MB stayed, and the start played again from
disk); `private-browsing.e2e.mjs` (the player's store is memory-only and holds the video);
`MemoryBudget.test.mjs`; `opfsStorage.test.mjs` (deferred saves, spill, `memoryOnly`, an old
write racing a new save); `DownloadEntry.test.mjs`, `DownloadManager.test.mjs` (lost data).

## What goes to the disk, measured (2026-10-09)

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
