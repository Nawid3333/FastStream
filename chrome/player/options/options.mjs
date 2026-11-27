// @ts-check
import {DefaultKeybinds} from './defaults/DefaultKeybinds.mjs';
import {conflictPartners, keyDisplayName, keybindLabel} from './KeybindUtils.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {Localize} from '../modules/Localize.mjs';
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
import {AutomaticRamBudget, migrateStorage, optionsForStorageMode, StorageModes, storageModeOf} from './StorageMode.mjs';
import {AheadSteps, BehindSteps, MaxSizeSteps, RamOnlySteps, SpeedSteps, WholeVideo} from './SettingSteps.mjs';
import {StoredNow} from './StoredNow.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {ignoredPatternLines, ignoredUrlLines, showIgnoredLines} from './IgnoredLines.mjs';
import {BufferKeepChoices, bufferKeepLabel, bufferKeepSeconds} from './BufferKeep.mjs';

// Empty until loadOptions: the select menus below are built before it.
let Options = /** @type {typeof DefaultOptions} */ ({});
const playStreamURLs = /** @type {HTMLInputElement} */ (document.getElementById('playstreamurls'));
const playMP4URLs = /** @type {HTMLInputElement} */ (document.getElementById('playmp4urls'));
const keybindsList = /** @type {HTMLElement} */ (document.getElementById('keybindslist'));
const autoEnableURLSInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('autoEnableURLs'));
const mpvModeToggle = /** @type {HTMLInputElement} */ (document.getElementById('mpvModeSectionToggle'));
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
const loadAhead = /** @type {HTMLSelectElement} */ (document.getElementById('loadahead'));
const maxSize = /** @type {HTMLSelectElement} */ (document.getElementById('maxsize'));
const maxSizeRow = /** @type {HTMLElement} */ (document.getElementById('maxsizerow'));
const bufferBehind = /** @type {HTMLSelectElement} */ (document.getElementById('bufferbehind'));
const maxSpeed = /** @type {HTMLSelectElement} */ (document.getElementById('maxspeed'));
const storageRadios = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.storage-mode'));
const storageRamDiskDesc = /** @type {HTMLElement} */ (document.getElementById('storageramdiskdesc'));
const ramBudget = /** @type {HTMLSelectElement} */ (document.getElementById('rambudget'));
const ramBudgetRow = /** @type {HTMLElement} */ (document.getElementById('rambudgetrow'));
const ramBudgetDesc = /** @type {HTMLElement} */ (document.getElementById('rambudgetdesc'));
const bufferKeep = /** @type {HTMLSelectElement} */ (document.getElementById('bufferkeep'));
const storedNowBox = /** @type {HTMLElement} */ (document.getElementById('storednow'));
const storedNowText = /** @type {HTMLElement} */ (document.getElementById('storednowtext'));
const resetButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.section-reset'));
const seekStepSize = /** @type {HTMLInputElement} */ (document.getElementById('seekstepsize'));
const autoplayCountdown = /** @type {HTMLInputElement} */ (document.getElementById('autoplaycountdown'));
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
  mpvAllowlistInput.disabled = true;
  mpvPathInput.disabled = true;
  mpvFullscreenToggle.disabled = true;
  mpvPausePageToggle.disabled = true;
  mpvSingleInstanceToggle.disabled = true;
  mpvAutoplayNextToggle.disabled = true;
  mpvTestButton.disabled = true;
  /** @type {HTMLInputElement} */ (miniSize).disabled = true;
  autoplayCountdown.disabled = true;
}

/**
 * @param {Object} newOptions - The saved options merged over DefaultOptions.
 */
async function loadOptions(newOptions) {
  newOptions = newOptions || OptionsStore.get();
  Options = /** @type {typeof DefaultOptions} */ (newOptions);

  playStreamURLs.checked = !!Options.playStreamURLs;
  playMP4URLs.checked = !!Options.playMP4URLs;
  mpvModeToggle.checked = !!Options.mpvMode;
  mpvAllowlistInput.value = (Options.mpvAllowlist || []).join('\n');
  showIgnoredLines(mpvAllowlistInput, ignoredUrlLines);
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
  autoplayCountdown.value = /** @type {string} */ (/** @type {unknown} */ (Options.autoplayCountdown));
  blockPopupsWhilePlaying.checked = !!Options.blockPopupsWhilePlaying;
  showDownload();
  showStorage();
  bufferKeep.value = String(bufferKeepSeconds(Options.bufferKeep));
  seekStepSize.value = /** @type {any} */ (Math.round(Options.seekStepSize * 100) / 100);
  customSourcePatterns.value = Options.customSourcePatterns || '';
  showIgnoredLines(customSourcePatterns, ignoredPatternLines);
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
  showIgnoredLines(autoEnableURLSInput, ignoredUrlLines);

  if (Options.dev) {
    /** @type {HTMLElement} */ (document.getElementById('dev')).style.display = '';
  }
  markChanged();
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
  optionChanged();
  // The page's own save does not come back through loadOptions.
  if (mpvSuggestion) {
    mpvSuggestion.optionsChanged();
  }
};

