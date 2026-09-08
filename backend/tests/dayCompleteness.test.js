import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeDayCompleteness,
  finalizeDecision,
  contiguousSampleThrough,
  categorizeGaps,
  hasExplicitNonwearEvidence,
  nonwearWindowsFromSamples,
  DAY_STATUS,
  GAP_CATEGORY,
} from '../metrics/dayCompleteness.js';
import { dayBounds } from '../time/dayBoundary.js';

const TZ = 'America/Los_Angeles';
const DAY = '2026-08-28';

function dayMs(day, tz = TZ) {
  const b = dayBounds(day, tz);
  return [Date.parse(b.day_start_at), Date.parse(b.day_end_at)];
}

/** One sample every `cadenceMs` across the day, in local-day bounds. */
function generate(day, cadenceMs, { skip = () => false, bpm = 60 } = {}) {
  const [lo, hi] = dayMs(day);
  const out = [];
  for (let t = lo; t < hi; t += cadenceMs) {
    if (bpm == null && !skip(t)) { /* keep generator simple */ }
    if (skip(t)) continue;
    out.push({ datetime: new Date(t).toISOString(), bpm, rr_ms: [], connected: true, src: 'ble_hr' });
  }
  return out;
}

function denseDay(day, cadenceMs = 4000) {
  return generate(day, { bpm: 55 });
  function generate() {
    const [lo, hi] = dayMs(day);
    const out = [];
    for (let t = lo; t < hi; t += cadenceMs) {
      out.push({ datetime: new Date(t).toISOString(), bpm: 55, rr_ms: [], connected: true, src: 'ble_hr' });
    }
    return out;
  }
}

const VERIFIED = (keys) => ({
  verifiedByObjectKey: Object.fromEntries(keys.map((k) => [k, { sha256: 'a'.repeat(64), verified_at: '2026-08-29T10:00:00Z' }])),
});

function manifestsFor(day, count = 24) {
  const [lo, hi] = dayMs(day);
  const span = Math.round((hi - lo) / count);
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    object_key: `phys-${day}-${i}`,
    object_kind: 'physiology',
    status: 'ready',
    start_at: new Date(lo + i * Math.floor((hi - lo) / count)).toISOString(),
    end_at: new Date(Math.min(hi, lo + (i + 1) * Math.floor((hi - lo) / count))).toISOString(),
    period_day: day,
  }));
}

test('1. complete synthetic day is complete with full coverage and zero open gaps', () => {
  const samples = denseDay(DAY);
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, DAY_STATUS.COMPLETE);
  assert.equal(r.hr_coverage.coverage_pct, 100);
  assert.equal(r.hr_coverage.expected_buckets, 288);
  assert.equal(r.gaps.counts.live, 0);
  assert.equal(r.gaps.unclassified_ms, 0);
  assert.equal(r.raw_archive_verification.verification_complete, true);
  assert.ok(finalizeDecision(r).allowed);
});

test('2. DST: 2026-11-01 fall-back is a 25h day (300 buckets); 2027-03-14 spring-forward is 23h (276)', () => {
  for (const [day, buckets] of [['2026-11-01', 300], ['2027-03-14', 276]]) {
    const r = computeDayCompleteness({
      day,
      timeZone: TZ,
      samples: denseDay(day, 60000),
      manifestRows: manifestsFor(day),
      verification: VERIFIED(manifestsFor(day).map((m) => m.object_key)),
      dayFinishedAt: '2027-06-01T00:00:00Z',
    });
    assert.equal(r.hr_coverage.expected_buckets, buckets, `${day} must be ${buckets} buckets`);
    assert.equal(r.status, DAY_STATUS.COMPLETE);
    assert.equal(r.hr_coverage.coverage_pct, 100);
  }
});

