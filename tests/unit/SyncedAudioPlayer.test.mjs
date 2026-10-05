import {beforeEach, describe, expect, it, vi} from 'vitest';

// A positive video delay has SyncedAudioPlayer build two audio-only players and swap
// between them to keep the sound the delay ahead; a negative one, with Web Audio, puts a
// delay node in the sound's path. It only affects people who set a delay, and each of
// these left the delay off, or the next video muted, for the rest of the session.

// Resyncs wait for PLAYING events and half-second pauses: answered at once here.
vi.mock('../../chrome/player/utils/Utils.mjs', () => ({
  Utils: {
    timeoutableEvent: vi.fn(async () => true),
    asyncTimeout: vi.fn(async () => {}),
  },
}));

const {SyncedAudioPlayer} = await import('../../chrome/player/players/SyncedAudioPlayer.mjs');
const {Utils} = await import('../../chrome/player/utils/Utils.mjs');

const SOURCE = {mode: 'hls', url: 'https://example.test/stream.m3u8'};

/**
 * An audio-only player as the player loader makes one.
 * @return {Object}
 */
function audioPlayer() {
  const video = {currentTime: 0, paused: true, readyState: 4};
  const player = {
    volume: 1,
    playbackRate: 1,
    destroyed: false,
    setup: vi.fn(async () => {}),
    setSource: vi.fn(async () => {}),
    getVideo: () => video,
    on: vi.fn(),
    play: vi.fn(async () => {
      video.paused = false;
    }),
    pause: vi.fn(async () => {
      video.paused = true;
    }),
    destroy: vi.fn(() => {
      player.destroyed = true;
    }),
    set currentTime(value) {
      video.currentTime = value;
    },
  };
  return player;
}

/**
 * The client, with its main player playing.
 * @param {Object} [overrides] - What its player loader does.
 * @return {Object}
 */
