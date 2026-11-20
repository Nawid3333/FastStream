# Working notes

What was learned while changing this project, by area: why the code is as it is, what
shipped broken once, how each workflow decides. `CLAUDE.md` in the repository's root holds
the rules that apply to every change and points here; read the note for the area you are
about to change before changing it, and add to it afterwards.

| File | Area | Sections |
|---|---|---|
| [build-and-release.md](build-and-release.md) | Building and releasing | The SPLICER preprocessor; Build targets; Releasing (auto-release.yml); AMO lint (firefox-amo, current: 0 errors / 0 warnings, needs `--self-hosted`); Firefox for Android (2026-11-20); Baseline verification |
| [history.md](history.md) | What was removed, and upstream bugs fixed here | YouTube removal; Known upstream bugs fixed here |
| [keybinds.md](keybinds.md) | Keybinds | Keybinds |
| [libraries.md](libraries.md) | Vendored libraries | Vendored libraries; The binary blobs are identifiable published artifacts; sortablejs: what checks it; Tools: reasons behind the code |
| [local-pc.md](local-pc.md) | The owner's PC: update-local.cmd | - |
| [mpv.md](mpv.md) | MPV mode and the native host | MPV mode and the native host; Host 15: the thin helper; Background: reasons behind the code |
| [playback-testing.md](playback-testing.md) | Manual playback testing | Manual playback testing; Tests: reasons behind the code |
| [player.md](player.md) | The player | Architecture facts that are easy to get wrong; Player core: what the loaders tell the libraries; Which version of a height gets picked; A quality lowered when the computer drops frames; The audio output; The qualities a page's own player offers; Player engines: reasons behind the code; MP4Player and its MediaSource; MP4 from servers that do not answer ranges; An MP4 paused, at its end, and played again; An MP4's audio tracks; A file is what its bytes are, and Firefox's own player keeps the page's headers; AAC in a channel layout of its own, on Windows; Downloads between players, after seeks and errors; Players in several tabs take turns; Loading through the page; Firefox VPN; A copy-protected video stays in the page's player; Background: reasons behind the code; The background's questions to a frame have a time limit; The background analyses and hostile subtitle files; A page loaded again keeps FastStream's player; Content scripts: reasons behind the code; Interface: reasons behind the code; Utils, options, enums, dash2mp4: reasons behind the code; Settings in the cloud; Measuring two builds: tools/bench-ab.mjs |
| [storage.md](storage.md) | Network layer and storage | Network layer: fetch() + OPFS; Storage in a private window; RAM first, a budget, and private windows in RAM only; What goes to the disk, measured; A reload keeps the buffer for 20 s; Network layer: reasons behind the code |
| [type-checking.md](type-checking.md) | Type checking | Type checking |
| [workflows.md](workflows.md) | Workflows | Workflows; Firefox API watch; Issues anyone can open; Tools: reasons behind the code |

History lives in `docs/history/`: [reviews.md](../history/reviews.md) (what each review and
audit found, fixed and rejected), [modernisation-checkpoint.md](../history/modernisation-checkpoint.md)
(the record of the modernisation; several of its sections no longer hold),
[firefox-optimization-ui-review.md](../history/firefox-optimization-ui-review.md),
[upstream-candidates.md](../history/upstream-candidates.md) and
[upstream-sync-log.md](../history/upstream-sync-log.md) (what was taken from upstream while
this fork still merged it).

The runbooks stay one folder up: `docs/maintenance.md` (the owner's guide to the e-mails
and PRs), `docs/updating-patched-libraries.md`, `docs/vendored-libraries.md`,
`docs/amo-linter-warnings.md`, `docs/amo-source-submission.md` and `docs/privacy-policy.md`.
