// @ts-check
import {Localize} from '../../modules/Localize.mjs';
import {EventEmitter} from '../../modules/eventemitter.mjs';
import {DOMElements} from '../DOMElements.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';

/** @typedef {import('../../players/Levels.mjs').AudioLevel} AudioLevel */
export class AudioQualityChanger extends EventEmitter {
  constructor() {
    super();
    this.stayOpen = false;
    this.enabled = false;
    // More than one track: the button shows then, and whenever the audio output can be
    // chosen (setOutputDevice).
    this.hasChoice = false;
    /** @type {?import('../audio/AudioOutputDevice.mjs').AudioOutputDevice} */
    this.outputDevice = null;
    /** @type {?((e: *) => void)} A refused choice or a failed switch is said here. */
    this.onOutputError = null;
    /** @type {Array<HTMLElement>} The output part's rows, kept to draw the part again in place. */
    this.outputItems = [];
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
        // The output part's header is no choice of its own: the walk steps over it.
        const next = this.nextItem(candidates, index, 1);
        next.classList.add('candidate');
        // scroll into view
        next.scrollIntoView({block: 'nearest'});
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'ArrowUp') {
        current.classList.remove('candidate');
        const next = this.nextItem(candidates, index, -1);
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
  * @param {import('../../FastStreamClient.mjs').FastStreamClient} client
  */
  updateQualityLevels(client) {
    const audioLevels = client.getLevelManager().filterAudioLevelsByLanguage(Array.from(client.getAudioLevels().values()));
    const canChooseOutput = !!this.outputDevice?.isSupported();
    this.hasChoice = !!audioLevels && audioLevels.length > 1;
    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).classList.toggle('hidden', !this.hasChoice && !canChooseOutput);
    // With one track (and no output to choose) the button hides, and an open list stayed
    // open under no button.
    if (!this.hasChoice && !canChooseOutput) {
      this.closeUI();
    }
    if (!audioLevels || audioLevels.length < 1) {
      if (canChooseOutput) {
        // No tracks, but the output is a choice: the last video's tracks go, the output
        // part stays.
        this.enabled = true;
        /** @type {HTMLElement} */ (DOMElements.audioSourceList).replaceChildren();
        this.renderOutputs();
        return;
      }
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

    this.renderOutputs();
  }

  /**
   * The device the output part chooses with (AudioOutputDevice), and where its failures go.
   * @param {import('../audio/AudioOutputDevice.mjs').AudioOutputDevice} device
   * @param {(e: *) => void} onError
   */
  setOutputDevice(device, onError) {
    this.outputDevice = device;
    this.onOutputError = onError;
    this.renderOutputs();
  }

  /**
   * The "Audio output" part, after the tracks: a header, the system's default output, the
   * device chosen (when there is one), and "Choose an output..." for Firefox's own chooser.
   * The row playing is marked as a track's is. Drawn again in place, the tracks untouched.
   */
  renderOutputs() {
    this.outputItems.forEach((element) => element.remove());
    this.outputItems = [];
    const device = this.outputDevice;
    if (!device?.isSupported()) return;
    const list = /** @type {HTMLElement} */ (DOMElements.audioSourceList);
    const header = document.createElement('div');
    header.classList.add('fluid_audio_source_list_header');
    header.textContent = Localize.getMessage('player_audio_output_label');
    // No choice of its own: a click on it is no click on the video either.
    header.addEventListener('click', (e) => e.stopPropagation());
    this.outputItems.push(header);
    this.outputItems.push(this.makeOutputItem(Localize.getMessage('player_audio_output_default'), !device.playing,
        () => device.useDefault()));
    if (device.choice) {
      const chosen = device.choice;
      this.outputItems.push(this.makeOutputItem(chosen.label || chosen.deviceId, device.playing === chosen,
          // Not playing (gone or not allowed at the start): the chooser again, with it picked.
          () => (device.playing === chosen ? Promise.resolve() : device.choose())));
    }
    this.outputItems.push(this.makeOutputItem(Localize.getMessage('player_audio_output_choose'), false,
        () => device.choose()));
    this.outputItems.forEach((element) => list.appendChild(element));
    // A list with the output part is one to open, tracks or none.
    /** @type {HTMLElement} */ (DOMElements.audioTracksBtn).classList.remove('hidden');
    this.enabled = true;
  }

  /**
   * A row of the output part, built as a track's. Its click runs the switch in the click
   * itself (Firefox's chooser needs the user's click), draws the part again when it is done,
   * and gives a failure to onOutputError.
   * @param {string} label
   * @param {boolean} active
   * @param {() => Promise<*>} action
   * @return {HTMLElement}
   */
  makeOutputItem(label, active, action) {
    const item = document.createElement('div');
    item.classList.add('fluid_audio_source_list_item');
    if (active) item.classList.add('source_active');
    const text = document.createElement('span');
    text.textContent = active ? label + ' ' + Localize.getMessage('player_quality_current') : label;
    item.appendChild(text);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      action().then(() => this.renderOutputs(), (error) => {
        this.renderOutputs();
        this.onOutputError?.(error);
      });
    });
    return item;
  }

  /**
   * The row above or below one, wrapping, past the output part's header.
   * @param {Array<Element>} candidates
   * @param {number} index
   * @param {number} step - 1 down, -1 up.
   * @return {Element}
   */
  nextItem(candidates, index, step) {
    const count = candidates.length;
    let next = (index + step + count) % count;
    while (next !== index && candidates[next].classList.contains('fluid_audio_source_list_header')) {
      next = (next + step + count) % count;
    }
    return candidates[next];
  }
}
