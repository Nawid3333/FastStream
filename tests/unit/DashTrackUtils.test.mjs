import {describe, expect, it} from 'vitest';
import {DashTrackUtils} from '../../chrome/player/players/dash/DashTrackUtils.mjs';

// DashPlayer's current video and audio level, as FastStreamClient reads them every second
// (checkLevelChange). While dash.js had no level for a type, the answer was -1 (no stream
// processor yet), which the client took for a level: it replaced the level an archive had
// asked for, and the archive reopened at another quality. A processor before its first
// representation (at the start, or a period change) made the getter throw instead, which
// cut that second's main loop short.

/**
 * dash.js as far as the getter reaches into it.
 * @param {Object[]} processors - The active stream's processors: {type, rep}.
 * @return {Object}
 */
function dashWith(processors) {
  return {
    getStreamController: () => ({
      getActiveStream: () => ({
        getStreamProcessors: () => processors.map(({type, rep}) => ({
          getType: () => type,
          getRepresentationController: () => ({getCurrentRepresentation: () => rep}),
        })),
      }),
    }),
  };
}

describe('DashTrackUtils.getCurrentLevel', () => {
  it('names the level of the representation dash.js plays', () => {
    const dash = dashWith([
      {type: 'video', rep: {id: 'v720', adaptation: {type: 'video'}}},
      {type: 'audio', rep: {id: 'a-en', adaptation: {type: 'audio'}}},
    ]);
    expect(DashTrackUtils.getCurrentLevel(dash, 'video')).toBe('video-v720');
    expect(DashTrackUtils.getCurrentLevel(dash, 'audio')).toBe('audio-a-en');
  });

  it('has none, not -1, while dash.js has no processor for the type', () => {
    expect(DashTrackUtils.getCurrentLevel(dashWith([]), 'video')).toBe(null);
    expect(DashTrackUtils.getCurrentLevel({getStreamController: () => null}, 'video')).toBe(null);
    // A destroyed player has no dash.js left.
    expect(DashTrackUtils.getCurrentLevel(null, 'audio')).toBe(null);
  });

  it('has none, rather than throwing, before the processor has a representation', () => {
    expect(DashTrackUtils.getCurrentLevel(dashWith([{type: 'video', rep: undefined}]), 'video')).toBe(null);
  });
});
