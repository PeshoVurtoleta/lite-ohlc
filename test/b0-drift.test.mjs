// B0 gate A1: sum-volume drift after a long run. v2 contract (PLAN-v2 S5, A1).
// Runs against OHLC_MODULE (default ../Ohlc.js). v1 (LiteTimeSeries) is adapted inline, only to
// prove the gate is red on v1; the v2 branch is exactly the spec.
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
const CAP = 1024;
const PRES = [1, 3, 7, 777];
const tOf = (j) => T0 + j * STEP;

// api: { make(cap), append(s,t,o,h,l,c,v), bounds(s,i0,i1,out) } where i0/i1 are logical indices
// and j-of-logical is computed from the harness model (bars appended so far).
let api;
if (mod.OhlcSeries) {
    api = {
        make: (cap) => new mod.OhlcSeries(cap, STEP),
        append: (s, t, o, h, l, c, v) => s.appendBar(t, o, h, l, c, v),
        bounds: (s, i0, i1, out, M) => s.boundsInto(i0, i1, out, 0),
    };
} else if (mod.LiteTimeSeries) {
    api = {
        make: (cap) => new mod.LiteTimeSeries({ capacity: cap }),
        append: (s, t, o, h, l, c, v) => s.append(t, o, h, l, c, v),
        bounds: (s, i0, i1, out, M) => {
            const first = M - s.count; // bar index of logical 0
            return s.computeBoundsInto(tOf(first + i0), tOf(first + i1), out, 0);
        },
    };
} else {
    throw new Error('module exports neither OhlcSeries nor LiteTimeSeries');
}

for (const N of [4, 64, 2048]) for (const PRE of PRES) {
    test('A1 drift: N=' + N + ' PRE=' + PRE + ' (' + (N * CAP + PRE) + ' random-volume bars, then 256 zero-volume bars)', () => {
        const rng = mulberry32(0x0DDBA11);
        const s = api.make(CAP);
        let M = 0;
        // PRE-ROLL: the literal A1 shape puts the zero window on phys 0..255, one Fenwick node, which v1
        // reads exactly (even with the fallback volumes). PRE extra bar misaligns the window; the
        // v2 contract is unchanged (bounds over the last 256 logical bars). Deviation recorded in B0 report.
        for (let i = 0; i < N * CAP + PRE; i++) {
            // Spec fallback volume distribution (the literal v = rng()*1e6 reads exactly +0 on v1).
            api.append(s, tOf(M), 100, 100, 100, 100, rng() < 0.5 ? rng() * 1e9 : rng() * 1e-3);
            M++;
        }
        for (let i = 0; i < 256; i++) {
            api.append(s, tOf(M), 100, 100, 100, 100, 0);
            M++;
        }
        const out = new Float64Array(9);
        const n = api.bounds(s, CAP - 256, CAP - 1, out, M);
        assert.equal(n, 256, 'A1 N=' + N + ' PRE=' + PRE + ': return value, expected 256, got ' + n);
        assert.equal(out[8], 256, 'A1 N=' + N + ' PRE=' + PRE + ' control: out[8] (n) expected 256, got ' + out[8]);
        assert.equal(out[2], 0, 'A1 N=' + N + ' PRE=' + PRE + ' control: out[2] (maxVol) expected 0, got ' + out[2]);
        assert.ok(Object.is(out[5], 0),
            'A1 N=' + N + ' PRE=' + PRE + ': out[5] (sumVol over 256 zero-volume bars) expected exact +0, got ' + out[5]);
    });
}
