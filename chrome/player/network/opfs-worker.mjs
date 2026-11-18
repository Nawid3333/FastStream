// @ts-check
import {OpQueue} from './OpQueue.mjs';

// Owns one OPFS session directory. One OpQueue runs its file operations: two sync access handles on one file throw.

// A page in the back-forward cache, or a computer asleep, writes no heartbeat for a while.
const STALE_MS = 60000;
// A hidden tab's timers run up to 15 s late: a beat is at most about 20 s old.
const HEARTBEAT_MS = 5000;
const META_FILE = '_meta.json';

const queue = new OpQueue();
/** @type {FileSystemDirectoryHandle|null} */
let fsBlobRoot = null;
/** @type {FileSystemDirectoryHandle|null} */
let sessionDir = null;
/** @type {string|null} */
let sessionName = null;
/** @type {ReturnType<typeof setInterval>|null} */
let heartbeatInterval = null;
let heartbeatInFlight = false;

// identifier -> {handle, offset}: a save keeps its sync access handle open across messages.
const saveStreams = new Map();

async function getFsBlobRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('fsblob', {create: true});
}

/**
 * @return {Promise<{time: ?number, unreadable?: boolean}>} Null: none or a broken one (dead). Unreadable: its owner writes it (alive).
 * @param {string} name
 */
async function readHeartbeat(name) {
  let fileHandle;
  try {
    const dir = await /** @type {FileSystemDirectoryHandle} */ (fsBlobRoot).getDirectoryHandle(name);
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
 * Deletes sessions whose heartbeat is stale or missing; one younger than STALE_MS has none yet.
 * @param {string} ownName
 */
async function prune(ownName) {
  const stale = [];
  for await (const name of /** @type {FileSystemDirectoryHandle} */ (fsBlobRoot).keys()) {
    if (name === ownName) continue;
    const created = sessionCreatedTime(name);
    if (created !== null && Date.now() - created <= STALE_MS) continue;
    const heartbeat = await readHeartbeat(name);
    if (heartbeat.unreadable) continue;
    if (!heartbeat.time || Date.now() - heartbeat.time > STALE_MS) {
      stale.push(name);
    }
  }
  await Promise.all(stale.map(async (name) => {
    try {
      await /** @type {FileSystemDirectoryHandle} */ (fsBlobRoot).removeEntry(name, {recursive: true});
    } catch (e) {
      // Another tab may be pruning or closing it: the next prune takes it.
    }
  }));
}

/**
 * Firefox reports a write that fails part-way (disk or quota full) only in write()'s count, never as an error.
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

// No flush(): files are read back only in this browser session, and a crashed session is pruned.

/**
 * The session's directory is made again when another player's prune took it.
 * @param {string} name
 * @return {Promise<FileSystemFileHandle>}
 */
async function sessionFile(name) {
  try {
    return await /** @type {FileSystemDirectoryHandle} */ (sessionDir).getFileHandle(name, {create: true});
  } catch (e) {
    sessionDir = await /** @type {FileSystemDirectoryHandle} */ (fsBlobRoot).getDirectoryHandle(/** @type {string} */ (sessionName), {create: true});
    return sessionDir.getFileHandle(name, {create: true});
  }
}

async function writeHeartbeat() {
  const handle = await sessionFile(META_FILE);
  const accessHandle = await handle.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({updated_time: Date.now()}));
    writeAll(accessHandle, bytes, 0);
    accessHandle.truncate(bytes.byteLength);
  } finally {
    accessHandle.close();
  }
}

async function init() {
  fsBlobRoot = await getFsBlobRoot();
  sessionName = 'fsblob-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);

  // Before this session's own directory exists, so prune never takes it.
  await prune(sessionName);

  sessionDir = await /** @type {FileSystemDirectoryHandle} */ (fsBlobRoot).getDirectoryHandle(sessionName, {create: true});
  await writeHeartbeat();
  heartbeatInterval = setInterval(() => {
    // Not queued, so long writes cannot starve it past STALE_MS: it touches no file another op does.
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    writeHeartbeat().catch(() => {}).finally(() => {
      heartbeatInFlight = false;
    });
  }, HEARTBEAT_MS);
}

/**
 * @param {string} identifier
 * @param {ArrayBuffer|ArrayBufferView} data
 */
async function setFile(identifier, data) {
  const fileHandle = await sessionFile(identifier);
  const accessHandle = await fileHandle.createSyncAccessHandle();
  try {
    writeAll(accessHandle, data, 0);
    accessHandle.truncate(data.byteLength);
  } catch (e) {
    accessHandle.close();
    // What was written of it only takes up the space that ran out.
    await /** @type {FileSystemDirectoryHandle} */ (sessionDir).removeEntry(identifier).catch(() => {});
    throw e;
  }
  accessHandle.close();
}

/** @param {string} identifier */
async function getFile(identifier) {
  const fileHandle = await /** @type {FileSystemDirectoryHandle} */ (sessionDir).getFileHandle(identifier);
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

/** @param {string} identifier */
async function deleteFile(identifier) {
  try {
    await /** @type {FileSystemDirectoryHandle} */ (sessionDir).removeEntry(identifier);
  } catch (e) {
    // Already gone.
  }
}

async function clearStorage() {
  const names = [];
  for await (const name of /** @type {FileSystemDirectoryHandle} */ (sessionDir).keys()) {
    if (name !== META_FILE) names.push(name);
  }
  await Promise.all(names.map((name) => /** @type {FileSystemDirectoryHandle} */ (sessionDir).removeEntry(name).catch(() => {})));
}

async function destroy() {
  clearInterval(/** @type {ReturnType<typeof setInterval>|undefined} */ (heartbeatInterval));
  heartbeatInterval = null;
  for (const stream of saveStreams.values()) {
    try {
      stream.handle.close();
    } catch (e) {
      // Best-effort - the worker is going away anyway.
    }
  }
  saveStreams.clear();
  // The directory stays: a finished save may still be read. Prune or OPFSManager.close(true) removes it.
}

/** @param {string} identifier */
async function saveBegin(identifier) {
  const fileHandle = await sessionFile(identifier);
  const accessHandle = await fileHandle.createSyncAccessHandle();
  saveStreams.set(identifier, {handle: accessHandle, offset: 0});
}

/**
 * @param {string} identifier
 * @param {ArrayBuffer|ArrayBufferView} data
 */
async function saveAppend(identifier, data) {
  const stream = saveStreams.get(identifier);
  if (!stream) {
    throw new Error('No open save stream: ' + identifier);
  }
  writeAll(stream.handle, data, stream.offset);
  stream.offset += data.byteLength;
}

/** @param {string} identifier */
async function saveEnd(identifier) {
  const stream = saveStreams.get(identifier);
  if (!stream) {
    throw new Error('No open save stream: ' + identifier);
  }
  try {
    stream.handle.truncate(stream.offset);
  } finally {
    stream.handle.close();
    saveStreams.delete(identifier);
  }
}

/** @param {string} identifier */
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
    await /** @type {FileSystemDirectoryHandle} */ (sessionDir).removeEntry(identifier);
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
        // The main thread opens finished save files itself: getFile works there.
        result = {sessionName};
        break;
      case 'set':
        // A Blob (OPFSManager.setFile) is read here, in its turn: one in RAM at a time.
        await queue.push(async () => setFile(identifier, data instanceof Blob ? await data.arrayBuffer() : data));
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
    self.postMessage({id, ok: false, error: /** @type {Error|undefined} */ (e)?.message || String(e)});
  }
});
