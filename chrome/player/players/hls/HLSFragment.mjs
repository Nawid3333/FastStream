// @ts-check
import {Fragment} from '../Fragment.mjs';

/**
 * The hls.js fragment, with what HLSFragmentStore notes on it (its levelIdentifier and
 * trackID: types/vendor-patches.d.ts). An init segment's has no levelIdentifier.
 * @typedef {import('../../modules/hls.mjs').Fragment} HlsJsFragment
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
    // An init segment comes with hls.js's own: no levelIdentifier, and 'initSegment' for its
    // sn (the client keeps it at -1). Neither is read of an init segment.
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
