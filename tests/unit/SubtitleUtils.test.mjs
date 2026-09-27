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
});
