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
  'chrome/background/KeyShortcut.mjs',
  'chrome/background/ManifestTypes.mjs',
  'chrome/background/MpvBackend.mjs',
  'chrome/background/MultiRegexMatcher.mjs',
  'chrome/background/TabTracker.mjs',
  'chrome/background/UrlMatchList.mjs',
  'chrome/background/background.mjs',
  'chrome/player/enums/AnalyzerEvents.mjs',
  'chrome/player/enums/DefaultPlayerEvents.mjs',
  'chrome/player/enums/DownloadStatus.mjs',
  'chrome/player/enums/MessageTypes.mjs',
  'chrome/player/enums/PlayerModes.mjs',
  'chrome/player/enums/ReferenceTypes.mjs',
  'chrome/player/network/DownloadEntry.mjs',
  'chrome/player/network/OpQueue.mjs',
  'chrome/player/players/DecodingCapabilities.mjs',
  'chrome/player/utils/AudioUtils.mjs',
  'chrome/player/utils/StreamLength.mjs',
  'chrome/player/utils/SubtitleSyncUtils.mjs',
  'chrome/player/utils/URLUtils.mjs',
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
