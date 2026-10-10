import {DefaultKeybinds} from './defaults/DefaultKeybinds.mjs';
import {conflictPartners, keybindLabel} from './KeybindUtils.mjs';
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
import {ColorThemes} from './defaults/ColorThemes.mjs';
import {MpvSuggestion} from './MpvSuggestion.mjs';

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
const maxSizeUnit = document.getElementById('maxsizeunit');
const ramBudget = document.getElementById('rambudget');
const ramBudgetUnit = document.getElementById('rambudgetunit');
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
mpvAllowlistInput.placeholder = 'netflix.com\ncrunchyroll.com @anime\nhttps://example.com/films/\n~^https:\\/\\/example\\.com\\/movie\\/';

customSourcePatterns.setAttribute('autocapitalize', 'off');
customSourcePatterns.setAttribute('autocomplete', 'off');
customSourcePatterns.setAttribute('autocorrect', 'off');
customSourcePatterns.setAttribute('spellcheck', false);
customSourcePatterns.placeholder = '# This is a comment. Use the following format.\n[file extension] /[regex]/[flags]';

// Initialize store and then load page controls
// Until the saved options are read, OptionsStore.get() gives the defaults. Showing those, even
// for a moment, would let a change made then save the defaults over the user's options.
let optionsLoaded = false;
// The offer to turn MPV mode on (MpvSuggestion.mjs): extension only, outside the update
// banner's SPLICER block so the AMO build has it too. The host is asked once the saved
// options are read (MPV mode may be on) and the page was seen (the options page is an
// iframe in every player too, and most of those are never opened).
const mpvSuggestion = EnvUtils.isExtension() ? new MpvSuggestion({
  box: document.getElementById('mpvsuggestbox'),
  text: document.getElementById('mpvsuggesttext'),
  enableButton: document.getElementById('mpvsuggestyes'),
  dismissLink: document.getElementById('mpvsuggestno'),
  isMpvModeOn: () => !!Options.mpvMode,
  turnOnMpvMode: () => {
    mpvModeToggle.checked = true;
    mpvModeChanged();
  },
}) : null;
let pageSeen = false;
// Firefox's word for the system, for the mpv helper's steps (EnvUtils.isWindows).
EnvUtils.os();
const offerMpvWhenReady = () => {
  if (mpvSuggestion && optionsLoaded && pageSeen) {
    mpvSuggestion.check().catch((e) => console.error('Asking the mpv host failed', e));
  }
};
OptionsStore.init().then(() => {
  optionsLoaded = true;
  loadOptions(OptionsStore.get());
  offerMpvWhenReady();
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
  maxSize.disabled = !downloadAll.checked;
  maxSizeUnit.disabled = !downloadAll.checked;
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
  showSpeed(Options.maxSpeed);
  showSize(maxSize, maxSizeUnit, Options.maxVideoSize);
  showSize(ramBudget, ramBudgetUnit, Options.ramBudget);
  showSeconds(bufferAhead, Options.bufferAhead);
  showSeconds(bufferBehind, Options.bufferBehind);
  seekStepSize.value = Math.round(Options.seekStepSize * 100) / 100;
  customSourcePatterns.value = Options.customSourcePatterns || '';
  // A part of the player, shown in percent: 0.25 left users typing 25, which was 100%.
  miniSize.value = Math.round(Options.miniSize * 1000) / 10;
  storeProgress.checked = !!Options.storeProgress;
  replaceDelay.value = Options.replaceDelay;
  maxdownloaders.value = Options.maximumDownloaders;

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
  // MPV mode turned on another way ends the offer.
  if (mpvSuggestion) {
    mpvSuggestion.optionsChanged();
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
    // A unit picker beside a number takes its own clicks.
    if (e.target.tagName !== 'INPUT' && !e.target.closest('select')) {
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
    const text = numberInput.value.replace(unit, '').trim();
    const value = parseInt(text);
    // An emptied field is no value: clearing it to type a new one saved 0 at once, an
    // invisible (zoom) or black (brightness) video until the next key. Left so, the field
    // shows the value set again (the change handler).
    if (text === '' || !Number.isFinite(value)) return;
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

/**
 * Whether the mpv path typed on this page names the mpv the host found: the same file,
 * or the folder it is in (the host accepts both), whatever the case and slashes.
 * @param {string} typed - The path typed above.
 * @param {string} found - The mpv.exe the host found.
 * @return {boolean} True when they are the same mpv.
 */
function samePath(typed, found) {
  const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  // A folder: mpv.exe in it on Windows, mpv on Linux (/usr/bin for /usr/bin/mpv said "found
  // at another path").
  return norm(typed) === norm(found) || norm(typed) + '\\mpv.exe' === norm(found) ||
    norm(typed) + '\\mpv' === norm(found);
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
        // The steps differ: Windows has a Start menu entry, Linux and macOS a manifest.
        mpvTestResult.textContent += ' ' + window.getI18nMessage(EnvUtils.isWindows() ?
          'options_mpv_test_outdated' : 'options_mpv_test_outdated_unix');
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
  // The size limit applies to predownloading only; without it "Buffer ahead" decides (#378).
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

// The speed and the two sizes are a number with a unit beside it: typed as text, "10 Mb",
// "10 Mo" and "10" left users unsure what the field took (#378). The values are kept as
// before: bytes per second, bytes, -1 for no limit. An empty field is no limit, and 0 is
// none: 0 Mbit/s downloads nothing ahead, 0 MB predownloads nothing, 0 MB of RAM keeps
// nothing ahead in RAM. 0 read as "no limit" surprised the user who typed it to turn a
// thing off (2026-10-09).
const BYTES_PER_MBIT_PER_S = 1000000 / 8;
const GB = 1000 ** 3;

/**
 * Shows the maximum speed in Mbit/s, as speed tests give it; nothing (no limit) for -1.
 * @param {number} bytesPerSecond
 */
function showSpeed(bytesPerSecond) {
  maxSpeed.value = bytesPerSecond >= 0 ? String(Math.round(bytesPerSecond / BYTES_PER_MBIT_PER_S * 1000) / 1000) : '';
  showLimitHint(maxSpeed, bytesPerSecond);
}

// What a limit of 0, or no limit, does, under the field: both are easy to set without
// meaning to, and their effect is not visible on the page.
const LIMIT_HINTS = {
  maxspeed: {zero: 'options_general_targetspeed_zero'},
  maxsize: {zero: 'options_general_maxsize_zero'},
  rambudget: {zero: 'options_general_rambudget_zero', none: 'options_general_rambudget_none'},
  bufferahead: {zero: 'options_general_bufferahead_zero', none: 'options_general_bufferahead_none'},
  bufferbehind: {zero: 'options_general_bufferbehind_zero', none: 'options_general_bufferbehind_none'},
};

/**
 * Shows, under a limit's field, what 0 or no limit means for it; nothing for other values.
 * @param {HTMLInputElement} input
 * @param {number} value - The limit as saved: -1 for none.
 */
function showLimitHint(input, value) {
  const hint = document.getElementById(input.id + 'hint');
  const key = value === 0 ? LIMIT_HINTS[input.id].zero : value < 0 ? LIMIT_HINTS[input.id].none : null;
  if (!hint) return;
  hint.textContent = key ? Localize.getMessage(key) : '';
  hint.hidden = !key;
}

/**
 * Shows a size in its number field and MB/GB picker, to three decimals; nothing (∞) for no
 * limit. Loaded, in GB from 1 GB up (in whole MB) and in MB below; after a change, in the unit the user
 * has picked: switched under them, "3000" typed in MB became "3 GB" when the field was left,
 * and picking GB after it changed nothing.
 * @param {HTMLInputElement} input
 * @param {HTMLSelectElement} unit
 * @param {number} bytes
 * @param {boolean} [keepUnit] - Whether the unit picked stays.
 */
function showSize(input, unit, bytes, keepUnit = false) {
  // GB only when its three decimals hold the size: 1234.4 MB came back as 1.234 GB.
  if (!keepUnit) unit.value = String(!(bytes >= 0) || (bytes >= GB && bytes % (GB / 1000) === 0) ? GB : GB / 1000);
  input.value = bytes >= 0 ? String(Math.round(bytes / Number(unit.value) * 1000) / 1000) : '';
  showLimitHint(input, bytes);
}

/**
 * The limit a field holds, times its unit: -1 (no limit) for an empty field, the amount for
 * a number from 0 up, and null for anything else (letters, a negative number, one too big to
 * save: 1e308 GB was saved as Infinity, which JSON keeps as null), which leaves the limit as
 * it was. A comma is a decimal point ("1,5", as French and German write it): a number field
 * would have taken only the page language's, and "1,5" was cut to 1. Read to the three
 * decimals the field shows (showSpeed, showSize), so what is saved is what it says: 0.0001 MB
 * was saved as 100 bytes and shown as 0, which is none.
 * @param {HTMLInputElement} input
 * @param {number} multiplier
 * @return {?number}
 */
function readLimit(input, multiplier) {
  const text = input.value.trim().replace(',', '.');
  if (text === '') return -1;
  // Number() rather than parseFloat(): "10 MB" or "5x" is no number, not 10 or 5.
  const shown = Math.round(Number(text) * 1000) / 1000;
  const amount = Math.round(shown * multiplier);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

// Written back (in the unit picked: showSize) when the field is left or a unit picked - a
// trusted change - not on a save while typing, where it fought the keys being typed. A field
// that holds no limit shows the one saved again then.
maxSpeed.addEventListener('change', (e) => {
  const value = readLimit(maxSpeed, BYTES_PER_MBIT_PER_S);
  if (value !== null) Options.maxSpeed = value;
  if (e.isTrusted) showSpeed(Options.maxSpeed);
  if (value !== null) optionChanged();
});

const onMaxSizeChange = (e) => {
  const value = readLimit(maxSize, Number(maxSizeUnit.value));
  if (value !== null) Options.maxVideoSize = value;
  if (e.isTrusted) showSize(maxSize, maxSizeUnit, Options.maxVideoSize, true);
  if (value !== null) optionChanged();
};
maxSize.addEventListener('change', onMaxSizeChange);
// Another unit, the same number: "2" from MB to GB is 2 GB.
maxSizeUnit.addEventListener('change', onMaxSizeChange);

// The RAM all players keep downloaded video in (MemoryBudget); beyond it, it goes to disk
// (a private window lets it go). Empty: no limit, all of it in RAM. 0: none in RAM, so
// nothing is downloaded ahead of playback.
const onRamBudgetChange = (e) => {
  const value = readLimit(ramBudget, Number(ramBudgetUnit.value));
  if (value !== null) Options.ramBudget = value;
  if (e.isTrusted) showSize(ramBudget, ramBudgetUnit, Options.ramBudget, true);
  if (value !== null) optionChanged();
};
ramBudget.addEventListener('change', onRamBudgetChange);
ramBudgetUnit.addEventListener('change', onRamBudgetChange);

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
  // A decimal comma, as in the size fields (readLimit): "2,5" seconds was 2.
  const text = String(input.value).trim().replace(',', '.');
  const value = whole ? parseInt(text) : parseFloat(text);
  const result = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
  input.value = result;
  return result;
}

/**
 * Shows seconds of Buffer ahead or behind; nothing ("No limit") for none.
 * @param {HTMLInputElement} input
 * @param {number} seconds - As saved: -1 for no limit.
 */
function showSeconds(input, seconds) {
  input.value = seconds >= 0 ? String(seconds) : '';
  showLimitHint(input, seconds);
}

// Whole seconds; an empty field is no limit (-1), and anything else that is no number keeps
// the value saved (an empty field read as 0 kept nothing buffered).
for (const [input, option] of [[bufferAhead, 'bufferAhead'], [bufferBehind, 'bufferBehind']]) {
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
  Options.seekStepSize = readNumberField(seekStepSize, DefaultOptions.seekStepSize, 0.1, 3600);
  optionChanged();
});

replaceDelay.addEventListener('change', () => {
  Options.replaceDelay = readNumberField(replaceDelay, DefaultOptions.replaceDelay, 0, 60000, true);
  optionChanged();
});

miniSize.addEventListener('change', () => {
  Options.miniSize = readNumberField(miniSize, DefaultOptions.miniSize * 100, 1, 100) / 100;
  optionChanged();
});

// 1 to 6, the browser's limit per server; 0 or less is the default, as the downloader reads
// it. 0 meant "never add one" to the downloader and "no limit" to the add-downloader key.
// Empty is no limit, the most a browser opens to one server (6, the default); 0 is the least
// that still downloads, 1. 0 was read as the default 6, the most (2026-10-09).
maxdownloaders.addEventListener('change', () => {
  Options.maximumDownloaders = readNumberField(maxdownloaders, DefaultOptions.maximumDownloaders, 1, 6, true);
  optionChanged();
});

/**
 * Saves a text field while it is typed in, not only when it is left. Its change event came only
 * on leaving the field (Tab, a click elsewhere), so a size typed and the settings closed with the
 * cursor still in it was lost, and the field showed the old value again ("stuck at 5 GB", #378).
 * The field's own change handler reads, clamps and saves the value; what is being typed stays in
 * the field as typed. An emptied field is saved when it or the page is left, not while typing.
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 */
function saveWhileTyping(input) {
  let timer = null;
  // Typed and not saved yet: an emptied field waits for the field or the page to be left.
  let unsaved = false;
  const save = (leaving = false) => {
    clearTimeout(timer);
    timer = null;
    // A number field half typed ("1.", "-") reads as empty: taken for "no limit", it is lost.
    if (input.validity?.badInput) return;
    // Emptied while typing is no value yet; emptied when the page goes, it is the user's.
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
  // Left: its change event saves it, and shows it as kept.
  input.addEventListener('change', () => {
    unsaved = false;
    clearTimeout(timer);
    timer = null;
  });
  // The page goes (the tab closed, the player with the settings in it closed) before the wait,
  // or with the field emptied: an emptied field was not saved at all.
  window.addEventListener('pagehide', () => {
    if (unsaved) save(true);
  });
}

[maxSpeed, maxSize, ramBudget, bufferAhead, bufferBehind, seekStepSize, replaceDelay, miniSize, maxdownloaders,
  mpvPathInput].forEach(saveWhileTyping);

/**
 * Saves a list field when the page goes with it changed, as it does when it is left: half a
 * line saved while typing would be a list entry of its own ("https://" in the sites FastStream
 * opens on by itself would be every site).
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

[mpvAllowlistInput, autoEnableURLSInput, customSourcePatterns].forEach(saveOnLeavingPage);

importButton.addEventListener('click', () => {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.json';
  picker.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let newOptionsObj;
    try {
      newOptionsObj = JSON.parse(await file.text());
    } catch (err) {
      newOptionsObj = null;
    }
    // Valid JSON that is no settings object (null, a list, a number) threw further down,
    // and the import failed without a word.
    if (!newOptionsObj || typeof newOptionsObj !== 'object' || Array.isArray(newOptionsObj)) {
      alert(Localize.getMessage('options_import_invalid'));
      return;
    }
    const newOptions = Utils.migrateSizes(Utils.migrateKeybinds(Utils.mergeOptions(DefaultOptions, newOptionsObj), newOptionsObj), newOptionsObj);
    const subtitlesSettings = Utils.mergeOptions(DefaultSubtitlesSettings, newOptionsObj.subtitlesSettings || {});
    const toolSettings = Utils.mergeOptions(DefaultToolSettings, newOptionsObj.toolSettings || {});
    loadOptions(newOptions);
    optionChanged();

    Utils.setConfig('subtitlesSettings', JSON.stringify(subtitlesSettings));
    Utils.setConfig('toolSettings', JSON.stringify(toolSettings));
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
    if (entry.isIntersecting) {
      pageSeen = true;
      offerMpvWhenReady();
    }
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

