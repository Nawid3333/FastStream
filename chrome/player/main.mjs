// @ts-check

import {MessageTypes} from './enums/MessageTypes.mjs';
import {PlayerModes} from './enums/PlayerModes.mjs';
import {FastStreamClient} from './FastStreamClient.mjs';
import {Localize} from './modules/Localize.mjs';
import {SubtitleTrack} from './SubtitleTrack.mjs';
import {isAddressFromRedirect} from './utils/AddressKey.mjs';
import {EnvUtils} from './utils/EnvUtils.mjs';
import {STILLS_LENGTH, StreamLength} from './utils/StreamLength.mjs';
import {StreamPick} from './utils/StreamPick.mjs';
import {loadSubtitles} from './utils/SubtitleFetch.mjs';
import {desiredHeight, pickQuality} from './utils/PageQualityPick.mjs';
import {URLUtils} from './utils/URLUtils.mjs';
import {Utils} from './utils/Utils.mjs';
import {VideoSource} from './VideoSource.mjs';

// The notices the background may send with the sources, by message key.
const PlayerNotices = ['player_mpv_page_only'];
const PlayerNoticeMs = 12000;

/**
 * The player's window while it has its client, for the two functions that read it unchecked.
 * @typedef {Window & typeof globalThis & {fastStream: NonNullable<Window['fastStream']>}} FastStreamWindow
 */

/**
 * A stream as the SOURCES message carries it, with its depth, length and page qualities when known.
 * @typedef {{url: string, mode: string, headers?: *, time?: number, depth?: number,
 *   duration?: number|null, qualities?: ?Array<{url: string, label: string, height: number}>,
 *   frameId?: number}} SentSource
 */

/**
 * A subtitle track once loadSubtitles() fetched its text; score is sortSubtitles()'s for its language.
 * @typedef {{label: string, language: string, data: string, score?: number}} SubtitleData
 */

/** @type {typeof import('./options/defaults/DefaultOptions.mjs').DefaultOptions|null} */
let OPTIONS = null;
/** @type {number|null} */ let optionSendTime = null;
if (EnvUtils.isExtension()) {
  chrome.runtime.onMessage.addListener(
      (request, sender, sendResponse) => {
        if (request.type === MessageTypes.FRAME_LINK_SENDER) {
          window.parent.postMessage(request.key, '*');
          sendResponse('ok');
          return;
        } else if (request.type === MessageTypes.HAS_PLAYER) {
          // The background asks after it restarted; a frame that navigated to the player has no content script,
          // so the player answers.
          sendResponse(true);
          return;
        } else if (request.type === MessageTypes.SOURCES && window.fastStream) {
          // Answered whatever happens: the background waits for it.
          recieveSources(request, sendResponse).catch((e) => {
            console.error('Taking the sources failed', e);
            sendResponse('sources_recieved');
          });
          return true;
        } else if (request.type === MessageTypes.VPN_ALLOWED && window.fastStream) {
          window.fastStream.vpnPrompt.onAllowed();
        } else if (request.type === MessageTypes.MPV_ASKING && window.fastStream) {
          window.fastStream.interfaceController?.saveManager?.whileMpvAsks();
        } else if (request.type === MessageTypes.EXIT_CARRIED_FULLSCREEN && window.fastStream) {
          // false: this player has no carried fullscreen, and the background ends it.
          sendResponse(window.fastStream.interfaceController.exitCarriedFullscreen());
          return;
        } else if (request.type === MessageTypes.UPDATE_OPTIONS) {
          if (request.time !== optionSendTime) {
            optionSendTime = request.time;
            loadOptions();
          }
        } else if (request.type === MessageTypes.MESSAGE_FROM_PAGE && window.fastStream) {
          const data = request.data;
          if (data.type === 'fullscreen-state') {
            window.fastStream.interfaceController.setFullscreenStatus(data.value);
          } else if (data.type === 'miniplayer-state') {
            window.fastStream.interfaceController.setMiniplayerStatus(data.value);
          }
          sendResponse('recieved');
          return;
        } else if (request.type === MessageTypes.HANDLE_DOWNLOAD) {
          console.log('Downloading', request);
          const url = request.url;
          const filename = request.filename;
          /** @type {Promise<*>} */ (Utils.downloadURL(url, filename, true)).then((response) => {
            sendResponse(response);
          }).catch((e) => {
            // The background waits for an answer, and takes null as none (its own timeout's).
            console.error('Starting the download failed', e);
            sendResponse(null);
          });
          return true;
        } else {
          return;
        }

        sendResponse('ok');
        return undefined;
      });

  setInterval(() => {
    chrome.runtime.sendMessage({
      type: MessageTypes.PING,
    });
  }, 10000);
}

