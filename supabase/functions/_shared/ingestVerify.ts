// Slim ingest-verify report: push receipts, manifest statuses, B2 presence, projection rows.
// Deliberately omits diagnoseDay / replay accounting / persistSidecars (Node-only engine deps).

import type { SupabaseRest } from './rest.ts';
import type { S3Store } from './s3.ts';
import { isUuid } from './keys.ts';

const PROJECTION_TABLES = [
  { table: 'daily_metrics', dayColumn: 'day' },
  { table: 'sessions', dayColumn: null },
  { table: 'noop_journal_entries', dayColumn: 'day' },
] as const;

export type IngestVerifyStage =
  | 'push_receipt'
  | 'manifest_ready'
  | 'b2_object'
  | 'projection_row';

export async function buildIngestVerifyReport({
  rest,
  objectStore,
  userId,
  day,
}: {
  rest: SupabaseRest;
  objectStore: Pick<S3Store, 'head'> | null;
  userId: string;
  day: string;
}) {
  if (!isUuid(userId)) throw Object.assign(new Error('user required'), { code: 'unauthorized' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw Object.assign(new Error('invalid day'), { code: 'invalid_day' });
  }

  const [walRows, ackRows, manifestRows, dailyRows] = await Promise.all([
    rest.select(
      'noop_push_wal',
      `user_id=eq.${userId}&select=batch_id,stream,device_id,record_count,body_sha256,received_at&order=received_at.desc&limit=200`,
    ).catch(() => []),
    rest.select(
      'noop_push_acks',
      `user_id=eq.${userId}&select=batch_id,body_sha256,saved_at&order=saved_at.desc&limit=200`,
    ).catch(() => []),
    rest.select(
      'object_manifests',
      `user_id=eq.${userId}&period_day=eq.${day}&select=id,object_key,status,object_kind,compressed_bytes,sha256,created_at,updated_at&order=created_at.asc`,
    ).catch(() => []),
    rest.select(
      'daily_metrics',
      `user_id=eq.${userId}&day=eq.${day}&select=day,computed_at,algorithm_version,provenance&limit=1`,
    ).catch(() => []),
  ]);

  const manifests = (manifestRows as any[]).map((m) => ({
    id: m.id,
    object_key: m.object_key,
    status: m.status,
    object_kind: m.object_kind,
    compressed_bytes: m.compressed_bytes ?? null,
    sha256: m.sha256 ?? null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }));

  const b2Presence: Record<string, { exists: boolean; contentLength: number | null }> = {};
  if (objectStore) {
    for (const m of manifests) {
      if (!m.object_key) continue;
      try {
        const head = await objectStore.head(m.object_key);
        b2Presence[m.object_key] = {
          exists: Boolean(head?.exists),
          contentLength: head?.contentLength ?? null,
        };
      } catch {
        b2Presence[m.object_key] = { exists: false, contentLength: null };
      }
    }
  }

  const manifestStatuses = manifests.reduce<Record<string, number>>((acc, m) => {
    const s = String(m.status || 'unknown');
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const projections: Record<string, { present: boolean; count: number }> = {};
  for (const { table, dayColumn } of PROJECTION_TABLES) {
    try {
      const query = dayColumn
        ? `user_id=eq.${userId}&${dayColumn}=eq.${day}&select=${dayColumn}&limit=5`
        : `user_id=eq.${userId}&select=id&limit=5`;
      const rows = await rest.select(table, query);
      const count = Array.isArray(rows) ? rows.length : 0;
      projections[table] = { present: count > 0, count };
    } catch {
      projections[table] = { present: false, count: 0 };
    }
  }

  const pushReceipts = {
    wal_batches: (walRows as any[]).length,
    ack_batches: (ackRows as any[]).length,
    newest_wal_at: (walRows as any[])[0]?.received_at ?? null,
    newest_ack_at: (ackRows as any[])[0]?.saved_at ?? null,
    unacked_estimate: Math.max(0, (walRows as any[]).length - (ackRows as any[]).length),
  };

  const firstIncompleteStage = ((): IngestVerifyStage | null => {
    if (pushReceipts.ack_batches === 0 && pushReceipts.wal_batches === 0) return 'push_receipt';
    const pendingManifest = manifests.find((m) => !['ready', 'verified', 'deleted'].includes(String(m.status)));
    if (pendingManifest) return 'manifest_ready';
    const missingB2 = manifests.some((m) => {
      const hit = b2Presence[m.object_key];
      return m.object_key && (!hit || !hit.exists);
    });
    if (missingB2) return 'b2_object';
    if (!projections.daily_metrics?.present) return 'projection_row';
    return null;
  })();

  return {
    user_id: userId,
    day,
    push_receipts: pushReceipts,
    manifest_statuses: manifestStatuses,
    manifests,
    b2_presence: b2Presence,
    projections,
    daily_metrics_row: (dailyRows as any[])[0] ?? null,
    first_incomplete_stage: firstIncompleteStage,
    complete: firstIncompleteStage === null,
  };
}
