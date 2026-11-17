// @ts-check

/**
 * The track the subtitles key goes on to when it cycles (Options.cycleSubtitles): the first when
 * none is on, the one after the last one on, none (off) after the last track.
 * @template T
 * @param {T[]} tracks - The tracks listed, in their order.
 * @param {T[]} active - The tracks on.
 * @return {?T} The track to show alone, or null for off.
 */
export function nextTrack(tracks, active) {
  if (active.length === 0) {
    return tracks[0] ?? null;
  }
  const last = Math.max(...active.map((track) => tracks.indexOf(track)));
  return tracks[last + 1] ?? null;
}
