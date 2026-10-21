// ohlc-decimate: decimateInto (PLAN-v2 S7, A3, A8e, D5 / ADDENDUM 1). Written from the SPEC only.
// The oracle below is this file's own naive fold; no expected value comes from running decimateInto.
// Module override for teeth runs: OHLC_MODULE=../.handoff/frozen-b1a/Ohlc.js (no decimateInto -> must fail).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import(new URL(process.env.OHLC_MODULE ?? '../Ohlc.js', import.meta.url));
const { OhlcSeries } = mod;

const T0 = 1.7e12;
const T = (i) => T0 + i * 60000;
const FILL = 12345.5;

function mulberry32(seed) { // 32-bit exact
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Independent streams: price stream and volume stream never share a PRNG.
// vmode 'int': (rng()*1000)|0.  vmode 'frac' (addendum 5 shape): half rng()*1e6, half rng()*10^(k-2), k in 0..7.
function makeBars(seed, M, vmode) {
    const rp = mulberry32(seed), rv = mulberry32(seed ^ 0x9E3779B9), rk = mulberry32(seed ^ 0x85EBCA6B);
    const bars = [];
    for (let i = 0; i < M; i++) {
        const p = 100 + rp() * 50;
        const lo = p - rp() * 5, hi = p + rp() * 5;
        const o = Math.min(hi, lo + rp() * (hi - lo)), c = Math.min(hi, lo + rp() * (hi - lo));
        let v;
        if (vmode === 'int') v = (rv() * 1000) | 0;
        else if (rk() < 0.5) v = rv() * 1e6;
        else v = rv() * Math.pow(10, ((rk() * 8) | 0) - 2);
        bars.push([T(i), o, hi, lo, c, v]);
    }
    return bars;
}

// cap-sized ring fed with M bars: M-1 closed, the last as the live bar (when live=true).
// Returns the series and the RESIDENT bars in logical order (last min(M,cap)).
function build(cap, bars, live = true) {
    const s = new OhlcSeries(cap, 60000);
    // guard: a missing method would make assert.throws(TypeError) pass for the wrong reason
    assert.equal(typeof s.decimateInto, 'function', 'decimateInto missing');
    const last = bars.length - 1;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (live && i === last) s.setLive(b[0], b[1], b[2], b[3], b[4], b[5]);
        else s.appendBar(b[0], b[1], b[2], b[3], b[4], b[5]);
    }
    return { s, res: bars.slice(Math.max(0, bars.length - cap)) };
}

// S7 bucket bounds, ceil form: [i0 + ceil(kn/B), i0 + ceil((k+1)n/B) - 1], ceil = floor((x + B - 1)/B).
function ceilBounds(i0, n, B, k) {
    return [i0 + Math.floor((k * n + B - 1) / B), i0 + Math.floor(((k + 1) * n + B - 1) / B) - 1];
}

// Naive oracle: bar r (offset from i0) is in bucket floor(r*B/n) (A2's independent form). Returns rows
// [t_first, o_first, max h, min l, c_last, sequential sum v, k] for non-empty buckets, ascending k,
// plus the ceil-form [s,e] per row. Cross-checks the two bucket derivations against each other.
function naive(res, i0, i1, B) {
    const n = i1 - i0 + 1;
    const members = new Map();
    for (let r = 0; r < n; r++) {
        const k = Math.floor(r * B / n);
        if (!members.has(k)) members.set(k, []);
        members.get(k).push(i0 + r);
    }
    const rows = [], bounds = [];
    for (let k = 0; k < B; k++) {
        const [s, e] = ceilBounds(i0, n, B, k);
        const m = members.get(k);
        if (e < s) { assert.equal(m, undefined, 'ceil says empty, floor has members: n=' + n + ' B=' + B + ' k=' + k); continue; }
        assert.ok(m !== undefined && m[0] === s && m[m.length - 1] === e && m.length === e - s + 1,
            'bucket derivations disagree: n=' + n + ' B=' + B + ' k=' + k);
        let h = res[s][2], l = res[s][3], v = 0;
        for (let j = s; j <= e; j++) { if (res[j][2] > h) h = res[j][2]; if (res[j][3] < l) l = res[j][3]; v += res[j][5]; }
        rows.push([res[s][0], res[s][1], h, l, res[e][4], v, k]);
        bounds.push([s, e]);
    }
    return { rows, bounds };
}

