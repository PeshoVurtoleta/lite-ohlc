// test/parity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    createTimeSeries,
    createViewport,
    hitTestInto,
    HIT_STRIDE,
    BOUNDS_STRIDE
} from '../Ohlc.js';

function mapRange(val, inMin, inMax, outMin, outMax) {
    return ((val - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

class FrozenViewport {
    constructor() {
        this.width = 0;
        this.height = 0;
        this.minTime = 0;
        this.maxTime = 0;
        this.minPrice = 0;
        this.maxPrice = 0;
        this.isLogScale = false;
        this.paddingTop = 20;
        this.paddingBottom = 20;
        this.minTimeSpan = 1000;
    }

    resize(width, height) {
        this.width = width;
        this.height = height;
    }

    setDomain(minTime, maxTime, minPrice, maxPrice) {
        this.minTime = minTime;
        this.maxTime = Math.max(maxTime, minTime + this.minTimeSpan);
        const absoluteMin = this.isLogScale ? 0.00000001 : -Infinity;
        this.minPrice = Math.max(minPrice, absoluteMin);
        this.maxPrice = Math.max(maxPrice, this.minPrice + 0.00000001);
    }

    timeToX(time) {
        return Math.round(mapRange(time, this.minTime, this.maxTime, 0, this.width));
    }

    xToTime(x) {
        return mapRange(x, 0, this.width, this.minTime, this.maxTime);
    }

    priceToY(price) {
        const bottomY = this.height - this.paddingBottom;
        const topY = this.paddingTop;
        if (this.isLogScale) {
            const logMin = Math.log10(this.minPrice);
            const logMax = Math.log10(this.maxPrice);
            const logPrice = Math.log10(Math.max(price, this.minPrice));
            return Math.round(mapRange(logPrice, logMin, logMax, bottomY, topY));
        }
        return Math.round(mapRange(price, this.minPrice, this.maxPrice, bottomY, topY));
    }

    yToPrice(y) {
        const bottomY = this.height - this.paddingBottom;
        const topY = this.paddingTop;
        if (this.isLogScale) {
            const logMin = Math.log10(this.minPrice);
            const logMax = Math.log10(this.maxPrice);
            const logVal = mapRange(y, bottomY, topY, logMin, logMax);
            return Math.pow(10, logVal);
        }
        return mapRange(y, bottomY, topY, this.minPrice, this.maxPrice);
    }
}

const golden = JSON.parse(
    fs.readFileSync(new URL('./golden.json', import.meta.url), 'utf8')
);

test('parity: linear viewport coordinate transforms match golden & frozen', () => {
    const vp = createViewport(golden.viewport_linear.domain);
    const frozenVp = new FrozenViewport();
    frozenVp.resize(golden.viewport_linear.domain.width, golden.viewport_linear.domain.height);
    frozenVp.setDomain(
        golden.viewport_linear.domain.minTime,
        golden.viewport_linear.domain.maxTime,
        golden.viewport_linear.domain.minPrice,
        golden.viewport_linear.domain.maxPrice
    );

    for (const { input, output } of golden.viewport_linear.timeToX) {
        assert.equal(vp.timeToX(input), output, `timeToX mismatch for ${input}`);
        assert.equal(vp.timeToX(input), frozenVp.timeToX(input));
    }

    for (const { input, output } of golden.viewport_linear.xToTime) {
        assert.equal(vp.xToTime(input), output, `xToTime mismatch for ${input}`);
        assert.equal(vp.xToTime(input), frozenVp.xToTime(input));
    }

    for (const { input, output } of golden.viewport_linear.priceToY) {
        assert.equal(vp.priceToY(input), output, `priceToY mismatch for ${input}`);
        assert.equal(vp.priceToY(input), frozenVp.priceToY(input));
    }

    for (const { input, output } of golden.viewport_linear.yToPrice) {
        assert.equal(vp.yToPrice(input), output, `yToPrice mismatch for ${input}`);
        assert.equal(vp.yToPrice(input), frozenVp.yToPrice(input));
    }
});

test('parity: log viewport coordinate transforms match golden & frozen', () => {
    const vp = createViewport(golden.viewport_log.domain);
    const frozenVp = new FrozenViewport();
    frozenVp.isLogScale = true;
    frozenVp.resize(golden.viewport_log.domain.width, golden.viewport_log.domain.height);
    frozenVp.setDomain(
        golden.viewport_log.domain.minTime,
        golden.viewport_log.domain.maxTime,
        golden.viewport_log.domain.minPrice,
        golden.viewport_log.domain.maxPrice
    );

    for (const { input, output } of golden.viewport_log.priceToY) {
        assert.equal(vp.priceToY(input), output, `log priceToY mismatch for ${input}`);
        assert.equal(vp.priceToY(input), frozenVp.priceToY(input));
    }

    for (const { input, output } of golden.viewport_log.yToPrice) {
        const actual = vp.yToPrice(input);
        assert.ok(Math.abs(actual - output) < 1e-9, `log yToPrice mismatch for ${input}`);
        assert.ok(Math.abs(actual - frozenVp.yToPrice(input)) < 1e-9);
    }
});

test('parity: binary search unwrapped matches golden & frozen', () => {
    const ts = createTimeSeries({ capacity: 16 });
    const times = [100, 200, 300, 400, 500, 600, 700, 800];
    times.forEach((t, i) => ts.append(t, 10 + i, 20 + i, 5 + i, 15 + i, 100 * i));

    for (const { targetTime, physicalIndex, matchedTime } of golden.binary_search_unwrapped) {
        const actualPhys = ts.findClosestPhysicalIndex(targetTime);
        assert.equal(actualPhys, physicalIndex, `targetTime ${targetTime}`);
        assert.equal(ts.time[actualPhys], matchedTime);
    }
});

test('parity: binary search wrapped matches golden & frozen', () => {
    const ts = createTimeSeries({ capacity: 8 });
    const times = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    times.forEach((t, i) => ts.append(t, 10 + i, 20 + i, 5 + i, 15 + i, 100 * i));

    assert.equal(ts.head, golden.binary_search_wrapped.head);
    assert.equal(ts.count, golden.binary_search_wrapped.count);

    for (const { targetTime, physicalIndex, matchedTime } of golden.binary_search_wrapped.results) {
        const actualPhys = ts.findClosestPhysicalIndex(targetTime);
        assert.equal(actualPhys, physicalIndex, `targetTime ${targetTime}`);
        assert.equal(ts.time[actualPhys], matchedTime);
    }
});

test('parity: hit testing matches golden and frozen HitTester', () => {
    const ts = createTimeSeries({ capacity: 8 });
    const times = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    times.forEach((t, i) => ts.append(t, 10 + i, 20 + i, 5 + i, 15 + i, 100 * i));

    const vp = createViewport();
    vp.resize(800, 400);
    vp.setDomain(10, 120, 0, 150);

    const outHit = new Float64Array(HIT_STRIDE);

    for (const { mouseX, mouseY, hit } of golden.hit_test) {
        const hitResult = hitTestInto(ts, vp, mouseX, mouseY, 20, outHit, 0);
        if (hit === null) {
            assert.equal(hitResult, 0);
            assert.equal(outHit[0], -1);
        } else {
            assert.equal(hitResult, 1);
            assert.equal(outHit[1], hit.index);
            assert.equal(outHit[2], hit.time);
            assert.equal(outHit[8], hit.ui.x);
            assert.equal(outHit[9], hit.ui.nearestY);
            assert.equal(outHit[10], hit.ui.yOpen);
            assert.equal(outHit[11], hit.ui.yHigh);
            assert.equal(outHit[12], hit.ui.yLow);
            assert.equal(outHit[13], hit.ui.yClose);
        }
    }
});

test('parity: log-n SegmentTree & Fenwick bounds match brute force across wrapped states', () => {
    const ts = createTimeSeries({ capacity: 16 });
    const candles = [];
    for (let i = 0; i < 45; i++) {
        const t = 1000 + i * 10;
        const o = 100 + Math.sin(i) * 20;
        const h = o + Math.abs(Math.cos(i)) * 15;
        const l = o - Math.abs(Math.sin(i * 2)) * 15;
        const c = l + (h - l) * 0.5;
        const v = 50 + (i % 10) * 20;
        ts.append(t, o, h, l, c, v);
        candles.push({ t, o, h, l, c, v });
    }

    const ringCandles = candles.slice(-16);
    const outBounds = new Float64Array(BOUNDS_STRIDE);
    const rangeBuf = new Float64Array(2);

    for (let start = 0; start < 16; start++) {
        for (let end = start; end < 16; end++) {
            const minT = ringCandles[start].t;
            const maxT = ringCandles[end].t;

            // Brute force calculation over ringCandles[start..end]
            let expLow = Infinity;
            let expHigh = -Infinity;
            let expVol = -Infinity;
            let expSumVol = 0;
            const expOpen = ringCandles[start].o;
            const expClose = ringCandles[end].c;

            for (let k = start; k <= end; k++) {
                const c = ringCandles[k];
                if (c.l < expLow) expLow = c.l;
                if (c.h > expHigh) expHigh = c.h;
                if (c.v > expVol) expVol = c.v;
                expSumVol += c.v;
            }

            // computeBoundsInto
            const countInto = ts.computeBoundsInto(minT, maxT, outBounds, 0);
            assert.equal(countInto, end - start + 1);
            assert.ok(Math.abs(outBounds[0] - expLow) < 1e-9);
            assert.ok(Math.abs(outBounds[1] - expHigh) < 1e-9);
            assert.ok(Math.abs(outBounds[2] - expVol) < 1e-9);
            assert.ok(Math.abs(outBounds[3] - expOpen) < 1e-9);
            assert.ok(Math.abs(outBounds[4] - expClose) < 1e-9);
            assert.ok(Math.abs(outBounds[5] - expSumVol) < 1e-9);

            // computeBoundsFrom
            rangeBuf[0] = minT;
            rangeBuf[1] = maxT;
            const countFrom = ts.computeBoundsFrom(rangeBuf, 0, outBounds, 0);
            assert.equal(countFrom, end - start + 1);
            assert.ok(Math.abs(outBounds[0] - expLow) < 1e-9);
            assert.ok(Math.abs(outBounds[1] - expHigh) < 1e-9);
            assert.ok(Math.abs(outBounds[2] - expVol) < 1e-9);
            assert.ok(Math.abs(outBounds[3] - expOpen) < 1e-9);
            assert.ok(Math.abs(outBounds[4] - expClose) < 1e-9);
            assert.ok(Math.abs(outBounds[5] - expSumVol) < 1e-9);
        }
    }
});
