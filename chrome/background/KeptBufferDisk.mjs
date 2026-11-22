// @ts-check
/**
 * Buffers kept longer than the event page lives (BufferStash.KeptDisk): in their session directory under OPFS
 * `fsblob`, with a record next to their files, which a player's prune leaves alone until its time is up.
 */

import {KeptRecordFile} from '../player/options/BufferKeep.mjs';

export {KeptRecordFile};
export const BufferKeepAlarm = 'buffer-keep';
const BrowserIdKey = 'bufferKeepBrowser';
const WritingKey = 'bufferKeepWriting';
// What kept buffers may hold on the disk together: the rest is for the videos playing.
const QuotaShare = 0.25;
const UnknownQuotaLimit = 2e9;

/** @return {Promise<FileSystemDirectoryHandle>} */
async function fsblobRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('fsblob', {create: true});
}

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} name
 * @param {Blob|string} data
 * @return {Promise<void>}
 */
async function writeWhole(dir, name, data) {
  const writable = await (await dir.getFileHandle(name, {create: true})).createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}

/** @return {import('./BufferStash.mjs').KeptDisk} */
export function keptBufferDisk() {
  /** @type {?Promise<string>} */
  let browserId = null;
  return {
    browserId() {
      // storage.session: kept while the event page is unloaded, gone when Firefox closes.
      browserId ??= chrome.storage.session.get(BrowserIdKey).then(async (stored) => {
        if (typeof stored?.[BrowserIdKey] === 'string') return stored[BrowserIdKey];
        const id = crypto.randomUUID();
        await chrome.storage.session.set({[BrowserIdKey]: id});
        return id;
      });
      browserId.catch(() => {
        browserId = null;
      });
      return browserId;
    },

    async newSession() {
      // The players' session name: younger than their prune's limit, it is left alone until its record is written.
      const name = `fsblob-${Date.now()}-kept${crypto.randomUUID().slice(0, 8)}`;
      await (await fsblobRoot()).getDirectoryHandle(name, {create: true});
      return name;
    },

    async writeFile(session, name, blob) {
      await writeWhole(await (await fsblobRoot()).getDirectoryHandle(session), name, blob);
      // An extension call counts as the event page's activity (measured: an OPFS write alone does not, and Firefox
      // unloaded it 30 s in): it stays up while the buffer is written.
      await chrome.storage.session.set({[WritingKey]: Date.now()});
    },

    async writeRecord(session, record) {
      await writeWhole(await (await fsblobRoot()).getDirectoryHandle(session), KeptRecordFile, JSON.stringify(record));
    },

    async listKept() {
      const kept = [];
      for await (const [session, handle] of /** @type {*} */ (await fsblobRoot()).entries()) {
        if (handle.kind !== 'directory') continue;
        let text;
        try {
          text = await (await (await handle.getFileHandle(KeptRecordFile)).getFile()).text();
        } catch (e) {
          continue;
        }
        let record = null;
        try {
          record = JSON.parse(text);
        } catch (e) {
          // Broken: deleted as no record of this run's.
        }
        kept.push({session, record});
      }
      return kept;
    },

    schedule(when) {
      const done = when === null ? chrome.alarms.clear(BufferKeepAlarm) : chrome.alarms.create(BufferKeepAlarm, {when});
      Promise.resolve(done).catch((e) => console.warn('Could not set the kept buffers\' alarm', e));
    },

    async limitBytes() {
      const {quota} = await navigator.storage.estimate();
      return Number.isFinite(quota) ? /** @type {number} */ (quota) * QuotaShare : UnknownQuotaLimit;
    },
  };
}
