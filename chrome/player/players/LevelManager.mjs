import {Localize} from '../modules/Localize.mjs';

export class LevelManager {
  constructor(client) {
    this.client = client;

    this.currentVideoLevelID = null;
    this.currentAudioLevelID = null;

    this.currentVideoLanguage = null;
    this.currentAudioLanguage = null;

    this.prioritizedVideoContainer = 'mp4';
    this.prioritizedAudioContainer = 'mp4';

    this.prioritizedVideoCodec = null;
    this.prioritizedAudioCodec = null;

    this.shouldPreferDRCAudio = true;

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
      prioritizedVideoCodec: this.prioritizedVideoCodec,
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
      this.prioritizedVideoCodec = prefs.prioritizedVideoCodec || null;
      this.prioritizedAudioCodec = prefs.prioritizedAudioCodec || null;
      this.shouldPreferDRCAudio = prefs.shouldPreferDRCAudio || false;
    } catch (e) {
      console.warn('Failed to load level manager preferences:', e);
    }
  }

  reset() {
    this.currentVideoLevelID = null;
    this.currentAudioLevelID = null;
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

  setPrioritizedVideoCodec(codec) {
    this.prioritizedVideoCodec = codec;
    this.savePreferences();
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
      if (currentLevel) {
        return currentLevel;
      }
    }

    // First, filter out incompatible levels
    availableLevels = availableLevels.filter((level) => {
      return (!level.videoCodec || this.isCodecSupported(level.videoCodec)) &&
                (!level.audioCodec || this.isCodecSupported(level.audioCodec));
    });

    // Next, pick language
    availableLevels = this.filterVideoLevelsByLanguage(availableLevels);


    // Sort by quality match
    desiredHeight = desiredHeight || this.getDesiredVideoHeight();
    availableLevels = this.matchQuality(availableLevels, desiredHeight);

    // Prioritize mp4 levels
    const containerLevels = availableLevels.filter((level) => {
      return this.isLevelContainerPrioritized(level);
    });

    if (containerLevels.length > 0 && containerLevels[0].height === availableLevels[0].height) {
      availableLevels = containerLevels;
    }

    // Prioritize codec
    const codecLevels = availableLevels.filter((level) => {
      return level.videoCodec && this.prioritizedVideoCodec && level.videoCodec === this.prioritizedVideoCodec;
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

    // Sort by match level descending
    matched.sort((a, b) => b.matchLevel - a.matchLevel);
    return matched.map((item) => item.level);
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

    // Sort by match level descending
    matched.sort((a, b) => b.matchLevel - a.matchLevel);
    return matched.map((item) => item.level);
  }
}
