import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  PROBE_TIMEOUT_MS,
  audioProbeFor,
  bareCodec,
  cachedAnswer,
  clearDecodingCache,
  describeDashRepresentation,
  getCodecDisplayName,
  getCodecEfficiency,
  getCodecFamily,
  getDecodingLabel,
  parseFrameRate,
  probeDecoding,
  screenSupportsHdr,
  toDecodingConfiguration,
  videoProbeFor,
} from '../../chrome/player/players/DecodingCapabilities.mjs';
import {DashTrackUtils} from '../../chrome/player/players/dash/DashTrackUtils.mjs';

describe('codec strings', () => {
  it('takes the first codec out of a bare string, a list or a MIME type', () => {
    expect(bareCodec('avc1.640028')).toBe('avc1.640028');
    expect(bareCodec('avc1.640028,mp4a.40.2')).toBe('avc1.640028');
    expect(bareCodec('audio/mp4; codecs="mp4a.40.2"')).toBe('mp4a.40.2');
    expect(bareCodec('video/webm;codecs=vp9')).toBe('vp9');
    expect(bareCodec('video/mp4')).toBe(null);
    expect(bareCodec('')).toBe(null);
    expect(bareCodec(null)).toBe(null);
  });

  it('knows each codec\'s family by its four-character code', () => {
    expect(getCodecFamily('av01.0.08M.08')).toBe('av1');
    expect(getCodecFamily('vp09.00.40.08')).toBe('vp9');
    expect(getCodecFamily('hvc1.2.4.L153.B0')).toBe('hevc');
    expect(getCodecFamily('hev1.1.6.L93.B0')).toBe('hevc');
    expect(getCodecFamily('dvh1.05.06')).toBe('dolbyvision');
    expect(getCodecFamily('avc1.64001f')).toBe('avc');
    expect(getCodecFamily('avc3.640028')).toBe('avc');
    expect(getCodecFamily('audio/mp4; codecs="mp4a.40.2"')).toBe('aac');
    expect(getCodecFamily('ec-3')).toBe('eac3');
    expect(getCodecFamily('fLaC')).toBe('flac');
    expect(getCodecFamily('xyz1.0')).toBe(null);
  });

  it('ranks AV1 above VP9 and HEVC, those above H.264, and the rest at 0', () => {
    expect(getCodecEfficiency('av1')).toBeGreaterThan(getCodecEfficiency('vp9'));
    expect(getCodecEfficiency('vp9')).toBe(getCodecEfficiency('hevc'));
    expect(getCodecEfficiency('hevc')).toBeGreaterThan(getCodecEfficiency('avc'));
    expect(getCodecEfficiency('avc')).toBeGreaterThan(0);
    expect(getCodecEfficiency('dolbyvision')).toBe(0);
    expect(getCodecEfficiency(null)).toBe(0);
  });
});

describe('the quality menu', () => {
  it('names video codecs, and nothing else', () => {
    expect(getCodecDisplayName('av01.0.08M.08')).toBe('AV1');
    expect(getCodecDisplayName('avc1.640028')).toBe('H.264');
    expect(getCodecDisplayName('hev1.1.6.L93.B0')).toBe('HEVC');
    expect(getCodecDisplayName('mp4a.40.2')).toBe(null);
    expect(getCodecDisplayName(null)).toBe(null);
  });

  it('labels hardware, software, or nothing without a usable answer', () => {
    expect(getDecodingLabel({supported: true, smooth: true, powerEfficient: true})).toBe('hardware');
    expect(getDecodingLabel({supported: true, smooth: true, powerEfficient: false})).toBe('software');
    expect(getDecodingLabel({supported: false, smooth: false, powerEfficient: false})).toBe(null);
    expect(getDecodingLabel(null)).toBe(null);
  });
});

describe('frame rates', () => {
  it('reads DASH fractions and plain numbers', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('25')).toBe(25);
    expect(parseFrameRate(59.94)).toBe(59.94);
  });

  it('is 0 when unknown or nonsense', () => {
    for (const value of [undefined, null, '', 'abc', '30/0', '-5', 0, NaN, Infinity]) {
      expect(parseFrameRate(value)).toBe(0);
    }
  });
});

