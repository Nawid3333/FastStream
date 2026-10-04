import {describe, expect, it} from 'vitest';
import {SubtitleUtils} from '../../chrome/player/utils/SubtitleUtils.mjs';

// Subtitle parsing is a classic silent-regression source: a broken parser
// doesn't crash, it just drops or mangles cues, and nobody notices until a
// user reports missing captions. This pins down the pure-string logic
// (time formatting and SRT->VTT conversion) that has no DOM dependency.

describe('vttTimeFormat / srtTimeFormat', () => {
  it('zero-pads hours, minutes, seconds and milliseconds', () => {
    expect(SubtitleUtils.vttTimeFormat(0)).toBe('00:00:00.000');
    expect(SubtitleUtils.vttTimeFormat(3661.5)).toBe('01:01:01.500');
  });

  it('differs from srtTimeFormat only by the ms separator', () => {
    expect(SubtitleUtils.vttTimeFormat(65.25)).toBe('00:01:05.250');
    expect(SubtitleUtils.srtTimeFormat(65.25)).toBe('00:01:05,250');
  });

  it('rounds to the nearest millisecond instead of flooring float error away', () => {
    // 1.001 * 1000 is 1000.9999999999999, and 0.1 + 0.2 is 0.30000000000000004; a time a
    // subtitle shift left as 1.2999999999999998 is 1.300 s, not 1.299.
    expect(SubtitleUtils.vttTimeFormat(1.001)).toBe('00:00:01.001');
    expect(SubtitleUtils.srtTimeFormat(1.2999999999999998)).toBe('00:00:01,300');
    expect(SubtitleUtils.vttTimeFormat(59.9996)).toBe('00:01:00.000');
    expect(SubtitleUtils.vttTimeFormat(3599.9999)).toBe('01:00:00.000');
  });
});

describe('convertSrtCue', () => {
  it('converts a standard cue with a leading sequence-number line', () => {
    const cue = '1\n00:00:01,000 --> 00:00:02,500\nHello world';
    const out = SubtitleUtils.convertSrtCue(cue);
    expect(out).toBe('1\n00:00:01.000 --> 00:00:02.500\nHello world\n\n');
  });

  it('converts a cue with no sequence-number line at all', () => {
    // Regression test: convertSrtCue is explicitly written to tolerate SRT
    // cues that start directly with a timestamp (no index line) - `line`
    // stays 0 and every lookup must use s[line], not a hardcoded s[1]. A
    // hardcoded s[1] would read the cue text as the timestamp regex input,
    // fail to match, and silently drop the whole cue (return '').
    const cue = '00:00:01,000 --> 00:00:02,500\nHello world';
    const out = SubtitleUtils.convertSrtCue(cue);
    expect(out).not.toBe('');
    expect(out).toContain('00:00:01.000 --> 00:00:02.500');
    expect(out).toContain('Hello world');
  });

  it('keeps every text line of a cue that has no sequence-number line', () => {
    const out = SubtitleUtils.convertSrtCue('00:00:01,000 --> 00:00:02,500\nLine one\nLine two\nLine three');
    expect(out).toBe('00:00:01.000 --> 00:00:02.500\nLine one\nLine two\nLine three\n\n');
  });

  it('joins multi-line cue text onto one line separated by \\n', () => {
    const cue = '1\n00:00:01,000 --> 00:00:02,500\nLine one\nLine two';
    const out = SubtitleUtils.convertSrtCue(cue);
    expect(out).toContain('Line one\nLine two');
  });

  it('converts <br> tags in the cue text to newlines', () => {
    const cue = '1\n00:00:01,000 --> 00:00:02,500\nLine one<br>Line two';
    const out = SubtitleUtils.convertSrtCue(cue);
    expect(out).toContain('Line one\nLine two');
  });

  it('returns an empty string for a cue with no timestamp line', () => {
    const out = SubtitleUtils.convertSrtCue('just some text\nmore text');
    expect(out).toBe('');
  });

  it('returns an empty string for a single-line (malformed) cue', () => {
    expect(SubtitleUtils.convertSrtCue('only one line')).toBe('');
  });
});

