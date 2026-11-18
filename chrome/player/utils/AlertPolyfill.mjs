// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {EnvUtils} from './EnvUtils.mjs';

// <dialog> and popover open in the top layer, over a fullscreen player. They are children of
// <body> and stop their keys: the player's Escape handler and keybinds must not see them.
// Texts go in as textContent: an error's message can quote markup. Styles: assets/dialogs/dialogs.css.

const TOAST_MS = 3000;

let lastId = 0;

/** @type {Object<string, string>} */
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
 * @param {string} icon - success, error, warning, info or question.
 * @return {HTMLElement}
 */
function makeIcon(icon) {
  const element = make('div', `fs-dialog-icon fs-dialog-icon-${icon}`, ICON_MARKS[icon] || '');
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/**
 * Closes by a button, Escape, or a click on its backdrop.
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
  /**
   * @param {HTMLElement} element
   * @param {string} attribute
   * @return {HTMLElement}
   */
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
    field.required = input.type === 'url';
    field.setAttribute('aria-label', text || title || '');
    form.append(field);
  }

  const buttons = make('div', 'fs-dialog-buttons');
  // First: Enter in the field submits with the first submit button.
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

  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  // A backdrop click lands on the dialog; so does a selection dragged out of the field.
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => {
    pressedOutside = e.target === dialog;
  });
  dialog.addEventListener('click', (e) => {
    if (!pressedOutside || e.target !== dialog) return;
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
    if (!field) confirm.focus();
  });
}

/**
 * Shown again so it stays on top of whatever opened in the top layer since.
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
 * A player's error can be a plain object (hls.js, dash.js).
 * @param {*} error
 * @return {string}
 */
function errorText(error) {
  let text = String(error);
  if (error?.message) {
    text = String(error.message);
  } else if (error && typeof error === 'object') {
    try {
      // An Error without a message is "{}" as JSON: its name says more.
      const json = JSON.stringify(error);
      if (json && json !== '{}') text = json;
    } catch (e) {
      // A cycle: the plain text.
    }
  }
  return text.length > 1000 ? text.slice(0, 1000) + '...' : text;
}

/**
 * @param {*} error
 * @return {string}
 */
export function errorTitleText(error) {
  const text = errorText(error);
  return text.length > 200 ? text.slice(0, 200) + '...' : text;
}

/**
 * Well-formed (encodeURIComponent throws on a lone surrogate) and cut to fit `limit`.
 * @param {string} text
 * @param {number} limit - Encoded (encodeURIComponent) characters.
 * @param {string} more - Put after a text that was cut.
 * @return {string}
 */
function clipForAddress(text, limit, more) {
  const whole = text.toWellFormed();
  let clipped = whole;
  while (encodeURIComponent(clipped).length > limit) {
    clipped = clipped.slice(0, Math.floor(clipped.length * 0.8)).toWellFormed();
  }
  return clipped === whole ? whole : clipped + more;
}

/**
 * @param {*} error
 * @param {string} version - FastStream's.
 * @return {string}
 */
export function errorReportURL(error, version) {
  // GitHub refuses an address past about 8 kB; the extension's id names the install, in the
  // stack and in a message (a module that failed to load is named by its address).
  /** @param {string} text */
  const noInstall = (text) => text.replace(/moz-extension:\/\/[^/\s]+\//g, 'moz-extension://.../');
  const stack = clipForAddress(noInstall(String(error?.stack || 'No stack trace')), 4000, '\n...');
  const message = clipForAddress(noInstall(errorText(error)), 2000, '...');
  const body = `## Version:\n${version}\n\n## Error message:\n${message}\n\n## Stack trace:\n\`\`\`\n${stack}\n\`\`\``;
  const urlBase = `https://github.com/Nawid3333/FastStream/issues/new?`;
  return `${urlBase}title=${encodeURIComponent('Error report')}&body=${encodeURIComponent(body)}`;
}

export class AlertPolyfill {
  /**
   * @param {string} message
   * @param {string} [icon]
   * @return {Promise<DialogResult>}
   */
  static async alert(message, icon = undefined) {
    return openDialog({
      icon,
      text: message,
      confirmText: Localize.getMessage('ok'),
    });
  }

  /**
   * @param {string} message
   * @param {string} [icon]
   * @return {Promise<boolean>}
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
   * @param {string} message
   * @param {string} [defaultValue]
   * @param {string} [icon]
   * @param {string} [inputType='text']
   * @return {Promise<string|undefined>} Undefined if dismissed.
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
   * @param {string} icon
   * @param {string} message
   * @param {string} [submessage]
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
      // The bar's animation is the toast's only timer: hover pauses it.
      const time = bar.animate([{transform: 'scaleX(1)'}, {transform: 'scaleX(0)'}],
          {duration: TOAST_MS, fill: 'forwards'});
      let closed = false;
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
   * @param {Error} error
   * @return {Promise<void>}
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
