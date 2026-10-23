// @ts-check
/* eslint-disable new-cap */
import {AudioUtils} from '../../utils/AudioUtils.mjs';
import {EventEmitter} from '../eventemitter.mjs';

/** @typedef {MediaElementAudioSourceNode|import('../../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} SoundSource */

export class AudioAnalyzerNode extends EventEmitter {
  constructor() {
    super();
    this.loopHandle = this.volumeLoop.bind(this);
    this.volumeLoopRunning = false;
    this.volumeLoopShouldRun = false;
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

    this.volumeLoopTimeout = setTimeout(this.loopHandle, Math.floor(64 / this.audioElement.playbackRate));

    this.recordVolume();
  }

  destroy() {
    this.stopRecordingVolume();

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
