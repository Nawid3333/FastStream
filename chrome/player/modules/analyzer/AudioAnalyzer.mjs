// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {EventEmitter} from '../eventemitter.mjs';
import {AudioAnalyzerNode} from './AudioAnalyzerNode.mjs';

/**
 * A stretch of the video the background analysis has covered, in seconds.
 * @typedef {{start: number, end: number}} DoneRange
 */

const AnalyzerStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  FINISHED: 'finished',
  FAILED: 'failed',
};

export class AudioAnalyzer extends EventEmitter {
  /** @param {import('../../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    super();
    this.client = client;
    this.outputRate = 10;
    // The volume measured, by frame (outputRate a second).
    /** @type {Array<number>} */
    this.volumeBuffer = [];

    // Whoever needs the volume or the background analysis, kept by identity.
    /** @type {Array<object>} */
    this.volumeNeededBy = [];
    /** @type {Array<object>} */
    this.backgroundNeededBy = [];

    this.analyzerNodes = new Map();

    this.backgroundAnalyzerStatus = AnalyzerStatus.IDLE;
    /** @type {DoneRange[]} */
    this.backgroundDoneRanges = [];
    // The video and audio levels the background analysis is made of (setLevel).
    this.analyzedLevels = null;
    this.backgroundAnalyzerEnabled = true;
    // Counts startBackgroundAnalyzer's loads (see there).
    this.backgroundStarts = 0;
  }

  /**
   * @param {number} time - Seconds.
   * @param {number} volume
   */
  onVolumeFrameProcessed(time, volume) {
    const frame = Math.floor(time * this.outputRate);
    // The first ~20 ms of playback come stamped just before 0, and frame -1 became a
    // property of the array.
    if (frame < 0) {
      this.emit('volume', time, volume, 0);
      return;
    }
    this.volumeBuffer[frame] = volume;
    const interpMax = 8;
    let interp = 0;
    if (frame >= 2 && !this.volumeBuffer[frame - 1]) {
      // interpolate. Find last non-zero frame within 5 frames
      let lastFrame = frame - 2;
      const min = Math.max(0, frame - interpMax);
      while (lastFrame > min && !this.volumeBuffer[lastFrame]) {
        lastFrame--;
      }
      if (this.volumeBuffer[lastFrame]) {
        interp = frame - lastFrame - 1;
        const diff = frame - lastFrame;
        const step = (volume - this.volumeBuffer[lastFrame]) / diff;
        for (let i = lastFrame + 1; i < frame; i++) {
          this.volumeBuffer[i] = this.volumeBuffer[lastFrame] + step * (i - lastFrame);
        }
      }
    }
    this.emit('volume', time, volume, interp);
  }

  /** @param {object} dependent */
  addVolumeDependent(dependent) {
    if (this.volumeNeededBy.includes(dependent)) return;
    this.volumeNeededBy.push(dependent);

    this.sendConfigToAnalyzerNodes();
  }

  /** @param {object} dependent */
  removeVolumeDependent(dependent) {
    const index = this.volumeNeededBy.indexOf(dependent);
    if (index !== -1) {
      this.volumeNeededBy.splice(index, 1);
    }

    this.sendConfigToAnalyzerNodes();
  }

  /** @param {object} dependent */
  addBackgroundDependent(dependent) {
    if (this.backgroundNeededBy.includes(dependent)) return;
    this.backgroundNeededBy.push(dependent);
  }

  /** @param {object} dependent */
  removeBackgroundDependent(dependent) {
    const index = this.backgroundNeededBy.indexOf(dependent);
    if (index !== -1) {
      this.backgroundNeededBy.splice(index, 1);
    }

    if (!this.shouldRunAnalyzerInBackground()) {
      this.stopBackgroundAnalyzer();
    }
  }

  sendConfigToAnalyzerNodes() {
    const volume = this.volumeNeededBy.length > 0;

    this.analyzerNodes.forEach((node) => {
      node.configure({volume});
    });
  }

  reset() {
    try {
      this.volumeBuffer = [];
      this.backgroundDoneRanges = [];

      this.analyzerNodes.forEach((node) => {
        node.destroy();
      });
      this.analyzerNodes.clear();

      this.stopBackgroundAnalyzer();
      this.backgroundAnalyzerStatus = AnalyzerStatus.IDLE;
      this.analyzedLevels = null;
    } catch (e) {
      console.error(e);
    }
  }

  getVolumeData() {
    return this.volumeBuffer;
  }

  getOutputRate() {
    return this.outputRate;
  }

  /**
   * @param {HTMLVideoElement} videoElement - The main player's.
   * @param {import('../../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} audioOutputNode - Its sound.
   * @param {AudioContext} audioContext
   * @param {() => number} getTime - The time its sound is at.
   */
  setupAnalyzerNodeForMainPlayer(videoElement, audioOutputNode, audioContext, getTime) {
    if (this.analyzerNodes.has('main')) {
      this.analyzerNodes.get('main').destroy();
    }

    const mainAnalyzerNode = new AudioAnalyzerNode();
    this.analyzerNodes.set('main', mainAnalyzerNode);
    mainAnalyzerNode.attach(videoElement, audioOutputNode, audioContext, getTime);
    mainAnalyzerNode.on('volume', this.onVolumeFrameProcessed.bind(this));

    mainAnalyzerNode.configure({
      volume: this.volumeNeededBy.length > 0,
    });
  }

  async startBackgroundAnalyzer() {
    if (!this.client.player || this.backgroundAnalyzerStatus !== AnalyzerStatus.IDLE) {
      return;
    }

    const newSource = this.client.player.getSource();
    if (this.backgroundAnalyzerSource === newSource) {
      return;
    }

    this.backgroundAnalyzerSource = newSource;
    // The levels the analysis is made of (its player takes the client's), for a switch
    // after it finished (setLevel).
    this.analyzedLevels = {video: this.client.getCurrentVideoLevelID(), audio: this.client.getCurrentAudioLevelID()};

    if (this.backgroundAnalyzerPlayer) {
      this.backgroundAnalyzerPlayer.destroy();
      this.backgroundAnalyzerPlayer = null;
    }

    console.log('[AudioAnalyzer] Starting background analyzer');

    // A stop and a new start while this one loads (the tool closed and opened again, or a
    // new video) make this start stale: only the latest one may keep its player. Two
    // starts for the same source used to both keep theirs, and the first ran on for good.
    const start = ++this.backgroundStarts;
    /** @type {import('../../FastStreamClient.mjs').Player|undefined} */
    let backgroundAnalyzerPlayer;
    try {
      backgroundAnalyzerPlayer = await this.loadPlayer(this.backgroundAnalyzerSource, this.backgroundDoneRanges, (/** @type {boolean} */ completed) => {
        // Only the running player's end counts: a stale player, destroyed below, cleared
        // the running one's place, and nothing could stop that one any more.
        if (this.backgroundAnalyzerPlayer !== backgroundAnalyzerPlayer) {
          return;
        }
        console.log('[AudioAnalyzer] Background analyzer finished', completed ? 'successfully' : 'with errors');
        this.backgroundAnalyzerStatus = completed ? AnalyzerStatus.FINISHED : AnalyzerStatus.FAILED;
        this.client.interfaceController.updateMarkers();
        this.backgroundAnalyzerPlayer = null;
      });
    } catch (e) {
      console.warn('[AudioAnalyzer] The background analyzer did not start', e);
      // Forget the source, or the check above refuses every later start for it: the
      // next play tries again.
      if (start === this.backgroundStarts && this.backgroundAnalyzerSource === newSource) {
        this.backgroundAnalyzerSource = null;
      }
      return;
    }

    if (start !== this.backgroundStarts || newSource !== this.backgroundAnalyzerSource) {
      backgroundAnalyzerPlayer.destroy();
      return;
    }

    this.backgroundAnalyzerStatus = AnalyzerStatus.RUNNING;
    this.backgroundAnalyzerPlayer = backgroundAnalyzerPlayer;
  }

  stopBackgroundAnalyzer() {
    this.backgroundAnalyzerSource = null;
    if (this.backgroundAnalyzerPlayer) {
      const player = this.backgroundAnalyzerPlayer;
      this.backgroundAnalyzerPlayer = null;
      player.destroy();
    }
    // A failed analysis too: the start needs IDLE, so reopening the tool never tried that
    // video again (review of 2026-10-14). A finished one stays finished.
    if (this.backgroundAnalyzerStatus === AnalyzerStatus.RUNNING ||
        this.backgroundAnalyzerStatus === AnalyzerStatus.FAILED) {
      this.backgroundAnalyzerStatus = AnalyzerStatus.IDLE;
    }
    this.client.interfaceController.updateMarkers();
  }

  /**
   * @param {import('../../VideoSource.mjs').VideoSource} source
   * @param {DoneRange[]} doneRanges - What of it is analyzed already.
   * @param {(completed: boolean) => void} onDone
   * @return {Promise<import('../../FastStreamClient.mjs').Player>}
   */
  async loadPlayer(source, doneRanges, onDone) {
    const player = await this.client.playerLoader.createPlayer(source.mode, this.client, {
      isAnalyzer: true,
      isAudioOnly: true,
    });

    try {
      return await this.setupPlayer(player, source, doneRanges, onDone);
    } catch (e) {
      // A player that failed halfway would keep its downloads and audio context.
      player.destroy();
      throw e;
    }
  }

  /**
   * @param {import('../../FastStreamClient.mjs').Player} player - An audio-only analyzer player.
   * @param {import('../../VideoSource.mjs').VideoSource} source
   * @param {DoneRange[]} doneRanges
   * @param {(completed: boolean) => void} onDone
   * @return {Promise<import('../../FastStreamClient.mjs').Player>}
   */
  async setupPlayer(player, source, doneRanges, onDone) {
    await player.setup();

    const audioAnalyzerNode = new AudioAnalyzerNode();
    // sinkId (no output device) is newer than TypeScript's AudioContextOptions.
    const audioContext = new AudioContext(/** @type {AudioContextOptions & {sinkId: {type: 'none'}}} */ ({
      sinkId: {type: 'none'},
    }));
    const audioSource = audioContext.createMediaElementSource(player.getVideo());
    audioAnalyzerNode.attach(player.getVideo(), audioSource, audioContext);
    audioAnalyzerNode.on('volume', this.onVolumeFrameProcessed.bind(this));
    audioAnalyzerNode.configure({
      volume: true,
    });

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      audioAnalyzerNode.destroy();
      audioSource.disconnect();
      audioContext.close();
    };
    // Destroyed before its metadata came (a stop or a newer start while it loaded): only the
    // analysis below let these go, and it never ran - the audio context and the volume loop
    // ran on for the rest of the session.
    player.on(DefaultPlayerEvents.DESTROYED, release);

    player.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
      player.setCurrentVideoLevelID(this.client.getCurrentVideoLevelID());
      player.setCurrentAudioLevelID(this.client.getCurrentAudioLevelID());
    });

    const onLoadMeta = () => {
      player.off(DefaultPlayerEvents.LOADEDMETADATA, onLoadMeta);
      this.runAnalyzerInBackground(player, doneRanges, (/** @type {boolean} */ completed)=>{
        release();
        onDone(completed);
      });
    };

    player.on(DefaultPlayerEvents.LOADEDMETADATA, onLoadMeta);

    try {
      await player.setSource(source);
    } catch (e) {
      release();
      throw e;
    }
    return player;
  }

  /**
   * @param {import('../../FastStreamClient.mjs').Player} player
   * @param {DoneRange[]} doneRanges
   * @param {(completed: boolean) => void} onDone
   */
  runAnalyzerInBackground(player, doneRanges, onDone) {
    const offsetTarget = -35;
    const time = this.client.currentTime;
    let offset = this.client.isRegionBuffered(time + offsetTarget, time) ? offsetTarget : 0;
    player.currentTime = Math.max(time + offset, 0);
    player.playbackRate = 8; // Firefox mutes audio above 8x
    player.play();

    let destroyed = false;
    let completed = false;
    const context = player.createContext();
    context.on(DefaultPlayerEvents.DESTROYED, () => {
      context.destroy();
      destroyed = true;
      onDone(completed);
    });


    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let pauseTimeout;

    if (!doneRanges) {
      doneRanges = [];
    }

    /** @type {DoneRange|null} */
    let currentRange = null;
    let currentRangeIndex = 0;
    /** @type {DoneRange|null} */
    let currentClientRange = null;
    let lastOffsetCalc = Date.now();

    const onEnd = () => {
      completed = true;
      player.destroy();
    };

    context.on(DefaultPlayerEvents.ENDED, ()=>{
      player.currentTime = 0;
    });

    const pauseHandler = () => {
      if (!destroyed && player.readyState >= 1) {
        player.pause();
        console.log('[AudioAnalyzer] Paused analyzer');
      }
    };

    const onAnimFrame = () => {
      if (destroyed) {
        return;
      }
      const time = player.currentTime;
      const clientTimeOriginal = this.client.currentTime;

      if (player.paused) {
        if (player.readyState >= 1 && Math.abs(time - clientTimeOriginal) <= 40) {
          player.play();
          console.log('[AudioAnalyzer] Resumed analyzer');
        }
      } else {
        if (Math.abs(time - clientTimeOriginal) > 60) {
          player.pause();
          console.log('[AudioAnalyzer] Outside of bounds, pausing');
        }
      }

      clearTimeout(pauseTimeout);
      pauseTimeout = setTimeout(pauseHandler, 100);

      requestAnimationFrame(onAnimFrame);

      if (player.readyState < 2) {
        return;
      }

      const now = Date.now();
      if (now - lastOffsetCalc > 1000) {
        lastOffsetCalc = now;
        offset = this.client.isRegionBuffered(clientTimeOriginal + offsetTarget, clientTimeOriginal) ? offsetTarget : 0;
      }

      const clientTime = Math.max(clientTimeOriginal + offset, 0);

      if (doneRanges.length === 0) {
        currentRange = null;
        currentClientRange = null;
      }

      if (!currentRange || time < currentRange.start || time > currentRange.end + 16) {
        currentRangeIndex = -1;
        for (let i = 0; i < doneRanges.length; i++) {
          if (doneRanges[i].start <= time && doneRanges[i].end >= time) {
            currentRange = doneRanges[i];
            currentRangeIndex = i;
            break;
          }
        }

        if (currentRangeIndex === -1) {
          currentRange = {start: time, end: time};
          // insert in order
          currentRangeIndex = -1;
          for (let i = 0; i < doneRanges.length; i++) {
            if (doneRanges[i].start > time) {
              doneRanges.splice(i, 0, currentRange);
              currentRangeIndex = i;
              break;
            }
          }
          if (currentRangeIndex === -1) {
            doneRanges.push(currentRange);
            currentRangeIndex = doneRanges.length - 1;
          }
        }

        // check if ranges need to merge (if they are close enough)
        // (Set by now: found in doneRanges, or a new one made.)
        if (currentRangeIndex > 0 && /** @type {DoneRange} */ (currentRange).start - doneRanges[currentRangeIndex - 1].end < 0) {
          doneRanges[currentRangeIndex - 1].end = Math.max(doneRanges[currentRangeIndex - 1].end, /** @type {DoneRange} */ (currentRange).end);
          doneRanges.splice(currentRangeIndex, 1);
          currentRangeIndex--;
          currentRange = doneRanges[currentRangeIndex];
        }
      }

      if (currentRangeIndex < doneRanges.length - 1 && doneRanges[currentRangeIndex + 1].start - /** @type {DoneRange} */ (currentRange).end < 0) {
        /** @type {DoneRange} */ (currentRange).end = Math.max(/** @type {DoneRange} */ (currentRange).end, doneRanges[currentRangeIndex + 1].end);
        doneRanges.splice(currentRangeIndex + 1, 1);
      }


      if (/** @type {DoneRange} */ (currentRange).end - /** @type {DoneRange} */ (currentRange).start >= player.duration - 5) {
        onEnd();
        return;
      }

      if (/** @type {DoneRange} */ (currentRange).end > time + 10) {
        player.currentTime = /** @type {DoneRange} */ (currentRange).end - 5;
        console.log('[AudioAnalyzer] Already analyzed range, seeking', player.currentTime, /** @type {DoneRange} */ (currentRange).end);
      } else if (/** @type {DoneRange} */ (currentRange).end < time) {
        /** @type {DoneRange} */ (currentRange).end = time;
      }

      if (clientTime < /** @type {DoneRange} */ (currentRange).start - 5 || clientTime > /** @type {DoneRange} */ (currentRange).end + 5) {
        if (!currentClientRange || Math.min(clientTime + 90, player.duration) > currentClientRange.end + 5 || clientTime + 5 < currentClientRange.start) {
          console.log('[AudioAnalyzer] Client time is outside of analyzed region, seeking', clientTime, /** @type {DoneRange} */ (currentRange).start, /** @type {DoneRange} */ (currentRange).end);
          offset = this.client.isRegionBuffered(clientTimeOriginal + offsetTarget, clientTimeOriginal) ? offsetTarget : 0;
          player.currentTime = Math.max(clientTimeOriginal + offset, 0);
          currentRange = null;
        }
      } else {
        currentClientRange = currentRange;
      }

      this.client.interfaceController.updateMarkers();
    };

    requestAnimationFrame(onAnimFrame);

    return doneRanges;
  }

  getMarkerPosition() {
    if (this.backgroundAnalyzerPlayer && this.backgroundAnalyzerStatus === AnalyzerStatus.RUNNING) {
      return this.backgroundAnalyzerPlayer.currentTime;
    }
    return null;
  }

  shouldRunAnalyzerInBackground() {
    if (!this.backgroundAnalyzerEnabled) {
      return false;
    }
    return this.backgroundNeededBy.length > 0;
  }

  enableBackground() {
    this.backgroundAnalyzerEnabled = true;
  }

  disableBackground() {
    this.backgroundAnalyzerEnabled = false;
    this.stopBackgroundAnalyzer();
  }

  /**
   * @param {string|number|null} videoLevel - The client's level now.
   * @param {string|number|null} audioLevel - Its audio track now; null for none.
   */
  setLevel(videoLevel, audioLevel) {
    let changedVideo;
    let changedAudio;
    if (this.backgroundAnalyzerPlayer) {
      changedVideo = this.backgroundAnalyzerPlayer.getCurrentVideoLevelID() !== videoLevel;
      changedAudio = this.backgroundAnalyzerPlayer.getCurrentAudioLevelID() !== audioLevel;
      this.backgroundAnalyzerPlayer.setCurrentVideoLevelID(videoLevel);
      this.backgroundAnalyzerPlayer.setCurrentAudioLevelID(audioLevel);
    } else if (this.analyzedLevels) {
      // Finished (or failed): its player is gone, and the switch changed nothing. The
      // volumes were the old track's for the rest of the video, and nothing analysed the
      // new one (glm's look at a noted edge case, 2026-10-13).
      changedVideo = this.analyzedLevels.video !== videoLevel;
      changedAudio = this.analyzedLevels.audio !== audioLevel;
    } else {
      return;
    }
    this.analyzedLevels = {video: videoLevel, audio: audioLevel};
    if (audioLevel === null ? changedVideo : changedAudio) {
      this.backgroundDoneRanges.length = 0;
      this.volumeBuffer = [];
      if (this.backgroundAnalyzerStatus !== AnalyzerStatus.RUNNING) {
        this.reset();
      }
      this.emit('audioLevelChanged', audioLevel);
    }
  }

  /**
   * Must only run on trusted events to ensure the player runs.
   */
  updateBackgroundAnalyzer() {
    if (this.shouldRunAnalyzerInBackground()) {
      this.startBackgroundAnalyzer();
    } else {
      this.stopBackgroundAnalyzer();
    }
  }
}
