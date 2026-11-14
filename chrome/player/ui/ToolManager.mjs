// @ts-check
import {Sortable} from '../modules/sortable.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {DOMElements} from './DOMElements.mjs';
import {MediaKeys} from './MediaKeys.mjs';
import {PressTracker} from './PressTracker.mjs';

/** @typedef {import('../options/defaults/ToolSettings.mjs').ToolSetting} ToolSetting */
export class ToolManager {
  /**
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client
   * @param {import('./InterfaceController.mjs').InterfaceController} interfaceController
   */
  constructor(client, interfaceController) {
    this.interfaceController = interfaceController;
    this.client = client;
    this.mediaKeys = new MediaKeys(client);
    this.userIsReordering = false;
    this.specialReorderModeEnabled = false;
  }

  setupUI() {
    this.updateToolVisibility();
    DOMElements.playerContainer.addEventListener('click', (e) => {
      this.stopReorderUI();
      DOMElements.extraTools.classList.remove('visible');
    });

    const options = {
      // No reorder animation: everything in the player is instant.
      animation: 0,
      group: 'reorder',
      onStart: ()=>{
        this.userIsReordering = true;
        clearTimeout(this.reorderTimeout);
      },
      onEnd: (/** @type {Event} */ evt)=>{
        this.userIsReordering = false;
        this.checkToolsAndSave();
      },
      filter: '.menu_container, .rate_menu_container, .fluid_control_volume_container',
      preventOnFilter: false,
    };
    this.sortableRight = Sortable.create(DOMElements.rightToolsContainer, options);
    this.sortableLeft = Sortable.create(DOMElements.leftToolsContainer, options);
    this.sortableExtra = Sortable.create(DOMElements.extraTools, options);

    if (EnvUtils.isMobile()) {
      this.sortableRight.option('disabled', true);
      this.sortableLeft.option('disabled', true);
      this.sortableExtra.option('disabled', true);
    }

    const tools = /** @type {HTMLElement[]} */ (Array.from(DOMElements.leftToolsContainer.children).concat(Array.from(DOMElements.rightToolsContainer.children), Array.from(DOMElements.extraTools.children)));

    tools.forEach((el) => {
      // A tool held 800 ms starts the reordering. It ended only on a mouseup in the player:
      // with the window switched while a tool was held, the reordering began after the button
      // had been let go. The press ends however it ends now (PressTracker), and the release of
      // a long press opens no tool and leaves the reordering on: its click is kept from them,
      // where a flag set aside for 100 ms after the mouseup let the click through or not.
      el.addEventListener('mousedown', (e) => {
        // check if left mouse button was pressed
        if (e.button !== 0) return;

        if (this.specialReorderModeEnabled) return;

        clearTimeout(this.reorderTimeout);
        let longPress = false;
        this.reorderTimeout = setTimeout(() => {
          longPress = true;
          this.startReorderUI();
        }, 800);
        PressTracker.follow(e, {end: (release) => {
          clearTimeout(this.reorderTimeout);
          if (longPress) {
            PressTracker.swallowClick(release ?? e);
          }
        }});
      });

      el.addEventListener('click', (e) => {
        if (this.specialReorderModeEnabled) {
          this.stopReorderUI();
          e.stopPropagation();
        }
      }, true);

      el.addEventListener('focus', (e)=>{
        if (this.specialReorderModeEnabled) {
          e.stopPropagation();
        }
      }, true);
    });
  }

  canHideControls() {
    return !this.specialReorderModeEnabled && !this.userIsReordering;
  }

