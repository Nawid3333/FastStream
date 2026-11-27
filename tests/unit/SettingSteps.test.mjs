import {describe, expect, it} from 'vitest';

import {DefaultOptions} from '../../chrome/player/options/defaults/DefaultOptions.mjs';
import {AheadSteps, BehindSteps, MaxSizeSteps, nearestStep, RamOnlySteps, SpeedSteps} from
  '../../chrome/player/options/SettingSteps.mjs';

describe('nearestStep', () => {
  it('keeps a step as it is', () => {
    for (const steps of [AheadSteps, MaxSizeSteps, BehindSteps, SpeedSteps, RamOnlySteps]) {
      for (const step of steps) expect(nearestStep(step, steps)).toBe(step);
    }
  });

  it('takes the closest step by ratio', () => {
    expect(nearestStep(45, AheadSteps)).toBe(60);
    expect(nearestStep(40, AheadSteps)).toBe(30);
    expect(nearestStep(2700, AheadSteps)).toBe(3600);
    expect(nearestStep(2500, AheadSteps)).toBe(1800);
  });

  it('takes 0 as the smallest step, so nothing that stops the video is left', () => {
    expect(nearestStep(0, AheadSteps)).toBe(30);
    expect(nearestStep(0, SpeedSteps)).toBe(2 * 125000);
  });

  it('takes no limit as the no-limit step, or the largest where there is none', () => {
    expect(nearestStep(-1, SpeedSteps)).toBe(-1);
    expect(nearestStep(Infinity, MaxSizeSteps)).toBe(-1);
    expect(nearestStep(-1, AheadSteps)).toBe(3600);
    expect(nearestStep(-1, RamOnlySteps)).toBe(4e9);
    expect(nearestStep(NaN, RamOnlySteps)).toBe(4e9);
  });

  it('offers the defaults as steps', () => {
    expect(AheadSteps).toContain(DefaultOptions.bufferAhead);
    expect(MaxSizeSteps).toContain(DefaultOptions.maxVideoSize);
    expect(BehindSteps).toContain(DefaultOptions.bufferBehind);
    expect(SpeedSteps).toContain(DefaultOptions.maxSpeed);
    expect(RamOnlySteps).toContain(DefaultOptions.ramBudget);
  });
});
