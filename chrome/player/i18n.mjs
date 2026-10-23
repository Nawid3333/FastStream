// @ts-check
import {Localize} from './modules/Localize.mjs';

/** @type {any} */ (window).getI18nMessage = Localize.getMessage;

// The page is in the UI language, and a screen reader picks its voice from this. The
// options, welcome and permissions pages had none, the player a fixed "en".
document.documentElement.lang = Localize.getLanguage();

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-i18n]')).forEach((/** @type {HTMLElement} */ elem) => {
  elem.innerText = /** @type {any} */ (window).getI18nMessage(elem.dataset.i18n);
});

// An empty limit field said only "∞" (options page): it says "No limit" in words now.
/** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('[data-i18n-placeholder]')).forEach((/** @type {HTMLInputElement} */ elem) => {
  elem.placeholder = /** @type {any} */ (window).getI18nMessage(elem.dataset.i18nPlaceholder);
});

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-i18n-label]')).forEach((/** @type {HTMLElement} */ elem) => {
  const msg = /** @type {any} */ (window).getI18nMessage(elem.dataset.i18nLabel);
  elem.title = msg;
  elem.setAttribute('aria-label', msg);
});
