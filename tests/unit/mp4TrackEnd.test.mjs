import {describe, expect, it, vi} from 'vitest';

// A seek past the end of one of a file's tracks - its sound ends 2 s before its picture, say,
// and the user presses End. mp4box's seek leaves a track that ends before the time where it
// was (ISOFile.seek: `if (time > this.getTrackDuration(trak)) continue`), at a place whose
// bytes the seek's reset threw away and nothing loads again: the track never finished, the
// MediaSource never ended, and Firefox waited at the seek for good. These run MP4Player's own
// segmentation and reset on the real mp4box (the npm build, vitest.config.mjs), reading a file
// its writer makes: a picture of 20 one-second frames, a sound of 18.

const {createFile} = await import('../../chrome/player/modules/mp4box/mp4box.all.mjs');
const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');
const {keyframeOffset} = await import('../../chrome/player/players/mp4/SampleIndex.mjs');

/**
 * A fragmented MP4 whose tracks end apart, their samples interleaved as a muxer writes them.
 * @param {number} videoSeconds
 * @param {number} audioSeconds
 * @return {ArrayBuffer}
 */
function fileWithTracksEndingApart(videoSeconds, audioSeconds) {
  const out = createFile();
  const video = out.addTrack({type: 'avc1', timescale: 1000, width: 64, height: 64});
  const audio = out.addTrack({type: 'mp4a', hdlr: 'soun', timescale: 1000, samplerate: 48000});
  for (let i = 0; i < Math.max(videoSeconds, audioSeconds); i++) {
    const at = {duration: 1000, dts: i * 1000, cts: i * 1000, is_sync: true};
    if (i < videoSeconds) out.addSample(video, new Uint8Array(40000), at);
    if (i < audioSeconds) out.addSample(audio, new Uint8Array(10000), at);
  }
  const written = out.getBuffer();
  return written.buffer.slice(0, written.byteLength);
}

/**
 * A player with what segmentation, a reset and the end of the stream reach, on a real mp4box.
 * @param {ArrayBuffer} file
 * @return {Object} The player and a way to give its mp4box a part of the file.
 */
function playerOf(file) {
  const idle = () => ({updating: false, sourceBuffer: {updating: false}, toDo: [],
    appendBuffer: () => Promise.resolve(), dropQueuedMedia() {}});
  const player = Object.create(MP4Player.prototype);
  Object.assign(player, {
    isPreview: false, isAudioOnly: false, nothingToPreview: false, loader: null, pendingSeek: null,
    currentVideoTrack: 0, currentAudioTrack: 0, fileLength: file.byteLength,
    currentFragments: [], rangeRetries: new Map(), fedRanges: new Map(),
    video: {currentTime: 0, duration: 20},
    mediaSource: {readyState: 'open', endOfStream: vi.fn()},
    videoSourceBuffer: idle(), audioSourceBuffer: idle(),
    segmentAppender: {append: vi.fn(), reloaded: vi.fn()},
    removeFromBuffers: vi.fn(),
    updateDuration: vi.fn(),
    mp4box: createFile(false),
  });
  player.mp4box.onReady = (info) => {
    player.metaData = info;
    player.startSegmentation();
  };
  /**
   * @param {number} start
   * @param {number} [end]
   */
  const feed = (start, end = file.byteLength) => {
    const part = /** @type {ArrayBuffer & {fileStart: number}} */ (file.slice(start, end));
    part.fileStart = start;
    player.mp4box.appendBuffer(part);
  };
  return {player, feed};
}

/**
 * The tracks' sync samples, as the player's keyframe index has them.
 * @param {Object} player
 * @return {Array<Array<Object>>}
 */
const keyframes = (player) => player.mp4box.fragmentedTracks.map(({trak}) => trak.samples.filter((sample) => sample.is_sync));

/**
 * A seek as the player makes one: the element goes there, and the reset takes mp4box there.
 * @param {Object} player
 * @param {number} time
 */
function seek(player, time) {
  player.video.currentTime = time;
  player.resetHLS(true);
}

/**
 * Where runLoad reads from after a seek: the earliest keyframe at or before the time.
 * @param {Object} player
 * @param {number} time
 * @return {number}
 */
const readFrom = (player, time) => /** @type {number} */ (keyframeOffset(keyframes(player), time));

describe('MP4Player, a seek past the end of one of its tracks', () => {
  /**
   * The file played at 5 s, every sample of it known (as a regular MP4's moov lists them).
   * @return {{player: Object, feed: Function, file: ArrayBuffer}}
   */
  function playingAtFive() {
    const file = fileWithTracksEndingApart(20, 18);
    const {player, feed} = playerOf(file);
    feed(0);
    seek(player, 5);
    // The range from there on, the next two seconds of it.
    feed(readFrom(player, 5), readFrom(player, 7));
    return {player, feed, file};
  }

  it('finishes the track that ended, so the stream can end and the seek completes', () => {
    const {player, feed, file} = playingAtFive();
    // End: the last half second, past the sound's end.
    seek(player, 19.5);
    feed(readFrom(player, 19.5));
    player.currentFragments.push({rangeEnd: file.byteLength});

    const finished = player.mp4box.fragmentedTracks.map(({trak}) => trak.nextSample === trak.samples.length);
    expect(finished).toEqual([true, true]);
    player.checkEndOfStream();
    expect(player.mediaSource.endOfStream).toHaveBeenCalledTimes(1);
  });

  it('leaves the tracks where a seek inside both of them puts them', () => {
    const {player} = playingAtFive();
    seek(player, 10.5);
    // Each at its sample at 10 s, nothing appended from there yet.
    expect(player.mp4box.fragmentedTracks.map(({trak}) => trak.nextSample)).toEqual([10, 10]);
  });
});