function makeClient(overrides = {}) {
  const video = {currentTime: 10, paused: false, readyState: 4};
  return {
    player: {getSource: () => SOURCE, getVideo: () => video, volume: 1},
    currentVideo: video,
    state: {playing: true},
    playerLoader: {createPlayer: vi.fn(async () => audioPlayer()), ...overrides},
    interfaceController: {addVideo: vi.fn()},
    getCurrentVideoLevelID: () => null,
    getCurrentAudioLevelID: () => null,
    failedToLoad: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SyncedAudioPlayer', () => {
  it('builds the audio players again after a build that failed half way', async () => {
    // The flag was set before the build, and stayed: every later change of the delay
    // skipped the build, and the one player built made the resync throw.
    let calls = 0;
    const client = makeClient({createPlayer: vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error('the second one fails');
      return audioPlayer();
    })});
    const synced = new SyncedAudioPlayer(client);
    await synced.setVideoDelay(300);
    expect(synced.audioPlayers).toEqual([]);
    expect(synced.madePlayers).toBe(false);

    await synced.setVideoDelay(400);
    expect(client.playerLoader.createPlayer).toHaveBeenCalledTimes(4);
    expect(synced.audioPlayers).toHaveLength(2);
  });

  it('destroys a player whose source failed, which the cleanup of those built did not reach', async () => {
    // Not in audioPlayers yet: its element and audio source stayed after the failed build.
    const made = [];
    const client = makeClient({createPlayer: vi.fn(async () => {
      const player = audioPlayer();
      if (made.length === 1) {
        player.setSource = vi.fn(async () => {
          throw new Error('manifest failed to load');
        });
      }
      made.push(player);
      return player;
    })});
    const synced = new SyncedAudioPlayer(client);
    await synced.setVideoDelay(300);
    expect(synced.audioPlayers).toEqual([]);
    expect(made.map((player) => player.destroyed)).toEqual([true, true]);
  });

  it('keeps resyncing after one resync threw', async () => {
    // resyncing stayed set, and the drift was never corrected again that session.
    const synced = new SyncedAudioPlayer(makeClient());
    const internal = vi.spyOn(synced, 'silentResyncInternal').mockRejectedValueOnce(new Error('sync failed'));
    await synced.resync();
    internal.mockResolvedValue(true);
    await synced.resync();
    expect(internal).toHaveBeenCalledTimes(2);
  });

  it('does not resync with one player', async () => {
    const synced = new SyncedAudioPlayer(makeClient());
    synced.videoDelay = 300;
    synced.audioPlayers = [audioPlayer()];
    await expect(synced.silentResyncInternal()).resolves.toBe(false);
  });

  it('drops a player that finishes building after it was destroyed', async () => {
    // It went on building after the video changed: the player was added to the page and
    // kept downloading, and its errors showed on the new video.
    let finishSetup;
    const late = audioPlayer();
    late.setup = vi.fn(() => new Promise((resolve) => {
      finishSetup = resolve;
    }));
    const client = makeClient({createPlayer: vi.fn(async () => late)});
    const synced = new SyncedAudioPlayer(client);
    const building = synced.makePlayers(SOURCE);
    await vi.waitFor(() => expect(late.setup).toHaveBeenCalled());
    synced.destroy();
    finishSetup();
    await building;
    expect(late.destroyed).toBe(true);
    expect(synced.audioPlayers).toEqual([]);
    expect(client.interfaceController.addVideo).not.toHaveBeenCalled();
  });

  it('does not mute the next video with a resync that ends after it was destroyed', async () => {
    let finishPlay;
    const next = audioPlayer();
    next.play = vi.fn(() => new Promise((resolve) => {
      finishPlay = resolve;
    }));
    const client = makeClient();
    const synced = new SyncedAudioPlayer(client);
    synced.videoDelay = 300;
    synced.audioPlayers = [audioPlayer(), next];
    const resyncing = synced.resync();
    await vi.waitFor(() => expect(next.play).toHaveBeenCalled());
    synced.destroy();
    finishPlay();
    await resyncing;
    expect(client.player.volume).toBe(1);
  });

  it('does not mute the next video with a resync destroyed while it synced the time', async () => {
    let answer;
    Utils.timeoutableEvent.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const client = makeClient();
    const synced = new SyncedAudioPlayer(client);
    synced.videoDelay = 300;
    synced.audioPlayers = [audioPlayer(), audioPlayer()];
    const resyncing = synced.resync();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    synced.destroy();
    answer(true);
    await resyncing;
    expect(client.player.volume).toBe(1);
  });

  it('gives a large drift more than three resyncs', async () => {
    // Tested from the smallest error up, anything over 0.05 s took the first branch.
    const client = makeClient();
    const synced = new SyncedAudioPlayer(client);
    synced.videoDelay = 300;
    synced.audioPlayers = [audioPlayer(), audioPlayer()];
    // 0.5 s off: the audio should be at 10.3 s.
    synced.audioPlayers[0].getVideo().currentTime = 9.8;
    const resync = vi.spyOn(synced, 'resync').mockImplementation(async () => {});
    for (let i = 0; i < 12; i++) {
      await synced.watcherLoop();
    }
    expect(resync).toHaveBeenCalledTimes(10);
  });

  /**
   * Sends an event to a player as its own emitter would.
   * @param {Object} player - From audioPlayer().
   * @param {string} event
   * @param {*} [arg]
   */
  function emitTo(player, event, arg) {
    player.on.mock.calls.filter(([name]) => name === event).forEach(([, handler]) => handler(arg));
  }

  it('lets the video play on with its own sound when a separate audio player fails', async () => {
    // A hidden audio player's error (a segment its own loader gave up on) failed the whole
    // player: the error banner over a video that went on playing, and no fallback stream.
    const client = makeClient();
    const synced = new SyncedAudioPlayer(client);
    await synced.setVideoDelay(300);
    const players = synced.audioPlayers.slice();
    expect(players).toHaveLength(2);
    // The resync gave the sound to a separate player.
    client.player.volume = 0;

    emitTo(players[1], 'error', 'Segment failed to load');

    expect(client.failedToLoad).not.toHaveBeenCalled();
    expect(players.every((player) => player.destroyed)).toBe(true);
    expect(synced.audioPlayers).toEqual([]);
    expect(synced.madePlayers).toBe(false);
    expect(client.player.volume).toBe(1);
    // Nothing goes to the players that are gone.
    await synced.play();
    synced.setCurrentTime(20);
    expect(players[0].play).not.toHaveBeenCalled();
  });

  it('does not keep the other player when one fails while it is being built', async () => {
    let finishSetup;
    const first = audioPlayer();
    const second = audioPlayer();
    second.setup = vi.fn(() => new Promise((resolve) => {
      finishSetup = resolve;
    }));
    const made = [first, second];
    const client = makeClient({createPlayer: vi.fn(async () => made.shift())});
    const synced = new SyncedAudioPlayer(client);
    const building = synced.setVideoDelay(300);
    await vi.waitFor(() => expect(second.setup).toHaveBeenCalled());

    emitTo(first, 'error', 'Manifest failed to load');
    finishSetup();
    await building;

    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(true);
    expect(synced.audioPlayers).toEqual([]);
    expect(client.failedToLoad).not.toHaveBeenCalled();
  });

  it('delays the sound by a negative delay of more than a second in full', async () => {
    // The delay node was made for at most 1 s: -1500 ms played at -1000.
    const client = makeClient();
    const nodes = [];
    const context = {
      createDelay: vi.fn((max) => {
        const node = {max, delayTime: {value: 0}};
        nodes.push(node);
        return node;
      }),
    };
    const source = {connect: vi.fn(), disconnect: vi.fn()};
    const output = {connectFrom: vi.fn(), disconnectFrom: vi.fn()};
    const synced = new SyncedAudioPlayer(client);
    await synced.setup(context, source, output);

    await synced.setVideoDelay(-500);
    expect(nodes.at(-1).delayTime.value).toBe(0.5);
    await synced.setVideoDelay(-1500);
    expect(nodes.at(-1).max).toBeGreaterThanOrEqual(1.5);
    expect(nodes.at(-1).delayTime.value).toBe(1.5);
    // Back to no delay: the node leaves the sound's path.
    await synced.setVideoDelay(0);
    expect(synced.audioDelayNode).toBe(null);
    expect(output.connectFrom).toHaveBeenLastCalledWith(source);
  });
});
