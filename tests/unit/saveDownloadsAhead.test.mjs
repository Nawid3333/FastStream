import {afterEach, describe, expect, it, vi} from 'vitest';
import {DownloadStatus} from '../../chrome/player/enums/DownloadStatus.mjs';
import {Fragment} from '../../chrome/player/players/Fragment.mjs';

// A save of a stream that is not buffered yet downloads its fragments as it goes. Each
// player's saveVideo asked for one, waited, converted it, and only then asked for the
// next. These run the three players' saveVideo with a stand-in network (each request is
// recorded and finished when the test says) and a stand-in converter that reads the
// fragments in order, as the real ones do.

vi.mock('../../chrome/player/modules/hls.mjs', () => ({Hls: class {}, AbrController: class {}}));
vi.mock('../../chrome/player/modules/dash.mjs', () => ({MediaPlayer: () => ({create: () => ({})})}));

/**
 * A converter that reads every fragment's entry in turn, as HLS2MP4, MP4Merger and the
 * remuxer do, and makes a file of the bytes it read.
 */
class FakeConverter {
  constructor(registerCancel) {
    registerCancel?.(() => {
      this.cancelled = true;
    });
  }
  on() {}
  release() {}
  async convert(...args) {
    const zipped = args.at(-1);
    const parts = [];
    for (const data of zipped) {
      if (this.cancelled) throw new Error('Cancelled');
      const entry = await data.getEntry();
      parts.push(new Uint8Array(await entry.getDataFromBlob()));
    }
    return new Blob(parts);
  }
}

vi.mock('../../chrome/player/modules/hls2mp4/hls2mp4.mjs', () => ({HLS2MP4: FakeConverter}));
vi.mock('../../chrome/player/modules/dash2mp4/dash2mp4.mjs', () => ({DASH2MP4: FakeConverter}));

const {default: HLSPlayer} = await import('../../chrome/player/players/hls/HLSPlayer.mjs');
const {default: DashPlayer} = await import('../../chrome/player/players/dash/DashPlayer.mjs');
const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');

const COUNT = 8;
// The user's downloader limit.
const LIMIT = 3;

class TestFragment extends Fragment {
  constructor(sn) {
    super(0, sn);
    this.start = sn;
  }
  getContext() {
    return {sn: this.sn};
  }
}

/**
 * A network that records each request and finishes it when told.
 * @return {Object}
 */
function makeNetwork() {
  const requests = [];
  return {
    requests,
    running: () => requests.filter((r) => !r.settled).map((r) => r.fragment.sn),
    requestFragment(fragment, callbacks, config, priority) {
      const request = {fragment, priority, settled: false, aborted: false};
      request.succeed = () => {
        if (request.settled) return;
        request.settled = true;
        fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
        callbacks.onSuccess();
      };
      request.fail = () => {
        request.settled = true;
        fragment.status = DownloadStatus.DOWNLOAD_FAILED;
        callbacks.onFail();
      };
      requests.push(request);
      return {
        abort: () => {
          if (request.settled) return;
          request.settled = true;
          request.aborted = true;
          fragment.status = DownloadStatus.WAITING;
          callbacks.onAbort();
        },
      };
    },
  };
}

/**
 * What a player's saveVideo uses of itself and its client.
 * @param {Object} network
 * @param {Fragment[]} frags
 * @param {Function} Player the player's class, for its own downloadFragment
 * @return {Object}
 */
function makePlayer(network, frags, Player) {
  return {
    downloadFragment: Player.prototype.downloadFragment,
    client: {
      getFragments: (id) => id === 'video' ? frags : [],
      downloadManager: {
        downloaderLimit: () => LIMIT,
        getEntry: ({sn}) => ({getDataFromBlob: async () => new Uint8Array([sn]).buffer}),
      },
    },
    getCurrentVideoLevelID: () => 'video',
    getCurrentAudioLevelID: () => 'audio',
    getIndexes: () => ({levelID: 0}),
    hls: {levels: [{details: {totalduration: COUNT}}], audioTracks: [], audioTrack: -1},
    dash: {getStreamController: () => undefined},
    readInitSegment: async () => null,
    fragmentRequester: network,
  };
}

const PLAYERS = [
  ['HLSPlayer', HLSPlayer],
  ['DashPlayer', DashPlayer],
  ['MP4Player', MP4Player],
];

/**
 * Starts a save on a player.
 * @param {Function} Player
 * @return {Object} the save's promise and what goes with it
 */
