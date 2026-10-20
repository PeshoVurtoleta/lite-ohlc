// test/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

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

test('constants contract', () => {
    assert.equal(VERSION, '1.0.0');
    assert.equal(DEFAULT_CAPACITY, 65536);
    assert.equal(MIN_CAPACITY, 2);
    assert.equal(MAX_CAPACITY, 4194304);
    assert.equal(BOUNDS_STRIDE, 9);
    assert.equal(BUCKET_STRIDE, 7);
    assert.equal(HIT_STRIDE, 14);
});

test('LiteTimeSeries options validation', () => {
    // undefined allowed
    const tsDefault = createTimeSeries();
    assert.equal(tsDefault.capacity, DEFAULT_CAPACITY);

    const tsCustom = createTimeSeries({ capacity: 1024 });
    assert.equal(tsCustom.capacity, 1024);

    // non-plain object
    assert.throws(() => createTimeSeries(null), TypeError);
    assert.throws(() => createTimeSeries([]), TypeError);
    assert.throws(() => createTimeSeries(123), TypeError);

    // symbol property
    assert.throws(() => createTimeSeries({ [Symbol('cap')]: 1024 }), TypeError);

    // unknown option with did-you-mean suggestion
    assert.throws(
        () => createTimeSeries({ capaciti: 1024 }),
        /Did you mean "capacity"\?/
    );

    // capacity validations
    assert.throws(() => createTimeSeries({ capacity: '1024' }), TypeError);
    assert.throws(() => createTimeSeries({ capacity: 1 }), RangeError);
    assert.throws(() => createTimeSeries({ capacity: 3 }), RangeError); // not power of 2
    assert.throws(() => createTimeSeries({ capacity: MAX_CAPACITY * 2 }), RangeError);
});

test('TimeSeriesViewport options validation', () => {
    // undefined allowed
    const vpDefault = createViewport();
    assert.equal(vpDefault.width, 0);
    assert.equal(vpDefault.height, 0);
    assert.equal(vpDefault.minTime, 0);
    assert.equal(vpDefault.maxTime, 1000);
    assert.equal(vpDefault.minPrice, 0);
    assert.equal(vpDefault.maxPrice, 100);
    assert.equal(vpDefault.isLogScale, false);

    // did-you-mean on unknown key
    assert.throws(
        () => createViewport({ widht: 800 }),
        /Did you mean "width"\?/
    );

    // type & range errors
    assert.throws(() => createViewport({ isLogScale: 'true' }), TypeError);
    assert.throws(() => createViewport({ width: -10 }), RangeError);
    assert.throws(() => createViewport({ minTimeSpan: 0 }), RangeError);
    assert.throws(() => createViewport({ minTime: 500, maxTime: 400 }), RangeError);
    assert.throws(() => createViewport({ minPrice: 100, maxPrice: 50 }), RangeError);
    assert.throws(() => createViewport({ isLogScale: true, minPrice: 0 }), RangeError);
});

test('LiteTimeSeries ingestion and candle invariants', () => {
    const ts = createTimeSeries({ capacity: 4 });

    // Initial state
    assert.equal(ts.count, 0);
    assert.equal(ts.head, 0);
    assert.ok(Number.isNaN(ts.getLatestTime()));
    assert.ok(Number.isNaN(ts.getOldestTime()));

    // Successful append
    ts.append(1000, 10, 20, 5, 15, 100);
    assert.equal(ts.count, 1);
    assert.equal(ts.head, 1);
    assert.equal(ts.getLatestTime(), 1000);
    assert.equal(ts.getOldestTime(), 1000);

    // Invalid candle: high < low
    assert.throws(() => ts.append(2000, 10, 4, 5, 8, 50), RangeError);

    // Invalid candle: open > high
    assert.throws(() => ts.append(2000, 25, 20, 5, 15, 50), RangeError);

    // Invalid candle: close < low
    assert.throws(() => ts.append(2000, 10, 20, 5, 2, 50), RangeError);

    // Invalid candle: volume < 0
    assert.throws(() => ts.append(2000, 10, 20, 5, 15, -1), RangeError);

    // Invalid candle: non-finite
    assert.throws(() => ts.append(2000, NaN, 20, 5, 15, 10), RangeError);

    // Non-monotonic time: equal or lesser
    assert.throws(() => ts.append(1000, 10, 20, 5, 15, 100), RangeError);
    assert.throws(() => ts.append(900, 10, 20, 5, 15, 100), RangeError);

    // AppendFrom
    const buf = new Float64Array([2000, 12, 22, 6, 18, 200]);
    ts.appendFrom(buf, 0);
    assert.equal(ts.count, 2);
    assert.equal(ts.getLatestTime(), 2000);
});

