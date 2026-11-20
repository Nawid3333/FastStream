// @ts-check
import {DefaultKeybinds} from './defaults/DefaultKeybinds.mjs';
import {conflictPartners, keyDisplayName, keybindLabel} from './KeybindUtils.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {Localize} from '../modules/Localize.mjs';
import {clearProblems, issueUrl, readProblems} from '../utils/ProblemLog.mjs';
import {OptionsStore} from './OptionsStore.mjs';
import {resetSearch, searchWithQuery, initsearch} from '../utils/SearchUtils.mjs';

import {UpdateChecker} from '../utils/UpdateChecker.mjs'; // SPLICER:NO_UPDATE_CHECKER:REMOVE_LINE
import {ClickActions} from './defaults/ClickActions.mjs';
import {VisChangeActions} from './defaults/VisChangeActions.mjs';
import {MiniplayerPositions} from './defaults/MiniplayerPositions.mjs';
import {DefaultSubtitlesSettings} from './defaults/DefaultSubtitlesSettings.mjs';
import {DefaultToolSettings} from './defaults/ToolSettings.mjs';
import {DefaultQualities} from './defaults/DefaultQualities.mjs';
import {AspectRatios} from './defaults/AspectRatios.mjs';
import {ColorThemes} from './defaults/ColorThemes.mjs';
import {MpvSuggestion} from './MpvSuggestion.mjs';
import {holdImportedNumbers, importedForMigration, settingsForExport} from './SettingsFile.mjs';
import {CloudSettings} from './CloudSettings.mjs';
import {WebStorage} from '../utils/WebStorage.mjs';

// Empty until loadOptions: the select menus below are built before it.
let Options = /** @type {typeof DefaultOptions} */ ({});
const playStreamURLs = /** @type {HTMLInputElement} */ (document.getElementById('playstreamurls'));
const playMP4URLs = /** @type {HTMLInputElement} */ (document.getElementById('playmp4urls'));
const downloadAll = /** @type {HTMLInputElement} */ (document.getElementById('downloadall'));
const keybindsList = /** @type {HTMLElement} */ (document.getElementById('keybindslist'));
const autoEnableURLSInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('autoEnableURLs'));
const mpvModeToggle = /** @type {HTMLInputElement} */ (document.getElementById('mpvmode'));
const mpvModeSectionToggle = /** @type {HTMLInputElement} */ (document.getElementById('mpvModeSectionToggle'));
const mpvAllowlistInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('mpvAllowlist'));
const mpvPathInput = /** @type {HTMLInputElement} */ (document.getElementById('mpvpath'));
const mpvFullscreenToggle = /** @type {HTMLInputElement} */ (document.getElementById('mpvfullscreen'));
const mpvPausePageToggle = /** @type {HTMLInputElement} */ (document.getElementById('mpvpausepage'));
const mpvSingleInstanceToggle = /** @type {HTMLInputElement} */ (document.getElementById('mpvsingleinstance'));
const mpvAutoplayNextToggle = /** @type {HTMLInputElement} */ (document.getElementById('mpvautoplaynext'));
const mpvTestButton = /** @type {HTMLButtonElement} */ (document.getElementById('mpvtest'));
const mpvTestResult = /** @type {HTMLElement} */ (document.getElementById('mpvtestresult'));
const autoSub = /** @type {HTMLInputElement} */ (document.getElementById('autosub'));
const cycleSubs = /** @type {HTMLInputElement} */ (document.getElementById('cyclesubs'));
const maxSpeed = /** @type {HTMLInputElement} */ (document.getElementById('maxspeed'));
const maxSize = /** @type {HTMLInputElement} */ (document.getElementById('maxsize'));
const maxSizeUnit = /** @type {HTMLSelectElement} */ (document.getElementById('maxsizeunit'));
const ramBudget = /** @type {HTMLInputElement} */ (document.getElementById('rambudget'));
const ramBudgetUnit = /** @type {HTMLSelectElement} */ (document.getElementById('rambudgetunit'));
const bufferToDisk = /** @type {HTMLInputElement} */ (document.getElementById('buffertodisk'));
const bufferAhead = /** @type {HTMLInputElement} */ (document.getElementById('bufferahead'));
const bufferBehind = /** @type {HTMLInputElement} */ (document.getElementById('bufferbehind'));
const seekStepSize = /** @type {HTMLInputElement} */ (document.getElementById('seekstepsize'));
const autoplayNext = /** @type {HTMLInputElement} */ (document.getElementById('autoplaynext'));
const autoplayCountdown = /** @type {HTMLInputElement} */ (document.getElementById('autoplaycountdown'));
const problemsList = /** @type {HTMLElement} */ (document.getElementById('problemslist'));
const clearProblemsButton = /** @type {HTMLButtonElement} */ (document.getElementById('clearproblems'));
const blockPopupsWhilePlaying = /** @type {HTMLInputElement} */ (document.getElementById('blockpopupswhileplaying'));
const qualityMenu = /** @type {HTMLElement} */ (document.getElementById('quality'));
const importButton = /** @type {HTMLElement} */ (document.getElementById('import'));
const exportButton = /** @type {HTMLElement} */ (document.getElementById('export'));
const clickAction = /** @type {HTMLElement} */ (document.getElementById('clickaction'));
const dblclickAction = /** @type {HTMLElement} */ (document.getElementById('dblclickaction'));
const tplclickAction = /** @type {HTMLElement} */ (document.getElementById('tplclickaction'));
const visChangeAction = /** @type {HTMLElement} */ (document.getElementById('vischangeaction'));
const customSourcePatterns = /** @type {HTMLTextAreaElement} */ (document.getElementById('customSourcePatterns'));
const showWhenMiniSelected = /** @type {HTMLElement} */ (document.getElementById('showWhenMiniSelected'));
const storeProgress = /** @type {HTMLInputElement} */ (document.getElementById('storeprogress'));
const miniSize = /** @type {HTMLInputElement} */ (document.getElementById('minisize'));
const miniPos = /** @type {HTMLElement} */ (document.getElementById('minipos'));
const previewEnabled = /** @type {HTMLInputElement} */ (document.getElementById('previewenabled'));
const decodingAwareQuality = /** @type {HTMLInputElement} */ (document.getElementById('decodingawarequality'));
const lowerOnDroppedFrames = /** @type {HTMLInputElement} */ (document.getElementById('lowerondroppedframes'));
const replaceDelay = /** @type {HTMLInputElement} */ (document.getElementById('replacedelay'));
const colorTheme = /** @type {HTMLElement} */ (document.getElementById('colortheme'));
const videoAspectRatio = /** @type {HTMLElement} */ (document.getElementById('videoAspectRatio'));
const optionsSearchBar = /** @type {HTMLInputElement} */ (document.getElementById('searchbar'));
const optionsResetButton = /** @type {HTMLElement} */ (document.getElementById('resetsearch'));
const maxdownloaders = /** @type {HTMLInputElement} */ (document.getElementById('maxdownloaders'));
autoEnableURLSInput.setAttribute('autocapitalize', 'off');
autoEnableURLSInput.setAttribute('autocomplete', 'off');
autoEnableURLSInput.setAttribute('autocorrect', 'off');
autoEnableURLSInput.setAttribute('spellcheck', /** @type {any} */ (false));
autoEnableURLSInput.placeholder = 'https://example.com/movie/\n~^https:\\/\\/example\\.com\\/(movie|othermovie)\\/';

