import {describe, expect, it} from 'vitest';
import {MpvBackend} from '../../chrome/background/MpvBackend.mjs';

// The header filter decides which request headers are relayed to mpv.
// Deliberately narrow: only Referer/Origin, because CDN checks use those,
// and forwarding cookies or auth headers to an external process would leak
// credentials out of the browser.

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

  it('drops everything else, including cookies and auth', () => {
    const headers = [
      {name: 'Cookie', value: 'session=secret'},
      {name: 'Authorization', value: 'Bearer token'},
      {name: 'User-Agent', value: 'Mozilla/5.0'},
      {name: 'Accept', value: '*/*'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toBeUndefined();
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
