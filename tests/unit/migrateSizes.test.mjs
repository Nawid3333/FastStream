import {describe, expect, it} from 'vitest';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// Until #378 a bare number in "Maximum size of predownloaded video" was bytes: "10" saved
// 10 bytes where 10 MB was meant, and nothing could be predownloaded. Such a size is read as
// megabytes now, wherever the options are read.
describe('Utils.migrateSizes', () => {
  it('reads a maximum size below 1 MB as megabytes', () => {
    expect(Utils.migrateSizes({maxVideoSize: 10}).maxVideoSize).toBe(1e7);
    expect(Utils.migrateSizes({maxVideoSize: 500}).maxVideoSize).toBe(5e8);
    expect(Utils.migrateSizes({maxVideoSize: 0.5}).maxVideoSize).toBe(5e5);
  });

  it('leaves a real size, no limit and nothing alone, and changes nothing twice', () => {
    for (const size of [1e6, 1e7, 5e9, -1, 0, undefined]) {
      expect(Utils.migrateSizes({maxVideoSize: size}).maxVideoSize).toBe(size);
    }
    const once = Utils.migrateSizes({maxVideoSize: 10});
    expect(Utils.migrateSizes(once).maxVideoSize).toBe(1e7);
  });
});
