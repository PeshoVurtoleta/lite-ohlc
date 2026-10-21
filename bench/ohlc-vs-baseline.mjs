// bench/ohlc-vs-baseline.mjs -- lite-ohlc vs a hand-rolled best-form baseline (REPORTED tier).
//
//   node --expose-gc bench/ohlc-vs-baseline.mjs          timed run (wrap it in quiet-lock), writes
//                                                         bench/RESULTS.md, exits verdict().exit
//   node bench/ohlc-vs-baseline.mjs --smoke              cross-check + one runner call per row, untimed
//   node bench/ohlc-vs-baseline.mjs --probe              path probe (patches the _decimate* prototypes)
//   node bench/ohlc-vs-baseline.mjs --selftest-mismatch  cross-check with one injected error: exits 1
//
// Hot = the runners only (one monomorphic runner per (side, op), SMI args from Int32Array start
// tables, Float64Array out, sink in a Float64Array(1)). Everything else is cold. The timing process
// never patches anything: the probe runs in its own child process.
//
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

import { cpus, loadavg } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { OhlcSeries } from '../Ohlc.js';
import {
    makeBars, baseBoundsInto, baseDecimateInto, baseDecimateIdiomatic, PushShiftRing, IndexRing,
} from './baseline.mjs';
import { BAR, verdict } from './verdict.mjs';

const FLAGS = ['--smoke', '--probe', '--selftest-mismatch'];
const STARTS = 1024; // seeded window starts per row (mask 1023)
const TICK_TAB = 4096; // setLive candle table (mask 4095); 60 ticks per bar: 59 same-time + 1 new
const BLOCK_MS = 20;
const WARMUP = 3;
const MAX_OPS = 0x3FFFFFFF;
const OUT_LEN = 7 * 1920;
const SENT = 0xDEADBEEF;

// Rows (TASK 3). Path per row from Ohlc.js:561/567: scan iff w < B * log2(C), sparse iff w - 1 < B.
const NS = [1e4, 1e5, 1e6];
const WS = { 1e4: [1e3], 1e5: [1e3, 1e5], 1e6: [1e3, 1e5] };
const BS = [800, 1920];
const PATH = { '1e3/800': 'scan', '1e3/1920': 'sparse', '1e5/800': 'tree', '1e5/1920': 'tree' };

function capOf(n) { let c = 2; while (c < n) c *= 2; return c; }
function log2(c) { return 31 - Math.clz32(c); }
function ruleOf(w, B, C) { return w < B * log2(C) ? (w - 1 < B ? 'sparse' : 'scan') : 'tree'; }
function tag(x) { return x === 1e4 ? '1e4' : x === 1e5 ? '1e5' : x === 1e6 ? '1e6' : x === 1e3 ? '1e3' : String(x); }

// --- data (cold) --------------------------------------------------------------

/** xorshift32 over a Uint32Array(1) state. */
function rnd(st) {
    let x = st[0];
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    st[0] = x;
    return st[0];
}

/** n valid candles, stride 6: t = 60i, prices on a 0.01 grid (integer cents / 100), v in [1, 1e6]. */
function genCandles(n, seed) {
    const st = new Uint32Array([seed]);
    const buf = new Float64Array(6 * n);
    let p = 10000;
    for (let i = 0; i < n; i++) {
        const o = p;
        const step = (rnd(st) % 101) - 50;
        let c = o + step;
        if (c < 500) c = o - step;
        const hi = o > c ? o : c;
        const lo = o < c ? o : c;
        const h = hi + (rnd(st) % 31);
        const l = lo - (rnd(st) % 31);
        const k = 6 * i;
        buf[k] = 60 * i;
        buf[k + 1] = o / 100;
        buf[k + 2] = h / 100;
        buf[k + 3] = l / 100;
        buf[k + 4] = c / 100;
        buf[k + 5] = 1 + (rnd(st) % 1000000);
        p = c;
    }
    return buf;
}

function genStarts(n, w, seed) {
    const st = new Uint32Array([seed]);
    const s = new Int32Array(STARTS);
    const span = n - w + 1;
    for (let i = 0; i < STARTS; i++) s[i] = rnd(st) % span;
    return s;
}

function seriesFrom(buf, count, C) {
    const s = new OhlcSeries(C, 60);
    for (let i = 0; i < count; i++) s.appendBarFrom(buf, 6 * i);
    return s;
}

/** One n group: lite series, control series, baseline bars, start tables. */
function buildGroup(n, withBase) {
    const C = capOf(n);
    const buf = genCandles(n, 0x9E3779B9 ^ n);
    const g = { n, C, lite: seriesFrom(buf, n, C), ctl: null, bars: null, starts: {} };
    if (withBase) {
        g.ctl = seriesFrom(buf, n, C);
        g.bars = makeBars(buf, n);
    }
    for (const w of WS[n]) g.starts[w] = genStarts(n, w, 0x85EBCA6B ^ (n + w));
    return g;
}

