# Firefox API watch, optimisation and UI review (2026-11-13)

The owner's two briefs of 2026-11-13: a watcher for what each Firefox release changes, research into
Firefox-only improvements, and an incremental modernisation of the player's and settings' UI.
Nothing here is merged or released: two draft pull requests wait for the owner's test and decision.

| Branch | Draft PR | Ships to users |
|---|---|---|
| `feature/firefox-api-watch` | #674 | no (a workflow and its tool) |
| `feature/firefox-optimization-ui-modernization` | #675 | yes, once merged (a merge to main releases) |

## 1. Firefox API watch (branch `feature/firefox-api-watch`)

`.github/workflows/firefox-api-watch.yml` runs daily and by hand. For each new Firefox Stable
release it reads MDN's notes for developers, browser-compat-data, Bugzilla's fixed bugs and the
add-ons blog. It keeps what touches FastStream, measured against the code: names searched in
`chrome/`, the manifest's keys and permissions. It posts one section per release to one review
issue, "Firefox API Watch: starting with Firefox N", which holds a checkbox per finding.

The issue's life, as asked:

| Case | What the watcher does | Test |
|---|---|---|
| A: no open issue | opens one with the first release | unit, workflow r1 |
| B: an open issue | one comment per release, in version order; a release not yet posted holds back the later ones | unit, workflow r5 |
| C: ticks and edits | never edits or deletes anything it posted (write-once) | unit; the workflow test fails on any PATCH/edit |
| D: a closed issue | never touched; its markers still count, so the next issue copies nothing | unit, workflow r6 |
| E: nothing relevant | no post; the run's summary says "reviewed, nothing new" | unit, workflow r7 |

- **Recovery and repeats:** missed releases are caught up (the current release and the two before
  it). A second run posts nothing twice, and a partial failure posts the rest on the next run.
  Notes Mozilla adds later come as "added after its first review".
- **Waiting:** a release waits up to 10 days for MDN's notes, then is reviewed without them.
- **When it fails:** a source that answers wrongly fails the run, and so does the newest release
  still unreviewed after 10 days. A failure opens "Firefox API watch failed", which the next clean
  run closes.
- **Safety:** `permissions: {}` for the workflow, and `contents: read` + `issues: write` for the job.
  There is no secret. The workflow never pushes or dispatches, so it cannot start a release.
- **Posted text:** outside text can mention no one, reference none of this repository's issues or
  commits, link only to Mozilla/MDN and the specs' GitHub, and cannot forge a marker
  (property-tested).
- **Independent review:** a separate agent reviewed the watcher. It found eight real problems:
  - a marker could be forged inside a code span;
  - a merged note was hidden;
  - a later change to a reported feature was never reported;
  - sections could be posted out of version order;
  - false failure alarms, and a long outage of a shared source that never failed the run;
  - links to any github.com repository were allowed;
  - the folding counted `<details>` inside code;
  - a lagging issue list.

  All eight are fixed, each with a test; see the commit "what an independent review found".
  `docs/notes/workflows.md` holds the rules.

**Live dry run** over Firefox 153-160 (the releases since the floor): 96 findings, of which 6 high,
43 medium and 47 low. The six high ones, checked by hand:

