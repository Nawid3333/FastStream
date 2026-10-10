import {Localize} from '../../modules/Localize.mjs';
import {EventEmitter} from '../../modules/eventemitter.mjs';
import {DOMElements} from '../DOMElements.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';

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

    DOMElements.audioSourceList.style.display = '';
    if (!dontSetStayVisible) {
      this.stayOpen = true;
    }
  }

  closeUI() {
    if (!this.isOpen()) {
      return false;
    }
    DOMElements.audioSourceList.style.display = 'none';
    this.stayOpen = false;
    return true;
  }

  isOpen() {
    return DOMElements.audioSourceList.style.display !== 'none';
  }

  setupUI() {
    // Its click opened the audio settings window, its right click this list; since the
    // window went (2026-10-10), both open the list.
    WebUtils.setupTabIndex(DOMElements.audioTracksBtn);
    DOMElements.audioTracksBtn.addEventListener('click', (e) => {
      if (this.isOpen() || !this.enabled) {
        this.closeUI();
      } else {
        this.openUI();
      }
      e.stopPropagation();
    });

    let isMouseDown = false;
    DOMElements.audioTracksBtn.addEventListener('mousedown', (e) => {
      isMouseDown = true;
    }, true);

    DOMElements.audioTracksBtn.addEventListener('mouseup', (e) => {
      isMouseDown = false;
    }, true);

    DOMElements.audioTracksBtn.addEventListener('contextmenu', (e) => {
      if (this.isOpen() || !this.enabled) {
        this.closeUI();
      } else {
        this.openUI();
      }
      e.stopPropagation();
      e.preventDefault();
    });

    DOMElements.audioTracksBtn.addEventListener('focus', ()=>{
      if ( this.enabled &&!this.isOpen() && !isMouseDown) {
        this.openUI(true);
      }
    });

    DOMElements.audioTracksBtn.addEventListener('blur', ()=>{
      isMouseDown = false;
      if (!this.stayOpen) {
        this.closeUI();
      }

      const candidates = Array.from(DOMElements.audioSourceList.children);
      let current = candidates.find((el) => el.classList.contains('candidate'));
      if (!current) {
        current = candidates.find((el) => el.classList.contains('source_active'));
      }

      if (!current) {
        return;
      }

      current.classList.remove('candidate');
    });

    DOMElements.audioTracksBtn.addEventListener('keydown', (e) => {
      // The button keeps the focus after a click; with the list closed, its keys are the
      // player's again (the arrows are the volume), not a choice in a list no one sees.
      if (!this.isOpen()) return;
      const candidates = Array.from(DOMElements.audioSourceList.children);
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
        current.click();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    DOMElements.audioSourceList.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    DOMElements.audioSourceList.addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });
  }

  updateQualityLevels(client) {
    const audioLevels = client.getLevelManager().filterAudioLevelsByLanguage(Array.from(client.getAudioLevels().values()));
    this.hasChoice = !!audioLevels && audioLevels.length > 1;
    DOMElements.audioTracksBtn.classList.toggle('hidden', !this.hasChoice);
    if (!audioLevels || audioLevels.length < 1) {
      this.enabled = false;
      // An open list kept the previous video's tracks (final review, 2026-10-10).
      DOMElements.audioSourceList.replaceChildren();
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

    DOMElements.audioSourceList.replaceChildren();

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

        Array.from(DOMElements.audioSourceList.getElementsByClassName('source_active')).forEach((element) => {
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

      DOMElements.audioSourceList.appendChild(levelelement);
    });
  }
}
