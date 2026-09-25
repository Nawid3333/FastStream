# FastStream — working notes

Fork of [Andrews54757/FastStream](https://github.com/Andrews54757/FastStream),
branched from `d5fe931` (V1.3.77).

**LICENSING — read this before publishing anything.** The upstream
`LICENSE.md` is **not** GPL and grants **no redistribution right**: it is
"All rights reserved. You must receive permission before using my code."
The `GPL-3.0-or-later` claim that used to sit in this file was wrong; the
upstream repo carries no LICENSE file granting GPL, and `package.json` in the
fork deliberately declares **no** `license` field for exactly this reason.
Practical consequence: this fork is a derivative of proprietary code made
without Andrew's written permission. Fixing that (getting permission or
rewriting) is a **hard prerequisite for any listed AMO submission** — AMO
reviewers check add-on license claims, and "I assert GPL over someone
else's all-rights-reserved code" does not survive that.

Goal: a Firefox-only extension (Chrome was dropped on 2026-09-20 — see
"Chromium was dropped" below) with a modern, testable dev workflow, and
upstream merges that stay as painless as a fork can make them.

## Keybinds

The pure logic is in `chrome/player/options/KeybindUtils.mjs` (no DOM, so Node can test it);
`KeybindManager.mjs` and the options page use it.

- **Percent seeks**: `SeekPercent10..90` on `Digit1..Digit9`. A live stream reports an infinite
  duration, which the `currentTime` setter throws on, so `seekPercentTarget` returns null for it.
