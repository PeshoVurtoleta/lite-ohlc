import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '@zakkster/lite-viewport';
import {
  VERSION,
  DEFAULT_CAPACITY,
  MIN_CAPACITY,
  MAX_CAPACITY,
  BOUNDS_STRIDE,
  BUCKET_STRIDE,
  HIT_STRIDE,
  DEFAULT_POOL_MAX_SERIES,
  LiteTimeSeries,
  createTimeSeries,
  TimeSeriesViewport,
  createViewport,
  TimeSeriesPool,
  createTimeSeriesPool,
  hitTestInto,
  hitTestFrom
} from '../Ohlc.js';

// Seeded 32-bit-exact PRNG (Mulberry32) for deterministic randomized testing
function mulberry32(seed) {
  let state = seed >>> 0;
  return function nextFloat() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent brute-force linear scan oracle over plain JS reference array
function bruteForceClosestLogical(ref, targetTime) {
  if (ref.length === 0) return -1;
  let bestIdx = 0;
  let bestDiff = Math.abs(ref[0].time - targetTime);
  for (let i = 1; i < ref.length; i++) {
    const diff = Math.abs(ref[i].time - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Helper to snapshot all internal state of a LiteTimeSeries instance for fail-closed checks
function snapshotSeriesState(series) {
  return {
    head: series.head,
    count: series.count,
    version: series.version,
    time: Float64Array.from(series.time),
    open: Float64Array.from(series.open),
    high: Float64Array.from(series.high),
    low: Float64Array.from(series.low),
    close: Float64Array.from(series.close),
    volume: Float64Array.from(series.volume)
  };
}

function assertSeriesStateUnchanged(series, snap, label) {
  assert.strictEqual(series.head, snap.head, `${label}: head mutated`);
  assert.strictEqual(series.count, snap.count, `${label}: count mutated`);
  assert.strictEqual(series.version, snap.version, `${label}: version mutated`);
  assert.deepStrictEqual(series.time, snap.time, `${label}: time buffer mutated`);
  assert.deepStrictEqual(series.open, snap.open, `${label}: open buffer mutated`);
  assert.deepStrictEqual(series.high, snap.high, `${label}: high buffer mutated`);
  assert.deepStrictEqual(series.low, snap.low, `${label}: low buffer mutated`);
  assert.deepStrictEqual(series.close, snap.close, `${label}: close buffer mutated`);
  assert.deepStrictEqual(series.volume, snap.volume, `${label}: volume buffer mutated`);
}

describe('LiteTimeSeries Independent Oracle Suite', () => {
  it('exports spec constants and factory functions', () => {
    assert.strictEqual(VERSION, '1.0.0');
    assert.strictEqual(DEFAULT_CAPACITY, 65536);
    assert.strictEqual(MIN_CAPACITY, 2);
    assert.strictEqual(MAX_CAPACITY, 4194304);
    assert.strictEqual(BOUNDS_STRIDE, 9);
    assert.strictEqual(BUCKET_STRIDE, 7);
    assert.strictEqual(HIT_STRIDE, 14);
    assert.strictEqual(DEFAULT_POOL_MAX_SERIES, 64);

    const ts = createTimeSeries({ capacity: 16 });
    assert.ok(ts instanceof LiteTimeSeries);
    assert.strictEqual(ts.capacity, 16);

    const vp = createViewport({
      width: 800,
      height: 400,
      minTime: 0,
      maxTime: 100,
      minPrice: 10,
      maxPrice: 200
    });
    assert.ok(vp instanceof TimeSeriesViewport);

    const pool = createTimeSeriesPool({ maxSeries: 8, seriesCapacity: 16 });
    assert.ok(pool instanceof TimeSeriesPool);
    assert.strictEqual(pool.maxSeries, 8);
    assert.strictEqual(pool.seriesCapacity, 16);
  });

  describe('1. True Array Reference Oracle', () => {
    it('matches plain JS reference array byte-for-byte across 200 mixed operations and multiple wrap-arounds', () => {
      const CAPACITY = 16;
      const series = new LiteTimeSeries({ capacity: CAPACITY });
      const ref = [];

      // Two independent PRNG streams: one for operation choice, one for candle values
      const opRng = mulberry32(0x13572468);
      const valRng = mulberry32(0x24681357);

      const scratchIn = new Float64Array(12);
      const queryBuf = new Float64Array(4);
      const opCounts = {
        append: 0,
        appendFrom: 0,
        updateLatest: 0,
        updateLatestFrom: 0,
        fullWraps: 0
      };

      let currentTime = 1000;
      let prevHead = 0;

      for (let step = 0; step < 200; step++) {
        const u = opRng();
        // Generate valid OHLCV candle derived from valRng
        const basePrice = 100 + Math.round(valRng() * 5000) / 100;
        const spreadLow = Math.round((1 + valRng() * 10) * 100) / 100;
        const spreadHigh = Math.round((1 + valRng() * 10) * 100) / 100;
        const low = basePrice - spreadLow;
        const high = basePrice + spreadHigh;
        const open = low + Math.round(valRng() * (high - low) * 100) / 100;
        const close = low + Math.round(valRng() * (high - low) * 100) / 100;
        const volume = Math.round(valRng() * 10000);

        const canUpdate = ref.length > 0;
        if (!canUpdate || u < 0.35) {
          // append
          currentTime += 10 + Math.floor(valRng() * 20);
          series.append(currentTime, open, high, low, close, volume);
          ref.push({ time: currentTime, open, high, low, close, volume });
          if (ref.length > CAPACITY) ref.shift();
          opCounts.append++;
        } else if (u < 0.70) {
          // appendFrom at offset 3
          currentTime += 10 + Math.floor(valRng() * 20);
          scratchIn[3] = currentTime;
          scratchIn[4] = open;
          scratchIn[5] = high;
          scratchIn[6] = low;
          scratchIn[7] = close;
          scratchIn[8] = volume;
          series.appendFrom(scratchIn, 3);
          ref.push({ time: currentTime, open, high, low, close, volume });
          if (ref.length > CAPACITY) ref.shift();
          opCounts.appendFrom++;
        } else if (u < 0.85) {
          // updateLatest (keep timestamp equal or advance slightly while staying > previous sample)
          currentTime += Math.floor(valRng() * 3);
          series.updateLatest(currentTime, open, high, low, close, volume);
          ref[ref.length - 1] = { time: currentTime, open, high, low, close, volume };
          opCounts.updateLatest++;
        } else {
          // updateLatestFrom at offset 2
          currentTime += Math.floor(valRng() * 3);
          scratchIn[2] = currentTime;
          scratchIn[3] = open;
          scratchIn[4] = high;
          scratchIn[5] = low;
          scratchIn[6] = close;
          scratchIn[7] = volume;
          series.updateLatestFrom(scratchIn, 2);
          ref[ref.length - 1] = { time: currentTime, open, high, low, close, volume };
          opCounts.updateLatestFrom++;
        }

        if (series.count === CAPACITY && series.head < prevHead) {
          opCounts.fullWraps++;
        }
        prevHead = series.head;

        // 1a. Verify count, version, oldest, and latest accessors
        assert.strictEqual(series.version, step + 1, `step ${step}: version mismatch`);
        assert.strictEqual(series.count, ref.length, `step ${step}: count mismatch`);
        assert.strictEqual(series.getOldestTime(), ref[0].time, `step ${step}: oldest time mismatch`);
        assert.strictEqual(series.getLatestTime(), ref[ref.length - 1].time, `step ${step}: latest time mismatch`);
        assert.strictEqual(series.getOldestPhysicalIndex(), series.getPhysicalIndex(0));
        assert.strictEqual(series.getLatestPhysicalIndex(), series.getPhysicalIndex(ref.length - 1));

        // 1b. Verify every logical index 0..count-1 and physical round-trip byte-for-byte
        for (let i = 0; i < ref.length; i++) {
          const phys = series.getPhysicalIndex(i);
          assert.ok(phys >= 0 && phys < CAPACITY, `step ${step}: physical index out of range`);
          assert.strictEqual(series.getLogicalIndex(phys), i, `step ${step}: logical round-trip mismatch at i=${i}`);
          assert.strictEqual(series.time[phys], ref[i].time, `step ${step}: time mismatch at i=${i}`);
          assert.strictEqual(series.open[phys], ref[i].open, `step ${step}: open mismatch at i=${i}`);
          assert.strictEqual(series.high[phys], ref[i].high, `step ${step}: high mismatch at i=${i}`);
          assert.strictEqual(series.low[phys], ref[i].low, `step ${step}: low mismatch at i=${i}`);
          assert.strictEqual(series.close[phys], ref[i].close, `step ${step}: close mismatch at i=${i}`);
          assert.strictEqual(series.volume[phys], ref[i].volume, `step ${step}: volume mismatch at i=${i}`);
        }

        // 1c. Verify forEachVisible(0, count - 1) visits all count items even when full and wrapped
        const visitedLogical = [];
        const visitedPhysical = [];
        const visitedCount = series.forEachVisible(0, series.count - 1, (physIdx, logicalIdx) => {
          visitedPhysical.push(physIdx);
          visitedLogical.push(logicalIdx);
        });
        assert.strictEqual(visitedCount, ref.length, `step ${step}: forEachVisible return count mismatch`);
        assert.strictEqual(visitedLogical.length, ref.length, `step ${step}: forEachVisible visited length mismatch`);
        for (let i = 0; i < ref.length; i++) {
          assert.strictEqual(visitedLogical[i], i, `step ${step}: forEachVisible logical order mismatch`);
          assert.strictEqual(visitedPhysical[i], series.getPhysicalIndex(i), `step ${step}: forEachVisible physical order mismatch`);
        }

        // 1d. Verify findClosestLogicalIndex & findClosestPhysicalIndex against brute-force linear scan
        const probeTimes = [
          ref[0].time - 25,
          ref[0].time,
          ref[ref.length - 1].time,
          ref[ref.length - 1].time + 25
        ];
        for (let i = 0; i < ref.length - 1; i++) {
          const dt = ref[i + 1].time - ref[i].time;
          probeTimes.push(ref[i].time + dt * 0.25);
          probeTimes.push(ref[i].time + dt * 0.75);
        }

        for (let p = 0; p < probeTimes.length; p++) {
          const target = probeTimes[p];
          const expectedLogical = bruteForceClosestLogical(ref, target);
          const expectedPhysical = series.getPhysicalIndex(expectedLogical);

          assert.strictEqual(
            series.findClosestLogicalIndex(target),
            expectedLogical,
            `step ${step}: findClosestLogicalIndex(${target}) mismatch (count=${series.count})`
          );
          assert.strictEqual(
            series.findClosestPhysicalIndex(target),
            expectedPhysical,
            `step ${step}: findClosestPhysicalIndex(${target}) mismatch (count=${series.count})`
          );

          queryBuf[2] = target;
          assert.strictEqual(series.findClosestLogicalIndexFrom(queryBuf, 2), expectedLogical);
          assert.strictEqual(series.findClosestPhysicalIndexFrom(queryBuf, 2), expectedPhysical);
        }
      }

      // Asserted coverage floor across randomized streams
      assert.ok(opCounts.append >= 35, `insufficient append coverage: ${opCounts.append}`);
      assert.ok(opCounts.appendFrom >= 35, `insufficient appendFrom coverage: ${opCounts.appendFrom}`);
      assert.ok(opCounts.updateLatest >= 15, `insufficient updateLatest coverage: ${opCounts.updateLatest}`);
      assert.ok(opCounts.updateLatestFrom >= 15, `insufficient updateLatestFrom coverage: ${opCounts.updateLatestFrom}`);
      assert.ok(opCounts.fullWraps >= 5, `insufficient full buffer wrap coverage: ${opCounts.fullWraps}`);
    });

    it('tracks monotonic version counter across append, updateLatest (including count===0), clear, failed writes, and read queries', () => {
      const s1 = new LiteTimeSeries({ capacity: 8 });
      assert.strictEqual(s1.version, 0);

      // When count === 0, updateLatest delegates to append and must increment version by 1, NOT 2
      s1.updateLatest(100, 10, 15, 8, 12, 50);
      assert.strictEqual(s1.count, 1);
      assert.strictEqual(s1.version, 1, 'updateLatest on empty series must increment version by 1, not 2');

      const s2 = new LiteTimeSeries({ capacity: 8 });
      const inBuf = new Float64Array([0, 100, 10, 15, 8, 12, 50]);
      s2.updateLatestFrom(inBuf, 1);
      assert.strictEqual(s2.count, 1);
      assert.strictEqual(s2.version, 1, 'updateLatestFrom on empty series must increment version by 1, not 2');

      // Subsequent mutations each increment version by 1
      s1.append(200, 12, 18, 11, 16, 60);
      assert.strictEqual(s1.version, 2);

      inBuf.set([300, 16, 22, 14, 20, 70], 1);
      s1.appendFrom(inBuf, 1);
      assert.strictEqual(s1.version, 3);

      s1.updateLatest(305, 16, 25, 13, 21, 90);
      assert.strictEqual(s1.version, 4);

      inBuf.set([310, 16, 26, 12, 24, 110], 1);
      s1.updateLatestFrom(inBuf, 1);
      assert.strictEqual(s1.version, 5);

      // Read-only queries never change version
      const rangeOut = new Int32Array(3);
      const boundsOut = new Float64Array(BOUNDS_STRIDE);
      const decOut = new Float64Array(BUCKET_STRIDE * 4);
      const hitOut = new Float64Array(HIT_STRIDE);
      const vp = new TimeSeriesViewport({ width: 800, height: 400, minTime: 50, maxTime: 400, minPrice: 5, maxPrice: 50 });

      s1.findClosestLogicalIndex(200);
      s1.findClosestPhysicalIndex(200);
      s1.findLowerBoundLogicalIndex(100);
      s1.findUpperBoundLogicalIndex(310);
      s1.getVisibleLogicalRangeInto(100, 310, rangeOut, 0);
      s1.forEachVisible(0, s1.count - 1, () => {});
      s1.computeBoundsInto(100, 310, boundsOut, 0);
      s1.decimateInto(100, 310, 2, decOut, 0);
      s1.hitTestInto(vp, 400, 200, 50, hitOut, 0);
      assert.strictEqual(s1.version, 5, 'read-only queries must not mutate version');

      // Failed mutations leave version unchanged
      assert.throws(() => s1.append(100, 10, 12, 8, 9, 10), RangeError);
      assert.strictEqual(s1.version, 5);
      assert.throws(() => s1.updateLatest(400, 10, 5, 8, 9, 10), RangeError);
      assert.strictEqual(s1.version, 5);

      // clear() increments version by 1
      s1.clear();
      assert.strictEqual(s1.count, 0);
      assert.strictEqual(s1.version, 6);
    });
  });

  describe('2. Bounds & Decimation Conservation Oracle', () => {
    it('matches brute-force bounds scan and satisfies decimation conservation laws across wrapped buffers', () => {
      const CAPACITY = 64;
      const series = new LiteTimeSeries({ capacity: CAPACITY });
      const ref = [];
      const rng = mulberry32(0xabcdef01);

      for (let i = 0; i < 100; i++) {
        const t = 10000 + i * 60;
        const base = 200 + Math.sin(i * 0.2) * 50;
        const l = Math.round((base - 5 - rng() * 15) * 100) / 100;
        const h = Math.round((base + 5 + rng() * 15) * 100) / 100;
        const o = Math.round((l + rng() * (h - l)) * 100) / 100;
        const c = Math.round((l + rng() * (h - l)) * 100) / 100;
        const v = Math.round(100 + rng() * 5000);
        series.append(t, o, h, l, c, v);
        ref.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
        if (ref.length > CAPACITY) ref.shift();
      }

      const windows = [
        [ref[0].time, ref[ref.length - 1].time],
        [ref[5].time, ref[48].time],
        [ref[12].time - 10, ref[35].time + 10],
        [ref[20].time, ref[20].time]
      ];

      const rangeOut = new Int32Array(6);
      const boundsOut = new Float64Array(20);
      const boundsOutFrom = new Float64Array(20);
      const timeRangeBuf = new Float64Array(6);

      for (const [minTime, maxTime] of windows) {
        let expStart = -1;
        let expEnd = -1;
        for (let i = 0; i < ref.length; i++) {
          if (ref[i].time >= minTime && ref[i].time <= maxTime) {
            if (expStart === -1) expStart = i;
            expEnd = i;
          }
        }
        const visibleSlice = expStart === -1 ? [] : ref.slice(expStart, expEnd + 1);
        const expCount = visibleSlice.length;

        series.getVisibleLogicalRangeInto(minTime, maxTime, rangeOut, 2);
        assert.strictEqual(rangeOut[2], expStart);
        assert.strictEqual(rangeOut[3], expEnd);
        assert.strictEqual(rangeOut[4], expCount);

        timeRangeBuf[1] = minTime;
        timeRangeBuf[2] = maxTime;
        rangeOut.fill(0);
        series.getVisibleRangeFrom(timeRangeBuf, 1, rangeOut, 1);
        assert.strictEqual(rangeOut[1], expStart);
        assert.strictEqual(rangeOut[2], expEnd);
        assert.strictEqual(rangeOut[3], expCount);

        let expMinLow = Infinity;
        let expMaxHigh = -Infinity;
        let expMaxVol = -Infinity;
        let expSumVol = 0;
        for (const item of visibleSlice) {
          if (item.low < expMinLow) expMinLow = item.low;
          if (item.high > expMaxHigh) expMaxHigh = item.high;
          if (item.volume > expMaxVol) expMaxVol = item.volume;
          expSumVol += item.volume;
        }
        const expFirstOpen = visibleSlice[0].open;
        const expLastClose = visibleSlice[visibleSlice.length - 1].close;

        series.computeBoundsInto(minTime, maxTime, boundsOut, 3);
        assert.strictEqual(boundsOut[3 + 0], expMinLow, 'minLow mismatch');
        assert.strictEqual(boundsOut[3 + 1], expMaxHigh, 'maxHigh mismatch');
        assert.strictEqual(boundsOut[3 + 2], expMaxVol, 'maxVolume mismatch');
        assert.strictEqual(boundsOut[3 + 3], expFirstOpen, 'firstOpen mismatch');
        assert.strictEqual(boundsOut[3 + 4], expLastClose, 'lastClose mismatch');
        assert.ok(Math.abs(boundsOut[3 + 5] - expSumVol) < 1e-9, 'sumVolume mismatch');
        assert.strictEqual(boundsOut[3 + 6], expStart, 'startLogical mismatch');
        assert.strictEqual(boundsOut[3 + 7], expEnd, 'endLogical mismatch');
        assert.strictEqual(boundsOut[3 + 8], expCount, 'visibleCount mismatch');

        series.computeBoundsFrom(timeRangeBuf, 1, boundsOutFrom, 3);
        assert.deepStrictEqual(
          boundsOutFrom.subarray(3, 3 + BOUNDS_STRIDE),
          boundsOut.subarray(3, 3 + BOUNDS_STRIDE)
        );

        for (const bucketCount of [1, 2, 5, 11, 24, 64, 128]) {
          const decOut = new Float64Array(4 + bucketCount * BUCKET_STRIDE);
          const decOutFrom = new Float64Array(4 + bucketCount * BUCKET_STRIDE);
          const written = series.decimateInto(minTime, maxTime, bucketCount, decOut, 4);
          const writtenFrom = series.decimateFrom(timeRangeBuf, 1, bucketCount, decOutFrom, 4);

          assert.strictEqual(writtenFrom, written);
          assert.ok(written >= 1 && written <= Math.min(bucketCount, expCount));
          assert.deepStrictEqual(
            decOutFrom.subarray(4, 4 + written * BUCKET_STRIDE),
            decOut.subarray(4, 4 + written * BUCKET_STRIDE)
          );

          let totalSamples = 0;
          let totalVolume = 0;
          let decMinLow = Infinity;
          let decMaxHigh = -Infinity;
          let prevBucketTime = -Infinity;

          for (let b = 0; b < written; b++) {
            const base = 4 + b * BUCKET_STRIDE;
            const bTime = decOut[base + 0];
            const bOpen = decOut[base + 1];
            const bHigh = decOut[base + 2];
            const bLow = decOut[base + 3];
            const bClose = decOut[base + 4];
            const bVol = decOut[base + 5];
            const bCount = decOut[base + 6];

            assert.ok(bTime > prevBucketTime, `bucket ${b} firstTime not strictly increasing`);
            prevBucketTime = bTime;

            assert.ok(bCount >= 1 && Number.isInteger(bCount), `bucket ${b} invalid sampleCount`);
            assert.ok(bLow <= bOpen && bOpen <= bHigh, `bucket ${b} open outside [low, high]`);
            assert.ok(bLow <= bClose && bClose <= bHigh, `bucket ${b} close outside [low, high]`);

            if (bLow < decMinLow) decMinLow = bLow;
            if (bHigh > decMaxHigh) decMaxHigh = bHigh;
            totalVolume += bVol;
            totalSamples += bCount;
          }

          assert.strictEqual(totalSamples, expCount, `sampleCount conservation failed (bucketCount=${bucketCount})`);
          assert.ok(Math.abs(totalVolume - expSumVol) < 1e-9, `volumeSum conservation failed (bucketCount=${bucketCount})`);
          assert.strictEqual(decMinLow, expMinLow, `minLow conservation failed (bucketCount=${bucketCount})`);
          assert.strictEqual(decMaxHigh, expMaxHigh, `maxHigh conservation failed (bucketCount=${bucketCount})`);
          assert.strictEqual(decOut[4 + 0], visibleSlice[0].time, 'first bucket firstTime mismatch');
          assert.strictEqual(decOut[4 + 1], expFirstOpen, 'first bucket open mismatch');
          assert.strictEqual(decOut[4 + (written - 1) * BUCKET_STRIDE + 4], expLastClose, 'last bucket close mismatch');
        }
      }
    });

    it('ASSERTION 4: O(log N) computeBoundsInto / computeBoundsFrom matches independent O(N) linear scan across 300 mixed ops (with intra-bar shrink/raise/reduce and clear) and 500 intervals', () => {
      const CAPACITY = 32;
      const series = new LiteTimeSeries({ capacity: CAPACITY });
      const ref = [];

      const opRng = mulberry32(0x31415926);
      const valRng = mulberry32(0x27182818);
      const queryRng = mulberry32(0x16180339);

      const scratchCandle = new Float64Array(10);
      const timeRangeBuf = new Float64Array(4);
      const boundsOut = new Float64Array(16);
      const boundsOutFrom = new Float64Array(16);

      const opStats = {
        append: 0,
        appendFrom: 0,
        updateShrink: 0,
        updateExpand: 0,
        clear: 0
      };
      const queryStats = {
        total: 0,
        singleBar: 0,
        subRange: 0,
        fullBuffer: 0,
        wrappedSplitPhys: 0
      };

      function verifyIntervalQuery(minTime, maxTime, label) {
        let expStart = -1;
        let expEnd = -1;
        for (let i = 0; i < ref.length; i++) {
          if (ref[i].time >= minTime && ref[i].time <= maxTime) {
            if (expStart === -1) expStart = i;
            expEnd = i;
          }
        }

        const expCount = expStart === -1 ? 0 : (expEnd - expStart + 1);
        boundsOut.fill(0);
        boundsOutFrom.fill(0);

        const retInto = series.computeBoundsInto(minTime, maxTime, boundsOut, 2);
        timeRangeBuf[1] = minTime;
        timeRangeBuf[2] = maxTime;
        const retFrom = series.computeBoundsFrom(timeRangeBuf, 1, boundsOutFrom, 2);

        assert.strictEqual(retInto, expCount, `${label}: computeBoundsInto return mismatch`);
        assert.strictEqual(retFrom, expCount, `${label}: computeBoundsFrom return mismatch`);

        if (expCount === 0) {
          assert.ok(Number.isNaN(boundsOut[2 + 0]), `${label}: empty minLow should be NaN`);
          assert.ok(Number.isNaN(boundsOut[2 + 1]), `${label}: empty maxHigh should be NaN`);
          assert.ok(Number.isNaN(boundsOut[2 + 2]), `${label}: empty maxVolume should be NaN`);
          assert.ok(Number.isNaN(boundsOut[2 + 3]), `${label}: empty firstOpen should be NaN`);
          assert.ok(Number.isNaN(boundsOut[2 + 4]), `${label}: empty lastClose should be NaN`);
          assert.strictEqual(boundsOut[2 + 5], 0, `${label}: empty sumVolume should be 0`);
          assert.strictEqual(boundsOut[2 + 6], -1, `${label}: empty startLogical should be -1`);
          assert.strictEqual(boundsOut[2 + 7], -1, `${label}: empty endLogical should be -1`);
          assert.strictEqual(boundsOut[2 + 8], 0, `${label}: empty visibleCount should be 0`);
          return;
        }

        let expMinLow = Infinity;
        let expMaxHigh = -Infinity;
        let expMaxVol = -Infinity;
        let expSumVol = 0;
        for (let i = expStart; i <= expEnd; i++) {
          const item = ref[i];
          if (item.low < expMinLow) expMinLow = item.low;
          if (item.high > expMaxHigh) expMaxHigh = item.high;
          if (item.volume > expMaxVol) expMaxVol = item.volume;
          expSumVol += item.volume;
        }
        const expFirstOpen = ref[expStart].open;
        const expLastClose = ref[expEnd].close;

        assert.strictEqual(boundsOut[2 + 0], expMinLow, `${label}: minLow mismatch`);
        assert.strictEqual(boundsOut[2 + 1], expMaxHigh, `${label}: maxHigh mismatch`);
        assert.strictEqual(boundsOut[2 + 2], expMaxVol, `${label}: maxVolume mismatch`);
        assert.strictEqual(boundsOut[2 + 3], expFirstOpen, `${label}: firstOpen mismatch`);
        assert.strictEqual(boundsOut[2 + 4], expLastClose, `${label}: lastClose mismatch`);
        assert.ok(Math.abs(boundsOut[2 + 5] - expSumVol) < 1e-7, `${label}: sumVolume mismatch (${boundsOut[2 + 5]} vs ${expSumVol})`);
        assert.strictEqual(boundsOut[2 + 6], expStart, `${label}: startLogical mismatch`);
        assert.strictEqual(boundsOut[2 + 7], expEnd, `${label}: endLogical mismatch`);
        assert.strictEqual(boundsOut[2 + 8], expCount, `${label}: visibleCount mismatch`);

        assert.deepStrictEqual(
          boundsOutFrom.subarray(2, 2 + BOUNDS_STRIDE),
          boundsOut.subarray(2, 2 + BOUNDS_STRIDE),
          `${label}: computeBoundsFrom vs computeBoundsInto mismatch`
        );

        const startPhys = series.getPhysicalIndex(expStart);
        const endPhys = series.getPhysicalIndex(expEnd);
        if (expStart === expEnd) {
          queryStats.singleBar++;
        } else if (expStart === 0 && expEnd === ref.length - 1) {
          queryStats.fullBuffer++;
        } else {
          queryStats.subRange++;
        }
        if (startPhys > endPhys) {
          queryStats.wrappedSplitPhys++;
        }
        queryStats.total++;
      }

      let currentTime = 50000;

      for (let step = 0; step < 300; step++) {
        // Trigger clear() at deterministic checkpoints so tree reset and subsequent rebuild/wrap are tested
        if (step === 55 || step === 145) {
          series.clear();
          ref.length = 0;
          opStats.clear++;
          verifyIntervalQuery(0, 1000000, `step ${step} post-clear`);
          continue;
        }

        const u = opRng();
        if (ref.length === 0 || u < 0.35) {
          currentTime += 10 + Math.floor(valRng() * 30);
          const base = 100 + Math.round(valRng() * 2000) / 10;
          const low = Math.round((base - 10 - valRng() * 40) * 100) / 100;
          const high = Math.round((base + 10 + valRng() * 40) * 100) / 100;
          const open = Math.round((low + valRng() * (high - low)) * 100) / 100;
          const close = Math.round((low + valRng() * (high - low)) * 100) / 100;
          const volume = Math.round(500 + valRng() * 9500);

          series.append(currentTime, open, high, low, close, volume);
          ref.push({ time: currentTime, open, high, low, close, volume });
          if (ref.length > CAPACITY) ref.shift();
          opStats.append++;
        } else if (u < 0.65) {
          currentTime += 10 + Math.floor(valRng() * 30);
          const base = 100 + Math.round(valRng() * 2000) / 10;
          const low = Math.round((base - 10 - valRng() * 40) * 100) / 100;
          const high = Math.round((base + 10 + valRng() * 40) * 100) / 100;
          const open = Math.round((low + valRng() * (high - low)) * 100) / 100;
          const close = Math.round((low + valRng() * (high - low)) * 100) / 100;
          const volume = Math.round(500 + valRng() * 9500);

          scratchCandle[2] = currentTime;
          scratchCandle[3] = open;
          scratchCandle[4] = high;
          scratchCandle[5] = low;
          scratchCandle[6] = close;
          scratchCandle[7] = volume;
          series.appendFrom(scratchCandle, 2);
          ref.push({ time: currentTime, open, high, low, close, volume });
          if (ref.length > CAPACITY) ref.shift();
          opStats.appendFrom++;
        } else if (u < 0.88) {
          // Intra-bar updateLatest that specifically SHRINKS high, RAISES low, and REDUCES volume on newest bar
          const prev = ref[ref.length - 1];
          const span = prev.high - prev.low;
          const newLow = Math.round((prev.low + span * (0.15 + valRng() * 0.2)) * 100) / 100;
          const newHigh = Math.round((prev.high - span * (0.15 + valRng() * 0.2)) * 100) / 100;
          const safeLow = Math.min(newLow, newHigh - 0.5);
          const safeHigh = Math.max(newHigh, safeLow + 0.5);
          const newOpen = Math.round((safeLow + valRng() * (safeHigh - safeLow)) * 100) / 100;
          const newClose = Math.round((safeLow + valRng() * (safeHigh - safeLow)) * 100) / 100;
          const newVol = Math.max(1, Math.floor(prev.volume * (0.25 + valRng() * 0.5)));

          series.updateLatest(prev.time, newOpen, safeHigh, safeLow, newClose, newVol);
          ref[ref.length - 1] = {
            time: prev.time,
            open: newOpen,
            high: safeHigh,
            low: safeLow,
            close: newClose,
            volume: newVol
          };
          opStats.updateShrink++;
        } else {
          // Intra-bar updateLatestFrom that expands high/low/volume
          const prev = ref[ref.length - 1];
          const newLow = Math.round((prev.low - 5 - valRng() * 15) * 100) / 100;
          const newHigh = Math.round((prev.high + 5 + valRng() * 15) * 100) / 100;
          const newOpen = Math.round((newLow + valRng() * (newHigh - newLow)) * 100) / 100;
          const newClose = Math.round((newLow + valRng() * (newHigh - newLow)) * 100) / 100;
          const newVol = prev.volume + Math.floor(100 + valRng() * 1500);

          scratchCandle[1] = prev.time;
          scratchCandle[2] = newOpen;
          scratchCandle[3] = newHigh;
          scratchCandle[4] = newLow;
          scratchCandle[5] = newClose;
          scratchCandle[6] = newVol;
          series.updateLatestFrom(scratchCandle, 1);
          ref[ref.length - 1] = {
            time: prev.time,
            open: newOpen,
            high: newHigh,
            low: newLow,
            close: newClose,
            volume: newVol
          };
          opStats.updateExpand++;
        }

        // Run interval queries on current state
        if (ref.length > 0 && queryStats.total < 500) {
          const qMode = queryRng();
          let iA;
          let iB;
          if (qMode < 0.18) {
            // Single-bar interval
            iA = Math.floor(queryRng() * ref.length);
            iB = iA;
          } else if (qMode < 0.36) {
            // Full-buffer interval
            iA = 0;
            iB = ref.length - 1;
          } else {
            // Random sub-range
            const a = Math.floor(queryRng() * ref.length);
            const b = Math.floor(queryRng() * ref.length);
            iA = Math.min(a, b);
            iB = Math.max(a, b);
          }
          verifyIntervalQuery(ref[iA].time, ref[iB].time, `step ${step} query [${iA}..${iB}]`);
        }
      }

      // Complete remaining interval queries up to 500 on the final wrapped 32-element ring buffer
      while (queryStats.total < 500) {
        const qMode = queryRng();
        let iA;
        let iB;
        if (qMode < 0.15) {
          iA = Math.floor(queryRng() * ref.length);
          iB = iA;
        } else if (qMode < 0.30) {
          iA = 0;
          iB = ref.length - 1;
        } else {
          const a = Math.floor(queryRng() * ref.length);
          const b = Math.floor(queryRng() * ref.length);
          iA = Math.min(a, b);
          iB = Math.max(a, b);
        }
        verifyIntervalQuery(ref[iA].time, ref[iB].time, `final query #${queryStats.total} [${iA}..${iB}]`);
      }

      assert.strictEqual(queryStats.total, 500, 'must execute 500 interval queries');
      assert.ok(opStats.append >= 75, `insufficient append ops: ${opStats.append}`);
      assert.ok(opStats.appendFrom >= 60, `insufficient appendFrom ops: ${opStats.appendFrom}`);
      assert.ok(opStats.updateShrink >= 45, `insufficient shrinking updateLatest ops: ${opStats.updateShrink}`);
      assert.ok(opStats.clear === 2, `expected 2 clear ops, got ${opStats.clear}`);
      assert.ok(queryStats.singleBar >= 40, `insufficient single-bar queries: ${queryStats.singleBar}`);
      assert.ok(queryStats.subRange >= 200, `insufficient sub-range queries: ${queryStats.subRange}`);
      assert.ok(queryStats.fullBuffer >= 40, `insufficient full-buffer queries: ${queryStats.fullBuffer}`);
      assert.ok(queryStats.wrappedSplitPhys >= 50, `insufficient wrapped split physical queries: ${queryStats.wrappedSplitPhys}`);
    });
  });

  describe('3. Fail-Closed State Atomicity & Options Validation', () => {
    it('leaves all typed arrays, head, and count untouched when append or updateLatest rejects invalid inputs', () => {
      const series = new LiteTimeSeries({ capacity: 8 });
      series.append(100, 10, 15, 8, 12, 500);
      series.append(200, 12, 18, 11, 16, 600);
      series.append(300, 16, 20, 14, 15, 700);

      const snap = snapshotSeriesState(series);
      const buf = new Float64Array(8);

      const invalidAppendCases = [
        { name: 'NaN time', args: [NaN, 15, 20, 10, 15, 100] },
        { name: 'NaN open', args: [400, NaN, 20, 10, 15, 100] },
        { name: 'NaN high', args: [400, 15, NaN, 10, 15, 100] },
        { name: 'NaN low', args: [400, 15, 20, NaN, 15, 100] },
        { name: 'NaN close', args: [400, 15, 20, 10, NaN, 100] },
        { name: 'NaN volume', args: [400, 15, 20, 10, 15, NaN] },
        { name: 'Infinity time', args: [Infinity, 15, 20, 10, 15, 100] },
        { name: '-Infinity low', args: [400, 15, 20, -Infinity, 15, 100] },
        { name: 'Infinity volume', args: [400, 15, 20, 10, 15, Infinity] },
        { name: 'high < low', args: [400, 15, 9, 10, 15, 100] },
        { name: 'open > high', args: [400, 21, 20, 10, 15, 100] },
        { name: 'open < low', args: [400, 9, 20, 10, 15, 100] },
        { name: 'close > high', args: [400, 15, 20, 10, 22, 100] },
        { name: 'close < low', args: [400, 15, 20, 10, 8, 100] },
        { name: 'negative volume', args: [400, 15, 20, 10, 15, -0.01] },
        { name: 'duplicate timestamp', args: [300, 15, 20, 10, 15, 100] },
        { name: 'decreasing timestamp', args: [250, 15, 20, 10, 15, 100] }
      ];

      for (const tc of invalidAppendCases) {
        assert.throws(
          () => series.append(...tc.args),
          RangeError,
          `append(${tc.name}) must throw RangeError`
        );
        assertSeriesStateUnchanged(series, snap, `after invalid append(${tc.name})`);

        for (let i = 0; i < 6; i++) buf[i + 1] = tc.args[i];
        assert.throws(
          () => series.appendFrom(buf, 1),
          RangeError,
          `appendFrom(${tc.name}) must throw RangeError`
        );
        assertSeriesStateUnchanged(series, snap, `after invalid appendFrom(${tc.name})`);
      }

      const invalidUpdateCases = [
        { name: 'NaN close', args: [300, 15, 20, 10, NaN, 100] },
        { name: 'Infinity high', args: [300, 15, Infinity, 10, 15, 100] },
        { name: 'high < low', args: [300, 15, 12, 14, 13, 100] },
        { name: 'open > high', args: [300, 25, 20, 10, 15, 100] },
        { name: 'close < low', args: [300, 15, 20, 10, 5, 100] },
        { name: 'negative volume', args: [300, 15, 20, 10, 15, -5] },
        { name: 'time <= previous candle time (200)', args: [200, 15, 20, 10, 15, 100] },
        { name: 'time < previous candle time (150)', args: [150, 15, 20, 10, 15, 100] }
      ];

      for (const tc of invalidUpdateCases) {
        assert.throws(
          () => series.updateLatest(...tc.args),
          RangeError,
          `updateLatest(${tc.name}) must throw RangeError`
        );
        assertSeriesStateUnchanged(series, snap, `after invalid updateLatest(${tc.name})`);

        for (let i = 0; i < 6; i++) buf[i + 2] = tc.args[i];
        assert.throws(
          () => series.updateLatestFrom(buf, 2),
          RangeError,
          `updateLatestFrom(${tc.name}) must throw RangeError`
        );
        assertSeriesStateUnchanged(series, snap, `after invalid updateLatestFrom(${tc.name})`);
      }
    });

    it('ASSERTION 2: enforces Fenwick volume budget fail-closed atomicity on append and updateLatest without mutating channel or tree state', () => {
      const ts = new LiteTimeSeries({ capacity: 8 });
      ts.append(100, 10, 15, 8, 12, 500);
      ts.append(200, 12, 18, 11, 16, 600);
      ts.append(300, 16, 20, 14, 15, 700);

      const snap = snapshotSeriesState(ts);
      const boundsBefore = new Float64Array(BOUNDS_STRIDE);
      const boundsAfter = new Float64Array(BOUNDS_STRIDE);
      ts.computeBoundsInto(100, 300, boundsBefore, 0);

      const excessiveVol = Number.MAX_VALUE / 2;
      const inBuf = new Float64Array([0, 400, 10, 12, 8, 9, excessiveVol]);

      assert.throws(
        () => ts.append(400, 10, 12, 8, 9, excessiveVol),
        RangeError,
        'append with Number.MAX_VALUE / 2 volume must throw RangeError'
      );
      assertSeriesStateUnchanged(ts, snap, 'after excessive volume append');
      ts.computeBoundsInto(100, 300, boundsAfter, 0);
      assert.deepStrictEqual(boundsAfter, boundsBefore, 'tree/bounds state mutated after rejected append');

      assert.throws(
        () => ts.appendFrom(inBuf, 1),
        RangeError,
        'appendFrom with Number.MAX_VALUE / 2 volume must throw RangeError'
      );
      assertSeriesStateUnchanged(ts, snap, 'after excessive volume appendFrom');
      boundsAfter.fill(0);
      ts.computeBoundsInto(100, 300, boundsAfter, 0);
      assert.deepStrictEqual(boundsAfter, boundsBefore, 'tree/bounds state mutated after rejected appendFrom');

      assert.throws(
        () => ts.updateLatest(300, 10, 12, 8, 9, excessiveVol),
        RangeError,
        'updateLatest with Number.MAX_VALUE / 2 volume must throw RangeError'
      );
      assertSeriesStateUnchanged(ts, snap, 'after excessive volume updateLatest');
      boundsAfter.fill(0);
      ts.computeBoundsInto(100, 300, boundsAfter, 0);
      assert.deepStrictEqual(boundsAfter, boundsBefore, 'tree/bounds state mutated after rejected updateLatest');

      inBuf[1] = 300;
      assert.throws(
        () => ts.updateLatestFrom(inBuf, 1),
        RangeError,
        'updateLatestFrom with Number.MAX_VALUE / 2 volume must throw RangeError'
      );
      assertSeriesStateUnchanged(ts, snap, 'after excessive volume updateLatestFrom');
      boundsAfter.fill(0);
      ts.computeBoundsInto(100, 300, boundsAfter, 0);
      assert.deepStrictEqual(boundsAfter, boundsBefore, 'tree/bounds state mutated after rejected updateLatestFrom');
    });

    it('validates options objects on LiteTimeSeries, TimeSeriesViewport, and TimeSeriesPool (plain object, symbols, typo hint, power-of-2 capacity)', () => {
      const nonPlainValues = [null, 'options', 123, true, [16], Object.create(null), new Date()];
      for (const bad of nonPlainValues) {
        assert.throws(() => new LiteTimeSeries(bad), TypeError);
        assert.throws(() => new TimeSeriesViewport(bad), TypeError);
        assert.throws(() => new TimeSeriesPool(bad), TypeError);
      }

      const sym = Symbol('extra');
      assert.throws(() => new LiteTimeSeries({ [sym]: 16 }), TypeError);
      assert.throws(() => new TimeSeriesViewport({ [sym]: 800 }), TypeError);
      assert.throws(() => new TimeSeriesPool({ [sym]: 8 }), TypeError);

      assert.throws(
        () => new LiteTimeSeries({ capactiy: 16 }),
        (err) => err instanceof TypeError && /Did you mean "capacity"/i.test(err.message)
      );
      assert.throws(
        () => new TimeSeriesViewport({ widht: 800 }),
        (err) => err instanceof TypeError && /Did you mean "width"/i.test(err.message)
      );
      assert.throws(
        () => new TimeSeriesPool({ maxSereis: 8 }),
        (err) => err instanceof TypeError && /Did you mean "maxSeries"/i.test(err.message)
      );
      assert.throws(
        () => new TimeSeriesPool({ seriesCapactiy: 16 }),
        (err) => err instanceof TypeError && /Did you mean "seriesCapacity"/i.test(err.message)
      );
      assert.throws(
        () => new TimeSeriesPool({ onEvcit: () => {} }),
        (err) => err instanceof TypeError && /Did you mean "onEvict"/i.test(err.message)
      );

      for (const badCap of [0, 1, 3, 7, 15, 100, -16, 16.5, NaN, Infinity, MAX_CAPACITY * 2]) {
        assert.throws(
          () => new LiteTimeSeries({ capacity: badCap }),
          RangeError,
          `capacity=${badCap} should throw RangeError`
        );
        assert.throws(
          () => new TimeSeriesPool({ seriesCapacity: badCap }),
          RangeError,
          `seriesCapacity=${badCap} should throw RangeError`
        );
      }

      assert.throws(() => new TimeSeriesPool({ maxSeries: '8' }), TypeError);
      assert.throws(() => new TimeSeriesPool({ seriesCapacity: '16' }), TypeError);
      assert.throws(() => new TimeSeriesPool({ onEvict: 'not-a-fn' }), TypeError);

      for (const badMax of [0, -1, 4.5, 65537, NaN, Infinity]) {
        assert.throws(
          () => new TimeSeriesPool({ maxSeries: badMax }),
          RangeError,
          `maxSeries=${badMax} should throw RangeError`
        );
      }
    });
  });

  describe('4. Viewport & HitTest Oracle', () => {
    it('verifies linear and log10 round-trip transforms, pivot-preserving zoomTime, and mapToScreenInto/From against manual math', () => {
      const vp = new TimeSeriesViewport({
        width: 1000,
        height: 500,
        minTime: 1000,
        maxTime: 3000,
        minPrice: 10,
        maxPrice: 1000,
        paddingTop: 0,
        paddingBottom: 0,
        isLogScale: false
      });

      // Linear scale manual math (with Math.round on screen coords):
      // x = Math.round(((t - 1000) / (3000 - 1000)) * 1000)
      // y = Math.round(500 - ((p - 10) / (1000 - 10)) * 500)
      for (const t of [1000, 1250, 2000, 2750, 3000]) {
        const expectedX = Math.round(((t - 1000) / 2000) * 1000);
        const x = vp.timeToX(t);
        assert.strictEqual(x, expectedX, `linear timeToX(${t}) mismatch`);
        assert.ok(Math.abs(vp.xToTime(x) - t) <= 2, `linear xToTime round-trip failed for t=${t}`);
      }

      for (const p of [10, 109, 505, 802, 1000]) {
        const expectedY = Math.round(500 - ((p - 10) / 990) * 500);
        const y = vp.priceToY(p);
        assert.strictEqual(y, expectedY, `linear priceToY(${p}) mismatch`);
        assert.ok(Math.abs(vp.yToPrice(y) - p) <= 2, `linear yToPrice round-trip failed for p=${p}`);
      }

      // mapToScreenInto / mapToScreenFrom verification in linear mode
      const screenOut = new Float64Array(6);
      const screenIn = new Float64Array([0, 1500, 505]);
      vp.mapToScreenInto(1500, 505, screenOut, 2);
      assert.strictEqual(screenOut[2], vp.timeToX(1500));
      assert.strictEqual(screenOut[3], vp.priceToY(505));

      screenOut.fill(0);
      vp.mapToScreenFrom(screenIn, 1, screenOut, 3);
      assert.strictEqual(screenOut[3], vp.timeToX(1500));
      assert.strictEqual(screenOut[4], vp.priceToY(505));

      // Pivot-preserving zoomTime verification
      const pivotX = 350;
      const anchorTimeBefore = vp.xToTime(pivotX);
      vp.zoomTime(0.5, anchorTimeBefore);
      const anchorTimeAfter = vp.xToTime(pivotX);
      assert.ok(
        Math.abs(anchorTimeAfter - anchorTimeBefore) < 1e-9,
        `zoomTime failed to preserve anchor time at pivotX=${pivotX}: ${anchorTimeBefore} vs ${anchorTimeAfter}`
      );
      assert.strictEqual(vp.timeToX(anchorTimeBefore), pivotX);

      // Log10 scale manual math:
      // logMin = log10(10) = 1, logMax = log10(1000) = 3
      // y = Math.round(500 - ((log10(p) - 1) / (3 - 1)) * 500)
      const logVp = new TimeSeriesViewport({
        width: 1000,
        height: 500,
        minTime: 1000,
        maxTime: 3000,
        minPrice: 10,
        maxPrice: 1000,
        paddingTop: 0,
        paddingBottom: 0,
        isLogScale: true
      });

      for (const p of [10, 31.622776601683793, 100, 316.22776601683796, 1000]) {
        const expectedLogY = Math.round(500 - ((Math.log10(p) - 1) / 2) * 500);
        const y = logVp.priceToY(p);
        assert.strictEqual(y, expectedLogY, `log10 priceToY(${p}) mismatch: got ${y}, expected ${expectedLogY}`);
        assert.ok(Math.abs(logVp.yToPrice(y) - p) < 1e-6, `log10 yToPrice round-trip failed for p=${p}`);
      }
    });

    it('verifies hitTestInto and hitTestFrom against manual coordinate geometry', () => {
      const series = new LiteTimeSeries({ capacity: 8 });
      for (let i = 0; i < 10; i++) {
        const t = 1000 + i * 100;
        const o = 100 + i * 10;
        const h = o + 20;
        const l = o - 15;
        const c = o + 5;
        const v = 1000 + i * 100;
        series.append(t, o, h, l, c, v);
      }

      const vp = new TimeSeriesViewport({
        width: 700,
        height: 350,
        minTime: 1200,
        maxTime: 1900,
        minPrice: 50,
        maxPrice: 300
      });

      const targetLogical = 3;
      const targetPhysical = series.getPhysicalIndex(targetLogical);
      const expectedCandleX = vp.timeToX(1500);
      assert.strictEqual(expectedCandleX, 300);

      const hitOut = new Float64Array(20);
      const hitOutFrom = new Float64Array(20);
      const hitIn = new Float64Array([0, 306, 180, 10]);

      const hit = hitTestInto(series, vp, 306, 180, 10, hitOut, 2);
      assert.strictEqual(hit, 1, 'expected hit within snap distance');
      assert.strictEqual(hitOut[2 + 0], targetLogical, 'logicalIdx mismatch');
      assert.strictEqual(hitOut[2 + 1], targetPhysical, 'physicalIdx mismatch');
      assert.strictEqual(hitOut[2 + 2], 1500, 'time mismatch');
      assert.strictEqual(hitOut[2 + 3], 150, 'open mismatch');
      assert.strictEqual(hitOut[2 + 4], 170, 'high mismatch');
      assert.strictEqual(hitOut[2 + 5], 135, 'low mismatch');
      assert.strictEqual(hitOut[2 + 6], 155, 'close mismatch');
      assert.strictEqual(hitOut[2 + 7], 1500, 'volume mismatch');
      assert.strictEqual(hitOut[2 + 8], 300, 'snappedX mismatch');
      assert.strictEqual(hitOut[2 + 10], vp.priceToY(150), 'yOpen mismatch');
      assert.strictEqual(hitOut[2 + 11], vp.priceToY(170), 'yHigh mismatch');
      assert.strictEqual(hitOut[2 + 12], vp.priceToY(135), 'yLow mismatch');
      assert.strictEqual(hitOut[2 + 13], vp.priceToY(155), 'yClose mismatch');

      const hitFrom = hitTestFrom(series, vp, hitIn, 1, hitOutFrom, 2);
      assert.strictEqual(hitFrom, 1);
      assert.deepStrictEqual(
        hitOutFrom.subarray(2, 2 + HIT_STRIDE),
        hitOut.subarray(2, 2 + HIT_STRIDE)
      );

      hitOutFrom.fill(0);
      assert.strictEqual(series.hitTestInto(vp, 306, 180, 10, hitOutFrom, 2), 1);
      assert.deepStrictEqual(
        hitOutFrom.subarray(2, 2 + HIT_STRIDE),
        hitOut.subarray(2, 2 + HIT_STRIDE)
      );

      hitOutFrom.fill(0);
      assert.strictEqual(series.hitTestFrom(vp, hitIn, 1, hitOutFrom, 2), 1);
      assert.deepStrictEqual(
        hitOutFrom.subarray(2, 2 + HIT_STRIDE),
        hitOut.subarray(2, 2 + HIT_STRIDE)
      );

      const miss = series.hitTestInto(vp, 315, 180, 10, hitOut, 2);
      assert.strictEqual(miss, 0, 'expected miss outside maxSnapDistance');
    });

    it('ASSERTION 5: verifies @zakkster/lite-viewport Viewport option construction, syncViewport, bindViewport chaining, and unbindViewport cleanup', () => {
      const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
      const prevWindow = globalThis.window;
      globalThis.window = {
        devicePixelRatio: 2,
        innerWidth: 800,
        innerHeight: 600
      };

      try {
        let rectWidth = 960;
        let rectHeight = 540;
        const priorCalls = [];
        const originalOnResize = (w, h, dpr) => {
          priorCalls.push([w, h, dpr]);
        };

        const canvasStub = {
          width: 0,
          height: 0,
          style: {},
          parentElement: {
            getBoundingClientRect: () => ({ width: rectWidth, height: rectHeight })
          },
          getContext: () => ({
            setTransform() {},
            scale() {}
          })
        };

        const canvasVp = new Viewport({
          canvas: canvasStub,
          autoResize: false,
          onResize: originalOnResize
        });

        assert.strictEqual(canvasVp.width, 960);
        assert.strictEqual(canvasVp.height, 540);
        assert.strictEqual(priorCalls.length, 1);
        assert.deepStrictEqual(priorCalls[0], [960, 540, 2]);

        // 1. Verify createViewport({ viewport: canvasVp })
        const vpFromOption = createViewport({
          viewport: canvasVp,
          minTime: 1000,
          maxTime: 2000,
          minPrice: 10,
          maxPrice: 100
        });
        assert.strictEqual(vpFromOption.width, 960);
        assert.strictEqual(vpFromOption.height, 540);

        rectWidth = 1024;
        rectHeight = 640;
        canvasVp.resize();
        assert.strictEqual(vpFromOption.width, 1024);
        assert.strictEqual(vpFromOption.height, 640);
        assert.strictEqual(priorCalls.length, 2);
        assert.deepStrictEqual(priorCalls[1], [1024, 640, 2]);

        vpFromOption.unbindViewport();
        assert.strictEqual(canvasVp.onResize, originalOnResize);

        // 2. Verify syncViewport(canvasVp), bindViewport(canvasVp), and unbindViewport()
        const vp = createViewport({
          width: 320,
          height: 200,
          minTime: 1000,
          maxTime: 2000,
          minPrice: 10,
          maxPrice: 100
        });

        assert.strictEqual(vp.syncViewport(canvasVp), vp);
        assert.strictEqual(vp.width, 1024);
        assert.strictEqual(vp.height, 640);

        // syncViewport is one-shot; resizing canvasVp before bindViewport does not mutate vp
        rectWidth = 1100;
        rectHeight = 680;
        canvasVp.resize();
        assert.strictEqual(vp.width, 1024);
        assert.strictEqual(vp.height, 640);
        assert.strictEqual(priorCalls.length, 3);
        assert.deepStrictEqual(priorCalls[2], [1100, 680, 2]);

        // bindViewport syncs immediately and chains onto canvasVp.onResize
        assert.strictEqual(vp.bindViewport(canvasVp), vp);
        assert.strictEqual(vp.width, 1100);
        assert.strictEqual(vp.height, 680);

        rectWidth = 1280;
        rectHeight = 720;
        canvasVp.resize();
        assert.strictEqual(vp.width, 1280);
        assert.strictEqual(vp.height, 720);
        assert.strictEqual(priorCalls.length, 4);
        assert.deepStrictEqual(priorCalls[3], [1280, 720, 2]);

        // unbindViewport restores originalOnResize and stops updating vp on future resizes
        assert.strictEqual(vp.unbindViewport(), vp);
        assert.strictEqual(canvasVp.onResize, originalOnResize);

        rectWidth = 1600;
        rectHeight = 900;
        canvasVp.resize();
        assert.strictEqual(priorCalls.length, 5);
        assert.deepStrictEqual(priorCalls[4], [1600, 900, 2]);
        assert.strictEqual(vp.width, 1280);
        assert.strictEqual(vp.height, 720);
      } finally {
        if (hadWindow) {
          globalThis.window = prevWindow;
        } else {
          delete globalThis.window;
        }
      }
    });
  });

  describe('5. TimeSeriesPool SIEVE Eviction & Recycling Oracle', () => {
    it('implements SIEVE second-chance eviction, peek/has non-promotion, and onEvict notification', () => {
      const evicted = [];
      const pool = createTimeSeriesPool({
        maxSeries: 4,
        seriesCapacity: 16,
        onEvict: (key, series) => {
          evicted.push([key, series]);
        }
      });

      assert.strictEqual(Object.prototype.toString.call(pool), '[object TimeSeriesPool]');
      assert.strictEqual(pool.maxSeries, 4);
      assert.strictEqual(pool.seriesCapacity, 16);
      assert.strictEqual(pool.size, 0);
      assert.strictEqual(pool.freeCount, 0);
      assert.strictEqual(pool.totalAllocated, 0);

      // Fill cache: A (oldest/tail), B, C, D (newest/head)
      const sA = pool.acquire('A');
      const sB = pool.acquire('B');
      const sC = pool.acquire('C');
      const sD = pool.acquire('D');

      assert.strictEqual(pool.getOrCreate('A'), sA);
      assert.strictEqual(pool.size, 4);
      assert.strictEqual(pool.totalAllocated, 4);
      assert.strictEqual(pool.freeCount, 0);

      // Touch 'A' via get('A') and 'C' via acquire('C') -> visited(A)=1, visited(C)=1
      assert.strictEqual(pool.get('A'), sA);
      assert.strictEqual(pool.acquire('C'), sC);

      // peek('B') and has('D') must NOT set the SIEVE visited bit
      assert.strictEqual(pool.peek('B'), sB);
      assert.strictEqual(pool.has('D'), true);

      // Acquire 'E': SIEVE hand starts at tail ('A'), grants 'A' a second chance (visited 1 -> 0),
      // advances to 'B' (visited=0), and evicts 'B'
      const sE = pool.acquire('E');
      assert.strictEqual(evicted.length, 1, 'onEvict should have fired once');
      assert.strictEqual(evicted[0][0], 'B', 'SIEVE hand should spare visited A and evict unvisited B');
      assert.strictEqual(evicted[0][1], sB);

      assert.strictEqual(pool.has('B'), false);
      assert.strictEqual(pool.get('B'), undefined);
      assert.strictEqual(pool.peek('B'), undefined);
      assert.strictEqual(pool.has('A'), true);
      assert.strictEqual(pool.has('C'), true);
      assert.strictEqual(pool.has('D'), true);
      assert.strictEqual(pool.has('E'), true);
      assert.strictEqual(pool.size, 4);
      assert.ok(sE instanceof LiteTimeSeries);
    });

    it('recycles LiteTimeSeries instances across 200 distinct symbol acquisitions, delete(), and clear() with bounded allocation', () => {
      const pool = new TimeSeriesPool({
        maxSeries: 8,
        seriesCapacity: 16
      });
      const boundsBuf = new Float64Array(BOUNDS_STRIDE);

      for (let i = 0; i < 200; i++) {
        const key = `SYM_${i}`;
        const ts = pool.acquire(key);

        // Every newly acquired or recycled instance must start completely empty and clean
        assert.strictEqual(ts.count, 0, `recycled series for ${key} must have count === 0`);
        assert.strictEqual(ts.head, 0, `recycled series for ${key} must have head === 0`);
        assert.strictEqual(ts.computeBoundsInto(0, 1e9, boundsBuf, 0), 0);
        assert.ok(Number.isNaN(boundsBuf[0]));

        // Populate with 5 bars and verify bounds match manual values
        for (let b = 0; b < 5; b++) {
          const t = 1000 + b * 60;
          const o = 50 + i + b;
          const h = o + 10;
          const l = o - 5;
          const c = o + 2;
          const v = 100 * (b + 1);
          ts.append(t, o, h, l, c, v);
        }
        assert.strictEqual(ts.count, 5);
        assert.strictEqual(ts.computeBoundsInto(1000, 1240, boundsBuf, 0), 5);
        assert.strictEqual(boundsBuf[0], 50 + i - 5);
        assert.strictEqual(boundsBuf[1], 50 + i + 4 + 10);
        assert.strictEqual(boundsBuf[5], 1500);
      }

      assert.strictEqual(pool.size, 8);
      assert.ok(pool.totalAllocated <= 9, `expected totalAllocated <= 9, got ${pool.totalAllocated}`);
      assert.strictEqual(pool.freeCount, pool.totalAllocated - pool.size);

      // Verify keys(), values(), entries(), and [Symbol.iterator]() (entries yields a borrowed tuple per @zakkster/lite-lru D18.2)
      const keys = Array.from(pool.keys());
      const values = Array.from(pool.values());
      const entries = Array.from(pool.entries(), ([k, v]) => [k, v]);
      const iterEntries = Array.from(pool, ([k, v]) => [k, v]);
      assert.strictEqual(keys.length, 8);
      assert.strictEqual(values.length, 8);
      assert.deepStrictEqual(entries, iterEntries);
      for (let i = 0; i < 8; i++) {
        assert.strictEqual(entries[i][0], keys[i]);
        assert.strictEqual(entries[i][1], values[i]);
        assert.strictEqual(pool.peek(keys[i]), values[i]);
      }

      // Verify delete(key) recycles the instance into freeList without allocating on next acquire
      const allocBeforeDelete = pool.totalAllocated;
      const victimKey = keys[0];
      assert.strictEqual(pool.delete(victimKey), true);
      assert.strictEqual(pool.delete(victimKey), false);
      assert.strictEqual(pool.size, 7);
      assert.strictEqual(pool.freeCount, allocBeforeDelete - 7);

      const reusedAfterDelete = pool.acquire('SYM_AFTER_DELETE');
      assert.strictEqual(reusedAfterDelete.count, 0);
      assert.strictEqual(pool.totalAllocated, allocBeforeDelete, 'acquire after delete must reuse freeList');
      assert.strictEqual(pool.size, 8);

      // Verify clear() recycles all resident instances into freeList so 8 new acquisitions allocate 0 instances
      pool.clear();
      assert.strictEqual(pool.size, 0);
      assert.strictEqual(pool.freeCount, allocBeforeDelete);

      for (let k = 0; k < 8; k++) {
        const s = pool.acquire(`POST_CLEAR_${k}`);
        assert.strictEqual(s.count, 0);
      }
      assert.strictEqual(pool.size, 8);
      assert.strictEqual(pool.totalAllocated, allocBeforeDelete, 'acquisitions after clear() must reuse freeList');
    });
  });
});
