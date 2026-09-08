// FRWHOOP Strain V2 — Individualized lactate-curve TRIMP (iTRIMP)
//
// Replaces Banister's universal constants with per-athlete constants fitted to
// that athlete's own HR-blood-lactate curve (individualized TRIMP):
//
//   TRIMP_i = T(min) * dHR * y_i(dHR)     dHR = fractional HR reserve
//
// where y_i(dHR) is the athlete's individual weighting factor from an
// exponential fit y_i = a*e^(b*dHR) to their ramp-test ΔHR vs blood-lactate
// response. Source: Manzi et al. 2009, Am J Physiol Heart Circ Physiol 296(6)
// H1733-H1740, doi:10.1152/ajpheart.00054.2009; formula also described in
// Miguel et al. 2021, doi:10.3390/ijerph18052721.
//
// REQUIRES an individualized curve — not inferable from wrist HR + age + body
// data (work_lit_cardio.md §4). Supply via config.curve (or profile.curve):
//   curve = { a, b }      exponential coefficients y_i = a*e^(b*dHR)  (Manzi)
//   curve = { points: [[x, y], ...] }   piecewise-linear y_i(dHR) table
// Without a usable curve this model is 'unavailable' (null AU; never throws;
// never silently falls back to population Banister). a>0 and b>0 are required
// so the minute-weight is monotone in dHR; a non-monotone points table is
// rejected as invalid (unavailable).

export const VERSION = 'individualized.1';

export function weightWithCurve(dhr, curve) {
  const f = num(dhr);
  if (!Number.isFinite(f) || f < 0) return 0;
  if (curve == null) return 0;
  if (Number.isFinite(num(curve.a)) && Number.isFinite(num(curve.b))) {
    const a = num(curve.a);
    const b = num(curve.b);
    if (a <= 0 || b <= 0) return 0; // non-monotone / invalid exponential
    return f * a * Math.exp(b * f);
  }
  if (Array.isArray(curve.points)) {
    const pts = curve.points
      .filter((p) => p && Number.isFinite(num(p[0])) && Number.isFinite(num(p[1])))
      .map((p) => [num(p[0]), num(p[1])])
      .sort((p, q) => p[0] - q[0]);
    if (pts.length < 2) return 0;
    // reject non-monotone y (weight factor must not decrease with intensity)
    for (let i = 1; i < pts.length; i += 1) {
      if (pts[i][1] < pts[i - 1][1]) return 0;
    }
    const y = interp(pts, f);
    return f * y;
  }
  return 0;
}

function interp(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i += 1) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      if (x1 - x0 === 0) return y1;
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

function resolveCurve(profile, config) {
  const c = config?.curve || profile?.curve || null;
  if (c == null) return null;
  if (Number.isFinite(num(c.a)) && Number.isFinite(num(c.b)) && num(c.a) > 0 && num(c.b) > 0) {
    return { ...c, kind: 'exponential', source: c.source ?? null };
  }
  if (Array.isArray(c.points) && c.points.length >= 2) {
    const pts = c.points
      .filter((p) => p && Number.isFinite(num(p[0])) && Number.isFinite(num(p[1])))
      .map((p) => [num(p[0]), num(p[1])])
      .sort((p, q) => p[0] - q[0]);
    let monotone = true;
    for (let i = 1; i < pts.length; i += 1) if (pts[i][1] < pts[i - 1][1]) monotone = false;
    if (pts.length >= 2 && monotone) {
      return { points: pts, kind: 'table', source: c.source ?? null };
    }
  }
  return { invalid: true, kind: 'invalid', reason: 'curve must be {a>0, b>0} (Manzi exponential) or monotone {points:[x,y][]}', source: c?.source ?? null };
}

function unavailable(notes) {
  return {
    au: null,
    increments: [],
    model: {
      name: 'individualized',
      version: VERSION,
      params: { status: 'unavailable', reason: 'individualized HR-lactate curve (config.curve / profile.curve) required; none usable supplied' },
      weightCurve: null,
    },
    notes: notes.length
      ? notes
      : ['individualized unavailable: no usable individual lactate curve — requires an individualized graded test (Manzi et al. 2009); no silent fallback to population Banister'],
  };
}

