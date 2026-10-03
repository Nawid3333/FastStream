import {describe, expect, it} from 'vitest';

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
