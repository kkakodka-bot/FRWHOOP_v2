import { APPEND_STREAM_PROJECTIONS } from '../ingest/pushRegistry.js';

/**
 * How long a per-sample projection stays in Postgres.
 *
 * The `noop_*` append tables are a READ CACHE for the UI, not the archive. B2 holds every sample
 * permanently; these rows exist so a screen can render a recent range without fetching objects. That
 * distinction has to be enforced rather than documented: `rrInterval` alone lands on the order of
 * 100k rows per patient-day, so an unswept cache reaches the billions across a cohort-year and takes
 * the database down long before it takes the bucket down.
 *
 * Sweeping is safe precisely because it is a cache — the same rows are reconstructible by replaying
 * the archived objects, which is why the sweep never touches `object_manifests` or
 * `noop_signal_windows` (the index that makes replay findable) or `noop_event_labels` (never
 * derivable from signal at all).
 */
export const PROJECTION_WINDOW_DAYS = 14;

/** Tables the sweep may delete from, derived from the projection registry so a new stream is covered. */
export function projectionWindowTables() {
  return Object.entries(APPEND_STREAM_PROJECTIONS)
    .map(([stream, projection]) => ({
      stream,
      table: projection.table,
      tsKey: projection.tsKey,
    }))
    .filter((entry) => entry.table && entry.tsKey);
}

/**
 * Streams that project per-sample rows but declare no timestamp column to sweep on. A stream here is
 * unbounded growth in Postgres, so `projectionWindowCoverageGaps` is asserted empty by the tests
 * rather than left for someone to notice from a disk graph.
 */
export function projectionWindowCoverageGaps() {
  return Object.entries(APPEND_STREAM_PROJECTIONS)
    .filter(([, projection]) => !projection.table || !projection.tsKey)
    .map(([stream]) => stream);
}

/** Cutoff in unix seconds. Rows strictly older than this are cache, not data, and may be dropped. */
export function projectionCutoffTs(now = new Date(), days = PROJECTION_WINDOW_DAYS) {
  const ms = (now instanceof Date ? now : new Date(now)).getTime();
  return Math.floor(ms / 1000) - days * 86400;
}

export function projectionWindowPlan({ now = new Date(), days = PROJECTION_WINDOW_DAYS } = {}) {
  const cutoffTs = projectionCutoffTs(now, days);
  return projectionWindowTables().map((entry) => ({ ...entry, cutoffTs }));
}

/**
 * Drops per-sample projection rows older than the window. Idempotent, and safe to run while ingest
 * is live: a re-push of an old batch re-archives to B2 and may re-insert cache rows that the next
 * sweep removes again.
 */
export async function sweepProjectionWindow({
  rest,
  now = () => new Date(),
  days = PROJECTION_WINDOW_DAYS,
} = {}) {
  if (!rest?.configured) return { swept: [], skipped: 'rest_not_configured' };
  const plan = projectionWindowPlan({ now: now(), days });
  const swept = [];
  for (const entry of plan) {
    try {
      await rest.delete(entry.table, `${entry.tsKey}=lt.${entry.cutoffTs}`);
      swept.push({ ...entry, ok: true });
    } catch (err) {
      swept.push({ ...entry, ok: false, error: String(err?.message || err) });
    }
  }
  return { swept };
}