test('LiteTimeSeries ring buffer wrapping and indexing', () => {
    const ts = createTimeSeries({ capacity: 4 });
    // Append 6 items into cap 4
    for (let i = 1; i <= 6; i++) {
        ts.append(i * 1000, 10, 20, 5, 15, i * 10);
    }
    assert.equal(ts.count, 4);
    assert.equal(ts.head, 2); // 6 % 4 = 2

    // Oldest is tick 3 (time 3000), latest is tick 6 (time 6000)
    assert.equal(ts.getOldestTime(), 3000);
    assert.equal(ts.getLatestTime(), 6000);

    // Logical index 0 is oldest (tick 3), logical index 3 is newest (tick 6)
    assert.equal(ts.time[ts.getPhysicalIndex(0)], 3000);
    assert.equal(ts.time[ts.getPhysicalIndex(3)], 6000);
    assert.equal(ts.getLogicalIndex(ts.getPhysicalIndex(0)), 0);
    assert.equal(ts.getLogicalIndex(ts.getPhysicalIndex(3)), 3);

    // Out of bounds indexing
    assert.equal(ts.getPhysicalIndex(-1), -1);
    assert.equal(ts.getPhysicalIndex(4), -1);
    assert.equal(ts.getLogicalIndex(4), -1);
});

test('LiteTimeSeries updateLatest semantics', () => {
    const ts = createTimeSeries({ capacity: 4 });

    // On empty series delegates to append
    ts.updateLatest(1000, 10, 20, 5, 15, 50);
    assert.equal(ts.count, 1);
    assert.equal(ts.getLatestTime(), 1000);

    // Count 1: time >= oldest
    ts.updateLatest(1000, 11, 22, 5, 16, 60);
    assert.equal(ts.count, 1);
    assert.equal(ts.close[ts.getLatestPhysicalIndex()], 16);

    ts.append(2000, 15, 25, 10, 20, 100);
    assert.equal(ts.count, 2);

    // Count 2: time > prevTime (1000)
    ts.updateLatest(2000, 15, 28, 10, 25, 150);
    assert.equal(ts.high[ts.getLatestPhysicalIndex()], 28);

    // Monotonicity violation on updateLatest: cannot be <= prevTime (1000)
    assert.throws(() => ts.updateLatest(1000, 15, 28, 10, 25, 150), RangeError);
    assert.throws(() => ts.updateLatest(900, 15, 28, 10, 25, 150), RangeError);

    // UpdateLatestFrom
    const uBuf = new Float64Array([2100, 16, 30, 12, 26, 160]);
    ts.updateLatestFrom(uBuf, 0);
    assert.equal(ts.getLatestTime(), 2100);
});

