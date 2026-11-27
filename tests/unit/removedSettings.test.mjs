import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// What removed features kept is forgotten once, on update: the audio settings window's profiles and impulse
// responses (IndexedDB), and the options page's list of sites where autoplay got stuck.

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

describe('BackgroundUtils.forgetRemovedSettingsOnUpdate', () => {
  it('forgets the audio profiles, the impulse files and the stuck-sites list when an update installs', async () => {
    BackgroundUtils.forgetRemovedSettingsOnUpdate();
    await onInstalled({reason: 'update', previousVersion: '1.3.82.78'});
    expect(removed).toEqual(['audioProfiles', 'currentAudioProfile', 'siteProblems']);
    expect(deleted).toEqual(['faststream-impulse-responses']);
  });

  it('leaves a fresh install alone (there is nothing to forget)', async () => {
    BackgroundUtils.forgetRemovedSettingsOnUpdate();
    await onInstalled({reason: 'install'});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(removed).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('still forgets the profiles where IndexedDB is refused', async () => {
    globalThis.indexedDB = {deleteDatabase: () => {
      throw new Error('SecurityError');
    }};
    await expect(BackgroundUtils.forgetRemovedSettings()).resolves.toBeUndefined();
    expect(removed).toEqual(['audioProfiles', 'currentAudioProfile', 'siteProblems']);
  });

  it('settles when the storage refuses, and still deletes the impulse files', async () => {
    chrome.storage.local.remove = () => Promise.reject(new Error('storage gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(BackgroundUtils.forgetRemovedSettings()).resolves.toBeUndefined();
    expect(deleted).toEqual(['faststream-impulse-responses']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
