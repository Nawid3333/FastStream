import {EventEmitter} from '../eventemitter.mjs';
import {FSBlob} from '../FSBlob.mjs';
import {BlobManager} from '../../utils/BlobManager.mjs';
import {MP4Writer} from './mp4-writer.mjs';
import {MP4Demuxer, WebMDemuxer} from './demuxers.mjs';
import {Localize} from '../Localize.mjs';
import {AlertPolyfill} from '../../utils/AlertPolyfill.mjs';

const KEYFRAME_INTERVAL = 10 * 1000 * 1000; // 10 seconds
/**
 * Recode Merger
 *
 * Re-encodes video and audio to MP4. Can be very slow.
 *
 * Currently supports WebM input only.
 *
 * REQUIRES WebCodecs (VideoDecoder/VideoEncoder/AudioDecoder/AudioEncoder).
 * Firefox has shipped this on desktop since Firefox 130 (Sept 2024), so the
 * window.VideoDecoder/etc. checks at this module's call sites (dash2mp4.mjs,
 * convert() below) are genuine feature detection, not a Chrome-only gate.
 */
export class Reencoder extends EventEmitter {
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
   * Ends the save with this error. A codec that fails closes itself and puts out nothing
   * more, so pushFragment() would wait for it forever: it is let go instead, and throws
   * the first error.
   *
   * @param {Error} e
   */
  fail(e) {
    console.error(e);
    if (this.error) {
      return;
    }
    this.error = e;
    if (this.resolveRecodePromise) {
      this.resolveRecodePromise();
      this.resolveRecodePromise = null;
    }
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

  async pushFragment(fragData, demuxer) {
    const entry = await fragData.getEntry();
    const blob = await entry.getData();
    const data = await BlobManager.getDataFromBlob(blob, 'arraybuffer');

    demuxer.appendBuffer(data);
    const videoChunks = demuxer.getVideoChunks();
    const audioChunks = demuxer.getAudioChunks();
    demuxer.clearChunks();

    if (this.error) {
      throw this.error;
    }

    videoChunks.forEach((chunk) => {
      this.videoDecoder.decode(chunk);
    });

    audioChunks.forEach((chunk) => {
      this.audioDecoder.decode(chunk);
    });

    const waitEncodePromise = new Promise((resolve) => {
      this.resolveRecodePromise = resolve;
    });

    await waitEncodePromise;

    if (this.error) {
      throw this.error;
    }

    if (this.videoEncoder) {
      if (
        this.videoEncoder.state !== 'configured' ||
        this.videoDecoder.state !== 'configured'
      ) {
        throw new Error('Video encoder/decoder has been closed!');
      }
    }

    if (this.audioEncoder) {
      if (
        this.audioEncoder.state !== 'configured' ||
        this.audioDecoder.state !== 'configured' ||
        !this.resamplerWorker
      ) {
        throw new Error('Audio encoder/decoder/resampler has been closed!');
      }
    }

    if (!this.videoEncoder && !this.audioEncoder) {
      throw new Error('No video or audio encoder');
    }
  }

  async setup(videoMimeType, videoDuration, videoInitSegment, audioMimeType, audioDuration, audioInitSegment) {
    if (!videoDuration && !audioDuration) {
      throw new Error('no video or audio');
    }

    if (videoDuration) {
      this.videoDuration = videoDuration;
      this.videoDemuxer = videoMimeType.includes('webm') ? new WebMDemuxer() : new MP4Demuxer();
      this.videoDemuxer.initialize(videoInitSegment);
    }

    const requeue = (e) => {
      if (this.audioEncoder) {
        if (this.audioDecoder.decodeQueueSize >= 10) {
          return;
        }

        if (this.audioEncoder.encodeQueueSize >= 10) {
          return;
        }

        if (this.resamplerWorkerTasks >= 500) {
          return;
        }
      }

      if (this.videoEncoder) {
        if (this.videoDecoder.decodeQueueSize >= 10) {
          return;
        }

        if (this.videoEncoder.encodeQueueSize >= 10) {
          return;
        }
      }

      if (this.resolveRecodePromise) {
        this.resolveRecodePromise();
        this.resolveRecodePromise = null;
      }
    };

    if (this.videoDemuxer && this.videoDemuxer.getVideoDecoderConfig()) {
      const decoderConfig = this.videoDemuxer.getVideoDecoderConfig();
      const encoderConfig = {
        codec: 'avc1.4d003e',
        width: decoderConfig.codedWidth,
        height: decoderConfig.codedHeight,
      };

      console.log('Video decoder config: ', decoderConfig);
      console.log('Video encoder config: ', encoderConfig);

      const support = await VideoDecoder.isConfigSupported(decoderConfig);
      if (!support) {
        throw new Error('unsupported input video codec');
      }

      const support2 = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!support2) {
        throw new Error('unsupported output video codec');
      }

      this.lastVideoKeyframe = 0;

      // A codec that fails has closed itself by the time its error callback runs, so the
      // callbacks only report it (fail()); close() there would throw.
      this.videoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          this.writer.addVideoChunk(chunk, meta);
          requeue();
        },
        error: (e) => this.fail(e),
      });
      this.videoEncoder.configure(encoderConfig);


      this.videoDecoder = new VideoDecoder({
        output: (frame) => {
          try {
            if (this.error) {
              return;
            }
            const timestamp = frame.timestamp; // frame.timestamp is in microseconds
            if (timestamp - this.lastVideoKeyframe > KEYFRAME_INTERVAL) {
              this.lastVideoKeyframe = timestamp;
              this.videoEncoder.encode(frame, {keyFrame: true});
            } else {
              this.videoEncoder.encode(frame);
            }
          } catch (e) {
            this.fail(e);
          } finally {
            frame.close();
          }
          requeue();
        },
        error: (e) => this.fail(e),
      });
      this.videoDecoder.configure(decoderConfig);
    }

    const videoHasAudio = this.videoDemuxer && this.videoDemuxer.getAudioDecoderConfig();
    if (audioDuration) {
      if (videoHasAudio) {
        throw new Error('Video already has audio');
      }

      this.audioDuration = audioDuration;
      this.audioDemuxer = audioMimeType.includes('webm') ? new WebMDemuxer() : new MP4Demuxer();
      this.audioDemuxer.initialize(audioInitSegment);
    }

    if (videoHasAudio || (this.audioDemuxer && this.audioDemuxer.getAudioDecoderConfig())) {
      const decoderConfig = this.audioDemuxer ? this.audioDemuxer.getAudioDecoderConfig() : this.videoDemuxer.getAudioDecoderConfig();

      const encoderConfig = {
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: decoderConfig.numberOfChannels,
      };

      console.log('Audio decoder config: ', decoderConfig);
      console.log('Audio encoder config: ', encoderConfig);

      const support = await AudioDecoder.isConfigSupported(decoderConfig);
      if (!support) {
        throw new Error('unsupported input audio codec');
      }

      const support2 = await AudioEncoder.isConfigSupported(encoderConfig);
      if (!support2) {
        throw new Error('unsupported output video codec');
      }

      this.lastAudioKeyframe = 0;
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          this.writer.addAudioChunk(chunk, meta);
          requeue();
        },
        error: (e) => this.fail(e),
      });
      this.audioEncoder.configure(encoderConfig);

      const currentScript = import.meta;
      let basePath = '';
      if (currentScript) {
        basePath = currentScript.url
            .replace(/#.*$/, '')
            .replace(/\?.*$/, '')
            .replace(/\/[^\/]+$/, '/');
      }
      this.resamplerWorker = new Worker(basePath + 'resampler-worker.mjs', {
        type: 'module',
      });

      this.resamplerWorkerTasks = 0;
      this.resamplerWorker.postMessage({
        type: 'init',
        oldSampleRate: decoderConfig.sampleRate,
        newSampleRate: encoderConfig.sampleRate,
        numChannels: decoderConfig.numberOfChannels,
      });

      this.resamplerWorker.addEventListener('message', (event) => {
        const data = event.data;
        if (data.type === 'resampled') {
          this.resamplerWorkerTasks--;

          const frame = data.data;
          if (this.error) {
            frame.close();
            return;
          }
          try {
            const timestamp = frame.timestamp; // frame.timestamp is in microseconds
            if (timestamp - this.lastAudioKeyframe > KEYFRAME_INTERVAL) {
              this.lastAudioKeyframe = timestamp;
              this.audioEncoder.encode(frame, {keyFrame: true});
            } else {
              this.audioEncoder.encode(frame);
            }
          } catch (e) {
            this.fail(e);
            return;
          }

          requeue();

          if (this.resamplerWorkerTasks === 0 && this.resamplerWorkerPromiseResolve) {
            this.resamplerWorkerPromiseResolve();
            this.resamplerWorkerPromiseResolve = null;
          }
        }
      });

      this.resamplerWorker.addEventListener('error', (e) => {
        this.resamplerWorker.terminate();
        this.resamplerWorker = null;
        this.fail(new Error('The audio resampler failed: ' + (e.message || 'no message')));
      });

      this.audioDecoder = new AudioDecoder({
        output: (data) => {
          if (this.error) {
            data.close();
            return;
          }
          this.resamplerWorkerTasks++;
          this.resamplerWorker.postMessage({
            type: 'pushSample',
            data: data,
          }, [data]);

          requeue();
        },
        error: (e) => this.fail(e),
      });
      this.audioDecoder.configure(decoderConfig);
    }
    this.writer = new MP4Writer(this.blobManager, {
      video: !!this.videoEncoder,
      audio: !!this.audioEncoder,
    }, (e) => this.fail(e));
    await this.writer.start();
  }

  async finalize() {
    try {
      if (this.audioDecoder) {
        // Process last packet
        const left = this.audioDemuxer.getAudioChunks(this.audioDuration);
        left.forEach((chunk) => {
          this.audioDecoder.decode(chunk);
        });

        await this.audioDecoder.flush();
        await this.audioEncoder.flush();
      }

      if (this.videoDecoder) {
        // Process last packet
        const left = this.videoDemuxer.getVideoChunks(this.videoDuration);
        left.forEach((chunk) => {
          this.videoDecoder.decode(chunk);
        });

        await this.videoDecoder.flush();
        await this.videoEncoder.flush();
      }
    } catch (e) {
      // A codec that failed rejects its flush, or throws on decode, with less to say
      // than the error that closed it.
      throw this.error || e;
    }

    if (this.error) {
      throw this.error;
    }
    return this.writer.finalize();
  }

  async convert(videoMimeType, videoDuration, videoInitSegment, audioMimeType, audioDuration, audioInitSegment, zippedFragments) {
    // Check webcodec support
    if (!window.VideoDecoder || !window.VideoEncoder || !window.AudioDecoder || !window.AudioEncoder) {
      throw new Error('Webcodecs not supported');
    }

    const answer = await AlertPolyfill.confirm(Localize.getMessage('player_savevideo_reencode'), 'warning');
    if (!answer) {
      throw new Error('Cancelled');
    }

    try {
      await this.setup(videoMimeType, videoDuration, videoInitSegment, audioMimeType, audioDuration, audioInitSegment);

      let lastProgress = 0;
      for (let i = 0; i < zippedFragments.length; i++) {
        if (this.cancelled) {
          this.destroy();
          this.blobManager.close();
          throw new Error('Cancelled');
        }
        if (zippedFragments[i].track === 0) {
          await this.pushFragment(zippedFragments[i], this.videoDemuxer);
        } else {
          await this.pushFragment(zippedFragments[i], this.audioDemuxer);
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
      // Frees the codecs and the resampler worker, which stay open until closed.
      this.destroy();
      throw e;
    }
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    // A codec that failed is closed already, and close() on it throws.
    for (const codec of ['videoDecoder', 'audioDecoder', 'videoEncoder', 'audioEncoder']) {
      if (this[codec]) {
        if (this[codec].state !== 'closed') {
          this[codec].close();
        }
        this[codec] = null;
      }
    }

    if (this.resamplerWorker) {
      this.resamplerWorker.terminate();
      this.resamplerWorker = null;
    }

    this.videoDemuxer = null;
    this.audioDemuxer = null;

    if (this.writer) {
      // Stops a file that is still being written; one that was finished stays as it is.
      this.writer.cancel().catch((e) => console.warn(e));
      this.writer = null;
    }

    setTimeout(() => {
      this.blobManager.close();
      this.blobManager = null;
    }, 120000);
  }
}