test('LiteTimeSeries search and visible range', () => {
    const ts = createTimeSeries({ capacity: 8 });
    const times = [100, 200, 300, 400, 500, 600];
    times.forEach(t => ts.append(t, 10, 20, 5, 15, 10));

    // Exact matches
    assert.equal(ts.findClosestLogicalIndex(300), 2);
    assert.equal(ts.findClosestLogicalIndex(100), 0);
    assert.equal(ts.findClosestLogicalIndex(600), 5);

    // Clamp outer
    assert.equal(ts.findClosestLogicalIndex(50), 0);
    assert.equal(ts.findClosestLogicalIndex(700), 5);

    // Nearest tie-breaker: 250 is equidistant to 200 and 300 -> favors older (200, logical 1)
    assert.equal(ts.findClosestLogicalIndex(250), 1);
    assert.equal(ts.findClosestLogicalIndex(251), 2);
    assert.equal(ts.findClosestLogicalIndex(249), 1);

    // Visible range
    const outRange = new Int32Array(3);
    const visCount = ts.getVisibleLogicalRangeInto(200, 500, outRange, 0);
    assert.equal(visCount, 4);
    assert.equal(outRange[0], 1); // logical start
    assert.equal(outRange[1], 4); // logical end
    assert.equal(outRange[2], 4); // count

    // forEachVisible
    const visited = [];
    const countVisited = ts.forEachVisible(1, 4, (phys, log) => {
        visited.push(log);
    });
    assert.equal(countVisited, 4);
    assert.deepEqual(visited, [1, 2, 3, 4]);
});

test('LiteTimeSeries computeBoundsInto and decimateInto', () => {
    const ts = createTimeSeries({ capacity: 16 });
    for (let i = 0; i < 10; i++) {
        ts.append(1000 + i * 100, 10 + i, 30 + i, 5 + i, 20 + i, (i + 1) * 10);
    }

    const bounds = new Float64Array(BOUNDS_STRIDE);
    const count = ts.computeBoundsInto(1200, 1700, bounds, 0);
    assert.equal(count, 6);
    // [minLow, maxHigh, maxVolume, firstOpen, lastClose, sumVolume, startLog, endLog, visCount]
    assert.equal(bounds[0], 7); // low for tick i=2 is 5+2=7
    assert.equal(bounds[1], 37); // high for tick i=7 is 30+7=37
    assert.equal(bounds[2], 80); // max volume (i=7 is 80)
    assert.equal(bounds[3], 12); // first open (i=2 is 10+2=12)
    assert.equal(bounds[4], 27); // last close (i=7 is 20+7=27)
    assert.equal(bounds[6], 2); // startLog
    assert.equal(bounds[7], 7); // endLog
    assert.equal(bounds[8], 6);

    // Decimation into 3 buckets
    const decOut = new Float64Array(3 * BUCKET_STRIDE);
    const written = ts.decimateInto(1200, 1700, 3, decOut, 0);
    assert.equal(written, 3);
    // Each bucket has [tFirst, open, high, low, close, volSum, sampleCount]
    assert.equal(decOut[6], 2); // 2 samples in bucket 0
    assert.equal(decOut[13], 2); // 2 samples in bucket 1
    assert.equal(decOut[20], 2); // 2 samples in bucket 2
});

test('TimeSeriesViewport navigation and transforms', () => {
    const vp = createViewport({
        width: 800,
        height: 400,
        minTime: 1000,
        maxTime: 5000,
        minPrice: 10,
        maxPrice: 110,
        paddingTop: 20,
        paddingBottom: 20
    });

    // timeToX and xToTime
    assert.equal(vp.timeToX(1000), 0);
    assert.equal(vp.timeToX(5000), 800);
    assert.equal(vp.timeToX(3000), 400);
    assert.equal(vp.xToTime(400), 3000);

    // priceToY and yToPrice (linear)
    // topY = 20 (maxPrice), bottomY = 380 (minPrice)
    assert.equal(vp.priceToY(110), 20);
    assert.equal(vp.priceToY(10), 380);
    assert.equal(vp.priceToY(60), 200);
    assert.equal(vp.yToPrice(200), 60);

    // Zoom and pan
    vp.zoomTime(2.0, 3000);
    assert.equal(vp.minTime, -1000);
    assert.equal(vp.maxTime, 7000);

    vp.pan(500, 10);
    assert.equal(vp.minTime, -500);
    assert.equal(vp.maxTime, 7500);
    assert.equal(vp.minPrice, 20);
    assert.equal(vp.maxPrice, 120);

    // 2D zero-box points
    const ptScreen = new Float64Array(2);
    vp.mapToScreenInto(3500, 70, ptScreen, 0);
    assert.equal(ptScreen[0], 400);
    assert.equal(ptScreen[1], 200);

    const ptDomain = new Float64Array(2);
    vp.mapToDomainInto(400, 200, ptDomain, 0);
    assert.equal(ptDomain[0], 3500);
    assert.equal(ptDomain[1], 70);
});

