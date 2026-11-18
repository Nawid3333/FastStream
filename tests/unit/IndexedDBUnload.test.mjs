import {afterEach, expect, it, vi} from 'vitest';

// When the player page goes, every open IndexedDBManager closes, and a temporary one deletes
// its database. A persistent manager (SecureMemory's) takes itself out of the list as it
// closes, at once, and the manager after it in the list was skipped: its temporary database
// stayed on disk.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('closes every manager when the page goes, a temporary one after a persistent one too', async () => {
  /** @type {Function[]} */
  const unloads = [];
  vi.stubGlobal('window', {addEventListener: (type, listener) => type === 'beforeunload' && unloads.push(listener)});
  const {IndexedDBManager} = await import('../../chrome/player/network/IndexedDBManager.mjs');
  const db = () => ({close: vi.fn()});
  vi.spyOn(IndexedDBManager, 'requestDB').mockImplementation(async () => db());
  vi.spyOn(IndexedDBManager, 'transact').mockResolvedValue(null);
  const deleted = vi.spyOn(IndexedDBManager, 'deleteDB').mockResolvedValue(undefined);
  vi.spyOn(IndexedDBManager.prototype, 'prune').mockResolvedValue(undefined);

  const persistent = new IndexedDBManager('secure-memory');
  const temporary = new IndexedDBManager();
  await persistent.setup();
  await temporary.setup();
  clearInterval(temporary.aliveInterval);

  expect(unloads).toHaveLength(1);
  await unloads[0]();
  expect(persistent.db).toBeNull();
  expect(temporary.db).toBeNull();
  expect(deleted).toHaveBeenCalledWith(temporary.dbName);
});
