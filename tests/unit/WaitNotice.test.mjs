import {afterEach, describe, expect, it, vi} from 'vitest';
import {Localize} from '../../chrome/player/modules/Localize.mjs';
import {EnvUtils} from '../../chrome/player/utils/EnvUtils.mjs';

// StatusManager's elements are the page's.
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
const {WaitNotice, waitCause} = await import('../../chrome/player/ui/WaitNotice.mjs');

// A video that stops to load names the setting behind it, when one is: the #798 pattern for the other limits. Each of
// these keeps the client from downloading ahead (FastStreamClient.predownloadFragments, updateHasDownloadSpace), so
// only the players' own 10-30 s are buffered and a short slowdown of the line stops the video.

const MB = 1e6;
const video = {rate: 1.25 * MB, speed: 0.5 * MB, ramOnly: false, aheadKept: 120, live: false};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('waitCause', () => {
  it('says nothing with no limit set (the defaults)', () => {
    expect(waitCause({maxSpeed: -1, bufferAhead: 120, ramBudget: 2e9}, video)).toBeNull();
  });

  it('names a download speed of 0', () => {
    expect(waitCause({maxSpeed: 0}, video)).toEqual({key: 'player_wait_speed_zero'});
  });

  it('names a download speed below the video\'s, in Mbit/s', () => {
    // 0.5 MB/s is 4 Mbit/s; the video's 1.25 MB/s is 10.
    expect(waitCause({maxSpeed: 0.5 * MB}, video)).toEqual({key: 'player_wait_speed_low',
      args: [(4).toLocaleString(), (10).toLocaleString()]});
    expect(waitCause({maxSpeed: 2 * MB}, video)).toBeNull();
    // The video's rate not known yet: no claim.
    expect(waitCause({maxSpeed: 0.5 * MB}, {...video, rate: 0})).toBeNull();
  });

  it('does not blame the speed limit when the line is slower than it: raising the limit would not help', () => {
    // A 10 Mbit/s video over a 2 Mbit/s line with a limit of 4: the downloads never reach the limit.
    expect(waitCause({maxSpeed: 0.5 * MB}, {...video, speed: 0.25 * MB})).toBeNull();
    // Held at the limit: they stop above it and start again below it.
    expect(waitCause({maxSpeed: 0.5 * MB}, {...video, speed: 0.45 * MB})?.key).toBe('player_wait_speed_low');
  });

  it('names 0 seconds ahead only when the client keeps none ahead', () => {
    expect(waitCause({bufferAhead: 0}, {...video, aheadKept: 0})).toEqual({key: 'player_wait_ahead_zero'});
    // Predownload on keeps more ahead than the setting.
    expect(waitCause({bufferAhead: 0}, video)).toBeNull();
  });

  it('names a RAM of 0 only where nothing is kept on disk', () => {
    expect(waitCause({ramBudget: 0}, {...video, ramOnly: true})).toEqual({key: 'player_wait_ram_zero'});
    expect(waitCause({ramBudget: 0}, video)).toBeNull();
  });

  it('says nothing for a live stream, which waits for its next segment', () => {
    expect(waitCause({maxSpeed: 0}, {...video, live: true})).toBeNull();
  });
});

describe('WaitNotice', () => {
  /** A client that stalls while playing, with these options. */
  const stalled = (options) => {
    const client = {
      options, source: {}, state: {buffering: true, playing: true, bufferAhead: 0},
      videoRate: () => 1.25 * MB, isLive: () => false, downloadManager: {paused: false, getSpeed: () => 0},
      interfaceController: {setStatusMessage: vi.fn()},
    };
    return {client, notice: new WaitNotice(/** @type {any} */ (client))};
  };
  const said = (client) => client.interfaceController.setStatusMessage.mock.calls.map((call) => call[1]);

  it('tells the cause after the video waited 2 s while playing, once per video, as an info for 12 s', () => {
    vi.spyOn(Localize, 'getMessage').mockImplementation((key) => key);
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(false);
    const {client, notice} = stalled({maxSpeed: 0});
    notice.check(0);
    notice.check(1999);
    expect(said(client)).toEqual([]);
    notice.check(2000);
    expect(said(client)).toEqual(['player_wait_speed_zero']);
    expect(client.interfaceController.setStatusMessage).toHaveBeenCalledWith('info', 'player_wait_speed_zero', 'info', 12000);
    // Played on, waited again: told already.
    client.state.buffering = false;
    notice.check(3000);
    client.state.buffering = true;
    notice.check(4000);
    notice.check(7000);
    expect(said(client)).toHaveLength(1);
    // The next video is told again.
    client.source = {};
    notice.check(7100);
    expect(said(client)).toHaveLength(2);
  });

  it('counts the 2 s from the start of each wait, and not while paused or loading at the start', () => {
    vi.spyOn(Localize, 'getMessage').mockImplementation((key) => key);
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(false);
    const {client, notice} = stalled({maxSpeed: 0});
    notice.check(0);
    client.state.buffering = false;
    notice.check(1500);
    client.state.buffering = true;
    notice.check(1600);
    notice.check(3000);
    expect(said(client)).toEqual([]);
    client.state.playing = false;
    notice.check(9000);
    expect(said(client)).toEqual([]);
  });

  it('leaves a download pause to its own message, which names the key that resumes', () => {
    vi.spyOn(Localize, 'getMessage').mockImplementation((key) => key);
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(false);
    const {client, notice} = stalled({maxSpeed: 0});
    client.downloadManager.paused = true;
    notice.check(0);
    notice.check(5000);
    expect(said(client)).toEqual([]);
  });

  it('says nothing when no setting is behind the wait (a slow line)', () => {
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(false);
    const {client, notice} = stalled({maxSpeed: -1, bufferAhead: 120, ramBudget: 2e9});
    client.state.bufferAhead = 120;
    notice.check(0);
    notice.check(5000);
    expect(said(client)).toEqual([]);
  });

  it('reads a private window as keeping nothing on disk', () => {
    vi.spyOn(Localize, 'getMessage').mockImplementation((key) => key);
    vi.spyOn(EnvUtils, 'isIncognito').mockReturnValue(true);
    const {client, notice} = stalled({ramBudget: 0});
    notice.check(0);
    notice.check(2000);
    expect(said(client)).toEqual(['player_wait_ram_zero']);
  });
});
