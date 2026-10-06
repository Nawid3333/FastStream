import {afterEach, describe, expect, it, vi} from 'vitest';

import {WebUtils} from '../../chrome/player/utils/WebUtils.mjs';
import {fakeDocument} from './fakeCueDom.mjs';

/**
 * A stand-in element with the given children.
 * @param {...Object} children - Its children.
 * @return {Object}
 */
function parentOf(...children) {
  const parent = fakeDocument.createElement('div');
  children.forEach((child) => parent.appendChild(child));
  return parent;
}

const div = (name) => {
  const element = fakeDocument.createElement('div');
  element.name = name;
  return element;
};
const names = (parent) => parent.children.map((child) => child.name);

describe('replaceChildrenPerformant', () => {
  it('puts the children in the order given, not the new ones last', () => {
    // A subtitle cue that came back on screen (a seek back into two overlapping cues) was
    // appended below the cue that started after it, and the two lines swapped places.
    const [a, b] = [div('a'), div('b')];
    const parent = parentOf(b);
    WebUtils.replaceChildrenPerformant(parent, [a, b]);
    expect(names(parent)).toEqual(['a', 'b']);

    const c = div('c');
    WebUtils.replaceChildrenPerformant(parent, [c, b, a]);
    expect(names(parent)).toEqual(['c', 'b', 'a']);
  });

  it('removes the children not given', () => {
    const [a, b, c] = [div('a'), div('b'), div('c')];
    const parent = parentOf(a, b, c);
    WebUtils.replaceChildrenPerformant(parent, [b]);
    expect(names(parent)).toEqual(['b']);
    WebUtils.replaceChildrenPerformant(parent, []);
    expect(names(parent)).toEqual([]);
  });

  it('moves nothing when the children are already the ones given, in order', () => {
    const [a, b] = [div('a'), div('b')];
    const parent = parentOf(a, b);
    let moves = 0;
    const {insertBefore, removeChild} = parent;
    parent.insertBefore = (...args) => {
      moves++;
      return insertBefore.apply(parent, args);
    };
    parent.removeChild = (...args) => {
      moves++;
      return removeChild.apply(parent, args);
    };
    WebUtils.replaceChildrenPerformant(parent, [a, b]);
    expect(moves).toBe(0);
    expect(names(parent)).toEqual(['a', 'b']);
  });
});

describe('copyText', () => {
  // The copy-link buttons copied with a selected input and document.execCommand('copy'),
  // which browsers deprecate; since 2026-10-06 navigator.clipboard, the old way kept for
  // where it refuses (no secure context or no click to answer: the web build on http).
  const fallback = () => {
    const calls = [];
    const input = {value: '', focus: () => calls.push('focus'), select: () => calls.push('select')};
    const container = {
      appendChild: (child) => calls.push(['append', child.value]),
      removeChild: (child) => calls.push(['remove', child.value]),
    };
    vi.stubGlobal('document', {
      createElement: () => input,
      execCommand: (command) => calls.push(['exec', command, input.value]),
    });
    return {calls, container};
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies with navigator.clipboard, and leaves the page alone', async () => {
    const {calls, container} = fallback();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', {clipboard: {writeText}});
    await WebUtils.copyText('https://example.com/v.m3u8', container);
    expect(writeText).toHaveBeenCalledWith('https://example.com/v.m3u8');
    expect(calls).toEqual([]);
  });

  it('copies the old way when navigator.clipboard refuses, or is not there', async () => {
    for (const navigator of [{clipboard: {writeText: async () => {
      throw new DOMException('Clipboard write was blocked', 'NotAllowedError');
    }}}, {}]) {
      const {calls, container} = fallback();
      vi.stubGlobal('navigator', navigator);
      await WebUtils.copyText('https://example.com/v.mp4', container);
      expect(calls).toEqual([
        ['append', 'https://example.com/v.mp4'], 'focus', 'select',
        ['exec', 'copy', 'https://example.com/v.mp4'], ['remove', 'https://example.com/v.mp4'],
      ]);
    }
  });
});
