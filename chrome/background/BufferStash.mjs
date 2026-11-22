// @ts-check
import {BufferKeepMaxMs, BufferKeepRamOnlySeconds} from '../player/options/BufferKeep.mjs';

/**
 * A gone player's buffer, kept for the next player of the same video on the same page: in the background's RAM up to
 * BufferKeepRamOnlySeconds, longer on the disk (the RAM goes with the event page Firefox unloads when idle).
 */

export const BufferKeepMs = BufferKeepRamOnlySeconds * 1000;
// The record of a buffer on the disk is written again after this much of its RAM was written there.
const RecordEveryBytes = 256 * 1024 * 1024;

/**
 * @typedef {Object} HandedEntry
 * @property {string} url
 * @property {number} rangeStart
 * @property {number} rangeEnd
 * @property {string} responseType
 * @property {number} dataSize
 * @property {Blob} [blob]
 * @property {string} [file]
 */

/**
 * @typedef {Object} BufferHandOff
 * @property {string} url
 * @property {?string} session
 * @property {HandedEntry[]} entries
 */

/**
 * What a buffer kept on the disk says about itself, next to its files (`_kept.json`).
 * @typedef {Object} KeptRecord
 * @property {string} browser - The Firefox run it was kept in (KeptDisk.browserId).
 * @property {string} key - bufferKey.
 * @property {number} until - When it goes.
 * @property {string} url
 * @property {HandedEntry[]} entries - Its files only.
 */

/**
 * The disk of buffers kept longer than the event page lives (KeptBufferDisk.mjs; a stand-in in tests).
 * @typedef {Object} KeptDisk
 * @property {() => Promise<string>} browserId - Gone when Firefox closes: what an earlier run kept is deleted.
 * @property {() => Promise<string>} newSession - A session directory for a buffer that had none (all in RAM).
 * @property {(session: string, name: string, blob: Blob) => Promise<void>} writeFile - Keeps the event page up.
 * @property {(session: string, record: KeptRecord) => Promise<void>} writeRecord
 * @property {() => Promise<Array<{session: string, record: *}>>} listKept - Every session with a record.
 * @property {(when: ?number) => void} schedule - Wakes the background then (an alarm); null for none.
 * @property {() => Promise<number>} limitBytes - What all buffers kept on the disk may hold together.
 */

/**
 * @typedef {Object} Kept
 * @property {BufferHandOff} handOff
 * @property {number} until
 * @property {number} since
 * @property {number} bytes
 * @property {boolean} onDisk
 * @property {ReturnType<typeof setTimeout>} timer
 */

/**
 * Same video, page, window kind and container: a private window's buffer must not reach the disk.
 * @param {{pageUrl: string, identifier: string, incognito: boolean, cookieStoreId?: ?string}} where
 * @return {string}
 */
export function bufferKey({pageUrl, identifier, incognito, cookieStoreId}) {
  return JSON.stringify([incognito ? 1 : 0, cookieStoreId || '', pageUrl, identifier]);
}

/**
 * @param {HandedEntry[]} entries
 * @return {number}
 */
function sizeOf(entries) {
  return entries.reduce((sum, entry) => sum + (Number.isFinite(entry?.dataSize) ? entry.dataSize : 0), 0);
}

/**
 * A record read back from the disk, or null for one that is no record of this run's.
 * @param {*} record
 * @param {string} browser
 * @param {number} now
 * @return {?KeptRecord}
 */
function validRecord(record, browser, now) {
  if (!record || record.browser !== browser || typeof record.key !== 'string' || typeof record.url !== 'string' ||
      !Array.isArray(record.entries) || !Number.isFinite(record.until) || record.until <= now ||
      record.until > now + BufferKeepMaxMs) {
    return null;
  }
  const entries = record.entries.filter((/** @type {*} */ entry) => typeof entry?.url === 'string' && typeof entry.file === 'string');
  return {...record, entries};
}

export class BufferStash {
  /**
   * @param {Object} [options]
   * @param {number} [options.keepMs] - When put() is given none.
   * @param {(session: string) => (Promise<void>|void)} [options.dropSession]
   * @param {?KeptDisk} [options.disk] - None: nothing is kept longer than the RAM keeps it.
   */
  constructor({keepMs = BufferKeepMs, dropSession = () => {}, disk = null} = {}) {
    this.keepMs = keepMs;
    this.dropSession = dropSession;
    this.disk = disk;
    /** @type {Map<string, Kept>} */
    this.kept = new Map();
    // What an unloaded event page kept on the disk: take() and expire() wait for it.
    this.ready = disk ? this.restore().catch((e) => console.warn('Could not read the buffers kept on the disk', e)) :
      Promise.resolve();
  }

  /**
   * @param {string} key
   * @param {BufferHandOff} handOff
   * @param {number} [keepMs] - 0: none kept, its files deleted.
   * @param {{ramOnly?: boolean}} [where] - A private window's: in RAM, at most BufferKeepMs.
   */
  put(key, handOff, keepMs = this.keepMs, {ramOnly = false} = {}) {
    this.flush(key, handOff.session);
    if (!(keepMs > 0)) {
      this.drop(handOff.session);
      return;
    }
    // Past BufferKeepMs only on the disk: the RAM goes with the event page.
    const ms = Math.min(keepMs, ramOnly || !this.disk ? BufferKeepMs : BufferKeepMaxMs);
    const now = Date.now();
    /** @type {Kept} */
    const kept = {handOff, until: now + ms, since: now, bytes: sizeOf(handOff.entries), onDisk: false,
      timer: setTimeout(() => this.expire(), ms)};
    this.kept.set(key, kept);
    if (this.disk && ms > BufferKeepMs) {
      this.keepOnDisk(key, kept).catch((e) => {
        // Taken or let go of while it was written: its directory went with it.
        if (this.kept.get(key) === kept) console.warn('Could not keep a handed-over buffer on the disk', e);
      });
    }
  }

