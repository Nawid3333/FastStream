# A/B benchmark 2026-11-14T21:31:25.633Z

A = main, B = head. 3 rounds a build (ABBA), 1 warm-up round thrown away; media: 8 Mbit/s shared line, 0 ms to first byte.
Verdict: B against A, only where the medians differ by more than twice the larger MAD and the measure's floor, and a rank-sum (Mann-Whitney) test gives p < 0.05; "same" otherwise.

| Scenario | Measure | main (median) | head (median) | B - A | Noise (MAD) | p | Runs | Verdict for head |
|---|---|---:|---:|---:|---:|---:|---:|---|
| tabs | in front of 3 background players: player modules ready | 621 ms | 602 ms | -19.1 (-3.1 %) | 4.4 | 0.400 | 3/3 | same |
| tabs | ... first frame, after its first request for the video | 1041 ms | 1085 ms | +43.9 (+4.2 %) | 2.9 | 0.100 | 3/3 | same |
| tabs | ... seconds of video ahead, 10 s in | 19.1 s | 19.1 s | 0 (0 %) | 0 | 1.000 | 3/3 | same |
| tabs | ... has its whole video | 64047 ms | 63557 ms | -490 (-0.8 %) | 13.7 | 0.700 | 3/3 | same |
| tabs | ... all four players have theirs | 109928 ms | 110032 ms | +104 (+0.1 %) | 36.5 | 0.100 | 3/3 | same |
