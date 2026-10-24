import {afterEach, describe, expect, it, vi} from 'vitest';

import {describe as describeInfo, MediaKeys} from '../../chrome/player/ui/MediaKeys.mjs';

// The keyboard's next- and previous-track keys go to the next and previous episode, while the
// player has one (his report, 2026-10-22: they did nothing). The Media Session stands in for
// Firefox's: what matters is which actions have a handler, and what a handler does.

/** A Media Session that keeps what was set, as Firefox's does. */
function fakeSession() {
  const handlers = new Map();
  return {
    handlers,
    setActionHandler: vi.fn((action, handler) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    }),
  };
}

/** A player whose next and previous episodes the test sets. */
function fakeClient() {
  return {
    next: false,
    previous: false,
    hasNextVideo() {
      return this.next;
    },
    hasPreviousVideo() {
      return this.previous;
    },
    nextVideo: vi.fn(),
    previousVideo: vi.fn(),
  };
}

describe('MediaKeys', () => {
  it('offers no key while the player has no episode to go to', () => {
    const session = fakeSession();
    new MediaKeys(/** @type {*} */ (fakeClient()), /** @type {*} */ (session)).update();
    expect(session.handlers.size).toBe(0);
    // Nothing to take back either: a key another player of the page offered stays untouched.
    expect(session.setActionHandler).not.toHaveBeenCalled();
  });

  it('goes to the next and the previous episode once the player knows them', () => {
    const session = fakeSession();
    const client = fakeClient();
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session));
    client.next = true;
    client.previous = true;
    keys.update();

    session.handlers.get('nexttrack')();
    expect(client.nextVideo).toHaveBeenCalledTimes(1);
    expect(client.previousVideo).not.toHaveBeenCalled();
    session.handlers.get('previoustrack')();
    expect(client.previousVideo).toHaveBeenCalledTimes(1);
  });

  it('takes a key back when its episode goes, so the overlay greys it out', () => {
    const session = fakeSession();
    const client = fakeClient();
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session));
    client.next = true;
    keys.update();
    expect(session.handlers.has('nexttrack')).toBe(true);

    client.next = false;
    keys.update();
    expect(session.handlers.has('nexttrack')).toBe(false);
    expect(session.setActionHandler).toHaveBeenLastCalledWith('nexttrack', null);
  });

  it('sets each key once, however often the buttons are updated', () => {
    const session = fakeSession();
    const client = fakeClient();
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session));
    client.next = true;
    keys.update();
    keys.update();
    keys.update();
    expect(session.setActionHandler).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a Media Session, and keeps going when Firefox refuses an action', () => {
    const client = fakeClient();
    client.next = true;
    expect(() => new MediaKeys(/** @type {*} */ (client), null).update()).not.toThrow();

    const refusing = {setActionHandler: vi.fn(() => {
      throw new TypeError('not supported');
    })};
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (refusing));
    expect(() => keys.update()).not.toThrow();
    // Asked again next time: the action may be there by then.
    keys.update();
    expect(refusing.setActionHandler).toHaveBeenCalledTimes(2);
  });
});

// The overlay showed only "FastStream" (his report, 2026-10-24): the video's name, a frame of
// it and its time line, and seek keys, are the Media Session's too.

/** A Media Session with the overlay's parts: metadata, the time line, every action. */
function fullSession() {
  return Object.assign(fakeSession(), {
    metadata: /** @type {*} */ (null),
    setPositionState: vi.fn(),
  });
}

/** MediaMetadata as Firefox makes it: what it was given. */
class FakeMetadata {
  /** @param {Object} init */
  constructor(init) {
    Object.assign(this, init);
  }
}

/** A playing video's player: time, length, rate, and the seek-save switch. */
function playingClient(overrides = {}) {
  return Object.assign(fakeClient(), {
    currentTime: 30,
    duration: 1200,
    playbackRate: 1,
    live: false,
    isLive() {
      return this.live;
    },
    setSeekSave: vi.fn(),
  }, overrides);
}

