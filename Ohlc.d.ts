/**
 * @zakkster/lite-ohlc -- zero-allocation OHLCV candle store for live charts.
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 *
 * Hot vs cold: the *From methods, the searches, boundsInto, copyRangeInto, decimateInto,
 * clear and the integer getters (version, capacity, count, hasLive) are the zero-allocation
 * path. The scalar wrappers (appendBar, setLive, lowerBound, upperBound) and the getters
 * that return a double (interval, oldestTime, latestTime) are the cold path: a fractional
 * or large argument crossing the call boundary boxes (up to six per appendBar / setLive call),
 * and the double getters box their result once per read.
 *
 * Every candle is six doubles in the order [t, o, h, l, c, v].
 */

/** Package version. */
export declare const VERSION: '1.0.2';
/** Doubles per candle: [t, o, h, l, c, v]. */
export declare const CANDLE_STRIDE: 6;
/** Doubles written by boundsInto: [minLow, maxHigh, maxVol, open, close, sumVol, i0, i1, n]. */
export declare const BOUNDS_STRIDE: 9;
/** Doubles per bucket written by decimateInto: [t, o, h, l, c, v, k]. */
export declare const BUCKET_STRIDE: 7;
/** Smallest accepted capacity. */
export declare const MIN_CAPACITY: 2;
/** Largest accepted capacity (2^22). */
export declare const MAX_CAPACITY: 4194304;
/** Largest accepted bucket count B for decimateInto (2^20). */
export declare const MAX_BUCKETS: 1048576;

/**
 * Fixed-capacity ring of OHLCV bars, oldest first, addressed by LOGICAL index
 * 0..count-1 (0 = oldest). The newest bar may be a live (still forming) bar.
 * When full, appending a new bar evicts the oldest one.
 */
export declare class OhlcSeries {
    /**
     * @param capacity integer power of two in [MIN_CAPACITY, MAX_CAPACITY].
     * @param interval bar interval, metadata only (never used to validate times); finite and > 0.
     * @throws {TypeError} capacity or interval is not a number.
     * @throws {RangeError} capacity is not an integer power of two in range, or interval is
     *   not finite and > 0.
     */
    constructor(capacity: number, interval: number);

    /** Bumped on every successful write or clear; wraps at 2^30. Integer (SMI). */
    readonly version: number;
    /** The interval given to the constructor. Cold: boxes a double. */
    readonly interval: number;
    /** Ring capacity given to the constructor. */
    readonly capacity: number;
    /** Closed bars plus the live bar if any (0..capacity). Integer (SMI). */
    readonly count: number;
    /** True when the newest bar (index count-1) is the live bar. */
    readonly hasLive: boolean;
    /** Time of logical bar 0, or NaN when empty. Cold: boxes a double. */
    readonly oldestTime: number;
    /** Time of logical bar count-1, or NaN when empty. Cold: boxes a double. */
    readonly latestTime: number;

    /**
     * Append a CLOSED bar read from buf[off..off+5] as [t,o,h,l,c,v]. Time rule against the
     * newest bar: equal time replaces it (and it becomes closed, even if it was live); later
     * time closes any live bar as-is, then pushes (evicting the oldest when full); earlier
     * time throws. Bar values are validated first: finite, l <= o <= h, l <= c <= h,
     * 0 <= v <= Number.MAX_VALUE / (4 * capacity). Any throw leaves the series unchanged.
     * Hot: zero allocation.
     * @throws {TypeError} buf is not a Float64Array.
     * @throws {RangeError} off is not an integer >= 0 with off + 6 <= buf.length; the candle
     *   is invalid; or t is earlier than the newest bar.
     * @returns this
     */
    appendBarFrom(buf: Float64Array, off?: number): this;

    /**
     * Set the LIVE (forming) bar from buf[off..off+5] as [t,o,h,l,c,v]. Time rule against
     * the newest bar: equal time overwrites it (a closed newest bar REOPENS as live); later
     * time closes any live bar as-is, then pushes the new live bar (evicting the oldest when
     * full); earlier time throws. The live bar is outside the tree, so repeated updates are
     * O(1). Validation and throws as appendBarFrom. Hot: zero allocation.
     * @throws {TypeError} buf is not a Float64Array.
     * @throws {RangeError} bad off, invalid candle, or t earlier than the newest bar.
     * @returns this
     */
    setLiveFrom(buf: Float64Array, off?: number): this;

    /**
     * Scalar wrapper of appendBarFrom; all six arguments are required. Cold: fractional or large
     * arguments box.
     * @throws {TypeError} any argument is not a number.
     * @throws {RangeError} as appendBarFrom (invalid candle, earlier time).
     * @returns this
     */
    appendBar(t: number, o: number, h: number, l: number, c: number, v: number): this;

