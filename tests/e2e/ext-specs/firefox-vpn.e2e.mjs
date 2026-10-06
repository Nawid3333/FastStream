// Firefox VPN carries a page's requests and leaves FastStream's out: its channel filter
// proxies only http(s) principals (IPPExceptionsManager.getPrincipalRule, Firefox 157), and
// a site that ties its stream to the VPN's address then refuses FastStream's player - VOE,
// on 2026-10-06: "Failed to load video!" while the site's own player played. FastStream now
// sends its requests to such a stream's host the way the page's went (VpnProxyMirror.mjs),
// once the user gave it the optional "proxy" permission from the player's button.
//
// Firefox VPN itself needs a Mozilla account, so a helper add-on plays its part: it sends
// the page's requests to the stream's host through a local proxy, and leaves an extension's
// own requests alone, as Firefox VPN does. The stream's host, cdn.faststream.test, is a name
// no DNS answers: only the proxy serves it, so a request that goes direct fails, as one from
// the wrong address does at VOE. The stand-in is a plain http proxy, without the VPN's
// bearer token: Firefox sends a proxyAuthorizationHeader only to an https proxy (measured,
// Firefox 157), and an https one here would need a certificate Firefox trusts. The token's
// copy is VpnProxyMirror.test.mjs's.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {tinyZip} from '../tinyZip.mjs';

const SITE_PORT = 41973;
const PROXY_PORT = 41974;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const CDN_HOST = 'cdn.faststream.test';
const STREAM = `http://${CDN_HOST}/hls-ts/index.m3u8`;
const hlsDir = path.join(import.meta.dirname, '..', 'fixtures', 'hls-ts');

// The files that went through the proxy.
const proxied = [];
let siteServer;
let proxyServer;

/**
 * The helper add-on: Firefox VPN's part, for one host.
 * @return {Buffer} Its package.
 */
function vpnSimulator() {
  return tinyZip({
    'manifest.json': JSON.stringify({
      manifest_version: 2,
      name: 'Firefox VPN stand-in',
      version: '1.0',
      browser_specific_settings: {gecko: {id: 'vpn-sim@faststream.test'}},
      permissions: ['proxy', '<all_urls>'],
      background: {scripts: ['bg.js']},
    }),
    'bg.js': `
      browser.proxy.onRequest.addListener((details) => {
        // A page's request (an http(s) document) goes through the VPN; an extension's not.
        const from = details.originUrl || details.documentUrl || '';
        if (!/^https?:/.test(from)) return undefined;
        return {type: 'http', host: '127.0.0.1', port: ${PROXY_PORT}, connectionIsolationKey: 'vpn-sim'};
      }, {urls: ['http://${CDN_HOST}/*']});
    `,
  });
}

/**
 * Waits for FastStream's player in the page and switches into it.
 */
async function enterPlayer() {
  await browser.switchFrame(null);
  const frame = await browser.$('iframe[src*="player/index.html"]');
  await frame.waitForExist({timeout: 30000, timeoutMsg: 'FastStream never opened its player'});
  await browser.switchFrame(frame);
  await browser.waitUntil(() => browser.execute(() => !!window.fastStream?.source),
      {timeout: 30000, timeoutMsg: 'the player never got its source'});
}

const playerState = () => browser.execute(async () => {
  const client = window.fastStream;
  const video = client?.player?.getVideo?.();
  const button = document.querySelector('.mainplayer .vpn_button');
  const state = {
    source: client?.source?.url || null,
    failed: !!client?.interfaceController?.failed,
    readyState: video ? video.readyState : -1,
    width: video ? video.videoWidth : 0,
    time: client ? client.currentTime : 0,
    button: button ? button.style.display !== 'none' : null,
    buttonText: button ? button.textContent : null,
  };
  try {
    state.permitted = await chrome.permissions.contains({permissions: ['proxy']});
    state.vpn = await chrome.runtime.sendMessage({type: 'VPN_STATUS', url: state.source || ''});
  } catch (e) {
    state.error = String(e);
  }
  return state;
});

/**
 * Waits until the player's state passes a check, and returns it; the last state seen and
 * what went through the proxy go into the error.
 * @param {function(Object): boolean} check - The condition.
 * @param {string} what - For the error.
 * @return {Promise<Object>} The state.
 */
