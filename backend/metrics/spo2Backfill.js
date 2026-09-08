import {
  reportsByDeviceFirmwareNight,
  annotateSpo2Identity,
  inferSleepEpisodes,
  physiologicalNightKey,
  upsertObservations,
} from '../protocol/spo2.js';
import {
  extrasFromSpo2Summary,
  spo2CandidateSeriesFromObservations,
  spo2CandidateInputHash,
  shouldPersistSpo2Candidate,
} from './spo2.js';
import { dailyToWhoopDay } from './engine.js';

/**
 * Idempotent extras-only backfill. Does not mutate B2. Never writes spo2_pct.
 * Rerun patches the same extras blob; daily_metrics stays one row per user/day.
 */
export async function applySpo2CandidateBackfill({
  observations,
  db,
  timeZone = 'UTC',
  sleepSessions = null,
  userId = null,
} = {}) {
  const stamped = (observations || []).map((o) => annotateSpo2Identity(o, {
    userId: o.user_id || userId,
  }));
  const episodes = inferSleepEpisodes(stamped);
  const nights = reportsByDeviceFirmwareNight(stamped, {
    timeZone,
    sleepSessions,
    by: 'user',
  });
  const results = [];
  for (const night of nights) {
    const uid = night.user_id || userId;
    if (!uid || !night.night) continue;
    if (!shouldPersistSpo2Candidate(night)) continue;
    const nightObs = stamped.filter((o) => (
      (o.user_id || userId) === uid
      && physiologicalNightKey(o, { timeZone, sleepSessions, episodes }) === night.night
    ));
    const extras = extrasFromSpo2Summary({
      ...night,
      input_hash: spo2CandidateInputHash(nightObs),
    }, spo2CandidateSeriesFromObservations(nightObs));
    if (typeof db?.patchDailyExtras !== 'function') {
      throw new Error('engine_patch_daily_extras required');
    }
    await db.patchDailyExtras(uid, night.night, extras);
    results.push({
      user_id: uid,
      day: night.night,
      input_hash: extras.spo2_candidate.input_hash,
      spo2_candidate_pct: extras.spo2_candidate.spo2_candidate_pct,
      spo2_pct: extras.spo2_candidate.spo2_pct,
      candidate_count: night.candidate_count,
      valid_windows: night.valid_windows,
    });
  }
  return { days: results, count: results.length };
}

export function whoopDayFromSpo2Extras(extras, { spo2_pct = null } = {}) {
  return dailyToWhoopDay({ spo2_pct, extras });
}

export function mergeObservationPasses(first, second) {
  return upsertObservations(first, second);
}
