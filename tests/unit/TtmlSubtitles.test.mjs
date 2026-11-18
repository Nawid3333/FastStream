import {describe, expect, it} from 'vitest';
import {DEFAULT_TTML_RATES, closeOpenEnds, isTtml, parseTtmlTime, ttmlRates} from '../../chrome/player/utils/TtmlSubtitles.mjs';

// The document walk (ttmlCues, ttml2vtt) needs a DOMParser: subtitle-ttml.e2e.mjs runs it in Firefox.

describe('parseTtmlTime', () => {
  const rates = DEFAULT_TTML_RATES;

  it('reads clock times, with a fraction or with frames and sub-frames', () => {
    expect(parseTtmlTime('00:00:01.500', rates)).toBeCloseTo(1.5, 9);
    expect(parseTtmlTime('01:02:03', rates)).toBe(3723);
    expect(parseTtmlTime('100:00:00.25', rates)).toBeCloseTo(360000.25, 9);
    expect(parseTtmlTime('00:00:01:15', {frameRate: 30, subFrameRate: 1, tickRate: 1})).toBeCloseTo(1.5, 9);
    expect(parseTtmlTime('00:00:00:12.1', {frameRate: 24, subFrameRate: 2, tickRate: 1})).toBeCloseTo(0.5 + 1 / 48, 9);
  });

  it('reads offset times in every unit', () => {
    const at = {frameRate: 25, subFrameRate: 1, tickRate: 10000000};
    expect(parseTtmlTime('1.5s', at)).toBeCloseTo(1.5, 9);
    expect(parseTtmlTime('250ms', at)).toBeCloseTo(0.25, 9);
    expect(parseTtmlTime('2h', at)).toBe(7200);
    expect(parseTtmlTime('1.5m', at)).toBe(90);
    expect(parseTtmlTime('50f', at)).toBe(2);
    expect(parseTtmlTime('15000000t', at)).toBeCloseTo(1.5, 9);
    expect(parseTtmlTime(' 3s ', at)).toBe(3);
  });

  it('gives NaN for what is no TTML time', () => {
    for (const bad of [null, '', 's', '1.5', '-1s', '1:02:03', '00:00:60.5x', '1e3s', '00:00:01.', 'NaN']) {
      expect(parseTtmlTime(bad, rates), String(bad)).toBeNaN();
    }
  });
});

describe('ttmlRates', () => {
  const from = (attributes) => ttmlRates((name) => attributes[name] ?? null);

  it('has TTML\'s defaults: 30 frames, a tick a second', () => {
    expect(from({})).toEqual({frameRate: 30, subFrameRate: 1, tickRate: 1});
  });

  it('applies the frame rate multiplier, and counts ticks in sub-frames when only a frame rate is named', () => {
    const rates = from({frameRate: '30', frameRateMultiplier: '1000 1001', subFrameRate: '2'});
    expect(rates.frameRate).toBeCloseTo(29.97, 2);
    expect(rates.tickRate).toBeCloseTo(59.94, 2);
    expect(from({tickRate: '10000000'}).tickRate).toBe(10000000);
  });

  it('ignores rates that are not positive numbers', () => {
    expect(from({frameRate: '0', tickRate: '-5', subFrameRate: 'x', frameRateMultiplier: '0 1'}))
        .toEqual({frameRate: 30, subFrameRate: 1, tickRate: 1});
  });
});

describe('isTtml', () => {
  it('knows a TTML or DFXP document by its root, after a declaration, comments and white space', () => {
    expect(isTtml('<tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>')).toBe(true);
    expect(isTtml('<?xml version="1.0" encoding="utf-8"?>\n<!-- made by x -->\n<tt xml:lang="en">')).toBe(true);
    expect(isTtml('﻿  <tt:tt xmlns:tt="http://www.w3.org/ns/ttml">')).toBe(true);
    expect(isTtml('<!DOCTYPE tt>\n<tt>')).toBe(true);
  });

  it('leaves timed-text XML, WebVTT, SubRip and other XML to their readers', () => {
    expect(isTtml('<?xml version="1.0"?><transcript><text start="1">a</text></transcript>')).toBe(false);
    expect(isTtml('WEBVTT\n\n00:00.000 --> 00:01.000\nHello')).toBe(false);
    expect(isTtml('1\n00:00:01,000 --> 00:00:02,000\nHello')).toBe(false);
    expect(isTtml('<ttx/>')).toBe(false);
    expect(isTtml('<html><tt>code</tt></html>')).toBe(false);
    expect(isTtml('<!--x--><foo><!--y--><tt>')).toBe(false);
  });

  it('answers at once for hostile text', () => {
    const start = performance.now();
    expect(isTtml(' '.repeat(100000) + 'x')).toBe(false);
    expect(isTtml('<!--'.repeat(5000))).toBe(false);
    expect(isTtml('<?'.repeat(5000))).toBe(false);
    // Comments that could each be read as running into the next one: 2^39 ways before.
    expect(isTtml('<!--a-->'.repeat(40) + '<x/>')).toBe(false);
    expect(isTtml('<!--a-->'.repeat(900) + '<tt>')).toBe(true);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('closeOpenEnds', () => {
  it('sorts by start and ends an open cue at the next later start, the last after 2 s', () => {
    const cues = closeOpenEnds([
      {start: 5, end: Infinity, text: 'c'},
      {start: 1, end: Infinity, text: 'a'},
      {start: 1, end: 3, text: 'a2'},
      {start: 2, end: 4, text: 'b'},
    ]);
    expect(cues.map((cue) => [cue.text, cue.start, cue.end])).toEqual([
      ['a', 1, 2], ['a2', 1, 3], ['b', 2, 4], ['c', 5, 7],
    ]);
  });

  it('closes very many cues in well under a second', () => {
    const cues = Array.from({length: 150000}, (_, i) => ({start: i, end: Infinity, text: 'x'}));
    const start = performance.now();
    closeOpenEnds(cues);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(cues[149998].end).toBe(149999);
    expect(cues[149999].end).toBe(150001);
  });
});
