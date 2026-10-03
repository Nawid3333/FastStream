import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// SaveManager.saveVideo: the blob: URL a finished save hands the download, and the stream a
// streamed save writes to, when the save does not get that far. The player, the dialogs and
// the page around it are stand-ins; Utils.revokeWhenDownloaded is the real one.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({
  DOMElements: {saveNotifBanner: {style: {}}},
}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({
  AlertPolyfill: {
    prompt: async (message, suggested) => suggested,
    alert: async () => {},
    // Yes to saving what was downloaded so far, no to an archive after a failure.
    confirm: async (message) => message === 'player_savevideo_partial_confirm',
  },
}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/modules/StreamSaver.mjs', () => ({
  streamSaver: {createWriteStream: vi.fn()},
}));
vi.mock('../../chrome/player/utils/Utils.mjs', async (importOriginal) => {
  const {Utils} = await importOriginal();
  Utils.downloadURL = vi.fn(async () => 7);
  return {Utils};
});

const {SaveManager} = await import('../../chrome/player/ui/SaveManager.mjs');
const {streamSaver} = await import('../../chrome/player/modules/StreamSaver.mjs');

/**
 * A client whose player saves what the test says.
 * @param {Object} player canSave() and saveVideo() of the player
 * @return {Object}
 */
function makeClient(player) {
  return {
    player,
    mediaInfo: {name: 'clip'},
    interfaceController: {setStatusMessage() {}},
  };
}

let created;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  created = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    created.push(`blob:save-${created.length + 1}`);
    return created.at(-1);
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SaveManager: the URL of a finished save', () => {
  // Saved from what was downloaded so far (alt-click): not complete, so every save makes a
  // file of its own.
  const partialPlayer = {
    canSave: () => ({canSave: true, isComplete: false, canStream: false}),
    saveVideo: async () => ({blob: new Blob(['video'])}),
  };

  it('revokes a URL a later save replaces, once its download is over', async () => {
    // A sweep 10 s after each save revoked the URL only if it had been replaced by then;
    // a save made later replaced it for good and nothing revoked it.
    const manager = new SaveManager(makeClient(partialPlayer));
    await manager.saveVideo({altKey: true});
    await vi.advanceTimersByTimeAsync(20000);
    await manager.saveVideo({altKey: true});
    expect(created).toEqual(['blob:save-1', 'blob:save-2']);

    // revokeWhenDownloaded keeps a URL a minute when it cannot follow the download.
    await vi.advanceTimersByTimeAsync(60000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:save-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:save-2');
  });

  it('keeps the current URL until the source changes, then revokes it once its download is over', async () => {
    const manager = new SaveManager(makeClient(partialPlayer));
    await manager.saveVideo({altKey: true});
    await vi.advanceTimersByTimeAsync(120000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    manager.reset();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:save-1');
  });

  it('reuses the URL of a complete save', async () => {
    const player = {
      canSave: () => ({canSave: true, isComplete: true, canStream: false}),
      saveVideo: vi.fn(async () => ({blob: new Blob(['video'])})),
    };
    const manager = new SaveManager(makeClient(player));
    await manager.saveVideo({});
    await manager.saveVideo({});

    expect(player.saveVideo).toHaveBeenCalledTimes(1);
    expect(created).toEqual(['blob:save-1']);
    await vi.advanceTimersByTimeAsync(120000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe('SaveManager: a streamed save that fails', () => {
  it('ends the stream when the player failed before writing to it', async () => {
    // A direct download whose server answered 404 throws before it takes a writer.
    const stream = {abort: vi.fn(async () => {})};
    streamSaver.createWriteStream.mockReturnValue(stream);
    const player = {
      canSave: () => ({canSave: true, isComplete: true, canStream: true, extension: 'webm'}),
      saveVideo: async () => {
        throw new Error('Bad status code: 404');
      },
    };
    const manager = new SaveManager(makeClient(player));
    await manager.saveVideo({});

    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(manager.makingDownload).toBe(false);
  });
});
