// ohlc-core: literal / fail-closed behaviour of OhlcSeries v2 (PLAN-v2 A5, A6, A8a-d, A11, A12, A16
// + count transitions). Expected values come from the spec text and from this file's own FIFO model,
// never from running the implementation. A8(e) (decimateInto) is H3's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OhlcSeries, BOUNDS_STRIDE, CANDLE_STRIDE, MIN_CAPACITY, MAX_CAPACITY } from '../Ohlc.js';
import { readFileSync } from 'node:fs';

const INTERVAL = 60000;
const T = (i) => 1.7e12 + i * 60000;
const fresh = (cap) => new OhlcSeries(cap, INTERVAL);
const NaNv = NaN;
const EMPTY = [NaN, NaN, NaN, NaN, NaN, 0, -1, -1, 0];

// deterministic candle k: [o,h,l,c,v], integer-valued, all distinct per k
const cand = (k) => { const l = 90 + k; return [l + 1.5, l + 7, l, l + 2.5, 100 + k * 10]; };
const row = (t, k) => [t, ...cand(k)];

function same(a, b) { // index of first Object.is mismatch, or -1
    if (a.length !== b.length) return Math.min(a.length, b.length);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
    return -1;
}
function assertSame(a, b, msg) {
    const i = same(a, b);
    assert.equal(i, -1, msg + ' (first diff at slot ' + i + ': ' + a[i] + ' vs ' + b[i] + ')');
}
function copyAll(s) {
    const n = s.count;
    const out = new Float64Array(6 * n);
    if (n > 0) assert.equal(s.copyRangeInto(0, n - 1, out, 0), n);
    return Array.from(out);
}
function boundsAt(s, i0, i1) {
    const out = new Float64Array(9).fill(7.5);
    const n = s.boundsInto(i0, i1, out, 0);
    return [n, Array.from(out)];
}
function boundsAll(s) {
    return s.count === 0 ? boundsAt(s, 0, 0) : boundsAt(s, 0, s.count - 1);
}
function snap(s) {
    return { count: s.count, version: s.version, hasLive: s.hasLive, copy: copyAll(s), bounds: boundsAll(s)[1] };
}
function assertSnap(a, b, msg) {
    assert.equal(a.count, b.count, msg + ' count');
    assert.equal(a.version, b.version, msg + ' version');
    assert.equal(a.hasLive, b.hasLive, msg + ' hasLive');
    assertSame(a.copy, b.copy, msg + ' copy bytes');
    assertSame(a.bounds, b.bounds, msg + ' bounds bytes');
}
// naive scan over a plain array of [t,o,h,l,c,v] rows -> BOUNDS record
function naive(rows, i0, i1) {
    let mn = Infinity, mx = -Infinity, mv = -Infinity, sum = 0;
    for (let i = i0; i <= i1; i++) {
        if (rows[i][3] < mn) mn = rows[i][3];
        if (rows[i][2] > mx) mx = rows[i][2];
        if (rows[i][5] > mv) mv = rows[i][5];
        sum += rows[i][5];
    }
    return [mn, mx, mv, rows[i0][1], rows[i1][4], sum, i0, i1, i1 - i0 + 1];
}
const dec = (x) => (typeof x === 'string' ? ({ NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 })[x] : x);
const golden = JSON.parse(readFileSync(new URL('./golden-v1.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- constants / ctor (A8d)
test('exports: strides and capacity limits (S1)', () => {
    assert.equal(BOUNDS_STRIDE, 9);
    assert.equal(CANDLE_STRIDE, 6);
    assert.equal(MIN_CAPACITY, 2);
    assert.equal(MAX_CAPACITY, 2 ** 22);
});

test('A8d ctor: capacity must be an integer power of two in [2, 2^22]', () => {
    for (const bad of [3, 1, 2 ** 23, 1.5, 0, -2, 6, 12, NaN, Infinity, 2 ** 22 + 1]) {
        assert.throws(() => new OhlcSeries(bad, INTERVAL), RangeError, 'capacity ' + bad);
    }
    for (const bad of ['16', null, undefined, {}, [16], true, 16n]) {
        assert.throws(() => new OhlcSeries(bad, INTERVAL), TypeError, 'capacity ' + String(bad));
    }
    for (const ok of [2, 4, 16, 1024]) {
        const s = new OhlcSeries(ok, INTERVAL);
        assert.equal(s.capacity, ok);
        assert.equal(s.count, 0);
    }
});

test('A8d ctor: interval must be a finite number > 0', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, -0]) {
        assert.throws(() => new OhlcSeries(16, bad), RangeError, 'interval ' + bad);
    }
    for (const bad of ['60000', null, undefined, {}]) {
        assert.throws(() => new OhlcSeries(16, bad), TypeError, 'interval ' + String(bad));
    }
    assert.throws(() => new OhlcSeries(16), TypeError, 'interval is required');
    assert.throws(() => new OhlcSeries(), TypeError, 'capacity is required');
    assert.equal(new OhlcSeries(16, 0.5).interval, 0.5);
});

