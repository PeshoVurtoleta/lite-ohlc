# lite-ohlc bench -- REPORTED tier

Verdict: MET (exit 0)
Headline-eligible hit: bounds n=100000 w=1000 ratio median 44.2x
Headline-eligible hit: bounds n=100000 w=100000 ratio median 5873x
Headline-eligible hit: bounds n=1000000 w=1000 ratio median 57.6x
Headline-eligible hit: bounds n=1000000 w=100000 ratio median 2519x

## Provenance

- date: 2026-10-21T06:48:17.482Z
- cpu: Apple M4 Pro, ncpu 12
- node: v26.8.2
- runs: 1 run x 21 rounds (ABBA blocks of ~20 ms per side, 3 warmup blocks, gc() before every block)
- load1 samples: start=2.24, setLive n=1e4 best=1.97, setLive n=1e4 idiomatic=1.97, bounds n=1e4 w=1e3 best=1.89, decimate n=1e4 w=1e3 B=800 best=1.89, decimate n=1e4 w=1e3 B=800 idiomatic=1.89, decimate n=1e4 w=1e3 B=1920 best=1.98, decimate n=1e4 w=1e3 B=1920 idiomatic=1.98, setLive n=1e5 best=2.06, setLive n=1e5 idiomatic=2.06, control setLive 1e5 lite vs lite=2.13, bounds n=1e5 w=1e3 best=2.13, decimate n=1e5 w=1e3 B=800 best=2.20, decimate n=1e5 w=1e3 B=800 idiomatic=2.11, decimate n=1e5 w=1e3 B=1920 best=2.11, decimate n=1e5 w=1e3 B=1920 idiomatic=2.02, bounds n=1e5 w=1e5 best=2.02, decimate n=1e5 w=1e5 B=800 best=1.94, decimate n=1e5 w=1e5 B=800 idiomatic=1.94, decimate n=1e5 w=1e5 B=1920 best=1.94, decimate n=1e5 w=1e5 B=1920 idiomatic=1.87, control decimate (1e5, 1e3, 800) scan lite vs lite=1.87, setLive n=1e6 best=1.80, setLive n=1e6 idiomatic=1.99, bounds n=1e6 w=1e3 best=2.31, decimate n=1e6 w=1e3 B=800 best=2.49, decimate n=1e6 w=1e3 B=800 idiomatic=2.55, decimate n=1e6 w=1e3 B=1920 best=2.61, decimate n=1e6 w=1e3 B=1920 idiomatic=2.59, bounds n=1e6 w=1e5 best=2.58, decimate n=1e6 w=1e5 B=800 best=2.65, decimate n=1e6 w=1e5 B=800 idiomatic=2.86, decimate n=1e6 w=1e5 B=1920 best=2.73, decimate n=1e6 w=1e5 B=1920 idiomatic=2.92, control bounds (1e6, 1e5) lite vs lite=3.00, control decimate (1e6, 1e5, 1920) tree lite vs lite=3.07, positive baseBounds n=1e6 w=1e5 vs w=1e3=3.22, end=3.20
- max load1: 3.22 (bar 4)
- other node processes >= 10% CPU: none (excluded own pid + ancestors: 97381, 97380, 845, 844, 628)
- GC over timed lite blocks: major 0, minor 0 (A3 requires 0 / 0: PASS)
- GC over timed baseline blocks (reported): major 0, minor 462
- cross-check: 5120 bounds + 10240 decimate + 10240 idiomatic starts + 6 setLive sides, bitwise PASS; probe exit 0

## Rows (ratio = baseline ns/op / lite ns/op, per round)