function run(fn, s, i0, i1, B) { // private path or public door into a fresh pre-filled buffer
    const out = new Float64Array(7 * B + 10).fill(FILL);
    const w = fn.call(s, i0, i1, B, out, 3);
    return { w, out };
}
const scanOf = (s, i0, i1, B) => run(s._decimateScan, s, i0, i1, B);
const treeOf = (s, i0, i1, B) => run(s._decimateTree, s, i0, i1, B);
const pubOf = (s, i0, i1, B) => run(s.decimateInto, s, i0, i1, B);

function sameLane(a, b, w, lane) { // Object.is on one lane of w rows (offset 3)
    for (let r = 0; r < w; r++) if (!Object.is(a[3 + r * 7 + lane], b[3 + r * 7 + lane])) return false;
    return true;
}

const BS = [1, 2, 3, 7, 16, 64, 65];
const H = 6; // log2(64)

// ------------------------------------------------------------------ A3
for (const vmode of ['int', 'frac']) {
    test('A3 tree == scan, cap 64, 200 bars + live, all 2080 ranges x 7 B (' + vmode + ' volumes)', () => {
        const { s, res } = build(64, makeBars(0xA3A3 + (vmode === 'int' ? 1 : 2), 201, vmode));
        assert.equal(s.count, 64);
        assert.ok(s.hasLive);
        let cases = 0, vDiffer = 0, pairs = 0;
        for (let i0 = 0; i0 < 64; i0++) for (let i1 = i0; i1 < 64; i1++) {
            pairs++;
            const n = i1 - i0 + 1;
            for (const B of BS) {
                cases++;
                const exp = naive(res, i0, i1, B);
                const w = Math.min(n, B);
                const sc = scanOf(s, i0, i1, B), tr = treeOf(s, i0, i1, B), pu = pubOf(s, i0, i1, B);
                const tag = ' (i0=' + i0 + ' i1=' + i1 + ' B=' + B + ')';
                assert.equal(exp.rows.length, w, 'oracle row count' + tag);
                assert.equal(sc.w, w, 'scan return' + tag);
                assert.equal(tr.w, w, 'tree return' + tag);
                assert.equal(pu.w, w, 'public return' + tag);
                for (const lane of [0, 1, 2, 3, 4, 6]) {
                    assert.ok(sameLane(sc.out, tr.out, w, lane), 'lane ' + lane + ' scan!=tree' + tag);
                    for (let r = 0; r < w; r++) {
                        assert.ok(Object.is(sc.out[3 + r * 7 + lane], exp.rows[r][lane]), 'lane ' + lane + ' vs naive row ' + r + tag);
                    }
                }
                if (vmode === 'int') {
                    assert.ok(sameLane(sc.out, tr.out, w, 5), 'int v scan!=tree' + tag);
                    for (let r = 0; r < w; r++) assert.ok(Object.is(sc.out[3 + r * 7 + 5], exp.rows[r][5]), 'int v vs naive' + tag);
                } else {
                    const bo = new Float64Array(9);
                    for (let r = 0; r < w; r++) {
                        assert.ok(Object.is(sc.out[3 + r * 7 + 5], exp.rows[r][5]), 'scan v != sequential sum, row ' + r + tag);
                        const [bs, be] = exp.bounds[r];
                        s.boundsInto(bs, be, bo, 0);
                        assert.ok(Object.is(tr.out[3 + r * 7 + 5], bo[5]), 'tree v != boundsInto sum, row ' + r + tag);
                        if (!Object.is(sc.out[3 + r * 7 + 5], tr.out[3 + r * 7 + 5])) vDiffer++;
                    }
                }
                // public door follows the H rule (n < B*H -> scan, else tree), all 7 lanes byte-identical
                const want = n < B * H ? sc : tr;
                for (let lane = 0; lane < 7; lane++) assert.ok(sameLane(pu.out, want.out, w, lane), 'public path lane ' + lane + tag);
                // slots outside the written rows untouched
                for (let q = 0; q < 3; q++) assert.ok(Object.is(pu.out[q], FILL));
                for (const x of [sc, tr, pu]) for (let q = 3 + w * 7; q < x.out.length; q++) assert.ok(Object.is(x.out[q], FILL), 'tail' + tag);
            }
        }
        assert.equal(pairs, 2080);
        assert.equal(cases, 2080 * 7);
        if (vmode === 'frac') assert.ok(vDiffer > 0, 'fractional data must make the two paths differ somewhere (teeth), got ' + vDiffer);
    });
}

