# Upstream PR candidates

Tracks fixes on `dev/mv3-modernization` that are self-contained enough to
offer back to `Andrews54757/FastStream`, independent of the rest of the
modernization work.

**Held per project decision:** no PR gets opened until the whole fork is
done, so Andrew can integrate them one at a time without ever landing on a
broken intermediate state. See `CHECKPOINT.md`.

**Test workflow, once we start cutting these:**

1. Branch from `upstream/main` on the fork (`dev/mv3-modernization`'s
   remote), not from `dev/mv3-modernization` itself — the PR must be a clean
   diff against Andrew's tree, not against our modernization work.
2. Cherry-pick or hand-port just the relevant change onto that branch.
3. Push it, then in `V:\Faststream modernisation\FastStream` (the pristine
   clone of `Andrews54757/FastStream`, `origin` pointed straight at Andrew's
   repo) pull the candidate branch and merge it into a local `main` to prove
   it applies cleanly and builds/tests green on Andrew's actual tree, not
   just ours.
4. Only after that local merge succeeds does the branch get shown to you and
   a PR get opened.

Status values: `queued` (identified, not yet cut) · `cut` (branch exists,
not yet test-merged) · `verified` (test-merged clean in the pristine clone)
· `opened` (PR live upstream) · `merged`.

---

## How the queue is ordered

Andrew has a working Chrome Web Store extension. Nothing offered upstream may
put that at risk, and each PR has to stand on its own — he should be able to
take number 3 and skip number 4 without anything breaking.

So the queue runs from *touches no shipped code* to *changes what ships*, and
within that, from small to large:

| Wave | What it is | Risk to his store build |
|---|---|---|
| A | repository hygiene and one shipped bug fix | none - A0 fixes a path that already fails |
| B | tests and CI | none — new files only |
| C | library provenance | real — changes what ships, one library at a time |
| D | Firefox MV3 / AMO | real — but only affects a target he does not ship |

Wave C is the one that matters for FastStream's own store standing, and it is
also the one that must go slowly: every entry there has an end-to-end test
attached, for exactly the reason recorded in `docs/vendored-libraries.md` —
migrating mp4box on a diff that "only added things" shipped a regression that
no linter caught.

---

# Wave A — repository hygiene

## A0. Fix the resampler: it fetches a wasm file that is not there

- **Commit:** `pending` (this fork)
- **What:** `reencoder/libsamplerate.mjs` is webpack output, and webpack wrote
  the wasm reference under its content-hashed name:

  ```js
  module.exports = __webpack_require__.p + "625941a851f0440e1705.wasm";
  ```

  The file vendored beside it is `libsamplerate.wasm`. Nothing sets
  `Module.locateFile`, so the request 404s - and because the glue is built
  with `BINARYEN_ASYNC_COMPILATION=0` it instantiates synchronously, so the
  404 body reaches `WebAssembly.Module` and fails with
  `at offset 4: failed to match magic number`. One string literal fixes it.
- **Why he wants it:** audio resampling during re-encode has never worked, in
  any release, on any browser. It is reached only from `reencoder.mjs`, which
  needs WebCodecs and so runs on Chrome only, and only when a user re-encodes
  a download - which is why nothing caught it. Verified present in upstream
  v1.3.77.
- **Depends on:** nothing. Ideally offered together with the e2e test from B3
  that proves it, since the fix is otherwise a one-character-looking change to
  a 50 KB vendored bundle and hard to take on faith.
- **Note:** send this one first. It is the smallest diff in the queue and the
  only one that fixes something users can hit.
- **Status:** `queued`

## A1. Fix Windows build: `miniglob.mjs` `volumeNameLen` shadowing

- **Commit:** `ab0719d`
- **What:** a function parameter shadows the outer `volumeNameLen`, so path
  handling breaks on Windows and the build cannot complete there.
- **Why he wants it:** contributors on Windows currently cannot build at all.
- **Depends on:** nothing.
- **Status:** `queued`

## A2. Add `.gitattributes` for cross-platform line endings

