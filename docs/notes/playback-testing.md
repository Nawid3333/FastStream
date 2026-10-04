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
