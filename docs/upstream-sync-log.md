# Upstream sync decisions

This fork is maintained on its own. Upstream (`Andrews54757/FastStream`) is a
source of fixes to take, not a tree to stay identical to. The rule for every
upstream commit:

- **Take it** when it fixes something in code this fork still has, or adds
  something small and self-contained that the Firefox build or the web build
  can use.
- **Skip it** when it only serves a site integration this fork does not carry,
  or depends on a feature that was removed here (YouTube). Dead code is
  something a later sync then has to conflict with.
- **Adapt it** when the idea is right but a fork change (OPFS finalize, the
  `fetch()` network layer, no YouTube) makes a plain merge wrong. Say what
  was adapted and why in the merge commit, because git will not.

## How syncs arrive

`.github/workflows/sync-upstream.yml` runs every 6 hours. When upstream has
commits `main` lacks it opens, or updates, one PR from `sync/upstream` that lists
them. Merge it to take (resolve conflicts, keep only what is wanted) or close it
to skip; a PR closed without merging is not reopened for the same upstream
commit. Then add a dated section below saying what was decided and why.

Merge with `git merge`, not cherry-picks: a merge records upstream as an
ancestor, so the next sync only shows new commits and GitHub stops counting the
skipped ones as "behind".

## 2026-09-19: merged up to `9118236f` (10 commits)

| Upstream commit | Decision |
|---|---|
| `32fbe04e` Panopto support | Skipped. The quality-menu `label` grouping fix in it was taken. |
| `454b0722` Panopto element | Skipped (Panopto only). |
| `cd602962` Fix | Skipped (Panopto only). |
| `1cb23b2e` fix | Taken: `mp4merger` edit-list start delay. |
| `b618210f` Fix subtitles | Skipped: `IS_TAB_ENABLED` / `notifyTabEnabled` exist for Panopto's content script. |
| `7deb8b5c` merge | Nothing new: it brings in this fork's own PRs #548 and #550. |
| `960b0c28` Iframe claiming | Skipped: `CLAIM_FRAME` and held sources are used only by Panopto. |
| `b203e35e` fix saving | Taken, adapted: `mp4merger` multi-track fragments, HLS save of fMP4 levels with muxed or no audio. |
| `53b448bd` embed API | Taken: `EmbedAPI` (web target only, `REMOVE_FILE` keeps it out of the extension), the `paused` getter fix, the `FRAME_REMOVED` guard. `VolumeControls` was already fixed here. |
| `9118236f` Bug fixes | Taken: `setSource` queue, single preview-player build, DIRECT needs no interaction, `setChapters`. |

Adapted, where a plain merge was wrong: `mp4merger` keeps this fork's raw Blob
slices in `this.datas` (upstream stores an FSBlob identifier; git merged that
line without a conflict and it yields a file with a header and no media);
`FastStreamClient` imports `PlayerModes` again; `EmbedAPI`'s allowed-mode list
lost `ACCELERATED_PANOPTO`, which is undefined here.

### Next sync: Panopto files will conflict

Upstream will keep changing `panopto_content.js`, `PanoptoPlayer.mjs` and
`PanoptoUtils.mjs`, which this fork deleted. Git reports those as
modify/delete conflicts. Resolve with `git rm` on each, keep this fork's side of
any shared file, and take only what is generic.

### Edges that came in with upstream's code

They arrived unchanged from upstream's design. Each was flagged by a model
review of the merge diff and confirmed by reading the code; none is covered by a
test and none has been reproduced in a browser:

- `setSource` now queues, so a source change that never settles blocks every
  later one.
- A muxed fMP4 level whose audio codec `mp4merger` does not list is saved
  without audio and without an error; a separate audio track of the same codec
  throws `Audio codec not supported!` instead (which also triggers the
  re-encode fallback).
- A preview-player build that started for a source that was replaced while it
  ran discards itself, and a caller that joined it is not rebuilt, so that
  source has no seek preview until the next options change.

### How the merge was checked

Frame-level, not just "it loads": `tests/e2e/specs/save-fmp4.e2e.mjs` saves a
video-only fMP4 HLS level, a muxed one, and a DASH stream with separate tracks,
decodes each result with ffmpeg and compares its frame count to the source. A
container whose sample table points at the wrong bytes still loads and reports a
duration, which is how the existing DASH save spec once passed on a file with no
media in it.