mpvAllowlistInput.setAttribute('autocapitalize', 'off');
mpvAllowlistInput.setAttribute('autocomplete', 'off');
mpvAllowlistInput.setAttribute('autocorrect', 'off');
mpvAllowlistInput.setAttribute('spellcheck', /** @type {any} */ (false));
mpvAllowlistInput.placeholder = 'netflix.com\ncrunchyroll.com @anime\nhttps://example.com/films/\n~^https:\\/\\/example\\.com\\/movie\\/';

customSourcePatterns.setAttribute('autocapitalize', 'off');
customSourcePatterns.setAttribute('autocomplete', 'off');
customSourcePatterns.setAttribute('autocorrect', 'off');
customSourcePatterns.setAttribute('spellcheck', /** @type {any} */ (false));
customSourcePatterns.placeholder = '# This is a comment. Use the following format.\n[file extension] /[regex]/[flags]';

// Until then OptionsStore.get() gives the defaults: a change made then would save them over the user's.
let optionsLoaded = false;
// Outside the update banner's SPLICER block, so the AMO build has it too.
const mpvSuggestion = EnvUtils.isExtension() ? new MpvSuggestion({
  box: /** @type {HTMLElement} */ (document.getElementById('mpvsuggestbox')),
  text: /** @type {HTMLElement} */ (document.getElementById('mpvsuggesttext')),
  enableButton: /** @type {HTMLElement} */ (document.getElementById('mpvsuggestyes')),
  dismissLink: /** @type {HTMLElement} */ (document.getElementById('mpvsuggestno')),
  isMpvModeOn: () => !!Options.mpvMode,
  turnOnMpvMode: () => {
    mpvModeToggle.checked = true;
    mpvModeChanged();
  },
}) : null;
let pageSeen = false;
// Firefox's answer to EnvUtils.os(); the user agent's guess until it comes, which a user
// agent override or Android's desktop-site mode makes wrong.
let platformKnown = false;
// Firefox for Android runs no mpv helper: its options are not shown there.
const showMpvOptions = () => {
  const hidden = EnvUtils.isAndroid();
  /** @type {HTMLElement} */ (document.getElementById('mpvmoderow')).hidden = hidden;
  /** @type {HTMLElement} */ (document.getElementById('mpvsection')).hidden = hidden;
};
showMpvOptions();
const cloudSettings = new CloudSettings({
  box: /** @type {HTMLElement} */ (document.getElementById('cloudsettings')),
  exportButton: /** @type {HTMLButtonElement} */ (document.getElementById('cloudexport')),
  importButton: /** @type {HTMLButtonElement} */ (document.getElementById('cloudimport')),
  question: /** @type {HTMLElement} */ (document.getElementById('cloudquestion')),
  questionText: /** @type {HTMLElement} */ (document.getElementById('cloudquestiontext')),
  replaceButton: /** @type {HTMLButtonElement} */ (document.getElementById('cloudreplace')),
  cancelButton: /** @type {HTMLButtonElement} */ (document.getElementById('cloudcancel')),
  status: /** @type {HTMLElement} */ (document.getElementById('cloudstatus')),
  result: /** @type {HTMLElement} */ (document.getElementById('cloudresult')),
  area: EnvUtils.isExtension() ? chrome.storage?.sync : undefined,
  settings: settingsToExport,
  apply: applyImportedSettings,
  os: () => EnvUtils.os(),
  isAndroid: () => EnvUtils.isAndroid(),
});
const offerMpvWhenReady = () => {
  if (mpvSuggestion && optionsLoaded && pageSeen && platformKnown && !EnvUtils.isAndroid()) {
    mpvSuggestion.check().catch((e) => console.error('Asking the mpv host failed', e));
  }
};
// Also for EnvUtils.isWindows.
EnvUtils.os().then(() => {
  platformKnown = true;
  showMpvOptions();
  cloudSettings.showWhereItWorks();
  offerMpvWhenReady();
}).catch((e) => console.error('Reading the platform failed', e));
OptionsStore.init().then(() => {
  optionsLoaded = true;
  loadOptions(OptionsStore.get());
  offerMpvWhenReady();
  // For the e2e specs.
  document.documentElement.dataset.optionsLoaded = 'true';
}).catch((e) => console.error('Loading the saved options failed', e));


if (!EnvUtils.isExtension()) {
  playStreamURLs.disabled = true;
  playMP4URLs.disabled = true;
  autoSub.disabled = true;
  autoEnableURLSInput.disabled = true;
  customSourcePatterns.disabled = true;
  mpvModeToggle.disabled = true;
  mpvModeSectionToggle.disabled = true;
  mpvAllowlistInput.disabled = true;
  mpvPathInput.disabled = true;
  mpvFullscreenToggle.disabled = true;
  mpvPausePageToggle.disabled = true;
  mpvSingleInstanceToggle.disabled = true;
  mpvAutoplayNextToggle.disabled = true;
  mpvTestButton.disabled = true;
  /** @type {HTMLInputElement} */ (miniSize).disabled = true;
  autoplayNext.disabled = true;
  autoplayCountdown.disabled = true;
}

/**
 * @param {Object} newOptions - The saved options merged over DefaultOptions.
 */