test('Spatial Hit Testing hitTestInto and hitTestFrom', () => {
    const ts = createTimeSeries({ capacity: 8 });
    for (let i = 0; i < 5; i++) {
        ts.append(1000 + i * 1000, 50, 100, 10, 60, 500);
    }

    const vp = createViewport({
        width: 800,
        height: 400,
        minTime: 1000,
        maxTime: 5000,
        minPrice: 0,
        maxPrice: 100,
        paddingTop: 0,
        paddingBottom: 0
    });

    const outHit = new Float64Array(HIT_STRIDE);

    // Hit exact candle at time 3000 (x = 400)
    const res1 = hitTestInto(ts, vp, 400, 200, 20, outHit, 0);
    assert.equal(res1, 1);
    assert.equal(outHit[0], 2); // logical index
    assert.equal(outHit[2], 3000); // time
    assert.equal(outHit[8], 400); // snappedX

    // Miss: distance > maxSnapDistance (25 px away)
    const res2 = hitTestInto(ts, vp, 425, 200, 20, outHit, 0);
    assert.equal(res2, 0);
    assert.equal(outHit[0], -1);
    assert.ok(Number.isNaN(outHit[2]));

    // HitTestFrom
    const inHit = new Float64Array([400, 200, 20]);
    const res3 = hitTestFrom(ts, vp, inHit, 0, outHit, 0);
    assert.equal(res3, 1);
    assert.equal(outHit[2], 3000);
});

test('SegmentTree and Fenwick bounds query unwrapped and wrapped', () => {
    const ts = createTimeSeries({ capacity: 4 });
    // Append 4 candles to fill
    ts.append(1000, 10, 30, 5, 20, 100);
    ts.append(2000, 20, 50, 15, 45, 200);
    ts.append(3000, 45, 60, 40, 55, 300);
    ts.append(4000, 55, 70, 35, 65, 400);

    const outBounds = new Float64Array(BOUNDS_STRIDE);

    // Unwrapped query: time 1000 to 4000
    const count1 = ts.computeBoundsInto(1000, 4000, outBounds, 0);
    assert.equal(count1, 4);
    assert.equal(outBounds[0], 5); // minLow
    assert.equal(outBounds[1], 70); // maxHigh
    assert.equal(outBounds[2], 400); // maxVolume
    assert.equal(outBounds[3], 10); // firstOpen
    assert.equal(outBounds[4], 65); // lastClose
    assert.equal(outBounds[5], 1000); // sumVolume (100 + 200 + 300 + 400)

    // Wrap the ring buffer by appending 2 more candles
    ts.append(5000, 65, 80, 50, 75, 500); // overwrites index 0
    ts.append(6000, 75, 90, 60, 85, 600); // overwrites index 1

    // State now: [5000 (head-2=0), 6000 (head-1=1), 3000 (head=2), 4000 (head+1=3)]
    // Oldest is 3000 (phys 2), latest is 6000 (phys 1).
    // Query visible range covering the wrap: 3000 to 6000
    const count2 = ts.computeBoundsInto(3000, 6000, outBounds, 0);
    assert.equal(count2, 4);
    assert.equal(outBounds[0], 35); // minLow: min(40, 35, 50, 60) = 35
    assert.equal(outBounds[1], 90); // maxHigh: max(60, 70, 80, 90) = 90
    assert.equal(outBounds[2], 600); // maxVolume: max(300, 400, 500, 600) = 600
    assert.equal(outBounds[3], 45); // firstOpen (candle at 3000)
    assert.equal(outBounds[4], 85); // lastClose (candle at 6000)
    assert.equal(outBounds[5], 1800); // sumVolume (300 + 400 + 500 + 600)

    // Sub-range query wrapped: 4000 to 5000 (phys 3 and phys 0)
    const count3 = ts.computeBoundsInto(4000, 5000, outBounds, 0);
    assert.equal(count3, 2);
    assert.equal(outBounds[0], 35); // minLow: min(35, 50) = 35
    assert.equal(outBounds[1], 80); // maxHigh: max(70, 80) = 80
    assert.equal(outBounds[2], 500); // maxVolume: max(400, 500) = 500
    assert.equal(outBounds[3], 55); // firstOpen (candle at 4000)
    assert.equal(outBounds[4], 75); // lastClose (candle at 5000)
    assert.equal(outBounds[5], 900); // sumVolume (400 + 500)

    // Clear resets trees
    ts.clear();
    assert.equal(ts.count, 0);
    const count4 = ts.computeBoundsInto(1000, 6000, outBounds, 0);
    assert.equal(count4, 0);
});