- **mpv seeks** (layout version 3, from Nawid's mpv `input.conf`): `SeekBackward60s/SeekForward60s`
  on `Z/X`, `SeekBackward10s/SeekForward10s` on `J/K` (`FIXED_SEEKS`), the arrows 5 s (the
  `seekStepSize` default went 2 -> 5, and a saved 2 is moved to 5 once). Undo seek moved to
  `Shift+Backspace` (mpv's revert-seek) and Screenshot to `Shift+S` (mpv's video-only
  screenshot). `SeekForwardLarge/SeekBackwardLarge` (10 s on `,`/`.`, a duplicate of J/K) were
  removed; the skip buttons seek a fixed `SKIP_BUTTON_SECONDS` (10), no longer 5 x the step, so
  they did not become 25 s. None of these hops is saved for undo, like the arrows, and a hop
  back is clamped at 0: the `currentTime` setter hands its value to `state.currentTime` and
  the separate audio track unclamped. `keyboard.png` on the welcome page predates version 2
  and is out of date; the text list above it is current.
- **Frame step** (`,`/`.`, moved from Shift+arrows in version 3): mpv's frame-step, pause then
  exactly one frame. `ui/FrameStepper.mjs` learns the frame length from
  `requestVideoFrameCallback` during playback. Measured on Firefox 156: a playback frame's
  `mediaTime` is its own start, but while paused it is the position seeked to (anywhere inside
  the frame), and so is the frame shown again when playback starts. So only gaps between two
  consecutive playback frames count (the frame after a seeking/play/pause event is skipped),
  the shortest such gap is the length (drops at high speed only lengthen gaps), and the step
  works out the frame on screen from `currentTime` on the grid a playback frame anchors
  (`mediaTime` is rounded to whole microseconds, so `currentTime` on the anchor frame can
  read just below the anchor; a 10 us tolerance keeps it in that frame - Windows CI hit
  0.4176667 vs 0.417667 and stepped onto the frame it was on). Before
  any playback the length is the old 1/30 s. The usual use is play, pause, then step, which is
  what `tests/e2e/specs/keybinds.e2e.mjs` checks on `fixtures/frames-24fps.mp4` (96 frames,
  ffmpeg `testsrc2` at 24 fps, libopenh264), by the picture itself, not only the time.
- **mpv-style speed presets** (a port of `speed-presets.lua`): `SpeedPreset1/2/2_5/3/3_5/4/5/8/16` on
  `R G B Q W A Y E H`. A press sets the speed; the same key again reverts to the speed active
  before it (per-key memory, fallback 1x; `applySpeedPreset`). One deliberate difference from
  the lua: a remembered speed equal to the preset itself falls back to 1x, so the key never goes
  dead. The target is clamped to `options.maxPlaybackRate`, which is 8, so the 16x key gives
  8x, the same as the 8x key. 8 is where Firefox stops playing audio: measured on Firefox 156,
  a tone is at full level at 8x and silent at 10x and 16x, while the picture still runs at the
  requested pace. `tests/e2e/specs/firefox.e2e.mjs` pins it, so a Firefox that plays faster audio
  shows up as a failure and the cap can move.
- Six defaults moved to `Shift+<letter>` for those letters: WindowedFullscreen, NextChapter,
  PreviousVideo, FlipVideo, RotateVideo, ToggleVisualFilters.
- **Typing is not a command.** `KeybindManager.onKeyDown` ignores a press whose target is a text
  field, text area, select or editable element, unless Ctrl, Alt or Meta is held (Right Alt hides
  the player). Ranges, checkboxes and buttons still pass keys through.
- **Layout version.** `mergeOptions` only fills missing keys, so nothing in saved options said
  which layout they were written for. Options now carry `keybindsVersion` (`KEYBINDS_VERSION`
  in KeybindUtils). `Utils.getOptionsFromStorage()` reads the saved options, merges the
  defaults over them, and runs `migrateKeybinds(options, stored)`, once per saved options: a
  saved binding that still holds an old plain-letter default is moved, and a new action takes
  its default key only when nothing else uses it (otherwise it is left `None`). A user's own
  binding is never overridden, so one press never fires two actions after a migration. A choice
  made afterwards, even one equal to an old default, is kept, because the saved version stops
  the migration. Options that were never saved need nothing. Imported settings files go through
  the same migration. When a default moves again, add an entry to `MIGRATIONS` in KeybindUtils
  (the moved actions with their old key, the new actions) and bump `KEYBINDS_VERSION`; each
  entry newer than the saved version runs in turn, so version 1 options go through all of them.
- **`getOptionsFromStorage` is async.** It once passed the unresolved promise straight to the
  migration, which skipped it silently, so the migration never ran in the extension; the unit
  tests fed plain objects and passed. `tests/unit/Keybinds.test.mjs` now goes through
  `getOptionsFromStorage` with a stubbed `getConfig`.
- **Options page shows nothing before the saved options are read.** `OptionsStore.get()` returns
  the defaults until `init()` has read storage, and the page's visibility refresh
  (IntersectionObserver) used to call `loadOptions` with that, so a slow start drew the default
  keybinds for a moment, and a change made then would have saved the defaults over the user's
  options. The refresh now waits for `init()` (`optionsLoaded`). Found as a flaky failure of
  `keybinds-storage.e2e.mjs` under the full `verify` load; reproduced every time with a 1.5 s
  delay injected into `OptionsStore.init()`, and passing with the guard.
- **Options page menu.** Rows are named by `keybindLabel` ("Seek to 50%", "Speed preset 2.5x"),
  and a row whose key another action shares is marked with a warning naming the other action
  (`conflictPartners`; nothing stops the choice, the user may be mid-rearrangement).
- Locale keys `welcome_page_keybinds_content10` and `content11` exist in all 16 locales.
  **Gotcha:** `en/messages.json` carries 7 keys that are not in `combined-locales.json`
  (`extension_toggle_label_mpv`, `options_general_buffer*`, `options_general_blockpopups`,
  `player_mpv_content_*`), so `localescript.mjs --split` without a whitelist deletes them from
  en. Both files are formatted with a 4-space indent; keep it, or a one-key change shows up as
  thousands of changed lines.
- Tests: `tests/unit/KeybindUtils.test.mjs` (the pure functions), `tests/unit/Keybinds.test.mjs`
  (the default layout has no clashes and every default has a handler, the storage path, the
  welcome page and locales), `tests/e2e/specs/keybinds.e2e.mjs` (presses in the running player,
  the migration on a legacy profile, the text-field guard) and `keybinds-menu.e2e.mjs` (the
  options page). Not covered: a saved profile in the real extension's `chrome.storage`.

## Reading big generated files

`.claude/settings.json` denies the Read tool on `pnpm-lock.yaml`, `node_modules/`,
`combined-locales.json`, the vendored libraries under `chrome/player/modules/` (generated from npm
by the build and gitignored), source maps and build output. `.ignore` keeps the committed ones out
of Grep and Glob results. `.claudeignore` repeats the list, but Claude Code does not read a file
with that name (checked against 2.1.278); the two above are what work. The rules load when a
session starts, so an already-open session keeps reading them.

When one of those files has to be consulted, do not read it whole: run `grep -n` or `sed -n`
through Bash, or have the ollama helper (`glm-5.3-flash:cloud`, through its HTTP API) pull out the
lines that matter, and check what it reports against the source.

## Commands

```bash
pnpm install              # pnpm 11, pinned via packageManager
pnpm run build            # 4 targets -> built/*.zip, unpacked dirs deleted
pnpm run build:keep       # same, but keeps build_*/ for web-ext
pnpm run lint             # eslint (must stay at 0), plus eslint.modules.config.js:
                          # undefined/unused names in chrome/player/modules, which the main
                          # config skips entirely (first-party code lives there next to vendored libs)
pnpm run lint:amo         # web-ext lint on build_firefox_amo (--self-hosted)
pnpm run start:ff         # web-ext run — launches Firefox with the extension
pnpm test                 # vitest
pnpm run test:ext         # installed extension, ordinary windows
pnpm run test:ext:github  # the same, against the GitHub self-host build
pnpm run test:pbm         # installed extension, private windows
```

`build:keep` must run before any `lint:amo` or `start:ff` — those need an
unpacked directory, and a plain build leaves only zips.

## Manual playback testing

```bash
pnpm run profile:setup   # once: builds .dev-profile with uBlock Origin
pnpm run build:keep
pnpm run start:ff        # persistent profile, uBO enabled
pnpm run start:ff:clean  # throwaway profile, FastStream only
```

The dev profile exists because real streaming sites are dense with ads and
overlay players, which makes "FastStream failed to replace the player"
indistinguishable from "an ad iframe got in the way". `.dev-profile/` is
gitignored.

**How FastStream picks up a stream URL.** `background.mjs:913`
`setupRedirectRule` installs a declarativeNetRequest rule matching
`^.+\.(m3u8|mpd)([?#].*)?$` on `main_frame` and redirects to the player with
the URL in the hash. So pasting a manifest URL into the address bar opens it
in FastStream — **but only when the matching option is on, and both default
to `false`** (`DefaultOptions.mjs:13-14`):

- `playMP4URLs` → rule 1, `.mp4`
- `playStreamURLs` → rule 2, `.m3u8` and `.mpd`

Enable them in the extension's options page before testing by URL. Without
them, use a page that embeds the stream and click the FastStream toolbar
icon instead.

### The playback checklist

**This is the reference baseline. Re-run it after every change to the player,
the loaders or the vendored libraries.** Confirmed working on upstream
`d5fe931` + the tooling commits, firefox-github build, 2026-09-02:

| Format | Page | Status |
|---|---|---|
| DASH | `https://reference.dashif.org/dash.js/v4.4.0/samples/getting-started/auto-load-single-video-src.html` | works |
| HLS | `https://tracylocalschool.com/gquzbcolcgom` | works |
| MP4 | `https://video.nie.edu.sg/media/Sample-Video-File-For-Testing.mp4/0_9311zvk2/22238` | works |

These are **pages that embed a stream**, so they exercise the content-script
detection path — the one real users hit. That is the more valuable test than
a pasted manifest URL, which only exercises the declarativeNetRequest
redirect.

Direct manifests for testing the redirect path instead (all verified
`200 application/dash+xml`), which need `playStreamURLs` enabled first:

- `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` (DASH-IF reference vector)
- `https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd`

Real sites serving DASH: Bilibili (has a dedicated content script at
`chrome/custom/bilibili_content.js`), and most large video platforms.

**YouTube support was removed entirely** (all targets, not just AMO) —
`YTPlayer`, the sandboxed evaluator, `yt.mjs`, `googlevideo.mjs`,
`yt_runner.js` and `custom/yt_content.js` are gone, along with the
`userScripts` permission and every `PlayerModes.ACCELERATED_YT` branch. See
"YouTube removal" below.

## Architecture facts that are easy to get wrong

- **Already Manifest V3.** `chrome/manifest.json` is `manifest_version: 3`
  with a `service_worker`. `build.mjs` rewrites that to `background.scripts`
  (a non-persistent event page) for Firefox. There is no MV2 migration to do.
- **Nothing is bundled.** The browser loads all 166 `.mjs` files natively as
  ES modules. `build.mjs` is a file-copier plus a conditional-compilation
  preprocessor — not a bundler. Introducing whole-tree bundling is a
  behaviour change, not a refactor.
- **The hls.js/dash.js hooks are already the official public APIs.**
  `HLSPlayer.mjs:68` passes `loader: HLSLoaderFactory(this)` (hls.js's
  documented config option) and `DashPlayer.mjs:153` calls
  `dash.extend('XHRLoader', DASHLoaderFactory(this), false)` (dash.js's
  public extension point). The AMO problem is that the vendored *bytes*
  aren't an official release — not that the integration is hacked.
- **Vendored library versions are current**, not stale: dash.js reports
  `VERSION = '5.1.0'`, hls.js carries 1.6.x branches.

## Network layer: fetch() + OPFS (2026-09-10)

`chrome/player/network/XHRLoader.mjs` — the single loader shared by HLS,
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
`tests/unit/XHRLoader.test.mjs` (the file had zero coverage before).

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
  fragment in memory.
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
- `OPFSManager.isSupported()` additionally refuses up front when
  `EnvUtils.isFirefox() && EnvUtils.isIncognito()`, purely to avoid spawning
  a worker and logging a `SecurityError` per player open. It is not the
  safety net — the runtime fall-through is, and it has to be, because the
  web build has no `chrome.extension` to read `inIncognitoContext` from and
  still reaches OPFS in a private window.

`tests/e2e/wdio.pbm.conf.mjs` + `tests/e2e/pbm-specs/` (`pnpm run
test:pbm`) cover this: a permanently private session
(`browser.privatebrowsing.autostart`) with the add-on's private-browsing
permission granted through `ExtensionPermissions` in the `before` hook,
asserting the blob backend is neither `memory` nor `opfs`, that
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
instead of asking. Both now skip the prompt only when
`isChrome() && isIncognito()`.

Deliberately left alone: `FastStreamClient.updateHasDownloadSpace()` still
refuses to predownload a whole video in a private session
(`player_buffer_incognito_warning`) and caps buffering to the configured
window. With a disk-backed Cache backend the original RAM rationale is
weaker, but not writing an entire video to disk during a private session is
a defensible privacy stance, and changing it is a behaviour change rather
than a fix.

## MPV mode and the native host

Feature branch `Mpv-feature`. Allowlisted sites hand their detected stream to
mpv on the user's machine instead of the in-page player, over native
messaging to `com.faststream.mpv`.

**The host in `native-host/` is not part of the extension build.** It is a
separate Node script the user installs with `native-host/install.ps1`, which
copies it to `%LOCALAPPDATA%\FastStreamMpvHost`, writes a `.bat` wrapper (the
browser runs the manifest `path` directly and cannot execute a `.mjs`), and
registers the host under `HKCU\Software\Mozilla\NativeMessagingHosts`.
Editing `native-host/faststream-mpv-host.mjs` in the repo changes nothing
until it is copied to the install directory — a rebuild does **not** ship it.

Four things here are counter-intuitive enough that each shipped broken once:

- **A child of the host does not survive the browser.** Firefox runs a native
  messaging host inside a job object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; every descendant joins that job, and
  when the host exits after replying, Windows kills them all. `detached: true`
  and `unref()` do not escape a job, and neither does `cmd /c start`. mpv is
  therefore created by the **WMI** service (`Win32_Process.Create`), which
  parents it to `WmiPrvSE`, outside the job. Do not "simplify" this back to a
  plain spawn.
- **A WMI-created process cannot take the foreground**, so mpv's own
  `--focus-on=open` is silently refused and the window opens behind the
  browser. The host grants the right and activates the window by attaching to
  the foreground thread's input queue, then re-reads `GetForegroundWindow` to
  confirm rather than trusting the call's return value.
- **Request headers must be read before the first `await`.** In
  `onSourceRecieved`, `deleteHeaderCache` is a second `onHeadersReceived`
  listener and runs the moment the function yields, so a header read placed
  after an `await` always returns `undefined`. This silently breaks the
  ordinary in-page player too, not just mpv.
- **`VideoSource` blacklists `user-agent`**, so the player's "send to mpv"
  button physically cannot forward it and the background restores
  `navigator.userAgent` on arrival. Without it mpv identifies itself to CDNs
  as `libmpv` and gets refused.

**Tab state has to outlive the event page (2026-09-24).** Firefox unloads the
background after ~30 idle seconds, and every `TabHolder` goes with it. A reload
then woke a fresh background with no record of the user's toolbar choice, so an
allowlisted site auto-started MPV again even after the user had picked the
in-page player or Off. The same loss dropped the one-hand-off-per-page latch,
so the page's next stream request after a wake opened a second mpv window.
`TabTracker.saveTabState` now writes `url`, `isOn`, `isMpv`, `regexMatched`,
`mpvMatched` and `mpvAutoOpened` per tab to `chrome.storage.session` whenever
one of them changes (toolbar click, URL change, mpv hand-off and its failure),
and `restoreTabStates` puts them back inside `ensureOptions()`, which every
state-changing listener already awaits. A new field that has to survive a wake
goes into `PersistedTabFields`, and every place that sets it saves. Within one
background lifetime the old in-memory logic was already right, so a test that
never suspends the background cannot see this.
`tests/e2e/classic-specs/` (`toolbar-state`, `mpv-suspend`, `toolbar-cycle-mpv`)
click the toolbar and suspend the background from Firefox's chrome context,
which needs WebDriver classic, hence its own `wdio.classic.conf.mjs` (run by
`test:ext`).

**Toolbar cycle on an allowlisted site: MPV → Off → On → MPV (2026-09-24,
reordered from MPV → On → Off).** A click on the glowing purple icon now
turns FastStream off outright, matching "a click stops it" everywhere else in
the toolbar, instead of falling back to the in-page player first. This added
a transition that never existed before: On -> MPV by a toolbar click (the old
cycle could only reach MPV via Off). There is no message that retracts an
in-page overlay iframe, so that transition reloads the tab - same as the
plain Off/On toggle already does to undo one - and leans on the ordinary
auto-forward path (`onSourceRecieved`) to hand the reload's freshly detected
stream to mpv; it does not call `openMpvWithSources` itself. The three
`onClicked` branches check `frame.playerOpening || frame.isPlayer`, not just
`isPlayer`: `playerOpening` flips true the moment `OPEN_PLAYER` is sent, well
before the player's own `PLAYER_LOADED` round trip sets `isPlayer`, and
checking `isPlayer` alone leaves a window where a click lands after the
overlay iframe already exists on the page but before the background has
heard about it - for On -> MPV specifically this means both an in-page
overlay and an mpv window are left running the same stream at once, not just
a stale overlay. `toolbar-cycle-mpv.e2e.mjs` drives real mpv through all
three transitions and checks the actual effect at each one (the overlay
iframe's presence in the page, not just the toolbar badge): MPV -> Off raises
no second mpv request, Off -> On swaps in the overlay from already-tracked
sources with no new network request, and On -> MPV tears the overlay down and
gets a fresh request to mpv purely from the reload. Its test page cache-busts
the reload's video URL - the same fix `mpv-suspend.e2e.mjs` needed - since a
repeat request for the identical URL can be satisfied out of Firefox's HTTP
cache with no network traffic, which would leave nothing for `onHeadersReceived`
to redetect.

Single-instance reuse goes over mpv's JSON IPC on a named pipe. Only
instances this host starts are given `--input-ipc-server`, which is what
stops it ever loading into — or closing — an mpv the user opened themselves.
A stale pipe simply fails to connect and a fresh instance starts.

**Anime/movie content-type hint (2026-09-12).** `open` messages always
carry `contentType: 'anime'|'movie'` — never omitted — resolved by
`background.mjs`'s `resolveMpvContentType(explicit, url)`: the player's
manual override if set (`SaveManager.mjs`'s `mpvContentType`, right-click
the mpv button to cycle Auto → Anime → Movie; resets to Auto on every new
source via `FastStreamClient.resetPlayer`), else the MPV Allowlist's
trailing `@anime`/`@movie` tag (`UrlMatchList.mjs`'s `getContentType`), else
**`'movie'`**. Movie is the deliberate default — this user's allowlist is
mostly movie sites, so only the anime ones need tagging; `@movie` is still
accepted but never required. Only the manual override is available on the
button-click path — the two webRequest/DNR auto-forward paths
(`onSourceRecieved`, `openMpvWithSources`) never load the player, so they
only ever see the allowlist tag (or the movie default).
`faststream-mpv-host.mjs`'s `withContentTypeFragment` appends it to the
stream URL as `#fs-content=anime`/`#fs-content=movie` before either launch
path (`launchMpv`'s spawn args, `loadIntoExisting`'s `loadfile` command) —
a URL fragment, so it never reaches the CDN and cannot break a signed URL.
An mpv-side script reads that marker back off the `path` property as its
*sole* signal (`fs-content=anime` present → anime, else movie) — an earlier
version also fell back to an `anime`-named folder in the path, but that
never matched anything for a streamed URL and was deleted the same day the
`resolveMpvContentType` default-to-movie behavior above was added, per this
user's request, rather than kept as dead/misleading code. Covered by
`tests/unit/{UrlMatchList,MpvBackend,MpvNativeHost}.test.mjs`.

**Resume key (`pageUrl` → `fs-id=`).** All three `Mpv.openStream` call sites
pass the tab's page URL as a 5th argument; `MpvBackend` relays it (http(s)
only) and the host's `mpvTargetUrl` appends `fs-id=<first 16 hex of
sha256(pageUrl)>` after the `fs-content=` tag. The mpv config's
`stream-resume.lua` saves the playback position under that key. The stream
URL cannot be the key: CDN tokens change it on every visit. Hashed so the
page address never appears in mpv's path or state file. A host without this
change simply sends no `fs-id`, and mpv then does not resume.

**Debugging.** Add `"debug": true` to
`%LOCALAPPDATA%\FastStreamMpvHost\config.json` (no reinstall needed, the host
reads it per message) and it appends JSONL to `faststream-mpv-host.log` next
to the script: every message received, the exact mpv argv, the WMI pid, and
whether focus took. It never writes to stdout, which carries the framed
native messages. That log is what found the header loss and the job object;
reach for it before theorising.

**Testing.** `tests/e2e/ext-specs/mpv.e2e.mjs` drives the real chain —
allowlisted page, webRequest detection, native host, mpv, HTTP request —
against two local origins, because a same-origin media request carries no
`Origin` header. It skips rather than fails when the host is not installed.
The host itself is covered by no suite; verify it by driving
`com.faststream.mpv.bat` with a length-prefixed message, and by checking
survival inside a real kill-on-close job object.

## The SPLICER preprocessor

`build.mjs` strips or injects code per build target using comment directives:

```js
// SPLICER:<TARGET>:REMOVE_LINE      drop this line
// SPLICER:<TARGET>:REMOVE_START     drop everything until REMOVE_END
// SPLICER:<TARGET>:REMOVE_END
// SPLICER:<TARGET>:REMOVE_FILE      drop the whole file
// SPLICER:<TARGET>:INSERT_LOCALE    inline all _locales messages
// SPLICER:<TARGET>:INSERT_VERSION   inline the package.json version
```

**It only processes `.mjs` and `.js`.** Move code into a `.ts` file and it
silently stops being spliced — no error, wrong code ships. Stay on `.mjs`
plus JSDoc.

Targets: `EXTENSION`, `FIREFOX`, `WEB`, `NO_PROMO`, `NO_UPDATE_CHECKER`.
(`CENSORYT` and `NO_YOUTUBE` existed before YouTube support was removed
entirely — see "YouTube removal" below — and no longer apply to anything.)

## Build targets

**Firefox only (decided 2026-09-11).** Nawid only uses this fork on Firefox;
`buildChromeGithub()`/`buildChromeWebstore()` and the `chrome-github`/
`chrome-webstore` targets were removed from `build.mjs`, the release
workflow's asset list, and the comments around CI's Chromium E2E step.
**Chromium was dropped altogether on 2026-09-20:** that step, `wdio.chromium.conf.mjs`, the
`test:e2e:chromium` and `test:e2e:all` scripts, the `chromedriver` dependency, the Chrome and
Safari branches of the code (`EnvUtils.isChrome/isFirefox/isSafari` are gone), Chromium's
`details.initiator` handling in the background script (Firefox does not send that field, so it
never ran here; measured), and the Chrome-family registration in the mpv host installer.
`chromeSourceDir` (`chrome/`) keeps its name because upstream's tree does, and the sync bot merges
upstream into it. `chrome/manifest.json` is Firefox's own: an event page, no Chrome-only keys, and
the `downloads` and `cookies` permissions the builds used to add. The built manifests are
byte-identical to what the old transformations produced. The plain `web` target stays: the web
e2e suite runs against it, in Firefox.

| Target | Splices | Notes |
|---|---|---|
| `firefox-github` | EXTENSION, FIREFOX, NO_PROMO | manual install |
| `firefox-amo` | EXTENSION, FIREFOX, NO_UPDATE_CHECKER | AMO target; min version 142, declares data_collection_permissions |
| `web` | WEB, NO_UPDATE_CHECKER | faststream.online, no extension APIs |

`buildFirefoxAmo()` was written but never invoked (commit "Remove firefox
dist build for now"). Re-enabled in `7ed4723`.

The 12 `EnvUtils.isChrome()`/`isFirefox()` branches elsewhere in the
codebase (playback-rate caps, the 7.1-audio workaround, OPFS backend
selection, SponsorBlock's extension ID) were deliberately left in place —
narrow, self-contained, and not worth the risk of touching working
audio/playback logic for a small cleanup win.

## Releasing (auto-release.yml, added 2026-09-12)

Every push to `main` that passes CI now gets released
automatically — no separate "ship it" step. `auto-release.yml` waits for
CI to go green on that branch (`workflow_run`, not `push` directly — a
red push is never released), then bumps just the trailing build number
(`1.3.82.0` -> `1.3.82.1` -> ...), commits `chore: release <version>`,
tags it, and pushes both, then explicitly runs `gh workflow run
release.yml --ref v<version>` to do the actual build/sign/publish.
That last step has to be explicit: the tag push is authenticated with the
default `GITHUB_TOKEN`, and GitHub deliberately does not let a
`GITHUB_TOKEN`-authenticated push fire other workflows' `push` triggers
(anti-recursion protection) — confirmed the hard way when `v1.3.82.1`'s
tag landed with no Release run behind it, before this dispatch step
existed.

The bump commit is itself a push to the branch, which reruns CI, which
would re-trigger `auto-release.yml` — the workflow's `if:` skips any
`workflow_run` whose head commit message starts with `chore: release `,
which is what stops that loop rather than looping forever.

`tools/cut-release.mjs` (`pnpm run release <version>`) still exists for a
deliberate version bump — a real minor/patch for a milestone rather than
the next build number. Run it by hand right before the push you want that
version on; auto-release's next build-number bump continues from whatever
version that leaves in `package.json`.

**AMO signing no longer depends on a timer.** AMO has no webhook for "signed" (its API
documents none), so `tools/sign-amo.mjs` uploads and polls, waiting up to 30 minutes
(`approvalTimeout`). Measured over 30 releases: 2-6 minutes, once 15. When the wait runs
out, the release is published without the xpi and `updates.json` (the sign step is
`continue-on-error`), and **`amo-signing-failsafe.yml`** completes it: every 3 hours it
checks the latest release and, if incomplete, builds that tag and asks AMO for the version
(`tools/fetch-amo-signed.mjs`, no upload): signed -> download (byte-identical to web-ext's
file, checked on 1.3.82.27; the regenerated `updates.json` matched the published one
exactly) and attach both; pending -> next run; missing (never uploaded) -> sign now;
rejected, or still incomplete after 24 h -> one issue, assigned + @mention, closed when the
release is complete. Re-running `web-ext sign` cannot do this: AMO refuses a second upload
of a version. v1.3.79.0 and v1.3.82.2, the two releases without an xpi, are both `public`
on AMO - the failsafe would have collected them. `release.yml`'s `timeout-minutes: 45`
covers the 30-minute wait.

## Workflows (reworked 2026-09-25)

- **`ci.yml`** runs what `pnpm run verify` runs (including `test:pbm` and `verify:ort`),
  plus a `workflows` job: actionlint with its bundled shellcheck over every workflow.
- **`auto-release.yml`** only acts on a CI run that was a `push` to this repository's
  `main`. Before, `branches: [main]` matched a fork PR's branch named `main` too, and the
  job would have checked out that commit with a write token, pushed it and released it.
- **`release.yml`** checks the tag against `package.json` and `chrome/manifest.json` before
  building, and runs lint + unit tests (a hand-cut tag reaches it without CI).
- **`amo-signing-failsafe.yml`** (every 3 h) completes a release whose AMO signing did not
  finish in `release.yml`; see "AMO signing no longer depends on a timer" above.
- **`toolchain-updates.yml`** (weekly) + `tools/check-toolchain.mjs`: one issue for a newer
  Node LTS than CI/`.nvmrc` use, and one for a newer pnpm major once
  dependabot-core#15904 is fixed (pnpm 12's two-document lockfile hides every dependency
  from GitHub's dependency graph; 12.6.0 otherwise passed the full verify on 2026-09-25).
  A newer version supersedes and closes the older issue; moving closes it. Same-major
  releases are not reported. Dependencies stay pinned by the lockfile on purpose (patches,
  AMO reproducibility); Dependabot's weekly grouped PR is how they move.
- **`firefox-beta.yml`** (Monday and Thursday, and on PRs touching it or the e2e configs): `test:e2e` and
  `test:ext` against Firefox Beta (`browser-actions/setup-firefox`, `latest-beta`) through
  the `FIREFOX_BINARY` env var the wdio configs honour. A scheduled failure opens one issue
  naming the Beta version - about two weeks before that Firefox reaches users (two-week
  release cycle since Firefox 155, September 2026) - and the
  next green run closes it. Not part of CI; it never blocks a release.
- **`firefox-stable.yml`** (daily): reads the current stable version from
  product-details.mozilla.org (Mozilla sends no notification) and, once per version, runs
  `test:e2e` + `test:ext` against exactly that version; a green run records it as an Actions
  cache key `firefox-stable-tested-<version>`, so later days skip it (a manual run always
  tests). A failure opens one issue per version; a green run closes it. Read release dates
  from that file rather than computing them - it said 157 is due 2026-10-09, not the
  2026-09-29 two-week arithmetic from 155 suggested.
- **`runner-images.yml`** (daily, 2026-09-25; the same file is in every repo of the owner
  except mpv and KytyPS5): reads the actions/runner-images README for the image behind
  `ubuntu-latest`/`windows-latest` and the newest GA one, and calls `ci.yml` (which takes
  `linux-runner`/`windows-runner` inputs for this) once on the newest image when it is
  newer than `-latest` - a warning before GitHub switches, as `ubuntu-latest` does to 26.04
  in November 2026 - and once more when `-latest` moves. Green runs are recorded as cache
  keys `runner-image-{next,latest}-<images>`; a failure opens one issue per image, closed by
  the next green run. A called CI run is not a "CI" run, so it never releases. Never put a
  `schedule:` in `ci.yml`: GitHub disables a public repo's scheduled workflows after 60 days
  without a commit, and it disables the whole file, push trigger included.
- **Windows e2e** (2026-09-25): CI has an `e2e-windows` job (all four e2e suites on
  windows-latest) beside `verify`, and auto-release waits for the whole workflow, so a
  release ships only when Windows passes too. `firefox-beta.yml` and `firefox-stable.yml`
  run their e2e job on ubuntu-latest and windows-latest; the stable version is recorded
  as tested only when both pass (a separate `record` job). Windows Firefox decodes through
  Media Foundation where Linux uses ffmpeg, so playback can differ. Both CI jobs install
  the current stable Firefox (`browser-actions/setup-firefox`, `latest`) instead of the
  image's (Windows had 155.0.1 when 156.0.1 was out). Windows gets ffmpeg from
  Chocolatey for the fixtures. Do not call `firefox.exe --version` there: it does not
  print to a console on Windows. The first Windows runs exposed timing races in
  specs that had always won on fast machines, fixed in the specs: capabilities picked the
  last window handle (sometimes the http:// opener, where WebCodecs/AudioWorklet do not
  exist) - now found by URL; options-mpv clicked before the saved options loaded and read
  storage once - now waits for `data-options-loaded` on the options page's `<html>` and
  for storage to hold the change; sources-browser checked auto-hide once after 150 ms -
  now re-queues until hidden (mutation-checked: a never-hiding bar still fails).
  keybinds (frame step) and storage (OPFS) log where they were on a failure; save-fmp4
  logs each phase's time (ready, downloaded, saved) and the download state if it stalls.
  The Windows runner also exposed a real player bug: hiding a focused control sometimes
  moves focus to `<body>` with no `focusout` there (logged `{"focusouts":0,"flag":true}`;
  on a desktop it does fire, so it never reproduced locally), which left
  `InterfaceController.focusingControls` stuck true and the control bar up for good.
  `isFocusInControls()` now checks the flag against `document.activeElement`; the
  sources-browser spec forces the stale flag, so it fails without the fix on any machine.
  A second one: SweetAlert2 removes a closing dialog only on the popup's `animationend`,
  which on the runner once never fired, leaving an invisible `swal2-hide` popup over the
  save button. `AlertPolyfill` dialogs close without a hide animation (a `Dialog` mixin
  with empty `hideClass`, sweetalert2#1841); `specs/dialogs.e2e.mjs` makes the animation
  last an hour and fails without the fix. Failing save/storage specs log the page and
  every unanswered OPFS worker call (`specs/diagnostics.mjs`, `OPFSManager.pendingCalls()`).
- **e2e config, 2026-09-25:** `autoXvfb: false` - Firefox runs `-headless`, and WebdriverIO
  otherwise spawns workers through `xvfb-run`, whose Ubuntu 26.04 version closes fd 3, the
  worker IPC channel: every worker died with `write EINVAL` (webdriverio#15685, unfixed in
  9.32.0; found by runner-images.yml before `ubuntu-latest` moves in November).
  `specFileRetries: 1` - a failed spec file runs once more in a fresh browser: after the two
  bugs above were fixed, 3 x 12 parallel Windows runs showed only rare timing-budget
  overruns (a 6 s streamSaver write, a 30 s player start) with nothing pending. A real bug
  fails twice and still blocks the release.
- **Every action is pinned to a commit SHA** with the exact version as a comment (and the
  actionlint image by digest); Dependabot bumps them, minor/patch grouped weekly. Checked
  against `git ls-remote` when pinned; `dependency-review-action`'s `v5` is a branch.
- **No CVE watch for the vendored components outside the lockfile** (vtt.js, knob,
  libsamplerate, StreamSaver, the native ONNX Runtime wasm): measured 2026-09-25, OSV has
  never recorded a vulnerability for any of them, so a workflow could never fire. They are
  covered by the provenance checks instead. The lockfile-backed libraries are covered by
  Dependabot alerts (OSV's only hls.js record, MAL-2026-3019, is two canary builds, not 1.7.3).
- **`reminders.yml`** (1st of each month) comments with an @mention on every open issue
  labelled `reminder: <month>`, so a parked issue emails its owner in that month.
- **`dependency-review.yml`** fails a PR that adds a package with a high-severity advisory.
- **`build.yml` was removed**: CI already builds and uploads the same zips.
- **`sync-upstream.yml`** runs daily (06:00 UTC) and on every push to `main`. The PR is
  assigned to the owner and @mentions them (a bot PR alone is not emailed); a comment
  with the mention follows only when upstream itself moved. Upstream release tags on the
  incoming commits are named in the title (tags fetched to `refs/upstream-tags/`, never
  `refs/tags/`). A push-triggered run only closes the PR once `main` holds every upstream
  commit; it never rebuilds it. The failure issue closes on the next clean run.
- **`patched-libraries.yml`** + `tools/check-patched-updates.mjs`: Dependabot ignores the
  seven libraries in `patchedDependencies` (a bump leaves the patch unapplied), so this
  opens one issue per new version (assigned, @mention), never twice, and closes it when
  the patch is cut against that version or newer. Closing one by hand skips that version.
  `tests/unit/checkPatchedUpdates.test.mjs` fails if Dependabot's ignore list and
  `patchedDependencies` drift apart.
- All of it was dry-run with a stub `gh` against the real upstream history (sync: adopted
  -> closed, push -> no rebuild, new release named, comment only on upstream movement;
  patched libraries: open once, no duplicates, close when caught up or unpatched).

## Rules

- **Never hand-edit `chrome/player/modules/*`** — vendored third-party code
  (dash.mjs 3.5 MB, hls.mjs 1.3 MB, yt.mjs 1.3 MB). Excluded from eslint and
  tsconfig; they stall the language server otherwise.
- **`build.mjs` rewrites `chrome/manifest.json` in place** on every run to
  sync the version from `package.json`. The tree is dirty after each build.
  Don't sweep it into an unrelated commit.
- `incognito: "split"` is deliberately deleted for Firefox builds — Gecko
  doesn't support split mode. Not a bug.
- **Private windows are their own platform.** Firefox will not run an
  extension in a private window until the user ticks "Run in Private
  Windows" in `about:addons` - there is no manifest key that asks for it,
  and a temporary install gets it no more automatically than a signed one.
  Before that tick the extension is genuinely inert there (its
  `web_accessible_resources` aren't even reachable: a private-window page
  loading the player URL gets "Access to moz-extension://... from script
  denied"), so "nothing happens in a private tab" is the expected state and
  not a bug to chase. After it, `tests/e2e/wdio.pbm.conf.mjs` is the suite
  that covers what actually runs there - see "Storage in a private window"
  below for the bug that hid behind this for months.
- Branches: `main` is the project and the only long-lived branch. It was
  `dev/mv3-modernization` until 2026-09-19, when that was merged into `main`
  and deleted. Upstream is never mirrored: `sync-upstream.yml` opens one PR
  from `sync/upstream` when Andrew has commits `main` lacks, and taking or
  skipping them is decided on that PR - close it to skip, merge it to take.
  `docs/upstream-sync-log.md` records what was decided and why. `pr/*`
  branches, if ever needed, get cut fresh off `upstream/main`.

## AMO lint (firefox-amo, current: 0 errors / 3 warnings, needs `--self-hosted`)

Verified 2026-09-24: both `firefox-amo` and `firefox-github` are **0 errors,
0 notices, 3 warnings**. (`firefox-github` had a 4th until 2026-09-24, see
below.)

The 3 warnings both targets share are all in vendored libraries: `vtt.mjs`
and `vad/ort.wasm.mjs` (`UNSAFE_VAR_ASSIGNMENT`), `dash.mjs`'s webpack
bootstrap eval (`DANGEROUS_EVAL`) — see `docs/amo-linter-warnings.md` for why
each is safe-left-alone. `firefox-github` used to add
`MISSING_DATA_COLLECTION_PERMISSIONS`; it now declares
`data_collection_permissions: {required: ['none']}` like `firefox-amo`, which
needed its `strict_min_version` raised from 136 to 142 (the key needs 140+,
Android 142+). The only versions that dropped, 136-139, were long out of
support and never ESR. Neither target has a `players/PlayerLoader.mjs` or
`yt_runner.js` hit anymore; both disappeared along with YouTube support.

**`pnpm run lint:amo` needs `--self-hosted`, or it reports a false
`MANIFEST_UPDATE_URL` error.** `browser_specific_settings.gecko.update_url`
(set in `build.mjs`'s `buildFirefoxAmo()` for this unlisted build's
self-hosted update checking) is exactly what that flag exists for — per
`web-ext lint --help`, `--self-hosted` "disables messages related to hosting
on addons.mozilla.org." Without it, addons-linter assumes every build is
headed for AMO's own hosting and flags `update_url` as disallowed there,
which is a real rule but doesn't apply to this build. The `package.json`
`lint:amo` script now passes it. **This was live-broken on the real
`dev/mv3-modernization` branch's CI** from the commit that added
`update_url` (2026-09-09) until this fix — confirmed via `gh run view` on
the failing runs, not assumed. An earlier claim in this project's history
that AMO lint was "0 errors" had actually been made from truncated command
output that never showed the error section at all.

## Vendored libraries

The in-tree hls.js is **1.6.9 with 466 lines of divergence across 22 hunks**
(1.3%), not a fork. Much of it has already landed upstream. See
[docs/vendored-libraries.md](docs/vendored-libraries.md) for the full hunk
classification and the recommended `pnpm patch` approach; the raw diff is
`docs/hls.js-1.6.9-faststream.patch`.

Do not try to replace these with wrapper classes — the extra demuxer exports
that `hls2mp4/transmuxer.mjs` needs have no public-API equivalent in any
hls.js release, including 1.7.1.

## The binary blobs are identifiable published artifacts

Not mystery blobs — every one has a known upstream, version and licence, so
they belong in the Phase 7 npm migration rather than being removed:

| File | What it is | npm |
|---|---|---|
| `vad/ort-wasm-simd-threaded.wasm` + `ort.wasm.mjs` | **ONNX Runtime Web v1.20.0**, Microsoft, MIT | `onnxruntime-web@1.20.0` |
| `vad/silero_vad_half.ort` | Silero VAD model, ORT format, MIT | published model |
| `reencoder/libsamplerate.wasm` + `.mjs` | `aolsenjazz/libsamplerate-js`, MIT | `@alexanderolsen/libsamplerate-js` |

`vad/LICENSE.md` is already in-tree. **`ort.wasm.mjs` carries the comment
"Minified to reduce loading time (https://minify-js.com/)"** — Andrew
minified it by hand, which is precisely the modified-third-party-library
problem AMO objects to. Shipping the unminified npm dist fixes it.

VAD is lazily loaded via dynamic `import()` from
`analyzer/AudioAnalyzerNode.mjs:63`, so it only costs anything when the
audio analyzer runs.

## Type checking

`tsconfig.json` type checks without emitting. `checkJs` is off; files opt in
with `// @ts-check` on line 1. `pnpm run typecheck` is gated in CI, so the
opted-in set is a ratchet.

Opted in: `BackgroundUtils`, `MultiRegexMatcher`,
`TabTracker`. Not yet: `background.mjs` (23 errors),
`NetRequestRuleManager` (1) — mostly nullability and API-shape issues
in the header-spoofing and download paths, where a wrong guard causes silent
403s. Fix those only with the playback checklist to hand.

`types/messages.d.ts` describes the cross-context message contracts. Add a
message only after reading its real payload; an inaccurate type is worse
than an absent one.

Use `@types/chrome` — the codebase uses `chrome.*` in 136 places and does
not use webextension-polyfill at all.

## Baseline verification

Any change claiming to be output-neutral must reproduce the upstream build
exactly. Use `tools/hash-build.mjs`, which collapses CRLF to LF for text
files before hashing:

```bash
pnpm run build:keep                                  # --keep is required
node tools/hash-build.mjs build_firefox_github > after.txt
diff baseline.txt after.txt                          # must be empty
```

**Always normalise line endings when comparing builds.** A build made on
Windows before `.gitattributes` existed has CRLF throughout; Andrew's Linux
CI produces LF. Comparing raw bytes across the two makes all 620 text files
look changed when nothing is. Verified for the pnpm migration: 611 text
files and 9 SVGs content-identical, 24 png/wasm/ort byte-identical, 644
total. The LF output this fork now produces is what upstream CI already
ships; the CRLF build was the local anomaly.

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

- `miniglob.mjs` `cleanGlobPath` shadowed the module-level `volumeNameLen`
  with a parameter of the same name, then called it. Callers pass a number,
  so **every Windows build failed** with `TypeError: volumeNameLen is not a
  function`. Fixed in `ab0719d`; candidate for upstream PR.
- No `.gitattributes`, so Windows checkouts got CRLF and eslint's
  `linebreak-style` reported 2352 errors. Fixed in `e81b036`.
