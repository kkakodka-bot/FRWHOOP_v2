import { buildCanonicalEpochs } from './epochs.js';
import { scoreModel, DEFAULT_MODEL } from './models/index.js';
import { display } from './display.js';
import { resolveStrainV2Profile } from './profile.js';

/**
 * FRWHOOP Strain V2 - orchestrator (Layers 1-3, 5, 6).
 *
 * Deterministic pipeline from raw normalized samples to the full Strain V2
 * output envelope (D6): profile -> canonical epochs -> cardio model ->
 * display transform -> sufficiency + provenance. Pure: identical inputs give
 * identical outputs; no wall clock; no randomness.
 *
 * Unification (D7): the daily total, every activity window, and the 5-minute
 * strain series are ALL windows over the SAME per-epoch increment series
 * emitted by the cardio model. There is no second formula anywhere.
 *
 * Failure isolation: never throws on bad data; deficiencies degrade into
 * provenance notes and/or INSUFFICIENT state. No data => strain null, never 0.
 */

const ALGORITHM_VERSION = 'frwhoop-strain-v2.0.0-shadow';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Window cardiovascular load over the canonical increment series (D7). */
export function windowCardioLoad(increments, startMs, endMs) {
  let au = 0;
  let n = 0;
  for (const inc of increments || []) {
    if (inc.t >= startMs && inc.t < endMs) {
      au += inc.au;
      n += 1;
    }
  }
  return { au: Math.round(au * 1000) / 1000, nEpochs: n };
}

/** 5-minute bucket projection of the increment series (strain_series shape). */
export function strainSeries5Min(increments, dayStartMs, dayEndMs) {
  const BUCKET_MS = 5 * 60_000;
  const out = [];
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(dayEndMs)) return out;
  const n = Math.max(0, Math.round((dayEndMs - dayStartMs) / BUCKET_MS));
  const sorted = [...(increments || [])].sort((a, b) => a.t - b.t);
  let idx = 0;
  for (let i = 0; i < n; i += 1) {
    const b0 = dayStartMs + i * BUCKET_MS;
    const b1 = b0 + BUCKET_MS;
    let au = 0;
    let nEpochs = 0;
    while (idx < sorted.length && sorted[idx].t < b1) {
      if (sorted[idx].t >= b0) {
        au += sorted[idx].au;
        nEpochs += 1;
      }
      idx += 1;
    }
    if (nEpochs > 0) {
      out.push({
        bucket_start: new Date(b0).toISOString(),
        bucket_minutes: 5,
        au: Math.round(au * 1000) / 1000,
        n: nEpochs,
      });
    }
  }
  return out;
}

/**
 * Compact provenance payload for daily_metrics.strain_v2 (jsonb).
 * Excludes the bulky strainSeries (lives in daily_physiology_series.strain_series)
 * and keeps only the sufficiency/provenance envelope (D6).
 */
export function provenancePayload(v2) {
  if (!v2) return null;
  return {
    version: v2.version,
    au: v2.au,
    coveragePct: v2.coveragePct,
    scorableMinutes: v2.scorableMinutes,
    unknownMinutes: v2.unknownMinutes,
    missingMinutes: v2.missingMinutes,
    qualityState: v2.qualityState,
    hrMax: v2.hrMax,
    restingHr: v2.restingHr,
    acuteRestingHrDelta: v2.acuteRestingHrDelta,
    thresholds: v2.thresholds,
    cardioModel: v2.cardioModel,
    muscular: v2.muscular,
    activities: (v2.activities || []).map((a) => ({ id: a.id, name: a.name, au: a.au, strain: a.strain, state: a.state })),
    algorithmVersion: v2.algorithmVersion,
    profileVersion: v2.profileVersion,
    notes: v2.notes,
  };
}

/**
 * Shadow-mode gate: FRWHOOP_STRAIN_V2 env ('off' default | 'shadow').
 * Read at call time so tests can flip it without re-importing the module.
 */
export function strainV2Mode() {
  const mode = String(process.env.FRWHOOP_STRAIN_V2 || 'off').toLowerCase();
  return mode === 'shadow' ? 'shadow' : 'off';
}

/**
 * Compute the Strain V2 day result.
 *
 * @param {object} args
 * @param {Array}   args.samples   raw normalized rows (same rows V1 scoreDay consumes)
 * @param {object}  [args.profile] store.profile
 * @param {object}  [args.prefs]   store.prefs
 * @param {Array}   [args.days]    history days (observed peaks + overnight rhr)
 * @param {string}  [args.currentDay] 'YYYY-MM-DD' (RHR baseline excludes this day)
 * @param {number}  [args.acuteRestingHr] today's measured resting HR (recovery context only)
 * @param {Array}   [args.activities] [{id?, name?, start, end}] windows to score from the SAME series
 * @param {object}  [args.opts]    { dayStartMs, dayEndMs, model, config }
 */
