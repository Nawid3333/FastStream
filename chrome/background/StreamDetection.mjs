// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {URLUtils} from '../player/utils/URLUtils.mjs';
import {contentTypeOf, modeFromContentType, modeFromMediaType} from './ManifestTypes.mjs';

/** @typedef {import('./MultiRegexMatcher.mjs').MultiRegexMatcher} MultiRegexMatcher */
/** @typedef {{kind: 'ignore'}|{kind: 'subtitles'}|{kind: 'source', mode: string}} ResponseKind */

export const SUBTITLE_EXTENSIONS = ['vtt', 'srt', 'ttml', 'dfxp'];
const TTML_TYPES = ['application/ttml+xml', 'application/ttaf+xml'];

/**
 * @param {string} ext
 * @return {boolean}
 */
export function isSubtitles(ext) {
  return SUBTITLE_EXTENSIONS.includes(ext);
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

  // TTML is often served from an address that names no type; its media type is its own (DFXP's
  // older one, application/ttaf+xml). Other XML is no subtitles by its type alone.
  if (isSubtitles(ext) || TTML_TYPES.includes(contentTypeOf(details.responseHeaders))) {
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

// Types a server gives a manifest it does not name, and none at all.
const UNNAMED_TYPES = ['', 'text/plain', 'application/octet-stream', 'binary/octet-stream', 'application/binary'];
// Never a manifest, whatever their Content-Type says.
const NOT_MANIFEST_EXTENSIONS = ['js', 'mjs', 'json', 'css', 'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'avif', 'ico', 'woff', 'woff2', 'ttf', 'wasm', 'ts', 'm4s', 'mp4', 'aac', 'mp3'];
export const SNIFF_BYTES = 1024;

/**
 * Whether a response classifyResponse ignored can still be a manifest only its first bytes tell:
 * a player's 200 fetch of a type a server gives an unnamed playlist (text/plain, octet-stream).
 * @param {{url: string, statusCode: number, method?: string, type?: string,
 *   responseHeaders?: Array<{name: string, value?: string}>}} details
 * @return {boolean}
 */
export function worthSniffing(details) {
  if (details.statusCode !== 200 || (details.method && details.method !== 'GET')) return false;
  if (details.type !== 'xmlhttprequest' && details.type !== 'other') return false;
  if (!UNNAMED_TYPES.includes(contentTypeOf(details.responseHeaders))) return false;
  return !NOT_MANIFEST_EXTENSIONS.includes(URLUtils.get_url_extension(details.url));
}

const HLS_START = '#EXTM3U';

/**
 * The player mode a manifest's first bytes name: HLS by #EXTM3U and an #EXT-X- tag (an IPTV or
 * Winamp .m3u list has none), DASH by an <MPD> root.
 * @param {string} text - The body's first SNIFF_BYTES or fewer.
 * @param {boolean} complete - Whether text is the whole body.
 * @return {string|null|undefined} The mode; null for none; undefined while more bytes may tell.
 */
export function modeFromBody(text, complete) {
  const start = text.trimStart();
  const undecided = complete || text.length >= SNIFF_BYTES ? null : undefined;
  if (start.startsWith(HLS_START)) return start.includes('#EXT-X-') ? PlayerModes.ACCELERATED_HLS : undecided;
  if (HLS_START.startsWith(start)) return undecided;
  if (start[0] !== '<') return null;
  const root = start.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/^(<!--[\s\S]*?-->\s*)*/, '');
  if (/^<MPD[\s>]/.test(root)) return PlayerModes.ACCELERATED_DASH;
  // A prolog or comment not ended yet, or <MPD cut short.
  if (/^<(\?|!--)/.test(root) || '<!--'.startsWith(root) || '<MPD'.startsWith(root)) return undecided;
  return null;
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
