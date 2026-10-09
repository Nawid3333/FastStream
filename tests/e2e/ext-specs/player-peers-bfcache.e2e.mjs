// A page with a FastStream player stays in the back-forward cache while other players talk.
//
// Players tell each other how they are doing over a BroadcastChannel, every second
// (PlayerPeers), and the OPFS worker of each player's storage runs for the page's lifetime.
// Firefox keeps a page out of the back-forward cache for some of what a page holds: a Web
// Lock held by a worker does (BFCacheStatus::ACTIVE_LOCK - a lock per OPFS session was tried
// and reverted on 2026-10-09 for it, content-cleanup.e2e.mjs caught it). A BroadcastChannel
// message to a cached page does not take it out (measured here: the next page's player
// announced itself twice while the first was cached, and Back restored it); messages to a
// frozen page are dropped.
//
// Both players are in one tab - a page, then the next page with its own player - because a
// tab WebDriver opens meanwhile drops the first tab's cached page by itself (measured).

import {browser, expect} from '@wdio/globals';

import {OPENER_URL} from '../wdio.extension.conf.mjs';

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
  await browser.switchFrame(null);
}

describe('A page with a player in the back-forward cache', function() {
  it('stays there while the next page\'s player announces itself', async function() {
    await openEmbed('first=' + Date.now());
    await browser.execute(() => {
      window.__kept = true;
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
    expect(await browser.execute(() => window.__kept === true)).toBe(true);
  });
});
