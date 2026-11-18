// A segment whose answer is cut part-way costs a retry, not the video.
//
// The first answer for the 4-6 s segment is cut after half its body and the connection reset: the
// player asks again and plays on. From a server that offers ranges it asks for the rest only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

const PORT = 41964;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
// Per fixture, its manifest; per case, the answer cut: the segment from 4 s to 6 s, or the
// video's initialization segment.
const STREAMS = {
  'dash-template': {manifest: 'manifest.mpd'},
  'hls-fmp4': {manifest: 'index.m3u8'},
};
// The dash-template fixture twice, as two Periods, the second's segments under addresses of
// their own (?p=1): a manifest of several periods, whose later segments the player's store has
// no place for (DashLoader.loadFragmentInternal) and fetches as they are asked for.
const TWO_PERIODS = 'two-periods.mpd';
const CASES = [
  {stream: 'dash-template', cut: 'chunk-stream0-00003.m4s'},
  {stream: 'hls-fmp4', cut: 'seg-002.m4s'},
  {stream: 'dash-template', cut: 'init-stream0.m4s'},
  {stream: 'hls-fmp4', cut: 'init.mp4'},
  // The second Period's 4-6 s segment: 13-15 s.
  {stream: 'dash-template', manifest: TWO_PERIODS, cut: 'chunk-stream0-00003.m4s?p=1', end: 15},
  // Started in the second Period (as after a seek there), its first audio segment cut: the
  // benchmark's case (a seek to 271 s of a 67-Period manifest sat there for good). The
  // segments the store has no place for were fetched with no retry (DashLoader.request,
  // maxRetry 0), and dash.js did not ask for the failed one again.
  {stream: 'dash-template', manifest: TWO_PERIODS, start: 11, cut: 'chunk-stream1-00002.m4s?p=1', end: 13},
  // A server that offers ranges: the second request asks from the byte the cut stopped at.
  {stream: 'hls-fmp4', cut: 'seg-002.m4s', resumable: true},
];

/**
 * The dash-template manifest as two Periods of 9 s.
 * @return {string}
 */
function twoPeriods() {
  const fixture = fs.readFileSync(path.join(FIXTURES, 'dash-template', 'manifest.mpd'), 'utf8');
  // Every replacement has to find its text: a fixture that changed fails here, not as a timeout.
  const swap = (text, from, to) => {
    if (!text.includes(from)) throw new Error(`the dash-template fixture changed: no ${from}`);
    return text.replaceAll(from, to);
  };
  const tag = '<Period id="0" start="PT0.0S">';
  const period = fixture.slice(fixture.indexOf('<Period'), fixture.indexOf('</Period>') + '</Period>'.length);
  const second = swap(swap(period, tag, '<Period id="1" start="PT9.0S">'), '.m4s"', '.m4s?p=1"');
  return swap(fixture.slice(0, fixture.indexOf('<Period')), 'mediaPresentationDuration="PT9.0S"', 'mediaPresentationDuration="PT18.0S"') +
    swap(period, tag, '<Period id="0" start="PT0.0S" duration="PT9.0S">') + '\n' + second + '\n</MPD>\n';
}
/** @type {string} The answer the running case cuts. */
let cutting = '';
// Whether the server of the running case answers ranges (Accept-Ranges, 206).
let resumable = false;
const CUT_END = 6;
const TYPES = {'.mpd': 'application/dash+xml', '.m3u8': 'application/vnd.apple.mpegurl'};

describe('An answer cut part-way', function() {
  let server;
  /** @type {Map<string, number>} Requests per path, this test's. */
  const asked = new Map();
  /** @type {Map<string, Array<?string>>} Each request's Range header, per path. */
  const rangesAsked = new Map();

  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, ORIGIN);
      const pathname = url.pathname + url.search;
      const [, stream, name] = url.pathname.split('/');
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'};
      if (stream === 'dash-template' && name === TWO_PERIODS) {
        res.writeHead(200, {...headers, 'Content-Type': TYPES['.mpd']});
        res.end(twoPeriods());
        return;
      }
      const file = STREAMS[stream] && /^[\w.-]+$/.test(name || '') && path.join(FIXTURES, stream, name);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      const count = (asked.get(pathname) || 0) + 1;
      asked.set(pathname, count);
      rangesAsked.set(pathname, [...(rangesAsked.get(pathname) || []), req.headers.range || null]);
      const data = fs.readFileSync(file);
      const type = TYPES[path.extname(name)] || 'video/mp4';
      const range = resumable && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (resumable) {
        headers['Accept-Ranges'] = 'bytes';
        headers['Access-Control-Expose-Headers'] = 'Accept-Ranges, Content-Range';
      }
      if (range) {
        const from = Number(range[1]);
        const to = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        res.writeHead(206, {...headers, 'Content-Type': type, 'Content-Length': to - from + 1,
          'Content-Range': `bytes ${from}-${to}/${data.length}`});
        res.end(data.subarray(from, to + 1));
        return;
      }
      res.writeHead(200, {...headers, 'Content-Type': type, 'Content-Length': data.length});
      if (pathname === cutting && count === 1) {
        // Half of it, then the connection goes.
        res.write(data.subarray(0, data.length >> 1), () => res.destroy());
        return;
      }
      res.end(data);
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  for (const {stream, manifest = STREAMS[stream].manifest, start, cut, end = CUT_END, resumable: ranges = false} of CASES) {
    it(`is asked for again, and the video plays on past it (${manifest}${start ? ` from ${start} s` : ''}, ${cut}${ranges ? ', the rest only' : ''})`, async function() {
      asked.clear();
      rangesAsked.clear();
      cutting = `/${stream}/${cut}`;
      resumable = ranges;
      const at = start ? `?faststream-timestamp=${start}` : '';
      await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/${stream}/${manifest}${at}`);
      let state = {time: 0, failed: false};
      try {
        await browser.waitUntil(async () => {
          state = await browser.execute(() => {
            const client = window.fastStream;
            const video = client?.player?.getVideo();
            if (!video) return {time: 0, failed: false};
            if (video.paused && !video.ended) video.play().catch(() => {});
            const ranges = [];
            for (let i = 0; i < video.buffered.length; i++) ranges.push(`${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}`);
            return {time: video.currentTime, failed: !!client.interfaceController.failed, readyState: video.readyState,
              buffered: ranges.join(' '), status: Array.from(document.querySelectorAll('.status_message')).map((e) => e.textContent.trim()).filter(Boolean)};
          });
          return state.time > end + 0.5 || state.failed;
        }, {timeout: 30000, interval: 250});
      } finally {
        console.log(`      ${stream}: ${JSON.stringify({...state, asked: asked.get(`/${stream}/${cut}`)})}`);
      }
      expect(state.failed).toBe(false);
      expect(state.time).toBeGreaterThan(end + 0.5);
      expect(asked.get(`/${stream}/${cut}`)).toBeGreaterThanOrEqual(2);
      if (ranges) {
        const length = fs.statSync(path.join(FIXTURES, stream, cut)).size;
        expect(rangesAsked.get(`/${stream}/${cut}`)).toEqual([null, `bytes=${length >> 1}-${length - 1}`]);
      }
    });
  }
});
