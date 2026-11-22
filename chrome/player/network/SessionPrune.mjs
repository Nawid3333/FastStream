// @ts-check
import {BufferKeepMaxMs, KeptRecordFile} from '../options/BufferKeep.mjs';

// The players' session directories under OPFS `fsblob`: each player writes a heartbeat into its own, and one whose
// heartbeat stopped is a player gone without deleting its files (a crash, a Firefox closed with it open).

// A page in the back-forward cache, or a computer asleep, writes no heartbeat for a while.
export const STALE_MS = 60000;
export const META_FILE = '_meta.json';

/**
 * @param {FileSystemDirectoryHandle} root - `fsblob`.
 * @param {string} name
 * @return {Promise<{time: ?number, unreadable?: boolean}>} Null: none or a broken one (dead). Unreadable: its owner writes it (alive).
 */
async function readHeartbeat(root, name) {
  let fileHandle;
  try {
    const dir = await root.getDirectoryHandle(name);
    fileHandle = await dir.getFileHandle(META_FILE);
  } catch (e) {
    return {time: null};
  }
  let text;
  try {
    text = await (await fileHandle.getFile()).text();
  } catch (e) {
    return {time: null, unreadable: true};
  }
  try {
    return {time: JSON.parse(text).updated_time ?? null};
  } catch (e) {
    // Its owner never leaves it half written (it holds the lock while writing): a crash did.
    return {time: null};
  }
}

/**
 * @param {string} name
 * @return {?number}
 */
function sessionCreatedTime(name) {
  const match = /^fsblob-(\d+)-/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Until when the background keeps a gone player's session for the next player of its video (BufferStash); 0 for
 * none, a broken record, or a time past BufferKeepMaxMs from now.
 * @param {FileSystemDirectoryHandle} root - `fsblob`.
 * @param {string} name
 * @return {Promise<number>}
 */
async function keptUntil(root, name) {
  try {
    const dir = await root.getDirectoryHandle(name);
    const until = JSON.parse(await (await (await dir.getFileHandle(KeptRecordFile)).getFile()).text())?.until;
    return Number.isFinite(until) && until <= Date.now() + BufferKeepMaxMs ? until : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Deletes sessions whose heartbeat is stale or missing; one younger than STALE_MS has none yet, and one the
 * background keeps stays until its time is up.
 * @param {FileSystemDirectoryHandle} root - `fsblob`.
 * @param {?string} [ownName] - The caller's own session.
 * @return {Promise<void>}
 */
export async function pruneSessions(root, ownName = null) {
  const stale = [];
  for await (const name of root.keys()) {
    if (name === ownName) continue;
    const created = sessionCreatedTime(name);
    if (created !== null && Date.now() - created <= STALE_MS) continue;
    const heartbeat = await readHeartbeat(root, name);
    if (heartbeat.unreadable) continue;
    if ((!heartbeat.time || Date.now() - heartbeat.time > STALE_MS) && await keptUntil(root, name) <= Date.now()) {
      stale.push(name);
    }
  }
  await Promise.all(stale.map(async (name) => {
    try {
      await root.removeEntry(name, {recursive: true});
    } catch (e) {
      // Another tab may be pruning or closing it: the next prune takes it.
    }
  }));
}
