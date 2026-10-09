// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {EnvUtils} from './EnvUtils.mjs';

// The player's dialogs and toasts, with Firefox's own <dialog> (showModal) and popover, in
// place of sweetalert2 11.26.25 (until 2026-10-09: its 150 KB module, its stylesheet, and the
// changes the build made to both). Styles: assets/dialogs/dialogs.css.
//
// - Both open in the top layer, so they show over a player in fullscreen wherever they are in
//   the page; sweetalert2 had to be retargeted at the player for that.
// - A dialog leaves the page the moment it closes: no hide animation to wait for. One that
//   never ended once left an invisible sweetalert2 popup over the page, taking every click
//   (sweetalert2/sweetalert2#1841).
// - They are children of <body>, not of the player (.mainplayer), and their keys stop at
//   them: the player's Escape handler cancels the key (preventDefault), which would keep a
//   dialog open, and its keybinds would act on keys meant for the dialog.
// - Every text goes in as text (textContent): an error's message can quote the markup it
//   failed on.

const TOAST_MS = 3000;

// Ids of the dialogs' titles and texts (aria-labelledby, aria-describedby).
let lastId = 0;

// The mark inside each icon's circle.
const ICON_MARKS = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
  question: '?',
};

/**
 * @typedef {{isConfirmed: boolean, isDenied: boolean, isDismissed: boolean, value: (string|boolean|undefined)}} DialogResult
 */

/**
 * An element with a class and, when given, its text.
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @return {HTMLElement}
 */
function make(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

/**
 * The circle with an icon's mark.
 * @param {string} icon - success, error, warning, info or question.
 * @return {HTMLElement}
 */
function makeIcon(icon) {
  const element = make('div', `fs-dialog-icon fs-dialog-icon-${icon}`, ICON_MARKS[icon] || '');
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/**
 * Opens a modal dialog and waits for it to close: by a button, Escape, or a click beside it
 * (on its backdrop), as sweetalert2's closed.
 * @param {Object} options
 * @param {string} [options.icon]
 * @param {string} [options.title]
 * @param {string} [options.text]
 * @param {HTMLElement} [options.content] - Built from text.
 * @param {{type: string, value: string}} [options.input]
 * @param {string} options.confirmText
 * @param {string} [options.cancelText] - No cancel button without it.
 * @return {Promise<DialogResult>} value: the input's text, or true, once confirmed.
 */
function openDialog({icon, title, text, content, input, confirmText, cancelText}) {
  const dialog = /** @type {HTMLDialogElement} */ (make('dialog', 'fs-dialog'));
  const form = /** @type {HTMLFormElement} */ (make('form', 'fs-dialog-form'));
  form.method = 'dialog';
  if (icon) form.append(makeIcon(icon));
  // What a screen reader names the dialog by, and reads after its name.
  const said = (element, attribute) => {
    element.id = `fs-dialog-${++lastId}`;
    dialog.setAttribute(attribute, element.id);
    return element;
  };
  if (title) form.append(said(make('h2', 'fs-dialog-title', title), 'aria-labelledby'));
  if (text) form.append(said(make('p', 'fs-dialog-text', text), title ? 'aria-describedby' : 'aria-labelledby'));
  if (content) form.append(content);

  /** @type {?HTMLInputElement} */
  let field = null;
  if (input) {
    field = /** @type {HTMLInputElement} */ (make('input', 'fs-dialog-input'));
    field.type = input.type;
    field.value = input.value ?? '';
    // A URL is asked for to load something: an empty one is no answer (sweetalert2 refused
    // it too). The browser says why before the dialog closes.
    field.required = input.type === 'url';
    field.setAttribute('aria-label', text || title || '');
    form.append(field);
  }

  const buttons = make('div', 'fs-dialog-buttons');
  // First: Enter in the field submits with the first submit button (implicit submission).
  const confirm = /** @type {HTMLButtonElement} */ (make('button', 'fs-dialog-confirm', confirmText));
  confirm.type = 'submit';
  confirm.value = 'confirm';
  buttons.append(confirm);
  if (cancelText) {
    const cancel = /** @type {HTMLButtonElement} */ (make('button', 'fs-dialog-cancel', cancelText));
    cancel.type = 'submit';
    cancel.value = 'cancel';
    cancel.formNoValidate = true;
    buttons.append(cancel);
  }
  form.append(buttons);
  dialog.append(form);

  // Keys typed into the dialog are the dialog's: not the player's keybinds (on document).
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  // A click on the backdrop lands on the dialog itself. Pressed there too: a selection
  // dragged out of the field ends in a click on the dialog as well.
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => {
    pressedOutside = e.target === dialog;
  });
  dialog.addEventListener('click', (e) => {
    if (!pressedOutside || e.target !== dialog) return;
    // Its own scrollbar and border are the dialog too: only beside its box is the backdrop.
    const box = dialog.getBoundingClientRect();
    if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) {
      dialog.close('');
    }
  });

  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'confirm';
      dialog.remove();
      resolve({
        isConfirmed: confirmed,
        isDenied: false,
        isDismissed: !confirmed,
        value: confirmed ? (field ? field.value : true) : undefined,
      });
    }, {once: true});
    dialog.showModal();
    // The field when there is one (showModal focuses the first control), else the button
    // that answers: Enter or Space confirms, as in sweetalert2.
    if (!field) confirm.focus();
  });
}

/**
 * The corner the toasts stack in, a popover so it shows over a dialog or a fullscreen
 * player. Shown again on top of whatever opened in the top layer since.
 * @return {HTMLElement}
 */
function toastCorner() {
  let corner = /** @type {?HTMLElement} */ (document.querySelector('.fs-toasts'));
  if (!corner) {
    corner = make('div', 'fs-toasts');
    corner.popover = 'manual';
    document.body.append(corner);
  }
  if (corner.matches(':popover-open')) corner.hidePopover();
  corner.showPopover();
  return corner;
}