/** setLive state for one side: preloaded to C bars, own tick table, clock and tick counters. */
function liveSide(kind, C, pre) {
    let ring;
    if (kind === 'lite') ring = seriesFrom(pre, C, C);
    else {
        ring = kind === 'idx' ? new IndexRing(C) : new PushShiftRing(C);
        for (let i = 0; i < C; i++) ring.setLiveFrom(pre, 6 * i);
    }
    const tab = genCandles(TICK_TAB, 0xC2B2AE35);
    const clk = new Float64Array([60 * C]);
    return { ring, tab, clk, st: new Int32Array(2) };
}

function buildLive(n, withCtl) {
    const C = capOf(n);
    const pre = genCandles(C, 0x27D4EB2F ^ C);
    return {
        n, C,
        lite: liveSide('lite', C, pre),
        ctl: withCtl ? liveSide('lite', C, pre) : null,
        idx: liveSide('idx', C, pre),
        push: liveSide('push', C, pre),
    };
}

// --- hot runners (one per (side, op)) ---------------------------------------------

function liteBounds(s, starts, w1, out, sink, ops) {
    let acc = 0;
    for (let i = 0; i < ops; i++) {
        const i0 = starts[i & 1023];
        acc = (acc + s.boundsInto(i0, i0 + w1, out, 0)) | 0;
    }
    sink[0] += out[5];
    return acc;
}

function liteBoundsCtl(s, starts, w1, out, sink, ops) {
    let acc = 0;
    for (let i = 0; i < ops; i++) {
        const i0 = starts[i & 1023];
        acc = (acc + s.boundsInto(i0, i0 + w1, out, 0)) | 0;
    }
    sink[0] += out[5];
    return acc;
}

function baseBounds(bars, starts, w1, out, sink, ops) {
    let acc = 0;
    for (let i = 0; i < ops; i++) {
        const i0 = starts[i & 1023];
        acc = (acc + baseBoundsInto(bars, i0, i0 + w1, out, 0)) | 0;
    }
    sink[0] += out[5];
    return acc;
}

function liteDecimate(s, starts, w1, B, out, sink, ops) {
    let acc = 0;
    for (let i = 0; i < ops; i++) {
        const i0 = starts[i & 1023];
        acc = (acc + s.decimateInto(i0, i0 + w1, B, out, 0)) | 0;
    }
    sink[0] += out[5];
    return acc;
}

function liteDecimateCtl(s, starts, w1, B, out, sink, ops) {
    let acc = 0;
    for (let i = 0; i < ops; i++) {
        const i0 = starts[i & 1023];
        acc = (acc + s.decimateInto(i0, i0 + w1, B, out, 0)) | 0;
    }
    sink[0] += out[5];
    return acc;
}

function baseDecimate(bars, starts, w1, B, out, sink, ops) {
    let acc = 0;
    for (let i = 0; i < ops; i++) {
        const i0 = starts[i & 1023];
        acc = (acc + baseDecimateInto(bars, i0, i0 + w1, B, out, 0)) | 0;
    }
    sink[0] += out[5];
    return acc;
}

function baseDecimateIdio(bars, starts, w1, B, out, sink, ops) {
    let acc = 0;
    for (let i = 0; i < ops; i++) {
        const i0 = starts[i & 1023];
        acc = (acc + baseDecimateIdiomatic(bars, i0, i0 + w1, B, out, 0)) | 0;
    }
    sink[0] += out[5];
    return acc;
}

function liteSetLive(s, tab, clk, st, sink, ops) {
    let j = st[0];
    let m = st[1];
    for (let i = 0; i < ops; i++) {
        const off = j * 6;
        tab[off] = clk[0];
        s.setLiveFrom(tab, off);
        j = (j + 1) & 4095;
        if (++m === 60) { m = 0; clk[0] += 60; }
    }
    st[0] = j;
    st[1] = m;
    sink[0] += clk[0];
    return ops;
}

function liteSetLiveCtl(s, tab, clk, st, sink, ops) {
    let j = st[0];
    let m = st[1];
    for (let i = 0; i < ops; i++) {
        const off = j * 6;
        tab[off] = clk[0];
        s.setLiveFrom(tab, off);
        j = (j + 1) & 4095;
        if (++m === 60) { m = 0; clk[0] += 60; }
    }
    st[0] = j;
    st[1] = m;
    sink[0] += clk[0];
    return ops;
}

