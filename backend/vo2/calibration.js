import { getMethodology } from './methodology.js';
import { clamp, dayDiff, finiteNumber } from './math.js';

export const ACCEPTED_LAB_MODALITIES = Object.freeze([
  'gas_exchange_gxt', 'gas_exchange', 'cpet', 'douglas_bag',
]);

export function isAcceptedLabModality(modality) {
  return ACCEPTED_LAB_MODALITIES.includes(String(modality || '').toLowerCase());
}

export function labDecayK(anchorDay, asOfDay, version) {
  const lab = getMethodology(version).lab;
  if (!anchorDay || !asOfDay) return lab.k0;
  const ageDays = Math.max(0, dayDiff(anchorDay, asOfDay));
  return lab.k0 * (0.5 ** (ageDays / lab.halfLifeDays));
}

export function applyLabCalibration({
  labValue,
  measuredOn,
  asOfDay,
  modelNow,
  modelAtAnchor,
  version,
} = {}) {
  const lab = getMethodology(version).lab;
  const value = finiteNumber(labValue);
  if (value == null || value < lab.minValue || value > lab.maxValue) return null;
  const now = finiteNumber(modelNow);
  const then = finiteNumber(modelAtAnchor);
  if (now == null || then == null) {
    return { vo2: value, k: lab.k0, delta: 0, labValue: value };
  }
  const k = labDecayK(measuredOn, asOfDay, version);
  const delta = k * (now - then);
  const vo2 = clamp(value + delta, lab.minValue, lab.maxValue);
  return { vo2, k, delta, labValue: value };
}

export function activeLabAnchor(anchors = [], asOfDay) {
  const valid = (anchors || []).filter((a) => (
    isAcceptedLabModality(a.modality)
    && finiteNumber(a.value) != null
    && (!asOfDay || !a.measuredOn || a.measuredOn <= asOfDay)
  ));
  if (!valid.length) return null;
  return valid.slice().sort((a, b) => String(b.measuredOn).localeCompare(String(a.measuredOn)))[0];
}
