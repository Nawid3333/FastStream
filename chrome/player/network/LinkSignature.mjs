// @ts-check
/**
 * A link's signature: the query parameters a hoster gives new values each time it issues the
 * link. vidmoly's ?t=<token>&s=<issued>&e=43200 comes with another t and s at every load of
 * its page, and every file of the video carries them too, so a download made under one issue
 * of the link was not found under the next (a reload, a fresh link): every file was
 * downloaded again. A file is the same under either issue when its address is, the signature
 * left out. Only the parameters that changed are the signature: one that did not (a segment's
 * ?n=5) still tells two files apart.
 */

/**
 * The names of the query parameters whose values differ between two issues of one link.
 * @param {string} oldUrl - The link as it was.
 * @param {string} newUrl - The link as it is now.
 * @return {?Set<string>} The names; empty for the same link; null when they are not one link
 *   (another scheme, host or path), whose files then match only by their whole addresses.
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
 * A file's address without the link's signature: the same for the file under any issue of the
 * link. Only ever compared, never fetched: the parameters left are written as the URL parser
 * writes them, which is the same for both issues.
 * @param {string} url - The file's address.
 * @param {?Set<string>} signature - signatureParams; none or empty leaves the address whole.
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
