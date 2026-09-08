/**
 * Pure Node port of NOOP VanHeesSleep.swift.
 *
 * A bout is a gravity-orientation rest period, not a PSG sleep assertion.
 * Timestamps are integer unix seconds and windows are [onsetSec, offsetSec).
 */

export const VAN_HEES_DEFAULTS = Object.freeze({
  angleThresholdDeg: 5,
  sustainedMin: 5,
  bridgeGapMin: 30,
  smoothSec: 5,
  maxSpanSec: 3 * 86_400,
});

export function zAngle(x, y, z) {
  return Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function rollingMedian(values, width) {
  if (width <= 1) return [...values];
  const half = Math.floor(width / 2);
  return values.map((value, i) => {
    if (Number.isNaN(value)) return Number.NaN;
    const segment = [];
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    for (let k = lo; k <= hi; k += 1) {
      if (!Number.isNaN(values[k])) segment.push(values[k]);
    }
    return median(segment) ?? Number.NaN;
  });
}

export function immobilityMask(accel, {
  angleThresholdDeg = VAN_HEES_DEFAULTS.angleThresholdDeg,
  sustainedMin = VAN_HEES_DEFAULTS.sustainedMin,
  smoothSec = VAN_HEES_DEFAULTS.smoothSec,
} = {}) {
  const n = accel.length;
  const sustainedSec = sustainedMin * 60;
  if (!n) {
    return {
      immobile: [], immobileUnknown: [], zAngleDeg: [], deltaDeg: [],
      sustainedSec, thresholdDeg: angleThresholdDeg,
    };
  }
  const raw = accel.map((sample) => sample.valid === false
    ? Number.NaN
    : zAngle(sample.x, sample.y, sample.z));
  const angles = rollingMedian(raw, smoothSec);
  const deltas = Array(n).fill(0);
  for (let i = 1; i < n; i += 1) deltas[i] = Math.abs(angles[i] - angles[i - 1]);

  const immobile = Array(n).fill(false);
  const immobileUnknown = Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    const hi = Math.min(n, i + sustainedSec);
    let maxDelta = 0;
    let gap = accel[i].valid === false;
    if (!gap) {
      for (let k = i + 1; k < hi; k += 1) {
        if (accel[k].valid === false) {
          gap = true;
          break;
        }
        // NaN comparisons intentionally match Swift: they never raise maxDelta.
        if (deltas[k] > maxDelta) {
          maxDelta = deltas[k];
          if (maxDelta >= angleThresholdDeg) break;
        }
      }
    }
    const still = maxDelta < angleThresholdDeg;
    const fullWindow = hi - i >= sustainedSec;
    immobile[i] = still && fullWindow && !gap;
    immobileUnknown[i] = still && (!fullWindow || gap);
  }
  return {
    immobile, immobileUnknown, zAngleDeg: angles, deltaDeg: deltas,
    sustainedSec, thresholdDeg: angleThresholdDeg,
  };
}

export function restBoutsFromAccel(accel, {
  angleThresholdDeg = VAN_HEES_DEFAULTS.angleThresholdDeg,
  sustainedMin = VAN_HEES_DEFAULTS.sustainedMin,
  bridgeGapMin = VAN_HEES_DEFAULTS.bridgeGapMin,
  smoothSec = VAN_HEES_DEFAULTS.smoothSec,
} = {}) {
  const n = accel.length;
  const minLength = sustainedMin * 60;
  if (n < minLength) return [];
  const { immobile } = immobilityMask(accel, {
    angleThresholdDeg, sustainedMin, smoothSec,
  });
  const bridge = bridgeGapMin * 60;
  const firstMs = Number(accel[0]?.tsMs);
  const t0Sec = Math.floor(firstMs / 1000);
  const bouts = [];
  let i = 0;
  while (i < n) {
    if (!immobile[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n) {
      if (immobile[j]) {
        j += 1;
        continue;
      }
      let k = j;
      while (k < n && !immobile[k] && k - j < bridge) k += 1;
      if (k < n && immobile[k] && k - j < bridge) j = k;
      else break;
    }
    const length = j - i;
    if (length >= minLength) {
      bouts.push({
        onsetSec: t0Sec + i,
        offsetSec: t0Sec + j,
        sptSec: length,
        confidence: Math.min(0.95, Math.max(0.3, length / (7 * 3600))),
      });
    }
    i = j + 1;
  }
  return bouts;
}

export function resampleGravity1Hz(gravity, {
  maxSpanSec = VAN_HEES_DEFAULTS.maxSpanSec,
} = {}) {
  if (gravity.length < 2) return null;
  const sorted = [...gravity].sort((a, b) => a.ts - b.ts);
  const t0 = sorted[0].ts;
  const t1 = sorted.at(-1).ts;
  const span = t1 - t0 + 1;
  if (span < 5 * 60 || span > maxSpanSec) return null;
  const grid = Array.from({ length: span }, (_, i) => ({
    tsMs: (t0 + i) * 1000,
    x: 0,
    y: 0,
    z: 0,
    valid: false,
  }));
  for (const sample of sorted) {
    const idx = sample.ts - t0;
    if (idx < 0 || idx >= span) continue;
    grid[idx] = {
      tsMs: (t0 + idx) * 1000,
      x: sample.x,
      y: sample.y,
      z: sample.z,
      valid: true,
    };
  }
  return grid;
}

export function restBouts(gravity, options = {}) {
  const grid = resampleGravity1Hz(gravity, options);
  return grid ? restBoutsFromAccel(grid, options) : [];
}

export function sleepWindow(gravity, options = {}) {
  const bouts = restBouts(gravity, options);
  return bouts.reduce((best, bout) => (!best || bout.sptSec > best.sptSec ? bout : best), null);
}
