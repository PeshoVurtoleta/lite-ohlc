// ohlc-qa: boundary matrix for OhlcSeries v2 (qa pass, PLAN-v2 A2, A5-A8, A12, A15, A16).
// Oracles are this file's own FIFO model, a naive sequential scan and the bucket rule
// bucket(r) = floor(r*B/n) -- never the engine's geometry. Deterministic: fixed seeds, no timing.
// Imports only node: builtins and ../Ohlc.js (so a mutant copy can be graded by path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OhlcSeries, MAX_BUCKETS } from '../Ohlc.js';

const EMPTY = [NaN, NaN, NaN, NaN, NaN, 0, -1, -1, 0];
const FILL = 12345.5;
const T = (i) => 1.7e12 + i * 60000;
const W30 = 2 ** 30;
const BIG_INTS = [-1, W30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53];
const NON_INTS = [NaN, Infinity, -Infinity, 0.5, -0.5, null, undefined, '0', '1', true, {}];

function mulberry32(a) {
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function firstDiff(a, b) {
    if (a.length !== b.length) return Math.min(a.length, b.length);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
    return -1;
}
function assertSame(a, b, msg) {
    const i = firstDiff(a, b);
    assert.equal(i, -1, msg + ' (first diff at slot ' + i + ': ' + a[i] + ' vs ' + b[i] + ')');
}
function assertFinite(arr, from, to, msg) { // A15
    for (let q = from; q < to; q++) assert.ok(Number.isFinite(arr[q]), msg + ' slot ' + q + ' = ' + arr[q]);
}

// ---- oracles ---------------------------------------------------------------------------------
// rows: logical [t,o,h,l,c,v] arrays (already canonical +0)
function naiveBounds(rows, i0, i1) {
    let mn = Infinity, mx = -Infinity, mv = -Infinity, sm = 0;
    for (let i = i0; i <= i1; i++) {
        const r = rows[i];
        if (r[3] < mn) mn = r[3];
        if (r[2] > mx) mx = r[2];
        if (r[5] > mv) mv = r[5];
        sm += r[5];
    }
    return [mn, mx, mv, rows[i0][1], rows[i1][4], sm, i0, i1, i1 - i0 + 1];
}
function naiveDec(rows, i0, i1, B) {
    const n = i1 - i0 + 1;
    const res = [];
    let cur = null;
    for (let r = 0; r < n; r++) {
        const k = Math.floor((r * B) / n);
        const b = rows[i0 + r];
        if (cur === null || cur[6] !== k) {
            if (cur !== null) res.push(cur);
            cur = [b[0], b[1], b[2], b[3], b[4], b[5], k];
        } else {
            if (b[2] > cur[2]) cur[2] = b[2];
            if (b[3] < cur[3]) cur[3] = b[3];
            cur[4] = b[4];
            cur[5] += b[5];
        }
    }
    if (cur !== null) res.push(cur);
    return res;
}

// FIFO model of the spec (S3): count <= cap includes the live bar.
class Model {
    constructor(cap) { this.cap = cap; this.rows = []; this.live = false; this.ver = 0; }
    last() { return this.rows.length ? this.rows[this.rows.length - 1][0] : NaN; }
    write(row, live) { // returns false when the spec says throw
        const r = row.map((x) => x + 0);
        if (this.rows.length > 0) {
            const T0 = this.last();
            if (r[0] < T0) return false;
            if (r[0] === T0) { this.rows[this.rows.length - 1] = r; this.live = live; this.ver = (this.ver + 1) % W30; return true; }
        }
        this.rows.push(r);
        if (this.rows.length > this.cap) this.rows.shift();
        this.live = live;
        this.ver = (this.ver + 1) % W30;
        return true;
    }
    clear() { this.rows = []; this.live = false; this.ver = (this.ver + 1) % W30; }
}

function snap(s) {
    const n = s.count;
    const copy = new Float64Array(6 * Math.max(n, 1));
    if (n > 0) s.copyRangeInto(0, n - 1, copy, 0);
    const b = new Float64Array(9);
    s.boundsInto(0, n - 1, b, 0);
    return { n, ver: s.version, live: s.hasLive, copy: Array.from(copy), b: Array.from(b) };
}
function assertSnap(a, b, msg) {
    assert.equal(a.n, b.n, msg + ' count');
    assert.equal(a.ver, b.ver, msg + ' version');
    assert.equal(a.live, b.live, msg + ' hasLive');
    assertSame(a.copy, b.copy, msg + ' copy');
    assertSame(a.b, b.b, msg + ' bounds');
}

// Full check of the series against the model: getters, copy, searches, every (i0,i1) bounds and
// decimate at B in {1, 2, 3, n-1, n, n+1, 2n+1}; A15 on every non-empty result.
function checkAll(s, m, tag) {
    const n = m.rows.length;
    assert.equal(s.count, n, tag + ' count');
    assert.equal(s.hasLive, m.live && n > 0, tag + ' hasLive');
    assert.equal(s.version, m.ver, tag + ' version');
    assert.ok(Object.is(s.oldestTime, n ? m.rows[0][0] : NaN), tag + ' oldestTime');
    assert.ok(Object.is(s.latestTime, n ? m.rows[n - 1][0] : NaN), tag + ' latestTime');
    const out9 = new Float64Array(9);
    for (const [a, b] of [[0, n], [n, n], [-1, 0], [0, -1]]) {
        out9.fill(FILL);
        assert.equal(s.boundsInto(a, b, out9, 0), 0, tag + ' invalid edge (' + a + ',' + b + ')');
        assertSame(Array.from(out9), EMPTY, tag + ' EMPTY edge (' + a + ',' + b + ')');
    }
    if (n === 0) return;
    const copy = new Float64Array(6 * n + 1).fill(FILL);
    assert.equal(s.copyRangeInto(0, n - 1, copy, 0), n, tag + ' copy n');
    assertSame(Array.from(copy.subarray(0, 6 * n)), m.rows.flat(), tag + ' copy rows');
    assert.ok(Object.is(copy[6 * n], FILL), tag + ' copy tail');
    for (let i = 0; i < n; i++) {
        const t = m.rows[i][0];
        assert.equal(s.lowerBound(t), i, tag + ' lowerBound(t' + i + ')');
        assert.equal(s.upperBound(t), i, tag + ' upperBound(t' + i + ')');
        assert.equal(s.lowerBound(t + 1), i + 1 < n ? i + 1 : -1, tag + ' lowerBound(t' + i + '+1)');
        assert.equal(s.upperBound(t - 1), i - 1, tag + ' upperBound(t' + i + '-1)');
    }
    const dec = new Float64Array(7 * (2 * n + 2) + 1);
    for (let i0 = 0; i0 < n; i0++) {
        for (let i1 = i0; i1 < n; i1++) {
            out9.fill(FILL);
            assert.equal(s.boundsInto(i0, i1, out9, 0), i1 - i0 + 1, tag + ' bounds n');
            assertSame(Array.from(out9), naiveBounds(m.rows, i0, i1), tag + ' bounds(' + i0 + ',' + i1 + ')');
            assertFinite(out9, 0, 6, tag + ' A15 bounds(' + i0 + ',' + i1 + ')');
            const len = i1 - i0 + 1;
            for (const B of [1, 2, 3, len - 1, len, len + 1, 2 * len + 1]) {
                if (B < 1) continue;
                dec.fill(FILL);
                const want = naiveDec(m.rows, i0, i1, B);
                const w = s.decimateInto(i0, i1, B, dec, 0);
                const lbl = tag + ' dec(' + i0 + ',' + i1 + ',B=' + B + ')';
                assert.equal(w, Math.min(len, B), lbl + ' return');
                assert.equal(w, want.length, lbl + ' return == oracle rows');
                assertSame(Array.from(dec.subarray(0, 7 * w)), want.flat(), lbl);
                assertFinite(dec, 0, 7 * w, lbl + ' A15');
                for (let q = 7 * w; q < dec.length; q++) assert.ok(Object.is(dec[q], FILL), lbl + ' tail ' + q);
            }
        }
    }
}

function candle(rng, t) {
    const l = 100 + ((rng() * 50) | 0) + 0.25;
    const h = l + ((rng() * 20) | 0) + 0.5;
    const o = l + (h - l) * rng();
    const c = l + (h - l) * rng();
    const v = rng() < 0.1 ? 0 : (rng() * 1000) | 0;
    return [t, o, h, l, c, v];
}

// ---- 1. model fuzz at the small rings ---------------------------------------------------------
for (const cap of [2, 4, 8]) {
    test('qa fuzz: cap ' + cap + ', 3 seeds x 300 ops (append/setLive new+same, reopen, earlier, invalid, -0, clear) vs FIFO model', () => {
        for (const seed of [0xC0FFEE, 0x5EED + cap, 0xBADF00D]) {
            const rng = mulberry32(seed);
            const s = new OhlcSeries(cap, 60000);
            const m = new Model(cap);
            let tc = 0; // next time index
            for (let op = 0; op < 300; op++) {
                const r = rng();
                const n = m.rows.length;
                const tag = 'cap ' + cap + ' seed ' + seed + ' op ' + op;
                let kind;
                if (r < 0.03) { s.clear(); m.clear(); tc = (rng() * 5) | 0; kind = 'clear'; } // times restart lower
                else if (r < 0.10 && n > 0) { // earlier time -> RangeError, nothing changes
                    const before = snap(s);
                    const row = candle(rng, m.last() - 1);
                    const live = rng() < 0.5;
                    assert.throws(() => (live ? s.setLive(...row) : s.appendBar(...row)), RangeError, tag + ' earlier');
                    assertSnap(snap(s), before, tag + ' earlier unchanged');
                    kind = 'earlier';
                } else if (r < 0.15) { // invalid candle -> RangeError, nothing changes
                    const before = snap(s);
                    const row = candle(rng, T(tc + 1));
                    const bad = [NaN, Infinity, -Infinity][(rng() * 3) | 0];
                    row[(rng() * 6) | 0] = bad;
                    const live = rng() < 0.5;
                    assert.throws(() => (live ? s.setLive(...row) : s.appendBar(...row)), RangeError, tag + ' invalid');
                    assertSnap(snap(s), before, tag + ' invalid unchanged');
                    kind = 'invalid';
                } else {
                    const same = n > 0 && rng() < 0.3;
                    const t = same ? m.last() : T(++tc);
                    const row = rng() < 0.05 ? [t, -0, -0, -0, -0, -0] : candle(rng, t);
                    const live = rng() < 0.55;
                    const ret = live ? s.setLive(...row) : s.appendBar(...row);
                    assert.equal(ret, s, tag + ' chaining');
                    assert.ok(m.write(row, live), tag + ' model accepted');
                    kind = (live ? 'setLive' : 'appendBar') + (same ? ' same' : ' new');
                }
                checkAll(s, m, tag + ' (' + kind + ')');
            }
        }
    });
}

// ---- 2. cap 2: wrap exactly at cap, literal ----------------------------------------------------
test('qa cap 2: 0 / 1 / N-1 / N / N+1 bars, eviction exactly at cap, live-only, both decimate paths', () => {
    const s = new OhlcSeries(2, 60000);
    const out = new Float64Array(9);
    const d = new Float64Array(7 * 3).fill(FILL);
    assert.equal(s.decimateInto(0, 0, 1, d, 0), 0, 'count 0 -> 0');
    assert.ok(d.every((x) => Object.is(x, FILL)), 'count 0 writes nothing');
    s.setLive(T(0), 10, 12, 9, 11, 5); // live-only, N-1 = 1
    assert.equal(s.count, 1);
    assert.equal(s.boundsInto(0, 0, out, 0), 1);
    assertSame(Array.from(out), [9, 12, 5, 10, 11, 5, 0, 0, 1], 'live-only bounds');
    assert.equal(s.decimateInto(0, 0, 1, d, 0), 1, 'B=1, n=1: tree path (n >= B*H, H=1)');
    assertSame(Array.from(d.subarray(0, 7)), [T(0), 10, 12, 9, 11, 5, 0], 'live-only tree bucket');
    assert.equal(s.decimateInto(0, 0, 2, d, 0), 1, 'B=2 > n: scan path');
    assertSame(Array.from(d.subarray(0, 7)), [T(0), 10, 12, 9, 11, 5, 0], 'live-only scan bucket');
    s.appendBar(T(1), 20, 22, 19, 21, 7); // closes live; N = 2 = cap, base 0
    assert.equal(s.count, 2);
    assert.equal(s.hasLive, false);
    assert.equal(s.oldestTime, T(0));
    s.setLive(T(2), 30, 33, 29, 31, 9); // N+1: evicts T(0) exactly at cap
    assert.equal(s.count, 2);
    assert.equal(s.oldestTime, T(1));
    assert.equal(s.latestTime, T(2));
    assert.equal(s.boundsInto(0, 1, out, 0), 2);
    assertSame(Array.from(out), [19, 33, 9, 20, 31, 16, 0, 1, 2], 'wrapped cap-2 bounds incl. live');
    assert.equal(s.boundsInto(1, 1, out, 0), 1);
    assertSame(Array.from(out), [29, 33, 9, 30, 31, 9, 1, 1, 1], 'i0 == i1 == live index');
    assert.equal(s.decimateInto(1, 1, 1, d, 0), 1);
    assertSame(Array.from(d.subarray(0, 7)), [T(2), 30, 33, 29, 31, 9, 0], 'decimate i0 == i1 == live, tree path');
    d.fill(FILL);
    assert.equal(s.decimateInto(0, 1, 1, d, 0), 1, 'B=1, n=2 -> tree');
    assertSame(Array.from(d.subarray(0, 7)), [T(1), 20, 33, 19, 31, 16, 0], 'one bucket over wrap + live');
    assert.equal(s.decimateInto(0, 1, 2, d, 0), 2, 'B=n=2 -> tree (n >= B*H)');
    assertSame(Array.from(d.subarray(0, 14)), [T(1), 20, 22, 19, 21, 7, 0, T(2), 30, 33, 29, 31, 9, 1], 'B = n');
    d.fill(FILL);
    assert.equal(s.decimateInto(0, 1, 3, d, 0), 2, 'B=n+1 -> scan, 2 of 3 buckets');
    assertSame(Array.from(d.subarray(0, 14)), [T(1), 20, 22, 19, 21, 7, 0, T(2), 30, 33, 29, 31, 9, 1], 'B > n: k = floor(r*B/n) = floor(3/2) = 1');
    assert.ok(d.subarray(14).every((x) => Object.is(x, FILL)), 'B > n: tail untouched');
    // close the live bar with v=900 (leaf written), then reopen it with v=1: the stale 900 leaf
    // must not leak through bounds or the tree path
    s.appendBar(T(2), 30, 33, 29, 31, 900); // live -> closed, leaf v=900
    s.setLive(T(2), 30, 31, 30, 30, 1);     // reopen, v=1, stale leaf 900
    assert.equal(s.boundsInto(0, 1, out, 0), 2);
    assertSame(Array.from(out), [19, 31, 7, 20, 30, 8, 0, 1, 2], 'reopen: stale leaf 900 unread');
    assert.equal(s.decimateInto(0, 1, 1, d, 0), 1);
    assertSame(Array.from(d.subarray(0, 7)), [T(1), 20, 31, 19, 30, 8, 0], 'reopen: tree path ignores stale leaf');
});

// ---- 3. index matrix (i0 / i1) on every range entry point ---------------------------------------
test('qa index matrix: -1, 2^30, 2^31-1, 2^31, 2^32-1, 2^32, 2^53-1, 2^53, non-integers -> 0, EMPTY / no write; -0 is index 0', () => {
    const s = new OhlcSeries(4, 60000);
    for (let i = 0; i < 6; i++) s.appendBar(T(i), 10 + i, 20 + i, 5 + i, 15 + i, 100 + i); // wrapped
    s.setLive(T(6), 16, 26, 11, 21, 106);
    const n = s.count;
    assert.equal(n, 4);
    const bad = [];
    for (const x of [...BIG_INTS, ...NON_INTS, n, n + 1]) { bad.push([x, n - 1]); bad.push([0, x]); bad.push([x, x]); }
    const v0 = s.version;
    for (const [a, b] of bad) {
        const lbl = '(' + String(a) + ',' + String(b) + ')';
        const o9 = new Float64Array(10).fill(FILL);
        assert.equal(s.boundsInto(a, b, o9, 1), 0, 'bounds ' + lbl);
        assertSame(Array.from(o9.subarray(1)), EMPTY, 'EMPTY ' + lbl);
        assert.ok(Object.is(o9[0], FILL), 'before off ' + lbl);
        const oc = new Float64Array(6 * 8).fill(FILL);
        assert.equal(s.copyRangeInto(a, b, oc, 0), 0, 'copy ' + lbl);
        assert.ok(oc.every((x) => Object.is(x, FILL)), 'copy no write ' + lbl);
        const od = new Float64Array(7 * 4).fill(FILL);
        assert.equal(s.decimateInto(a, b, 4, od, 0), 0, 'decimate ' + lbl);
        assert.ok(od.every((x) => Object.is(x, FILL)), 'decimate no write ' + lbl);
    }
    assert.equal(s.version, v0, 'reads never bump');
    // -0 is a valid index 0 everywhere, and no -0 reaches an output index slot
    const o9 = new Float64Array(9);
    assert.equal(s.boundsInto(-0, -0, o9, -0), 1);
    assertSame(Array.from(o9), [8, 23, 103, 13, 18, 103, 0, 0, 1], 'bounds(-0,-0) at off -0');
    const oc = new Float64Array(6);
    assert.equal(s.copyRangeInto(-0, -0, oc, -0), 1);
    assertSame(Array.from(oc), [T(3), 13, 23, 8, 18, 103], 'copy(-0,-0)');
    for (const B of [1, 2]) {
        const od = new Float64Array(7 * B);
        assert.equal(s.decimateInto(-0, -0, B, od, -0), 1);
        assertSame(Array.from(od.subarray(0, 7)), [T(3), 13, 23, 8, 18, 103, 0], 'decimate(-0,-0,B=' + B + ')');
    }
});

// ---- 4. offset boundaries ----------------------------------------------------------------------
test('qa off matrix: exact fit at the end of out passes, one past throws; big / non-integer off throws untouched', () => {
    const s = new OhlcSeries(8, 60000);
    for (let i = 0; i < 5; i++) s.appendBar(T(i), 10, 20, 5, 15, i + 1);
    const want9 = [5, 20, 5, 10, 15, 15, 0, 4, 5];
    for (const len of [9, 10, 31]) {
        const o = new Float64Array(len).fill(FILL);
        assert.equal(s.boundsInto(0, 4, o, len - 9), 5, 'bounds exact fit len ' + len);
        assertSame(Array.from(o.subarray(len - 9)), want9, 'bounds at end len ' + len);
        for (let q = 0; q < len - 9; q++) assert.ok(Object.is(o[q], FILL));
        const o2 = new Float64Array(len).fill(FILL);
        assert.throws(() => s.boundsInto(0, 4, o2, len - 8), RangeError, 'bounds one past len ' + len);
        assert.throws(() => s.boundsInto(-1, -1, o2, len - 8), RangeError, 'bounds one past, invalid range');
        assert.ok(o2.every((x) => Object.is(x, FILL)));
        // copy: n = 2 bars
        const o3 = new Float64Array(len + 3).fill(FILL);
        assert.equal(s.copyRangeInto(3, 4, o3, len + 3 - 12), 2, 'copy exact fit');
        assert.throws(() => s.copyRangeInto(3, 4, o3, len + 3 - 11), RangeError, 'copy one past');
        // decimate: B = 1
        const o4 = new Float64Array(len).fill(FILL);
        assert.equal(s.decimateInto(0, 4, 1, o4, len - 7), 1, 'decimate exact fit');
        assertSame(Array.from(o4.subarray(len - 7)), [T(0), 10, 20, 5, 15, 15, 0], 'decimate at end');
        const o5 = new Float64Array(len).fill(FILL);
        assert.throws(() => s.decimateInto(0, 4, 1, o5, len - 6), RangeError, 'decimate one past');
        assert.ok(o5.every((x) => Object.is(x, FILL)));
    }
    const o = new Float64Array(64).fill(FILL);
    for (const off of [...BIG_INTS, NaN, Infinity, 0.5, null, '0']) {
        assert.throws(() => s.boundsInto(0, 4, o, off), RangeError, 'bounds off ' + String(off));
        assert.throws(() => s.copyRangeInto(0, 4, o, off), RangeError, 'copy off ' + String(off));
        assert.throws(() => s.decimateInto(0, 4, 2, o, off), RangeError, 'decimate off ' + String(off));
        assert.throws(() => s.appendBarFrom(o, off), RangeError, 'appendBarFrom off ' + String(off));
        assert.throws(() => s.setLiveFrom(o, off), RangeError, 'setLiveFrom off ' + String(off));
        assert.throws(() => s.lowerBoundFrom(o, off), RangeError, 'lowerBoundFrom off ' + String(off));
        assert.throws(() => s.upperBoundFrom(o, off), RangeError, 'upperBoundFrom off ' + String(off));
    }
    assert.ok(o.every((x) => Object.is(x, FILL)), 'no write on any off throw');
    assert.equal(s.count, 5);
    // *From: off + 6 == len passes, off + 6 == len + 1 throws; searches: off = len - 1 passes, len throws
    const b = new Float64Array(9);
    b.set([T(9), 1, 2, 0.5, 1.5, 3], 3);
    assert.throws(() => s.appendBarFrom(b, 4), RangeError);
    assert.throws(() => s.setLiveFrom(b, 4), RangeError);
    assert.equal(s.count, 5);
    s.setLiveFrom(b, 3);
    assert.equal(s.count, 6);
    const q = new Float64Array([0, 0, T(2)]);
    assert.equal(s.lowerBoundFrom(q, 2), 2);
    assert.equal(s.upperBoundFrom(q, 2), 2);
    assert.throws(() => s.lowerBoundFrom(q, 3), RangeError);
    assert.throws(() => s.upperBoundFrom(q, 3), RangeError);
});

// ---- 5. B matrix + validation order ---------------------------------------------------------------
test('qa B matrix: 0, -0, -1, 2^20+1, 2^30 .. 2^53, non-integers -> RangeError, no write; validation order out -> off -> B -> length -> range', () => {
    const s = new OhlcSeries(4, 60000);
    for (let i = 0; i < 3; i++) s.appendBar(T(i), 10, 20, 5, 15, i + 1);
    const out = new Float64Array(70).fill(FILL);
    const v0 = s.version;
    for (const B of [0, -0, MAX_BUCKETS + 1, ...BIG_INTS, ...NON_INTS]) {
        assert.throws(() => s.decimateInto(0, 2, B, out, 0), { name: 'RangeError', message: /B must be an integer/ }, 'B=' + String(B));
        assert.throws(() => s.decimateInto(-5, -9, B, out, 0), { name: 'RangeError', message: /B must be an integer/ }, 'B=' + String(B) + ', invalid range');
    }
    assert.ok(out.every((x) => Object.is(x, FILL)), 'no write');
    assert.equal(s.version, v0);
    // order: out type first, then off, then B, then off + 7B, then the range
    assert.throws(() => s.decimateInto(NaN, NaN, 0, [], -1), TypeError, 'out first');
    assert.throws(() => s.decimateInto(NaN, NaN, 0, out, -1), { name: 'RangeError', message: /offset/ }, 'off second');
    assert.throws(() => s.decimateInto(NaN, NaN, 0, out, 0), { name: 'RangeError', message: /B must be/ }, 'B third');
    assert.throws(() => s.decimateInto(NaN, NaN, 11, out, 0), { name: 'RangeError', message: /too small/ }, 'length fourth (77 > 70)');
    assert.equal(s.decimateInto(NaN, NaN, 10, out, 0), 0, 'range last (70 fits)');
    // B = n - 1, n, n + 1 and B = MAX_BUCKETS with n = 3: k = floor(r*B/n) up to 699050
    for (const [B, ks] of [[2, [0, 0, 1]], [3, [0, 1, 2]], [4, [0, 1, 2]], [MAX_BUCKETS, [0, 349525, 699050]]]) {
        const o = new Float64Array(7 * B + 1).fill(FILL);
        const w = s.decimateInto(0, 2, B, o, 1);
        const rows = [[T(0), 10, 20, 5, 15, 1], [T(1), 10, 20, 5, 15, 2], [T(2), 10, 20, 5, 15, 3]];
        const want = [];
        for (let r = 0; r < 3; r++) {
            if (want.length && want[want.length - 1][6] === ks[r]) { const g = want[want.length - 1]; g[4] = rows[r][4]; g[5] += rows[r][5]; }
            else want.push([...rows[r], ks[r]]);
        }
        assert.equal(w, Math.min(3, B), 'B=' + B + ' return');
        assertSame(Array.from(o.subarray(1, 1 + 7 * w)), want.flat(), 'B=' + B + ' rows');
        assert.ok(Object.is(o[0], FILL), 'B=' + B + ' head');
        for (let q = 1 + 7 * w; q < Math.min(o.length, 1 + 7 * w + 64); q++) assert.ok(Object.is(o[q], FILL), 'B=' + B + ' tail');
    }
});

// ---- 6. version: start just below the 2^30 wrap and cross it with real ops, throws included -------
test('qa version: from 2^30 - 3 across the wrap; throws and reads never bump; always an integer in [0, 2^30)', () => {
    const s = new OhlcSeries(2, 60000);
    s.appendBar(T(0), 10, 20, 5, 15, 1);
    s._s[3] = W30 - 3;
    let v = W30 - 3;
    const ok = (label) => { v = (v + 1) % W30; assert.equal(s.version, v, label); assert.ok(Number.isInteger(s.version) && s.version >= 0 && s.version < W30); };
    const flat = (label) => assert.equal(s.version, v, label);
    const steps = [
        () => { s.setLive(T(1), 10, 20, 5, 15, 2); ok('setLive new -> 2^30-2'); },
        () => { assert.throws(() => s.setLive(T(0), 10, 20, 5, 15, 2), RangeError); flat('earlier throw'); },
        () => { s.appendBar(T(1), 10, 20, 5, 15, 3); ok('appendBar same (close live) -> 2^30-1'); },
        () => { assert.throws(() => s.appendBar(T(2), 10, 20, 25, 15, 3), RangeError); flat('invalid throw at 2^30-1'); },
        () => { assert.throws(() => s.decimateInto(0, 1, 0, new Float64Array(7), 0), RangeError); flat('decimate throw'); },
        () => { assert.throws(() => s.boundsInto(0, 1, new Float64Array(8), 0), RangeError); flat('bounds throw'); },
        () => { assert.throws(() => s.copyRangeInto(0, 1, new Float64Array(11), 0), RangeError); flat('copy throw'); },
        () => { assert.throws(() => s.setLiveFrom([T(3), 1, 1, 1, 1, 1], 0), TypeError); flat('buf type throw'); },
        () => { s.setLive(T(1), 10, 20, 5, 15, 4); ok('setLive reopen -> wraps to 0'); },
        () => { s.decimateInto(0, 1, 2, new Float64Array(14), 0); s.boundsInto(0, 1, new Float64Array(9), 0); flat('reads at 0'); },
        () => { s.setLive(T(2), 10, 20, 5, 15, 5); ok('setLive new + evict -> 1'); },
        () => { s.clear(); ok('clear -> 2'); },
        () => { s.clear(); ok('clear twice -> 3'); },
        () => { s.appendBar(T(0), 10, 20, 5, 15, 6); ok('append after clear -> 4'); },
    ];
    for (const st of steps) st();
    assert.equal(v, 4);
});

// ---- 7. fail-closed on every write path: NaN / +-Inf per field on a FULL cap-2 ring with a live bar
test('qa fail-closed: NaN / Infinity / -Infinity in each of the 6 fields, on all 4 write doors, full ring + live -> RangeError, nothing changes', () => {
    const s = new OhlcSeries(2, 60000);
    s.appendBar(T(0), 10, 20, 5, 15, 1).appendBar(T(1), 11, 21, 6, 16, 2).setLive(T(2), 12, 22, 7, 17, 3);
    const before = snap(s);
    const good = [T(3), 13, 23, 8, 18, 4];
    for (let f = 0; f < 6; f++) {
        for (const bad of [NaN, Infinity, -Infinity]) {
            const row = good.slice(); row[f] = bad;
            const lbl = 'field ' + f + ' = ' + bad;
            assert.throws(() => s.appendBar(...row), RangeError, 'appendBar ' + lbl);
            assert.throws(() => s.setLive(...row), RangeError, 'setLive ' + lbl);
            const buf = new Float64Array(8); buf.set(row, 2);
            assert.throws(() => s.appendBarFrom(buf, 2), RangeError, 'appendBarFrom ' + lbl);
            assert.throws(() => s.setLiveFrom(buf, 2), RangeError, 'setLiveFrom ' + lbl);
            // same time as the live bar (the replace path) must also throw
            row[0] = f === 0 ? bad : T(2);
            assert.throws(() => s.setLive(...row), RangeError, 'setLive same-time ' + lbl);
            assert.throws(() => s.appendBar(...row), RangeError, 'appendBar same-time ' + lbl);
        }
    }
    for (const bad of [[T(3), 13, 23, 24, 18, 4], [T(3), 13, 23, 8, 18, -Number.MIN_VALUE], [T(3), 13, 23, 8, 18, Number.MAX_VALUE / 8 * 1.0000001]]) {
        assert.throws(() => s.appendBar(...bad), RangeError, 'predicate ' + bad);
        assert.throws(() => s.setLive(...bad), RangeError, 'predicate ' + bad);
    }
    assertSnap(snap(s), before, 'after every throw');
    assert.equal(s.oldestTime, T(1));
    // searches on non-finite input: -1, never a throw, never a write
    for (const x of [NaN, Infinity, -Infinity]) {
        assert.equal(s.lowerBound(x), -1);
        assert.equal(s.upperBound(x), -1);
        assert.equal(s.lowerBoundFrom(new Float64Array([x]), 0), -1);
        assert.equal(s.upperBoundFrom(new Float64Array([x]), 0), -1);
    }
    // the ceiling itself is accepted, and the root sum at cap * ceiling stays finite (A15)
    const z = new OhlcSeries(2, 60000);
    const ceil = Number.MAX_VALUE / 8;
    z.appendBar(0, -Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE, ceil);
    z.setLive(1, 0, Number.MAX_VALUE, -Number.MAX_VALUE, 0, ceil);
    const o = new Float64Array(9);
    assert.equal(z.boundsInto(0, 1, o, 0), 2);
    assertSame(Array.from(o), [-Number.MAX_VALUE, Number.MAX_VALUE, ceil, -Number.MAX_VALUE, 0, 2 * ceil, 0, 1, 2], 'extremes');
    for (const B of [1, 3]) {
        const d = new Float64Array(21);
        const w = z.decimateInto(0, 1, B, d, 0);
        assertFinite(d, 0, 7 * w, 'A15 extremes B=' + B);
    }
});

// ---- 8. clear then reuse on a wrapped cap-2 ring (base != 0) ---------------------------------------
test('qa clear-reuse: cap 2 after 13 evictions (base != 0), clear, refill past cap with lower volumes: no stale leaf, model-exact', () => {
    const s = new OhlcSeries(2, 60000);
    const m = new Model(2);
    for (let i = 0; i < 14; i++) { const r = [T(i), 1000, 9000, 1, 5000, 1e6 + i]; s.appendBar(...r); m.write(r, false); }
    s.setLive(T(14), 1000, 9999, 1, 5000, 9e6); m.write([T(14), 1000, 9999, 1, 5000, 9e6], true);
    assert.notEqual(s._s[0], 0, 'precondition: base != 0 before clear');
    checkAll(s, m, 'before clear');
    s.clear(); m.clear();
    checkAll(s, m, 'after clear');
    const d = new Float64Array(14).fill(FILL);
    assert.equal(s.decimateInto(0, 0, 2, d, 0), 0, 'decimate at count 0 after clear');
    assert.ok(d.every((x) => Object.is(x, FILL)));
    // an earlier time than the pre-clear history is fine now
    const rows = [[5, 3, 4, 2, 3, 1], [6, 3, 4, 2, 3, 2], [7, 3, 5, 1, 4, 0], [7, 3, 6, 1, 4, 3]];
    rows.forEach((r, i) => {
        const live = i % 2 === 1;
        (live ? s.setLive(...r) : s.appendBar(...r));
        m.write(r, live);
        checkAll(s, m, 'refill ' + i);
    });
    s.clear(); m.clear(); s.clear(); m.clear();
    checkAll(s, m, 'double clear');
});

// ---- 9. adversarial ---------------------------------------------------------------------------
test('qa adversarial: times past 2^53 collapse to equal (replace), -0 / +0 times are equal, view and subclass outputs', () => {
    const s = new OhlcSeries(4, 60000);
    s.appendBar(2 ** 53, 1, 2, 0, 1, 1);
    s.appendBar(2 ** 53 + 1, 1, 3, 0, 1, 5); // == 2^53 in float64: same time -> replace, not push
    assert.equal(s.count, 1);
    s.setLive(2 ** 53 + 2, 1, 4, 0, 1, 7);
    assert.equal(s.count, 2);
    assert.throws(() => s.setLive(2 ** 53 + 1, 1, 4, 0, 1, 7), RangeError, '2^53+1 rounds below the live time');
    const z = new OhlcSeries(2, 60000);
    z.appendBar(-0, 1, 2, 0, 1, 1);
    z.setLive(0, 1, 2, 0, 1, 2); // +0 === -0: reopen, not push
    assert.equal(z.count, 1);
    assert.equal(z.hasLive, true);
    assert.ok(Object.is(z.oldestTime, 0), 'time canonical +0');
    assert.equal(z.lowerBound(-0), 0);
    assert.equal(z.upperBound(-0), 0);
    // output into a subarray view: offsets are view-relative, bytes outside the view untouched
    const back = new Float64Array(40).fill(FILL);
    const view = back.subarray(5, 5 + 9 + 7 * 2 + 6);
    assert.equal(s.boundsInto(0, 1, view, 0), 2);
    assert.equal(s.decimateInto(0, 1, 2, view, 9), 2);
    assert.equal(s.copyRangeInto(1, 1, view, 23), 1);
    for (let q = 0; q < 5; q++) assert.ok(Object.is(back[q], FILL), 'before view');
    for (let q = 34; q < 40; q++) assert.ok(Object.is(back[q], FILL), 'after view');
    assertSame(Array.from(back.subarray(5, 14)), [0, 4, 7, 1, 1, 12, 0, 1, 2], 'bounds via view');
    assert.throws(() => s.boundsInto(0, 1, view, view.length - 8), RangeError, 'view length, not buffer length');
    // a Float64Array subclass is a Float64Array
    class F64 extends Float64Array {}
    const sub = new F64(9);
    assert.equal(s.boundsInto(0, 0, sub, 0), 1);
    assert.equal(sub[5], 5);
    // copy round-trip: rows copied out and fed back through appendBarFrom rebuild an identical series
    const src = new OhlcSeries(4, 60000);
    for (let i = 0; i < 7; i++) src.appendBar(T(i), 10 + i, 30 + i, 1 + i, 20 + i, i);
    const rows = new Float64Array(24);
    src.copyRangeInto(0, 3, rows, 0);
    const dst = new OhlcSeries(4, 60000);
    for (let k = 0; k < 4; k++) dst.appendBarFrom(rows, 6 * k);
    const a = new Float64Array(9), b = new Float64Array(9);
    for (let i0 = 0; i0 < 4; i0++) for (let i1 = i0; i1 < 4; i1++) {
        src.boundsInto(i0, i1, a, 0); dst.boundsInto(i0, i1, b, 0);
        assertSame(Array.from(b), Array.from(a), 'round-trip bounds (' + i0 + ',' + i1 + ')');
    }
});
