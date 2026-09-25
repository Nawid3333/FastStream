// End-to-end playback checks.
//
// These replace the manual checklist in tests/manual-playback-urls.txt. That
// checklist required a person to open three URLs and watch for video after
// every change to a player, a loader or a vendored media library - which
// meant it was skipped, and it never ran on CI.
//
// The player is driven through `player/index.html#<url>`, which main.mjs
// treats as a source and loads with the mode implied by the extension. That
// seam exercises the real players and the real vendored libraries (hls.js,
// dash.js, mp4box) without depending on the page-interception UI, which is
// far more brittle to drive and is not what these changes touch.
//
// What counts as a pass is deliberately strict: not "a video element exists"
// but "currentTime advanced past zero while readyState reported decodable
// data". A player that loads its manifest and then stalls fails here, which
// is exactly the failure a library swap causes.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

/**
 * A local DASH stream from DASH_FIXTURES in wdio.conf.mjs.
 * @param {string} fixture - Its directory under fixtures/.
 * @param {string} kind - How its manifest lists the segments.
 * @return {Object} The STREAMS entry.
 */
function localDash(fixture, kind) {
  return {
    name: `DASH ${kind} (dash.js)`,
    fixture,
    get url() {
      return globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/${fixture}/manifest.mpd`;
    },
  };
}

/** Streams chosen for stability and for exercising one library each. */
const STREAMS = [
  {
    name: 'HLS (hls.js + hls.worker.js)',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  },
  {
    name: 'DASH (dash.js)',
    url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
  },
  localDash('dash-template', 'SegmentTemplate'),
  localDash('dash-list', 'SegmentList'),
  localDash('dash-timeline', 'SegmentTimeline'),
  localDash('dash-base', 'SegmentBase'),
  {
    name: 'MP4 (mp4box)',
    // Served by the local test server: same-origin, so no CORS, and no
    // network dependency once fetched. The URL is built at runtime against
    // the test server's own origin - available as a global via the config
    // (window.__E2E_FIXTURES_ORIGIN__, set by wdio.conf.mjs) - because the
    // port is chosen at run time.
    get url() {
      return globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4';
    },
  },
];

/**
 * Opens the web player at a given source.
 *
 * main.mjs treats the page hash as a source URL and picks the player mode
 * from its extension, so this one entry point reaches the HLS, DASH and MP4
 * paths - and therefore hls.js, dash.js and mp4box - without any UI driving.
 *
 * @param {string} [source] media URL to load, passed via the page's hash
 * @return {Promise<void>}
 */
async function openPlayer(source) {
  // The cache-busting query is load-bearing, not cosmetic. Navigating from
  // `index.html#a` to `index.html#b` changes only the fragment, so Firefox
  // does not reload - main.mjs reads the hash once at startup, and every test
  // after the first would silently re-measure the first stream and pass.
  // Making the path differ forces a real document load per case.
  const bust = `?t=${Date.now()}`;
  await browser.url(
      '/player/index.html' + bust + (source ? '#' + source : ''));
}

/**
 * Checks FastStream's fragment list for a local DASH stream against its manifest.
 *
 * DashPlayer.mjs builds one fragment per segment from getAllSegments(), which FastStream
 * patches into each of dash.js's segment getters. Playback does not prove that works: a
 * segment missing from the list is still fetched, through DashLoader's fallback, and the
 * stream plays either way. The list itself does - every segment the manifest names, in
 * order, at its address, with no gap in time between one and the next.
 *
 * @param {string} fixture - Directory under fixtures/ holding expected.json.
 * @return {Promise<void>}
 */
async function expectEverySegmentListed(fixture) {
  const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, fixture, 'expected.json'), 'utf8'));
  for (const [level, want] of Object.entries(expected)) {
    const got = await browser.execute((level) => {
      return (window.fastStream.getFragments(level) || []).filter(Boolean).map((frag) => ({
        sn: frag.sn,
        start: frag.start,
        duration: frag.duration,
        file: frag.request.url.split('/').pop(),
        range: frag.request.range || null,
      }));
    }, level);
    console.log(`      ${level}: ${got.length} fragments`);

    const count = (want.media || want.ranges).length;
    expect(got.map((frag) => frag.sn)).toEqual([...Array(count).keys()]);
    if (want.media) {
      expect(got.map((frag) => frag.file)).toEqual(want.media);
    } else {
      expect(got.map((frag) => frag.range)).toEqual(want.ranges);
    }
    got.forEach((frag, i) => {
      expect(frag.duration).toBeGreaterThan(0);
      if (i > 0) {
        const previous = got[i - 1];
        expect(Math.abs(frag.start - (previous.start + previous.duration))).toBeLessThan(0.01);
      }
    });
  }
}

describe('FastStream playback', function() {
  it('serves the player page', async function() {
    // Guards the rest of the suite: if the local server or the web build ever
    // stops producing a loadable page, every playback test would fail with a
    // confusing "no <video>" rather than "the page did not load".
    await openPlayer();
    expect(await browser.getUrl()).toContain('/player/index.html');
  });

  for (const stream of STREAMS) {
    it(`plays ${stream.name}`, async function() {
      await openPlayer(stream.url);

      // The player mounts its own <video>; wait for one to exist at all
      // before asking anything about it, or the first poll races the module
      // graph loading.
      await browser.waitUntil(
          async () => browser.execute(() => !!document.querySelector('video')),
          {timeout: 30000, timeoutMsg: 'no <video> element was created'},
      );

      // readyState >= 2 (HAVE_CURRENT_DATA) means the decoder produced a
      // frame for the current position - a manifest parsed but undecodable
      // does not reach this.
      await browser.waitUntil(
          async () => browser.execute(
              () => document.querySelector('video').readyState >= 2),
          {timeout: 60000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'},
      );

      const start = await browser.execute(
          () => document.querySelector('video').currentTime);

      // Advancing currentTime is the part that distinguishes real playback
      // from a loaded-but-stalled player.
      //
      // play() is re-issued on every poll rather than called once: FastStream
      // drives the element through its own state machine and can pause it
      // back while it finishes setting up, so a single call made at the wrong
      // moment is silently undone and the clip never starts.
      await browser.waitUntil(
          async () => browser.execute((t) => {
            const v = document.querySelector('video');
            if (v.paused) v.play().catch(() => {});
            return v.currentTime > t;
          }, start),
          {
            timeout: 30000,
            interval: 500,
            timeoutMsg: 'currentTime never advanced',
          },
      );

      const state = await browser.execute(() => {
        const v = document.querySelector('video');
        return {
          videos: document.querySelectorAll('video').length,
          src: (v.currentSrc || v.src || '').slice(0, 60),
          readyState: v.readyState,
          currentTime: v.currentTime,
          duration: v.duration,
          error: v.error ? {code: v.error.code, message: v.error.message} : null,
        };
      });
      console.log('      state:', JSON.stringify(state));
      expect(state.error).toBe(null);

      if (stream.fixture) {
        await expectEverySegmentListed(stream.fixture);
      }
    });
  }
});