async function waitForState(check, what) {
  let state;
  try {
    await browser.waitUntil(async () => check(state = await playerState()), {timeout: 30000, interval: 300});
  } catch (e) {
    throw new Error(`${what}: ${JSON.stringify(state)}, proxied: ${JSON.stringify(proxied)}`);
  }
  return state;
}

describe('Firefox VPN', function() {
  before(async function() {
    proxyServer = http.createServer((req, res) => {
      // An http proxy is sent the whole URL.
      let target;
      try {
        target = new URL(req.url);
      } catch (e) {
        res.writeHead(400);
        res.end();
        return;
      }
      const name = path.basename(target.pathname);
      if (target.hostname !== CDN_HOST || !/^(index\.m3u8|seg-\d{3}\.ts)$/.test(name)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      proxied.push(name);
      res.writeHead(200, {
        ...cors,
        'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      });
      res.end(fs.readFileSync(path.join(hlsDir, name)));
    });
    siteServer = http.createServer((req, res) => {
      // The page asks for the stream, as a site's player does.
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><title>VPN site</title>
        <video muted style="width: 640px; height: 360px"></video>
        <script>fetch(${JSON.stringify(STREAM)} + location.search);</script>`);
    });
    for (const [server, port] of [[proxyServer, PROXY_PORT], [siteServer, SITE_PORT]]) {
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    }

    await browser.installAddOn(vpnSimulator().toString('base64'), true);
    await inExtensionPage((site, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: [site + '/']})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, SITE);
  });

  after(async function() {
    await browser.switchFrame(null);
    for (const server of [siteServer, proxyServer]) {
      if (!server) continue;
      // Firefox keeps its connections to a proxy open: close() alone waits for them.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('cannot reach the stream without the permission, and its player offers to follow the VPN', async function() {
    proxied.length = 0;
    await browser.url(`${SITE}/watch?c=1`);
    await enterPlayer();
    const state = await waitForState((state) => state.button && state.failed, 'no failure and no button');
    expect(state.source).toBe(STREAM + '?c=1');
    expect(state.readyState).toBeLessThan(3);
    // Only the page's own request went through the VPN.
    expect(proxied).toEqual(['index.m3u8']);
  });

  it('plays once allowed, its requests going the page\'s way', async function() {
    proxied.length = 0;
    const videoTab = await browser.getWindowHandle();
    // A player in a page has no permissions API: its button opens the permissions page.
    await (await browser.$('.mainplayer .vpn_button')).click();
    let permsTab;
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        if (handle === videoTab) continue;
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).endsWith('/perms.html#proxy')) {
          permsTab = handle;
          return true;
        }
      }
      return false;
    }, {timeout: 10000, timeoutMsg: 'the button did not open the permissions page'});
    // A user's click there: Firefox grants a permission only from one (its prompt is off
    // here). The page then closes itself.
    await (await browser.$('.permstatus[data-perm="proxy"]')).click();
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(permsTab),
        {timeout: 10000, timeoutMsg: 'the permissions page stayed open'});
    await browser.switchToWindow(videoTab);
    await enterPlayer();
    const state = await waitForState((state) => state.readyState >= 3 && state.width > 0 && !state.failed,
        'never became playable');
    expect(state.button).toBe(false);
    await browser.execute(() => window.fastStream.play());
    await browser.waitUntil(async () => (await playerState()).time > 1,
        {timeout: 20000, timeoutMsg: 'playback did not advance'});
    // The segments, which only FastStream asks for, came through the proxy.
    expect(proxied.filter((name) => name.endsWith('.ts')).length).toBeGreaterThan(0);
  });

  it('follows the VPN at once on the next page, the permission given', async function() {
    await browser.switchFrame(null);
    proxied.length = 0;
    await browser.url(`${SITE}/watch?c=2`);
    await enterPlayer();
    const state = await waitForState((state) => state.readyState >= 3 && state.width > 0, 'never became playable');
    expect(state.button).toBe(false);
    expect(state.failed).toBe(false);
    expect(proxied.filter((name) => name.endsWith('.ts')).length).toBeGreaterThan(0);
  });
});
