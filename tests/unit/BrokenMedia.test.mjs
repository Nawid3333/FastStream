import {describe, expect, it} from 'vitest';

import {AGAIN_WITHIN_MS, BLIND_SKIP_S, isDecodeError, isSamePlace, pastBrokenMedia} from '../../chrome/player/utils/BrokenMedia.mjs';
import {stuckAfterStart} from '../../chrome/player/players/dash/DashErrors.mjs';

// A segment that does not decode, and the player built again for it (FastStreamClient.
// recoverPlayer): the first decode error at a place builds it again at the same time, the
// same place failing again right after is the media's fault and the player starts past it.
// Measured on a DASH stream with one broken segment: three rebuilds at 3.64 s, then the video
// ended in "Failed to load video!".

const fragment = (start, end) => ({start, end});

describe('BrokenMedia', () => {
  it('knows the <video> element\'s decode error, and nothing else', () => {
    expect(isDecodeError({target: {error: {code: 3}}})).toBe(true);
    expect(isDecodeError({target: {error: {code: 3, message: 'RemoteVideoDecoderChild::InitIPDL'}}})).toBe(true);
    // An audio decoder's failure: no reason to skip video.
    expect(isDecodeError({target: {error: {code: 3, message: 'RemoteAudioDecoder failed'}}})).toBe(false);
    for (const reason of [{target: {error: {code: 2}}}, {target: {error: null}}, 'Segment 1 failed to load',
      {type: 'mediaError', details: 'bufferAppendError'}, null, undefined]) {
      expect(isDecodeError(reason)).toBe(false);
    }
    const throwing = {get target() {
      throw new Error('dead object');
    }};
    expect(isDecodeError(throwing)).toBe(false);
  });

  it('takes two decode errors of a source within 1.5 s of each other, soon after, for the same place', () => {
    const at = 1000000;
    const last = {url: 'https://a/x.mpd', time: 3.64, at};
    const soon = at + 700;
    expect(isSamePlace(last, 'https://a/x.mpd', 3.64, soon)).toBe(true);
    expect(isSamePlace(last, 'https://a/x.mpd', 3.1, soon)).toBe(true);
    expect(isSamePlace(last, 'https://a/x.mpd', 5.5, soon)).toBe(false);
    expect(isSamePlace(last, 'https://a/y.mpd', 3.64, soon)).toBe(false);
    expect(isSamePlace(null, 'https://a/x.mpd', 3.64, soon)).toBe(false);
    expect(isSamePlace(last, 'https://a/x.mpd', NaN, soon)).toBe(false);
    // A seek back there much later: a new failure, not the same one again.
    expect(isSamePlace(last, 'https://a/x.mpd', 3.64, at + AGAIN_WITHIN_MS + 1)).toBe(false);
  });

  it('plays on past the segment Firefox was decoding ahead into', () => {
    const fragments = [fragment(0, 2), fragment(2, 4), fragment(4, 6), fragment(6, 8)];
    // 3.64 s, the segment from 4 s on failing (as measured): past it, at 6 s.
    expect(pastBrokenMedia(fragments, 3.64)).toBe(6);
  });

  it('plays on past the segment playing when none begins within a second', () => {
    const fragments = [fragment(0, 4), fragment(4, 8)];
    expect(pastBrokenMedia(fragments, 1.5)).toBe(4);
    // Holes and fragments without times (a live window, a fragmented MP4's ranges) are passed over.
    expect(pastBrokenMedia([null, {start: NaN, end: NaN}, fragment(0, 4)], 1.5)).toBe(4);
  });

  it('skips a little when it knows of no fragment there', () => {
    expect(pastBrokenMedia([], 10)).toBe(10 + BLIND_SKIP_S);
    expect(pastBrokenMedia(undefined, 10)).toBe(10 + BLIND_SKIP_S);
  });
});

describe('DashErrors', () => {
  const errors = {
    MANIFEST_LOADER_PARSING_FAILURE_ERROR_CODE: 10,
    MANIFEST_LOADER_LOADING_FAILURE_ERROR_CODE: 11,
    TIME_SYNC_FAILED_ERROR_CODE: 16,
    DOWNLOAD_ERROR_ID_MANIFEST_CODE: 25,
    DOWNLOAD_ERROR_ID_SIDX_CODE: 26,
    DOWNLOAD_ERROR_ID_CONTENT_CODE: 27,
    DOWNLOAD_ERROR_ID_INITIALIZATION_CODE: 28,
    DOWNLOAD_ERROR_ID_XLINK_CODE: 29,
    MANIFEST_ERROR_ID_PARSE_CODE: 31,
    MANIFEST_ERROR_ID_NOSTREAMS_CODE: 32,
    TIMED_TEXT_ERROR_ID_PARSE_CODE: 33,
    MANIFEST_ERROR_ID_MULTIPLEXED_CODE: 34,
    MEDIASOURCE_TYPE_UNSUPPORTED_CODE: 35,
    NO_SUPPORTED_KEY_IDS: 36,
  };

  it('reports what leaves the stream stuck once it is up, and leaves the rest to dash.js', () => {
    const stuck = stuckAfterStart(errors);
    expect([...stuck].sort((a, b) => a - b)).toEqual([11, 25, 26, 27, 28, 29, 31, 32, 34, 35, 36]);
    // A live refresh that did not parse, the clock sync, a subtitle: dash.js plays on.
    for (const code of [10, 16, 33]) expect(stuck.has(code)).toBe(false);
  });

  it('leaves the manifest refresh failures of a live stream to dash.js: the next refresh may load', () => {
    const live = stuckAfterStart(errors, true);
    expect(live.has(11)).toBe(false);
    expect(live.has(25)).toBe(false);
    expect(live.has(27)).toBe(true);
  });

  it('reads the codes from dash.js, and skips a name it does not have', () => {
    expect(stuckAfterStart({DOWNLOAD_ERROR_ID_CONTENT_CODE: 27})).toEqual(new Set([27]));
    expect(stuckAfterStart(undefined)).toEqual(new Set());
  });
});