/**
 * @param {{sources: SentSource[], video?: ?{src?: string, duration?: number|null},
 *   subtitles?: Array<import('./utils/SubtitleFetch.mjs').SentSubtitle>, autoSetSource?: boolean, forceAutoplay?: boolean,
 *   notice?: string,
 *   continuationOptions: {autoPlay?: boolean,
 *   disableLoadProgress?: boolean, fullscreenState?: string}}} request
 * @param {(response: *) => void} sendResponse
 */
async function recieveSources(request, sendResponse) {
  // URLs only: the sources' headers hold the page's Cookie and Authorization (see addSource)
  console.log('Recieved sources', (request.sources || []).map((s) => s.url), request.continuationOptions);

  const continuationOptions = /** @type {{autoPlay?: boolean, disableLoadProgress?: boolean, fullscreenState?: string}} */ (request.continuationOptions || {});
  if (continuationOptions.autoPlay) {
    request.forceAutoplay = true;
  }

  /** @type {import('./utils/SubtitleFetch.mjs').SentSubtitle[]|SubtitleData[]|undefined} */
  let subs = request.subtitles;
  /** @type {SentSource[]} */
  const sources = request.sources;

  if (sources.length === 0) {
    sendResponse('no_sources');
    return;
  }

  // Only known notice keys: the page's iframe messager brings SOURCES too.
  if (typeof request.notice === 'string' && PlayerNotices.includes(request.notice)) {
    /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.setStatusMessage(
        'mpv', Localize.getMessage(request.notice), 'warning', PlayerNoticeMs);
  }

  // The streams the page's video played, else the longest: an ad or an intro runs seconds, the video minutes.
  const candidates = StreamPick.played(sources, request.video) || StreamLength.longest(sources);

  // Lowest depth first, then a streaming one, then the newest MP4 (StreamPick.pick).
  /** @type {?SentSource} */
  let autoSetSource = StreamPick.pick(candidates);

  // Playlists of stills (seek-bar thumbnails) are listed, but never played by themselves.
  if (/** @type {FastStreamWindow} */ (window).fastStream.source || !request.autoSetSource || autoSetSource.duration === STILLS_LENGTH) {
    autoSetSource = null;
  }

  if (autoSetSource) {
    /** @type {FastStreamWindow} */ (window).fastStream.clearSubtitles();
  }

  if (autoSetSource && request.forceAutoplay) {
    /** @type {FastStreamWindow} */ (window).fastStream.setAutoPlay(true);
  }

  // For the source set here only (setSourceInternal takes it).
  if (autoSetSource && continuationOptions.disableLoadProgress) {
    /** @type {FastStreamWindow} */ (window).fastStream.options.disableLoadProgress = true;
  }

  /**
   * A detected stream as a source, with its page's qualities (page-qualities.js); the played one is at
   * the user's quality setting, not the page's default.
   * @param {SentSource} s
   * @param {boolean} played
   * @return {VideoSource}
   */
  const toVideoSource = (s, played) => {
    let url = s.url;
    if (played && s.qualities) {
      const best = pickQuality(s.qualities, desiredHeight(/** @type {FastStreamWindow} */ (window).fastStream.options.defaultQuality));
      if (best) url = best.url;
    }
    const source = new VideoSource(url, s.headers, s.mode);
    source.setQualities(s.qualities);
    if (Number.isInteger(s.frameId)) source.pageFrameId = /** @type {number} */ (s.frameId);
    return source;
  };

  // Should the stream picked fail before it shows anything, the next of those it was
  // picked from plays in its place.
  const fallbacks = autoSetSource ? StreamPick.fallbacks(candidates, autoSetSource).map((s) => {
    return toVideoSource(s, false);
  }) : [];

  sources.forEach((s) => {
    const isAutoSet = s === autoSetSource;
    /** @type {FastStreamWindow} */ (window).fastStream.addSource(toVideoSource(s, isAutoSet), isAutoSet, isAutoSet ? fallbacks : []);
  });

  const fullscreenState = continuationOptions.fullscreenState;
  if (fullscreenState === 'fullscreen') {
    // Firefox refuses a fullscreen nobody clicked for: the browser window goes fullscreen instead.
    /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.carryFullscreen();
  } else if (fullscreenState === 'pip') {
    /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.pipToggle(true);
  } else if (fullscreenState === 'windowed') {
    /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.toggleWindowedFullscreen(true);
  }

  // After an automatic continuation the keyboard comes to this player,
  // not while the user types in the page or looks at another tab (PAGE_TYPING).
  if (continuationOptions.autoPlay && EnvUtils.isExtension()) {
    chrome.runtime.sendMessage({type: MessageTypes.REQUEST_KEYBOARD}, (mayTake) => {
      void chrome.runtime.lastError;
      if (mayTake === true) window.focus();
    });
  }

  // Subtitles last: the steps above are the ones the user waits for.
  if (subs) {
    subs = await loadSubtitles(subs);
    subs = await sortSubtitles(/** @type {SubtitleData[]} */ (subs));

    try {
      subs.forEach((sub, i) => {
        const track = new SubtitleTrack(sub.label, sub.language);
        try {
          track.loadText(sub.data);
          if (track.cues.length > 0) {
            /** @type {FastStreamWindow} */ (window).fastStream.loadSubtitleTrack(track, request.autoSetSource);
          }
        } catch (e) {
          console.error(e);
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  sendResponse('sources_recieved');
}

/**
 * Sorts the subtitles by their language's match score, best first.
 * @param {SubtitleData[]} subs
 */
async function sortSubtitles(subs) {
  if (!EnvUtils.isExtension() || !chrome?.i18n?.detectLanguage) {
    return subs;
  }

  let defLang = 'en';
  const subtitlesSettings = /** @type {{defaultLanguage?: string}} */ (await Utils.getSubtitlesSettingsFromStorage());
  if (subtitlesSettings.defaultLanguage) {
    defLang = subtitlesSettings.defaultLanguage;
  }

  await Promise.all(subs.map((sub) => {
    return /** @type {Promise<void>} */ (new Promise((resolve, reject)=>{
      chrome.i18n.detectLanguage(sub.data, (result) => {
        // An error (runtime.lastError) answers with no result: reject, or the sources are never answered.
        if (!Array.isArray(result?.languages)) {
          void chrome.runtime.lastError;
          sub.score = 0;
          resolve();
          return;
        }
        const langCandidates = result.languages.map((lang) => {
          return {
            matchLevel: Localize.getLanguageMatchLevel(lang.language, defLang),
            percentage: lang.percentage,
          };
        }).filter((lang) => lang.matchLevel > 0);
        langCandidates.sort((a, b) => b.matchLevel - a.matchLevel);
        const lang = langCandidates[0];

        const score = lang ? lang.percentage : 0;
        sub.score = score;

        if (!sub.language && result.languages.length > 0 && result.languages[0].percentage > 50) {
          sub.language = result.languages[0].language;
        }

        resolve();
      });
    }));
  }));

  subs.sort((a, b) => {
    return /** @type {number} */ (b.score) - /** @type {number} */ (a.score);
  });

  return subs;
}

async function loadOptions() {
  try {
    OPTIONS = await Utils.getOptionsFromStorage();
    /** @type {FastStreamWindow} */ (window).fastStream.setOptions(OPTIONS);
    // Marked for tests: these options can overwrite ones a test forced.
    /** @type {FastStreamWindow} */ (window).fastStream.optionsApplied = true;
  } catch (e) {
    console.error(e);
  }
}

async function setup() {
  if (!window.fastStream) {
    window.fastStream = new FastStreamClient();
    await window.fastStream.setup();
  }

  await loadOptions();

  if (EnvUtils.isExtension()) {
    const urlParams = new URLSearchParams(window.location.search);
    chrome?.runtime?.sendMessage({
      type: MessageTypes.PLAYER_LOADED,
      url: window.location.href,
      isExt: true,
      parentFrameId: urlParams.has('parent_frame_id') ? parseInt(/** @type {string} */ (urlParams.get('parent_frame_id'))) : undefined,
    }).then((data) => {
      // Nor once the client went (beforeunload) before the background answered.
      if (!data || !window.fastStream) {
        return;
      }
      window.fastStream.setMediaInfo(data.mediaInfo);
      window.fastStream.setPage(data.tabId, data.pageFrameId);
      window.fastStream.setNeedsUserInteraction(!data.isMainPlayer);

      console.log('Recieved data', data);
      window.fastStream.setupPoll();

      chrome.runtime.sendMessage({
        type: MessageTypes.REQUEST_SOURCES,
      });
    });
  } else {
    if (window.self !== window.top) {
      window.fastStream.setNeedsUserInteraction(true);
    }
  }

  const version = window.fastStream.version;
  Utils.printWelcome(version);

  // Tells the background once that this frame is gone; only the extension has a background.
  let frameRemovedSent = false;
  const sendFrameRemoved = () => {
    if (frameRemovedSent || !EnvUtils.isExtension()) {
      return;
    }
    frameRemovedSent = true;
    chrome.runtime.sendMessage({
      type: MessageTypes.FRAME_REMOVED,
    });
  };

  // Firefox fires beforeunload for navigations that never happen (a download, a 204, "Leave page?" Stay).
  // A page-frame player left dead loads again at its second; a player tab's own leave is the user's.
  const StayedMs = 3000;
  /** @type {any} */
  let stayTimer = null;
  const tearDown = () => {
    if (window.fastStream) {
      // Its buffer to this video's next player on this page (BufferStash); taken back if it loads again.
      window.fastStream.handOffBuffer();
      window.fastStream.destroy();
      delete window.fastStream;
    }
  };
  window.addEventListener('beforeunload', () => {
    // A player tab goes at pagehide, once the navigation happens: one answered with a download
    // or a 204 left it dead, and it does not load again by itself.
    if (window.top === window) {
      return;
    }
    const time = window.fastStream?.source ? window.fastStream.currentTime : 0;
    tearDown();
    sendFrameRemoved();
    clearTimeout(stayTimer);
    stayTimer = setTimeout(() => {
      const url = new URL(window.location.href);
      if (Number.isFinite(time) && time >= 1) {
        url.searchParams.set('faststream-timestamp', String(Math.floor(time)));
      }
      window.location.replace(url.toString());
    }, StayedMs);
  });
  // A page that removes the player's iframe runs no beforeunload in it; pagehide still runs.
  window.addEventListener('pagehide', (e) => {
    clearTimeout(stayTimer);
    stayTimer = null;
    if (window.top === window) tearDown();
    if (!e.persisted) {
      sendFrameRemoved();
    }
  });
  // Back from the back-forward cache, the client is gone (it went at beforeunload):
  // a player the page embeds starts again; content.js's go with the page's REMOVE_PLAYERS.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !window.fastStream && !new URLSearchParams(window.location.search).has('opener')) {
      window.location.reload();
    }
  });

  // A source in the address (#url) is taken only in the player's own tab: a page that frames it
  // could hand it made-up headers.
  // In a tab a page opened, its headers and mode count only with the redirect rule's key (AddressKey.mjs).
  if (window.location.hash && (!EnvUtils.isExtension() || window.top === window)) {
    const url = window.location.hash.substring(1);
    const ext = URLUtils.get_url_extension(url);
    let mode = PlayerModes.DIRECT;

    if (mode === PlayerModes.DIRECT && URLUtils.getModeFromExtension(ext)) {
      mode = URLUtils.getModeFromExtension(ext);
    }

    if (url.startsWith('file://') && mode === PlayerModes.ACCELERATED_MP4) {
      mode = PlayerModes.DIRECT;
    }

    const source = new VideoSource(url, {}, mode);
    source.parseHeadersParam(!EnvUtils.isExtension() || await isAddressFromRedirect(window.location.search));

    window.fastStream.addSource(source, true).catch((e) => console.error('Opening the stream in the address failed', e));
  }

  if (!EnvUtils.isExtension()) {
    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin) return;

      if (e.data?.type === 'options') {
        loadOptions();
      } else if (e.data?.type === 'sources') {
        recieveSources(e.data, () => {});
      }
    });
  }
}

