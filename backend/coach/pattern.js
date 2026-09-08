
// coach/pattern.js — deterministic correlational analysis for longitudinal coaching
// questions. The model reasons; the backend computes. Runs on the day index.
import { sliceDays } from './days.js';

export const PATTERN_HINTS = /\b(usually|normally|often|after (?:hard|heavy|leg)|after i|when i|tend(?:s)? to|correlat|pattern|relation|do i sleep better|perform better|what happens|what usually)\b/i;

export function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function mean(arr) {
  const vals = arr.filter((v) => v != null && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function heavySessions(rows, threshold = 13) {
  return rows.filter((r) => (r.workouts || []).some((w) => Number(w.strain) >= threshold));
}

function sessionStartHour(workout) {
  const s = workout && (workout.start || workout.startTime || '');
  const m = /(?:^|T|\s)(\d{1,2}):/.exec(s);
  return m ? Number(m[1]) : null;
}

export function analyzePattern(index, { lastDays = 90 } = {}) {
  const rows = sliceDays(index, { fromDay: null, toDay: index.lastDay, limit: lastDays, before: index.lastDay }).reverse();
  const out = {};

  // 1. HRV after heavy sessions (leg/hard days) vs otherwise
  const heavy = heavySessions(rows, 13);
  const heavyDays = new Set(heavy.map((r) => r.day));
  const nextDayAfterHeavy = rows.map((r, i) => ({ r, next: rows[i + 1] }))
    .filter((x) => x.next && heavyDays.has(x.r.day))
    .map((x) => x.next.hrv);
  const nonHeavyNext = rows.map((r, i) => ({ r, next: rows[i + 1] }))
    .filter((x) => x.next && !heavyDays.has(x.r.day))
    .map((x) => x.next.hrv);
  const mH = mean(nextDayAfterHeavy); const mN = mean(nonHeavyNext);
  if (heaviesExist(heavyDays.size) || (mH != null && mN != null)) {
    out.hrvAfterHard = {
      nHard: nextDayAfterHeavy.length,
      avgAfterHard: mH != null ? round1(mH) : null,
      avgOther: mN != null ? round1(mN) : null,
      deltaPct: mH != null && mN != null ? round1(((mH - mN) / mN) * 100) : null,
      sample: heavy.slice(0, 6).map((r) => ({ day: r.day, strain: Math.max(...(r.workouts || []).map((w) => w.strain)) })),
    };
  }

  // 2. Sleep performance on nights following hard sessions
  const sleepAfterHard = rows.map((r, i) => ({ r, next: rows[i + 1] }))
    .filter((x) => x.next && heavyDays.has(x.r.day))
    .map((x) => x.next.sleepPerformance);
  const sleepOther = rows.map((r, i) => ({ r, next: rows[i + 1] }))
    .filter((x) => x.next && !heavyDays.has(x.r.day))
    .map((x) => x.next.sleepPerformance);
  const sH = mean(sleepAfterHard); const sO = mean(sleepOther);
  out.sleepAfterHard = { n: sleepAfterHard.length, avgAfterHard: sH != null ? round1(sH) : null, avgOther: sO != null ? round1(sO) : null };

  // 3. Rest-day vs training-day sleep (nights after a day with no workouts)
  const restDays = rows.filter((r) => !(r.workouts || []).length);
  const restSet = new Set(restDays.map((r) => r.day));
  const sleepAfterRest = rows.map((r, i) => ({ r, next: rows[i + 1] }))
    .filter((x) => x.next && restSet.has(x.r.day)).map((x) => x.next.sleepPerformance);
  const sleepAfterTrain = rows.map((r, i) => ({ r, next: rows[i + 1] }))
    .filter((x) => x.next && !restSet.has(x.r.day)).map((x) => x.next.sleepPerformance);
  const rR = mean(sleepAfterRest); const rT = mean(sleepAfterTrain);
  out.sleepOnRestDays = { nRest: sleepAfterRest.length, avgAfterRest: rR != null ? round1(rR) : null, avgAfterTrain: rT != null ? round1(rT) : null };

  // 4. Evening vs morning session intensity (strain per hour)
  const sessions = rows.flatMap((r) => (r.workouts || []).map((w) => ({ ...w, day: r.day })));
  const byHour = {};
  for (const s of sessions) {
    const h = sessionStartHour(s);
    if (h == null) continue;
    const bucket = h >= 17 || h < 5 ? 'evening' : 'morning';
    byHour[bucket] = byHour[bucket] || { strain: [], hours: [] };
    byHour[bucket].strain.push(s.strain || 0);
    byHour[bucket].hours.push(s.durationMin || 0);
  }
  if (byHour.morning && byHour.evening) {
    const mS = (b) => mean(b.strain);
    out.timeOfDay = {
      morning: byHour.morning.strain.length ? round1(mS(byHour.morning)) : null,
      evening: byHour.evening.strain.length ? round1(mS(byHour.evening)) : null,
      morningSessions: byHour.morning.strain.length,
      eveningSessions: byHour.evening.strain.length,
    };
  }

  // 5. HRV crash contexts: days where hrv drops >= 12 ms vs prior day
  const crashes = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]; const cur = rows[i];
    if (cur.hrv != null && prev.hrv != null && prev.hrv - cur.hrv >= 12) {
      crashes.push({
        day: cur.day,
        hrvDrop: round1(prev.hrv - cur.hrv),
        priorDayStrain: prev.strain,
        priorWorkouts: (prev.workouts || []).map((w) => `${w.name}(${w.strain})`).slice(0, 3),
        sleepPerf: cur.sleepPerformance,
      });
    }
  }
  if (crashes.length) out.hrvCrashes = { count: crashes.length, samples: crashes.slice(-4) };

  return out;
}

function heaviesExist(n) { return n > 0; }

/** Compact prompt block of the pattern summary when a correlational question is asked. */
export function patternBlock(index, lastDays = 90) {
  const p = analyzePattern(index, { lastDays });
  const bits = [];
  if (p.hrvAfterHard) bits.push(`HRV after hard days (strain>=13): avg ${p.hrvAfterHard.avgAfterHard ?? 'n/a'} ms vs ${p.hrvAfterHard.avgOther ?? 'n/a'} on other days (${p.hrvAfterHard.nHard} hard days, delta ${p.hrvAfterHard.deltaPct ?? 'n/a'}%).`);
  if (p.sleepAfterHard) bits.push(`Sleep performance after hard days: ${p.sleepAfterHard.avgAfterHard ?? 'n/a'}% vs ${p.sleepAfterHard.avgOther ?? 'n/a'}% (n=${p.sleepAfterHard.n}).`);
  if (p.sleepOnRestDays) bits.push(`Sleep performance on nights after rest days: ${p.sleepOnRestDays.avgAfterRest ?? 'n/a'}% vs ${p.sleepOnRestDays.avgAfterTrain ?? 'n/a'}% after training days (nRest=${p.sleepOnRestDays.nRest}).`);
  if (p.timeOfDay) bits.push(`Sessions: morning avg strain ${p.timeOfDay.morning ?? 'n/a'} (${p.timeOfDay.morningSessions}), evening avg strain ${p.timeOfDay.evening ?? 'n/a'} (${p.timeOfDay.eveningSessions}).`);
  if (p.hrvCrashes) bits.push(`HRV crashes (drop>=12ms): ${p.hrvCrashes.count} in window; last samples ${JSON.stringify(p.hrvCrashes.samples)}`);
  if (!bits.length) return '';
  return `PRE-COMPUTED PATTERNS (from your data, last ${lastDays}d):\n${bits.join('\n')}`;
}
