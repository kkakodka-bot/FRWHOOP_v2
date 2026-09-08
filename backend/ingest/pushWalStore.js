/** Shared Postgres-backed (or in-memory test) store for NOOP push WAL + acks. */

const memoryNamespaces = new Map();

function walRowToEntry(row) {
  return {
    batchId: row.batch_id,
    stream: row.stream,
    deviceId: row.device_id,
    sourceId: row.source_id,
    recordCount: row.record_count,
    bodySha256: row.body_sha256,
    receivedAt: row.received_at,
  };
}

function createMemoryPushWalBackend() {
  const wal = new Map();
  const acks = new Map();
  const quota = new Map();

  function walKey(userId, batchId) {
    return `${userId}\0${batchId}`;
  }

  return {
    appendWal(userId, entry) {
      const key = walKey(userId, entry.batchId);
      if (!wal.has(key)) wal.set(key, { ...entry });
    },
    trimWal(userId, batchId) {
      wal.delete(walKey(userId, batchId));
    },
    recoverWal(userId) {
      const lines = [];
      for (const [key, row] of wal.entries()) {
        if (!key.startsWith(`${userId}\0`)) continue;
        lines.push({ ...row });
      }
      return { lines, truncated: 0, corrupt: 0 };
    },
    getAck(userId, batchId) {
      const row = acks.get(walKey(userId, batchId));
      if (!row) return null;
      return { ack: row.ack, bodySha256: row.bodySha256, savedAt: row.savedAt };
    },
    saveAck(userId, batchId, ack, bodySha256) {
      const key = walKey(userId, batchId);
      const prior = acks.get(key);
      if (prior?.bodySha256 && prior.bodySha256 !== bodySha256) {
        throw new Error('batch_id_conflict');
      }
      acks.set(key, {
        ack,
        bodySha256,
        savedAt: new Date().toISOString(),
      });
    },
    consumeQuota(userId, bytes, { maxBatches, maxBytes, windowSec }) {
      if (!maxBatches || !maxBytes || !windowSec) return;
      const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
      const quotaKey = `${userId}\0${windowStart}`;
      const prior = quota.get(quotaKey) || { batchCount: 0, byteCount: 0 };
      const next = {
        batchCount: prior.batchCount + 1,
        byteCount: prior.byteCount + bytes,
      };
      if (next.batchCount > maxBatches || next.byteCount > maxBytes) {
        throw new Error('ingest_quota_exceeded');
      }
      quota.set(quotaKey, next);
    },
  };
}

export function getMemoryPushWalStore(namespace) {
  if (!memoryNamespaces.has(namespace)) {
    memoryNamespaces.set(namespace, createMemoryPushWalBackend());
  }
  return memoryNamespaces.get(namespace);
}

export function createPushWalStore({ rest, quota = {} } = {}) {
  if (!rest?.configured) {
    return null;
  }

  const maxBatchesDefault = Number(process.env.FRWHOOP_PUSH_QUOTA_MAX_BATCHES || 10_000);
  const maxBytesDefault = Number(process.env.FRWHOOP_PUSH_QUOTA_MAX_BYTES || 512 * 1024 * 1024);
  const windowSecDefault = Number(process.env.FRWHOOP_PUSH_QUOTA_WINDOW_SEC || 3600);
  const {
    maxBatches = maxBatchesDefault,
    maxBytes = maxBytesDefault,
    windowSec = windowSecDefault,
  } = quota;

  return {
    async appendWal(userId, entry) {
      await rest.upsert('noop_push_wal', {
        user_id: userId,
        batch_id: entry.batchId,
        source_id: entry.sourceId || null,
        stream: entry.stream,
        device_id: String(entry.deviceId || ''),
        record_count: entry.recordCount ?? 0,
        body_sha256: entry.bodySha256,
        received_at: entry.receivedAt,
      }, { onConflict: 'user_id,batch_id', prefer: 'resolution=ignore-duplicates' });
    },
    async trimWal(userId, batchId) {
      await rest.delete('noop_push_wal', `user_id=eq.${userId}&batch_id=eq.${batchId}`);
    },
    async recoverWal(userId) {
      const rows = await rest.select(
        'noop_push_wal',
        `user_id=eq.${userId}&select=batch_id,stream,device_id,source_id,record_count,body_sha256,received_at&order=received_at.asc`,
      );
      return {
        lines: rows.map(walRowToEntry),
        truncated: 0,
        corrupt: 0,
      };
    },
    async getAck(userId, batchId) {
      const rows = await rest.select(
        'noop_push_acks',
        `user_id=eq.${userId}&batch_id=eq.${batchId}&select=body_sha256,ack,saved_at`,
      );
      const row = rows[0];
      if (!row) return null;
      return {
        bodySha256: row.body_sha256,
        ack: row.ack,
        savedAt: row.saved_at,
      };
    },
    async saveAck(userId, batchId, ack, bodySha256) {
      try {
        await rest.rpc('noop_push_save_ack', {
          p_user_id: userId,
          p_batch_id: batchId,
          p_body_sha256: bodySha256,
          p_ack: ack,
        });
      } catch (err) {
        if (String(err.message || '').includes('batch_id_conflict')) {
          throw new Error('batch_id_conflict');
        }
        throw err;
      }
    },
    async consumeQuota(userId, bytes, config = {}) {
      const batchLimit = config.maxBatches ?? maxBatches;
      const byteLimit = config.maxBytes ?? maxBytes;
      const window = config.windowSec ?? windowSec;
      try {
        await rest.rpc('noop_push_consume_ingest_quota', {
          p_user_id: userId,
          p_bytes: bytes,
          p_max_batches: batchLimit,
          p_max_bytes: byteLimit,
          p_window_seconds: window,
        });
      } catch (err) {
        if (String(err.message || '').includes('ingest_quota_exceeded')) {
          throw new Error('ingest_quota_exceeded');
        }
        throw err;
      }
    },
    quotaConfig: { maxBatches, maxBytes, windowSec },
  };
}
