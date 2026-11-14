// @ts-check

// The pieces of a save on their way to its file at once: the worker writes them one after
// the other while the next ones are converted.
const SAVE_APPENDS_AHEAD = 8;

/**
 * The media of a file a converter saves (HLS2MP4, MP4Merger), kept as it is made, in its own
 * place: written into one file on disk as it goes (OPFS), or, where the disk save cannot
 * begin (a private window, the web build without OPFS), staged piece by piece in the
 * converter's own blob store. The saved file is the moov in front of it (finish).
 *
 * Kept as Blobs until the end, a long HLS save had the whole video in RAM: 454 MB held at the
 * end of a 458 MB save, 30 minutes of a 2 Mbit/s stream (measured 2026-11-07,
 * docs/notes/player.md). MP4Merger kept slices of the player's own stored fragments until
 * the end instead: the player lets go of a fragment once the save has read it, and once it
 * freed it (a quality change, the buffer moving on) the slice of an OPFS File read nothing.
 */
export class SaveFile {
  /**
   * @param {import('./FSBlob.mjs').FSBlob} blobManager - The converter's own blob store.
   * @param {string} prefix - What the file's identifier starts with.
   */
  constructor(blobManager, prefix) {
    this.blobManager = blobManager;
    // Decided at the first piece (toDisk), once the save began or could not: the store's
    // backend may still turn out to be unusable (a private window's OPFS throws).
    /** @type {?import('../network/OPFSManager.mjs').OPFSManager} */
    this.opfs = blobManager.opfsManager || null;
    this.identifier = this.opfs ? prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000000) : null;
    /** @type {?Promise<void>} */
    this.ready = null;
    if (this.opfs) {
      this.ready = this.opfs.saveBegin(this.identifier);
      // Awaited by toDisk; this only keeps a save cancelled before its first piece quiet.
      this.ready.catch(() => {});
    }
    // Pieces on their way to the file, at most SAVE_APPENDS_AHEAD.
    /** @type {Promise<void>[]} */
    this.appends = [];
    // Without the disk: the blob store's identifiers of the pieces, in order.
    /** @type {string[]} */
    this.pieces = [];
  }

  /**
   * Whether the pieces go into the file on disk: OPFS's save began. Asked before the first
   * piece is kept, so a save that could not begin keeps them all in the blob store. Once a
   * piece is on disk the save stays there: a write that fails fails the save, as the pieces
   * before it are no longer held anywhere else.
   * @return {Promise<boolean>}
   */
  async toDisk() {
    if (!this.opfs) return false;
    try {
      await this.ready;
      return true;
    } catch (e) {
      console.warn('The save could not write to disk; it keeps its pieces in memory', e);
      this.opfs = null;
      return false;
    }
  }

  /**
   * Adds a piece of the media after the ones before it. Waits only while SAVE_APPENDS_AHEAD
   * are on their way to the disk; a write that failed fails here or in finish().
   * @param {Uint8Array<ArrayBuffer>} data - The piece. Nothing keeps it: a view of a larger
   *   buffer is copied, a whole buffer is handed to the worker as it is (transferred).
   * @return {Promise<void>}
   */
  async add(data) {
    if (await this.toDisk()) {
      const own = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
      const append = /** @type {import('../network/OPFSManager.mjs').OPFSManager} */ (this.opfs)
          .saveAppend(this.identifier, own);
      // Awaited below or in finish(); this keeps a failure after a cancel quiet.
      append.catch(() => {});
      this.appends.push(append);
      if (this.appends.length >= SAVE_APPENDS_AHEAD) {
        await this.appends.shift();
      }
      return;
    }
    // Its own copy (the Blob takes the bytes), staged in the converter's store.
    this.pieces.push(this.blobManager.saveBlob(new Blob([data], {type: 'video/mp4'})));
  }

  /**
   * The saved file: the moov in front of the media. It reads from the blob store (its OPFS
   * session, or the pieces), which stays until the converter's release().
   * @param {Uint8Array<ArrayBuffer>} initSeg - The ftyp and moov.
   * @return {Promise<Blob>}
   */
  async finish(initSeg) {
    if (await this.toDisk()) {
      const opfs = /** @type {import('../network/OPFSManager.mjs').OPFSManager} */ (this.opfs);
      await Promise.all(this.appends.splice(0));
      await opfs.saveEnd(this.identifier);
      return new Blob([initSeg, await opfs.getSavedFile(/** @type {string} */ (this.identifier))], {type: 'video/mp4'});
    }
    const pieces = await Promise.all(this.pieces.map((id) => this.blobManager.getBlob(id)));
    // A piece the store no longer has fails the save: in the file it was the word
    // "undefined" (docs/notes/storage.md), behind a "Save complete".
    if (pieces.some((piece) => !piece)) {
      throw new Error('A piece of the saved file is gone');
    }
    return new Blob([initSeg, .../** @type {Blob[]} */ (pieces)], {type: 'video/mp4'});
  }

  /**
   * Drops the file on disk: the save failed or was cancelled, and nothing will read it.
   * @return {Promise<void>}
   */
  async abort() {
    if (this.opfs) {
      await this.opfs.saveAbort(this.identifier).catch(() => {});
    }
  }
}
