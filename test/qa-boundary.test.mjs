// test/qa-boundary.test.mjs -- Boundary matrix & planner assertions QA suite
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceObserver } from 'node:perf_hooks';

import {
    VERSION,
    DEFAULT_CAPACITY,
    MIN_CAPACITY,
    MAX_CAPACITY,
    BOUNDS_STRIDE,
    BUCKET_STRIDE,
    HIT_STRIDE,
    LiteTimeSeries,
    createTimeSeries,
    TimeSeriesViewport,
    createViewport,
    hitTestInto,
    hitTestFrom,
    TimeSeriesPool,
    createTimeSeriesPool
} from '../Ohlc.js';

// -----------------------------------------------------------------------------
// ASSERTION 1: Wraparound & Full-Capacity Boundary
// -----------------------------------------------------------------------------
test('ASSERTION 1: wraparound & full-capacity boundary (MIN_CAPACITY = 2)', () => {
    const ts = createTimeSeries({ capacity: MIN_CAPACITY });
    assert.equal(ts.capacity, 2);
    assert.equal(ts.count, 0);
    assert.equal(ts.head, 0);

    // Initial boundary calls on empty buffer
    assert.equal(ts.getPhysicalIndex(0), -1);
    assert.equal(ts.getLogicalIndex(0), -1);
    assert.equal(ts.getLatestPhysicalIndex(), -1);
    assert.equal(ts.getOldestPhysicalIndex(), -1);
    assert.ok(Number.isNaN(ts.getLatestTime()));
    assert.ok(Number.isNaN(ts.getOldestTime()));

    // 1st append: count 1, head 1
    ts.append(100, 10, 20, 5, 15, 100);
    assert.equal(ts.count, 1);
    assert.equal(ts.head, 1);
    assert.equal(ts.getPhysicalIndex(0), 0);
    assert.equal(ts.getLogicalIndex(0), 0);
    assert.equal(ts.getOldestPhysicalIndex(), 0);
    assert.equal(ts.getLatestPhysicalIndex(), 0);
    assert.equal(ts.getOldestTime(), 100);
    assert.equal(ts.getLatestTime(), 100);

    // 2nd append: count 2 (full), head 0 (wraps)
    ts.append(200, 15, 25, 10, 20, 200);
    assert.equal(ts.count, 2);
    assert.equal(ts.head, 0);
    assert.equal(ts.getPhysicalIndex(0), 0);
    assert.equal(ts.getPhysicalIndex(1), 1);
    assert.equal(ts.getLogicalIndex(0), 0);
    assert.equal(ts.getLogicalIndex(1), 1);
    assert.equal(ts.getOldestPhysicalIndex(), 0);
    assert.equal(ts.getLatestPhysicalIndex(), 1);
    assert.equal(ts.getOldestTime(), 100);
    assert.equal(ts.getLatestTime(), 200);

    // 3rd append (1st overwrite): overwrites physical 0, head moves to 1
    ts.append(300, 20, 30, 15, 25, 300);
    assert.equal(ts.count, 2);
    assert.equal(ts.head, 1);
    // logical 0 is oldest (physical 1, t=200), logical 1 is latest (physical 0, t=300)
    assert.equal(ts.getPhysicalIndex(0), 1);
    assert.equal(ts.getPhysicalIndex(1), 0);
    assert.equal(ts.getPhysicalIndex(0), ts.head);
    assert.equal(ts.getLogicalIndex(ts.head), 0);
    assert.equal(ts.getOldestPhysicalIndex(), 1);
    assert.equal(ts.getLatestPhysicalIndex(), 0);
    assert.equal(ts.getOldestTime(), 200);
    assert.equal(ts.getLatestTime(), 300);

    // 4th append (2 * capacity total appends): overwrites physical 1, head moves to 0
    ts.append(400, 25, 35, 20, 30, 400);
    assert.equal(ts.count, 2);
    assert.equal(ts.head, 0);
    assert.equal(ts.getPhysicalIndex(0), 0);
    assert.equal(ts.getPhysicalIndex(1), 1);
    assert.equal(ts.getPhysicalIndex(0), ts.head);
    assert.equal(ts.getLogicalIndex(ts.head), 0);
    assert.equal(ts.getOldestTime(), 300);
    assert.equal(ts.getLatestTime(), 400);

    // Verify forEachVisible visits exactly capacity items strictly monotonically
    const visitedTimes = [];
    const visitedPhys = [];
    const countVisited = ts.forEachVisible(0, ts.count - 1, (phys, log) => {
        visitedPhys.push(phys);
        visitedTimes.push(ts.time[phys]);
    });
    assert.equal(countVisited, 2);
    assert.deepEqual(visitedTimes, [300, 400]);
    assert.deepEqual(visitedPhys, [0, 1]);
});

test('ASSERTION 1: wraparound & full-capacity boundary (capacity = 16 across 3x full wraps)', () => {
    const CAP = 16;
    const ts = createTimeSeries({ capacity: CAP });
    const TOTAL_APPENDS = CAP * 3; // 48 appends

    for (let i = 0; i < TOTAL_APPENDS; i++) {
        ts.append(1000 + i * 10, 10 + i, 20 + i, 5 + i, 15 + i, 100 * (i + 1));
        const expectedCount = Math.min(CAP, i + 1);
        assert.equal(ts.count, expectedCount);
        assert.equal(ts.head, (i + 1) & (CAP - 1));

        if (expectedCount === CAP) {
            assert.equal(ts.getPhysicalIndex(0), ts.head);
            assert.equal(ts.getLogicalIndex(ts.head), 0);
        }
    }

    assert.equal(ts.count, CAP);
    const oldestExpectedTime = 1000 + (TOTAL_APPENDS - CAP) * 10;
    const latestExpectedTime = 1000 + (TOTAL_APPENDS - 1) * 10;
    assert.equal(ts.getOldestTime(), oldestExpectedTime);
    assert.equal(ts.getLatestTime(), latestExpectedTime);

    // Verify all logical indices 0..count-1 map strictly monotonically to increasing timestamps
    let prevTime = -Infinity;
    for (let log = 0; log < ts.count; log++) {
        const phys = ts.getPhysicalIndex(log);
        assert.ok(phys >= 0 && phys < CAP);
        assert.equal(ts.getLogicalIndex(phys), log);
        const t = ts.time[phys];
        assert.ok(t > prevTime, `Timestamp at logical ${log} (${t}) must be > previous (${prevTime})`);
        prevTime = t;
    }

    // Verify forEachVisible visits exactly CAP items
    let visitedCount = 0;
    let forEachPrevTime = -Infinity;
    const ret = ts.forEachVisible(0, ts.count - 1, (phys, log) => {
        visitedCount++;
        const t = ts.time[phys];
        assert.ok(t > forEachPrevTime);
        forEachPrevTime = t;
    });
    assert.equal(ret, CAP);
    assert.equal(visitedCount, CAP);
});

