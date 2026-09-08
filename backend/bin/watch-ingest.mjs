#!/usr/bin/env node
/**
 * Ingest liveness probe. Exit 0 only when GET /health is 200 + status=healthy.
 * Use from launchd/cron or `npm run health`. The API itself is the ingest path.
 */
const base = String(process.env.FRWHOOP_INGEST_URL || process.env.VITE_API_URL || `http://127.0.0.1:${process.env.PORT || 8080}`)
  .replace(/\/$/, '');
const url = `${base}/health`;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'healthy') {
    console.error(`ingest_unhealthy ${res.status} ${url} ${body.status || ''}`);
    process.exit(1);
  }
  console.log(`ingest_healthy ${url} uptime=${body.uptime ?? '?'} ingest=${body.ingest === true}`);
} catch (err) {
  console.error(`ingest_down ${url} ${err?.message || err}`);
  process.exit(1);
}
