import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// An MP4Player made for sound only (isAudioOnly: the two a video delay adds, SyncedAudioPlayer,
// and the audio analyzer's) played the file's picture as well: a video SourceBuffer in its
// <audio>, every frame cut into a segment by mp4box and appended, about 30 s ahead and 10 s
// behind of video in each - the MediaSource memory and the per-frame work three times over
// with a video delay. The seek preview leaves out the sound the same way (currentAudioTrack
// null). These run the player's SourceBuffer, segmentation and keyframe choices on stand-ins.

const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');

const originalMediaSource = globalThis.MediaSource;
const VIDEO = {id: 1, codec: 'avc1.42E01E'};
const AUDIO = {id: 2, codec: 'mp4a.40.2'};

beforeEach(() => {
  // Node has no MediaSource; SourceBufferWrapper asks it whether the codec plays.
  globalThis.MediaSource = {isTypeSupported: () => true};
});

afterEach(() => {
  globalThis.MediaSource = originalMediaSource;
  vi.restoreAllMocks();
});

/**
 * A player of a file with these tracks, its MediaSource and mp4box stood in for.
 * @param {{isAudioOnly?: boolean, isPreview?: boolean}} config
 * @param {{videoTracks: Array<Object>, audioTracks: Array<Object>}} tracks
 * @return {Object}
 */
function playerOf(config, tracks) {
  const player = Object.create(MP4Player.prototype);
  Object.assign(player, {
    isAudioOnly: !!config.isAudioOnly, isPreview: !!config.isPreview, pendingSeek: null, previewSeek: null,
    currentVideoTrack: 0, currentAudioTrack: config.isPreview ? null : 0,
    metaData: tracks,
    video: {currentTime: 0},
    mediaSource: {addSourceBuffer: vi.fn(() => Object.assign(new EventTarget(), {updating: false, appendBuffer: vi.fn()}))},
    mp4box: {
      fragmentedTracks: [], setSegmentOptions: vi.fn(), seek: vi.fn(), start: vi.fn(), getTrackById: () => undefined,
      initializeSegmentation: vi.fn(() => player.mp4box.setSegmentOptions.mock.calls.map(() => ({buffer: new ArrayBuffer(1)}))),
    },
  });
  return player;
}

/**
 * The SourceBuffers a player makes and the tracks it has mp4box cut into segments.
 * @param {Object} player
 * @return {{sourceBuffers: string[], segmented: number[]}}
 */
function setUp(player) {
  player.makeSourceBuffers();
  player.startSegmentation();
  return {
    sourceBuffers: player.mediaSource.addSourceBuffer.mock.calls.map(([type]) => type),
    segmented: player.mp4box.setSegmentOptions.mock.calls.map(([id]) => id),
  };
}

describe('MP4Player for sound only', () => {
  it('makes no video SourceBuffer and cuts no video into segments', () => {
    const player = playerOf({isAudioOnly: true}, {videoTracks: [VIDEO], audioTracks: [AUDIO]});
    expect(setUp(player)).toEqual({sourceBuffers: ['audio/mp4; codecs="mp4a.40.2"'], segmented: [2]});
    expect(player.videoSourceBuffer).toBeUndefined();
  });

  it('reads from the sound\'s place, not from the picture\'s keyframe before it', () => {
    const player = playerOf({isAudioOnly: true}, {videoTracks: [VIDEO], audioTracks: [AUDIO]});
    // A picture with keyframes 8 s apart, the sound's samples all sync.
    const sample = (seconds, offset) => ({cts: seconds * 1000, timescale: 1000, offset, is_sync: true});
    player.videoTracks = [{sortedSamples: [sample(0, 1000), sample(8, 8000000)]}];
    player.audioTracks = [{sortedSamples: [sample(0, 900), sample(6, 6000000), sample(7, 7000000)]}];
    player.client = {getFragment: (level, sn) => ({sn})};
    player.video.currentTime = 7.5;
    expect(player.currentFragment.sn).toBe(7);
    // The main player reads from the picture's keyframe, as before.
    const main = playerOf({}, {videoTracks: [VIDEO], audioTracks: [AUDIO]});
    Object.assign(main, {videoTracks: player.videoTracks, audioTracks: player.audioTracks, client: player.client});
    main.video.currentTime = 7.5;
    expect(main.currentFragment.sn).toBe(0);
  });

  it('plays the picture of a file without sound, as before: it has nothing else', () => {
    const player = playerOf({isAudioOnly: true}, {videoTracks: [VIDEO], audioTracks: []});
    expect(setUp(player)).toEqual({sourceBuffers: ['video/mp4; codecs="avc1.42E01E"'], segmented: [1]});
  });

  it('leaves the main player, the preview and a file without a picture as they were', () => {
    expect(setUp(playerOf({}, {videoTracks: [VIDEO], audioTracks: [AUDIO]}))).toEqual({
      sourceBuffers: ['video/mp4; codecs="avc1.42E01E"', 'audio/mp4; codecs="mp4a.40.2"'], segmented: [1, 2]});
    expect(setUp(playerOf({isPreview: true}, {videoTracks: [VIDEO], audioTracks: [AUDIO]}))).toEqual({
      sourceBuffers: ['video/mp4; codecs="avc1.42E01E"'], segmented: [1]});
    expect(setUp(playerOf({isAudioOnly: true}, {videoTracks: [], audioTracks: [AUDIO]}))).toEqual({
      sourceBuffers: ['audio/mp4; codecs="mp4a.40.2"'], segmented: [2]});
  });
});
