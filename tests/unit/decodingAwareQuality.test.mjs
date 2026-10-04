import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LevelManager} from '../../chrome/player/players/LevelManager.mjs';

// Which version of a stream gets picked when several share the chosen height. Before this,
// the higher bitrate always won and the codec was never looked at: AV1 at 2.5 Mbit/s lost
// to H.264 at 5 Mbit/s, and on a GPU without AV1 decoding a higher-bitrate AV1 version
// was decoded in software. Now Firefox's Media Capabilities answers decide among them
// (hardware first, smooth, frame rate, codec efficiency), and the height stays the
// user's choice.

const HW = {supported: true, smooth: true, powerEfficient: true};
const SW = {supported: true, smooth: true, powerEfficient: false};

const level = (id, fields) => ({
  id, width: 1920, height: 1080, bitrate: 5e6, mimeType: '', language: '',
  videoCodec: 'avc1.640028', audioCodec: null, frameRate: 0, videoRange: 'SDR', decoding: null,
  ...fields,
});

const audio = (id, fields) => ({
  id, bitrate: 128000, mimeType: '', language: '', audioCodec: 'mp4a.40.2', decoding: null,
  ...fields,
});

/**
 * A LevelManager without its constructor, which reads localStorage.
 * @param {Object} [options]
 * @return {LevelManager}
 */