- **Commit:** needs extraction from `e81b036`, which bundles other changes.
- **What:** normalises to LF in the repository.
- **Why he wants it:** without it a Windows clone rewrites every file to
  CRLF, which makes diffs unreadable and, once A3 lands, produces thousands
  of `linebreak-style` errors.
- **Depends on:** nothing. Pairs with A3 — send A2 first.
- **Status:** `queued`

## A3. ESLint covers `.mjs`, which is 94% of the codebase

- **Commit:** `1d2ff5a`
- **What:** the lint script only ever matched `.js`, so almost nothing was
  linted.
- **Why he wants it:** the config already exists; it simply was not reaching
  the files.
- **Depends on:** A2 in practice.
- **Note:** landing this surfaces a backlog of pre-existing violations. Offer
  it with the autofixable ones already applied, or he will reasonably decline
  a PR that turns his CI red.
- **Status:** `queued`

---

# Wave B — tests and CI

Everything here adds files and changes no shipped byte.

## B1. Unit test suite (vitest)

- **Commit:** `65daf55`
- **What:** covers stream detection, buffer maths, string utils and URL
  parsing. 58 tests.
- **Why he wants it:** these are the pure functions most likely to break
  silently during a refactor, and they had no coverage.
- **Depends on:** nothing. Vitest is a devDependency only.
- **Status:** `queued`

## B2. CI: lint, typecheck, test, build, addons-linter

- **Commits:** `2ca0d94`, `cf7be94`
- **What:** a GitHub Actions workflow running the whole gate on push and PR,
  including Mozilla's addons-linter — the same engine AMO runs on upload.
- **Why he wants it:** it turns "does this still pass AMO's automated
  checks?" into something answered on every commit rather than at submission
  time.
- **Depends on:** B1 for the test step; degrades gracefully without it.
- **Status:** `queued`

## B3. End-to-end playback tests (WebdriverIO + Firefox)

- **Commits:** `a0d7f26`, `92af8fa`, `caa3bb5`
- **What:** loads real HLS, DASH and MP4 streams in a real browser and
  asserts `currentTime` actually advances. Plus `modules.e2e.mjs`, which
  exercises the libraries that never appear on the playback path — gif.js,
  mp4-muxer, jswebm and coloris.
- **Why he wants it:** this suite is what caught the mp4box regression. It
  replaces a manual three-URL checklist that nobody ran.
- **Depends on:** B2 for the CI wiring; runnable locally without it. Needs
  ffmpeg on Linux runners for H.264.
- **Note:** the single highest-value PR in the queue for him, and the one to
  lead with if only one ever gets sent.
- **Status:** `queued`

## B4. Build-output hasher for output-neutrality checks

- **Commit:** `ffa233e`
- **What:** `tools/hash-build.mjs`, which hashes a build directory with EOL
  normalisation so two builds can be compared across platforms.
- **Why he wants it:** it is how you prove a refactor changed no shipped
  byte. Small and self-contained.
- **Status:** `queued`

## B5. Opt-in type checking and cross-context message contracts

- **Commit:** `0176208`
- **What:** `tsc --noEmit` over JSDoc types, plus typed message contracts
  between the background, content and player contexts.
- **Why he wants it:** the message passing between contexts is stringly typed
  and easy to get wrong.
- **Note:** more opinionated than the rest of wave B. Offer last, and only if
  the earlier ones land well.
- **Status:** `queued`

---

# Wave C — library provenance

The work that answers Mozilla's stated objection, and useful to Andrew
whether or not he ever ships to AMO: it replaces roughly 6.9 MB of
unattributed vendored JavaScript with pinned releases plus reviewable
patches.

**Send C0 first and alone.** Everything after it is a small diff on top.

## C0. `sync-vendor.mjs` and the identification tools

- **What:** the generator (`tools/sync-vendor.mjs`), plus `ast-compare.mjs`,
  `find-base.mjs` and `compare-decls.mjs` — the tools that establish which
  published release a vendored file came from, by comparing parsed programs
  rather than diff lines.
- **Why he wants it:** it makes "which version is this, and what did we
  change" a question with an answer, for every library at once.
- **Ship with:** fuse.js and pako only. Both are stock npm releases with no
  patch — fuse.js is byte-identical and pako needs one added export line — so
  C0 can be reviewed without also arguing about a patch.
