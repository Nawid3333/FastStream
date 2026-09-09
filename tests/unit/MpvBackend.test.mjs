import {afterEach, describe, expect, it, vi} from 'vitest';
import {MpvBackend} from '../../chrome/background/MpvBackend.mjs';

// The header filter decides which request headers are relayed to mpv.
// Deliberately narrow: only Referer/Origin (CDN checks use those) and
// User-Agent (mpv would otherwise identify itself as "libmpv", which UA-gated
// CDNs reject). Forwarding cookies or auth headers to an external process
// would leak credentials out of the browser.

describe('pickRelayHeaders', () => {
  it('returns undefined for a missing header list', () => {
    expect(MpvBackend.pickRelayHeaders(undefined)).toBeUndefined();
    expect(MpvBackend.pickRelayHeaders(null)).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(MpvBackend.pickRelayHeaders([])).toBeUndefined();
  });

  it('keeps Referer and Origin, case-insensitively', () => {
    const headers = [
      {name: 'Referer', value: 'https://example.com/page'},
      {name: 'Origin', value: 'https://example.com'},
    ];
    const picked = MpvBackend.pickRelayHeaders(headers);
    expect(picked).toHaveLength(2);
  });

  it('keeps lowercase variants', () => {
    const headers = [
      {name: 'referer', value: 'https://example.com/page'},
      {name: 'origin', value: 'https://example.com'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toHaveLength(2);
  });

  it('keeps User-Agent so CDNs do not see libmpv', () => {
    const headers = [
      {name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
    ]);
  });

  it('drops everything else, including cookies and auth', () => {
    const headers = [
      {name: 'Cookie', value: 'session=secret'},
      {name: 'Authorization', value: 'Bearer token'},
      {name: 'Accept', value: '*/*'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toBeUndefined();
  });

  it('keeps a comma in a value: the host appends headers one at a time', () => {
    const headers = [
      {name: 'Referer', value: 'https://example.com/?list=a,b'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'Referer', value: 'https://example.com/?list=a,b'},
    ]);
  });

  it('keeps only the first value when a header repeats', () => {
    const headers = [
      {name: 'Referer', value: 'https://example.com/first'},
      {name: 'referer', value: 'https://example.com/second'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'Referer', value: 'https://example.com/first'},
    ]);
  });

  it('keeps relayed headers and drops others in a mixed list', () => {
    const headers = [
      {name: 'Host', value: 'cdn.example.com'},
      {name: 'Referer', value: 'https://example.com/'},
      {name: 'Cookie', value: 'session=secret'},
    ];
    const picked = MpvBackend.pickRelayHeaders(headers);
    expect(picked).toEqual([{name: 'Referer', value: 'https://example.com/'}]);
  });

  it('drops headers with empty names or values', () => {
    const headers = [
      {name: '', value: 'https://example.com/'},
      {name: 'Origin', value: ''},
      {name: 'Origin', value: 'https://example.com'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'Origin', value: 'https://example.com'},
    ]);
  });
});

// openStream records every URL it hands to the host so a page that reports the
// same source twice does not open two windows. That record must not survive a
// failed launch: the user fixes the cause (installs mpv, corrects the path)
// and retries the very same video, and a stale entry would make the retry
// report success while nothing plays.

/**
 * Installs a fake chrome.runtime whose sendNativeMessage replies with a fixed
 * response, and reports how many times it was called.
 * @param {Object|null} response - Reply handed to the callback.
 * @param {Object} [lastError] - chrome.runtime.lastError to simulate.
 * @return {{calls: () => number}} Call counter.
 */
function stubNativeHost(response, lastError) {
  let calls = 0;
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(name, message, callback) {
        calls++;
        globalThis.chrome.runtime.lastError = lastError;
        callback(response);
        globalThis.chrome.runtime.lastError = undefined;
      },
    },
  };
  return {calls: () => calls};
}

describe('openStream retry bookkeeping', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  it('does not resend a URL the host already accepted', async () => {
    const host = stubNativeHost({ok: true});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    expect(await backend.openStream('https://cdn/a.m3u8', tab)).toEqual({ok: true});
    expect(await backend.openStream('https://cdn/a.m3u8', tab)).toEqual({ok: true});
    expect(host.calls()).toBe(1);
  });

  it('lets the same URL be retried after the host reports a launch failure', async () => {
    const host = stubNativeHost({ok: false, error: 'mpv executable not found'});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    const first = await backend.openStream('https://cdn/a.m3u8', tab);
    expect(first.ok).toBe(false);
    expect(tab.mpvSentUrls.has('https://cdn/a.m3u8')).toBe(false);

    const second = await backend.openStream('https://cdn/a.m3u8', tab);
    expect(second.ok).toBe(false);
    expect(host.calls()).toBe(2);
  });

  it('lets the same URL be retried when the host is not installed', async () => {
    const host = stubNativeHost(undefined, {message: 'no such native application'});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    await backend.openStream('https://cdn/a.m3u8', tab);
    await backend.openStream('https://cdn/a.m3u8', tab);
    expect(host.calls()).toBe(2);
  });
});
