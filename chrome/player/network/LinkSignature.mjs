// @ts-check
// A link's signature: the query parameters a hoster gives new values at each issue of the link.

/**
 * @param {string} oldUrl
 * @param {string} newUrl
 * @return {?Set<string>} Empty for the same link; null for another scheme, host or path.
 */
export function signatureParams(oldUrl, newUrl) {
  let before;
  let after;
  try {
    before = new URL(oldUrl);
    after = new URL(newUrl);
  } catch (e) {
    return null;
  }
  if (before.origin !== after.origin || before.pathname !== after.pathname) {
    return null;
  }
  const changed = new Set();
  for (const name of new Set([...before.searchParams.keys(), ...after.searchParams.keys()])) {
    const was = before.searchParams.getAll(name);
    const is = after.searchParams.getAll(name);
    if (was.length !== is.length || was.some((value, i) => value !== is[i])) {
      changed.add(name);
    }
  }
  return changed;
}

/**
 * Compared only, never fetched.
 * @param {string} url
 * @param {?Set<string>} signature
 * @return {string}
 */
export function withoutSignature(url, signature) {
  if (!signature || signature.size === 0) {
    return url;
  }
  try {
    const parsed = new URL(url);
    for (const name of signature) {
      parsed.searchParams.delete(name);
    }
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

/**
 * How a hoster issued a stream's link anew: the query parameters it signs (signatureParams), and beyond the query
 * another host (a CDN's next node) or tokens in the path (a path segment of the same place with another value).
 * @typedef {Object} LinkChange
 * @property {string} oldStream - The stream's old link, without its fragment.
 * @property {string} newStream
 * @property {string} oldOrigin
 * @property {string} newOrigin
 * @property {Set<string>} oldTokens - The old link's path segments that changed.
 * @property {Set<string>} newTokens
 * @property {Set<string>} params - The query parameters whose values changed.
 * @property {boolean} samePlace - The same host and path: only the query changed, which says it is the same file.
 */

/**
 * @param {string} oldUrl
 * @param {string} newUrl
 * @return {?LinkChange} Null for links that are not http(s).
 */
export function linkChange(oldUrl, newUrl) {
  let before;
  let after;
  try {
    before = new URL(oldUrl);
    after = new URL(newUrl);
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(before.protocol) || !/^https?:$/.test(after.protocol)) return null;
  const oldParts = before.pathname.split('/');
  const newParts = after.pathname.split('/');
  const oldTokens = new Set();
  const newTokens = new Set();
  // Tokens only where the paths line up: segment by segment, the same depth.
  if (oldParts.length === newParts.length) {
    oldParts.forEach((part, i) => {
      if (part && newParts[i] && part !== newParts[i]) {
        oldTokens.add(part);
        newTokens.add(newParts[i]);
      }
    });
  }
  const params = new Set();
  for (const name of new Set([...before.searchParams.keys(), ...after.searchParams.keys()])) {
    const was = before.searchParams.getAll(name);
    const is = after.searchParams.getAll(name);
    if (was.length !== is.length || was.some((value, i) => value !== is[i])) params.add(name);
  }
  return {
    oldStream: oldUrl.split('#')[0],
    newStream: newUrl.split('#')[0],
    oldOrigin: before.origin,
    newOrigin: after.origin,
    oldTokens,
    newTokens,
    params,
    samePlace: before.origin === after.origin && before.pathname === after.pathname,
  };
}

/**
 * A link with what the change issued anew left out, the same for a part under the old link and under the new one:
 * compared only, never fetched. The stream's own link stands for itself (a file whose whole link changed).
 * @param {string} url
 * @param {LinkChange} change
 * @param {boolean} old - Whether the link is one of the old stream's.
 * @return {string}
 */
export function looseLink(url, change, old) {
  const [withoutHash, ...hash] = url.split('#');
  const fragment = hash.length ? '#' + hash.join('#') : '';
  if (withoutHash === (old ? change.oldStream : change.newStream)) return 'stream:' + fragment;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return url;
  }
  const origin = old ? change.oldOrigin : change.newOrigin;
  const tokens = old ? change.oldTokens : change.newTokens;
  const host = change.oldOrigin !== change.newOrigin && parsed.origin === origin ? 'host:' : parsed.origin;
  const path = parsed.pathname.split('/').map((part) => tokens.has(part) ? 'token:' : part).join('/');
  for (const name of change.params) parsed.searchParams.delete(name);
  return host + path + parsed.search + fragment;
}
