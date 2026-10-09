import {Localize} from '../modules/Localize.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';

/**
 * The options page's offer to turn MPV mode on, once the mpv host answers.
 *
 * mpv-config's one-click setup for Windows installs mpv and this extension's mpv host
 * (the "helper") and opens the add-on in Firefox, but MPV mode stays off until the user
 * ticks it here. When it is off and the host answers "mpv found" (the MPV_TEST message
 * the "Test mpv connection" button sends), a banner says so, with a button that turns
 * MPV mode on and a link that dismisses the offer for good (storage.local, like the
 * update banner's ignored version).
 *
 * Unlike the update banner it is not between SPLICER:NO_UPDATE_CHECKER markers, so the
 * AMO build (the signed .xpi) has it too.
 *
 * The host is asked at most once per page, and only when the page is first seen
 * (`check()`): the options page is also an iframe in every player, and a player whose
 * settings are never opened should not start the host. It is never asked once the offer
 * was dismissed or taken, or while MPV mode is on.
 */

/** The storage.local key that records a dismissed (or taken) offer. */
export const MpvSuggestionDismissedKey = 'mpvSuggestionDismissed';

export class MpvSuggestion {
  /**
   * @param {Object} parts
   * @param {HTMLElement} parts.box - The banner, hidden until shown.
   * @param {HTMLElement} parts.text - Its text.
   * @param {HTMLElement} parts.enableButton - "Turn on MPV mode".
   * @param {HTMLElement} parts.dismissLink - "Dismiss" (after the button: "Close").
   * @param {function(): boolean} parts.isMpvModeOn - Whether MPV mode is on in the options.
   * @param {function(): void} parts.turnOnMpvMode - Turns it on, as its checkbox does.
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
   * Asks the host, once, and offers MPV mode when it found mpv and the mode is off.
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
   * The options changed (on this page or elsewhere): MPV mode turned on another way
   * makes the offer moot.
   */
  optionsChanged() {
    if (this.state === 'offered' && this.isMpvModeOn()) {
      this.close();
    }
  }

  /** The button: MPV mode on, and where to go from here. */
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

  /** The link: no offer again, on this page or any other. */
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
   * The background's MPV_TEST answer, or null when there is none.
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
