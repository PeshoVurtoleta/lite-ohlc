// test/zerobox.test.mjs -- A13 (PLAN-v2). DETERMINISTIC tier: allocation / GC counts, no timing.
// Run: node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 --test test/zerobox.test.mjs
// Expected values come from the spec (S9 / A13): <= 0.1 B/op per hot method, >= 16 B/op for the
// control (a HeapNumber is 16 B on Node), maxMajor 0 / maxMinor 0 for the GcProfiler window.
import test from 'node:test';
import assert from 'node:assert/strict';

import { measureOps, GcProfiler, assertNoGc } from '@zakkster/lite-gc-profiler';
import { OhlcSeries } from '../Ohlc.js';

const CAP = 65536;
const EPOCH_BASE = 1700000000123.5; // fractional epoch ms: a non-Smi double on every V8
const OPS = 1000000;      // zero lanes: the meter has ~10-25 KB fixed noise, so 1e6 ops keeps it < 0.03 B/op
const CONTROL_OPS = 30000; // control: stays under one 4 MB semi-space even at 130 B/op, so no scavenge undercounts it
const WARMUP = 200000;
const BUDGET = 0.1;

// Fail closed: the harness is meaningless without a pinned 4 MB semi-space and a gc() hook.
function requireHarness() {
    assert.equal(typeof globalThis.gc, 'function', 'run with node --expose-gc');
    const a = process.execArgv.join(' ');
    assert.ok(/--min-semi-space-size=4\b/.test(a) && /--max-semi-space-size=4\b/.test(a),
        'run with --min-semi-space-size=4 --max-semi-space-size=4; execArgv=' + a);
}

// 5-class megamorphic call sites: four TEXTUALLY DISTINCT dummies + the real series share ONE call
// site each (5 different callee functions), so V8 cannot inline the callee and a boxed argument or
// return really crosses a call boundary.
class D1 {
    appendBarFrom(b, o) { sink[0] = 10; } setLiveFrom(b, o) { sink[0] = 11; } setLive(t, o, h, l, c, v) { sink[0] = 12; }
    lowerBoundFrom(b, o) { return 13; } upperBoundFrom(b, o) { return 14; }
    boundsInto(i0, i1, out, off) { sink[0] = 15; } copyRangeInto(i0, i1, out, off) { sink[0] = 16; }
    get version() { return 17; } get count() { return 18; }
    decimateInto(i0, i1, B, out, off) { sink[0] = 19; return 1; }
}
class D2 {
    appendBarFrom(b, o) { sink[0] = 20; } setLiveFrom(b, o) { sink[0] = 21; } setLive(t, o, h, l, c, v) { sink[0] = 22; }
    lowerBoundFrom(b, o) { return 23; } upperBoundFrom(b, o) { return 24; }
    boundsInto(i0, i1, out, off) { sink[0] = 25; } copyRangeInto(i0, i1, out, off) { sink[0] = 26; }
    get version() { return 27; } get count() { return 28; }
    decimateInto(i0, i1, B, out, off) { sink[0] = 29; return 1; }
}
class D3 {
    appendBarFrom(b, o) { sink[0] = 30; } setLiveFrom(b, o) { sink[0] = 31; } setLive(t, o, h, l, c, v) { sink[0] = 32; }
    lowerBoundFrom(b, o) { return 33; } upperBoundFrom(b, o) { return 34; }
    boundsInto(i0, i1, out, off) { sink[0] = 35; } copyRangeInto(i0, i1, out, off) { sink[0] = 36; }
    get version() { return 37; } get count() { return 38; }
    decimateInto(i0, i1, B, out, off) { sink[0] = 39; return 1; }
}
class D4 {
    appendBarFrom(b, o) { sink[0] = 40; } setLiveFrom(b, o) { sink[0] = 41; } setLive(t, o, h, l, c, v) { sink[0] = 42; }
    lowerBoundFrom(b, o) { return 43; } upperBoundFrom(b, o) { return 44; }
    boundsInto(i0, i1, out, off) { sink[0] = 45; } copyRangeInto(i0, i1, out, off) { sink[0] = 46; }
    get version() { return 47; } get count() { return 48; }
    decimateInto(i0, i1, B, out, off) { sink[0] = 49; return 1; }
}

