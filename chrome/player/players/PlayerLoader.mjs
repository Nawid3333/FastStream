import {PlayerModes} from '../enums/PlayerModes.mjs';

export class PlayerLoader {
<<<<<<< HEAD
  /**
   * Loads the player module for a source mode and constructs it.
   *
   * Every specifier here is a literal, deliberately. The previous version kept
   * a registry of paths and did `import(this.players[mode])`, which loads the
   * same modules but leaves the set of reachable files invisible to any static
   * reader - a bundler, a reviewer, or addons-linter, which reported it as an
   * unsafe assignment.
   *
   * Writing the branches out fixes that without giving up lazy loading, which
   * matters: dash.js is 3.5 MB and hls.js 1.2 MB, so importing every player
   * eagerly would pull both into the first page load whatever the video turns
   * out to be.
   *
   * @param {number} mode a PlayerModes value
   * @param {object} client the FastStreamClient
   * @param {object} options passed through to the player
   * @return {Promise<object>} the constructed player
   */
=======
  constructor() {
    this.players = {};

    this.registerPlayer(PlayerModes.DIRECT, './DirectVideoPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_MP4, './mp4/MP4Player.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_HLS, './hls/HLSPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_DASH, './dash/DashPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_YT, './yt/YTPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_VM, './vm/VMPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_PANOPTO, './panopto/PanoptoPlayer.mjs');
  }

>>>>>>> upstream/main
  async createPlayer(mode, client, options) {
    let module;
    switch (mode) {
      case PlayerModes.DIRECT:
        module = await import('./DirectVideoPlayer.mjs');
        break;
      case PlayerModes.ACCELERATED_MP4:
        module = await import('./mp4/MP4Player.mjs');
        break;
      case PlayerModes.ACCELERATED_HLS:
        module = await import('./hls/HLSPlayer.mjs');
        break;
      case PlayerModes.ACCELERATED_DASH:
        module = await import('./dash/DashPlayer.mjs');
        break;
      case PlayerModes.ACCELERATED_VM:
        module = await import('./vm/VMPlayer.mjs');
        break;
      default:
        throw new Error(`Unknown player mode: ${mode}`);
    }
    const Player = module.default;
    return new Player(client, options);
  }
}
