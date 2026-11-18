// @ts-check
import {Localize} from './modules/Localize.mjs';
import {WebVTT} from './modules/vtt.mjs';
import {SubtitleUtils} from './utils/SubtitleUtils.mjs';
import {TtmlError, isTtml, ttml2vtt} from './utils/TtmlSubtitles.mjs';

/**
 * A track's cue with the DOM trees the subtitle code caches on it: `dom` for the video, `dom2` for the resync timeline.
 * @typedef {VTTCue & {dom?: HTMLElement|null, dom2?: HTMLElement|null}} TrackCue
 */

export class SubtitleTrack {
  /**
   * @param {string} label
   * @param {string|null} [language]
   */
  constructor(label, language) {
    this.label = label;
    this.language = language;
    /** @type {Array<TrackCue>} */
    this.cues = [];
    /** @type {Array<VTTRegion>} */
    this.regions = [];
    this.shiftTotal = 0;
  }

  /**
   * Fetches a subtitle file and reads its cues into the track.
   * @param {string} url
   * @return {Promise<void>}
   */
  loadURL(url) {
    return fetch(url).then((response) => {
      // An error page is no subtitle file: its status is the reason.
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

  /** Throws when loadText found no cue: the parser skips what is not subtitles without complaint. */
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
   * Reads a subtitle file's text into the track's cues: WebVTT, SubRip, TTML/DFXP, or timed-text XML.
   * @param {string} text
   */
  loadText(text) {
    // A byte order mark would hide the WEBVTT signature (and '<?xml') from the checks and the parser.
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.substring(1);
    }

    if (isTtml(text)) {
      try {
        text = ttml2vtt(text, (seconds) => SubtitleUtils.vttTimeFormat(seconds));
      } catch (e) {
        if (!(e instanceof TtmlError)) throw e;
        const message = Localize.getMessage(e.reason === 'images' ? 'player_subtitles_ttml_images' : 'player_subtitles_ttml_unreadable');
        throw new Error(e.detail ? `${message} (${e.detail})` : message, {cause: e});
      }
    } else if (text.substring(0, 5) === '<?xml') {
      text = SubtitleUtils.xml2vtt(text);
    } else if (text.trim().split('\n')[0].trim().substr(0, 6) !== 'WEBVTT') {
      text = SubtitleUtils.srt2webvtt(text);
    }

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

    // toWellFormed: the parser's decoder throws "URI malformed" on a lone surrogate.
    parser.parse(text.toWellFormed());
    parser.flush();
  }

  /**
   * Whether two tracks are the same subtitles: the same cues, unless the name and the language both differ.
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