function mAppend(t, b, o) { t.appendBarFrom(b, o); }
function mSetLiveFrom(t, b, o) { t.setLiveFrom(b, o); }
function mLower(t, b, o) { return t.lowerBoundFrom(b, o); }
function mUpper(t, b, o) { return t.upperBoundFrom(b, o); }
function mBounds(t, i0, i1, out, o) { t.boundsInto(i0, i1, out, o); }
function mCopy(t, i0, i1, out, o) { t.copyRangeInto(i0, i1, out, o); }
function mVersion(t) { return t.version; }
function mCount(t) { return t.count; }
function mSetLive(t, ti, o, h, l, c, v) { t.setLive(ti, o, h, l, c, v); }
function mDecimate(t, i0, i1, B, out, o) { return t.decimateInto(i0, i1, B, out, o); }

// Candle layout [t,o,h,l,c,v]; o,h,l,c,v fractional, valid (l <= o,c <= h).
function makeSeries() {
    const s = new OhlcSeries(CAP, 1000);
    const b = new Float64Array([0, 10.5, 20.25, 5.75, 15.5, 100.5]);
    for (let k = 0; k < CAP; k++) {
        b[0] = EPOCH_BASE + k * 1000;
        s.appendBarFrom(b, 0);
    }
    return s;
}

function targetsOf(s) { return [new D1(), new D2(), new D3(), new D4(), s]; }

// Warm the closure OUTSIDE the meter, collect, then measure. A scavenge inside the window makes the
// heap delta undercount (new space is reclaimed), so a lane also fails if the profiler saw any minor GC
// in its window: a zero-alloc lane has none, an allocating lane has bytes > 0.1 or a scavenge.
async function bytesPerOp(fn, ops = OPS) {
    for (let i = 0; i < WARMUP; i++) fn(i);
    // An inverted bracket (end anchor below start) is UNMEASURED, never a pass. Measured 2026-10-21,
    // node 26.8.2: no GC entry in any inverted window; 12/100 runs (gc before start), 2/200 (gc after),
    // 0/80 with --no-concurrent-recompilation --no-concurrent-osr. Discard and re-measure; 3 of 3 fails.
    // Raw bracket kept (no stabilize): stabilize reads only the surviving delta, which would blind
    // the zero lanes to transient allocation and flatten the >= 16 B/op control to ~0.
    // The forced full GCs count as major, not minor, so the minor === 0 assertion stays meaningful.
    for (let attempt = 0; attempt < 3; attempt++) {
        const prof = new GcProfiler().start();
        globalThis.gc(); globalThis.gc();
        const r = measureOps(fn, { ops });
        await prof.settle();
        const minor = prof.summary().gc.minor;
        prof.stop();
        assert.notEqual(r.source, 'none', 'meter has no memory signal');
        if (r.bytesPerOp !== null) return { bpo: r.bytesPerOp, minor };
    }
    assert.fail('bytesPerOp is null in 3 of 3 windows (bracket inverted)');
}
function assertZero(name, m) {
    assert.ok(m.bpo <= BUDGET && m.minor === 0, name + ' ' + m.bpo + ' B/op, ' + m.minor + ' scavenges in window');
}

const sink = new Int32Array(2); // ints only: version/count/bounds results are Smis

test('zerobox: control -- scalar setLive with fractional args boxes >= 16 B/op', async () => {
    requireHarness();
    const targets = targetsOf(makeSeries());
    const m = await bytesPerOp((i) => {
        const p = 12.5 + (i & 7) * 0.125;
        mSetLive(targets[i % 5], EPOCH_BASE + CAP * 1000 + 0.5, p, p + 10, p - 5, p, 200.25);
    }, CONTROL_OPS);
    assert.ok(m.bpo >= 16, 'meter must see the box; measured ' + m.bpo + ' B/op');
});

