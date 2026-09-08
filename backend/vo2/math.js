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

export function mean(values) {
  const xs = (values || []).filter(Number.isFinite);
  if (!xs.length) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

export function median(values) {
  const xs = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function trimmedMean(values, fraction = 0.1, minN = 10) {
  const xs = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
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

export function stdev(values) {
  const xs = (values || []).filter(Number.isFinite);
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, n) => s + (n - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function cv(values) {
  const m = mean(values);
  if (!m) return null;
  return stdev(values) / Math.abs(m);
}

export function percentile(values, p) {
  const xs = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = clamp((p / 100) * (xs.length - 1), 0, xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

export function linregSlope(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 2) return 0;
  const n = pairs.length;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  if (den === 0) return 0;
  return num / den;
}

export function weightedMedian(items) {
  const rows = (items || [])
    .filter((r) => Number.isFinite(r?.value) && Number.isFinite(r?.weight) && r.weight > 0)
    .slice()
    .sort((a, b) => a.value - b.value);
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let acc = 0;
  for (const row of rows) {
    acc += row.weight;
    if (acc >= total / 2) return row.value;
  }
  return rows[rows.length - 1].value;
}

export function pearson(xs, ys) {
  const pairs = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function isoWeekMonday(isoDay) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function lastDayOf(days) {
  let last = null;
  for (const d of days || []) {
    const day = d?.day || d?.date;
    if (day && (!last || day > last)) last = day;
  }
  return last;
}

export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function bmi(weightKg, heightCm) {
  const w = finiteNumber(weightKg);
  const h = finiteNumber(heightCm);
  if (w == null || h == null || h <= 0) return null;
  const meters = h / 100;
  return w / (meters * meters);
}

export function ageYears(birthYear, asOfDay) {
  const year = finiteNumber(birthYear);
  if (year == null) return null;
  const asOf = asOfDay ? new Date(`${asOfDay}T12:00:00Z`) : new Date();
  if (Number.isNaN(asOf.getTime())) return null;
  return (asOf.getTime() - Date.UTC(year, 6, 1)) / (365.25 * 86400000);
}
