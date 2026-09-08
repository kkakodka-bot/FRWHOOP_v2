// FRWHOOP Strain V2 — Stagno discontinuous HRR-zone TRIMP (recommended default)
//
// Recommended default model for wrist-HR + age + body data with NO individual
// test (work_lit_cardio.md §0, §11): a discontinuous, zone-weighted TRIMP on
// heart-rate reserve with lactate-anchored weights.
//
// EXACT published weights (tabulated in Miguel et al. 2021, Int J Environ Res
// Public Health 18(5):2721, doi:10.3390/ijerph18052721, citing Stagno, Thatcher
// & van Someren 2007, J Sports Sci 25(6):629-634,
// doi:10.1080/02640410600811817):
//
//   zone 1  1.25
//   zone 2  1.71
//   zone 3  2.54
//   zone 4  3.61
//   zone 5  5.16
//
// The original paper defines 5 bands around lactate threshold and OBLA at
// 65-71 / 72-78 / 79-85 / 86-92 / 93-100 %HRmax. V2 applies the SAME exact
// weights to the existing V1 HRR-zone architecture (bands at >= 90/80/70/60/50
// pct HRR) — the lit report's explicit strategy: "keep V1's HRR-zone
// architecture but assign lactate-anchored zone weights (Stagno family)".
// For a reference profile (HRrest 55, HRmax 190) the published %HRmax band
// edges map to HRR ≈ 0.507 / 0.606 / 0.704 / 0.803 / 0.887, which is what the
// 0.50/0.60/0.70/0.80/0.90 HRR edges approximate.
//
// Weights are the exact constants; only the axis (HRR vs HRmax) is adapted to
// the Layer-1 contract, which supplies hrrFrac per epoch.

export const VERSION = 'stagno.1';

export const ZONES = [
  { minHrrFrac: 0.90, weight: 5.16 },
  { minHrrFrac: 0.80, weight: 3.61 },
  { minHrrFrac: 0.70, weight: 2.54 },
  { minHrrFrac: 0.60, weight: 1.71 },
  { minHrrFrac: 0.50, weight: 1.25 },
];

export function weight(hrrFrac) {
  const f = num(hrrFrac);
  if (!Number.isFinite(f)) return 0;
  if (f >= 0.90) return 5.16;
  if (f >= 0.80) return 3.61;
  if (f >= 0.70) return 2.54;
  if (f >= 0.60) return 1.71;
  if (f >= 0.50) return 1.25;
  return 0;
}

export const WEIGHT_CURVE = {
  type: 'zones',
  note: 'lactate-anchored zone weights (Stagno 2007, via Miguel et al. 2021 table), applied to V1 HRR-zone architecture on %HRR',
  bands: ZONES.map((z) => ({ minHrrFrac: z.minHrrFrac, weight: z.weight })),
};

export function params() {
  return {
    zones: ZONES,
    weightSource: 'Stagno et al. 2007, doi:10.1080/02640410600811817; coefficients tabulated in Miguel et al. 2021, doi:10.3390/ijerph18052721',
    bandsPublished: '65-71 / 72-78 / 79-85 / 86-92 / 93-100 %HRmax (original paper, mapped to HRR 0.50/0.60/0.70/0.80/0.90 for Layer-1 hrrFrac contract)',
  };
}

export function score({ epochs = [], profile = {}, thresholds, config = {} } = {}) {
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
      inc = weight(ep.hrrFrac) * mins;
      au += inc;
      scorableMinutes += mins;
      scorableEpochs += 1;
      firstT = firstT === null ? t : firstT;
      lastT = t;
    }
    increments.push({ t, au: inc });
  }

  const notes = [];
  if (scorableEpochs === 0) {
    notes.push('INSUFFICIENT: no scorable epochs (all UNKNOWN, missing hrrFrac, or missing coverage) — AU is null, not a fabricated zero');
  } else {
    if (lastT - firstT > 60 * 60 * 1000) {
      notes.push('long-session cardiac-drift caveat: scorable span > 60 min; HR-based TRIMP biased upward ~+5-15% in heat (Wingo et al. 2005, doi:10.1249/01.mss.0000152731.33450.95); no correction applied — reported as context');
    }
    if (hasShortHighIntensityRun(normalized, epochMinutes)) {
      notes.push('interval / short high-intensity work detected: zone-binned TRIMP under-weights bursts shorter than the HR time constant and intermittent exercise shifts the HR-lactate curve (Coutts et al. 2011, doi:10.1016/j.jsams.2010.12.003) — score is aerobic-biased');
    }
    if (unknownEpochs > 0) {
      notes.push(`${unknownEpochs} UNKNOWN epoch(s) excluded (contribute 0 AU, no invented duration)`);
    }
    if (!hrMaxIsObserved(profile)) {
      notes.push('HRmax caution: no observed-max source in profile; population-equation HRmax carries SEE ≈ ±10.8 bpm (Nes et al. 2013, doi:10.1111/j.1600-0838.2012.01445.x), which shifts every HRR zone boundary');
    }
  }

  const thisParams = params();
  thisParams.hrMax = profile?.hrMax ?? null;
  thisParams.hrMaxSource = profile?.hrMaxSource ?? null;
  thisParams.hrRest = profile?.hrRest ?? null;
  thisParams.epochMinutes = epochMinutes;

  return {
    au: scorableEpochs === 0 ? null : au,
    increments,
    model: { name: 'stagno', version: VERSION, params: thisParams, weightCurve: WEIGHT_CURVE },
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
export function hasShortHighIntensityRun(epochs, epochMinutes = 1, lowFrac = 0.9, minMinutes = 5) {
  let run = 0;
  let burst = false;
  for (const e of epochs || []) {
    const frac = num(e && e.hrrFrac);
    const mins = scorableMinutesOf(e, epochMinutes);
    if (Number.isFinite(frac) && frac >= lowFrac && mins > 0 && !isUnknownEpoch(e)) {
      run += mins;
      if (run >= minMinutes) return false;
    } else if (run > 0) {
      if (run < minMinutes) burst = true;
      run = 0;
    }
  }
  if (run > 0 && run < minMinutes) burst = true;
  return burst;
}
export function hrMaxIsObserved(profile) {
  const src = String((profile && profile.hrMaxSource) || (profile && profile.hrMax && profile.hrMax.source) || '').toLowerCase();
  if (!src) return false;
  return /lab|manual|observed|measured|test/.test(src);
}
