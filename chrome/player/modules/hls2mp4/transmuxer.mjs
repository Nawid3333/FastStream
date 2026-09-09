import {TSDemuxer, MP4Remuxer, MP4Demuxer, AACDemuxer, MP3Demuxer, PassThroughRemuxer, ChunkMetadata} from '../hls.mjs';

// hls.js 1.7.2 added a chunkMeta parameter to Demuxer.resetInitSegment/demux
// and Remuxer.remux that 1.6.9 (what this file was written against) did not
// have. In hls.js's own pipeline it is built per-fragment by the
// FragmentController and always a real object; here, where this file drives
// the demuxer/remuxer classes directly on already-downloaded fragments for
// the offline HLS-to-MP4 save path, nothing ever constructs one, so it
// arrived as undefined -- and hls.js reads chunkMeta.iframe unconditionally
// at the top of demux(), resetInitSegment() and remux(), so every save of an
// HLS source with an out-of-band init segment (fMP4/CMAF-packaged HLS is
// increasingly the common case) threw immediately.
//
// A single reused, mostly-inert instance is enough: this file bypasses hls.js's
// FragmentController/BufferController entirely and never reads sn/level/part
// back out of it, so the exact values only need to be well-typed, not
// individually meaningful, other than duration, which is worth keeping real
// since box generation downstream can consult it.
function makeChunkMeta(duration) {
  return new ChunkMetadata(0, 0, 1, 0, -1, false, duration || 0, false);
}

const muxConfig = [{
  demux: MP4Demuxer,
  remux: PassThroughRemuxer,
}, {
  demux: TSDemuxer,
  remux: MP4Remuxer,
}, {
  demux: AACDemuxer,
  remux: MP4Remuxer,
}, {
  demux: MP3Demuxer,
  remux: MP4Remuxer,
}];

const Logger = {
  debug: (msg, ...args) => {
    console.debug(`[Transmuxer] ${msg}`, ...args);
  },
  log: (msg, ...args) => {
    console.log(`[Transmuxer] ${msg}`, ...args);
  },
  info: (msg, ...args) => {
    console.info(`[Transmuxer] ${msg}`, ...args);
  },
  warn: (msg, ...args) => {
    console.warn(`[Transmuxer] ${msg}`, ...args);
  },
  error: (msg, ...args) => {
    console.error(`[Transmuxer] ${msg}`, ...args);
  },
};
export default class Transmuxer {
  constructor(transmuxConfig) {
    this.typeSupported = {
      mp4: MediaSource.isTypeSupported('video/mp4'),
      mpeg: MediaSource.isTypeSupported('audio/mpeg'),
      mp3: MediaSource.isTypeSupported('audio/mp4; codecs="mp3"'),
    };

    this.config = new Proxy({
      stretchShortVideoTrack: false,
      maxBufferHole: 0.5,
      maxAudioFramesDrift: 1,
      enableSoftwareAES: true,
      forceKeyFrameOnDiscontinuity: true,
      userAgent: 'android',
    }, {
      get: (obj, prop) => {
        // console.log("get", prop)
        if (prop in obj) {
          return obj[prop];
        } else {
          console.log('get', prop);
          return null;
        }
      },
    });

    this.vendor = 'AJS/FastStream';

    this.transmuxConfig = {
      audioCodec: null,
      videoCodec: null,
      initSegmentData: null,
      duration: null,
      defaultInitPts: null,
      ...transmuxConfig,
    };
  }

  get observer() {
    return {
      emit: (event, name, data) => {
        console.log(event, name, data);
      },
      removeAllListeners: () => {},
      on: () => {},
      off: () => {},
    };
  }

  configureTransmuxer(data) {
    const {
      config,
      observer,
      typeSupported,
    } = this;
    // probe for content type
    let mux;
    for (let i = 0, len = muxConfig.length; i < len; i++) {
      if (muxConfig[i].demux.probe(data, Logger)) {
        mux = muxConfig[i];
        break;
      }
    }
    if (!mux) {
      return new Error('Failed to find demuxer by probing fragment data');
    }
    // so let's check that current remuxer and demuxer are still valid
    const demuxer = this.demuxer;
    const remuxer = this.remuxer;
    const Remuxer = mux.remux;
    const Demuxer = mux.demux;

    if (!remuxer || !(remuxer instanceof Remuxer)) {
      this.remuxer = new Remuxer(observer, config, typeSupported, Logger);
    }
    if (!demuxer || !(demuxer instanceof Demuxer)) {
      this.demuxer = new Demuxer(observer, config, typeSupported);
      this.probe = Demuxer.probe;
    }
  }

