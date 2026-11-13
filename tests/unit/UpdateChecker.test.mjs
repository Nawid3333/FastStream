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

// The options page, an iframe in every player, stored the update data at every load (which
// told every open options page), a failed check wrote null over the version known, and with
// no version known it asked GitHub again at every player opened.
describe('UpdateChecker.refreshUpdateData', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const HOUR = 1000 * 60 * 60;
  const now = 1000 * HOUR;
  const latest = (version) => vi.spyOn(UpdateChecker, 'getLatestVersion').mockResolvedValue(version);

  it('checks when it never did, and gives what to store', async () => {
    const asked = latest('1.3.82.200');
    expect(await UpdateChecker.refreshUpdateData({}, now)).toEqual({latestVersion: '1.3.82.200', lastUpdateCheck: now});
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('checks again after 12 hours, and keeps the version the user said no to', async () => {
    latest('1.3.82.201');
    const data = {latestVersion: '1.3.82.200', lastUpdateCheck: now - 13 * HOUR, ignoreVersion: '1.3.82.200'};
    expect(await UpdateChecker.refreshUpdateData(data, now)).toEqual({
      latestVersion: '1.3.82.201', lastUpdateCheck: now, ignoreVersion: '1.3.82.200',
    });
  });

  it('neither asks nor gives anything to store within 12 hours of a check', async () => {
    const asked = latest('1.3.82.201');
    expect(await UpdateChecker.refreshUpdateData({latestVersion: '1.3.82.200', lastUpdateCheck: now - HOUR}, now)).toBe(null);
    expect(asked).not.toHaveBeenCalled();
  });

  it('keeps the version known when a check fails', async () => {
    latest(null);
    expect(await UpdateChecker.refreshUpdateData({latestVersion: '1.3.82.200', lastUpdateCheck: now - 13 * HOUR}, now))
        .toEqual({latestVersion: '1.3.82.200', lastUpdateCheck: now});
    expect(await UpdateChecker.refreshUpdateData({}, now)).toEqual({latestVersion: null, lastUpdateCheck: now});
  });

  it('waits 12 hours after a failed check too, with no version known', async () => {
    const asked = latest('1.3.82.200');
    expect(await UpdateChecker.refreshUpdateData({latestVersion: null, lastUpdateCheck: now - HOUR}, now)).toBe(null);
    expect(asked).not.toHaveBeenCalled();
  });
});
