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

describe('srt2webvtt', () => {
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
