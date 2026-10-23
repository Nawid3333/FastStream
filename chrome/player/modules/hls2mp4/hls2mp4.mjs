// @ts-check
import {EventEmitter} from '../eventemitter.mjs';
import {FSBlob} from '../FSBlob.mjs';
import {MP4} from './MP4Generator.mjs';
import {normalizePts} from './ptsNormalize.mjs';
import Transmuxer from './transmuxer.mjs';

// The clock MPEG-TS timestamps count in.
const TS_CLOCK = 90000;

/**
 * What hls.js remuxed from one fragment for one track (MP4Remuxer, one of the internals
 * FastStream's patch exports): hls.js's RemuxedTrack, its mdat in data2 (optional in hls.js's
 * types, always there for a track MP4Remuxer remuxed), and the samples (hls.js's Mp4Sample,
 * which its types do not describe) that patches/hls.js@*.patch adds.
 * @typedef {import('../hls.mjs').RemuxedTrack & {data2: Uint8Array<ArrayBuffer>, outputSamples: Array<*>}} RemuxedFragment
 */

/**
 * One fragment's part of a track (pushChunk): its samples, where its mdat goes in the file,
 * and its times on the stream's clock, in seconds.
 * @typedef {{id: number, samples: Array<*>, offset: number, originalOffset: number,
 *   startDTS: number, endDTS: number, startPTS: number, endPTS: number}} TrackChunk
 */

/**
 * A track the file is written from (makeTrack): the track hls.js's demuxer describes (TSDemuxer,
 * an internal its types do not describe, so its fields - timescale, pps, sps and the rest
 * MP4Generator reads - stay unchecked), with what this file adds.
 * @typedef {Object<string, *> & {samples: Array<*>, chunks: Array<TrackChunk>, use64Offsets: boolean,
 *   nextChunkId: number, elst: Array<{media_time: number, segment_duration: number}>}} Mp4Track
 */

/**
 * A fragment to save, of the level (track 0) or the audio rendition (1), with what reads its
 * data (HLSPlayer.saveVideo).
 * @typedef {{track: number, fragment: import('../../players/hls/HLSFragment.mjs').HLSFragment,
 *   getEntry: () => ReturnType<typeof import('../../players/SaveFragmentFetcher.mjs').savedEntry>}} ZippedFragment
 */


