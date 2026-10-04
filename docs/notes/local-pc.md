# The owner's PC: update-local.cmd

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; [README.md](README.md) lists where the other sections went.
> For the owner's own instructions see `docs/maintenance.md`.

`update-local.cmd` (double-click; `tools/update-local.ps1 [-Apply] [-Repo <path>]`) checks
the owner's PC against what CI uses and reports (2026-10-01): Node of the `.nvmrc` major,
npm's newest and the pinned pnpm, each 5 days old by `tools/newest-release.mjs` (CI's rule,
`tools/check-toolchain.mjs`); on a clean `main`, how far it is behind origin, `pnpm install
--frozen-lockfile`, fsaunpack's `npm ci --ignore-scripts`; and whether
`%LOCALAPPDATA%\FastStreamMpvHost`'s host is the repository's (reinstalled by
`native-host/install.ps1` with the installed mpv and Node paths). The check changes nothing
and exits 2 when something is due; the .cmd then asks "Update these now?" and Y runs
`-Apply` (Node: nodejs.org MSI, SHA-256 checked and OpenJS-signed, staged in a folder
`tools/update-local-lib.ps1` locks to the user, Administrators and SYSTEM by SID (names are
localized: "Administratoren" broke it on the owner's German Windows, 2026-10-03), admin
prompt). The installs run only when a lockfile changed after the last install. WSL too
(2026-10-04, instead of `wsl-releases.yml`'s issues): `wsl.exe --version` against
microsoft/WSL's latest release once it is 5 days old (`newest-release.mjs wsl`), and
`-Apply` runs `wsl --update`, then `wsl --shutdown` (which stops a running `verify:linux`).
`WSL_UTF8=1` for those calls: wsl.exe otherwise writes UTF-16, read as a NUL after every
character (`ConvertFrom-WslVersionText` drops them all the same, and reads the number, not
the localized label). Never Firefox, mpv (`C:\Program Files\mpv` is the owner's own
repository, Nawid3333/mpv, with its own updater) or the Ubuntu releases inside WSL.