describe('MediaKeys, the overlay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the video, with its season and episode or its year underneath', () => {
    const session = fullSession();
    const keys = new MediaKeys(/** @type {*} */ (playingClient()), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata));
    keys.setInfo({name: 'Example Series', season: 1, episode: 3});
    expect(session.metadata).toMatchObject({title: 'Example Series', artist: 'S01E03', artwork: []});
    keys.setInfo({name: 'A Film', year: 2024, season: null, episode: null});
    expect(session.metadata).toMatchObject({title: 'A Film', artist: '2024'});
    // No name known: Firefox's own (the tab's title) again.
    keys.setInfo({name: ''});
    expect(session.metadata).toBe(null);
  });

  it('describes a title by season and episode, the episode alone, the season, the year or nothing', () => {
    expect(describeInfo({name: 'x', season: 2, episode: 11})).toBe('S02E11');
    expect(describeInfo({name: 'x', episode: 120})).toBe('E120');
    expect(describeInfo({name: 'x', season: 3})).toBe('S03');
    expect(describeInfo({name: 'x', year: 1999})).toBe('1999');
    expect(describeInfo({name: 'x'})).toBe('');
  });

  it('shows a frame of the video as its picture, and lets the old one go', async () => {
    const created = [];
    const revoked = [];
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        created.push(`blob:frame-${created.length + 1}`);
        return created.at(-1);
      }),
      revokeObjectURL: vi.fn((url) => revoked.push(url)),
    });
    const session = fullSession();
    const keys = new MediaKeys(/** @type {*} */ (playingClient()), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata));
    keys.setInfo({name: 'Example Series', episode: 1});
    const video = /** @type {*} */ ({videoWidth: 1920, videoHeight: 1080});
    const capture = vi.fn(async () => new Blob(['jpeg']));
    await keys.setArtwork(video, capture);
    expect(capture).toHaveBeenCalledWith(video, 320, 180);
    expect(session.metadata.artwork).toEqual([{src: 'blob:frame-1', sizes: '320x180', type: 'image/jpeg'}]);

    await keys.setArtwork(video, capture);
    expect(session.metadata.artwork[0].src).toBe('blob:frame-2');
    expect(revoked).toEqual(['blob:frame-1']);
  });

  it('keeps no picture of a video another origin taints, nor of one with no frame yet', async () => {
    const session = fullSession();
    const keys = new MediaKeys(/** @type {*} */ (playingClient()), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata));
    keys.setInfo({name: 'A Film'});
    await keys.setArtwork(/** @type {*} */ ({videoWidth: 1280, videoHeight: 720}), async () => {
      throw new DOMException('tainted', 'SecurityError');
    });
    expect(session.metadata.artwork).toEqual([]);
    const capture = vi.fn();
    await keys.setArtwork(/** @type {*} */ ({videoWidth: 0, videoHeight: 0}), capture);
    expect(capture).not.toHaveBeenCalled();
  });

  it('gives the overlay the time line: where, how long, how fast', () => {
    const session = fullSession();
    const client = playingClient({currentTime: 95.5, duration: 1440, playbackRate: 2});
    new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata)).updatePosition();
    expect(session.setPositionState).toHaveBeenLastCalledWith({duration: 1440, playbackRate: 2, position: 95.5});
  });

  it('gives a live stream, or a video of no known length, no time line', () => {
    for (const client of [playingClient({live: true}), playingClient({duration: Infinity}), playingClient({duration: NaN})]) {
      const session = fullSession();
      new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata)).updatePosition();
      expect(session.setPositionState).toHaveBeenLastCalledWith();
    }
  });

  it('keeps a position inside the video, and a paused rate of 0 a valid one', () => {
    const session = fullSession();
    new MediaKeys(/** @type {*} */ (playingClient({currentTime: 1300, duration: 1200, playbackRate: 0})), /** @type {*} */ (session),
        /** @type {*} */ (FakeMetadata)).updatePosition();
    expect(session.setPositionState).toHaveBeenLastCalledWith({duration: 1200, playbackRate: 1, position: 1200});
  });

  it('sets the time line again on a time update only every few seconds', () => {
    vi.useFakeTimers();
    try {
      const session = fullSession();
      const keys = new MediaKeys(/** @type {*} */ (playingClient()), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata));
      keys.updatePosition(false);
      keys.updatePosition(false);
      expect(session.setPositionState).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      keys.updatePosition(false);
      expect(session.setPositionState).toHaveBeenCalledTimes(2);
      // A seek or a rate change sets it at once.
      keys.updatePosition();
      expect(session.setPositionState).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeks back and forward by the overlay\'s step or 10 s, and to a time, as the arrow keys do', () => {
    const session = fullSession();
    const client = playingClient({currentTime: 100});
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata));
    keys.offerSeeking();
    keys.offerSeeking();
    expect(session.setActionHandler.mock.calls.map(([action]) => action)).toEqual(['seekbackward', 'seekforward', 'seekto']);

    session.handlers.get('seekforward')({action: 'seekforward'});
    expect(client.currentTime).toBe(110);
    session.handlers.get('seekbackward')({action: 'seekbackward', seekOffset: 5});
    expect(client.currentTime).toBe(105);
    session.handlers.get('seekto')({action: 'seekto', seekTime: 600});
    expect(client.currentTime).toBe(600);
    session.handlers.get('seekto')({action: 'seekto'});
    expect(client.currentTime).toBe(600);
    expect(client.setSeekSave.mock.calls).toEqual([[false], [true], [false], [true], [false], [true]]);
    expect(session.setPositionState).toHaveBeenLastCalledWith({duration: 1200, playbackRate: 1, position: 600});
  });

  it('lets a video\'s picture and time line go with it, and keeps the page\'s name', async () => {
    vi.stubGlobal('URL', {createObjectURL: () => 'blob:frame', revokeObjectURL: vi.fn()});
    const session = fullSession();
    const keys = new MediaKeys(/** @type {*} */ (playingClient()), /** @type {*} */ (session), /** @type {*} */ (FakeMetadata));
    keys.setInfo({name: 'Example Series', season: 1, episode: 1});
    await keys.setArtwork(/** @type {*} */ ({videoWidth: 640, videoHeight: 360}), async () => new Blob(['x']));
    keys.reset();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame');
    expect(session.metadata).toMatchObject({title: 'Example Series', artwork: []});
    expect(session.setPositionState).toHaveBeenLastCalledWith();
  });

  it('does nothing without a Media Session or MediaMetadata', async () => {
    const keys = new MediaKeys(/** @type {*} */ (playingClient()), null, null);
    expect(() => {
      keys.setInfo({name: 'x'});
      keys.offerSeeking();
      keys.updatePosition();
      keys.reset();
    }).not.toThrow();
    await keys.setArtwork(/** @type {*} */ ({videoWidth: 640, videoHeight: 360}), async () => new Blob(['x']));
  });
});