test('fresh instance: getters', () => {
    const s = fresh(16);
    assert.equal(s.capacity, 16);
    assert.equal(s.interval, INTERVAL);
    assert.equal(s.count, 0);
    assert.equal(s.hasLive, false);
    assert.equal(s.version, 0);
    assert.ok(Number.isNaN(s.oldestTime));
    assert.ok(Number.isNaN(s.latestTime));
});

// ---------------------------------------------------------------- A5 last-bar rule
test('A5 last-bar rule: equal time replaces, later appends, earlier throws', () => {
    const s = fresh(4);
    const X = cand(5), Y = cand(6), Z = cand(7);
    s.setLive(T(0), ...cand(0));
    assert.equal(s.count, 1);
    assert.equal(s.hasLive, true);
    const v1 = s.version;

    s.setLive(T(0), ...X);
    assert.equal(s.count, 1, 'same-time setLive replaces');
    assert.equal(s.hasLive, true);
    assert.equal(s.version, v1 + 1);
    assertSame(copyAll(s), row(T(0), 5), 'bar 0 is X');

    s.setLive(T(1), ...cand(1));
    assert.equal(s.count, 2);
    assert.equal(s.hasLive, true);
    const [n, b] = boundsAt(s, 0, 0);
    assert.equal(n, 1);
    assertSame(b, naive([row(T(0), 5)], 0, 0), 'bounds(0,0) is the old live bar X, now closed');

    const before = snap(s);
    assert.throws(() => s.setLive(T(0), ...cand(2)), RangeError, 'earlier time throws');
    assertSnap(snap(s), before, 'after earlier-time setLive');
    assert.throws(() => s.appendBar(T(0), ...cand(2)), RangeError, 'earlier time throws on appendBar');
    assertSnap(snap(s), before, 'after earlier-time appendBar');

    s.appendBar(T(1), ...Y);
    assert.equal(s.hasLive, false, 'same-time appendBar closes the live bar');
    assert.equal(s.count, 2);
    assertSame(copyAll(s), [...row(T(0), 5), ...row(T(1), 6)], 'bar 1 is Y');
    assertSame(boundsAt(s, 0, 1)[1], naive([row(T(0), 5), row(T(1), 6)], 0, 1), 'bounds all closed');

    const vr = s.version;
    s.setLive(T(1), ...Z);
    assert.equal(s.hasLive, true, 'same-time setLive on a closed last bar reopens it');
    assert.equal(s.count, 2);
    assert.equal(s.version, vr + 1);
    const rows = [row(T(0), 5), row(T(1), 7)];
    assertSame(copyAll(s), rows.flat(), 'bar 1 is Z');
    // live fold: bounds over [0,1] and [1,1] must include the live bar Z
    assertSame(boundsAt(s, 0, 1)[1], naive(rows, 0, 1), 'bounds(0,1) folds the reopened live bar');
    assertSame(boundsAt(s, 1, 1)[1], naive(rows, 1, 1), 'bounds(1,1) is the live bar alone');

    s.appendBar(T(2), ...cand(8));
    assert.equal(s.count, 3);
    assert.equal(s.hasLive, false);
    rows.push(row(T(2), 8));
    assertSame(copyAll(s), rows.flat(), 'three bars');
    assertSame(boundsAt(s, 0, 2)[1], naive(rows, 0, 2), 'bounds(0,2)');
    assertSame(boundsAt(s, 1, 2)[1], naive(rows, 1, 2), 'bounds(1,2)');
});

test('A5 live bar on top of closed bars: bounds fold live last, closed range excludes it', () => {
    const s = fresh(8);
    const rows = [];
    for (let i = 0; i < 5; i++) { s.appendBar(T(i), ...cand(i)); rows.push(row(T(i), i)); }
    s.setLive(T(5), ...cand(50)); rows.push(row(T(5), 50)); // dominates every lane
    for (let i0 = 0; i0 < 6; i0++) for (let i1 = i0; i1 < 6; i1++) {
        assertSame(boundsAt(s, i0, i1)[1], naive(rows, i0, i1), 'bounds(' + i0 + ',' + i1 + ')');
    }
    // overwrite live repeatedly: closed part untouched, live part follows
    for (let k = 60; k < 64; k++) {
        s.setLive(T(5), ...cand(k)); rows[5] = row(T(5), k);
        assert.equal(s.count, 6);
        assertSame(boundsAt(s, 0, 5)[1], naive(rows, 0, 5), 'after overwrite ' + k);
        assertSame(boundsAt(s, 5, 5)[1], naive(rows, 5, 5), 'live alone ' + k);
        assertSame(boundsAt(s, 0, 4)[1], naive(rows, 0, 4), 'closed part ' + k);
    }
});