export function score({ epochs = [], profile = {}, thresholds, config = {} } = {}) {
  const notes = [];
  const curve = resolveCurve(profile, config);

  if (!curve || curve.invalid) {
    notes.push('individualized curve required; absent/invalid -> model unavailable (never zero-load, never silent fallback)');
    if (curve && curve.invalid) notes.push(`curve invalid: ${curve.reason}`);
    return unavailable(notes);
  }

  const normalized = normalizeEpochs(epochs);
  const epochMinutes = finiteOr(config.epochMinutes, 1);

  let au = 0;
  let scorableMinutes = 0;
  let scorableEpochs = 0;
  let unknownEpochs = 0;
  const increments = [];
  let firstT = null;
  let lastT = null;

  for (const ep of normalized) {
    const t = num(ep.t);
    const isUnknown = isUnknownEpoch(ep);
    const hasHrr = Number.isFinite(num(ep.hrrFrac));
    const mins = scorableMinutesOf(ep, epochMinutes);
    const excluded = isUnknown || !hasHrr || mins <= 0;

    let inc = 0;
    if (excluded) {
      if (isUnknown) unknownEpochs += 1;
    } else {
      inc = weightWithCurve(ep.hrrFrac, curve) * mins;
      au += inc;
      scorableMinutes += mins;
      scorableEpochs += 1;
      firstT = firstT === null ? t : firstT;
      lastT = t;
    }
    increments.push({ t, au: inc });
  }

  if (scorableEpochs === 0) {
    notes.push('INSUFFICIENT: no scorable epochs against the supplied curve — AU is null, not a fabricated zero');
  } else {
    if (lastT - firstT > 60 * 60 * 1000) {
      notes.push('long-session cardiac-drift caveat: scorable span > 60 min; HR-based TRIMP biased upward ~+5-15% in heat (Wingo et al. 2005, doi:10.1249/01.mss.0000152731.33450.95)');
    }
    if (unknownEpochs > 0) {
      notes.push(`${unknownEpochs} UNKNOWN epoch(s) excluded (contribute 0 AU, no invented duration)`);
    }
    if (!curve.source && !(curve.kind === 'table' && curve.points?.length)) {
      notes.push('curve provenance missing: provide config.curve.source (e.g. test date / protocol) per D2 provenance expectations');
    }
  }

  const weightCurve = curve.kind === 'exponential'
    ? { type: 'exponential', formula: 'dHR * a * exp(b * dHR)', a: curve.a, b: curve.b, note: 'individualized coefficients, Manzi et al. 2009' }
    : { type: 'table', points: curve.points, formula: 'dHR * y_i(dHR), y_i interpolated piecewise-linearly', note: 'individualized weighting-factor table' };

  return {
    au: scorableEpochs === 0 ? null : au,
    increments,
    model: {
      name: 'individualized',
      version: VERSION,
      params: {
        curve: curve.kind === 'exponential' ? { a: curve.a, b: curve.b, source: curve.source } : { points: curve.points, source: curve.source },
        epochMinutes,
      },
      weightCurve,
    },
    notes,
  };
}

export default score;

// --- shared epoch plumbing (duplicated intentionally; see edwards.js) -----
export function num(x) {
  if (x == null) return NaN;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isNaN(n) ? NaN : n;
}
export function finiteOr(x, dflt) {
  const n = num(x);
  return Number.isFinite(n) ? n : dflt;
}
export function qualityRank(q) {
  const s = String(q || '').toUpperCase();
  if (s === 'HIGH') return 4;
  if (s === 'MODERATE') return 3;
  if (s === 'LOW') return 2;
  return 1;
}
export function normalizeEpochs(epochs) {
  const byT = new Map();
  for (const e of epochs || []) {
    const t = num(e && e.t);
    if (!Number.isFinite(t)) continue;
    const prev = byT.get(t);
    const rank = qualityRank(e.quality);
    if (!prev || rank > qualityRank(prev.quality)) byT.set(t, e);
  }
  return [...byT.values()].sort((a, b) => num(a.t) - num(b.t));
}
export function scorableMinutesOf(e, epochMinutes) {
  const c = num(e && e.coverage);
  if (!Number.isFinite(c) || c <= 0) return 0;
  const em = Number.isFinite(num(epochMinutes)) && num(epochMinutes) > 0 ? num(epochMinutes) : 1;
  return Math.min(1, Math.max(0, c)) * em;
}
export function isUnknownEpoch(e) {
  return String((e && e.quality) || '').toUpperCase() === 'UNKNOWN';
}
