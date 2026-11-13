# Keybinds

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## Keybinds

The pure logic is in `chrome/player/options/KeybindUtils.mjs` (no DOM, so Node can test it);
`KeybindManager.mjs` and the options page use it.

- **Percent seeks**: `SeekPercent10..90` on `Digit1..Digit9`. A live stream reports an infinite
  duration, which the `currentTime` setter throws on, so `seekPercentTarget` returns null for it.
- **mpv seeks** (layout version 3, from Nawid's mpv `input.conf`): `SeekBackward60s/SeekForward60s`
  on `Z/X`, `SeekBackward10s/SeekForward10s` on `J/K` (`FIXED_SEEKS`), the arrows 5 s (the
  `seekStepSize` default went 2 -> 5, and a saved 2 is moved to 5 once). Undo seek moved to
  `Shift+Backspace` (mpv's revert-seek) and Screenshot to `Shift+S` (mpv's video-only
  screenshot). `SeekForwardLarge/SeekBackwardLarge` (10 s on `,`/`.`, a duplicate of J/K) were
  removed; the skip buttons seek a fixed `SKIP_BUTTON_SECONDS` (10), no longer 5 x the step, so
  they did not become 25 s. None of these hops is saved for undo, like the arrows. Every seek is
  clamped to [0, duration] in `FastStreamClient`'s `currentTime` setter (only the lower
  bound on a live stream): the media element clamps by itself, but `state.currentTime`, the
  separate audio track and `MP4Player`'s "is the target buffered" check did not, and an
  arrow press near the start used to make `MP4Player` drop its whole buffer (`resetHLS`)
  for a seek to -3 s that landed on the buffered 0. `keyboard.png` on the welcome page predates version 2
  and is out of date; the text list above it is current.
- **Frame step** (`,`/`.`, moved from Shift+arrows in version 3): mpv's frame-step, pause then
  exactly one frame. `ui/FrameStepper.mjs` learns the frame length from
  `requestVideoFrameCallback` during playback. Measured on Firefox 156: a playback frame's
  `mediaTime` is its own start, but while paused it is the position seeked to (anywhere inside
  the frame), and so is the frame shown again when playback starts. So only gaps between two
  consecutive playback frames count (the frame after a seeking/play/pause event is skipped),
  the shortest such gap is the length (drops at high speed only lengthen gaps), and the step
  works out the frame on screen from `currentTime` on the grid a playback frame anchors
  (`mediaTime` is rounded to whole microseconds, so `currentTime` on the anchor frame can
  read just below the anchor; a 10 us tolerance keeps it in that frame - Windows CI hit
  0.4176667 vs 0.417667 and stepped onto the frame it was on). Before
  any playback the length is the old 1/30 s. The usual use is play, pause, then step, which is
  what `tests/e2e/specs/keybinds.e2e.mjs` checks on `fixtures/frames-24fps.mp4` (96 frames,
  ffmpeg `testsrc2` at 24 fps, libopenh264), by the picture itself, not only the time.
