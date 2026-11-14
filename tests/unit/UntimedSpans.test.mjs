import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {isTimed, untimedSpans} from '../../chrome/player/network/UntimedSpans.mjs';

// Where a fragmented MP4's ranges that the player has not parsed yet lie in the video, about:
// what the download window goes by for them (FastStreamClient.windowSpan, freeFragments).

const timed = (start, end = start + 10) => ({start, end});
const untimed = () => ({start: -1, end: -1});

describe('isTimed', () => {
  it('is false for a fragment with no times yet, and for one whose times are no numbers', () => {
    expect(isTimed(timed(0))).toBe(true);
    expect(isTimed(untimed())).toBe(false);
    expect(isTimed({start: 0, end: -1})).toBe(false);
    expect(isTimed({start: NaN, end: 5})).toBe(false);
    expect(isTimed({start: 0, end: Infinity})).toBe(false);
  });
});

describe('untimedSpans', () => {
  it('places the ranges after the parsed ones at the pace those had', () => {
    // Four ranges parsed, ten seconds each; the last parsed one ends at the video's end, as
    // MP4Player.setFragmentTimes leaves it.
    const fragments = [timed(0), timed(10), timed(20), timed(30, 600), untimed(), untimed(), untimed()];
    const spans = untimedSpans(fragments);
    expect([...spans.keys()]).toEqual([4, 5, 6]);
    expect(spans.get(4)).toEqual({start: 40, end: 50});
    expect(spans.get(6)).toEqual({start: 60, end: 70});
  });

  it('places the ranges between two parsed stretches evenly between them', () => {
    // Played from the start, then sought to the middle: the ranges between were never parsed.
    const fragments = [timed(0), timed(10), untimed(), untimed(), untimed(), timed(90), timed(100)];
    const spans = untimedSpans(fragments);
    expect(spans.get(2)).toEqual({start: 30, end: 50});
    expect(spans.get(3)).toEqual({start: 50, end: 70});
    expect(spans.get(4)).toEqual({start: 70, end: 90});
  });

  it('places the ranges before the first parsed one back from it, never before the start', () => {
    const fragments = [untimed(), untimed(), timed(50), timed(60)];
    const spans = untimedSpans(fragments);
    expect(spans.get(1)).toEqual({start: 40, end: 50});
    expect(spans.get(0)).toEqual({start: 30, end: 40});
    expect(untimedSpans([untimed(), untimed(), untimed(), untimed(), untimed(), untimed(), timed(50), timed(60)]).get(0).start).toBe(0);
  });

  it('places none while fewer than two ranges have their times, or those tell no pace', () => {
    expect(untimedSpans([timed(0), untimed(), untimed()]).size).toBe(0);
    expect(untimedSpans([untimed(), untimed()]).size).toBe(0);
    expect(untimedSpans([]).size).toBe(0);
    expect(untimedSpans([timed(0), timed(0), untimed()]).size).toBe(0);
  });

  it('skips the places of a list that hold nothing', () => {
    const fragments = [timed(0), timed(10), undefined, null, untimed()];
    expect([...untimedSpans(fragments).keys()]).toEqual([4]);
    expect(untimedSpans(fragments).get(4)).toEqual({start: 40, end: 50});
  });

  it('places every range without times, in order, and none that has them (any list)', () => {
    // A level's ranges: the parsed ones at rising times, any of them missing their times.
    const lists = fc.array(fc.record({gap: fc.double({min: 0.5, max: 60, noNaN: true}), parsed: fc.boolean()}),
        {minLength: 0, maxLength: 60}).map((entries) => {
      let at = 0;
      return entries.map(({gap, parsed}) => {
        const start = at;
        at += gap;
        return parsed ? {start, end: at} : untimed();
      });
    });
    fc.assert(fc.property(lists, (fragments) => {
      const spans = untimedSpans(fragments);
      const parsed = fragments.filter(isTimed).length;
      const starts = new Set(fragments.filter(isTimed).map((fragment) => fragment.start));
      // With a pace to go by, every range without times is placed; without, none.
      const placeable = parsed >= 2 && starts.size >= 2;
      expect(spans.size).toBe(placeable ? fragments.length - parsed : 0);
      let last = -Infinity;
      fragments.forEach((fragment, i) => {
        const span = isTimed(fragment) ? fragment : spans.get(i);
        if (isTimed(fragment)) expect(spans.has(i)).toBe(false);
        if (!span) return;
        expect(span.start).toBeGreaterThanOrEqual(0);
        expect(span.end).toBeGreaterThanOrEqual(span.start);
        // In the order of the list: a range never lies before the one before it.
        expect(span.start).toBeGreaterThanOrEqual(last - 1e-6);
        last = span.start;
      });
    }));
  });
});
