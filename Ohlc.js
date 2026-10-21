/**
 * Ohlc.js -- @zakkster/lite-ohlc
 * Zero-allocation OHLCV candle store for live charts: a power-of-two ring of six Float64
 * columns, a fused 4-lane segment tree (min low, max high, max volume, sum volume) over the
 * CLOSED bars, and an O(1) live (forming) bar outside the tree.
 *
 * Hot path: one fused tree walk per closed bar, an O(1) live-bar write, iterative fused
 * queries that leave their results in a Float64 scratch, binary searches. Every numeric hot
 * return value is a SMI (writes return this). Cold path: ctor validation, every throw
 * (module-level fail*() helpers), the scalar wrappers and the oldestTime / latestTime /
 * interval getters (a wrapper boxes each fractional or large argument; a getter boxes its
 * result once).
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */

export const VERSION = '1.0.0';
export const CANDLE_STRIDE = 6;
export const BOUNDS_STRIDE = 9;
export const BUCKET_STRIDE = 7;
export const MIN_CAPACITY = 2;
export const MAX_CAPACITY = 4194304; // 2^22
export const MAX_BUCKETS = 1048576; // 2^20

// Int32 state slots (instance field `_s`).
const S_BASE = 0; // physical slot of logical bar 0
const S_CLOSED = 1; // closed bars C (in the tree)
const S_LIVE = 2; // 1 when bar C is the live bar
const S_VER = 3; // version, wraps at 2^30
const S_H = 4; // log2(capacity)

// Float64 scratch slots (instance field `_f`).
const F_MAXVOL = 0; // Number.MAX_VALUE / (4 * capacity)
const F_STG = 1; // 1..6 staging for the scalar wrappers
const F_Q = 7; // 7..10 query result [minLow, maxHigh, maxVol, sumVol]
const F_W = 11; // 11..14 first wrap segment, saved across the second _q
const F_INT = 15; // interval
const F_LEN = 16;

const VER_MASK = 0x3FFFFFFF;

// --- Cold throw helpers (keep throw bytes out of the hot bodies) -------------

function failCapType() { throw new TypeError('[lite-ohlc] capacity must be a number'); }
function failCapRange() {
    throw new RangeError('[lite-ohlc] capacity must be an integer power of two in [' +
        MIN_CAPACITY + ', ' + MAX_CAPACITY + ']');
}
function failIntType() { throw new TypeError('[lite-ohlc] interval must be a number'); }
function failIntRange() { throw new RangeError('[lite-ohlc] interval must be finite and > 0'); }
function failBuf() { throw new TypeError('[lite-ohlc] buf must be a Float64Array'); }
function failOut() { throw new TypeError('[lite-ohlc] out must be a Float64Array'); }
function failOff() { throw new RangeError('[lite-ohlc] offset out of bounds'); }
function failOutShort() { throw new RangeError('[lite-ohlc] out too small for the requested range'); }
function failArgs() { throw new TypeError('[lite-ohlc] candle values must be numbers (all six required)'); }
function failCandle() {
    throw new RangeError('[lite-ohlc] invalid candle: need finite values, l <= o <= h, ' +
        'l <= c <= h, 0 <= v <= MAX_VALUE / (4 * capacity)');
}
function failOrder() { throw new RangeError('[lite-ohlc] time is earlier than the last bar'); }
function failBuckets() {
    throw new RangeError('[lite-ohlc] B must be an integer in [1, ' + MAX_BUCKETS + ']');
}

