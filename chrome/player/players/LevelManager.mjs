// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {getCodecEfficiency, getCodecFamily, screenSupportsHdr} from './DecodingCapabilities.mjs';
import {WebStorage} from '../utils/WebStorage.mjs';

// Sites whose manual codec choice is remembered; the oldest is forgotten past this.
const MAX_CODEC_SITES = 200;

// Decode errors of one video codec family before this video's picks leave it out: one bad segment is no codec's fault.
const VIDEO_DECODE_FAILURES_TO_DROP = 2;

/** @typedef {import('./Levels.mjs').VideoLevel} VideoLevel */
/** @typedef {import('./Levels.mjs').AudioLevel} AudioLevel */

/**
 * @template {{language?: string}} L
 * @param {Array<L>} availableLevels
 * @param {*} lang
 * @return {Array<L>}
 */
function bestLanguageMatches(availableLevels, lang) {
  /** @type {Array<{level: L, matchLevel: number}>} */
  const matched = [];
  availableLevels.forEach((level) => {
    const matchLevel = Localize.getLanguageMatchLevel(level.language, lang);
    if (matchLevel > 0) {
      matched.push({level, matchLevel});
    }
  });

  if (matched.length === 0) {
    return availableLevels;
  }

  // Only the best-matching ones: the quality sort after this ignores how well the language matched.
  const best = Math.max(...matched.map((item) => item.matchLevel));
  return matched.filter((item) => item.matchLevel === best).map((item) => item.level);
}

export class LevelManager {
  /** @param {import('../FastStreamClient.mjs').FastStreamClient} client */
  constructor(client) {
    this.client = client;

    /** @type {string|number|null} */
    this.currentVideoLevelID = null;
    /** @type {string|number|null} */
    this.currentAudioLevelID = null;

    /** @type {?string} */
    this.currentVideoLanguage = null;
    /** @type {?string} */
    this.currentAudioLanguage = null;

    this.prioritizedVideoContainer = 'mp4';
    this.prioritizedAudioContainer = 'mp4';

    // A codec picked by hand in the quality menu, as a family (CodecFamilies), per site.
    /** @type {Object<string, string>} */
    this.videoCodecFamilyBySite = {};
    /** @type {?string} */
    this.prioritizedAudioCodec = null;

    this.shouldPreferDRCAudio = true;

    /** @type {Map<string, number>} */
    this.videoDecodeFailures = new Map();

    this.loadPreferences();
  }

  savePreferences() {
    clearTimeout(this.savePrefsTimeout);
    this.savePrefsTimeout = setTimeout(() => {
      this.savePreferencesInternal();
    }, 200);
  }

  savePreferencesInternal() {
    const savedPrefs = {
      videoLanguage: this.currentVideoLanguage,
      audioLanguage: this.currentAudioLanguage,
      prioritizedVideoContainer: this.prioritizedVideoContainer,
      prioritizedAudioContainer: this.prioritizedAudioContainer,
      videoCodecFamilyBySite: this.videoCodecFamilyBySite,
      prioritizedAudioCodec: this.prioritizedAudioCodec,
      shouldPreferDRCAudio: this.shouldPreferDRCAudio,
    };
    WebStorage.set('local', 'level_manager_prefs', JSON.stringify(savedPrefs));
  }

  loadPreferences() {
    const prefsStr = WebStorage.get('local', 'level_manager_prefs');
    if (!prefsStr) {
      return;
    }
    try {
      const prefs = JSON.parse(prefsStr);
      this.currentVideoLanguage = prefs.videoLanguage || null;
      this.currentAudioLanguage = prefs.audioLanguage || null;
      this.prioritizedVideoContainer = prefs.prioritizedVideoContainer || 'mp4';
      this.prioritizedAudioContainer = prefs.prioritizedAudioContainer || 'mp4';
      const bySite = prefs.videoCodecFamilyBySite;
      this.videoCodecFamilyBySite = (bySite && typeof bySite === 'object' && !Array.isArray(bySite)) ? bySite : {};
      this.prioritizedAudioCodec = prefs.prioritizedAudioCodec || null;
      // Its default is on: settings saved before it existed loaded it as off.
      this.shouldPreferDRCAudio = prefs.shouldPreferDRCAudio ?? true;
    } catch (e) {
      console.warn('Failed to load level manager preferences:', e);
    }
  }

  reset() {
    this.currentVideoLevelID = null;
    this.currentAudioLevelID = null;
    this.videoDecodeFailures.clear();
  }

