# The owner's PC: update-local.cmd

> Why the code in this area is as it is. A date on an entry is when it was learned; where
> the code and its tests say otherwise, they win. A section named in quotes may be in
> another file: [README.md](README.md) lists every section.
> For the owner's own instructions see `docs/maintenance.md`.

`update-local.cmd` (double-click; `tools/update-local.ps1 [-Apply] [-Repo <path>]`) checks
the owner's PC against what CI uses and reports (2026-10-01): Node of the `.nvmrc` major,
npm's newest and the pinned pnpm, by `tools/newest-release.mjs` (CI's rule, `MIN_AGE_DAYS` in
`tools/check-toolchain.mjs`: no wait since 2026-11-09); on a clean `main`, how far it is behind origin, `pnpm install
--frozen-lockfile`, fsaunpack's `npm ci --ignore-scripts`; and whether
`%LOCALAPPDATA%\FastStreamMpvHost`'s host is the repository's (reinstalled by
`native-host/install.ps1` with the installed mpv and Node paths). The check changes nothing
and exits 2 when something is due; the .cmd then asks "Update these now?" and Y runs
`-Apply` (Node: nodejs.org MSI, SHA-256 checked and OpenJS-signed, staged in a folder
`tools/update-local-lib.ps1` locks to the user, Administrators and SYSTEM by SID (names are
localized: "Administratoren" broke it on the owner's German Windows, 2026-10-03), admin
prompt). The installs run only when a lockfile changed after the last install. WSL too
(2026-10-04, instead of `wsl-releases.yml`'s issues): `wsl.exe --version` against
microsoft/WSL's latest release (`newest-release.mjs wsl`), and
`-Apply` runs `wsl --update`, then `wsl --shutdown` (which stops a running `verify:linux`).
`WSL_UTF8=1` for those calls: wsl.exe otherwise writes UTF-16, read as a NUL after every
character (`ConvertFrom-WslVersionText` drops them all the same, and reads the number, not
the localized label). Never Firefox, mpv (`C:\Program Files\mpv` is the owner's own
repository, Nawid3333/mpv-config, with its own updater) or the Ubuntu releases inside WSL.
