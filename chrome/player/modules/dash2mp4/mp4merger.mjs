// @ts-check
import {EventEmitter} from '../eventemitter.mjs';
import {createFile, DataStream, Endianness} from '../mp4box/mp4box.all.mjs';
import {MP4} from '../hls2mp4/MP4Generator.mjs';
import {FSBlob} from '../FSBlob.mjs';
import {SaveFile} from '../SaveFile.mjs';

/** @typedef {import('../mp4box/mp4box.all.mjs').ISOFile} ISOFile */
/** @typedef {import('../mp4box/mp4box.all.mjs').SampleEntry} SampleEntry */
/** @typedef {import('../mp4box/mp4box.all.mjs').MP4BoxBuffer} MP4BoxBuffer */

/**
 * @typedef {ISOFile['moov']['traks'][number]} TrakBox
 */

/**
 * @typedef {ReturnType<typeof createMp4Sample>} OutputSample
 */

/**
 * One fragment's part of a track; times in the track's timescale.
 * @typedef {{id: number, samples: Array<OutputSample>, samplesDuration: number, offset: number,
 *   originalOffset: number, startPTS: number, endPTS: number, baseDecodeTime: number}} MergerChunk
 */

/**
 * @typedef {{type: 'video'|'audio', id: number, sourceTrackId: number, timescale: number,
 *   duration: number, samples: Array<OutputSample>, chunks: Array<MergerChunk>,
 *   presentedDuration?: number,
 *   use64Offsets: boolean, nextChunkId: number, elst: Array<{media_time: number, segment_duration: number}>,
 *   trexs: NonNullable<ISOFile['moov']['mvex']>['trexs'], codecBuffer: ArrayBuffer,
 *   movieTimescale?: number, width?: number, height?: number, pixelRatio?: Array<number>,
 *   sps?: Array<Uint8Array>, pps?: Array<Uint8Array>, segmentCodec?: null}} MergerTrack
 */

/**
 * track: 0 the video, 1 the audio.
 * @typedef {{track: number, fragment: import('../../players/dash/DashFragment.mjs').DashFragment,
 *   getEntry: (options?: {keepPinned?: boolean}) => ReturnType<typeof import('../../players/SaveFragmentFetcher.mjs').savedEntry>}} ZippedFragment
 */

const VideoCodecs = ['avc1', 'avc2', 'avc3', 'avc4', 'av01', 'dav1', 'hvc1', 'hev1', 'hvt1', 'lhe1', 'dvh1', 'dvhe', 'vvc1', 'vvi1', 'vvs1', 'vvcN', 'vp08', 'vp09', 'avs3', 'j2ki', 'mjp2', 'mjpg', 'uncv'];
const AudioCodecs = ['mp4a', 'ac-3', 'ac-4', 'ec-3', 'Opus', 'mha1', 'mha2', 'mhm1', 'mhm2'];