mpvModeToggle.addEventListener('change', mpvModeChanged);

mpvAllowlistInput.addEventListener('change', (e) => {
  Options.mpvAllowlist = mpvAllowlistInput.value.split('\n').map((o)=>o.trim()).filter((o)=>o.length);
  mpvAllowlistInput.value = Options.mpvAllowlist.join('\n');
  showIgnoredLines(mpvAllowlistInput, ignoredUrlLines);
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

const BYTES_PER_MBIT_PER_S = 125000;

/**
 * @param {HTMLSelectElement} select
 * @param {Array<[string, string]>} choices - Each one's value and text.
 * @param {string} value
 */
function fillPicker(select, choices, value) {
  select.replaceChildren(...choices.map(([choice, text]) => {
    const option = document.createElement('option');
    option.value = choice;
    option.textContent = text;
    return option;
  }));
  select.value = value;
}

/** @param {number} seconds */
const durationText = (seconds) => bufferKeepLabel(seconds, Localize.getLanguage()) ?? String(seconds);

/** The download pickers as the options say; the largest size greyed unless the whole video is loaded. */
function showDownload() {
  fillPicker(loadAhead, [...AheadSteps.map((seconds) => /** @type {[string, string]} */ ([String(seconds), durationText(seconds)])),
    [WholeVideo, Localize.getMessage('options_storage_whole')]], Options.downloadAll ? WholeVideo : String(Options.bufferAhead));
  fillPicker(maxSize, MaxSizeSteps.map((bytes) => [String(bytes),
    bytes < 0 ? Localize.getMessage('options_general_nolimit') : StringUtils.formatSize(bytes)]), String(Options.maxVideoSize));
  maxSize.disabled = !Options.downloadAll;
  maxSizeRow.classList.toggle('disabled', !Options.downloadAll);
  fillPicker(bufferBehind, BehindSteps.map((seconds) => [String(seconds),
    seconds < 0 ? Localize.getMessage('options_storage_all') : durationText(seconds)]), String(Options.bufferBehind));
  fillPicker(maxSpeed, SpeedSteps.map((bytes) => [String(bytes), bytes < 0 ? Localize.getMessage('options_general_nolimit') :
    `${(bytes / BYTES_PER_MBIT_PER_S).toLocaleString()} Mbit/s`]), String(Options.maxSpeed));
}

/** The mode's radio and the RAM row: a limit to pick with "RAM only", else greyed with what it is. */
function showStorage() {
  const mode = storageModeOf(Options);
  for (const radio of storageRadios) radio.checked = radio.value === mode;
  // The automatic amount, unless one was saved by hand since the migration.
  const ramDiskBudget = mode === StorageModes.RAM_THEN_DISK ? Options.ramBudget : AutomaticRamBudget;
  storageRamDiskDesc.textContent = Localize.getMessage('options_general_storage_ramdisk_hint', [StringUtils.formatSize(ramDiskBudget)]);
  const ramOnly = mode === StorageModes.RAM_ONLY;
  if (ramOnly) {
    fillPicker(ramBudget, RamOnlySteps.map((bytes) => [String(bytes), StringUtils.formatSize(bytes)]), String(Options.ramBudget));
  } else {
    fillPicker(ramBudget, [['', mode === StorageModes.DISK_ONLY ? Localize.getMessage('options_storage_ram_unused') :
      Localize.getMessage('options_storage_ram_auto', [StringUtils.formatSize(ramDiskBudget)])]], '');
  }
  ramBudget.disabled = !ramOnly;
  ramBudgetRow.classList.toggle('disabled', !ramOnly);
  ramBudgetDesc.textContent = Localize.getMessage(ramOnly ? 'options_storage_ram_ramonly_desc' : 'options_storage_ram_auto_desc');
}

loadAhead.addEventListener('change', () => {
  Options.downloadAll = loadAhead.value === WholeVideo;
  // With the whole video, the default is what a video too large for the room keeps at least (migrateStorage).
  Options.bufferAhead = Options.downloadAll ? DefaultOptions.bufferAhead : Number(loadAhead.value);
  showDownload();
  optionChanged();
});

maxSize.addEventListener('change', () => {
  Options.maxVideoSize = Number(maxSize.value);
  optionChanged();
});

bufferBehind.addEventListener('change', () => {
  Options.bufferBehind = Number(bufferBehind.value);
  optionChanged();
});

maxSpeed.addEventListener('change', () => {
  Options.maxSpeed = Number(maxSpeed.value);
  optionChanged();
});

for (const radio of storageRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    Object.assign(Options, optionsForStorageMode(radio.value, Options));
    showStorage();
    optionChanged();
  });
}

