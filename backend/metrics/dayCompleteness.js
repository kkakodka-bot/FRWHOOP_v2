/**
 * Canonical DayCompleteness — the ONE 24h data-continuity computation.
 *
 * Every diagnostic, the verify endpoint, and the finalize gate read this
 * module. Nothing else may compute day coverage.
 *
 * Contract:
 * - Local IANA day bounds (time/dayBoundary.js, DST-correct) and ACTUAL sample
 *   / object timestamps. `period_day` is only a partition hint, never proof.
 * - MAX(timestamp) is never proof of continuity. The contiguous frontier
 *   (history_synced_through) walks the sorted sample timeline and stops at the
 *   first hole wider than the resolved gap threshold.
 * - A finished day is 'complete' (zero recoverable/unclassified open gaps and
 *   verified raw archive) or 'degraded' (reconciliation finished, only known
 *   unrecoverable loss). Confirmed nonwear/charging is expected_absence — it
 *   stays in diagnostics and does not block complete. Anything ambiguous stays
 *   'open'. Days are never silently finalized and missing physiology is never
 *   zero-filled: this module only measures.
 *
 * PURE: no fs, no db, no network. Callers inject samples, gap rows, manifest
 * rows, verification evidence, and frontiers.
 */

import { dayBounds } from '../time/dayBoundary.js';
import { detectSampleGaps, EXPECTED_SAMPLE_MS, GAP_MS } from '../ingest/gaps.js';
import { classifyGap } from '../ingest/gapProvenance.js';
import { verifiedArchiveFrontierMs } from './dayEvidence.js';
import { isHistoricalPuffin54 } from '../protocol/eventRecords.js';

export const DAY_STATUS = Object.freeze({
  OPEN: 'open',
  COMPLETE: 'complete',
  DEGRADED: 'degraded',
});

export const GAP_CATEGORY = Object.freeze({
  RECOVERABLE: 'recoverable',
  UNRECOVERABLE: 'unrecoverable',
  UNCLASSIFIED: 'unclassified',
  EXPECTED_ABSENCE: 'expected_absence',
  BACKFILLED: 'backfilled',
  OBSERVED: 'observed',
});

/** Absence taxonomy used by diagnostics. Recoverable stays a completeness gate. */
export const GAP_SEMANTIC = Object.freeze({
  OBSERVED: 'observed',
  BACKFILLED: 'backfilled',
  EXPECTED_ABSENCE: 'expected_absence',
  UNRECOVERABLE: 'unrecoverable',
  UNCLASSIFIED: 'unclassified',
});

/** Provenance classes where the data still exists somewhere upstream. */
export const RECOVERABLE_CLASSES = new Set([
  'IOS_RECEIVED_NOT_PERSISTED',
  'IOS_PERSISTED_NOT_UPLOADED',
  'BACKEND_RECEIVED_NOT_ARCHIVED',
  'B2_HAS_RAW_NOT_NORMALIZED',
  'B2_HAS_NORMALIZED_NOT_SUPABASE',
  'SUPABASE_HAS_DATA_API_DROPPED',
  'API_HAS_DATA_FRONTEND_DROPPED',
]);

/** Provenance classes where the data is gone by design or by loss. */
export const UNRECOVERABLE_CLASSES = new Set([
  'INTENTIONAL_VALIDITY_FILTER',
]);

/** Confirmed nonwear / charging — expected absence, not data loss. */
export const EXPECTED_ABSENCE_CLASSES = new Set([
  'OFF_WRIST',
]);

const NONWEAR_KINDS = new Set(['off_wrist', 'wrist_off', 'charging']);
const TRANSPORT_KINDS = new Set([
  'connection', 'upload', 'suspend', 'bluetooth_off', 'not_restored',
  'app_killed', 'hr_stream_stalled', 'missing_interval',
]);

const EVENT_KINDS = new Set([
  'missing_interval',
  'connection',
  'upload',
  'suspend',
  'bluetooth_off',
  'not_restored',
  'app_killed',
]);

const BUCKET_MS = 300000;