export class OhlcSeries {
    /**
     * @param {number} capacity  integer power of two in [MIN_CAPACITY, MAX_CAPACITY]
     * @param {number} interval  bar interval (metadata), finite and > 0
     */
    constructor(capacity, interval) {
        if (typeof capacity !== 'number') failCapType();
        if ((capacity | 0) !== capacity || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY ||
            (capacity & (capacity - 1)) !== 0) failCapRange();
        if (typeof interval !== 'number') failIntType();
        if (!(interval > 0 && interval < Infinity)) failIntRange();

        const cap = capacity;
        this._cap = cap;
        this._mask = cap - 1;
        this._t = new Float64Array(cap);
        this._o = new Float64Array(cap);
        this._h = new Float64Array(cap);
        this._l = new Float64Array(cap);
        this._c = new Float64Array(cap);
        this._v = new Float64Array(cap);
        // Node j lanes at 4j..4j+3 = [minLow, maxHigh, maxVol, sumVol]; leaf of phys p = cap + p.
        const tree = new Float64Array(8 * cap);
        for (let k = 0; k < tree.length; k += 4) {
            tree[k] = Infinity;
            tree[k + 1] = -Infinity;
            tree[k + 2] = -Infinity;
            tree[k + 3] = 0;
        }
        this._tree = tree;
        const s = new Int32Array(5);
        s[S_H] = 31 - Math.clz32(cap);
        this._s = s;
        const f = new Float64Array(F_LEN);
        f[F_MAXVOL] = Number.MAX_VALUE / (4 * cap);
        f[F_INT] = interval;
        this._f = f;
    }

    // --- Getters ------------------------------------------------------------

    /** Bumped on every successful write or clear; wraps at 2^30. SMI. */
    get version() { return this._s[S_VER]; }
    /** Bar interval (metadata). Cold: boxes a double. */
    get interval() { return this._f[F_INT]; }
    get capacity() { return this._cap; }
    /** Closed bars plus the live bar. SMI. */
    get count() { const s = this._s; return s[S_CLOSED] + s[S_LIVE]; }
    get hasLive() { return this._s[S_LIVE] === 1; }
    /** Time of logical bar 0, NaN when empty. Cold: boxes a double. */
    get oldestTime() {
        const s = this._s;
        if (s[S_CLOSED] + s[S_LIVE] === 0) return NaN;
        return this._t[s[S_BASE]];
    }
    /** Time of logical bar count-1, NaN when empty. Cold: boxes a double. */
    get latestTime() {
        const s = this._s;
        const n = s[S_CLOSED] + s[S_LIVE];
        if (n === 0) return NaN;
        return this._t[(s[S_BASE] + n - 1) & this._mask];
    }

    // --- Tree (internal) ----------------------------------------------------

    /** Leaf of phys p = (l, h, v, v) from the columns, then one fused walk to the root. */
    _write(p) {
        const tr = this._tree;
        const leaf = (this._cap + p) << 2;
        const v = this._v[p];
        tr[leaf] = this._l[p];
        tr[leaf + 1] = this._h[p];
        tr[leaf + 2] = v;
        tr[leaf + 3] = v;
        for (let j = (this._cap + p) >> 1; j >= 1; j >>= 1) {
            const a = j << 3; // left child 2j at 8j, right child 2j+1 at 8j+4
            const d = j << 2;
            let x = tr[a];
            let y = tr[a + 4];
            tr[d] = x < y ? x : y;
            x = tr[a + 1];
            y = tr[a + 5];
            tr[d + 1] = x > y ? x : y;
            x = tr[a + 2];
            y = tr[a + 6];
            tr[d + 2] = x > y ? x : y;
            tr[d + 3] = tr[a + 3] + tr[a + 7];
        }
    }

    /** Fold phys [p0, p1] (p0 <= p1) into _f[F_Q..F_Q+3]. lite-logn SegmentTree.query order. */
    _q(p0, p1) {
        const tr = this._tree;
        let l = this._cap + p0;
        let r = this._cap + p1 + 1;
        let mn = Infinity;
        let mx = -Infinity;
        let mv = -Infinity;
        let sm = 0;
        for (; l < r; l >>= 1, r >>= 1) {
            if (l & 1) {
                const k = l << 2;
                let x = tr[k]; if (x < mn) mn = x;
                x = tr[k + 1]; if (x > mx) mx = x;
                x = tr[k + 2]; if (x > mv) mv = x;
                sm += tr[k + 3];
                l++;
            }
            if (r & 1) {
                const k = (--r) << 2;
                let x = tr[k]; if (x < mn) mn = x;
                x = tr[k + 1]; if (x > mx) mx = x;
                x = tr[k + 2]; if (x > mv) mv = x;
                sm += tr[k + 3];
            }
        }
        const f = this._f;
        f[F_Q] = mn;
        f[F_Q + 1] = mx;
        f[F_Q + 2] = mv;
        f[F_Q + 3] = sm;
    }

