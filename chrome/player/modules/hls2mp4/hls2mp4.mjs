import {EventEmitter} from '../eventemitter.mjs';
import {FSBlob} from '../FSBlob.mjs';
import {MP4} from './MP4Generator.mjs';
import {normalizePts} from './ptsNormalize.mjs';
import Transmuxer from './transmuxer.mjs';

// The clock MPEG-TS timestamps count in.
const TS_CLOCK = 90000;


export class HLS2MP4 extends EventEmitter {
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
   * @param {Object} fragment
   * @param {Object|undefined} previous the fragment of the same track before it
   * @return {boolean} whether fragments of the same timeline are missing between the two (a
   *     partial save): the stream's clock runs on across them, unlike at a discontinuity.
   */
  isAfterHole(fragment, previous) {
    return !!previous && fragment.cc === previous.cc && fragment.sn > previous.sn + 1;
  }

  async pushFragment(fragData) {
    const entry = await fragData.getEntry();
    const data = await entry.getDataFromBlob();
    const fragment = fragData.fragment;
    const isDiscontinuity = !this.prevFrag || fragment.sn !== this.prevFrag.fragment.sn + 1 || fragment.cc !== this.prevFrag.fragment.cc;
    const afterHole = this.isAfterHole(fragment, this.prevFrag?.fragment);

    if (isDiscontinuity) {
      console.log('discontinuity');
    }
    this.prevFrag = fragData;
    const result = this.transmuxer.pushData(new Uint8Array(data), isDiscontinuity);

    if (result.video) {
      if (!this.videoTrack) {
        this.videoTrack = this.makeTrack(result.videoTrack);
      }

      result.videoTrack.pps.forEach((pps) => {
        if (!this.videoTrack.pps.find((p) => {
          return this.arrayEquals(p, pps);
        })) {
          this.videoTrack.pps.push(pps);
        }
      });

      result.videoTrack.sps.forEach((sps) => {
        if (!this.videoTrack.sps.find((s) => {
          return this.arrayEquals(s, sps);
        })) {
          this.videoTrack.sps.push(sps);
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

  async pushFragmentAudio(fragData) {
    const entry = await fragData.getEntry();
    const data = await entry.getDataFromBlob();
    const fragment = fragData.fragment;
    const isDiscontinuity = !this.prevFragAudio || fragment.sn !== this.prevFragAudio.fragment.sn + 1 || fragment.cc !== this.prevFragAudio.fragment.cc;
    const afterHole = this.isAfterHole(fragment, this.prevFragAudio?.fragment);

    if (isDiscontinuity) {
      console.log('discontinuity');
    }
    this.prevFragAudio = fragData;
    const result = this.transmuxerAudio.pushData(new Uint8Array(data), isDiscontinuity);
    if (result.audio) {
      if (!this.audioTrack) {
        this.audioTrack = this.makeTrack(result.audioTrack);
      }
      this.pushChunk(this.audioTrack, result.audio, result.initPTS, afterHole);
    }
  }

  /**
   * @param {Object} demuxedTrack the track hls.js's demuxer describes
   * @return {Object} the track the file is written from
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
   * @param {Object} track
   * @param {Object} remuxed hls.js's result for the track: its samples, times and mdat
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
      offset: this.datasOffset + headerLen,
      originalOffset: this.datasOffset + headerLen,
      startDTS: remuxed.startDTS + initPTS,
      endDTS: remuxed.endDTS + initPTS,
      startPTS: remuxed.startPTS + initPTS,
      endPTS: remuxed.endPTS + initPTS,
    });
    const blob = new Blob([remuxed.data2], {
      type: 'video/mp4',
    });
    this.datas.push(this.blobManager.saveBlob(blob));
    this.datasOffset += remuxed.data2.byteLength;
  }

  /**
   * Stretches a track's last sample over the fragments a partial save lacks, as MP4Merger
   * does for DASH. The samples are written one after the other, so a hole was closed up:
   * the track after it played early, and the other track, with its holes elsewhere (an audio
   * rendition has fragments of its own) or none, was out of step with it from there on.
   * @param {Object} track
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
    this.datas = [];
    this.datasOffset = 0;
  }

  async finalize() {
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
    const startOf = (track) => normalizePts(track.chunks[0].startPTS * TS_CLOCK, tracks[0].chunks[0].startPTS * TS_CLOCK) / TS_CLOCK;
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

    const dataChunks = await Promise.all(this.datas.map((data) => {
      return this.blobManager.getBlob(data);
    }));

    return new Blob([initSeg, ...dataChunks], {
      type: 'video/mp4',
    });
  }
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
    this.blobManager = null;
    blobManager?.close();
  }
}
