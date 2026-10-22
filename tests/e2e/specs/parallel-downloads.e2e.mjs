// A server that limits each connection's speed, as many video hosts do: more connections side
// by side are faster, each at its own rate.
//
// A player short of video (under 10 s ahead) ran two downloads at most (PlayheadFirst), whatever
// the speed test had found, and the speed test could not finish a round with its third
// downloader idle. On a server giving each connection less than the video's rate the player
// never got 10 s ahead: two connections for the whole video, stalling, where six would have
// played it (measured 2026-10-22: 200 kB/s per connection for a 400 kB/s stream, 60 s at two).
// While its speed test runs, a player short of video now runs every downloader, and afterwards
// as many as the test saw add speed (DownloadManager.urgentParallel).
//
// The download line shows those connections: "3C ↓2.4 Mbit/s 1.5%", as upstream did.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41897;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
// Each connection's rate: the fixture's 2 s segments are about 525 kB (about 2.1 Mbit/s), so
// one connection takes about 5 s for one, and two together are slower than the video plays.
const BYTES_PER_SECOND = 100000;

let server;
let open = 0;
let mostOpen = 0;

describe('Downloads from a server that limits each connection', function() {
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
      const data = fs.readFileSync(file);
      res.writeHead(200, {...headers, 'Content-Type': 'video/mp2t', 'Content-Length': data.length});
      open++;
      mostOpen = Math.max(mostOpen, open);
      let sent = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        open--;
        clearInterval(timer);
      };
      const timer = setInterval(() => {
        const end = Math.min(data.length, sent + BYTES_PER_SECOND / 10);
        res.write(data.subarray(sent, end));
        sent = end;
        if (sent >= data.length) {
          finish();
          res.end();
        }
      }, 100);
      res.on('close', finish);
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

  it('runs more than two at once while short of video, and the download line counts them', async function() {
    mostOpen = 0;
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/long.m3u8`);
    await browser.waitUntil(async () => browser.execute(() => {
      const video = document.querySelector('video');
      if (!video || !window.fastStream?.player) return false;
      if (video.paused && video.readyState >= 2) video.play().catch(() => {});
      return true;
    }), {timeout: 30000, interval: 250, timeoutMsg: 'the player never came up'});

    // Two at most before: the first segment comes alone (hls.js asks for no other until it has
    // one), about 5 s, then three side by side - the downloaders the speed test starts with.
    let ahead;
    await browser.waitUntil(async () => {
      ahead = await browser.execute(() => window.fastStream.getVideoAhead());
      return mostOpen >= 3;
    }, {timeout: 25000, interval: 200}).catch(() => {});
    console.log(`      most open at once: ${mostOpen}; seconds ahead then: ${ahead}`);
    expect(mostOpen).toBeGreaterThanOrEqual(3);
    // Still short of video: what PlayheadFirst held to two.
    expect(ahead).toBeLessThan(10);

    // The download line: "<connections>C ↓<speed> Mbit/s <percent>%", its count the downloads
    // running, and it follows the add and remove downloader keys.
    const line = () => browser.execute(() => {
      const client = window.fastStream;
      client.interfaceController.updateDownloadStatus();
      return {
        text: client.interfaceController.statusManager.statusMessages.get('download').message,
        running: client.downloadManager.runningCount(),
        downloaders: client.downloadManager.downloaders.length,
      };
    });
    const count = (text) => Number(/^(\d+)C ↓[\d.]+ Mbit\/s [\d.]+%$/.exec(text)?.[1]);
    const shown = await line();
    expect(shown.text).toMatch(/^\d+C ↓[\d.]+ Mbit\/s [\d.]+%$/);
    expect(count(shown.text)).toBe(shown.running);

    // Each key changes the downloaders by one, and with segments waiting all of them download.
    const downloaders = shown.downloaders;
    let last;
    const showsAll = async (expected) => {
      last = await line();
      return last.downloaders === expected && count(last.text) === expected;
    };
    // Nothing returned: emit() returns the manager, which the driver cannot serialise.
    await browser.execute(() => {
      window.fastStream.keybindManager.emit('AddDownloader');
    });
    await browser.waitUntil(() => showsAll(downloaders + 1),
        {timeout: 5000, interval: 100, timeoutMsg: `not ${downloaders + 1}C after the add-downloader key: ${JSON.stringify(last)}`});
    await browser.execute(() => {
      window.fastStream.keybindManager.emit('RemoveDownloader');
      window.fastStream.keybindManager.emit('RemoveDownloader');
    });
    await browser.waitUntil(() => showsAll(downloaders - 1),
        {timeout: 5000, interval: 100, timeoutMsg: `not ${downloaders - 1}C after the remove-downloader key: ${JSON.stringify(last)}`});
  });
});
