import {DefaultKeybinds} from './defaults/DefaultKeybinds.mjs';
import {conflictPartners, keybindLabel} from './KeybindUtils.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
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
import {DaltonizerTypes} from './defaults/DaltonizerTypes.mjs';
import {DefaultToolSettings} from './defaults/ToolSettings.mjs';
import {DefaultQualities} from './defaults/DefaultQualities.mjs';
import {ColorThemes} from './defaults/ColorThemes.mjs';

let Options = {};
const analyzeVideos = document.getElementById('analyzevideos');
const playStreamURLs = document.getElementById('playstreamurls');
const playMP4URLs = document.getElementById('playmp4urls');
const downloadAll = document.getElementById('downloadall');
const keybindsList = document.getElementById('keybindslist');
const autoEnableURLSInput = document.getElementById('autoEnableURLs');
const mpvModeToggle = document.getElementById('mpvmode');
const mpvModeSectionToggle = document.getElementById('mpvModeSectionToggle');
const mpvAllowlistInput = document.getElementById('mpvAllowlist');
const mpvPathInput = document.getElementById('mpvpath');
const mpvFullscreenToggle = document.getElementById('mpvfullscreen');
const mpvPausePageToggle = document.getElementById('mpvpausepage');
const mpvSingleInstanceToggle = document.getElementById('mpvsingleinstance');
const mpvTestButton = document.getElementById('mpvtest');
const mpvTestResult = document.getElementById('mpvtestresult');
const autoSub = document.getElementById('autosub');
const maxSpeed = document.getElementById('maxspeed');
const maxSize = document.getElementById('maxsize');
const bufferAhead = document.getElementById('bufferahead');
const bufferBehind = document.getElementById('bufferbehind');
const seekStepSize = document.getElementById('seekstepsize');
const autoplayNext = document.getElementById('autoplaynext');
const blockPopupsWhilePlaying = document.getElementById('blockpopupswhileplaying');
const qualityMenu = document.getElementById('quality');
const importButton = document.getElementById('import');
const exportButton = document.getElementById('export');
const clickAction = document.getElementById('clickaction');
const dblclickAction = document.getElementById('dblclickaction');
const tplclickAction = document.getElementById('tplclickaction');
const visChangeAction = document.getElementById('vischangeaction');
const customSourcePatterns = document.getElementById('customSourcePatterns');
const showWhenMiniSelected = document.getElementById('showWhenMiniSelected');
const storeProgress = document.getElementById('storeprogress');
const miniSize = document.getElementById('minisize');
const miniPos = document.getElementById('minipos');
const daltonizerType = document.getElementById('daltonizerType');
const daltonizerStrength = document.getElementById('daltonizerStrength');
const previewEnabled = document.getElementById('previewenabled');
const decodingAwareQuality = document.getElementById('decodingawarequality');
const replaceDelay = document.getElementById('replacedelay');
const colorTheme = document.getElementById('colortheme');
const optionsSearchBar = document.getElementById('searchbar');
const optionsResetButton = document.getElementById('resetsearch');
const maxdownloaders = document.getElementById('maxdownloaders');
autoEnableURLSInput.setAttribute('autocapitalize', 'off');
autoEnableURLSInput.setAttribute('autocomplete', 'off');
autoEnableURLSInput.setAttribute('autocorrect', 'off');
autoEnableURLSInput.setAttribute('spellcheck', false);
autoEnableURLSInput.placeholder = 'https://example.com/movie/\n~^https:\\/\\/example\\.com\\/(movie|othermovie)\\/';

mpvAllowlistInput.setAttribute('autocapitalize', 'off');
mpvAllowlistInput.setAttribute('autocomplete', 'off');
mpvAllowlistInput.setAttribute('autocorrect', 'off');
mpvAllowlistInput.setAttribute('spellcheck', false);
mpvAllowlistInput.placeholder = 'https://netflix.com\nhttps://crunchyroll.com @anime\n~^https:\\/\\/example\\.com\\/movie\\/';

customSourcePatterns.setAttribute('autocapitalize', 'off');
customSourcePatterns.setAttribute('autocomplete', 'off');
customSourcePatterns.setAttribute('autocorrect', 'off');
customSourcePatterns.setAttribute('spellcheck', false);
customSourcePatterns.placeholder = '# This is a comment. Use the following format.\n[file extension] /[regex]/[flags]';

