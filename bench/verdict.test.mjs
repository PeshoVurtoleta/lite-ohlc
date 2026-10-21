// Oracle for bench/verdict.mjs, written from .handoff/PLAN-bench.md (SPEC + A2) only.
// Median = element (len-1)>>1 of a sorted copy: for K=21 that is sorted index 10.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR, clears, verdict } from './verdict.mjs';

// 21 ratios: first = mn, other 20 = m. Sorted index 10 is m (mn <= m), min is mn.
const mk = (m, mn = m, len = 21) => { const a = new Array(len).fill(m); a[0] = mn; return a; };
const row = (o = {}) => ({ op: 'bounds', baseline: 'best', n: 1e6, ratios: mk(12, 6), ...o });
const base = (o = {}) => ({
  crossOk: true, probeOk: true,
  rows: [row()],
  controls: [{ ratios: mk(1.0) }, { ratios: mk(1.1, 0.9) }],
  positive: { ratios: mk(12) },
  maxLoad: 1.0, busyNode: false,
  ...o,
});
const inc = (o) => verdict(base(o));

test('BAR values pinned and frozen', () => {
  assert.deepEqual({ ...BAR }, { MEDIAN: 10, ROUND: 5, N_MIN: 1e5, K: 21, CTRL_LO: 0.8, CTRL_HI: 1.25, LOAD_MAX: 4.0, BUSY_PCPU: 10 });
  assert.ok(Object.isFrozen(BAR));
});

test('passing fixture -> MET exit 0 with hit', () => {
  const r = verdict(base());
  assert.equal(r.v, 'MET'); assert.equal(r.exit, 0);
  assert.equal(r.hit.length, 1);
});

test('median 10 passes, 9.99 fails', () => {
  assert.equal(clears(mk(10, 10)), true);
  assert.equal(clears(mk(9.99, 9.99)), false);
  assert.equal(inc({ rows: [row({ ratios: mk(10, 5) })] }).v, 'MET');
  assert.equal(inc({ rows: [row({ ratios: mk(9.99, 5) })] }).v, 'MISSED');
});

test('round min 5 passes, 4.99 fails', () => {
  assert.equal(clears(mk(12, 5)), true);
  assert.equal(clears(mk(12, 4.99)), false);
  assert.equal(inc({ rows: [row({ ratios: mk(12, 4.99) })] }).v, 'MISSED');
});

test('K: 21 ratios ok, 20 and 22 fail', () => {
  assert.equal(clears(mk(12, 6, 21)), true);
  assert.equal(clears(mk(12, 6, 20)), false);
  assert.equal(clears(mk(12, 6, 22)), false);
  assert.equal(inc({ rows: [row({ ratios: mk(12, 6, 20) })] }).v, 'MISSED');
});

test('n 1e5 passes, 1e4 fails', () => {
  assert.equal(inc({ rows: [row({ n: 1e5 })] }).v, 'MET');
  assert.equal(inc({ rows: [row({ n: 1e4 })] }).v, 'MISSED');
});

test('baseline must be best: idiomatic fails', () => {
  assert.equal(inc({ rows: [row({ baseline: 'idiomatic' })] }).v, 'MISSED');
});

test('op: decimate passes, setLive fails', () => {
  assert.equal(inc({ rows: [row({ op: 'decimate' })] }).v, 'MET');
  assert.equal(inc({ rows: [row({ op: 'setLive' })] }).v, 'MISSED');
});

test('MISSED when no row hits (empty rows) exit 0, no hit', () => {
  const r = inc({ rows: [] });
  assert.equal(r.v, 'MISSED'); assert.equal(r.exit, 0); assert.equal(r.hit, undefined);
});

test('hit lists only clearing eligible rows', () => {
  const good = row({ op: 'decimate' });
  const r = inc({ rows: [good, row({ n: 1e4 }), row({ ratios: mk(9, 9) })] });
  assert.equal(r.v, 'MET'); assert.deepEqual(r.hit, [good]);
});

test('control median bounds: 1.25 and 0.8 ok; 1.26 and 0.79 INCONCLUSIVE', () => {
  assert.equal(inc({ controls: [{ ratios: mk(1.25) }] }).v, 'MET');
  assert.equal(inc({ controls: [{ ratios: mk(0.8) }] }).v, 'MET');
  for (const m of [1.26, 0.79]) {
    const r = inc({ controls: [{ ratios: mk(m) }] });
    assert.equal(r.v, 'INCONCLUSIVE'); assert.equal(r.exit, 2);
  }
});

