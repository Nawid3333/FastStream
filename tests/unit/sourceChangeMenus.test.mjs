import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// The review of 2026-10-14, on stand-in elements:
// - the subtitle syncer's track drag ended only on a mouseup the player heard; let go over the
//   subtitles menu (which stops mouseup), the track went on following the pointer with no
//   button held;
// - the language menu, open when the source changed to one with a single language, stayed
//   open with the old rows; the audio menu did the same for a source with one track.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {});

const el = () => doc.body.appendChild(doc.createElement('div'));
const dom = {
  playerContainer: el(), languageButton: el(), languageMenu: el(), audioTracksBtn: el(), audioSourceList: el(),
  videoSource: el(), videoSourceList: el(),
};
globalThis.__sourceChangeMenusDom = dom;

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__sourceChangeMenusDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));

const {SubtitleSyncer} = await import('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs');
const {LanguageChanger} = await import('../../chrome/player/ui/menus/LanguageChanger.mjs');
const {AudioQualityChanger} = await import('../../chrome/player/ui/menus/AudioQualityChanger.mjs');
const {VideoQualityChanger} = await import('../../chrome/player/ui/menus/VideoQualityChanger.mjs');

beforeEach(() => {
  for (const target of [dom.playerContainer, doc]) {
    for (const type of Object.keys(target.listeners)) target.listeners[type].length = 0;
  }
});

describe('the subtitle syncer\'s track drag', () => {
  it('stops at a move with no button held, for a mouseup it never heard', () => {
    const syncer = new SubtitleSyncer({
      player: {getVideo: () => ({duration: 100})},
      interfaceController: {subtitlesManager: {renderSubtitles() {}}},
    });
    syncer.trackToSync = {shift: vi.fn()};
    syncer.showShift = () => {};
    syncer.redrawTrack = () => {};
    syncer.ui.timelineTrack.clientWidth = 100;
    syncer.ui.timelineTrack.fire('mousedown', {button: 0, clientX: 10});
    dom.playerContainer.fire('mousemove', {buttons: 1, clientX: 20});
    expect(syncer.trackToSync.shift).toHaveBeenCalledTimes(1);
    // Let go over the subtitles menu: the player heard no mouseup.
    dom.playerContainer.fire('mousemove', {buttons: 0, clientX: 30});
    dom.playerContainer.fire('mousemove', {buttons: 0, clientX: 40});
    expect(syncer.trackToSync.shift).toHaveBeenCalledTimes(1);
  });
});

/**
 * A player whose source has one video and one audio level.
 * @return {Object}
 */
function singleLevelClient() {
  const video = {id: 'v', language: 'en', bitrate: 1};
  const audio = {id: 'a', language: 'en', bitrate: 1, label: 'English'};
  return {
    getVideoLevels: () => new Map([['v', video]]),
    getAudioLevels: () => new Map([['a', audio]]),
    getCurrentAudioLevelID: () => 'a',
    getLevelManager: () => ({
      getCurrentVideoLevelID: () => 'v',
      getCurrentAudioLevelID: () => 'a',
      filterAudioLevelsByLanguage: (levels) => levels,
    }),
  };
}

describe('the language and audio menus, open when the source changes', () => {
  it('close the language menu, with its old rows, for a source with one language', () => {
    const menu = new LanguageChanger();
    dom.languageMenu.appendChild(doc.createElement('div'));
    menu.openUI();
    menu.updateLanguageTracks(singleLevelClient());
    expect(menu.isOpen()).toBe(false);
    expect(dom.languageMenu.children.length).toBe(0);
  });

  it('close the audio menu for a source with one track', () => {
    const menu = new AudioQualityChanger();
    menu.openUI();
    menu.updateQualityLevels(singleLevelClient());
    expect(menu.isOpen()).toBe(false);
  });
});

describe('the quality menu, open when the source changes', () => {
  it('closes, with its old rows, for a source with no qualities to pick', () => {
    const menu = new VideoQualityChanger();
    dom.videoSourceList.appendChild(doc.createElement('div'));
    menu.openUI();
    menu.updateQualityLevels({getMenuVideoLevels: () => new Map()});
    expect(menu.isOpen()).toBe(false);
    expect(dom.videoSourceList.children.length).toBe(0);
  });
});

describe('the language menu\'s rows', () => {
  it('name a track without a language "Unknown" to a screen reader, as on screen', () => {
    const client = singleLevelClient();
    const english = {id: 'a', language: 'en', bitrate: 1, label: 'English'};
    const unnamed = {id: 'b', bitrate: 1, label: 'Track 2'};
    client.getAudioLevels = () => new Map([['a', english], ['b', unnamed]]);
    const menu = new LanguageChanger();
    menu.updateLanguageTracks(client);
    const labels = [];
    const walk = (node) => {
      if (node.getAttribute?.('aria-label')) labels.push(node.getAttribute('aria-label'));
      for (const child of node.children || []) walk(child);
    };
    walk(dom.languageMenu);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.join(' | ')).not.toContain('undefined');
  });
});
