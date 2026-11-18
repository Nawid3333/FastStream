// content.js keeps the page usable around an in-page player (hides its video, keeps its media
// paused) and puts everything back when the player goes.
// Every case also checks that content.js threw nothing: its listeners' exceptions show only in
// Firefox's console service.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {inChrome, clickToolbar as clickToolbarIn} from '../classic-helpers.mjs';
import {BUILD, EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

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
  const bytes = rate * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFFxxxxWAVEfmt ', 0, 'ascii');
  wav.writeUInt32LE(36 + bytes, 4);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(bytes, 40);
  return wav;
})();

// #wrap is the outermost element with the video's bounds; while the player is up the iframe has
// that id.
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
 * window.removePlayersAtOnce(): a re-render that takes the player's iframe out the moment it is put
 * in.
 * @return {string}
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
 * window.addVideo(): another video the page adds, as a re-render or a single-page site's next item
 * does.
 * @param {number} t
 * @return {string}
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

// .box has the video's bounds (content.js hides it), the wrapper the player's: the miniplayer's
// placeholder holds its id.
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

// Next-episode links content.js finds (chrome/episode-links.js), and two it must not take.
const DETECTION_PAGES = {
  // An icon link with no words: the address's episode number +1 (and -1), beside an ad's
  // "Next" on another site.
  '/serie/x/staffel-1/episode-4': `<!doctype html><title>episode 4</title>
<a href="/serie/x/staffel-1/episode-3" style="display: inline-block; width: 40px; height: 20px"><svg width="20" height="20"></svg></a>
<a href="/serie/x/staffel-1/episode-5" style="display: inline-block; width: 40px; height: 20px"><svg width="20" height="20"></svg></a>
<a href="http://localhost:${SITE_PORT}/promo">Next</a>`,
  // A German phrase, beside a page of a list.
  '/de/folge-a': `<!doctype html><meta charset="utf-8"><title>Folge</title>
<a href="/de/seite-2">Nächste Seite</a> <a href="/de/naechste">Nächste Folge »</a>`,
  // A button, no link.
  '/btn/ep': `<!doctype html><title>episode</title>
<button type="button" onclick="location.href = '/btn/ep-next'">Next episode</button>`,
  // A link whose own click goes elsewhere, as an ad's handler does: its address is followed.
  '/ad/episode-1': `<!doctype html><title>episode 1</title>
<a href="/ad/episode-2" onclick="event.preventDefault(); location.href = '/ad/hijacked'">Next episode</a>`,
  // The very next episode's address in a link into a new tab: followed, in this tab.
  '/nt/episode-7': `<!doctype html><title>episode 7</title>
<a href="/nt/episode-8" target="_blank">Next episode</a>`,
  // No episode: a "next episode" into a new tab to anywhere else, and a pagination only.
  '/nt/teaser': `<!doctype html><title>teaser</title>
<a href="/nt/elsewhere" target="_blank">Next episode</a>`,
  '/de/nur-seite': `<!doctype html><meta charset="utf-8"><title>Liste</title><a href="/de/nur-seite-2">Nächste Seite</a>`,
};

// A page that swaps its video for a copy on every frame, between the browser measuring what is
// visible and handing it over.
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
            // A rejection the browser made (a refused fullscreen request) has no source: kept apart
            // for the case to judge.
            if (message instanceof Ci.nsIScriptError && !message.sourceName &&
                !(message.flags & Ci.nsIScriptError.warningFlag)) {
              win.__fsUnsourcedErrors.push(message.errorMessage);
            }
            if (message instanceof Ci.nsIScriptError &&
                /^moz-extension:\/\/[^/]+\/content\.js/.test(message.sourceName || '') &&
                !(message.flags & Ci.nsIScriptError.warningFlag) &&
                // Firefox's note that a message's answer came after its page had gone
                // (ExtensionCommon's wrapPromise): not content.js's.
                !/^Promise (resolved|rejected) (while context is inactive|after context unloaded)/.test(message.errorMessage || '')) {
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
const clickToolbar = () => clickToolbarIn(siteHandle);

/** @return {Promise<?number>} The site tab's id. */
async function siteTabId() {
  await browser.switchToWindow(extHandle);
  return await browser.execute((site) => new Promise((done) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(site + '/'));
      done(tab ? tab.id : null);
    });
  }), SITE);
}

