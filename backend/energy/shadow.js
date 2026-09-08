
/**
 * Shadow deployment / model-comparison + rollback (Phase 16 "shadow deployment and
 * rollback", required final-state item #19).
 *
 * A candidate model is never promoted on a single in-sample win and never swapped
 * in-place. This module runs PRODUCTION and CANDIDATE estimates side by side over
 * the same inputs, tags every estimate with its model version, records the
 * comparison, and keeps enough provenance to roll back to the previous version
 * deterministically.
 *
 * Shadow contract:
 *   - every estimate carries model_version + the source inputs hash (so a
 *     result is reproducible from B2).
 *   - production_vs_candidate rows keep BOTH numbers + their shared provenance.
 *   - promotion is explicit (activateCandidate), changes a registry pointer,
 *     never mutates historical rows.
 *   - rollback re-points to the previous version; because all rows are versioned
 *     and recomputable, old outputs can be regenerated rather than guessed.
 */
import { createHash } from 'node:crypto';

export function inputsHash(samples, opts = {}) {
  const h = createHash('sha256');
  // stable fingerprint: sorted unique sample timestamps + count + a few params
  const ts = [...new Set((samples || []).map((s) => s?.t ?? s?.datetime ?? s?.at)).values()].sort();
  h.update(JSON.stringify({ count: samples?.length, ts: ts.slice(0, 500), ...opts }));
  return h.digest('hex').slice(0, 16);
}

/**
 * Run the same inputs through two estimators side by side (shadow mode).
 *
 * @param {object} o
 * @param {Function} o.production  (inputs) => {minutes, stats}
 * @param {Function} o.candidate   (inputs) => {minutes, stats}
 * @param {object}  o.inputs       shared args passed to both
 * @param {string}  o.modelVersion prod version id
 * @param {string}  o.candidateVersion cand version id
 * @returns shadow record (both outputs + provenance + comparison)
 */
export function runShadow({ production, candidate, inputs, modelVersion, candidateVersion } = {}) {
  const prod = production(inputs);
  const cand = candidate(inputs);
  const prodTotal = dayTotal(prod.minutes);
  const candTotal = dayTotal(cand.minutes);
  const h = inputsHash(inputs.samples, { modelVersion, candidateVersion });
  return {
    produced_at: new Date().toISOString(),
    inputs_hash: h,
    model_version: modelVersion,
    candidate_version: candidateVersion,
    production: { minutes: prod.minutes, stats: prod.stats, total_kcal: prodTotal },
    candidate: { minutes: cand.minutes, stats: cand.stats, total_kcal: candTotal },
    comparison: {
      prod_total_kcal: prodTotal, cand_total_kcal: candTotal,
      delta_kcal: round(candTotal - prodTotal, 2),
      prod_skipped: prod.stats.skipped, cand_skipped: cand.stats.skipped,
    },
  };
}

function dayTotal(minutes) {
  return (minutes || []).reduce((a, m) => a + (m.total_kcal ?? (m.resting_kcal + m.active_kcal)), 0);
}

/**
 * Simple in-memory/registrar of active model versions + rollback.
 *
 * @param {object} o
 * @param {string} o.active initial active version
 * @returns {{
 *   active:()=>string,
 *   activate:(v)=>void,
 *   history:()=>Array,
 *   rollback:()=>string|undefined
 * }}
 */
export function createVersionRegistry(o = {}) {
  const history = [{ version: o.active ?? 'prod', activatedAt: new Date().toISOString() }];
  let active = history[history.length - 1].version;
  return {
    active: () => active,
    activate(v) {
      history.push({ version: v, activatedAt: new Date().toISOString() });
      active = v;
      return v;
    },
    history: () => history.slice(),
    rollback() {
      const idx = history.findIndex((e) => e.version === active);
      const prev = history[idx - 1];
      if (prev) { active = prev.version; history.push({ version: active, activatedAt: new Date().toISOString(), rollback: true }); }
      return prev ? prev.version : undefined;
    },
    current: active,
  };
}

function round(n, p = 2) { const f = 10 ** p; return Math.round(n * f) / f; }

export { round };