setup().catch((e)=>{
  console.error(e);
});

// SPLICER:EXTENSION:REMOVE_START
// The wave accessibility extension's sidebar: the player moves aside for it.
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((/** @type {Node} */ node) => {
      if (/** @type {Element} */ (node).id === 'wave_sidebar_container' || /** @type {Element} */ (node).id === 'waveordercontainer') {
        doWaveFix();
      }
    });

    mutation.removedNodes.forEach((/** @type {Node} */ node) => {
      if (/** @type {Element} */ (node).id === 'wave_sidebar_container') {
        undoWaveFix();
      }
    });
  });
});

observer.observe(document.body, {
  childList: true,
});

/** @type {ResizeObserver|null} */
let lastObserver = null;

function doWaveFix() {
  const player = /** @type {HTMLElement} */ (document.querySelector('.mainplayer'));
  if (player) {
    player.style.left = '380px';
    player.style.width = 'calc(100% - 380px)';
  }

  const waveordercontainer = /** @type {HTMLElement} */ (document.querySelector('#waveordercontainer'));
  if (waveordercontainer) {
    waveordercontainer.style.left = '380px';
  }

  const waveTopbar = document.querySelector('#wave5topbar');
  if (waveTopbar) {
    const topbarHeight = waveTopbar.clientHeight;
    player.style.height = `calc(100% - ${topbarHeight}px)`;

    const observer = new ResizeObserver((entries) => {
      const topbarHeight = waveTopbar.clientHeight;
      player.style.height = `calc(100% - ${topbarHeight}px)`;
    });

    observer.observe(waveTopbar);
    if (lastObserver) {
      lastObserver.disconnect();
    }
    lastObserver = observer;
  }
}

function undoWaveFix() {
  const player = /** @type {HTMLElement} */ (document.querySelector('.mainplayer'));
  if (player) {
    player.style.left = '';
    player.style.width = '';
    player.style.height = '';
  }

  if (lastObserver) {
    lastObserver.disconnect();
    lastObserver = null;
  }
}
// SPLICER:EXTENSION:REMOVE_END
