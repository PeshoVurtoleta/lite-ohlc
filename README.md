# @zakkster/lite-ohlc

> Zero-GC OHLCV bar store for live charts. A power-of-two ring of six Float64 columns, a fused segment tree for O(log n) visible-window bounds, an O(1) live (forming) bar, and bucketed candle decimation. Zero runtime dependencies. Built for tick-rate updates and 60fps redraws.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-ohlc.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-ohlc)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-ohlc?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-ohlc)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-ohlc?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-ohlc)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-ohlc?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-ohlc)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The candle store the rest of the ecosystem was missing

`lite-ohlc` is the data end of a live chart. A feed produces ticks; a chart needs, every frame, the visible window's price range for autoscale and a handful of candles per pixel column to draw. Nothing small turned a stream of bars into exactly those two answers without allocating. `OhlcSeries` is that piece: write the forming bar in O(1), close it in O(log n), then ask for bounds and decimated candles into buffers you own.

```bash
npm install @zakkster/lite-ohlc
```

```js
import { OhlcSeries, CANDLE_STRIDE, BOUNDS_STRIDE } from '@zakkster/lite-ohlc';

const MIN = 60000;
const series = new OhlcSeries(1024, MIN);       // capacity (power of two), bar interval
const bar = new Float64Array(CANDLE_STRIDE);    // [t, o, h, l, c, v] scratch, owned by you

function fill(t, o, h, l, c, v) {
  bar[0] = t; bar[1] = o; bar[2] = h; bar[3] = l; bar[4] = c; bar[5] = v;
}

fill(0 * MIN, 100, 105, 99, 104, 10);  series.appendBarFrom(bar);   // closed bar
fill(1 * MIN, 104, 108, 103, 107, 12); series.appendBarFrom(bar);   // closed bar
fill(2 * MIN, 107, 107, 107, 107, 1);  series.setLiveFrom(bar);     // forming bar
fill(2 * MIN, 107, 110, 106, 109, 5);  series.setLiveFrom(bar);     // tick: same time replaces

console.log(series.count, series.hasLive);      // 3 true

const out = new Float64Array(BOUNDS_STRIDE);
series.boundsInto(0, series.count - 1, out);
// [minLow, maxHigh, maxVol, open(i0), close(i1), sumVol, i0, i1, n]
console.log(Array.from(out));                   // [99, 110, 12, 100, 109, 27, 0, 2, 3]
```

