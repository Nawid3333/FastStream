import {afterEach, describe, expect, it, vi} from 'vitest';
import {playerOnFakeElement} from './helpers/fakeMediaElement.mjs';

// The seek preview of a fragmented MP4 without its duration in the metadata (no mehd box, as
// ffmpeg's frag_keyframe+empty_moov writes it): the preview knows only as much of the file as it
// has read, and reads only up to its first frame - about 9 s of a 160 s file. A place past that
// was clamped by the element to the 9 s it knew, and every place past 9 s showed the frame at 9 s.

const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A seek preview of such a file once its first frame is shown: 9 s known and buffered, of a
 * 17 MB file whose last range it has not read.
 * @return {{player: Object, video: Object}}
 */
function previewOfFragmentedFile() {
  const {player, video} = playerOnFakeElement(MP4Player, vi.stubGlobal, {isPreview: true});
  Object.assign(player, {running: true, loaded: true, fileLength: 17000000, _duration: 9});
  player.metaData = {isFragmented: true, tracks: [], videoTracks: [], audioTracks: []};
  video.duration = 9;
  video.ranges = [[0, 9]];
  const store = [];
  for (let i = 0; i < 17; i++) store.push({sn: i, rangeStart: i * 1000000, rangeEnd: (i + 1) * 1000000, status: 0});
  player.client = {getFragment: (level, sn) => store[sn], getFragments: () => store};
  vi.spyOn(player.fragmentRequester, 'requestFragment').mockReturnValue({abort() {}});
  vi.spyOn(player, 'resetHLS').mockImplementation(() => {});
  return {player, video};
}

describe('MP4Player, the seek preview of a fragmented file without its duration', () => {
  it('holds a place past the duration it knows, and reads on to learn it', () => {
    const {player, video} = previewOfFragmentedFile();
    player.currentTime = 120;
    // Not clamped to the 9 s it knows: the place waits, and the preview says where it is going.
    expect(video.currentTime).toBe(0);
    expect(player.currentTime).toBe(120);
    // It has its first frame (readyState 2), and reads on all the same.
    player.runLoad();
    expect(player.fragmentRequester.requestFragment).toHaveBeenCalledTimes(1);
  });

  it('seeks there once the duration it knows has reached the place', () => {
    const {player, video} = previewOfFragmentedFile();
    player.currentTime = 120;
    // The ranges read on the way: the duration grows, as onSegment's updateDuration sets it.
    player._duration = 60;
    player.runLoad();
    expect(video.currentTime).toBe(0);
    player._duration = 125;
    video.duration = 125;
    player.runLoad();
    expect(video.currentTime).toBe(120);
    expect(player.currentTime).toBe(120);
    expect(player.resetHLS).toHaveBeenCalledTimes(1);
  });

  it('seeks once the file\'s end is in, a place past its end too', () => {
    const {player, video} = previewOfFragmentedFile();
    player.currentTime = 170;
    player._duration = 160;
    video.duration = 160;
    player.currentFragments.push({rangeEnd: 17000000, removeReference() {}});
    player.runLoad();
    // The element lands a seek past its duration on that duration.
    expect(video.currentTime).toBe(160);
    expect(player.currentTime).toBe(160);
  });

  it('forgets the place for one it knows', () => {
    const {player, video} = previewOfFragmentedFile();
    player.currentTime = 120;
    player.currentTime = 5;
    expect(video.currentTime).toBe(5);
    expect(player.currentTime).toBe(5);
    // 5 s is buffered: nothing more to read, as before.
    player.runLoad();
    expect(player.fragmentRequester.requestFragment).not.toHaveBeenCalled();
  });

  it('appends nothing it reads on the way: the seek\'s reset takes it away again', () => {
    const {player} = previewOfFragmentedFile();
    player.metaData.videoTracks = [{id: 1, codec: 'avc1.42E01E'}];
    player.currentAudioTrack = null;
    player.videoSourceBuffer = {appendBuffer: () => Promise.resolve(), hasPendingRemove: () => false};
    player.mp4box = {
      fragmentedTracks: [], setSegmentOptions: vi.fn(), initializeSegmentation: () => [{buffer: new ArrayBuffer(1)}],
      seek: vi.fn(), start: vi.fn(), getTrackById: () => ({samples_stored: []}), releaseSample: vi.fn(),
    };
    vi.spyOn(player.segmentAppender, 'append').mockImplementation(() => {});
    vi.spyOn(player, 'updateDuration').mockImplementation(() => {});
    player.startSegmentation();

    player.currentTime = 120;
    player.mp4box.onSegment(1, 1, new ArrayBuffer(1), 2, false);
    expect(player.segmentAppender.append).not.toHaveBeenCalled();
    // Its duration still grows with what is read.
    expect(player.updateDuration).toHaveBeenCalledTimes(1);

    player.currentTime = 5;
    player.mp4box.onSegment(1, 1, new ArrayBuffer(1), 3, false);
    expect(player.segmentAppender.append).toHaveBeenCalledTimes(1);
  });

  it('leaves the main player\'s seeks as they were: the element lands them on its duration', () => {
    const {player, video} = playerOnFakeElement(MP4Player, vi.stubGlobal);
    Object.assign(player, {running: true, loaded: true, fileLength: 17000000, _duration: 9});
    player.metaData = {isFragmented: true, tracks: []};
    video.duration = 9;
    vi.spyOn(player, 'resetHLS').mockImplementation(() => {});
    player.currentTime = 120;
    expect(video.currentTime).toBe(9);
  });
});