export class MP4Merger extends EventEmitter {
  /**
   * @param {(cancel: () => void) => void} [registerCancel]
   */
  constructor(registerCancel) {
    super();
    this.blobManager = new FSBlob();
    // Each fragment's media goes to disk as it is read: the player may free its own copy meanwhile.
    this.file = new SaveFile(this.blobManager, 'merge');
    if (registerCancel) {
      registerCancel(() => {
        this.cancel();
      });
    }
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Track IDs are trusted only within one fragment carrying several tracks: separately
   * delivered tracks may share one.
   * @param {number} trackId - The track ID the fragment names.
   * @param {number} trackCount - How many tracks the fragment carries.
   * @param {MergerTrack} defaultTrack - The track the fragment was queued against.
   * @return {MergerTrack|null} The track to append to, or null if it is not one of ours.
   */
  trackForSamples(trackId, trackCount, defaultTrack) {
    if (trackCount < 2) {
      return defaultTrack;
    }

    return [this.videoTrack, this.audioTrack].find((track) => {
      return track && track.sourceTrackId === trackId;
    }) || null;
  }

  /**
   * @param {ZippedFragment} fragData
   * @return {Promise<*>} Its bytes (an ArrayBuffer of its own).
   */
  async readFragment(fragData) {
    const entry = await fragData.getEntry();
    // getDataFromBlob tells the store of data it lost, and the save downloads it again.
    return entry.getDataFromBlob('arraybuffer');
  }

  /**
   * @param {MergerTrack} defaultTrack - The track the fragment was queued against.
   * @param {ZippedFragment} fragData
   * @param {*} data - Its bytes (readFragment).
   * @return {Promise<void>}
   */
  async pushFragment(defaultTrack, fragData, data) {
    data.fileStart = 0;
    const mp4boxfile = createFile(false);
    mp4boxfile.onError = function(module, message) {
      console.log('mp4box error', module, message);
    };

    mp4boxfile.appendBuffer(data);
    mp4boxfile.flush();


    const mdats = mp4boxfile.mdats;
    if (mdats.length !== 1) throw new Error('Unsupported mdat count!');
    if (mp4boxfile.moofs.length !== 1) throw new Error('Unsupported moofs count!');

    const moof = mp4boxfile.moofs[0];
    const mdat = mdats[0];
    // A muxed fragment has one traf and one sidx per track, keyed by track ID.
    const sidxs = /** @type {Array<import('../mp4box/mp4box.all.mjs').Box & {reference_ID: number, earliest_presentation_time: number}>} */ (mp4boxfile.boxes.filter((box) => box.type === 'sidx'));
    const sampleLists = mp4boxfile.getSampleList(moof, defaultTrack.trexs);

    sampleLists.forEach((samplesList) => {
      const track = this.trackForSamples(samplesList.track_id, sampleLists.length, defaultTrack);
      if (!track || samplesList.samples.length === 0) {
        return;
      }

      const traf = moof.trafs.find((candidate) => candidate.tfhd.track_id === samplesList.track_id);
      const baseDecodeTime = traf?.tfdt?.baseMediaDecodeTime || 0;
      // A sidx counts in its own track's timescale: only a single-track fragment lends its
      // lone sidx unchecked.
      const sidx = sidxs.length > 1 || sampleLists.length > 1 ?
        sidxs.find((box) => box.reference_ID === samplesList.track_id) :
        sidxs[0];
      const earliestPresentationTime = sidx ? sidx.earliest_presentation_time : baseDecodeTime;
      const outputSamples = samplesList.samples.map((sample) => {
        return createMp4Sample(sample.is_sync, sample.duration, sample.size, sample.cts - sample.dts);
      });

      if (track.chunks.length > 0) {
        const lastChunk = track.chunks[track.chunks.length - 1];
        if (lastChunk.baseDecodeTime + lastChunk.samplesDuration < baseDecodeTime) {
          console.log('Extending', lastChunk);
          lastChunk.samples[lastChunk.samples.length - 1].duration += baseDecodeTime - (lastChunk.baseDecodeTime + lastChunk.samplesDuration);
        } else if (lastChunk.baseDecodeTime + lastChunk.samplesDuration > baseDecodeTime) {
          console.log('Too long');
        }
      }

      if (samplesList.samples_duration === 0) {
        console.log(track);
        throw new Error('Sample duration is zero!');
      }

      // Measured, not assumed: in a muxed mdat one track's samples follow the other's.
      const offset = /** @type {number} */ (this.datasOffset) + (samplesList.samples[0].offset - /** @type {number} */ (mdat.start));

      track.chunks.push({
        id: track.nextChunkId++,
        samples: outputSamples,
        samplesDuration: samplesList.samples_duration,
        offset,
        originalOffset: offset,
        startPTS: earliestPresentationTime,
        endPTS: earliestPresentationTime + samplesList.samples_duration,
        baseDecodeTime: baseDecodeTime,
      });
    });

    /** @type {number} */ (this.datasOffset) += mdat.size;
    // The buffer is the save's own (readFragment): it goes to disk as it is, not copied.
    const start = /** @type {number} */ (mdat.start);
    await this.file.add(new Uint8Array(/** @type {ArrayBuffer} */ (data)).subarray(start, start + mdat.size), true);
  }

  /**
   * @param {ISOFile} file - The parsed initialization segment.
   * @param {number} duration - Seconds.
   * @return {?MergerTrack} Null if the segment has no usable video.
   */
  makeVideoTrack(file, duration) {
    const found = findTrack(file, VideoCodecs);
    if (!found) {
      return null;
    }

    const {trak, entry} = found;
    return {
      type: 'video',
      id: 1,
      sourceTrackId: trak.tkhd.track_id,
      timescale: trak.mdia.mdhd.timescale,
      duration: duration,
      width: trak.tkhd.width >> 16,
      height: trak.tkhd.height >> 16,
      pixelRatio: [1, 1],
      sps: [],
      pps: [],
      samples: [],
      chunks: [],
      use64Offsets: false,
      nextChunkId: 1,
      elst: [],
      trexs: file.moov?.mvex?.trexs || [],
      codecBuffer: writeSampleEntry(entry),
    };
  }

  /**
   * @param {ISOFile} file - The parsed initialization segment.
   * @param {number} duration - Seconds.
   * @return {?MergerTrack} Null if the segment has no usable audio.
   */
  makeAudioTrack(file, duration) {
    const found = findTrack(file, AudioCodecs);
    if (!found) {
      return null;
    }

    const {trak, entry} = found;
    return {
      type: 'audio',
      id: 2,
      sourceTrackId: trak.tkhd.track_id,
      timescale: trak.mdia.mdhd.timescale,
      duration: duration,
      segmentCodec: null,
      samples: [],
      chunks: [],
      use64Offsets: false,
      nextChunkId: 1,
      elst: [],
      trexs: file.moov?.mvex?.trexs || [],
      codecBuffer: writeSampleEntry(entry),
    };
  }

  /**
   * @param {number} videoDuration - Seconds; 0 without video.
   * @param {?ArrayBuffer} videoInitSegment - Its init segment; null without one.
   * @param {number} audioDuration - Seconds; 0 without a separate audio track.
   * @param {?ArrayBuffer} audioInitSegment - Its init segment; null without one.
   */
  setup(videoDuration, videoInitSegment, audioDuration, audioInitSegment) {
    if (!videoDuration && !audioDuration) {
      throw new Error('no video or audio');
    }

    if (videoDuration) {
      const file = parseInitSegment(videoInitSegment, 'Video');
      this.videoTrack = this.makeVideoTrack(file, videoDuration);

      if (!this.videoTrack) {
        throw new Error('Video codec not supported!');
      }

      // No separate audio: the video may be muxed.
      if (!audioDuration) {
        this.audioTrack = this.makeAudioTrack(file, videoDuration);
      }
    }

    if (audioDuration) {
      const file = parseInitSegment(audioInitSegment, 'Audio');
      this.audioTrack = this.makeAudioTrack(file, audioDuration);

      if (!this.audioTrack) {
        throw new Error('Audio codec not supported!');
      }
    }

    this.datasOffset = 0;
  }

  async finalize() {
    const tracks = [];
    const videoTrack = this.videoTrack;
    const audioTrack = this.audioTrack;
    if (videoTrack && videoTrack.chunks.length) {
      tracks.push(videoTrack);
    }
    if (audioTrack && audioTrack.chunks.length) {
      tracks.push(audioTrack);
    }

    if (!tracks.length) {
      throw new Error('Not enough data to save yet');
    }
    const len = tracks[0].chunks.length;

    // In seconds: each track keeps its own timescale.
    let minStart = Infinity;

    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].chunks.length !== len) {
        console.log('WARNING: chunk length is not equal', tracks[i].chunks.length, len);
      }

