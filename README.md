![logotext1](https://github.com/user-attachments/assets/cefd20ba-606a-482c-a522-36b3419e93c7)

# FastStream

Tired of having videos buffer with slow internet speeds? Frustrated by a website's lack of accessibility features? This extension will replace videos on websites with a video player designed for your convenience. Say goodbye to buffering and hello to a more accessible video experience!

This is a Firefox-only fork of [Andrews54757/FastStream](https://github.com/Andrews54757/FastStream), maintained by Nawid3333 on its own since 2026-10-09 (it no longer follows upstream). It adds a hand-off to the mpv player and leaves out upstream's YouTube support.

1. Watch videos without interruptions by pre-buffering the video in the background. Automatic fragmentation and up to 6 parallel requests make downloads faster.
2. Advanced subtitling features include: customizable subtitle appearance, built-in OpenSubtitles support to find subtitles on the internet, and an intuitive subtitle syncing tool to adjust subtitle timings on the fly.
3. Adjustable audio dynamics (equalizer, compressor, mixer, mono mode, volume booster), and video settings (brightness, contrast, saturation, hue) for your unique audiovisual preferences.
4. Over 60 remappable keyboard shortcuts (mpv-style seeks, frame steps and speed presets among them) and accessible tool buttons for easy control of the player. The welcome page lists the defaults.
5. Available in 16 languages.
6. Optional: send a stream to [mpv](https://mpv.io/) on your computer instead of playing it in the browser. It needs a small helper installed once; see [README-MPV.md](README-MPV.md).

The player currently supports:
- MP4 videos (.mp4)
- HLS streams (.m3u8)
- DASH streams (.mpd)

To use the player, simply:
1. Go to any website you want with a video and toggle the extension on. Any video it detects will be automatically replaced with the FastStream player.
2. Alternatively, you can also simply click on or navigate to a stream manifest file (m3u8/mpd) to begin playing.
3. Navigate to a new tab and press the extension icon to go to the player. Play sources detected on other tabs through the Sources Browser. You can also drag and drop video files from your computer.

Notes:
- Live HLS and DASH streams play.
- This player will not function with DRM protected content. This is intended. Please be mindful of how you use this tool. FastStream should not be used to infringe copyright.
- Please report bugs, accessibility problems and feature requests on the issue tracker: https://github.com/Nawid3333/FastStream/issues
- For your privacy, this extension **does not collect telemetry** and has no server of its own. Besides the sites whose videos you play, it connects only to OpenSubtitles when you search for subtitles, and to GitHub for updates. Everything it runs ships inside the add-on. The details, permission by permission, are in [docs/privacy-policy.md](docs/privacy-policy.md).
- The default maximum size for pre-buffering is 5GB. This can be changed in the settings page. Please be mindful of your computer's storage space when changing this setting. Browsers will offload data in the RAM to the SSD if the video is too large. Frequently pre-buffering large videos can reduce the lifespan of your SSD.

## Browser compatibility

FastStream is built for Firefox on the desktop. Chrome and other Chromium browsers are not supported and are not tested, and there are no plans for mobile.

## Installation

Download the `.xpi` from the [Releases page](https://github.com/Nawid3333/FastStream/releases) and open it in Firefox (drag it into a window, or `about:addons` → the gear → Install Add-on From File). It needs Firefox 142 or newer. The release is signed by Mozilla for self-distribution, so it installs in an ordinary Firefox, and Firefox checks for updates by itself: every release publishes an `updates.json` that the extension points at.

The `firefox-github-*.zip` on the same page is an unsigned build for development; loading it needs Firefox Developer Edition or a temporary add-on (`about:debugging`).

## Build Instructions

You need Node.js 22 or newer and pnpm 11.

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
- [vtt.js](https://github.com/mozilla/vtt.js): Used for parsing VTT subtitles
- [Mediabunny](https://github.com/Vanilagy/mediabunny): Used for reading WebM and copying streams into MP4 when saving
- And some more! [docs/vendored-libraries.md](docs/vendored-libraries.md) lists every one, with its version and what this project changed in it.

## Technical Details

[CLAUDE.md](CLAUDE.md) holds the rules every change follows, [docs/notes/](docs/notes/) the working notes by area (conventions, tests, decisions), and [docs/](docs/) the runbooks: maintenance, patched and vendored libraries, upstream syncs.

## Disclaimer

While it may be possible for FastStream to save videos from any website as long as there is no DRM, that doesn't mean you have the legal right to do so if you don't own the content. Please be mindful of how you use this tool. FastStream should not be used to infringe copyright.
