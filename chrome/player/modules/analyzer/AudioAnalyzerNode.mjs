// @ts-check
/* eslint-disable new-cap */
import {AudioUtils} from '../../utils/AudioUtils.mjs';
import {EventEmitter} from '../eventemitter.mjs';

/** @typedef {MediaElementAudioSourceNode|import('../../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} SoundSource */

// How often the volume loop looks while the sound is paused, when there is nothing to measure
// (recordVolume); a play runs its next round at once (wakeLoop). It ran every 64 ms divided by
// the playback rate all the same: the background analysis plays at 8x and waits paused most
// of the time (AudioAnalyzer, when it is far enough ahead), and woke the page 125 times a
// second for the whole video; the main player 15 times a second while paused.
const PAUSED_LOOP_MS = 250;

export class AudioAnalyzerNode extends EventEmitter {
  constructor() {
    super();
    this.loopHandle = this.volumeLoop.bind(this);
    this.wakeHandle = this.wakeLoop.bind(this);
    this.volumeLoopRunning = false;
    this.volumeLoopShouldRun = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.volumeLoopTimeout = undefined;
  }

  recordVolume() {
    const audioElement = this.audioElement;
    if (!this.volumeAnalyserNode || !audioElement || audioElement.readyState < 4 || audioElement.paused) return;
    const volume = AudioUtils.getVolume(this.volumeAnalyserNode);
    const time = this.getCurrentTime() - audioElement.playbackRate * 0.02;
    this.emit('volume', time, volume);
  }

  startRecordingVolume() {
    if (this.volumeLoopShouldRun) return;
    this.volumeLoopShouldRun = true;
    const analyser = AudioUtils.createVolumeAnalyserNode(this.audioContext);
    this.volumeAnalyserNode = analyser;
    // Attached: only destroy() takes the source away, after it stopped this.
    /** @type {SoundSource} */ (this.audioSource).connect(analyser);

    if (this.volumeLoopRunning) return;
    this.volumeLoopRunning = true;
    this.volumeLoop();
  }

  stopRecordingVolume() {
    if (!this.volumeLoopShouldRun) return;
    this.volumeLoopShouldRun = false;
    // Its next round goes too: left to end the loop by itself, it kept the page's timer for
    // up to a quarter second after a destroy.
    clearTimeout(this.volumeLoopTimeout);
    this.volumeLoopRunning = false;
    try {
      // Both set: the loop was running, and destroy() comes here before it takes the source.
      /** @type {SoundSource} */ (this.audioSource).disconnect(/** @type {AnalyserNode} */ (this.volumeAnalyserNode));
    } catch (e) {

    }
    this.volumeAnalyserNode = null;
  }

  volumeLoop() {
    if (!this.volumeLoopShouldRun) {
      this.volumeLoopRunning = false;
      return;
    }

    const audioElement = this.audioElement;
    this.volumeLoopTimeout = setTimeout(this.loopHandle, audioElement.paused ? PAUSED_LOOP_MS : Math.floor(64 / audioElement.playbackRate));

    this.recordVolume();
  }

  /**
   * Measures at once when the sound starts playing, and from then on at the playing pace:
   * the background analysis at 8x would lose up to 2 s of its sound waiting for the paused
   * loop's next round. The round that was waiting is dropped, so one loop runs.
   */
  wakeLoop() {
    if (!this.volumeLoopRunning) return;
    clearTimeout(this.volumeLoopTimeout);
    this.volumeLoop();
  }

  destroy() {
    this.stopRecordingVolume();
    this.audioElement?.removeEventListener('play', this.wakeHandle);

    // Through a cast: TypeScript takes the assignment below, the first in the file, for the
    // field's declaration, and this read for a use before it.
    if (/** @type {AudioAnalyzerNode} */ (this).audioSource) {
      this.audioSource = null;
    }
  }

  /**
   * @param {HTMLVideoElement} audioElement - The video whose sound is measured.
   * @param {SoundSource} audioSource - Its sound: the element's own source, or the main
   *   player's output node.
   * @param {AudioContext} audioContext
   * @param {() => number} [getCurrentTime] - The time the sound is at; the element's by default.
   */
  attach(audioElement, audioSource, audioContext, getCurrentTime) {
    // Set before anything measures: configure() comes after attach().
    /** @type {HTMLVideoElement} */
    this.audioElement = audioElement;
    /** @type {AudioContext} */
    this.audioContext = audioContext;
    /** @type {?SoundSource} */
    this.audioSource = audioSource;
    /** @type {() => number} */
    this.getCurrentTime = getCurrentTime || (() => audioElement.currentTime);
    audioElement.addEventListener('play', this.wakeHandle);
  }

  /** @param {{volume: boolean}} options - Whether the volume is measured. */
  configure({volume}) {
    if (volume) {
      this.startRecordingVolume();
    } else {
      this.stopRecordingVolume();
    }
  }
}
