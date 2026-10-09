import {AnalyzerEvents} from '../../enums/AnalyzerEvents.mjs';
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {PlayerModes} from '../../enums/PlayerModes.mjs';
import {EventEmitter} from '../eventemitter.mjs';
import {EnvUtils} from '../../utils/EnvUtils.mjs';
import {VideoAligner} from './VideoAligner.mjs';
import {ReferenceTypes} from '../../enums/ReferenceTypes.mjs';
import {MessageTypes} from '../../enums/MessageTypes.mjs';

const AnalyzerStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  FINISHED: 'finished',
  FAILED: 'failed',
};

export class VideoAnalyzer extends EventEmitter {
  constructor(client, options) {
    super();
    this.options = {
      introCutoff: 5 * 60,
      outroCutoff: 5 * 60,
      ...options,
    };
    this.client = client;

    this.introAligner = new VideoAligner();
    this.outroAligner = new VideoAligner();

    this.introAligner.on(AnalyzerEvents.MATCH, (aligner) => {
      this.emit(AnalyzerEvents.INTRO_MATCH, this);
      this.emit(AnalyzerEvents.MATCH, this);
    });

    this.outroAligner.on(AnalyzerEvents.MATCH, (aligner) => {
      this.emit(AnalyzerEvents.OUTRO_MATCH, this);
      this.emit(AnalyzerEvents.MATCH, this);
    });

    this.introPlayer = null;
    this.outroPlayer = null;

    this.introStatus = AnalyzerStatus.IDLE;
    this.outroStatus = AnalyzerStatus.IDLE;
    // Counts the finders' runs, which a source or quality change ends (destroyPlayers).
    this.runs = 0;

    this.lastAnalyzerSave = 0;

    this.enabled = true;
  }


  getOutro() {
    if (!this.enabled) return null;
    return this.outroAligner.getMatch();
  }

  getIntro() {
    if (!this.enabled) return null;
    return this.introAligner.getMatch();
  }

  reset() {
    this.destroyPlayers();
    this.introStatus = AnalyzerStatus.IDLE;
    this.outroStatus = AnalyzerStatus.IDLE;
  }

  saveAnalyzerData() {
    if (!this.introAligner.hasMemoryChanges && !this.outroAligner.hasMemoryChanges) {
      return;
    }

    const now = Date.now();
    if (now - this.lastAnalyzerSave <= 1000 * 10) {
      return;
    }
    this.lastAnalyzerSave = now;

    if (EnvUtils.isExtension()) {
      this.introAligner.unsetChangesFlag();
      this.outroAligner.unsetChangesFlag();
      Promise.all([this.introAligner.getMemoryForSave(), this.outroAligner.getMemoryForSave()]).then(([intro, outro]) => {
        return chrome.runtime.sendMessage({
          type: MessageTypes.STORE_ANALYZER_DATA,
          data: {intro, outro},
        });
      }).catch((e) => {
        // Saved with the next changes, or at the next try.
        this.introAligner.hasMemoryChanges = true;
        this.outroAligner.hasMemoryChanges = true;
        console.warn('[VideoAnalyzer] Could not save the analyzer data', e);
      });
    }
  }

  /**
   * Takes the data saveAnalyzerData stored for the tab.
   * @param {Object} data
   * @return {Promise<void>}
   */
  async loadAnalyzerData(data) {
    console.log('[VideoAnalyzer] Loading analyzer data');
    try {
      await Promise.all([
        data.intro && this.introAligner.loadMemoryFromSave(data.intro),
        data.outro && this.outroAligner.loadMemoryFromSave(data.outro),
      ]);
    } catch (e) {
      // What was saved does not read: the analyzer starts without it.
      console.warn('[VideoAnalyzer] Could not load the analyzer data', e);
    }
  }

  destroyPlayers() {
    // Every finder running or loading is the one before's now (runFinder), including one
    // whose player is not here yet; a running one starts again (IDLE), as its own end
    // reported nothing then.
    this.runs++;
    if (this.introPlayer) {
      this.introPlayer.destroy();
      this.introPlayer = null;
    }

    if (this.outroPlayer) {
      this.outroPlayer.destroy();
      this.outroPlayer = null;
    }
    if (this.introStatus === AnalyzerStatus.RUNNING) {
      this.introStatus = AnalyzerStatus.IDLE;
    }
    if (this.outroStatus === AnalyzerStatus.RUNNING) {
      this.outroStatus = AnalyzerStatus.IDLE;
    }
  }

