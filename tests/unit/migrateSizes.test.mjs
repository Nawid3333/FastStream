import {describe, expect, it} from 'vitest';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// Until #378 a bare number in "Maximum size of predownloaded video" was bytes: "10" saved
// 10 bytes where 10 MB was meant, and nothing could be predownloaded. Such a size, in options
// saved before (no sizesVersion), is read as megabytes now, wherever the options are read.
describe('Utils.migrateSizes', () => {
  const migrate = (stored) => Utils.migrateSizes({...stored}, stored).maxVideoSize;

  it('reads a maximum size below 1 MB saved before as megabytes', () => {
    expect(migrate({maxVideoSize: 10})).toBe(1e7);
    expect(migrate({maxVideoSize: 500})).toBe(5e8);
    expect(Utils.migrateSizes({maxVideoSize: 10}, {maxVideoSize: 10}).sizesVersion).toBe(1);
  });

  it('leaves a size chosen since alone: 0.5 MB in the MB/GB picker is meant', () => {
    expect(migrate({maxVideoSize: 5e5, sizesVersion: 1})).toBe(5e5);
    expect(migrate({maxVideoSize: 10, sizesVersion: 1})).toBe(10);
  });

  it('leaves a real size, no limit and fresh options alone', () => {
    for (const size of [1e6, 1e7, 5e9, -1]) {
      expect(migrate({maxVideoSize: size})).toBe(size);
    }
    expect(Utils.migrateSizes({maxVideoSize: 5e9}, null).maxVideoSize).toBe(5e9);
  });

  // The options page reads 0 as no limit now, as an empty field. A speed limit of 0 saved
  // before held back reading ahead while the field said 0.
  it('reads a size or speed limit of 0 saved before as no limit', () => {
    const stored = {maxVideoSize: 0, maxSpeed: 0};
    const options = Utils.migrateSizes({...stored}, stored);
    expect(options.maxVideoSize).toBe(-1);
    expect(options.maxSpeed).toBe(-1);
    for (const speed of [-1, 125000]) {
      expect(Utils.migrateSizes({maxSpeed: speed}, {maxSpeed: speed}).maxSpeed).toBe(speed);
    }
    // Saved since: no page writes 0 any more, and what is there is left as it is.
    const since = {maxVideoSize: 0, maxSpeed: 0, sizesVersion: 1};
    expect(Utils.migrateSizes({...since}, since)).toMatchObject({maxVideoSize: 0, maxSpeed: 0});
  });
});
