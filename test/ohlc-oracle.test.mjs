// ohlc-oracle: bounds vs an independent oracle (PLAN-v2 A4, A7, A15).
// A4 mirrors the series with four @zakkster/lite-logn SegmentTrees (min low, max high, max vol, sum vol),
// driven by this file's OWN FIFO model (physical slots, base, closed count). A7 compares against a naive scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OhlcSeries } from '../Ohlc.js';
import { SegmentTree } from '@zakkster/lite-logn';

const INTERVAL = 60000;
const T0 = 1.7e12;
const T = (i) => T0 + i * 60000;

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

function finite6(out) {
    for (let k = 0; k < 6; k++) if (!Number.isFinite(out[k])) return false;
    return true;
}

// ------------------------------------------------------------------ A4
class Model {
    constructor(cap) {
        this.cap = cap;
        this.bars = [];      // logical order; each [t,o,h,l,c,v]
        this.base = 0;       // physical slot of logical 0
        this.C = 0;          // closed count
        this.live = false;
        this.tmin = new SegmentTree(cap, 'min');
        this.tmax = new SegmentTree(cap, 'max');
        this.tvol = new SegmentTree(cap, 'max');
        this.tsum = new SegmentTree(cap, 'sum');
        this.evictions = 0;
    }
    get count() { return this.bars.length; }
    phys(i) { return (this.base + i) % this.cap; }
    upd(i) { // push logical bar i into the four trees
        const p = this.phys(i), b = this.bars[i];
        this.tmin.update(p, b[3]);
        this.tmax.update(p, b[2]);
        this.tvol.update(p, b[5]);
        this.tsum.update(p, b[5]);
    }
    closeLive() { if (this.live) { this.upd(this.count - 1); this.live = false; this.C++; } }
    push(bar, asLive) {
        if (this.count === this.cap) { this.bars.shift(); this.base = (this.base + 1) % this.cap; this.C--; this.evictions++; }
        this.bars.push(bar);
        if (asLive) this.live = true; else { this.upd(this.count - 1); this.C++; }
    }
    appendBar(bar) {
        const n = this.count;
        if (n > 0 && bar[0] === this.bars[n - 1][0]) {
            if (this.live) { this.live = false; this.C++; }
            this.bars[n - 1] = bar;
            this.upd(n - 1);
            return;
        }
        this.closeLive();
        this.push(bar, false);
    }
    setLive(bar) {
        const n = this.count;
        if (n > 0 && bar[0] === this.bars[n - 1][0]) {
            this.reopened = !this.live;
            if (!this.live) { this.live = true; this.C--; }
            this.bars[n - 1] = bar;
            return;
        }
        this.closeLive();
        this.push(bar, true);
    }
    clear() { this.bars.length = 0; this.base = 0; this.C = 0; this.live = false; } // trees NOT reset
    // fold over CLOSED logical [a,b]; returns [min,max,maxVol,sum] and whether it wrapped
    tree(a, b) {
        const p0 = this.phys(a), p1 = this.phys(b);
        if (p0 <= p1) {
            return [this.tmin.query(p0, p1), this.tmax.query(p0, p1), this.tvol.query(p0, p1), this.tsum.query(p0, p1), false];
        }
        const cap1 = this.cap - 1;
        const mn1 = this.tmin.query(p0, cap1), mn2 = this.tmin.query(0, p1);
        const mx1 = this.tmax.query(p0, cap1), mx2 = this.tmax.query(0, p1);
        const mv1 = this.tvol.query(p0, cap1), mv2 = this.tvol.query(0, p1);
        const s1 = this.tsum.query(p0, cap1), s2 = this.tsum.query(0, p1);
        return [mn1 < mn2 ? mn1 : mn2, mx1 > mx2 ? mx1 : mx2, mv1 > mv2 ? mv1 : mv2, s1 + s2, true];
    }
    expect(i0, i1, stats) {
        const n = this.count;
        let mn = Infinity, mx = -Infinity, mv = -Infinity, sum = 0;
        const foldLive = this.live && i1 === n - 1;
        const hi = foldLive ? i1 - 1 : i1;
        if (i0 <= hi) {
            const r = this.tree(i0, hi);
            mn = r[0]; mx = r[1]; mv = r[2]; sum = r[3];
            if (r[4]) stats.wrap++;
        }
        if (foldLive) {
            const lv = this.bars[n - 1];
            if (lv[3] < mn) mn = lv[3];
            if (lv[2] > mx) mx = lv[2];
            if (lv[5] > mv) mv = lv[5];
            sum = sum + lv[5];
            stats.liveFold++;
            if (i0 === i1) stats.liveOnly++;
            if (i0 < i1) stats.liveMixed++;
        }
        return [mn, mx, mv, this.bars[i0][1], this.bars[i1][4], sum, i0, i1, i1 - i0 + 1];
    }
}

