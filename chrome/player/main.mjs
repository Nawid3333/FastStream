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

/**
 * The player's window: it holds the client from setup() until beforeunload deletes it,
 * marked optionsApplied for the tests once loadOptions() gave it the saved options.
 * @typedef {Window & typeof globalThis & {fastStream: FastStreamClient & {optionsApplied?: boolean}}} FastStreamWindow
 */

/**
 * A stream as the SOURCES message carries it (the background's tracked sources), with its
 * depth, length and the page's qualities for it when known.
 * @typedef {{url: string, mode: string, headers?: *, time?: number, depth?: number,
 *   duration?: number|null, qualities?: ?Array<{url: string, label: string, height: number}>}} SentSource
 */

/**
 * A subtitle track once loadSubtitles() fetched its text, with its label and language; score
 * is what sortSubtitles() gives its language.
 * @typedef {{label: string, language: string, data: string, score?: number}} SubtitleData
 */

// The saved options over the defaults, once loaded.
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
          // The background asks the tab when it restarted and forgot the players. The
          // page's content script sees player iframes; a page frame that navigated to the
          // player has no content script left, so the player answers.
          sendResponse(true);
          return;
        } else if (request.type === MessageTypes.SOURCES && /** @type {FastStreamWindow} */ (window).fastStream) {
          // Answered whatever happens: the background waits for it.
          recieveSources(request, sendResponse).catch((e) => {
            console.error('Taking the sources failed', e);
            sendResponse('sources_recieved');
          });
          return true;
        } else if (request.type === MessageTypes.VPN_ALLOWED && /** @type {FastStreamWindow} */ (window).fastStream) {
          /** @type {FastStreamWindow} */ (window).fastStream.vpnPrompt.onAllowed();
        } else if (request.type === MessageTypes.EXIT_CARRIED_FULLSCREEN && /** @type {FastStreamWindow} */ (window).fastStream) {
          // Escape in the page around a carried fullscreen (content.js).
          /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.exitCarriedFullscreen();
        } else if (request.type === MessageTypes.UPDATE_OPTIONS) {
          if (request.time !== optionSendTime) {
            optionSendTime = request.time;
            loadOptions();
          }
        } else if (request.type === MessageTypes.MESSAGE_FROM_PAGE && /** @type {FastStreamWindow} */ (window).fastStream) {
          const data = request.data;
          if (data.type === 'fullscreen-state') {
            /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.setFullscreenStatus(data.value);
          } else if (data.type === 'miniplayer-state') {
            /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.setMiniplayerStatus(data.value);
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
 *   continuationOptions: {autoPlay?: boolean,
 *   disableLoadProgress?: boolean, fullscreenState?: string}}} request - The SOURCES
 * message, from the background's runtime listener or the page's iframe messager.
 * @param {(response: *) => void} sendResponse - Answers the sender when it's done.
 */
