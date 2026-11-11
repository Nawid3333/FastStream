// @ts-check
// The player's way to its page (PageFetch.mjs to page-fetch.js). A player in a page's iframe has no
// tabs API: Firefox gives an extension frame inside a web page none (measured, Firefox 160:
// chrome.tabs undefined there), so it cannot open a port into the page itself. It opens one to the
// background, named for the page's frame, and the background joins it to a port into that frame of
// the player's own tab (tabs.connect), passing every message on as it is, both ways.
import {PAGE_PORT_NAME, RELAY_PORT_PREFIX} from '../player/network/PageFetch.mjs';

/**
 * Joins a player's port to its page's frame, when it is one (by its name).
 * @param {chrome.runtime.Port} port - From runtime.onConnect.
 * @param {{extensionId: string, extensionUrl: string,
 *   connectTab: (tabId: number, info: {frameId: number, name: string}) => chrome.runtime.Port}} env
 * @return {boolean} Whether the port was a player's for its page (taken, or refused and closed).
 */
export function relayPageFetch(port, env) {
  if (typeof port.name !== 'string' || !port.name.startsWith(RELAY_PORT_PREFIX)) return false;
  const frameId = Number(port.name.slice(RELAY_PORT_PREFIX.length));
  const sender = port.sender;
  const tabId = sender?.tab?.id;
  // Only this extension's own pages, in a tab: a page's frame of that same tab, never another tab.
  if (sender?.id !== env.extensionId || !String(sender?.url || '').startsWith(env.extensionUrl) ||
      typeof tabId !== 'number' || tabId < 0 || !Number.isInteger(frameId) || frameId < 0 ||
      frameId === sender?.frameId) {
    port.disconnect();
    return true;
  }
  /** @type {chrome.runtime.Port} */
  let page;
  try {
    page = env.connectTab(tabId, {frameId, name: PAGE_PORT_NAME});
  } catch (e) {
    port.disconnect();
    return true;
  }
  let open = true;
  // Either side going ends both: the page's requests stop, the player's fail and connect anew.
  const close = () => {
    if (!open) return;
    open = false;
    for (const end of [page, port]) {
      try {
        end.disconnect();
      } catch (e) {
        // Gone already.
      }
    }
  };
  /**
   * @param {chrome.runtime.Port} to
   * @return {(msg: *) => void}
   */
  const passTo = (to) => (msg) => {
    if (!open) return;
    try {
      to.postMessage(msg);
    } catch (e) {
      close();
    }
  };
  port.onMessage.addListener(passTo(page));
  page.onMessage.addListener(passTo(port));
  port.onDisconnect.addListener(close);
  page.onDisconnect.addListener(close);
  return true;
}
