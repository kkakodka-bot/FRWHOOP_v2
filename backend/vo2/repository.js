import { randomUUID } from 'node:crypto';
import { METHODOLOGY_VERSION } from './methodology.js';
import { finiteNumber } from './math.js';
import { isAcceptedLabModality } from './calibration.js';

const MAX_SNAPSHOTS = 104;

export function emptyVo2State() {
  return {
    snapshots: [],
    latest: null,
    labAnchors: [],
    hrMaxOverride: null,
    weightHistory: [],
  };
}

export function ensureVo2Store(store) {
  if (!store.vo2 || typeof store.vo2 !== 'object') store.vo2 = emptyVo2State();
  if (!Array.isArray(store.vo2.snapshots)) store.vo2.snapshots = [];
  if (!Array.isArray(store.vo2.labAnchors)) store.vo2.labAnchors = [];
  if (!Array.isArray(store.vo2.weightHistory)) store.vo2.weightHistory = [];
  if (store.vo2.hrMaxOverride === undefined) store.vo2.hrMaxOverride = null;
  return store;
}

export function snapshotFromResult(result, { calculatedAt } = {}) {
  return {
    id: randomUUID(),
    calculatedAt: calculatedAt || result.calculatedAt || new Date().toISOString(),
    asOfDay: result.asOfDay || null,
    effectiveDate: result.effectiveDate || null,
    methodologyVersion: result.methodologyVersion || METHODOLOGY_VERSION,
    modelVersion: result.modelVersion,
    featureVersion: result.featureVersion,
    smoothingVersion: result.smoothingVersion,
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
    disclaimer: result.disclaimer,
  };
}

export function persistSnapshot(store, result, options = {}) {
  ensureVo2Store(store);
  const snap = snapshotFromResult(result, options);
  const existing = store.vo2.snapshots.findIndex((s) => (
    s.effectiveDate === snap.effectiveDate && s.methodologyVersion === snap.methodologyVersion
  ));
  if (existing >= 0 && !options.forceNew) {
    store.vo2.snapshots[existing] = { ...snap, id: store.vo2.snapshots[existing].id };
  } else {
    store.vo2.snapshots.push(snap);
  }
  store.vo2.snapshots.sort((a, b) => String(a.effectiveDate || a.asOfDay).localeCompare(String(b.effectiveDate || b.asOfDay)));
  if (store.vo2.snapshots.length > MAX_SNAPSHOTS) {
    store.vo2.snapshots = store.vo2.snapshots.slice(-MAX_SNAPSHOTS);
  }
  store.vo2.latest = snap;
  return { store, snapshot: snap };
}

export function listSnapshots(store, { limit = 52 } = {}) {
  ensureVo2Store(store);
  return store.vo2.snapshots.slice().reverse().slice(0, Math.max(1, Math.min(200, Number(limit) || 52)));
}

export function previousSnapshot(store, effectiveDate, methodologyVersion) {
  ensureVo2Store(store);
  const rows = store.vo2.snapshots.filter((s) => (
    s.methodologyVersion === (methodologyVersion || METHODOLOGY_VERSION)
    && s.effectiveDate && effectiveDate && s.effectiveDate < effectiveDate
    && s.vo2Max != null
  ));
  return rows.length ? rows[rows.length - 1] : null;
}

export function snapshotIsFresh(snapshot, asOfDay, maxAgeDays = 7) {
  if (!snapshot) return false;
  if (asOfDay && snapshot.asOfDay === asOfDay) return true;
  if (!snapshot.calculatedAt) return false;
  const ageMs = Date.now() - Date.parse(snapshot.calculatedAt);
  return Number.isFinite(ageMs) && ageMs <= maxAgeDays * 86400000;
}

export function appendLabAnchor(store, body = {}) {
  ensureVo2Store(store);
  const value = finiteNumber(body.value ?? body.vo2Max);
  const modality = String(body.modality || '').toLowerCase();
  if (!isAcceptedLabModality(modality)) {
    return { error: 'invalid_modality', message: 'Lab anchors must be gas-exchange GXT measurements.' };
  }
  if (value == null || value < 20 || value > 85) {
    return { error: 'invalid_value', message: 'Lab VO2 must be 20–85 ml/kg/min.' };
  }
  const anchor = {
    id: randomUUID(),
    value,
    unit: body.unit || 'ml/kg/min',
    measuredOn: String(body.measuredOn || body.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    modality,
    lab: body.lab ? String(body.lab) : null,
    userSupplied: body.userSupplied !== false,
    recordedAt: new Date().toISOString(),
    modelAtAnchor: finiteNumber(body.modelAtAnchor),
    featuresAtAnchor: body.featuresAtAnchor || null,
    methodologyVersion: body.methodologyVersion || METHODOLOGY_VERSION,
    modelVersion: body.modelVersion || null,
    featureVersion: body.featureVersion || null,
  };
  store.vo2.labAnchors.push(anchor);
  return { store, anchor };
}

export function listLabAnchors(store) {
  ensureVo2Store(store);
  return store.vo2.labAnchors.slice();
}

export function setHrMaxOverride(store, value) {
  ensureVo2Store(store);
  const n = finiteNumber(value);
  if (n == null || n < 120 || n > 220) {
    return { error: 'invalid_hr_max', message: 'Tested HRmax must be 120–220 bpm.' };
  }
  store.vo2.hrMaxOverride = { value: n, source: 'manual_tested', at: new Date().toISOString() };
  return { store, hrMaxOverride: store.vo2.hrMaxOverride };
}

export function recordWeightChange(store, kg, at = new Date().toISOString()) {
  ensureVo2Store(store);
  const value = finiteNumber(kg);
  if (value == null) return store;
  const hist = store.vo2.weightHistory;
  const last = hist[hist.length - 1];
  if (last && Math.abs(last.kg - value) < 0.05) return store;
  let quality = 'ok';
  if (last) {
    const prevDay = String(last.at).slice(0, 10);
    const day = String(at).slice(0, 10);
    const days = Math.abs((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${prevDay}T00:00:00Z`)) / 86400000);
    if (Number.isFinite(days) && days <= 7 && Math.abs(last.kg - value) > 8) quality = 'suspect';
    if (Number.isFinite(days) && days <= 7 && Math.abs(last.kg - value) > 15) quality = 'reject';
  }
  hist.push({ at, kg: value, quality });
  return store;
}
