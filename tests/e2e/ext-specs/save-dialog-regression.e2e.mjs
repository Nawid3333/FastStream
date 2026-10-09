// Regression test for a bug where the save-filename dialog's overlay (then
// sweetalert2's `.swal2-container`) got created under the real `document.body`
// while every other lookup scoped to DOMElements.playerContainer
// (`.mainplayer`) - so the popup inside it never became visible, and the
// invisible full-size container sat on top of the page eating every click,
// including WebDriver's own trusted click on its confirm button ("did not
// become interactable"). The dialogs are Firefox's own <dialog> since
// 2026-10-09 (AlertPolyfill), which leaves the page as it closes; this keeps
// checking that nothing is left over the page after a real save.
//
// This drives the full real flow: click Save, confirm the prompt with a
// trusted driver click, wait for the save to settle, then assert nothing
// is left covering the page.

import {browser, expect} from '@wdio/globals';
import {pageState} from '../specs/diagnostics.mjs';

import {addSourceInPlayer} from '../extension-page.mjs';

/**
 * Embeds the player iframe pointing at the MP4 fixture and switches the
 * driver into it, past the interaction gate.
 * @return {Promise<void>}
 */
async function openEmbeddedPlayerWithMp4() {
  await browser.url(globalThis.__EXT_OPENER_URL__ + 'embed?t=' + Date.now());
  await browser.waitUntil(
      async () => browser.execute(() => {
        const f = document.querySelector('iframe#fs');
        return !!f && f.src.startsWith('moz-extension://');
      }),
      {timeout: 15000, timeoutMsg: 'embed page never got its player iframe'});
  await browser.switchFrame(await browser.$('iframe#fs'));
  await browser.waitUntil(
      async () => browser.execute(() => document.readyState === 'complete'),
      {timeout: 30000, timeoutMsg: 'player iframe never finished loading'});
  await browser.waitUntil(
      async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'window.fastStream never appeared'});
  // Not through the iframe's #hash: a player inside a page ignores it.
  await addSourceInPlayer(globalThis.__EXT_FIXTURE_MP4__);
  await browser.execute(() => window.fastStream.userInteracted());
  await browser.waitUntil(
      async () => browser.execute(() => {
        const v = document.querySelector('video');
        return !!v && v.readyState >= 2;
      }),
      {timeout: 60000, interval: 1000,
        timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});
}

describe('save dialog regression', function() {
  it('leaves no click-eating overlay after the prompt is confirmed and the save finishes', async function() {
    await openEmbeddedPlayerWithMp4();

    const saveBtn = await browser.$('.main_download');
    await saveBtn.waitForExist({timeout: 15000});
    await saveBtn.click();

    await browser.waitUntil(
        async () => browser.execute(() => !!document.querySelector('.fs-dialog-input')),
        {timeout: 15000, timeoutMsg: 'filename prompt never appeared'});
    // The real regression: this trusted click used to time out with
    // "element did not become interactable" because an invisible
    // .fs-dialog sat on top of the whole page.
    const confirmBtn = await browser.$('.fs-dialog-confirm');
    await confirmBtn.waitForClickable({timeout: 10000});
    await confirmBtn.click();

    // Wait for the save to settle: SaveManager hides the banner when done.
    await browser.waitUntil(
        async () => browser.execute(() => {
          const banner = document.querySelector('#save_notif_banner');
          return banner && getComputedStyle(banner).display === 'none';
        }),
        {timeout: 60000, interval: 1000, timeoutMsg: 'save never settled'});

    const readLandscape = () => browser.execute(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const describe = (el) => el ? {
        tag: el.tagName, id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
      } : null;
      const containers = Array.from(
          document.querySelectorAll('.fs-dialog')).map((c) => ({
        display: getComputedStyle(c).display,
        pointerEvents: getComputedStyle(c).pointerEvents,
        open: c.open,
        inDom: document.body.contains(c),
      }));
      return {
        center: describe(document.elementFromPoint(w / 2, h / 2)),
        bottomBar: describe(document.elementFromPoint(w / 2, h - 20)),
        saveBtnStillClickable: (() => {
          const btn = document.querySelector('.main_download');
          if (!btn) return false;
          const r = btn.getBoundingClientRect();
          const top = document.elementFromPoint(
              r.x + r.width / 2, r.y + r.height / 2);
          return btn === top || btn.contains(top);
        })(),
        containers,
      };
    });
    // A closed dialog leaves the page (AlertPolyfill): one still in it is left over.
    const leftoversOf = (landscape) => (landscape.containers || []).filter((c) => c.inDom);

    // Poll instead of sleeping a fixed 2s and taking one snapshot: headless
    // Firefox's software (SWGL) compositor - the path CI's Linux runners
    // fall back to, per its "RenderCompositorSWGL failed mapping default
    // framebuffer" log - can hand elementFromPoint() a stale hit-test right
    // after the save-completion UI updates, failing this on nothing more
    // than a slow paint. A real stuck overlay still fails, just after the
    // full timeout instead of after a single sample.
    let landscape;
    try {
      await browser.waitUntil(async () => {
        landscape = await readLandscape();
        return leftoversOf(landscape).length === 0 && landscape.saveBtnStillClickable;
      }, {timeout: 10000, interval: 500});
    } catch (e) {
      // What covered it, and whether the save was still waiting on OPFS: on the Windows
      // runner saves have hung on an OPFS worker call that never answered.
      throw new Error('save button stayed covered/unclickable after the save finished: ' +
          JSON.stringify({landscape, page: await pageState()}));
    }

    expect(leftoversOf(landscape)).toEqual([]);
    expect(landscape.saveBtnStillClickable).toBe(true);
  });
});
