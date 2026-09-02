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

## 1. Fix Windows build: `miniglob.mjs` `volumeNameLen` shadowing

- **Source:** commit `ab0719d` on `dev/mv3-modernization`, standalone —
  nothing else depends on it.
- **Problem:** `cleanGlobPath`'s Windows branch takes a parameter also named
  `volumeNameLen`, shadowing the module-level function of the same name, then
  calls it as if it were still the function. Every Windows build throws.
  Andrew has only ever built on Linux, so this has never surfaced for him.
- **Fix:** rename the parameter (`vollen`), drop the dead recomputation.
- **Standalone:** yes — one file, no dependency on pnpm/CI/anything else in
  this fork.
- **Status:** `queued`

## 2. Add `.gitattributes` for cross-platform line endings

- **Source:** currently bundled inside `e81b036` (harness commit) — needs to
  be extracted as its own single-purpose commit before it can be offered as
  a clean PR. Do not cherry-pick `e81b036` whole.
- **Problem:** no `.gitattributes` exists, so a checkout with
  `core.autocrlf=true` (the common Windows Git default) converts every
  tracked file to CRLF, which ESLint's `linebreak-style` rule then flags —
  2352 errors on a completely unmodified checkout.
- **Fix:** `* text=auto eol=lf` plus explicit binary declarations for the
  wasm/image/audio assets.
- **Standalone:** yes, but needs the extraction step above first.
- **Status:** `queued`

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
