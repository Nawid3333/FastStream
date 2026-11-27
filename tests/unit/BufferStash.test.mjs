import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {BufferKeepMs, BufferStash, LendMs, bufferKey, nearKey} from '../../chrome/background/BufferStash.mjs';

// A player that goes away hands its buffer to the background for the next player of the same video;
// unclaimed after 20 s it is flushed.

const handOff = (session = 'fsblob-1-1') => ({url: 'https://cdn.test/v/master.m3u8?t=A', session, entries: [{url: 'x'}]});
const where = {pageUrl: 'https://site.test/watch/1', identifier: 'https://cdn.test/v/master.m3u8', incognito: false, cookieStoreId: null};

describe('BufferStash', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a hand-off for 20 s, for the next player to take back', async () => {
    expect(BufferKeepMs).toBe(20000);
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    const key = bufferKey(where);
    const kept = handOff();
    stash.put(key, kept);
    vi.advanceTimersByTime(19000);
    expect(await stash.take(key)).toBe(kept);
    // Taken: its taker owns its files now, and nothing is flushed later.
    expect(await stash.take(key)).toBeNull();
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
    expect(await stash.take(key)).toBeNull();
    expect(dropSession).toHaveBeenCalledExactlyOnceWith('fsblob-9-9');
  });

  // reload-keeps-buffer.e2e on CI: the directory was still there at 22 s, as if the 20 s had never come.
  it('flushes at its timer while the wall clock is behind it, as a clock being corrected is', async () => {
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    const key = bufferKey(where);
    stash.put(key, handOff('fsblob-9-9'));
    vi.setSystemTime(Date.now() - 50);
    await vi.advanceTimersByTimeAsync(BufferKeepMs);
    expect(stash.size).toBe(0);
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

// The hoster's frame or the stream's link came anew in another form: its own key finds nothing, and the tab's page
// does. Under another link it is only lent: the taker checks the data (DownloadManager.adopt) and says whose it is.
describe('BufferStash.lendNear', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const top = {topUrl: 'https://series.example/show/episode-1', incognito: false, cookieStoreId: null};
  const TO = '1/5';

  it('lends a buffer handed over in the same tab page; the taker\'s "same video" gives it away for good', async () => {
    const stash = new BufferStash();
    const kept = handOff();
    stash.put(bufferKey(where), kept, 60000, {near: nearKey(top)});
    expect(await stash.take(bufferKey({...where, pageUrl: 'https://hoster.example/e/1?t=2'}))).toBeNull();
    const lent = await stash.lendNear(nearKey(top), 'https://cdn.test/v2/master.m3u8', TO);
    expect(lent.handOff).toBe(kept);
    expect(lent.lent).toEqual(expect.any(Number));
    // Out of the stash while lent.
    expect(await stash.lendNear(nearKey(top), 'https://cdn.test/v2/master.m3u8', TO)).toBeNull();
    expect(await stash.take(bufferKey(where))).toBeNull();
    // Only its taker ends the lend.
    expect(stash.endLend(lent.lent, true, '2/5')).toBe(false);
    expect(stash.endLend(lent.lent, true, TO)).toBe(true);
    expect(stash.endLend(lent.lent, false, TO)).toBe(false);
    vi.advanceTimersByTime(120000);
    expect(await stash.take(bufferKey(where))).toBeNull();
  });

  it('has it back for its own video when the taker found another\'s, for the rest of its time', async () => {
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    const kept = handOff();
    stash.put(bufferKey(where), kept, 60000, {near: nearKey(top)});
    const {lent} = await stash.lendNear(nearKey(top), 'https://cdn.test/v2/master.m3u8', TO);
    vi.advanceTimersByTime(10000);
    expect(stash.endLend(lent, false, TO)).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(await stash.take(bufferKey(where))).toBe(kept);
    expect(dropSession).not.toHaveBeenCalled();
  });

  it('lets it go when its time ends while lent, its taker never saying', async () => {
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    stash.put(bufferKey(where), handOff('fsblob-7-7'), 60000, {near: nearKey(top)});
    await stash.lendNear(nearKey(top), 'https://cdn.test/v2/master.m3u8', TO);
    vi.advanceTimersByTime(LendMs);
    expect(await stash.take(bufferKey(where))).toBeNull();
    await vi.runAllTimersAsync();
    expect(dropSession).toHaveBeenCalledExactlyOnceWith('fsblob-7-7');
  });

  it('lets the lent one go when a newer one of its video came meanwhile', async () => {
    const dropSession = vi.fn();
    const stash = new BufferStash({dropSession});
    stash.put(bufferKey(where), handOff('fsblob-1-1'), 60000, {near: nearKey(top)});
    const {lent} = await stash.lendNear(nearKey(top), 'https://cdn.test/v2/master.m3u8', TO);
    const newer = handOff('fsblob-2-2');
    stash.put(bufferKey(where), newer, 60000, {near: nearKey(top)});
    stash.endLend(lent, false, TO);
    await vi.advanceTimersByTimeAsync(0);
    expect(dropSession).toHaveBeenCalledExactlyOnceWith('fsblob-1-1');
    expect(await stash.take(bufferKey(where))).toBe(newer);
  });

  it('gives one under the very link away at once: no check', async () => {
    const stash = new BufferStash();
    const kept = handOff();
    stash.put(bufferKey(where), kept, 60000, {near: nearKey(top)});
    expect(await stash.lendNear(nearKey(top), kept.url, TO)).toEqual({handOff: kept, lent: null});
    expect(await stash.take(bufferKey(where))).toBeNull();
  });

  it('not from another page, window kind or container', async () => {
    const stash = new BufferStash();
    stash.put(bufferKey(where), handOff(), 60000, {near: nearKey(top)});
    stash.put(bufferKey({...where, identifier: 'b'}), handOff('fsblob-2-1'), 60000);
    expect(await stash.lendNear(nearKey({...top, topUrl: 'https://series.example/show/episode-2'}), 'https://cdn.test/v/m.m3u8', TO))
        .toBeNull();
    expect(await stash.lendNear(nearKey({...top, incognito: true}), 'https://cdn.test/v/m.m3u8', TO)).toBeNull();
    expect(await stash.lendNear(nearKey({...top, cookieStoreId: 'firefox-container-1'}), 'https://cdn.test/v/m.m3u8', TO))
        .toBeNull();
  });

  it('first one from the same hoster page: back on the first language after another\'s, its own', async () => {
    const stash = new BufferStash();
    const first = {url: 'https://cdn.test/v/t1/master.m3u8', session: 'fsblob-1-1', entries: [{url: 'x'}]};
    const second = {url: 'https://cdn.test/v/t2/master.m3u8', session: 'fsblob-2-1', entries: [{url: 'y'}]};
    const pageA = {...where, pageUrl: 'https://hoster.example/e/sub', identifier: 'https://cdn.test/v/t1/master.m3u8'};
    const pageB = {...where, pageUrl: 'https://hoster.example/e/dub', identifier: 'https://cdn.test/v/t2/master.m3u8'};
    stash.put(bufferKey(pageA), first, 60000, {near: nearKey(top)});
    vi.advanceTimersByTime(1000);
    stash.put(bufferKey(pageB), second, 60000, {near: nearKey(top)});
    const again = bufferKey({...pageA, identifier: 'https://cdn.test/v/t3/master.m3u8'});
    expect((await stash.lendNear(nearKey(top), 'https://cdn.test/v/t3/master.m3u8', TO, again)).handOff).toBe(first);
  });

  it('of two, one whose link looks like the new one first, else the newest', async () => {
    const stash = new BufferStash();
    const file = {url: 'https://files.example/aaa/movie.mp4', session: 'fsblob-1-1', entries: [{url: 'x'}]};
    const hls = {url: 'https://cdn.test/v/t1/master.m3u8', session: 'fsblob-2-1', entries: [{url: 'y'}]};
    stash.put(bufferKey({...where, identifier: 'file'}), file, 60000, {near: nearKey(top)});
    vi.advanceTimersByTime(1000);
    stash.put(bufferKey({...where, identifier: 'hls'}), hls, 60000, {near: nearKey(top)});
    expect((await stash.lendNear(nearKey(top), 'https://files.example/bbb/movie.mp4', TO)).handOff).toBe(file);
    expect((await stash.lendNear(nearKey(top), 'https://other.example/x.mp4', TO)).handOff).toBe(hls);
  });
});
