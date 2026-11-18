// @ts-check

// A stream's address can carry a key its server asks of every file (/pl/7?token=...) while its
// playlists list the files without it: the site's own player adds it to each request. Once a file
// from the stream's own server is refused for the lack of it, that file is asked again with it; once
// such a retry is given the file, every later file from that server gets it before it is asked for.
// Never to another server.

/** @type {?URL} */
let stream = null;
let active = false;

/**
 * @param {string} url
 * @return {?URL}
 */
function parse(url) {
  try {
    return new URL(url);
  } catch (e) {
    return null;
  }
}

/**
 * url with the names of key's query it lacks; null when it lacks none or is another server's.
 * @param {?URL} key - An address whose query its server asks of every file.
 * @param {string} url
 * @return {?string}
 */
export function withKeyOf(key, url) {
  const target = key && parse(url);
  if (!key || !target || target.origin !== key.origin) return null;
  let added = false;
  for (const [name, value] of key.searchParams) {
    if (!target.searchParams.has(name)) {
      target.searchParams.append(name, value);
      added = true;
    }
  }
  return added ? target.href : null;
}

export const StreamQuery = {
  /**
   * The address of the stream now played; null for none.
   * @param {?string} url
   */
  configure(url) {
    const parsed = url ? parse(url) : null;
    stream = parsed && parsed.search.length > 1 ? parsed : null;
    active = false;
  },

  /**
   * The url with the stream query's names it lacks; null when it lacks none or is another server's.
   * @param {string} url
   * @return {?string}
   */
  withQuery(url) {
    return withKeyOf(stream, url);
  },

  /**
   * For a refused url: the address to ask again with.
   * @param {string} url
   * @return {?string}
   */
  retryFor(url) {
    return this.withQuery(url);
  },

  /** A file asked again with the key was given: apply() adds it from now on. */
  confirm() {
    if (stream) active = true;
  },

  /**
   * The address to ask for a url by.
   * @param {string} url
   * @return {string}
   */
  apply(url) {
    return (active && this.withQuery(url)) || url;
  },
};