    /** Fold the CLOSED logical range [a, b] into _f[F_Q..]. A wrap folds two segments, each from identity. */
    _rangeQ(a, b) {
        const base = this._s[S_BASE];
        const mask = this._mask;
        const p0 = (base + a) & mask;
        const p1 = (base + b) & mask;
        if (p0 <= p1) {
            this._q(p0, p1);
            return;
        }
        const f = this._f;
        this._q(p0, mask);
        f[F_W] = f[F_Q];
        f[F_W + 1] = f[F_Q + 1];
        f[F_W + 2] = f[F_Q + 2];
        f[F_W + 3] = f[F_Q + 3];
        this._q(0, p1);
        let x = f[F_W];
        let y = f[F_Q];
        f[F_Q] = x < y ? x : y;
        x = f[F_W + 1];
        y = f[F_Q + 1];
        f[F_Q + 1] = x > y ? x : y;
        x = f[F_W + 2];
        y = f[F_Q + 2];
        f[F_Q + 2] = x > y ? x : y;
        f[F_Q + 3] = f[F_W + 3] + f[F_Q + 3];
    }

    // --- Writes -------------------------------------------------------------

    /**
     * Append a closed bar [t,o,h,l,c,v] from buf[off..off+5]. Equal time to the last bar
     * replaces it as CLOSED; a later time closes any live bar, then pushes (evicting the oldest
     * when full); an earlier time throws. A throw changes nothing.
     */
    appendBarFrom(buf, off = 0) {
        if (!(buf instanceof Float64Array)) failBuf();
        if ((off | 0) !== off || off < 0 || off + 6 > buf.length) failOff();
        const t = buf[off];
        const o = buf[off + 1];
        const h = buf[off + 2];
        const l = buf[off + 3];
        const c = buf[off + 4];
        const v = buf[off + 5];
        if ((t - t !== 0) || (o - o !== 0) || (h - h !== 0) || (l - l !== 0) || (c - c !== 0) ||
            (v - v !== 0) || !(h >= l) || !(o >= l) || !(o <= h) || !(c >= l) || !(c <= h) ||
            !(v >= 0) || !(v <= this._f[F_MAXVOL])) failCandle();
        const s = this._s;
        const mask = this._mask;
        let C = s[S_CLOSED];
        const L = s[S_LIVE];
        let p = 0;
        let same = false;
        if (C + L > 0) {
            p = (s[S_BASE] + C + L - 1) & mask;
            const T = this._t[p];
            if (t < T) failOrder();
            same = t === T;
        }
        if (same) {
            C += L; // a live bar becomes closed; a closed bar stays closed
        } else {
            if (L === 1) {
                this._write((s[S_BASE] + C) & mask); // close the live bar as-is
                C++;
            }
            if (C === this._cap) {
                s[S_BASE] = (s[S_BASE] + 1) & mask;
                C--;
            }
            p = (s[S_BASE] + C) & mask;
            C++;
        }
        this._t[p] = t + 0;
        this._o[p] = o + 0;
        this._h[p] = h + 0;
        this._l[p] = l + 0;
        this._c[p] = c + 0;
        this._v[p] = v + 0;
        this._write(p);
        s[S_CLOSED] = C;
        s[S_LIVE] = 0;
        s[S_VER] = (s[S_VER] + 1) & VER_MASK;
        return this;
    }

