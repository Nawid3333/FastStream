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
const URI_ATTRIBUTE = /(URI=")([^"]*)(")/g;

/** @typedef {{status: number, type: string, text: string}} Fetched */
/**
 * @typedef {{
 *   fetchText: (url: string) => Promise<?Fetched>,
 *   status: (url: string) => Promise<number>,
 * }} PackageIo - fetchText: a playlist with the page's headers, null when it could not be read; status: a file's
 *   answer status, its body not read.
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
 * The playlists of an HLS stream for mpv, when mpv cannot open its address alone; null when it can, or when
 * they cannot go as files (a live stream, too many or too large, one unreadable).
 * @param {{url: string, keyFrom: string, io: PackageIo}} stream - url: the playlist mpv would be given (a
 *   master, or the variant the quality setting picked); keyFrom: the detected address, whose query may be the
 *   key its server asks of every file.
 * @return {Promise<?{files: Array<{name: string, text: string}>}>}
 */
export async function hlsPackage({url, keyFrom, io}) {
  let key;
  try {
    const parsed = new URL(keyFrom);
    key = parsed.search.length > 1 ? parsed : null;
  } catch (e) {
    key = null;
  }
  // Named a playlist, with no query a key could come from: mpv opens it itself, and nothing is asked for.
  if (!key && namesHls(url, '')) return null;
  // StreamQuery's rule: the key once a file refused without it was given with it, then for every file of its server.
  let keyed = false;
  /** @param {string} address */
  const whole = (address) => (keyed && withKeyOf(key, address)) || address;

  /**
   * @param {string} address
   * @return {Promise<?{url: string, type: string, text: string}>}
   */
  const read = async (address) => {
    const first = await io.fetchText(whole(address));
    if (first && first.status >= 200 && first.status < 300) return {url: whole(address), type: first.type, text: first.text};
    const withKey = !keyed && first && (first.status === 401 || first.status === 403) ? withKeyOf(key, address) : null;
    if (!withKey) return null;
    const second = await io.fetchText(withKey);
    if (!second || second.status < 200 || second.status >= 300) return null;
    keyed = true;
    return {url: withKey, type: second.type, text: second.text};
  };

  const root = await read(url);
  if (!root || !root.text.trimStart().startsWith('#EXTM3U')) return null;
  const isMaster = root.text.includes('#EXT-X-STREAM-INF') || /#EXT-X-MEDIA:.*URI=/.test(root.text);
  // The first file below the root: whether its server asks for the key too.
  const firstMedia = mediaUris(root.text)[0];
  const media = isMaster ? (firstMedia ? await read(new URL(firstMedia, root.url).href) : null) : root;
  if (!media) return null;
  const firstSegment = new URL(media.text.split(/\r?\n/).map((l) => l.trim()).find(isUriLine) || media.url, media.url).href;
  if (!keyed && await io.status(firstSegment).catch(() => 0) === 403) {
    const withKey = withKeyOf(key, firstSegment);
    if (withKey && [200, 206].includes(await io.status(withKey).catch(() => 0))) keyed = true;
  }
  if (!keyed && namesHls(url, root.type)) return null;

  if (!isMaster) {
    const text = vodText(root.text, root.url, whole);
    return text === null ? null : sized([{name: '0.m3u8', text}]);
  }
  const uris = mediaUris(root.text);
  if (uris.length === 0 || uris.length > MAX_MEDIA_PLAYLISTS) return null;
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {Array<{name: string, text: string}>} */
  const files = [];
  for (const [index, uri] of uris.entries()) {
    const playlist = await read(new URL(uri, root.url).href);
    const text = playlist && vodText(playlist.text, playlist.url, whole);
    if (text === null || text === undefined) return null;
    names.set(uri, `${index}.m3u8`);
    files.push({name: `${index}.m3u8`, text});
  }
  return sized([{name: 'master.m3u8', text: masterText(root.text, root.url, names, whole)}, ...files]);
}

/**
 * The media playlists a master names: its variants' and its renditions'; not its I-frame playlists.
 * @param {string} text
 * @return {Array<string>}
 */
function mediaUris(text) {
  const uris = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      for (const match of line.matchAll(URI_ATTRIBUTE)) uris.push(match[2]);
    } else if (isUriLine(line) && lines.slice(0, index).reverse().find((l) => l.startsWith('#EXT'))?.startsWith('#EXT-X-STREAM-INF')) {
      uris.push(line);
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
  return text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (isUriLine(line)) return whole(new URL(line, base).href);
    return line.replace(URI_ATTRIBUTE, (_, open, uri, close) => open + whole(new URL(uri, base).href) + close);
  }).join('\n');
}

/**
 * The master with its media playlists named by their files, and its other addresses whole; its I-frame
 * playlists and session data left out.
 * @param {string} text
 * @param {string} base
 * @param {Map<string, string>} names
 * @param {(address: string) => string} whole
 * @return {string}
 */
function masterText(text, base, names, whole) {
  return text.split(/\r?\n/).map((raw) => raw.trim())
      .filter((line) => !line.startsWith('#EXT-X-I-FRAME-STREAM-INF') && !line.startsWith('#EXT-X-SESSION-DATA'))
      .map((line) => {
        if (isUriLine(line)) return names.get(line) ?? whole(new URL(line, base).href);
        return line.replace(URI_ATTRIBUTE, (_, open, uri, close) =>
          open + (names.get(uri) ?? whole(new URL(uri, base).href)) + close);
      }).join('\n');
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
   * @param {string} url
   * @param {(response: Response) => Promise<*>} use
   * @return {Promise<*>}
   */
  const get = async (url, use) => {
    if (commands.length > 0) {
      await setHeaders(url, commands).catch((e) => console.warn('Header rule refused', e));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await use(await fetch(url, {credentials: 'omit', cache: 'no-store', signal: controller.signal}));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  return {
    fetchText: (url) => get(url, async (response) => {
      if (!response.ok) return {status: response.status, type: '', text: ''};
      const text = await readWhole(response, MAX_PACKAGE_BYTES);
      return text === null ? null : {status: response.status, type: response.headers.get('content-type') || '', text};
    }).catch(() => null),
    status: (url) => get(url, async (response) => response.status),
  };
}

const FETCH_TIMEOUT_MS = 10000;

/**
 * The body as text; null when it is over limit bytes: a playlist cut short would go to mpv as a whole one.
 * @param {Response} response
 * @param {number} limit
 * @return {Promise<?string>}
 */
async function readWhole(response, limit) {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > limit ? null : new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
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
