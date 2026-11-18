// @ts-check
import {EventEmitter} from '../eventemitter.mjs';
import {FSBlob} from '../FSBlob.mjs';
import {SaveFile} from '../SaveFile.mjs';
import {MP4 as HlsMP4} from '../hls.mjs';
import {MP4} from './MP4Generator.mjs';
import {normalizePts} from './ptsNormalize.mjs';
import Transmuxer from './transmuxer.mjs';

const TS_CLOCK = 90000;

/** @typedef {import('../hls.mjs').RemuxedTrack & {data2: Uint8Array<ArrayBuffer>}} RemuxedFragment */

/**
 * @typedef {{duration: number, size: number, cts: number, flags: {isLeading: number,
 *   isDependedOn: number, hasRedundancy: number, degradPrio: number, dependsOn: number,
 *   isNonSync: number, paddingValue: number}}} Mp4Sample
 */

/**
 * Reads a fragment's samples back from the trun of the moof hls.js's MP4Remuxer wrote (data1).
 * @param {Uint8Array} moof
 * @return {Array<Mp4Sample>}
 */
export function samplesFromMoof(moof) {
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  /**
   * @param {number} start
   * @param {number} end
   * @param {string} type
   * @return {?{start: number, end: number}}
   */
  const child = (start, end, type) => {
    for (let at = start; at + 8 <= end;) {
      const size = view.getUint32(at);
      if (size < 8 || at + size > end) {
        break;
      }
      if (String.fromCharCode(moof[at + 4], moof[at + 5], moof[at + 6], moof[at + 7]) === type) {
        return {start: at + 8, end: at + size};
      }
      at += size;
    }
    return null;
  };
  const moofBox = child(0, moof.byteLength, 'moof');
  const traf = moofBox && child(moofBox.start, moofBox.end, 'traf');
  const trun = traf && child(traf.start, traf.end, 'trun');
  if (!trun) {
    throw new Error('hls.js remuxed a fragment without moof/traf/trun');
  }
  const version = moof[trun.start];
  const flags = view.getUint32(trun.start) & 0xffffff;
  // MP4.trun writes each sample's duration, size, flags and composition offset.
  if ((flags & 0xf00) !== 0xf00 || (flags & 0x4)) {
    throw new Error(`hls.js wrote a trun without each sample's duration, size, flags and offset (0x${flags.toString(16)})`);
  }
  const count = view.getUint32(trun.start + 4);
  let at = trun.start + 8 + ((flags & 0x1) ? 4 : 0);
  if (at + count * 16 > trun.end) {
    throw new Error('hls.js wrote a trun shorter than its sample count');
  }
  /** @type {Array<Mp4Sample>} */
  const samples = [];
  for (let i = 0; i < count; i++, at += 16) {
    const f = view.getUint32(at + 8);
    samples.push({
      duration: view.getUint32(at),
      size: view.getUint32(at + 4),
      // Version 1 (video) writes the offset signed.
      cts: version === 1 ? view.getInt32(at + 12) : view.getUint32(at + 12),
      flags: {
        isLeading: (f >>> 26) & 3,
        dependsOn: (f >>> 24) & 3,
        isDependedOn: (f >>> 22) & 3,
        hasRedundancy: (f >>> 20) & 3,
        paddingValue: (f >>> 17) & 7,
        isNonSync: (f >>> 16) & 1,
        degradPrio: f & 0xffff,
      },
    });
  }
  return samples;
}

/**
 * @typedef {{id: number, samples: Array<Mp4Sample>, offset: number, originalOffset: number,
 *   startDTS: number, endDTS: number, startPTS: number, endPTS: number}} TrackChunk
 */

/**
 * @typedef {Object<string, *> & {id: number, type: string, timescale: number, duration: number,
 *   samples: Array<*>, chunks: Array<TrackChunk>, use64Offsets: boolean,
 *   nextChunkId: number, elst: Array<{media_time: number, segment_duration: number}>}} Mp4Track
 */

/**
 * @typedef {{track: number, fragment: import('../../players/hls/HLSFragment.mjs').HLSFragment,
 *   getEntry: (options?: {keepPinned?: boolean}) => ReturnType<typeof import('../../players/SaveFragmentFetcher.mjs').savedEntry>}} ZippedFragment
 */

