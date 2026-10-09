import {describe, expect, it} from 'vitest';

import {describePlayerError, isNetworkFailure} from '../../chrome/player/utils/PlayerErrorUtils.mjs';

// The load error says what failed (FastStreamClient's ERROR handler). Each player emits its
// own kind of reason; every one of them showed as the bare "Failed to load video!".

describe('isNetworkFailure', () => {
  // A player built again asks the same server for the same fragment: no rebuild for those.
  it('knows the players\' network failures', () => {
    for (const reason of ['Range 5 failed to load', 'Segment 0:12 failed to load', 'Failed first fragment',
      'No content range', {type: 'networkError', details: 'fragLoadError', fatal: true}]) {
      expect(isNetworkFailure(reason)).toBe(true);
    }
  });

  it('knows the downloads of dash.js that ran out of retries', () => {
    // The manifest's loading, then a manifest, an index, a segment, an init segment, an xlink.
    for (const code of [11, 25, 26, 27, 28, 29]) {
      expect(isNetworkFailure({type: 'error', error: {code, message: 'x'}})).toBe(true);
    }
    // A manifest it cannot use, no stream, a muxed track, a type MSE does not take, no key:
    // a new player can do no better, but they are not the network.
    for (const code of [10, 31, 32, 34, 35, 36]) {
      expect(isNetworkFailure({type: 'error', error: {code, message: 'x'}})).toBe(false);
    }
  });

  it('leaves what a new player can get past', () => {
    for (const reason of ['Playback stuck at 302.1', 'The video could not be buffered: QuotaExceededError',
      {type: 'mediaError', details: 'bufferAppendError', fatal: true},
      {type: 'error', target: {error: {code: 3, message: 'decode'}}}, undefined, null, {}]) {
      expect(isNetworkFailure(reason)).toBe(false);
    }
  });
});

describe('describePlayerError', () => {
  it('keeps a sentence as it is (MP4Player, DashLoader)', () => {
    expect(describePlayerError('Range 5 failed to load')).toBe('Range 5 failed to load');
    expect(describePlayerError('Segment 0:12 failed to load')).toBe('Segment 0:12 failed to load');
  });

  it('reads the MediaError off the <video> element\'s error event', () => {
    const video = {error: {code: 3, message: 'NS_ERROR_DOM_MEDIA_FATAL_ERR (0x806e0005) - decode failed', MEDIA_ERR_DECODE: 3}};
    expect(describePlayerError({type: 'error', target: video}))
        .toBe('media error 3: NS_ERROR_DOM_MEDIA_FATAL_ERR (0x806e0005) - decode failed');
    expect(describePlayerError({type: 'error', target: {error: {code: 2, message: ''}}})).toBe('media error 2');
  });

  it('names hls.js\'s error details, with the HTTP status when there is one', () => {
    expect(describePlayerError({type: 'networkError', details: 'fragLoadError', fatal: true, response: {code: 403, text: 'Forbidden'}}))
        .toBe('fragLoadError (HTTP 403)');
    expect(describePlayerError({type: 'mediaError', details: 'bufferAppendError', fatal: true})).toBe('bufferAppendError');
  });

  it('reads dash.js\'s error', () => {
    expect(describePlayerError({error: {code: 25, message: 'Manifest is not valid'}})).toBe('Manifest is not valid');
    expect(describePlayerError({error: {code: 10}})).toBe('dash.js error 10');
    expect(describePlayerError({error: 'Segment not found'})).toBe('Segment not found');
  });

  it('never throws: the load error must still show', () => {
    const hostile = {get target() {
      throw new Error('getter');
    }};
    expect(describePlayerError(hostile)).toBe('');
    expect(describePlayerError({error: {code: Symbol('x')}})).toBe('');
  });

  it('reads an Error', () => {
    expect(describePlayerError(new Error('No current fragment'))).toBe('No current fragment');
  });

  it('says nothing when there is nothing to say', () => {
    expect(describePlayerError(undefined)).toBe('');
    expect(describePlayerError(null)).toBe('');
    expect(describePlayerError({})).toBe('');
  });

  it('keeps it to one short line', () => {
    const long = describePlayerError({target: {error: {code: 3, message: 'x'.repeat(500) + '\n  more'}}});
    expect(long.length).toBe(160);
    expect(long.endsWith('…')).toBe(true);
    expect(describePlayerError('two\nlines')).toBe('two lines');
  });
});
