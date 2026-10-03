import {describe, expect, it} from 'vitest';
import fc from 'fast-check';

import {SubtitleUtils} from '../../chrome/player/utils/SubtitleUtils.mjs';

// Subtitle parsers fail silently: a cue the regex no longer matches is simply
// dropped, and playback misses a caption nobody reports for weeks. These
// property tests push generated timestamps, cue lists and arbitrary strings
// through the pure-string logic and pin what its code guarantees: no throw,
// times that re-parse to the same finite seconds with start never after end,
// and cue times/text that survive cuesToSrt -> srt2webvtt unchanged.
//
// The module serialises cues (cuesToSrt) and parses SRT text (srt2webvtt) but
// has no parser that returns cue objects, so the parse side of the round trip
// is srt2webvtt itself plus the small WebVTT reader below; the comparison then
// runs cue by cue. xml2vtt is left out: it needs DOMParser, which the vitest
// node environment does not provide.

// A WebVTT timestamp as srtTimestampToVtt writes it: minutes, seconds and
// milliseconds padded, hours exactly as they were written.
const VTT_TIMESTAMP = /^(\d+):(\d{2}):(\d{2})\.(\d{3})$/;
const VTT_CUE_TIME =
    /^(\d+):(\d{2}):(\d{2})\.(\d{3}) --> (\d+):(\d{2}):(\d{2})\.(\d{3})$/;