- **mpv-style speed presets** (a port of `speed-presets.lua`): `SpeedPreset1/2/2_5/3/3_5/4/5/8/16` on
  `R G B Q W A Y E H`. A press sets the speed; the same key again reverts to the speed active
  before it (per-key memory, fallback 1x; `applySpeedPreset`). One deliberate difference from
  the lua: a remembered speed equal to the preset itself falls back to 1x, so the key never goes
  dead. 8 (`options.maxPlaybackRate`) is where Firefox stops playing audio: measured on Firefox
  156, a tone is at full level at 8x and silent at 10x and 16x, while the picture still runs at
  the requested pace; `tests/e2e/specs/firefox.e2e.mjs` pins it, so a Firefox that plays faster
  audio shows up as a failure and the cap can move. Everything that should be heard stops there:
  the menu, the speed steps, holding the video, the silence skipper, the embed API. **The 16x key
  plays 16x anyway, silent** (Nawid's decision, 2026-10-10: mpv's 16x is silent too; until then
  it gave 8x, the same as the 8x key): the presets go up to `SILENT_MAX_PLAYBACK_RATE` (16,
  Firefox's own limit) through `FastStreamClient.setPlaybackRate(rate, true)`, and putting such
  a rate back (after holding the video, after a GIF) does too. The speed menu marks its top entry
  then; the speed-up step leaves it where it is (`min()` took it down to 8x). Measured in the
  player: 15.6x on long-av.mp4 (`keybinds.e2e.mjs` "The 16x key"). **Firefox plays a video
  without an audio track at 1x once Web Audio takes its sound, whatever the rate** (2026-10-10:
  a plain element 1.9x at 2x, 0.95x once captured; with an audio track 15.8x either way); the
  player takes every video's sound (the volume above 100 %), so on a silent video the speed keys
  do nothing - sample.mp4 has no audio, which is why that case uses long-av.mp4.
- **A speed set by key is kept for the next video** (the owner, 2026-10-22, as mpv's
  remember-speed keeps every speed): the presets, Shift+arrows and the reset key save it the
  way the speed menu saves its own (`KeybindManager.rememberSpeed()`, the menu's
  `scheduleSave()`, 500 ms after the last change). Until then only the menu saved. A 16x left
  by its key starts the next video at 8x, with sound (`PlaybackRateChanger.loadState`);
  holding the video's double speed is no key's and is not kept. **With the silence skipper on**
  (2026-11-13, a review) a speed key becomes the skipper's regular speed, or its skip speed in a
  silence, as a pick in the speed menu does (`PlaybackRateChanger.chooseSpeed`). Until then D, S
  and the presets changed the speed for a moment only: the OSD showed the new speed, the
  skipper's loop put its regular speed back within 100 ms, and that was what got saved. A speed
  held for a moment (holding the video, a GIF's 4x) and the skipper's own switches do not go
  through `chooseSpeed`, so they never become the regular speed. `playbackRateLimit.test.mjs`.
- **Speed steps on S and D** (layout version 4, 2026-10-10, as in Nawid's mpv `input.conf`:
  s -0.1, d +0.1): `DecreasePlaybackRate` on S, `IncreasePlaybackRate` on D (Shift+Down/Up
  before), and `SaveVideo` moved from D to Shift+D (still with any extra modifier:
  `KeybindsWithModifiers`; a plain D is the speed-up alone). `MOVED_IN_VERSION_4` moves a saved
  binding only if it is still the old default, Save video first so D is free; a new key the user
  already has elsewhere leaves the action unbound (`KeybindUtils.test.mjs` "to version 4",
  `Keybinds.test.mjs` "migrates a few bindings saved at version 3").
- **Speed shown on screen** (2026-10-07), like mpv's OSD. Every speed key
  (`IncreasePlaybackRate`, `DecreasePlaybackRate`, `ResetPlaybackRate`, the `SpeedPreset` keys)
  calls `KeybindManager.showSpeed()`, which shows the rate now in effect top left over the
  video; it stays 1 s, then goes at once (no fade since 2026-10-13: the player has no
  animations), and a new press replaces the text and starts
  the time over. `ui/OnScreenDisplay.mjs` drives `.mainplayer .osd` (in `player/index.html`,
  outside the control bar's container so it shows with the controls hidden; white bold text on
  rgba(0,0,0,0.6) in `fluidplayer.css`), `aria-hidden` because the rate button carries the
  label. The text comes from `formatPlaybackRate` in KeybindUtils ("2×", "2.5×"), rounded to 2
  decimals so the 0.1 steps' float leftovers show as "1.2×"; above the rate with sound,
  `describePlaybackRate` adds the localized "no sound" ("16× · no sound"). Nawid chose speed only (not
  volume or seeks) and top left. Tests: `KeybindUtils.test.mjs` "formatPlaybackRate" and
  `keybinds.e2e.mjs` "a speed key shows the speed top left over the video for a moment" (text,
  opacity, position; a mutant without `showSpeed` in the preset handler fails it).
- In that layout (version 2), six defaults moved to `Shift+<letter>` for those letters: WindowedFullscreen, NextChapter,
  PreviousVideo, FlipVideo, RotateVideo, ToggleVisualFilters. (NextChapter went on 2026-10-10
  with the chapters, SkipIntroOutro on S with the intro/outro finder, and ToggleVisualFilters
  on Shift+Q with the video filters: an old saved binding of any of them is dropped, as every
  key the defaults no longer have.)
- **Typing is not a command.** `KeybindManager.onKeyDown` ignores a press whose target is a text
  field, text area, select or editable element, unless Ctrl, Alt or Meta is held (Right Alt hides
  the player). Ranges, checkboxes and buttons still pass keys through.
- **Escape closes menus and windows wherever the focus is** (2026-11-13, a review). The player
  heard it only on its own element, so with the focus on `<body>` (leaving the control bar
  blurs the clicked control) a menu opened by a click stayed open. And the loop menu, the
  subtitle settings, the subtitle search (its fields and page number) and the sources browser's
  fields kept every key from the player, Escape too: the subtitle search could not be closed
  from its own field. Escape is now heard on the document, as the keybinds are (once: the
  player's own listener is gone), and those fields and menus stop every key but Escape
  (`if (e.key !== 'Escape') e.stopPropagation()`). Dialogs keep their own keys.
  `playerFieldKeys.test.mjs`, `player-a11y.e2e.mjs`.
- **Space and Enter press a control the keyboard went to** (2026-11-13).
  `WebUtils.setupKeyPress` gives a control with a tab index and role of its own the keys of a
  `<button>`: Enter presses it, and so does Space without a modifier when the control shows the
  keyboard's focus (`:focus-visible`). After a mouse click the control keeps the focus without
  `:focus-visible`, and Space stays play/pause. A form control (input, text area, select,
  button) keeps its own Space: the options page's fields come through `setupTabIndex` too, and
  the first version swallowed every space typed in them ("1 2" in the speed limit became "12").
  The subtitles, quality and language buttons had an Enter of their own and no Space, Enter
  could not open the quality or language list again once a click had closed it, and Space after
  a click on the autoplay switch toggled it again instead of playing. They all go through
  `setupKeyPress` now, as `setupTabIndex` does. It leaves alone a key that a listener before
  it took (`preventDefault`), so Enter in an open list chooses and does not also press the
  button, which closed the list; the audio button's is set up after its list's keys (it had
  two Enter listeners, and its own closed the list before the list's could choose).
  `playerA11y.test.mjs`, `player-a11y.e2e.mjs`, `player-menus.e2e.mjs`.
- **Keys follow the keyboard's layout** (2026-10-07). `WebUtils.getKeyString`, which
  `KeybindManager` and the options page's keybind recorder both use, named every key by
  `e.code`, its place on a US keyboard. On a German QWERTZ keyboard the key labelled Y is `KeyZ`
  and the one labelled Z is `KeyY`, so Nawid's Y seeked back 60 s (Z's `SeekBackward60s`) and
  his Z set the 5x preset (`SpeedPreset5` on `KeyY`); its '-' is the US '/', '=' is Shift+0 and
  '[' AltGr+8, so the welcome page's "=/-" and "[" were other keys, and 'ß' was '-'. mpv's
  `input.conf` goes by the character typed, and so does this now, with the bindings' names
  kept (no migration): a Latin letter is `Key<LETTER>` from `e.key`, Shift counted; a digit or
  one of the 12 US punctuation characters is its US key's name (`TypedKeyNames`), the Shift or
  AltGr it took dropped (German Shift+0 is `Equal`, AZERTY Shift+1 is `Digit1`, a numpad digit
  is the digit); another character on such a key (ß, ü, ö, @, €, Shift+1's '!') is named by
  itself and a dead key is `Dead`, so neither is a default any more; a non-Latin letter
  (Cyrillic) keeps its place, as those keycaps carry the Latin letters too; named keys
  (arrows, Space, Backspace, Right Alt) as before. AltGr is Control+Alt on Windows:
  `getModifierState('AltGraph')`, or Control+Alt with a non-letter character, is no modifier.
  Left: ` (ResetFailed) is a dead key on German, Swiss, French and Spanish layouts and cannot
  be typed (the reset button can); a custom binding a user recorded on a non-US layout to a
  punctuation key by its place may need recording again. Not changed: `content.js`'s fallback
  for shortcuts a page cancels (`KeyShortcut.mjs` already matches the typed character first)
  and the subtitle resync tool's own keys (D, R, brackets, Delete/Backspace by `e.code`).
  Tests: `tests/unit/keyboardLayouts.test.mjs` presses every default binding the way US, UK,
  German, Swiss German, French, Spanish, Dvorak and Russian layouts type its character and
  wants the binding back, and keys that type other characters (ß, ü, dead keys, @, &, б, Dvorak
  ' and /) no default (a letters-only mutant fails all seven layouts measured before Dvorak
  came in; naming every key by `e.code` again fails all but US and UK, Dvorak included);
  `WebUtils.test.mjs` "getKeyString"; `keybinds.e2e.mjs` "on a German keyboard Z seeks -60 s
  and Y sets the 5x preset" (`pressKey` takes an optional `key`, what the layout types).
- **Layout version.** `mergeOptions` only fills missing keys, so nothing in saved options said
  which layout they were written for. Options now carry `keybindsVersion` (`KEYBINDS_VERSION`
  in KeybindUtils). `Utils.getOptionsFromStorage()` reads the saved options, merges the
  defaults over them, and runs `migrateKeybinds(options, stored)`, once per saved options: a
  saved binding that still holds an old plain-letter default is moved, and a new action takes
  its default key only when nothing else uses it (otherwise it is left `None`). A user's own
  binding is never overridden, so one press never fires two actions after a migration. A choice
  made afterwards, even one equal to an old default, is kept, because the saved version stops
  the migration. Options that were never saved need nothing. Imported settings files go through
  the same migration. When a default moves again, add an entry to `MIGRATIONS` in KeybindUtils
  (the moved actions with their old key, the new actions) and bump `KEYBINDS_VERSION`; each
  entry newer than the saved version runs in turn, so version 1 options go through all of them.
- **`getOptionsFromStorage` is async.** It once passed the unresolved promise straight to the
  migration, which skipped it silently, so the migration never ran in the extension; the unit
  tests fed plain objects and passed. `tests/unit/Keybinds.test.mjs` now goes through
  `getOptionsFromStorage` with a stubbed `getConfig`.
- **A settings file can no longer break the options page** (2026-11-13, a review). An imported
  binding with a line break in it ("Space\n") made `keyDisplayName` throw: the page stopped half
  drawn, and as the import had saved it, every later visit broke the same way until "Reset
  keybinds". A binding of many kilobytes froze the page (the pattern backtracked over it).
  `mergeOptions` now keeps a binding only when it can be a key string (`isKeyString`: at most 64
  characters, no control character) and gives the action its default otherwise, as it did for a
  binding that is no text; this also heals options already saved that way. `keyDisplayName`
  reads a binding with `splitKeyString`, which takes any string in linear time. An import holds
  the five number fields' options to the fields' own limits (`NUMBER_LIMITS` in options.mjs,
  which `readNumberField` reads too: a seek step of -5 or a mini player of 50 were taken as they
  were) and the click, visibility, theme and mini player menus to their choices (a value no menu
  has showed as a blank menu). Values within them stay exactly as they are. The aspect ratio and
  the quality are left alone: the player takes any ratio and height. `optionsPage.test.mjs`,
  `Keybinds.test.mjs`, `KeybindUtils.test.mjs`.
- **Options page shows nothing before the saved options are read.** `OptionsStore.get()` returns
  the defaults until `init()` has read storage, and the page's visibility refresh
  (IntersectionObserver) used to call `loadOptions` with that, so a slow start drew the default
  keybinds for a moment, and a change made then would have saved the defaults over the user's
  options. The refresh now waits for `init()` (`optionsLoaded`). Found as a flaky failure of
  `keybinds-storage.e2e.mjs` under the full `verify` load; reproduced every time with a 1.5 s
  delay injected into `OptionsStore.init()`, and passing with the guard.
- **The page knows every echo of its own saves** (2026-11-13). While a slider was dragged, the
  page saved once a frame, and now and then redrew every keybind row and the search and put the
  slider back to the stored value mid-drag. Each save goes to the background, which tells every
  tab with the save's time; the page ignored only the echo of its latest save, so an earlier
  save's echo that came after the next save was taken for a change made elsewhere.
  `OptionsStore` now keeps the times of its saves whose echo has not come back (at most 100) and
  drops each one as its echo arrives; any other time still reloads the options.
  `OptionsStore.set()`, which only a test called, went the same day: the page saves through
  `replace()` alone. `OptionsStore.test.mjs`.
- **Options page menu.** Rows are named by `keybindLabel` ("Seek to 50%", "Speed preset 2.5x"),
  and a row whose key another action shares is marked with a warning naming the other action
  (`conflictPartners`; nothing stops the choice, the user may be mid-rearrangement).
- **A binding to the "+" key fires and shows its clashes** (2026-11-13). `getKeyString` names
  that key by its character (the German + key, the numpad +, Shift+= on a US keyboard), so it is
  saved as `+` or `Control++`. `actionsForKey` split the string at every '+', found an empty key
  and gave up before the exact match: the key never fired, and two actions on it got no warning.
  The modifiers and the key are now read the way `keyDisplayName` reads them (`splitKeyString`):
  the leading Meta/Control/Alt/Shift, each with its '+', and the rest is the key. `Shift+` still
  names no key. `KeybindUtils.test.mjs`.
- Locale keys `welcome_page_keybinds_content10` and `content11` exist in all 16 locales.
  **Gotcha:** the 16 `messages.json` files are the source; edit those, then run
  `pnpm run combine-locales` to bring `combined-locales.json` along. `tests/unit/localeKeys.test.mjs`
  fails when the two differ (the combined file had fallen behind by 15 keys and 17 English-only
  entries, regenerated 2026-09-30). Don't run `split-locales` unless the combined file is the
  one you edited: it writes over the locales. (Plain `node localescript.mjs`, which the build
  runs, only compares keys.) Both files are formatted with a 4-space indent; keep it, or a
  one-key change shows up as thousands of changed lines. The same test also fails when a
  locale's keys or `$1`/`$2` placeholders differ from English's (2026-10-03), so a new string
  needs all 16 locales before CI passes, a key ported from upstream (English only there) included. The
  welcome page lists every default key; `Keybinds.test.mjs` fails when a default is missing.
- Tests: `tests/unit/KeybindUtils.test.mjs` (the pure functions), `tests/unit/Keybinds.test.mjs`
  (the default layout has no clashes and every default has a handler, the storage path, the
  welcome page and locales), `tests/e2e/specs/keybinds.e2e.mjs` (presses in the running player,
  the migration on a legacy profile, the text-field guard) and `keybinds-menu.e2e.mjs` (the
  options page). Not covered: a saved profile in the real extension's `chrome.storage`.
- **Mouse clicks: the old defaults move once** (2026-10-14). From 2023-12 until upstream's
  2024-09-14 "click to play" the defaults were "hide controls" on a click, play/pause on a
  double click and fullscreen on a triple; options saved then keep them, and a pause took a
  double click after the triple click's wait (the owner's "the click to pause reacts late").
  `Utils.migrateClickActions` moves all three, when still exactly so, to today's defaults
  once (`clickActionsVersion`); a set the user changed in any part stays.
  `tests/unit/migrateClickActions.test.mjs`.
