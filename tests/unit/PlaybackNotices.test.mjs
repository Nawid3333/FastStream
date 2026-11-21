import {afterEach, describe, expect, it, vi} from 'vitest';
import {Localize} from '../../chrome/player/modules/Localize.mjs';
import {resumedMessage, subtitlesMessage} from '../../chrome/player/ui/PlaybackNotices.mjs';
import {StringUtils} from '../../chrome/player/utils/StringUtils.mjs';

// Two things the player did without a word: starting a video where it was left (on by default), and loading the
// page's subtitles while leaving them off (auto-enable is off by default). Each now names the key that changes it.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resumedMessage', () => {
  it('names the time and the key that goes to the start, or only the time when that action has no key', () => {
    const message = vi.spyOn(Localize, 'getMessage').mockImplementation((key) => key);
    expect(resumedMessage(754, new Map([['GoToStart', 'Digit0']]))).toBe('player_resumed_key');
    expect(message).toHaveBeenLastCalledWith('player_resumed_key', [StringUtils.formatTime(754), '0']);
    expect(resumedMessage(754, new Map([['GoToStart', 'None']]))).toBe('player_resumed');
    expect(message).toHaveBeenLastCalledWith('player_resumed', [StringUtils.formatTime(754)]);
    expect(resumedMessage(754, undefined)).toBe('player_resumed');
  });
});

describe('subtitlesMessage', () => {
  it('names how many tracks and the subtitles key, or the menu when that action has no key', () => {
    const message = vi.spyOn(Localize, 'getMessage').mockImplementation((key) => key);
    expect(subtitlesMessage(2, new Map([['ToggleSubtitles', 'KeyC']]))).toBe('player_subtitles_available_key');
    expect(message).toHaveBeenLastCalledWith('player_subtitles_available_key', ['2', 'C']);
    expect(subtitlesMessage(1, new Map([['ToggleSubtitles', 'None']]))).toBe('player_subtitles_available');
    expect(message).toHaveBeenLastCalledWith('player_subtitles_available', ['1']);
  });
});
