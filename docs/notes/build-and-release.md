# Building and releasing

> Why the code in this area is as it is. A date on an entry is when it was learned; where
> the code and its tests say otherwise, they win. A section named in quotes may be in
> another file: [README.md](README.md) lists every section.

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
| `firefox-amo` | EXTENSION, FIREFOX, NO_UPDATE_CHECKER | AMO target; min version 153, declares data_collection_permissions |
| `web` | WEB, NO_UPDATE_CHECKER | faststream.online, no extension APIs |

`buildFirefoxAmo()` was written but never invoked (commit "Remove firefox
dist build for now"). Re-enabled in `7ed4723`.

The 12 `EnvUtils.isChrome()`/`isFirefox()` branches elsewhere in the
codebase (playback-rate caps, the 7.1-audio workaround, OPFS backend
selection, SponsorBlock's extension ID), left in place on 2026-09-11, went
with the rest of Chrome's code on 2026-09-20; none is left.

**The GitHub build's update check** (`UpdateChecker.mjs` and its block in
`options.mjs`, both `NO_UPDATE_CHECKER`, so the AMO and web builds have none of
it). Since 2026-11-13 (a review) `UpdateChecker.refreshUpdateData` decides: a
check is due 12 hours after the last one, failed or not, or when none ran, and a
failed check keeps the version known. The options page, an iframe in every
player, stores `updateData` only after a check. Before, it wrote the data to
`storage.local` at every load, which fired `storage.onChanged` in every open
options page; a failed check wrote null over the version known, and with no
version known the next player asked GitHub again at once: after one failure,
every player opened fetched `package.json`, with no back-off.
`UpdateChecker.test.mjs`.

**`custom/instagram_inject.js` is web-accessible to Instagram's pages only**
(2026-11-13, a review). It shared the player page's `web_accessible_resources`
entry, open to `<all_urls>`, though only `instagram_content.js` puts it in a page,
and that runs on `https://www.instagram.com/*` only: any site could load it into
itself. It has an entry of its own now, with the content script's match. The
player's page stays open to every page (a page frames it: mpv.md, "A player a
page frames itself"). `customSiteScripts.test.mjs`.

## Releasing (auto-release.yml)

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
rejected, or still incomplete after 24 h -> one issue, closed when the
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

## AMO lint (firefox-amo, current: 0 errors / 0 warnings, needs `--self-hosted`)

Verified 2026-10-27: both `firefox-amo` and `firefox-github` are **0 errors, 0 notices,
0 warnings**. (Until then 2: `vtt.mjs` line 1181's `UNSAFE_VAR_ASSIGNMENT` and
`dash.mjs` line 81180's webpack bootstrap `DANGEROUS_EVAL`, both in vendored libraries,
fixed as `docs/amo-linter-warnings.md` says; `firefox-github` had a 4th until 2026-09-24,
see below; both had ONNX Runtime's `vad/ort.wasm.mjs` until the speech detector went on
2026-10-10.) `firefox-github` used to add
`MISSING_DATA_COLLECTION_PERMISSIONS`; it now declares
`data_collection_permissions: {required: ['none']}` like `firefox-amo`, which
needed its `strict_min_version` raised from 136 to 142 (the key needs 140+,
Android 142+). The only versions that dropped, 136-139, were long out of
support and never ESR. Since 2026-10-14 both require 153, where
Firefox gained the picture-in-picture API the player's PiP button calls. Neither target has a `players/PlayerLoader.mjs` or
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

**Both lint scripts pass `--warnings-as-errors` (2026-11-17).** web-ext lint exits 0 with
warnings (tried on a one-file extension with an `innerHTML` write: exit 0, and 1 with the
flag), so CI let a new warning in unseen while the count the owner asked for is 0
(`docs/amo-linter-warnings.md`). A dependency update that brings one now turns its PR red.

## Firefox for Android (2026-11-20)

The owner's decision (issue #771): Android is supported as a bonus, tested by hand on his
phone; the desktop on Windows 11 stays the focus. One code base and one signed file for both:
both Firefox builds declare `gecko_android` with the desktop's floor, and the parts Android
lacks switch themselves off there. No Android branch, build or release.

**What Firefox for Android lacks, of what FastStream uses** (Mozilla's browser-compat-data
8.1.4, every `chrome.*`/`browser.*` member in `chrome/` outside `modules/`): `commands`
(keyboard shortcuts), `menus` (the right-click menu), `windows`, and
`runtime.connectNative`/`sendNativeMessage` (no helper, so no MPV mode, and with it no
upscaling, which is mpv's). `tabs.query` may return only some tabs there. Firefox for Android
has no WebGPU either (not used since ONNX Runtime left, `libraries.md`).

**What it did before the guards:** `chrome.commands.onCommand.addListener` at the top of
`background.mjs` threw, so nothing after it was registered: no `runtime.onMessage`, no
`webRequest` listener; the toolbar button's listener came before it. The reporter's
"toggling does nothing" (Nightly for Android); reproduced in the background harness with
Android's API set: no message listener and none of the `webRequest` listeners.

**How each is switched off:** shortcuts: the listener and `onCancelledShortcut` only when
`chrome.commands` exists. The menu was already behind `if (menus)`. Window fullscreen:
`setCarriedFullscreen` answers `exit` without `chrome.windows`, so the next episode plays in
the page. MPV: `loadOptions` turns `mpvMode` off in the background when
`runtime.connectNative` is missing (settings brought from a desktop); the options page hides
the MPV toggle and the MPV section, and offers no MPV suggestion, and the player hides its MPV
button, both by `EnvUtils.isAndroid()`. The player and the options page are frames in pages,
where Firefox gives an extension fewer APIs, so they ask for the platform
(`runtime.getPlatformInfo`) instead of testing for `connectNative`; the background has every
API and tests the features themselves. Until Firefox answers, `isAndroid()` guesses from the
user agent, which a user agent override (a desktop that says Android) or Android's desktop-site
mode makes wrong, so both pages decide again once the answer is there, either way, and the
suggestion waits for it.

**What keeps it working:** `tests/unit/firefoxAndroid.test.mjs` loads the background with
Android's API set and expects every listener the desktop has but those of what Android
lacks, and the toolbar button, a cancelled key, a carried fullscreen and MPV mode from saved
settings to work there. It also reads Mozilla's data (through web-ext's addons-linter, no
package of its own) for every API the code uses: a new one Android lacks fails it until it is
guarded and listed. Mozilla's linter does not catch these: `web-ext lint --self-hosted` on
the AMO build with `gecko_android` gives 0 errors, 0 warnings, 0 notices. Between Dependabot's
updates, the Firefox API watch reports what each release changes for Android's WebExtensions
(`workflows.md`, "Firefox API watch").

**In an emulator (2026-11-20):** `.github/workflows/android.yml` runs `tests/android/smoke.mjs`
on every pull request and push to `main`, beside CI and not a release gate: Firefox for
Android's current release (product-details) on an API 35 x86_64 emulator with software
rendering, driven by geckodriver 0.37.1, the first that drives a release build (it has Firefox
read its configuration through `am set-debug-app`; no USB debugging). The APK must carry
Mozilla's release signing certificate (`apksigner`, pinned digest). The GitHub build installs
as a temporary add-on, its welcome page opens, its background answers the player page, the
player plays the pinned `sample.mp4`, served from the runner through `adb reverse`; with "Use
player to play MP4 videos" on, a direct `.mp4` link opens in the player and plays, and with the
test site in "Auto-enable URLs", FastStream's player takes the place of a page's own `<video>`
and plays it. The browser console (read in the chrome context) must hold no script error from
the extension's files, after its start and at the end. What the script relies on, measured on
Firefox for Android 160.0.1:
- `nativeMessaging` makes it refuse a temporary add-on ("Extension is invalid"; bisected, every
  other permission passes). The signed xpi with it installs normally, as on the owner's phone.
  The test package leaves it out: there is no mpv on Android.
- Extension pages are privileged for WebDriver: geckodriver runs scripts there only with
  `--allow-system-access`, and navigates to no `moz-extension://` address; the welcome tab, on
  that origin, navigates itself.
- Firefox 153+ waits at its first-run screens under automation unless started with
  `--ez automationtest true` (the session's `androidIntentArguments`).
- WebDriver's screenshot leaves the video out (black); the device's own capture shows it.
- Without a GPU the emulator is slow: the player can take longer than WebDriver's 30 s script
  limit, and its page is there before `window.fastStream` is.
- A direct `.mp4` link stays in Firefox's own viewer by default, as on the desktop ("Use player
  to play MP4 videos" is off).
- `tabs.onUpdated` takes no filter there (browser-compat-data agrees): `addListener(fn,
  {properties})` throws "Incorrect argument types". Until `BackgroundUtils.onTabUpdated`, which
  then adds the listener without it and passes on the same changes, that stopped the background
  before `runtime.onMessage`: the welcome page still opened, but options, the player's messages
  and the `.mp4` redirect rule never reached it. The unit tests' Android stand-in refuses the
  filter the same way (`tests/unit/firefoxAndroid.test.mjs`).
- A player page that goes while a message it sent awaits its answer (`FRAME_REMOVED` on
  pagehide) leaves Firefox's own "Promise rejected after context unloaded: Actor 'Conduits'
  destroyed before query 'RuntimeMessage' was resolved" in the console, under the player's file.
  The message arrives; no code of the page can catch that report, so the console check leaves
  out that one reason (any other rejection after unload still counts).

Locally, after `pnpm run build:keep`: an x86_64 AVD (API 35, default image) with Firefox for
Android's x86_64 APK, `geckodriver --allow-system-access`, then `node tests/android/smoke.mjs
--build build_firefox_github --media tests/e2e/fixtures/sample.mp4 --geckodriver
http://127.0.0.1:4444 --device <serial> --adb <adb>`. On Windows the emulator needs the Windows
Hypervisor Platform feature; in WSL 2 it runs on KVM (`/dev/kvm`, nested virtualisation). With
WSL's mirrored networking Windows and WSL share ports: one emulator and one adb server at a
time, or another `-port`.

**Installing it on a phone:** AMO's listed channel, where Android users normally find
add-ons, is closed to this fork until the licence question in `CLAUDE.md` is settled. The
signed xpi of a release installs on Firefox for Android through a hidden menu: Settings,
About Firefox, tap the logo five times, then Settings, "Install extension from file" (Mozilla
staff on Discourse, June 2025; one report says Android 10 or later). A link to the xpi only
downloads it there. Not established: whether Firefox for Android updates it from `update_url`
by itself. GeckoView's documentation says its update call uses `update_url`; to be checked
on the owner's phone with the next release.

**Not done yet:** the player and the options page on a touchscreen (bigger controls, taps,
a narrow layout), and memory defaults for a phone. Built from what the owner finds on his
phone.

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
