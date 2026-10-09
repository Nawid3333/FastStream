// Pointing at the timeline loads that part: the seek preview downloads the segment under the
// pointer into the store the player plays from, and a click there plays at once (measured on
// a 12 Mbit/s line: 0.56 s instead of 3.45 s).
//
// The preview dropped what it was loading for the old place by aborting its loaders behind
// hls.js's back, and hls.js resets after an abort only once its first segment has loaded
// (handleFragLoadAborted needs its transmuxer). Pointing at the timeline before that - the
// preview loads its first segment as the video starts, on a slow line for seconds - left the
// preview waiting for that first segment to finish before it followed the pointer: 4.8 s here,
// more than 10 s on a 12 Mbit/s line shared with the player, and pointing loaded nothing
// meanwhile. It hits a video that opens where it was left (the saved position): the player
// starts there, and the preview loads the first segment alone.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41896;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
// Each segment arrives over this long, a slice every 100 ms, as on a slow line: the preview's
// first one is half there when the pointer moves.
const SEGMENT_MS = 4000;
// The segment under the pointer is asked for within this after the pointer got there (4 ms
// measured), not once the preview's first segment has arrived (4.8 s before).
const ASKED_WITHIN_MS = 1500;
const HOVER_AT = 200;
// The playlist repeats the fixture's 9 s: 5 segments, 2 s each but the last (1 s).
const HOVER_PLACE = Math.floor(HOVER_AT / 9) * 5 + Math.min(Math.floor((HOVER_AT % 9) / 2), 4);

let server;
let requests = [];

describe('The seek preview', function() {
  before(async function() {
    const playlist = loopedPlaylist(600, '/seg/', {unique: true});
    server = http.createServer((req, res) => {
      const url = new URL(req.url, ORIGIN);
      const headers = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'};
      if (url.pathname === '/long.m3u8') {
        res.writeHead(200, {...headers, 'Content-Type': 'application/vnd.apple.mpegurl'});
        res.end(playlist);
        return;
      }
      const name = url.pathname.startsWith('/seg/') && path.basename(url.pathname);
      const file = name && /^seg-\d+\.ts$/.test(name) && path.join(SEGMENTS, name);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      requests.push({place: Number(url.searchParams.get('i')), at: Date.now()});
      const data = fs.readFileSync(file);
      res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t', 'Content-Length': data.length});
      const slices = SEGMENT_MS / 100;
      let sent = 0;
      const timer = setInterval(() => {
        const end = Math.min(data.length, sent + Math.ceil(data.length / slices));
        res.write(data.subarray(sent, end));
        sent = end;
        if (sent >= data.length) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.on('close', () => clearInterval(timer));
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

  it('loads the part the pointer is on, also before its first segment has loaded', async function() {
    requests = [];
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/long.m3u8`);
    // The preview is there and loading its first segment, which has not arrived yet.
    await browser.waitUntil(async () => browser.execute(() => {
      const preview = window.fastStream?.previewPlayer;
      return !!preview && preview.activeRequests.length > 0 && preview.getVideo().buffered.length === 0;
    }), {timeout: 30000, interval: 50, timeoutMsg: 'the preview never started loading'});
    // The player goes on where the video was left, and stops waiting for the first segment.
    await browser.execute(() => {
      window.fastStream.currentTime = 100;
    });
    await browser.pause(300);

    await browser.execute((time) => {
      window.fastStream.seekPreview(time);
    }, HOVER_AT);
    const pointedAt = Date.now();
    await browser.waitUntil(async () => requests.some((request) => request.place === HOVER_PLACE),
        {timeout: 20000, interval: 50, timeoutMsg: 'the segment under the pointer was never asked for'});
    const askedAfter = requests.find((request) => request.place === HOVER_PLACE).at - pointedAt;

    let state;
    try {
      await browser.waitUntil(async () => {
        state = await browser.execute((time) => {
          const client = window.fastStream;
          const fragment = client.fragments.find((f) => f && f.start <= time && f.end > time);
          const video = client.previewPlayer.getVideo();
          return {status: fragment?.status, previewReady: video.readyState};
        }, HOVER_AT);
        // Downloaded into the player's store (DownloadStatus.DOWNLOAD_COMPLETE), and shown.
        return state.status === 3 && state.previewReady >= 2;
      }, {timeout: 20000, interval: 250});
    } finally {
      console.log(`      pointer at place ${HOVER_PLACE}, asked for ${askedAfter} ms later: ${JSON.stringify(state)}; ` +
        `asked for: ${JSON.stringify(requests.slice(0, 12).map((request) => request.place))}`);
    }
    expect(askedAfter).toBeLessThan(ASKED_WITHIN_MS);
  });
});
