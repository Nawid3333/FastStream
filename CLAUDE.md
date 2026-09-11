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

Goal: an AMO-compliant Firefox build with a modern, testable dev workflow,
without breaking Chrome and without making upstream merges painful.

## Commands

```bash
pnpm install              # pnpm 11, pinned via packageManager
pnpm run build            # 4 targets -> built/*.zip, unpacked dirs deleted
pnpm run build:keep       # same, but keeps build_*/ for web-ext
pnpm run lint             # eslint (must stay at 0)
pnpm run lint:amo         # web-ext lint on build_firefox_amo (--self-hosted)
pnpm run start:ff         # web-ext run — launches Firefox with the extension
pnpm test                 # vitest
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

Single-instance reuse goes over mpv's JSON IPC on a named pipe. Only
instances this host starts are given `--input-ipc-server`, which is what
stops it ever loading into — or closing — an mpv the user opened themselves.
A stale pipe simply fails to connect and a fresh instance starts.

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
workflow's asset list, and CI's Chromium E2E step comments (that step
itself stays — it tests the `web` target across engines, not the extension).
`chromeSourceDir` (`chrome/`) is still the shared source directory for every
remaining target; only the two Chrome-flavored *build outputs* are gone.

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

## Rules

- **Never hand-edit `chrome/player/modules/*`** — vendored third-party code
  (dash.mjs 3.5 MB, hls.mjs 1.3 MB, yt.mjs 1.3 MB). Excluded from eslint and
  tsconfig; they stall the language server otherwise.
- **`build.mjs` rewrites `chrome/manifest.json` in place** on every run to
  sync the version from `package.json`. The tree is dirty after each build.
  Don't sweep it into an unrelated commit.
- `incognito: "split"` is deliberately deleted for Firefox builds — Gecko
  doesn't support split mode. Not a bug.
- Branches: `main` mirrors upstream, `dev/mv3-modernization` is the work
  branch, `pr/*` branches get cut fresh off `upstream/main`.

## AMO lint (firefox-amo, current: 0 errors / 3 warnings, needs `--self-hosted`)

Verified 2026-09-10, after YouTube support was removed entirely (see
"YouTube removal" below): `firefox-amo` is **0 errors, 0 notices, 3
warnings**; `firefox-github` is **0 errors, 0 notices, 4 warnings**.

The 3 warnings both targets share are all in vendored libraries: `vtt.mjs`
and `vad/ort.wasm.mjs` (`UNSAFE_VAR_ASSIGNMENT`), `dash.mjs`'s webpack
bootstrap eval (`DANGEROUS_EVAL`) — see `docs/amo-linter-warnings.md` for why
each is safe-left-alone. `firefox-github`'s extra warning is
`MISSING_DATA_COLLECTION_PERMISSIONS`, expected — only `firefox-amo`
declares that key. Neither target has a `players/PlayerLoader.mjs` or
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
