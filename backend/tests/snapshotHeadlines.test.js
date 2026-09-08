import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotToWhoopDay, snapshotHeadlines, whoopDayHeadlines, headlinesMatch, snapshotsFromPersistedPayload, whoopDaysFromSnapshots } from '../metrics/snapshot.js';

test('RPC snapshot headlines match /api/days whoop overlay', () => {
  const snap = {
    day: '2026-08-30',
    metrics: {
      steps: 12,
      strain_score: 4.4,
      energy_kcal: 352,
      resting_hr_bpm: 63,
      avg_hr_bpm: 75,
      sleep_total_min: null,
    },
    sleep: [{ persist_state: 'provisional' }],
    chart: [{ avg_hr: 70 }, { avg_hr: 72 }],
    availability: { sleep: { kind: 'provisional' } },
  };
  const whoop = snapshotToWhoopDay(snap);
  const a = snapshotHeadlines(snap);
  const b = whoopDayHeadlines(snap.day, whoop);
  assert.equal(headlinesMatch(a, b), true);
  assert.equal(headlinesMatch({ energy_kcal: 61.99999999999999 }, { energy_kcal: 62 }), true);
  assert.equal(a.persist_states[0], 'provisional');
  assert.equal(a.hr_buckets, 2);
});

test('/api/days whoop overlay is snapshotToWhoopDay of the persisted payload', () => {
  const payload = {
    daily_metrics: [{
      day: '2026-08-30',
      record_class: 'user',
      timezone_name: 'UTC',
      strain_score: 0,
      steps: 12,
      resting_hr_bpm: 63,
      active_kcal: 100,
      basal_kcal: 200,
    }],
    daily_physiology_series: [{
      day: '2026-08-30',
      hr_series: [{ t: '2026-08-30T00:00:00.000Z', avg_hr: 70 }, { t: '2026-08-30T00:05:00.000Z', avg_hr: null }],
      strain_series: [],
    }],
    sleep_details: [],
    sessions: [],
  };
  const snapshots = snapshotsFromPersistedPayload(payload);
  const snap = snapshots['2026-08-30'];
  assert.equal(snap.metrics.strain_score, 0);
  assert.equal(snap.availability.hr.buckets, 1);
  const whoop = whoopDaysFromSnapshots(snapshots)['2026-08-30'];
  assert.deepEqual(whoop.physiological_summary['Day Strain'], snapshotToWhoopDay(snap).physiological_summary['Day Strain']);
  assert.equal(whoop.availability.hr.buckets, snap.availability.hr.buckets);
});

