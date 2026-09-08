
/**
 * Session-level scorability and uncertainty summary (Phase 14).
 *
 * Thirty-second sleep staging is inherently uncertain and every epoch is NOT
 * equally trustworthy. This turns the per-epoch model output + input coverage
 * into an honest session-level summary: how much of the night was high/medium/
 * low confidence, how much input coverage each modality had, off-wrist time,
 * which model/failback ran — so a night with, say, half the PPG missing is not
 * reported with the same certainty as a clean one.
 */

export function stageConfidence(probs, coverage) {
  const maxP = Math.max(...Object.values(probs || {}));
  if (coverage < 1 / 3 || maxP < 0.35) return 'low';
  if (coverage >= 2 / 3 && maxP >= 0.8) return 'high';
  return 'medium';
}

export function sessionScorability({
  epochs = [],
  offWristDurationMin = null,
  detector = null,
  fallbackReason = null,
  model = 'sleep_stager_v2',
} = {}) {
  let high = 0, medium = 0, low = 0, n = 0;
  let hrCoverage = 0, rrCoverage = 0, accCoverage = 0, ppgCoverage = 0, imuCoverage = 0;
  for (const e of epochs) {
    const c = stageConfidence(e.probs, e.coverage);
    if (c === 'high') high += 1; else if (c === 'low') low += 1; else medium += 1;
    n += 1;
    if (e.hrPresent) hrCoverage += 1;
    if (e.rrPresent) rrCoverage += 1;
    if (e.accPresent) accCoverage += 1;
    if (e.ppgPresent) ppgCoverage += 1;
    if (e.imuPresent) imuCoverage += 1;
  }
  const frac = (x) => (n ? Math.round(x / n * 1000) / 1000 : 0);
  return {
    epochCount: n,
    pctHighConfidence: frac(high),
    pctMediumConfidence: frac(medium),
    pctLowConfidence: frac(low),
    ppgCoverage: frac(ppgCoverage),
    imuCoverage: frac(imuCoverage),
    hrCoverage: frac(hrCoverage),
    rrCoverage: frac(rrCoverage),
    accCoverage: frac(accCoverage),
    offWristDurationMin,
    model,
    fallbackReason,
    detector,
    fallback: Boolean(fallbackReason && fallbackReason !== 'none'),
  };
}
