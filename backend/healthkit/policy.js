/**
 * Central HealthKit source taxonomy, permission groups, and metric arbitration.
 *
 * Screens and algorithms must not pick a source themselves. Call `arbitrate()`.
 * Policies are data: change SOURCE_POLICY, not callers.
 */

export const SOURCES = Object.freeze({
  WHOOP_BLE: 'whoop_ble',
  APPLE_WATCH_HEALTHKIT: 'apple_watch_healthkit',
  IPHONE_HEALTHKIT: 'iphone_healthkit',
  THIRD_PARTY_HEALTHKIT: 'third_party_healthkit',
  MANUAL: 'manual',
  FRWHOOP_DERIVED: 'frwhoop_derived',
  FRWHOOP: 'frwhoop',
});

/** Sources that are HealthKit interoperability, never Layer-1 WHOOP telemetry. */
export const HEALTHKIT_SOURCES = Object.freeze(new Set([
  SOURCES.APPLE_WATCH_HEALTHKIT,
  SOURCES.IPHONE_HEALTHKIT,
  SOURCES.THIRD_PARTY_HEALTHKIT,
]));

export const CANONICAL_SOURCES = Object.freeze(new Set([
  SOURCES.WHOOP_BLE,
  SOURCES.FRWHOOP_DERIVED,
  SOURCES.FRWHOOP,
]));

const APPLE_BUNDLES = new Set([
  'com.apple.health',
  'com.apple.Health',
  'com.apple.private.health',
]);

const FRWHOOP_BUNDLES = new Set([
  'com.rahulvijayan.frwhoop',
  'com.noop.strand',
  'com.noop.NOOP',
  'com.noopapp.noop',
  'com.noop.noop',
]);

/**
 * Permission groups shown to the user. HealthKit still presents one sheet;
 * grouping is how FRWHOOP requests, documents, and degrades partial grants.
 */
export const PERMISSION_GROUPS = Object.freeze({
  heart: {
    label: 'Heart',
    read: [
      'heartRate', 'heartRateVariabilitySDNN', 'restingHeartRate',
      'walkingHeartRateAverage', 'oxygenSaturation', 'respiratoryRate',
    ],
    write: ['heartRateVariabilitySDNN', 'restingHeartRate', 'respiratoryRate'],
  },
  fitness: {
    label: 'Fitness',
    read: [
      'stepCount', 'distanceWalkingRunning', 'distanceCycling',
      'activeEnergyBurned', 'basalEnergyBurned', 'vo2Max', 'workoutType',
    ],
    write: ['activeEnergyBurned', 'distanceWalkingRunning', 'distanceCycling', 'workoutType'],
  },
  sleep: {
    label: 'Sleep',
    read: ['sleepAnalysis'],
    write: ['sleepAnalysis'],
  },
  body: {
    label: 'Body measurements',
    read: [
      'bodyMass', 'height', 'bodyFatPercentage', 'leanBodyMass', 'bodyMassIndex',
      'bodyTemperature',
    ],
    write: [],
  },
  nutrition: {
    label: 'Nutrition',
    read: [
      'dietaryEnergyConsumed', 'dietaryProtein', 'dietaryCarbohydrates',
      'dietaryFatTotal',
    ],
    write: [],
  },
});

/**
 * Per-metric source priority. First listed source that has a usable sample wins.
 * `uses` documents what a lower-ranked source may do; it never becomes primary
 * by being present.
 *
 * fusion: null means never average/merge. A dedicated algorithm may be named later.
 */
