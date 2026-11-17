// @ts-check

/** Ports of the thin helper's functions, same output byte for byte (tests/unit/MpvTarget.test.mjs). */

/**
 * As a reader counts characters: cut between code points, mpv drew a broken character.
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
 * The helper refuses a text over its limit in UTF-16 units, and one character can be many.
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
 * http(s) only, the string itself starting with the scheme: a UNC path makes Windows sign in with the user's credentials.
 * @param {*} url
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
 * A fragment never reaches the server, so a signed CDN URL stays valid.
 * @param {string} streamUrl
 * @param {string} tag
 * @return {string}
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
 * mpv's scripts must never read a tag a page made up: a forged fs-id would move another site's resume position.
 * @param {string} streamUrl
 * @return {string}
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
 * @param {string} streamUrl
 * @param {*} [contentType]
 * @return {string}
 */
export function withContentTypeFragment(streamUrl, contentType) {
  if (contentType !== 'anime' && contentType !== 'movie') {
    return streamUrl;
  }
  return withFragmentTag(streamUrl, `fs-content=${contentType}`);
}

/**
 * The first 16 hex digits of the page URL's SHA-256 (UTF-8), as the helper made it.
 * @param {*} [pageUrl]
 * @return {Promise<string|undefined>}
 */
export async function resumeIdFor(pageUrl) {
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) {
    return undefined;
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pageUrl));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {*} [pageUrl]
 * @return {string|undefined}
 */
export function pageFragmentFor(pageUrl) {
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) {
    return undefined;
  }
  return encodeURIComponent(pageUrl);
}

const MaxQualities = 12;
const MaxQualityUrlChars = 2048;

/**
 * A percent-encoded JSON array of {label, height, url} for faststream-quality.lua, at least two.
 * @param {*} qualities
 * @return {string|undefined}
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
 * The stream URL as the URL parser writes it, plus its fs-* fragment tags in that order (fs-quality last).
 * @param {{url: string, contentType?: *, pageUrl?: *, qualities?: *, private?: *}} stream
 * @return {Promise<string>}
 */
export async function mpvTargetUrl(stream) {
  const target = withContentTypeFragment(withoutFsTags(new URL(stream.url).href), stream.contentType);
  const resumeId = await resumeIdFor(stream.pageUrl);
  const withId = resumeId ? withFragmentTag(target, `fs-id=${resumeId}`) : target;
  const withPrivate = stream.private === true ? withFragmentTag(withId, 'fs-private=1') : withId;
  const pageFragment = pageFragmentFor(stream.pageUrl);
  const withPage = pageFragment ? withFragmentTag(withPrivate, `fs-page=${pageFragment}`) : withPrivate;
  const qualities = qualityFragmentFor(stream.qualities);
  return qualities ? withFragmentTag(withPage, `fs-quality=${qualities}`) : withPage;
}

/**
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
 * @param {*} headers
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
 * @param {{start?: *}} stream
 * @return {number|undefined}
 */
export function startOf(stream) {
  const t = stream.start;
  return typeof t === 'number' && Number.isFinite(t) && t >= 1 && t < 1e7 ?
    Math.floor(t * 1000) / 1000 : undefined;
}
