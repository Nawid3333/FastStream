// The sources browser: its close button stays put while the dialog is open (no control-bar
// auto-hide), its clear button empties the list (the background's store too:
// embed-page-query.e2e.mjs), and the mode dropdown leaves the address field's focus.

import {browser, expect} from '@wdio/globals';

/**
 * Opens the web player and returns once window.fastStream exists.
 * @return {Promise<void>}
 */
async function openPlayer() {
  await browser.url('/player/index.html?t=' + Date.now());
  await browser.waitUntil(
      async () => browser.execute(() => !!window.fastStream),
      {timeout: 15000, timeoutMsg: 'window.fastStream never appeared'});
}

describe('Sources Browser (Quellen Browser) UI', function() {
  it('clear button actually empties the source list', async function() {
    await openPlayer();

    const linkButton = await browser.$('.mainplayer .fluid_button_link');
    await linkButton.click();

    const addBtn = await browser.$('.linkui-addnew-button');
    await addBtn.waitForDisplayed();
    // Constructor already seeds one blank source; add two more so the list
    // definitely has rows to clear.
    await addBtn.click();
    await addBtn.click();

    const rowsBefore = await browser.$$('.linkui-source');
    expect(rowsBefore.length).toBeGreaterThanOrEqual(3);

    const clearBtn = await browser.$('.linkui-clear-button');
    // A real WebDriver click hit-tests its point: a moved button shows as "element click
    // intercepted".
    await clearBtn.click();

    await browser.waitUntil(
        async () => (await browser.$$('.linkui-source')).length === 0,
        {timeout: 3000, timeoutMsg: 'clear button did not empty the source list'});

    const sourcesLen = await browser.execute(
        () => window.fastStream.sourcesBrowser.sources.length);
    expect(sourcesLen).toBe(0);
  });

  it('keeps the popwindow still (close button reachable) while it is open, even once the control bar would auto-hide', async function() {
    await openPlayer();

    // every focus change during the test, for the failure message
    await browser.execute(() => {
      const start = performance.now();
      const name = (el) => el ? (el.className || el.tagName || String(el)).toString().slice(0, 40) : null;
      window.__focusLog = [];
      for (const type of ['focusin', 'focusout', 'blur', 'focus']) {
        window.addEventListener(type, (e) => {
          window.__focusLog.push({
            t: Math.round(performance.now() - start), type, target: name(e.target), related: name(e.relatedTarget),
            flag: window.fastStream?.interfaceController?.focusingControls,
          });
        }, true);
      }
    });

    await browser.execute(() => {
      // Isolate the control-bar-hide guard from needing a real decoding
      // video: drive the same state the auto-hide timer reads.
      window.fastStream.interfaceController.hideBigPlayButton();
      window.fastStream.state.playing = true;
    });

    const linkButton = await browser.$('.mainplayer .fluid_button_link');
    await linkButton.click();
    await browser.waitUntil(
        async () => browser.execute(
            () => window.fastStream.sourcesBrowser.isOpen()),
        {timeout: 3000, timeoutMsg: 'sources browser never opened'});

    // the auto-hide path the 2 s idle timer uses, with the dialog open: the bar and the popwindow
    // stay
    await browser.execute(() => {
      window.fastStream.interfaceController.queueControlsHide(20);
    });
    await browser.pause(150);

    const stillVisibleWhileOpen = await browser.execute(
        () => document.querySelector('.mainplayer')
            .classList.contains('controls_visible'));
    expect(stillVisibleWhileOpen).toBe(true);

    const closeBtn = await browser.$(
        '.mainplayer .linkui_container .close_button');
    await closeBtn.click();
    await browser.waitUntil(
        async () => browser.execute(
            () => !window.fastStream.sourcesBrowser.isOpen()),
        {timeout: 3000, timeoutMsg: 'close button did not close the dialog'});

    // With nothing open idle auto-hide still works; re-queued per poll, and the pointer moved off
    // where the close button was.
    const player = await browser.$('.mainplayer');
    const {width, height} = await player.getSize();
    await browser.action('pointer')
        .move({origin: player, x: -Math.floor(width / 2) + 10, y: -Math.floor(height / 2) + 10})
        .perform();
    let hiddenWhenClosed = false;
    try {
      await browser.waitUntil(async () => {
        hiddenWhenClosed = await browser.execute(() => {
          const visible = document.querySelector('.mainplayer').classList.contains('controls_visible');
          if (visible) window.fastStream.interfaceController.queueControlsHide(20);
          return !visible;
        });
        return hiddenWhenClosed;
      }, {timeout: 3000, interval: 150});
    } catch (e) {
      // What stopped the hide - every condition queueControlsHide checks.
      const why = await browser.execute(() => {
        const ic = window.fastStream.interfaceController;
        return {
          focusingControls: ic.focusingControls, mouseOverControls: ic.mouseOverControls,
          bigPlayButton: ic.isBigPlayButtonVisible(), playing: ic.state.playing,
          canHideControls: ic.toolManager.canHideControls(),
          active: document.activeElement?.className || document.activeElement?.tagName,
          hasFocus: document.hasFocus(),
          focusLog: window.__focusLog.slice(-20),
        };
      });
      throw new Error(`the control bar never auto-hid once the dialog was closed: ${JSON.stringify(why)}`);
    }
    expect(hiddenWhenClosed).toBe(true);
  });

  // A focused control that is hidden fires no focusout in some Firefox builds: the flag must not
  // keep the bar up.
  it('auto-hides the control bar after the focused control disappears, even without a focusout', async function() {
    await openPlayer();
    const focusedIn = await browser.execute(() => {
      const ic = window.fastStream.interfaceController;
      ic.hideBigPlayButton();
      window.fastStream.state.playing = true;
      window.__focusouts = 0;
      document.querySelector('.mainplayer .fluid_controls_container')
          .addEventListener('focusout', () => window.__focusouts++);
      const button = document.querySelector('.mainplayer .fluid_button_link');
      button.focus();
      const focused = ic.focusingControls;
      button.style.display = 'none';
      return focused;
    });
    // The browser moves focus off a hidden element when it next renders, not at once.
    await browser.pause(200);
    const state = await browser.execute(() => ({
      active: document.activeElement.tagName,
      focusouts: window.__focusouts,
      flag: window.fastStream.interfaceController.focusingControls,
    }));
    console.log('      after hiding the focused control:', JSON.stringify(state));
    // The setup itself: focus was in the bar, and hiding moved it to <body>.
    expect(focusedIn).toBe(true);
    expect(state.active).toBe('BODY');
    // whether this Firefox fired the focusout varies: put the flag back as a missed one leaves it
    await browser.execute(() => {
      window.fastStream.interfaceController.focusingControls = true;
    });

    let hidden = false;
    try {
      await browser.waitUntil(async () => {
        hidden = await browser.execute(() => {
          const visible = document.querySelector('.mainplayer').classList.contains('controls_visible');
          if (visible) window.fastStream.interfaceController.queueControlsHide(20);
          return !visible;
        });
        return hidden;
      }, {timeout: 3000, interval: 150});
    } catch (e) {
      const flag = await browser.execute(() => window.fastStream.interfaceController.focusingControls);
      throw new Error(`the control bar never auto-hid after its focused control vanished (focusingControls: ${flag})`);
    } finally {
      await browser.execute(() => {
        document.querySelector('.mainplayer .fluid_button_link').style.display = '';
      });
    }
    expect(hidden).toBe(true);
  });
  it('gives the Play button back when the source fails to load', async function() {
    // a source whose setSource threw leaves its button
    await openPlayer();
    await (await browser.$('.mainplayer .fluid_button_link')).click();
    const url = await browser.$('.linkui-source-url');
    await url.waitForDisplayed();
    const state = await browser.execute((url) => new Promise((done) => {
      const client = window.fastStream;
      client.setSource = async () => {
        window.__tried = true;
        throw new Error('the source would not load');
      };
      const input = document.querySelector('.linkui-source-url');
      input.value = url;
      // As typing does: input, then change when the field is left.
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      document.querySelector('.linkui-source-set-button').click();
      setTimeout(() => {
        const button = document.querySelector('.linkui-source-set-button');
        done({loading: button.classList.contains('loading'), text: button.textContent, tried: window.__tried});
      }, 500);
    }), globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/missing.mp4');
    console.log('      after a failed source:', JSON.stringify(state));
    expect(state.tried).toBe(true);
    expect(state.loading).toBe(false);
  });

  it('keeps the typing in the address field while the pointer passes over the mode dropdown', async function() {
    // The dropdown must not take the focus on hover: the address field's change would run on half
    // an address.
    await openPlayer();
    await (await browser.$('.mainplayer .fluid_button_link')).click();
    const url = await browser.$('.linkui-source-url');
    await url.waitForDisplayed();
    await url.click();
    await browser.keys(['h', 't', 't', 'p']);
    await (await browser.$('.linkui-source-mode')).moveTo();
    // F fullscreen, D faster, Space play, 1 a seek: in the field, letters.
    await browser.keys(['f', 'd', ' ', '1']);
    const state = await browser.execute(() => ({
      value: /** @type {HTMLInputElement} */ (document.querySelector('.linkui-source-url')).value,
      focus: document.activeElement?.className,
      mode: /** @type {HTMLElement} */ (document.querySelector('.linkui-source-mode')).dataset.val,
      fullscreen: !!document.fullscreenElement || window.fastStream.state.windowedFullscreen,
      rate: window.fastStream.playbackRate,
    }));
    expect(state).toMatchObject({value: 'httpfd 1', focus: 'text_input linkui-source-url', mode: 'auto',
      fullscreen: false, rate: 1});
  });
});
