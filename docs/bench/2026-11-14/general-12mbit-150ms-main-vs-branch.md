# A/B benchmark 2026-11-14T22:10:29.580Z

A = main, B = branch. 7 rounds a build (ABBA), 1 warm-up round thrown away; media: 12 Mbit/s shared line, 150 ms to first byte.
Verdict: B against A, only where the medians differ by more than twice the larger MAD and the measure's floor, and a rank-sum (Mann-Whitney) test gives p < 0.05; "same" otherwise.

| Scenario | Measure | main (median) | branch (median) | B - A | Noise (MAD) | p | Runs | Verdict for branch |
|---|---|---:|---:|---:|---:|---:|---:|---|
| mp4 | player modules ready | 628 ms | 501 ms | -127 (-20.2 %) | 97.6 | 0.073 | 7/7 | same |
| mp4 | first frame | 1239 ms | 1134 ms | -105 (-8.4 %) | 116 | 0.128 | 7/7 | same |
| mp4 | playing | 1239 ms | 1134 ms | -105 (-8.4 %) | 116 | 0.128 | 7/7 | same |
| mp4 | seek to 80 s: seeked | 1572 ms | 1581 ms | +9 (+0.6 %) | 7 | 0.456 | 7/7 | same |
| mp4 | seek to 80 s: playing past it | 1856 ms | 1864 ms | +8 (+0.4 %) | 8.2 | 0.535 | 7/7 | same |
| mp4 | wake-ups while playing | 40.6 /s | 24.8 /s | -15.8 (-38.9 %) | 0.2 | <0.001 | 7/7 | better |
| mp4 | DOM changes while playing | 56.3 /s | 59.4 /s | +3.1 (+5.4 %) | 0.1 | <0.001 | 7/7 | worse |
| mp4 | frames > 50 ms apart while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| mp4 | dropped video frames while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| mp4 | wake-ups while paused | 41.3 /s | 9.5 /s | -31.8 (-77 %) | 0 | <0.001 | 7/7 | better |
| mp4 | seek preview at 120 s shown | 47.8 ms | 36.2 ms | -11.6 (-24.4 %) | 12.3 | 0.012 | 7/7 | same |
| mp4 | wake-ups while paused, after a seek preview | 41.2 /s | 9.4 /s | -31.8 (-77.2 %) | 0 | <0.001 | 7/7 | better |
| mp4 | wake-ups once the video has ended | 253 /s | 9.4 /s | -244 (-96.3 %) | 0.2 | <0.001 | 7/7 | better |
| hls | player modules ready | 686 ms | 587 ms | -98.9 (-14.4 %) | 24.9 | 0.026 | 7/7 | better |
| hls | first frame | 1904 ms | 1820 ms | -83.6 (-4.4 %) | 107 | 0.165 | 7/7 | same |
| hls | playing | 1906 ms | 1823 ms | -82.5 (-4.3 %) | 107 | 0.165 | 7/7 | same |
| hls | wake-ups while playing | 49.6 /s | 49.8 /s | +0.1 (+0.3 %) | 0.5 | 0.710 | 7/7 | same |
| hls | DOM changes while playing | 45.4 /s | 48.5 /s | +3.1 (+6.8 %) | 0.8 | 0.097 | 7/7 | same |
| hls | frames > 50 ms apart while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| hls | dropped video frames while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
