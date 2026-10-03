import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {HLSFragment} from './HLSFragment.mjs';

// FastStream keeps each level's fragments in an array (FastStreamClient.fragmentsStore), and
// the client walks those arrays every second: to free what playback has left, to pick the
// next download, to draw the buffer bar. hls.js numbers a playlist's segments by media
// sequence number, which a live stream may start anywhere (hundreds of thousands, millions,
// a timestamp), and the arrays were indexed by it: as long as that number, every hole below
// it walked each time (in Node, 52 ms a walk at 2 million, about a second at 50 million).
// A level's segments are therefore stored from its first one, at sn - snBase, where snBase
// is the first segment's number when the level was first stored, kept on the level's array.
//
// Kept apart from HLSPlayer so that unit tests can run it (HLSPlayer imports the vendored
// hls.mjs, which unit tests do not have).

/**
 * Where a segment is in its level's store.
 * @param {Array} [fragments] - The level's store; none before the level was first stored.
 * @param {number} sn - The segment's media sequence number.
 * @return {?number} Null when the level has no store yet, or for a segment before the
 *   level's first (a live stream that started its numbering again): it is not stored, and
 *   HLSLoader downloads it as it is.
 */
export function storeIndex(fragments, sn) {
  if (fragments?.snBase === undefined) return null;
  const index = sn - fragments.snBase;
  return index >= 0 ? index : null;
}

/**
 * Stores a playlist's segments, and its first segment's init segment as the level's
 * fragment -1. Segments already stored are kept as they are.
 *
 * A live playlist's window moves on, and the segments it has left that hold nothing are
 * forgotten: waiting (never downloaded, or freed again) and pinned by nothing. hls.js asks
 * only for what its playlist lists, so they were never wanted again, yet each kept an object
 * (and the hls.js fragment it wraps) for the whole session. Downloaded ones stay (a save of
 * the stream so far may want them; playback frees them as it leaves them behind), and so do
 * pinned or downloading ones, until they are released: a later refresh forgets them then.
 * @param {Object} client - The FastStreamClient whose store this is.
 * @param {Object} levelDetails - hls.js's LevelDetails, with trackID set.
 * @param {function(number): string} identifierOf - The store's id of an hls.js level index.
 */
export function storeLevel(client, levelDetails, identifierOf) {
  const fragments = levelDetails.fragments;
  // A live playlist's window moves on: its first fragment starts where hls.js placed
  // it, not at 0, or each refresh would place its new fragments over the old ones.
  let time = fragments[0]?.start || 0;
  fragments.forEach((fragment, i) => {
    const identifier = identifierOf(fragment.level);
    if (fragment.initSegment && i === 0) {
      fragment.initSegment.trackID = levelDetails.trackID;
      if (!client.getFragment(identifier, -1)) {
        client.makeFragment(identifier, -1, new HLSFragment(fragment.initSegment, 0, 0));
      }
    }
    const start = time;
    time += fragment.duration;
    const end = time;
    fragment.levelIdentifier = identifier;
    fragment.trackID = levelDetails.trackID;

    const base = client.getFragments(identifier)?.snBase ?? fragment.sn;
    const index = fragment.sn - base;
    if (index < 0) {
      return;
    }
    if (!client.getFragment(identifier, index)) {
      client.makeFragment(identifier, index, new HLSFragment(fragment, start, end, index));
    }
    client.getFragments(identifier).snBase = base;
  });

  if (levelDetails.live && fragments.length) {
    const store = client.getFragments(identifierOf(fragments[0].level));
    const windowStart = storeIndex(store, fragments[0].sn);
    if (windowStart !== null) {
      forgetPassed(store, windowStart);
    }
  }
}

/**
 * Forgets the segments before a live window that hold nothing (storeLevel).
 * @param {Array} store - The level's store.
 * @param {number} windowStart - The index of the window's first segment.
 */
function forgetPassed(store, windowStart) {
  for (let i = 0; i < windowStart; i++) {
    const fragment = store[i];
    if (fragment && fragment.status === DownloadStatus.WAITING && fragment.canFree()) {
      delete store[i];
    }
  }
}
