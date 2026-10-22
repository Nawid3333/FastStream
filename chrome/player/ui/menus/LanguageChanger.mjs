// @ts-check
import {Localize} from '../../modules/Localize.mjs';
import {EventEmitter} from '../../modules/eventemitter.mjs';
import {DOMElements} from '../DOMElements.mjs';

export class LanguageChanger extends EventEmitter {
  constructor() {
    super();
    this.stayOpen = false;
  }

  openUI(dontSetStayVisible = false) {
    this.emit('open', {
      target: DOMElements.languageButton,
    });

    /** @type {HTMLElement} */ (DOMElements.languageMenu).style.display = '';
    if (!dontSetStayVisible) {
      this.stayOpen = true;
    }
  }

  closeUI() {
    if (/** @type {HTMLElement} */ (DOMElements.languageMenu).style.display === 'none') {
      return false;
    }
    /** @type {HTMLElement} */ (DOMElements.languageMenu).style.display = 'none';
    this.stayOpen = false;
    return true;
  }

  isOpen() {
    return /** @type {HTMLElement} */ (DOMElements.languageMenu).style.display !== 'none';
  }

  setupUI() {
    /** @type {HTMLElement} */ (DOMElements.languageButton).tabIndex = 0;

    let isMouseDown = false;
    /** @type {HTMLElement} */ (DOMElements.languageButton).addEventListener('mousedown', (e) => {
      isMouseDown = true;
    }, true);

    /** @type {HTMLElement} */ (DOMElements.languageButton).addEventListener('mouseup', (e) => {
      isMouseDown = false;
    }, true);

    /** @type {HTMLElement} */ (DOMElements.languageButton).addEventListener('click', (e) => {
      if (this.isOpen()) {
        this.closeUI();
      } else {
        this.openUI();
      }
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.languageButton).addEventListener('focus', () => {
      if (!this.isOpen() && !isMouseDown) {
        this.openUI(true);
      }
    });

    /** @type {HTMLElement} */ (DOMElements.languageButton).addEventListener('blur', () => {
      isMouseDown = false;
      if (!this.stayOpen) {
        this.closeUI();
      }

      const candidates = Array.from(/** @type {HTMLElement} */ (DOMElements.languageMenu).getElementsByClassName('language_track'));
      let current = candidates.find((el) => el.classList.contains('candidate'));
      if (!current) {
        current = candidates.find((el) => el.classList.contains('active'));
      }
      if (!current) {
        return;
      }
      current.classList.remove('candidate');
    });
    /** @type {HTMLElement} */ (DOMElements.languageButton).addEventListener('keydown', (e) => {
      // The button keeps the focus after a click closes the menu; its keys are then the
      // player's again (the arrows are the volume), not a choice in a menu no one sees.
      if (!this.isOpen()) return;
      // A filler is the empty cell of a language that has no track of that type.
      const candidates = Array.from(/** @type {HTMLElement} */ (DOMElements.languageMenu).getElementsByClassName('language_track'))
          .filter((el) => !el.classList.contains('language_track_filler'));
      let current = candidates.find((el) => el.classList.contains('candidate'));
      if (!current) {
        current = candidates.find((el) => el.classList.contains('active'));
      }
      if (!current) {
        return;
      }

      const index = candidates.indexOf(current);
      if (e.key === 'ArrowDown') {
        current.classList.remove('candidate');
        if (index < candidates.length - 1) {
          candidates[index + 1].classList.add('candidate');
          candidates[index + 1].scrollIntoView({block: 'nearest'});
        } else {
          candidates[0].classList.add('candidate');
          candidates[0].scrollIntoView({block: 'nearest'});
        }
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'ArrowUp') {
        current.classList.remove('candidate');
        if (index > 0) {
          candidates[index - 1].classList.add('candidate');
          candidates[index - 1].scrollIntoView({block: 'nearest'});
        } else {
          candidates[candidates.length - 1].classList.add('candidate');
          candidates[candidates.length - 1].scrollIntoView({block: 'nearest'});
        }
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'Enter') {
        /** @type {HTMLElement} */ (current).click();
        e.preventDefault();
        e.stopPropagation();
      }
    });

    /** @type {HTMLElement} */ (DOMElements.languageMenu).addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.languageMenu).addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.languageMenu).addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });
  }

  groupLevelsByLanguage(levels) {
    const languageMap = new Map();
    // None yet (a player still loading): the quality menu checks for that, and this threw.
    levels?.forEach((level) => {
      const lang = level.language;
      if (!languageMap.has(lang)) {
        languageMap.set(lang, []);
      }
      languageMap.get(lang).push(level);
    });
    return languageMap;
  }

  updateLanguageTracks(client) {
    const videoLevels = client.getVideoLevels();
    const audioLevels = client.getAudioLevels();

    const videoLanguageMap = this.groupLevelsByLanguage(videoLevels);
    const audioLanguageMap = this.groupLevelsByLanguage(audioLevels);

    const currentVideoLevelID = client.getLevelManager().getCurrentVideoLevelID();
    const currentAudioLevelID = client.getLevelManager().getCurrentAudioLevelID();

    if (videoLanguageMap.size < 2 && audioLanguageMap.size < 2) {
      /** @type {HTMLElement} */ (DOMElements.languageButton).classList.add('hidden');
      // An open menu stayed with the previous video's languages (review of 2026-10-14), as
      // the audio menu once did.
      /** @type {HTMLElement} */ (DOMElements.languageMenu).replaceChildren();
      this.closeUI();
      return;
    } else {
      /** @type {HTMLElement} */ (DOMElements.languageButton).classList.remove('hidden');
    }

    /** @type {HTMLElement} */ (DOMElements.languageMenu).replaceChildren();
    const languageTable = document.createElement('div');
    languageTable.classList.add('language_table');
    /** @type {HTMLElement} */ (DOMElements.languageMenu).appendChild(languageTable);

    const languages = [];
    const hasVideoLanguages = videoLanguageMap.size > 1;
    const hasAudioLanguages = audioLanguageMap.size > 1;
    if (hasVideoLanguages) {
      videoLanguageMap.forEach((tracks, lang) => {
        if (!languages.includes(lang)) {
          languages.push(lang);
        }
      });
    }

    if (hasAudioLanguages) {
      audioLanguageMap.forEach((tracks, lang) => {
        if (!languages.includes(lang)) {
          languages.push(lang);
        }
      });
    }

    languages.sort();

    const regionNames = new Intl.DisplayNames([
      navigator.language,
    ], {type: 'language'});

    languages.forEach((language) => {
      const languageElement = document.createElement('div');
      languageElement.classList.add('language_container');
      languageTable.appendChild(languageElement);

      const languageText = document.createElement('div');
      languageText.classList.add('language_text');
      try {
        languageText.textContent = /** @type {string} */ (regionNames.of(language));
      } catch (e) {
        languageText.textContent = language || 'Unknown';
      }
      languageElement.appendChild(languageText);

      const videoTracks = videoLanguageMap.get(language) || [];
      const audioTracks = audioLanguageMap.get(language) || [];
      const trackElements = ([videoTracks, audioTracks]).map((tracks, i) => {
        const type = (i === 0) ? 'video' : 'audio';

        if (type === 'video' && !hasVideoLanguages) return;
        if (type === 'audio' && !hasAudioLanguages) return;

        if (tracks.length === 0) {
          // filler element to keep layout consistent
          const filler = document.createElement('div');
          filler.classList.add('language_track');
          filler.classList.add('language_track_filler');
          languageElement.appendChild(filler);
          return;
        }


        const trackElement = document.createElement('div');
        trackElement.classList.add('language_track');
        trackElement.dataset.type = type;
        trackElement.textContent = Localize.getMessage('player_languagemenu_' + type);
        // "Unknown" as the row's text says: a track without a language was read out as "undefined".
        trackElement.setAttribute('aria-label', Localize.getMessage('player_languagemenu_' + type) + ': ' + (language || 'Unknown'));
        const currentLevelID = type === 'video' ? currentVideoLevelID : currentAudioLevelID;
        if (tracks.some((level) => level.id === currentLevelID)) {
          trackElement.classList.add('active');
        }
        languageElement.appendChild(trackElement);
        trackElement.addEventListener('click', (e) => {
          /** @type {HTMLElement[]} */ (Array.from(/** @type {HTMLElement} */ (DOMElements.languageMenu).getElementsByClassName('active'))).forEach((element) => {
            if (element.dataset.type === type) {
              element.classList.remove('active');
            }
          });

          trackElement.classList.add('active');
          this.emit('languageChanged', type, language, tracks);
          e.stopPropagation();
        });
        return trackElement;
      });
      languageElement.addEventListener('click', (e) => {
        trackElements.forEach((element) => {
          if (element) {
            element.click();
          }
        });
        e.stopPropagation();
      });
    });
  }
}