| op | n | w | B | path | baseline | lite ns/op | base ns/op | ratio median [min, max] | IQR | eligible | clears |
|---|---|---|---|---|---|---|---|---|---|---|---|
| setLive | 1e4 | - | - | - | best | 12.2 | 4.32 | 0.35 [0.35, 0.36] | 0.35-0.36 | no | no |
| setLive | 1e4 | - | - | - | idiomatic | 12.2 | 181 | 14.7 [14.4, 15.2] | 14.6-14.9 | no | yes |
| bounds | 1e4 | 1e3 | - | tree | best | 40.1 | 1677 | 42.0 [40.4, 42.8] | 41.5-42.3 | no | yes |
| decimate | 1e4 | 1e3 | 800 | scan | best | 4192 | 3718 | 0.88 [0.81, 0.98] | 0.85-0.92 | no | no |
| decimate | 1e4 | 1e3 | 800 | scan | idiomatic | 4314 | 13002 | 3.04 [2.85, 3.60] | 2.97-3.19 | no | no |
| decimate | 1e4 | 1e3 | 1920 | sparse | best | 2584 | 4620 | 1.79 [1.75, 1.83] | 1.78-1.80 | no | no |
| decimate | 1e4 | 1e3 | 1920 | sparse | idiomatic | 2590 | 18013 | 6.96 [6.72, 7.64] | 6.94-6.99 | no | no |
| setLive | 1e5 | - | - | - | best | 12.5 | 4.35 | 0.35 [0.34, 0.36] | 0.35-0.35 | no | no |
| setLive | 1e5 | - | - | - | idiomatic | 12.5 | 1277 | 102 [101, 106] | 101-103 | no | yes |
| bounds | 1e5 | 1e3 | - | tree | best | 44.4 | 1965 | 44.2 [42.4, 46.2] | 43.5-44.9 | yes | yes |
| decimate | 1e5 | 1e3 | 800 | scan | best | 5629 | 5300 | 0.94 [0.88, 0.99] | 0.93-0.95 | yes | no |
| decimate | 1e5 | 1e3 | 800 | scan | idiomatic | 5639 | 13754 | 2.45 [2.37, 2.60] | 2.42-2.47 | no | no |
| decimate | 1e5 | 1e3 | 1920 | sparse | best | 2644 | 5051 | 1.91 [1.84, 1.95] | 1.89-1.92 | yes | no |
| decimate | 1e5 | 1e3 | 1920 | sparse | idiomatic | 2647 | 18705 | 7.07 [6.76, 7.33] | 6.98-7.18 | no | no |
| bounds | 1e5 | 1e5 | - | tree | best | 29.2 | 171549 | 5873 [5541, 5987] | 5788-5902 | yes | yes |
| decimate | 1e5 | 1e5 | 800 | tree | best | 24449 | 216599 | 8.93 [8.54, 9.36] | 8.65-9.18 | yes | no |
| decimate | 1e5 | 1e5 | 800 | tree | idiomatic | 24571 | 650772 | 26.5 [25.8, 27.4] | 26.3-26.8 | no | yes |
| decimate | 1e5 | 1e5 | 1920 | tree | best | 47018 | 248230 | 5.26 [4.89, 5.79] | 5.15-5.35 | yes | no |
| decimate | 1e5 | 1e5 | 1920 | tree | idiomatic | 46777 | 604185 | 13.0 [12.5, 13.3] | 12.8-13.1 | no | yes |
| setLive | 1e6 | - | - | - | best | 13.2 | 4.45 | 0.34 [0.33, 0.36] | 0.34-0.34 | no | no |
| setLive | 1e6 | - | - | - | idiomatic | 12.8 | 11083 | 867 [844, 883] | 856-873 | no | yes |
| bounds | 1e6 | 1e3 | - | tree | best | 48.2 | 2810 | 57.6 [48.9, 60.5] | 56.1-59.3 | yes | yes |
| decimate | 1e6 | 1e3 | 800 | scan | best | 6087 | 5842 | 0.96 [0.91, 1.02] | 0.94-0.97 | yes | no |
| decimate | 1e6 | 1e3 | 800 | scan | idiomatic | 5967 | 14029 | 2.35 [2.25, 2.60] | 2.34-2.37 | no | no |
| decimate | 1e6 | 1e3 | 1920 | sparse | best | 2928 | 5320 | 1.81 [1.66, 1.85] | 1.78-1.83 | yes | no |
| decimate | 1e6 | 1e3 | 1920 | sparse | idiomatic | 2993 | 19385 | 6.50 [5.89, 6.97] | 6.41-6.64 | no | no |
| bounds | 1e6 | 1e5 | - | tree | best | 85.8 | 215945 | 2519 [1999, 2817] | 2463-2650 | yes | yes |
| decimate | 1e6 | 1e5 | 800 | tree | best | 131871 | 309627 | 2.36 [2.31, 2.43] | 2.34-2.39 | yes | no |
| decimate | 1e6 | 1e5 | 800 | tree | idiomatic | 132054 | 733199 | 5.59 [5.31, 5.68] | 5.56-5.62 | no | no |
| decimate | 1e6 | 1e5 | 1920 | tree | best | 256243 | 371338 | 1.47 [1.44, 1.51] | 1.46-1.48 | yes | no |
| decimate | 1e6 | 1e5 | 1920 | tree | idiomatic | 251272 | 650927 | 2.61 [2.52, 2.67] | 2.57-2.62 | no | no |

## Controls (lite vs lite: median must be in [0.8, 1.25] and must not clear; positive must clear)

| control | A ns/op | B ns/op | ratio median [min, max] | IQR | clears |
|---|---|---|---|---|---|
| setLive 1e5 lite vs lite | 12.5 | 12.5 | 0.99 [0.98, 1.02] | 0.99-0.99 | no |
| decimate (1e5, 1e3, 800) scan lite vs lite | 5595 | 5842 | 1.04 [1.02, 1.06] | 1.03-1.04 | no |
| bounds (1e6, 1e5) lite vs lite | 78.2 | 80.8 | 1.01 [0.90, 1.09] | 0.98-1.06 | no |
| decimate (1e6, 1e5, 1920) tree lite vs lite | 256026 | 254587 | 1.00 [0.93, 1.02] | 0.99-1.02 | no |
| baseBounds n=1e6 w=1e5 vs w=1e3 | 2830 | 216958 | 76.6 [74.8, 79.1] | 76.1-77.5 | yes |
