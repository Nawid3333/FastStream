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
 * How many of the refused link's parameters a link has as they were: a hoster changes its
 * signature and issue time, and keeps the rest (vidmoly: e, srv, i, asn…).
 * @param {URL} link
 * @param {URL} dead
 * @return {number}
 */
function keptParameters(link, dead) {
  let kept = 0;
  for (const [name, value] of link.searchParams) {
    if (name !== 'faststream-timestamp' && dead.searchParams.getAll(name).includes(value)) kept++;
  }
  return kept;
}

/**
 * The link to the same stream in a page's text, other than the one refused: the same host and
 * path. Of several, the one that kept most of the refused link's parameters (a page can name
 * the next episode too, with the same path and its own id), and none when two keep as many.
 * Links in a script's strings count too (https:\/\/…, &), and in the page's HTML (&amp;):
 * each read as it is written there, never unescaped twice.
 * @param {string} text - The page.
 * @param {string} refused - The link the server refused.
 * @return {?string} The new link, or null when the page has none other, or no one best.
 */
export function findFreshLink(text, refused) {
  let dead;
  try {
    dead = new URL(refused);
  } catch (e) {
    return null;
  }
  const old = URLUtils.withTimestamp(refused, null);
  /** @type {Map<string, number>} */
  const found = new Map();
  const readings = [text, text.replace(/\\\//g, '/').replace(/\\u0026/gi, '&'), text.replace(/&amp;/g, '&')];
  for (const page of readings) {
    for (const match of page.matchAll(/https?:\/\/[^\s"'<>`\\]+/g)) {
      // As the page wrote it: a signed link is taken byte for byte (URLUtils.withTimestamp).
      const link = match[0].replace(/[.,;)]+$/, '');
      // Still escaped here (&amp;), or cut at a script's escape (&): the reading for that
      // escape has it whole.
      if (link.includes('&amp;') || page[/** @type {number} */ (match.index) + match[0].length] === '\\') continue;
      let candidate;
      try {
        candidate = new URL(link);
      } catch (e) {
        continue;
      }
      if (candidate.host === dead.host && candidate.pathname === dead.pathname && link !== old) {
        found.set(link, keptParameters(candidate, dead));
      }
    }
  }
  const best = Math.max(-1, ...found.values());
  const bests = [...found].filter(([, kept]) => kept === best).map(([link]) => link);
  return bests.length === 1 ? bests[0] : null;
}

/**
 * A page's text, at most MAX_PAGE_LENGTH of it, read as it comes: a huge answer is not held
 * whole. Nothing for a stream or a picture opened as a page, which names no link.
 * @param {Response} response
 * @return {Promise<string>}
 */
async function readPage(response) {
  const type = response.headers.get('Content-Type') || '';
  if (type && !/text|html|json|javascript|xml/i.test(type)) return '';
  if (!response.body) return (await response.text()).slice(0, MAX_PAGE_LENGTH);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < MAX_PAGE_LENGTH) {
      const {done, value} = await reader.read();
      if (done) break;
      text += decoder.decode(value, {stream: true});
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text.slice(0, MAX_PAGE_LENGTH);
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
      const fresh = findFreshLink(await readPage(response), refused);
      if (fresh) return fresh;
    } catch (e) {
      console.warn('Could not fetch a page for a new link', page, e);
    }
  }
  return null;
}
