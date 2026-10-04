import {describe, expect, it} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {SaveFragmentFetcher} from '../../chrome/player/players/SaveFragmentFetcher.mjs';

// A save reads its fragments one after the other. SaveFragmentFetcher downloads the next
// few while the current one is read. The requester here is a stand-in for a player's: it
// records each request, and the test finishes, fails or aborts them.

/**
 * @param {Object} [options]
 * @param {boolean} [options.sharedWithPlayback] whether an abort leaves the download to
 *     another watcher, so the request hears nothing (DownloadEntry.abortWatcher)
 * @return {{requests: Object[], requestFragment: Function}}
 */
function makeRequester({sharedWithPlayback = false} = {}) {
  const requests = [];
  return {
    requests,
    requestFragment(fragment, callbacks, config, priority) {
      const request = {fragment, callbacks, priority, aborted: false, settled: false};
      request.succeed = () => {
        fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
        request.settled = true;
        callbacks.onSuccess();
      };
      request.fail = () => {
        fragment.status = DownloadStatus.DOWNLOAD_FAILED;
        request.settled = true;
        callbacks.onFail();
      };
      request.abortByManager = () => {
        request.settled = true;
        callbacks.onAbort();
      };
      requests.push(request);
      return {
        abort: () => {
          request.aborted = true;
          request.settled = true;
          if (!sharedWithPlayback) callbacks.onAbort();
        },
      };
    },
  };
}

/** @return {Object[]} fragments nothing has downloaded yet */
const fragments = (count) => Array.from({length: count}, (_, sn) => ({sn, status: DownloadStatus.WAITING}));

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {Object} requester
 * @return {number[]} the fragments asked for and not finished, by number
 */
const running = (requester) => requester.requests.filter((r) => !r.settled).map((r) => r.fragment.sn);

/**
 * Whether a promise has settled yet.
 * @param {Promise} promise
 * @return {Promise<boolean>}
 */
async function isSettled(promise) {
  let settled = false;
  promise.then(() => settled = true, () => settled = true);
  await settle();
  return settled;
}

describe('SaveFragmentFetcher', () => {
  it('asks for the next fragments while one is read, never more than `ahead` at once', async () => {
    const requester = makeRequester();
    const frags = fragments(6);
    const fetcher = new SaveFragmentFetcher(requester, frags, 3);

    const first = fetcher.get(0);
    await settle();
    expect(running(requester)).toEqual([0, 1, 2]);
    expect(requester.requests.every((r) => r.priority === -1)).toBe(true);

    requester.requests[0].succeed();
    await first;
    const second = fetcher.get(1);
    await settle();
    expect(running(requester)).toEqual([1, 2, 3]);
    requester.requests[1].succeed();
    await second;
  });

  it('downloads one at a time with a downloader limit of 1, as saves always did', async () => {
    const requester = makeRequester();
    const fetcher = new SaveFragmentFetcher(requester, fragments(3), 1);
    const first = fetcher.get(0);
    await settle();
    expect(running(requester)).toEqual([0]);
    requester.requests[0].succeed();
    await first;
  });

  it('gives each fragment in its turn, whatever order the downloads finish in', async () => {
    const requester = makeRequester();
    const fetcher = new SaveFragmentFetcher(requester, fragments(3), 3);
    const first = fetcher.get(0);
    await settle();
    requester.requests[2].succeed();
    requester.requests[1].succeed();
    expect(await isSettled(first)).toBe(false);
    requester.requests[0].succeed();
    await first;
    await fetcher.get(1);
    await fetcher.get(2);
    expect(requester.requests).toHaveLength(3);
  });

  it('does not ask for a fragment that is already downloaded', async () => {
    const requester = makeRequester();
    const frags = fragments(3);
    frags[1].status = DownloadStatus.DOWNLOAD_COMPLETE;
    const fetcher = new SaveFragmentFetcher(requester, frags, 3);
    const first = fetcher.get(0);
    await settle();
    expect(running(requester)).toEqual([0, 2]);
    requester.requests[0].succeed();
    await first;
    await fetcher.get(1);
  });

  it('asks again for a download the manager gave up, as saves always did', async () => {
    const requester = makeRequester();
    const fetcher = new SaveFragmentFetcher(requester, fragments(1), 2);
    const first = fetcher.get(0);
    await settle();
    requester.requests[0].abortByManager();
    await settle();
    expect(running(requester)).toEqual([0]);
    requester.requests[1].succeed();
    await first;
  });

  it('fails the save at a failed fragment\'s turn, not before', async () => {
    const requester = makeRequester();
    const fetcher = new SaveFragmentFetcher(requester, fragments(3), 3);
    const first = fetcher.get(0);
    await settle();
    requester.requests[1].fail();
    requester.requests[0].succeed();
    await first;
    await expect(fetcher.get(1)).rejects.toThrow('Failed to download fragment');
  });

  it('aborts what is still downloading when the save is cancelled, and starts nothing more', async () => {
    const requester = makeRequester();
    const fetcher = new SaveFragmentFetcher(requester, fragments(6), 3);
    const first = fetcher.get(0);
    await settle();
    fetcher.cancel();

    await expect(first).rejects.toThrow('Cancelled');
    expect(requester.requests.map((r) => r.aborted)).toEqual([true, true, true]);
    await expect(fetcher.get(1)).rejects.toThrow('Cancelled');
    expect(requester.requests).toHaveLength(3);
  });

  it('does not wait for a download playback watches too when the save is cancelled', async () => {
    // The download manager drops the save's request quietly and goes on for playback.
    const requester = makeRequester({sharedWithPlayback: true});
    const fetcher = new SaveFragmentFetcher(requester, fragments(2), 2);
    const first = fetcher.get(0);
    await settle();
    fetcher.cancel();
    await expect(first).rejects.toThrow('Cancelled');
  });
});
