# Working notes

What was learned while changing this project, by area: why the code is as it is, what
shipped broken once, how each workflow decides. `CLAUDE.md` in the repository's root holds
the rules that apply to every change and points here; read the note for the area you are
about to change before changing it, and add to it afterwards.

These were sections of `CLAUDE.md` until 2026-10-04 (it had grown to 128 KB, loaded into
every agent session). Where a note names a section in quotes, this is where it is now:

| Section | File |
|---|---|
| Keybinds | [keybinds.md](keybinds.md) |
| Manual playback testing | [playback-testing.md](playback-testing.md) |
| Architecture facts that are easy to get wrong | [player.md](player.md) |
| MP4Player and its MediaSource (2026-09-27) | [player.md](player.md) |
| Player core: what the loaders tell the libraries (2026-09-28) | [player.md](player.md) |
| Network layer: fetch() + OPFS (2026-09-10) | [storage.md](storage.md) |
| Storage in a private window (2026-09-17) | [storage.md](storage.md) |
| MPV mode and the native host | [mpv.md](mpv.md) |
| The SPLICER preprocessor | [build-and-release.md](build-and-release.md) |
| Build targets | [build-and-release.md](build-and-release.md) |
| Releasing (auto-release.yml, added 2026-09-12) | [build-and-release.md](build-and-release.md) |
| AMO lint (firefox-amo, current: 0 errors / 3 warnings, needs `--self-hosted`) | [build-and-release.md](build-and-release.md) |
| Baseline verification | [build-and-release.md](build-and-release.md) |
| Workflows (reworked 2026-09-25) | [workflows.md](workflows.md) |
| Vendored libraries | [libraries.md](libraries.md) |
| The binary blobs are identifiable published artifacts | [libraries.md](libraries.md) |
| Type checking | [type-checking.md](type-checking.md) |
| YouTube removal | [history.md](history.md) |
| Known upstream bugs fixed here | [history.md](history.md) |
| Commands: the `update-local.cmd` paragraph | [local-pc.md](local-pc.md) |

The runbooks stay one folder up: `docs/maintenance.md` (the owner's guide to the e-mails
and PRs), `docs/updating-patched-libraries.md`, `docs/vendored-libraries.md`,
`docs/amo-linter-warnings.md`, `docs/upstream-sync-log.md` (what was merged from upstream until
2026-10-09), and
`docs/modernisation-checkpoint.md` (the record of the modernisation; several of its
sections no longer hold).
