import {SubtitleTrack} from '../SubtitleTrack.mjs';
import {VideoSource} from '../VideoSource.mjs';
import {PlayerModes} from '../enums/PlayerModes.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {Localize} from '../modules/Localize.mjs';
import {streamSaver} from '../modules/StreamSaver.mjs';
import {AlertPolyfill} from '../utils/AlertPolyfill.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {FastStreamArchiveUtils} from '../utils/FastStreamArchiveUtils.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {SubtitleUtils} from '../utils/SubtitleUtils.mjs';
import {URLUtils} from '../utils/URLUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';
import {StatusTypes} from './StatusManager.mjs';

/**
 * Revokes a save's URL once its download is over, then closes the blob store its file
 * reads from (when it has one).
 * @param {string} url
 * @param {*} download - What Utils.downloadURL resolved with.
 * @param {?function(): void} release
 * @return {Promise<void>} Not awaited: the save is done before its download is.
 */
async function releaseWhenDownloaded(url, download, release) {
  await Utils.revokeWhenDownloaded(url, download);
  release?.();
}

export class SaveManager {
  constructor(client) {
    this.client = client;
    // Firefox's word for the system, long before an mpv answer names the helper's steps
    // (EnvUtils.isWindows).
    EnvUtils.os();
    this.downloadURL = null;
    // What Utils.downloadURL answered for the last download of downloadURL.
    this.downloadURLDownload = undefined;
    // Closes the blob store the file behind downloadURL reads from, if it has one.
    this.downloadURLRelease = null;
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

    // mpv carries on where this player is, with the subtitles it shows (as SubRip,
    // shifts and edits included).
    const startTime = this.client.currentTime;
    const subtitles = this.client.interfaceController.subtitlesManager.activeTracks.map((track) => ({
      label: track.label || track.language || '',
      srt: SubtitleUtils.cuesToSrt(track.cues),
    }));

    chrome.runtime.sendMessage({
      type: MessageTypes.MPV_OPEN,
      url: source.url,
      headers: headers,
      contentType: this.mpvContentType || undefined,
      startTime: startTime >= 1 ? startTime : undefined,
      subtitles: subtitles.length > 0 ? subtitles : undefined,
    }, (response) => {
      if (chrome.runtime.lastError) {
        this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_fail'), 'error', 3000);
        return;
      }
      // The host's own reason when it gave one ("mpv executable not found", "mpv is
      // busy..."); "is the host installed?" only when the host itself was not reached.
      const reason = response && !response.ok && !response.noHost && typeof response.error === 'string' ?
        response.error : '';
      if (response && response.vpn) {
        this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_vpn'), 'warning', 12000);
        return;
      }
      if (response && response.ok) {
        // An outdated host still got the stream; say that it wants installing again.
        if (response.hostOutdated) {
          // The steps differ: Windows has a Start menu entry, Linux and macOS a manifest.
          const key = EnvUtils.isWindows() ? 'player_mpv_sent_outdated' : 'player_mpv_sent_outdated_unix';
          this.setStatusMessage(StatusTypes.MPV, Localize.getMessage(key), 'warning', 8000);
        } else {
          this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_sent'), 'info', 2000);
        }
        // mpv has the stream now, so stop playing it here too: otherwise both
        // players run at once and the user has to come back just to pause.
        if (this.client.options.mpvPausePage) {
          this.client.pause().catch(() => {});
        }
      } else if (reason) {
        this.setStatusMessage(StatusTypes.MPV, Localize.getMessage('player_mpv_fail_reason', [reason]), 'error', 6000);
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

  /**
   * Whether a video shows a picture a screenshot can take. Its size is known from the
   * metadata, but drawImage draws nothing until a frame is decoded (readyState 2): during a
   * slow seek, or the first moments of a video, the screenshot was an empty file that said
   * "saved" (review).
   * @param {?HTMLVideoElement} video
   * @return {boolean}
   */
  static hasPicture(video) {
    return !!video?.videoWidth && !!video?.videoHeight && video.readyState >= 2;
  }

  async saveScreenshot() {
    if (!this.client.player) {
      await AlertPolyfill.alert(Localize.getMessage('player_nosource_alert'), 'error');
      return;
    }

    // No picture (audio, or a video not showing one yet): the screenshot was an empty file,
    // and said "saved".
    if (!SaveManager.hasPicture(this.client.player.getVideo())) {
      await AlertPolyfill.alert(Localize.getMessage('player_screenshot_nopicture'), 'error');
      return;
    }

    const suggestedName = (this.client.mediaInfo?.name || 'video').replaceAll(' ', '_') + '@' + StringUtils.formatTime(this.client.currentTime);
    const name = await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName);

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
      // null: Firefox refused the download; it said "saved".
      if (await Utils.downloadURL(url, name + '.png') === null) {
        throw new Error('The download was refused');
      }
      this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_saved'), 'info', 1000);
    } catch (e) {
      console.error(e);
      this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_fail'), 'error', 2000);
    }
  }

  async saveVideo(e, allowPartial = false) {
    // A second click while the first still asks (a confirm, the file name) started a second
    // save: makingDownload is set only once the save begins, which clears this.
    if (this.askingToSave) return;
    this.askingToSave = true;
    try {
      await this.saveVideoAsked(e, allowPartial);
    } finally {
      this.askingToSave = false;
    }
  }

  async saveVideoAsked(e, allowPartial) {
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

    // A Firefox save, private window or not, lands straight in the download directory
    // under whatever name is passed, so the name is always asked for.
    const suggestedName = (this.client.mediaInfo?.name || 'video').replaceAll(' ', '_');

    if (doDump) {
      const name = await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName);
      if (!name) {
        return;
      }
      this.dumpBuffer(name);
      return;
    }

    let url;
    let filestream;
    let name;
    // A stream is written to its file as it is made, so the file has to be named first;
    // anything else is named once it is complete.
    if (canStream) {
      name = await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName);
      if (!name) {
        return;
      }
      filestream = streamSaver.createWriteStream(name + '.' + saveExtension);
    }

    // The file kept is of the quality and audio track it was made of: saved again after a
    // change of either, it was the previous one's file under the new name.
    const levels = String(player.getCurrentVideoLevelID?.()) + '|' + String(player.getCurrentAudioLevelID?.());
    if (this.reuseDownloadURL && this.downloadURL && isComplete && this.downloadURLLevels === levels) {
      url = this.downloadURL;
    } else {
      this.reuseDownloadURL = isComplete;
      let result;
      this.makingDownload = true;
      this.askingToSave = false;
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
        // A stream the player never wrote to (a direct download whose server said no) is
        // ended here; one it wrote to, it aborted itself, and this does nothing.
        filestream?.abort(e).catch(() => {});
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
              name = await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName);
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

      // The url this one replaces goes once its download is over (revoking it
      // at once would kill a download still reading it). A sweep 10 s after
      // each save used to reap it, and left it alone when it was still the
      // current one then: a save made later than that kept the previous file
      // in memory, or its OPFS file pinned, for the rest of the session.
      this.releaseDownloadURL();
      this.downloadURL = url;
      this.downloadURLLevels = levels;
      this.downloadURLRelease = result.release || null;
    }