  updateToolVisibility() {
    DOMElements.playinfo.style.display = this.client.player ? 'none' : '';

    if ((this.client.player && document.pictureInPictureEnabled) || this.interfaceController.shouldDoDocumentPip()) {
      DOMElements.pip.classList.remove('hidden');
    } else {
      DOMElements.pip.classList.add('hidden');
    }

    if (this.client.player) {
      DOMElements.screenshot.classList.remove('hidden');
      DOMElements.loopButton.classList.remove('hidden');
      DOMElements.skipForwardButton.classList.remove('hidden');
      DOMElements.skipBackwardButton.classList.remove('hidden');
    } else {
      DOMElements.screenshot.classList.add('hidden');
      DOMElements.loopButton.classList.add('hidden');
      DOMElements.skipForwardButton.classList.add('hidden');
      DOMElements.skipBackwardButton.classList.add('hidden');
    }

    if (this.client.player && !this.client.player.canSave().cantSave) {
      DOMElements.download.classList.remove('hidden');
    } else {
      DOMElements.download.classList.add('hidden');
    }

    // MPV button: only meaningful when the extension can talk to the native
    // host (extension context, MPV mode enabled) and a source is playing.
    if (this.client.player && this.client.source && EnvUtils.isExtension() && this.client.options.mpvMode) {
      DOMElements.mpv.classList.remove('hidden');
    } else {
      DOMElements.mpv.classList.add('hidden');
    }

    if (this.client.player && window.self !== window.top) {
      DOMElements.windowedFullscreen.classList.remove('hidden');
    } else {
      DOMElements.windowedFullscreen.classList.add('hidden');
    }

    if (this.client.hasPreviousVideo()) {
      DOMElements.previousVideo.classList.remove('hidden');
    } else {
      DOMElements.previousVideo.classList.add('hidden');
    }

    // The next button only with a next video; the autoplay switch always (his wish, 2026-10-11:
    // it went with the next button, and was never there where FastStream found no next link).
    DOMElements.nextVideo.classList.toggle('hidden', !this.client.hasNextVideo());
    // The keyboard's next- and previous-track keys go where those buttons go.
    this.mediaKeys.update();

    // The audio-track list's button: only where there is a track to choose (2026-10-10; it
    // opened the audio settings until they went).
    DOMElements.audioTracksBtn.classList.toggle('hidden', !this.interfaceController.audioQualityChanger?.hasChoice);

    const toolSettings = this.client.options.toolSettings;
    const toolElements = /** @type {Record<string, HTMLElement>} */ (/** @type {unknown} */ ({
      playpause: DOMElements.playPauseButton,
      volume: DOMElements.volumeBlock,
      duration: DOMElements.duration,
      next: DOMElements.nextVideo,
      autoplay: DOMElements.autoplaySwitch,
      previous: DOMElements.previousVideo,
      pip: DOMElements.pip,
      screenshot: DOMElements.screenshot,
      download: DOMElements.download,
      mpv: DOMElements.mpv,
      playrate: DOMElements.playbackRate,
      fullscreen: DOMElements.fullscreen,
      windowedfs: DOMElements.windowedFullscreen,
      subtitles: DOMElements.subtitles,
      audioconfig: DOMElements.audioTracksBtn,
      sources: DOMElements.linkButton,
      settings: DOMElements.settingsButton,
      quality: DOMElements.videoSource,
      languages: DOMElements.languageButton,
      loop: DOMElements.loopButton,
      more: DOMElements.moreButton,
      forward: DOMElements.skipForwardButton,
      backward: DOMElements.skipBackwardButton,
    }));

    if (this.specialReorderModeEnabled) {
      return;
    }

    /** @type {Array<[HTMLElement, ToolSetting]>} */
    const leftToolPairs = [];
    /** @type {Array<[HTMLElement, ToolSetting]>} */
    const rightToolPairs = [];
    /** @type {Array<[HTMLElement, ToolSetting]>} */
    const extraToolPairs = [];

    for (const [tool, element] of Object.entries(toolElements)) {
      element.dataset.tool = tool;
      const location = toolSettings[tool].location;
      if (location === 'left') {
        leftToolPairs.push([element, toolSettings[tool]]);
      } else if (location === 'right') {
        rightToolPairs.push([element, toolSettings[tool]]);
      } else if (location === 'extra') {
        extraToolPairs.push([element, toolSettings[tool]]);
      } else { // Legacy
        if (toolSettings[tool].enabled) {
          rightToolPairs.push([element, toolSettings[tool]]);
        } else {
          extraToolPairs.push([element, toolSettings[tool]]);
        }
      }
      element.remove();
    }

    leftToolPairs.sort((a, b) => a[1].priority - b[1].priority);
    for (const [element] of leftToolPairs) {
      DOMElements.leftToolsContainer.appendChild(element);
    }

    rightToolPairs.sort((a, b) => a[1].priority - b[1].priority);
    for (const [element] of rightToolPairs) {
      DOMElements.rightToolsContainer.appendChild(element);
    }

    extraToolPairs.sort((a, b) => a[1].priority - b[1].priority);
    for (const [element] of extraToolPairs) {
      DOMElements.extraTools.appendChild(element);
    }

    this.checkMoreTool();
  }

