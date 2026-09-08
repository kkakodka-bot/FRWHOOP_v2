import { PushProtocolError } from './pushRegistry.js';

export function defaultQuotaConfig() {
  return {
    maxBatches: Number(process.env.FRWHOOP_PUSH_QUOTA_MAX_BATCHES || 10_000),
    maxBytes: Number(process.env.FRWHOOP_PUSH_QUOTA_MAX_BYTES || 512 * 1024 * 1024),
    windowSec: Number(process.env.FRWHOOP_PUSH_QUOTA_WINDOW_SEC || 3600),
  };
}

export function createPushIngestQuota({ store, config = defaultQuotaConfig() } = {}) {
  if (!store?.consumeQuota) {
    return {
      async reserve() {},
    };
  }
  return {
    async reserve(userId, bytes) {
      try {
        await store.consumeQuota(userId, bytes, config);
      } catch (err) {
        if (err.message === 'ingest_quota_exceeded') {
          throw new PushProtocolError('ingest_quota_exceeded', 429);
        }
        throw err;
      }
    },
  };
}
