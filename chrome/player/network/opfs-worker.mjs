import {OpQueue} from './OpQueue.mjs';

// Owns one OPFS subdirectory (chrome/player/network/OPFSManager.mjs's
// counterpart on the main thread never touches the filesystem directly -
// FileSystemSyncAccessHandle only exists inside a dedicated worker). Every
// filesystem operation, including the heartbeat write, goes through a single
// OpQueue: opening two FileSystemSyncAccessHandles on the same file throws,
// and every identifier here is always a one-shot whole-blob get/set, so
// serializing is simpler and cheaper than per-identifier locking.

const STALE_MS = 10000; // matches IndexedDBManager's own staleness window
const HEARTBEAT_MS = 1000;
const META_FILE = '_meta.json';

const queue = new OpQueue();
let fsBlobRoot = null;
let sessionDir = null;
let sessionName = null;
let heartbeatInterval = null;

/** Gets (creating if needed) the shared parent directory every session's subdirectory lives under. */
async function getFsBlobRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('fsblob', {create: true});
}

/** Reads another session's heartbeat timestamp, or null if it has none / is unreadable. */
async function readHeartbeat(name) {
  try {
    const dir = await fsBlobRoot.getDirectoryHandle(name);
    const fileHandle = await dir.getFileHandle(META_FILE);
    const file = await fileHandle.getFile();
    const meta = JSON.parse(await file.text());
    return meta.updated_time ?? null;
  } catch (e) {
    return null;
  }
}

/**
 * Deletes sibling session directories whose heartbeat is missing or older
 * than STALE_MS - orphans from a crashed/closed tab. Judged off the
 * heartbeat, not directory creation time, so a long-running session isn't
 * mistaken for stale by a prune pass that starts while it's still active.
 */
async function prune(ownName) {
  const stale = [];
  for await (const name of fsBlobRoot.keys()) {
    if (name === ownName) continue;
    const updatedTime = await readHeartbeat(name);
    if (!updatedTime || Date.now() - updatedTime > STALE_MS) {
      stale.push(name);
    }
  }
  await Promise.all(stale.map(async (name) => {
    try {
      await fsBlobRoot.removeEntry(name, {recursive: true});
    } catch (e) {
      // Another tab may be pruning or still finishing its own close() at
      // the same time - not fatal, just leave it for the next prune pass.
    }
  }));
}

/** Overwrites this session's heartbeat marker with the current time. */
async function writeHeartbeat() {
  const handle = await sessionDir.getFileHandle(META_FILE, {create: true});
  const accessHandle = await handle.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({updated_time: Date.now()}));
    accessHandle.write(bytes, {at: 0});
    accessHandle.truncate(bytes.byteLength);
    accessHandle.flush();
  } finally {
    accessHandle.close();
  }
}

async function init() {
  fsBlobRoot = await getFsBlobRoot();
  sessionName = 'fsblob-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);

  // Prune before this session's own directory exists, so it can never be
  // mistaken for one of the (stale) siblings being cleaned up.
  await prune(sessionName);

  sessionDir = await fsBlobRoot.getDirectoryHandle(sessionName, {create: true});
  await writeHeartbeat();
  heartbeatInterval = setInterval(() => {
    queue.push(() => writeHeartbeat()).catch(() => {});
  }, HEARTBEAT_MS);
}

async function setFile(identifier, data) {
  const fileHandle = await sessionDir.getFileHandle(identifier, {create: true});
  const accessHandle = await fileHandle.createSyncAccessHandle();
  try {
    accessHandle.write(data, {at: 0});
    accessHandle.truncate(data.byteLength);
    accessHandle.flush();
  } finally {
    accessHandle.close();
  }
}

async function getFile(identifier) {
  const fileHandle = await sessionDir.getFileHandle(identifier);
  const accessHandle = await fileHandle.createSyncAccessHandle();
  try {
    const size = accessHandle.getSize();
    const buffer = new ArrayBuffer(size);
    accessHandle.read(buffer, {at: 0});
    return buffer;
  } finally {
    accessHandle.close();
  }
}

async function deleteFile(identifier) {
  try {
    await sessionDir.removeEntry(identifier);
  } catch (e) {
    // Already gone - fine, deleteFile is idempotent everywhere else in
    // this codebase's storage backends too.
  }
}

async function clearStorage() {
  const names = [];
  for await (const name of sessionDir.keys()) {
    if (name !== META_FILE) names.push(name);
  }
  await Promise.all(names.map((name) => sessionDir.removeEntry(name).catch(() => {})));
}

async function destroy() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
  if (sessionDir && fsBlobRoot && sessionName) {
    await fsBlobRoot.removeEntry(sessionName, {recursive: true}).catch(() => {});
  }
}

self.addEventListener('message', async (event) => {
  const {id, op, identifier, data} = event.data;
  try {
    let result;
    let transfer;
    switch (op) {
      case 'init':
        await queue.push(() => init());
        break;
      case 'set':
        await queue.push(() => setFile(identifier, data));
        break;
      case 'get':
        result = await queue.push(() => getFile(identifier));
        transfer = [result];
        break;
      case 'delete':
        await queue.push(() => deleteFile(identifier));
        break;
      case 'clear':
        await queue.push(() => clearStorage());
        break;
      case 'destroy':
        await queue.push(() => destroy());
        break;
      default:
        throw new Error('Unknown OPFS op: ' + op);
    }
    self.postMessage({id, ok: true, result}, transfer || []);
  } catch (e) {
    self.postMessage({id, ok: false, error: e?.message || String(e)});
  }
});
