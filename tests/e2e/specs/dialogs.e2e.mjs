// The player's dialogs and toasts (AlertPolyfill): Firefox's own <dialog> and popover since
// 2026-10-09, in place of sweetalert2.
//
// What they must do, each once a bug or a sweetalert2 behaviour the callers count on:
// - leave the page the moment they close. A sweetalert2 popup whose hide animation never
//   ended stayed over the page, invisible, and took every click (save-dialog-regression);
// - open in the top layer (over a fullscreen player), sized as before: wider than 32em for a
//   long line, a toast narrower;
// - show an error's message as text: it can quote the markup the code failed on (#186);
// - close on Escape and on a click beside the dialog, confirm on Enter, and keep the keys
//   typed into them from the player's keybinds;
// - refuse a URL that is none where a URL is asked for;
// - follow the player's colour theme.

import {browser, expect} from '@wdio/globals';

/** Opens the player page without a source. */
async function openPlayer() {
  await browser.url('/player/index.html?t=' + Date.now());
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 15000, timeoutMsg: 'window.fastStream never appeared'});
}

/**
 * Opens a dialog in the page; its answer lands in window.__answer.
 * @param {string} method - alert, confirm or prompt.
 * @param {...*} args
 */
async function open(method, ...args) {
  await browser.executeAsync((method, args, done) => {
    window.__answer = undefined;
    import('/player/utils/AlertPolyfill.mjs').then(({AlertPolyfill}) => {
      AlertPolyfill[method](...args).then((answer) => {
        window.__answer = {answer};
      });
      done();
    });
  }, method, args);
  await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('dialog.fs-dialog[open]')),
      {timeout: 5000, timeoutMsg: `the dialog of ${method} never opened`});
}

/**
 * Waits for the open dialog's answer.
 * @return {Promise<*>}
 */
async function answer() {
  let state;
  await browser.waitUntil(async () => {
    state = await browser.execute(() => ({answer: window.__answer, left: document.querySelectorAll('.fs-dialog').length}));
    return state.answer !== undefined;
  }, {timeout: 5000, timeoutMsg: 'the dialog never answered'});
  expect(state.left).toBe(0);
  return state.answer.answer;
}