function secondsOfVttTimestamp(text) {
  const m = VTT_TIMESTAMP.exec(text);
  if (m === null) {
    return null;
  }
  return m[1] * 3600 + m[2] * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

// Reads the cues back out of a generated WebVTT file: a timestamp line starts
// a cue, its text runs to the next blank line, so an index line after a blank
// line is never mistaken for text.
function parseVttCues(vtt) {
  const cues = [];
  let current = null;
  let collecting = false;
  for (const line of vtt.split('\n')) {
    const m = VTT_CUE_TIME.exec(line);
    if (m !== null) {
      current = {
        start: m[1] * 3600 + m[2] * 60 + Number(m[3]) + Number(m[4]) / 1000,
        end: m[5] * 3600 + m[6] * 60 + Number(m[7]) + Number(m[8]) / 1000,
        text: '',
      };
      collecting = true;
      cues.push(current);
    } else if (line === '') {
      collecting = false;
    } else if (collecting && current !== null) {
      current.text = current.text === '' ? line : current.text + '\n' + line;
    }
  }
  return cues;
}

// Cue text built from characters that cannot look like a cue boundary, a <br>
// tag or a blank line: no newline, no '<', '>', no ':'.
const CUE_TEXT_CHARS =
    'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789.,;!?-_&'.split('');

// Text holding no '{', '}' or '\': nothing convertSubtitleFormatting rewrites.
const PLAIN_TEXT_CHARS =
    'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789 .,;:!?-()[]&%#@*+=/~^_'.split('');

const arbitraryCaption = fc.oneof(
    fc.string({unit: 'binary'}),
    fc.string({unit: 'binary'}).map((s) => '1\n' + s),
    fc.string({unit: 'binary'}).map((s) => '00:00:01,000 --> 00:00:02,000\n' + s),
);

const arbitrarySrt = fc.oneof(
    fc.string({unit: 'binary'}),
    fc.string({unit: 'binary'}).map((s) => '00:00:01,000 --> 00:00:02,000\n' + s),
    fc.string({unit: 'binary'}).map((s) => '1\n00:00:01,000 --> 00:00:02,000\n' + s),
);

describe('formatTimestamp / vttTimeFormat / srtTimeFormat', () => {
  const timeParts = fc.tuple(
      fc.nat({max: 99}), // hours
      fc.nat({max: 59}), // minutes
      fc.nat({max: 59}), // seconds
      fc.nat({max: 999}), // milliseconds
  );

  it('writes generated hour/minute/second/millisecond values so they re-parse to the same seconds', () => {
    fc.assert(fc.property(timeParts, ([h, m, s, ms]) => {
      const seconds = h * 3600 + m * 60 + s + ms / 1000;
      const parsed = secondsOfVttTimestamp(SubtitleUtils.vttTimeFormat(seconds));
      expect(parsed).not.toBeNull();
      expect(Math.abs(parsed - seconds)).toBeLessThanOrEqual(1e-6);
    }), {numRuns: 200});
  });

  it('rounds a generated arbitrary time to the nearest millisecond, never more than half a millisecond away', () => {
    // Line 107 uses Math.round; the comment at lines 99-101 documents why.
    fc.assert(fc.property(fc.nat({max: 0x7FFFFFFF}).map((n) => (n / 0x80000000) * 86400), (sec) => {
      const parsed = secondsOfVttTimestamp(SubtitleUtils.vttTimeFormat(sec));
      expect(parsed).not.toBeNull();
      expect(Math.abs(parsed - sec)).toBeLessThanOrEqual(0.0005 + 1e-6);
    }), {numRuns: 200});
  });

  it('writes every negative time as zero, as the function documents', () => {
    // Line 103: "a negative time is written as zero"; line 107 clamps it.
    fc.assert(fc.property(fc.nat({max: 1000000}).map((n) => -(n / 1000) - 0.001), (sec) => {
      expect(SubtitleUtils.vttTimeFormat(sec)).toBe('00:00:00.000');
      expect(SubtitleUtils.srtTimeFormat(sec)).toBe('00:00:00,000');
    }), {numRuns: 200});
  });

  it('differs from srtTimeFormat only by the millisecond separator', () => {
    // Lines 119-121 and 128-130: the same formatter with a different separator.
    fc.assert(fc.property(fc.nat({max: 86399999}).map((ms) => ms / 1000), (sec) => {
      expect(SubtitleUtils.srtTimeFormat(sec))
          .toBe(SubtitleUtils.vttTimeFormat(sec).replace('.', ','));
    }), {numRuns: 200});
  });
});

describe('convertSrtCue', () => {
  it('never throws on arbitrary input, and any non-empty result carries a timestamp arrow and ends with a blank line', () => {
    // Lines 232-245: without a matchable timestamp the cue is dropped (''),
    // otherwise the returned cue always holds ' --> ' and ends with '\n\n'.
    fc.assert(fc.property(arbitraryCaption, (caption) => {
      let out = null;
      try {
        out = SubtitleUtils.convertSrtCue(caption);
      } catch (error) {
        out = null;
      }
      expect(typeof out).toBe('string');
      if (out !== '') {
        expect(out).toContain(' --> ');
        expect(out.endsWith('\n\n')).toBe(true);
      }
    }), {numRuns: 200});
  });

  it('re-encodes generated loose SRT timestamps so they re-parse to the same finite seconds, with start never after end', () => {
    // The timestamp line (lines 3-5) accepts one-digit minutes and seconds, a
    // missing millisecond field, ',' or '.', and short or long millisecond
    // fields read as a number of milliseconds (lines 152-153, 160-163).
    const stampParts = fc.record({
      hours: fc.nat({max: 99}),
      minutes: fc.nat({max: 59}),
      seconds: fc.nat({max: 59}),
      ms: fc.nat({max: 999}),
      style: fc.constantFrom('none', 'bare', 'padded', 'long'),
      separator: fc.constantFrom(',', '.'),
    });

    const writtenMs = (ms, style) => {
      if (style === 'none') return '';
      if (style === 'bare') return String(ms);
      if (style === 'padded') return String(ms).padStart(3, '0');
      return String(ms).padStart(3, '0') + '9'; // four digits: read as its first three (line 162)
    };
    const readMs = (written) => {
      const digits = written === '' ? '0' :
        written.length > 3 ? written.slice(0, 3) : written.padStart(3, '0');
      return parseInt(digits, 10);
    };
    const writtenStamp = (p) => p.hours + ':' + p.minutes + ':' + p.seconds +
      (p.style === 'none' ? '' : p.separator + writtenMs(p.ms, p.style));
    const expectedSeconds = (p) =>
      p.hours * 3600 + p.minutes * 60 + p.seconds + readMs(writtenMs(p.ms, p.style)) / 1000;

    fc.assert(fc.property(fc.record({start: stampParts, end: stampParts}), ({start, end}) => {
      const [first, second] = expectedSeconds(start) <= expectedSeconds(end) ?
        [start, end] : [end, start];
      const cue = '1\n' + writtenStamp(first) + ' --> ' + writtenStamp(second) + '\nCue text';
      const out = SubtitleUtils.convertSrtCue(cue);
      expect(out).not.toBe('');
      const timeLine = VTT_CUE_TIME.exec(out.split('\n')[1]);
      expect(timeLine).not.toBeNull();
      const parsedStart = timeLine[1] * 3600 + timeLine[2] * 60 +
        Number(timeLine[3]) + Number(timeLine[4]) / 1000;
      const parsedEnd = timeLine[5] * 3600 + timeLine[6] * 60 +
        Number(timeLine[7]) + Number(timeLine[8]) / 1000;
      expect(Number.isFinite(parsedStart)).toBe(true);
      expect(Number.isFinite(parsedEnd)).toBe(true);
      expect(Math.abs(parsedStart - expectedSeconds(first))).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(parsedEnd - expectedSeconds(second))).toBeLessThanOrEqual(1e-6);
      expect(parsedStart).toBeLessThanOrEqual(parsedEnd);
    }), {numRuns: 200});
  });
});