test('Volume budget rejection on append and updateLatest', () => {
    const ts = createTimeSeries({ capacity: 4 });
    const maxVol = Number.MAX_VALUE / (4 * 4);
    assert.equal(ts._maxVol, maxVol);

    // Acceptable volume
    ts.append(1000, 10, 20, 5, 15, maxVol);
    assert.equal(ts.count, 1);

    // Rejection on append with volume > _maxVol
    assert.throws(
        () => ts.append(2000, 10, 20, 5, 15, maxVol * 1.01),
        RangeError
    );
    assert.equal(ts.count, 1); // atomic fail-closed

    // Rejection on appendFrom
    const bufExcess = new Float64Array([2000, 10, 20, 5, 15, maxVol * 1.5]);
    assert.throws(
        () => ts.appendFrom(bufExcess, 0),
        RangeError
    );
    assert.equal(ts.count, 1);

    // Rejection on updateLatest
    assert.throws(
        () => ts.updateLatest(1000, 10, 20, 5, 15, maxVol * 1.01),
        RangeError
    );

    // Rejection on updateLatestFrom
    bufExcess[0] = 1000;
    assert.throws(
        () => ts.updateLatestFrom(bufExcess, 0),
        RangeError
    );
});

test('TimeSeriesViewport viewport binding lifecycle and onResize delegation', () => {
    let resizedArgs = null;
    let resizeThis = null;
    const mockCanvasViewport = {
        width: 1280,
        height: 720,
        dpr: 2,
        onResize: function (w, h, dpr) {
            assert.equal(this, mockCanvasViewport);
            resizeThis = this;
            resizedArgs = [w, h, dpr];
        }
    };

    // Constructor with viewport
    const vp = createViewport({
        viewport: mockCanvasViewport,
        minTime: 0,
        maxTime: 1000,
        minPrice: 10,
        maxPrice: 100
    });
    assert.equal(vp.width, 1280);
    assert.equal(vp.height, 720);
    assert.equal(vp.boundViewport, mockCanvasViewport);

    // Trigger onResize from canvas viewport
    mockCanvasViewport.onResize(1920, 1080, 1.5);
    assert.equal(vp.width, 1920);
    assert.equal(vp.height, 1080);
    assert.equal(resizeThis, mockCanvasViewport);
    assert.deepEqual(resizedArgs, [1920, 1080, 1.5]);

    // Unbind viewport restores previous onResize
    vp.unbindViewport();
    assert.equal(vp.boundViewport, null);

    resizedArgs = null;
    mockCanvasViewport.onResize(800, 600, 1);
    assert.deepEqual(resizedArgs, [800, 600, 1]);
    // vp dimensions should NOT have changed on mockCanvasViewport call after unbind
    assert.equal(vp.width, 1920);
    assert.equal(vp.height, 1080);

    // Rebind to a viewport without onResize
    const simpleVp = { width: 640, height: 480 };
    vp.bindViewport(simpleVp);
    assert.equal(vp.width, 640);
    assert.equal(vp.height, 480);
    assert.equal(vp.boundViewport, simpleVp);

    // Call newly attached onResize hook
    simpleVp.onResize(1024, 768, 2);
    assert.equal(vp.width, 1024);
    assert.equal(vp.height, 768);

    vp.unbindViewport();
    assert.equal(vp.boundViewport, null);

    // Validation errors
    assert.throws(() => vp.syncViewport(null), TypeError);
    assert.throws(() => vp.syncViewport([]), TypeError);
    assert.throws(() => vp.syncViewport({ width: '100', height: 200 }), TypeError);
    assert.throws(() => vp.syncViewport({ width: -10, height: 200 }), RangeError);
    assert.throws(() => vp.syncViewport({ width: 100, height: 200, onResize: 'not-a-fn' }), TypeError);

    assert.throws(() => vp.bindViewport(null), TypeError);
    assert.throws(() => createViewport({ viewport: { width: -5, height: 10 } }), RangeError);
});