export class HLS2MP4 extends EventEmitter {
  /** @param {(cancel: () => void) => void} [registerCancel] */
  constructor(registerCancel) {
    super();
    this.blobManager = new FSBlob();
    // Converted pieces go into one file on disk (OPFS) as they are made; the blob store without OPFS.
    this.file = new SaveFile(this.blobManager, 'hls');
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
   * @param {ArrayLike<*>} a
   * @param {ArrayLike<*>} b
   * @return {boolean}
   */
  arrayEquals(a, b) {
    let i;

    if (a.length !== b.length) {
      return false;
    }


    for (i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * @param {import('../../players/hls/HLSFragment.mjs').HLSFragment} fragment
   * @param {import('../../players/hls/HLSFragment.mjs').HLSFragment} [previous]
   * @return {boolean} Whether fragments of the same timeline are missing between the two (a partial save).
   */
  isAfterHole(fragment, previous) {
    // The discontinuity counter (cc) is on hls.js's own fragment; sn is on the wrapper.
    return !!previous && fragment.getFrag().cc === previous.getFrag().cc && fragment.sn > previous.sn + 1;
  }

  /**
   * @param {ZippedFragment} fragData
   * @return {Promise<*>}
   */
  async readFragment(fragData) {
    const entry = await fragData.getEntry();
    return entry.getDataFromBlob();
  }

  /**
   * @param {ZippedFragment} fragData
   * @param {*} data
   */
  async pushFragment(fragData, data) {
    const fragment = fragData.fragment;
    // cc is on hls.js's own fragment (getFrag()).
    const isDiscontinuity = !this.prevFrag || fragment.sn !== this.prevFrag.fragment.sn + 1 || fragment.getFrag().cc !== this.prevFrag.fragment.getFrag().cc;
    const afterHole = this.isAfterHole(fragment, this.prevFrag?.fragment);

    if (isDiscontinuity) {
      console.log('discontinuity');
    }
    this.prevFrag = fragData;
    const result = /** @type {Transmuxer} */ (this.transmuxer).pushData(new Uint8Array(data), isDiscontinuity);

    if (result.video) {
      if (!this.videoTrack) {
        this.videoTrack = this.makeTrack(result.videoTrack);
      }

      result.videoTrack.pps.forEach(/** @param {Uint8Array} pps */ (pps) => {
        if (!/** @type {Mp4Track} */ (this.videoTrack).pps.find(/** @param {Uint8Array} p */ (p) => {
          return this.arrayEquals(p, pps);
        })) {
          /** @type {Mp4Track} */ (this.videoTrack).pps.push(pps);
        }
      });

      result.videoTrack.sps.forEach(/** @param {Uint8Array} sps */ (sps) => {
        if (!/** @type {Mp4Track} */ (this.videoTrack).sps.find(/** @param {Uint8Array} s */ (s) => {
          return this.arrayEquals(s, sps);
        })) {
          /** @type {Mp4Track} */ (this.videoTrack).sps.push(sps);
        }
      });

      await this.pushChunk(this.videoTrack, result.video, result.initPTS, afterHole);
    }

    // With an audio rendition selected, hls.js drops the level's own audio; so does the save.
    if (result.audio && !this.audioRendition) {
      if (!this.audioTrack) {
        this.audioTrack = this.makeTrack(result.audioTrack);
      }
      await this.pushChunk(this.audioTrack, result.audio, result.initPTS, afterHole);
    }
  }

  /**
   * @param {ZippedFragment} fragData
   * @param {*} data
   */
  async pushFragmentAudio(fragData, data) {
    const fragment = fragData.fragment;
    const isDiscontinuity = !this.prevFragAudio || fragment.sn !== this.prevFragAudio.fragment.sn + 1 || fragment.getFrag().cc !== this.prevFragAudio.fragment.getFrag().cc;
    const afterHole = this.isAfterHole(fragment, this.prevFragAudio?.fragment);

    if (isDiscontinuity) {
      console.log('discontinuity');
    }
    this.prevFragAudio = fragData;
    const result = /** @type {Transmuxer} */ (this.transmuxerAudio).pushData(new Uint8Array(data), isDiscontinuity);
    if (result.audio) {
      if (!this.audioTrack) {
        this.audioTrack = this.makeTrack(result.audioTrack);
      }
      await this.pushChunk(this.audioTrack, result.audio, result.initPTS, afterHole);
    }
  }

  /**
   * @param {Object<string, *> & {id: number, type: string, timescale: number, duration: number}} demuxedTrack
   * @return {Mp4Track}
   */
  makeTrack(demuxedTrack) {
    return {
      ...demuxedTrack,
      samples: [],
      chunks: [],
      use64Offsets: false,
      nextChunkId: 1,
      elst: [],
    };
  }

  /**
   * Adds what hls.js remuxed from one fragment to a track, and keeps its data.
   * @param {Mp4Track} track
   * @param {RemuxedFragment} remuxed
   * @param {number} initPTS - Seconds: the stream's clock at the transmuxer's time 0, which both renditions share.
   * @param {boolean} [afterHole]
   */
  async pushChunk(track, remuxed, initPTS, afterHole = false) {
    const headerLen = 8;
    if (afterHole && track.chunks.length) {
      this.padHole(track, remuxed.startDTS + initPTS);
    }
    track.chunks.push({
      id: track.nextChunkId++,
      samples: samplesFromMoof(remuxed.data1),
      offset: /** @type {number} */ (this.datasOffset) + headerLen,
      originalOffset: /** @type {number} */ (this.datasOffset) + headerLen,
      startDTS: remuxed.startDTS + initPTS,
      endDTS: remuxed.endDTS + initPTS,
      startPTS: remuxed.startPTS + initPTS,
      endPTS: remuxed.endPTS + initPTS,
    });
    const data = remuxed.data2;
    this.datasOffset += data.byteLength;
    await this.file.add(data);
  }

  /**
   * Stretches a track's last sample over the fragments a partial save lacks, as MP4Merger does.
   * @param {Mp4Track} track
   * @param {number} startDTS - Seconds, on the stream's clock.
   */
  padHole(track, startDTS) {
    const last = track.chunks[track.chunks.length - 1];
    const lastSample = last.samples[last.samples.length - 1];
    if (!lastSample) {
      return;
    }
    const hole = (normalizePts(startDTS * TS_CLOCK, last.endDTS * TS_CLOCK) / TS_CLOCK) - last.endDTS;
    const ticks = Math.round(hole * track.timescale);
    if (ticks > 0) {
      lastSample.duration += ticks;
    }
  }

  /**
   * @param {import('../hls.mjs').Level} level
   * @param {?Uint8Array} levelInitData
   * @param {import('../hls.mjs').MediaPlaylist|undefined} audioLevel
   * @param {?Uint8Array} audioInitData
   */
  setup(level, levelInitData, audioLevel, audioInitData) {
    if (!level.details) {
      throw new Error('level.details is null');
    }

    this.transmuxer = new Transmuxer({
      audioCodec: level.audioCodec,
      videoCodec: level.videoCodec,
      initSegmentData: levelInitData || [],
      duration: level.details.totalduration,
      defaultInitPts: 0,
    });

    if (audioLevel) {
      this.transmuxerAudio = new Transmuxer({
        videoCodec: '',
        audioCodec: audioLevel.audioCodec,
        initSegmentData: audioInitData || [],
        duration: level.details.totalduration,
        defaultInitPts: 0,
      });
    }

    this.prevFrag = null;
    this.prevFragAudio = null;
    /** @type {number} */
    this.datasOffset = 0;
  }

  async finalize() {
    /** @type {Array<Mp4Track>} */
    const tracks = [];
    const videoTrack = this.videoTrack;
    const audioTrack = this.audioTrack;
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) {
      tracks.push(audioTrack);
    }

    if (!tracks.length || !tracks[0].chunks.length) {
      throw new Error('Not enough data to save yet');
    }

    const len = tracks[0].chunks.length;
    // The movie starts with the first frame shown by either track, on the stream's clock.
    // The 33-bit 90 kHz clock wraps every 26.5 hours: a track across the wrap is brought over.
    const startOf = /** @param {Mp4Track} track */ (track) => normalizePts(track.chunks[0].startPTS * TS_CLOCK, tracks[0].chunks[0].startPTS * TS_CLOCK) / TS_CLOCK;
    let minStart = Infinity;

    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].chunks.length !== len) {
        console.log('WARNING: chunk length is not equal', tracks[i].chunks.length, len);
      }

      minStart = Math.min(minStart, startOf(tracks[i]));
    }

