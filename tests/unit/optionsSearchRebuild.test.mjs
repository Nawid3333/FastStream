import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The options page rebuilds its search (initsearch) whenever it reloads its options: an
// IntersectionObserver, or a change from another tab. The new instance takes each row's
// current display as the row's own, and one built while a query hid rows took their
// hiding for it: no later search showed them again. options-mpv.e2e.mjs failed that way
// on the Windows CI runner (2026-10-03 and 05): after "fullscreen", "reuse" never showed
// the single-instance row.

// Fuse is copied in by the build (tools/sync-vendor.mjs), and CI runs these tests before
// it: a stand-in that matches by substring, which is all these cases need.
vi.mock('../../chrome/player/modules/fuse.mjs', () => ({
  default: class {
    setCollection(texts) {
      this.texts = texts;
    }
    search(query) {
      return this.texts.flatMap((text, refIndex) => text.toLowerCase().includes(query.toLowerCase()) ? [{refIndex}] : []);
    }
  },
}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

/** A row: a .search-target-remove holding its .search-target-text. */
function row(text) {
  const label = {textContent: text};
  const el = {
    style: {display: ''},
    label,
    getClientRects: () => (el.style.display === 'none' ? [] : [{}]),
    get offsetParent() {
      return el.style.display === 'none' ? null : {};
    },
  };
  return el;
}

let rows;

beforeEach(() => {
  rows = [row('Open videos in fullscreen'), row('Pause the page while mpv plays'), row('Reuse one mpv window')];
  vi.stubGlobal('document', {
    body: {classList: {toggle: () => {}}},
    querySelectorAll: (selector) => ({
      '.search-target-remove': rows,
      '.search-target-text': rows.map((r) => r.label),
    })[selector] || [],
  });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the options search, rebuilt while a query hides rows', () => {
  it('still shows a row the earlier query hid, when a later query matches it', async () => {
    const {initsearch, searchWithQuery} = await import('../../chrome/player/utils/SearchUtils.mjs');
    initsearch();
    searchWithQuery('fullscreen');
    expect(rows.map((r) => r.style.display)).toEqual(['', 'none', 'none']);

    // The page reloads its options in the middle of the search.
    initsearch();
    searchWithQuery('reuse');
    expect(rows.map((r) => r.style.display)).toEqual(['none', 'none', '']);
  });

  it('shows every row again once the box is emptied', async () => {
    const {initsearch, resetSearch, searchWithQuery} = await import('../../chrome/player/utils/SearchUtils.mjs');
    initsearch();
    searchWithQuery('pause');
    initsearch();
    resetSearch();
    expect(rows.map((r) => r.style.display)).toEqual(['', '', '']);
  });

  it('keeps a row the page hides on its own hidden', async () => {
    rows[1].style.display = 'none';
    const {initsearch, searchWithQuery} = await import('../../chrome/player/utils/SearchUtils.mjs');
    initsearch();
    searchWithQuery('mpv');
    initsearch();
    expect(rows.map((r) => r.style.display)).toEqual(['', 'none', '']);
  });
});
