// The toggle_mpv keyboard shortcut (Ctrl+Shift+U) turns MPV on and off for a
// tab by a real key press, on a site that is not on the MPV Allowlist, and
// then hands over only a video the user starts: never one the page autoplays
// (the muted preview here) or merely preloads (the main video, until its play
// button is clicked). With Ctrl+Shift+F, the in-page player's own key, it
// switches straight between MPV and the player.
//
// Firefox lets an extension's suggested key win over nothing: a combination
// Firefox itself binds is refused on about:addons' shortcuts page ("already
// used by Firefox") and is unreliable at best. Ctrl+Shift+M, the obvious one
// for MPV, is Responsive Design Mode. So the first test pins the chosen key
// against Firefox's own check, the one that page uses, and fails if a later
// Firefox claims it.
//
// The mode switches need no mpv; the checks that mpv really fetched the
// stream skip, not fail, when the native host is not installed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {loopedPlaylist} from '../loopedPlaylist.mjs';
import {closeSpecMpv, hostInstalled, hostLogSince} from '../mpvTestProcesses.mjs';
import {EXTENSION_ID, EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');
const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

const SITE_PORT = 41988;
const CDN_PORT = 41989;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;

// Only mpv's HTTP client sends this header; see mpv.e2e.mjs.
const isMpvRequest = (r) => 'icy-metadata' in r.headers;

let siteServer;
let cdnServer;
const requests = [];
let extHandle;
let siteHandle;

const HAVE_HOST = hostInstalled();

// When the running test started (Date.now()), for what a failed one prints.
let testStart = 0;

// How many of mpv's requests the preview check has looked at. Each is checked once, so a
// request for the preview fails the test that first sees it, not every test after it.
let mpvChecked = 0;

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

/**
 * Presses Ctrl+Shift+U (or Ctrl+Shift+F, the in-page player's key) with the site
 * page focused, as a user would.
 *
 * browser.keys() is no good here: WebDriver synthesizes its key events inside
 * the page's content process, where Firefox's window-level shortcuts - the
 * extension's commands among them - never see them. A TextInputProcessor
 * started on the browser window feeds keys in at the widget, the way a
 * physical keyboard does, so they reach the page first and Firefox's
 * shortcuts after (the path Firefox's own shortcut tests use).
 *
 * Returns only once the extension's key has fired. The key goes through the
 * page's process before Firefox acts on it, and Firefox hands the command
 * whichever tab is active at that moment; with focus inside the player
 * iframe that round trip is slow enough for the next step here (switching to
 * the extension's tab to read the icon) to win the race, and the command then
 * lands on the wrong tab.
 *
 * @param {string} [letter] - 'U' or 'F'.
 */
async function pressShortcut(letter = 'U') {
  await browser.switchToWindow(siteHandle);
  const result = await inChrome((extId, letter, done) => {
    try {
      const {ExtensionCommon} = ChromeUtils.importESModule(
          'resource://gre/modules/ExtensionCommon.sys.mjs');
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const keysetId = 'ext-keyset-id-' + ExtensionCommon.makeWidgetId(extId);
      const keyEl = win.document.querySelector(`keyset[id="${keysetId}"] key[key="${letter}"]`);
      if (!keyEl) {
        done({err: `the extension has no Ctrl+Shift+${letter} key`});
        return;
      }
      const timer = win.setTimeout(() => {
        keyEl.removeEventListener('command', onCommand);
        done({err: 'the key press never reached the shortcut'});
      }, 5000);
      const onCommand = () => {
        win.clearTimeout(timer);
        keyEl.removeEventListener('command', onCommand);
        done({ok: true});
      };
      keyEl.addEventListener('command', onCommand);

      const tip = Cc['@mozilla.org/text-input-processor;1']
          .createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(win)) {
        done({err: 'no input transaction'});
        return;
      }
      const KE = win.KeyboardEvent;
      const ctrl = new KE('', {key: 'Control', code: 'ControlLeft', keyCode: KE.DOM_VK_CONTROL});
      const shift = new KE('', {key: 'Shift', code: 'ShiftLeft', keyCode: KE.DOM_VK_SHIFT});
      const key = new KE('', {key: letter, code: 'Key' + letter, keyCode: KE['DOM_VK_' + letter]});
      tip.keydown(ctrl);
      tip.keydown(shift);
      tip.keydown(key);
      tip.keyup(key);
      tip.keyup(shift);
      tip.keyup(ctrl);
    } catch (e) {
      done({err: String(e)});
    }
  }, EXTENSION_ID, letter);
  if (!result || !result.ok) {
    throw new Error(`could not press Ctrl+Shift+${letter}: ` + JSON.stringify(result));
  }
}

