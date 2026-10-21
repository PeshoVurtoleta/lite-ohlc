// ohlc-fastpath: decimateInto output against the frozen v1.0.0 build -- PLAN-1.0.1 ASSERTION 1.
// The fixture test/fixtures/Ohlc-v1.0.0.js is `git show v1.0.0:Ohlc.js`, pinned by sha256 (R2:
// no git at test time). Both modules get the same LCG feed; every case compares the WHOLE
// sentinel-prefilled out buffer bytewise (so slots past off + 7 * w are checked untouched) and
// the returns. The n <= B fast-path expectation is copyRangeInto rows + k = floor(m * B / n).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { OhlcSeries, MAX_BUCKETS } from '../Ohlc.js';
import { OhlcSeries as OhlcSeriesV100 } from './fixtures/Ohlc-v1.0.0.js';

const FIXTURE_SHA256 = '2a616e5b1c507e2586fb786024256b4c214d169fe3e55620757bb0f31b037f18';
const SENTINEL = -12345.5;
const CAPS = [2, 4, 64, 1024];
const SMALL_LEN = 7 * 4096 + 8; // B <= 1024 + 3000, off <= 3
const BIG_B = 1048576; // 2^20 = MAX_BUCKETS

let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const ri = (k) => Math.floor(rnd() * k); // integer in [0, k)

// One feed per cap: 2 * cap + 3 bars (the ring wraps), fractional volumes.
function makeFeed(cap) {
    const nb = cap * 2 + 3;
    const f = new Float64Array(6 * nb);
    for (let i = 0; i < nb; i++) {
        const o = 10 + rnd();
        f[6 * i] = i;
        f[6 * i + 1] = o;
        f[6 * i + 2] = o + rnd();
        f[6 * i + 3] = o - rnd();
        f[6 * i + 4] = o;
        f[6 * i + 5] = Math.floor(rnd() * 100) + rnd();
    }
    return f;
}

// live: every bar via setLiveFrom (the newest stays live). closed: the same, then the newest
// is re-appended with appendBarFrom at the same time (equal time replaces and closes it).
function build(Cls, cap, feed, live) {
    const s = new Cls(cap, 1);
    const nb = feed.length / 6;
    for (let i = 0; i < nb; i++) s.setLiveFrom(feed, 6 * i);
    if (!live) s.appendBarFrom(feed, 6 * (nb - 1));
    return s;
}

const PAIRS = [];
for (const cap of CAPS) {
    const feed = makeFeed(cap);
    for (const live of [true, false]) {
        PAIRS.push({ cap, live, h: Math.log2(cap), a: build(OhlcSeries, cap, feed, live), b: build(OhlcSeriesV100, cap, feed, live) });
    }
}

const smallA = new Float64Array(SMALL_LEN);
const smallB = new Float64Array(SMALL_LEN);
let bigA = null;
let bigB = null;
function big() {
    if (bigA === null) { bigA = new Float64Array(7 * BIG_B); bigB = new Float64Array(7 * BIG_B); }
}
const rows = new Float64Array(6 * 1024);

