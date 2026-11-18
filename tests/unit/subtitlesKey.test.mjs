import {beforeEach, describe, expect, it, vi} from 'vitest';
import {nextTrack} from '../../chrome/player/ui/subtitles/SubtitleCycle.mjs';

// The subtitles key (C) changed the subtitles without a word on screen, and with several
// tracks it only ever turned on the ones on before. It shows the outcome on the OSD now, and
// options.cycleSubtitles makes it go through the tracks one at a time, then off.

const osd = {textContent: '', classList: {add() {}, remove() {}}};
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {osd, playerContainer: {addEventListener() {}}}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key, subs) => (subs ? `${key}:${subs.join('|')}` : key)},
}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => ({InterfaceUtils: {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
// It imports coloris.mjs, which the build generates: not there when CI runs the unit tests.
vi.mock('../../chrome/player/ui/subtitles/SubtitlesSettingsManager.mjs', () => ({SubtitlesSettingsManager: class {}, SubtitlesSettingsManagerEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs', () => ({SubtitleSyncer: class {}}));
vi.stubGlobal('document', {addEventListener() {}});

const {SubtitlesManager} = await import('../../chrome/player/ui/subtitles/SubtitlesManager.mjs');
const {KeybindManager} = await import('../../chrome/player/ui/KeybindManager.mjs');
const {DefaultOptions} = await import('../../chrome/player/options/defaults/DefaultOptions.mjs');

const english = {language: 'en', label: 'English'};
const german = {language: 'de', label: 'Deutsch'};
const unnamed = {language: '', label: ''};

/**
 * The real subtitle methods on a manager holding these tracks, without its menu.
 * @param {Object[]} tracks
 * @return {Object}
 */
function manager(tracks) {
  return Object.assign(Object.create(SubtitlesManager.prototype), {
    tracks, activeTracks: [], lastActiveTracks: null, updateTrackList: vi.fn(),
  });
}

describe('nextTrack', () => {
  it('goes first, next, ..., off, and starts over', () => {
    const tracks = ['a', 'b', 'c'];
    expect(nextTrack(tracks, [])).toBe('a');
    expect(nextTrack(tracks, ['a'])).toBe('b');
    expect(nextTrack(tracks, ['b'])).toBe('c');
    expect(nextTrack(tracks, ['c'])).toBeNull();
  });

  it('goes on after the last of several tracks on (turned on in the menu)', () => {
    expect(nextTrack(['a', 'b', 'c'], ['c', 'a'])).toBeNull();
    expect(nextTrack(['a', 'b', 'c'], ['a', 'b'])).toBe('c');
  });

  it('has nothing to turn on without tracks', () => {
    expect(nextTrack([], [])).toBeNull();
  });
});

describe('the subtitles key', () => {
  /** @type {Object} */
  let subtitles;
  /** @type {Object} */
  let client;
  /** @type {InstanceType<typeof KeybindManager>} */
  let keys;
  const press = () => {
    keys.handleKeyString('KeyC', {});
    return osd.textContent;
  };

  beforeEach(() => {
    osd.textContent = '';
    subtitles = manager([english, unnamed, german]);
    client = {options: {cycleSubtitles: false}, interfaceController: {subtitlesManager: subtitles}};
    keys = new KeybindManager(/** @type {any} */ (client));
  });

  it('turns them on and off by default, and says which', () => {
    expect(DefaultOptions.cycleSubtitles).toBe(false);
    expect(press()).toBe('player_subtitles_osd_on:(en) English');
    expect(press()).toBe('player_subtitles_osd_off');
    // Two tracks turned on in the menu: the key turns both off, then both back on.
    subtitles.activateTrack(english);
    subtitles.activateTrack(german);
    expect(press()).toBe('player_subtitles_osd_off');
    expect(press()).toBe('player_subtitles_osd_on:(en) English, (de) Deutsch');
  });

  it('goes through the tracks with options.cycleSubtitles, naming each as the menu does', () => {
    client.options.cycleSubtitles = true;
    const seen = [press(), press(), press(), press(), press()];
    expect(seen).toEqual([
      'player_subtitles_osd_on:(en) English',
      'player_subtitles_osd_on:player_subtitles_track_numbered:2',
      'player_subtitles_osd_on:(de) Deutsch',
      'player_subtitles_osd_off',
      'player_subtitles_osd_on:(en) English',
    ]);
    expect(subtitles.activeTracks).toEqual([english]);
    // Each press redraws the subtitles and the menu, not only the OSD.
    expect(subtitles.updateTrackList).toHaveBeenCalledTimes(5);
  });

  it('says there are none when the video has no subtitles', () => {
    subtitles.tracks.length = 0;
    expect(press()).toBe('player_subtitles_osd_none');
    client.options.cycleSubtitles = true;
    expect(press()).toBe('player_subtitles_osd_none');
    expect(subtitles.activeTracks).toEqual([]);
  });
});

describe('the subtitle sync key', () => {
  /** @type {Object} */
  let subtitles;
  /** @type {InstanceType<typeof KeybindManager>} */
  let keys;
  /** @type {Object} */
  let syncer;
  const press = () => {
    keys.handleKeyString('KeyT', {});
    return osd.textContent;
  };

  beforeEach(() => {
    osd.textContent = '';
    subtitles = manager([english, german]);
    // As SubtitleSyncer.toggleTrack: the open track again closes the tool, another opens it.
    syncer = {
      started: false, trackToSync: null,
      toggleTrack: vi.fn((track) => {
        const close = syncer.started && syncer.trackToSync === track;
        syncer.started = !close;
        syncer.trackToSync = close ? null : track;
      }),
    };
    subtitles.subtitleSyncer = syncer;
    keys = new KeybindManager(/** @type {any} */ ({options: {}, interfaceController: {subtitlesManager: subtitles}}));
  });

  it('is T, as in mpv', () => {
    expect(keys.keyStringToKeybinds('KeyT')).toEqual(['SubtitleSyncTool']);
  });

  it('opens the tool on the track shown, and closes it again', () => {
    subtitles.activateTrack(german);
    press();
    expect(syncer.toggleTrack).toHaveBeenLastCalledWith(german);
    expect(syncer.started).toBe(true);
    press();
    expect(syncer.started).toBe(false);
  });

  it('closes the track the tool has open, whichever is shown now', () => {
    subtitles.activateTrack(english);
    syncer.started = true;
    syncer.trackToSync = german;
    press();
    expect(syncer.toggleTrack).toHaveBeenCalledWith(german);
    expect(syncer.started).toBe(false);
  });

  it('says why nothing opens: no subtitles, or none shown', () => {
    expect(press()).toBe('player_subtitles_osd_off');
    subtitles.tracks.length = 0;
    expect(press()).toBe('player_subtitles_osd_none');
    expect(syncer.toggleTrack).not.toHaveBeenCalled();
  });
});
