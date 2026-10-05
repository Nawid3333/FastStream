import {Localize} from '../modules/Localize.mjs';
import {getCodecEfficiency, getCodecFamily, screenSupportsHdr} from './DecodingCapabilities.mjs';

// Sites whose manual codec choice is remembered; the oldest is forgotten past this.
const MAX_CODEC_SITES = 200;

// Decode errors (MEDIA_ERR_DECODE) of one video codec family before this video's picks
// leave it out (noteVideoDecodeFailure). One is retried as before: a single bad segment
// is no codec's fault.
const VIDEO_DECODE_FAILURES_TO_DROP = 2;

export class LevelManager {
  constructor(client) {
    this.client = client;

    this.currentVideoLevelID = null;
    this.currentAudioLevelID = null;

    this.currentVideoLanguage = null;
    this.currentAudioLanguage = null;

    this.prioritizedVideoContainer = 'mp4';
    this.prioritizedAudioContainer = 'mp4';

    // A codec picked by hand in the quality menu, as a family (CodecFamilies) per site.
    // It replaced one global exact codec string ("avc1.640028"), which seldom matched
    // anywhere but where it was picked and, where it did, overrode every other site.
    /** @type {Object<string, string>} */
    this.videoCodecFamilyBySite = {};
    this.prioritizedAudioCodec = null;

    this.shouldPreferDRCAudio = true;

    // Decode errors per video codec family in this video (noteVideoDecodeFailure).
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
    localStorage.setItem('level_manager_prefs', JSON.stringify(savedPrefs));
  }

  loadPreferences() {
    const prefsStr = localStorage.getItem('level_manager_prefs');
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
   * Counts a decode error (MEDIA_ERR_DECODE) of the video codec playing. From the second
   * one, the codec's family is left out of this video's picks while another is there
   * (pickVideoLevel). A codec the browser answers it can decode, but cannot, was picked
   * again after every reset: dash.js resets the MediaSource after such an error and picks
   * the track anew, and the hardware-first ranking chose the same one each time - a live
   * DASH stream stalled for good on AV1 where Firefox could not create its decoder
   * ("RemoteMediaManager is not available", the real-streams check, 2026-10-05, #348).
   * @param {?string} codec - The video codec playing, as its level names it.
   * @return {boolean} Whether this failure is the one that leaves its family out: true once
   *     per family, so what follows it (the player loaded again without it) happens once.
   */
  noteVideoDecodeFailure(codec) {
    const family = getCodecFamily(codec);
    if (!family) {
      return false;
    }
    const count = (this.videoDecodeFailures.get(family) || 0) + 1;
    this.videoDecodeFailures.set(family, count);
    return count === VIDEO_DECODE_FAILURES_TO_DROP;
  }

  /**
   * The decode failures of this video, to carry over a load of the same source again
   * (FastStreamClient.reloadWithoutFailedCodec), which reset() would otherwise forget.
   * @return {Map<string, number>} A copy: codec family -> failures.
   */
  getVideoDecodeFailures() {
    return new Map(this.videoDecodeFailures);
  }

  /**
   * @param {Map<string, number>} failures - What getVideoDecodeFailures returned.
   */
  restoreVideoDecodeFailures(failures) {
    this.videoDecodeFailures = new Map(failures);
  }

  /**
   * @param {?string} codec - A level's video codec.
   * @return {boolean} Whether its family failed to decode in this video (noteVideoDecodeFailure).
   */
  isVideoCodecFailed(codec) {
    const family = getCodecFamily(codec);
    return !!family && (this.videoDecodeFailures.get(family) || 0) >= VIDEO_DECODE_FAILURES_TO_DROP;
  }

  setCurrentVideoLevelID(levelID) {
    this.currentVideoLevelID = levelID;
  }

  setCurrentAudioLevelID(levelID) {
    this.currentAudioLevelID = levelID;
  }

  setCurrentVideoLanguage(language) {
    this.currentVideoLanguage = language;
    this.savePreferences();
  }

  setCurrentAudioLanguage(language) {
    this.currentAudioLanguage = language;
    this.savePreferences();
  }

  setPrioritizedVideoContainer(container) {
    this.prioritizedVideoContainer = container;
    this.savePreferences();
  }

  setPrioritizedAudioContainer(container) {
    this.prioritizedAudioContainer = container;
    this.savePreferences();
  }

  /**
   * Remembers the codec of a version picked by hand, as its family, for the site playing.
   * @param {?string} codec
   */
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
   * Remembers a version picked by hand in the quality menu: its container, and its codec
   * family when the click chose between codecs (isCodecChoice). A quality with one version,
   * or versions that differ only in bitrate, say nothing about codecs: the family saved
   * from such a click outranked the hardware decoder (rankHeightGroup) at every height on
   * that site, so one click on a 360p that only came in H.264 got the software-decoded
   * H.264 1080p over the hardware HEVC one from then on.
   * @param {Object} level - The version picked.
   * @param {Array<Object>} [versions] - The versions of its size it was picked from.
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
   * Whether picking one of these versions is a choice between codecs: they come in more
   * than one codec family (a version whose codec is not known does not count).
   * @param {Array<Object>} versions
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

  /**
   * @return {?string} The codec family picked by hand on this site, if any.
   */
  getPrioritizedVideoCodecFamily() {
    const site = this.getSiteKey();
    return (site && Object.hasOwn(this.videoCodecFamilyBySite, site)) ? this.videoCodecFamilyBySite[site] : null;
  }

  /**
   * The site a video plays on: the page that asked for it (its Referer or Origin), else
   * the stream's own host. "www." is dropped so both spellings of a site are one.
   * @return {?string}
   */
  getSiteKey() {
    const source = this.client?.source;
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

  /**
   * Whether versions are ranked by what Firefox says about decoding them (the
   * "decodingAwareQuality" option, on by default).
   * @return {boolean}
   */
  isDecodingAware() {
    return this.client?.options?.decodingAwareQuality !== false;
  }

  /**
   * How good a version of a given height is to pick, as a key compared left to right,
   * higher first. Only what is known moves a version ahead of today's choice (the higher
   * bitrate): frame rate and codec efficiency count only between versions decoded in
   * hardware, and a version without an answer sits between a hardware and a software one.
   * @param {Object} level
   * @param {boolean} hdrScreen
   * @return {Array<number>}
   */
  videoRankKey(level, hdrScreen) {
    const decoding = level.decoding || null;
    const known = (value) => value === true ? 2 : (decoding ? 0 : 1);
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
   * Orders the versions that share the first one's height (the height being picked) by
   * videoRankKey; the rest stay behind them as matchQuality left them. Nothing is removed,
   * and no version of another height moves ahead: the resolution stays the user's choice.
   * @param {Array<Object>} levels - As matchQuality returns them.
   * @return {Array<Object>}
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
      const ka = keys.get(a);
      const kb = keys.get(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) {
          return kb[i] - ka[i];
        }
      }
      return 0;
    });
    return [...group, ...rest];
  }