export function parseSampleTime(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const raw = sample.datetime ?? sample.at ?? sample.t;
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Samples clipped to [loMs, hiMs), deduplicated at millisecond precision
 * (first occurrence wins) so a duplicate resend cannot inflate coverage.
 */
export function inDaySamples(samples, loMs, hiMs) {
  const seen = new Set();
  const out = [];
  for (const sample of samples || []) {
    const t = parseSampleTime(sample);
    if (t == null || t < loMs || t >= hiMs) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(sample);
  }
  return out;
}

/**
 * Contiguous sample frontier: walk sorted in-day timestamps; the run starts at
 * the first sample (or at loMs when a sample lands within gapMs of it) and the
 * frontier advances only while the next sample is within gapMs. Returns the
 * END of the contiguous run in ms, or null. This is the anti-MAX(timestamp)
 * primitive: one hole ends the frontier even if later samples exist.
 */
export function contiguousSampleThrough(samples, loMs, hiMs, gapMs = GAP_MS) {
  const times = inDaySamples(samples, loMs, hiMs)
    .map(parseSampleTime)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (!times.length) return null;
  let frontier = times[0];
  if (times[0] - loMs <= gapMs) frontier = Math.max(loMs, times[0]);
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] - frontier > gapMs) break;
    frontier = times[i];
  }
  return frontier;
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function clipGapToDay(gap, loMs, hiMs) {
  if (!gap) return null;
  const start = toMs(gap.start_at);
  const end = toMs(gap.end_at);
  if (start == null || end == null || end <= start) return null;
  const s = Math.max(start, loMs);
  const e = Math.min(end, hiMs);
  if (e <= s) return null;
  return { start_at: new Date(s).toISOString(), end_at: new Date(e).toISOString(), duration_ms: e - s };
}

function provenanceClassOf(row) {
  return row?.provenance_class ?? row?.meta?.provenance_class ?? row?.provenance ?? null;
}

/** Explicit wear-off / charging evidence only. Missing HR is never enough. */
export function hasExplicitNonwearEvidence(row) {
  if (!row) return false;
  if (isHistoricalPuffin54(row) || row.live_side_effects === false) return false;
  if (EXPECTED_ABSENCE_CLASSES.has(provenanceClassOf(row))) return true;
  if (NONWEAR_KINDS.has(String(row.kind || ''))) return true;
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
  const name = meta.event_name || row.event_name;
  if (name === 'WRIST_OFF') return true;
  if (meta.off_wrist === true || meta.wrist_off === true || meta.wrist_off === 1) return true;
  if (meta.skin_contact === 0) return true;
  if (meta.charging === true || meta.battery_charging === true || meta.battery_charging === 1) return true;
  return false;
}

export function nonwearEvidenceOf(row) {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  return {
    provenance: provenanceClassOf(row) || null,
    kind: row?.kind || null,
    event_name: meta.event_name || row?.event_name || null,
    skin_contact: meta.skin_contact ?? null,
    charging: meta.charging ?? meta.battery_charging ?? null,
  };
}

function sampleIsNonwearMark(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (isHistoricalPuffin54(sample) || sample.live_side_effects === false) return false;
  const name = sample.event_name || sample.eventName;
  if (name === 'WRIST_OFF') return true;
  if (sample.wrist_off === 1 || sample.wrist_off === true) return true;
  if (sample.on_wrist === 0) return true;
  if (sample.skin_contact === 0) return true;
  if (sample.battery_charging === 1 || sample.battery_charging === true || sample.charging === true) {
    return true;
  }
  return false;
}

/**
 * Confirmed nonwear windows from wrist/charging marks already on samples.
 * Does not invent windows from missing HR.
 */