// SubRip files in the wild are loose about the timestamp line. Each case below was dropped
// (convertSrtCue returned '') or written as a timestamp WebVTT rejects, so the cue never
// showed; the WebVTT parser needs HH:MM:SS.mmm with exactly three digits.
describe('convertSrtCue: timestamps as SubRip files actually write them', () => {
  it('accepts a full stop as the millisecond separator', () => {
    const out = SubtitleUtils.convertSrtCue('1\n00:00:01.000 --> 00:00:02.500\nHello');
    expect(out).toBe('1\n00:00:01.000 --> 00:00:02.500\nHello\n\n');
  });

  it('writes .000 for a timestamp without milliseconds, not .undefined', () => {
    const out = SubtitleUtils.convertSrtCue('1\n00:00:01 --> 00:00:02\nHello');
    expect(out).toBe('1\n00:00:01.000 --> 00:00:02.000\nHello\n\n');
  });

  it('reads short milliseconds as a number of milliseconds, as ffmpeg and VLC do', () => {
    const out = SubtitleUtils.convertSrtCue('1\n00:00:01,5 --> 00:00:02,25\nHello');
    expect(out).toBe('1\n00:00:01.005 --> 00:00:02.025\nHello\n\n');
  });

  it('pads one-digit minutes and seconds', () => {
    const out = SubtitleUtils.convertSrtCue('1\n0:0:1,000 --> 0:0:2,000\nHello');
    expect(out).toBe('1\n0:00:01.000 --> 0:00:02.000\nHello\n\n');
  });

  it('keeps the cue when the sequence line holds no word characters', () => {
    const out = SubtitleUtils.convertSrtCue('-\n00:00:01,000 --> 00:00:02,000\nHello');
    expect(out).toBe('00:00:01.000 --> 00:00:02.000\nHello\n\n');
  });
});