  /**
   * From the second decode error, the codec's family is left out of this video's picks while another is there.
   * @param {?string} codec
   * @param {boolean} [cannotStart] - Firefox could not create the decoder: this one failure leaves the family out.
   * @return {boolean} True once per family: for the failure that leaves it out.
   */
  noteVideoDecodeFailure(codec, cannotStart = false) {
    const family = getCodecFamily(codec);
    if (!family) {
      return false;
    }
    const before = this.videoDecodeFailures.get(family) || 0;
    const count = cannotStart ? Math.max(before + 1, VIDEO_DECODE_FAILURES_TO_DROP) : before + 1;
    this.videoDecodeFailures.set(family, count);
    return before < VIDEO_DECODE_FAILURES_TO_DROP && count >= VIDEO_DECODE_FAILURES_TO_DROP;
  }

  /**
   * To carry over a reload of the same source (reloadWithoutFailedCodec), which reset() would forget.
   * @return {Map<string, number>} A copy: codec family -> failures.
   */
  getVideoDecodeFailures() {
    return new Map(this.videoDecodeFailures);
  }

  /** @param {Map<string, number>} failures */
  restoreVideoDecodeFailures(failures) {
    this.videoDecodeFailures = new Map(failures);
  }

  /**
   * @param {?string} codec
   * @return {boolean}
   */
  isVideoCodecFailed(codec) {
    const family = getCodecFamily(codec);
    return !!family && (this.videoDecodeFailures.get(family) || 0) >= VIDEO_DECODE_FAILURES_TO_DROP;
  }

  /** @param {string|number} levelID */
  setCurrentVideoLevelID(levelID) {
    this.currentVideoLevelID = levelID;
  }

  /** @param {string|number} levelID */
  setCurrentAudioLevelID(levelID) {
    this.currentAudioLevelID = levelID;
  }

  /** @param {string} language */
  setCurrentVideoLanguage(language) {
    this.currentVideoLanguage = language;
    this.savePreferences();
  }

  /** @param {string} language */
  setCurrentAudioLanguage(language) {
    this.currentAudioLanguage = language;
    this.savePreferences();
  }

  /** @param {string} container - The subtype of a MIME type, e.g. 'mp4'. */
  setPrioritizedVideoContainer(container) {
    this.prioritizedVideoContainer = container;
    this.savePreferences();
  }

  /** @param {string} container - The subtype of a MIME type, e.g. 'mp4'. */
  setPrioritizedAudioContainer(container) {
    this.prioritizedAudioContainer = container;
    this.savePreferences();
  }

  /** @param {?string} codec */
  setPrioritizedVideoCodec(codec) {
    const family = getCodecFamily(codec);
    const site = this.getSiteKey();
    if (!family || !site) {
      return;
    }
    // Re-inserted so the object's order is oldest first.
    delete this.videoCodecFamilyBySite[site];
    this.videoCodecFamilyBySite[site] = family;
    const sites = Object.keys(this.videoCodecFamilyBySite);
    for (let i = 0; i < sites.length - MAX_CODEC_SITES; i++) {
      delete this.videoCodecFamilyBySite[sites[i]];
    }
    this.savePreferences();
  }

  /**
   * Its codec family is remembered only when the click chose between codecs (isCodecChoice).
   * @param {VideoLevel} level
   * @param {Array<VideoLevel>} [versions] - The versions of its size it was picked from.
   */
  rememberVideoChoice(level, versions = [level]) {
    const mimeType = (level.mimeType || '').split('/');
    if (mimeType.length > 1) {
      this.setPrioritizedVideoContainer(mimeType[1]);
    }

    if (level.videoCodec && LevelManager.isCodecChoice(versions)) {
      this.setPrioritizedVideoCodec(level.videoCodec);
    }
  }

  /**
   * More than one codec family among them (a version whose codec is not known does not count).
   * @param {Array<VideoLevel>} versions
   * @return {boolean}
   */
  static isCodecChoice(versions) {
    const families = new Set();
    for (const version of versions || []) {
      const family = getCodecFamily(version?.videoCodec);
      if (family) {
        families.add(family);
      }
    }
    return families.size > 1;
  }

  /** @return {?string} The codec family picked by hand on this site, if any. */
  getPrioritizedVideoCodecFamily() {
    const site = this.getSiteKey();
    return (site && Object.hasOwn(this.videoCodecFamilyBySite, site)) ? this.videoCodecFamilyBySite[site] : null;
  }

