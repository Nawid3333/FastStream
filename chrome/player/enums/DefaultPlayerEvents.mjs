// @ts-check
// The media element's events, and FastStream's own after WAITING.
export const DefaultPlayerEvents = {
  ABORT: 'abort',
  CANPLAY: 'canplay',
  CANPLAYTHROUGH: 'canplaythrough',
  COMPLETE: 'complete',
  DURATIONCHANGE: 'durationchange',
  EMPTIED: 'emptied',
  ENDED: 'ended',
  LOADEDDATA: 'loadeddata',
  LOADEDMETADATA: 'loadedmetadata',
  PAUSE: 'pause',
  PLAY: 'play',
  PLAYING: 'playing',
  PROGRESS: 'progress',
  RATECHANGE: 'ratechange',
  SEEKED: 'seeked',
  SEEKING: 'seeking',
  STALLED: 'stalled',
  SUSPEND: 'suspend',
  TIMEUPDATE: 'timeupdate',
  VOLUMECHANGE: 'volumechange',
  WAITING: 'waiting',

  LEVELUPDATE: 'levelupdate',
  FRAGMENT_UPDATE: 'fragmentupdate',
  // With the suggested level.
  MANIFEST_PARSED: 'manifestparsed',
  DESTROYED: 'destroyed',
  ERROR: 'error',
  // The source goes to Firefox's own player (MP4Player, for a server that ignores Range).
  PLAY_DIRECTLY: 'playdirectly',
  // A DRM key is asked for: not supported.
  NEED_KEY: 'needkey',
  PLAYLIST: 'playlist',
};
