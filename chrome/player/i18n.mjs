import {Localize} from './modules/Localize.mjs';

window.getI18nMessage = Localize.getMessage;

// The page is in the UI language, and a screen reader picks its voice from this. The
// options, welcome and permissions pages had none, the player a fixed "en".
document.documentElement.lang = Localize.getLanguage();

document.querySelectorAll('[data-i18n]').forEach((elem) => {
  elem.innerText = window.getI18nMessage(elem.dataset.i18n);
});

// An empty limit field said only "∞" (options page): it says "No limit" in words now.
document.querySelectorAll('[data-i18n-placeholder]').forEach((elem) => {
  elem.placeholder = window.getI18nMessage(elem.dataset.i18nPlaceholder);
});

document.querySelectorAll('[data-i18n-label]').forEach((elem) => {
  const msg = window.getI18nMessage(elem.dataset.i18nLabel);
  elem.title = msg;
  elem.setAttribute('aria-label', msg);
});
