#!/usr/bin/env node
// Download every B2 Level A frames object and replay the current decoder.
// Also derives the events stream (type 48 + type 54) so historical packet-54
// archives can be reprocessed. Type 54 is historical/replayed only.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { storageConfig } from '../storage/config.js';
import { createS3 } from '../storage/s3.js';
import { replayNotifies } from '../redecode/redecode.js';
import { deriveHistoricalFromObjects } from '../redecode/historicalDerived.js';
import { encodeEventArchive } from '../protocol/eventRecords.js';

const LIST_PATH = '/tmp/frwhoop-b2-list.json';
const DEFAULT_OUT_DIR = '/tmp/frwhoop-redecode';
const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}
const OUT_DIR = flagValue('out', DEFAULT_OUT_DIR);
const deriveOff = argv.includes('--no-derive');
const uploadDerived = argv.includes('--upload-derived');
const FRAME_CACHE = path.join(OUT_DIR, 'frames');

function parseRows(buf) {
  let text;
  try {
    text = gunzipSync(buf).toString('utf8');
  } catch {
    text = buf.toString('utf8');
  }
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  }
  return trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function userOf(key) {
  const m = /\/users\/([^/]+)\//.exec(key);
  return m ? m[1] : 'unknown';
}

function deviceOf(key) {
  const m = /\/devices\/([^/]+)\//.exec(key);
  return m ? m[1] : 'unknown';
}

function emptyHist() {
  return {
    frames: 0,
    decoded: 0,
    mapped: 0,
    unique_unix: new Set(),
    unique_record_index: new Set(),
    samples: 0,
    fields_present: {},
    first_unix: null,
    last_unix: null,
  };
}

