// @ts-check

/**
 * What Firefox says about decoding a stream's versions (Media Capabilities).
 * Answers only reorder versions of one height; none is removed for one.
 */

/**
 * @typedef {Object} DecodingInfo
 * @property {boolean} supported
 * @property {boolean} smooth
 * @property {boolean} powerEfficient - In Firefox: decoded in hardware.
 */

/** @typedef {'SDR'|'PQ'|'HLG'} VideoRange */

/**
 * @typedef {Object} VideoProbe
 * @property {string} contentType - MIME type with codecs, as MSE gets it.
 * @property {number} width
 * @property {number} height
 * @property {number} bitrate
 * @property {number} framerate
 * @property {VideoRange} videoRange
 */

/**
 * @typedef {Object} AudioProbe
 * @property {string} contentType
 * @property {number} bitrate
 */

export const CodecFamilies = Object.freeze({
  AV1: 'av1',
  VP9: 'vp9',
  HEVC: 'hevc',
  DOLBY_VISION: 'dolbyvision',
  AVC: 'avc',
  VP8: 'vp8',
  AAC: 'aac',
  OPUS: 'opus',
  AC3: 'ac3',
  EAC3: 'eac3',
  FLAC: 'flac',
  MP3: 'mp3',
  VORBIS: 'vorbis',
});

/** @type {Map<string, string>} */
const FAMILY_BY_FOURCC = new Map([
  ['av01', CodecFamilies.AV1],
  ['vp09', CodecFamilies.VP9],
  ['vp9', CodecFamilies.VP9],
  ['hvc1', CodecFamilies.HEVC],
  ['hev1', CodecFamilies.HEVC],
  ['dvh1', CodecFamilies.DOLBY_VISION],
  ['dvhe', CodecFamilies.DOLBY_VISION],
  ['dav1', CodecFamilies.DOLBY_VISION],
  ['avc1', CodecFamilies.AVC],
  ['avc3', CodecFamilies.AVC],
  ['vp08', CodecFamilies.VP8],
  ['vp8', CodecFamilies.VP8],
  ['mp4a', CodecFamilies.AAC],
  ['opus', CodecFamilies.OPUS],
  ['ac-3', CodecFamilies.AC3],
  ['ec-3', CodecFamilies.EAC3],
  ['flac', CodecFamilies.FLAC],
  ['fLaC', CodecFamilies.FLAC],
  ['mp3', CodecFamilies.MP3],
  ['vorbis', CodecFamilies.VORBIS],
]);

/** @type {Set<string>} */
const VIDEO_FAMILIES = new Set([
  CodecFamilies.AV1, CodecFamilies.VP9, CodecFamilies.HEVC, CodecFamilies.DOLBY_VISION,
  CodecFamilies.AVC, CodecFamilies.VP8,
]);

// Picture per bit, best first; consulted only between versions all decoded in hardware.
/** @type {Map<string, number>} */
const EFFICIENCY = new Map([
  [CodecFamilies.AV1, 3],
  [CodecFamilies.VP9, 2],
  [CodecFamilies.HEVC, 2],
  [CodecFamilies.AVC, 1],
]);

// A probe that never answers must not hold the stream back: dash.js and hls.js wait for it.
export const PROBE_TIMEOUT_MS = 1500;

/** @type {Map<string, Promise<DecodingInfo|null>>} */
const probes = new Map();
/** @type {Map<string, DecodingInfo|null>} */
const answers = new Map();

/**
 * A bare codec, a list of them, or a whole MIME type: returns the first codec, bare.
 * @param {?string|undefined} codec
 * @return {?string}
 */
export function bareCodec(codec) {
  if (!codec || typeof codec !== 'string') {
    return null;
  }
  let value = codec.trim();
  const match = /codecs\s*=\s*"?([^";]*)"?/i.exec(value);
  if (match) {
    value = match[1];
  } else if (value.includes('/')) {
    return null;
  }
  const first = value.split(',')[0].trim();
  return first || null;
}

/**
 * @param {?string|undefined} codec
 * @return {?string} One of CodecFamilies, or null for a codec this does not know.
 */
export function getCodecFamily(codec) {
  const bare = bareCodec(codec);
  if (!bare) {
    return null;
  }
  const fourcc = bare.split('.')[0];
  return FAMILY_BY_FOURCC.get(fourcc) ?? FAMILY_BY_FOURCC.get(fourcc.toLowerCase()) ?? null;
}

/**
 * @param {?string} family
 * @return {number} Higher is more efficient; 0 for anything not ranked.
 */