/** @return {Promise<string>} The site tab's mode, 'on' or 'off'. */
async function tabMode() {
  const tabId = await siteTabId();
  await browser.switchToWindow(extHandle);
  return await browser.execute((tabId) => new Promise((done) => {
    chrome.action.getBadgeText({tabId}, (badge) => done(badge === 'On' ? 'on' : 'off'));
  }), tabId);
}

/**
 * Sends a message to the site tab's top frame, as the background does.
 * @param {Object} message
 * @param {number} [within] - How long to wait for the answer, in ms; 0 for as long as it takes.
 * @return {Promise<*>}
 */
async function sendToPage(message, within = 0) {
  const tabId = await siteTabId();
  await browser.switchToWindow(extHandle);
  return await browser.execute((tabId, message, within) => new Promise((done) => {
    if (within) {
      setTimeout(() => done({error: 'no answer'}), within);
    }
    chrome.tabs.sendMessage(tabId, message, {frameId: 0}, (response) => {
      done(chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : response);
    });
  }), tabId, message, within);
}

/**
 * sendToPage for a message the site tab must be in front for: a background tab runs no animation
 * frames.
 * @param {Object} message
 * @param {number} within
 * @return {Promise<*>}
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
 * @param {Function} fn
 * @param {...*} args
 * @return {Promise<*>}
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
 * @param {string} pathname
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

/**
 * Waits until the page's own video has loaded its whole clip: a request still open keeps the page
 * out of the bfcache.
 */
async function pageMediaIdle() {
  await browser.waitUntil(async () => inPage(() => {
    const video = document.getElementById('main');
    if (!video || video.readyState !== 4 || video.networkState !== 1) return false;
    // NETWORK_IDLE is also a suspended download with its request open; the whole clip buffered is
    // the request done.
    const buffered = video.buffered;
    return buffered.length > 0 && buffered.end(buffered.length - 1) >= video.duration - 0.05;
  }), {timeout: 20000, timeoutMsg: 'the page\'s video never finished loading'});
}

/**
 * Marks the page as the one Back must give back from the bfcache, and keeps pagehide's persisted in
 * sessionStorage.
 */
async function keepForBack() {
  await inPage(() => {
    window.__kept = true;
    sessionStorage.removeItem('fsLeft');
    window.addEventListener('pagehide', (e) => {
      sessionStorage.setItem('fsLeft', JSON.stringify({persisted: e.persisted, at: new Date().toISOString()}));
    });
  });
}

/**
 * Checks that Back gave the page back from the back-forward cache (keepForBack): a load
 * fetches the video anew, and proves nothing.
 * @param {string} backAt
 */
async function expectFromCache(backAt) {
  const state = await inPage(() => ({kept: window.__kept === true, left: sessionStorage.getItem('fsLeft')}));
  if (!state.kept) {
    throw new Error('Back loaded the page again instead of taking it from the back-forward cache: ' +
      `its pagehide ${state.left || 'never came'}, Back at ${backAt}. Firefox's PageCache and ` +
      'SHIPBFCache log, in the driver log, says what kept it out or took it out.');
  }
}

/**
 * Runs a test's way there and back until Back gave the page from the bfcache, three rounds at most.
 * A round repeated is written to logs/retried.jsonl as a spec's retry is (retriedSpecs.mjs),
 * under a suite of its own, so the run's summary and the weekly "Flaky e2e specs" issue show it:
 * a change that keeps the page out of the cache now and then (a request of the player's, #346)
 * must not pass unseen.
 * @param {() => Promise<string>} round
 */
async function untilCached(round) {
  for (let attempt = 1; ; attempt++) {
    const backAt = await round();
    const kept = await inPage(() => window.__kept === true);
    if (attempt > 1) noteRepeatedRound(attempt, kept);
    if (kept || attempt === 3) return expectFromCache(backAt);
    console.log(`      Back at ${backAt} loaded the page again instead of taking it from the cache: round ${attempt + 1}`);
  }
}

/**
 * @param {number} rounds
 * @param {boolean} passed
 */