function baseSetLiveIdx(r, tab, clk, st, sink, ops) {
    let j = st[0];
    let m = st[1];
    for (let i = 0; i < ops; i++) {
        const off = j * 6;
        tab[off] = clk[0];
        r.setLiveFrom(tab, off);
        j = (j + 1) & 4095;
        if (++m === 60) { m = 0; clk[0] += 60; }
    }
    st[0] = j;
    st[1] = m;
    sink[0] += clk[0];
    return ops;
}

function baseSetLivePush(r, tab, clk, st, sink, ops) {
    let j = st[0];
    let m = st[1];
    for (let i = 0; i < ops; i++) {
        const off = j * 6;
        tab[off] = clk[0];
        r.setLiveFrom(tab, off);
        j = (j + 1) & 4095;
        if (++m === 60) { m = 0; clk[0] += 60; }
    }
    st[0] = j;
    st[1] = m;
    sink[0] += clk[0];
    return ops;
}

// --- cold: shared buffers ------------------------------------------------------

const sink = new Float64Array(1);
const outA = new Float64Array(OUT_LEN);
const outB = new Float64Array(OUT_LEN);
const outA32 = new Uint32Array(outA.buffer);
const outB32 = new Uint32Array(outB.buffer);

/** Comparisons for one bounds/decimate group; `rows` and `ctls` are cold descriptors. */
function groupJobs(g) {
    const jobs = [];
    const n = g.n;
    for (const w of WS[n]) {
        const st = g.starts[w];
        const w1 = w - 1;
        jobs.push({ op: 'bounds', n, w, B: 0, path: 'tree', baseline: 'best',
            a: (k) => liteBounds(g.lite, st, w1, outA, sink, k),
            b: (k) => baseBounds(g.bars, st, w1, outB, sink, k) });
        for (const B of BS) {
            const path = PATH[tag(w) + '/' + B];
            jobs.push({ op: 'decimate', n, w, B, path, baseline: 'best',
                a: (k) => liteDecimate(g.lite, st, w1, B, outA, sink, k),
                b: (k) => baseDecimate(g.bars, st, w1, B, outB, sink, k) });
            jobs.push({ op: 'decimate', n, w, B, path, baseline: 'idiomatic',
                a: (k) => liteDecimate(g.lite, st, w1, B, outA, sink, k),
                b: (k) => baseDecimateIdio(g.bars, st, w1, B, outB, sink, k) });
        }
    }
    if (n === 1e6) {
        const st = g.starts[1e5];
        jobs.push({ ctl: 'bounds (1e6, 1e5) lite vs lite',
            a: (k) => liteBounds(g.lite, st, 1e5 - 1, outA, sink, k),
            b: (k) => liteBoundsCtl(g.ctl, st, 1e5 - 1, outB, sink, k) });
        jobs.push({ ctl: 'decimate (1e6, 1e5, 1920) tree lite vs lite',
            a: (k) => liteDecimate(g.lite, st, 1e5 - 1, 1920, outA, sink, k),
            b: (k) => liteDecimateCtl(g.ctl, st, 1e5 - 1, 1920, outB, sink, k) });
        const st3 = g.starts[1e3];
        jobs.push({ pos: 'baseBounds n=1e6 w=1e5 vs w=1e3', baseSides: true,
            a: (k) => baseBounds(g.bars, st3, 1e3 - 1, outA, sink, k),
            b: (k) => baseBounds(g.bars, st, 1e5 - 1, outB, sink, k) });
    }
    if (n === 1e5) {
        const st = g.starts[1e3];
        jobs.push({ ctl: 'decimate (1e5, 1e3, 800) scan lite vs lite',
            a: (k) => liteDecimate(g.lite, st, 1e3 - 1, 800, outA, sink, k),
            b: (k) => liteDecimateCtl(g.ctl, st, 1e3 - 1, 800, outB, sink, k) });
    }
    return jobs;
}

function liveJobs(L) {
    const jobs = [];
    const x = L.lite;
    const lite = (k) => liteSetLive(x.ring, x.tab, x.clk, x.st, sink, k);
    const y = L.idx;
    jobs.push({ op: 'setLive', n: L.n, w: 0, B: 0, path: '-', baseline: 'best', a: lite,
        b: (k) => baseSetLiveIdx(y.ring, y.tab, y.clk, y.st, sink, k) });
    const z = L.push;
    jobs.push({ op: 'setLive', n: L.n, w: 0, B: 0, path: '-', baseline: 'idiomatic', a: lite,
        b: (k) => baseSetLivePush(z.ring, z.tab, z.clk, z.st, sink, k) });
    if (L.ctl) {
        const c = L.ctl;
        jobs.push({ ctl: 'setLive 1e5 lite vs lite', a: lite,
            b: (k) => liteSetLiveCtl(c.ring, c.tab, c.clk, c.st, sink, k) });
    }
    return jobs;
}

