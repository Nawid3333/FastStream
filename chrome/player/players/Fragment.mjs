// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';

/**
 * @typedef {{url: string, rangeStart: number|undefined, rangeEnd: number|undefined, responseType: string}} FragmentContext
 */

export class Fragment {
  /**
   * @param {string|number} level
   * @param {number} sn - -1 for an init segment.
   */
  constructor(level, sn) {
    this.sn = sn;
    this.level = level;
    this.status = DownloadStatus.WAITING;
    this.start = -1;
    this.end = -1;
    this.duration = 0;
    // What still needs it (ReferenceTypes): freed when nothing does.
    /** @type {Array<number>} */
    this.references = [];
    this.dataSize = null;
    /** @type {?string} */
    this.failure = null;
  }

  /**
   * @param {number} id
   * @param {boolean} [duplicate]
   */
  addReference(id, duplicate = false) {
    if (duplicate || !this.references.includes(id)) {
      this.references.push(id);
    }
  }

  /** @param {number} id */
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
