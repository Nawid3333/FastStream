import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// SaveManager.saveVideo: the blob: URL a finished save hands the download, and the stream a
// streamed save writes to, when the save does not get that far. The player, the dialogs and
// the page around it are stand-ins; Utils.revokeWhenDownloaded is the real one.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({
  DOMElements: {saveNotifBanner: {style: {}}, mpv: {}, mpvContentBanner: {style: {}}},
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
    // Waited a minute without knowing: its files on disk stay for the next prune.
    expect(release).toHaveBeenCalledWith(false);
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

  it('lets go of a URL two downloads read from only once both are over', async () => {
    // A complete video saved again downloads the same URL again. Only the newest download
    // was followed: its end revoked the URL and closed the blob store under the first one,
    // still running (paused in the downloads panel).
    const states = new Map([[1, 'in_progress'], [2, 'in_progress']]);
    const listeners = [];
    vi.stubGlobal('chrome', {downloads: {
      onChanged: {addListener: (fn) => listeners.push(fn), removeListener: () => {}},
      search: async ({id}) => [{id, state: states.get(id)}],
    }});
    const end = (id) => {
      states.set(id, 'complete');
      listeners.slice().forEach((fn) => fn({id, state: {current: 'complete'}}));
    };
    const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
    Utils.downloadURL.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const release = vi.fn();
    const player = {
      canSave: () => ({canSave: true, isComplete: true, canStream: false}),
      saveVideo: async () => ({blob: new Blob(['video']), release}),
    };
    const manager = new SaveManager(makeClient(player));
    await manager.saveVideo({});
    await manager.saveVideo({});
    expect(created).toEqual(['blob:save-1']);
    manager.reset();

    end(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    end(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:save-1');
    expect(release).toHaveBeenCalledTimes(1);
    // Firefox said both are over: its files on disk go too.
    expect(release).toHaveBeenCalledWith(true);
    vi.unstubAllGlobals();
  });

  // Saved again after another quality or audio track was picked, it was the previous one's
  // file under the new name.
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

  it('keeps the file a finished save names while a second click comes', async () => {
    // The name is asked once the file is made: a second save then revoked the first's file.
    let answer;
    vi.spyOn(AlertPolyfill, 'prompt').mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const player = {
      canSave: () => ({canSave: true, isComplete: false, canStream: false}),
      saveVideo: vi.fn(async () => ({blob: new Blob(['x'])})),
    };
    const manager = new SaveManager(makeClient(player));
    const first = manager.saveVideo({});
    await vi.advanceTimersByTimeAsync(0);
    await manager.saveVideo({});
    answer('clip');
    await first;
    expect(player.saveVideo).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('saves nothing for an answer that comes after the next video did', async () => {
    const first = {canSave: () => ({canSave: true, isComplete: false, canStream: false}), saveVideo: vi.fn()};
    const client = makeClient(first);
    vi.spyOn(AlertPolyfill, 'confirm').mockImplementation(async () => {
      client.player = {canSave: first.canSave, saveVideo: vi.fn()};
      return true;
    });
    await new SaveManager(client).saveVideo({altKey: true});
    expect(first.saveVideo).not.toHaveBeenCalled();
    expect(client.player.saveVideo).not.toHaveBeenCalled();
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

describe('SaveManager: a file whose length is not known yet', () => {
  it('saves what is loaded, after asking, rather than a whole file it does not have', async () => {
    streamSaver.createWriteStream.mockReturnValue({abort: vi.fn(async () => {})});
    const confirm = vi.spyOn(AlertPolyfill, 'confirm');
    const saveVideo = vi.fn(async () => ({extension: 'mp4', blob: null}));
    const player = {
      canSave: () => ({canSave: true, isComplete: false, canStream: true, onlyLoaded: true}),
      saveVideo,
    };
    await new SaveManager(makeClient(player)).saveVideo({});
    expect(confirm).toHaveBeenCalledWith('player_savevideo_partial_confirm', 'warning');
    expect(saveVideo.mock.calls[0][0].partialSave).toBe(true);
  });
});

// An older helper still plays the stream and lacks only newer features: no warning for it.
describe('SaveManager.openInMpv', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('says "sent" for a stream that went to an outdated helper too, and pauses the page', async () => {
    for (const answer of [{ok: true}, {ok: true, hostOutdated: true}]) {
      const statuses = [];
      const client = {
        ...makeClient({}),
        source: {url: 'https://cdn.test/a.m3u8', headers: {}},
        currentTime: 0,
        options: {mpvPausePage: true},
        pause: vi.fn(async () => {}),
        interfaceController: {
          setStatusMessage: (key, message, type) => statuses.push({message, type}),
          subtitlesManager: {activeTracks: []},
        },
      };
      globalThis.chrome = {runtime: {lastError: undefined, sendMessage: (message, callback) => callback(answer)}};
      await new SaveManager(client).openInMpv();
      expect(statuses.at(-1)).toEqual({message: 'player_mpv_sent', type: 'info'});
      expect(client.pause).toHaveBeenCalledTimes(1);
    }
  });

  it('pauses the player while mpv asks, as the page is paused', async () => {
    for (const mpvPausePage of [true, false]) {
      const client = {...makeClient({}), options: {mpvPausePage}, pause: vi.fn(async () => {})};
      new SaveManager(client).whileMpvAsks();
      expect(client.pause).toHaveBeenCalledTimes(mpvPausePage ? 1 : 0);
    }
  });

  it('says "not sent" with no error when it was declined in mpv, and starts nothing again', async () => {
    const statuses = [];
    const client = {
      ...makeClient({}),
      source: {url: 'https://cdn.test/a.m3u8', headers: {}},
      currentTime: 0,
      options: {mpvPausePage: true},
      pause: vi.fn(async () => {}),
      interfaceController: {
        setStatusMessage: (key, message, type) => statuses.push({message, type}),
        subtitlesManager: {activeTracks: []},
      },
    };
    globalThis.chrome = {runtime: {lastError: undefined,
      sendMessage: (message, callback) => callback({ok: false, declined: true})}};
    await new SaveManager(client).openInMpv();
    expect(statuses.at(-1)).toEqual({message: 'player_mpv_declined', type: 'info'});
    expect(client.pause).not.toHaveBeenCalled();
  });

  it('sends the stream once for a second click while the first is on its way', async () => {
    const callbacks = [];
    globalThis.chrome = {runtime: {lastError: undefined, sendMessage: (message, callback) => callbacks.push(callback)}};
    const client = {
      ...makeClient({}),
      source: {url: 'https://cdn.test/a.m3u8', headers: {}},
      currentTime: 0,
      options: {},
      interfaceController: {setStatusMessage() {}, subtitlesManager: {activeTracks: []}},
    };
    const manager = new SaveManager(client);
    await manager.openInMpv();
    await manager.openInMpv();
    expect(callbacks).toHaveLength(1);
    callbacks[0]({ok: true});
    await manager.openInMpv();
    expect(callbacks).toHaveLength(2);
  });

  it('sends again after a send that threw, or got no answer for a while', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      let sent = 0;
      let throws = true;
      globalThis.chrome = {runtime: {lastError: undefined, sendMessage: () => {
        sent++;
        if (throws) throw new Error('Extension context invalidated.');
      }}};
      const statuses = [];
      const client = {
        ...makeClient({}),
        source: {url: 'https://cdn.test/a.m3u8', headers: {}},
        currentTime: 0,
        options: {},
        interfaceController: {setStatusMessage: (key, message) => statuses.push(message), subtitlesManager: {activeTracks: []}},
      };
      const manager = new SaveManager(client);
      await manager.openInMpv();
      expect(statuses.at(-1)).toBe('player_mpv_fail');
      throws = false;
      await manager.openInMpv();
      expect(sent).toBe(2);
      await manager.openInMpv();
      expect(sent).toBe(2);
      // Not within the waits before a send and mpv's 2 + 17 s question to a window that plays.
      vi.advanceTimersByTime(29999);
      await manager.openInMpv();
      expect(sent).toBe(2);
      vi.advanceTimersByTime(1);
      await manager.openInMpv();
      expect(sent).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SaveManager.saveScreenshot', () => {
  // Firefox can ask where to save; the user cancelling it was taken as a refused download:
  // "screenshot failed".
  /**
   * Takes a screenshot whose download is answered with the given value.
   * @param {*} answer - What Utils.downloadURL resolves with.
   * @return {Promise<Array<Array<*>>>} The status messages set.
   */
  async function screenshotAnswered(answer) {
    const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
    Utils.downloadURL.mockResolvedValueOnce(answer);
    vi.stubGlobal('document', {createElement: () => ({
      getContext: () => ({drawImage() {}}),
      toDataURL: () => 'data:image/png;base64,',
    })});
    const messages = [];
    const client = makeClient({getVideo: () => ({videoWidth: 640, videoHeight: 360, readyState: 4})});
    client.interfaceController.setStatusMessage = (...args) => messages.push(args);
    try {
      await new SaveManager(client).saveScreenshot();
    } finally {
      vi.unstubAllGlobals();
    }
    return messages;
  }

  it('takes back its "saving" when the user cancels Firefox\'s Save As, and says nothing failed', async () => {
    expect(await screenshotAnswered(false)).toEqual([
      ['save-screenshot', 'player_screenshot_saving', 'info', undefined],
      ['save-screenshot', null, 'info', undefined],
    ]);
  });

  it('says it failed when Firefox refuses the download, and saved when it starts', async () => {
    expect((await screenshotAnswered(null)).at(-1)).toEqual(['save-screenshot', 'player_screenshot_fail', 'error', 2000]);
    expect((await screenshotAnswered(7)).at(-1)).toEqual(['save-screenshot', 'player_screenshot_saved', 'info', 1000]);
  });
});

describe('SaveManager.hasPicture', () => {
  // A size from the metadata alone: drawImage draws nothing before a frame is decoded, and the
  // screenshot was an empty file that said "saved".
  it('needs a decoded frame, not only the size', () => {
    expect(SaveManager.hasPicture({videoWidth: 640, videoHeight: 360, readyState: 2})).toBe(true);
    expect(SaveManager.hasPicture({videoWidth: 640, videoHeight: 360, readyState: 1})).toBe(false);
    expect(SaveManager.hasPicture({videoWidth: 0, videoHeight: 0, readyState: 4})).toBe(false);
    expect(SaveManager.hasPicture(null)).toBe(false);
  });
});

describe('SaveManager.cycleMpvContentType', () => {
  it('cycles Auto -> Anime -> Movie -> Native -> Auto, with the badge and tooltip of each', async () => {
    const {DOMElements} = await import('../../chrome/player/ui/DOMElements.mjs');
    const manager = new SaveManager(makeClient({}));
    const seen = [];
    for (let i = 0; i < 4; i++) {
      manager.cycleMpvContentType();
      seen.push([manager.mpvContentType, DOMElements.mpvContentBanner.textContent,
        DOMElements.mpvContentBanner.style.display, DOMElements.mpv.title]);
    }
    expect(seen).toEqual([
      ['anime', 'A', '', 'player_mpv_content_anime'],
      ['movie', 'M', '', 'player_mpv_content_movie'],
      ['native', 'N', '', 'player_mpv_content_native'],
      [null, '', 'none', 'player_mpv_content_unset'],
    ]);
  });
});