function genBar(rv, t) { // valid candle: l <= o,c <= h, fractional volume
    const l = 10 + rv() * 90;
    const h = l + rv() * 50;
    const cl = (x) => (x < l ? l : x > h ? h : x);
    const o = cl(l + (h - l) * rv());
    const c = cl(l + (h - l) * rv());
    // rng()*1e6 for half the bars; the rest span 1e-2..1e5 so partial sums mix binades and the
    // fold ORDER (l before r, s1 + s2 across the wrap) is visible in the low bits of the sum lane
    const v = rv() < 0.5 ? rv() * 1e6 : rv() * Math.pow(10, ((rv() * 8) | 0) - 2);
    return [t, o, h, l, c, v];
}

function runA4(cap, seed, nOps, pClear, stats) {
    const rop = mulberry32(seed ^ 0xA5A5A5A5);   // op stream
    const rv = mulberry32(seed + 0x1234567);     // value stream
    const s = new OhlcSeries(cap, INTERVAL);
    const m = new Model(cap);
    const out = new Float64Array(9);
    const all = new Float64Array(6 * cap);
    let version = 0, tNext = T(0);
    for (let op = 0; op < nOps; op++) {
        const r = rop(), r2 = rop(), gap = 1 + ((rop() * 3) | 0);
        let kind;
        if (r < pClear) kind = 'clear';
        else if (m.count === 0) kind = r2 < 0.5 ? 'appendNew' : 'liveNew';
        else kind = r2 < 0.30 ? 'appendNew' : r2 < 0.42 ? 'appendSame' : r2 < 0.70 ? 'liveNew' : 'liveSame';
        const last = m.count > 0 ? m.bars[m.count - 1][0] : tNext;
        if (kind === 'clear') {
            s.clear(); m.clear(); stats.clears++;
            tNext = T((rop() * 40) | 0);
        } else if (kind === 'appendNew') {
            const t = m.count > 0 ? last + gap * 60000 : tNext;
            const b = genBar(rv, t);
            s.appendBar(...b); m.appendBar(b);
        } else if (kind === 'appendSame') {
            const b = genBar(rv, last);
            s.appendBar(...b); m.appendBar(b); stats.appendSame++;
        } else if (kind === 'liveNew') {
            const t = m.count > 0 ? last + gap * 60000 : tNext;
            const b = genBar(rv, t);
            s.setLive(...b); m.setLive(b);
        } else {
            const b = genBar(rv, last);
            m.setLive(b); // sets m.reopened
            if (m.reopened) stats.reopen++;
            s.setLive(...b);
        }
        version++;
        const n = m.count;
        assert.equal(s.count, n, 'count after op ' + op + ' ' + kind);
        assert.equal(s.hasLive, m.live, 'hasLive after op ' + op + ' ' + kind);
        assert.equal(s.version, version, 'version after op ' + op);
        if (n > 0) {
            assert.equal(s.oldestTime, m.bars[0][0]);
            assert.equal(s.latestTime, m.bars[n - 1][0]);
            assert.equal(s.copyRangeInto(0, n - 1, all, 0), n);
            for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) {
                if (!Object.is(all[6 * i + k], m.bars[i][k])) assert.fail('copy mismatch bar ' + i + ' lane ' + k + ' after op ' + op + ' ' + kind);
            }
        }
        for (let i0 = 0; i0 < n; i0++) for (let i1 = i0; i1 < n; i1++) {
            const exp = m.expect(i0, i1, stats);
            out.fill(-3);
            const ret = s.boundsInto(i0, i1, out, 0);
            stats.queries++;
            if (ret !== i1 - i0 + 1) assert.fail('ret ' + ret + ' for (' + i0 + ',' + i1 + ') after op ' + op + ' ' + kind);
            for (let k = 0; k < 9; k++) {
                if (!Object.is(out[k], exp[k])) {
                    assert.fail('bounds(' + i0 + ',' + i1 + ') slot ' + k + ' got ' + out[k] + ' want ' + exp[k] +
                        ' after op ' + op + ' ' + kind + ' cap ' + cap + ' seed ' + seed + ' base ' + m.base + ' C ' + m.C + ' live ' + m.live);
                }
            }
            if (!finite6(out)) assert.fail('A15 non-finite lane in (' + i0 + ',' + i1 + ') after op ' + op);
            stats.finite++;
        }
        if (n > 0) { // out-of-range stays EMPTY after every op
            assert.equal(s.boundsInto(0, n, out, 0), 0);
        }
    }
    stats.evictions += m.evictions;
}

