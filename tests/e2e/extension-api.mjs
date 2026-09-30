// Whether the page the driver is in has the extension API yet.
//
// window.open() gives the new tab its URL before the extension page has loaded into it, so a
// spec that found the tab by its URL and ran chrome.* at once sometimes got "ReferenceError:
// chrome is not defined" (mpv.e2e on 2026-09-30; the same race extension-page.mjs describes).
// The specs that find the extension's tab this way count it only once this says yes.

import {browser} from '@wdio/globals';

/**
 * @return {Promise<boolean>} True once the page has chrome.storage. A page still loading
 *   may refuse the script: that is a no, and the caller's next round asks again.
 */
export async function hasExtensionApi() {
  return browser.execute(() => typeof chrome !== 'undefined' && !!chrome.storage).catch(() => false);
}