Hot methods take a caller-owned `Float64Array` (`xxxFrom(buf, off)`) or write into one (`xxxInto(..., out, off)`), so the steady state allocates nothing.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The core surface](#the-core-surface)
- [API reference](#api-reference)
  - [Constructor and getters](#constructor-and-getters)
  - [Writes](#writes)
  - [Searches](#searches)
  - [Range queries](#range-queries)
  - [Constants](#constants)
  - [Throws](#throws)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

A live candlestick chart has three problems that no small library solves at once:

1. **Ticks at feed rate.** The forming bar changes on every trade. Rewriting a segment tree per tick is wasteful, so the live bar sits outside the tree: `setLiveFrom` is a column write, nothing more for the new bar. The tree is touched once, when the bar closes.
2. **Autoscale every frame.** The y-axis needs min low, max high (and often max/sum volume) over the visible window. `boundsInto` folds all four lanes in one iterative tree query: O(log n) by construction, not a scan.
3. **More bars than pixels.** Ten thousand visible bars on a 1000 px canvas must become about 1000 candles. `decimateInto` produces first-open, max-high, min-low, last-close and summed volume per bucket, with the bucket index in each record so a renderer can place it.

All of it with no allocation after construction on the `*From` / `*Into` paths, so frame pacing never sees a GC pause from the data layer.

---

## What you get

- **`OhlcSeries(capacity, interval)`** -- the store. Six Float64 columns (`t, o, h, l, c, v`) in a power-of-two ring; the oldest bar is evicted when full.
- **Writes** -- `appendBarFrom` / `appendBar` (close a bar), `setLiveFrom` / `setLive` (forming bar), `clear`.
- **Searches** -- `lowerBoundFrom` / `upperBoundFrom` and the scalar `lowerBound` / `upperBound`: time -> logical index.
- **Range queries** -- `boundsInto` (stride 9), `copyRangeInto` (stride 6), `decimateInto` (stride 7).
- **Getters** -- `version`, `interval`, `capacity`, `count`, `hasLive`, `oldestTime`, `latestTime`.
- **Constants** -- `VERSION`, `CANDLE_STRIDE`, `BOUNDS_STRIDE`, `BUCKET_STRIDE`, `MIN_CAPACITY`, `MAX_CAPACITY`, `MAX_BUCKETS`.
- **Fail-closed validation** -- bad candles, out-of-order times and short buffers throw before any state is written.

Full types ship in [`Ohlc.d.ts`](./Ohlc.d.ts).

---

## The core surface

<details>
<summary>Ring, fused 4-lane tree, live slot, and the last-bar rule.</summary>

### Logical indices

Bars are addressed by **logical index**: `0` is the oldest retained bar, `count - 1` the newest. `count` includes the live bar when `hasLive` is true. The ring maps logical index `i` to physical slot `(base + i) & (capacity - 1)`; when the ring is full, an append advances `base` and the oldest bar is gone.

### The fused tree

A segment tree over the physical slots stores four lanes per node: **min low, max high, max volume, sum volume**. One walk from a changed leaf to the root rebuilds all four lanes, and one iterative query folds all four over a range. Every write rebuilds each node on the leaf's path to the root from its two children. Memory is `6 x 8 B` of columns plus `8 x 8 B` of tree per capacity slot, i.e. 112 B per bar of capacity (a computed figure, not a measurement).

### The live slot

The tree covers the **closed** bars only. The live (forming) bar is stored in its column slot, outside the tree, and is folded into `boundsInto` / `decimateInto` results in O(1) when a query includes it. Writing it never touches the tree.

### The last-bar rule

Both `appendBarFrom` and `setLiveFrom` compare the new time `t` with the time of the last bar (live or closed):

| New time vs last bar | `appendBarFrom` (close)                              | `setLiveFrom` (forming)                                |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| equal                | replaces the last bar, which ends up CLOSED          | overwrites the last bar; a closed last bar REOPENS as live |
| later                | closes any live bar as-is, then pushes the new bar   | closes any live bar as-is, then pushes the new bar as live |
| earlier              | throws `RangeError`, nothing changes                 | throws `RangeError`, nothing changes                   |

There are no mid-history edits: the only bar you can change is the last one. A feed that streams ticks calls `setLiveFrom` for each tick with the bar's open time, then `appendBarFrom` once with the final values.

</details>

---

## API reference

All `off` parameters default to `0`. Writes return the series (chainable). "Logical index" is defined above.

### Constructor and getters

```ts
new OhlcSeries(capacity: number, interval: number)
```

- **`capacity`** -- integer power of two in `[MIN_CAPACITY, MAX_CAPACITY]`.
- **`interval`** -- bar interval, metadata only (finite, `> 0`). The store never uses it to compute anything; it is exposed so a renderer can read it.

| Getter       | Type    | Meaning                                                              |
| ------------ | ------- | -------------------------------------------------------------------- |
| `version`    | integer | Bumped on every successful write or `clear`; wraps at 2^30.          |
| `interval`   | number  | The constructor interval.                                            |
| `capacity`   | integer | The constructor capacity.                                            |
| `count`      | integer | Closed bars plus the live bar.                                       |
| `hasLive`    | boolean | `true` when the newest bar is the live bar.                          |
| `oldestTime` | number  | Time of logical bar `0`; `NaN` when empty.                           |
| `latestTime` | number  | Time of logical bar `count - 1`; `NaN` when empty.                   |

### Writes

```ts
appendBarFrom(buf: Float64Array, off?: number): this   // buf[off..off+5] = [t, o, h, l, c, v]
setLiveFrom(buf: Float64Array, off?: number): this     // same layout
appendBar(t, o, h, l, c, v): this                      // scalar wrapper, all six required
setLive(t, o, h, l, c, v): this                        // scalar wrapper, all six required
clear(): this                                          // forget every bar
```

A candle is valid when every value is finite, `l <= o <= h`, `l <= c <= h`, and `0 <= v <= Number.MAX_VALUE / (4 * capacity)`. A throw happens before any write, so a rejected call leaves the series unchanged. Cost: `appendBarFrom` is O(log n) (one fused walk; closing a live bar first adds one more); `setLiveFrom` is O(1) for the new bar (a previous live bar is closed into the tree first when the time advances); `clear` is O(1).

### Searches

```ts
lowerBoundFrom(buf: Float64Array, off?: number): number  // first logical index with time >= buf[off], else -1
upperBoundFrom(buf: Float64Array, off?: number): number  // LAST logical index with time <= buf[off], else -1
lowerBound(x: number): number                            // scalar form
upperBound(x: number): number                            // scalar form
```

Both return `-1` for an empty series, a non-finite query, or no match. A bad **value** returns `-1` and never throws; a wrong container **type** (or an out-of-range `off`) throws. O(log n).

A window `[tMin, tMax]` maps to the inclusive index range `[lowerBound(tMin), upperBound(tMax)]`. If either is `-1`, or `lo > hi`, the window holds no bars.

### Range queries

All ranges are inclusive logical indices `[i0, i1]`. `n = i1 - i0 + 1`.

```ts
boundsInto(i0, i1, out: Float64Array, off?): number     // returns n, or 0 for an invalid range
copyRangeInto(i0, i1, out: Float64Array, off?): number  // returns n, or 0 for an invalid range
decimateInto(i0, i1, B, out: Float64Array, off?): number // returns buckets written
```

**`boundsInto`** needs `off + 9 <= out.length` and writes (`BOUNDS_STRIDE = 9`):

| Slot | Value                                |
| ---- | ------------------------------------ |
| 0    | min low                              |
| 1    | max high                             |
| 2    | max volume                           |
| 3    | open of bar `i0`                     |
| 4    | close of bar `i1`                    |
| 5    | sum volume                           |
| 6    | `i0`                                 |
| 7    | `i1`                                 |
| 8    | `n`                                  |

An invalid range (non-integer, `i0 < 0`, `i0 > i1`, or `i1 >= count`) writes `[NaN, NaN, NaN, NaN, NaN, 0, -1, -1, 0]` and returns `0`. O(log n).

**`copyRangeInto`** writes `n` records of `[t, o, h, l, c, v]` (`CANDLE_STRIDE = 6`), oldest first, starting at `off`, and returns `n`. An invalid range returns `0` and writes nothing. A valid range whose `6 * n` values do not fit (`off + 6 * n > out.length`) throws `RangeError` with no write.

**`decimateInto`** splits the `n` bars into at most `B` buckets. Bucket `k` covers `[i0 + ceil(k*n/B), i0 + ceil((k+1)*n/B) - 1]`. Each non-empty bucket, in ascending `k`, writes (`BUCKET_STRIDE = 7`):

| Slot | Value                              |
| ---- | ---------------------------------- |
| 0    | time of the bucket's first bar     |
| 1    | open of the first bar              |
| 2    | max high                           |
| 3    | min low                            |
| 4    | close of the last bar              |
| 5    | sum volume                         |
| 6    | bucket index `k`                   |

It returns the number written, `min(n, B)`; empty buckets (only when `n < B`) write nothing, and slots past `off + 7 * written` are untouched. `B` must be an integer in `[1, MAX_BUCKETS]` and `off + 7 * B <= out.length`, otherwise it throws `RangeError` -- even when the range is invalid. An invalid range returns `0` and writes nothing. O(n) on the scan path, O(B log capacity) on the tree path, by construction.

### Constants

| Constant        | Value     | Meaning                                              |
| --------------- | --------- | ---------------------------------------------------- |
| `VERSION`       | `'1.0.2'` | Package version string.                              |
| `CANDLE_STRIDE` | `6`       | `[t, o, h, l, c, v]`.                                |
| `BOUNDS_STRIDE` | `9`       | `boundsInto` record.                                 |
| `BUCKET_STRIDE` | `7`       | `decimateInto` record.                               |
| `MIN_CAPACITY`  | `2`       | Smallest ring.                                       |
| `MAX_CAPACITY`  | `4194304` | 2^22, largest ring.                                  |
| `MAX_BUCKETS`   | `1048576` | 2^20, largest `B` for `decimateInto`.                |

### Throws

| Error        | When                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| `TypeError`  | capacity or interval is not a number; `buf` / `out` is not a `Float64Array`; a scalar write has a non-number argument. |
| `RangeError` | capacity not an integer power of two in range; interval not finite and `> 0`; `off` out of bounds; invalid candle; time earlier than the last bar; `B` out of range; `out` too short. |

Every message starts with `[lite-ohlc]`. The scalar `lowerBound` / `upperBound` never throw.

---

## Composability

The whole live-chart data path: ticks -> forming bar -> closed bar -> visible window -> autoscale -> candles to draw.

```js
import {
  OhlcSeries, CANDLE_STRIDE, BOUNDS_STRIDE, BUCKET_STRIDE,
} from '@zakkster/lite-ohlc';

const MIN = 60000;
const T0 = 1.7e12;
const series = new OhlcSeries(4096, MIN);

// Preallocated, reused every frame: the hot path never allocates.
const bar = new Float64Array(CANDLE_STRIDE);
const q = new Float64Array(1);                   // time query scratch
const bounds = new Float64Array(BOUNDS_STRIDE);
const B = 8;                                     // buckets (about one per pixel column)
const buckets = new Float64Array(B * BUCKET_STRIDE);

// A deterministic fake feed: 1000 one-minute bars, each closed by a final tick.
let price = 100;
for (let j = 0; j < 1000; j++) {
  const t = T0 + j * MIN;
  const o = price;
  let h = o, l = o;
  for (let tick = 1; tick <= 4; tick++) {            // forming bar: several ticks
    price = o + Math.sin(j * 0.1 + tick) * 3 + tick * 0.1;
    if (price > h) h = price;
    if (price < l) l = price;
    bar[0] = t; bar[1] = o; bar[2] = h; bar[3] = l; bar[4] = price; bar[5] = tick;
    series.setLiveFrom(bar);                          // O(1), replaces the live bar
  }
  series.appendBarFrom(bar);                          // same time: closes the bar
}

// Visible window: the last 200 minutes, as times -> logical indices.
q[0] = T0 + 800 * MIN; const i0 = series.lowerBoundFrom(q);   // first bar with time >= x
q[0] = T0 + 999 * MIN; const i1 = series.upperBoundFrom(q);   // last bar with time <= x

series.boundsInto(i0, i1, bounds);                    // autoscale: bounds[0] = minLow, [1] = maxHigh
console.log('window', i0, i1, 'y-range', bounds[0].toFixed(2), bounds[1].toFixed(2), 'n', bounds[8]);

const w = series.decimateInto(i0, i1, B, buckets);    // returns buckets written
for (let k = 0; k < w; k++) {
  const o = k * BUCKET_STRIDE;                        // [t, o, high, low, close, sumVol, k]
  console.log(buckets[o + 6], buckets[o] - T0, buckets[o + 1].toFixed(2),
    buckets[o + 2].toFixed(2), buckets[o + 3].toFixed(2), buckets[o + 4].toFixed(2), buckets[o + 5]);
}
```

On this feed the window resolves to indices `800` to `999` (`n = 200`), and `decimateInto` writes 8 buckets of 25 bars. Use `copyRangeInto` instead when the visible count is already at or below the pixel count and you want the raw bars.

---

## Zero-GC design notes

<details>
<summary>What allocates, what does not, and what is gated.</summary>

All storage is allocated once in the constructor: six column arrays, the tree, a small Int32 state array and a small Float64 scratch. After that:

| Call                                                                              | Steady-state allocation |
| --------------------------------------------------------------------------------- | ----------------------- |
| `appendBarFrom`, `setLiveFrom`                                                    | **0**                   |
| `lowerBoundFrom`, `upperBoundFrom`                                                | **0**                   |
| `boundsInto`, `copyRangeInto`, `decimateInto`                                     | **0**                   |
| `version`, `count`, `capacity`, `hasLive`                                         | **0** (integers)        |
| `oldestTime`, `latestTime`, `interval`                                            | boxes one double per read |
| `appendBar`, `setLive`, `lowerBound`, `upperBound` (scalar wrappers)              | box fractional or large arguments (cold path) |
| every throw                                                                       | allocates the error (cold path) |

Every numeric hot return value is a small integer; the writes return the series. The scalar wrappers exist for convenience and as the control of the gate: use the `*From` / `*Into` forms in a frame loop.

Complexity is algorithmic, by construction: `setLiveFrom` O(1) for the new bar, `appendBarFrom` / bounds / searches O(log n), `decimateInto` O(n) on the scan path and O(B log capacity) on the tree path. The REPORTED benchmark below measures time against baselines on one host and does not prove complexity.

### Gated numbers

Measured 2026-10-21 on Node v26.8.2, macOS (Darwin 27), under the suite quiet-lock: one `npm run verify` run (exit 0) at 1-minute load average 2.80, except the 30-run zerobox row, which is the 1.0.0 run (not repeated for 1.0.1). Timing data is in Benchmarks (REPORTED) below; it gates nothing.

| Gate                                                                                                                            | Result                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                                      | 102 tests, 102 pass                                                                                     |
| `npm run test:zerobox`                                                                                                          | 12 of 12 pass                                                                                           |
| zerobox thresholds                                                                                                              | each gated hot method at `<= 0.1 B/op` (clear / capacity / hasLive are zero by construction, not gated) |
| zerobox control                                                                                                                 | scalar `setLive` with fractional args boxes `>= 16 B/op`                                                |
| zerobox, 30 consecutive runs                                                                                                    | 0 failures (1.0.0 run, 10 lanes; not re-run for 1.0.1)                                                  |
| torture GC window: 1e6 `setLiveFrom` + 1e5 `appendBarFrom` + 1e5 `boundsInto` + 1e5 `decimateInto` (scan / tree / sparse lanes) | GC major 0, minor 0                                                                                     |
| torture retention: 1000 create/drop cycles                                                                                      | tracker size 0, audit empty                                                                             |

The zerobox thresholds are limits, not measured B/op values; the control proves the gate can fail.

### Benchmarks (REPORTED)

REPORTED tier: this section is a measurement on one host; it gates nothing and proves no complexity.

Measured on Apple M4 Pro, Node v26.8.2, 2026-10-21: `boundsInto` measured 44.2x to 5873x faster than a hand-rolled best-form loop over an array of `{t,o,h,l,c,v}` objects, at n >= 1e5 (median of 21 rounds; every round >= 5x; per-row [min, max] in the table below).

`decimateInto` does not clear the bar against the best form (best median 8.93x at n=1e5, w=1e5, B=800; scan-path rows lose or tie: medians 0.88x / 0.94x / 0.96x), and `setLiveFrom` loses to the best-form index ring at every n (medians 0.34x-0.35x, no round above 0.36x: it validates each candle and maintains the tree; the baseline does neither). The idiomatic-baseline rows (for example `setLive` vs push/shift, medians 14.7x-867x) and the n < 1e5 rows are reported but carry no headline.

What is compared:

- **ratio** = baseline ns/op / lite ns/op, per round; above 1 means lite is faster.
- **best** baseline = plain for-loops over an array of objects (bounds, and decimate with the same integer bucket bound); for `setLive`, a preallocated index ring that reuses evicted objects, with no validation.
- **idiomatic** baseline = slice/reduce per bucket for decimate, and a push/shift array for `setLive` (its cost grows with n in this run: 181 / 1277 / 11083 ns/op at n = 1e4 / 1e5 / 1e6). Reported only.
- **eligible** = op is bounds or decimate, baseline is best, n >= 1e5 (the verdict rule). **clears** = median >= 10 AND min >= 5 over the 21 rounds.
- **path** = the path taken (tree / scan / sparse); **w** = window bars; **B** = buckets.

All rows (values as written by the harness):

| op | n | w | B | path | baseline | lite ns/op | base ns/op | ratio median [min, max] | IQR | eligible | clears |
|---|---|---|---|---|---|---|---|---|---|---|---|
| setLive | 1e4 | - | - | - | best | 12.2 | 4.32 | 0.35 [0.35, 0.36] | 0.35-0.36 | no | no |
| setLive | 1e4 | - | - | - | idiomatic | 12.2 | 181 | 14.7 [14.4, 15.2] | 14.6-14.9 | no | yes |
| bounds | 1e4 | 1e3 | - | tree | best | 40.1 | 1677 | 42.0 [40.4, 42.8] | 41.5-42.3 | no | yes |
| decimate | 1e4 | 1e3 | 800 | scan | best | 4192 | 3718 | 0.88 [0.81, 0.98] | 0.85-0.92 | no | no |
| decimate | 1e4 | 1e3 | 800 | scan | idiomatic | 4314 | 13002 | 3.04 [2.85, 3.60] | 2.97-3.19 | no | no |
| decimate | 1e4 | 1e3 | 1920 | sparse (1) | best | 2584 | 4620 | 1.79 [1.75, 1.83] | 1.78-1.80 | no | no |
| decimate | 1e4 | 1e3 | 1920 | sparse (1) | idiomatic | 2590 | 18013 | 6.96 [6.72, 7.64] | 6.94-6.99 | no | no |
| setLive | 1e5 | - | - | - | best | 12.5 | 4.35 | 0.35 [0.34, 0.36] | 0.35-0.35 | no | no |
| setLive | 1e5 | - | - | - | idiomatic | 12.5 | 1277 | 102 [101, 106] | 101-103 | no | yes |
| bounds | 1e5 | 1e3 | - | tree | best | 44.4 | 1965 | 44.2 [42.4, 46.2] | 43.5-44.9 | yes | yes |
| decimate | 1e5 | 1e3 | 800 | scan | best | 5629 | 5300 | 0.94 [0.88, 0.99] | 0.93-0.95 | yes | no |
| decimate | 1e5 | 1e3 | 800 | scan | idiomatic | 5639 | 13754 | 2.45 [2.37, 2.60] | 2.42-2.47 | no | no |
| decimate | 1e5 | 1e3 | 1920 | sparse (1) | best | 2644 | 5051 | 1.91 [1.84, 1.95] | 1.89-1.92 | yes | no |
| decimate | 1e5 | 1e3 | 1920 | sparse (1) | idiomatic | 2647 | 18705 | 7.07 [6.76, 7.33] | 6.98-7.18 | no | no |
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
| decimate | 1e6 | 1e3 | 1920 | sparse (1) | best | 2928 | 5320 | 1.81 [1.66, 1.85] | 1.78-1.83 | yes | no |
| decimate | 1e6 | 1e3 | 1920 | sparse (1) | idiomatic | 2993 | 19385 | 6.50 [5.89, 6.97] | 6.41-6.64 | no | no |
| bounds | 1e6 | 1e5 | - | tree | best | 85.8 | 215945 | 2519 [1999, 2817] | 2463-2650 | yes | yes |
| decimate | 1e6 | 1e5 | 800 | tree | best | 131871 | 309627 | 2.36 [2.31, 2.43] | 2.34-2.39 | yes | no |
| decimate | 1e6 | 1e5 | 800 | tree | idiomatic | 132054 | 733199 | 5.59 [5.31, 5.68] | 5.56-5.62 | no | no |
| decimate | 1e6 | 1e5 | 1920 | tree | best | 256243 | 371338 | 1.47 [1.44, 1.51] | 1.46-1.48 | yes | no |
| decimate | 1e6 | 1e5 | 1920 | tree | idiomatic | 251272 | 650927 | 2.61 [2.52, 2.67] | 2.57-2.62 | no | no |

(1) sparse: the window holds fewer bars than buckets (w=1e3 < B=1920), so `decimateInto` copies each bar into its own bucket (920 of the 1920 buckets stay empty). The harness marks the n >= 1e5 best-form sparse rows eligible; they do not clear and no headline rests on them.

Controls:

| control | A ns/op | B ns/op | ratio median [min, max] | IQR | clears |
|---|---|---|---|---|---|
| setLive 1e5 lite vs lite | 12.5 | 12.5 | 0.99 [0.98, 1.02] | 0.99-0.99 | no |
| decimate (1e5, 1e3, 800) scan lite vs lite | 5595 | 5842 | 1.04 [1.02, 1.06] | 1.03-1.04 | no |
| bounds (1e6, 1e5) lite vs lite | 78.2 | 80.8 | 1.01 [0.90, 1.09] | 0.98-1.06 | no |
| decimate (1e6, 1e5, 1920) tree lite vs lite | 256026 | 254587 | 1.00 [0.93, 1.02] | 0.99-1.02 | no |
| baseBounds n=1e6 w=1e5 vs w=1e3 | 2830 | 216958 | 76.6 [74.8, 79.1] | 76.1-77.5 | yes |

Lite-vs-lite controls must have a median in [0.8, 1.25] and must not clear; the positive control (the baseline against itself at w=1e5 vs w=1e3) must clear. All passed.

Provenance:

- date 2026-10-21T06:48Z; Apple M4 Pro, 12 cpus; Node v26.8.2.
- 1 run x 21 rounds; ABBA blocks of ~20 ms per side, 3 warmup blocks, `gc()` before every block.
- load1 2.24 at start, max 3.22 (bar 4.0); no other node process >= 10% CPU. Run by the maintainer from Terminal.app under the suite quiet-lock, with the Claude app and the IDE closed.
- GC over timed lite blocks: major 0 / minor 0 (baseline: minor 462, reported).
- Cross-check bitwise PASS before timing (5120 bounds + 10240 decimate + 10240 idiomatic starts + 6 setLive sides).
- Source: `bench/RESULTS.md` in the repository (`bench/` is not published in the npm package).

</details>

---

## Design decisions worth knowing

- **D1: a rewrite, not a port.** Salvaged from a never-published v1 source (`@zakkster/lite-time-series`). Only the ring indexing, candle validation, bound searches and bounds layout survive.
- **D2: the name.** `@zakkster/lite-ohlc`, main file `Ohlc.js`, class `OhlcSeries`.
- **D3: a narrow scope.** v1's viewport, hit-testing, series pool and Fenwick tree are gone. The store holds bars and answers range questions; the chart owns the rest.
- **D4: the tree is built in.** The fused 4-lane tree lives inside `Ohlc.js`, so there are zero runtime dependencies. `@zakkster/lite-logn`'s `SegmentTree` is a devDependency used only as a test oracle.
- **D5: `decimateInto` has two paths, on purpose.** For each query the path is chosen from the shape alone: when the visible count is below `B x log2(capacity)` it runs a linear scan; otherwise it runs one fused tree query per bucket. Times, prices and bucket indices are byte-identical across the two paths. Volume is byte-identical for integer volumes whose sums stay below 2^53; otherwise (fractional volumes, or integer sums at or past 2^53) the scan sums sequentially and the tree sums pairwise, so the last bits can differ. A given query always takes the same path, so repeated calls on the same data agree with themselves. This is documented, not hidden.
- **Live bar outside the tree.** Tick-rate writes never rebuild tree nodes.
- **Last-bar rule.** Equal time replaces, later appends, earlier throws; no mid-history edits (the rule lightweight-charts' `series.update()` applies by default).
- **Fail closed.** `NaN`, `Infinity`, `l > o`, negative volume and out-of-order times throw instead of being stored. Volume is capped at `Number.MAX_VALUE / (4 * capacity)` so tree sums can never overflow to `Infinity`. A bad query value returns `-1` (searches), `0` (range queries) and the EMPTY bounds record `[NaN x5, 0, -1, -1, 0]`, never a guess.
- **Index-based ranges.** Queries take logical indices; times go through `lowerBound` / `upperBound`. One binary search per window edge, then every query is index arithmetic.

---

## Testing

**102 tests, all pass** (`npm test`), plus the zerobox allocation gate and a torture gate (numbers above).

```bash
npm test             # node:test: core, oracle, parity, decimate, qa boundaries, B0 gates, 1.0.0 fast-path parity + work count
npm run test:zerobox # --expose-gc: <= 0.1 B/op per hot method, with a boxing control
npm run torture      # lite-leak + lite-gc-profiler: GC window and retention
npm run verify       # test + zerobox + torture
```

The benchmark is not an npm script; run it directly (`--smoke` = cross-check plus one untimed call per row; `--probe` = assert each decimate row's path). Exit 0 = MET or MISSED, 1 = abort (cross-check or probe failure, no `--expose-gc`, unknown flag), 2 = inconclusive (busy host or failed controls):

```bash
node --expose-gc bench/ohlc-vs-baseline.mjs   # REPORTED-tier bench vs best-form / idiomatic baselines; writes bench/RESULTS.md
```

Oracles: range results are checked against a naive scan and against `@zakkster/lite-logn`'s `SegmentTree`. The B0 gates (`test/b0-drift.test.mjs`, `test/b0-decimate.test.mjs`) were written against the unpublished v1 and fail on it.

---

## What this is not

- **Not a renderer.** It draws nothing. `lite-charts` is the planned consumer; its duck-typed source contract is `version`, `interval`, `count`, `oldestTime`, `latestTime`, `lowerBound`, `upperBound`, `boundsInto`, `decimateInto` and `copyRangeInto`.
- **No viewport, no hit-testing, no pool, no Fenwick tree (D3).** Pan/zoom math, pointer picking and multi-series pooling belong to the caller or the chart.
- **Not a history database.** A fixed ring; the oldest bar is evicted when it is full. Persisting is on you.
- **Not an indicator library.** No moving averages or oscillators.
- **Not a timestamp or timezone library.** `t` is any finite number, ordered; `interval` is metadata.
- **Not a tick store.** It holds bars; aggregate ticks into the forming bar yourself, as in the pipeline above.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- [`lite-charts`](https://www.npmjs.com/package/@zakkster/lite-charts) -- charts; the planned consumer of this store's source contract
- [`lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) -- `SegmentTree` and friends (devDependency here, used only as a test oracle)
- [`lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) -- O(1) window folds (candidate for a later indicators layer)
- [`lite-leak`](https://www.npmjs.com/package/@zakkster/lite-leak) and [`lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler) -- the torture gate's tooling (devDependencies)
- **`lite-ohlc`** -- this package

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