test('zerobox: appendBarFrom is <= 0.1 B/op (5-class site, fractional epoch)', async () => {
    requireHarness();
    const targets = targetsOf(makeSeries());
    const b = new Float64Array([EPOCH_BASE + CAP * 1000, 10.5, 20.25, 5.75, 15.5, 100.5]);
    const bpo = await bytesPerOp((i) => { b[0] += 1000; mAppend(targets[i % 5], b, 0); });
    assertZero('appendBarFrom', bpo);
});

test('zerobox: setLiveFrom is <= 0.1 B/op (5-class site, fractional values)', async () => {
    requireHarness();
    const targets = targetsOf(makeSeries());
    const b = new Float64Array(8); // offset 2 exercises the off argument
    b[2] = EPOCH_BASE + CAP * 1000; b[3] = 10.5; b[4] = 20.25; b[5] = 5.75; b[6] = 15.5; b[7] = 100.5;
    const bpo = await bytesPerOp((i) => { b[6] = 15.5 + (i & 3) * 0.25; mSetLiveFrom(targets[i % 5], b, 2); });
    assertZero('setLiveFrom', bpo);
});

test('zerobox: lowerBoundFrom and upperBoundFrom are <= 0.1 B/op (fractional epoch query)', async () => {
    requireHarness();
    const targets = targetsOf(makeSeries());
    const q = new Float64Array(1);
    const lo = await bytesPerOp((i) => {
        q[0] = EPOCH_BASE + ((i * 31) & (CAP - 1)) * 1000 + 0.25;
        sink[0] = mLower(targets[i % 5], q, 0);
    });
    assertZero('lowerBoundFrom', lo);
    const up = await bytesPerOp((i) => {
        q[0] = EPOCH_BASE + ((i * 31) & (CAP - 1)) * 1000 + 0.25;
        sink[0] = mUpper(targets[i % 5], q, 0);
    });
    assertZero('upperBoundFrom', up);
});

test('zerobox: boundsInto is <= 0.1 B/op (stride-9 output; wrapped ring + live bar)', async () => {
    requireHarness();
    const s = makeSeries();
    const b = new Float64Array([EPOCH_BASE + CAP * 1000, 10.5, 20.25, 5.75, 15.5, 100.5]);
    for (let k = 0; k < 777; k++) { s.appendBarFrom(b, 0); b[0] += 1000; } // base moves: ranges wrap
    s.setLiveFrom(b, 0); // ranges ending at count-1 take the O(1) live fold
    const targets = targetsOf(s);
    const out = new Float64Array(9);
    const last = CAP - 1;
    const bpo = await bytesPerOp((i) => {
        const i0 = (i * 31) & 16383;
        if ((i & 1) === 0) mBounds(targets[i % 5], i0, i0 + 1000, out, 0);
        else mBounds(targets[i % 5], last - 1000 - i0, last, out, 0);
    });
    assertZero('boundsInto', bpo);
    assert.ok(s.hasLive && s.count === CAP, 'lane covers the live fold');
});

test('zerobox: copyRangeInto is <= 0.1 B/op (stride-6 output)', async () => {
    requireHarness();
    const targets = targetsOf(makeSeries());
    const out = new Float64Array(256 * 6);
    const bpo = await bytesPerOp((i) => {
        const i0 = (i * 31) & 16383;
        mCopy(targets[i % 5], i0, i0 + 255, out, 0);
    });
    assertZero('copyRangeInto', bpo);
});

// P2 lane: i0 = -0 passes the `(i0 | 0) === i0` validation, so it reaches the copy loop as a non-Smi
// HeapNumber. Alternate -0 with +0 through the same 5-class site; the loop index must stay unboxed.
test('zerobox: copyRangeInto is <= 0.1 B/op with i0 = -0 (alternating -0 / +0)', async () => {
    requireHarness();
    const targets = targetsOf(makeSeries());
    const out = new Float64Array(256 * 6);
    const bpo = await bytesPerOp((i) => {
        if ((i & 1) === 0) mCopy(targets[i % 5], -0, 255, out, 0);
        else mCopy(targets[i % 5], 0, 255, out, 0);
    });
    assertZero('copyRangeInto -0', bpo);
});