async function recieveSources(request, sendResponse) {
  // URLs only: the sources' headers hold the page's Cookie and Authorization (see addSource)
  console.log('Recieved sources', (request.sources || []).map((s) => s.url), request.continuationOptions);

  const continuationOptions = /** @type {{autoPlay?: boolean, disableLoadProgress?: boolean, fullscreenState?: string}} */ (request.continuationOptions || {});
  if (continuationOptions.autoPlay) {
    request.forceAutoplay = true;
  }

  if (continuationOptions.disableLoadProgress) {
    /** @type {FastStreamWindow} */ (window).fastStream.options.disableLoadProgress = true;
  }

  /** @type {import('./utils/SubtitleFetch.mjs').SentSubtitle[]|SubtitleData[]|undefined} */
  let subs = request.subtitles;
  /** @type {SentSource[]} */
  const sources = request.sources;

  if (sources.length === 0) {
    sendResponse('no_sources');
    return;
  }

  // The streams the page's video played, when it tells them; else the longest: an ad or an
  // intro runs for seconds, the video for minutes or hours. The rest stay in the list, to
  // choose by hand.
  const candidates = StreamPick.played(sources, request.video) || StreamLength.longest(sources);

  // Sources are ordered by time, so the first is the oldest; the lowest depth wins, then a
  // streaming one, and among MP4 files the newest (StreamPick.pick).
  /** @type {?SentSource} */
  let autoSetSource = StreamPick.pick(candidates);

  // Playlists of stills are all there is (the seek bar's thumbnails): listed, to choose by
  // hand, but nothing to play by itself.
  if (/** @type {FastStreamWindow} */ (window).fastStream.source || !request.autoSetSource || autoSetSource.duration === STILLS_LENGTH) {
    autoSetSource = null;
  }

  if (autoSetSource) {
    /** @type {FastStreamWindow} */ (window).fastStream.clearSubtitles();
  }

  if (autoSetSource && request.forceAutoplay) {
    /** @type {FastStreamWindow} */ (window).fastStream.setAutoPlay(true);
  }

  /**
   * A detected stream as a source, with the qualities its page's player offers it in
   * (page-qualities.js). The one played is the quality the user's setting asks for: the page
   * asked for its own default, the lowest on kinoger's fsst hoster.
   * @param {SentSource} s - The stream, as the background sent it.
   * @param {boolean} played - Whether it is the one the player plays.
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

  const fullscreenState = continuationOptions.fullscreenState;
  if (fullscreenState === 'fullscreen') {
    // Firefox refuses a fullscreen nobody clicked for (the page went on by itself), and the
    // episode played windowed: the browser window goes fullscreen instead.
    /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.carryFullscreen();
  } else if (fullscreenState === 'pip') {
    /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.pipToggle(true);
  } else if (fullscreenState === 'windowed') {
    /** @type {FastStreamWindow} */ (window).fastStream.interfaceController.toggleWindowedFullscreen(true);
  }

  // The keyboard into this player after FastStream went on to it by itself (his report,
  // 2026-10-11: F, Space and the arrows did nothing on the next episode until a click in the
  // player; the page had the keyboard). Only then, and not while the user types in the page
  // or looks at another tab (the background asks the page: PAGE_TYPING; the reviews).
  if (continuationOptions.autoPlay && EnvUtils.isExtension()) {
    chrome.runtime.sendMessage({type: MessageTypes.REQUEST_KEYBOARD}, (mayTake) => {
      void chrome.runtime.lastError;
      if (mayTake === true) window.focus();
    });
  }

  sendResponse('sources_recieved');
}

/**
 * Sorts the subtitles by their language's match score, best first.
 * @param {SubtitleData[]} subs - The subtitles; each gets a score for its language here.
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
    // Marked for tests: the client exists before its options do, and the first
    // ones can be clobbered by this call seconds after a test forced them.
    /** @type {FastStreamWindow} */ (window).fastStream.optionsApplied = true;
  } catch (e) {
    console.error(e);
  }
}

