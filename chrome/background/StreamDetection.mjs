// @ts-check
import {URLUtils} from '../player/utils/URLUtils.mjs';
import {modeFromContentType, modeFromMediaType} from './ManifestTypes.mjs';

/** @typedef {import('./MultiRegexMatcher.mjs').MultiRegexMatcher} MultiRegexMatcher */
/** @typedef {{kind: 'ignore'}|{kind: 'subtitles'}|{kind: 'source', mode: string}} ResponseKind */

/**
 * @param {string} ext
 * @return {boolean}
 */
export function isSubtitles(ext) {
  return ext === 'vtt' || ext === 'srt';
}

/** @type {ResponseKind} */
const IGNORE = Object.freeze({kind: 'ignore'});

/**
 * @param {{url: string, requestId: string|number, statusCode: number, method?: string, type?: string,
 *   responseHeaders?: Array<{name: string, value?: string}>}} details
 * @param {?string} first
 * @param {MultiRegexMatcher} matcher
 * @return {ResponseKind}
 */
export function classifyResponse(details, first, matcher) {
  const url = details.url;

  if ((details.statusCode >= 400 && details.statusCode < 600) || details.statusCode === 204) {
    return IGNORE;
  }
  if (isRedirect(details)) {
    return IGNORE; // The request's response at the end of the redirect is the stream.
  }
  // A CORS preflight or a HEAD carries no stream; the request after it has the headers to fetch it with.
  if (details.method === 'OPTIONS' || details.method === 'HEAD') {
    return IGNORE;
  }
  // A page is no stream, whatever its address names; a page load answered with the stream itself is not HTML.
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
      // Only for a player's fetch or a page load: a tracking pixel's query often names the media it reports on.
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
 * @param {string} url
 * @param {MultiRegexMatcher} matcher
 * @return {string}
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
 * The mode a proxy URL names in its query: proxy?url=https://cdn/.../index.m3u8.
 * @param {string} url
 * @param {MultiRegexMatcher} matcher
 * @return {?string}
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
 * @param {Array<{name: string, value?: string}>} [headers]
 * @return {boolean}
 */
export function isHtmlResponse(headers) {
  const contentType = headers?.find((header) => header.name.toLowerCase() === 'content-type');
  const type = contentType?.value?.split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}
/**
 * Only the statuses Firefox follows, to a Location; 304 is the file itself, from the cache.
 * @param {{statusCode: number, responseHeaders?: Array<{name: string, value?: string}>}} details
 * @return {boolean}
 */
export function isRedirect(details) {
  return [301, 302, 303, 307, 308].includes(details.statusCode) &&
    !!details.responseHeaders?.some((header) => header.name.toLowerCase() === 'location');
}
/**
 * For an address that names no type: what the redirect's first address named (.../master.m3u8 to /v/7?token).
 * @param {?string} first
 * @param {{requestId: string|number, type?: string, responseHeaders?: Array<{name: string, value?: string}>}} details
 * @param {string} ext
 * @param {MultiRegexMatcher} matcher
 * @return {string}
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
 * @param {?string} first
 * @param {{requestId: string|number, responseHeaders?: Array<{name: string, value?: string}>}} details
 * @param {MultiRegexMatcher} matcher
 * @return {?string}
 */
export function modeFromRedirectQuery(first, details, matcher) {
  return first && !isHtmlResponse(details.responseHeaders) ? modeFromQuery(first, matcher) : null;
}
