export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function roundTo(n, digits = 2) {
  if (!Number.isFinite(n)) return n;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

export function finiteNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Piecewise-linear interpolation. `points` is [[x,y], ...] sorted by x. Clamps to ends. */
export function interpolatePoints(points, x) {
  if (!points?.length) return null;
  if (!Number.isFinite(x)) return null;
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (x <= x2) {
      const t = (x2 - x1) === 0 ? 0 : (x - x1) / (x2 - x1);
      return lerp(y1, y2, t);
    }
  }
  return last[1];
}

/** Interpolate hazard ratios in log space so midpoints stay epidemiologically shaped. */
export function interpolateHazard(points, x) {
  const logged = points.map(([px, hr]) => [px, Math.log(Math.max(hr, 1e-9))]);
  const y = interpolatePoints(logged, x);
  if (y == null) return null;
  return Math.exp(y);
}

export function median(values) {
  const xs = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function mean(values) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

export function trimmedMean(values, fraction = 0.1, minN = 10) {
  const xs = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length < minN) return mean(xs);
  const drop = Math.floor(xs.length * fraction);
  const sliced = xs.slice(drop, xs.length - drop);
  return mean(sliced.length ? sliced : xs);
}

export function addDays(isoDay, delta) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function dayDiff(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000);
}

export function sameSign(a, b) {
  if (a === 0 || b === 0) return false;
  return (a > 0 && b > 0) || (a < 0 && b < 0);
}
