// switchFrame(element) and switchFrame(null) for WebDriver BiDi sessions, as WebdriverIO 9 had
// them.
//
// WebdriverIO 10 removed switchFrame for BiDi sessions (the extension and playback suites):
// code in a frame is to go through browsing-context objects there (browser.url(), then
// .frame()). The specs switch into the player's frames and back some fifty times, with
// shared helpers that run in whatever frame is current. This puts back what 9 did for an
// element or null (its switchFrame, webdriverio 9.32.0 build/node.js): the frame's browsing
// context, read from the iframe's contentWindow in the page, becomes the one WebdriverIO's
// BiDi commands (execute, $) go to, and WebDriver classic's switchToFrame takes the classic
// commands (click, keys) there as well. null goes back to the tab itself. Sessions without
// BiDi (the classic and private-browsing suites) keep WebdriverIO's own switchFrame.

import {getContextManager} from 'webdriverio';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/**
 * Overwrites browser.switchFrame for BiDi sessions. Call it in the config's before hook,
 * after the session has its BiDi connection (ensureBidi).
 * @param {WebdriverIO.Browser} browser
 */
export function restoreSwitchFrame(browser) {
  browser.overwriteCommand('switchFrame', async function(original, target) {
    if (!browser.isBidi) {
      return original(target);
    }
    const contexts = getContextManager(browser);
    if (target === null) {
      const handle = await browser.getWindowHandle();
      contexts.setCurrentContext(handle);
      await browser.switchToFrame(null);
      return handle;
    }
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
      throw new Error('switchFrame (tests/e2e/switchFrame.mjs) takes an iframe element or null');
    }
    const element = typeof target.getElement === 'function' ? await target.getElement() : await target;
    await element.waitForExist({
      timeoutMsg: `Can't switch to frame with selector ${element.selector} because it doesn't exist`,
    });
    const frame = await browser.execute((iframe) => iframe.contentWindow, element);
    if (!frame?.context) {
      throw new Error(`switchFrame: ${element.selector} has no browsing context (not a frame?)`);
    }
    contexts.setCurrentContext(frame.context);
    await browser.switchToFrame({[ELEMENT_KEY]: element.elementId});
    return frame.context;
  });
}
