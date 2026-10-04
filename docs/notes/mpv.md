# MPV mode and the native host

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

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

**A page Back brings back with its in-page player (measured 2026-10-04, #286).** Firefox
157 caches a page whose in-page player is up, an MP4 (MediaSource) player and a direct one
alike, and Back gives it back with the player in it (`pagehide` and `pageshow` persisted,
the iframe there both times). Its `FRAME_ADDED` makes the background reset the page's
frames, the player's with them. Right after the `pageshow` the player goes: the tab's URL
changed, and the background's `REMOVE_PLAYERS` reaches the page (the only other caller of
`removePlayers` is a click on a link, and there was none). So no player outlives the
background's memory of it, and nothing was changed for #286; content-cleanup.e2e.mjs
("takes down the player a page brings back ...") pins it.

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

**MPV shortcut: Alt+F since 2026-10-04 (Ctrl+Shift+U before), the `toggle_mpv`
command (2026-09-26).** The owner switched to Alt+F (tested: nothing in their Firefox
uses it) and made it the default, so new installs get it the way Ctrl+Shift+F is the
player's; a user who rebound the key in about:addons keeps theirs. The paragraphs below
were written for Ctrl+Shift+U; what they say about the key holds for any binding. MPV
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

**A play after a pop-up (2026-10-04).** "Only a video the user starts" was
`navigator.userActivation.isActive` at the `play`, and a site whose play button opens a
pop-up first broke it: `window.open()` consumes the activation (Firefox's web-platform
tests check that `isActive` turns false), so the video the same click started played as
if nobody had started it, nothing went to mpv, and it played on in the page. content.js
now also counts a trusted press in the same frame within Firefox's activation time
(`dom.user_activation.transient.timeout`, 5 s): `pointerdown`, or a `keydown` that could
be no extension's shortcut (`couldBeExtensionShortcut`, the rule the cancelled-shortcut
listener uses: Ctrl, Alt or Command, an F-key or a media key), not Escape and not a lone
modifier (`playFollowsUserPress`). The MPV shortcut itself must not count, whatever it is
bound to in about:addons: Ctrl+Shift+U by default, Alt+F on the owner's PC. An autoplay with no press behind it, a page-made event,
or a press over 5 s old still sends nothing. Not covered: a press in a child frame and the
play in its parent once the pop-up consumed the activation (Firefox propagates activation up
the tree; this records presses per frame). Tests: `tests/unit/contentUserPlay.test.mjs` (3 of
9 fail without the fix, the rest guard the autoplay cases) and mpv-shortcut's `/popup` page,
whose mpv half runs where the host is installed (CI's e2e-windows).

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

**Which decoder mpv uses (2026-10-04, host version 2).** FastStream never sets mpv's
hardware decoding: a `--hwdec` on the command line would beat the user's mpv.conf (here
gpu-next on Vulkan with shaders), so it only says what mpv does. After a hand-off that
worked (the three automatic paths: allowlist, toolbar/shortcut, a play), the background
sends the host `{type: 'status', waitMs: 20000}` (`followMpvDecoder`). The host
(`queryDecoder`) asks the mpv on its pipe for `hwdec-current`, `hwdec`, `video-format`,
`width` and `height` once a second until `hwdec-current` is there (it is unavailable while
no video decoder is loaded, "no" in software, "d3d11va", "vulkan", "d3d11va-copy"... in
hardware), at most `waitMs` (capped at 30 s), and answers `{running, decoder}`. Only an mpv
the host started for single-instance use has the pipe, so with "Reuse one mpv window" off
nothing is asked. The answer goes to `tab.mpvDecoder` (persisted like `mpvError`; cleared on a new
page and before each hand-off's own question, and an older question's late answer is
dropped by `tab.mpvDecoderQuery`). The tooltip then says "decoded by the graphics card:
d3d11va, AV1 1920x1080", or "decoded by the processor (H.264 1280x720): add
hwdec=auto-safe to mpv.conf...". The badge is unchanged: a failure's "!" and the outdated
host's come first. "Test mpv connection" asks too (`waitMs: 0`) and adds the same sentence
while such an mpv is open. A host from before answers "unknown message", which reads as no
answer. Tests: `tests/unit/mpvDecoderStatus.test.mjs`, including a socket that answers as
mpv does (Linux) and the background end to end; not yet run against a real mpv. mpv's own
choice of stream version is issue #330.
