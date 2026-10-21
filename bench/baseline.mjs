// bench/baseline.mjs -- hand-rolled baselines for bench/ohlc-vs-baseline.mjs (REPORTED tier).
// Best honest form: an array of plain {t,o,h,l,c,v} objects (one shape), plain for-loops, no
// validation (favours the baseline). Every function writes the same slots as its Ohlc.js
// counterpart so the bench cross-checks them bitwise before any timing.
//
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

function failOrder() { throw new RangeError('[bench] time is earlier than the last bar'); }

/** The one bar shape. Integer t / v stay SMI fields; o / h / l / c are Double fields. */
function newBar(t, o, h, l, c, v) {
    return { t, o, h, l, c, v };
}

// Prime the shape with fractional prices so an integral price (100.00) never lands first and
// forces a later Smi -> Double field generalization (a deprecated map would slow the baseline).
newBar(0, 0.5, 0.5, 0.5, 0.5, 0);

/** n bars from buf (stride 6: t,o,h,l,c,v) as one PACKED array of one-shape objects. */
export function makeBars(buf, n) {
    const bars = [];
    for (let i = 0; i < n; i++) {
        const k = i * 6;
        bars.push(newBar(buf[k], buf[k + 1], buf[k + 2], buf[k + 3], buf[k + 4], buf[k + 5]));
    }
    return bars;
}

/**
 * boundsInto twin: [minLow, maxHigh, maxVol, open(i0), close(i1), sumVol, i0, i1, n], returns n.
 * Valid ranges only (the bench never passes an invalid one). Plain loop, not reduce.
 */
export function baseBoundsInto(bars, i0, i1, out, off) {
    let b = bars[i0];
    const o = b.o;
    let mn = b.l;
    let mx = b.h;
    let mv = b.v;
    let sv = b.v;
    for (let i = i0 + 1; i <= i1; i++) {
        b = bars[i];
        const l = b.l; if (l < mn) mn = l;
        const h = b.h; if (h > mx) mx = h;
        const v = b.v; if (v > mv) mv = v;
        sv += v;
    }
    out[off] = mn;
    out[off + 1] = mx;
    out[off + 2] = mv;
    out[off + 3] = o;
    out[off + 4] = b.c;
    out[off + 5] = sv;
    out[off + 6] = i0;
    out[off + 7] = i1;
    out[off + 8] = i1 - i0 + 1;
    return i1 - i0 + 1;
}

/**
 * decimateInto twin, plain loop. Bucket k = [a, i0 + floor(((k+1)n + B - 1) / B) - 1]; an empty
 * bucket (only when n < B) writes nothing. Non-empty bucket writes [t_first, o_first, max h,
 * min l, c_last, sum v, k]. Returns the number of buckets written.
 */
export function baseDecimateInto(bars, i0, i1, B, out, off) {
    const n = i1 - i0 + 1;
    let a = i0;
    let d = off;
    let w = 0;
    for (let k = 0; k < B; k++) {
        const e = i0 + (Math.floor(((k + 1) * n + B - 1) / B) | 0) - 1;
        if (e >= a) {
            let b = bars[a];
            let mx = b.h;
            let mn = b.l;
            let sm = b.v;
            out[d] = b.t;
            out[d + 1] = b.o;
            for (let i = a + 1; i <= e; i++) {
                b = bars[i];
                const h = b.h; if (h > mx) mx = h;
                const l = b.l; if (l < mn) mn = l;
                sm += b.v;
            }
            out[d + 2] = mx;
            out[d + 3] = mn;
            out[d + 4] = b.c;
            out[d + 5] = sm;
            out[d + 6] = k;
            d += 7;
            w++;
        }
        a = e + 1;
    }
    return w;
}

/** decimateInto, idiomatic form: slice + reduce per bucket. Reported only (baseline 'idiomatic'). */
export function baseDecimateIdiomatic(bars, i0, i1, B, out, off) {
    const n = i1 - i0 + 1;
    let a = i0;
    let d = off;
    let w = 0;
    for (let k = 0; k < B; k++) {
        const e = i0 + Math.floor(((k + 1) * n + B - 1) / B) - 1;
        if (e >= a) {
            const seg = bars.slice(a, e + 1);
            out[d] = seg[0].t;
            out[d + 1] = seg[0].o;
            out[d + 2] = seg.reduce((m, b) => Math.max(m, b.h), -Infinity);
            out[d + 3] = seg.reduce((m, b) => Math.min(m, b.l), Infinity);
            out[d + 4] = seg[seg.length - 1].c;
            out[d + 5] = seg.reduce((s, b) => s + b.v, 0);
            out[d + 6] = k;
            d += 7;
            w++;
        }
        a = e + 1;
    }
    return w;
}

/**
 * Live-bar store, idiomatic form: equal time mutates the last bar in place; a later time pushes a
 * new literal and shift()s past capacity; an earlier time throws. No candle validation.
 */
export class PushShiftRing {
    constructor(capacity) {
        this.cap = capacity;
        this.bars = [];
    }

    get count() { return this.bars.length; }

    /** Logical bar i (0 = oldest). Cold. */
    at(i) { return this.bars[i]; }

    setLiveFrom(buf, off) {
        const bars = this.bars;
        const t = buf[off];
        const n = bars.length;
        if (n > 0) {
            const last = bars[n - 1];
            const T = last.t;
            if (t < T) failOrder();
            if (t === T) {
                last.o = buf[off + 1];
                last.h = buf[off + 2];
                last.l = buf[off + 3];
                last.c = buf[off + 4];
                last.v = buf[off + 5];
                return this;
            }
        }
        bars.push({ t, o: buf[off + 1], h: buf[off + 2], l: buf[off + 3], c: buf[off + 4], v: buf[off + 5] });
        if (bars.length > this.cap) bars.shift();
        return this;
    }
}

/**
 * Live-bar store, best form: C preallocated bars, a head index, a pow2 mask; a new bar past
 * capacity reuses the evicted (oldest) object in place. No allocation, no validation.
 */
export class IndexRing {
    constructor(capacity) {
        const bars = [];
        for (let i = 0; i < capacity; i++) bars.push(newBar(0, 0.5, 0.5, 0.5, 0.5, 0));
        this.bars = bars;
        this.cap = capacity;
        this.mask = capacity - 1;
        this.head = 0;
        this.n = 0;
    }

    get count() { return this.n; }

    /** Logical bar i (0 = oldest). Cold. */
    at(i) { return this.bars[(this.head + i) & this.mask]; }

    setLiveFrom(buf, off) {
        const bars = this.bars;
        const mask = this.mask;
        const t = buf[off];
        const n = this.n;
        let b;
        if (n > 0) {
            b = bars[(this.head + n - 1) & mask];
            const T = b.t;
            if (t < T) failOrder();
            if (t === T) {
                b.o = buf[off + 1];
                b.h = buf[off + 2];
                b.l = buf[off + 3];
                b.c = buf[off + 4];
                b.v = buf[off + 5];
                return this;
            }
        }
        if (n === this.cap) {
            b = bars[this.head];
            this.head = (this.head + 1) & mask;
        } else {
            b = bars[(this.head + n) & mask];
            this.n = n + 1;
        }
        b.t = t;
        b.o = buf[off + 1];
        b.h = buf[off + 2];
        b.l = buf[off + 3];
        b.c = buf[off + 4];
        b.v = buf[off + 5];
        return this;
    }
}
