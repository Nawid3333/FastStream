// Autoplay next with the tab in the background (his report, 2026-10-27: MPV autoplay went on
// to the next episode in a tab he was not looking at, and nothing played). The next page's
// player is a hoster's, in a frame of another site, idle until played: FastStream starts it
// (background.mjs startPagePlayers, content.js startPagePlayer), but only in the frame whose
// video it finds on screen (content.js getVideo). A frame made in a hidden tab has a 0x0
// viewport at first, and Firefox's IntersectionObserver says nothing in it is shown until
// the tab is: no frame was asked, and the hoster's player was never started. The player's
// autoplay next goes the same way as mpv's, and is what this drives (no mpv here).
//
// Over WebDriver classic: there, showing another tab hides this one (Firefox's
// visibilityState "hidden"). The BiDi session's newWindow left the first tab "visible"
// (measured 2026-10-27).

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {hasExtensionApi} from '../extension-api.mjs';
import {setOptions} from '../live-specs/liveSite.mjs';
import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41876;
const HOSTER_PORT = 41877;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// Another site: its frame in the episode's page is a process of its own (Fission).
const HOSTER = `http://localhost:${HOSTER_PORT}`;
const style = 'width: 640px; height: 360px; display: block';
// What the hoster served, and when.
const hosterLog = [];
let site;
let hoster;
let siteHandle;
let extHandle;

/**
 * The episode pages.
 * @param {string} file - The video.
 * @return {Object<string, string>} Pages by path.
 */
function pages(file) {
  const next = (to) => `<p><a href="/${to}" style="display: inline-block; width: 120px; height: 24px">Next episode</a></p>`;
  return {
    '/episode-1': `<!doctype html><title>episode 1</title>
<video preload="auto" style="${style}" src="${file}?ep=1"></video>${next('episode-2')}`,
    '/episode-2': `<!doctype html><title>episode 2</title>
<iframe src="${HOSTER}/embed" style="width: 660px; height: 380px; border: 0"></iframe>${next('episode-3')}`,
  };
}

/**
 * A JW Player as a hoster has it, idle until played. It says whether its tab was hidden when
 * it loaded, and when it was played.
 * @param {string} file - The video.
 * @return {string}
 */
function embed(file) {
  return `<!doctype html><title>hoster</title>
<div id="jw" style="width: 100%; height: 100%"><video style="width: 100%; height: 100%"></video></div>
<style>html, body {margin: 0; height: 100%}</style>
<script>
  fetch('/loaded?visibility=' + document.visibilityState).catch(() => {});
  let state = 'idle';
  window.jwplayer = () => ({
    getState: () => state,
    play() {
      if (state !== 'idle') return;
      state = 'buffering';
      fetch('/started?visibility=' + document.visibilityState).catch(() => {});
      const video = document.querySelector('#jw video');
      video.src = '${file}?ep=2';
      video.play().catch(() => {});
    },
  });
</script>`;
}

/**
 * A server on 127.0.0.1 or localhost.
 * @param {number} port
 * @param {string} host
 * @param {(pathname: string) => ?string} page - The page for a path, or null.
 * @param {?Array<Object>} [log] - Where each request goes, with its time.
 * @return {Promise<http.Server>}
 */