test('A5 reopen then replace by a lower-volume bar: stale leaf must not leak', () => {
    const s = fresh(4);
    s.appendBar(T(0), ...cand(0));
    s.appendBar(T(1), 100, 1000, 1, 100, 5000); // huge extremes, closed
    s.setLive(T(1), 100, 101, 99, 100, 1);      // reopen with tiny bar
    let rows = [row(T(0), 0), [T(1), 100, 101, 99, 100, 1]];
    assertSame(boundsAt(s, 0, 1)[1], naive(rows, 0, 1), 'reopened');
    s.appendBar(T(2), ...cand(2));              // closes the live (tiny) bar for real
    rows.push(row(T(2), 2));
    assertSame(boundsAt(s, 0, 2)[1], naive(rows, 0, 2), 'after close');
    assertSame(boundsAt(s, 1, 1)[1], naive(rows, 1, 1), 'bar 1 alone');
});

// ---------------------------------------------------------------- A6 eviction
test('A6 eviction: cap 4, 10 closed bars', () => {
    const s = fresh(4);
    for (let i = 0; i < 10; i++) s.appendBar(T(i), ...cand(i));
    assert.equal(s.count, 4);
    assert.equal(s.oldestTime, T(6));
    assert.equal(s.latestTime, T(9));
    const out = new Float64Array(24);
    assert.equal(s.copyRangeInto(0, 3, out, 0), 4);
    assertSame(Array.from(out), [6, 7, 8, 9].flatMap((i) => row(T(i), i)), 'oldest first t6..t9');
    assert.equal(s.hasLive, false);
});

test('A6 eviction with a live bar at count == cap', () => {
    const s = fresh(4);
    for (let i = 0; i < 3; i++) s.appendBar(T(i), ...cand(i));
    s.setLive(T(3), ...cand(3));
    assert.equal(s.count, 4);
    assert.equal(s.oldestTime, T(0));
    s.setLive(T(3), ...cand(13)); // same time: no eviction
    assert.equal(s.count, 4);
    assert.equal(s.oldestTime, T(0));
    s.setLive(T(4), ...cand(4));  // later: closes live t3, evicts t0
    assert.equal(s.count, 4);
    assert.equal(s.hasLive, true);
    assert.equal(s.oldestTime, T(1), 'oldest advanced one bar');
    assert.equal(s.latestTime, T(4));
    const rows = [row(T(1), 1), row(T(2), 2), row(T(3), 13), row(T(4), 4)];
    assertSame(copyAll(s), rows.flat(), 'bars t1..t4');
    assertSame(boundsAt(s, 0, 3)[1], naive(rows, 0, 3), 'bounds');
    s.setLive(T(5), ...cand(5));
    assert.equal(s.oldestTime, T(2));
    assert.equal(s.count, 4);
    s.appendBar(T(6), ...cand(6)); // closes live t5, evicts t2
    assert.equal(s.oldestTime, T(3));
    assert.equal(s.count, 4);
    assert.equal(s.hasLive, false);
});

