import { METHODOLOGY_VERSION, getMethodology } from './methodology.js';
import {
  collectDays, extraWorkoutsFromStore, profileFromStore, computeVo2FromData,
} from './adapter.js';
import {
  appendLabAnchor, ensureVo2Store, listLabAnchors, listSnapshots, persistSnapshot,
  previousSnapshot, setHrMaxOverride, snapshotIsFresh,
} from './repository.js';

function serialize(result) {
  if (!result || result.error) return result;
  return {
    vo2Max: result.vo2Max,
    unit: result.unit,
    tier: result.tier,
    eligibility: result.eligibility,
    dataQualityScore: result.dataQualityScore,
    confidence: result.confidence,
    coverage: result.coverage,
    sources: result.sources,
    hrMax: result.hrMax,
    trend: result.trend,
    weightKg: result.weightKg,
    gps: result.gps,
    lab: result.lab,
    methodologyVersion: result.methodologyVersion,
    modelVersion: result.modelVersion,
    featureVersion: result.featureVersion,
    smoothingVersion: result.smoothingVersion,
    calculatedAt: result.calculatedAt,
    effectiveDate: result.effectiveDate,
    asOfDay: result.asOfDay,
    disclaimer: result.disclaimer,
  };
}

export function calculateForStore(store, { asOfDay, persist = true, force = false } = {}) {
  ensureVo2Store(store);
  const days = collectDays(store);
  const profile = profileFromStore(store, asOfDay);
  const extraWorkouts = extraWorkoutsFromStore(store);
  const probe = computeVo2FromData({
    days,
    profile,
    extraWorkouts,
    labAnchors: store.vo2.labAnchors,
    hrMaxOverride: store.vo2.hrMaxOverride,
    asOfDay,
    methodologyVersion: METHODOLOGY_VERSION,
  });
  if (probe.error) return { result: probe, store, snapshot: null };

  const result = computeVo2FromData({
    days,
    profile,
    extraWorkouts,
    labAnchors: store.vo2.labAnchors,
    hrMaxOverride: store.vo2.hrMaxOverride,
    priorSnapshot: previousSnapshot(store, probe.effectiveDate, METHODOLOGY_VERSION),
    asOfDay,
    methodologyVersion: METHODOLOGY_VERSION,
  });

  let snapshot = store.vo2.latest;
  if (persist && (force || !snapshotIsFresh(snapshot, result.asOfDay))) {
    snapshot = persistSnapshot(store, result).snapshot;
  }
  return { result: serialize(result), store, snapshot };
}

export function historyForStore(store, { limit } = {}) {
  ensureVo2Store(store);
  return listSnapshots(store, { limit });
}

export function addLabForStore(store, body) {
  ensureVo2Store(store);
  const { result } = calculateForStore(store, { persist: false, force: true });
  const saved = appendLabAnchor(store, {
    ...body,
    modelAtAnchor: result?.sources?.passiveEstimate ?? result?.sources?.uthBaseline ?? result?.vo2Max,
    methodologyVersion: METHODOLOGY_VERSION,
    modelVersion: result?.modelVersion,
    featureVersion: result?.featureVersion,
  });
  if (saved.error) return saved;
  const next = calculateForStore(store, { persist: true, force: true });
  return { ...next, anchor: saved.anchor };
}

export function setHrMaxForStore(store, value) {
  const saved = setHrMaxOverride(store, value);
  if (saved.error) return saved;
  const next = calculateForStore(store, { persist: true, force: true });
  return { ...next, hrMaxOverride: saved.hrMaxOverride };
}

export function methodologyPublic() {
  const m = getMethodology();
  return {
    version: m.version,
    modelVersion: m.modelVersion,
    featureVersion: m.featureVersion,
    smoothingVersion: m.smoothingVersion,
    unit: m.unit,
    windows: m.windows,
    eligibility: m.eligibility,
    disclaimer: m.disclaimer,
    documentation: '/docs/vo2-max-methodology.md',
  };
}

export { listLabAnchors };