// ------------------------------------------------------------------ path choice teeth
test('path choice: n = B*H boundary, public output equals the expected path byte-for-byte (v differs)', () => {
    // for each B, n in {B*H-1 (scan), B*H (tree), B*H+1 (tree)}; search seeds for a case where scan v != tree v.
    for (const B of [1, 3, 7, 10]) {
        for (const n of [B * H - 1, B * H, B * H + 1]) {
            if (n > 64) continue;
            const wantTree = n >= B * H; // spec: n < B*H -> scan, else tree
            let found = false;
            for (let seed = 1; seed <= 400 && !found; seed++) {
                const { s } = build(64, makeBars(seed * 7919, 201, 'frac'));
                const i0 = seed % (64 - n + 1), i1 = i0 + n - 1;
                const sc = scanOf(s, i0, i1, B), tr = treeOf(s, i0, i1, B);
                const w = Math.min(n, B);
                if (sameLane(sc.out, tr.out, w, 5)) continue;
                found = true;
                const pu = pubOf(s, i0, i1, B);
                const want = wantTree ? tr : sc, other = wantTree ? sc : tr;
                for (let lane = 0; lane < 7; lane++) assert.ok(sameLane(pu.out, want.out, w, lane), 'B=' + B + ' n=' + n + ' lane ' + lane);
                assert.ok(!sameLane(pu.out, other.out, w, 5), 'public must differ from the other path in v');
            }
            assert.ok(found, 'no fractional case separates the paths for B=' + B + ' n=' + n);
        }
    }
});

// ------------------------------------------------------------------ cap-16 wrapped sweep (seam buckets)
test('wrap seam: cap 16, 37 bars, all 136 ranges x B, both paths and the door vs naive (integer volumes)', () => {
    const { s, res } = build(16, makeBars(0x5EA1, 37, 'int'), false);
    assert.equal(res.length, 16);
    let cases = 0;
    for (let i0 = 0; i0 < 16; i0++) for (let i1 = i0; i1 < 16; i1++) for (const B of [1, 2, 3, 5, 16, 17]) {
        cases++;
        const exp = naive(res, i0, i1, B), w = Math.min(i1 - i0 + 1, B);
        for (const f of [scanOf, treeOf, pubOf]) {
            const r = f(s, i0, i1, B);
            assert.equal(r.w, w);
            for (let q = 0; q < w; q++) for (let lane = 0; lane < 7; lane++) {
                assert.ok(Object.is(r.out[3 + q * 7 + lane], exp.rows[q][lane]), f.name + ' i0=' + i0 + ' i1=' + i1 + ' B=' + B + ' row ' + q + ' lane ' + lane);
            }
        }
    }
    assert.equal(cases, 816);
});

// ------------------------------------------------------------------ live-only bucket
test('live-only range (i0 = i1 = live index): finite, equals the live bar, on every path', () => {
    const bars = makeBars(0x11FE, 201, 'frac');
    const { s, res } = build(64, bars);
    const live = res[63];
    for (const B of [1, 3, 64]) {
        for (const f of [scanOf, treeOf, pubOf]) {
            const r = f(s, 63, 63, B);
            assert.equal(r.w, 1);
            const row = [live[0], live[1], live[2], live[3], live[4], live[5], 0];
            for (let lane = 0; lane < 7; lane++) {
                const x = r.out[3 + lane];
                assert.ok(Number.isFinite(x), 'non-finite lane ' + lane + ' B=' + B);
                assert.ok(Object.is(x, row[lane]), 'lane ' + lane + ' B=' + B + ' ' + x + ' vs ' + row[lane]);
            }
        }
    }
});

