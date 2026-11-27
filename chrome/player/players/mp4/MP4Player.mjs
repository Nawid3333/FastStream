// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {ReferenceTypes} from '../../enums/ReferenceTypes.mjs';
import {EmitterCancel, EmitterRelay, EventEmitter} from '../../modules/eventemitter.mjs';
import {DataStream, Endianness, createFile} from '../../modules/mp4box/mp4box.all.mjs';
import {startsLikeMp4} from '../../utils/ContainerSniff.mjs';
import {VideoUtils} from '../../utils/VideoUtils.mjs';
import {AudioLevel, VideoLevel} from '../Levels.mjs';
import {relabelEsdsAacLayout} from './AacLayout.mjs';
import {audioTrackLabel, audioTrackMime, pickAudioTrack} from './AudioTracks.mjs';
import {MP4Fragment} from './MP4Fragment.mjs';
import {MAX_FILE_LENGTH, lengthFromAnswer, startsElsewhere} from './RangeAnswers.mjs';
import {MP4FragmentRequester} from './MP4FragmentRequester.mjs';

/** @typedef {import('../../modules/mp4box/mp4box.all.mjs').ISOFile} ISOFile */
/** @typedef {import('../../modules/mp4box/mp4box.all.mjs').Sample} Sample */
/** @typedef {ISOFile['moov']['traks'][number]} TrakBox */
/** @typedef {import('../../modules/mp4box/mp4box.all.mjs').Movie} Movie */
/** @typedef {import('../../modules/mp4box/mp4box.all.mjs').Track} Track */
/** @typedef {import('../../modules/mp4box/mp4box.all.mjs').MP4BoxBuffer} MP4BoxBuffer */
/** @typedef {import('../../network/DownloadEntry.mjs').DownloadEntry} DownloadEntry */
/** @typedef {import('../../network/FetchLoader.mjs').FetchLoader['stats']} LoadStats */
/**
 * @typedef {{trak: TrakBox|undefined, track: Track, samples: Array<Sample>,
 *   sortedSamples: Array<Sample>, sortedCount: number}} PlayedTrack
 */
import {RangeTimes, addKeyframes, apartBy, keyframeOffset, sampledDuration, sortKeyframes} from './SampleIndex.mjs';
import {DurationSync} from './DurationSync.mjs';
import {loopDelay} from './LoopPace.mjs';
import {SegmentAppender} from './SegmentAppender.mjs';
import {SourceBufferWrapper, removalPending} from './SourceBufferWrapper.mjs';
import {SaveFragmentFetcher, savedEntry} from '../SaveFragmentFetcher.mjs';
import {StallWatchdog, bufferedAhead} from './StallWatchdog.mjs';
const FRAGMENT_SIZE = 1000000;
// How far past the back buffer a SourceBuffer may run before it is trimmed, in seconds.
const BACK_BUFFER_SLACK = 1;
// The least maxBufferLength comes down to (a SourceBuffer that is full), in seconds.
const MIN_BUFFER_LENGTH = 5;
// Waits before a failed range is asked for again, in ms; still failing, it is the error once playback is there.
const RANGE_RETRY_DELAYS_MS = [2000, 4000, 8000];

const VIDEO_TRACK = 0;
const AUDIO_TRACK = 1;

/**
 * An init segment or a removal the SourceBuffer refused: nothing to mend.
 * @param {Error} e
 */
function warnRefused(e) {
  console.warn('The SourceBuffer refused an operation', e);
}

export default class MP4Player extends EventEmitter {
  /**
   * @param {import('../../FastStreamClient.mjs').FastStreamClient} client
   * @param {{isPreview?: boolean, isAudioOnly?: boolean}} [config]
   */
  constructor(client, config) {
    super();
    this.client = client;
    this.boundMainLoop = this.mainLoop.bind(this);
    // Waiting for the first frame (setSource), and when that start last got somewhere.
    this.needsInit = false;
    this.initProgressAt = 0;

    this.isPreview = config?.isPreview || false;
    this.isAudioOnly = config?.isAudioOnly || false;
    this.video = /** @type {HTMLVideoElement} */ (document.createElement(this.isAudioOnly ? 'audio' : 'video'));
    // A seek or a play while the main loop waits at its paused pace: its next round at once.
    this.video.addEventListener('play', () => this.wakeLoop());
    // The first frame's data: the start is over (needsInit), at the loop's next round.
    this.video.addEventListener('loadeddata', () => {
      if (this.needsInit) this.wakeLoop();
    });
    this.video.addEventListener('seeking', () => {
      this.wakeLoop();
      this.onElementSeeking();
    });
    // Where the last seek made through currentTime here took the element; null once it landed.
    /** @type {number|null} */
    this.ownSeek = null;
    this.video.addEventListener('seeked', () => {
      // Not the seeked of an earlier seek, queued before the next began.
      if (!this.video?.seeking) this.ownSeek = null;
    });
    // A start set before the element had data that it never sought to: the mark goes at the first frame.
    this.video.addEventListener('loadeddata', () => {
      if (!this.video?.seeking) this.ownSeek = null;
    });

    this.mp4box = createFile(false);
    this.rangeTimes = new RangeTimes();

    this.options = {
      backBufferLength: 10,
      maxFragmentsBuffered: 30,
      maxBufferLength: this.isPreview ? 10 : 30,
    };

    this.metaData = null;
    this.fileLength = 0;
    this.handedOver = false;

    this.fragmentRequester = new MP4FragmentRequester(this);

    this.running = false;
    this.nothingToPreview = false;

    this.loaded = false;

    /** @type {Array<PlayedTrack>} */
    this.videoTracks = [];
    /** @type {Array<PlayedTrack>} */
    this.audioTracks = [];
    /** @type {?VideoDecoderConfig} The video track's, for the seek preview's pictures (previewKeyframes). */
    this.previewDecoderConfig = null;
    /** @type {TrakBox|undefined} The track previewDecoderConfig is for. */
    this.previewDecoderTrak = undefined;


    this.currentVideoTrack = 0;
    this.currentAudioTrack = this.isPreview ? null : 0;

    /** @type {Array<MP4Fragment>} */
    this.currentFragments = [];
    this.rangeRetries = new Map();
    // How much of each range mp4box has had while it downloads (feedPiece).
    /** @type {Map<MP4Fragment, {bytes: number, off: boolean, hadMetaData: boolean, moovInFirstPiece: boolean}>} */
    this.fedRanges = new Map();

    this._duration = 0;
    this.durationSync = new DurationSync(() => this.mediaSource,
        () => /** @type {SourceBufferWrapper[]} */ ([this.videoSourceBuffer, this.audioSourceBuffer].filter(Boolean)));
    // While the player waits for its first frame, an append is progress: the next loop round at once.
    this.boundApplyDuration = () => {
      this.durationSync.apply();
      if (this.needsInit) this.wakeLoop();
    };
    // A seek past the element's duration, waiting for the duration to be set; null: none.
    /** @type {?number} */
    this.pendingSeek = null;
    // A preview's place past the duration it knows of a fragmented file, held while it reads on.
    /** @type {?number} */
    this.previewSeek = null;

    // Still stuck once its nudges are spent: an error the player shows.
    this.stallWatchdog = new StallWatchdog((time) => {
      this.emit(DefaultPlayerEvents.ERROR, 'Playback stuck at ' + time);
    });

    this.segmentAppender = new SegmentAppender({
      reload: () => this.resetHLS(true),
      // A SourceBuffer that is full holds less than this player reads ahead.
      readLess: () => {
        this.options.maxFragmentsBuffered = Math.max(2, Math.floor(this.options.maxFragmentsBuffered / 2));
        this.options.maxBufferLength = Math.max(MIN_BUFFER_LENGTH, Math.floor(this.options.maxBufferLength / 2));
      },
      fail: (message) => {
        this.running = false;
        this.emit(DefaultPlayerEvents.ERROR, message);
      },
      isCurrent: (wrapper) => this.running && (wrapper === this.videoSourceBuffer || wrapper === this.audioSourceBuffer),
    });
  }