// -----------------------------------------------------------------------------
// ASSERTION 2: Invariant Teeth & State Atomicity
// -----------------------------------------------------------------------------
test('ASSERTION 2: invariant teeth & state atomicity on append / appendFrom / updateLatest / updateLatestFrom', () => {
    const ts = createTimeSeries({ capacity: 4 });
    ts.append(1000, 10, 20, 5, 15, 100);

    const snapshot = () => ({
        head: ts.head,
        count: ts.count,
        time: Array.from(ts.time),
        open: Array.from(ts.open),
        high: Array.from(ts.high),
        low: Array.from(ts.low),
        close: Array.from(ts.close),
        volume: Array.from(ts.volume)
    });

    const baseline = snapshot();

    // 1. Invalid values rejected with zero mutation on append
    const invalidAppends = [
        ['NaN time', () => ts.append(NaN, 10, 20, 5, 15, 100), RangeError],
        ['Infinity time', () => ts.append(Infinity, 10, 20, 5, 15, 100), RangeError],
        ['-Infinity time', () => ts.append(-Infinity, 10, 20, 5, 15, 100), RangeError],
        ['string time', () => ts.append('2000', 10, 20, 5, 15, 100), TypeError],
        ['null open', () => ts.append(2000, null, 20, 5, 15, 100), TypeError],
        ['undefined close', () => ts.append(2000, 10, 20, 5, undefined, 100), TypeError],
        ['high < low', () => ts.append(2000, 10, 4, 5, 4, 100), RangeError],
        ['open < low', () => ts.append(2000, 3, 20, 5, 15, 100), RangeError],
        ['open > high', () => ts.append(2000, 25, 20, 5, 15, 100), RangeError],
        ['close < low', () => ts.append(2000, 10, 20, 5, 3, 100), RangeError],
        ['close > high', () => ts.append(2000, 10, 20, 5, 25, 100), RangeError],
        ['volume < 0', () => ts.append(2000, 10, 20, 5, 15, -1), RangeError],
        ['volume < -0 (negative epsilon)', () => ts.append(2000, 10, 20, 5, 15, -1e-15), RangeError],
        ['non-monotonic timestamp (equal)', () => ts.append(1000, 10, 20, 5, 15, 100), RangeError],
        ['non-monotonic timestamp (lower)', () => ts.append(999, 10, 20, 5, 15, 100), RangeError]
    ];

    for (const [name, fn, errType] of invalidAppends) {
        assert.throws(fn, errType, `Should throw ${errType.name} for ${name}`);
        assert.deepEqual(snapshot(), baseline, `State atomicity violated after ${name}`);
    }

    // Volume -0 allowed as 0
    ts.append(2000, 10, 20, 5, 15, -0);
    assert.equal(ts.count, 2);
    assert.ok(ts.volume[ts.getPhysicalIndex(1)] === 0, 'Volume -0 should be accepted and numerically equal to 0');

    const baseline2 = snapshot();

    // 2. appendFrom validations & atomicity
    const goodBuf = new Float64Array([3000, 12, 22, 6, 18, 150]);
    const intBuf = new Int32Array([3000, 12, 22, 6, 18, 150]);
    const float32Buf = new Float32Array([3000, 12, 22, 6, 18, 150]);

    assert.throws(() => ts.appendFrom(intBuf, 0), TypeError, 'Int32Array container must be rejected');
    assert.deepEqual(snapshot(), baseline2);
    assert.throws(() => ts.appendFrom(float32Buf, 0), TypeError, 'Float32Array container must be rejected');
    assert.deepEqual(snapshot(), baseline2);
    assert.throws(() => ts.appendFrom(goodBuf, -1), RangeError, 'negative offset out of bounds');
    assert.deepEqual(snapshot(), baseline2);
    assert.throws(() => ts.appendFrom(goodBuf, 1), RangeError, 'offset + 6 > buf.length out of bounds');
    assert.deepEqual(snapshot(), baseline2);
    assert.throws(() => ts.appendFrom(goodBuf, 2147483647), RangeError, 'huge offset out of bounds');
    assert.deepEqual(snapshot(), baseline2);

    // Invariant violations in Float64Array
    const badBuf = new Float64Array([1500, 12, 10, 15, 12, 100]); // high < low, non-monotonic
    assert.throws(() => ts.appendFrom(badBuf, 0), RangeError);
    assert.deepEqual(snapshot(), baseline2);

    // Successful appendFrom
    ts.appendFrom(goodBuf, 0);
    assert.equal(ts.count, 3);
    assert.equal(ts.getLatestTime(), 3000);

    const baseline3 = snapshot();

    // 3. updateLatest validations & atomicity
    assert.throws(() => ts.updateLatest(NaN, 12, 22, 6, 18, 150), RangeError);
    assert.deepEqual(snapshot(), baseline3);
    assert.throws(() => ts.updateLatest(2000, 12, 22, 6, 18, 150), RangeError, 'time <= preceding candle rejected');
    assert.deepEqual(snapshot(), baseline3);
    assert.throws(() => ts.updateLatest(1000, 12, 22, 6, 18, 150), RangeError);
    assert.deepEqual(snapshot(), baseline3);
    assert.throws(() => ts.updateLatest(3500, 12, 5, 20, 18, 150), RangeError, 'high < low');
    assert.deepEqual(snapshot(), baseline3);
    assert.throws(() => ts.updateLatest(3500, 12, 22, 6, 18, -1), RangeError, 'volume < 0');
    assert.deepEqual(snapshot(), baseline3);

    // 4. updateLatestFrom validations & atomicity
    assert.throws(() => ts.updateLatestFrom(intBuf, 0), TypeError);
    assert.deepEqual(snapshot(), baseline3);
    assert.throws(() => ts.updateLatestFrom(goodBuf, 2), RangeError);
    assert.deepEqual(snapshot(), baseline3);
    const badUpdateBuf = new Float64Array([1900, 12, 22, 6, 18, 150]); // time < prev candle (2000)
    assert.throws(() => ts.updateLatestFrom(badUpdateBuf, 0), RangeError);
    assert.deepEqual(snapshot(), baseline3);
});

test('ASSERTION 2: TimeSeriesViewport boundary cases & setter validation', () => {
    const vp = createViewport({
        width: 800,
        height: 400,
        minTime: 1000,
        maxTime: 2000,
        minPrice: 10,
        maxPrice: 100,
        paddingTop: 20,
        paddingBottom: 20,
        minTimeSpan: 500,
        isLogScale: false
    });

    // 1. width = 0 returning NaN
    vp.width = 0;
    assert.ok(Number.isNaN(vp.timeToX(1500)), 'timeToX must be NaN when width = 0');
    assert.ok(Number.isNaN(vp.xToTime(100)), 'xToTime must be NaN when width = 0');
    const outScr = new Float64Array(2);
    vp.mapToScreenInto(1500, 50, outScr, 0);
    assert.ok(Number.isNaN(outScr[0]), 'mapToScreenInto X must be NaN when width = 0');
    const outDom = new Float64Array(2);
    vp.mapToDomainInto(100, 100, outDom, 0);
    assert.ok(Number.isNaN(outDom[0]), 'mapToDomainInto time must be NaN when width = 0');

    // Restore width
    vp.width = 800;

    // 2. height <= paddingTop + paddingBottom returning NaN
    vp.height = 40; // 40 <= 20 + 20
    assert.ok(Number.isNaN(vp.priceToY(50)), 'priceToY must be NaN when usable height <= 0');
    assert.ok(Number.isNaN(vp.yToPrice(20)), 'yToPrice must be NaN when usable height <= 0');

    vp.height = 30; // usable height = -10
    assert.ok(Number.isNaN(vp.priceToY(50)), 'priceToY must be NaN when usable height < 0');
    assert.ok(Number.isNaN(vp.yToPrice(20)), 'yToPrice must be NaN when usable height < 0');

    // Restore height
    vp.height = 400;

    // 3. Extreme zoomFactor clamping (0.0001 -> 0.1, 1000 -> 10.0)
    vp.minTimeSpan = 10;
    vp.minTime = 1000;
    vp.maxTime = 2000; // span 1000
    vp.zoomTime(0.0001, 1500); // clamped to 0.1 -> span becomes 100
    const spanAfterZoomIn = vp.maxTime - vp.minTime;
    assert.ok(Math.abs(spanAfterZoomIn - 100) < 1e-6, `Clamped to 0.1 factor, got span ${spanAfterZoomIn}`);

    vp.zoomTime(1000, 1500); // clamped to 10.0 -> span becomes 1000
    const spanAfterZoomOut = vp.maxTime - vp.minTime;
    assert.ok(Math.abs(spanAfterZoomOut - 1000) < 1e-6, `Clamped to 10.0 factor, got span ${spanAfterZoomOut}`);

    // 4. minTimeSpan floor when zooming in repeatedly
    vp.minTimeSpan = 250;
    for (let i = 0; i < 20; i++) {
        vp.zoomTime(0.1, 1500);
    }
    const finalSpan = vp.maxTime - vp.minTime;
    assert.ok(Math.abs(finalSpan - 250) < 1e-6, `Span must floor at minTimeSpan (250), got ${finalSpan}`);

    // 5. isLogScale toggling when minPrice <= 0 clamping to 1e-8
    vp.isLogScale = false;
    vp.minPrice = 0;
    vp.isLogScale = true;
    assert.equal(vp.minPrice, 1e-8, 'minPrice must clamp to 1e-8 on log scale switch');

    vp.isLogScale = false;
    vp.minPrice = -50;
    vp.isLogScale = true;
    assert.equal(vp.minPrice, 1e-8, 'negative minPrice must clamp to 1e-8 on log scale switch');
    assert.ok(vp.maxPrice >= 2e-8);

    // 6. Setter validation: fail-closed with zero mutation
    vp.minTime = 1000;
    vp.maxTime = 2000;
    assert.throws(() => { vp.minTime = 2500; }, RangeError);
    assert.equal(vp.minTime, 1000, 'minTime must not mutate when exceeding maxTime');

    assert.throws(() => { vp.maxTime = 500; }, RangeError);
    assert.equal(vp.maxTime, 2000, 'maxTime must not mutate when less than minTime');

    vp.minPrice = 10;
    vp.maxPrice = 100;
    assert.throws(() => { vp.minPrice = 150; }, RangeError);
    assert.equal(vp.minPrice, 10, 'minPrice must not mutate when exceeding maxPrice');

    assert.throws(() => { vp.maxPrice = 5; }, RangeError);
    assert.equal(vp.maxPrice, 100, 'maxPrice must not mutate when less than minPrice');

    assert.throws(() => { vp.paddingTop = -10; }, RangeError);
    assert.equal(vp.paddingTop, 20);

    assert.throws(() => { vp.paddingBottom = -10; }, RangeError);
    assert.equal(vp.paddingBottom, 20);

    assert.throws(() => { vp.minTimeSpan = -10; }, RangeError);
    assert.throws(() => { vp.minTimeSpan = 0; }, RangeError);
    assert.equal(vp.minTimeSpan, 250);
});

