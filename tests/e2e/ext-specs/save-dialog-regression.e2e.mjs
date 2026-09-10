// Regression test for a bug where the save-filename dialog's
// `.swal2-container` overlay got created under the real `document.body`
// while every other lookup (getContainer, focus, classList) scoped to
// DOMElements.playerContainer (`.mainplayer`) - so the container was never
// found again after creation, the popup inside it never became visible, and
// the invisible full-size container sat on top of the page eating every
// click, including WebDriver's own trusted click on `.swal2-confirm`
// ("did not become interactable"). Fixed in tools/sync-vendor.mjs's
// toSweetAlertModule() by making getTarget() resolve the 'body' default to
// document_body instead of the real document.body.
//
// This drives the full real flow: click Save, confirm the prompt with a
// trusted driver click, wait for the save to settle, then assert nothing
// is left covering the page.

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

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
  await browser.execute((origin, url) => {
    const f = document.querySelector('iframe#fs');
    f.src = origin + '/player/index.html?t=' + Date.now() + '#' + url;
  }, ORIGIN, globalThis.__EXT_FIXTURE_MP4__);
  await browser.switchFrame(await browser.$('iframe#fs'));
  await browser.waitUntil(
      async () => browser.execute(() => document.readyState === 'complete'),
      {timeout: 30000, timeoutMsg: 'player iframe never finished loading'});
  await browser.waitUntil(
      async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'window.fastStream never appeared'});
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
        async () => browser.execute(() => !!document.querySelector('.swal2-input')),
        {timeout: 15000, timeoutMsg: 'filename prompt never appeared'});
    // The real regression: this trusted click used to time out with
    // "element did not become interactable" because an invisible
    // .swal2-container sat on top of the whole page.
    const confirmBtn = await browser.$('.swal2-confirm');
    await confirmBtn.waitForClickable({timeout: 10000});
    await confirmBtn.click();

    // Wait for the save to settle: SaveManager hides the banner when done.
    await browser.waitUntil(
        async () => browser.execute(() => {
          const banner = document.querySelector('#save_notif_banner');
          return banner && getComputedStyle(banner).display === 'none';
        }),
        {timeout: 60000, interval: 1000, timeoutMsg: 'save never settled'});

    await new Promise((r) => setTimeout(r, 2000));

    const landscape = await browser.execute(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const describe = (el) => el ? {
        tag: el.tagName, id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
      } : null;
      const containers = Array.from(
          document.querySelectorAll('.swal2-container')).map((c) => ({
        display: getComputedStyle(c).display,
        pointerEvents: getComputedStyle(c).pointerEvents,
        childPopup: !!c.querySelector('.swal2-popup'),
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

    const leftovers = (landscape.containers || []).filter((c) => {
      return c.inDom && c.display !== 'none' && !c.childPopup;
    });
    expect(leftovers).toEqual([]);
    expect(landscape.saveBtnStillClickable).toBe(true);
  });
});
