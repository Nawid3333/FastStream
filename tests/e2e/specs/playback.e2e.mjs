// End-to-end playback checks of the real players and vendored libraries (hls.js, dash.js, mp4box).
// Driven through `player/index.html#<url>`: main.mjs loads the hash as a source in the mode its
// extension implies.
// A pass is currentTime advancing with decodable data: a player that loads its manifest and stalls
// fails.

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

/**
 * A local HLS stream from HLS_FIXTURES in wdio.conf.mjs.
 * @param {string} fixture - Its directory under fixtures/.
 * @param {string} kind - How it is packaged.
 * @return {Object} The STREAMS entry.
 */
function localHls(fixture, kind) {
  return {
    name: `HLS ${kind} (hls.js)`,
    hlsFixture: fixture,
    get url() {
      const {playlist} = JSON.parse(fs.readFileSync(path.join(fixturesDir, fixture, 'expected.json'), 'utf8'));
      return globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/${fixture}/${playlist}`;
    },
  };
}

/** Streams chosen to exercise one library each, all local: this suite gates CI and the release. */
const STREAMS = [
  localHls('hls-ts', 'MPEG-TS segments'),
  localHls('hls-fmp4', 'fMP4 segments'),
  localHls('hls-audio', 'with a separate audio rendition'),
  localDash('dash-template', 'SegmentTemplate'),
  localDash('dash-list', 'SegmentList'),
  localDash('dash-timeline', 'SegmentTimeline'),
  localDash('dash-base', 'SegmentBase'),
  {
    name: 'MP4 (mp4box)',
    // Built at run time against the test server's origin (window.__E2E_FIXTURES_ORIGIN__): its port
    // varies.
    get url() {
      return globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4';
    },
  },
];

/**
 * Opens the web player at a given source.
 * @param {string} [source] media URL to load, passed via the page's hash
 * @return {Promise<void>}
 */
async function openPlayer(source) {
  // The cache-busting query forces a document load: a changed fragment alone would not reload the
  // page.
  const bust = `?t=${Date.now()}`;
  await browser.url(
      '/player/index.html' + bust + (source ? '#' + source : ''));
}

/**
 * Checks FastStream's fragment list for a local DASH stream against its manifest.
 * Playback proves nothing here: a segment missing from the list is still fetched through
 * DashLoader's fallback.
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

/**
 * Checks FastStream's fragment list for a local HLS stream against its playlists: every segment, in
 * order, no gap.
 * @param {string} fixture - Directory under fixtures/ holding expected.json.
 * @return {Promise<void>}
 */
async function expectEveryHlsSegmentListed(fixture) {
  const {levels} = JSON.parse(fs.readFileSync(path.join(fixturesDir, fixture, 'expected.json'), 'utf8'));
  for (const [level, want] of Object.entries(levels)) {
    let got = [];
    // An audio rendition's playlist is loaded after the video's, so its list can lag. On a
    // timeout the comparison below fails with both lists; this says why.
    await browser.waitUntil(async () => {
      got = await browser.execute((level) => {
        return (window.fastStream.getFragments(level) || []).filter(Boolean).map((frag) => ({
          sn: frag.sn,
          start: frag.start,
          duration: frag.duration,
          file: frag.getContext().url.split('/').pop(),
        }));
      }, level);
      return got.length >= want.media.length;
    }, {timeout: 15000, interval: 250}).catch(() => {
      console.log(`      ${level}: ${got.length} of ${want.media.length} fragments listed after 15 s ` +
        '(its playlist never arrived, or arrived short)');
    });
    console.log(`      ${level}: ${got.length} fragments`);

    expect(got.map((frag) => frag.sn)).toEqual([...Array(want.media.length).keys()]);
    expect(got.map((frag) => frag.file)).toEqual(want.media);
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
    // Guards the rest of the suite: a page that does not load fails here, not as "no <video>"
    // everywhere.
    await openPlayer();
    expect(await browser.getUrl()).toContain('/player/index.html');
  });

  for (const stream of STREAMS) {
    it(`plays ${stream.name}`, async function() {
      await openPlayer(stream.url);

      // wait for the player's <video> first, or the first poll races the module graph loading
      await browser.waitUntil(
          async () => browser.execute(() => !!document.querySelector('video')),
          {timeout: 30000, timeoutMsg: 'no <video> element was created'},
      );

      // readyState >= 2: the decoder produced a frame for the current position
      await browser.waitUntil(
          async () => browser.execute(
              () => document.querySelector('video').readyState >= 2),
          {timeout: 60000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'},
      );

      const start = await browser.execute(
          () => document.querySelector('video').currentTime);

      // currentTime advancing tells real playback from a stalled player; play() is sent on every
      // poll, as the player may pause it while setting up.
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
      if (stream.hlsFixture) {
        await expectEveryHlsSegmentListed(stream.hlsFixture);
        // hls.js falls back to main-thread transmuxing when its worker fails, and still plays: this
        // checks the worker ran.
        const transmux = await browser.execute(() => {
          const hls = window.fastStream.player.hls;
          const main = hls.streamController.transmuxer;
          return {enableWorker: hls.config.enableWorker, worker: !!main?.workerContext, inline: !!main?.transmuxer};
        });
        expect(transmux).toEqual({enableWorker: true, worker: true, inline: false});
      }
    });
  }
});
