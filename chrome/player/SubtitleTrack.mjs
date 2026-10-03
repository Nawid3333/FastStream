import {Localize} from './modules/Localize.mjs';
import {WebVTT} from './modules/vtt.mjs';
import {SubtitleUtils} from './utils/SubtitleUtils.mjs';

export class SubtitleTrack {
  constructor(label, language) {
    this.label = label;
    this.language = language;
    this.cues = [];
    this.regions = [];
    // the sum of every whole-track shift, shown by the resync tool
    this.shiftTotal = 0;
  }

  loadURL(url) {
    return fetch(url).then((response) => {
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

  shift(time) {
    this.cues.forEach((cue) => {
      cue.startTime += time;
      cue.endTime += time;
    });
    this.shiftTotal += time;
  }

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
    parser.onRegion = (region) => {
      this.regions.push(region);
    };

    parser.oncue = (cue) => {
      this.cues.push(cue);
    };

    parser.onflush = () => {
      this.cues.sort((a, b) => {
        return a.startTime - b.startTime;
      });
    };

    parser.onparsingerror = (error) => {
      console.error(error);
    };

    // toWellFormed: the parser's decoder, decodeURIComponent(encodeURIComponent(text)),
    // throws "URI malformed" on a lone surrogate, which a page's string can hold.
    parser.parse(text.toWellFormed());
    parser.flush();
  }

  equals(otherTrack) {
    if (this.label !== otherTrack.label || this.language !== otherTrack.language) {
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
