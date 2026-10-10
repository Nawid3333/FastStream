/* eslint-disable new-cap */
import {AudioUtils} from '../../utils/AudioUtils.mjs';
import {EventEmitter} from '../eventemitter.mjs';

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
    this.audioSource.connect(analyser);

    if (this.volumeLoopRunning) return;
    this.volumeLoopRunning = true;
    this.volumeLoop();
  }

  stopRecordingVolume() {
    if (!this.volumeLoopShouldRun) return;
    this.volumeLoopShouldRun = false;
    try {
      this.audioSource.disconnect(this.volumeAnalyserNode);
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

    if (this.audioSource) {
      this.audioSource = null;
    }
  }

  attach(audioElement, audioSource, audioContext, getCurrentTime) {
    this.audioElement = audioElement;
    this.audioContext = audioContext;
    this.audioSource = audioSource;
    this.getCurrentTime = getCurrentTime || (() => audioElement.currentTime);
  }

  configure({volume}) {
    if (volume) {
      this.startRecordingVolume();
    } else {
      this.stopRecordingVolume();
    }
  }
}