// ---------------------------------------------------------------- count transitions
test('count transitions at MIN_CAPACITY = 2 (0 / 1 / N-1 / N / N+1)', () => {
    const s = fresh(MIN_CAPACITY);
    assert.equal(s.count, 0);
    const exp = [[1, 0], [2, 0], [2, 1], [2, 2], [2, 3]]; // [count, oldest index] after append i
    for (let i = 0; i < 5; i++) {
        s.appendBar(T(i), ...cand(i));
        assert.equal(s.count, exp[i][0], 'count after append ' + i);
        assert.equal(s.oldestTime, T(exp[i][1]), 'oldest after append ' + i);
        assert.equal(s.latestTime, T(i));
        const lo = exp[i][1], rows = [];
        for (let k = lo; k <= i; k++) rows.push(row(T(k), k));
        assertSame(copyAll(s), rows.flat(), 'copy after append ' + i);
        assertSame(boundsAll(s)[1], naive(rows, 0, rows.length - 1), 'bounds after append ' + i);
    }
    // live variants
    s.setLive(T(5), ...cand(5));
    assert.equal(s.count, 2);
    assert.equal(s.oldestTime, T(4));
    s.setLive(T(5), ...cand(15));
    assert.equal(s.count, 2);
    assert.equal(s.oldestTime, T(4));
    s.setLive(T(6), ...cand(6));
    assert.equal(s.count, 2);
    assert.equal(s.oldestTime, T(5));
    const rows = [row(T(5), 15), row(T(6), 6)];
    assertSame(copyAll(s), rows.flat(), 'copy');
    assertSame(boundsAll(s)[1], naive(rows, 0, 1), 'bounds');
    // a lone live bar in an empty series, and reopen of the only bar
    const u = fresh(MIN_CAPACITY);
    u.setLive(T(0), ...cand(0));
    assert.equal(u.count, 1);
    assertSame(boundsAt(u, 0, 0)[1], naive([row(T(0), 0)], 0, 0), 'lone live');
    u.appendBar(T(0), ...cand(1));
    assert.equal(u.hasLive, false);
    u.setLive(T(0), ...cand(2));
    assert.equal(u.hasLive, true);
    assert.equal(u.count, 1);
    assertSame(boundsAt(u, 0, 0)[1], naive([row(T(0), 2)], 0, 0), 'lone reopened');
});

test('cap 16, 3x wrap: count, oldest, latest, copy and bounds at every step', () => {
    const s = fresh(16);
    const model = [];
    for (let i = 0; i < 52; i++) {
        const live = (i % 3) === 1;
        if (live) s.setLive(T(i), ...cand(i)); else s.appendBar(T(i), ...cand(i));
        model.push(row(T(i), i));
        if (model.length > 16) model.shift();
        const n = model.length;
        assert.equal(s.count, n, 'count at ' + i);
        assert.equal(s.hasLive, live, 'hasLive at ' + i);
        assert.equal(s.oldestTime, model[0][0]);
        assert.equal(s.latestTime, model[n - 1][0]);
        assertSame(copyAll(s), model.flat(), 'copy at ' + i);
        assertSame(boundsAll(s)[1], naive(model, 0, n - 1), 'bounds(all) at ' + i);
        assertSame(boundsAt(s, n >> 1, n - 1)[1], naive(model, n >> 1, n - 1), 'bounds(tail) at ' + i);
        assertSame(boundsAt(s, 0, n >> 1)[1], naive(model, 0, n >> 1), 'bounds(head) at ' + i);
    }
});

// ---------------------------------------------------------------- A8a candle validation
const invalidCandles = golden.validate.filter((c) => !c.accepted).map((c) => ({ name: c.name, c: c.candle.map(dec) }));
const validCandles = golden.validate.filter((c) => c.accepted).map((c) => ({ name: c.name, c: c.candle.map(dec) }));

test('A8a golden validate set has the expected shape (control)', () => {
    assert.equal(golden.validate.length, 30);
    assert.equal(invalidCandles.length, 25);
    assert.equal(validCandles.length, 5);
});

function guardedSeries() { // times < 1000 so a candle at t=1000 is never an order error
    const s = fresh(16);
    s.appendBar(100, ...cand(1));
    s.appendBar(200, ...cand(2));
    s.appendBar(300, ...cand(3));
    s.setLive(400, ...cand(4));
    return s;
}

test('A8a every invalid golden candle throws RangeError and changes nothing', () => {
    for (const { name, c } of invalidCandles) {
        for (const method of ['appendBar', 'setLive']) {
            const s = guardedSeries();
            const before = snap(s);
            assert.throws(() => s[method](...c), RangeError, method + ' ' + name);
            assertSnap(snap(s), before, method + ' ' + name);
        }
        // *From twins take the same door
        for (const method of ['appendBarFrom', 'setLiveFrom']) {
            const s = guardedSeries();
            const before = snap(s);
            const buf = new Float64Array([9, ...c]);
            assert.throws(() => s[method](buf, 1), RangeError, method + ' ' + name);
            assertSnap(snap(s), before, method + ' ' + name);
        }
    }
});

test('A8a every accepted golden candle is accepted', () => {
    for (const { name, c } of validCandles) {
        for (const method of ['appendBar', 'setLive']) {
            const s = fresh(16);
            s[method](...c);
            assert.equal(s.count, 1, method + ' ' + name);
            assert.equal(s.version, 1);
        }
        const s2 = fresh(16);
        s2.appendBarFrom(new Float64Array(c), 0);
        assert.equal(s2.count, 1, 'appendBarFrom ' + name);
    }
});

