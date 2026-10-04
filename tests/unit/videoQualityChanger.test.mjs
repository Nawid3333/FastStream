import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The video quality menu, on stand-in elements. A click hands the version it picks over
// with the versions of its size it was picked from, so that only a choice between codecs
// is remembered as one (LevelManager.rememberVideoChoice). Without them every click on a
// quality with one version, and every pick among versions that differed only in bitrate,
// saved a codec family for the site, which then outranked the hardware decoder there.

const {el} = vi.hoisted(() => {
  const el = () => {
    const classes = new Set();
    const listeners = {};
    const children = [];
    return {
      children,
      listeners,
      style: {},
      title: '',
      textContent: '',
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      appendChild(child) {
        children.push(child);
        return child;
      },
      replaceChildren() {
        children.length = 0;
      },
      getElementsByClassName: (name) => children.filter((child) => child.classList.contains(name)),
      querySelector: () => ({style: {}}),
      click() {
        (listeners.click || []).forEach((fn) => fn({stopPropagation() {}}));
      },
    };
  };
  return {el};
});

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {videoSource: el(), videoSourceList: el()}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key, getLanguageMatchLevel: () => 0}}));

const {VideoQualityChanger} = await import('../../chrome/player/ui/menus/VideoQualityChanger.mjs');
const {DOMElements} = await import('../../chrome/player/ui/DOMElements.mjs');
const {LevelManager} = await import('../../chrome/player/players/LevelManager.mjs');

const HW = {supported: true, smooth: true, powerEfficient: true};
const SW = {supported: true, smooth: true, powerEfficient: false};

const level = (id, fields) => ({
  id, width: 1920, height: 1080, bitrate: 5e6, mimeType: '', language: '',
  videoCodec: 'avc1.640028', audioCodec: null, frameRate: 0, videoRange: 'SDR', decoding: null,
  ...fields,
});

/**
 * A LevelManager without its constructor, which reads localStorage, on a site.
 * @param {Object} client
 * @return {LevelManager}
 */
function manager(client) {
  const m = Object.create(LevelManager.prototype);
  Object.assign(m, {
    client,
    currentVideoLevelID: null,
    currentAudioLevelID: null,
    currentVideoLanguage: 'en',
    currentAudioLanguage: 'en',
    prioritizedVideoContainer: 'mp4',
    prioritizedAudioContainer: 'mp4',
    videoCodecFamilyBySite: {},
    prioritizedAudioCodec: null,
    shouldPreferDRCAudio: false,
  });
  m.savePreferences = () => {};
  return m;
}

describe('VideoQualityChanger: what a click hands over', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {createElement: () => el()});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives each picked version with the versions of its size, and so saves only a choice between codecs', () => {
    const levels = [
      level('360p', {width: 640, height: 360, bitrate: 8e5, videoCodec: 'avc1.4d401e', decoding: HW}),
      level('h264-sw', {videoCodec: 'avc1.640028', bitrate: 6e6, decoding: SW}),
      level('hevc-hw', {videoCodec: 'hvc1.1.6.L120.90', bitrate: 4e6, decoding: HW}),
    ];
    const client = {
      options: {defaultQuality: 'Auto'},
      source: {url: 'https://cdn.example.net/master.m3u8', headers: {referer: 'https://a.example/watch'}},
      videoWidth: 1920,
      videoHeight: 1080,
      getVideoLevels: () => new Map(levels.map((version) => [version.id, version])),
      getCurrentVideoLevelID: () => 'hevc-hw',
    };
    const m = manager(client);
    client.getLevelManager = () => m;

    const changer = new VideoQualityChanger();
    const clicks = [];
    changer.on('qualityChanged', (picked, savePriority, versions) => {
      clicks.push({id: picked.id, savePriority, versions: versions.map((version) => version.id)});
      // As InterfaceController does.
      if (savePriority) {
        m.rememberVideoChoice(picked, versions);
      }
    });
    changer.updateQualityLevels(client);

    const items = DOMElements.videoSourceList.children;
    const item = (className, text) => items.find((child) => child.classList.contains(className) &&
      child.children[0].textContent.includes(text));

    // The 360p quality has one version: its codec says nothing about the user's taste.
    item('fluid_video_source_list_item', '640x360').click();
    expect(clicks.at(-1)).toEqual({id: '360p', savePriority: true, versions: ['360p']});
    expect(m.videoCodecFamilyBySite).toEqual({});
    expect(m.pickVideoLevel(levels).id).toBe('hevc-hw');

    // The 1080p one is playing, so its versions are listed: H.264 picked over HEVC.
    item('fluid_video_source_sublist_item', 'H.264').click();
    expect(clicks.at(-1)).toEqual({id: 'h264-sw', savePriority: true, versions: ['hevc-hw', 'h264-sw']});
    expect(m.videoCodecFamilyBySite).toEqual({'a.example': 'avc'});
  });
});