async function loadOptions(newOptions) {
  newOptions = newOptions || OptionsStore.get();
  Options = /** @type {typeof DefaultOptions} */ (newOptions);

  downloadAll.checked = !!Options.downloadAll;
  maxSize.disabled = !downloadAll.checked;
  maxSizeUnit.disabled = !downloadAll.checked;
  playStreamURLs.checked = !!Options.playStreamURLs;
  playMP4URLs.checked = !!Options.playMP4URLs;
  mpvModeToggle.checked = !!Options.mpvMode;
  mpvModeSectionToggle.checked = !!Options.mpvMode;
  mpvAllowlistInput.value = (Options.mpvAllowlist || []).join('\n');
  mpvPathInput.value = Options.mpvPath || '';
  mpvFullscreenToggle.checked = !!Options.mpvFullscreen;
  mpvPausePageToggle.checked = !!Options.mpvPausePage;
  mpvSingleInstanceToggle.checked = !!Options.mpvSingleInstance;
  mpvAutoplayNextToggle.checked = !!Options.mpvAutoplayNext;
  previewEnabled.checked = !!Options.previewEnabled;
  decodingAwareQuality.checked = Options.decodingAwareQuality !== false;
  lowerOnDroppedFrames.checked = Options.lowerOnDroppedFrames !== false;
  autoSub.checked = !!Options.autoEnableBestSubtitles;
  cycleSubs.checked = !!Options.cycleSubtitles;
  autoplayNext.checked = !!Options.autoplayNext;
  autoplayCountdown.value = /** @type {string} */ (/** @type {unknown} */ (Options.autoplayCountdown));
  blockPopupsWhilePlaying.checked = !!Options.blockPopupsWhilePlaying;
  showSpeed(Options.maxSpeed);
  showSize(maxSize, maxSizeUnit, Options.maxVideoSize);
  bufferToDisk.checked = Options.bufferToDisk !== false;
  showSize(ramBudget, ramBudgetUnit, Options.ramBudget);
  showSeconds(bufferAhead, Options.bufferAhead);
  showSeconds(bufferBehind, Options.bufferBehind);
  seekStepSize.value = /** @type {any} */ (Math.round(Options.seekStepSize * 100) / 100);
  customSourcePatterns.value = Options.customSourcePatterns || '';
  // A share of the player, shown in percent.
  miniSize.value = /** @type {any} */ (Math.round(Options.miniSize * 1000) / 10);
  storeProgress.checked = !!Options.storeProgress;
  replaceDelay.value = /** @type {string} */ (/** @type {unknown} */ (Options.replaceDelay));
  maxdownloaders.value = /** @type {string} */ (/** @type {unknown} */ (Options.maximumDownloaders));

  setSelectMenuValue(clickAction, Options.singleClickAction);
  setSelectMenuValue(dblclickAction, Options.doubleClickAction);
  setSelectMenuValue(tplclickAction, Options.tripleClickAction);
  setSelectMenuValue(visChangeAction, Options.visChangeAction);
  setSelectMenuValue(colorTheme, Options.colorTheme);
  setSelectMenuValue(videoAspectRatio, Options.videoAspectRatio);
  setSelectMenuValue(miniPos, Options.miniPos);
  setSelectMenuValue(qualityMenu, Options.defaultQuality);

  document.body.dataset.theme = Options.colorTheme;

  if (Options.visChangeAction === VisChangeActions.MINI_PLAYER) {
    showWhenMiniSelected.style.display = '';
  } else {
    showWhenMiniSelected.style.display = 'none';
  }

  if (Options.keybinds) {
    renderKeybinds();
  }

  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.video-option')).forEach((option) => {
    const numberInput = /** @type {HTMLInputElement} */ (option.querySelector('input.number'));
    const rangeInput = /** @type {HTMLInputElement & {value: any}} */ (option.querySelector('input.range'));
    const unit = option.dataset.unit || '%';
    const unitMultiplier = parseInt(/** @type {string} */ (option.dataset.multiplier || 100));
    const optionKey = /** @type {'videoZoom'|'videoDelay'} */ (option.dataset.option);
    const val = Math.round(Options[optionKey] * unitMultiplier);
    rangeInput.value = val;
    numberInput.value = val + unit;
  });

  autoEnableURLSInput.value = Options.autoEnableURLs.join('\n');

  if (Options.dev) {
    /** @type {HTMLElement} */ (document.getElementById('dev')).style.display = '';
  }
  if (mpvSuggestion) {
    mpvSuggestion.optionsChanged();
  }
  initsearch();
  // initsearch() shows every row again.
  if (optionsSearchBar.value) {
    searchWithQuery(optionsSearchBar.value);
  }
}

/**
 * @param {HTMLElement} container - The menu's place, which names it (data-i18n-label).
 * @param {string[]} options - The values to choose from.
 * @param {string|undefined} selected - Undefined before the options are read: loadOptions chooses then.
 * @param {?string} localPrefix - The locale messages' prefix for the values; null shows them
 *     as they are.
 * @param {(e: Event & {target: HTMLSelectElement}) => void} callback - On a change.
 * @param {((option: string) => string)|null} [labelOf]
 */
function createSelectMenu(container, options, selected, localPrefix, callback, labelOf = null) {
  container.replaceChildren();
  const select = document.createElement('select');
  // A screen reader names the select, not the labelled wrapper.
  if (container.dataset.i18nLabel) {
    select.setAttribute('aria-label', Localize.getMessage(container.dataset.i18nLabel));
  }
  for (const option of options) {
    const optionElement = document.createElement('option');
    optionElement.value = option;
    optionElement.textContent = labelOf ? labelOf(option) :
      (localPrefix !== null ? Localize.getMessage(localPrefix + '_' + option) : option);
    if (option === selected) {
      optionElement.selected = true;
    }
    select.appendChild(optionElement);
  }
  select.addEventListener('change', /** @type {EventListener} */ (callback));
  container.appendChild(select);
}

/**
 * @param {HTMLElement} container - As createSelectMenu took it.
 * @param {string} value
 */
function setSelectMenuValue(container, value) {
  const select = container.querySelector('select');
  if (!select) {
    return;
  }
  select.value = value;
}

createSelectMenu(clickAction, Object.values(ClickActions), Options.singleClickAction, 'options_general_clickaction', (e) => {
  Options.singleClickAction = e.target.value;
  optionChanged();
});

createSelectMenu(dblclickAction, Object.values(ClickActions), Options.doubleClickAction, 'options_general_clickaction', (e) => {
  Options.doubleClickAction = e.target.value;
  optionChanged();
});

createSelectMenu(tplclickAction, Object.values(ClickActions), Options.tripleClickAction, 'options_general_clickaction', (e) => {
  Options.tripleClickAction = e.target.value;
  optionChanged();
});

createSelectMenu(visChangeAction, Object.values(VisChangeActions), Options.visChangeAction, 'options_general_vischangeaction', (e) => {
  Options.visChangeAction = e.target.value;
  if (Options.visChangeAction === VisChangeActions.MINI_PLAYER) {
    showWhenMiniSelected.style.display = '';
  } else {
    showWhenMiniSelected.style.display = 'none';
  }
  optionChanged();
});

