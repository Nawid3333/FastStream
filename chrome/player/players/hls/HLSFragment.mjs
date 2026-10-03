import {Fragment} from '../Fragment.mjs';

export class HLSFragment extends Fragment {
  /**
   * @param {Object} frag - The hls.js fragment.
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