export function nonwearWindowsFromSamples(samples, loMs, hiMs, mergeMs = 5 * 60000) {
  const marks = [];
  let offOpen = null;
  const rows = (samples || [])
    .map((s) => ({ s, t: parseSampleTime(s) }))
    .filter((x) => x.t != null)
    .sort((a, b) => a.t - b.t);
  for (const { s, t } of rows) {
    if (t < loMs || t >= hiMs) continue;
    if (isHistoricalPuffin54(s) || s.live_side_effects === false) continue;
    const name = s.event_name || s.eventName;
    if (name === 'WRIST_OFF') {
      if (offOpen == null) offOpen = t;
      continue;
    }
    if (name === 'WRIST_ON') {
      if (offOpen != null) {
        marks.push({ start: offOpen, end: t, kind: 'off_wrist', evidence: { event_name: 'WRIST_OFF' } });
        offOpen = null;
      }
      continue;
    }
    if (!sampleIsNonwearMark(s)) continue;
    const kind = (s.battery_charging === 1 || s.charging === true) ? 'charging' : 'off_wrist';
    marks.push({ start: t, end: t, kind, evidence: nonwearEvidenceOf(s) });
  }
  if (offOpen != null) {
    marks.push({ start: offOpen, end: hiMs, kind: 'off_wrist', evidence: { event_name: 'WRIST_OFF' } });
  }
  marks.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (!last || m.start > last.end + mergeMs) merged.push({ ...m });
    else last.end = Math.max(last.end, m.end);
  }
  return merged.filter((w) => w.end > w.start);
}

/**
 * Split persisted gap rows into backfilled / expected_absence / recoverable /
 * unrecoverable / unclassified. Backfilled and expected absence are never
 * open loss. Transport kinds without wear evidence stay recoverable or
 * unclassified — never expected absence.
 */
export function categorizeGaps(gapRows, {
  strapTrimmedThroughMs = null,
  historyOldestMs = null,
  rangeProbedAtMs = null,
  rangeTrustworthy = false,
} = {}) {
  const buckets = {
    recoverable: [],
    unrecoverable: [],
    unclassified: [],
    backfilled: [],
    expected_absence: [],
    live: [],
  };
  for (const rawRow of gapRows || []) {
    let row = rawRow;
    const endMs = toMs(row?.end_at);
    const cls = provenanceClassOf(row);
    let category;
    if (row?.resolved_at != null) {
      if (row.resolution === 'expected_absence') category = 'expected_absence';
      else if (row.resolution === 'unrecoverable' || row.resolution === 'strap_trimmed') {
        category = 'unrecoverable';
      } else category = 'backfilled';
    } else if (hasExplicitNonwearEvidence(row)) {
      category = 'expected_absence';
      row = { ...row, resolution_evidence: nonwearEvidenceOf(row) };
    } else if (cls != null && RECOVERABLE_CLASSES.has(cls)) {
      category = 'recoverable';
    } else if (cls != null && UNRECOVERABLE_CLASSES.has(cls)) {
      category = 'unrecoverable';
    } else if (cls === 'STRAP_OR_BLE_MISSING') {
      const oldest = toMs(historyOldestMs) ?? strapTrimmedThroughMs;
      const probed = toMs(rangeProbedAtMs);
      if (
        rangeTrustworthy === true
        && oldest != null
        && probed != null
        && oldest >= (endMs ?? 0)
        && probed >= (endMs ?? 0)
      ) {
        category = 'unrecoverable';
        row = {
          ...row,
          resolution_evidence: {
            history_oldest: new Date(oldest).toISOString(),
            range_probed_at: new Date(probed).toISOString(),
            range_trustworthy: true,
          },
        };
      } else if (oldest != null && oldest < (endMs ?? 0)) category = 'recoverable';
      else category = 'unclassified';
    } else if (TRANSPORT_KINDS.has(String(row?.kind)) || EVENT_KINDS.has(String(row?.kind))) {
      category = strapTrimmedThroughMs != null && strapTrimmedThroughMs < (endMs ?? 0)
        ? 'recoverable'
        : 'unclassified';
    } else {
      category = 'unclassified';
    }
    buckets[category].push(row);
    if (category !== 'backfilled' && category !== 'expected_absence') buckets.live.push(row);
  }
  return buckets;
}

/** Deterministic gap threshold: explicit input > cadence inference > GAP_MS. */
export function resolveGapThreshold(times, gapMs) {
  if (Number.isFinite(gapMs) && gapMs > 0) return gapMs;
  const deltas = [];
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i] - times[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return GAP_MS;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.max(GAP_MS, Math.min(3 * median, 600000));
}

function isHrSample(sample) {
  const bpm = sample?.bpm;
  return Number.isFinite(Number(bpm)) && Number(bpm) > 0;
}

