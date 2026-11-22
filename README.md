![logotext1](https://github.com/user-attachments/assets/cefd20ba-606a-482c-a522-36b3419e93c7)

# FastStream

[![CI](https://github.com/Nawid3333/FastStream/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Nawid3333/FastStream/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Nawid3333/FastStream)](https://github.com/Nawid3333/FastStream/releases/latest)

Tired of having videos buffer with slow internet speeds? Frustrated by a website's lack of accessibility features? This extension will replace videos on websites with a video player designed for your convenience. Say goodbye to buffering and hello to a more accessible video experience!

This is a Firefox-only fork of [Andrews54757/FastStream](https://github.com/Andrews54757/FastStream), maintained by Nawid3333 on its own since 2026-10-09 (it no longer follows upstream). It adds a hand-off to the mpv player and leaves out upstream's YouTube support.

1. Watch videos without interruptions by pre-buffering the video in the background. Automatic fragmentation and up to 6 parallel requests make downloads faster.
2. Advanced subtitling features include: subtitle files in WebVTT, SubRip (SRT, with ASS-style tags) and TTML/DFXP (text, timing and basic styling; see [docs/notes/player.md](docs/notes/player.md) for what TTML features are not drawn), customizable subtitle appearance, built-in OpenSubtitles support to find subtitles on the internet, and an intuitive subtitle syncing tool to adjust subtitle timings on the fly.
3. A volume booster past 100 %, and the picture zoomed, flipped or rotated.
4. Nearly 60 remappable keyboard shortcuts (mpv-style seeks, frame steps and speed presets among them) and accessible tool buttons for easy control of the player. The welcome page lists the defaults.
5. Save the video as a file (MP4, HLS and DASH: the streams are copied as they are, not re-encoded), and screenshots of the picture.
6. Several audio tracks: pick the one you want (MP4, HLS and DASH).
7. Available in 16 languages.
8. Optional: send a stream to [mpv](https://mpv.io/) on your computer instead of playing it in the browser. It needs a small helper installed once. On Windows, one line in PowerShell installs mpv, the helper and this add-on: `irm https://raw.githubusercontent.com/Nawid3333/mpv-config/main/installer/setup.ps1 | iex` (from [mpv-config](https://github.com/Nawid3333/mpv-config#install); it needs no admin rights, no Git and no Node.js). Then restart Firefox, turn on MPV mode in FastStream's settings, and add the sites whose videos should open in mpv to its MPV Allowlist (on any other site, the MPV shortcut, Alt+F, sends the video you start). The manual way, for developers and other setups, is in [README-MPV.md](README-MPV.md).

The player currently supports:
- MP4 videos (.mp4)
- HLS streams (.m3u8)
- DASH streams (.mpd)
- WebM and other files Firefox plays itself (.webm), in Firefox's own playback

To use the player, simply:
1. Go to any website you want with a video and toggle the extension on. Any video it detects will be automatically replaced with the FastStream player.
2. Alternatively, turn on "Use player to play HLS/DASH streams when opening playlist URLs" in the options, then click on or navigate to a stream manifest file (m3u8/mpd) to play it (off by default; the option below it does the same for .mp4 links).
3. Navigate to a new tab and press the extension icon to go to the player. Play sources detected on other tabs through the Sources Browser. You can also drag and drop video files from your computer.

Notes:
- Live HLS and DASH streams play.
- This player will not function with DRM protected content. This is intended. Please be mindful of how you use this tool. FastStream should not be used to infringe copyright. When its manifest says a page's video is copy-protected, FastStream leaves it to the site's own player (the toolbar button shows "DRM" and says why), and mpv mode does not send it to mpv (the button's "!" says why).
- Please report bugs, accessibility problems and feature requests on the issue tracker: https://github.com/Nawid3333/FastStream/issues. A security problem goes in a private report instead: see [SECURITY.md](SECURITY.md).
- For your privacy, this extension **does not collect telemetry** and has no server of its own. Besides the sites whose videos you play, it connects only to OpenSubtitles when you search for subtitles, and to GitHub for updates. Everything it runs ships inside the add-on. The details, permission by permission, are in [docs/privacy-policy.md](docs/privacy-policy.md).
- The default maximum size for predownloading is 5 GB. This can be changed in the settings page (0 = predownload nothing, empty = no limit). Where the downloaded video is kept, in RAM or on the disk, is your choice too: see [RAM and disk](#ram-and-disk).

## RAM and disk

FastStream downloads the video ahead and keeps it until it is played. **Where to keep downloaded video** (Options > General) decides where:

| Mode | What it does | For |
|---|---|---|
| **RAM, then disk** (default) | Video stays in RAM up to the amount you set; what does not fit is written to the disk and read from there. A video that fits is never written to the disk. | Most computers |
| **RAM only** | Nothing of the buffer is written to the disk. What does not fit in the RAM is let go of and downloaded again when you need it. | Sparing an SSD's writes |
| **Disk only** | The video goes to the disk as it arrives; only the part playing now stays in RAM. | Computers with little memory |

In the two RAM modes, **RAM for buffered video (all tabs)** sets the amount, for all FastStream tabs together (default 1 GB). Pick **this computer's memory** above it, and FastStream puts in the recommended amount (an eighth of the memory, at most 4 GB), and warns when the field asks for more than the computer can spare. "No limit" is offered only with RAM only, with a warning: a long video can then fill the memory and freeze the computer.

Measured with a 1080p video at 16 Mbit/s on an SSD, on Windows and Linux, the disk modes played as smoothly as RAM, with no more dropped frames, and a seek took at most about 15 ms longer; the disk took the video faster than any internet line delivers it. More RAM saves SSD writes and nothing else. RAM only has a cost: what does not fit is downloaded again, so seeking back waits for the network.

Private windows never write the buffer to the disk: they keep it in RAM (with Disk only, 64 MB). Your watch progress and the videos you save are not the buffer: these settings do not touch them.

Reloading or closing the page doesn't throw the buffer away at once. FastStream keeps what it had downloaded for the time set under **How long the downloaded video is kept after a reload or a closed tab** (Off, 20 seconds by default, 1, 5, 15 or 30 minutes, or 1 hour; past 20 seconds on the disk, and never past the moment Firefox closes: what a closed Firefox leaves behind is deleted a minute after it starts again). The player of the page opened again plays on with it, also when the site gives the video a new signed link at every load. Whatever no player takes back in that time is let go of, and its files are deleted. To start from scratch instead, click the "Reusing ... already downloaded" notice the player shows, or **Download the video again** in the player's menu.

## Your settings on several computers

The options page exports all settings to a file and imports them again (Options > Import/Export Settings). Below those buttons, **Export to cloud** and **Import from cloud** do the same through Firefox Sync: the copy reaches your other computers only when Firefox is signed in to a Mozilla account with "Add-ons" checked in Firefox's Sync settings (Firefox syncs about every 10 minutes; "Sync Now" is faster). Firefox gives add-ons 100 KB there; very long URL lists need the file instead. This is for Firefox on the desktop only: Firefox for Android keeps add-on storage on the phone, so the cloud buttons are not shown there. Firefox Sync carries the copy, as it does your bookmarks; FastStream itself still contacts no server of its own.

## Browser compatibility

FastStream is built for Firefox on the desktop. It also runs in Firefox for Android: see [Firefox for Android](#firefox-for-android). Chrome and other Chromium browsers are not supported and are not tested.

## Installation

FastStream installs in your normal Firefox (version 153 or newer). You do not need Firefox Developer Edition, Nightly, or any change in `about:config`: every release is signed by Mozilla.

1. Open the [latest release](https://github.com/Nawid3333/FastStream/releases/latest) and download the file whose name ends in **`.xpi`** (for example `99f1b8e844554f46b28a-1.3.82.192.xpi`).
2. Install it: drag the file into a Firefox window, or open `about:addons`, click the gear icon and choose **Install Add-on From File...**, then pick the file.
3. Click **Add** when Firefox asks.

**Updates** come like those of any other add-on: Firefox checks for them by itself, and installs a new version when there is one. To check right away, open `about:addons`, click the gear icon and choose **Check for Updates**. (The add-on tells Firefox where to look: each release publishes an `updates.json`.)

You do not need the other files on the release page. The `firefox-github-*.zip` is an unsigned build for developers: a normal Firefox loads it only as a temporary add-on, which is gone after a restart and never updates.

### Firefox for Android

The same signed `.xpi` installs in Firefox for Android (version 153 or newer). Firefox for Android installs an add-on file only from a menu that is hidden at first:

1. On your phone, open the [latest release](https://github.com/Nawid3333/FastStream/releases/latest) in Firefox and download the file whose name ends in **`.xpi`**.
2. In Firefox, open **Settings > About Firefox** and tap the Firefox logo five times, until Firefox says the debug menu is enabled.
3. Go back to **Settings** and tap **Install extension from file**, then pick the `.xpi` you downloaded.
4. Tap **Add** when Firefox asks.

Updates come by themselves here too.

On a phone, FastStream has no MPV mode (Android has no helper programs for add-ons), no keyboard shortcuts and no right-click menu. The player and its settings are the same as on the desktop, and its controls were made for a mouse and a keyboard, not yet for a touch screen.

## Build Instructions

You need Node.js 22 or newer and pnpm 12.

1. `pnpm install`
2. `pnpm run build`
3. The Firefox bundles and the web build are in the `built` directory. `pnpm run build:keep` also leaves the unpacked `build_firefox_*` directories, which `web-ext run` and `web-ext lint` need.

`pnpm test` runs the unit tests, `pnpm run lint` and `pnpm run typecheck` the static checks, and `pnpm run verify` everything, end-to-end tests included (they drive Firefox).

The web build (`built/web`) runs the player in an ordinary page, without OpenSubtitles or header overrides. This fork does not host it anywhere.

## Credits

Many thanks to the contributors of this project.

#### Developers
- Andrews54757: Lead developer
- ChromiaCat: Update notify icon (PR #142)
- frenicohansen: SRT/ASS subtitles to WebVTT (PR #323)
- Mesoon5642: Options search (PR #459)
- nonab: Fixed vimeo playback (PR #489)
- Nawid3333: this Firefox fork

#### Translators
- Dael (dael_io): Fixed Spanish translations
- reindex-ot: Japanese translations
- elfriob: Russian translations
- Justryuz: Malay translations
- CommandLeo: Italian translations
- andercard0: Portuguese translations
- MrMysterius: German translations

#### Open Source Libraries

- [hls.js](https://github.com/video-dev/hls.js): Used for HLS playback
- [dash.js](https://github.com/Dash-Industry-Forum/dash.js): Used for DASH playback
- [mp4box.js](https://github.com/gpac/mp4box.js): Used for automatic fragmentation of mp4 files
- [vtt.js](https://github.com/videojs/vtt.js) (the bundle dash.js keeps of it): Used for parsing VTT subtitles
- [Mediabunny](https://github.com/Vanilagy/mediabunny): Used for reading WebM and copying streams into MP4 when saving
- And some more! [docs/vendored-libraries.md](docs/vendored-libraries.md) lists every one, with its version and what this project changed in it.

## Technical Details

[CLAUDE.md](CLAUDE.md) holds the rules every change follows, [docs/notes/](docs/notes/) the working notes by area (conventions, tests, decisions), and [docs/](docs/) the runbooks: maintenance, patched and vendored libraries, upstream syncs.

## License

FastStream's own code is Andrews54757's, all rights reserved, and the libraries it ships keep their own licenses: [LICENSE.md](LICENSE.md) has the terms, and [docs/vendored-libraries.md](docs/vendored-libraries.md) each library's version and what this project changed in it.

## Disclaimer

While it may be possible for FastStream to save videos from any website as long as there is no DRM, that doesn't mean you have the legal right to do so if you don't own the content. Please be mindful of how you use this tool. FastStream should not be used to infringe copyright.
