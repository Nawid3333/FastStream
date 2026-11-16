# Security policy

## Supported versions

Only the latest release gets security fixes. Firefox updates the add-on by itself (it reads the
`updates.json` every release publishes), so an installed copy is on the latest release within a
day of it. FastStream needs Firefox 153 or newer, and the fixes are made and tested on the current
Firefox release.

## Reporting a vulnerability

Please report it privately, not in a public issue:
[open a private security advisory](https://github.com/Nawid3333/FastStream/security/advisories/new)
(the repository's Security tab, "Report a vulnerability"). Describe what an attacker can do, the
FastStream version and the Firefox version, and the steps or a page that shows it.

You get an answer as soon as possible, usually within a few days. A confirmed problem is fixed
in a release, and the advisory is published once that release is out, with credit to you unless
you ask otherwise.

## Scope

In scope:

- the add-on itself (`chrome/`): its content scripts, background script, player and option pages;
- the mpv helper (`native-host/`), which receives the streams the add-on hands to mpv;
- the release pipeline in `.github/workflows/` (signing, `updates.json`).

Out of scope: the libraries the add-on ships (hls.js, dash.js, mp4box.js, Mediabunny and others,
see [docs/vendored-libraries.md](docs/vendored-libraries.md)), unless FastStream's own use or its
patch of one makes the problem; report those to their projects. Sites playing their own videos,
and content protected by DRM (FastStream leaves it to the site's player), are not FastStream's.

What FastStream sends where is in [docs/privacy-policy.md](docs/privacy-policy.md).
