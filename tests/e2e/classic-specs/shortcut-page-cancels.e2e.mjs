// FastStream's shortcuts (Ctrl+Shift+F, Ctrl+Shift+U) still work on a page
// that cancels them.
//
// Firefox lets a page cancel an extension's shortcut: a keydown the page calls
// preventDefault() on never reaches the command. Sites do it by accident -
// VOE's "no view-source" guard cancels every Ctrl+U, Shift or not, and
// swallowed Ctrl+Shift+U (2026-09-27). content.js reports a cancelled press to
// the background, which runs the command bound to it. A press the page leaves
// alone is Firefox's to run, so the shortcut must fire once, never twice.
//
// Keys are pressed through a TextInputProcessor in chrome, the way a physical
// keyboard feeds them in; see mpv-shortcut.e2e.mjs for why browser.keys()
// cannot reach an extension's commands.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_ID, EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

const SITE_PORT = 41976;
const FRAME_PORT = 41977;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FRAME = `http://127.0.0.1:${FRAME_PORT}`;

// VOE's handler as served on 2026-09-27, verbatim.
const VOE_GUARD = `
    window.onload = function () {
        document.addEventListener("contextmenu", function (e) {
            e.preventDefault()
        }, false);
        document.addEventListener("keydown", function (e) {
            if (e.ctrlKey && e.shiftKey && e.keyCode == 73) {
                disabledEvent(e)
            }
            if (e.ctrlKey && e.shiftKey && e.keyCode == 74) {
                disabledEvent(e)
            }
            if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)) {
                disabledEvent(e)
            }
            if (e.ctrlKey && e.keyCode == 85) {
                disabledEvent(e)
            }
            if (event.keyCode == 123) {
                disabledEvent(e)
            }
        }, false);

        function disabledEvent(e) {
            if (e.stopPropagation) {
                e.stopPropagation()
            } else if (window.event) {
                window.event.cancelBubble = true
            }
            e.preventDefault();
            return false
        }
    };`;

const CANCEL_MODIFIED = `
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey) e.preventDefault();
    });`;

// What the page's own key handling saw, so a test can show the key really
// went where it says and really was cancelled.
const RECORDER = `
    window.__keys = [];
    window.addEventListener('keydown', (e) => {
      if (['Control', 'Shift', 'Alt'].includes(e.key)) return;
      const entry = {key: e.key};
      window.__keys.push(entry);
      setTimeout(() => { entry.prevented = e.defaultPrevented; }, 0);
    }, true);`;

const PAGES = {
  '/voe': VOE_GUARD,
  '/cancel-modified': CANCEL_MODIFIED,
  '/plain': '',
};

const KEYS = {
  ctrlShiftU: {ctrl: true, shift: true, key: 'U'},
  ctrlShiftF: {ctrl: true, shift: true, key: 'F'},
  altShiftU: {alt: true, shift: true, key: 'U'},
};

let siteServer;
let frameServer;
let extHandle;
let siteHandle;

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
 * Serves one test page: a focus button, the recorder, and the page's script.
 * @param {string} script - The page's own key handling.
 * @return {string} The page.
 */
function page(script) {
  return `<!doctype html><title>shortcut test</title>
    <button id="focus">focus</button>
    <script>${RECORDER}${script}</script>`;
}

/**
 * Presses a key combination into whatever has focus, as a keyboard does.
 *
 * Reports whether Firefox itself ran the extension's command for it: a page
 * that cancels the key stops that, and the command then has to come from the
 * fallback under test. Waits long enough for the command's round trip
 * through the page either way.
 *
 * @param {{key: string, ctrl?: boolean, shift?: boolean, alt?: boolean}} combo
 * @return {Promise<boolean>} Whether Firefox's own key element fired.
 */
async function press(combo) {
  const result = await inChrome((extId, combo, done) => {
    try {
      const {ExtensionCommon} = ChromeUtils.importESModule(
          'resource://gre/modules/ExtensionCommon.sys.mjs');
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const keysetId = 'ext-keyset-id-' + ExtensionCommon.makeWidgetId(extId);
      const keyEls = Array.from(win.document.querySelectorAll(`keyset[id="${keysetId}"] key`));
      let fired = false;
      const onCommand = () => {
        fired = true;
      };
      keyEls.forEach((k) => k.addEventListener('command', onCommand));
      win.setTimeout(() => {
        keyEls.forEach((k) => k.removeEventListener('command', onCommand));
        done({fired});
      }, 1500);

      const tip = Cc['@mozilla.org/text-input-processor;1']
          .createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(win)) {
        done({err: 'no input transaction'});
        return;
      }
      const KE = win.KeyboardEvent;
      const mods = [];
      if (combo.ctrl) {
        mods.push(new KE('', {key: 'Control', code: 'ControlLeft', keyCode: KE.DOM_VK_CONTROL}));
      }
      if (combo.alt) {
        mods.push(new KE('', {key: 'Alt', code: 'AltLeft', keyCode: KE.DOM_VK_ALT}));
      }
      if (combo.shift) {
        mods.push(new KE('', {key: 'Shift', code: 'ShiftLeft', keyCode: KE.DOM_VK_SHIFT}));
      }
      const k = new KE('', {key: combo.key, code: 'Key' + combo.key,
        keyCode: KE['DOM_VK_' + combo.key]});
      mods.forEach((m) => tip.keydown(m));
      tip.keydown(k);
      tip.keyup(k);
      mods.reverse().forEach((m) => tip.keyup(m));
    } catch (e) {
      done({err: String(e)});
    }
  }, EXTENSION_ID, combo);
  if (!result || result.err) {
    throw new Error('could not press the key: ' + JSON.stringify(result));
  }
  return result.fired;
}