    if (!canStream) {
      if (!name) {
        name = await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName);
      }
      if (!name) {
        this.releaseDownloadURL();
        this.reuseDownloadURL = false;
        return;
      }

      this.downloadURLDownload = await Utils.downloadURL(url, name + '.' + saveExtension);
      // null: Firefox refused the download (no room, a folder it cannot write to), and after
      // "Save complete" nothing said so.
      if (this.downloadURLDownload === null) {
        this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_fail'), 'error', 4000);
      }
    }
  }

  /**
   * Lets go of this.downloadURL: it is revoked once its last download is over, and the
   * blob store its file reads from (a merged save's OPFS session) is closed then. The
   * store used to close two minutes after the save, and a closed session is deleted by the
   * next player or save that starts: a longer download, or the same file saved again (a
   * complete save's URL is reused), lost its file.
   */
  releaseDownloadURL() {
    const release = this.downloadURLRelease;
    if (this.downloadURL) {
      releaseWhenDownloaded(this.downloadURL, this.downloadURLDownload, release);
    } else {
      release?.();
    }
    this.downloadURL = null;
    this.downloadURLDownload = undefined;
    this.downloadURLRelease = null;
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
      this.setStatusMessage('save-video', Localize.getMessage('player_archiver_fail'), 'error', 2000);
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
        // A .json that is not JSON is skipped, rather than failing the whole drop and
        // with it the video dropped alongside.
        let data;
        try {
          data = JSON.parse(fsprofile);
        } catch (e) {
          console.warn('Skipped a dropped .json that is not JSON:', file.name, e);
          continue;
        }

        if (data?.type === 'audioProfile') {
          this.client.audioConfigManager.loadProfileFile(data);
        }
      } else if (subtitleFormats.includes(ext)) {
        captions.push({
          url: window.URL.createObjectURL(file),
          name: file.name.substring(0, file.name.length - 4),
        });
      } else if (audioFormats.includes(ext)) {
        // Passing the File itself (rather than a pre-made object URL) routes
        // through VideoSource.fromFile(), which is the only path that sets
        // shouldRevoke - so VideoSource.destroy() actually frees the blob
        // when this source is replaced, instead of leaking it for the tab's
        // whole lifetime.
        newSource = new VideoSource(file, {}, PlayerModes.DIRECT);
        newSource.identifier = file.name + 'size' + file.size;
      } else if (URLUtils.getModeFromExtension(ext)) {
        let mode = URLUtils.getModeFromExtension(ext);
        if (mode === PlayerModes.ACCELERATED_MP4) {
          mode = PlayerModes.DIRECT;
        }
        newSource = new VideoSource(file, {}, mode);
        newSource.identifier = file.name + 'size' + file.size;
      } else if (ext === 'fsa') {
        try {
          const {source, entries, currentLevel, currentAudioLevel} = await FastStreamArchiveUtils.parseFSAFile(file, (progress)=>{
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
        // Once loaded: "loaded" came before, and a source that would not load said nothing.
        if (newSource.loadedFromArchive) {
          this.setStatusMessage('save-video', Localize.getMessage('player_archive_loaded'), 'info', 2000);
        }
      } catch (e) {
        console.error(e);
        if (newSource.loadedFromArchive) {
          this.setStatusMessage('save-video', Localize.getMessage('player_archive_fail'), 'error', 4000);
        }
      }

      if (newEntries) {
        this.client.downloadManager.resetOverride(false);
      }
    }

    // One file that cannot be read is left out: its error dropped every caption of the drop,
    // and the video dropped with them never started.
    (await Promise.all(captions.map(async (file) => {
      const track = new SubtitleTrack(file.name);
      try {
        await track.loadURL(file.url);
      } catch (e) {
        console.warn('A dropped subtitle file could not be read', file.name, e);
        return null;
      } finally {
        // loadURL() only ever fetches this once - nothing holds onto the
        // blob URL afterward, so it would otherwise leak for the tab's
        // whole lifetime instead of being freed right after use.
        window.URL.revokeObjectURL(file.url);
      }
      return track;
    }))).filter(Boolean).forEach((track) => {
      const returnedTrack = this.client.loadSubtitleTrack(track);
      this.client.interfaceController.subtitlesManager.activateTrack(returnedTrack);
    });

    // Only a dropped video plays: a subtitle file or an audio profile started the video.
    if (newSource) {
      this.client.play();
    }
  }

  reset() {
    this.reuseDownloadURL = false;
    this.releaseDownloadURL();

    // Second line of defense: the caller (FastStreamClient.resetPlayer)
    // should already have canceled and awaited any in-flight save before
    // reaching this point. Clear the flags anyway so a save that somehow
    // wasn't canceled first can't leave the Save button permanently stuck.
    this.makingDownload = false;
    this.downloadCancel = null;
    this.pendingSave = null;
  }

  destroy() {
    this.releaseDownloadURL();
    this.makingDownload = false;
    this.downloadCancel = null;
    this.pendingSave = null;
  }
}
