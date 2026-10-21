# Changelog

All notable changes to `@zakkster/lite-ohlc` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-10-21

First release of `@zakkster/lite-ohlc`. It is a REWRITE salvaged from the
never-published v1 source (`LiteTimeSeries.js`, package name
`@zakkster/lite-time-series`, which was never published to npm). From v1 only
these were kept: the ring indexing, the candle validation, the lower/upper-bound
binary searches and the bounds output layout. Everything else is new.

### BREAKING (vs the unpublished v1 source)

Nothing published breaks; this list is for anyone who has the v1 source.

- **Renamed:** package `@zakkster/lite-time-series` -> `@zakkster/lite-ohlc`,
  main file `LiteTimeSeries.js` -> `Ohlc.js`, class `LiteTimeSeries` ->
  `OhlcSeries`.
- **Constructor:** `new LiteTimeSeries(options)` / `createTimeSeries(options)`
  -> `new OhlcSeries(capacity, interval)`. Capacity must be an integer power of
  two in `[MIN_CAPACITY, MAX_CAPACITY]`; `DEFAULT_CAPACITY` is gone.
- **Removed (scope cut, ROADMAP D3):** `TimeSeriesViewport` / `createViewport`,
  hit-testing (`hitTestInto`, `hitTestFrom`, `HIT_STRIDE`), `TimeSeriesPool` /
  `createTimeSeriesPool` / `DEFAULT_POOL_MAX_SERIES`, and the Fenwick tree.
  The caller (and the planned lite-charts) owns viewport math, hit-testing and
  series pooling.
- **Dependencies:** v1 had `peerDependencies` on `@zakkster/lite-logn`,
  `@zakkster/lite-lru` and (optional) `@zakkster/lite-viewport`. v2 has none and
  zero runtime dependencies; the fused segment tree is built into `Ohlc.js`.
  `@zakkster/lite-logn` is a devDependency used only as a test oracle.
- **Method renames:** `append` / `appendFrom` -> `appendBar` / `appendBarFrom`;
  `updateLatest` / `updateLatestFrom` -> `setLive` / `setLiveFrom` (the live bar
  now lives outside the tree); `findLowerBoundLogicalIndex[From]` ->
  `lowerBound[From]`; `findUpperBoundLogicalIndex[From]` -> `upperBound[From]`;
  `getLatestTime()` / `getOldestTime()` -> getters `latestTime` / `oldestTime`.
- **Range arguments are logical bar indices, not times.** `computeBoundsInto`
  and `decimateInto` took `(minTime, maxTime, ...)` in v1; `boundsInto` and
  `decimateInto` now take `(i0, i1, ...)`. Convert times with
  `lowerBound` / `upperBound`.
- **Renamed / replaced:** `computeBounds[Into|From]` -> `boundsInto`;
  `decimate[Into|From]` -> `decimateInto(i0, i1, B, out, off)`.
- **Dropped v1 helpers:** `getCandleInto`, `getPhysicalIndex`,
  `getLogicalIndex`, `getLatest/OldestPhysicalIndex`,
  `findClosestLogicalIndex` / `findClosestPhysicalIndex`,
  `getVisibleRangeFrom` / `getVisibleLogicalRangeInto`, `forEachVisible`,
  `head`. Use `copyRangeInto` and `lowerBound` / `upperBound`.
- **Last-bar rule changed:** `appendBar[From]` with a time EQUAL to the last bar
  now replaces it (v1 threw `RangeError`: times had to be strictly increasing);
  `setLive[From]` with a LATER time now closes the live bar and pushes a new live
  bar (v1 `updateLatest[From]` re-timed and overwrote the latest bar in place),
  and on an empty series it creates a live bar (v1 appended a closed one). An
  earlier time still throws `RangeError`.
- **Volume is required:** `appendBar` / `setLive` take all six arguments (a
  missing `v` is a `TypeError`); v1 `append` / `updateLatest` defaulted
  `volume = 0`.
- **`version` wraps to 0 at 2^30;** v1 wrapped as an Int32 (`| 0`, negative past
  2^31 - 1). Compare versions for equality only.

### Added

- `OhlcSeries(capacity, interval)`: six Float64 columns in a power-of-two ring
  (oldest bars evicted when full), a fused 4-lane segment tree
  (min low, max high, max volume, sum volume) over the closed bars, and a live
  (forming) bar slot outside the tree.
- Writes: `appendBarFrom(buf, off)`, `setLiveFrom(buf, off)` and the scalar
  wrappers `appendBar(t, o, h, l, c, v)`, `setLive(t, o, h, l, c, v)`;
  `clear()`.
- Searches: `lowerBoundFrom` / `upperBoundFrom` (buffer form) and
  `lowerBound(x)` / `upperBound(x)` (scalar form).
- Queries: `boundsInto(i0, i1, out, off)` (stride 9), `copyRangeInto(i0, i1,
  out, off)` (stride 6), `decimateInto(i0, i1, B, out, off)` (stride 7, bucket
  index in each record).
- Getters: `version`, `interval`, `capacity`, `count`, `hasLive`, `oldestTime`,
  `latestTime`.
- Constants: `VERSION`, `CANDLE_STRIDE` (6), `BOUNDS_STRIDE` (9),
  `BUCKET_STRIDE` (7), `MIN_CAPACITY` (2), `MAX_CAPACITY` (4194304),
  `MAX_BUCKETS` (1048576).
- `Ohlc.d.ts`, `llms.txt`, `README.md`, `LICENSE`.
- `decimateInto` keeps two paths (ROADMAP D5): one fused tree query per bucket,
  and a linear scan when the visible count is below `B * log2(capacity)`.
  Times, prices and bucket indices are byte-identical across paths; volume is
  byte-identical for integer volumes whose sums stay below 2^53 (otherwise
  the scan sums sequentially, the tree pairwise). A given query always takes the same path.

### Fixed (behaviour vs v1)

- **Volume drift.** The `test/b0-drift.test.mjs` gate builds a long run of
  random-volume bars, then 256 zero-volume bars, and asserts that
  `boundsInto` over exactly those 256 bars returns a sum volume of exact `+0`.
  It is red on the frozen v1 source (v1 returned a small non-zero sum, e.g.
  8.756387978787507e-8 for N=4, PRE=1, where exact +0 is required) and green
  on v2, where every write rebuilds each node on the leaf's path to the root from its
  two children.
- **Decimation.** The `test/b0-decimate.test.mjs` gate compares `decimateInto`
  against a naive scan oracle (11 hand-picked vectors plus an 816-case sweep).
  It is red on the frozen v1 source (for example its first vector reports bucket
  index 3 where the oracle expects 0) and green on v2.

### Verified (this cycle, 2026-10-21, Node v26.8.2, macOS Darwin 27, run under
the suite quiet-lock; release `npm run verify` at 1-min load 5.0, the 30-run
zerobox loop at 1-min load 2.3-3.0; these gates are GC and allocation counts)

- `npm test`: 95 tests, 95 pass.
- `npm run test:zerobox`: 10 of 10 pass (gates at `<= 0.1 B/op`; the control
  shows a scalar `setLive` with fractional args boxes `>= 16 B/op`).
  30 consecutive runs: 0 failures.
- `npm run torture`: 1e6 `setLiveFrom` + 1e5 `appendBarFrom` + 1e5 `boundsInto`
  + 1e5 `decimateInto`: GC major 0, minor 0; 1000 create/drop cycles: tracker
  size 0, audit empty.
- No timing or benchmark data exists for this release.
