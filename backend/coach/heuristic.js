export function heuristicCoachReply(message, metrics, evidence) {
  const m = metrics || {};
  const q = String(message || '').toLowerCase();
  const strain = m.strain ?? m.dayStrain ?? evidence?.day?.strain;
  const recovery = m.recovery ?? evidence?.day?.recovery;
  const target = m.target ?? evidence?.day?.suggestedStrain;
  const avgs = evidence?.averages || evidence?.recoveryWeek?.averages || evidence?.sleepWeek?.averages;

  if (q.includes('hrv') && (avgs?.hrv || evidence?.day?.hrv)) {
    const hrv = avgs?.hrv ?? evidence.day.hrv;
    return `HRV is ${hrv} ms RMSSD in the window I pulled. Compare that to nearby days rather than chasing a single night. Sleep debt and high strain usually drag it down.`;
  }
  if (q.includes('sleep')) {
    const perf = avgs?.sleepPerformance ?? evidence?.day?.sleepPerformance;
    const debt = evidence?.day?.sleepDebtMin;
    return perf != null
      ? `Sleep performance is ${perf}%${debt != null ? ` with ${debt} min of debt` : ''}. Protect bedtime and keep the next strain target honest so recovery can rebound.`
      : `Sleep need is driving tonight's plan. Hit the suggested bedtime from Sleep Coach so recovery can rebound.`;
  }
  if (/\brecover/.test(q) && recovery != null) {
    return recovery >= 67
      ? `Recovery is ${recovery}% (green). Suggested strain is ${target ?? 'in range'} — you can train, but keep the day honest.`
      : `Recovery is ${recovery}%. Treat this as a cap day${target != null ? ` (target ${target})` : ''} and protect sleep.`;
  }
  if (q.includes('feel') || q.includes('sore') || q.includes('tired')) {
    return recovery >= 67
      ? `Thanks for the check-in. Recovery is ${recovery}% so the body is ready — keep strain near ${target} and note how you feel after the next session.`
      : `Thanks for the check-in. Recovery is ${recovery ?? 'low'} so today is a cap day (target ${target}). If you're sore, swap intensity for Zone 2 or mobility and protect bedtime.`;
  }
  if (strain != null && target != null) {
    const left = Math.max(0, Math.round((target - strain) * 10) / 10);
    return left > 0
      ? `Day Strain is ${strain} vs a ${target} target (${left} still in range). A focused session gets you there without overreaching.`
      : `Day Strain is ${strain}, which already meets today's ${target} target. Shift to recovery: food, fluids, and the Sleep Coach window.`;
  }
  return `I have your latest WHOOP numbers. Ask about strain, sleep, recovery, or how you feel and I'll ground the answer in today's metrics.`;
}