  /**
   * @param {string} key
   * @return {Promise<?BufferHandOff>}
   */
  async take(key) {
    await this.ready;
    const kept = this.kept.get(key);
    if (!kept) return null;
    clearTimeout(kept.timer);
    this.kept.delete(key);
    if (kept.onDisk) this.schedule();
    return kept.handOff;
  }

  /**
   * @param {string} key
   * @param {?string} [keepSession]
   */
  flush(key, keepSession = null) {
    const kept = this.kept.get(key);
    if (!kept) return;
    clearTimeout(kept.timer);
    this.kept.delete(key);
    if (kept.handOff.session !== keepSession) {
      this.drop(kept.handOff.session);
    }
    if (kept.onDisk) this.schedule();
  }

  /** Lets go of every buffer whose time is up: at its timer, or at the alarm of an event page loaded again. */
  expire() {
    const now = Date.now();
    for (const [key, kept] of [...this.kept]) {
      if (kept.until <= now) this.flush(key);
    }
  }

  /** @return {number} */
  get size() {
    return this.kept.size;
  }

  /** @param {?string} session */
  drop(session) {
    if (!session) return;
    Promise.resolve()
        .then(() => this.dropSession(session))
        .catch((e) => console.warn('Could not delete a handed-over buffer\'s files', e));
  }

  /** The next deadline of a buffer on the disk, for an event page that is gone by then. */
  schedule() {
    if (!this.disk) return;
    let next = Infinity;
    for (const kept of this.kept.values()) {
      if (kept.onDisk) next = Math.min(next, kept.until);
    }
    this.disk.schedule(Number.isFinite(next) ? next : null);
  }

  /**
   * Room for it among the buffers kept on the disk, the oldest let go of first; one larger than all the room is
   * kept in RAM only.
   * @param {string} key
   * @param {Kept} kept
   * @return {Promise<void>}
   */
  async keepOnDisk(key, kept) {
    const disk = /** @type {KeptDisk} */ (this.disk);
    const limit = await disk.limitBytes();
    if (this.kept.get(key) !== kept) return;
    if (kept.bytes > limit) {
      clearTimeout(kept.timer);
      const ms = Math.max(0, kept.since + BufferKeepMs - Date.now());
      kept.until = kept.since + BufferKeepMs;
      kept.timer = setTimeout(() => this.expire(), ms);
      return;
    }
    let total = kept.bytes;
    const others = [...this.kept].filter(([, other]) => other.onDisk).sort(([, a], [, b]) => b.since - a.since);
    for (const [otherKey, other] of others) {
      if (total + other.bytes > limit) {
        this.flush(otherKey);
      } else {
        total += other.bytes;
      }
    }
    kept.onDisk = true;
    this.schedule();
    await this.persist(key, kept);
  }

  /**
   * Writes its RAM to its session directory and a record of it next to its files, which a player's prune leaves
   * alone until its time is up. Taken or let go of meanwhile, it stops.
   * @param {string} key
   * @param {Kept} kept
   * @return {Promise<void>}
   */
  async persist(key, kept) {
    const disk = /** @type {KeptDisk} */ (this.disk);
    const handOff = kept.handOff;
    const here = () => this.kept.get(key) === kept;
    const browser = await disk.browserId();
    if (!here()) return;
    if (!handOff.session) {
      const created = await disk.newSession();
      if (!here()) {
        this.drop(created);
        return;
      }
      handOff.session = created;
    }
    const session = handOff.session;
    const record = () => disk.writeRecord(session, {browser, key, until: kept.until, url: handOff.url,
      entries: handOff.entries.filter((entry) => typeof entry.file === 'string').map(({blob, ...entry}) => entry)});
    await record();
    let count = 0;
    let unrecorded = 0;
    for (const entry of handOff.entries) {
      if (!here()) return;
      if (!(entry.blob instanceof Blob)) continue;
      const name = 'k' + count++;
      await disk.writeFile(session, name, entry.blob);
      if (!here()) return;
      unrecorded += entry.blob.size;
      entry.file = name;
      delete entry.blob;
      if (unrecorded >= RecordEveryBytes) {
        await record();
        unrecorded = 0;
      }
    }
    if (here()) await record();
  }

  /**
   * What the event page kept on the disk before Firefox unloaded it. An earlier Firefox run's, a broken record and
   * one whose time is up are deleted.
   * @return {Promise<void>}
   */
  async restore() {
    const disk = /** @type {KeptDisk} */ (this.disk);
    const browser = await disk.browserId();
    const now = Date.now();
    for (const {session, record: read} of await disk.listKept()) {
      // Being written now: put() came first.
      if ([...this.kept.values()].some((kept) => kept.handOff.session === session)) continue;
      const record = validRecord(read, browser, now);
      // A newer one of the same video came first.
      if (!record || this.kept.has(record.key)) {
        this.drop(session);
        continue;
      }
      const key = record.key;
      this.kept.set(key, {handOff: {url: record.url, session, entries: record.entries}, until: record.until,
        since: now, bytes: sizeOf(record.entries), onDisk: true, timer: setTimeout(() => this.expire(), record.until - now)});
    }
    this.schedule();
  }
}
