import { loadWhoopDays } from '../host/whoopDays.js';
import { extraWorkoutsFromStore, computeHealthspanFromData, daysFromWhoopMap } from './adapter.js';
import {
  ensureFunctionalAgeStore, persistSnapshot, listSnapshots, snapshotIsFresh,
} from './repository.js';
import { METHODOLOGY_VERSION, getMethodology } from './methodology.js';

function serialize(result) {
  if (!result || result.error) return result;
  return {
    chronologicalAge: result.chronologicalAge,
    functionalAge: result.functionalAge,
    ageDelta: result.ageDelta,
    paceOfAging: result.paceOfAging,
    paceOfAgingRaw: result.paceOfAgingRaw,
    paceOfAgingDisplay: result.paceOfAgingDisplay,
    projectedFunctionalAge: result.projectedFunctionalAge,
    projectedChronologicalAge: result.projectedChronologicalAge,
    calibrationStatus: result.calibrationStatus,
    coverageDays: result.coverageDays,
    coverage: result.coverage,
    methodologyVersion: result.methodologyVersion,
    asOfDay: result.asOfDay,
    contributors: result.contributors,
    window: result.window,
    inputs: result.inputs,
  };
}

export function collectDays(store) {
  if (store?.days && typeof store.days === 'object' && Object.keys(store.days).length) {
    return daysFromWhoopMap(store.days);
  }
  try {
    const mapped = daysFromWhoopMap(loadWhoopDays());
    if (mapped.length) return mapped;
  } catch { /* ignore */ }
  return [];
}

export function calculateForStore(store, { asOfDay, persist = true, force = false } = {}) {
  ensureFunctionalAgeStore(store);
  const days = collectDays(store);
  const profile = store.profile || {};
  const extraWorkouts = extraWorkoutsFromStore(store);
  const result = computeHealthspanFromData({
    days,
    profile,
    extraWorkouts,
    asOfDay,
    methodologyVersion: METHODOLOGY_VERSION,
  });
  if (result.error) return { result, store, snapshot: null };
  let snapshot = store.functionalAge.latest;
  if (persist && (force || !snapshotIsFresh(snapshot, result.asOfDay))) {
    const saved = persistSnapshot(store, result);
    snapshot = saved.snapshot;
  }
  return { result: serialize(result), store, snapshot };
}

export function historyForStore(store, { limit } = {}) {
  ensureFunctionalAgeStore(store);
  return listSnapshots(store, { limit });
}

export function methodologyPublic() {
  const m = getMethodology();
  return {
    version: m.version,
    gompertzRate: m.gompertzRate,
    windows: m.windows,
    contributors: Object.keys(m.overlap.uniqueVariance),
    documentation: '/docs/FUNCTIONAL_AGE.md',
    disclaimer: 'Reconstruction of WHOOP Healthspan from public methodology and epidemiology. Not WHOOP’s proprietary algorithm.',
  };
}
