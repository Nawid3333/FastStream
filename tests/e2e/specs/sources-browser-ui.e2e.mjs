// Regression tests for two Quellen-Browser (SourcesBrowser) UI bugs:
//
// 1. The close button ("close_button") sits inside a `.popwindow` that is
//    repositioned (`bottom: 60px` -> `140px`, animated over 0.5s) whenever
//    the control bar auto-hides/shows during playback. With the dialog open
//    and the video still playing, the control bar auto-hid every ~2s of
//    mouse idle and snapped back the instant the mouse moved - sliding the
//    14x14px button out from under the cursor mid-click. Fixed by gating the
//    auto-hide timer on InterfaceUtils.isAnyWindowOpen() in
//    InterfaceController.mjs.
//
// 2. The "Quellen leeren" / clear button (`.linkui-clear-button`) appeared
//    to do nothing. Hit-testing (elementFromPoint at the button's centre)
//    showed the button itself receives the click - the earlier theory that
//    `.linkui-sources-list` overlapped it did not reproduce at any measured
//    viewport. The real mechanism: the player's list is only a MIRROR of the
//    background script's per-frame source store. Clearing the mirror left
//    the background's copy intact, and sendSourcesToMainFramePlayers
//    re-pushed it to the player on the next detected media request - so in
//    the extension the list visibly refilled within seconds of clearing,
//    reading as "nothing happened". Fixed by adding a CLEAR_SOURCES message
//    the button sends so the background clears its authoritative stores too.
//    (The web build has no background script, so this spec only pins the
//    mirror-side behaviour; the extension-side clearing is checked by
//    loading the build in Firefox.)

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
    // A real WebDriver click does its own hit-testing at the element's
    // on-screen point and throws "element click intercepted" if a different
    // element is actually on top - which is exactly how this bug surfaces,
    // as opposed to a synthetic .click() call that bypasses hit-testing.
    await clearBtn.click();

    await browser.waitUntil(
        async () => (await browser.$$('.linkui-source')).length === 0,
        {timeout: 3000, timeoutMsg: 'clear button did not empty the source list'});

    const sourcesLen = await browser.execute(
        () => window.fastStream.sourcesBrowser.sources.length);
    expect(sourcesLen).toBe(0);
  });

  it('clear button sends CLEAR_SOURCES to the background in extension builds and nothing in web builds', async function() {
    await openPlayer();

    // Instrument chrome.runtime.sendMessage (extension) / noop (web) before
    // clicking, so the assertion observes the real dispatch path.
    await browser.execute(() => {
      window.__clearSent = [];
      if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, ...rest) => {
          if (msg && msg.type === 'CLEAR_SOURCES') window.__clearSent.push(msg);
          return orig(msg, ...rest);
        };
      }
    });

    const linkButton = await browser.$('.mainplayer .fluid_button_link');
    await linkButton.click();
    const clearBtn = await browser.$('.linkui-clear-button');
    await clearBtn.waitForDisplayed();
    await clearBtn.click();

    const isExt = await browser.execute(
        () => !!(window.chrome && chrome.runtime && chrome.runtime.id));
    const sent = await browser.execute(() => window.__clearSent.length);
    if (isExt) {
      expect(sent).toBe(1);
    } else {
      // The web build has no background page to clear; the mirror-only
      // clear is the entire correct behaviour there.
      expect(sent).toBe(0);
    }
  });

  it('keeps the popwindow still (close button reachable) while it is open, even once the control bar would auto-hide', async function() {
    await openPlayer();

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

    // Force the same auto-hide path the 2s idle timer uses, with the dialog
    // open. Before the fix this would remove 'controls_visible' and slide
    // the popwindow (and its close button) down by 80px.
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

    // Sanity check the guard is scoped to "a window is open", not a
    // blanket disable: with nothing open, idle auto-hide must still work.
    // Re-queued on each poll: on a slow machine a mouse event arriving after
    // the dialog closed (the pointer is left where the close button was)
    // restarts the 2 s timer once, which a single 150 ms check read as failure.
    let hiddenWhenClosed = false;
    await browser.waitUntil(async () => {
      hiddenWhenClosed = await browser.execute(() => {
        const visible = document.querySelector('.mainplayer').classList.contains('controls_visible');
        if (visible) window.fastStream.interfaceController.queueControlsHide(20);
        return !visible;
      });
      return hiddenWhenClosed;
    }, {timeout: 3000, interval: 150, timeoutMsg: 'the control bar never auto-hid once the dialog was closed'});
    expect(hiddenWhenClosed).toBe(true);
  });
});