createSelectMenu(colorTheme, Object.values(ColorThemes), Options.colorTheme, 'options_general_color_theme', (e) => {
  Options.colorTheme = e.target.value;
  document.body.dataset.theme = Options.colorTheme;
  optionChanged();
});

createSelectMenu(videoAspectRatio, Object.values(AspectRatios), Options.videoAspectRatio, null, (e) => {
  Options.videoAspectRatio = e.target.value;
  optionChanged();
}, (option) => (option === AspectRatios.AUTO || option === AspectRatios.STRETCH) ?
  Localize.getMessage('options_video_aspect_ratio_' + option) : option);

createSelectMenu(miniPos, Object.values(MiniplayerPositions), Options.miniPos, 'options_general_minipos', (e) => {
  Options.miniPos = e.target.value;
  optionChanged();
});

createSelectMenu(qualityMenu, Object.values(DefaultQualities), Options.defaultQuality, null, (e) => {
  Options.defaultQuality = e.target.value;
  optionChanged();
});

document.querySelectorAll('.option').forEach((option) => {
  option.addEventListener('click', /** @param {Event} e */ (e) => {
    // A unit picker beside a number takes its own clicks.
    if (/** @type {Element} */ (e.target).tagName !== 'INPUT' && !/** @type {Element} */ (e.target).closest('select')) {
      const input = option.querySelector('input');
      if (input) {
        if (input.type === 'checkbox') {
          input.click();
        } else {
          input.focus();
        }
      } else {
        const select = option.querySelector('select');
        if (select) {
          select.focus();
        }
      }
    }
  });

  const input = option.querySelector('input');
  // Enter ticks a box. No button role: a screen reader would not say a box is ticked, nor
  // that a field takes text.
  if (input) {
    WebUtils.setupKeyPress(input);
  }
});

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.video-option')).forEach((option) => {
  const numberInput = /** @type {HTMLInputElement} */ (option.querySelector('input.number'));
  const rangeInput = /** @type {HTMLInputElement & {value: any}} */ (option.querySelector('input.range'));
  const unit = option.dataset.unit || '%';
  const unitMultiplier = parseInt(/** @type {string} */ (option.dataset.multiplier || 100));

  const optionKey = /** @type {'videoZoom'|'videoDelay'} */ (option.dataset.option);

  function numberInputChanged() {
    const text = numberInput.value.replace(unit, '').trim();
    const value = parseInt(text);
    // An emptied field is no value: 0 would hide the video while the user types.
    if (text === '' || !Number.isFinite(value)) return;
    rangeInput.value = value;
    Options[optionKey] = (option.dataset.nolimits ? value : parseInt(rangeInput.value)) / unitMultiplier;
    optionChanged();
  }

  // A drag saves once a frame: each save makes every player read the options again.
  let pendingSave = 0;
  /**
   * @param {Event} e - The slider's change or input.
   */
  function rangeInputChanged(e) {
    numberInput.value = rangeInput.value + unit;
    Options[optionKey] = parseInt(rangeInput.value) / unitMultiplier;
    if (e?.type === 'input') {
      if (!pendingSave) {
        pendingSave = requestAnimationFrame(() => {
          pendingSave = 0;
          optionChanged();
        });
      }
      return;
    }
    if (pendingSave) {
      cancelAnimationFrame(pendingSave);
      pendingSave = 0;
    }
    optionChanged();
  }

  numberInput.addEventListener('change', () => {
    numberInputChanged();
    numberInput.value = Math.round(Options[optionKey] * unitMultiplier) + unit;
  });
  numberInput.addEventListener('input', numberInputChanged);
  rangeInput.addEventListener('change', rangeInputChanged);
  rangeInput.addEventListener('input', rangeInputChanged);
  rangeInput.addEventListener('dblclick', (e) => {
    Options[optionKey] = DefaultOptions[optionKey];
    rangeInput.value = Math.round(Options[optionKey] * unitMultiplier);
    numberInput.value = rangeInput.value + unit;
    optionChanged();
  });
});

function renderKeybinds() {
  keybindsList.replaceChildren();
  for (const keybind in Options.keybinds) {
    if (Object.hasOwn(Options.keybinds, keybind)) {
      createKeybindElement(keybind);
    }
  }
  refreshKeybindConflicts();
}

/**
 * Warns but does not refuse: the user may be halfway through rearranging.
 */
function refreshKeybindConflicts() {
  const partners = conflictPartners(Options.keybinds);
  /** @type {NodeListOf<HTMLElement>} */ (keybindsList.querySelectorAll('.keybind-container')).forEach((container) => {
    const others = partners.get(/** @type {string} */ (container.dataset.keybind));
    const warning = /** @type {HTMLElement} */ (container.querySelector('.keybind-warning'));
    container.classList.toggle('keybind-conflict', !!others);
    warning.hidden = !others;
    warning.textContent = others ? Localize.getMessage('options_keybinds_conflict', [others.map(keybindLabel).join(', ')]) : '';
  });
}

/**
 * @param {string} keybind - The action.
 */
function createKeybindElement(keybind) {
  const containerElement = document.createElement('div');
  containerElement.classList.add('keybind-container');
  containerElement.classList.add('search-target-remove-keybind');
  containerElement.dataset.keybind = keybind;

  const keybindNameElement = document.createElement('div');
  keybindNameElement.classList.add('keybind-name');
  keybindNameElement.classList.add('search-target-keybind');
  const keybindName = keybindLabel(keybind);
  keybindNameElement.textContent = keybindName;
  containerElement.appendChild(keybindNameElement);

  const keybindInput = document.createElement('div');
  keybindInput.classList.add('keybind-input');
  keybindInput.classList.add('search-target-keybind');
  keybindInput.tabIndex = 0;
  keybindInput.title = keybindName;
  keybindInput.role = 'button';
  const showKey = () => {
    keybindInput.dataset.key = Options.keybinds[keybind];
    keybindInput.textContent = keyDisplayName(Options.keybinds[keybind], Localize.getMessage('options_keybinds_none') || 'None');
  };
  showKey();

  keybindInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      return;
    } else if (e.key === 'Escape') {
      Options.keybinds[keybind] = 'None';
      showKey();
      refreshKeybindConflicts();
      optionChanged();
      keybindInput.blur();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    // A press with no key code names no key.
    if (!e.code && e.key !== ' ') {
      return;
    }
    Options.keybinds[keybind] = WebUtils.getKeyString(e);
    showKey();
    refreshKeybindConflicts();
    optionChanged();
  });

  keybindInput.addEventListener('keyup', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });

  keybindInput.addEventListener('click', (e) => {
    keybindInput.textContent = Localize.getMessage('options_keybinds_press');
  });

  keybindInput.addEventListener('blur', (e) => {
    showKey();
  });

  containerElement.appendChild(keybindInput);

  const warning = document.createElement('div');
  warning.classList.add('keybind-warning');
  warning.setAttribute('role', 'status');
  warning.hidden = true;
  containerElement.appendChild(warning);

  keybindsList.appendChild(containerElement);
}

