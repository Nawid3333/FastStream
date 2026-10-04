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
  they did not become 25 s. None of these hops is saved for undo, like the arrows. Every seek is
  clamped to [0, duration] in `FastStreamClient`'s `currentTime` setter (only the lower
  bound on a live stream): the media element clamps by itself, but `state.currentTime`, the
  separate audio track and `MP4Player`'s "is the target buffered" check did not, and an
  arrow press near the start used to make `MP4Player` drop its whole buffer (`resetHLS`)
  for a seek to -3 s that landed on the buffered 0. `keyboard.png` on the welcome page predates version 2
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
  **Gotcha:** the 16 `messages.json` files are the source; edit those, then run
  `pnpm run combine-locales` to bring `combined-locales.json` along. `tests/unit/localeKeys.test.mjs`
  fails when the two differ (the combined file had fallen behind by 15 keys and 17 English-only
  entries, regenerated 2026-09-30). Don't run `split-locales` unless the combined file is the
  one you edited: it writes over the locales. (Plain `node localescript.mjs`, which the build
  runs, only compares keys.) Both files are formatted with a 4-space indent; keep it, or a
  one-key change shows up as thousands of changed lines. The same test also fails when a
  locale's keys or `$1`/`$2` placeholders differ from English's (2026-10-03), so a new string
  needs all 16 locales before CI passes, an upstream sync's English-only key included. The
  welcome page lists every default key; `Keybinds.test.mjs` fails when a default is missing.
- Tests: `tests/unit/KeybindUtils.test.mjs` (the pure functions), `tests/unit/Keybinds.test.mjs`
  (the default layout has no clashes and every default has a handler, the storage path, the
  welcome page and locales), `tests/e2e/specs/keybinds.e2e.mjs` (presses in the running player,
  the migration on a legacy profile, the text-field guard) and `keybinds-menu.e2e.mjs` (the
  options page). Not covered: a saved profile in the real extension's `chrome.storage`.

## Reading big generated files

`.claude/settings.json` denies the Read tool on `pnpm-lock.yaml`, `node_modules/`,
`combined-locales.json`, the vendored libraries under `chrome/player/modules/` (generated from npm
by the build and gitignored), source maps and build output. `.ignore` keeps the committed ones out
of Grep and Glob results. (A `.claudeignore` repeated the list until 2026-10-04; Claude Code
reads no file with that name, checked against 2.1.278.) The rules load when a session starts,
so an already-open session keeps reading them.

When one of those files has to be consulted, do not read it whole: run `grep -n` or `sed -n`
through Bash, or have the ollama helper (`glm-5.3-flash:cloud`, through its HTTP API) pull out the
lines that matter, and check what it reports against the source.

## Commands

```bash
pnpm install              # pnpm 11, pinned via packageManager
pnpm run build            # 3 targets -> built/firefox-*.zip + built/web, unpacked dirs deleted
pnpm run build:keep       # same, but keeps build_*/ for web-ext
pnpm run lint             # eslint (must stay at 0), plus eslint.modules.config.js:
                          # undefined/unused names in chrome/player/modules, which the main
                          # config skips entirely (first-party code lives there next to vendored libs)
pnpm run lint:amo         # web-ext lint on build_firefox_amo (--self-hosted)
pnpm run start:ff         # rebuilds, then web-ext run on the dev profile (tools/launch-ff.mjs)
pnpm test                 # vitest
pnpm run test:ext         # installed extension, ordinary windows
pnpm run test:ext:github  # the same, against the GitHub self-host build
pnpm run test:pbm         # installed extension, private windows
```

`build:keep` must run before any `lint:amo` or `start:ff:clean` — those need an
unpacked directory, and a plain build leaves only zips. (`start:ff` and `start:ff:fresh`
rebuild by themselves.)

`update-local.cmd` (double-click; `tools/update-local.ps1 [-Apply] [-Repo <path>]`) checks
the owner's PC against what CI uses and reports (2026-10-01): Node of the `.nvmrc` major,
npm's newest and the pinned pnpm, each 5 days old by `tools/newest-release.mjs` (CI's rule,
`tools/check-toolchain.mjs`); on a clean `main`, how far it is behind origin, `pnpm install
--frozen-lockfile`, fsaunpack's `npm ci --ignore-scripts`; and whether
`%LOCALAPPDATA%\FastStreamMpvHost`'s host is the repository's (reinstalled by
`native-host/install.ps1` with the installed mpv and Node paths). The check changes nothing
and exits 2 when something is due; the .cmd then asks "Update these now?" and Y runs
`-Apply` (Node: nodejs.org MSI, SHA-256 checked and OpenJS-signed, staged in a folder
`tools/update-local-lib.ps1` locks to the user, Administrators and SYSTEM by SID (names are
localized: "Administratoren" broke it on the owner's German Windows, 2026-10-03), admin
prompt). The installs run only when a lockfile changed after the last install. WSL too
(2026-10-04, instead of `wsl-releases.yml`'s issues): `wsl.exe --version` against
microsoft/WSL's latest release once it is 5 days old (`newest-release.mjs wsl`), and
`-Apply` runs `wsl --update`, then `wsl --shutdown` (which stops a running `verify:linux`).
`WSL_UTF8=1` for those calls: wsl.exe otherwise writes UTF-16, read as a NUL after every
character (`ConvertFrom-WslVersionText` drops them all the same, and reads the number, not
the localized label). Never Firefox, mpv (`C:\Program Files\mpv` is the owner's own
repository, Nawid3333/mpv, with its own updater) or the Ubuntu releases inside WSL.

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

**Automated: `pnpm run test:live`** (after `pnpm run build:keep`; 2026-09-27), and every
Monday on Linux and Windows in `live-streams.yml` (2026-09-28; an issue when it fails,
closed by the next green run - never part of CI, so an outage elsewhere holds nothing back).
`tests/e2e/live-specs/streams.e2e.mjs` runs this checklist on the installed extension
against real streams: Shaka Player's demo assets on storage.googleapis.com (HLS and DASH
angel-one: 5 qualities, 5 audio languages; DASH Sintel, 888 s, seeked 10 minutes in; a
live DASH stream) and a progressive MP4 on raw.githubusercontent.com. The pages are local
and embed them the way sites do: the site's own hls.js/dash.js (the official releases of
the versions `package.json` pins, from the npm registry, cached in the gitignored `tests/e2e/fixtures/live-libs`), a
plain `<video src>`, a cross-origin iframe that may go fullscreen (player laid over it)
and one that may not (the frame is sent to the player page), plus a manifest opened
directly (`playStreamURLs`). Not in `verify` or CI: a third-party outage must not block a
release. Two things it found on its first run: a page whose query string names a stream
was taken for the stream, and the player that takes over an iframe without
`allowfullscreen` got no sources (PRs #40 and #41, each with its own ext-spec). Pages
name their stream by key (`/hls?stream=hls`), never by URL, so the suite does not depend
on the first fix. A test that switches into a frame must switch back before
`browser.url()`, which navigates the frame WebDriver is in.

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

- **Measured cheap, so left alone (2026-10-01, PF1-PF4).** In the e2e Firefox, on the
  Guardian, BBC, Spiegel and CNN front pages (20 s each):
  - **PF1:** the webRequest listeners ran 49-115 times per page, about 1-6 ms of handler
    time in all. A `types` filter would drop 65-85% of the calls (script, image,
    imageset, font, stylesheet, beacon) but saves no measurable time; not worth risking
    a stream of a type nobody thought of.
  - **PF2:** overlay-guard.js's check took 1.3 ms a second on a 1,500-element page,
    2.3 ms on 5,000, 9.5 ms on 20,000 and 23 ms on 50,000; dropping its per-element
    array spread saved only 5-25%.
  - **PF3:** content.js sends 3 messages per frame per page load, 9-12 on those pages.
  - **PF4:** `querySelectorAllIncludingShadows` took 0.2-3 ms per call, and one-walk
    rewrites were no faster. What it did have was a bug (searching an element's own
    shadow root), fixed and tested in content-cleanup.e2e.mjs.

- **`play()` does not wait for the audio (2026-10-01).** With no sound device (CI's Linux
  runner) the player's AudioContext stays suspended and `resume()` never settles; `play()`
  waited for it, so it never finished, and autoplay's `autoPlayTriggered` was never set.
  `startAudio()` now starts the context once, without waiting, and starts the background
  analyzer when the audio runs (client-setup.e2e.mjs fakes the never-settling resume).
  Specs that need actual sound check for it with audio-tools.e2e.mjs's `skipWithoutSound`;
  without it they skip, except on Linux CI, which has a PulseAudio null sink since
  2026-10-03 and fails them there (`tests/e2e/soundCheck.mjs`, #265).

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
  and `XHRLoader`'s `stats.error` (`{code, text}`). A fragment or key that fails gets
  `onAbort` after 1 s, and hls.js picks it again: upstream's design, on top of
  `XHRLoader`'s own six retries. From the third failure in a row of the same one it gets
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
- **`DownloadEntry.notifyWatchers`**: a watcher that throws neither silences the others
  nor skips the cleanup. `StandardDownloader.onSuccess` cleans up in `finally`, or the
  downloader stays busy for good.
- **`setSourceInternal`'s progress chain returns if another source came in**, both before
  it switches progress saving off and after it waits for the player. The wait ends when
  whichever player is current is ready, which may be the next source's.

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
instead of asking. Both now always ask (they skipped it only for
`isChrome() && isIncognito()` until Chrome was dropped).

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

**The host's version (2026-10-04).** `HostVersion` in the host goes out with every answer
(`withHostVersion`), and `RequiredHostVersion` in `MpvBackend.mjs` is the host the
extension was released with. An answer with a lower version, or with none (a host from
before this), is an outdated host (`MpvBackend.isHostOutdated`): the stream still goes
to it, and the result carries `hostOutdated`. That shows as "!" on the toolbar button
in MPV mode with what to run in the tooltip (`tab.mpvHostOutdated`, persisted like
`mpvError`, whose reason comes first), in the player's "Sent to mpv" message, and after
"Test mpv connection". This replaced `mpv-host-changed.yml`'s e-mail. **Every change to
the host file or to `install.ps1` raises both numbers by one**:
`tests/unit/mpvHostVersion.test.mjs` records both files' SHA-256 beside the version and
fails until `HostVersion`, `RequiredHostVersion` and the record agree (the failure prints
the new hashes). The installer counts because `update-local.ps1` tells an installed host
from the repository's by the host file alone; a raised `HostVersion` changes that file. The
extension changes with it, so such a push releases, Firefox updates the extension, and
the next hand-off on the owner's PC shows the "!" until `update-local.cmd` (or
`install.ps1`) has run. The hash check is skipped in Stryker's sandbox, whose copy of
the host holds every mutant.

**Only http(s) goes to mpv, and a bare `mpv` is looked up (2026-09-28).** mpv opens
local files and UNC paths too, and a UNC path makes Windows sign in to that host with
the user's credentials. The player page is web-accessible, so a page could build a
player around such a "source" and have the user send it to mpv. `MpvBackend.isStreamUrl`
and the host's `isStreamUrl` accept an `http://`/`https://` string only (the prefix is
checked on the raw string: the URL parser reads `https:\host\share` as https). And the
host no longer passes a bare `mpv` on unchecked - "Test mpv connection" said mpv was
there on a machine without it, and WMI's provider searches its own PATH, not the user's -
`findMpvOnPath` returns `mpv.exe`'s absolute path from the user's PATH, or nothing.
Both need `install.ps1` run again on a machine, like any host change.

