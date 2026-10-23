// @ts-check
import {Fragment} from '../Fragment.mjs';

export class MP4Fragment extends Fragment {
  /**
   * @param {string|number} level
   * @param {number} sn
   * @param {import('../../VideoSource.mjs').VideoSource} source - The file it is a byte range of.
   * @param {number} rangeStart - Its first byte.
   * @param {number} rangeEnd - The byte after its last.
   */
  constructor(level, sn, source, rangeStart, rangeEnd) {
    super(level, sn);
    this.source = source;
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
  }

  getContext() {
    return {
      url: this.source.url,
      rangeStart: this.rangeStart,
      rangeEnd: this.rangeEnd,
      responseType: 'arraybuffer',
    };
  }
}
