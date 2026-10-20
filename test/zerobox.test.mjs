// test/zerobox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';

import {
    createTimeSeries,
    createViewport,
    createTimeSeriesPool,
    hitTestFrom,
    BOUNDS_STRIDE,
    BUCKET_STRIDE,
    HIT_STRIDE
} from '../Ohlc.js';

function getNewSpaceUsed() {
    const spaces = v8.getHeapSpaceStatistics();
    const ns = spaces.find(s => s.space_name === 'new_space');
    return ns ? ns.space_used_size : 0;
}

let gcCount = 0;
const gcObs = new PerformanceObserver((list) => {
    gcCount += list.getEntries().length;
});
gcObs.observe({ entryTypes: ['gc'] });

function runWindow(fn, N = 20000) {
    globalThis.gc?.();
    const startGc = gcCount;
    const b1 = getNewSpaceUsed();
    for (let i = 0; i < N; i++) fn();
    const b2 = getNewSpaceUsed();
    const endGc = gcCount;
    if (endGc !== startGc) {
        // Scavenge occurred during window, retry
        globalThis.gc?.();
        const b1Retry = getNewSpaceUsed();
        for (let i = 0; i < N; i++) fn();
        const b2Retry = getNewSpaceUsed();
        return b2Retry - b1Retry;
    }
    return b2 - b1;
}

function measureNetBpo(fn, N = 20000) {
    // Warmup JIT (window 0)
    for (let i = 0; i < 20000; i++) fn();

    // Baseline window
    const baseline = runWindow(() => {}, N);

    let minNetBpo = Infinity;
    // Steady state: minimum over windows 1..3
    for (let w = 0; w < 3; w++) {
        const actual = runWindow(fn, N);
        const netBpo = Math.max(0, (actual - baseline) / N);
        if (netBpo < minNetBpo) minNetBpo = netBpo;
    }
    return minNetBpo;
}

class C1 { updateLatest() {} }
class C2 { updateLatest() {} }
class C3 { updateLatest() {} }
class C4 { updateLatest() {} }

function megamorphicUpdateLatest(target, t, o, h, l, c, v) {
    target.updateLatest(t, o, h, l, c, v);
}

class DummyFrom1 {
    updateLatestFrom() {}
    findClosestLogicalIndexFrom() { return 0; }
    getVisibleRangeFrom() { return 0; }
    computeBoundsFrom() { return 0; }
    decimateFrom() { return 0; }
    mapToScreenFrom() {}
    mapToDomainFrom() {}
    hitTestFrom() { return 0; }
    resizeFrom() {}
    fitPriceDomainFrom() {}
    setDomainFrom() {}
    centerOnTimeFrom() {}
    zoomTimeFrom() {}
    panFrom() {}
}
class DummyFrom2 extends DummyFrom1 {}
class DummyFrom3 extends DummyFrom1 {}
class DummyFrom4 extends DummyFrom1 {}

function megaUpdateLatestFrom(target, buf, offset) {
    target.updateLatestFrom(buf, offset);
}
function megaFindClosestLogicalIndexFrom(target, buf, offset) {
    return target.findClosestLogicalIndexFrom(buf, offset);
}
function megaGetVisibleRangeFrom(target, buf, offset, out, outOff) {
    return target.getVisibleRangeFrom(buf, offset, out, outOff);
}
function megaComputeBoundsFrom(target, buf, offset, out, outOff) {
    return target.computeBoundsFrom(buf, offset, out, outOff);
}
function megaDecimateFrom(target, buf, offset, bc, out, outOff) {
    return target.decimateFrom(buf, offset, bc, out, outOff);
}
function megaMapToScreenFrom(target, inBuf, inOff, outBuf, outOff) {
    return target.mapToScreenFrom(inBuf, inOff, outBuf, outOff);
}
function megaMapToDomainFrom(target, inBuf, inOff, outBuf, outOff) {
    return target.mapToDomainFrom(inBuf, inOff, outBuf, outOff);
}
function megaHitTestFrom(target, vp, inBuf, inOff, outBuf, outOff) {
    return target.hitTestFrom(vp, inBuf, inOff, outBuf, outOff);
}
function megaResizeFrom(target, buf, offset) {
    return target.resizeFrom(buf, offset);
}
function megaFitPriceDomainFrom(target, buf, offset) {
    return target.fitPriceDomainFrom(buf, offset);
}
function megaSetDomainFrom(target, buf, offset) {
    return target.setDomainFrom(buf, offset);
}
function megaCenterOnTimeFrom(target, buf, offset) {
    return target.centerOnTimeFrom(buf, offset);
}
function megaZoomTimeFrom(target, buf, offset) {
    return target.zoomTimeFrom(buf, offset);
}
function megaPanFrom(target, buf, offset) {
    return target.panFrom(buf, offset);
}