function manager({defaultQuality = 'Auto', decodingAwareQuality, source = null} = {}) {
  const m = Object.create(LevelManager.prototype);
  Object.assign(m, {
    client: {options: {defaultQuality, decodingAwareQuality}, source},
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

const pick = (m, levels) => m.pickVideoLevel(levels).id;

describe('picking among versions of the chosen height', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches: false}));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes the more efficient codec when both are decoded in hardware, not the higher bitrate', () => {
    const levels = [
      level('h264', {videoCodec: 'avc1.640028', bitrate: 5e6, decoding: HW}),
      level('av1', {videoCodec: 'av01.0.08M.08', bitrate: 2.5e6, decoding: HW}),
    ];
    expect(pick(manager(), levels)).toBe('av1');
  });

  it('ranks VP9 above H.264 among hardware-decoded versions', () => {
    const levels = [
      level('h264', {videoCodec: 'avc1.640028', bitrate: 9e6, decoding: HW}),
      level('vp9', {videoCodec: 'vp09.00.40.08', bitrate: 6e6, mimeType: '', decoding: HW}),
    ];
    expect(pick(manager(), levels)).toBe('vp9');
  });

  it('takes the hardware-decoded version over a software one of the same height', () => {
    const levels = [
      level('av1-sw', {videoCodec: 'av01.0.08M.08', bitrate: 8e6, decoding: SW}),
      level('h264-hw', {videoCodec: 'avc1.640028', bitrate: 5e6, decoding: HW}),
    ];
    expect(pick(manager(), levels)).toBe('h264-hw');
  });

  it('never lowers the resolution to reach hardware decoding', () => {
    const levels = [
      level('4k-av1-sw', {height: 2160, width: 3840, videoCodec: 'av01.0.12M.08', bitrate: 16e6, decoding: SW}),
      level('1080-h264-hw', {videoCodec: 'avc1.640028', bitrate: 5e6, decoding: HW}),
    ];
    expect(pick(manager(), levels)).toBe('4k-av1-sw');
    expect(pick(manager({defaultQuality: '1080p'}), levels)).toBe('1080-h264-hw');
  });

  it('takes the higher frame rate among hardware-decoded versions, before the codec', () => {
    const levels = [
      level('30-av1', {videoCodec: 'av01.0.08M.08', frameRate: 30, bitrate: 4e6, decoding: HW}),
      level('60-h264', {videoCodec: 'avc1.64002a', frameRate: 60, bitrate: 3e6, decoding: HW}),
    ];
    expect(pick(manager(), levels)).toBe('60-h264');
  });

  it('treats 59.94 and 60 fps as the same frame rate', () => {
    const levels = [
      level('60-h264', {videoCodec: 'avc1.64002a', frameRate: 60, bitrate: 6e6, decoding: HW}),
      level('5994-av1', {videoCodec: 'av01.0.08M.08', frameRate: 59.94, bitrate: 3e6, decoding: HW}),
    ];
    expect(pick(manager(), levels)).toBe('5994-av1');
  });

  it('leaves software-decoded versions to the bitrate, as before', () => {
    const levels = [
      level('av1-sw', {videoCodec: 'av01.0.08M.08', frameRate: 60, bitrate: 3e6, decoding: SW}),
      level('h264-sw', {videoCodec: 'avc1.640028', frameRate: 30, bitrate: 5e6, decoding: SW}),
    ];
    expect(pick(manager(), levels)).toBe('h264-sw');
  });

  it('leaves versions without an answer to the bitrate, as before', () => {
    const levels = [
      level('h264', {videoCodec: 'avc1.640028', bitrate: 5e6}),
      level('av1', {videoCodec: 'av01.0.08M.08', bitrate: 2.5e6}),
    ];
    expect(pick(manager(), levels)).toBe('h264');
  });

  it('puts a version without an answer between hardware and software ones', () => {
    const unknown = level('unknown', {bitrate: 4e6});
    const hw = level('hw', {bitrate: 3e6, decoding: HW});
    const sw = level('sw', {bitrate: 9e6, decoding: SW});
    expect(pick(manager(), [unknown, sw])).toBe('unknown');
    expect(pick(manager(), [unknown, hw])).toBe('hw');
  });

  it('prefers a smooth version among those decoded the same way', () => {
    const levels = [
      level('choppy', {bitrate: 8e6, decoding: {supported: true, smooth: false, powerEfficient: false}}),
      level('smooth', {bitrate: 5e6, decoding: SW}),
    ];
    expect(pick(manager(), levels)).toBe('smooth');
  });

  it('puts a version Firefox cannot play last', () => {
    const levels = [
      level('unsupported', {bitrate: 8e6, decoding: {supported: false, smooth: false, powerEfficient: false}}),
      level('playable', {bitrate: 5e6, decoding: SW}),
    ];
    expect(pick(manager(), levels)).toBe('playable');
  });

  it('still picks something when nothing is playable', () => {
    const bad = {supported: false, smooth: false, powerEfficient: false};
    const levels = [level('a', {bitrate: 5e6, decoding: bad}), level('b', {bitrate: 8e6, decoding: bad})];
    expect(pick(manager(), levels)).toBe('b');
  });

  it('goes back to the higher bitrate when the option is off', () => {
    const levels = [
      level('h264', {videoCodec: 'avc1.640028', bitrate: 5e6, decoding: HW}),
      level('av1', {videoCodec: 'av01.0.08M.08', bitrate: 2.5e6, decoding: HW}),
      level('sw', {videoCodec: 'av01.0.08M.08', bitrate: 9e6, decoding: SW}),
    ];
    expect(pick(manager({decodingAwareQuality: false}), levels)).toBe('sw');
  });

  it('only reorders the chosen height: other heights keep matchQuality\'s order', () => {
    const levels = [
      level('720', {height: 720, bitrate: 2e6, decoding: HW}),
      level('1080-sw', {bitrate: 9e6, decoding: SW}),
      level('1080-hw', {bitrate: 4e6, decoding: HW}),
    ];
    const m = manager();
    const ranked = m.rankHeightGroup(m.matchQuality(levels, Infinity));
    expect(ranked.map((l) => l.id)).toEqual(['1080-hw', '1080-sw', '720']);
  });
});