// decimateInto lanes. Path rule (S7): H = log2(CAP) = 16; n = i1-i0+1 < B*H -> scan, else tree.
// SCAN: B = 20 -> B*H = 320; n = 200 < 320.  TREE: B = 20; n = 2000 >= 320.
// SPARSE: n = 12 <= B = 20 (one bar per bucket; still the scan path by the H rule).  Guards assert all three.
const DEC_B = 20;
function decimateLane(name, n) {
    test('zerobox: decimateInto is <= 0.1 B/op (' + name + ' path, fractional volumes, wrapped ring + live bar)', async () => {
        requireHarness();
        assert.ok(name === 'tree' ? n >= DEC_B * 16 : n < DEC_B * 16 && (name !== 'sparse' || n <= DEC_B) &&
            (name !== 'scan' || n > DEC_B),
            'lane picks the ' + name + ' path by the H rule');
        const s = makeSeries();
        const b = new Float64Array([EPOCH_BASE + CAP * 1000, 10.5, 20.25, 5.75, 15.5, 100.5]);
        for (let k = 0; k < 777; k++) { s.appendBarFrom(b, 0); b[0] += 1000; } // base moves: ranges wrap
        s.setLiveFrom(b, 0);
        assert.ok(s.hasLive && s.count === CAP);
        const targets = targetsOf(s);
        const out = new Float64Array(7 * DEC_B);
        const bpo = await bytesPerOp((i) => {
            const i0 = (i * 31) & 16383;
            if ((i & 1) === 0) sink[0] = mDecimate(targets[i % 5], i0, i0 + n - 1, DEC_B, out, 0);
            else sink[0] = mDecimate(targets[i % 5], CAP - n, CAP - 1, DEC_B, out, 0); // ends at the live bar
        });
        assertZero('decimateInto ' + name, bpo);
    });
}
decimateLane('scan', 200);
decimateLane('tree', 2000);
decimateLane('sparse', 12);

test('zerobox: version and count getters are <= 0.1 B/op', async () => {
    requireHarness();
    const targets = targetsOf(makeSeries());
    const v = await bytesPerOp((i) => { sink[0] = mVersion(targets[i % 5]); });
    assertZero('version', v);
    const c = await bytesPerOp((i) => { sink[1] = mCount(targets[i % 5]); });
    assertZero('count', c);
});

test('zerobox: GcProfiler window -- 1e6 setLiveFrom + 1e5 appendBarFrom + 1e5 boundsInto: 0 major, 0 minor', async () => {
    requireHarness();
    const s = makeSeries();
    const targets = targetsOf(s);
    const b = new Float64Array([EPOCH_BASE + CAP * 1000, 10.5, 20.25, 5.75, 15.5, 100.5]);
    const out = new Float64Array(9);

    function run(nLive, nApp, nBounds) {
        // ring is full (wrapped); appends move base; the live bar is open when the bounds loop runs
        for (let i = 0; i < nApp; i++) { b[0] += 1000; mAppend(targets[4], b, 0); }
        b[0] += 1000;
        for (let i = 0; i < nLive; i++) { b[4] = 15.5 + (i & 3) * 0.25; mSetLiveFrom(targets[4], b, 0); }
        for (let i = 0; i < nBounds; i++) {
            const i0 = (i * 31) & 16383;
            if ((i & 1) === 0) mBounds(targets[4], i0, i0 + 1000, out, 0);
            else mBounds(targets[4], CAP - 2001 - i0, CAP - 1, out, 0); // ends at the live bar
        }
    }
    run(200000, 20000, 20000); // warmup, outside the window
    globalThis.gc();

    const gc = new GcProfiler().start();
    run(1000000, 100000, 100000);
    await gc.settle();
    const summary = gc.summary();
    gc.stop();
    assertNoGc(summary, { maxMajor: 0, maxMinor: 0 });
});
