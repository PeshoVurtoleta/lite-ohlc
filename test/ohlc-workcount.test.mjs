// ohlc-workcount: deterministic work witness for decimateInto -- PLAN-1.0.1 ASSERTION 2 (R3).
// No timing: a global Math.floor wrapper counts the calls one decimateInto makes. v1.0.0 makes
// one per bucket (B) on the scan path; the n <= B fast path makes at most n. This file runs in
// its own process (npm test passes each test file to its own child), and the wrapper lives only
// inside count(), restored in a finally. The fixture is the frozen v1.0.0 build (sha256-pinned
// by test/ohlc-fastpath.test.mjs). RISK: this pins "dense scan = B calls"; a rewrite of the
// dense loop updates this file, never deletes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OhlcSeries } from '../Ohlc.js';
import { OhlcSeries as OhlcSeriesV100 } from './fixtures/Ohlc-v1.0.0.js';

const BIG_B = 1048576; // 2^20 = MAX_BUCKETS
const OUT = new Float64Array(7 * BIG_B); // allocated once, reused by every query

let seed = 11;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);

// nb bars, the newest left live; fractional volumes.
function makeFeed(nb) {
    const f = new Float64Array(6 * nb);
    for (let i = 0; i < nb; i++) {
        const o = 10 + rnd();
        f[6 * i] = i;
        f[6 * i + 1] = o;
        f[6 * i + 2] = o + rnd();
        f[6 * i + 3] = o - rnd();
        f[6 * i + 4] = o;
        f[6 * i + 5] = ((rnd() * 100) | 0) + rnd();
    }
    return f;
}

function build(Cls, cap, feed) {
    const s = new Cls(cap, 1);
    const nb = feed.length / 6;
    for (let i = 0; i < nb; i++) s.setLiveFrom(feed, 6 * i);
    return s;
}

// Count Math.floor calls and the internal path taken by ONE decimateInto call.
const CNT = new Float64Array(4); // [floor calls, scan calls, tree calls, sparse calls]
function count(s, i0, i1, B) {
    const proto = Object.getPrototypeOf(s);
    const floor = Math.floor;
    const scan = proto._decimateScan;
    const tree = proto._decimateTree;
    const sparse = proto._decimateSparse; // undefined on v1.0.0
    CNT[0] = 0; CNT[1] = 0; CNT[2] = 0; CNT[3] = 0;
    Math.floor = function (x) { CNT[0]++; return floor(x); };
    proto._decimateScan = function (a, b, c, d, e) { CNT[1]++; return scan.call(this, a, b, c, d, e); };
    proto._decimateTree = function (a, b, c, d, e) { CNT[2]++; return tree.call(this, a, b, c, d, e); };
    if (sparse) proto._decimateSparse = function (a, b, c, d, e) { CNT[3]++; return sparse.call(this, a, b, c, d, e); };
    let w;
    try {
        w = s.decimateInto(i0, i1, B, OUT, 0);
    } finally {
        Math.floor = floor;
        proto._decimateScan = scan;
        proto._decimateTree = tree;
        if (sparse) proto._decimateSparse = sparse;
    }
    return { w, floors: CNT[0], scans: CNT[1], trees: CNT[2], sparses: CNT[3] };
}

test('n = 1, B = 2^20 on cap 1024: scan path; <= 1 Math.floor live, exactly 2^20 on v1.0.0', () => {
    const cap = 1024;
    const feed = makeFeed(cap + 37); // the ring wraps; the newest bar stays live
    const live = build(OhlcSeries, cap, feed);
    const v100 = build(OhlcSeriesV100, cap, feed);
    assert.equal(live.count, cap);
    assert.equal(live.hasLive, true);
    // D5 dispatch: scan iff n < B * log2(cap). n = 1 < 2^20 * 10.
    assert.ok(1 < BIG_B * Math.log2(cap), 'the query must take the scan path');
    for (const i of [0, 1, 511, cap - 2, cap - 1]) { // cap - 1 = the live bar
        const a = count(live, i, i, BIG_B);
        const b = count(v100, i, i, BIG_B);
        assert.equal(a.scans, 1, 'live: scan path taken at i=' + i);
        assert.equal(a.trees, 0, 'live: tree path not taken at i=' + i);
        assert.equal(b.scans, 1, 'v1.0.0: scan path taken at i=' + i);
        assert.equal(b.trees, 0, 'v1.0.0: tree path not taken at i=' + i);
        assert.equal(a.w, 1);
        assert.equal(b.w, 1);
        assert.ok(a.floors <= 1, 'live Math.floor calls at i=' + i + ': ' + a.floors + ' (want <= 1)');
        assert.equal(b.floors, BIG_B, 'v1.0.0 Math.floor calls at i=' + i);
    }
});

test('dense scan (cap 4096, n = 3000, B = 1000): exactly 1000 Math.floor calls on both', () => {
    const cap = 4096;
    const n = 3000;
    const B = 1000;
    const feed = makeFeed(cap + 101);
    const live = build(OhlcSeries, cap, feed);
    const v100 = build(OhlcSeriesV100, cap, feed);
    assert.ok(n > B && n < B * Math.log2(cap), 'dense scan: B < n < B * log2(cap)');
    for (const i0 of [0, 500, cap - n]) { // cap - n: the range ends at the live bar
        const a = count(live, i0, i0 + n - 1, B);
        const b = count(v100, i0, i0 + n - 1, B);
        assert.equal(a.scans, 1);
        assert.equal(a.trees, 0);
        assert.equal(b.scans, 1);
        assert.equal(b.trees, 0);
        assert.equal(a.w, B);
        assert.equal(b.w, B);
        assert.equal(a.floors, B, 'live Math.floor calls at i0=' + i0);
        assert.equal(b.floors, B, 'v1.0.0 Math.floor calls at i0=' + i0);
    }
});

test('fast-path threshold (cap 64, B = 64): n = B takes _decimateSparse, n = B + 1 does not', () => {
    const cap = 64;
    const B = 64;
    const feed = makeFeed(cap + 9);
    const live = build(OhlcSeries, cap, feed);
    assert.ok(typeof Object.getPrototypeOf(live)._decimateSparse === 'function');
    // n = B: the floor count cannot tell the paths apart (B floors either way), so count the method.
    const a = count(live, 0, B - 1, B);
    assert.ok(B < B * Math.log2(cap), 'n = B takes the scan path');
    assert.equal(a.scans, 1);
    assert.equal(a.sparses, 1, 'n = B must take the sparse path');
    assert.equal(a.w, B);
    assert.ok(a.floors <= B);
    // n = B + 1 on the same series (B = 63 keeps n <= cap): dense loop, no sparse call.
    const c = count(live, 0, B - 1, B - 1);
    assert.equal(c.scans, 1);
    assert.equal(c.sparses, 0, 'n = B + 1 must take the dense loop');
    assert.equal(c.w, B - 1);
    assert.equal(c.floors, B - 1);
});
