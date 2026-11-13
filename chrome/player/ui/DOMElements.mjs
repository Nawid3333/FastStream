// @ts-check

// The player's elements in index.html, found once. Each is typed here, once, as the element
// it is and without null: every one is in the page from the start (the extension's own
// page), so the code that uses them needs no cast of its own.
export const DOMElements = {
  playerContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer')),
  videoContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .video-container')),
  controlsContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_container')),
  controlsLeft: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_left')),
  playPauseButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_playpause')),
  playPauseButtonBig: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_playpause_big')),
  playPauseButtonBigCircle: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_playpause_big_circle')),
  progressContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_progress_container')),
  currentProgress: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_currentprogress')),
  fullscreen: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_fullscreen')),
  windowedFullscreen: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_windowed_fullscreen')),
  subtitles: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_subtitles')),
  videoSource: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_video_source')),
  videoSourceList: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_video_sources_list')),
  audioSourceList: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_audio_sources_list')),
  playbackRate: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_playback_rate')),
  playbackRateBanner: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .rate_menu_banner')),
  download: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_download.main_download')),
  mpv: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_mpv')),
  mpvContentBanner: /** @type {HTMLElement} */ (document.querySelector('#mpv_content_banner')),
  saveNotifBanner: /** @type {HTMLElement} */ (document.querySelector('#save_notif_banner')),
  screenshot: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_screenshot')),
  pip: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_pip')),
  nextVideo: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_next')),
  // The next button and the autoplay switch beside it: one tool in the bar.
  autoplaySwitch: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_autoplay_switch')),
  previousVideo: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_previous')),
  muteBtn: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_mute')),
  volumeBlock: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .volume_block')),
  volumeBanner: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .volume_banner')),
  volumeControlBar: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_volume')),
  volumeContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_volume_container')),
  volumeUnity: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .unity_volume_marker')),
  currentVolumeText: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .current_volume_text')),
  currentVolume: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_currentvolume')),
  currentVolumePos: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_volume_currentpos')),
  duration: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_duration')),

  seekPreview: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .seek_preview')),
  seekPreviewText: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .seek_preview_text')),
  seekPreviewVideo: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .seek_preview_video')),
  seekPreviewTip: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .seek_preview_tip')),

  progressLoadedContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .progress_loaded_container')),

  subtitlesMenu: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subtitles_menu')),
  subtitlesView: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subtitles_view')),
  subtitlesOptions: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subtitles_options')),
  subtitlesList: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subtitles_list')),
  subtitlesContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_subtitles_container')),
  osd: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .osd')),

  subtitlesOptionsBackButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subtitles_options_back')),
  subtitlesOptionsList: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subtitles_options_list')),
  subtitlesOptionsTestButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subtitles_test_button')),

  statusMessages: /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.mainplayer .status_message')),
  resetFailed: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .reset_failed')),

  vpnButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .vpn_button')),
  nextVideoBannerButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .next_video_button')),
  nextVideoCancelButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .next_video_cancel')),
  autoNextIndicator: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .nextvideo_banner')),

  markerContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .marker_container')),

  rateMenu: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .rate_menu')),
  playbackRateMenuContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .rate_menu_container')),

  settingsButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_settings')),

  linkButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_link')),
  subuiContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .subui_container')),
  linkuiContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .linkui_container')),

  bufferingSpinner: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .buffering_spinner')),
  timelineSyncer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_timeline_syncer')),

  optionsContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .options_container')),
  optionsFrame: /** @type {HTMLIFrameElement} */ (document.querySelector('.mainplayer .options_frame')),
  audioTracksBtn: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_button_soundwave')),
  hideButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .hide_button')),
  playinfo: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .playinfo')),

  languageButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_language')),
  languageMenu: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_language .fluid_language_list')),
  rightToolsContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_right')),
  leftToolsContainer: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .tools_container_left')),
  extraTools: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_extra_tools')),
  moreButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_more')),
  loopButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_loop')),
  loopMenu: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .loop_menu')),
  skipForwardButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_skip_forward')),
  skipBackwardButton: /** @type {HTMLElement} */ (document.querySelector('.mainplayer .fluid_control_skip_backward')),
};
