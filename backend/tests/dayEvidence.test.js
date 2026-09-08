import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeArchive, sha256Hex } from '../ingest/archiveFormat.js';
import {
  verifiedArchiveFrontierMs,
  dedupeManifests,
  manifestOverlapsWindow,
  loadVerifiedPhysiologyObject,
  loadCanonicalDayEvidence,
  OVERNIGHT_LOOKBACK_MS,
} from '../metrics/dayEvidence.js';
import { toDayCompletenessWire, computeDayCompleteness, DAY_STATUS } from '../metrics/dayCompleteness.js';
import { dayBounds } from '../time/dayBoundary.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TZ = 'America/Los_Angeles';
const DAY = '2026-08-28';

function boundsMs(day = DAY) {
  const b = dayBounds(day, TZ);
  return [Date.parse(b.day_start_at), Date.parse(b.day_end_at)];
}

test('archive frontier: overlapping objects merge to day end', () => {
  const [lo, hi] = boundsMs();
  const mid = lo + 12 * 3600000;
  const frontier = verifiedArchiveFrontierMs([
    { start_at: new Date(lo).toISOString(), end_at: new Date(mid + 3600000).toISOString() },
    { start_at: new Date(mid).toISOString(), end_at: new Date(hi).toISOString() },
  ], lo, hi);
  assert.equal(frontier, hi);
});

test('archive frontier: head gap yields null', () => {
  const [lo, hi] = boundsMs();
  const frontier = verifiedArchiveFrontierMs([
    { start_at: new Date(lo + 600000).toISOString(), end_at: new Date(hi).toISOString() },
  ], lo, hi);
  assert.equal(frontier, null);
});

test('archive frontier: middle gap stops before the hole', () => {
  const [lo, hi] = boundsMs();
  const aEnd = lo + 10 * 3600000;
  const bStart = aEnd + 600000;
  const frontier = verifiedArchiveFrontierMs([
    { start_at: new Date(lo).toISOString(), end_at: new Date(aEnd).toISOString() },
    { start_at: new Date(bStart).toISOString(), end_at: new Date(hi).toISOString() },
  ], lo, hi);
  assert.equal(frontier, aEnd);
});

test('archive frontier: tail gap stops before day end', () => {
  const [lo, hi] = boundsMs();
  const end = hi - 3600000;
  const frontier = verifiedArchiveFrontierMs([
    { start_at: new Date(lo).toISOString(), end_at: new Date(end).toISOString() },
  ], lo, hi);
  assert.equal(frontier, end);
});

test('archive frontier: cross-midnight object is clipped to the local day', () => {
  const [lo, hi] = boundsMs();
  const frontier = verifiedArchiveFrontierMs([
    { start_at: new Date(lo - 3600000).toISOString(), end_at: new Date(hi + 3600000).toISOString() },
  ], lo, hi);
  assert.equal(frontier, hi);
});

test('archive frontier: duplicate manifests do not shrink coverage', () => {
  const [lo, hi] = boundsMs();
  const row = { start_at: new Date(lo).toISOString(), end_at: new Date(hi).toISOString() };
  assert.equal(verifiedArchiveFrontierMs([row, row, row], lo, hi), hi);
});

test('archive frontier: late object after a hole does not skip the hole', () => {
  const [lo, hi] = boundsMs();
  const holeEnd = lo + 2 * 3600000;
  const late = lo + 20 * 3600000;
  const frontier = verifiedArchiveFrontierMs([
    { start_at: new Date(lo).toISOString(), end_at: new Date(holeEnd).toISOString() },
    { start_at: new Date(late).toISOString(), end_at: new Date(hi).toISOString() },
  ], lo, hi);
  assert.equal(frontier, holeEnd);
});

test('dedupeManifests prefers stable id then object_key', () => {
  const rows = [
    { id: 'a', object_key: 'k1' },
    { id: 'a', object_key: 'k1-dup' },
    { object_key: 'k2' },
    { object_key: 'k2' },
  ];
  assert.equal(dedupeManifests(rows).length, 2);
});

test('period_day is not an overlap filter', () => {
  const [lo, hi] = boundsMs();
  const taggedNeighbor = {
    period_day: '2026-08-27',
    start_at: new Date(lo + 1000).toISOString(),
    end_at: new Date(lo + 3600000).toISOString(),
  };
  assert.equal(manifestOverlapsWindow(taggedNeighbor, lo, hi), true);
  const labeledOnly = { period_day: DAY };
  assert.equal(manifestOverlapsWindow(labeledOnly, lo, hi), false);
});

