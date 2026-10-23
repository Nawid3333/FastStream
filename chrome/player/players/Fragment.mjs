// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';

/**
 * What a fragment's bytes are downloaded from (getContext): its URL, its byte range when it is
 * one part of a file, and the response type.
 * @typedef {{url: string, rangeStart: number|undefined, rangeEnd: number|undefined, responseType: string}} FragmentContext
 */

export class Fragment {
  /**
   * @param {string|number} level - The level (or track) it belongs to, as the client keys it.
   * @param {number} sn - Its number in the level; -1 for an init segment.
   */
  constructor(level, sn) {
    this.sn = sn;
    this.level = level;
    this.status = DownloadStatus.WAITING;
    this.start = -1;
    this.end = -1;
    this.duration = 0;
    // What still needs it (ReferenceTypes); it can be freed when nothing does.
    /** @type {Array<number>} */
    this.references = [];
    this.dataSize = null;
  }

  /**
   * @param {number} id - A ReferenceTypes value.
   * @param {boolean} [duplicate] - Counts it again if it is there already.
   */
  addReference(id, duplicate = false) {
    if (duplicate || !this.references.includes(id)) {
      this.references.push(id);
    }
  }

  /** @param {number} id - A ReferenceTypes value. */
  removeReference(id) {
    const index = this.references.indexOf(id);
    if (index !== -1) {
      this.references.splice(index, 1);
    }
  }

  canFree() {
    return this.references.length <= 0;
  }

  /** @return {FragmentContext} */
  getContext() {
    throw new Error('Not implemented');
  }
}