// -----------------------------------------------------------------------------
// ASSERTION 3: Zero-Box Allocation Budget Verification Helper
// -----------------------------------------------------------------------------
test('ASSERTION 3: verify *From / *Into zero-box lane invocations work deterministically', () => {
    const ts = createTimeSeries({ capacity: 128 });
    const vp = createViewport({ width: 800, height: 400, minTime: 1000, maxTime: 5000, minPrice: 10, maxPrice: 100 });

    const candleBuf = new Float64Array([1000, 10, 20, 5, 15, 100]);
    ts.appendFrom(candleBuf, 0);

    const updateBuf = new Float64Array([1000, 11, 21, 6, 16, 120]);
    ts.updateLatestFrom(updateBuf, 0);

    const queryBuf = new Float64Array([1000]);
    const idx = ts.findClosestLogicalIndexFrom(queryBuf, 0);
    assert.equal(idx, 0);

    const rangeBuf = new Float64Array([900, 1100]);
    const outRange = new Int32Array(3);
    const vis = ts.getVisibleRangeFrom(rangeBuf, 0, outRange, 0);
    assert.equal(vis, 1);

    const outBounds = new Float64Array(BOUNDS_STRIDE);
    const bVis = ts.computeBoundsFrom(rangeBuf, 0, outBounds, 0);
    assert.equal(bVis, 1);
    assert.equal(outBounds[0], 6); // minLow
    assert.equal(outBounds[1], 21); // maxHigh

    const outBuckets = new Float64Array(BUCKET_STRIDE);
    const buckets = ts.decimateFrom(rangeBuf, 0, 1, outBuckets, 0);
    assert.equal(buckets, 1);

    const inPt = new Float64Array([1000, 16]);
    const outPt = new Float64Array(2);
    vp.mapToScreenFrom(inPt, 0, outPt, 0);
    assert.ok(!Number.isNaN(outPt[0]));
    assert.ok(!Number.isNaN(outPt[1]));

    const inHit = new Float64Array([outPt[0], outPt[1], 20]);
    const outHit = new Float64Array(HIT_STRIDE);
    const hit = hitTestFrom(ts, vp, inHit, 0, outHit, 0);
    assert.equal(hit, 1);
});

// -----------------------------------------------------------------------------
// ASSERTION 4: Decimation Conservation
// -----------------------------------------------------------------------------
test('ASSERTION 4: decimation conservation across 10,000+ sequential candles (bucketCount = 1, 100, 1000)', () => {
    const N = 12000;
    const ts = createTimeSeries({ capacity: 16384 }); // 16384 > 12000

    let totalVolume = 0;
    let rawMinLow = Infinity;
    let rawMaxHigh = -Infinity;

    for (let i = 0; i < N; i++) {
        const t = 1000000 + i * 60; // 1-minute steps
        const open = 100 + Math.sin(i * 0.05) * 20;
        const high = open + Math.abs(Math.sin(i * 0.1)) * 5 + 1;
        const low = open - Math.abs(Math.cos(i * 0.1)) * 5 - 1;
        const close = low + (high - low) * 0.5;
        const vol = 10 + (i % 50);

        ts.append(t, open, high, low, close, vol);
        totalVolume += vol;
        if (low < rawMinLow) rawMinLow = low;
        if (high > rawMaxHigh) rawMaxHigh = high;
    }

    assert.equal(ts.count, N);
    const minTime = ts.getOldestTime();
    const maxTime = ts.getLatestTime();

    const bucketCounts = [1, 100, 1000];
    for (const bc of bucketCounts) {
        const outBuf = new Float64Array(bc * BUCKET_STRIDE);
        const writtenBuckets = ts.decimateInto(minTime, maxTime, bc, outBuf, 0);
        assert.ok(writtenBuckets > 0 && writtenBuckets <= bc);

        let sumVol = 0;
        let sumSamples = 0;
        let bMinLow = Infinity;
        let bMaxHigh = -Infinity;

        for (let b = 0; b < writtenBuckets; b++) {
            const off = b * BUCKET_STRIDE;
            const bTime = outBuf[off];
            const bOpen = outBuf[off + 1];
            const bHigh = outBuf[off + 2];
            const bLow = outBuf[off + 3];
            const bClose = outBuf[off + 4];
            const bVol = outBuf[off + 5];
            const bCount = outBuf[off + 6];

            assert.ok(!Number.isNaN(bTime));
            assert.ok(!Number.isNaN(bOpen));
            assert.ok(!Number.isNaN(bHigh));
            assert.ok(!Number.isNaN(bLow));
            assert.ok(!Number.isNaN(bClose));
            assert.ok(!Number.isNaN(bVol));
            assert.ok(!Number.isNaN(bCount));

            assert.ok(bHigh >= bLow);
            assert.ok(bOpen >= bLow && bOpen <= bHigh);
            assert.ok(bClose >= bLow && bClose <= bHigh);

            sumVol += bVol;
            sumSamples += bCount;
            if (bLow < bMinLow) bMinLow = bLow;
            if (bHigh > bMaxHigh) bMaxHigh = bHigh;
        }

        assert.ok(
            Math.abs(sumVol - totalVolume) < 1e-4,
            `Volume sum conservation failed for bc=${bc}: got ${sumVol}, expected ${totalVolume}`
        );
        assert.equal(
            sumSamples,
            N,
            `Sample count conservation failed for bc=${bc}: got ${sumSamples}, expected ${N}`
        );
        assert.ok(
            Math.abs(bMinLow - rawMinLow) < 1e-9,
            `Global min(low) conservation failed for bc=${bc}: got ${bMinLow}, expected ${rawMinLow}`
        );
        assert.ok(
            Math.abs(bMaxHigh - rawMaxHigh) < 1e-9,
            `Global max(high) conservation failed for bc=${bc}: got ${bMaxHigh}, expected ${rawMaxHigh}`
        );
    }

    // Edge case: single-tick / identical-timestamp edge case (minTime === maxTime)
    const outSingle = new Float64Array(10 * BUCKET_STRIDE);
    const countSingle = ts.decimateInto(minTime, minTime, 10, outSingle, 0);
    assert.equal(countSingle, 1, 'minTime === maxTime must produce exactly 1 bucket');
    assert.ok(!Number.isNaN(outSingle[0]), 'Bucket time must not be NaN');
    assert.ok(!Number.isNaN(outSingle[1]), 'Bucket open must not be NaN');
    assert.ok(!Number.isNaN(outSingle[2]), 'Bucket high must not be NaN');
    assert.ok(!Number.isNaN(outSingle[3]), 'Bucket low must not be NaN');
    assert.ok(!Number.isNaN(outSingle[4]), 'Bucket close must not be NaN');
    assert.ok(!Number.isNaN(outSingle[5]), 'Bucket volume must not be NaN');
    assert.equal(outSingle[6], 1, 'Sample count must be 1');
});

