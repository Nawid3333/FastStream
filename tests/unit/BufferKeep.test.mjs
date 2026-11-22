import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {BufferStash} from '../../chrome/background/BufferStash.mjs';
import {BufferKeepChoices, bufferKeepLabel, bufferKeepMs, bufferKeepSeconds} from '../../chrome/player/options/BufferKeep.mjs';

// The owner (2026-11-22): a reload or a closed tab keeps the buffer for a time the user picks (fixed steps up to an
// hour), gone when Firefox closes. Past 20 s it lives on the disk: Firefox unloads the idle event page, and its RAM
// with it, about 30 s after its last event.

const KEY = '[0,"","https://site.test/watch/1","https://cdn.test/v/master.m3u8"]';
const HOUR = 3600 * 1000;

/**
 * The disk of kept buffers, in memory: session -> its files and its record.
 * @param {{limit?: number, browser?: string}} [setup]
 * @return {Object}
 */
function fakeDisk({limit = 1e12, browser = 'run-1'} = {}) {
  /** @type {Map<string, {files: Map<string, Blob>, record: *}>} */
  const dirs = new Map();
  let made = 0;
  const dir = (session) => {
    if (!dirs.has(session)) dirs.set(session, {files: new Map(), record: null});
    return dirs.get(session);
  };
  return {
    dirs,
    dir,
    browserId: vi.fn(async () => browser),
    newSession: vi.fn(async () => {
      const session = `fsblob-${Date.now()}-kept${made++}`;
      dir(session);
      return session;
    }),
    writeFile: vi.fn(async (session, name, blob) => {
      if (!dirs.has(session)) throw new Error('No such directory');
      dirs.get(session).files.set(name, blob);
    }),
    writeRecord: vi.fn(async (session, record) => {
      dir(session).record = structuredClone(record);
    }),
    listKept: vi.fn(async () => [...dirs].filter(([, d]) => d.record).map(([session, d]) => ({session, record: d.record}))),
    schedule: vi.fn(),
    limitBytes: vi.fn(async () => limit),
  };
}

/**
 * @param {?string} session
 * @return {Object} A hand-off: one part in RAM, one on the disk already (when it has a session).
 */
function handOff(session = 'fsblob-1-1') {
  const entries = [{url: 'https://cdn.test/v/seg-1.ts', responseType: 'arraybuffer', dataSize: 3, blob: new Blob(['one'])}];
  if (session) entries.push({url: 'https://cdn.test/v/seg-2.ts', responseType: 'arraybuffer', dataSize: 5, file: 'f0'});
  return {url: 'https://cdn.test/v/master.m3u8?t=A', session, entries};
}

/**
 * A stash on the disk, its deletions taken off the disk.
 * @param {Object} disk
 * @return {{stash: BufferStash, dropSession: Function}}
 */
function stashOn(disk) {
  const dropSession = vi.fn((session) => {
    disk.dirs.delete(session);
  });
  return {stash: new BufferStash({dropSession, disk}), dropSession};
}

/** Lets the stash's writes run. */
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the keep time a user picks', () => {
  it('is one of the settings\' steps, up to an hour; anything else is the default', () => {
    expect(BufferKeepChoices).toEqual([0, 20, 60, 300, 900, 1800, 3600]);
    for (const seconds of BufferKeepChoices) expect(bufferKeepSeconds(seconds)).toBe(seconds);
    for (const bad of [7200, 86400, -1, 30, '60', null, undefined, NaN, Infinity]) expect(bufferKeepSeconds(bad)).toBe(20);
  });

  it('is 20 s at most in a private window, whose buffer never reaches the disk', () => {
    expect(bufferKeepMs(3600, false)).toBe(HOUR);
    expect(bufferKeepMs(3600, true)).toBe(20000);
    expect(bufferKeepMs(0, true)).toBe(0);
    expect(bufferKeepMs(99999, false)).toBe(20000);
  });

  it('reads in the user\'s language', () => {
    expect(bufferKeepLabel(0, 'en')).toBe(null);
    expect(bufferKeepLabel(20, 'en')).toBe('20 seconds');
    expect(bufferKeepLabel(60, 'en')).toBe('1 minute');
    expect(bufferKeepLabel(1800, 'en')).toBe('30 minutes');
    expect(bufferKeepLabel(3600, 'de')).toBe('1 Stunde');
  });
});

