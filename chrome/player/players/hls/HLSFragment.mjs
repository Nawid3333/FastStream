// @ts-check
import {Fragment} from '../Fragment.mjs';

/**
 * @typedef {object} HlsJsFragment - The hls.js fragment.
 * @property {number|string} sn - Its media sequence number; 'initSegment' for an init segment.
 * @property {string} levelIdentifier - The identifier of the level it belongs to.
 * @property {number} duration - Its length, in seconds.
 * @property {string} url - Its resolved address.
 * @property {number} byteRangeStartOffset - First byte of its byte range.
 * @property {number} byteRangeEndOffset - Last byte of its byte range.
 */
export class HLSFragment extends Fragment {
  /**
   * @param {HlsJsFragment} frag - The hls.js fragment.
   * @param {number} start
   * @param {number} end
   * @param {number|string} [index] - Its place in the level's store (HLSFragmentStore), which
   *   the client knows it by; hls.js's sn for an init segment.
   */
  constructor(frag, start, end, index = frag.sn) {
    super(frag.levelIdentifier, index);
    this.hlsFrag = frag;
    this.duration = frag.duration;
    this.start = start;
    this.end = end;
  }

  getFrag() {
    return this.hlsFrag;
  }

  getContext() {
    return {
      url: this.hlsFrag.url,
      rangeStart: this.hlsFrag.byteRangeStartOffset,
      rangeEnd: this.hlsFrag.byteRangeEndOffset,
      responseType: 'arraybuffer',
    };
  }
}