test('LiteTimeSeries version monotonic counter and fail-closed atomicity', () => {
    const ts = createTimeSeries({ capacity: 16 });
    assert.equal(ts.version, 0);

    // 1. append increments version by 1
    ts.append(100, 10, 12, 9, 11, 100);
    assert.equal(ts.version, 1);

    // fail-closed rejection on invalid candle leaves version untouched
    assert.throws(() => ts.append(90, 10, 12, 9, 11, 100), RangeError); // non-increasing timestamp
    assert.equal(ts.version, 1);
    assert.throws(() => ts.append(110, 10, 8, 9, 11, 100), RangeError); // high < low
    assert.equal(ts.version, 1);

    // 2. appendFrom increments version by 1
    const buf = new Float64Array([110, 10, 12, 9, 11, 50]);
    ts.appendFrom(buf, 0);
    assert.equal(ts.version, 2);

    assert.throws(() => ts.appendFrom(buf, 0), RangeError); // timestamp 110 not > 110
    assert.equal(ts.version, 2);

    // 3. updateLatest increments version by 1
    ts.updateLatest(110, 10, 13, 9, 12, 70);
    assert.equal(ts.version, 3);

    assert.throws(() => ts.updateLatest(90, 10, 13, 9, 12, 70), RangeError); // timestamp < prev
    assert.equal(ts.version, 3);

    // 4. updateLatestFrom increments version by 1
    const updateBuf = new Float64Array([110, 10, 14, 9, 13, 80]);
    ts.updateLatestFrom(updateBuf, 0);
    assert.equal(ts.version, 4);

    assert.throws(() => ts.updateLatestFrom(new Float64Array([90, 10, 14, 9, 13, 80]), 0), RangeError);
    assert.equal(ts.version, 4);

    // 5. clear increments version by 1
    ts.clear();
    assert.equal(ts.version, 5);

    // 6. updateLatest on empty series delegates to append and increments version once
    ts.updateLatest(200, 5, 8, 4, 7, 10);
    assert.equal(ts.version, 6);

    // 7. Frame-skip pattern simulation
    let lastRenderedVersion = -1;
    let renderCount = 0;
    function maybeRender() {
        if (ts.version === lastRenderedVersion) return;
        renderCount++;
        lastRenderedVersion = ts.version;
    }

    maybeRender();
    assert.equal(renderCount, 1);
    maybeRender(); // no data change -> skipped
    assert.equal(renderCount, 1);

    ts.append(210, 7, 9, 6, 8, 15);
    maybeRender(); // version changed -> rendered
    assert.equal(renderCount, 2);
    maybeRender(); // skipped
    assert.equal(renderCount, 2);
});

