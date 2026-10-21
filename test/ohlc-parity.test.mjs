// ohlc-parity: v2 against the frozen v1 golden (test/golden-v1.json) -- PLAN-v2 A9, A10.
// Expected values are the v1 outputs recorded by .handoff/golden-src/cut.mjs; non-finite values are
// stored as "NaN" / "Infinity" / "-Infinity" and negative zero as "-0".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OhlcSeries } from '../Ohlc.js';

const golden = JSON.parse(readFileSync(new URL('./golden-v1.json', import.meta.url), 'utf8'));
const dec = (x) => (typeof x === 'string' ? ({ NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 })[x] : x);
const decArr = (a) => a.map(dec);
const INTERVAL = 60000;

function firstDiff(got, want) {
    if (got.length !== want.length) return 'length ' + got.length + ' vs ' + want.length;
    for (let i = 0; i < want.length; i++) if (!Object.is(got[i], want[i])) return 'slot ' + i + ': got ' + got[i] + ' want ' + want[i];
    return '';
}

test('golden file shape (control)', () => {
    assert.equal(golden.search.length, 2);
    assert.equal(golden.bounds.rows.length, 140);
    assert.equal(golden.copy.rows.length, 136);
    assert.equal(golden.validate.length, 30);
    assert.equal(golden.bounds.bars.length, 45);
});

// ------------------------------------------------------------------ A9
function searchSeries(sec) {
    const s = new OhlcSeries(sec.cap, INTERVAL);
    for (const t of sec.times) s.appendBar(t, 10, 12, 8, 11, 1);
    return s;
}

test('A9 every golden search row equals lowerBound / upperBound', () => {
    let rows = 0;
    for (const sec of golden.search) {
        const s = searchSeries(sec);
        for (const [x0, lo, hi] of sec.rows) {
            const x = dec(x0);
            assert.equal(s.lowerBound(x), lo, 'cap ' + sec.cap + ' lowerBound(' + x0 + ')');
            assert.equal(s.upperBound(x), hi, 'cap ' + sec.cap + ' upperBound(' + x0 + ')');
            rows++;
        }
    }
    assert.equal(rows, golden.search[0].rows.length + golden.search[1].rows.length);
    assert.ok(rows > 100, 'rows: ' + rows);
});

test('A9 *From twins agree with the golden rows (any offset)', () => {
    for (const sec of golden.search) {
        const s = searchSeries(sec);
        for (const [x0, lo, hi] of sec.rows) {
            const buf = new Float64Array([99, 99, dec(x0), 99]);
            assert.equal(s.lowerBoundFrom(buf, 2), lo, 'lowerBoundFrom ' + x0);
            assert.equal(s.upperBoundFrom(buf, 2), hi, 'upperBoundFrom ' + x0);
        }
    }
});

test('A9 *From doors: buf type and off in [0, len)', () => {
    const sec = golden.search[0];
    const s = searchSeries(sec);
    const q = new Float64Array([sec.times[0], 0]);
    for (const m of ['lowerBoundFrom', 'upperBoundFrom']) {
        for (const off of [2, 3, -1, 0.5, NaN, null]) assert.throws(() => s[m](q, off), RangeError, m + ' off ' + String(off));
        for (const bad of [[1], new Float32Array(2), null]) assert.throws(() => s[m](bad, 0), TypeError, m + ' buf');
    }
});

test('A9 non-number argument -> -1; count 0 -> -1', () => {
    const s = searchSeries(golden.search[0]);
    for (const bad of ['100', null, undefined, {}, [100], true]) {
        assert.equal(s.lowerBound(bad), -1, 'lowerBound ' + String(bad));
        assert.equal(s.upperBound(bad), -1, 'upperBound ' + String(bad));
    }
    const e = new OhlcSeries(16, INTERVAL);
    for (const x of [0, 100, NaN, Infinity]) { assert.equal(e.lowerBound(x), -1); assert.equal(e.upperBound(x), -1); }
});

