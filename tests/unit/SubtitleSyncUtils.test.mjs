import {describe, expect, it} from 'vitest';
import {SubtitleSyncUtils} from '../../chrome/player/utils/SubtitleSyncUtils.mjs';

// The resync timeline draws only the cues in view. Its filter used `||`, which
// is true for every cue (each one starts before the end of the view OR ends
// after its start), so a two-hour track put all of its cues in the DOM and
// moved each of them on every frame.

const cue = (startTime, endTime) => ({startTime, endTime});

describe('cuesInRange', () => {
  const cues = [cue(1, 2), cue(10, 12), cue(29, 31), cue(40, 41), cue(100, 105)];

  it('keeps only the cues that overlap the range', () => {
    expect(SubtitleSyncUtils.cuesInRange(cues, 5, 35)).toEqual([cue(10, 12), cue(29, 31)]);
  });

  it('drops cues entirely before or after the range', () => {
    expect(SubtitleSyncUtils.cuesInRange(cues, 50, 60)).toEqual([]);
  });

  it('keeps a cue that only touches an edge or spans the whole range', () => {
    expect(SubtitleSyncUtils.cuesInRange([cue(0, 5), cue(35, 40)], 5, 35)).toHaveLength(2);
    expect(SubtitleSyncUtils.cuesInRange([cue(0, 100)], 5, 35)).toHaveLength(1);
  });

  it('does not change the cue list', () => {
    const copy = cues.slice();
    SubtitleSyncUtils.cuesInRange(cues, 5, 35);
    expect(cues).toEqual(copy);
  });
});

describe('formatShift', () => {
  it('signs and rounds to two decimals', () => {
    expect(SubtitleSyncUtils.formatShift(1.4)).toBe('+1.40');
    expect(SubtitleSyncUtils.formatShift(-0.2)).toBe('-0.20');
    expect(SubtitleSyncUtils.formatShift(0.1 + 0.2)).toBe('+0.30');
  });

  it('shows no shift as +0.00, also after float noise', () => {
    expect(SubtitleSyncUtils.formatShift(0)).toBe('+0.00');
    expect(SubtitleSyncUtils.formatShift(0.2 - 0.2 - 1e-9)).toBe('+0.00');
    expect(SubtitleSyncUtils.formatShift(-0.001)).toBe('+0.00');
  });
});