**A page could run code through "Send to mpv" (fixed 2026-09-30).** The chain: a page
reads the extension's address from a player iframe's `src`, frames
`player/index.html#<url>?faststream-headers={"Referer":"x’;…;’"}` itself, and the user
clicks the mpv button. The Referer reached the host unchecked, and `launchViaWmi` put
mpv's command line into the PowerShell script as a single-quoted string with only the
ASCII `'` escaped; PowerShell also ends such a string at U+2018-U+201B. Proven on the real
PowerShell (`tests/unit/mpvHostSecurity.test.mjs`) and the Firefox half in
`ext-specs/framed-player.e2e.mjs`. The fixes, in layers:
- **No data in PowerShell source.** The command line goes in through the environment
  (`FASTSTREAM_MPV_COMMAND_LINE`, read as `$env:`), so the script text never changes.
  This also removed the ~9 KB limit a long URL hit inside `-EncodedCommand`.
- **Header values are printable ASCII** (`MpvBackend.pickRelayHeaders` and the host's
  `relayHeaderFields`): Referer, Origin and User-Agent only, no CR/LF, no quotes beyond ASCII.
- **A framed player ignores its address.** The extension puts a source in the address
  only of a player in a tab of its own (the stream-URL redirect rule is `main_frame`
  only); `main.mjs` takes the hash only when `window.top === window`. The copy-URL
  buttons' `faststream-headers` links still work when opened in a tab.
- **Header rules cover only the extension's own requests** (`initiatorDomains`, the
  moz-extension host): the rule is per tab, and the tab is the page's, so for 5 s the
  page's own requests to that URL got the player's Origin or Cookie.
- **The options page is not web-accessible.** Only the player frames it, and an
  extension page needs no entry for that. The e2e helpers open it from the player page
  (`extension-page.mjs`'s `openExtensionPage`).
- **The host starts only an mpv**: a file named `mpv*` (or `mpv.exe` in a named folder),
  never a UNC or device path, which it does not even `stat`.
- Also in the host: a 1 MB cap on a message's length prefix (an over-size message is read
  past and answered with an error; `MpvBackend` leaves out subtitles that would not fit),
  a page's own `fs-*` fragment tags dropped before the host's are added, no direct-spawn
  fallback when WMI fails on Windows (Firefox kills that mpv as the host exits, so it
  reported success for nothing), "mpv quit right after it started" after ~2 s instead of
  a 30 s wait, and the headers and title as per-file options of the one `loadfile`
  command (no lock file since 2026-10-02), so two sends milliseconds apart cannot swap
  headers.

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

