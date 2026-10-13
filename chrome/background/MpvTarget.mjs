// @ts-check

/**
 * What mpv is given for a stream, built here for the thin mpv helper (host 15).
 *
 * Until host 14 the helper (native-host/faststream-mpv-host.mjs) built all of this itself
 * from the extension's `open` message: the URL with its fs-* fragment tags, the title, the
 * header list, the start. Each change to that policy was a new helper, and a helper is
 * installed by hand: 14 versions in 10 days, each one a reinstall for the owner. So he chose
 * (2026-10-13) a thin helper that keeps only the mechanics (start mpv, talk over its pipe,
 * allowlisted commands), and the policy moved here, where it updates with the extension.
 *
 * Every function below is a port of the helper's function of the same name and gives the
 * same output for the same input, byte for byte (tests/unit/MpvTarget.test.mjs compares
 * them with the helper's own): mpv's scripts read these tags (stream-resume.lua the fs-id,
 * source-info.lua the fs-page, faststream-quality.lua the fs-quality, gpu-toggles.lua the
 * fs-content), and a resume position saved under host 14's fs-id is found again under the
 * extension's.
 */

/**
 * The first `max` characters of a text, as a reader counts them: a flag or an emoji joined
 * from several is one. Cut between its code points, a part of it was left, which mpv drew
 * as a broken character (#470; glm's review of the fix, 2026-10-13).
 * @param {string} text
 * @param {number} max
 * @return {string}
 */
export function cutText(text, max) {
  let out = '';
  let count = 0;
  for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)) {
    if (count++ === max) break;
    out += segment;
  }
  return out;
}

/**
 * A text of at most `max` UTF-16 units, cut between whole characters (cutText). The helper
 * refuses a title or a notice over its limit in units, and one character as a reader counts
 * it can be any number of units (a letter with a pile of combining marks).
 * @param {string} text
 * @param {number} max
 * @return {string}
 */
export function cutToLength(text, max) {
  if (text.length <= max) {
    return text;
  }
  let out = '';
  for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

/**
 * Whether a URL may be handed to mpv: http or https, and nothing else. mpv opens local files
 * and UNC paths too, and a UNC path makes Windows sign in to that host with the user's
 * credentials. The string itself has to start with the scheme: the URL parser alone would
 * read `https:\\host\share` as https://host/share.
 * @param {*} url - The candidate.
 * @return {boolean}
 */
export function isStreamUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return false;
  }
  try {
    const {protocol} = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Appends a key=value tag to a URL's fragment. A URL fragment is never sent to the HTTP
 * server, so this cannot break a signed CDN URL, and mpv's scripts read it back off the
 * `path` property.
 * @param {string} streamUrl - The stream URL headed to mpv.
 * @param {string} tag - The tag, e.g. `fs-content=anime`.
 * @return {string} The URL with the tag appended.
 */
function withFragmentTag(streamUrl, tag) {
  const hashIndex = streamUrl.indexOf('#');
  if (hashIndex === -1) {
    return `${streamUrl}#${tag}`;
  }
  const existingFragment = streamUrl.slice(hashIndex + 1);
  return existingFragment.length > 0 ? `${streamUrl}&${tag}` : `${streamUrl}${tag}`;
}

/**
 * Drops fs-* tags a stream URL already carries in its fragment. The tags built here come
 * after them, and mpv's scripts must never read one a page made up (a stream URL can come
 * from a page): a forged fs-id= would move another site's resume position, a forged fs-page=
 * the "Site page" link.
 * @param {string} streamUrl - The stream URL.
 * @return {string} The URL without fs-* fragment tags.
 */
export function withoutFsTags(streamUrl) {
  const hashIndex = streamUrl.indexOf('#');
  if (hashIndex === -1) {
    return streamUrl;
  }
  const kept = streamUrl.slice(hashIndex + 1).split('&')
      .filter((part) => !/^fs-/i.test(part));
  return kept.some(Boolean) ?
    streamUrl.slice(0, hashIndex + 1) + kept.join('&') :
    streamUrl.slice(0, hashIndex);
}

/**
 * Appends an fs-content=anime|movie marker to a stream URL's fragment, for gpu-toggles.lua's
 * content-aware shader selection.
 * @param {string} streamUrl - The stream URL headed to mpv.
 * @param {*} [contentType] - 'anime' or 'movie'; anything else leaves the URL as it is.
 * @return {string}
 */
export function withContentTypeFragment(streamUrl, contentType) {
  if (contentType !== 'anime' && contentType !== 'movie') {
    return streamUrl;
  }
  return withFragmentTag(streamUrl, `fs-content=${contentType}`);
}

/**
 * The resume key for a page (fs-id=, stream-resume.lua): the first 16 hex digits of its URL's
 * SHA-256, as the helper's node:crypto made it (the text as UTF-8; a lone surrogate as
 * U+FFFD, which TextEncoder writes too). Async: crypto.subtle is what the extension has.
 * @param {*} [pageUrl] - The tab's page URL.
 * @return {Promise<string|undefined>} The key; undefined for a missing or non-http(s) URL.
 */
export async function resumeIdFor(pageUrl) {
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) {
    return undefined;
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pageUrl));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The page URL percent-encoded as one fragment tag value (fs-page=, source-info.lua's
 * "Site page" entry). http(s) pages only.
 * @param {*} [pageUrl] - The tab's page URL.
 * @return {string|undefined}
 */
