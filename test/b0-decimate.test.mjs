// B0 gate A2: decimateInto == naive scan oracle. v2 contract (PLAN-v2 S7, A2).
// Runs against OHLC_MODULE (default ../Ohlc.js). v1 (LiteTimeSeries) is adapted inline, only to
// prove the gate is red on v1; the v2 branch is exactly the spec.
// Oracle: per bar r in [0,n), bucket = floor(r*B/n) -- independent of S7's ceil bounds.
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import(new URL(process.env.OHLC_MODULE ?? '../Ohlc.js', import.meta.url));

function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const T0 = 1.7e12;
const STEP = 60000;
const tOf = (j) => T0 + j * STEP;
const FILL = 12345.5;
const OFF = 3;
const FIELDS = ['t_first', 'o_first', 'max_h', 'min_l', 'c_last', 'sum_v', 'k'];

let api;
if (mod.OhlcSeries) {
    api = {
        make: (cap) => new mod.OhlcSeries(cap, STEP),
        append: (s, t, o, h, l, c, v) => s.appendBar(t, o, h, l, c, v),
        decimate: (s, i0, i1, B, out, M) => s.decimateInto(i0, i1, B, out, OFF),
    };
} else if (mod.LiteTimeSeries) {
    api = {
        make: (cap) => new mod.LiteTimeSeries({ capacity: cap }),
        append: (s, t, o, h, l, c, v) => s.append(t, o, h, l, c, v),
        decimate: (s, i0, i1, B, out, M) => {
            const first = M - s.count; // bar index of logical 0
            return s.decimateInto(tOf(first + i0), tOf(first + i1), B, out, OFF);
        },
    };
} else {
    throw new Error('module exports neither OhlcSeries nor LiteTimeSeries');
}

// Deterministic bar j (independent key stream per file: seed fixed, op stream = j order).
function makeBars(M, seed) {
    const rng = mulberry32(seed);
    const bars = [];
    for (let j = 0; j < M; j++) {
        const base = 100 + rng() * 50;
        const h = base + rng() * 10;
        const l = base - rng() * 10;
        const o = l + (h - l) * rng();
        const c = l + (h - l) * rng();
        const v = (rng() * 1000) | 0; // integer vols
        bars.push([tOf(j), o, h, l, c, v]);
    }
    return bars;
}

function build(cap, bars) {
    const s = api.make(cap);
    for (const b of bars) api.append(s, b[0], b[1], b[2], b[3], b[4], b[5]);
    return s;
}

function oracle(bars, M, cap, i0, i1, B) {
    const count = Math.min(M, cap);
    const first = M - count; // bar index of logical 0
    const n = i1 - i0 + 1;
    const buckets = new Map(); // k -> record, insertion ascending because r ascends
    for (let r = 0; r < n; r++) {
        const k = Math.floor(r * B / n);
        const b = bars[first + i0 + r];
        const rec = buckets.get(k);
        if (rec === undefined) buckets.set(k, [b[0], b[1], b[2], b[3], b[4], b[5], k]);
        else {
            if (b[2] > rec[2]) rec[2] = b[2];
            if (b[3] < rec[3]) rec[3] = b[3];
            rec[4] = b[4];
            rec[5] += b[5];
        }
    }
    return [...buckets.values()];
}

// Returns null on success, else a message naming the case and the first mismatch.
function check(name, s, bars, M, cap, i0, i1, B) {
    const exp = oracle(bars, M, cap, i0, i1, B);
    const n = i1 - i0 + 1;
    const out = new Float64Array(OFF + 7 * B + 5).fill(FILL);
    const ret = api.decimate(s, i0, i1, B, out, M);
    const tag = name + ' (cap ' + cap + ', M ' + M + ', i0 ' + i0 + ', i1 ' + i1 + ', B ' + B + ')';
    for (let q = 0; q < OFF; q++) {
        if (!Object.is(out[q], FILL)) return tag + ': head slot ' + q + ' clobbered, got ' + out[q];
    }
    for (let w = 0; w < exp.length; w++) {
        for (let f = 0; f < 7; f++) {
            const slot = OFF + 7 * w + f;
            if (!Object.is(out[slot], exp[w][f])) {
                return tag + ': bucket ' + w + ' ' + FIELDS[f] + ' (out[' + (7 * w + f) + ' rel]) expected ' +
                    exp[w][f] + ', actual ' + out[slot];
            }
        }
    }
    if (ret !== Math.min(n, B)) return tag + ': return expected ' + Math.min(n, B) + ', actual ' + ret;
    for (let q = OFF + 7 * exp.length; q < out.length; q++) {
        if (!Object.is(out[q], FILL)) {
            return tag + ': tail slot ' + (q - OFF) + ' rel expected untouched ' + FILL + ', actual ' + out[q];
        }
    }
    return null;
}

const VECTORS = [
    ['V1', 16, 10, 0, 9, 4], ['V2', 16, 10, 0, 2, 8], ['V3', 16, 37, 0, 15, 3],
    ['V4 seam', 16, 37, 9, 13, 2], ['V5', 16, 37, 4, 4, 1], ['V6 tree', 64, 200, 0, 63, 2],
    ['V7 tree', 64, 200, 0, 63, 7], ['V8 scan', 64, 200, 0, 63, 16], ['V9', 64, 200, 50, 63, 1],
    ['V10', 64, 200, 0, 63, 64], ['V11', 64, 200, 10, 20, 100],
];
for (const [name, cap, M, i0, i1, B] of VECTORS) {
    test('A2 decimate == naive: ' + name, () => {
        const bars = makeBars(M, 0xDEC1 + M);
        const s = build(cap, bars);
        const msg = check(name, s, bars, M, cap, i0, i1, B);
        assert.equal(msg, null, msg);
    });
}

test('A2 decimate == naive: sweep cap 16, M 37, all 136 (i0,i1) x B in {1,2,3,5,16,17}', () => {
    const cap = 16, M = 37;
    const bars = makeBars(M, 0x5EED + M);
    const s = build(cap, bars);
    let cases = 0, failing = 0, first = null;
    for (let i0 = 0; i0 < cap; i0++) for (let i1 = i0; i1 < cap; i1++) for (const B of [1, 2, 3, 5, 16, 17]) {
        cases++;
        const msg = check('sweep', s, bars, M, cap, i0, i1, B);
        if (msg !== null) { failing++; if (first === null) first = msg; }
    }
    assert.equal(cases, 816, 'sweep coverage floor: expected 816 cases, ran ' + cases);
    assert.equal(failing, 0, failing + ' of ' + cases + ' sweep cases failing; first: ' + first);
});