/**
 * Opens a test page in the site tab and focuses it, as a click on it would.
 * @param {string} url - The page.
 */
async function openPage(url) {
  await browser.switchToWindow(siteHandle);
  await browser.url(url);
  await browser.waitUntil(async () =>
    (await browser.execute(() => document.readyState)) === 'complete');
  await focusPage();
}

/** Puts focus back on the site page, after a look at the extension's tab. */
async function focusPage() {
  await browser.switchToWindow(siteHandle);
  await browser.$('#focus').click();
}

/** @return {Promise<Array<{key: string, prevented: boolean}>>} */
async function pageKeys() {
  await browser.switchToWindow(siteHandle);
  return await browser.execute(() => window.__keys);
}

/**
 * Reads the site tab's mode off its toolbar button.
 * @return {Promise<string>} 'mpv', 'on' or 'off'.
 */
async function tabMode() {
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
  }, SITE + '/');
}

/**
 * Waits for the site tab to reach a mode, then checks it stays there: a
 * shortcut run twice would flip it straight back.
 * @param {string} expected - 'mpv', 'on' or 'off'.
 * @param {string} when - What just happened, for the failure message.
 */
async function expectMode(expected, when) {
  let last;
  try {
    await browser.waitUntil(async () => {
      last = await tabMode();
      return last === expected;
    }, {timeout: 10000, interval: 250});
  } catch (e) {
    throw new Error(`${when}: expected the tab to be '${expected}', it is '${last}'`);
  }
  await browser.pause(1500);
  last = await tabMode();
  if (last !== expected) {
    throw new Error(`${when}: the tab reached '${expected}', then became '${last}'`);
  }
}

/**
 * Checks the site tab's mode does not move.
 * @param {string} expected - The mode it has to keep.
 * @param {string} when - What just happened, for the failure message.
 */
async function expectModeKept(expected, when) {
  await browser.pause(2500);
  const mode = await tabMode();
  if (mode !== expected) {
    throw new Error(`${when}: the tab should have stayed '${expected}', it is '${mode}'`);
  }
}

/**
 * Rebinds a command, the way about:addons' shortcut page does.
 * @param {string} name - The command.
 * @param {?string} shortcut - The new key, or null to restore the manifest's.
 */
async function rebind(name, shortcut) {
  await browser.switchToWindow(extHandle);
  await browser.executeAsync((name, shortcut, done) => {
    const p = shortcut === null ?
      chrome.commands.reset(name) :
      chrome.commands.update({name, shortcut});
    p.then(() => done(true), (e) => done(String(e)));
  }, name, shortcut);
}