    const movieTimescale = tracks[0].timescale;
    tracks.forEach((track) => {
      track.movieTimescale = movieTimescale;

      const first = track.chunks[0];
      // An empty edit holds back the later track, counted in the movie's timescale.
      const delay = Math.round((startOf(track) - minStart) * movieTimescale);
      if (delay > 0) {
        track.elst.push({
          media_time: -1,
          segment_duration: delay,
        });
      }

      // From the samples as written: across a discontinuity the stream's timestamps start over.
      const mediaTime = Math.round((first.startPTS - first.startDTS) * track.timescale);
      let decoded = 0;
      let presentedEnd = 0;
      track.chunks.forEach((chunk) => {
        chunk.samples.forEach((sample) => {
          presentedEnd = Math.max(presentedEnd, decoded + (sample.cts || 0) + sample.duration);
          decoded += sample.duration;
        });
      });
      // The last presented end counts too: a stream cut in decode order shows a frame past the decode end.
      const presented = Math.max(decoded, presentedEnd - mediaTime);
      track.elst.push({
        media_time: mediaTime,
        segment_duration: Math.round(presented / track.timescale * movieTimescale),
      });

      // flatMap, not push(...samples): a long spread can pass the engine's argument limit.
      track.samples = track.chunks.flatMap((chunk) => chunk.samples);

      // mdhd: the track's own length. What its edits present goes in the tkhd, the longest in the mvhd.
      track.duration = decoded / track.timescale;
      track.presentedDuration = track.elst.reduce((sum, edit) => sum + edit.segment_duration, 0) / movieTimescale;

      // The video sample entry is hls.js's own writer's; here, not in MP4Generator, which DASH saves load too.
      if (track.type !== 'audio' && !track.codecBuffer) {
        track.codecBuffer = track.segmentCodec === 'hevc' ? HlsMP4.hvc1(track) : HlsMP4.avc1(track);
      }
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

    // The moov in front of the media; it stays until release(), with the blob store.
    return this.file.finish(initSeg);
  }
  /**
   * @param {import('../hls.mjs').Level} level
   * @param {?Uint8Array} levelInitData
   * @param {import('../hls.mjs').MediaPlaylist|undefined} audioLevel
   * @param {?Uint8Array} audioInitData
   * @param {Array<ZippedFragment>} zippedFragments
   * @return {Promise<Blob>}
   */
  async convert(level, levelInitData, audioLevel, audioInitData, zippedFragments) {
    try {
      this.setup(level, levelInitData, audioLevel, audioInitData);
      // A rendition of its own (track 1); one without a URI is the level's own audio.
      this.audioRendition = zippedFragments.some((fragment) => fragment.track !== 0);

      let lastProgress = 0;
      // The next fragment is read while this one converts; a failed read is the next round's error.
      let next = zippedFragments.length ? this.readFragment(zippedFragments[0]) : null;
      for (let i = 0; i < zippedFragments.length; i++) {
        if (this.cancelled) {
          throw new Error('Cancelled');
        }
        const data = await next;
        next = i + 1 < zippedFragments.length ? this.readFragment(zippedFragments[i + 1]) : null;
        next?.catch(() => {});
        if (zippedFragments[i].track === 0) {
          await this.pushFragment(zippedFragments[i], data);
        } else {
          await this.pushFragmentAudio(zippedFragments[i], data);
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
      // Cancelled or failed: nothing will read what was kept, so the blob store goes now.
      await this.file.abort();
      this.destroy(/* immediate */ true);
      throw e;
    }
  }

  /** @param {boolean} [immediate] - After a failure: closes the blob store too. */
  destroy(immediate) {
    if (this.transmuxer) this.transmuxer.destroy();
    if (this.transmuxerAudio) this.transmuxerAudio.destroy();
    this.transmuxerAudio = null;
    this.transmuxer = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.prevFrag = null;
    this.datasOffset = 0;

    // After a save that worked, the returned file is made of the blob store: it stays until release().
    if (immediate) {
      this.release(/* removeFiles */ true);
    }
  }

  /**
   * Once nothing will read the saved file again (SaveManager), as MP4Merger's.
   * @param {boolean} [removeFiles]
   */
  release(removeFiles = false) {
    const blobManager = this.blobManager;
    this.blobManager = /** @type {any} */ (null);
    blobManager?.close(removeFiles);
  }
}