  pushData(data, discontinuity) {
    const uintData = new Uint8Array(data);

    if (!this.demuxer || !this.remuxer) {
      this.configureTransmuxer(uintData);
    }

    const {transmuxConfig} = this;
    const {audioCodec, videoCodec, defaultInitPts, duration, initSegmentData} = transmuxConfig;

    if (discontinuity) {
      this.resetInitSegment(initSegmentData, audioCodec, videoCodec, duration);
      this.resetInitialTimestamp(defaultInitPts);
      this.resetContiguity();
    }
    const result = this.demux(uintData);
    const remuxed = this.remux(result.videoTrack, result.audioTrack, result.minPTS || 0);
    remuxed.videoTrack = result.videoTrack;
    remuxed.audioTrack = result.audioTrack;
    return remuxed;
  }

  resetInitialTimestamp(defaultInitPts) {
    const {demuxer, remuxer} = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetTimeStamp(defaultInitPts);
    remuxer.resetTimeStamp(defaultInitPts);
  }
  resetContiguity() {
    const {demuxer, remuxer} = this;
    if (!demuxer || !remuxer) {
      return;
    }
    demuxer.resetContiguity();
    remuxer.resetNextTimestamp();
  }
  resetInitSegment(initSegmentData, audioCodec, videoCodec, trackDuration) {
    const {demuxer, remuxer} = this;
    if (!demuxer || !remuxer) {
      return;
    }
    // decryptdata (5th) stays undefined -- this offline save path never
    // handles DRM-encrypted content -- but chunkMeta (6th) has to be a real
    // object: TSDemuxer.resetInitSegment reads chunkMeta.iframe as soon as
    // an init segment is present, unconditionally.
    demuxer.resetInitSegment(initSegmentData, audioCodec, videoCodec, trackDuration,
        undefined, makeChunkMeta(trackDuration));
    remuxer.resetInitSegment(initSegmentData, audioCodec, videoCodec);
  }
  destroy() {
    if (this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = undefined;
    }
    if (this.remuxer) {
      this.remuxer.destroy();
      this.remuxer = undefined;
    }
  }
  remux(videoTrack, audioTrack, timeOffset) {
    const id3Track = {
      'type': 'id3',
      'id': 3,
      'pid': -1,
      'inputTimeScale': 90000,
      'sequenceNumber': 0,
      'samples': [],
      'dropped': 0,
      'pesData': null,
    };
    const textTrack = {
      'type': 'text',
      'id': 4,
      'pid': -1,
      'inputTimeScale': 90000,
      'sequenceNumber': 0,
      'samples': [],
      'dropped': 0,
    };

    // 9th positional arg (chunkMeta) is new in hls.js 1.7.2 and read
    // unconditionally at the top of remux() -- see makeChunkMeta above.
    return this.remuxer.remux(audioTrack, videoTrack, id3Track, textTrack, timeOffset, true, false, 3,
        makeChunkMeta(this.transmuxConfig.duration));
  }
  getVideoStartPts(videoSamples) {
    let rolloverDetected = false;
    const startPTS = videoSamples.reduce((minPTS, sample) => {
      const delta = sample.pts - minPTS;
      if (delta < -4294967296) {
        // 2^32, see PTSNormalize for reasoning, but we're hitting a rollover here, and we don't want that to impact the timeOffset calculation
        rolloverDetected = true;
        return normalizePts(minPTS, sample.pts);
      } else if (delta > 0) {
        return minPTS;
      } else {
        return sample.pts;
      }
    }, videoSamples[0].pts);
    if (rolloverDetected) {
      console.log('PTS rollover detected');
    }
    return startPTS;
  }
  demux(data) {
    // 3rd positional arg (chunkMeta) used to be harmless as `false` here --
    // TSDemuxer.demux only reads chunkMeta.iframe, and false.iframe reads as
    // undefined rather than throwing -- but a real object is used for
    // consistency with the other two call sites, which do throw on it.
    const {audioTrack, videoTrack} = this.demuxer.demux(
        data, null, makeChunkMeta(this.transmuxConfig.duration), true);


    const videoStartPTS = videoTrack.samples.length ? this.getVideoStartPts(videoTrack.samples) : 0;
    const audioStartPTS = audioTrack.samples[0]?.pts || 0;

    const minPTS = Math.min(videoStartPTS, audioStartPTS);

    return {
      audioTrack,
      videoTrack,
      videoStartPTS,
      audioStartPTS,
      minPTS: minPTS / videoTrack.inputTimeScale,
    };
  }
}
export function isPromise(p) {
  return 'then' in p && p.then instanceof Function;
}