| Firefox | Change | FastStream | Verdict |
|---|---|---|---|
| 153 | `requestPictureInPicture()` and its events ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestPictureInPicture)) | `ToolManager.mjs` shows the PiP button when `document.pictureInPictureEnabled`; `InterfaceController.enterPip` | Already used through the feature check: needs a hand test (checklist) |
| 153 | Range requests pass through a service worker ([bug 1465074](https://bugzil.la/1465074)) | the page transport (`page-fetch.js`) depends on it | Verified: the new save tests below get 206 ranges through a page's worker |
| 154 | WebCodecs audio encoder buffer overflow ([bug 2050988](https://bugzil.la/2050988)) | no `AudioEncoder` in FastStream's own code; the vendored Mediabunny (saving, remuxing) can use one | Nothing to do: the fix is Firefox's (the watcher matched comments in `AacLayout.mjs`) |
| 154 | `storage.local` resets itself on a corrupted IndexedDB ([bug 1992973](https://bugzil.la/1992973)) | options live in `storage.local` | Nothing to do: after such a corruption the options start from their defaults instead of failing |
| 157 | `ImageDecoder` returned a broken frame ([bug 2066911](https://bugzil.la/2066911)) | not used | Nothing to do (the watcher rated the area, not a use) |
| 159 | `mediaCapabilities.decodingInfo()` never resolved on Windows ([bug 2082265](https://bugzil.la/2082265)) | `DecodingCapabilities.mjs` | Verified safe on 153-158 too: FastStream's probe gives up after 1.5 s (`PROBE_TIMEOUT_MS`, unit-tested); hls.js starts the call without waiting on it; dash.js has it off (`useMediaCapabilitiesApi: false`) |

## 2. Research

Floor: `strict_min_version` 153 (ESR 153); current Stable 160, 161 due 2026-11-20 (product-details).

- **documentId** (Firefox 153, [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_documentId),
  [bug 1891478](https://bugzil.la/1891478)). Available at the floor, so it needs no feature check:
  `runtime.MessageSender.documentId`, `tabs.sendMessage`/`tabs.connect` options, `webNavigation`,
  `webRequest`, `scripting`. `documentLifecycle` is not supported.
  - The sends that name a frame but no document: `OPEN_PLAYER`, `PLAYLIST_NAVIGATION`/`POLL` in
    `background.mjs`, and the page transport's `tabs.connect` in `PageFetchRelay.mjs`. A frame that
    navigated in between could get a message meant for its previous document.
  - No such misdelivery has been seen: `DocumentKey` in `content.js` and the bfcache handling
    already cover the known cases.
  - Recommendation: **needs more evidence**. Probe first: is `sender.documentId` stable across a
    bfcache restore, and does a stale id reject? Then target those sends with it.
- **The replaced player's measurement** (`content.js`, `updateReplacedPlayer`). The player is
  measured with `display: none`, which the notes count as up to 8 player resizes and 300x150
  flashes in a soft replace's first 2 s (`docs/notes/player.md`).
  - Candidate fix: take the iframe out of flow at its current size instead, and skip the style
    write when nothing changed.
  - **Recommended for later**, measure first: a baseline e2e of resize events and style writes,
    interleaved builds, the replace/miniplayer/fullscreen specs kept green. Not done in this round.
- **The page transport and MPV** (commits b581563, ec8d546). Saving through the page was the
  recorded gap. It is now tested end to end (section 4) and works.
  - MPV mode's refusal of a page-only file is unchanged here. Its e2e specs start a real mpv and
    run only on CI.
- **Media APIs** (BCD, notes for 153-160):
  - MSE in dedicated workers (`MediaSource.canConstructInDedicatedWorker`, `MediaSourceHandle`) is
    not in Firefox Stable: **monitor**. The watcher reports it when it ships.
  - WebCodecs (`VideoDecoder`, `AudioDecoder`) is at the floor. FastStream's players feed MSE
    through hls.js, dash.js and mp4box, and nothing measured asks for WebCodecs: **rejected for
    now**, no problem it would solve.
  - MediaCapabilities is already used, with a timeout.
  - OPFS (`createSyncAccessHandle` in workers) is used already (`storage.md`).
- **UI.** The player's controls are `div`s with ARIA (32 of them). Swapping them for `<button>`s
  would touch every control's CSS and keyboard handling: **recommended for later**, as a change of
  its own.
  - The menus are children of their buttons, so a screen reader cannot reach their items. A
  `role="button"`'s children are presentational. Moving each menu out of its button, with
  `role="menu"` items, is **recommended for later**: the menus' CSS positions them inside the
  button.

## 3. Backlog

| Item | Status |
|---|---|
| Firefox API watch (workflow, tool, tests, docs) | Implemented and verified |
| Saving through the page transport: worker video and current-cookie video byte for byte; cancel half-way, then a whole save | Implemented and verified |
| Space presses a control the keyboard went to; after a click it stays play/pause; form fields keep their Space | Implemented and verified |
| Menu buttons say `aria-haspopup`/`aria-expanded` (six menus) | Implemented and verified |
| Seek bar: a named slider in the tab order with live values; arrows seek from it; focus ring | Implemented and verified |
| Picture-in-Picture button on Firefox 153+ | Implemented but requires manual testing (no change made: the feature check picks the API up) |
| Screen-reader announcement of the menus and the slider | Implemented but requires manual testing (no screen reader in the e2e) |
| documentId on the frame-addressed sends | Needs more evidence |
| Replaced player measured without `display: none` | Recommended for later (measure first) |
| Menus out of their buttons, `role="menu"` | Recommended for later |
| `<button>` elements instead of ARIA `div`s | Recommended for later |
| `<label for>` on the settings page | Rejected: each row already ticks its box or focuses its field on a click anywhere in it, and every field has an accessible name (`aria-label`). A label would toggle a box twice |
| Transitions, "subtle animations" | Rejected: the owner's zero-motion rule (`playerA11y.test.mjs` enforces it) |
| Performance changes (modulepreload, earlier player choice, paused wake-ups, RAM budget for two players) | Recommended for later: none was measured in this round, and the notes' rule is no change without an A/B. The recorded rejections in `docs/notes/player.md` still stand |
| MSE in workers | Recommended for later (monitor: not in Stable) |
| WebCodecs players | Rejected for now (no measured problem it solves) |

## 4. What changed, and the numbers

On `feature/firefox-optimization-ui-modernization` (from main `4813fbee`, 1.3.82.180):

- `tests/e2e/ext-specs/page-fetch.e2e.mjs` gets three new tests:
  - a service-worker video and a current-cookie video, saved through the Save button and the name
    prompt, are the film byte for byte (SHA-256), their far end asked for through the page;
  - a save cancelled about a quarter in says "Save cancelled!", with no "failed, save what there
    is?" question; it leaves no file, and the next save is whole.

  What the first version of the tests ran into is in `docs/notes/player.md`: the player's buffer
  hand-over, and Firefox's cache.
- Player accessibility (`WebUtils.setupTabIndex`, `setExpanded`, the six menus, `ProgressBar`,
  `InterfaceController.timeUpdated`, the focus-ring CSS). One new string, `player_seekbar_label`
  ("Playback position"), is in all 16 locales and `combined-locales.json`.
  - A regression made on the way and fixed: the first Space rule swallowed spaces typed in the
    settings' fields. "1 2" became "12" on that build; now tested.

| Measure | main 4813fbee | this branch |
|---|---|---|
| Shipped files (`chrome/`, unpacked) | 3,571,889 B | 3,576,685 B (+4,796 B: 16 locale strings and code) |
| Manifest, permissions | unchanged | unchanged |
| Unit tests | 3552 passed, 6 skipped | 3558 passed, 6 skipped (the six new accessibility tests) |
| `lint:amo` / `lint:github` | 0 errors, 0 warnings | 0 errors, 0 warnings |
| e2e suites (non-mpv) | all green | see section 5 |

No playback-speed or memory change is claimed: nothing in this round touches the loaders or the
players' buffering.

## 5. Verification

Run on this PC (Windows 11, Firefox 160), on the branch's last commit unless noted:

- `pnpm run lint`, `pnpm run typecheck`: clean.
- Full unit suite (`vitest run`): 229 files, 3558 tests passed, 6 skipped.
- `pnpm run build:keep`, `lint:github`, `lint:amo`, `verify:vtt`, `verify:fsaunpack`: pass.
- e2e, every suite except the mpv specs, which are never run on this PC (they start a real mpv):
  web 47/47 spec files (main: 46, plus the new `player-a11y`), extension 26/26, classic 10/10,
  github and private-browsing green: no failure, no retry. The log was checked for an mpv spec
  name and for "did not match": none.
- The new and nearest specs, run on their own as well: `page-fetch` 6/6 (three runs while the
  tests were written; the last passed with no retry), `player-a11y` 4/4, and `keybinds`,
  `player-controls`, `dialogs` and `options-fields` all green.
- Not run here: `verify:linux` (CI's Linux jobs cover it), the mpv specs (CI), a Firefox Beta.
- Watcher branch, on its last commit: lint, typecheck, the full unit suite (3602 passed, 6
  skipped), its workflow test and `no-mentions` in WSL: all pass. actionlint, zizmor (no findings)
  and `keepalive` passed on the workflow, which the review fixes did not change. CI on #674 is
  green.
- Not done: the usual glm-5.3-flash review. The local Ollama was not running this session; an
  independent Claude review covered the watcher instead.

## 6. Manual test (the owner)

In each branch's checkout, `pnpm run start:ff` builds and opens that checkout's own development
profile; `pnpm run start:ff` in the main checkout is the comparison.

1. Play an MP4, an HLS and a DASH video and a live stream; seek; change quality, audio and speed.
2. Keyboard: Tab through the controls. The seek bar gets a ring, and ArrowLeft/Right seek 5 s
   from it. Tab to the speed button (its menu opens), press Space (it closes), and the video does
   not start.
3. Mouse: click the speed button, then press Space. The video plays; the menu stays open.
4. Settings page: tick a box with Space, type a space in the mpv path field (it must stay).
5. A screen reader (NVDA, or Firefox's accessibility inspector): the seek bar reads as "Playback
   position, slider" with the time. A menu button says collapsed or expanded.
6. Picture-in-Picture: the PiP button shows on a playing video, and PiP opens.
7. Save a video from a site that only plays in its own page (a service-worker player). The file
   plays in another player. Cancel a second save half-way; no file is left, and the next save is
   whole.
8. MPV mode on such a page: FastStream plays it and says why, as before.
9. Watcher, after its PR is merged: Actions, "Firefox API watch", Run workflow with `dry_run`; the
   run's summary lists what it would post. Locally: `node tools/firefox-api-watch.mjs --dry-run
   --no-github --from 158 --to 160`.

## 7. Git

| Branch | Commits on main 4813fbee |
|---|---|
| `feature/firefox-api-watch` | feat(tools) watcher; ci workflow; docs; fix(tools) the review's findings |
| `feature/firefox-optimization-ui-modernization` | test(e2e) saving through the page; feat(player) Space, menus, seek slider; fix(player) Space stays a form control's own; docs this report |

Both are pushed, with draft PRs; nothing is merged. To drop a branch after the decision: close its
PR, `git push origin --delete <branch>`, `git worktree remove <path>`, `git branch -D <branch>`.
