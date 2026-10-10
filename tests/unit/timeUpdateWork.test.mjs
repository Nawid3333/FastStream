import {describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// Work the player did on every time update, which is every animation frame for a video
// shorter than five minutes (#191):
// - checkTrackBounds read the subtitle container's computed style (a forced layout) with
//   no subtitle track at all;
// - the markers were rewritten, unchanged, each time.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
const getComputedStyle = vi.fn(() => ({bottom: '0px'}));
vi.stubGlobal('window', {getComputedStyle});
const el = () => doc.body.appendChild(doc.createElement('div'));
globalThis.__timeUpdateDom = {
  playerContainer: el(), subtitlesContainer: el(), progressContainer: el(), nextVideoBannerButton: el(),
};
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__timeUpdateDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
vi.mock('../../chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs', () => ({OpenSubtitlesSearch: class {}, OpenSubtitlesSearchEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/SubtitlesSettingsManager.mjs', () => ({SubtitlesSettingsManager: class {}, SubtitlesSettingsManagerEvents: {}}));
vi.mock('../../chrome/player/ui/subtitles/SubtitleSyncer.mjs', () => ({SubtitleSyncer: class {}}));

const {SubtitlesManager} = await import('../../chrome/player/ui/subtitles/SubtitlesManager.mjs');
const {ProgressBar} = await import('../../chrome/player/ui/ProgressBar.mjs');

describe('checkTrackBounds', () => {
  it('lays nothing out when there is no subtitle track', () => {
    getComputedStyle.mockClear();
    SubtitlesManager.prototype.checkTrackBounds.call({subtitleTrackDisplayElements: []});
    expect(getComputedStyle).not.toHaveBeenCalled();
  });
});

describe('updateNextVideoBanner', () => {
  /**
   * A progress bar on a 100 s video at `time`, the next video playing by itself.
   * @param {number} time
   * @return {{bar: ProgressBar, client: Object, shown: Array}}
   */
  function make(time) {
    const client = {duration: 100, currentTime: time, options: {autoplayNext: true}, hasNextVideo: () => true};
    const bar = new ProgressBar(client);
    const shown = [];
    bar.on('show-next-video', () => shown.push(client.currentTime));
    return {bar, client, shown};
  }

  it('shows the next video for the last 10 seconds, the controls once', () => {
    const banner = globalThis.__timeUpdateDom.nextVideoBannerButton;
    const {bar, client, shown} = make(50);
    bar.updateNextVideoBanner();
    expect(banner.style.display).toBe('none');
    client.currentTime = 91;
    bar.updateNextVideoBanner();
    expect(banner.style.display).toBe('');
    expect(banner.textContent).toBe('player_nextvideoin');
    client.currentTime = 95;
    bar.updateNextVideoBanner();
    expect(shown).toEqual([91]);
  });

  it('shows nothing without a next video or with autoplay off', () => {
    const banner = globalThis.__timeUpdateDom.nextVideoBannerButton;
    const {bar, client} = make(95);
    client.options.autoplayNext = false;
    bar.updateNextVideoBanner();
    expect(banner.style.display).toBe('none');
    client.options.autoplayNext = true;
    client.hasNextVideo = () => false;
    bar.updateNextVideoBanner();
    expect(banner.style.display).toBe('none');
  });
});

describe('updateMarkers', () => {
  // The analyzers call it on every animation frame while they run (the preview frames' one
  // by default); it rewrote the left and display of all four markers each time.
  it('writes a marker only when it moves, shows or hides', () => {
    const writes = [];
    const marker = (name) => ({style: new Proxy({}, {
      set: (style, key, value) => {
        writes.push(name + '.' + key);
        style[key] = value;
        return true;
      },
    })});
    let position = 10;
    const bar = {
      seekMarker: marker('seek'), unseekMarker: marker('unseek'),
      audioAnalyzerMarker: marker('audio'), frameExtractorMarker: marker('frames'),
      placeMarker: ProgressBar.prototype.placeMarker,
      client: {
        duration: 100, pastSeeks: [], pastUnseeks: [],
        audioAnalyzer: {getMarkerPosition: () => null},
        frameExtractor: {getMarkerPosition: () => position},
      },
    };
    const update = () => ProgressBar.prototype.updateMarkers.call(bar);
    update();
    expect(writes).toHaveLength(5);
    expect(bar.frameExtractorMarker.style).toEqual({left: '10%', display: ''});
    writes.length = 0;
    update();
    update();
    expect(writes).toEqual([]);
    position = 20;
    update();
    expect(writes).toEqual(['frames.left', 'frames.display']);
    expect(bar.frameExtractorMarker.style.left).toBe('20%');
    position = null;
    bar.client.pastSeeks = [50];
    writes.length = 0;
    update();
    expect(writes.sort()).toEqual(['frames.display', 'seek.display', 'seek.left']);
    expect(bar.frameExtractorMarker.style.display).toBe('none');
    expect(bar.seekMarker.style).toEqual({left: '50%', display: ''});
  });
});
