// An HLS stream with an interstitial: an EXT-X-DATERANGE of CLASS "com.apple.hls.interstitial"
// whose X-ASSET-URI is another stream, the ad, played at that point of the timeline.
//
// hls.js plays one in a player of its own, built from the same config, so it loaded through
// FastStream's loader and level control, which drive none of it. Measured before
// enableInterstitialPlayback went off (HLSPlayer), on the hls-ts fixture's 9 s with a 9 s ad:
// a break that replaces part of the stream (no X-RESUME-OFFSET, as live ad insertion has it)
// made the video skip from 0 to 9.9 s within a second and end at 13; plain hls.js played the
// stream to 4 s, then the ad. A break inserted into the stream (X-RESUME-OFFSET=0) played no
// ad in FastStream, though hls.js fetched the ad's playlist and kept a schedule that never
// moved. Now hls.js plays the stream itself, in order, as the HLS spec has a player without
// interstitials do, and never asks for the ad.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

const PORT = 41898;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
// The hls-ts fixture's segments (fixtures/hls-ts/index.m3u8): 9 s.
const DURATIONS = [2, 2, 2, 2, 1];
const START = '2026-01-01T00:00:00.000Z';

let server;
let requests = [];

/**
 * A VOD playlist of the hls-ts fixture's segments, under a path of its own.
 * @param {string} prefix - main or ad.
 * @param {string[]} [tags] - Lines after EXT-X-PROGRAM-DATE-TIME.
 * @return {string}
 */
function playlist(prefix, tags = []) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-PROGRAM-DATE-TIME:${START}`, ...tags];
  DURATIONS.forEach((d, i) => lines.push(`#EXTINF:${d.toFixed(6)},`, `${ORIGIN}/${prefix}/seg-${String(i).padStart(3, '0')}.ts`));
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * The interstitial: the ad stream, 9 s, at a time of the stream.
 * @param {string} start - Its START-DATE.
 * @param {string} [attributes] - More attributes.
 * @return {string}
 */
const adBreak = (start, attributes = '') => '#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",' +
  `START-DATE="${start}",DURATION=9,X-ASSET-URI="${ORIGIN}/ad.m3u8"${attributes}`;

const PLAYLISTS = {
  '/preroll.m3u8': () => playlist('main', [adBreak(START, ',X-RESUME-OFFSET=0,CUE="PRE"')]),
  '/midroll.m3u8': () => playlist('main', [adBreak('2026-01-01T00:00:04.000Z', ',X-RESUME-OFFSET=0')]),
  '/midroll-replacing.m3u8': () => playlist('main', [adBreak('2026-01-01T00:00:04.000Z')]),
  '/ad.m3u8': () => playlist('ad'),
};

/**
 * Plays a stream to its end, noting the time every second.
 * @param {string} name - Its path.
 * @return {Promise<{times: number[], ended: boolean, duration: number, error: ?string}>}
 */
async function playThrough(name) {
  requests = [];
  await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}${name}`);
  const times = [];
  let last = null;
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    last = await browser.execute(() => {
      const client = window.fastStream;
      const video = client?.player?.getVideo();
      if (!video) return null;
      if (video.paused && !video.ended) video.play().catch(() => {});
      return {
        time: video.currentTime, ended: video.ended, duration: video.duration,
        error: client.interfaceController?.statusManager?.statusMessages?.get('error')?.message || null,
      };
    });
    if (last) times.push(last.time);
    if (last?.ended || last?.error) break;
    await browser.pause(1000);
  }
  return {times, ended: !!last?.ended, duration: last?.duration ?? NaN, error: last?.error ?? null};
}

describe('An HLS stream with an interstitial (an ad break)', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, ORIGIN);
      requests.push(url.pathname);
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'};
      if (PLAYLISTS[url.pathname]) {
        res.writeHead(200, {...headers, 'Content-Type': 'application/vnd.apple.mpegurl'});
        res.end(PLAYLISTS[url.pathname]());
        return;
      }
      const m = /^\/(main|ad)\/(seg-\d+\.ts)$/.exec(url.pathname);
      const file = m && path.join(SEGMENTS, m[2]);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t'});
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    await new Promise((resolve) => server.close(resolve));
  });

  for (const [name, what] of [
    ['/preroll.m3u8', 'inserted before the stream'],
    ['/midroll.m3u8', 'inserted into the stream'],
    ['/midroll-replacing.m3u8', 'replacing part of the stream'],
  ]) {
    it(`plays the stream itself, in order, past a break ${what}, and never asks for the ad`, async function() {
      const {times, ended, duration, error} = await playThrough(name);
      expect(error).toBe(null);
      expect(ended).toBe(true);
      // The stream's 9 s, not a timeline with the ad's 9 in it.
      expect(duration).toBeCloseTo(9, 0);
      // A second a step, never a jump.
      const steps = times.slice(1).map((t, i) => Math.round((t - times[i]) * 10) / 10);
      expect(steps.filter((s) => s < 0 || s > 2.5)).toEqual([]);
      expect(requests.filter((p) => p.startsWith('/ad'))).toEqual([]);
    });
  }
});
