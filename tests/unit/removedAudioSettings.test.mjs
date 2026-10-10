import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// The audio settings window went on 2026-10-10. What it kept - its profiles in storage and
// the impulse response files in IndexedDB - is forgotten once, when that update installs.

let BackgroundUtils;
let removed;
let deleted;
let onInstalled;

beforeAll(async () => {
  // BackgroundUtils reads the player URL when it loads.
  globalThis.chrome = {runtime: {getURL: (file) => 'moz-extension://test/' + file}};
  ({BackgroundUtils} = await import('../../chrome/background/BackgroundUtils.mjs'));
});

beforeEach(() => {
  removed = [];
  deleted = [];
  onInstalled = null;
  globalThis.chrome = {
    runtime: {
      getURL: (file) => 'moz-extension://test/' + file,
      onInstalled: {addListener: (fn) => {
        onInstalled = fn;
      }},
    },
    // As Firefox's: a promise, settled later.
    storage: {local: {remove: (keys) => new Promise((resolve) => setTimeout(() => {
      removed.push(...keys);
      resolve();
    }, 0))}},
  };
  globalThis.indexedDB = {deleteDatabase: (name) => {
    const request = {};
    setTimeout(() => {
      deleted.push(name);
      request.onsuccess?.();
    }, 0);
    return request;
  }};
});

afterEach(() => {
  delete globalThis.indexedDB;
});

describe('BackgroundUtils.forgetRemovedAudioSettingsOnUpdate', () => {
  it('forgets the audio profiles and the impulse files when an update installs', async () => {
    BackgroundUtils.forgetRemovedAudioSettingsOnUpdate();
    await onInstalled({reason: 'update', previousVersion: '1.3.82.78'});
    expect(removed).toEqual(['audioProfiles', 'currentAudioProfile']);
    expect(deleted).toEqual(['faststream-impulse-responses']);
  });

  it('leaves a fresh install alone (there is nothing to forget)', async () => {
    BackgroundUtils.forgetRemovedAudioSettingsOnUpdate();
    await onInstalled({reason: 'install'});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(removed).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('still forgets the profiles where IndexedDB is refused', async () => {
    globalThis.indexedDB = {deleteDatabase: () => {
      throw new Error('SecurityError');
    }};
    await expect(BackgroundUtils.forgetRemovedAudioSettings()).resolves.toBeUndefined();
    expect(removed).toEqual(['audioProfiles', 'currentAudioProfile']);
  });

  it('settles when the storage refuses, and still deletes the impulse files', async () => {
    chrome.storage.local.remove = () => Promise.reject(new Error('storage gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(BackgroundUtils.forgetRemovedAudioSettings()).resolves.toBeUndefined();
    expect(deleted).toEqual(['faststream-impulse-responses']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