test('A9 live bar at tL: lowerBound(tL) === upperBound(tL) === count-1', () => {
    for (const sec of golden.search) {
        const s = new OhlcSeries(sec.cap, INTERVAL);
        const ts = sec.times;
        for (let i = 0; i < ts.length - 1; i++) s.appendBar(ts[i], 10, 12, 8, 11, 1);
        const tL = ts[ts.length - 1];
        s.setLive(tL, 10, 12, 8, 11, 1);
        assert.equal(s.hasLive, true);
        const last = s.count - 1;
        assert.equal(s.lowerBound(tL), last, 'cap ' + sec.cap + ' lowerBound(tL)');
        assert.equal(s.upperBound(tL), last, 'cap ' + sec.cap + ' upperBound(tL)');
        // the live bar is part of the series for searches: just past it / just before it
        assert.equal(s.upperBound(tL + 1), last);
        assert.equal(s.lowerBound(tL + 1), -1);
        assert.equal(s.lowerBound(tL - 0.5), last);
        assert.equal(s.upperBound(tL - 0.5), last - 1);
        // the same answers after the bar is closed (searches read the columns uniformly)
        s.appendBar(tL, 10, 12, 8, 11, 1);
        assert.equal(s.lowerBound(tL), last);
        assert.equal(s.upperBound(tL), last);
    }
    // live bar alone
    const s = new OhlcSeries(4, INTERVAL);
    s.setLive(500, 1, 2, 0, 1, 1);
    assert.equal(s.lowerBound(500), 0);
    assert.equal(s.upperBound(500), 0);
    assert.equal(s.lowerBound(501), -1);
    assert.equal(s.upperBound(499), -1);
});

// ------------------------------------------------------------------ A10
function boundsSeries() {
    const s = new OhlcSeries(golden.bounds.cap, INTERVAL);
    for (const b of golden.bounds.bars) s.appendBar(...decArr(b));
    return s;
}

test('A10 boundsInto(lowerBound(minT), upperBound(maxT)) == v1 out9, slot for slot incl. empties', () => {
    const s = boundsSeries();
    assert.equal(s.count, 16);
    let empties = 0, valid = 0;
    for (const r of golden.bounds.rows) {
        const minT = dec(r.minT), maxT = dec(r.maxT);
        const i0 = s.lowerBound(minT), i1 = s.upperBound(maxT);
        const out = new Float64Array(9).fill(-7);
        const ret = s.boundsInto(i0, i1, out, 0);
        const label = '(' + r.minT + ',' + r.maxT + ')';
        assert.equal(ret, r.ret, 'ret ' + label);
        assert.equal(firstDiff(Array.from(out), decArr(r.out)), '', 'out9 ' + label);
        if (r.ret === 0) empties++; else valid++;
    }
    assert.equal(valid, 136, 'valid rows');
    assert.equal(empties, 4, 'empty rows');
});

test('A10 copyRangeInto == v1 copy rows', () => {
    const s = new OhlcSeries(golden.copy.cap, INTERVAL);
    for (const b of golden.copy.bars) s.appendBar(...decArr(b));
    for (const r of golden.copy.rows) {
        const out = new Float64Array(96).fill(-7);
        const ret = s.copyRangeInto(r.s, r.e, out, 0);
        assert.equal(ret, r.ret, 'ret (' + r.s + ',' + r.e + ')');
        const n = 6 * (r.e - r.s + 1);
        assert.equal(firstDiff(Array.from(out.subarray(0, n)), decArr(r.out)), '', 'rows (' + r.s + ',' + r.e + ')');
        for (let i = n; i < 96; i++) assert.ok(out[i] === -7, 'tail untouched (' + r.s + ',' + r.e + ') slot ' + i);
    }
});

test('A10 validate rows: accept / reject equals v1 (appendBar, setLive, *From)', () => {
    let rejected = 0, accepted = 0;
    for (const r of golden.validate) {
        const c = decArr(r.candle);
        const ways = {
            appendBar: (s) => s.appendBar(...c),
            setLive: (s) => s.setLive(...c),
            appendBarFrom: (s) => s.appendBarFrom(new Float64Array(c), 0),
            setLiveFrom: (s) => s.setLiveFrom(new Float64Array(c), 0),
        };
        for (const [name, w] of Object.entries(ways)) {
            const s = new OhlcSeries(16, INTERVAL);
            let ok = true;
            try { w(s); } catch (e) { ok = false; assert.ok(e instanceof RangeError, name + ' ' + r.name + ' throws RangeError'); }
            assert.equal(ok, r.accepted, name + ' ' + r.name);
            assert.equal(s.count, r.accepted ? 1 : 0, name + ' ' + r.name + ' count');
        }
        if (r.accepted) accepted++; else rejected++;
    }
    assert.equal(accepted, 5);
    assert.equal(rejected, 25);
});
