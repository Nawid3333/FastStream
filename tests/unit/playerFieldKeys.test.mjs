import fs from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// Keys in the player's fields and menus, on stand-in elements (the review of 2026-11-13):
// - Escape did nothing from a field. The loop menu, the subtitle settings, the subtitle
//   search (its fields and its page number) and the sources browser's fields kept every key
//   from the player, so the player's Escape (escapeAll: menus, windows, fullscreen) never
//   heard it: the subtitle search could not be closed from its own field. And the player
//   heard Escape only inside itself: with the focus on <body> (leaving the control bar blurs
//   its control) a menu opened by a click stayed open. The full presses are in
//   tests/e2e/specs/player-a11y.e2e.mjs.
// - The pointer took the focus out of a field. A dropdown (the sources browser's mode, beside
//   its address) and a subtitle track's row take the focus when the pointer comes over them:
//   passing over one while typing an address ended the typing there (the field's change ran
//   on half an address), and the next letters went to the player's shortcuts (F fullscreen,
//   D speed, Space play) or to the row's own keys (D saves the track).

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {getSelection: () => ({selectAllChildren() {}, removeAllRanges() {}})});
// A text node, as the dropdown's label has: an element that matches no selector here.
doc.createTextNode = (text) => Object.assign(doc.createElement('#text'), {textContent: text});
const el = (tag = 'div') => doc.body.appendChild(doc.createElement(tag));
globalThis.__fieldKeysDom = {playerContainer: el()};

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__fieldKeysDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => ({InterfaceUtils: {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
// It imports coloris.mjs, which the build generates: not there when CI runs the unit tests.
vi.mock('../../chrome/player/ui/subtitles/SubtitlesSettingsManager.mjs', () => ({SubtitlesSettingsManager: class {}, SubtitlesSettingsManagerEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs', () => ({SubtitleSyncer: class {}}));

const {WebUtils} = await import('../../chrome/player/utils/WebUtils.mjs');
vi.spyOn(WebUtils, 'createSVGIcon').mockImplementation(() => document.createElement('svg'));
const {SubtitlesManager} = await import('../../chrome/player/ui/subtitles/SubtitlesManager.mjs');
const {OpenSubtitlesSearch} = await import('../../chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs');
const {SourcesBrowser} = await import('../../chrome/player/ui/SourcesBrowser.mjs');
const {createPagesBar} = await import('../../chrome/player/ui/components/PagesBar.mjs');
const {VideoSource} = await import('../../chrome/player/VideoSource.mjs');
const {PlayerModes} = await import('../../chrome/player/enums/PlayerModes.mjs');

// JSDoc casts (`/** @type {T} */ (x)`, for the type checker) are no code: read without them.
const withoutCasts = (text) => text.replace(/\/\*\* @type \{[^}]*\} \*\/ \(([^()]*)\)/g, '$1');
const read = (file) => withoutCasts(fs.readFileSync(new URL(`../../chrome/player/${file}`, import.meta.url), 'utf8'));

describe('Escape in the player\'s fields and menus', () => {
  /**
   * Each place that keeps the keys typed in it from the player, with the element its
   * listener is on.
   * @return {Array<[string, Object]>}
   */
  const places = () => {
    const search = {subui: {searchContainer: el(), search: {blur() {}}}, startSearch() {}};
    const searchField = OpenSubtitlesSearch.prototype.createInput.call(search, 'search', 'player_opensubtitles_searchbox');
    const browser = {linkui: {sourcesList: el()}, updateSources() {}, client: {}};
    const source = new VideoSource('', null, PlayerModes.AUTO);
    SourcesBrowser.prototype.setupSourceListing.call(browser, source);
    const pages = createPagesBar(3, 10, () => {});
    return [
      ['the subtitle search\'s field', searchField],
      ['the subtitle search\'s page number', pages.querySelector('.selected')],
      ['the sources browser\'s address', source.sourceBrowserElements.url],
      ['the sources browser\'s headers', browser.linkui.sourcesList.querySelector('.linkui-source-headers')],
    ];
  };

  it('goes on to the player, which closes them; every other key stays theirs', () => {
    for (const [name, element] of places()) {
      expect(element, name).toBeTruthy();
      expect(element.fire('keydown', {key: 'Escape'}).propagationStopped, name).toBe(false);
      // Typed there: not the player's fullscreen key.
      expect(element.fire('keydown', {key: 'f'}).propagationStopped, name).toBe(true);
    }
  });

  it('goes on to the player from the loop menu and the subtitle settings too', () => {
    // Read from the source: both import a library the build generates (gif.mjs,
    // coloris.mjs), which is not there when CI runs the unit tests.
    for (const [file, menu] of [['ui/menus/LoopMenu.mjs', 'loopMenu'], ['ui/subtitles/SubtitlesSettingsManager.mjs', 'subtitlesOptionsList']]) {
      const listener = `DOMElements.${menu}.addEventListener('keydown', (e) => {`;
      const source = read(file);
      expect(source, file).toContain(listener);
      // The listener's statements, its comments left out: the Escape test, then its end.
      const body = source.slice(source.indexOf(listener) + listener.length).split('\n')
          .map((line) => line.trim()).filter((line) => line && !line.startsWith('//'));
      expect(body.slice(0, 2), file).toEqual(['if (e.key !== \'Escape\') e.stopPropagation();', '});']);
    }
  });

  it('is heard on the document, as the keybinds are, not only inside the player', () => {
    const client = read('FastStreamClient.mjs');
    expect(client).toMatch(/\n {4}document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Escape'\) \{\s*this\.escapeAll\(\);/);
    // Once: not on the player as well.
    expect(client.match(/this\.escapeAll\(\)/g)).toHaveLength(1);
  });
});

describe('the pointer over a dropdown or a subtitle track', () => {
  it('leaves the focus in the field being typed in', () => {
    const browser = {linkui: {sourcesList: el()}, updateSources() {}, client: {}};
    const source = new VideoSource('', null, PlayerModes.AUTO);
    SourcesBrowser.prototype.setupSourceListing.call(browser, source);
    const {url, mode} = source.sourceBrowserElements;
    const {trackElement} = SubtitlesManager.prototype.createTrackEntryElements.call({}, 0);
    for (const [name, hovered] of [['the mode dropdown', mode], ['a subtitle track', trackElement]]) {
      url.focus();
      hovered.fire('mouseenter');
      expect(doc.activeElement, name).toBe(url);
      hovered.fire('mouseleave');
      expect(doc.activeElement, name).toBe(url);
    }
  });

  it('still takes the focus otherwise, for the keys of its own', () => {
    // The dropdown's arrows and Enter, the row's Delete and brackets, under the pointer.
    const browser = {linkui: {sourcesList: el()}, updateSources() {}, client: {}};
    const source = new VideoSource('', null, PlayerModes.AUTO);
    SourcesBrowser.prototype.setupSourceListing.call(browser, source);
    const {mode} = source.sourceBrowserElements;
    const {trackElement} = SubtitlesManager.prototype.createTrackEntryElements.call({}, 0);
    for (const hovered of [mode, trackElement]) {
      doc.body.focus();
      hovered.fire('mouseenter');
      expect(doc.activeElement).toBe(hovered);
      hovered.fire('mouseleave');
      expect(doc.activeElement).toBe(doc.body);
    }
  });
});