test('A8a volume ceiling is MAX_VALUE / (4 * cap)', () => {
    for (const cap of [2, 16, 1024]) {
        const maxVol = Number.MAX_VALUE / (4 * cap);
        const s = fresh(cap);
        s.appendBar(T(0), 1, 2, 0, 1, maxVol);
        assert.equal(s.count, 1, 'accept at ceiling cap ' + cap);
        assert.throws(() => s.appendBar(T(1), 1, 2, 0, 1, maxVol * 1.0000001), RangeError, 'reject above ceiling cap ' + cap);
        assert.equal(s.count, 1);
    }
});

test('A8a time order: earlier time throws before any write, valid or not', () => {
    const s = guardedSeries();
    const before = snap(s);
    assert.throws(() => s.appendBar(399, ...cand(9)), RangeError);
    assert.throws(() => s.setLive(399, ...cand(9)), RangeError);
    assert.throws(() => s.appendBar(399, NaN, 1, 1, 1, 1), RangeError);
    assertSnap(snap(s), before, 'after order errors');
    // no minimum gap / alignment rule (S3): misaligned and equal-offset times are accepted
    s.appendBar(401.5, ...cand(9));
    assert.equal(s.count, 5);
});

test('A8a time order on a full ring with a live bar: throw before the close-live walk and eviction', () => {
    const s = fresh(4);
    for (let i = 0; i < 3; i++) s.appendBar(T(i), ...cand(i));
    s.setLive(T(3), ...cand(3));
    const before = snap(s);
    assert.throws(() => s.appendBar(T(2), ...cand(9)), RangeError);
    assert.throws(() => s.setLive(T(2), ...cand(9)), RangeError);
    assertSnap(snap(s), before, 'after order errors on a full ring');
});

test('A8a scalar wrappers: non-number argument -> TypeError, no change', () => {
    const s = guardedSeries();
    const before = snap(s);
    const good = [1000, ...cand(5)];
    for (let f = 0; f < 6; f++) {
        for (const bad of ['1', null, undefined, {}, true]) {
            const a = good.slice(); a[f] = bad;
            assert.throws(() => s.appendBar(...a), TypeError, 'appendBar arg ' + f + ' ' + String(bad));
            assert.throws(() => s.setLive(...a), TypeError, 'setLive arg ' + f + ' ' + String(bad));
        }
    }
    assert.throws(() => s.appendBar(1000, ...cand(5).slice(0, 4)), TypeError, 'volume is required');
    assertSnap(snap(s), before, 'after TypeErrors');
});

test('A8a *From twins: buf type and offset doors', () => {
    const s = guardedSeries();
    const before = snap(s);
    const c = [1000, ...cand(5)];
    for (const method of ['appendBarFrom', 'setLiveFrom']) {
        assert.throws(() => s[method](c, 0), TypeError, method + ' plain array');
        assert.throws(() => s[method](new Float32Array(c), 0), TypeError, method + ' Float32Array');
        assert.throws(() => s[method](new Float64Array(5), 0), RangeError, method + ' too short');
        assert.throws(() => s[method](new Float64Array(7), 2), RangeError, method + ' off+6 > len');
        assert.throws(() => s[method](new Float64Array(c), 0.5), RangeError, method + ' fractional off');
        assert.throws(() => s[method](new Float64Array(c), -1), RangeError, method + ' negative off');
    }
    assertSnap(snap(s), before, 'after buffer errors');
    s.appendBarFrom(new Float64Array([0, 0, ...c]), 2);
    assert.equal(s.count, 5);
    assert.equal(s.latestTime, 1000);
});

// ---------------------------------------------------------------- A8b boundsInto
test('A8b boundsInto invalid ranges -> return 0 and exact EMPTY record', () => {
    const s = fresh(16);
    for (let i = 0; i < 5; i++) s.appendBar(T(i), ...cand(i));
    const count = s.count;
    const bad = [[-1, -1], [3, 2], [0, count], [0.5, 1], [NaN, 0], ['0', 1], [0, NaN], [0, '1'], [-1, 2],
        [count, count], [1, 1.5], [Infinity, Infinity], [0, Infinity], [-Infinity, 2], [0, 2 ** 31], [2 ** 32, 2 ** 32]];
    for (const [a, b] of bad) {
        const out = new Float64Array(11).fill(7.5);
        assert.equal(s.boundsInto(a, b, out, 1), 0, 'ret (' + String(a) + ',' + String(b) + ')');
        assertSame(Array.from(out.subarray(1, 10)), EMPTY, 'record (' + String(a) + ',' + String(b) + ')');
        assert.equal(out[0], 7.5, 'slot before off untouched');
        assert.equal(out[10], 7.5, 'slot after record untouched');
    }
    // sanity control: a valid range is NOT empty
    assert.equal(boundsAt(s, 0, count - 1)[0], count);
    // live bar present: valid range limit is count (live included), not closed count
    s.setLive(T(5), ...cand(5));
    assert.equal(boundsAt(s, 0, 5)[0], 6);
    assert.equal(boundsAt(s, 0, 6)[0], 0);
});

