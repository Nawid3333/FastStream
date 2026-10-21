import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// A finished GIF was handed to the browser by an anchor clicked in the player, a frame of the
// page, which in Firefox downloads no blob: Utils.downloadURL sends a download through the
// background for that (glm's review, 2026-10-22).

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Utils.downloadBlob', () => {
  it('saves as every save does, and keeps the URL until the download is over', async () => {
    const download = vi.spyOn(Utils, 'downloadURL').mockResolvedValue(7);
    const later = vi.spyOn(Utils, 'revokeWhenDownloaded').mockResolvedValue();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await Utils.downloadBlob(new Blob(['GIF89a'], {type: 'image/gif'}), 'loop.gif');
    expect(download).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 'loop.gif');
    expect(later).toHaveBeenCalledWith(download.mock.calls[0][0], 7);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('is how the loop menu saves its GIF, not an anchor of its own', () => {
    // LoopMenu imports the vendored GIF encoder, which unit tests do not have: read as text.
    const source = fs.readFileSync(new URL('../../chrome/player/ui/menus/LoopMenu.mjs', import.meta.url), 'utf8');
    expect(source).toContain('Utils.downloadBlob(blob, \'loop.gif\')');
    expect(source).not.toMatch(/a\.download = 'loop\.gif'/);
  });
});
