// @ts-check
(() => {
  const MessageTypes = {
    OPEN_PLAYER: 'OPEN_PLAYER',
    GET_VIDEO_SIZE: 'GET_VIDEO_SIZE',
    GET_PLAYED_VIDEO: 'GET_PLAYED_VIDEO',
    GET_PAGE_QUALITIES: 'GET_PAGE_QUALITIES',
    FRAME_ADDED: 'FRAME_ADDED',
    REMOVE_PLAYERS: 'REMOVE_PLAYERS',
    IS_FULL: 'IS_FULL',
    RELEASE_OVERLAY_GUARD: 'RELEASE_OVERLAY_GUARD',
    FRAME_LINK_SENDER: 'FRAME_LINK_SENDER',
    FRAME_LINK_RECEIVER: 'FRAME_LINK_RECEIVER',
    SEND_TO_PLAYER: 'SEND_TO_PLAYER',
    TOGGLE_MINIPLAYER: 'TOGGLE_MINIPLAYER',
    TOGGLE_FULLSCREEN: 'TOGGLE_FULLSCREEN',
    TOGGLE_WINDOWED_FULLSCREEN: 'TOGGLE_WINDOWED_FULLSCREEN',
    CARRIED_FULLSCREEN: 'CARRIED_FULLSCREEN',
    EXIT_CARRIED_FULLSCREEN: 'EXIT_CARRIED_FULLSCREEN',
    PLAYLIST_NAVIGATION: 'PLAYLIST_NAVIGATION',
    PLAYLIST_POLL: 'PLAYLIST_POLL',
    EPISODE_LINKS: 'EPISODE_LINKS',
    START_PAGE_PLAYER: 'START_PAGE_PLAYER',
    PAGE_TYPING: 'PAGE_TYPING',
    FRAME_REMOVED: 'FRAME_REMOVED',
    PAUSE_MEDIA: 'PAUSE_MEDIA',
    POPUP_GUARD_ARM: 'POPUP_GUARD_ARM',
    MPV_USER_PLAY: 'MPV_USER_PLAY',
    MPV_REPORT_PLAYING: 'MPV_REPORT_PLAYING',
    LAST_PRESS: 'LAST_PRESS',
    SCRAPE_CAPTIONS: 'SCRAPE_CAPTIONS',
    SHORTCUT_CANCELLED: 'SHORTCUT_CANCELLED',
    HAS_PLAYER: 'HAS_PLAYER',
    REPORT_LOADED_MEDIA: 'REPORT_LOADED_MEDIA',
    LOADED_MEDIA: 'LOADED_MEDIA',
    PLAYER_OPEN_GONE: 'PLAYER_OPEN_GONE',
    IS_PLAYER_OPENER: 'IS_PLAYER_OPENER',
    HOLD_PAGE_MEDIA: 'HOLD_PAGE_MEDIA',
  };

  /** @typedef {{src: string, duration: ?number, playing: string, time: number}} PlayedVideo */
  /** @typedef {Element & {openOrClosedShadowRoot?: ?ShadowRoot}} ShadowHost */
  /** @typedef {{observer: MutationObserver, held: WeakSet<HTMLMediaElement>}} PauseWatcher */
  /** @typedef {ReturnType<typeof setTimeout>} Timer */

  const iframeMap = new Map();
  // A fullscreen carried over to the next episode: Escape here ends it.
  let carriedFullscreen = false;
  /** @type {ReplacedPlayer[]} */
  const replacedPlayerQueue = [];
  // Players laid over the whole page (a video that fills it), with their pause watchers.
  /** @type {Array<{iframe: HTMLIFrameElement, watcher: PauseWatcher, hidden: *}>} */
  const overlayPlayers = [];
  // A Map: looked up per element. A hidden element gets back only its display.
  const elementsChangedByFillscreen = new Map();
  const linkRequests = new Map();
  // Counts removePlayers(): an OPEN_PLAYER that a removal overtook puts no player in.
  let PlayersEpoch = 0;
  let MiniplayerCooldown = 0;
  // 'sent', then 'leaving' at the redirect's beforeunload; a second one is a leave of the page's
  // own (the redirect was cancelled). Not a timer: a slow unload lost the player its sources.
  /** @type {false|'sent'|'leaving'} */
  let RedirectingToPlayer = false;
  // Not crypto.randomUUID: that needs a secure context, and plain http pages are not one.
  const DocumentKey = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('');
  // A frame the page's script writes: document.open() gives it the writer's address later.
  const StartedAsAboutFrame = window.location.protocol === 'about:';

  // The resize observers' last update of the players, and the one due after a burst.
  let resizeDebounce = performance.now();
  /** @type {?Timer} */
  let resizeTrailing = null;
  const Config = {
    softReplaceByDefault: true,
  };

  const {hostname} = window.location;
  if (hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv') ||
      hostname === 'vimeo.com' || hostname.endsWith('.vimeo.com')) {
    Config.softReplaceByDefault = false;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === MessageTypes.IS_FULL) {
      const frameId = request.frameId;
      const iframeObj = iframeMap.get(frameId);
      if (!iframeObj) {
        console.error('no element found');
        sendResponse(false);
        return;
      }

      OverlayGuard.guard(iframeObj.iframe);

      const parents = getParentElementsWithSameBounds(iframeObj.iframe);
      if (parents.length > 0 && parents[parents.length - 1].tagName === 'BODY') {
        sendResponse(true);
      } else {
        sendResponse(false);
      }
      return;
    } else if (request.type === MessageTypes.RELEASE_OVERLAY_GUARD) {
      // The player under that iframe went, and the iframe stayed.
      const iframeObj = iframeMap.get(request.frameId);
      if (iframeObj) OverlayGuard.release(iframeObj.iframe);
      return;
    } else if (request.type === MessageTypes.FRAME_LINK_RECEIVER) {
      linkRequests.set(request.key, {
        frameId: request.frameId,
      });
      sendResponse('ok');
      return;
    } else if (request.type === MessageTypes.FRAME_LINK_SENDER) {
      window.parent.postMessage(request.key, '*');
      sendResponse('ok');
      return;
    } else if (request.type === MessageTypes.HAS_PLAYER) {
      // Only a frame holding a player answers: a tab without one answers nothing.
      if (hasPlayerIframe()) {
        sendResponse(true);
      }
      return;
    } else if (request.type === MessageTypes.IS_PLAYER_OPENER) {
      // Only this content script knows the page's name.
      sendResponse(request.document === DocumentKey);
      return;
    } else if (request.type === MessageTypes.OPEN_PLAYER) {
      return handlePlayerOpen(request, sender, sendResponse);
    } else if (request.type === MessageTypes.REMOVE_PLAYERS) {
      removePlayers();
      sendResponse('ok');
    } else if (request.type === MessageTypes.PAUSE_MEDIA) {
      sendResponse(pauseAllMedia());
    } else if (request.type === MessageTypes.HOLD_PAGE_MEDIA) {
      holdPageMedia(request.hold === true);
      return;
    } else if (request.type === MessageTypes.MPV_REPORT_PLAYING) {
      // any is for the YouTube page itself, not a frame in it.
      sendResponse(reportPlayingUserVideo(request.any === true && window === window.top));
    } else if (request.type === MessageTypes.LAST_PRESS) {
      // When, on the clock every frame shares (Date.now's).
      sendResponse(lastUserGestureAt === -Infinity ? null : performance.timeOrigin + lastUserGestureAt);
    } else if (request.type === MessageTypes.GET_VIDEO_SIZE) {
      getVideo().then((video) => {
        sendResponse(video ? video.size : 0);
      }).catch((e) => {
        // The background waits for an answer: none found is 0.
        console.error('Finding the largest video failed', e);
        sendResponse(0);
      });
      return true;
    } else if (request.type === MessageTypes.GET_PAGE_QUALITIES) {
      /** @type {*[]} */
      let lists = [];
      try {
        lists = PageQualities.find(document, /** @type {Window & {wrappedJSObject?: *}} */ (window).wrappedJSObject || window, document.baseURI || window.location.href);
      } catch (e) {
        console.warn('Reading the page player\'s qualities failed', e);
      }
      sendResponse(lists);
    } else if (request.type === MessageTypes.GET_PLAYED_VIDEO) {
      // Before the player linked up, the latest replaced (one player opens per frame at a time).
      const linked = iframeMap.get(request.frameId);
      sendResponse(replacedVideo(linked ? linked.replacedData : replacedPlayerQueue[replacedPlayerQueue.length - 1]));
    } else if (request.type === MessageTypes.REPORT_LOADED_MEDIA) {
      // Each answers in a message of its own, which tells the background its frame.
      try {
        chrome.runtime.sendMessage({
          type: MessageTypes.LOADED_MEDIA,
          url: pageAddress(),
          document: DocumentKey,
          resources: loadedMedia(),
        }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) {
        // The extension was reloaded under this page: nothing to report to.
      }
      return;
    } else if (request.type === MessageTypes.SCRAPE_CAPTIONS) {
      return handleCaptionsScrape(request, sender, sendResponse);
    } else if (request.type === MessageTypes.TOGGLE_MINIPLAYER) {
      return handleMiniplayer(request, sender, sendResponse);
    } else if (request.type === MessageTypes.TOGGLE_FULLSCREEN) {
      return handleFullscreen(request, sender, sendResponse);
    } else if (request.type === MessageTypes.TOGGLE_WINDOWED_FULLSCREEN) {
      return handleWindowedFullscreen(request, sender, sendResponse);
    } else if (request.type === MessageTypes.CARRIED_FULLSCREEN) {
      carriedFullscreen = !!request.active;
      return;
    } else if (request.type === MessageTypes.PLAYLIST_NAVIGATION) {
      return handlePlaylistNavigation(request, sender, sendResponse);
    } else if (request.type === MessageTypes.PLAYLIST_POLL) {
      return pollPlaylistButtons(request, sender, sendResponse);
    } else if (request.type === MessageTypes.EPISODE_LINKS) {
      return readEpisodeLinks(request, sender, sendResponse);
    } else if (request.type === MessageTypes.START_PAGE_PLAYER) {
      startPagePlayer().then(sendResponse, () => sendResponse(null));
      return true;
    } else if (request.type === MessageTypes.PAGE_TYPING) {
      // Whether the user types here: the next episode's player then leaves the keyboard alone. An
      // iframe with the focus counts (a chat's, whose field this frame cannot see), not a player's.
      const active = /** @type {HTMLElement | null} */ (OverlayGuard.focused());
      sendResponse(document.visibilityState !== 'visible' ||
        !!active && (active.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) ||
          (active.tagName === 'IFRAME' && !holdsPlayer(/** @type {HTMLIFrameElement} */ (active)))));
      return;
    }
  });

  PageListeners.add(window, 'message', (e) => {
    if (typeof e.data !== 'string') {
      return;
    }

    const request = linkRequests.get(e.data);
    if (request) {
      linkRequests.delete(e.data);
      const iframeElement = findIframeWithWindow(e.source);
      if (!iframeElement) {
        console.error('no iframe found');
        return;
      }

      const replacedIndex = replacedPlayerQueue.findIndex((player) => player.iframe === iframeElement);
      let replacedData = null;
      if (replacedIndex !== -1) {
        replacedData = replacedPlayerQueue[replacedIndex];
        replacedPlayerQueue.splice(replacedIndex, 1);
      }

      const newFrameObj = {
        iframe: iframeElement,
        frameId: request.frameId,
        replacedData,
        miniplayerState: {},
        fullscreenState: {},
        windowedFullscreenState: {},
      };

      if (iframeMap.has(request.frameId)) {
        const oldFrameObj = iframeMap.get(request.frameId);
        if (oldFrameObj.miniplayerState.active) {
          unmakeMiniPlayer(oldFrameObj);
        }

        if (oldFrameObj.windowedFullscreenState.active) {
          windowedFullscreenToggle(oldFrameObj);
        }

        if (oldFrameObj.iframe !== iframeElement) {
          iframeElement.addEventListener('load', frameLoadListener);
        } else if (!newFrameObj.replacedData) {
          // The same iframe reloaded: only the old entry knows how to give its element back.
          newFrameObj.replacedData = oldFrameObj.replacedData;
        }
      } else {
        iframeElement.addEventListener('load', frameLoadListener);
      }

      iframeMap.set(request.frameId, newFrameObj);
      watchRemovalOf(iframeElement);
      checkPendingPlayers();

      updateReplacedPlayers(replacedData && replacedData.convertDue ? replacedData : null);
    }
  });

  // Player iframes not linked up yet: a page that takes one out runs nothing in it to say so.
  const pendingPlayers = new Map();
  /** @type {MutationObserver | null} */
  let pendingPlayersWatch = null;
  // This page started its own player for an autoplay next once (startPagePlayer), and one
  // ask is still looking for its video.
  let pagePlayerStarted = false;
  let pagePlayerLooking = false;

  /**
   * Watches a player iframe until its player links up, or the page takes it out.
   * @param {HTMLIFrameElement} iframe - The player's iframe, in the page.
   * @param {*} attempt - OPEN_PLAYER's attempt.
   */
  function watchPendingPlayer(iframe, attempt) {
    pendingPlayers.set(iframe, attempt);
    watchRemovalOf(iframe);
  }

  /** @type {WeakSet<Node>} The shadow roots pendingPlayersWatch observes besides the page. */
  let watchedRoots = new WeakSet();

  /**
   * Observes each shadow root the iframe is in too: an observer of the page sees nothing in one.
   * @param {Element} iframe
   */
  function watchRemovalOf(iframe) {
    if (!pendingPlayersWatch) {
      pendingPlayersWatch = new MutationObserver(checkPendingPlayers);
      pendingPlayersWatch.observe(document, {childList: true, subtree: true});
      watchedRoots = new WeakSet();
    }
    let root = iframe.getRootNode();
    while (root && root !== document && /** @type {ShadowRoot} */ (root).host) {
      if (!watchedRoots.has(root)) {
        watchedRoots.add(root);
        pendingPlayersWatch.observe(root, {childList: true, subtree: true});
      }
      root = /** @type {ShadowRoot} */ (root).host.getRootNode();
    }
  }

  /** Reports each pending player iframe out of the page (PLAYER_OPEN_GONE), once. */
  function checkPendingPlayers() {
    const linked = new Set();
    iframeMap.forEach((iframeObj) => linked.add(iframeObj.iframe));
    pendingPlayers.forEach((attempt, iframe) => {
      if (linked.has(iframe)) {
        pendingPlayers.delete(iframe);
      } else if (!iframe.isConnected) {
        pendingPlayers.delete(iframe);
        releaseRemovedPlayer(iframe);
        if (typeof attempt !== 'number') {
          return;
        }
        try {
          chrome.runtime.sendMessage({
            type: MessageTypes.PLAYER_OPEN_GONE,
            attempt,
          }, () => {
            void chrome.runtime.lastError;
          });
        } catch (e) {
          // The extension was reloaded under this page: nothing to report to.
        }
      }
    });
    // A linked-up player the page took out (a re-render): its element is given back; the entry
    // stays, for removePlayers.
    iframeMap.forEach((iframeObj) => {
      if (iframeObj.iframe.isConnected) return;
      unmakeMiniPlayer(iframeObj);
      if (iframeObj.windowedFullscreenState.active) {
        windowedFullscreenToggle(iframeObj);
      }
      if (iframeObj.replacedData) {
        restoreReplaced(iframeObj.replacedData);
        iframeObj.replacedData = null;
      }
      releaseRemovedPlayer(iframeObj.iframe);
    });
    if (pendingPlayers.size === 0 && iframeMap.size === 0 && pendingPlayersWatch) {
      pendingPlayersWatch.disconnect();
      pendingPlayersWatch = null;
    }
  }

  /**
   * Gives the page back what a player took, when the page took its iframe out before it linked up.
   * @param {HTMLIFrameElement} iframe - The player's iframe, out of the page.
   */
  function releaseRemovedPlayer(iframe) {
    const replaced = replacedPlayerQueue.findIndex((player) => player.iframe === iframe);
    if (replaced !== -1) {
      restoreReplaced(replacedPlayerQueue.splice(replaced, 1)[0]);
    }
    const overlay = overlayPlayers.findIndex((player) => player.iframe === iframe);
    if (overlay !== -1) {
      const {watcher, hidden} = overlayPlayers.splice(overlay, 1)[0];
      undoFillScreenIframe(hidden);
      stopPausing(watcher);
    }
  }

  /** @param {Event} e */
  function frameLoadListener(e) {
    const iframeElement = e.target;
    /** @type {*} */
    let frameObj = null;
    iframeMap.forEach((value) => {
      if (value.iframe === iframeElement) {
        frameObj = value;
      }
    });

    if (!frameObj) {
      return;
    }

    if (frameObj.miniplayerState.active) {
      unmakeMiniPlayer(frameObj);
    }

    if (frameObj.windowedFullscreenState.active) {
      windowedFullscreenToggle(frameObj);
    }
  }

  /**
   * Tells the background something, with no answer to wait for. The rejection of a page that
   * goes away meanwhile is caught: it reached the page's console as an error.
   * @param {*} message - The message.
   */
  function notifyBackground(message) {
    chrome.runtime.sendMessage(message).catch((e) => {
      console.debug('FastStream: no answer to', message.type, e && e.message);
    });
  }

  /**
   * @param {?MessageEventSource} win
   */
  function findIframeWithWindow(win) {
    const iframes = /** @type {HTMLIFrameElement[]} */ (querySelectorAllInAllShadows('iframe'));
    for (let i = 0; i < iframes.length; i++) {
      if (iframes[i].contentWindow === win) {
        return iframes[i];
      }
    }
    return null;
  }


  /**
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function handlePlaylistNavigation(request, sender, sendResponse) {
    const button = getNextOrPreviousButton(request.direction === 'next');
    if (!button) {
      // The series' last episode, or a page FastStream cannot read (isSeriesEnd).
      sendResponse(request.direction === 'next' && isSeriesEnd() ? 'series_end' : 'no_button');
      return;
    }

    const address = episodeLinkAddress(button);
    if (address) {
      window.location.assign(address);
    } else {
      /** @type {HTMLElement} */ (button).click();
    }
    sendResponse('clicked');
  }

  /**
   * The address of an episode link, followed instead of a click (hosters hang ad scripts on
   * their links); none for a button or a link meant for another frame.
   * @param {*} button - getNextOrPreviousButton's.
   * @return {?string}
   */
  function episodeLinkAddress(button) {
    const target = linkTarget(button);
    if (button.tagName === 'A' && /^https?:/i.test(button.href) && (target === '' || target === '_self' || target === '_blank') &&
        withoutHash(button.href) !== withoutHash(window.location.href)) {
      return button.href;
    }
    return null;
  }

  /**
   * The page's address; an about: frame's is that of the document it is in (same origin unless sandboxed), which
   * its requests name as their page. Not its base URL: a <base> of the page's choosing would stand for the page.
   * @return {string}
   */
  function pageAddress() {
    /** @type {Window} */
    let page = window;
    try {
      while (page.location.protocol === 'about:' && page.parent !== page) page = page.parent;
      return page.location.href;
    } catch (e) {
      return window.location.href;
    }
  }

  /**
   * The next and previous episode's addresses for MPV autoplay (EPISODE_LINKS), own origin only.
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function readEpisodeLinks(request, sender, sendResponse) {
    const ownSite = (/** @type {?string} */ address) => {
      try {
        return address && new URL(address).origin === new URL(pageAddress()).origin ? address : null;
      } catch (e) {
        return null;
      }
    };
    try {
      const nextButton = getNextOrPreviousButton(true);
      const previousButton = getNextOrPreviousButton(false);
      sendResponse({
        next: nextButton ? ownSite(episodeLinkAddress(nextButton)) : null,
        previous: previousButton ? ownSite(episodeLinkAddress(previousButton)) : null,
        hasNext: nextButton !== null,
        hasPrevious: previousButton !== null,
        seriesEnd: nextButton === null && isSeriesEnd(),
      });
    } catch (e) {
      sendResponse({
        error: /** @type {Error} */ (e).message,
      });
    }
  }

  /**
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function pollPlaylistButtons(request, sender, sendResponse) {
    try {
      const nextButton = getNextOrPreviousButton(true);
      const previousButton = getNextOrPreviousButton(false);
      sendResponse({
        next: nextButton !== null,
        previous: previousButton !== null,
        // No next: the series' last episode, or a page FastStream cannot read.
        seriesEnd: nextButton === null && isSeriesEnd(),
      });
    } catch (e) {
      sendResponse({
        error: /** @type {Error} */ (e).message,
      });
    }
  }

  /**
   * @typedef ReplacedPlayer
   * @property {HTMLIFrameElement} iframe
   * @property {PauseWatcher} watcher
   * @property {HTMLElement} old
   * @property {boolean} softReplace
   * @property {?HTMLVideoElement} [video]
   * @property {?PlayedVideo} [played]
   * @property {boolean} [convertDue]
   * @property {?ResizeObserver} [resizeObserver]
   */
  /**
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function handlePlayerOpen(request, sender, sendResponse) {
    // Players removed while the video was looked for: this puts no player in.
    const epoch = PlayersEpoch;
    getVideo().then((video) => {
      if (epoch !== PlayersEpoch) {
        sendResponse('error');
        return;
      }
      if (!video && !request.force) {
        sendResponse('no_video');
        return;
      }

      const playerFillsScreen = video?.highest?.tagName === 'BODY';
      const newURL = new URL(request.url);
      newURL.searchParams.set('opener', DocumentKey);
      if (!video || playerFillsScreen) {
        if (!document.fullscreenEnabled && !request.noRedirect && !StartedAsAboutFrame && window.location.protocol !== 'about:') {
          if (request.parentFrameId > -1) {
            newURL.searchParams.set('parent_frame_id', request.parentFrameId);
          }
          RedirectingToPlayer = 'sent';
          window.location = /** @type {string & Location} */ (newURL.href);
          sendResponse('redirect');
        } else {
          const iframe = document.createElement('iframe');
          newURL.searchParams.set('parent_frame_id', request.frameId);
          iframe.src = newURL.href;
          iframe.allowFullscreen = true;
          iframe.allow = 'autoplay; fullscreen; picture-in-picture; speaker-selection';
          const watcher = pauseAllWithin(document.body);
          document.body.appendChild(iframe);
          const hidden = fillScreenIframe(iframe);
          overlayPlayers.push({iframe, watcher, hidden});
          watchPendingPlayer(iframe, request.attempt);
          sendResponse('replaceall');
        }
      } else {
        const softReplace = request.softReplace || Config.softReplaceByDefault;
        const iframe = document.createElement('iframe');
        iframe.allowFullscreen = true;
        iframe.allow = 'autoplay; fullscreen; picture-in-picture; speaker-selection';
        iframe.style.display = 'none';
        newURL.searchParams.set('parent_frame_id', request.frameId);
        iframe.src = newURL.href;

        if (softReplace) {
          /** @type {ParentNode} */ (video.highest.parentNode).insertBefore(iframe, video.highest);
        } else {
          /** @type {ParentNode} */ (video.highest.parentNode).replaceChild(iframe, video.highest);
        }

        const watcher = pauseAllWithin(video.highest);

        /** @type {ReplacedPlayer} */
        const pobj = {
          iframe,
          watcher,
          old: video.highest,
          softReplace,
        };
        // The video itself, for GET_PLAYED_VIDEO; in a box with more than one, none.
        const inBox = /** @type {HTMLVideoElement[]} */ (video.highest.tagName === 'VIDEO' ? [video.highest] :
          querySelectorAllIncludingShadows('video', video.highest));
        pobj.video = video.video || (inBox.length === 1 ? inBox[0] : null);
        pobj.played = playedVideo(pobj.video);
        replacedPlayerQueue.push(pobj);
        watchPendingPlayer(iframe, request.attempt);

        updateReplacedPlayer(video.highest, iframe, softReplace);

        sendResponse('replace');

        if (softReplace) {
          for (let i = 1; i <= 8; i++) {
            ((i) => {
              setTimeout(() => {
                // A player not linked up yet gets this check when it links up.
                if (i === 4 && replacedPlayerQueue.includes(pobj)) {
                  pobj.convertDue = true;
                }
                updateReplacedPlayers(i === 4 ? pobj : null);
              }, i * 250);
            })(i);
          }
        }

        pobj.resizeObserver = new ResizeObserver(updateReplacedPlayersSoon);
        // An element: a ResizeObserver refuses a shadow root, the parent of a video straight in one.
        pobj.resizeObserver.observe(iframe.parentElement || /** @type {ShadowRoot} */ (iframe.parentNode).host);
      }
    }).catch((e) => {
      // The background must hear back, or it keeps the frame's player opening.
      console.error(e);
      sendResponse('error');
    });
    return true;
  }

  /**
   * @param {*} pobj
   */
  function makeSoftIntoHard(pobj) {
    const {old} = pobj;
    if (!pobj.softReplace) {
      return;
    }

    showSoft(old);
    forgetSoft(old);
    old.remove();
    pobj.softReplace = false;
  }

  /**
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function handleWindowedFullscreen(request, sender, sendResponse) {
    const iframeObj = iframeMap.get(request.frameId);
    if (!iframeObj) {
      sendResponse('no_element');
      console.error('No element found for frame id ' + request.frameId);
      return;
    }

    const windowedFullscreenState = iframeObj.windowedFullscreenState;

    // A state not entered yet has no `active`: an exit asked of it (force false) entered.
    if (request.force === undefined || request.force !== !!windowedFullscreenState.active) {
      windowedFullscreenToggle(iframeObj);
    }

    if (windowedFullscreenState.active) {
      sendResponse('enter');
    } else {
      sendResponse('exit');
    }
  }

  /**
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function handleMiniplayer(request, sender, sendResponse) {
    if (Date.now() < MiniplayerCooldown) {
      sendResponse('cooldown');
      return;
    }

    const iframeObj = iframeMap.get(request.frameId);
    if (!iframeObj) {
      sendResponse('no_element');
      console.error('No element found for frame id ' + request.frameId);
      return;
    }

    const miniplayerState = iframeObj.miniplayerState;

    miniplayerState.size = request.size;
    miniplayerState.styles = request.styles;
    miniplayerState.playerFrameId = request.playerFrameId;

    if (miniplayerState.closeObserver) {
      miniplayerState.closeObserver.disconnect();
      miniplayerState.closeObserver = null;
    }

    try {
      // As for windowed fullscreen: a state not entered yet is out, not unknown.
      if ((request.force !== undefined && request.force === !!miniplayerState.active) || iframeObj.windowedFullscreenState.active || document.fullscreenElement) {
        updateMiniPlayer(iframeObj);
      } else {
        toggleMiniPlayer(iframeObj);
      }
    } catch (e) {
      // The player must hear back.
      console.error(e);
      sendResponse('error');
      return;
    }

    if (miniplayerState.active && request.autoExit) {
      const observer = new IntersectionObserver(async ([entry]) => {
        if (entry.intersectionRatio > 0.3 && miniplayerState.active) {
          observer.disconnect();

          const result = await sendToPlayer(miniplayerState.playerFrameId, {
            type: 'miniplayer-state',
            value: false,
          });

          if (result !== 'recieved') {
            console.error('Failed to send miniplayer state to player, assuming its closed');
            unmakeMiniPlayer(iframeObj);
            updateReplacedPlayers();
          }
        }
      }, {
        // 0.3 too: an entry comes only where the ratio crosses one, and the test above is > 0.3.
        threshold: [0, 0.25, 0.3, 0.5],
      });
      observer.observe(miniplayerState.placeholder);
      miniplayerState.closeObserver = observer;
    }

    if (miniplayerState.active) {
      sendResponse('enter');
    } else {
      sendResponse('exit');
    }
  }

  /**
   * Tells a player something of its page (through the background, SEND_TO_PLAYER).
   * @param {number|undefined} frameId - The player's frame: none for a state never entered.
   * @param {*} data
   * @return {Promise<*>} Its answer; undefined when there is none, or no player to ask.
   */
  function sendToPlayer(frameId, data) {
    if (typeof frameId !== 'number') return Promise.resolve(undefined);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: MessageTypes.SEND_TO_PLAYER,
        frameId,
        data,
      }, (response) => {
        // A player gone meanwhile: no answer, which the caller reads as such.
        void chrome.runtime.lastError;
        resolve(response);
      });
    });
  }

  /**
   * Whether an element is in fullscreen, asked of its own tree: for an iframe in a shadow root,
   * the document's fullscreenElement is the host.
   * @param {Element} element
   * @return {boolean}
   */
  function isFullscreenElement(element) {
    return /** @type {Document|ShadowRoot} */ (element.getRootNode()).fullscreenElement === element;
  }

  /**
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function handleFullscreen(request, sender, sendResponse) {
    if (request.queryPermissions) {
      sendResponse(!!document.fullscreenEnabled);
      return;
    }

    const iframeObj = iframeMap.get(request.frameId);
    if (!iframeObj) {
      sendResponse('no_element');
      console.error('No element found for frame id ' + request.frameId);
      return;
    }

    const fullscreenState = iframeObj.fullscreenState;
    fullscreenState.playerFrameId = request.playerFrameId;

    const element = iframeObj.iframe;
    const force = request.force;

    const newValue = force === undefined ? !isFullscreenElement(element) : force;
    fullscreenState.active = newValue;
    if (!newValue) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
      sendResponse('exit');
    } else {
      /** @type {Promise<void>} */ (element.requestFullscreen()).then(() => {
        sendResponse('enter');
      }).catch((e) => {
        // Refused (no user gesture): the player hears 'error', and the state follows the page.
        fullscreenState.active = isFullscreenElement(element);
        console.error(e);
        sendResponse('error');
      });
    }
    return true;
  }

  // 'subtitles' is also what a <track> with no kind attribute reports.
  const ScrapedTrackKinds = ['subtitles', 'captions'];
  // Bounds on one reading of the page's tracks, all of which go to the background.
  const ScrapedTracksMax = 64;
  const ScrapedBytesMax = 64 * 1024 * 1024;

  /**
   * @param {*} request
   * @param {*} sender
   * @param {Function} sendResponse
   */
  function handleCaptionsScrape(request, sender, sendResponse) {
    // All counted before any is asked for: a request can fail at once, inside the loop.
    const trackElements = /** @type {HTMLTrackElement[]} */ (querySelectorAllIncludingShadows('track'))
        .filter((track) => track.src && ScrapedTrackKinds.includes(track.kind))
        .slice(0, ScrapedTracksMax);
    // Shared by the requests, which run at once.
    const budget = {left: ScrapedBytesMax};
    const pending = trackElements.length;
    let done = 0;
    /** @type {{data: string, source: string, label: string, language: string}[]} */
    const tracks = [];
    for (let i = 0; i < trackElements.length; i++) {
      const track = trackElements[i];
      const source = track.src;
      httpRequest(source, (/** @type {*} */ err, /** @type {*} */ req, /** @type {*} */ body) => {
        done++;
        if (body) {
          tracks.push({
            data: body,
            source: source,
            label: track.label,
            language: track.srclang,
          });
        }
        if (done === pending) sendResponse(tracks);
      }, budget);
    }
    if (pending === 0) sendResponse(tracks);

    return true;
  }

  /**
   * Pauses every playing media element in this frame, for a stream handed to mpv.
   * @return {number} How many elements were paused.
   */
  function pauseAllMedia() {
    let paused = 0;
    // Closed shadow roots too: a web-component player keeps its <video> in one.
    /** @type {HTMLMediaElement[]} */ (querySelectorAllInAllShadows('video, audio', document.documentElement)).forEach((media) => {
      try {
        if (!media.paused && !playsLiveStream(media)) {
          media.pause();
          paused++;
        }
      } catch (e) {
        // A cross-origin or detached element: nothing to do about it.
      }
    });
    return paused;
  }

  /**
   * Whether a media element plays a MediaStream (srcObject): a call's, which is never paused.
   * @param {HTMLMediaElement} media - The element.
   * @return {boolean}
   */
  function playsLiveStream(media) {
    return typeof MediaStream !== 'undefined' && media.srcObject instanceof MediaStream;
  }

  // HOLD_PAGE_MEDIA: the page's media stays paused while a player in this tab plays.
  let pageMediaHeld = false;

  /**
   * @param {boolean} hold - Whether a FastStream player in the tab plays.
   */
  function holdPageMedia(hold) {
    pageMediaHeld = hold;
    if (hold) {
      // A play inside a shadow root reaches only that root's listeners.
      listenInShadowRoots(document);
      pauseAllMedia();
    }
  }

  /** @param {*} e */
  function pauseHeldMedia(e) {
    const media = e.target;
    if (pageMediaHeld && media && (media.tagName === 'VIDEO' || media.tagName === 'AUDIO') &&
        !playsLiveStream(media)) {
      media.pause();
    }
  }

  function removePlayers() {
    PlayersEpoch++;
    MiniplayerCooldown = Date.now() + 1000;
    pageMediaHeld = false;
    OverlayGuard.releaseAll();
    iframeMap.forEach((iframeObj) => {
      unmakeMiniPlayer(iframeObj);
      // Only leaving windowed fullscreen gives the iframe its own style back.
      if (iframeObj.windowedFullscreenState.active) {
        windowedFullscreenToggle(iframeObj);
      }
      if (iframeObj.replacedData) {
        restoreReplaced(iframeObj.replacedData);
        iframeObj.replacedData = null;
      }
    });

    undoFillScreenIframe();

    replacedPlayerQueue.forEach(restoreReplaced);
    replacedPlayerQueue.length = 0;

    overlayPlayers.forEach(({iframe, watcher}) => {
      iframe.remove();
      stopPausing(watcher);
    });
    overlayPlayers.length = 0;

    // Taking an iframe out runs no beforeunload in it: each one gone is reported here, once.
    iframeMap.forEach((iframeObj, frameId) => {
      if (!iframeObj.iframe.isConnected) {
        iframeMap.delete(frameId);
        notifyBackground({
          type: MessageTypes.FRAME_REMOVED,
          frameId,
        });
      }
    });
  }

  /**
   * Puts the page's own element back where a player replaced it, and lets its media play again.
   * The iframe may be out of the page already: remove() and replaceWith() do nothing then.
   * @param {ReplacedPlayer} replacedData - The replacement, from handlePlayerOpen.
   */
  function restoreReplaced(replacedData) {
    const {iframe, old} = replacedData;
    if (replacedData.softReplace) {
      showSoft(old);
      forgetSoft(old);
      iframe.remove();
    } else {
      iframe.replaceWith(old);
    }
    transferId(iframe, old);
    restoreTransition(old);
    stopPausing(replacedData.watcher);
    replacedData.resizeObserver?.disconnect();
  }

  /** @param {*} iframeObj */
  function updateMiniPlayer(iframeObj) {
    const miniplayerState = iframeObj.miniplayerState;
    if (miniplayerState.active) {
      const placeholder = miniplayerState.placeholder;
      const element = miniplayerState.element;
      // A placeholder without a size (in a hidden part of the page) has no shape to keep.
      let aspectRatio = placeholder.clientWidth / placeholder.clientHeight;
      if (!(aspectRatio > 0 && aspectRatio < Infinity)) {
        aspectRatio = 16 / 9;
      }
      // Within its share of the screen both ways, for a portrait player too.
      const newWidth = Math.min(Math.min(window.screen.width, window.screen.height * aspectRatio) * miniplayerState.size, document.body.clientWidth);
      const newHeight = newWidth / aspectRatio;
      element.style.setProperty('width', newWidth + 'px', 'important');
      element.style.setProperty('height', newHeight + 'px', 'important');

      for (const key in miniplayerState.styles) {
        if (Object.hasOwn(miniplayerState.styles, key)) {
          element.style.setProperty(key, miniplayerState.styles[key], 'important');
        }
      }
    }
  }

  function resizeMiniPlayers() {
    iframeMap.forEach((iframeObj) => {
      updateMiniPlayer(iframeObj);
    });
  }

  /** @param {*} iframeObj */
  function makeMiniPlayer(iframeObj) {
    const miniplayerState = iframeObj.miniplayerState;
    if (miniplayerState.active) {
      return;
    }

    // The page took the iframe out (a re-render): nothing to shrink.
    if (!iframeObj.iframe.isConnected) {
      return;
    }

    miniplayerState.active = true;

    // Not the body itself: a wrapper filling it made the body the miniplayer.
    const parentElementsWithSameBounds = getParentElementsWithSameBounds(iframeObj.iframe)
        .filter((parent) => parent.tagName !== 'BODY');
    const element = parentElementsWithSameBounds.length > 0 ? parentElementsWithSameBounds[parentElementsWithSameBounds.length - 1] : iframeObj.iframe;
    // Never a new iframe or a custom element: either started a second player.
    const placeholder = document.createElement(element.tagName === 'IFRAME' || element.tagName.includes('-') ? 'div' : element.tagName);

    miniplayerState.element = element;

    transferId(element, placeholder);

    miniplayerState.placeholder = placeholder;
    miniplayerState.oldStyle = element.getAttribute('style') || '';

    transferStyles(element, placeholder, true);

    placeholder.style.setProperty('background-color', 'black', 'important');
    placeholder.classList = element.classList;

    element.parentNode.insertBefore(placeholder, element);

    element.setAttribute('style', `
    position: fixed !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    padding: 0px !important;
    z-index: 2147483647 !important;
    border: 1px solid rgba(0, 0, 0, 0.2) !important;
    outline: none !important;
    top: auto !important;
    left: auto !important;
    right: auto !important;
    bottom: auto !important;
    pointer-events: auto !important;
    border-radius: 0px !important;`);
    updateMiniPlayer(iframeObj);
  }

  /** @param {*} iframeObj */
  function unmakeMiniPlayer(iframeObj) {
    const miniplayerState = iframeObj.miniplayerState;
    if (!miniplayerState.active) {
      return;
    }

    if (miniplayerState.closeObserver) {
      miniplayerState.closeObserver.disconnect();
      miniplayerState.closeObserver = null;
    }

    const element = miniplayerState.element;

    miniplayerState.active = false;

    element.setAttribute('style', miniplayerState.oldStyle);

    transferId(miniplayerState.placeholder, element);

    miniplayerState.placeholder.remove();
    miniplayerState.placeholder = null;
  }

  /** @param {*} iframeObj */
  function toggleMiniPlayer(iframeObj) {
    const miniplayerState = iframeObj.miniplayerState;
    if (miniplayerState.active) {
      unmakeMiniPlayer(iframeObj);
      return false;
    } else {
      makeMiniPlayer(iframeObj);
      return true;
    }
  }

  /** @param {*} iframeObj */
  function windowedFullscreenToggle(iframeObj) {
    const windowedFullscreenState = iframeObj.windowedFullscreenState;

    if (!windowedFullscreenState.active) {
      if (iframeObj.miniplayerState.active) {
        unmakeMiniPlayer(iframeObj);
      }

      windowedFullscreenState.active = true;
      windowedFullscreenState.oldStyle = iframeObj.iframe.getAttribute('style') || '';
      windowedFullscreenState.fillScreenWhitelist = fillScreenIframe(iframeObj.iframe);
    } else {
      windowedFullscreenState.active = false;
      iframeObj.iframe.setAttribute('style', windowedFullscreenState.oldStyle);
      undoFillScreenIframe(windowedFullscreenState.fillScreenWhitelist);
      // Again a second later, for a page whose scripts lay it out once it has its styles back.
      updateReplacedPlayers();
      setTimeout(() => {
        updateReplacedPlayers();
      }, 1000);
    }
  }

  /** @param {Element[]} [whitelist] */
  function undoFillScreenIframe(whitelist) {
    const only = whitelist ? new Set(whitelist) : null;
    elementsChangedByFillscreen.forEach((old, element) => {
      if (!only || only.has(element)) {
        if (old.style !== undefined && element.getAttribute('style') === old.filled) {
          element.setAttribute('style', old.style);
        } else if (old.style !== undefined) {
          // The page wrote to it meanwhile: what the fill set goes back, what the page wrote stays.
          const before = document.createElement('div').style;
          before.cssText = old.style;
          const filled = document.createElement('div').style;
          filled.cssText = old.filled;
          for (let i = 0; i < filled.length; i++) {
            const name = filled.item(i);
            if (element.style.getPropertyValue(name) === filled.getPropertyValue(name) &&
              element.style.getPropertyPriority(name) === filled.getPropertyPriority(name)) {
              // An empty value takes it out.
              element.style.setProperty(name, before.getPropertyValue(name), before.getPropertyPriority(name));
            }
          }
          // What the fill took out with the old attribute, unless the page set it since.
          for (let i = 0; i < before.length; i++) {
            const name = before.item(i);
            if (!filled.getPropertyValue(name) && !element.style.getPropertyValue(name)) {
              element.style.setProperty(name, before.getPropertyValue(name), before.getPropertyPriority(name));
            }
          }
        } else if (element.style.getPropertyValue('display') !== 'none' ||
            element.style.getPropertyPriority('display') !== 'important') {
          // The page set it since (a menu it closed): its value stays.
        } else if (old.display) {
          element.style.setProperty('display', old.display, old.priority);
        } else {
          element.style.removeProperty('display');
        }
        elementsChangedByFillscreen.delete(element);
      }
    });
  }

  /** @param {HTMLIFrameElement} iframe */
  function fillScreenIframe(iframe, skipHide = false) {
    /** @type {Element[]} */
    const addedElements = [];
    const expandStyle =
    `position: fixed !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    padding: 0px !important;
    z-index: 2147483647 !important;
    border: none !important;
    outline: none !important;
    top: 0px !important;
    left: 0px !important;
    width: 100% !important;
    height: 100% !important;
    bottom: 0px !important;
    right: 0px !important;
    pointer-events: auto !important;
    border-radius: 0px !important;`;
    if (!skipHide) {
      const elementsToHide = [];
      const elementsToExpand = [];
      // Shadow roots and slots included: a web-component player's bar sits next to it.
      const trace = new Set(flatTreeParents(iframe));

      // Every element but the iframe's parents, in shadow roots too, each root's after its host.
      const elements = OverlayGuard.allElements();
      for (let i = 0; i < elements.length; i++) {
        const element = /** @type {HTMLElement} */ (elements[i]);
        if (element === iframe) {
          continue;
        }

        if (
          element.tagName === 'BODY' ||
          element.tagName === 'HTML' ||
          element.tagName === 'HEAD'
        ) {
          continue;
        }

        // Nothing in the <head> is shown: its <meta>, <script> and <style> are no layers.
        if (document.head && document.head.contains(element)) {
          continue;
        }
        // Nor a shadow root's own styles and scripts.
        if (NotLayerTags.has(element.tagName)) {
          continue;
        }

        if (trace.has(element)) {
          elementsToExpand.push(element);
        } else {
          elementsToHide.push(element);
        }
      }

      elementsToHide.forEach((element) => {
        if (element === iframe) {
          return;
        }
        if (elementsChangedByFillscreen.has(element)) {
          return;
        }
        elementsChangedByFillscreen.set(element, {
          display: element.style.getPropertyValue('display'),
          priority: element.style.getPropertyPriority('display'),
        });
        element.style.setProperty('display', 'none', 'important');
        addedElements.push(element);
      });

      elementsToExpand.forEach((element) => {
        if (element === iframe) {
          return;
        }
        if (elementsChangedByFillscreen.has(element)) {
          return;
        }
        const old = element.getAttribute('style') || '';
        element.setAttribute('style', expandStyle);
        // filled: the attribute as the fill left it, to tell whether the page wrote to it since.
        elementsChangedByFillscreen.set(element, {style: old, filled: element.getAttribute('style')});
        addedElements.push(element);
      });
    }

    iframe.setAttribute('style', expandStyle);

    return /** @type {Element[]} */ (addedElements);
  }

  // hideSoft and showSoft switch transitions off; the page's own comes back with the element.
  /** @param {HTMLElement} player */
  function rememberTransition(player) {
    if (!('fsTransition' in player.dataset)) {
      player.dataset.fsTransition = player.style.getPropertyValue('transition');
      player.dataset.fsTransitionPriority = player.style.getPropertyPriority('transition');
    }
  }

  /** @param {HTMLElement} player */
  function restoreTransition(player) {
    if (!('fsTransition' in player.dataset)) {
      return;
    }
    const value = player.dataset.fsTransition;
    const priority = player.dataset.fsTransitionPriority;
    delete player.dataset.fsTransition;
    delete player.dataset.fsTransitionPriority;
    if (value) {
      player.style.setProperty('transition', value, priority);
    } else {
      player.style.removeProperty('transition');
    }
  }

  // No size, no overflow, no flex share: a flex item's size is its share (`flex: 1 1 0%`).
  /** @type {Object<string, string>} */
  const SoftHidden = {'width': '0px', 'height': '0px', 'overflow': 'hidden', 'margin': '0px', 'contain': 'paint',
    'flex-grow': '0', 'flex-basis': '0px'};

  /**
   * The page's own inline values of those, with their priority, until the element is given back.
   * Kept here, not in the page's DOM, which the page can change.
   * @type {WeakMap<HTMLElement, Object<string, string[]>>}
   */
  const softSaves = new WeakMap();

  /**
   * @param {HTMLElement} player
   * @param {string} name
   */
  function isSoftHidden(player, name) {
    return player.style.getPropertyValue(name) === SoftHidden[name] &&
      player.style.getPropertyPriority(name) === 'important';
  }

  /** @param {HTMLElement} player */
  function hideSoft(player) {
    rememberTransition(player);
    // Saved again where the value is no longer the hidden one: the page's newest wish.
    const saved = softSaves.get(player) || {};
    softSaves.set(player, saved);
    for (const name of Object.keys(SoftHidden)) {
      if (!(name in saved) || !isSoftHidden(player, name)) {
        saved[name] = [player.style.getPropertyValue(name), player.style.getPropertyPriority(name)];
      }
    }
    for (const [name, value] of Object.entries(SoftHidden)) {
      player.style.setProperty(name, value, 'important');
    }
    player.style.setProperty('transition', 'none', 'important');
  }

  // Each saved value back only while it is still the hidden one; the save stays.
  /** @param {HTMLElement} player */
  function showSoft(player) {
    rememberTransition(player);
    player.style.setProperty('transition', 'none', 'important');
    const saved = softSaves.get(player);
    // Not hidden yet: a value equal to the hidden one is the page's own (margin: 0 !important).
    if (!saved) {
      return;
    }
    for (const name of Object.keys(SoftHidden)) {
      if (!isSoftHidden(player, name)) {
        continue;
      }
      const [value, priority] = saved[name] || ['', ''];
      if (value) {
        player.style.setProperty(name, value, priority);
      } else {
        player.style.removeProperty(name);
      }
    }
  }

  /** @param {HTMLElement} player */
  function forgetSoft(player) {
    softSaves.delete(player);
  }

  /** Updates the replaced players for a resize: at most every 100 ms, and once after the last call. */
  function updateReplacedPlayersSoon() {
    clearTimeout(/** @type {Timer} */ (resizeTrailing));
    const now = performance.now();
    if (now - resizeDebounce > 100) {
      resizeDebounce = now;
      updateReplacedPlayers();
    } else {
      resizeTrailing = setTimeout(() => {
        resizeDebounce = performance.now();
        updateReplacedPlayers();
      }, 100);
    }
  }

  /** @param {?ReplacedPlayer} [convert] - A soft replace to make hard if it came out too small. */
  function updateReplacedPlayers(convert = null) {
    iframeMap.forEach((iframeObj) => {
      if (iframeObj.replacedData) {
        const {iframe, old, softReplace} = iframeObj.replacedData;
        if (iframeObj.windowedFullscreenState.active) {
          fillScreenIframe(iframe, true);
        } else if (iframeObj.miniplayerState.active) {
          const placeholder = iframeObj.miniplayerState.placeholder;
          // The placeholder holds the id only when it stands in for the player's iframe itself.
          updateReplacedPlayer(old, placeholder, softReplace, iframeObj.miniplayerState.element === iframe);
          placeholder.style.setProperty('background-color', 'black', 'important');
        } else {
          const final_size = updateReplacedPlayer(old, iframe, softReplace);
          // null: not measured (updateReplacedPlayer), not a player too small.
          if (convert === iframeObj.replacedData && final_size !== null && final_size <= 100 && softReplace) {
            makeSoftIntoHard(iframeObj.replacedData);
            updateReplacedPlayer(old, iframe, false);
          }
        }
      } else if (iframeObj.miniplayerState.active) {
        updateMiniPlayer(iframeObj);
      }
    });
  }

  /**
   * Sizes and places the player as the page's element it replaced: the player is hidden while
   * that element is measured, and takes its styles after.
   * @param {HTMLElement} old
   * @param {HTMLElement} iframe
   * @param {boolean} softReplace
   * @param {boolean} [holdsId]
   * @return {?number} The measured area; null when measuring failed (the player as it was).
   */
  function updateReplacedPlayer(old, iframe, softReplace, holdsId = true) {
    const parent = iframe.parentNode;
    // Nowhere to measure: insertBefore on the missing parent throws.
    if (!softReplace && !parent) {
      return 0;
    }
    // Put back if measuring throws: only transferStyles shows the player again.
    const style = iframe.getAttribute('style');
    const id = iframe.id;
    let shownSoft = false;
    /** @type {?Element} */
    let inserted = null;
    iframe.style.display = 'none';
    try {
      let final_size;
      if (softReplace) {
        showSoft(old);
        shownSoft = true;
        // With its id: the page's #id rules size and place the element.
        if (holdsId) {
          transferId(iframe, old);
        }
        final_size = transferStyles(old, iframe, true);
        hideSoft(old);
        shownSoft = false;
      } else {
        // A stand-in, not the page's element: putting that back runs the page's code for it.
        let fits = standInFits.get(old);
        if (fits === undefined) {
          fits = standInMeasuresAs(old, /** @type {ParentNode} */ (parent), iframe);
          standInFits.set(old, fits);
        }
        const measured = (fits && makeStandIn(old)) || old;
        /** @type {ParentNode} */ (parent).insertBefore(measured, iframe);
        inserted = measured;
        transferId(iframe, measured);
        final_size = transferStyles(measured, iframe, false);
        /** @type {ParentNode} */ (parent).removeChild(measured);
        inserted = null;
      }
      return final_size;
    } catch (e) {
      if (style === null) iframe.removeAttribute('style');
      else iframe.setAttribute('style', style);
      // transferId moved the page's id to what was measured; a stand-in leaves with it.
      if (id && iframe.id !== id) {
        if (old.id === id) old.id = '';
        if (inserted && inserted.id === id) inserted.id = '';
        iframe.id = id;
      }
      if (shownSoft) hideSoft(old);
      inserted?.parentNode?.removeChild(inserted);
      console.warn('FastStream: measuring the page\'s element for the player failed; the player keeps its size', e);
      return null;
    }
  }

  // Elements a stand-in cannot be sized like: what they show sizes them (media, frames,
  // images), or the page's code runs when one is made (custom elements, by their '-').
  const NoStandInTags = new Set(['video', 'audio', 'iframe', 'img', 'canvas', 'object', 'embed', 'picture', 'svg']);

  // For each hard-replaced element, whether its stand-in measures as it does.
  const standInFits = new WeakMap();

  /**
   * An empty element the page's CSS sizes as `old`: same tag and attributes, no children, id or handlers.
   * @param {Element} old - The page's element.
   * @return {?Element} null when no stand-in can be sized like it.
   */
  function makeStandIn(old) {
    const tag = old.localName;
    if (old.namespaceURI !== 'http://www.w3.org/1999/xhtml' || tag.includes('-') || NoStandInTags.has(tag)) {
      return null;
    }
    const standIn = document.createElement(tag);
    for (const {name, value} of Array.from(old.attributes)) {
      if (name !== 'id' && !name.toLowerCase().startsWith('on')) {
        standIn.setAttribute(name, value);
      }
    }
    return standIn;
  }

  /**
   * Measures the element and a stand-in once in the player's place: content can size the element.
   * @param {Element} old - The page's element, out of the page.
   * @param {Node} parent - Where the player is.
   * @param {Element} iframe - The player.
   * @return {boolean} Whether the stand-in had the element's size.
   */
  function standInMeasuresAs(old, parent, iframe) {
    const standIn = makeStandIn(old);
    if (!standIn) {
      return false;
    }
    /** @param {Element} element */
    const measure = (element) => {
      parent.insertBefore(element, iframe);
      transferId(iframe, element);
      const rect = element.getBoundingClientRect();
      transferId(element, iframe);
      parent.removeChild(element);
      return rect;
    };
    const real = measure(old);
    const stood = measure(standIn);
    return real.width > 0 && real.height > 0 &&
      Math.abs(real.width - stood.width) < 0.5 && Math.abs(real.height - stood.height) < 0.5;
  }

  // Weak: pages add and drop media while a player is up (ads, previews on hover).
  /** @type {Set<WeakSet<HTMLMediaElement>>} */
  const PausedHolds = new Set();

  /** @this {HTMLMediaElement} */
  function pauseOnPlay() {
    // A medium the page took out keeps this listener after the player goes.
    if (![...PausedHolds].some((held) => held.has(this))) return;
    // A call's live stream plays on (playsLiveStream), also one given its stream later.
    if (!playsLiveStream(this)) this.pause();
  }

  /** @param {Element} element */
  function pauseAllWithin(element) {
    /** @type {WeakSet<HTMLMediaElement>} */
    const held = new WeakSet();
    PausedHolds.add(held);
    /** @param {HTMLMediaElement} media */
    const hook = (media) => {
      try {
        if (!playsLiveStream(media)) media.pause();
      } catch (e) {
        console.error(e);
      }
      media.addEventListener('play', pauseOnPlay);
      held.add(media);
    };

    // Its sounds too, in closed shadow roots as well.
    /** @type {HTMLMediaElement[]} */ (querySelectorAllInAllShadows('video, audio', element)).forEach(hook);
    // The element itself when it is the page's video: querySelectorAll lists only what is below.
    if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') hook(/** @type {HTMLMediaElement} */ (element));

    // Media added later: themselves, or inside an added subtree (a re-render).
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          // Text nodes too, which have no tagName.
          /** @type {NodeListOf<Element>} */ (mutation.addedNodes).forEach((node) => {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
              hook(/** @type {HTMLMediaElement} */ (node));
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              /** @type {HTMLMediaElement[]} */ (querySelectorAllInAllShadows('video, audio', node)).forEach(hook);
            }
          });
        }
      });
    });
    observer.observe(element, {childList: true, subtree: true});

    return {
      observer,
      held,
    };
  }

  /**
   * Lets go of what a player held paused, wherever the page has moved it by then.
   * @param {PauseWatcher} watcher
   */
  function stopPausing(watcher) {
    PausedHolds.delete(watcher.held);
    watcher.observer.disconnect();
    for (const media of /** @type {HTMLMediaElement[]} */ (querySelectorAllInAllShadows('video, audio', document.documentElement))) {
      if (watcher.held.has(media) && ![...PausedHolds].some((held) => held.has(media))) {
        media.removeEventListener('play', pauseOnPlay);
      }
    }
  }

  /**
   * @param {Element} old
   * @param {HTMLElement} iframe
   * @param {boolean} softReplace
   */
  function transferStyles(old, iframe, softReplace) {
    const rect = old.getBoundingClientRect();
    const styles = window.getComputedStyle(old);

    iframe.setAttribute('style', /** @type {string} */ (old.getAttribute('style')));
    // The setter takes the list's text.
    iframe.classList = /** @type {*} */ (old.classList);

    const width = Math.max(rect.width, 100) + 'px';
    const height = Math.max(rect.height, 100) + 'px';

    iframe.style.setProperty('width', width, 'important');
    iframe.style.setProperty('height', height, 'important');
    iframe.style.setProperty('padding', '0px', 'important');
    // The measured size includes the border copied below.
    iframe.style.setProperty('box-sizing', 'border-box', 'important');
    iframe.style.setProperty('opacity', '1', 'important');
    iframe.style.setProperty('pointer-events', 'auto', 'important');
    iframe.style.setProperty('visibility', 'visible', 'important');
    if (styles.display === 'none' || softReplace) {
      iframe.style.setProperty('display', 'block', 'important');
    }

    if (styles.position !== 'static') {
      iframe.style.position = styles.position;
    } else {
      iframe.style.position = 'relative';
    }

    transferId(old, iframe);

    iframe.style.zIndex = styles.zIndex;
    iframe.style.border = styles.border;
    iframe.style.borderRadius = styles.borderRadius;
    iframe.style.boxShadow = styles.boxShadow;

    return rect.width * rect.height;
  }

  /**
   * @param {Element} from
   * @param {Element} to
   */
  function transferId(from, to) {
    const fromId = from.id;
    if (fromId) {
      from.id = '';
      to.id = fromId;
    }
  }

  // A track whose server never answers must not hold up the player: a stall gives it up.
  const HttpRequestStallMs = 2000;
  const HttpRequestTimeoutMs = 10000;

  /**
   * A copy of SubtitleUtils.decodeSubtitleBytes: a classic script cannot import it.
   * @param {ArrayBuffer|ArrayBufferView} data - The file's bytes.
   * @param {?string} [contentType] - The Content-Type it came with over HTTP, if any.
   * @return {string} The file's text.
   */
  function decodeSubtitleBytes(data, contentType) {
    const bytes = ArrayBuffer.isView(data) ?
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data || 0);
    // A byte order mark says what the file is, before anything a server says.
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
    // A charset the server declared, unless it is UTF-8: a file a server calls UTF-8 often
    // is not, and is then read like one that came with no charset.
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
    if (charset) {
      try {
        const decoder = new TextDecoder(charset[1]);
        if (decoder.encoding !== 'utf-8') {
          return decoder.decode(bytes);
        }
      } catch (e) {
        // A charset no browser knows: as if none was given.
      }
    }
    try {
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch (e) {
      // No UTF-8, in an XML file whose declaration names its encoding (a TTML file in ISO-8859-1,
      // say): that one. One that reads as ASCII is no UTF-16, whatever it says.
      const head = String.fromCharCode(...bytes.subarray(0, 200));
      const declaration = head.startsWith('<?xml') ? head.slice(0, head.indexOf('?>') + 1) : '';
      const declared = /\sencoding\s*=\s*["']([A-Za-z][\w.:-]*)["']/.exec(declaration);
      if (declared) {
        try {
          const decoder = new TextDecoder(declared[1]);
          if (!/^utf-(8|16)/.test(decoder.encoding)) {
            return decoder.decode(bytes);
          }
        } catch (e) {
          // An encoding no browser knows: as if none was named.
        }
      }
      // Otherwise the older encoding of the browser's language, as Firefox falls back to.
      // Read as Windows-1252, a Russian, Polish or Greek file showed wrong letters.
      const language = String(globalThis.navigator?.language || '').toLowerCase();
      const legacy = /** @type {Array<[RegExp, string]>} */ ([
        [/^(ru|uk|be|bg|sr|mk)\b/, 'windows-1251'], [/^(pl|cs|sk|sl|hu|hr|ro|bs)\b/, 'windows-1250'],
        [/^el\b/, 'windows-1253'], [/^(tr|az)\b/, 'windows-1254'], [/^he\b/, 'windows-1255'],
        [/^(ar|fa|ur)\b/, 'windows-1256'], [/^(lt|lv|et)\b/, 'windows-1257'], [/^vi\b/, 'windows-1258'],
        [/^th\b/, 'windows-874'], [/^ja\b/, 'shift_jis'], [/^ko\b/, 'euc-kr'],
        [/^zh-(tw|hk|mo|hant)/, 'big5'], [/^zh\b/, 'gb18030'],
      ]).find(([pattern]) => pattern.test(language));
      return new TextDecoder(legacy ? legacy[1] : 'windows-1252').decode(bytes);
    }
  }

  // Answers with the response's text, read as a subtitle file (decodeSubtitleBytes).
  /**
   * @param {string} url - What to ask for, with a GET.
   * @param {Function} callback - Called with the error (true, or none), the response, and
   *   its text (false for none).
   * @param {{left: number}} budget - The bytes the requests sharing it may still read: one
   *   whose body goes past it is given up, as a failed one. A failed one gives its bytes back.
   */
  function httpRequest(url, callback, budget) {
    // Stops when nothing has come for HttpRequestStallMs; the whole request has HttpRequestTimeoutMs.
    const stall = new AbortController();
    /** @type {Timer|undefined} */
    let stallTimer;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), HttpRequestStallMs);
    };
    /** @type {RequestInit} */ const init = {
      method: 'GET',
      signal: AbortSignal.any([stall.signal, AbortSignal.timeout(HttpRequestTimeoutMs)]),
    };

    // The bytes this request took from the budget.
    let read = 0;
    const load = async () => {
      armStallTimer();
      const response = await fetch(url, init);
      if (response.status !== 200) {
        response.body?.cancel().catch(() => {});
        return [true, response, false];
      }
      const chunks = [];
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          armStallTimer();
          const {done, value} = await reader.read();
          if (done) break;
          read += value.byteLength;
          budget.left -= value.byteLength;
          if (budget.left < 0) {
            // Given back at once: a read of another request may already be next.
            budget.left += read;
            read = 0;
            reader.cancel().catch(() => {});
            throw new Error('past the bytes a reading of the tracks takes');
          }
          chunks.push(value);
        }
      }
      const bytes = await new Blob(chunks).arrayBuffer();
      return [undefined, response, decodeSubtitleBytes(bytes, response.headers.get('Content-Type'))];
    };
    // The callback runs outside the catch: one that throws is not a failed request.
    load().catch(() => {
      budget.left += read;
      return [true, undefined, false];
    }).then(([err, response, text]) => {
      clearTimeout(stallTimer);
      callback(err, response, text);
    }).catch((e) => console.error('FastStream: a subtitle answer failed', e));
  }

  /**
   * Whether this frame holds a player iframe, loaded or loading (iframeMap has only loaded ones).
   * @return {boolean}
   */
  function hasPlayerIframe() {
    const playerUrl = chrome.runtime.getURL('player/index.html');
    return querySelectorAllIncludingShadows('iframe').some((iframe) => /** @type {HTMLIFrameElement} */ (iframe).src.startsWith(playerUrl));
  }

  /**
   * Whether an iframe is a FastStream player's, or one a player plays in below it (an
   * embed's, which the background linked to this frame).
   * @param {HTMLIFrameElement} iframe
   * @return {boolean}
   */
  function holdsPlayer(iframe) {
    return iframe.src.startsWith(chrome.runtime.getURL('player/index.html')) ||
      [...iframeMap.values()].some((iframeObj) => iframeObj.iframe === iframe);
  }

  /**
   * Every element matching a query, those in open shadow roots too.
   * @param {string} query - The selector.
   * @param {?Element|DocumentFragment} [currentElement] - Where to look; the body by default.
   * @param {Element[]} [results] - Where to put what is found.
   * @param {(el: Element) => ShadowRoot | null} [shadowOf] - The shadow root to look into, of
   *   an element: its open one by default (querySelectorAllInAllShadows: closed ones too).
   * @return {Element[]}
   */
  function querySelectorAllIncludingShadows(query, currentElement = document.body, results = [],
      shadowOf = (/** @type {Element} */ el) => el.shadowRoot) {
    if (!currentElement) {
      return results;
    }

    Array.from(currentElement.querySelectorAll(query)).forEach((el) => results.push(el));

    const allElements = currentElement.querySelectorAll('*');
    Array.from(allElements).forEach((el) => {
      const shadow = shadowOf(el);
      if (shadow) {
        querySelectorAllIncludingShadows(query, shadow, results, shadowOf);
      }
    });

    // The element's own shadow root too (a re-rendered custom element's <video>); last, so order holds.
    const own = shadowOf(/** @type {Element} */ (currentElement));
    if (own) {
      querySelectorAllIncludingShadows(query, own, results, shadowOf);
    }

    return results;
  }

  /**
   * querySelectorAllIncludingShadows into closed shadow roots too: for what is paused or looked
   * up there, not for where a player goes.
   * @param {string} query - The selector.
   * @param {?Element|DocumentFragment} [root] - Where to look; the body by default.
   * @return {Element[]}
   */
  function querySelectorAllInAllShadows(query, root = document.body) {
    return querySelectorAllIncludingShadows(query, root, [], (/** @type {ShadowHost} */ el) => el.openOrClosedShadowRoot || el.shadowRoot);
  }

  /**
   * @param {Element} element
   */
  function getParentElement(element) {
    return element.parentElement || element.assignedSlot || /** @type {ShadowRoot} */ (element.parentNode)?.host;
  }

  const NotLayerTags = new Set(['STYLE', 'SCRIPT', 'LINK', 'TEMPLATE']);

  /**
   * The element and what it is drawn inside, up to <html>: the slot that shows it before
   * its light-DOM parent, and a shadow root's host after the root's top element.
   * @param {Element} element
   * @return {Element[]}
   */
  function flatTreeParents(element) {
    const parents = [];
    for (let current = element; current;) {
      parents.push(current);
      current = current.assignedSlot || current.parentElement || /** @type {ShadowRoot} */ (current.parentNode)?.host;
    }
    return parents;
  }

  /**
   * How much of an element is on screen, 0 to 1; in a hidden document by its box (boxVisibleRatio).
   * @param {Element} domElement
   * @return {Promise<number>}
   */
  function isVisible(domElement) {
    if (document.visibilityState === 'hidden') {
      return Promise.resolve(boxVisibleRatio(domElement));
    }
    return new Promise((resolve) => {
      const o = new IntersectionObserver(([entry]) => {
        resolve(entry.intersectionRatio);
        o.disconnect();
      });
      o.observe(domElement);
    });
  }

  /**
   * isVisible's measure in a hidden document: the box's part inside the viewport and inside each
   * box above it that clips, as IntersectionObserver has it.
   * @param {Element} element
   * @return {number} 0 to 1.
   */
  function boxVisibleRatio(element) {
    const rect = element.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (!(area > 0)) return 0;
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = window.innerWidth > 0 ? Math.min(rect.right, window.innerWidth) : rect.right;
    let bottom = window.innerHeight > 0 ? Math.min(rect.bottom, window.innerHeight) : rect.bottom;
    const set = (/** @type {string} */ value) => !!value && value !== 'none';
    // 'absolute' or 'fixed' while the walk is between such a box and its containing block.
    let escaping = null;
    for (const current of flatTreeParents(element)) {
      const style = window.getComputedStyle(current);
      const contain = String(style.contain || '');
      const paintContained = /paint|strict|content/.test(contain);
      if (current !== element) {
        const holdsFixed = set(style.transform) || set(style.perspective) || set(style.filter) ||
          set(style.backdropFilter) || paintContained || /layout/.test(contain) ||
          /transform|perspective|filter/.test(String(style.willChange || ''));
        if (escaping === null || holdsFixed || (escaping === 'absolute' && style.position !== 'static')) {
          escaping = null;
          const clipsX = (style.overflowX || style.overflow) !== 'visible' || paintContained;
          const clipsY = (style.overflowY || style.overflow) !== 'visible' || paintContained;
          if (clipsX || clipsY) {
            const box = current.getBoundingClientRect();
            if (clipsX) {
              left = Math.max(left, box.left);
              right = Math.min(right, box.right);
            }
            if (clipsY) {
              top = Math.max(top, box.top);
              bottom = Math.min(bottom, box.bottom);
            }
          }
        }
      }
      if (escaping === null && (style.position === 'absolute' || style.position === 'fixed')) {
        escaping = style.position;
      }
    }
    const width = right - left;
    const height = bottom - top;
    return width > 0 && height > 0 ? width * height / area : 0;
  }

  /**
   * @param {Element} originalElement
   * @param {Element} childElement
   * @param {Element} parentElement
   */
  function testSimilarity(originalElement, childElement, parentElement) {
    const parentStyle = window.getComputedStyle(parentElement);
    const parentRect = parentElement.getBoundingClientRect();
    const childRect = childElement.getBoundingClientRect();

    if (parentStyle.position === 'fixed') {
      return false;
    }

    const originalRect = originalElement.getBoundingClientRect();
    if (parentRect.width === 0 || parentRect.height === 0) {
      return true;
    }

    const tolerance = Math.max(Math.min(originalRect.width, originalRect.height, 5000), 100) * 0.1;
    if (
      Math.abs(originalRect.x - parentRect.x) < tolerance &&
      Math.abs(originalRect.y - parentRect.y) < tolerance &&
      Math.abs(originalRect.width - parentRect.width) < tolerance &&
      Math.abs(originalRect.height - parentRect.height) < tolerance
    ) {
      return true;
    }

    if (parentStyle.overflow === 'hidden') {
      if (childRect.x <= parentRect.x &&
        childRect.y <= parentRect.y &&
        childRect.x + childRect.width >= parentRect.x + parentRect.width &&
        childRect.y + childRect.height >= parentRect.y + parentRect.height) {
        return true;
      }
    }

    return false;
  }

  /**
   * @param {Element} element
   */
  function getParentElementsWithSameBounds(element) {
    const elements = [];
    const originalElement = element;

    while (getParentElement(element)) {
      const parent = getParentElement(element);
      if (testSimilarity(originalElement, element, parent)) {
        elements.push(parent);
      } else {
        break;
      }

      element = parent;

      if (element.tagName === 'BODY') {
        break;
      }
    }

    return elements;
  }

  async function getVideo() {
    const videos = /** @type {HTMLVideoElement[]} */ (Array.from(querySelectorAllIncludingShadows('video')));

    let visibleVideos = await Promise.all(videos.map(async (video) => {
      const visibleRatio = await isVisible(video);
      const rect = video.getBoundingClientRect();
      return {
        video: video,
        visibleArea: rect.width * rect.height * visibleRatio,
      };
    }));

    visibleVideos = visibleVideos.filter((v) => v.visibleArea > 0);

    const largestVideo = visibleVideos.reduce((prev, current) => {
      return (prev && prev.visibleArea > current.visibleArea) ? prev : current;
    }, /** @type {?{video: HTMLVideoElement, visibleArea: number}} */ (null));

    if (!largestVideo) {
      return null;
    }

    const parentElementsWithSameBounds = getParentElementsWithSameBounds(largestVideo.video);
    return {
      video: largestVideo.video,
      size: largestVideo.visibleArea,
      highest: /** @type {HTMLElement} */ (parentElementsWithSameBounds.length > 0 ? parentElementsWithSameBounds[parentElementsWithSameBounds.length - 1] : largestVideo.video),
    };
  }

  /**
   * Starts the page's own player when it waits for a click, after an autoplay next. Once per page.
   * @return {Promise<?string>} What was done, or null.
   */
  async function startPagePlayer() {
    // Started already, or FastStream's player is in this frame.
    if (pagePlayerStarted || iframeMap.size > 0 || pendingPlayers.size > 0) return null;
    // The players' own APIs first: a click can land on an ad's layer.
    const page = /** @type {Window & {wrappedJSObject?: *}} */ (window).wrappedJSObject;
    try {
      // JW Player, as most hosters have it: idle until played.
      if (page && typeof page.jwplayer === 'function') {
        const player = page.jwplayer();
        if (player && typeof player.getState === 'function' && player.getState() === 'idle') {
          player.play();
          // Once it took the play: one that refuses (throws) leaves it to the next way.
          pagePlayerStarted = true;
          return 'jwplayer';
        }
      }
    } catch (e) {
      // Not a JW Player after all, or one that refuses: the next way.
    }
    try {
      // Video.js: one not started yet.
      if (page && typeof page.videojs === 'function' && typeof page.videojs.getPlayers === 'function') {
        const players = page.videojs.getPlayers();
        for (const id of Object.keys(players || {})) {
          const player = players[id];
          if (player && typeof player.paused === 'function' && player.paused() &&
              !(typeof player.hasStarted === 'function' && player.hasStarted())) {
            player.play();
            pagePlayerStarted = true;
            return 'videojs';
          }
        }
      }
    } catch (e) {
      // As above.
    }
    // One ask at a time: finding the video can take a second, and a second click paused it.
    if (pagePlayerLooking) return null;
    pagePlayerLooking = true;
    let found;
    try {
      found = await getVideo();
    } finally {
      pagePlayerLooking = false;
    }
    // FastStream's player may have taken the video meanwhile.
    if (pagePlayerStarted || iframeMap.size > 0 || pendingPlayers.size > 0) return null;
    const video = /** @type {HTMLVideoElement|null} */ (found && found.video);
    if (video && (!video.paused || video.ended)) return null;
    if (video && (video.currentSrc || video.src || video.srcObject)) {
      pagePlayerStarted = true;
      // Not muted: if FastStream does not take the stream, the site's player would stay silent.
      video.play().catch(() => {
        pagePlayerStarted = false;
      });
      return 'play';
    }
    // Nothing loaded: the player's big play button, else a click on the video.
    const button = playButtonFor(video);
    if (button) {
      pagePlayerStarted = true;
      button.click();
      return 'button';
    }
    if (video) {
      pagePlayerStarted = true;
      video.click();
      return 'click';
    }
    return null;
  }

  // The big play buttons of common web players, over their picture before it plays.
  const PlayerPlayButtons = [
    '.vjs-big-play-button', '.plyr__control--overlaid', '.jw-display-icon-container',
    '.fp-play', '.fp-ui', '.mejs__overlay-play', '.mejs-overlay-play', '.player-poster',
    '.art-state', '.dplayer-mobile-play', '.shaka-play-button',
  ].join(', ');
  // Any other button that says it plays: taken only where it lies over the video.
  const GenericPlayButtons = [
    'button[aria-label*="play" i]', '[role="button"][aria-label*="play" i]', 'button[title*="play" i]',
    'button[class*="play" i]', '[class*="big-play" i]', '[class*="play-button" i]', '[class*="playbutton" i]',
  ].join(', ');

  // "play" words that are no play button: "Display", "Autoplay", "Replay", "Playlist", "player-...".
  const NotPlayWords = /display|auto[\s_-]?play|(?<![a-z])re[_-]?play|play[\s_-]?list|play[\s_-]?back|play[\s_-]?speed|play[\s_-]?rate|player/g;

  /**
   * Whether a generic play button still says "play" once the words in NotPlayWords are out.
   * @param {Element} element
   * @return {boolean}
   */
  function saysPlay(element) {
    const words = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('class')];
    return words.some((text) => String(text || '').toLowerCase().replace(NotPlayWords, ' ').includes('play'));
  }

  /**
   * The visible big play button of the page's player: a known player's anywhere (it shows
   * one only over its picture), another one only over the video.
   * @param {?HTMLVideoElement} video - The page's largest video, if there is one.
   * @return {?HTMLElement}
   */
  function playButtonFor(video) {
    const shown = (/** @type {Element} */ element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return null;
      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
      return rect;
    };
    const known = querySelectorAllIncludingShadows(PlayerPlayButtons).find((element) => shown(element));
    if (known) return /** @type {HTMLElement} */ (known);
    if (!video) return null;
    const area = video.getBoundingClientRect();
    return /** @type {HTMLElement | null} */ (querySelectorAllIncludingShadows(GenericPlayButtons).find((element) => {
      if (!saysPlay(element)) return false;
      const rect = shown(element);
      if (!rect) return false;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
    }) || null);
  }

  /**
   * @param {string} urlStr
   */
  function url_to_absolute(urlStr) {
    const url = new URL(urlStr, document.baseURI);
    return url.href;
  }

  /**
   * @param {string|URL} url
   */
  function isLinkToDifferentPageOnWebsite(url) {
    let page;
    try {
      page = new URL(pageAddress());
      url = new URL(url, page);
    } catch (e) {
      return false;
    }

    if (url.origin !== page.origin) {
      return false;
    }

    if (url.pathname !== page.pathname) {
      return true;
    }

    if (url.search !== page.search) {
      return true;
    }

    return false;
  }


  /**
   * @param {Element} element
   * @param {Element} child
   */
  function isSimilar(element, child) {
    const style = window.getComputedStyle(element);
    const width = parseInt(style.width) || 0;
    const height = parseInt(style.height) || 0;

    const cstyle = window.getComputedStyle(child);
    const cwidth = parseInt(cstyle.width) || 0;
    const cheight = parseInt(cstyle.height) || 0;
    if (child.tagName === element.tagName && (cwidth === width || cheight === height) && cstyle.display === style.display && cstyle.position === style.position) {
      return true;
    }
    return false;
  }


  /**
   * @param {Element} element
   * @return {Array<Element>}
   */
  function getSimilar(element) {
    if (!element) return [];
    const parent = element.parentElement;
    if (!parent) return [];
    const children = parent.children;
    if (element.tagName === 'BODY' || !children) return [];


    const found = /** @type {Element[]} */ ([]);
    const potential = /** @type {Element[]} */ ([]);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (isSimilar(element, child)) {
        let count = 0;

        if ((element.children && child.children)) {
          const threshold = Math.ceil(Math.max(element.children.length, child.children.length) * 0.6);

          for (let k = 0; k < element.children.length; k++) {
            const el2 = element.children[k];
            for (let j = 0; j < child.children.length; j++) {
              const ch2 = child.children[j];
              if (isSimilar(el2, ch2)) {
                count++;
                break;
              }
            }
            if (count >= threshold) {
              break;
            }
          }
          if (count >= threshold) {
            found.push(child);
          } else {
            potential.push(child);
          }
        } else if (!element.children && !child.children) {
          found.push(child);
        }
      }
    }

    if (found.length > 1) {
      potential.forEach((item) => {
        found.push(item);
      });
      return found;
    } else {
      return getSimilar(parent);
    }
  }

  /**
   * An address without its #.
   * @param {string} href
   * @return {string}
   */
  function withoutHash(href) {
    return String(href || '').split('#')[0];
  }

  /**
   * A link's own target, in lower case ("_BLANK" opens a new tab too).
   * @param {Element} a
   * @return {string} '' when it has none.
   */
  function ownTarget(a) {
    return (a.getAttribute('target') || '').toLowerCase();
  }

  /**
   * Where a link opens: its own target, else the page's <base target>, in lower case.
   * @param {Element} a
   * @return {string} '' for this frame.
   */
  function linkTarget(a) {
    if (a.hasAttribute('target')) return ownTarget(a);
    return (document.querySelector('base[target]')?.getAttribute('target') || '').toLowerCase();
  }

  /**
   * What a link or a button says: its text, else its aria-label or title (an icon link).
   * @param {Element} el
   * @return {string}
   */
  function wordsOf(el) {
    return (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  }

  /**
   * The one element whose words score this (EpisodeLinks.phraseScore); two different ones are none.
   * @param {Array<Element>} elements
   * @param {boolean} isNext
   * @param {number} score
   * @return {?Element}
   */
  function onlyOneSaying(elements, isNext, score) {
    const hits = elements.filter((el) => EpisodeLinks.phraseScore(wordsOf(el), isNext) === score);
    // A link counts by its address; anything else (a button) by itself.
    const targets = new Set(hits.map((/** @type {Element & {href?: string}} */ el) => (el.tagName === 'A' && typeof el.href === 'string' && el.href ?
      withoutHash(el.href) : el)));
    return targets.size === 1 ? hits[0] : null;
  }

  /**
   * The page's links by trust: site (to this site); series (of those, this page's series);
   * own (of those, the ones opening in the page: a new-tab link is an ad's way).
   * @param {Array<HTMLAnchorElement>} aElements
   * @return {{site: Array<HTMLAnchorElement>, series: Array<HTMLAnchorElement>, own: Array<HTMLAnchorElement>}}
   */
  function episodeLinksOf(aElements) {
    const seriesOfPage = EpisodeLinks.seriesOf(window.location.href);
    const site = aElements.filter((a) => typeof a.href === 'string' && isLinkOnThisSite(a));
    const series = site.filter((a) => EpisodeLinks.inSeries(seriesOfPage, a.href));
    return {site, series, own: series.filter((a) => ownTarget(a) !== '_blank')};
  }

  /**
   * Whether the page lists this season: it links the previous episode, or two other episodes.
   * @param {Array<HTMLAnchorElement>} links - episodeLinksOf's series links.
   * @return {boolean}
   */
  function listsThisSeason(links) {
    const previous = EpisodeLinks.neighbourEpisodeUrls(window.location.href, false);
    if (links.some((a) => previous.includes(withoutHash(a.href)))) return true;
    const here = EpisodeLinks.seasonEpisode(window.location.href);
    if (!here) return false;
    const others = new Set();
    for (const a of links) {
      const at = EpisodeLinks.seasonEpisode(a.href);
      if (at && at.show === here.show && at.season === here.season && at.episode !== here.episode) others.add(at.episode);
    }
    return others.size >= 2;
  }

  /**
   * Whether this page is its series' last episode, as far as its links tell.
   * @return {boolean}
   */
  function isSeriesEnd() {
    if (!EpisodeLinks.seriesOf(window.location.href)) return false;
    const links = episodeLinksOf(/** @type {HTMLAnchorElement[]} */ (querySelectorAllIncludingShadows('a')));
    return listsThisSeason(links.series) && !linksLaterInSeason(links.site);
  }

  /**
   * Whether the page links a later episode of this page's season: a gap before it (a removed
   * episode) is no season's end.
   * @param {Array<HTMLAnchorElement>} siteLinks - episodeLinksOf's site links, into a new tab too.
   * @return {boolean}
   */
  function linksLaterInSeason(siteLinks) {
    const here = EpisodeLinks.seasonEpisode(window.location.href);
    if (!here) return false;
    return siteLinks.some((a) => {
      const at = EpisodeLinks.seasonEpisode(a.href);
      return !!at && at.show === here.show && at.season === here.season && at.episode > here.episode;
    });
  }

  function getNextOrPreviousButton(isNext = false) {
    const aElements = /** @type {HTMLAnchorElement[]} */ (querySelectorAllIncludingShadows('a'));
    const links = episodeLinksOf(aElements);
    const ownLinks = links.own;
    const series = EpisodeLinks.seriesOf(window.location.href);

    // 1. This page's episode number +1 (or -1) where the page links it, new-tab links too.
    for (const candidate of EpisodeLinks.neighbourEpisodeUrls(window.location.href, isNext)) {
      const hit = links.series.find((a) => withoutHash(url_to_absolute(a.href)) === candidate);
      if (hit) return hit;
    }

    // A page that names its series and lists its season tells by its links alone.
    const structured = !!series && listsThisSeason(links.series);

    // 1b. A season's last episode: the next season's first, unless a later one of this season is linked.
    if (isNext && structured && !linksLaterInSeason(links.site)) {
      const here = EpisodeLinks.seasonEpisode(window.location.href);
      const next = EpisodeLinks.nextSeason(window.location.href);
      if (here && next) {
        const ofNext = /** @type {Array<{a: HTMLAnchorElement, at: *}>} */ (links.series.map((a) => ({a, at: EpisodeLinks.seasonEpisode(a.href)}))
            .filter(({at}) => !!at && at.show === here.show && at.season === here.season + 1));
        const linked = ofNext.find(({at}) => at.episode === 1) || ofNext.find(({at}) => at.episode === here.episode + 1);
        if (linked) return linked.a;
        const linksSeason = (/** @type {HTMLAnchorElement} */ a) => {
          const path = withoutHash(a.href).split('?')[0].replace(/\/$/, '');
          return path.startsWith(next.season) && !/^\d/.test(path.slice(next.season.length));
        };
        if (ofNext.length > 0 || links.site.some(linksSeason)) {
          const first = document.createElement('a');
          first.href = next.first;
          return first;
        }
      }
    }

    // 2. An episode phrase in a link's text, aria-label or title, or on a button.
    const buttons = structured ? [] : /** @type {Array<HTMLElement & {disabled?: boolean}>} */ (querySelectorAllIncludingShadows('button, [role="button"]'))
        .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    const phrase = onlyOneSaying(ownLinks, isNext, 2) || onlyOneSaying(buttons, isNext, 2);
    if (phrase) return phrase;

    // 3. The list ways, without new-tab links; a link of another series is none.
    const found = getNextOrPreviousByList(aElements.filter((a) => ownTarget(a) !== '_blank'), isNext);
    if (found && (found.tagName !== 'A' || (typeof found.href === 'string' && EpisodeLinks.inSeries(series, found.href)))) {
      return found;
    }

    // 4. rel=next (or prev), then a bare word: pagination uses them too, so last.
    const rel = ownLinks.find((a) => (a.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes(isNext ? 'next' : 'prev'));
    return rel || onlyOneSaying(ownLinks, isNext, 1);
  }

  /**
   * 3. An English "next" or "next episode" link, the neighbour of this page's link in a list,
   * an "Episode N" list.
   * @param {Array<HTMLAnchorElement>} aElements
   * @param {boolean} isNext
   * @return {?HTMLAnchorElement}
   */
  function getNextOrPreviousByList(aElements, isNext) {
    const matches = aElements.filter((a) => {
      const textContent = a.textContent.trim().toLowerCase();
      if (isNext) {
        return textContent === 'next' || textContent === 'next episode';
      } else {
        return textContent === 'previous' || textContent === 'previous episode' || textContent === 'prev' || textContent === 'prev episode';
      }
    }).filter(isLinkOnThisSite);

    if (matches.length === 1) {
      return matches[0];
    }

    const currentURL = window.location.href;
    const matchedElements = aElements.filter((a) => {
      if (!/** @type {HTMLAnchorElement} */ (a).href) {
        return false;
      }
      try {
        const url = url_to_absolute(/** @type {HTMLAnchorElement} */ (a).href);
        return url === currentURL;
      } catch (e) {
        return false;
      }
    });

    // Only this page's own link tells where it is in a list.
    if (matchedElements.length === 0) {
      return null;
    }

    for (let i = 0; i < matchedElements.length; i++) {
      const element = matchedElements[i];
      const similar = getSimilar(element);
      if (similar.length > 0) {
        const index = similar.findIndex((el) => {
          if (el === element) {
            return true;
          }

          if (el.contains(element)) {
            return true;
          }

          return false;
        });

        if (index === -1) {
          continue;
        }

        const nextIndex = isNext ? index + 1 : index - 1;

        if (nextIndex < 0 || nextIndex >= similar.length) {
          continue;
        }

        // Only one to this site: a list's neighbour may be an ad.
        if (similar[nextIndex].tagName === 'A') {
          if (isLinkOnThisSite(/** @type {HTMLAnchorElement} */ (similar[nextIndex]))) {
            return /** @type {HTMLAnchorElement} */ (similar[nextIndex]);
          }
          continue;
        }

        // A neighbour without a link ends this match only: another may lead to the episode.
        const link = similar[nextIndex].querySelector('a');
        if (link && isLinkOnThisSite(link)) {
          return link;
        }
      }
    }
    return null;
  }

  /**
   * Whether a link leads to a page of this site.
   * @param {HTMLAnchorElement} a - The link.
   * @return {boolean}
   */
  function isLinkOnThisSite(a) {
    if (!a.href) {
      return false;
    }
    try {
      const url = url_to_absolute(a.href);
      return (new URL(url)).origin === new URL(pageAddress()).origin;
    } catch (e) {
      return false;
    }
  }

  PageListeners.add(document, 'click', (e) => {
    // By the click's path first: in a web component the click's target is its host.
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    let current = /** @type {?Element} */ (path.find((node) => /** @type {?Element} */ (node)?.tagName === 'A') || null);
    if (!current) current = /** @type {?Element} */ (e.target);
    while (current) {
      if (current.tagName === 'A') {
        break;
      }
      current = getParentElement(current);
    }

    if (!current || !/** @type {HTMLAnchorElement} */ (current).href) {
      return;
    }

    // A click that opens the link elsewhere (a new tab or window, a download) leaves the player.
    const target = linkTarget(/** @type {HTMLAnchorElement} */ (current));
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey ||
        current.hasAttribute('download') ||
        (target && !['_self', '_parent', '_top'].includes(target))) {
      return;
    }

    const url = /** @type {HTMLAnchorElement} */ (current).href;
    if (isLinkToDifferentPageOnWebsite(url)) {
      // Decided after the page's own listeners: a link the page handles itself keeps the player.
      const address = window.location.pathname + window.location.search;
      setTimeout(() => {
        if (!e.defaultPrevented || window.location.pathname + window.location.search !== address) {
          removePlayers();
        }
      }, 0);
    }
  }, true);


  PageListeners.add(document, 'fullscreenchange', () => {
    const changedFor = /** @type {any[]} */ ([]);
    iframeMap.forEach((iframeObj) => {
      const fullscreenState = iframeObj.fullscreenState;
      const element = iframeObj.iframe;
      const active = isFullscreenElement(element);
      if (active !== fullscreenState.active) {
        fullscreenState.active = active;
        changedFor.push(iframeObj);
      }
    });

    changedFor.forEach((iframeObj) => {
      sendToPlayer(iframeObj.fullscreenState.playerFrameId, {
        type: 'fullscreen-state',
        value: iframeObj.fullscreenState.active,
      });
    });
  });

  PageListeners.add(window, 'resize', () => {
    updateReplacedPlayersSoon();
    resizeMiniPlayers();
  });

  // Arms the background's popup guard: ad scripts open a popup from this blur.
  PageListeners.add(window, 'blur', () => {
    // Shadow roots too: a player in a web component's root has its host as activeElement.
    const active = OverlayGuard.focused();
    if (!active) return;
    let isOurIframe = false;
    iframeMap.forEach((iframeObj) => {
      if (iframeObj.iframe === active) isOurIframe = true;
    });
    if (isOurIframe) {
      notifyBackground({type: MessageTypes.POPUP_GUARD_ARM});
    }
  });

  /**
   * What a video plays, for the player to play the same stream (StreamPick.played).
   * @param {HTMLVideoElement|null|undefined} video - The video.
   * @return {?PlayedVideo} Null for no video; src is never a blob: URL.
   */
  function playedVideo(video) {
    if (!video) {
      return null;
    }
    const src = video.currentSrc || '';
    return {
      src: /^https?:\/\//i.test(src) ? src : '',
      duration: video.duration > 0 ? video.duration : null,
      playing: src,
      // Where it is: mpv starts there (background sendPlayedToMpv).
      time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    };
  }

  /**
   * What the replaced video plays: as now while it plays what it did, else as it was then.
   * @param {ReplacedPlayer|undefined} player - The replaced player (replacedPlayerQueue).
   * @return {?{src: string, duration: ?number}} See playedVideo.
   */
  function replacedVideo(player) {
    if (!player || !player.played) {
      return null;
    }
    const now = playedVideo(player.video);
    const {src, duration} = now && now.playing === player.played.playing ? now : player.played;
    return {src, duration};
  }

  // The requests a page's player makes for its stream, as Resource Timing names them.
  const LoadedMediaInitiators = ['xmlhttprequest', 'fetch', 'video', 'audio', 'other'];

  // Past the 250 entries Resource Timing keeps: the newest of them, manifests last.
  const ObservedMediaLimit = 1000;
  const observedMedia = new Map();
  const ManifestAddress = /\.(?:m3u8|m3u|mpd)$/i;

  /**
   * Whether a request is for a manifest: by its address, or by the one a proxy's query names.
   * @param {string} url - The request's.
   * @return {boolean}
   */
  function namesManifest(url) {
    try {
      const parsed = new URL(url);
      return ManifestAddress.test(parsed.pathname) ||
        [...parsed.searchParams.values()].some((value) => ManifestAddress.test(value.split(/[?#]/)[0]));
    } catch (e) {
      return false;
    }
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!LoadedMediaInitiators.includes(/** @type {PerformanceResourceTiming} */ (entry).initiatorType) || observedMedia.has(entry.name)) continue;
        if (observedMedia.size >= ObservedMediaLimit) {
          let oldest = observedMedia.keys().next().value;
          for (const [url, media] of observedMedia) {
            if (!media.manifest) {
              oldest = url;
              break;
            }
          }
          observedMedia.delete(oldest);
        }
        observedMedia.set(entry.name, {
          name: entry.name,
          initiatorType: /** @type {PerformanceResourceTiming} */ (entry).initiatorType,
          responseStatus: /** @type {PerformanceResourceTiming} */ (entry).responseStatus,
          startTime: entry.startTime,
          manifest: namesManifest(entry.name),
        });
      }
    }).observe({type: 'resource', buffered: true});
  } catch (e) {
    // No observer: the timeline's own buffer is all there is.
  }

  /**
   * What this page loaded that may be a stream, for a background unloaded meanwhile.
   * @return {Array<{url: string, media: boolean, time: number}>} Each URL, whether a media
   *   element loaded it, and when the request started (ms since the epoch).
   */
  function loadedMedia() {
    const found = /** @type {Array<{url: string, media: boolean, time: number}>} */ ([]);
    let entries = /** @type {PerformanceResourceTiming[]} */ ([]);
    try {
      entries = /** @type {PerformanceResourceTiming[]} */ (Array.from(performance.getEntriesByType('resource')));
    } catch (e) {
      // No timeline: the videos still tell theirs.
    }
    const inTimeline = new Set(entries.map((entry) => entry.name));
    observedMedia.forEach((entry, url) => {
      if (!inTimeline.has(url)) entries.push(entry);
    });
    for (const entry of entries) {
      if (!LoadedMediaInitiators.includes(entry.initiatorType)) continue;
      // An error answer is no stream. The status is 0 when the server did not share it.
      if (entry.responseStatus >= 400) continue;
      found.push({
        url: entry.name,
        media: entry.initiatorType === 'video' || entry.initiatorType === 'audio',
        time: performance.timeOrigin + entry.startTime,
      });
    }
    querySelectorAllInAllShadows('video, audio').forEach((media) => {
      const src = /** @type {HTMLMediaElement} */ (media).currentSrc || '';
      if (/^https?:\/\//i.test(src) && !found.some((entry) => entry.url === src)) {
        found.push({url: src, media: true, time: Date.now()});
      }
    });
    return found;
  }

  // The videos the user started: MPV by its shortcut takes only those, not an autoplay.
  const userStartedVideos = new WeakSet();

  // How long Firefox counts a press as the user's (dom.user_activation.transient.timeout).
  const UserActivationMs = 5000;
  // When the user last pressed a pointer or a key in this frame (trusted; onUserGesture).
  let lastUserGestureAt = -Infinity;
  // When this frame last saw a key press that could be an extension's shortcut (onUserGesture).
  let lastShortcutKeyAt = -Infinity;

  /**
   * Whether a play now follows the user's own press, not a shortcut's key (docs/notes/mpv.md).
   * @return {boolean}
   */
  function playFollowsUserPress() {
    const now = performance.now();
    if (now - lastUserGestureAt <= UserActivationMs) return true;
    if (!navigator.userActivation || !navigator.userActivation.isActive) return false;
    // Active with no press here: a shortcut's key, or a press in another frame.
    return now - lastShortcutKeyAt > UserActivationMs;
  }

  /**
   * The video the user just started: report it to the background for mpv.
   * @param {HTMLVideoElement} video - The video.
   * @param {boolean} [pressedHere] - false: no press of this frame's behind it; the background asks the frames above.
   */
  function reportUserPlay(video, pressedHere = true) {
    try {
      chrome.runtime.sendMessage({
        type: MessageTypes.MPV_USER_PLAY,
        src: video.currentSrc || '',
        video: playedVideo(video),
        // Now: a site like YouTube moves to the next video without a load.
        page: location.href,
        pressedHere,
        // When it played and when this frame's page began: a press above counts only before both.
        ...(pressedHere ? {} : {playedAt: performance.timeOrigin + performance.now(), documentStart: performance.timeOrigin}),
      }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // The extension was reloaded under this page: nothing to report to.
    }
  }

  /**
   * A 'play' event: report the video to mpv if the user started it.
   * @param {Event} e - The play event.
   */
  function onPlay(e) {
    // Only a play Firefox reports: a page could make one up during a click.
    if (!e.isTrusted) return;
    const video = /** @type {HTMLVideoElement|null} */ (e.target);
    if (!video || video.tagName !== 'VIDEO') return;
    if (playFollowsUserPress()) {
      userStartedVideos.add(video);
      reportUserPlay(video);
    } else if (window !== window.top) {
      // A player frame the click above created has no press and no activation of its own (docs/notes/mpv.md).
      reportUserPlay(video, false);
    }
  }

  PageListeners.add(document, 'play', onPlay, true);
  PageListeners.add(document, 'play', pauseHeldMedia, true);

  // A video's own file, told once: Firefox can play a file with no request the background sees.
  const reportedVideoFiles = new Set();

  /**
   * A video got its file: tell the background once.
   * @param {Event} e - The loadedmetadata event.
   */
  function onLoadedMetadata(e) {
    if (!e.isTrusted) return;
    const video = /** @type {HTMLVideoElement|null} */ (e.target);
    if (!video || video.tagName !== 'VIDEO') return;
    const src = video.currentSrc || '';
    if (!/^https?:\/\//i.test(src) || reportedVideoFiles.has(src)) return;
    reportedVideoFiles.add(src);
    try {
      chrome.runtime.sendMessage({
        type: MessageTypes.LOADED_MEDIA,
        // Told as it loaded: the background lets the request's own detection come first.
        live: true,
        url: pageAddress(),
        document: DocumentKey,
        // cors: a crossorigin video's request carries an Origin (pageHeaders).
        resources: [{url: src, media: true, cors: video.crossOrigin !== null, time: Date.now()}],
      }, () => {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      // The extension was reloaded under this page: nothing to report to.
    }
  }

  PageListeners.add(document, 'loadedmetadata', onLoadedMetadata, true);

  // Media events are not composed: each shadow root gets the listener, found as the user acts.
  const listenedRoots = new WeakSet();
  let lastRootScan = 0;

  /**
   * Listen for plays in one shadow root.
   * @param {ShadowRoot} root - The shadow root.
   */
  function listenInRoot(root) {
    if (!listenedRoots.has(root)) {
      listenedRoots.add(root);
      root.addEventListener('play', onPlay, true);
      root.addEventListener('play', pauseHeldMedia, true);
      root.addEventListener('loadedmetadata', onLoadedMetadata, true);
    }
  }

  /**
   * Listen in one root and every shadow root under it.
   * @param {Document|ShadowRoot} root - The document or a shadow root.
   */
  function listenInShadowRoots(root) {
    for (const element of root.querySelectorAll('*')) {
      // Firefox lets a content script into closed roots too.
      const shadow = /** @type {ShadowHost} */ (element).openOrClosedShadowRoot || element.shadowRoot;
      if (shadow) {
        listenInRoot(shadow);
        listenInShadowRoots(shadow);
      }
    }
  }

  /** @param {KeyboardEvent} e */
  function onUserGesture(e) {
    if (!e.isTrusted) return;
    // None: a press that could be an extension's shortcut, a lone modifier, or Escape.
    const noPress = e.type === 'keydown' &&
      (ModifierKeys.includes(e.key) || e.key === 'Escape' || couldBeExtensionShortcut(e));
    if (!noPress) {
      lastUserGestureAt = performance.now();
    } else if (!ModifierKeys.includes(e.key) && e.key !== 'Escape' && !/^Media/.test(e.key)) {
      // A media key is a play control, not a shortcut: its play stays the user's.
      lastShortcutKeyAt = performance.now();
    }
    for (const node of e.composedPath()) {
      if (node instanceof ShadowRoot) {
        listenInRoot(node);
      }
    }
    const now = Date.now();
    if (now - lastRootScan > 2000) {
      lastRootScan = now;
      listenInShadowRoots(document);
    }
  }

  PageListeners.add(window, 'pointerdown', /** @type {EventListener} */ (onUserGesture), true);
  PageListeners.add(window, 'keydown', onUserGesture, true);
  PageListeners.add(window, 'keydown', (e) => {
    // The user's Escape only: one the page made (dispatchEvent) left the window too.
    if (!e.isTrusted || !carriedFullscreen || e.key !== 'Escape') return;
    carriedFullscreen = false;
    e.preventDefault();
    try {
      chrome.runtime.sendMessage({type: MessageTypes.EXIT_CARRIED_FULLSCREEN}, () => {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      // The extension was reloaded under this page.
    }
  }, true);

  /**
   * Pressing the shortcut while already watching a video the user started counts as starting it now.
   * @param {boolean} any - Any video with a file, playing ones first: a YouTube video page's own, autoplayed or paused.
   * @return {boolean} Whether one was reported.
   */
  function reportPlayingUserVideo(any) {
    const videos = /** @type {HTMLVideoElement[]} */ (querySelectorAllInAllShadows('video'));
    const video = videos.find((v) => (any || userStartedVideos.has(v)) && !v.paused && !v.ended) ||
      (any ? videos.find((v) => v.currentSrc && !v.ended) : undefined);
    if (!video) {
      return false;
    }
    reportUserPlay(video);
    return true;
  }

  // A page can cancel an extension's shortcut (preventDefault): a cancelled press that could be
  // one goes to the background, which runs its command. One left alone is Firefox's to run.
  const ModifierKeys = ['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS'];

  /**
   * Whether a key press could be an extension's shortcut: Ctrl, Alt or Command, an F-key or a media key.
   * @param {KeyboardEvent} e - The press.
   * @return {boolean}
   */
  function couldBeExtensionShortcut(e) {
    return e.ctrlKey || e.altKey || e.metaKey || /^(F\d+|Media\w+)$/.test(e.key);
  }

  PageListeners.add(window, 'keydown', (e) => {
    if (!e.isTrusted || e.repeat || e.isComposing || ModifierKeys.includes(e.key)) return;
    if (!couldBeExtensionShortcut(e)) return;
    setTimeout(() => {
      if (!e.defaultPrevented) return;
      try {
        chrome.runtime.sendMessage({
          type: MessageTypes.SHORTCUT_CANCELLED,
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
        }, () => {
          void chrome.runtime.lastError;
        });
      } catch (err) {
        // The extension was reloaded under this page: nothing to report to.
      }
    }, 0);
  }, true);

  // beforeunload fires for a navigation that may never happen (a download, a cancelled "Leave
  // page?"): a page still here after LeaveSettledMs names itself again and reports on pagehide.
  const LeaveSettledMs = 2000;
  // 'here'; 'left', told at beforeunload; or 'back', named again after a leave that never
  // happened.
  let leaveState = 'here';
  /** @type {?Timer} */
  let leaveTimer = null;

  /** Names this page to the background (FRAME_ADDED). */
  function nameThisPage() {
    notifyBackground({
      type: MessageTypes.FRAME_ADDED,
      url: window.location.href,
      document: DocumentKey,
    });
  }

  /** Tells the background this page left its frame (FRAME_REMOVED). */
  function reportLeaving() {
    leaveState = 'left';
    // The page's name: this can arrive after the next page's FRAME_ADDED.
    notifyBackground({
      type: MessageTypes.FRAME_REMOVED,
      document: DocumentKey,
    });
  }

  PageListeners.add(window, 'beforeunload', (e) => {
    // The page's own made-up event: nothing leaves.
    if (!e.isTrusted) return;
    // The player loads in this frame and asks for its sources: no FRAME_REMOVED for the redirect.
    if (RedirectingToPlayer === 'sent') {
      RedirectingToPlayer = 'leaving';
      return;
    }
    RedirectingToPlayer = false;
    if (leaveState !== 'left') {
      reportLeaving();
    }
    const timer = setTimeout(() => {
      if (leaveTimer === timer && leaveState === 'left') {
        leaveTimer = null;
        leaveState = 'back';
        nameThisPage();
      }
    }, LeaveSettledMs);
    leaveTimer = timer;
  });

  PageListeners.add(window, 'pagehide', (e) => {
    if (!e.isTrusted) return;
    // Gone, or into the back-forward cache, which names the page again itself (pageshow).
    clearTimeout(/** @type {Timer} */ (leaveTimer));
    leaveTimer = null;
    if (leaveState === 'back' && !RedirectingToPlayer) {
      reportLeaving();
    }
  });

  // The back-forward cache gives the page back after its leave: naming it again restores its sources.
  PageListeners.add(window, 'pageshow', (e) => {
    if (!e.isTrusted || !e.persisted) {
      return;
    }
    RedirectingToPlayer = false;
    leaveState = 'here';
    // A hold from before it left can be stale: its end never reached the cached page.
    pageMediaHeld = false;
    nameThisPage();
  });

  nameThisPage();
})();
