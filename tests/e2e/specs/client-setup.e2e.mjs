// FastStreamClient's setup of a source, and what it does once one plays.
//
// Each case opens the web player with no source, changes what it needs in the page, and
// then hands the player a source the way main.mjs does.

import {browser, expect} from '@wdio/globals';

const mp4Url = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/sample.mp4`;
// An HLS source: its setup goes through without its manifest, which then never loads. A
// missing MP4 fails inside setSource, so the part that seeks to its time never runs.
const missingUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/missing/stream.m3u8`;

/**
 * Opens the player with no source, and with autoplay and remembered positions off, so
 * that nothing but the case itself moves the video.
 * @return {Promise<void>}
 */
async function openEmptyPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  // setOptions() runs after the client exists (main.mjs loads its options from
  // storage) and would clobber the overrides below when it lands; main.mjs sets
  // optionsApplied when it has run. preload.mjs also sets a theme early, so the
  // page's dataset is not a reliable sign here.
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
  await browser.execute(() => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
  });
}

/**
 * Hands the player a source, as main.mjs does for a URL in the page's hash.
 * @param {string} url - The source.
 * @return {Promise<void>}
 */
async function addSource(url) {
  const error = await browser.executeAsync((url, done) => {
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }, url);
  expect(error).toBe(null);
}

/**
 * Waits until the video the player shows has a frame to show.
 * @return {Promise<void>}
 */
async function waitForPicture() {
  await browser.waitUntil(async () => browser.execute(() => {
    const client = window.fastStream;
    return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
  }), {timeout: 30000, timeoutMsg: 'the video never loaded'});
}

