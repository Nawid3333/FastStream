// @ts-check
import {Localize} from './modules/Localize.mjs';

/** @type {any} */ (window).getI18nMessage = Localize.getMessage;

// A screen reader picks its voice from the page's language.
document.documentElement.lang = Localize.getLanguage();

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-i18n]')).forEach((/** @type {HTMLElement} */ elem) => {
  elem.innerText = /** @type {any} */ (window).getI18nMessage(elem.dataset.i18n);
});

/** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('[data-i18n-placeholder]')).forEach((/** @type {HTMLInputElement} */ elem) => {
  elem.placeholder = /** @type {any} */ (window).getI18nMessage(elem.dataset.i18nPlaceholder);
});

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-i18n-label]')).forEach((/** @type {HTMLElement} */ elem) => {
  const msg = /** @type {any} */ (window).getI18nMessage(elem.dataset.i18nLabel);
  elem.title = msg;
  elem.setAttribute('aria-label', msg);
});