describe('srt2webvtt', () => {
  for (const blankLines of [2, 3]) {
    it(`keeps every cue when cues are separated by ${blankLines} blank lines`, () => {
      // Splitting on exactly two newlines left an odd count's extra newline at the start of
      // the next cue, which then read as having no timestamp line and was dropped.
      const srt = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n' + '\n'.repeat(blankLines) +
        '2\n00:00:03,000 --> 00:00:04,000\nSecond';
      const out = SubtitleUtils.srt2webvtt(srt);
      expect(out).toContain('00:00:01.000 --> 00:00:02.000\nFirst');
      expect(out).toContain('00:00:03.000 --> 00:00:04.000\nSecond');
    });
  }

  it('keeps every cue when the blank line between them holds spaces or tabs', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n \t\n2\n00:00:03,000 --> 00:00:04,000\nSecond';
    const out = SubtitleUtils.srt2webvtt(srt);
    expect(out).toContain('00:00:01.000 --> 00:00:02.000\nFirst');
    expect(out).toContain('00:00:03.000 --> 00:00:04.000\nSecond');
  });

  // Each expectation below is what ffmpeg 9 (so mpv) makes of the same file, measured with
  // `ffmpeg -i x.srt -f webvtt -`, except that ffmpeg keeps the invisible line a
  // non-breaking-space separator leaves at the end of a cue.
  it('starts a cue at its timestamp when no blank line comes before it', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n2\n00:00:03,000 --> 00:00:04,000\nSecond';
    expect(SubtitleUtils.srt2webvtt(srt)).toBe('WEBVTT\n\n' +
      '1\n00:00:01.000 --> 00:00:02.000\nFirst\n\n' +
      '2\n00:00:03.000 --> 00:00:04.000\nSecond\n\n');
  });

  it('keeps every cue when the line between them holds only a non-breaking space', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n \n2\n00:00:03,000 --> 00:00:04,000\nSecond';
    expect(SubtitleUtils.srt2webvtt(srt)).toBe('WEBVTT\n\n' +
      '1\n00:00:01.000 --> 00:00:02.000\nFirst\n\n' +
      '2\n00:00:03.000 --> 00:00:04.000\nSecond\n\n');
  });

  it('keeps a non-breaking-space line inside a cue as part of its text', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nTop line\n \nBottom line\n\n' +
      '2\n00:00:03,000 --> 00:00:04,000\nSecond';
    expect(SubtitleUtils.srt2webvtt(srt)).toBe('WEBVTT\n\n' +
      '1\n00:00:01.000 --> 00:00:02.000\nTop line\n \nBottom line\n\n' +
      '2\n00:00:03.000 --> 00:00:04.000\nSecond\n\n');
  });

  it('keeps a line of spaces or tabs inside a cue, and the text below it', () => {
    for (const blank of ['  ', '\t']) {
      const srt = '1\n00:00:01,000 --> 00:00:02,000\nTop line\n' + blank + '\nBottom line\n\n' +
        '2\n00:00:03,000 --> 00:00:04,000\nSecond';
      expect(SubtitleUtils.srt2webvtt(srt)).toBe('WEBVTT\n\n' +
        '1\n00:00:01.000 --> 00:00:02.000\nTop line\n' + blank + '\nBottom line\n\n' +
        '2\n00:00:03.000 --> 00:00:04.000\nSecond\n\n');
    }
  });

  it('does not take a text line that starts with a number for a sequence number', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n' +
      '2\n00:00:03,000 --> 00:00:04,000\n12 monkeys\nSecond';
    expect(SubtitleUtils.srt2webvtt(srt)).toBe('WEBVTT\n\n' +
      '1\n00:00:01.000 --> 00:00:02.000\nFirst\n\n' +
      '2\n00:00:03.000 --> 00:00:04.000\n12 monkeys\nSecond\n\n');
  });

  it('produces a WEBVTT header followed by converted cues', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond';
    const out = SubtitleUtils.srt2webvtt(srt);
    expect(out.startsWith('WEBVTT\n\n')).toBe(true);
    expect(out).toContain('00:00:01.000 --> 00:00:02.000');
    expect(out).toContain('First');
    expect(out).toContain('00:00:03.000 --> 00:00:04.000');
    expect(out).toContain('Second');
  });

  it('strips dos newlines before splitting into cues', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello';
    const out = SubtitleUtils.srt2webvtt(srt);
    expect(out).toContain('Hello');
    expect(out).not.toContain('\r');
  });
});

