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
 * mp4box's trak box, which it does not export by name.
 * @typedef {ISOFile['moov']['traks'][number]} TrakBox
 */

/**
 * A sample as MP4Generator writes it (createMp4Sample).
 * @typedef {ReturnType<typeof createMp4Sample>} OutputSample
 */

/**
 * One fragment's part of a track (pushFragment): its samples, where its mdat goes in the
 * file, and its times in the track's timescale.
 * @typedef {{id: number, samples: Array<OutputSample>, samplesDuration: number, offset: number,
 *   originalOffset: number, startPTS: number, endPTS: number, baseDecodeTime: number}} MergerChunk
 */

/**
 * A track of the file (makeVideoTrack, makeAudioTrack), as MP4Generator writes it: the
 * source's track ID, timescale, trex boxes and sample entry, the chunks the fragments add,
 * and what finalize() works out from them.
 * @typedef {{type: 'video'|'audio', id: number, sourceTrackId: number, timescale: number,
 *   duration: number, samples: Array<OutputSample>, chunks: Array<MergerChunk>,
 *   presentedDuration?: number,
 *   use64Offsets: boolean, nextChunkId: number, elst: Array<{media_time: number, segment_duration: number}>,
 *   trexs: NonNullable<ISOFile['moov']['mvex']>['trexs'], codecBuffer: ArrayBuffer,
 *   movieTimescale?: number, width?: number, height?: number, pixelRatio?: Array<number>,
 *   sps?: Array<Uint8Array>, pps?: Array<Uint8Array>, segmentCodec?: null}} MergerTrack
 */

/**
 * A fragment to save, in time order (DashPlayer.saveVideo): its track (0 the video, 1 the
 * audio), and what reads its data.
 * @typedef {{track: number, fragment: import('../../players/dash/DashFragment.mjs').DashFragment,
 *   getEntry: (options?: {keepPinned?: boolean}) => ReturnType<typeof import('../../players/SaveFragmentFetcher.mjs').savedEntry>}} ZippedFragment
 */

const VideoCodecs = ['avc1', 'avc2', 'avc3', 'avc4', 'av01', 'dav1', 'hvc1', 'hev1', 'hvt1', 'lhe1', 'dvh1', 'dvhe', 'vvc1', 'vvi1', 'vvs1', 'vvcN', 'vp08', 'vp09', 'avs3', 'j2ki', 'mjp2', 'mjpg', 'uncv'];
const AudioCodecs = ['mp4a', 'ac-3', 'ac-4', 'ec-3', 'Opus', 'mha1', 'mha2', 'mhm1', 'mhm2'];

