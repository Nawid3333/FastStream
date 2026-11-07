// @ts-check
// How the background tells a stream or a subtitle file from the rest of a page's responses
// (webRequest's onHeadersReceived, in background.mjs): pure functions, the custom source
// patterns and a redirect's first address given to them. Moved out of background.mjs
// (2026-11-07) so they can be tested by themselves (StreamDetection.test.mjs).
import {URLUtils} from '../player/utils/URLUtils.mjs';
import {modeFromContentType, modeFromMediaType} from './ManifestTypes.mjs';

/** @typedef {import('./MultiRegexMatcher.mjs').MultiRegexMatcher} MultiRegexMatcher */
/** @typedef {{kind: 'ignore'}|{kind: 'subtitles'}|{kind: 'source', mode: string}} ResponseKind */

/**
 * Whether a file extension or type is a subtitle file's.
 * @param {string} ext - A file extension or type (urlType).
 * @return {boolean}
 */
export function isSubtitles(ext) {
  return ext === 'vtt' || ext === 'srt';
}

/** @type {ResponseKind} */
const IGNORE = Object.freeze({kind: 'ignore'});

/**
 * What a response webRequest saw is to the detection (background.mjs's onHeadersReceived, which
 * acts on it): nothing, a subtitle file, or a stream and the player mode it plays in.
 * @param {{url: string, requestId: string|number, statusCode: number, method?: string, type?: string,
 *   responseHeaders?: Array<{name: string, value?: string}>}} details - webRequest's.
 * @param {?string} first - Where the request was first sent, if it was redirected (TabHolder.redirectOrigin).
 * @param {MultiRegexMatcher} matcher - The custom source patterns (the options).
 * @return {ResponseKind}
 */
export function classifyResponse(details, first, matcher) {
  const url = details.url;

  if ((details.statusCode >= 400 && details.statusCode < 600) || details.statusCode === 204) {
    return IGNORE; // Client or server error. Ignore it
  }
  if (isRedirect(details)) {
    return IGNORE; // The request's response at the end of the redirect is the stream.
  }
  // A CORS preflight (OPTIONS), which Firefox shows add-ons, or a HEAD: no stream comes in
  // either, and the request after it, which does, has the headers to fetch it with. The
  // preflight's were taken for the stream's, a header of the page's own (a token) left out,
  // and the server refused the player.
  if (details.method === 'OPTIONS' || details.method === 'HEAD') {
    return IGNORE;
  }
  // A page is not a stream, whatever its address or query names: an embed page
  // (embed.php?file=https://cdn/.../index.m3u8), or a link run out, answered with the
  // hoster's "expired" page at …/clip.mp4. Taking it for the stream opened the player on
  // the page itself. The stream a page plays is detected by itself, when the page requests
  // it. A page load answered with the stream itself - a proxy link opened in a tab or an
  // iframe - is not HTML, and Firefox plays it in that load, with no request of its own to
  // detect. Not a player's fetch: a manifest a server calls text/html still plays there.
  if ((details.type === 'media' || details.type === 'main_frame' || details.type === 'sub_frame') &&
      isHtmlResponse(details.responseHeaders)) {
    return IGNORE;
  }
  const ext = redirectedType(first, details, urlType(url, matcher), matcher);

  if (isSubtitles(ext)) {
    return {kind: 'subtitles'};
  }

  let mode = URLUtils.getModeFromExtension(ext);
  if (!mode) {
    // A manifest whose URL names no type: its Content-Type does (ManifestTypes).
    mode = modeFromContentType(details.responseHeaders);
  }
  if (!mode) {
    if (details.type === 'media') {
      mode = modeFromMediaType(details.responseHeaders);
      if (!mode) {
        return IGNORE;
      }
    } else if (details.type === 'xmlhttprequest' || details.type === 'other' ||
        details.type === 'main_frame' || details.type === 'sub_frame') {
      // The query names the stream for a proxy a player fetches it through, and for a
      // page load answered with the stream itself (not HTML, above). Nothing else: a
      // tracking pixel, script or beacon often names the media URL it reports on in its
      // query, and was taken for the stream - opened in the player, sent to mpv ahead of
      // the real manifest. Or the query of the proxy link redirected here.
      mode = modeFromQuery(url, matcher) || modeFromRedirectQuery(first, details, matcher);
      if (!mode) {
        return IGNORE;
      }
    } else {
      return IGNORE;
    }
  }
  return {kind: 'source', mode};
}

/**
 * The type a URL names by itself: its file extension, or what a site's pattern says it
 * is (Vimeo's player config, the user's custom source patterns).
 * @param {string} url - A request's URL.
 * @param {MultiRegexMatcher} matcher - The custom source patterns (the options).
 * @return {string} The extension or type, for URLUtils.getModeFromExtension and
 *   BackgroundUtils.isSubtitles.
 */
