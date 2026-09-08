// FRWHOOP Strain V2 — Banister continuous exponential TRIMP
//
// Classic impulse-response training load (Calvert et al. 1976, IEEE Trans Syst
// Man Cybern SMC-6:94-102; Morton, Fitz-Clarke & Banister 1990, J Appl Physiol
// 69(3):1171-1177, doi:10.1152/jappl.1990.69.3.1171):
//
//   TRIMP = D(min) * dHR * a * e^(b*dHR),    dHR = fractional HR reserve
//
// The exponent b is what makes the minute-weight track the curvilinear
// HR-blood-lactate relationship. Per-minute weight = dHR * a * e^(b*dHR).
//
// MALE coefficients (exact, Morton et al. 1990):      a = 0.64, b = 1.92
// FEMALE coefficients — two published sets (weakly replicated; not sealed
// truth — see work_lit_cardio.md §1):
//   default  a = 0.86, b = 1.67  (widely cited female form, Banister lineage)
//   variant  a = 0.64, b = 1.62  (systematic-review table, Miguel et al. 2021,
//            Int J Environ Res Public Health 18(5):2721,
//            doi:10.3390/ijerph18052721)
// Select with config.femaleVariant = 'classic' (default) | 'miguel'.
//
// Inputs: per-epoch dHR == hrrFrac from Layer 1 (already normalized to
// fractional HR reserve). NOTE sex is honored via profile.sex / config.sex;
// if unknown, male is used and a note is emitted (female weights differ
// materially at high dHR).
//

export const VERSION = 'banister.1';

// Exact coefficients + citations. dHR is fractional HR reserve.
export const MALE_PARAMS = { a: 0.64, b: 1.92, source: 'Morton, Fitz-Clarke & Banister 1990, J Appl Physiol 69(3):1171-1177, doi:10.1152/jappl.1990.69.3.1171' };
export const FEMALE_PARAMS = {
  classic: { a: 0.86, b: 1.67, source: 'widely cited female form, Banister lineage (secondary literature; work_lit_cardio.md §1)' },
  miguel: { a: 0.64, b: 1.62, source: 'Miguel et al. 2021, IJERPH 18(5):2721, doi:10.3390/ijerph18052721 (systematic-review table)' },
};

export function coefficients(sex, femaleVariant) {
  const s = String(sex || '').toLowerCase();
  if (s === 'f' || s === 'female') {
    const v = femaleVariant === 'miguel' ? FEMALE_PARAMS.miguel : FEMALE_PARAMS.classic;
    return { ...v, sex: 'female', femaleVariant: femaleVariant === 'miguel' ? 'miguel' : 'classic' };
  }
  return { ...MALE_PARAMS, sex: 'male', femaleVariant: null };
}

export function weight(hrrFrac, coeff) {
  const dhr = num(hrrFrac);
  if (!Number.isFinite(dhr) || dhr < 0) return 0;
  return dhr * coeff.a * Math.exp(coeff.b * dhr);
}

export function weightCurve(coeff) {
  return {
    type: 'exponential',
    formula: 'dHR * a * exp(b * dHR)',
    a: coeff.a,
    b: coeff.b,
    dhr: 'per-epoch fractional HR reserve (hrrFrac) from Layer 1',
    source: coeff.source,
  };
}

export function score({ epochs = [], profile = {}, thresholds, config = {} } = {}) {
  const normalized = normalizeEpochs(epochs);
  const epochMinutes = finiteOr(config.epochMinutes, 1);
  const sex = config.sex || profile?.sex;
  const coeff = coefficients(sex, config.femaleVariant);

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
      inc = weight(ep.hrrFrac, coeff) * mins;
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
      notes.push('interval / short high-intensity work detected: TRIMP weighting is altered under intermittent exercise (Coutts et al. 2011, doi:10.1016/j.jsams.2010.12.003) — score is aerobic-biased');
    }
    if (unknownEpochs > 0) {
      notes.push(`${unknownEpochs} UNKNOWN epoch(s) excluded (contribute 0 AU, no invented duration)`);
    }
    if (!sex) {
      notes.push('sex not provided (profile.sex / config.sex); defaulted to MALE coefficients a=0.64 b=1.92. Female weights differ (0.86/1.67 or 0.64/1.62) — set sex for correct per-minute scaling');
    }
    if (coeff.sex === 'female') {
      notes.push(`female coefficients a=${coeff.a} b=${coeff.b} (${coeff.femaleVariant}); gender-specific constants are weakly replicated across sources (1.67 vs 1.62; 0.86 vs 0.64) — treat as approximate`);
    }
    if (!hrMaxIsObserved(profile)) {
      notes.push('HRmax caution: no observed-max source in profile; population-equation HRmax carries SEE ≈ ±10.8 bpm (Nes et al. 2013) and Banister is exponential in dHR, so HRmax error materially shifts high-intensity weights');
    }
  }

  const thisParams = {
    ...coeff,
    hrMax: profile?.hrMax ?? null,
    hrMaxSource: profile?.hrMaxSource ?? null,
    hrRest: profile?.hrRest ?? null,
    epochMinutes,
  };

  return {
    au: scorableEpochs === 0 ? null : au,
    increments,
    model: { name: 'banister', version: VERSION, params: thisParams, weightCurve: weightCurve(coeff) },
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