  setPrioritizedAudioCodec(codec) {
    this.prioritizedAudioCodec = codec;
    this.savePreferences();
  }

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
    return this.currentVideoLanguage || navigator.language || navigator.userLanguage || null;
  }

  getAudioLanguage() {
    return this.currentAudioLanguage || navigator.language || navigator.userLanguage || null;
  }

  getDesiredVideoHeight() {
    const defaultQuality = this.client.options.defaultQuality;
    if (defaultQuality === 'Auto') {
      // Always max out rather than scaling to the screen - Infinity has no
      // level at or above it, so matchQuality() falls through to its "no
      // level meets the target" branch and picks the highest one available.
      return Infinity;
    } else {
      return parseInt(defaultQuality.replace('p', ''));
    }
  }

  matchQuality(levels, desiredHeight) {
    // Prefer the smallest level that still meets or exceeds the target
    // height - never settle for a lower resolution than requested if a
    // higher one is on offer, even if it's numerically farther away (a
    // 1440p target with 1080p/4K available should land on 4K, not 1080p).
    // Only fall back to a lower resolution when nothing meets the target,
    // in which case the highest of those remaining is the closest possible.
    const atOrAbove = [];
    const below = [];
    levels.forEach((level) => {
      if (level.height >= desiredHeight) {
        atOrAbove.push(level);
      } else {
        below.push(level);
      }
    });

    // Ascending: the smallest level that still meets the target comes first.
    // Ties (same height) prefer the higher bitrate.
    atOrAbove.sort((a, b) => {
      if (a.height === b.height) {
        return b.bitrate - a.bitrate;
      }
      return a.height - b.height;
    });

    // Descending: closest-below comes first among the levels that fall short.
    below.sort((a, b) => {
      if (a.height === b.height) {
        return b.bitrate - a.bitrate;
      }
      return b.height - a.height;
    });

    return [...atOrAbove, ...below];
  }

  isLevelContainerPrioritized(level) {
    if (!level || !level.mimeType) {
      return false;
    }

    // split
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

  isCodecSupported(codec) {
    return true;
  }

  pickVideoLevel(availableLevels, desiredHeight = null, ignoreCurrent = false) {
    // Check if current level is still valid
    if (!ignoreCurrent && this.currentVideoLevelID !== null) {
      const currentLevel = availableLevels.find((level) => level.id === this.currentVideoLevelID);
      // Not one whose codec failed to decode here, chosen in the menu or not.
      if (currentLevel && !this.isVideoCodecFailed(currentLevel.videoCodec)) {
        return currentLevel;
      }
    }

    // First, filter out incompatible levels
    availableLevels = availableLevels.filter((level) => {
      return (!level.videoCodec || this.isCodecSupported(level.videoCodec)) &&
                (!level.audioCodec || this.isCodecSupported(level.audioCodec));
    });

    // Then the codecs that failed to decode in this video, while another one is left.
    const decodable = availableLevels.filter((level) => !this.isVideoCodecFailed(level.videoCodec));
    if (decodable.length > 0) {
      availableLevels = decodable;
    }

    // Next, pick language
    availableLevels = this.filterVideoLevelsByLanguage(availableLevels);


    // Sort by quality match
    desiredHeight = desiredHeight || this.getDesiredVideoHeight();
    availableLevels = this.matchQuality(availableLevels, desiredHeight);

    // Among the versions of that height: decoded in hardware, smooth, frame rate, codec
    if (this.isDecodingAware()) {
      availableLevels = this.rankHeightGroup(availableLevels);
    }

    // Prioritize mp4 levels
    const containerLevels = availableLevels.filter((level) => {
      return this.isLevelContainerPrioritized(level);
    });

    if (containerLevels.length > 0 && containerLevels[0].height === availableLevels[0].height) {
      availableLevels = containerLevels;
    }

    // Prioritize the codec picked by hand on this site
    const preferredFamily = this.getPrioritizedVideoCodecFamily();
    const codecLevels = availableLevels.filter((level) => {
      return preferredFamily && getCodecFamily(level.videoCodec) === preferredFamily;
    });
    if (codecLevels.length > 0 && codecLevels[0].height === availableLevels[0].height) {
      availableLevels = codecLevels;
    }

    return availableLevels[0] || null;
  }

  pickAudioLevel(availableLevels, ignoreCurrent = false) {
    // Check if current level is still valid
    if (!ignoreCurrent && this.currentAudioLevelID !== null) {
      const currentLevel = availableLevels.find((level) => level.id === this.currentAudioLevelID);
      if (currentLevel) {
        return currentLevel;
      }
    }

    // First, filter out incompatible levels
    availableLevels = availableLevels.filter((level) => {
      return (!level.audioCodec || this.isCodecSupported(level.audioCodec));
    });

    // Next, pick language
    availableLevels = this.filterAudioLevelsByLanguage(availableLevels);

    // Audio Firefox says it cannot play (Dolby AC-3/E-AC-3, say) only if nothing else is left
    if (this.isDecodingAware()) {
      const playable = availableLevels.filter((level) => level.decoding?.supported !== false);
      if (playable.length > 0) {
        availableLevels = playable;
      }
    }

    // Prioritize DRC levels if enabled
    if (this.shouldPreferDRCAudio) {
      const drcLevels = availableLevels.filter((level) => {
        return level.id.includes('-drc');
      });
      if (drcLevels.length > 0) {
        availableLevels = drcLevels;
      }
    }

    // Prioritize mp4 levels
    const containerLevels = availableLevels.filter((level) => {
      return this.isLevelContainerPrioritized(level);
    });

    if (containerLevels.length > 0) {
      availableLevels = containerLevels;
    }

    // Prioritize codec
    const codecLevels = availableLevels.filter((level) => {
      return level.audioCodec && this.prioritizedAudioCodec && level.audioCodec === this.prioritizedAudioCodec;
    });
    if (codecLevels.length > 0) {
      availableLevels = codecLevels;
    }

    // Sort by bitrate descending
    availableLevels.sort((a, b) => {
      return b.bitrate - a.bitrate;
    });

    return availableLevels[0] || null;
  }

  filterVideoLevelsByLanguage(availableLevels) {
    const lang = this.getVideoLanguage();
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

    // Only the best-matching ones: the quality or bitrate sort after this threw the order
    // away, and with an en-GB preference an en-US 1080p beat an en-GB 720p.
    const best = Math.max(...matched.map((item) => item.matchLevel));
    return matched.filter((item) => item.matchLevel === best).map((item) => item.level);
  }

  filterAudioLevelsByLanguage(availableLevels) {
    const lang = this.getAudioLanguage();
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

    // Only the best-matching ones: the quality or bitrate sort after this threw the order
    // away, and with an en-GB preference an en-US 1080p beat an en-GB 720p.
    const best = Math.max(...matched.map((item) => item.matchLevel));
    return matched.filter((item) => item.matchLevel === best).map((item) => item.level);
  }
}
