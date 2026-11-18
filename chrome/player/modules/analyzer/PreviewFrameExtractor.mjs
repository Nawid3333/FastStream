// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {EventEmitter} from '../eventemitter.mjs';
import {AnalyzerStatus, coversVideo, destroyPlayer, failOnError, startBackgroundPlayer} from './BackgroundAnalysis.mjs';

/** @typedef {import('./BackgroundAnalysis.mjs').DoneRange} DoneRange */

export class PreviewFrameExtractor extends EventEmitter {
  /** @param {import('../../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    super();
    this.client = client;
    this.outputRateInv = 2;
    // The frames taken, one per outputRateInv seconds: an object URL of the PNG.
    /** @type {Array<{url: string, blob: Blob}>} */
    this.frameBuffer = [];
    // Frames being encoded (toBlob), not in frameBuffer yet.
    /** @type {Set<number>} */
    this.framesPending = new Set();

    // Whoever needs the frames, kept by identity.
    /** @type {Array<object>} */
    this.backgroundNeededBy = [];

    this.backgroundAnalyzerStatus = AnalyzerStatus.IDLE;
    /** @type {DoneRange[]} */
    this.backgroundDoneRanges = [];
    this.backgroundAnalyzerEnabled = true;
    // Counts the starts: only the latest one may keep its player (startBackgroundPlayer).
    this.backgroundStarts = 0;
    // The source the background player plays, and that player while its analysis runs.
    /** @type {*} */
    this.backgroundAnalyzerSource = null;
    /** @type {?import('../../FastStreamClient.mjs').Player} */
    this.backgroundAnalyzerPlayer = null;

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
      this.frameBuffer.forEach((frame) => {
        URL.revokeObjectURL(frame.url);
      });
      this.frameBuffer = [];
      this.framesPending = new Set();
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

    await startBackgroundPlayer(this, '[FrameExtractor]', newSource);
  }

  stopBackgroundAnalyzer() {
    this.backgroundAnalyzerSource = null;
    if (this.backgroundAnalyzerPlayer) {
      const player = this.backgroundAnalyzerPlayer;
      this.backgroundAnalyzerPlayer = null;
      destroyPlayer(player);
    }
    // A failed analysis too: the start needs IDLE, so reopening the tool never tried that
    // video again. A finished one stays finished.
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
    });

    try {
      await player.setup();

      player.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
        player.setCurrentVideoLevelID(this.client.getCurrentVideoLevelID());
        player.setCurrentAudioLevelID(this.client.getCurrentAudioLevelID());
      });

      let running = false;
      const onLoadMeta = () => {
        player.off(DefaultPlayerEvents.LOADEDMETADATA, onLoadMeta);
        running = true;
        this.runAnalyzerInBackground(player, doneRanges, (/** @type {boolean} */ completed)=>{
          onDone(completed);
        });
      };

      player.on(DefaultPlayerEvents.LOADEDMETADATA, onLoadMeta);
      failOnError(player, '[FrameExtractor]', () => running, onDone);

      await player.setSource(source);
    } catch (e) {
      // Not left half built, downloading on its own.
      try {
        destroyPlayer(player);
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
      destroyPlayer(player);
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
      destroyPlayer(player);
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

      // A seek still pending shows the frame before it: taken now, it was kept as the new
      // place's, and the next seek was asked for before this one ended (Codex, 2026-11-07).
      if (player.readyState < 2 || video.seeking) {
        return;
      }

      const now = Date.now();
      if (now - lastOffsetCalc > 1000) {
        lastOffsetCalc = now;
        offset = this.client.isRegionBuffered(clientTimeOriginal + offsetTarget, clientTimeOriginal) ? offsetTarget : 0;
      }

      const clientTime = Math.max(clientTimeOriginal + offset, 0);

      const frame = Math.floor(time / this.outputRateInv);

      if (!this.frameBuffer[frame] && !this.framesPending.has(frame)) {
        this.extractorContext.drawImage(video, 0, 0, this.extractorCanvas.width, this.extractorCanvas.height);
        this.storeFrame(frame);
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


      if (coversVideo(/** @type {DoneRange} */ (currentRange), player.duration)) {
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

  /**
   * Keeps the canvas's picture as this frame. toBlob copies the picture at once and encodes
   * the PNG off the main thread; toDataURL encoded it here, into a base64 string that was
   * decoded again for the Blob.
   * @param {number} frame
   */
  storeFrame(frame) {
    const buffer = this.frameBuffer;
    const pending = this.framesPending;
    pending.add(frame);
    this.extractorCanvas.toBlob((blob) => {
      pending.delete(frame);
      // Dropped meanwhile (reset): not put into the new video's frames.
      if (!blob || buffer !== this.frameBuffer || buffer[frame]) return;
      buffer[frame] = {blob, url: URL.createObjectURL(blob)};
    }, 'image/png');
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
