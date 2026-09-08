import { clamp, roundTo } from './math.js';
import { getMethodology, METHODOLOGY_VERSION } from './methodology.js';
import { calculateFunctionalAge } from './engine.js';

export function calculatePaceOfAging({
  current,
  recentMetrics,
  confidence,
  sex,
  chronologicalAge,
  methodologyVersion = METHODOLOGY_VERSION,
}) {
  const m = getMethodology(methodologyVersion);
  const horizon = m.windows.paceHorizonYears;
  const currentResult = current || calculateFunctionalAge({
    chronologicalAge,
    sex,
    metrics: recentMetrics,
    confidence,
    methodologyVersion,
  });
  const projectedChronologicalAge = currentResult.chronologicalAge + horizon;
  const projected = calculateFunctionalAge({
    chronologicalAge: projectedChronologicalAge,
    sex: sex || currentResult.sex,
    metrics: recentMetrics,
    confidence,
    methodologyVersion,
  });
  const raw = (projected.functionalAge - currentResult.functionalAge) / horizon;
  const display = clamp(raw, m.paceDisplayClamp.min, m.paceDisplayClamp.max);
  return {
    paceOfAgingRaw: roundTo(raw, 4),
    paceOfAging: roundTo(display, 3),
    paceOfAgingDisplay: roundTo(display, 3),
    projectedChronologicalAge: roundTo(projectedChronologicalAge, 3),
    projectedFunctionalAge: projected.functionalAge,
    projectedAgeDelta: projected.ageDelta,
    projectedContributors: projected.contributors,
    horizonYears: horizon,
  };
}