// Initialize store and then load page controls
// Until the saved options are read, OptionsStore.get() gives the defaults. Showing those, even
// for a moment, would let a change made then save the defaults over the user's options.
let optionsLoaded = false;
OptionsStore.init().then(() => {
  optionsLoaded = true;
  loadOptions(OptionsStore.get());
  // Lets the e2e specs wait for the saved options instead of guessing when they arrived.
  document.documentElement.dataset.optionsLoaded = 'true';
}).catch((e) => console.error('Loading the saved options failed', e));


if (!EnvUtils.isExtension()) {
  analyzeVideos.disabled = true;
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
  mpvTestButton.disabled = true;
  miniSize.disabled = true;
  autoplayNext.disabled = true;
}

async function loadOptions(newOptions) {
  newOptions = newOptions || OptionsStore.get();
  Options = newOptions;

  downloadAll.checked = !!Options.downloadAll;
  analyzeVideos.checked = !!Options.analyzeVideos;
  playStreamURLs.checked = !!Options.playStreamURLs;
  playMP4URLs.checked = !!Options.playMP4URLs;
  mpvModeToggle.checked = !!Options.mpvMode;
  mpvModeSectionToggle.checked = !!Options.mpvMode;
  mpvAllowlistInput.value = (Options.mpvAllowlist || []).join('\n');
  mpvPathInput.value = Options.mpvPath || '';
  mpvFullscreenToggle.checked = !!Options.mpvFullscreen;
  mpvPausePageToggle.checked = !!Options.mpvPausePage;
  mpvSingleInstanceToggle.checked = !!Options.mpvSingleInstance;
  previewEnabled.checked = !!Options.previewEnabled;
  // On unless turned off: options saved before it existed have no value for it.
  decodingAwareQuality.checked = Options.decodingAwareQuality !== false;
  autoSub.checked = !!Options.autoEnableBestSubtitles;
  autoplayNext.checked = !!Options.autoplayNext;
  blockPopupsWhilePlaying.checked = !!Options.blockPopupsWhilePlaying;
  maxSpeed.value = StringUtils.getSpeedString(Options.maxSpeed, true);
  maxSize.value = StringUtils.getSizeString(Options.maxVideoSize);
  bufferAhead.value = Options.bufferAhead;
  bufferBehind.value = Options.bufferBehind;
  seekStepSize.value = Math.round(Options.seekStepSize * 100) / 100;
  customSourcePatterns.value = Options.customSourcePatterns || '';
  miniSize.value = Options.miniSize;
  storeProgress.checked = !!Options.storeProgress;
  replaceDelay.value = Options.replaceDelay;
  maxdownloaders.value = Options.maximumDownloaders;

  setSelectMenuValue(daltonizerType, Options.videoDaltonizerType);
  setSelectMenuValue(clickAction, Options.singleClickAction);
  setSelectMenuValue(dblclickAction, Options.doubleClickAction);
  setSelectMenuValue(tplclickAction, Options.tripleClickAction);
  setSelectMenuValue(visChangeAction, Options.visChangeAction);
  setSelectMenuValue(colorTheme, Options.colorTheme);
  setSelectMenuValue(miniPos, Options.miniPos);
  setSelectMenuValue(qualityMenu, Options.defaultQuality);

  document.body.dataset.theme = Options.colorTheme;

  if (Options.visChangeAction === VisChangeActions.MINI_PLAYER) {
    showWhenMiniSelected.style.display = '';
  } else {
    showWhenMiniSelected.style.display = 'none';
  }

  if (Options.videoDaltonizerType === DaltonizerTypes.NONE) {
    daltonizerStrength.style.display = 'none';
  } else {
    daltonizerStrength.style.display = '';
  }

  if (Options.keybinds) {
    renderKeybinds();
  }

  document.querySelectorAll('.video-option').forEach((option) => {
    const numberInput = option.querySelector('input.number');
    const rangeInput = option.querySelector('input.range');
    const unit = option.dataset.unit || '%';
    const unitMultiplier = parseInt(option.dataset.multiplier || 100);
    const optionKey = option.dataset.option;
    const val = Math.round(Options[optionKey] * unitMultiplier);
    rangeInput.value = val;
    numberInput.value = val + unit;
  });

  autoEnableURLSInput.value = Options.autoEnableURLs.join('\n');

  if (Options.dev) {
    document.getElementById('dev').style.display = '';
  }
  initsearch();
  // initsearch() shows every row again; a query still in the box applies again.
  if (optionsSearchBar.value) {
    searchWithQuery(optionsSearchBar.value);
  }
}