describe('Dialogs', function() {
  it('leaves the page the moment it closes, and answers', async function() {
    await openPlayer();
    await open('alert', 'closing test', 'success');
    await (await browser.$('.fs-dialog-confirm')).click();
    expect(await answer()).toEqual({isConfirmed: true, isDenied: false, isDismissed: false, value: true});
    const top = await browser.execute(() => {
      const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return element.closest('dialog') ? 'dialog' : element.className;
    });
    expect(top).not.toBe('dialog');
  });

  it('opens in the top layer, as wide as before; a toast stays narrow', async function() {
    await browser.setWindowSize(1280, 800);
    await openPlayer();
    const before = await browser.execute(() => document.querySelector('.mainplayer').getBoundingClientRect().height);
    await open('confirm', 'Do you want to download the whole video? This can take quite a long while.', 'warning');
    const dialog = await browser.execute(() => {
      const element = document.querySelector('.fs-dialog');
      return {
        modal: element.matches(':modal'),
        width: element.getBoundingClientRect().width,
        em32: 32 * parseFloat(getComputedStyle(element).fontSize),
        player: document.querySelector('.mainplayer').getBoundingClientRect().height,
      };
    });
    await (await browser.$('.fs-dialog-cancel')).click();
    expect(await answer()).toBe(false);

    await browser.execute(() => import('/player/utils/AlertPolyfill.mjs').then(({AlertPolyfill}) => {
      AlertPolyfill.toast('success', 'Saved', 'The video was saved.');
    }));
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.fs-toast')), {timeout: 5000});
    const toast = await browser.execute(() => {
      const element = document.querySelector('.fs-toast');
      return {
        open: document.querySelector('.fs-toasts').matches(':popover-open'),
        width: element.getBoundingClientRect().width,
        right: window.innerWidth - element.getBoundingClientRect().right,
        em32: 32 * parseFloat(getComputedStyle(element).fontSize),
      };
    });
    console.log('      sizes:', JSON.stringify({dialog, toast}));
    expect(dialog.modal).toBe(true);
    expect(dialog.width).toBeGreaterThan(dialog.em32 + 10);
    expect(dialog.player).toBe(before);
    expect(toast.open).toBe(true);
    expect(toast.width).toBeLessThan(toast.em32);
    expect(toast.right).toBeLessThan(30);
    // Gone after its 3 s, and its corner with it.
    await browser.waitUntil(async () => browser.execute(() => !document.querySelector('.fs-toast') &&
      !document.querySelector('.fs-toasts').matches(':popover-open')), {timeout: 6000, timeoutMsg: 'the toast stayed'});
  });

  it('shows markup in an error\'s message and in a toast as text', async function() {
    await openPlayer();
    const shown = await browser.executeAsync((done) => {
      import('/player/utils/AlertPolyfill.mjs').then(async ({AlertPolyfill}) => {
        const markup = 'Invalid URL: <b id="fs-injected">x</b>';
        AlertPolyfill.errorSendToDeveloper(new Error(markup));
        AlertPolyfill.toast('error', markup);
        await new Promise((resolve) => setTimeout(resolve, 300));
        done({
          title: document.querySelector('.fs-dialog-title')?.textContent,
          toast: document.querySelector('.fs-toast-title')?.textContent,
          injected: !!document.getElementById('fs-injected'),
        });
      });
    });
    expect(shown.injected).toBe(false);
    expect(shown.title).toContain('<b id="fs-injected">x</b>');
    expect(shown.toast).toContain('<b id="fs-injected">x</b>');
  });

  it('closes on Escape and on a click beside it, not on one inside', async function() {
    await openPlayer();
    await open('confirm', 'Escape?');
    await browser.keys(['Escape']);
    expect(await answer()).toBe(false);

    await open('confirm', 'Beside?');
    // Inside: on its text. Then beside it: the backdrop, in a corner of the page.
    await (await browser.$('.fs-dialog-text')).click();
    expect(await browser.execute(() => !!document.querySelector('dialog.fs-dialog[open]'))).toBe(true);
    await browser.action('pointer').move({x: 5, y: 5}).down().up().perform();
    expect(await answer()).toBe(false);
  });

  it('confirms a prompt on Enter with what was typed, and keeps its keys from the player', async function() {
    await openPlayer();
    await browser.execute(() => {
      const keybinds = window.fastStream.keybindManager;
      const onKeyDown = keybinds.onKeyDown;
      window.__playerKeys = [];
      keybinds.onKeyDown = (e) => {
        window.__playerKeys.push(e.key);
        return onKeyDown.call(keybinds, e);
      };
    });
    await open('prompt', 'File name?', 'video');
    expect(await browser.execute(() => document.activeElement?.className)).toBe('fs-dialog-input');
    await browser.keys(['End', '-', '2', 'Enter']);
    expect(await answer()).toBe('video-2');

    await open('alert', 'Keys?');
    // On the focused button: ArrowRight seeks in the player, Space plays.
    await browser.keys(['ArrowRight', 'k']);
    await browser.keys(['Escape']);
    await answer();
    expect(await browser.execute(() => window.__playerKeys)).toEqual([]);
  });

  it('refuses a URL that is none where a URL is asked for', async function() {
    await openPlayer();
    await open('prompt', 'Subtitle URL?', '', null, 'url');
    await browser.keys(['Enter']);
    expect(await browser.execute(() => !!document.querySelector('dialog.fs-dialog[open]'))).toBe(true);
    await browser.keys(['n', 'o', 't', ' ', 'a', ' ', 'u', 'r', 'l', 'Enter']);
    expect(await browser.execute(() => !!document.querySelector('dialog.fs-dialog[open]'))).toBe(true);
    await browser.execute(() => {
      document.querySelector('.fs-dialog-input').value = 'https://example.com/a.vtt';
    });
    await browser.keys(['Enter']);
    expect(await answer()).toBe('https://example.com/a.vtt');
  });

  it('follows the player\'s colour theme', async function() {
    await openPlayer();
    const colours = [];
    for (const theme of ['default', 'arctic']) {
      await browser.execute((theme) => {
        document.body.dataset.theme = theme;
      }, theme);
      await open('alert', theme);
      colours.push(await browser.execute(() => getComputedStyle(document.querySelector('.fs-dialog')).backgroundColor));
      await browser.keys(['Escape']);
      await answer();
    }
    console.log('      backgrounds:', JSON.stringify(colours));
    // Dark in the default theme, light in arctic (colors.css: --popwindow-background-color).
    expect(colours[0]).toBe('rgba(50, 50, 50, 0.9)');
    expect(colours[1]).toBe('rgba(255, 255, 255, 0.98)');
  });
});