describe('a DASH representation', () => {
  it('reads its type, codec, size, rate and frame rate', () => {
    const info = describeDashRepresentation({
      mimeType: 'video/mp4', codecs: 'av01.0.08M.08', width: 1920, height: 1080,
      bandwidth: 2500000, frameRate: '30000/1001',
    });
    expect(info).toMatchObject({type: 'video', codec: 'av01.0.08M.08', width: 1920, height: 1080, bitrate: 2500000, videoRange: 'SDR'});
    expect(info.frameRate).toBeCloseTo(29.97, 2);
  });

  it('reads PQ and HLG from the transfer characteristics, as one descriptor or a list', () => {
    const scheme = 'urn:mpeg:mpegB:cicp:TransferCharacteristics';
    expect(describeDashRepresentation({mimeType: 'video/mp4', codecs: 'hvc1.2.4.L153.B0',
      EssentialProperty: {schemeIdUri: scheme, value: '16'}}).videoRange).toBe('PQ');
    expect(describeDashRepresentation({mimeType: 'video/mp4', codecs: 'hvc1.2.4.L153.B0',
      SupplementalProperty: [{schemeIdUri: 'urn:other', value: '1'}, {schemeIdUri: scheme, value: 18}]}).videoRange).toBe('HLG');
    expect(describeDashRepresentation({mimeType: 'video/mp4', codecs: 'hvc1.1.6.L93.B0',
      EssentialProperty: {schemeIdUri: scheme, value: '1'}}).videoRange).toBe('SDR');
  });

  it('counts Dolby Vision as HDR', () => {
    expect(describeDashRepresentation({mimeType: 'video/mp4', codecs: 'dvh1.05.06'}).videoRange).toBe('PQ');
  });

  it('tells audio from video, by MIME type or else by codec', () => {
    expect(describeDashRepresentation({mimeType: 'audio/mp4', codecs: 'mp4a.40.2'}).type).toBe('audio');
    expect(describeDashRepresentation({codecs: 'avc1.640028'}).type).toBe('video');
    expect(describeDashRepresentation({codecs: 'opus'}).type).toBe('audio');
    expect(describeDashRepresentation({mimeType: 'text/vtt'}).type).toBe(null);
    expect(describeDashRepresentation(null).type).toBe(null);
  });
});