describe('srt2webvtt', () => {
  it('never throws on arbitrary input; a non-empty result starts with the WEBVTT header and holds no carriage return', () => {
    // Line 59 strips every '\r'; lines 68-73 emit the header whenever any cue
    // block was found, even if all of them convert to ''.
    fc.assert(fc.property(arbitrarySrt, (data) => {
      let out = null;
      try {
        out = SubtitleUtils.srt2webvtt(data);
      } catch (error) {
        out = null;
      }
      expect(typeof out).toBe('string');
      expect(out.includes('\r')).toBe(false);
      if (out !== '') {
        expect(out.startsWith('WEBVTT\n\n')).toBe(true);
      }
    }), {numRuns: 200});
  });

  it('round-trips generated cues: cuesToSrt then srt2webvtt gives the same cue count, times within a millisecond and the same text', () => {
    const cueArb = fc.record({
      startMs: fc.nat({max: 86399999}),
      durationMs: fc.nat({max: 35999999}),
      text: fc.array(fc.constantFrom(...CUE_TEXT_CHARS), {minLength: 1, maxLength: 24})
          .map((chars) => chars.join('')),
    }).map(({startMs, durationMs, text}) => ({
      startTime: startMs / 1000,
      endTime: (startMs + durationMs) / 1000,
      text,
    }));

    fc.assert(fc.property(fc.array(cueArb, {minLength: 1, maxLength: 6}), (cues) => {
      const vtt = SubtitleUtils.srt2webvtt(SubtitleUtils.cuesToSrt(cues));
      const parsed = parseVttCues(vtt);
      expect(parsed.length).toBe(cues.length);
      for (let i = 0; i < cues.length; i++) {
        expect(Math.abs(parsed[i].start - cues[i].startTime)).toBeLessThanOrEqual(0.001 + 1e-9);
        expect(Math.abs(parsed[i].end - cues[i].endTime)).toBeLessThanOrEqual(0.001 + 1e-9);
        expect(parsed[i].text).toBe(cues[i].text);
      }
    }), {numRuns: 100});
  });
});

describe('splitAtCueStarts', () => {
  it('never throws on arbitrary input and returns blocks that are non-empty with a non-blank last line', () => {
    // Lines 179-186: trailing blank lines are popped and empty blocks dropped.
    fc.assert(fc.property(fc.string({unit: 'binary'}), (block) => {
      let cues = null;
      try {
        cues = SubtitleUtils.splitAtCueStarts(block);
      } catch (error) {
        cues = null;
      }
      expect(Array.isArray(cues)).toBe(true);
      for (const cue of cues) {
        expect(cue.length).toBeGreaterThan(0);
        expect(cue.split('\n').pop().trim()).not.toBe('');
      }
    }), {numRuns: 200});
  });
});

describe('translateXMLEntities', () => {
  it('never throws on arbitrary strings and returns them unchanged when no & appears', () => {
    // Lines 25-28: with no captured reference the input comes back as it is.
    fc.assert(fc.property(fc.string({unit: 'binary'}).map((s) => s.replace(/&/g, '.')), (s) => {
      let out = null;
      try {
        out = SubtitleUtils.translateXMLEntities(s);
      } catch (error) {
        out = null;
      }
      expect(out).toBe(s);
    }), {numRuns: 200});
  });

  it('resolves generated decimal and hexadecimal numeric references to the character of that code point', () => {
    // '#' numeric references, 'x' hexadecimal, 0..0x10FFFF; a surrogate code point, which
    // is no character, becomes U+FFFD as in HTML.
    const character = (code) => code >= 0xD800 && code <= 0xDFFF ?
      String.fromCharCode(0xFFFD) : String.fromCodePoint(code);
    const codes = fc.oneof(fc.nat({max: 0x10FFFF}), fc.integer({min: 0xD7F0, max: 0xE00F}));
    fc.assert(fc.property(codes, (code) => {
      expect(SubtitleUtils.translateXMLEntities('&#' + code + ';'))
          .toBe(character(code));
      expect(SubtitleUtils.translateXMLEntities('&#x' + code.toString(16) + ';'))
          .toBe(character(code));
      expect(SubtitleUtils.translateXMLEntities('&#' + code + ';').isWellFormed()).toBe(true);
    }), {numRuns: 200});
  });

  it('translates each of the five named entities it knows', () => {
    // Lines 17-23 and 44-46.
    const entities = [['&amp;', '&'], ['&gt;', '>'], ['&lt;', '<'], ['&quot;', '"'], ['&apos;', '\'']];
    for (const [ref, char] of entities) {
      expect(SubtitleUtils.translateXMLEntities(ref)).toBe(char);
    }
  });
});

describe('convertSubtitleFormatting', () => {
  it('never throws on arbitrary strings and always returns a string', () => {
    fc.assert(fc.property(fc.string({unit: 'binary'}), (text) => {
      let out = null;
      try {
        out = SubtitleUtils.convertSubtitleFormatting(text);
      } catch (error) {
        out = null;
      }
      expect(typeof out).toBe('string');
    }), {numRuns: 200});
  });

  it('leaves text without braces or backslashes byte for byte unchanged', () => {
    // Every replacement at lines 266-280 needs a tag's '{' or a '\h' hard
    // space; neither can occur in the generated text.
    fc.assert(fc.property(
        fc.array(fc.constantFrom(...PLAIN_TEXT_CHARS), {minLength: 0, maxLength: 32})
            .map((chars) => chars.join('')),
        (text) => {
          expect(SubtitleUtils.convertSubtitleFormatting(text)).toBe(text);
        },
    ), {numRuns: 200});
  });
});