// --- cold: cross-check -----------------------------------------------------------

let injectMismatch = false;
let crossFail = ''; // first CROSS-CHECK FAIL reason: the selftest requires it to be the injected one

function mismatch(what) {
    if (crossFail === '') crossFail = what;
    console.error('CROSS-CHECK FAIL ' + what);
    return false;
}

function cmpSlots(slots) {
    for (let i = 0; i < 2 * slots; i++) if (outA32[i] !== outB32[i]) return (i >> 1);
    return -1;
}

function crossGroup(g, counts) {
    const n = g.n;
    for (const w of WS[n]) {
        const st = g.starts[w];
        for (let j = 0; j < STARTS; j++) {
            const i0 = st[j];
            const i1 = i0 + w - 1;
            outA32.fill(SENT);
            outB32.fill(SENT);
            const ra = g.lite.boundsInto(i0, i1, outA, 0);
            const rb = baseBoundsInto(g.bars, i0, i1, outB, 0);
            if (injectMismatch && counts.bounds === 0) outB[5] += 1;
            const bad = cmpSlots(9);
            if (ra !== rb || bad >= 0) {
                return mismatch('bounds n=' + n + ' w=' + w + ' start#' + j + ' i0=' + i0 +
                    ' ret ' + ra + '/' + rb + ' slot ' + bad + ' lite=' + outA[bad] + ' base=' + outB[bad]);
            }
            counts.bounds++;
        }
        for (const B of BS) {
            for (let j = 0; j < STARTS; j++) {
                const i0 = st[j];
                const i1 = i0 + w - 1;
                outA32.fill(SENT);
                outB32.fill(SENT);
                const ra = g.lite.decimateInto(i0, i1, B, outA, 0);
                const rb = baseDecimateInto(g.bars, i0, i1, B, outB, 0);
                let bad = cmpSlots(7 * B);
                if (ra !== rb || bad >= 0) {
                    return mismatch('decimate best n=' + n + ' w=' + w + ' B=' + B + ' start#' + j +
                        ' ret ' + ra + '/' + rb + ' slot ' + bad);
                }
                outB32.fill(SENT);
                const ri = baseDecimateIdiomatic(g.bars, i0, i1, B, outB, 0);
                bad = cmpSlots(7 * B);
                if (ra !== ri || bad >= 0) {
                    return mismatch('decimate idiomatic n=' + n + ' w=' + w + ' B=' + B + ' start#' + j +
                        ' ret ' + ra + '/' + ri + ' slot ' + bad);
                }
                counts.decimate++;
                counts.idiomatic++;
            }
        }
        counts.boundsRows++;
        counts.decimateRows += BS.length;
    }
    return true;
}

/** Runs the same tick stream through every side, then compares count + the last 256 bars bitwise. */
function crossLive(L, counts) {
    const T = 6000;
    const J = liveJobs(L); // the same closures the timed path runs (built with no ctl job)
    if (J[1].a !== J[0].a) return mismatch('setLive lite closure not shared');
    J[0].a(T);
    J[0].b(T);
    J[1].b(T);
    const lite = L.lite.ring;
    const cnt = lite.count;
    const K = 256;
    for (const side of [L.idx, L.push]) {
        const r = side.ring;
        if (r.count !== cnt) return mismatch('setLive n=' + L.n + ' count ' + cnt + '/' + r.count);
        outA32.fill(SENT);
        outB32.fill(SENT);
        lite.copyRangeInto(cnt - K, cnt - 1, outA, 0);
        for (let i = 0; i < K; i++) {
            const b = r.at(cnt - K + i);
            const d = 6 * i;
            outB[d] = b.t; outB[d + 1] = b.o; outB[d + 2] = b.h;
            outB[d + 3] = b.l; outB[d + 4] = b.c; outB[d + 5] = b.v;
        }
        const bad = cmpSlots(6 * K);
        if (bad >= 0) return mismatch('setLive n=' + L.n + ' last ' + K + ' bars slot ' + bad);
        counts.live++;
    }
    return true;
}

/** Runner-level cross-check: each row's timed closures over all STARTS must return the same acc and leave the same slots. */
function crossJobs(jobs) {
    for (const j of jobs) {
        if (j.op !== 'bounds' && j.op !== 'decimate') continue;
        outA32.fill(SENT);
        outB32.fill(SENT);
        const ra = j.a(STARTS);
        const rb = j.b(STARTS);
        const bad = cmpSlots(j.op === 'bounds' ? 9 : 7 * j.B);
        if (ra !== rb || bad >= 0) return mismatch('runner ' + j.op + ' n=' + j.n + ' w=' + j.w + ' B=' + j.B + ' ' + j.baseline + ' acc ' + ra + '/' + rb + ' slot ' + bad);
    }
    return true;
}

