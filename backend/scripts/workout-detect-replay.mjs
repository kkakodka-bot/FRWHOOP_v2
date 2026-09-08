#!/usr/bin/env node
/**
 * Offline V1 vs V2 replay. Synthetics always run.
 * Pass --labeled to reconstruct type-40 HR from archived frames (eval-only)
 * and score the six LA windows. Never prints secrets, never mutates production.
 */
import {
  evaluateWindow,
  strengthSetRest,
  walkCadence,
  stressHr,
  noisyDesk,
  series,
  LABELED_WINDOWS,
  type40SamplesFromFrames,
  gattSamplesFromFrames,
  mergeHrReplay,
  labeledBoundsMs,
  productionMissCause,
  classifyCaptureWindow,
} from '../metrics/workoutDetectReplay.js';
import { createReassembler, verifyFrame } from '../protocol/framing.js';
import { decodeFrame } from '../protocol/decoder.js';

const T0 = Date.UTC(2026, 7, 1, 18, 0, 0);

function block(name, samples, start, end, extra = {}) {
  const ev = evaluateWindow({
    samples, start, end, restingHr: 60, maxHr: 174, padMin: 0, ...extra,
  });
  return {
    name,
    v1: { hit: ev.v1.hit, path: ev.v1.path, sport: ev.v1.sport, miss: ev.v1.miss, latencyS: ev.v1.latencyS },
    v2: { hit: ev.v2.hit, path: ev.v2.path, sport: ev.v2.sport, miss: ev.v2.miss, latencyS: ev.v2.latencyS, branch: ev.v2.scores?.branch },
    disagree: ev.disagree,
    coverage: ev.coverage,
    unavailable: ev.unavailable,
  };
}

const synthetics = [
  block(
    'strength_modest_hr_set_rest',
    [...series({ t0: T0, seconds: 180, bpm: 65, phoneMotion: 0.02 }), ...strengthSetRest({ t0: T0 + 180_000, minutes: 6, hr: 90 })],
    T0 + 180_000,
    T0 + 180_000 + 6 * 60_000,
  ),
  block(
    'indoor_walk_cadence',
    [...series({ t0: T0, seconds: 120, bpm: 70, phoneMotion: 0.02 }), ...walkCadence({ t0: T0 + 120_000, minutes: 8 })],
    T0 + 120_000,
    T0 + 120_000 + 8 * 60_000,
  ),
  block(
    'stress_hr_no_motion',
    [...series({ t0: T0, seconds: 120, bpm: 70, phoneMotion: 0.01 }), ...stressHr({ t0: T0 + 120_000, minutes: 10 })],
    T0 + 120_000,
    T0 + 120_000 + 10 * 60_000,
  ),
  block(
    'noisy_desk',
    noisyDesk({ t0: T0, minutes: 8 }),
    T0,
    T0 + 8 * 60_000,
  ),
  block(
    'empty_labeled_gap',
    series({ t0: T0, seconds: 30, bpm: 70, motion: 0.02 }),
    T0 + 3_600_000,
    T0 + 3_600_000 + 3_600_000,
  ),
];

