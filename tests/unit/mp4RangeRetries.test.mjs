import {describe, expect, it, vi} from 'vitest';

// A range that failed gets three retries (2, 4, 8 s apart). Their count outlived every seek
// and reset: once a network blip had used them up, the range failed on sight for good, even
// after the user seeked away and back (review, 2026-10-09).

const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');

/** A player as far as resetHLS() reaches into it. */
function playerWithSpentRetries() {
  const frag = {sn: 5, removeReference: vi.fn()};
  return {
    metaData: {tracks: []},
    segmentAppender: {reloaded: vi.fn()},
    removeFromBuffers: vi.fn(),
    mp4box: {flush: vi.fn(), seek: vi.fn(), stream: {buffers: []}},
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
});
