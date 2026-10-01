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

  it('keeps FastStream\'s dialog sizes with the stylesheet generated from npm', async function() {
    // tools/sweetalert-overrides.css: a dialog grows past sweetalert2's 32em for a long
    // line (sweetalert2 fixes its width), a toast does not take that width (it was
    // clipped), and the player keeps its height while a dialog is open (sweetalert2 sets
    // the height of what it marks swal2-height-auto: here the player, not <body>).
    await browser.setWindowSize(1280, 800);
    await browser.url('/player/index.html?t=' + Date.now());
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
        {timeout: 15000, timeoutMsg: 'window.fastStream never appeared'});

    const measure = async (open) => {
      const size = await browser.executeAsync((open, done) => {
        import('/player/utils/AlertPolyfill.mjs').then(({AlertPolyfill}) => {
          const player = document.querySelector('.mainplayer');
          const before = player.getBoundingClientRect().height;
          if (open === 'toast') {
            AlertPolyfill.toast('success', 'Saved', 'The video was saved.');
          } else {
            AlertPolyfill.confirm('Do you want to download the whole video? This can take quite a long while.', 'warning');
          }
          setTimeout(() => {
            const popup = document.querySelector('.swal2-popup');
            const em = parseFloat(getComputedStyle(popup).fontSize);
            done({
              width: popup.getBoundingClientRect().width,
              em32: 32 * em,
              playerBefore: before,
              playerAfter: player.getBoundingClientRect().height,
            });
          }, 500);
        });
      }, open);
      await browser.execute(() => document.querySelector('.swal2-container')?.remove());
      return size;
    };

    const dialog = await measure('confirm');
    const toast = await measure('toast');
    console.log('      sizes:', JSON.stringify({dialog, toast}));
    expect(dialog.width).toBeGreaterThan(dialog.em32 + 10);
    expect(dialog.playerAfter).toBe(dialog.playerBefore);
    expect(toast.width).toBeLessThan(toast.em32);
  });
});
