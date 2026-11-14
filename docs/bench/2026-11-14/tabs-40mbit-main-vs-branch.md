# A/B benchmark 2026-11-14T21:42:49.077Z

A = main, B = branch. 5 rounds a build (ABBA), 1 warm-up round thrown away; media: 40 Mbit/s shared line, 0 ms to first byte.
Verdict: B against A, only where the medians differ by more than twice the larger MAD and the measure's floor, and a rank-sum (Mann-Whitney) test gives p < 0.05; "same" otherwise.

| Scenario | Measure | main (median) | branch (median) | B - A | Noise (MAD) | p | Runs | Verdict for branch |
|---|---|---:|---:|---:|---:|---:|---:|---|
| tabs | in front of 3 background players: player modules ready | 571 ms | 276 ms | -295 (-51.7 %) | 58.5 | 0.008 | 5/5 | same |
| tabs | ... first frame, after its first request for the video | 423 ms | 415 ms | -7.7 (-1.8 %) | 11.9 | 1.000 | 5/5 | same |
| tabs | ... seconds of video ahead, 10 s in | 49.1 s | 31.6 s | -17.5 (-35.7 %) | 16.8 | 0.222 | 5/5 | same |
| tabs | ... has its whole video | 6533 ms | 6536 ms | +2.7 (+0 %) | 494 | 0.841 | 5/5 | same |
| tabs | ... all four players have theirs | 18281 ms | 18174 ms | -108 (-0.6 %) | 192 | 1.000 | 5/5 | same |