- **Status:** `queued`

## C1–C9, one per library

Each is: pin the release, generate the file, delete the vendored copy, and
where needed commit a patch. Ordered by risk, lowest first.

| # | Library | Base | Patch | Test | Status |
|---|---|---|---|---|---|
| C1 | sortablejs | npm 1.15.2 | none | — | `queued` |
| C2 | sweetalert2 | npm 11.12.4 | none, but a locale payload must stay stripped | — | `queued` |
| C3 | gif.js | npm 0.2.0 | none — AST-identical | `modules.e2e.mjs` | `queued` |
| C4 | mp4-muxer | npm 4.3.3 | none — AST-identical | `modules.e2e.mjs` | `queued` |
| C5 | onnxruntime-web | npm 1.20.0 | none — replaces a hand-minified bundle | none yet | `queued` |
| C6 | jswebm | npm 0.1.2 | 23 KB, five changes, two of them upstream bug fixes | `modules.e2e.mjs` | `queued` |
| C7 | Coloris | git, pinned commit | 10 KB | `modules.e2e.mjs` | `queued` |
| C8 | hls.js | npm 1.6.9 | 31 KB, 22 hunks | `playback.e2e.mjs` | `queued` |
| C9 | dash.js | npm 5.1.0 | 354 KB | `playback.e2e.mjs` | `queued` |

**C8 carries a dependency of its own.** Its patch would shrink considerably
if `video-dev/hls.js` widened its exports map — see the note at the foot of
this file. Worth filing that issue before offering C8.

## C10. vtt.js provenance, verified rather than generated

- **What:** `tools/verify-vtt.mjs` and `pnpm run verify:vtt`. `vtt.mjs`
  cannot be generated — it is dash.js's `contrib/videojs-vtt.js/vtt.js`,
  which dash.js publishes only minified — so instead the script fetches
  upstream, applies the three documented changes, and asserts the two parse
  to the same program.
- **Why he wants it:** it turns "trust this 88 KB blob" into a claim anyone
  can re-run, which is what a reviewer is actually asking for.
- **Status:** `queued`

## C11. `docs/vendored-libraries.md`

- **What:** the analysis behind wave C — every base version, how it was
  determined, what each patch changes and why, and the libraries that stay
  vendored with their provenance recorded.
- **Why he wants it:** it answers a reviewer's questions without a
  conversation.
- **Depends on:** send after the wave it describes, or trim to match.
- **Status:** `queued`

---

# Wave D — Firefox MV3 and AMO

The payload of this fork. Offer only after waves A–C have landed, because
each of these is easier to review once the tree is already tested and its
libraries already have provenance.

## D1. Re-enable the Firefox store build and make it submittable

- **Commit:** `7ed4723`
- **What:** `data_collection_permissions`, `strict_min_version: 142`, a
  non-persistent background script instead of a service worker, and the
  manifest keys Firefox rejects removed.
- **Why he wants it:** without it the Firefox target does not pass
  addons-linter at all.
- **Status:** `queued`

## D2. Splice YouTube out of the AMO build

- **Commits:** `288b375`, plus `39c8a3a`, which restored it after it was
  briefly removed.
- **What:** a `NO_YOUTUBE` splice target that drops `yt.mjs`,
  `googlevideo.mjs`, `YTPlayer`, `SandboxedEvaluator` and `yt_runner.js`, and
  with them the `userScripts` permission and the `unsafe-eval` world.
- **Why he wants it:** `yt_runner.js` runs `new Function()` on YouTube's
  signature-decipher code, fetched at runtime. AMO prohibits remote code
  execution outright — this is not a warning to argue about, and it is the
  single thing that makes a Firefox submission unwinnable. Chrome is
  unaffected, so it costs him nothing.
- **Depends on:** D1.
- **Status:** `queued`

## D3. Developer profile launchers

- **Commits:** `d47309f`, `411c966`, `e13fd8c`
- **What:** `pnpm run start:ff` and friends, which build and launch an
  isolated Firefox profile — never the developer's own — with the extension
  loaded and uBlock Origin preinstalled.
