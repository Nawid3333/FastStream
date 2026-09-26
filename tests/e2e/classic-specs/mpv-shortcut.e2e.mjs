// The toggle_mpv keyboard shortcut (Ctrl+Shift+U) turns MPV on and off for a
// tab by a real key press, on a site that is not on the MPV Allowlist, and
// then hands over only a video the user starts: never one the page autoplays
// (the muted preview here) or merely preloads (the main video, until its play
// button is clicked).
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
import {execFileSync} from 'node:child_process';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

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

/** @return {boolean} Whether the native host is registered for Firefox. */
function hostInstalled() {
  try {
    const key = ['HKCU', 'Software', 'Mozilla', 'NativeMessagingHosts',
      'com.faststream.mpv'].join('\\');
    const out = execFileSync('reg', ['query', key],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const match = out.match(/REG_SZ\s+(.+)/);
    return !!(match && fs.existsSync(match[1].trim()));
  } catch (e) {
    return false;
  }
}

const HAVE_HOST = hostInstalled();

/** @return {Array<number>} Process ids of every running mpv.exe. */
function mpvPids() {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const out = execFileSync('tasklist',
        ['/FI', 'IMAGENAME eq mpv.exe', '/FO', 'CSV', '/NH'],
        {encoding: 'utf8'});
    return out.split(String.fromCharCode(10))
        .map((line) => /^"mpv\.exe","(\d+)"/.exec(line.trim()))
        .filter(Boolean)
        .map((m) => Number(m[1]));
  } catch (e) {
    return [];
  }
}

const preexistingMpvPids = new Set(mpvPids());

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
 * Presses Ctrl+Shift+U with the site page focused, as a user would.
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
 */
async function pressShortcut() {
  await browser.switchToWindow(siteHandle);
  const result = await inChrome((extId, done) => {
    try {
      const {ExtensionCommon} = ChromeUtils.importESModule(
          'resource://gre/modules/ExtensionCommon.sys.mjs');
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const keysetId = 'ext-keyset-id-' + ExtensionCommon.makeWidgetId(extId);
      const keyEl = win.document.querySelector(`keyset[id="${keysetId}"] key[key="U"]`);
      if (!keyEl) {
        done({err: 'the extension has no Ctrl+Shift+U key'});
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
      const u = new KE('', {key: 'U', code: 'KeyU', keyCode: KE.DOM_VK_U});
      tip.keydown(ctrl);
      tip.keydown(shift);
      tip.keydown(u);
      tip.keyup(u);
      tip.keyup(shift);
      tip.keyup(ctrl);
    } catch (e) {
      done({err: String(e)});
    }
  }, EXTENSION_ID);
  if (!result || !result.ok) {
    throw new Error('could not press Ctrl+Shift+U: ' + JSON.stringify(result));
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
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((site, done) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(site));
      if (!tab) {
        done('no site tab');
        return;
      }
      chrome.action.getTitle({tabId: tab.id}, (title) => {
        chrome.action.getBadgeText({tabId: tab.id}, (badge) => {
          if (title.includes('MPV')) done('mpv');
          else if (badge === 'On') done('on');
          else done('off');
        });
      });
    });
  }, prefix);
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
 * Waits for mpv to request a stream beyond the first `before` it had made.
 * @param {number} before - mpv requests counted before the switch.
 * @param {string} when - What just happened, for the failure message.
 */
/** @return {string} Every request so far, marked mpv or browser. */
function seenRequests() {
  return JSON.stringify(requests.map((r) => (isMpvRequest(r) ? 'mpv ' : 'browser ') + r.url));
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
  expect(requests.filter((r) => isMpvRequest(r) && r.url.startsWith('/preview.mp4')))
      .toEqual([]);
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

describe('The MPV keyboard shortcut (Ctrl+Shift+U)', function() {
  before(async function() {
    const clip = fs.readFileSync(path.join(root, 'tests/e2e/fixtures/sample.mp4'));

    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
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

    cdnServer = http.createServer((req, res) => {
      requests.push({url: req.url, headers: req.headers});
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
    for (const pid of mpvPids()) {
      if (preexistingMpvPids.has(pid)) {
        continue;
      }
      try {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], {stdio: 'ignore'});
      } catch (e) {
        // Already gone.
      }
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
});
