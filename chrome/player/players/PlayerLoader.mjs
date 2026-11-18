// @ts-check
import {PlayerModes} from '../enums/PlayerModes.mjs';

export class PlayerLoader {
  /**
   * Literal specifiers, so static readers (addons-linter) see every file; lazy, as dash.js and hls.js are big.
   * @param {string} mode
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client
   * @param {{isPreview?: boolean, isAudioOnly?: boolean}} options
   * @return {Promise<import('../FastStreamClient.mjs').Player>}
   */
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
