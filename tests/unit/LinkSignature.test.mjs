import {describe, expect, it} from 'vitest';

import {linkChange, looseLink, signatureParams, withoutSignature} from '../../chrome/player/network/LinkSignature.mjs';

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

describe('linkChange and looseLink', () => {
  /**
   * @param {string} oldStream
   * @param {string} newStream
   * @param {string} oldPart
   * @param {string} newPart
   * @return {boolean} Whether the part under the old link is the one under the new link.
   */
  const same = (oldStream, newStream, oldPart, newPart) => {
    const change = /** @type {*} */ (linkChange(oldStream, newStream));
    return looseLink(oldPart, change, true) === looseLink(newPart, change, false);
  };

  it('a token in the path, in the stream\'s parts too', () => {
    expect(same('https://cdn.test/hls/AAA/master.m3u8', 'https://cdn.test/hls/BBB/master.m3u8',
        'https://cdn.test/hls/AAA/v1/seg-3.ts', 'https://cdn.test/hls/BBB/v1/seg-3.ts')).toBe(true);
    expect(same('https://cdn.test/hls/AAA/master.m3u8', 'https://cdn.test/hls/BBB/master.m3u8',
        'https://cdn.test/hls/AAA/v1/seg-3.ts', 'https://cdn.test/hls/BBB/v1/seg-4.ts')).toBe(false);
  });

  it('another host, with a signature in the query', () => {
    expect(same('https://n1.cdn.test/v/master.m3u8?t=1', 'https://n7.cdn.test/v/master.m3u8?t=2',
        'https://n1.cdn.test/v/seg-3.ts?t=1', 'https://n7.cdn.test/v/seg-3.ts?t=2')).toBe(true);
    // A part on a third host is none of the stream's.
    expect(same('https://n1.cdn.test/v/master.m3u8', 'https://n7.cdn.test/v/master.m3u8',
        'https://n1.cdn.test/v/seg-3.ts', 'https://img.test/v/seg-3.ts')).toBe(false);
  });

  it('a file whose whole link changed stands for itself; the same place is a query change only', () => {
    const change = /** @type {*} */ (linkChange('https://a.test/x1/m~1.mp4?e=1', 'https://b.test/y2/zz/m~2.mp4?e=2'));
    expect(looseLink('https://a.test/x1/m~1.mp4?e=1', change, true)).toBe(looseLink('https://b.test/y2/zz/m~2.mp4?e=2', change, false));
    expect(change.samePlace).toBe(false);
    expect(linkChange('https://a.test/v.mp4?t=1', 'https://a.test/v.mp4?t=2')?.samePlace).toBe(true);
    expect(linkChange('blob:https://a.test/1', 'https://a.test/v.mp4')).toBeNull();
  });

  it('for a query change, the same as withoutSignature', () => {
    const change = /** @type {*} */ (linkChange('https://cdn.test/hls/x/m.m3u8?t=AAA&s=1&e=9', 'https://cdn.test/hls/x/m.m3u8?t=BBB&s=2&e=9'));
    const url = 'https://cdn.test/hls/x/seg-7.ts?t=AAA&s=1&e=9#frag';
    expect(looseLink(url, change, true)).toBe(withoutSignature(url, change.params));
  });
});
