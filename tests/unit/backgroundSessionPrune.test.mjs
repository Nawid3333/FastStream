import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// A Firefox closed with players open leaves their session directories in OPFS: the players never deleted them, and
// the background's timers went with it. A player's start pruned them, but only once a video opened again, so the
// disk held them until then.

/** @type {Awaited<ReturnType<typeof loadBackground>>} */
let bg;

afterEach(() => {
  bg?.unload();
  bg = undefined;
  vi.unstubAllGlobals();
});

/**
 * @param {string} text
 * @return {Object} A file of the stand-in OPFS.
 */
function file(text) {
  const handle = {kind: 'file', text, getFile: async () => ({text: async () => handle.text, size: handle.text.length})};
  return handle;
}

/**
 * @param {Object<string, Object>} [children]
 * @return {Object} A directory of the stand-in OPFS.
 */
function directory(children = {}) {
  const items = new Map(Object.entries(children));
  const notFound = (name) => new DOMException(name, 'NotFoundError');
  return {
    kind: 'directory',
    items,
    async getDirectoryHandle(name, {create = false} = {}) {
      if (!items.has(name) && create) items.set(name, directory());
      if (items.get(name)?.kind !== 'directory') throw notFound(name);
      return items.get(name);
    },
    async getFileHandle(name) {
      if (items.get(name)?.kind !== 'file') throw notFound(name);
      return items.get(name);
    },
    async removeEntry(name) {
      if (!items.delete(name)) throw notFound(name);
    },
    async* keys() {
      yield* [...items.keys()];
    },
    async* entries() {
      yield* [...items.entries()];
    },
  };
}

const heartbeat = (time) => file(JSON.stringify({updated_time: time}));

describe('the files players left on the disk as Firefox closed', () => {
  it('are deleted a minute after Firefox starts, with no video opened; a player of this run\'s stays', async () => {
    const fsblob = directory();
    vi.stubGlobal('navigator', {...globalThis.navigator, storage: {getDirectory: async () => directory({fsblob})}});
    bg = await loadBackground();
    const now = Date.now();
    const quitSeconds = (s) => now - s * 1000;
    // Open as Firefox closed 10 s ago: a restart that quick is younger than a player's prune lets go of.
    fsblob.items.set(`fsblob-${quitSeconds(600)}-1`, directory({'_meta.json': heartbeat(quitSeconds(10)), 'f0': file('video')}));
    // From the day before.
    fsblob.items.set(`fsblob-${quitSeconds(90000)}-2`, directory({'_meta.json': heartbeat(quitSeconds(86400)), 'f0': file('video')}));
    // A tab Firefox put back at its start plays, its heartbeat every 5 s.
    const live = `fsblob-${now + 2000}-3`;
    const beat = heartbeat(now + 2000);
    fsblob.items.set(live, directory({'_meta.json': beat}));
    const beating = setInterval(() => {
      beat.text = JSON.stringify({updated_time: Date.now()});
    }, 5000);
    // A buffer this run keeps for the next player of its video.
    const kept = `fsblob-${now + 3000}-kept1`;
    fsblob.items.set(kept, directory({'_kept.json': file(JSON.stringify({until: now + 30 * 60000}))}));

    await bg.startup();
    await bg.wait(30000);
    expect(fsblob.items.size).toBe(4);
    await bg.wait(40000);
    clearInterval(beating);
    expect([...fsblob.items.keys()].sort()).toEqual([kept, live].sort());
  });

  it('keep the event page up until they are deleted', async () => {
    const fsblob = directory();
    vi.stubGlobal('navigator', {...globalThis.navigator, storage: {getDirectory: async () => directory({fsblob})}});
    bg = await loadBackground();
    const now = Date.now();
    fsblob.items.set(`fsblob-${now - 600000}-1`, directory({'_meta.json': heartbeat(now - 300000)}));
    // A slow disk: the delete answers when the test says.
    let deleted;
    fsblob.removeEntry = (name) => new Promise((resolve) => {
      deleted = () => resolve(fsblob.items.delete(name));
    });
    let over = false;
    const work = bg.chrome.alarms.onAlarm.listeners.map((listener) => listener({name: 'fsblob-prune'}));
    Promise.all(work).then(() => {
      over = true;
    });
    await bg.wait();
    expect(deleted).toBeTypeOf('function');
    expect(over).toBe(false);
    deleted();
    await bg.wait();
    expect(over).toBe(true);
    expect(fsblob.items.size).toBe(0);
  });

  it('are looked for after an install or an update too', async () => {
    vi.stubGlobal('navigator', {...globalThis.navigator, storage: {getDirectory: async () => directory()}});
    bg = await loadBackground();
    expect(bg.alarms.has('fsblob-prune')).toBe(false);
    for (const listener of bg.chrome.runtime.onInstalled.listeners) listener({reason: 'install'});
    await bg.wait();
    expect(bg.alarms.get('fsblob-prune')?.when).toBe(Date.now() + 65000);
    // No player ever wrote to the disk: nothing to look through, and nothing goes wrong.
    const warn = vi.spyOn(console, 'warn');
    await bg.wait(65000);
    expect(warn).not.toHaveBeenCalled();
  });
});