test('3. suspension gap with strap still holding data is recoverable -> open, never finalizable', () => {
  const gapStart = dayMs(DAY)[0] + 3 * 3600000;
  const gapEnd = gapStart + Math.round(8.9 * 3600000);
  const samples = denseDay(DAY, 4000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{ id: 'g1', kind: 'suspend', start_at: new Date(gapStart).toISOString(), end_at: new Date(gapEnd).toISOString() }],
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    frontiers: { strapTrimmedThrough: new Date(gapStart - 1000).toISOString() },
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.equal(r.gaps.counts.recoverable, 1);
  assert.equal(r.gaps.counts.unclassified, 0);
  assert.ok(Math.abs(r.largest_gap.duration_ms - (gapEnd - gapStart)) < 5000, `largest gap ${r.largest_gap.duration_ms}`);
  assert.equal(finalizeDecision(r).allowed, false);
  assert.equal(finalizeDecision(r).reason.includes('recoverable_gaps_open'), true);
});

test('4. reconnect history repair: resolved gap row + present samples -> backfilled, complete', () => {
  const gapStart = dayMs(DAY)[0] + 3 * 3600000;
  const gapEnd = gapStart + 40 * 60000;
  const samples = denseDay(DAY, 60000); // backfill delivered the missing rows
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{
      id: 'g1', kind: 'suspend',
      start_at: new Date(gapStart).toISOString(), end_at: new Date(gapEnd).toISOString(),
      resolved_at: '2026-08-29T02:00:00Z', resolution: 'backfilled',
    }],
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.backfilled, 1);
  assert.equal(r.gaps.counts.live, 0);
  assert.equal(r.status, DAY_STATUS.COMPLETE);
  assert.ok(finalizeDecision(r).allowed);
});

test('5. partial history cycle: 40-min hole with no gap row -> unclassified -> open', () => {
  const holeStart = dayMs(DAY)[0] + 10 * 3600000;
  const holeEnd = holeStart + 40 * 60000;
  const samples = denseDay(DAY, 30000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < holeStart || t >= holeEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.equal(r.gaps.counts.unclassified, 1);
  assert.ok(Math.abs(r.gaps.unclassified_ms - 40 * 60000) < 60000, `unclassified_ms ${r.gaps.unclassified_ms}`);
  assert.equal(finalizeDecision(r).allowed, false);
});

test('6. duplicate resend does not inflate coverage', () => {
  const samples = denseDay(DAY, 60000);
  const duped = [...samples, ...samples.map((s) => ({ ...s }))];
  const a = computeDayCompleteness({ day: DAY, timeZone: TZ, samples });
  const b = computeDayCompleteness({ day: DAY, timeZone: TZ, samples: duped });
  assert.equal(b.hr_coverage.received_samples, a.hr_coverage.received_samples);
  assert.equal(b.hr_coverage.coverage_pct, a.hr_coverage.coverage_pct);
});

test('7. process restart: MAX(timestamp) trap — contiguous frontier ignores an isolated late sample', () => {
  const [lo] = dayMs(DAY);
  const dense = [];
  for (let t = lo; t < lo + 12 * 3600000; t += 4000) {
    dense.push({ datetime: new Date(t).toISOString(), bpm: 55 });
  }
  const isolated = { datetime: new Date(lo + 23 * 3600000 + 50 * 60000).toISOString(), bpm: 57 };
  const samples = [...dense, isolated];
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    frontiers: { historySyncedThrough: new Date(lo + 12 * 3600000 + 30 * 60000).toISOString() },
  });
  // frontier must end the 00:00-12:00 dense run, NOT the 23:50 outlier
  const expectedFrontier = new Date(lo + 12 * 3600000 - 4000).toISOString();
  assert.equal(r.contiguous_sample_through, expectedFrontier);
  // min() of the provided frontier and the contiguous frontier wins, never max
  assert.equal(r.history_synced_through, expectedFrontier);
  assert.notEqual(r.history_synced_through, new Date(lo + 23 * 3600000 + 50 * 60000).toISOString());
});

