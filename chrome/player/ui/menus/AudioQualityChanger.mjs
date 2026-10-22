// @ts-check
import {Localize} from '../../modules/Localize.mjs';
import {EventEmitter} from '../../modules/eventemitter.mjs';
import {DOMElements} from '../DOMElements.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';

/** @typedef {{id: string, bitrate: number, mimeType?: string, audioCodec?: string, language?: string}} AudioLevel */
export class AudioQualityChanger extends EventEmitter {
  constructor() {
    super();
    this.stayOpen = false;
    this.enabled = false;
    // More than one track: the button shows only then.
    this.hasChoice = false;
  }

  openUI(dontSetStayVisible = false) {
    this.emit('open', {
      target: DOMElements.audioTracksBtn,
    });

    /** @type {HTMLElement} */ (DOMElements.audioSourceList).style.display = '';
    if (!dontSetStayVisible) {
      this.stayOpen = true;
    }
  }

  closeUI() {
    if (!this.isOpen()) {
      return false;
    }
    /** @type {HTMLElement} */ (DOMElements.audioSourceList).style.display = 'none';
    this.stayOpen = false;
    return true;
  }

  isOpen() {
    return /** @type {HTMLElement} */ (DOMElements.audioSourceList).style.display !== 'none';
  }

  setupUI() {
    // Its click opened the audio settings window, its right click this list; since the
    // window went (2026-10-10), both open the list.
    WebUtils.setupTabIndex(/** @type {HTMLElement} */ (DOMElements.audioTracksBtn));
    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).addEventListener('click', (e) => {
      if (this.isOpen() || !this.enabled) {
        this.closeUI();
      } else {
        this.openUI();
      }
      e.stopPropagation();
    });

    let isMouseDown = false;
    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).addEventListener('mousedown', (e) => {
      isMouseDown = true;
    }, true);

    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).addEventListener('mouseup', (e) => {
      isMouseDown = false;
    }, true);

    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).addEventListener('contextmenu', (e) => {
      if (this.isOpen() || !this.enabled) {
        this.closeUI();
      } else {
        this.openUI();
      }
      e.stopPropagation();
      e.preventDefault();
    });

    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).addEventListener('focus', ()=>{
      if ( this.enabled &&!this.isOpen() && !isMouseDown) {
        this.openUI(true);
      }
    });

    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).addEventListener('blur', ()=>{
      isMouseDown = false;
      if (!this.stayOpen) {
        this.closeUI();
      }

      const candidates = Array.from(/** @type {HTMLElement} */ (DOMElements.audioSourceList).children);
      let current = candidates.find((el) => el.classList.contains('candidate'));
      if (!current) {
        current = candidates.find((el) => el.classList.contains('source_active'));
      }

      if (!current) {
        return;
      }

      current.classList.remove('candidate');
    });

    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).addEventListener('keydown', (e) => {
      // The button keeps the focus after a click; with the list closed, its keys are the
      // player's again (the arrows are the volume), not a choice in a list no one sees.
      if (!this.isOpen()) return;
      const candidates = Array.from(/** @type {HTMLElement} */ (DOMElements.audioSourceList).children);
      let current = candidates.find((el) => el.classList.contains('candidate'));
      if (!current) {
        current = candidates.find((el) => el.classList.contains('source_active'));
      }
      if (!current || !this.enabled) {
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
        // The track playing already: nothing to choose, and the key is not the player's
        // either (it reached its Enter binding).
        if (current.classList.contains('source_active')) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        /** @type {HTMLElement} */ (current).click();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    /** @type {HTMLElement} */ (DOMElements.audioSourceList).addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    /** @type {HTMLElement} */ (DOMElements.audioSourceList).addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });
  }

 /**
  * @param {{getLevelManager: () => {filterAudioLevelsByLanguage: (levels: AudioLevel[]) => AudioLevel[]}, getAudioLevels: () => Map<string, AudioLevel>, getCurrentAudioLevelID: () => string}} client
  */
 updateQualityLevels(client) {
    const audioLevels = client.getLevelManager().filterAudioLevelsByLanguage(Array.from(client.getAudioLevels().values()));
    this.hasChoice = !!audioLevels && audioLevels.length > 1;
    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).classList.toggle('hidden', !this.hasChoice);
    // With one track the button hides, and an open list stayed open under no button.
    if (!this.hasChoice) {
      this.closeUI();
    }
    if (!audioLevels || audioLevels.length < 1) {
      this.enabled = false;
      // An open list kept the previous video's tracks (final review, 2026-10-10).
      /** @type {HTMLElement} */ (DOMElements.audioSourceList).replaceChildren();
      this.closeUI();
      return;
    } else {
      this.enabled = true;
    }

    // sort levels by bitrate ascending
    audioLevels.sort((a, b) => {
      return a.bitrate - b.bitrate;
    });

    const currentAudioLevelID = client.getCurrentAudioLevelID();

    /** @type {HTMLElement} */ (DOMElements.audioSourceList).replaceChildren();

    audioLevels.forEach((level) => {
      const levelelement = document.createElement('div');

      levelelement.classList.add('fluid_audio_source_list_item');
      levelelement.addEventListener('click', (e) => {
        // if already active, do nothing
        const currentLevelID = client.getCurrentAudioLevelID();
        if (level.id === currentLevelID) {
          e.stopPropagation();
          return;
        }

        Array.from(/** @type {HTMLElement} */ (DOMElements.audioSourceList).getElementsByClassName('source_active')).forEach((element) => {
          element.classList.remove('source_active');
        });
        this.emit('qualityChanged', level);
        levelelement.classList.add('source_active');
        e.stopPropagation();
      });

      const isLevelActive = (level.id === currentAudioLevelID);
      if (isLevelActive) {
        levelelement.classList.add('source_active');
      }

      const icon = document.createElement('span');
      icon.classList.add('source_button_icon');

      const text = document.createElement('span');
      const mimeParts = level.mimeType ? level.mimeType.split('/') : [];
      const container = (mimeParts.length >= 2) ? mimeParts[1] : '';

      const label = `${container}${level.id.includes('-drc') ? ' [DRC]' : ''} @${Math.round(level.bitrate / 1000)} kbps`;

      text.textContent = isLevelActive ? label + ' ' + Localize.getMessage('player_quality_current') : label;

      const titleParts = [];
      titleParts.push(`ID: ${level.id}`);
      if (container) {
        titleParts.push(`Container: ${container}`);
      }
      titleParts.push(`Bitrate: ${level.bitrate + ' bps'}`);
      if (level.audioCodec) {
        titleParts.push(`Audio codec: ${level.audioCodec}`);
      }
      if (level.language) {
        titleParts.push(`Language: ${level.language}`);
      }
      levelelement.title = titleParts.join('\n');

      levelelement.appendChild(text);

      /** @type {HTMLElement} */ (DOMElements.audioSourceList).appendChild(levelelement);
    });
  }
}
