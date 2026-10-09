// A page with a FastStream player stays in the back-forward cache while other players talk.
//
// Players tell each other how they are doing over a BroadcastChannel, every second
// (PlayerPeers), and the OPFS worker of each player's storage runs for the page's lifetime.
// Firefox keeps a page out of the back-forward cache for some of what a page holds: a Web
// Lock held by a worker does (BFCacheStatus::ACTIVE_LOCK - a lock per OPFS session was tried
// and reverted on 2026-10-09 for it, content-cleanup.e2e.mjs caught it). So does a message
// that reaches a BroadcastChannel the cached page has open (BroadcastChannel::MessageReceived
// calls RemoveDocFromBFCache for a window in the cache), and PlayerPeers leaves its channel on
// pagehide: this test passed locally without that, and failed on the Windows runner in 4 of 4
// attempts (PR #366).
//
// Both players are in one tab - a page, then the next page with its own player - because a
// tab WebDriver opens meanwhile drops the first tab's cached page by itself (measured).
//
// The page is left only once nothing is loading: a request in flight keeps a page out of the
// cache too (Firefox's REQUEST flag). The GitHub build's options page, in every player, asks
// GitHub for the latest version once in 12 hours - on the first player of the test's fresh
// profile - and the test left the page 70 ms into that request (the SHIPBFCache log of
// PR #366's second CI run). Someone leaving a page that fast would lose the cache the same way.

import {browser, expect} from '@wdio/globals';

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
    await browser.waitUntil(async () => browser.executeAsync((done) => {
      chrome.storage.local.get('updateData', (result) => {
        try {
          done(!!JSON.parse(result?.updateData || '{}').lastUpdateCheck);
        } catch (e) {
          done(false);
        }
      });
    }), {timeout: 30000, interval: 250, timeoutMsg: 'the update check of the GitHub build never ended'});
  }
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
