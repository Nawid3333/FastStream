// @ts-check
import {DownloadStatus} from '../../enums/DownloadStatus.mjs';
import {HLSFragment} from './HLSFragment.mjs';

// A level's segments are stored from its first, at sn - snBase: a live stream's sn may be in the millions.

/** @typedef {Array<HLSFragment> & {snBase?: number}} FragmentStore */
/**
 * @param {FragmentStore|undefined} fragments - None before the level was first stored.
 * @param {number} sn
 * @return {?number} Null without a store, or before the level's first segment (HLSLoader downloads it as it is).
 */
export function storeIndex(fragments, sn) {
  if (fragments?.snBase === undefined) return null;
  const index = sn - fragments.snBase;
  return index >= 0 ? index : null;
}

/**
 * Stores a playlist's segments, its first init segment as fragment -1.
 * Passed segments of a live window that hold nothing are forgotten.
 * @param {import('../../FastStreamClient.mjs').FastStreamClient} client
 * @param {import('../../modules/hls.mjs').LevelDetails} levelDetails
 * @param {(level: number) => string} identifierOf
 */
export function storeLevel(client, levelDetails, identifierOf) {
  const fragments = levelDetails.fragments;
  // A live window starts where hls.js placed it, or each refresh would overlap the old fragments.
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

    const base = /** @type {FragmentStore|undefined} */ (client.getFragments(identifier))?.snBase ?? fragment.sn;
    const index = fragment.sn - base;
    if (index < 0) {
      return;
    }
    const stored = /** @type {HLSFragment|undefined} */ (client.getFragment(identifier, index));
    // One not downloaded yet takes the latest address: a live playlist renews its segments' tokens.
    if (!stored || (stored.status === DownloadStatus.WAITING && stored.canFree() && stored.hlsFrag.url !== fragment.url)) {
      client.makeFragment(identifier, index, new HLSFragment(fragment, start, end, index));
    }
    /** @type {FragmentStore} */ (client.getFragments(identifier)).snBase = base;
  });

  if (levelDetails.live && fragments.length) {
    const store = /** @type {FragmentStore|undefined} */ (client.getFragments(identifierOf(fragments[0].level)));
    const windowStart = storeIndex(store, fragments[0].sn);
    if (windowStart !== null) {
      forgetPassed(/** @type {FragmentStore} */ (store), windowStart);
    }
  }
}

/**
 * @param {FragmentStore} store
 * @param {number} windowStart
 */
function forgetPassed(store, windowStart) {
  for (let i = 0; i < windowStart; i++) {
    const fragment = store[i];
    if (fragment && fragment.status === DownloadStatus.WAITING && fragment.canFree()) {
      delete store[i];
    }
  }
}
