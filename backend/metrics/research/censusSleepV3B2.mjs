#!/usr/bin/env node
/**
 * Download a few production B2 objects and census v18/v21/v26/type-48.
 * Read-only. Does not enable FRWHOOP_SLEEP_V3=beta.
 */
import { gunzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getStores } from '../../storage/stores.js';
import { deriveRecords } from '../../redecode/derive.js';
import { decodeImuArchive } from '../../protocol/imuArchive.js';
import { decodePpgArchive } from '../../protocol/ppgArchive.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

function parseNdjson(body) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = gunzipSync(buf); } catch { /* plain */ }
  }
  const text = buf.toString('utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function packetCensus(rows) {
  let v18 = 0; let v21 = 0; let v26 = 0; let t48 = 0; let other = 0;
  for (const row of rows) {
    const hex = row?.hex || row?.payload_hex || '';
    if (hex.length < 24) { other += 1; continue; }
    const buf = Buffer.from(hex, 'hex');
    const fam = String(row.family || row.service_family || '').toLowerCase();
    const pt = fam === 'puffin' || buf[0] === 0xAA ? buf[8] : buf[4];
    const hv = fam === 'puffin' || buf[0] === 0xAA ? buf[9] : buf[5];
    if (pt === 47 && hv === 18) v18 += 1;
    else if (pt === 47 && hv === 21) v21 += 1;
    else if (pt === 47 && hv === 26) v26 += 1;
    else if (pt === 48) t48 += 1;
    else other += 1;
  }
  return { rows: rows.length, v18, v21, v26, type48: t48, other };
}

async function main() {
  const restUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const q = `${restUrl}/rest/v1/object_manifests?select=object_kind,object_key,sha256,status,start_at,compressed_bytes&status=eq.ready&object_kind=in.(frames,imu_raw,events,ppg_raw)&order=uploaded_at.desc&limit=20`;
  const res = await fetch(q, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const manifests = await res.json();
  const stores = await getStores();
  const byKind = {};
  for (const row of manifests) {
    if (byKind[row.object_kind]) continue;
    byKind[row.object_kind] = row;
  }
  const report = { manifests_sampled: Object.keys(byKind), objects: {}, derive: null };
  for (const [kind, row] of Object.entries(byKind)) {
    const obj = await stores.raw.getObject(row.object_key);
    if (!obj?.body) {
      report.objects[kind] = { error: 'missing_body', key: row.object_key };
      continue;
    }
    const body = obj.body;
    if (kind === 'imu_raw') {
      const recs = decodeImuArchive(body);
      const v21 = recs.filter((r) => r?.kind === 'hist_v21');
      report.objects[kind] = {
        key: row.object_key, sha256: row.sha256, records: recs.length, v21: v21.length,
        sample_rate_hz: v21[0]?.sample_rate_hz ?? null,
        decoder_version: v21[0]?.decoder?.version || v21[0]?.identity?.decoder_version || null,
        layout: v21[0]?.layout || null,
      };
    } else if (kind === 'ppg_raw') {
      const recs = decodePpgArchive(body);
      report.objects[kind] = {
        key: row.object_key, sha256: row.sha256, records: recs.length,
        v26: recs.filter((r) => r.kind === 'hist_v26').length,
        rates: [...new Set(recs.map((r) => r.sample_rate_hz))],
      };
    } else {
      const rows = parseNdjson(body);
      const census = packetCensus(rows);
      report.objects[kind] = { key: row.object_key, sha256: row.sha256, ...census };
      if (kind === 'frames') {
        const derived = deriveRecords(rows.slice(0, 4000));
        report.derive = {
          imu: derived.imu.length,
          ppg: derived.ppg.length,
          events: derived.events.length,
          ppg_kinds: [...new Set(derived.ppg.map((r) => r.kind))],
          imu_kinds: [...new Set(derived.imu.map((r) => r.kind))],
          event_names: [...new Set(derived.events.map((r) => r.event_name).filter(Boolean))].slice(0, 20),
        };
      }
    }
  }
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache', 'whoop_sleep_v3_b2_census.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
