import {SubtitleTrack} from '../SubtitleTrack.mjs';
import {VideoSource} from '../VideoSource.mjs';
import {PlayerModes} from '../enums/PlayerModes.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {Localize} from '../modules/Localize.mjs';
import {streamSaver} from '../modules/StreamSaver.mjs';
import {AlertPolyfill} from '../utils/AlertPolyfill.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {FastStreamArchiveUtils} from '../utils/FastStreamArchiveUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {URLUtils} from '../utils/URLUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';
import {StatusTypes} from './StatusManager.mjs';

export class SaveManager {
  constructor(client) {
    this.client = client;
    this.downloadURL = null;
    this.reuseDownloadURL = false;
    this.makingDownload = false;
    this.downloadCancel = null;
    this.pendingSave = null;
    // Manual override for the mpv anime/movie shader selection, cycled by
    // right-clicking the mpv button. null defers to the MPV Allowlist's
    // per-site @anime/@movie tag (see UrlMatchList.mjs / background.mjs).
    this.mpvContentType = null;
  }

  setupUI() {
    DOMElements.playerContainer.addEventListener('drop', this.onFileDrop.bind(this), false);

    DOMElements.download.addEventListener('click', this.saveVideo.bind(this));

    DOMElements.download.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.saveVideo(e, true);
    });

    WebUtils.setupTabIndex(DOMElements.download);

    DOMElements.mpv.addEventListener('click', this.openInMpv.bind(this));
    DOMElements.mpv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cycleMpvContentType();
    });
    WebUtils.setupTabIndex(DOMElements.mpv);
    this.updateMpvContentBadge();

    DOMElements.screenshot.addEventListener('click', this.saveScreenshot.bind(this));
    WebUtils.setupTabIndex(DOMElements.screenshot);
  }

  /**
   * Sends the currently playing source URL to mpv through the background's
   * native messaging bridge (MPV_OPEN -> com.faststream.mpv).
   * @return {Promise<void>}
   */
  async openInMpv() {
    if (!this.client.player || !this.client.source) {
      await AlertPolyfill.alert(Localize.getMessage('player_nosource_alert'), 'error');
      return;
    }

    const source = this.client.source;
    const headers = Object.entries(source.headers || {}).map(([name, value]) => {
      return {name, value};
    });

    this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_sending'), 'info');

    chrome.runtime.sendMessage({
      type: MessageTypes.MPV_OPEN,
      url: source.url,
      headers: headers,
      contentType: this.mpvContentType || undefined,
    }, (response) => {
      if (chrome.runtime.lastError) {
        this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_fail'), 'error', 3000);
        return;
      }
      if (response && response.ok) {
        this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_sent'), 'info', 2000);
        // mpv has the stream now, so stop playing it here too: otherwise both
        // players run at once and the user has to come back just to pause.
        if (this.client.options.mpvPausePage) {
          this.client.pause().catch(() => {});
        }
      } else {
        this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_fail'), 'error', 3000);
      }
    });
  }

  setStatusMessage(key, message, type, expiry) {
    this.client.interfaceController.setStatusMessage(key, message, type, expiry);
  }

  /**
   * Cycles the manual mpv content-type override: Unset -> Anime -> Movie ->
   * Unset. Right-click on the mpv button, since the button's main click
   * already does the "send to mpv" action.
   * @return {void}
   */
  cycleMpvContentType() {
    const order = [null, 'anime', 'movie'];
    const next = order[(order.indexOf(this.mpvContentType) + 1) % order.length];
    this.mpvContentType = next;
    this.updateMpvContentBadge();
  }

  /**
   * Clears the manual override back to Unset (deferring to the MPV
   * Allowlist's per-site tag) for a newly loaded video.
   * @return {void}
   */
  resetMpvContentType() {
    this.mpvContentType = null;
    this.updateMpvContentBadge();
  }

  /**
   * Reflects the current mpvContentType on the mpv button: a small A/M
   * badge, and a tooltip naming the active state.
   * @return {void}
   */
  updateMpvContentBadge() {
    const banner = DOMElements.mpvContentBanner;
    if (this.mpvContentType === 'anime') {
      if (banner) {
        banner.textContent = 'A';
        banner.style.display = '';
      }
      WebUtils.setLabels(DOMElements.mpv, Localize.getMessage('player_mpv_content_anime'));
    } else if (this.mpvContentType === 'movie') {
      if (banner) {
        banner.textContent = 'M';
        banner.style.display = '';
      }
      WebUtils.setLabels(DOMElements.mpv, Localize.getMessage('player_mpv_content_movie'));
    } else {
      if (banner) {
        banner.textContent = '';
        banner.style.display = 'none';
      }
      WebUtils.setLabels(DOMElements.mpv, Localize.getMessage('player_mpv_content_unset'));
    }
  }

  async saveScreenshot() {
    if (!this.client.player) {
      await AlertPolyfill.alert(Localize.getMessage('player_nosource_alert'), 'error');
      return;
    }

    const suggestedName = (this.client.mediaInfo?.name || 'video').replaceAll(' ', '_') + '@' + StringUtils.formatTime(this.client.currentTime);
    const name = EnvUtils.isIncognito() ? suggestedName : await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName);

    if (!name) {
      return;
    }

    this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_saving'), 'info');
    try {
      const video = this.client.player.getVideo();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const url = canvas.toDataURL('image/png'); // For some reason this is faster than async toBlob
      await Utils.downloadURL(url, name + '.png');
      this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_saved'), 'info', 1000);
    } catch (e) {
      console.error(e);
      this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_fail'), 'error', 2000);
    }
  }

  async saveVideo(e, allowPartial = false) {
    if (!this.client.player) {
      await AlertPolyfill.alert(Localize.getMessage('player_nosource_alert'), 'error');
      return;
    }

    if (this.makingDownload) {
      if (this.downloadCancel) {
        this.downloadCancel();
        DOMElements.saveNotifBanner.style.color = 'gold';
        this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_cancelling'), 'info');
      } else {
        await AlertPolyfill.alert(Localize.getMessage('player_savevideo_inprogress_alert'), 'error');
      }
      return;
    }

    const doPartial = e.altKey || allowPartial;
    const doDump = e.shiftKey;
    const player = this.client.player;

    const {canSave, isComplete, canStream, extension} = player.canSave();
    const saveExtension = extension || 'mp4';

    if (!canSave && !doDump) {
      await AlertPolyfill.alert(Localize.getMessage('player_savevideo_unsupported'), 'error');
      return;
    }

    if (doPartial && !isComplete) {
      const res = await AlertPolyfill.confirm(Localize.getMessage('player_savevideo_partial_confirm'), 'warning');
      if (!res) {
        return;
      }
    }

    if (!doPartial && !isComplete && EnvUtils.isIncognito()) {
      const res = await AlertPolyfill.confirm(Localize.getMessage('player_savevideo_incognito_confirm'), 'warning');
      if (!res) {
        return;
      }
    }

    // Incognito mode always opens file picker anyways
    const shouldAskForName = !EnvUtils.isIncognito();
    const suggestedName = (this.client.mediaInfo?.name || 'video').replaceAll(' ', '_');

    if (doDump) {
      const name = shouldAskForName ? await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName) : suggestedName;
      if (!name) {
        return;
      }
      this.dumpBuffer(name);
      return;
    }

    let url;
    let filestream;
    let name;
    if (canStream || EnvUtils.isChrome()) {
      name = shouldAskForName ? await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName) : suggestedName;
      if (!name) {
        return;
      }
    }

    if (canStream) {
      if (!name) {
        return;
      }
      filestream = streamSaver.createWriteStream(name + '.' + saveExtension);
    }

    if (this.reuseDownloadURL && this.downloadURL && isComplete) {
      url = this.downloadURL;
    } else {
      this.reuseDownloadURL = isComplete;
      let result;
      this.makingDownload = true;
      this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_start'), 'info');
      DOMElements.saveNotifBanner.style.display = '';
      DOMElements.saveNotifBanner.style.color = '';
      try {
        const start = performance.now();
        this.pendingSave = player.saveVideo({
          onProgress: (progress) => {
            this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_progress', [Math.floor(progress * 100)]), 'info');
          },
          registerCancel: (cancel) => {
            // Multiple layers (the player itself, and any muxer it hands
            // off to) each register their own cancel callback. Compose
            // rather than overwrite, or only the last one registered would
            // ever run.
            const previousCancel = this.downloadCancel;
            this.downloadCancel = () => {
              if (previousCancel) previousCancel();
              cancel();
            };
          },
          filestream,
          partialSave: doPartial,
        });
        result = await this.pendingSave;
        this.pendingSave = null;
        const end = performance.now();
        console.log('Save took ' + (end - start) / 1000 + 's');
      } catch (e) {
        console.error(e);
        this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_fail'), 'error', 2000);
        this.makingDownload = false;
        this.downloadCancel = null;
        this.pendingSave = null;
        DOMElements.saveNotifBanner.style.display = 'none';

        if (e.message === 'Cancelled') {
          console.error(e);
          this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_cancelled'), 'info', 2000);
        } else {
          if (await AlertPolyfill.confirm(Localize.getMessage('player_savevideo_failed_ask_archive'), 'error')) {
            if (!name) {
              name = shouldAskForName ? await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName) : suggestedName;
            }
            if (name) {
              this.dumpBuffer(name);
            }
          }
        }
        return;
      }

      DOMElements.saveNotifBanner.style.display = 'none';
      this.downloadCancel = null;
      this.makingDownload = false;


      this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_complete'), 'info', 2000);

      if (!canStream) {
        url = URL.createObjectURL(result.blob);
      }

      // Any still-referenced previous url stays alive: the 10s sweep below
      // reaps replaced urls, and revoking here would kill the backing store
      // of an in-flight download from a re-save on the same source.
      this.downloadURL = url;
    }

    if (!canStream) {
      if (!name) {
        name = shouldAskForName ? await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName) : suggestedName;
      }
      if (!name) {
        URL.revokeObjectURL(this.downloadURL);
        this.downloadURL = null;
        this.reuseDownloadURL = false;
        return;
      }

      // The old sweep revoked this.downloadURL unconditionally 10s after
      // the save finished - mid-transfer for anything whose download takes
      // longer than that, which killed the backing blob and made the save
      // fail silently. It now only reaps a url once it has been REPLACED
      // by a newer save (or nulled on a cancel/name-less exit).
      setTimeout(() => {
        if (this.downloadURL === url) return;

        if (url) {
          URL.revokeObjectURL(url);
          this.reuseDownloadURL = false;
        }
      }, 10000);
      await Utils.downloadURL(url, name + '.' + saveExtension);
    }
  }

  async dumpBuffer(name) {
    const entries = this.client.downloadManager.getCompletedEntries();
    const filestream = streamSaver.createWriteStream(name + '.fsa');
    try {
      await FastStreamArchiveUtils.writeFSAToStream(filestream, this.client.player, entries, (progress)=>{
        this.setStatusMessage('save-video', Localize.getMessage('player_archiver_progress', [Math.floor(progress * 100)]), 'info');
      });

      this.setStatusMessage('save-video', Localize.getMessage('player_archiver_saved'), 'info', 2000);
    } catch (e) {
      console.error(e);
      this.setStatusMessage('save-video', 'Unreachable Error', 'error', 2000);
      AlertPolyfill.errorSendToDeveloper(e);
    }
  }

  async onFileDrop(e) {
    e.stopPropagation();
    e.preventDefault();

    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length === 0) {
      return;
    }
    const captions = [];
    const audioFormats = [
      'mp3',
      'wav',
      'm4a',
      'm4r',
      'mkv',
      'webm',
    ];

    const subtitleFormats = [
      'vtt',
      'srt',
      'xml',
    ];

    let newSource = null;
    let newEntries = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = URLUtils.get_url_extension(file.name);

      if (ext === 'json') {
        const fsprofile = await file.text();
        const data = JSON.parse(fsprofile);

        if (data?.type === 'audioProfile') {
          this.client.audioConfigManager.loadProfileFile(data);
        }
      } else if (subtitleFormats.includes(ext)) {
        captions.push({
          url: window.URL.createObjectURL(file),
          name: file.name.substring(0, file.name.length - 4),
        });
      } else if (audioFormats.includes(ext)) {
        newSource = new VideoSource(window.URL.createObjectURL(file), {}, PlayerModes.DIRECT);
        newSource.identifier = file.name + 'size' + file.size;
      } else if (URLUtils.getModeFromExtension(ext)) {
        let mode = URLUtils.getModeFromExtension(ext);
        if (mode === PlayerModes.ACCELERATED_MP4) {
          mode = PlayerModes.DIRECT;
        }
        newSource = new VideoSource(window.URL.createObjectURL(file), {}, mode);
        newSource.identifier = file.name + 'size' + file.size;
      } else if (ext === 'fsa') {
        const buffer = await RequestUtils.httpGetLarge(window.URL.createObjectURL(file));
        try {
          const {source, entries, currentLevel, currentAudioLevel} = await FastStreamArchiveUtils.parseFSA(buffer, (progress)=>{
            this.setStatusMessage('save-video', Localize.getMessage('player_archive_loading', [Math.floor(progress * 100)]), 'info');
          }, this.client.downloadManager);

          newEntries = entries;

          newSource = new VideoSource(source.url, null, source.mode);
          newSource.identifier = source.identifier;
          newSource.headers = source.headers;
          newSource.loadedFromArchive = true;
          newSource.defaultLevelInfo = {
            level: currentLevel,
            audioLevel: currentAudioLevel,
          };

          this.setStatusMessage('save-video', Localize.getMessage('player_archive_loaded'), 'info', 2000);
        } catch (e) {
          console.error(e);
          this.setStatusMessage('save-video', Localize.getMessage('player_archive_fail'), 'error', 2000);
        }
      }
    }

    if (newSource) {
      if (newEntries) {
        this.client.downloadManager.resetOverride(true);
        this.client.downloadManager.setEntries(newEntries);
      }

      try {
        await this.client.addSource(newSource, true);
      } catch (e) {
        console.error(e);
      }

      if (newEntries) {
        this.client.downloadManager.resetOverride(false);
      }
    }

    (await Promise.all(captions.map(async (file) => {
      const track = new SubtitleTrack(file.name);
      await track.loadURL(file.url);
      return track;
    }))).forEach((track) => {
      const returnedTrack = this.client.loadSubtitleTrack(track);
      this.client.interfaceController.subtitlesManager.activateTrack(returnedTrack);
    });

    this.client.play();
  }

  reset() {
    this.reuseDownloadURL = false;
    if (this.downloadURL) {
      URL.revokeObjectURL(this.downloadURL);
    }
    this.downloadURL = null;

    // Second line of defense: the caller (FastStreamClient.resetPlayer)
    // should already have canceled and awaited any in-flight save before
    // reaching this point. Clear the flags anyway so a save that somehow
    // wasn't canceled first can't leave the Save button permanently stuck.
    this.makingDownload = false;
    this.downloadCancel = null;
    this.pendingSave = null;
  }

  destroy() {
    if (this.downloadURL) {
      URL.revokeObjectURL(this.downloadURL);
      this.downloadURL = null;
    }
    this.makingDownload = false;
    this.downloadCancel = null;
    this.pendingSave = null;
  }
}