test('8. network outage: open upload-kind gap with strap trimmed past it -> unclassified -> open', () => {
  const gapStart = dayMs(DAY)[0] + 5 * 3600000;
  const gapEnd = gapStart + 25 * 60000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{ id: 'g2', kind: 'upload', start_at: new Date(gapStart).toISOString(), end_at: new Date(gapEnd).toISOString() }],
    frontiers: { strapTrimmedThrough: new Date(gapEnd + 60000).toISOString() },
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.equal(r.gaps.counts.unclassified, 1);
});

test('9. backend/B2 failure: one unverified required object -> verification incomplete -> open; archive_verified_through limited', () => {
  const manifests = manifestsFor(DAY);
  const [lo] = dayMs(DAY);
  // verify only the first half of objects
  const half = manifests.filter((m) => Date.parse(m.end_at) <= lo + 12 * 3600000).map((m) => m.object_key);
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples: denseDay(DAY, 60000),
    manifestRows: manifests,
    verification: VERIFIED(half),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.raw_archive_verification.verification_complete, false);
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.ok(r.raw_archive_verification.unverified_object_keys.length > 0);
  assert.ok(r.archive_verified_through != null);
  assert.ok(Date.parse(r.archive_verified_through) <= lo + 12 * 3600000 + 1000,
    'verified-through must stop at the verified run');
});

test('10. cross-midnight: each local day counts only its own bounds', () => {
  const dayA = '2026-08-28';
  const dayB = '2026-08-29';
  const [loA, hiA] = dayMs(dayA);
  const [loB, hiB] = dayMs(dayB);
  const samples = [];
  for (let t = loA + 23 * 3600000; t < hiB - 1 * 3600000; t += 30000) {
    samples.push({ datetime: new Date(t).toISOString(), bpm: 60 });
  }
  const ra = computeDayCompleteness({ day: dayA, timeZone: TZ, samples, dayFinishedAt: '2026-08-30T00:00:00Z' });
  const rb = computeDayCompleteness({ day: dayB, timeZone: TZ, samples, dayFinishedAt: '2026-08-30T00:00:00Z' });
  assert.equal(ra.hr_coverage.received_samples, 120, 'day A gets exactly its last hour');
  assert.equal(rb.hr_coverage.received_samples, Math.round((hiB - loB - 3600000) / 30000), 'day B gets the rest');
  // boundary samples land in exactly one day
  const at235959 = { datetime: new Date(hiA - 1000).toISOString(), bpm: 60 };
  const at000001 = { datetime: new Date(hiA + 1000).toISOString(), bpm: 60 };
  const ca = computeDayCompleteness({ day: dayA, timeZone: TZ, samples: [at235959, at000001] });
  assert.equal(ca.hr_coverage.received_samples, 1);
});

test('11. GET_DATA_RANGE oldest alone does not make a strap gap unrecoverable', () => {
  const gapStart = dayMs(DAY)[0] + 6 * 3600000;
  const gapEnd = gapStart + 2 * 3600000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{
      id: 'g3', kind: 'connection',
      start_at: new Date(gapStart).toISOString(), end_at: new Date(gapEnd).toISOString(),
      provenance_class: 'STRAP_OR_BLE_MISSING',
    }],
    frontiers: { strapTrimmedThrough: new Date(gapEnd + 3600000).toISOString() },
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.unrecoverable, 0);
  assert.equal(r.gaps.counts.unclassified, 1);
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.equal(finalizeDecision(r).allowed, false);
});