/** Clicks the extension's toolbar button for the focused window. */
async function clickToolbar() {
  await browser.switchToWindow(siteHandle);
  const result = await inChrome((extId, done) => {
    (async () => {
      try {
        const {ExtensionParent} = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionParent.sys.mjs');
        const extension = WebExtensionPolicy.getByID(extId).extension;
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const action = ExtensionParent.apiManager.global.browserActionFor(extension);
        await action.triggerAction(win);
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

/**
 * Reads the site tab's mode off its toolbar button.
 * @param {string} [prefix] - Start of the tab's URL, when not a site page.
 * @return {Promise<string>} 'mpv', 'on' or 'off'.
 */
async function tabMode(prefix = SITE + '/') {
  const tabId = await tabIdOf(prefix);
  return tabId === null ? 'no site tab' : await modeOfTab(tabId);
}

/**
 * @param {string} prefix - Start of the tab's URL.
 * @return {Promise<?number>} The id of the first tab whose URL starts so.
 */
async function tabIdOf(prefix) {
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((site, done) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(site));
      done(tab ? tab.id : null);
    });
  }, prefix);
}

/**
 * Reads a tab's mode off its toolbar button.
 * @param {number} tabId - The tab.
 * @return {Promise<string>} 'mpv', 'on' or 'off'.
 */
async function modeOfTab(tabId) {
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((tabId, done) => {
    chrome.action.getTitle({tabId}, (title) => {
      chrome.action.getBadgeText({tabId}, (badge) => {
        if (title.includes('MPV')) done('mpv');
        else if (badge === 'On') done('on');
        else done('off');
      });
    });
  }, tabId);
}

/**
 * @param {number} tabId - The tab.
 * @return {Promise<string>} Its URL.
 */
async function urlOfTab(tabId) {
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((tabId, done) => {
    chrome.tabs.get(tabId, (tab) => done(tab.url || ''));
  }, tabId);
}

/**
 * Waits until the site tab shows the expected mode.
 * @param {string} expected - 'mpv', 'on' or 'off'.
 * @param {string} when - What just happened, for the failure message.
 * @param {string} [prefix] - Start of the tab's URL, when not a site page.
 */
async function expectMode(expected, when, prefix) {
  let last;
  try {
    await browser.waitUntil(async () => {
      try {
        last = await tabMode(prefix);
      } catch (e) {
        last = String(e);
      }
      return last === expected;
    }, {timeout: 15000, interval: 250});
  } catch (e) {
    throw new Error(`${when}: expected the tab to be '${expected}', it is '${last}'`);
  }
}

/**
 * Whether the site page currently has FastStream's overlay iframe in place
 * of its native <video>.
 * @return {Promise<boolean>}
 */
async function hasOverlayPlayer() {
  await browser.switchToWindow(siteHandle);
  return await browser.execute(() => {
    return Array.from(document.querySelectorAll('iframe'))
        .some((f) => f.src.includes('player/index.html'));
  });
}

/**
 * @param {number} ms - A Date.now().
 * @return {string} Its time of day in UTC, as CI's log and the mpv host's log print it.
 */
function clock(ms) {
  return new Date(ms).toISOString().slice(11, 23);
}

/**
 * @param {number} [since] - A Date.now() to list from; every request without it.
 * @return {string} The CDN's requests, marked mpv or browser, with the time each came.
 */
function seenRequests(since = 0) {
  return JSON.stringify(requests.filter((r) => r.at >= since)
      .map((r) => `${isMpvRequest(r) ? 'mpv' : 'browser'} ${r.url} at ${clock(r.at)}`));
}

/** @return {number} How many requests mpv has made so far. */
function mpvCount() {
  return requests.filter(isMpvRequest).length;
}

/**
 * Waits for mpv to request the main video, beyond the first `before` requests
 * mpv had made, and checks it never asked for the preview.
 * @param {number} before - mpvCount() before the play.
 * @param {string} when - What just happened, for the failure message.
 */
async function expectMainInMpv(before, when) {
  await browser.waitUntil(
      async () => requests.filter(isMpvRequest).slice(before)
          .some((r) => r.url.startsWith('/clip.mp4')), {
        timeout: 45000,
        interval: 500,
        timeoutMsg: `${when}: mpv never requested the main video. Seen: ${seenRequests()}`,
      });
  const unchecked = requests.filter(isMpvRequest).slice(mpvChecked);
  mpvChecked += unchecked.length;
  if (unchecked.some((r) => r.url.startsWith('/preview.mp4'))) {
    // From this test's start, or earlier: a request that came after the last test's
    // check is this test's to report.
    const from = Math.min(testStart, ...unchecked.map((r) => r.at));
    throw new Error(`${when}: mpv also requested the preview, which the page autoplays. ` +
      `Seen from ${clock(from)}: ${seenRequests(from)}`);
  }
}

/**
 * Checks mpv is left alone for a while.
 * @param {string} when - What just happened, for the failure message.
 */
async function expectNothingInMpv(when) {
  const before = mpvCount();
  await browser.pause(4000);
  if (mpvCount() !== before) {
    throw new Error(`${when}: mpv requested a video nobody started. Seen: ${seenRequests()}`);
  }
}

/**
 * Waits for the page to request both of its videos.
 * @param {number} since - requests.length when the page was opened.
 */
async function pageVideosLoaded(since) {
  await browser.waitUntil(async () => {
    const own = requests.slice(since).filter((r) => !isMpvRequest(r));
    return own.some((r) => r.url.startsWith('/clip.mp4')) &&
      own.some((r) => r.url.startsWith('/preview.mp4'));
  }, {
    timeout: 15000,
    interval: 250,
    timeoutMsg: 'the page never requested its videos: ' + seenRequests(),
  });
}

/** Clicks the page's play button for the main video, as a user would. */
async function clickPlay() {
  await browser.switchToWindow(siteHandle);
  await browser.$('#play').click();
}

/**
 * Whether the page's main video is playing.
 * @return {Promise<boolean>}
 */
async function mainPlaying() {
  await browser.switchToWindow(siteHandle);
  return await browser.execute(() => {
    const main = document.getElementById('main');
    return !!main && !main.paused;
  });
}

/**
 * Saves FastStream's options and has the background load them.
 * @param {Object} options - The whole options object to store.
 */
async function setOptions(options) {
  await browser.switchToWindow(extHandle);
  await browser.executeAsync((json, done) => {
    chrome.storage.local.set({options: json}, () => {
      chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
        void chrome.runtime.lastError;
        done(true);
      });
    });
  }, JSON.stringify(options));
  await browser.pause(500);
}

