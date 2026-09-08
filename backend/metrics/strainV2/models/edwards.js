// FRWHOOP Strain V2 — Edwards TRIMP model (V1-parity discrete HRR zones)
//
// Layer 1 (epochs.js) supplies per-epoch fractional heart-rate reserve
// (hrrFrac) and a coverage fraction. Per-epoch AU =
//   weight(hrrFrac) * scorableMinutes(coverage)
// where scorableMinutes comes from EPOCH coverage (fraction of the epoch's
// expected samples that were valid) — NOT from sample count, so the metric is
// invariant to upstream packet frequency.
//
// V1 PARITY: this model reproduces the exact zone structure of the canonical
// V1 daily scorer backend/metrics/sleep.js:153-185 —
//   weights 5/4/3/2/1/0.5/0 at pct HRR >= 90/80/70/60/50/25.
// The published Edwards TRIMP uses weights 1..5 only (Edwards, The Heart Rate
// Monitor Book, 1993; notice in Med Sci Sports Exerc 1994,
// doi:10.1249/00005768-199405000-00020). The custom 0.5 low band (25-50% HRR)
// and 5-unit top band are V1's unvalidated modification; they are kept here
// ONLY so V2 can run exact V1-parity comparisons. This is never the V2
// default model (see stagno.js).
//

export const VERSION = 'edwards.1';

// Discrete HRR zone table (V1 parity). 'minPct' is the %HRR lower edge.
export const ZONES = [
  { minPct: 90, weight: 5 },
  { minPct: 80, weight: 4 },
  { minPct: 70, weight: 3 },
  { minPct: 60, weight: 2 },
  { minPct: 50, weight: 1 },
  { minPct: 25, weight: 0.5 },
];

export function weight(hrrFrac) {
  const pct = num(hrrFrac) * 100;
  if (!Number.isFinite(pct)) return 0;
  if (pct >= 90) return 5;
  if (pct >= 80) return 4;
  if (pct >= 70) return 3;
  if (pct >= 60) return 2;
  if (pct >= 50) return 1;
  if (pct >= 25) return 0.5;
  return 0;
}

export const WEIGHT_CURVE = {
  type: 'zones',
  note: 'discrete HRR zones, V1 parity weights (sleep.js:174-180); published Edwards weights are 1-5 (Edwards 1993)',
  bands: ZONES.map((z) => ({ minHrrFrac: z.minPct / 100, weight: z.weight })),
};

export function params() {
  return {
    zones: ZONES,
    note: VERSION + ' = V1-parity only; low band 0.5 and 5-unit top band are V1 modifications, not literature',
  };
}

export function score({ epochs = [], profile = {}, thresholds, config = {} } = {}) {
  const normalized = normalizeEpochs(epochs);
  const epochMinutes = finiteOr(config.epochMinutes, 1);

  let au = 0;
  let scorableMinutes = 0;
  let scorableEpochs = 0;
  let unknownEpochs = 0;
  let lowQuality = 0;
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
      const q = String(ep.quality || '').toUpperCase();
      if (q === 'LOW' || q === 'MODERATE') lowQuality += 1;
      firstT = firstT === null ? t : firstT;
      lastT = t;
    }
    increments.push({ t, au: inc });
  }

  const notes = [];
  if (scorableEpochs === 0) {
    notes.push('INSUFFICIENT: no scorable epochs (all UNKNOWN, missing hrrFrac, or missing coverage) — AU is null, not a fabricated zero');
    notes.push('V1 (sleep.js:161) silently returns 0 on no data; V2 ascribes no confidence to a missing-data day');
  } else {
    if (lastT - firstT > 60 * 60 * 1000) {
      notes.push('long-session cardiac-drift caveat: scorable span > 60 min; HR-based TRIMP is biased upward ~+5-15% in heat (Wingo et al. 2005, doi:10.1249/01.mss.0000152731.33450.95); no population correction applied (Coyle & González-Alonso 2001, doi:10.1097/00003677-200104000-00009) — reported as context');
    }
    if (hasShortHighIntensityRun(normalized, epochMinutes)) {
      notes.push('interval / short high-intensity work detected: HR-based TRIMP under-weights bursts shorter than the HR time constant (Coutts et al. 2011, doi:10.1016/j.jsams.2010.12.003) — score is aerobic-biased for this session');
    }
    if (scorableEpochs > 0 && lowQuality / scorableEpochs > 0.25) {
      notes.push(`data-quality caveat: ${lowQuality}/${scorableEpochs} scorable epochs are LOW/MODERATE quality — score carries wrist-PPG uncertainty`);
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
    model: { name: 'edwards', version: VERSION, params: thisParams, weightCurve: WEIGHT_CURVE },
    notes,
  };
}

export default score;

// --- shared epoch plumbing ------------------------------------------------
// (an intentional small duplicate across the model files: each model is a
//  standalone unit and index.js only registers them — no circular imports.)

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
  return 1; // UNKNOWN or missing
}

// Dedup by epoch start time keeping the best-quality epoch (D1: 'dedup
// (t,source) keep best quality'); ties keep the first occurrence. Then sort
// chronologically. Duplicated epochs therefore contribute exactly once.
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

// Minutes contributed by an epoch = coverage fraction x epoch duration.
// No coverage => 0 minutes => excluded (never an invented duration).
export function scorableMinutesOf(e, epochMinutes) {
  const c = num(e && e.coverage);
  if (!Number.isFinite(c) || c <= 0) return 0;
  const em = Number.isFinite(num(epochMinutes)) && num(epochMinutes) > 0 ? num(epochMinutes) : 1;
  return Math.min(1, Math.max(0, c)) * em;
}

export function isUnknownEpoch(e) {
  return String((e && e.quality) || '').toUpperCase() === 'UNKNOWN';
}

// Flag only BRIEF high-intensity blocks (< 5 min contiguous at hrrFrac>=0.9);
// a sustained >= 5 min block is assumed well represented by HR. Citation for
// the under-score: Özyener et al. 2001 (HR/VO2 kinetics ~30-60 s),
// doi:10.1111/j.1469-7793.2001.t01-1-00891.x; intermittent-shift evidence
// Coutts et al. 2011, doi:10.1016/j.jsams.2010.12.003.
export function hasShortHighIntensityRun(epochs, epochMinutes = 1, lowFrac = 0.9, minMinutes = 5) {
  let run = 0;
  let burst = false;
  for (const e of epochs || []) {
    const frac = num(e && e.hrrFrac);
    const mins = scorableMinutesOf(e, epochMinutes);
    if (Number.isFinite(frac) && frac >= lowFrac && mins > 0 && !isUnknownEpoch(e)) {
      run += mins;
      if (run >= minMinutes) return false; // sustained effort — well covered by HR
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