test('11b. unrecoverable requires trustworthy range, post-gap probe, and oldest past the gap', () => {
  const gapStart = dayMs(DAY)[0] + 6 * 3600000;
  const gapEnd = gapStart + 2 * 3600000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{
      id: 'g3', kind: 'connection',
      start_at: new Date(gapStart).toISOString(), end_at: new Date(gapEnd).toISOString(),
      provenance_class: 'STRAP_OR_BLE_MISSING',
    }],
    frontiers: {
      historyOldest: new Date(gapEnd + 3600000).toISOString(),
      rangeProbedAt: new Date(gapEnd + 2 * 3600000).toISOString(),
      rangeTrustworthy: true,
    },
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.unrecoverable, 1);
  assert.equal(r.status, DAY_STATUS.DEGRADED);
  assert.equal(finalizeDecision(r).allowed, true);
});

test('12. finalized invariant (negative): 99% coverage with one unclassified gap stays open', () => {
  const [lo, hi] = dayMs(DAY);
  const gapStart = lo + 12 * 3600000;
  const gapEnd = gapStart + 10 * 60000; // ~0.7% loss -> ~99.3% coverage
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.ok(r.hr_coverage.coverage_pct > 99, `coverage ${r.hr_coverage.coverage_pct}`);
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.equal(r.finalized, false);
  assert.equal(finalizeDecision(r).allowed, false);
});

test('13. rr coverage counts only rr-bearing samples and never blocks hr accounting', () => {
  const [lo, hi] = dayMs(DAY);
  const samples = denseDay(DAY, 60000).map((s) => {
    const withRr = Date.parse(s.datetime) < lo + 12 * 3600000;
    return withRr ? { ...s, rr_ms: [900, 910] } : s;
  });
  const r = computeDayCompleteness({ day: DAY, timeZone: TZ, samples });
  assert.ok(r.rr_coverage.coverage_pct < 52 && r.rr_coverage.coverage_pct > 48,
    `rr bucket coverage should be ~50%, got ${r.rr_coverage.coverage_pct}`);
  assert.equal(r.hr_coverage.coverage_pct, 100);
  assert.equal(r.rr_coverage.received_samples * 2, r.hr_coverage.received_samples);
});

test('14. acceptance-style 30s cadence day completes (cadence-inferred threshold)', () => {
  const samples = denseDay(DAY, 30000);
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gap_threshold_ms, Math.max(10000, Math.min(3 * 30000, 600000)));
  assert.equal(r.gaps.counts.live, 0);
  assert.equal(r.status, DAY_STATUS.COMPLETE);
});

test('15. contiguousSampleThrough primitive stops at the first hole', () => {
  const [lo] = dayMs(DAY);
  const times = [];
  for (let t = lo; t < lo + 3600000; t += 4000) times.push({ datetime: new Date(t).toISOString() });
  const result = contiguousSampleThrough(times, lo, lo + 3600000, 10000);
  assert.equal(result, lo + 3600000 - 4000);
  const withHole = times.concat([{ datetime: new Date(lo + 3500000).toISOString() }]);
  const result2 = contiguousSampleThrough(withHole, lo, lo + 3600000, 10000);
  assert.equal(result2, lo + 3600000 - 4000, 'hole must end the frontier before the late sample');
});

test('16. categorizeGaps: strap trim evidence decides recoverable vs unrecoverable', () => {
  const rows = [
    { kind: 'connection', start_at: '2026-08-28T10:00:00Z', end_at: '2026-08-28T11:00:00Z' },
  ];
  const a = categorizeGaps(rows, { strapTrimmedThroughMs: Date.parse('2026-08-28T10:30:00Z') });
  assert.equal(a.recoverable.length, 1);
  const b = categorizeGaps(rows, { strapTrimmedThroughMs: Date.parse('2026-08-28T11:30:00Z') });
  assert.equal(b.unclassified.length, 1);
  const c = categorizeGaps([{ ...rows[0], provenance_class: 'STRAP_OR_BLE_MISSING' }], { strapTrimmedThroughMs: Date.parse('2026-08-28T11:30:00Z') });
  assert.equal(c.unclassified.length, 1);
  const e = categorizeGaps([{ ...rows[0], provenance_class: 'STRAP_OR_BLE_MISSING' }], {
    historyOldestMs: Date.parse('2026-08-28T11:30:00Z'),
    rangeProbedAtMs: Date.parse('2026-08-28T12:00:00Z'),
    rangeTrustworthy: true,
  });
  assert.equal(e.unrecoverable.length, 1);
  assert.equal(e.unrecoverable[0].resolution_evidence.range_trustworthy, true);
  const d = categorizeGaps([{ ...rows[0], resolved_at: '2026-08-28T12:00:00Z' }], {});
  assert.equal(d.backfilled.length, 1);
  assert.equal(d.live.length, 0);
});