export function computeStrainV2({
  samples,
  profile = {},
  prefs = {},
  days = [],
  currentDay = null,
  acuteRestingHr = null,
  activities = [],
  opts = {},
} = {}) {
  const notes = [];

  const prof = resolveStrainV2Profile({ profile, prefs, days, currentDay, acuteRestingHr });
  if (prof.hrMax.source === 'unavailable') notes.push('hrmax_unavailable_day_unscorable');
  if (prof.restingHr?.source === 'population_default') notes.push('rhr_population_default');
  if (prof.thresholds) notes.push(`thresholds_source:${prof.thresholds.source}`);

  const { epochs, dayStats } = buildCanonicalEpochs({
    samples,
    profile: { restingHr: prof.restingHr?.value, hrMax: prof.hrMax?.value },
    opts: { dayStartMs: opts.dayStartMs, dayEndMs: opts.dayEndMs },
  });

  const dayStart = Number.isFinite(opts.dayStartMs)
    ? opts.dayStartMs
    : (epochs.length ? epochs[0].t : 0);
  const dayEnd = Number.isFinite(opts.dayEndMs)
    ? opts.dayEndMs
    : (epochs.length ? epochs[epochs.length - 1].t + 60_000 : 0);

  if (dayStats.scorableMinutes === 0) {
    return envelope({
      prof,
      epochs,
      dayStats,
      scored: null,
      qualityState: 'INSUFFICIENT',
      notes: [...notes, 'no_scorable_epochs'],
      activities,
      dayStart,
      dayEnd,
    });
  }

  const modelName = opts.model ?? DEFAULT_MODEL;
  let scored;
  try {
    scored = scoreModel(modelName, {
      epochs,
      profile: prof,
      thresholds: prof.thresholds,
      config: opts.config,
    });
  } catch (err) {
    // Unknown model name is a programming error; degrade to INSUFFICIENT with
    // provenance rather than poisoning V1's day (shadow-mode safety).
    return envelope({
      prof,
      epochs,
      dayStats,
      scored: { au: null, increments: [], model: { name: modelName, state: 'error', reason: String(err?.message || err) }, notes: [] },
      qualityState: dayStats.state,
      notes: [...notes, 'cardio_model_error'],
      activities,
      dayStart,
    });
  }

  if (scored.au == null) notes.push(`cardio_model_unavailable:${modelName}`);

  return envelope({
    prof,
    epochs,
    dayStats,
    scored,
    qualityState: dayStats.state,
    notes,
    activities,
    dayStart,
  });
}

function envelope({ prof, epochs, dayStats, scored, qualityState, notes, activities, dayStart }) {
  const au = scored?.au ?? null;
  const increments = scored?.increments ?? [];
  const model = scored?.model ?? null;
  const modelNotes = scored?.notes ?? [];

  // Activity windows over the SAME increment series (D7).
  const activityResults = (activities || []).map((a) => {
    const startMs = toMs(a.start ?? a.startMs);
    const endMs = toMs(a.end ?? a.endMs);
    const win = startMs != null && endMs != null && endMs > startMs
      ? windowCardioLoad(increments, startMs, endMs)
      : { au: null, nEpochs: 0 };
    const au = win.au;
    const nEpochs = win.nEpochs;
    return {
      id: a.id ?? null,
      name: a.name ?? null,
      start: a.start ?? a.startMs ?? null,
      end: a.end ?? a.endMs ?? null,
      au: au == null ? null : au,
      strain: au == null ? null : display(au),
      nEpochs,
      state: win.nEpochs > 0 ? 'scored' : 'insufficient',
    };
  });

  return {
    version: ALGORITHM_VERSION,
    strain: au == null ? null : display(au),
    // 3-decimal rounding matches the activity-window and 5-min-bucket series
    // precision so window sums partition the daily AU exactly (D7).
    au: au == null ? null : Math.round(au * 1000) / 1000,
    coveragePct: dayStats.coveragePct,
    scorableMinutes: dayStats.scorableMinutes,
    unknownMinutes: dayStats.unknownMinutes,
    missingMinutes: dayStats.missingMinutes,
    qualityState,
    hrMax: prof.hrMax,
    restingHr: prof.restingHr,
    acuteRestingHrDelta: prof.acuteRestingHrDelta,
    thresholds: prof.thresholds,
    cardioModel: {
      name: model?.name ?? null,
      version: model?.version ?? null,
      params: model?.params ?? null,
      weightCurve: model?.weightCurve ?? null,
      // scored | unavailable | error | not_run
      state: au == null ? (model?.state ?? 'unavailable') : 'scored',
    },
    muscular: {
      state: 'not_implemented_v2_0',
      note: 'separate experimental subsystem; never merged into canonical strain (D4)',
    },
    algorithmVersion: ALGORITHM_VERSION,
    profileVersion: prof.version,
    strainSeries: au == null ? [] : strainSeries5Min(increments, dayStart, dayStart + 24 * 3_600_000),
    activities: activityResults,
    notes: [...notes, ...modelNotes, ...prof.notes],
  };
}
