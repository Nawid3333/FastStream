import {describe, expect, it} from 'vitest';

import {describePlayerError} from '../../chrome/player/utils/PlayerErrorUtils.mjs';

// The load error says what failed (FastStreamClient's ERROR handler). Each player emits its
// own kind of reason; every one of them showed as the bare "Failed to load video!".

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
