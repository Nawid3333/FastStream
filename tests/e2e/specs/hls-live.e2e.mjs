// A live HLS stream: its playlist is a window that moves on, one segment at a time.
//
// Two things stopped one. hls.js reloads the playlist to see what is new, and FastStream's
// download manager answered every reload from its store with the first window: the stream
// ended where that window did (one request reached the server in 30 s).
//
// And HLSPlayer keeps its own list of every fragment it has seen, with the time each one
// starts and ends; the progress bar, the pre-buffering and a save all go by it. It placed
// the first fragment of every playlist it received at 0. For a VOD playlist that is right,
// but a live one's window moves on, so each refresh placed its new fragments over the
// ones already listed. hls.js itself keeps the live timeline, and by the time the player
// hears of a refresh its fragments start where they belong.
//
// This serves the five segments of the hls-ts fixture as a live playlist, three at a time,
// moving on every two seconds.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

const LIVE_PORT = 41885;
const LIVE_ORIGIN = `http://127.0.0.1:${LIVE_PORT}`;
// The hls-ts fixture's segments and their lengths (fixtures/hls-ts/index.m3u8).
const SEGMENTS = [2, 2, 2, 2, 1];
const WINDOW = 3;
const STEP_MS = 2000;

let server;
let firstRequest = null;
let playlistRequests = 0;

/**
 * The live playlist as it is now: three segments, starting later every STEP_MS from the
 * first request, until the window reaches the last segment.
 * @return {string}
 */
function livePlaylist() {
  firstRequest ??= Date.now();
  const first = Math.min(Math.floor((Date.now() - firstRequest) / STEP_MS), SEGMENTS.length - WINDOW);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${first}`];
  for (let sn = first; sn < first + WINDOW; sn++) {
    const name = `seg-${String(sn).padStart(3, '0')}.ts`;
    lines.push(`#EXTINF:${SEGMENTS[sn].toFixed(6)},`, `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/hls-ts/${name}`);
  }
  return lines.join('\n') + '\n';
}

describe('A live HLS stream', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      });
      playlistRequests++;
      res.end(livePlaylist());
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(LIVE_PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    await new Promise((resolve) => server.close(resolve));
  });

  let fragments = [];

  it('gets every new window of the playlist', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}#${LIVE_ORIGIN}/live.m3u8`);

    // The last segment is only in the third window, so its arrival means two refreshes.
    await browser.waitUntil(async () => {
      fragments = await browser.execute(() => {
        const client = window.fastStream;
        const level = client?.player?.getCurrentVideoLevelID?.();
        return (level ? client.getFragments(level) || [] : []).filter(Boolean)
            .map((frag) => ({sn: frag.sn, start: frag.start, end: frag.end}));
      });
      return fragments.some((frag) => frag.sn === SEGMENTS.length - 1);
    }, {timeout: 30000, interval: 250, timeoutMsg: 'the last window never arrived'}).catch(() => {});
    console.log('      fragments:', JSON.stringify(fragments), 'playlist requests:', playlistRequests);

    expect(playlistRequests).toBeGreaterThan(2);
    expect(fragments.map((frag) => frag.sn)).toEqual([...SEGMENTS.keys()]);
  });

  it('lists the fragments of each new window after the ones before, not over them', async function() {
    expect(fragments).toHaveLength(SEGMENTS.length);
    fragments.forEach((frag, i) => {
      expect(frag.end - frag.start).toBeCloseTo(SEGMENTS[i], 1);
      if (i > 0) {
        expect(Math.abs(frag.start - fragments[i - 1].end)).toBeLessThan(0.1);
      }
    });
  });
});

// A live playlist that moves on by more than a window: segments 0-2, then segment 4
// alone, as a reload that came too late sees it. Segment 3 is never listed.
// - That leaves a gap in the player's list of fragments, and the progress bar, which draws
//   that list, threw on a gap after a fragment, on every tick.
// - hls.js seeks to the new window while a fragment is loading, and asks the loader how
//   far along it is (stats.loading.first); FastStream's loader had no such stats before
//   its download first reported, which threw in hls.js's seek handling.
const JUMP_PORT = 41887;
const JUMP_ORIGIN = `http://127.0.0.1:${JUMP_PORT}`;

describe('A live HLS stream that skips a segment', function() {
  let started = null;
  let jump;

  /**
   * A playlist of the hls-ts fixture's segments.
   * @param {number[]} sns - The segments' sequence numbers, in order, without gaps.
   * @return {string}
   */
  const playlist = (sns) => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${sns[0]}`];
    for (const sn of sns) {
      lines.push(`#EXTINF:${SEGMENTS[sn].toFixed(6)},`,
          `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/hls-ts/seg-${String(sn).padStart(3, '0')}.ts`);
    }
    return lines.join('\n') + '\n';
  };

  before(async function() {
    jump = http.createServer((req, res) => {
      started ??= Date.now();
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      });
      res.end(playlist(Date.now() - started < STEP_MS ? [0, 1, 2] : [4]));
    });
    await new Promise((resolve, reject) => {
      jump.on('error', reject);
      jump.listen(JUMP_PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    await new Promise((resolve) => jump.close(resolve));
  });

  it('goes on past a gap in a live window, and draws the fragments on both sides of it', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}#${JUMP_ORIGIN}/jump.m3u8`);
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream), {timeout: 30000});
    // The page's uncaught errors, from the start.
    await browser.execute(() => {
      window.__errors = [];
      window.__stacks = [];
      window.addEventListener('error', (e) => {
        window.__errors.push(String(e.message));
        window.__stacks.push(String(e.error?.stack || '').split('\n').slice(0, 6).join(' < '));
      });
    });
    let fragments = [];
    await browser.waitUntil(async () => {
      fragments = await browser.execute(() => {
        const client = window.fastStream;
        const level = client?.player?.getCurrentVideoLevelID?.();
        return (level ? client.getFragments(level) || [] : []).filter(Boolean)
            .map((frag) => ({sn: frag.sn, start: frag.start, end: frag.end}));
      });
      return fragments.some((frag) => frag.sn === 4);
    }, {timeout: 30000, interval: 250, timeoutMsg: 'segment 4 was never listed'}).catch(() => {});
    // The bar is drawn once a second.
    await browser.pause(2500);
    const state = await browser.execute(() => ({
      errors: window.__errors.slice(0, 3),
      stacks: [...new Set(window.__stacks)].slice(0, 3),
      bar: window.fastStream.interfaceController.progressBar.progressCache.map((entry) => ({start: entry.start, width: entry.width})),
    }));
    console.log('      fragments:', JSON.stringify(fragments), 'state:', JSON.stringify(state));
    expect(fragments.map((frag) => frag.sn)).toEqual([0, 1, 2, 4]);
    expect(state.errors).toEqual([]);
    // Segment 4 is drawn from its own start, not from where segment 2 ended.
    const four = fragments.find((frag) => frag.sn === 4);
    expect(state.bar.some((entry) => Math.abs(entry.start - four.start) < 0.1)).toBe(true);
  });
});
