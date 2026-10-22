// @ts-check
import {Localize} from '../../modules/Localize.mjs';
import {EventEmitter} from '../../modules/eventemitter.mjs';
import {getCodecDisplayName, getDecodingLabel} from '../../players/DecodingCapabilities.mjs';
import {DOMElements} from '../DOMElements.mjs';

const DECODING_MESSAGES = {
  hardware: {badge: 'player_quality_hw', title: 'player_quality_hw_title'},
  software: {badge: 'player_quality_sw', title: 'player_quality_sw_title'},
};

/**
 * "HW" or "SW" after a quality: whether Firefox decodes that version in hardware.
 * @param {Object} level
 * @return {HTMLElement|null} null when Firefox gave no answer.
 */
function makeDecodingBadge(level) {
  const label = getDecodingLabel(level?.decoding);
  if (!label) {
    return null;
  }
  const badge = document.createElement('span');
  badge.classList.add('quality_decode_badge', label);
  badge.textContent = Localize.getMessage(DECODING_MESSAGES[label].badge);
  badge.title = Localize.getMessage(DECODING_MESSAGES[label].title);
  return badge;
}

/**
 * @param {Object} level
 * @return {string|null} The tooltip line saying how the version is decoded.
 */
function decodingTitle(level) {
  const label = getDecodingLabel(level?.decoding);
  return label ? Localize.getMessage(DECODING_MESSAGES[label].title) : null;
}

export class VideoQualityChanger extends EventEmitter {
  constructor() {
    super();
    this.stayOpen = false;
  }

  openUI(dontSetStayVisible = false) {
    this.emit('open', {
      target: DOMElements.videoSource,
    });

    /** @type {HTMLElement} */ (DOMElements.videoSourceList).style.display = '';
    if (!dontSetStayVisible) {
      this.stayOpen = true;
    }
  }

  closeUI() {
    if (!this.isOpen()) {
      return false;
    }
    /** @type {HTMLElement} */ (DOMElements.videoSourceList).style.display = 'none';
    this.stayOpen = false;
    return true;
  }

  isOpen() {
    return /** @type {HTMLElement} */ (DOMElements.videoSourceList).style.display !== 'none';
  }

