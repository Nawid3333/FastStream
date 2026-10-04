// The web player's embed API, in Firefox: it takes commands only from the page that embeds
// it, not from another frame of that page (#218). tests/unit/EmbedAPI.test.mjs covers the
// rules on stand-in windows; this checks them on the real web build, between real frames.
//
// The embedding page is served from its own origin, as a site would be. Its second frame,
// the "ad", is a srcdoc frame: it reaches the player the way any frame of the page can,
// through parent.frames, and what decides is which window a command comes from.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {listenOrStop} from '../listen-or-stop.mjs';

const EMBED_PORT = 41890;
const EMBED_ORIGIN = `http://127.0.0.1:${EMBED_PORT}`;

let server;

/**
 * The embedding page: the player, and an ad frame that posts commands to it.
 * @param {string} playerUrl - The web build's player page.
 * @return {string} The page's HTML.
 */
function embeddingPage(playerUrl) {
  const playerOrigin = new URL(playerUrl).origin;
  const ad = `<script>
    window.inbox = [];
    addEventListener('message', (e) => inbox.push(e.data));
    window.send = (command, args) => parent.frames[0].postMessage(
        {type: 'faststream:command', id: 'ad-' + command, command, args}, '*');
  </script>`;
  return `<!doctype html><meta charset="utf-8"><title>Embed API</title>
<iframe id="player" src="${playerUrl}" width="640" height="360" allow="autoplay"></iframe>
<iframe id="ad" srcdoc="${ad.replace(/"/g, '&quot;')}"></iframe>
<script>
  window.inbox = [];
  const player = document.getElementById('player');
  addEventListener('message', (e) => {
    if (e.source === player.contentWindow) inbox.push(e.data);
  });
  window.send = (command, args) => player.contentWindow.postMessage(
      {type: 'faststream:command', id: 'page-' + command, command, args}, '${playerOrigin}');
</script>`;
}

describe('Embed API (web build)', function() {
  before(async function() {
    const playerUrl = new URL('/player/index.html', browser.options.baseUrl).href;
    const page = embeddingPage(playerUrl);
    server = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(page);
    });
    await new Promise((resolve) => listenOrStop(server, EMBED_PORT, resolve));
  });

  after(async function() {
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers the page that embeds it, and gives another frame of the page nothing', async function() {
    await browser.url(`${EMBED_ORIGIN}/?t=${Date.now()}`);
    await browser.waitUntil(() => browser.execute(() => window.inbox.some((m) => m.event === 'ready')),
        {timeout: 20000, timeoutMsg: 'the player never announced itself'});

    // The ad asks for the state, to load another video, and to follow every event.
    await browser.execute(() => {
      const ad = document.getElementById('ad').contentWindow;
      ad.send('getState');
      ad.send('load', {url: 'https://ads.example/other.mp4'});
      ad.send('subscribe');
    });
    // The page itself asks for the state, after the ad's commands.
    await browser.execute(() => window.send('getState'));
    await browser.waitUntil(() => browser.execute(() => window.inbox.some((m) => m.id === 'page-getState')),
        {timeout: 10000, timeoutMsg: 'the embedding page got no answer'});
    // The player answers in order, so the ad's answers would be in by now; give them a
    // moment more anyway.
    await browser.pause(500);

    const result = await browser.execute(() => ({
      page: window.inbox.find((m) => m.id === 'page-getState'),
      ad: document.getElementById('ad').contentWindow.inbox,
    }));
    console.log('      embed api:', JSON.stringify({page: result.page.ok, ad: result.ad.length}));
    expect(result.page.ok).toBe(true);
    // The ad's load was not run: the player still has no source.
    expect(result.page.result.hasSource).toBe(false);
    expect(result.ad).toEqual([]);
  });
});
