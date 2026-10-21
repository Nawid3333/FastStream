import {afterEach, describe, expect, it, vi} from 'vitest';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// A storage read that failed answers nothing (runtime.lastError): getConfig read result[key]
// in the callback, threw there, and never settled - whatever waited for a setting waited for
// good (glm's review, 2026-10-22).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Utils.getConfig and setConfig', () => {
  it('answers unset when the storage read failed, instead of never', async () => {
    vi.stubGlobal('chrome', {extension: {}, runtime: {lastError: {message: 'storage gone'}},
      storage: {local: {get: (key, callback) => callback(undefined)}}});
    await expect(Utils.getConfig('volumeState')).resolves.toBeUndefined();
  });

  it('says so when a save failed, and still resolves', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('chrome', {extension: {}, runtime: {lastError: {message: 'QUOTA_BYTES quota exceeded'}},
      storage: {local: {set: (items, callback) => callback()}}});
    await expect(Utils.setConfig('volumeState', '{}')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Saving volumeState failed', {message: 'QUOTA_BYTES quota exceeded'});
  });
});
