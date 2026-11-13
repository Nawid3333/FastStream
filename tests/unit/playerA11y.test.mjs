import fs from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// What a keyboard or screen reader user gets from the player's controls (#270):
// - the volume block is a role="slider" with no value a screen reader could read;
// - Tab skipped the big play button;
// - the toolbar buttons had no focus ring of their own.
// And from #277: the pages did not say which language they are in, and the controls
// faded in and out (and the buttons being rearranged shook) whatever the system said.
// And from the review of 2026-11-13: Space did not press a control the keyboard went to, the
// menu buttons did not say whether their menu was open, and the seek bar was no slider. And
// from its second look: Space played or paused the video on the subtitles, quality and
// language buttons, Enter could not open the quality or language list again once a click had
// closed it, the audio list's Enter closed the list instead of choosing, and Space after a
// click on the autoplay switch toggled it again.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {AudioContext: class {}, addEventListener() {}});
const el = () => doc.body.appendChild(doc.createElement('div'));
globalThis.__playerA11yDom = {
  currentVolume: el(), muteBtn: el(), currentVolumeText: el(), volumeBanner: el(), volumeBlock: el(), volumeUnity: el(),
  languageButton: el(), languageMenu: el(), audioTracksBtn: el(), audioSourceList: el(), videoSource: el(), videoSourceList: el(),
  subtitles: el(), subtitlesMenu: el(), subtitlesView: el(), subtitlesOptionsTestButton: el(), subtitlesOptionsBackButton: el(),
  playerContainer: el(),
};
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__playerA11yDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key, subs) => `${key} ${subs}`, getLanguage: () => 'de'}}));
// The subtitles menu's parts; the settings import coloris.mjs, which the build generates.
vi.mock('../../chrome/player/ui/subtitles/SubtitlesSettingsManager.mjs', () => ({SubtitlesSettingsManager: class {}, SubtitlesSettingsManagerEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs', () => ({OpenSubtitlesSearch: class {}, OpenSubtitlesSearchEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs', () => ({SubtitleSyncer: class {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));

const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
vi.spyOn(Utils, 'setConfig').mockResolvedValue();
const {VolumeControls} = await import('../../chrome/player/ui/VolumeControls.mjs');
const {WebUtils} = await import('../../chrome/player/utils/WebUtils.mjs');
const {LanguageChanger} = await import('../../chrome/player/ui/menus/LanguageChanger.mjs');
const {AudioQualityChanger} = await import('../../chrome/player/ui/menus/AudioQualityChanger.mjs');
const {VideoQualityChanger} = await import('../../chrome/player/ui/menus/VideoQualityChanger.mjs');
const {SubtitlesManager} = await import('../../chrome/player/ui/subtitles/SubtitlesManager.mjs');

describe('a control the keyboard went to', () => {
  /**
   * A control set up as the player's are; :focus-visible as Firefox has it (keyboard focus, not a click's).
   * @param {boolean} focusVisible
   */
  const control = (focusVisible) => {
    const element = {tabIndex: -1, role: '', clicks: 0, listeners: /** @type {Record<string, Function>} */ ({}),
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
      click() {
        this.clicks++;
      },
      matches: (selector) => selector === ':focus-visible' && focusVisible};
    WebUtils.setupTabIndex(/** @type {any} */ (element));
    return element;
  };
  const key = (name, extra = {}) => ({key: name, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra});

  it('is a button in the tab order, pressed by Enter and by Space as a <button> is', () => {
    const button = control(true);
    expect(button.tabIndex).toBe(0);
    expect(button.role).toBe('button');
    button.listeners.keydown(key('Enter'));
    const space = key(' ');
    button.listeners.keydown(space);
    expect(button.clicks).toBe(2);
    // Not the player's play/pause too, and no page scroll.
    expect(space.stopPropagation).toHaveBeenCalled();
    expect(space.preventDefault).toHaveBeenCalled();
  });

  it('leaves Space to play/pause after a mouse click, and when held or with a modifier', () => {
    // A control clicked with the mouse keeps the focus, without :focus-visible.
    const clicked = control(false);
    const space = key(' ');
    clicked.listeners.keydown(space);
    expect(clicked.clicks).toBe(0);
    expect(space.stopPropagation).not.toHaveBeenCalled();
    const focused = control(true);
    for (const extra of [{repeat: true}, {ctrlKey: true}, {shiftKey: true}, {altKey: true}, {metaKey: true}]) {
      focused.listeners.keydown(key(' ', extra));
    }
    expect(focused.clicks).toBe(0);
  });

  it('leaves Space to a form control: a space typed in a field, a box ticked once', () => {
    // The options page sets up its fields this way too; a text field always has :focus-visible.
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
      const field = control(true);
      field.tagName = tagName;
      const space = key(' ');
      field.listeners.keydown(space);
      expect(field.clicks).toBe(0);
      expect(space.preventDefault).not.toHaveBeenCalled();
      expect(space.stopPropagation).not.toHaveBeenCalled();
    }
  });
});

describe('the menu buttons, from the keyboard', () => {
  const dom = globalThis.__playerA11yDom;
  // Each as the player sets it up, its list closed (as in the page).
  dom.videoSourceList.style.display = 'none';
  dom.languageMenu.style.display = 'none';
  dom.audioSourceList.style.display = 'none';
  dom.subtitlesMenu.style.display = 'none';
  dom.languageMenu.getElementsByClassName = (name) => dom.languageMenu.querySelectorAll(`.${name}`);
  const quality = new VideoQualityChanger();
  quality.setupUI();
  const language = new LanguageChanger();
  language.setupUI();
  const audio = new AudioQualityChanger();
  audio.enabled = true;
  audio.setupUI();
  const subtitles = Object.assign(Object.create(SubtitlesManager.prototype),
      {settingsManager: {closeUI() {}}, openSubtitlesSearch: {toggleUI: vi.fn()}, emit() {}});
  subtitles.setupUI();
  const buttons = [['quality', quality, dom.videoSource], ['language', language, dom.languageButton],
    ['subtitles', subtitles, dom.subtitles]];
  // :focus-visible as Firefox has it: keyboard focus, not a click's.
  let focusVisible = true;
  for (const [, , button] of buttons) button.matches = (selector) => selector === ':focus-visible' && focusVisible;
  // A key press; the stand-in DOM calls one element's listeners in the order they were added.
  const press = (button, key, extra = {}) => button.fire('keydown', {key, repeat: false, ctrlKey: false, altKey: false,
    metaKey: false, shiftKey: false, ...extra});

  it('are pressed by Space where the keyboard went to them, and leave it to play/pause after a click', () => {
    for (const [name, menu, button] of buttons) {
      focusVisible = true;
      const space = press(button, ' ');
      expect(menu.isOpen(), name).toBe(true);
      expect(space.propagationStopped, name).toBe(true);
      expect(space.defaultPrevented, name).toBe(true);
      press(button, ' ');
      expect(menu.isOpen(), name).toBe(false);
      focusVisible = false;
      const played = press(button, ' ');
      expect(menu.isOpen(), name).toBe(false);
      expect(played.propagationStopped, name).toBe(false);
    }
    focusVisible = true;
  });

  it('open their list again with Enter once a click closed it', () => {
    for (const [name, menu, button] of buttons) {
      button.click();
      expect(menu.isOpen(), name).toBe(true);
      button.click();
      expect(menu.isOpen(), name).toBe(false);
      press(button, 'Enter');
      expect(menu.isOpen(), name).toBe(true);
      menu.closeUI();
    }
    // Shift+Enter is the subtitle search, as a Shift+click.
    press(dom.subtitles, 'Enter', {shiftKey: true});
    expect(subtitles.openSubtitlesSearch.toggleUI).toHaveBeenCalledTimes(1);
    expect(subtitles.isOpen()).toBe(false);
  });

  it('choose the highlighted entry with Enter in an open list, the audio one too', () => {
    const chosen = [];
    for (const [name, list] of [['quality', dom.videoSourceList], ['audio', dom.audioSourceList]]) {
      list.replaceChildren();
      const playing = list.appendChild(doc.createElement('div'));
      playing.classList.add('source_active');
      const other = list.appendChild(doc.createElement('div'));
      other.classList.add('candidate');
      other.addEventListener('click', () => chosen.push(name));
    }
    for (const [name, menu, button] of [['quality', quality, dom.videoSource], ['audio', audio, dom.audioTracksBtn]]) {
      menu.openUI();
      press(button, 'Enter');
      expect(chosen, name).toContain(name);
      // The list stays open, as after a click on the entry.
      expect(menu.isOpen(), name).toBe(true);
      menu.closeUI();
    }
  });

  it('leave a key a listener before them took to it (WebUtils.setupKeyPress)', () => {
    const button = doc.createElement('div');
    button.matches = (selector) => selector === ':focus-visible';
    let pressed = 0;
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
    WebUtils.setupKeyPress(button, () => pressed++);
    press(button, 'Enter');
    expect(pressed).toBe(0);
    press(button, ' ');
    expect(pressed).toBe(1);
  });

  it('include the autoplay switch, whose Space after a click is play/pause again', () => {
    // InterfaceController imports coloris.mjs, which the build generates: read from the source.
    const ui = withoutCasts(fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8'));
    expect(ui).toContain('WebUtils.setupKeyPress(DOMElements.autoplaySwitch);');
    expect(ui).not.toMatch(/autoplaySwitch\.addEventListener\('keydown'/);
  });
});

describe('the menu buttons', () => {
  it('say whether their menu is open', () => {
    const dom = globalThis.__playerA11yDom;
    const menus = [[new LanguageChanger(), dom.languageButton], [new AudioQualityChanger(), dom.audioTracksBtn],
      [new VideoQualityChanger(), dom.videoSource]];
    for (const [menu, button] of menus) {
      menu.openUI();
      expect(button.getAttribute('aria-haspopup')).toBe('true');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      menu.closeUI();
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('start out closed, every one of them, in the page', () => {
    const html = fs.readFileSync(new URL('../../chrome/player/index.html', import.meta.url), 'utf8');
    for (const label of ['player_audiotracks_label', 'player_subtitlesmenu_open_label', 'player_qualitymenu_label',
      'player_languagemenu_label', 'player_playbackrate_label', 'player_loop_label']) {
      expect(html).toContain(`aria-haspopup="true" aria-expanded="false" data-i18n-label="${label}"`);
    }
    // The other three say it in their openUI/closeUI too.
    for (const [file, button] of [['menus/LoopMenu.mjs', 'loopButton'], ['menus/PlaybackRateChanger.mjs', 'playbackRate'],
      ['subtitles/SubtitlesManager.mjs', 'subtitles']]) {
      const source = withoutCasts(fs.readFileSync(new URL(`../../chrome/player/ui/${file}`, import.meta.url), 'utf8'));
      expect(source).toContain(`WebUtils.setExpanded(DOMElements.${button}, true);`);
      expect(source).toContain(`WebUtils.setExpanded(DOMElements.${button}, false);`);
    }
  });
});

describe('the seek bar', () => {
  it('is a named slider in the tab order, its values written with the time\'s text', () => {
    const bar = withoutCasts(fs.readFileSync(new URL('../../chrome/player/ui/ProgressBar.mjs', import.meta.url), 'utf8'));
    expect(bar).toContain('bar.tabIndex = 0;');
    expect(bar).toContain('bar.setAttribute(\'role\', \'slider\');');
    expect(bar).toContain('bar.setAttribute(\'aria-label\', Localize.getMessage(\'player_seekbar_label\'));');
    const ui = withoutCasts(fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8'));
    expect(ui).toMatch(/textContent !== timeText\) \{[^}]*aria-valuenow[^}]*aria-valuetext', timeText\);/);
  });
});

describe('the volume block', () => {
  it('gives a screen reader the slider\'s value and range', () => {
    const block = globalThis.__playerA11yDom.volumeBlock;
    const controls = new VolumeControls({});
    controls.setVolume(1.5);
    expect(block.getAttribute('aria-valuemin')).toBe('0');
    expect(block.getAttribute('aria-valuemax')).toBe('300');
    expect(block.getAttribute('aria-valuenow')).toBe('150');
    expect(block.getAttribute('aria-valuetext')).toBe('150%');
    controls.setVolume(0);
    expect(block.getAttribute('aria-valuenow')).toBe('0');
  });
});

// JSDoc casts (`/** @type {T} */ (x)`, for the type checker) are no code: the checks below
// read the source without them.
const withoutCasts = (text) => text.replace(/\/\*\* @type \{[^}]*\} \*\/ \(([^()]*)\)/g, '$1');

describe('the player\'s buttons', () => {
  const source = withoutCasts(fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8'));
  const css = fs.readFileSync(new URL('../../chrome/player/assets/fluidplayer/css/fluidplayer.css', import.meta.url), 'utf8');

  it('lets the keyboard reach and press the big play button', () => {
    // WebUtils.setupTabIndex puts an element in the tab order and makes Enter click it.
    expect(source).toContain('WebUtils.setupTabIndex(DOMElements.playPauseButtonBigCircle);');
  });

  it('shows where the keyboard is on every kind of button', () => {
    const rule = /([^{}]+)\{[^}]*\boutline:\s*2px solid var\(--menu-text-color\)/.exec(css);
    expect(rule).not.toBe(null);
    const selectors = rule[1].replace(/\/\*[^]*?\*\//g, '').split(',').map((selector) => selector.trim());
    expect(selectors).toEqual(expect.arrayContaining([
      '.fluid_button:focus-visible', '.next_video_button:focus-visible', '.fluid_control_playpause_big_circle:focus-visible',
    ]));
  });
});

describe('the extension\'s pages', () => {
  it('say they are in the UI language', async () => {
    const page = new FakeDocument('<html><body><p data-i18n="player_loading"></p></body></html>');
    vi.stubGlobal('document', page);
    await import('../../chrome/player/i18n.mjs');
    expect(page.documentElement.lang).toBe('de');
    vi.stubGlobal('document', doc);
  });

  it('keep still, for everyone', () => {
    // His wish (2026-10-13): no animations. It was only for those who asked their system for
    // less motion; for everyone else the controls faded in over half a second.
    const css = fs.readFileSync(new URL('../../chrome/player/assets/fluidplayer/css/fluidplayer.css', import.meta.url), 'utf8');
    expect(css).not.toContain('prefers-reduced-motion');
    // At the top level, and with the controls bar's own selector: its `transition: all 0.5s
    // !important` needs one as specific.
    const still = /\n\.fluid_video_wrapper\.fluid_player_layout_default \*,\n\.fluid_video_wrapper\.fluid_player_layout_default \.fluid_controls_container \{([^}]*)\}/.exec(css);
    expect(still).not.toBe(null);
    expect(still[1]).toMatch(/transition-duration: 0s !important;\s*animation-duration: 0s !important;/);
  });
});
