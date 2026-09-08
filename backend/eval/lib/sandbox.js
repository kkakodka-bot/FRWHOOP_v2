
// eval/lib/sandbox.js — deterministic synthetic users + day-index builders for evals.
// The real app uses data/coach-days.json; sandboxes layer engineered patterns on top.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDayIndex(days) {
  const rows = days.map((row) => ({ workouts: row.workouts || [], ...row }));
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  return {
    days: sorted,
    byDay: new Map(sorted.map((row) => [row.day, row])),
    firstDay: sorted[0]?.day || null,
    lastDay: sorted[sorted.length - 1]?.day || null,
  };
}

export function addIsoDay(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Generate a full 200-day series that encodes patterns.
// opts:
//   seed    - PRNG seed
//   baseDay - ISO start (default 2024-11-16)
//   runs    - workout patterns: [{days:[0..6], name, strain, hrs}]
//   evenings - if set, evening workouts encode better next-day recovery (pattern questions)
//   kneeInjuryAfter - {runName, dayIndex} inject an injury note into memory fixture instead
//   sleepBadAfterRun - hard runs hurt next-day sleep/hrv
export function generateUser({
  seed = 1,
  baseDay = '2024-11-18',
  days = 200,
  runs = [],
  hrvDropAfterHardLeg = false,
  betterAfterEvening = false,
  morningRuns = false,
  legDays = [],
} = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun
  let pendingHardEffect = 0;
  for (let i = 0; i < days; i += 1) {
    const day = addIsoDay(baseDay, i);
    const wd = weekday(day);
    // base recovery: cyclic 30..90
    const cycle = 55 + 22 * Math.sin(i / 9) + 12 * Math.sin(i / 23) + (rnd() - 0.5) * 10;
    let recovery = Math.round(Math.max(15, Math.min(97, cycle)));
    // base HRV
    let hrv = Math.round(Math.max(24, Math.min(120, 58 + 14 * Math.sin(i / 11) + (rnd() - 0.5) * 12)));
    let sleepPerf = Math.round(Math.max(45, Math.min(96, 74 + 9 * Math.sin(i / 13) + (rnd() - 0.5) * 8)));
    const workouts = [];
    let strain = 0;

    // leg day (heavy squat/deadlift/leg press) schedule
    const isLeg = Array.isArray(legDays) && legDays.includes(wd);
    let hardLeg = false;
    for (const r of runs) {
      if (r.days.includes(wd)) {
        const name = r.name;
        const s = r.strain ?? (r.hours ? strainForHours(r.hours) : 10);
        const evening = betterAfterEvening && !morningRuns;
        const start = r.hours
          ? `${day} ${evening ? '18:30:00' : '07:00:00'}`
          : `${day} ${evening ? '18:45:00' : '07:15:00'}`;
        workouts.push({ name, durationMin: r.durationMin ?? 50, strain: s, avgHr: r.avgHr ?? 130, start });
        strain += s;
        if (/leg|squat|deadlift|leg press/i.test(name)) hardLeg = true;
      }
    }
    // apply YESTERDAY's hard-session effect to today's hrv + recovery (exactly one day)
    const todayEffect = pendingHardEffect;
    pendingHardEffect = 0;
    hrv = Math.max(18, hrv - todayEffect);
    recovery = Math.max(10, recovery - (todayEffect > 0 ? 10 : 0));
    // if today was a hard session, today's night will hurt tomorrow
    if ((hardLeg || strain >= 13) && hrvDropAfterHardLeg) pendingHardEffect = Math.round(18 + rnd() * 10);

    // sleep owed varies with recovery
    const need = 520;
    const asleep = Math.round(Math.max(240, Math.min(520, 380 + recovery * 1.1 + (rnd() - 0.5) * 60 + (todayEffect>0 ? -50 : 0))));
    const deep = Math.round(asleep * (0.18 + rnd() * 0.08));
    const rem = Math.round(asleep * (0.19 + rnd() * 0.08));
    const light = Math.max(0, asleep - deep - rem);
    const debt = Math.max(0, need - asleep);
    const rhr = Math.round(Math.max(42, Math.min(76, 58 - recovery * 0.08 + (rnd() - 0.5) * 4)));

    out.push({
      day,
      recovery: Math.max(0, Math.round(recovery)),
      strain: Math.max(0, Math.round(strain * 10) / 10),
      hrv,
      rhr,
      resp: Math.round((13.5 - recovery * 0.012 + (rnd() - 0.5) * 0.8) * 10) / 10,
      spo2: Math.round((96 - rnd() * 2) * 100) / 100,
      skinTemp: Math.round((33.8 + rnd() * 0.6) * 10) / 10,
      calories: workouts.length ? 250 + Math.round(rnd() * 300) : 0,
      avgHr: workouts.length ? 120 + Math.round(rnd() * 30) : 0,
      maxHr: workouts.length ? 150 + Math.round(rnd() * 30) : 0,
      sleepPerformance: Math.max(0, sleepPerf - (todayEffect > 0 ? 12 : 0)),
      sleepEfficiency: Math.round((asleep / (asleep + 30 + Math.round(rnd() * 30))) * 100),
      sleepConsistency: Math.round(60 + rnd() * 35),
      asleepMin: asleep,
      inBedMin: asleep + 40,
      lightMin: light,
      deepMin: deep,
      remMin: rem,
      awakeMin: inBedMinFor(asleep) + 12,
      sleepNeedMin: need,
      sleepDebtMin: debt,
      sleepOnset: `${day} 23:15:00`,
      wakeOnset: `${day} 07:10:00`,
      nap: false,
      workouts,
    });
  }
  return out;
}

function inBedMinFor(asleep) { return asleep + 40; }

function strainForHours(hours) {
  return Math.round(Math.min(21, 6 + hours * 4) * 10) / 10;
}

export function cloneIndex(index) {
  const days = index.days.map((row) => ({ ...row, workouts: (row.workouts || []).map((w) => ({ ...w })) }));
  return buildDayIndex(days);
}