function bumpUnix(h, unix) {
  if (!Number.isFinite(unix) || unix <= 0) return;
  h.unique_unix.add(unix);
  if (h.first_unix == null || unix < h.first_unix) h.first_unix = unix;
  if (h.last_unix == null || unix > h.last_unix) h.last_unix = unix;
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function main() {
  mkdirSync(FRAME_CACHE, { recursive: true });
  const listed = JSON.parse(readFileSync(LIST_PATH, 'utf8'));
  const frameKeys = listed.frame_keys || [];
  const cfg = storageConfig();
  const s3 = createS3({
    endpoint: cfg.b2S3Endpoint,
    bucket: cfg.b2Bucket,
    region: cfg.b2Region,
    accessKeyId: cfg.b2KeyId,
    secretAccessKey: cfg.b2ApplicationKey,
  });

  let downloadFailures = 0;
  const perObject = [];
  await pool(frameKeys, 8, async (key) => {
    const local = path.join(FRAME_CACHE, key.replaceAll('/', '_'));
    let body;
    try {
      try {
        body = readFileSync(local);
      } catch {
        const obj = await s3.getObject(key);
        if (!obj) throw new Error('missing');
        body = obj.body;
        writeFileSync(local, body);
      }
      const rows = parseRows(body);
      perObject.push({
        key,
        user: userOf(key),
        device: deviceOf(key),
        notifies: rows.length,
        bytes: body.length,
        families: [...new Set(rows.map((r) => r.family).filter(Boolean))],
        models: [...new Set(rows.map((r) => r.model).filter(Boolean))],
        rows,
      });
    } catch (err) {
      downloadFailures += 1;
      perObject.push({ key, user: userOf(key), device: deviceOf(key), error: String(err.message || err), rows: [] });
    }
  });

  const notifies = [];
  const objectMeta = [];
  for (const o of perObject) {
    objectMeta.push({
      key: o.key, user: o.user, device: o.device,
      notifies: o.notifies || 0, bytes: o.bytes || 0,
      families: o.families || [], models: o.models || [],
      error: o.error || null,
    });
    for (const row of o.rows || []) notifies.push({ ...row, _user: o.user, _device: o.device, _key: o.key });
  }

  // FRAMED-ROWS-ONLY reassembly (2026-08-30 fix): GATT service reads (2A19
  // battery / 2A24 model / 2A26 fw) and non-WHOOP vault blobs contain 0xAA
  // bytes; feeding them through the same shared reassembler interleaves
  // garbage into real frame streams (observed: 8 false CRC-invalid frames and
  // 240 lost real frames per corpus run). Archive rows carry the WHOOP
  // payload in `hex`; only rows with an AA-framed payload belong here.
  const framedNotifies = notifies.filter((row) => {
    const hex = typeof row?.hex === 'string' ? row.hex : '';
    return hex.length >= 16 && hex.startsWith('aa');
  });
  const result = replayNotifies(framedNotifies, { family: undefined });

  const packetTypes = {};
  const families = {};
  const hist = { 18: emptyHist(), 20: emptyHist(), 21: emptyHist(), 26: emptyHist() };
  const otherHist = {};
  const users = {};
  const type43 = { imu: 0, optical: 0, unknown: 0 };
  const type2f = { frames: 0, lengths: {} };
  let recoveredSemantic = 0;

  for (const rec of result.levelB) {
    const pt = rec.packet_type ?? 'null';
    packetTypes[pt] = (packetTypes[pt] || 0) + 1;
    families[rec.family] = (families[rec.family] || 0) + 1;
    if (pt === 47) {
      const parsed = rec.decoded?.parsed || {};
      const v = parsed.hist_version ?? rec.version;
      const bucket = hist[v] ? hist[v] : (otherHist[v] = otherHist[v] || emptyHist());
      bucket.frames += 1;
      if (rec.decode_status === 'decoded') bucket.decoded += 1;
      if (rec.decoded?.mapped) {
        bucket.mapped += 1;
        recoveredSemantic += 1;
      }
      bumpUnix(bucket, parsed.unix);
      if (parsed.record_index != null) bucket.unique_record_index.add(parsed.record_index);
      if (v === 18) {
        for (const k of Object.keys(parsed)) bucket.fields_present[k] = (bucket.fields_present[k] || 0) + 1;
        bucket.samples += 1;
      } else if (v === 20) {
        const n = parsed.sensor_channel_samples || 0;
        const c = parsed.sensor_channels_present || 0;
        bucket.samples += n * c;
      } else if (v === 21) {
        bucket.samples += (parsed.sensor_channel_samples || 0) * (parsed.sensor_channels_present || 0);
      } else if (v === 26) {
        bucket.samples += parsed.ppg_sample_count || (parsed.ppg_waveform || []).length;
      }
    }
    if (pt === 43) {
      const kind = rec.decoded?.kind || 'unknown';
      type43[kind] = (type43[kind] || 0) + 1;
    }
    if (pt === 47 && rec.decoded?.parsed?.hist_version == null && rec.version === 0x2f) {
      type2f.frames += 1;
    }
    if (pt === 0x2f || rec.packet_name === 'HISTORICAL_DATA' && rec.decoded?.parsed?.record_class === 0x2f) {
      type2f.frames += 1;
      const len = rec.frame_length;
      type2f.lengths[len] = (type2f.lengths[len] || 0) + 1;
    }
  }

  // Type 0x2F is a packet type, not a historical version. Count packet type 47.
  const packetType47 = result.levelB.filter((r) => r.packet_type === 47);
  const packetType2F = result.levelB.filter((r) => r.packet_type === 47 && r.decoded?.parsed?.layout_marker != null
    ? false : r.packet_type === 0x2F);

  let derived = null;
  let uploaded = null;
  if (!deriveOff) {
    derived = deriveHistoricalFromObjects(perObject);
    const derivedDir = path.join(OUT_DIR, 'derived');
    mkdirSync(derivedDir, { recursive: true });
    const eventsArchive = encodeEventArchive(derived.events);
    const puffin54Archive = encodeEventArchive(derived.puffin54);
    writeFileSync(path.join(derivedDir, 'events.ndjson.gz'), eventsArchive.body);
    writeFileSync(path.join(derivedDir, 'puffin54.ndjson.gz'), puffin54Archive.body);
    writeFileSync(path.join(derivedDir, 'puffin54-census.json'), JSON.stringify(derived.census, null, 2));
    if (uploadDerived && derived.puffin54.length) {
      const { createMetricsEngine } = await import('../metrics/engine.js');
      const engine = createMetricsEngine({ cfg });
      const groups = new Map();
      for (const rec of derived.puffin54) {
        const uid = rec.provenance?.user_id || userOf(rec.provenance?.b2_key || '');
        const did = rec.provenance?.device_id || deviceOf(rec.provenance?.b2_key || '');
        const gk = `${uid}\0${did}`;
        if (!groups.has(gk)) groups.set(gk, { user: uid, device: did, records: [] });
        groups.get(gk).records.push(rec);
      }
      uploaded = { groups: groups.size, objects: [] };
      for (const g of groups.values()) {
        const times = g.records
          .map((r) => Number(r.stored_unix))
          .filter((n) => Number.isFinite(n));
        const startAt = times.length
          ? new Date(Math.min(...times) * 1000).toISOString()
          : new Date().toISOString();
        const endAt = times.length
          ? new Date(Math.max(...times) * 1000).toISOString()
          : startAt;
        const row = await engine.archiveDerivedStream({
          records: g.records,
          stream: 'events',
          format: 'ndjson_gzip_events_v1',
          schemaVersion: 1,
          device: { externalId: g.device, deviceId: g.device },
          startAt,
          endAt,
          extras: { userId: g.user },
        });
        uploaded.objects.push({
          user: g.user,
          device: g.device,
          records: g.records.length,
          object_id: row?.id || null,
          status: row?.status || null,
        });
      }
    }
  }

  function freezeHist(h) {
    const unixCount = h.unique_unix.size;
    const span = h.first_unix != null && h.last_unix != null ? (h.last_unix - h.first_unix + 1) : 0;
    return {
      frames: h.frames,
      decoded: h.decoded,
      mapped: h.mapped,
      unique_unix: unixCount,
      unique_record_index: h.unique_record_index.size,
      samples: h.samples,
      first_unix: h.first_unix,
      last_unix: h.last_unix,
      span_seconds: span,
      span_hours: span ? +(span / 3600).toFixed(2) : 0,
      fields_present: h.fields_present,
    };
  }

  const summary = {
    ran_at: new Date().toISOString(),
    decoder: 'frwhoop-js/1 <- noop@ab0f699e',
    b2_objects_listed: listed.object_count,
    frame_objects: frameKeys.length,
    download_failures: downloadFailures,
    notifies: notifies.length,
    session: result.session,
    families,
    packet_types: packetTypes,
    type43,
    type0x2F_packet: {
      frames: packetType2F.length,
    },
    historical: {
      v18: freezeHist(hist[18]),
      v20: freezeHist(hist[20]),
      v21: freezeHist(hist[21]),
      v26: freezeHist(hist[26]),
      other: Object.fromEntries(Object.entries(otherHist).map(([k, v]) => [k, freezeHist(v)])),
    },
    recovered_semantic_historical_frames: recoveredSemantic,
    packet_54: {
      level_b_frames: packetTypes[54] || 0,
      derived: derived?.census || null,
      uploaded,
    },
    objects: objectMeta,
    unknown_observations: result.observed.length,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    frame_objects: summary.frame_objects,
    download_failures: summary.download_failures,
    notifies: summary.notifies,
    reassembled_frames: summary.session.reassembled_frames,
    decoded_frames: summary.session.decoded_frames,
    historical: summary.historical,
    packet_types: summary.packet_types,
    families: summary.families,
    type43: summary.type43,
    packet_54: summary.packet_54,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
