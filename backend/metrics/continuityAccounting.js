/**
 * Product continuity accounting.
 *
 * Consumes persisted strap / phone / backend / B2 / derived state. Does not
 * talk to BLE or change upload. Archive completeness stays in
 * dayCompleteness.js (open / complete / degraded); this module maps that
 * plus independent frontiers onto the product day states.
 */

import { dayBounds, localDateKey } from '../time/dayBoundary.js';
import { DAY_STATUS } from './dayCompleteness.js';

export const PRODUCT_DAY_STATUS = Object.freeze({
  COLLECTING: 'collecting',
  WAITING_FOR_HISTORY: 'waiting_for_history',
  COMPLETE: 'complete',
  INCOMPLETE_WITH_KNOWN_GAP: 'incomplete_with_known_gap',
  OFF_WRIST: 'off_wrist',
  STALE: 'stale',
  RECOMPUTE_PENDING: 'recompute_pending',
});

/** Live high-rate streams that the history bank cannot reconstruct. */
export const REALTIME_HIGH_RATE_TYPES = Object.freeze([43, 51]);

export const STALE_MS = 15 * 60_000;
const LIVE_FRESH_MS = 2 * 60_000;

export function toMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== '' && !String(value).includes('T')) {
    if (n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms) {
  return ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function maxMs(values) {
  const nums = (values || []).map(toMs).filter((n) => n != null);
  return nums.length ? Math.max(...nums) : null;
}

function maxNum(values) {
  const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : null;
}

function durationSum(rows) {
  return (rows || []).reduce((n, g) => n + (Number(g.duration_ms) || 0), 0);
}

const RANGE_WATERMARK_MAX = new Set([
  'data_range_newest',
  'raw_type47_newest',
  'phone_physiology_frontier_ts',
  'phone_raw_notify_at',
  'last_type40_at',
  'data_range_at',
]);

/**
 * Merge phone diag probes. Null/empty never clobbers a watermark; newest
 * keys take max; oldest is last non-null (strap trim can advance it).
 */
export function mergeRangeEvidence(prev = {}, next = {}) {
  const out = { ...(prev && typeof prev === 'object' ? prev : {}) };
  for (const [k, v] of Object.entries(next && typeof next === 'object' ? next : {})) {
    if (v == null || v === '') continue;
    if (RANGE_WATERMARK_MAX.has(k)) {
      const a = toMs(out[k]);
      const b = toMs(v);
      if (b == null) continue;
      if (a == null || b >= a) out[k] = v;
      continue;
    }
    out[k] = v;
  }
  out.range_trustworthy = toMs(out.data_range_oldest) != null && toMs(out.data_range_newest) != null;
  return out;
}

function lastSeriesSampleMs(seriesRow) {
  if (!seriesRow) return null;
  const hr = seriesRow.hr_series;
  if (!hr) return null;
  let latest = null;
  const consider = (value) => {
    const ms = toMs(value);
    if (ms != null && (latest == null || ms > latest)) latest = ms;
  };
  if (Array.isArray(hr)) {
    for (const point of hr) consider(point?.t || point?.datetime || point);
  } else if (typeof hr === 'object') {
    for (const [key, value] of Object.entries(hr)) {
      consider(value?.t || value?.datetime || key);
    }
  }
  return latest;
}

/**
 * Sample-time derived frontier. Job wall clocks (`computed_at`, `checked_at`)
 * are not valid here — they sit after the samples they processed.
 */
export function derivedSensorThrough(input = {}) {
  const row = input.dailyRow && typeof input.dailyRow === 'object' ? input.dailyRow : {};
  const extras = row.extras && typeof row.extras === 'object' ? row.extras : {};
  const overnightFin = extras.overnight_finalization && typeof extras.overnight_finalization === 'object'
    ? extras.overnight_finalization
    : {};
  return toMs(
    extras.latest_sensor_at
    || overnightFin.latest_sensor_at
    || row.latest_sensor_at
    || lastSeriesSampleMs(input.seriesRow)
    || input.derivedThrough,
  );
}

/**
 * Independent per-device frontiers. Null means unknown, never fabricated.
 */
export function collectDeviceFrontiers(input = {}) {
  const live = input.live && typeof input.live === 'object' ? input.live : {};
  const range = input.rangeEvidence && typeof input.rangeEvidence === 'object'
    ? input.rangeEvidence
    : live;
  const diag = input.diag && typeof input.diag === 'object'
    ? input.diag
    : (live.diag && typeof live.diag === 'object' ? live.diag : {});
  const watermarks = diag.history_watermarks && typeof diag.history_watermarks === 'object'
    ? diag.history_watermarks
    : {};
  const hour = input.hourBufferStats && typeof input.hourBufferStats === 'object'
    ? input.hourBufferStats
    : {};
  const history = input.historyBufferStats && typeof input.historyBufferStats === 'object'
    ? input.historyBufferStats
    : {};
  const completeness = input.completeness && typeof input.completeness === 'object'
    ? input.completeness
    : {};
  const phone = input.phone && typeof input.phone === 'object' ? input.phone : {};

  const lastTs = hour.last_ts && typeof hour.last_ts === 'object' ? hour.last_ts : {};
  const lastFrameTs = hour.last_frame_ts && typeof hour.last_frame_ts === 'object' ? hour.last_frame_ts : {};
  const lastSeq = hour.last_seq && typeof hour.last_seq === 'object' ? hour.last_seq : {};
  const lastFrameSeq = hour.last_frame_seq && typeof hour.last_frame_seq === 'object'
    ? hour.last_frame_seq
    : {};

  const strapNewest = toMs(
    range.data_range_newest
    || watermarks.data_range_newest
    || diag.data_range_newest
    || live.data_range_newest,
  );
  const strapOldest = toMs(
    range.data_range_oldest
    || watermarks.data_range_oldest
    || diag.data_range_oldest
    || live.data_range_oldest,
  );
  const strapHistory = toMs(
    watermarks.raw_type47_newest
    || range.raw_type47_newest
    || diag.raw_type47_newest,
  );
  const phonePhys = toMs(
    phone.physiology_frontier
    ?? range.phone_physiology_frontier_ts
    ?? diag.phone_history_contiguous_frontier_ts
    ?? watermarks.queue_newest
    ?? diag.phone_history_newest_sensor_ts,
  );
  const phoneNotifyMs = toMs(
    phone.raw_notify_frontier
    ?? range.phone_raw_notify_at
    ?? diag.last_notify_at
    ?? diag.last_custom_notify_at,
  );
  const backendPhys = maxMs([...Object.values(lastTs), hour.last_sample_at]);
  const backendNotifyMs = maxMs(Object.values(lastFrameTs));

  const unresolved = [
    ...(completeness.gaps?.recoverable_remaining || []),
    ...(completeness.gaps?.unrecoverable || []),
    ...((completeness.gaps?.live || []).filter((g) => {
      const cls = g.class || g.kind;
      return cls && cls !== 'off_wrist' && cls !== 'OFF_WRIST';
    })),
  ];

  return {
    device_id: live.deviceId || input.deviceId || range.deviceId || null,
    strap_newest_ms: strapNewest,
    strap_history_frontier_ms: strapHistory,
    strap_oldest_ms: strapOldest,
    phone_physiology_frontier_ms: phonePhys,
    phone_raw_notify_frontier_ms: phoneNotifyMs,
    backend_durable_frontier_ms: backendPhys,
    backend_raw_notify_frontier_ms: backendNotifyMs,
    backend_durable_seq: maxNum(Object.values(lastSeq)),
    backend_raw_notify_seq: maxNum(Object.values(lastFrameSeq)),
    b2_verified_frontier_ms: toMs(completeness.archive_verified_through),
    derived_frontier_ms: toMs(input.derivedThrough || completeness.recomputed_through),
    unresolved_gaps: unresolved,
    historical_complete: history.history_complete === true,
    history_pending_days: [...new Set([
      ...(history.pending_days || []),
      ...(history.affected_days || []),
    ])].filter(Boolean).sort(),
    range_probed_at_ms: toMs(range.data_range_at || diag.data_range_at),
    range_trustworthy: range.range_trustworthy === true,
    live_connected: live.connected === true,
    live_heart_rate: Number.isFinite(Number(live.heartRate ?? live.bpm))
      ? Number(live.heartRate ?? live.bpm)
      : null,
    last_type40_at_ms: toMs(diag.last_type40 || diag.last_custom_hr_at || range.last_type40_at),
    last_successful_offload_ms: toMs(completeness.last_successful_offload),
  };
}

/** Shape dayCompleteness.frontiers from the independent snapshot. */
export function completenessFrontiers(frontiers = {}) {
  return {
    strapTrimmedThrough: iso(frontiers.strap_oldest_ms),
    historyOldest: iso(frontiers.strap_oldest_ms),
    rangeProbedAt: iso(frontiers.range_probed_at_ms),
    rangeTrustworthy: frontiers.range_trustworthy === true,
    historySyncedThrough: iso(
      frontiers.phone_physiology_frontier_ms || frontiers.backend_durable_frontier_ms,
    ),
    lastSuccessfulOffload: iso(frontiers.last_successful_offload_ms),
    recomputedThrough: iso(frontiers.derived_frontier_ms),
  };
}

function historyDebt(frontiers, completeness, finalization, day) {
  const fin = finalization?.state || finalization?.stages?.finalization?.state || null;
  if (fin === 'waiting_for_history') return true;
  if ((completeness?.gaps?.counts?.recoverable ?? 0) > 0) return true;
  const pending = frontiers.history_pending_days || [];
  if (day && pending.includes(day) && frontiers.historical_complete !== true) return true;
  if (completeness?.day_finished && frontiers.historical_complete === false
    && (completeness?.gaps?.counts?.unclassified ?? 0) > 0) return true;
  const strap = frontiers.strap_newest_ms;
  const phone = frontiers.phone_physiology_frontier_ms;
  const backend = frontiers.backend_durable_frontier_ms;
  const caught = phone != null && backend != null ? Math.max(phone, backend)
    : (phone ?? backend);
  if (strap != null && caught != null && strap > caught + STALE_MS) return true;
  return false;
}

function liveLooksHealthy(frontiers, nowMs) {
  if (frontiers.live_connected === true) return true;
  const hr = frontiers.live_heart_rate;
  if (Number.isFinite(hr) && hr >= 20 && hr <= 240) return true;
  const t40 = frontiers.last_type40_at_ms;
  return t40 != null && nowMs - t40 <= LIVE_FRESH_MS;
}

function derivedBehindVerified(frontiers) {
  const b2 = frontiers.b2_verified_frontier_ms;
  const derived = frontiers.derived_frontier_ms;
  if (b2 == null) return false;
  if (derived == null) return true;
  return b2 > derived + 1000;
}

function historyStateKnown(frontiers = {}) {
  if (frontiers.historical_complete === true) return true;
  if (frontiers.strap_history_frontier_ms != null) return true;
  return frontiers.phone_physiology_frontier_ms != null
    && frontiers.backend_durable_frontier_ms != null;
}

/**
 * One product state. Connected / type-40 arriving is never complete.
 */
export function resolveProductDayState({
  completeness = {},
  finalization = {},
  frontiers = {},
  now = new Date(),
  day = completeness.day,
  timeZone = completeness.timezone_name || 'UTC',
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const fin = finalization?.state || finalization?.stages?.finalization?.state || null;
  const todayKey = localDateKey(new Date(nowMs), timeZone);
  const isToday = day && todayKey && day === todayKey;
  const finished = completeness.day_finished === true;
  const counts = completeness.gaps?.counts || {};
  const expectedMs = durationSum(completeness.gaps?.expected_absence);
  const coverage = Number(completeness.hr_coverage?.coverage_pct) || 0;
  const bounds = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayBounds(day, timeZone) : null;
  const dayMs = bounds
    ? Date.parse(bounds.day_end_at) - Date.parse(bounds.day_start_at)
    : 86400000;

  const historyKnown = historyStateKnown(frontiers);
  if (fin === 'computing' || finalization?.recompute_pending === true
    || (historyKnown && derivedBehindVerified(frontiers))) {
    return PRODUCT_DAY_STATUS.RECOMPUTE_PENDING;
  }
  if (historyDebt(frontiers, completeness, finalization, day)) {
    return PRODUCT_DAY_STATUS.WAITING_FOR_HISTORY;
  }
  if (!finished) {
    const durable = frontiers.backend_durable_frontier_ms
      ?? frontiers.phone_physiology_frontier_ms
      ?? toMs(completeness.contiguous_sample_through)
      ?? toMs(completeness.history_synced_through);
    if (isToday && liveLooksHealthy(frontiers, nowMs)
      && (durable == null || nowMs - durable > STALE_MS)) {
      return PRODUCT_DAY_STATUS.STALE;
    }
    return PRODUCT_DAY_STATUS.COLLECTING;
  }
  if ((counts.expected_absence || 0) > 0
    && (counts.recoverable || 0) === 0
    && (counts.unclassified || 0) === 0
    && (coverage < 50 || expectedMs > dayMs / 2)) {
    return PRODUCT_DAY_STATUS.OFF_WRIST;
  }
  if (completeness.status === DAY_STATUS.DEGRADED
    || (counts.unrecoverable || 0) > 0
    || (counts.unclassified || 0) > 0
    || completeness.status === DAY_STATUS.OPEN) {
    return PRODUCT_DAY_STATUS.INCOMPLETE_WITH_KNOWN_GAP;
  }
  if (completeness.status === DAY_STATUS.COMPLETE) {
    if (!historyKnown) return PRODUCT_DAY_STATUS.WAITING_FOR_HISTORY;
    return PRODUCT_DAY_STATUS.COMPLETE;
  }
  return PRODUCT_DAY_STATUS.INCOMPLETE_WITH_KNOWN_GAP;
}

export function historicalLagMs(frontiers = {}) {
  const strap = frontiers.strap_newest_ms;
  const caught = maxMs([
    frontiers.phone_physiology_frontier_ms,
    frontiers.backend_durable_frontier_ms,
    frontiers.b2_verified_frontier_ms,
  ]);
  if (strap == null || caught == null) return null;
  return Math.max(0, strap - caught);
}

export function uiSeriesCoverage(seriesRow, completeness = {}) {
  if (!seriesRow) {
    return {
      present: false,
      sample_count: 0,
      coverage_pct: completeness.hr_coverage?.coverage_pct ?? null,
    };
  }
  const hr = seriesRow.hr_series;
  let n = Number(seriesRow.sample_count) || 0;
  if (Array.isArray(hr)) n = Math.max(n, hr.length);
  else if (hr && typeof hr === 'object') n = Math.max(n, Object.keys(hr).length);
  return {
    present: true,
    sample_count: n,
    coverage_pct: completeness.hr_coverage?.coverage_pct ?? null,
  };
}

export function buildIngestReconciliation({
  completeness = {},
  finalization = {},
  frontiers = {},
  evidencePipeline = null,
  uiSeries = null,
  now = new Date(),
} = {}) {
  const product_status = resolveProductDayState({
    completeness, finalization, frontiers, now, day: completeness.day,
    timeZone: completeness.timezone_name,
  });
  const recoverableMs = durationSum(completeness.gaps?.recoverable_remaining);
  const expectedAbsenceMs = durationSum(completeness.gaps?.expected_absence);
  const actual = completeness.hr_coverage || null;
  const expected = actual
    ? {
      expected_samples: actual.expected_samples,
      expected_buckets: actual.expected_buckets,
    }
    : null;
  return {
    product_status,
    expected_coverage: expected,
    recoverable_coverage: {
      gap_ms: recoverableMs,
      count: completeness.gaps?.counts?.recoverable ?? 0,
    },
    actual_coverage: actual,
    largest_gap: completeness.largest_gap || null,
    historical_lag_ms: historicalLagMs(frontiers),
    raw_evidence: evidencePipeline,
    b2: completeness.raw_archive_verification || null,
    b2_verified_through: completeness.archive_verified_through ?? null,
    recompute: {
      state: finalization?.state || finalization?.stages?.finalization?.state || null,
      pending: product_status === PRODUCT_DAY_STATUS.RECOMPUTE_PENDING,
      derived_through: iso(frontiers.derived_frontier_ms),
      b2_verified_through: iso(frontiers.b2_verified_frontier_ms),
    },
    ui_series: uiSeries,
    frontiers,
    gap_kinds: {
      off_wrist: completeness.gaps?.expected_absence || [],
      repaired_by_history: completeness.gaps?.backfilled || [],
      unresolved: [
        ...(completeness.gaps?.recoverable_remaining || []),
        ...(completeness.gaps?.unrecoverable || []),
      ],
      realtime_only_unrecoverable: evidencePipeline?.realtime_high_rate || [],
    },
    expected_absence_ms: expectedAbsenceMs,
  };
}