test('17. NEGATIVE (P0): finished day with data only 12:00-12:01 stays open — head/tail gaps block', () => {
  const [lo, hi] = dayMs(DAY);
  const samples = [];
  for (let t = lo + 12 * 3600000; t < lo + 12 * 3600000 + 60000; t += 4000) {
    samples.push({ datetime: new Date(t).toISOString(), bpm: 60 });
  }
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, 'open', `status ${r.status}`);
  assert.ok(finalizeDecision(r).allowed === false);
  assert.equal(finalizeDecision(r).reason.includes('unclassified'), true);
  assert.ok(r.gaps.unclassified_ms >= 23 * 3600000 - 60000,
    `unclassified gap time must cover the head+tail, got ${r.gaps.unclassified_ms}`);
});

test('18. NEGATIVE: empty finished day with verified manifests and zero required coverage stays open', () => {
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples: [],
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, 'open');
  assert.equal(finalizeDecision(r).allowed, false);
  assert.equal(r.hr_coverage.received_samples, 0);
});

test('19. head/tail gaps carry duration and count as unclassified', () => {
  const [lo, hi] = dayMs(DAY);
  const samples = denseDay(DAY, 60000).slice(100, 200); // data only in a middle window
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, 'open');
  assert.ok(r.gaps.counts.unclassified >= 2, 'head and tail must both count');
  assert.ok(r.gaps.unclassified_ms > 0);
  assert.ok(r.largest_gap != null && r.largest_gap.duration_ms > 0);
});

test('20. charging / intentional nonwear is expected absence, not unrecoverable, and does not block complete', () => {
  const [lo] = dayMs(DAY);
  const gapStart = lo + 10 * 3600000;
  const gapEnd = gapStart + 2 * 3600000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{
      id: 'wear1',
      kind: 'charging',
      start_at: new Date(gapStart).toISOString(),
      end_at: new Date(gapEnd).toISOString(),
      provenance: 'OFF_WRIST',
      meta: { charging: true, event_name: 'WRIST_OFF' },
    }],
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.expected_absence, 1);
  assert.equal(r.gaps.counts.unrecoverable, 0);
  assert.equal(r.gaps.counts.unclassified, 0);
  assert.equal(r.gaps.counts.recoverable, 0);
  assert.ok(r.gaps.expected_absence[0].evidence.charging);
  assert.equal(r.status, DAY_STATUS.COMPLETE);
  assert.equal(finalizeDecision(r).allowed, true);
});

test('21. BLE dropout while worn stays recoverable/unclassified, never expected absence', () => {
  const [lo] = dayMs(DAY);
  const gapStart = lo + 4 * 3600000;
  const gapEnd = gapStart + 20 * 60000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{
      id: 'ble1',
      kind: 'connection',
      start_at: new Date(gapStart).toISOString(),
      end_at: new Date(gapEnd).toISOString(),
    }],
    frontiers: { strapTrimmedThrough: new Date(gapStart - 1000).toISOString() },
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.expected_absence, 0);
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.ok(r.gaps.counts.recoverable + r.gaps.counts.unclassified >= 1);
});

test('22. unresolved missing data without wear evidence stays unclassified', () => {
  const [lo] = dayMs(DAY);
  const gapStart = lo + 5 * 3600000;
  const gapEnd = gapStart + 40 * 60000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [],
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.status, DAY_STATUS.OPEN);
  assert.ok(r.gaps.counts.unclassified >= 1);
  assert.equal(r.gaps.counts.expected_absence, 0);
});

