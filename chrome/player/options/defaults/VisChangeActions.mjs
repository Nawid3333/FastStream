// @ts-check
import {EnvUtils} from '../../utils/EnvUtils.mjs';

/** @type {{NOTHING: string, PLAY_PAUSE: string, MINI_PLAYER?: string}} */
export const VisChangeActions = {
  NOTHING: 'nothing',
  PLAY_PAUSE: 'playpause',
  MINI_PLAYER: 'miniplayer',
  // PIP: 'pip',
};

if (!EnvUtils.isExtension()) {
  delete VisChangeActions.MINI_PLAYER;
}
