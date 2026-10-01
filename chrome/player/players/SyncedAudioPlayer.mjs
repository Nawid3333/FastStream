import {DefaultPlayerEvents} from '../enums/DefaultPlayerEvents.mjs';
import {EventEmitter} from '../modules/eventemitter.mjs';
import {Localize} from '../modules/Localize.mjs';
import {Utils} from '../utils/Utils.mjs';

export class SyncedAudioPlayer extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.audioPlayers = [];
    this.currentAudioPlayer = 0;
    this.videoDelay = 0;
    this.volume = 1;
    this.playbackRate = 1;
    this.consecutiveResyncs = 0;
    this.audioDelayNode = null;
    this.resyncDecreaseCount = 0;
    this.madePlayers = false;
    // Set by destroy(): a build or a resync still on its way stops at its next step. They
    // went on after the video changed, adding players that kept downloading, showing their
    // errors on the new video, and muting it.
    this.destroyed = false;
  }

  async setup(audioContext, audioSource, audioOutputNode) {
    this.audioContext = audioContext;
    this.audioSource = audioSource;
    this.outputNode = audioOutputNode;
  }

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
          // One failed build left the flag set and half the players: every later call
          // skipped the build, the delay stayed off for the session, and a resync threw.
          // What was built goes, and the next change of the delay builds again.
          console.error('Could not build the audio players for the video delay', e);
          this.audioPlayers.forEach((player) => player.destroy());
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
    // A delay node holds up to the most it was made for: one made for 1 s held a delay of
    // -1500 ms at -1000 (the options field takes any number; its slider stops at 1000).
    if (this.audioDelayNode && !(this.audioContext && delaySeconds > 0 && delaySeconds <= this.audioDelayMax)) {
      this.outputNode.disconnectFrom(this.audioDelayNode);
      this.audioSource.disconnect(this.audioDelayNode);
      this.outputNode.connectFrom(this.audioSource);
      this.audioDelayNode = null;
    }
    if (this.audioContext && delaySeconds > 0) {
      if (!this.audioDelayNode) {
        // Up to the 180 s Web Audio allows.
        this.audioDelayMax = Math.min(Math.max(1, delaySeconds), 179);
        this.audioDelayNode = this.audioContext.createDelay(this.audioDelayMax);
        this.outputNode.disconnectFrom(this.audioSource);
        this.audioSource.connect(this.audioDelayNode);
        this.outputNode.connectFrom(this.audioDelayNode);
      }

      this.audioDelayNode.delayTime.value = Math.min(delaySeconds, this.audioDelayMax);
    }
    this.consecutiveResyncs = 0;
  }

  shouldUseSeparateAudioPlayers() {
    return this.videoDelay !== 0 && (this.videoDelay > 0 || !this.audioContext);
  }

  async makePlayers(source) {
    this.source = source;

    for (let i = 0; i < 2; i++) {
      const player = await this.client.playerLoader.createPlayer(source.mode, this.client, {
        isAudioOnly: true,
      });
      if (this.destroyed) {
        player.destroy();
        return;
      }

      await player.setup();
      if (this.destroyed) {
        player.destroy();
        return;
      }
      this.client.interfaceController.addVideo(player.getVideo());

      if (this.audioContext) {
        const audioSource = this.audioContext.createMediaElementSource(player.getVideo());
        player.audioSource = audioSource;
        this.outputNode.connectFrom(audioSource);
      }

      player.volume = 0;
      player.playbackRate = this.playbackRate;

      player.on(DefaultPlayerEvents.MANIFEST_PARSED, () => {
        player.setCurrentVideoLevelID(this.client.getCurrentVideoLevelID());
        player.setCurrentAudioLevelID(this.client.getCurrentAudioLevelID());
      });

      player.on(DefaultPlayerEvents.ERROR, (msg) => {
        this.client.failedToLoad(msg || Localize.getMessage('player_error_load'));
      });

      await player.setSource(source);
      if (this.destroyed) {
        player.destroy();
        return;
      }

      this.audioPlayers.push(player);
    }
  }

  getOutputNode() {
    return this.outputNode;
  }

  async play() {
    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }
    this.audioPlayers[this.currentAudioPlayer].play();
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

  setCurrentTime(time) {
    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }
    this.audioPlayers.forEach((player) => {
      player.currentTime = time + this.videoDelay / 1000;
    });
    this.consecutiveResyncs = 0;
  }

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
      this.resyncDecreaseCount = 60; // 1 minute
      if (this.consecutiveResyncs > 0) {
        this.consecutiveResyncs--;
      }
    }

    const currentPlayer = this.audioPlayers[this.currentAudioPlayer];

    // Check error
    const offset = this.videoDelay / 1000;
    const error = Math.abs(this.client.currentVideo.currentTime + offset - currentPlayer.getVideo().currentTime);
    // console.log('Error is', error);
    if (error > 0.01 && this.client.currentVideo.readyState >= 2) {
      if (!this.resyncing) {
        // The largest error first: tested from the smallest, anything over 0.05 s took
        // the first branch, and a drift never got more than 3 tries.
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
      // One throw left this set, and the drift was never corrected again that session.
      this.resyncing = false;
    }
  }

  async silentResyncInternal() {
    // Both players: it swaps between them. With one (a build that failed half way), the
    // other was undefined, and this threw.
    if (this.audioPlayers.length < 2 || this.destroyed) {
      return false;
    }

    const nextIndex = (this.currentAudioPlayer + 1) % 2;
    const current = this.audioPlayers[this.currentAudioPlayer];
    const next = this.audioPlayers[nextIndex];

    // Get current error
    const offset = this.videoDelay / 1000;
    const error = (this.client.currentVideo.currentTime + offset) - current.getVideo().currentTime;
    console.log('Resyncing audio, current error is', error);

    next.volume = 0;

    if (this.client.state.playing && this.client.currentVideo.readyState >= 2) {
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
      return false;
    }

    // Destroyed meanwhile: the video changed, and the swap below muted the new one.
    if (this.destroyed || !this.shouldUseSeparateAudioPlayers()) {
      return false;
    }

    const newError = (this.client.currentVideo.currentTime + offset) - next.getVideo().currentTime;
    if (Math.abs(newError) > Math.abs(error)) {
      console.error('Failed to resync audio. New error is bigger than old error', newError, error);
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

  setVolume(value) {
    this.volume = value;

    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }

    this.audioPlayers[this.currentAudioPlayer].volume = value;
    return true;
  }

  setPlaybackRate(value) {
    this.playbackRate = value;

    if (!this.shouldUseSeparateAudioPlayers() || this.audioPlayers.length < 2) {
      return;
    }

    this.audioPlayers.forEach((player) => {
      player.playbackRate = value;
    });
  }

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
