// @ts-check
import {SubtitleUtils} from '../player/utils/SubtitleUtils.mjs';
import {StreamLengths} from './StreamLengths.mjs';

/** @typedef {import('../player/SubtitleTrack.mjs').SubtitleTrack} SubtitleTrack */
// The host takes at most this many tracks (MaxSubtitles in native-host/faststream-mpv-host.mjs).
export const MAX_TRACKS = 8;
// The most of a page's tracks read for one send: some may fail or hold no cue.
const MAX_READS = 16;
// mpv starts only once the tracks are read.
export const FETCH_TIMEOUT_MS = 4000;
// Twice the host's message cap (HostMaxMessageBytes, 1 MB): a larger file could not go anyway.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Imported when first needed: vtt.js takes its window from the global scope when it loads.
 * @param {string} text
 * @param {string} label
 * @param {string} language
 * @return {Promise<SubtitleTrack>}
 */
async function loadTrack(text, label, language) {
  const {SubtitleTrack} = await import('../player/SubtitleTrack.mjs');
  const track = new SubtitleTrack(label, language);
  track.loadText(text);
  return track;
}

/** A page's subtitles as mpv takes them: SubRip text with a label, fetched and read the player's way. */
export class MpvSubtitles {
  /**
   * @param {Object} [options]
   * @param {(url: string, init: Object) => Promise<Response>} [options.fetch]
   * @param {(url: string, commands: FSHeaderCommand[]) => Promise<unknown>} [options.setHeaders]
   * @param {(text: string, label: string, language: string) => Promise<SubtitleTrack>}
   *   [options.loadTrack]
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
   * @param {Array<{source?: string, data?: string, headers?: Array<{name: string, value: string}>, label?: string, language?: string}>} subs
   * @return {Promise<Array<{label: string, srt: string}>>}
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
        // A string has at most as many UTF-16 units as its UTF-8 has bytes: longer is over the cap.
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
   * With the Origin and Referer the page's request had, as the player fetches it.
   * @param {*} url
   * @param {*} headers
   * @return {Promise<string>}
   */
  async fetchText(url, headers) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return '';
    }
    /** @type {FSHeaderCommand[]} */
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
      // Not cached: the page may be in a private window, and this request is not.
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
