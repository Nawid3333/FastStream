// @ts-check
import {SNIFF_BYTES, modeFromBody} from './StreamDetection.mjs';

// A response that trickles (a long poll, an event stream) is let go after this long.
export const SNIFF_GIVE_UP_MS = 10000;

/**
 * @typedef {{ondata: ?((event: {data: ArrayBuffer}) => void), onstop: ?(() => void), onerror: ?(() => void),
 *   write: (data: ArrayBuffer) => void, disconnect: () => void, close: () => void}} StreamFilterLike
 */

/**
 * Reads a response's first bytes while they pass on to the page unchanged (Firefox's
 * webRequest.filterResponseData), and lets the response go as soon as they tell a manifest or not.
 * @param {(requestId: string) => StreamFilterLike} open
 * @param {string} requestId
 * @return {Promise<?string>} The player mode, or null.
 */
export function sniffManifest(open, requestId) {
  return new Promise((resolve) => {
    /** @type {StreamFilterLike} */
    let filter;
    try {
      filter = open(requestId);
    } catch (e) {
      resolve(null);
      return;
    }
    const decoder = new TextDecoder();
    let text = '';
    let settled = false;
    /**
     * @param {?string} mode
     * @param {boolean} detach - Whether the rest of the response goes on without the filter.
     */
    const settle = (mode, detach) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (detach) {
        try {
          filter.disconnect();
        } catch (e) {
          // Already ended.
        }
      }
      resolve(mode);
    };
    const timer = setTimeout(() => settle(null, true), SNIFF_GIVE_UP_MS);
    filter.ondata = (event) => {
      filter.write(event.data);
      if (settled) return;
      const take = Math.min(event.data.byteLength, Math.max(SNIFF_BYTES - text.length, 0));
      text += decoder.decode(new Uint8Array(event.data, 0, take), {stream: true});
      const mode = modeFromBody(text, false);
      if (mode !== undefined) settle(mode, true);
    };
    filter.onstop = () => {
      settle(modeFromBody(text, true) ?? null, false);
      filter.close();
    };
    filter.onerror = () => settle(null, false);
  });
}