test('loadVerifiedPhysiologyObject fails closed on missing or mismatched digest', async () => {
  const packed = encodeArchive([{ datetime: '2026-08-28T12:00:00.000Z', bpm: 60 }]);
  const raw = { async getObject() { return { body: packed.body }; } };
  const miss = await loadVerifiedPhysiologyObject(raw, { object_key: 'k', status: 'ready' });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'missing_digest');
  const bad = await loadVerifiedPhysiologyObject(raw, {
    object_key: 'k', status: 'ready', sha256: '0'.repeat(64),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'digest_mismatch');
  const ok = await loadVerifiedPhysiologyObject(raw, {
    object_key: 'k', status: 'ready', sha256: packed.sha256,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.sha256, sha256Hex(Buffer.from(packed.body)));
});

test('HEAD/length/ETag alone cannot verify; corrupt objects block the day', async () => {
  const packed = encodeArchive([{ datetime: '2026-08-28T12:00:00.000Z', bpm: 60 }]);
  const [lo, hi] = boundsMs();
  const db = {
    async listPhysiologyManifests() {
      return [{
        id: 'm1',
        object_key: 'phys-1',
        object_kind: 'physiology',
        status: 'ready',
        start_at: new Date(lo).toISOString(),
        end_at: new Date(hi).toISOString(),
        sha256: packed.sha256,
      }];
    },
    async listIngestGaps() { return []; },
    async markManifestCorrupt() { this.corrupt = true; },
  };
  const raw = { async getObject() { return { body: Buffer.from('not-the-archive') }; } };
  const evidence = await loadCanonicalDayEvidence({ db, raw, userId: 'u', day: DAY, timeZone: TZ });
  assert.equal(evidence.failures[0].reason, 'digest_mismatch');
  assert.equal(db.corrupt, true);
  const gate = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples: evidence.samples,
    manifestRows: evidence.manifestRows,
    verification: { verifiedByObjectKey: evidence.verifiedByObjectKey, unavailableReason: evidence.unavailableReason },
    dayFinishedAt: '2026-08-29T15:00:00Z',
  });
  assert.equal(gate.status, DAY_STATUS.OPEN);
  assert.equal(gate.raw_archive_verification.verification_complete, false);
});

test('wire fixture matches toDayCompletenessWire keys', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(path.join(here, '../../contracts/day_completeness.v1.json'), 'utf8'));
  const keys = Object.keys(fixture);
  const sample = toDayCompletenessWire({
    day: fixture.day,
    status: fixture.status,
    finalized_at: fixture.finalized_at,
    hr_coverage: fixture.hr_coverage,
    rr_coverage: fixture.rr_coverage,
    history_synced_through: fixture.history_synced_through,
    archive_verified_through: fixture.archive_verified_through,
    largest_gap: { duration_ms: fixture.largest_gap_seconds * 1000 },
    gaps: { counts: { live: 0, backfilled: 0, unrecoverable: 0 }, unclassified_ms: 0 },
    raw_archive_verification: { verification_complete: true },
    last_successful_offload: fixture.last_successful_offload_at,
  });
  assert.deepEqual(Object.keys(sample).sort(), keys.sort());
  assert.equal(sample.finalized_at, fixture.finalized_at);
  assert.equal('finalized' in sample, false);
});

test('wake-day evidence includes pre-midnight physiology via 12h lookback', async () => {
  const packed = encodeArchive([{ datetime: '2026-08-28T05:00:00.000Z', bpm: 50 }]);
  const db = {
    async listPhysiologyManifests() {
      return [{
        id: 'eve',
        object_key: 'phys-eve',
        object_kind: 'physiology',
        status: 'ready',
        start_at: '2026-08-28T05:00:00.000Z',
        end_at: '2026-08-28T06:30:00.000Z',
        sha256: packed.sha256,
      }];
    },
    async listIngestGaps() { return []; },
  };
  const raw = { async getObject() { return { body: packed.body }; } };
  const evidence = await loadCanonicalDayEvidence({ db, raw, userId: 'u', day: DAY, timeZone: TZ });
  const [calendarLo] = boundsMs();
  assert.ok(Date.parse('2026-08-28T06:30:00.000Z') <= calendarLo, 'fixture is before local midnight');
  assert.equal(evidence.loMs, calendarLo - OVERNIGHT_LOOKBACK_MS);
  assert.equal(evidence.manifestRows.length, 1);
  assert.ok(evidence.samples.length >= 1);
});