function createSelectMenu(container, options, selected, localPrefix, callback) {
  container.replaceChildren();
  const select = document.createElement('select');
  // The wrapper carries the label (data-i18n-label), but a screen reader names the select:
  // the eight menus were read as a bare "combo box".
  if (container.dataset.i18nLabel) {
    select.setAttribute('aria-label', Localize.getMessage(container.dataset.i18nLabel));
  }
  for (const option of options) {
    const optionElement = document.createElement('option');
    optionElement.value = option;
    optionElement.textContent = localPrefix !== null ? Localize.getMessage(localPrefix + '_' + option) : option;
    if (option === selected) {
      optionElement.selected = true;
    }
    select.appendChild(optionElement);
  }
  select.addEventListener('change', callback);
  container.appendChild(select);
}

function setSelectMenuValue(container, value) {
  const select = container.querySelector('select');
  if (!select) {
    return;
  }
  select.value = value;
}

createSelectMenu(daltonizerType, Object.values(DaltonizerTypes), Options.videoDaltonizerType, 'options_video_daltonizer', (e) => {
  Options.videoDaltonizerType = e.target.value;
  if (Options.videoDaltonizerType === DaltonizerTypes.NONE) {
    daltonizerStrength.style.display = 'none';
  } else {
    daltonizerStrength.style.display = '';
  }
  optionChanged();
});

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

createSelectMenu(miniPos, Object.values(MiniplayerPositions), Options.miniPos, 'options_general_minipos', (e) => {
  Options.miniPos = e.target.value;
  optionChanged();
});

createSelectMenu(qualityMenu, Object.values(DefaultQualities), Options.defaultQuality, null, (e) => {
  Options.defaultQuality = e.target.value;
  optionChanged();
});