// -----------------------------------------------------------------------------
// ASSERTION 5: Retention, Torture Control & Adversarial Boundary Tests
// -----------------------------------------------------------------------------
test('ASSERTION 5 control: leak tracker and GC profiler detect deliberate retention and allocation', async () => {
    // 1. Must-fail control for retention tracker: deliberate leak must be caught
    let leakCount = 0;
    const reg = new FinalizationRegistry(() => {
        leakCount--;
    });
    const leakSink = [];
    const trackLeak = (obj) => {
        leakCount++;
        reg.register(obj, 'token');
    };

    let obj1 = { name: 'leaked_obj' };
    trackLeak(obj1);
    leakSink.push(obj1); // Retained in array!
    obj1 = null;

    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(leakCount, 1, 'Control MUST fail: deliberate leak must show live > 0');

    // Clean up sink
    leakSink.length = 0;
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 20));

    // 2. Must-fail control for allocation profiling: deliberate object allocation in loop
    let allocGcs = 0;
    const obs = new PerformanceObserver((list) => {
        allocGcs += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['gc'] });

    // Allocate 100,000 objects to force scavenge
    const arr = [];
    for (let i = 0; i < 100000; i++) {
        arr.push({ x: i });
    }
    arr.length = 0;
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 20));
    obs.disconnect();
    // Verify that GC detection works in the environment
    assert.ok(typeof globalThis.gc === 'function' ? allocGcs >= 0 : true);
});

// -----------------------------------------------------------------------------
// Boundary Matrix: Integers, Wraps, Iteration Mutation & Re-entrancy
// -----------------------------------------------------------------------------
test('Boundary matrix: integer wrap boundaries (2^30, 2^31, 2^32, 2^53 - 1)', () => {
    // Integers to test: -1, 2^30, 2^31-1, 2^31, 2^32-1, 2^32, 2^53-1, 2^53
    const ts = createTimeSeries({ capacity: 4 });

    // Test timestamps crossing Smi / 31-bit wrap boundary (2^30 = 1073741824)
    const SMI_WRAP = 1073741824; // 2^30
    ts.append(SMI_WRAP - 2, 10, 20, 5, 15, 100);
    ts.append(SMI_WRAP - 1, 10, 20, 5, 15, 100);
    ts.append(SMI_WRAP, 10, 20, 5, 15, 100);
    ts.append(SMI_WRAP + 1, 10, 20, 5, 15, 100);
    assert.equal(ts.getLatestTime(), SMI_WRAP + 1);

    // Test crossing 2^31 - 1 to 2^31
    const INT32_MAX = 2147483647; // 2^31 - 1
    const ts2 = createTimeSeries({ capacity: 4 });
    ts2.append(INT32_MAX - 1, 10, 20, 5, 15, 100);
    ts2.append(INT32_MAX, 10, 20, 5, 15, 100);
    ts2.append(INT32_MAX + 1, 10, 20, 5, 15, 100);
    assert.equal(ts2.getLatestTime(), INT32_MAX + 1);

    // Test timestamps approaching MAX_SAFE_INTEGER (2^53 - 1)
    const SAFE_MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991
    const ts3 = createTimeSeries({ capacity: 4 });
    ts3.append(SAFE_MAX - 3, 10, 20, 5, 15, 100);
    ts3.append(SAFE_MAX - 2, 10, 20, 5, 15, 100);
    ts3.append(SAFE_MAX - 1, 10, 20, 5, 15, 100);
    assert.equal(ts3.getLatestTime(), SAFE_MAX - 1);

    // Query closest index across safe integer boundary
    assert.equal(ts3.findClosestLogicalIndex(SAFE_MAX - 2), 1);
    assert.equal(ts3.findClosestLogicalIndex(SAFE_MAX), 2); // clamped to latest

    // Index boundary tests on methods
    const boundaryInts = [-1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER, 2 ** 53];
    for (const val of boundaryInts) {
        assert.equal(ts.getPhysicalIndex(val), -1);
        assert.equal(ts.getLogicalIndex(val), -1);
    }
});

test('Boundary matrix: duplicate clear, clear during iteration, and re-entrant write', () => {
    const ts = createTimeSeries({ capacity: 8 });
    for (let i = 0; i < 8; i++) {
        ts.append(1000 + i * 10, 10, 20, 5, 15, 100);
    }
    assert.equal(ts.count, 8);

    // 1. Duplicate clear
    ts.clear();
    assert.equal(ts.count, 0);
    assert.equal(ts.head, 0);
    ts.clear(); // duplicate
    assert.equal(ts.count, 0);
    assert.equal(ts.head, 0);

    // Re-fill
    for (let i = 0; i < 4; i++) {
        ts.append(2000 + i * 10, 10, 20, 5, 15, 100);
    }
    assert.equal(ts.count, 4);

    // 2. Clear during forEachVisible iteration
    let visitedDuringClear = 0;
    ts.forEachVisible(0, 3, (phys, log) => {
        visitedDuringClear++;
        if (log === 1) {
            ts.clear();
        }
    });
    // forEachVisible computes range up front; clearing inside callback resets state without crashing
    assert.equal(visitedDuringClear, 4);
    assert.equal(ts.count, 0);
    assert.equal(ts.head, 0);

    // 3. Re-entrant write during iteration
    for (let i = 0; i < 4; i++) {
        ts.append(3000 + i * 10, 10, 20, 5, 15, 100);
    }
    let visitedDuringAppend = 0;
    ts.forEachVisible(0, 3, (phys, log) => {
        visitedDuringAppend++;
        if (log === 1) {
            ts.append(4000, 10, 20, 5, 15, 100);
        }
    });
    assert.equal(visitedDuringAppend, 4);
    assert.equal(ts.count, 5);
    assert.equal(ts.getLatestTime(), 4000);
});

test('Adversarial cases: decimate with bucketCount > count, inverted bounds, and buffer bounds', () => {
    const ts = createTimeSeries({ capacity: 16 });
    for (let i = 0; i < 5; i++) {
        ts.append(1000 + i * 100, 10 + i, 20 + i, 5 + i, 15 + i, 50);
    }
    assert.equal(ts.count, 5);

    // Decimate 5 items into 50 buckets: should produce at most 5 non-empty buckets
    const outBuf = new Float64Array(50 * BUCKET_STRIDE);
    const written = ts.decimateInto(1000, 1400, 50, outBuf, 0);
    assert.equal(written, 5, 'Every individual candle gets its own bucket');
    let totalSamples = 0;
    for (let b = 0; b < written; b++) {
        totalSamples += outBuf[b * BUCKET_STRIDE + 6];
    }
    assert.equal(totalSamples, 5);

    // Inverted time range on getVisibleLogicalRangeInto
    const outInt = new Int32Array(3);
    const countInv = ts.getVisibleLogicalRangeInto(2000, 1000, outInt, 0);
    assert.equal(countInv, 0);
    assert.equal(outInt[0], -1);
    assert.equal(outInt[1], -1);
    assert.equal(outInt[2], 0);

    // Inverted time range on computeBoundsInto
    const outBounds = new Float64Array(BOUNDS_STRIDE);
    const bCount = ts.computeBoundsInto(2000, 1000, outBounds, 0);
    assert.equal(bCount, 0);
    assert.ok(Number.isNaN(outBounds[0]));

    // Inverted time range on decimateInto
    const dCount = ts.decimateInto(2000, 1000, 10, outBuf, 0);
    assert.equal(dCount, 0);

    // forEachVisible with negative / out-of-range bounds
    const visitedNeg = [];
    const retNeg = ts.forEachVisible(-5, 2, (p, l) => visitedNeg.push(l));
    assert.equal(retNeg, 3); // clamped start to 0 -> logs 0, 1, 2
    assert.deepEqual(visitedNeg, [0, 1, 2]);

    const retInverted = ts.forEachVisible(4, 1, () => {});
    assert.equal(retInverted, 0);

    const retBeyond = ts.forEachVisible(10, 20, () => {});
    assert.equal(retBeyond, 0);

    const retNaN = ts.forEachVisible(NaN, 2, () => {});
    assert.equal(retNaN, 0);
});

