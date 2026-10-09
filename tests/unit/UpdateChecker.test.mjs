import {afterEach, describe, expect, it, vi} from 'vitest';

import {RequestUtils} from '../../chrome/player/utils/RequestUtils.mjs';
import {UpdateChecker} from '../../chrome/player/utils/UpdateChecker.mjs';

// The GitHub build's options page asks GitHub for the latest version (UpdateChecker). Offline,
// requestSimple gives no request back, and reading its status threw a TypeError in the
// options page of every player opened, instead of "no update known".
describe('UpdateChecker.getLatestVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const answer = (xhr) => vi.spyOn(RequestUtils, 'requestSimple').mockResolvedValue(xhr);

  it('reads the version from package.json', async () => {
    answer({status: 200, responseText: JSON.stringify({version: '1.3.82.72'})});
    expect(await UpdateChecker.getLatestVersion()).toBe('1.3.82.72');
  });

  it('knows of no update without an answer, with a bad one, or with no version in it', async () => {
    for (const xhr of [undefined, {status: 404, responseText: ''}, {status: 200, responseText: '<html>'},
      {status: 200, responseText: '{}'}, {status: 200, responseText: '{"version": 2}'}]) {
      answer(xhr);
      expect(await UpdateChecker.getLatestVersion()).toBe(null);
    }
  });
});
