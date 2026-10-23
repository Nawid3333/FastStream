// @ts-check
import {Localize} from './modules/Localize.mjs';
import {WebVTT} from './modules/vtt.mjs';
import {SubtitleUtils} from './utils/SubtitleUtils.mjs';

/**
 * A track's cue, with the DOM trees the subtitle code caches on it: `dom` for the video
 * (SubtitlesManager.renderSubtitles), `dom2` for the resync timeline (SubtitleSyncer).
 * @typedef {VTTCue & {dom?: HTMLElement|null, dom2?: HTMLElement|null}} TrackCue
 */

export class SubtitleTrack {
  /**
   * @param {string} label - The track's name in the subtitles menu.
   * @param {string|null} [language] - Its language, where one is known.
   */
  constructor(label, language) {
    this.label = label;
    this.language = language;
    // The parser makes the window's own cues and regions (vtt.js's shims only where the
    // browser has none); the resync tool adds cues of its own (SubtitleSyncer).
    /** @type {Array<TrackCue>} */
    this.cues = [];
    /** @type {Array<VTTRegion>} */
    this.regions = [];
    // the sum of every whole-track shift, shown by the resync tool
    this.shiftTotal = 0;
  }

  /**
   * Fetches a subtitle file and reads its cues into the track.
   * @param {string} url
   * @return {Promise<void>}
   */
  loadURL(url) {
    return fetch(url).then((response) => {
      // An error page (404) was read as a subtitle file without cues: the reason was lost
      // (review). A link typed in the subtitles menu says it already (requestSimple).
      if (!response.ok) {
        throw new Error('Bad status code: ' + response.status);
      }
      return response.arrayBuffer().then((bytes) => {
        return SubtitleUtils.decodeSubtitleBytes(bytes, response.headers.get('Content-Type'));
      });
    }).then((text) => {
      this.loadText(text);
    });
  }

  /**
   * Throws when loadText found no cue: what was loaded was no subtitles (a web page, an
   * error message, another kind of file), which the parser skips without complaint.
   */
  checkHasCues() {
    if (this.cues.length === 0) {
      throw new Error(Localize.getMessage('player_subtitles_nocues'));
    }
  }

  /**
   * Moves every cue by the same time.
   * @param {number} time - Seconds, later when positive.
   */
  shift(time) {
    this.cues.forEach((cue) => {
      cue.startTime += time;
      cue.endTime += time;
    });
    this.shiftTotal += time;
  }

  /**
   * @param {TrackCue} cue - The first cue to move, one of the track's.
   * @param {number} time - Seconds, later when positive.
   */
  shiftAfter(cue, time) {
    // only shift cues that are the given cue or come after it. This allows users to shift a single cue without affecting cues that come before it.
    let shift = false;
    this.cues.forEach((c) => {
      if (c === cue) {
        shift = true;
      }
      if (shift) {
        c.startTime += time;
        c.endTime += time;
      }
    });
  }

  /**
   * Reads a subtitle file's text (WebVTT, SubRip or TTML) into the track's cues.
   * @param {string} text
   */
  loadText(text) {
    // A byte order mark hid the WEBVTT signature (and '<?xml') from the checks below and
    // from the parser: no cue. The page's own subtitles come in as the page wrote them.
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.substring(1);
    }

    if (text.substring(0, 5) === '<?xml') {
      text = SubtitleUtils.xml2vtt(text);
    } else if (text.trim().split('\n')[0].trim().substr(0, 6) !== 'WEBVTT') {
      text = SubtitleUtils.srt2webvtt(text);
    }

    // sometimes formatting in subtitles are not properly
    // converted into webvtt, so we need to convert them manually
    text = SubtitleUtils.convertSubtitleFormatting(text);

    // eslint-disable-next-line new-cap
    const parser = new WebVTT.Parser(window, WebVTT.StringDecoder());
    parser.onRegion = (/** @type {VTTRegion} */ region) => {
      this.regions.push(region);
    };

    parser.oncue = (/** @type {VTTCue} */ cue) => {
      this.cues.push(cue);
    };

    parser.onflush = () => {
      this.cues.sort((a, b) => {
        return a.startTime - b.startTime;
      });
    };

    // vtt.js's ParsingError: an Error with the code of what was malformed.
    parser.onparsingerror = (/** @type {Error & {code: number}} */ error) => {
      console.error(error);
    };

    // toWellFormed: the parser's decoder, decodeURIComponent(encodeURIComponent(text)),
    // throws "URI malformed" on a lone surrogate, which a page's string can hold.
    parser.parse(text.toWellFormed());
    parser.flush();
  }

  /**
   * Whether two tracks are the same subtitles (SubtitlesManager.addTrack keeps one): the
   * same cues, unless the name and the language both differ. The same file under another
   * name (the page's subtitle file and the user's copy of it) is one track. A 2026-09-11
   * review took upstream's && here for a typo, and such a file was listed twice.
   * @param {SubtitleTrack} otherTrack
   * @return {boolean}
   */
  equals(otherTrack) {
    if (this.label !== otherTrack.label && this.language !== otherTrack.language) {
      return false;
    }

    if (this.cues.length !== otherTrack.cues.length) {
      return false;
    }

    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      const otherCue = otherTrack.cues[i];

      if (cue.startTime !== otherCue.startTime || cue.endTime !== otherCue.endTime || cue.text !== otherCue.text) {
        return false;
      }
    }

    return true;
  }
}