describe('what is asked', () => {
  it('asks about MP4 unless the version is WebM, as MSE gets it', () => {
    expect(videoProbeFor({codec: 'avc1.640028', mimeType: null}).contentType).toBe('video/mp4; codecs="avc1.640028"');
    expect(videoProbeFor({codec: 'vp09.00.40.08', mimeType: 'video/webm'}).contentType).toBe('video/webm; codecs="vp09.00.40.08"');
    expect(audioProbeFor({codec: 'audio/mp4; codecs="mp4a.40.2"'}).contentType).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it('fills what a manifest leaves out, and asks nothing without a codec', () => {
    expect(videoProbeFor({codec: 'avc1.640028'})).toEqual({
      contentType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30, videoRange: 'SDR',
    });
    expect(videoProbeFor({codec: null})).toBe(null);
    expect(audioProbeFor({codec: undefined})).toBe(null);
  });

  it('asks about HDR with its transfer function and the BT.2020 gamut', () => {
    const config = toDecodingConfiguration(videoProbeFor({codec: 'av01.0.08M.10', videoRange: 'PQ'}));
    expect(config).toMatchObject({type: 'media-source', video: {transferFunction: 'pq', colorGamut: 'rec2020'}});
    expect(toDecodingConfiguration(videoProbeFor({codec: 'av01.0.08M.10', videoRange: 'HLG'})).video.transferFunction).toBe('hlg');
    expect(toDecodingConfiguration(videoProbeFor({codec: 'avc1.640028'})).video.transferFunction).toBeUndefined();
  });
});

describe('asking Firefox', () => {
  const HW = {supported: true, smooth: true, powerEfficient: true};

  beforeEach(() => {
    clearDecodingCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearDecodingCache();
  });

  const stubDecodingInfo = (impl) => {
    const decodingInfo = vi.fn(impl);
    vi.stubGlobal('navigator', {mediaCapabilities: {decodingInfo}});
    return decodingInfo;
  };

  it('asks once per version and keeps the answer for the synchronous pick', async () => {
    const decodingInfo = stubDecodingInfo(async () => HW);
    const probe = videoProbeFor({codec: 'av01.0.08M.08', width: 1920, height: 1080, bitrate: 2e6, frameRate: 30});
    expect(cachedAnswer(probe)).toBe(null);
    const [a, b] = await Promise.all([probeDecoding(probe), probeDecoding({...probe})]);
    expect(a).toEqual(HW);
    expect(b).toEqual(HW);
    expect(decodingInfo).toHaveBeenCalledTimes(1);
    expect(decodingInfo.mock.calls[0][0]).toEqual({type: 'media-source', video: {
      contentType: 'video/mp4; codecs="av01.0.08M.08"', width: 1920, height: 1080, bitrate: 2e6, framerate: 30,
    }});
    expect(cachedAnswer(probe)).toEqual(HW);
  });

  it('answers null without the API', async () => {
    vi.stubGlobal('navigator', {});
    expect(await probeDecoding(videoProbeFor({codec: 'avc1.640028'}))).toBe(null);
    expect(await probeDecoding(null)).toBe(null);
  });

  it('answers null when Firefox throws or rejects, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubDecodingInfo(() => {
      throw new TypeError('bad configuration');
    });
    expect(await probeDecoding(videoProbeFor({codec: 'avc1.640028'}))).toBe(null);
    stubDecodingInfo(async () => {
      throw new Error('rejected');
    });
    expect(await probeDecoding(videoProbeFor({codec: 'avc1.4d401f'}))).toBe(null);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('gives up on a probe that never answers, and asks again next time', async () => {
    vi.useFakeTimers();
    const decodingInfo = stubDecodingInfo(() => new Promise(() => {}));
    const probe = videoProbeFor({codec: 'avc1.640028'});
    const pending = probeDecoding(probe);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(await pending).toBe(null);
    expect(cachedAnswer(probe)).toBe(null);
    probeDecoding(probe);
    await vi.advanceTimersByTimeAsync(0);
    expect(decodingInfo).toHaveBeenCalledTimes(2);
  });

  it('keeps an answer that comes after the probe gave up, and does not ask again', async () => {
    // The pick goes on without it, but the quality menu, the next pick and a live
    // manifest's refresh read it. It was dropped: a version whose answer took longer than
    // the wait never had one, and every refresh asked again and waited again.
    vi.useFakeTimers();
    const decodingInfo = stubDecodingInfo(() => new Promise((resolve) => {
      setTimeout(() => resolve(HW), PROBE_TIMEOUT_MS + 200);
    }));
    const probe = videoProbeFor({codec: 'av01.0.08M.08'});
    const pending = probeDecoding(probe);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    // The start-up wait is the same.
    expect(await pending).toBe(null);
    expect(cachedAnswer(probe)).toBe(null);

    await vi.advanceTimersByTimeAsync(200);
    expect(cachedAnswer(probe)).toEqual(HW);
    expect(await probeDecoding(probe)).toEqual(HW);
    expect(decodingInfo).toHaveBeenCalledTimes(1);
  });

  it('turns a partial answer into booleans', async () => {
    stubDecodingInfo(async () => ({supported: true}));
    expect(await probeDecoding(audioProbeFor({codec: 'mp4a.40.2'}))).toEqual({supported: true, smooth: false, powerEfficient: false});
  });
});

describe('the screen', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows HDR only when (dynamic-range: high) matches', () => {
    vi.stubGlobal('matchMedia', (query) => ({matches: query === '(dynamic-range: high)'}));
    expect(screenSupportsHdr()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({matches: false}));
    expect(screenSupportsHdr()).toBe(false);
    vi.stubGlobal('matchMedia', () => {
      throw new Error('no');
    });
    expect(screenSupportsHdr()).toBe(false);
  });
});

describe('DASH levels', () => {
  beforeEach(() => {
    clearDecodingCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearDecodingCache();
  });

  it('carry the frame rate, range and answer the capability filter found', async () => {
    vi.stubGlobal('navigator', {mediaCapabilities: {decodingInfo: async () => ({supported: true, smooth: true, powerEfficient: true})}});
    const probe = videoProbeFor({codec: 'av01.0.08M.10', width: 3840, height: 2160, bitrate: 1e7, frameRate: 60, videoRange: 'PQ'});
    await probeDecoding(probe);
    const details = new Map([['video-r1', {probe, frameRate: 60, videoRange: 'PQ'}]]);
    const track = {
      mimeType: 'video/mp4', lang: 'en', codec: 'video/mp4;codecs="av01.0.08M.10"',
      bitrateList: [{id: 'r1', width: 3840, height: 2160, bandwidth: 1e7}, {id: 'r2', width: 1920, height: 1080, bandwidth: 4e6}],
    };
    const levels = DashTrackUtils.getVideoLevelList([track], details);
    expect(levels.get('video-r1')).toMatchObject({frameRate: 60, videoRange: 'PQ', decoding: {powerEfficient: true}});
    expect(levels.get('video-r2')).toMatchObject({frameRate: 0, videoRange: 'SDR', decoding: null});
    // Without details, as before.
    expect(DashTrackUtils.getVideoLevelList([track]).get('video-r1').decoding).toBe(null);
  });
});