if (EnvUtils.isExtension()) {
  /** @type {HTMLAnchorElement} */ (document.getElementById('welcome')).href = chrome.runtime.getURL('welcome.html');
} else {
  // The web build has no welcome page.
  /** @type {HTMLElement} */ (document.getElementById('welcomeitem')).style.display = 'none';
}

playMP4URLs.addEventListener('change', () => {
  Options.playMP4URLs = playMP4URLs.checked;
  optionChanged();
});

autoSub.addEventListener('change', () => {
  Options.autoEnableBestSubtitles = autoSub.checked;
  optionChanged();
});

cycleSubs.addEventListener('change', () => {
  Options.cycleSubtitles = cycleSubs.checked;
  optionChanged();
});

playStreamURLs.addEventListener('change', () => {
  Options.playStreamURLs = playStreamURLs.checked;
  optionChanged();
});

const mpvModeChanged = () => {
  Options.mpvMode = mpvModeToggle.checked;
  mpvModeSectionToggle.checked = Options.mpvMode;
  optionChanged();
  // The page's own save does not come back through loadOptions.
  if (mpvSuggestion) {
    mpvSuggestion.optionsChanged();
  }
};

mpvModeToggle.addEventListener('change', mpvModeChanged);
mpvModeSectionToggle.addEventListener('change', () => {
  mpvModeToggle.checked = mpvModeSectionToggle.checked;
  mpvModeChanged();
});

mpvAllowlistInput.addEventListener('change', (e) => {
  Options.mpvAllowlist = mpvAllowlistInput.value.split('\n').map((o)=>o.trim()).filter((o)=>o.length);
  mpvAllowlistInput.value = Options.mpvAllowlist.join('\n');
  optionChanged();
});

mpvPathInput.addEventListener('change', () => {
  Options.mpvPath = mpvPathInput.value.trim();
  mpvPathInput.value = Options.mpvPath;
  optionChanged();
});

mpvFullscreenToggle.addEventListener('change', () => {
  Options.mpvFullscreen = mpvFullscreenToggle.checked;
  optionChanged();
});

mpvPausePageToggle.addEventListener('change', () => {
  Options.mpvPausePage = mpvPausePageToggle.checked;
  optionChanged();
});

mpvSingleInstanceToggle.addEventListener('change', () => {
  Options.mpvSingleInstance = mpvSingleInstanceToggle.checked;
  optionChanged();
});

mpvAutoplayNextToggle.addEventListener('change', () => {
  Options.mpvAutoplayNext = mpvAutoplayNextToggle.checked;
  optionChanged();
});

/**
 * The same file, or the folder it is in (the host accepts both), whatever the case and slashes.
 * @param {string} typed
 * @param {string} found - The mpv the host found.
 * @return {boolean}
 */
function samePath(typed, found) {
  const norm = /** @param {string} p */ (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(typed) === norm(found) || norm(typed) + '\\mpv.exe' === norm(found) ||
    norm(typed) + '\\mpv' === norm(found);
}

mpvTestButton.addEventListener('click', () => {
  mpvTestResult.textContent = '...';
  const sendTest = () => {
    chrome.runtime.sendMessage({type: 'MPV_TEST'}, (response) => {
      if (chrome.runtime.lastError || !response) {
        mpvTestResult.textContent = /** @type {any} */ (window).getI18nMessage('options_mpv_test_fail');
        return;
      }
      if (response.ok && response.mpv && typeof response.path === 'string') {
        // A path set here that does not exist falls back to other places: say which mpv.
        const typed = mpvPathInput.value.trim();
        mpvTestResult.textContent = !typed || samePath(typed, response.path) ?
          /** @type {any} */ (window).getI18nMessage('options_mpv_test_ok_at', [response.path]) :
          /** @type {any} */ (window).getI18nMessage('options_mpv_test_otherpath', [response.path]);
      } else if (response.ok && response.mpv) {
        mpvTestResult.textContent = /** @type {any} */ (window).getI18nMessage('options_mpv_test_ok');
      } else if (response.ok) {
        mpvTestResult.textContent = /** @type {any} */ (window).getI18nMessage('options_mpv_test_nompv');
      } else {
        mpvTestResult.textContent = /** @type {any} */ (window).getI18nMessage('options_mpv_test_fail');
      }
      if (response.ok && response.hostOutdated) {
        mpvTestResult.textContent += ' ' + /** @type {any} */ (window).getI18nMessage(EnvUtils.isWindows() ?
          'options_mpv_test_outdated' : 'options_mpv_test_outdated_unix');
      }
      // Only a hint: mpv.conf is the user's, and FastStream never overrides it.
      if (response.ok && response.decoder && typeof response.decoderText === 'string') {
        const key = response.decoder.hardware ? 'options_mpv_test_decoder_hw' : 'options_mpv_test_decoder_sw';
        const what = response.decoderText || String(response.decoder.api || '');
        mpvTestResult.textContent += ' ' + /** @type {any} */ (window).getI18nMessage(key, [what]);
      }
    });
  };
  sendTest();
});

downloadAll.addEventListener('change', () => {
  Options.downloadAll = downloadAll.checked;
  maxSize.disabled = !downloadAll.checked;
  maxSizeUnit.disabled = !downloadAll.checked;
  optionChanged();
});

previewEnabled.addEventListener('change', () => {
  Options.previewEnabled = previewEnabled.checked;
  optionChanged();
});

decodingAwareQuality.addEventListener('change', () => {
  Options.decodingAwareQuality = decodingAwareQuality.checked;
  optionChanged();
});

lowerOnDroppedFrames.addEventListener('change', () => {
  Options.lowerOnDroppedFrames = lowerOnDroppedFrames.checked;
  optionChanged();
});

storeProgress.addEventListener('change', () => {
  Options.storeProgress = storeProgress.checked;
  optionChanged();
});

autoplayNext.addEventListener('change', () => {
  Options.autoplayNext = autoplayNext.checked;
  WebStorage.remove('session', 'autoplayNext');
  optionChanged();
});

/**
 * Sites where autoplay got stuck (ProblemLog.mjs).
 */
async function renderProblems() {
  if (!EnvUtils.isExtension()) {
    /** @type {HTMLElement} */ (document.getElementById('autoplayproblems')).hidden = true;
    return;
  }
  const problems = await readProblems();
  problemsList.replaceChildren();
  clearProblemsButton.disabled = problems.length === 0;
  if (problems.length === 0) {
    const none = document.createElement('li');
    none.textContent = Localize.getMessage('options_problems_none');
    problemsList.appendChild(none);
    return;
  }
  const about = {version: chrome.runtime.getManifest().version, browser: navigator.userAgent};
  for (const entry of problems) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    const what = Localize.getMessage(entry.kind === 'no_next' ? 'options_problems_no_next' : 'options_problems_no_stream');
    const where = Localize.getMessage(entry.mode === 'mpv' ? 'options_problems_mode_mpv' : 'options_problems_mode_player');
    const seen = Localize.getMessage('options_problems_seen', [String(entry.count), new Date(entry.last).toLocaleDateString()]);
    text.textContent = `${entry.host}: ${what} (${where}; ${seen})`;
    const report = document.createElement('button');
    report.textContent = Localize.getMessage('options_problems_report');
    report.addEventListener('click', () => {
      // Not window.open: this page is an iframe in the player.
      EnvUtils.openExternalURL(issueUrl(entry, about));
    });
    item.append(text, report);
    problemsList.appendChild(item);
  }
}

