import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.join(here, '../data/live');

function dayKey(iso) {
  return String(iso || new Date().toISOString()).slice(0, 10);
}

export function createLiveBuffer({
  dir = defaultDir,
  userId,
  flushEvery = 60,
  flushMs = 60_000,
  engine,
  now = () => new Date(),
} = {}) {
  const pending = [];
  let lastFlush = now().getTime();
  let flushing = false;

  function fileFor(day) {
    const safe = String(userId || 'local').replace(/[^a-zA-Z0-9_-]/g, '');
    const folder = path.join(dir, safe);
    fs.mkdirSync(folder, { recursive: true });
    return path.join(folder, `${day}.ndjson`);
  }

  function appendLine(sample) {
    const day = dayKey(sample.datetime);
    fs.appendFileSync(fileFor(day), `${JSON.stringify(sample)}\n`);
  }

  function readDay(day) {
    const file = fileFor(day);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  async function flush() {
    if (flushing || !pending.length || !engine) return null;
    flushing = true;
    const batch = pending.splice(0, pending.length);
    lastFlush = now().getTime();
    try {
      const archived = await engine.archiveRawSamples({
        samples: batch,
        device: batch[0],
        startAt: batch[0].datetime,
        endAt: batch[batch.length - 1].datetime,
        day: dayKey(batch[batch.length - 1].datetime),
      });
      const today = dayKey(now().toISOString());
      const yesterday = new Date(now().getTime() - 86400000).toISOString().slice(0, 10);
      const samples = [...readDay(yesterday), ...readDay(today)];
      let computed = null;
      if (samples.length >= 20) {
        computed = await engine.persistComputed({
          samples,
          device: batch[0],
        });
      }
      return { archived, computed, flushed: batch.length };
    } finally {
      flushing = false;
    }
  }

  return {
    append(sample) {
      const row = {
        datetime: sample.datetime || sample.at || sample.t || now().toISOString(),
        bpm: Number(sample.bpm ?? sample.heartRate),
        sleep_stage: sample.sleep_stage || null,
        battery: sample.battery ?? null,
        connected: Boolean(sample.connected),
        deviceId: sample.deviceId || sample.externalId || null,
        name: sample.name || null,
        firmware: sample.firmware || null,
      };
      if (!Number.isFinite(row.bpm)) return row;
      appendLine(row);
      pending.push(row);
      const due = pending.length >= flushEvery || (now().getTime() - lastFlush) >= flushMs;
      if (due) flush().catch(() => {});
      return row;
    },
    samplesFor(day) {
      return readDay(day || dayKey(now().toISOString()));
    },
    pendingCount() {
      return pending.length;
    },
    flush,
  };
}
