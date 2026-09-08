/** WHOOP strap subseconds are Q15: value / 32768 seconds. One helper for every path. */
export const SUBSEC_TICKS_PER_SECOND = 32768;

export function strapTimeMs(seconds, subseconds = 0) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return null;
  const q = Number(subseconds);
  const frac = Number.isFinite(q) && q >= 0 && q < SUBSEC_TICKS_PER_SECOND
    ? q / SUBSEC_TICKS_PER_SECOND
    : 0;
  const base = s > 1e12 ? s : s * 1000;
  return s > 1e12 ? base : (s + frac) * 1000;
}
