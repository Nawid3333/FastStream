// What a site lays over its own video stays off FastStream's player (overlay-guard.js):
// its control bar and play button, in the frame of the video, and the bar of a page that
// embeds its player in a full-page iframe from another site, as streaming sites do. Page
// parts that only border the player stay, and everything comes back when the player goes.
//
// Every case also checks that content.js and overlay-guard.js threw nothing.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {inChrome, clickToolbar as clickToolbarIn} from '../classic-helpers.mjs';
import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41979;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// The embedded player's site: another origin, as an embed is.
const EMBED_PORT = 41982;
const EMBED = `http://127.0.0.1:${EMBED_PORT}`;

let servers = [];
let extHandle;
let siteHandle;

// The site's own player: the video fills #media, and the bar and the play button lie on
// it from outside #media, so FastStream replaces #media and they stay over the player. A
// page header above it, and a fixed bar that only touches its top edge, are the page's.
const barPage = (t) => `<!doctype html><title>bar</title>
<style>
  body { margin: 0; }
  #header { height: 60px; }
  #player { position: relative; width: 640px; height: 400px; }
  #media, #media video { width: 640px; height: 360px; display: block; }
  #controls { position: absolute; left: 0; top: 320px; width: 640px; height: 40px; z-index: 5; background: #222; }
  #play { position: absolute; left: 270px; top: 130px; width: 100px; height: 100px; z-index: 5; background: #c00; }
  #topbar { position: fixed; left: 0; top: 0; width: 100%; height: 70px; z-index: 10; background: #444; }
</style>
<div id="header"></div>
<div id="player">
  <div id="media"><video id="main" muted preload="auto" src="/clip.mp4?bar=${t}"></video></div>
  <div id="controls"></div>
  <div id="play"></div>
</div>
<div id="topbar"></div>
<script>
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// The same player as a web component: the video, its bar and its play button are in the
// custom element's shadow root, so FastStream's player goes in there too. The page's own
// header and top bar are outside it.
const shadowPage = (t) => `<!doctype html><title>shadow</title>
<style>
  body { margin: 0; }
  #header { height: 60px; }
  #topbar { position: fixed; left: 0; top: 0; width: 100%; height: 70px; z-index: 10; background: #444; }
