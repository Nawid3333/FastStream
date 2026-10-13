// @ts-check
import {SubtitleUtils} from '../player/utils/SubtitleUtils.mjs';
import {StreamLengths} from './StreamLengths.mjs';

// The host takes at most this many tracks (MaxSubtitles in native-host/faststream-mpv-host.mjs).
export const MAX_TRACKS = 8;
// The most of a page's tracks read for one send: some may fail or hold no cue.
const MAX_READS = 16;
// How long a track's file may take to come: mpv starts only once the tracks are read.
export const FETCH_TIMEOUT_MS = 4000;
// The largest file read: twice what the whole message to the host may be (HostMaxMessageBytes,
// 1 MB). A larger one could not go anyway, and parsing it here would hold up the background,
// every tab's detection with it (glm's review).
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Reads a subtitle file into a track, with the player's own parser (WebVTT, SubRip, TTML).
 * Imported when first needed: vtt.js takes the window it parses with from the global
 * scope when it loads, and the background's unit tests give it one only in their own setup.
 * @param {string} text - The file.
 * @param {string} label - The track's label.
 * @param {string} language - Its language.
 * @return {Promise<{cues: Array}>} The track.
 */
async function loadTrack(text, label, language) {
  const {SubtitleTrack} = await import('../player/SubtitleTrack.mjs');
  const track = new SubtitleTrack(label, language);
  track.loadText(text);
  return track;
}

/**
 * A page's subtitles as mpv takes them (MpvBackend.openStream's extras.subtitles): SubRip
 * text with a label. MPV mode sent a page's stream alone, while the in-page player showed
 * that page's subtitles - the subtitle files it asked for and its <track> elements. Each
 * track goes the player's way: fetched with the page's Origin and Referer, as
 * SubtitleFetch.loadSubtitles fetches it, read by SubtitleTrack.loadText, and written as
 * SubRip as the player's mpv button writes it (SubtitleUtils.cuesToSrt).
 */
export class MpvSubtitles {
  /**
   * @param {Object} [options]
   * @param {(url: string, init: Object) => Promise<Response>} [options.fetch] - fetch().
   * @param {(url: string, commands: Array<Object>) => Promise<*>} [options.setHeaders] -
   *   Makes the background's next request to a URL carry the page's Origin and Referer,
   *   which a fetch() cannot set: a declarativeNetRequest rule, as StreamLengths' reads get.
   * @param {(text: string, label: string, language: string) => Promise<{cues: Array}>}
   *   [options.loadTrack] - Reads a file into a track.
   */
  constructor({
    fetch = (url, init) => globalThis.fetch(url, init),
    setHeaders = async () => {},
    loadTrack: load = loadTrack,
  } = {}) {
    this.fetch = fetch;
    this.setHeaders = setHeaders;
    this.loadTrack = load;
  }

  /**
   * @param {Array<Object>} subs - The page's tracks, as the background holds them:
   *   {source?, data?, headers?, label?, language?}. A <track> element's come with their
   *   text (data); a detected request's with its URL and headers.
   * @return {Promise<Array<{label: string, srt: string}>>} Those with cues, in the page's
   *   order (each URL once), at most MAX_TRACKS.
   */
  async toSrt(subs) {
    const seen = new Set();
    const tracks = [];
    for (const sub of Array.isArray(subs) ? subs : []) {
      const key = sub && (sub.source || sub.data);
      if (typeof key !== 'string' || !key || seen.has(key)) continue;
      seen.add(key);
      tracks.push(sub);
    }
    const read = await Promise.all(tracks.slice(0, MAX_READS).map(async (sub) => {
      try {
        // A <track> element's text comes whole, of any size (content.js reads the file): no
        // more of it is read than of a fetched one. A string has at most as many UTF-16 units
        // as its UTF-8 has bytes, so one longer than the cap is over it either way.
        if (typeof sub.data === 'string' && sub.data.length > MAX_FILE_BYTES) return null;
        const text = typeof sub.data === 'string' && sub.data ? sub.data : await this.fetchText(sub.source, sub.headers);
        if (!text) return null;
        const label = typeof sub.label === 'string' ? sub.label : '';
        const language = typeof sub.language === 'string' ? sub.language : '';
        const track = await this.loadTrack(text, label, language);
        if (!track.cues.length) return null;
        return {label: label || language, srt: SubtitleUtils.cuesToSrt(track.cues)};
      } catch (e) {
        console.warn('A subtitle track could not be read for mpv', sub.source, e);
        return null;
      }
    }));
    return read.filter((track) => track !== null).slice(0, MAX_TRACKS);
  }

  /**
   * Fetches a track's file with the Origin and Referer the page's request had, as the
   * player does (the rest of the page's headers stay the page's).
   * @param {*} url - The file.
   * @param {*} headers - The page's request headers: [{name, value}].
   * @return {Promise<string>} Its text, or '' for an error status.
   */
  async fetchText(url, headers) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return '';
    }
    const commands = (Array.isArray(headers) ? headers : []).filter((header) => {
      const name = String(header?.name || '').toLowerCase();
      return (name === 'origin' || name === 'referer') && typeof header.value === 'string' && header.value;
    }).map((header) => ({operation: 'set', header: header.name.toLowerCase(), value: header.value}));
    if (commands.length > 0) {
      try {
        await this.setHeaders(url, commands);
      } catch (e) {
        // Refused: the request goes without them, as the player's does.
        console.warn('Header rule refused', e);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // Not kept in the cache: the page may be in a private window, and this request is not.
      const response = await this.fetch(url, {credentials: 'omit', cache: 'no-store', signal: controller.signal});
      if (!response.ok) {
        return '';
      }
      const bytes = await StreamLengths.readAtMost(response, MAX_FILE_BYTES + 1);
      if (bytes.length > MAX_FILE_BYTES) {
        console.warn('A subtitle file is too large to send to mpv, left out', url);
        return '';
      }
      const type = response.headers?.get ? response.headers.get('Content-Type') : null;
      return SubtitleUtils.decodeSubtitleBytes(bytes, type) || '';
    } finally {
      clearTimeout(timer);
    }
  }
}
