import {describe, expect, it} from 'vitest';
import {loadPage} from './helpers/fakeDom.mjs';

// The options page's search box (SearchUtils.mjs) matches the .search-target-text
// elements and hides the .search-target-remove ones, pairing the two lists by position
// on the page; a section with data-search-section is hidden when none of its items is
// left. Five sections had no data-search-section: a search hid single rows inside the MPV
// section but left its heading, text and allowlist, and never hid the other four, so
// "zoom" showed the zoom row followed by four unrelated sections (#278).

const doc = loadPage('chrome/player/options/index.html');
const removes = doc.querySelectorAll('.search-target-remove');
const texts = doc.querySelectorAll('.search-target-text');
const sectionOf = (el) => {
  let node = el;
  while (node && !node.classList.contains('options-section')) node = node.parentNode;
  return node;
};
const contains = (outer, inner) => {
  for (let node = inner; node; node = node.parentNode) {
    if (node === outer) return true;
  }
  return false;
};

describe('the options page\'s search markup', () => {
  it('lets the search hide every section', () => {
    const sections = doc.querySelectorAll('section');
    expect(sections.length).toBe(8);
    const unsearchable = sections.filter((section) => !section.hasAttribute('data-search-section'));
    expect(unsearchable.map((section) => section.querySelector('h1').dataset.i18n)).toEqual([]);
  });

  it('gives every section something a search can find, and a match count', () => {
    for (const section of doc.querySelectorAll('[data-search-section]')) {
      const name = section.dataset.searchSection;
      expect(section.querySelectorAll('.search-target-remove').length, name).toBeGreaterThan(0);
      expect(section.querySelector('.section-count'), name).not.toBe(null);
    }
  });

  it('pairs each text the search matches with the element it hides', () => {
    expect(texts.length).toBe(removes.length);
    removes.forEach((remove, i) => {
      const text = texts[i];
      const label = text.dataset.i18n;
      expect(sectionOf(text), label).toBe(sectionOf(remove));
      // The text is inside what it hides, or it is the section's heading.
      const heading = text.parentNode.classList.contains('section-heading');
      expect(contains(remove, text) || heading, label).toBe(true);
    });
  });

  it('hides the MPV allowlist and the connection test along with their rows', () => {
    const owner = (id) => removes.find((remove) => contains(remove, doc.getElementById(id)));
    expect(owner('mpvAllowlist')).toBeTruthy();
    expect(owner('mpvtestresult')).toBe(owner('mpvtest'));
    expect(owner('autoEnableURLs')).toBeTruthy();
    expect(owner('customSourcePatterns')).toBeTruthy();
  });
});
