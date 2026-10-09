import {OpQueue} from './OpQueue.mjs';

// Owns one OPFS subdirectory (chrome/player/network/OPFSManager.mjs's
// counterpart on the main thread never touches the filesystem directly -
// FileSystemSyncAccessHandle only exists inside a dedicated worker). Every
// filesystem operation, including the heartbeat write, goes through a single
// OpQueue: opening two FileSystemSyncAccessHandles on the same file throws,
// and every identifier here is always a one-shot whole-blob get/set, so
// serializing is simpler and cheaper than per-identifier locking. The
// identifiers it gets are file names OPFSManager.fileName() chose.

const STALE_MS = 10000; // matches IndexedDBManager's own staleness window
const HEARTBEAT_MS = 1000;
const META_FILE = '_meta.json';

const queue = new OpQueue();
let fsBlobRoot = null;
let sessionDir = null;
let sessionName = null;
let heartbeatInterval = null;
let heartbeatInFlight = false;
// Lets go of this session's lock (acquireSessionLock).
let releaseSessionLock = null;

// Open save-streams: identifier -> {handle, offset}. A save writes one
// whole output file progressively (see StreamSaver.mjs / mp4merger.mjs);
// keeping the FileSystemSyncAccessHandle open across messages avoids
// open/close churn per chunk. All ops still go through the shared OpQueue,
// so an open save handle can never collide with a heartbeat write.
const saveStreams = new Map();

/** Gets (creating if needed) the shared parent directory every session's subdirectory lives under. */
async function getFsBlobRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('fsblob', {create: true});
}

/**
 * Reads another session's heartbeat.
 * @return {Promise<{time: ?number, unreadable?: boolean}>} time: the last beat, or null
 *     when the session has no heartbeat (or is no directory); unreadable: it has one that
 *     could not be read, e.g. while its owner is writing it (a sync access handle locks
 *     the file) - a live session.
 */
async function readHeartbeat(name) {
  let fileHandle;
  try {
    const dir = await fsBlobRoot.getDirectoryHandle(name);
    fileHandle = await dir.getFileHandle(META_FILE);
  } catch (e) {
    return {time: null};
  }
  try {
    const file = await fileHandle.getFile();
    const meta = JSON.parse(await file.text());
    return {time: meta.updated_time ?? null};
  } catch (e) {
    return {time: null, unreadable: true};
  }
}

/**
 * When a session directory was made, from its name (see init), or null for another name.
 * @param {string} name
 * @return {?number}
 */
