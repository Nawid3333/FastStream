// An MP4 plays from what has come so far, not only once its next keyframe has come too.
//
// MP4Player has mp4box cut the file into segments for the SourceBuffer, one frame each - but
// mp4box's default ended a video segment only at a keyframe (rapAlignement): the first frame
// went alone, and every frame from there to the next keyframe waited until the last of them
// was downloaded. The video showed its first frame and stood there for that whole stretch,
// after a seek and a stall too: 2.0 s after the first frame on a shared 12 Mbit/s line, 3.3 s
// at 4 Mbit/s per connection (measured 2026-11-06, long-av.mp4: keyframes 8.3 s apart).
//
// long-av.mp4's first keyframe stretch (0 - 8.3 s) ends past the first 1 MB range
// (MP4Player's FRAGMENT_SIZE) - its next keyframe is at byte 1,027,012 - and the server here
// holds back every range after the first. The video must play from the first range alone.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {byteRange} from '../serveFile.mjs';

const PORT = 41899;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/long-av.mp4');
// Long enough that the first range alone has to do: the spec is over before it ends.
const HOLD_MS = 20000;

let server;
let laterRangesServed = 0;
// The end of the first range asked for (MP4Player's FRAGMENT_SIZE).
let firstRangeEnd = -1;
// Where long-av.mp4's second keyframe starts: the first range must end before it.
const SECOND_KEYFRAME_BYTE = 1027012;

describe('An MP4 whose first keyframe stretch runs past the first range', function() {
  before(async function() {
    const data = fs.readFileSync(FIXTURE);
    server = http.createServer((req, res) => {
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes'};
      if (!req.url.startsWith('/long.mp4')) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      const asked = byteRange(req.headers.range, data.length);
      const range = typeof asked === 'object' ? asked : null;
      const start = range ? range.start : 0;
      const end = range ? range.end : data.length - 1;
      const send = () => {
        if (res.destroyed) return;
        if (start > 0) laterRangesServed++;
        res.writeHead(range ? 206 : 200, {...headers, 'Content-Length': end - start + 1,
          ...(range ? {'Content-Range': `bytes ${start}-${end}/${data.length}`} : {})});
        res.end(data.subarray(start, end + 1));
      };
      // The first range at once, the rest only after the spec is over.
      if (start === 0) {
        firstRangeEnd = end;
        send();
      } else {
        setTimeout(send, HOLD_MS);
      }
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    await browser.url('about:blank');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('plays the frames of the first range before the rest of their stretch has come', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/long.mp4`);
    let last;
    await browser.waitUntil(async () => {
      last = await browser.execute(() => {
        const video = window.fastStream?.player?.getVideo?.();
        if (!video) return null;
        if (video.paused && video.readyState >= 2) video.play().catch(() => {});
        const buffered = video.buffered;
        return {time: video.currentTime, readyState: video.readyState,
          bufferedEnd: buffered.length ? buffered.end(buffered.length - 1) : 0};
      });
      return !!last && last.time > 1;
    }, {timeout: 12000, interval: 200}).catch(() => {
      // What it reached by then (the options' message is made before the wait runs).
      throw new Error(`did not play from the first range: ${JSON.stringify(last)}`);
    });
    // From the first range alone: everything after it is still held back.
    // A first range that held the next keyframe too would play without the fix as well: this
    // spec would no longer tell (glm's review).
    expect(firstRangeEnd).toBeGreaterThan(0);
    expect(firstRangeEnd).toBeLessThan(SECOND_KEYFRAME_BYTE);
    expect(laterRangesServed).toBe(0);
    // About 7.8 s of the first keyframe stretch is in the first megabyte.
    expect(last.bufferedEnd).toBeGreaterThan(5);
  });
});
