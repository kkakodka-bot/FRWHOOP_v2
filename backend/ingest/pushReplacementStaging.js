import { PushProtocolError } from './pushRegistry.js';

function scopeKey(userId, header) {
  return `${userId}|${header.sourceId}|${header.deviceId}|${header.stream}`;
}

function windowIdentity(window) {
  return JSON.stringify({
    replacementId: window.replacementId,
    selector: window.selector,
    startInclusive: window.startInclusive,
    endExclusive: window.endExclusive,
    parts: window.parts,
  });
}

function validateWindow(header) {
  const window = header?.window;
  if (!window || typeof window !== 'object') {
    throw new PushProtocolError('missing_window', 422);
  }
  const { replacementId, selector, startInclusive, endExclusive, part, parts } = window;
  if (!replacementId || !selector || startInclusive == null || endExclusive == null) {
    throw new PushProtocolError('invalid_window', 422);
  }
  if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 1 || parts < 1 || part > parts) {
    throw new PushProtocolError('invalid_window_part', 422);
  }
  if (header.startCursor != null || header.endCursor != null) {
    throw new PushProtocolError('invalid_replace_cursor', 422);
  }
  return window;
}

function createMemoryReplacementStore() {
  const generations = new Map();

  return {
    getGeneration(scope) {
      return generations.get(scope) || null;
    },
    putGeneration(scope, generation) {
      generations.set(scope, generation);
    },
    deleteGeneration(scope) {
      generations.delete(scope);
    },
  };
}

const memoryStores = new Map();

export function getMemoryReplacementStore(namespace = 'default') {
  if (!memoryStores.has(namespace)) {
    memoryStores.set(namespace, createMemoryReplacementStore());
  }
  return memoryStores.get(namespace);
}

/**
 * Durably stage replace_window parts; apply only when every part is present.
 * A completing part is not acknowledged until apply succeeds (caller responsibility).
 */
export function createPushReplacementStaging({ store } = {}) {
  const backend = store || createMemoryReplacementStore();

  return {
    stagePart({ userId, header, records, bodySha256 }) {
      const window = validateWindow(header);
      const scope = scopeKey(userId, header);
      const identity = windowIdentity(window);
      let generation = backend.getGeneration(scope);

      if (generation && generation.replacementId !== window.replacementId) {
        if (!generation.complete) {
          backend.deleteGeneration(scope);
          generation = null;
        } else {
          throw new PushProtocolError('replacement_superseded', 409);
        }
      }

      if (!generation) {
        generation = {
          replacementId: window.replacementId,
          windowIdentity: identity,
          parts: window.parts,
          receivedParts: new Map(),
          complete: false,
        };
        backend.putGeneration(scope, generation);
      }

      if (generation.windowIdentity !== identity && generation.replacementId === window.replacementId) {
        throw new PushProtocolError('replacement_window_conflict', 409);
      }

      if (generation.replacementId !== window.replacementId) {
        throw new PushProtocolError('replacement_superseded', 409);
      }

      const prior = generation.receivedParts.get(window.part);
      if (prior) {
        if (prior.batchId !== header.batchId) {
          throw new PushProtocolError('replacement_part_conflict', 409);
        }
        if (prior.bodySha256 !== bodySha256) {
          throw new PushProtocolError('batch_id_conflict', 409);
        }
        return {
          complete: generation.complete,
          isCompletingPart: window.part === window.parts && !generation.complete,
          records: collectRecords(generation),
          window,
          header,
          alreadyStaged: true,
        };
      }

      generation.receivedParts.set(window.part, {
        batchId: header.batchId,
        bodySha256,
        records,
      });

      const complete = generation.receivedParts.size === window.parts;
      if (complete) {
        generation.complete = true;
        backend.putGeneration(scope, generation);
      }

      return {
        complete,
        isCompletingPart: complete,
        records: complete ? collectRecords(generation) : [],
        window,
        header,
        alreadyStaged: false,
      };
    },

    clearGeneration({ userId, header }) {
      backend.deleteGeneration(scopeKey(userId, header));
    },
  };
}

function collectRecords(generation) {
  const parts = [...generation.receivedParts.keys()].sort((a, b) => a - b);
  const records = [];
  for (const part of parts) {
    records.push(...(generation.receivedParts.get(part)?.records || []));
  }
  return records;
}
