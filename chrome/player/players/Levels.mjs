// @ts-check
export class VideoLevel {
  /**
   * @param {Object} level - What the player knows of this version of the video.
   * @param {string} level.id
   * @param {number} [level.width]
   * @param {number} [level.height]
   * @param {number} [level.bitrate]
   * @param {?string} [level.mimeType]
   * @param {?string} [level.language]
   * @param {?string} [level.videoCodec]
   * @param {?string} [level.audioCodec]
   * @param {*} [level.track] - The player's own object for it, whichever library made it: a
   *     dash.js MediaInfo, an hls.js Level, mp4box's track info.
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
    // Distinguishes levels that are different sources rather than different qualities,
    // such as a lecture's screen capture and camera. Grouped on in the quality menu.
    this.label = label || '';
    this.width = width || 0;
    this.height = height || 0;
    this.bitrate = bitrate || 0;
    this.mimeType = mimeType || '';
    this.language = language || '';
    this.videoCodec = videoCodec ?? null;
    this.audioCodec = audioCodec ?? null;
    this.track = track;
    // 0 when the manifest does not say.
    this.frameRate = frameRate || 0;
    // 'SDR', 'PQ' or 'HLG' (DecodingCapabilities.normalizeVideoRange).
    this.videoRange = videoRange || 'SDR';
    // Firefox's {supported, smooth, powerEfficient} for this version, or null without an
    // answer (DecodingCapabilities). LevelManager ranks versions of one height by it.
    this.decoding = decoding ?? null;
  }
}

export class AudioLevel {
  /**
   * @param {Object} level - What the player knows of this version of the audio.
   * @param {string} level.id
   * @param {number} [level.bitrate]
   * @param {?string} [level.mimeType]
   * @param {?string} [level.language]
   * @param {?string} [level.audioCodec]
   * @param {*} [level.track] - The player's own object for it, as VideoLevel's.
   * @param {?import('./DecodingCapabilities.mjs').DecodingInfo} [level.decoding]
   */
  constructor({
    id,
    bitrate,
    mimeType,
    language,
    audioCodec,
    track,
    decoding,
  }) {
    this.id = id;
    this.bitrate = bitrate || 0;
    this.mimeType = mimeType || '';
    this.language = language || '';
    this.audioCodec = audioCodec ?? null;
    this.track = track;
    this.decoding = decoding ?? null;
  }
}