test('A8b boundsInto at count 0 -> 0 + EMPTY for any call', () => {
    const s = fresh(16);
    for (const [a, b] of [[0, 0], [0, 1], [-1, -1], [3, 2], [NaN, NaN]]) {
        const out = new Float64Array(9).fill(7.5);
        assert.equal(s.boundsInto(a, b, out, 0), 0);
        assertSame(Array.from(out), EMPTY, 'empty record at count 0');
    }
});

test('A8b boundsInto out / off doors', () => {
    const s = fresh(16);
    for (let i = 0; i < 3; i++) s.appendBar(T(i), ...cand(i));
    const short = new Float64Array(10).fill(7.5);
    assert.throws(() => s.boundsInto(0, 2, short, 2), RangeError, 'off + 9 > len');
    assert.ok(short.every((x) => x === 7.5), 'out untouched on RangeError');
    assert.throws(() => s.boundsInto(-1, -1, short, 2), RangeError, 'off + 9 > len even for an invalid range');
    assert.throws(() => s.boundsInto(0, 2, new Float64Array(8), 0), RangeError, 'len 8');
    for (const off of [-1, 0.5, NaN, null, '0', Infinity]) {
        const o = new Float64Array(20).fill(7.5);
        assert.throws(() => s.boundsInto(0, 2, o, off), RangeError, 'bad off ' + String(off));
        assert.ok(o.every((x) => x === 7.5), 'out untouched, off ' + String(off));
    }
    for (const bad of [new Array(9).fill(0), new Float32Array(9), new Float64Array(9).buffer, null, undefined, {}]) {
        assert.throws(() => s.boundsInto(0, 2, bad, 0), TypeError, 'out not Float64Array');
        assert.throws(() => s.boundsInto(-1, -1, bad, 0), TypeError, 'out not Float64Array, invalid range');
    }
    // both checks run at count 0 too
    const e = fresh(16);
    assert.throws(() => e.boundsInto(0, 0, new Float64Array(8), 0), RangeError);
    assert.throws(() => e.boundsInto(0, 0, [], 0), TypeError);
    // exact fit with off > 0
    const fit = new Float64Array(11).fill(7.5);
    assert.equal(s.boundsInto(0, 2, fit, 2), 3);
    assert.equal(fit[0], 7.5);
    assert.equal(fit[1], 7.5);
    const rows = [row(T(0), 0), row(T(1), 1), row(T(2), 2)];
    assertSame(Array.from(fit.subarray(2)), naive(rows, 0, 2), 'record at off 2');
});

// ---------------------------------------------------------------- A8c copyRangeInto
test('A8c copyRangeInto: short out -> RangeError before any write', () => {
    const s = fresh(16);
    for (let i = 0; i < 4; i++) s.appendBar(T(i), ...cand(i));
    const out = new Float64Array(23).fill(7.5);
    assert.throws(() => s.copyRangeInto(0, 3, out, 0), RangeError);
    assert.ok(out.every((x) => x === 7.5), 'out untouched');
    const out2 = new Float64Array(26).fill(7.5);
    assert.throws(() => s.copyRangeInto(0, 3, out2, 3), RangeError, 'off + 6n > len');
    assert.ok(out2.every((x) => x === 7.5), 'out2 untouched');
    for (const off of [-1, 0.5, NaN, null, '0']) {
        const o = new Float64Array(64).fill(7.5);
        assert.throws(() => s.copyRangeInto(0, 3, o, off), RangeError, 'bad off ' + String(off));
        assert.ok(o.every((x) => x === 7.5), 'out untouched, off ' + String(off));
    }
    // exact fit with offset
    const out3 = new Float64Array(27).fill(7.5);
    assert.equal(s.copyRangeInto(0, 3, out3, 3), 4);
    assertSame(Array.from(out3.subarray(0, 3)), [7.5, 7.5, 7.5], 'head untouched');
    assertSame(Array.from(out3.subarray(3)), [0, 1, 2, 3].flatMap((i) => row(T(i), i)), 'records');
});