/**
 * An error's message for a report. A player's error can be a plain object (hls.js and
 * dash.js report {type, details, ...}): as text that was "[object Object]".
 * @param {*} error
 * @return {string}
 */
function errorText(error) {
  let text = String(error);
  if (error?.message) {
    text = String(error.message);
  } else if (error && typeof error === 'object') {
    try {
      text = JSON.stringify(error) ?? text;
    } catch (e) {
      // A cycle: the plain text.
    }
  }
  // An issue's address has a length limit.
  return text.length > 1000 ? text.slice(0, 1000) + '...' : text;
}

/**
 * What the error dialog's title says went wrong: error.message alone was "undefined" for
 * a thrown text or a player's error object.
 * @param {*} error
 * @return {string}
 */
export function errorTitleText(error) {
  const text = errorText(error);
  return text.length > 200 ? text.slice(0, 200) + '...' : text;
}

/**
 * The address of a new GitHub issue that reports an error.
 * @param {*} error
 * @param {string} version - FastStream's.
 * @return {string}
 */
export function errorReportURL(error, version) {
  const body = `## Version:\n${version}\n\n## Error message:\n${errorText(error)}\n\n## Stack trace:\n\`\`\`\n${error?.stack || 'No stack trace'}\n\`\`\``;
  const urlBase = `https://github.com/Nawid3333/FastStream/issues/new?`;
  return `${urlBase}title=${encodeURIComponent('Error report')}&body=${encodeURIComponent(body)}`;
}

/**
 * The player's alert, confirm and prompt dialogs, and its toasts.
 */
export class AlertPolyfill {
  /**
   * Shows an alert dialog.
   * @param {string} message - The message to display.
   * @param {string} [icon] - Optional icon type.
   * @return {Promise<DialogResult>} Resolves when the dialog is closed.
   */
  static async alert(message, icon = undefined) {
    return openDialog({
      icon,
      text: message,
      confirmText: Localize.getMessage('ok'),
    });
  }

  /**
   * Shows a confirmation dialog.
   * @param {string} message - The message to display.
   * @param {string} [icon] - Optional icon type.
   * @return {Promise<boolean>} Resolves with true if confirmed, false otherwise.
   */
  static async confirm(message, icon = undefined) {
    return (await openDialog({
      icon,
      text: message,
      confirmText: Localize.getMessage('yes'),
      cancelText: Localize.getMessage('cancel'),
    })).isConfirmed;
  }

  /**
   * Shows a prompt dialog for user input.
   * @param {string} message - The message to display.
   * @param {string} [defaultValue] - Default input value.
   * @param {string} [icon] - Optional icon type.
   * @param {string} [inputType='text'] - Input type.
   * @return {Promise<string|undefined>} Resolves with the entered value, undefined if dismissed.
   */
  static async prompt(message, defaultValue = '', icon = undefined, inputType = 'text') {
    const {value} = await openDialog({
      icon,
      text: message,
      input: {type: inputType, value: defaultValue},
      confirmText: Localize.getMessage('ok'),
      cancelText: Localize.getMessage('cancel'),
    });
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Shows a toast notification in the top right corner for 3 s: longer while the pointer is
   * on it, shorter when clicked.
   * @param {string} icon - Icon type.
   * @param {string} message - Main message.
   * @param {string} [submessage] - Optional submessage.
   * @return {Promise<DialogResult>} Resolves when the toast is closed.
   */
  static async toast(icon, message, submessage = undefined) {
    const corner = toastCorner();
    const toast = make('div', `fs-toast fs-toast-${icon}`);
    toast.setAttribute('role', 'status');
    const words = make('div', 'fs-toast-words');
    words.append(make('div', 'fs-toast-title', message));
    if (submessage) words.append(make('div', 'fs-toast-text', submessage));
    const bar = make('div', 'fs-toast-progress');
    toast.append(makeIcon(icon), words, bar);
    corner.append(toast);

    return new Promise((resolve) => {
      // The bar running out is the toast's time, its only timer: paused while the pointer is
      // on it.
      const time = bar.animate([{transform: 'scaleX(1)'}, {transform: 'scaleX(0)'}],
          {duration: TOAST_MS, fill: 'forwards'});
      let closed = false;
      /** Takes the toast away. */
      function close() {
        if (closed) return;
        closed = true;
        time.onfinish = null;
        time.cancel();
        toast.remove();
        if (!corner.children.length && corner.matches(':popover-open')) corner.hidePopover();
        resolve({isConfirmed: false, isDenied: false, isDismissed: true, value: undefined});
      }
      time.onfinish = close;
      toast.addEventListener('mouseenter', () => time.pause());
      toast.addEventListener('mouseleave', () => time.play());
      toast.addEventListener('click', close);
    });
  }

  /**
   * Shows an error dialog and optionally sends the error report to the developer via GitHub.
   * @param {Error} error - The error object to report.
   * @return {Promise<void>} Resolves when the dialog is closed and report is sent or cancelled.
   */
  static async errorSendToDeveloper(error) {
    const content = make('div', 'fs-dialog-error');
    content.append(
        make('p', 'error-popup-body', Localize.getMessage('error_popup_body')),
        make('pre', 'error-popup-stack', error?.stack || ''),
    );
    const result = await openDialog({
      icon: 'error',
      title: Localize.getMessage('error_popup', [errorTitleText(error)]),
      content,
      confirmText: Localize.getMessage('error_popup_send'),
      cancelText: Localize.getMessage('cancel'),
    });
    if (result.isConfirmed) {
      EnvUtils.openExternalURL(errorReportURL(error, EnvUtils.getVersion()));
    }
  }
}