function startSave(Player) {
  const network = makeNetwork();
  const frags = Array.from({length: COUNT}, (_, sn) => new TestFragment(sn));
  const cancels = [];
  const written = [];
  const filestream = {
    getWriter: () => ({
      write: async (data) => written.push(...data),
      close: async () => {},
      abort: async () => {},
    }),
  };
  const saving = Player.prototype.saveVideo.call(makePlayer(network, frags, Player), {
    registerCancel: (cancel) => cancels.push(cancel),
    filestream,
  });
  saving.catch(() => {});
  return {saving, network, frags, written, cancel: () => cancels.forEach((cancel) => cancel())};
}

/**
 * The bytes the save produced: its blob, or what it wrote to its stream (MP4Player).
 * @param {Object} result what saveVideo resolved with
 * @param {number[]} written
 * @return {Promise<number[]>}
 */
async function output(result, written) {
  return result.blob ? [...new Uint8Array(await result.blob.arrayBuffer())] : written;
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(PLAYERS)('%s.saveVideo', (name, Player) => {
  it('asks for the next fragments while it converts one, up to the downloader limit', async () => {
    const {saving, network} = startSave(Player);
    await settle();
    // It asked for one and waited for it before asking for the next.
    expect(network.running()).toEqual([0, 1, 2]);
    expect(network.requests.every((r) => r.priority === -1)).toBe(true);

    network.requests[0].succeed();
    await settle();
    expect(network.running()).toEqual([1, 2, 3]);
    while (network.running().length) {
      network.requests.find((r) => !r.settled).succeed();
      await settle();
    }
    await saving;
  });

  it('makes the same file in the same order, whatever order the downloads finish in', async () => {
    const {saving, network, written} = startSave(Player);
    await settle();
    // The newest request first, each time.
    while (network.running().length) {
      network.requests.filter((r) => !r.settled).at(-1).succeed();
      await settle();
    }
    expect(await output(await saving, written)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(network.requests).toHaveLength(COUNT);
  });

  it('leaves nothing pinned or downloading for the save when it is cancelled', async () => {
    const {saving, network, frags, cancel} = startSave(Player);
    await settle();
    network.requests[0].succeed();
    await settle();
    cancel();
    await settle();
    // Stopped at once. It used to go on downloading the fragment it was waiting for, and
    // notice the cancel only after that.
    expect(network.running()).toEqual([]);
    network.requests.filter((r) => !r.settled).forEach((r) => r.succeed());
    await expect(saving).rejects.toThrow('Cancelled');

    expect(frags.filter((frag) => !frag.canFree()).map((frag) => frag.sn)).toEqual([]);
  });

  it('leaves nothing pinned or downloading for the save when a fragment fails', async () => {
    const {saving, network, frags} = startSave(Player);
    await settle();
    network.requests[0].succeed();
    await settle();
    network.requests.find((r) => r.fragment.sn === 1).fail();
    await expect(saving).rejects.toThrow('Failed to download fragment');

    // What it had asked for ahead of the failed fragment is stopped too.
    expect(network.running()).toEqual([]);
    expect(frags.filter((frag) => !frag.canFree()).map((frag) => frag.sn)).toEqual([]);
  });
});

// A partial save ("what is downloaded") took no references: a range playback had passed
// could be let go of while the save was still writing the ones before it, and was written
// as zeros (review, 2026-10-09).
describe('MP4Player.saveVideo, a partial save', () => {
  it('holds what it has not written yet, and lets it all go once written', async () => {
    const network = makeNetwork();
    const frags = Array.from({length: 5}, (_, sn) => new TestFragment(sn));
    for (const frag of frags) frag.status = frag.sn === 3 ? DownloadStatus.WAITING : DownloadStatus.DOWNLOAD_COMPLETE;
    let release;
    const firstWrite = new Promise((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const filestream = {
      getWriter: () => ({
        write: async () => {
          if (writes++ === 0) await firstWrite;
        },
        close: async () => {},
        abort: async () => {},
      }),
    };
    const saving = MP4Player.prototype.saveVideo.call(makePlayer(network, frags, MP4Player), {partialSave: true, filestream});
    await settle();
    // Writing the first range: it and the ones after it cannot be let go of.
    expect(frags.filter((frag) => !frag.canFree()).map((frag) => frag.sn)).toEqual([0, 1, 2, 3, 4]);
    release();
    await saving;
    expect(frags.filter((frag) => !frag.canFree()).map((frag) => frag.sn)).toEqual([]);
    expect(network.requests).toEqual([]);
  });
});
