import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

// FSBlob's last storage backend (after OPFS and the Cache API): a temporary IndexedDB
// database per player, which the other players' prune() deletes once its heartbeat stops.
// - prune() kept the connection to a live player's database open, and that player's own
//   deleteDatabase on closing was blocked until the pruning tab closed too (#137).
// - transact() never answered for a commit that failed (an abort with no error event), and
//   answered null, as if it had worked, when the callback could not make its request (#149).

let IndexedDBManager;

beforeAll(async () => {
  // The module listens for the page closing.
  vi.stubGlobal('window', {addEventListener: () => {}});
  ({IndexedDBManager} = await import('../../chrome/player/network/IndexedDBManager.mjs'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A stand-in database whose transactions behave as IndexedDB's: one with no request left
 * commits by itself once the task is over, and one whose commit fails aborts without an
 * error event.
 * @param {{commitFails?: boolean, put?: Function}} [options]
 * @return {Object}
 */
function fakeDb({commitFails = false, put = () => ({})} = {}) {
  return {
    transaction() {
      const transaction = {
        error: null,
        finished: false,
        objectStore: () => ({put}),
        commit() {
          transaction.finished = true;
          if (commitFails) {
            transaction.error = new DOMException('The quota is exceeded', 'QuotaExceededError');
            setTimeout(() => transaction.onabort?.());
          } else {
            setTimeout(() => transaction.oncomplete?.());
          }
        },
        abort() {
          if (transaction.finished) throw new DOMException('Finished', 'InvalidStateError');
          transaction.finished = true;
          setTimeout(() => transaction.onabort?.());
        },
      };
      setTimeout(() => {
        if (!transaction.finished) {
          transaction.finished = true;
          transaction.oncomplete?.();
        }
      });
      return transaction;
    },
  };
}

/** How a promise ends within a short while: 'resolved: x', 'rejected: name', or 'pending'. */
function outcome(promise) {
  return Promise.race([
    promise.then((value) => 'resolved: ' + value, (e) => 'rejected: ' + (e?.name || e)),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
  ]);
}

describe('IndexedDBManager.transact', () => {
  it('fails when the callback cannot make its request, rather than answering null', async () => {
    const db = fakeDb({put: () => {
      throw new DOMException('The object could not be cloned', 'DataCloneError');
    }});
    const done = IndexedDBManager.transact(db, 'files', 'readwrite', (transaction) => transaction.objectStore('files').put({}, 'key'));
    expect(await outcome(done)).toBe('rejected: DataCloneError');
  });

  it('fails when the commit fails, rather than never answering', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const done = IndexedDBManager.transact(fakeDb({commitFails: true}), 'files', 'readwrite', () => Promise.resolve('stored'));
    expect(await outcome(done)).toBe('rejected: QuotaExceededError');
  });

  it('answers with what the callback gave once the transaction is complete', async () => {
    const done = IndexedDBManager.transact(fakeDb(), 'files', 'readwrite', () => Promise.resolve('stored'));
    expect(await outcome(done)).toBe('resolved: stored');
  });
});

describe('IndexedDBManager.prune', () => {
  it('closes its connection to a live database as well as to a stale one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    window.indexedDB = {databases: async () => [{name: 'faststream-temp-live'}, {name: 'faststream-temp-stale'}, {name: 'other'}]};
    const connections = new Map();
    vi.spyOn(IndexedDBManager, 'requestDB').mockImplementation(async (name) => {
      const db = {name, close: vi.fn()};
      connections.set(name, db);
      return db;
    });
    vi.spyOn(IndexedDBManager, 'getValue').mockImplementation(async (db) =>
      db.name === 'faststream-temp-live' ? Date.now() - 1000 : Date.now() - 120000);
    const deleteDB = vi.spyOn(IndexedDBManager, 'deleteDB').mockResolvedValue();

    await new IndexedDBManager().prune();

    expect([...connections.keys()].sort()).toEqual(['faststream-temp-live', 'faststream-temp-stale']);
    expect(connections.get('faststream-temp-live').close).toHaveBeenCalledTimes(1);
    expect(connections.get('faststream-temp-stale').close).toHaveBeenCalledTimes(1);
    expect(deleteDB.mock.calls).toEqual([['faststream-temp-stale']]);
  });

  // A live tab writes its time each second, but Firefox runs a hidden tab's timers up to 15 s
  // late: one 10 s behind was taken for a dead one, and its videos were deleted under it.
  it('keeps the database of a hidden tab whose timers run late', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    window.indexedDB = {databases: async () => [{name: 'faststream-temp-hidden'}]};
    vi.spyOn(IndexedDBManager, 'requestDB').mockImplementation(async (name) => ({name, close: vi.fn()}));
    vi.spyOn(IndexedDBManager, 'getValue').mockImplementation(async () => Date.now() - 20000);
    const deleteDB = vi.spyOn(IndexedDBManager, 'deleteDB').mockResolvedValue();

    await new IndexedDBManager().prune();

    expect(deleteDB).not.toHaveBeenCalled();
  });
});