const bytes = (x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
const sameBytes = (x, y) => x.length === y.length && bytes(x).equals(bytes(y));
function firstDiff(x, y) {
    if (x.length !== y.length) return 'length ' + x.length + ' vs ' + y.length;
    const u = new BigUint64Array(x.buffer, x.byteOffset, x.length);
    const v = new BigUint64Array(y.buffer, y.byteOffset, y.length);
    for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return 'slot ' + i + ': ' + x[i] + ' vs ' + y[i];
    return '';
}

// Fast-path expectation for n <= B: bar m -> slots [7m .. 7m+5] = its row, slot 7m+6 = k.
function expectInto(s, i0, i1, B, e, off, kOf) {
    const n = s.copyRangeInto(i0, i1, rows, 0);
    for (let m = 0; m < n; m++) {
        const d = off + 7 * m;
        for (let j = 0; j < 6; j++) e[d + j] = rows[6 * m + j];
        e[d + 6] = kOf(m, B, n);
    }
    return n;
}
const kFloor = (m, B, n) => Math.floor((m * B) / n);
const kCeil = (m, B, n) => Math.ceil((m * B) / n);

// The LCG case list, drawn once and shared by (a), (b) and (d): per pair 200 cases n <= B
// (1600 total) and 50 cases n > B (400 total).
const CASES = [];
for (let pi = 0; pi < PAIRS.length; pi++) {
    const cnt = PAIRS[pi].a.count;
    for (let t = 0; t < 250; t++) {
        const sparse = t < 200;
        let i0;
        let i1;
        if (sparse) {
            i0 = ri(cnt);
            i1 = i0 + ri(cnt - i0);
        } else {
            i0 = ri(cnt - 1);
            i1 = i0 + 1 + ri(cnt - i0 - 1); // n >= 2
        }
        const n = i1 - i0 + 1;
        const B = sparse ? n + ri(3000) + (t % 3 === 0 ? 0 : 1) : 1 + ri(n - 1);
        CASES.push({ pi, i0, i1, B, off: t & 3, sparse });
    }
}

function runPair(p, i0, i1, B, x, y, off) {
    x.fill(SENTINEL);
    y.fill(SENTINEL);
    const wa = p.a.decimateInto(i0, i1, B, x, off);
    const wb = p.b.decimateInto(i0, i1, B, y, off);
    return { wa, wb };
}

test('(a) live vs v1.0.0 fixture: 2000 LCG cases + edges, whole buffer bytewise, returns equal', () => {
    for (const p of PAIRS) {
        assert.equal(p.a.hasLive, p.live, 'cap ' + p.cap + ' live flag');
        assert.equal(p.b.hasLive, p.live, 'cap ' + p.cap + ' fixture live flag');
        assert.equal(p.a.count, p.b.count, 'cap ' + p.cap + ' count');
        assert.equal(p.a.count, p.cap, 'cap ' + p.cap + ' ring full');
    }
    const bad = [];
    let sparse = 0;
    let denseScan = 0;
    let denseTree = 0;
    for (const c of CASES) {
        const p = PAIRS[c.pi];
        const r = runPair(p, c.i0, c.i1, c.B, smallA, smallB, c.off);
        const n = c.i1 - c.i0 + 1;
        if (c.sparse) sparse++;
        else if (n < c.B * p.h) denseScan++;
        else denseTree++;
        if (r.wa !== r.wb || r.wa !== Math.min(n, c.B) || !sameBytes(smallA, smallB)) {
            if (bad.length < 5) bad.push('cap ' + p.cap + ' live ' + p.live + ' [' + c.i0 + ',' + c.i1 + '] B ' + c.B + ' off ' + c.off + ': w ' + r.wa + '/' + r.wb + ' ' + firstDiff(smallA, smallB));
            else bad.push('');
        }
    }
    assert.equal(CASES.length, 2000);
    assert.equal(sparse, 1600);
    assert.ok(denseScan > 0 && denseTree > 0, 'n > B covers both paths: scan ' + denseScan + ' tree ' + denseTree);
    assert.equal(bad.length, 0, bad.length + ' mismatching cases: ' + bad.slice(0, 5).join(' | '));

    // Edges. Each row: [pair, i0, i1, B, off].
    const edges = [];
    for (const p of PAIRS) {
        const last = p.a.count - 1;
        const full = p.a.count;
        edges.push([p, 0, last, full, 0]); // n = B: cap 2 -> tree, otherwise scan
        edges.push([p, 0, last, full + 1, 0]); // n = B - 1
        if (full > 1) edges.push([p, 0, last, full - 1, 0]); // n = B + 1
        edges.push([p, 0, last, full, 3]); // off = 3
        edges.push([p, -0, last, full, 0]); // -0 i0
        edges.push([p, -0, -0, 5, 0]); // -0 i0 and i1
        edges.push([p, 0, -0, 1, -0]); // -0 i1 and off
        edges.push([p, -0, last, full - 1 || 1, -0]); // -0 i0 and off
        edges.push([p, last, last, 3, 3]); // n = 1 at the newest (live) bar
        edges.push([p, 1, last, full + 7, 3]); // inner range
        edges.push([p, 0, full, full, 0]); // invalid: i1 = count -> 0, nothing written
        edges.push([p, last, 0, 4, 0]); // invalid when count > 1: i0 > i1
        edges.push([p, 0.5, last, 4, 0]); // invalid: non-integer i0
    }
    let edgeN = 0;
    let treeEdges = 0;
    for (const [p, i0, i1, B, off] of edges) {
        const r = runPair(p, i0, i1, B, smallA, smallB, off);
        const n = i1 - i0 + 1;
        if (p.cap === 2 && n === B && n >= 2) treeEdges++;
        assert.equal(r.wa, r.wb, 'cap ' + p.cap + ' live ' + p.live + ' [' + i0 + ',' + i1 + '] B ' + B + ' return');
        if (!sameBytes(smallA, smallB)) assert.fail('cap ' + p.cap + ' live ' + p.live + ' [' + i0 + ',' + i1 + '] B ' + B + ' off ' + off + ': ' + firstDiff(smallA, smallB));
        edgeN++;
    }
    assert.equal(treeEdges, 6, 'n = B on cap 2 (tree path): off 0, off 3, -0 i0; live on and off');

    // B = 2^20 = MAX_BUCKETS edges on the big buffers (allocated once, reused).
    big();
    assert.equal(MAX_BUCKETS, BIG_B);
    let bigN = 0;
    for (const p of PAIRS) {
        if (p.cap !== 1024 && p.cap !== 2) continue;
        const last = p.a.count - 1;
        const rowsB = [
            [0, 0, BIG_B, 0], // n = 1 at i0 = 0
            [last, last, BIG_B, 0], // n = 1 at the newest (live when p.live) bar
            [-0, -0, BIG_B, -0], // n = 1, every index and off -0
            [0, last, BIG_B, 0], // whole series
            [0, last, BIG_B - 1, 3], // off = 3, tail slots past the last write checked untouched
        ];
        for (const [i0, i1, B, off] of rowsB) {
            const r = runPair(p, i0, i1, B, bigA, bigB, off);
            assert.equal(r.wa, r.wb, 'big cap ' + p.cap + ' [' + i0 + ',' + i1 + '] B ' + B + ' return');
            assert.equal(r.wa, i1 - i0 + 1);
            if (!sameBytes(bigA, bigB)) assert.fail('big cap ' + p.cap + ' live ' + p.live + ' [' + i0 + ',' + i1 + '] B ' + B + ' off ' + off + ': ' + firstDiff(bigA, bigB));
            bigN++;
        }
    }
    assert.equal(bigN, 20);
    assert.ok(edgeN + bigN > 100, 'edges: ' + (edgeN + bigN));
});

test('(b) live vs fast-path expectation (copyRangeInto rows + floor(mB/n)) for every n <= B case', () => {
    const bad = [];
    let checked = 0;
    for (const c of CASES) {
        if (!c.sparse) continue;
        const p = PAIRS[c.pi];
        smallA.fill(SENTINEL);
        smallB.fill(SENTINEL);
        const w = p.a.decimateInto(c.i0, c.i1, c.B, smallA, c.off);
        const n = expectInto(p.a, c.i0, c.i1, c.B, smallB, c.off, kFloor);
        checked++;
        if (w !== n || !sameBytes(smallA, smallB)) {
            if (bad.length < 5) bad.push('cap ' + p.cap + ' [' + c.i0 + ',' + c.i1 + '] B ' + c.B + ': w ' + w + '/' + n + ' ' + firstDiff(smallA, smallB));
            else bad.push('');
        }
    }
    assert.equal(checked, 1600);
    assert.equal(bad.length, 0, bad.length + ' mismatching cases: ' + bad.slice(0, 5).join(' | '));

    // n = 1 and the whole series at B = 2^20, -0 indices, on the big buffers.
    big();
    let bigN = 0;
    for (const p of PAIRS) {
        if (p.cap !== 1024 && p.cap !== 64) continue;
        const last = p.a.count - 1;
        for (const [i0, i1, B, off] of [[0, 0, BIG_B, 0], [last, last, BIG_B, 0], [-0, last, BIG_B, -0], [0, last, BIG_B - 1, 3]]) {
            bigA.fill(SENTINEL);
            bigB.fill(SENTINEL);
            const w = p.a.decimateInto(i0, i1, B, bigA, off);
            const n = expectInto(p.a, i0, i1, B, bigB, off, kFloor);
            assert.equal(w, n, 'big cap ' + p.cap + ' [' + i0 + ',' + i1 + '] return');
            if (!sameBytes(bigA, bigB)) assert.fail('big cap ' + p.cap + ' live ' + p.live + ' [' + i0 + ',' + i1 + '] B ' + B + ': ' + firstDiff(bigA, bigB));
            bigN++;
        }
    }
    assert.equal(bigN, 16);
});

test('(c) k = floor(mB/n) is exact vs BigInt at B = 2^20, n in {3, 2^20 - 1, 2^20, 2^22}', () => {
    const B = BIG_B;
    const bB = BigInt(B);
    let checked = 0;
    let bad = 0;
    let bucketBad = 0;
    const ceilDiv = (x, y) => (x + y - 1n) / y;
    for (const n of [3, BIG_B - 1, BIG_B, 4 * BIG_B]) {
        const bn = BigInt(n);
        const ms = [];
        for (let m = 0; m < n; m += 997) ms.push(m);
        for (let m = Math.max(0, n - 5000); m < n; m++) ms.push(m);
        for (let m = 0; m < Math.min(n, 5000); m++) ms.push(m);
        for (const m of ms) {
            const k = Math.floor((m * B) / n);
            const kb = (BigInt(m) * bB) / bn;
            if (BigInt(k) !== kb) bad++;
            // n <= B: bar m lies in bucket k = [ceil(kn/B), ceil((k+1)n/B) - 1] (scan geometry).
            if (n <= B) {
                const bm = BigInt(m);
                if (!(ceilDiv(kb * bn, bB) <= bm && bm < ceilDiv((kb + 1n) * bn, bB))) bucketBad++;
            }
            checked++;
        }
    }
    assert.ok(checked > 20000, 'checked ' + checked);
    assert.equal(bad, 0, 'k mismatches vs BigInt');
    assert.equal(bucketBad, 0, 'bars outside their bucket');
});

test('(d) must-fail controls: ceil mutant, -0 in a k slot, fixture sha256 pin', () => {
    // ceil(mB/n) mutant expectation vs live: must mismatch.
    let mism = 0;
    let checked = 0;
    for (const c of CASES) {
        if (!c.sparse) continue;
        const p = PAIRS[c.pi];
        smallA.fill(SENTINEL);
        smallB.fill(SENTINEL);
        p.a.decimateInto(c.i0, c.i1, c.B, smallA, c.off);
        expectInto(p.a, c.i0, c.i1, c.B, smallB, c.off, kCeil);
        checked++;
        if (!sameBytes(smallA, smallB)) mism++;
    }
    assert.equal(checked, 1600);
    assert.ok(mism >= 1, 'ceil mutant mismatches: ' + mism);

    // -0 written into one k slot (bucket 0, k = +0) of an exact copy: == misses it, the comparator must not.
    const p = PAIRS[PAIRS.length - 2]; // cap 1024, live
    smallA.fill(SENTINEL);
    const w = p.a.decimateInto(0, 9, 20, smallA, 3);
    assert.equal(w, 10);
    const copy = smallA.slice();
    assert.ok(sameBytes(smallA, copy), 'exact copy compares equal');
    assert.ok(Object.is(copy[3 + 6], 0), 'k slot of bucket 0 holds +0');
    copy[3 + 6] = -0;
    assert.ok(copy[3 + 6] === smallA[3 + 6], 'a == comparator would miss the -0');
    assert.equal(sameBytes(smallA, copy), false, 'bytewise comparator catches -0 in a k slot');
    assert.notEqual(firstDiff(smallA, copy), '');

    // Fixture pin: the file under test/fixtures is byte-for-byte v1.0.0.
    const src = readFileSync(new URL('./fixtures/Ohlc-v1.0.0.js', import.meta.url));
    assert.equal(createHash('sha256').update(src).digest('hex'), FIXTURE_SHA256);
    assert.notEqual(OhlcSeries, OhlcSeriesV100, 'fixture is a separate module');
    assert.ok(src.includes("export const VERSION = '1.0.0'"), 'fixture VERSION 1.0.0');
});
