import {describe, expect, it} from 'vitest';

import {signatureParams, withoutSignature} from '../../chrome/player/network/LinkSignature.mjs';

// A link issued anew (a reload, a fresh link) carries a new signature, and so does every file
// of the video: the same file is found under either issue with the signature left out.

describe('signatureParams', () => {
  it('names the parameters whose values a new issue of the link changed', () => {
    // vidmoly's: a new token and issue time at every load of its page, the same lifetime.
    const sig = signatureParams('https://cdn.test/hls/x/master.m3u8?t=AAA&s=100&e=43200',
        'https://cdn.test/hls/x/master.m3u8?t=BBB&s=200&e=43200');
    expect([...sig].sort()).toEqual(['s', 't']);
  });

  it('counts a parameter only one of them has', () => {
    const sig = signatureParams('https://cdn.test/v.mp4?a=1', 'https://cdn.test/v.mp4?a=1&exp=9');
    expect([...sig]).toEqual(['exp']);
  });

  it('is empty for the same link, and null for another one', () => {
    expect(signatureParams('https://cdn.test/v.mp4?a=1', 'https://cdn.test/v.mp4?a=1').size).toBe(0);
    expect(signatureParams('https://cdn.test/a.mp4?t=1', 'https://cdn.test/b.mp4?t=2')).toBeNull();
    expect(signatureParams('https://cdn1.test/a.mp4?t=1', 'https://cdn2.test/a.mp4?t=2')).toBeNull();
    expect(signatureParams('not a url', 'https://cdn.test/a.mp4')).toBeNull();
  });

  it('tells repeated parameters apart by their values and their number', () => {
    expect([...signatureParams('https://c.test/a?x=1&x=2', 'https://c.test/a?x=1&x=3')]).toEqual(['x']);
    expect([...signatureParams('https://c.test/a?x=1', 'https://c.test/a?x=1&x=1')]).toEqual(['x']);
  });
});

describe('withoutSignature', () => {
  const sig = new Set(['t', 's']);

  it('gives a file the same address under either issue of the link', () => {
    expect(withoutSignature('https://cdn.test/hls/x/seg-7-v1.ts?t=AAA&s=100&e=43200', sig))
        .toBe(withoutSignature('https://cdn.test/hls/x/seg-7-v1.ts?t=BBB&s=200&e=43200', sig));
  });

  it('keeps what tells two files apart: a parameter that did not change', () => {
    expect(withoutSignature('https://cdn.test/seg.ts?n=5&t=AAA', sig))
        .not.toBe(withoutSignature('https://cdn.test/seg.ts?n=6&t=BBB', sig));
  });

  it('leaves an address whole for no signature, and one it cannot read', () => {
    const url = 'https://cdn.test/seg.ts?t=AAA';
    expect(withoutSignature(url, new Set())).toBe(url);
    expect(withoutSignature(url, null)).toBe(url);
    expect(withoutSignature('not a url', sig)).toBe('not a url');
  });
});
