import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';
import {describe, expect, it} from 'vitest';

// T5's ratchet: the files TypeScript checks (`// @ts-check`, strictNullChecks; `pnpm run
// typecheck`) only ever grow. Many of the bugs a review finds are null dereferences the
// checker reports. Turning a file's checking on means fixing what tsc says and adding the
// file here; taking the comment out of one fails this test.

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');

const CHECKED = [
  'chrome/background/BackgroundUtils.mjs',
  'chrome/background/CustomSourcePatterns.mjs',
  'chrome/background/DownloadFilename.mjs',
  'chrome/background/KeyShortcut.mjs',
  'chrome/background/ManifestTypes.mjs',
  'chrome/background/MpvBackend.mjs',
  'chrome/background/MpvRelayWatch.mjs',
  'chrome/background/MpvSubtitles.mjs',
  'chrome/background/MpvTarget.mjs',
  'chrome/background/MultiRegexMatcher.mjs',
  'chrome/background/TabTracker.mjs',
  'chrome/background/UrlMatchList.mjs',
  'chrome/background/VpnProxyMirror.mjs',
  'chrome/background/background.mjs',
  'chrome/content.js',
  'chrome/custom/bilibili_content.js',
  'chrome/custom/facebook_content.js',
  'chrome/custom/instagram_content.js',
  'chrome/custom/instagram_inject.js',
  'chrome/episode-links.js',
  'chrome/overlay-guard.js',
  'chrome/page-qualities.js',
  'chrome/perms.mjs',
  'chrome/player/FastStreamClient.mjs',
  'chrome/player/SubtitleTrack.mjs',
  'chrome/player/VideoSource.mjs',
  'chrome/player/enums/DefaultPlayerEvents.mjs',
  'chrome/player/enums/DownloadStatus.mjs',
  'chrome/player/enums/MessageTypes.mjs',
  'chrome/player/enums/PlayerModes.mjs',
  'chrome/player/enums/ReferenceTypes.mjs',
  'chrome/player/i18n.mjs',
  'chrome/player/main.mjs',
  'chrome/player/network/BufferAhead.mjs',
  'chrome/player/network/DownloadEntry.mjs',
  'chrome/player/network/IndexedDBManager.mjs',
  'chrome/player/network/MemoryBudget.mjs',
  'chrome/player/network/OpQueue.mjs',
  'chrome/player/network/PlayerPeers.mjs',
  'chrome/player/network/PlayheadFirst.mjs',
  'chrome/player/network/SpeedTracker.mjs',
  'chrome/player/network/StandardDownloader.mjs',
  'chrome/player/options/KeybindUtils.mjs',
  'chrome/player/options/MpvSuggestion.mjs',
  'chrome/player/options/OptionsStore.mjs',
  'chrome/player/options/defaults/AspectRatios.mjs',
  'chrome/player/options/defaults/ClickActions.mjs',
  'chrome/player/options/defaults/ColorThemes.mjs',
  'chrome/player/options/defaults/DefaultKeybinds.mjs',
  'chrome/player/options/defaults/DefaultOptions.mjs',
  'chrome/player/options/defaults/DefaultQualities.mjs',
  'chrome/player/options/defaults/DefaultSubtitlesSettings.mjs',
  'chrome/player/options/defaults/MiniplayerPositions.mjs',
  'chrome/player/options/defaults/ToolSettings.mjs',
  'chrome/player/options/defaults/VisChangeActions.mjs',
  'chrome/player/options/options.mjs',
  'chrome/player/players/DecodingCapabilities.mjs',
  'chrome/player/players/DirectVideoPlayer.mjs',
  'chrome/player/players/Fragment.mjs',
  'chrome/player/players/LevelManager.mjs',
  'chrome/player/players/Levels.mjs',
  'chrome/player/players/PlayerLoader.mjs',
  'chrome/player/players/SaveFragmentFetcher.mjs',
  'chrome/player/players/SyncedAudioPlayer.mjs',
  'chrome/player/players/dash/DashErrors.mjs',
  'chrome/player/players/dash/DashFragment.mjs',
  'chrome/player/players/dash/DashFragmentRequester.mjs',
  'chrome/player/players/dash/DashLoader.mjs',
  'chrome/player/players/dash/DashTrackUtils.mjs',
  'chrome/player/players/hls/HLSFragment.mjs',
  'chrome/player/players/hls/HLSFragmentRequester.mjs',
  'chrome/player/players/mp4/AacLayout.mjs',
  'chrome/player/players/mp4/MP4Fragment.mjs',
  'chrome/player/players/mp4/MP4FragmentRequester.mjs',
  'chrome/player/players/mp4/RangeAnswers.mjs',
  'chrome/player/players/mp4/SourceBufferWrapper.mjs',
  'chrome/player/players/mp4/StallWatchdog.mjs',
  'chrome/player/players/vm/VMPlayer.mjs',
  'chrome/player/preload.mjs',
  'chrome/player/ui/DOMElements.mjs',
  'chrome/player/ui/FrameStepper.mjs',
  'chrome/player/ui/InterfaceController.mjs',
  'chrome/player/ui/OptionsWindow.mjs',
  'chrome/player/ui/PointerMoves.mjs',
  'chrome/player/ui/SaveManager.mjs',
  'chrome/player/ui/StatusManager.mjs',
  'chrome/player/ui/VpnPrompt.mjs',
  'chrome/player/ui/audio/AbstractAudioModule.mjs',
  'chrome/player/ui/audio/AudioGain.mjs',
  'chrome/player/ui/audio/VirtualAudioNode.mjs',
  'chrome/player/ui/menus/AudioQualityChanger.mjs',
  'chrome/player/ui/menus/LanguageChanger.mjs',
  'chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs',
  'chrome/player/ui/subtitles/SubtitleSearchTitles.mjs',
  'chrome/player/ui/subtitles/SubtitlesManager.mjs',
  'chrome/player/utils/AddressKey.mjs',
  'chrome/player/utils/AlertPolyfill.mjs',
  'chrome/player/utils/AudioUtils.mjs',
  'chrome/player/utils/BlobManager.mjs',
  'chrome/player/utils/BrokenMedia.mjs',
  'chrome/player/utils/InterfaceUtils.mjs',
  'chrome/player/utils/MediaTitle.mjs',
  'chrome/player/utils/PageQualityPick.mjs',
  'chrome/player/utils/PlayerErrorUtils.mjs',
  'chrome/player/utils/ProblemLog.mjs',
  'chrome/player/utils/StreamLength.mjs',
  'chrome/player/utils/StringUtils.mjs',
  'chrome/player/utils/SubtitleFetch.mjs',
  'chrome/player/utils/SubtitleSyncUtils.mjs',
  'chrome/player/utils/URLUtils.mjs',
  'chrome/player/utils/UpdateChecker.mjs',
  'chrome/player/utils/VideoTransformUtils.mjs',
  'chrome/player/utils/VideoUtils.mjs',
  'native-host/faststream-mpv-host.mjs',
];

/**
 * Whether a file opts into checking: `// @ts-check` before its code (after a shebang).
 * @param {string} file - Path from the repository.
 * @return {boolean}
 */
function isChecked(file) {
  const head = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).slice(0, 3);
  return head.some((line) => line.trim() === '// @ts-check');
}

/**
 * Every first-party script under a folder, vendored modules left out.
 * @param {string} dir - Folder from the repository.
 * @return {string[]} Paths from the repository.
 */
function scripts(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), {withFileTypes: true})) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (rel === 'chrome/player/modules' || rel === 'chrome/player/assets') continue;
      out.push(...scripts(rel));
    } else if (/\.m?js$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe('type-checked files', () => {
  it('keep their // @ts-check', () => {
    expect(CHECKED.filter((file) => !isChecked(file))).toEqual([]);
  });

  it('are all listed here, so none drops out unnoticed', () => {
    const checked = [...scripts('chrome'), ...scripts('native-host')].filter(isChecked).sort();
    expect(checked).toEqual([...CHECKED].sort());
  });
});
