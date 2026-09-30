/* eslint-disable new-cap */
import {AudioUtils} from '../../utils/AudioUtils.mjs';
import {EventEmitter} from '../eventemitter.mjs';

export class AudioAnalyzerNode extends EventEmitter {
  constructor() {
    super();
    this.vadOptions = {
      onFrameProcessed: this.onVadFrameProcessed.bind(this),
      positiveSpeechThreshold: 1,
      negativeSpeechThreshold: 1,
    };

    this.loopHandle = this.volumeLoop.bind(this);
    this.volumeLoopRunning = false;
    this.volumeLoopShouldRun = false;
    this.vadShouldRun = false;
    this.vadNode = null;
    // Counts startRecordingVad's loads (see there).
    this.vadLoads = 0;
  }

  onVadFrameProcessed(probs) {
    const isSpeechProb = Math.round(probs.isSpeech * 255);
    const audioElement = this.audioElement;
    if (!audioElement || audioElement.readyState < 4 || audioElement.paused) return;
    const time = this.getCurrentTime() - audioElement.playbackRate * 0.02;
    this.emit('vad', time, isSpeechProb);
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

  async startRecordingVad() {
    if (this.vadShouldRun) return;
    this.vadShouldRun = true;

    if (this.vadNode) return;
    // A stop and a new start while this load runs (the syncer closed and reopened) start
    // a second load. The first to finish is used and the other destroyed: both used to
    // connect and run, and a stop removed only the second.
    const load = ++this.vadLoads;
    let vadNode;
    try {
      const {VadJS} = await import('../vad/vad.mjs');
      vadNode = await VadJS.AudioNodeVAD.new(this.audioContext, this.vadOptions);
    } catch (e) {
      console.error('The voice detector did not start', e);
      // The latest start failed: the next one may try again. (An older load's failure
      // leaves a newer one's decision alone.)
      if (load === this.vadLoads && !this.vadNode) {
        this.vadShouldRun = false;
      }
      return;
    }
    if (this.vadNode || !this.vadShouldRun) {
      vadNode.destroy();
      return;
    }
    this.vadNode = vadNode;
    this.audioSource.connect(vadNode.getNode());
    vadNode.start();
  }

  stopRecordingVad() {
    if (!this.vadShouldRun) return;
    this.vadShouldRun = false;

    if (this.vadNode) {
      try {
        this.audioSource.disconnect(this.vadNode.getNode());
      } catch (e) {

      }
      this.vadNode.destroy();
      this.vadNode = null;
    }
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
    this.stopRecordingVad();

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

  configure({vad, volume}) {
    if (volume) {
      this.startRecordingVolume();
    } else {
      this.stopRecordingVolume();
    }

    if (vad) {
      this.startRecordingVad();
    } else {
      this.stopRecordingVad();
    }
  }
}