  load() {
    this.loaded = true;
  }

  getClient() {
    return this.client;
  }

  removeSourceBuffers() {
    if (this.videoSourceBuffer) {
      /** @type {MediaSource} */ (this.mediaSource).removeSourceBuffer(this.videoSourceBuffer.sourceBuffer);
      this.videoSourceBuffer = null;
    }

    if (this.audioSourceBuffer) {
      /** @type {MediaSource} */ (this.mediaSource).removeSourceBuffer(this.audioSourceBuffer.sourceBuffer);
      this.audioSourceBuffer = null;
    }
  }

  /**
   * The played video track's keyframes by time, for the seek preview's pictures (PreviewThumbnailer), with the
   * decoder config WebCodecs takes for them; the file's parts are partSize bytes each.
   * @return {?{config: VideoDecoderConfig, keyframes: Sample[], partSize: number}} None before the metadata.
   */
  previewKeyframes() {
    const played = this.videoTracks[parseInt(/** @type {any} */ (this.currentVideoTrack))];
    const track = this.metaData ? this.playedVideoTrack() : undefined;
    if (!played?.trak || !track) return null;
    let config = this.previewDecoderConfig;
    if (!config || this.previewDecoderTrak !== played.trak) {
      /** @type {*} */
      const entry = played.trak.mdia.minf.stbl.stsd.entries[0];
      const box = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;
      /** @type {Uint8Array|undefined} */
      let description;
      if (box) {
        const stream = new DataStream();
        stream.endianness = Endianness.BIG_ENDIAN;
        box.write(stream);
        // The box's contents, without its own size and type.
        description = new Uint8Array(stream.buffer, 8);
      }
      config = {codec: track.codec, codedWidth: track.video?.width, codedHeight: track.video?.height, description};
      this.previewDecoderConfig = config;
      this.previewDecoderTrak = played.trak;
    }
    return {config, keyframes: played.sortedSamples, partSize: FRAGMENT_SIZE};
  }

  /**
   * None for a sound-only player of a file with sound (SyncedAudioPlayer, the analyzer): it plays no picture.
   * @return {Track|undefined} Once the metadata is in.
   */
  playedVideoTrack() {
    const metaData = /** @type {Movie} */ (this.metaData);
    if (this.isAudioOnly && metaData.audioTracks.length) return undefined;
    return metaData.videoTracks[this.currentVideoTrack];
  }

  makeSourceBuffers() {
    const videoTrack = this.playedVideoTrack();
    if (videoTrack) {
      const videoCodec = 'video/mp4; codecs=\"' + videoTrack.codec + '\"';
      this.videoSourceBuffer = new SourceBufferWrapper(/** @type {MediaSource} */ (this.mediaSource), videoCodec);
      this.videoSourceBuffer.on('updateend', this.boundApplyDuration);
    }

    if (this.currentAudioTrack !== null) {
      const audioTrack = /** @type {Movie} */ (this.metaData).audioTracks[this.currentAudioTrack];
      if (audioTrack) {
        this.audioSourceBuffer = new SourceBufferWrapper(/** @type {MediaSource} */ (this.mediaSource), audioTrackMime(audioTrack.codec));
        this.audioSourceBuffer.on('updateend', this.boundApplyDuration);
      }
    }
  }

  /** @param {number} id */
  freeSamples(id) {
    // samples_stored: patches/mp4box@*.patch.
    const trak = /** @type {TrakBox & {samples_stored: Sample[]}} */ (this.mp4box.getTrackById(id));

    trak.samples_stored.forEach((sample) => {
      this.mp4box.releaseSample(trak, sample.number);
    });

    trak.samples_stored.length = 0;
  }

  setupHLS() {
    this.removeSourceBuffers();
    try {
      this.makeSourceBuffers();
    } catch (e) {
      this.emit(DefaultPlayerEvents.ERROR, 'Failed to create SourceBuffers: ' + /** @type {Error} */ (e).message);
      return;
    }
    this.startSegmentation();
  }

  /**
   * Has mp4box cut the played tracks into segments for their SourceBuffers, from the playhead on.
   * @param {{audioOnly?: boolean}} [options] - audioOnly: the audio track changed; the video's init segment is in already.
   */
  startSegmentation({audioOnly = false} = {}) {
    this.mp4box.fragmentedTracks.length = 0;

    const videoTrack = this.playedVideoTrack();
    const audioTrack = /** @type {Movie} */ (this.metaData).audioTracks[/** @type {number} */ (this.currentAudioTrack)];

    this.mp4box.onSegment = (id, user, buffer, sampleNumber, last) => {
      // The tracks played now, not when this was set: switchAudioTrack's flush gives samples of the old audio.
      const playedAudio = this.currentAudioTrack === null ? undefined : this.metaData?.audioTracks[this.currentAudioTrack];
      // A preview reading on past the duration it knew: only the duration it tells is kept.
      if (this.previewSeek !== null) {
        this.freeSamples(id);
        this.updateDuration();
        return;
      }
      if (videoTrack?.id === id) {
        this.segmentAppender.append(/** @type {SourceBufferWrapper} */ (this.videoSourceBuffer), buffer);

        this.freeSamples(id);
      } else if (playedAudio?.id === id) {
        this.segmentAppender.append(/** @type {SourceBufferWrapper} */ (this.audioSourceBuffer), buffer);

        this.freeSamples(id);
      } else if (audioTrack?.id === id) {
        this.freeSamples(id);
        return;
      } else {
        throw new Error('Unknown track id');
      }
      this.updateDuration();
    };

    if (videoTrack) {
      this.mp4box.setSegmentOptions(videoTrack.id, 1, {
        nbSamples: 1,
        // Each frame on its own as soon as its bytes are in: cut at keyframes, the first frame waited for the whole GOP.
        rapAlignement: false,
      });
    }

    if (audioTrack) {
      this.mp4box.setSegmentOptions(audioTrack.id, 1, {
        nbSamples: 1,
      });
      // AAC in a channel layout Windows' decoder plays as silence is relabelled (AacLayout.mjs).
      const esd = this.mp4box.getTrackById(audioTrack.id)?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.esds?.data;
      if (esd && relabelEsdsAacLayout(esd)) {
        console.log('Relabelled the AAC channel layout for Windows\' decoder');
      }
    }


    // One initialization segment per track: mp4box 2.x otherwise returns one for all.
    const initSegs = this.mp4box.initializeSegmentation('per-track');

    let ind = 0;
    if (videoTrack) {
      const init = initSegs[ind++].buffer;
      if (!audioOnly) /** @type {SourceBufferWrapper} */ (this.videoSourceBuffer).appendBuffer(init).catch(warnRefused);
    }

    if (audioTrack) {
      /** @type {SourceBufferWrapper} */ (this.audioSourceBuffer).appendBuffer(initSegs[ind++].buffer).catch(warnRefused);
    }

    // From the keyframe before the playhead: from a sample, Firefox drops the frames up to the next keyframe.
    this.seekMp4box(this.currentTime, true);
    this.mp4box.start();
  }