function crossAll() {
    const counts = { bounds: 0, decimate: 0, idiomatic: 0, boundsRows: 0, decimateRows: 0, live: 0 };
    for (const n of NS) {
        try {
            const g = buildGroup(n, true);
            if (!crossGroup(g, counts) || !crossJobs(groupJobs(g))) return null;
            if (!crossLive(buildLive(n, false), counts)) return null;
        } catch (e) {
            mismatch('exception ' + (e && e.stack ? e.stack : String(e))); // fails closed: a throw is a failed cross-check, never an uncaught crash
            return null;
        }
    }
    return counts;
}

// --- cold: provenance -------------------------------------------------------------

/** Other node processes >= BAR.BUSY_PCPU, excluding this pid and its ancestors. Fails closed. */
function sampleBusy() {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,ucomm='], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) });
    if (r.status !== 0 || typeof r.stdout !== 'string') {
        return { ok: false, busy: true, excluded: [], hot: ['ps failed: status ' + r.status] };
    }
    const ppid = new Map();
    const rows = [];
    for (const line of r.stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = +m[1];
        ppid.set(pid, +m[2]);
        rows.push({ pid, pcpu: +m[3], comm: m[4].trim() });
    }
    if (!ppid.has(process.pid)) return { ok: false, busy: true, excluded: [], hot: ['ps parse failed: own pid ' + process.pid + ' not in ' + rows.length + ' parsed rows'] };
    const excluded = [];
    for (let p = process.pid; p > 1 && excluded.indexOf(p) < 0; p = ppid.has(p) ? ppid.get(p) : 0) excluded.push(p);
    const hot = [];
    for (const x of rows) {
        if (excluded.indexOf(x.pid) >= 0) continue;
        if (!/(^|\/)node$/i.test(x.comm)) continue;
        if (x.pcpu >= BAR.BUSY_PCPU) hot.push(x.pid + ' ' + x.pcpu + '% ' + x.comm);
    }
    return { ok: true, busy: hot.length > 0, excluded, hot };
}

const prov = { loads: [], busy: false, hot: [], excluded: [] };

function sampleHost(where) {
    const l = loadavg()[0];
    const b = sampleBusy();
    prov.loads.push({ where, load1: l });
    if (b.busy) prov.busy = true;
    for (const h of b.hot) prov.hot.push(where + ': ' + h);
    prov.excluded = b.excluded;
    return b;
}

function maxLoad() {
    if (prov.loads.length === 0) return Infinity; // no load1 sample = unverified host: fails closed (verdict INCONCLUSIVE)
    let m = 0;
    for (const x of prov.loads) {
        if (!(x.load1 > 0)) return Infinity; // non-positive / NaN load1 = unverified host: fails closed (verdict INCONCLUSIVE)
        if (x.load1 > m) m = x.load1;
    }
    return m;
}

// --- cold: timing -------------------------------------------------------------------

const gcSum = { lite: { major: 0, minor: 0 }, base: { major: 0, minor: 0 } };
let undrained = 0; // timed blocks whose prof.settle() did not report drained === true or whose summary().gc.observed !== true (A3 unverified)

function calibrate(run) {
    let ops = 1;
    let dt = 0;
    for (;;) {
        globalThis.gc();
        const t0 = performance.now();
        run(ops);
        dt = performance.now() - t0;
        if (dt >= 2 || ops >= MAX_OPS / 4) break;
        ops *= 4;
    }
    const k = Math.ceil(ops * BLOCK_MS / (dt > 0 ? dt : 1));
    return k < 1 ? 1 : k > MAX_OPS ? MAX_OPS : k;
}

/** One timed block: gc(), profiler start, run, stop. Returns elapsed ms. */
async function block(run, ops, acc) {
    const prof = new GcProfiler();
    globalThis.gc();
    prof.start();
    const t0 = performance.now();
    run(ops);
    const t1 = performance.now();
    const d = await prof.settle();
    const s = prof.summary();
    if (!(d !== null && typeof d === 'object' && d.drained === true) || s.gc.observed !== true) undrained++; // fails closed: no drained === true or an unobserved GC channel = undrained
    prof.stop();
    acc.major += s.gc.major;
    acc.minor += s.gc.minor;
    return t1 - t0;
}

function sorted(r) { return r.slice().sort((a, b) => a - b); }
function medOf(r) { return sorted(r)[(r.length - 1) >> 1]; }

