import {Localize} from '../../modules/Localize.mjs';
import {EventEmitter} from '../../modules/eventemitter.mjs';
import {WebVTT} from '../../modules/vtt.mjs';
import {AlertPolyfill} from '../../utils/AlertPolyfill.mjs';
import {SubtitleSyncUtils} from '../../utils/SubtitleSyncUtils.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';
import {DOMElements} from '../DOMElements.mjs';

export class SubtitleSyncer extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.trackToSync = null;
    this.renderHandle = this.renderTracks.bind(this);
    this.onOpenHandle = this.onOpen.bind(this);
    this.onCloseHandle = this.onClose.bind(this);

    this.setup();
  }

  shiftSubtitles(delta) {
    if (!this.started) return;
    this.trackToSync.shift(delta);
    this.client.interfaceController.subtitlesManager.renderSubtitles();
    // There is no onVideoTimeUpdate() here (it moved to FineTimeControls long
    // ago), so this used to throw a TypeError on every ShiftSubtitles key.
    // The timeline redraws on its own; only the cues in view are stale.
    this.lastUpdate = 0;
    this.showShift();
  }

  // The track's total shift, so the tool says where the subtitles stand
  // instead of only "drag subtitles to resync".
  showShift() {
    const shift = SubtitleSyncUtils.formatShift(this.trackToSync.shiftTotal || 0);
    this.client.interfaceController.setStatusMessage('subtitles', Localize.getMessage('player_subtitlesmenu_shifttool_message', [shift]), 'info', 2000);
  }

  setup() {
    this.ui = {};

    this.ui.timelineTrack = WebUtils.create('div', '', 'timeline_track');

    // track line is grabbable
    let isGrabbingTrack = false;
    let grabStartTrack = 0;
    let grabbedCue = null;
    let grabbedEdge = null;


    this.ui.timelineTrack.addEventListener('mousedown', (e) => {
      // Left button only, as the time ticks do: a right-click opens the
      // context menu, which swallows the mouseup, and the track then followed
      // the pointer with no button held.
      if (e.button !== 0) return;
      isGrabbingTrack = true;
      grabStartTrack = e.clientX;
      if (window.subEditMode && !e.shiftKey) {
        const grabbed = this.trackElements.find((el) => {
          const rect = el.element.getBoundingClientRect();
          return e.clientX >= rect.left && e.clientX <= rect.right;
        }) || null;
        // check if grabbing right edge to resize cue
        if (grabbed) {
          const rect = grabbed.element.getBoundingClientRect();
          if (e.clientX >= rect.right - 5 && e.clientX <= rect.right + 5) {
            grabbedEdge = 'right';
          } else {
            grabbedEdge = null;
          }

          grabbedCue = grabbed.cue;
        } else {
          grabbedCue = null;
        }
      } else {
        grabbedCue = null;
        grabbedEdge = null;
      }
    });

    // double click to edit
    this.ui.timelineTrack.addEventListener('dblclick', (e) => {
      if (!window.subEditMode) return;
      const time = this.client.interfaceController.fineTimeControls.mousePositionToTime(e.clientX);
      const cue = this.trackToSync.cues.find((c) => {
        return time >= c.startTime && time <= c.endTime;
      });
      if (cue) {
        AlertPolyfill.prompt(Localize.getMessage('player_subtitlesmenu_resynctool_edit'), cue.text).then((newText) => {
          // A cancelled prompt gives undefined, which removed the cue like emptied text.
          if (newText === undefined || newText === null) {
            return;
          }
          if (newText) {
            cue.text = newText;
            cue.dom2 = null; // reset cached DOM tree so it will be regenerated with new text
            cue.dom = null; // reset cached DOM tree so it will be regenerated with new text
            // update element
            const el = this.trackElements.find((el) => el.cue === cue);
            if (el) {
              el.element.replaceChildren();
              if (!cue.dom2) {
                cue.dom2 = WebVTT.convertCueToDOMTree(window, cue.text);
              }
              el.element.appendChild(cue.dom2);
              el.element.title = cue.text;
            }
          } else {
            // if text is empty, remove cue
            const index = this.trackToSync.cues.indexOf(cue);
            if (index !== -1) {
              this.trackToSync.cues.splice(index, 1);
            }
          }
        });
      } else {
        // create new cue at this time with default duration of 2 seconds
        const newCue = new VTTCue(time, time + 2, 'New subtitle');
        this.trackToSync.cues.push(newCue);
        // sort cues by start time
        this.trackToSync.cues.sort((a, b) => a.startTime - b.startTime);
        this.client.interfaceController.subtitlesManager.renderSubtitles();
        AlertPolyfill.prompt(Localize.getMessage('player_subtitlesmenu_resynctool_edit'), newCue.text).then((newText) => {
          if (newText) {
            newCue.text = newText;
            newCue.dom2 = null; // reset cached DOM tree so it will be regenerated with new text
            newCue.dom = null; // reset cached DOM tree so it will be regenerated with new text
            const el = this.trackElements.find((el) => el.cue === newCue);
            if (el) {
              el.element.replaceChildren();
              if (!newCue.dom2) {
                newCue.dom2 = WebVTT.convertCueToDOMTree(window, newCue.text);
              }
              el.element.appendChild(newCue.dom2);
              el.element.title = newCue.text;
            }
            this.client.interfaceController.subtitlesManager.renderSubtitles();
          } else {
            // Cancelled, or emptied: no new cue, rather than one reading "New subtitle".
            const index = this.trackToSync.cues.indexOf(newCue);
            if (index !== -1) {
              this.trackToSync.cues.splice(index, 1);
            }
          }
        });
      }
    });

    const clearGrabbing = () => {
      // if cue was grabbed then resort
      if (grabbedCue) {
        this.trackToSync.cues.sort((a, b) => a.startTime - b.startTime);
      }

      isGrabbingTrack = false;
      grabbedCue = null;
      grabbedEdge = null;
    };

    DOMElements.playerContainer.addEventListener('mouseup', clearGrabbing);

    DOMElements.playerContainer.addEventListener('mouseleave', clearGrabbing);

    DOMElements.playerContainer.addEventListener('mousemove', (e) => {
      if (!this.client.player) return;
      const video = this.client.player.getVideo();
      if (isGrabbingTrack) {
        const delta = e.clientX - grabStartTrack;
        grabStartTrack = e.clientX;
        const amount = delta / this.ui.timelineTrack.clientWidth * video.duration;
        if (grabbedCue) {
          if (grabbedEdge === 'right') {
            grabbedCue.endTime += amount;
            // update element
            const el = this.trackElements.find((el) => el.cue === grabbedCue);
            if (el) {
              el.element.style.width = (grabbedCue.endTime - grabbedCue.startTime) / video.duration * 100 + '%';
            }
          } else {
            this.trackToSync.shiftAfter(grabbedCue, amount);
          }
        } else {
          if (window.subEditMode) return;
          this.trackToSync.shift(amount);
          this.showShift();
        }
        // cues dragged into view show at once, not up to 500 ms later
        this.lastUpdate = 0;
        this.client.interfaceController.subtitlesManager.renderSubtitles();
      }
    });
  }

  toggleTrack(track, removeOnly = false) {
    if (this.started && this.trackToSync === track) {
      const fineTimeControls = this.client.interfaceController.fineTimeControls;
      if (!fineTimeControls.isStateActive(this.onOpenHandle)) {
        fineTimeControls.prioritizeState(this.onOpenHandle);
        return;
      }

      this.trackToSync = null;
      this.stop();
    } else if (!removeOnly) {
      this.trackToSync = track;
      this.start();
    }

    return this.trackToSync;
  }

  async start() {
    const video = this.client.currentVideo;
    if (this.started || !video) return;
    this.started = true;

    if (!this.ui) {
      this.setup();
    }

    this.lastUpdate = 0;
    this.trackElements = [];
    this.ui.timelineTrack.replaceChildren();

    const fineTimeControls = this.client.interfaceController.fineTimeControls;
    fineTimeControls.pushState(this.onOpenHandle, this.onCloseHandle);
  }

  async stop() {
    if (!this.started) return;
    this.started = false;

    const fineTimeControls = this.client.interfaceController.fineTimeControls;
    fineTimeControls.removeState(this.onOpenHandle);
  }

  onOpen() {
    const fineTimeControls = this.client.interfaceController.fineTimeControls;
    fineTimeControls.on('render', this.renderHandle);
    fineTimeControls.ui.timelineTrackContainer.appendChild(this.ui.timelineTrack);
    fineTimeControls.ui.timelineAudio.style.height = '22px';
    fineTimeControls.shouldRenderVAD(true);

    this.client.interfaceController.setStatusMessage('subtitles', Localize.getMessage('player_subtitlesmenu_resynctool_instructions'), 'info', 5000);
  }

  onClose() {
    const fineTimeControls = this.client.interfaceController.fineTimeControls;
    fineTimeControls.off('render', this.renderHandle);
    fineTimeControls.ui.timelineAudio.style.height = '';
    this.ui.timelineTrack.remove();
    fineTimeControls.shouldRenderVAD(false);

    this.client.interfaceController.setStatusMessage('subtitles');
  }

  renderTracks(minTime, maxTime) {
    if (!this.started || !this.client.player) return;

    const video = this.client.player.getVideo();


    const now = Date.now();
    if (now - this.lastUpdate >= 500) {
      this.lastUpdate = now;

      // `||` here kept every cue (all of them start before maxTime or end
      // after minTime), so the whole track sat in the DOM and each cue was
      // repositioned on every frame.
      this.visibleCues = SubtitleSyncUtils.cuesInRange(this.trackToSync.cues, minTime, maxTime);
    }


    this.trackElements = this.trackElements.filter((el) => {
      if (!this.visibleCues.includes(el.cue)) {
        el.element.remove();
        return false;
      } else {
        el.element.style.left = el.cue.startTime / video.duration * 100 + '%';
      }
      return true;
    });

    this.visibleCues.forEach((cue) => {
      if (cue.text.length === 0) return;
      if (this.trackElements.find((el) => el.cue === cue)) return;

      const el = WebUtils.create('div', '', 'timeline_track_cue');
      el.style.left = cue.startTime / video.duration * 100 + '%';
      el.style.width = (cue.endTime - cue.startTime) / video.duration * 100 + '%';
      if (!cue.dom2) {
        cue.dom2 = WebVTT.convertCueToDOMTree(window, cue.text);
      }
      el.appendChild(cue.dom2);
      el.title = cue.text;
      this.ui.timelineTrack.appendChild(el);

      this.trackElements.push({
        cue,
        element: el,
      });
    });
  }
}
