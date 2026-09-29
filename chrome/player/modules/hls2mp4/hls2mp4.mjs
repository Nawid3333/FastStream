import {EventEmitter} from '../eventemitter.mjs';
import {FSBlob} from '../FSBlob.mjs';
import {MP4} from './MP4Generator.mjs';
import Transmuxer from './transmuxer.mjs';


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

  async pushFragment(fragData) {
    const entry = await fragData.getEntry();
    const data = await entry.getDataFromBlob();
    const fragment = fragData.fragment;
    const isDiscontinuity = !this.prevFrag || fragment.sn !== this.prevFrag.fragment.sn + 1 || fragment.cc !== this.prevFrag.fragment.cc;

    if (isDiscontinuity) {
      console.log('discontinuity');
    }
    this.prevFrag = fragData;
    const result = this.transmuxer.pushData(new Uint8Array(data), isDiscontinuity);
    const headerLen = 8;

    if (result.video) {
      if (!this.videoTrack) {
        this.videoTrack = {
          ...result.videoTrack,
          samples: [],
          chunks: [],
          use64Offsets: false,
          nextChunkId: 1,
          elst: [],
        };
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

      this.videoTrack.chunks.push({
        id: this.videoTrack.nextChunkId++,
        samples: result.video.outputSamples,
        offset: this.datasOffset + headerLen,
        originalOffset: this.datasOffset + headerLen,
        startDTS: result.video.startDTS,
        endDTS: result.video.endDTS,
        startPTS: result.video.startPTS,
        endPTS: result.video.endPTS,
      });
      const blob = new Blob([result.video.data2], {
        type: 'video/mp4',
      });
      this.datas.push(this.blobManager.saveBlob(blob));
      this.datasOffset += result.video.data2.byteLength;
    }

    if (result.audio) {
      if (!this.audioTrack) {
        this.audioTrack = {
          ...result.audioTrack,
          samples: [],
          chunks: [],
          use64Offsets: false,
          nextChunkId: 1,
          elst: [],
        };
      }

      this.audioTrack.chunks.push({
        id: this.audioTrack.nextChunkId++,
        samples: result.audio.outputSamples,
        offset: this.datasOffset + headerLen,
        originalOffset: this.datasOffset + headerLen,
        startDTS: result.audio.startDTS,
        endDTS: result.audio.endDTS,
        startPTS: result.audio.startPTS,
        endPTS: result.audio.endPTS,
      });
      const blob = new Blob([result.audio.data2], {
        type: 'video/mp4',
      });
      this.datas.push(this.blobManager.saveBlob(blob));
      this.datasOffset += result.audio.data2.byteLength;
    }
  }

  async pushFragmentAudio(fragData) {
    const entry = await fragData.getEntry();
    const data = await entry.getDataFromBlob();
    const fragment = fragData.fragment;
    const isDiscontinuity = !this.prevFragAudio || fragment.sn !== this.prevFragAudio.fragment.sn + 1 || fragment.cc !== this.prevFragAudio.fragment.cc;

    if (isDiscontinuity) {
      console.log('discontinuity');
    }
    this.prevFragAudio = fragData;
    const result = this.transmuxerAudio.pushData(new Uint8Array(data), isDiscontinuity);
    const headerLen = 8;
    if (result.audio) {
      if (!this.audioTrack) {
        this.audioTrack = {
          ...result.audioTrack,
          samples: [],
          chunks: [],
          use64Offsets: false,
          nextChunkId: 1,
          elst: [],
        };
      }

      this.audioTrack.chunks.push({
        id: this.audioTrack.nextChunkId++,
        samples: result.audio.outputSamples,
        offset: this.datasOffset + headerLen,
        originalOffset: this.datasOffset + headerLen,
        startDTS: result.audio.startDTS,
        endDTS: result.audio.endDTS,
        startPTS: result.audio.startPTS,
        endPTS: result.audio.endPTS,
      });
      const blob = new Blob([result.audio.data2], {
        type: 'video/mp4',
      });
      this.datas.push(this.blobManager.saveBlob(blob));
      this.datasOffset += result.audio.data2.byteLength;
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
    // The chunks' times are in seconds. The movie starts with the first frame shown by either
    // track, as MP4Merger's does.
    let minStart = Infinity;

    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].chunks.length !== len) {
        console.log('WARNING: chunk length is not equal', tracks[i].chunks.length, len);
      }

      minStart = Math.min(minStart, tracks[i].chunks[0].startPTS);
    }

    const movieTimescale = tracks[0].timescale;
    tracks.forEach((track) => {
      track.movieTimescale = movieTimescale;

      const first = track.chunks[0];
      // An empty edit holds back the track that starts later, and is counted in the movie's
      // timescale. It was counted in the track's own and from the first decode time, so a
      // 44100 Hz audio track started 44 ms later against the video than in the stream.
      const delay = Math.round((first.startPTS - minStart) * movieTimescale);
      if (delay > 0) {
        track.elst.push({
          media_time: -1,
          segment_duration: delay,
        });
      }

      const decoded = track.chunks[track.chunks.length - 1].endDTS - first.startDTS;
      // A chunk's endPTS is where its last shown frame ends. A stream cut in decode order
      // (a recording that stopped inside a group of pictures) shows a frame after the decode
      // timeline ends: the edit stopped short of it, and players left the frame out.
      const presented = Math.max(...track.chunks.map((chunk) => chunk.endPTS)) - first.startPTS;
      // The edit lasts as long as the track's media. It was shortened by the empty edit
      // before it, which cut the last audio frame off a transport stream's save.
      track.elst.push({
        media_time: Math.round((first.startPTS - first.startDTS) * track.timescale),
        segment_duration: Math.round(Math.max(decoded, presented) * movieTimescale),
      });

      track.samples = [];
      track.chunks.forEach((chunk) => {
        track.samples.push(...chunk.samples);
      });
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
    this.setup(level, levelInitData, audioLevel, audioInitData);

    let lastProgress = 0;
    for (let i = 0; i < zippedFragments.length; i++) {
      if (this.cancelled) {
        this.destroy();
        this.blobManager.close();
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
  }

  destroy() {
    if (this.transmuxer) this.transmuxer.destroy();
    if (this.transmuxerAudio) this.transmuxerAudio.destroy();
    this.transmuxerAudio = null;
    this.transmuxer = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.prevFrag = null;
    this.datas = null;
    this.datasOffset = 0;

    setTimeout(() => {
      this.blobManager.close();
      this.blobManager = null;
    }, 120000);
  }
}