describe('FastStreamClient setup', function() {
  afterEach(async function() {
    // Remembered times outlive the page in this browser session's IndexedDB, and a later
    // case on the same video would start at one.
    await browser.executeAsync((done) => {
      const manager = window.fastStream?.progressMemory?.indexedDbManager;
      if (!manager) return done();
      manager.clearStorage().then(() => done(), () => done());
    });
  });

  it('finishes setting up a video whose seek preview fails to build', async function() {
    // The rest of the setup came after the preview's, so a preview that failed took the
    // time in the URL, the video analyzer and autoplay with it, and showed an error.
    await openEmptyPlayer();
    await browser.execute(() => {
      const loader = window.fastStream.playerLoader;
      const createPlayer = loader.createPlayer.bind(loader);
      loader.createPlayer = (mode, client, options) => options?.isPreview ?
        Promise.reject(new Error('no preview here')) : createPlayer(mode, client, options);
    });
    await addSource(`${mp4Url()}?faststream-timestamp=4`);
    await waitForPicture();

    let state;
    await browser.waitUntil(async () => {
      state = await browser.execute(() => ({
        currentTime: window.fastStream.currentTime,
        failed: !!window.fastStream.interfaceController.failed,
        alert: !!document.querySelector('.fs-dialog'),
      }));
      return state.currentTime >= 3.9;
    }, {timeout: 10000, interval: 250}).catch(() => {});
    console.log('      state:', JSON.stringify(state));

    expect(state.currentTime).toBeGreaterThanOrEqual(3.9);
    expect(state.alert).toBe(false);
    expect(state.failed).toBe(false);
  });

  it('does not seek a video to the time of the source before it', async function() {
    // The first source never gets a picture. Its wait for one used to outlive it and to
    // end when the next source had one, which was then sought to the first one's time.
    await openEmptyPlayer();
    await addSource(`${missingUrl()}?faststream-timestamp=8`);
    await browser.pause(1500);
    await addSource(mp4Url());
    await waitForPicture();
    // The wait checks once a second.
    await browser.pause(2500);

    const currentTime = await browser.execute(() => window.fastStream.currentTime);
    console.log('      currentTime:', currentTime);
    expect(currentTime).toBeLessThan(1);
  });

  it('moves a separate audio track along with an undone or redone seek', async function() {
    // Undo and redo set the video's time without the client's setter, which is what moves
    // the synced audio player too; it caught up only on its next check.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();

    const moves = await browser.execute(() => {
      const client = window.fastStream;
      const audio = [];
      const setCurrentTime = client.syncedAudioPlayer.setCurrentTime.bind(client.syncedAudioPlayer);
      client.syncedAudioPlayer.setCurrentTime = (time) => {
        audio.push(time);
        setCurrentTime(time);
      };
      client.currentTime = 5;
      client.undoSeek();
      const afterUndo = {audio: audio.slice(), state: client.state.currentTime};
      client.redoSeek();
      return {afterUndo, afterRedo: {audio, state: client.state.currentTime}};
    });
    console.log('      moves:', JSON.stringify(moves));

    expect(moves.afterUndo.audio).toEqual([5, 0]);
    expect(moves.afterUndo.state).toBe(0);
    expect(moves.afterRedo.audio).toEqual([5, 0, 5]);
    expect(moves.afterRedo.state).toBe(5);
  });

  it('does not start a video at the remembered time of the one before it', async function() {
    // Looking up a video's remembered time takes two PBKDF2 hashes. The lookup of a video
    // replaced meanwhile wrote its record after the next video's reset: that video then
    // skipped its own lookup, started at the other's time, and saved into its record.
    await openEmptyPlayer();
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.progressMemory),
        {timeout: 30000, timeoutMsg: 'the progress memory never loaded'});

    const result = await browser.executeAsync((firstUrl, secondUrl, done) => {
      (async () => {
        const [{VideoSource}, {URLUtils}] =
          await Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')]);
        const client = window.fastStream;
        const memory = client.progressMemory;
        const source = (url) => new VideoSource(url, {}, URLUtils.getModeFromURL(url));
        const first = source(firstUrl);
        const second = source(secondUrl);
        client.options.storeProgress = true;
        const firstHashes = await memory.getHashes(first.identifier);
        const secondHashes = await memory.getHashes(second.identifier);
        await memory.setFile(firstHashes, {lastTime: 3});
        // The hashes are ArrayBuffers.
        const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
        window.hexOfHash = hex;

        // The first video's lookup is held until the second video's reset has run, and the
        // second's player is made only once that lookup is done, or after a second when
        // it gives up, as it should.
        let lookupStarted;
        const started = new Promise((resolve) => lookupStarted = resolve);
        let releaseLookup;
        const released = new Promise((resolve) => releaseLookup = resolve);
        let lookupDone;
        const finished = new Promise((resolve) => lookupDone = resolve);
        const getHashes = memory.getHashes.bind(memory);
        memory.getHashes = async (identifier) => {
          const hashes = await getHashes(identifier);
          if (identifier === first.identifier) {
            lookupStarted();
            await released;
          }
          return hashes;
        };
        const getFile = memory.getFile.bind(memory);
        memory.getFile = async (hashes) => {
          const file = await getFile(hashes);
          if (hex(hashes.identifierHash) === hex(firstHashes.identifierHash)) setTimeout(lookupDone);
          return file;
        };

        client.addSource(first, true);
        await started;
        const resetPlayer = client.resetPlayer.bind(client);
        client.resetPlayer = async (...args) => {
          await resetPlayer(...args);
          releaseLookup();
        };
        const loader = client.playerLoader;
        const createPlayer = loader.createPlayer.bind(loader);
        loader.createPlayer = async (mode, owner, options) => {
          if (!options?.isPreview) {
            await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 1000))]);
          }
          return createPlayer(mode, owner, options);
        };
        await client.addSource(second, true);
        return {secondRecord: hex(secondHashes.identifierHash)};
      })().then(done, (e) => done({error: String(e)}));
    }, missingUrl(), mp4Url());
    expect(result.error).toBe(undefined);

    await waitForPicture();
    // The lookup keeps its hashes when it is done: the second video's own, or with the bug,
    // the first's. A fixed wait could end before the second's two hashes on a slow runner,
    // and the test would then blame the race.
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.progressHashesCache),
        {timeout: 30000, timeoutMsg: 'the second video\'s remembered-time lookup never finished'});
    // The seek to a remembered time comes once the player is ready.
    await browser.pause(500);
    const state = await browser.execute(() => {
      const hashes = window.fastStream.progressHashesCache;
      return {
        currentTime: window.fastStream.currentTime,
        record: hashes ? window.hexOfHash(hashes.identifierHash) : null,
      };
    });
    console.log('      state:', JSON.stringify(state));
    expect(state.currentTime).toBeLessThan(1);
    expect(state.record).toBe(result.secondRecord);
  });

  it('finishes setting up a video whose remembered time cannot be read', async function() {
    // The lookup threw on (a record that does not decrypt, IndexedDB failing), and the rest
    // of the setup waits on it: the seek to the time in the URL never came.
    await openEmptyPlayer();
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.progressMemory),
        {timeout: 30000, timeoutMsg: 'the progress memory never loaded'});
    await browser.execute(() => {
      window.fastStream.options.storeProgress = true;
      window.fastStream.progressMemory.getFile = async () => {
        throw new Error('OperationError: the record does not decrypt');
      };
    });
    await addSource(`${mp4Url()}?faststream-timestamp=4`);
    await waitForPicture();

    let currentTime = 0;
    await browser.waitUntil(async () => {
      currentTime = await browser.execute(() => window.fastStream.currentTime);
      return currentTime >= 3.9;
    }, {timeout: 10000, interval: 250}).catch(() => {});
    console.log('      currentTime:', currentTime);
    expect(currentTime).toBeGreaterThanOrEqual(3.9);
  });

  it('gives the next video a seek preview when the one before changed while its preview built', async function() {
    // A preview build that turning previews on started (not the setup of a source, which
    // the next source waits for) was still running when the next video came. That video
    // joined it; the build then threw its preview away (its source was gone), and the next
    // video had none.
    await openEmptyPlayer();
    await browser.execute(() => {
      const client = window.fastStream;
      client.options.previewEnabled = false;
      const loader = client.playerLoader;
      const createPlayer = loader.createPlayer.bind(loader);
      // Each build is held until the case lets it go.
      window.releasePreview = [];
      loader.createPlayer = async (mode, client, options) => {
        if (options?.isPreview) {
          await new Promise((resolve) => window.releasePreview.push(resolve));
        }
        return createPlayer(mode, client, options);
      };
      const buildPreviewPlayer = client.buildPreviewPlayer.bind(client);
      window.previewBuilds = [];
      client.buildPreviewPlayer = () => {
        const build = {done: false};
        window.previewBuilds.push(build);
        return buildPreviewPlayer().finally(() => build.done = true);
      };
    });
    await addSource(`${mp4Url()}?first`);
    await waitForPicture();
    // What setOptions() does when previews are turned on.
    await browser.execute(() => {
      window.fastStream.options.previewEnabled = true;
      window.fastStream.setupPreviewPlayer();
    });
    await browser.waitUntil(async () => browser.execute(() => window.releasePreview.length === 1),
        {timeout: 10000, timeoutMsg: 'the first video never started its preview'});
    await addSource(`${mp4Url()}?second`);
    await browser.waitUntil(async () => browser.execute(() => window.releasePreview.length === 2),
        {timeout: 30000, timeoutMsg: 'the second video never started its preview'});

    // The first build ends (and throws its preview away) while the second is still held: a
    // caller then joins the second, rather than starting a third.
    await browser.execute(() => window.releasePreview[0]());
    await browser.waitUntil(async () => browser.execute(() => window.previewBuilds[0].done),
        {timeout: 10000, timeoutMsg: 'the first preview build never ended'});
    await browser.execute(() => {
      window.fastStream.setupPreviewPlayer();
      window.releasePreview[1]();
    });

    let state;
    await browser.waitUntil(async () => {
      state = await browser.execute(() => ({
        builds: window.previewBuilds.length,
        preview: window.fastStream.previewPlayer?.getSource()?.url || null,
      }));
      return !!state.preview;
    }, {timeout: 10000, interval: 250}).catch(() => {});
    console.log('      state:', JSON.stringify(state));
    expect(state.preview).toContain('?second');
    expect(state.builds).toBe(2);
  });

  it('does not reuse the wait for a picture of a source that never had one', async function() {
    // The next source joined that wait, which listened on the player before it: its own
    // picture was only noticed by the wait's once-a-second check.
    await openEmptyPlayer();
    await browser.execute(() => {
      const client = window.fastStream;
      const setupInitHook = client.setupInitHook.bind(client);
      window.initHooks = 0;
      client.setupInitHook = () => {
        window.initHooks++;
        return setupInitHook();
      };
    });
    await addSource(missingUrl());
    await browser.pause(1500);
    await addSource(mp4Url());
    await waitForPicture();

    const hooks = await browser.execute(() => window.initHooks);
    expect(hooks).toBe(2);
  });

  it('shows the video as paused when a pause comes while a play is still starting', async function() {
    // play() went on after the pause, and showed "playing" over the paused video.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();

    const state = await browser.executeAsync((done) => {
      const client = window.fastStream;
      const player = client.player;
      const play = player.play.bind(player);
      player.play = async () => {
        await play();
        await new Promise((resolve) => setTimeout(resolve, 500));
      };
      client.currentVideo.muted = true;
      const playing = client.play();
      setTimeout(async () => {
        await client.pause();
        await playing;
        done({paused: client.currentVideo.paused, shown: client.state.playing});
      }, 100);
    });
    console.log('      state:', JSON.stringify(state));
    expect(state.paused).toBe(true);
    expect(state.shown).toBe(false);
  });

  it('shows the video as playing when a play comes while a pause is still going', async function() {
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();

    const state = await browser.executeAsync((done) => {
      const client = window.fastStream;
      const player = client.player;
      client.currentVideo.muted = true;
      client.play().then(() => {
        const pause = player.pause.bind(player);
        player.pause = async () => {
          await pause();
          await new Promise((resolve) => setTimeout(resolve, 500));
        };
        const pausing = client.pause();
        setTimeout(() => {
          client.play().catch(() => {});
          pausing.then(() => setTimeout(() => {
            done({paused: client.currentVideo.paused, shown: client.state.playing});
          }, 100));
        }, 100);
      }, (e) => done({error: String(e)}));
    });
    console.log('      state:', JSON.stringify(state));
    expect(state.paused).toBe(false);
    expect(state.shown).toBe(true);
  });

  it('finishes a play when the audio cannot start, as with no sound device', async function() {
    // On a machine with no sound device (CI's Linux runner) the AudioContext stays
    // suspended and its resume() never settles; play() waited for it and never finished.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();

    const state = await browser.executeAsync((done) => {
      const client = window.fastStream;
      client.currentVideo.muted = true;
      const context = client.audioContext;
      context.suspend().then(() => {
        let resumes = 0;
        context.resume = () => {
          resumes++;
          return new Promise(() => {});
        };
        const giveUp = setTimeout(() => done({settled: false, resumes}), 5000);
        client.play().then(() => client.play()).then(() => {
          clearTimeout(giveUp);
          done({
            settled: true,
            resumes,
            paused: client.currentVideo.paused,
            shown: client.state.playing,
          });
        }, (e) => {
          clearTimeout(giveUp);
          done({error: String(e)});
        });
      }, (e) => done({error: String(e)}));
    });
    console.log('      state:', JSON.stringify(state));
    expect(state.settled).toBe(true);
    expect(state.paused).toBe(false);
    expect(state.shown).toBe(true);
    // The second play() found the context still starting and left it be.
    expect(state.resumes).toBe(1);
  });

  it('ignores the keys and menus that act on the video while there is none', async function() {
    // Between two sources there is no player: a key pressed then threw.
    await openEmptyPlayer();
    const errors = await browser.executeAsync((done) => {
      const client = window.fastStream;
      const errors = [];
      const attempt = async (name, action) => {
        try {
          await action();
        } catch (e) {
          errors.push(`${name}: ${e}`);
        }
      };
      (async () => {
        client.pastSeeks.push(5);
        client.pastUnseeks.push(5);
        await attempt('pause', () => client.pause());
        await attempt('undoSeek', () => client.undoSeek());
        await attempt('redoSeek', () => client.redoSeek());
        await attempt('setCurrentVideoLevelID', () => client.setCurrentVideoLevelID('0'));
        await attempt('setCurrentAudioLevelID', () => client.setCurrentAudioLevelID('0'));
        done(errors);
      })();
    });
    expect(errors).toEqual([]);
  });
});
