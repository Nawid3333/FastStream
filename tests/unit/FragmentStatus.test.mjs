import {describe, expect, it, vi} from 'vitest';
import {DefaultPlayerEvents} from '../../chrome/player/enums/DefaultPlayerEvents.mjs';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {Fragment} from '../../chrome/player/players/Fragment.mjs';
import {fragmentDownloadCallbacks, markRequested} from '../../chrome/player/players/FragmentStatus.mjs';

// The fragment status every player's requester keeps: the progress bar draws from it, and an
// aborted fragment is asked for again.

/** A player that records each FRAGMENT_UPDATE's status as it was told. */
const player = () => {
  const told = [];
  return {told, emit: vi.fn((event, fragment) => {
    if (event === DefaultPlayerEvents.FRAGMENT_UPDATE) told.push(fragment.status);
  })};
};
const statuses = (p) => p.told;
const entry = (data, dataSize = 3) => ({dataSize, getDataFromBlob: vi.fn(async () => data)});

describe('markRequested', () => {
  it('marks a waiting fragment as downloading, and tells the player', () => {
    const p = player();
    const fragment = new Fragment(0, 1);
    markRequested(p, fragment);
    expect(fragment.status).toBe(DownloadStatus.DOWNLOAD_INITIATED);
    expect(statuses(p)).toEqual([DownloadStatus.DOWNLOAD_INITIATED]);
  });

  it('leaves a fragment in any other state as it is, and says nothing', () => {
    const p = player();
    const fragment = new Fragment(0, 1);
    fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
    markRequested(p, fragment);
    expect(fragment.status).toBe(DownloadStatus.DOWNLOAD_COMPLETE);
    expect(p.emit).not.toHaveBeenCalled();
  });
});

describe('fragmentDownloadCallbacks', () => {
  it('reads the data, marks the fragment complete, then hands the data on', async () => {
    const p = player();
    const fragment = new Fragment(0, 1);
    const succeed = vi.fn(() => expect(fragment.status).toBe(DownloadStatus.DOWNLOAD_COMPLETE));
    const data = new ArrayBuffer(3);
    const e = entry(data);
    await fragmentDownloadCallbacks(p, fragment, {onFail: vi.fn()}, succeed).onSuccess(e);
    expect(succeed).toHaveBeenCalledWith(e, data);
    expect(fragment.dataSize).toBe(3);
    expect(statuses(p)).toEqual([DownloadStatus.DOWNLOAD_COMPLETE]);
  });

  it('reads nothing when skipProcess asks for none', async () => {
    const p = player();
    const succeed = vi.fn();
    const e = entry(new ArrayBuffer(3));
    await fragmentDownloadCallbacks(p, new Fragment(0, 1), {skipProcess: true, onFail: vi.fn()}, succeed).onSuccess(e);
    expect(e.getDataFromBlob).not.toHaveBeenCalled();
    expect(succeed).toHaveBeenCalledWith(e, undefined);
  });

  it('tells a fragment complete already nothing more', async () => {
    const p = player();
    const fragment = new Fragment(0, 1);
    fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
    await fragmentDownloadCallbacks(p, fragment, {onFail: vi.fn()}, vi.fn()).onSuccess(entry(new ArrayBuffer(1)));
    expect(p.emit).not.toHaveBeenCalled();
  });

  it('keeps why a download failed', () => {
    const fragment = new Fragment(0, 1);
    fragmentDownloadCallbacks(player(), fragment, {onFail: vi.fn()}, vi.fn())
        .onFail({stats: {error: {code: 403, text: 'Forbidden', page: 'HTTP 403'}}});
    expect(fragment.failure).toBe('HTTP 403; through the page: HTTP 403');
  });

  it('counts stored data that cannot be read as a failed download', async () => {
    const p = player();
    const fragment = new Fragment(0, 1);
    const onFail = vi.fn();
    const succeed = vi.fn();
    const e = {dataSize: 0, getDataFromBlob: vi.fn(async () => {
      throw new Error('gone');
    })};
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await fragmentDownloadCallbacks(p, fragment, {onFail}, succeed).onSuccess(e);
    expect(fragment.status).toBe(DownloadStatus.DOWNLOAD_FAILED);
    expect(fragment.failure).toBe('gone');
    expect(onFail).toHaveBeenCalledWith(e);
    expect(succeed).not.toHaveBeenCalled();
    expect(statuses(p)).toEqual([DownloadStatus.DOWNLOAD_FAILED]);
  });

  it('leaves a failed download failed and an aborted one waiting, to be asked for again', () => {
    const p = player();
    const fragment = new Fragment(0, 1);
    const onFail = vi.fn();
    const onAbort = vi.fn();
    const callbacks = fragmentDownloadCallbacks(p, fragment, {onFail, onAbort}, vi.fn());
    const e = entry(null);
    callbacks.onFail(e);
    expect(fragment.status).toBe(DownloadStatus.DOWNLOAD_FAILED);
    expect(onFail).toHaveBeenCalledWith(e);
    callbacks.onAbort(e);
    expect(fragment.status).toBe(DownloadStatus.WAITING);
    expect(onAbort).toHaveBeenCalledWith(e);
    expect(statuses(p)).toEqual([DownloadStatus.DOWNLOAD_FAILED, DownloadStatus.WAITING]);
  });

  it('takes an abort without an onAbort of the caller', () => {
    const fragment = new Fragment(0, 1);
    fragmentDownloadCallbacks(player(), fragment, {onFail: vi.fn()}, vi.fn()).onAbort(entry(null));
    expect(fragment.status).toBe(DownloadStatus.WAITING);
  });
});