for (const [cap, pClear] of [[16, 0.02], [64, 0.005]]) {
    test('A4 bounds == lite-logn SegmentTree mirror, cap ' + cap + ' (300 ops x 3 seeds, all (i0,i1) after each op)', () => {
        const stats = { wrap: 0, liveFold: 0, liveOnly: 0, liveMixed: 0, reopen: 0, clears: 0, appendSame: 0, queries: 0, finite: 0, evictions: 0 };
        for (const seed of [0xC0FFEE, 0xBADC0DE, 0x5EED5]) runA4(cap, seed, 300, pClear, stats);
        // coverage floors (controls): the op mix must actually exercise every hazard
        assert.ok(stats.wrap > 0, 'wrap ranges exercised: ' + stats.wrap);
        assert.ok(stats.liveFold > 0, 'live folds exercised: ' + stats.liveFold);
        assert.ok(stats.liveOnly > 0, 'live-only ranges exercised: ' + stats.liveOnly);
        assert.ok(stats.liveMixed > 0, 'live+closed ranges exercised: ' + stats.liveMixed);
        assert.ok(stats.reopen > 0, 'reopens exercised: ' + stats.reopen);
        assert.ok(stats.clears > 0, 'clears exercised: ' + stats.clears);
        assert.ok(stats.appendSame > 0, 'same-time appends exercised: ' + stats.appendSame);
        assert.ok(stats.evictions > 0, 'evictions exercised: ' + stats.evictions);
        assert.ok(stats.queries > 1000, 'queries: ' + stats.queries);
        assert.equal(stats.finite, stats.queries, 'A15: every non-empty result had finite lanes 0..5');
        if (cap === 16) {
            assert.ok(stats.wrap >= 200 && stats.reopen >= 20, 'floors cap16 wrap ' + stats.wrap + ' reopen ' + stats.reopen);
        }
    });
}

test('A4 oracle self-check: SegmentTree mirror identities (sentinels, order, sum)', () => {
    const sm = new SegmentTree(4, 'sum'), mn = new SegmentTree(4, 'min'), mx = new SegmentTree(4, 'max');
    sm.update(0, 0.1); sm.update(1, 0.2); sm.update(2, 0.3); sm.update(3, 1e16);
    assert.ok(Object.is(sm.query(0, 3), (0.1 + 0.2) + (0.3 + 1e16)), 'pairwise node sum');
    // hand-walk of query(0,2): l=4,r=7 -> r odd folds leaf 2 (0.3); next level r=3 folds node 2 (0.1+0.2)
    assert.ok(Object.is(sm.query(0, 2), 0.3 + (0.1 + 0.2)), 'range sum order: right edge first');
    mn.update(2, 5); mx.update(2, 5);
    assert.equal(mn.query(2, 2), 5);
    assert.equal(mn.query(0, 1), Infinity, 'unwritten min leaf is +Inf');
    assert.equal(mx.query(0, 1), -Infinity, 'unwritten max leaf is -Inf');
});

