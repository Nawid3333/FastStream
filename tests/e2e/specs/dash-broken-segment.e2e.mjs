// A segment that does not decode costs that segment, not the video.
//
// The dash-template and hls-fmp4 fixtures (2 s segments) from a local server, the 4-6 s video
// segment of each with its sample sizes overwritten: Firefox fails to decode it (MEDIA_ERR_DECODE
// on the <video> element), as it does a corrupt segment on a real site. For DASH the player was
// built again three times in 1.5 s at 3.64 s - each time the same segment failed again - and the
// video ended in "Failed to load video!". Now the first decode error builds the player again at
// the same time (right for Firefox's late-append bug 2069633, where the segment is fine), and the
// same place failing again right after builds it past that segment (FastStreamClient.
// recoverPlayer, BrokenMedia.mjs): the video plays on from 6 s.
//
// dash.js's own recovery does not help here: it skips a segment only when the SourceBuffer
// reports the error, and a decode error on the element only resets its MediaSource.
//
// The HLS segment holds both tracks, and on Linux Firefox's FFmpeg audio decoder fails on it
// first (on Windows the video decoder): an audio decode error skips the place too.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

const PORT = 41892;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
// Per fixture, its manifest and the segment from 4 s to 6 s.
const STREAMS = {
  'dash-template': {manifest: 'manifest.mpd', broken: 'chunk-stream0-00003.m4s'},
  'hls-fmp4': {manifest: 'index.m3u8', broken: 'seg-002.m4s'},
};
const BROKEN_END = 6;
const TYPES = {'.mpd': 'application/dash+xml', '.m3u8': 'application/vnd.apple.mpegurl'};

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

describe('A segment that does not decode', function() {
  let server;

  before(async function() {
    server = http.createServer((req, res) => {
      const [, stream, name] = new URL(req.url, ORIGIN).pathname.split('/');
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'};
      const file = STREAMS[stream] && /^[\w.-]+$/.test(name || '') && path.join(FIXTURES, stream, name);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      let data = fs.readFileSync(file);
      if (name === STREAMS[stream].broken) data = breakSamples(data);
      res.writeHead(200, {...headers, 'Content-Type': TYPES[path.extname(name)] || 'video/mp4'});
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

  for (const [stream, {manifest}] of Object.entries(STREAMS)) {
    it(`is skipped, and the video plays on past it (${stream})`, async function() {
      await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/${stream}/${manifest}`);
      let state = {time: 0, failed: false, rebuilds: 0};
      try {
        await browser.waitUntil(async () => {
          state = await browser.execute(() => {
            const client = window.fastStream;
            const video = client?.player?.getVideo();
            // Each error the client builds the player again for, and with what: a failure then
            // says which decoder failed where (on Linux the audio one, for hls-fmp4).
            if (client && !client.recoveryLog) {
              const log = client.recoveryLog = [];
              const recover = client.recoverPlayer.bind(client);
              client.recoverPlayer = (player, reason) => {
                const error = reason?.target?.error;
                const entry = {at: Math.round(performance.now()), time: client.currentTime,
                  reason: error ? `error ${error.code}: ${error.message}` : String(reason?.details || reason).slice(0, 200)};
                entry.rebuilt = recover(player, reason);
                entry.to = new URL(client.source?.url || 'about:blank').searchParams.get('faststream-timestamp');
                log.push(entry);
                return entry.rebuilt;
              };
            }
            if (!video) return {time: 0, failed: false, rebuilds: 0};
            if (video.paused && !video.ended) video.play().catch(() => {});
            return {time: video.currentTime, failed: !!client.interfaceController.failed,
              rebuilds: client.recoveries.times.length, log: client.recoveryLog};
          });
          return state.time > BROKEN_END + 0.5 || state.failed;
        }, {timeout: 45000, interval: 250});
      } finally {
        console.log(`      ${stream}: ${JSON.stringify(state)}`);
      }
      expect(state.failed).toBe(false);
      expect(state.time).toBeGreaterThan(BROKEN_END + 0.5);
      // Built again once at the same time, once past the segment (a slow runner may fail once
      // more before the second error lands at the same place).
      expect(state.rebuilds).toBeGreaterThanOrEqual(2);
      expect(state.rebuilds).toBeLessThanOrEqual(3);
    });
  }
});