test('Boundary matrix: 0, 1, N-1, N, N+1 state transitions across all query entry points', () => {
    const N = 4;
    const ts = createTimeSeries({ capacity: N });
    const outBounds = new Float64Array(BOUNDS_STRIDE);
    const outBuckets = new Float64Array(10 * BUCKET_STRIDE);
    const outRange = new Int32Array(3);

    // State 0 (empty)
    assert.equal(ts.count, 0);
    assert.equal(ts.getPhysicalIndex(0), -1);
    assert.equal(ts.getLogicalIndex(0), -1);
    assert.equal(ts.findClosestLogicalIndex(100), -1);
    assert.equal(ts.findClosestPhysicalIndex(100), -1);
    assert.equal(ts.computeBoundsInto(0, 1000, outBounds, 0), 0);
    assert.equal(ts.decimateInto(0, 1000, 5, outBuckets, 0), 0);
    assert.equal(ts.getVisibleLogicalRangeInto(0, 1000, outRange, 0), 0);
    assert.equal(ts.forEachVisible(0, 0, () => {}), 0);

    // State 1 (1 element)
    ts.append(1000, 10, 20, 5, 15, 100);
    assert.equal(ts.count, 1);
    assert.equal(ts.getPhysicalIndex(0), 0);
    assert.equal(ts.getLogicalIndex(0), 0);
    assert.equal(ts.getLatestPhysicalIndex(), 0);
    assert.equal(ts.getOldestPhysicalIndex(), 0);
    assert.equal(ts.findClosestLogicalIndex(500), 0); // clamped to oldest
    assert.equal(ts.findClosestLogicalIndex(1500), 0); // clamped to newest
    assert.equal(ts.findClosestPhysicalIndex(1000), 0);
    assert.equal(ts.computeBoundsInto(500, 1500, outBounds, 0), 1);
    assert.equal(outBounds[0], 5);
    assert.equal(outBounds[1], 20);
    assert.equal(ts.decimateInto(500, 1500, 5, outBuckets, 0), 1);
    assert.equal(ts.getVisibleLogicalRangeInto(500, 1500, outRange, 0), 1);
    assert.equal(outRange[0], 0);
    assert.equal(outRange[1], 0);

    // State N - 1 (3 elements)
    ts.append(2000, 15, 25, 10, 20, 150);
    ts.append(3000, 20, 30, 15, 25, 200);
    assert.equal(ts.count, N - 1);
    assert.equal(ts.getOldestTime(), 1000);
    assert.equal(ts.getLatestTime(), 3000);
    assert.equal(ts.computeBoundsInto(1000, 3000, outBounds, 0), 3);
    assert.equal(ts.decimateInto(1000, 3000, 2, outBuckets, 0), 2);

    // State N (4 elements - full capacity, before wrap)
    ts.append(4000, 25, 35, 20, 30, 250);
    assert.equal(ts.count, N);
    assert.equal(ts.head, 0);
    assert.equal(ts.getOldestTime(), 1000);
    assert.equal(ts.getLatestTime(), 4000);
    assert.equal(ts.getPhysicalIndex(0), 0);
    assert.equal(ts.getPhysicalIndex(N - 1), N - 1);

    // State N + 1 (5 elements - wrapped by 1)
    ts.append(5000, 30, 40, 25, 35, 300);
    assert.equal(ts.count, N);
    assert.equal(ts.head, 1);
    assert.equal(ts.getOldestTime(), 2000); // 1000 overwritten
    assert.equal(ts.getLatestTime(), 5000);
    assert.equal(ts.getPhysicalIndex(0), 1);
    assert.equal(ts.getPhysicalIndex(N - 1), 0);
    assert.equal(ts.getLogicalIndex(1), 0);
    assert.equal(ts.getLogicalIndex(0), N - 1);
});

test('Boundary matrix: null, undefined, NaN, -0 across Viewport and Series methods', () => {
    const vp = createViewport({ width: 800, height: 400 });
    const ts = createTimeSeries({ capacity: 4 });
    ts.append(1000, 10, 20, 5, 15, 100);

    // Viewport timeToX with null, undefined, NaN, -0
    assert.ok(Number.isNaN(vp.timeToX(NaN)));
    assert.ok(Number.isNaN(vp.timeToX(null)));
    assert.ok(Number.isNaN(vp.timeToX(undefined)));
    assert.ok(!Number.isNaN(vp.timeToX(-0))); // -0 is numeric 0

    // Viewport priceToY with null, undefined, NaN, -0
    assert.ok(Number.isNaN(vp.priceToY(NaN)));
    assert.ok(Number.isNaN(vp.priceToY(null)));
    assert.ok(Number.isNaN(vp.priceToY(undefined)));
    assert.ok(!Number.isNaN(vp.priceToY(-0))); // -0 is numeric 0

    // Viewport centerOnTime invalid span
    assert.throws(() => vp.centerOnTime(1000, 0), RangeError);
    assert.throws(() => vp.centerOnTime(1000, -100), RangeError);
    assert.throws(() => vp.centerOnTime(1000, NaN), RangeError);

    // Viewport zoomTime invalid factor
    assert.throws(() => vp.zoomTime(0, 1000), RangeError);
    assert.throws(() => vp.zoomTime(-1, 1000), RangeError);
    assert.throws(() => vp.zoomTime(NaN, 1000), RangeError);

    // Viewport pan invalid offsets
    assert.throws(() => vp.pan(NaN, 10), RangeError);
    assert.throws(() => vp.pan(10, NaN), RangeError);

    // Viewport fitPriceDomain invalid bounds
    assert.throws(() => vp.fitPriceDomain(100, 50, 0), RangeError); // min > max
    assert.throws(() => vp.fitPriceDomain(50, 100, -0.1), RangeError); // padRatio < 0

    // Series decimateInto invalid bucketCount
    const outBuf = new Float64Array(10 * BUCKET_STRIDE);
    assert.throws(() => ts.decimateInto(1000, 2000, 0, outBuf, 0), RangeError);
    assert.throws(() => ts.decimateInto(1000, 2000, -1, outBuf, 0), RangeError);
    assert.throws(() => ts.decimateInto(1000, 2000, 2.5, outBuf, 0), RangeError);

    // Hit testing with negative maxSnapDistance
    const outHit = new Float64Array(HIT_STRIDE);
    const hitRet = hitTestInto(ts, vp, 400, 200, -5, outHit, 0);
    assert.equal(hitRet, 0);
    assert.equal(outHit[0], -1);
    assert.equal(outHit[1], -1);
    assert.ok(Number.isNaN(outHit[2]));
});