export class HLS2MP4 extends EventEmitter {
  /**
   * @param {(cancel: () => void) => void} [registerCancel] - Hands over what cancels the save.
   */
  constructor(registerCancel) {
    super();
    this.blobManager = new FSBlob();
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
   * @return {boolean} Whether they hold the same values, in the same order.
   */
  arrayEquals(a, b) {
    let i;

    if (a.length !== b.length) {
      return false;
    } // compare the value of each element in the array


    for (i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * @param {import('../../players/hls/HLSFragment.mjs').HLSFragment} fragment
   * @param {import('../../players/hls/HLSFragment.mjs').HLSFragment} [previous] the fragment
   *     of the same track before it
   * @return {boolean} whether fragments of the same timeline are missing between the two (a
   *     partial save): the stream's clock runs on across them, unlike at a discontinuity.
   */
  isAfterHole(fragment, previous) {
    // The wrapper has no cc; the discontinuity counter is on hls.js's own fragment. sn, its
    // number, the wrapper carries itself.
    return !!previous && fragment.getFrag().cc === previous.getFrag().cc && fragment.sn > previous.sn + 1;
  }

  /** @param {ZippedFragment} fragData - A fragment of the level. */
  async pushFragment(fragData) {
    const entry = await fragData.getEntry();
    const data = await entry.getDataFromBlob();
    const fragment = fragData.fragment;
    // The wrapper has no cc; the discontinuity counter is on hls.js's own fragment (getFrag()).
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

      // Set above; a callback does not keep that.
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

      this.pushChunk(this.videoTrack, result.video, result.initPTS, afterHole);
    }

    // With an audio rendition selected, hls.js plays that and drops whatever audio the
    // level carries itself; the save takes the same audio. It took both, one after the
    // other in a single track.
    if (result.audio && !this.audioRendition) {
      if (!this.audioTrack) {
        this.audioTrack = this.makeTrack(result.audioTrack);
      }
      this.pushChunk(this.audioTrack, result.audio, result.initPTS, afterHole);
    }
  }

  /** @param {ZippedFragment} fragData - A fragment of the audio rendition. */
  async pushFragmentAudio(fragData) {
    const entry = await fragData.getEntry();
    const data = await entry.getDataFromBlob();
    const fragment = fragData.fragment;
    // The wrapper has no cc; the discontinuity counter is on hls.js's own fragment (getFrag()).
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
      this.pushChunk(this.audioTrack, result.audio, result.initPTS, afterHole);
    }
  }

  /**
   * @param {Object<string, *>} demuxedTrack the track hls.js's demuxer describes
   * @return {Mp4Track} the track the file is written from
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
   * @param {RemuxedFragment} remuxed hls.js's result for the track: its samples, times and mdat
   * @param {number} initPTS where the stream's clock was at the transmuxer's time 0, in
   *     seconds. The level and the audio rendition each have a transmuxer, which counts
   *     from its own stream's first timestamp: the chunks keep the stream's clock instead,
   *     the one both renditions share, so the tracks start as far apart as they played.
   * @param {boolean} [afterHole] whether fragments are missing before this one (isAfterHole)
   */
  pushChunk(track, remuxed, initPTS, afterHole = false) {
    const headerLen = 8;
    if (afterHole && track.chunks.length) {
      this.padHole(track, remuxed.startDTS + initPTS);
    }
    track.chunks.push({
      id: track.nextChunkId++,
      samples: remuxed.outputSamples,
      offset: /** @type {number} */ (this.datasOffset) + headerLen,
      originalOffset: /** @type {number} */ (this.datasOffset) + headerLen,
      startDTS: remuxed.startDTS + initPTS,
      endDTS: remuxed.endDTS + initPTS,
      startPTS: remuxed.startPTS + initPTS,
      endPTS: remuxed.endPTS + initPTS,
    });
    const blob = new Blob([remuxed.data2], {
      type: 'video/mp4',
    });
    /** @type {Array<*>} */ (this.datas).push(this.blobManager.saveBlob(blob));
    this.datasOffset += remuxed.data2.byteLength;
  }

  /**
   * Stretches a track's last sample over the fragments a partial save lacks, as MP4Merger
   * does for DASH. The samples are written one after the other, so a hole was closed up:
   * the track after it played early, and the other track, with its holes elsewhere (an audio
   * rendition has fragments of its own) or none, was out of step with it from there on.
   * @param {Mp4Track} track
   * @param {number} startDTS where the fragment after the hole starts, on the stream's clock,
   *     in seconds
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
   * @param {import('../hls.mjs').Level} level - The level saved.
   * @param {?Uint8Array} levelInitData - Its init segment, if it has one.
   * @param {import('../hls.mjs').MediaPlaylist|undefined} audioLevel - The audio rendition
   *     selected, if any.
   * @param {?Uint8Array} audioInitData - Its init segment, if it has one.
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
    /** @type {?Array<string>} The blob store's ids of the chunks' mdats, in order. */
    this.datas = [];
    /** @type {number} Where the next mdat goes, after the init segment. */
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
    // The chunks' times are in seconds, on the stream's clock (pushChunk). The movie starts
    // with the first frame shown by either track, as MP4Merger's does.
    // The clock is 33 bits of 90 kHz and wraps every 26.5 hours: a track that starts across
    // the wrap from the first one is brought to the same side of it.
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
      // An empty edit holds back the track that starts later, and is counted in the movie's
      // timescale. It was counted in the track's own and from the first decode time, so a
      // 44100 Hz audio track started 44 ms later against the video than in the stream.
      const delay = Math.round((startOf(track) - minStart) * movieTimescale);
      if (delay > 0) {
        track.elst.push({
          media_time: -1,
          segment_duration: delay,
        });
      }

      // Measured on the samples as they are written, one after the other: across an
      // EXT-X-DISCONTINUITY the stream's timestamps start over (or jump past a fragment a
      // partial save lacks), and an edit worked out from them showed only the first piece
      // of a stream with ad breaks in players that follow edit lists (mpv, VLC, ffmpeg).
      const mediaTime = Math.round((first.startPTS - first.startDTS) * track.timescale);
      let decoded = 0;
      let presentedEnd = 0;
      track.chunks.forEach((chunk) => {
        chunk.samples.forEach((sample) => {
          presentedEnd = Math.max(presentedEnd, decoded + (sample.cts || 0) + sample.duration);
          decoded += sample.duration;
        });
      });
      // The last presented end counts too: a stream cut in decode order (a recording that
      // stopped inside a group of pictures) shows a frame after the decode timeline ends:
      // the edit stopped short of it, and players left the frame out. The edit lasts as
      // long as the track's media. It was shortened by the empty edit before it, which cut
      // the last audio frame off a transport stream's save.
      const presented = Math.max(decoded, presentedEnd - mediaTime);
      track.elst.push({
        media_time: mediaTime,
        segment_duration: Math.round(presented / track.timescale * movieTimescale),
      });

      // flatMap, not push(...samples): a spread of a very long chunk's samples can pass the
      // engine's argument limit and throw a RangeError.
      track.samples = track.chunks.flatMap((chunk) => chunk.samples);
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

    const dataChunks = await Promise.all(/** @type {Array<*>} */ (this.datas).map((data) => {
      return this.blobManager.getBlob(data);
    }));

    // Its own pieces, staged for this save: none is gone before it ends.
    return new Blob([initSeg, .../** @type {Blob[]} */ (dataChunks)], {
      type: 'video/mp4',
    });
  }
  /**
   * @param {import('../hls.mjs').Level} level - The level saved.
   * @param {?Uint8Array} levelInitData - Its init segment, if it has one.
   * @param {import('../hls.mjs').MediaPlaylist|undefined} audioLevel - The audio rendition
   *     selected, if any.
   * @param {?Uint8Array} audioInitData - Its init segment, if it has one.
   * @param {Array<ZippedFragment>} zippedFragments - The fragments of both tracks, by time.
   * @return {Promise<Blob>} The MP4 file.
   */
  async convert(level, levelInitData, audioLevel, audioInitData, zippedFragments) {
    try {
      this.setup(level, levelInitData, audioLevel, audioInitData);
      // Whether the audio comes from a rendition of its own (fragments of track 1). One
      // without a URI is the level's own audio, and has none.
      this.audioRendition = zippedFragments.some((fragment) => fragment.track !== 0);

      let lastProgress = 0;
      for (let i = 0; i < zippedFragments.length; i++) {
        if (this.cancelled) {
          throw new Error('Cancelled');
        }
        if (zippedFragments[i].track === 0) {
          await this.pushFragment(zippedFragments[i]);
        } else {
          await this.pushFragmentAudio(zippedFragments[i]);
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
      // Cancelled, or a fragment that failed to download or demux: nothing will read what
      // was kept, so the blob store goes now, as MP4Merger's does. Only a cancel closed
      // it; after a failure its worker and the fragments on disk stayed until the tab
      // closed.
      this.destroy(/* immediate */ true);
      throw e;
    }
  }

  /**
   * @param {boolean} [immediate] - Closes the blob store too (release()): after a failure.
   */
  destroy(immediate) {
    if (this.transmuxer) this.transmuxer.destroy();
    if (this.transmuxerAudio) this.transmuxerAudio.destroy();
    this.transmuxerAudio = null;
    this.transmuxer = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.prevFrag = null;
    this.datas = null;
    this.datasOffset = 0;

    // After a save that worked, the file convert() returned is made of what the blob
    // store keeps: it stays until release().
    if (immediate) {
      this.release();
    }
  }

  /**
   * Closes the blob store the saved file is made of, once nothing will read the file
   * again (SaveManager: its URL dropped and the download of it over). See MP4Merger's.
   */
  release() {
    const blobManager = this.blobManager;
    // The last use of it: nothing reads the store once it is released.
    this.blobManager = /** @type {any} */ (null);
    blobManager?.close();
  }
}