function noteRepeatedRound(rounds, passed) {
  try {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, {recursive: true});
    fs.appendFileSync(path.join(logs, 'retried.jsonl'), JSON.stringify({
      suite: `classic-${BUILD}-bfcache`, spec: 'tests/e2e/classic-specs/content-cleanup.e2e.mjs',
      attempts: rounds, passed, os: process.platform,
    }) + '\n');
  } catch (e) {
    console.warn(`could not record the repeated round: ${e.message}`);
  }
}

/**
 * What the player in the session's frame was doing, for a wait on it that timed out: source,
 * player, open OPFS calls.
 * @return {Promise<Object>}
 */
async function playerState() {
  return browser.execute(() => new Promise((done) => {
    const state = {source: window.fastStream?.source?.url ?? null, player: !!window.fastStream?.player};
    import('/player/network/OPFSManager.mjs').then(({OPFSManager}) => {
      state.opfs = [...OPFSManager.live].map((m) => ({session: m.sessionName, pending: m.pendingCalls()}));
    }, (e) => {
      state.opfs = 'unreadable: ' + e.message;
    }).finally(() => done(state));
  }));
}

/**
 * Waits for the soft replace of the /cleanup page's video to turn hard; a timeout says what the
 * replace left.
 */
async function waitForHardReplace() {
  try {
    await browser.waitUntil(async () => inPage(() => !document.contains(window.wrap)), {timeout: 10000});
  } catch (e) {
    const state = await inPage(() => {
      const box = (el) => {
        if (!el) return null;
        const {width, height} = el.getBoundingClientRect();
        return `${Math.round(width)}x${Math.round(height)}`;
      };
      const name = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.dataset?.test ? `[data-test=${el.dataset.test}]` : '') : null;
      const iframe = window.playerIframe();
      return {
        linked: window.__playerAnnounced === true, wrapInPage: document.contains(window.wrap), wrap: box(window.wrap),
        // What hideSoft hid: width and height 0 in its style.
        softHidden: Array.from(document.querySelectorAll('[style]'))
            .filter((el) => el.style.width === '0px' && el.style.height === '0px').map(name),
        iframe: box(iframe), iframeParent: name(iframe?.parentElement),
      };
    });
    throw new Error(`the soft replace never turned hard: ${JSON.stringify(state)}`);
  }
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
 * @param {Array<string>} ids
 * @return {Promise<Object<string, boolean>>}
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
      } else if (Object.hasOwn(DETECTION_PAGES, pathname)) {
        res.end(DETECTION_PAGES[pathname]);
      } else if (pathname.startsWith('/swap')) {
        res.end(swapPage(t));
      } else if (pathname.startsWith('/fakeplay')) {
        res.end(fakePlayPage(t));
      } else if (pathname.startsWith('/shadow')) {
        res.end(shadowPage(t));
      } else {
        // The same page whatever was asked: a server that echoes its request is reflected XSS to
        // CodeQL.
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
    // Firefox's bfcache log (SHIPBFCache at Debug) into the driver log, for the Back cases; set as
    // prefs it works on Linux too.
    await inChrome((done) => {
      Services.prefs.setBoolPref('logging.config.add_timestamp', true);
      Services.prefs.setIntPref('logging.PageCache', 5);
      Services.prefs.setIntPref('logging.SHIPBFCache', 4);
      done(true);
    });
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

  it('keeps the page\'s media paused while the player is up, and gives the page its video, styles and id back after', async function() {
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => {
      window.addNested();
      window.addAudio();
      window.addShadowHost();
    });
    await browser.pause(2000);
    // a re-render one level down
    expect(await inPage(() => ({
      nested: document.getElementById('nested').paused,
      sfx: document.getElementById('sfx').paused,
    }))).toEqual({nested: true, sfx: true});
    // into an added element's own shadow root
    expect(await inPage(() => {
      const video = document.getElementById('host').shadowRoot.getElementById('shadowed');
      return {paused: video.paused, played: video.currentTime > 0.5};
    })).toEqual({paused: true, played: false});

    await inPage(() => window.leave());
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the player up'});
    // the page's transition and the element's id come back, so the page's #wrap rule sizes it again
    expect(await inPage(() => ({
      id: window.wrap.id,
      transition: window.wrap.style.transition,
      width: window.wrap.getBoundingClientRect().width,
    }))).toEqual({id: 'wrap', transition: 'opacity 0.25s', width: 640});
    // the <audio> loses its pause-on-play hook
    expect(await playingAfterPlay(['main', 'nested', 'sfx'])).toEqual({main: true, nested: true, sfx: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  // "Reload Frame" on the player: the page's video goes to the reloaded player too, and the element
  // comes back after.
  it('keeps the video, and the page\'s element, over a reload of the player\'s frame', async function() {
    await openPage('/cleanup');
    await openPlayer();
    // What Reload Frame does: the player's page loads again in the same frame.
    await inPage(() => {
      window.__playerAnnounced = false;
      const iframe = window.playerIframe();
      iframe.src = iframe.src;
    });
    await browser.waitUntil(async () => inPage(() => window.__playerAnnounced === true),
        {timeout: 15000, timeoutMsg: 'the reloaded player never announced itself'});
    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    let source;
    try {
      await browser.waitUntil(async () => {
        source = await browser.execute(() => window.fastStream?.source?.url || null);
        return !!source;
      }, {timeout: 15000, interval: 250, timeoutMsg: 'the reloaded player never got a source'});
    } finally {
      await browser.switchFrame(null);
    }
    expect(source).toContain('/clip.mp4?main=');

    await inPage(() => window.leave());
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the player up'});
    expect(await inPage(() => ({
      id: window.wrap.id,
      width: window.wrap.getBoundingClientRect().width,
    }))).toEqual({id: 'wrap', width: 640});
    expect(await playingAfterPlay(['main'])).toEqual({main: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('keeps the player in the box the page\'s #id rule gives its element, and copes with a page that removes it', async function() {
    await openPage('/cleanup');
    await openPlayer();
    // The soft replace measures the element with the id it handed over, so the #wrap rule keeps
    // sizing it.
    await browser.pause(2500);
    expect(await inPage(() => {
      const r = window.playerIframe().getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map(Math.round);
    })).toEqual([0, 0, 640, 360]);

    // The page takes the player out itself: its element and video must come back.
    await inPage(() => window.playerIframe().remove());
    await browser.pause(500);
    expect(await inPage(() => ({
      id: window.wrap.id,
      width: window.wrap.getBoundingClientRect().width,
    }))).toEqual({id: 'wrap', width: 640});
    expect(await playingAfterPlay(['main'])).toEqual({main: true});
    // Each resize threw on the missing iframe.
    await nudgeWindowSize();
    await inPage(() => window.leave());
    await browser.pause(1500);
    // The cleanup threw on the missing iframe, and the page's video stayed paused for good.
    expect(await playingAfterPlay(['main'])).toEqual({main: true});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('opens a player for the next video after the page removed the player itself', async function() {
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => window.playerIframe().remove());
    // The page's next video is not taken for the gone player's own: a player opens for it.
    await inPage(() => window.addVideo());
    await browser.waitUntil(hasPlayer, {
      timeout: 15000,
      timeoutMsg: 'no player opened for the video the page added after it removed the player',
    });
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
    // The placeholder holds the wrapper's id: the element is measured without taking the page's
    // #col rule.
    expect(await inPage(() => {
      const placeholder = document.getElementById('col');
      const r = placeholder.getBoundingClientRect();
      return {placeholder: placeholder !== window.col, size: [r.width, r.height].map(Math.round)};
    })).toEqual({placeholder: true, size: [640, 390]});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('measures a hard-replaced element without putting it back into the page, and copes with a page that removes it', async function() {
    // Measuring must not put the element back into the page (its observers, an autoplay video): a
    // stand-in is measured.
    await openPage('/cleanup');
    await inPage(() => window.shrinkWhenReplaced());
    await openPlayer();
    await waitForHardReplace();
    await browser.pause(1000);
    await inPage(() => {
      window.__wrapInserted = 0;
      new MutationObserver((records) => {
        for (const record of records) {
          if (Array.from(record.addedNodes).includes(window.wrap)) window.__wrapInserted++;
        }
      }).observe(document.body, {childList: true, subtree: true});
    });
    await nudgeWindowSize();
    await nudgeWindowSize();
    expect(await inPage(() => ({
      inserted: window.__wrapInserted,
      inPage: document.contains(window.wrap),
      // The player still takes the element's box (100 px at the least, as it always did).
      size: (() => {
        const r = window.playerIframe().getBoundingClientRect();
        return [r.width, r.height].map(Math.round);
      })(),
      id: window.playerIframe().id,
    }))).toEqual({inserted: 0, inPage: false, size: [100, 100], id: 'wrap'});

    // The page takes the hard-replaced player out: resizes and the cleanup must cope.
    await inPage(() => window.playerIframe().remove());
    await nudgeWindowSize();
    await inPage(() => window.leave());
    await browser.pause(1500);
    expect(await takeContentErrors()).toEqual([]);
  });

  // A player taken out before it linked up: the element and video come back, and a player opens for
  // the next video.
  it('gives the page its video back when it removed a player still loading, and opens a player for the next video', async function() {
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

    await inPage(() => window.addVideo());
    await browser.waitUntil(hasPlayer, {
      timeout: 15000,
      timeoutMsg: 'no player opened for the video the page added after it removed a player still loading',
    });
    expect(await takeContentErrors()).toEqual([]);
  });

  // The same as the case above for a player laid over the whole page, which hides
  // everything else on it.
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

  // A video swapped out after getVideo()'s measuring is still reported visible: its size, read
  // again, keeps the player out.
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

  // Anything that throws while the player goes in must still answer OPEN_PLAYER, or no player opens
  // there again.
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

  // An iframe in a closed shadow root: the document's fullscreenElement is the root's host. Firefox
  // wants no click here.
  it('leaves fullscreen of an iframe in a closed shadow root on the toggle', async function() {
    await openPage('/cleanup');
    await inChrome((done) => {
      Services.prefs.setBoolPref('full-screen-api.allow-trusted-requests-only', false);
      done(true);
    });
    try {
      await inPage(() => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const iframe = document.createElement('iframe');
        // It posts back what it is sent, as a player posts its link key to its parent.
        iframe.srcdoc = '<script>addEventListener("message", (e) => parent.postMessage(e.data, "*"));</' + 'script>';
        host.attachShadow({mode: 'closed'}).appendChild(iframe);
        window.__shadowed = {host, iframe};
      });
      await browser.waitUntil(async () => inPage(() => window.__shadowed.iframe.contentDocument?.readyState === 'complete'),
          {timeout: 10000, timeoutMsg: 'the iframe in the shadow root never loaded'});
      expect(await sendToPage({type: 'FRAME_LINK_RECEIVER', key: 'fs-shadow-link', frameId: 424244})).toBe('ok');
      await inPage(() => window.__shadowed.iframe.contentWindow.postMessage('fs-shadow-link', '*'));
      await browser.pause(300);
      // Fullscreen is refused to a background tab: the toggles go out on timers while the site's
      // tab stays in front.
      await inPage(() => {
        window.__fullscreenSeen = [];
        document.addEventListener('fullscreenchange', () => {
          const element = document.fullscreenElement;
          window.__fullscreenSeen.push(element === window.__shadowed.host ? 'host' : element ? element.tagName : null);
        });
      });
      const tabId = await siteTabId();
      await browser.switchToWindow(extHandle);
      await browser.execute((tabId, message) => {
        window.__answers = [];
        const send = () => chrome.tabs.sendMessage(tabId, message, {frameId: 0}, (response) => {
          window.__answers.push(chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : response);
        });
        // A timer in a background tab may come up to a second late.
        setTimeout(send, 1000);
        setTimeout(send, 4000);
      }, tabId, {type: 'TOGGLE_FULLSCREEN', frameId: 424244});
      await browser.switchToWindow(siteHandle);
      await browser.waitUntil(async () => (await browser.execute(() => window.__fullscreenSeen.length)) >= 2,
          {timeout: 8000, interval: 200}).catch(() => {});
      const seen = await browser.execute(() => window.__fullscreenSeen);
      await browser.switchToWindow(extHandle);
      const answers = await browser.execute(() => window.__answers);
      // entered on the first, left on the second
      expect({answers, seen}).toEqual({answers: ['enter', 'exit'], seen: ['host', null]});
      expect(await takeContentErrors()).toEqual([]);
    } finally {
      await inPage(() => document.fullscreenElement && document.exitFullscreen());
      await inChrome((done) => {
        Services.prefs.clearUserPref('full-screen-api.allow-trusted-requests-only');
        done(true);
      });
    }
  });

  it('removes a player that overlays the whole page, and opens a player for the next video after that navigation', async function() {
    await openPage('/full');
    await openPlayer();
    await inPage(() => window.leave());
    // the overlay must not stay on top of the restored page
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 15000, timeoutMsg: 'leaving the page left the overlay player up'});
    expect(await playingAfterPlay(['main'])).toEqual({main: true});

    await inPage(() => window.addVideo());
    await browser.waitUntil(hasPlayer, {
      timeout: 15000,
      timeoutMsg: 'no player opened for the video the page added after the navigation',
    });
    expect(await takeContentErrors()).toEqual([]);
  });

  // Back to a page in the bfcache: the toolbar's On must open a player for the video detected
  // there.
  it('opens the player on a page Back brought out of the back-forward cache', async function() {
    await untilCached(async () => {
      await openPage('/cleanup');
      await keepForBack();
      await pageMediaIdle();
      await openPage('/wrapper');
      const backAt = new Date().toISOString();
      await browser.back();
      await browser.waitUntil(async () => inPage(() => location.pathname === '/cleanup'),
          {timeout: 10000, timeoutMsg: 'Back never reached the first page'});
      return backAt;
    });
    await openPlayer();
    await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
    let source;
    try {
      await browser.waitUntil(async () => {
        source = await browser.execute(() => window.fastStream?.source?.url || null);
        return !!source;
      }, {timeout: 15000, interval: 250});
    } catch (e) {
      throw new Error(`the player never got a source: ${JSON.stringify(await playerState())}`);
    } finally {
      await browser.switchFrame(null);
    }
    expect(source).toContain('/clip.mp4?main=');
    expect(await takeContentErrors()).toEqual([]);
  });

  // The same from another site: the background resets the tab on a new hostname, maybe after the
  // page named itself again.
  it('opens the player on a page Back brought back from another site', async function() {
    await untilCached(async () => {
      await openPage('/cleanup');
      await keepForBack();
      await pageMediaIdle();
      // localhost is another hostname for the same server.
      await browser.url(`http://localhost:${SITE_PORT}/wrapper?t=${Date.now()}`);
      await browser.waitUntil(async () => inPage(() => location.hostname === 'localhost' &&
          document.querySelector('video')?.readyState >= 2), {timeout: 20000, timeoutMsg: 'the other site never loaded'});
      const backAt = new Date().toISOString();
      await browser.back();
      await browser.waitUntil(async () => inPage(() => location.pathname === '/cleanup'),
          {timeout: 10000, timeoutMsg: 'Back never reached the first page'});
      return backAt;
    });
    await openPlayer();
    expect(await takeContentErrors()).toEqual([]);
  });

  it('takes down the player a page brings back from the back-forward cache', async function() {
    // Firefox caches a page with its in-page player up; after Back, REMOVE_PLAYERS takes it down
    // and the page has its video.
    await untilCached(async () => {
      await openPage('/cleanup');
      await openPlayer();
      // A request still open keeps the page out of the cache; keepForBack says whether it was never
      // cached or dropped.
      await keepForBack();
      await pageMediaIdle();
      await inPage(() => {
        window.__cachedWithPlayer = null;
        window.addEventListener('pageshow', (e) => {
          window.__cachedWithPlayer = e.persisted && !!window.playerIframe();
        });
        // A script's navigation: WebDriver's click leaves a listener that keeps a page out of the
        // cache.
        location.href = '/other?x=' + Date.now();
      });
      await browser.waitUntil(async () => inPage(() => location.pathname === '/other'),
          {timeout: 10000, timeoutMsg: 'the other page never loaded'});
      const backAt = new Date().toISOString();
      await browser.back();
      await browser.waitUntil(async () => inPage(() => location.pathname === '/cleanup'),
          {timeout: 10000, timeoutMsg: 'Back never reached the first page'});
      return backAt;
    });
    expect(await inPage(() => ({kept: window.__kept === true, withPlayer: window.__cachedWithPlayer})))
        .toEqual({kept: true, withPlayer: true});
    await browser.waitUntil(async () => !(await hasPlayer()),
        {timeout: 10000, timeoutMsg: 'the player the cache gave back stayed up'});
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
    // the tab never navigated: the player stays
    expect(await hasPlayer()).toBe(true);
    expect(await takeContentErrors()).toEqual([]);
  });

  it('keeps the player for a link to another page that the page handles itself', async function() {
    // A "Sign in" that opens a dialog: the page cancels the click, and the player stays.
    await openPage('/cleanup');
    await openPlayer();
    await inPage(() => {
      const a = document.createElement('a');
      a.id = 'pagehandled';
      a.href = '/login';
      a.textContent = 'sign in';
      a.addEventListener('click', (e) => e.preventDefault());
      document.body.appendChild(a);
    });
    await browser.$('#pagehandled').click();
    await browser.pause(1000);
    expect(await inPage(() => location.pathname)).toBe('/cleanup');
    expect(await hasPlayer()).toBe(true);
    expect(await takeContentErrors()).toEqual([]);
  });

  it('finds the next episode past a list whose next entry has no link', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/episodes/ep2`);
    await browser.pause(500);
    // the first list's next entry has no link: the search goes on to the next list
    expect(await sendToPage({type: 'PLAYLIST_POLL'})).toEqual({next: true, previous: true, seriesEnd: false});
    expect(await sendToPage({type: 'PLAYLIST_NAVIGATION', direction: 'next'})).toBe('clicked');
    await browser.waitUntil(async () => (await inPage(() => location.pathname)) === '/episodes/ep3',
        {timeout: 10000, timeoutMsg: 'the next-episode link was not ep3'});
    expect(await takeContentErrors()).toEqual([]);
  });

  it('finds the next episode by its address, its words in any language, or a button, and follows its address', async function() {
    const cases = [
      ['/serie/x/staffel-1/episode-4', 'next', '/serie/x/staffel-1/episode-5'],
      ['/serie/x/staffel-1/episode-4', 'previous', '/serie/x/staffel-1/episode-3'],
      ['/de/folge-a', 'next', '/de/naechste'],
      ['/btn/ep', 'next', '/btn/ep-next'],
      // Its click handler would have gone to /ad/hijacked.
      ['/ad/episode-1', 'next', '/ad/episode-2'],
      // Into a new tab, the very next episode's address: in this tab.
      ['/nt/episode-7', 'next', '/nt/episode-8'],
    ];
    for (const [page, direction, to] of cases) {
      await browser.switchToWindow(siteHandle);
      await browser.url(`${SITE}${page}`);
      await browser.pause(500);
      expect({page, direction, answer: await sendToPage({type: 'PLAYLIST_NAVIGATION', direction})})
          .toEqual({page, direction, answer: 'clicked'});
      await browser.waitUntil(async () => (await inPage(() => location.pathname)) === to,
          {timeout: 10000, timeoutMsg: `${page} ${direction} did not go to ${to}`});
    }
    for (const page of ['/nt/teaser', '/de/nur-seite']) {
      await browser.switchToWindow(siteHandle);
      await browser.url(`${SITE}${page}`);
      await browser.pause(500);
      expect({page, poll: await sendToPage({type: 'PLAYLIST_POLL'})})
          .toEqual({page, poll: {next: false, previous: false, seriesEnd: false}});
    }
    expect(await takeContentErrors()).toEqual([]);
  });

  it('follows no next-episode link to another site', async function() {
    for (const pathname of Object.keys(AD_EPISODE_PAGES)) {
      await browser.switchToWindow(siteHandle);
      await browser.url(`${SITE}${pathname}`);
      await browser.pause(500);
      // the list's next entry on another site is not taken
      expect({pathname, poll: await sendToPage({type: 'PLAYLIST_POLL'})})
          .toEqual({pathname, poll: {next: false, previous: true, seriesEnd: false}});
      expect(await sendToPage({type: 'PLAYLIST_NAVIGATION', direction: 'next'})).toBe('no_button');
    }
    expect(await takeContentErrors()).toEqual([]);
  });

  // The shortcut sends the video the user started: a 'play' the page made up does not count.
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
