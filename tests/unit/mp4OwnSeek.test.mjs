import {afterEach, describe, expect, it, vi} from 'vitest';
import {playerOnFakeElement} from './helpers/fakeMediaElement.mjs';

// A seek made through MP4Player's currentTime is checked there (reloadUnlessBuffered), and the
// element's `seeking` for it is not checked a second time (onElementSeeking, ownSeek). The mark
// was dropped on any `seeked`, also one an earlier seek had queued: seek A into what is buffered,
// then B elsewhere before A's `seeked` ran - A's `seeked` dropped B's mark, B's `seeking` was taken
// for a seek the element made itself, and the player was reset a second time, aborting the range
// B's reset had just asked for.

const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A playing MP4Player with 0-20 s buffered, its resets counted.
 * @return {{player: Object, video: Object}}
 */
function bufferedPlayer() {
  const {player, video} = playerOnFakeElement(MP4Player, vi.stubGlobal);
  player.running = true;
  player.metaData = {tracks: []};
  video.ranges = [[0, 20]];
  vi.spyOn(player, 'resetHLS').mockImplementation(() => {});
  return {player, video};
}

describe('MP4Player, its own seeks', () => {
  it('resets once for a seek whose `seeking` comes after an earlier seek\'s `seeked`', () => {
    const {player, video} = bufferedPlayer();
    player.currentTime = 10;
    player.currentTime = 60;
    expect(player.resetHLS).toHaveBeenCalledTimes(1);
    // The first seek's `seeked`, queued before the second began, then the second's `seeking`.
    video.dispatchEvent(new Event('seeked'));
    video.dispatchEvent(new Event('seeking'));
    expect(player.resetHLS).toHaveBeenCalledTimes(1);
  });

  it('forgets its seek once it has landed: a later seek the element makes itself is checked', () => {
    const {player, video} = bufferedPlayer();
    player.currentTime = 60;
    video.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    expect(player.ownSeek).toBeNull();
    // Played again after its end, say: the element seeks by itself, to where the setter went.
    video.ranges = [];
    video.currentTime = 60;
    video.dispatchEvent(new Event('seeking'));
    expect(player.resetHLS).toHaveBeenCalledTimes(2);
  });
});
