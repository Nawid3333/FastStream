// Every way back to a video keeps what its player buffered (BufferStash) within the keep time picked: a reload, Back,
// the tab closed and opened again, Firefox unloading the tab. And a hoster that issues its links anew in other ways
// than a query signature: a token in the path, another host, a frame address of its own.
//
// The pages are built as a series site's are: an episode page framing the hoster's page, whose script loads an HLS
// stream (FastStream's player takes the place of its <video>).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';

const PORT = 41907;
const SITE = `http://127.0.0.1:${PORT}`;
// The same server under another host name: a hoster's next CDN node.
const OTHER_HOST = `http://localhost:${PORT}`;
const SEGMENTS = path.resolve(import.meta.dirname, '../fixtures/hls-ts');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
};

let server;
let loads = 0;
/** @type {Array<{load: string, place: string}>} */
let segments = [];

/**
 * How each load of the hoster's page names its stream and itself.
 * query: a new ?sig= at each load (as before). path: a new token in the path. host: every other load from another host.
 * frame: the hoster's page itself under a new ?t= at each load. other: as path, but every other load is another
 * video (each segment one TS null packet longer): the kept buffer must not play.
 * @param {string} name - The case's, `<mode>-<way>`: no case finds another's buffer.
 * @param {number} load
 * @return {{embed: string, master: string}}
 */
function linksFor(name, load) {
  const mode = name.split('-')[0];
  const embed = mode === 'frame' ? `${SITE}/embed/${name}?t=${load}` : `${SITE}/embed/${name}`;
  if (mode === 'path' || mode === 'other') return {embed, master: `${SITE}/v/t${load}/master.m3u8`};
  const origin = mode === 'host' && load % 2 === 0 ? OTHER_HOST : SITE;
  return {embed, master: `${origin}/v/master.m3u8?sig=l${load}&e=43200`};
}

/** @type {Map<number, boolean>} The loads that are another video. */
const otherVideo = new Map();
// A transport stream packet that carries nothing: the same video plays, other bytes.
const NULL_PACKET = Buffer.concat([Buffer.from([0x47, 0x1f, 0xff, 0x10]), Buffer.alloc(184, 0xff)]);

/** @type {Map<string, number>} The load each episode page last got. */
const lastLoad = new Map();

/**
 * Into the player's frame: the episode page, the hoster's frame, the player's.
 * @return {Promise<boolean>}
 */
async function intoPlayer() {
  await browser.switchFrame(null);
  const embed = await browser.$('iframe[src*="/embed/"]');
  if (!(await embed.isExisting())) return false;
  await browser.switchFrame(embed);
  const player = await browser.$('iframe[src*="player/index.html"]');
  if (!(await player.isExisting())) {
    await browser.switchFrame(null);
    return false;
  }
  await browser.switchFrame(player);
  return true;
}

/** @return {Promise<Object>} */
async function playerState() {
  if (!await intoPlayer()) return {player: false};
  const state = await browser.execute(() => {
    const client = window.fastStream;
    const video = client?.player?.getVideo?.();
    return {player: true, url: client?.source?.url || '', readyState: video?.readyState || 0,
      failed: !!client?.interfaceController?.failed, tookBack: client?.bufferTakenBack || null,
      downloaded: [...(client?.fragments || [])].filter((f) => f?.status === 3)
          .map((f) => new URL(f.getContext().url).searchParams.get('i')).filter((i) => i !== null)};
  });
  await browser.switchFrame(null);
  return state;
}

/**
 * The tag of a load in a segment's URL: its sig, else its path token.
 * @param {URL} url
 * @return {string}
 */
