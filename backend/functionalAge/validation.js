/**
 * Black-box calibration harness. Scientific prior curves stay in hazardCurves.js;
 * this module only scores paired WHOOP observations if we later supply them.
 */
export function scoreObservations(rows, predictFn) {
  const pairs = [];
  for (const row of rows || []) {
    const predicted = predictFn(row);
    if (!predicted || !Number.isFinite(predicted.functionalAge) || !Number.isFinite(Number(row.actualWhoopAge))) continue;
    pairs.push({
      date: row.date,
      actualAge: Number(row.actualWhoopAge),
      predictedAge: predicted.functionalAge,
      residual: predicted.functionalAge - Number(row.actualWhoopAge),
      actualPace: row.actualWhoopPace == null ? null : Number(row.actualWhoopPace),
      predictedPace: predicted.paceOfAging,
      contributors: predicted.contributors,
    });
  }
  const n = pairs.length;
  if (!n) {
    return { n: 0, mae: null, rmse: null, bias: null, correlation: null, paceMae: null, paceDirectionAccuracy: null, pairs: [] };
  }
  const errs = pairs.map((p) => p.residual);
  const mae = errs.reduce((s, e) => s + Math.abs(e), 0) / n;
  const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / n);
  const bias = errs.reduce((s, e) => s + e, 0) / n;
  const correlation = pearson(pairs.map((p) => p.actualAge), pairs.map((p) => p.predictedAge));

  const pacePairs = pairs.filter((p) => Number.isFinite(p.actualPace) && Number.isFinite(p.predictedPace));
  const paceMae = pacePairs.length
    ? pacePairs.reduce((s, p) => s + Math.abs(p.predictedPace - p.actualPace), 0) / pacePairs.length
    : null;
  const paceDirectionAccuracy = pacePairs.length
    ? pacePairs.filter((p) => Math.sign(p.predictedPace - 1) === Math.sign(p.actualPace - 1) || (Math.abs(p.predictedPace - 1) < 0.05 && Math.abs(p.actualPace - 1) < 0.05)).length / pacePairs.length
    : null;

  const perContributor = {};
  for (const p of pairs) {
    for (const c of p.contributors || []) {
      if (!perContributor[c.key]) perContributor[c.key] = { n: 0, meanImpact: 0 };
      perContributor[c.key].n += 1;
      perContributor[c.key].meanImpact += c.ageImpactYears;
    }
  }
  for (const k of Object.keys(perContributor)) {
    perContributor[k].meanImpact /= perContributor[k].n;
  }

  return {
    n,
    mae,
    rmse,
    bias,
    correlation,
    paceMae,
    paceDirectionAccuracy,
    perContributor,
    pairs,
  };
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}