const EPOCH_BASE = 1700000000123.5;

test('zerobox: control plain method shows box on fractional input', (t) => {
    if (typeof globalThis.gc !== 'function') {
        t.skip('Requires node --expose-gc');
        return;
    }
    const ts = createTimeSeries({ capacity: 1024 });
    ts.append(EPOCH_BASE, 10.5, 20.25, 5.75, 15.5, 100.5);
    const targets = [new C1(), new C2(), new C3(), new C4(), ts];

    let counter = 0;
    // Megamorphic warmup across 5 classes to defeat callsite inlining
    for (let i = 0; i < 20000; i++) {
        const p = 12.5 + ((counter++) & 7) * 0.125;
        megamorphicUpdateLatest(targets[i % 5], EPOCH_BASE, p, p + 10, p - 5, p, 200);
    }

    const boxedBpo = measureNetBpo(() => {
        const p = 12.5 + ((counter++) & 7) * 0.125;
        megamorphicUpdateLatest(targets[counter % 5], EPOCH_BASE, p, p + 10, p - 5, p, 200);
    });

    // Plain method across non-inlined call boundary boxes >= 16 B/op
    assert.ok(boxedBpo >= 16.0, `Control plain method must show boxing (>= 16 B/op), measured: ${boxedBpo}`);
});

test('zerobox: updateLatestFrom is 0 B/op (megamorphic callsite + fractional epoch input)', () => {
    const ts = createTimeSeries({ capacity: 1024 });
    ts.append(EPOCH_BASE, 10.5, 20.25, 5.75, 15.5, 100.5);
    const inBuf = new Float64Array([EPOCH_BASE, 12.375, 22.875, 6.125, 18.625, 200.5]);
    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), ts];

    let counter = 0;
    for (let i = 0; i < 20000; i++) {
        megaUpdateLatestFrom(targets[i % 5], inBuf, 0);
    }

    const netBpo = measureNetBpo(() => {
        megaUpdateLatestFrom(targets[(counter++) % 5], inBuf, 0);
    });
    assert.ok(netBpo < 0.1, `updateLatestFrom must be 0 B/op (noise floor < 0.1), measured: ${netBpo}`);
});

test('zerobox: findClosestLogicalIndexFrom is 0 B/op (megamorphic callsite + fractional epoch input)', () => {
    const ts = createTimeSeries({ capacity: 1024 });
    for (let i = 0; i < 500; i++) {
        ts.append(EPOCH_BASE + i * 10.5, 10.25, 20.75, 5.5, 15.25, 100);
    }
    const queryBuf = new Float64Array([EPOCH_BASE + 2500.625]);
    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), ts];

    let counter = 0;
    for (let i = 0; i < 20000; i++) {
        megaFindClosestLogicalIndexFrom(targets[i % 5], queryBuf, 0);
    }

    const netBpo = measureNetBpo(() => {
        megaFindClosestLogicalIndexFrom(targets[(counter++) % 5], queryBuf, 0);
    });
    assert.ok(netBpo < 0.1, `findClosestLogicalIndexFrom must be 0 B/op, measured: ${netBpo}`);
});

test('zerobox: getVisibleRangeFrom is 0 B/op (megamorphic callsite + fractional epoch input)', () => {
    const ts = createTimeSeries({ capacity: 1024 });
    for (let i = 0; i < 500; i++) {
        ts.append(EPOCH_BASE + i * 10.5, 10.25, 20.75, 5.5, 15.25, 100);
    }
    const rangeBuf = new Float64Array([EPOCH_BASE + 1500.125, EPOCH_BASE + 3500.875]);
    const outInt32 = new Int32Array(3);
    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), ts];

    let counter = 0;
    for (let i = 0; i < 20000; i++) {
        megaGetVisibleRangeFrom(targets[i % 5], rangeBuf, 0, outInt32, 0);
    }

    const netBpo = measureNetBpo(() => {
        megaGetVisibleRangeFrom(targets[(counter++) % 5], rangeBuf, 0, outInt32, 0);
    });
    assert.ok(netBpo < 0.1, `getVisibleRangeFrom must be 0 B/op, measured: ${netBpo}`);
});