function loadTag(url) {
  return url.searchParams.get('sig') || (url.pathname.match(/^\/v\/(t\d+)\//) || [])[1] || '';
}

const placesFor = (tag) => new Set(segments.filter((s) => s.load === tag).map((s) => s.place));

/**
 * @param {string} mode
 * @param {number} load
 * @return {string}
 */
function tagOf(mode, load) {
  return mode === 'path' || mode === 'other' ? `t${load}` : `l${load}`;
}

/**
 * Waits until the player plays this load's stream and has downloaded `ahead` segments of it.
 * @param {string} name - The case's.
 * @param {number} ahead
 * @return {Promise<{load: number, downloaded: Set<string>}>}
 */
async function playing(name, ahead) {
  const mode = name.split('-')[0];
  let state = null;
  await browser.waitUntil(async () => {
    state = await playerState();
    const load = lastLoad.get(name);
    return state.player && state.readyState >= 2 && !!load && state.url.includes(tagOf(mode, load));
  }, {timeout: 30000, interval: 300, timeoutMsg: `the player never played (${mode}): ${JSON.stringify(state)}`});
  const load = /** @type {number} */ (lastLoad.get(name));
  await browser.waitUntil(async () => placesFor(tagOf(mode, load)).size >= ahead,
      {timeout: 30000, timeoutMsg: `fewer than ${ahead} segments were downloaded (${mode})`});
  return {load, downloaded: new Set((await playerState()).downloaded)};
}

/**
 * Runs a script in Firefox's privileged scope.
 * @param {string} body
 * @param {...*} args
 * @return {Promise<*>}
 */
async function inChrome(body, ...args) {
  await browser.setMozContext('chrome');
  try {
    return await browser.executeScript(body, args);
  } finally {
    await browser.setMozContext('content');
  }
}

/**
 * Switches to the window whose page starts with `prefix`.
 * @param {string} prefix
 * @return {Promise<void>}
 */
async function toWindowAt(prefix) {
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if ((await browser.getUrl()).startsWith(prefix)) return true;
    }
    return false;
  }, {timeout: 15000, interval: 500, timeoutMsg: `no window at ${prefix}`});
}

const WAYS = {
  async reload() {
    await browser.switchFrame(null);
    await browser.execute(() => location.reload());
  },
  async back() {
    await browser.url(`${SITE}/elsewhere`);
    await browser.pause(500);
    await browser.back();
  },
  async reopen(page) {
    const watching = await browser.getWindowHandle();
    await browser.newWindow('about:blank');
    const other = /** @type {string} */ ((await browser.getWindowHandles()).find((handle) => handle !== watching));
    await browser.switchToWindow(watching);
    await browser.closeWindow();
    await browser.switchToWindow(other);
    await browser.pause(1000);
    await browser.url(page);
  },
  async unloaded(page) {
    await browser.newWindow('about:blank');
    await browser.pause(500);
    // WebDriver's new window is a window of its own: the tab is looked for in every one.
    const find = `let found = null;
      for (const win of Services.wm.getEnumerator('navigator:browser')) {
        const tab = win.gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === arguments[0]);
        if (tab) found = {win, tab};
      }`;
    const gone = await inChrome(`${find}
      if (!found) return 'no tab';
      if (found.win.gBrowser.selectedTab === found.tab) {
        found.win.gBrowser.selectedTab = found.win.gBrowser.addTab('about:blank',
          {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      }
      found.win.gBrowser.discardBrowser(found.tab, true);
      return found.tab.linkedPanel ? 'still loaded' : 'unloaded';`, page);
    console.log(`      the tab: ${gone}`);
    await browser.pause(1000);
    await inChrome(`${find}
      if (found) found.win.gBrowser.selectedTab = found.tab;`, page);
    await toWindowAt(page);
  },
};

/**
 * The options, saved as the options page does and loaded by the background.
 * @param {Object} options
 * @return {Promise<void>}
 */
async function setOptions(options) {
  await inExtensionPage((options, done) => {
    chrome.storage.local.set({options: JSON.stringify(options)}, () => {
      chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
        void chrome.runtime.lastError;
        setTimeout(() => done(true), 500);
      });
    });
  }, options);
}

/**
 * Buffers an episode, goes away and back the given way, and says what the new player took back.
 * @param {string} mode
 * @param {keyof WAYS} way
 * @return {Promise<{tookBack: *, buffered: number, again: number, failed: boolean}>}
 */
async function wayBack(mode, way) {
  const name = `${mode}-${way}`;
  const page = `${SITE}/ep/${name}`;
  await browser.url(page);
  const first = await playing(name, 8);
  await WAYS[way](page);
  const second = await playing(name, 1).catch((e) => ({load: -1, downloaded: new Set(), error: String(e)}));
  let tookBack = null;
  await browser.waitUntil(async () => {
    tookBack = (await playerState()).tookBack;
    return !!tookBack && tookBack.taken === tookBack.of;
  }, {timeout: 10000, interval: 300}).catch(() => {});
  await browser.pause(2000);
  const again = [...placesFor(tagOf(mode, second.load))].filter((place) => first.downloaded.has(place));
  const result = {tookBack, buffered: first.downloaded.size, again: again.length, failed: (await playerState()).failed};
  console.log(`      ${mode} / ${way}: ${JSON.stringify(result)}`);
  return result;
}