export const SOURCE_POLICY = Object.freeze({
  heart_rate: {
    primary: [SOURCES.WHOOP_BLE, SOURCES.FRWHOOP_DERIVED, SOURCES.FRWHOOP],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT],
    uses: 'validation_gap_fill',
    fusion: null,
  },
  hrv: {
    primary: [SOURCES.FRWHOOP_DERIVED, SOURCES.WHOOP_BLE],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT],
    uses: 'comparison',
    fusion: null,
    note: 'RMSSD (FRWHOOP) and SDNN (HealthKit) are not interchangeable.',
  },
  resting_heart_rate: {
    primary: [SOURCES.FRWHOOP_DERIVED],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT],
    uses: 'comparison',
    fusion: null,
  },
  walking_heart_rate: {
    primary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT],
    secondary: [],
    uses: 'primary',
    fusion: null,
  },
  gps: {
    primary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT],
    secondary: [],
    uses: 'primary',
    fusion: null,
  },
  distance: {
    primary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT],
    secondary: [SOURCES.WHOOP_BLE, SOURCES.FRWHOOP_DERIVED],
    uses: 'prefer_gps',
    fusion: null,
  },
  steps: {
    primary: [SOURCES.WHOOP_BLE, SOURCES.FRWHOOP_DERIVED, SOURCES.FRWHOOP],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT, SOURCES.THIRD_PARTY_HEALTHKIT],
    uses: 'in_app_whoop_only',
    fusion: null,
    note: 'Overview shows strap step_motion_counter (wrap-aware diff). Never merge or sum with HealthKit.',
  },
  skin_temperature: {
    primary: [SOURCES.WHOOP_BLE, SOURCES.FRWHOOP_DERIVED],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT],
    uses: 'comparison',
    fusion: null,
  },
  sleep: {
    primary: [SOURCES.FRWHOOP_DERIVED, SOURCES.FRWHOOP, SOURCES.WHOOP_BLE],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT],
    uses: 'validation_fallback_calibration',
    fusion: null,
  },
  calories: {
    primary: [SOURCES.FRWHOOP_DERIVED, SOURCES.FRWHOOP],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT, SOURCES.THIRD_PARTY_HEALTHKIT],
    uses: 'validation_calibration',
    fusion: null,
    note: 'Never sum FRWHOOP and Apple energy. Workout kcal is a subset of active kcal.',
  },
  workout: {
    primary: [SOURCES.FRWHOOP, SOURCES.FRWHOOP_DERIVED, SOURCES.WHOOP_BLE],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT, SOURCES.THIRD_PARTY_HEALTHKIT],
    uses: 'reconciliation_fallback_enrichment',
    fusion: null,
  },
  weight: {
    primary: [SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT, SOURCES.THIRD_PARTY_HEALTHKIT, SOURCES.MANUAL],
    secondary: [],
    uses: 'primary',
    fusion: null,
  },
  height: {
    primary: [SOURCES.IPHONE_HEALTHKIT, SOURCES.APPLE_WATCH_HEALTHKIT, SOURCES.MANUAL],
    secondary: [],
    uses: 'primary',
    fusion: null,
  },
  nutrition: {
    primary: [SOURCES.THIRD_PARTY_HEALTHKIT, SOURCES.IPHONE_HEALTHKIT, SOURCES.APPLE_WATCH_HEALTHKIT],
    secondary: [SOURCES.MANUAL],
    uses: 'primary_if_present',
    fusion: null,
    note: 'Never overwrite a user-entered manual nutrition day.',
  },
  vo2_max: {
    primary: [SOURCES.FRWHOOP_DERIVED],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT],
    uses: 'comparison_calibration',
    fusion: null,
  },
  respiratory_rate: {
    primary: [SOURCES.FRWHOOP_DERIVED, SOURCES.WHOOP_BLE],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT],
    uses: 'comparison',
    fusion: null,
  },
  oxygen_saturation: {
    primary: [SOURCES.WHOOP_BLE, SOURCES.FRWHOOP_DERIVED],
    secondary: [SOURCES.APPLE_WATCH_HEALTHKIT],
    uses: 'comparison',
    fusion: null,
  },
});

const WATCH_HINT = /watch|series [0-9]|ultra/i;
const IPHONE_HINT = /iphone|ipod/i;

/**
 * Classify a HealthKit source into the FRWHOOP taxonomy. Never invent a merge source.
 */
export function classifySource({
  bundleId,
  sourceName,
  deviceName,
  deviceModel,
  productType,
} = {}) {
  const bundle = String(bundleId || '').trim();
  const device = `${deviceName || ''} ${deviceModel || ''} ${productType || ''}`;
  if (FRWHOOP_BUNDLES.has(bundle) || /frwhoop|noop|strand/i.test(bundle)) {
    return SOURCES.FRWHOOP_DERIVED;
  }
  if (APPLE_BUNDLES.has(bundle) || bundle.startsWith('com.apple.')) {
    if (WATCH_HINT.test(device) || WATCH_HINT.test(sourceName || '')) return SOURCES.APPLE_WATCH_HEALTHKIT;
    if (IPHONE_HINT.test(device) || IPHONE_HINT.test(sourceName || '')) return SOURCES.IPHONE_HEALTHKIT;
    return SOURCES.APPLE_WATCH_HEALTHKIT;
  }
  if (!bundle && !sourceName) return SOURCES.THIRD_PARTY_HEALTHKIT;
  return SOURCES.THIRD_PARTY_HEALTHKIT;
}

export function isHealthKitSource(source) {
  return HEALTHKIT_SOURCES.has(source);
}

export function isCanonicalSource(source) {
  return CANONICAL_SOURCES.has(source) || source === 'whoop' || source === 'auto';
}

function usable(candidate) {
  if (!candidate || candidate.rejected) return false;
  const v = candidate.value;
  if (v == null) return false;
  if (typeof v === 'number' && !Number.isFinite(v)) return false;
  return true;
}

/**
 * Pick one candidate for a metric. Never averages. Returns the winning observation
 * plus every loser as `comparison` so UI/calibration can still see them.
 */
export function arbitrate(metricType, candidates = [], policy = SOURCE_POLICY) {
  const spec = policy[metricType];
  const list = (Array.isArray(candidates) ? candidates : []).filter(usable);
  if (!spec) {
    return {
      value: list[0]?.value ?? null,
      source: list[0]?.source ?? null,
      winner: list[0] || null,
      comparison: list.slice(1),
      reason: 'no_policy',
    };
  }
  const rank = [...spec.primary, ...spec.secondary];
  for (const source of rank) {
    const hit = list.find((c) => c.source === source);
    if (hit) {
      return {
        value: hit.value,
        source: hit.source,
        winner: hit,
        comparison: list.filter((c) => c !== hit),
        reason: spec.primary.includes(source) ? 'primary' : spec.uses || 'secondary',
        fusion: spec.fusion,
      };
    }
  }
  // Fallback: first remaining candidate, tagged so it cannot silently become canonical.
  const fallback = list[0] || null;
  return {
    value: fallback?.value ?? null,
    source: fallback?.source ?? null,
    winner: fallback,
    comparison: list.slice(1),
    reason: fallback ? 'unranked_fallback' : 'none',
    fusion: spec.fusion,
  };
}

export function policyFor(metricType) {
  return SOURCE_POLICY[metricType] || null;
}
