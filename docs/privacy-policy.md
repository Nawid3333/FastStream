# Privacy Policy

**FastStream Video Player (Firefox)**
Last updated: 2026-09-06

## Summary

This add-on collects nothing, sends nothing, and has no server of its own.

Everything it stores stays in your browser profile on your own machine. There
is no account, no analytics, no crash reporting, no usage counter, and no
"phone home" of any kind - not even a version check.

The add-on's manifest declares this to Firefox as
`data_collection_permissions: {"required": ["none"]}`.

## What is stored, and where

The add-on writes to `browser.storage.local` only. That is per-profile
storage on your own device.

It is **not** `browser.storage.sync`, so nothing is ever uploaded to a
Mozilla account or copied to your other devices.

What lives there is your own configuration: playback preferences, subtitle
and audio settings, keybindings, and similar options you set yourself. You
can erase all of it by removing the add-on.

No browsing history, no page contents, no video URLs, and no personal
information are recorded or transmitted anywhere.

## Network requests

The add-on contacts exactly the servers the media you are playing already
requires - the site hosting the video, and whatever CDN that site's manifest
or player points at. It does this because playing a video necessarily means
fetching it.

It never sends that information anywhere else. There is no intermediary
server, no proxy operated by this project, and no third-party service
receiving any part of it.

This Firefox build additionally has the add-on's own update checker removed
at build time, so it does not contact anything on startup either.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | Saves your settings locally (see above). |
| `tabs` | Lets the player know which tab a video belongs to, so it can attach to the right one. |
| `webRequest`, `declarativeNetRequest` | Reads and adjusts request headers for the video streams you play. Some hosts serve media only with particular `Referer`/`Origin` headers; without this the video will not load. |
| `downloads` | Saves a video or subtitle file when *you* click download. Nothing is downloaded without your action. |
| `cookies` | Only to read the container ID (`cookieStoreId`) of the tab you started from, so that a download opened from a Firefox Container tab stays in that same container. The add-on never reads, writes, or transmits cookie values. |
| `<all_urls>` | FastStream is a general-purpose video player - it cannot know in advance which site you will play a video on. It activates on a page only when you invoke it or when a supported video is detected. |

## What this build does not include

This Firefox build ships without YouTube support. The code that handled
YouTube - including its sandboxed script evaluation - is removed at build
time, not merely disabled. See `docs/vendored-libraries.md`.

## Third-party code

The add-on bundles well-known open-source media libraries (hls.js, dash.js,
mp4box, ONNX Runtime and others). None of them are configured to report
telemetry. Their exact upstream versions, and every modification made to
them, are documented in `docs/vendored-libraries.md` and reproducible from
the `patches/` directory in the source repository.

## Contact

Issues and questions: https://github.com/Nawid3333/FastStream/issues
