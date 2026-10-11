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
  mpvAllowlist: [],
  mpvPath: '',
  mpvFullscreen: false,
  mpvPausePage: true,
  mpvSingleInstance: true,
  // MPV autoplay (2026-10-11, his choice): its own setting, also switched by mpv's autoplay
  // button; the browser player's is autoplayNext.
  mpvAutoplayNext: true,
  downloadAll: true,
  blockPopupsWhilePlaying: true,
  previewEnabled: true,
  // Among versions of the chosen resolution, prefer the one Firefox decodes in hardware,
  // then smooth, higher frame rate and the more efficient codec; playable audio first.
  decodingAwareQuality: true,
  autoEnableBestSubtitles: false,
  storeProgress: true,
  autoplayNext: false,
  // Seconds between an episode's end and the next one, in the player and in mpv; 0: none.
  autoplayCountdown: 5,
  defaultQuality: `Auto`,
  colorTheme: ColorThemes.DEFAULT,
  autoEnableURLs: [],
  customSourcePatterns: ``,
  keybinds: DefaultKeybinds,
  keybindsVersion: KEYBINDS_VERSION,
  // Saved with the options: those saved before carry none, and their maximum size may be a
  // bare number read as bytes (Utils.migrateSizes).
  sizesVersion: 1,
  videoZoom: 1,
  videoAspectRatio: AspectRatios.AUTO,
  maxSpeed: -1,
  maxVideoSize: 5000000000, // 5GB max size
  ramBudget: 2000000000, // downloaded video kept in RAM, all players together; beyond it: disk (private windows: let go)
  bufferToDisk: true, // beyond the RAM budget: on disk; false: let go, downloaded again when needed (as in private windows)
  bufferAhead: 300, // seconds to keep buffered ahead of playback when predownloading is off/unavailable
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