export function getCodecEfficiency(family) {
  return (family && EFFICIENCY.get(family)) || 0;
}

/** @type {Map<string, string>} */
const DISPLAY_NAMES = new Map([
  [CodecFamilies.AV1, 'AV1'],
  [CodecFamilies.VP9, 'VP9'],
  [CodecFamilies.HEVC, 'HEVC'],
  [CodecFamilies.DOLBY_VISION, 'Dolby Vision'],
  [CodecFamilies.AVC, 'H.264'],
  [CodecFamilies.VP8, 'VP8'],
]);

/**
 * @param {?string|undefined} codec
 * @return {?string}
 */
export function getCodecDisplayName(codec) {
  return DISPLAY_NAMES.get(getCodecFamily(codec) || '') ?? null;
}

/**
 * Hardware, software, or nothing without an answer.
 * @param {?DecodingInfo|undefined} decoding
 * @return {?('hardware'|'software')}
 */
export function getDecodingLabel(decoding) {
  if (!decoding || !decoding.supported) {
    return null;
  }
  return decoding.powerEfficient ? 'hardware' : 'software';
}

/**
 * @param {?string|undefined} value
 * @return {VideoRange}
 */
export function normalizeVideoRange(value) {
  const upper = (value || '').toUpperCase();
  if (upper === 'PQ' || upper === 'HLG') {
    return /** @type {VideoRange} */ (upper);
  }
  return 'SDR';
}

/**
 * DASH writes "30000/1001", HLS a decimal.
 * @param {?string|number|undefined} value
 * @return {number} 0 when unknown.
 */