</style>
<div id="header"></div>
<test-player id="host"></test-player>
<div id="topbar"></div>
<script>
  customElements.define('test-player', class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({mode: 'open'});
      window.shadowPart = (id) => root.getElementById(id);
      root.innerHTML = \`<style>
        :host { display: block; position: relative; width: 640px; height: 400px; }
        #media, #media video { width: 640px; height: 360px; display: block; }
        #controls { position: absolute; left: 0; top: 320px; width: 640px; height: 40px; z-index: 5; background: #222; }
        #play { position: absolute; left: 270px; top: 130px; width: 100px; height: 100px; z-index: 5; background: #c00; }
      </style>
      <div id="media"><video id="main" muted preload="auto" src="/clip.mp4?shadow=${t}"></video></div>
      <div id="controls"></div>
      <div id="play"></div>\`;
    }
  });
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// A layout wrapper that holds the page's nav, a side column and an ad over the player,
// but not the player: it covers the player's box, and it is painted under it. Only the ad
// is the player's; hiding the wrapper would take the nav and the column with it. The
// player's box is placed by a class, which the player takes over with the box.
const stagePage = (t) => `<!doctype html><title>stage</title>
<style>
  body { margin: 0; }
  #ui { width: 1000px; height: 700px; }
  #nav { height: 60px; background: #333; }
  #aside { position: absolute; left: 660px; top: 80px; width: 300px; height: 360px; background: #666; }
  #promo { position: absolute; left: 220px; top: 200px; width: 200px; height: 100px; z-index: 5; background: #c00; }
  .stage { position: absolute; left: 0; top: 80px; width: 640px; height: 360px; }
  .stage video { width: 640px; height: 360px; display: block; }
</style>
<div id="ui">
  <div id="nav"></div>
  <div id="aside"></div>
  <div id="promo"></div>
</div>
<div class="stage"><video id="main" muted preload="auto" src="/clip.mp4?stage=${t}"></video></div>
<script>
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// A see-through veil over the whole page, with a clickable ad in it over the player. The
// veil lets clicks through (pointer-events: none), so the browser's hit test never finds
// it; it covers the player, so it goes with the ad. The page's nav, under it, stays.
const veilPage = (t) => `<!doctype html><title>veil</title>
<style>
  body { margin: 0; }
  #nav { height: 60px; background: #333; }
  .stage, .stage video { width: 640px; height: 360px; display: block; }
  #veil { position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 50; background: rgba(0, 0, 0, 0.5); pointer-events: none; }
  #promo { position: absolute; left: 220px; top: 200px; width: 200px; height: 100px; background: #c00; pointer-events: auto; }
</style>
<div id="nav"></div>
<div class="stage"><video id="main" muted preload="auto" src="/clip.mp4?veil=${t}"></video></div>
<div id="veil"><div id="promo"></div></div>
<script>
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// A site's own dialog, opened while the player is up: a backdrop over the whole page with
// the dialog in it, the geometry of an ad layer. It stays (#226). The ad that opens with
// it, over the player and above the dialog's layer, goes: that shows the guard looked
// again after the dialog opened.
const dialogPage = (t) => `<!doctype html><title>dialog</title>
<style>
  body { margin: 0; }
  .stage, .stage video { width: 640px; height: 360px; display: block; }
  #promo { position: absolute; left: 220px; top: 200px; width: 200px; height: 100px; z-index: 5; background: #c00; }
  #modal { position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 100; display: none; }
  #backdrop { position: absolute; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); }
  #dialog { position: absolute; left: 200px; top: 100px; width: 400px; height: 200px; background: #fff; }
  #lateAd { position: absolute; left: 20px; top: 20px; width: 120px; height: 60px; z-index: 200; background: #c00; display: none; }
</style>
<div class="stage"><video id="main" muted preload="auto" src="/clip.mp4?dialog=${t}"></video></div>
<div id="promo"></div>
<div id="modal"><div id="backdrop"></div><div id="dialog" role="dialog" aria-modal="true"><input id="email"></div></div>
<div id="lateAd"></div>
<script>
  window.openDialog = () => {
    document.getElementById('modal').style.display = 'block';
    document.getElementById('lateAd').style.display = 'block';
  };
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// The embedding page: the player's iframe fills it, and its bar lies on top.
const embeddingPage = (t) => `<!doctype html><title>embedding</title>
<style>
  body { margin: 0; }
  .player { position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 1000; }
  .player iframe { position: absolute; width: 100%; height: 100%; border: 0; }
  #bar { position: fixed; left: 35px; top: 30px; width: 600px; height: 52px; z-index: 1001; background: #444; }
</style>
<div class="player"><iframe src="${EMBED}/embed?t=${t}" allow="autoplay; fullscreen"></iframe></div>
<div id="bar"></div>
<script>
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// The embed: its video fills it.
const embedPage = (t) => `<!doctype html><title>embed</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  video { width: 100vw; height: 100vh; display: block; }
</style>
<video id="main" muted preload="auto" src="/clip.mp4?embed=${t}"></video>`;

/** Starts collecting the errors the content scripts report, once per browser. */
async function watchContentErrors() {
  await inChrome((done) => {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    if (!win.__fsOverlayErrors) {
      win.__fsOverlayErrors = [];
      Services.console.registerListener({
        observe(message) {
          try {
            if (message instanceof Ci.nsIScriptError &&
                /^moz-extension:\/\/[^/]+\/(content|overlay-guard)\.js/.test(message.sourceName || '') &&
                !(message.flags & Ci.nsIScriptError.warningFlag) &&
                // Firefox's note that a message's answer came after its page had gone.
                !(message.errorMessage || '').startsWith('Promise resolved while context is inactive')) {
              win.__fsOverlayErrors.push(`${message.errorMessage} (${message.sourceName.split('/').pop()}:${message.lineNumber})`);
            }
          } catch (e) {
            // Not a script error.
          }
        },
      });
    }
    done(true);
  });
}

/** @return {Promise<Array<string>>} The errors reported since the last call. */
async function takeContentErrors() {
  return await inChrome((done) => {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    done(win.__fsOverlayErrors.splice(0));
  });
}

/** Clicks the extension's toolbar button for the site tab. */
const clickToolbar = () => clickToolbarIn(siteHandle);

/** @return {Promise<string>} The site tab's mode, 'on' or 'off'. */
async function tabMode() {
  await browser.switchToWindow(extHandle);
  const mode = await browser.executeAsync((site, done) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(site + '/'));
      if (!tab) return done('none');
      chrome.action.getBadgeText({tabId: tab.id}, (badge) => done(badge === 'On' ? 'on' : 'off'));
    });
  }, SITE);
  await browser.switchToWindow(siteHandle);
  return mode;
}

/**
 * Runs a function in the site page's top frame.
 * @param {Function} fn - The function.
 * @param {...*} args - Serialisable arguments.
 * @return {Promise<*>} What it returned.
 */
async function inPage(fn, ...args) {
  await browser.switchToWindow(siteHandle);
  await browser.switchFrame(null);
  return await browser.execute(fn, ...args);
}

/**
 * The visibility of each element, by id, in the page's top frame.
 * @param {Array<string>} ids - Element ids.
 * @return {Promise<Object<string, string>>}
 */
async function visibilities(ids) {
  return inPage((ids) => Object.fromEntries(ids.map((id) => [id, getComputedStyle(document.getElementById(id)).visibility])), ids);
}

/**
 * Loads a page of the site, and waits until the video the player takes has data.
 * @param {string} pathname - The page.
 * @param {boolean} [embedded] - Whether the video is in the page's iframe.
 */
async function openPage(pathname, embedded = false) {
  await browser.switchToWindow(siteHandle);
  await browser.url(`${SITE}${pathname}?t=${Date.now()}`);
  if (embedded) {
    await browser.waitUntil(async () => {
      await browser.switchFrame(null);
      const frame = await browser.$('.player iframe');
      if (!(await frame.isExisting())) return false;
      await browser.switchFrame(frame);
      const ready = await browser.execute(() => document.querySelector('video')?.readyState >= 2);
      await browser.switchFrame(null);
      return ready;
    }, {timeout: 20000, timeoutMsg: `the video of ${pathname} never loaded`});
  } else {
    await browser.waitUntil(async () => inPage(() => document.querySelector('video')?.readyState >= 2),
        {timeout: 20000, timeoutMsg: `the video of ${pathname} never loaded`});
  }
  // The detection is an async webRequest event on top of the load.
  await browser.pause(500);
}

describe('A site\'s overlays around an in-page player', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));
    const serve = (port, pages) => new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const pathname = req.url.split('?')[0];
        if (pathname === '/clip.mp4') {
          res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': String(clip.length), 'Access-Control-Allow-Origin': '*'});
          res.end(clip);
          return;
        }
        const page = Object.entries(pages).find(([prefix]) => pathname.startsWith(prefix));
        res.writeHead(200, {'Content-Type': 'text/html'});
        // Anything else (the favicon) gets an empty page; echoing the request's path would
        // be reflected XSS to CodeQL.
        res.end(page ? page[1](Date.now()) : '<!doctype html><title>no page</title>');
      });
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
    servers = [
      await serve(SITE_PORT, {'/bar': barPage, '/shadow': shadowPage, '/stage': stagePage, '/veil': veilPage, '/dialog': dialogPage, '/embedding': embeddingPage}),
      await serve(EMBED_PORT, {'/embed': embedPage}),
    ];

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
      if (handle === extHandle) continue;
      await browser.switchToWindow(handle);
      if ((await browser.getUrl()).startsWith(OPENER_URL)) {
        siteHandle = handle;
      }
    }
    await watchContentErrors();
  });

  afterEach(async function() {
    // The next case starts with FastStream off.
    if (siteHandle && (await tabMode()) === 'on') {
      await clickToolbar();
    }
    await takeContentErrors();
  });

  after(async function() {
    await Promise.all(servers.map((server) => new Promise((r) => server.close(r))));
  });

  it('hides the site\'s bar and play button on the player, and nothing else, while the player is up', async function() {
    await openPage('/bar');
    const ids = ['controls', 'play', 'header', 'topbar'];
    expect(await visibilities(ids)).toEqual({controls: 'visible', play: 'visible', header: 'visible', topbar: 'visible'});
    await clickToolbar();
    await browser.waitUntil(async () => (await visibilities(['controls'])).controls === 'hidden',
        {timeout: 15000, timeoutMsg: 'the site\'s bar stayed over the player'}).catch(() => {});
    // They lay over FastStream's player, which took #media's place under them.
    expect(await visibilities(ids)).toEqual({controls: 'hidden', play: 'hidden', header: 'visible', topbar: 'visible'});
    expect(await inPage(() => !!Array.from(document.querySelectorAll('iframe')).find((f) => f.src.includes('player/index.html'))))
        .toBe(true);

    await inPage(() => window.leave());
    await browser.waitUntil(async () => (await visibilities(['controls'])).controls === 'visible',
        {timeout: 15000, timeoutMsg: 'the site\'s bar was not given back'}).catch(() => {});
    expect(await visibilities(ids)).toEqual({controls: 'visible', play: 'visible', header: 'visible', topbar: 'visible'});
    expect(await inPage(() => document.getElementById('controls').style.visibility)).toBe('');
    expect(await takeContentErrors()).toEqual([]);
  });

  it('hides the bar a web-component player keeps in its shadow root, while the player is up', async function() {
    // The guard went through document.querySelectorAll('*'), which never sees a shadow
    // root, and the page's elementsFromPoint gives the shadow root's elements as their
    // host: the web component's own bar stayed over FastStream's player (#233).
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/shadow?t=${Date.now()}`);
    await browser.waitUntil(async () => inPage(() => window.shadowPart?.('main')?.readyState >= 2),
        {timeout: 20000, timeoutMsg: 'the web component\'s video never loaded'});
    await browser.pause(500);
    const state = () => inPage(() => ({
      controls: getComputedStyle(window.shadowPart('controls')).visibility,
      play: getComputedStyle(window.shadowPart('play')).visibility,
      header: getComputedStyle(document.getElementById('header')).visibility,
      topbar: getComputedStyle(document.getElementById('topbar')).visibility,
      player: !!Array.from(document.getElementById('host').shadowRoot.querySelectorAll('iframe'))
          .find((f) => f.src.includes('player/index.html')),
    }));
    await clickToolbar();
    await browser.waitUntil(async () => (await state()).controls === 'hidden',
        {timeout: 15000, timeoutMsg: 'the web component\'s bar stayed over the player'}).catch(() => {});
    expect(await state()).toEqual({controls: 'hidden', play: 'hidden', header: 'visible', topbar: 'visible', player: true});

    await inPage(() => window.leave());
    await browser.waitUntil(async () => (await state()).controls === 'visible',
        {timeout: 15000, timeoutMsg: 'the web component\'s bar was not given back'}).catch(() => {});
    expect(await state()).toMatchObject({controls: 'visible', play: 'visible', header: 'visible', topbar: 'visible'});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('hides the rest of a web-component player in windowed fullscreen, and gives it back', async function() {
    // Windowed fullscreen hides every element that does not hold the player, going through
    // document.querySelectorAll('*'): it expanded the custom element, but the bar beside
    // the player in its shadow root stayed (#233).
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/shadow?t=${Date.now()}`);
    await browser.waitUntil(async () => inPage(() => window.shadowPart?.('main')?.readyState >= 2),
        {timeout: 20000, timeoutMsg: 'the web component\'s video never loaded'});
    await browser.pause(500);
    // The player's first message to the page: the background has linked the player to its
    // iframe by then (content.js's listener runs before the page's). Windowed fullscreen
    // needs that link. In Firefox 158 the player is ready a moment before it, and a toggle
    // that soon was answered 'no_element' and did nothing (measured: Beta on Windows).
    await inPage(() => {
      window.__playerAnnounced = false;
      window.addEventListener('message', (e) => {
        const frame = document.getElementById('host').shadowRoot.querySelector('iframe[src*="player/index.html"]');
        if (frame && frame.contentWindow === e.source) {
          window.__playerAnnounced = true;
        }
      });
    });
    await clickToolbar();
    const frame = await browser.$('#host').shadow$('iframe[src*="player/index.html"]');
    await frame.waitForExist({timeout: 15000, timeoutMsg: 'no player in the web component'});
    await browser.waitUntil(async () => inPage(() => window.__playerAnnounced === true),
        {timeout: 15000, timeoutMsg: 'the player never linked up with its iframe'});
    const toggle = async () => {
      await browser.switchFrame(await browser.$('#host').shadow$('iframe[src*="player/index.html"]'));
      await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.interfaceController),
          {timeout: 15000, timeoutMsg: 'the player never started'});
      await browser.execute(() => window.fastStream.interfaceController.toggleWindowedFullscreen());
      await browser.switchFrame(null);
      await browser.pause(1000);
    };
    const state = () => inPage(() => {
      const iframe = Array.from(document.getElementById('host').shadowRoot.querySelectorAll('iframe'))
          .find((f) => f.src.includes('player/index.html'));
      const r = iframe.getBoundingClientRect();
      return {
        controls: getComputedStyle(window.shadowPart('controls')).display,
        play: getComputedStyle(window.shadowPart('play')).display,
        header: getComputedStyle(document.getElementById('header')).display,
        player: [r.width, r.height].map(Math.round),
        window: [window.innerWidth, window.innerHeight],
      };
    });

    // The toggle reaches the page's content script a message later: the fixed second above
    // was now and then not enough (5 first attempts in a week, the page not yet hidden,
    // #346). Waited for, then checked.
    const settles = (display, msg) => browser.waitUntil(async () => (await state()).controls === display,
        {timeout: 15000, timeoutMsg: msg}).catch(() => {});

    await toggle();
    await settles('none', 'windowed fullscreen never hid the rest of the web component');
    const full = await state();
    expect(full).toMatchObject({controls: 'none', play: 'none', header: 'none'});
    expect(full.player).toEqual(full.window);

    await toggle();
    await settles('block', 'leaving windowed fullscreen never gave the web component back');
    expect(await state()).toMatchObject({controls: 'block', play: 'block', header: 'block'});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('hides an ad over the player, and not the page wrapper under the player that holds it', async function() {
    await openPage('/stage');
    const ids = ['promo', 'nav', 'aside', 'ui'];
    expect(await visibilities(ids)).toEqual({promo: 'visible', nav: 'visible', aside: 'visible', ui: 'visible'});
    await clickToolbar();
    await browser.waitUntil(async () => (await visibilities(['promo'])).promo === 'hidden',
        {timeout: 15000, timeoutMsg: 'the ad stayed over the player'}).catch(() => {});
    expect(await visibilities(ids)).toEqual({promo: 'hidden', nav: 'visible', aside: 'visible', ui: 'visible'});

    await inPage(() => window.leave());
    await browser.waitUntil(async () => (await visibilities(['promo'])).promo === 'visible',
        {timeout: 15000, timeoutMsg: 'the ad was not given back'}).catch(() => {});
    expect(await visibilities(ids)).toEqual({promo: 'visible', nav: 'visible', aside: 'visible', ui: 'visible'});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('hides a see-through veil that holds an ad over the player, though clicks pass through it', async function() {
    await openPage('/veil');
    const ids = ['veil', 'promo', 'nav'];
    expect(await visibilities(ids)).toEqual({veil: 'visible', promo: 'visible', nav: 'visible'});
    await clickToolbar();
    await browser.waitUntil(async () => (await visibilities(['promo'])).promo === 'hidden',
        {timeout: 15000, timeoutMsg: 'the ad stayed over the player'}).catch(() => {});
    // Found through the ad, the veil goes with it. The case above's ancestor stop at first
    // took a veil missing from the hit test for one under the player: only the ad went, and
    // the veil stayed, dimming the player.
    expect(await visibilities(ids)).toEqual({veil: 'hidden', promo: 'hidden', nav: 'visible'});

    await inPage(() => window.leave());
    await browser.waitUntil(async () => (await visibilities(['veil'])).veil === 'visible',
        {timeout: 15000, timeoutMsg: 'the veil was not given back'}).catch(() => {});
    expect(await visibilities(ids)).toEqual({veil: 'visible', promo: 'visible', nav: 'visible'});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('leaves a dialog the site opens over the player alone', async function() {
    await openPage('/dialog');
    await clickToolbar();
    await browser.waitUntil(async () => (await visibilities(['promo'])).promo === 'hidden',
        {timeout: 15000, timeoutMsg: 'the ad stayed over the player'});
    await inPage(() => window.openDialog());
    await browser.waitUntil(async () => (await visibilities(['lateAd'])).lateAd === 'hidden',
        {timeout: 15000, timeoutMsg: 'the guard never looked again after the dialog opened'});
    // The whole page's layer with a dialog in it, hidden like an ad layer, left the user
    // no dialog to see while clicks went through its backdrop.
    expect(await visibilities(['modal', 'backdrop', 'dialog', 'promo'])).toEqual(
        {modal: 'visible', backdrop: 'visible', dialog: 'visible', promo: 'hidden'});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('hides the embedding page\'s bar over a full-page embed while its player is up', async function() {
    await openPage('/embedding', true);
    expect(await visibilities(['bar'])).toEqual({bar: 'visible'});
    await clickToolbar();
    await browser.waitUntil(async () => (await visibilities(['bar'])).bar === 'hidden',
        {timeout: 15000, timeoutMsg: 'the embedding page\'s bar stayed over the player'}).catch(() => {});
    expect(await visibilities(['bar'])).toEqual({bar: 'hidden'});
    // The player is in the embed.
    await browser.switchFrame(await browser.$('.player iframe'));
    expect(await browser.execute(() => !!Array.from(document.querySelectorAll('iframe')).find((f) => f.src.includes('player/index.html'))))
        .toBe(true);
    await browser.switchFrame(null);

    await inPage(() => window.leave());
    await browser.waitUntil(async () => (await visibilities(['bar'])).bar === 'visible',
        {timeout: 15000, timeoutMsg: 'the embedding page\'s bar was not given back'}).catch(() => {});
    expect(await visibilities(['bar'])).toEqual({bar: 'visible'});
    expect(await takeContentErrors()).toEqual([]);
  });
});