      minStart = Math.min(minStart, tracks[i].chunks[0].startPTS / tracks[i].timescale);
    }

    const movieTimescale = tracks[0].timescale;
    tracks.forEach((track) => {
      track.movieTimescale = movieTimescale;

      const start = track.chunks[0].startPTS / track.timescale;
      const end = track.chunks[track.chunks.length - 1].endPTS / track.timescale;
      // Rounded first: no zero-length edit for tracks that start together.
      const delay = Math.round((start - minStart) * movieTimescale);

      // An empty edit delays a later track; a media_time would skip into it instead.
      if (delay > 0) {
        track.elst.push({
          media_time: -1,
          segment_duration: delay,
        });
      }

      // Out of decode order, the first frame presents a little after decode time zero.
      const firstPresented = firstPresentedTime(track.chunks[0]);
      // A stream cut inside a group of pictures shows a frame after the last decode time.
      const presented = (lastPresentedEnd(track.chunks) - firstPresented) / track.timescale;
      track.elst.push({
        media_time: firstPresented,
        segment_duration: Math.round(Math.max(end - start, presented) * movieTimescale),
      });

      // Not push(...samples): a long spread passes the engine's argument limit.
      track.samples = track.chunks.flatMap((chunk) => chunk.samples);

      // mdhd: the samples' sum; tkhd: what the edits present; mvhd: the longest.
      track.duration = track.samples.reduce((sum, sample) => sum + sample.duration, 0) / track.timescale;
      track.presentedDuration = track.elst.reduce((sum, edit) => sum + edit.segment_duration, 0) / movieTimescale;
    });
    let initSeg;
    try {
      const initSegCount = MP4.initSegment(tracks);
      const len = initSegCount.byteLength;

      tracks.forEach((track) => {
        track.chunks.forEach((chunk) => {
          chunk.offset = chunk.originalOffset + len;
        });
      });

      initSeg = MP4.initSegment(tracks);
    } catch (e) {
      console.error('MP4Merger finalize initSegment failed:', e);
      tracks.forEach((track) => {
        track.use64Offsets = true;
      });

      const initSegCount = MP4.initSegment(tracks);
      const len = initSegCount.byteLength;

      tracks.forEach((track) => {
        track.chunks.forEach((chunk) => {
          chunk.offset = chunk.originalOffset + len;
        });
      });

      initSeg = MP4.initSegment(tracks);
    }

    return this.file.finish(initSeg);
  }
  /**
   * @param {number} videoDuration - Seconds; 0 without video.
   * @param {?ArrayBuffer} videoInitSegment
   * @param {number} audioDuration - Seconds; 0 without a separate audio track.
   * @param {?ArrayBuffer} audioInitSegment
   * @param {Array<ZippedFragment>} zippedFragments - The fragments of both tracks, by time.
   * @return {Promise<Blob>}
   */
  async convert(videoDuration, videoInitSegment, audioDuration, audioInitSegment, zippedFragments) {
    try {
      // Inside the try: the save the constructor began must close when setup() throws too.
      this.setup(videoDuration, videoInitSegment, audioDuration, audioInitSegment);

      let lastProgress = 0;
      // The next fragment is read while this one converts; its failure is the next round's error.
      let next = zippedFragments.length ? this.readFragment(zippedFragments[0]) : null;
      for (let i = 0; i < zippedFragments.length; i++) {
        if (this.cancelled) {
          throw new Error('Cancelled');
        }
        const read = await next;
        next = i + 1 < zippedFragments.length ? this.readFragment(zippedFragments[i + 1]) : null;
        next?.catch(() => {});
        if (zippedFragments[i].track === 0) {
          await this.pushFragment(/** @type {MergerTrack} */ (this.videoTrack), zippedFragments[i], read);
        } else {
          await this.pushFragment(/** @type {MergerTrack} */ (this.audioTrack), zippedFragments[i], read);
        }
        const newProgress = Math.floor((i + 1) / zippedFragments.length * 100);
        if (newProgress !== lastProgress) {
          lastProgress = newProgress;
          this.emit('progress', newProgress / 100);
        }
      }

      const blob = await this.finalize();
      this.destroy();
      return blob;
    } catch (e) {
      // Nothing will read the result: close the store at once, its file on disk first.
      await this.file.abort();
      this.destroy(/* immediate */ true);
      throw e;
    }
  }

  /**
   * @param {boolean} [immediate] - Closes the blob store too (a save that failed).
   */
  destroy(immediate) {
    if (this.destroyed) return;
    this.destroyed = true;

    this.videoTrack = null;
    this.audioTrack = null;
    this.datasOffset = 0;

    if (immediate) {
      this.release(/* removeFiles */ true);
    }
  }

  /**
   * Closes the blob store the saved file reads from, once nothing will read it again.
   * @param {boolean} [removeFiles] - Its files on disk go too; else they stay for the next prune.
   */
  release(removeFiles = false) {
    const blobManager = this.blobManager;
    this.blobManager = /** @type {any} */ (null);
    blobManager?.close(removeFiles);
  }
}

