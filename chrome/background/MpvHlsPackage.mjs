// @ts-check
import {withKeyOf} from '../player/network/StreamQuery.mjs';

// An HLS stream mpv cannot open from its address alone (docs/notes/mpv.md, "Streams mpv cannot open alone"):
// ffmpeg reads a playlist as HLS only by a .m3u8/.m3u name or an HLS media type, and never adds the key a
// server asks of every file (/pl/7?token=... listing /pl/7/a and page-0.html without it). FastStream's player
// handles both (sniffing, StreamQuery); for mpv its playlists go to the helper with every address made whole,
// and mpv plays them from files (helper 27, checkHlsPackage).

const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/mpegurl', 'audio/mpegurl',
  'audio/x-mpegurl'];
// The helper's MaxHlsBytes and its 32 files.
export const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const MAX_MEDIA_PLAYLISTS = 31;
const PARALLEL_READS = 4;
// Past it the stream goes as its address, as before helper 27.
export const PACKAGE_TIMEOUT_MS = 10000;
const URI_ATTRIBUTE = /(URI=")([^"]*)(")/g;
const LINE_BREAK = /\r\n|\r|\n/;

/** @typedef {{status: number, type: string, text: string, url: string}} Fetched - url: the answer's, after redirects. */
/** @typedef {{left: number}} Budget - The bytes the package may still read, shared by the reads at once. */
/**
 * @typedef {{
 *   fetchText: (url: string, budget: Budget, signal: AbortSignal) => Promise<?Fetched>,
 *   status: (url: string, signal: AbortSignal) => Promise<number>,
 * }} PackageIo - fetchText: a playlist with the page's headers, its bytes taken from the budget as they come;
 *   null when it could not be read or the budget ran out; status: a file's answer status, its body not read.
 */

/**
 * @param {string} url
 * @param {string} type
 * @return {boolean}
 */
function namesHls(url, type) {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (e) {
    return false;
  }
  return path.endsWith('.m3u8') || path.endsWith('.m3u') || HLS_TYPES.includes(type.split(';')[0].trim().toLowerCase());
}

/**
 * @param {string} line
 * @return {boolean}
 */
function isUriLine(line) {
  return line.length > 0 && !line.startsWith('#');
}

/**
 * @param {?Fetched} fetched
 * @return {boolean}
 */
function isOk(fetched) {
  return !!fetched && fetched.status >= 200 && fetched.status < 300;
}

/**
 * The playlists of an HLS stream for mpv, when mpv cannot open its address alone; null when it can, or when
 * they cannot go as files (a live stream, too many or too large, one unreadable, not read in time).
 * @param {{url: string, keyFrom: string, io: PackageIo, signal?: AbortSignal}} stream - url: the playlist mpv
 *   would be given (a master, or the variant the quality setting picked); keyFrom: the detected address, whose
 *   query may be the key its server asks of every file; signal: the hand-off no longer waits for it.
 * @return {Promise<?{files: Array<{name: string, text: string}>}>}
 */
export async function hlsPackage({url, keyFrom, io, signal}) {
  let key;
  try {
    const parsed = new URL(keyFrom);
    key = parsed.search.length > 1 ? parsed : null;
  } catch (e) {
    key = null;
  }
  // Named a playlist, with no query a key could come from: mpv opens it itself, and nothing is asked for.
  if (!key && namesHls(url, '')) return null;
  const stop = AbortSignal.any([AbortSignal.timeout(PACKAGE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  if (stop.aborted) return null;
  // Whatever it still waits for (a fetch, a header rule).
  const stopped = new Promise((resolve) => stop.addEventListener('abort', () => resolve(null), {once: true}));
  return Promise.race([collect(url, key, io, stop), /** @type {Promise<null>} */ (stopped)]);
}

/**
 * hlsPackage's reading.
 * @param {string} url
 * @param {?URL} key
 * @param {PackageIo} io
 * @param {AbortSignal} stop
 * @return {Promise<?{files: Array<{name: string, text: string}>}>}
 */
async function collect(url, key, io, stop) {
  // StreamQuery's rule: the key once a file refused without it was given with it, then for every file of its
  // server. Known only once every playlist was read, so they are rewritten after.
  let keyed = false;
  /** @param {string} address */
  const whole = (address) => (keyed && withKeyOf(key, address)) || address;
  /** @type {Budget} */
  const budget = {left: MAX_PACKAGE_BYTES};

  /**
   * @param {string} address
   * @return {Promise<?Fetched>}
   */
  const fetchText = async (address) => {
    if (stop.aborted || budget.left < 0) return null;
    const fetched = await io.fetchText(address, budget, stop).catch(() => null);
    return fetched && {...fetched, url: fetched.url || address};
  };
  /**
   * @param {string} address
   * @return {Promise<?Fetched>}
   */
  const read = async (address) => {
    const first = await fetchText(whole(address));
    if (first && isOk(first)) return first;
    const withKey = first && (first.status === 401 || first.status === 403) ? withKeyOf(key, address) : null;
    const second = withKey ? await fetchText(withKey) : null;
    if (!second || !isOk(second)) return null;
    keyed = true;
    return second;
  };
  /** @type {Map<string, Promise<?Fetched>>} */
  const reads = new Map();
  /** @param {string} address */
  const readOnce = (address) => {
    if (!reads.has(address)) reads.set(address, read(address));
    return /** @type {Promise<?Fetched>} */ (reads.get(address));
  };

  const root = await read(url);
  if (!root || !root.text.trimStart().startsWith('#EXTM3U')) return null;
  const isMaster = root.text.includes('#EXT-X-STREAM-INF');
  const uris = isMaster ? mediaUris(root.text) : [];
  if (isMaster && (uris.length === 0 || uris.length > MAX_MEDIA_PLAYLISTS)) return null;
  /** @param {string} uri */
  const addressOf = (uri) => new URL(uri, root.url).href;
  // The first file below the root: whether its server asks for the key too.
  const media = isMaster ? await readOnce(addressOf(uris[0])) : root;
  if (!media) return null;
  const firstSegment = new URL(media.text.split(LINE_BREAK).map((l) => l.trim()).find(isUriLine) || media.url, media.url).href;
  if (!keyed && [401, 403].includes(await io.status(firstSegment, stop).catch(() => 0))) {
    const withKey = withKeyOf(key, firstSegment);
    if (withKey && [200, 206].includes(await io.status(withKey, stop).catch(() => 0))) keyed = true;
  }
  if (!keyed && namesHls(url, root.type)) return null;

  const playlists = isMaster ? await inParallel(uris, (uri) => readOnce(addressOf(uri))) : [root];
  if (stop.aborted || budget.left < 0 || playlists.some((playlist) => !playlist)) return null;
  const texts = playlists.map((playlist) => vodText(/** @type {Fetched} */ (playlist).text,
      /** @type {Fetched} */ (playlist).url, whole));
  if (texts.some((text) => text === null)) return null;
  const files = texts.map((text, index) => ({name: `${index}.m3u8`, text: /** @type {string} */ (text)}));
  if (!isMaster) return sized(files);
  const names = new Map(uris.map((uri, index) => [uri, `${index}.m3u8`]));
  return sized([{name: 'master.m3u8', text: masterText(root.text, names)}, ...files]);
}

/**
 * At most PARALLEL_READS at a time; none started after one came back empty.
 * @template T, R
 * @param {Array<T>} items
 * @param {(item: T) => Promise<?R>} work
 * @return {Promise<Array<?R | undefined>>}
 */
async function inParallel(items, work) {
  /** @type {Array<?R | undefined>} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
      if (!results[index]) next = items.length;
    }
  };
  await Promise.all(Array.from({length: Math.min(PARALLEL_READS, items.length)}, worker));
  return results;
}

/**
 * The media playlists a master names, as ffmpeg reads them: its renditions', and the first address after each
 * variant's tag; not its I-frame playlists.
 * @param {string} text
 * @return {Array<string>}
 */
function mediaUris(text) {
  const uris = [];
  let variant = false;
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      for (const match of line.matchAll(URI_ATTRIBUTE)) uris.push(match[2]);
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      variant = true;
    } else if (isUriLine(line)) {
      if (variant) uris.push(line);
      variant = false;
    }
  }
  return [...new Set(uris)];
}

/**
 * A media playlist with every address whole; null when it is no complete one (a live stream's goes stale as a file).
 * @param {string} text
 * @param {string} base
 * @param {(address: string) => string} whole
 * @return {?string}
 */
function vodText(text, base, whole) {
  if (!text.trimStart().startsWith('#EXTM3U') || !text.includes('#EXT-X-ENDLIST')) return null;
  return text.split(LINE_BREAK).map((raw) => {
    const line = raw.trim();
    if (isUriLine(line)) return whole(new URL(line, base).href);
    return line.replace(URI_ATTRIBUTE, (_, open, uri, close) => open + whole(new URL(uri, base).href) + close);
  }).join('\n');
}

/**
 * The master naming only its media playlists, by their files: the helper takes no other address in it, so tags
 * with one (I-frame playlists, session keys and data) are left out, as are addresses after no variant's tag,
 * which ffmpeg skips.
 * @param {string} text
 * @param {Map<string, string>} names
 * @return {string}
 */
function masterText(text, names) {
  const lines = [];
  let variant = false;
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.trim();
    if (isUriLine(line)) {
      if (variant) lines.push(/** @type {string} */ (names.get(line)));
      variant = false;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      lines.push(line.replace(URI_ATTRIBUTE, (_, open, uri, close) => open + names.get(uri) + close));
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      variant = true;
      lines.push(line);
    } else if (!line.includes('URI=')) {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * @param {Array<{name: string, text: string}>} files
 * @return {?{files: Array<{name: string, text: string}>}}
 */
function sized(files) {
  const bytes = files.reduce((sum, file) => sum + new TextEncoder().encode(file.text).length, 0);
  return bytes > MAX_PACKAGE_BYTES ? null : {files};
}

/**
 * Fetching as the player does for its stream: the page's Origin and Referer (header rules), no cookies, not
 * cached (the page may be in a private window).
 * @param {{headers?: ?Array<{name: string, value: string}>, fetch?: typeof globalThis.fetch,
 *   setHeaders: (url: string, commands: FSHeaderCommand[]) => Promise<unknown>}} options
 * @return {PackageIo}
 */
export function pageFetchIo({headers, fetch = (url, init) => globalThis.fetch(url, init), setHeaders}) {
  const commands = (Array.isArray(headers) ? headers : []).filter((header) => ['origin', 'referer'].includes(String(header?.name).toLowerCase()) &&
    typeof header.value === 'string' && header.value)
      .map((header) => /** @type {FSHeaderCommand} */ ({operation: 'set', header: header.name.toLowerCase(), value: header.value}));
  /**
   * The answer's body is dropped once used.
   * @param {string} url
   * @param {AbortSignal} signal
   * @param {(response: Response) => Promise<*>} use
   * @return {Promise<*>}
   */
  const get = async (url, signal, use) => {
    if (commands.length > 0) {
      await setHeaders(url, commands).catch((e) => console.warn('Header rule refused', e));
    }
    signal.throwIfAborted();
    const done = new AbortController();
    try {
      return await use(await fetch(url, {credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([done.signal, signal])}));
    } finally {
      done.abort();
    }
  };
  return {
    fetchText: (url, budget, signal) => get(url, signal, async (response) => {
      const answered = response.url || url;
      if (!response.ok) return {status: response.status, type: '', text: '', url: answered};
      const text = await readWhole(response, budget);
      return text === null ? null : {status: response.status, type: response.headers.get('content-type') || '', text, url: answered};
    }).catch(() => null),
    status: (url, signal) => get(url, signal, async (response) => response.status),
  };
}

/**
 * The body as text, its bytes taken from the budget as they come; null once it ran out: a playlist cut short would
 * go to mpv as a whole one.
 * @param {Response} response
 * @param {Budget} budget
 * @return {Promise<?string>}
 */
async function readWhole(response, budget) {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    budget.left -= buffer.byteLength;
    return budget.left < 0 ? null : new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    budget.left -= value.byteLength;
    if (budget.left < 0) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