clearProblemsButton.addEventListener('click', () => {
  clearProblems().then(renderProblems).catch((e) => console.error(e));
});

if (EnvUtils.isExtension()) {
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.siteProblems) renderProblems().catch((e) => console.error(e));
  });
}
renderProblems().catch((e) => console.error(e));

// In the unit each option is saved in; an imported file is held to them too (holdToFields).
/** @type {Object<string, {min: number, max: number, whole: boolean}>} */
const NUMBER_LIMITS = {
  autoplayCountdown: {min: 0, max: 30, whole: true},
  seekStepSize: {min: 0.1, max: 3600, whole: false},
  replaceDelay: {min: 0, max: 60000, whole: true},
  miniSize: {min: 0.01, max: 1, whole: false},
  maximumDownloaders: {min: 1, max: 6, whole: true},
};

autoplayCountdown.addEventListener('change', () => {
  Options.autoplayCountdown = readNumberField(autoplayCountdown, DefaultOptions.autoplayCountdown, NUMBER_LIMITS.autoplayCountdown);
  optionChanged();
});

blockPopupsWhilePlaying.addEventListener('change', () => {
  Options.blockPopupsWhilePlaying = blockPopupsWhilePlaying.checked;
  optionChanged();
});

// Saved as bytes a second and bytes; an empty field is no limit (-1), 0 is none.
const BYTES_PER_MBIT_PER_S = 1000000 / 8;
const GB = 1000 ** 3;

/**
 * In Mbit/s, as speed tests give it.
 * @param {number} bytesPerSecond
 */
function showSpeed(bytesPerSecond) {
  maxSpeed.value = bytesPerSecond >= 0 ? String(Math.round(bytesPerSecond / BYTES_PER_MBIT_PER_S * 1000) / 1000) : '';
  showLimitHint(maxSpeed, bytesPerSecond);
}

/** @type {Object<string, {zero: string, none?: string}>} By the field's id. */
const LIMIT_HINTS = {
  maxspeed: {zero: 'options_general_targetspeed_zero'},
  maxsize: {zero: 'options_general_maxsize_zero'},
  rambudget: {zero: 'options_general_rambudget_zero', none: 'options_general_rambudget_none'},
  bufferahead: {zero: 'options_general_bufferahead_zero', none: 'options_general_bufferahead_none'},
  bufferbehind: {zero: 'options_general_bufferbehind_zero', none: 'options_general_bufferbehind_none'},
};

/**
 * 0 and no limit are easy to set without meaning to: say what they do.
 * @param {HTMLInputElement} input
 * @param {number} value - The limit as saved: -1 for none.
 */
function showLimitHint(input, value) {
  const hint = document.getElementById(input.id + 'hint');
  let key = value === 0 ? LIMIT_HINTS[input.id].zero : value < 0 ? LIMIT_HINTS[input.id].none : null;
  if (input === ramBudget && value === 0 && !bufferToDisk.checked) key = 'options_general_rambudget_zero_nodisk';
  if (!hint) return;
  hint.textContent = key ? Localize.getMessage(key) : '';
  hint.hidden = !key;
}

/**
 * To three decimals. Loaded, in GB when that holds it exactly, else MB; after a change, in the
 * unit the user picked.
 * @param {HTMLInputElement} input
 * @param {HTMLSelectElement} unit
 * @param {number} bytes
 * @param {boolean} [keepUnit] - Whether the unit picked stays.
 */
function showSize(input, unit, bytes, keepUnit = false) {
  if (!keepUnit) unit.value = String(!(bytes >= 0) || (bytes >= GB && bytes % (GB / 1000) === 0) ? GB : GB / 1000);
  input.value = bytes >= 0 ? String(Math.round(bytes / Number(unit.value) * 1000) / 1000) : '';
  showLimitHint(input, bytes);
}

/**
 * -1 for an empty field, null for no number from 0 up (the limit stays). A comma is a decimal
 * point; read to the three decimals the field shows, so what is saved is what it says.
 * @param {HTMLInputElement} input
 * @param {number} multiplier
 * @return {?number}
 */
