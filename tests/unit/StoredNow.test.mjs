import {afterEach, describe, expect, it, vi} from 'vitest';
import {PEER_TIMEOUT_MS, VERSION} from '../../chrome/player/network/PlayerPeers.mjs';
import {diskBytes, PlayersRam, StoredNow, StoredNowEveryMs} from '../../chrome/player/options/StoredNow.mjs';

/**
 * An OPFS directory: each entry a file size, a directory (an object), or 'gone' for a file deleted meanwhile.
 * @param {Object<string, *>} entries
 * @param {boolean} [vanished] - The directory itself deleted while it is read.
 * @return {*}
 */
function dir(entries, vanished = false) {
  return {
    kind: 'directory',
    async getDirectoryHandle(name) {
      const entry = entries[name];
      if (!entry || typeof entry !== 'object') throw new DOMException('not found', 'NotFoundError');
      return entry;
    },
    async* values() {
      if (vanished) throw new DOMException('gone', 'NotFoundError');
      for (const entry of Object.values(entries)) {
        if (entry && typeof entry === 'object') {
          yield entry;
        } else {
          yield {kind: 'file', getFile: async () => {
            if (entry === 'gone') throw new DOMException('gone', 'NotFoundError');
            return {size: entry};
          }};
        }
      }
    },
  };
}

const announce = (id, ramBytes, extra = {}) => ({v: VERSION, id, ramBytes, ...extra});

describe('the stored video on the disk', () => {
  it('adds up the files of every player directory, and nothing outside them', async () => {
    const root = dir({
      fsblob: dir({a: dir({one: 100, two: 50}), b: dir({three: 25}), stray: 7}),
      other: dir({big: 1e9}),
    });
    expect(await diskBytes(root)).toBe(175);
  });

  it('is 0 with no player directory', async () => {
    expect(await diskBytes(dir({}))).toBe(0);
  });

  it('counts the rest when a file or a directory is deleted while it is read', async () => {
    const root = dir({fsblob: dir({a: dir({one: 100, gone: 'gone', two: 50}), b: dir({x: 9}, true), c: dir({y: 1})})});
    expect(await diskBytes(root)).toBe(151);
  });
});

describe('the RAM the players announce', () => {
  /** @return {{ram: PlayersRam, send: (m: *) => void, clock: {now: number}}} */
  function players() {
    const clock = {now: 1000};
    /** @type {*} */
    const channel = {close: vi.fn()};
    const ram = new PlayersRam({channel: () => channel, now: () => clock.now});
    return {ram, send: (message) => channel.onmessage({data: message}), clock};
  }

  it('adds up the latest announcement of each player', () => {
    const {ram, send} = players();
    send(announce('a', 100));
    send(announce('b', 50));
    send(announce('a', 300));
    expect(ram.total()).toEqual({bytes: 350, players: 2});
  });

  it('forgets a player that said goodbye or went quiet, as PlayerPeers does', () => {
    const {ram, send, clock} = players();
    send(announce('a', 100));
    send(announce('b', 50));
    send(announce('a', 0, {bye: true}));
    expect(ram.total()).toEqual({bytes: 50, players: 1});
    clock.now += PEER_TIMEOUT_MS + 1;
    expect(ram.total()).toEqual({bytes: 0, players: 0});
  });

  it('ignores what is not an announcement of this version, and counts a bad amount as 0', () => {
    const {ram, send} = players();
    send(null);
    send({v: VERSION + 1, id: 'x', ramBytes: 5});
    send({v: VERSION, ramBytes: 5});
    send(announce('a', 'lots'));
    send(announce('b', -4));
    expect(ram.total()).toEqual({bytes: 0, players: 2});
  });
});

describe('the "Stored now" line', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const ramOf = (bytes, players) => /** @type {*} */ ({total: () => ({bytes, players})});

  it('shows the disk and the RAM, and is hidden until then', async () => {
    const box = {hidden: true};
    const show = vi.fn();
    const line = new StoredNow({box: /** @type {*} */ (box), show, root: async () => dir({fsblob: dir({a: dir({f: 40})})}),
      ram: ramOf(10, 1)});
    expect(box.hidden).toBe(true);
    await line.refresh();
    expect(show).toHaveBeenCalledWith(40, 10, 1);
    expect(box.hidden).toBe(false);
  });

  it('shows the RAM with 0 on the disk where OPFS is refused', async () => {
    const show = vi.fn();
    const line = new StoredNow({box: /** @type {*} */ ({hidden: true}), show,
      root: () => Promise.reject(new DOMException('no', 'SecurityError')), ram: ramOf(10, 1)});
    await line.refresh();
    expect(show).toHaveBeenCalledWith(0, 10, 1);
  });

  it('refreshes only while the page is seen', async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const line = new StoredNow({box: /** @type {*} */ ({hidden: true}), show, root: async () => dir({}), ram: ramOf(0, 0)});
    line.setSeen(true);
    await vi.advanceTimersByTimeAsync(StoredNowEveryMs * 2);
    expect(show).toHaveBeenCalledTimes(3);
    line.setSeen(false);
    await vi.advanceTimersByTimeAsync(StoredNowEveryMs * 3);
    expect(show).toHaveBeenCalledTimes(3);
  });
});