  setupUI() {
    /** @type {HTMLElement} */ (DOMElements.videoSource).tabIndex = 0;

    let isMouseDown = false;
    /** @type {HTMLElement} */ (DOMElements.videoSource).addEventListener('mousedown', (e) => {
      isMouseDown = true;
    }, true);

    /** @type {HTMLElement} */ (DOMElements.videoSource).addEventListener('mouseup', (e) => {
      isMouseDown = false;
    }, true);

    /** @type {HTMLElement} */ (DOMElements.videoSource).addEventListener('click', (e) => {
      if (this.isOpen()) {
        this.closeUI();
      } else {
        this.openUI();
      }
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.videoSource).addEventListener('focus', () => {
      if (!this.isOpen() && !isMouseDown) {
        this.openUI(true);
      }
    });

    /** @type {HTMLElement} */ (DOMElements.videoSource).addEventListener('blur', () => {
      isMouseDown = false;
      if (!this.stayOpen) {
        this.closeUI();
      }

      const candidates = Array.from(/** @type {HTMLElement} */ (DOMElements.videoSourceList).children);
      let current = candidates.find((el) => el.classList.contains('candidate'));
      if (!current) {
        current = candidates.find((el) => el.classList.contains('source_active'));
      }

      if (!current) {
        return;
      }

      current.classList.remove('candidate');
    });

    /** @type {HTMLElement} */ (DOMElements.videoSource).addEventListener('keydown', (e) => {
      // The button keeps the focus after a click closes the list; its keys are then the
      // player's again (the arrows are the volume), not a choice in a list no one sees.
      if (!this.isOpen()) return;
      const candidates = Array.from(/** @type {HTMLElement} */ (DOMElements.videoSourceList).children);
      let current = candidates.find((el) => el.classList.contains('candidate'));
      if (!current) {
        current = candidates.find((el) => el.classList.contains('source_active'));
      }
      if (!current) {
        return;
      }

      const index = candidates.indexOf(current);
      if (e.key === 'ArrowDown') {
        current.classList.remove('candidate');
        const next = (index < candidates.length - 1) ? candidates[index + 1] : candidates[0];
        next.classList.add('candidate');
        // scroll into view
        next.scrollIntoView({block: 'nearest'});
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'ArrowUp') {
        current.classList.remove('candidate');
        const next = (index > 0) ? candidates[index - 1] : candidates[candidates.length - 1];
        next.classList.add('candidate');
        // scroll into view
        next.scrollIntoView({block: 'nearest'});
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'Enter') {
        /** @type {HTMLElement} */ (current).click();
        e.preventDefault();
        e.stopPropagation();
      }
    });

    /** @type {HTMLElement} */ (DOMElements.videoSourceList).addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.videoSourceList).addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });
  }

  groupLevelsByDimensions(levels) {
    const map = new Map();
    levels.forEach((level) => {
      // Levels that name a distinct source stay in their own group even when they share
      // dimensions with another source, since picking between them is not a quality choice.
      const key = (level.label ? level.label + ' ' : '') + level.width + 'x' + level.height;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(level);
    });
    return map;
  }

  updateQualityLevels(client) {
    // The page's own qualities when it offers its file in several (FastStreamClient.getMenuVideoLevels).
    const videoLevels = client.getMenuVideoLevels();
    if (!videoLevels || videoLevels.size < 1) {
      /** @type {HTMLElement} */ (DOMElements.videoSource).classList.add('hidden');
      // An open list stayed open under no button, with the last video's qualities - a
      // click on one asked this video for a level it does not have (as the audio menu did).
      /** @type {HTMLElement} */ (DOMElements.videoSourceList).replaceChildren();
      this.closeUI();
      return;
    } else {
      /** @type {HTMLElement} */ (DOMElements.videoSource).classList.remove('hidden');
    }

    const videoLevelsByDimensions = this.groupLevelsByDimensions(client.getLevelManager().filterVideoLevelsByLanguage(Array.from(videoLevels.values())));
    const currentVideoLevelID = client.getMenuVideoLevelID();

    /** @type {HTMLElement} */ (DOMElements.videoSourceList).replaceChildren();

    videoLevelsByDimensions.forEach((levels) => {
      const isLevelActive = levels.some((level) => level.id === currentVideoLevelID);

      let dimensions = `${levels[0].width}x${levels[0].height}`;
      if (dimensions === '0x0') {
        if (isLevelActive && client.videoWidth > 0 && client.videoHeight > 0) {
          dimensions = `${client.videoWidth}x${client.videoHeight}`;
        } else if (levels[0].label) {
          // A label alone ("HQ", one of the page's qualities): no "Unknown" beside it.
          dimensions = levels[0].label;
        } else {
          dimensions = Localize.getMessage('player_quality_unknown');
        }
      } else if (levels[0].width === 0) {
        // A height alone: one of the page's qualities before the video's shape is known.
        dimensions = `${levels[0].height}p`;
      }

      if (levels[0].label && levels[0].label !== dimensions) {
        dimensions = `${levels[0].label} ${dimensions}`;
      }
      const levelelement = document.createElement('div');

      levelelement.classList.add('fluid_video_source_list_item');
      levelelement.addEventListener('click', (e) => {
        const chosen = client.getLevelManager().pickVideoLevel(levels, null, true);
        if (!chosen) {
          console.warn('No level chosen');
          e.stopPropagation();
          return;
        }

        // if already active, do nothing
        const currentLevelID = client.getMenuVideoLevelID();
        if (chosen.id === currentLevelID) {
          e.stopPropagation();
          return;
        }

        Array.from(/** @type {HTMLElement} */ (DOMElements.videoSourceList).getElementsByClassName('source_active')).forEach((element) => {
          element.classList.remove('source_active');
        });
        // With the versions it was picked from: LevelManager.rememberVideoChoice saves a
        // codec only for a choice between codecs.
        this.emit('qualityChanged', chosen, levels.length <= 1, levels);
        levelelement.classList.add('source_active');
        e.stopPropagation();
      });

      if (isLevelActive && levels.length <= 1) {
        levelelement.classList.add('source_active');
      } else if (isLevelActive) {
        levelelement.classList.add('subsource_active');
      }

      // sort levels by bitrate ascending
      levels.sort((a, b) => a.bitrate - b.bitrate);

      const icon = document.createElement('span');
      icon.classList.add('source_button_icon');

      const text = document.createElement('span');
      // No bitrate where none is known (the page's own qualities, files of their own): "@0 kbps".
      const bitrateKnown = levels.some((level) => level.bitrate > 0);
      const label = `${dimensions}${(levels.length > 1 && isLevelActive) || !bitrateKnown ? '' : ` @${levels.length > 1 ? `${Math.round(levels[0].bitrate / 1000)}-${Math.round(levels[levels.length - 1].bitrate / 1000)}` : Math.round(levels[0].bitrate / 1000)} kbps`}`;

      text.textContent = (isLevelActive && levels.length <= 1) ? label + ' ' + Localize.getMessage('player_quality_current') : (isLevelActive ? (label + ' ▼') : label);

      const audioCodecSet = new Set();
      const videoCodecSet = new Set();
      const containerSet = new Set();
      const languageSet = new Set();
      levels.forEach((lvl) => {
        if (lvl.audioCodec) {
          audioCodecSet.add(lvl.audioCodec);
        }
        if (lvl.videoCodec) {
          videoCodecSet.add(lvl.videoCodec);
        }
        if (lvl.mimeType) {
          const mimeParts = lvl.mimeType.split('/');
          if (mimeParts.length >= 2) {
            containerSet.add(mimeParts[1]);
          }
        }
        if (lvl.language) {
          languageSet.add(lvl.language);
        }
      });

      const titleParts = [];
      titleParts.push(`IDs: ${levels.map((o) => o.id).join(', ')}`);
      if (containerSet.size > 0) {
        titleParts.push(`Containers: ${Array.from(containerSet).join(', ')}`);
      }
      titleParts.push(`Bitrate: ${levels.length > 1 ? levels.map((lvl) => lvl.bitrate).join(', ') + ' bps' : levels[0].bitrate + ' bps'}`);

      if (videoCodecSet.size > 0) {
        titleParts.push(`Video codecs: ${Array.from(videoCodecSet).join(', ')}`);
      }
      if (audioCodecSet.size > 0) {
        titleParts.push(`Audio codecs: ${Array.from(audioCodecSet).join(', ')}`);
      }
      if (languageSet.size > 0) {
        titleParts.push(`Languages: ${Array.from(languageSet).join(', ')}`);
      }
      if (dimensions !== '0x0') {
        titleParts.push(`Dimensions: ${dimensions}`);
      }
      // The version a click on this quality picks (and the one playing, if it is this one).
      const groupLevel = levels.find((level) => level.id === currentVideoLevelID) ||
        client.getLevelManager().pickVideoLevel(levels, null, true);
      const groupDecoding = decodingTitle(groupLevel);
      if (groupDecoding) {
        titleParts.push(groupDecoding);
      }
      levelelement.title = titleParts.join('\n');
      levelelement.appendChild(text);
      const groupBadge = makeDecodingBadge(groupLevel);
      if (groupBadge) {
        levelelement.appendChild(groupBadge);
      }

      /** @type {HTMLElement} */ (DOMElements.videoSourceList).appendChild(levelelement);

      if (levels.length > 1 && isLevelActive) {
        // Add sub-level elements
        levels.forEach((level) => {
          const subLevelElement = document.createElement('div');
          subLevelElement.classList.add('fluid_video_source_sublist_item');
          const mimeParts = level.mimeType ? level.mimeType.split('/') : [];
          const container = (mimeParts.length >= 2) ? mimeParts[1] : '';

          const isActive = level.id === currentVideoLevelID;
          if (isActive) {
            subLevelElement.classList.add('source_active');
          }

          const text = document.createElement('span');
          // The codec tells apart versions of one size that differ only in it.
          const codecName = getCodecDisplayName(level.videoCodec);
          const describe = [container, codecName].filter(Boolean).join(' ');
          text.textContent = `${describe} @${Math.round(level.bitrate / 1000)} kbps${level.id === currentVideoLevelID ? ' ' + Localize.getMessage('player_quality_current') : ''}`;
          const titleParts = [];
          titleParts.push(`ID: ${level.id}`);
          if (container) {
            titleParts.push(`Container: ${container}`);
          }
          titleParts.push(`Bitrate: ${level.bitrate} bps`);
          if (level.videoCodec) {
            titleParts.push(`Video codec: ${level.videoCodec}`);
          }
          if (level.audioCodec) {
            titleParts.push(`Audio codec: ${level.audioCodec}`);
          }
          if (level.language) {
            titleParts.push(`Language: ${level.language}`);
          }
          if (dimensions !== '0x0') {
            titleParts.push(`Dimensions: ${dimensions}`);
          }
          const levelDecoding = decodingTitle(level);
          if (levelDecoding) {
            titleParts.push(levelDecoding);
          }
          subLevelElement.title = titleParts.join('\n');
          subLevelElement.appendChild(text);
          const badge = makeDecodingBadge(level);
          if (badge) {
            subLevelElement.appendChild(badge);
          }

          subLevelElement.addEventListener('click', (e) => {
            // if already active, do nothing
            const currentLevelID = client.getMenuVideoLevelID();
            if (level.id === currentLevelID) {
              e.stopPropagation();
              return;
            }

            Array.from(/** @type {HTMLElement} */ (DOMElements.videoSourceList).getElementsByClassName('source_active')).forEach((element) => {
              element.classList.remove('source_active');
            });
            this.emit('qualityChanged', level, true, levels);
            subLevelElement.classList.add('source_active');
            e.stopPropagation();
          });
          /** @type {HTMLElement} */ (DOMElements.videoSourceList).appendChild(subLevelElement);
        });
      }
    });


    const current = videoLevels.get(currentVideoLevelID);
    if (!current) {
      console.warn('No current level');
      return;
    }
    let maxSize = Math.min(current.width, current.height);
    if (maxSize <= 0) {
      maxSize = Math.min(client.videoWidth, client.videoHeight);
    }

    const qualityList = {
      'sd': maxSize < 720,
      'hd': maxSize >= 720 && maxSize < 1080,
      'fhd': maxSize >= 1080 && maxSize < 1440,
      '2k': maxSize >= 1440 && maxSize < 2160,
      '4k': maxSize >= 2160 && maxSize < 4320,
      '8k': maxSize >= 4320,
    };

    for (const quality in qualityList) {
      if (!Object.hasOwn(qualityList, quality)) {
        continue;
      }

      // Find element with .quality-<quality> class
      const element = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (DOMElements.videoSource).querySelector(`.quality-${quality}`));
      if (!element) {
        console.warn('No element for quality', quality);
        continue;
      }

      if (qualityList[quality]) {
        element.style.display = 'inline-block';
      } else {
        element.style.display = '';
      }
    }
  }
}
