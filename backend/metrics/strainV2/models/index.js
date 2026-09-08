// FRWHOOP Strain V2 — cardio-load model registry + common interface
//
// Layer 3+5 (D3, D5): cardiovascular internal-load models and the display
// transform. One interface for every model:
//
//   scoreModel(name, { epochs, profile, thresholds, config }) -> {
//     au: number|null,                 // raw TRIMP AU, minute-weighted; null if insufficient
//     increments: [{ t: epochStartMs, au: number }],
//     model: { name, version, params, weightCurve },
//     notes: string[],
//   }
//
// Inputs are Layer-1 epochs [{ t, hr, hrrFrac, coverage, quality }]:
//   - UNKNOWN epochs contribute 0 AU and are EXCLUDED from scorable duration
//     (never zero-weight invented duration).
//   - Per-epoch increment = weight(hrrFrac) * scorableMinutes(coverage);
//     duration comes from EPOCH coverage (fraction of expected samples valid),
//     not sample count — the metric is invariant to packet frequency.
//   - Duplicate epochs (same t) are deduped keeping the best quality (D1).
//
// Lucia and individualized return model:'unavailable' + null au when their
// thresholds/curve are absent — they never throw and never silently fall back.
//
// Default-model stance (decided by ground-truth replay: _strain_v2/
// work_weee_model_comparison.md, 17 subjects x 6 MET-labeled stages vs
// chest-strap HR): banister continuous HRR TRIMP is the default DAILY scorer
// (best MET-tracking in every pool; nonzero across the full intensity range).
// stagno remains available for intermittent session scoring (lactate-anchored
// high-intensity weighting, but zero below 50% HRR); lucia/individualized are
// power-user tiers requiring a graded test; edwards is V1 parity only.

import scoreEdwards, { weight as edwardsWeight, WEIGHT_CURVE as EDWARDS_CURVE, VERSION as EDWARDS_VERSION } from './edwards.js';
import scoreBanister, { weight as banisterWeight, coefficients as banisterCoefficients, MALE_PARAMS as BANISTER_MALE, FEMALE_PARAMS as BANISTER_FEMALE, VERSION as BANISTER_VERSION } from './banister.js';
import scoreStagno, { weight as stagnoWeight, WEIGHT_CURVE as STAGNO_CURVE, ZONES as STAGNO_ZONES, VERSION as STAGNO_VERSION } from './stagno.js';
import scoreLucia, { VERSION as LUCIA_VERSION } from './lucia.js';
import scoreIndividualized, { VERSION as INDIVIDUALIZED_VERSION } from './individualized.js';

export { default as scoreEdwards, weight as edwardsWeight, WEIGHT_CURVE as EDWARDS_CURVE, VERSION as EDWARDS_VERSION } from './edwards.js';
export { default as scoreBanister, weight as banisterWeight, coefficients as banisterCoefficients, MALE_PARAMS as BANISTER_MALE, FEMALE_PARAMS as BANISTER_FEMALE, VERSION as BANISTER_VERSION } from './banister.js';
export { default as scoreStagno, weight as stagnoWeight, WEIGHT_CURVE as STAGNO_CURVE, ZONES as STAGNO_ZONES, VERSION as STAGNO_VERSION } from './stagno.js';
export { default as scoreLucia, VERSION as LUCIA_VERSION } from './lucia.js';
export { default as scoreIndividualized, VERSION as INDIVIDUALIZED_VERSION } from './individualized.js';

// DEFAULT-MODEL DECISION (replay evidence, scripts/strainV2WeeeCompare.mjs):
// 17-subject chest-strap staged protocol vs MET-minutes ground truth:
//   banister r=0.6630/rho=0.8028 (n=96) — best in ALL pools (primary,
//   exercise-only, sensitivity). Stagno worst (0.5707/0.5874): its zones start
//   at 50% HRR so light daily activity (sit/stand/walk) scores 0 AU — wrong
//   for a DAILY internal-load construct. Banister is continuous over the full
//   range and remains the most-established TRIMP formulation.
export const DEFAULT_MODEL = 'banister';

export const MODELS = {
  edwards: { score: scoreEdwards, defaultModel: false },
  banister: { score: scoreBanister, defaultModel: true },
  stagno: { score: scoreStagno, defaultModel: false, note: 'session-scoring option; zero below 50% HRR' },
  lucia: { score: scoreLucia, defaultModel: false, requires: 'thresholds (vt1/vt2 bpm or lt1/lt2 HRR)' },
  individualized: { score: scoreIndividualized, defaultModel: false, requires: 'individual curve (config.curve)' },
};

// Canonical entry point. Unknown model name is a programmer error and throws a
// clear Error; model-specific missing optional inputs (thresholds/curve) are
// handled by the models themselves and never throw.
export function scoreModel(name, opts = {}) {
  const entry = MODELS[name];
  if (!entry) {
    const known = Object.keys(MODELS).join(', ');
    throw new Error(`scoreModel: unknown strain model "${name}" (known: ${known})`);
  }
  return entry.score(opts);
}

export function listModels() {
  return Object.keys(MODELS);
}

export function modelMeta() {
  return Object.entries(MODELS).map(([name, entry]) => ({
    name,
    defaultModel: entry.defaultModel,
    requires: entry.requires ?? null,
    note: entry.note ?? null,
      ...(entry.defaultModel ? { recommendation: 'ground-truth replay: _strain_v2/work_weee_model_comparison.md (banister best tracks MET-minutes in every pool)' } : {}),
  }));
}
