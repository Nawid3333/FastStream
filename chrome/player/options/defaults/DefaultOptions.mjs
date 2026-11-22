// @ts-check
import {AspectRatios} from './AspectRatios.mjs';
import {ClickActions} from './ClickActions.mjs';
import {ColorThemes} from './ColorThemes.mjs';
import {DefaultKeybinds} from './DefaultKeybinds.mjs';
import {DEFAULT_SEEK_STEP_SIZE, KEYBINDS_VERSION} from '../KeybindUtils.mjs';
import {MiniplayerPositions} from './MiniplayerPositions.mjs';
import {VisChangeActions} from './VisChangeActions.mjs';

export const DefaultOptions = {
  dev: false,
  replaceDelay: 500,
  playMP4URLs: false,
  playStreamURLs: false,
  mpvMode: false,
  mpvAllowlist: /** @type {string[]} */ ([]),
  mpvPath: '',
  mpvFullscreen: false,
  mpvPausePage: true,
  mpvSingleInstance: true,
  // Apart from the player's autoplayNext; also switched by mpv's autoplay button.
  mpvAutoplayNext: true,
  downloadAll: true,
  blockPopupsWhilePlaying: true,
  previewEnabled: true,
  // Among versions of the chosen resolution, prefer hardware-decoded, smooth, efficient ones.
  decodingAwareQuality: true,
  // Step down a version that drops a fifth of its frames.
  lowerOnDroppedFrames: true,
  autoEnableBestSubtitles: false,
  cycleSubtitles: false,
  storeProgress: true,
  autoplayNext: false,
  // Seconds before the next episode, in the player and in mpv; 0: none.
  autoplayCountdown: 5,
  defaultQuality: `Auto`,
  colorTheme: ColorThemes.DEFAULT,
  autoEnableURLs: /** @type {string[]} */ ([]),
  customSourcePatterns: ``,
  // Action to key string; saved ones may name actions DefaultKeybinds no longer has.
  keybinds: /** @type {Object<string, string>} */ (DefaultKeybinds),
  keybindsVersion: KEYBINDS_VERSION,
  // Utils.migrateSizes.
  sizesVersion: 1,
  // Utils.migrateClickActions.
  clickActionsVersion: 1,
  videoZoom: 1,
  videoAspectRatio: AspectRatios.AUTO,
  maxSpeed: -1,
  maxVideoSize: 5000000000,
  ramBudget: 2000000000, // all players together; beyond it: disk (private windows: let go)
  computerMemory: 0, // GB, as the user gave it (0: not given): sets ramBudget, and when its field warns
  bufferToDisk: true, // false: beyond the RAM budget let go, downloaded again when needed
  bufferAhead: 300, // seconds, when predownloading is off or unavailable
  bufferBehind: 20, // seconds to keep buffered behind playback before trimming
  seekStepSize: DEFAULT_SEEK_STEP_SIZE,
  singleClickAction: ClickActions.PLAY_PAUSE,
  doubleClickAction: ClickActions.FULLSCREEN,
  tripleClickAction: ClickActions.HIDE_CONTROLS,
  visChangeAction: VisChangeActions.NOTHING,
  miniSize: 0.25,
  miniPos: MiniplayerPositions.BOTTOM_RIGHT,
  videoDelay: 0,
  maximumDownloaders: 6,
};
