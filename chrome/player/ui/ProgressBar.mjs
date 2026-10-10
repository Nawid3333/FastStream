import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {Localize} from '../modules/Localize.mjs';
import {EventEmitter} from '../modules/eventemitter.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';

export class ProgressBar extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.progressCache = [];
    this.progressCacheAudio = [];
    this.hasShownNextVideo = false;
    this.isSeeking = false;
    this.isMouseOverProgressbar = false;

    this.preciseMode = false;
    this.keepPreciseModeOpen = false;
    this.onPreciseModeStartHandle = this.onPreciseModeStart.bind(this);
    this.onPreciseModeEndHandle = this.onPreciseModeEnd.bind(this);
  }

  onPreciseModeStart() {
    const fineTimeControls = this.client.interfaceController.fineTimeControls;

    fineTimeControls.ui.timelineAudio.style.height = '22px';
    fineTimeControls.ui.timelineAudio.style.top = '52px';
    fineTimeControls.shouldRenderFrames(true);
  }

  onPreciseModeEnd() {
    const fineTimeControls = this.client.interfaceController.fineTimeControls;

    fineTimeControls.ui.timelineAudio.style.height = '';
    fineTimeControls.ui.timelineAudio.style.top = '';
    fineTimeControls.shouldRenderFrames(false);
  }

  startPreciseMode(keepOpen = false) {
    if (!this.client.player) {
      return;
    }

    const fineTimeControls = this.client.interfaceController.fineTimeControls;
    if (this.preciseMode) {
      fineTimeControls.prioritizeState(this.onPreciseModeStartHandle);
      return;
    }

    if (keepOpen) {
      this.keepPreciseModeOpen = true;
    }
    this.preciseMode = true;
    fineTimeControls.pushState(this.onPreciseModeStartHandle, this.onPreciseModeEndHandle);
  }

  endPreciseMode() {
    if (!this.preciseMode) {
      return;
    }
    this.preciseMode = false;
    this.keepPreciseModeOpen = false;
    const fineTimeControls = this.client.interfaceController.fineTimeControls;
    fineTimeControls.removeState(this.onPreciseModeStartHandle);
  }

  setupUI() {
    this.seekMarker = document.createElement('div');
    this.seekMarker.classList.add('seek_marker');
    DOMElements.markerContainer.appendChild(this.seekMarker);
    this.seekMarker.style.display = 'none';

    this.unseekMarker = document.createElement('div');
    this.unseekMarker.classList.add('seek_marker');
    this.unseekMarker.classList.add('unseek_marker');
    DOMElements.markerContainer.appendChild(this.unseekMarker);
    this.unseekMarker.style.display = 'none';

    this.audioAnalyzerMarker = document.createElement('div');
    this.audioAnalyzerMarker.classList.add('analyzer_marker');
    this.audioAnalyzerMarker.style.backgroundColor = '#ff0';
    DOMElements.markerContainer.appendChild(this.audioAnalyzerMarker);
    this.audioAnalyzerMarker.style.display = 'none';

    this.frameExtractorMarker = document.createElement('div');
    this.frameExtractorMarker.classList.add('analyzer_marker');
    this.frameExtractorMarker.style.backgroundColor = '#f00';
    DOMElements.markerContainer.appendChild(this.frameExtractorMarker);
    this.frameExtractorMarker.style.display = 'none';

    DOMElements.progressContainer.addEventListener('mousedown', this.onProgressbarMouseDown.bind(this));
    DOMElements.progressContainer.addEventListener('mouseenter', this.onProgressbarMouseEnter.bind(this));
    DOMElements.progressContainer.addEventListener('mouseleave', this.onProgressbarMouseLeave.bind(this));
    DOMElements.progressContainer.addEventListener('mousemove', this.onProgressbarMouseMove.bind(this));

    DOMElements.nextVideoBannerButton.addEventListener('click', (e) => {
      this.client.nextVideo();
      e.preventDefault();
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(DOMElements.nextVideoBannerButton);
  }

  reset() {
    // A drag still going (the next video came mid-scrub) froze the next video's bar, and the
    // release then seeked it to the old position.
    // Without playing on: the next video does not start because one was dragged in.
    this.endDrag?.(null, false);
    DOMElements.progressLoadedContainer.replaceChildren();
    this.progressCache = [];
    this.progressCacheAudio = [];
    // updateNextVideoBanner() runs only once the next video has a duration, and one that
    // never gets one kept the previous video's banner.
    this.hasShownNextVideo = false;
    DOMElements.nextVideoBannerButton.style.display = 'none';
  }

  collectProgressbarData(fragments) {
    let i = 0;
    let total = 0;
    let loaded = 0;
    let failed = 0;
    let currentTime = -1;
    const results = [];
    while (i < fragments.length) {
      const frag = fragments[i];
      if (!frag) {
        // A gap, which a live stream leaves when its window moves past fragments that were
        // never listed: the fragment after it starts from its own start.
        currentTime = -1;
        i++;
        continue;
      }
      total++;
      if (currentTime === -1) {
        currentTime = frag.start ? Math.max(frag.start, 0) : 0;
      }

      const start = currentTime;

      let end = currentTime + frag.duration;
      currentTime = end;

      if (frag.status === DownloadStatus.WAITING) {
        i++;
        continue;
      }

      const entry = {
        start: start,
        end: 0,
        width: 0,
        statusClass: 'download-uninitiated',
      };
      results.push(entry);

      if (frag.status === DownloadStatus.DOWNLOAD_INITIATED) {
        entry.statusClass = 'download-initiated';
      } else if (frag.status === DownloadStatus.DOWNLOAD_COMPLETE) {
        loaded++;
        entry.statusClass = 'download-complete';
      } else if (frag.status === DownloadStatus.DOWNLOAD_FAILED) {
        failed++;
        entry.statusClass = 'download-failed';
      }

      i++;

      while (i < fragments.length && fragments[i] && fragments[i].status === frag.status) {
        end = currentTime + fragments[i].duration;
        currentTime = end;
        i++;

        total++;
        if (frag.status === DownloadStatus.DOWNLOAD_COMPLETE) {
          loaded++;
        } else if (frag.status === DownloadStatus.DOWNLOAD_FAILED) {
          failed++;
        }
      }

      entry.end = end;
      entry.width = end - start;
    }
    return {
      results, total, loaded, failed,
    };
  }


  updateProgressBar(duration, cache, results, additionalClass) {
    for (let i = cache.length; i < results.length; i++) {
      const entry = {
        start: -1,
        width: -1,
        className: '',
        element: document.createElement('div'),
      };
      DOMElements.progressLoadedContainer.appendChild(entry.element);
      cache.push(entry);
    }

    for (let i = results.length; i < cache.length; i++) {
      cache[i].element.remove();
    }

    cache.length = results.length;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const entry = cache[i];
      // Placed as a part of the duration: a duration that changed (unknown at first, or
      // growing as a fragmented file is parsed) left them where the old one put them.
      const rescaled = entry.duration !== duration;
      entry.duration = duration;
      if (entry.start !== result.start || rescaled) {
        entry.start = result.start;
        entry.element.style.left = Math.min(result.start / duration * 100, 100) + '%';
      }

      if (entry.width !== result.width || rescaled) {
        entry.width = result.width;
        entry.element.style.width = Math.min(result.width / duration * 100, 100) + '%';
      }

      const className = ([result.statusClass, additionalClass]).join(' ');
      if (entry.className !== className) {
        entry.className = className;
        entry.element.className = className;
      }
    }
  }

  renderProgressBar(duration, cache, fragments, additionalClass = null) {
    const {results, total, loaded, failed} = this.collectProgressbarData(fragments);

    this.updateProgressBar(duration, cache, results, additionalClass);

    return {
      total,
      loaded,
      failed,
    };
  }

  updateFragmentsLoaded() {
    if (!this.client.player) {
      this.renderProgressBar(0, this.progressCache, []);
      this.renderProgressBar(0, this.progressCacheAudio, []);
      return;
    }

    const player = this.client.player;
    const duration = player.duration;

    const currentVideoLevelID = player.getCurrentVideoLevelID();
    const currentAudioLevelID = player.getCurrentAudioLevelID();

    const fragments = this.client.getFragments(currentVideoLevelID);
    const audioFragments = this.client.getFragments(currentAudioLevelID);

    let total = 0;
    let loaded = 0;
    let failed = 0;

    if (fragments) {
      const result = this.renderProgressBar(duration, this.progressCache, fragments, audioFragments ? 'download-video' : null);
      total += result.total;
      loaded += result.loaded;
      failed += result.failed;
    }

    if (audioFragments) {
      const result = this.renderProgressBar(duration, this.progressCacheAudio, audioFragments, fragments ? 'download-audio' : null);
      total += result.total;
      loaded += result.loaded;
      failed += result.failed;
    }

    this.loaded = loaded;
    this.failed = failed;
    this.total = total;
  }

  getFragmentCounts() {
    return {
      loaded: this.loaded,
      failed: this.failed,
      total: this.total,
    };
  }

  /**
   * The next video's banner, for its last 10 seconds when the next video plays by itself.
   */
  updateNextVideoBanner() {
    const duration = this.client.duration;
    if (!duration) {
      return;
    }
    const left = Math.ceil(duration - this.client.currentTime);
    if (this.client.options.autoplayNext && this.client.hasNextVideo() && left <= 10) {
      DOMElements.nextVideoBannerButton.style.display = '';
      DOMElements.nextVideoBannerButton.textContent = Localize.getMessage('player_nextvideoin', [left]);
      if (!this.hasShownNextVideo) {
        this.hasShownNextVideo = true;
        this.emit('show-next-video');
      }
    } else {
      DOMElements.nextVideoBannerButton.style.display = 'none';
      this.hasShownNextVideo = false;
    }
  }

  onProgressbarMouseMove(event) {
    const currentX = Math.min(Math.max(event.clientX - WebUtils.getOffsetLeft(DOMElements.progressContainer), 0), DOMElements.progressContainer.clientWidth);
    const totalWidth = DOMElements.progressContainer.clientWidth;

    const time = this.client.duration * currentX / totalWidth;

    DOMElements.seekPreviewVideo.style.bottom = '25px';
    DOMElements.seekPreviewText.innerText = StringUtils.formatTime(time);

    const maxWidth = Math.max(DOMElements.seekPreviewVideo.clientWidth, DOMElements.seekPreview.clientWidth);

    let nudgeAmount = 0;

    if (currentX < maxWidth / 2) {
      nudgeAmount = maxWidth / 2 - currentX;
    }

    if (currentX > totalWidth - maxWidth / 2) {
      nudgeAmount = (totalWidth - maxWidth / 2 - currentX);
    }

    DOMElements.seekPreview.style.left = (currentX + nudgeAmount) / totalWidth * 100 + '%';
    DOMElements.seekPreviewTip.style.left = currentX / totalWidth * 100 + '%';

    if (nudgeAmount) {
      DOMElements.seekPreviewTip.classList.add('detached');
    } else {
      DOMElements.seekPreviewTip.classList.remove('detached');
    }


    this.client.seekPreview(time);
  }

  onProgressbarMouseDown(event) {
    // check if left mouse button was pressed
    if (event.button !== 0) {
      return;
    }

    let shouldPlay = false;
    if (this.client.state.playing) {
      this.client.player.pause();
      shouldPlay = true;
    }

    this.isSeeking = true;
    this.client.savePosition();
    this.client.setSeekSave(false);

    DOMElements.progressContainer.classList.add('freeze');
    // we need an initial position for touchstart events, as mouse up has no offset x for iOS
    let initialPosition = Math.min(Math.max(event.clientX - WebUtils.getOffsetLeft(DOMElements.progressContainer), 0), DOMElements.progressContainer.clientWidth);

    let preciseSavedTime = null;
    let preciseSavedPosition = null;
    const shiftTime = (timeBarX) => {
      const totalWidth = DOMElements.progressContainer.clientWidth;
      if (totalWidth) {
        let newTime;
        if (preciseSavedPosition !== null) {
          newTime = preciseSavedTime + 60 * (timeBarX - preciseSavedPosition) / totalWidth;
        } else {
          newTime = this.client.duration * timeBarX / totalWidth;
        }
        this.client.currentTime = newTime;
        this.client.updateTime(newTime);
        DOMElements.currentProgress.style.width = Utils.clamp(newTime / this.client.duration, 0, 1) * 100 + '%';
      }
    };

    const onProgressbarMouseMove = (event) => {
      // No button held: it was let go outside the player, where neither mouseup nor
      // mouseleave may reach this frame. The drag ends where it was, without seeking:
      // every move went on seeking, and the next click played the video.
      if (event.type === 'mousemove' && event.buttons === 0) {
        endDrag(null);
        return;
      }
      this.hidePreview();
      const currentY = Math.min(Math.max(event.clientY - WebUtils.getOffsetTop(DOMElements.progressContainer), -100), 50);
      const currentX = Math.min(Math.max(event.clientX - WebUtils.getOffsetLeft(DOMElements.progressContainer), 0), DOMElements.progressContainer.clientWidth);
      const isExpanded = DOMElements.playerContainer.classList.contains('expanded');
      const offset = isExpanded ? 0 : 80;
      if ((this.preciseMode || preciseSavedPosition !== null) && currentY > 20) {
        preciseSavedTime = null;
        preciseSavedPosition = null;
        if (!this.keepPreciseModeOpen) {
          this.endPreciseMode();
        }
      } else if (preciseSavedPosition === null && currentY <= -10 - offset) {
        preciseSavedTime = this.client.currentTime;
        preciseSavedPosition = currentX;
        this.startPreciseMode();
      }

      initialPosition = NaN; // mouse up will fire after the move, we don't want to trigger the initial position in the event of iOS
      shiftTime(currentX);
    };

    // Ends the drag, at the release point of a mouseup (event) or where it was (null).
    let ended = false;
    const endDrag = (event, resume = true) => {
      // Once: a mouseup in the player reaches its listener and the document's.
      if (ended) return;
      ended = true;
      DOMElements.playerContainer.removeEventListener('mousemove', onProgressbarMouseMove);
      DOMElements.playerContainer.removeEventListener('touchmove', onProgressbarMouseMove);
      DOMElements.playerContainer.removeEventListener('mouseup', onProgressbarMouseUp);
      DOMElements.playerContainer.removeEventListener('mouseleave', onProgressbarMouseUp);
      DOMElements.playerContainer.removeEventListener('touchend', onProgressbarMouseUp);
      document.removeEventListener('mouseup', onProgressbarMouseUp);
      if (this.endDrag === endDrag) this.endDrag = null;
      if (!this.keepPreciseModeOpen) {
        this.endPreciseMode();
      }
      this.isSeeking = false;

      if (this.isMouseOverProgressbar) {
        this.showPreview();
      }

      let clickedX = event ? Math.min(Math.max(event.clientX - WebUtils.getOffsetLeft(DOMElements.progressContainer), 0), DOMElements.progressContainer.clientWidth) : NaN;

      if (event && isNaN(clickedX) && !isNaN(initialPosition)) {
        clickedX = initialPosition;
      }
      if (!isNaN(clickedX)) {
        shiftTime(clickedX);
      }
      this.client.setSeekSave(true);

      DOMElements.progressContainer.classList.remove('freeze');

      if (shouldPlay && resume) {
        this.client.player?.play();
      }
    };
    const onProgressbarMouseUp = (event) => endDrag(event);
    this.endDrag = endDrag;
    shiftTime(initialPosition);
    // Anywhere in this document: a drag keeps the mouse events in the frame it started in,
    // wherever the button is let go (FineTimeControls).
    document.addEventListener('mouseup', onProgressbarMouseUp);
    DOMElements.playerContainer.addEventListener('mouseup', onProgressbarMouseUp);
    DOMElements.playerContainer.addEventListener('touchend', onProgressbarMouseUp, {passive: true});
    DOMElements.playerContainer.addEventListener('mouseleave', onProgressbarMouseUp);
    DOMElements.playerContainer.addEventListener('mousemove', onProgressbarMouseMove);
    DOMElements.playerContainer.addEventListener('touchmove', onProgressbarMouseMove, {passive: true});
  }

  onProgressbarMouseLeave() {
    this.isMouseOverProgressbar = false;
    if (!this.isSeeking) {
      this.hidePreview();
    }
  }

  onProgressbarMouseEnter() {
    this.isMouseOverProgressbar = true;
    this.showPreview();
  }

  showPreview() {
    DOMElements.seekPreview.style.display = '';
    DOMElements.seekPreviewTip.style.display = '';
  }

  hidePreview() {
    DOMElements.seekPreview.style.display = 'none';
    DOMElements.seekPreviewTip.style.display = 'none';
  }

  /**
   * Puts a marker at a time on the bar, or hides it (null). The analyzers call
   * updateMarkers on every animation frame while they run: a marker's style is written
   * only when it moved or showed or hid.
   * @param {HTMLElement} marker
   * @param {?number} time - Seconds, or null for none.
   * @param {number} duration
   */
  placeMarker(marker, time, duration) {
    const left = time === null ? null : (time / duration * 100) + '%';
    this.markerPlaces ??= new Map();
    if (this.markerPlaces.has(marker) && this.markerPlaces.get(marker) === left) return;
    this.markerPlaces.set(marker, left);
    if (left === null) {
      marker.style.display = 'none';
    } else {
      marker.style.left = left;
      marker.style.display = '';
    }
  }

  updateMarkers() {
    const duration = this.client.duration;
    const pastSeeks = this.client.pastSeeks;
    this.placeMarker(this.seekMarker, pastSeeks.length ? pastSeeks[pastSeeks.length - 1] : null, duration);
    const pastUnseeks = this.client.pastUnseeks;
    this.placeMarker(this.unseekMarker, pastUnseeks.length ? pastUnseeks[pastUnseeks.length - 1] : null, duration);
    this.placeMarker(this.audioAnalyzerMarker, this.client.audioAnalyzer.getMarkerPosition(), duration);
    this.placeMarker(this.frameExtractorMarker, this.client.frameExtractor.getMarkerPosition(), duration);
  }
}