function isRrSample(sample) {
  const rr = sample?.rr_ms ?? sample?.rrIntervals;
  return Array.isArray(rr) ? rr.length > 0 : Number.isFinite(Number(rr)) && Number(rr) > 0;
}

function coverageOf(times, loMs, hiMs) {
  const expectedSamples = Math.max(0, Math.round((hiMs - loMs) / EXPECTED_SAMPLE_MS));
  const expectedBuckets = Math.max(0, Math.round((hiMs - loMs) / BUCKET_MS));
  const buckets = new Set();
  for (const t of times) buckets.add(Math.floor((t - loMs) / BUCKET_MS));
  const pct = expectedBuckets ? Math.round((1000 * Math.min(buckets.size, expectedBuckets)) / expectedBuckets) / 10 : 0;
  return {
    expected_samples: expectedSamples,
    received_samples: times.length,
    coverage_pct: pct,
    expected_buckets: expectedBuckets,
    covered_buckets: Math.min(buckets.size, expectedBuckets),
  };
}

function manifestWindow(row) {
  const start = toMs(row?.start_at);
  const end = toMs(row?.end_at);
  return { start, end };
}

function manifestOverlapsDay(row, _day, loMs, hiMs) {
  const { start, end } = manifestWindow(row);
  if (start != null && end != null) return end > loMs && start < hiMs;
  if (start != null && end == null) return start < hiMs;
  if (start == null && end != null) return end > loMs;
  return false;
}

/**
 * True when a gap's full interval is covered by one contiguous sample run:
 * a sample lands within gapMs of the start, the frontier walks the whole
 * span, and a sample lands within gapMs of the end. The backfill resolver
 * uses this to close persisted gap rows explicitly.
 */
export function gapCoveredBySamples(gap, samples, { gapMs = GAP_MS } = {}) {
  const startMs = toMs(gap?.start_at);
  const endMs = toMs(gap?.end_at);
  if (startMs == null || endMs == null || endMs <= startMs) return false;
  const times = (samples || [])
    .map(parseSampleTime)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const inside = times.filter((t) => t >= startMs - gapMs && t <= endMs + gapMs);
  if (!inside.length) return false;
  if (inside[0] - startMs > gapMs) return false;
  if (endMs - inside[inside.length - 1] > gapMs) return false;
  for (let i = 1; i < inside.length; i += 1) {
    if (inside[i] - inside[i - 1] > gapMs) return false;
  }
  return true;
}

export function finalizeDecision(result) {
  const gates = [];
  if (!result?.day_finished) gates.push('day_not_finished');
  if (!result?.raw_archive_verification?.verification_complete) gates.push('archive_verification_incomplete');
  if ((result?.gaps?.counts?.recoverable ?? 0) > 0) gates.push('recoverable_gaps_open');
  if ((result?.gaps?.counts?.unclassified ?? 0) > 0) gates.push('unclassified_gaps_open');
  if ((result?.gaps?.unclassified_ms ?? 0) > 0) gates.push('unclassified_gap_time_open');
  if (gates.length) return { allowed: false, status: DAY_STATUS.OPEN, reason: gates.join('+') };
  const unrecoverable = result?.gaps?.counts?.unrecoverable ?? 0;
  return {
    allowed: true,
    status: unrecoverable > 0 ? DAY_STATUS.DEGRADED : DAY_STATUS.COMPLETE,
    reason: unrecoverable > 0 ? 'known_unrecoverable_loss' : 'no_open_gaps',
  };
}

/**
 * Compute the canonical completeness record for one local day.
 * Every field is always present; unknown is null, never fabricated.
 */
