// @ts-check
import {DefaultPlayerEvents} from '../enums/DefaultPlayerEvents.mjs';
import {EventEmitter} from '../modules/eventemitter.mjs';
import {Utils} from '../utils/Utils.mjs';

/**
 * @typedef {import('../FastStreamClient.mjs').Player & {audioSource?: MediaElementAudioSourceNode|null}} AudioPlayer
 */

export class SyncedAudioPlayer extends EventEmitter {
  /** @param {import('../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    super();
    this.client = client;
    /** @type {Array<AudioPlayer>} */
    this.audioPlayers = [];
    this.currentAudioPlayer = 0;
    this.videoDelay = 0;
    this.volume = 1;
    this.playbackRate = 1;
    this.consecutiveResyncs = 0;
    this.audioDelayNode = null;
    this.resyncDecreaseCount = 0;
    this.madePlayers = false;
    // Set by destroy(): a build or a resync still on its way stops at its next step.
    this.destroyed = false;
    // Counts dropPlayers(): a build still on its way when its players were dropped stops.
    this.playersDropped = 0;
  }

  /**
   * Without Web Audio the client has none of these, and the sound players play as they are.
   * @param {AudioContext|null|undefined} audioContext
   * @param {MediaElementAudioSourceNode|null|undefined} audioSource
   * @param {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode|null|undefined} audioOutputNode
   */
  async setup(audioContext, audioSource, audioOutputNode) {
    /** @type {AudioContext|null|undefined} */
    this.audioContext = audioContext;
    /** @type {MediaElementAudioSourceNode|null|undefined} */
    this.audioSource = audioSource;
    /** @type {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode|null|undefined} */
    this.outputNode = audioOutputNode;
  }

  /** @param {number} delay - Milliseconds the video is behind its sound. */
  async setVideoDelay(delay) {
    if (this.videoDelay === delay || !this.client.player) {
      return;
    }

    this.videoDelay = delay;

    if (this.shouldUseSeparateAudioPlayers()) {
      if (!this.madePlayers) {
        // Set before the build, so a second call meanwhile does not start another.
        this.madePlayers = true;
        try {
          await this.makePlayers(this.client.player.getSource());
        } catch (e) {
          // What was built goes, and the next change of the delay builds again.
          console.error('Could not build the audio players for the video delay', e);
          this.audioPlayers.forEach((player) => this.discardPlayer(player));
          this.audioPlayers = [];
          this.madePlayers = false;
          return;
        }
      }
      this.resync();
    } else {
      this.client.player.volume = this.volume;
      this.audioPlayers.forEach((player) => {
        player.volume = 0;
        player.pause();
      });
    }

    const delaySeconds = -this.videoDelay / 1000;
    // A delay node holds up to the most it was made for, and the options field takes any number.
    if (this.audioDelayNode && !(this.audioContext && delaySeconds > 0 && delaySeconds <= /** @type {number} */ (this.audioDelayMax))) {
      /** @type {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} */ (this.outputNode).disconnectFrom(this.audioDelayNode);
      /** @type {MediaElementAudioSourceNode} */ (this.audioSource).disconnect(this.audioDelayNode);
      /** @type {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} */ (this.outputNode).connectFrom(/** @type {MediaElementAudioSourceNode} */ (this.audioSource));
      this.audioDelayNode = null;
    }
    if (this.audioContext && delaySeconds > 0) {
      if (!this.audioDelayNode) {
        // Up to the 180 s Web Audio allows.
        this.audioDelayMax = Math.min(Math.max(1, delaySeconds), 179);
        this.audioDelayNode = this.audioContext.createDelay(this.audioDelayMax);
        /** @type {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} */ (this.outputNode).disconnectFrom(/** @type {MediaElementAudioSourceNode} */ (this.audioSource));
        /** @type {MediaElementAudioSourceNode} */ (this.audioSource).connect(this.audioDelayNode);
        /** @type {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} */ (this.outputNode).connectFrom(this.audioDelayNode);
      }

      this.audioDelayNode.delayTime.value = Math.min(delaySeconds, /** @type {number} */ (this.audioDelayMax));
    }
    this.consecutiveResyncs = 0;
  }

  shouldUseSeparateAudioPlayers() {
    return this.videoDelay !== 0 && (this.videoDelay > 0 || !this.audioContext);
  }

  /** @param {import('../VideoSource.mjs').VideoSource} source */
  async makePlayers(source) {
    this.source = source;
    const dropped = this.playersDropped;
    const gone = () => this.destroyed || this.playersDropped !== dropped;

    for (let i = 0; i < 2; i++) {
      /** @type {AudioPlayer} */
      const player = await this.client.playerLoader.createPlayer(source.mode, this.client, {
        isAudioOnly: true,
      });
      if (gone()) {
        player.destroy();
        return;
      }

      // Not yet in audioPlayers: a failure here leaves it out of the caller's cleanup.
      try {
        await player.setup();
        if (gone()) {
          player.destroy();
          return;
        }
        this.client.interfaceController.addVideo(player.getVideo());

        if (this.audioContext) {
          const audioSource = this.audioContext.createMediaElementSource(player.getVideo());
          player.audioSource = audioSource;
          /** @type {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} */ (this.outputNode).connectFrom(audioSource);
        }

        player.volume = 0;
        player.playbackRate = this.playbackRate;

        player.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
          player.setCurrentVideoLevelID(this.client.getCurrentVideoLevelID());
          player.setCurrentAudioLevelID(this.client.getCurrentAudioLevelID());
        });

        // Its error is not the video's: the video keeps its own sound, without the delay.
        player.on(DefaultPlayerEvents.ERROR, (/** @type {unknown} */ msg) => {
          console.warn('A separate audio player failed; the video plays with its own sound', msg);
          this.dropPlayers();
        });
        // Handed to Firefox's own player (a server that ignores Range): it stops, as on an error.
        player.on(DefaultPlayerEvents.PLAY_DIRECTLY, (/** @type {unknown} */ reason) => {
          console.warn('A separate audio player stopped; the video plays with its own sound', reason);
          this.dropPlayers();
        });

        await player.setSource(source);
      } catch (e) {
        this.discardPlayer(player);
        throw e;
      }
      if (gone()) {
        this.discardPlayer(player);
        return;
      }

      this.audioPlayers.push(player);
    }
  }

  /** The video plays with its own sound; the next change of the delay builds them again. */
  dropPlayers() {
    this.playersDropped++;
    this.audioPlayers.forEach((player) => this.discardPlayer(player));
    this.audioPlayers = [];
    this.madePlayers = false;
    if (this.client.player) {
      this.client.player.volume = this.volume;
    }
  }

  /**
   * Destroys a player and takes its sound out of the output.
   * @param {AudioPlayer} player
   */
  discardPlayer(player) {
    if (player.audioSource) {
      /** @type {import('../ui/audio/VirtualAudioNode.mjs').VirtualAudioNode} */ (this.outputNode).disconnectFrom(player.audioSource);
      player.audioSource = null;
    }
    player.destroy();
  }

  getOutputNode() {
    return this.outputNode;
  }

  async play() {
    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }
    this.audioPlayers[this.currentAudioPlayer].play().catch((/** @type {unknown} */ e) => console.warn('The separate audio did not play', e));
    this.resync();
    this.consecutiveResyncs = 0;
  }

  async pause() {
    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }
    this.audioPlayers[this.currentAudioPlayer].pause();
    this.consecutiveResyncs = 0;
  }

  /** @param {number} time - Seconds. */
  setCurrentTime(time) {
    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }
    this.audioPlayers.forEach((player) => {
      player.currentTime = time + this.videoDelay / 1000;
    });
    this.consecutiveResyncs = 0;
  }

  /**
   * @param {AudioPlayer} playerToSync
   * @param {import('../FastStreamClient.mjs').Player} targetPlayer
   * @param {number} [offset] - Seconds the one to sync is ahead.
   */
  async syncTime(playerToSync, targetPlayer, offset = 0) {
    const syncVideo = playerToSync.getVideo();
    const targetVideo = targetPlayer.getVideo();

    let res;
    if (Math.abs((targetVideo.currentTime + offset) - syncVideo.currentTime) > 3 || targetVideo.paused) {
      syncVideo.currentTime = targetVideo.currentTime + offset;
      if (!targetVideo.paused) {
        res = await Utils.timeoutableEvent(playerToSync, DefaultPlayerEvents.PLAYING, 1000);
        if (!res) {
          return false;
        }
      }
    } else {
      syncVideo.currentTime = targetVideo.currentTime + offset;
      res = await Utils.timeoutableEvent(playerToSync, DefaultPlayerEvents.PLAYING, 1000);
      if (!res) {
        return false;
      }

      await Utils.asyncTimeout(500);

      const error = (targetVideo.currentTime + offset) - syncVideo.currentTime;
      syncVideo.currentTime = (targetVideo.currentTime + offset) + error;
      res = await Utils.timeoutableEvent(playerToSync, DefaultPlayerEvents.PLAYING, 1000);
      if (!res) {
        return false;
      }

      await Utils.asyncTimeout(500);
    }

    return true;
  }

  async watcherLoop() {
    if (this.audioPlayers.length < 2 || !this.shouldUseSeparateAudioPlayers()) {
      return;
    }

    if (this.resyncDecreaseCount > 0) {
      this.resyncDecreaseCount--;
    } else {
      this.resyncDecreaseCount = 60;
      if (this.consecutiveResyncs > 0) {
        this.consecutiveResyncs--;
      }
    }

    const currentPlayer = this.audioPlayers[this.currentAudioPlayer];

    const offset = this.videoDelay / 1000;
    const error = Math.abs(/** @type {HTMLVideoElement} */ (this.client.currentVideo).currentTime + offset - currentPlayer.getVideo().currentTime);
    if (error > 0.01 && /** @type {HTMLVideoElement} */ (this.client.currentVideo).readyState >= 2) {
      if (!this.resyncing) {
        // The largest error first.
        let resyncMax = 1;
        if (error > 0.2) {
          resyncMax = 10;
        } else if (error > 0.1) {
          resyncMax = 6;
        } else if (error > 0.05) {
          resyncMax = 3;
        }

        if (this.consecutiveResyncs < resyncMax) {
          this.consecutiveResyncs++;
          this.resync();
          if (this.consecutiveResyncs === resyncMax) {
            console.log('Will not resync anymore');
          }
        }
      }
    } else {
      this.consecutiveResyncs = 0;
    }
  }

  async resync() {
    if (this.resyncing) {
      return;
    }

    this.resyncing = true;
    try {
      await this.silentResyncInternal();
    } catch (e) {
      console.error('Audio resync failed', e);
    } finally {
      this.resyncing = false;
    }
  }

  async silentResyncInternal() {
    // Both players: it swaps between them.
    if (this.audioPlayers.length < 2 || this.destroyed) {
      return false;
    }

    const nextIndex = (this.currentAudioPlayer + 1) % 2;
    const current = this.audioPlayers[this.currentAudioPlayer];
    const next = this.audioPlayers[nextIndex];

    const offset = this.videoDelay / 1000;
    const error = (/** @type {HTMLVideoElement} */ (this.client.currentVideo).currentTime + offset) - current.getVideo().currentTime;
    console.log('Resyncing audio, current error is', error);

    next.volume = 0;

    if (this.client.state.playing && /** @type {HTMLVideoElement} */ (this.client.currentVideo).readyState >= 2) {
      try {
        await next.play();
      } catch (e) {
        console.log('Failed to play audio');
        return false;
      }
    } else {
      await next.pause();
    }

    const res = await this.syncTime(next, this.client.player, this.videoDelay / 1000);
    if (!res) {
      console.error('Failed to sync audio');
      // Played muted for the swap: left playing, it would decode for nothing.
      await next.pause();
      return false;
    }

    // Destroyed or dropped meanwhile: the swap below would mute the wrong sound.
    if (this.destroyed || !this.shouldUseSeparateAudioPlayers() || this.audioPlayers[nextIndex] !== next) {
      return false;
    }

    // Paused meanwhile: the next player, played muted for the swap, must not take over playing.
    if (!this.client.state.playing) {
      await next.pause();
    }

    const newError = (/** @type {HTMLVideoElement} */ (this.client.currentVideo).currentTime + offset) - next.getVideo().currentTime;
    if (Math.abs(newError) > Math.abs(error)) {
      console.error('Failed to resync audio. New error is bigger than old error', newError, error);
      await next.pause();
      return false;
    }

    next.volume = this.volume;
    current.volume = 0;
    this.currentAudioPlayer = nextIndex;
    this.client.player.volume = 0;
    await current.pause();

    console.log('Resync complete! New error is', newError);

    return true;
  }

  /**
   * @param {number} value - 0 to 1.
   * @return {boolean|undefined} True when the sound player took it; nothing when there is none.
   */
  setVolume(value) {
    this.volume = value;

    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }

    this.audioPlayers[this.currentAudioPlayer].volume = value;
    return true;
  }

  /** @param {number} value */
  setPlaybackRate(value) {
    this.playbackRate = value;

    // Also while a delay of 0 keeps them paused: a delay set again reuses them.
    this.audioPlayers.forEach((player) => {
      player.playbackRate = value;
    });
  }

  /**
   * @param {string|number|null} videoLevel
   * @param {string|number|null} audioLevel - Null for none.
   */
  setLevel(videoLevel, audioLevel) {
    let changed = false;
    this.audioPlayers.forEach((player) => {
      const videoChanged = player.getCurrentVideoLevelID() !== videoLevel;
      const audioChanged = player.getCurrentAudioLevelID() !== audioLevel;

      if (audioChanged || (videoChanged && audioLevel === null)) {
        changed = true;
      }

      player.setCurrentVideoLevelID(videoLevel);
      player.setCurrentAudioLevelID(audioLevel);
    });

    if (changed) {
      this.consecutiveResyncs = 0;
      this.emit('audioLevelChanged', audioLevel);
    }
  }

  destroy() {
    this.destroyed = true;
    this.audioPlayers.forEach((player) => player.destroy());
    this.audioPlayers = [];
    // None without Web Audio, or before setup().
    this.audioContext?.close();
  }
}
