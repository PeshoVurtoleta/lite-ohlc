/**
 * Ohlc.js
 * High-performance, zero-allocation ring buffer, viewport math, and spatial indexing
 * for high-frequency financial time-series charts.
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */

import { SegmentTree, Fenwick } from '@zakkster/lite-logn';
import { Sieve } from '@zakkster/lite-lru';

export const VERSION = '1.0.0';
export const DEFAULT_CAPACITY = 65536;
export const MIN_CAPACITY = 2;
export const MAX_CAPACITY = 4194304; // 1 << 22
export const DEFAULT_POOL_MAX_SERIES = 64;
export const CANDLE_STRIDE = 6;
export const BOUNDS_STRIDE = 9;
export const BUCKET_STRIDE = 7;
export const HIT_STRIDE = 14;

const LOG_PRICE_FLOOR = 1e-8;
const MIN_ZOOM_FACTOR = 0.1;
const MAX_ZOOM_FACTOR = 10.0;
const DEFAULT_MAX_TIME = 1000;
const DEFAULT_MAX_PRICE = 100;
const DEFAULT_PADDING = 20;
const DEFAULT_MIN_TIME_SPAN = 1000;

// --- Options Validation & Did-You-Mean (Cold Path) ---------------------------

const _levRow = new Int32Array(32);

function levenshtein(a, b) {
    const la = a.length;
    const lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;

    const row = lb + 1 <= _levRow.length ? _levRow : new Int32Array(lb + 1);
    for (let j = 0; j <= lb; j++) row[j] = j;

    for (let i = 1; i <= la; i++) {
        let prev = i - 1;
        row[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j++) {
            const temp = row[j];
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            const ins = row[j - 1] + 1;
            const del = temp + 1;
            const sub = prev + cost;
            let min = ins < del ? ins : del;
            if (sub < min) min = sub;
            row[j] = min;
            prev = temp;
        }
    }
    return row[lb];
}

function findSuggestion(unknownKey, allowedKeys) {
    let bestMatch = null;
    let bestDist = 3; // only suggest if distance <= 2
    for (let i = 0; i < allowedKeys.length; i++) {
        const d = levenshtein(unknownKey, allowedKeys[i]);
        if (d < bestDist) {
            bestDist = d;
            bestMatch = allowedKeys[i];
        }
    }
    return bestMatch;
}

