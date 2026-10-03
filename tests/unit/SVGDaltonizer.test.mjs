import {describe, expect, it} from 'vitest';
import {DaltonizerTypes, SVGDaltonizer} from '../../chrome/player/modules/SVGDaltonizer.mjs';

// The colour-blindness filter's matrices. updateCSSFilters builds one from the saved
// options while the player sets itself up, so a value it cannot use must not throw there.

const IDENTITY = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

describe('SVGDaltonizer', () => {
  it('corrects each known type', () => {
    for (const type of Object.values(DaltonizerTypes)) {
      expect(SVGDaltonizer.getCorrectiveMatrix(type, 0.5, true)).not.toEqual(IDENTITY);
      expect(SVGDaltonizer.getCorrectiveMatrix(type, 0.5, false)).not.toEqual(IDENTITY);
    }
  });

  it.each([
    ['an unknown type', undefined, 1],
    ['a type out of range', 3, 1],
    ['a strength that is no number', DaltonizerTypes.PROTANOMALY, NaN],
  ])('leaves the picture as it is for %s', (name, type, strength) => {
    // An imported settings file with videoDaltonizerType "foo" (CSSFilterUtils maps it to
    // undefined) threw a TypeError reading MachadoMatrices[undefined].
    for (const useMachado of [true, false]) {
      expect(SVGDaltonizer.getCorrectiveMatrix(type, strength, useMachado)).toEqual(IDENTITY);
    }
  });

  it('leaves the picture as it is at no strength', () => {
    expect(SVGDaltonizer.getCorrectiveMatrix(DaltonizerTypes.DEUTERANOMALY, 0, true)).toEqual(IDENTITY);
  });
});
