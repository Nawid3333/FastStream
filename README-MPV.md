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
> nobody has run it.

---

## 1. What you need

- **On Windows 10 or 11 (64-bit): nothing.** The one-click setup in step 2
  brings mpv, the helper and a private copy of Node.js for it.
- **Setting it up by hand** (developers, other systems):
  - **mpv** — https://mpv.io/installation/
    The helper looks in `C:\Program Files\mpv\`, then `C:\Program Files (x86)\mpv\`,
    then on `PATH`. Anywhere else works too; you just tell it where in step 3.
  - **Node.js 22 or newer** for the helper, as for building this repo. CI tests the helper
    with the version in `.nvmrc`.

## 2. Install the helper

### One click (Windows)

The companion mpv setup, [mpv-config](https://github.com/Nawid3333/mpv-config),
installs everything in one go. Open **PowerShell** (Start menu, type
`PowerShell`, Enter), paste this line and press Enter:

```powershell
irm https://raw.githubusercontent.com/Nawid3333/mpv-config/main/installer/setup.ps1 | iex
```

Or download mpv-config as a ZIP (**Code ▸ Download ZIP**), extract it and
double-click **`install.bat`**. No admin rights, Git or Node.js are needed. It:

- installs mpv with mpv-config's configuration into `%LOCALAPPDATA%\Programs\mpv`;
- installs this fork's helper from its latest release (this repository's
  `native-host\install.ps1` and `faststream-mpv-host.mjs`, run with that
  `mpv.exe` and a private `node.exe` in `%LOCALAPPDATA%\FastStreamMpvHost\node\`)
  and registers it for Firefox;
- opens the signed FastStream add-on in Firefox: click **Add**;
- adds a Start menu folder **mpv** with *mpv*, *Update mpv* and *Uninstall mpv*.

Details are in mpv-config's README, under
[Install](https://github.com/Nawid3333/mpv-config#install).

**Then restart Firefox** and turn MPV mode on (step 3). FastStream's settings
offer it too: once the helper answers, a banner at the top asks *"The mpv
helper is installed - open videos in mpv?"*, and its button turns MPV mode on.

To update later: Start menu ▸ mpv ▸ *Update mpv* (or run the line above
again). It also brings the helper to the newest FastStream release.

### By hand (developers, other setups)

From the repo, in PowerShell:

```powershell
cd native-host
powershell -ExecutionPolicy Bypass -File install.ps1
```

If mpv is not in the default location, pass it:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -MpvPath "D:\Apps\mpv\mpv.exe"
```

**Then restart Firefox.** It only looks for native hosts at startup.

Not on Windows, or prefer to do it by hand? See
[`native-host/README.md`](native-host/README.md) — the same steps, no script.

## 3. Turn it on

FastStream settings → **MPV Mode**:

1. Tick **Open detected streams in mpv (external player)**.
2. Click **Test mpv connection**. You want **"mpv found"**.
   - *"host reachable, but mpv was not found"* → mpv is installed somewhere
     unusual; put its full path in **mpv path** and test again.
   - *"mpv host not available - is it installed?"* → the helper is not
     registered, or you have not restarted the browser since installing it.
3. Fill in the **MPV Allowlist** — one site per line. mpv is only used on
   these sites; everywhere else FastStream behaves normally.

   ```
   https://example.com
   ```

   A line matches any page starting with it; `https://` and `www.` can be left
   out (`example.com` matches `https://www.example.com/...`). `~` starts a regex, `!` excludes,
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

On any site, the MPV shortcut (**Alt+F**; you can change it in Firefox's
add-on shortcut settings) puts the tab in MPV: the next video you start
there goes to mpv. FastStream does nothing for YouTube; paste a YouTube link
into mpv yourself, which opens it with yt-dlp.

## Options

| Option | Default | What it does |
|---|---|---|
| Open detected streams in mpv | off | The master switch. |
| MPV Allowlist | empty | Sites that use mpv. Nothing happens until this has entries. |
| mpv path | empty | Only needed when mpv is not found automatically. |
| Open mpv in fullscreen | **off** | Starts fullscreen. |
| Pause the video in the browser | **on** | Stops the page playing once mpv has the stream, so it is not streaming twice. |
| Reuse one mpv window | **on** | A second video replaces the first in the same window instead of opening another. Only ever reuses a window FastStream started — an mpv you opened yourself is never touched. Two videos sent within the same second, before any FastStream mpv is open, can still open two windows. |

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
| The toolbar's `!` says the mpv host is out of date | The helper on this PC is older than the add-on. One-click install: Start menu ▸ mpv ▸ *Update mpv*. By hand: `update-local.cmd` in your checkout, or `native-host\install.ps1` again. |
| mpv opens and closes instantly | The stream itself was refused — an expired token, or a site that needs cookies. Cookies are deliberately **not** sent to mpv. |
| mpv plays but nothing switches | Log will show whether a second URL arrived at all. |
| The toolbar tooltip says "decoded by the processor" | mpv decodes in software. FastStream never changes your mpv settings; add `hwdec=auto-safe` to `mpv.conf` for the graphics card. The tooltip (and **Test mpv connection**, while an mpv FastStream started is open) say what mpv uses; this needs **Reuse one mpv window** on (the default). |

## Uninstall

**Installed with the one-click setup:** Start menu ▸ mpv ▸ *Uninstall mpv*.
It removes the helper it installed too. The add-on itself is removed in
`about:addons`.

**Installed by hand:**

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\FastStreamMpvHost"
Remove-Item -Recurse -Force "HKCU:\Software\Mozilla\NativeMessagingHosts\com.faststream.mpv"
```

Untick the MPV options in settings, and FastStream goes back to normal.

## What gets sent to mpv

Only the stream URL, the address of the page you were on (see below), and
**`Referer`, `Origin` and `User-Agent`** — the three headers CDNs check.
**Cookies and every other header stay in the browser.** That is why some
streams that play fine in the browser will not play in mpv: they are tied to
a login session that mpv does not have.

The URL mpv opens gets fragment tags at its end:

- `fs-content=anime` or `fs-content=movie`, when a content type is set.
- `fs-page=` with the page's address (percent-encoded), for the "Site page"
  entry in mpv's menu, and `fs-id=` with a short hash of it, which the resume
  script saves your position under. Both only for an `http(s)` page.

Fragments are never transmitted over HTTP, so none of this reaches the site
or the CDN. mpv does see them: they are part of the URL it opens, so anything
in mpv that keeps URLs (its history, a script) keeps the page's address too.

---

For how the helper actually works, why mpv is launched through WMI on
Windows, and how to test it by hand, see
[`native-host/README.md`](native-host/README.md).