/**
 * @param {MergerChunk} chunk
 * @return {number} The composition time of its first presented sample, from its first decode time.
 */
function firstPresentedTime(chunk) {
  let decodeTime = 0;
  let earliest = 0;

  chunk.samples.forEach((sample, index) => {
    const presentedAt = decodeTime + sample.cts;
    if (index === 0 || presentedAt < earliest) {
      earliest = presentedAt;
    }
    decodeTime += sample.duration;
  });

  return Math.max(0, earliest);
}

/**
 * When the last shown frame ends, from decode time zero, in the track's timescale.
 * @param {Array<MergerChunk>} chunks - In order.
 * @return {number}
 */
function lastPresentedEnd(chunks) {
  let decodeTime = 0;
  let latest = 0;

  chunks.forEach((chunk) => {
    chunk.samples.forEach((sample) => {
      latest = Math.max(latest, decodeTime + sample.cts + sample.duration);
      decodeTime += sample.duration;
    });
  });

  return latest;
}

/**
 * @param {?ArrayBuffer} buffer - A null one throws a TypeError, not a merger error (no remux fallback).
 * @param {string} what - 'Video' or 'Audio', for the error a caller may recover from.
 * @return {ISOFile}
 */
function parseInitSegment(buffer, what) {
  const file = createFile(false);
  /** @type {MP4BoxBuffer} */ (buffer).fileStart = 0;
  file.appendBuffer(/** @type {MP4BoxBuffer} */ (buffer));
  file.flush();

  if (!file.moov) {
    throw new Error(`${what} is not an mp4!`);
  }

  return file;
}