export function pageFragmentFor(pageUrl) {
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) {
    return undefined;
  }
  return encodeURIComponent(pageUrl);
}

// The qualities of the page's player, at most, and the longest file address taken.
const MaxQualities = 12;
const MaxQualityUrlChars = 2048;

/**
 * The page's qualities as one fragment tag value (fs-quality=) for mpv's
 * faststream-quality.lua: a JSON array of {label, height, url}, percent-encoded. http(s)
 * files of at most MaxQualityUrlChars, each as the URL parser writes it without a fragment
 * (the script finds the playing one by mpv's path up to its first '#'), a label of at most
 * 40 characters without control characters, a whole height or 0, at least two of them.
 * @param {*} qualities - [{url, label, height}] (MpvBackend.relayQualities).
 * @return {string|undefined} The tag's value, or undefined without a usable list.
 */
export function qualityFragmentFor(qualities) {
  if (!Array.isArray(qualities)) {
    return undefined;
  }
  const list = [];
  for (const entry of qualities.slice(0, MaxQualities)) {
    if (!entry || !isStreamUrl(entry.url) || entry.url.length > MaxQualityUrlChars) {
      continue;
    }
    const label = typeof entry.label === 'string' ?
      cutText(entry.label.replace(/[\x00-\x1f\x7f]/g, ' ').trim(), 40) : '';
    const height = Number.isInteger(entry.height) && entry.height > 0 && entry.height <= 10000 ? entry.height : 0;
    const parsed = new URL(entry.url);
    parsed.hash = '';
    list.push({label, height, url: parsed.href});
  }
  return list.length >= 2 ? encodeURIComponent(JSON.stringify(list)) : undefined;
}

/**
 * The URL to hand mpv: the stream URL as the URL parser writes it (the form a browser
 * requests: tabs and newlines dropped, spaces and the like percent-encoded), plus its
 * fs-content=, fs-id=, fs-page= and fs-quality= fragment tags, in that order (fs-quality
 * last, the longest).
 * @param {{url: string, contentType?: *, pageUrl?: *, qualities?: *}} stream - url passed
 *   isStreamUrl.
 * @return {Promise<string>}
 */
export async function mpvTargetUrl(stream) {
  const target = withContentTypeFragment(withoutFsTags(new URL(stream.url).href), stream.contentType);
  const resumeId = await resumeIdFor(stream.pageUrl);
  const withId = resumeId ? withFragmentTag(target, `fs-id=${resumeId}`) : target;
  const pageFragment = pageFragmentFor(stream.pageUrl);
  const withPage = pageFragment ? withFragmentTag(withId, `fs-page=${pageFragment}`) : withId;
  const qualities = qualityFragmentFor(stream.qualities);
  return qualities ? withFragmentTag(withPage, `fs-quality=${qualities}`) : withPage;
}

/**
 * The title mpv shows for a stream (window, taskbar, uosc's top bar): the tab's title, one
 * line, at most 200 characters (whole ones, #470), or else the stream's host name.
 * @param {{url: string, title?: *}} stream
 * @return {string}
 */
export function streamTitle(stream) {
  if (typeof stream.title === 'string') {
    const oneLine = Array.from(stream.title, (c) => {
      const code = c.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : c;
    }).join('').replace(/\s+/g, ' ').trim();
    const clean = cutText(oneLine, 200);
    if (clean) {
      return clean;
    }
  }
  try {
    return new URL(stream.url).hostname || 'FastStream';
  } catch (e) {
    return 'FastStream';
  }
}

// The headers mpv is given (MpvBackend.pickRelayHeaders picks them from the request).
const RelayHeaderNames = /^(referer|origin|user-agent)$/i;
// Printable ASCII only: no CR/LF (a second header in mpv's request), no NUL.
const RelayHeaderValue = /^[ -~]{1,4096}$/;

/**
 * The "Name: value" fields mpv is given for a list of headers: Referer, Origin and
 * User-Agent with printable ASCII values; the rest is dropped.
 * @param {*} headers - [{name, value}].
 * @return {Array<string>}
 */
export function relayHeaderFields(headers) {
  if (!Array.isArray(headers)) {
    return [];
  }
  const fields = [];
  for (const header of headers) {
    if (header && typeof header.name === 'string' && typeof header.value === 'string' &&
        RelayHeaderNames.test(header.name) && RelayHeaderValue.test(header.value)) {
      fields.push(`${header.name}: ${header.value}`);
    }
  }
  return fields;
}

/**
 * The position to start the stream at, when one is usable.
 * @param {{start?: *}} stream
 * @return {number|undefined} Seconds (millisecond precision), or undefined.
 */
export function startOf(stream) {
  const t = stream.start;
  return typeof t === 'number' && Number.isFinite(t) && t >= 1 && t < 1e7 ?
    Math.floor(t * 1000) / 1000 : undefined;
}
