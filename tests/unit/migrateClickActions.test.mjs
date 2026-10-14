import {afterEach, describe, expect, it, vi} from 'vitest';
import {ClickActions} from '../../chrome/player/options/defaults/ClickActions.mjs';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// The click defaults were "hide controls" on a click, play/pause on a double click and
// fullscreen on a triple from 2023-12 until upstream's 2024-09-14 "click to play"; options
// saved in that time keep them, and a pause then needed a double click, after the triple
// click's wait (the owner's "the click to pause reacts late", 2026-10-13). Untouched, they
// move to today's defaults once (clickActionsVersion); any choice of the user's stays.
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
