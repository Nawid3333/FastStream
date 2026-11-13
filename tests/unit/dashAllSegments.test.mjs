import {describe, expect, it} from 'vitest';
// Its text, which vitest includes when it loads this file (?raw): read at run time, the code
// run below was "user-provided" to CodeQL (js/code-injection).
import DASH_SOURCE from '../../node_modules/dashjs/dist/modern/esm/dash.all.debug.js?raw';

// patches/dashjs@*.patch gives dash.js's segment getters a getAllSegments, which DashPlayer's
// extractFragments calls for every representation to fill the fragment store. It listed until
// the getter had no next segment, and a manifest decides when that is: a 1 KB one that says
// 100000000 hours of 1 s segments, a live one whose every segment is available
// (availabilityTimeOffset="INF"), an S element repeated a billion times or a SegmentList
// starting at number 10^12 made one object per segment until the player page ran out of
// memory - with every add-on's pages, which share its process. More than 100000 segments are
// now listed as none: the loader fetches each one as dash.js asks for it (DashLoader's
// "Fragment not found" path, DashLoader.test.mjs).
//
// This runs the getters of the dash.js that pnpm installed with the patch (the file
// tools/sync-vendor.mjs vendors as chrome/player/modules/dash.mjs) on manifests its own parser
// read.

const LIMIT = 100000;

/**
 * The installed dash.js's internal modules, without its entry point (which needs a page).
 * @return {(id: string) => any} - Its __webpack_require__.
 */
function loadDashModules() {
  const end = DASH_SOURCE.indexOf('var __webpack_exports__ = {};');
  expect(end).toBeGreaterThan(-1);
  return new Function('window', DASH_SOURCE.slice(0, end) + '\nreturn __webpack_require__;')({performance});
}

const require = loadDashModules();
const factory = (/** @type {string} */ id) => require(`./src/${id}.js`).default;
const context = {};
factory('core/Settings')(context).getInstance();
const silent = {getLogger: () => ({debug() {}, info() {}, warn() {}, error() {}})};
const parser = factory('dash/parser/DashParser')(context).create({debug: silent});
const model = factory('dash/models/DashManifestModel')(context).getInstance();
model.setConfig({errHandler: {error() {}}});
const timelineConverter = factory('dash/utils/TimelineConverter')(context).getInstance();
timelineConverter.initialize();
const GETTERS = {
  SegmentTemplate: factory('dash/utils/TemplateSegmentsGetter'),
  SegmentTimeline: factory('dash/utils/TimelineSegmentsGetter'),
  SegmentList: factory('dash/utils/ListSegmentsGetter'),
};

/**
 * The segments the patched getter lists for a manifest's one representation.
 * @param {string} mpd - What the MPD element holds and its attributes, as `<MPD ${mpd}</MPD>`.
 * @return {{segments: Array<{index: number, media: string}>, ms: number}}
 */
function allSegments(mpd) {
  const manifest = parser.parse(`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT2S" ${mpd}</MPD>`);
  manifest.loadedTime = new Date();
  const [period] = model.getRegularPeriods(model.getMpd(manifest));
  const [adaptation] = model.getAdaptationsForPeriod(period);
  const [representation] = model.getRepresentationsForAdaptation(adaptation);
  const getter = GETTERS[representation.segmentInfoType](context).create({
    timelineConverter,
    dashMetrics: {getCurrentDVRInfo: () => ({end: NaN})},
  }, model.getIsDynamic(manifest));
  const start = performance.now();
  const segments = getter.getAllSegments(representation);
  return {segments, ms: performance.now() - start};
}

/**
 * A video on demand with one representation.
 * @param {string} duration - Its mediaPresentationDuration.
 * @param {string} segments - Its segment element.
 * @return {string}
 */
const vod = (duration, segments) => `type="static" mediaPresentationDuration="${duration}">` +
  `<Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000">${segments}` +
  '</Representation></AdaptationSet></Period>';

describe('dash.js getAllSegments (patched): a manifest with too many segments', () => {
  it('lists a template\'s segments as before', () => {
    const {segments} = allSegments(vod('PT20S', '<SegmentTemplate media="$Number$.m4s" duration="2"/>'));
    expect(segments.map((segment) => [segment.index, segment.media])).toEqual(
        Array.from({length: 10}, (_, i) => [i, `${i + 1}.m4s`]));
  });

  it('lists a timeline\'s and a list\'s segments as before', () => {
    const timeline = allSegments(vod('PT10S',
        '<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="4" r="1"/><S d="2"/></SegmentTimeline></SegmentTemplate>')).segments;
    expect(timeline.map((segment) => [segment.index, segment.media, segment.duration])).toEqual(
        [[0, '0.m4s', 4], [1, '4.m4s', 4], [2, '8.m4s', 2]]);
    const list = allSegments(vod('PT6S',
        '<SegmentList duration="2"><SegmentURL media="a.m4s"/><SegmentURL media="b.m4s"/><SegmentURL media="c.m4s"/></SegmentList>')).segments;
    expect(list.map((segment) => [segment.index, segment.media])).toEqual([[0, 'a.m4s'], [1, 'b.m4s'], [2, 'c.m4s']]);
  });

  it('lists a template of 100000 segments in full, and none of 100001', () => {
    const template = (seconds) => allSegments(vod(`PT${seconds}S`, '<SegmentTemplate media="$Number$.m4s" duration="1"/>')).segments;
    expect(template(LIMIT).length).toBe(LIMIT);
    expect(template(LIMIT + 1).length).toBe(0);
  });

  it('lists a timeline of 100000 segments in full, and none of 100001', () => {
    const timeline = (repeat) => allSegments(vod('PT1S',
        `<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S d="1" r="${repeat}"/></SegmentTimeline></SegmentTemplate>`)).segments;
    expect(timeline(LIMIT - 1).length).toBe(LIMIT);
    expect(timeline(LIMIT).length).toBe(0);
  });

  it('lists a list of 100000 segments in full, and none of 100001', () => {
    // Every number below startNumber is the list's first segment again.
    const list = (startNumber) => allSegments(vod('PT1000000S',
        `<SegmentList duration="1" startNumber="${startNumber}"><SegmentURL media="a.m4s"/></SegmentList>`)).segments;
    expect(list(LIMIT).length).toBe(LIMIT);
    expect(list(LIMIT + 1).length).toBe(0);
  });

  it.each([
    ['100000000 hours of 1 s segments', vod('PT100000000H', '<SegmentTemplate media="$Number$.m4s" duration="1"/>')],
    ['a live stream whose every segment is available', 'type="dynamic" availabilityStartTime="2020-01-01T00:00:00Z">' +
      '<Period start="PT0S"><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000">' +
      '<SegmentTemplate media="$Number$.m4s" duration="1" availabilityTimeOffset="INF"/></Representation></AdaptationSet></Period>'],
    ['an S element repeated a billion times', vod('PT1S',
        '<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S d="1" r="1000000000"/></SegmentTimeline></SegmentTemplate>')],
    ['a SegmentList that starts at number 10^12', vod('PT100000000H',
        '<SegmentList duration="1" startNumber="1000000000000"><SegmentURL media="a.m4s"/></SegmentList>')],
  ])('lists none, at once, for %s', (_, mpd) => {
    const {segments, ms} = allSegments(mpd);
    expect(segments.length).toBe(0);
    expect(ms).toBeLessThan(1000);
  });
});