/**
 * Puts a new tab in the site tab's place. A tab's mode, its MPV arm and its player belong
 * to the tab, so the new one starts Off with nothing pending, whatever a failed test left
 * in the old one.
 */
async function replaceSiteTab() {
  const old = siteHandle;
  const handles = await browser.getWindowHandles();
  await browser.switchToWindow(extHandle);
  await browser.execute((u) => window.open(u, '_blank'), OPENER_URL);
  await browser.waitUntil(async () => (await browser.getWindowHandles()).length > handles.length, {
    timeout: 10000,
    timeoutMsg: 'no new tab opened',
  });
  const fresh = (await browser.getWindowHandles()).find((h) => !handles.includes(h));
  if (!fresh) {
    throw new Error('the new tab closed at once');
  }
  await browser.switchToWindow(old);
  await browser.closeWindow();
  siteHandle = fresh;
  await browser.switchToWindow(siteHandle);
}

describe('The MPV keyboard shortcut (Ctrl+Shift+U)', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));

    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
      if (req.url.startsWith('/mse')) {
        // An MSE player: its video plays a blob:, and it fetched the film's manifest,
        // then an ad's - the newest of the page's streams, and the short one. Well after:
        // two found within the same millisecond tie for the newest.
        res.end(`<!doctype html><title>mpv shortcut test, MSE</title>
          <video id="main" style="width: 640px; height: 360px"></video>
          <button id="play">Play</button>
          <script>
            const t = Date.now();
            document.getElementById('main').src = URL.createObjectURL(new MediaSource());
            fetch('${CDN}/film.m3u8?t=' + t).then(() => setTimeout(() => fetch('${CDN}/ad.m3u8?t=' + t), 300));
            document.getElementById('play').addEventListener('click', () => {
              document.getElementById('main').play().catch(() => {});
            });
          </script>`);
        return;
      }
      // A muted preview that autoplays, and the main video: preloaded, played
      // only by its button. Both cache-busted: switching an in-page player to
      // mpv reloads this page, and a cached response gives no webRequest
      // event to redetect a stream by - see mpv-suspend.e2e.mjs.
      res.end(`<!doctype html><title>mpv shortcut test</title>
        <video id="preview" muted loop crossorigin="anonymous"></video>
        <video id="main" preload="auto" crossorigin="anonymous"></video>
        <button id="play">Play</button>
        <script>
          setTimeout(() => {
            const t = Date.now();
            const preview = document.getElementById('preview');
            preview.src = '${CDN}/preview.mp4?t=' + t;
            preview.play().catch(() => {});
            const main = document.getElementById('main');
            main.src = '${CDN}/clip.mp4?t=' + t;
            main.load();
          }, 1500);
          document.getElementById('play').addEventListener('click', () => {
            document.getElementById('main').play().catch(() => {});
          });
        </script>`);
    });

    // The MSE page's streams: a half-hour film and a 9-second ad, from the hls-ts
    // fixture's segments.
    const segmentDir = path.join(root, 'tests/e2e/fixtures/hls-ts');
    const segments = new Map(fs.readdirSync(segmentDir).filter((name) => name.endsWith('.ts'))
        .map((name) => [`/seg/${name}`, fs.readFileSync(path.join(segmentDir, name))]));
    const playlists = {'/film.m3u8': loopedPlaylist(1800, '/seg/'), '/ad.m3u8': loopedPlaylist(9, '/seg/')};

    cdnServer = http.createServer((req, res) => {
      requests.push({url: req.url, headers: req.headers, at: Date.now()});
      const pathname = req.url.split('?')[0];
      if (playlists[pathname] || segments.has(pathname)) {
        res.writeHead(200, {
          'Content-Type': playlists[pathname] ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(playlists[pathname] || segments.get(pathname));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(clip.length),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(req.method === 'HEAD' ? undefined : clip);
    });

    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      cdnServer.on('error', reject);
      cdnServer.listen(CDN_PORT, '127.0.0.1', resolve);
    });

    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'),
        ORIGIN + '/player/index.html');
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

    // MPV mode on, allowlist empty: nothing here auto-starts MPV, so every
    // switch below is the shortcut's doing.
    await browser.executeAsync((done) => {
      chrome.storage.local.set({
        options: JSON.stringify({mpvMode: true, mpvAllowlist: []}),
      }, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          done(true);
        });
      });
    });
    await browser.pause(1000);

    siteHandle = (await browser.getWindowHandles()).find((h) => h !== extHandle);
  });

  after(async function() {
    if (siteServer) await new Promise((r) => siteServer.close(r));
    if (cdnServer) await new Promise((r) => cdnServer.close(r));
    closeSpecMpv([SITE, CDN]);
  });

  beforeEach(function() {
    testStart = Date.now();
  });

  // A failed test left the tab in the mode it stopped in, and every test after it then
  // failed at its first mode check, hiding which failure was real. Now the failed test's
  // evidence is printed, what the CDN and the mpv host saw during it, and the next test
  // gets a new tab.
  afterEach(async function() {
    // eslint-disable-next-line no-invalid-this
    const test = this.currentTest;
    if (test.state !== 'failed') {
      return;
    }
    console.log(`"${test.title}" failed. The CDN saw, from ${clock(testStart)}: ` +
      seenRequests(testStart));
    const hostLog = hostLogSince(testStart);
    console.log(hostLog.length ? `The mpv host logged:\n${hostLog.join('\n')}` :
      'The mpv host logged nothing (no host installed, or its debug log is off).');
    try {
      await replaceSiteTab();
    } catch (e) {
      // The tests after this one then start in whatever mode it left.
      console.log(`Could not replace the site tab: ${e.message}`);
    }
  });

  it('is a key Firefox leaves free, and is bound to the extension', async function() {
    const result = await inChrome((extId, done) => {
      try {
        const {ShortcutUtils} = ChromeUtils.importESModule(
            'resource://gre/modules/ShortcutUtils.sys.mjs');
        const {ExtensionCommon} = ChromeUtils.importESModule(
            'resource://gre/modules/ExtensionCommon.sys.mjs');
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        // ExtensionShortcuts.sys.mjs names each add-on's keyset this way.
        const keysetId = 'ext-keyset-id-' + ExtensionCommon.makeWidgetId(extId);
        const bound = Array.from(win.document.querySelectorAll(
            `keyset[id="${keysetId}"] key[modifiers="accel,shift"]`))
            .map((k) => (k.getAttribute('key') || '').toUpperCase());
        done({
          // The same check about:addons' shortcuts page runs before it lets
          // a user pick a combination.
          uIsFirefox: !!ShortcutUtils.isSystem(win, 'Ctrl+Shift+U'),
          fIsFirefox: !!ShortcutUtils.isSystem(win, 'Ctrl+Shift+F'),
          // Control: proves the check sees Firefox's keys at all.
          aIsFirefox: !!ShortcutUtils.isSystem(win, 'Ctrl+Shift+A'),
          bound,
        });
      } catch (e) {
        done({err: String(e)});
      }
    }, EXTENSION_ID);
    expect(result.err).toBeUndefined();
    expect(result.aIsFirefox).toBe(true);
    expect(result.uIsFirefox).toBe(false);
    expect(result.fIsFirefox).toBe(false);
    expect(result.bound.sort()).toEqual(['F', 'U']);
  });

  it('on a site not on the allowlist, sends only the video the user starts', async function() {
    await browser.switchToWindow(siteHandle);
    const since = requests.length;
    await browser.url(`${SITE}/watch`);
    await pageVideosLoaded(since);
    await expectMode('off', 'visiting a site that is not on the allowlist');

    await pressShortcut();
    await expectMode('mpv', 'pressing Ctrl+Shift+U with FastStream off');
    await expectNothingInMpv('switching MPV on with a preview playing and the main video preloaded');

    const before = mpvCount();
    await clickPlay();
    if (HAVE_HOST) {
      await expectMainInMpv(before, 'clicking play on the main video');
      // The page's own copy is paused once mpv has it.
      await browser.waitUntil(async () => !(await mainPlaying()), {
        timeout: 15000,
        timeoutMsg: 'the page kept playing the video mpv opened',
      });
    }
    expect(await hasOverlayPlayer()).toBe(false);

    // MPV -> Off: no overlay, and no further mpv launch off the key itself.
    await pressShortcut();
    await expectMode('off', 'pressing Ctrl+Shift+U in MPV mode');
    await expectNothingInMpv('switching MPV off');
    expect(await hasOverlayPlayer()).toBe(false);
  });

  it('takes an open in-page player over to mpv, then waits for a play', async function() {
    await expectMode('off', 'the start of this test');

    // The toolbar (Ctrl+Shift+F) brings up the in-page player.
    await clickToolbar();
    await expectMode('on', 'clicking the toolbar button');
    await browser.waitUntil(hasOverlayPlayer, {
      timeout: 15000,
      timeoutMsg: 'the in-page player never appeared',
    });

    // On -> MPV: the overlay comes down (the tab reloads) and nothing goes
    // to mpv until the reloaded page's video is started.
    const since = requests.length;
    await pressShortcut();
    await expectMode('mpv', 'pressing Ctrl+Shift+U with the in-page player open');
    await browser.waitUntil(async () => !(await hasOverlayPlayer()), {
      timeout: 15000,
      timeoutMsg: 'the in-page player stayed up after switching to mpv',
    });
    await pageVideosLoaded(since);
    await expectNothingInMpv('the reloaded page, before any play');

    const before = mpvCount();
    await clickPlay();
    if (HAVE_HOST) {
      await expectMainInMpv(before, 'clicking play after the switch');
    }

    await pressShortcut();
    await expectMode('off', 'pressing Ctrl+Shift+U again');
  });

  // Ctrl+Shift+F used to be the toolbar button (_execute_action), and a click on MPV
  // goes to Off, so after Ctrl+Shift+U the key turned FastStream off and the player
  // took a second press. Each key now has its own command.
  it('binds Ctrl+Shift+F to the player\'s own command, not the toolbar button', async function() {
    await browser.switchToWindow(extHandle);
    const commands = await browser.executeAsync((done) => {
      chrome.commands.getAll().then((all) => done(all.map((c) => [c.name, c.shortcut || ''])));
    });
    expect(Object.fromEntries(commands)).toEqual({
      toggle_player: 'Ctrl+Shift+F',
      toggle_mpv: 'Ctrl+Shift+U',
    });
  });

  // Each key turns on its own mode whatever mode the tab is in; neither has to be
  // switched off first to get the other.
  it('switches between MPV and the in-page player by their keys alone', async function() {
    await browser.switchToWindow(siteHandle);
    let since = requests.length;
    await browser.url(`${SITE}/watch`);
    await pageVideosLoaded(since);
    await expectMode('off', 'the start of this test');

    await pressShortcut('U');
    await expectMode('mpv', 'pressing Ctrl+Shift+U with FastStream off');

    // MPV -> On, from the sources already tracked.
    await pressShortcut('F');
    await expectMode('on', 'pressing Ctrl+Shift+F in MPV mode');
    await browser.waitUntil(hasOverlayPlayer, {
      timeout: 15000,
      timeoutMsg: 'the in-page player never appeared after Ctrl+Shift+F in MPV mode',
    });

    // On -> MPV: the player comes down with a reload.
    since = requests.length;
    await pressShortcut('U');
    await expectMode('mpv', 'pressing Ctrl+Shift+U with the in-page player open');
    await browser.waitUntil(async () => !(await hasOverlayPlayer()), {
      timeout: 15000,
      timeoutMsg: 'the in-page player stayed up after Ctrl+Shift+U',
    });
    await pageVideosLoaded(since);
    await expectNothingInMpv('switching back to MPV, before any play');

    // And to the player again, from the reloaded page's sources.
    await pressShortcut('F');
    await expectMode('on', 'pressing Ctrl+Shift+F in MPV mode, after the reload');
    await browser.waitUntil(hasOverlayPlayer, {
      timeout: 15000,
      timeoutMsg: 'the in-page player never appeared after the second Ctrl+Shift+F',
    });

    // The player's key again is its Off, and the player comes down.
    await pressShortcut('F');
    await expectMode('off', 'pressing Ctrl+Shift+F with the in-page player open');
    await browser.waitUntil(async () => !(await hasOverlayPlayer()), {
      timeout: 15000,
      timeoutMsg: 'the in-page player stayed up after Ctrl+Shift+F turned it off',
    });
  });

  // A stream found while the player is on opens it after Options.replaceDelay. That
  // timer only checked "on", and MPV is on too: switching to MPV inside the delay
  // found no player to reload away, and the timer then opened one under MPV.
  it('opens no in-page player under MPV that was due just before the switch', async function() {
    await setOptions({mpvMode: true, mpvAllowlist: [], replaceDelay: 8000});
    try {
      // Streams found while off start no timer, and Off -> On opens the player at once.
      await browser.switchToWindow(siteHandle);
      let since = requests.length;
      await browser.url(`${SITE}/watch`);
      await pageVideosLoaded(since);
      await expectMode('off', 'the start of this test');
      await pressShortcut('F');
      await expectMode('on', 'pressing Ctrl+Shift+F');
      await browser.waitUntil(hasOverlayPlayer, {
        timeout: 15000,
        timeoutMsg: 'the in-page player never appeared after Ctrl+Shift+F',
      });

      // A new page on the same site keeps the tab on, so its streams start the timer.
      since = requests.length;
      await browser.switchToWindow(siteHandle);
      await browser.url(`${SITE}/watch?again`);
      await pageVideosLoaded(since);
      await pressShortcut('U');
      await expectMode('mpv', 'pressing Ctrl+Shift+U before the player was due');

      await browser.pause(10000);
      expect(await hasOverlayPlayer()).toBe(false);
      await expectMode('mpv', 'the delay running out');

      await pressShortcut('U');
      await expectMode('off', 'pressing Ctrl+Shift+U again');
    } finally {
      await setOptions({mpvMode: true, mpvAllowlist: []});
    }
  });

  // The player page has no MPV mode. Ctrl+Shift+F on a blank tab opens it, and on a
  // tab Ctrl+Shift+U had armed, the MPV icon used to stay on it.
  it('drops the MPV arm when Ctrl+Shift+F opens the player page', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url('about:blank');
    await expectMode('off', 'opening a blank tab', 'about:blank');
    const tabId = await tabIdOf('about:blank');

    await pressShortcut('U');
    await expectMode('mpv', 'pressing Ctrl+Shift+U on a blank tab', 'about:blank');

    await pressShortcut('F');
    await browser.waitUntil(async () => (await urlOfTab(tabId)).startsWith(ORIGIN + '/player/'), {
      timeout: 15000,
      timeoutMsg: 'Ctrl+Shift+F on the blank tab never opened the player page',
    });
    let mode;
    try {
      await browser.waitUntil(async () => (mode = await modeOfTab(tabId)) === 'on', {
        timeout: 10000,
        interval: 250,
      });
    } catch (e) {
      throw new Error(`the player page opened on the armed tab shows '${mode}', not 'on'`);
    }

    // Leaving the player page turns FastStream off, for the tests after this one.
    await browser.switchToWindow(siteHandle);
    await browser.url(`${SITE}/watch`);
    await expectMode('off', 'leaving the player page');
  });

  it('arms MPV on a blank tab, for the video started on the next page', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url('about:blank');
    await expectMode('off', 'opening a blank tab', 'about:blank');

    await pressShortcut();
    await expectMode('mpv', 'pressing Ctrl+Shift+U on a blank tab', 'about:blank');

    await browser.switchToWindow(siteHandle);
    const since = requests.length;
    await browser.url(`${SITE}/watch`);
    await expectMode('mpv', 'opening a page in the armed tab');
    await pageVideosLoaded(since);
    await expectNothingInMpv('the page opened in the armed tab, before any play');

    const before = mpvCount();
    await clickPlay();
    if (HAVE_HOST) {
      await expectMainInMpv(before, 'clicking play on that page');
    }
    expect(await hasOverlayPlayer()).toBe(false);

    await pressShortcut();
    await expectMode('off', 'pressing Ctrl+Shift+U on that page');
  });

  // The Auto-enable URLs list turns the in-page player on for a site. A tab armed with the
  // shortcut is the user's own choice for that tab, and outranks the list: it used to open
  // the in-page player there and drop the arm.
  it('keeps the arm on a site on the Auto-enable URLs list', async function() {
    await setOptions({mpvMode: true, mpvAllowlist: [], autoEnableURLs: [SITE]});
    try {
      await browser.switchToWindow(siteHandle);
      await browser.url('about:blank');
      await expectMode('off', 'opening a blank tab', 'about:blank');

      await pressShortcut();
      await expectMode('mpv', 'pressing Ctrl+Shift+U on a blank tab', 'about:blank');

      await browser.switchToWindow(siteHandle);
      const since = requests.length;
      await browser.url(`${SITE}/watch`);
      await expectMode('mpv', 'opening an Auto-enable site in the armed tab');
      await pageVideosLoaded(since);
      expect(await hasOverlayPlayer()).toBe(false);
      await expectNothingInMpv('the Auto-enable site opened in the armed tab, before any play');

      const before = mpvCount();
      await clickPlay();
      if (HAVE_HOST) {
        await expectMainInMpv(before, 'clicking play on the Auto-enable site');
      }
      expect(await hasOverlayPlayer()).toBe(false);

      await pressShortcut();
      await expectMode('off', 'pressing Ctrl+Shift+U on that page');
    } finally {
      await setOptions({mpvMode: true, mpvAllowlist: []});
    }
  });

  it('hands over a video the user is already watching', async function() {
    await browser.switchToWindow(siteHandle);
    const since = requests.length;
    await browser.url(`${SITE}/watch`);
    await pageVideosLoaded(since);
    await expectMode('off', 'the start of this test');

    // Started with MPV off: it plays in the page.
    await clickPlay();
    await browser.waitUntil(mainPlaying, {
      timeout: 15000,
      timeoutMsg: 'the main video never started in the page',
    });

    const before = mpvCount();
    await pressShortcut();
    await expectMode('mpv', 'pressing Ctrl+Shift+U while watching');
    if (HAVE_HOST) {
      await expectMainInMpv(before, 'pressing Ctrl+Shift+U while watching');
    }

    await pressShortcut();
    await expectMode('off', 'pressing Ctrl+Shift+U again');
  });

  it('hands an MSE player\'s film to mpv, not the ad it fetched after it', async function() {
    // The video's src is a blob:, so the stream is one of its frame's: the longest, and
    // not the newest. The page fetched both with MPV off, when nothing read their lengths.
    await browser.switchToWindow(siteHandle);
    const since = requests.length;
    await browser.url(`${SITE}/mse`);
    await browser.waitUntil(async () => {
      const own = requests.slice(since).filter((r) => !isMpvRequest(r));
      return own.some((r) => r.url.startsWith('/film.m3u8')) && own.some((r) => r.url.startsWith('/ad.m3u8'));
    }, {timeout: 15000, interval: 250, timeoutMsg: 'the page never fetched its manifests: ' + seenRequests()});
    await expectMode('off', 'the start of this test');

    await pressShortcut();
    await expectMode('mpv', 'pressing Ctrl+Shift+U with FastStream off');
    const before = mpvCount();
    await clickPlay();
    if (HAVE_HOST) {
      await browser.waitUntil(async () => requests.filter(isMpvRequest).slice(before)
          .some((r) => r.url.startsWith('/film.m3u8')), {
        timeout: 45000,
        interval: 500,
        timeoutMsg: `mpv never requested the film. Seen: ${seenRequests()}`,
      });
      expect(requests.filter((r) => isMpvRequest(r) && r.url.startsWith('/ad.m3u8'))).toEqual([]);
    }

    await pressShortcut();
    await expectMode('off', 'pressing Ctrl+Shift+U again');
  });
});
