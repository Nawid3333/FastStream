import {afterEach, describe, expect, it, vi} from 'vitest';
import {ClickActions} from '../../chrome/player/options/defaults/ClickActions.mjs';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// Options saved with the old click defaults (hide controls, double click to pause) move to today's
// once (clickActionsVersion); a user's own choice stays.
const OLD = {
  singleClickAction: ClickActions.HIDE_CONTROLS,
  doubleClickAction: ClickActions.PLAY_PAUSE,
  tripleClickAction: ClickActions.FULLSCREEN,
};
const NOW = {
  singleClickAction: ClickActions.PLAY_PAUSE,
  doubleClickAction: ClickActions.FULLSCREEN,
  tripleClickAction: ClickActions.HIDE_CONTROLS,
};

describe('Utils.migrateClickActions', () => {
  const migrate = (stored) => Utils.migrateClickActions({...stored}, stored);

  it('moves the old default clicks, untouched, to today\'s', () => {
    expect(migrate({...OLD})).toMatchObject({...NOW, clickActionsVersion: 1});
  });

  it('keeps clicks the user chose, even one of the old defaults among them', () => {
    const chosen = {...OLD, tripleClickAction: ClickActions.PIP};
    expect(migrate(chosen)).toMatchObject(chosen);
    const single = {...OLD, doubleClickAction: ClickActions.NOTHING};
    expect(migrate(single)).toMatchObject(single);
  });

  it('runs once: the old defaults chosen again after it stay', () => {
    expect(migrate({...OLD, clickActionsVersion: 1})).toMatchObject(OLD);
  });

  it('leaves options never saved, and marks every result', () => {
    expect(Utils.migrateClickActions({...NOW}, null)).toMatchObject({...NOW, clickActionsVersion: 1});
  });
});

describe('Utils.getOptionsFromStorage, saved with the old default clicks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plays and pauses on a click', async () => {
    vi.spyOn(Utils, 'getConfig').mockImplementation(async () => JSON.stringify({...OLD, keybindsVersion: 1}));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await Utils.getOptionsFromStorage()).toMatchObject(NOW);
  });
});