describe('HDR versions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const levels = () => [
    level('pq', {videoCodec: 'av01.0.08M.10', videoRange: 'PQ', bitrate: 6e6, decoding: HW}),
    level('sdr', {videoCodec: 'av01.0.08M.08', videoRange: 'SDR', bitrate: 8e6, decoding: HW}),
  ];

  it('takes SDR when the screen cannot show HDR, though the HDR version is decoded', () => {
    vi.stubGlobal('matchMedia', () => ({matches: false}));
    const hdrFirst = [
      level('pq', {videoCodec: 'av01.0.08M.10', videoRange: 'PQ', bitrate: 9e6, decoding: HW}),
      level('sdr', {videoCodec: 'av01.0.08M.08', videoRange: 'SDR', bitrate: 6e6, decoding: HW}),
    ];
    expect(pick(manager(), hdrFirst)).toBe('sdr');
  });

  it('takes HDR when the screen shows HDR and Firefox decodes it', () => {
    vi.stubGlobal('matchMedia', (query) => ({matches: query === '(dynamic-range: high)'}));
    expect(pick(manager(), levels())).toBe('pq');
  });

  it('takes SDR when Firefox gave no answer about the HDR version', () => {
    vi.stubGlobal('matchMedia', () => ({matches: true}));
    const unanswered = [
      level('pq', {videoCodec: 'av01.0.08M.10', videoRange: 'PQ', bitrate: 9e6}),
      level('sdr', {videoCodec: 'av01.0.08M.08', videoRange: 'SDR', bitrate: 6e6}),
    ];
    expect(pick(manager(), unanswered)).toBe('sdr');
  });

  it('works without matchMedia (no screen to ask)', () => {
    vi.stubGlobal('matchMedia', undefined);
    const hdrFirst = [
      level('pq', {videoCodec: 'av01.0.08M.10', videoRange: 'PQ', bitrate: 9e6, decoding: HW}),
      level('sdr', {videoCodec: 'av01.0.08M.08', videoRange: 'SDR', bitrate: 6e6, decoding: HW}),
    ];
    expect(pick(manager(), hdrFirst)).toBe('sdr');
  });
});

describe('a codec picked by hand', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({matches: false}));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const site = (referer, url = 'https://cdn.example.net/master.m3u8') => ({
    url, headers: referer ? {referer} : {},
  });

  // AV1 wins both on its own (efficiency) and on bitrate, so only the pick can choose H.264.
  const levels = () => [
    level('av1', {videoCodec: 'av01.0.08M.08', bitrate: 6e6, decoding: HW}),
    level('h264', {videoCodec: 'avc1.64001f', bitrate: 5e6, decoding: HW}),
  ];

  it('is remembered as a codec type, so another profile of it matches', () => {
    // The pick saved "avc1.640028"; this stream's H.264 is "avc1.64001f". The exact
    // string never matched.
    const m = manager({source: site('https://www.video.example/watch/1')});
    m.setPrioritizedVideoCodec('avc1.640028');
    expect(pick(m, levels())).toBe('h264');
  });

  it('applies only to the site it was picked on', () => {
    const shared = {};
    const onA = manager({source: site('https://a.example/')});
    onA.videoCodecFamilyBySite = shared;
    onA.setPrioritizedVideoCodec('avc1.640028');

    const onB = manager({source: site('https://b.example/')});
    onB.videoCodecFamilyBySite = shared;
    expect(pick(onB, levels())).toBe('av1');
    expect(pick(onA, levels())).toBe('h264');
  });

  it('keys a site by its page, without "www.", and falls back to the stream host', () => {
    expect(manager({source: site('https://www.video.example/x')}).getSiteKey()).toBe('video.example');
    expect(manager({source: {url: 'https://cdn.example.net/a.mpd', headers: {origin: 'https://player.example'}}}).getSiteKey()).toBe('player.example');
    expect(manager({source: site(null)}).getSiteKey()).toBe('cdn.example.net');
    expect(manager({source: {url: undefined, headers: {}}}).getSiteKey()).toBe(null);
    expect(manager().getSiteKey()).toBe(null);
  });

  it('forgets the oldest sites past 200', () => {
    const m = manager();
    for (let i = 0; i < 205; i++) {
      m.client.source = site(`https://site${i}.example/`);
      m.setPrioritizedVideoCodec('avc1.640028');
    }
    const sites = Object.keys(m.videoCodecFamilyBySite);
    expect(sites.length).toBe(200);
    expect(sites[0]).toBe('site5.example');
    expect(sites[199]).toBe('site204.example');
  });

  it('ignores a codec it does not know', () => {
    const m = manager({source: site('https://a.example/')});
    m.setPrioritizedVideoCodec('xyz1.0');
    expect(m.videoCodecFamilyBySite).toEqual({});
  });

  // What the quality menu remembers of a click (rememberVideoChoice, with the versions of
  // the size it was picked from). Every click on a quality with one version, and every
  // pick among versions that differ only in bitrate, saved that version's codec family for
  // the site, and the family outranked the hardware decoder at every height there: one
  // click on a 360p that only came in H.264 got the software H.264 1080p from then on.
  const ladder = () => [
    level('360p', {width: 640, height: 360, bitrate: 8e5, videoCodec: 'avc1.4d401e', decoding: HW}),
    level('h264-sw', {videoCodec: 'avc1.640028', bitrate: 6e6, decoding: SW}),
    level('hevc-hw', {videoCodec: 'hvc1.1.6.L120.90', bitrate: 4e6, decoding: HW}),
  ];

  it('is not taken from a quality that has one version, though its container still is', () => {
    const m = manager({source: site('https://a.example/')});
    const only = level('360p', {width: 640, height: 360, videoCodec: 'avc1.4d401e', mimeType: 'video/webm'});
    m.rememberVideoChoice(only, [only]);
    expect(m.videoCodecFamilyBySite).toEqual({});
    expect(m.prioritizedVideoContainer).toBe('webm');
    expect(pick(m, ladder())).toBe('hevc-hw');
  });

  it('is not taken from versions that differ only in bitrate', () => {
    const m = manager({source: site('https://a.example/')});
    const versions = [
      level('h264-hi', {videoCodec: 'avc1.640028', bitrate: 6e6}),
      level('h264-lo', {videoCodec: 'avc1.64001f', bitrate: 3e6}),
      // A version whose codec is not known is no other codec.
      level('unknown', {videoCodec: null, bitrate: 2e6}),
    ];
    m.rememberVideoChoice(versions[1], versions);
    expect(m.videoCodecFamilyBySite).toEqual({});
    expect(pick(m, ladder())).toBe('hevc-hw');
  });

  it('is taken from a pick between codecs, for that site', () => {
    const m = manager({source: site('https://a.example/')});
    const versions = ladder().filter((version) => version.height === 1080);
    m.rememberVideoChoice(versions[0], versions);
    expect(m.videoCodecFamilyBySite).toEqual({'a.example': 'avc'});
    expect(pick(m, ladder())).toBe('h264-sw');
  });
});

