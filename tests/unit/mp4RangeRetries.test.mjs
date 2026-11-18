import {describe, expect, it, vi} from 'vitest';

// A range that failed gets three retries (2, 4, 8 s apart). Their count outlived every seek
// and reset: once a network blip had used them up, the range failed on sight for good, even
// after the user seeked away and back.

const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');

/** A player as far as resetHLS() reaches into it. */
function playerWithSpentRetries() {
  const frag = {sn: 5, removeReference: vi.fn()};
  return {
    metaData: {tracks: []},
    segmentAppender: {reloaded: vi.fn()},
    removeFromBuffers: vi.fn(),
    mp4box: {flush: vi.fn(), seek: vi.fn(), stream: {buffers: []}},
    seekMp4box: vi.fn(),
    freeSamples: vi.fn(),
    loader: null,
    video: {duration: 100},
    currentTime: 50,
    currentFragments: [frag],
    rangeRetries: new Map([[frag, {count: 3, at: 0}]]),
    runLoad: vi.fn(),
  };
}

describe('MP4Player, a range whose retries were used up', () => {
  it('is tried afresh after a seek resets the player', () => {
    const player = playerWithSpentRetries();
    MP4Player.prototype.resetHLS.call(player, true);
    expect(player.rangeRetries.size).toBe(0);
  });

  it('says why its last download failed, once playback reaches it', () => {
    const frag = {sn: 2, failure: 'HTTP 403; through the page: The page did not answer'};
    const player = {
      rangeRetries: new Map([[frag, {count: 3, at: 0}]]),
      video: {buffered: {length: 0}, currentTime: 0},
      emit: vi.fn(),
      running: true,
    };
    expect(() => MP4Player.prototype.retryFailedRange.call(player, frag)).toThrow();
    expect(player.emit).toHaveBeenCalledWith('error', 'Range 2 failed to load (HTTP 403; through the page: The page did not answer)');
  });
});

// A destroyed preview or frame extractor gives its holds on fragments back, so the memory budget
// can let them go.
describe('MP4Player.destroy', () => {
  it('gives back its own holds on the fragments, one each, and no other player\'s', async () => {
    const {Fragment} = await import('../../chrome/player/players/Fragment.mjs');
    const {ReferenceTypes} = await import('../../chrome/player/enums/ReferenceTypes.mjs');
    const shared = Object.create(Fragment.prototype);
    shared.references = [];
    // The main player's hold, then this one's.
    shared.addReference(ReferenceTypes.MP4PLAYER, true);
    shared.addReference(ReferenceTypes.MP4PLAYER, true);
    const own = Object.create(Fragment.prototype);
    own.references = [];
    own.addReference(ReferenceTypes.MP4PLAYER, true);
    const player = {
      running: true, mediaSource: null, videoSourceBuffer: null, audioSourceBuffer: null,
      mediaSourceURL: null, loader: null, currentFragments: [shared, own], loopTimeout: null,
      video: {pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn()}, emit: vi.fn(),
    };
    MP4Player.prototype.destroy.call(player);
    expect(own.canFree()).toBe(true);
    expect(shared.references).toEqual([ReferenceTypes.MP4PLAYER]);
    expect(player.currentFragments).toEqual([]);
  });
});
