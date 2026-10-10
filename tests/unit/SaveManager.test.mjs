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
const {AlertPolyfill} = await import('../../chrome/player/utils/AlertPolyfill.mjs');

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

  it('lets go of the file\'s blob store only once the URL is dropped and its download is over', async () => {
    // A merged save's file reads from the converter's blob store (an OPFS session). The
    // converter closed it two minutes after the save; a closed session is deleted by the
    // next player or save that starts, so a longer download, or the same complete file
    // saved again (its URL is reused), lost it.
    const release = vi.fn();
    const player = {
      canSave: () => ({canSave: true, isComplete: true, canStream: false}),
      saveVideo: async () => ({blob: new Blob(['video']), release}),
    };
    const manager = new SaveManager(makeClient(player));
    await manager.saveVideo({});
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await manager.saveVideo({});
    expect(release).not.toHaveBeenCalled();

    manager.reset();
    await vi.advanceTimersByTimeAsync(59000);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:save-1');
    expect(release).toHaveBeenCalledTimes(1);
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

  // Saved again after another quality or audio track was picked, it was the previous one's
  // file under the new name (review, 2026-10-09).
  it('makes the file again once the quality has changed', async () => {
    let level = '1080p';
    const player = {
      canSave: () => ({canSave: true, isComplete: true, canStream: false}),
      saveVideo: vi.fn(async () => ({blob: new Blob([level])})),
      getCurrentVideoLevelID: () => level,
      getCurrentAudioLevelID: () => 'en',
    };
    const manager = new SaveManager(makeClient(player));
    await manager.saveVideo({});
    level = '720p';
    await manager.saveVideo({});
    expect(player.saveVideo).toHaveBeenCalledTimes(2);
  });

  // A second click while the first still asked for the file name started a second save.
  it('starts one save for two clicks while the name is asked', async () => {
    let answer;
    vi.spyOn(AlertPolyfill, 'prompt').mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const player = {
      canSave: () => ({canSave: true, isComplete: true, canStream: true}),
      saveVideo: vi.fn(async () => ({blob: null})),
    };
    streamSaver.createWriteStream.mockReturnValue({abort: async () => {}});
    const manager = new SaveManager(makeClient(player));
    const first = manager.saveVideo({});
    await vi.advanceTimersByTimeAsync(0);
    await manager.saveVideo({});
    answer('clip');
    await first;
    expect(player.saveVideo).toHaveBeenCalledTimes(1);
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

describe('SaveManager.hasPicture', () => {
  // A size from the metadata alone: drawImage draws nothing before a frame is decoded, and the
  // screenshot was an empty file that said "saved" (review).
  it('needs a decoded frame, not only the size', () => {
    expect(SaveManager.hasPicture({videoWidth: 640, videoHeight: 360, readyState: 2})).toBe(true);
    expect(SaveManager.hasPicture({videoWidth: 640, videoHeight: 360, readyState: 1})).toBe(false);
    expect(SaveManager.hasPicture({videoWidth: 0, videoHeight: 0, readyState: 4})).toBe(false);
    expect(SaveManager.hasPicture(null)).toBe(false);
  });
});