/**
 * Searched, not indexed: the muxer decides which track comes first.
 * @param {ISOFile} file - A parsed initialization segment.
 * @param {string[]} codecs - Sample entry types to accept.
 * @return {{trak: TrakBox, entry: SampleEntry}|null}
 */
function findTrack(file, codecs) {
  for (const trak of file.moov.traks) {
    const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.find((candidate) => {
      return codecs.includes(candidate.type);
    });

    if (entry) {
      return {trak, entry};
    }
  }

  return null;
}

/**
 * @param {SampleEntry} entry
 * @return {ArrayBuffer}
 */
function writeSampleEntry(entry) {
  const stream = new DataStream();
  stream.endianness = Endianness.BIG_ENDIAN;
  entry.write(stream);
  return stream.buffer;
}

/**
 * @param {boolean} isKeyframe - mp4box's is_sync.
 * @param {number} duration - In the track's timescale.
 * @param {number} size - Bytes.
 * @param {number} cts - The composition offset: cts - dts.
 */
function createMp4Sample(isKeyframe, duration, size, cts) {
  return {
    duration,
    size,
    cts,
    flags: {
      isLeading: 0,
      isDependedOn: 0,
      hasRedundancy: 0,
      degradPrio: 0,
      dependsOn: isKeyframe ? 2 : 1,
      isNonSync: isKeyframe ? 0 : 1,
    },
  };
}