    /**
     * Set the live bar [t,o,h,l,c,v] from buf[off..off+5]. O(1) for the new bar. Equal time
     * overwrites the last bar (a closed last bar REOPENS as live); a later time closes any live
     * bar, then pushes the new live bar (evicting the oldest when full); an earlier time throws.
     */
    setLiveFrom(buf, off = 0) {
        if (!(buf instanceof Float64Array)) failBuf();
        if ((off | 0) !== off || off < 0 || off + 6 > buf.length) failOff();
        const t = buf[off];
        const o = buf[off + 1];
        const h = buf[off + 2];
        const l = buf[off + 3];
        const c = buf[off + 4];
        const v = buf[off + 5];
        if ((t - t !== 0) || (o - o !== 0) || (h - h !== 0) || (l - l !== 0) || (c - c !== 0) ||
            (v - v !== 0) || !(h >= l) || !(o >= l) || !(o <= h) || !(c >= l) || !(c <= h) ||
            !(v >= 0) || !(v <= this._f[F_MAXVOL])) failCandle();
        const s = this._s;
        const mask = this._mask;
        let C = s[S_CLOSED];
        const L = s[S_LIVE];
        let p = 0;
        let same = false;
        if (C + L > 0) {
            p = (s[S_BASE] + C + L - 1) & mask;
            const T = this._t[p];
            if (t < T) failOrder();
            same = t === T;
        }
        if (same) {
            C += L - 1; // a closed last bar reopens (C--); a live one stays live
        } else {
            if (L === 1) {
                this._write((s[S_BASE] + C) & mask); // close the live bar as-is
                C++;
            }
            if (C === this._cap) {
                s[S_BASE] = (s[S_BASE] + 1) & mask;
                C--;
            }
            p = (s[S_BASE] + C) & mask;
        }
        this._t[p] = t + 0;
        this._o[p] = o + 0;
        this._h[p] = h + 0;
        this._l[p] = l + 0;
        this._c[p] = c + 0;
        this._v[p] = v + 0;
        s[S_CLOSED] = C;
        s[S_LIVE] = 1;
        s[S_VER] = (s[S_VER] + 1) & VER_MASK;
        return this;
    }

    /**
     * Scalar wrapper of appendBarFrom (cold: boxes fractional or large args).
     * All six required.
     */
    appendBar(t, o, h, l, c, v) {
        if (typeof t !== 'number' || typeof o !== 'number' || typeof h !== 'number' ||
            typeof l !== 'number' || typeof c !== 'number' || typeof v !== 'number') failArgs();
        const f = this._f;
        f[F_STG] = t;
        f[F_STG + 1] = o;
        f[F_STG + 2] = h;
        f[F_STG + 3] = l;
        f[F_STG + 4] = c;
        f[F_STG + 5] = v;
        return this.appendBarFrom(f, F_STG);
    }

    /**
     * Scalar wrapper of setLiveFrom (cold: boxes fractional or large args).
     * All six required.
     */
    setLive(t, o, h, l, c, v) {
        if (typeof t !== 'number' || typeof o !== 'number' || typeof h !== 'number' ||
            typeof l !== 'number' || typeof c !== 'number' || typeof v !== 'number') failArgs();
        const f = this._f;
        f[F_STG] = t;
        f[F_STG + 1] = o;
        f[F_STG + 2] = h;
        f[F_STG + 3] = l;
        f[F_STG + 4] = c;
        f[F_STG + 5] = v;
        return this.setLiveFrom(f, F_STG);
    }

    /** O(1): forget every bar. The tree is not reset; its stale leaves are unreachable. */
    clear() {
        const s = this._s;
        s[S_BASE] = 0;
        s[S_CLOSED] = 0;
        s[S_LIVE] = 0;
        s[S_VER] = (s[S_VER] + 1) & VER_MASK;
        return this;
    }

    // --- Searches -----------------------------------------------------------