export function urlType(url, matcher) {
  let ext = URLUtils.get_url_extension(url);
  if (URLUtils.hostnameMatches(url, 'player.vimeo.com') && (url.includes('config?') || url.includes('video'))) {
    ext = 'vmpatch';
  }

  const output = matcher.match(url);
  if (output) {
    ext = output;
  }
  return ext;
}
/**
 * The mode of a stream fetched through a proxy, which names it in the query string:
 * proxy?url=https://cdn/.../index.m3u8.
 * @param {string} url - The proxy request's URL.
 * @param {MultiRegexMatcher} matcher - The custom source patterns (the options).
 * @return {?string} The stream's player mode, or null when the query names none.
 */
export function modeFromQuery(url, matcher) {
  for (const value of URLUtils.get_url_params(url).values()) {
    if (!URLUtils.is_url(value)) continue;
    let ext = URLUtils.get_url_extension(value);

    const output = matcher.match(value);
    if (output) {
      ext = output;
    }

    const mode = URLUtils.getModeFromExtension(ext);
    if (mode) {
      return mode;
    }
  }
  return null;
}
/**
 * Whether a response is an HTML page, by its Content-Type.
 * @param {Array<{name: string, value?: string}>} [headers] - webRequest's responseHeaders.
 * @return {boolean} True for text/html and application/xhtml+xml.
 */
export function isHtmlResponse(headers) {
  const contentType = headers?.find((header) => header.name.toLowerCase() === 'content-type');
  const type = contentType?.value?.split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}
/**
 * Whether a response is a redirect, which the request follows to another address: no stream,
 * though its address names one (a hoster's …/clip.mp4 link to its CDN). Taken for the stream,
 * the player played the link, and the redirect at each of its requests went to the CDN without
 * the page's Referer, which was set for the link (refused by a CDN that checks it); a CDN slower
 * than the player's opening delay was never seen, the frame having a player by its answer; and a
 * link run out, redirected to the hoster's "expired" page, opened a player on it (upstream #585).
 * Only the statuses Firefox follows, to a Location: without one, the response is the file
 * (glm's review, 2026-10-28). 304 Not Modified is the file itself, from the cache.
 * @param {{statusCode: number, responseHeaders?: Array<{name: string, value?: string}>}} details -
 *   webRequest's.
 * @return {boolean}
 */
export function isRedirect(details) {
  return [301, 302, 303, 307, 308].includes(details.statusCode) &&
    !!details.responseHeaders?.some((header) => header.name.toLowerCase() === 'location');
}
/**
 * The type a redirected request's first address names, for a response whose own address names
 * none: …/master.m3u8 redirected to the CDN's /v/7?token. Not for a page (the link run out, sent
 * to the hoster's "expired" page), nor a manifest its Content-Type names, nor a media element's
 * file, whose Content-Type tells video from audio (modeFromMediaType).
 * @param {?string} first - The redirected request's first address (TabHolder.redirectOrigin), or null.
 * @param {{requestId: string|number, type?: string, responseHeaders?: Array<{name: string, value?: string}>}} details -
 *   webRequest's.
 * @param {string} ext - What the response's own address names (urlType).
 * @param {MultiRegexMatcher} matcher - The custom source patterns (the options).
 * @return {string} The type to go by: ext, or the first address's.
 */
export function redirectedType(first, details, ext, matcher) {
  const namesType = (/** @type {string} */ type) => !!URLUtils.getModeFromExtension(type) || isSubtitles(type);
  if (!first || namesType(ext) || details.type === 'media' || isHtmlResponse(details.responseHeaders) ||
      modeFromContentType(details.responseHeaders)) {
    return ext;
  }
  const firstType = urlType(first, matcher);
  return namesType(firstType) ? firstType : ext;
}
/**
 * The mode the query of a redirected request's first address names (modeFromQuery), for a
 * proxy link redirected to an address that names none: proxy?url=https://cdn/.../index.m3u8 to
 * the CDN's /s/9f3e, answered application/octet-stream. Not for a page it led to.
 * @param {?string} first - The redirected request's first address (TabHolder.redirectOrigin), or null.
 * @param {{requestId: string|number, responseHeaders?: Array<{name: string, value?: string}>}} details -
 *   webRequest's.
 * @param {MultiRegexMatcher} matcher - The custom source patterns (the options).
 * @return {?string}
 */
export function modeFromRedirectQuery(first, details, matcher) {
  return first && !isHtmlResponse(details.responseHeaders) ? modeFromQuery(first, matcher) : null;
}
