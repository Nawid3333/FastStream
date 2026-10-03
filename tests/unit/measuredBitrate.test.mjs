import {describe, expect, it} from 'vitest';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// FastStreamClient.updateHasDownloadSpace works out from this whether the whole video fits
// in the storage left. An MP4's ranges start on whole seconds, so on a high-bitrate one the
// first downloaded ranges all lasted 0 s: the bitrate came out as Infinity, the player
// warned that storage was short, and kept every downloaded fragment for the session (#210).

/** A fragment, downloaded when it has a size. */
const fragment = (dataSize, duration) => ({dataSize, duration});
const MB = 1000000;

describe('Utils.measuredBitrate', () => {
  it('is the downloaded bytes over their time, in bits per second', () => {
    const fragments = Array.from({length: 5}, () => fragment(MB, 1));
    expect(Utils.measuredBitrate(fragments)).toBe(8 * MB);
  });

  it('counts only downloaded fragments, and needs five of them', () => {
    const fragments = [...Array.from({length: 4}, () => fragment(MB, 1)), fragment(null, 1), undefined];
    expect(Utils.measuredBitrate(fragments)).toBeNull();
    fragments.push(fragment(MB, 1));
    expect(Utils.measuredBitrate(fragments)).toBe(8 * MB);
  });

  it('is unknown, not Infinity, while the downloaded fragments last no time', () => {
    // Five 1 MB ranges of a 40 Mbit/s video, all inside its first second.
    const fragments = Array.from({length: 5}, () => fragment(MB, 0));
    expect(Utils.measuredBitrate(fragments)).toBeNull();
  });
});
