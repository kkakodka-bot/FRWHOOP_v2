/** Tier 2 ingest policy: decouple archive flush from scoring. */

export function ingestScoreAsyncEnabled() {
  const v = String(process.env.FRWHOOP_INGEST_SCORE_ASYNC || 'on').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  return true;
}

export function scoreDebounceMs() {
  const n = Number(process.env.FRWHOOP_SCORE_DEBOUNCE_MS);
  if (Number.isFinite(n) && n >= 0) return n;
  return 2000;
}
