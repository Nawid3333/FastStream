# Manual playback testing

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Manual playback testing

```bash
pnpm run profile:setup   # once: builds .dev-profile with uBlock Origin
pnpm run build:keep
pnpm run start:ff        # persistent profile, uBO enabled
pnpm run start:ff:clean  # throwaway profile, FastStream only
```

The dev profile exists because real streaming sites are dense with ads and
overlay players, which makes "FastStream failed to replace the player"
indistinguishable from "an ad iframe got in the way". `.dev-profile/` is
gitignored.

**How FastStream picks up a stream URL.** `background.mjs:913`
`setupRedirectRule` installs a declarativeNetRequest rule matching
`^.+\.(m3u8|mpd)([?#].*)?$` on `main_frame` and redirects to the player with
the URL in the hash. So pasting a manifest URL into the address bar opens it
in FastStream — **but only when the matching option is on, and both default
to `false`** (`DefaultOptions.mjs:13-14`):

- `playMP4URLs` → rule 1, `.mp4`
- `playStreamURLs` → rule 2, `.m3u8` and `.mpd`

Enable them in the extension's options page before testing by URL. Without
them, use a page that embeds the stream and click the FastStream toolbar
icon instead.

### The playback checklist

**This is the reference baseline. Re-run it after every change to the player,
the loaders or the vendored libraries.** Confirmed working on upstream
`d5fe931` + the tooling commits, firefox-github build, 2026-09-02:

| Format | Page | Status |
|---|---|---|
| DASH | `https://reference.dashif.org/dash.js/v4.4.0/samples/getting-started/auto-load-single-video-src.html` | works |
| HLS | `https://tracylocalschool.com/gquzbcolcgom` | works |
| MP4 | `https://video.nie.edu.sg/media/Sample-Video-File-For-Testing.mp4/0_9311zvk2/22238` | works |

These are **pages that embed a stream**, so they exercise the content-script
detection path — the one real users hit. That is the more valuable test than
a pasted manifest URL, which only exercises the declarativeNetRequest
redirect.

