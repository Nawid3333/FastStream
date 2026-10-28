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
  'chrome/background/ContextMenu.mjs',
  'chrome/background/CustomSourcePatterns.mjs',
  'chrome/background/DownloadFilename.mjs',
  'chrome/background/FreshLink.mjs',
  'chrome/background/KeyShortcut.mjs',
  'chrome/background/ManifestTypes.mjs',
  'chrome/background/MpvBackend.mjs',
  'chrome/background/MpvRelayWatch.mjs',
  'chrome/background/MpvSubtitles.mjs',
  'chrome/background/MpvTarget.mjs',
  'chrome/background/MultiRegexMatcher.mjs',
  'chrome/background/NetRequestRuleManager.mjs',
  'chrome/background/StreamLengths.mjs',
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
  'chrome/player/modules/FSBlob.mjs',
  'chrome/player/modules/LargeBuffer.mjs',
  'chrome/player/modules/Localize.mjs',
  'chrome/player/modules/SecureMemory.mjs',
  'chrome/player/modules/StreamSaver.mjs',
  'chrome/player/modules/analyzer/AudioAnalyzer.mjs',
  'chrome/player/modules/analyzer/AudioAnalyzerNode.mjs',
  'chrome/player/modules/analyzer/PreviewFrameExtractor.mjs',
  'chrome/player/modules/channelcounter/channelcounter.mjs',
  'chrome/player/modules/channelcounter/channelcounter.worklet.mjs',
  'chrome/player/modules/dash2mp4/dash2mp4.mjs',
  'chrome/player/modules/dash2mp4/mp4merger.mjs',
  'chrome/player/modules/decrypter-worker.js',
  'chrome/player/modules/eventemitter.mjs',
  'chrome/player/modules/hls2mp4/hls2mp4.mjs',
  'chrome/player/modules/hls2mp4/ptsNormalize.mjs',
  'chrome/player/modules/hls2mp4/transmuxer.mjs',
  'chrome/player/modules/remux/TimestampRebaser.mjs',
  'chrome/player/modules/remux/mp4-writer.mjs',
  'chrome/player/modules/remux/remuxer.mjs',
  'chrome/player/network/BufferAhead.mjs',
  'chrome/player/network/DownloadEntry.mjs',
  'chrome/player/network/DownloadManager.mjs',
  'chrome/player/network/FetchLoader.mjs',
  'chrome/player/network/IndexedDBManager.mjs',
  'chrome/player/network/MemoryBudget.mjs',
  'chrome/player/network/OPFSManager.mjs',
  'chrome/player/network/OpQueue.mjs',
  'chrome/player/network/PlayerPeers.mjs',
  'chrome/player/network/PlayheadFirst.mjs',
  'chrome/player/network/SpeedTracker.mjs',
  'chrome/player/network/StandardDownloader.mjs',
  'chrome/player/network/opfs-worker.mjs',
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
  'chrome/player/players/DroppedFrameWatch.mjs',
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
  'chrome/player/players/dash/DashPlayer.mjs',
  'chrome/player/players/dash/DashTrackUtils.mjs',
  'chrome/player/players/hls/HLSDecrypter.mjs',
  'chrome/player/players/hls/HLSFragment.mjs',
  'chrome/player/players/hls/HLSFragmentRequester.mjs',
  'chrome/player/players/hls/HLSFragmentStore.mjs',
  'chrome/player/players/hls/HLSLoader.mjs',
  'chrome/player/players/hls/HLSPlayer.mjs',
  'chrome/player/players/mp4/AacLayout.mjs',
  'chrome/player/players/mp4/MP4Fragment.mjs',
  'chrome/player/players/mp4/MP4FragmentRequester.mjs',
  'chrome/player/players/mp4/MP4Player.mjs',
  'chrome/player/players/mp4/RangeAnswers.mjs',
  'chrome/player/players/mp4/SampleIndex.mjs',
  'chrome/player/players/mp4/SegmentAppender.mjs',
  'chrome/player/players/mp4/SourceBufferWrapper.mjs',
  'chrome/player/players/mp4/StallWatchdog.mjs',
  'chrome/player/players/vm/VMPlayer.mjs',
  'chrome/player/preload.mjs',
  'chrome/player/ui/ClickSequence.mjs',
  'chrome/player/ui/DOMElements.mjs',
  'chrome/player/ui/DownloadStatusText.mjs',
  'chrome/player/ui/FineTimeControls.mjs',
  'chrome/player/ui/FrameStepper.mjs',
  'chrome/player/ui/InterfaceController.mjs',
  'chrome/player/ui/KeybindManager.mjs',
  'chrome/player/ui/MediaKeys.mjs',
  'chrome/player/ui/OnScreenDisplay.mjs',
  'chrome/player/ui/OptionsWindow.mjs',
  'chrome/player/ui/PointerMoves.mjs',
  'chrome/player/ui/PressTracker.mjs',
  'chrome/player/ui/ProgressBar.mjs',
  'chrome/player/ui/SaveManager.mjs',
  'chrome/player/ui/SourcesBrowser.mjs',
  'chrome/player/ui/StatusManager.mjs',
  'chrome/player/ui/ToolManager.mjs',
  'chrome/player/ui/VolumeControls.mjs',
  'chrome/player/ui/VpnPrompt.mjs',
  'chrome/player/ui/audio/AbstractAudioModule.mjs',
  'chrome/player/ui/audio/AudioGain.mjs',
  'chrome/player/ui/audio/AudioOutput.mjs',
  'chrome/player/ui/audio/AudioOutputDevice.mjs',
  'chrome/player/ui/audio/VirtualAudioNode.mjs',
  'chrome/player/ui/components/Dropdown.mjs',
  'chrome/player/ui/components/PagesBar.mjs',
  'chrome/player/ui/menus/AudioQualityChanger.mjs',
  'chrome/player/ui/menus/LanguageChanger.mjs',
  'chrome/player/ui/menus/LoopMenu.mjs',
  'chrome/player/ui/menus/PlaybackRateChanger.mjs',
  'chrome/player/ui/menus/VideoQualityChanger.mjs',
  'chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs',
  'chrome/player/ui/subtitles/SubtitleSearchTitles.mjs',
  'chrome/player/ui/subtitles/SubtitleSyncer.mjs',
  'chrome/player/ui/subtitles/SubtitlesManager.mjs',
  'chrome/player/ui/subtitles/SubtitlesSettingsManager.mjs',
  'chrome/player/utils/AddressKey.mjs',
  'chrome/player/utils/AlertPolyfill.mjs',
  'chrome/player/utils/AudioUtils.mjs',
  'chrome/player/utils/BlobManager.mjs',
  'chrome/player/utils/BrokenMedia.mjs',
  'chrome/player/utils/EnvUtils.mjs',
  'chrome/player/utils/FastStreamArchiveUtils.mjs',
  'chrome/player/utils/InterfaceUtils.mjs',
  'chrome/player/utils/MediaTitle.mjs',
  'chrome/player/utils/PageQualityPick.mjs',
  'chrome/player/utils/PlayerErrorUtils.mjs',
  'chrome/player/utils/ProblemLog.mjs',
  'chrome/player/utils/RequestUtils.mjs',
  'chrome/player/utils/SearchUtils.mjs',
  'chrome/player/utils/StreamLength.mjs',
  'chrome/player/utils/StreamPick.mjs',
  'chrome/player/utils/StringUtils.mjs',
  'chrome/player/utils/SubtitleFetch.mjs',
  'chrome/player/utils/SubtitleSyncUtils.mjs',
  'chrome/player/utils/SubtitleUtils.mjs',
  'chrome/player/utils/URLUtils.mjs',
  'chrome/player/utils/UpdateChecker.mjs',
  'chrome/player/utils/Utils.mjs',
  'chrome/player/utils/VideoTransformUtils.mjs',
  'chrome/player/utils/VideoUtils.mjs',
  'chrome/player/utils/WebUtils.mjs',
  'native-host/faststream-mpv-host.mjs',
  'tools/ast-compare.mjs',
  'tools/check-patched-updates.mjs',
  'tools/check-toolchain.mjs',
  'tools/check-update-path.mjs',
  'tools/compare-decls.mjs',
  'tools/cut-release.mjs',
  'tools/e2e-spec-weights.mjs',
  'tools/fetch-amo-signed.mjs',
  'tools/find-base.mjs',
  'tools/gen-update-manifest.mjs',
  'tools/hash-build.mjs',
  'tools/launch-ff-fresh.mjs',
  'tools/launch-ff.mjs',
  'tools/newest-release.mjs',
  'tools/privacy-check.mjs',
  'tools/rebuild.mjs',
  'tools/recut-patch.mjs',
  'tools/security-overrides.mjs',
  'tools/setup-dev-profile.mjs',
  'tools/sign-amo.mjs',
  'tools/splicer.mjs',
  'tools/sync-vendor.mjs',
  'tools/test-ext-github.mjs',
  'tools/verify-fsaunpack.mjs',
  'tools/verify-linux.mjs',
  'tools/verify-vtt.mjs',
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

