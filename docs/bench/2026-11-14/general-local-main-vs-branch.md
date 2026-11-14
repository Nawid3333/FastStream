# A/B benchmark 2026-11-14T21:59:37.991Z

A = main, B = branch. 7 rounds a build (ABBA), 1 warm-up round thrown away; media: local, no limit.
Verdict: B against A, only where the medians differ by more than twice the larger MAD and the measure's floor, and a rank-sum (Mann-Whitney) test gives p < 0.05; "same" otherwise.

| Scenario | Measure | main (median) | branch (median) | B - A | Noise (MAD) | p | Runs | Verdict for branch |
|---|---|---:|---:|---:|---:|---:|---:|---|
| mp4 | player modules ready | 673 ms | 607 ms | -65.3 (-9.7 %) | 18.4 | 0.002 | 7/7 | better |
| mp4 | first frame | 997 ms | 915 ms | -82 (-8.2 %) | 20 | 0.011 | 7/7 | better |
| mp4 | playing | 998 ms | 916 ms | -82 (-8.2 %) | 20 | 0.011 | 7/7 | better |
| mp4 | seek to 80 s: seeked | 70.4 ms | 73.6 ms | +3.2 (+4.5 %) | 1.1 | 0.073 | 7/7 | same |
| mp4 | seek to 80 s: playing past it | 353 ms | 357 ms | +3.3 (+0.9 %) | 0.7 | 0.073 | 7/7 | same |
| mp4 | wake-ups while playing | 40.9 /s | 25 /s | -15.9 (-39 %) | 0 | <0.001 | 7/7 | better |
| mp4 | DOM changes while playing | 28.1 /s | 31.1 /s | +3 (+10.6 %) | 0.1 | <0.001 | 7/7 | worse |
| mp4 | frames > 50 ms apart while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| mp4 | dropped video frames while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| mp4 | wake-ups while paused | 41.3 /s | 9.5 /s | -31.8 (-77 %) | 0 | <0.001 | 7/7 | better |
| mp4 | seek preview at 120 s shown | 68.2 ms | 31.4 ms | -36.8 (-53.9 %) | 10 | <0.001 | 7/7 | better |
| mp4 | wake-ups while paused, after a seek preview | 41.3 /s | 9.4 /s | -31.9 (-77.2 %) | 0 | <0.001 | 7/7 | better |
| mp4 | wake-ups once the video has ended | 253 /s | 9.4 /s | -244 (-96.3 %) | 0.3 | <0.001 | 7/7 | better |
| hls | player modules ready | 705 ms | 608 ms | -97.5 (-13.8 %) | 18.7 | <0.001 | 7/7 | better |
| hls | first frame | 1446 ms | 1348 ms | -98 (-6.8 %) | 70.2 | 0.017 | 7/7 | same |
| hls | playing | 1447 ms | 1349 ms | -98.1 (-6.8 %) | 68.6 | 0.017 | 7/7 | same |
| hls | wake-ups while playing | 45.8 /s | 45.5 /s | -0.3 (-0.6 %) | 0.1 | 0.004 | 7/7 | same |
| hls | DOM changes while playing | 49.3 /s | 51.5 /s | +2.2 (+4.4 %) | 1 | 0.456 | 7/7 | same |
| hls | frames > 50 ms apart while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| hls | dropped video frames while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| dash | player modules ready | 640 ms | 593 ms | -46.9 (-7.3 %) | 81.2 | 0.318 | 7/7 | same |
| dash | first frame | 1700 ms | 1710 ms | +9.8 (+0.6 %) | 132 | 1.000 | 7/7 | same |
| dash | playing | 1701 ms | 1710 ms | +9 (+0.5 %) | 131 | 1.000 | 7/7 | same |
| dash | wake-ups while playing | 64.1 /s | 64.4 /s | +0.2 (+0.4 %) | 0.4 | 0.805 | 7/7 | same |
| dash | DOM changes while playing | 37.5 /s | 41.2 /s | +3.7 (+9.9 %) | 1.6 | 0.026 | 7/7 | worse |
| dash | frames > 50 ms apart while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| dash | dropped video frames while playing | 0  | 0  | 0 (0 %) | 0 | 1.000 | 7/7 | same |
| idle | player modules ready | 736 ms | 581 ms | -155 (-21.1 %) | 46.7 | 0.011 | 7/7 | better |
| idle | wake-ups, idle player (no video) | 1 /s | 1.4 /s | +0.4 (+40 %) | 0 | <0.001 | 7/7 | same |
