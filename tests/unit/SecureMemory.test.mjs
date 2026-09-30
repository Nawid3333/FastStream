import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The encrypted store of remembered playback positions (FastStreamClient's progress).
// Three ways it lost or hung:
// - pruneOld, which the player's setup awaits before the player shows, rejected on a cursor
//   error and never settled on an aborted transaction: a blank player.
// - Two players starting together on a fresh profile each made a salt, the second
//   overwrote the first, and the first tab's saved positions could never be found again.
// - A read that failed was handled like a record that does not decrypt: the video started
//   at 0 and saved over the intact record a second later. getFile now marks the record
//   it could read but not decrypt, so the client can tell the two apart.

// The metadata store, shared by the tabs; addValue as IndexedDB's add() behaves: stored
// only when the key has no value, in one transaction.
const metadata = new Map();

vi.mock('../../chrome/player/network/IndexedDBManager.mjs', () => ({
  IndexedDBManager: class {
    static async getValue(db, store, key) {
      // What the read sees is fixed when it is asked, as in a transaction.
      const value = metadata.get(key);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return value;
    }
    static async setValue(db, store, key, value) {
      metadata.set(key, value);
    }
    static async addValue(db, store, key, value) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (metadata.has(key)) return false;
      metadata.set(key, value);
      return true;
    }
  },
}));

const {SecureMemory} = await import('../../chrome/player/modules/SecureMemory.mjs');

/**
 * A stand-in database with one record older than the cutoff, whose prune transaction
 * ends the way a test asks.
 * @param {'complete'|'abort'|'cursor error'|'throws'|'failed commit'} ending
 * @return {Object}
 */
function pruneDb(ending) {
  const deleted = [];
  return {
    deleted,
    transaction() {
      if (ending === 'throws') throw new Error('the database is closing');
      const transaction = {
        error: null,
        commit: () => queueMicrotask(() => ending === 'failed commit' ?
          transaction.onabort?.() : transaction.oncomplete?.()),
        abort: () => queueMicrotask(() => transaction.onabort?.()),
        objectStore: () => ({openCursor: () => request}),
      };
      let step = 0;
      const request = {error: null};
      queueMicrotask(function next() {
        if (ending === 'cursor error') {
          request.error = new Error('cursor failed');
          request.onerror?.();
          return;
        }
        if (step++ === 0) {
          request.onsuccess({target: {result: {
            value: {time: 1},
            delete: () => {
              deleted.push(1);
              if (ending === 'abort') {
                transaction.error = new Error('QuotaExceededError');
                queueMicrotask(() => transaction.onabort?.());
              }
            },
            continue: () => {
              if (ending !== 'abort') queueMicrotask(next);
            },
          }}});
        } else {
          request.onsuccess({target: {result: null}});
        }
      });
      return transaction;
    },
  };
}

describe('SecureMemory.pruneOld', () => {
  let warn;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const pruneWith = (db) => {
    const memory = new SecureMemory('test');
    memory.indexedDbManager = {getDatabase: () => db};
    return memory.pruneOld(100);
  };

  it('deletes old records and resolves when the transaction completes', async () => {
    const db = pruneDb('complete');
    await expect(pruneWith(db)).resolves.toBeUndefined();
    expect(db.deleted).toEqual([1]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['abort', 'cursor error', 'throws', 'failed commit'])('resolves, not hangs or throws, when the transaction ends with %s', async (ending) => {
    const outcome = await Promise.race([
      pruneWith(pruneDb(ending)).then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 500)),
    ]);
    expect(outcome).toBe('resolved');
    expect(warn).toHaveBeenCalled();
  });
});

describe('SecureMemory.getSalt', () => {
  beforeEach(() => {
    metadata.clear();
  });

  it('gives two players starting together on a fresh profile the same salt', async () => {
    const tabs = [new SecureMemory('test'), new SecureMemory('test')];
    for (const tab of tabs) tab.indexedDbManager = {getDatabase: () => ({})};
    const [a, b] = await Promise.all(tabs.map((tab) => tab.getSalt('identifier_salt')));
    expect(a).toBe(b);
    expect(metadata.get('identifier_salt')).toBe(a);
  });

  it('reads a salt that is already there', async () => {
    const salt = new Uint8Array([1, 2, 3]);
    metadata.set('key_salt', salt);
    const memory = new SecureMemory('test');
    memory.indexedDbManager = {getDatabase: () => ({})};
    expect(await memory.getSalt('key_salt')).toBe(salt);
  });
});

describe('SecureMemory.getFile', () => {
  const hashesFor = async (identifier) => ({
    identifierHash: 'id',
    keyHash: await crypto.subtle.exportKey('raw', await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt'])),
    identifier,
  });

  it('reads back what it saved', async () => {
    const stored = new Map();
    const memory = new SecureMemory('test');
    memory.indexedDbManager = {
      setFile: async (key, value) => stored.set(key, value),
      getFile: async (key) => stored.get(key),
    };
    const hashes = await hashesFor('video');
    await memory.setFile(hashes, {lastTime: 42});
    expect(await memory.getFile(hashes)).toEqual({lastTime: 42});
  });

  it('marks a record it read but cannot decrypt', async () => {
    const memory = new SecureMemory('test');
    memory.indexedDbManager = {getFile: async () => ({encryptedData: new Uint8Array(40)})};
    const error = await memory.getFile(await hashesFor('video')).catch((e) => e);
    expect(error.unusableRecord).toBe(true);
  });

  it('does not mark a read that failed', async () => {
    const memory = new SecureMemory('test');
    memory.indexedDbManager = {getFile: async () => {
      throw new Error('IndexedDB is having a moment');
    }};
    const error = await memory.getFile(await hashesFor('video')).catch((e) => e);
    expect(error.message).toBe('IndexedDB is having a moment');
    expect(error.unusableRecord).toBeUndefined();
  });

  it('gives null for no record', async () => {
    const memory = new SecureMemory('test');
    memory.indexedDbManager = {getFile: async () => undefined};
    expect(await memory.getFile(await hashesFor('video'))).toBeNull();
  });
});