export function parseFrameRate(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (typeof value !== 'string' || !value) {
    return 0;
  }
  const [num, den] = value.split('/');
  const rate = den === undefined ? parseFloat(num) : parseFloat(num) / parseFloat(den);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

// ISO/IEC 23091-2 transfer characteristics, as DASH signals them.
const TRANSFER_SCHEME = 'urn:mpeg:mpegB:cicp:TransferCharacteristics';
const TRANSFER_RANGES = new Map([['16', 'PQ'], ['18', 'HLG']]);

/**
 * @param {any} descriptors
 * @return {Array<{schemeIdUri?: string, value?: any}>}
 */
function asList(descriptors) {
  if (!descriptors) return [];
  return Array.isArray(descriptors) ? descriptors : [descriptors];
}

/**
 * What a DASH representation says about itself (dash.js's, its AdaptationSet's common properties pushed down).
 * @param {any} rep
 * @return {{type: ?string, codec: ?string, mimeType: string, width: number, height: number,
 *   bitrate: number, frameRate: number, videoRange: VideoRange}}
 */
export function describeDashRepresentation(rep) {
  const mimeType = typeof rep?.mimeType === 'string' ? rep.mimeType : '';
  const codec = bareCodec(rep?.codecs);
  let type = mimeType.startsWith('video/') ? 'video' : (mimeType.startsWith('audio/') ? 'audio' : null);
  if (!type) {
    const family = getCodecFamily(codec);
    type = family && VIDEO_FAMILIES.has(family) ? 'video' : (family ? 'audio' : null);
  }
  let videoRange = /** @type {VideoRange} */ ('SDR');
  const descriptors = [...asList(rep?.EssentialProperty), ...asList(rep?.SupplementalProperty)];
  for (const descriptor of descriptors) {
    if (descriptor?.schemeIdUri === TRANSFER_SCHEME) {
      const range = TRANSFER_RANGES.get(String(descriptor.value));
      if (range) videoRange = /** @type {VideoRange} */ (range);
    }
  }
  if (videoRange === 'SDR' && getCodecFamily(codec) === CodecFamilies.DOLBY_VISION) {
    videoRange = 'PQ';
  }
  return {
    type,
    codec,
    mimeType,
    width: Number(rep?.width) || 0,
    height: Number(rep?.height) || 0,
    bitrate: Number(rep?.bandwidth) || 0,
    frameRate: parseFrameRate(rep?.frameRate),
    videoRange,
  };
}

/**
 * MSE gets fragmented MP4 from the HLS player whatever the container, so anything but WebM is asked as MP4.
 * @param {{codec: ?string|undefined, mimeType?: ?string, width?: number, height?: number,
 *   bitrate?: number, frameRate?: number, videoRange?: ?string}} level
 * @return {?VideoProbe} Null when the codec is not known.
 */
export function videoProbeFor(level) {
  const codec = bareCodec(level.codec);
  if (!codec) {
    return null;
  }
  const container = (level.mimeType || '').toLowerCase().includes('webm') ? 'video/webm' : 'video/mp4';
  return {
    contentType: `${container}; codecs="${codec}"`,
    // The API needs every field: a version without one is asked about as 1080p30 (the codec is what matters).
    width: level.width || 1920,
    height: level.height || 1080,
    bitrate: level.bitrate || 5000000,
    framerate: level.frameRate || 30,
    videoRange: normalizeVideoRange(level.videoRange),
  };
}

/**
 * @param {{codec: ?string|undefined, mimeType?: ?string, bitrate?: number}} level
 * @return {?AudioProbe}
 */
export function audioProbeFor(level) {
  const codec = bareCodec(level.codec);
  if (!codec) {
    return null;
  }
  const mime = (level.mimeType || '').toLowerCase();
  const container = mime.includes('webm') ? 'audio/webm' : 'audio/mp4';
  return {
    contentType: `${container}; codecs="${codec}"`,
    bitrate: level.bitrate || 128000,
  };
}

/**
 * @param {VideoProbe|AudioProbe} probe
 * @return {Object}
 */
export function toDecodingConfiguration(probe) {
  if ('framerate' in probe) {
    /** @type {Object<string, any>} */
    const video = {
      contentType: probe.contentType,
      width: probe.width,
      height: probe.height,
      bitrate: probe.bitrate,
      framerate: probe.framerate,
    };
    if (probe.videoRange !== 'SDR') {
      video.transferFunction = probe.videoRange === 'PQ' ? 'pq' : 'hlg';
      video.colorGamut = 'rec2020';
    }
    return {type: 'media-source', video};
  }
  return {
    type: 'media-source',
    audio: {contentType: probe.contentType, bitrate: probe.bitrate},
  };
}

/**
 * @param {VideoProbe|AudioProbe} probe
 * @return {string}
 */
function keyOf(probe) {
  return JSON.stringify(toDecodingConfiguration(probe));
}

/**
 * Asks once per distinct version; later calls share the answer.
 * @param {?VideoProbe|AudioProbe} probe
 * @return {Promise<DecodingInfo|null>} Null without an answer (no API, an error, a timeout).
 */
export function probeDecoding(probe) {
  if (!probe) {
    return Promise.resolve(null);
  }
  const key = keyOf(probe);
  // An answer that came after its probe gave up is kept (below): not asked again.
  if (answers.has(key)) {
    return Promise.resolve(answers.get(key) ?? null);
  }
  const existing = probes.get(key);
  if (existing) {
    return existing;
  }
  const capabilities = globalThis.navigator?.mediaCapabilities;
  if (!capabilities || typeof capabilities.decodingInfo !== 'function') {
    return Promise.resolve(null);
  }

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
  });
  const asked = Promise.resolve()
      .then(() => capabilities.decodingInfo(/** @type {any} */ (toDecodingConfiguration(probe))))
      .then((result) => ({
        supported: !!result?.supported,
        smooth: !!result?.smooth,
        powerEfficient: !!result?.powerEfficient,
      }))
      .catch((e) => {
        console.warn('[DecodingCapabilities] decodingInfo failed', probe, e);
        return null;
      })
      .then((info) => {
        // Kept whenever it comes, also after the probe gave up: the menu, the next pick and a refresh read it.
        if (info) {
          answers.set(key, info);
        }
        return info;
      });
  const answer = Promise.race([asked, timeout]).then((result) => {
    clearTimeout(timer);
    const info = /** @type {DecodingInfo|null} */ (result);
    // No answer is not remembered as unknown: asked again next time.
    if (!info) {
      probes.delete(key);
    }
    return info;
  });
  probes.set(key, answer);
  return answer;
}

/**
 * The pick itself is synchronous (dash.js's track selection): the players ask first and the pick reads this.
 * @param {?VideoProbe|AudioProbe} probe
 * @return {DecodingInfo|null}
 */
export function cachedAnswer(probe) {
  if (!probe) {
    return null;
  }
  return answers.get(keyOf(probe)) ?? null;
}

/**
 * HDR is preferred only when the screen and the decoder agree: else it is washed out or dark.
 * @return {boolean}
 */
export function screenSupportsHdr() {
  try {
    return !!globalThis.matchMedia?.('(dynamic-range: high)')?.matches;
  } catch (e) {
    return false;
  }
}

/** For tests: forget every answer. */
export function clearDecodingCache() {
  probes.clear();
  answers.clear();
}