    /** First logical index with time >= buf[off], or -1 (empty, non-finite, none). */
    lowerBoundFrom(buf, off = 0) {
        if (!(buf instanceof Float64Array)) failBuf();
        if ((off | 0) !== off || off < 0 || off >= buf.length) failOff();
        const s = this._s;
        const n = s[S_CLOSED] + s[S_LIVE];
        const x = buf[off];
        if (n === 0 || (x - x !== 0)) return -1;
        const tc = this._t;
        const mask = this._mask;
        const base = s[S_BASE];
        const last = n - 1;
        if (x <= tc[base]) return 0;
        if (x > tc[(base + last) & mask]) return -1;
        let lo = 0;
        let hi = last;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (tc[(base + mid) & mask] < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /** LAST logical index with time <= buf[off], or -1 (empty, non-finite, none). */
    upperBoundFrom(buf, off = 0) {
        if (!(buf instanceof Float64Array)) failBuf();
        if ((off | 0) !== off || off < 0 || off >= buf.length) failOff();
        const s = this._s;
        const n = s[S_CLOSED] + s[S_LIVE];
        const x = buf[off];
        if (n === 0 || (x - x !== 0)) return -1;
        const tc = this._t;
        const mask = this._mask;
        const base = s[S_BASE];
        // `last` is computed on the common path: a binary op only on the rare early-return
        // branch has no type feedback when the optimizer runs and soft-deopts later.
        const last = n - 1;
        if (x < tc[base]) return -1;
        if (x >= tc[(base + last) & mask]) return last;
        let lo = 0;
        let hi = last;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (tc[(base + mid) & mask] <= x) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /**
     * First logical index with time >= x, or -1 (empty, non-finite, none). Scalar wrapper over
     * lowerBoundFrom (stages x in the Float64 scratch). Returns -1 when x is not a finite
     * number: typeof x !== 'number', or NaN / +/-Infinity (exactly what `x - x !== 0`
     * rejects).
     */
    lowerBound(x) {
        if (typeof x !== 'number' || (x - x !== 0)) return -1;
        this._f[F_STG] = x;
        return this.lowerBoundFrom(this._f, F_STG);
    }

    /**
     * LAST logical index with time <= x, or -1 (empty, non-finite, none). Scalar wrapper over
     * upperBoundFrom (stages x in the Float64 scratch). Returns -1 when x is not a finite
     * number: typeof x !== 'number', or NaN / +/-Infinity (exactly what `x - x !== 0`
     * rejects).
     */
    upperBound(x) {
        if (typeof x !== 'number' || (x - x !== 0)) return -1;
        this._f[F_STG] = x;
        return this.upperBoundFrom(this._f, F_STG);
    }

    // --- Range queries ------------------------------------------------------

    /**
     * Write [minLow, maxHigh, maxVol, open(i0), close(i1), sumVol, i0, i1, n] for the logical
     * range [i0, i1] and return n. Any invalid range writes [NaN x5, 0, -1, -1, 0] and returns 0.
     */
    boundsInto(i0, i1, out, off = 0) {
        if (!(out instanceof Float64Array)) failOut();
        if ((off | 0) !== off || off < 0 || off + 9 > out.length) failOff();
        const s = this._s;
        const C = s[S_CLOSED];
        if ((i0 | 0) !== i0 || (i1 | 0) !== i1 || i0 < 0 || i0 > i1 || i1 >= C + s[S_LIVE]) {
            out[off] = NaN;
            out[off + 1] = NaN;
            out[off + 2] = NaN;
            out[off + 3] = NaN;
            out[off + 4] = NaN;
            out[off + 5] = 0;
            out[off + 6] = -1;
            out[off + 7] = -1;
            out[off + 8] = 0;
            return 0;
        }
        const f = this._f;
        // The tree covers closed bars only: i1 == C is the live bar, folded in O(1) below.
        const te = i1 === C ? i1 - 1 : i1;
        if (te >= i0) {
            this._rangeQ(i0, te);
        } else {
            f[F_Q] = Infinity;
            f[F_Q + 1] = -Infinity;
            f[F_Q + 2] = -Infinity;
            f[F_Q + 3] = 0;
        }
        const base = s[S_BASE];
        const mask = this._mask;
        if (te !== i1) {
            const pl = (base + i1) & mask;
            let x = this._l[pl];
            if (x < f[F_Q]) f[F_Q] = x;
            x = this._h[pl];
            if (x > f[F_Q + 1]) f[F_Q + 1] = x;
            x = this._v[pl];
            if (x > f[F_Q + 2]) f[F_Q + 2] = x;
            f[F_Q + 3] = f[F_Q + 3] + x;
        }
        out[off] = f[F_Q];
        out[off + 1] = f[F_Q + 1];
        out[off + 2] = f[F_Q + 2];
        out[off + 3] = this._o[(base + i0) & mask];
        out[off + 4] = this._c[(base + i1) & mask];
        out[off + 5] = f[F_Q + 3];
        out[off + 6] = i0 + 0; // i0 = -0 passes the integer test; write +0
        out[off + 7] = i1 + 0;
        out[off + 8] = i1 - i0 + 1;
        return i1 - i0 + 1;
    }

    /**
     * Copy bars [i0, i1] as [t,o,h,l,c,v] per bar, oldest first, into out at off; return n.
     * Invalid range: return 0, write nothing. Valid but out too short: RangeError, no write.
     */
    copyRangeInto(i0, i1, out, off = 0) {
        if (!(out instanceof Float64Array)) failOut();
        if ((off | 0) !== off || off < 0) failOff();
        const s = this._s;
        if ((i0 | 0) !== i0 || (i1 | 0) !== i1 || i0 < 0 || i0 > i1 ||
            i1 >= s[S_CLOSED] + s[S_LIVE]) return 0;
        const n = i1 - i0 + 1;
        if (off + 6 * n > out.length) failOutShort();
        const base = s[S_BASE];
        const mask = this._mask;
        const tc = this._t;
        const oc = this._o;
        const hc = this._h;
        const lc = this._l;
        const cc = this._c;
        const vc = this._v;
        let d = off;
        for (let i = i0 | 0; i <= i1; i++) {
            const p = (base + i) & mask;
            out[d] = tc[p];
            out[d + 1] = oc[p];
            out[d + 2] = hc[p];
            out[d + 3] = lc[p];
            out[d + 4] = cc[p];
            out[d + 5] = vc[p];
            d += 6;
        }
        return n;
    }

    /**
     * Decimate the logical range [i0, i1] into at most B buckets. n = i1 - i0 + 1; bucket k
     * covers [i0 + ceil(k*n/B), i0 + ceil((k+1)*n/B) - 1]. Each non-empty bucket, ascending k,
     * writes [t_first, o_first, max h, min l, c_last, sum v, k] (BUCKET_STRIDE = 7); empty
     * buckets (only when n < B) write nothing. Returns the number written (= min(n, B)); slots
     * past off + 7 * written are untouched. B outside [1, MAX_BUCKETS] or off + 7 * B > length
     * throws RangeError, even for an invalid range. An invalid range returns 0, writes nothing.
     * Path: n < B * log2(capacity) -> linear scan (v summed sequentially), else one fused tree
     * query per bucket (v == boundsInto(s_k, e_k)[5]). t, o, h, l, c, k are byte-identical
     * across paths; v is byte-identical for integer volumes whose sums stay below 2^53.
     */
    decimateInto(i0, i1, B, out, off = 0) {
        if (!(out instanceof Float64Array)) failOut();
        if ((off | 0) !== off || off < 0) failOff();
        if ((B | 0) !== B || B < 1 || B > MAX_BUCKETS) failBuckets();
        if (off + 7 * B > out.length) failOutShort();
        const s = this._s;
        if ((i0 | 0) !== i0 || (i1 | 0) !== i1 || i0 < 0 || i0 > i1 ||
            i1 >= s[S_CLOSED] + s[S_LIVE]) return 0;
        // `| 0` keeps a -0 index out of the internal calls (SMI args only).
        if (i1 - i0 + 1 < B * s[S_H]) return this._decimateScan(i0 | 0, i1 | 0, B, out, off);
        return this._decimateTree(i0 | 0, i1 | 0, B, out, off);
    }

    /** Linear-scan decimation over validated args. Bars fold in logical order; v summed sequentially. */
    _decimateScan(i0, i1, B, out, off) {
        if (i1 - i0 < B) return this._decimateSparse(i0, i1, B, out, off);
        const s = this._s;
        const base = s[S_BASE];
        const mask = this._mask;
        const tc = this._t;
        const oc = this._o;
        const hc = this._h;
        const lc = this._l;
        const cc = this._c;
        const vc = this._v;
        const n = i1 - i0 + 1;
        let a = i0; // first bar of bucket k
        let d = off;
        let w = 0;
        for (let k = 0; k < B; k++) {
            const e = i0 + (Math.floor(((k + 1) * n + B - 1) / B) | 0) - 1; // last bar of bucket k
            if (e >= a) {
                let p = (base + a) & mask;
                let mx = hc[p];
                let mn = lc[p];
                let sm = vc[p]; // canonical +0 or positive: the sum never reads -0
                out[d] = tc[p];
                out[d + 1] = oc[p];
                for (let i = a + 1; i <= e; i++) {
                    p = (base + i) & mask;
                    let x = hc[p]; if (x > mx) mx = x;
                    x = lc[p]; if (x < mn) mn = x;
                    sm += vc[p];
                }
                out[d + 2] = mx;
                out[d + 3] = mn;
                out[d + 4] = cc[p];
                out[d + 5] = sm;
                out[d + 6] = k + 0;
                d += 7;
                w++;
            }
            a = e + 1;
        }
        return w;
    }

    /** Fast path for n <= B over validated args: O(n), one bar per bucket, k = floor(m * B / n). */
    _decimateSparse(i0, i1, B, out, off) {
        const s = this._s;
        const base = s[S_BASE];
        const mask = this._mask;
        const tc = this._t;
        const oc = this._o;
        const hc = this._h;
        const lc = this._l;
        const cc = this._c;
        const vc = this._v;
        const n = i1 - i0 + 1;
        let d = off;
        for (let m = 0; m < n; m++) {
            const p = (base + i0 + m) & mask;
            out[d] = tc[p];
            out[d + 1] = oc[p];
            out[d + 2] = hc[p];
            out[d + 3] = lc[p];
            out[d + 4] = cc[p];
            out[d + 5] = vc[p];
            out[d + 6] = Math.floor((m * B) / n) | 0; // m * B < 2^40: exact; | 0 never yields -0
            d += 7;
        }
        return n;
    }

    /**
     * Tree decimation over validated args: per bucket, one _rangeQ over its closed part plus the
     * O(1) live-bar fold -- the exact boundsInto fold, so v == boundsInto(s_k, e_k)[5].
     */
    _decimateTree(i0, i1, B, out, off) {
        const s = this._s;
        const C = s[S_CLOSED];
        const base = s[S_BASE];
        const mask = this._mask;
        const f = this._f;
        const n = i1 - i0 + 1;
        let a = i0; // first bar of bucket k
        let d = off;
        let w = 0;
        for (let k = 0; k < B; k++) {
            const e = i0 + (Math.floor(((k + 1) * n + B - 1) / B) | 0) - 1; // last bar of bucket k
            if (e >= a) {
                // The tree covers closed bars only: e == C is the live bar, folded below. A
                // bucket holding only the live bar skips the tree (no sentinel reaches out).
                const te = e === C ? e - 1 : e;
                if (te >= a) {
                    this._rangeQ(a, te);
                } else {
                    f[F_Q] = Infinity;
                    f[F_Q + 1] = -Infinity;
                    f[F_Q + 2] = -Infinity;
                    f[F_Q + 3] = 0;
                }
                if (te !== e) {
                    const pl = (base + e) & mask;
                    let x = this._l[pl];
                    if (x < f[F_Q]) f[F_Q] = x;
                    x = this._h[pl];
                    if (x > f[F_Q + 1]) f[F_Q + 1] = x;
                    f[F_Q + 3] = f[F_Q + 3] + this._v[pl];
                }
                const pa = (base + a) & mask;
                out[d] = this._t[pa];
                out[d + 1] = this._o[pa];
                out[d + 2] = f[F_Q + 1];
                out[d + 3] = f[F_Q];
                out[d + 4] = this._c[(base + e) & mask];
                out[d + 5] = f[F_Q + 3];
                out[d + 6] = k + 0;
                d += 7;
                w++;
            }
            a = e + 1;
        }
        return w;
    }
}
