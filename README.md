[![logotext1](https://github.com/user-attachments/assets/cefd20ba-606a-482c-a522-36b3419e93c7)](https://faststream.online)

# FastStream

Tired of having videos buffer with slow internet speeds? Frustrated by a website's lack of accessibility features? This extension will replace videos on websites with a video player designed for your convenience. Say goodbye to buffering and hello to a more accessible video experience!

1. Watch videos without interruptions by pre-buffering the video in the background. Automatic fragmentation and parallel requests for up to 6x faster download speeds.
2. Advanced subtitling features include: customizable subtitle appearance, built-in OpenSubtitles support to find subtitles on the internet, and an intuitive subtitle syncing tool to adjust subtitle timings on the fly.
3. Adjustable audio dynamics (equalizer, compressor, mixer, mono mode, volume booster), and video settings (brightness, contrast, hue, LMS daltonization for color blindness) for your unique audiovisual preferences.
4. 20+ remappable keybinds and accessible tool buttons for easy control of the player.
5. Available in multiple languages! Translated into Spanish, Japanese, Russian, Malay, and Italian by the FastStream community. Support for more languages is coming soon!

The player currently supports:
- MP4 videos (.mp4)
- HLS streams (.m3u8)
- DASH streams (.mpd)

To use the player, simply:
1. Go to any website you want with a video and toggle the extension on. Any video it detects will be automatically replaced with the FastStream player.
2. Alternatively, you can also simply click on or navigate to a stream manifest file (m3u8/mpd) to begin playing.
3. Navigate to a new tab and press the extension icon to go to the player. Play sources detected on other tabs through the Sources Browser. You can also drag and drop video files from your computer. 

Notes:
- Livestreams are not supported. They will not be supported in the near future.
- This player will not function with DRM protected content. This is intended. Please be mindful of how you use this tool. FastStream should not be used to infringe copyright.
- This player is still a work-in-progress. Please report any bugs to the Github issue tracker here: https://github.com/Nawid3333/FastStream/issues
- For your privacy, this extension **does not collect telemetry**. Nor does it require additional resources from the internet to function. It will work fully offline. Feel free to browse the codebase on Github.
- **We take accessibility concerns seriously**. If you need accommodations not available in the latest version, please contact us and we will work on it ASAP. Also, please feel free to submit feature requests or suggestions on the Github issue tracker!
- The default maximum size for pre-buffering is 5GB. This can be changed in the settings page. Please be mindful of your computer's storage space when changing this setting. Browsers will offload data in the RAM to the SSD if the video is too large. Frequently pre-buffering large videos can reduce the lifespan of your SSD.

## Demo

See the player in action without installing the extension! Runs in Firefox. Note: Some features (OpenSubtitles/header override) are not available without installation.

[Web Version + Big Buck Bunny](https://faststream.online/player/#https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8)

## Browser compatibility

FastStream is built for Firefox on the desktop. Chrome and other Chromium browsers are not supported and are not tested, and there are no plans for mobile.

## Installation

Download the `.xpi` from the [Releases page](https://github.com/Nawid3333/FastStream/releases) and open it in Firefox (drag it into a window, or `about:addons` → the gear → Install Add-on From File). It needs Firefox 142 or newer. The release is signed by Mozilla for self-distribution, so it installs in an ordinary Firefox, and Firefox checks for updates by itself: every release publishes an `updates.json` that the extension points at.

The `firefox-github-*.zip` on the same page is an unsigned build for development; loading it needs Firefox Developer Edition or a temporary add-on (`about:debugging`).

## Build Instructions

You need Node.js 20 or newer and pnpm 11.

1. `pnpm install`
2. `pnpm run build`
3. The Firefox bundles and the web build are in the `built` directory. `pnpm run build:keep` also leaves the unpacked `build_firefox_*` directories, which `web-ext run` and `web-ext lint` need.

`pnpm test` runs the unit tests, `pnpm run lint` and `pnpm run typecheck` the static checks, and `pnpm run verify` everything, end-to-end tests included (they drive Firefox).

## Credits

Many thanks to the contributors of this project.

#### Developers
- Andrews54757: Lead developer
- ChromiaCat: Update notify icon (PR #142)
- frenicohansen: SRT/ASS subtitles to WebVTT (PR #323)
- Mesoon5642: Options search (PR #459)
- nonab: Fixed vimeo playback (PR #489)

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
- [jswebm](https://github.com/jscodec/jswebm): Used for demuxing webm files
- And some more! Check the `chrome/player/modules` directory for more information.

## Funding & Donation Policy

FastStream does not accept donations for the project as a whole. Please see the [wiki](https://github.com/Andrews54757/FastStream/wiki/Funding) for more details.

## Technical Details

Please see the [wiki](https://github.com/Andrews54757/FastStream/wiki/Technical-Details) for more information on the technical details!
  
## Disclaimer

While it may be possible for FastStream to save videos from any website as long as there is no DRM, that doesn't mean you have the legal right to do so if you don't own the content. Please be mindful of how you use this tool. FastStream should not be used to infringe copyright.