test('TimeSeriesPool options validation and defaults', () => {
    assert.equal(DEFAULT_POOL_MAX_SERIES, 64);

    // Defaults
    const poolDefault = createTimeSeriesPool();
    assert.equal(poolDefault.maxSeries, 64);
    assert.equal(poolDefault.seriesCapacity, DEFAULT_CAPACITY);
    assert.equal(poolDefault.size, 0);
    assert.equal(poolDefault.totalAllocated, 0);
    assert.equal(poolDefault.freeCount, 0);

    // Custom valid options
    const poolCustom = createTimeSeriesPool({
        maxSeries: 16,
        seriesCapacity: 1024,
        onEvict: () => {}
    });
    assert.equal(poolCustom.maxSeries, 16);
    assert.equal(poolCustom.seriesCapacity, 1024);

    // Non-plain object
    assert.throws(() => createTimeSeriesPool(null), TypeError);
    assert.throws(() => createTimeSeriesPool([]), TypeError);
    assert.throws(() => createTimeSeriesPool('pool'), TypeError);

    // Unknown option with typo hint
    assert.throws(() => createTimeSeriesPool({ maxSereis: 32 }), /Did you mean "maxSeries"\?/);
    assert.throws(() => createTimeSeriesPool({ seriesCapcity: 512 }), /Did you mean "seriesCapacity"\?/);

    // maxSeries validation
    assert.throws(() => createTimeSeriesPool({ maxSeries: '16' }), TypeError);
    assert.throws(() => createTimeSeriesPool({ maxSeries: 0 }), RangeError);
    assert.throws(() => createTimeSeriesPool({ maxSeries: -1 }), RangeError);
    assert.throws(() => createTimeSeriesPool({ maxSeries: 2.5 }), RangeError);

    // seriesCapacity validation
    assert.throws(() => createTimeSeriesPool({ seriesCapacity: '1024' }), TypeError);
    assert.throws(() => createTimeSeriesPool({ seriesCapacity: 1000 }), RangeError); // not power of 2
    assert.throws(() => createTimeSeriesPool({ seriesCapacity: 1 }), RangeError); // < MIN_CAPACITY
    assert.throws(() => createTimeSeriesPool({ seriesCapacity: 8388608 }), RangeError); // > MAX_CAPACITY

    // onEvict validation
    assert.throws(() => createTimeSeriesPool({ onEvict: 'callback' }), TypeError);
});

test('TimeSeriesPool CRUD, key validation, and iteration', () => {
    const pool = createTimeSeriesPool({ maxSeries: 8, seriesCapacity: 128 });

    // Key validation
    assert.throws(() => pool.acquire(null), TypeError);
    assert.throws(() => pool.acquire(undefined), TypeError);
    assert.throws(() => pool.acquire(NaN), TypeError);
    assert.throws(() => pool.get(null), TypeError);
    assert.throws(() => pool.peek(null), TypeError);
    assert.throws(() => pool.has(null), TypeError);
    assert.throws(() => pool.delete(null), TypeError);

    // acquire / getOrCreate
    const s1 = pool.acquire('BTC-USDT');
    assert.ok(s1 instanceof LiteTimeSeries);
    assert.equal(s1.capacity, 128);
    assert.equal(pool.size, 1);
    assert.equal(pool.totalAllocated, 1);
    assert.equal(pool.freeCount, 0);

    // Repeated acquire returns identical instance
    const s1Again = pool.acquire('BTC-USDT');
    assert.equal(s1Again, s1);
    assert.equal(pool.size, 1);

    // get / peek / has
    assert.equal(pool.has('BTC-USDT'), true);
    assert.equal(pool.has('ETH-USDT'), false);
    assert.equal(pool.get('BTC-USDT'), s1);
    assert.equal(pool.get('ETH-USDT'), undefined);
    assert.equal(pool.peek('BTC-USDT'), s1);
    assert.equal(pool.peek('ETH-USDT'), undefined);

    // delete
    s1.append(100, 10, 12, 9, 11, 5);
    assert.equal(s1.count, 1);
    assert.equal(pool.delete('NON_EXISTENT'), false);
    assert.equal(pool.delete('BTC-USDT'), true);
    assert.equal(pool.size, 0);
    assert.equal(pool.freeCount, 1);
    assert.equal(s1.count, 0); // cleared when recycled to freeList

    // Re-acquiring recycles from freeList
    const s2 = pool.acquire('ETH-USDT');
    assert.equal(s2, s1); // recycled instance
    assert.equal(pool.size, 1);
    assert.equal(pool.freeCount, 0);
    assert.equal(pool.totalAllocated, 1);

    // Iteration: keys, values, entries, Symbol.iterator
    pool.acquire('SOL-USDT');
    assert.equal(pool.size, 2);

    const keys = Array.from(pool.keys());
    assert.deepEqual(keys.sort(), ['ETH-USDT', 'SOL-USDT']);

    const values = Array.from(pool.values());
    assert.equal(values.length, 2);
    assert.ok(values[0] instanceof LiteTimeSeries);
    assert.ok(values[1] instanceof LiteTimeSeries);

    const entries = Array.from(pool.entries());
    assert.equal(entries.length, 2);

    const iterated = [];
    for (const [k, s] of pool) {
        iterated.push(k);
    }
    assert.deepEqual(iterated.sort(), ['ETH-USDT', 'SOL-USDT']);

    // clear()
    pool.clear();
    assert.equal(pool.size, 0);
    assert.equal(pool.freeCount, pool.totalAllocated);
});