function validateOptions(options, allowedKeys, componentName) {
    if (options === undefined) return;
    if (typeof options !== 'object' || options === null || Object.getPrototypeOf(options) !== Object.prototype) {
        throw new TypeError(`${componentName} options must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(options).length > 0) {
        throw new TypeError(`${componentName} options cannot have symbol properties`);
    }

    const keys = Object.keys(options);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!allowedKeys.includes(k)) {
            const suggestion = findSuggestion(k, allowedKeys);
            const hint = suggestion !== null ? ` Did you mean "${suggestion}"?` : '';
            throw new TypeError(`Unknown option "${k}" in ${componentName}.${hint}`);
        }
    }
}

const SERIES_ALLOWED_KEYS = ['capacity'];
const POOL_ALLOWED_KEYS = ['maxSeries', 'seriesCapacity', 'onEvict'];
const VIEWPORT_ALLOWED_KEYS = [
    'width', 'height', 'minTime', 'maxTime', 'minPrice', 'maxPrice',
    'isLogScale', 'paddingTop', 'paddingBottom', 'minTimeSpan', 'viewport'
];

function validateCanvasViewport(vp) {
    if (typeof vp !== 'object' || vp === null || Array.isArray(vp)) {
        throw new TypeError('viewport must be a non-null object');
    }
    if (typeof vp.width !== 'number' || typeof vp.height !== 'number') {
        throw new TypeError('viewport.width and viewport.height must be numbers');
    }
    if (
        (vp.width - vp.width !== 0) ||
        (vp.height - vp.height !== 0) ||
        !(vp.width >= 0) ||
        !(vp.height >= 0)
    ) {
        throw new RangeError('viewport.width and viewport.height must be non-negative finite numbers');
    }
    if (vp.onResize !== undefined && vp.onResize !== null && typeof vp.onResize !== 'function') {
        throw new TypeError('viewport.onResize must be a function or undefined/null');
    }
}

// --- LiteTimeSeries ----------------------------------------------------------

export class LiteTimeSeries {
    constructor(options) {
        validateOptions(options, SERIES_ALLOWED_KEYS, 'LiteTimeSeries');
        let cap = DEFAULT_CAPACITY;
        if (options !== undefined && options.capacity !== undefined) {
            const c = options.capacity;
            if (typeof c !== 'number') {
                throw new TypeError('Option "capacity" must be a number');
            }
            if ((c | 0) !== c || c < MIN_CAPACITY || c > MAX_CAPACITY || (c & (c - 1)) !== 0) {
                throw new RangeError(
                    `Option "capacity" must be an integer power of 2 between ${MIN_CAPACITY} and ${MAX_CAPACITY}`
                );
            }
            cap = c;
        }
        this.capacity = cap;
        this.mask = cap - 1;
        this.time = new Float64Array(cap);
        this.open = new Float64Array(cap);
        this.high = new Float64Array(cap);
        this.low = new Float64Array(cap);
        this.close = new Float64Array(cap);
        this.volume = new Float64Array(cap);
        this._istate = new Int32Array(3); // [0] head (next write slot), [1] count (occupied slots), [2] version
        this._scratch = new Float64Array(CANDLE_STRIDE);

        this._maxVol = Number.MAX_VALUE / (4 * cap);
        this._segLow = new SegmentTree(cap, 'min');
        this._segHigh = new SegmentTree(cap, 'max');
        this._segVol = new SegmentTree(cap, 'max');
        this._fenVol = new Fenwick(cap);
    }

    get head() { return this._istate[0]; }
    get count() { return this._istate[1]; }
    get version() { return this._istate[2]; }

    get [Symbol.toStringTag]() { return 'LiteTimeSeries'; }

    // --- Ring Buffer Indexing -------------------------------------------------

    /**
     * Converts a logical chronological index [0, count - 1] (0 = oldest, count - 1 = newest)
     * into its physical typed-array slot index [0, capacity - 1], or -1 if out of range.
     */
    getPhysicalIndex(logicalIndex) {
        const count = this._istate[1];
        if (typeof logicalIndex !== 'number' || (logicalIndex | 0) !== logicalIndex || logicalIndex < 0 || logicalIndex >= count) {
            return -1;
        }
        return count < this.capacity ? logicalIndex : ((this._istate[0] + logicalIndex) & this.mask);
    }

    /**
     * Converts an occupied physical typed-array slot index [0, capacity - 1] into its
     * logical chronological index [0, count - 1], or -1 if out of range or unoccupied.
     */
    getLogicalIndex(physicalIndex) {
        const count = this._istate[1];
        const cap = this.capacity;
        if (
            count === 0 ||
            typeof physicalIndex !== 'number' ||
            (physicalIndex | 0) !== physicalIndex ||
            physicalIndex < 0 ||
            physicalIndex >= cap
        ) {
            return -1;
        }
        if (count < cap) {
            return physicalIndex < count ? physicalIndex : -1;
        }
        return (physicalIndex - this._istate[0] + cap) & this.mask;
    }

    getLatestPhysicalIndex() {
        const count = this._istate[1];
        if (count === 0) return -1;
        return (this._istate[0] - 1 + this.capacity) & this.mask;
    }

    getOldestPhysicalIndex() {
        const count = this._istate[1];
        if (count === 0) return -1;
        return count < this.capacity ? 0 : this._istate[0];
    }

    getLatestTime() {
        const count = this._istate[1];
        if (count === 0) return NaN;
        return this.time[(this._istate[0] - 1 + this.capacity) & this.mask];
    }

    getOldestTime() {
        const count = this._istate[1];
        if (count === 0) return NaN;
        return this.time[count < this.capacity ? 0 : this._istate[0]];
    }

    getCandleInto(logicalIndex, outFloat64, outOffset = 0) {
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + CANDLE_STRIDE > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }
        const phys = this.getPhysicalIndex(logicalIndex);
        if (phys === -1) {
            for (let i = 0; i < CANDLE_STRIDE; i++) {
                outFloat64[outOffset + i] = NaN;
            }
            return 0;
        }
        outFloat64[outOffset] = this.time[phys];
        outFloat64[outOffset + 1] = this.open[phys];
        outFloat64[outOffset + 2] = this.high[phys];
        outFloat64[outOffset + 3] = this.low[phys];
        outFloat64[outOffset + 4] = this.close[phys];
        outFloat64[outOffset + 5] = this.volume[phys];
        return 1;
    }

    /**
     * Bulk-copies a logical index range [startLogical, endLogical] (inclusive) into a flat
     * Float64Array at CANDLE_STRIDE (6) floats per candle: [time, open, high, low, close, volume].
     * Returns the number of candles copied.
     */
    copyRangeInto(startLogical, endLogical, outFloat64, outOffset = 0) {
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }

        const count = this._istate[1];
        if (
            count === 0 ||
            typeof startLogical !== 'number' ||
            typeof endLogical !== 'number' ||
            (startLogical !== startLogical) ||
            (endLogical !== endLogical)
        ) {
            return 0;
        }

        if (endLogical < 0 || startLogical >= count) {
            return 0;
        }
        const s = startLogical <= 0 ? 0 : (startLogical | 0);
        const e = endLogical >= count - 1 ? count - 1 : (endLogical | 0);
        if (s > e) {
            return 0;
        }

        const n = e - s + 1;
        if (outOffset + n * CANDLE_STRIDE > outFloat64.length) {
            throw new RangeError('outFloat64 buffer too small for requested logical range');
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const base = count < cap ? 0 : head;

        let dst = outOffset;
        for (let log = s; log <= e; log++) {
            const phys = (base + log) & mask;
            outFloat64[dst] = this.time[phys];
            outFloat64[dst + 1] = this.open[phys];
            outFloat64[dst + 2] = this.high[phys];
            outFloat64[dst + 3] = this.low[phys];
            outFloat64[dst + 4] = this.close[phys];
            outFloat64[dst + 5] = this.volume[phys];
            dst += CANDLE_STRIDE;
        }
        return n;
    }

    // --- Ingestion & Mutation (Canonical *From + Thin Scalar Wrappers) --------

    appendFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + CANDLE_STRIDE > buf.length) {
            throw new RangeError('offset out of bounds');
        }

        const time = buf[offset];
        const open = buf[offset + 1];
        const high = buf[offset + 2];
        const low = buf[offset + 3];
        const close = buf[offset + 4];
        const volume = buf[offset + 5];

        if (
            (time - time !== 0) ||
            (open - open !== 0) ||
            (high - high !== 0) ||
            (low - low !== 0) ||
            (close - close !== 0) ||
            (volume - volume !== 0) ||
            !(high >= low) ||
            !(open >= low) ||
            !(open <= high) ||
            !(close >= low) ||
            !(close <= high) ||
            !(volume >= 0) ||
            !(volume <= this._maxVol)
        ) {
            throw new RangeError('Invalid candle values or invariant violation');
        }

        const count = this._istate[1];
        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;

        if (count > 0) {
            const latestPhys = (head - 1 + cap) & mask;
            if (!(time > this.time[latestPhys])) {
                throw new RangeError('Timestamp must be strictly increasing');
            }
        }

        this.time[head] = time;
        this.open[head] = open;
        this.high[head] = high;
        this.low[head] = low;
        this.close[head] = close;
        this.volume[head] = volume;

        this._segLow.setFrom(this.low, head);
        this._segHigh.setFrom(this.high, head);
        this._segVol.setFrom(this.volume, head);
        this._fenVol.setFrom(this.volume, head);

        this._istate[0] = (head + 1) & mask;
        if (count < cap) {
            this._istate[1] = count + 1;
        }
        this._istate[2] = (this._istate[2] + 1) | 0;
        return this;
    }

    append(time, open, high, low, close, volume = 0) {
        if (
            typeof time !== 'number' ||
            typeof open !== 'number' ||
            typeof high !== 'number' ||
            typeof low !== 'number' ||
            typeof close !== 'number' ||
            typeof volume !== 'number'
        ) {
            throw new TypeError('Candle values must be numbers');
        }
        const s = this._scratch;
        s[0] = time;
        s[1] = open;
        s[2] = high;
        s[3] = low;
        s[4] = close;
        s[5] = volume;
        return this.appendFrom(s, 0);
    }

    updateLatestFrom(buf, offset = 0) {
        const count = this._istate[1];
        if (count === 0) {
            return this.appendFrom(buf, offset);
        }

        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + CANDLE_STRIDE > buf.length) {
            throw new RangeError('offset out of bounds');
        }

        const time = buf[offset];
        const open = buf[offset + 1];
        const high = buf[offset + 2];
        const low = buf[offset + 3];
        const close = buf[offset + 4];
        const volume = buf[offset + 5];

        if (
            (time - time !== 0) ||
            (open - open !== 0) ||
            (high - high !== 0) ||
            (low - low !== 0) ||
            (close - close !== 0) ||
            (volume - volume !== 0) ||
            !(high >= low) ||
            !(open >= low) ||
            !(open <= high) ||
            !(close >= low) ||
            !(close <= high) ||
            !(volume >= 0) ||
            !(volume <= this._maxVol)
        ) {
            throw new RangeError('Invalid candle values or invariant violation');
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const phys = (head - 1 + cap) & mask;

        if (!(time >= this.time[phys])) {
            throw new RangeError('Timestamp cannot be older than current latest candle');
        }

        this.time[phys] = time;
        this.open[phys] = open;
        this.high[phys] = high;
        this.low[phys] = low;
        this.close[phys] = close;
        this.volume[phys] = volume;

        this._segLow.setFrom(this.low, phys);
        this._segHigh.setFrom(this.high, phys);
        this._segVol.setFrom(this.volume, phys);
        this._fenVol.setFrom(this.volume, phys);

        this._istate[2] = (this._istate[2] + 1) | 0;
        return this;
    }

    updateLatest(time, open, high, low, close, volume = 0) {
        if (
            typeof time !== 'number' ||
            typeof open !== 'number' ||
            typeof high !== 'number' ||
            typeof low !== 'number' ||
            typeof close !== 'number' ||
            typeof volume !== 'number'
        ) {
            throw new TypeError('Candle values must be numbers');
        }
        const s = this._scratch;
        s[0] = time;
        s[1] = open;
        s[2] = high;
        s[3] = low;
        s[4] = close;
        s[5] = volume;
        return this.updateLatestFrom(s, 0);
    }

    clear() {
        this._istate[0] = 0;
        this._istate[1] = 0;
        this._istate[2] = (this._istate[2] + 1) | 0;
        this._segLow.clear();
        this._segHigh.clear();
        this._segVol.clear();
        this._fenVol.clear();
        return this;
    }

    // --- Search & Range Queries -----------------------------------------------

    findClosestLogicalIndexFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset >= buf.length) {
            throw new RangeError('offset out of bounds');
        }

        const count = this._istate[1];
        const targetTime = buf[offset];
        if (count === 0 || (targetTime - targetTime !== 0)) {
            return -1;
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const base = count < cap ? 0 : head;

        const oldestPhys = base;
        const newestPhys = (head - 1 + cap) & mask;

        if (targetTime <= this.time[oldestPhys]) return 0;
        if (targetTime >= this.time[newestPhys]) return count - 1;

        let leftLogical = 0;
        let rightLogical = count - 1;

        while (leftLogical <= rightLogical) {
            const midLogical = (leftLogical + rightLogical) >>> 1;
            const midPhys = (base + midLogical) & mask;
            const midTime = this.time[midPhys];

            if (midTime === targetTime) {
                return midLogical;
            } else if (midTime < targetTime) {
                leftLogical = midLogical + 1;
            } else {
                rightLogical = midLogical - 1;
            }
        }

        // Defensive clamp against domain boundary inversions
        if (rightLogical < 0) rightLogical = 0;
        if (leftLogical >= count) leftLogical = count - 1;

        const olderPhys = (base + rightLogical) & mask;
        const newerPhys = (base + leftLogical) & mask;

        const diffOlder = targetTime - this.time[olderPhys];
        const diffNewer = this.time[newerPhys] - targetTime;

        return diffOlder <= diffNewer ? rightLogical : leftLogical;
    }

    findClosestLogicalIndex(targetTime) {
        if (typeof targetTime !== 'number' || (targetTime - targetTime !== 0)) {
            return -1;
        }
        this._scratch[0] = targetTime;
        return this.findClosestLogicalIndexFrom(this._scratch, 0);
    }

    findClosestPhysicalIndexFrom(buf, offset = 0) {
        const log = this.findClosestLogicalIndexFrom(buf, offset);
        if (log === -1) return -1;
        const count = this._istate[1];
        return count < this.capacity ? log : ((this._istate[0] + log) & this.mask);
    }

    findClosestPhysicalIndex(targetTime) {
        if (typeof targetTime !== 'number' || (targetTime - targetTime !== 0)) {
            return -1;
        }
        this._scratch[0] = targetTime;
        return this.findClosestPhysicalIndexFrom(this._scratch, 0);
    }

    /**
     * First logical index in [0, count - 1] with time >= minTime, or -1 if none.
     */
    findLowerBoundLogicalIndexFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset >= buf.length) {
            throw new RangeError('offset out of bounds');
        }

        const count = this._istate[1];
        const minTime = buf[offset];
        if (count === 0 || (minTime - minTime !== 0)) {
            return -1;
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const base = count < cap ? 0 : head;

        const oldestPhys = base;
        const newestPhys = (head - 1 + cap) & mask;

        if (minTime <= this.time[oldestPhys]) return 0;
        if (minTime > this.time[newestPhys]) return -1;

        let lo = 0;
        let hi = count - 1;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const midPhys = (base + mid) & mask;
            if (this.time[midPhys] < minTime) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    findLowerBoundLogicalIndex(minTime) {
        if (typeof minTime !== 'number' || (minTime - minTime !== 0)) {
            return -1;
        }
        this._scratch[0] = minTime;
        return this.findLowerBoundLogicalIndexFrom(this._scratch, 0);
    }

    /**
     * Last logical index in [0, count - 1] with time <= maxTime, or -1 if none.
     */
    findUpperBoundLogicalIndexFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset >= buf.length) {
            throw new RangeError('offset out of bounds');
        }

        const count = this._istate[1];
        const maxTime = buf[offset];
        if (count === 0 || (maxTime - maxTime !== 0)) {
            return -1;
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const base = count < cap ? 0 : head;

        const oldestPhys = base;
        const newestPhys = (head - 1 + cap) & mask;

        if (maxTime < this.time[oldestPhys]) return -1;
        if (maxTime >= this.time[newestPhys]) return count - 1;

        let lo = 0;
        let hi = count - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            const midPhys = (base + mid) & mask;
            if (this.time[midPhys] <= maxTime) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo;
    }

    findUpperBoundLogicalIndex(maxTime) {
        if (typeof maxTime !== 'number' || (maxTime - maxTime !== 0)) {
            return -1;
        }
        this._scratch[0] = maxTime;
        return this.findUpperBoundLogicalIndexFrom(this._scratch, 0);
    }

    getVisibleRangeFrom(timeBuf, timeOffset, outInt32, outOffset = 0) {
        if (!(timeBuf instanceof Float64Array)) {
            throw new TypeError('timeBuf must be a Float64Array');
        }
        if ((timeOffset | 0) !== timeOffset || timeOffset < 0 || timeOffset + 2 > timeBuf.length) {
            throw new RangeError('timeOffset out of bounds');
        }
        if (!(outInt32 instanceof Int32Array)) {
            throw new TypeError('outInt32 must be an Int32Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + 3 > outInt32.length) {
            throw new RangeError('outOffset out of bounds');
        }

        const count = this._istate[1];
        const minTime = timeBuf[timeOffset];
        const maxTime = timeBuf[timeOffset + 1];

        if (
            count === 0 ||
            (minTime - minTime !== 0) ||
            (maxTime - maxTime !== 0) ||
            !(minTime <= maxTime)
        ) {
            outInt32[outOffset] = -1;
            outInt32[outOffset + 1] = -1;
            outInt32[outOffset + 2] = 0;
            return 0;
        }

        const startLog = this.findLowerBoundLogicalIndexFrom(timeBuf, timeOffset);
        const endLog = this.findUpperBoundLogicalIndexFrom(timeBuf, timeOffset + 1);
        if (startLog === -1 || endLog === -1 || startLog > endLog) {
            outInt32[outOffset] = -1;
            outInt32[outOffset + 1] = -1;
            outInt32[outOffset + 2] = 0;
            return 0;
        }

        const visCount = endLog - startLog + 1;
        outInt32[outOffset] = startLog;
        outInt32[outOffset + 1] = endLog;
        outInt32[outOffset + 2] = visCount;
        return visCount;
    }

    getVisibleLogicalRangeInto(minTime, maxTime, outInt32, outOffset = 0) {
        if (!(outInt32 instanceof Int32Array)) {
            throw new TypeError('outInt32 must be an Int32Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + 3 > outInt32.length) {
            throw new RangeError('outOffset out of bounds');
        }
        if (typeof minTime !== 'number' || typeof maxTime !== 'number') {
            outInt32[outOffset] = -1;
            outInt32[outOffset + 1] = -1;
            outInt32[outOffset + 2] = 0;
            return 0;
        }
        const s = this._scratch;
        s[0] = minTime;
        s[1] = maxTime;
        return this.getVisibleRangeFrom(s, 0, outInt32, outOffset);
    }

    forEachVisible(startLogical, endLogical, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('callback must be a function');
        }

        const count = this._istate[1];
        if (
            count === 0 ||
            typeof startLogical !== 'number' ||
            typeof endLogical !== 'number' ||
            (startLogical !== startLogical) ||
            (endLogical !== endLogical)
        ) {
            return 0;
        }

        if (endLogical < 0 || startLogical >= count) {
            return 0;
        }
        const s = startLogical <= 0 ? 0 : (startLogical | 0);
        const e = endLogical >= count - 1 ? count - 1 : (endLogical | 0);
        if (s > e) {
            return 0;
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const base = count < cap ? 0 : head;

        for (let log = s; log <= e; log++) {
            const phys = (base + log) & mask;
            callback(phys, log);
        }
        return e - s + 1;
    }

    // --- Bounds & Decimation (Zero-Box Hot Paths) -----------------------------

    computeBoundsFrom(timeBuf, timeOffset, outFloat64, outOffset = 0) {
        if (!(timeBuf instanceof Float64Array)) {
            throw new TypeError('timeBuf must be a Float64Array');
        }
        if ((timeOffset | 0) !== timeOffset || timeOffset < 0 || timeOffset + 2 > timeBuf.length) {
            throw new RangeError('timeOffset out of bounds');
        }
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + BOUNDS_STRIDE > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }

        const count = this._istate[1];
        const minTime = timeBuf[timeOffset];
        const maxTime = timeBuf[timeOffset + 1];

        if (
            count === 0 ||
            (minTime - minTime !== 0) ||
            (maxTime - maxTime !== 0) ||
            !(minTime <= maxTime)
        ) {
            outFloat64[outOffset] = NaN;
            outFloat64[outOffset + 1] = NaN;
            outFloat64[outOffset + 2] = NaN;
            outFloat64[outOffset + 3] = NaN;
            outFloat64[outOffset + 4] = NaN;
            outFloat64[outOffset + 5] = 0;
            outFloat64[outOffset + 6] = -1;
            outFloat64[outOffset + 7] = -1;
            outFloat64[outOffset + 8] = 0;
            return 0;
        }

        const startLog = this.findLowerBoundLogicalIndexFrom(timeBuf, timeOffset);
        const endLog = this.findUpperBoundLogicalIndexFrom(timeBuf, timeOffset + 1);
        if (startLog === -1 || endLog === -1 || startLog > endLog) {
            outFloat64[outOffset] = NaN;
            outFloat64[outOffset + 1] = NaN;
            outFloat64[outOffset + 2] = NaN;
            outFloat64[outOffset + 3] = NaN;
            outFloat64[outOffset + 4] = NaN;
            outFloat64[outOffset + 5] = 0;
            outFloat64[outOffset + 6] = -1;
            outFloat64[outOffset + 7] = -1;
            outFloat64[outOffset + 8] = 0;
            return 0;
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const base = count < cap ? 0 : head;

        const firstPhys = (base + startLog) & mask;
        const lastPhys = (base + endLog) & mask;

        const firstOpen = this.open[firstPhys];
        const lastClose = this.close[lastPhys];

        const tLow = this._segLow._t;
        const tHigh = this._segHigh._t;
        const tVol = this._segVol._t;
        const tFen = this._fenVol._t;

        let minLow, maxHigh, maxVolume, sumVolume;

        if (firstPhys <= lastPhys) {
            let l = cap + firstPhys, r = cap + lastPhys + 1;
            minLow = Infinity;
            maxHigh = -Infinity;
            maxVolume = -Infinity;
            for (; l < r; l >>= 1, r >>= 1) {
                if (l & 1) {
                    const vl = tLow[l]; if (vl < minLow) minLow = vl;
                    const vh = tHigh[l]; if (vh > maxHigh) maxHigh = vh;
                    const vv = tVol[l]; if (vv > maxVolume) maxVolume = vv;
                    l++;
                }
                if (r & 1) {
                    --r;
                    const vl = tLow[r]; if (vl < minLow) minLow = vl;
                    const vh = tHigh[r]; if (vh > maxHigh) maxHigh = vh;
                    const vv = tVol[r]; if (vv > maxVolume) maxVolume = vv;
                }
            }

            let sHi = 0, k = 0, m = lastPhys + 1;
            while (m !== 0) {
                const hi = 1 << (31 - Math.clz32(m));
                k += hi; sHi += tFen[k]; m ^= hi;
            }
            let sLo = 0;
            k = 0; m = firstPhys;
            while (m !== 0) {
                const hi = 1 << (31 - Math.clz32(m));
                k += hi; sLo += tFen[k]; m ^= hi;
            }
            sumVolume = sHi - sLo;
        } else {
            let l1 = cap + firstPhys, r1 = cap + cap;
            let min1 = Infinity, max1 = -Infinity, vol1 = -Infinity;
            for (; l1 < r1; l1 >>= 1, r1 >>= 1) {
                if (l1 & 1) {
                    const vl = tLow[l1]; if (vl < min1) min1 = vl;
                    const vh = tHigh[l1]; if (vh > max1) max1 = vh;
                    const vv = tVol[l1]; if (vv > vol1) vol1 = vv;
                    l1++;
                }
                if (r1 & 1) {
                    --r1;
                    const vl = tLow[r1]; if (vl < min1) min1 = vl;
                    const vh = tHigh[r1]; if (vh > max1) max1 = vh;
                    const vv = tVol[r1]; if (vv > vol1) vol1 = vv;
                }
            }

            let s1Hi = 0, k1 = 0, m1 = cap;
            while (m1 !== 0) {
                const hi = 1 << (31 - Math.clz32(m1));
                k1 += hi; s1Hi += tFen[k1]; m1 ^= hi;
            }
            let s1Lo = 0;
            k1 = 0; m1 = firstPhys;
            while (m1 !== 0) {
                const hi = 1 << (31 - Math.clz32(m1));
                k1 += hi; s1Lo += tFen[k1]; m1 ^= hi;
            }
            const sum1 = s1Hi - s1Lo;

            let l2 = cap, r2 = cap + lastPhys + 1;
            let min2 = Infinity, max2 = -Infinity, vol2 = -Infinity;
            for (; l2 < r2; l2 >>= 1, r2 >>= 1) {
                if (l2 & 1) {
                    const vl = tLow[l2]; if (vl < min2) min2 = vl;
                    const vh = tHigh[l2]; if (vh > max2) max2 = vh;
                    const vv = tVol[l2]; if (vv > vol2) vol2 = vv;
                    l2++;
                }
                if (r2 & 1) {
                    --r2;
                    const vl = tLow[r2]; if (vl < min2) min2 = vl;
                    const vh = tHigh[r2]; if (vh > max2) max2 = vh;
                    const vv = tVol[r2]; if (vv > vol2) vol2 = vv;
                }
            }

            let s2Hi = 0, k2 = 0, m2 = lastPhys + 1;
            while (m2 !== 0) {
                const hi = 1 << (31 - Math.clz32(m2));
                k2 += hi; s2Hi += tFen[k2]; m2 ^= hi;
            }
            const sum2 = s2Hi;

            minLow = min1 < min2 ? min1 : min2;
            maxHigh = max1 > max2 ? max1 : max2;
            maxVolume = vol1 > vol2 ? vol1 : vol2;
            sumVolume = sum1 + sum2;
        }

        const visibleCount = endLog - startLog + 1;
        outFloat64[outOffset] = minLow;
        outFloat64[outOffset + 1] = maxHigh;
        outFloat64[outOffset + 2] = maxVolume;
        outFloat64[outOffset + 3] = firstOpen;
        outFloat64[outOffset + 4] = lastClose;
        outFloat64[outOffset + 5] = sumVolume;
        outFloat64[outOffset + 6] = startLog;
        outFloat64[outOffset + 7] = endLog;
        outFloat64[outOffset + 8] = visibleCount;
        return visibleCount;
    }

    computeBoundsInto(minTime, maxTime, outFloat64, outOffset = 0) {
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + BOUNDS_STRIDE > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }
        if (typeof minTime !== 'number' || typeof maxTime !== 'number') {
            outFloat64[outOffset] = NaN;
            outFloat64[outOffset + 1] = NaN;
            outFloat64[outOffset + 2] = NaN;
            outFloat64[outOffset + 3] = NaN;
            outFloat64[outOffset + 4] = NaN;
            outFloat64[outOffset + 5] = 0;
            outFloat64[outOffset + 6] = -1;
            outFloat64[outOffset + 7] = -1;
            outFloat64[outOffset + 8] = 0;
            return 0;
        }
        const s = this._scratch;
        s[0] = minTime;
        s[1] = maxTime;
        return this.computeBoundsFrom(s, 0, outFloat64, outOffset);
    }

    decimateFrom(timeBuf, timeOffset, bucketCount, outFloat64, outOffset = 0) {
        if (!(timeBuf instanceof Float64Array)) {
            throw new TypeError('timeBuf must be a Float64Array');
        }
        if ((timeOffset | 0) !== timeOffset || timeOffset < 0 || timeOffset + 2 > timeBuf.length) {
            throw new RangeError('timeOffset out of bounds');
        }
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((bucketCount | 0) !== bucketCount || bucketCount < 1) {
            throw new RangeError('bucketCount must be an integer >= 1');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + bucketCount * BUCKET_STRIDE > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }

        const count = this._istate[1];
        const minTime = timeBuf[timeOffset];
        const maxTime = timeBuf[timeOffset + 1];

        if (
            count === 0 ||
            (minTime - minTime !== 0) ||
            (maxTime - maxTime !== 0) ||
            !(minTime <= maxTime)
        ) {
            return 0;
        }

        const startLog = this.findLowerBoundLogicalIndexFrom(timeBuf, timeOffset);
        const endLog = this.findUpperBoundLogicalIndexFrom(timeBuf, timeOffset + 1);
        if (startLog === -1 || endLog === -1 || startLog > endLog) {
            return 0;
        }

        const head = this._istate[0];
        const cap = this.capacity;
        const mask = this.mask;
        const base = count < cap ? 0 : head;
        const span = maxTime - minTime;
        const invSpan = span > 0 ? bucketCount / span : 0;
        const maxBucket = bucketCount - 1;

        let currentBucket = -1;
        let written = 0;

        for (let log = startLog; log <= endLog; log++) {
            const phys = (base + log) & mask;
            const t = this.time[phys];
            let b = ((t - minTime) * invSpan) | 0;
            if (b > maxBucket || b < 0) b = maxBucket;

            const o = this.open[phys];
            const h = this.high[phys];
            const l = this.low[phys];
            const c = this.close[phys];
            const v = this.volume[phys];

            if (b !== currentBucket) {
                const dst = outOffset + written * BUCKET_STRIDE;
                outFloat64[dst] = t;
                outFloat64[dst + 1] = o;
                outFloat64[dst + 2] = h;
                outFloat64[dst + 3] = l;
                outFloat64[dst + 4] = c;
                outFloat64[dst + 5] = v;
                outFloat64[dst + 6] = 1;
                written++;
                currentBucket = b;
            } else {
                const dst = outOffset + (written - 1) * BUCKET_STRIDE;
                if (h > outFloat64[dst + 2]) outFloat64[dst + 2] = h;
                if (l < outFloat64[dst + 3]) outFloat64[dst + 3] = l;
                outFloat64[dst + 4] = c;
                outFloat64[dst + 5] += v;
                outFloat64[dst + 6] += 1;
            }
        }

        return written;
    }

    decimateInto(minTime, maxTime, bucketCount, outFloat64, outOffset = 0) {
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((bucketCount | 0) !== bucketCount || bucketCount < 1) {
            throw new RangeError('bucketCount must be an integer >= 1');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + bucketCount * BUCKET_STRIDE > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }
        if (typeof minTime !== 'number' || typeof maxTime !== 'number') {
            return 0;
        }
        const s = this._scratch;
        s[0] = minTime;
        s[1] = maxTime;
        return this.decimateFrom(s, 0, bucketCount, outFloat64, outOffset);
    }

    // --- Spatial Hit-Testing --------------------------------------------------

    hitTestInto(viewport, mouseX, mouseY, maxSnapDistance, outFloat64, outOffset = 0) {
        return hitTestInto(this, viewport, mouseX, mouseY, maxSnapDistance, outFloat64, outOffset);
    }

    hitTestFrom(viewport, inFloat64, inOffset, outFloat64, outOffset = 0) {
        return hitTestFrom(this, viewport, inFloat64, inOffset, outFloat64, outOffset);
    }
}

export function createTimeSeries(options) {
    return new LiteTimeSeries(options);
}

// --- TimeSeriesViewport -------------------------------------------------------

export class TimeSeriesViewport {
    constructor(options) {
        validateOptions(options, VIEWPORT_ALLOWED_KEYS, 'TimeSeriesViewport');

        // [0] width, [1] height, [2] minTime, [3] maxTime, [4] minPrice, [5] maxPrice,
        // [6] paddingTop, [7] paddingBottom, [8] minTimeSpan
        this._f = new Float64Array(9);
        this._scratch = new Float64Array(4);
        this._boundViewport = null;
        this._prevOnResize = null;
        this._resizeHook = null;

        this._f[0] = 0;
        this._f[1] = 0;
        this._f[2] = 0;
        this._f[3] = DEFAULT_MAX_TIME;
        this._f[4] = 0;
        this._f[5] = DEFAULT_MAX_PRICE;
        this._f[6] = DEFAULT_PADDING;
        this._f[7] = DEFAULT_PADDING;
        this._f[8] = DEFAULT_MIN_TIME_SPAN;

        let isLog = false;
        if (options !== undefined && options.isLogScale !== undefined) {
            if (typeof options.isLogScale !== 'boolean') {
                throw new TypeError('Option "isLogScale" must be a boolean');
            }
            isLog = options.isLogScale;
        }
        this._isLogScale = isLog;
        if (isLog) {
            this._f[4] = 1;
        }

        if (options !== undefined) {
            if (options.minTimeSpan !== undefined) {
                const s = options.minTimeSpan;
                if (typeof s !== 'number') throw new TypeError('Option "minTimeSpan" must be a number');
                if ((s - s !== 0) || !(s > 0)) throw new RangeError('Option "minTimeSpan" must be a positive finite number');
                this._f[8] = s;
            }
            if (options.width !== undefined) {
                const w = options.width;
                if (typeof w !== 'number') throw new TypeError('Option "width" must be a number');
                if ((w - w !== 0) || !(w >= 0)) throw new RangeError('Option "width" must be a non-negative finite number');
                this._f[0] = w;
            }
            if (options.height !== undefined) {
                const h = options.height;
                if (typeof h !== 'number') throw new TypeError('Option "height" must be a number');
                if ((h - h !== 0) || !(h >= 0)) throw new RangeError('Option "height" must be a non-negative finite number');
                this._f[1] = h;
            }
            if (options.paddingTop !== undefined) {
                const pt = options.paddingTop;
                if (typeof pt !== 'number') throw new TypeError('Option "paddingTop" must be a number');
                if ((pt - pt !== 0) || !(pt >= 0)) throw new RangeError('Option "paddingTop" must be a non-negative finite number');
                this._f[6] = pt;
            }
            if (options.paddingBottom !== undefined) {
                const pb = options.paddingBottom;
                if (typeof pb !== 'number') throw new TypeError('Option "paddingBottom" must be a number');
                if ((pb - pb !== 0) || !(pb >= 0)) throw new RangeError('Option "paddingBottom" must be a non-negative finite number');
                this._f[7] = pb;
            }
            if (options.minTime !== undefined) {
                const mt = options.minTime;
                if (typeof mt !== 'number') throw new TypeError('Option "minTime" must be a number');
                if (mt - mt !== 0) throw new RangeError('Option "minTime" must be a finite number');
                this._f[2] = mt;
            }
            if (options.maxTime !== undefined) {
                const xt = options.maxTime;
                if (typeof xt !== 'number') throw new TypeError('Option "maxTime" must be a number');
                if (xt - xt !== 0) throw new RangeError('Option "maxTime" must be a finite number');
                this._f[3] = xt;
            } else {
                this._f[3] = Math.max(DEFAULT_MAX_TIME, this._f[2] + this._f[8]);
            }
            if (this._f[3] < this._f[2]) {
                throw new RangeError('maxTime must be greater than or equal to minTime');
            }
            if (options.maxTime !== undefined) {
                if (options.minTimeSpan !== undefined) {
                    this._f[3] = Math.max(this._f[3], this._f[2] + this._f[8]);
                } else if (this._f[3] > this._f[2] && this._f[3] - this._f[2] < this._f[8]) {
                    this._f[8] = this._f[3] - this._f[2];
                }
            }
            if (options.minPrice !== undefined) {
                const mp = options.minPrice;
                if (typeof mp !== 'number') throw new TypeError('Option "minPrice" must be a number');
                if (mp - mp !== 0) throw new RangeError('Option "minPrice" must be a finite number');
                if (this._isLogScale && !(mp > 0)) {
                    throw new RangeError('Option "minPrice" must be positive when isLogScale is true');
                }
                this._f[4] = mp;
            }
            if (options.maxPrice !== undefined) {
                const xp = options.maxPrice;
                if (typeof xp !== 'number') throw new TypeError('Option "maxPrice" must be a number');
                if (xp - xp !== 0) throw new RangeError('Option "maxPrice" must be a finite number');
                if (this._isLogScale && !(xp > 0)) {
                    throw new RangeError('Option "maxPrice" must be positive when isLogScale is true');
                }
                this._f[5] = xp;
                if (this._isLogScale && options.minPrice === undefined) {
                    this._f[4] = Math.max(LOG_PRICE_FLOOR, Math.min(1, xp * 0.1));
                }
            } else if (options.minPrice !== undefined) {
                this._f[5] = Math.max(DEFAULT_MAX_PRICE, this._f[4] + DEFAULT_MAX_PRICE);
            }
            if (!(this._f[5] >= this._f[4])) {
                throw new RangeError('maxPrice must be greater than or equal to minPrice');
            }
            if (options.viewport !== undefined) {
                this.bindViewport(options.viewport);
            }
        } else {
            this._f[3] = Math.max(DEFAULT_MAX_TIME, this._f[2] + this._f[8]);
        }

        if (this._isLogScale) {
            const pMin = Math.max(this._f[4], LOG_PRICE_FLOOR);
            this._f[4] = pMin;
            const minSpan = Math.max(LOG_PRICE_FLOOR, pMin * 1e-12);
            this._f[5] = Math.max(this._f[5], pMin + minSpan);
        }
    }

    get [Symbol.toStringTag]() { return 'TimeSeriesViewport'; }

    get width() { return this._f[0]; }
    set width(v) {
        if (typeof v !== 'number') throw new TypeError('width must be a number');
        if ((v - v !== 0) || !(v >= 0)) throw new RangeError('width must be a non-negative finite number');
        this._f[0] = v;
    }

    get height() { return this._f[1]; }
    set height(v) {
        if (typeof v !== 'number') throw new TypeError('height must be a number');
        if ((v - v !== 0) || !(v >= 0)) throw new RangeError('height must be a non-negative finite number');
        this._f[1] = v;
    }

    get minTime() { return this._f[2]; }
    set minTime(v) {
        if (typeof v !== 'number') throw new TypeError('minTime must be a number');
        if (v - v !== 0) throw new RangeError('minTime must be a finite number');
        if (v > this._f[3]) throw new RangeError('minTime cannot exceed maxTime');
        this._f[2] = v;
    }

    get maxTime() { return this._f[3]; }
    set maxTime(v) {
        if (typeof v !== 'number') throw new TypeError('maxTime must be a number');
        if (v - v !== 0) throw new RangeError('maxTime must be a finite number');
        if (v < this._f[2]) throw new RangeError('maxTime cannot be less than minTime');
        this._f[3] = v;
    }

    get minPrice() { return this._f[4]; }
    set minPrice(v) {
        if (typeof v !== 'number') throw new TypeError('minPrice must be a number');
        if (v - v !== 0) throw new RangeError('minPrice must be a finite number');
        if (this._isLogScale && !(v > 0)) throw new RangeError('minPrice must be positive in log scale');
        if (v > this._f[5]) throw new RangeError('minPrice cannot exceed maxPrice');
        this._f[4] = v;
    }

    get maxPrice() { return this._f[5]; }
    set maxPrice(v) {
        if (typeof v !== 'number') throw new TypeError('maxPrice must be a number');
        if (v - v !== 0) throw new RangeError('maxPrice must be a finite number');
        if (v < this._f[4]) throw new RangeError('maxPrice cannot be less than minPrice');
        this._f[5] = v;
    }

    get paddingTop() { return this._f[6]; }
    set paddingTop(v) {
        if (typeof v !== 'number') throw new TypeError('paddingTop must be a number');
        if ((v - v !== 0) || !(v >= 0)) throw new RangeError('paddingTop must be a non-negative finite number');
        this._f[6] = v;
    }

    get paddingBottom() { return this._f[7]; }
    set paddingBottom(v) {
        if (typeof v !== 'number') throw new TypeError('paddingBottom must be a number');
        if ((v - v !== 0) || !(v >= 0)) throw new RangeError('paddingBottom must be a non-negative finite number');
        this._f[7] = v;
    }

    get minTimeSpan() { return this._f[8]; }
    set minTimeSpan(v) {
        if (typeof v !== 'number') throw new TypeError('minTimeSpan must be a number');
        if ((v - v !== 0) || !(v > 0)) throw new RangeError('minTimeSpan must be a positive finite number');
        this._f[8] = v;
        if (this._f[3] - this._f[2] < v) {
            this._f[3] = this._f[2] + v;
        }
    }

    get isLogScale() { return this._isLogScale; }
    set isLogScale(v) {
        if (typeof v !== 'boolean') throw new TypeError('isLogScale must be a boolean');
        this._isLogScale = v;
        if (v) {
            const pMin = Math.max(this._f[4], LOG_PRICE_FLOOR);
            this._f[4] = pMin;
            const minSpan = Math.max(LOG_PRICE_FLOOR, pMin * 1e-12);
            this._f[5] = Math.max(this._f[5], pMin + minSpan);
        }
    }

    // --- Navigation & Domain Mutation (Canonical *From + Thin Scalar) ---------

    resizeFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + 2 > buf.length) {
            throw new RangeError('offset out of bounds');
        }
        const width = buf[offset];
        const height = buf[offset + 1];
        if (
            (width - width !== 0) ||
            (height - height !== 0) ||
            !(width >= 0) ||
            !(height >= 0)
        ) {
            throw new RangeError('width and height must be non-negative finite numbers');
        }
        this._f[0] = width;
        this._f[1] = height;
        return this;
    }

    resize(width, height) {
        if (typeof width !== 'number' || typeof height !== 'number') {
            throw new TypeError('width and height must be numbers');
        }
        const s = this._scratch;
        s[0] = width;
        s[1] = height;
        return this.resizeFrom(s, 0);
    }

    get boundViewport() {
        return this._boundViewport;
    }

    syncViewport(canvasViewport) {
        validateCanvasViewport(canvasViewport);
        this._f[0] = canvasViewport.width;
        this._f[1] = canvasViewport.height;
        return this;
    }

    bindViewport(canvasViewport) {
        validateCanvasViewport(canvasViewport);
        if (this._boundViewport !== null) {
            this.unbindViewport();
        }
        this.syncViewport(canvasViewport);
        this._boundViewport = canvasViewport;
        const prev = canvasViewport.onResize;
        this._prevOnResize = prev;
        const hook = (w, h, dpr) => {
            this._f[0] = w;
            this._f[1] = h;
            if (typeof prev === 'function') {
                prev.call(canvasViewport, w, h, dpr);
            }
        };
        this._resizeHook = hook;
        canvasViewport.onResize = hook;
        return this;
    }

    unbindViewport() {
        if (this._boundViewport !== null) {
            if (this._boundViewport.onResize === this._resizeHook) {
                this._boundViewport.onResize = this._prevOnResize;
            }
            this._boundViewport = null;
            this._prevOnResize = null;
            this._resizeHook = null;
        }
        return this;
    }

    fitPriceDomainFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + 2 > buf.length) {
            throw new RangeError('offset out of bounds');
        }
        const minPrice = buf[offset];
        const maxPrice = buf[offset + 1];
        const padRatio = offset + 3 <= buf.length ? buf[offset + 2] : 0;
        if (
            (minPrice - minPrice !== 0) ||
            (maxPrice - maxPrice !== 0) ||
            (padRatio - padRatio !== 0) ||
            !(padRatio >= 0) ||
            !(maxPrice >= minPrice)
        ) {
            throw new RangeError('Price bounds and padRatio must be valid finite numbers with maxPrice >= minPrice');
        }

        const pad = (maxPrice - minPrice) * padRatio;
        let pMin = minPrice - pad;
        const pMax = maxPrice + pad;
        if (this._isLogScale) {
            pMin = Math.max(pMin, LOG_PRICE_FLOOR);
        }
        this._f[4] = pMin;
        if (this._isLogScale || pMax <= pMin) {
            const minSpan = Math.max(LOG_PRICE_FLOOR, Math.abs(pMin) * 1e-12);
            this._f[5] = Math.max(pMax, pMin + minSpan);
        } else {
            this._f[5] = pMax;
        }
        return this;
    }

    fitPriceDomain(minPrice, maxPrice, padRatio = 0) {
        if (typeof minPrice !== 'number' || typeof maxPrice !== 'number' || typeof padRatio !== 'number') {
            throw new TypeError('Price bounds and padRatio must be numbers');
        }
        const s = this._scratch;
        s[0] = minPrice;
        s[1] = maxPrice;
        s[2] = padRatio;
        return this.fitPriceDomainFrom(s, 0);
    }

    setDomainFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + 4 > buf.length) {
            throw new RangeError('offset out of bounds');
        }
        const minTime = buf[offset];
        const maxTime = buf[offset + 1];
        const minPrice = buf[offset + 2];
        const maxPrice = buf[offset + 3];
        if (
            (minTime - minTime !== 0) ||
            (maxTime - maxTime !== 0) ||
            (minPrice - minPrice !== 0) ||
            (maxPrice - maxPrice !== 0) ||
            !(maxTime >= minTime) ||
            !(maxPrice >= minPrice) ||
            (this._isLogScale && !(minPrice > 0))
        ) {
            throw new RangeError('Domain values must be finite numbers with max >= min (minPrice > 0 if log scale)');
        }

        this._f[2] = minTime;
        this._f[3] = Math.max(maxTime, minTime + this._f[8]);
        let pMin = minPrice;
        if (this._isLogScale) {
            pMin = Math.max(pMin, LOG_PRICE_FLOOR);
        }
        this._f[4] = pMin;
        if (this._isLogScale || maxPrice <= pMin) {
            const minSpan = Math.max(LOG_PRICE_FLOOR, Math.abs(pMin) * 1e-12);
            this._f[5] = Math.max(maxPrice, pMin + minSpan);
        } else {
            this._f[5] = maxPrice;
        }
        return this;
    }

    setDomain(minTime, maxTime, minPrice, maxPrice) {
        if (
            typeof minTime !== 'number' ||
            typeof maxTime !== 'number' ||
            typeof minPrice !== 'number' ||
            typeof maxPrice !== 'number'
        ) {
            throw new TypeError('Domain values must be numbers');
        }
        const s = this._scratch;
        s[0] = minTime;
        s[1] = maxTime;
        s[2] = minPrice;
        s[3] = maxPrice;
        return this.setDomainFrom(s, 0);
    }

    centerOnTimeFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + 2 > buf.length) {
            throw new RangeError('offset out of bounds');
        }
        const time = buf[offset];
        const spanMs = buf[offset + 1];
        if (
            (time - time !== 0) ||
            (spanMs - spanMs !== 0) ||
            !(spanMs > 0)
        ) {
            throw new RangeError('time must be finite and spanMs must be positive');
        }

        const halfSpan = Math.max(spanMs, this._f[8]) * 0.5;
        this._f[2] = time - halfSpan;
        this._f[3] = time + halfSpan;
        return this;
    }

    centerOnTime(time, spanMs) {
        if (typeof time !== 'number' || typeof spanMs !== 'number') {
            throw new TypeError('time and spanMs must be numbers');
        }
        const s = this._scratch;
        s[0] = time;
        s[1] = spanMs;
        return this.centerOnTimeFrom(s, 0);
    }

    zoomTimeFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + 2 > buf.length) {
            throw new RangeError('offset out of bounds');
        }
        const zoomFactor = buf[offset];
        const pivotTime = buf[offset + 1];
        if (
            (zoomFactor - zoomFactor !== 0) ||
            (pivotTime - pivotTime !== 0) ||
            !(zoomFactor > 0)
        ) {
            throw new RangeError('zoomFactor must be positive and pivotTime must be finite');
        }

        const factor = Math.min(Math.max(zoomFactor, MIN_ZOOM_FACTOR), MAX_ZOOM_FACTOR);
        const timeSpan = this._f[3] - this._f[2];
        const newTimeSpan = Math.max(timeSpan * factor, this._f[8]);

        const clampedPivot = Math.min(Math.max(pivotTime, this._f[2]), this._f[3]);
        const pivotRatio = timeSpan > 0 ? (clampedPivot - this._f[2]) / timeSpan : 0.5;

        this._f[2] = clampedPivot - (newTimeSpan * pivotRatio);
        this._f[3] = clampedPivot + (newTimeSpan * (1 - pivotRatio));
        return this;
    }

    zoomTime(zoomFactor, pivotTime) {
        if (typeof zoomFactor !== 'number' || typeof pivotTime !== 'number') {
            throw new TypeError('zoomFactor and pivotTime must be numbers');
        }
        const s = this._scratch;
        s[0] = zoomFactor;
        s[1] = pivotTime;
        return this.zoomTimeFrom(s, 0);
    }

    panFrom(buf, offset = 0) {
        if (!(buf instanceof Float64Array)) {
            throw new TypeError('buf must be a Float64Array');
        }
        if ((offset | 0) !== offset || offset < 0 || offset + 1 > buf.length) {
            throw new RangeError('offset out of bounds');
        }
        const deltaTime = buf[offset];
        const deltaPrice = offset + 2 <= buf.length ? buf[offset + 1] : 0;
        if (
            (deltaTime - deltaTime !== 0) ||
            (deltaPrice - deltaPrice !== 0)
        ) {
            throw new RangeError('Pan offsets must be finite numbers');
        }

        const nextMinPrice = this._f[4] + deltaPrice;
        const nextMaxPrice = this._f[5] + deltaPrice;
        if (this._isLogScale && !(nextMinPrice > 0)) {
            throw new RangeError('Panning in log scale cannot shift minPrice <= 0');
        }

        this._f[2] += deltaTime;
        this._f[3] += deltaTime;
        this._f[4] = nextMinPrice;
        this._f[5] = nextMaxPrice;
        return this;
    }

    pan(deltaTime, deltaPrice = 0) {
        if (typeof deltaTime !== 'number' || typeof deltaPrice !== 'number') {
            throw new TypeError('Pan offsets must be numbers');
        }
        const s = this._scratch;
        s[0] = deltaTime;
        s[1] = deltaPrice;
        return this.panFrom(s, 0);
    }

    // --- Coordinate Transforms ------------------------------------------------

    timeToX(time) {
        if (typeof time !== 'number' || (time - time !== 0) || this._f[0] <= 0) {
            return NaN;
        }
        const span = this._f[3] - this._f[2];
        if (span <= 0) return NaN;
        return Math.round(((time - this._f[2]) / span) * this._f[0]);
    }

    xToTime(x) {
        if (typeof x !== 'number' || (x - x !== 0) || this._f[0] <= 0) {
            return NaN;
        }
        return (x / this._f[0]) * (this._f[3] - this._f[2]) + this._f[2];
    }

    priceToY(price) {
        if (typeof price !== 'number' || (price - price !== 0)) {
            return NaN;
        }
        const usableHeight = this._f[1] - this._f[6] - this._f[7];
        if (usableHeight <= 0) return NaN;

        const bottomY = this._f[1] - this._f[7];
        const topY = this._f[6];

        if (this._isLogScale) {
            const logMin = Math.log10(this._f[4]);
            const logMax = Math.log10(this._f[5]);
            const logSpan = logMax - logMin;
            if (logSpan <= 0) return NaN;
            const logPrice = Math.log10(Math.max(price, LOG_PRICE_FLOOR));
            const y = ((logPrice - logMin) / logSpan) * (topY - bottomY) + bottomY;
            return Math.round(y);
        }

        const priceSpan = this._f[5] - this._f[4];
        if (priceSpan <= 0) return NaN;
        const y = ((price - this._f[4]) / priceSpan) * (topY - bottomY) + bottomY;
        return Math.round(y);
    }

    yToPrice(y) {
        if (typeof y !== 'number' || (y - y !== 0)) {
            return NaN;
        }
        const usableHeight = this._f[1] - this._f[6] - this._f[7];
        if (usableHeight <= 0) return NaN;

        const bottomY = this._f[1] - this._f[7];
        const topY = this._f[6];
        const ySpan = topY - bottomY;
        if (ySpan === 0) return NaN;

        if (this._isLogScale) {
            const logMin = Math.log10(this._f[4]);
            const logMax = Math.log10(this._f[5]);
            const logVal = ((y - bottomY) / ySpan) * (logMax - logMin) + logMin;
            return Math.pow(10, logVal);
        }

        return ((y - bottomY) / ySpan) * (this._f[5] - this._f[4]) + this._f[4];
    }

    mapToScreenFrom(inFloat64, inOffset, outFloat64, outOffset = 0) {
        if (!(inFloat64 instanceof Float64Array)) {
            throw new TypeError('inFloat64 must be a Float64Array');
        }
        if ((inOffset | 0) !== inOffset || inOffset < 0 || inOffset + 2 > inFloat64.length) {
            throw new RangeError('inOffset out of bounds');
        }
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + 2 > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }

        const time = inFloat64[inOffset];
        const price = inFloat64[inOffset + 1];

        if ((time - time !== 0) || this._f[0] <= 0) {
            outFloat64[outOffset] = NaN;
        } else {
            const span = this._f[3] - this._f[2];
            outFloat64[outOffset] = span <= 0 ? NaN : Math.round(((time - this._f[2]) / span) * this._f[0]);
        }

        if (price - price !== 0) {
            outFloat64[outOffset + 1] = NaN;
        } else {
            const usableHeight = this._f[1] - this._f[6] - this._f[7];
            if (usableHeight <= 0) {
                outFloat64[outOffset + 1] = NaN;
            } else {
                const bottomY = this._f[1] - this._f[7];
                const topY = this._f[6];
                if (this._isLogScale) {
                    const logMin = Math.log10(this._f[4]);
                    const logMax = Math.log10(this._f[5]);
                    const logSpan = logMax - logMin;
                    if (logSpan <= 0) {
                        outFloat64[outOffset + 1] = NaN;
                    } else {
                        const logPrice = Math.log10(Math.max(price, LOG_PRICE_FLOOR));
                        const y = ((logPrice - logMin) / logSpan) * (topY - bottomY) + bottomY;
                        outFloat64[outOffset + 1] = Math.round(y);
                    }
                } else {
                    const priceSpan = this._f[5] - this._f[4];
                    if (priceSpan <= 0) {
                        outFloat64[outOffset + 1] = NaN;
                    } else {
                        const y = ((price - this._f[4]) / priceSpan) * (topY - bottomY) + bottomY;
                        outFloat64[outOffset + 1] = Math.round(y);
                    }
                }
            }
        }
        return outFloat64;
    }

    mapToScreenInto(time, price, outFloat64, outOffset = 0) {
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + 2 > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }
        const s = this._scratch;
        s[0] = typeof time === 'number' ? time : NaN;
        s[1] = typeof price === 'number' ? price : NaN;
        return this.mapToScreenFrom(s, 0, outFloat64, outOffset);
    }

    mapToDomainFrom(inFloat64, inOffset, outFloat64, outOffset = 0) {
        if (!(inFloat64 instanceof Float64Array)) {
            throw new TypeError('inFloat64 must be a Float64Array');
        }
        if ((inOffset | 0) !== inOffset || inOffset < 0 || inOffset + 2 > inFloat64.length) {
            throw new RangeError('inOffset out of bounds');
        }
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + 2 > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }

        const x = inFloat64[inOffset];
        const y = inFloat64[inOffset + 1];

        if ((x - x !== 0) || this._f[0] <= 0) {
            outFloat64[outOffset] = NaN;
        } else {
            outFloat64[outOffset] = (x / this._f[0]) * (this._f[3] - this._f[2]) + this._f[2];
        }

        if (y - y !== 0) {
            outFloat64[outOffset + 1] = NaN;
        } else {
            const usableHeight = this._f[1] - this._f[6] - this._f[7];
            if (usableHeight <= 0) {
                outFloat64[outOffset + 1] = NaN;
            } else {
                const bottomY = this._f[1] - this._f[7];
                const topY = this._f[6];
                const ySpan = topY - bottomY;
                if (ySpan === 0) {
                    outFloat64[outOffset + 1] = NaN;
                } else if (this._isLogScale) {
                    const logMin = Math.log10(this._f[4]);
                    const logMax = Math.log10(this._f[5]);
                    const logVal = ((y - bottomY) / ySpan) * (logMax - logMin) + logMin;
                    outFloat64[outOffset + 1] = Math.pow(10, logVal);
                } else {
                    outFloat64[outOffset + 1] = ((y - bottomY) / ySpan) * (this._f[5] - this._f[4]) + this._f[4];
                }
            }
        }
        return outFloat64;
    }

    mapToDomainInto(x, y, outFloat64, outOffset = 0) {
        if (!(outFloat64 instanceof Float64Array)) {
            throw new TypeError('outFloat64 must be a Float64Array');
        }
        if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + 2 > outFloat64.length) {
            throw new RangeError('outOffset out of bounds');
        }
        const s = this._scratch;
        s[0] = typeof x === 'number' ? x : NaN;
        s[1] = typeof y === 'number' ? y : NaN;
        return this.mapToDomainFrom(s, 0, outFloat64, outOffset);
    }
}

export function createViewport(options) {
    return new TimeSeriesViewport(options);
}

// --- Spatial Hit-Testing (Single Canonical Zero-Box Implementation) -----------

function writeHitMiss(outFloat64, outOffset) {
    outFloat64[outOffset] = -1;
    outFloat64[outOffset + 1] = -1;
    for (let i = 2; i < HIT_STRIDE; i++) {
        outFloat64[outOffset + i] = NaN;
    }
    return 0;
}

export function hitTestFrom(series, viewport, inFloat64, inOffset, outFloat64, outOffset = 0) {
    if (!(series instanceof LiteTimeSeries)) {
        throw new TypeError('series must be an instance of LiteTimeSeries');
    }
    if (!(viewport instanceof TimeSeriesViewport)) {
        throw new TypeError('viewport must be an instance of TimeSeriesViewport');
    }
    if (!(inFloat64 instanceof Float64Array)) {
        throw new TypeError('inFloat64 must be a Float64Array');
    }
    if ((inOffset | 0) !== inOffset || inOffset < 0 || inOffset + 3 > inFloat64.length) {
        throw new RangeError('inOffset out of bounds');
    }
    if (!(outFloat64 instanceof Float64Array)) {
        throw new TypeError('outFloat64 must be a Float64Array');
    }
    if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + HIT_STRIDE > outFloat64.length) {
        throw new RangeError('outOffset out of bounds');
    }

    const mouseX = inFloat64[inOffset];
    const mouseY = inFloat64[inOffset + 1];
    const maxSnapDistance = inFloat64[inOffset + 2];

    const width = viewport._f[0];
    const count = series._istate[1];
    const vMinTime = viewport._f[2];
    const vMaxTime = viewport._f[3];
    const timeSpan = vMaxTime - vMinTime;

    if (
        (mouseX - mouseX !== 0) ||
        (mouseY - mouseY !== 0) ||
        (maxSnapDistance - maxSnapDistance !== 0) ||
        !(maxSnapDistance >= 0) ||
        !(width > 0) ||
        !(timeSpan > 0) ||
        count === 0
    ) {
        return writeHitMiss(outFloat64, outOffset);
    }

    let targetTime = (mouseX / width) * timeSpan + vMinTime;
    if (targetTime !== targetTime) {
        return writeHitMiss(outFloat64, outOffset);
    }

    if (targetTime < vMinTime) targetTime = vMinTime;
    else if (targetTime > vMaxTime) targetTime = vMaxTime;

    series._scratch[0] = targetTime;
    const logIdx = series.findClosestLogicalIndexFrom(series._scratch, 0);
    if (logIdx === -1) {
        return writeHitMiss(outFloat64, outOffset);
    }

    const head = series._istate[0];
    const cap = series.capacity;
    const mask = series.mask;
    const physIdx = count < cap ? logIdx : ((head + logIdx) & mask);

    const time = series.time[physIdx];
    const snappedX = Math.round(((time - vMinTime) / timeSpan) * width);

    if (snappedX !== snappedX || Math.abs(snappedX - mouseX) > maxSnapDistance) {
        return writeHitMiss(outFloat64, outOffset);
    }

    const open = series.open[physIdx];
    const high = series.high[physIdx];
    const low = series.low[physIdx];
    const close = series.close[physIdx];
    const volume = series.volume[physIdx];

    const usableHeight = viewport._f[1] - viewport._f[6] - viewport._f[7];
    let yOpen = NaN;
    let yHigh = NaN;
    let yLow = NaN;
    let yClose = NaN;

    if (usableHeight > 0) {
        const bottomY = viewport._f[1] - viewport._f[7];
        const topY = viewport._f[6];
        const yDist = topY - bottomY;

        if (viewport._isLogScale) {
            const logMin = Math.log10(viewport._f[4]);
            const logMax = Math.log10(viewport._f[5]);
            const logSpan = logMax - logMin;
            if (logSpan > 0) {
                const invLogSpan = yDist / logSpan;
                yOpen = Math.round(((Math.log10(Math.max(open, LOG_PRICE_FLOOR)) - logMin) * invLogSpan) + bottomY);
                yHigh = Math.round(((Math.log10(Math.max(high, LOG_PRICE_FLOOR)) - logMin) * invLogSpan) + bottomY);
                yLow = Math.round(((Math.log10(Math.max(low, LOG_PRICE_FLOOR)) - logMin) * invLogSpan) + bottomY);
                yClose = Math.round(((Math.log10(Math.max(close, LOG_PRICE_FLOOR)) - logMin) * invLogSpan) + bottomY);
            }
        } else {
            const priceSpan = viewport._f[5] - viewport._f[4];
            if (priceSpan > 0) {
                const invPriceSpan = yDist / priceSpan;
                yOpen = Math.round(((open - viewport._f[4]) * invPriceSpan) + bottomY);
                yHigh = Math.round(((high - viewport._f[4]) * invPriceSpan) + bottomY);
                yLow = Math.round(((low - viewport._f[4]) * invPriceSpan) + bottomY);
                yClose = Math.round(((close - viewport._f[4]) * invPriceSpan) + bottomY);
            }
        }
    }

    let nearestY = yOpen;
    let minDiff = Math.abs(mouseY - yOpen);
    let diff = Math.abs(mouseY - yClose);
    if (diff < minDiff) { minDiff = diff; nearestY = yClose; }
    diff = Math.abs(mouseY - yHigh);
    if (diff < minDiff) { minDiff = diff; nearestY = yHigh; }
    diff = Math.abs(mouseY - yLow);
    if (diff < minDiff) { minDiff = diff; nearestY = yLow; }

    outFloat64[outOffset] = logIdx;
    outFloat64[outOffset + 1] = physIdx;
    outFloat64[outOffset + 2] = time;
    outFloat64[outOffset + 3] = open;
    outFloat64[outOffset + 4] = high;
    outFloat64[outOffset + 5] = low;
    outFloat64[outOffset + 6] = close;
    outFloat64[outOffset + 7] = volume;
    outFloat64[outOffset + 8] = snappedX;
    outFloat64[outOffset + 9] = nearestY;
    outFloat64[outOffset + 10] = yOpen;
    outFloat64[outOffset + 11] = yHigh;
    outFloat64[outOffset + 12] = yLow;
    outFloat64[outOffset + 13] = yClose;

    return 1;
}

export function hitTestInto(series, viewport, mouseX, mouseY, maxSnapDistance, outFloat64, outOffset = 0) {
    if (!(series instanceof LiteTimeSeries)) {
        throw new TypeError('series must be an instance of LiteTimeSeries');
    }
    if (!(viewport instanceof TimeSeriesViewport)) {
        throw new TypeError('viewport must be an instance of TimeSeriesViewport');
    }
    if (!(outFloat64 instanceof Float64Array)) {
        throw new TypeError('outFloat64 must be a Float64Array');
    }
    if ((outOffset | 0) !== outOffset || outOffset < 0 || outOffset + HIT_STRIDE > outFloat64.length) {
        throw new RangeError('outOffset out of bounds');
    }
    const s = series._scratch;
    s[0] = typeof mouseX === 'number' ? mouseX : NaN;
    s[1] = typeof mouseY === 'number' ? mouseY : NaN;
    s[2] = typeof maxSnapDistance === 'number' ? maxSnapDistance : NaN;
    return hitTestFrom(series, viewport, s, 0, outFloat64, outOffset);
}

// --- TimeSeriesPool -----------------------------------------------------------

function validatePoolKey(key) {
    if (key === undefined || key === null || (typeof key === 'number' && key !== key)) {
        throw new TypeError('TimeSeriesPool: key must not be null, undefined, or NaN');
    }
}

export class TimeSeriesPool {
    constructor(options) {
        validateOptions(options, POOL_ALLOWED_KEYS, 'TimeSeriesPool');

        let maxSeries = DEFAULT_POOL_MAX_SERIES;
        let seriesCapacity = DEFAULT_CAPACITY;
        let userOnEvict = null;

        if (options !== undefined) {
            if (options.maxSeries !== undefined) {
                const m = options.maxSeries;
                if (typeof m !== 'number') {
                    throw new TypeError('Option "maxSeries" must be a number');
                }
                if (!Number.isInteger(m) || m < 1 || m > 65536) {
                    throw new RangeError('Option "maxSeries" must be an integer between 1 and 65536');
                }
                maxSeries = m;
            }

            if (options.seriesCapacity !== undefined) {
                const c = options.seriesCapacity;
                if (typeof c !== 'number') {
                    throw new TypeError('Option "seriesCapacity" must be a number');
                }
                if (!Number.isInteger(c) || c < MIN_CAPACITY || c > MAX_CAPACITY || (c & (c - 1)) !== 0) {
                    throw new RangeError(
                        `Option "seriesCapacity" must be an integer power of 2 between ${MIN_CAPACITY} and ${MAX_CAPACITY}`
                    );
                }
                seriesCapacity = c;
            }

            if (options.onEvict !== undefined) {
                if (typeof options.onEvict !== 'function') {
                    throw new TypeError('Option "onEvict" must be a function');
                }
                userOnEvict = options.onEvict;
            }
        }

        this._maxSeries = maxSeries;
        this._seriesCapacity = seriesCapacity;
        this._userOnEvict = userOnEvict;

        this._allocated = [];
        this._freeList = [];

        this._cache = new Sieve(maxSeries, {
            onEvict: (evictedKey, evictedSeries) => {
                try {
                    if (this._userOnEvict !== null) {
                        this._userOnEvict(evictedKey, evictedSeries);
                    }
                } finally {
                    evictedSeries.clear();
                    this._freeList.push(evictedSeries);
                }
            }
        });
    }

    get size() { return this._cache.size; }
    get maxSeries() { return this._maxSeries; }
    get seriesCapacity() { return this._seriesCapacity; }
    get freeCount() { return this._freeList.length; }
    get totalAllocated() { return this._allocated.length; }
    get [Symbol.toStringTag]() { return 'TimeSeriesPool'; }

    acquire(key) {
        validatePoolKey(key);
        const existing = this._cache.get(key);
        if (existing !== undefined) {
            return existing;
        }
        let series;
        if (this._freeList.length > 0) {
            series = this._freeList.pop();
            series.clear();
        } else {
            series = new LiteTimeSeries({ capacity: this._seriesCapacity });
            this._allocated.push(series);
        }
        this._cache.put(key, series);
        return series;
    }

    getOrCreate(key) {
        return this.acquire(key);
    }

    get(key) {
        validatePoolKey(key);
        return this._cache.get(key);
    }

    peek(key) {
        validatePoolKey(key);
        return this._cache.peek(key);
    }

    has(key) {
        validatePoolKey(key);
        return this._cache.has(key);
    }

    delete(key) {
        validatePoolKey(key);
        const series = this._cache.peek(key);
        if (series === undefined) {
            return false;
        }
        this._cache.delete(key);
        series.clear();
        this._freeList.push(series);
        return true;
    }

    clear() {
        this._cache.clear();
        this._freeList.length = 0;
        const allocated = this._allocated;
        for (let i = 0; i < allocated.length; i++) {
            const s = allocated[i];
            s.clear();
            this._freeList.push(s);
        }
        return this;
    }

    keys() {
        return this._cache.keys();
    }

    values() {
        return this._cache.values();
    }

    entries() {
        return this._cache.entries();
    }

    [Symbol.iterator]() {
        return this._cache.entries();
    }
}

export function createTimeSeriesPool(options) {
    return new TimeSeriesPool(options);
}

