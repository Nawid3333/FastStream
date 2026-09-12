# MPV mode — setup guide

Play a site's video in [mpv](https://mpv.io/) on your own machine instead of
in the browser. FastStream detects the stream, hands the URL and the headers
the CDN needs to mpv, and mpv plays it.

This is a **fork-only feature** and it needs a one-time install, because a
browser extension cannot start a program on your computer by itself. It talks
to a small helper ("native messaging host") that you register with the
browser once.

Everything else in FastStream works without any of this.

> **Tested on Windows + Firefox only.** The helper falls back to a plain
> process launch on Linux and macOS, which should be correct there, but
> nobody has run it. Chrome-family browsers are supported by the installer
> but have not been tried either.

---

## 1. What you need

- **mpv** — https://mpv.io/installation/
  Default lookups are `C:\Program Files\mpv\mpv.exe`, then `mpv` on `PATH`.
  Anywhere else works too; you just tell it where in step 3.
- **Node.js 20 or newer** — already required to build this repo.

## 2. Install the helper

From the repo, in PowerShell:

```powershell
cd native-host
powershell -ExecutionPolicy Bypass -File install.ps1 -Browser firefox
```

If mpv is not in the default location, pass it:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Browser firefox -MpvPath "D:\Apps\mpv\mpv.exe"
```

For Chrome, Edge, Brave or Vivaldi you must also pass the extension's ID
(`chrome://extensions` → Developer mode → ID):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Browser both -ExtensionId <your-id>
```

**Then restart the browser.** It only looks for native hosts at startup.

Not on Windows, or prefer to do it by hand? See
[`native-host/README.md`](native-host/README.md) — same four steps, no script.

## 3. Turn it on

FastStream settings → **MPV Mode**:

1. Tick **Open detected streams in mpv (external player)**.
2. Click **Test mpv connection**. You want **"mpv found"**.
   - *"host reachable, but mpv was not found"* → mpv is installed somewhere
     unusual; put its full path in **mpv path** and test again.
   - *"mpv host not available"* → the helper is not registered, or you have
     not restarted the browser since installing it.
3. Fill in the **MPV Allowlist** — one site per line. mpv is only used on
   these sites; everywhere else FastStream behaves normally.

   ```
   https://example.com
   ```

   A line matches any page starting with it. `~` starts a regex, `!` excludes,
   `-` matches by hostname only, `#` is a comment. Later lines win over
   earlier ones.

   Every site on this list is tagged **Movie** by default. Add `@anime` at
   the end of a line for the sites that are not, e.g.
   `https://crunchyroll.com @anime` — most people have more movie sites
   than anime ones, so only the exceptions need marking. (`@movie` is also
   accepted, if you'd rather write it out.) This is passed to mpv as a
   `#fs-content=anime`/`#fs-content=movie` marker on the stream URL (never
   sent to the site — URL fragments stay client-side), for an mpv config
   that reads it back to pick an anime- or movie-tuned shader chain
   automatically.

## 4. Use it

Open a video on an allowlisted site — mpv takes over automatically. On any
other site, the player's toolbar has an **Open this stream in mpv** button
next to the download button. Right-click that button to cycle a per-video
override — Auto → Anime → Movie → Auto — shown as a small A/M badge; it wins
over the allowlist tag for that one video.

## Options

| Option | Default | What it does |
|---|---|---|
| Open detected streams in mpv | off | The master switch. |
| MPV Allowlist | empty | Sites that use mpv. Nothing happens until this has entries. |
| mpv path | empty | Only needed when mpv is not found automatically. |
| Open mpv in fullscreen | **off** | Starts fullscreen. |
| Pause the video in the browser | **on** | Stops the page playing once mpv has the stream, so it is not streaming twice. |
| Reuse one mpv window | **on** | A second video replaces the first in the same window instead of opening another. Only ever reuses a window FastStream started — an mpv you opened yourself is never touched. |

## When something does not work

Turn on the helper's log. Add `"debug": true` to
`%LOCALAPPDATA%\FastStreamMpvHost\config.json`:

```json
{"mpvPath": "C:\\Program Files\\mpv\\mpv.exe", "debug": true}
```

No reinstall or restart needed — it is read on every message. It then writes
`faststream-mpv-host.log` next to itself, one JSON line per event: the URL
and headers it received, the exact mpv command line, and whether the window
took focus. Delete the log and remove the `debug` line when you are done.

Common cases:

| Symptom | Usually means |
|---|---|
| Nothing at all happens | Site is not on the allowlist, or MPV mode is off. The log will be empty. |
| **Test mpv connection** fails | Browser not restarted after installing, or the helper is not registered. |
| mpv opens and closes instantly | The stream itself was refused — an expired token, or a site that needs cookies. Cookies are deliberately **not** sent to mpv. |
| mpv plays but nothing switches | Log will show whether a second URL arrived at all. |

## Uninstall

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\FastStreamMpvHost"
Remove-Item -Recurse -Force "HKCU:\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv"
```

Untick the MPV options in settings, and FastStream goes back to normal.

## What gets sent to mpv

Only the stream URL, and **`Referer`, `Origin` and `User-Agent`** — the three
headers CDNs check. **Cookies and every other header stay in the browser.**
That is why some streams that play fine in the browser will not play in mpv:
they are tied to a login session that mpv does not have.

When a content type is set, the URL mpv opens gets an extra
`#fs-content=anime` or `#fs-content=movie` fragment. Fragments are never
transmitted over HTTP, so this cannot change what the site or CDN receives.

---

For how the helper actually works, why mpv is launched through WMI on
Windows, and how to test it by hand, see
[`native-host/README.md`](native-host/README.md).
