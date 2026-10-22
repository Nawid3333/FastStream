// @ts-check
// @ts-ignore - sortable.mjs is vendored at build time (tools/sync-vendor.mjs), absent when CI type-checks.
import {Sortable} from '../modules/sortable.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {DOMElements} from './DOMElements.mjs';

/** @typedef {Element & {_toolSkipClick: boolean}} ToolElement */
export class ToolManager {
  constructor(client, interfaceController) {
    this.interfaceController = interfaceController;
    this.client = client;
    this.userIsReordering = false;
    this.specialReorderModeEnabled = false;
  }

  setupUI() {
    this.updateToolVisibility();
    /** @type {Element} */ (DOMElements.playerContainer).addEventListener('click', (e) => {
      this.stopReorderUI();
      /** @type {Element} */ (DOMElements.extraTools).classList.remove('visible');
    });

    const options = {
      // No reorder animation: everything in the player is instant.
      animation: 0,
      group: 'reorder',
      onStart: ()=>{
        this.userIsReordering = true;
        clearTimeout(this.reorderTimeout);
      },
      onEnd: (evt)=>{
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

    const tools = /** @type {ToolElement[]} */ (Array.from(/** @type {Element} */ (DOMElements.leftToolsContainer).children).concat(Array.from(/** @type {Element} */ (DOMElements.rightToolsContainer).children), Array.from(/** @type {Element} */ (DOMElements.extraTools).children)));

    // Only one tool's long-press can be pending at a time (each mousedown
    // clears any previous this.reorderTimeout), so a single shared mouseup
    // listener can track which element is waiting for its skipClick reset
    // instead of registering a near-identical listener per tool.
    /** @type {ToolElement | null} */
    let pendingSkipClickEl = null;
    /** @type {Element} */ (DOMElements.playerContainer).addEventListener('mouseup', (e) => {
      clearTimeout(this.reorderTimeout);
      if (pendingSkipClickEl) {
        const el = pendingSkipClickEl;
        pendingSkipClickEl = null;
        setTimeout(() => {
          el._toolSkipClick = false;
        }, 100);
      }
    });

    tools.forEach((el) => {
      el._toolSkipClick = false;
      const reorderMouseDown = (e) => {
        // check if left mouse button was pressed
        if (e.button !== 0) return;

        if (this.specialReorderModeEnabled) return;

        clearTimeout(this.reorderTimeout);
        this.reorderTimeout = setTimeout(() => {
          el._toolSkipClick = true;
          pendingSkipClickEl = el;
          this.startReorderUI();
        }, 800);
      };

      el.addEventListener('mousedown', (e) => {
        reorderMouseDown(e);
      });

      el.addEventListener('click', (e) => {
        if (this.specialReorderModeEnabled) {
          if (!el._toolSkipClick) this.stopReorderUI();
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
    /** @type {HTMLElement} */ (DOMElements.playinfo).style.display = this.client.player ? 'none' : '';

    if ((this.client.player && document.pictureInPictureEnabled) || this.interfaceController.shouldDoDocumentPip()) {
      /** @type {Element} */ (DOMElements.pip).classList.remove('hidden');
    } else {
      /** @type {Element} */ (DOMElements.pip).classList.add('hidden');
    }

    if (this.client.player) {
      /** @type {Element} */ (DOMElements.screenshot).classList.remove('hidden');
      /** @type {Element} */ (DOMElements.loopButton).classList.remove('hidden');
      /** @type {Element} */ (DOMElements.skipForwardButton).classList.remove('hidden');
      /** @type {Element} */ (DOMElements.skipBackwardButton).classList.remove('hidden');
    } else {
      /** @type {Element} */ (DOMElements.screenshot).classList.add('hidden');
      /** @type {Element} */ (DOMElements.loopButton).classList.add('hidden');
      /** @type {Element} */ (DOMElements.skipForwardButton).classList.add('hidden');
      /** @type {Element} */ (DOMElements.skipBackwardButton).classList.add('hidden');
    }

    if (this.client.player && !this.client.player.canSave().cantSave) {
      /** @type {Element} */ (DOMElements.download).classList.remove('hidden');
    } else {
      /** @type {Element} */ (DOMElements.download).classList.add('hidden');
    }

    // MPV button: only meaningful when the extension can talk to the native
    // host (extension context, MPV mode enabled) and a source is playing.
    if (this.client.player && this.client.source && EnvUtils.isExtension() && this.client.options.mpvMode) {
      /** @type {Element} */ (DOMElements.mpv).classList.remove('hidden');
    } else {
      /** @type {Element} */ (DOMElements.mpv).classList.add('hidden');
    }

    if (this.client.player && window.self !== window.top) {
      /** @type {Element} */ (DOMElements.windowedFullscreen).classList.remove('hidden');
    } else {
      /** @type {Element} */ (DOMElements.windowedFullscreen).classList.add('hidden');
    }

    if (this.client.hasPreviousVideo()) {
      /** @type {Element} */ (DOMElements.previousVideo).classList.remove('hidden');
    } else {
      /** @type {Element} */ (DOMElements.previousVideo).classList.add('hidden');
    }

    // The next button only with a next video; the autoplay switch always (his wish, 2026-10-11:
    // it went with the next button, and was never there where FastStream found no next link).
    /** @type {Element} */ (DOMElements.nextVideo).classList.toggle('hidden', !this.client.hasNextVideo());

    // The audio-track list's button: only where there is a track to choose (2026-10-10; it
    // opened the audio settings until they went).
    /** @type {Element} */ (DOMElements.audioTracksBtn).classList.toggle('hidden', !this.interfaceController.audioQualityChanger?.hasChoice);

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

    const leftToolPairs = [];
    const rightToolPairs = [];
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
      /** @type {Element} */ (DOMElements.leftToolsContainer).appendChild(element);
    }

    rightToolPairs.sort((a, b) => a[1].priority - b[1].priority);
    for (const [element] of rightToolPairs) {
      /** @type {Element} */ (DOMElements.rightToolsContainer).appendChild(element);
    }

    extraToolPairs.sort((a, b) => a[1].priority - b[1].priority);
    for (const [element] of extraToolPairs) {
      /** @type {Element} */ (DOMElements.extraTools).appendChild(element);
    }

    this.checkMoreTool();
  }

  checkMoreTool() {
    if (Array.from(/** @type {HTMLElement} */ (DOMElements.extraTools).children).some((el) => {
      return !el.classList.contains('hidden');
    })) {
      /** @type {HTMLButtonElement} */ (DOMElements.moreButton).classList.remove('hidden');
    } else {
      /** @type {HTMLButtonElement} */ (DOMElements.moreButton).classList.add('hidden');
      /** @type {HTMLElement} */ (DOMElements.extraTools).classList.remove('visible');
    }

    if (/** @type {HTMLElement} */ (DOMElements.leftToolsContainer).children.length === 0 && /** @type {HTMLElement} */ (DOMElements.rightToolsContainer).children.length === 0) {
      this.moveMoreTool(DOMElements.extraTools, DOMElements.rightToolsContainer);
    } else if (/** @type {HTMLElement} */ (DOMElements.extraTools).children.length === 0) {
      this.moveMoreTool(DOMElements.rightToolsContainer, DOMElements.extraTools);
      this.moveMoreTool(DOMElements.leftToolsContainer, DOMElements.extraTools);
    }
  }

  moveMoreTool(source, dest) {
    const more = Array.from(source.children).find((el) => el.dataset.tool === 'more');
    if (more) {
      more.remove();
      dest.appendChild(more);
    }
  }

  checkToolsAndSave() {
    this.checkMoreTool();

    Array.from(/** @type {HTMLElement} */ (DOMElements.leftToolsContainer).children).forEach((el, i) => {
      const tool = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.tool);
      this.client.options.toolSettings[tool].priority = (i + 1) * 100;
      this.client.options.toolSettings[tool].location = 'left';
    });

    Array.from(/** @type {HTMLElement} */ (DOMElements.rightToolsContainer).children).forEach((el, i) => {
      const tool = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.tool);
      this.client.options.toolSettings[tool].priority = (i + 1) * 100;
      this.client.options.toolSettings[tool].location = 'right';
    });

    Array.from(/** @type {HTMLElement} */ (DOMElements.extraTools).children).forEach((el, i) => {
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
    /** @type {HTMLElement} */ (DOMElements.rightToolsContainer).classList.add('reordering');
    /** @type {HTMLElement} */ (DOMElements.leftToolsContainer).classList.add('reordering');
    /** @type {HTMLElement} */ (DOMElements.extraTools).classList.add('reordering');

    if (EnvUtils.isMobile()) {
      this.sortableRight.option('disabled', false);
      this.sortableLeft.option('disabled', false);
      this.sortableExtra.option('disabled', false);
    }
  }

  stopReorderUI() {
    if (!this.specialReorderModeEnabled) return;
    this.specialReorderModeEnabled = false;
    /** @type {HTMLElement} */ (DOMElements.rightToolsContainer).classList.remove('reordering');
    /** @type {HTMLElement} */ (DOMElements.leftToolsContainer).classList.remove('reordering');
    /** @type {HTMLElement} */ (DOMElements.extraTools).classList.remove('reordering');

    if (EnvUtils.isMobile()) {
      this.sortableRight.option('disabled', true);
      this.sortableLeft.option('disabled', true);
      this.sortableExtra.option('disabled', true);
    }
  }
}
