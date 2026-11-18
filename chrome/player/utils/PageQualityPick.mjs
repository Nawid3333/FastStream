// @ts-check

// The user's quality setting picks among the files a page's own player lists (page-qualities.js);
// the page itself plays its default, often the lowest.

/**
 * @param {*} defaultQuality - 'Auto' (the highest), or e.g. '720p'.
 * @return {number} Infinity for Auto, or anything unreadable.
 */
export function desiredHeight(defaultQuality) {
  const height = parseInt(String(defaultQuality ?? '').replace(/p$/i, ''), 10);
  return Number.isFinite(height) && height > 0 ? height : Infinity;
}

/**
 * @param {string} url
 * @return {?string}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return null;
  }
}

/**
 * The page's list holding a source's file, by its URL or its address before a redirect. Only
 * files on the played one's host: they get its request's headers, and a page script could list any URL.
 * @param {{url: string, requestedUrl?: ?string}} source
 * @param {Array<Array<{url: string}>>} lists - What the page holds (page-qualities.js).
 * @return {?Array<{url: string, label: string, height: number}>} At least two files, or null.
 */
export function listForSource(source, lists) {
  if (!source || !Array.isArray(lists)) return null;
  const urls = [source.url, source.requestedUrl].filter(Boolean);
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const played = list.find((entry) => entry && urls.includes(entry.url));
    if (!played) continue;
    const host = hostOf(played.url);
    const sameHost = list.filter((entry) => entry && hostOf(entry.url) === host);
    // A later list may hold it too (the <video>'s <source> elements come first).
    if (sameHost.length >= 2) {
      return /** @type {Array<{url: string, label: string, height: number}>} */ (sameHost);
    }
  }
  return null;
}

/**
 * The smallest entry at or above the height, else the highest below (LevelManager.matchQuality's rule).
 * @param {Array<{url: string, label: string, height: number}>} list
 * @param {number} height
 * @return {?{url: string, label: string, height: number}} Null when no entry says its height:
 *   the page's own choice stands.
 */
export function pickQuality(list, height) {
  const known = (list || []).filter((entry) => entry && entry.height > 0);
  if (known.length === 0) return null;
  const atOrAbove = known.filter((entry) => entry.height >= height).sort((a, b) => a.height - b.height);
  if (atOrAbove.length > 0) return atOrAbove[0];
  return known.sort((a, b) => b.height - a.height)[0];
}