  async update() {
    if (!this.shouldAnalyze()) return;
    const duration = this.client.duration;
    const introStart = 0;
    const introEnd = Math.min(introStart + this.options.introCutoff, duration);
    const outroStart = Math.max(duration - this.options.outroCutoff, introEnd);
    const outroEnd = duration;

    this.introAligner.setRange(introStart, introEnd);
    this.outroAligner.setRange(outroStart, outroEnd);

    // The ranges are this source's: after a source change while the intro finder loaded,
    // the outro's is not started from them.
    const run = this.runs;
    if (this.outroStatus !== AnalyzerStatus.RUNNING && this.introStatus === AnalyzerStatus.IDLE && introEnd - introStart > 30) {
      if (this.shouldLoadPlayer(introStart, introEnd)) {
        await this.runFinder(true, introStart, introEnd);
        if (run !== this.runs) return;
      }
    }

    if (this.introStatus !== AnalyzerStatus.RUNNING && this.outroStatus === AnalyzerStatus.IDLE && outroEnd - outroStart > 30) {
      if (this.shouldLoadPlayer(outroStart, outroEnd)) {
        await this.runFinder(false, outroStart, outroEnd);
      }
    }
  }

  /**
   * Runs the intro or the outro finder: a background player plays its range at 6x, and its
   * frames go to the aligner.
   * @param {boolean} intro - The intro's finder, or the outro's.
   * @param {number} start - Where its range starts, in seconds.
   * @param {number} end - Where its range ends.
   * @return {Promise<void>} Once its player plays, or it could not load.
   */
  async runFinder(intro, start, end) {
    const name = intro ? 'Intro' : 'Outro';
    const setStatus = (status) => {
      if (intro) this.introStatus = status;
      else this.outroStatus = status;
    };
    const setPlayer = (player) => {
      if (intro) this.introPlayer = player;
      else this.outroPlayer = player;
    };
    // A source or a quality change (destroyPlayers) while its player loads, or once it
    // plays: that player, and all it reports, are the one before's.
    const run = this.runs;
    console.log(`[VideoAnalyzer] Running ${name.toLowerCase()} finder in background`, start, end);
    setStatus(AnalyzerStatus.RUNNING);
    const reserved = this.referenceFragments(start, end);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.dereferenceFragments(reserved);
      }
    };
    let ended = false;
    let player;
    try {
      player = await this.loadPlayer(intro ? this.introAligner : this.outroAligner, start, end, (completed) => {
        ended = true;
        release();
        if (run !== this.runs) return;
        setStatus(completed ? AnalyzerStatus.FINISHED : AnalyzerStatus.FAILED);
        setPlayer(null);
        console.log(`[VideoAnalyzer] ${name} finder completed`, completed);
        this.client.interfaceController.updateMarkers();
      }, () => run === this.runs);
    } catch (e) {
      // Thrown on, it left the finder "running" (never run again) and the fragments it
      // had pinned unfreeable for the rest of the video.
      console.warn(`[VideoAnalyzer] ${name} finder could not load`, e);
      release();
      if (run === this.runs) {
        setStatus(AnalyzerStatus.FAILED);
        this.client.interfaceController.updateMarkers();
      }
      return;
    }
    if (run !== this.runs) {
      // Loaded for the source or quality before. Kept, it went on downloading that one's
      // range at 6x and put its frames into the next one's sequence, and a later finder
      // overwrote it here without destroying it (audit, 2026-10-09).
      if (!ended) player.destroy();
      release();
      return;
    }
    // Ended while it loaded (no picture): its onDone already said so.
    if (!ended) {
      setPlayer(player);
    }
  }

  isRunning() {
    return this.introStatus === AnalyzerStatus.RUNNING || this.outroStatus === AnalyzerStatus.RUNNING;
  }

  destroy() {
    this.destroyPlayers();
  }

  isModeSupported() {
    const mode = this.source.mode;
    const supportedModes = [
      PlayerModes.ACCELERATED_HLS,
      PlayerModes.ACCELERATED_MP4,
      PlayerModes.ACCELERATED_DASH,
    ];
    return supportedModes.includes(mode);
  }

  shouldLoadPlayer(timeStart, timeEnd) {
    if (this.isModeSupported()) {
      const fragments = this.client.fragments;
      if (!fragments || fragments.length === 0) return false;

      if (this.client.getCurrentVideoLevelID() === null) return false;

      const start = fragments.find((fragment) => {
        return fragment && fragment.start <= timeStart && fragment.end >= timeStart;
      });

      if (!start) return false;
      return start.status === DownloadStatus.DOWNLOAD_COMPLETE || !this.client.options.downloadAll;
    } else if (this.source.mode === PlayerModes.DIRECT) {
      return true;
    }
    return false;
  }

  dereferenceFragments(fragments) {
    for (let i = 0; i < fragments.length; i++) {
      fragments[i].removeReference(ReferenceTypes.ANALYZER);
    }
    fragments.length = 0;
  }


  referenceFragments(timeStart, timeEnd) {
    if (!this.isModeSupported()) {
      return [];
    }
    const fragments = this.client.fragments;
    if (!fragments || fragments.length === 0) return [];

    let start = fragments.find((fragment) => {
      return fragment && fragment.start <= timeStart && fragment.end >= timeStart;
    });

    if (!start) return [];

    start = fragments.indexOf(start);
    const reserved = [];
    for (let i = start; i < fragments.length; i++) {
      // A live stream's store has holes where it forgot what its window left (HLSFragmentStore).
      if (!fragments[i]) continue;
      fragments[i].addReference(ReferenceTypes.ANALYZER);
      reserved.push(fragments[i]);
      // The one that holds timeEnd too: the analyzer plays up to it, and it was the one left
      // out (the loop stopped before it), free to be dropped under the analyzer.
      if (fragments[i].end >= timeEnd) {
        break;
      }
    }
    return reserved;
  }

  async loadPlayer(aligner, timeStart, timeEnd, onDone, isCurrent = () => true) {
    // The source it was started for: a source change during the awaits below has its own.
    const source = this.source;
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
        // Its run ended while it loaded: it plays nothing, and runFinder destroys it.
        if (!isCurrent()) return;
        this.runAnalyzerInBackground(player, aligner, timeStart, timeEnd, onDone);
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

  shouldAnalyze() {
    if (!this.enabled) {
      return false;
    }

    if (!this.source) {
      return false;
    }

    const duration = this.client.duration;
    if (!duration) { // No duration
      return false;
    }

    if (duration < 5 * 60) { // Video is too short
      return false;
    }

    if (duration > 90 * 60) { // Video is likely a movie
      return false;
    }

    const video = this.client.player?.getVideo();
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return false;
    }

    return true;
  }

  getMarkerPosition() {
    if (this.introStatus === AnalyzerStatus.RUNNING && this.introPlayer) {
      return this.introPlayer.currentTime;
    } else if (this.outroStatus === AnalyzerStatus.RUNNING && this.outroPlayer) {
      return this.outroPlayer.currentTime;
    }
    return null;
  }

  runAnalyzerInBackground(player, aligner, timeStart, timeEnd, onDone) {
    player.currentTime = timeStart;
    player.playbackRate = 6;
    player.volume = 0;
    player.muted = true;
    player.play();


    let destroyed = false;
    let completed = false;
    const context = player.createContext();
    context.on(DefaultPlayerEvents.DESTROYED, () => {
      context.destroy();
      destroyed = true;
      onDone(completed);
    });

    const video = player.getVideo();
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      console.error('[VideoAnalyzer] Invalid video dimensions');
      player.destroy();
      return;
    }

    context.on(DefaultPlayerEvents.ENDED, () => {
      completed = true;
      player.destroy();
    });

    let pauseTimeout;
    let lastTime = -1;

    let lastCalculate = Date.now();

    const pauseHandler = () => {
      if (!destroyed && player.readyState >= 1) {
        player.pause();
        console.log('[VideoAnalyzer] Paused analyzer');
      }
    };

    const onAnimFrame = () => {
      if (destroyed) {
        aligner.calculate();
        return;
      }
      if (player.readyState >= 1 && player.paused) {
        player.play();
        player.currentTime = Math.max(player.currentTime - 1.5, timeStart);
        console.log('[VideoAnalyzer] Resumed analyzer');
      }
      requestAnimationFrame(onAnimFrame);

      clearTimeout(pauseTimeout);
      pauseTimeout = setTimeout(pauseHandler, 100);

      if (player.readyState < 2) {
        return;
      }

      const time = player.currentTime;

      if (time + 1 < timeStart) {
        console.log('[VideoAnalyzer] Seeking analyzer back to start');
        player.currentTime = timeStart;
        return;
      }

      if (time === lastTime) return;
      lastTime = time;

      if (time < timeStart) {
        player.currentTime = timeStart;
        return;
      }

      if (time >= timeEnd) {
        completed = true;
        player.destroy();
        return;
      }

      aligner.pushVideoFrame(player.getVideo());

      if (Date.now() - lastCalculate > 1000) {
        setTimeout(() => {
          aligner.calculate();
          lastCalculate = Date.now();
        }, 1);
        lastCalculate = Date.now();
      }

      this.client.interfaceController.updateMarkers();
    };

    requestAnimationFrame(onAnimFrame);
  }

  setLevel(level, audioLevel) {
    this.destroyPlayers();

    if (this.introStatus === AnalyzerStatus.FAILED) {
      this.introStatus = AnalyzerStatus.IDLE;
    }

    if (this.outroStatus === AnalyzerStatus.FAILED) {
      this.outroStatus = AnalyzerStatus.IDLE;
    }
  }

  pushFrame(video) {
    if (!this.shouldAnalyze()) return false;

    const time = video.currentTime;
    if (time < this.options.introCutoff) {
      return this.introAligner.pushVideoFrame(video);
    } else if (this.client.duration - this.options.outroCutoff < time) {
      return this.outroAligner.pushVideoFrame(video);
    }
    return false;
  }

  calculate() {
    this.introAligner.calculate();
    this.outroAligner.calculate();
  }

  async setSource(source) {
    this.reset();

    this.source = source;
    this.introAligner.prepare(source.identifier);
    this.outroAligner.prepare(source.identifier);
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    this.reset();
  }
}
