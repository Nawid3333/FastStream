# Building and releasing

> Working notes, moved here from `CLAUDE.md` on 2026-10-04 so that file stays short. The
> text is as it was written; dated entries describe the tree at their date. Where a note
> says "above", "below" or names a section in quotes, [README.md](README.md) lists the
> file each section is in now.

## The SPLICER preprocessor

`build.mjs` strips or injects code per build target using comment directives:

```js
// SPLICER:<TARGET>:REMOVE_LINE      drop this line
// SPLICER:<TARGET>:REMOVE_START     drop everything until REMOVE_END
// SPLICER:<TARGET>:REMOVE_END
// SPLICER:<TARGET>:REMOVE_FILE      drop the whole file
// SPLICER:<TARGET>:INSERT_LOCALE    inline all _locales messages
// SPLICER:<TARGET>:INSERT_VERSION   inline the package.json version
```

**It only processes `.mjs` and `.js`.** Move code into a `.ts` file and it
silently stops being spliced — no error, wrong code ships. Stay on `.mjs`
plus JSDoc.

The code is `tools/splicer.mjs` (tests: `tests/unit/splicer.test.mjs`). A directive is
a `//` comment that is exactly `SPLICER:<TARGET>:<COMMAND>`; any other `// SPLICER:`
comment, unknown target or unknown command fails the build, and the text in a string or
block comment is not a directive (#168). Everything else ships as written, blank lines
included: until 2026-10-03 every blank line was dropped, inside template literals too.

Targets: `EXTENSION`, `FIREFOX`, `WEB`, `NO_UPDATE_CHECKER`; no code carries a
`FIREFOX` block any more, but both Firefox builds still pass it.
(`CENSORYT` and `NO_YOUTUBE` existed before YouTube support was removed
entirely — see "YouTube removal" below — and no longer apply to anything;
`NO_PROMO` went with the review prompt on 2026-09-20.)

## Build targets

**Firefox only (decided 2026-09-11).** Nawid only uses this fork on Firefox;
`buildChromeGithub()`/`buildChromeWebstore()` and the `chrome-github`/
`chrome-webstore` targets were removed from `build.mjs`, the release
workflow's asset list, and the comments around CI's Chromium E2E step.
**Chromium was dropped altogether on 2026-09-20:** that step, `wdio.chromium.conf.mjs`, the
`test:e2e:chromium` and `test:e2e:all` scripts, the `chromedriver` dependency, the Chrome and
Safari branches of the code (`EnvUtils.isChrome/isFirefox/isSafari` are gone), Chromium's
`details.initiator` handling in the background script (Firefox does not send that field, so it
never ran here; measured), and the Chrome-family registration in the mpv host installer.
`chromeSourceDir` (`chrome/`) keeps its name because upstream's tree does, and the sync bot merges
upstream into it. `chrome/manifest.json` is Firefox's own: an event page, no Chrome-only keys, and
the `downloads` and `cookies` permissions the builds used to add. The built manifests are
byte-identical to what the old transformations produced. The plain `web` target stays: the web
e2e suite runs against it, in Firefox.

| Target | Splices | Notes |
|---|---|---|
| `firefox-github` | EXTENSION, FIREFOX | manual install |
| `firefox-amo` | EXTENSION, FIREFOX, NO_UPDATE_CHECKER | AMO target; min version 142, declares data_collection_permissions |
| `web` | WEB, NO_UPDATE_CHECKER | faststream.online, no extension APIs |

`buildFirefoxAmo()` was written but never invoked (commit "Remove firefox
dist build for now"). Re-enabled in `7ed4723`.

The 12 `EnvUtils.isChrome()`/`isFirefox()` branches elsewhere in the
codebase (playback-rate caps, the 7.1-audio workaround, OPFS backend
selection, SponsorBlock's extension ID), left in place on 2026-09-11, went
with the rest of Chrome's code on 2026-09-20; none is left.

## Releasing (auto-release.yml, added 2026-09-12)

Every push to `main` that passes CI now gets released
automatically — no separate "ship it" step. `auto-release.yml` waits for
CI to go green on that branch (`workflow_run`, not `push` directly — a
red push is never released), then bumps just the trailing build number
(`1.3.82.0` -> `1.3.82.1` -> ...; past any build number whose tag exists, locally or on
the remote, since a reverted release takes the version back and leaves its tag), commits
`chore: release <version>`, tags it, and pushes both in one `git push --atomic` (a
refused push leaves neither, never a release commit without its tag), then explicitly runs `gh workflow run
release.yml --ref v<version>` to do the actual build/sign/publish.
That last step has to be explicit: the tag push is authenticated with the
default `GITHUB_TOKEN`, and GitHub deliberately does not let a
`GITHUB_TOKEN`-authenticated push fire other workflows' `push` triggers
(anti-recursion protection) — confirmed the hard way when `v1.3.82.1`'s
tag landed with no Release run behind it, before this dispatch step
existed.

The bump commit is pushed with `GITHUB_TOKEN` like the tag, so it starts no
CI run: the release commit itself is never CI-tested (it changes only the
version; release commit `598c2d6a` has no CI run). Should CI run on it anyway,
by a dispatch or a re-run, the workflow's `if:` skips any `workflow_run` whose
head commit message starts with `chore: release `, so a release never
releases itself.

**Only when something shipped changed** (2026-09-25). Before bumping,
auto-release downloads CI's build of the commit (the `faststream-bundles`
artifact) and the latest release's `firefox-github-*.zip` and signed xpi, unzips them and
runs `diff -rq`: the github zip against its zip, the AMO build against the xpi minus
`META-INF/` (Mozilla's signature; otherwise the xpi is that build, checked on 1.3.82.52).
Until #164 (2026-10-03) only the github zip was compared, so a change to the AMO build
alone (its `update_url`) released nothing. A release still waiting for its xpi cannot be
compared, so a push then releases. Identical means the push touched only tools, tests,
workflows, docs or dev dependencies, and the release would differ from the
last one only in its version number (v1.3.82.33 after PR #21 was exactly
that), so it stops with a notice and nothing is released. Any doubt - no
release, no artifact, a failed download or unzip, any difference - releases
as before. Checked on real history before it went in: PR #21's merge build
against v1.3.82.32 is identical; PR #20's against v1.3.82.31 differs in the
six dash.js/mp4box files it changed. The builds are deterministic enough for
this: two releases from different commits differ only in `manifest.json`'s
version. To release such a push anyway, run `pnpm run release <version>`.

`tools/cut-release.mjs` (`pnpm run release <version>`) still exists for a
deliberate version bump — a real minor/patch for a milestone rather than
the next build number. Run it by hand right before the push you want that
version on; auto-release's next build-number bump continues from whatever
version that leaves in `package.json`.

**AMO signing no longer depends on a timer.** AMO has no webhook for "signed" (its API
documents none), so `tools/sign-amo.mjs` uploads and polls, waiting up to 30 minutes
(`approvalTimeout`). Measured over 30 releases: 2-6 minutes, once 15. When the wait runs
out, the release is published without the xpi and `updates.json` (the sign step is
`continue-on-error`), and **`amo-signing-failsafe.yml`** ("Release failsafe") completes it:
`release.yml` starts it after every run, and a schedule every 3 hours as well. It checks the
latest release and, if incomplete, builds that tag and asks AMO for the version
(`tools/fetch-amo-signed.mjs --wait 40`, no upload; the tools are main's, the build the
tag's): signed -> download (byte-identical to web-ext's
file, checked on 1.3.82.27; the regenerated `updates.json` matched the published one
exactly) and attach both; pending -> next run; missing (never uploaded) -> sign now;
rejected, or still incomplete after 24 h -> one issue, assigned + @mention, closed when the
release is complete. Re-running `web-ext sign` cannot do this: AMO refuses a second upload
of a version. v1.3.79.0 and v1.3.82.2, the two releases without an xpi, are both `public`
on AMO - the failsafe would have collected them. `release.yml`'s `timeout-minutes: 45`
covers the 30-minute wait. **A network error does not end the wait** (2026-09-28):
v1.3.82.37 passed validation, then one `fetch failed` while web-ext polled for approval
failed the step, and the release lacked its xpi and `updates.json` until the failsafe
(run by hand) collected them 10 minutes later. `sign-amo.mjs` now goes on asking AMO
itself with `fetch-amo-signed.mjs`'s check, every 30 s, within the same 30 minutes; a
version AMO never received is uploaded once more. AMO's own answers (a refused upload, a
failed validation, the approval timeout) still fail the step as before.

**Every release is checked to reach Firefox** (2026-09-28, the failsafe). A version tag
without a release - `release.yml` failed before publishing, or was never started, which no
one heard of before, since the bot starts it - gets `release.yml` started again, at most
twice, then the issue "Release <tag> failed". A complete latest release gets its update
path followed the way Firefox does (`tools/check-update-path.mjs`: the `update_url`
redirect, `updates.json`, the xpi's sha256, `META-INF/mozilla.rsa` and `cose.sig`, the
version and the add-on id `build.mjs` sets); broken -> the issue "Update path broken:
<tag>". Both close on their own; the run stays green once the issue is open, so it is not
repeated by mail. The decision steps were dry-run with a stub `gh` (17 scenarios) before
the change went in.

## AMO lint (firefox-amo, current: 0 errors / 3 warnings, needs `--self-hosted`)

Verified 2026-09-24: both `firefox-amo` and `firefox-github` are **0 errors,
0 notices, 3 warnings**. (`firefox-github` had a 4th until 2026-09-24, see
below.)

The 3 warnings both targets share are all in vendored libraries: `vtt.mjs`
and `vad/ort.wasm.mjs` (`UNSAFE_VAR_ASSIGNMENT`), `dash.mjs`'s webpack
bootstrap eval (`DANGEROUS_EVAL`) — see `docs/amo-linter-warnings.md` for why
each is safe-left-alone. `firefox-github` used to add
`MISSING_DATA_COLLECTION_PERMISSIONS`; it now declares
`data_collection_permissions: {required: ['none']}` like `firefox-amo`, which
needed its `strict_min_version` raised from 136 to 142 (the key needs 140+,
Android 142+). The only versions that dropped, 136-139, were long out of
support and never ESR. Neither target has a `players/PlayerLoader.mjs` or
`yt_runner.js` hit anymore; both disappeared along with YouTube support.

**`pnpm run lint:amo` needs `--self-hosted`, or it reports a false
`MANIFEST_UPDATE_URL` error.** `browser_specific_settings.gecko.update_url`
(set in `build.mjs`'s `buildFirefoxAmo()` for this unlisted build's
self-hosted update checking) is exactly what that flag exists for — per
`web-ext lint --help`, `--self-hosted` "disables messages related to hosting
on addons.mozilla.org." Without it, addons-linter assumes every build is
headed for AMO's own hosting and flags `update_url` as disallowed there,
which is a real rule but doesn't apply to this build. The `package.json`
`lint:amo` script now passes it. **This was live-broken on the real
`dev/mv3-modernization` branch's CI** from the commit that added
`update_url` (2026-09-09) until this fix — confirmed via `gh run view` on
the failing runs, not assumed. An earlier claim in this project's history
that AMO lint was "0 errors" had actually been made from truncated command
output that never showed the error section at all.

## Baseline verification

Any change claiming to be output-neutral must reproduce the upstream build
exactly. Use `tools/hash-build.mjs`, which collapses CRLF to LF for text
files before hashing:

```bash
pnpm run build:keep                                  # --keep is required
node tools/hash-build.mjs build_firefox_github > after.txt
diff baseline.txt after.txt                          # must be empty
```

**Always normalise line endings when comparing builds.** A build made on
Windows before `.gitattributes` existed has CRLF throughout; Andrew's Linux
CI produces LF. Comparing raw bytes across the two makes all 620 text files
look changed when nothing is. Verified for the pnpm migration: 611 text
files and 9 SVGs content-identical, 24 png/wasm/ort byte-identical, 644
total. The LF output this fork now produces is what upstream CI already
ships; the CRLF build was the local anomaly.
