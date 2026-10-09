import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {ReferenceTypes} from '../../enums/ReferenceTypes.mjs';
import {EmitterCancel, EmitterRelay, EventEmitter} from '../../modules/eventemitter.mjs';
import {createFile} from '../../modules/mp4box/mp4box.all.mjs';
import {Utils} from '../../utils/Utils.mjs';
import {VideoUtils} from '../../utils/VideoUtils.mjs';
import {AudioLevel, VideoLevel} from '../Levels.mjs';
import {MP4Fragment} from './MP4Fragment.mjs';
import {lengthFromAnswer} from './RangeAnswers.mjs';
import {MP4FragmentRequester} from './MP4FragmentRequester.mjs';
import {keyframeOffset, sampledDuration} from './SampleIndex.mjs';
import {SegmentAppender} from './SegmentAppender.mjs';
import {SourceBufferWrapper, removalPending} from './SourceBufferWrapper.mjs';
import {SaveFragmentFetcher} from '../SaveFragmentFetcher.mjs';
import {StallWatchdog, bufferedAhead} from './StallWatchdog.mjs';
const FRAGMENT_SIZE = 1000000;
// How far past the back buffer a SourceBuffer may run before it is trimmed, in seconds.
const BACK_BUFFER_SLACK = 1;
// A range that failed (after FetchLoader's own retries, or at once for a 4xx) is asked for
// again after each of these waits, in ms. Still failing, it is the player's error once
// playback has reached it.
const RANGE_RETRY_DELAYS_MS = [2000, 4000, 8000];

const VIDEO_TRACK = 0;
const AUDIO_TRACK = 1;

/**
 * An init segment or a removal the SourceBuffer refused: nothing to mend (a removal that
 * failed loses nothing, and an init segment is appended again with the SourceBuffers), but
 * it was an unhandled rejection.
 * @param {Error} e
 */
function warnRefused(e) {
  console.warn('The SourceBuffer refused an operation', e);
}