function sessionCreatedTime(name) {
  const match = /^fsblob-(\d+)-/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * The Web Lock a session holds for as long as its worker lives.
 * @param {string} name - The session's directory.
 * @return {string}
 */
function sessionLockName(name) {
  return 'faststream-fsblob:' + name;
}

/**
 * Takes this session's lock and holds it until destroy() or the worker ends: Firefox lets
 * go of a worker's locks when it ends, crashed or closed. Taken before the session's
 * directory exists, so a sibling's prune never finds that directory without its lock.
 * @param {string} name
 * @return {Promise<void>}
 */
async function acquireSessionLock(name) {
  if (!navigator.locks?.request) return;
  await new Promise((resolve) => {
    navigator.locks.request(sessionLockName(name), () => {
      resolve();
      return new Promise((release) => {
        releaseSessionLock = release;
      });
    }).catch(() => resolve());
  });
}

/**
 * Whether a sibling session's worker still lives: it holds its lock.
 * @param {string} name
 * @return {Promise<boolean>}
 */
async function sessionIsLocked(name) {
  if (!navigator.locks?.request) return false;
  let held = false;
  try {
    await navigator.locks.request(sessionLockName(name), {ifAvailable: true}, (lock) => {
      held = lock === null;
    });
  } catch (e) {
    return false;
  }
  return held;
}

/**
 * Deletes sibling session directories left by a crashed or closed tab: a heartbeat
 * older than STALE_MS, or none at all. Judged off the heartbeat, not the directory's age,
 * so a long-running session isn't mistaken for stale. But a directory younger than
 * STALE_MS is never judged: it is made before its first heartbeat is written, and two
 * players starting together deleted each other's brand-new session that way (its blobs
 * then stayed in RAM, and its saves failed). And a heartbeat that is there but cannot be
 * read is its owner writing it.
 *
 * A session whose worker holds its Web Lock lives, whatever its heartbeat says: a heartbeat
 * is only as punctual as a timer, and one that ran late (a busy worker, the computer
 * waking from sleep, the clock set forward) had a live player's whole stored video
 * deleted, and seeking back in it failed for good. Without the lock (a worker gone, or a
 * build from before the locks) the heartbeat decides, as before; that also leaves a closed
 * session's finished save its STALE_MS to be read.
 */
async function prune(ownName) {
  const stale = [];
  for await (const name of fsBlobRoot.keys()) {
    if (name === ownName) continue;
    const created = sessionCreatedTime(name);
    if (created !== null && Date.now() - created <= STALE_MS) continue;
    if (await sessionIsLocked(name)) continue;
    const heartbeat = await readHeartbeat(name);
    if (heartbeat.unreadable) continue;
    if (!heartbeat.time || Date.now() - heartbeat.time > STALE_MS) {
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

/**
 * Writes all of `data` at `at`. A sync access handle's write() answers with the bytes it
 * wrote, and Firefox reports a write that failed part-way (the disk or the quota full) only
 * through that count, never with an error: a fragment was stored cut short, or a save went
 * on with a hole in it, and nothing said so.
 * @param {FileSystemSyncAccessHandle} accessHandle
 * @param {ArrayBuffer|ArrayBufferView} data
 * @param {number} at
 */
function writeAll(accessHandle, data, at) {
  const written = accessHandle.write(data, {at});
  if (written !== data.byteLength) {
    throw new Error(`OPFS wrote ${written} of ${data.byteLength} bytes`);
  }
}

/** Overwrites this session's heartbeat marker with the current time. */
async function writeHeartbeat() {
  const handle = await sessionDir.getFileHandle(META_FILE, {create: true});
  const accessHandle = await handle.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({updated_time: Date.now()}));
    writeAll(accessHandle, bytes, 0);
    accessHandle.truncate(bytes.byteLength);
    accessHandle.flush();
  } finally {
    accessHandle.close();
  }
}

async function init() {
  fsBlobRoot = await getFsBlobRoot();
  sessionName = 'fsblob-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);

  await acquireSessionLock(sessionName);
  // Prune before this session's own directory exists, so it can never be
  // mistaken for one of the (stale) siblings being cleaned up.
  await prune(sessionName);

  sessionDir = await fsBlobRoot.getDirectoryHandle(sessionName, {create: true});
  await writeHeartbeat();
  heartbeatInterval = setInterval(() => {
    // Deliberately NOT queue.push()'d: the heartbeat only ever touches
    // META_FILE, a different path from every other op here, so it can't
    // collide with an in-progress sync access handle the way two ops on the
    // same identifier would. Going through the shared queue let one big
    // get/set or a long saveAppend burst starve the heartbeat past
    // STALE_MS and get this session's directory deleted by a sibling tab's
    // prune() while it was still alive, just busy. heartbeatInFlight only
    // guards against a heartbeat write itself running long enough to
    // overlap the next tick.
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    writeHeartbeat().catch(() => {}).finally(() => {
      heartbeatInFlight = false;
    });
  }, HEARTBEAT_MS);
}

async function setFile(identifier, data) {
  const fileHandle = await sessionDir.getFileHandle(identifier, {create: true});
  const accessHandle = await fileHandle.createSyncAccessHandle();
  try {
    writeAll(accessHandle, data, 0);
    accessHandle.truncate(data.byteLength);
    accessHandle.flush();
  } catch (e) {
    accessHandle.close();
    // What was written of it only takes up the space that ran out.
    await sessionDir.removeEntry(identifier).catch(() => {});
    throw e;
  }
  accessHandle.close();
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
  // From here the heartbeat decides, and gives a finished save its time (prune).
  releaseSessionLock?.();
  releaseSessionLock = null;
  for (const stream of saveStreams.values()) {
    try {
      stream.handle.close();
    } catch (e) {
      // Best-effort - the worker is going away anyway.
    }
  }
  saveStreams.clear();
  // Deliberately NOT removing the session directory here: a finished save
  // file may still be mid-download from the main thread (the File was handed
  // to chrome.downloads). Once the heartbeat stops, prune() reaps this
  // directory on the next FSBlob init - same staleness semantics as before,
  // just deferred so in-flight downloads can finish.
}

/**
 * Progressive whole-file saves. 'saveBegin' creates/truncates the output
 * file and keeps an open sync access handle for it; 'saveAppend' writes
 * chunks in order (FIFO through the OpQueue preserves stream order);
 * 'saveEnd' flushes and closes, leaving the file readable from the main
 * thread via getFile. 'saveAbort' discards everything.
 */
async function saveBegin(identifier) {
  const fileHandle = await sessionDir.getFileHandle(identifier, {create: true});
  const accessHandle = await fileHandle.createSyncAccessHandle();
  saveStreams.set(identifier, {handle: accessHandle, offset: 0});
}

async function saveAppend(identifier, data) {
  const stream = saveStreams.get(identifier);
  if (!stream) {
    throw new Error('No open save stream: ' + identifier);
  }
  writeAll(stream.handle, data, stream.offset);
  stream.offset += data.byteLength;
}

async function saveEnd(identifier) {
  const stream = saveStreams.get(identifier);
  if (!stream) {
    throw new Error('No open save stream: ' + identifier);
  }
  try {
    stream.handle.truncate(stream.offset);
    stream.handle.flush();
  } finally {
    stream.handle.close();
    saveStreams.delete(identifier);
  }
}

async function saveAbort(identifier) {
  const stream = saveStreams.get(identifier);
  if (stream) {
    try {
      stream.handle.close();
    } catch (e) {
      // Already closed - fine.
    }
    saveStreams.delete(identifier);
  }
  try {
    await sessionDir.removeEntry(identifier);
  } catch (e) {
    // Never created / already gone - fine, abort is idempotent.
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
        // The main thread needs the session name to open finished save
        // files itself (FileSystemSyncAccessHandle is worker-only, but
        // plain getFile() is not).
        result = {sessionName};
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
      case 'saveBegin':
        await queue.push(() => saveBegin(identifier));
        break;
      case 'saveAppend':
        await queue.push(() => saveAppend(identifier, data));
        break;
      case 'saveEnd':
        await queue.push(() => saveEnd(identifier));
        break;
      case 'saveAbort':
        await queue.push(() => saveAbort(identifier));
        break;
      default:
        throw new Error('Unknown OPFS op: ' + op);
    }
    self.postMessage({id, ok: true, result}, transfer || []);
  } catch (e) {
    self.postMessage({id, ok: false, error: e?.message || String(e)});
  }
});
