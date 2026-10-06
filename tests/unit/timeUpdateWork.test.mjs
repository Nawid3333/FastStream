import {describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// Work the player did on every time update, which is every animation frame for a video
// shorter than five minutes (#191):
// - checkTrackBounds read the subtitle container's computed style (a forced layout) with
//   no subtitle track at all;
// - updateSkipSegments rewrote the class, position and width of every skip segment and
//   chapter marker, unchanged, each time.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
const getComputedStyle = vi.fn(() => ({bottom: '0px'}));
vi.stubGlobal('window', {getComputedStyle});
const el = () => doc.body.appendChild(doc.createElement('div'));
globalThis.__timeUpdateDom = {
  playerContainer: el(), subtitlesContainer: el(), skipSegmentsContainer: el(), skipButton: el(),
  progressContainer: el(), nextVideoBannerButton: el(),
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

describe('updateSkipSegments', () => {
  /**
   * A progress bar on a 100 s video at `time`, with an intro, a coloured skip segment and
   * two chapters.
   * @param {Object} [overrides] - Changes to the client.
   * @return {{bar: ProgressBar, client: Object}}
   */
  function make(overrides = {}) {
    const client = {
      duration: 100,
      currentTime: 2,
      videoAnalyzer: {getIntro: () => ({startTime: 0, endTime: 10}), getOutro: () => null},
      skipSegments: [{startTime: 40, endTime: 50, class: 'sponsor', name: 'Sponsor', color: 'rgb(0, 200, 0)'}],
      chapters: [{name: 'A', startTime: 0, endTime: 30}, {name: 'B', startTime: 30, endTime: 100}, {name: 'C', startTime: 60, endTime: 100}],
      options: {autoplayNext: false},
      hasNextVideo: () => false,
      ...overrides,
    };
    const bar = new ProgressBar(client);
    return {bar, client};
  }

  /**
   * Counts the writes to the class and inline style of the given elements from now on.
   * @param {Array<Object>} elements - Stand-in elements.
   * @return {Array<string>} The writes, as they happen.
   */
  function recordWrites(elements) {
    const writes = [];
    for (const element of elements) {
      const style = element.style;
      element.style = new Proxy(style, {
        set(target, property, value) {
          writes.push(`style.${String(property)}`);
          target[property] = value;
          return true;
        },
      });
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'className');
      Object.defineProperty(element, 'className', {
        get: () => proto.get.call(element),
        set: (value) => {
          writes.push('className');
          proto.set.call(element, value);
        },
      });
    }
    return writes;
  }

  it('draws the segments and chapters once, then writes nothing while nothing changes', () => {
    const {bar} = make();
    bar.updateSkipSegments();
    const [intro, sponsor] = bar.skipSegmentsCache;
    expect(intro.className).toBe('skip_segment intro active');
    expect(sponsor.className).toBe('skip_segment sponsor');
    expect(sponsor.style).toMatchObject({left: '40%', width: '10%', backgroundColor: 'rgb(0, 200, 0)'});
    expect(bar.chapterCache.map((chapter) => [chapter.className, chapter.style.left])).toEqual([['chapter', '30%'], ['chapter', '60%']]);

    const writes = recordWrites([...bar.skipSegmentsCache, ...bar.chapterCache]);
    for (let frame = 0; frame < 10; frame++) bar.updateSkipSegments();
    expect(writes).toEqual([]);
  });

  it('still redraws what changes', () => {
    const {bar, client} = make();
    bar.updateSkipSegments();
    const [intro, sponsor] = bar.skipSegmentsCache;
    client.currentTime = 45;
    bar.updateSkipSegments();
    expect(intro.className).toBe('skip_segment intro');
    expect(sponsor.className).toBe('skip_segment sponsor active');

    // The coloured segment goes; an uncoloured one takes its element.
    client.skipSegments = [{startTime: 70, endTime: 80, class: 'filler', name: 'Filler'}];
    bar.updateSkipSegments();
    expect(sponsor.className).toBe('skip_segment filler');
    expect(sponsor.style).toMatchObject({left: '70%', width: '10%', backgroundColor: ''});
  });
});

describe('updateMarkers', () => {
  // The analyzers call it on every animation frame while they run (the preview frames' one
  // by default); it rewrote the left and display of all five markers each time.
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
      seekMarker: marker('seek'), unseekMarker: marker('unseek'), videoAnalyzerMarker: marker('video'),
      audioAnalyzerMarker: marker('audio'), frameExtractorMarker: marker('frames'),
      placeMarker: ProgressBar.prototype.placeMarker,
      client: {
        duration: 100, pastSeeks: [], pastUnseeks: [],
        videoAnalyzer: {getMarkerPosition: () => null}, audioAnalyzer: {getMarkerPosition: () => null},
        frameExtractor: {getMarkerPosition: () => position},
      },
    };
    const update = () => ProgressBar.prototype.updateMarkers.call(bar);
    update();
    expect(writes).toHaveLength(6);
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