export class MP4Merger extends EventEmitter {
  /**
   * @param {(cancel: () => void) => void} [registerCancel] - Hands over what cancels the save.
   */
  constructor(registerCancel) {
    super();
    this.blobManager = new FSBlob();
    // Each fragment's media goes into one file on disk as it is read (OPFS), as an HLS
    // save's does, and the saved file is that one behind the moov; staged in this blob store
    // where there is no OPFS (SaveFile). It kept a slice of each fragment's own Blob (the
    // player's store) until the end and wrote the file only then: the player lets go of a
    // fragment once the save read it, and a slice of a File it freed meanwhile (a quality
    // change, the buffer moving on) read nothing - the copy failed, and its fallback handed
    // the download a Blob of the same dead slices behind a "Save complete". Slices of Blobs
    // in RAM kept the whole video there, past the RAM budget.
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
   * Picks the track a set of samples belongs to.
   *
   * Track IDs only mean anything within the initialization segment that declared them,
   * so two separately-delivered tracks may well share one. They are therefore only
   * trusted to tell tracks apart when a single fragment carries more than one.
   *
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
   * A fragment's data, from the store.
   * @param {ZippedFragment} fragData
   * @return {Promise<*>} Its bytes (an ArrayBuffer of its own).
   */
  async readFragment(fragData) {
    const entry = await fragData.getEntry();
    // getDataFromBlob, not getData and BlobManager: it tells the store a read of data it
    // lost, and the save downloads the fragment again (savedEntry).
    return entry.getDataFromBlob('arraybuffer');
  }

  /**
   * Adds a fragment's samples to its track, and its mdat to the file's data.
   * @param {MergerTrack} defaultTrack - The track the fragment was queued against.
   * @param {ZippedFragment} fragData - The fragment.
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
    // A muxed fragment describes one track per traf and indexes each of them
    // separately, both keyed by the track ID.
    // A sidx box's fields (mp4box's sidxBox, which it does not export by name).
    const sidxs = /** @type {Array<import('../mp4box/mp4box.all.mjs').Box & {reference_ID: number, earliest_presentation_time: number}>} */ (mp4boxfile.boxes.filter((box) => box.type === 'sidx'));
    const sampleLists = mp4boxfile.getSampleList(moof, defaultTrack.trexs);

    sampleLists.forEach((samplesList) => {
      const track = this.trackForSamples(samplesList.track_id, sampleLists.length, defaultTrack);
      if (!track || samplesList.samples.length === 0) {
        return;
      }

      const traf = moof.trafs.find((candidate) => candidate.tfhd.track_id === samplesList.track_id);
      const baseDecodeTime = traf?.tfdt?.baseMediaDecodeTime || 0;
      // A sidx says which track it indexes and counts in that track's timescale. Only a
      // fragment with a single track can lend its lone sidx to that track unchecked; in a
      // muxed one it would give the other track a start time in the wrong timescale, so
      // that track falls back to its own decode time.
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

      // The mdat is copied whole, so each track's samples keep their distance into it.
      // In a muxed fragment one track's samples follow the other's rather than starting
      // right after the box header, which is why this is measured and not assumed.
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
    // The whole mdat box, from this save's own copy of the fragment: nothing of the player's
    // store is kept (SaveFile). subarray, as the Blob slice before it, stops at the data's end.
    const start = /** @type {number} */ (mdat.start);
    await this.file.add(new Uint8Array(/** @type {ArrayBuffer} */ (data)).subarray(start, start + mdat.size));
  }

  /**
   * Builds the video track an initialization segment describes.
   * @param {ISOFile} file - The parsed initialization segment.
   * @param {number} duration - The track's duration, in seconds.
   * @return {?MergerTrack} The track, or null if the segment has no usable video.
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
   * Builds the audio track an initialization segment describes.
   * @param {ISOFile} file - The parsed initialization segment.
   * @param {number} duration - The track's duration, in seconds.
   * @return {?MergerTrack} The track, or null if the segment has no usable audio.
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
   * Makes the tracks the init segments describe: a video track for a video duration, an
   * audio track for an audio one (or from the video's segment, when that muxes both).
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

      // With no separate audio rendition the video may be muxed, in which case the one
      // initialization segment describes both tracks and every fragment carries both.
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

    // Where the next mdat goes, after the init segment.
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

    // Tracks need not start together, and each keeps its own timescale, so the shared
    // starting point has to be found in seconds rather than in raw timestamps.
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
      // Rounded before it is tested, so that tracks which start together but count in
      // different timescales are not given an edit that lasts no time at all.
      const delay = Math.round((start - minStart) * movieTimescale);

      // Samples are written starting at media time zero, so a track that begins later
      // than the others is held back by an empty edit. Expressing the delay as a
      // media_time instead would skip into the media rather than postpone it.
      if (delay > 0) {
        track.elst.push({
          media_time: -1,
          segment_duration: delay,
        });
      }

      // Samples are written from decode time zero, so a track that composes out of
      // decode order presents its first frame a little after that. Starting the edit
      // any earlier points it at a frame that is not there and the first one is lost.
      // Media times are counted in the track's own timescale.
      const firstPresented = firstPresentedTime(track.chunks[0]);
      // The chunks' ends are decode times. A stream cut in decode order (a recording that
      // stopped inside a group of pictures) can show a frame after that: the edit stopped
      // short of it, and players left the frame out.
      const presented = (lastPresentedEnd(track.chunks) - firstPresented) / track.timescale;
      track.elst.push({
        media_time: firstPresented,
        segment_duration: Math.round(Math.max(end - start, presented) * movieTimescale),
      });

      // flatMap, not push(...samples): a spread of a very long chunk's samples can pass the
      // engine's argument limit and throw a RangeError.
      track.samples = track.chunks.flatMap((chunk) => chunk.samples);

      // The track's own length (mdhd): its samples one after the other, the holes of a
      // partial save padded (pushFragment). What its edits present goes in the tkhd, the
      // longest in the mvhd. The period's length was written in all three, and Firefox, which
      // takes the duration from the moov, said a 10 minute save of an hour lasted an hour.
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

    // The moov in front of the media, which is on disk already (or staged where there is
    // no OPFS: a private window). It stays until release(), with the blob store.
    return this.file.finish(initSeg);
  }
  /**
   * @param {number} videoDuration - Seconds; 0 without video.
   * @param {?ArrayBuffer} videoInitSegment - Its init segment; null without one.
   * @param {number} audioDuration - Seconds; 0 without a separate audio track.
   * @param {?ArrayBuffer} audioInitSegment - Its init segment; null without one.
   * @param {Array<ZippedFragment>} zippedFragments - The fragments of both tracks, by time.
   * @return {Promise<Blob>} The MP4 file: the moov in front of its media (SaveFile.finish).
   */
  async convert(videoDuration, videoInitSegment, audioDuration, audioInitSegment, zippedFragments) {
    try {
      // Inside the try: setup() throws for a codec or packaging this merger cannot
      // handle, which is what sends the caller to the remux fallback, and the
      // OPFS save the constructor began has to be closed on that path as well.
      this.setup(videoDuration, videoInitSegment, audioDuration, audioInitSegment);

      let lastProgress = 0;
      // The next fragment is read from the store (RAM, or OPFS through its worker) while this
      // one converts: one after the other, each waited for the other. One fragment more held.
      // A read that fails meanwhile is the next round's error, not an unhandled rejection.
      let next = zippedFragments.length ? this.readFragment(zippedFragments[0]) : null;
      for (let i = 0; i < zippedFragments.length; i++) {
        if (this.cancelled) {
          throw new Error('Cancelled');
        }
        const read = await next;
        next = i + 1 < zippedFragments.length ? this.readFragment(zippedFragments[i + 1]) : null;
        next?.catch(() => {});
        // setup made the track of each duration given: a track's fragments come with its
        // duration (DashPlayer.saveVideo).
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
      // A cancellation or a mux failure (bad fragment, mp4box parse error)
      // both leave a live OPFS-backed blobManager behind if nothing closes
      // it - unlike the success path, there's no result that still needs
      // to read from it, so close it right away rather than deferring. The
      // file on disk goes first, as an HLS save's does: only the store was
      // closed, and the file stayed until the session was pruned.
      await this.file.abort();
      this.destroy(/* immediate */ true);
      throw e;
    }
  }

  /**
   * @param {boolean} [immediate] - Closes the blob store too (a save that failed): nothing
   *   will read from it.
   */
  destroy(immediate) {
    if (this.destroyed) return;
    this.destroyed = true;

    this.videoTrack = null;
    this.audioTrack = null;
    this.datasOffset = 0;

    // After a save that worked, the file convert() returned reads from the blob store:
    // it stays until release().
    if (immediate) {
      this.release();
    }
  }

  /**
   * Closes the blob store the saved file reads from, once nothing will read the file
   * again (SaveManager: its URL dropped and the download of it over). It was closed two
   * minutes after the save, and a closed OPFS session is deleted by the next player or
   * save that starts: a longer download, or the same file saved again, lost it.
   */
  release() {
    const blobManager = this.blobManager;
    // The last use of it: nothing reads the store once it is released.
    this.blobManager = /** @type {any} */ (null);
    blobManager?.close();
  }
}

/**
 * The earliest time a chunk presents anything, counted from its own first decode time.
 * @param {MergerChunk} chunk - A chunk of samples.
 * @return {number} The composition time of its first presented sample.
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
 * When a track's last shown frame ends, counted as firstPresentedTime() counts: from decode
 * time zero, in the track's timescale, over all its chunks.
 * @param {Array<MergerChunk>} chunks - The track's chunks, in order.
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
 * Parses an initialization segment.
 * @param {?ArrayBuffer} buffer - The segment (setup's); a null one throws a TypeError here,
 *   not one of the merger's errors that send the save to the remuxer.
 * @param {string} what - 'Video' or 'Audio', for the error a caller may recover from.
 * @return {ISOFile} The parsed file.
 */
function parseInitSegment(buffer, what) {
  const file = createFile(false);
  // An MP4BoxBuffer from here on: mp4box reads it from fileStart.
  /** @type {MP4BoxBuffer} */ (buffer).fileStart = 0;
  file.appendBuffer(/** @type {MP4BoxBuffer} */ (buffer));
  file.flush();

  if (!file.moov) {
    throw new Error(`${what} is not an mp4!`);
  }

  return file;
}

/**
 * Finds the track whose sample description names one of the given codecs.
 *
 * Which track an initialization segment lists first is up to whatever muxed it, so a
 * segment describing both audio and video has to be searched rather than indexed.
 *
 * @param {ISOFile} file - A parsed initialization segment.
 * @param {string[]} codecs - Sample entry types to accept.
 * @return {{trak: TrakBox, entry: SampleEntry}|null} The track and its sample entry.
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
 * Serializes a sample description entry, so the output carries the same codec setup.
 * @param {SampleEntry} entry - The sample description entry.
 * @return {ArrayBuffer} The written box.
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
