// content.js keeps the page usable around an in-page player: it hides the page's own
// video next to the player (or overlays the whole page when the video fills it), keeps
// the page's media paused while the player is up, and puts everything back when the
// player goes - REMOVE_PLAYERS, sent on a same-site navigation, or a click on a link to
// another page of the site. Each case here is a way that used to fail.
//
// Every case also checks that content.js threw nothing. An exception in one of its
// listeners goes to Firefox's console service, where a chrome-context listener reads it;
// without that check, most of these failures show only as a quiet console error.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_ID, EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const SITE_PORT = 41978;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let siteServer;
let extHandle;
let siteHandle;

// A second of silence as a WAV, for the page's <audio>: the clip has no sound track, and
// an <audio> given only a video track never plays at all.
const SILENCE = (() => {
  const rate = 8000;
  const bytes = rate * 2; // 16-bit mono, all zero
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFFxxxxWAVEfmt ', 0, 'ascii');
  wav.writeUInt32LE(36 + bytes, 4);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); // bytes per second
  wav.writeUInt16LE(2, 32); // bytes per sample
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(bytes, 40);
  return wav;
})();

// The page's own video, hidden next to the player (the soft replace): #wrap is the
// outermost element with the video's bounds, so it is what content.js hides and watches.
// While the player is up, the iframe has the id "wrap" (content.js hands it over, so the
// page's CSS for the element sizes the player), so the page keeps its own reference.
const cleanupPage = (t) => `<!doctype html><title>cleanup</title>
<style>
  body { margin: 0; }
  #wrap, #wrap video { width: 640px; height: 360px; display: block; }
</style>
<div id="wrap" data-test="wrap" style="transition: opacity 0.25s"><video id="main" muted preload="auto" src="/clip.mp4?main=${t}"></video></div>
<a id="newtab" href="/other" target="_blank">another page, in a new tab</a>
<a id="sametab" href="/other">another page</a>
<script>
  window.wrap = document.getElementById('wrap');
  window.playerIframe = () => Array.from(document.querySelectorAll('iframe'))
      .find((f) => f.src.includes('player/index.html'));
  // A re-render inside the hidden player: the new video sits one level down.
  window.addNested = () => {
    const div = document.createElement('div');
    div.innerHTML = '<video id="nested" muted autoplay loop src="/clip.mp4?nested=${t}"></video>';
    window.wrap.appendChild(div);
  };
  window.addAudio = () => {
    const audio = document.createElement('audio');
    audio.id = 'sfx';
    audio.muted = true;
    audio.loop = true;
    audio.src = '/sound.wav?sfx=${t}';
    window.wrap.appendChild(audio);
    audio.play().catch(() => {});
  };
  // Below 100 px square, the soft replace turns hard: the video leaves the page.
  window.shrinkWhenReplaced = () => {
    new MutationObserver((records, observer) => {
      if (!window.playerIframe()) return;
      observer.disconnect();
      const sheet = document.styleSheets[0];
      sheet.insertRule('[data-test="wrap"], [data-test="wrap"] video { width: 5px !important; height: 5px !important; }',
          sheet.cssRules.length);
    }).observe(document.body, {childList: true, subtree: true});
  };
  // A same-site navigation without a page load, as a single-page site makes one.
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// A video that fills the page: the player overlays the whole page instead.
const fullPage = (t) => `<!doctype html><title>full</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  video { width: 100vw; height: 100vh; display: block; }
</style>
<video id="main" muted preload="auto" src="/clip.mp4?full=${t}"></video>
<script>
  window.leave = () => history.pushState({}, '', location.pathname + '/next');
</script>`;

// An episode page with two lists that link to it: a side list whose next entry has no
// link, then the real episode list.
const EPISODE_PAGE = `<!doctype html><title>episode 2</title>
<style>
  .card, li { display: block; width: 300px; height: 30px; }
  .card a, .card span, li a { display: inline-block; width: 100px; height: 20px; }
</style>
<div class="side">
  <div class="card"><a href="/episodes/ep8">Episode 8</a><span>x</span></div>
  <div class="card"><a href="/episodes/ep2">Episode 2</a><span>x</span></div>
  <div class="card"><span>soon</span><span>x</span></div>
</div>
<ul>
  <li><a href="/episodes/ep1">Episode 1</a></li>
  <li><a href="/episodes/ep2">Episode 2</a></li>
  <li><a href="/episodes/ep3">Episode 3</a></li>