**An open extension page keeps the event page running (measured 2026-09-28).** With
idle unloading on at Firefox's 30 s default, the background stayed `running` through
60 idle seconds while a FastStream player was on the page, or the player page was open
in a tab, and went `stopped` once neither was. So idling alone never takes the frame
registry away from under an open player; a stop that does (a hung background Firefox
restarts, about:debugging's Terminate) left Off unable to see the player, which stayed
on the page. `tabHasPlayer` asks the tab when the registry knows none: `HAS_PLAYER`
goes to every frame, and a content script that finds a player iframe in its document
(by URL, so a loading one counts) answers, as does a player page itself (a page frame
that navigated to the player). The e2e harness runs with
`extensions.background.idle.enabled = false`, so a spec never sees an idle unload:
stop the background with `extension.terminateBackground()` from the chrome context
(`toolbar-state`, `toolbar-off-race`, `mpv-suspend`).

**Tab state has to outlive the event page (2026-09-24).** Firefox unloads the
background after ~30 idle seconds, and every `TabHolder` goes with it. A reload
then woke a fresh background with no record of the user's toolbar choice, so an
allowlisted site auto-started MPV again even after the user had picked the
in-page player or Off. The same loss dropped the one-hand-off-per-page latch,
so the page's next stream request after a wake opened a second mpv window.
`TabTracker.saveTabState` now writes `url`, `isOn`, `isMpv`, `mpvOnPlay`, `regexMatched`,
`mpvMatched` and `mpvAutoOpened` per tab to `chrome.storage.session` whenever
one of them changes (toolbar click, URL change, mpv hand-off and its failure),
and since 2026-10-03 (#158) the failure shown as "!" (`mpvError`) and the shortcut's
waiting play (`mpvPlayPendingUntil`, `mpvPlayedVideo`, `mpvLastPlaySend`),
and `restoreTabStates` puts them back inside `ensureOptions()`, which every
state-changing listener already awaits. A new field that has to survive a wake
goes into `PersistedTabFields`, and every place that sets it saves. Within one
background lifetime the old in-memory logic was already right, so a test that
never suspends the background cannot see this.
`tests/e2e/classic-specs/` (`toolbar-state`, `mpv-suspend`, `toolbar-cycle-mpv`,
`mpv-shortcut`) click the toolbar, press keys, and suspend the background from Firefox's chrome context,
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
stream to mpv; it does not call `openMpvWithSources` itself. The MPV
branches go through `startMpv`/`stopMpv`, which check
`frame.playerOpening || frame.isPlayer` (`hasOrOpeningPlayer`), not just
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

**A player whose page reloaded while it started (2026-09-30).** The other end of
that window: the reload (`tab.reset()` + `chrome.tabs.reload`) can come while the
player iframe is still starting. Its `beforeunload` (which sends `FRAME_REMOVED`)
is only added after it sent `PLAYER_LOADED`, and on the slow Windows runner the
dying out-of-process iframe sent `PLAYER_LOADED` after the new page's
`FRAME_ADDED`. The background then took it for a player of the new page: frame 0
`hasPlayer()`, so `onHeadersReceived` dropped every stream the page requested and
`openPlayer` refused, until the next navigation (mpv-shortcut failed so in 4 of 5
CI attempts from #67 on, none in ~40 before). Now content.js names its page
(`DocumentKey`, sent in `FRAME_ADDED` and set as the player URL's `opener`), and
`PLAYER_LOADED` from a player whose opener is no longer the page in its frame or
the frame above (`TabHolder.isPlayerOfGoneDocument`) is answered null and
forgotten. A frame whose page never named itself to this background (it restarted
since) proves nothing and the player counts. mpv-shortcut's `/late` page pins the
state the race left.

**A player a page frames itself (2026-10-03, #225).** `player/index.html` is
web-accessible, so a page, or an ad's iframe in it, can frame it with any
`parent_frame_id`. The player's own load is a moz-extension request that webRequest never
sees, so the background took that id on trust: the named frame (the top one) counted as
holding a player, with the effect above. Now `PLAYER_LOADED` adopts the named parent only
when the opener is that frame's page or the player frame's own
(`TabHolder.playerParentProof`); when the background does not know the frame's name (it
restarted since), it asks the frame's content script (`IS_PLAYER_OPENER`). Otherwise the
player is answered null and forgotten. mpv-shortcut's `/framed` page pins it.

**Gone pages, and a page Back brings back (2026-09-30).** `TabHolder.goneDocuments`
keeps the 16 latest pages that left a tab, by name, with what each had detected. A page
leaves when its `FRAME_REMOVED` is taken, when another page names itself in its frame
(`FRAME_ADDED`), and in the reset before a reload (`resetForReload`: startMpv, stopMpv,
the toolbar's Off); not in the reset on a new hostname (`tabs.onUpdated`), which can come
after the new page named itself, or while a player the tab was sent to (a moz-extension
URL) still names the page it replaced. A player naming a gone page is refused even when
the reload left no named frame to tell by (a player in an iframe of an iframe). Firefox's
back-forward cache gives a page back with its content script alive and fetches nothing:
content.js names the page again on a persisted `pageshow`, and its streams come back by
its name (random per page, so its URL may have moved on), for the toolbar, a shortcut or a
play in MPV mode; nothing opens by itself. The reset on a new hostname can come after that
page (or any new page) named itself: it keeps a frame 0 already named at a URL of the new
hostname, with the frames under it (`resetForNewSite`), where a plain reset wiped them. On
the MPV allowlist, a play sends the page's stream only on a page Back gave back
(`frame.restoredFromCache`), while none went on it (`onUserPlay`): such a page detects
nothing for the allowlist to send by itself. Its file goes at once; a blob: player's stream
after 3 s, if none was detected meanwhile. Anywhere else a play sends nothing: a site that
plays its next episode in the same page (a URL change without a load) still has the last
one's streams when the play is reported, and the next one's detection sends it (GLM's
review of #87 caught the play sending the last one again). mpv-shortcut covers both, and
the Back cases need a script's play before leaving: a WebDriver click leaves an unload
listener on the page, which keeps it out of the cache. An open timer fires only for a
frame the tab still tracks (`isTracked`): the
reset on a new site drops frames with their streams on them, and OPEN_PLAYER goes by frame
id. `FRAME_REMOVED` names its page, and a late one from the page before (a
known name that is not the frame's) is ignored. A page that takes the player's iframe out
itself runs no `beforeunload` in it, so the player also reports on `pagehide` (Firefox
fires it on removal; content-cleanup's case fails without it), and `removePlayers`
reports every player iframe that is out of the page when it is done, whoever took it out,
overlays too, once each.

**MPV shortcut: Ctrl+Shift+U, the `toggle_mpv` command (2026-09-26).** MPV
on or off for the tab on any site, allowlisted or not, while MPV mode is on
(off = FastStream off, as the toolbar's MPV -> Off). On a blank or new tab it
arms MPV for the next page opened there (the tab's mode survives navigation);
the toolbar opens the player page on a blank tab instead. **Only a video the
user starts goes to mpv** (`tab.mpvOnPlay`, persisted): on an arbitrary site the
first stream a page loads is as likely a preview or background clip, and Nawid
found the automatic hand-off wrong there (2026-09-26). content.js reports a
`play` (capture listener) that carries transient user activation
(`navigator.userActivation.isActive`) as `MPV_USER_PLAY`; `onUserPlay` sends the
detected source matching the video's `currentSrc` (a preloaded file is never
detected again), else the newest source of that frame (MSE: `blob:` src), else
the next stream detected within 15 s. The same URL again within 10 s only
re-pauses the page (players call play() twice, or resume after the pause). On
activation `MPV_REPORT_PLAYING` lets a frame hand over a video the user started
and is still watching. The allowlist and the toolbar keep the automatic
first-stream hand-off (`startMpv(tab)` without `onPlay`). Not seen: a video in a
shadow root (media events do not leave it) and a cross-origin player started
by a button in its parent page (activation does not reach a cross-origin
child). The spec was checked against both mistakes it guards (the old
automatic hand-off; no activation check): each fails 4 of its 5 tests. It shares
`startMpv`/`stopMpv` with the toolbar, so the two cannot drift: a tab is
always exactly one of Off / On / MPV, and the last key pressed decides.
**Ctrl+Shift+F is its own command, `toggle_player` (2026-09-28)**, not the
toolbar button (`_execute_action`) any more. `_execute_action` fires the
button's own `action.onClicked`, as a click does, so the background cannot
tell the key from the button, and a click on MPV goes to
Off: Ctrl+Shift+F after Ctrl+Shift+U turned FastStream off, and getting the
player took a second press (Nawid, 2026-09-28). Now `onClicked(tab,
{playerKey: true})` goes MPV -> On straight away (from the allowlist's MPV
too) and is the plain Off/On toggle otherwise, on the allowlist as well; the
button keeps its cycle. The player page drops an MPV arm (Ctrl+Shift+F on a
new tab opens it). The delayed `openPlayer` in `onSourceRecieved` checks
`!isMpv` as well, since MPV is "on" too: a switch to MPV inside
`replaceDelay` otherwise got a player opened under it. `manifestCommands.test.mjs`
checks each command is run on both paths (Firefox's and the cancelled-key
fallback); `mpv-shortcut.e2e.mjs` drives F and U through every switch. The key was picked by measurement on Firefox 156:
the Ctrl+Shift letters Firefox binds itself (browser.xhtml plus the DevTools
keys - M is Responsive Design Mode) leave only F, L, U and Y free (V is
paste-as-plain-text in text fields), L and Y are Bitwarden's defaults, and
`RegisterHotKey` showed no other Windows program holding U. `mpv-shortcut.e2e.mjs`
pins it with Firefox's own `ShortcutUtils.isSystem` check (the one
about:addons runs) and presses it through a `TextInputProcessor` in chrome:
`browser.keys()` synthesizes inside the content process and never reaches
window-level shortcuts. The helper waits for the key element's `command`
event, because Firefox gives the command the tab active when the key's round
trip through the page ends, and a test that switches tabs straight after
pressing sends it to the wrong tab.

**A page that cancels a shortcut (2026-09-27).** Firefox lets page content
cancel an extension's shortcut: a keydown the page calls `preventDefault()` on
never reaches the command (the extension's `<key>` has no `reserved`
attribute). VOE's "no view-source" guard cancels every `ctrlKey && keyCode ==
85`, Shift or not, and swallowed Ctrl+Shift+U; Nawid wants Ctrl+Shift+F and
Ctrl+Shift+U to work on (nearly) every site. content.js's window capture
listener - registered at document_start, before any page script - checks each
trusted, non-repeat press with Ctrl/Alt/Command (or an F-key or media key)
after dispatch, and reports it as `SHORTCUT_CANCELLED` only if the page
cancelled it; the background matches it against `commands.getAll()` (fresh,
so a key rebound on about:addons counts) with `KeyShortcut.matches` and runs
the command's handler, as `commands.onCommand` does. A press the page leaves alone is Firefox's to
run, so the two paths never both fire. `isTrusted` matters: content-script
listeners do receive page-dispatched events (measured). A site that uses the
same combination for itself now gets both its own action and FastStream's.
Not covered: a page script in an `about:blank` frame (content.js does not run
there). `shortcut-page-cancels.e2e.mjs` fails 4 of 6 without the fix, and
catches both mistakes it guards: reporting uncancelled presses (runs twice)
and dropping `isTrusted` (a page fakes the key).

Single-instance reuse goes over mpv's JSON IPC on a named pipe. Only
instances this host starts are given `--input-ipc-server`, which is what
stops it ever loading into — or closing — an mpv the user opened themselves.
A stale pipe simply fails to connect and a fresh instance starts. The pipe's
name carries `config.json`'s `ipcToken` (random, written by `install.ps1`):
pipe names are machine-wide, so another account must not be able to guess it
(`ipcPipeFor`; a Unix socket in `$XDG_RUNTIME_DIR` off Windows). A running mpv
that answers `loadfile` with an error is not replaced by a second one.

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
key is short and the same on every visit; the page address itself is in mpv's
`path` too, percent-encoded as `fs-page=` (source-info.lua's "Site page"),
and so wherever mpv or a script records the path. A host without this
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
`Origin` header. It skips rather than fails when the host is not installed,
and so do `classic-specs/mpv-shortcut`, `mpv-suspend` and `toolbar-cycle-mpv`.
CI's `e2e-windows` job installs the host, so there they run: shinchiro's
x86_64-v3 Windows build, the one the maintainer runs (release, asset and
SHA-256 pinned in `.github/mpv-build.json`, logging through
`portable_config`), registered by `native-host/install.ps1`, the step failing
if the registry key or its manifest is missing rather than letting the specs
skip. `mpv-updates.yml` offers each new pin: each day it pushes shinchiro's
newest build as `mpv/<release>`, dispatches CI on it, reruns failed jobs once,
and on a pass moves branch `mpv-update` to that commit, with ONE pull request from
it that keeps up (retitled per build, assigned to the owner, who merges it; the
pin ships nothing, so his merge releases nothing). Until 2026-10-02 the pin
commit went onto main directly. A failed build,
or a pinned release gone upstream (shinchiro keeps about 30), opens or updates
one assigned issue, "mpv update failed: ...", which a later pass closes. A
failed build keeps its branch, so it is not tried again; delete the branch to
retry it.
The host's own functions are unit tested (`tests/unit/MpvNativeHost`, `mpvHostPath`,
`mpvHostSecurity`, `mpvHostInstall`); the last two run the real PowerShell and the
installed `.bat` on Windows only. What no suite covers is survival inside a real
kill-on-close job object: check that by hand after a change to the launch.

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

The code is `tools/splicer.mjs` (tests: `tests/unit/splicer.test.mjs`). A directive is
a `//` comment that is exactly `SPLICER:<TARGET>:<COMMAND>`; any other `// SPLICER:`
comment, unknown target or unknown command fails the build, and the text in a string or
block comment is not a directive (#168). Everything else ships as written, blank lines
included: until 2026-10-03 every blank line was dropped, inside template literals too.

Targets: `EXTENSION`, `FIREFOX`, `WEB`, `NO_UPDATE_CHECKER`; no code carries a
`FIREFOX` block any more, but both Firefox builds still pass it.
(`CENSORYT` and `NO_YOUTUBE` existed before YouTube support was removed
entirely — see "YouTube removal" below — and no longer apply to anything;
`NO_PROMO` went with the review prompt on 2026-09-20.)

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
| `firefox-github` | EXTENSION, FIREFOX | manual install |
| `firefox-amo` | EXTENSION, FIREFOX, NO_UPDATE_CHECKER | AMO target; min version 142, declares data_collection_permissions |
| `web` | WEB, NO_UPDATE_CHECKER | faststream.online, no extension APIs |

`buildFirefoxAmo()` was written but never invoked (commit "Remove firefox
dist build for now"). Re-enabled in `7ed4723`.

The 12 `EnvUtils.isChrome()`/`isFirefox()` branches elsewhere in the
codebase (playback-rate caps, the 7.1-audio workaround, OPFS backend
selection, SponsorBlock's extension ID), left in place on 2026-09-11, went
with the rest of Chrome's code on 2026-09-20; none is left.

## Releasing (auto-release.yml, added 2026-09-12)

Every push to `main` that passes CI now gets released
automatically — no separate "ship it" step. `auto-release.yml` waits for
CI to go green on that branch (`workflow_run`, not `push` directly — a
red push is never released), then bumps just the trailing build number
(`1.3.82.0` -> `1.3.82.1` -> ...; past any build number whose tag exists, locally or on
the remote, since a reverted release takes the version back and leaves its tag), commits
`chore: release <version>`, tags it, and pushes both in one `git push --atomic` (a
refused push leaves neither, never a release commit without its tag), then explicitly runs `gh workflow run
release.yml --ref v<version>` to do the actual build/sign/publish.
That last step has to be explicit: the tag push is authenticated with the
default `GITHUB_TOKEN`, and GitHub deliberately does not let a
`GITHUB_TOKEN`-authenticated push fire other workflows' `push` triggers
(anti-recursion protection) — confirmed the hard way when `v1.3.82.1`'s
tag landed with no Release run behind it, before this dispatch step
existed.

The bump commit is pushed with `GITHUB_TOKEN` like the tag, so it starts no
CI run: the release commit itself is never CI-tested (it changes only the
version; release commit `598c2d6a` has no CI run). Should CI run on it anyway,
by a dispatch or a re-run, the workflow's `if:` skips any `workflow_run` whose
head commit message starts with `chore: release `, so a release never
releases itself.

**Only when something shipped changed** (2026-09-25). Before bumping,
auto-release downloads CI's build of the commit (the `faststream-bundles`
artifact) and the latest release's `firefox-github-*.zip` and signed xpi, unzips them and
runs `diff -rq`: the github zip against its zip, the AMO build against the xpi minus
`META-INF/` (Mozilla's signature; otherwise the xpi is that build, checked on 1.3.82.52).
Until #164 (2026-10-03) only the github zip was compared, so a change to the AMO build
alone (its `update_url`) released nothing. A release still waiting for its xpi cannot be
compared, so a push then releases. Identical means the push touched only tools, tests,
workflows, docs or dev dependencies, and the release would differ from the
last one only in its version number (v1.3.82.33 after PR #21 was exactly
that), so it stops with a notice and nothing is released. Any doubt - no
release, no artifact, a failed download or unzip, any difference - releases
as before. Checked on real history before it went in: PR #21's merge build
against v1.3.82.32 is identical; PR #20's against v1.3.82.31 differs in the
six dash.js/mp4box files it changed. The builds are deterministic enough for
this: two releases from different commits differ only in `manifest.json`'s
version. To release such a push anyway, run `pnpm run release <version>`.

`tools/cut-release.mjs` (`pnpm run release <version>`) still exists for a
deliberate version bump — a real minor/patch for a milestone rather than
the next build number. Run it by hand right before the push you want that
version on; auto-release's next build-number bump continues from whatever
version that leaves in `package.json`.

**AMO signing no longer depends on a timer.** AMO has no webhook for "signed" (its API
documents none), so `tools/sign-amo.mjs` uploads and polls, waiting up to 30 minutes
(`approvalTimeout`). Measured over 30 releases: 2-6 minutes, once 15. When the wait runs
out, the release is published without the xpi and `updates.json` (the sign step is
`continue-on-error`), and **`amo-signing-failsafe.yml`** ("Release failsafe") completes it:
`release.yml` starts it after every run, and a schedule every 3 hours as well. It checks the
latest release and, if incomplete, builds that tag and asks AMO for the version
(`tools/fetch-amo-signed.mjs --wait 40`, no upload; the tools are main's, the build the
tag's): signed -> download (byte-identical to web-ext's
file, checked on 1.3.82.27; the regenerated `updates.json` matched the published one
exactly) and attach both; pending -> next run; missing (never uploaded) -> sign now;
rejected, or still incomplete after 24 h -> one issue, assigned + @mention, closed when the
release is complete. Re-running `web-ext sign` cannot do this: AMO refuses a second upload
of a version. v1.3.79.0 and v1.3.82.2, the two releases without an xpi, are both `public`
on AMO - the failsafe would have collected them. `release.yml`'s `timeout-minutes: 45`
covers the 30-minute wait. **A network error does not end the wait** (2026-09-28):
v1.3.82.37 passed validation, then one `fetch failed` while web-ext polled for approval
failed the step, and the release lacked its xpi and `updates.json` until the failsafe
(run by hand) collected them 10 minutes later. `sign-amo.mjs` now goes on asking AMO
itself with `fetch-amo-signed.mjs`'s check, every 30 s, within the same 30 minutes; a
version AMO never received is uploaded once more. AMO's own answers (a refused upload, a
failed validation, the approval timeout) still fail the step as before.

**Every release is checked to reach Firefox** (2026-09-28, the failsafe). A version tag
without a release - `release.yml` failed before publishing, or was never started, which no
one heard of before, since the bot starts it - gets `release.yml` started again, at most
twice, then the issue "Release <tag> failed". A complete latest release gets its update
path followed the way Firefox does (`tools/check-update-path.mjs`: the `update_url`
redirect, `updates.json`, the xpi's sha256, `META-INF/mozilla.rsa` and `cose.sig`, the
version and the add-on id `build.mjs` sets); broken -> the issue "Update path broken:
<tag>". Both close on their own; the run stays green once the issue is open, so it is not
repeated by mail. The decision steps were dry-run with a stub `gh` (17 scenarios) before
the change went in.

## Workflows (reworked 2026-09-25)

- **`ci.yml`** runs what `pnpm run verify` runs (including `test:pbm` and,
  since 2026-09-25, `verify:vtt`/`verify:knob`/`verify:vad` - `verify:vtt` had been red
  for three days when nothing ran it - and since 2026-09-30 `verify:fsaunpack`, which
  installs fsaunpack's own npm lockfile and starts its express test server;
  `verify:ort` left the chain on 2026-09-30 with the custom ONNX Runtime wasm it
  stamped), plus a
  `workflows` job: actionlint with its
  bundled shellcheck over every workflow.
- **Run it here before pushing, the way CI runs it** (2026-09-25; PR #20 passed locally
  and failed on CI). The e2e fixtures are built with the machine's ffmpeg: CI's has
  libx264, a local LGPL build only libopenh264, and only libx264 makes B-frames. The
  fixtures no longer depend on that (the DASH and HLS ones are encoded with `-bf 0
  -sc_threshold 0`; the B-frame one is copied from `sample.mp4`). Before a push, run
  both halves of CI here: `pnpm run verify` (Windows), and **`pnpm run verify:linux`**,
  which runs CI's Linux verify job and its workflows job (actionlint, zizmor, and the `run:`
  scripts' tests in `tests/workflows`) in WSL, once on each Ubuntu
  release CI uses: the one `ubuntu-latest` gives and the newest GitHub offers (24.04 and
  26.04 until `ubuntu-latest` has moved, rolled out Oct 19 - Nov 19 2026), read from the runner image table
  `runner-images.yml` reads, so the pair follows GitHub; a release WSL lacks is
  installed, `--distro Ubuntu-26.04` picks one. Every run first brings the distro up to
  date, as a freshly built runner image is: `tools/linux/setup.sh` runs apt update +
  full-upgrade, installs the newest release of the Node major `.nvmrc` names
  (so it moves with CI) with the `packageManager` pnpm through its npm (not corepack, which
  Node 25+ lacks; Node 26 also needs apt's libatomic1, #238), and the current stable Firefox
  (its SHA-512 from the SHA512SUMS Mozilla's release key signs, the key pinned by fingerprint
  in setup.sh, #248; Node's sum is still only from nodejs.org itself), apt ffmpeg
  with libx264, and the actionlint and shellcheck binaries out of the image digest
  `.github/actionlint/Dockerfile` pins (apt's shellcheck is 0.9.0 on 24.04, the image's 0.11.0),
  and zizmor's out of the one `.github/zizmor/Dockerfile` pins (#239). Then
  `tools/linux/verify.sh` runs on a copy of the working tree with fresh fixtures. wsl.exe
  writes stdout and stderr to a redirected file at separate offsets, one over the other,
  so both scripts merge them. The Windows build of actionlint hangs driving shellcheck on
  some scripts; use the Linux one. On CI, `-latest` picks the OS release and GitHub
  rebuilds each image about weekly; what the tests use is fetched fresh every run: ffmpeg
  (apt-get update + install), Firefox `latest`, and Node from `.nvmrc` in every workflow
  (`node-version-file: .nvmrc`, `check-latest` - without it setup-node took the image's
  cached 22.23.2 two days after 22.23.3).
  CI does not apt-upgrade the whole image: minutes per run, for packages the tests do not
  touch. For CI's Windows encoder, delete everything in `tests/e2e/fixtures/` except
  `sample.mp4` and run `pnpm run verify` with a GPL ffmpeg first on `PATH` (on this
  machine: winget's `Gyan.FFmpeg`, gyan.dev 9.0.2 full; Chocolatey gives the Windows
  runner the same version as the essentials build, both with libx264).
- **`auto-release.yml`** only acts on a CI run that was a `push` to this repository's
  `main`. Before, `branches: [main]` matched a fork PR's branch named `main` too, and the
  job would have checked out that commit with a write token, pushed it and released it.
  When `main` has moved past the commit while CI ran, it stops with a notice (2026-09-28):
  the later push's run releases both, and pushing the bump would only be refused.
- **Two ways `main`'s changes went unreleased with no one told** (fixed 2026-09-30).
  (1) A late CI run can cancel the run of `main`'s newest commit: on 2026-09-29 GitHub
  delivered the push of 3b74403c a second time, after `main` had moved to 477bcd59;
  through `ci.yml`'s `cancel-in-progress` that run cancelled 477bcd59's, went green, and was
  rightly not released, being behind `main`. 477bcd59 had no run and no release until it
  was re-run by hand. `auto-release.yml`'s `restart-cancelled-ci` job now runs after every
  CI push run on `main`: it finds the newest commit on `main` with a CI run, back to the
  last release bump, and re-runs that run when it was cancelled and a CI run on `main`
  started after it did. A run cancelled by hand is left alone; after a third cancelled
  attempt, or when GitHub refuses the re-run, the issue "CI on main needs a re-run" goes to
  the owner. (2) A push by `GITHUB_TOKEN` starts no CI (until 2026-10-02 `mpv-updates.yml`'s
  pin and `update-prs.yml`'s merges were such pushes), so one landing while CI ran on a commit left that commit's
  run seeing `main` moved on, to a commit whose run never comes. "Is this commit still
  main's newest?" now waits a minute for a later commit's CI run on `main` and, with none,
  starts CI on `main` by dispatch (a release bump after the commit means it is released).
  Both kinds of run are `GITHUB_TOKEN`'s and send no `workflow_run`: `ci.yml`'s
  `release-hand-off` job starts `auto-release.yml` by `workflow_dispatch` with the run's
  id and commit, whatever the run concluded, and "Which CI run?" waits for it to end and
  checks it as the job condition checks the event. A red one, a failed release, or a
  hand-off GitHub refuses opens "Auto release failed", since no one is emailed for a run
  the token started; a failed release on the `workflow_run` path too, since no failed run
  there has shown that it emails the pusher (2026-09-30). The hand-off takes a run either
  of whose actors is the token: the owner's re-run of such a run keeps the token as its
  actor and sends no `workflow_run` either (CI run 36618653582, attempt 2), and released
  nothing while only the triggering actor was checked. Each failure issue here and in the
  other workflows' "Report this workflow's own failure" is one issue while it is open, and
  a failure while it is open adds a comment with its run's link (before, it was dropped).
  The concurrency group is per commit, at job level: a workflow-wide
  group keeps one pending run and cancels it when another arrives, which could have
  dropped the newest commit's release behind a stale one's. The three scripts ran against
  a fake `gh` in WSL, 47 cases, each of eight mutations caught, and a GLM review before they
  went in. Not covered: a push GitHub never delivers.
- **`release.yml`** checks the tag against `package.json` and `chrome/manifest.json` before
  building, and runs lint + unit tests (a hand-cut tag reaches it without CI). Only
  lowercase `v` tags: the 106 capital-`V` tags in the repository are upstream's, copied at
  the fork. Run again for a tag that has a release, it replaces the files. Its last step,
  whatever happened, starts the failsafe.
- **`amo-signing-failsafe.yml`** ("Release failsafe"; after every release run, and every
  3 h): completes a release whose AMO signing did not finish, re-runs one that did not
  publish, checks the update path; see "AMO signing no longer depends on a timer" and
  "Every release is checked to reach Firefox" above.
- **`live-streams.yml`** (Mondays; 2026-09-28): `pnpm run test:live` on Linux and Windows,
  one issue while it fails. Also on a PR that changes the live suite or the e2e setup.
- **`.github/actions/e2e-setup`** (2026-09-28): ffmpeg, the e2e port reservation and the
  Firefox to test (`firefox-version`, exported as `FIREFOX_BINARY`), for every e2e job - the
  four copies differed already. Each download (Chocolatey, apt, Mozilla) is retried before
  the job fails. A change to it runs Firefox Beta and the live suite on the PR. Since
  2026-10-03 also `sample.mp4` from the Actions cache, keyed on its pinned SHA-256 and
  checked like a download (`tests/e2e/mp4FixtureCli.mjs`, #256), and on Linux a PulseAudio
  null sink as Firefox's sound device (`PULSE_SERVER`, `E2E_SOUND_SINK`; #265). The
  Windows runner has no audio endpoint. Its scripts: `tests/workflows/e2e-setup.test.sh`,
  `tests/unit/e2eSetupAction.test.mjs`.
- **Artifacts** (2026-09-28): `faststream-bundles` is kept 7 days (auto-release reads it
  minutes after the run; the 90-day default had piled up 57 copies, 469 MB), failure logs
  30 days.
- **`toolchain-updates.yml`** (weekly, Mondays 07:00 UTC; a push to `main` touching
  `.nvmrc`/`package.json` only closes) + `tools/check-toolchain.mjs`: a pull request
  per update, "Toolchain update: <name> <version>", on `toolchain/node-<major>` or
  `toolchain/pnpm-<version>`, with CI started on the branch by `gh workflow run ci.yml`
  (a `GITHUB_TOKEN` push starts no workflow). A newer Node LTS major changes `.nvmrc`
  and waits for the owner's merge (nothing merges itself since 2026-10-02).
  `.nvmrc` is the one place the Node major is named, so a
  Node update is a one-file change: the toolchain workflow's `GITHUB_TOKEN` may not
  push changes to `.github/workflows/*`. `tests/unit/checkToolchain.test.mjs` fails
  if a workflow names its own `node-version` or a setup-node step lacks
  `node-version-file: .nvmrc`. pnpm's newest release of the pinned major, once it is
  5 days old, changes `packageManager` in `package.json` and nothing else, and waits
  for the owner's merge. Nothing from npm runs in that job, beside its write token: CI
  installs the lockfile unchanged with the new pnpm (`--frozen-lockfile`), so one that
  wants it rewritten fails CI and reaches the owner. A newer pnpm major waits
  for dependabot-core#15904 to close, then comes the same way (pnpm 12's two-document
  lockfile hides every dependency from GitHub's dependency graph; 12.6.0 otherwise
  passed the full verify on 2026-09-25).
  A title is never used twice (issue or PR, open or closed): closing one skips that
  version for good. An open PR closes itself when the project reaches that version,
  or when a newer one on the same track gets its own PR (on a push, which raises
  nothing, only an open one counts: `--close-only`). The weekly run also rebuilds on
  `main` an open one `main` has moved into conflict with (the two pnpm tracks change
  the same line) when all its commits are the bot's, rebuilt on a freshly fetched
  `main`, and starts CI on one whose head has no run that decides (a lost dispatch, or
  only cancelled runs). Only the bot's own titles and pull requests count (author
  `github-actions[bot]`, never a fork's): anyone's PR with such a title neither blocks
  an update nor is closed or rebuilt; `patched-libraries.yml` filters the same way. A
  failed run opens one issue "Toolchain updates workflow failed". Node 24 was skipped on
  purpose (issue #11 closed); Node 26 arrives as a PR when it becomes LTS (late
  October 2026). The decision logic is `plan()` in `tools/check-toolchain.mjs`,
  unit-tested. Dependencies stay pinned by the lockfile on purpose (patches, AMO
  reproducibility); Dependabot's weekly grouped PRs are how they move, each release
  proposed once it is 5 days old (`cooldown` in `.github/dependabot.yml`; security
  updates skip the wait): npm minor/patch is split into `shipped-minor-and-patch`
  (fuse.js, mediabunny, onnxruntime-web, pako, sortablejs - the unpatched libraries
  `tools/sync-vendor.mjs` copies into the extension) and `tooling-minor-and-patch`
  (everything else), so a tooling update is not held back by a shipped one;
  `update-prs.yml` merges both when green (the shipped one then releases, see below).
- **`update-prs.yml`** (2026-09-29) runs after every completed CI run (`workflow_run`;
  for a run a workflow's token started, which sends none, `ci.yml`'s hand-off starts it by
  `workflow_dispatch`, and opens "Update PRs hand-off failed" when GitHub refuses all three
  tries) for this repository's `dependabot/*`, `toolchain/*`, `patched/*` and
  `sync/upstream` branches, and never checks out PR code. `gh pr list --head` lists a fork's
  pull request from a branch of the same name too: it, `sync-upstream.yml` and
  `mpv-updates.yml` drop those (`isCrossRepository`, #169; `tests/unit/workflowGh.test.mjs`
  fails for a `--head` list that does not ask). CI red: CI is started once more
  on the same commit, and that run decides (a new run, not a re-run: a re-run by this
  workflow's token would reach no workflow when it ends); not when CI already failed on
  that commit (an earlier run, or this run was re-run by hand), and when GitHub refuses
  to start it, this run decides. Still red, one comment @mentions the owner with a
  table of failed job, step and what the step checks, the last 40 lines of each failed
  log and `main`'s latest CI status, and the PR is labelled `ci-failed` and assigned to them. CI green:
  **nothing merges itself** (the owner's choice, 2026-10-02; from 2026-10-01 every kind
  did). One comment @mentions the owner, assigned: "ready to merge" for any kind (Dependabot
  npm, fsaunpack, GitHub Actions, the actionlint/zizmor images, toolchain Node and pnpm,
  patched libraries, the upstream sync) when it is not labelled `hold`, and only when its
  bot opened it (not a draft,
  against `main`) and its commits are the bot's or this workflow's merges of `main` (the
  owner's, made with their token; Dependabot's and those merges also signed by GitHub, as
  an author login is only the commit's e-mail, #170; an upstream sync's: in the history of
  upstream's `main`, `compare/<sha>...main` with `behind_by` 0 - not
  `repos/Andrews54757/FastStream/commits/<sha>`, which finds any commit of the fork network,
  this repository's own included), it changes only what its kind
  changes (`package.json` + `pnpm-lock.yaml`; for pnpm only `packageManager`, the lockfile
  untouched; fsaunpack's two files; `.nvmrc`; `.github/workflows` + `.github/actions`;
  the two Dockerfiles; a re-cut's `pnpm-workspace.yaml`, `patches/`, `tools/sync-vendor.mjs`;
  an upstream sync anything but `.github/`, with no "(CONFLICTS - resolve before merging)"
  commit and no added file that main's history has, i.e. one this project deleted), the
  dependency review passed, every version its lockfile adds is 7 days old (fsaunpack's
  `package-lock.json` read with jq), it is mergeable, it contains the newest `main`
  (otherwise GitHub's update-branch runs, CI restarts and that run decides, at most 3
  times), and, for an update that must not ship (all but the shipped libraries, patched
  libraries and the upstream sync), CI's build of the extension (the `faststream-bundles`
  artifact, both zips) is file-for-file identical to the latest release's zip and xpi
  apart from `manifest.json`'s version - `auto-release.yml`'s own test, so such a merge
  releases nothing. A shipped library's major comes on its own branch: it ships when one of
  its `dependency-name`s is in the `shipped-minor-and-patch` patterns of main's
  `.github/dependabot.yml` (unreadable: treated as tooling, whose build must not differ).
  GitHub Actions updates change workflow files, which `GITHUB_TOKEN` may not merge or
  update: that is done with the owner's fine-grained token, secret `UPDATE_PRS_TOKEN` of the
  `update-prs` environment
  (Contents, Pull requests, Workflows: write; docs/maintenance.md, "A token for workflow
  updates"), used only to bring such a branch up to date. The comment tells the owner to
  merge an upstream sync with a merge commit, keeping upstream's commits. His merge is his
  push: CI runs on `main`, and a green run of a merge that ships releases. A green PR that
  fails a check gets one comment @mentioning the owner - CI is green, and what to look at
  before merging - and is assigned to them. A comment with the same verdict
  as the last one is edited in place, so it sends no new mail: the owner hears when a
  verdict changes. The "behind main" check is the last one: a branch behind `main` is
  brought up to date and CI decides again, so what he merges is what CI tested. A branch
  update refused because the branch moved on meanwhile (Dependabot rebased it), or the PR
  was closed, is no failure: the new commit's CI run decides, or there is nothing to
  decide. A cancelled or skipped CI run decides nothing. The comment keeps one key per
  verdict, so a changed reason edits it without a new email. GitHub deletes a merged
  branch. `main`'s ruleset blocks force-pushes and deletion only, no required checks. If `update-prs.yml` itself fails, it
  opens one issue "Update PRs workflow failed" (the decide step has its own
  `timeout-minutes` under the job's, so running out of time fails the step and still
  reaches the report).
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
  rolled out October 19 - November 19, 2026 - and once more when `-latest` moves. Green runs are recorded as cache
  keys `runner-image-{next,latest}-<images>`; a failure opens one issue per image, closed by
  the next green run. A called CI run is not a "CI" run, so it never releases. Both calls
  grant the most any ci.yml job asks for (`contents: read`, `actions: write`,
  `issues: write`): GitHub refuses the whole run at startup when a called job asks for
  more, even one whose `if:` skips it, and as no job runs, no issue says so (#77's release
  hand-off stopped it so, 2026-09-30). A permission added to a ci.yml job goes in both
  calls; `tests/unit/workflowPermissions.test.mjs` fails until it does, and follows a
  called workflow's own calls down the chain. The image list is read by label shape
  (`ubuntu-NN.NN`, `windows-NNNN`); a new Ubuntu or Windows Server image with no label of
  that shape fails the run by name, as it would otherwise go unseen. Never put a
  `schedule:` in `ci.yml`: GitHub disables a public repo's scheduled workflows after 60 days
  without a commit, and it disables the whole file, push trigger included.
- **Keepalive** (2026-09-30): `keepalive.yml` (Wednesdays 09:20 UTC) keeps the scheduled
  workflows on without committing anything. Once main's last commit is 45 days old (or a
  dispatch sets `force`), it calls the API's enable endpoint for every workflow whose file
  has a `schedule:` trigger (read from the checkout, itself included) and whose state is
  `active` or `disabled_inactivity`; never one the owner disabled (`disabled_manually`).
  That the call restarts GitHub's 60-day count is not documented by GitHub; it is what the
  former keepalive-workflow action's API mode relied on. If they are disabled anyway:
  Actions tab, each workflow, "Enable workflow". A failed run opens "Keepalive failed".
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
  The MPV-mode specs joined the Windows job on 2026-09-28, after three five-job trials;
  the third, with the fix below, passed every MPV spec on the first attempt.
  The first two showed `toolbar-cycle-mpv` racing: its Off -> On step allowed no new CDN
  request, but the in-page player it opens loads the detected stream, on the runner from
  1.3 s before the iframe was found to 0.5 s after. It now checks what a reload changes
  (the page is loaded again, and the page cache-busts its stream URL on every load) and
  fails when `chrome.tabs.reload()` is added to that branch.
- **e2e config, 2026-09-25:** `autoXvfb: false` - Firefox runs `-headless`, and WebdriverIO
  otherwise spawns workers through `xvfb-run`, whose Ubuntu 26.04 version closes fd 3, the
  worker IPC channel: every worker died with `write EINVAL` (webdriverio#15685, unfixed in
  9.32.0; found by runner-images.yml before `ubuntu-latest` moves, from October 19).
  `specFileRetries: 1` - a failed spec file runs once more in a fresh browser: after the two
  bugs above were fixed, 3 x 12 parallel Windows runs showed only rare timing-budget
  overruns (a 6 s streamSaver write, a 30 s player start) with nothing pending. A real bug
  fails twice and still blocks the release. Since 2026-10-01 a retry leaves a trace
  (W5): each config's `onWorkerEnd` is `recordRetriedSpecs` (`tests/e2e/retriedSpecs.mjs`),
  which appends a spec file that was run again to `logs/retried.jsonl`; ci.yml lists them
  in the run's summary with a warning for each that passed only on its retry
  (`tests/e2e/reportRetried.mjs`), uploads the list as `e2e-retried`/`e2e-retried-windows`
  (14 days), and uploads `e2e-logs` for such a green job too, so the failed attempt's driver
  log is there. `flaky-specs.yml` (Mondays 06:20 UTC) folds a week of lists into one issue.
- **e2e harness, 2026-10-01 (F1, F4-F6):** a config's `before` hook runs its setup
  through `guardSetup` (`tests/e2e/setupGuard.mjs`): WebdriverIO only logs a hook's
  error, so a failed add-on install let every spec run without the extension (a probe
  test passed that way); now the mocha root hook fails each test with the setup's reason.
  Each spec file's attempt starts with an empty `.e2e-downloads` (a retry's save went to
  `name(1).png` and the spec read the first attempt's file). download-names keeps its
  extension page open until Firefox reports the download `complete`: closed at once, the
  page took its blob with it before Firefox read it, the CI flake. Single-file fixtures are
  written under `.partial` and renamed (`writeFixture`); `sample.mp4` is pinned by size and
  SHA-256 (`mp4Fixture.mjs`), and the fixtures made from it (`buildFixtures.mjs`) keep the
  recipe they were built by and are built again when it changes (2026-10-03, #256/#263);
  the extension config makes them too, so `pnpm run test:ext` works on a fresh clone.
  Both test servers answer a bad `%` escape with 400, end a response whose read fails, and
  read `bytes=-N` as the last N bytes (`serveFile.mjs`). A retried test's screenshot is
  numbered, not written over the first attempt's.
- **e2e test cap, 2026-09-30:** mocha stops a test at 120 s (the live suite at 300 s), and a
  test's own `this.timeout()` did not lift that under WebdriverIO. For a long local run (a
  timing sweep, a loop waiting for a rare race) set `E2E_TEST_TIMEOUT_MS`
  (`tests/e2e/testTimeout.mjs`); CI keeps the caps, so a hang there still ends the test.
- **The extension's console in the driver logs, 2026-10-01 (W6):** background.mjs's debug
  lines (`if (Logging)`) are on for a temporary install (`management.getSelf()` says
  `development`: the e2e suites' `installAddOn(xpi, true)`, `web-ext run`, about:debugging)
  and off for an installed release. The extension suites set
  `devtools.console.stdout.content`, so the background's and the player's console go to
  Firefox's stdout and into each spec's `geckodriver-<suite>-<spec>-<worker>-attempt<N>.log`
  (`e2e-logs` artifact on CI): grep `console.log:` for what the background detected
  (`Found source`), opened, and sent to mpv. About 13 KB per spec.
  `ext-specs/background-log.e2e.mjs` fails without either half.
- **Firefox's network log on CI, 2026-09-30:** with `E2E_MOZ_LOG=1` (CI's Windows playback
  step), the specs listed in `tests/e2e/mozLog.mjs` run with `MOZ_LOG` (cache2 and nsHttp),
  and an attempt with a failed test keeps its log under `logs-moz/`, uploaded as
  `e2e-moz-logs-windows` for 7 days; a passing attempt deletes its own. For loader-retry's
  "stalls before its body", which failed twice on the Windows runner with every retry stalled
  before reaching the server, and never locally.
- **e2e ports, 2026-09-27:** every fixed port a test server listens on is in
  41800-41999 (`tests/unit/e2ePorts.test.mjs` fails otherwise). Linux hands 32768-60999
  out to outgoing connections, and one that gets a test's port makes that server's
  `listen()` fail with `EADDRINUSE` - mpv-suspend's 41996 did on PR #40's CI. The Linux
  jobs (`ci.yml`, `firefox-beta.yml`, `firefox-stable.yml`) and `tools/linux/setup.sh`
  reserve the range (`net.ipv4.ip_local_reserved_ports`); measured here, 47 of 8,000
  OS-picked ports landed in it without the reservation and none with it. Windows hands
  out 49152-65535 and needs nothing.
- **One e2e run per machine at a time** (2026-09-28). The ports are fixed, and WSL's
  mirrored networking shares them with Windows, so a second run - another checkout, or
  `verify:linux` - finds its ports taken. wdio only logs an error thrown in `onPrepare`
  and runs the specs anyway, so they were answered by the other run's server and tested
  its build (a keybind spec saw a fix it was checking missing; with a port held by
  another process, a spec passed and wdio exited 0). The suites' servers now start
  through `tests/e2e/listen-or-stop.mjs`, which ends the run with "Port N is already in
  use" instead.
- **Every action is pinned to a commit SHA** with the exact version as a comment (and the
  actionlint image by digest, in `.github/actionlint/Dockerfile`, since Dependabot does
  not update a `docker://` line); Dependabot bumps them, the workflows' and the composite
  actions' (`/.github/actions/*`), minor/patch grouped weekly, and wait for the owner's
  merge like every update.
  `tests/unit/checkToolchain.test.mjs` fails for a pin in a form Dependabot does not update. Checked
  against `git ls-remote` when pinned; `dependency-review-action`'s `v5` is a branch.
- **No CVE watch for the vendored components outside the lockfile** (vtt.js, knob,
  StreamSaver): measured 2026-09-25, OSV has
  never recorded a vulnerability for any of them, so a workflow could never fire. They are
  covered by the provenance checks instead. The lockfile-backed libraries are covered by
  Dependabot alerts (OSV's only hls.js record, MAL-2026-3019, is two canary builds, not 1.7.3);
  since 2026-09-30 that includes the ONNX Runtime wasm, which ships as `onnxruntime-web`
  publishes it.
- **No `reminders.yml` any more** (removed 2026-10-04): it commented on open issues
  labelled `reminder: <month>` on the 1st of that month. The only issue that ever carried
  such a label (#10) was closed, so it had nothing to do.
- **No `mpv-host-changed.yml` any more** (removed 2026-10-04; it emailed "run install.ps1
  again" through issue #73 after a push that changed the host). The host now sends its
  version with every answer, and the extension says when the installed copy is older: see
  "The host's version" under "MPV mode and the native host". `update-local.cmd` installs
  it again.
- **No `wsl-releases.yml` any more** (removed 2026-10-04; it opened an issue "WSL update:
  <version>" for each microsoft/WSL release, which the owner closed by hand, GitHub not
  seeing the PC). `update-local.cmd` checks WSL itself now: see "Commands".
- **`flaky-specs.yml`** (Mondays, 06:20 UTC), 2026-10-01: the spec files CI ran again
  (`e2e-retried` and `e2e-retried-windows` artifacts, all of this repository's branches, the
  last 7 days; never a fork's pull request, whose CI run writes the list with its own code,
  and the texts are cut down to a path's characters, #166) in one
  issue "Flaky e2e specs: week to <date>", assigned + @mention: per spec, how often it was
  run again, how often its retry passed, suites, branches and runs. It finds the artifacts
  through the repository's artifact list (`actions/artifacts?name=`), not run by run. The
  next week's issue closes it, and so does a week with no retry. Permissions: `actions:
  read`, `issues: write`; no checkout. Tested by `tests/workflows/flaky-specs.test.sh`.
- **`security-alerts.yml`** (daily, 06:30 UTC; and on a push to `main` that changes a
  lockfile, closing only), 2026-09-30: Dependabot could not make the security fix for
  brace-expansion (three majors in the lockfile), its failed run emailed no one, and 12
  alerts sat on the Security tab unseen. For an open alert over 6 hours old with no open
  Dependabot PR naming the package (title, the links before the first `<details>`, a
  grouped update's "Updates" lines), it opens "Security alert: <package>", assigned +
  @mention; a later alert edits it and comments. The body's `<!-- alerts: ... -->` line
  records what it listed: a listed alert is never raised again, so closing by hand skips.
  The advisory summary's `<` is escaped in the table, as a marker in it would hide that
  line from the next run (which would comment every day). Closes itself when no alert for the package is open. `vulnerability-alerts: read` is
  what lets `GITHUB_TOKEN` list the alerts (403 without it, checked on a probe branch);
  actionlint 1.7.12, the latest, does not know that permission, so
  `.github/actionlint.yaml` ignores that one message for that one file
  (rhysd/actionlint#666). `tests/workflows/security-alerts.test.sh`: 37 scenarios, and 25
  mutations of the workflow each fail it. Its stub `gh` applies `--jq` with jq, as CI has
  it; the real gh uses gojq, built in, and the filters avoid the one difference found
  (jq 1.7 splits `""` into `[]`, gojq into `[""]`). The test passed with gojq 0.12.19
  swapped in too.
- **The Security tab's count also holds CodeQL code scanning** (2026-10-03). GitHub's
  default setup runs it on every push to `main` (Actions shows it as "CodeQL",
  `dynamic/github-code-scanning/codeql`; there is no workflow file), JavaScript and
  Actions, and security-alerts.yml does not see its alerts. It runs 105 JavaScript queries
  (read off a CodeQL job log's `Loaded .../javascript-queries/...` lines;
  `javascript-code-scanning.qls` has only 89) with **local sources on**: environment
  variables, files read, command-line arguments and stdin count as untrusted. The API is not
  reachable from a session without `gh`, so reproduce a scan: the CodeQL bundle from
  github/codeql-action's releases, `codeql database create --language=javascript-typescript`
  on `git archive origin/main`, then `database analyze` with those 105 queries,
  `--threat-model=local` and `--rerun` (a cached result from a run without it is reused
  silently). On `main` at c6372bc that gives 70 results, nearly all in tools and tests and
  dismissed on the Security tab, so compare a branch against `main`, never against zero, and
  ask the owner which alerts are open. On 2026-10-04 the open ones were 2 Dependabot
  (node-forge, braces: dev-only, no fixed release) and 5 CodeQL: `FASTSTREAM_MPV_PATH` into
  the mpv host's `statSync` (the variable is gone; `config.json`'s `mpvPath` does the same),
  `FS_EXT_BUILD` into e2e log names (`BUILD` is now one of the two constants),
  instagramInject.test.mjs running a file read (now a `?raw` import), and the MP4 fixture
  download in `mp4Fixture.mjs` (js/http-to-file-access; checked against its pinned SHA-256
  before it is written, so dismissed as a false positive). #320's five fixes (the direct
  player's `video.src`, the fsaunpack rate limiter, firefox.e2e.mjs) were real but were not
  open alerts: the count matched by chance, a mistake not to repeat.
- **`vendored-updates.yml`** (daily, 06:45 UTC), 2026-10-01, U1: the two vendored files no
  other workflow watches. **The silero VAD model:** a newer snakers4/silero-vad release whose
  half-precision model has other bytes gets a PR on `vendored/silero-vad-<tag>` with the
  model replaced and TAG/SHA256 moved in `tools/verify-vad.mjs`, and CI dispatched on it
  (the reference e2e decides); update-prs.yml leaves `vendored/` branches to the owner. A
  model missing at its path gets an issue, "Silero VAD <tag>: the model file moved".
  **vtt.js:** a dash.js release that changes `contrib/videojs-vtt.js/vtt.js` gets an issue,
  "vtt.js changed in dash.js <tag>", with the changed-line count and a compare link: a
  person moves `tools/verify-vtt.mjs`'s tag and re-runs `verify:vtt`. Each item is assigned
  + @mention, is never raised twice (closing it skips that release), closes itself once its
  pin reaches its tag, and a newer release's item closes older ones. On 2026-10-01 both
  were current in effect: silero-vad v6.2.3 and dash.js v5.2.1 publish the same bytes as
  the pins (v6.2.1, v5.1.0). `tests/workflows/vendored-updates.test.sh`: 10 scenarios
  (real git pushing to a local bare origin), and 7 undone rules each fail it.
  **Adapted copies** (job `sources`, 2026-10-01): `tools/vendored-sources.json` lists code
  copied from other projects and changed here (knob.mjs from jherrm/knobs, StreamSaver.mjs,
  crosstalk/fft.mjs from indutny/fft.js, vad/vad.mjs from ricky0123/vad), each with the
  upstream path and the commit it was taken from. When upstream's newest commit to that path
  is not in the ref (compare status behind or diverged), an issue "Vendored source changed
  upstream: <name> (<repo> <sha8>)" lists the commits after the ref that changed it; port by
  hand, move the ref, and it closes itself. The lists are read on fds 3/4 (gh.exe via WSL
  swallowed stdin and ended the loop after the first source). On 2026-10-01 knob (16 commits
  after its 2012 pin) and vad-web (37 since 2023-03-30) were behind, StreamSaver and fft.js
  current. `tests/workflows/vendored-sources.test.sh`: 8 scenarios, 10 undone rules caught.
- **`dependency-review.yml`** fails a PR that adds a package with a high-severity advisory.
  Since 2026-09-30 it also runs on `workflow_dispatch`, which `sync-upstream.yml` and
  `patched-libraries.yml` send next to CI's: their PRs are opened by the workflow token, so
  the `pull_request` run waits for an approval, and the two PR kinds that change the
  lockfile from outside Dependabot went unreviewed. A dispatched run compares `main` with
  the commit's hash (`base-ref`/`head-ref`; the compare API answers 404 for an unencoded
  branch name with a `/`). Checked on two probe branches off `main`: brace-expansion
  2.1.4 -> 2.1.3 failed on its three high advisories, the fixed lockfile passed.
  `update-prs.yml` names a review that did not pass in its comment on those PRs.
- **`build.yml` was removed**: CI already builds and uploads the same zips.
- **`sync-upstream.yml`** runs daily (06:00 UTC) and on every push to `main`. The PR is
  assigned to the owner and @mentions them (a bot PR alone is not emailed); a comment
  with the mention follows only when upstream itself moved. Upstream release tags on the
  incoming commits are named in the title (tags fetched to `refs/upstream-tags/`, never
  `refs/tags/`). A push-triggered run only closes the PR once `main` holds every upstream
  commit; it never rebuilds it. The failure issue closes on the next clean run.
  `update-prs.yml` calls the PR ready to merge (with a merge commit) once CI is green when
  it is clean (no conflict, nothing under `.github/`, no deleted file back, only upstream's
  commits); otherwise it says what to look at. **A merge that changes anything under
  `.github/` gets no CI and no dependency review** (#163, 2026-10-03): a dispatched run
  takes its workflow file from the branch, so upstream's workflow would run with this
  repository's token and secrets; the PR says so, and the owner starts both after reading
  the change. `tests/workflows/sync-upstream.test.sh` (real git, stub `gh`). And the secrets
  that can do harm are no repository secrets any more: the AMO keys are the `release`
  environment's (main and tags `v*` only), `UPDATE_PRS_TOKEN` the `update-prs` one's (main
  only), so no other branch's workflow can read them; the jobs that use them name the
  environment with `deployment: false` (no deployment records), and
  `tests/unit/workflowSecrets.test.mjs` fails for a job that reads one without it
  (docs/maintenance.md, "Secrets in environments").
- **`patched-libraries.yml`** + `tools/check-patched-updates.mjs` + `tools/recut-patch.mjs`
  (2026-09-25): Dependabot ignores the six libraries in `patchedDependencies` (a bump
  leaves the patch unapplied), so for each new version this re-cuts the patch itself.
  Clean, checks passed: a PR from `patched/<name>-<version>`, with CI dispatched on it (a
  push by `GITHUB_TOKEN` starts no workflow; `gh workflow run` does). Conflict or failed
  check: an issue with the tool's report. Too new for pnpm's `minimumReleaseAge`
  (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`): nothing until the next daily run. Both
  assigned + @mention, never raised twice (issue or PR titles, any state), closed when
  the patch is cut against that version or newer; closing one by hand skips the
  version. Runbook: `docs/updating-patched-libraries.md`. The tool reproduces every
  current patch byte for byte and replays the hand-cut hls.js 1.7.2 -> 1.7.3 upgrade
  exactly; the workflow step was dry-run in WSL with a stub `gh` and stub tools (every
  path: PR, issue, too new, already raised, caught up, no longer patched, push).
  `tests/unit/checkPatchedUpdates.test.mjs` fails if Dependabot's ignore list and
  `patchedDependencies` drift apart; `tests/unit/recutPatch.test.mjs` covers the tool.
- All of it was dry-run with a stub `gh` against the real upstream history (sync: adopted
  -> closed, push -> no rebuild, new release named, comment only on upstream movement;
  patched libraries: open once, no duplicates, close when caught up or unpatched).
- **`mutation-tests.yml`** (Mondays 06:40 UTC), 2026-10-01, T4: Stryker
  (`stryker.config.mjs`, `pnpm run test:mutation`) over 25 pure-logic modules with unit
  tests (10 small ones added 2026-10-03, #253; the config says which wait, and why). A report, not a gate: the run summary gets a table per file
  (`tools/mutation-report.mjs`), the HTML report is the `mutation-reports` artifact, and when
  the unit tests missed mutants (survived, or no test reaches them), one issue "Mutation
  testing: week to <date>" lists them, assigned + @mention; next week's replaces it, a week
  with all caught closes it. **The command runner**, not the vitest one: every mutant runs the
  whole unit suite (`__STRYKER_ACTIVE_MUTANT__`), about 1.2 s each with 4 workers. Stryker's
  vitest runner 10.0.0 (August 2026) predates vitest 5 and switched no mutant on there (every
  one "survived"); switch back once a release supports vitest 5, and per-test coverage makes
  the run far faster. The sandbox leaves out `tsconfig.json`: Stryker rewrites it through
  TypeScript's JS API, which TypeScript 7 does not have. `tests/workflows/mutation-tests.test.sh`.
  Baseline, 2026-10-01 (73 min locally): 71.8% of 3,614 mutants caught; the weakest are the
  mpv host (47.7%), MpvBackend (58.4%), SubtitleUtils (63.2%) and TabTracker (68.4%), the
  best SubtitleSyncUtils (96%), MultiRegexMatcher, UrlMatchList and StreamPick (92%).

## Rules

- **Never hand-edit `chrome/player/modules/*`** — vendored third-party code
  (dash.mjs 3.3 MB, hls.mjs 1.5 MB). Excluded from eslint and
  tsconfig; they stall the language server otherwise. Those two and a dozen more are
  copied from `node_modules` by `tools/sync-vendor.mjs` on every build and gitignored, so
  a change to one of them goes into a pnpm patch (`docs/updating-patched-libraries.md`).
  CI runs the unit tests before the build makes those copies, so `vitest.config.mjs` points
  the ones copied unchanged (hls.mjs, dash.mjs, mp4box, Mediabunny) at their npm builds: a
  unit test can run the save's real demuxer and MP4 writers (`tests/unit/hls2mp4.test.mjs`).
- **Property tests for what a page feeds in** (2026-10-01, T8): `tests/unit/*.property.test.mjs`
  run fast-check against SubtitleUtils (SRT/VTT/XML), StreamLength (m3u8/mpd), URLUtils,
  DownloadFilename and the host's `readMessage`: no throw on arbitrary text, round trips,
  and models (an HLS length is the sum of its finite positive EXTINFs). Random text rarely
  hits the cases that matter, so each rule has a targeted generator too (device names,
  emoji at the 200-character cut, broken EXTINF values); 7 broken rules were each caught.
  A failure prints its seed and shrunk input: reproduce with `fc.assert(..., {seed})`.
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
  from `sync/upstream` when Andrew has commits `main` lacks. It waits for the owner like
  every PR (`update-prs.yml` only says whether it is ready): close it to skip,
  merge it to take. `docs/upstream-sync-log.md` records what was decided by hand and why. `pr/*`
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

hls.js is the npm release, **1.7.3**, plus `patches/hls.js@1.7.3.patch` (the extra
demuxer exports, `outputSamples` on the remux result and the VTT part-loading guard),
which pnpm applies at install; dash.js is `dashjs@5.2.1` with its patch the same way. The
in-tree hls.js they replaced was 1.6.9 with 466 lines of divergence across 22 hunks (1.3%),
not a fork; that diff is kept as `docs/hls.js-1.6.9-faststream.patch`. See
[docs/vendored-libraries.md](docs/vendored-libraries.md) for the hunk classification.

Do not try to replace these with wrapper classes — the extra demuxer exports
that `hls2mp4/transmuxer.mjs` needs have no public-API equivalent in any
hls.js release, including 1.7.1.

## The binary blobs are identifiable published artifacts

Not mystery blobs — every one has a known upstream, version and licence, so
they belong in the Phase 7 npm migration rather than being removed:

| File | What it is | npm |
|---|---|---|
| `vad/ort.wasm.mjs` + `ort-wasm-simd-threaded.mjs` + `ort-wasm-simd-threaded.wasm` | **ONNX Runtime Web 1.30.0**, Microsoft, MIT | `onnxruntime-web@1.30.0` |
| `vad/silero_vad_half.onnx` | Silero VAD model, `.onnx`, MIT | published model, silero-vad tag v6.2.1 |
| `remux/mediabunny.mjs` | **Mediabunny 1.60.0**, MPL-2.0 (file-level: shipped unmodified, its licence header kept) | `mediabunny@1.60.0` |

`vad/LICENSE.md` is already in-tree. **`ort.wasm.mjs` carried the comment
"Minified to reduce loading time (https://minify-js.com/)"** — Andrew
minified it by hand, which is precisely the modified-third-party-library
problem AMO objects to. It has shipped as the npm dist since (all three ONNX
Runtime files, since 2026-09-30).

VAD is lazily loaded via dynamic `import()` from
`analyzer/AudioAnalyzerNode.mjs:63`, so it only costs anything when the
audio analyzer runs.

## Type checking

`tsconfig.json` type checks without emitting. `checkJs` is off; files opt in
with `// @ts-check` on line 1 (line 2 after a shebang). `pnpm run typecheck` is
gated in CI, and `tests/unit/typeChecked.test.mjs` lists the opted-in files: taking
the comment out of one, or opting one in without listing it, fails it (T5's ratchet).

Opted in: `background.mjs` (2026-10-01) and the rest of `chrome/background/` but
`NetRequestRuleManager` (1 error), `StreamLength`, and the mpv host
(`native-host/faststream-mpv-host.mjs`). The types are Chrome's (`@types/chrome`,
which matches the `chrome.*` calls, callbacks included) plus Node's (the host, tests
and tools), and `types/firefox-chrome.d.ts` adds the Firefox-only fields read here
(`cookieStoreId`). background.mjs's own fixes were JSDoc, a few
`undefined` checks that return what the code returned before (through a throw), and
one guard: a message from a page outside any tab is no longer handled as a tab's. The
player's files are next; fix what tsc reports only with the playback suites to hand.

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

- **"Auto-enable URLs" parsing** (review, 2026-09-28): the background had its own
  parser for the list. A `-domain` line - "You can now exclude specific domains by
  prepending -" (upstream #241, still open there) - set `domain` but left `match`
  null and was dropped, so the site was neither excluded from auto-enable nor from the
  "Use player to load" redirect rule's `excludedRequestDomains`; a lone `~` became the
  empty regex and auto-enabled every site. The list is now a
  `UrlMatchList({domainEntriesExclude: true})` (a `-domain` entry is an exclusion there,
  a plain hostname match in the MPV allowlist), matched case-insensitively like the
  allowlist, and `options_autourl_body` documents `-`. A unit test keeps a second parser
  from coming back. Candidate for upstream PR ("fixes #241").
- **Custom source patterns** (review, 2026-09-28): `loadCustomPatternsFile` took the
  text between the first character and the last slash whatever it was, so `hls` alone
  was the empty regex and every response became an HLS source. Parsed by
  `CustomSourcePatterns.mjs` now (`<type> /<regex>/<flags>`, bad lines reported and left
  out); `MultiRegexMatcher` refuses the empty regex and drops `g`/`y`, with which a
  pattern never matched. Candidate for upstream PR.
- **A frame stuck "opening a player"** (review, 2026-09-28): `openPlayer` cleared
  `frame.playerOpening` only on `'no_video'`; a failed `OPEN_PLAYER` (frame navigated
  away, no content script) left it set, and that frame never got a player again.
  `BackgroundUtils.isPlayerOpeningResponse` names the answers that keep it, and a unit
  test ties them to what `content.js` sends. Candidate for upstream PR.
- `miniglob.mjs` `cleanGlobPath` shadowed the module-level `volumeNameLen`
  with a parameter of the same name, then called it. Callers pass a number,
  so **every Windows build failed** with `TypeError: volumeNameLen is not a
  function`. Fixed in `ab0719d`; candidate for upstream PR.
- No `.gitattributes`, so Windows checkouts got CRLF and eslint's
  `linebreak-style` reported 2352 errors. Fixed in `e81b036`.
- **The subtitle resync tool** (`SubtitleSyncer.mjs`, the hourglass on a
  track; all three from upstream's 2023 code, fixed 2026-09-27):
  `renderTracks()` picked the cues in view with `start <= max || end >= min`,
  true for every cue, so the whole track sat in the DOM and every cue was
  repositioned on each frame (300 elements instead of ~18 in the spec);
  `shiftSubtitles()` (the ShiftSubtitlesLater/Earlier keys while the tool is
  open) ended with a call to an `onVideoTimeUpdate()` that SubtitleSyncer does
  not have - the TypeError never showed because `EventEmitter.emit` catches a
  handler's error and only logs it; and the track row started a drag on any
  button, so after a right-click (whose context menu swallows the mouseup) the
  cues followed the pointer. The tool now also shows the track's total shift
  (`SubtitleTrack.shiftTotal`, "Shifted subtitles +1.40s"). Pure helpers in
  `utils/SubtitleSyncUtils.mjs` (unit-tested); `tests/e2e/specs/subtitle-sync.e2e.mjs`
  fails on each of the three against the old code. A port of this tool lives
  in Nawid's mpv config (`subtitle-sync.lua`), with the audio drawn by a second
  mpv instead of the VAD model.