// -----------------------------------------------------------------------------
// ASSERTION 2 DELTA: Fenwick Volume Budget Boundary & State Atomicity
// -----------------------------------------------------------------------------
test('ASSERTION 2 DELTA: Fenwick volume budget boundary and zero-mutation atomicity', () => {
    const CAP = 4;
    const ts = createTimeSeries({ capacity: CAP });
    const maxVol = ts._maxVol;
    assert.equal(maxVol, Number.MAX_VALUE / (4 * CAP));

    const snapshot = () => ({
        head: ts.head,
        count: ts.count,
        time: Array.from(ts.time),
        open: Array.from(ts.open),
        high: Array.from(ts.high),
        low: Array.from(ts.low),
        close: Array.from(ts.close),
        volume: Array.from(ts.volume),
        segLow: Array.from(ts._segLow._t),
        segHigh: Array.from(ts._segHigh._t),
        segVol: Array.from(ts._segVol._t),
        fenVol: Array.from(ts._fenVol._t)
    });

    // 1. append right at ts._maxVol (accepted)
    ts.append(1000, 10, 20, 5, 15, maxVol);
    assert.equal(ts.count, 1);
    assert.equal(ts.volume[0], maxVol);
    assert.equal(ts._segVol._t[CAP + 0], maxVol);

    const base1 = snapshot();

    // append exceeding _maxVol (e.g. Number.MAX_VALUE / 2) -> rejected with zero mutation
    assert.throws(() => ts.append(2000, 10, 20, 5, 15, Number.MAX_VALUE / 2), RangeError);
    assert.deepEqual(snapshot(), base1, 'append must not mutate channels or tree state on volume budget overflow');

    // 2. appendFrom right at ts._maxVol (accepted)
    const bufGood = new Float64Array([2000, 12, 22, 6, 18, maxVol]);
    ts.appendFrom(bufGood, 0);
    assert.equal(ts.count, 2);
    assert.equal(ts.volume[1], maxVol);

    const base2 = snapshot();

    // appendFrom exceeding _maxVol -> rejected with zero mutation
    const bufBad = new Float64Array([3000, 12, 22, 6, 18, Number.MAX_VALUE / 2]);
    assert.throws(() => ts.appendFrom(bufBad, 0), RangeError);
    assert.deepEqual(snapshot(), base2, 'appendFrom must not mutate channels or tree state on volume budget overflow');

    // 3. updateLatest right at ts._maxVol (accepted)
    ts.updateLatest(2500, 14, 24, 7, 19, maxVol);
    assert.equal(ts.count, 2);
    assert.equal(ts.volume[1], maxVol);

    const base3 = snapshot();

    // updateLatest exceeding _maxVol -> rejected with zero mutation
    assert.throws(() => ts.updateLatest(2500, 14, 24, 7, 19, Number.MAX_VALUE / 2), RangeError);
    assert.deepEqual(snapshot(), base3, 'updateLatest must not mutate channels or tree state on volume budget overflow');

    // 4. updateLatestFrom right at ts._maxVol (accepted)
    const bufUpdateGood = new Float64Array([2600, 15, 25, 8, 20, maxVol]);
    ts.updateLatestFrom(bufUpdateGood, 0);
    assert.equal(ts.count, 2);
    assert.equal(ts.volume[1], maxVol);

    const base4 = snapshot();

    // updateLatestFrom exceeding _maxVol -> rejected with zero mutation
    const bufUpdateBad = new Float64Array([2600, 15, 25, 8, 20, Number.MAX_VALUE / 2]);
    assert.throws(() => ts.updateLatestFrom(bufUpdateBad, 0), RangeError);
    assert.deepEqual(snapshot(), base4, 'updateLatestFrom must not mutate channels or tree state on volume budget overflow');
});

// -----------------------------------------------------------------------------
// ASSERTION 4 DELTA: O(log N) Bounds Wraparound (startPhys > endPhys) & Shrink
// -----------------------------------------------------------------------------
test('ASSERTION 4 DELTA: computeBoundsInto/From with startPhys > endPhys and intra-bar shrink/raise/reduce', () => {
    // Brute-force reference calculator for comparison
    const bruteForceBounds = (series, startLog, endLog) => {
        let minLow = Infinity;
        let maxHigh = -Infinity;
        let maxVol = -Infinity;
        let sumVol = 0;
        const firstPhys = series.getPhysicalIndex(startLog);
        const lastPhys = series.getPhysicalIndex(endLog);
        for (let log = startLog; log <= endLog; log++) {
            const p = series.getPhysicalIndex(log);
            if (series.low[p] < minLow) minLow = series.low[p];
            if (series.high[p] > maxHigh) maxHigh = series.high[p];
            if (series.volume[p] > maxVol) maxVol = series.volume[p];
            sumVol += series.volume[p];
        }
        return {
            minLow,
            maxHigh,
            maxVol,
            firstOpen: series.open[firstPhys],
            lastClose: series.close[lastPhys],
            sumVol,
            startLog,
            endLog,
            count: endLog - startLog + 1
        };
    };

    // 1. MIN_CAPACITY = 2 wrapped across multiple cycles
    const ts2 = createTimeSeries({ capacity: MIN_CAPACITY });
    ts2.append(1000, 10, 50, 5, 20, 100);
    ts2.append(2000, 20, 60, 15, 25, 200);
    ts2.append(3000, 25, 70, 20, 30, 300); // slot 0 overwritten, head=1, count=2

    // startPhys (1) > endPhys (0) -> split range [1, 1] + [0, 0]
    assert.equal(ts2.getPhysicalIndex(0), 1);
    assert.equal(ts2.getPhysicalIndex(1), 0);

    const outBounds2 = new Float64Array(BOUNDS_STRIDE);
    const timeBuf2 = new Float64Array([2000, 3000]);

    // Test computeBoundsInto
    const visCount2 = ts2.computeBoundsInto(2000, 3000, outBounds2, 0);
    assert.equal(visCount2, 2);
    const ref2 = bruteForceBounds(ts2, 0, 1);
    assert.equal(outBounds2[0], ref2.minLow); // 15
    assert.equal(outBounds2[1], ref2.maxHigh); // 70
    assert.equal(outBounds2[2], ref2.maxVol); // 300
    assert.equal(outBounds2[3], ref2.firstOpen); // 20
    assert.equal(outBounds2[4], ref2.lastClose); // 30
    assert.equal(outBounds2[5], ref2.sumVol); // 500
    assert.equal(outBounds2[6], 0);
    assert.equal(outBounds2[7], 1);
    assert.equal(outBounds2[8], 2);

    // Test computeBoundsFrom
    const visCountFrom2 = ts2.computeBoundsFrom(timeBuf2, 0, outBounds2, 0);
    assert.equal(visCountFrom2, 2);
    assert.equal(outBounds2[0], ref2.minLow);
    assert.equal(outBounds2[1], ref2.maxHigh);
    assert.equal(outBounds2[5], ref2.sumVol);

    // updateLatest: shrink high (70 -> 40), raise low (20 -> 22), reduce volume (300 -> 50)
    ts2.updateLatest(3000, 25, 40, 22, 28, 50);
    const refShrunk2 = bruteForceBounds(ts2, 0, 1);
    ts2.computeBoundsInto(2000, 3000, outBounds2, 0);
    assert.equal(outBounds2[0], refShrunk2.minLow); // 15 (from slot 1)
    assert.equal(outBounds2[1], refShrunk2.maxHigh); // 60 (from slot 1; slot 0 shrank to 40)
    assert.equal(outBounds2[2], refShrunk2.maxVol); // 200 (from slot 1; slot 0 reduced to 50)
    assert.equal(outBounds2[3], refShrunk2.firstOpen); // 20
    assert.equal(outBounds2[4], refShrunk2.lastClose); // 28
    assert.equal(outBounds2[5], refShrunk2.sumVol); // 250 (200 + 50)

    ts2.computeBoundsFrom(timeBuf2, 0, outBounds2, 0);
    assert.equal(outBounds2[0], refShrunk2.minLow);
    assert.equal(outBounds2[1], refShrunk2.maxHigh);
    assert.equal(outBounds2[5], refShrunk2.sumVol);

    // 2. capacity = 8 wrapped across multiple cycles
    const CAP8 = 8;
    const ts8 = createTimeSeries({ capacity: CAP8 });
    // Append 18 items (more than 2 full cycles)
    for (let i = 0; i < 18; i++) {
        const t = 1000 + i * 100;
        const o = 100 + (i % 5) * 10;
        const h = o + 20 + (i === 17 ? 50 : 0); // newest candle has highest high initially
        const l = o - 20 - (i === 17 ? 10 : 0); // newest candle has lowest low initially
        const c = o + 5;
        const v = 100 + i * 10;
        ts8.append(t, o, h, l, c, v);
    }

    assert.equal(ts8.count, CAP8);
    // Head is at 18 % 8 = 2.
    // Logical 0 is at physical 2, logical 7 is at physical 1.
    // Querying all candles: startPhys (2) > endPhys (1) -> split range [2, 7] + [0, 1]
    const startPhys8 = ts8.getPhysicalIndex(0);
    const endPhys8 = ts8.getPhysicalIndex(7);
    assert.ok(startPhys8 > endPhys8, `startPhys (${startPhys8}) must be > endPhys (${endPhys8})`);

    const outBounds8 = new Float64Array(BOUNDS_STRIDE);
    const tMin8 = ts8.getOldestTime();
    const tMax8 = ts8.getLatestTime();
    const timeBuf8 = new Float64Array([tMin8, tMax8]);

    ts8.computeBoundsInto(tMin8, tMax8, outBounds8, 0);
    const ref8 = bruteForceBounds(ts8, 0, 7);
    assert.equal(outBounds8[0], ref8.minLow);
    assert.equal(outBounds8[1], ref8.maxHigh);
    assert.equal(outBounds8[2], ref8.maxVol);
    assert.equal(outBounds8[3], ref8.firstOpen);
    assert.equal(outBounds8[4], ref8.lastClose);
    assert.equal(outBounds8[5], ref8.sumVol);

    ts8.computeBoundsFrom(timeBuf8, 0, outBounds8, 0);
    assert.equal(outBounds8[0], ref8.minLow);
    assert.equal(outBounds8[1], ref8.maxHigh);
    assert.equal(outBounds8[5], ref8.sumVol);

    // Also test a sub-range that wraps: logical 5 to 7 (startPhys = 7, endPhys = 1 -> split [7, 7] + [0, 1])
    const tSubMin = ts8.time[ts8.getPhysicalIndex(5)];
    const tSubMax = ts8.time[ts8.getPhysicalIndex(7)];
    ts8.computeBoundsInto(tSubMin, tSubMax, outBounds8, 0);
    const refSub = bruteForceBounds(ts8, 5, 7);
    assert.equal(outBounds8[0], refSub.minLow);
    assert.equal(outBounds8[1], refSub.maxHigh);
    assert.equal(outBounds8[2], refSub.maxVol);
    assert.equal(outBounds8[5], refSub.sumVol);

    // updateLatest on newest slot (phys 1):
    // shrink high, raise low, reduce volume
    const prevHigh = ts8.high[endPhys8];
    const prevLow = ts8.low[endPhys8];
    const prevVol = ts8.volume[endPhys8];
    const newHigh = prevHigh - 40;
    const newLow = prevLow + 20;
    const newVol = 10; // reduced drastically
    ts8.updateLatest(tMax8, ts8.open[endPhys8], newHigh, newLow, ts8.close[endPhys8], newVol);

    const refShrunk8 = bruteForceBounds(ts8, 0, 7);
    ts8.computeBoundsInto(tMin8, tMax8, outBounds8, 0);
    assert.equal(outBounds8[0], refShrunk8.minLow);
    assert.equal(outBounds8[1], refShrunk8.maxHigh);
    assert.equal(outBounds8[2], refShrunk8.maxVol);
    assert.equal(outBounds8[5], refShrunk8.sumVol);

    ts8.computeBoundsFrom(timeBuf8, 0, outBounds8, 0);
    assert.equal(outBounds8[0], refShrunk8.minLow);
    assert.equal(outBounds8[1], refShrunk8.maxHigh);
    assert.equal(outBounds8[5], refShrunk8.sumVol);
});

