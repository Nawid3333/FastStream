// What a web page can do with FastStream's pages by framing them itself.
//
// The player page is web-accessible (the extension puts it into pages), so any page that
// learns the extension's address (from a player iframe's src) can frame it too, with
// whatever it likes in the address. Three things that allowed:
//
// - A made-up source with made-up headers: `player/index.html#<url>?faststream-headers=`.
//   Its Referer went on to mpv, and the native host's PowerShell ran a value that closed
//   its quoted string (tests/unit/mpvHostSecurity.test.mjs). The extension only ever puts
//   a source in the address of a player in a tab of its own (the redirect rule is
//   main_frame only), so a framed player now ignores the address.
// - Headers on the page's own requests: the player's header rule was for the whole tab,
//   and the tab is the page's. For 5 s the page's requests to that URL went out with the
//   player's Origin or Cookie. The rule now covers only the extension's own requests.
// - The options page, framed for a click on a changed mpv path. Only the player frames
//   it, and an extension page needs no web-accessible entry for that.
//
// The controls show each mechanism still works where it should: a player in a tab of its
// own plays its address's source, sending the address's Referer through the header rule;
// the player's own request gets its rule's headers; the player's settings still load.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;
const PLAYER = `${ORIGIN}/player/index.html`;
const SITE_PORT = 41975;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const SAMPLE = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/sample.mp4'));
const FORGED_REFERER = 'https://forged.test/page';

let siteServer;
// path -> the requests it got, with the headers that matter here.
const requests = new Map();

/**
 * A player address with a source and made-up headers, as a page would write it.
 * @param {string} name - The source's path on the site server.
 * @return {string}
 */
function playerWithSource(name) {
  const source = `${SITE}/${name}.mp4?faststream-headers=` +
    encodeURIComponent(JSON.stringify({Referer: FORGED_REFERER}));
  return `${PLAYER}#${source}`;
}

/**
 * Waits for a frame on the current page and switches into it.
 * @param {string} selector - The iframe.
 * @return {Promise<void>}
 */
async function intoFrame(selector) {
  const frame = await browser.$(selector);
  await frame.waitForExist({timeout: 10000});
  await browser.switchFrame(frame);
}

describe('A page framing FastStream\'s pages', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      const seen = requests.get(url.pathname) || [];
      seen.push({referer: req.headers.referer || null, origin: req.headers.origin || null});
      requests.set(url.pathname, seen);

      if (url.pathname.endsWith('.mp4')) {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': SAMPLE.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(SAMPLE);
        return;
      }
      if (url.pathname === '/echo') {
        res.writeHead(200, {'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'});
        res.end('ok');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      if (url.pathname === '/frames-source') {
        res.end(`<!doctype html><title>frames a source</title>
          <iframe id="player" src="${playerWithSource('framed-source')}"
                  style="width: 640px; height: 360px"></iframe>`);
      } else if (url.pathname === '/frames-player') {
        res.end(`<!doctype html><title>frames the player</title>
          <iframe id="player" src="${PLAYER}" style="width: 640px; height: 360px"></iframe>`);
      } else if (url.pathname === '/frames-options') {
        res.end(`<!doctype html><title>frames the options</title>
          <iframe id="options" src="${ORIGIN}/player/options/index.html"
                  style="width: 640px; height: 360px"></iframe>`);
      } else {
        res.end('<!doctype html><title>site</title>');
      }
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });
  });

  afterEach(async function() {
    await browser.switchFrame(null);
    // Back to one tab, on a page of the test server.
    const handles = await browser.getWindowHandles();
    for (const h of handles.slice(1)) {
      await browser.switchToWindow(h);
      await browser.closeWindow();
    }
    await browser.switchToWindow(handles[0]);
    await browser.url(OPENER_URL);
  });

  after(async function() {
    if (siteServer) await new Promise((resolve) => siteServer.close(resolve));
  });

  it('plays a source from the address in a player tab of its own, with its headers (the control)', async function() {
    await browser.url(OPENER_URL);
    await browser.execute((u) => window.open(u, '_blank'), playerWithSource('own-tab'));
    await browser.waitUntil(() => requests.has('/own-tab.mp4'), {
      timeout: 20000, interval: 200, timeoutMsg: 'the player tab never requested its source',
    });
    console.log('      requests:', JSON.stringify(requests.get('/own-tab.mp4')));
    // The player's own requests still get their header rule (limited to the extension's
    // requests by initiatorDomains).
    expect(requests.get('/own-tab.mp4')[0].referer).toBe(FORGED_REFERER);
  });

  it('ignores a source a page put in the address of a player it framed', async function() {
    await browser.url(`${SITE}/frames-source`);
    await intoFrame('#player');
    // The player has set up and would have requested its source by now.
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.interfaceController), {
      timeout: 20000, interval: 200, timeoutMsg: 'the framed player never set up',
    });
    await browser.pause(3000);
    const source = await browser.execute(() => window.fastStream?.source?.url || null);
    console.log('      requests:', JSON.stringify(requests.get('/framed-source.mp4') || []), 'source:', source);
    expect(requests.has('/framed-source.mp4')).toBe(false);
    expect(source).toBeNull();
  });

  it('keeps a framed player\'s header rule off the page\'s own requests', async function() {
    await browser.url(`${SITE}/frames-player`);
    await intoFrame('#player');
    await browser.waitUntil(async () => browser.execute(() => typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage), {
      timeout: 20000, interval: 200, timeoutMsg: 'the framed player never loaded',
    });
    const url = `${SITE}/echo?id=rule`;
    const asked = await browser.executeAsync((u, done) => {
      chrome.runtime.sendMessage({
        type: 'SET_HEADERS',
        url: u,
        commands: [{operation: 'set', header: 'origin', value: 'https://victim.test'}],
      }).then(() => done('ok'), (e) => done('failed: ' + e));
    }, url);
    expect(asked).toBe('ok');

    // The page, within the rule's 5 seconds, then the player itself.
    await browser.switchFrame(null);
    const pageFetch = await browser.executeAsync((u, done) => {
      fetch(u, {cache: 'no-store'}).then((r) => done(r.status), (e) => done(String(e)));
    }, url);
    await intoFrame('#player');
    const playerFetch = await browser.executeAsync((u, done) => {
      fetch(u, {cache: 'no-store'}).then((r) => done(r.status), (e) => done(String(e)));
    }, url);

    const seen = requests.get('/echo') || [];
    console.log('      fetches:', pageFetch, playerFetch, 'requests:', JSON.stringify(seen));
    expect(seen).toHaveLength(2);
    expect(seen[0].origin).not.toBe('https://victim.test');
    expect(seen[1].origin).toBe('https://victim.test');
  });

  it('cannot frame the options page, and the player\'s own settings still load', async function() {
    await browser.url(`${SITE}/frames-options`);
    await intoFrame('#options');
    await browser.pause(3000);
    const framed = await browser.execute(() => ({
      href: location.href,
      loaded: document.documentElement.dataset.optionsLoaded || null,
    })).catch((e) => ({error: String(e)}));
    console.log('      options framed by the page:', JSON.stringify(framed));
    expect(framed.loaded).not.toBe('true');

    // The player (itself framed by a page here) frames its settings: an extension page
    // loading another, which needs no web-accessible entry.
    await browser.switchFrame(null);
    await browser.url(`${SITE}/frames-player`);
    await intoFrame('#player');
    await intoFrame('.options_frame');
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'), {
      timeout: 20000, interval: 200, timeoutMsg: 'the player\'s settings never loaded',
    });
  });
});