test('zerobox: computeBoundsFrom is 0 B/op (megamorphic callsite + fractional epoch input)', () => {
    const ts = createTimeSeries({ capacity: 1024 });
    for (let i = 0; i < 500; i++) {
        ts.append(EPOCH_BASE + i * 10.5, 10.25, 20.75, 5.5, 15.25, 100);
    }
    const rangeBuf = new Float64Array([EPOCH_BASE + 1500.125, EPOCH_BASE + 3500.875]);
    const outBounds = new Float64Array(BOUNDS_STRIDE);
    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), ts];

    let counter = 0;
    for (let i = 0; i < 20000; i++) {
        megaComputeBoundsFrom(targets[i % 5], rangeBuf, 0, outBounds, 0);
    }

    const netBpo = measureNetBpo(() => {
        megaComputeBoundsFrom(targets[(counter++) % 5], rangeBuf, 0, outBounds, 0);
    });
    assert.ok(netBpo < 0.1, `computeBoundsFrom must be 0 B/op, measured: ${netBpo}`);
});

test('zerobox: decimateFrom is 0 B/op (megamorphic callsite + fractional epoch input)', () => {
    const ts = createTimeSeries({ capacity: 1024 });
    for (let i = 0; i < 500; i++) {
        ts.append(EPOCH_BASE + i * 10.5, 10.25, 20.75, 5.5, 15.25, 100);
    }
    const rangeBuf = new Float64Array([EPOCH_BASE + 1500.125, EPOCH_BASE + 3500.875]);
    const outBuckets = new Float64Array(4 * BUCKET_STRIDE);
    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), ts];

    let counter = 0;
    for (let i = 0; i < 20000; i++) {
        megaDecimateFrom(targets[i % 5], rangeBuf, 0, 4, outBuckets, 0);
    }

    const netBpo = measureNetBpo(() => {
        megaDecimateFrom(targets[(counter++) % 5], rangeBuf, 0, 4, outBuckets, 0);
    });
    assert.ok(netBpo < 0.1, `decimateFrom must be 0 B/op, measured: ${netBpo}`);
});

test('zerobox: mapToScreenFrom and mapToDomainFrom are 0 B/op (megamorphic callsite + fractional input)', () => {
    const vp = createViewport({
        width: 800,
        height: 400,
        minTime: EPOCH_BASE,
        maxTime: EPOCH_BASE + 5000,
        minPrice: 10.25,
        maxPrice: 100.75
    });
    const inPt = new Float64Array([EPOCH_BASE + 2500.5, 50.125]);
    const outPt = new Float64Array(2);
    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), vp];

    let counter = 0;
    for (let i = 0; i < 20000; i++) {
        megaMapToScreenFrom(targets[i % 5], inPt, 0, outPt, 0);
    }

    const bpoScreen = measureNetBpo(() => {
        megaMapToScreenFrom(targets[(counter++) % 5], inPt, 0, outPt, 0);
    });
    assert.ok(bpoScreen < 0.1, `mapToScreenFrom must be 0 B/op, measured: ${bpoScreen}`);

    for (let i = 0; i < 20000; i++) {
        megaMapToDomainFrom(targets[i % 5], inPt, 0, outPt, 0);
    }

    const bpoDomain = measureNetBpo(() => {
        megaMapToDomainFrom(targets[(counter++) % 5], inPt, 0, outPt, 0);
    });
    assert.ok(bpoDomain < 0.1, `mapToDomainFrom must be 0 B/op, measured: ${bpoDomain}`);
});

