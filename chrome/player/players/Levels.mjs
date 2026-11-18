// @ts-check
export class VideoLevel {
  /**
   * @param {Object} level
   * @param {string} level.id
   * @param {number} [level.width]
   * @param {number} [level.height]
   * @param {number} [level.bitrate]
   * @param {?string} [level.mimeType]
   * @param {?string} [level.language]
   * @param {?string} [level.videoCodec]
   * @param {?string} [level.audioCodec]
   * @param {*} [level.track] - The player's own object for it: a dash.js MediaInfo, an hls.js Level, mp4box's track info.
   * @param {string} [level.label]
   * @param {number} [level.frameRate]
   * @param {import('./DecodingCapabilities.mjs').VideoRange} [level.videoRange]
   * @param {?import('./DecodingCapabilities.mjs').DecodingInfo} [level.decoding]
   */
  constructor({
    id,
    width,
    height,
    bitrate,
    mimeType,
    language,
    videoCodec,
    audioCodec,
    track,
    label,
    frameRate,
    videoRange,
    decoding,
  }) {
    this.id = id;
    // Different sources rather than qualities (a lecture's screen and camera): grouped in the menu.
    this.label = label || '';
    this.width = width || 0;
    this.height = height || 0;
    this.bitrate = bitrate || 0;
    this.mimeType = mimeType || '';
    this.language = language || '';
    this.videoCodec = videoCodec ?? null;
    this.audioCodec = audioCodec ?? null;
    this.track = track;
    this.frameRate = frameRate || 0;
    // 'SDR', 'PQ' or 'HLG' (DecodingCapabilities.normalizeVideoRange).
    this.videoRange = videoRange || 'SDR';
    // Firefox's decoding answer, or null. LevelManager ranks versions of one height by it.
    this.decoding = decoding ?? null;
  }
}

export class AudioLevel {
  /**
   * @param {Object} level
   * @param {string} level.id
   * @param {number} [level.bitrate]
   * @param {?string} [level.mimeType]
   * @param {?string} [level.language]
   * @param {?string} [level.audioCodec]
   * @param {*} [level.track]
   * @param {string} [level.label] - The track's own name: two tracks in one language are told apart by it.
   * @param {?import('./DecodingCapabilities.mjs').DecodingInfo} [level.decoding]
   */
  constructor({
    id,
    bitrate,
    mimeType,
    language,
    audioCodec,
    track,
    label,
    decoding,
  }) {
    this.id = id;
    this.label = label || '';
    this.bitrate = bitrate || 0;
    this.mimeType = mimeType || '';
    this.language = language || '';
    this.audioCodec = audioCodec ?? null;
    this.track = track;
    this.decoding = decoding ?? null;
  }
}