describe('FastStream shortcuts on a page that cancels them', function() {
  before(async function() {
    const serve = (req, res) => {
      const pathname = req.url.split('?')[0];
      res.writeHead(200, {'Content-Type': 'text/html'});
      if (pathname === '/outer') {
        // The VOE guard in a cross-origin frame: the key goes to the frame's
        // own process, where content.js runs as well.
        res.end(`<!doctype html><title>outer</title>
          <iframe id="inner" src="${FRAME}/voe" width="400" height="200"></iframe>`);
        return;
      }
      res.end(page(PAGES[pathname] ?? ''));
    };
    siteServer = http.createServer(serve);
    frameServer = http.createServer(serve);
    for (const [server, port] of [[siteServer, SITE_PORT], [frameServer, FRAME_PORT]]) {
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    }

    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'),
        ORIGIN + '/player/index.html');
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

    // MPV mode on, allowlist empty: every switch below is a shortcut's doing.
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
    await rebind('toggle_mpv', null).catch(() => {});
    if (siteServer) await new Promise((r) => siteServer.close(r));
    if (frameServer) await new Promise((r) => frameServer.close(r));
  });

  it('Ctrl+Shift+U works past VOE\'s guard, which cancels every Ctrl+U', async function() {
    await openPage(SITE + '/voe');
    await expectMode('off', 'on opening the page');

    await focusPage();
    expect(await press(KEYS.ctrlShiftU)).toBe(false);
    // The guard really did cancel it: Firefox did not run the command above.
    expect(await pageKeys()).toEqual([{key: 'U', prevented: true}]);
    await expectMode('mpv', 'after Ctrl+Shift+U');

    await focusPage();
    await press(KEYS.ctrlShiftU);
    await expectMode('off', 'after Ctrl+Shift+U again');
  });

  it('Ctrl+Shift+F works on a page that cancels every Ctrl key', async function() {
    await openPage(SITE + '/cancel-modified');
    await expectMode('off', 'on opening the page');

    await focusPage();
    expect(await press(KEYS.ctrlShiftF)).toBe(false);
    await expectMode('on', 'after Ctrl+Shift+F');

    await focusPage();
    await press(KEYS.ctrlShiftF);
    await expectMode('off', 'after Ctrl+Shift+F again');
  });

  it('a shortcut the page leaves alone runs once, not twice', async function() {
    await openPage(SITE + '/plain');
    await expectMode('off', 'on opening the page');

    await focusPage();
    expect(await press(KEYS.ctrlShiftU)).toBe(true);
    await expectMode('mpv', 'after Ctrl+Shift+U');

    await focusPage();
    expect(await press(KEYS.ctrlShiftF)).toBe(true);
    // From MPV, Ctrl+Shift+F goes straight to the in-page player; run twice it
    // would go on to Off.
    await expectMode('on', 'after Ctrl+Shift+F');

    await focusPage();
    expect(await press(KEYS.ctrlShiftF)).toBe(true);
    await expectMode('off', 'after Ctrl+Shift+F again');
  });

  it('Ctrl+Shift+F switches from MPV to the player on a page that cancels it', async function() {
    await openPage(SITE + '/cancel-modified');
    await expectMode('off', 'on opening the page');

    await focusPage();
    expect(await press(KEYS.ctrlShiftU)).toBe(false);
    await expectMode('mpv', 'after Ctrl+Shift+U');

    await focusPage();
    expect(await press(KEYS.ctrlShiftF)).toBe(false);
    await expectMode('on', 'after Ctrl+Shift+F');

    await focusPage();
    await press(KEYS.ctrlShiftF);
    await expectMode('off', 'after Ctrl+Shift+F again');
  });

  it('a key event the page makes up runs nothing', async function() {
    await openPage(SITE + '/cancel-modified');
    await expectMode('off', 'on opening the page');

    // One at a time, so each key's own effect would show.
    for (const key of ['U', 'F']) {
      await browser.switchToWindow(siteHandle);
      await browser.execute((key) => {
        window.__keys = [];
        document.getElementById('focus').dispatchEvent(new KeyboardEvent('keydown', {
          key, code: 'Key' + key, keyCode: key.charCodeAt(0),
          ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
      }, key);
      expect(await pageKeys()).toEqual([{key, prevented: true}]);
      await expectModeKept('off', `after the page dispatched Ctrl+Shift+${key} itself`);
    }
  });

  it('works with focus inside a cross-origin frame that cancels the key', async function() {
    await browser.switchToWindow(siteHandle);
    await browser.url(SITE + '/outer');
    const inner = await browser.$('#inner');
    await inner.waitForExist();
    await expectMode('off', 'on opening the page');

    await browser.switchToWindow(siteHandle);
    await browser.switchFrame(inner);
    await browser.waitUntil(async () =>
      (await browser.execute(() => document.readyState)) === 'complete');
    await browser.$('#focus').click();
    await browser.switchFrame(null);
    expect(await press(KEYS.ctrlShiftU)).toBe(false);

    await browser.switchFrame(await browser.$('#inner'));
    const frameKeys = await browser.execute(() => window.__keys);
    await browser.switchFrame(null);
    expect(frameKeys).toEqual([{key: 'U', prevented: true}]);
    await expectMode('mpv', 'after Ctrl+Shift+U in the frame');

    await browser.switchToWindow(siteHandle);
    await browser.switchFrame(await browser.$('#inner'));
    await browser.$('#focus').click();
    await browser.switchFrame(null);
    await press(KEYS.ctrlShiftU);
    await expectMode('off', 'after Ctrl+Shift+U in the frame again');
  });

  it('follows a shortcut the user rebinds', async function() {
    await rebind('toggle_mpv', 'Alt+Shift+U');
    await openPage(SITE + '/cancel-modified');
    await expectMode('off', 'on opening the page');

    // The old key is no longer FastStream's, cancelled or not.
    await focusPage();
    await press(KEYS.ctrlShiftU);
    await expectModeKept('off', 'after the old Ctrl+Shift+U');

    await focusPage();
    expect(await press(KEYS.altShiftU)).toBe(false);
    await expectMode('mpv', 'after the new Alt+Shift+U');

    await focusPage();
    await press(KEYS.altShiftU);
    await expectMode('off', 'after Alt+Shift+U again');

    await rebind('toggle_mpv', null);
  });
});