- **Why he wants it:** it is the difference between a one-command test loop
  and a manual `about:debugging` dance.
- **Note:** convenience, not correctness. Lowest priority here.
- **Status:** `queued`

---

# Not in the queue

## The pnpm migration

`30625bb` moved the project from npm to pnpm, and everything after it
assumes that — `patchedDependencies` in `pnpm-workspace.yaml` is how wave C's
patches get applied at all.

It is deliberately **not** offered as a PR. Choosing a package manager is a
maintainer's call, not a contributor's, and pushing it would make every other
PR here contingent on it. If Andrew wants the patch mechanism without pnpm,
the same thing is achievable with `patch-package` on npm — and that is the
version to offer him, not this one.

---

## A build framework (WXT, or any bundler)

Recorded here because it has come up, and because adopting one would change
what the rest of this file is worth.

**The fork does not use WXT today.** There is no `wxt` dependency, no
`wxt.config.ts`, no `entrypoints/` directory. The build is Andrew's
`build.mjs` — the SPLICER preprocessor plus `web-ext` — with
`tools/sync-vendor.mjs` added in front of it to generate the vendored
libraries from pinned releases.

Three reasons that is the right position for now, in descending order of
weight:

**1. The extension currently ships unbundled, unminified ES modules, and
that is an asset with AMO.** Every file in `build_firefox_amo` is either
first-party source that a reviewer can read, or a file generated from a
pinned release they can fetch and hash. Mozilla requires a separate source
code submission, with build instructions they must reproduce, when the
submitted code is bundled, minified or transpiled. Today that requirement
does not apply. A Vite-based build would trigger it — and would do so for an
add-on whose *previous rejection was about reviewers being unable to verify
shipped code*. That is the wrong direction to move in.

**2. It would make almost everything in this file unsendable.** A framework
migration rewrites `build.mjs`, the manifest handling and the entrypoint
layout at once. Andrew could not take it incrementally, it would conflict
with every other PR here, and it violates the rule this queue is built
on — that he can integrate one change at a time and still have a working
program.

**3. It buys the least where this fork is weakest.** The open problems are
libsamplerate's laptop-built wasm, the ONNX Runtime blobs, and knob's
provenance. A framework does nothing for any of them. What it offers is a
faster dev loop, and `pnpm run start:ff` already covers that.

None of this is an argument that WXT is bad. It is a good framework, and for
a *new* extension it would be the obvious choice. The argument is about
sequencing: adopt it, if at all, after the Firefox submission is accepted and
after whatever is going upstream has gone — not before, when it would put
both goals at risk to buy developer convenience.

---

## Fork-only — never send upstream

**The build-target rename.** `chrome_dist`/`chrome_libre`/`firefox_dist`/
`firefox_libre` became `chrome_webstore`/`chrome_github`/`firefox_amo`/
`firefox_github`, and `lint:amo` now lints the AMO build rather than the
self-install one.

The reason is not taste. "dist" reads as the download build and "libre" as
the free one, which is backwards - `dist` is the store target and `libre` is
the self-install target - and that misreading led to a change that would have
put YouTube's remote-code path into the AMO submission. Naming a target after
where it goes removes the trap.

Upstream has no such trap to remove, and a rename in `build.mjs` is pure
conflict surface for every other PR that touches that file. It stays here.
Keep it in its own commit so it can be rebased around if that ever changes.

---

## Not FastStream PRs — upstream hls.js issue (separate project)

Not a candidate for Andrew's repo. Once the hls.js migration (step 2) is
done, the demuxer/remuxer export widening
(`AACDemuxer`/`MP3Demuxer`/`MP4Demuxer`/`TSDemuxer`/`MP4Remuxer`/
`PassThroughRemuxer`/`AvcVideoParser`/`ExpGolomb`) that `hls2mp4/transmuxer.mjs`
needs is a small, reasonable ask to file against `video-dev/hls.js` itself —
"please export these from the package's public exports map." If accepted,
FastStream's hls.js patch shrinks further. Tracked here only as a note; not
in scope for the FastStream PR queue above.

See `docs/vendored-libraries.md` for the full analysis this depends on.
