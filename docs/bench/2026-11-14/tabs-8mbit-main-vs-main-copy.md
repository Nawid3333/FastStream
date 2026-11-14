# A/B benchmark 2026-11-14T21:15:14.270Z

A = main, B = maincopy. 3 rounds a build (ABBA), 1 warm-up round thrown away; media: 8 Mbit/s shared line, 0 ms to first byte.
Verdict: B against A, only where the medians differ by more than twice the larger MAD and the measure's floor, and a rank-sum (Mann-Whitney) test gives p < 0.05; "same" otherwise.

| Scenario | Measure | main (median) | maincopy (median) | B - A | Noise (MAD) | p | Runs | Verdict for maincopy |
|---|---|---:|---:|---:|---:|---:|---:|---|
| tabs | in front of 3 background players: player modules ready | 573 ms | 609 ms | +36 (+6.3 %) | 115 | 1.000 | 3/3 | same |
| tabs | ... first frame, after its first request for the video | 1098 ms | 1040 ms | -58 (-5.3 %) | 72.7 | 0.700 | 3/3 | same |
| tabs | ... seconds of video ahead, 10 s in | 19.1 s | 19.2 s | +0.1 (+0.4 %) | 0.1 | 1.000 | 3/3 | same |
| tabs | ... has its whole video | 9044 ms | 9034 ms | -9.5 (-0.1 %) | 3.5 | 0.400 | 3/3 | same |
| tabs | ... all four players have theirs | 41820 ms | 41871 ms | +50.4 (+0.1 %) | 1038 | 1.000 | 3/3 | same |
