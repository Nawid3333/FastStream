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
      runtime: {
        getURL: (path) => 'moz-extension://0f3e2c1a-uuid-of-the-extension' + path,
      },
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
    expect(added[0].condition).toEqual({
      urlFilter: '||' + rest,
      tabIds: [7],
      initiatorDomains: ['0f3e2c1a-uuid-of-the-extension'],
    });
    expect(added[0].condition.urlFilter.includes(String.fromCharCode(92))).toBe(false);
    expect(added[0].action.requestHeaders).toEqual(commands);
  });

  // The rule is for one tab, and a player's tab is the page's tab: without the initiator
  // condition, the page's own requests to that URL got the player's headers for 5 s. A
  // page that framed the player could then send its requests to another site with a
  // made-up Origin (past Origin-based CSRF checks) or Cookie.
  it('applies only to the extension\'s own requests, not the page\'s in the same tab', async () => {
    const manager = new RuleManager();
    await manager.addHeaderRule('https://bank.test/transfer', 7, [{operation: 'set', header: 'origin', value: 'https://bank.test'}]);
    expect(added[0].condition.initiatorDomains).toEqual(['0f3e2c1a-uuid-of-the-extension']);
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

// Both of RuleManager's background promises went unhandled: the clearing of old rules at
// start, and the removal of expired ones each second. A refused removal also took the rule
// out of the list, so its id went to the next rule while the browser still held the old
// one, and that rule was refused as a duplicate.
describe('RuleManager when the browser refuses', () => {
  let warn;
  let refuseRemovals;
  let removed;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    refuseRemovals = 0;
    removed = [];
    globalThis.chrome = {
      runtime: {getURL: (path) => 'moz-extension://test-uuid' + path},
      declarativeNetRequest: {
        getSessionRules: async () => [],
        updateSessionRules: async (update) => {
          const ids = update.removeRuleIds || [];
          if (ids.length > 0) {
            if (refuseRemovals > 0) {
              refuseRemovals--;
              throw new Error('refused');
            }
            removed.push(...ids);
          }
        },
      },
    };
  });

  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
    delete globalThis.chrome;
  });

  it('says so when the rules left from before cannot be cleared', async () => {
    globalThis.chrome.declarativeNetRequest.getSessionRules = async () => {
      throw new Error('not now');
    };
    new RuleManager();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith('Could not clear the header rules left from before', expect.any(Error));
  });

  it('keeps an expired rule it could not remove, and removes it on the next round', async () => {
    const manager = new RuleManager();
    const rule = await manager.addHeaderRule('https://cdn.test/a.m3u8', 7, [{operation: 'set', header: 'referer', value: 'https://site.test/'}]);
    refuseRemovals = 1;
    // It expires after 5 s; the round after that is refused.
    await vi.advanceTimersByTimeAsync(6000);
    expect(removed).toEqual([]);
    expect(warn).toHaveBeenCalledWith('Could not remove expired header rules', expect.any(Error));
    expect(manager.getNextID()).not.toBe(rule.id);

    await vi.advanceTimersByTimeAsync(1000);
    expect(removed).toEqual([rule.id]);
    expect(manager.rules).toEqual([]);
  });

  it('gives a rule up after three refused removals', async () => {
    const manager = new RuleManager();
    const rule = await manager.addHeaderRule('https://cdn.test/a.m3u8', 7, [{operation: 'set', header: 'referer', value: 'https://site.test/'}]);
    refuseRemovals = 100;
    await vi.advanceTimersByTimeAsync(20000);
    expect(manager.rules).toEqual([]);
    expect(manager.isLoopRunning).toBe(false);
    expect(manager.getNextID()).toBe(rule.id);
  });
});