/** ABBA rounds: per round A B B A; ns/op per side = both blocks' time / both blocks' ops. */
async function compare(job) {
    const aAcc = job.baseSides ? gcSum.base : gcSum.lite;
    const bAcc = job.ctl ? gcSum.lite : gcSum.base;
    const opsA = calibrate(job.a);
    const opsB = calibrate(job.b);
    for (let i = 0; i < WARMUP; i++) {
        globalThis.gc(); job.a(opsA);
        globalThis.gc(); job.b(opsB);
    }
    const nsA = [];
    const nsB = [];
    const ratios = [];
    for (let r = 0; r < BAR.K; r++) {
        let ta = await block(job.a, opsA, aAcc);
        let tb = await block(job.b, opsB, bAcc);
        tb += await block(job.b, opsB, bAcc);
        ta += await block(job.a, opsA, aAcc);
        const a = ta * 1e6 / (2 * opsA);
        const b = tb * 1e6 / (2 * opsB);
        nsA.push(a);
        nsB.push(b);
        ratios.push(b / a);
    }
    return { opsA, opsB, nsA, nsB, ratios };
}

// --- cold: report ---------------------------------------------------------------------

function f2(x) { return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2); }
function stat(r) {
    const s = sorted(r);
    return { med: s[(s.length - 1) >> 1], min: s[0], max: s[s.length - 1], q1: s[(s.length - 1) >> 2], q3: s[(3 * (s.length - 1)) >> 2] };
}

function writeResults(res, v, prelim) {
    const L = [];
    L.push('# lite-ohlc bench -- REPORTED tier' + (prelim ? ' -- PRELIMINARY' : ''));
    L.push('');
    L.push('Verdict: ' + v.v + ' (exit ' + v.exit + ')' + (prelim ? ' -- PRELIMINARY: ' + prelim : ''));
    if (v.hit) for (const h of v.hit) L.push('Headline-eligible hit: ' + h.op + ' n=' + h.n + ' w=' + h.w + (h.B ? ' B=' + h.B : '') + ' ratio median ' + f2(stat(h.ratios).med) + 'x');
    L.push('');
    L.push('## Provenance');
    L.push('');
    L.push('- date: ' + res.date);
    L.push('- cpu: ' + res.cpu + ', ncpu ' + res.ncpu);
    L.push('- node: ' + process.version);
    L.push('- runs: 1 run x ' + BAR.K + ' rounds (ABBA blocks of ~' + BLOCK_MS + ' ms per side, ' + WARMUP + ' warmup blocks, gc() before every block)');
    L.push('- load1 samples: ' + prov.loads.map((x) => x.where + '=' + x.load1.toFixed(2)).join(', '));
    L.push('- max load1: ' + maxLoad().toFixed(2) + ' (bar ' + BAR.LOAD_MAX + ')');
    L.push('- other node processes >= ' + BAR.BUSY_PCPU + '% CPU: ' + (prov.hot.length ? prov.hot.join('; ') : 'none') + ' (excluded own pid + ancestors: ' + prov.excluded.join(', ') + ')');
    L.push('- GC over timed lite blocks: major ' + gcSum.lite.major + ', minor ' + gcSum.lite.minor + ' (A3 requires 0 / 0: ' + (undrained > 0 ? 'A3 UNVERIFIED (' + undrained + ' windows did not drain or had no GC observer)' : gcSum.lite.major + gcSum.lite.minor === 0 ? 'PASS' : 'FAIL') + ')');
    L.push('- GC over timed baseline blocks (reported): major ' + gcSum.base.major + ', minor ' + gcSum.base.minor);
    L.push('- cross-check: ' + res.cross + '; probe exit ' + res.probeExit);
    L.push('');
    L.push('## Rows (ratio = baseline ns/op / lite ns/op, per round)');
    L.push('');
    L.push('| op | n | w | B | path | baseline | lite ns/op | base ns/op | ratio median [min, max] | IQR | eligible | clears |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of res.rows) {
        const s = stat(r.ratios);
        const elig = (r.op === 'bounds' || r.op === 'decimate') && r.baseline === 'best' && r.n >= BAR.N_MIN;
        L.push('| ' + r.op + ' | ' + tag(r.n) + ' | ' + (r.w ? tag(r.w) : '-') + ' | ' + (r.B || '-') + ' | ' + r.path + ' | ' + r.baseline +
            ' | ' + f2(medOf(r.nsA)) + ' | ' + f2(medOf(r.nsB)) + ' | ' + f2(s.med) + ' [' + f2(s.min) + ', ' + f2(s.max) + '] | ' +
            f2(s.q1) + '-' + f2(s.q3) + ' | ' + (elig ? 'yes' : 'no') + ' | ' + (r.clears ? 'yes' : 'no') + ' |');
    }
    L.push('');
    L.push('## Controls (lite vs lite: median must be in [' + BAR.CTRL_LO + ', ' + BAR.CTRL_HI + '] and must not clear; positive must clear)');
    L.push('');
    L.push('| control | A ns/op | B ns/op | ratio median [min, max] | IQR | clears |');
    L.push('|---|---|---|---|---|---|');
    for (const c of res.controls.concat([res.positive])) {
        const s = stat(c.ratios);
        L.push('| ' + c.name + ' | ' + f2(medOf(c.nsA)) + ' | ' + f2(medOf(c.nsB)) + ' | ' + f2(s.med) + ' [' + f2(s.min) + ', ' + f2(s.max) + '] | ' +
            f2(s.q1) + '-' + f2(s.q3) + ' | ' + (c.clears ? 'yes' : 'no') + ' |');
    }
    L.push('');
    writeFileSync(new URL('./RESULTS.md', import.meta.url), L.join('\n'));
}

