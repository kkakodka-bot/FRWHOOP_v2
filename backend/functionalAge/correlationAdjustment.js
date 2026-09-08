import { sameSign } from './math.js';
import { CONTRIBUTOR_KEYS, getMethodology, METHODOLOGY_VERSION } from './methodology.js';

/**
 * Conservative overlap adjustment. Not WHOOP's SEM coefficients.
 *
 * For each contributor, shrink log-hazard toward its unique-variance fraction
 * in proportion to how many same-sign partners in overlapping pathway groups
 * are actually present. A lone non-neutral contributor is left unshrunk.
 */
export function adjustLogHazards(rawLogHr, availability, version = METHODOLOGY_VERSION) {
  const { overlap } = getMethodology(version);
  const adjusted = {};
  for (const key of CONTRIBUTOR_KEYS) {
    const raw = Number(rawLogHr[key]) || 0;
    if (!availability[key] || raw === 0) {
      adjusted[key] = 0;
      continue;
    }
    const partners = new Set();
    const possible = new Set();
    for (const group of overlap.groups) {
      if (!group.members.includes(key)) continue;
      for (const member of group.members) {
        if (member === key) continue;
        possible.add(member);
        if (availability[member] && sameSign(raw, rawLogHr[member] || 0)) partners.add(member);
      }
    }
    const unique = overlap.uniqueVariance[key] ?? 1;
    const partnerFraction = possible.size ? partners.size / possible.size : 0;
    const lambda = unique + (1 - unique) * (1 - partnerFraction);
    adjusted[key] = raw * lambda;
  }
  return adjusted;
}

export function adjustHazardRatios(rawHrs, availability, version = METHODOLOGY_VERSION) {
  const rawLog = {};
  for (const key of CONTRIBUTOR_KEYS) {
    const hr = Number(rawHrs[key]);
    rawLog[key] = Number.isFinite(hr) && hr > 0 ? Math.log(hr) : 0;
  }
  const adjLog = adjustLogHazards(rawLog, availability, version);
  const adjusted = {};
  for (const key of CONTRIBUTOR_KEYS) {
    adjusted[key] = availability[key] ? Math.exp(adjLog[key]) : 1;
  }
  return { rawLog, adjLog, adjustedHrs: adjusted };
}
