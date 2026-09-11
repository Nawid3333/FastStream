import {describe, expect, it} from 'vitest';
import {RuleManager} from '../../chrome/background/NetRequestRuleManager.mjs';

// getInsertionIndex() is a hand-rolled binary search over this.rules (sorted
// by id) - classic off-by-one territory, and RuleManager's real constructor
// calls chrome.declarativeNetRequest (unavailable outside the extension),
// so it's exercised directly off the prototype against a plain fake `this`
// instead of a real instance.
const insertionIndex = (ids, id) =>
  RuleManager.prototype.getInsertionIndex.call({rules: ids.map((i) => ({id: i}))}, id);

describe('RuleManager.getInsertionIndex', () => {
  it('returns 0 for an empty rule list', () => {
    expect(insertionIndex([], 5)).toBe(0);
  });

  it('inserts before the first element when smaller than everything', () => {
    expect(insertionIndex([10, 20, 30], 5)).toBe(0);
  });

  it('inserts after the last element when larger than everything', () => {
    expect(insertionIndex([10, 20, 30], 35)).toBe(3);
  });

  it('inserts between two adjacent elements', () => {
    expect(insertionIndex([10, 20, 30], 15)).toBe(1);
    expect(insertionIndex([10, 20, 30], 25)).toBe(2);
  });

  it('returns -1 when the id already exists (caller treats this as a conflict)', () => {
    expect(insertionIndex([10, 20, 30], 20)).toBe(-1);
    expect(insertionIndex([10, 20, 30], 10)).toBe(-1);
    expect(insertionIndex([10, 20, 30], 30)).toBe(-1);
  });

  it('finds the correct slot in a larger sorted list, exercising real binary search steps', () => {
    const ids = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    expect(insertionIndex(ids, 0)).toBe(0);
    expect(insertionIndex(ids, 4)).toBe(2);
    expect(insertionIndex(ids, 8)).toBe(4);
    expect(insertionIndex(ids, 12)).toBe(6);
    expect(insertionIndex(ids, 20)).toBe(10);
    // Every existing id in a larger list should still report a conflict.
    ids.forEach((id) => expect(insertionIndex(ids, id)).toBe(-1));
  });

  it('handles a single-element list on both sides', () => {
    expect(insertionIndex([10], 5)).toBe(0);
    expect(insertionIndex([10], 15)).toBe(1);
    expect(insertionIndex([10], 10)).toBe(-1);
  });
});