// The vendored libraries: tools/sync-vendor.mjs writes them at build time, so .gitignore
// names each (a folder with a trailing slash, or `/*` when a file in it is kept). Not the
// whole modules folder: FastStream's own modules (FSBlob, the analyzers, remux) sit beside them.
const vendored = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)
    .map((line) => line.trim().replace(/\/\*$/, '/')).filter((line) => line.startsWith('chrome/'));
const isVendored = (rel, isDir) => vendored.some((entry) => (entry.endsWith('/') ? isDir && `${rel}/` === entry : rel === entry));
const isVendoredFile = (rel) => vendored.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));

/**
 * Every first-party script under a folder, vendored modules left out.
 * @param {string} dir - Folder from the repository.
 * @return {string[]} Paths from the repository.
 */
function scripts(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), {withFileTypes: true})) {
    const rel = `${dir}/${entry.name}`;
    if (isVendored(rel, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
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
    const checked = [...scripts('chrome'), ...scripts('native-host'), ...scripts('tools')].filter(isChecked).sort();
    expect(checked).toEqual([...CHECKED].sort());
  });

  it('see a declaration beside every vendored library they import', () => {
    // Absent until the build copies it, a vendored library was an untyped import; once
    // there, TypeScript read its JavaScript, guessed types the code does not fit, and the
    // check failed in a built checkout only. The declaration beside it is what both see.
    const missing = [];
    for (const file of [...scripts('chrome'), ...scripts('native-host')]) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      for (const [, spec] of text.matchAll(/^\s*import\b[^'"]*['"](\.[^'"]+\.mjs)['"]/gm)) {
        const target = path.posix.join(path.posix.dirname(file), spec);
        const declaration = target.replace(/\.mjs$/, '.d.mts');
        if (isVendoredFile(target) && !fs.existsSync(path.join(root, declaration))) {
          missing.push(`${file} imports ${target}: no ${declaration}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