function readLimit(input, multiplier) {
  const text = input.value.trim().replace(',', '.');
  if (text === '') return -1;
  // Number(), not parseFloat(): "10 MB" is no number.
  const shown = Math.round(Number(text) * 1000) / 1000;
  const amount = Math.round(shown * multiplier);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

// Written back only on a trusted change, not on a save while typing.
maxSpeed.addEventListener('change', (e) => {
  const value = readLimit(maxSpeed, BYTES_PER_MBIT_PER_S);
  if (value !== null) Options.maxSpeed = value;
  if (e.isTrusted) showSpeed(Options.maxSpeed);
  if (value !== null) optionChanged();
});

const onMaxSizeChange = /** @param {Event} e */ (e) => {
  const value = readLimit(maxSize, Number(maxSizeUnit.value));
  if (value !== null) Options.maxVideoSize = value;
  if (e.isTrusted) showSize(maxSize, maxSizeUnit, Options.maxVideoSize, true);
  if (value !== null) optionChanged();
};
maxSize.addEventListener('change', onMaxSizeChange);
maxSizeUnit.addEventListener('change', onMaxSizeChange);

const onRamBudgetChange = /** @param {Event} e */ (e) => {
  const value = readLimit(ramBudget, Number(ramBudgetUnit.value));
  if (value !== null) Options.ramBudget = value;
  if (e.isTrusted) showSize(ramBudget, ramBudgetUnit, Options.ramBudget, true);
  if (value !== null) optionChanged();
};
ramBudget.addEventListener('change', onRamBudgetChange);
ramBudgetUnit.addEventListener('change', onRamBudgetChange);

bufferToDisk.addEventListener('change', () => {
  Options.bufferToDisk = bufferToDisk.checked;
  // What the field says now: a number typed is saved only 400 ms later.
  showLimitHint(ramBudget, readLimit(ramBudget, Number(ramBudgetUnit.value)) ?? Options.ramBudget);
  optionChanged();
});

/**
 * Within its limits, or the default when it holds no number, shown back in the field.
 * @param {HTMLInputElement} input
 * @param {number} fallback - The value for an empty or unreadable field, as the field shows it.
 * @param {{min: number, max: number, whole: boolean}} limits - The option's (NUMBER_LIMITS).
 * @param {number} [scale] - The field's units in one of the option's: 100 for a percent.
 * @return {number} As the field shows it.
 */
function readNumberField(input, fallback, {min, max, whole}, scale = 1) {
  const text = String(input.value).trim().replace(',', '.');
  const value = whole ? parseInt(text) : parseFloat(text);
  const result = Number.isFinite(value) ? Math.min(Math.max(value, min * scale), max * scale) : fallback;
  input.value = /** @type {string} */ (/** @type {unknown} */ (result));
  return result;
}

/**
 * @param {HTMLInputElement} input
 * @param {number} seconds - As saved: -1 for no limit.
 */
function showSeconds(input, seconds) {
  input.value = seconds >= 0 ? String(seconds) : '';
  showLimitHint(input, seconds);
}

// An empty field is no limit; anything else that is no number keeps the value saved.
for (const [input, option] of /** @type {[HTMLInputElement, 'bufferAhead'|'bufferBehind'][]} */ ([[bufferAhead, 'bufferAhead'], [bufferBehind, 'bufferBehind']])) {
  input.addEventListener('change', (e) => {
    const text = input.value.trim().replace(',', '.');
    const seconds = text === '' ? -1 : Number(text);
    if (seconds === -1 || (Number.isFinite(seconds) && seconds >= 0)) {
      Options[option] = seconds === -1 ? -1 : Math.floor(seconds);
      optionChanged();
    }
    if (e.isTrusted) showSeconds(input, Options[option]);
  });
}

seekStepSize.addEventListener('change', () => {
  Options.seekStepSize = readNumberField(seekStepSize, DefaultOptions.seekStepSize, NUMBER_LIMITS.seekStepSize);
  optionChanged();
});

replaceDelay.addEventListener('change', () => {
  Options.replaceDelay = readNumberField(replaceDelay, DefaultOptions.replaceDelay, NUMBER_LIMITS.replaceDelay);
  optionChanged();
});

miniSize.addEventListener('change', () => {
  Options.miniSize = readNumberField(miniSize, DefaultOptions.miniSize * 100, NUMBER_LIMITS.miniSize, 100) / 100;
  optionChanged();
});

// 1 to 6, the browser's limit per server.
maxdownloaders.addEventListener('change', () => {
  Options.maximumDownloaders = readNumberField(maxdownloaders, DefaultOptions.maximumDownloaders, NUMBER_LIMITS.maximumDownloaders);
  optionChanged();
});

/**
 * Change comes only on leaving the field: a value typed and the settings closed was lost. What
 * is typed stays as typed; an emptied field is saved when it or the page is left.
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 */
function saveWhileTyping(input) {
  /** @type {any} */ let timer = null;
  let unsaved = false;
  const save = (leaving = false) => {
    clearTimeout(timer);
    timer = null;
    // Half typed ("1.", "-") reads as empty, which would be "no limit".
    if (input.validity?.badInput) return;
    if (!leaving && !input.value.trim()) return;
    const typed = input.value;
    const {selectionStart, selectionEnd} = input;
    input.dispatchEvent(new Event('change'));
    if (input.value !== typed) {
      input.value = typed;
      // A number field has no caret position (null), and setSelectionRange throws there.
      if (selectionStart !== null) input.setSelectionRange(selectionStart, selectionEnd);
    }
  };
  input.addEventListener('input', () => {
    unsaved = true;
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  });
  input.addEventListener('change', () => {
    unsaved = false;
    clearTimeout(timer);
    timer = null;
  });
  window.addEventListener('pagehide', () => {
    if (unsaved) save(true);
  });
}

[maxSpeed, maxSize, ramBudget, bufferAhead, bufferBehind, seekStepSize, replaceDelay, miniSize, maxdownloaders,
  mpvPathInput, autoplayCountdown].forEach(saveWhileTyping);

/**
 * Not while typing: half a line would be an entry of its own ("https://" matches every site).
 * @param {HTMLTextAreaElement} input
 */
function saveOnLeavingPage(input) {
  let changed = false;
  input.addEventListener('input', () => {
    changed = true;
  });
  input.addEventListener('change', () => {
    changed = false;
  });
  window.addEventListener('pagehide', () => {
    if (changed) input.dispatchEvent(new Event('change'));
  });
}

optionsSearchBar.placeholder = Localize.getMessage('options_search_placeholder');


optionsSearchBar.addEventListener('input', () => {
  if (optionsSearchBar.value === '') {
    resetSearch();
  } else {
    searchWithQuery(optionsSearchBar.value);
  }
});

optionsResetButton.addEventListener('click', () => {
  optionsSearchBar.value = '';
  resetSearch();
});

/** @type {HTMLElement} */ (document.getElementById('resetdefault')).addEventListener('click', () => {
  Options.keybinds = structuredClone(DefaultKeybinds);
  renderKeybinds();
  optionChanged();
});

WebUtils.setupTabIndex(/** @type {HTMLElement} */ (document.getElementById('resetdefault')));

autoEnableURLSInput.addEventListener('change', (e) => {
  Options.autoEnableURLs = autoEnableURLSInput.value.split('\n').map((o)=>o.trim()).filter((o)=>o.length);
  autoEnableURLSInput.value = Options.autoEnableURLs.join('\n');
  optionChanged();
});

customSourcePatterns.addEventListener('change', (e) => {
  Options.customSourcePatterns = customSourcePatterns.value;
  optionChanged();
});

[mpvAllowlistInput, autoEnableURLSInput, customSourcePatterns].forEach(saveOnLeavingPage);

// Not the aspect ratio and quality: the player takes any ratio and any height.
/** @type {Object<string, Object<string, string>>} */
const MENU_CHOICES = {
  singleClickAction: ClickActions, doubleClickAction: ClickActions, tripleClickAction: ClickActions,
  visChangeAction: VisChangeActions, colorTheme: ColorThemes, miniPos: MiniplayerPositions,
};

/**
 * Holds an imported file's numbers to NUMBER_LIMITS, and a menu's value to its choices.
 * @param {Object<string, *>} options - Merged over DefaultOptions; changed in place.
 */
function holdToFields(options) {
  /** @type {Object<string, *>} */
  const defaults = DefaultOptions;
  for (const [option, {min, max, whole}] of Object.entries(NUMBER_LIMITS)) {
    const value = whole ? Math.trunc(options[option]) : options[option];
    options[option] = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : defaults[option];
  }
  for (const [option, choices] of Object.entries(MENU_CHOICES)) {
    if (!Object.values(choices).includes(options[option])) {
      options[option] = defaults[option];
    }
  }
}

importButton.addEventListener('click', () => {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.json';
  picker.addEventListener('change', async (e) => {
    const file = /** @type {HTMLInputElement & {files: FileList}} */ (e.target).files[0];
    if (!file) return;
    let newOptionsObj;
    try {
      newOptionsObj = JSON.parse(await file.text());
    } catch (err) {
      newOptionsObj = null;
    }
    if (!newOptionsObj || typeof newOptionsObj !== 'object' || Array.isArray(newOptionsObj)) {
      alert(Localize.getMessage('options_import_invalid'));
      return;
    }
    applyImportedSettings(newOptionsObj);
  });
  document.body.appendChild(picker);
  picker.click();
  picker.remove();
});

/**
 * Takes imported settings (a file's, the cloud copy's) as the page's own and saves them.
 * @param {Object<string, *>} newOptionsObj - What settingsToExport wrote.
 */
function applyImportedSettings(newOptionsObj) {
  newOptionsObj = importedForMigration(newOptionsObj);
  const newOptions = Utils.migrateClickActions(Utils.migrateSizes(Utils.migrateKeybinds(
      Utils.mergeOptions(DefaultOptions, newOptionsObj), newOptionsObj), newOptionsObj), newOptionsObj);
  // Never imported: a shared file could name a program planted on this computer.
  /** @type {Object<string, *>} */ (newOptions).mpvPath = typeof Options.mpvPath === 'string' ? Options.mpvPath : '';
  holdToFields(newOptions);
  holdImportedNumbers(newOptions);
  const subtitlesSettings = Utils.mergeOptions(DefaultSubtitlesSettings, newOptionsObj.subtitlesSettings || {});
  const toolSettings = Utils.mergeOptions(DefaultToolSettings, newOptionsObj.toolSettings || {});
  loadOptions(newOptions);
  optionChanged();

  Utils.setConfig('subtitlesSettings', JSON.stringify(subtitlesSettings));
  Utils.setConfig('toolSettings', JSON.stringify(toolSettings));
}

/**
 * What the settings file and the cloud copy hold.
 * @return {Promise<Object<string, *>>}
 */
async function settingsToExport() {
  return {
    ...settingsForExport(await Utils.getOptionsFromStorage()),
    subtitlesSettings: await Utils.getSubtitlesSettingsFromStorage(),
    toolSettings: await Utils.loadAndParseOptions('toolSettings', DefaultToolSettings),
  };
}

exportButton.addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(await settingsToExport(), null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  Utils.downloadURL(url, 'faststream-options.json', true);
  URL.revokeObjectURL(url);
});

