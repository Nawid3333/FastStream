# FastStream mpv native host

> Just want to set this up? Start with [`../README-MPV.md`](../README-MPV.md).
> This file is the reference: how the host works, why mpv is launched the
> way it is, manual setup for non-Windows, and how to test it by hand.

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
contentType?, ...}` and it launches mpv with that URL, tagged as below. The
extension passes on only `Referer`, `Origin` and `User-Agent`
(`MpvBackend.pickRelayHeaders`), and the host gives mpv one
`--http-header-fields-append` per header. Referer/Origin are what
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

## Why mpv is started through WMI on Windows

Firefox runs a native messaging host inside a Windows **job
object** created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Every descendant of
the host joins that job. This host answers one message and exits, the browser
then closes the job, and Windows kills everything still in it -- so an mpv
started as an ordinary child dies a fraction of a second after it appears.
`detached: true` and `unref()` do not help: neither escapes a job object.

Measured, spawning mpv from inside such a job and then closing it:

| how mpv was started | survives the job closing |
| --- | --- |
| `spawn(..., {detached: true})` + `unref()` | no |
| `cmd /c start` | no |
| `Win32_Process.Create` via WMI | **yes** |

So on Windows the host asks the WMI service to create the process; mpv ends up
parented to `WmiPrvSE` and outlives the browser's job. If WMI is unavailable
the host falls back to a direct spawn, which still plays for as long as the
browser allows. On other platforms there is no job object and the direct
detached spawn is used.

## Requirements

- Node.js 22 or newer, as for building this repository. CI tests the host with
  the version in the repository's `.nvmrc`.
- mpv on your machine (e.g. `C:\Program Files\mpv\mpv.exe`)

## Setup

There are two ways to register the host. **Pick one.**

### Option A — install script (recommended, Windows only)

```powershell
powershell -ExecutionPolicy Bypass -File native-host\install.ps1
```

The extension is allowed by its fixed build ID `thanatus@Nawid`.

Options:

- `-MpvPath "D:\tools\mpv\mpv.exe"` - where mpv lives
  (default `C:\Program Files\mpv\mpv.exe`; the host also looks where
  [Configuration](#configuration) lists)
- `-NodePath` - path to `node.exe` if it is not on `PATH`

#### What the script actually does, step by step

Nothing here needs admin rights — everything stays in your user profile
(`HKCU` registry, `%LOCALAPPDATA%`). You can verify every step below, or
perform the same steps by hand instead of running the script.

| # | Action | Manual equivalent |
|---|---|---|
| 1 | Creates `%LOCALAPPDATA%\FastStreamMpvHost\` and copies `faststream-mpv-host.mjs` into it | `New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\FastStreamMpvHost"` then copy the file |
| 2 | Writes `config.json` there containing only `{"mpvPath": "..."}` — the mpv location the host should launch | create the same file by hand |
| 3 | Writes `com.faststream.mpv.bat` — a two-line wrapper that runs `node faststream-mpv-host.mjs`. Needed because Windows won't start a `.mjs` as a program. Firefox passes the manifest's path and the add-on's id as arguments; the wrapper hands them on, and the host ignores them | create the same file by hand |
| 4 | Writes `com.faststream.mpv.json` — the native-messaging manifest: host name, path to the `.bat`, `type: "stdio"`, and which extension may talk to it (`allowed_extensions` = `thanatus@Nawid`) | create the same file by hand |
| 5 | Creates registry key `HKCU\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv` (default value = path to the manifest JSON) so **Firefox** can find the host | `New-Item` + `Set-ItemProperty`, see the key paths in the script |

The script does **not**: run anything as admin, modify `PATH`, install
software, start any background process, make network connections, or touch
anything outside `%LOCALAPPDATA%\FastStreamMpvHost` and the one
`NativeMessagingHosts` registry key listed above. Read it — it is about 80
lines, commented, one action per block.

### Option B — manual setup (any OS, no script)

The steps are written for Windows; on Linux and macOS, see the notes after
them.

1. Copy `faststream-mpv-host.mjs` somewhere permanent, e.g.
   `%LOCALAPPDATA%\FastStreamMpvHost\`.
2. Create a wrapper `com.faststream.mpv.bat` next to it (Windows won't start
   a `.mjs` as a program):

   ```bat
   @echo off
   "C:\Program Files\nodejs\node.exe" "%LOCALAPPDATA%\FastStreamMpvHost\faststream-mpv-host.mjs" %*
   ```

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
   lookups in [Configuration](#configuration).

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
3. The `FASTSTREAM_MPV_PATH` environment variable.
4. `C:\Program Files\mpv\mpv.exe`, then `C:\Program Files (x86)\mpv\mpv.exe`.
5. `mpv` on `PATH` (`mpv.exe` on Windows).

A folder works too: the host looks for `mpv.exe` in it. So a path in the
options page wins over `config.json`, which matters when an old one there
seems to be ignored.

The log: `"debug": true` in `config.json`, or the environment variable
`FASTSTREAM_MPV_DEBUG=1`, makes the host append every message, the mpv
command line and the result to `faststream-mpv-host.log` next to itself.
`config.json` is read on every message, so no restart is needed.

## Extension-side setup

1. Open FastStream settings.
2. Enable **Open detected streams in mpv (external player)**.
3. Fill the **MPV Allowlist** with the sites whose streams should open in
   mpv (same syntax as Auto-enable URLs: one URL per line, `~regex`, `!` to
   exclude).
4. Click the toolbar button on an allowlisted page: its state cycles
   Off → On → **MPV** (violet icon, `MPV` badge). Detected streams are then
   handed to mpv instead of the in-page player.

## Testing the host by hand

Use the **Test mpv connection** button in the extension options — it sends
the same `{type: 'ping'}` through the browser and reports whether mpv was
found (with its path).

## Uninstall

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\FastStreamMpvHost"
Remove-Item -Recurse -Force "HKCU:\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv" -ErrorAction SilentlyContinue
```

Or by hand: delete the folder and the registry key the setup created (see
the table above).

## Files

| File | Purpose |
|---|---|
| `faststream-mpv-host.mjs` | The host: reads one JSON message on stdin, launches mpv, replies on stdout |
| `install.ps1` | Copies the host, writes wrapper + manifest, registers it |
| `README.md` | This file |