test('zerobox: hitTestFrom is 0 B/op (megamorphic callsite + fractional input)', () => {
    const ts = createTimeSeries({ capacity: 1024 });
    for (let i = 0; i < 500; i++) {
        ts.append(EPOCH_BASE + i * 10.5, 10.25, 20.75, 5.5, 15.25, 100);
    }
    const vp = createViewport({
        width: 800,
        height: 400,
        minTime: EPOCH_BASE,
        maxTime: EPOCH_BASE + 6000,
        minPrice: 0,
        maxPrice: 50
    });
    const inHit = new Float64Array([400.5, 200.25, 20.5]);
    const outHit = new Float64Array(HIT_STRIDE);
    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), ts];

    let counter = 0;
    for (let i = 0; i < 20000; i++) {
        megaHitTestFrom(targets[i % 5], vp, inHit, 0, outHit, 0);
    }

    const netBpo = measureNetBpo(() => {
        megaHitTestFrom(targets[(counter++) % 5], vp, inHit, 0, outHit, 0);
    });
    assert.ok(netBpo < 0.1, `hitTestFrom must be 0 B/op, measured: ${netBpo}`);
});

test('zerobox: viewport mutators *From are 0 B/op (megamorphic callsite + fractional input)', () => {
    const vp = createViewport({
        width: 800,
        height: 400,
        minTime: EPOCH_BASE,
        maxTime: EPOCH_BASE + 5000,
        minPrice: 10,
        maxPrice: 100
    });
    const resizeBuf = new Float64Array([1024.5, 768.5]);
    const fitPriceBuf = new Float64Array([15.25, 85.75, 0.1]);
    const setDomainBuf = new Float64Array([EPOCH_BASE + 100.5, EPOCH_BASE + 4000.5, 20.25, 90.75]);
    const centerBuf = new Float64Array([EPOCH_BASE + 2000.5, 1000.25]);
    const zoomBuf = new Float64Array([1.5, EPOCH_BASE + 2000.5]);
    const panBuf = new Float64Array([10.5, 2.5]);

    const targets = [new DummyFrom1(), new DummyFrom2(), new DummyFrom3(), new DummyFrom4(), vp];

    let counter = 0;
    const bpoResize = measureNetBpo(() => {
        megaResizeFrom(targets[(counter++) % 5], resizeBuf, 0);
    });
    assert.ok(bpoResize < 0.1, `resizeFrom must be 0 B/op, measured: ${bpoResize}`);

    const bpoFit = measureNetBpo(() => {
        megaFitPriceDomainFrom(targets[(counter++) % 5], fitPriceBuf, 0);
    });
    assert.ok(bpoFit < 0.1, `fitPriceDomainFrom must be 0 B/op, measured: ${bpoFit}`);

    const bpoSet = measureNetBpo(() => {
        megaSetDomainFrom(targets[(counter++) % 5], setDomainBuf, 0);
    });
    assert.ok(bpoSet < 0.1, `setDomainFrom must be 0 B/op, measured: ${bpoSet}`);

    const bpoCenter = measureNetBpo(() => {
        megaCenterOnTimeFrom(targets[(counter++) % 5], centerBuf, 0);
    });
    assert.ok(bpoCenter < 0.1, `centerOnTimeFrom must be 0 B/op, measured: ${bpoCenter}`);

    const bpoZoom = measureNetBpo(() => {
        megaZoomTimeFrom(targets[(counter++) % 5], zoomBuf, 0);
    });
    assert.ok(bpoZoom < 0.1, `zoomTimeFrom must be 0 B/op, measured: ${bpoZoom}`);

    const bpoPan = measureNetBpo(() => {
        megaPanFrom(targets[(counter++) % 5], panBuf, 0);
    });
    assert.ok(bpoPan < 0.1, `panFrom must be 0 B/op, measured: ${bpoPan}`);
});

test('zerobox: TimeSeriesPool acquire hit and version frame-skip lane is 0 B/op', () => {
    const pool = createTimeSeriesPool({ maxSeries: 8, seriesCapacity: 64 });
    const symbols = ['BTC', 'ETH', 'SOL', 'AVAX', 'BNB', 'ADA', 'XRP', 'DOGE'];
    for (let i = 0; i < symbols.length; i++) {
        pool.acquire(symbols[i]);
    }

    let counter = 0;
    let lastVersion = -1;
    let skipped = 0;
    const bpoHit = measureNetBpo(() => {
        const s = pool.acquire(symbols[(counter++) & 7]);
        if (s.version === lastVersion) {
            skipped++;
        }
    });
    assert.ok(bpoHit < 0.1, `TimeSeriesPool acquire hit must be 0 B/op, measured: ${bpoHit}`);
});