describe('translateXMLEntities', () => {
  it('translates named entities', () => {
    expect(SubtitleUtils.translateXMLEntities('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
  });

  it('translates decimal and hex numeric references', () => {
    expect(SubtitleUtils.translateXMLEntities('&#65;')).toBe('A');
    expect(SubtitleUtils.translateXMLEntities('&#x41;')).toBe('A');
  });

  it('leaves plain text without entities untouched', () => {
    expect(SubtitleUtils.translateXMLEntities('no entities here')).toBe('no entities here');
  });
});

describe('convertSubtitleFormatting', () => {
  it('converts ASS-style bold/italic/underline tags to HTML tags', () => {
    expect(SubtitleUtils.convertSubtitleFormatting('{\\b1}bold{\\b}')).toBe('<b>bold</b>');
    expect(SubtitleUtils.convertSubtitleFormatting('{\\i1}italic{\\i}')).toBe('<i>italic</i>');
  });

  it('converts hard spaces to regular spaces', () => {
    expect(SubtitleUtils.convertSubtitleFormatting('a\\hb')).toBe('a b');
  });

  it('strips remaining alignment tags it does not translate inline', () => {
    expect(SubtitleUtils.convertSubtitleFormatting('{\\an5}')).toBe('');
  });

  it('turns an alignment tag right after the timing line into cue settings', () => {
    expect(SubtitleUtils.convertSubtitleFormatting('00:00:01.000 --> 00:00:02.000\n{\\an8}Top'))
        .toBe('00:00:01.000 --> 00:00:02.000 line:5% position:50% align:center\nTop');
    expect(SubtitleUtils.convertSubtitleFormatting('00:00:01.000 --> 00:00:02.000\r\n{\\AN1}Low\r\n'))
        .toBe('00:00:01.000 --> 00:00:02.000 line:95% position:0% align:start\nLow\r\n');
    expect(SubtitleUtils.convertSubtitleFormatting('00:00:01.000 --> 00:00:02.000\n{an0}Text'))
        .toBe('00:00:01.000 --> 00:00:02.000\nText');
  });

  it('drops an alignment tag on a later line of a cue instead of showing settings in the line above', () => {
    // The settings were appended to whatever line came before the tag, and were shown:
    // "first line line:5% position:50% align:center".
    expect(SubtitleUtils.convertSubtitleFormatting('00:00:01.000 --> 00:00:02.000\nfirst line\n{\\an8}second line'))
        .toBe('00:00:01.000 --> 00:00:02.000\nfirst line\nsecond line');
  });
});

describe('cuesAt', () => {
  const cue = (startTime, endTime, text) => ({startTime, endTime, text});
  const textsAt = (cues, time) => SubtitleUtils.cuesAt(cues, time).map((c) => c.text);

  it('keeps a long cue on screen while shorter, later cues start and end over it', () => {
    // A sign or song spanning dialogue went off when a dialogue cue ended: at 12.5 only
    // l2 showed, and at 20 nothing did.
    const cues = [cue(0, 100, 'SIGN'), cue(10, 12, 'l1'), cue(11, 13, 'l2')];
    expect(textsAt(cues, 5)).toEqual(['SIGN']);
    expect(textsAt(cues, 11.5)).toEqual(['SIGN', 'l1', 'l2']);
    expect(textsAt(cues, 12.5)).toEqual(['SIGN', 'l2']);
    expect(textsAt(cues, 20)).toEqual(['SIGN']);
    expect(textsAt(cues, 100)).toEqual(['SIGN']);
    expect(textsAt(cues, 100.001)).toEqual([]);
  });

  it('gives the cues whose start and end include the time, in start order', () => {
    const cues = [cue(1, 2, 'a'), cue(2, 3, 'b'), cue(2, 2.5, 'c'), cue(4, 5, 'd')];
    expect(textsAt(cues, 0)).toEqual([]);
    expect(textsAt(cues, 2)).toEqual(['a', 'b', 'c']);
    expect(textsAt(cues, 2.7)).toEqual(['b']);
    expect(textsAt(cues, 3.5)).toEqual([]);
    expect(textsAt([], 1)).toEqual([]);
    // After a seek back, the same cues in the same order: it keeps nothing from the last
    // time it was asked (#147).
    expect(textsAt(cues, 2)).toEqual(['a', 'b', 'c']);
    expect(textsAt(cues, 1.5)).toEqual(['a']);
  });
});

describe('isOpenSubtitlesDownloadLink', () => {
  it('takes an https link on OpenSubtitles\' hosts, as the API gives them', () => {
    for (const link of [
      'https://www.opensubtitles.com/download/D35F5069516828D0/subfile/Titanic.1997.srt',
      'https://opensubtitles.com/download/x/subfile/a.webvtt',
      'https://dl.opensubtitles.org/en/download/sub/1',
      'https://WWW.OpenSubtitles.COM/download/x',
    ]) {
      expect(SubtitleUtils.isOpenSubtitlesDownloadLink(link), link).toBe(true);
    }
  });

  it('refuses any other scheme or host, which the extension would fetch with its permissions', () => {
    for (const link of [
      'http://www.opensubtitles.com/download/x',
      'https://dl.example/sub.vtt',
      'https://opensubtitles.com.evil.example/download/x',
      'https://evilopensubtitles.com/download/x',
      'https://evil.example/#.opensubtitles.com',
      'https://evil.example/?www.opensubtitles.com',
      'https://www.opensubtitles.com@evil.example/x',
      'http://127.0.0.1:8080/admin',
      'file:///C:/Users/x/secret.txt',
      'moz-extension://abc/player/index.html',
      'javascript:alert(1)',
      'data:text/vtt,WEBVTT',
      '/download/x',
      '',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(SubtitleUtils.isOpenSubtitlesDownloadLink(link), String(link)).toBe(false);
    }
  });
});

describe('srt2webvtt: line endings', () => {
  const EXPECTED = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n\n2\n00:00:03.000 --> 00:00:04.000\nWorld\n\n';

  it('reads a SubRip file whose lines end in a carriage return only (classic Mac)', () => {
    // Every '\r' was removed, which left the whole file on one line and no cue.
    const srt = '1\r00:00:01,000 --> 00:00:02,000\rHello\r\r2\r00:00:03,000 --> 00:00:04,000\rWorld\r';
    expect(SubtitleUtils.srt2webvtt(srt)).toBe(EXPECTED);
  });

  it('still reads two carriage returns and a line feed as one line ending', () => {
    const srt = '1\r\r\n00:00:01,000 --> 00:00:02,000\r\r\nHello\r\r\n\r\r\n2\r\r\n00:00:03,000 --> 00:00:04,000\r\r\nWorld';
    expect(SubtitleUtils.srt2webvtt(srt)).toBe(EXPECTED);
  });
});

describe('translateXMLEntities: surrogates', () => {
  it('writes a reference to a surrogate code point as U+FFFD, as HTML does', () => {
    // String.fromCodePoint(0xD800) is a lone surrogate, and the WebVTT parser's decoder
    // threw "URI malformed" on it: the whole track failed to load.
    const replacement = String.fromCharCode(0xfffd);
    for (const reference of ['&#xD800;', '&#55296;', '&#xDFFF;', '&#xdc00;']) {
      expect(SubtitleUtils.translateXMLEntities('a' + reference + 'b')).toBe('a' + replacement + 'b');
    }
    expect(SubtitleUtils.translateXMLEntities('&#x1F600;')).toBe(String.fromCodePoint(0x1f600));
  });
});

describe('hostile input: linear time', () => {
  // Each took seconds with a regex that backtracks quadratically, on the page's main
  // thread, as soon as a page offered the file. The sizes below took 1-3 s each before.
  const budget = 250;

  /**
   * How long a call takes, in milliseconds.
   * @param {Function} fn - The call.
   * @return {number}
   */
  function elapsed(fn) {
    const started = performance.now();
    fn();
    return performance.now() - started;
  }

  it('trims a file with a long run of spaces inside it', () => {
    // /^\s+|\s+$/g retried \s+$ from every space of the run.
    const srt = '1\n00:00:01,000 --> 00:00:02,000\na' + ' '.repeat(60000) + 'b';
    expect(elapsed(() => SubtitleUtils.srt2webvtt(srt))).toBeLessThan(budget);
  });

  it('looks for a timestamp in a long line of digits', () => {
    // The unanchored timestamp regex tried (\d+): from every digit of the run.
    const srt = '1'.repeat(30000) + '\n' + '2'.repeat(30000) + '\nx';
    expect(elapsed(() => SubtitleUtils.srt2webvtt(srt))).toBeLessThan(budget);
  });

  it('looks for <br> tags in text full of unclosed "<br"', () => {
    // [^>]* ran to the end of the text from every "<br" when no '>' came after it.
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n' + '<br'.repeat(30000);
    expect(elapsed(() => SubtitleUtils.srt2webvtt(srt))).toBeLessThan(budget);
  });

  it('still turns <br> tags into line breaks', () => {
    expect(SubtitleUtils.convertSrtCue('1\n00:00:01,000 --> 00:00:02,000\na<br>b< BR />c</br>d<br x="1">e<brx>f<br'))
        .toBe('1\n00:00:01.000 --> 00:00:02.000\na\nb\nc\nd\ne<brx>f<br\n\n');
  });
});