export function computeDayCompleteness(input = {}) {
  const {
    day,
    timeZone,
    samples = [],
    gapRows = [],
    manifestRows = [],
    verification = {},
    frontiers = {},
    dayFinishedAt = null,
    finalizedAt = null,
    gapMs = null,
    now = new Date(),
  } = input;

  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    throw new Error('day_completeness_requires_day');
  }
  const bounds = dayBounds(day, timeZone || 'UTC');
  const loMs = Date.parse(bounds.day_start_at);
  const hiMs = Date.parse(bounds.day_end_at);

  const daySamples = inDaySamples(samples, loMs, hiMs);
  const hrSamples = daySamples.filter(isHrSample);
  const rrSamples = daySamples.filter(isRrSample);
  const hrTimes = hrSamples.map(parseSampleTime).sort((a, b) => a - b);
  const rrTimes = rrSamples.map(parseSampleTime).sort((a, b) => a - b);

  const threshold = resolveGapThreshold(hrTimes, gapMs);

  // --- interval gaps: derived from the sample timeline, merged with persisted rows ---
  const derived = detectSampleGaps(hrSamples, { gapMs: threshold, expectedMs: EXPECTED_SAMPLE_MS });
  const dayFinished = dayFinishedAt != null;

  const openPersisted = [];
  const backfilledPersisted = [];
  for (const row of gapRows || []) {
    const clipped = clipGapToDay(row, loMs, hiMs);
    if (!clipped) continue;
    const wrapper = {
      ...clipped,
      kind: row?.kind,
      provenance_class: provenanceClassOf(row),
      meta: row?.meta,
      resolved_at: row?.resolved_at ?? null,
      resolution: row?.resolution ?? null,
      row,
      class: provenanceClassOf(row),
    };
    if (
      row?.resolved_at != null
      && row?.resolution !== 'expected_absence'
      && row?.resolution !== 'unrecoverable'
      && row?.resolution !== 'strap_trimmed'
    ) {
      backfilledPersisted.push(wrapper);
    } else openPersisted.push(wrapper);
  }

  for (const w of nonwearWindowsFromSamples(daySamples, loMs, hiMs)) {
    const clipped = clipGapToDay(
      { start_at: new Date(w.start).toISOString(), end_at: new Date(w.end).toISOString() },
      loMs,
      hiMs,
    );
    if (!clipped) continue;
    const startMs = Date.parse(clipped.start_at);
    const endMs = Date.parse(clipped.end_at);
    if (openPersisted.some((g) => startMs < Date.parse(g.end_at) && endMs > Date.parse(g.start_at))) continue;
    openPersisted.push({
      ...clipped,
      kind: w.kind,
      provenance_class: 'OFF_WRIST',
      provenance: 'OFF_WRIST',
      meta: { resolution_evidence: w.evidence },
      resolved_at: null,
      class: 'OFF_WRIST',
    });
  }

  const sortedPersisted = openPersisted.slice().sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  function overlapsPersisted(startMs, endMs) {
    return sortedPersisted.some((g) => {
      const s = Date.parse(g.start_at);
      const e = Date.parse(g.end_at);
      return startMs < e && endMs > s;
    });
  }

  // head/tail open spans count only for a finished day: while the day runs,
  // the tail is simply "not yet collected".
  const headStart = hrTimes.length ? hrTimes[0] : null;
  const tailStart = hrTimes.length ? hrTimes[hrTimes.length - 1] : null;
  const extra = [];
  // Open spans carry real duration_ms and are clipped like every other gap:
  // a finished day with data only in the middle (or no data at all) must stay
  // open, never finalize as complete.
  const pushExtra = (startMs, endMs) => {
    const clipped = clipGapToDay({ start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString() }, loMs, hiMs);
    if (clipped && clipped.duration_ms > 0) extra.push({ kind: 'missing_interval', ...clipped });
  };
  if (dayFinished) {
    if (headStart == null || headStart - loMs > threshold) {
      pushExtra(loMs, headStart ?? hiMs);
    }
    if (tailStart != null && hiMs - tailStart > threshold) {
      pushExtra(tailStart, hiMs);
    }
    if (!hrTimes.length) {
      extra.length = 0;
      pushExtra(loMs, hiMs);
    }
  } else if (!hrTimes.length) {
    pushExtra(loMs, hiMs);
  }

  const derivedRows = [];
  for (const d of derived) {
    const clipped = clipGapToDay(d, loMs, hiMs);
    if (!clipped) continue;
    if (overlapsPersisted(Date.parse(clipped.start_at), Date.parse(clipped.end_at))) continue;
    derivedRows.push({ ...clipped, class: classifyGap({}) });
  }
  for (const e of extra) {
    if (overlapsPersisted(Date.parse(e.start_at), Date.parse(e.end_at))) continue;
    derivedRows.push({ ...e, class: classifyGap({}) });
  }

  const categorized = categorizeGaps(
    [...openPersisted, ...derivedRows],
    {
      strapTrimmedThroughMs: toMs(frontiers.strapTrimmedThrough),
      historyOldestMs: toMs(frontiers.historyOldest ?? frontiers.strapTrimmedThrough),
      rangeProbedAtMs: toMs(frontiers.rangeProbedAt),
      rangeTrustworthy: frontiers.rangeTrustworthy === true,
    },
  );

  const durations = (rows) => rows.reduce((n, g) => n + (Number(g.duration_ms) || 0), 0);
  const openRows = [
    ...categorized.recoverable,
    ...categorized.unrecoverable,
    ...categorized.unclassified,
  ];
  const openMs = durations(openRows);
  const unclassifiedMs = durations(categorized.unclassified);

  let largestGap = null;
  for (const g of openRows) {
    if (!largestGap || g.duration_ms > largestGap.duration_ms) {
      largestGap = {
        start_at: g.start_at,
        end_at: g.end_at,
        duration_ms: g.duration_ms,
        class: g.class || provenanceClassOf(g.row) || 'missing_interval',
        category: categorized.recoverable.includes(g)
          ? GAP_CATEGORY.RECOVERABLE
          : categorized.unrecoverable.includes(g)
            ? GAP_CATEGORY.UNRECOVERABLE
            : GAP_CATEGORY.UNCLASSIFIED,
      };
    }
  }

  // --- archive verification ---
  const required = [];
  for (const row of manifestRows || []) {
    if (!manifestOverlapsDay(row, day, loMs, hiMs)) continue;
    if (row?.status && !['ready', 'verified'].includes(row.status)) continue;
    required.push(row);
  }
  const verifiedMap = verification?.verifiedByObjectKey instanceof Map
    ? verification.verifiedByObjectKey
    : new Map(Object.entries(verification?.verifiedByObjectKey || {}));
  const unverifiedKeys = [];
  const verifiedRows = [];
  for (const row of required) {
    const evidence = verifiedMap.get(row?.object_key);
    if (evidence) verifiedRows.push({ row, evidence });
    else unverifiedKeys.push(row?.object_key);
  }
  const verificationComplete = verification?.unavailableReason
    ? false
    : required.length > 0 && unverifiedKeys.length === 0;

  let archiveVerifiedThrough = null;
  {
    const frontier = verifiedArchiveFrontierMs(
      verifiedRows.map(({ row }) => row),
      loMs,
      hiMs,
    );
    if (frontier != null) archiveVerifiedThrough = new Date(Math.min(frontier, hiMs)).toISOString();
  }

  const contiguousThrough = contiguousSampleThrough(hrSamples, loMs, hiMs, threshold);
  const frontierMs = toMs(frontiers.historySyncedThrough);
  let historySyncedThrough = null;
  if (frontierMs != null && contiguousThrough != null) historySyncedThrough = Math.min(frontierMs, contiguousThrough);
  else if (frontierMs != null) historySyncedThrough = frontierMs;
  else historySyncedThrough = contiguousThrough;

  const lastOffloadCandidates = [];
  if (frontiers.lastSuccessfulOffload) {
    const ms = toMs(frontiers.lastSuccessfulOffload);
    if (ms != null) lastOffloadCandidates.push(ms);
  }
  for (const row of manifestRows || []) {
    const ms = toMs(row?.uploaded_at ?? row?.verified_at);
    if (ms != null) lastOffloadCandidates.push(ms);
  }
  const lastSuccessfulOffload = lastOffloadCandidates.length
    ? new Date(Math.max(...lastOffloadCandidates)).toISOString()
    : null;

  const result = {
    day,
    timezone_name: timeZone || 'UTC',
    day_start_at: bounds.day_start_at,
    day_end_at: bounds.day_end_at,
    day_finished: dayFinished,
    status: DAY_STATUS.OPEN,
    gap_threshold_ms: threshold,
    hr_coverage: coverageOf(hrTimes, loMs, hiMs),
    rr_coverage: coverageOf(rrTimes, loMs, hiMs),
    history_synced_through: historySyncedThrough != null ? new Date(historySyncedThrough).toISOString() : null,
    contiguous_sample_through: contiguousThrough != null ? new Date(contiguousThrough).toISOString() : null,
    largest_gap: largestGap,
    gaps: {
      live: categorized.live.map((g) => ({ start_at: g.start_at, end_at: g.end_at, duration_ms: g.duration_ms, class: g.class || provenanceClassOf(g.row) || 'missing_interval', kind: g.row?.kind || g.kind || 'missing_interval' })),
      backfilled: backfilledPersisted.map((g) => ({ start_at: g.start_at, end_at: g.end_at, duration_ms: g.duration_ms })),
      expected_absence: categorized.expected_absence.map((g) => ({
        start_at: g.start_at,
        end_at: g.end_at,
        duration_ms: g.duration_ms,
        class: g.class || provenanceClassOf(g.row) || 'OFF_WRIST',
        kind: g.row?.kind || g.kind || 'off_wrist',
        evidence: g.resolution_evidence || g.meta?.resolution_evidence || nonwearEvidenceOf(g.row || g),
      })),
      unrecoverable: categorized.unrecoverable.map((g) => ({ start_at: g.start_at, end_at: g.end_at, duration_ms: g.duration_ms, class: g.class || provenanceClassOf(g.row) || 'missing_interval' })),
      recoverable_remaining: categorized.recoverable.map((g) => ({ start_at: g.start_at, end_at: g.end_at, duration_ms: g.duration_ms, class: g.class || provenanceClassOf(g.row) || g.row?.kind || 'missing_interval' })),
      counts: {
        live: categorized.live.length,
        backfilled: backfilledPersisted.length,
        expected_absence: categorized.expected_absence.length,
        unrecoverable: categorized.unrecoverable.length,
        recoverable: categorized.recoverable.length,
        unclassified: categorized.unclassified.length,
      },
      unclassified_ms: unclassifiedMs,
      open_ms: openMs,
    },
    last_successful_offload: lastSuccessfulOffload,
    raw_archive_verification: {
      required_objects: required.length,
      verified_objects: verifiedRows.length,
      verification_complete: verificationComplete,
      unverified_object_keys: unverifiedKeys,
      unavailable_reason: verification?.unavailableReason ?? null,
    },
    archive_verified_through: archiveVerifiedThrough,
    recomputed_through: frontiers.recomputedThrough ?? null,
    finalized: false,
    finalized_at: null,
  };

  if (result.hr_coverage.expected_buckets === 0) result.hr_coverage.coverage_pct = 0;
  if (result.rr_coverage.expected_buckets === 0) result.rr_coverage.coverage_pct = 0;

  const decision = finalizeDecision(result);
  result.status = decision.status;
  if (finalizedAt != null && result.status !== DAY_STATUS.OPEN) {
    result.finalized = true;
    result.finalized_at = finalizedAt;
  }
  return result;
}

/** One wire object for a requested day. finalized is derived, never a second meaning. */
export function toDayCompletenessWire(result) {
  const r = result || {};
  const finalizedAt = r.status === DAY_STATUS.OPEN ? null : (r.finalized_at || null);
  return {
    day: r.day ?? null,
    status: r.status || DAY_STATUS.OPEN,
    finalized_at: finalizedAt,
    hr_coverage: r.hr_coverage || null,
    rr_coverage: r.rr_coverage || null,
    history_synced_through: r.history_synced_through ?? null,
    archive_verified_through: r.archive_verified_through ?? null,
    largest_gap_seconds: r.largest_gap?.duration_ms != null
      ? Math.round(Number(r.largest_gap.duration_ms) / 1000)
      : 0,
    live_gaps: r.gaps?.counts?.live ?? 0,
    backfilled_gaps: r.gaps?.counts?.backfilled ?? 0,
    unrecoverable_gaps: r.gaps?.counts?.unrecoverable ?? 0,
    unclassified_gap_seconds: Math.round((r.gaps?.unclassified_ms || 0) / 1000),
    raw_archive_verified: Boolean(r.raw_archive_verification?.verification_complete),
    last_successful_offload_at: r.last_successful_offload ?? null,
  };
}
