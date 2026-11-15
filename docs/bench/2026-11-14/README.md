# Benchmarks of 2026-11-14

The A/B runs of main (before PR #679) against `test/all-prs` (what #679 brought in). The reports
beside this file are as `tools/bench-ab.mjs` wrote them (`.md` to read, `.json` with every run's
numbers). This summary was section 3 of the review round's brief (`docs/review-2026-11-14.md`, deleted
on 2026-11-15 when the round was done; its results are in `docs/firefox-optimization-ui-review.md`,
section 9).

`tools/bench-ab.mjs` (`docs/notes/player.md`, "Measuring two builds"): two builds, one server
each, one e2e Firefox, ABBA order per round, one warm-up round thrown away. `--rate`/`--ttfb` put
the media on one shared slow line (first in, first out, 64 KiB at a time). A verdict needs the
medians apart by more than twice the larger spread (MAD) and the measure's floor, and a rank-sum
test with p < 0.05; otherwise "same". It measures; it never fails on a number.

## Several tabs (the owner's question)

`--scenarios tabs`: three players paused in background tabs, one playing in front, each video
(90 s, 2.1 Mbit/s HLS) on a loopback host of its own, all on one line.

| Line, rounds | Measure | main | branch | |
|---|---|---:|---:|---|
| 8 Mbit/s, 7 | the player in front has its whole video | 66.1 s | 29.6 s | better, 7 of 7 |
| | all four have theirs | 109.1 s | 92.3 s | better, 7 of 7 |
| | first frame in front, from its first request | 1168 ms | 1076 ms | better, 7 of 7 |
| | seconds ahead in front, 10 s in | 18.8 s | 19.1 s | same |
| 40 Mbit/s, 5 | in front; all four | 6.5 s; 18.3 s | 6.5 s; 18.2 s | same |

Controls (8 Mbit/s, 3 rounds): main against the branch before the turns (2f8cd482): 64.0 and
63.6 s in front, 109.9 and 110.0 s for all: the same, so the difference is the turns. Main
against a copy of itself: the same in every measure.

**A caveat that cost an evening.** The tabs scenario's "player modules ready" (a new tab's page
start) comes in two speeds, about 0.25 s and 0.6 s, by the Firefox session, not by the build:
main had 0.25 s in every round of one run and 0.6 s in every round of the next. Counted from
the navigation, the first frame read 0.27 s *worse* for the branch, 7 of 7 rounds, p < 0.001 -
an artifact. The first frame is now counted from the page's first request for the video, and
the tabs scenario's "player modules ready" has a floor of 0.5 s, so the report gives it no
verdict below that. The tabs reports beside this file were written before that floor: their
"player modules ready: worse" line is this two-speed artifact. What causes the two speeds was not found.

## General (main against the branch, 7 rounds)

Local files, no limit (`general-local-main-vs-branch.md`) and a 12 Mbit/s line with 150 ms to
the first byte, MP4 and HLS (`general-12mbit-150ms-main-vs-branch.md`). Nothing is slower:

| Measure | main | branch | |
|---|---:|---:|---|
| MP4, local: player modules ready; first frame | 673; 997 ms | 607; 915 ms | better |
| MP4, local: seek preview at 120 s shown | 68 ms | 31 ms | better |
| MP4: wake-ups a second while playing; paused; ended | 40.9; 41.3; 253 | 25.0; 9.5; 9.4 | better |
| HLS: player modules ready, local; slow line | 705; 686 ms | 608; 587 ms | better |
| Idle player: modules ready | 736 ms | 581 ms | better |
| Slow line, MP4 seek to 80 s: seeked; playing past it | 1572; 1856 ms | 1581; 1864 ms | same |
| MP4 and DASH: DOM changes a second while playing | 28.1; 37.5 | 31.1; 41.2 | worse: the seek slider's ARIA values (accessibility), accepted |

No frame was dropped or more than 50 ms late on either build. HLS's and DASH's first frames:
the same (HLS's comes in two modes on both builds).

To repeat a run: build main in a worktree (`--a main` does it), then
`node tools/bench-ab.mjs --a main --rounds 7`, `... --scenarios mp4,hls --rate 12 --ttfb 150`,
`... --scenarios tabs --rate 8` (about 30 minutes) and `... --scenarios tabs --rate 40 --rounds 5`. `BENCH_TRACE=1` writes each
media request's start and end to `logs/bench/trace-<time>.jsonl`, to see who had the line when.