// [5,2] (i1 < count, i0 > count) and [3,0]: i0 > i1 must return 0; without that guard n = i1-i0+1 < 0 / <= 0 slips through.
test('A8c copyRangeInto: invalid range -> 0, nothing written', () => {
    const s = fresh(16);
    for (let i = 0; i < 4; i++) s.appendBar(T(i), ...cand(i));
    for (const [a, b] of [[-1, 0], [3, 2], [5, 2], [3, 0], [0, 4], [0.5, 1], [NaN, 1], ['0', 1], [0, '1']]) {
        const out = new Float64Array(24).fill(7.5);
        assert.equal(s.copyRangeInto(a, b, out, 0), 0, '(' + String(a) + ',' + String(b) + ')');
        assert.ok(out.every((x) => x === 7.5), 'untouched');
    }
    assert.equal(fresh(16).copyRangeInto(0, 0, new Float64Array(6), 0), 0, 'count 0');
    // a range that is valid only because a live bar counts
    s.setLive(T(4), ...cand(4));
    const out = new Float64Array(30);
    assert.equal(s.copyRangeInto(0, 4, out, 0), 5);
    assertSame(Array.from(out.subarray(24)), row(T(4), 4), 'live bar is copied');
});

// ---------------------------------------------------------------- A11 -0
test('A11 -0 is canonicalised to +0 on every write path', () => {
    const paths = {
        setLive: (s, a) => s.setLive(...a),
        appendBar: (s, a) => s.appendBar(...a),
        setLiveFrom: (s, a) => s.setLiveFrom(new Float64Array([1, ...a]), 1),
        appendBarFrom: (s, a) => s.appendBarFrom(new Float64Array([1, ...a]), 1),
    };
    for (const [name, w] of Object.entries(paths)) {
        const s = fresh(16);
        w(s, [T(0), -0, -0, -0, -0, -0]);
        const out = Array.from({ length: 6 }, () => 7.5);
        const o = new Float64Array(6).fill(7.5);
        assert.equal(s.copyRangeInto(0, 0, o, 0), 1);
        assertSame(Array.from(o), [T(0), 0, 0, 0, 0, 0], name + ' copy slots are +0');
        const [n, b] = boundsAt(s, 0, 0);
        assert.equal(n, 1);
        assertSame(b, [0, 0, 0, 0, 0, 0, 0, 0, 1], name + ' bounds slots are +0');
        void out;
    }
});

test('A11 -0 time and -0 mixed into closed + live bars; sums are +0', () => {
    const s = fresh(16);
    s.appendBar(-0, -0, -0, -0, -0, -0);
    s.appendBar(1, -0, 0, -0, -0, -0);
    s.setLive(2, -0, -0, -0, -0, -0);
    assertSame(copyAll(s), [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0], 'all +0');
    for (const [a, b] of [[0, 0], [0, 1], [1, 2], [2, 2], [0, 2]]) {
        assertSame(boundsAt(s, a, b)[1], [0, 0, 0, 0, 0, 0, a, b, b - a + 1], 'bounds (' + a + ',' + b + ')');
    }
    assert.ok(Object.is(s.oldestTime, 0), 'oldestTime +0');
    // same-time replacement of a -0 time stays consistent
    s.appendBar(2, -0, -0, -0, -0, -0);
    assert.equal(s.count, 3);
    assert.equal(s.hasLive, false);
});

// ---------------------------------------------------------------- A12 version
test('A12 version: +1 per successful write or clear; reads and throws never bump', () => {
    const s = fresh(4);
    assert.equal(s.version, 0);
    let v = 0;
    const bump = (label) => { v++; assert.equal(s.version, v, label); };
    const flat = (label) => assert.equal(s.version, v, label);

    s.appendBar(T(0), ...cand(0)); bump('appendBar new');
    s.appendBar(T(0), ...cand(1)); bump('appendBar same-time replace');
    s.setLive(T(1), ...cand(2)); bump('setLive new');
    s.setLive(T(1), ...cand(3)); bump('setLive same-time overwrite live');
    s.appendBar(T(1), ...cand(4)); bump('appendBar same-time close live');
    s.setLive(T(1), ...cand(5)); bump('setLive reopen (closed -> live)');
    s.appendBar(T(2), ...cand(6)); bump('appendBar new, closing live');
    s.setLive(T(3), ...cand(7)); bump('setLive new');
    s.setLive(T(4), ...cand(8)); bump('setLive new with eviction');
    s.appendBarFrom(new Float64Array([T(5), ...cand(9)]), 0); bump('appendBarFrom');
    s.setLiveFrom(new Float64Array([T(6), ...cand(10)]), 0); bump('setLiveFrom');

    // reads
    void s.count; void s.hasLive; void s.oldestTime; void s.latestTime; void s.interval; void s.capacity;
    s.lowerBound(T(5)); s.upperBound(T(5)); s.lowerBoundFrom(new Float64Array([T(5)]), 0); s.upperBoundFrom(new Float64Array([T(5)]), 0);
    s.boundsInto(0, 1, new Float64Array(9), 0); s.boundsInto(-1, 0, new Float64Array(9), 0);
    s.copyRangeInto(0, 1, new Float64Array(12), 0);
    flat('reads');

    // throws
    assert.throws(() => s.appendBar(T(0), ...cand(0)), RangeError);
    assert.throws(() => s.setLive(T(0), ...cand(0)), RangeError);
    assert.throws(() => s.appendBar(T(9), NaN, 1, 1, 1, 1), RangeError);
    assert.throws(() => s.setLive(T(9), 1, 1, 2, 1, 1), RangeError);
    assert.throws(() => s.appendBar('x', 1, 1, 1, 1, 1), TypeError);
    assert.throws(() => s.boundsInto(0, 1, new Float64Array(3), 0), RangeError);
    assert.throws(() => s.copyRangeInto(0, 1, new Float64Array(3), 0), RangeError);
    flat('throws');

    s.clear(); bump('clear');
});