  /**
   * The page that asked for it (Referer or Origin), else the stream's host; "www." dropped.
   * @return {?string}
   */
  getSiteKey() {
    const source = /** @type {import('../VideoSource.mjs').VideoSource|null|undefined} */ (this.client?.source);
    if (!source) {
      return null;
    }
    const headers = source.headers || {};
    const candidates = [headers.referer, headers.origin, source.url];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate) continue;
      try {
        const host = new URL(candidate).hostname;
        if (host) {
          return host.replace(/^www\./, '');
        }
      } catch (e) {
        // Not a URL: try the next.
      }
    }
    return null;
  }

  /** @return {boolean} */
  isDecodingAware() {
    return this.client?.options?.decodingAwareQuality !== false;
  }

  /**
   * A key compared left to right, higher first.
   * Frame rate and codec efficiency count only between versions decoded in hardware.
   * @param {VideoLevel} level
   * @param {boolean} hdrScreen
   * @return {Array<number>}
   */
  videoRankKey(level, hdrScreen) {
    const decoding = level.decoding || null;
    const known = /** @param {boolean|undefined} value - One of the decoding answers. */ (value) => value === true ? 2 : (decoding ? 0 : 1);
    const isHdr = !!level.videoRange && level.videoRange !== 'SDR';
    const hdrUsable = isHdr && hdrScreen && decoding?.supported === true;
    const hardware = decoding?.powerEfficient === true;
    return [
      decoding?.supported === false ? 0 : 1,
      // HDR the screen or decoder cannot show looks washed out or dark: SDR before it.
      isHdr && !hdrUsable ? 0 : 1,
      known(decoding?.powerEfficient),
      known(decoding?.smooth),
      hdrUsable ? 1 : 0,
      hardware ? Math.round(level.frameRate || 0) : 0,
      hardware ? getCodecEfficiency(getCodecFamily(level.videoCodec)) : 0,
      level.bitrate || 0,
    ];
  }

  /**
   * Orders the versions of the first one's height by videoRankKey: nothing is removed, no other height moves ahead.
   * @param {Array<VideoLevel>} levels
   * @return {Array<VideoLevel>}
   */
  rankHeightGroup(levels) {
    if (levels.length < 2) {
      return levels;
    }
    const height = levels[0].height;
    const group = levels.filter((level) => level.height === height);
    if (group.length < 2) {
      return levels;
    }
    const rest = levels.filter((level) => level.height !== height);
    const hdrScreen = screenSupportsHdr();
    const keys = new Map(group.map((level) => [level, this.videoRankKey(level, hdrScreen)]));
    group.sort((a, b) => {
      const ka = /** @type {Array<number>} */ (keys.get(a));
      const kb = /** @type {Array<number>} */ (keys.get(b));
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) {
          return kb[i] - ka[i];
        }
      }
      return 0;
    });
    return [...group, ...rest];
  }

  /** @param {string} codec */
  setPrioritizedAudioCodec(codec) {
    this.prioritizedAudioCodec = codec;
    this.savePreferences();
  }

  /** @param {boolean} prefer */
  setShouldPreferDRCAudio(prefer) {
    this.shouldPreferDRCAudio = prefer;
    this.savePreferences();
  }

  getCurrentVideoLevelID() {
    return this.currentVideoLevelID;
  }

  getCurrentAudioLevelID() {
    return this.currentAudioLevelID;
  }

  getVideoLanguage() {
    return this.currentVideoLanguage || navigator.language || /** @type {Navigator & {userLanguage?: string}} */ (navigator).userLanguage || null;
  }

  getAudioLanguage() {
    return this.currentAudioLanguage || navigator.language || /** @type {Navigator & {userLanguage?: string}} */ (navigator).userLanguage || null;
  }

  getDesiredVideoHeight() {
    // Options without it are Auto, as the players read them.
    const defaultQuality = this.client.options.defaultQuality || 'Auto';
    if (defaultQuality === 'Auto') {
      // Infinity: matchQuality picks the highest level.
      return Infinity;
    } else {
      return parseInt(defaultQuality.replace('p', ''));
    }
  }

  /**
   * @param {Array<VideoLevel>} levels
   * @param {number} desiredHeight - Pixels; Infinity for the highest.
   * @return {Array<VideoLevel>}
   */
  matchQuality(levels, desiredHeight) {
    // The smallest level at or above the target, else the highest below it.
    /** @type {Array<VideoLevel>} */
    const atOrAbove = [];
    /** @type {Array<VideoLevel>} */
    const below = [];
    levels.forEach((level) => {
      if (level.height >= desiredHeight) {
        atOrAbove.push(level);
      } else {
        below.push(level);
      }
    });

    // Ascending; ties prefer the higher bitrate.
    atOrAbove.sort((a, b) => {
      if (a.height === b.height) {
        return b.bitrate - a.bitrate;
      }
      return a.height - b.height;
    });

    below.sort((a, b) => {
      if (a.height === b.height) {
        return b.bitrate - a.bitrate;
      }
      return b.height - a.height;
    });

    return [...atOrAbove, ...below];
  }

  /**
   * @param {VideoLevel|(AudioLevel & {videoCodec?: undefined})} level
   * @return {boolean}
   */
  isLevelContainerPrioritized(level) {
    if (!level || !level.mimeType) {
      return false;
    }

    const mimeParts = level.mimeType.split('/');
    if (mimeParts.length < 2) {
      return false;
    }

    const container = mimeParts[1].toLowerCase();
    if (level.videoCodec) {
      return container.includes(this.prioritizedVideoContainer);
    } else if (level.audioCodec) {
      return container.includes(this.prioritizedAudioContainer);
    } else {
      return false;
    }
  }

  /**
   * @param {Array<VideoLevel>} availableLevels
   * @param {?number} [desiredHeight]
   * @param {boolean} [ignoreCurrent]
   * @return {?VideoLevel}
   */
  pickVideoLevel(availableLevels, desiredHeight = null, ignoreCurrent = false) {
    if (!ignoreCurrent && this.currentVideoLevelID !== null) {
      const currentLevel = availableLevels.find((level) => level.id === this.currentVideoLevelID);
      // Not one whose codec failed to decode here, chosen in the menu or not.
      if (currentLevel && !this.isVideoCodecFailed(currentLevel.videoCodec)) {
        return currentLevel;
      }
    }

    // Then the codecs that failed to decode in this video, while another one is left.
    const decodable = availableLevels.filter((level) => !this.isVideoCodecFailed(level.videoCodec));
    if (decodable.length > 0) {
      availableLevels = decodable;
    }

    availableLevels = this.filterVideoLevelsByLanguage(availableLevels);


    desiredHeight = desiredHeight || this.getDesiredVideoHeight();
    availableLevels = this.matchQuality(availableLevels, desiredHeight);

    if (this.isDecodingAware()) {
      availableLevels = this.rankHeightGroup(availableLevels);
    }

    const containerLevels = availableLevels.filter((level) => {
      return this.isLevelContainerPrioritized(level);
    });

    if (containerLevels.length > 0 && containerLevels[0].height === availableLevels[0].height) {
      availableLevels = containerLevels;
    }

    const preferredFamily = this.getPrioritizedVideoCodecFamily();
    const codecLevels = availableLevels.filter((level) => {
      return preferredFamily && getCodecFamily(level.videoCodec) === preferredFamily;
    });
    if (codecLevels.length > 0 && codecLevels[0].height === availableLevels[0].height) {
      availableLevels = codecLevels;
    }

    return availableLevels[0] || null;
  }

  /**
   * @param {Array<AudioLevel>} availableLevels
   * @param {boolean} [ignoreCurrent]
   * @return {?AudioLevel}
   */
  pickAudioLevel(availableLevels, ignoreCurrent = false) {
    if (!ignoreCurrent && this.currentAudioLevelID !== null) {
      const currentLevel = availableLevels.find((level) => level.id === this.currentAudioLevelID);
      if (currentLevel) {
        return currentLevel;
      }
    }

    // A copy: the levels are sorted below.
    availableLevels = availableLevels.slice();

    availableLevels = this.filterAudioLevelsByLanguage(availableLevels);

    // Audio Firefox says it cannot play (Dolby AC-3/E-AC-3, say) only if nothing else is left
    if (this.isDecodingAware()) {
      const playable = availableLevels.filter((level) => level.decoding?.supported !== false);
      if (playable.length > 0) {
        availableLevels = playable;
      }
    }

    if (this.shouldPreferDRCAudio) {
      const drcLevels = availableLevels.filter((level) => {
        return level.id.includes('-drc');
      });
      if (drcLevels.length > 0) {
        availableLevels = drcLevels;
      }
    }

    const containerLevels = availableLevels.filter((level) => {
      return this.isLevelContainerPrioritized(level);
    });

    if (containerLevels.length > 0) {
      availableLevels = containerLevels;
    }

    // The codec last picked by hand, by its family: an exact string held every pick to one profile.
    const prioritized = this.prioritizedAudioCodec;
    const family = getCodecFamily(prioritized);
    const codecLevels = availableLevels.filter((level) => {
      if (!level.audioCodec || !prioritized) return false;
      return family ? getCodecFamily(level.audioCodec) === family : level.audioCodec === prioritized;
    });
    if (codecLevels.length > 0) {
      availableLevels = codecLevels;
    }

    availableLevels.sort((a, b) => {
      return b.bitrate - a.bitrate;
    });

    return availableLevels[0] || null;
  }

  /**
   * @param {Array<VideoLevel>} availableLevels
   * @return {Array<VideoLevel>}
   */
  filterVideoLevelsByLanguage(availableLevels) {
    return bestLanguageMatches(availableLevels, this.getVideoLanguage());
  }

  /**
   * @param {Array<AudioLevel>} availableLevels
   * @return {Array<AudioLevel>}
   */
  filterAudioLevelsByLanguage(availableLevels) {
    return bestLanguageMatches(availableLevels, this.getAudioLanguage());
  }
}
