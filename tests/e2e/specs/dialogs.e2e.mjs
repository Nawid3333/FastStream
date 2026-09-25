// A closed dialog must leave the page at once, even when its close animation never ends.
//
// SweetAlert2 removes a closing dialog only on the popup's animationend. On the Windows
// CI runner that event once never came - Firefox can hold back animations in a window
// it considers inactive - and the invisible popup (class swal2-hide) stayed over the
// page, covering the save button (save-dialog-regression.e2e.mjs). AlertPolyfill's
// dialogs therefore close without a hide animation. This makes any hide animation last an
// hour, the same as one that never ends, and checks the dialog is still gone at once.

import {browser, expect} from '@wdio/globals';

describe('Dialogs', function() {
  it('removes a closed dialog at once, even if a hide animation would never end', async function() {
    await browser.url('/player/index.html?t=' + Date.now());
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
        {timeout: 15000, timeoutMsg: 'window.fastStream never appeared'});

    await browser.executeAsync((done) => {
      const style = document.createElement('style');
      style.textContent = '.swal2-hide, .swal2-backdrop-hide, .swal2-icon-hide { animation-duration: 3600s !important; }';
      document.head.appendChild(style);
      import('/player/utils/AlertPolyfill.mjs').then(({AlertPolyfill}) => {
        window.__closed = AlertPolyfill.alert('closing test');
        done();
      });
    });
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.swal2-container')),
        {timeout: 5000, timeoutMsg: 'the dialog never opened'});

    await (await browser.$('.swal2-confirm')).click();

    let left;
    try {
      await browser.waitUntil(async () => {
        left = await browser.execute(() => {
          const container = document.querySelector('.swal2-container');
          return container ? container.querySelector('.swal2-popup')?.className ?? container.className : null;
        });
        return left === null;
      }, {timeout: 1500, interval: 100});
    } catch (e) {
      throw new Error(`the closed dialog stayed on the page: ${left}`);
    }
    expect(left).toBe(null);
  });
});
