// @ts-check
// A player in a page's iframe has no tabs API, so the background joins its port to one into that frame.
import {PAGE_PORT_NAME, RELAY_PORT_PREFIX} from '../player/network/PageFetch.mjs';

/**
 * @param {chrome.runtime.Port} port
 * @param {{extensionId: string, extensionUrl: string,
 *   connectTab: (tabId: number, info: {frameId: number, name: string}) => chrome.runtime.Port}} env
 * @return {boolean}
 */
export function relayPageFetch(port, env) {
  if (typeof port.name !== 'string' || !port.name.startsWith(RELAY_PORT_PREFIX)) return false;
  const frameId = Number(port.name.slice(RELAY_PORT_PREFIX.length));
  const sender = port.sender;
  const tabId = sender?.tab?.id;
  // Only this extension's pages in a tab, joined to a frame of that same tab.
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
  // Either side going ends both; the player connects anew.
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