// The store tells listeners about this page's own saves too: no redraw for those.
/** @type {object|null} */
let ownSave = null;

function optionChanged() {
  // Before then, saving would put the defaults over everything else the user had set.
  if (!optionsLoaded) {
    return;
  }
  OptionsStore.replace(Options);
  ownSave = OptionsStore.get();
}

const versionDiv = /** @type {HTMLElement} */ (document.getElementById('version'));
versionDiv.textContent = `FastStream v${EnvUtils.getVersion()}`;

if (parent !== window) {
  document.body.classList.add('frame');
}

OptionsStore.subscribe((options) => {
  if (options !== ownSave) {
    loadOptions(options);
  }
});

if (EnvUtils.isExtension()) {
  const o = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && optionsLoaded) loadOptions(OptionsStore.get());
    if (entry.isIntersecting) {
      pageSeen = true;
      offerMpvWhenReady();
      cloudSettings.pageSeen();
    }
  });
  o.observe(document.body);

  // SPLICER:NO_UPDATE_CHECKER:REMOVE_START
  const updatebox = /** @type {HTMLElement} */ (document.getElementById('updatebox'));
  const updatetext = /** @type {HTMLElement} */ (document.getElementById('updatetext'));
  const updatenotif = parent.document ? parent.document.getElementById('update_notif_banner') : null;

  chrome.storage.local.get({
    updateData: '{}',
  }, async (result) => {
    const stored = result?.updateData ? JSON.parse(/** @type {string} */ (result.updateData)) : {};
    const checked = await UpdateChecker.refreshUpdateData(stored, Date.now());
    if (checked) {
      chrome.storage.local.set({
        updateData: JSON.stringify(checked),
      });
    }
    const data = checked ?? stored;

    const currentVersion = EnvUtils.getVersion();
    const latestVersion = data.latestVersion;
    const ignoreVersion = data.ignoreVersion;
    if (latestVersion && UpdateChecker.compareVersions(currentVersion, latestVersion) && latestVersion !== ignoreVersion) {
      updatetext.textContent = Localize.getMessage('options_update_body', [latestVersion, currentVersion]);
      updatebox.style.display = 'block';
      if (updatenotif) {
        updatenotif.style.display = 'block';
        updatenotif.title = /** @type {any} */ (window).getI18nMessage('options_update_header');
      }
    }
  });

  /** @type {HTMLElement} */ (document.getElementById('update')).addEventListener('click', (e) => {
    EnvUtils.openExternalURL('https://github.com/Nawid3333/FastStream/releases');
  });

  /** @type {HTMLElement} */ (document.getElementById('noupdate')).addEventListener('click', (e) => {
    updatebox.style.display = 'none';
    if (updatenotif) updatenotif.style.display = 'none';
    chrome.storage.local.get('updateData', (result) => {
      const data = result?.updateData ? JSON.parse(/** @type {string} */ (result.updateData)) : {};
      data.ignoreVersion = data.latestVersion;
      chrome.storage.local.set({
        updateData: JSON.stringify(data),
      });
    });
  });
  // SPLICER:NO_UPDATE_CHECKER:REMOVE_END
}

