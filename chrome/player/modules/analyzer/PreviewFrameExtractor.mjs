// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {EventEmitter} from '../eventemitter.mjs';

/**
 * A stretch of the video whose frames are extracted, in seconds.
 * @typedef {{start: number, end: number}} DoneRange
 */

const AnalyzerStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  FINISHED: 'finished',
  FAILED: 'failed',
};

const SHOULD_STORE_AS_BLOB = true;

export class PreviewFrameExtractor extends EventEmitter {
  /** @param {import('../../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    super();
    this.client = client;
    this.outputRateInv = 2;
    // The frames taken, one per outputRateInv seconds: a data URL, or an object URL of its Blob.
    /** @type {Array<{url: string, blob?: Blob}>} */
    this.frameBuffer = [];

    // Whoever needs the frames, kept by identity.
    /** @type {Array<object>} */
    this.backgroundNeededBy = [];

    this.backgroundAnalyzerStatus = AnalyzerStatus.IDLE;
    /** @type {DoneRange[]} */
    this.backgroundDoneRanges = [];
    this.backgroundAnalyzerEnabled = true;
    // Counts the starts: only the latest one may keep its player (AudioAnalyzer's).
    this.backgroundStarts = 0;

    this.extractorCanvas = document.createElement('canvas');
    this.extractorContext = /** @type {CanvasRenderingContext2D} */ (this.extractorCanvas.getContext('2d'));
  }

  getFrameBuffer() {
    return this.frameBuffer;
  }

  getOutputRateInv() {
    return this.outputRateInv;
  }

  /** @param {object} dependent */
  addBackgroundDependent(dependent) {
    if (this.backgroundNeededBy.includes(dependent)) return;
    this.backgroundNeededBy.push(dependent);

    this.updateBackground();
  }

  /** @param {object} dependent */
  removeBackgroundDependent(dependent) {
    const index = this.backgroundNeededBy.indexOf(dependent);
    if (index !== -1) {
      this.backgroundNeededBy.splice(index, 1);
    }

    this.updateBackground();
  }

  updateBackground() {
    if (this.shouldRunAnalyzerInBackground()) {
      this.startBackgroundAnalyzer();
    } else {
      this.stopBackgroundAnalyzer();
    }
  }

  reset() {
    try {
      if (SHOULD_STORE_AS_BLOB) {
        this.frameBuffer.forEach((frame) => {
          URL.revokeObjectURL(frame.url);
        });
      }
      this.frameBuffer = [];
      this.backgroundAnalyzerSource = null;
      this.backgroundDoneRanges = [];
      this.stopBackgroundAnalyzer();
      this.backgroundAnalyzerStatus = AnalyzerStatus.IDLE;
    } catch (e) {
      console.error(e);
    }
  }


  async startBackgroundAnalyzer() {
    if (!this.client.player || this.backgroundAnalyzerStatus !== AnalyzerStatus.IDLE) {
      return;
    }

    const video = this.client.player?.getVideo();
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    const newSource = this.client.player.getSource();
    if (this.backgroundAnalyzerSource === newSource) {
      return;
    }

    this.backgroundAnalyzerSource = newSource;

    if (this.backgroundAnalyzerPlayer) {
      this.backgroundAnalyzerPlayer.destroy();
      this.backgroundAnalyzerPlayer = null;
    }

    console.log('[FrameExtractor] Starting background analyzer');

    // A stop and a new start while this one loads (the tool closed and opened again) make
    // this start stale: both passed the source check below, and the first player went on
    // seeking, downloading and drawing frames with the tool closed (review of 2026-10-14).
    const start = ++this.backgroundStarts;
    /** @type {import('../../FastStreamClient.mjs').Player|undefined} */
    let backgroundAnalyzerPlayer;
    // Set by an end that came before the load returned the player (its video had no size).
    /** @type {boolean|null} */
    let endedWhileLoading = null;
    try {
      backgroundAnalyzerPlayer = await this.loadPlayer(this.backgroundAnalyzerSource, this.backgroundDoneRanges, (/** @type {boolean} */ completed) => {
        // Before the load returned, the check below compared two unset values and passed,
        // and the return then kept the dead player as the running one, which blocked every
        // later start (glm's second look, 2026-10-13).
        if (backgroundAnalyzerPlayer === undefined) {
          endedWhileLoading = completed;
          return;
        }
        // Only the running player's end counts, as in AudioAnalyzer: a stale player,
        // destroyed below, cleared the running one's place, and nothing could stop that
        // one any more.
        if (backgroundAnalyzerPlayer !== this.backgroundAnalyzerPlayer) {
          return;
        }
        console.log('[FrameExtractor] Background analyzer finished', completed ? 'successfully' : 'with errors');
        this.backgroundAnalyzerStatus = completed ? AnalyzerStatus.FINISHED : AnalyzerStatus.FAILED;
        this.client.interfaceController.updateMarkers();
        this.backgroundAnalyzerPlayer = null;
      });
    } catch (e) {
      // Thrown on, it was an unhandled rejection. The source is forgotten, as AudioAnalyzer
      // does, so the next start (the timeline tool opened again) tries again: marked as
      // failed, one dropped request left the timeline without frames for the whole video
      // (glm's second look, 2026-10-13).
      console.warn('[FrameExtractor] The background analyzer could not load', e);
      if (start === this.backgroundStarts && newSource === this.backgroundAnalyzerSource) {
        this.backgroundAnalyzerSource = null;
      }
      return;
    }

    if (start !== this.backgroundStarts || newSource !== this.backgroundAnalyzerSource) {
      backgroundAnalyzerPlayer.destroy();
      return;
    }

    if (endedWhileLoading !== null) {
      this.backgroundAnalyzerStatus = endedWhileLoading ? AnalyzerStatus.FINISHED : AnalyzerStatus.FAILED;
      this.client.interfaceController.updateMarkers();
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
   * @param {DoneRange[]} doneRanges - What of it has its frames already.
   * @param {(completed: boolean) => void} onDone
   */
  async loadPlayer(source, doneRanges, onDone) {
    const player = await this.client.playerLoader.createPlayer(source.mode, this.client, {
      isAnalyzer: true,
    });

    try {
      await player.setup();

      player.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
        player.setCurrentVideoLevelID(this.client.getCurrentVideoLevelID());
        player.setCurrentAudioLevelID(this.client.getCurrentAudioLevelID());
      });

      const onLoadMeta = () => {
        player.off(DefaultPlayerEvents.LOADEDMETADATA, onLoadMeta);
        this.runAnalyzerInBackground(player, doneRanges, (/** @type {boolean} */ completed)=>{
          onDone(completed);
        });
      };

      player.on(DefaultPlayerEvents.LOADEDMETADATA, onLoadMeta);

      await player.setSource(source);
    } catch (e) {
      // Not left half built, downloading on its own.
      try {
        player.destroy();
      } catch (destroyError) {
        console.error(destroyError);
      }
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
    player.volume = 0;

    const video = player.getVideo();
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const aspect = videoWidth / videoHeight;
    const height = 64;
    const width = Math.round(height * aspect);
    this.extractorCanvas.width = width;
    this.extractorCanvas.height = height;

    let destroyed = false;
    let completed = false;
    const context = player.createContext();
    context.on(DefaultPlayerEvents.DESTROYED, () => {
      context.destroy();
      destroyed = true;
      onDone(completed);
    });

    if (videoWidth === 0 || videoHeight === 0) {
      console.error('[FrameExtractor] Invalid video dimensions');
      player.destroy();
      return;
    }

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

    let paused = false;
    const pauseHandler = () => {
      if (!destroyed && !paused ) {
        paused = true;
        console.log('[FrameExtractor] Paused analyzer');
      }
    };

    const onAnimFrame = () => {
      if (destroyed) {
        return;
      }

      const time = player.currentTime;
      const clientTimeOriginal = this.client.currentTime;

      if (paused) {
        if (player.readyState >= 1 && Math.abs(time - clientTimeOriginal) <= 40) {
          paused = false;
          console.log('[FrameExtractor] Resumed analyzer');
        }
      } else {
        if (Math.abs(time - clientTimeOriginal) > 60) {
          paused = true;
          console.log('[FrameExtractor] Outside of bounds, pausing');
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

      const frame = Math.floor(time / this.outputRateInv);

      if (!this.frameBuffer[frame]) {
        this.extractorContext.drawImage(video, 0, 0, this.extractorCanvas.width, this.extractorCanvas.height);
        const url = this.extractorCanvas.toDataURL('image/png');
        if (SHOULD_STORE_AS_BLOB) {
          // convert to blob
          const blob = new Blob([/** @type {any} */ (Uint8Array).fromBase64(url.slice(url.indexOf(',') + 1))], {type: 'image/png'});
          this.frameBuffer[frame] = {
            blob,
            url: URL.createObjectURL(blob),
          };
        } else {
          this.frameBuffer[frame] = {
            url,
          };
        }
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

      let timeSet = false;
      if (/** @type {DoneRange} */ (currentRange).end > time + 10) {
        player.currentTime = Math.floor((/** @type {DoneRange} */ (currentRange).end - 5) / this.outputRateInv) * this.outputRateInv;
        timeSet = true;
        console.log('[FrameExtractor] Already analyzed range, seeking', player.currentTime, /** @type {DoneRange} */ (currentRange).end);
      } else if (/** @type {DoneRange} */ (currentRange).end < time) {
        /** @type {DoneRange} */ (currentRange).end = time;
      }

      if (clientTime < /** @type {DoneRange} */ (currentRange).start - 5 || clientTime > /** @type {DoneRange} */ (currentRange).end + 5) {
        if (!currentClientRange || Math.min(clientTime + 90, player.duration) > currentClientRange.end + 5 || clientTime + 5 < currentClientRange.start) {
          console.log('[FrameExtractor] Client time is outside of analyzed region, seeking', clientTime, /** @type {DoneRange} */ (currentRange).start, /** @type {DoneRange} */ (currentRange).end);
          offset = this.client.isRegionBuffered(clientTimeOriginal + offsetTarget, clientTimeOriginal) ? offsetTarget : 0;
          player.currentTime = Math.floor(Math.max(clientTimeOriginal + offset, 0) / this.outputRateInv) * this.outputRateInv;
          timeSet = true;
          currentRange = null;
        }
      } else {
        currentClientRange = currentRange;
      }

      if (!timeSet && !paused) {
        player.currentTime = (1 + Math.floor(time / this.outputRateInv)) * this.outputRateInv;
      }

      this.client.interfaceController.updateMarkers();
    };

    requestAnimationFrame(onAnimFrame);

    return doneRanges;
  }

  shouldRunAnalyzerInBackground() {
    if (!this.backgroundAnalyzerEnabled) {
      return false;
    }
    return this.backgroundNeededBy.length > 0;
  }

  enableBackground() {
    this.backgroundAnalyzerEnabled = true;

    this.updateBackground();
  }

  disableBackground() {
    this.backgroundAnalyzerEnabled = false;
    this.updateBackground();
  }

  /**
   * @param {string|number|null} level - The client's level now.
   * @param {string|number|null} audioLevel - Its audio track now; null for none.
   */
  setLevel(level, audioLevel) {
    if (this.backgroundAnalyzerPlayer) {
      this.backgroundAnalyzerPlayer.setCurrentVideoLevelID(level);
      this.backgroundAnalyzerPlayer.setCurrentAudioLevelID(audioLevel);
    }
  }

  getMarkerPosition() {
    if (this.backgroundAnalyzerPlayer && this.backgroundAnalyzerStatus === AnalyzerStatus.RUNNING) {
      return this.backgroundAnalyzerPlayer.currentTime;
    }
    return null;
  }
}
