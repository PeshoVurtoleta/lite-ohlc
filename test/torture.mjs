// test/torture.mjs -- node --expose-gc test/torture.mjs
import { PerformanceObserver } from 'node:perf_hooks';
import {
    createTimeSeries,
    createViewport,
    createTimeSeriesPool,
    hitTestFrom,
    BOUNDS_STRIDE,
    BUCKET_STRIDE,
    HIT_STRIDE
} from '../Ohlc.js';

// Minimal zero-dependency retention tracker conforming to lite-leak semantics
function createTracker() {
    let size = 0;
    const findings = [];
    const registry = new FinalizationRegistry((held) => {
        size--;
    });

    return {
        track(target, tag) {
            size++;
            registry.register(target, tag);
        },
        size() {
            return size;
        },
        audit() {
            return findings;
        }
    };
}

// Minimal zero-dependency GC profiler conforming to lite-gc-profiler semantics
class GcProfiler {
    constructor() {
        this.major = 0;
        this.minor = 0;
        this.maxMs = 0;
        this.obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const dur = entry.duration;
                if (dur > this.maxMs) this.maxMs = dur;
                // Kind 1 = Scavenge (minor), Kind 2 = Mark-sweep-compact (major)
                const detail = entry.detail;
                if (detail && detail.kind === 2) {
                    this.major++;
                } else {
                    this.minor++;
                }
            }
        });
    }

    start() {
        this.obs.observe({ entryTypes: ['gc'] });
        return this;
    }

    stop() {
        this.obs.disconnect();
    }

    summary() {
        return {
            gc: {
                major: this.major,
                minor: this.minor,
                maxMs: this.maxMs
            }
        };
    }
}

function checkNoGc(summary, limits = { maxMajor: 0, maxPauseMs: 4 }) {
    const violations = [];
    if (summary.gc.major > limits.maxMajor) {
        violations.push({ metric: 'major', limit: limits.maxMajor, actual: summary.gc.major });
    }
    if (summary.gc.maxMs > limits.maxPauseMs) {
        violations.push({ metric: 'maxMs', limit: limits.maxPauseMs, actual: summary.gc.maxMs });
    }
    return {
        ok: violations.length === 0,
        violations
    };
}

const CYCLES = 4096;
const HOT = 200000;
const leaks = [];
const warns = [];

const tracker = createTracker();

// ---- phase 1: retention torture ------------------------------------------
for (let i = 0; i < CYCLES; i++) {
    let ts = createTimeSeries({ capacity: 16 });
    let vp = createViewport();
    let canvasVp = {
        width: 800,
        height: 600,
        dpr: 1,
        onResize: () => {}
    };
    vp.bindViewport(canvasVp);
    vp.unbindViewport();

    let pool = createTimeSeriesPool({ maxSeries: 4, seriesCapacity: 16 });
    pool.acquire('k1');
    pool.acquire('k2');
    pool.acquire('k3');
    pool.acquire('k4');
    pool.acquire('k5');
    pool.delete('k2');

    tracker.track(ts, 'series_' + i);
    tracker.track(vp, 'viewport_' + i);
    tracker.track(canvasVp, 'canvas_vp_' + i);
    tracker.track(pool, 'pool_' + i);
    ts = null;
    vp = null;
    canvasVp = null;
    pool = null;
}

globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));

const live = tracker.size();
const findings = tracker.audit();

// ---- phase 2: allocation + GC torture ------------------------------------
const gc = new GcProfiler().start();

// Steady-state instances allocated OUTSIDE the loop, stepped inside
const inst = createTimeSeries({ capacity: 1024 });
inst.append(1000, 10, 20, 5, 15, 100);

const vp = createViewport({
    width: 800,
    height: 400,
    minTime: 1000,
    maxTime: 6000,
    minPrice: 0,
    maxPrice: 50
});

const inBuf = new Float64Array([1000, 12.5, 22.5, 6.5, 18.5, 200]);
const rangeBuf = new Float64Array([1000, 2000]);
const outBounds = new Float64Array(BOUNDS_STRIDE);
const outBuckets = new Float64Array(4 * BUCKET_STRIDE);
const inHit = new Float64Array([400, 200, 20]);
const outHit = new Float64Array(HIT_STRIDE);

const steadyPool = createTimeSeriesPool({ maxSeries: 8, seriesCapacity: 64 });
const steadySymbols = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
for (let i = 0; i < 8; i++) steadyPool.acquire(steadySymbols[i]);
let lastVersion = -1;

for (let i = 0; i < HOT; i++) {
    inst.updateLatestFrom(inBuf, 0);
    inst.computeBoundsFrom(rangeBuf, 0, outBounds, 0);
    inst.decimateFrom(rangeBuf, 0, 4, outBuckets, 0);
    hitTestFrom(inst, vp, inHit, 0, outHit, 0);

    const s = steadyPool.acquire(steadySymbols[i & 7]);
    if (s.version === lastVersion) {
        lastVersion = s.version;
    }
}

await new Promise((r) => setTimeout(r, 50));
const s = gc.summary();
const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
gc.stop();

const ok = report.ok && live === 0 && leaks.length === 0 && findings.length === 0;
console.log(
    'GATE leak=size ' + live + '/0 findings=' + findings.length +
    ' warnings=' + warns.length +
    ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
    ' maxMs=' + s.gc.maxMs.toFixed(2) +
    ' | alloc=0 B/op | ' + (ok ? 'ok' : 'FAIL')
);
if (!ok) {
    for (const v of report.violations) {
        console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
    }
    for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
    for (const l of leaks) console.error('  leak ' + l);
    process.exitCode = 1;
}