    /**
     * Scalar wrapper of setLiveFrom; all six arguments are required. Cold: fractional or large
     * arguments box.
     * @throws {TypeError} any argument is not a number.
     * @throws {RangeError} as setLiveFrom (invalid candle, earlier time).
     * @returns this
     */
    setLive(t: number, o: number, h: number, l: number, c: number, v: number): this;

    /** O(1): forget every bar (live included) and bump version. Capacity is unchanged. */
    clear(): this;

    /**
     * First logical index whose time is >= buf[off], or -1 when the series is empty,
     * buf[off] is not finite, or every bar is earlier. Binary search, O(log n). Hot.
     * @throws {TypeError} buf is not a Float64Array.
     * @throws {RangeError} off is not an integer in [0, buf.length).
     */
    lowerBoundFrom(buf: Float64Array, off?: number): number;

    /**
     * LAST logical index whose time is <= buf[off], or -1 when the series is empty,
     * buf[off] is not finite, or every bar is later. Binary search, O(log n). Hot.
     * @throws {TypeError} buf is not a Float64Array.
     * @throws {RangeError} off is not an integer in [0, buf.length).
     */
    upperBoundFrom(buf: Float64Array, off?: number): number;

    /**
     * Scalar lowerBoundFrom. A non-number or non-finite x returns -1 (never throws). Cold.
     */
    lowerBound(x: number): number;

    /**
     * Scalar upperBoundFrom. A non-number or non-finite x returns -1 (never throws). Cold.
     */
    upperBound(x: number): number;

    /**
     * Aggregate the logical range [i0, i1] (both inclusive, the live bar included) and write
     * BOUNDS_STRIDE (9) doubles at out[off..off+8], in this order:
     *   [0] minLow  [1] maxHigh  [2] maxVol  [3] open of bar i0  [4] close of bar i1
     *   [5] sumVol  [6] i0  [7] i1  [8] n
     * and return n = i1 - i0 + 1 (count of bars aggregated). An invalid range (non-integer
     * index, i0 < 0, i0 > i1, or i1 >= count) writes [NaN, NaN, NaN, NaN, NaN, 0, -1, -1, 0]
     * and returns 0. O(log n) by construction (tree over closed bars plus an O(1) live fold).
     * @throws {TypeError} out is not a Float64Array.
     * @throws {RangeError} off is not an integer >= 0 with off + 9 <= out.length (checked
     *   even for an invalid range).
     */
    boundsInto(i0: number, i1: number, out: Float64Array, off?: number): number;

    /**
     * Copy bars [i0, i1] oldest first into out starting at off, CANDLE_STRIDE (6) doubles per
     * bar in the order [t, o, h, l, c, v]; return the number of bars copied. An invalid range
     * returns 0 and writes nothing.
     * @throws {TypeError} out is not a Float64Array.
     * @throws {RangeError} off is not an integer >= 0; or the range is valid but
     *   off + 6 * n > out.length (nothing is written).
     */
    copyRangeInto(i0: number, i1: number, out: Float64Array, off?: number): number;

    /**
     * Decimate the logical range [i0, i1] into at most B buckets for drawing. With
     * n = i1 - i0 + 1, bucket k covers the bars [i0 + ceil(k*n/B), i0 + ceil((k+1)*n/B) - 1].
     * Each non-empty bucket, in ascending k, writes BUCKET_STRIDE (7) doubles at
     * out[off + 7 * w]:
     *   [0] t of first bar  [1] open of first bar  [2] max high  [3] min low
     *   [4] close of last bar  [5] sum of volume  [6] bucket index k
     * where w counts the buckets already written. Empty buckets (only when n < B) write
     * nothing, so k can skip values. Returns the number of buckets written (= min(n, B)); an
     * invalid range returns 0 and writes nothing. Slots past off + 7 * written are untouched.
     *
     * Two paths (settled, ROADMAP D5): a linear scan when n < B * log2(capacity), else one
     * fused tree query per bucket. A given query always takes the same path. t, o, h, l, c
     * and k are byte-identical across paths; volume is byte-identical for integer
     * volumes whose sums stay below 2^53 (otherwise the scan sums sequentially, the tree pairwise).
     * @throws {TypeError} out is not a Float64Array.
     * @throws {RangeError} off is not an integer >= 0; B is not an integer in
     *   [1, MAX_BUCKETS]; or off + 7 * B > out.length. The B and length checks fire even
     *   for an invalid range.
     */
    decimateInto(i0: number, i1: number, B: number, out: Float64Array, off?: number): number;
}