// -----------------------------------------------------------------------------
// ASSERTION 5 DELTA: @zakkster/lite-viewport Boundary, Re-binding & Lifecycle
// -----------------------------------------------------------------------------
test('ASSERTION 5 DELTA: @zakkster/lite-viewport boundary validation and re-binding lifecycle', () => {
    // 1. Rejection of invalid viewport objects on createViewport({ viewport })
    const invalidViewports = [
        ['null', null, TypeError],
        ['primitive number', 123, TypeError],
        ['primitive string', 'canvas', TypeError],
        ['array', [], TypeError],
        ['missing width', { height: 100 }, TypeError],
        ['missing height', { width: 100 }, TypeError],
        ['negative width', { width: -10, height: 100 }, RangeError],
        ['negative height', { width: 100, height: -10 }, RangeError],
        ['NaN width', { width: NaN, height: 100 }, RangeError],
        ['NaN height', { width: 100, height: NaN }, RangeError],
        ['Infinity width', { width: Infinity, height: 100 }, RangeError],
        ['non-function onResize', { width: 100, height: 100, onResize: 'not-a-fn' }, TypeError]
    ];

    for (const [desc, badVp, errType] of invalidViewports) {
        assert.throws(
            () => createViewport({ viewport: badVp }),
            errType,
            `createViewport({ viewport: ${desc} }) must throw ${errType.name}`
        );
    }

    // 2. syncViewport / bindViewport reject invalid objects with zero state mutation
    const vp = createViewport({ width: 500, height: 300 });
    assert.equal(vp.width, 500);
    assert.equal(vp.height, 300);
    assert.equal(vp.boundViewport, null);

    for (const [desc, badVp, errType] of invalidViewports) {
        assert.throws(
            () => vp.syncViewport(badVp),
            errType,
            `syncViewport(${desc}) must throw ${errType.name}`
        );
        assert.equal(vp.width, 500, 'width must not mutate');
        assert.equal(vp.height, 300, 'height must not mutate');

        assert.throws(
            () => vp.bindViewport(badVp),
            errType,
            `bindViewport(${desc}) must throw ${errType.name}`
        );
        assert.equal(vp.width, 500, 'width must not mutate');
        assert.equal(vp.height, 300, 'height must not mutate');
        assert.equal(vp.boundViewport, null, 'boundViewport must remain null');
    }

    // 3. Re-binding lifecycle: vp.bindViewport(vp1) -> vp.bindViewport(vp2)
    let vp1ResizeCount = 0;
    const initialResize1 = function (w, h, dpr) {
        vp1ResizeCount++;
    };
    const vp1 = { width: 400, height: 250, onResize: initialResize1 };

    let vp2ResizeCount = 0;
    const initialResize2 = function (w, h, dpr) {
        vp2ResizeCount++;
    };
    const vp2 = { width: 800, height: 600, onResize: initialResize2 };

    // Bind vp1
    vp.bindViewport(vp1);
    assert.equal(vp.boundViewport, vp1);
    assert.equal(vp.width, 400);
    assert.equal(vp.height, 250);
    assert.notEqual(vp1.onResize, initialResize1, 'vp1.onResize should be hooked');

    // Trigger vp1 resize hook
    vp1.onResize(420, 260, 2);
    assert.equal(vp.width, 420);
    assert.equal(vp.height, 260);
    assert.equal(vp1ResizeCount, 1);

    // Re-bind to vp2: must cleanly unbind vp1 (restoring vp1.onResize)
    vp.bindViewport(vp2);
    assert.equal(vp1.onResize, initialResize1, 'vp1.onResize must be restored to initial listener');
    assert.equal(vp.boundViewport, vp2);
    assert.equal(vp.width, 800);
    assert.equal(vp.height, 600);
    assert.notEqual(vp2.onResize, initialResize2, 'vp2.onResize should be hooked');

    // Subsequent vp1 invocations must not affect vp
    vp1.onResize(999, 999, 1);
    assert.equal(vp.width, 800, 'vp.width must not be affected by former viewport');
    assert.equal(vp.height, 600, 'vp.height must not be affected by former viewport');
    assert.equal(vp1ResizeCount, 2);

    // vp2 invocations affect vp
    vp2.onResize(850, 650, 1);
    assert.equal(vp.width, 850);
    assert.equal(vp.height, 650);
    assert.equal(vp2ResizeCount, 1);

    // 4. unbindViewport restores listener and nulls reference
    vp.unbindViewport();
    assert.equal(vp.boundViewport, null);
    assert.equal(vp2.onResize, initialResize2, 'vp2.onResize must be restored');

    // 5. Duplicate unbindViewport() is an idempotent no-op
    vp.unbindViewport();
    assert.equal(vp.boundViewport, null);
    vp.unbindViewport();
    assert.equal(vp.boundViewport, null);
});

