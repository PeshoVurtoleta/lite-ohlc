# @zakkster/lite-ohlc -- ROADMAP

Research: https://claude.ai/code/artifact/890fefa2-de01-4f30-8b7e-fbed87d07be2
(audit of the salvaged v1 + suite reuse + field practice, 2026-10-17)

## Settled (maintainer, 2026-10-21) -- binding for every agent

- D1 SETTLED: salvage as a REWRITE. Keep from v1 only: ring indexing, candle validation,
  lower/upper-bound binary searches, the bounds output layout. Everything else is rewritten.
- D2 SETTLED: name `@zakkster/lite-ohlc`, main file `Ohlc.js`, folder `LiteOhlc/`,
  main class `OhlcSeries`. (`@zakkster/lite-time-series` was never published.)
- D3 SETTLED: scope cut. v2 drops `TimeSeriesViewport`, hit-testing and `TimeSeriesPool`
  (lite-charts and the caller own those) and the Fenwick tree.
- D4 SETTLED: v2 owns its fused 4-lane tree (min low, max high, max vol, sum vol; sums rebuilt
  from children) inside `Ohlc.js`. Zero runtime dependencies. lite-logn `SegmentTree` is a
  devDependency used ONLY as a test oracle; no `queryInto` work in lite-logn.
- D5 SETTLED (maintainer, 2026-10-21): `decimateInto` keeps two paths (fused-tree per bucket, and
  a linear scan when visible < B x log2 cap). Times, prices and bucket indices are byte-identical
  across paths; volume is byte-identical for integer volumes whose sums stay below 2^53
  (otherwise -- fractional volumes, or integer sums at or past 2^53 -- the scan sums
  sequentially, the tree pairwise). A given query always takes the same path. Documented, not
  hidden. (Bound amended by the maintainer 2026-10-21 per PLAN-v2 addendum 9: integer volumes
  [2^53, 0, 1, 1] give tree 9007199254740994 vs scan 9007199254740992.)

## v2.0 target (from the research doc)

- Six Float64 columns in a power-of-two ring; live-bar slot outside the tree (O(1) ticks).
- `appendBar` O(log n) (one fused walk); `setLive` O(1); `boundsInto` O(log n);
  `decimateInto` O(B log n) with bucket indices in the output (linear scan when
  visible < B x log2 n); `lowerBound` / `upperBound` O(log n).
- Last-bar rule (lightweight-charts): equal time replaces, later appends, earlier throws.
  No mid-history edits.
- Duck-typed source contract for lite-charts: `version`, `interval`, `count`, `oldestTime`,
  `latestTime`, `lowerBound`, `upperBound`, `boundsInto`, `decimateInto`, `copyRangeInto`.

## Bursts (estimate, not a measurement)

1. Planner pass + B0 vectors (drift gate that fails on frozen v1).
2. Coder batch 1 + review: ring, validation, live slot, searches, fused tree, boundsInto.
3. Coder batch 2 + review: decimateInto.
4. QA: boundary suites + real lite-leak / lite-gc-profiler torture.
5. Statistical timing gate (quiet host).
6. Docs: README (LiteSepforge spine), llms.txt, CHANGELOG, Ohlc.d.ts, LICENSE.
7. Release.
Later (other packages): lite-charts source contract (~5-6 bursts); indicators layer on
lite-o1 WindowFold; robust autoscale via SlidingDDSketch / DDSketch.

## 1.0.1 (patch; output byte-identical to 1.0.0) -- from the 2026-10-21 external review

Accepted by the orchestrator after checking against `Ohlc.js` (the review's line numbers were
~100 off the shipped file); scope approved by the maintainer 2026-10-21.
- P1: `_decimateScan` fast path for n <= B (Ohlc.js:566). Today the bucket loop runs B times
  even when n < B, so n = 1, B = MAX_BUCKETS costs 2^20 iterations. When n <= B each non-empty
  bucket holds exactly one bar, bar m (logical i0 + m) in bucket k = floor(m * B / n): copy the
  bar, write k, return n. Scan path becomes O(n). Pre-check (orchestrator, run against the
  live 1.0.0 file; .handoff/fastpath-check.mjs, gitignored): 1600 random cases (capacity
  2..1024, wrapped ring, live bar, fractional volumes) gave the fast path's expected output
  byte-identical to 1.0.0 `decimateInto`; floor(m * B / n) matches BigInt at
  n = 2^22, B = 2^20. Proof required: parity vs `git show v1.0.0:Ohlc.js` (sweep incl.
  n = 1 / B = MAX_BUCKETS, n = B, S_H = 1); zerobox for the new branch. A "fails on the old
  code" gate for a work-count change is STATISTICAL tier (n = 1, B = 2^20 vs B = 1, interleaved,
  quiet host) or none -- planner decides; docs must not claim a measured speedup without it.
  Docs: complexity "O(n + B) on the scan path" -> "O(n)" in README / llms.txt / d.ts / CHANGELOG.
- P2: `copyRangeInto` loop starts at `i0 | 0` (Ohlc.js:528), matching decimateInto's `| 0`, so a
  caller's -0 never seeds a double induction variable. No output change (indices are never
  written there). The `end = i1 | 0` part of the review's suggestion is not needed.
- Ride-along (doc-only): llms.txt ~:125 orphan "use the" + :106-120 wrap; README ~:329 table
  padding; Ohlc.d.ts appendBar / setLive comment break alignment.
