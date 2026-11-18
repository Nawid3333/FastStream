// A page with a FastStream player stays in the back-forward cache while other players talk.
//
// Players tell each other how they are doing over a BroadcastChannel, every second
// (PlayerPeers), and the OPFS worker of each player's storage runs for the page's lifetime.
// A worker's Web Lock or a message to an open BroadcastChannel keeps a page out of the bfcache:
// PlayerPeers leaves its channel on pagehide.
//
// Both players in one tab: a tab WebDriver opens meanwhile drops the first tab's cached page by
// itself.
//
// The page is left only once nothing is loading (an in-flight request keeps it out too, as the
// GitHub build's version check).

import {browser} from '@wdio/globals';

import {BUILD, OPENER_URL} from '../wdio.extension.conf.mjs';

/**
 * Loads the page that embeds a player, and waits until that player has announced itself.
 * @param {string} query - Makes each load its own page.
 * @return {Promise<void>} With the driver back on the page.
 */
async function openEmbed(query) {
  await browser.url(OPENER_URL + 'embed?' + query);
  await browser.waitUntil(async () => browser.execute(() => {
    const frame = document.querySelector('iframe#fs');
    return !!frame && frame.src.startsWith('moz-extension://');
  }), {timeout: 15000, timeoutMsg: 'the page never got its player'});
  await browser.switchFrame(await browser.$('iframe#fs'));
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.peers?.lastAnnounced),
      {timeout: 30000, timeoutMsg: 'the player never announced itself'});
  if (BUILD === 'github') {
    // Stored once the request has ended (options.mjs).
    await browser.waitUntil(async () => browser.execute(() => new Promise((done) => {
      chrome.storage.local.get('updateData', (result) => {
        try {
          done(!!JSON.parse(result?.updateData || '{}').lastUpdateCheck);
        } catch (e) {
          done(false);
        }
      });
    })), {timeout: 30000, interval: 250, timeoutMsg: 'the update check of the GitHub build never ended'});
  }
  await browser.switchFrame(null);
}

describe('A page with a player in the back-forward cache', function() {
  it('stays there while the next page\'s player announces itself', async function() {
    await openEmbed('first=' + Date.now());
    await browser.execute(() => {
      window.__kept = true;
      // Whether Firefox took the page into the cache (pagehide's persisted), kept where the
      // reloaded page can read it.
      window.addEventListener('pagehide', (event) => {
        sessionStorage.setItem('fs-e2e-left', JSON.stringify({persisted: event.persisted, at: Date.now()}));
      });
    });
    // A script's navigation: WebDriver's own leaves a listener that keeps a page out of the cache.
    await browser.execute((url) => {
      location.href = url;
    }, OPENER_URL + 'embed?second=' + Date.now());
    await browser.waitUntil(async () => browser.execute(() => location.search.startsWith('?second')),
        {timeout: 15000, timeoutMsg: 'the second page never loaded'});
    // Its player announces itself, and again, while the first page is in the cache.
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('iframe#fs')),
        {timeout: 15000});
    await browser.switchFrame(await browser.$('iframe#fs'));
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.peers?.lastAnnounced),
        {timeout: 30000, timeoutMsg: 'the second player never announced itself'});
    const first = await browser.execute(() => window.fastStream.peers.lastAnnounced.at);
    await browser.waitUntil(async () => browser.execute((at) => window.fastStream.peers.lastAnnounced.at > at, first),
        {timeout: 10000, timeoutMsg: 'the second player did not announce itself again'});
    await browser.switchFrame(null);

    await browser.back();
    await browser.waitUntil(async () => browser.execute(() => location.search.startsWith('?first')),
        {timeout: 15000, timeoutMsg: 'Back never reached the first page'});
    const back = await browser.execute(() => ({kept: window.__kept === true, left: JSON.parse(sessionStorage.getItem('fs-e2e-left'))}));
    if (!back.kept) {
      const left = back.left ? `persisted ${back.left.persisted}, ${Date.now() - back.left.at} ms ago` : 'no pagehide recorded';
      throw new Error(`Back loaded the first page again, not from the back-forward cache. As it left: ${left} ` +
          '(persisted true: cached, then dropped; false: never cached, as with a request in flight)');
    }
    // And its player with it. Its client went at beforeunload, before the page was cached,
    // and Back gave back a dead player; it starts again now (main.mjs, pageshow).
    await browser.waitUntil(async () => {
      try {
        await browser.switchFrame(await browser.$('iframe#fs'));
        return await browser.execute(() => !!window.fastStream?.peers?.lastAnnounced);
      } catch (e) {
        return false; // The frame is loading again.
      } finally {
        await browser.switchFrame(null);
      }
    }, {timeout: 30000, interval: 500, timeoutMsg: 'the player Back gave back is dead'});
  });
});