// ------------------------------------------------------------------ A8(e) doors
test('A8e: B outside the integer range [1, 2^20] -> RangeError', () => {
    const { s } = build(64, makeBars(1, 201, 'int'));
    const out = new Float64Array(7 * 4 + 8);
    for (const B of [0, -1, 1.5, 2 ** 20 + 1, NaN, Infinity, '2', undefined, null])
        assert.throws(() => s.decimateInto(0, 10, B, out, 0), { name: 'RangeError', message: /B must be an integer/ }, 'B=' + String(B));
    // B = 2^20 itself is a valid B: it must hit the length rule, not the B rule
    assert.throws(() => s.decimateInto(0, 10, 2 ** 20, out, 0), RangeError);
    const big = new Float64Array(7 * 2 ** 20);
    assert.equal(s.decimateInto(0, 9, 2 ** 20, big, 0), 10);
});

test('A8e: off + 7B > out.length -> RangeError for valid, empty and invalid ranges, and at count 0', () => {
    const { s } = build(64, makeBars(2, 201, 'int'));
    const out = new Float64Array(7 * 4 + 6).fill(FILL); // 34 slots
    assert.throws(() => s.decimateInto(0, 10, 5, out, 0), RangeError);          // 35 > 34
    assert.throws(() => s.decimateInto(0, 10, 4, out, 7), RangeError);          // 7 + 28 = 35 > 34
    assert.throws(() => s.decimateInto(3, 2, 5, out, 0), RangeError);           // invalid (reversed)
    assert.throws(() => s.decimateInto(-1, -1, 5, out, 0), RangeError);
    assert.throws(() => s.decimateInto(0, s.count, 5, out, 0), RangeError);     // out of range
    assert.throws(() => s.decimateInto(NaN, 0, 5, out, 0), RangeError);
    for (let q = 0; q < out.length; q++) assert.ok(Object.is(out[q], FILL), 'a throwing call must not write');
    assert.equal(s.decimateInto(0, 10, 4, out, 6), 4); // 6 + 28 = 34: exactly fits
    const empty = new OhlcSeries(16, 60000);
    assert.throws(() => empty.decimateInto(0, 0, 3, new Float64Array(20), 0), RangeError); // 21 > 20
    assert.equal(empty.decimateInto(0, 0, 3, new Float64Array(21), 0), 0);
});

test('A8e: off non-integer or negative -> RangeError', () => {
    const { s } = build(64, makeBars(3, 201, 'int'));
    const out = new Float64Array(200).fill(FILL);
    for (const off of [-1, 0.5, NaN, Infinity, -0.5])
        assert.throws(() => s.decimateInto(0, 10, 2, out, off), RangeError, 'off=' + off);
    for (let q = 0; q < out.length; q++) assert.ok(Object.is(out[q], FILL));
    assert.equal(s.decimateInto(0, 10, 2, out), 2); // off defaults to 0
    assert.ok(Object.is(out[0], T(137)));
});

test('A8e: out not a Float64Array -> TypeError', () => {
    const { s } = build(64, makeBars(4, 201, 'int'));
    assert.throws(() => s.decimateInto(0, 10, 2, [], 0), TypeError);
    assert.throws(() => s.decimateInto(0, 10, 2, new Float32Array(64), 0), TypeError);
    assert.throws(() => s.decimateInto(0, 10, 2, new Array(64).fill(0), 0), TypeError);
    assert.throws(() => s.decimateInto(0, 10, 2, null, 0), TypeError);
});

test('A8e: invalid ranges return 0 and write nothing', () => {
    const { s } = build(64, makeBars(5, 201, 'int'));
    const n = s.count;
    for (const [a, b] of [[-1, -1], [3, 2], [0, n], [0.5, 1], [NaN, 0], [0, NaN], [n, n], [0, 1.5]]) {
        const out = new Float64Array(7 * 3 + 2).fill(FILL);
        assert.equal(s.decimateInto(a, b, 3, out, 1), 0, 'range ' + a + ',' + b);
        for (let q = 0; q < out.length; q++) assert.ok(Object.is(out[q], FILL), 'range ' + a + ',' + b + ' wrote slot ' + q);
    }
    const empty = new OhlcSeries(16, 60000);
    const out = new Float64Array(14).fill(FILL);
    assert.equal(empty.decimateInto(0, 0, 2, out, 0), 0);
    for (let q = 0; q < out.length; q++) assert.ok(Object.is(out[q], FILL));
});

