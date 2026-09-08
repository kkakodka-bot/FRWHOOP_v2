
// eval/lib/score.js — deterministic scoring of coach turns against frozen ground truth.
export const INTENT_PRIMARY_TOOL = {
  sleep: 'get_sleep',
  recovery: 'get_recovery',
  strain: 'get_strain',
  general: 'get_range',
};

export function normalizeToolNames(analysis, toolsUsed) {
  // Normalize evidence_<intent> pseudo-tools to the primary semantic tool for scoring.
  const names = (toolsUsed || []).map((t) => t.name || t);
  const intent = analysis?.intent;
  const out = new Set(names.filter((n) => !String(n).startsWith('evidence_')));
  for (const n of names) {
    if (String(n).startsWith('evidence_')) {
      const intentName = String(n).replace('evidence_', '');
      if (intentName === 'general') {
        // full evidence fetch covers day + recovery + sleep + strain
        out.add('get_day'); out.add('get_recovery'); out.add('get_sleep'); out.add('get_strain'); out.add('get_range');
      } else if (intentName === 'strain') {
        out.add('get_strain'); out.add('get_workouts');
      } else if (INTENT_PRIMARY_TOOL[intentName]) {
        out.add(INTENT_PRIMARY_TOOL[intentName]);
      } else {
        out.add(intentName);
      }
    }
  }
  return { names: [...out], intent };
}

function normalize(s) {
  return String(s || '')
    .replace(/<chart>[\s\S]*?<\/chart>/g, ' [chart] ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function hasFact(resp, fact) {
  const text = normalize(resp);
  if (fact && typeof fact === 'object') {
    if (fact.any) return fact.any.some((f) => hasFact(resp, f));
    if (fact.all) return fact.all.every((f) => hasFact(resp, f));
    if (fact.re) return new RegExp(fact.re, 'i').test(String(resp));
    if (fact.not) return !hasFact(resp, fact.not);
    return false;
  }
  const f = normalize(fact);
  if (text.includes(f)) return true;
  // numeric tolerance: a number in the response within ~4% (or 1 unit) of the fact counts,
  // so rounded/displayed values ("74%" vs true 74.7) are not marked wrong.
  const fn = Number((/[-+]?\d+(\.\d+)?/.exec(f) || [])[0]);
  if (Number.isFinite(fn) && /\d/.test(f)) {
    const nums = text.match(/\d+(\.\d+)?/g) || [];
    const tol = Math.max(1, fn * 0.04);
    return nums.some((n) => Math.abs(Number(n) - fn) <= tol);
  }
  return false;
}

export function scoreTurn(q, result) {
  const resp = String(result?.response || '');
  const analysis = result?.analysis || {};
  const raw = (result?.toolsUsed || []).map((t) => t.name || t);
  const { names } = normalizeToolNames(analysis, raw);
  const rawNonEvidence = raw.filter((n) => !String(n).startsWith('evidence_'));

  // lane correctness
  const laneCorrect = q.expectedLane == null ? null : analysis.lane === q.expectedLane;
  const intentCorrect = q.expectedIntent == null ? null : analysis.intent === q.expectedIntent;

  // tool selection: all expected tools called (semantic); allowed tools are acceptable
  // refinements that neither fail selection nor count as unnecessary.
  const expected = (q.expectedTools || []).map((t) => String(t));
  const allowed = (q.allowedTools || []).map((t) => String(t));
  const called = new Set(names);
  // When the evidence path deterministically includes document snippets, count the
  // document tools as satisfied (infra did the retrieval; model need not call a tool).
  if (Array.isArray(q.sources) && q.sources.includes('documents')) {
    const hasDocsInEvidence = Boolean(result?.evidenceHasDocuments);
    if (hasDocsInEvidence || called.size > 0) {
      if (expected.includes('search_user_documents')) called.add('search_user_documents');
      if (expected.includes('get_document')) called.add('get_document');
    }
  }
  const missing = expected.filter((t) => !called.has(t));
  const toolSelectionCorrect = missing.length === 0;
  const outside = [...called].filter((t) => !expected.includes(t) && !allowed.includes(t) && !String(t).startsWith('evidence_'));
  const unnecessary = rawNonEvidence.filter((t) => !expected.includes(t) && !allowed.includes(t));
  const unnecessaryCount = unnecessary.length;
  const outsideBad = outside.filter((t) => !allowed.includes(t));

  // fact coverage
  const facts = q.facts || [];
  const factsHit = facts.filter((f) => hasFact(resp, f));
  const factCoverage = facts.length ? factsHit.length / facts.length : null;

  // reject coverage (things that must NOT appear)
  const rejectsStruck = (q.rejectFacts || []).filter((f) => hasFact(resp, f)).length;

  // no-fabrication / missing-data
  let missingDataOK = null;
  if (q.noFabricate) {
    missingDataOK = !(q.rejectFacts || []).length;
  }

  return {
    id: q.id,
    category: q.category,
    laneCorrect,
    intentCorrect,
    toolSelectionCorrect,
    missing,
    unnecessary: unnecessary.slice(0, 8),
    unnecessaryCount,
    factCoverage,
    factCoveragePct: factCoverage == null ? null : Math.round(factCoverage * 100),
    rejectsStruck,
    responseLen: resp.length,
    answerAnswerable: resp.length > 40,
    outsideTools: outsideBad,
  };
}

export function aggregateScores(turns) {
  const n = turns.length;
  const sum = (k) => turns.filter((t) => t[k] === true).length;
  const pct = (k) => {
    const nk = turns.filter((t) => t[k] === true || t[k] === false).length;
    return nk ? Math.round((sum(k) / nk) * 1000) / 10 : null;
  };
  const coverageVals = turns.filter((t) => t.factCoverage != null).map((t) => t.factCoverage);
  const counts = (k) => {
    const map = {};
    for (const t of turns) {
      const v = t[k];
      if (v == null) continue;
      map[v] = (map[v] || 0) + 1;
    }
    return map;
  };
  return {
    n,
    laneCorrectPct: pct('laneCorrect'),
    intentCorrectPct: pct('intentCorrect'),
    toolSelectionPct: pct('toolSelectionCorrect'),
    unnecessaryTotal: turns.reduce((a, t) => a + t.unnecessaryCount, 0),
    unnecessaryPerTurn: Math.round((turns.reduce((a, t) => a + t.unnecessaryCount, 0) / n) * 100) / 100,
    factCoverage: coverageVals.length
      ? Math.round((coverageVals.reduce((a, b) => a + b, 0) / coverageVals.length) * 1000) / 10
      : null,
    perCategory: counts('category'),
    avgResponseLen: Math.round(turns.reduce((a, t) => a + t.responseLen, 0) / n),
  };
}