  /**
   * A track that ends before the time (a shorter sound, a seek to the end) goes from its own last keyframe:
   * mp4box leaves it where it was, and the stream never ends.
   * @param {number} time - Seconds.
   * @param {boolean} useRap - From the keyframe at or before the time.
   */
  seekMp4box(time, useRap) {
    this.mp4box.seek(time, useRap);
    for (const {trak} of this.mp4box.fragmentedTracks) {
      const end = this.mp4box.getTrackDuration(trak);
      if (time > end) this.mp4box.seekTrack(end, true, trak);
    }
  }


  async setup() {
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const preEvents = new EventEmitter();

      preEvents.on(DefaultPlayerEvents.DURATIONCHANGE, () => {
        return EmitterCancel;
      });

      const emitterRelay = new EmitterRelay([preEvents, this]);
      VideoUtils.addPassthroughEventListenersToVideo(/** @type {HTMLVideoElement} */ (this.video), emitterRelay);

      this.mp4box.onReady = (info) => {
        this.onMetadataParsed(info);
      };

      this.mp4box.onError = (module, message) => {
        console.error('onError', module, message);
        this.running = false;
        this.emit(DefaultPlayerEvents.ERROR, message);
      };

      this.mediaSource = new MediaSource();
      this.mediaSourceURL = URL.createObjectURL(this.mediaSource);
      this.mediaSource.addEventListener('sourceopen', () => {
        resolve();
      });
      this.video.src = this.mediaSourceURL;
    }));
  }

  estimateTotalSizeFromMetadats() {
    if (this.fileLength || !this.metaData) return;
    // A fragmented file's known samples are only those of the parsed fragments: no length from them.
    if (this.metaData.isFragmented) return;
    const info = this.metaData;
    let maxOffset = 0;
    info.tracks.forEach((track) => {
      const trak = this.mp4box.moov.traks.find((trak) => {
        return trak.tkhd.track_id === track.id;
      });
      const samples = /** @type {TrakBox} */ (trak).samples;
      if (samples.length > 0) {
        const lastSample = samples[samples.length - 1];
        if (lastSample.offset + lastSample.size > maxOffset) {
          maxOffset = lastSample.offset + lastSample.size;
        }
      }
    });
    // A sample past MAX_FILE_LENGTH (a broken or hostile file) gives no length.
    if (maxOffset > MAX_FILE_LENGTH) return;
    this.fileLength = maxOffset;
    this.initializeFragments();
  }

  /** @param {Movie} info - mp4box's description of the file. */
  onMetadataParsed(info) {
    this.metaData = info;
    this.estimateTotalSizeFromMetadats();
    const max = Math.ceil(this.fileLength / FRAGMENT_SIZE);
    const l = this.getCurrentVideoLevelID();
    for (let i = 0; i < max; i++) {
      if (!this.client.getFragment(l, i)) {
        this.client.makeFragment(l, i, new MP4Fragment(l, i, /** @type {import('../../VideoSource.mjs').VideoSource} */ (this.source), i * FRAGMENT_SIZE, Math.min((i + 1) * FRAGMENT_SIZE, this.fileLength)));
      }
    }
    if (info.videoTracks[this.currentVideoTrack]) {
      const trak = this.mp4box.moov.traks.find((trak) => {
        return trak.tkhd.track_id === info.videoTracks[this.currentVideoTrack].id;
      });
      const samples = /** @type {TrakBox} */ (trak).samples;
      this.videoTracks.push({
        trak,
        track: info.videoTracks[this.currentVideoTrack],
        samples: samples,
        sortedSamples: sortKeyframes(samples),
        sortedCount: samples.length,
      });
    }

    for (let l = 0; l < info.audioTracks.length; l++) {
      const trak = this.mp4box.moov.traks.find((trak) => {
        return trak.tkhd.track_id === info.audioTracks[l].id;
      });
      const samples = /** @type {TrakBox} */ (trak).samples;
      this.audioTracks.push({
        trak,
        track: info.audioTracks[l],
        samples: samples,
        sortedSamples: sortKeyframes(samples),
        sortedCount: samples.length,
      });
    }

    this.setFragmentTimes();
    this.currentAudioTrack = this.firstAudioTrack();
    // A file keeping its audio far from its video cannot be read in ranges timed by the video (apartBy).
    const audio = this.currentAudioTrack === null ? null : this.audioTracks[this.currentAudioTrack];
    if (!this.isPreview && !info.isFragmented && this.videoTracks.length && audio &&
        apartBy(this.videoTracks[0].samples, audio.samples) > MIN_BUFFER_LENGTH) {
      this.playDirectly('The file keeps its audio apart from its video');
      return;
    }
    this.emit(DefaultPlayerEvents.MANIFEST_PARSED);
    this.updateDuration();
    // A preview of a file without a picture has nothing to show: it stops here.
    if (this.isPreview && this.videoTracks.length === 0) {
      this.nothingToPreview = true;
      this.running = false;
      return;
    }
    this.setupHLS();
    this.load();
  }

  getVideo() {
    return this.video;
  }

  /** @param {import('../../VideoSource.mjs').VideoSource} source */
  async setSource(source) {
    if (this.source) {
      throw new Error('Source already set');
    }

    this.source = source;
    this.needsInit = true;
    this.initProgressAt = performance.now();

    const levelID = this.getCurrentVideoLevelID();
    if (!this.client.getFragment(levelID, 0)) {
      this.client.makeFragment(levelID, 0, new MP4Fragment(levelID, 0, source, 0, FRAGMENT_SIZE));
    }

    this.running = true;
    this.mainLoop();
  }

  getSource() {
    return this.source;
  }

  mainLoop() {
    if (!this.running) {
      return;
    }
    // A round runs now: a wake while it runs leaves the next round to it.
    this.loopTimeout = null;

    try {
      // Only once something is buffered: a seek to the current time with nothing buffered resets the player.
      if (this.needsInit && this.readyState === 1 && this.buffered.length > 0) {
        const start = this.buffered.start(0);
        if (this.currentTime < start) {
          this.client.setSeekSave(false);
          this.currentTime = start;
          this.client.setSeekSave(true);
        }
      }

      if (this.readyState > 1) {
        this.needsInit = false;
      }

      this.durationSync.apply();
      this.runLoad();
      this.checkEndOfStream();
      this.stallWatchdog.check(this.video);
    } catch (e) {
      // runLoad stops the player with an error of its own; anything else thrown here is the error.
      console.error(e);
      if (this.running) {
        this.running = false;
        this.emit(DefaultPlayerEvents.ERROR, 'Playback stopped: ' + (/** @type {Error|undefined} */ (e)?.message || e));
      }
      return;
    }
    // Stopped, or destroyed, by a listener of an event this round emitted (the stall watchdog's).
    if (!this.running || !this.video) return;
    // The pace: LoopPace.mjs.
    const video = this.video;
    const delay = loopDelay({ended: video.ended, paused: video.paused, seeking: video.seeking,
      readyState: this.readyState, needsInit: this.needsInit, sinceProgress: performance.now() - this.initProgressAt});
    this.loopTimeout = setTimeout(this.boundMainLoop, delay);
  }

  wakeLoop() {
    // Progress for a start that waits for its first frame (LoopPace.INIT_URGENT_MS).
    this.initProgressAt = performance.now();
    // null: a round is running now, and arms the next itself.
    if (!this.running || this.loopTimeout === null) return;
    clearTimeout(this.loopTimeout);
    this.loopTimeout = setTimeout(this.boundMainLoop, 1);
  }

  /**
   * Without endOfStream Firefox waits for data after the last frame: no 'ended', and a seek to the end never completes.
   */
  checkEndOfStream() {
    if (!this.metaData || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }

    const wrappers = /** @type {SourceBufferWrapper[]} */ ([this.videoSourceBuffer, this.audioSourceBuffer].filter(Boolean));
    /** @param {SourceBufferWrapper} wrapper */
    const busy = (wrapper) => wrapper.updating || wrapper.sourceBuffer.updating || wrapper.toDo.length > 0;
    if (wrappers.length === 0 || wrappers.some(busy)) {
      return;
    }

    const tracks = this.mp4box.fragmentedTracks;
    if (tracks.length === 0 || tracks.some((track) => track.trak.nextSample < track.trak.samples.length)) {
      return;
    }

    // A fragmented file's samples are all known only once the range with its last byte is in.
    if (this.metaData.isFragmented && !this.hasLastRange()) {
      return;
    }

    try {
      this.mediaSource.endOfStream();
    } catch (e) {
      console.warn('Could not end the MediaSource stream', e);
    }
  }

  /**
   * Whether the range holding the file's last byte has reached mp4box since the last reset.
   * @return {boolean}
   */
  hasLastRange() {
    return this.fileLength > 0 && this.currentFragments.some((frag) => frag.rangeEnd >= this.fileLength);
  }

  initializeFragments() {
    const max = Math.ceil(this.fileLength / FRAGMENT_SIZE);
    const levelID = this.getCurrentVideoLevelID();
    for (let i = 1; i < max; i++) {
      if (!this.client.getFragment(levelID, i)) {
        this.client.makeFragment(levelID, i, new MP4Fragment(levelID, i, /** @type {import('../../VideoSource.mjs').VideoSource} */ (this.source), i * FRAGMENT_SIZE, Math.min((i + 1) * FRAGMENT_SIZE, this.fileLength)));
      }
    }
  }

  /**
   * A fragmented file's samples come one moof at a time: the keyframe index and the ranges' times follow them.
   */
  refreshSampleIndex() {
    if (!this.metaData?.isFragmented) return;
    const tracks = [...this.videoTracks, ...this.audioTracks];
    if (tracks.every((track) => track.sortedCount === track.samples.length)) return;
    tracks.forEach((track) => {
      track.sortedSamples = addKeyframes(track.sortedSamples, track.samples, track.sortedCount);
      track.sortedCount = track.samples.length;
    });
    this.setFragmentTimes();
  }

  setFragmentTimes() {
    // The ranges are kept under the video level's id, an audio-only file's too: times from its audio track.
    const tracks = this.videoTracks.length ? this.videoTracks : this.audioTracks;
    const levels = this.videoTracks.length ? this.getVideoLevels() :
      new Map(this.audioTracks.length ? [[this.getCurrentVideoLevelID(), null]] : []);
    levels.forEach((level, l) => {
      const frags = /** @type {Array<MP4Fragment>} */ (this.client.getFragments(l.toString()));
      let currentFragment = frags[0];
      currentFragment.start = 0;
      const indexes = this.getIndexes(l);
      const times = this.rangeTimes.times(tracks[indexes.levelID].samples, frags);
      for (let i = 1; i < frags.length; i++) {
        const frag = frags[i];
        const dt = times[i];
        if (dt !== null) {
          const time = Math.floor(dt);
          currentFragment.end = time;
          currentFragment.duration = time - currentFragment.start;
          frag.start = time;
          currentFragment = frag;
        }
      }

      // The player's duration: a fragmented file without a mehd box has none in its metadata.
      currentFragment.end = Math.ceil(this.calculateDuration());
      currentFragment.duration = currentFragment.end - currentFragment.start;
    });
  }

  /**
   * @param {number} start - Seconds.
   * @param {number} end - Seconds.
   */
  removeFromBuffers(start, end) {
    start = Math.max(0, start);
    end = Math.min(/** @type {MediaSource} */ (this.mediaSource).duration, Math.max(end, start));

    if (start === end) {
      return;
    }
    if (this.videoSourceBuffer) {
      this.videoSourceBuffer.remove(start, end).catch(warnRefused);
    }
    if (this.audioSourceBuffer) {
      this.audioSourceBuffer.remove(start, end).catch(warnRefused);
    }
  }

  /**
   * Only while a SourceBuffer is idle and holds a second more than the back buffer keeps: each removal is an update.
   * @param {number} end - Keep what is buffered from here on.
   */
  removeBackBuffer(end) {
    for (const wrapper of [this.videoSourceBuffer, this.audioSourceBuffer]) {
      if (!wrapper || wrapper.updating || wrapper.sourceBuffer.updating || wrapper.toDo.length > 0) {
        continue;
      }
      const buffered = wrapper.buffered;
      if (buffered.length > 0 && buffered.start(0) < end - BACK_BUFFER_SLACK) {
        wrapper.remove(0, end).catch(warnRefused);
      }
    }
  }

  runLoad() {
    if (!this.running || this.nothingToPreview || (this.metaData && !this.loaded)) return;

    // A preview's place past the duration it knew: sought to once the duration reaches it or the last range is in.
    if (this.previewSeek !== null && (this._duration >= this.previewSeek || this.hasLastRange())) {
      const time = this.previewSeek;
      this.previewSeek = null;
      // Its reset loads from there (reloadUnlessBuffered).
      this.currentTime = time;
      return;
    }

    if (this.isPreview && this.readyState >= 2 && this.previewSeek === null) {
      return;
    }

    if (this.loader) {
      return;
    }

    // The whole file parsed and no moov in it (a recording cut off): an error, not a spinner.
    if (!this.metaData && this.fileLength > 0 && this.mp4box.nextParsePosition >= this.fileLength) {
      this.running = false;
      this.emit(DefaultPlayerEvents.ERROR, 'The file has no moov box: it ends before its index was written');
      return;
    }

    const currentFragment = this.currentFragment;

    // Both exits below are errors: no spinner forever, and the next stream is tried.
    if (!currentFragment) {
      this.running = false;
      this.emit(DefaultPlayerEvents.ERROR, 'No current fragment');
      throw new Error('No current fragment');
    }

    const frags = this.client.getFragments(this.getCurrentVideoLevelID()) || [];

    const time = this.video.currentTime;
    // A preview reading on holds none of the ranges on the way: the memory budget cannot free a held range.
    const keptFrom = this.previewSeek ?? time;
    for (let i = 0; i < this.currentFragments.length; i++) {
      const frag = this.currentFragments[i];
      if (frag.sn >= currentFragment.sn) continue;

      if (frag.end < keptFrom - this.options.backBufferLength) {
        this.currentFragments.splice(i, 1);
        frag.removeReference(ReferenceTypes.MP4PLAYER);
        i--;
      }
    }

    this.removeBackBuffer(Math.min(time - this.options.backBufferLength - 1, currentFragment.start));

    const len = frags.length;
    for (let i = currentFragment.sn; i < Math.min(currentFragment.sn + this.options.maxFragmentsBuffered, len); i++) {
      const frag = /** @type {?MP4Fragment} */ (this.client.getFragment(this.getCurrentVideoLevelID(), i));
      if (!frag) {
        this.running = false;
        this.emit(DefaultPlayerEvents.ERROR, 'No next fragment');
        throw new Error('No next fragment');
      }

      if (frag.status === DownloadStatus.DOWNLOAD_FAILED) {
        if (len === 1) {
          this.emit(DefaultPlayerEvents.ERROR, 'Failed first fragment');
          this.running = false;
          throw new Error('First fragment failed to load!');
        }
        if (!this.retryFailedRange(frag)) {
          break;
        }
      }

      // A fragmented file says where a time is only once the ranges before it are parsed: read ahead by ranges.
      if (i !== currentFragment.sn && !this.metaData?.isFragmented &&
          frag.start > this.video.currentTime + this.options.maxBufferLength) {
        break;
      }


      if (!this.currentFragments.includes(frag)) {
        const loader = this.loader = this.fragmentRequester.requestFragment(frag, {
          /**
           * @param {DownloadEntry} entry
           * @param {MP4BoxBuffer} data
           */
          onSuccess: (entry, data) => {
            if (this.loader === loader) {
              this.loader = null;
            } else return;

            // Another range than this one: its bytes would go to mp4box at the wrong place.
            if (startsElsewhere({status: entry.responseStatus, headers: entry.responseHeaders}, frag.rangeStart)) {
              this.playDirectly('The server answers a range other than the one asked for');
              return;
            }

            // The file's length must be known before mp4box parses the moov (onMetadataParsed makes the ranges).
            if (!this.fileLength) {
              const {length, playDirectly, tooLong} = lengthFromAnswer({
                status: entry.responseStatus,
                headers: entry.responseHeaders,
                received: data?.byteLength || 0,
              }, {start: frag.rangeStart, end: frag.rangeEnd});
              if (playDirectly) {
                this.playDirectly(tooLong ? 'The file is too long to load in ranges' :
                  'The server sends the whole file for a range request');
                return;
              }
              if (length > 0) {
                this.fileLength = length;
                this.initializeFragments();
              }
            }
            // More than the range (a 206 without Content-Range): only the range is this fragment's.
            if (data?.byteLength > frag.rangeEnd - frag.rangeStart) {
              const range = /** @type {MP4BoxBuffer} */ (data.slice(0, frag.rangeEnd - frag.rangeStart));
              range.fileStart = data.fileStart;
              data = range;
            }
            // Past the end: a range read on that came back empty, or at or past the length just told.
            if (frag.rangeStart > 0 &&
                (this.fileLength ? frag.rangeStart >= this.fileLength : !(data?.byteLength > 0))) {
              this.endsAt(this.fileLength || frag.rangeStart);
              return;
            }

            // Not an MP4 (a Matroska file served as video/mp4): Firefox's own player reads it.
            if (frag.rangeStart === 0 && !this.metaData && data?.byteLength &&
                !startsLikeMp4(new Uint8Array(data, 0, Math.min(data.byteLength, 8)))) {
              this.playDirectly('The file is not an MP4 file');
              return;
            }

            // What mp4box had of it while it downloaded (feedPiece): the rest goes now.
            const fed = this.fedRanges.get(frag);
            this.fedRanges.delete(frag);
            // As it was before its first piece: a moov in a fed range is no moov after the media.
            const hadMetaData = fed?.bytes ? fed.hadMetaData : !!this.metaData;
            const fedBytes = fed?.bytes || 0;
            if (!fedBytes) {
              this.mp4box.appendBuffer(data);
            } else if (fedBytes < (data?.byteLength || 0)) {
              const rest = /** @type {MP4BoxBuffer} */ (data.slice(fedBytes));
              rest.fileStart = data.fileStart + fedBytes;
              this.mp4box.appendBuffer(rest);
            }
            // Destroyed by a listener of what the append emitted (SyncedAudioPlayer's PLAY_DIRECTLY).
            if (!this.mp4box) return;
            this.refreshSampleIndex();
            this.currentFragments.push(frag);
            this.rangeRetries.delete(frag);
            frag.addReference(ReferenceTypes.MP4PLAYER, true);

            // The moov came after the media (no +faststart): the ranges read before it gave no samples, read again.
            if (!hadMetaData && this.metaData && (frag.sn > 0 || this.moovCameAfterFedMedia(fed))) {
              this.resetHLS(true);
            }

            if (!this.fileLength) {
              // No length from the server: a regular file's comes from its sample table; a short range is the end.
              const received = data?.byteLength || 0;
              const levelID = this.getCurrentVideoLevelID();
              if (received > 0 && received < frag.rangeEnd - frag.rangeStart) {
                this.endsAt(frag.rangeStart + received);
                return;
              } else {
                const nextParsePosition = this.metaData ? frag.rangeEnd : (this.mp4box.nextParsePosition || (frag.rangeEnd + 1));
                // A box before the moov ending past MAX_FILE_LENGTH would make every range up to there at once.
                if (nextParsePosition > MAX_FILE_LENGTH) {
                  this.playDirectly('The file is too long to load in ranges');
                  return;
                }
                const maxIndex = Math.max(frag.sn + 1, Math.floor(nextParsePosition / FRAGMENT_SIZE));
                for (let fragIndex = 1; fragIndex <= maxIndex; fragIndex++) {
                  if (!this.client.getFragment(levelID, fragIndex)) {
                    this.client.makeFragment(levelID, fragIndex, new MP4Fragment(levelID, fragIndex, /** @type {import('../../VideoSource.mjs').VideoSource} */ (this.source), fragIndex * FRAGMENT_SIZE, (fragIndex + 1) * FRAGMENT_SIZE));
                  }
                }
              }
            }
            this.runLoad();
          },
          /**
           * @param {LoadStats} stats
           * @param {ReturnType<MP4Fragment['getContext']>} context
           * @param {ArrayBuffer} data
           * @param {null} xhr
           */
          onProgress: (stats, context, data, xhr) => {

          },
          /**
           * @param {Uint8Array} chunk
           * @param {number} offset
           * @param {import('../../network/FetchLoader.mjs').PartialAnswer} answer
           */
          onChunk: (chunk, offset, answer) => {
            if (this.loader === loader) this.feedPiece(frag, chunk, offset, answer);
          },
          /** @param {DownloadEntry} entry */
          onFail: (entry) => {
            if (this.loader === loader) {
              this.loader = null;
            }
            // Read on without a length: 416 for the range after the end. The file ends there.
            if (!this.fileLength && frag.rangeStart > 0 && entry?.stats?.error?.code === 416) {
              this.endsAt(frag.rangeStart);
            }
          },
          /** @param {DownloadEntry} entry */
          onAbort: (entry) => {
            if (this.loader === loader) {
              this.loader = null;
            }
          },

        }, null, 1000);
        return;
      }
    }
  }

  /**
   * Gives mp4box a piece of a range while it downloads: the range's own answer, from its start, no holes.
   * Before the moov only the first range. The rest goes when the range is in (onSuccess).
   * @param {MP4Fragment} frag
   * @param {Uint8Array} chunk
   * @param {number} offset - Its place in the range.
   * @param {import('../../network/FetchLoader.mjs').PartialAnswer} answer
   */
  feedPiece(frag, chunk, offset, answer) {
    let state = this.fedRanges.get(frag);
    if (!state) {
      // A download joined on the way, its first pieces missed: all of it at its end.
      if (offset !== 0) return;
      state = {bytes: 0, off: false, hadMetaData: !!this.metaData, moovInFirstPiece: false};
      this.fedRanges.set(frag, state);
      // Only an answer that is this range from its start.
      if (parseInt(/^bytes (\d+)-/.exec(answer.contentRange)?.[1] ?? '', 10) !== frag.rangeStart) {
        state.off = true;
        return;
      }
      if (!this.metaData) {
        const length = frag.rangeStart === 0 && chunk.byteLength >= 8 && startsLikeMp4(chunk.subarray(0, 8)) ?
          lengthFromAnswer({status: answer.status, headers: answer.headers, received: 0},
              {start: frag.rangeStart, end: frag.rangeEnd}).length : 0;
        if (!(length > 0)) {
          state.off = true;
          return;
        }
        if (!this.fileLength) {
          this.fileLength = length;
          this.initializeFragments();
        }
      }
    }
    if (state.off) return;
    // A hole (a piece missed): the rest at the range's end.
    if (offset > state.bytes) {
      state.off = true;
      return;
    }
    const end = Math.min(offset + chunk.byteLength, frag.rangeEnd - frag.rangeStart);
    if (end <= state.bytes) return;
    const piece = /** @type {MP4BoxBuffer} */ (chunk.slice(state.bytes - offset, end - offset).buffer);
    piece.fileStart = frag.rangeStart + state.bytes;
    // Counted once mp4box has it: a piece it refused goes again with the rest (onSuccess).
    this.mp4box.appendBuffer(piece);
    if (state.bytes === 0) state.moovInFirstPiece = !!this.metaData;
    state.bytes = end;
  }

  /**
   * Whether a range fed in pieces lost its samples: its moov came after the first piece, with media before it.
   * @param {{bytes: number, hadMetaData: boolean, moovInFirstPiece: boolean}} [fed]
   * @return {boolean}
   */
  moovCameAfterFedMedia(fed) {
    return !!fed?.bytes && !fed.hadMetaData && !fed.moovInFirstPiece && this.moovIsAfterMedia();
  }

  /**
   * A moov merely spanning two pieces loses nothing: reading its range again would stop the playing video.
   * @return {boolean}
   */
  moovIsAfterMedia() {
    const moovStart = this.mp4box.moov?.start;
    return moovStart !== undefined && this.mp4box.mdats.some((mdat) => (mdat.start ?? Infinity) < moovStart);
  }

  /**
   * Asked for again after a growing wait; once the waits are spent it is the error when playback reaches it.
   * @param {MP4Fragment} frag
   * @return {boolean} Whether to ask for it again now.
   */
  retryFailedRange(frag) {
    const now = Date.now();
    let retry = this.rangeRetries.get(frag);
    if (!retry) {
      retry = {count: 0, at: now + RANGE_RETRY_DELAYS_MS[0]};
      this.rangeRetries.set(frag, retry);
    }
    if (retry.count < RANGE_RETRY_DELAYS_MS.length) {
      if (now < retry.at) {
        return false;
      }
      retry.count++;
      retry.at = now + (RANGE_RETRY_DELAYS_MS[retry.count] || 0);
      frag.status = DownloadStatus.WAITING;
      return true;
    }
    // Spent. The video still plays what it has; at the gap it would only spin.
    if (bufferedAhead(this.video.buffered, this.video.currentTime) < 1) {
      this.running = false;
      const message = 'Range ' + frag.sn + ' failed to load' + (frag.failure ? ' (' + frag.failure + ')' : '');
      this.emit(DefaultPlayerEvents.ERROR, message);
      throw new Error(message);
    }
    return false;
  }

  /**
   * @param {MP4Fragment} fragment
   * @param {number} priority - Higher first (a save's -1).
   * @return {Promise<void>}
   */
  downloadFragment(fragment, priority) {
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this.fragmentRequester.requestFragment(fragment, {
        skipProcess: true,
        /**
         * @param {DownloadEntry} entry
         * @param {undefined} data
         */
        onSuccess: (entry, data) => {
          resolve();
        },
        /**
         * @param {LoadStats} stats
         * @param {ReturnType<MP4Fragment['getContext']>} context
         * @param {ArrayBuffer} data
         * @param {null} xhr
         */
        onProgress: (stats, context, data, xhr) => {

        },
        /** @param {DownloadEntry} entry */
        onFail: (entry) => {
          reject(new Error('Failed to download fragment'));
        },
        /** @param {DownloadEntry} e */
        onAbort: (e) => {
          reject(new Error('Aborted download'));
        },
      }, null, priority);
    }));
  }


  get buffered() {
    return this.video.buffered;
  }

  async play() {
    return this.video.play();
  }

  async pause() {
    return this.video.pause();
  }

  destroy() {
    this.running = false;
    // First: a duration released afterwards would start the next append on the dying player.
    this.videoSourceBuffer?.dispose();
    this.audioSourceBuffer?.dispose();
    this.durationSync?.clear();
    this.pendingSeek = null;
    // SourceBuffer.abort() throws unless the MediaSource is open (after endOfStream() it is 'ended').
    const open = this.mediaSource?.readyState === 'open';
    if (this.videoSourceBuffer) {
      if (open) this.videoSourceBuffer.abort();
      this.videoSourceBuffer = null;
    }
    if (this.audioSourceBuffer) {
      if (open) this.audioSourceBuffer.abort();
      this.audioSourceBuffer = null;
    }
    if (this.mediaSourceURL) {
      URL.revokeObjectURL(this.mediaSourceURL);
      this.mediaSourceURL = null;
    }

    if (this.loader) {
      this.loader.abort();
      this.loader = null;
    }

    // Its holds on the fragments it appended go with it, or the memory budget could never free them.
    for (const frag of this.currentFragments.splice(0)) {
      frag.removeReference(ReferenceTypes.MP4PLAYER);
    }

    this.mp4box = /** @type {any} */ (null);
    this.metaData = null;

    this.videoTracks = /** @type {any} */ (null);
    this.audioTracks = /** @type {any} */ (null);

    if (this.loopTimeout) clearTimeout(this.loopTimeout);

    VideoUtils.destroyVideo(/** @type {HTMLVideoElement} */ (this.video));
    this.video = /** @type {any} */ (null);

    this.emit(DefaultPlayerEvents.DESTROYED);
  }

  /**
   * The file ends at a range read on (no length from the server) that brought nothing.
   * @param {number} length
   */
  endsAt(length) {
    this.fileLength = length;
    const fragments = this.client.getFragments(this.getCurrentVideoLevelID());
    // The ranges made past the end hold nothing: dropped, with whatever was kept for them.
    const count = Math.ceil(length / FRAGMENT_SIZE);
    if (fragments && fragments.length > count) {
      fragments.slice(count).forEach((frag) => {
        if (frag) this.client.freeFragment(frag);
        this.rangeRetries.delete(frag);
      });
      fragments.length = count;
    }
    this.initializeFragments();
    this.checkEndOfStream();
    this.runLoad();
  }

  /**
   * Hands the source to Firefox's own player (DirectVideoPlayer), once: this player stops loading.
   * @param {string} reason
   */
  playDirectly(reason) {
    if (this.handedOver) return;
    this.handedOver = true;
    this.running = false;
    console.warn('Playing directly: ' + reason);
    this.emit(DefaultPlayerEvents.PLAY_DIRECTLY, reason);
  }

  /** @param {boolean} [noLoad] - Leaves the loading to the caller. */
  resetHLS(noLoad) {
    if (!this.metaData || this.nothingToPreview) return;
    this.segmentAppender.reloaded();
    // Queued media segments would only be removed again: dropped, before the flush.
    this.videoSourceBuffer?.dropQueuedMedia();
    this.audioSourceBuffer?.dropQueuedMedia();
    this.removeFromBuffers(0, this.video.duration);
    this.mp4box.flush();
    this.mp4box.stream.buffers.length = 0;
    this.fedRanges?.clear();

    this.metaData.tracks.forEach((track) => {
      this.freeSamples(track.id);
    });
    if (this.loader) {
      this.loader.abort();
      this.loader = null;
    }

    this.currentFragments.forEach((frag) => {
      frag.removeReference(ReferenceTypes.MP4PLAYER);
    });

    this.currentFragments.length = 0;
    // A seek tries a failed range afresh.
    this.rangeRetries.clear();
    this.seekMp4box(this.currentTime, true);
    if (!noLoad) this.runLoad();
  }

  set currentTime(value) {
    // A seek held below for the duration waits for the loop's next round (durationSync).
    this.wakeLoop();
    // A preview past the known duration of a fragmented file without mehd is held while it reads on.
    if (this.isPreview && this.metaData?.isFragmented && value > this._duration && !this.hasLastRange()) {
      this.pendingSeek = null;
      this.previewSeek = value;
      return;
    }
    this.previewSeek = null;
    // A seek past the element's duration, or while it has none, waits for the pending duration.
    if (this.durationSync.pending && (!Number.isFinite(this.video.duration) || value > this.video.duration)) {
      this.pendingSeek = value;
      this.durationSync.whenApplied(() => {
        if (this.pendingSeek !== value || !this.video) return;
        this.pendingSeek = null;
        this.currentTime = value;
      });
      return;
    }
    this.pendingSeek = null;
    this.video.currentTime = value;
    // Marked only for a seek the element runs or will run: no seeked would clear a mark at 0.
    const video = this.video;
    this.ownSeek = video.seeking || (video.readyState === 0 && video.currentTime > 0) ? video.currentTime : null;

    // Clamped as the element clamps a seek ([0, duration]): a seek to -3 s lands on 0, maybe buffered.
    let target = Math.max(0, value);
    const duration = this.video.duration;
    if (Number.isFinite(duration)) {
      target = Math.min(target, duration);
    }
    this.reloadUnlessBuffered(target);
  }

  /** @param {number} target */
  reloadUnlessBuffered(target) {
    // A removal still queued takes away what buffered shows (removalPending).
    if (!VideoUtils.isBuffered(this.buffered, target) ||
        removalPending(/** @type {Array<SourceBufferWrapper|null>} */ ([this.videoSourceBuffer, this.audioSourceBuffer]), target)) {
      this.resetHLS();
    }
  }

  /**
   * A seek the element made itself (play() after the end, picture-in-picture controls): mp4box follows it.
   */
  onElementSeeking() {
    const video = this.video;
    if (!this.running || !this.metaData || !video) return;
    const at = video.currentTime;
    if (this.ownSeek !== null && Math.abs(at - this.ownSeek) < 0.001) return;
    this.reloadUnlessBuffered(at);
  }

  get currentTime() {
    return this.pendingSeek ?? this.previewSeek ?? this.video.currentTime;
  }

  get readyState() {
    return this.video.readyState;
  }

  get paused() {
    return this.video.paused;
  }

  getVideoLevels() {
    if (!this.metaData || !this.metaData.videoTracks[0]) return new Map();
    const track = this.metaData.videoTracks[0];
    const result = new Map();
    const id = this.getCurrentVideoLevelID();
    result.set(id, new VideoLevel(/** @type {Exclude<ConstructorParameters<typeof VideoLevel>[0], undefined>} */ ({
      id: id,
      width: track.track_width,
      height: track.track_height,
      bitrate: track.bitrate,
      mimeType: 'video/mp4',
      language: track.language,
      videoCodec: track.codec,
    })));
    return result;
  }

  /**
   * The audio tracks Firefox can play, by level id, in file order.
   * @return {Map<string, AudioLevel>}
   */
  getAudioLevels() {
    const result = new Map();
    // A preview plays no audio (currentAudioTrack null): none to choose.
    if (!this.metaData || this.currentAudioTrack === null) return result;
    this.metaData.audioTracks.forEach((track, index) => {
      if (!MediaSource.isTypeSupported(audioTrackMime(track.codec))) return;
      const id = this.getIdentifier(AUDIO_TRACK, index);
      result.set(id, new AudioLevel(/** @type {Exclude<ConstructorParameters<typeof AudioLevel>[0], undefined>} */ ({
        id: id,
        bitrate: track.bitrate,
        mimeType: 'audio/mp4',
        // 'und' (undetermined), as muxers write for none: no language.
        language: track.language === 'und' ? '' : track.language,
        audioCodec: track.codec,
        label: audioTrackLabel(track.name),
        track,
      })));
    });
    return result;
  }

  /**
   * The audio track to start with (AudioTracks.pickAudioTrack); 0 when none can play.
   * @return {?number} Null for a preview, which plays no audio.
   */
  firstAudioTrack() {
    if (this.currentAudioTrack === null) return null;
    const levels = Array.from(this.getAudioLevels().values());
    const levelManager = this.client.getLevelManager();
    const remembered = levelManager.getCurrentAudioLevelID();
    const chosen = pickAudioTrack(levels,
        (level) => !!((this.audioTracks[this.getIndexes(level.id).levelID]?.trak?.tkhd?.flags ?? 0) & 1),
        typeof remembered === 'string' ? remembered : null,
        (list) => levelManager.filterAudioLevelsByLanguage(list));
    return chosen ? this.getIndexes(chosen.id).levelID : 0;
  }

  getCurrentVideoLevelID() {
    return this.getIdentifier(VIDEO_TRACK, this.currentVideoTrack);
  }

  getCurrentAudioLevelID() {
    return this.getIdentifier(AUDIO_TRACK, this.currentAudioTrack);
  }

  /** @param {string|number|null} levelID */
  setCurrentVideoLevelID(levelID) {
  }

  /**
   * Plays another of the file's audio tracks, from the playhead on.
   * @param {string|number|null} levelID
   */
  setCurrentAudioLevelID(levelID) {
    // A preview plays no audio; before the metadata there is nothing to switch.
    if (typeof levelID !== 'string' || this.currentAudioTrack === null || !this.metaData) return;
    const {trackID, levelID: index} = this.getIndexes(levelID);
    if (trackID !== AUDIO_TRACK || index === this.currentAudioTrack || !this.getAudioLevels().has(levelID)) return;
    this.switchAudioTrack(index);
  }

  /**
   * The same audio SourceBuffer goes on with the other track: Firefox may refuse a new one once media is in.
   * @param {number} index - Into the file's audio tracks.
   */
  switchAudioTrack(index) {
    const wrapper = this.audioSourceBuffer;
    const next = /** @type {Movie} */ (this.metaData).audioTracks[index];
    if (!next) return;
    // Chosen at MANIFEST_PARSED, before setupHLS: the SourceBuffer is made for it.
    if (!wrapper) {
      this.currentAudioTrack = index;
      return;
    }
    const previous = /** @type {Movie} */ (this.metaData).audioTracks[/** @type {number} */ (this.currentAudioTrack)];
    this.currentAudioTrack = index;
    this.resetHLS(true);
    const mimeType = audioTrackMime(next.codec);
    if (!previous || audioTrackMime(previous.codec) !== mimeType) {
      wrapper.changeType(mimeType).catch((e) => {
        this.running = false;
        this.emit(DefaultPlayerEvents.ERROR, 'Could not switch the audio track: ' + (/** @type {Error} */ (e)?.message || e));
      });
    }
    this.startSegmentation({audioOnly: true});
    this.runLoad();
  }


  get duration() {
    return this._duration;
  }

  calculateDuration() {
    if (!this.metaData) return 0;
    const info = this.metaData;
    // A fragmented file's length is in its mehd box; mp4box 2.x's fragment_duration is a fraction.
    const mehd = this.mp4box.moov?.mvex?.mehd;
    let duration = info.isFragmented ?
      (mehd ? mehd.fragment_duration / this.mp4box.moov.mvhd.timescale : 0) :
      (info.duration || 0) / info.timescale;
    if (duration === 0 && info.isFragmented) {
      duration = sampledDuration(this.mp4box.moov.traks);
    }
    return duration;
  }

  updateDuration() {
    const newDuration = this.calculateDuration();
    // The MediaSource takes a duration only while open and idle: DurationSync sets it once it can.
    if (newDuration !== this._duration && /** @type {MediaSource} */ (this.mediaSource).readyState === 'open') {
      this._duration = newDuration;
      this.durationSync.set(newDuration);
      this.emit(DefaultPlayerEvents.DURATIONCHANGE);
    }
  }

  get currentFragment() {
    let startOffset = 0;
    if (!this.metaData && this.mp4box.nextParsePosition) {
      startOffset = this.mp4box.nextParsePosition;
    } else if (this.videoTracks.length || this.audioTracks.length) {
      const time = this.currentTime;
      const sortedSamples = [];
      // Only the tracks it plays: a sound-only player reads from the sound's place.
      if (this.videoTracks[this.currentVideoTrack] && this.playedVideoTrack()) {
        sortedSamples.push(this.videoTracks[parseInt(/** @type {any} */ (this.currentVideoTrack))].sortedSamples);
      }

      if (this.currentAudioTrack !== null && this.audioTracks[this.currentAudioTrack]) {
        sortedSamples.push(this.audioTracks[this.currentAudioTrack].sortedSamples);
      }
      // No keyframe in any track yet: read on from where mp4box stopped.
      startOffset = keyframeOffset(sortedSamples, time) ?? (this.mp4box.nextParsePosition || 0);
    }


    const index = Math.floor(startOffset / FRAGMENT_SIZE);

    return /** @type {?MP4Fragment} */ (this.client.getFragment(this.getCurrentVideoLevelID(), index));
  }

  canSave() {
    const frags = this.client.getFragments(this.getCurrentVideoLevelID());
    if (frags && !this.fileLength) {
      return {
        canSave: true,
        canStream: true,
        isComplete: false,
        // A whole save would write the ranges made so far and call it complete.
        onlyLoaded: true,
      };
    }
    if (!frags) {
      return {
        canSave: false,
        isComplete: false,
      };
    }
    let incomplete = false;
    for (let i = 0; i < frags.length; i++) {
      if (frags[i] && frags[i].status !== DownloadStatus.DOWNLOAD_COMPLETE) {
        incomplete = true;
        break;
      }
    }

    return {
      canSave: true,
      canStream: true,
      isComplete: !incomplete,
    };
  }

  /**
   * @param {{filestream: WritableStream<Uint8Array>, partialSave: boolean,
   *   registerCancel: (cancel: () => void) => void, onProgress: (progress: number) => void}} options
   * @return {Promise<{extension: string, blob: null}>}
   */
  async saveVideo(options) {
    const filestream = options.filestream;
    const writer = filestream.getWriter();
    const frags = /** @type {Array<MP4Fragment>} */ (this.client.getFragments(this.getCurrentVideoLevelID()));
    const emptyTemplate = new Uint8Array(FRAGMENT_SIZE);

    let lastFrag = 0;
    if (options.partialSave) {
      for (let i = frags.length - 1; i >= 0; i--) {
        const frag = frags[i];
        if (frag.status === DownloadStatus.DOWNLOAD_COMPLETE) {
          lastFrag = i + 1;
          break;
        }
      }
    } else {
      lastFrag = frags.length;
    }

    // Held until written: a range playback passed could be let go of meanwhile.
    for (let i = 0; i < lastFrag; i++) {
      frags[i].addReference(ReferenceTypes.SAVER);
    }

    let cancelled = false;
    const fetcher = new SaveFragmentFetcher(this.fragmentRequester, frags.slice(0, lastFrag),
        this.client.downloadManager.downloaderLimit());
    if (options?.registerCancel) {
      options.registerCancel(() => {
        cancelled = true;
        fetcher.cancel();
      });
    }

    try {
      for (let i = 0; i < lastFrag; i++) {
        if (cancelled) {
          throw new Error('Cancelled');
        }
        const frag = frags[i];
        // Past the file's end found meanwhile (endsAt): nothing more to write.
        if (!frag) {
          fetcher.cancel();
          break;
        }
        if (!options.partialSave) {
          await fetcher.get(i);
        }
        if (frag.status === DownloadStatus.DOWNLOAD_COMPLETE) {
          // Downloaded again when the store lost it (savedEntry).
          const entry = await savedEntry(() => this.client.downloadManager.getEntry(frag.getContext()),
              () => this.downloadFragment(frag, -1));
          await writer.write(new Uint8Array(await entry.getDataFromBlob()));
        } else {
          await writer.write(emptyTemplate);
        }
        frag.removeReference(ReferenceTypes.SAVER);

        if (options.onProgress) {
          options.onProgress(i / lastFrag);
        }
      }

      await writer.close();

      return {
        extension: 'mp4',
        blob: null,
      };
    } catch (e) {
      fetcher.cancel();
      for (let i = 0; i < lastFrag; i++) {
        frags[i]?.removeReference(ReferenceTypes.SAVER);
      }
      await writer.abort();
      throw e;
    }
  }

  get volume() {
    return this.video.volume;
  }

  set volume(value) {
    this.video.volume = value;
    if (value === 0) this.video.muted = true;
    else this.video.muted = false;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  set playbackRate(value) {
    this.video.playbackRate = value;
  }


  /**
   * @param {number} trackID - VIDEO_TRACK or AUDIO_TRACK.
   * @param {?number} levelID - The track's index; null for a preview's audio.
   * @return {string}
   */
  getIdentifier(trackID, levelID) {
    return `${trackID}:${levelID}`;
  }

  /**
   * @param {string} identifier
   * @return {{trackID: number, levelID: number}}
   */
  getIndexes(identifier) {
    const parts = identifier.split(':');
    return {
      trackID: parseInt(parts[0]),
      levelID: parseInt(parts[1]),
    };
  }
}
