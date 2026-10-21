import {afterEach, describe, expect, it, vi} from 'vitest';

// A finished GIF was handed to the browser by an anchor clicked in the player, a frame of the
// page, which in Firefox downloads no blob (Utils.downloadURL sends a download through the
// background for that), and its URL was revoked in the same task, before the download had
// read it (glm's review, 2026-10-22).

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/gif/gif.mjs', () => ({GIF: class {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
const {LoopMenu} = await import('../../chrome/player/ui/menus/LoopMenu.mjs');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoopMenu, a finished GIF', () => {
  it('is saved as every save is, and its URL kept until the download is over', async () => {
    const download = vi.spyOn(Utils, 'downloadURL').mockResolvedValue(7);
    const later = vi.spyOn(Utils, 'revokeWhenDownloaded').mockResolvedValue();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await LoopMenu.prototype.saveGif.call({}, new Blob(['GIF89a'], {type: 'image/gif'}));
    expect(download).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), 'loop.gif');
    expect(later).toHaveBeenCalledWith(download.mock.calls[0][0], 7);
    expect(revoke).not.toHaveBeenCalled();
  });
});