**Automated: `pnpm run test:live`** (after `pnpm run build:keep`; 2026-09-27), and every
Monday on Linux and Windows in `live-streams.yml` (2026-09-28; an issue when it fails,
closed by the next green run - never part of CI, so an outage elsewhere holds nothing back).
`tests/e2e/live-specs/streams.e2e.mjs` runs this checklist on the installed extension
against real streams: Shaka Player's demo assets on storage.googleapis.com (HLS and DASH
angel-one: 5 qualities, 5 audio languages; DASH Sintel, 888 s, seeked 10 minutes in; a
live DASH stream) and a progressive MP4 on raw.githubusercontent.com. The pages are local
and embed them the way sites do: the site's own hls.js/dash.js (the official releases of
the versions `package.json` pins, from the npm registry, cached in the gitignored `tests/e2e/fixtures/live-libs`), a
plain `<video src>`, a cross-origin iframe that may go fullscreen (player laid over it)
and one that may not (the frame is sent to the player page), plus a manifest opened
directly (`playStreamURLs`). Not in `verify` or CI: a third-party outage must not block a
release. Two things it found on its first run: a page whose query string names a stream
was taken for the stream, and the player that takes over an iframe without
`allowfullscreen` got no sources (PRs #40 and #41, each with its own ext-spec). Pages
name their stream by key (`/hls?stream=hls`), never by URL, so the suite does not depend
on the first fix. A test that switches into a frame must switch back before
`browser.url()`, which navigates the frame WebDriver is in.

**The player libraries sites use** (2026-10-07): `tests/e2e/live-specs/players.e2e.mjs`, in
the same `test:live` run and the same weekly workflow. Most sites play through a player
library, not bare hls.js or dash.js, and each wraps, moves or hides the `<video>` in its
own way. 11 libraries, each the official release at an exact version pinned in the spec
(from the npm registry, checked against the registry's integrity and cached as a tarball
in `tests/e2e/fixtures/live-libs`): video.js (HLS, DASH, MP4), Shaka (HLS, DASH), Plyr,
Clappr, MediaElement, Vidstack (a web component), Media Chrome with `<hls-video>` (its
`<video>` in a shadow root, as Mux's players have it), DPlayer, Artplayer, xgplayer (its
own HLS code, not hls.js), OpenPlayerJS - HLS on all, DASH on two, MP4 on nine: 22 cases.
Each page starts its player muted, as a visitor's click does. Two passes, so a failure
says whose it is: each page first plays on its own with FastStream not enabled there
(the page and the library are right), then, auto-enabled, FastStream must replace each
player, play, seek and play on. `LIVE_PLAYERS=plyr,mp4` (substrings of "name format")
and `LIVE_PHASE=own|faststream` narrow a run to look into one failure. The shared steps
(the npm cache, entering the player, its state, play and seek) are in
`live-specs/liveSite.mjs`, which `streams.e2e.mjs` uses too. Its first run (one Windows
pass, about 9 minutes): every page played on its own, FastStream took over all of them
for HLS and DASH (the shadow-root `<hls-video>` included), and missed the MP4 in 5 of 9
(the bug below). VHS, video.js's engine, plays DASH only from fMP4: Shaka's angel-one
also offers WebM, so video.js gets the DASH-IF reference vector on Akamai instead.

**A file Firefox plays without a request** (2026-10-07, found by the run above). The
background learns of a stream from the request for it (`onHeadersReceived`). A page that
plays a file an earlier page of the same site had played got it from Firefox with no
request at all - none reached the extension (not even `onBeforeSendHeaders`), none reached
the server - with the file served `no-store` and with the earlier page kept out of the
back-forward cache by an `unload` listener, so neither the HTTP cache nor the bfcache;
measured with `ext-specs/same-video-file.e2e.mjs` (the server counts the requests with
`Sec-Fetch-Dest: video`). On a site FastStream was already on for, nothing asked the page
either: `recoverSources` runs when FastStream is turned on, and the tab already was. So
the second page's player never opened (the same video opened again from a link). Seen
alone, each of those pages passed; one after another, every MP4 page after the first
failed, and one passed now and then (the background unloaded in a 60 s wait, its state
gone). content.js now reports a `<video>`'s http(s) `currentSrc` on `loadedmetadata`
(capture, document and the shadow roots it listens in), once per URL per page, as a
`LOADED_MEDIA` of one resource: the background takes it like a recovered stream
(`recoverFrameSources`), and a URL it knows already changes nothing. The request comes
first: its own headers (an `Origin`) are the ones to keep, not the page's stand-ins
(`pageHeaders`), and the page's word could beat its `onHeadersReceived` from a fast server -
taken at once, it lost `mpv.e2e.mjs`'s crossorigin video its `Origin` on the hand-off. So a
report marked `live` waits `LiveMediaReportWaitMs` (1 s) in the background, and
`onSourceRecieved` takes a source in before its first await (two detections of one URL both
passed the check while waiting); the report's `cors` (the video's `crossorigin`) gives the
stand-ins an `Origin` where the request would have had one. After the wait, only the page
that told it, still shown, takes the file in (`isTracked()` and the same `documentKey`): a
tab gone on to the next site within the second had the frame emptied by `FRAME_REMOVED`,
and its unnamed page took the last page's file as its first stream - mpv got that one again
instead of the new page's (mpv.e2e.mjs step 8). Unit tests in `backgroundMpv.test.mjs` (a
mutant taking the page's word at once fails; one without the page check fails). Same reach as the
request: a preview or ad video counts, as its request always did; a video in a shadow root
content.js has not found yet is not heard (media events stay in their root; roots are found
as the user acts), and turning FastStream on still finds it (`loadedMedia`). The wrong leads, for
the record: the HTTP cache (`max-age=300` on the test MP4; the same misses with the cache
off), and the bfcache (the same misses with the earlier page out of it).

Direct manifests for testing the redirect path instead (all verified
`200 application/dash+xml`), which need `playStreamURLs` enabled first:

- `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` (DASH-IF reference vector)
- `https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd`

Real sites serving DASH: Bilibili (has a dedicated content script at
`chrome/custom/bilibili_content.js`), and most large video platforms.

**YouTube support was removed entirely** (all targets, not just AMO) —
`YTPlayer`, the sandboxed evaluator, `yt.mjs`, `googlevideo.mjs`,
`yt_runner.js` and `custom/yt_content.js` are gone, along with the
`userScripts` permission and every `PlayerModes.ACCELERATED_YT` branch. See
"YouTube removal" below.