test('one bad control among good ones -> INCONCLUSIVE', () => {
  const r = inc({ controls: [{ ratios: mk(1.0) }, { ratios: mk(1.26) }, { ratios: mk(1.0) }] });
  assert.equal(r.v, 'INCONCLUSIVE'); assert.equal(r.exit, 2);
});

test('a control that itself clears -> INCONCLUSIVE', () => {
  const r = inc({ controls: [{ ratios: mk(12, 6) }] });
  assert.equal(r.v, 'INCONCLUSIVE'); assert.equal(r.exit, 2);
});

test('positive control: 10 ok, 9.9 INCONCLUSIVE', () => {
  assert.equal(inc({ positive: { ratios: mk(10, 5) } }).v, 'MET');
  const r = inc({ positive: { ratios: mk(9.9, 9.9) } });
  assert.equal(r.v, 'INCONCLUSIVE'); assert.equal(r.exit, 2);
});

test('maxLoad 4.0 ok, 4.01 INCONCLUSIVE', () => {
  assert.equal(inc({ maxLoad: 4.0 }).v, 'MET');
  const r = inc({ maxLoad: 4.01 });
  assert.equal(r.v, 'INCONCLUSIVE'); assert.equal(r.exit, 2);
});

test('busyNode true -> INCONCLUSIVE', () => {
  const r = inc({ busyNode: true });
  assert.equal(r.v, 'INCONCLUSIVE'); assert.equal(r.exit, 2);
});

test('crossOk false / probeOk false -> ABORT exit 1', () => {
  for (const o of [{ crossOk: false }, { probeOk: false }]) {
    const r = inc(o);
    assert.equal(r.v, 'ABORT'); assert.equal(r.exit, 1);
  }
});

test('ABORT takes precedence over INCONCLUSIVE', () => {
  const r = inc({ crossOk: false, maxLoad: 99, busyNode: true, positive: { ratios: mk(1) } });
  assert.equal(r.v, 'ABORT'); assert.equal(r.exit, 1);
});

test('INCONCLUSIVE takes precedence over MET/MISSED', () => {
  assert.equal(inc({ busyNode: true, rows: [] }).v, 'INCONCLUSIVE');
});

test('median is the lower median of a sorted copy; clears() does not mutate', () => {
  // unsorted input; its sorted index 10 is 15 (>= 10) and min is 5 -> clears; an in-place sort would reorder it.
  const r = [30, 5, 12, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const copy = r.slice();
  assert.equal(clears(r), true);
  assert.deepEqual(r, copy);
  // guard against an upper/max pick:
  // 20 values of 9 and one 100 -> median 9 -> no clear (a max/upper pick would clear).
  const r2 = mk(9, 9); r2[20] = 100;
  assert.equal(clears(r2), false);
  const r3 = mk(10, 10); r3[0] = 1; r3[1] = 1; // 2 low, median still 10, min 1 -> fails on min
  assert.equal(clears(r3), false);
});

test('median sorts numerically before indexing', () => {
  // Unsorted 50 at index 10: numeric median is 9 -> no clear (no-sort would read 50).
  const u = mk(9, 9); u[10] = 50;
  assert.equal(clears(u), false);
  // Numeric sorted index 10 is 80 -> clears; default string sort would put 7 there (100 < 7 < 80).
  const lx = [...new Array(10).fill(7), ...new Array(6).fill(80), ...new Array(5).fill(100)];
  assert.equal(clears(lx), true);
});

test('even-length control uses the lower median (index (len-1)>>1)', () => {
  // 20 values: ten 0.5 then ten 1.0 -> lower median 0.5 < CTRL_LO -> INCONCLUSIVE.
  const ratios = [...new Array(10).fill(0.5), ...new Array(10).fill(1.0)];
  const r = inc({ controls: [{ ratios }] });
  assert.equal(r.v, 'INCONCLUSIVE'); assert.equal(r.exit, 2);
  // ten 1.0 then ten 1.5 -> lower median 1.0 is in band -> MET.
  const ok = [...new Array(10).fill(1.0), ...new Array(10).fill(1.5)];
  assert.equal(inc({ controls: [{ ratios: ok }] }).v, 'MET');
});
