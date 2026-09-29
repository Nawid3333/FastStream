import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RuleManager} from '../../chrome/background/NetRequestRuleManager.mjs';

// The header rule's urlFilter is the request URL minus its scheme, as is.
// declarativeNetRequest's urlFilter has no escape character, so "escaping" a
// `*` as `\*` made the rule require a backslash that no URL contains, and
// streams whose URL has a `*` (Akamai `acl=/*` tokens) lost their
// Referer/Origin. tests/e2e/ext-specs/header-rules.e2e.mjs proves the same on
// Firefox's real rule engine.
describe('RuleManager.addHeaderRule', () => {
  let added;

  beforeEach(() => {
    vi.useFakeTimers();
    added = [];
    globalThis.chrome = {
      declarativeNetRequest: {
        getSessionRules: async () => [],
        updateSessionRules: async (update) => {
          added.push(...(update.addRules || []));
        },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.chrome;
  });

  it.each([
    ['https://cdn.test/hls/master.m3u8', 'cdn.test/hls/master.m3u8'],
    ['http://cdn.test/v.mp4?acl=/*~hmac=1f', 'cdn.test/v.mp4?acl=/*~hmac=1f'],
    ['https://cdn.test/s/v.mpd?a=b^1|c', 'cdn.test/s/v.mpd?a=b^1|c'],
    ['http://cdn.test/r?u=https://x.test/v.mp4', 'cdn.test/r?u=https://x.test/v.mp4'],
    // As the browser requests it: an accent or a space goes out percent-encoded, and
    // Firefox refuses a urlFilter that is not ASCII. (A `^` in the path too, but Node
    // encodes that only from some version on: the e2e spec checks it on Firefox.)
    ['https://cdn.test/vidéo 1.mp4?q=é x', 'cdn.test/vid%C3%A9o%201.mp4?q=%C3%A9%20x'],
  ])('matches %s by the URL itself, with nothing escaped', async (url, rest) => {
    const manager = new RuleManager();
    const commands = [{operation: 'set', header: 'referer', value: 'https://site.test/'}];
    await manager.addHeaderRule(url, 7, commands);

    expect(added).toHaveLength(1);
    expect(added[0].condition).toEqual({urlFilter: '||' + rest, tabIds: [7]});
    expect(added[0].condition.urlFilter.includes(String.fromCharCode(92))).toBe(false);
    expect(added[0].action.requestHeaders).toEqual(commands);
  });
});

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
