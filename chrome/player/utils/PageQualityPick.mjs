// @ts-check

// Which of the qualities a page's own player offers as files of their own (page-qualities.js)
// is played: by FastStream's player, and by mpv. The page plays its default, often the lowest
// (a film site's hoster: Playerjs with default_quality "360p" and 720p and 1080p files beside
// it); the user's quality setting decides here, as it does among an HLS or DASH stream's levels.

/**
 * The height the user's quality setting asks for.
 * @param {*} defaultQuality - The option: 'Auto' (the highest), or e.g. '720p'.
 * @return {number} Infinity for Auto, or anything unreadable.
 */
export function desiredHeight(defaultQuality) {
  const height = parseInt(String(defaultQuality ?? '').replace(/p$/i, ''), 10);
  return Number.isFinite(height) && height > 0 ? height : Infinity;
}

/**
 * A URL's host, or null.
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
 * The page's list that holds a source's file: by its URL, or by the address its request was
 * first made to before a redirect (a hoster's get_file/... link, played from a CDN's). Only its
 * files on the host of the one the page plays: they are fetched with that request's headers,
 * and a script in the page could list a file anywhere.
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
    // None beside it on its host: a later list may hold it too (the <video>'s own <source>
    // elements come first, the page's player's list after them).
    if (sameHost.length >= 2) {
      return /** @type {Array<{url: string, label: string, height: number}>} */ (sameHost);
    }
  }
  return null;
}

/**
 * The entry to play for a height: the smallest at or above it, else the highest below
 * (LevelManager.matchQuality's rule, so Auto - Infinity - is the highest).
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
