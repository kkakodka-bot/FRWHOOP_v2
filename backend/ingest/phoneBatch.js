import fs from 'node:fs';
import path from 'node:path';

const MAX_ACKS = 64;

function span(rows) {
  if (!Array.isArray(rows) || !rows.length) return '0';
  let min = Infinity;
  let max = -Infinity;
  let n = 0;
  for (const row of rows) {
    const seq = Number(row?.seq);
    if (!Number.isFinite(seq)) continue;
    n += 1;
    if (seq < min) min = seq;
    if (seq > max) max = seq;
  }
  return n === 0 ? '0' : `${min}-${max}:${n}`;
}

/** Same unacked prefix → same id. Matches iOS LiveUploadPolicy.batchId. */
export function batchIdFromPayload(body = {}) {
  return `v1:live:${span(body.samples)}:frames:${span(body.frames)}:hist:${span(body.historySamples)}`;
}

const EMPTY_BATCH_ID = batchIdFromPayload({});

/**
 * Replay identity is the payload. A client-supplied key is only used when it
 * matches `batchIdFromPayload`; a stolen or conflicting key must not replay
 * a cached ACK. Headerless posts still return '' so empty batches do not
 * collide on EMPTY_BATCH_ID.
 */
export function resolveBatchId(reqHeaders = {}, body = {}) {
  const header = String(reqHeaders['idempotency-key'] || reqHeaders['Idempotency-Key'] || '').trim();
  const fromBody = String(body.batch_id || '').trim();
  const claimed = (header || fromBody).slice(0, 200);
  if (!claimed) return '';
  const expected = batchIdFromPayload(body);
  if (claimed === expected) return claimed;
  return expected === EMPTY_BATCH_ID ? '' : expected;
}

function readAcks(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function fsyncDir(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* ponytail: directory fsync is best-effort; WAL seq-dedupe is the safety net. */
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function writeAcks(file, acks) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(acks)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

/**
 * Restart-safe replay of a phone POST ACK. WAL/seq dedupe is still the
 * source of truth; this only avoids re-entering append on a lost response.
 * ponytail: 64-key cap; older ids fall back to WAL seq-dedupe. Upgrade: index.
 */
export function createBatchAckStore(file = null) {
  let acks = readAcks(file);
  return {
    replay(id) {
      if (!id) return null;
      return acks[id] || null;
    },
    remember(id, ack) {
      if (!id || !ack) return;
      acks[id] = ack;
      const keys = Object.keys(acks);
      if (keys.length > MAX_ACKS) {
        for (const key of keys.slice(0, keys.length - MAX_ACKS)) delete acks[key];
      }
      writeAcks(file, acks);
    },
  };
}