// --- modes ---------------------------------------------------------------------------

function probe() {
    const P = OhlcSeries.prototype;
    const calls = [];
    for (const name of ['_decimateScan', '_decimateSparse', '_decimateTree']) {
        const orig = P[name];
        P[name] = function probed(i0, i1, B, out, off) { calls.push(name); return orig.call(this, i0, i1, B, out, off); };
    }
    const SEQ = { scan: '_decimateScan', sparse: '_decimateScan,_decimateSparse', tree: '_decimateTree' };
    const tally = { scan: 0, sparse: 0, tree: 0 };
    let ok = true;
    for (const n of NS) {
        const g = buildGroup(n, false);
        for (const w of WS[n]) {
            for (const B of BS) {
                const table = PATH[tag(w) + '/' + B];
                const rule = ruleOf(w, B, g.C);
                let seen = '';
                let same = true;
                for (let j = 0; j < STARTS; j++) {
                    calls.length = 0;
                    const i0 = g.starts[w][j];
                    g.lite.decimateInto(i0, i0 + w - 1, B, outA, 0);
                    const sq = calls.join(',');
                    if (j === 0) seen = sq;
                    else if (sq !== seen) same = false;
                }
                const label = seen === SEQ.scan ? 'scan' : seen === SEQ.sparse ? 'sparse' : seen === SEQ.tree ? 'tree' : '?(' + seen + ')';
                const rowOk = same && label === rule && label === table;
                if (!rowOk) ok = false;
                else tally[label]++;
                console.log('probe decimate n=' + tag(n) + ' w=' + tag(w) + ' B=' + B + ' S_H=' + log2(g.C) +
                    ' rule=' + rule + ' table=' + table + ' observed=' + label + (same ? '' : ' (varies by start)') + ' ' + (rowOk ? 'OK' : 'FAIL'));
            }
        }
    }
    console.log('probe tally: ' + tally.scan + ' scan, ' + tally.sparse + ' sparse, ' + tally.tree + ' tree -> ' + (ok ? 'PASS' : 'FAIL'));
    return ok ? 0 : 1;
}

function printCross(c) {
    console.log('cross-check bounds: ' + c.boundsRows + ' rows x ' + STARTS + ' starts = ' + c.bounds + ' PASS (bitwise, returns included)');
    console.log('cross-check decimate best: ' + c.decimateRows + ' rows x ' + STARTS + ' starts = ' + c.decimate + ' PASS');
    console.log('cross-check decimate idiomatic: ' + c.decimateRows + ' rows x ' + STARTS + ' starts = ' + c.idiomatic + ' PASS');
    console.log('cross-check setLive: ' + c.live + ' ring sides (IndexRing + PushShiftRing x ' + NS.length + ' n) PASS');
}

function smoke() {
    const c = crossAll();
    if (!c) return 1;
    printCross(c);
    let calls = 0;
    for (const n of NS) {
        for (const j of groupJobs(buildGroup(n, true))) { j.a(1); j.b(1); calls++; }
        for (const j of liveJobs(buildLive(n, n === 1e5))) { j.a(120); j.b(120); calls++; }
    }
    console.log('smoke runner calls: ' + calls + ' jobs (rows + controls + positive), one untimed call per side, sink ' + (sink[0] > 0 ? 'live' : 'DEAD'));
    const b = sampleBusy();
    console.log('busyNode excluded pids (self + ancestors): ' + b.excluded.join(', '));
    console.log('busyNode other node >= ' + BAR.BUSY_PCPU + '% CPU: ' + (b.hot.length ? b.hot.join('; ') : 'none') + ' -> busyNode=' + b.busy);
    console.log('load1 now: ' + loadavg()[0].toFixed(2) + ' (bar ' + BAR.LOAD_MAX + ', not gated in --smoke)');
    return 0;
}

