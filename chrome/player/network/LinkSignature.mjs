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
