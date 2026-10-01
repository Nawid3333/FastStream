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
  // A re-render inside the hidden player: the new video sits one level down.
  window.addNested = () => {
    const div = document.createElement('div');
    div.innerHTML = '<video id="nested" muted autoplay loop src="/clip.mp4?nested=${t}"></video>';
    window.wrap.appendChild(div);
  };
  // A re-render as a custom element: its video in the element's own shadow root.
  window.addShadowHost = () => {
    const host = document.createElement('div');
    host.id = 'host';
    host.attachShadow({mode: 'open'}).innerHTML =
        '<video id="shadowed" muted autoplay loop src="/clip.mp4?shadowed=${t}"></video>';
    window.wrap.appendChild(host);
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
</script>
${removePlayersScript()}
${addVideoScript(t)}`;

/**
 * window.removePlayersAtOnce(): a re-render that takes the player's iframe out the moment
 * it is put in, before its player can load; keepPlayers() ends it.
 * @return {string} The script.
 */
function removePlayersScript() {
  return `<script>
  window.playerIframe = () => Array.from(document.querySelectorAll('iframe'))
      .find((f) => f.src.includes('player/index.html'));
  window.removedPlayers = 0;
  window.removePlayersAtOnce = () => {
    window.playerRemover = new MutationObserver(() => {
      const iframe = window.playerIframe();
      if (iframe) {
        iframe.remove();
        window.removedPlayers++;
      }
    });
    window.playerRemover.observe(document.body, {childList: true, subtree: true});
  };
  window.keepPlayers = () => window.playerRemover.disconnect();
</script>`;
}

/**
 * window.addVideo(): another video the page adds, as a re-render or the next item of a
 * single-page site does.
 * @param {number} t - The page's time, for a URL of its own.
 * @return {string} The script.
 */
function addVideoScript(t) {
  return `<script>
  window.addVideo = () => {
    const video = document.createElement('video');
    video.id = 'later';
    video.muted = true;
    video.preload = 'auto';
    video.style.cssText = 'width: 640px; height: 360px; display: block';
    video.src = '/clip.mp4?later=${t}';
    document.body.appendChild(video);
  };
</script>`;
}

// The page's element (.box) in a wrapper with an id of its own. Each adds a strip below
// the video, so .box has the video's bounds and is what content.js hides, and the
// wrapper has the player's: the miniplayer lifts the wrapper, and the placeholder it
// leaves in the page holds the wrapper's id. The spacer lets the page scroll the
// placeholder out of view, as a miniplayer is used.
const wrapperPage = (t) => `<!doctype html><title>wrapper</title>
<style>
  body { margin: 0; }
  #col { width: 660px; }
  .box { width: 640px; }
  .box video { width: 640px; height: 360px; display: block; }
  .bar, .title { height: 30px; }
</style>
<div id="col"><div class="box"><video id="main" muted preload="auto" src="/clip.mp4?wrapper=${t}"></video><div class="bar"></div></div><div class="title"></div></div>
<div style="height: 3000px"></div>
<script>
  window.col = document.getElementById('col');
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
</script>
${removePlayersScript()}
${addVideoScript(t)}`;

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

// Episode lists whose next entry leads to another site, as an ad in the list does:
// entries that hold a link, and entries that are links. localhost is another origin than
// the 127.0.0.1 the page is on.
const AD_EPISODE_PAGES = {
  '/episodes/ad2': `<!doctype html><title>episode 2</title>
<style>
  li { display: block; width: 300px; height: 30px; }
  li a { display: inline-block; width: 100px; height: 20px; }
</style>
<ul>
  <li><a href="/episodes/ad1">Episode 1</a></li>
  <li><a href="/episodes/ad2">Episode 2</a></li>
  <li><a href="http://localhost:${SITE_PORT}/episodes/ad3">Episode 3</a></li>
</ul>`,
  '/episodes/bd2': `<!doctype html><title>episode 2</title>
<style>
  nav a { display: block; width: 300px; height: 30px; }
</style>
<nav>
  <a href="/episodes/bd1">Episode 1</a>
  <a href="/episodes/bd2">Episode 2</a>
  <a href="http://localhost:${SITE_PORT}/episodes/bd3">Episode 3</a>
</nav>`,
};

// A page that swaps its video for a copy on every frame, as one that keeps re-rendering
// its player does. The copy goes in from a message posted as the frame starts: it runs
// after the browser has measured what is visible, and before it hands that over.
const swapPage = (t) => `<!doctype html><title>swap</title>
<style>
  body { margin: 0; }
  main { padding: 20px; }
  main video { width: 640px; height: 360px; display: block; }
</style>
<main><video muted preload="none" src="/clip.mp4?swap=${t}"></video></main>
<script>
  window.swaps = 0;
  window.addEventListener('message', (e) => {
    if (e.data !== 'swap') return;
    const video = document.querySelector('main video');
    if (video) {
      video.replaceWith(video.cloneNode());
      window.swaps++;
    }
  });
  const frame = () => {
    window.postMessage('swap', '*');
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
</script>`;

// A button that makes up a 'play' event for the video, and one that plays it.
const fakePlayPage = (t) => `<!doctype html><title>fake play</title>
<video id="main" muted loop preload="auto" style="width: 320px; height: 180px" src="/clip.mp4?fakeplay=${t}"></video>
<button id="fake">fake play</button>
<button id="real">play</button>
<script>
  const main = document.getElementById('main');
  document.getElementById('fake').addEventListener('click', () => main.dispatchEvent(new Event('play')));
  document.getElementById('real').addEventListener('click', () => main.play());
</script>`;

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
      win.__fsUnsourcedErrors = [];
      win.__fsContentErrorListener = {
        observe(message) {
          try {
            // A promise rejected with an error the browser made (a refused fullscreen
            // request) comes without a source when nothing handles it. Kept apart: which
            // script it came from is for the case to judge.
            if (message instanceof Ci.nsIScriptError && !message.sourceName &&
                !(message.flags & Ci.nsIScriptError.warningFlag)) {
              win.__fsUnsourcedErrors.push(message.errorMessage);
            }
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
    win.__fsUnsourcedErrors.length = 0;
    done(win.__fsContentErrors.splice(0));
  });
}

/** @return {Promise<Array<string>>} The errors without a source since the last call. */
async function takeUnsourcedErrors() {
  return await inChrome((done) => {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    done(win.__fsUnsourcedErrors.splice(0));
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
 * @param {number} [within] - How long to wait for the answer, in ms; 0 for as long as it
 *   takes.
 * @return {Promise<*>} Its answer, or {error: 'no answer'} after `within`.
 */
async function sendToPage(message, within = 0) {
  const tabId = await siteTabId();
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((tabId, message, within, done) => {
    if (within) {
      setTimeout(() => done({error: 'no answer'}), within);
    }
    chrome.tabs.sendMessage(tabId, message, {frameId: 0}, (response) => {
      done(chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : response);
    });
  }, tabId, message, within);
}

/**
 * sendToPage for a message the site tab must be in front for: a tab in the background
 * runs none of the page's animation frames, and measures what is visible only once a
 * second. The extension's tab sends it a second after the site tab is shown again.
 * @param {Object} message - The message.
 * @param {number} within - How long to wait for the answer once sent, in ms.
 * @return {Promise<*>} Its answer, or {error: 'no answer'}.
 */
async function sendToPageInFront(message, within) {
  const tabId = await siteTabId();
  await browser.switchToWindow(extHandle);
  await browser.execute((tabId, message) => {
    window.__answer = undefined;
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, message, {frameId: 0}, (response) => {
        window.__answer = chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : response;
      });
    }, 1000);
  }, tabId, message);
  await browser.switchToWindow(siteHandle);
  // A timer in a background tab may come up to a second late.
  await browser.pause(2000 + within);
  await browser.switchToWindow(extHandle);
  return await browser.execute(() => window.__answer === undefined ? {error: 'no answer'} : window.__answer);
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
      } else if (pathname.startsWith('/wrapper')) {
        res.end(wrapperPage(t));
      } else if (pathname.startsWith('/full')) {
        res.end(fullPage(t));
      } else if (pathname.startsWith('/episodes/ep2')) {
        res.end(EPISODE_PAGE);
      } else if (Object.hasOwn(AD_EPISODE_PAGES, pathname)) {
        res.end(AD_EPISODE_PAGES[pathname]);
      } else if (pathname.startsWith('/swap')) {
        res.end(swapPage(t));
      } else if (pathname.startsWith('/fakeplay')) {
        res.end(fakePlayPage(t));
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

  it('keeps a video paused that the page adds inside a new element\'s shadow root', async function() {
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => window.addShadowHost());
    await browser.pause(2000);
    // The observer looked below each added element, but not into its own shadow root.
    expect(await inPage(() => {
      const video = document.getElementById('host').shadowRoot.getElementById('shadowed');
      return {paused: video.paused, played: video.currentTime > 0.5};
    })).toEqual({paused: true, played: false});
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

  it('keeps the player in the box the page\'s #id rule gives its element', async function() {
    await openPage('/cleanup');
    await openPlayer();
    // The soft replace measures the element again on each update: a resize, and 8 times in
    // its first 2 s. It measured it without the id it had handed to the player, so the
    // page's #wrap rule no longer sized it, and the player took the page's whole width.
    await browser.pause(2500);
    expect(await inPage(() => {
      const r = window.playerIframe().getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map(Math.round);
    })).toEqual([0, 0, 640, 360]);
    expect(await takeContentErrors()).toEqual([]);
  });

  it('measures the element with its own rules while the miniplayer lifts a wrapper', async function() {
    await openPage('/wrapper');
    await openPlayer();
    // Out of view, or the miniplayer closes at once.
    await inPage(() => window.scrollTo(0, 1500));
    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    await browser.execute(() => window.fastStream.interfaceController.requestMiniplayer(true));
    await browser.switchFrame(null);
    await browser.waitUntil(async () => inPage(() => getComputedStyle(window.col).position === 'fixed'),
        {timeout: 10000, timeoutMsg: 'the miniplayer never opened'});
    await nudgeWindowSize();
    // Each update measures the element for the placeholder, lending it its id back first
    // (the case above). But this placeholder holds the wrapper's id: lent that, the element
    // took the page's #col rule, and the placeholder became 660 wide.
    expect(await inPage(() => {
      const placeholder = document.getElementById('col');
      const r = placeholder.getBoundingClientRect();
      return {placeholder: placeholder !== window.col, size: [r.width, r.height].map(Math.round)};
    })).toEqual({placeholder: true, size: [640, 390]});
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

  // The background keeps a player's frame apart: its streams are the player's own, and
  // no player opens over it. Only the player's beforeunload told it the player went, and
  // an iframe taken out of the page runs none: the page's next video was dropped as the
  // player's, and no player opened for it until the page navigated.
  it('opens a player for the next video after the page removed the player itself', async function() {
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => window.playerIframe().remove());
    await inPage(() => window.addVideo());
    await browser.waitUntil(hasPlayer, {
      timeout: 15000,
      timeoutMsg: 'no player opened for the video the page added after it removed the player',
    });
    expect(await takeContentErrors()).toEqual([]);
  });

  // Taken out before its player loaded, the iframe ran nothing to tell the background, and
  // the background kept the frame's player opening: no player opened there again until the
  // page navigated.
  it('opens a player for the next video after the page removed a player still loading', async function() {
    await openPage('/cleanup');
    await inPage(() => window.removePlayersAtOnce());
    await clickToolbar();
    await browser.waitUntil(async () => inPage(() => window.removedPlayers > 0), {
      timeout: 15000,
      timeoutMsg: 'FastStream never put a player in the page',
    });
    await inPage(() => window.keepPlayers());
    await inPage(() => window.addVideo());
    await browser.waitUntil(hasPlayer, {
      timeout: 15000,
      timeoutMsg: 'no player opened for the video the page added after it removed a player still loading',
    });
    expect(await takeContentErrors()).toEqual([]);
  });

  // The player it put in was taken out before it linked up, and nothing let go of what it
  // took: the page's element stayed hidden (0 by 0), and its video paused itself on every
  // play, until FastStream was turned off.
  it('gives the page its video back when it removed a player still loading', async function() {
    await openPage('/cleanup');
    await inPage(() => window.removePlayersAtOnce());
    await clickToolbar();
    await browser.waitUntil(async () => inPage(() => window.removedPlayers > 0), {
      timeout: 15000,
      timeoutMsg: 'FastStream never put a player in the page',
    });
    await inPage(() => window.keepPlayers());
    await browser.pause(500);
    expect(await inPage(() => ({
      id: window.wrap.id,
      width: window.wrap.getBoundingClientRect().width,
    }))).toEqual({id: 'wrap', width: 640});
    expect(await playingAfterPlay(['main'])).toEqual({main: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  // The same for a player laid over the whole page, which hides everything else on it.
  it('shows the page again when it removed an overlay player still loading', async function() {
    await openPage('/full');
    await inPage(() => window.removePlayersAtOnce());
    await clickToolbar();
    await browser.waitUntil(async () => inPage(() => window.removedPlayers > 0), {
      timeout: 15000,
      timeoutMsg: 'FastStream never put a player in the page',
    });
    await inPage(() => window.keepPlayers());
    await browser.pause(500);
    expect(await inPage(() => getComputedStyle(document.getElementById('main')).display)).toBe('block');
    expect(await playingAfterPlay(['main'])).toEqual({main: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  // The page's sounds already there when the player opens: only its videos were paused.
  it('pauses the page\'s sounds already playing when the player opens', async function() {
    await openPage('/cleanup');
    await inPage(() => window.addAudio());
    await browser.waitUntil(async () => inPage(() => !document.getElementById('sfx').paused),
        {timeout: 10000, timeoutMsg: 'the page\'s sound never played'});
    await openPlayer();
    expect(await inPage(() => document.getElementById('sfx').paused)).toBe(true);
    await inPage(() => window.leave());
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the player up'});
    expect(await playingAfterPlay(['main', 'sfx'])).toEqual({main: true, sfx: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  // getVideo() waits for what is visible, measured while the browser draws and handed over
  // in a task of its own: a page task queued as the frame started runs in between (Firefox
  // 156, 40 tries of 40). A video swapped out meanwhile is still reported visible. Only its
  // size, read again after the wait (0 once out of the page), keeps the player from being
  // put next to an element with no parent - a TypeError, answered 'error'.
  it('opens no player next to a video the page swapped out meanwhile', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/swap?t=${Date.now()}`);
    await browser.waitUntil(async () => inPage(() => window.swaps > 10),
        {timeout: 10000, timeoutMsg: 'the page never swapped its video'});
    for (let i = 0; i < 2; i++) {
      const answer = await sendToPageInFront({type: 'OPEN_PLAYER', url: `${ORIGIN}/player/index.html`, frameId: 0}, 3000);
      expect(['no_video', 'replace']).toContain(answer);
      expect(await sendToPage({type: 'REMOVE_PLAYERS'})).toBe('ok');
    }
    expect(await takeContentErrors()).toEqual([]);
  });

  // Anything that threw while the player went in left OPEN_PLAYER without an answer, and
  // the background kept the frame's player opening: no player opened there again until a
  // navigation. A URL that is none stands in for whatever may throw.
  it('answers OPEN_PLAYER when putting the player in fails', async function() {
    await openPage('/cleanup');
    expect(await sendToPage({type: 'OPEN_PLAYER', url: 'not a url', frameId: 0}, 5000)).toBe('error');
    expect(await hasPlayer()).toBe(false);
  });

  it('answers a fullscreen request it cannot carry out, and throws nothing', async function() {
    await openPage('/cleanup');
    // For a frame it holds no player of: answered, and thrown on top.
    expect(await sendToPage({type: 'TOGGLE_FULLSCREEN', frameId: 424242})).toBe('no_element');
    expect(await sendToPage({type: 'TOGGLE_WINDOWED_FULLSCREEN', frameId: 424242})).toBe('no_element');
    // Refused by Firefox, asked with no click to go on: answered, and rethrown. The player's
    // iframe under a frame id of the test's own, linked the way the background links it.
    await openPlayer();
    expect(await sendToPage({type: 'FRAME_LINK_RECEIVER', key: 'fs-test-link', frameId: 424243})).toBe('ok');
    await browser.switchToWindow(siteHandle);
    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    await browser.execute(() => window.parent.postMessage('fs-test-link', '*'));
    await browser.switchFrame(null);
    await browser.pause(300);
    await takeUnsourcedErrors();
    expect(await sendToPage({type: 'TOGGLE_FULLSCREEN', frameId: 424243, force: true})).toBe('error');
    await browser.pause(500);
    // The rethrown refusal: "TypeError: Fullscreen request denied", without a source.
    expect((await takeUnsourcedErrors()).filter((m) => /fullscreen/i.test(m))).toEqual([]);
    expect(await takeContentErrors()).toEqual([]);
  });

  it('opens a player for the next video after a same-site navigation took the overlay', async function() {
    await openPage('/full');
    await openPlayer();
    await inPage(() => window.leave());
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the overlay player up'});
    await inPage(() => window.addVideo());
    await browser.waitUntil(hasPlayer, {
      timeout: 15000,
      timeoutMsg: 'no player opened for the video the page added after the navigation',
    });
    expect(await takeContentErrors()).toEqual([]);
  });

  // Back to a page Firefox kept in its back-forward cache: the page comes back as it was,
  // content script and all, and fetches nothing again. Its leaving had made the background
  // forget its frame and the video detected on it, so the toolbar's On opened no player.
  it('opens the player on a page Back brought out of the back-forward cache', async function() {
    await openPage('/cleanup');
    await inPage(() => {
      window.__kept = true;
    });
    await openPage('/wrapper');
    await browser.back();
    await browser.waitUntil(async () => inPage(() => location.pathname === '/cleanup'),
        {timeout: 10000, timeoutMsg: 'Back never reached the first page'});
    // From the cache, not loaded again: a load fetches the video anew, and proves nothing.
    expect(await inPage(() => window.__kept === true)).toBe(true);
    await openPlayer();
    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    let source;
    try {
      await browser.waitUntil(async () => {
        source = await browser.execute(() => window.fastStream?.source?.url || null);
        return !!source;
      }, {timeout: 15000, interval: 250, timeoutMsg: 'the player never got a source'});
    } finally {
      await browser.switchFrame(null);
    }
    expect(source).toContain('/clip.mp4?main=');
    expect(await takeContentErrors()).toEqual([]);
  });

  // The same from another site: the background resets the tab on a new hostname
  // (tabs.onUpdated), and that can come after the page named itself again.
  it('opens the player on a page Back brought back from another site', async function() {
    await openPage('/cleanup');
    await inPage(() => {
      window.__kept = true;
    });
    // localhost is another hostname for the same server.
    await browser.url(`http://localhost:${SITE_PORT}/wrapper?t=${Date.now()}`);
    await browser.waitUntil(async () => inPage(() => location.hostname === 'localhost' &&
        document.querySelector('video')?.readyState >= 2), {timeout: 20000, timeoutMsg: 'the other site never loaded'});
    await browser.back();
    await browser.waitUntil(async () => inPage(() => location.pathname === '/cleanup'),
        {timeout: 10000, timeoutMsg: 'Back never reached the first page'});
    expect(await inPage(() => window.__kept === true)).toBe(true);
    await openPlayer();
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

  it('follows no next-episode link to another site', async function() {
    for (const pathname of Object.keys(AD_EPISODE_PAGES)) {
      await browser.switchToWindow(siteHandle);
      await browser.url(`${SITE}${pathname}`);
      await browser.pause(500);
      // The list's next entry, on another site, was taken all the same.
      expect({pathname, poll: await sendToPage({type: 'PLAYLIST_POLL'})})
          .toEqual({pathname, poll: {next: false, previous: true}});
      expect(await sendToPage({type: 'PLAYLIST_NAVIGATION', direction: 'next'})).toBe('no_button');
    }
    expect(await takeContentErrors()).toEqual([]);
  });

  // The shortcut sends the video the user started. A 'play' the page made up, during a
  // click, made its video count as one.
  it('counts no made-up play as the user starting a video', async function() {
    await openPage('/fakeplay');
    await inPage(() => document.getElementById('main').play());
    await browser.waitUntil(async () => inPage(() => !document.getElementById('main').paused),
        {timeout: 10000, timeoutMsg: 'the video never played'});
    await browser.switchToWindow(siteHandle);
    await browser.$('#fake').click();
    expect(await sendToPage({type: 'MPV_REPORT_PLAYING'})).toBe(false);

    // A real one: the click plays it.
    await inPage(() => document.getElementById('main').pause());
    await browser.switchToWindow(siteHandle);
    await browser.$('#real').click();
    await browser.waitUntil(async () => inPage(() => !document.getElementById('main').paused),
        {timeout: 10000, timeoutMsg: 'the click never played the video'});
    expect(await sendToPage({type: 'MPV_REPORT_PLAYING'})).toBe(true);
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
