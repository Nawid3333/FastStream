// @ts-check
(() => { // Encapsulate the code to avoid polluting the global scope
  const MessageTypes = {
    OPEN_PLAYER: 'OPEN_PLAYER',
    GET_VIDEO_SIZE: 'GET_VIDEO_SIZE',
    GET_PLAYED_VIDEO: 'GET_PLAYED_VIDEO',
    GET_PAGE_QUALITIES: 'GET_PAGE_QUALITIES',
    FRAME_ADDED: 'FRAME_ADDED',
    REMOVE_PLAYERS: 'REMOVE_PLAYERS',
    IS_FULL: 'IS_FULL',
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
    START_PAGE_PLAYER: 'START_PAGE_PLAYER',
    PAGE_TYPING: 'PAGE_TYPING',
    FRAME_REMOVED: 'FRAME_REMOVED',
    PAUSE_MEDIA: 'PAUSE_MEDIA',
    POPUP_GUARD_ARM: 'POPUP_GUARD_ARM',
    MPV_USER_PLAY: 'MPV_USER_PLAY',
    MPV_REPORT_PLAYING: 'MPV_REPORT_PLAYING',
    SCRAPE_CAPTIONS: 'SCRAPE_CAPTIONS',
    SHORTCUT_CANCELLED: 'SHORTCUT_CANCELLED',
    HAS_PLAYER: 'HAS_PLAYER',
    REPORT_LOADED_MEDIA: 'REPORT_LOADED_MEDIA',
    LOADED_MEDIA: 'LOADED_MEDIA',
    PLAYER_OPEN_GONE: 'PLAYER_OPEN_GONE',
    IS_PLAYER_OPENER: 'IS_PLAYER_OPENER',
    HOLD_PAGE_MEDIA: 'HOLD_PAGE_MEDIA',
  };

  const iframeMap = new Map();
  // The next episode carried a fullscreen over (background.mjs setCarriedFullscreen): the
  // browser window is fullscreen and the player fills the page. Escape here, where the
  // keyboard is after the page loaded, ends it as it ends a real fullscreen.
  let carriedFullscreen = false;
  const replacedPlayerQueue = [];
  // Players laid over the whole page (a video that fills it), with their pause watchers.
  const overlayPlayers = [];
  // What fillScreenIframe changed: each element, with what it gets back. A Map, as each
  // element is looked up in it: an array made a page of 30,000 elements take seconds on its
  // main thread (an array lookup per element, and a splice per one undone). What holds the
  // player gets its whole style attribute back ({style}); a hidden element only its display
  // ({display, priority}), as display is all that hid it: putting its whole old attribute
  // back also put back the overlay guard's visibility: hidden, which the guard had given
  // back meanwhile, and the element stayed hidden for good.
  const elementsChangedByFillscreen = new Map();
  const linkRequests = new Map();
  // Counts removePlayers(): an OPEN_PLAYER that a removal overtook puts no player in.
  let PlayersEpoch = 0;
  let MiniplayerCooldown = 0;
  // Set when this frame is sent to the player (handlePlayerOpen's redirect). The frame is
  // not going away: the player takes it over, and asks the background for the sources
  // detected in it.
  let RedirectingToPlayer = false;
  // This page's name, for the background to tell a player it opens from one a page this
  // frame showed before opened (FRAME_ADDED, and the player URL's opener). Not
  // crypto.randomUUID: it needs a secure context, and plain http pages are not one.
  const DocumentKey = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('');

  // The resize observers' last update of the players, and the one due after a burst.
  let resizeDebounce = performance.now();
  let resizeTrailing = null;
  const Config = {
    softReplaceByDefault: true,
  };

  const {hostname} = window.location;
  // If twitch.tv, or vimeo, disable soft replace by default
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

      // Asked of each frame above a player as it opens: what this page lays over that
      // iframe lies over the player too (overlay-guard.js).
      OverlayGuard.guard(iframeObj.iframe);

      const parents = getParentElementsWithSameBounds(iframeObj.iframe);
      if (parents.length > 0 && parents[parents.length - 1].tagName === 'BODY') {
        sendResponse(true);
      } else {
        sendResponse(false);
      }
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
      // Sent to every frame of the tab; only a frame holding a player answers, so the
      // background's first answer is a yes, and a tab without one answers nothing.
      if (hasPlayerIframe()) {
        sendResponse(true);
      }
      return;
    } else if (request.type === MessageTypes.IS_PLAYER_OPENER) {
      // Whether a player naming this frame as its parent was opened by this page: only
      // this content script knows the page's name (background.mjs, PLAYER_LOADED).
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
      sendResponse(reportPlayingUserVideo());
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
      // The qualities the page's own player offers as files of their own (page-qualities.js),
      // for the background to give the stream's player, and mpv, the one the user wants.
      let lists = [];
      try {
        lists = PageQualities.find(document, window.wrappedJSObject || window, window.location.href);
      } catch (e) {
        console.warn('Reading the page player\'s qualities failed', e);
      }
      sendResponse(lists);
    } else if (request.type === MessageTypes.GET_PLAYED_VIDEO) {
      // The asking player's, once it linked up with its iframe; before that, the latest
      // replaced (one player opens per frame at a time, background.mjs openPlayer).
      const linked = iframeMap.get(request.frameId);
      sendResponse(replacedVideo(linked ? linked.replacedData : replacedPlayerQueue[replacedPlayerQueue.length - 1]));
    } else if (request.type === MessageTypes.REPORT_LOADED_MEDIA) {
      // Sent to every frame when the background knows no stream of the tab: each answers
      // with what it loaded, in a message of its own, which tells the background its frame.
      try {
        chrome.runtime.sendMessage({
          type: MessageTypes.LOADED_MEDIA,
          url: window.location.href,
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
    } else if (request.type === MessageTypes.START_PAGE_PLAYER) {
      startPagePlayer().then(sendResponse, () => sendResponse(null));
      return true;
    } else if (request.type === MessageTypes.PAGE_TYPING) {
      // Whether the user types in this page, or looks elsewhere: the next episode's player
      // takes the keyboard only when not (main.mjs; the reviews of 2026-10-11).
      const active = document.activeElement;
      sendResponse(document.visibilityState !== 'visible' ||
        !!active && (active.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)));
      return;
    }
  });

  window.addEventListener('message', (e) => {
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

      // Find matched in replaced players
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
          // The same iframe again: its player loaded anew ("Reload Frame" on it). It still
          // stands in for the page's element, which only the old entry knew how to give
          // back: removePlayers left that element hidden, and its media paused, for good.
          newFrameObj.replacedData = oldFrameObj.replacedData;
        }
      } else {
        iframeElement.addEventListener('load', frameLoadListener);
      }

      iframeMap.set(request.frameId, newFrameObj);
      // Watched while it is in the page too: taken out, it gives back what it took
      // (checkPendingPlayers).
      if (!pendingPlayersWatch) {
        pendingPlayersWatch = new MutationObserver(checkPendingPlayers);
        pendingPlayersWatch.observe(document.documentElement, {childList: true, subtree: true});
      }
      checkPendingPlayers();

      updateReplacedPlayers(replacedData && replacedData.convertDue ? replacedData : null);
    }
  });

  // Player iframes put in the page whose players have not linked up yet (above), with the
  // attempt OPEN_PLAYER named. A page that takes one out before that (a re-render) runs
  // nothing in it to say so, and the background kept that frame's player opening
  // (frame.playerOpening): no player opened there again until the page navigated.
  const pendingPlayers = new Map();
  let pendingPlayersWatch = null;
  // This page started its own player for an autoplay next once (startPagePlayer), and one
  // ask is still looking for its video.
  let pagePlayerStarted = false;
  let pagePlayerLooking = false;

  /**
   * Watches a player iframe until its player links up, or the page takes it out.
   * @param {HTMLIFrameElement} iframe - The player's iframe, in the page.
   * @param {*} attempt - OPEN_PLAYER's attempt; nothing to report without one, but the
   *   page still gets back what the player took (releaseRemovedPlayer).
   */
  function watchPendingPlayer(iframe, attempt) {
    pendingPlayers.set(iframe, attempt);
    if (!pendingPlayersWatch) {
      pendingPlayersWatch = new MutationObserver(checkPendingPlayers);
      pendingPlayersWatch.observe(document.documentElement, {childList: true, subtree: true});
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
    // A player that has linked up, which the page took out too (a re-render after the player
    // came): the page's element stayed hidden and its media paused themselves on every play,
    // until FastStream was turned off or the page navigated (final review, 2026-10-10). Its
    // element is given back now; the entry stays, so removePlayers still tells the background
    // that the frame is gone, as before.
    iframeMap.forEach((iframeObj) => {
      if (iframeObj.iframe.isConnected) return;
      // Its miniplayer and its windowed fullscreen go too, as removePlayers does: the rest
      // of the page stayed hidden, and a next player's windowed fullscreen left its own box
      // hidden, the elements being changed already (glm's review, 2026-10-13).
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
   * Gives the page back what a player took, when the page took that player's iframe out
   * before it linked up: its element shown again (a soft replace only hid it), the rest of
   * the page an overlay hid, and its media free to play. All of it stayed until FastStream
   * was turned off, with the page's video pausing itself on every play meanwhile.
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
      removePauseListeners(watcher);
    }
  }

  function frameLoadListener(e) {
    // Find match in iframeMap
    const iframeElement = e.target;
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
   * Tells the background something, with no answer to wait for. Such a message rejects
   * when the page goes away before the background has answered - the FRAME_REMOVED of a
   * page being left ("Actor 'Conduits' destroyed") - or when nothing listens yet. Nothing
   * waits for the answer, so that is not an error: unhandled, the rejection reached the
   * page's console as one, and failed an e2e that watches for them (content-cleanup's Back
   * case on Windows, 2026-10-01). tests/unit/contentMessages.test.mjs keeps every other
   * sendMessage here with a callback.
   * @param {Object} message - The message.
   */
  function notifyBackground(message) {
    chrome.runtime.sendMessage(message).catch((e) => {
      console.debug('FastStream: no answer to', message.type, e && e.message);
    });
  }

  function findIframeWithWindow(win) {
    const iframes = querySelectorAllInAllShadows('iframe');
    for (let i = 0; i < iframes.length; i++) {
      if (iframes[i].contentWindow === win) {
        return iframes[i];
      }
    }
    return null;
  }


  function handlePlaylistNavigation(request, sender, sendResponse) {
    const button = getNextOrPreviousButton(request.direction === 'next');
    if (!button) {
      // The series' last episode, or a page FastStream cannot read (isSeriesEnd).
      sendResponse(request.direction === 'next' && isSeriesEnd() ? 'series_end' : 'no_button');
      return;
    }

    // The link's own address rather than a click: hosters hang ad scripts on their links (a
    // popup, or the episode in a new tab), and the chain broke. A link meant for another
    // frame (_top, _parent, a name, also by the page's <base target>) and a button keep their
    // click; one into a new tab (<base target="_blank">) opens here, in the chain's tab.
    const target = linkTarget(button);
    if (button.tagName === 'A' && /^https?:/i.test(button.href) && (target === '' || target === '_self' || target === '_blank') &&
        withoutHash(button.href) !== withoutHash(window.location.href)) {
      window.location.assign(button.href);
    } else {
      button.click();
    }
    sendResponse('clicked');
  }

  function pollPlaylistButtons(request, sender, sendResponse) {
    try {
      const nextButton = getNextOrPreviousButton(true);
      const previousButton = getNextOrPreviousButton(false);
      sendResponse({
        next: nextButton !== null,
        previous: previousButton !== null,
        // No next: the series' last episode (autoplay stops and says so), or a page
        // FastStream cannot read (a problem to note).
        seriesEnd: nextButton === null && isSeriesEnd(),
      });
    } catch (e) {
      sendResponse({
        error: e.message,
      });
    }
  }

  function handlePlayerOpen(request, sender, sendResponse) {
    // The video is found by its visibility, which can take a second (a background tab's
    // IntersectionObserver): players removed meanwhile (the page went on to another address)
    // gave the page back, and this then put its player in anyway (glm's second look,
    // 2026-10-13).
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
      // Which page opened it: a reload can take this page away while the player still
      // starts (background.mjs, PLAYER_LOADED).
      newURL.searchParams.set('opener', DocumentKey);
      if (!video || playerFillsScreen) {
        if (!document.fullscreenEnabled && !request.noRedirect) {
          if (request.parentFrameId > -1) {
            newURL.searchParams.set('parent_frame_id', request.parentFrameId);
          }
          RedirectingToPlayer = true;
          window.location = newURL.href;
          sendResponse('redirect');
        } else {
          const iframe = document.createElement('iframe');
          newURL.searchParams.set('parent_frame_id', request.frameId);
          iframe.src = newURL.href;
          iframe.allowFullscreen = true;
          iframe.allow = 'autoplay; fullscreen; picture-in-picture';
          const watcher = pauseAllWithin(document.body);
          // Remove everything from the document
          document.body.appendChild(iframe);
          const hidden = fillScreenIframe(iframe);
          overlayPlayers.push({iframe, watcher, hidden});
          watchPendingPlayer(iframe, request.attempt);
          sendResponse('replaceall');
        }
      } else {
        const softReplace = request.softReplace || Config.softReplaceByDefault;
        // copy styles
        const iframe = document.createElement('iframe');
        iframe.allowFullscreen = true;
        iframe.allow = 'autoplay; fullscreen; picture-in-picture';
        iframe.style.display = 'none';
        newURL.searchParams.set('parent_frame_id', request.frameId);
        iframe.src = newURL.href;

        if (softReplace) {
          video.highest.parentNode.insertBefore(iframe, video.highest);
        } else {
          video.highest.parentNode.replaceChild(iframe, video.highest);
        }

        // updateIframeStyle(video.highest, iframe, isYt, playerFillsScreen);
        const watcher = pauseAllWithin(video.highest);

        const pobj = {
          iframe,
          watcher,
          old: video.highest,
          softReplace,
          fillScreen: playerFillsScreen,
        };
        // The video itself, for the stream it played (GET_PLAYED_VIDEO). A site's own query
        // may have found its player's box: the one video in it, and none when there are
        // more, an ad's or a preview's among them as likely as not.
        const inBox = video.highest.tagName === 'VIDEO' ? [video.highest] :
          querySelectorAllIncludingShadows('video', video.highest);
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
                // The check for a page element that collapsed (makeSoftIntoHard) sees only
                // players that linked up. One that has not yet (a slow start) gets it when it
                // does, in the link handler; it used to get none.
                if (i == 4 && replacedPlayerQueue.includes(pobj)) {
                  pobj.convertDue = true;
                }
                updateReplacedPlayers(i == 4 ? pobj : null);
              }, i * 250);
            })(i);
          }
        }

        // Add resize listener
        pobj.resizeObserver = new ResizeObserver(updateReplacedPlayersSoon);
        // An element: a video straight in a shadow root put the player there, with the root
        // as its parent, which a ResizeObserver refuses. The throw left the player without
        // one: it followed the window's size, but not its box on the page.
        pobj.resizeObserver.observe(iframe.parentElement || iframe.parentNode.host);
      }
    }).catch((e) => {
      // Whatever went wrong, the background hears back: without an answer it kept the
      // frame's player opening, and opened no player there again until a navigation. A
      // second answer, after one already given, is ignored.
      console.error(e);
      sendResponse('error');
    });
    return true;
  }

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

  function handleWindowedFullscreen(request, sender, sendResponse) {
    const iframeObj = iframeMap.get(request.frameId);
    if (!iframeObj) {
      // Answered; throwing on top only put an uncaught error in the page's console.
      sendResponse('no_element');
      console.error('No element found for frame id ' + request.frameId);
      return;
    }

    const windowedFullscreenState = iframeObj.windowedFullscreenState;

    if (request.force === undefined || request.force !== windowedFullscreenState.active) {
      windowedFullscreenToggle(iframeObj);
    }

    if (windowedFullscreenState.active) {
      sendResponse('enter');
    } else {
      sendResponse('exit');
    }
  }

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
      if ((request.force !== undefined && request.force === miniplayerState.active) || iframeObj.windowedFullscreenState.active || document.fullscreenElement) {
        updateMiniPlayer(iframeObj);
      } else {
        toggleMiniPlayer(iframeObj);
      }
    } catch (e) {
      // Whatever went wrong, the player hears back; a throw here left it unanswered.
      console.error(e);
      sendResponse('error');
      return;
    }

    if (miniplayerState.active && request.autoExit) {
      // if placeholder is visible again
      const observer = new IntersectionObserver(async ([entry]) => {
        if (entry.intersectionRatio > 0.3 && miniplayerState.active) {
          //  unmakeMiniPlayer(iframeObj);
          observer.disconnect();

          const result = await sendToPlayer(miniplayerState.playerFrameId, {
            type: 'miniplayer-state',
            value: false,
          });

          if (result[0] !== 'recieved') {
            console.error('Failed to send miniplayer state to player, assuming its closed');
            unmakeMiniPlayer(iframeObj);
            updateReplacedPlayers();
          }
        }
      }, {
        // 0.3: an entry comes only where the ratio crosses one of these, and the test above
        // is > 0.3 - with 0.25 and 0.5 alone it fired only half way back
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

  async function sendToPlayer(frameId, data) {
    const frameIds = [];
    if (typeof frameId === 'number') {
      frameIds.push(frameId);
    } else if (Array.isArray(frameId)) {
      frameIds.push(...frameId);
    } else if (frameId === 'all') {
      iframeMap.forEach((iframeObj) => {
        frameIds.push(iframeObj.frameId);
      });
    }

    return Promise.all(frameIds.map((id) => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: MessageTypes.SEND_TO_PLAYER,
          frameId: id,
          data,
        }, (response) => {
          resolve(response);
        });
      });
    }));
  }

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

    const newValue = force === undefined ? document.fullscreenElement !== element : force;
    fullscreenState.active = newValue;
    if (!newValue) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
      sendResponse('exit');
    } else {
      element.requestFullscreen().then(() => {
        sendResponse('enter');
      }).catch((e) => {
        // Refused (no user gesture, an iframe the page took out): the player hears 'error'.
        // Rethrown, it was an unhandled rejection besides. Not fullscreen, as the page is:
        // left "on", the next toggle went the wrong way.
        fullscreenState.active = document.fullscreenElement === element;
        console.error(e);
        sendResponse('error');
      });
    }
    return true;
  }

  // The text tracks a <track> element can carry that are meant to be read on screen.
  // 'subtitles' is also what a <track> with no kind attribute reports, which is how most
  // pages write them.
  const ScrapedTrackKinds = ['subtitles', 'captions'];

  function handleCaptionsScrape(request, sender, sendResponse) {
    // Every track is counted before any is asked for: a request that fails at once (a src
    // XMLHttpRequest refuses) answers inside the loop, and the answer went out then, with
    // the tracks after it never asked for.
    const trackElements = querySelectorAllIncludingShadows('track')
        .filter((track) => track.src && ScrapedTrackKinds.includes(track.kind));
    const pending = trackElements.length;
    let done = 0;
    const tracks = [];
    for (let i = 0; i < trackElements.length; i++) {
      const track = trackElements[i];
      const source = track.src;
      httpRequest(source, (err, req, body) => {
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
      });
    }
    if (pending === 0) sendResponse(tracks);

    return true;
  }

  /**
   * Pauses every playing media element in this frame. Used when a stream is
   * handed off to mpv: the page keeps buffering (and making noise) otherwise,
   * and the user would have to come back to the tab just to stop it.
   * @return {number} How many elements were paused.
   */
  function pauseAllMedia() {
    let paused = 0;
    // Shadow roots too, closed ones as well: a player built as a web component keeps its
    // <video> in one.
    querySelectorAllInAllShadows('video, audio', document.documentElement).forEach((media) => {
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
   * Whether a media element plays a MediaStream (srcObject): a call's or a camera's, live.
   * Neither mpv's pause nor the hold below is for it: a watch party's voice chat in the
   * same tab fell silent, and again on every play, while FastStream's player played.
   * @param {HTMLMediaElement} media - The element.
   * @return {boolean}
   */
  function playsLiveStream(media) {
    return typeof MediaStream !== 'undefined' && media.srcObject instanceof MediaStream;
  }

  // While a FastStream player in this tab plays, the page's own media stays paused
  // (HOLD_PAGE_MEDIA, sent to every frame by the background). Opening the player pauses
  // only what is inside the box it takes over (pauseAllWithin): a site's player outside
  // it, or in another frame, played on under FastStream's, and both were heard.
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
    // The players go, and with them the reason to hold the page's media. (Keeping the hold
    // and the guards over a site's embed whose player stays up through a URL change was
    // tried on 2026-10-04 and reverted the same night: the page is given back on a URL
    // change, content-overlays.e2e.mjs "hides the embedding page's bar...".)
    pageMediaHeld = false;
    OverlayGuard.releaseAll();
    iframeMap.forEach((iframeObj) => {
      unmakeMiniPlayer(iframeObj);
      // The iframe's own style too, which only leaving windowed fullscreen gives back: an
      // embed iframe holding the player stayed fixed over the whole page.
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
      removePauseListeners(watcher);
    });
    overlayPlayers.length = 0;

    // Every player iframe now out of the page, overlays too: taking an iframe out runs
    // no beforeunload in it, so the background kept its frame as a player's, dropped the
    // streams of that frame and opened no player on the page, until a navigation. Each
    // is reported once.
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
   * Puts the page's own element back where a player replaced it, and lets its media play
   * again. The page may have taken the player's iframe out itself (a re-render): remove()
   * and replaceWith() do nothing for a detached iframe, where removeChild on its missing
   * parent threw and left the rest of the cleanup undone.
   * @param {Object} replacedData - The replacement, from handlePlayerOpen.
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
    // transferStyles gave the iframe the element's id, so the page's CSS for it applied to
    // the player. The element gets it back; it used to keep none, and the page's own rules
    // and scripts for it stopped working until a reload.
    transferId(iframe, old);
    restoreTransition(old);
    removePauseListeners(replacedData.watcher);
    replacedData.resizeObserver?.disconnect();
  }

  function updateMiniPlayer(iframeObj) {
    const miniplayerState = iframeObj.miniplayerState;
    if (miniplayerState.active) {
      const placeholder = miniplayerState.placeholder;
      const element = miniplayerState.element;
      // A placeholder without a size (inside a hidden part of the page) has no shape to
      // keep: the sizes were NaN, or a miniplayer 0 px high.
      let aspectRatio = placeholder.clientWidth / placeholder.clientHeight;
      if (!(aspectRatio > 0 && aspectRatio < Infinity)) {
        aspectRatio = 16 / 9;
      }
      // Within its share of the screen both ways: by the wider of the two, a portrait
      // player's (a quarter of a 1920x1080 screen) came out 853 px high (glm's second look,
      // 2026-10-13).
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

  function makeMiniPlayer(iframeObj) {
    const miniplayerState = iframeObj.miniplayerState;
    if (miniplayerState.active) {
      return;
    }

    // The page took the player's iframe out (a re-render): there is nothing to shrink, and
    // the placeholder had no parent to go into.
    if (!iframeObj.iframe.isConnected) {
      return;
    }

    miniplayerState.active = true;

    // Up to the body, not the body itself: a wrapper that came to fill it made the body the
    // miniplayer, with a second <body> put in before it as its placeholder.
    const parentElementsWithSameBounds = getParentElementsWithSameBounds(iframeObj.iframe)
        .filter((parent) => parent.tagName !== 'BODY');
    const element = parentElementsWithSameBounds.length > 0 ? parentElementsWithSameBounds[parentElementsWithSameBounds.length - 1] : iframeObj.iframe;
    const placeholder = document.createElement(element.tagName);

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
      // Fitted at once: it waited a second, with the player at the size it had before
      // (glm's audit, 2026-10-13). Again a second later, for a page whose own scripts lay
      // it out once it has its styles back.
      updateReplacedPlayers();
      setTimeout(() => {
        updateReplacedPlayers();
      }, 1000);
    }
  }

  function undoFillScreenIframe(whitelist) {
    const only = whitelist ? new Set(whitelist) : null;
    elementsChangedByFillscreen.forEach((old, element) => {
      if (!only || only.has(element)) {
        if (old.style !== undefined) {
          element.setAttribute('style', old.style);
        } else if (old.display) {
          element.style.setProperty('display', old.display, old.priority);
        } else {
          element.style.removeProperty('display');
        }
        elementsChangedByFillscreen.delete(element);
      }
    });
  }

  function fillScreenIframe(iframe, skipHide = false) {
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
      // What the player is drawn inside, shadow roots and the slots that show it included:
      // a web-component player's host was expanded, but the bar next to the player in its
      // shadow root was never hidden (#233).
      const trace = new Set(flatTreeParents(iframe));

      // Gather all elements not parents of the iframe
      const elements = allElementsIncludingShadows();
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
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
        elementsChangedByFillscreen.set(element, {style: element.getAttribute('style') || ''});
        element.setAttribute('style', expandStyle);
        addedElements.push(element);
      });
    }

    iframe.setAttribute('style', expandStyle);

    return addedElements;
  }

  // hideSoft and showSoft switch the element's transitions off, so the size changes they
  // make don't animate. The page's own transition is kept until the element is given
  // back (restoreTransition); it used to stay "none !important" for good.
  function rememberTransition(player) {
    if (!('fsTransition' in player.dataset)) {
      player.dataset.fsTransition = player.style.getPropertyValue('transition');
      player.dataset.fsTransitionPriority = player.style.getPropertyPriority('transition');
    }
  }

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

  // What hideSoft sets on the page's element: no size, nothing drawn outside it.
  const SoftHidden = {width: '0px', height: '0px', overflow: 'hidden', margin: '0px', contain: 'paint'};

  /**
   * The page's own inline values of those, with their priority, per element until it is
   * given back (forgetSoft). Kept here, not in the page's DOM (data-old-width and the like):
   * a page that changed the attribute could leave its element hidden for good. A value equal
   * to the hidden one (overflow: hidden, margin: 0) was never saved and showSoft cleared it,
   * the saves were never deleted (a later replace restored a stale one), and !important was
   * lost (review of 2026-10-14).
   * @type {WeakMap<HTMLElement, Object<string, string[]>>}
   */
  const softSaves = new WeakMap();

  function isSoftHidden(player, name) {
    return player.style.getPropertyValue(name) === SoftHidden[name] &&
      player.style.getPropertyPriority(name) === 'important';
  }

  function hideSoft(player) {
    rememberTransition(player);
    // Saved at the first hide, and again at each later one where the value is no longer the
    // hidden one: what the page set while its element was hidden is its newest wish.
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

  // The saved values back - each only while it is still the hidden one: a value the page set
  // meanwhile is the page's newer one. The save stays for the next hideSoft (a measurement).
  function showSoft(player) {
    rememberTransition(player);
    player.style.setProperty('transition', 'none', 'important');
    const saved = softSaves.get(player);
    // Not hidden yet (the first measurement shows it before hiding it): a value equal to the
    // hidden one is the page's own, e.g. margin: 0 !important.
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

  function forgetSoft(player) {
    softSaves.delete(player);
  }

  /**
   * Updates the replaced players for a resize: at most every 100 ms, and once more 100 ms
   * after the last call. The changes skipped inside a burst (a sidebar sliding shut) were
   * never made up, and the player kept a size from the middle of it; a window being resized
   * updated them on every event, putting a hard-replaced page video back into the page to
   * measure it each time.
   */
  function updateReplacedPlayersSoon() {
    clearTimeout(resizeTrailing);
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

  function updateReplacedPlayers(convert = null) {
    iframeMap.forEach((iframeObj) => {
      if (iframeObj.replacedData) {
        const {iframe, old, softReplace} = iframeObj.replacedData;
        if (iframeObj.windowedFullscreenState.active) {
          fillScreenIframe(iframe, true);
        } else if (iframeObj.miniplayerState.active) {
          const placeholder = iframeObj.miniplayerState.placeholder;
          // The placeholder holds the element's id only when it stands in for the player's
          // iframe. One for a wrapper around it holds the wrapper's.
          updateReplacedPlayer(old, placeholder, softReplace, iframeObj.miniplayerState.element === iframe);
          placeholder.style.setProperty('background-color', 'black', 'important');
        } else {
          const final_size = updateReplacedPlayer(old, iframe, softReplace);
          if (convert == iframeObj.replacedData &&final_size <= 100 && softReplace) {
            makeSoftIntoHard(iframeObj.replacedData);
            updateReplacedPlayer(old, iframe, false);
          }
        }
      } else if (iframeObj.miniplayerState.active) {
        updateMiniPlayer(iframeObj);
      }
    });
  }

  function updateReplacedPlayer(old, iframe, softReplace, holdsId = true) {
    const parent = iframe.parentNode;
    // A hard-replaced player the page took out has nowhere to measure the page's element:
    // insertBefore on the missing parent threw, on every resize, and the players after it
    // in iframeMap were never updated.
    if (!softReplace && !parent) {
      return 0;
    }
    iframe.style.display = 'none';
    let final_size;
    if (softReplace) {
      showSoft(old);
      // Measured with its id, as a hard replace is: transferStyles handed it to the iframe,
      // and without it the page's #id rules no longer sized or placed the element. From the
      // second update on (the resize observer's first call), the player took the element's
      // unstyled box: the page's whole width, below the page's content.
      if (holdsId) {
        transferId(iframe, old);
      }
      final_size = transferStyles(old, iframe, true);
      hideSoft(old);
    } else {
      // The page's own element went back into the page for every measurement (every
      // resize): its observers and custom-element callbacks ran each time, and a <video
      // autoplay> in it started loading again (#228). A stand-in sized by the same rules is
      // measured instead, once it measured as the element did.
      let fits = standInFits.get(old);
      if (fits === undefined) {
        fits = standInMeasuresAs(old, parent, iframe);
        standInFits.set(old, fits);
      }
      const measured = (fits && makeStandIn(old)) || old;
      parent.insertBefore(measured, iframe);
      transferId(iframe, measured);
      final_size = transferStyles(measured, iframe, false);
      parent.removeChild(measured);
    }
    return final_size;
  }

  // Elements a stand-in cannot be sized like: what they show sizes them (media, frames,
  // images), or the page's code runs when one is made (custom elements, by their '-').
  const NoStandInTags = new Set(['video', 'audio', 'iframe', 'img', 'canvas', 'object', 'embed', 'picture', 'svg']);

  // For each hard-replaced element, whether its stand-in measures as it does.
  const standInFits = new WeakMap();

  /**
   * An empty element the page's CSS sizes as it sizes `old`: the same tag and attributes
   * (classes, inline style, data-*), but nothing inside, no id (the measurement lends it
   * the id) and no inline handlers.
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
   * Measures the page's element where the player is, once, and a stand-in in the same
   * place: a box that comes from what is inside (an aspect ratio its video gives it, text)
   * makes the stand-in's differ, and then the element itself goes on being measured.
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

  function pauseOnPlay() {
    // A call's live stream plays on (playsLiveStream), also one given its stream later.
    // eslint-disable-next-line no-invalid-this
    if (!playsLiveStream(this)) this.pause();
  }

  function pauseAllWithin(element) {
    // Every element hooked, so all of them are let go again, wherever the page has moved
    // them by then. The cleanup used to unhook the videos still inside the element only,
    // which left an <audio> added meanwhile pausing itself on every play, for good.
    const hooked = new Set();
    const hook = (media) => {
      try {
        // Not a call's live stream: a watch party's voice chat fell silent under a player
        // over the whole page, as every other pause here already knew (playsLiveStream).
        if (!playsLiveStream(media)) media.pause();
      } catch (e) {
        console.error(e);
      }
      media.addEventListener('play', pauseOnPlay);
      hooked.add(media);
    };

    // Its sounds too, as for the ones added later: an <audio> already there played on
    // under the player.
    querySelectorAllIncludingShadows('video, audio', element).forEach(hook);

    // Add mutation observer to pause videos added later: added themselves, or inside an
    // added subtree, as a re-render of the page's player puts them.
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
              hook(node);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              querySelectorAllIncludingShadows('video, audio', node).forEach(hook);
            }
          });
        }
      });
    });
    observer.observe(element, {childList: true, subtree: true});

    return {
      observer,
      hooked,
    };
  }

  function removePauseListeners(watcher) {
    watcher.hooked.forEach((media) => {
      media.removeEventListener('play', pauseOnPlay);
    });
    watcher.hooked.clear();
    watcher.observer.disconnect();
  }

  function transferStyles(old, iframe, softReplace) {
    const rect = old.getBoundingClientRect();
    const styles = window.getComputedStyle(old);

    iframe.setAttribute('style', old.getAttribute('style'));
    iframe.classList = old.classList;

    const width = Math.max(rect.width, 100) + 'px';
    const height = Math.max(rect.height, 100) + 'px';

    iframe.style.setProperty('width', width, 'important');
    iframe.style.setProperty('height', height, 'important');
    iframe.style.setProperty('padding', '0px', 'important');
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

  function transferId(from, to) {
    const fromId = from.id;
    if (fromId) {
      from.id = '';
      to.id = fromId;
    }
  }

  // The background opens the player only once the page's tracks have been read (see
  // handleCaptionsScrape), so a track whose server never answers must not be waited on:
  // without a timeout that request hung, and the player with it. What gives a request up
  // is a stall - this long with no byte arriving - so a large track on a slow connection
  // still loads, up to the total, which also bounds one that only trickles.
  const HttpRequestStallMs = 2000;
  const HttpRequestTimeoutMs = 10000;

  /**
   * A copy of SubtitleUtils.decodeSubtitleBytes (a classic script cannot import it; a unit
   * test keeps the two the same): a subtitle file's bytes as text, in the older encoding of
   * the browser's language when they are no UTF-8.
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
      // No UTF-8: the older encoding of the browser's language, as Firefox falls back to.
      // Read as Windows-1252, a Russian, Polish or Greek file showed wrong letters.
      const language = String(globalThis.navigator?.language || '').toLowerCase();
      const legacy = [
        [/^(ru|uk|be|bg|sr|mk)\b/, 'windows-1251'], [/^(pl|cs|sk|sl|hu|hr|ro|bs)\b/, 'windows-1250'],
        [/^el\b/, 'windows-1253'], [/^(tr|az)\b/, 'windows-1254'], [/^he\b/, 'windows-1255'],
        [/^(ar|fa|ur)\b/, 'windows-1256'], [/^(lt|lv|et)\b/, 'windows-1257'], [/^vi\b/, 'windows-1258'],
        [/^th\b/, 'windows-874'], [/^ja\b/, 'shift_jis'], [/^ko\b/, 'euc-kr'],
        [/^zh-(tw|hk|mo|hant)/, 'big5'], [/^zh\b/, 'gb18030'],
      ].find(([pattern]) => pattern.test(language));
      return new TextDecoder(legacy ? legacy[1] : 'windows-1252').decode(bytes);
    }
  }

  // Answers with the response's text, read as a subtitle file (decodeSubtitleBytes): its one
  // use is the page's subtitle files, which can be Windows-1252.
  function httpRequest(...args) {
    const url = args[0];
    let post = undefined;
    let callback;
    let bust = false;

    if (args[2]) { // post
      post = args[1];
      callback = args[2];
      bust = args[3];
    } else {
      callback = args[1];
      bust = args[2];
    }
    // fetch() since 2026-10-06 (XMLHttpRequest before). The whole request has
    // HttpRequestTimeoutMs; it stops when nothing has come for HttpRequestStallMs, before
    // the headers or between pieces of the body. A failed or stopped request calls back
    // as a status other than 200 did, with no response.
    const stall = new AbortController();
    let stallTimer;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(), HttpRequestStallMs);
    };
    const init = {
      method: post ? 'POST' : 'GET',
      signal: AbortSignal.any([stall.signal, AbortSignal.timeout(HttpRequestTimeoutMs)]),
    };
    try {
      if (post) {
        const toPost = [];
        for (const i in post) {
          if (Object.hasOwn(post, i)) {
            toPost.push(encodeURIComponent(i) + '=' + encodeURIComponent(post[i]));
          }
        }
        init.headers = {'Content-type': 'application/x-www-form-urlencoded'};
        init.body = toPost.join('&');
      }
    } catch (e) {
      callback(e);
      return;
    }

    const load = async () => {
      armStallTimer();
      const response = await fetch(url + (bust ? ('?' + Date.now()) : ''), init);
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
          chunks.push(value);
        }
      }
      const bytes = await new Blob(chunks).arrayBuffer();
      return [undefined, response, decodeSubtitleBytes(bytes, response.headers.get('Content-Type'))];
    };
    // The callback runs outside the catch: one that throws is not a failed request.
    load().catch(() => [true, undefined, false]).then(([err, response, text]) => {
      clearTimeout(stallTimer);
      callback(err, response, text);
    }).catch((e) => console.error('FastStream: a subtitle answer failed', e));
  }

  /**
   * Whether this frame's document holds a FastStream player iframe, loaded or still
   * loading. Read from the page, not from iframeMap: a player is linked there only once
   * it has loaded.
   * @return {boolean}
   */
  function hasPlayerIframe() {
    const playerUrl = chrome.runtime.getURL('player/index.html');
    return querySelectorAllIncludingShadows('iframe').some((iframe) => iframe.src.startsWith(playerUrl));
  }

  /**
   * Every element matching a query, those in open shadow roots too.
   * @param {string} query - The selector.
   * @param {?Element|DocumentFragment} [currentElement] - Where to look; the body by default.
   * @param {Element[]} [results] - Where to put what is found.
   * @param {function(Element): ?ShadowRoot} [shadowOf] - The shadow root to look into, of
   *   an element: its open one by default (querySelectorAllInAllShadows: closed ones too).
   * @return {Element[]}
   */
  function querySelectorAllIncludingShadows(query, currentElement = document.body, results = [],
      shadowOf = (el) => el.shadowRoot) {
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

    // The element's own shadow root too: querySelectorAll('*') lists only what is below
    // it. A page that re-renders its player as a custom element with its <video> in its
    // shadow root added it while FastStream's player was up, and pauseAllWithin's observer,
    // which looks inside each added element, never paused it. Last, so what the walk above
    // found keeps its place.
    const own = shadowOf(currentElement);
    if (own) {
      querySelectorAllIncludingShadows(query, own, results, shadowOf);
    }

    return results;
  }

  /**
   * querySelectorAllIncludingShadows into closed shadow roots as well, which Firefox opens
   * to a content script (openOrClosedShadowRoot; shadowRoot is null for a closed one). For
   * what is paused or looked up there - the page's media, a frame's iframe - not for where
   * a player goes. The listeners for a play already went into closed roots
   * (listenInShadowRoots), so a play there was heard, and sent to mpv, but nothing paused
   * it: it played on beside mpv (PAUSE_MEDIA) and under FastStream's player
   * (HOLD_PAGE_MEDIA), and an embed's iframe in one never linked up.
   * @param {string} query - The selector.
   * @param {?Element|DocumentFragment} [root] - Where to look; the body by default.
   * @return {Element[]}
   */
  function querySelectorAllInAllShadows(query, root = document.body) {
    return querySelectorAllIncludingShadows(query, root, [], (el) => el.openOrClosedShadowRoot || el.shadowRoot);
  }

  function getParentElement(element) {
    return element.parentElement || element.assignedSlot || element.parentNode?.host;
  }

  const NotLayerTags = new Set(['STYLE', 'SCRIPT', 'LINK', 'TEMPLATE']);

  /**
   * Every element of the page, those in shadow roots (open or closed) too, each root's
   * after its host.
   * @param {Document|ShadowRoot} [root]
   * @param {Element[]} [found]
   * @return {Element[]}
   */
  function allElementsIncludingShadows(root = document, found = []) {
    for (const element of root.querySelectorAll('*')) {
      found.push(element);
      // Firefox lets a content script into closed roots too.
      const shadow = element.openOrClosedShadowRoot || element.shadowRoot;
      if (shadow) {
        allElementsIncludingShadows(shadow, found);
      }
    }
    return found;
  }

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
      current = current.assignedSlot || current.parentElement || current.parentNode?.host;
    }
    return parents;
  }

  function isVisible(domElement) {
    return new Promise((resolve) => {
      const o = new IntersectionObserver(([entry]) => {
        resolve(entry.intersectionRatio);
        o.disconnect();
      });
      o.observe(domElement);
    });
  }

  function testSimilarity(originalElement, childElement, parentElement) {
    const parentStyle = window.getComputedStyle(parentElement);
    // const childStyle = window.getComputedStyle(childElement);
    const parentRect = parentElement.getBoundingClientRect();
    const childRect = childElement.getBoundingClientRect();

    // Check if child element has fixed position
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

    // Check if parent element is overflow hidden and child element can cover the parent element
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
    const videos = Array.from(querySelectorAllIncludingShadows('video'));

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
    }, null);

    if (!largestVideo) {
      return null;
    }

    const parentElementsWithSameBounds = getParentElementsWithSameBounds(largestVideo.video);
    return {
      video: largestVideo.video,
      size: largestVideo.visibleArea,
      parents: parentElementsWithSameBounds,
      highest: parentElementsWithSameBounds.length > 0 ? parentElementsWithSameBounds[parentElementsWithSameBounds.length - 1] : largestVideo.video,
    };
  }

  /**
   * Starts the page's own player, when it waits for a click before it loads its video. The
   * background asks for it after FastStream went on to the next episode by itself (the
   * player's autoplay next): a hoster's player sat idle on the next episode's page
   * (serienstream.to's VOE, a JW Player, 2026-10-11), FastStream had nothing to play, and
   * the user had to click. Started here, it loads its stream, FastStream takes that, and
   * its own player plays it: an extension page may play sound without a click.
   * Once per page: the background asks again every 2 s, and a page whose player does not
   * load at once (an overlay it opens, a request it waits for) was clicked again each time.
   * @return {Promise<?string>} What was done, or null.
   */
  async function startPagePlayer() {
    // Started already, or FastStream's player is in this frame.
    if (pagePlayerStarted || iframeMap.size > 0 || pendingPlayers.size > 0) return null;
    // The players' own APIs first: their play() loads the stream the way their button does,
    // and a click on them can land on an ad's layer. The page's objects, through the content
    // script's view of the page (Firefox's Xray waiver).
    const page = window.wrappedJSObject;
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
    // The video is found by its visibility, which a background tab tells only every second or
    // so (IntersectionObserver), and the background asks every 2 s: a second ask meanwhile
    // clicked the play button again, and the player paused (final review, 2026-10-11).
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
    const video = found && found.video;
    if (video && (!video.paused || video.ended)) return null;
    if (video && (video.currentSrc || video.src || video.srcObject)) {
      pagePlayerStarted = true;
      // Not muted when the page may not play sound yet: left muted when FastStream did not
      // take its stream after all, the site's player stayed silent. A play the browser
      // refuses (a tab with no click yet) is tried again at the next ask: a play, unlike a
      // click, does not undo itself.
      video.play().catch(() => {
        pagePlayerStarted = false;
      });
      return 'play';
    }
    // Nothing loaded (or no video yet: some players make it on the click): the player's own
    // big play button, else a click on the video, for players that load on a click on it.
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

  /**
   * The visible big play button of the page's player: a known player's anywhere (it shows
   * one only over its picture), another one only over the video.
   * @param {?HTMLVideoElement} video - The page's largest video, if there is one.
   * @return {?HTMLElement}
   */
  function playButtonFor(video) {
    const shown = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return null;
      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
      return rect;
    };
    const known = querySelectorAllIncludingShadows(PlayerPlayButtons).find((element) => shown(element));
    if (known) return known;
    if (!video) return null;
    const area = video.getBoundingClientRect();
    return querySelectorAllIncludingShadows(GenericPlayButtons).find((element) => {
      const rect = shown(element);
      if (!rect) return false;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
    }) || null;
  }

  function url_to_absolute(urlStr) {
    const url = new URL(urlStr, document.baseURI);
    return url.href;
  }

  function isLinkToDifferentPageOnWebsite(url) {
    try {
      url = new URL(url, window.location.href);
    } catch (e) {
      return false;
    }

    if (url.origin !== window.location.origin) {
      return false;
    }

    if (url.pathname !== window.location.pathname) {
      return true;
    }

    if (url.search !== window.location.search) {
      return true;
    }

    return false;
  }


  function isSimilar(element, child) {
    const style = window.getComputedStyle(element);
    const width = parseInt(style.width) || 0;
    const height = parseInt(style.height) || 0;

    const cstyle = window.getComputedStyle(child);
    const cwidth = parseInt(cstyle.width) || 0;
    const cheight = parseInt(cstyle.height) || 0;
    if (child.tagName == element.tagName && (cwidth == width || cheight == height) && cstyle.display == style.display && cstyle.position == style.position) {
      return true;
    }
    return false;
  }


  function getSimilar(element) {
    if (!element) return [];
    const parent = element.parentElement;
    if (!parent) return [];
    const children = parent.children;
    if (element.tagName === 'BODY' || !children) return [];


    const found = [];
    const potential = [];
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
   * A link's own target, in lower case: HTML matches the keywords so ("_BLANK" opens a new
   * tab too). An SVG link has it as an attribute as well.
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
   * The one element whose words mean the next (or the previous) episode this surely
   * (EpisodeLinks.phraseScore): one link target, or one button. Two different ones are
   * none: a guess between them could be a wrong episode.
   * @param {Array<Element>} elements
   * @param {boolean} isNext
   * @param {number} score
   * @return {?Element}
   */
  function onlyOneSaying(elements, isNext, score) {
    const hits = elements.filter((el) => EpisodeLinks.phraseScore(wordsOf(el), isNext) === score);
    // A link counts by its address; anything else (a button) by itself.
    const targets = new Set(hits.map((el) => (el.tagName === 'A' && typeof el.href === 'string' && el.href ?
      withoutHash(el.href) : el)));
    return targets.size === 1 ? hits[0] : null;
  }

  /**
   * The page's links, by how far they may be trusted as an episode's (2026-10-11, aniworld.cc:
   * after a season's last episode, autoplay went on to another series):
   * - site: to this site;
   * - series: of them, those of this page's series where its address names one
   *   (EpisodeLinks.seriesOf) - another series is never the next episode;
   * - own: of them, those that open in the page - a link into a new tab, unless it is the
   *   very next episode's address, is an ad's way.
   * @param {Array<Element>} aElements
   * @return {{site: Array<Element>, series: Array<Element>, own: Array<Element>}}
   */
  function episodeLinksOf(aElements) {
    const seriesOfPage = EpisodeLinks.seriesOf(window.location.href);
    const site = aElements.filter((a) => typeof a.href === 'string' && isLinkOnThisSite(a));
    const series = site.filter((a) => EpisodeLinks.inSeries(seriesOfPage, a.href));
    return {site, series, own: series.filter((a) => ownTarget(a) !== '_blank')};
  }

  /**
   * Whether the page lists this page's season: it links the previous episode, or two other
   * episodes of the season (a season's first episode has no previous; deepseek's review) -
   * one other alone ("latest episode: 5") is no list (its third round).
   * @param {Array<Element>} links - episodeLinksOf's series links.
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
   * Whether this page is its series' last episode, as far as its links tell: an address that
   * names the series, a page that lists this season's episodes, and no next episode or season
   * in it (asked once getNextOrPreviousButton found none). Autoplay then stops and says so,
   * where a page FastStream cannot read is noted as a problem.
   * @return {boolean}
   */
  function isSeriesEnd() {
    if (!EpisodeLinks.seriesOf(window.location.href)) return false;
    const links = episodeLinksOf(querySelectorAllIncludingShadows('a'));
    return listsThisSeason(links.series) && !linksLaterInSeason(links.site);
  }

  /**
   * Whether the page links a later episode of this page's season: a gap before it (a removed
   * episode) is no season's end (glm's review, 2026-10-11).
   * @param {Array<Element>} siteLinks - episodeLinksOf's site links, into a new tab too.
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
    const aElements = querySelectorAllIncludingShadows('a');
    const links = episodeLinksOf(aElements);
    const ownLinks = links.own;
    const series = EpisodeLinks.seriesOf(window.location.href);

    // 1. This page's episode number +1 (or -1), when the page links to it: the series part
    // of the address stays, so it cannot be another show (2026-10-11). Also a link into a
    // new tab: that address is the episode's, and it opens in this tab (the chain's).
    for (const candidate of EpisodeLinks.neighbourEpisodeUrls(window.location.href, isNext)) {
      const hit = links.series.find((a) => withoutHash(url_to_absolute(a.href)) === candidate);
      if (hit) return hit;
    }

    // A page that names its series and lists its season tells by its links alone: a button
    // that says "next episode" there may lead anywhere (kimi's review, 2026-10-11).
    const structured = !!series && listsThisSeason(links.series);

    // 1b. The last episode of a season, in a page that lists its episodes: the next season's
    // first. Not where the page links a later episode of this season (a gap: step 3 finds it
    // in the list). The next season's episode 1 where the page links it; its episode this
    // one +1 where the site numbers on across seasons (12, then 13); else, where the page
    // links the season or one of its episodes (a "continue watching" episode 5 is no first:
    // glm's review), its episode 1: this address with the season one on (.../staffel-4/episode-1).
    if (isNext && structured && !linksLaterInSeason(links.site)) {
      const here = EpisodeLinks.seasonEpisode(window.location.href);
      const next = EpisodeLinks.nextSeason(window.location.href);
      if (here && next) {
        const ofNext = links.series.map((a) => ({a, at: EpisodeLinks.seasonEpisode(a.href)}))
            .filter(({at}) => !!at && at.show === here.show && at.season === here.season + 1);
        const linked = ofNext.find(({at}) => at.episode === 1) || ofNext.find(({at}) => at.episode === here.episode + 1);
        if (linked) return linked.a;
        const linksSeason = (a) => {
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

    // 2. An episode phrase in any language FastStream knows ("Nächste Folge", 下一集), in a
    // link's text, aria-label or title, or on a button that is no link.
    const buttons = structured ? [] : querySelectorAllIncludingShadows('button, [role="button"]')
        .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    const phrase = onlyOneSaying(ownLinks, isNext, 2) || onlyOneSaying(buttons, isNext, 2);
    if (phrase) return phrase;

    // 3. As until 2026-10-11, without links into a new tab: the next episode there broke the
    // chain (the next page's stream came in another tab). A link of another series is none.
    const found = getNextOrPreviousByList(aElements.filter((a) => ownTarget(a) !== '_blank'), isNext);
    if (found && (found.tagName !== 'A' || (typeof found.href === 'string' && EpisodeLinks.inSeries(series, found.href)))) {
      return found;
    }

    // 4. rel=next (or prev), then a bare word ("weiter"): pagination uses them too, so last.
    // Link types are matched in any case, as HTML does (rel="Next").
    const rel = ownLinks.find((a) => (a.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes(isNext ? 'next' : 'prev'));
    return rel || onlyOneSaying(ownLinks, isNext, 1);
  }

  /**
   * 3. The way it was found until 2026-10-11: an English "next" or "next episode" link, the
   * neighbour of this page's link in a list, an "Episode N" list.
   * @param {Array<Element>} aElements
   * @param {boolean} isNext
   * @return {?Element}
   */
  function getNextOrPreviousByList(aElements, isNext) {
    // Check if next or previous button is in a elements
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
    let matchedElements = aElements.filter((a) => {
      if (!a.href) {
        return false;
      }
      try {
        const url = url_to_absolute(a.href);
        return url === currentURL;
      } catch (e) {
        return false;
      }
    });

    if (matchedElements.length === 0) {
      matchedElements = aElements.filter((a) => {
        const textContent = a.textContent.trim();
        // Check if it containes Episode # or similar
        if (textContent.match(/episode\s*\d+/i)) {
          return true;
        }
      });
    }

    if (matchedElements.length === 0) {
      return null;
    }

    for (let i = 0; i < matchedElements.length; i++) {
      const element = matchedElements[i];
      const similar = getSimilar(element);
      if (similar.length > 0) {
        // Find index of element with match
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

        // Find next element
        const nextIndex = isNext ? index + 1 : index - 1;

        if (nextIndex < 0 || nextIndex >= similar.length) {
          continue;
        }

        // Check if a element. Only one to this site, as for a "Next" link above: a list's
        // neighbour may be an ad, and the player followed it.
        if (similar[nextIndex].tagName === 'A') {
          if (isLinkOnThisSite(similar[nextIndex])) {
            return similar[nextIndex];
          }
          continue;
        }

        // A neighbour without a link ends this match only: another one may lead to the
        // episode (a side list that links here too, before the real episode list).
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
      return (new URL(url)).origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  document.addEventListener('click', (e) => {
    let current = e.target;
    while (current) {
      if (current.tagName === 'A') {
        break;
      }
      current = getParentElement(current);
    }

    if (!current || !current.href) {
      return;
    }

    // A click that opens the link somewhere else - a new tab or window (Ctrl, Command,
    // Shift, target="_blank", also by the page's <base target>), a download (Alt, or the
    // download attribute) - leaves this page and its player where they are.
    const target = linkTarget(current);
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey ||
        current.hasAttribute('download') ||
        (target && !['_self', '_parent', '_top'].includes(target))) {
      return;
    }

    // check if href leads to different page and origin
    const url = current.href;
    if (isLinkToDifferentPageOnWebsite(url)) {
      removePlayers();
    }
  }, true);


  document.addEventListener('fullscreenchange', () => {
    const changedFor = [];
    iframeMap.forEach((iframeObj) => {
      const fullscreenState = iframeObj.fullscreenState;
      const element = iframeObj.iframe;
      const active = document.fullscreenElement === element;
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

  window.addEventListener('resize', () => {
    updateReplacedPlayersSoon();
    resizeMiniPlayers();
  });

  // Sites that pad their video with popup/popunder ads commonly hook the
  // page's own 'blur' event to fire window.open() the moment focus leaves
  // the top document - which is exactly what happens the instant a click on
  // our player iframe lands, since focus moves into it. Arming the
  // background's tabs.onCreated guard right here lets it tell "the site
  // hijacked this click" apart from a normal middle-click-to-open-in-
  // background-tab elsewhere on the page, which never blurs the top window
  // like this.
  window.addEventListener('blur', () => {
    const active = document.activeElement;
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
   * @return {?{src: string, duration: ?number, playing: string, time: number}} Its file's URL
   *   (not a blob: URL, which a detected source never has), its length in seconds (Infinity
   *   when live), its currentSrc as it is, blob: or not, and where it plays, in seconds; or
   *   null for no video.
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
   * What the video a player replaced plays: as it is now, while it plays what it played
   * then (a page's player sets its length a moment after it asked for the manifest), or
   * else as it was then.
   * @param {Object|undefined} player - The replaced player (replacedPlayerQueue).
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

  // The page's Resource Timing buffer keeps its first 250 requests, and a streaming page has
  // made that many (ads, trackers) before its video asks for its manifest: the manifest was
  // never in it. An observer is told of every request, buffer full or not (Firefox's
  // Performance::InsertResourceEntry queues each entry to observers first), from this
  // script's start at document_start. The ones loadedMedia reports are kept here, the
  // first ObservedMediaLimit of them (a URL once), past the buffer. Nothing the page can
  // see changes, as it would with setResourceTimingBufferSize.
  const ObservedMediaLimit = 1000;
  const observedMedia = new Map();
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (observedMedia.size >= ObservedMediaLimit) break;
        if (!LoadedMediaInitiators.includes(entry.initiatorType) || observedMedia.has(entry.name)) continue;
        observedMedia.set(entry.name, {
          name: entry.name,
          initiatorType: entry.initiatorType,
          responseStatus: entry.responseStatus,
          startTime: entry.startTime,
        });
      }
    }).observe({type: 'resource', buffered: true});
  } catch (e) {
    // No observer: the timeline's own buffer is all there is.
  }

  /**
   * What this page loaded that may be a stream, for a background that did not see it load:
   * Firefox unloads the background after ~30 idle seconds, and the streams it detected with
   * it, while a page asks for its manifest once, when its video starts. The page's own
   * Resource Timing entries keep those requests for as long as it lives (the first 250 of
   * them, and what the observer above kept past those), and its videos tell the files
   * they play.
   * @return {Array<{url: string, media: boolean, time: number}>} Each URL, whether a media
   *   element loaded it, and when the request started (ms since the epoch).
   */
  function loadedMedia() {
    const found = [];
    let entries = [];
    try {
      entries = Array.from(performance.getEntriesByType('resource'));
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
    querySelectorAllIncludingShadows('video, audio').forEach((media) => {
      const src = media.currentSrc || '';
      if (/^https?:\/\//i.test(src) && !found.some((entry) => entry.url === src)) {
        found.push({url: src, media: true, time: Date.now()});
      }
    });
    return found;
  }

  // MPV started by its shortcut hands over only a video the user starts, not
  // whatever the page loads or autoplays on its own (previews, background
  // clips, a preloaded player). A 'play' while the page is still handling a
  // click or key press carries transient user activation; an autoplay does
  // not. Media events do not bubble, hence the capture listener. The
  // background ignores the report unless the tab is in that mode.
  const userStartedVideos = new WeakSet();

  // How long Firefox counts a press as the user's (dom.user_activation.transient.timeout).
  const UserActivationMs = 5000;
  // When the user last pressed a pointer or a key in this frame (trusted; onUserGesture).
  let lastUserGestureAt = -Infinity;
  // When this frame last saw a key press that could be an extension's shortcut (onUserGesture).
  let lastShortcutKeyAt = -Infinity;

  /**
   * Whether a play now follows the user's own press. navigator.userActivation.isActive
   * alone missed a common case: a site whose play button first opens a pop-up. window.open()
   * consumes the activation, so the video the same click started played with isActive
   * already false, was taken for an autoplay, and never went to mpv. A trusted press in
   * this frame within the time Firefox gives an activation counts too; an autoplay with no
   * press behind it still does not.
   *
   * Firefox activates the page for a shortcut's key too: after Alt+F, isActive is true for
   * 5 s (measured on Firefox 158, Linux and Windows, CI run 39473761807). A video the page
   * started on its own in those 5 s - a muted preview that began a moment after the MPV key -
   * counted as the user's and went to mpv (mpv-shortcut.e2e.mjs, CI runs 38454197759 and
   * 39192185180). So the activation counts only when the press behind it was not such a key.
   * @return {boolean}
   */
  function playFollowsUserPress() {
    const now = performance.now();
    if (now - lastUserGestureAt <= UserActivationMs) return true;
    if (!navigator.userActivation || !navigator.userActivation.isActive) return false;
    // Active with no press of its own here: a shortcut's key, or a press in another frame
    // (Firefox activates the frames above, and the same-origin ones below, too).
    return now - lastShortcutKeyAt > UserActivationMs;
  }

  function reportUserPlay(video) {
    try {
      chrome.runtime.sendMessage({
        type: MessageTypes.MPV_USER_PLAY,
        src: video.currentSrc || '',
        video: playedVideo(video),
      }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // The extension was reloaded under this page: nothing to report to.
    }
  }

  function onPlay(e) {
    // Only a play Firefox reports: a 'play' event the page makes up during a click starts
    // nothing, and made its video the one the shortcut sends.
    if (!e.isTrusted) return;
    const video = e.target;
    if (!video || video.tagName !== 'VIDEO') return;
    if (!playFollowsUserPress()) return;
    userStartedVideos.add(video);
    reportUserPlay(video);
  }

  document.addEventListener('play', onPlay, true);
  document.addEventListener('play', pauseHeldMedia, true);

  // A video's own file, told to the background once the video has it. The background learns
  // of a stream from the request for it (onHeadersReceived), and Firefox can play a file
  // without one: a page that plays a file an earlier page of the site played got it with no
  // request at all, served no-store and the earlier page not in the back-forward cache
  // (measured, same-video-file.e2e.mjs). On a site FastStream was already on for, nothing
  // asked the page either (recoverSources runs when it is turned on), so the player never
  // opened. A URL the background knows already changes nothing there (recoverFrameSources);
  // a blob: one is no file. Not heard: a video in a shadow root not found yet (media events
  // stay in their root, and roots are found as the user acts); turning FastStream on still
  // finds it (loadedMedia).
  const reportedVideoFiles = new Set();

  function onLoadedMetadata(e) {
    if (!e.isTrusted) return;
    const video = e.target;
    if (!video || video.tagName !== 'VIDEO') return;
    const src = video.currentSrc || '';
    if (!/^https?:\/\//i.test(src) || reportedVideoFiles.has(src)) return;
    reportedVideoFiles.add(src);
    try {
      chrome.runtime.sendMessage({
        type: MessageTypes.LOADED_MEDIA,
        // Told as it loaded: the background lets the request's own detection come first.
        live: true,
        url: window.location.href,
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

  document.addEventListener('loadedmetadata', onLoadedMetadata, true);

  // A play inside a shadow root (a player built as a web component) never reaches the
  // document: media events are not composed. So the shortcut ignored such players. Each
  // open shadow root gets the listener too, found as the user acts, since a play the user
  // starts follows a click or a key: the roots on the way to what was clicked at once, and
  // every root on the page at most every 2 s, for a button outside the player's root.
  const listenedRoots = new WeakSet();
  let lastRootScan = 0;

  function listenInRoot(root) {
    if (!listenedRoots.has(root)) {
      listenedRoots.add(root);
      root.addEventListener('play', onPlay, true);
      root.addEventListener('play', pauseHeldMedia, true);
      root.addEventListener('loadedmetadata', onLoadedMetadata, true);
    }
  }

  function listenInShadowRoots(root) {
    for (const element of root.querySelectorAll('*')) {
      // Firefox lets a content script into closed roots too.
      const shadow = element.openOrClosedShadowRoot || element.shadowRoot;
      if (shadow) {
        listenInRoot(shadow);
        listenInShadowRoots(shadow);
      }
    }
  }

  function onUserGesture(e) {
    if (!e.isTrusted) return;
    // A key that starts a video is a plain one (Space, Enter, K). One that could be an
    // extension's shortcut is not: the MPV shortcut itself is one, whatever the user bound
    // it to in about:addons (Ctrl+Shift+U by default, Alt+F on the owner's PC). Nor is a
    // modifier alone, or Escape, which is no activation in Firefox.
    const noPress = e.type === 'keydown' &&
      (ModifierKeys.includes(e.key) || e.key === 'Escape' || couldBeExtensionShortcut(e));
    if (!noPress) {
      lastUserGestureAt = performance.now();
    } else if (!ModifierKeys.includes(e.key) && e.key !== 'Escape' && !/^Media/.test(e.key)) {
      // Firefox's activation for it is not the user's (playFollowsUserPress). A media key is
      // a play control, not a shortcut: the play it starts stays the user's.
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

  window.addEventListener('pointerdown', onUserGesture, true);
  window.addEventListener('keydown', onUserGesture, true);
  window.addEventListener('keydown', (e) => {
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

  // Pressing the shortcut while already watching a video the user started
  // counts as starting it now.
  function reportPlayingUserVideo() {
    for (const video of querySelectorAllInAllShadows('video')) {
      if (userStartedVideos.has(video) && !video.paused && !video.ended) {
        reportUserPlay(video);
        return true;
      }
    }
    return false;
  }

  // Firefox lets a page cancel an extension's keyboard shortcut: a keydown
  // the page calls preventDefault() on never reaches the command. Sites do it
  // by accident - VOE's "no view-source" guard cancels every Ctrl+U, Shift or
  // not, which swallowed Ctrl+Shift+U (the MPV key until 2026-10-04, and still a
  // user's if they bound it). So once the page is done with a key
  // press, a cancelled one that could be a shortcut goes to the background,
  // which runs the command bound to it, if any. A press the page left alone
  // is Firefox's to run: reporting only cancelled ones means a shortcut never
  // runs twice. This listener is registered before any page script, so the
  // page cannot keep the press from it; isTrusted keeps the page from faking
  // one.
  const ModifierKeys = ['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS'];

  /**
   * Whether a key press could be an extension's keyboard shortcut, whatever the user bound
   * in about:addons: Firefox's shortcuts need Ctrl, Alt or Command, except F-keys and media
   * keys.
   * @param {KeyboardEvent} e - The press.
   * @return {boolean}
   */
  function couldBeExtensionShortcut(e) {
    return e.ctrlKey || e.altKey || e.metaKey || /^(F\d+|Media\w+)$/.test(e.key);
  }

  window.addEventListener('keydown', (e) => {
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

  // Firefox fires beforeunload for a navigation that then never happens: a link answered
  // with a download or a 204, a "Leave page?" the user said no to (this listener runs
  // before the page's). The page stays, but the background was told it left: it forgot the
  // page's frames and their streams, and refused every player the page opened after that,
  // as one of a gone page (TabHolder.isPlayerOfGoneDocument), until a reload. So a page
  // still here a moment later names itself again, as one the back-forward cache gives back
  // does (pageshow, below), and from then on reports its leaving on pagehide too.
  //
  // The report itself stays at beforeunload, not pagehide. The next page's own load can be
  // its stream (a proxy link opened in the tab, embed-page-query.e2e.mjs), detected as its
  // answer comes in, which is before the old page's pagehide. Told at beforeunload, the
  // background has let go of the old page's frame by then: kept, a frame holding a player
  // dropped that stream (onHeadersReceived's hasPlayer), and the old page's late leave took
  // it away with that page (FRAME_ADDED keeps only what the frame already has). A load that
  // takes longer than LeaveSettledMs gets the pagehide report, and loses that ordering.
  const LeaveSettledMs = 2000;
  // 'here'; 'left', told at beforeunload; or 'back', named again after a leave that never
  // happened.
  let leaveState = 'here';
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
    // The page's name: this message can reach the background after the next page's
    // FRAME_ADDED, and must not make it forget that page's frame.
    notifyBackground({
      type: MessageTypes.FRAME_REMOVED,
      document: DocumentKey,
    });
  }

  window.addEventListener('beforeunload', () => {
    // FRAME_REMOVED makes the background forget this frame and its sources. For the
    // redirect to the player that is exactly wrong: the player loads in this same frame
    // and asks for them straight away, and got none.
    if (RedirectingToPlayer) {
      return;
    }
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

  window.addEventListener('pagehide', () => {
    // Gone, or into the back-forward cache, which names the page again itself (pageshow).
    clearTimeout(leaveTimer);
    leaveTimer = null;
    if (leaveState === 'back' && !RedirectingToPlayer) {
      reportLeaving();
    }
  });

  // Firefox's back-forward cache gives this page back, content script and all, after
  // its leaving told the background to forget it (above); the page fetches nothing
  // again. Naming it again gets back what the background had detected on it
  // (TabHolder.restoreGoneDocument). A page that went to the player and came back
  // reports its next leave again.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) {
      return;
    }
    RedirectingToPlayer = false;
    leaveState = 'here';
    // A hold from before it left can be stale: its end, sent to the tab's frames while this
    // page was in the cache, never reached it, and its frames would go on pausing every
    // play, the site's own player in its embed included. The background holds it again if
    // a player still plays: naming the page (below) makes it tell every frame (FRAME_ADDED).
    pageMediaHeld = false;
    nameThisPage();
  });

  nameThisPage();
})();
