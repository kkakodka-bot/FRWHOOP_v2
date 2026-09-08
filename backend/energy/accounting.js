/**
 * Canonical energy accounting — the single enforced definition of every energy
 * quantity FRWHOOP computes. See docs/ENERGY_ACCOUNTING.md.
 *
 * This module does NOT estimate anything. It enforces the accounting identity so
 * no caller can silently mix gross and net, double count TEF, or let workout
 * energy exceed active energy. Every quantity here is derived from the minute row
 * fields that the engine already produces; this file just makes the bookkeeping
 * explicit and testable.
 */

// ---------------------------------------------------------------------------
// Per-minute accounting
// ---------------------------------------------------------------------------

/**
 * Build the canonical minute energy row from the engine's estimate.
 *
 * @param {object} m
 * @param {number} m.resting_kcal
 * @param {number} m.active_kcal    engine active = total - resting (pre-TEF)
 * @param {number} [m.tef_kcal=0]   thermic effect allocated to this minute
 * @returns canonical minute row
 */
export function accountMinute(m) {
  const resting = num(m.resting_kcal, 0);
  const active = Math.max(0, num(m.active_kcal, 0));
  const tef = Math.max(0, num(m.tef_kcal, 0));
  return {
    ...m,
    resting_kcal: resting,
    active_kcal: active,
    tef_kcal: tef,
    total_kcal: resting + active + tef,
    workout_active_kcal: m.workout_session_id ? active : 0,
  };
}