function hexToBytes(hex) {
  if (!hex) return [];
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function compactChar(char) {
  return String(char || 'unknown').toUpperCase().replace(/-/g, '').slice(0, 12);
}

function scoreWindow(w, samples, extra = {}) {
  const ev = evaluateWindow({
    samples,
    start: w.start,
    end: w.end,
    restingHr: 60,
    maxHr: 174,
    padMin: 45,
    ...extra,
  });
  const inBout = samples.filter((s) => s.ts >= w.start && s.ts < w.end);
  return {
    id: w.id,
    sport: w.sport || 'none',
    raw_type40: extra.rawType40 ?? inBout.length,
    decoded_hr: inBout.length,
    reconstructed_coverage: {
      n: inBout.length,
      span_s: inBout.length ? Math.round((inBout[inBout.length - 1].ts - inBout[0].ts) / 1000) : 0,
      ts_sensor: inBout.filter((s) => s.timestamp_source === 'sensor').length,
      ts_receive: inBout.filter((s) => s.timestamp_source === 'receive').length,
    },
    v1: {
      hit: ev.v1.hit,
      path: ev.v1.path,
      sport: ev.v1.sport,
      miss: ev.v1.miss,
      reason: ev.v1.miss || ev.v1.reason,
      latencyS: ev.v1.latencyS,
      onsetErrorS: ev.v1.onsetErrorS,
    },
    v2: {
      hit: ev.v2.hit,
      path: ev.v2.path,
      sport: ev.v2.sport,
      miss: ev.v2.miss,
      reason: ev.v2.miss || ev.v2.scores?.reason,
      branch: ev.v2.scores?.branch,
      latencyS: ev.v2.latencyS,
      onsetErrorS: ev.v2.onsetErrorS,
    },
    unavailable: ev.unavailable,
    production_miss: extra.productionMiss || null,
  };
}

const report = {
  replay: 'workout_detect_replay',
  v2_mode: 'shadow-only',
  synthetics,
  labeled: null,
};

if (process.argv.includes('--labeled')) {
  const { storageConfig } = await import('../storage/config.js');
  const { getStores } = await import('../storage/stores.js');
  const { decodeFrameArchive } = await import('../ingest/archiveFormat.js');
  const cfg = storageConfig();
  const stores = await getStores(cfg);
  const windows = LABELED_WINDOWS.map((w) => {
    const { start, end } = labeledBoundsMs(w);
    return { ...w, start, end };
  });
  const w5 = windows.find((w) => w.id === 'w5');
  const pad = 45 * 60_000;
  const reconstructed = [];
  const gattRows = [];
  const proof = new Map();
  const charTypes = {};
  let frames = 0;
  let t40 = 0;
  let t43 = 0;

  const keys = [];
  for (const uid of [cfg.localUserId, '9f33375b-e029-480f-9ebb-a99e5ff22ac9']) {
    try { keys.push(...await stores.raw.listPrefix(`v3/core/users/${uid}/`)); } catch { /* */ }
  }
  const frameKeys = keys.filter((k) => /\/frames\//.test(k) && /\/2026\/08\/(2[5-9]|30|31)\//.test(k));

  function feedProof(row, bytes) {
    if (!w5) return;
    const recv = Date.parse(row.t || '');
    if (!Number.isFinite(recv) || recv < w5.start - pad || recv >= w5.end + pad) return;
    const family = row.family === 'harvard' ? 'harvard' : 'puffin';
    const char = compactChar(row.char);
    let st = proof.get(char);
    if (!st) {
      st = {
        family,
        n: 0,
        type40: 0,
        complete: 0,
        legacy: createReassembler({ family, intactNotify: false }),
        neu: createReassembler({ family, intactNotify: true }),
        legacy40: 0,
        neu40: 0,
      };
      proof.set(char, st);
    }
    st.n += 1;
    const rec = decodeFrame(bytes, family);
    if (rec.packet_type === 40) {
      st.type40 += 1;
      const v = verifyFrame(bytes, family);
      if (v.ok && bytes.length === v.total) st.complete += 1;
    }
    const count40 = (framesOut, into) => {
      for (const f of framesOut) {
        const d = decodeFrame(f, family);
        if (d.packet_type === 40 && d.crc_ok && d.decoded?.hr) st[into] += 1;
      }
    };
    count40(st.legacy.feed(bytes).frames, 'legacy40');
    count40(st.neu.feed(bytes).frames, 'neu40');
  }

  let i = 0;
  for (const k of frameKeys) {
    i += 1;
    const obj = await stores.raw.getObject(k);
    if (!obj?.body) continue;
    let rows;
    try { rows = decodeFrameArchive(obj.body); } catch { continue; }
    for (const row of rows) {
      frames += 1;
      const gattHit = String(row.family || '').toLowerCase() === 'gatt'
        || /2A37/i.test(String(row.char || ''));
      if (gattHit) {
        gattRows.push(row);
        continue;
      }
      const bytes = hexToBytes(row.hex);
      if (bytes.length < 10) continue;
      const family = row.family === 'harvard' ? 'harvard' : 'puffin';
      const rec = decodeFrame(bytes, family);
      const char = compactChar(row.char);
      if (rec.packet_type) {
        charTypes[char] = charTypes[char] || {};
        charTypes[char][rec.packet_type] = (charTypes[char][rec.packet_type] || 0) + 1;
      }
      if (rec.packet_type === 43) t43 += 1;
      if (rec.packet_type === 40) {
        t40 += 1;
        const { samples } = type40SamplesFromFrames([row]);
        reconstructed.push(...samples);
      }
      feedProof(row, bytes);
    }
    if (i % 25 === 0) console.error(`replay ${i}/${frameKeys.length}`);
  }

  reconstructed.sort((a, b) => a.ts - b.ts);
  const gatt = gattSamplesFromFrames(gattRows);
  const merged = mergeHrReplay(reconstructed, gatt.samples);
  const proofChars = {};
  let legacy40 = 0;
  let neu40 = 0;
  let complete40 = 0;
  for (const [char, st] of proof) {
    proofChars[char] = {
      family: st.family,
      notifies: st.n,
      type40: st.type40,
      type40_complete_envelopes: st.complete,
      type40_legacy_reassembled: st.legacy40,
      type40_fixed_reassembled: st.neu40,
    };
    legacy40 += st.legacy40;
    neu40 += st.neu40;
    complete40 += st.complete;
  }

  const labeled = windows.map((w) => {
    const inBout = merged.filter((s) => s.ts >= w.start && s.ts < w.end);
    const recvInBout = merged.filter((s) => {
      const r = Date.parse(s.receive_t || s.datetime || '');
      return Number.isFinite(r) && r >= w.start && r < w.end;
    });
    const t40n = inBout.filter((s) => s.src !== 'gatt_hr').length;
    const gattN = inBout.filter((s) => s.src === 'gatt_hr').length;
    const captureClass = classifyCaptureWindow({
      objectCount: t40n + gattN,
      type40Count: t40n,
      gattHrCount: gattN,
      anyNotify: t40n + gattN > 0,
    });
    return scoreWindow(w, merged, {
      rawType40: t40n,
      productionMiss: productionMissCause({
        rawType40: t40n,
        gattHr: gattN,
        physiologyHr: 0,
        reconstructedHr: inBout.length,
        captureClass,
      }),
    });
  });

  const negatives = windows.map((w) => {
    const dur = w.end - w.start;
    const start = w.start - 2 * 3600_000;
    return scoreWindow({ id: `${w.id}_neg`, start, end: start + dur, sport: 'none' }, merged);
  });

  report.labeledNote = {
    supabaseHost: cfg.supabaseUrl ? new URL(cfg.supabaseUrl).host : null,
    hasB2: Boolean(cfg.b2Bucket),
    side_effects: 'none',
    type43_enabled: false,
  };
  report.root_cause = {
    mechanism: 'complete_type40_notify_spliced_into_partial_reassembly',
    frames_scanned: frames,
    type40_global: t40,
    type43_global: t43,
    w5_pad_proof: {
      complete_type40_notifies: complete40,
      legacy_concat_emitted: legacy40,
      complete_notify_first_emitted: neu40,
      chars: proofChars,
    },
    char_packet_types: charTypes,
  };
  report.labeled = labeled;
  report.negatives = negatives;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
