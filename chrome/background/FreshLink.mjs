// @ts-check
import {URLUtils} from '../player/utils/URLUtils.mjs';

// Firefox's Back gives a page its old document, and with it an old signed link: the page is fetched anew for a fresh one.

const MAX_PAGE_LENGTH = 4 * 1024 * 1024;

const PAGE_TIMEOUT_MS = 15000;

/**
 * A hoster changes its link's signature and issue time, and keeps the rest.
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
 * Same host and path; of several, the one that kept most parameters (none on a tie).
 * @param {string} text
 * @param {string} refused
 * @return {?string}
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
      // As the page wrote it: a signed link is taken byte for byte.
      const link = match[0].replace(/[.,;)]+$/, '');
      // Still escaped, or cut at a script's escape: that escape's own reading has it whole.
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
 * Read as it comes, at most MAX_PAGE_LENGTH: a huge answer is not held whole.
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
 * @param {string[]} pages
 * @param {string} refused
 * @param {typeof fetch} [fetchPage]
 * @return {Promise<?string>}
 */
export async function fetchFreshLink(pages, refused, fetchPage = fetch) {
  for (const page of pages) {
    try {
      // As the page asks: with its site's cookies.
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
