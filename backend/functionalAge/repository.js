import { randomUUID } from 'node:crypto';
import { METHODOLOGY_VERSION } from './methodology.js';

const MAX_SNAPSHOTS = 104;

export function emptyFunctionalAgeState() {
  return { snapshots: [], latest: null };
}

export function ensureFunctionalAgeStore(store) {
  if (!store.functionalAge || typeof store.functionalAge !== 'object') {
    store.functionalAge = emptyFunctionalAgeState();
  }
  if (!Array.isArray(store.functionalAge.snapshots)) store.functionalAge.snapshots = [];
  return store;
}

export function snapshotFromResult(result, { calculatedAt } = {}) {
  return {
    id: randomUUID(),
    calculatedAt: calculatedAt || new Date().toISOString(),
    asOfDay: result.asOfDay || null,
    methodologyVersion: result.methodologyVersion || METHODOLOGY_VERSION,
    chronologicalAge: result.chronologicalAge,
    functionalAge: result.functionalAge,
    ageDelta: result.ageDelta,
    paceOfAging: result.paceOfAging,
    paceOfAgingRaw: result.paceOfAgingRaw,
    calibrationStatus: result.calibrationStatus,
    coverageDays: result.coverageDays,
    coverage: result.coverage || null,
    inputs: result.inputs || null,
    contributors: result.contributors,
  };
}

export function persistSnapshot(store, result, options = {}) {
  ensureFunctionalAgeStore(store);
  const snap = snapshotFromResult(result, options);
  const weeklyKey = snap.asOfDay ? snap.asOfDay.slice(0, 10) : snap.calculatedAt.slice(0, 10);
  const existing = store.functionalAge.snapshots.findIndex((s) => (
    s.asOfDay === snap.asOfDay && s.methodologyVersion === snap.methodologyVersion
  ));
  if (existing >= 0 && !options.forceNew) {
    store.functionalAge.snapshots[existing] = { ...snap, id: store.functionalAge.snapshots[existing].id };
  } else {
    store.functionalAge.snapshots.push(snap);
  }
  store.functionalAge.snapshots.sort((a, b) => String(a.asOfDay || a.calculatedAt).localeCompare(String(b.asOfDay || b.calculatedAt)));
  if (store.functionalAge.snapshots.length > MAX_SNAPSHOTS) {
    store.functionalAge.snapshots = store.functionalAge.snapshots.slice(-MAX_SNAPSHOTS);
  }
  store.functionalAge.latest = snap;
  return { store, snapshot: snap, weekKey: weeklyKey };
}

export function listSnapshots(store, { limit = 52 } = {}) {
  ensureFunctionalAgeStore(store);
  const rows = store.functionalAge.snapshots.slice().reverse();
  return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 52)));
}

export function snapshotIsFresh(snapshot, asOfDay, maxAgeDays = 7) {
  if (!snapshot) return false;
  if (asOfDay && snapshot.asOfDay === asOfDay) return true;
  if (!snapshot.calculatedAt) return false;
  const ageMs = Date.now() - Date.parse(snapshot.calculatedAt);
  return Number.isFinite(ageMs) && ageMs <= maxAgeDays * 86400000;
}