document.querySelectorAll('.option').forEach((option) => {
  option.addEventListener('click', (e) => {
    if (e.target.tagName !== 'INPUT') {
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
  if (input) {
    WebUtils.setupTabIndex(input);
  }
});

document.querySelectorAll('.video-option').forEach((option) => {
  const numberInput = option.querySelector('input.number');
  const rangeInput = option.querySelector('input.range');
  const unit = option.dataset.unit || '%';
  const unitMultiplier = parseInt(option.dataset.multiplier || 100);

  const optionKey = option.dataset.option;

  function numberInputChanged() {
    const value = parseInt(numberInput.value.replace(unit, '')) || 0;
    rangeInput.value = value;
    Options[optionKey] = (option.dataset.nolimits ? value : parseInt(rangeInput.value)) / unitMultiplier;
    optionChanged();
  }

  function rangeInputChanged() {
    numberInput.value = rangeInput.value + unit;
    Options[optionKey] = parseInt(rangeInput.value) / unitMultiplier;
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
 * Marks every action whose key another action shares, and says which. A press fires all
 * of them, which is never what anyone meant; nothing stops the choice, since the user may
 * be halfway through rearranging.
 */
function refreshKeybindConflicts() {
  const partners = conflictPartners(Options.keybinds);
  keybindsList.querySelectorAll('.keybind-container').forEach((container) => {
    const others = partners.get(container.dataset.keybind);
    const warning = container.querySelector('.keybind-warning');
    container.classList.toggle('keybind-conflict', !!others);
    warning.hidden = !others;
    warning.textContent = others ? Localize.getMessage('options_keybinds_conflict', [others.map(keybindLabel).join(', ')]) : '';
  });
}

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
  keybindInput.textContent = Options.keybinds[keybind];

  keybindInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      return;
    } else if (e.key === 'Escape') {
      keybindInput.textContent = Options.keybinds[keybind] = 'None';
      refreshKeybindConflicts();
      optionChanged();
      keybindInput.blur();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    // A press with no key code (some virtual keyboards, unmapped keys) names no key: it was
    // saved as '', and every such press in the player fired the action.
    if (!e.code && e.key !== ' ') {
      return;
    }
    keybindInput.textContent = WebUtils.getKeyString(e);
    Options.keybinds[keybind] = keybindInput.textContent;
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
    keybindInput.textContent = Options.keybinds[keybind];
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
  document.getElementById('welcome').href = chrome.runtime.getURL('welcome.html');
} else {
  // The web build has no welcome page (build.mjs leaves it out): the link was a 404.
  document.getElementById('welcomeitem').style.display = 'none';
}

playMP4URLs.addEventListener('change', () => {
  Options.playMP4URLs = playMP4URLs.checked;
  optionChanged();
});

autoSub.addEventListener('change', () => {
  Options.autoEnableBestSubtitles = autoSub.checked;
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

/**
 * Whether the mpv path typed on this page names the mpv the host found: the same file,
 * or the folder it is in (the host accepts both), whatever the case and slashes.
 * @param {string} typed - The path typed above.
 * @param {string} found - The mpv.exe the host found.
 * @return {boolean} True when they are the same mpv.
 */
function samePath(typed, found) {
  const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(typed) === norm(found) || norm(typed) + '\\mpv.exe' === norm(found);
}

mpvTestButton.addEventListener('click', () => {
  mpvTestResult.textContent = '...';
  const sendTest = () => {
    chrome.runtime.sendMessage({type: 'MPV_TEST'}, (response) => {
      if (chrome.runtime.lastError || !response) {
        mpvTestResult.textContent = window.getI18nMessage('options_mpv_test_fail');
        return;
      }
      if (response.ok && response.mpv && typeof response.path === 'string') {
        // Which mpv the host found: a path set above that does not exist falls back to
        // the host's config.json and the usual install folders, and "mpv found" alone
        // hid that.
        const typed = mpvPathInput.value.trim();
        mpvTestResult.textContent = !typed || samePath(typed, response.path) ?
          window.getI18nMessage('options_mpv_test_ok_at', [response.path]) :
          window.getI18nMessage('options_mpv_test_otherpath', [response.path]);
      } else if (response.ok && response.mpv) {
        mpvTestResult.textContent = window.getI18nMessage('options_mpv_test_ok');
      } else if (response.ok) {
        mpvTestResult.textContent = window.getI18nMessage('options_mpv_test_nompv');
      } else {
        mpvTestResult.textContent = window.getI18nMessage('options_mpv_test_fail');
      }
      // The host answered as an older version than this extension was released with
      // (MpvBackend's RequiredHostVersion): the copy on this PC was not installed again
      // after the host changed.
      if (response.ok && response.hostOutdated) {
        mpvTestResult.textContent += ' ' + window.getI18nMessage('options_mpv_test_outdated');
      }
      // An mpv the host started is open: which decoder it plays with, as mpv says. On the
      // processor, only a hint: mpv.conf is the user's, and FastStream never overrides it.
      if (response.ok && response.decoder && typeof response.decoderText === 'string') {
        const key = response.decoder.hardware ? 'options_mpv_test_decoder_hw' : 'options_mpv_test_decoder_sw';
        const what = response.decoderText || String(response.decoder.api || '');
        mpvTestResult.textContent += ' ' + window.getI18nMessage(key, [what]);
      }
    });
  };
  if (chrome.permissions && chrome.permissions.contains) {
    chrome.permissions.contains({permissions: ['nativeMessaging']}, (has) => {
      if (has) {
        sendTest();
      } else {
        chrome.permissions.request({permissions: ['nativeMessaging']}, (granted) => {
          if (granted) {
            sendTest();
          } else {
            mpvTestResult.textContent = window.getI18nMessage('options_mpv_test_fail');
          }
        });
      }
    });
  } else {
    sendTest();
  }
});

analyzeVideos.addEventListener('change', () => {
  Options.analyzeVideos = analyzeVideos.checked;
  optionChanged();
});

downloadAll.addEventListener('change', () => {
  Options.downloadAll = downloadAll.checked;
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

storeProgress.addEventListener('change', () => {
  Options.storeProgress = storeProgress.checked;
  optionChanged();
});

autoplayNext.addEventListener('change', () => {
  Options.autoplayNext = autoplayNext.checked;
  sessionStorage.removeItem('autoplayNext');
  optionChanged();
});

blockPopupsWhilePlaying.addEventListener('change', () => {
  Options.blockPopupsWhilePlaying = blockPopupsWhilePlaying.checked;
  optionChanged();
});

maxSpeed.addEventListener('change', () => {
  // parse value, number unit/s
  Options.maxSpeed = StringUtils.getSpeedValue(maxSpeed.value);
  maxSpeed.value = StringUtils.getSpeedString(Options.maxSpeed, true);
  optionChanged();
});

maxSize.addEventListener('change', () => {
  // parse value, number unit
  Options.maxVideoSize = StringUtils.getSizeValue(maxSize.value);
  maxSize.value = StringUtils.getSizeString(Options.maxVideoSize);
  optionChanged();
});

/**
 * A number field's value within its limits, or the default when it holds no number, shown
 * back in the field. An emptied "Seek step size" or "Replace delay" was saved as NaN, and a
 * negative one as it was.
 * @param {HTMLInputElement} input - The field.
 * @param {number} fallback - The value for an empty or unreadable field.
 * @param {number} min - The smallest value allowed.
 * @param {number} [max] - The largest value allowed.
 * @param {boolean} [whole] - Whole numbers only.
 * @return {number}
 */
function readNumberField(input, fallback, min, max = Infinity, whole = false) {
  const value = whole ? parseInt(input.value) : parseFloat(input.value);
  const result = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
  input.value = result;
  return result;
}

bufferAhead.addEventListener('change', () => {
  Options.bufferAhead = readNumberField(bufferAhead, 0, 0, Infinity, true);
  optionChanged();
});

bufferBehind.addEventListener('change', () => {
  Options.bufferBehind = readNumberField(bufferBehind, 0, 0, Infinity, true);
  optionChanged();
});

seekStepSize.addEventListener('change', () => {
  Options.seekStepSize = readNumberField(seekStepSize, DefaultOptions.seekStepSize, 0.1, 3600);
  optionChanged();
});

replaceDelay.addEventListener('change', () => {
  Options.replaceDelay = readNumberField(replaceDelay, DefaultOptions.replaceDelay, 0, 60000, true);
  optionChanged();
});

miniSize.addEventListener('change', () => {
  Options.miniSize = readNumberField(miniSize, 0.25, 0.01, 1);
  optionChanged();
});

// 1 to 6, the browser's limit per server; 0 or less is the default, as the downloader reads
// it. 0 meant "never add one" to the downloader and "no limit" to the add-downloader key.
maxdownloaders.addEventListener('change', () => {
  if (!(parseInt(maxdownloaders.value) > 0)) {
    maxdownloaders.value = '';
  }
  Options.maximumDownloaders = readNumberField(maxdownloaders, DefaultOptions.maximumDownloaders, 1, 6, true);
  optionChanged();
});

optionsSearchBar.placeholder = Localize.getMessage('options_search_placeholder');


// Once per change of the text, pasted or dropped too. keydown and keyup searched twice per
// key, keydown for the text before the key.
optionsSearchBar.addEventListener('input', () => {
  if (optionsSearchBar.value == '') {
    resetSearch();
  } else {
    searchWithQuery(optionsSearchBar.value);
  }
});

optionsResetButton.addEventListener('click', () => {
  optionsSearchBar.value = '';
  resetSearch();
});

document.getElementById('resetdefault').addEventListener('click', () => {
  Options.keybinds = structuredClone(DefaultKeybinds);
  renderKeybinds();
  optionChanged();
});

WebUtils.setupTabIndex(document.getElementById('resetdefault'));

autoEnableURLSInput.addEventListener('change', (e) => {
  Options.autoEnableURLs = autoEnableURLSInput.value.split('\n').map((o)=>o.trim()).filter((o)=>o.length);
  autoEnableURLSInput.value = Options.autoEnableURLs.join('\n');
  optionChanged();
});

customSourcePatterns.addEventListener('change', (e) => {
  Options.customSourcePatterns = customSourcePatterns.value;
  optionChanged();
});

importButton.addEventListener('click', () => {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.json';
  picker.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      let newOptionsObj;
      try {
        newOptionsObj = JSON.parse(e.target.result);
      } catch (err) {
        newOptionsObj = null;
      }
      // Valid JSON that is no settings object (null, a list, a number) threw further down,
      // and the import failed without a word.
      if (!newOptionsObj || typeof newOptionsObj !== 'object' || Array.isArray(newOptionsObj)) {
        alert(Localize.getMessage('options_import_invalid'));
        return;
      }
      const newOptions = Utils.migrateKeybinds(Utils.mergeOptions(DefaultOptions, newOptionsObj), newOptionsObj);
      const subtitlesSettings = Utils.mergeOptions(DefaultSubtitlesSettings, newOptionsObj.subtitlesSettings || {});
      const toolSettings = Utils.mergeOptions(DefaultToolSettings, newOptionsObj.toolSettings || {});
      loadOptions(newOptions);
      optionChanged();

      Utils.setConfig('subtitlesSettings', JSON.stringify(subtitlesSettings));
      Utils.setConfig('toolSettings', JSON.stringify(toolSettings));
    };
    reader.readAsText(file);
  });
  document.body.appendChild(picker);
  picker.click();
  picker.remove();
});

exportButton.addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify({
    ...(await Utils.getOptionsFromStorage()),
    subtitlesSettings: await Utils.getSubtitlesSettingsFromStorage(),
    toolSettings: await Utils.loadAndParseOptions('toolSettings', DefaultToolSettings),
  }, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  Utils.downloadURL(url, 'faststream-options.json', true);
  URL.revokeObjectURL(url);
});

// The options this page last saved. The store tells its listeners about the page's own
// saves too, and redrawing the page then rebuilt every keybind row (the box a key was
// just pressed in lost focus), rewrote a number field after each key typed (the caret
// jumped to the end) and undid a search; the page already shows what it saved.
let ownSave = null;

function optionChanged() {
  // Before the saved options are read, Options holds only what was just changed, and
  // saving it would put the defaults over everything else the user had set.
  if (!optionsLoaded) {
    return;
  }
  // Centralized save/broadcast. replace() takes the options before it saves them.
  OptionsStore.replace(Options);
  ownSave = OptionsStore.get();
}

const versionDiv = document.getElementById('version');
versionDiv.textContent = `FastStream v${EnvUtils.getVersion()}`;

// if in iframe, add the frame class to body
if (parent !== window) {
  document.body.classList.add('frame');
}

// React to external changes via OptionsStore
OptionsStore.subscribe((options) => {
  if (options !== ownSave) {
    loadOptions(options);
  }
});

if (EnvUtils.isExtension()) {
  // Also refresh when becoming visible to catch recent changes
  const o = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && optionsLoaded) loadOptions(OptionsStore.get());
  });
  o.observe(document.body);

  // SPLICER:NO_UPDATE_CHECKER:REMOVE_START
  const updatebox = document.getElementById('updatebox');
  const updatetext = document.getElementById('updatetext');
  const updatenotif = parent.document ? parent.document.getElementById('update_notif_banner') : null;

  chrome.storage.local.get({
    updateData: '{}',
  }, async (result) => {
    const data = result?.updateData ? JSON.parse(result.updateData) : {};
    const now = Date.now();
    if (!data.latestVersion || now - data.lastUpdateCheck > 1000 * 60 * 60 * 12) {
      data.latestVersion = await UpdateChecker.getLatestVersion();
      data.lastUpdateCheck = now;
    }

    chrome.storage.local.set({
      updateData: JSON.stringify(data),
    });

    const currentVersion = EnvUtils.getVersion();
    const latestVersion = data.latestVersion;
    const ignoreVersion = data.ignoreVersion;
    if (latestVersion && UpdateChecker.compareVersions(currentVersion, latestVersion) && latestVersion !== ignoreVersion) {
      updatetext.textContent = Localize.getMessage('options_update_body', [latestVersion, currentVersion]);
      updatebox.style.display = 'block';
      if (updatenotif) updatenotif.style.display = 'block';
    }
  });

  document.getElementById('update').addEventListener('click', (e) => {
    chrome.tabs.create({
      url: 'https://github.com/Nawid3333/FastStream/releases',
    });
  });

  document.getElementById('noupdate').addEventListener('click', (e) => {
    updatebox.style.display = 'none';
    if (updatenotif) updatenotif.style.display = 'none';
    chrome.storage.local.get('updateData', (result) => {
      const data = result?.updateData ? JSON.parse(result.updateData) : {};
      data.ignoreVersion = data.latestVersion;
      chrome.storage.local.set({
        updateData: JSON.stringify(data),
      });
    });
  });
  // SPLICER:NO_UPDATE_CHECKER:REMOVE_END
}