async function setup() {
  if (!/** @type {FastStreamWindow} */ (window).fastStream) {
    /** @type {FastStreamWindow} */ (window).fastStream = new FastStreamClient();
    await /** @type {FastStreamWindow} */ (window).fastStream.setup();
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
      // Nor once the client went (beforeunload) before the background answered: its answer
      // then threw on the missing client.
      if (!data || !/** @type {FastStreamWindow} */ (window).fastStream) {
        return;
      }
      /** @type {FastStreamWindow} */ (window).fastStream.setMediaInfo(data.mediaInfo);
      /** @type {FastStreamWindow} */ (window).fastStream.setNeedsUserInteraction(!data.isMainPlayer);

      console.log('Recieved data', data);
      /** @type {FastStreamWindow} */ (window).fastStream.setupPoll();

      chrome.runtime.sendMessage({
        type: MessageTypes.REQUEST_SOURCES,
      });
    });
  } else {
    // if in iframe, require interaction
    if (window.self !== window.top) {
      /** @type {FastStreamWindow} */ (window).fastStream.setNeedsUserInteraction(true);
    }
  }

  const version = /** @type {FastStreamWindow} */ (window).fastStream.version;
  Utils.printWelcome(version);

  // Tells the background this player's frame is gone, once. Only the extension has a
  // background page that tracks its frames; the web build has no chrome object to reach
  // for, and reaching for one here threw on every unload.
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

  // Firefox fires beforeunload for navigations that never happen too: a link answered with
  // a download or a 204, a "Leave page?" answered Stay (content.js has the same). The client
  // goes at beforeunload all the same, before Firefox decides on the back-forward cache: a
  // live player keeps the page out of it. The player left dead in a page that stayed loads
  // again a moment later, at the second it was at (the page's faststream-timestamp), once
  // content.js has named its page again (LeaveSettledMs); a page that really goes clears it.
  // Only a player in a page's frame: a player tab's own leave is the user's (an address typed
  // there), and loading again there would cancel a navigation that took over StayedMs.
  const StayedMs = 3000;
  /** @type {any} */
  let stayTimer = null;
  window.addEventListener('beforeunload', () => {
    const time = /** @type {FastStreamWindow} */ (window).fastStream?.source ? /** @type {FastStreamWindow} */ (window).fastStream.currentTime : 0;
    if (/** @type {FastStreamWindow} */ (window).fastStream) {
      /** @type {FastStreamWindow} */ (window).fastStream.destroy();
      delete /** @type {Window & {fastStream?: FastStreamClient}} */ (window).fastStream;
    }
    sendFrameRemoved();
    clearTimeout(stayTimer);
    if (window.top === window) {
      return;
    }
    stayTimer = setTimeout(() => {
      const url = new URL(window.location.href);
      if (Number.isFinite(time) && time >= 1) {
        url.searchParams.set('faststream-timestamp', String(Math.floor(time)));
      }
      window.location.replace(url.toString());
    }, StayedMs);
  });
  // A page that takes the player's iframe out itself (a re-render) runs no beforeunload
  // in it, and the background kept the frame as a player's: it dropped that frame's
  // streams and opened no player on the page, until a navigation. The document's
  // pagehide still runs. Not a persisted one: that page is only hidden, and may come back.
  window.addEventListener('pagehide', (e) => {
    clearTimeout(stayTimer);
    stayTimer = null;
    if (!e.persisted) {
      sendFrameRemoved();
    }
  });
  // The client went at beforeunload, which also comes for a page Firefox then keeps in the
  // back-forward cache (gone first, the page can be cached: a live player kept it out).
  // Back then gave back a player without its client: dead. One in a page that embeds it
  // starts again; one that content.js put in a page is taken down with the page's own
  // REMOVE_PLAYERS (its URL has the opener), and a player tab is never cached.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !/** @type {FastStreamWindow} */ (window).fastStream && !new URLSearchParams(window.location.search).has('opener')) {
      window.location.reload();
    }
  });

  // A source in the address (#url, with faststream-headers) is taken only in a tab of
  // its own: the extension puts one there when you open a stream URL (the redirect rule
  // is main_frame only), and never in the player iframes it adds to pages. A player
  // inside a page with a hash was framed by that page, which could hand it made-up
  // headers (for mpv, or for the header rules on its own requests). A page can open the
  // player in a tab too (window.open): the address's headers and mode count only with the
  // redirect rule's key (AddressKey.mjs); without it the player plays the bare URL.
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

    /** @type {FastStreamWindow} */ (window).fastStream.addSource(source, true).catch((e) => console.error('Opening the stream in the address failed', e));
  }

  if (!EnvUtils.isExtension()) {
    // if not extension context then use iframe messager
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
// Detect wave extension and fix positioning so it works
// Watch for an iframe element added to body with an id wave_sidebar_container
// When it is added, move the player to the right
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
