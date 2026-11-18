// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';

// The offer to turn MPV mode on once the mpv host answers "mpv found". It is not between the
// update banner's SPLICER:NO_UPDATE_CHECKER markers: the AMO build has it too. The host is asked
// at most once, when the page is first seen: the options page is an iframe in every player.

export const MpvSuggestionDismissedKey = 'mpvSuggestionDismissed';

export class MpvSuggestion {
  /**
   * @param {Object} parts
   * @param {HTMLElement} parts.box - The banner, hidden until shown.
   * @param {HTMLElement} parts.text - Its text.
   * @param {HTMLElement} parts.enableButton - "Turn on MPV mode".
   * @param {HTMLElement} parts.dismissLink - "Dismiss" (after the button: "Close").
   * @param {() => boolean} parts.isMpvModeOn - Whether MPV mode is on in the options.
   * @param {() => void} parts.turnOnMpvMode - Turns it on, as its checkbox does.
   */
  constructor({box, text, enableButton, dismissLink, isMpvModeOn, turnOnMpvMode}) {
    this.box = box;
    this.text = text;
    this.enableButton = enableButton;
    this.dismissLink = dismissLink;
    this.isMpvModeOn = isMpvModeOn;
    this.turnOnMpvMode = turnOnMpvMode;
    /** @type {'idle'|'checking'|'offered'|'taken'|'closed'} */
    this.state = 'idle';

    enableButton.addEventListener('click', () => this.take());
    dismissLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.dismiss();
    });
  }

  /**
   * @return {Promise<void>}
   */
  async check() {
    if (this.state !== 'idle') {
      return;
    }
    this.state = 'checking';
    if (this.isMpvModeOn() || await MpvSuggestion.wasDismissed()) {
      this.state = 'closed';
      return;
    }
    const answer = await MpvSuggestion.askHost();
    // MPV mode may have been turned on while the host was asked.
    if (this.state !== 'checking' || this.isMpvModeOn() || !answer || !answer.ok || !answer.mpv) {
      this.state = 'closed';
      return;
    }
    this.state = 'offered';
    this.box.hidden = false;
  }

  /**
   * MPV mode turned on another way, or off again after the offer was taken, closes it.
   */
  optionsChanged() {
    if ((this.state === 'offered' && this.isMpvModeOn()) ||
        (this.state === 'taken' && !this.isMpvModeOn())) {
      this.close();
    }
  }

  take() {
    if (this.state !== 'offered') {
      return;
    }
    this.state = 'taken';
    this.turnOnMpvMode();
    MpvSuggestion.remember();
    this.text.textContent = Localize.getMessage('options_mpv_suggest_done');
    this.enableButton.hidden = true;
    this.dismissLink.textContent = Localize.getMessage('options_mpv_suggest_close');
  }

  dismiss() {
    if (this.state === 'offered') {
      MpvSuggestion.remember();
    }
    this.close();
  }

  close() {
    this.state = 'closed';
    this.box.hidden = true;
  }

  /**
   * @return {Promise<boolean>} Whether the offer was dismissed or taken before.
   */
  static wasDismissed() {
    return new Promise((resolve) => {
      chrome.storage.local.get(MpvSuggestionDismissedKey, (result) => {
        resolve(!!(result && result[MpvSuggestionDismissedKey]));
      });
    });
  }

  static remember() {
    chrome.storage.local.set({[MpvSuggestionDismissedKey]: true});
  }

  /**
   * @return {Promise<?{ok: boolean, mpv?: boolean}>}
   */
  static askHost() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({type: MessageTypes.MPV_TEST}, (response) => {
          resolve(chrome.runtime.lastError || !response ? null : response);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }
}