test('A8e: tail past off + 7*written and head before off untouched; short ranges (n < B) emit n rows', () => {
    const { s, res } = build(64, makeBars(6, 201, 'int'));
    const out = new Float64Array(200).fill(FILL);
    const w = s.decimateInto(10, 12, 20, out, 5); // n = 3 < B = 20 -> 3 non-empty buckets
    assert.equal(w, 3);
    for (let q = 0; q < 5; q++) assert.ok(Object.is(out[q], FILL));
    for (let q = 5 + 21; q < 200; q++) assert.ok(Object.is(out[q], FILL), 'tail slot ' + q);
    // each bar its own row; k is the bucket index (ceil form: bar r of n=3 under B=20 -> k = floor(r*20/3))
    for (let r = 0; r < 3; r++) {
        const base = 5 + r * 7;
        assert.ok(Object.is(out[base], res[10 + r][0]));
        assert.ok(Object.is(out[base + 6], Math.floor(r * 20 / 3)));
    }
});

test('A8e: every written k is +0 not -0, including an i0 = -0 input', () => {
    const { s } = build(64, makeBars(7, 201, 'int'));
    for (const f of [pubOf, scanOf, treeOf]) {
        for (const [a, b] of [[-0, 5], [0, 5], [-0, 0]]) {
            for (const B of [1, 3, 8]) {
                const r = f(s, a, b, B);
                assert.ok(r.w >= 1);
                assert.ok(Object.is(r.out[3 + 6], 0), f.name + ' k of row 0 must be +0, i0=' + Object.is(a, -0) + ' B=' + B);
                for (let q = 0; q < r.w; q++) assert.ok(!Object.is(r.out[3 + q * 7 + 6], -0));
            }
        }
    }
});

// ------------------------------------------------------------------ D5 volume rule
test('D5: integer volumes -> v byte-identical across paths; fractional -> scan = sequential, tree = boundsInto', () => {
    // integer: a mid-size query through both paths
    const ints = build(64, makeBars(0xD5, 201, 'int'));
    for (const B of [1, 4, 9]) {
        const a = scanOf(ints.s, 3, 60, B), b = treeOf(ints.s, 3, 60, B);
        assert.ok(sameLane(a.out, b.out, a.w, 5), 'integer v must match across paths, B=' + B);
    }
    // fractional: the rule holds and the paths genuinely differ for at least one query (teeth)
    const fr = build(64, makeBars(0xD6, 201, 'frac'));
    const bo = new Float64Array(9);
    let differ = 0;
    for (const B of [1, 2, 5, 9]) for (let i0 = 0; i0 < 20; i0++) {
        const i1 = 63 - i0;
        const exp = naive(fr.res, i0, i1, B);
        const a = scanOf(fr.s, i0, i1, B), b = treeOf(fr.s, i0, i1, B);
        for (let r = 0; r < exp.rows.length; r++) {
            assert.ok(Object.is(a.out[3 + r * 7 + 5], exp.rows[r][5]));
            fr.s.boundsInto(exp.bounds[r][0], exp.bounds[r][1], bo, 0);
            assert.ok(Object.is(b.out[3 + r * 7 + 5], bo[5]));
            if (!Object.is(a.out[3 + r * 7 + 5], b.out[3 + r * 7 + 5])) differ++;
        }
    }
    assert.ok(differ > 0, 'fractional volumes must separate the paths');
});

test('D5: a given (state, i0, i1, B) always takes the same path (repeat calls byte-identical)', () => {
    const { s } = build(64, makeBars(0xD7, 201, 'frac'));
    for (const [i0, i1, B] of [[0, 63, 3], [5, 30, 7], [0, 63, 16], [10, 12, 2]]) {
        const a = pubOf(s, i0, i1, B), b = pubOf(s, i0, i1, B);
        for (let lane = 0; lane < 7; lane++) assert.ok(sameLane(a.out, b.out, a.w, lane));
    }
});

test('addendum 8: boundsInto writes +0 index slots for an i0 / i1 = -0 input', () => {
    const { s } = build(64, makeBars(8, 201, 'int'));
    const out = new Float64Array(9);
    assert.equal(s.boundsInto(-0, 5, out, 0), 6);
    assert.ok(Object.is(out[6], 0));
    assert.equal(s.boundsInto(-0, -0, out, 0), 1);
    assert.ok(Object.is(out[6], 0) && Object.is(out[7], 0));
});
