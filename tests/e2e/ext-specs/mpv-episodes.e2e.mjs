// MPV autoplay across the whole chain: extension, helper, the mpv the helper starts (with its
// own config), and the page's next episode.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {closeSpecMpv, hostInstalled, ipcServerOf, mpvProcesses, mpvRequest, specMpvPids} from '../mpvTestProcesses.mjs';
import {setOptions} from '../live-specs/liveSite.mjs';

const root = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '../../..');

const SITE = 'http://127.0.0.1:41940';
const CDN = 'http://127.0.0.1:41941';
const HAVE_HOST = hostInstalled();

const isMpvRequest = (r) => 'icy-metadata' in r.headers;

describe('MPV autoplay, end to end', function() {
  const requests = [];
  const servers = [];
  let ipc = null;

  const mpvAsked = (file) => requests.some((r) => isMpvRequest(r) && r.url.startsWith(file));
  const waitForMpv = (file, timeout = 30000) => browser.waitUntil(async () => mpvAsked(file), {
    timeout, interval: 500,
    timeoutMsg: `mpv never asked for ${file}; mpv asked for: ` +
      JSON.stringify(requests.filter(isMpvRequest).map((r) => r.url)),
  });
  const mpvProperty = async (name) => (await mpvRequest(ipc, ['get_property', name]))?.data;
  const specWindows = async () => {
    const pids = await specMpvPids([CDN]);
    return mpvProcesses().filter((p) => pids.includes(p.pid));
  };

  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/episode.mp4'));
    const page = (n) => `<!doctype html><title>Series, episode ${n}</title>
      <video id="v" muted autoplay preload="auto" src="${CDN}/ep${n}.mp4"></video>
      ${n < 3 ? `<a href="/series/episode-${n + 1}">Next episode</a>` : ''}`;
    const site = http.createServer((req, res) => {
      const match = /^\/series\/episode-([1-3])$/.exec(req.url);
      res.writeHead(match ? 200 : 404, {'Content-Type': 'text/html'});
      res.end(match ? page(Number(match[1])) : 'no');
    });
    const cdn = http.createServer((req, res) => {
      requests.push({url: req.url, headers: req.headers});
      if (!/^\/ep[1-3]\.mp4$/.test(req.url)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': String(clip.length),
        'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*'});
      res.end(req.method === 'HEAD' ? undefined : clip);
    });
    for (const [server, origin] of [[site, SITE], [cdn, CDN]]) {
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(Number(new URL(origin).port), '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    if (HAVE_HOST) {
      await setOptions({mpvMode: true, mpvAllowlist: [SITE], mpvAutoplayNext: true, autoplayCountdown: 1});
    }
  });

  after(async function() {
    for (const server of servers) await new Promise((r) => server.close(r));
    await closeSpecMpv([SITE, CDN]);
  });

  (HAVE_HOST ? it : it.skip)('the next-episode key brings the next episode into the same mpv', async function() {
    await browser.url(`${SITE}/series/episode-1`);
    await waitForMpv('/ep1.mp4');

    let pid = null;
    await browser.waitUntil(async () => {
      const [window] = await specWindows();
      pid = window?.pid ?? null;
      ipc = window ? ipcServerOf(window.commandLine) : null;
      return !!ipc && await mpvProperty('user-data/faststream/connected') === true;
    }, {timeout: 20000, interval: 500, timeoutMsg: 'FastStream never followed the mpv window'});

    expect((await mpvRequest(ipc, ['script-message', 'faststream-next']))?.error).toBe('success');
    await waitForMpv('/ep2.mp4');
    await browser.waitUntil(async () => (await browser.getUrl()).endsWith('/series/episode-2'),
        {timeout: 15000, timeoutMsg: 'the tab did not go on to episode 2'});
    await browser.waitUntil(async () => String(await mpvProperty('path')).includes('/ep2.mp4'),
        {timeout: 15000, timeoutMsg: 'episode 2 never loaded in mpv'});
    expect((await specWindows()).map((p) => p.pid)).toEqual([pid]);
  });

  (HAVE_HOST ? it : it.skip)('an episode that plays to its end brings the next one', async function() {
    expect(ipc).toBeTruthy();
    let duration = null;
    await browser.waitUntil(async () => {
      duration = await mpvProperty('duration');
      return typeof duration === 'number';
    }, {timeout: 15000, timeoutMsg: 'episode 2 has no duration in mpv'});
    expect((await mpvRequest(ipc, ['seek', duration - 2, 'absolute']))?.error).toBe('success');
    await mpvRequest(ipc, ['set_property', 'pause', false]);
    await waitForMpv('/ep3.mp4');
    await browser.waitUntil(async () => (await browser.getUrl()).endsWith('/series/episode-3'),
        {timeout: 15000, timeoutMsg: 'the tab did not go on to episode 3'});
  });
});