async function timed() {
    if (typeof globalThis.gc !== 'function') {
        console.error('timed run needs node --expose-gc');
        return 1;
    }
    const res = { date: new Date().toISOString(), cpu: cpus()[0].model, ncpu: cpus().length, rows: [], controls: [], positive: null, cross: '', probeExit: -1 };
    sampleHost('start');
    const c = crossAll();
    const crossOk = c !== null;
    res.cross = crossOk ? (c.bounds + ' bounds + ' + c.decimate + ' decimate + ' + c.idiomatic + ' idiomatic starts + ' + c.live + ' setLive sides, bitwise PASS') : 'FAIL';
    if (crossOk) printCross(c);
    const pr = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe'], { stdio: 'inherit' });
    res.probeExit = pr.status;
    const probeOk = pr.status === 0;
    if (!crossOk || !probeOk) {
        const v = verdict({ crossOk, probeOk, rows: [], controls: [], positive: { ratios: [] }, maxLoad: maxLoad(), busyNode: prov.busy });
        console.error('VERDICT ' + v.v + ' exit ' + v.exit);
        return v.exit;
    }
    for (const n of NS) {
        // One n group in memory at a time (setLive rings first, then the bounds / decimate data).
        let jobs = liveJobs(buildLive(n, n === 1e5));
        for (const j of jobs) await runJob(j, res);
        jobs = groupJobs(buildGroup(n, true));
        for (const j of jobs) await runJob(j, res);
        jobs = null;
    }
    sampleHost('end');
    const v = verdict({ crossOk, probeOk, rows: res.rows, controls: res.controls, positive: res.positive, maxLoad: maxLoad(), busyNode: prov.busy });
    const why = [];
    if (maxLoad() > BAR.LOAD_MAX) why.push('load1 ' + maxLoad().toFixed(2) + ' > ' + BAR.LOAD_MAX);
    if (prov.busy) why.push('other node process >= ' + BAR.BUSY_PCPU + '% CPU');
    if (v.exit === 2 && why.length === 0) why.push('controls failed');
    writeResults(res, v, v.exit === 2 ? why.join('; ') : '');
    console.log('GC lite major=' + gcSum.lite.major + ' minor=' + gcSum.lite.minor + ' | base major=' + gcSum.base.major + ' minor=' + gcSum.base.minor);
    console.log('VERDICT ' + v.v + ' exit ' + v.exit + (why.length ? ' (' + why.join('; ') + ')' : '') + ' sink ' + sink[0]);
    return v.exit;
}

async function runJob(j, res) {
    const label = j.ctl ? 'control ' + j.ctl : j.pos ? 'positive ' + j.pos : j.op + ' n=' + tag(j.n) + (j.w ? ' w=' + tag(j.w) : '') + (j.B ? ' B=' + j.B : '') + ' ' + j.baseline;
    sampleHost(label);
    const m = await compare(j);
    const rec = { nsA: m.nsA, nsB: m.nsB, ratios: m.ratios, clears: false };
    if (j.ctl) { rec.name = j.ctl; res.controls.push(rec); }
    else if (j.pos) { rec.name = j.pos; res.positive = rec; }
    else { rec.op = j.op; rec.n = j.n; rec.w = j.w; rec.B = j.B; rec.path = j.path; rec.baseline = j.baseline; res.rows.push(rec); }
    const s = stat(m.ratios);
    rec.clears = m.ratios.length === BAR.K && s.med >= BAR.MEDIAN && s.min >= BAR.ROUND;
    console.log(label + ': A ' + f2(medOf(m.nsA)) + ' ns/op, B ' + f2(medOf(m.nsB)) + ' ns/op, ratio ' + f2(s.med) + ' [' + f2(s.min) + ', ' + f2(s.max) + ']' + (rec.clears ? ' CLEARS' : ''));
    await sleep(0);
}

async function main() {
    const args = process.argv.slice(2);
    for (const a of args) {
        if (FLAGS.indexOf(a) < 0) {
            const hint = FLAGS.find((f) => f.indexOf(a.replace(/^-+/, '').slice(0, 3)) >= 0);
            console.error('unknown flag ' + a + (hint ? ' -- did you mean ' + hint + '?' : '') + ' (valid: ' + FLAGS.join(' ') + ')');
            return 1;
        }
    }
    if (args.length > 1) { console.error('one flag at most'); return 1; }
    if (args[0] === '--probe') return probe();
    if (args[0] === '--selftest-mismatch') {
        injectMismatch = true;
        const c = crossAll();
        if (c || crossFail.indexOf('bounds n=' + NS[0] + ' w=' + WS[NS[0]][0] + ' start#0 ') !== 0) { console.error('selftest-mismatch: the injected mismatch was NOT the failure caught (' + (c ? 'cross-check passed' : crossFail) + ')'); return 0; }
        console.error('selftest-mismatch: injected mismatch caught -> exit 1');
        return 1;
    }
    if (args[0] === '--smoke') return smoke();
    return timed();
}

process.exit(await main());