  checkMoreTool() {
    if (Array.from(DOMElements.extraTools.children).some((el) => {
      return !el.classList.contains('hidden');
    })) {
      DOMElements.moreButton.classList.remove('hidden');
    } else {
      DOMElements.moreButton.classList.add('hidden');
      DOMElements.extraTools.classList.remove('visible');
    }

    if (DOMElements.leftToolsContainer.children.length === 0 && DOMElements.rightToolsContainer.children.length === 0) {
      this.moveMoreTool(DOMElements.extraTools, DOMElements.rightToolsContainer);
    } else if (DOMElements.extraTools.children.length === 0) {
      this.moveMoreTool(DOMElements.rightToolsContainer, DOMElements.extraTools);
      this.moveMoreTool(DOMElements.leftToolsContainer, DOMElements.extraTools);
    }
  }

  /**
   * Moves the "more" tool from one tool bar to another.
   * @param {HTMLElement} source - The tool bar it may be in.
   * @param {HTMLElement} dest - The tool bar it goes to.
   */
  moveMoreTool(source, dest) {
    const more = Array.from(source.children).find((el) => /** @type {HTMLElement} */ (el).dataset.tool === 'more');
    if (more) {
      more.remove();
      dest.appendChild(more);
    }
  }

  checkToolsAndSave() {
    this.checkMoreTool();

    Array.from(DOMElements.leftToolsContainer.children).forEach((el, i) => {
      const tool = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.tool);
      this.client.options.toolSettings[tool].priority = (i + 1) * 100;
      this.client.options.toolSettings[tool].location = 'left';
    });

    Array.from(DOMElements.rightToolsContainer.children).forEach((el, i) => {
      const tool = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.tool);
      this.client.options.toolSettings[tool].priority = (i + 1) * 100;
      this.client.options.toolSettings[tool].location = 'right';
    });

    Array.from(DOMElements.extraTools.children).forEach((el, i) => {
      const tool = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.tool);
      this.client.options.toolSettings[tool].priority = (i + 1) * 100;
      this.client.options.toolSettings[tool].location = 'extra';
    });

    Utils.setConfig('toolSettings', JSON.stringify(this.client.options.toolSettings));
  }

  startReorderUI() {
    if (this.specialReorderModeEnabled) return;
    this.interfaceController.closeAllMenus();
    this.specialReorderModeEnabled = true;
    DOMElements.rightToolsContainer.classList.add('reordering');
    DOMElements.leftToolsContainer.classList.add('reordering');
    DOMElements.extraTools.classList.add('reordering');

    if (EnvUtils.isMobile()) {
      this.sortableRight.option('disabled', false);
      this.sortableLeft.option('disabled', false);
      this.sortableExtra.option('disabled', false);
    }
  }

  stopReorderUI() {
    if (!this.specialReorderModeEnabled) return;
    this.specialReorderModeEnabled = false;
    DOMElements.rightToolsContainer.classList.remove('reordering');
    DOMElements.leftToolsContainer.classList.remove('reordering');
    DOMElements.extraTools.classList.remove('reordering');

    if (EnvUtils.isMobile()) {
      this.sortableRight.option('disabled', true);
      this.sortableLeft.option('disabled', true);
      this.sortableExtra.option('disabled', true);
    }
  }
}