test('23. WRIST_OFF then WRIST_ON samples classify the window as expected absence', () => {
  const [lo, hi] = dayMs(DAY);
  const off = lo + 8 * 3600000;
  const on = off + 90 * 60000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < off || t >= on;
  });
  samples.push({ datetime: new Date(off).toISOString(), event_name: 'WRIST_OFF' });
  samples.push({ datetime: new Date(on).toISOString(), event_name: 'WRIST_ON' });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.ok(r.gaps.counts.expected_absence >= 1, `expected_absence ${r.gaps.counts.expected_absence}`);
  assert.equal(r.gaps.counts.unrecoverable, 0);
  assert.equal(r.status, DAY_STATUS.COMPLETE, `status ${r.status} unclassified=${r.gaps.counts.unclassified}`);
  void hi;
});

test('24. backfilled hole is observed-repaired, not expected absence', () => {
  const [lo] = dayMs(DAY);
  const gapStart = lo + 3 * 3600000;
  const gapEnd = gapStart + 15 * 60000;
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples: denseDay(DAY, 60000),
    gapRows: [{
      id: 'bf1',
      kind: 'connection',
      start_at: new Date(gapStart).toISOString(),
      end_at: new Date(gapEnd).toISOString(),
      resolved_at: '2026-08-29T01:00:00Z',
      resolution: 'backfilled',
    }],
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.backfilled, 1);
  assert.equal(r.gaps.counts.expected_absence, 0);
  assert.equal(r.status, DAY_STATUS.COMPLETE);
});

test('25. permanent loss stays unrecoverable, never expected absence or backfill', () => {
  const [lo] = dayMs(DAY);
  const gapStart = lo + 6 * 3600000;
  const gapEnd = gapStart + 2 * 3600000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < gapStart || t >= gapEnd;
  });
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    gapRows: [{
      id: 'lost1',
      kind: 'connection',
      start_at: new Date(gapStart).toISOString(),
      end_at: new Date(gapEnd).toISOString(),
      resolved_at: '2026-08-29T02:00:00Z',
      resolution: 'unrecoverable',
      provenance_class: 'STRAP_OR_BLE_MISSING',
    }],
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.unrecoverable, 1);
  assert.equal(r.gaps.counts.backfilled, 0);
  assert.equal(r.gaps.counts.expected_absence, 0);
  assert.equal(r.status, DAY_STATUS.DEGRADED);
});

test('26. packet 54 records never classify wrist nonwear', () => {
  const [lo, hi] = dayMs(DAY);
  const off = lo + 8 * 3600000;
  const on = off + 90 * 60000;
  const samples = denseDay(DAY, 60000).filter((s) => {
    const t = Date.parse(s.datetime);
    return t < off || t >= on;
  });
  samples.push({
    datetime: new Date(off).toISOString(),
    kind: 'puffin_event_54',
    event_name: 'PUFFIN_EVENT_9',
    candidate_name: 'WRIST_ON',
    historical: true,
    live_side_effects: false,
    envelope: { packet_type: 54 },
  });
  samples.push({
    datetime: new Date(off).toISOString(),
    kind: 'puffin_event_54',
    event_name: 'WRIST_OFF',
    historical: true,
    live_side_effects: false,
    envelope: { packet_type: 54 },
  });
  assert.equal(hasExplicitNonwearEvidence(samples[samples.length - 1]), false);
  const windows = nonwearWindowsFromSamples(samples, lo, hi);
  assert.equal(windows.length, 0);
  const r = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: manifestsFor(DAY),
    verification: VERIFIED(manifestsFor(DAY).map((m) => m.object_key)),
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(r.gaps.counts.expected_absence, 0);
  void on;
});
