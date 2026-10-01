// The "Auto-enable URLs" list, as the background reads it.
//
// A `-domain` line leaves that site alone (upstream #241, "You can now exclude specific
// domains by prepending -"): FastStream does not auto-enable there, and with "Use player
// to load HLS/DASH" on, a manifest link on that site is not redirected into the player.
// The background had its own parser for this list, and it dropped every `-domain` line,
// so neither happened. It also kept a lone `~` as the empty regex, which matches every
// URL: one stray line turned FastStream on on every site. The list now goes through
// UrlMatchList, which the unit tests cover line by line; this checks the two effects in
// Firefox, where the redirect is a declarativeNetRequest rule.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';
import {hasExtensionApi} from '../extension-api.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const PORT = 41990;
// One server, two hostnames: the list excludes one of them.
const EXCLUDED = `http://localhost:${PORT}`;
const OTHER = `http://127.0.0.1:${PORT}`;

let server;
// The pages the server was asked for by a navigation (Sec-Fetch-Dest: document). A
// redirected link never reaches the server as one; the player it lands in then fetches
// the manifest itself, which is not a navigation.
const navigations = [];
let extHandle;
let siteHandle;

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
  // loadOptions rebuilds the redirect rule after it answers.
  await browser.pause(1000);
}

/**
 * Reads a tab's mode off its toolbar button.
 * @param {string} prefix - The start of the tab's URL.
 * @return {Promise<string>} 'on' or 'off'.
 */
async function tabMode(prefix) {
  await browser.switchToWindow(extHandle);
  return await browser.executeAsync((prefix, done) => {
    chrome.tabs.query({}, (tabs) => {
      const tab = tabs.find((t) => t.url && t.url.startsWith(prefix));
      if (!tab) {
        done('no tab at ' + prefix);
        return;
      }
      chrome.action.getBadgeText({tabId: tab.id}, (badge) => done(badge === 'On' ? 'on' : 'off'));
    });
  }, prefix);
}

/**
 * Opens a URL in the site tab the way a link would.
 * @param {string} url - Where to go.
 */
async function openInSiteTab(url) {
  await browser.switchToWindow(siteHandle);
  await browser.url(OPENER_URL);
  await browser.execute((u) => {
    window.location.href = u;
  }, url);
}

describe('The Auto-enable URLs list', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      if (req.headers['sec-fetch-dest'] === 'document') navigations.push(req.url);
      if (req.url.endsWith('.m3u8')) {
        // As a page, so Firefox shows it in the tab rather than downloading it.
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<!doctype html><title>manifest</title><pre>#EXTM3U\n#EXT-X-ENDLIST</pre>');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('<!doctype html><title>auto-enable list</title><p>no media here</p>');
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
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
    siteHandle = (await browser.getWindowHandles()).find((h) => h !== extHandle);
  });

  after(async function() {
    await setOptions({});
    if (server) await new Promise((r) => server.close(r));
  });

  it('does not redirect a manifest link on a -domain site into the player', async function() {
    await setOptions({playStreamURLs: true, autoEnableURLs: ['-localhost']});

    // The rule works: the same manifest on the other hostname goes to the player, and is
    // never navigated to - the rule redirects before the request is sent.
    await openInSiteTab(`${OTHER}/control.m3u8`);
    await browser.waitUntil(async () => (await browser.getUrl()).startsWith(ORIGIN + '/player/index.html'),
        {timeout: 15000, timeoutMsg: 'a manifest link was not redirected at all, so this test proves nothing'});
    expect(navigations).not.toContain('/control.m3u8');

    await openInSiteTab(`${EXCLUDED}/excluded.m3u8`);
    await browser.waitUntil(async () => navigations.includes('/excluded.m3u8'), {timeout: 15000,
      timeoutMsg: 'the manifest link on the excluded site never reached the server: it was redirected'});
    await browser.pause(1000);
    expect(await browser.getUrl()).not.toMatch(new RegExp('^' + ORIGIN));
  });

  it('does not auto-enable on a -domain site that an earlier line lists', async function() {
    await setOptions({autoEnableURLs: [`${EXCLUDED}/`]});
    await openInSiteTab(`${EXCLUDED}/listed`);
    await browser.waitUntil(async () => (await tabMode(EXCLUDED)) === 'on',
        {timeout: 10000, timeoutMsg: 'a listed page was not auto-enabled at all, so this test proves nothing'});

    await setOptions({autoEnableURLs: [`${EXCLUDED}/`, '-localhost']});
    await openInSiteTab(`${EXCLUDED}/excluded`);
    await browser.pause(2000);
    expect(await tabMode(EXCLUDED)).toBe('off');
  });

  it('does not auto-enable every site for a lone ~ line', async function() {
    await setOptions({autoEnableURLs: ['~']});
    await openInSiteTab(`${OTHER}/anything`);
    await browser.pause(2000);
    expect(await tabMode(OTHER)).toBe('off');
  });
});