</ul>`;

// A video in a shadow root, which a plain querySelectorAll does not reach.
const shadowPage = (t) => `<!doctype html><title>shadow</title>
<div id="host"></div>
<script>
  document.getElementById('host').attachShadow({mode: 'open'}).innerHTML =
    '<video id="v" muted loop autoplay style="width: 320px; height: 180px" src="/clip.mp4?shadow=${t}"></video>';
</script>`;

/**
 * Runs an async function in Firefox's chrome context.
 * @param {Function} fn - Called as fn(...args, done).
 * @param {...*} args - Serialisable arguments.
 * @return {Promise<*>} Whatever fn passed to done.
 */
async function inChrome(fn, ...args) {
  await browser.setMozContext('chrome');
  try {
    return await browser.executeAsync(fn, ...args);
  } finally {
    await browser.setMozContext('content');
  }
}

/** Starts collecting the errors content.js reports, once per browser. */
async function watchContentErrors() {
  await inChrome((done) => {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    if (!win.__fsContentErrors) {
      win.__fsContentErrors = [];
      win.__fsContentErrorListener = {
        observe(message) {
          try {
            if (message instanceof Ci.nsIScriptError &&
                /^moz-extension:\/\/[^/]+\/content\.js/.test(message.sourceName || '') &&
                !(message.flags & Ci.nsIScriptError.warningFlag) &&
                // Firefox's note that a message's answer came after its page had gone: the
                // unload handler's FRAME_REMOVED, when a case loads the next page. Nothing
                // content.js threw, and it comes or not with the timing.
                !(message.errorMessage || '').startsWith('Promise resolved while context is inactive')) {
              win.__fsContentErrors.push(`${message.errorMessage} (content.js:${message.lineNumber})`);
            }
          } catch (e) {
            // Not a script error.
          }
        },
      };
      Services.console.registerListener(win.__fsContentErrorListener);
    }
    done(true);
  });
}

/** @return {Promise<Array<string>>} The errors content.js reported since the last call. */
async function takeContentErrors() {
  return await inChrome((done) => {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    done(win.__fsContentErrors.splice(0));
  });
}

/** Clicks the extension's toolbar button for the site tab. */
async function clickToolbar() {
  await browser.switchToWindow(siteHandle);
  const result = await inChrome((extId, done) => {
    (async () => {
      try {
        const {ExtensionParent} = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionParent.sys.mjs');
        const extension = WebExtensionPolicy.getByID(extId).extension;
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        await ExtensionParent.apiManager.global.browserActionFor(extension).triggerAction(win);
        done({ok: true});
      } catch (e) {
        done({err: String(e)});
      }
    })();
  }, EXTENSION_ID);
  if (!result || !result.ok) {
    throw new Error('could not click the toolbar button: ' + JSON.stringify(result));
  }
}

/** @return {Promise<?number>} The site tab's id. */
async function siteTabId() {
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((site, done) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(site + '/'));
      done(tab ? tab.id : null);
    });
  }, SITE);
}

/** @return {Promise<string>} The site tab's mode, 'on' or 'off'. */
async function tabMode() {
  const tabId = await siteTabId();
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((tabId, done) => {
    chrome.action.getBadgeText({tabId}, (badge) => done(badge === 'On' ? 'on' : 'off'));
  }, tabId);
}

/**
 * Sends a message to the site tab's top frame, as the background does.
 * @param {Object} message - The message.
 * @return {Promise<*>} Its answer.
 */
async function sendToPage(message) {
  const tabId = await siteTabId();
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((tabId, message, done) => {
    chrome.tabs.sendMessage(tabId, message, {frameId: 0}, (response) => {
      done(chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : response);
    });
  }, tabId, message);
}

/**
 * Runs a function in the site page.
 * @param {Function} fn - The function.
 * @param {...*} args - Serialisable arguments.
 * @return {Promise<*>} What it returned.
 */
async function inPage(fn, ...args) {
  await browser.switchToWindow(siteHandle);
  return await browser.execute(fn, ...args);
}

/** @return {Promise<boolean>} Whether the site page has FastStream's player iframe. */
async function hasPlayer() {
  return await inPage(() => Array.from(document.querySelectorAll('iframe'))
      .some((f) => f.src.includes('player/index.html')));
}

/**
 * Loads a site page, and waits until its video has data: the background has detected it.
 * @param {string} pathname - The page.
 */
async function openPage(pathname) {
  await browser.switchToWindow(siteHandle);
  await browser.url(`${SITE}${pathname}?t=${Date.now()}`);
  await browser.waitUntil(async () => inPage(() => {
    const video = document.querySelector('video');
    return !!video && video.readyState >= 2;
  }), {timeout: 20000, timeoutMsg: `the video of ${pathname} never loaded`});
  // Watches for the player's first message to the page: the background has linked the
  // player to its iframe by then.
  await inPage(() => {
    window.__playerAnnounced = false;
    window.addEventListener('message', (e) => {
      const frame = Array.from(document.querySelectorAll('iframe')).find((f) => f.contentWindow === e.source);
      if (frame && frame.src.includes('player/index.html')) {
        window.__playerAnnounced = true;
      }
    });
  });
  // The detection is an async webRequest event on top of the load.
  await browser.pause(500);
}

/** Turns FastStream on for the page, and waits for its player to be up and linked. */
async function openPlayer() {
  await clickToolbar();
  await browser.waitUntil(hasPlayer, {timeout: 15000, timeoutMsg: 'the player never opened'});
  await browser.waitUntil(async () => inPage(() => window.__playerAnnounced === true),
      {timeout: 15000, timeoutMsg: 'the player never announced itself'});
  // The soft replace re-measures the page's video for its first two seconds.
  await browser.pause(2500);
}

/** Resizes the browser window a little and back, as a user would. */
async function nudgeWindowSize() {
  const {width, height} = await browser.getWindowSize();
  await browser.setWindowSize(width - 60, height - 40);
  await browser.pause(500);
  await browser.setWindowSize(width, height);
  await browser.pause(500);
}

/**
 * Checks which of the page's media elements are playing after a play() on each.
 * @param {Array<string>} ids - Element ids.
 * @return {Promise<Object<string, boolean>>} id: playing.
 */
async function playingAfterPlay(ids) {
  await inPage((ids) => {
    for (const id of ids) document.getElementById(id).play().catch(() => {});
  }, ids);
  await browser.pause(1500);
  return await inPage((ids) => Object.fromEntries(ids.map((id) => [id, !document.getElementById(id).paused])), ids);
}

describe('content.js around an in-page player', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));
    siteServer = http.createServer((req, res) => {
      const pathname = req.url.split('?')[0];
      const t = Date.now();
      if (pathname === '/clip.mp4') {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(clip.length),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(clip);
        return;
      }
      if (pathname === '/sound.wav') {
        res.writeHead(200, {'Content-Type': 'audio/wav', 'Content-Length': String(SILENCE.length)});
        res.end(SILENCE);
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html'});
      if (pathname.startsWith('/cleanup')) {
        res.end(cleanupPage(t));
      } else if (pathname.startsWith('/full')) {
        res.end(fullPage(t));
      } else if (pathname.startsWith('/episodes/ep2')) {
        res.end(EPISODE_PAGE);
      } else if (pathname.startsWith('/shadow')) {
        res.end(shadowPage(t));
      } else {
        // Any other page of the site (the links' /other). The same page whatever was asked:
        // the cases read location, and a server that echoes its request is reflected XSS
        // to CodeQL.
        res.end('<!doctype html><title>another page</title><p>another page</p>');
      }
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'), ORIGIN + '/player/index.html');
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).startsWith(ORIGIN)) {
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
    // The next case starts with FastStream off. With a player still up, Off reloads the
    // page, which is fine here.
    if (siteHandle && (await siteTabId()) !== null && (await tabMode()) === 'on') {
      await clickToolbar();
    }
    // Tabs a case opened.
    for (const handle of await browser.getWindowHandles()) {
      if (handle !== extHandle && handle !== siteHandle) {
        await browser.switchToWindow(handle);
        await browser.closeWindow();
      }
    }
    await takeContentErrors();
  });

  after(async function() {
    if (siteServer) await new Promise((r) => siteServer.close(r));
  });

  it('keeps the page\'s media paused while the player is up, and lets it play after', async function() {
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => {
      window.addNested();
      window.addAudio();
    });
    await browser.pause(2000);
    // The re-render one level down used to be missed and played under the player.
    expect(await inPage(() => ({
      nested: document.getElementById('nested').paused,
      sfx: document.getElementById('sfx').paused,
    }))).toEqual({nested: true, sfx: true});

    await inPage(() => window.leave());
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the player up'});
    // The <audio> kept its pause-on-play hook, so the page's sounds never played again.
    expect(await playingAfterPlay(['main', 'nested', 'sfx'])).toEqual({main: true, nested: true, sfx: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('gives the page\'s video its own styles and id back', async function() {
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => window.leave());
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the player up'});
    // The page's transition used to stay replaced by "none !important", and the element
    // stayed without its id, which the iframe had taken: the page's #wrap rule no longer
    // sized it.
    expect(await inPage(() => ({
      id: window.wrap.id,
      transition: window.wrap.style.transition,
      width: window.wrap.getBoundingClientRect().width,
    }))).toEqual({id: 'wrap', transition: 'opacity 0.25s', width: 640});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('cleans up after a page that removed the player itself', async function() {
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => window.playerIframe().remove());
    await nudgeWindowSize();
    await inPage(() => window.leave());
    await browser.pause(1500);
    // The cleanup threw on the missing iframe, and the page's video stayed paused for good.
    expect(await playingAfterPlay(['main'])).toEqual({main: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('copes with a page that removed a hard-replaced player', async function() {
    await openPage('/cleanup');
    await inPage(() => window.shrinkWhenReplaced());
    await openPlayer();
    await browser.waitUntil(async () => inPage(() => !document.contains(window.wrap)),
        {timeout: 10000, timeoutMsg: 'the soft replace never turned hard'});
    await inPage(() => window.playerIframe().remove());
    // Each resize, and the cleanup, used to throw on the iframe that has no parent.
    await nudgeWindowSize();
    await inPage(() => window.leave());
    await browser.pause(1500);
    expect(await takeContentErrors()).toEqual([]);
  });

  it('removes a player that overlays the whole page', async function() {
    await openPage('/full');
    await openPlayer();
    await inPage(() => window.leave());
    // The overlay was never tracked: it stayed on top of the restored page.
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the overlay player up'});
    expect(await playingAfterPlay(['main'])).toEqual({main: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('keeps the player for a link opened in another tab', async function() {
    await openPage('/cleanup');
    await openPlayer();
    const before = (await browser.getWindowHandles()).length;

    await browser.switchToWindow(siteHandle);
    await browser.$('#newtab').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before,
        {timeout: 10000, timeoutMsg: 'the target="_blank" link opened no tab'});
    await browser.switchToWindow(siteHandle);
    expect(await hasPlayer()).toBe(true);

    // Ctrl+click, a real one, on a link without a target.
    const link = await browser.$('#sametab');
    await browser.performActions([
      {type: 'key', id: 'keyboard', actions: [
        {type: 'keyDown', value: '\uE009'},
        {type: 'pause', duration: 0}, {type: 'pause', duration: 0}, {type: 'pause', duration: 0},
        {type: 'keyUp', value: '\uE009'},
      ]},
      {type: 'pointer', id: 'mouse', parameters: {pointerType: 'mouse'}, actions: [
        {type: 'pause', duration: 0},
        {type: 'pointerMove', origin: {'element-6066-11e4-a52e-4f735466cecf': link.elementId}, x: 0, y: 0},
        {type: 'pointerDown', button: 0},
        {type: 'pointerUp', button: 0},
        {type: 'pause', duration: 0},
      ]},
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before + 1,
        {timeout: 10000, timeoutMsg: 'the Ctrl+click opened no tab'});
    await browser.switchToWindow(siteHandle);
    // The tab never navigated, and the player used to be torn down anyway.
    expect(await hasPlayer()).toBe(true);
    expect(await takeContentErrors()).toEqual([]);
  });

  it('finds the next episode past a list whose next entry has no link', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/episodes/ep2`);
    await browser.pause(500);
    // The first list matched, its next entry had no link, and the search gave up there.
    expect(await sendToPage({type: 'PLAYLIST_POLL'})).toEqual({next: true, previous: true});
    expect(await sendToPage({type: 'PLAYLIST_NAVIGATION', direction: 'next'})).toBe('clicked');
    await browser.waitUntil(async () => (await inPage(() => location.pathname)) === '/episodes/ep3',
        {timeout: 10000, timeoutMsg: 'the next-episode link was not ep3'});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('pauses a video in a shadow root when mpv takes over', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/shadow?t=${Date.now()}`);
    await browser.waitUntil(async () => inPage(() => {
      const video = document.getElementById('host').shadowRoot.getElementById('v');
      return !!video && !video.paused;
    }), {timeout: 20000, timeoutMsg: 'the shadow-root video never played'});
    // What the background sends once mpv has the stream.
    expect(await sendToPage({type: 'PAUSE_MEDIA'})).toBe(1);
    expect(await inPage(() => document.getElementById('host').shadowRoot.getElementById('v').paused))
        .toBe(true);
    expect(await takeContentErrors()).toEqual([]);
  });
});
