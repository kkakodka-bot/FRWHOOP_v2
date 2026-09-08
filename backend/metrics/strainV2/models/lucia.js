// FRWHOOP Strain V2 — Lucia 3-zone threshold TRIMP
//
// Lucia TRIMP = t_zone_I*1 + t_zone_II*2 + t_zone_III*3 with phases anchored
// to EACH ATHLETE'S OWN ramp-test HR thresholds:
//   phase I   <  VT1  (aerobic threshold)       weight 1
//   phase II  VT1..VT2 (respiratory compensation point) weight 2
//   phase III >  VT2                             weight 3
// Sources: Lucia, Hoyos, Carvajal & Chicharro 1999, Int J Sports Med 20(3)
// doi:10.1055/s-1999-970284; Lucia et al. 2003, Med Sci Sports Exerc 35(5)
// doi:10.1249/01.mss.0000064999.82036.b4; formula tabulated in Miguel et al.
// 2021, doi:10.3390/ijerph18052721.
//
// Thresholds are REQUIRED — they cannot be synthesized from age/body data at
// individual precision (work_lit_cardio.md §5-6). Without them this model is
// 'unavailable' (null AU, never throws, never silently falls back to a
// population zone model). Provide them as:
//   thresholds.vt1, thresholds.vt2  (HR bpm; epochs classified by epoch.hr)
//   thresholds.lt1, thresholds.lt2  (HRR fraction; epochs classified by
//                                    epoch.hrrFrac)
// and always thresholds.source (provenance is mandatory per D2).

export const VERSION = 'lucia.1';

const ZONE_WEIGHTS = [1, 2, 3];
// Phase boundaries are per-individual; the weight curve is expressed
// symbolically in the returned params (classification axes vt1/vt2 or lt1/lt2).

export function weightByBpm(hr, vt1, vt2) {
  const h = num(hr);
  if (!Number.isFinite(h)) return 0;
  if (h > vt2) return 3;
  if (h >= vt1) return 2;
  return 1;
}

export function weightByFrac(hrrFrac, lt1, lt2) {
  const f = num(hrrFrac);
  if (!Number.isFinite(f)) return 0;
  if (f > lt2) return 3;
  if (f >= lt1) return 2;
  return 1;
}

function resolvedAxes(thresholds = {}) {
  const vt1 = num(thresholds.vt1);
  const vt2 = num(thresholds.vt2);
  const lt1 = num(thresholds.lt1);
  const lt2 = num(thresholds.lt2);
  if (Number.isFinite(vt1) && Number.isFinite(vt2) && vt2 > vt1) {
    return { axis: 'bpm', vt1, vt2 };
  }
  if (Number.isFinite(lt1) && Number.isFinite(lt2) && lt2 > lt1) {
    return { axis: 'frac', lt1, lt2 };
  }
  return null;
}

function unavailable(thresholds, notes) {
  return {
    au: null,
    increments: [],
    model: {
      name: 'lucia',
      version: VERSION,
      params: {
        status: 'unavailable',
        reason: 'individual VT1/VT2 thresholds required: thresholds.vt1+vt2 (bpm) or thresholds.lt1+lt2 (HRR fraction); none usable supplied',
        thresholdsGiven: thresholds ?? null,
      },
      weightCurve: null,
    },
    notes: notes.length
      ? notes
      : ['lucia unavailable: thresholds absent — this model cannot run without an individual ramp/graded test (Lucia et al. 2003); no silent fallback to a population model'],
  };
}

export function score({ epochs = [], profile = {}, thresholds, config = {} } = {}) {
  const notes = [];
  const axes = resolvedAxes(thresholds);

  if (!axes) {
    notes.push('thresholds required for lucia; absent -> model unavailable (never zero-load, never silent fallback)');
    notes.push('per work_lit_cardio.md §6, individual VT1/VT2 cannot be recovered from age/body data at individual precision');
    return unavailable(thresholds, notes);
  }

  if (!thresholds || !thresholds.source) {
    notes.push('threshold provenance warning: thresholds supplied WITHOUT thresholds.source — D2 requires provenance for every threshold');
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
    const value = axes.axis === 'bpm' ? num(ep.hr) : num(ep.hrrFrac);
    const mins = scorableMinutesOf(ep, epochMinutes);
    const excluded = isUnknown || !Number.isFinite(value) || mins <= 0;

    let inc = 0;
    if (excluded) {
      if (isUnknown) unknownEpochs += 1;
    } else {
      const w = axes.axis === 'bpm'
        ? weightByBpm(value, axes.vt1, axes.vt2)
        : weightByFrac(value, axes.lt1, axes.lt2);
      inc = w * mins;
      au += inc;
      scorableMinutes += mins;
      scorableEpochs += 1;
      firstT = firstT === null ? t : firstT;
      lastT = t;
    }
    increments.push({ t, au: inc });
  }

  if (scorableEpochs === 0) {
    notes.push('INSUFFICIENT: no scorable epochs against the supplied thresholds — AU is null, not a fabricated zero');
  } else {
    if (lastT - firstT > 60 * 60 * 1000) {
      notes.push('long-session cardiac-drift caveat: scorable span > 60 min; HR-based TRIMP biased upward ~+5-15% in heat (Wingo et al. 2005, doi:10.1249/01.mss.0000152731.33450.95)');
    }
    if (unknownEpochs > 0) {
      notes.push(`${unknownEpochs} UNKNOWN epoch(s) excluded (contribute 0 AU, no invented duration)`);
    }
  }

  return {
    au: scorableEpochs === 0 ? null : au,
    increments,
    model: {
      name: 'lucia',
      version: VERSION,
      params: {
        zones: [{ phase: 'I', bound: axes.axis === 'bpm' ? `< vt1=${axes.vt1} bpm` : `< lt1=${axes.lt1} HRR`, weight: 1 },
                { phase: 'II', bound: axes.axis === 'bpm' ? `vt1..vt2 (${axes.vt1}..${axes.vt2} bpm)` : `lt1..lt2 (${axes.lt1}..${axes.lt2})`, weight: 2 },
                { phase: 'III', bound: axes.axis === 'bpm' ? `> vt2=${axes.vt2} bpm` : `> lt2=${axes.lt2}`, weight: 3 }],
        axis: axes.axis,
        source: thresholds.source ?? null,
        epochMinutes,
      },
      weightCurve: {
        type: 'thresholdZones',
        axis: axes.axis,
        thresholds: axes.axis === 'bpm' ? { vt1: axes.vt1, vt2: axes.vt2 } : { lt1: axes.lt1, lt2: axes.lt2 },
        weights: ZONE_WEIGHTS,
        note: 'weights 1/2/3 per Lucia 1999/2003; phases individually anchored to VT1/VT2',
      },
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