function serve(port, host, page, log = null) {
  const server = http.createServer((req, res) => {
    const {pathname, searchParams} = new URL(req.url, `http://${host}:${port}`);
    log?.push({path: pathname, at: Date.now(), visibility: searchParams.get('visibility')});
    const body = page(pathname);
    res.writeHead(body ? 200 : 404, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(body || '');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

/**
 * Waits for FastStream's player in the current frame, and switches into it.
 * @param {string} what - For the failure message.
 */
async function intoPlayer(what) {
  await browser.waitUntil(() => browser.$('iframe[src*="player/index.html"]').isExisting(),
      {timeout: 30000, timeoutMsg: `FastStream never took ${what}`});
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
}

describe('Autoplay next in a tab in the background', function() {
  before(async function() {
    const file = globalThis.__EXT_FIXTURE_MP4__;
    const routes = pages(file);
    site = await serve(SITE_PORT, '127.0.0.1', (pathname) => routes[pathname] || null);
    hoster = await serve(HOSTER_PORT, 'localhost', (pathname) => (pathname === '/embed' ? embed(file) :
      pathname === '/loaded' || pathname === '/started' ? 'ok' : null), hosterLog);
    await setOptions({autoEnableURLs: [SITE], autoplayNext: true});
    // The extension's page in a tab of its own: shown, it puts the site's tab in the background.
    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'), ORIGIN + '/player/index.html');
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).startsWith(ORIGIN) && await hasExtensionApi()) {
          extHandle = handle;
          return true;
        }
      }
      return false;
    }, {timeout: 20000, timeoutMsg: 'the extension page never opened'});
    for (const handle of await browser.getWindowHandles()) {
      if (handle !== extHandle) siteHandle = handle;
    }
  });

  after(async function() {
    await browser.switchToWindow(siteHandle);
    await browser.switchFrame(null);
    await setOptions({});
    await new Promise((resolve) => site.close(resolve));
    await new Promise((resolve) => hoster.close(resolve));
  });

  it('starts the hoster\'s player in a frame of another site, and plays its episode', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/episode-1`);
    await intoPlayer('the first episode');
    await browser.waitUntil(() => browser.execute(() => (window.fastStream?.player?.getVideo?.()?.readyState || 0) >= 2 &&
        window.fastStream.hasNextVideo()), {timeout: 30000, timeoutMsg: 'the player never found the next episode'});
    // Its end comes once the tab is in the background: the player's own timer skips there
    // after the switch, which takes WebDriver two calls (glm's review: a skip made before them
    // could reach the end with the tab still in front on a slow runner).
    await browser.execute(() => {
      const client = window.fastStream;
      client.pause();
      setTimeout(() => {
        client.currentTime = Math.max(0, client.duration - 1.5);
        client.play();
      }, 5000);
    });
    await browser.switchFrame(null);
    const hidden = Date.now();
    await browser.switchToWindow(extHandle);

    await browser.waitUntil(() => hosterLog.some((entry) => entry.path === '/started' && entry.at > hidden),
        {timeout: 40000, interval: 250}).catch(() => {
      throw new Error(`the hoster's player was never started: ${JSON.stringify(hosterLog.filter((entry) => entry.at > hidden))}`);
    });
    // The next page came, and its player was started, while the tab was in the background.
    expect(hosterLog.filter((entry) => entry.at > hidden && entry.path !== '/embed')
        .map(({path, visibility}) => ({path, visibility}))).toEqual([
      {path: '/loaded', visibility: 'hidden'},
      {path: '/started', visibility: 'hidden'},
    ]);

    // FastStream's player took the hoster's stream: the hoster's video fills its frame, so the
    // player took the frame's place (content.js handlePlayerOpen's 'redirect').
    await browser.switchToWindow(siteHandle);
    await browser.waitUntil(async () => (await browser.getUrl()) === `${SITE}/episode-2`,
        {timeout: 10000, timeoutMsg: 'the tab is not on the next episode'});
    await browser.switchFrame(await browser.$(`iframe[src^="${HOSTER}/embed"]`));
    let state;
    await browser.waitUntil(async () => {
      state = await browser.execute(() => {
        const video = window.fastStream?.player?.getVideo?.();
        return video ? {url: window.fastStream.source?.url, paused: video.paused, time: video.currentTime} : null;
      });
      return !!state && state.url?.includes('ep=2') && !state.paused && state.time > 0.5;
    }, {timeout: 30000, interval: 250, timeoutMsg: 'the hoster\'s episode did not play'}).catch((e) => {
      throw new Error(`${e.message}: ${JSON.stringify(state)}`);
    });
  });
});