describe('Every way back to a video', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      const episode = url.pathname.match(/^\/ep\/(\w+-\w+)$/);
      if (episode) {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        // The hoster's frame address the next load will have (frame mode: a new ?t=).
        const {embed} = linksFor(episode[1], loads + 1);
        return res.end(`<!doctype html><title>episode</title><h1>episode</h1>
          <iframe src="${embed}" width="720" height="420" allow="autoplay; fullscreen"></iframe>`);
      }
      const embed = url.pathname.match(/^\/embed\/(\w+-\w+)$/);
      if (embed) {
        loads++;
        lastLoad.set(embed[1], loads);
        otherVideo.set(loads, embed[1].startsWith('other-') && loads % 2 === 0);
        const {master} = linksFor(embed[1], loads);
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return res.end(`<!doctype html><title>hoster</title>
          <video muted style="width: 640px; height: 360px"></video>
          <script>fetch(${JSON.stringify(master)});</script>`);
      }
      if (url.pathname === '/elsewhere') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end('<!doctype html><title>elsewhere</title><p>elsewhere');
      }
      const master = url.pathname.match(/^\/v\/(?:(t\d+)\/)?master\.m3u8$/);
      if (master) {
        const segmentPath = master[1] ? `/v/${master[1]}/seg/` : '/v/seg/';
        const sig = url.searchParams.get('sig');
        let playlist = loopedPlaylist(180, segmentPath, {unique: true});
        if (sig) playlist = playlist.replace(/\.ts\?i=/g, `.ts?sig=${sig}&i=`);
        res.writeHead(200, {...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store'});
        return res.end(playlist);
      }
      if (/^\/v\/(t\d+\/)?seg\//.test(url.pathname)) {
        segments.push({load: loadTag(url), place: url.searchParams.get('i') || ''});
        res.writeHead(200, {...CORS, 'Content-Type': 'video/mp2t'});
        const data = fs.readFileSync(path.join(SEGMENTS, path.basename(url.pathname)));
        const load = Number((loadTag(url).match(/\d+/) || ['0'])[0]);
        return res.end(otherVideo.get(load) ? Buffer.concat([data, NULL_PACKET]) : data);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
    await setOptions({autoEnableURLs: [SITE + '/', OTHER_HOST + '/'], bufferKeep: 300});
  });

  after(async function() {
    await browser.switchFrame(null);
    await setOptions({});
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const CASES = (process.env.KEEP_CASES ||
    'query-reload,query-back,query-reopen,query-unloaded,path-reload,host-reload,frame-reload,other-reload')
      .split(',').map((c) => c.split('-'));
  for (const [mode, way] of CASES.filter(([mode]) => mode !== 'other')) {
    it(`${mode} links, ${way}: the new player takes back what was buffered`, async function() {
      segments = [];
      const result = await wayBack(mode, /** @type {keyof WAYS} */ (way));
      if (process.env.KEEP_MEASURE) return;
      expect(result.buffered).toBeGreaterThan(0);
      expect(result.tookBack?.of).toBeGreaterThan(0);
      expect(result.tookBack.checked).toBe(true);
      // Under another host or path the kept data is used once a part downloaded anew is the same: those few
      // (the ones asked for at once) come again.
      expect(result.again).toBeLessThanOrEqual(mode === 'path' || mode === 'host' ? 8 : 0);
      expect(result.failed).toBe(false);
    });
  }
  if (CASES.some(([mode]) => mode === 'other')) {
    it('another video on the same page under a new link: the kept buffer is not played', async function() {
      segments = [];
      const result = await wayBack('other', 'reload');
      if (process.env.KEEP_MEASURE) return;
      expect(result.buffered).toBeGreaterThan(0);
      expect(result.tookBack?.checked).toBe(false);
      expect(result.failed).toBe(false);
    });
  }
});