ramBudget.addEventListener('change', () => {
  if (storageModeOf(Options) !== StorageModes.RAM_ONLY) return;
  Options.ramBudget = Number(ramBudget.value);
  optionChanged();
});

// Fixed steps up to an hour (BufferKeep.mjs): no other value can be picked.
for (const seconds of BufferKeepChoices) {
  const option = document.createElement('option');
  option.value = String(seconds);
  option.textContent = bufferKeepLabel(seconds, Localize.getLanguage()) ?? Localize.getMessage('options_general_bufferkeep_off');
  bufferKeep.append(option);
}

bufferKeep.addEventListener('change', () => {
  Options.bufferKeep = bufferKeepSeconds(Number(bufferKeep.value));
  optionChanged();
});

/** A dot at each setting that differs from its default, and its section's reset button while one does. */
function markChanged() {
  /** @type {Object<string, *>} */
  const options = Options;
  /** @type {Object<string, *>} */
  const defaults = DefaultOptions;
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-keys]'))) {
    // A greyed setting does nothing now: the choice above it is what changed.
    const changed = !row.classList.contains('disabled') && (row.dataset.keys || '').split(',')
        .some((key) => JSON.stringify(options[key]) !== JSON.stringify(defaults[key]));
    row.classList.toggle('changed', changed);
    const label = /** @type {?HTMLElement} */ (row.querySelector('.label'));
    if (label) label.title = changed ? Localize.getMessage('options_changed') : '';
  }
  for (const button of resetButtons) {
    button.hidden = !button.closest('section')?.querySelector('[data-keys].changed');
  }
}

for (const button of resetButtons) {
  button.addEventListener('click', () => {
    /** @type {Object<string, *>} */
    const options = Options;
    /** @type {Object<string, *>} */
    const defaults = DefaultOptions;
    const section = /** @type {HTMLElement} */ (button.closest('section'));
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (section.querySelectorAll('[data-keys]'))) {
      for (const key of (row.dataset.keys || '').split(',')) options[key] = structuredClone(defaults[key]);
    }
    loadOptions(Options);
    optionChanged();
  });
}

// Also with no OPFS (a private window's player refuses it): its RAM is still shown.
const storedNow = EnvUtils.isExtension() ? new StoredNow({
  box: storedNowBox,
  show: (disk, ram, players) => {
    storedNowText.textContent = Localize.getMessage('options_storage_stored',
        [StringUtils.formatSize(disk), StringUtils.formatSize(ram), String(players)]);
  },
}) : null;

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

[seekStepSize, replaceDelay, miniSize, maxdownloaders, mpvPathInput, autoplayCountdown].forEach(saveWhileTyping);

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
  // The seek step is this section's too.
  Options.seekStepSize = DefaultOptions.seekStepSize;
  seekStepSize.value = /** @type {any} */ (Options.seekStepSize);
  renderKeybinds();
  optionChanged();
});

WebUtils.setupTabIndex(/** @type {HTMLElement} */ (document.getElementById('resetdefault')));

autoEnableURLSInput.addEventListener('change', (e) => {
  Options.autoEnableURLs = autoEnableURLSInput.value.split('\n').map((o)=>o.trim()).filter((o)=>o.length);
  autoEnableURLSInput.value = Options.autoEnableURLs.join('\n');
  showIgnoredLines(autoEnableURLSInput, ignoredUrlLines);
  optionChanged();
});

customSourcePatterns.addEventListener('change', (e) => {
  Options.customSourcePatterns = customSourcePatterns.value;
  showIgnoredLines(customSourcePatterns, ignoredPatternLines);
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
  // Always, whatever storageVersion the file names: it comes from outside, and only saved settings keep what was
  // saved since the migration.
  migrateStorage(newOptions, null);
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
  markChanged();
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
  let intersecting = false;
  const seenNow = () => storedNow?.setSeen(intersecting && !document.hidden);
  const o = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && optionsLoaded) loadOptions(OptionsStore.get());
    if (entry.isIntersecting) {
      pageSeen = true;
      offerMpvWhenReady();
      cloudSettings.pageSeen();
    }
    intersecting = entry.isIntersecting;
    seenNow();
  });
  o.observe(document.body);
  document.addEventListener('visibilitychange', seenNow);

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

