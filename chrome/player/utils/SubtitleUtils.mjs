// @ts-check
// Also '.' before short or missing milliseconds, one-digit minutes and seconds. The lookbehind
// tries it only where a run of digits starts: from inside a long run it is quadratic.
const SRT_TIMESTAMP = /(?<!\d)(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d+))?\s*--?>\s*(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d+))?/;
const SRT_CUE_START = new RegExp('^\\s*' + SRT_TIMESTAMP.source);

export class SubtitleUtils {
  /**
   * A bare number ("20", "1,5") is pixels; anything else is CSS as given.
   * @param {string} value
   * @return {string}
   */
  static withUnit(value) {
    const text = String(value ?? '').trim();
    return /^\d+([.,]\d+)?$/.test(text) ? text.replace(',', '.') + 'px' : text;
  }

  /**
   * Pixels, at most 64: the outline's loop would never end for Infinity. 0 for no number.
   * @param {*} value
   * @return {number}
   */
  static outlineWidth(value) {
    const width = Math.min(parseFloat(String(value ?? '').replace(',', '.')), 64);
    return Number.isFinite(width) && width > 0 ? width : 0;
  }

  /**
   * The name before ".srt" is added: characters Windows refuses replaced, an own extension taken off.
   * @param {string} name
   * @return {string}
   */
  static downloadName(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\.(srt|vtt|ass|ssa)$/i, '');
  }

  /**
   * As the browser reads it (BOM, then a declared charset), but bytes that are no UTF-8 are read
   * in the legacy encoding of the browser's language. content.js carries a copy a test keeps the same.
   * @param {ArrayBuffer|ArrayBufferView} data
   * @param {?string} [contentType] - The Content-Type it came with over HTTP, if any.
   * @return {string}
   */
  static decodeSubtitleBytes(data, contentType) {
    const bytes = ArrayBuffer.isView(data) ?
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data || 0);
    // A byte order mark says what the file is, before anything a server says.
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
    // A charset the server declared, unless it is UTF-8: a file a server calls UTF-8 often
    // is not, and is then read like one that came with no charset.
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
    if (charset) {
      try {
        const decoder = new TextDecoder(charset[1]);
        if (decoder.encoding !== 'utf-8') {
          return decoder.decode(bytes);
        }
      } catch (e) {
        // A charset no browser knows: as if none was given.
      }
    }
    try {
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch (e) {
      // No UTF-8, in an XML file whose declaration names its encoding (a TTML file in ISO-8859-1,
      // say): that one. One that reads as ASCII is no UTF-16, whatever it says.
      const head = String.fromCharCode(...bytes.subarray(0, 200));
      const declaration = head.startsWith('<?xml') ? head.slice(0, head.indexOf('?>') + 1) : '';
      const declared = /\sencoding\s*=\s*["']([A-Za-z][\w.:-]*)["']/.exec(declaration);
      if (declared) {
        try {
          const decoder = new TextDecoder(declared[1]);
          if (!/^utf-(8|16)/.test(decoder.encoding)) {
            return decoder.decode(bytes);
          }
        } catch (e) {
          // An encoding no browser knows: as if none was named.
        }
      }
      // Otherwise the older encoding of the browser's language, as Firefox falls back to.
      // Read as Windows-1252, a Russian, Polish or Greek file showed wrong letters.
      const language = String(globalThis.navigator?.language || '').toLowerCase();
      const legacy = /** @type {Array<[RegExp, string]>} */ ([
        [/^(ru|uk|be|bg|sr|mk)\b/, 'windows-1251'], [/^(pl|cs|sk|sl|hu|hr|ro|bs)\b/, 'windows-1250'],
        [/^el\b/, 'windows-1253'], [/^(tr|az)\b/, 'windows-1254'], [/^he\b/, 'windows-1255'],
        [/^(ar|fa|ur)\b/, 'windows-1256'], [/^(lt|lv|et)\b/, 'windows-1257'], [/^vi\b/, 'windows-1258'],
        [/^th\b/, 'windows-874'], [/^ja\b/, 'shift_jis'], [/^ko\b/, 'euc-kr'],
        [/^zh-(tw|hk|mo|hant)/, 'big5'], [/^zh\b/, 'gb18030'],
      ]).find(([pattern]) => pattern.test(language));
      return new TextDecoder(legacy ? legacy[1] : 'windows-1252').decode(bytes);
    }
  }

  /**
   * @param {string} str
   * @return {string}
   */
  static translateXMLEntities(str) {
    /** @type {Object<string, string>} */
    const entitiesList = {
      '&amp;': '&',
      '&gt;': '>',
      '&lt;': '<',
      '&quot;': '"',
      '&apos;': '\'',
    };

    const entitySplit = str.split(/(&[#a-zA-Z0-9]+;)/);
    if (entitySplit.length <= 1) {
      return str;
    }

    for (let i = 1; i < entitySplit.length; i += 2) {
      const reference = entitySplit[i];
      if (reference.charAt(1) === '#') {
        let code;
        if (reference.charAt(2) === 'x' || reference.charAt(2) === 'X') {
          code = parseInt(reference.substring(3, reference.length - 1), 16);
        } else {
          code = parseInt(reference.substring(2, reference.length - 1), 10);
        }

        // A surrogate is U+FFFD, as in HTML: a lone one makes the WebVTT parser throw.
        if (!isNaN(code) && code >= 0 && code <= 0x10FFFF) {
          entitySplit[i] = code >= 0xD800 && code <= 0xDFFF ? String.fromCharCode(0xFFFD) : String.fromCodePoint(code);
        }
      } else if (entitiesList.hasOwnProperty(reference)) {
        entitySplit[i] = entitiesList[reference];
      }
    }

    return entitySplit.join('');
  }

  /**
   * @param {string} data - SRT.
   * @return {string} WebVTT.
   */
  static srt2webvtt(data) {
    // With no line feed at all (classic Mac), the carriage returns are the line ends.
    let srt = data.includes('\n') ? data.replace(/\r+/g, '') : data.replace(/\r/g, '\n');
    srt = srt.trim();
    // A cue ends at a blank line, and also starts at its own timestamp; a line of spaces
    // inside a cue is text, as ffmpeg and VLC read it.
    const cuelist = srt.split(/\n\n+/).flatMap((block) => this.splitAtCueStarts(block));
    let result = '';
    if (cuelist.length > 0) {
      result += 'WEBVTT\n\n';
      for (let i = 0; i < cuelist.length; i = i + 1) {
        result += this.convertSrtCue(cuelist[i]);
      }
    }
    return result;
  }

  /**
   * @param {string} data - XML.
   * @return {string} WebVTT.
   */
  static xml2vtt(data) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(data, 'text/xml');
    const cues = xml.getElementsByTagName('text');
    const result = ['WEBVTT'];
    // No start: left out; no duration: until the next one starts (2 s for the last).
    const starts = Array.from(cues, (cue) => parseFloat(/** @type {string} */ (cue.getAttribute('start'))));
    for (let i = 0; i < cues.length; i++) {
      const start = starts[i];
      if (!Number.isFinite(start)) continue;
      const dur = parseFloat(/** @type {string} */ (cues[i].getAttribute('dur')));
      let next;
      if (!Number.isFinite(dur)) {
        for (let j = i + 1; j < starts.length; j++) {
          if (Number.isFinite(starts[j]) && starts[j] > start) {
            next = starts[j];
            break;
          }
        }
      }
      const end = start + (Number.isFinite(dur) ? dur : (next !== undefined ? next - start : 2));
      const text = this.translateXMLEntities(cues[i].textContent);
      result.push(result.length + '\n' + this.vttTimeFormat(start) + ' --> ' + this.vttTimeFormat(end) + '\n' + text);
    }
    return result.join('\n\n');
  }

  /**
   * HH:MM:SS plus milliseconds, rounded: flooring turns 1.2999999999999998 into 1.299.
   * @param {number} sec - A negative time is written as zero.
   * @param {string} separator - Between the seconds and the milliseconds.
   * @return {string}
   */
  static formatTimestamp(sec, separator) {
    const total = Math.max(0, Math.round(sec * 1000));
    /** @type {(n: number, width: number) => string} */
    const pad = (n, width) => String(n).padStart(width, '0');
    const seconds = Math.floor(total / 1000);
    return pad(Math.floor(seconds / 3600), 2) + ':' + pad(Math.floor(seconds / 60) % 60, 2) + ':' +
      pad(seconds % 60, 2) + separator + pad(total % 1000, 3);
  }

  /**
   * @param {number} sec
   * @return {string} HH:MM:SS.mmm
   */
  static vttTimeFormat(sec) {
    return this.formatTimestamp(sec, '.');
  }

  /**
   * @param {number} sec
   * @return {string} HH:MM:SS,mmm
   */
  static srtTimeFormat(sec) {
    return this.formatTimestamp(sec, ',');
  }

  /**
   * @param {Array<{startTime: number, endTime: number, text: string}>} cues
   * @return {string} SRT.
   */
  static cuesToSrt(cues) {
    const result = [];
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const start = this.srtTimeFormat(cue.startTime);
      const end = this.srtTimeFormat(cue.endTime);
      const text = cue.text;
      result.push((i + 1) + '\n' + start + ' --> ' + end + '\n' + text);
    }
    return result.join('\n\n');
  }

  /**
   * Every cue is checked: a long cue stays on screen behind later, shorter ones, and an edit
   * can leave the track out of order. 10,000 cues take about 0.01 ms.
   * @template {{startTime: number, endTime: number}} T
   * @param {Array<T>} cues
   * @param {number} time - Seconds.
   * @return {Array<T>} In the track's order.
   */
  static cuesAt(cues, time) {
    const onScreen = [];
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].startTime <= time && cues[i].endTime >= time) {
        onScreen.push(cues[i]);
      }
    }
    return onScreen;
  }

  /**
   * Only https on OpenSubtitles' own hosts: it is fetched with the extension's host permissions.
   * @param {*} link - The link from the API's answer.
   * @return {boolean}
   */
  static isOpenSubtitlesDownloadLink(link) {
    let url;
    try {
      url = new URL(link);
    } catch (e) {
      return false;
    }
    return url.protocol === 'https:' && /(^|\.)opensubtitles\.(com|org)$/.test(url.hostname);
  }

  /**
   * To HH:MM:SS.mmm, all the WebVTT parser accepts. Short milliseconds are a number of
   * milliseconds, as ffmpeg and VLC read them.
   * @param {string} hours
   * @param {string} minutes
   * @param {string} seconds
   * @param {string} [millis]
   * @return {string}
   */
  static srtTimestampToVtt(hours, minutes, seconds, millis) {
    let ms = millis || '0';
    ms = ms.length > 3 ? ms.substring(0, 3) : ms.padStart(3, '0');
    return hours + ':' + minutes.padStart(2, '0') + ':' + seconds.padStart(2, '0') + '.' + ms;
  }

  /**
   * A cue starts at its timestamp line, or the sequence number before it, even with no blank
   * line before it, as in ffmpeg. Trailing whitespace lines are dropped; inner ones kept.
   * @param {string} block - SubRip text with no blank line in it.
   * @return {string[]} One block per cue, in order.
   */
  static splitAtCueStarts(block) {
    const lines = block.split('\n');
    /** @type {string[]} */
    const cues = [];
    /** @type {(from: number, to: number) => void} */
    const push = (from, to) => {
      const cue = lines.slice(from, to);
      while (cue.length > 0 && cue[cue.length - 1].trim() === '') {
        cue.pop();
      }
      if (cue.length > 0) {
        cues.push(cue.join('\n'));
      }
    };

    let start = 0;
    let lastCueTime = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!SRT_CUE_START.test(lines[i])) {
        continue;
      }
      // A number that is the only line after the last timestamp is that cue's text (a score, a year).
      const onlyText = lastCueTime >= 0 && lastCueTime === i - 2;
      const cueStart = i > start && !onlyText && /^\d+$/.test(lines[i - 1].trim()) ? i - 1 : i;
      if (cueStart > start) {
        push(start, cueStart);
        start = cueStart;
      }
      lastCueTime = i;
    }
    push(start, lines.length);
    return cues;
  }

  /**
   * @param {string} caption - One SRT cue: its number, timestamp and text lines.
   * @return {string}
   */
  static convertSrtCue(caption) {
    const lines = caption.split(/\n/);
    if (lines.length < 2) {
      return '';
    }

    const timestamp = SRT_TIMESTAMP;
    let line = 0;
    let cue = '';
    if (!timestamp.test(lines[0]) && timestamp.test(lines[1])) {
      const identifier = lines[0].match(/\w+/);
      if (identifier) {
        cue += identifier[0] + '\n';
      }
      line = 1;
    }

    const m = lines[line].match(timestamp);
    if (!m) {
      return '';
    }
    cue += this.srtTimestampToVtt(m[1], m[2], m[3], m[4]) + ' --> ' +
      this.srtTimestampToVtt(m[5], m[6], m[7], m[8]) + '\n';

    const cueText = lines.slice(line + 1).join('\n');
    if (cueText) {
      // Not after the last '>': [^>]* from every "<br" there would be quadratic.
      const end = cueText.lastIndexOf('>') + 1;
      cue += cueText.substring(0, end).replace(/<\s*\/?\s*br\b[^>]*>/gi, '\n') + cueText.substring(end);
    }
    return cue + '\n\n';
  }

  /**
   * ASS and SubRip tags to WebVTT.
   * @param {string} text
   * @return {string}
   */
  static convertSubtitleFormatting(text) {
    /** @type {Object<string, string>} */
    const alignmentSettings = {
      1: 'line:95% position:0% align:start',
      2: 'line:95% position:50% align:center',
      3: 'line:95% position:100% align:end',
      4: 'line:50% position:0% align:start',
      5: 'line:50% position:50% align:center',
      6: 'line:50% position:100% align:end',
      7: 'line:5% position:0% align:start',
      8: 'line:5% position:50% align:center',
      9: 'line:5% position:100% align:end',
    };

    // Only an alignment tag at the start of a cue's first line becomes the cue's settings.
    const lines = text.split('\n');
    const written = lines.slice();
    for (let i = 1; i < lines.length; i++) {
      // Other tags in its block ({\an8\i1}) stay for the override blocks below.
      const tag = /^\{\\?an(\d)((?:\\[^{}\n]*)?)\}/i.exec(lines[i]);
      if (!tag || !lines[i - 1].includes('-->')) {
        continue;
      }
      const timing = lines[i - 1].replace(/\r$/, '');
      const settings = alignmentSettings[tag[1]];
      lines[i - 1] = settings ? `${timing} ${settings}` : timing;
      lines[i] = (tag[2] ? `{${tag[2]}}` : '') + lines[i].substring(tag[0].length);
    }
    // Line by line: a stray "{\" must not swallow later cues.
    const converted = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
          // An ASS override block: i, b, u switches become tags (\b700 is on; \bord, \blur are
          // other tags); everything else has no WebVTT form and goes.
          .replace(/\{(\\[^{}\n]*)\}/g, (block, overrides) =>
            Array.from(overrides.matchAll(/\\([ibu])(\d*)(?![a-z])/gi), ([, tag, value]) =>
              value === '' || value === '0' ? `</${tag.toLowerCase()}>` : `<${tag.toLowerCase()}>`).join(''))
          .replace(/\{([ibu])\}/gi, '<$1>')
          .replace(/\{\/([ibu])\}/gi, '</$1>')
          .replace(/\{an\d\}/gi, '');
      // A line emptied of its tags goes: an empty line would end the cue.
      if (line.trim() === '' && written[i].trim() !== '') {
        continue;
      }
      converted.push(line);
    }

    return converted.join('\n')
        // ASS hard breaks in a row make one: an empty line would end the cue.
        .replace(/(?:\\N(?:\r?\n)?)+/g, '\n')
        // ASS soft line break.
        .replace(/\\n/g, ' ')
        .replace(/\\h/gi, ' ');
  }
}
