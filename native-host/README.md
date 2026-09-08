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
protocol. The extension sends it `{type: 'open', url, headers?}` and it
launches mpv with that URL. Only `Referer`, `Origin` and `User-Agent` are
relayed, one `--http-header-fields-append` per header. Referer/Origin are what
CDN-protected streams check; the browser's User-Agent is relayed because mpv
otherwise identifies itself as `libmpv`, which UA-gated CDNs reject. Cookies
and every other header stay in the browser, so streams behind a per-session
cookie will still fail to load in mpv.

## Why mpv is started through WMI on Windows

Firefox (and Chrome) run a native messaging host inside a Windows **job
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

- Node.js >= 20 (already required by this repository)
- mpv on your machine (e.g. `C:\Program Files\mpv\mpv.exe`)

## Setup

There are two ways to register the host. **Pick one.**

### Option A — install script (recommended, Windows only)

```powershell
powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -ExtensionId <your-extension-id>
```

Options:

- `-ExtensionId <id>` - your extension's ID from `chrome://extensions`
  (Developer mode). Required for the Chrome-family registration; Firefox
  uses the fixed build ID `thanatus@Nawid`.
- `-MpvPath "D:\tools\mpv\mpv.exe"` - where mpv lives
  (default `C:\Program Files\mpv\mpv.exe`; the host also falls back to `mpv`
  on `PATH`)
- `-Browser chrome|firefox|both` (default `both`)
- `-NodePath` - path to `node.exe` if it is not on `PATH`

#### What the script actually does, step by step

Nothing here needs admin rights — everything stays in your user profile
(`HKCU` registry, `%LOCALAPPDATA%`). You can verify every step below, or
perform the same steps by hand instead of running the script.

| # | Action | Manual equivalent |
|---|---|---|
| 1 | Creates `%LOCALAPPDATA%\FastStreamMpvHost\` and copies `faststream-mpv-host.mjs` into it | `New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\FastStreamMpvHost"` then copy the file |
| 2 | Writes `config.json` there containing only `{"mpvPath": "..."}` — the mpv location the host should launch | create the same file by hand |
| 3 | Writes `com.faststream.mpv.bat` — a two-line wrapper that runs `node faststream-mpv-host.mjs`. Needed because the browser starts the manifest's `path` executable **with no arguments**, and a bare `.mjs` is not an executable | create the same file by hand |
| 4 | Writes `com.faststream.mpv.json` — the native-messaging manifest: host name, path to the `.bat`, `type: "stdio"`, and which extensions may talk to it (`allowed_origins` for Chrome = your extension ID, `allowed_extensions` for Firefox = `thanatus@Nawid`) | create the same file by hand |
| 5 | Creates registry key `HKCU\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv` (default value = path to the manifest JSON) so **Firefox** can find the host, plus the same under `Google\Chrome`, `Microsoft\Edge`, `BraveSoftware\Brave-Browser`, `Vivaldi` for Chromium browsers | `New-Item` + `Set-ItemProperty`, see the key paths in the script |

The script does **not**: run anything as admin, modify `PATH`, install
software, start any background process, make network connections, or touch
anything outside `%LOCALAPPDATA%\FastStreamMpvHost` and the five
`NativeMessagingHosts` registry keys listed above. Read it — it is 130
lines, heavily commented, one action per block.

### Option B — manual setup (any OS, no script)

1. Copy `faststream-mpv-host.mjs` somewhere permanent, e.g.
   `%LOCALAPPDATA%\FastStreamMpvHost\`.
2. Create a wrapper `com.faststream.mpv.bat` next to it (Chrome-family
   launches the manifest `path` with zero arguments):

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

   (For Chrome, add `"allowed_origins": ["chrome-extension://<your-id>/"]`
   instead of/in addition to `allowed_extensions`.)

4. Tell the browser where the manifest is:
   - **Firefox:** registry key `HKCU\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv`,
     default value = full path to the JSON file. (Linux/macOS:
     `~/.mozilla/native-messaging-hosts/com.faststream.mpv.json`.)
   - **Chrome/Edge/Brave/Vivaldi:** same idea under
     `HKCU\Software\<Vendor>\NativeMessagingHosts\com.faststream.mpv`.
5. Put your mpv path into `config.json` next to the host script
   (`{"mpvPath": "C:\\Program Files\\mpv\\mpv.exe"}`), or rely on the
   built-in defaults (`C:\Program Files\mpv\mpv.exe`, then `mpv` on `PATH`).

Restart the browser afterwards. In FastStream's options page, use
**Test mpv connection** to verify the setup.

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
foreach ($root in 'Google\Chrome','Microsoft\Edge','BraveSoftware\Brave-Browser','Vivaldi','Mozilla') {
  Remove-Item -Recurse -Force "HKCU:\Software\$root\NativeMessagingHosts\com.faststream.mpv" -ErrorAction SilentlyContinue
}
```

Or by hand: delete the folder and the registry keys the setup created (see
the table above).

## Files

| File | Purpose |
|---|---|
| `faststream-mpv-host.mjs` | The host: reads one JSON message on stdin, launches mpv, replies on stdout |
| `install.ps1` | Copies the host, writes wrapper + manifest, registers it |
| `README.md` | This file |