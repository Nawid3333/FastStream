# FastStream mpv native host

> Just want to set this up? Start with [`../README-MPV.md`](../README-MPV.md).
> On Windows, the one-click setup of
> [mpv-config](https://github.com/Nawid3333/mpv-config#install) installs mpv,
> this host and the add-on with one line in PowerShell; nothing below is needed
> for it.
> This file is the reference: how the host works, why mpv is launched the
> way it is, manual setup for developers and non-Windows, and how to test it by hand.

Lets the FastStream extension open detected video streams directly in
[mpv](https://mpv.io/) on your computer, instead of the built-in browser
player.

## How it works

```
web page ──▶ FastStream content script ──▶ background (stream detected)
                                               │  mpv mode + allowlisted?
                                               ▼
                                    chrome.runtime.sendNativeMessage
                                               │  (native messaging)
                                               ▼
                              native-host/faststream-mpv-host.mjs
                                               │  spawn
                                               ▼
                                          mpv.exe <url>
```

The host is a small Node.js script that speaks the standard
[native messaging](https://developer.chrome.com/docs/apps/nativeMessaging)
protocol. The extension sends it `{type: 'open', url, headers?, pageUrl?,
title?, contentType?, ...}` and it launches mpv with that URL, tagged as below. The
extension passes on only `Referer`, `Origin` and `User-Agent`
(`MpvBackend.pickRelayHeaders`). The headers and the title (the browser tab's,
or the stream's host name without one) go to mpv as **per-file options** of
that one file: on a fresh start inside a `--{ ... --}` group, one
`--http-header-fields-append` per header; into a running mpv as the options of
its `loadfile` command. So the next file in that window does not inherit them,
and two quick sends cannot mix one site's headers with the other's stream (until
2026-10-02 they were set for the whole player, with a lock file between host
processes). Referer/Origin are what
CDN-protected streams check; the browser's User-Agent is relayed because mpv
otherwise identifies itself as `libmpv`, which UA-gated CDNs reject. Cookies
and every other header stay in the browser, so streams behind a per-session
cookie will still fail to load in mpv.

The URL mpv opens carries fragment tags, which never reach the site or the
CDN (a fragment is not sent over HTTP):

| Tag | When | What for |
|---|---|---|
| `fs-content=anime` / `fs-content=movie` | a content type is set (allowlist tag or the player's override) | an mpv config that picks shaders by it |
| `fs-page=<page address, percent-encoded>` | the page is `http(s)` | the "Site page" entry in mpv's menu (`source-info.lua`) |
| `fs-id=<16 hex digits>` | the page is `http(s)` | the key `stream-resume.lua` saves the position under: a hash of the page's address, since the stream URL's token changes on every visit |

A stream URL can come from a page, so it can carry text that looks like a tag.
The host drops the `fs-*` items the URL's own fragment had and appends its tags
after the rest. So a script on the mpv side reads a tag from the fragment only
(the text after the first `#`), as a whole `&`-separated item, and takes the
last one: anywhere else (`?x=fs-id=...`, `#a=1;fs-id=...`) it is the page's.

## Why mpv is started through WMI on Windows

Firefox starts a native messaging host inside a Windows **job object** of its
own, and every process the host starts joins that job. This host answers one
message and exits, and when it does Firefox **terminates the job**
(`TerminateJobObject`): Windows kills everything still in it -- so an mpv
started as an ordinary child dies a fraction of a second after it appears.
`detached: true` and `unref()` do not help: neither leaves a job object.

(Until 2026-10-04 this said the job was created with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Firefox's source says otherwise:
`toolkit/modules/subprocess/subprocess_win.worker.js`, read on
mozilla-firefox/firefox `main`, starts the host with `CREATE_NO_WINDOW`, gives
the job one limit, `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, and calls
`TerminateJobObject` in `wait()`, when the host has exited, and in `kill()`.
The effect on mpv is the same. `JOB_OBJECT_LIMIT_BREAKAWAY_OK` means a process
created with `CREATE_BREAKAWAY_FROM_JOB` would leave the job too; Node's
`spawn` cannot ask for that flag, and the host does not use it, so it is not
measured here.)

Measured, spawning mpv from inside such a job and then closing it:

| how mpv was started | survives the job closing |
| --- | --- |
| `spawn(..., {detached: true})` + `unref()` | no |
| `cmd /c start` | no |
| `Win32_Process.Create` via WMI | **yes** |

So on Windows the host asks the WMI service to create the process; mpv ends up
parented to `WmiPrvSE` and outlives the browser's job. If WMI is unavailable
the host reports the error: a direct spawn would be killed the moment the host
exits, before mpv shows anything. On other platforms there is no job object and
the direct detached spawn is used.

A process the WMI service creates may not take the foreground, so mpv would
open behind the browser. The host's PowerShell waits for mpv's window and
raises it (it attaches to the foreground window's input queue), then checks
250 ms later that mpv's window really is in front. The answer to an `open`
says how that went (host version 3): `focus` (`True`, `False`, `nowindow`, ...)
and `foreground` (`True` when the check found mpv in front), plus `reused: true`
when the stream went into the mpv already open; the message list at the top of
`faststream-mpv-host.mjs` names every value. Both describe that moment only. An
mpv that is gone before it had a window (an option it refuses, a broken
install) is reported as not started.

## Requirements

The one-click setup (below) brings both; by hand you need:

- Node.js 22 or newer, as for building this repository. CI tests the host with
  the version in the repository's `.nvmrc`.
- mpv 0.38 or newer on your machine (e.g. `C:\Program Files\mpv\mpv.exe`): a
  stream sent to an open mpv window goes in with `loadfile`'s named options. An
  older one refuses it, and the host says so instead of opening a second window.

## Setup

### One-click setup (Windows, recommended)

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/Nawid3333/mpv-config/main/installer/setup.ps1 | iex
```

(or `install.bat` from a downloaded ZIP of
[mpv-config](https://github.com/Nawid3333/mpv-config#install)). It needs no
admin rights, Git or Node.js. It installs mpv with mpv-config's configuration
into `%LOCALAPPDATA%\Programs\mpv`, then installs this host from the fork's
latest release: this folder's `install.ps1` and `faststream-mpv-host.mjs`, run
with `-MpvPath` set to that `mpv.exe` and `-NodePath` to a private `node.exe`
in `%LOCALAPPDATA%\FastStreamMpvHost\node\`. So Option A's table below says
what it does to the host. It also opens the signed add-on in Firefox (click
**Add**) and adds a Start menu folder **mpv** with *mpv*, *Update mpv* and
*Uninstall mpv*. Restart Firefox afterwards, and turn on MPV mode in
FastStream's settings.

**By hand** (developers, other setups), there are two ways to register the
host. **Pick one.**

### Option A — install script (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File native-host\install.ps1
```

The extension is allowed by its fixed build ID `thanatus@Nawid`.

Options:

- `-MpvPath "D:\tools\mpv\mpv.exe"` - where mpv lives
  (default: the path `config.json` already holds, on a first install
  `C:\Program Files\mpv\mpv.exe`; the host also looks where
  [Configuration](#configuration) lists)
- `-NodePath` - path to `node.exe` if it is not on `PATH`

#### What the script actually does, step by step

Nothing here needs admin rights — everything stays in your user profile
(`HKCU` registry, `%LOCALAPPDATA%`). You can verify every step below, or
perform the same steps by hand instead of running the script.

| # | Action | Manual equivalent |
|---|---|---|
| 1 | Creates `%LOCALAPPDATA%\FastStreamMpvHost\` and copies `faststream-mpv-host.mjs` into it | `New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\FastStreamMpvHost"` then copy the file |
| 2 | Writes `mpvPath` into `config.json` there — the mpv location the host should launch — and, once, `ipcToken`: a random value the host puts in the name of its pipe to mpv, since pipe names are shared by every account on the PC; anything else the file holds (`"debug": true`) stays | create the same file by hand |
| 3 | Writes `com.faststream.mpv.bat` — a short wrapper that runs `node faststream-mpv-host.mjs`. Needed because Windows won't start a `.mjs` as a program. Firefox passes the manifest's path and the add-on's id as arguments; the wrapper hands them on, and the host ignores them | create the same file by hand |
| 4 | Writes `com.faststream.mpv.json` — the native-messaging manifest: host name, path to the `.bat`, `type: "stdio"`, and which extension may talk to it (`allowed_extensions` = `thanatus@Nawid`) | create the same file by hand |
| 5 | Creates registry key `HKCU\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv` (default value = path to the manifest JSON) so **Firefox** can find the host | `New-Item` + `Set-ItemProperty`, see the key paths in the script |

The script does **not**: run anything as admin, modify `PATH`, install
software, start any background process, make network connections, or touch
anything outside `%LOCALAPPDATA%\FastStreamMpvHost` and the one
`NativeMessagingHosts` registry key listed above. Read it — it is about 130
lines, commented, one action per block.

### Option B — manual setup (any OS, no script)

The steps are written for Windows; on Linux and macOS, see the notes after
them.

1. Copy `faststream-mpv-host.mjs` somewhere permanent, e.g.
   `%LOCALAPPDATA%\FastStreamMpvHost\`.
2. Create a wrapper `com.faststream.mpv.bat` next to it (Windows won't start
   a `.mjs` as a program). Save it as UTF-8 without a BOM (Notepad: "UTF-8",
   not "UTF-8 with BOM"): a BOM breaks its first line, and cmd then writes its
   commands where Firefox expects the helper's answers. `chcp 65001` makes cmd
   read its paths as UTF-8, or a user name with an accent (José, Müller) breaks
   them:

   ```bat
   @echo off
   chcp 65001 > nul
   "C:\Program Files\nodejs\node.exe" "%LOCALAPPDATA%\FastStreamMpvHost\faststream-mpv-host.mjs" %*
   ```

   The first path is your `node.exe`: `where node` in a command prompt shows it.

3. Create `com.faststream.mpv.json` next to it:

   ```json
   {
     "name": "com.faststream.mpv",
     "description": "FastStream mpv host - opens detected streams in mpv",
     "path": "C:\\Users\\<you>\\AppData\\Local\\FastStreamMpvHost\\com.faststream.mpv.bat",
     "type": "stdio",
     "allowed_extensions": ["thanatus@Nawid"]
   }
   ```

4. Tell Firefox where the manifest is: registry key
   `HKCU\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv`, default
   value = full path to the JSON file.
5. Put your mpv path into `config.json` next to the host script
   (`{"mpvPath": "C:\\Program Files\\mpv\\mpv.exe"}`), or rely on the
   lookups in [Configuration](#configuration). On a PC with other accounts,
   add `"ipcToken"` with 32 random hex digits (see step 2 above); without it
   the pipe has a fixed name.

On **Linux and macOS**:

- No wrapper is needed: the host starts with `#!/usr/bin/env node`. Make it
  executable (`chmod +x faststream-mpv-host.mjs`) and give its absolute path
  as the manifest's `path`. If `node` is not on the `PATH` Firefox starts
  with (a version manager's node often isn't), point `path` at a two-line
  shell script that runs the host with node's full path instead.
- There is no registry step. The manifest goes in a folder Firefox reads:
  Linux `~/.mozilla/native-messaging-hosts/com.faststream.mpv.json`, macOS
  `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.faststream.mpv.json`.

Restart Firefox afterwards. In FastStream's options page, use
**Test mpv connection** to verify the setup.

## Configuration

The host takes the first mpv it finds, in this order:

1. The options page's **mpv path** (sent with each message).
2. `mpvPath` in `config.json` next to the host script.
3. `C:\Program Files\mpv\mpv.exe`, then `C:\Program Files (x86)\mpv\mpv.exe`.
4. `mpv` on `PATH` (`mpv.exe` on Windows).

(The `FASTSTREAM_MPV_PATH` environment variable is no longer read: use `mpvPath`.)

A folder works too: the host looks for `mpv.exe` in it. So a path in the
options page wins over `config.json`, which matters when an old one there
seems to be ignored.

A path to `mpv.com`, mpv's console wrapper, starts the `mpv.exe` beside it
when there is one (`mpv-x86_64.com` the `mpv-x86_64.exe`): the wrapper starts
the `.exe` as a child of its own, so the host would raise the wrapper's
process, which has no window, and mpv stayed behind the browser.

The log: `"debug": true` in `config.json`, or the environment variable
`FASTSTREAM_MPV_DEBUG=1`, makes the host append every message, the mpv
command line and the result to `faststream-mpv-host.log` next to itself.
`config.json` is read on every message, so no restart is needed.

## Extension-side setup

1. Open FastStream settings.
2. Enable **Open detected streams in mpv (external player)**. While it is
   off and the host finds mpv, the page also offers this in a banner at the
   top (*"The mpv helper is installed - open videos in mpv?"*).
3. Fill the **MPV Allowlist** with the sites whose streams should open in
   mpv (same syntax as Auto-enable URLs: one URL per line, `~regex`, `!` to
   exclude).
4. Open an allowlisted page: the toolbar button starts in **MPV** (violet
   icon, `MPV` badge), and detected streams are handed to mpv instead of the
   in-page player. A click cycles MPV → Off → On → MPV.

## Updating the host

Your PC runs the copy the setup put in `%LOCALAPPDATA%\FastStreamMpvHost\`. A
`git pull` updates the file in this folder, and an extension update updates the
extension; neither touches that copy. After the host changes, install it again:

- **One-click setup:** Start menu ▸ mpv ▸ *Update mpv* (or the setup line
  again). It also brings a host the setup installed to the newest FastStream
  release.
- **From a checkout:** `update-local.cmd` in the repository's root checks the
  installed copy against the repository's and runs `install.ps1` for you
  (keeping your mpv and Node paths), or run `install.ps1` yourself.

You do not have to remember this. The host sends its version (`HostVersion` in
`faststream-mpv-host.mjs`) with every answer, and the extension knows which
version it was released with. When the installed host is older, the stream still
opens, and FastStream says the host is out of date: a `!` on the toolbar button
in MPV mode (the reason is in its tooltip), in the player's "Sent to mpv"
message, and in **Test mpv connection** on the options page.

## Testing the host by hand

Use the **Test mpv connection** button in the extension options — it sends
the same `{type: 'ping'}` through the browser and reports whether mpv was
found (with its path).

## Uninstall

Installed with the one-click setup: Start menu ▸ mpv ▸ *Uninstall mpv*. It
removes the host it installed too. The add-on itself is removed in
`about:addons`.

Installed by hand:

```powershell
$dir = "$env:LOCALAPPDATA\FastStreamMpvHost"
if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv"
if (Test-Path $key) { Remove-Item -Recurse -Force $key }
```

What is not there is skipped; anything that cannot be removed (a file in use) says so.

Or by hand: delete the folder and the registry key the setup created (see
the table above).

## Files

| File | Purpose |
|---|---|
| `faststream-mpv-host.mjs` | The host: reads one JSON message on stdin, launches mpv, replies on stdout |
| `install.ps1` | Copies the host, writes wrapper + manifest, registers it |
| `README.md` | This file |