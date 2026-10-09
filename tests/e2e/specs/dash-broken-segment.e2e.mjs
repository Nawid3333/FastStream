// A DASH segment that does not decode costs that segment, not the video.
//
// The dash-template fixture (five 2 s segments) from a local server, its video's third segment
// (4-6 s) with its sample sizes overwritten: Firefox fails to decode it (MEDIA_ERR_DECODE on the
// <video> element), as it does a corrupt segment on a real site. The player was built again three
// times in 1.5 s at 3.64 s - each time the same segment failed again - and the video ended in
// "Failed to load video!". Now the first decode error builds the player again at the same time
// (right for Firefox's late-append bug 2069633, where the segment is fine), and the same place
// failing again right after builds it past that segment (FastStreamClient.recoverPlayer,
// BrokenMedia.mjs): the video plays on from 6 s.
//
// dash.js's own recovery does not help here: it skips a segment only when the SourceBuffer
// reports the error, and a decode error on the element only resets its MediaSource.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

const PORT = 41892;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIR = path.resolve(import.meta.dirname, '../fixtures/dash-template');
const BROKEN = 'chunk-stream0-00003.m4s';
const BROKEN_END = 6;

/**
 * The segment with every byte of its mdat payload overwritten: the NAL unit sizes inside are
 * garbage, which Firefox's decoder refuses (garbage inside a NAL unit it decodes as garbage).
 * @param {Buffer} data
 * @return {Buffer}
 */
function breakSamples(data) {
  const out = Buffer.from(data);
  let seed = 12345;
  for (let pos = 0; pos + 8 <= out.length;) {
    const size = out.readUInt32BE(pos);
    if (size < 8) break;
    if (out.toString('latin1', pos + 4, pos + 8) === 'mdat') {
      for (let i = pos + 8; i < pos + size; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        out[i] = seed & 0xff;
      }
    }
    pos += size;
  }
  return out;
}

describe('A DASH segment that does not decode', function() {
  let server;

  before(async function() {
    server = http.createServer((req, res) => {
      const name = path.basename(new URL(req.url, ORIGIN).pathname);
      const file = path.join(DIR, name);
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'};
      if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      let data = fs.readFileSync(file);
      if (name === BROKEN) data = breakSamples(data);
      res.writeHead(200, {...headers, 'Content-Type': name.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4'});
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

  it('is skipped, and the video plays on past it', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/manifest.mpd`);
    let state;
    try {
      await browser.waitUntil(async () => {
        state = await browser.execute(() => {
          const client = window.fastStream;
          const video = client?.player?.getVideo();
          if (!video) return null;
          if (video.paused && !video.ended) video.play().catch(() => {});
          return {time: video.currentTime, failed: !!client.interfaceController.failed,
            rebuilds: client.recoveries.times.length};
        });
        return !!state && (state.time > BROKEN_END + 0.5 || state.failed);
      }, {timeout: 45000, interval: 250});
    } finally {
      console.log(`      ${JSON.stringify(state)}`);
    }
    expect(state.failed).toBe(false);
    expect(state.time).toBeGreaterThan(BROKEN_END + 0.5);
    // Built again once at the same time, once past the segment.
    expect(state.rebuilds).toBe(2);
  });
});
