// @ts-check
import {Fragment} from '../Fragment.mjs';

export class MP4Fragment extends Fragment {
  /**
   * @param {string|number} level
   * @param {number} sn
   * @param {import('../../VideoSource.mjs').VideoSource} source
   * @param {number} rangeStart
   * @param {number} rangeEnd - The byte after its last.
   */
  constructor(level, sn, source, rangeStart, rangeEnd) {
    super(level, sn);
    this.source = source;
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
  }

  /** @override */
  getContext() {
    return {
      url: this.source.url,
      rangeStart: this.rangeStart,
      rangeEnd: this.rangeEnd,
      responseType: 'arraybuffer',
    };
  }
}
