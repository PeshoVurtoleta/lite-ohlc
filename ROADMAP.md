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