describe('codec preferences, loaded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const load = (saved) => {
    vi.stubGlobal('localStorage', {getItem: () => JSON.stringify(saved)});
    const m = {};
    LevelManager.prototype.loadPreferences.call(m);
    return m;
  };

  it('loads the per-site codec types', () => {
    expect(load({videoCodecFamilyBySite: {'a.example': 'avc'}}).videoCodecFamilyBySite).toEqual({'a.example': 'avc'});
  });

  it('drops the old global exact codec and anything malformed', () => {
    const m = load({prioritizedVideoCodec: 'avc1.640028', videoCodecFamilyBySite: ['x']});
    expect(m.videoCodecFamilyBySite).toEqual({});
    expect(m.prioritizedVideoCodec).toBeUndefined();
  });
});

describe('picking audio', () => {
  it('skips audio Firefox cannot play, however high its bitrate', () => {
    const levels = [
      audio('eac3', {audioCodec: 'ec-3', bitrate: 640000, decoding: {supported: false, smooth: false, powerEfficient: false}}),
      audio('aac', {audioCodec: 'mp4a.40.2', bitrate: 128000, decoding: {supported: true, smooth: true, powerEfficient: true}}),
    ];
    expect(manager().pickAudioLevel(levels).id).toBe('aac');
  });

  it('keeps unplayable audio when it is all there is', () => {
    const levels = [audio('eac3', {audioCodec: 'ec-3', decoding: {supported: false, smooth: false, powerEfficient: false}})];
    expect(manager().pickAudioLevel(levels).id).toBe('eac3');
  });

  it('keeps audio without an answer', () => {
    const levels = [audio('a', {bitrate: 96000}), audio('b', {bitrate: 192000})];
    expect(manager().pickAudioLevel(levels).id).toBe('b');
  });

  it('goes back to the bitrate when the option is off', () => {
    const levels = [
      audio('eac3', {audioCodec: 'ec-3', bitrate: 640000, decoding: {supported: false, smooth: false, powerEfficient: false}}),
      audio('aac', {bitrate: 128000}),
    ];
    expect(manager({decodingAwareQuality: false}).pickAudioLevel(levels).id).toBe('eac3');
  });
});
