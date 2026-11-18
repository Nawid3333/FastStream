// @ts-check
import {Fragment} from '../Fragment.mjs';

/** @typedef {import('../../modules/hls.mjs').Fragment} HlsJsFragment */
export class HLSFragment extends Fragment {
  /**
   * @param {HlsJsFragment} frag
   * @param {number} start
   * @param {number} end
   * @param {number|string} [index] - Its place in the level's store; hls.js's sn for an init segment.
   */
  constructor(frag, start, end, index = frag.sn) {
    // An init segment has no levelIdentifier and the sn 'initSegment' (the client keeps -1): neither is read.
    super(/** @type {string} */ (frag.levelIdentifier), /** @type {number} */ (index));
    this.hlsFrag = frag;
    this.duration = frag.duration;
    this.start = start;
    this.end = end;
  }

  getFrag() {
    return this.hlsFrag;
  }

  /** @override */
  getContext() {
    return {
      url: this.hlsFrag.url,
      rangeStart: this.hlsFrag.byteRangeStartOffset,
      rangeEnd: this.hlsFrag.byteRangeEndOffset,
      responseType: 'arraybuffer',
    };
  }
}