test('TimeSeriesPool SIEVE eviction, recycling ceiling, and onEvict exception safety', () => {
    const evictions = [];
    const pool = createTimeSeriesPool({
        maxSeries: 3,
        seriesCapacity: 64,
        onEvict: (k, s) => {
            evictions.push({ key: k, count: s.count });
        }
    });

    // Acquire 3 series
    const sA = pool.acquire('A');
    sA.append(10, 1, 2, 0.5, 1.5, 10);
    const sB = pool.acquire('B');
    sB.append(20, 2, 3, 1.5, 2.5, 20);
    const sC = pool.acquire('C');
    sC.append(30, 3, 4, 2.5, 3.5, 30);

    assert.equal(pool.size, 3);
    assert.equal(pool.totalAllocated, 3);
    assert.equal(pool.freeCount, 0);

    // Access B so it gets visited=1 in SIEVE
    assert.equal(pool.get('B'), sB);

    // Acquire D causes eviction of an unvisited item
    const sD = pool.acquire('D');
    assert.equal(pool.size, 3);
    assert.equal(pool.totalAllocated, 4); // maxSeries + 1 ceiling
    assert.equal(evictions.length, 1);
    assert.ok(evictions[0].key === 'A' || evictions[0].key === 'C');

    // Churn through 100 new keys: totalAllocated MUST NOT exceed maxSeries + 1
    for (let i = 0; i < 100; i++) {
        const key = `key-${i}`;
        const s = pool.acquire(key);
        s.append(100 + i, 1, 2, 0.5, 1.5, 5);
        assert.ok(pool.totalAllocated <= 4, `totalAllocated ${pool.totalAllocated} exceeded maxSeries + 1`);
    }
    assert.equal(pool.size, 3);
    assert.ok(pool.totalAllocated <= 4);

    // onEvict exception safety: error in user callback does not corrupt freeList or pool
    let throwCount = 0;
    const throwingPool = createTimeSeriesPool({
        maxSeries: 2,
        seriesCapacity: 32,
        onEvict: () => {
            throwCount++;
            throw new Error('boom');
        }
    });

    const tA = throwingPool.acquire('T1');
    tA.append(1, 10, 11, 9, 10, 1);
    const tB = throwingPool.acquire('T2');
    tB.append(2, 20, 21, 19, 20, 2);
    assert.equal(throwingPool.size, 2);

    // Eviction will trigger onEvict which throws
    assert.throws(() => throwingPool.acquire('T3'), /boom/);
    assert.equal(throwCount, 1);

    // Despite throw, the evicted series was cleared and recycled to freeList in finally block
    assert.equal(throwingPool.freeCount, 1);
    // Pool remains functional
    const t3 = throwingPool.acquire('T3');
    assert.ok(t3 instanceof LiteTimeSeries);
});