test('A12 version wraps to 0 at 2^30 - 1 (internal state slot 3)', () => {
    const writes = {
        appendBar: (s) => s.appendBar(T(9), ...cand(1)),
        setLiveNew: (s) => s.setLive(T(9), ...cand(1)),
        setLiveSame: (s) => s.setLive(T(1), ...cand(1)),
        appendSame: (s) => s.appendBar(T(1), ...cand(1)),
        clear: (s) => s.clear(),
    };
    for (const [name, w] of Object.entries(writes)) {
        const s = fresh(4);
        s.appendBar(T(0), ...cand(0));
        s.setLive(T(1), ...cand(1));
        s._s[3] = 0x3FFFFFFF;
        assert.equal(s.version, 0x3FFFFFFF, name + ' poke visible');
        w(s);
        assert.equal(s.version, 0, name + ' wraps to 0');
        s.setLive(T(20), ...cand(2));
        assert.equal(s.version, 1, name + ' continues from 0');
    }
});

// ---------------------------------------------------------------- A16 clear
test('A16 clear: empty state, then fresh appends use no stale data', () => {
    const s = fresh(16);
    for (let i = 0; i < 40; i++) s.appendBar(T(i), 1000 + i, 2000 + i, 500, 1500, 9e5 + i); // big, wrapped
    s.setLive(T(40), 1, 2, 0, 1, 1);
    const v = s.version;
    s.clear();
    assert.equal(s.count, 0);
    assert.equal(s.hasLive, false);
    assert.ok(Number.isNaN(s.oldestTime));
    assert.ok(Number.isNaN(s.latestTime));
    assert.equal(s.version, v + 1);
    assert.equal(s.capacity, 16);
    const out = new Float64Array(9).fill(7.5);
    assert.equal(s.boundsInto(0, 0, out, 0), 0);
    assertSame(Array.from(out), EMPTY, 'bounds EMPTY after clear');
    assert.equal(s.lowerBound(T(5)), -1);
    assert.equal(s.upperBound(T(5)), -1);
    assert.equal(s.copyRangeInto(0, 0, new Float64Array(6), 0), 0);

    // time order restarts after clear (earlier time is fine on an empty series)
    const rows = [[100, 5, 9, 4, 6, 3], [200, 6, 8, 2, 7, 4], [300, 7, 12, 6, 8, 5]];
    for (const r of rows) s.appendBar(...r);
    assert.equal(s.count, 3);
    assertSame(copyAll(s), rows.flat(), 'copy after clear');
    for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) {
        assertSame(boundsAt(s, a, b)[1], naive(rows, a, b), 'bounds(' + a + ',' + b + ') after clear');
    }
});

test('A16 clear with a live bar, then live-first refill', () => {
    const s = fresh(4);
    s.appendBar(T(0), ...cand(0));
    s.setLive(T(1), ...cand(1));
    s.clear();
    assert.equal(s.hasLive, false);
    s.setLive(50, ...cand(7));
    assert.equal(s.count, 1);
    assert.equal(s.hasLive, true);
    assertSame(boundsAt(s, 0, 0)[1], naive([row(50, 7)], 0, 0), 'lone live after clear');
    s.appendBar(60, ...cand(8));
    assertSame(boundsAt(s, 0, 1)[1], naive([row(50, 7), row(60, 8)], 0, 1), 'after append');
    s.clear(); s.clear();
    assert.equal(s.count, 0);
});