describe('a buffer kept longer than the event page lives', () => {
  it('stays in RAM up to 20 s, as before: nothing is written', async () => {
    const disk = fakeDisk();
    const {stash} = stashOn(disk);
    const kept = handOff();
    stash.put(KEY, kept, 20000);
    await settle();
    expect(disk.writeFile).not.toHaveBeenCalled();
    expect(disk.writeRecord).not.toHaveBeenCalled();
    expect(await stash.take(KEY)).toBe(kept);
  });

  it('writes its RAM to its directory, and a record of it next to its files', async () => {
    const disk = fakeDisk();
    const {stash} = stashOn(disk);
    const kept = handOff();
    stash.put(KEY, kept, 5 * 60000);
    await settle();

    const dir = disk.dirs.get('fsblob-1-1');
    expect([...dir.files.keys()]).toEqual(['k0']);
    expect(await dir.files.get('k0').text()).toBe('one');
    expect(dir.record).toEqual({browser: 'run-1', key: KEY, until: 1_000_000 + 5 * 60000, url: kept.url, entries: [
      {url: 'https://cdn.test/v/seg-1.ts', responseType: 'arraybuffer', dataSize: 3, file: 'k0'},
      {url: 'https://cdn.test/v/seg-2.ts', responseType: 'arraybuffer', dataSize: 5, file: 'f0'},
    ]});
    // Its RAM is let go of: the file is it now.
    expect(kept.entries[0].blob).toBeUndefined();
    expect(disk.schedule).toHaveBeenLastCalledWith(1_000_000 + 5 * 60000);
  });

  it('gets a directory of its own when it had all in RAM', async () => {
    const disk = fakeDisk();
    const {stash} = stashOn(disk);
    stash.put(KEY, handOff(null), 60000);
    await settle();
    const taken = await stash.take(KEY);
    expect(taken.session).toMatch(/^fsblob-\d+-kept/);
    expect(disk.dirs.get(taken.session).files.has('k0')).toBe(true);
    expect(taken.entries).toEqual([expect.objectContaining({file: 'k0'})]);
  });

  it('is taken back from the disk once Firefox unloaded the event page, and loaded it again', async () => {
    const disk = fakeDisk();
    stashOn(disk).stash.put(KEY, handOff(), 15 * 60000);
    await settle();

    vi.setSystemTime(1_000_000 + 10 * 60000);
    const {stash: again} = stashOn(disk);
    const taken = await again.take(KEY);
    expect(taken).toEqual({url: 'https://cdn.test/v/master.m3u8?t=A', session: 'fsblob-1-1', entries: [
      expect.objectContaining({url: 'https://cdn.test/v/seg-1.ts', file: 'k0'}),
      expect.objectContaining({url: 'https://cdn.test/v/seg-2.ts', file: 'f0'}),
    ]});
    expect(await again.take(KEY)).toBe(null);
  });

  it('goes at its time: by its timer, or by the alarm of an event page loaded again', async () => {
    const disk = fakeDisk();
    const {stash, dropSession} = stashOn(disk);
    stash.put(KEY, handOff(), 60000);
    await settle();
    await vi.advanceTimersByTimeAsync(60000);
    expect(dropSession).toHaveBeenCalledWith('fsblob-1-1');
    expect(disk.schedule).toHaveBeenLastCalledWith(null);

    const disk2 = fakeDisk();
    const putAt = Date.now();
    stashOn(disk2).stash.put(KEY, handOff('fsblob-2-2'), 60000);
    await settle();
    // Unloaded: its timers are gone. Loaded again by a player 30 s later, and unloaded again.
    vi.clearAllTimers();
    vi.setSystemTime(putAt + 30000);
    const {stash: woken, dropSession: drop2} = stashOn(disk2);
    await woken.ready;
    vi.clearAllTimers();
    expect(drop2).not.toHaveBeenCalled();
    // The alarm, after its time.
    vi.setSystemTime(putAt + 61000);
    woken.expire();
    await settle();
    expect(drop2).toHaveBeenCalledWith('fsblob-2-2');
    expect(disk2.dirs.size).toBe(0);
  });

  it('deletes what an earlier Firefox run kept, and records it cannot trust', async () => {
    const disk = fakeDisk({browser: 'run-2'});
    const record = {browser: 'run-2', key: KEY, until: 1_000_000 + 60000, url: 'https://cdn.test/v/m.m3u8', entries: []};
    disk.dir('fsblob-1-old').record = {...record, browser: 'run-1'};
    disk.dir('fsblob-2-late').record = {...record, key: 'b', until: 1_000_000 + 2 * HOUR};
    disk.dir('fsblob-3-past').record = {...record, key: 'c', until: 1_000_000 - 1};
    disk.dir('fsblob-4-broken').record = 'not a record';
    disk.dir('fsblob-5-good').record = {...record, key: 'e'};
    const {stash, dropSession} = stashOn(disk);
    await stash.ready;
    await settle();
    expect(dropSession.mock.calls.map(([session]) => session).sort())
        .toEqual(['fsblob-1-old', 'fsblob-2-late', 'fsblob-3-past', 'fsblob-4-broken']);
    expect((await stash.take('e')).session).toBe('fsblob-5-good');
  });

  it('stops writing once taken, and the taker gets each part from RAM or the disk', async () => {
    const disk = fakeDisk();
    let release;
    disk.writeFile.mockImplementationOnce(async (session, name, blob) => {
      await new Promise((resolve) => (release = resolve));
      disk.dirs.get(session).files.set(name, blob);
    });
    const {stash} = stashOn(disk);
    const kept = handOff();
    kept.entries.push({url: 'https://cdn.test/v/seg-3.ts', responseType: 'arraybuffer', dataSize: 5, blob: new Blob(['three'])});
    stash.put(KEY, kept, HOUR);
    await settle();
    // The first part is being written.
    const taken = await stash.take(KEY);
    release();
    await settle();
    expect(taken.entries[0].blob).toBeInstanceOf(Blob);
    expect(taken.entries[2].blob).toBeInstanceOf(Blob);
    expect(disk.writeFile).toHaveBeenCalledTimes(1);
  });

  it('deletes the files at once when the user keeps nothing ("Off")', async () => {
    const disk = fakeDisk();
    const {stash, dropSession} = stashOn(disk);
    stash.put(KEY, handOff(), 0);
    await settle();
    expect(dropSession).toHaveBeenCalledWith('fsblob-1-1');
    expect(await stash.take(KEY)).toBe(null);
  });

  it('keeps a private window\'s in RAM, 20 s at most', async () => {
    const disk = fakeDisk();
    const {stash} = stashOn(disk);
    stash.put(KEY, handOff(null), HOUR, {ramOnly: true});
    await settle();
    expect(disk.newSession).not.toHaveBeenCalled();
    expect(disk.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20000);
    expect(await stash.take(KEY)).toBe(null);
  });

  it('makes room: the oldest goes first, and one larger than all the room stays 20 s in RAM', async () => {
    const disk = fakeDisk({limit: 10});
    const {stash, dropSession} = stashOn(disk);
    stash.put('a', handOff('fsblob-1-a'), HOUR);
    await settle();
    vi.advanceTimersByTime(1000);
    stash.put('b', handOff('fsblob-2-b'), HOUR);
    await settle();
    expect(dropSession).toHaveBeenCalledWith('fsblob-1-a');
    expect(disk.dirs.get('fsblob-2-b').record).not.toBe(null);

    const big = handOff('fsblob-3-big');
    big.entries[1].dataSize = 50;
    stash.put('c', big, HOUR);
    await settle();
    expect(disk.dirs.get('fsblob-3-big')?.record ?? null).toBe(null);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await stash.take('c')).toBe(null);
    expect(await stash.take('b')).not.toBe(null);
  });

  it('leaves alone what a hand-off writes while the event page reads back what it kept', async () => {
    const disk = fakeDisk();
    let list;
    disk.listKept.mockImplementationOnce(() => new Promise((resolve) => (list = resolve)));
    const {stash, dropSession} = stashOn(disk);
    stash.put(KEY, handOff(), HOUR);
    await settle();
    list([{session: 'fsblob-1-1', record: disk.dirs.get('fsblob-1-1').record}]);
    await stash.ready;
    await settle();
    expect(dropSession).not.toHaveBeenCalled();
    expect((await stash.take(KEY)).session).toBe('fsblob-1-1');
  });
});
