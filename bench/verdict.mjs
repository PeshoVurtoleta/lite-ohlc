export const BAR = Object.freeze({ MEDIAN: 10, ROUND: 5, N_MIN: 1e5, K: 21, CTRL_LO: 0.8, CTRL_HI: 1.25, LOAD_MAX: 4.0, BUSY_PCPU: 10 });
const med = (r) => r.slice().sort((a, b) => a - b)[(r.length - 1) >> 1];
export function clears(r) { return r.length === BAR.K && med(r) >= BAR.MEDIAN && Math.min(...r) >= BAR.ROUND; }
export function verdict({ crossOk, probeOk, rows, controls, positive, maxLoad, busyNode }) {
  if (!crossOk || !probeOk) return { v: 'ABORT', exit: 1 };
  const ctrlOk = controls.every((c) => { const m = med(c.ratios); return m >= BAR.CTRL_LO && m <= BAR.CTRL_HI && !clears(c.ratios); }) && clears(positive.ratios);
  if (!ctrlOk || maxLoad > BAR.LOAD_MAX || busyNode) return { v: 'INCONCLUSIVE', exit: 2 };
  const hit = rows.filter((r) => (r.op === 'bounds' || r.op === 'decimate') && r.baseline === 'best' && r.n >= BAR.N_MIN && clears(r.ratios));
  return hit.length ? { v: 'MET', exit: 0, hit } : { v: 'MISSED', exit: 0 };
}