// ------------------------------------------------------------------ A7
function a7Series(withLive) {
    const rng = mulberry32(0x7A7A7);
    const rv = mulberry32(0x0DDBA11);
    const s = new OhlcSeries(16, INTERVAL);
    const all = [];
    const total = 37;
    for (let i = 0; i < total; i++) {
        const l = 10 + ((rng() * 90) | 0);
        const h = l + 1 + ((rng() * 50) | 0);
        const o = l + (((h - l) * rng()) | 0);
        const c = l + (((h - l) * rng()) | 0);
        const v = (rv() * 1000) | 0;
        const b = [T(i), o, h, l, c, v];
        all.push(b);
        if (withLive && i === total - 1) s.setLive(...b); else s.appendBar(...b);
    }
    return { s, rows: all.slice(all.length - 16) };
}

for (const withLive of [false, true]) {
    test('A7 wrap bounds vs naive scan, cap 16, 37 bars (base 5)' + (withLive ? ', last bar live' : ''), () => {
        const { s, rows } = a7Series(withLive);
        assert.equal(s.count, 16);
        assert.equal(s.hasLive, withLive);
        assert.equal(s.oldestTime, rows[0][0]);
        const out = new Float64Array(9);
        let pairs = 0, wrapPairs = 0;
        for (let i0 = 0; i0 < 16; i0++) for (let i1 = i0; i1 < 16; i1++) {
            let mn = Infinity, mx = -Infinity, mv = -Infinity, sum = 0;
            for (let i = i0; i <= i1; i++) {
                if (rows[i][3] < mn) mn = rows[i][3];
                if (rows[i][2] > mx) mx = rows[i][2];
                if (rows[i][5] > mv) mv = rows[i][5];
                sum += rows[i][5];
            }
            const exp = [mn, mx, mv, rows[i0][1], rows[i1][4], sum, i0, i1, i1 - i0 + 1];
            out.fill(-3);
            assert.equal(s.boundsInto(i0, i1, out, 0), i1 - i0 + 1);
            for (let k = 0; k < 9; k++) {
                if (!Object.is(out[k], exp[k])) assert.fail('(' + i0 + ',' + i1 + ') slot ' + k + ' got ' + out[k] + ' want ' + exp[k]);
            }
            assert.ok(finite6(out), 'A15 finite (' + i0 + ',' + i1 + ')');
            pairs++;
            if (((5 + i0) & 15) > ((5 + i1) & 15)) wrapPairs++; // physical p0 > p1 (base 5)
        }
        assert.equal(pairs, 136);
        assert.ok(wrapPairs > 40, 'wrap pairs exercised: ' + wrapPairs); // logical i0 <= 10 < i1 -> 11 * 5 = 55 minus nothing
    });
}

test('A7 wrap-seam extremes: each side of the seam owns a unique extreme', () => {
    // cap 4, 6 closed bars -> base 2; logical 0,1 -> phys 2,3 ; logical 2,3 -> phys 0,1.
    const s = new OhlcSeries(4, INTERVAL);
    const rows = [
        [T(0), 10, 11, 9, 10, 1], [T(1), 10, 11, 9, 10, 1],
        [T(2), 50, 60, 40, 55, 7],   // phys 2
        [T(3), 40, 90, 30, 35, 3],   // phys 3
        [T(4), 20, 30, 5, 25, 9],    // phys 0: lowest low, highest volume
        [T(5), 20, 30, 15, 25, 2],   // phys 1
    ];
    for (const r of rows) s.appendBar(...r);
    const win = rows.slice(2); // logical 0..3 = t2..t5
    const out = new Float64Array(9);
    for (let i0 = 0; i0 < 4; i0++) for (let i1 = i0; i1 < 4; i1++) {
        let mn = Infinity, mx = -Infinity, mv = -Infinity, sum = 0;
        for (let i = i0; i <= i1; i++) { mn = Math.min(mn, win[i][3]); mx = Math.max(mx, win[i][2]); mv = Math.max(mv, win[i][5]); sum += win[i][5]; }
        s.boundsInto(i0, i1, out, 0);
        const exp = [mn, mx, mv, win[i0][1], win[i1][4], sum, i0, i1, i1 - i0 + 1];
        for (let k = 0; k < 9; k++) assert.ok(Object.is(out[k], exp[k]), '(' + i0 + ',' + i1 + ') slot ' + k + ' got ' + out[k] + ' want ' + exp[k]);
    }
});
