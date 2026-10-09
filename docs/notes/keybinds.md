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
  dead. The target is clamped to `options.maxPlaybackRate`, which is 8, so the 16x key gives
  8x, the same as the 8x key. 8 is where Firefox stops playing audio: measured on Firefox 156,
  a tone is at full level at 8x and silent at 10x and 16x, while the picture still runs at the
  requested pace. `tests/e2e/specs/firefox.e2e.mjs` pins it, so a Firefox that plays faster audio
  shows up as a failure and the cap can move.
- **Speed shown on screen** (2026-10-07), like mpv's OSD. Every speed key
  (`IncreasePlaybackRate`, `DecreasePlaybackRate`, `ResetPlaybackRate`, the `SpeedPreset` keys)
  calls `KeybindManager.showSpeed()`, which shows the rate now in effect top left over the
  video; it stays 1 s, then fades out over 0.3 s, and a new press replaces the text and starts
  the time over. `ui/OnScreenDisplay.mjs` drives `.mainplayer .osd` (in `player/index.html`,
  outside the control bar's container so it shows with the controls hidden; white bold text on
  rgba(0,0,0,0.6) in `fluidplayer.css`), `aria-hidden` because the rate button carries the
  label. The text comes from `formatPlaybackRate` in KeybindUtils ("2×", "2.5×"), rounded to 2
  decimals so the 0.1 steps' float leftovers show as "1.2×". A preset clamped to
  `maxPlaybackRate` shows the real rate (the 16x key shows "8×"). Nawid chose speed only (not
  volume or seeks) and top left. Tests: `KeybindUtils.test.mjs` "formatPlaybackRate" and
  `keybinds.e2e.mjs` "a speed key shows the speed top left over the video for a moment" (text,
  opacity, position; a mutant without `showSpeed` in the preset handler fails it).
- Six defaults moved to `Shift+<letter>` for those letters: WindowedFullscreen, NextChapter,
  PreviousVideo, FlipVideo, RotateVideo, ToggleVisualFilters.
- **Typing is not a command.** `KeybindManager.onKeyDown` ignores a press whose target is a text
  field, text area, select or editable element, unless Ctrl, Alt or Meta is held (Right Alt hides
  the player). Ranges, checkboxes and buttons still pass keys through.
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
- **Options page shows nothing before the saved options are read.** `OptionsStore.get()` returns
  the defaults until `init()` has read storage, and the page's visibility refresh
  (IntersectionObserver) used to call `loadOptions` with that, so a slow start drew the default
  keybinds for a moment, and a change made then would have saved the defaults over the user's
  options. The refresh now waits for `init()` (`optionsLoaded`). Found as a flaky failure of
  `keybinds-storage.e2e.mjs` under the full `verify` load; reproduced every time with a 1.5 s
  delay injected into `OptionsStore.init()`, and passing with the guard.
- **Options page menu.** Rows are named by `keybindLabel` ("Seek to 50%", "Speed preset 2.5x"),
  and a row whose key another action shares is marked with a warning naming the other action
  (`conflictPartners`; nothing stops the choice, the user may be mid-rearrangement).
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
