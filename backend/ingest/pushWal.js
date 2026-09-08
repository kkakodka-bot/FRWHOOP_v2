import { createPushWalStore, getMemoryPushWalStore } from './pushWalStore.js';

/**
 * Per-user push WAL + batch acknowledgement facade.
 * Production uses a shared Postgres store; tests pass `dir` to share an in-memory namespace.
 */
export function createPushWal({ userId, store, dir }) {
  const backend = store || (dir ? getMemoryPushWalStore(dir) : null);
  if (!backend) {
    throw new Error('push_wal_store_required');
  }

  const sync = Boolean(dir) && !store;

  return {
    recoverWal() {
      return backend.recoverWal(userId);
    },
    appendWal(entry) {
      const out = backend.appendWal(userId, entry);
      return sync ? undefined : out;
    },
    trimWal(batchId) {
      const out = backend.trimWal(userId, batchId);
      return sync ? undefined : out;
    },
    getAck(batchId) {
      return backend.getAck(userId, batchId);
    },
    saveAck(batchId, ack, bodySha256) {
      const out = backend.saveAck(userId, batchId, ack, bodySha256);
      return sync ? undefined : out;
    },
  };
}

export { createPushWalStore, getMemoryPushWalStore };
