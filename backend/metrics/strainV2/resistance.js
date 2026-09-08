import {
  RESISTANCE_SUBSYSTEM_VERSION,
  BODY_MASS_FRACTIONS,
  exerciseFamily,
} from './resistanceTable.js';

/**
 * FRWHOOP Strain V2 — Layer 4: resistance / mechanical load subsystem.
 * EXPERIMENTAL. See _strain_v2/ARCHITECTURE_DRAFT.md (D4) and
 * _strain_v2/work_lit_resistance.md for the evidence base.
 *
 * HARD RULES (from the literature, not convention):
 * - HR-based TRIMP structurally under-scores lifting (pressor response +
 *   occlusion: MacDougall 1985/1992; hard sets reach only ~72% HRmax:
 *   Macedo 2025). Cardio load is therefore NEVER used as a proxy for lifting.
 * - A wrist accelerometer sum (PlayerLoad-style AU) measures kinematic motion
 *   only (r=-0.43..0.33 vs VO2/HR, Barrett 2014) and must not be equated with
 *   muscular tissue stress (Impellizzeri 2019). We do not produce such a sum.
 * - No universal "muscular arbitrary unit" coefficient is invented here. This
 *   module emits TRANSPARENT FEATURES only; combining them into a single score
 *   without construct validation is explicitly out of scope (v2.0).
 * - Wrist IMU cannot substitute a bar encoder for absolute velocity
 *   (PUSH band valid only in narrow windows: Orange 2019, Callaghan 2022;
 *   under-estimates 1RM by ~14 kg: van den Tillaar 2019). Velocity fields are
 *   passthrough provenance, never load-converted.
 *
 * All functions are pure and deterministic.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Per-exercise transparent features.
 * set: { reps, loadKg, bodyMassFraction?, romDeg?, meanConcentricMs?, rir? }
 */
export function exerciseFeatures({ name, family, sets, bodyMassKg, oneRmKg }) {
  const fam = family || exerciseFamily(name);
  const meta = BODY_MASS_FRACTIONS[fam] || { value: null, evidence: 'unknown family' };
  const clean = (sets || [])
    .map((s) => ({
      reps: num(s?.reps),
      loadKg: num(s?.loadKg),
      bodyMassFraction: s?.bodyMassFraction != null ? num(s.bodyMassFraction) : null,
      romDeg: num(s?.romDeg),
      meanConcentricMs: num(s?.meanConcentricMs),
      rir: num(s?.rir),
    }))
    .filter((s) => s.reps != null && s.reps > 0);

  const totalReps = clean.reduce((acc, s) => acc + s.reps, 0);
  const externalVolumeLoad = clean.reduce(
    (acc, s) => acc + s.reps * Math.max(0, s.loadKg ?? 0), 0,
  );

  // Effective moving mass per set: external load + (body-mass fraction x body
  // mass). Requires a KNOWN family fraction; unknown families stay null rather
  // than guessing (the mission forbids inventing coefficients).
  let effectiveVolumeLoad = null;
  if (meta.value != null && bodyMassKg != null && bodyMassKg > 0) {
    effectiveVolumeLoad = clean.reduce((acc, s) => {
      const frac = s.bodyMassFraction ?? meta.value;
      const movingMass = Math.max(s.loadKg ?? 0, 0) + frac * bodyMassKg;
      return acc + s.reps * movingMass;
    }, 0);
  }

  // Relative intensity: per-set %1RM when both exist.
  let relativeIntensity = null;
  if (oneRmKg != null && oneRmKg > 0) {
    const loaded = clean.filter((s) => s.loadKg != null && s.loadKg > 0);
    if (loaded.length) {
      relativeIntensity = loaded.map((s) => Math.round((s.loadKg / oneRmKg) * 1000) / 1000);
    }
  }

  return {
    name: name || null,
    family: fam,
    sets: clean.length,
    totalReps,
    externalVolumeLoadKg: Math.round(externalVolumeLoad * 10) / 10,
    effectiveVolumeLoadKg: effectiveVolumeLoad == null ? null : Math.round(effectiveVolumeLoad * 10) / 10,
    bodyMassFractionUsed: meta.value,
    bodyMassFractionEvidence: meta.evidence,
    relativeIntensity,
    notes: meta.value == null ? ['unknown_family_effective_mass_suppressed'] : [],
  };
}

/**
 * Session-level structured features for one resistance activity.
 * activity: {
 *   name, durationMin,
 *   exercises: [{ name, family?, sets: [...], oneRmKg? }],
 *   bodyMassKg, sessionRpe0to10?
 * }
 * Returns { state: 'experimental', features, sessionRpe, ... }. There is NO
 * 'muscularStrain' scalar here by design: until a validation plan passes, V2
 * does not claim a universal muscular load unit (D4).
 */
export function resistanceFeatures(activity = {}) {
  const bodyMassKg = num(activity.bodyMassKg);
  const exerciseRows = (activity.exercises || []).map((ex) => exerciseFeatures({
    name: ex?.name,
    family: ex?.family,
    sets: ex?.sets,
    bodyMassKg,
    oneRmKg: num(ex?.oneRmKg),
  }));

  const externalTotal = exerciseRows.reduce((acc, ex) => acc + ex.externalVolumeLoadKg, 0);
  const effectiveTotal = exerciseRows.some((ex) => ex.effectiveVolumeLoadKg == null)
    ? null
    : exerciseRows.reduce((acc, ex) => acc + ex.effectiveVolumeLoadKg, 0);

  const features = {
    externalVolumeLoadKg: Math.round(externalTotal * 10) / 10,
    effectiveVolumeLoadKg: effectiveTotal == null ? null : Math.round(effectiveTotal * 10) / 10,
    totalReps: exerciseRows.reduce((acc, ex) => acc + ex.totalReps, 0),
    totalSets: exerciseRows.reduce((acc, ex) => acc + ex.sets, 0),
    exercises: exerciseRows,
  };

  const sRpe = num(activity.sessionRpe0to10);
  const durationMin = num(activity.durationMin);
  const sessionRpe = sRpe != null && durationMin != null && sRpe >= 0 && sRpe <= 10
    ? {
      kind: 'session_rpe_foster',
      au: Math.round(sRpe * durationMin * 10) / 10,
      evidence: 'Foster 2001 - best-validated resistance internal load (work_lit_resistance.md §1)',
    }
    : null;

  return {
    state: 'experimental',
    version: RESISTANCE_SUBSYSTEM_VERSION,
    features,
    sessionRpe,
    mergedMuscularStrain: null, // intentionally absent: no validated construct (D4)
    notes: [
      'features_only_no_universal_au_coefficient',
      'wrist_imu_velocity_not_converted_to_load',
      'not_merged_into_canonical_strain',
      ...exerciseRows.flatMap((ex) => ex.notes.map((n) => `${ex.name || 'unnamed'}: ${n}`)),
    ],
  };
}
