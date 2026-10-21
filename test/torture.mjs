// test/torture.mjs -- A14 (+ the A13 zero-GC window). DETERMINISTIC tier, no timing thresholds.
// Run: node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 test/torture.mjs
// Prints PASS / FAIL per check; exit code 1 on any FAIL. Real libraries only:
//   @zakkster/lite-leak (retention: tracker.size() must return to 0)
//   @zakkster/lite-gc-profiler (budget: maxMajor 0 / maxMinor 0 over the hot window)
import { setTimeout as sleep } from 'node:timers/promises';
import { GcProfiler, assertNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { OhlcSeries } from '../Ohlc.js';

const EPOCH_BASE = 1700000000123.5; // fractional epoch ms
const CAP = 65536;
const CYCLES = 1000;
let failed = 0;
const gate = { size: -1, findings: -1, warnings: 0, major: -1, minor: -1, maxMs: 0 }; // filled by the checks below

function report(name, ok, detail) {
    if (!ok) failed++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''));
}

async function check(name, fn) {
    try {
        const detail = await fn();
        report(name, true, detail);
    } catch (e) {
        report(name, false, e && e.message ? e.message : String(e));
    }
}

// Fail closed: a torture run without gc() or the pinned 4 MB semi-space proves nothing.
const execArgs = process.execArgv.join(' ');
if (typeof globalThis.gc !== 'function'
    || !/--min-semi-space-size=4\b/.test(execArgs) || !/--max-semi-space-size=4\b/.test(execArgs)) {
    console.log('FAIL harness -- run: node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 test/torture.mjs');
    process.exit(1);
}

// FinalizationRegistry callbacks run on later macrotasks: collect, then yield, three times.
async function collect() {
    for (let k = 0; k < 3; k++) {
        globalThis.gc();
        await sleep(50);
    }
}

// ---- A14 phase 1: retention (lite-leak) -------------------------------------------------------
// The cleanup closure and the tag must NOT close over the target (lite-leak held-value contract).
// No kernels are registered: Ohlc owns no timers, listeners or observers, so size() is the oracle.
await check('A14 retention: 1000 cycles, size() === 0 and audit() empty after gc x3', async () => {
    const tracker = createLeakTracker({ name: 'ohlc-torture', onWarning: () => { gate.warnings++; } });
    const b = new Float64Array(6);
    const out = new Float64Array(9);
    let cleaned = 0;
    for (let c = 0; c < CYCLES; c++) {
        const s = new OhlcSeries(1024, 60000);
        tracker.track(s, () => { cleaned++; }, 'ohlc:' + c);
        for (let k = 0; k < 2048; k++) {
            b[0] = EPOCH_BASE + k * 60000;
            b[1] = 10.5; b[2] = 20.25; b[3] = 5.75; b[4] = 15.5; b[5] = 100.5;
            s.appendBarFrom(b, 0);
            if ((k & 63) === 63) s.boundsInto(0, s.count - 1, out, 0);
            if (k >= 1948) s.setLive(EPOCH_BASE + (k + 1) * 60000, 10.5, 20.25, 5.75, 15.5, 100.5);
        }
        s.boundsInto(0, s.count - 1, out, 0);
        const dec = new Float64Array(7 * 16);
        s.decimateInto(0, s.count - 1, 16, dec, 0); // tree path (n = 1024 >= 16*10)
        s.decimateInto(0, 99, 16, dec, 0);          // scan path (n = 100 < 160)
    }
    const before = tracker.size();
    await collect();
    const size = tracker.size();
    const findings = tracker.audit();
    gate.size = size;
    gate.findings = findings.length;
    if (size !== 0) throw new Error('size() = ' + size + ' after gc x3 (was ' + before + ' before), cleaned=' + cleaned);
    if (findings.length !== 0) throw new Error('audit() has ' + findings.length + ' finding(s)');
    return 'size 0, audit empty, cleaned=' + cleaned;
});

// Must-fail control: one retained target must read size() === 1 (the oracle can see a leak).
await check('A14 control: one retained series -> size() === 1', async () => {
    const tracker = createLeakTracker({ name: 'ohlc-control' });
    const retained = new OhlcSeries(1024, 60000);
    tracker.track(retained, () => {}, 'retained');
    for (let c = 0; c < 50; c++) tracker.track(new OhlcSeries(1024, 60000), () => {}, 'dropped:' + c);
    await collect();
    const size = tracker.size();
    if (size !== 1) throw new Error('expected size() === 1, got ' + size);
    if (retained.count !== 0) throw new Error('retained series must stay alive and empty');
    return 'size 1';
});

// ---- A13 zero-GC window (lite-gc-profiler) ----------------------------------------------------
await check('A13 gc: 1e6 setLiveFrom + 1e5 appendBarFrom + 1e5 boundsInto + 1e5 decimateInto -> maxMajor 0, maxMinor 0', async () => {
    const s = new OhlcSeries(CAP, 1000);
    const b = new Float64Array([0, 10.5, 20.25, 5.75, 15.5, 100.5]);
    for (let k = 0; k < CAP; k++) { b[0] = EPOCH_BASE + k * 1000; s.appendBarFrom(b, 0); }
    b[0] = EPOCH_BASE + CAP * 1000;
    const out = new Float64Array(9);
    const dec = new Float64Array(7 * 1000);

    function run(nLive, nApp, nBounds, nDec) {
        // ring is full (wrapped); appends move base; the live bar is open when the bounds loop runs
        for (let i = 0; i < nApp; i++) { b[0] += 1000; s.appendBarFrom(b, 0); }
        b[0] += 1000;
        for (let i = 0; i < nLive; i++) { b[4] = 15.5 + (i & 3) * 0.25; s.setLiveFrom(b, 0); }
        for (let i = 0; i < nBounds; i++) {
            const i0 = (i * 31) & 16383;
            if ((i & 1) === 0) s.boundsInto(i0, i0 + 1000, out, 0);
            else s.boundsInto(CAP - 2001 - i0, CAP - 1, out, 0); // ends at the live bar
        }
        // A13: 1e5 decimateInto(B=1000) per 1e5 bounds; H = 16 so B*H = 16000: n=5000 scan, n=40000 tree
        for (let i = 0; i < nDec; i++) {
            const n = (i & 1) === 0 ? 5000 : 40000;
            s.decimateInto(CAP - n, CAP - 1, 1000, dec, 0); // ends at the live bar
        }
    }
    run(200000, 20000, 20000, 2000); // warmup, outside the window
    globalThis.gc();

    const prof = new GcProfiler().start();
    run(1000000, 100000, 100000, 100000);
    await prof.settle();
    const summary = prof.summary();
    prof.stop();
    gate.major = summary.gc.major;
    gate.minor = summary.gc.minor;
    gate.maxMs = summary.gc.maxMs;
    assertNoGc(summary, { maxMajor: 0, maxMinor: 0 });
    return 'major ' + summary.gc.major + ', minor ' + summary.gc.minor;
});

console.log('GATE leak=size ' + gate.size + '/0 findings=' + gate.findings + ' warnings=' + gate.warnings +
    ' | gc major=' + gate.major + ' minor=' + gate.minor + ' maxMs=' + Number(gate.maxMs).toFixed(2) +
    ' | ' + (failed === 0 ? 'ok' : 'FAIL'));
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);
