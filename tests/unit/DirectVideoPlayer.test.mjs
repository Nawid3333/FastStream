import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import DirectVideoPlayer, {elementHeaderCommands, HEADER_RULE_LIFETIME_MS, HEADER_RULE_RENEW_MS, saveExtension} from '../../chrome/player/players/DirectVideoPlayer.mjs';

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
    // Web audio's own (review): saved as .mp4 before.
    expect(saveExtension({url: 'https://cdn.example/a/voice.weba'})).toBe('weba');
    expect(saveExtension({url: 'https://cdn.example/a/voice.OGA'})).toBe('oga');
  });

  it('saves anything else as mp4', () => {
    expect(saveExtension({url: 'https://cdn.example/watch?v=abc'})).toBe('mp4');
    expect(saveExtension({url: 'https://cdn.example/stream/get.php?id=4'})).toBe('mp4');
    expect(saveExtension(null)).toBe('mp4');
  });
});

// Firefox's player asks for ranges whenever it needs them: on a seek, after a long pause, for
// a Matroska file's index at its end. The rule set once lived 5 s, and the first request after
// that went out without the page's Referer: a hoster's server sent it to a decoy, and the
// source was reloaded. The rule now lives 60 s and is renewed every 10 s while the player has
// the source: a hidden tab's timers may run late.
describe('DirectVideoPlayer\'s header rule', () => {
  let sent;
  let player;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    const video = {src: '', pause() {}, removeAttribute() {}, load() {}};
    globalThis.document = {createElement: () => video, baseURI: 'https://site.test/watch'};
    globalThis.chrome = {extension: {}, runtime: {sendMessage: async (message) => {
      sent.push(message);
    }}};
    player = new DirectVideoPlayer(/** @type {any} */ ({}));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
    delete globalThis.chrome;
  });

  const source = (headers) => /** @type {any} */ ({url: 'https://cdn.test/v/film', headers});

  it('lives 60 s, and is renewed every 10 s while the player has the source', async () => {
    await player.setSource(source({Referer: 'https://site.test/watch'}));
    expect(sent).toEqual([{type: 'SET_HEADERS', url: 'https://cdn.test/v/film', lifetimeMs: HEADER_RULE_LIFETIME_MS,
      commands: [{operation: 'set', header: 'Referer', value: 'https://site.test/watch'}]}]);
    expect(HEADER_RULE_LIFETIME_MS).toBe(60000);
    expect(HEADER_RULE_LIFETIME_MS).toBeGreaterThanOrEqual(HEADER_RULE_RENEW_MS * 5);
    await vi.advanceTimersByTimeAsync(HEADER_RULE_RENEW_MS * 3);
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((message) => JSON.stringify(message))).size).toBe(1);
  });

  it('is no longer renewed once the player is gone, or has another source', async () => {
    await player.setSource(source({Referer: 'https://site.test/watch'}));
    await player.setSource(source({Referer: 'https://site.test/other'}));
    await vi.advanceTimersByTimeAsync(HEADER_RULE_RENEW_MS);
    expect(sent.map((message) => message.commands[0].value)).toEqual(['https://site.test/watch', 'https://site.test/other', 'https://site.test/other']);
    player.destroy();
    await vi.advanceTimersByTimeAsync(HEADER_RULE_RENEW_MS * 3);
    expect(sent).toHaveLength(3);
  });

  it('is neither set nor renewed for a source without headers', async () => {
    await player.setSource(source({}));
    await vi.advanceTimersByTimeAsync(HEADER_RULE_RENEW_MS * 3);
    expect(sent).toEqual([]);
    expect(player.headerRenewal).toBe(null);
  });
});
