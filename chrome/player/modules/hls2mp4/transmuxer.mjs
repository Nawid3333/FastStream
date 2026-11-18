// @ts-check
import {TSDemuxer, MP4Remuxer, MP4Demuxer, AACDemuxer, MP3Demuxer, PassThroughRemuxer, ChunkMetadata} from '../hls.mjs';
import {normalizePts} from './ptsNormalize.mjs';

// hls.js reads chunkMeta.iframe in demux, resetInitSegment and remux: one inert instance serves.
/** @param {?number} [duration] */
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

/** @type {Omit<import('../hls.mjs').ILogger, 'trace'>} */
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
  /**
   * @param {{audioCodec?: string, videoCodec?: string, initSegmentData?: Uint8Array|[],
   *   duration?: number, defaultInitPts?: number}} transmuxConfig
   */
  constructor(transmuxConfig) {
    // The output is an MP4 file, not MSE: MP3 goes in as MP3 in MP4, and AC-3 is kept.
    this.typeSupported = {
      mp4: true,
      mpeg: false,
      mp3: true,
      ac3: true,
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
        if (prop in obj) {
          return /** @type {Record<string|symbol, *>} */ (obj)[prop];
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
      /**
       * @param {import('../hls.mjs').Events} event
       * @param {import('../hls.mjs').Events} name
       * @param {Object} data
       */
      emit: (event, name, data) => {
        console.log(event, name, data);
      },
      removeAllListeners: () => {},
      on: () => {},
      off: () => {},
    };
  }

  /**
   * @param {Uint8Array} data
   * @return {Error|undefined} An error when no demuxer takes it.
   */
  configureTransmuxer(data) {
    const {
      config,
      observer,
      typeSupported,
    } = this;
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
    const demuxer = this.demuxer;
    const remuxer = this.remuxer;
    const Remuxer = mux.remux;
    const Demuxer = mux.demux;

    if (!remuxer || !(remuxer instanceof Remuxer)) {
      this.remuxer = new Remuxer(observer, config, typeSupported, Logger);
    }
    if (!demuxer || !(demuxer instanceof Demuxer)) {
      // TSDemuxer logs through the logger it is given: without one, its first report threw.
      this.demuxer = new Demuxer(observer, config, typeSupported, Logger);
      this.probe = Demuxer.probe;
    }
    return undefined;
  }

  /**
   * @param {Uint8Array} data
   * @param {boolean} discontinuity
   */
  pushData(data, discontinuity) {
    // Not copied: the fragment's buffer is read for this save only, and nothing writes into it.
    const uintData = data instanceof Uint8Array ? data : new Uint8Array(data);

    if (!this.demuxer || !this.remuxer) {
      const error = this.configureTransmuxer(uintData);
      if (error) throw error;
    }

    const {transmuxConfig} = this;
    const {audioCodec, videoCodec, defaultInitPts, duration, initSegmentData} = transmuxConfig;

    if (discontinuity) {
      this.resetInitSegment(initSegmentData, audioCodec, videoCodec, duration);
      this.resetInitialTimestamp(defaultInitPts);
      this.resetContiguity();
      this.initPTS = null;
    }
    const result = this.demux(uintData);
    const remuxed = this.remux(result.videoTrack, result.audioTrack, result.minPTS || 0);
    // hls.js picks an initPTS after each reset, per transmuxer, and reports it with the init segment.
    const initSegment = remuxed.initSegment;
    if (initSegment && Number.isFinite(initSegment.initPTS) && initSegment.timescale) {
      this.initPTS = initSegment.initPTS / initSegment.timescale;
    }
    remuxed.videoTrack = result.videoTrack;
    remuxed.audioTrack = result.audioTrack;
    // Where the stream's own clock was at this transmuxer's time 0, in seconds.
    remuxed.initPTS = this.initPTS ?? 0;
    return remuxed;
  }

  /** @param {?number} defaultInitPts */
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
  /**
   * @param {?Uint8Array|[]} initSegmentData
   * @param {?string|undefined} audioCodec
   * @param {?string|undefined} videoCodec
   * @param {?number} trackDuration
   */
  resetInitSegment(initSegmentData, audioCodec, videoCodec, trackDuration) {
    const {demuxer, remuxer} = this;
    if (!demuxer || !remuxer) {
      return;
    }
    // chunkMeta (6th) must be a real object: TSDemuxer.resetInitSegment reads chunkMeta.iframe.
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
  /**
   * @param {*} videoTrack
   * @param {*} audioTrack
   * @param {number} timeOffset - Seconds.
   */
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

    // chunkMeta (9th): remux() reads it unconditionally (makeChunkMeta).
    return this.remuxer.remux(audioTrack, videoTrack, id3Track, textTrack, timeOffset, true, false, 3,
        makeChunkMeta(this.transmuxConfig.duration));
  }
  /**
   * @param {Array<{pts: number}>} videoSamples
   * @return {number}
   */
  getVideoStartPts(videoSamples) {
    let rolloverDetected = false;
    const startPTS = videoSamples.reduce((minPTS, sample) => {
      const delta = sample.pts - minPTS;
      if (delta < -4294967296) {
        // A 2^32 rollover (hls.js's PTSNormalize) must not affect the timeOffset.
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
  /** @param {Uint8Array} data */
  demux(data) {
    // chunkMeta, then isSampleAes, then flush: without the flush, the last segment's PES data is never parsed.
    const {audioTrack, videoTrack} = this.demuxer.demux(
        data, null, makeChunkMeta(this.transmuxConfig.duration), false, true);


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
