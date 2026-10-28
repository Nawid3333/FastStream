import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {BufferKeepMs, BufferStash, bufferKey} from '../../chrome/background/BufferStash.mjs';

// A player that goes away (its page reloads) hands its buffer to the background, for the next
// player of the same video on the same page; what nobody takes is flushed after 20 s, its
// files deleted (his wish, 2026-10-28).

const handOff = (session = 'fsblob-1-1') => ({url: 'https://cdn.test/v/master.m3u8?t=A', session, entries: [{url: 'x'}]});
const where = {pageUrl: 'https://site.test/watch/1', identifier: 'https://cdn.test/v/master.m3u8', incognito: false, cookieStoreId: null};

describe('BufferStash', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a hand-off for 20 s, for the next player to take back', () => {
    expect(BufferKeepMs).toBe(20000);
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    const key = bufferKey(where);
    const kept = handOff();
    stash.put(key, kept);
    vi.advanceTimersByTime(19000);
    expect(stash.take(key)).toBe(kept);
    // Taken: its taker owns its files now, and nothing is flushed later.
    expect(stash.take(key)).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(dropSession).not.toHaveBeenCalled();
  });

  it('flushes what nobody took after 20 s: its RAM let go of, its files deleted', async () => {
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    const key = bufferKey(where);
    stash.put(key, handOff('fsblob-9-9'));
    vi.advanceTimersByTime(BufferKeepMs);
    await vi.runAllTimersAsync();
    expect(stash.size).toBe(0);
    expect(stash.take(key)).toBeNull();
    expect(dropSession).toHaveBeenCalledExactlyOnceWith('fsblob-9-9');
  });

  it('flushes an older hand-off of the same video and page when a newer comes', async () => {
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    const key = bufferKey(where);
    stash.put(key, handOff('fsblob-1-1'));
    const newer = handOff('fsblob-2-2');
    stash.put(key, newer);
    await vi.runOnlyPendingTimersAsync();
    expect(dropSession).toHaveBeenCalledWith('fsblob-1-1');
    expect(stash.size).toBe(0);
    // A hand-off whose session a newer one still names keeps its files.
    stash.put(key, handOff('fsblob-3-3'));
    stash.put(key, handOff('fsblob-3-3'));
    await Promise.resolve();
    expect(dropSession).not.toHaveBeenCalledWith('fsblob-3-3');
  });

  it('survives a session it cannot delete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stash = new BufferStash({dropSession: () => Promise.reject(new Error('gone'))});
    stash.put('k', handOff());
    await vi.runAllTimersAsync();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keys a hand-off by its page and video, and keeps windows and containers apart', () => {
    const key = bufferKey(where);
    expect(bufferKey({...where})).toBe(key);
    // Another page (another video on one address: hls.php?v=1, ?v=2), another source.
    expect(bufferKey({...where, pageUrl: 'https://site.test/watch/2'})).not.toBe(key);
    expect(bufferKey({...where, identifier: 'https://cdn.test/w/master.m3u8'})).not.toBe(key);
    // A private window's buffer is RAM only; an ordinary window's player would put it on disk.
    expect(bufferKey({...where, incognito: true})).not.toBe(key);
    expect(bufferKey({...where, cookieStoreId: 'firefox-container-1'})).not.toBe(key);
  });
});