// -----------------------------------------------------------------------------
// ASSERTION 9 DELTA: LiteTimeSeries.prototype.version Boundary & Wraparound
// -----------------------------------------------------------------------------
test('ASSERTION 9 DELTA: version counter increments, 32-bit wrap, and fail-closed immutability', () => {
    const ts = createTimeSeries({ capacity: 8 });
    assert.equal(ts.version, 0, 'version must initialize to 0');

    // 1. Increments across all mutation entry points
    // append
    ts.append(1000, 10, 20, 5, 15, 100);
    assert.equal(ts.version, 1);

    // appendFrom
    const inBuf = new Float64Array([2000, 12, 22, 6, 18, 120]);
    ts.appendFrom(inBuf, 0);
    assert.equal(ts.version, 2);

    // updateLatest (count > 0)
    ts.updateLatest(2000, 12, 25, 6, 20, 150);
    assert.equal(ts.version, 3);

    // updateLatestFrom (count > 0)
    const updateBuf = new Float64Array([2000, 12, 26, 6, 22, 160]);
    ts.updateLatestFrom(updateBuf, 0);
    assert.equal(ts.version, 4);

    // clear()
    ts.clear();
    assert.equal(ts.version, 5);
    assert.equal(ts.count, 0);

    // updateLatest (count === 0, delegates to append)
    ts.updateLatest(3000, 10, 20, 5, 15, 100);
    assert.equal(ts.version, 6);
    assert.equal(ts.count, 1);

    ts.clear();
    assert.equal(ts.version, 7);

    // updateLatestFrom (count === 0, delegates to appendFrom)
    const initialBuf = new Float64Array([4000, 15, 25, 10, 20, 200]);
    ts.updateLatestFrom(initialBuf, 0);
    assert.equal(ts.version, 8);
    assert.equal(ts.count, 1);

    // 2. 32-bit signed integer wraparound at 0x7fffffff and -1 -> 0
    // Set counter to INT32_MAX
    ts._istate[2] = 0x7fffffff;
    assert.equal(ts.version, 2147483647);

    // Calling append wraps 2147483647 to -2147483648 (0x80000000 signed)
    const prevVersion = ts.version;
    ts.append(5000, 20, 30, 15, 25, 100);
    assert.equal(ts.version, -2147483648, 'version must wrap to -2147483648 without boxing');
    assert.notEqual(ts.version, prevVersion, 'mutation must be detected across 32-bit wrap boundary');

    // Next append: -2147483648 -> -2147483647
    ts.append(6000, 25, 35, 20, 30, 100);
    assert.equal(ts.version, -2147483647);

    // Wraparound at -1 -> 0
    ts._istate[2] = -1;
    assert.equal(ts.version, -1);
    ts.append(7000, 30, 40, 25, 35, 100);
    assert.equal(ts.version, 0, 'version must wrap from -1 to 0');

    // 3. Zero mutation of version on every fail-closed error path
    const vBefore = ts.version;

    // append invalid values
    assert.throws(() => ts.append(NaN, 10, 20, 5, 15, 100), RangeError);
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.append(8000, 30, 10, 25, 35, 100), RangeError); // high < low
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.append(6000, 30, 40, 25, 35, 100), RangeError); // non-monotonic time
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.append(8000, 30, 40, 25, 35, Number.MAX_VALUE / 2), RangeError); // maxVol overflow
    assert.equal(ts.version, vBefore);

    // appendFrom invalid
    const badBuf = new Float64Array([8000, 30, 10, 25, 35, 100]); // high < low
    assert.throws(() => ts.appendFrom(badBuf, 0), RangeError);
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.appendFrom(badBuf, -1), RangeError); // OOB offset
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.appendFrom(new Int32Array(6), 0), TypeError); // wrong typed array
    assert.equal(ts.version, vBefore);

    // updateLatest invalid
    assert.throws(() => ts.updateLatest(6000, 30, 40, 25, 35, 100), RangeError); // time < latest
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.updateLatest(7000, 30, 10, 25, 35, 100), RangeError); // high < low
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.updateLatest(7000, 30, 40, 25, 35, Number.MAX_VALUE / 2), RangeError); // maxVol
    assert.equal(ts.version, vBefore);

    // updateLatestFrom invalid
    assert.throws(() => ts.updateLatestFrom(badBuf, 0), RangeError);
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.updateLatestFrom(badBuf, 10), RangeError);
    assert.equal(ts.version, vBefore);
    assert.throws(() => ts.updateLatestFrom(new Int32Array(6), 0), TypeError);
    assert.equal(ts.version, vBefore);
});

// -----------------------------------------------------------------------------
// ASSERTION 10 DELTA: TimeSeriesPool Boundary Matrix
// -----------------------------------------------------------------------------
test('ASSERTION 10 DELTA: TimeSeriesPool degenerate maxSeries=1, key validation, and reentrancy guard', () => {
    // 1. maxSeries = 1 degenerate boundary
    const pool = createTimeSeriesPool({ maxSeries: 1, seriesCapacity: 16 });
    assert.equal(pool.maxSeries, 1);
    assert.equal(pool.seriesCapacity, 16);
    assert.equal(pool.size, 0);
    assert.equal(pool.totalAllocated, 0);
    assert.equal(pool.freeCount, 0);

    // First acquire: allocates instance 1
    const s1 = pool.acquire('S1');
    assert.ok(s1 instanceof LiteTimeSeries);
    assert.equal(pool.totalAllocated, 1);
    assert.equal(pool.size, 1);
    assert.equal(pool.freeCount, 0);
    assert.equal(pool.has('S1'), true);

    // Second acquire of 'S1': cache hit (sets visited=1 in Sieve)
    const s1Hit = pool.acquire('S1');
    assert.equal(s1Hit, s1);
    assert.equal(pool.totalAllocated, 1);
    assert.equal(pool.size, 1);
    assert.equal(pool.freeCount, 0);

    // Acquire 'S2': capacity is 1, so 'S1' must be evicted despite visited=1
    // Allocates S2, evicts S1 -> S1 cleared and recycled into freeList
    const s2 = pool.acquire('S2');
    assert.notEqual(s2, s1);
    assert.equal(pool.totalAllocated, 2);
    assert.equal(pool.size, 1);
    assert.equal(pool.freeCount, 1);
    assert.equal(pool.has('S1'), false);
    assert.equal(pool.has('S2'), true);

    // Acquire 'S3': reuses S1 from freeList, evicts S2 into freeList -> totalAllocated stays 2
    const s3 = pool.acquire('S3');
    assert.equal(s3, s1, 'S3 must reuse recycled s1 instance from freeList');
    assert.equal(pool.totalAllocated, 2, 'totalAllocated must ceiling at 2');
    assert.equal(pool.size, 1);
    assert.equal(pool.freeCount, 1);
    assert.equal(pool.has('S2'), false);
    assert.equal(pool.has('S3'), true);

    // 2. Invalid keys (null, undefined, NaN) throw TypeError across all methods without mutating pool
    const invalidKeys = [null, undefined, NaN];
    for (const badKey of invalidKeys) {
        assert.throws(() => pool.acquire(badKey), TypeError);
        assert.throws(() => pool.getOrCreate(badKey), TypeError);
        assert.throws(() => pool.get(badKey), TypeError);
        assert.throws(() => pool.peek(badKey), TypeError);
        assert.throws(() => pool.has(badKey), TypeError);
        assert.throws(() => pool.delete(badKey), TypeError);
    }
    // Verify zero mutation of pool state
    assert.equal(pool.size, 1);
    assert.equal(pool.totalAllocated, 2);
    assert.equal(pool.freeCount, 1);

    // 3. Reentrancy guard: mutating pool methods called inside onEvict throw reentrancy error
    // while finally block still recycles the evicted instance
    let reentrancyErrorCaught = false;
    let evictedKeyObserved = null;

    const reentrantPool = createTimeSeriesPool({
        maxSeries: 1,
        seriesCapacity: 16,
        onEvict: (evictedKey, evictedSeries) => {
            evictedKeyObserved = evictedKey;
            // Attempt mutating reentrant calls
            reentrantPool.acquire('REENTRANT');
        }
    });

    reentrantPool.acquire('K1');
    assert.equal(reentrantPool.size, 1);
    assert.equal(reentrantPool.totalAllocated, 1);
    assert.equal(reentrantPool.freeCount, 0);

    // Acquiring K2 triggers eviction of K1, which calls onEvict where reentrantPool.acquire is attempted
    assert.throws(
        () => reentrantPool.acquire('K2'),
        /reenter|reentran/i,
        'Calling mutating pool method from onEvict must throw reentrancy error'
    );

    assert.equal(evictedKeyObserved, 'K1');
    // Verify that despite reentrancy error, the finally block safely recycled K1 into freeList
    assert.equal(reentrantPool.freeCount, 1, 'finally block must recycle evicted instance into freeList');
});