/** Per-minute accounting invariants. Returns array of violated invariant names. */
export function minuteInvariants(row) {
  const bad = [];
  if (Math.abs(row.total_kcal - (row.resting_kcal + row.active_kcal + row.tef_kcal)) > 1e-6) {
    bad.push('total_not_parts_sum');
  }
  if (row.resting_kcal < 0 || row.active_kcal < 0 || row.tef_kcal < 0) {
    bad.push('negative_component');
  }
  if (row.workout_active_kcal > row.active_kcal + 1e-6) {
    bad.push('workout_exceeds_active');
  }
  if (row.workout_active_kcal !== 0 && !row.workout_session_id) {
    bad.push('workout_kcal_without_session');
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Thermogenic effect of food
// ---------------------------------------------------------------------------

/**
 * TEF ranges by macronutrient, as a fraction of *that nutrient's* kcal, from
 * the diet-induced thermogenesis literature. Protein has the largest thermic
 * cost, carbohydrate intermediate, fat lowest. Reported as a range (lo, hi) to
 * keep it honest as an uncertain quantity.
 */
export const TEF_BY_MACRO = Object.freeze({
  protein: { lo: 0.20, hi: 0.30, source: 'protein DIT ~20-30% of protein kcal (Jequier, Reed 1989/1999 review)' },
  carbs: { lo: 0.05, hi: 0.10, source: 'carb DIT ~5-10% of carb kcal' },
  fat: { lo: 0.0, hi: 0.03, source: 'fat DIT ~0-3% of fat kcal' },
});

/**
 * Population prior for TEF as a fraction of total intake when macro detail is
 * missing. Conservative central value ~10% of a mixed diet's energy.
 */
export const TEF_POPULATION_PRIOR = Object.freeze({
  lo: 0.07, hi: 0.13, central: 0.10,
  source: 'mixed Western diet DIT ~10% of total energy (Reed & Hill 1996)',
});

/**
 * Estimate TEF for a day's logged intake from macronutrients.
 *
 * @param {object} n
 * @param {number} [n.protein_kcal]  kcal of protein on the day
 * @param {number} [n.carbs_kcal]    kcal of carbohydrate
 * @param {number} [n.fat_kcal]      kcal of fat
 * @param {boolean} [n.complete=false] whether the day's logging is complete
 * @returns {{tef_kcal_lo:number, tef_kcal_hi:number, tef_kcal_central:number,
 *            basis:'macro'|'population'|'none', source:string}}
 */
export function estimateTef(n = {}) {
  if (!n.complete) return { tef_kcal_lo: 0, tef_kcal_hi: 0, tef_kcal_central: 0, basis: 'none', source: 'logging_incomplete' };

  // Accept both camelCase and snake_case macro keys (the codebase mixes them).
  const p = num(n.protein_kcal ?? n.proteinKcal, null);
  const c = num(n.carbs_kcal ?? n.carbsKcal, null);
  const f = num(n.fat_kcal ?? n.fatKcal, null);

  if (p == null || c == null || f == null) {
    // Partial macros: fall back to the population prior on the logged total.
    const total = Math.max(0, (p ?? 0) + (c ?? 0) + (f ?? 0) || 0);
    return tefAsPopulation(total);
  }

  const lo = TEF_BY_MACRO.protein.lo * p + TEF_BY_MACRO.carbs.lo * c + TEF_BY_MACRO.fat.lo * f;
  const hi = TEF_BY_MACRO.protein.hi * p + TEF_BY_MACRO.carbs.hi * c + TEF_BY_MACRO.fat.hi * f;
  const central = (lo + hi) / 2;
  return {
    tef_kcal_lo: round(lo, 1), tef_kcal_hi: round(hi, 1), tef_kcal_central: round(central, 1),
    basis: 'macro', source: 'macronutrient DIT ranges',
  };
}

/** TEF from the population prior on a total intake. */
export function tefAsPopulation(totalKcal) {
  const lo = TEF_POPULATION_PRIOR.lo * totalKcal;
  const hi = TEF_POPULATION_PRIOR.hi * totalKcal;
  return {
    tef_kcal_lo: round(lo, 1), tef_kcal_hi: round(hi, 1),
    tef_kcal_central: round(TEF_POPULATION_PRIOR.central * totalKcal, 1),
    basis: 'population', source: TEF_POPULATION_PRIOR.source,
  };
}

// ---------------------------------------------------------------------------
// Daily accounting
// ---------------------------------------------------------------------------

/**
 * Build the canonical daily account from a set of canonical minute rows.
 *
 * @returns {{resting, active, workout_active, neat, tef, total_physiological,
 *            total_sensor_excl_tef, gross_workout, net_workout}}
 */
export function accountDay(minutes) {
  let resting = 0, active = 0, workoutActive = 0, tef = 0, gross = 0, net = 0;
  for (const m of minutes) {
    const row = m.total_kcal == null ? accountMinute(m) : m;
    resting += row.resting_kcal;
    active += row.active_kcal;
    tef += row.tef_kcal || 0;
    if (row.workout_session_id || row.workout_active_kcal > 0) {
      workoutActive += row.active_kcal;
      gross += row.resting_kcal + row.active_kcal;
      net += row.active_kcal;
    }
  }
  return {
    resting_kcal: round(resting, 2),
    active_kcal: round(active, 2),
    workout_active_kcal: round(workoutActive, 2),
    neat_kcal: round(Math.max(0, active - workoutActive), 2),
    tef_kcal: round(tef, 2),
    // Physiological TDEE = resting + PAEE + TEF. This is what a consumer who
    // wants "how much did I burn, full stop" should read.
    total_physiological_kcal: round(resting + active + tef, 2),
    // Sensor-model only (WHOOP-comparable): no TEF, matching how WHOOP reports.
    total_sensor_excl_tef_kcal: round(resting + active, 2),
    gross_workout_kcal: round(gross, 2),
    net_workout_kcal: round(net, 2),
  };
}

/** Daily accounting invariants. Returns array of violated invariant names. */
export function dayInvariants(d) {
  const bad = [];
  if (d.total_physiological_kcal < d.resting_kcal + d.active_kcal - 1) bad.push('total_phys_below_sensor');
  if (d.workout_active_kcal > d.active_kcal + 1) bad.push('workout_exceeds_active');
  if (d.neat_kcal < 0) bad.push('negative_neat');
  if (d.net_workout_kcal > d.gross_workout_kcal + 1) bad.push('net_exceeds_gross');
  return bad;
}

function round(n, p) {
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
}
function num(v, dflt) {
  if (v == null || !Number.isFinite(v)) return dflt;
  return v;
}

/**
 * Energy samples from different devices must never be summed just because they
 * share a quantity type. Overlapping FRWHOOP + Apple (or two workout copies)
 * returns an error instead of a number. Non-overlapping intervals of the *same*
 * logical series may be added by this dedicated aggregator.
 */
export function combineActiveEnergy(parts = []) {
  const rows = (Array.isArray(parts) ? parts : [])
    .map((p) => ({
      source: p.source,
      kcal: num(p.kcal ?? p.active_kcal ?? p.value, 0),
      start: p.start == null ? null : (typeof p.start === 'number' ? p.start : Date.parse(p.start)),
      end: p.end == null ? null : (typeof p.end === 'number' ? p.end : Date.parse(p.end)),
    }))
    .filter((p) => p.kcal > 0);

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      const sameSource = a.source === b.source;
      const aOpen = !Number.isFinite(a.start) || !Number.isFinite(a.end);
      const bOpen = !Number.isFinite(b.start) || !Number.isFinite(b.end);
      const overlap = !aOpen && !bOpen && Math.min(a.end, b.end) > Math.max(a.start, b.start);
      if (!sameSource && (overlap || aOpen || bOpen)) {
        return {
          ok: false,
          kcal: null,
          error: 'overlapping_energy_sources',
          sources: [a.source, b.source],
        };
      }
      if (sameSource && overlap) {
        return {
          ok: false,
          kcal: null,
          error: 'duplicate_energy_interval',
          sources: [a.source],
        };
      }
    }
  }
  return { ok: true, kcal: round(rows.reduce((s, r) => s + r.kcal, 0), 2), error: null };
}
