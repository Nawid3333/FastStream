// @ts-check
import {URLUtils} from '../player/utils/URLUtils.mjs';

// A stream link the server refuses (401, 403, 410) can often be had anew from the page that
// gave it: a hoster signs its link with the time it was issued and how long it holds (vidmoly:
// …/master.m3u8?t=<signature>&s=<issued>&e=43200, twelve hours), and every load of its page
// issues a new one for the same video. Firefox, on Back, gives a page's frame its old document
// from its cache without asking the server, however long its cache time is over (measured,
// Firefox 158), and so the link it had: a page left for hours played on until the old link ran
// out, and FastStream then sat at a spinner (issue #592). The user's fix was to reload the page
// and clear the cache. This is that, for the link only: the page's document fetched again, and
// in it the link to the same video, the same path with a new signature.

// How much of a page is read for its link: a hoster's embed page is a few dozen kB.
const MAX_PAGE_LENGTH = 4 * 1024 * 1024;

// How long the page may take.
const PAGE_TIMEOUT_MS = 15000;

/**
 * Whether two hosts are one service's: the same, or the same past their first label
 * (prx-1316-ant.vmget.online and prx-1402-ant.vmget.online: the proxy a page names can change).
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function sameService(a, b) {
  if (a === b) return true;
  const rest = (/** @type {string} */ host) => host.split('.').slice(1).join('.');
  return rest(a).includes('.') && rest(a) === rest(b);
}

/**
 * The link to the same stream in a page's text, other than the one refused: the same path, on
 * the same host or the same service's. Links in a script's strings count too (https:\/\/…,
 * &, &amp;).
 * @param {string} text - The page.
 * @param {string} refused - The link the server refused.
 * @return {?string} The new link, or null when the page has none other.
 */
export function findFreshLink(text, refused) {
  let dead;
  try {
    dead = new URL(refused);
  } catch (e) {
    return null;
  }
  const page = text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  for (const match of page.matchAll(/https?:\/\/[^\s"'<>`\\]+/g)) {
    // As the page wrote it: a signed link is taken byte for byte (URLUtils.withTimestamp).
    const link = match[0].replace(/[.,;)]+$/, '');
    let candidate;
    try {
      candidate = new URL(link);
    } catch (e) {
      continue;
    }
    if (candidate.pathname === dead.pathname && sameService(candidate.hostname, dead.hostname) &&
        link !== URLUtils.withTimestamp(refused, null)) {
      return link;
    }
  }
  return null;
}

/**
 * Fetches each page anew (no cache) and looks in it for a new link to the refused stream.
 * @param {string[]} pages - The pages' URLs, the likeliest first.
 * @param {string} refused - The link the server refused.
 * @param {typeof fetch} [fetchPage] - fetch, or a stand-in.
 * @return {Promise<?string>} The new link, or null when no page has one.
 */
export async function fetchFreshLink(pages, refused, fetchPage = fetch) {
  for (const page of pages) {
    try {
      // As the page itself asks: with its site's cookies, which a page may give its link for.
      const response = await fetchPage(page, {cache: 'no-store', credentials: 'include',
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)});
      if (!response.ok) continue;
      const text = await response.text();
      const fresh = findFreshLink(text.length > MAX_PAGE_LENGTH ? text.slice(0, MAX_PAGE_LENGTH) : text, refused);
      if (fresh) return fresh;
    } catch (e) {
      console.warn('Could not fetch a page for a new link', page, e);
    }
  }
  return null;
}
