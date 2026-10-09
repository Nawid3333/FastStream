// After a seek, FastStream downloads from the new time, not from where the video was.
//
// The client downloads ahead from the player's current fragment (getNextToDownload). For HLS
// that was hls.js's currentFrag, the fragment that plays, and after a seek it stays the old
// one until the first fragment at the new time has loaded and plays. Meanwhile every
// downloader that came free took the next fragment at the old place: measured on a 10-minute
// stream, three segments there were fetched after a seek to 5:00 before the one it needed,
// and with other FastStream tabs loading (Firefox's six connections to a host shared by all
// of them) the seek took 21 s to play instead of 4-9 s.
//
// Here every segment takes a while to arrive, as on a slow line, so the old place has time to
// show up in the server's log if anything asks for it.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41893;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
// Each segment's answer waits this long, about what a 2 s segment takes on a line that is only
// a little faster than the stream.
const SEGMENT_DELAY_MS = 700;
// The playlist repeats the fixture's 9 s: 5 segments, 2 s each but the last (1 s).
const SEEK_TO = 300;
const SEEK_PLACE = Math.floor(SEEK_TO / 9) * 5 + Math.min(Math.floor((SEEK_TO % 9) / 2), 4);

let server;
let requests = [];

describe('Downloads after a seek', function() {
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
      setTimeout(() => {
        res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t'});
        res.end(fs.readFileSync(file));
      }, SEGMENT_DELAY_MS);
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

  it('starts at the new time, not where the video was', async function() {
    requests = [];
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/long.m3u8`);
    // Playing, so hls.js has a current fragment at the start.
    await browser.waitUntil(async () => browser.execute(() => {
      const v = document.querySelector('video');
      if (!v || !window.fastStream?.player) return false;
      if (v.paused) v.play().catch(() => {});
      return v.currentTime > 1;
    }), {timeout: 60000, interval: 250, timeoutMsg: 'the stream never played'});

    await browser.execute((to) => {
      window.fastStream.currentTime = to;
    }, SEEK_TO);
    const seekAt = Date.now();

    await browser.waitUntil(async () => browser.execute((to) => {
      const v = document.querySelector('video');
      if (v.paused) v.play().catch(() => {});
      return v.currentTime > to + 0.5;
    }, SEEK_TO), {timeout: 30000, interval: 250, timeoutMsg: 'it never played after the seek'});

    // What was asked for after the seek. A request already on its way at the seek can arrive
    // a moment after it: those within 100 ms are left out. So can the first two the seek
    // asked for (on the Linux runner, PR #366): it downloads on, and three are waited for.
    const askedAfter = () => requests.filter((request) => request.at > seekAt + 100).map((request) => request.place);
    await browser.waitUntil(async () => askedAfter().length > 2,
        {timeout: 20000, interval: 250, timeoutMsg: `too few requests after the seek: ${JSON.stringify(askedAfter())}`});
    const after = askedAfter();
    console.log(`      seek to place ${SEEK_PLACE}; asked for after it: ${JSON.stringify(after.slice(0, 12))}`);
    const oldPlace = after.filter((place) => place < SEEK_PLACE - 1);
    expect(after.length).toBeGreaterThan(2);
    expect(oldPlace).toEqual([]);
    // And what the seek needs was asked for.
    expect(requests.some((request) => request.at >= seekAt - 100 && request.place === SEEK_PLACE)).toBe(true);
  });
});
