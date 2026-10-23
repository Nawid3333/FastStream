// @ts-check
import {StringUtils} from '../../utils/StringUtils.mjs';
import {Fragment} from '../Fragment.mjs';

export class DashFragment extends Fragment {
  /**
   * @param {import('../../modules/dash.mjs').FragmentRequest} request - dash.js's request for it, with
   *   the level and index DashPlayer gave it.
   */
  constructor(request) {
    // DashPlayer gives the request its level before it makes the fragment.
    super(/** @type {string} */ (request.level), request.index);
    this.request = request;
    this.duration = request.duration;
    this.start = request.startTime;
    this.end = request.startTime + this.duration;
  }

  /** @override */
  getContext() {
    /** @type {number|undefined} */
    let rangeStart = undefined;
    /** @type {number|undefined} */
    let rangeEnd = undefined;
    if (this.request.range) {
      const [start, end] = StringUtils.parseHTTPRange(this.request.range);
      if (start === undefined) {
        console.error('Failed to parse range', this.request.range);
      } else {
        rangeStart = start;
        rangeEnd = end + 1;
      }
    }
    return {
      // A segment's request has its URL.
      url: /** @type {string} */ (this.request.url),
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      responseType: 'arraybuffer',
    };
  }
}
