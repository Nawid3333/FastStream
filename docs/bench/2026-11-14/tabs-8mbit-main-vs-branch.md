# A/B benchmark 2026-11-14T21:07:49.275Z

A = main, B = branch. 7 rounds a build (ABBA), 1 warm-up round thrown away; media: 8 Mbit/s shared line, 0 ms to first byte.
Verdict: B against A, only where the medians differ by more than twice the larger MAD and the measure's floor, and a rank-sum (Mann-Whitney) test gives p < 0.05; "same" otherwise.

| Scenario | Measure | main (median) | branch (median) | B - A | Noise (MAD) | p | Runs | Verdict for branch |
|---|---|---:|---:|---:|---:|---:|---:|---|
| tabs | in front of 3 background players: player modules ready | 253 ms | 592 ms | +339 (+134 %) | 12.4 | <0.001 | 7/7 | worse |
| tabs | ... first frame, after its first request for the video | 1168 ms | 1076 ms | -91.6 (-7.8 %) | 21.8 | <0.001 | 7/7 | better |
| tabs | ... seconds of video ahead, 10 s in | 18.8 s | 19.1 s | +0.3 (+1.5 %) | 0 | 0.013 | 7/7 | same |
| tabs | ... has its whole video | 66050 ms | 29556 ms | -36494 (-55.3 %) | 17.3 | <0.001 | 7/7 | better |
| tabs | ... all four players have theirs | 109082 ms | 92286 ms | -16796 (-15.4 %) | 51.5 | <0.001 | 7/7 | better |
