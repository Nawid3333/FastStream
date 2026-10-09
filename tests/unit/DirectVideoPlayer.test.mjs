import {describe, expect, it} from 'vitest';

import {elementHeaderCommands, saveExtension} from '../../chrome/player/players/DirectVideoPlayer.mjs';

// A source handed from the MP4 player to Firefox's own (playDirectly) keeps the page's
// headers through the background's rule for its URL: the Referer or cookie a site asks for.
// Firefox's player asks for its own ranges, so the rule must not set Range or the headers
// that describe the connection or the request itself.

describe('elementHeaderCommands', () => {
  it('sets the site\'s headers and removes those set to false', () => {
    expect(elementHeaderCommands({'Referer': 'https://example.com/', 'Origin': false, 'X-Token': 7})).toEqual([
      {operation: 'set', header: 'Referer', value: 'https://example.com/'},
      {operation: 'remove', header: 'Origin'},
      {operation: 'set', header: 'X-Token', value: '7'},
    ]);
  });

  it('leaves the range, the encoding and the connection to Firefox, in any case', () => {
    expect(elementHeaderCommands({'Range': 'bytes=0-999999', 'if-range': 'x', 'Accept-Encoding': 'identity',
      'HOST': 'a', 'Connection': 'close', 'Content-Length': '5', 'Transfer-Encoding': 'chunked', 'TE': 'trailers',
      'Upgrade': 'h2c', 'Keep-Alive': '5', 'Expect': '100-continue', 'Trailer': 'x', 'Proxy-Authorization': 'x',
      'Cookie': 'a=b'})).toEqual([{operation: 'set', header: 'Cookie', value: 'a=b'}]);
  });

  it('makes no commands without headers', () => {
    expect(elementHeaderCommands(null)).toEqual([]);
    expect(elementHeaderCommands(undefined)).toEqual([]);
    expect(elementHeaderCommands({})).toEqual([]);
  });
});

// A URL without an extension was saved as .webm, one ending in .php as .php: most direct
// videos are MP4 (review, 2026-10-09).
describe('saveExtension', () => {
  it('keeps the extension of a media file', () => {
    expect(saveExtension({url: 'https://cdn.example/a/clip.webm?sig=1'})).toBe('webm');
    expect(saveExtension({url: 'https://cdn.example/a/clip.MP4'})).toBe('mp4');
    expect(saveExtension({identifier: 'song.m4a', url: 'blob:x'})).toBe('m4a');
  });

  it('saves anything else as mp4', () => {
    expect(saveExtension({url: 'https://cdn.example/watch?v=abc'})).toBe('mp4');
    expect(saveExtension({url: 'https://cdn.example/stream/get.php?id=4'})).toBe('mp4');
    expect(saveExtension(null)).toBe('mp4');
  });
});
