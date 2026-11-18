// Whether the page the driver is in has the extension API yet.
//
// window.open() gives the tab its URL before the extension page loads: specs count the tab only
// once chrome.* is there.

import {browser} from '@wdio/globals';

/**
 * @return {Promise<boolean>} True once the page has chrome.storage. A page still loading
 *   may refuse the script: that is a no, and the caller's next round asks again.
 */
export async function hasExtensionApi() {
  return browser.execute(() => typeof chrome !== 'undefined' && !!chrome.storage).catch(() => false);
}
