import {expect, it, vi} from 'vitest';

// The Sources browser marks a source's Play button "Loading..." while the player is set up
// with it, and a click on a button so marked does nothing. The list is drawn again at every
// edit of any row (a character typed in another source's address), which took the mark away:
// a second click then set the source up a second time (glm's review, 2026-11-16).

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

const {SourcesBrowser} = await import('../../chrome/player/ui/SourcesBrowser.mjs');

/** A row's element, as much as updateSources reads. */
function element() {
  const classes = new Set();
  return {
    textContent: '',
    classList: {add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name)},
  };
}

it('keeps a source being set up marked as loading when the list is drawn again', () => {
  const browser = Object.create(SourcesBrowser.prototype);
  const listed = (url, loading) => ({url, loading, equals: () => false,
    sourceBrowserElements: {container: element(), setBtn: element()}});
  const loading = listed('https://cdn.test/a.m3u8', true);
  const other = listed('https://cdn.test/b.m3u8', false);
  loading.sourceBrowserElements.setBtn.classList.add('loading');
  loading.sourceBrowserElements.setBtn.textContent = 'player_source_playbtn_loading';
  Object.assign(browser, {sources: [loading, other], client: {source: null}, linkui: {sourcesFound: element()}});

  browser.updateSources();
  expect(loading.sourceBrowserElements.setBtn.classList.contains('loading')).toBe(true);
  expect(loading.sourceBrowserElements.setBtn.textContent).toBe('player_source_playbtn_loading');
  expect(other.sourceBrowserElements.setBtn.textContent).toBe('player_source_playbtn');
  expect(browser.linkui.sourcesFound.textContent).toBe('player_source_multilisted');
});