export default class MP4Player extends EventEmitter {
  constructor(client, config) {
    super();
    this.client = client;

    this.isPreview = config?.isPreview || false;
    this.isAudioOnly = config?.isAudioOnly || false;
    this.video = document.createElement(this.isAudioOnly ? 'audio' : 'video');

    this.mp4box = createFile(false);

    this.options = {
      backBufferLength: 10,
      maxFragmentsBuffered: 30,
      maxBufferLength: this.isPreview ? 10 : 30,
    };

    this.metaData = null;
    this.fileLength = 0;
    // Handed to Firefox's own player (playDirectly): this player stops.
    this.handedOver = false;

    this.fragmentRequester = new MP4FragmentRequester(this);

    this.running = false;

    this.loaded = false;

    this.videoTracks = [];
    this.audioTracks = [];


    this.currentVideoTrack = 0;
    this.currentAudioTrack = this.isPreview ? null : 0;

    this.currentFragments = [];
    // Failed ranges' retries: fragment -> {count, at}.
    this.rangeRetries = new Map();

    this._duration = 0;

    // Still stuck once its nudges are spent: an error the player shows, rather than a
    // video frozen for good with nothing said.
    this.stallWatchdog = new StallWatchdog((time) => {
      this.emit(DefaultPlayerEvents.ERROR, 'Playback stuck at ' + time);
    });

    this.segmentAppender = new SegmentAppender({
      reload: () => this.resetHLS(true),
      // A SourceBuffer that is full holds less than this player reads ahead.
      readLess: () => {
        this.options.maxFragmentsBuffered = Math.max(2, Math.floor(this.options.maxFragmentsBuffered / 2));
        this.options.maxBufferLength = Math.max(5, Math.floor(this.options.maxBufferLength / 2));
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
      this.mediaSource.removeSourceBuffer(this.videoSourceBuffer.sourceBuffer);
      this.videoSourceBuffer = null;
    }

    if (this.audioSourceBuffer) {
      this.mediaSource.removeSourceBuffer(this.audioSourceBuffer.sourceBuffer);
      this.audioSourceBuffer = null;
    }
  }

  makeSourceBuffers() {
    const videoTrack = this.metaData.videoTracks[this.currentVideoTrack];
    if (videoTrack) {
      const videoCodec = 'video/mp4; codecs=\"' + videoTrack.codec + '\"';
      this.videoSourceBuffer = new SourceBufferWrapper(this.mediaSource, videoCodec);
    }

    if (this.currentAudioTrack !== null) {
      const audioTrack = this.metaData.audioTracks[this.currentAudioTrack];
      if (audioTrack) {
        let fixedCodec = audioTrack.codec;
        if (fixedCodec === 'Opus') {
          fixedCodec = 'opus';
        }
        const audioCodec = 'audio/mp4; codecs=\"' + fixedCodec + '\"';
        this.audioSourceBuffer = new SourceBufferWrapper(this.mediaSource, audioCodec);
      }
    }
  }

  freeSamples(id) {
    // return;
    const trak = this.mp4box.getTrackById(id);

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
      this.emit(DefaultPlayerEvents.ERROR, 'Failed to create SourceBuffers: ' + e.message);
      return;
    }

    this.mp4box.fragmentedTracks.length = 0;

    const videoTrack = this.metaData.videoTracks[this.currentVideoTrack];
    const audioTrack = this.metaData.audioTracks[this.currentAudioTrack];

    this.mp4box.onSegment = (id, user, buffer, sampleNumber, last) => {
      // console.log(id, sampleNumber)
      // A file can have no video track (audio only) or no audio track.
      // The samples are released once the segment is queued: one the SourceBuffer refuses
      // is handled by the appender, which loads again from the playhead.
      if (videoTrack?.id === id) {
        this.segmentAppender.append(this.videoSourceBuffer, buffer);

        this.freeSamples(id);
      } else if (audioTrack?.id === id) {
        this.segmentAppender.append(this.audioSourceBuffer, buffer);

        this.freeSamples(id);
      } else {
        throw new Error('Unknown track id');
      }
      this.updateDuration();
    };

    if (videoTrack) {
      this.mp4box.setSegmentOptions(videoTrack.id, 1, {
        nbSamples: 1,
      });
    }

    if (audioTrack) {
      this.mp4box.setSegmentOptions(audioTrack.id, 1, {
        nbSamples: 1,
      });
    }


    // One initialization segment per track, each for its own SourceBuffer. mp4box 2.x
    // otherwise returns a single one for all the tracks.
    const initSegs = this.mp4box.initializeSegmentation('per-track');

    let ind = 0;
    if (videoTrack) {
      this.videoSourceBuffer.appendBuffer(initSegs[ind++].buffer).catch(warnRefused);
    }

    if (audioTrack) {
      this.audioSourceBuffer.appendBuffer(initSegs[ind++].buffer).catch(warnRefused);
    }

    this.mp4box.seek(this.currentTime);
    this.mp4box.start();
  }


  async setup() {
    return new Promise((resolve, reject) => {
      const preEvents = new EventEmitter();

      preEvents.on(DefaultPlayerEvents.DURATIONCHANGE, () => {
        return EmitterCancel;
      });

      const emitterRelay = new EmitterRelay([preEvents, this]);
      VideoUtils.addPassthroughEventListenersToVideo(this.video, emitterRelay);

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
    });
  }

  sortSamples(samples) {
    samples = samples.filter((sample) => {
      return sample.is_sync;
    });
    samples.sort((a, b) => {
      return a.cts - b.cts;
    });
    return samples;
  }

  estimateTotalSizeFromMetadats() {
    if (this.fileLength || !this.metaData) return;
    // A fragmented file's samples are only those of the fragments parsed so far: taken for its
    // length, they ended the video after the first range. Without a length from the server it
    // is read on, range by range, until a range comes back short (onSuccess).
    if (this.metaData.isFragmented) return;
    const info = this.metaData;
    // get last sample offset
    let maxOffset = 0;
    info.tracks.forEach((track) => {
      const trak = this.mp4box.moov.traks.find((trak) => {
        return trak.tkhd.track_id === track.id;
      });
      const samples = trak.samples;
      if (samples.length > 0) {
        const lastSample = samples[samples.length - 1];
        if (lastSample.offset + lastSample.size > maxOffset) {
          maxOffset = lastSample.offset + lastSample.size;
        }
      }
    });
    this.fileLength = maxOffset;
    this.initializeFragments();
  }

  onMetadataParsed(info) {
    this.metaData = info;
    this.estimateTotalSizeFromMetadats();
    const max = Math.ceil(this.fileLength / FRAGMENT_SIZE);
    // for (let l = 0; l < info.videoTracks.length; l++) {
    const l = this.getCurrentVideoLevelID();
    for (let i = 0; i < max; i++) {
      if (!this.client.getFragment(l, i)) {
        this.client.makeFragment(l, i, new MP4Fragment(l, i, this.source, i * FRAGMENT_SIZE, Math.min((i + 1) * FRAGMENT_SIZE, this.fileLength)));
      }
    }
    if (info.videoTracks[this.currentVideoTrack]) {
      const trak = this.mp4box.moov.traks.find((trak) => {
        return trak.tkhd.track_id === info.videoTracks[this.currentVideoTrack].id;
      });
      const samples = trak.samples;
      this.videoTracks.push({
        trak,
        track: info.videoTracks[this.currentVideoTrack],
        samples: samples,
        sortedSamples: this.sortSamples(samples),
        sortedCount: samples.length,
      });
    }
    //  }

    for (let l = 0; l < info.audioTracks.length; l++) {
      const trak = this.mp4box.moov.traks.find((trak) => {
        return trak.tkhd.track_id === info.audioTracks[l].id;
      });
      const samples = trak.samples;
      this.audioTracks.push({
        trak,
        track: info.audioTracks[l],
        samples: samples,
        sortedSamples: this.sortSamples(samples),
        sortedCount: samples.length,
      });
    }

    this.setFragmentTimes();
    this.emit(DefaultPlayerEvents.MANIFEST_PARSED);
    this.updateDuration();
    this.setupHLS();
    this.load();
  }

  getVideo() {
    return this.video;
  }

  async setSource(source) {
    if (this.source) {
      throw new Error('Source already set');
    }

    this.source = source;
    this.needsInit = true;

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

    try {
      // Nothing to do while nothing is buffered: a seek to the time it is already at went
      // through the setter, found nothing buffered there, and reset the player - on every
      // tick until the first media arrived, 482 times opening a long fragmented file at 30 s.
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

      this.runLoad();
      this.checkEndOfStream();
      this.stallWatchdog.check(this.video);
    } catch (e) {
      // runLoad stops the player with an error of its own (running is then false). Anything
      // else thrown here stopped the loop just the same, the loading, the end of the stream
      // and the stall watchdog with it, and nothing was said.
      console.error(e);
      if (this.running) {
        this.running = false;
        this.emit(DefaultPlayerEvents.ERROR, 'Playback stopped: ' + (e?.message || e));
      }
      return;
    }
    this.loopTimeout = setTimeout(this.mainLoop.bind(this), 1);
  }

  /**
   * Tells the MediaSource there is no more media once every track's last sample has been
   * appended. Without it Firefox waits for data after the last frame: playback that
   * reaches the end sits there buffering and never fires 'ended', and a seek to exactly
   * the end never completes. A later append or removal - a seek back, say - opens the
   * MediaSource again by itself, and this runs again when the end is reached again.
   */
  checkEndOfStream() {
    if (!this.metaData || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }

    const wrappers = [this.videoSourceBuffer, this.audioSourceBuffer].filter(Boolean);
    const busy = (wrapper) => wrapper.updating || wrapper.sourceBuffer.updating || wrapper.toDo.length > 0;
    if (wrappers.length === 0 || wrappers.some(busy)) {
      return;
    }

    const tracks = this.mp4box.fragmentedTracks;
    if (tracks.length === 0 || tracks.some((track) => track.trak.nextSample < track.trak.samples.length)) {
      return;
    }

    // A fragmented file's sample list grows with each moof parsed, so "every sample
    // appended" also holds between two fragments, whenever a range ends there: ending the
    // stream then cuts the duration to what is buffered, and the video stops early. Its
    // samples are all known only once the range with the file's last byte is in.
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
   * Whether the range holding the file's last byte has reached mp4box since the last
   * reset: resetHLS() empties currentFragments and seeks. False while the file's length is
   * not known.
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
        this.client.makeFragment(levelID, i, new MP4Fragment(levelID, i, this.source, i * FRAGMENT_SIZE, Math.min((i + 1) * FRAGMENT_SIZE, this.fileLength)));
      }
    }
  }

  /**
   * A fragmented file's samples become known one moof at a time, as its ranges are parsed;
   * mp4box adds them to the track's sample list. The keyframe index that picks the range to
   * load, and the fragments' times, were made only from the samples known when the metadata
   * was parsed, so the player loaded the first maxFragmentsBuffered ranges (30 MB) and
   * stopped there. Both are made again whenever the list has grown.
   */
  refreshSampleIndex() {
    if (!this.metaData?.isFragmented) return;
    const tracks = [...this.videoTracks, ...this.audioTracks];
    if (tracks.every((track) => track.sortedCount === track.samples.length)) return;
    tracks.forEach((track) => {
      track.sortedSamples = this.sortSamples(track.samples);
      track.sortedCount = track.samples.length;
    });
    this.setFragmentTimes();
  }

  setFragmentTimes() {
    // The ranges are kept under the video level's id, an audio-only file's too, and its
    // times come from its audio track. They were never set: nothing behind playback was
    // freed, and the whole file went into the SourceBuffer.
    const tracks = this.videoTracks.length ? this.videoTracks : this.audioTracks;
    const levels = this.videoTracks.length ? this.getVideoLevels() :
      new Map(this.audioTracks.length ? [[this.getCurrentVideoLevelID(), null]] : []);
    levels.forEach((level, l) => {
      const frags = this.client.getFragments(l.toString());
      let currentFragment = frags[0];
      currentFragment.start = 0;
      const indexes = this.getIndexes(l);
      for (let i = 1; i < frags.length; i++) {
        const frag = frags[i];
        const dt = this.getMinTimeFromOffset(tracks[indexes.levelID].samples, frag.rangeStart, frag.rangeEnd);
        if (dt !== null) {
          const time = Math.floor(dt);
          currentFragment.end = time;
          currentFragment.duration = time - currentFragment.start;
          frag.start = time;
          currentFragment = frag;
        }
      }

      // The duration as the player counts it: a fragmented file without a mehd box has none
      // in its metadata (0), and this last fragment then ended at 0.
      currentFragment.end = Math.ceil(this.calculateDuration());
      currentFragment.duration = currentFragment.end - currentFragment.start;
    });
  }

  removeFromBuffers(start, end) {
    start = Math.max(0, start);
    end = Math.min(this.mediaSource.duration, Math.max(end, start));

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
   * Removes what is buffered before `end`. runLoad() runs every millisecond, and this used
   * to remove [0, end) from both SourceBuffers on every run once playback was past the back
   * buffer: about 470 removals a second, nearly all of them of nothing. Each one still put
   * the SourceBuffer through an update, queued behind the appends playback needs (on a slow
   * machine the queue grew into the tens of thousands and the video stalled), and reopened
   * the MediaSource after endOfStream(). So a SourceBuffer is trimmed only while it is idle,
   * and only once it holds a second more than the back buffer keeps.
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
    if (this.metaData && !this.loaded) return;

    if (this.isPreview && this.readyState >= 2) {
      return;
    }

    if (this.loader) {
      return;
    }

    const currentFragment = this.currentFragment;

    // Both exits below stopped the player without an error, unlike the others: a spinner
    // forever, and no next stream tried (a file shorter than its moov says, a page that is
    // no MP4 answered with 200).
    if (!currentFragment) {
      this.running = false;
      this.emit(DefaultPlayerEvents.ERROR, 'No current fragment');
      throw new Error('No current fragment');
    }

    const frags = this.client.getFragments(this.getCurrentVideoLevelID()) || [];

    const time = this.video.currentTime;
    for (let i = 0; i < this.currentFragments.length; i++) {
      const frag = this.currentFragments[i];
      if (frag.sn >= currentFragment.sn) continue;

      if (frag.end < time - this.options.backBufferLength) {
        this.currentFragments.splice(i, 1);
        frag.removeReference(ReferenceTypes.MP4PLAYER);
        i--;
      }
    }

    this.removeBackBuffer(Math.min(time - this.options.backBufferLength - 1, currentFragment.start));

    const len = frags.length;
    for (let i = currentFragment.sn; i < Math.min(currentFragment.sn + this.options.maxFragmentsBuffered, len); i++) {
      const frag = this.client.getFragment(this.getCurrentVideoLevelID(), i);
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

      // A fragmented file says where a time is only once the ranges before it are parsed,
      // so it is read ahead by ranges (maxFragmentsBuffered), not by seconds: that is how
      // its duration, and a seek far into it, come to be known.
      if (i !== currentFragment.sn && !this.metaData?.isFragmented &&
          frag.start > this.video.currentTime + this.options.maxBufferLength) {
        break;
      }


      if (!this.currentFragments.includes(frag)) {
        const loader = this.loader = this.fragmentRequester.requestFragment(frag, {
          onSuccess: (entry, data) => {
            if (this.loader === loader) {
              this.loader = null;
            } else return;

            // The file's length has to be known before mp4box parses the data: parsing the
            // moov runs onMetadataParsed, which otherwise works the length out from the
            // samples known so far. For a fragmented file those are only the fragments in
            // this range, so the ranges after it were never made, and the file was
            // taken to end there.
            if (!this.fileLength) {
              const {length, playDirectly} = lengthFromAnswer({
                status: entry.responseStatus,
                headers: entry.responseHeaders,
                received: data?.byteLength || 0,
              }, {start: frag.rangeStart, end: frag.rangeEnd});
              if (playDirectly) {
                this.playDirectly('The server sends the whole file for a range request');
                return;
              }
              if (length > 0) {
                this.fileLength = length;
                this.initializeFragments();
              }
            }
            // More than the range (a 206 without Content-Range that sent the rest of the file,
            // say): the rest would be parsed as this range's, and the offsets would no longer
            // match. Only the range is this fragment's.
            if (data?.byteLength > frag.rangeEnd - frag.rangeStart) {
              const range = data.slice(0, frag.rangeEnd - frag.rangeStart);
              range.fileStart = data.fileStart;
              data = range;
            }
            // Past the end: a range read on that came back empty (a file whose length is a
            // multiple of the range size), or one at or past the length this answer just told
            // (a file of exactly one range from a server that ignores Range, whose answer
            // FetchLoader took for this range: the file's start again).
            if (frag.rangeStart > 0 &&
                (this.fileLength ? frag.rangeStart >= this.fileLength : !(data?.byteLength > 0))) {
              this.endsAt(this.fileLength || frag.rangeStart);
              return;
            }

            const hadMetaData = !!this.metaData;
            this.mp4box.appendBuffer(data);
            this.refreshSampleIndex();
            this.currentFragments.push(frag);
            this.rangeRetries.delete(frag);
            frag.addReference(ReferenceTypes.MP4PLAYER, true);

            // The moov came after the media (ffmpeg's default without +faststart, OBS's
            // recordings): the ranges read to reach it were parsed without it, and gave no
            // samples, yet counted as loaded. A long such file sat at its start with nothing
            // buffered, for good. They are read again, as for a seek, now the moov is known.
            if (!hadMetaData && this.metaData && frag.sn > 0) {
              this.resetHLS(true);
            }

            if (!this.fileLength) {
              // No length from the server (a 206 without Content-Range): a regular file's comes
              // from its sample table once the moov is in (estimateTotalSizeFromMetadats); until
              // then, and for a fragmented file, it is read on range by range. A range shorter
              // than asked for is the file's end. (A fragmented file failed with "No content
              // range", or ended after the first range.)
              const received = data?.byteLength || 0;
              const levelID = this.getCurrentVideoLevelID();
              if (received > 0 && received < frag.rangeEnd - frag.rangeStart) {
                this.endsAt(frag.rangeStart + received);
                return;
              } else {
                const nextParsePosition = this.metaData ? frag.rangeEnd : (this.mp4box.nextParsePosition || (frag.rangeEnd + 1));
                const maxIndex = Math.max(frag.sn + 1, Math.floor(nextParsePosition / FRAGMENT_SIZE));
                for (let fragIndex = 1; fragIndex <= maxIndex; fragIndex++) {
                  if (!this.client.getFragment(levelID, fragIndex)) {
                    this.client.makeFragment(levelID, fragIndex, new MP4Fragment(levelID, fragIndex, this.source, fragIndex * FRAGMENT_SIZE, (fragIndex + 1) * FRAGMENT_SIZE));
                  }
                }
              }
            }
            this.runLoad();
          },
          onProgress: (stats, context, data, xhr) => {

          },
          onFail: (entry) => {
            if (this.loader === loader) {
              this.loader = null;
            }
            // Read on range by range (no length from the server), the range after the file's
            // end: 416, Range Not Satisfiable. The file ends there.
            if (!this.fileLength && frag.rangeStart > 0 && entry?.stats?.error?.code === 416) {
              this.endsAt(frag.rangeStart);
            }
          },
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
   * A range that failed to load is asked for again after a growing wait, since the network
   * may come back. Once the waits are spent it is the player's error, as soon as playback
   * has reached it. Loading used to stop at it for good: the video played up to it, then
   * spun with no error, unless several downloaders happened to run.
   * @param {MP4Fragment} frag - The failed range.
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
      this.emit(DefaultPlayerEvents.ERROR, 'Range ' + frag.sn + ' failed to load');
      throw new Error('Range ' + frag.sn + ' failed to load');
    }
    return false;
  }

  downloadFragment(fragment, priority) {
    return new Promise((resolve, reject) => {
      this.fragmentRequester.requestFragment(fragment, {
        skipProcess: true,
        onSuccess: (entry, data) => {
          resolve();
        },
        onProgress: (stats, context, data, xhr) => {

        },
        onFail: (entry) => {
          reject(new Error('Failed to download fragment'));
        },
        onAbort: (e) => {
          reject(new Error('Aborted download'));
        },
      }, null, priority);
    });
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
    // SourceBuffer.abort() throws unless the MediaSource is open, and after endOfStream()
    // it is 'ended': the throw left the player half destroyed, without DESTROYED ever being
    // emitted.
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

    this.mp4box = null;
    this.metaData = null;

    this.videoTracks = null;
    this.audioTracks = null;

    clearTimeout(this.loopTimeout);

    VideoUtils.destroyVideo(this.video);
    this.video = null;

    this.emit(DefaultPlayerEvents.DESTROYED);
  }

  /**
   * The file ends at a range read on (no length from the server) that brought nothing: its
   * length is known now, and the stream can end.
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
   * Hands the source to Firefox's own player (DirectVideoPlayer), for a server this player
   * cannot load in ranges (RangeAnswers.mjs). Once: this player stops loading.
   * @param {string} reason
   */
  playDirectly(reason) {
    if (this.handedOver) return;
    this.handedOver = true;
    this.running = false;
    console.warn('Playing directly: ' + reason);
    this.emit(DefaultPlayerEvents.PLAY_DIRECTLY, reason);
  }

  resetHLS(noLoad) {
    if (!this.metaData) return;
    this.segmentAppender.reloaded();
    // console.log("resetHLS");
    this.removeFromBuffers(0, this.video.duration);
    this.mp4box.flush();
    this.mp4box.stream.buffers.length = 0;

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
    // A seek (or any reset) tries a failed range afresh: one whose three retries a network
    // blip used up failed on sight for good, even after seeking away and back.
    this.rangeRetries.clear();
    this.mp4box.seek(this.currentTime, true);
    if (!noLoad) this.runLoad();
  }

  set currentTime(value) {
    this.video.currentTime = value;

    // What matters is where the element is going: a seek to -3 s lands on 0, which may well
    // be buffered, and throwing the whole buffer away for it made every arrow press near the
    // start rebuffer the video. The target is clamped here to the range the element clamps a
    // seek to (MediaSource makes it [0, duration]), so the check does not depend on reading
    // the time back.
    let target = Math.max(0, value);
    const duration = this.video.duration;
    if (Number.isFinite(duration)) {
      target = Math.min(target, duration);
    }
    // A removal still queued takes away what `buffered` shows (removalPending, #265).
    if (!VideoUtils.isBuffered(this.buffered, target) ||
        removalPending([this.videoSourceBuffer, this.audioSourceBuffer], target)) {
      this.resetHLS();
    }
  }

  get currentTime() {
    return this.video.currentTime;
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
    result.set(id, new VideoLevel({
      id: id,
      width: track.track_width,
      height: track.track_height,
      bitrate: track.bitrate,
      mimeType: 'video/mp4',
      language: track.language,
      videoCodec: track.codec,
    }));
    return result;
  }

  getAudioLevels() {
    if (!this.metaData || !this.metaData.audioTracks[0]) return new Map();
    const track = this.metaData.audioTracks[0];
    const result = new Map();
    const id = this.getCurrentAudioLevelID();
    result.set(id, new AudioLevel({
      id: id,
      bitrate: track.bitrate,
      mimeType: 'audio/mp4',
      language: track.language,
      audioCodec: track.codec,
    }));
    return result;
  }

  getCurrentVideoLevelID() {
    return this.getIdentifier(VIDEO_TRACK, this.currentVideoTrack);
  }

  getCurrentAudioLevelID() {
    return this.getIdentifier(AUDIO_TRACK, this.currentAudioTrack);
  }

  setCurrentVideoLevelID(levelID) { // not implemented yet
  }

  setCurrentAudioLevelID(levelID) { // not implemented yet
  }


  get duration() {
    return this._duration;
  }

  calculateDuration() {
    if (!this.metaData) return 0;
    const info = this.metaData;
    // A fragmented file's length is in its mehd box, if it has one. info.fragment_duration
    // was that box's value in mp4box 0.5; since 2.x it is a {num, den} fraction (a number
    // divided by it is NaN, which the MediaSource refuses), and without a mehd box it is
    // what had been parsed when the metadata was read, which does not grow.
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
    // The MediaSource takes a duration only while it is open; after endOfStream() it is
    // 'ended' until the next append opens it again, and the setter would throw.
    if (newDuration !== this._duration && this.mediaSource.readyState === 'open') {
      this._duration = newDuration;
      this.mediaSource.duration = newDuration;
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
      if (this.videoTracks[this.currentVideoTrack]) {
        sortedSamples.push(this.videoTracks[parseInt(this.currentVideoTrack)].sortedSamples);
      }

      if (this.currentAudioTrack !== null && this.audioTracks[this.currentAudioTrack]) {
        sortedSamples.push(this.audioTracks[this.currentAudioTrack].sortedSamples);
      }
      // No keyframe in any track yet (a fragmented file none of whose moofs the ranges read
      // so far held): read on from where mp4box stopped.
      startOffset = keyframeOffset(sortedSamples, time) ?? (this.mp4box.nextParsePosition || 0);
    }


    const index = Math.floor(startOffset / FRAGMENT_SIZE);

    return this.client.getFragment(this.getCurrentVideoLevelID(), index);
  }

  getMinTimeFromOffset(samples, offset, end) {
    let index = Utils.binarySearch(samples, offset, (offset, sample) => {
      return offset - sample.offset;
    });

    if (index < 0) {
      index = Math.max(-1 - index, 0);
    }

    let minTime = Infinity;
    for (let i = index; i < samples.length; i++) {
      if (samples[i].offset > end) {
        break;
      }
      minTime = Math.min(minTime, samples[i].cts);
    }


    if (minTime !== Infinity) {
      return minTime / samples[0].timescale;
    } else {
      return null;
    }
  }

  canSave() {
    const frags = this.client.getFragments(this.getCurrentVideoLevelID());
    // Read on range by range, the file's end not known yet: what is there is no whole file.
    if (frags && !this.fileLength) {
      return {
        canSave: true,
        isComplete: false,
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

  async saveVideo(options) {
    const filestream = options.filestream;
    const writer = filestream.getWriter();
    const frags = this.client.getFragments(this.getCurrentVideoLevelID());
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

    // Held until written, partial save or not: a partial one took none, and a range playback
    // had passed could be let go of meanwhile, written as zeros.
    for (let i = 0; i < lastFrag; i++) {
      frags[i].addReference(ReferenceTypes.SAVER);
    }

    let cancelled = false;
    // Downloads the ranges a few ahead of the one being written: see SaveFragmentFetcher.
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
        if (!options.partialSave) {
          await fetcher.get(i);
        }
        if (frag.status === DownloadStatus.DOWNLOAD_COMPLETE) {
          const entry = this.client.downloadManager.getEntry(frag.getContext());
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
        const frag = frags[i];
        frag.removeReference(ReferenceTypes.SAVER);
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


  getIdentifier(trackID, levelID) {
    return `${trackID}:${levelID}`;
  }

  getIndexes(identifier) {
    const parts = identifier.split(':');
    return {
      trackID: parseInt(parts[0]),
      levelID: parseInt(parts[1]),
    };
  }
}
