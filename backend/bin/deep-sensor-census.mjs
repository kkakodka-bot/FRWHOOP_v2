#!/usr/bin/env node
// Read-only WHOOP 5/MG type-47 deep-sensor census over Level A B2/raw captures.
// Never sends strap commands. Writes docs/deep-sensor-census.{json,md}.
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageConfig } from '../storage/config.js';
import { createS3 } from '../storage/s3.js';
import { createReassembler, verifyFrame } from '../protocol/framing.js';
import { crc16Modbus, u16le, u32le } from '../protocol/crc.js';
import { parseArchiveRows, framedRowsOnly } from '../protocol/census.js';
import {
  classifyType47Puffin, decodeWhoop5ImuV21, decodeWhoop5PpgV26, decodeWhoop5OpticalV20,
  gravityShellStats, gyroStats, v21Cadence, v26HrLock, v20StructuralStats,
  DEEP_SENSOR_DECODER_VERSION, V18_FRAME_LEN, V20_FRAME_LEN, V21_FRAME_LEN, V26_FRAME_LEN,
} from '../protocol/deepSensor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIST_PATH = '/tmp/frwhoop-b2-list.json';
const DEFAULT_CACHE_DIR = '/tmp/frwhoop-redecode/frames';
const FIXTURES = path.join(here, '../tests/fixtures/noop-whoop5-parity.json');
const FRWHOOP_FIX = path.join(here, '../../docs/research/fixtures/deep_records_2026-09-01.json');
const OUT_JSON = path.join(here, '../../docs/deep-sensor-census.json');
const OUT_MD = path.join(here, '../../docs/deep-sensor-census.md');

function flagValue(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}

function deviceOf(key) {
  return /\/devices\/([^/]+)\//.exec(key)?.[1] || 'unknown';
}
function dayOfIso(iso) {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : String(iso).slice(0, 10);
}

function bump(map, key, by = 1) {
  const k = String(key);
  map[k] = (map[k] || 0) + by;
}

function emptyLayout() {
  return {
    frames: 0, crc_ok: 0, crc_failed: 0, shape_ok: 0, shape_rejected: 0,
    decoded: 0, decode_rejected: 0,
    truncated_notifies: 0, truncated_unique: 0,
    by_device: {}, by_firmware: {}, by_day: {}, by_object: {},
  };
}

function walkCache(dir) {
  if (!dir || !existsSync(dir)) return [];
  const keys = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && (e.name.endsWith('.gz') || e.name.endsWith('.ndjson') || e.name.includes('frames'))) {
        keys.push(p);
      }
    }
  }
  return keys;
}

function addMeta(layout, rec, objectKey) {
  bump(layout.by_device, rec.device);
  bump(layout.by_firmware, rec.firmware);
  bump(layout.by_day, rec.day);
  bump(layout.by_object, objectKey);
}

function familyOf(row) {
  const fam = String(row.family || '').toLowerCase();
  const ch = String(row.char || row.characteristic || '');
  if (fam === 'puffin' || ch.toUpperCase().startsWith('FD4B')) return 'puffin';
  if (fam === 'harvard' || ch.toUpperCase().startsWith('6108')) return 'harvard';
  return 'puffin';
}

function puffinHeaderOk(b) {
  return b.length >= 8 && b[0] === 0xAA && b[1] === 0x01
    && crc16Modbus(b, 0, 6) === u16le(b, 6);
}

function topMap(map, n = 20) {
  return Object.fromEntries(Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n));
}

function compactLayout(layout) {
  return {
    ...layout,
    by_object: topMap(layout.by_object, 20),
    object_count: Object.keys(layout.by_object || {}).length,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const cacheDir = flagValue(argv, 'cache-dir', DEFAULT_CACHE_DIR);
  const listPath = flagValue(argv, 'list', LIST_PATH);
  const limitRaw = flagValue(argv, 'limit', null);
  const limit = limitRaw != null ? Number(limitRaw) : null;

  mkdirSync(cacheDir, { recursive: true });
  const cfg = storageConfig();
  let frameKeys = [];
  let listSource = 'none';
  if (existsSync(listPath)) {
    const listed = JSON.parse(readFileSync(listPath, 'utf8'));
    frameKeys = Array.isArray(listed.frame_keys) ? listed.frame_keys : [];
    listSource = listPath;
  } else if (cfg.b2KeyId && cfg.b2ApplicationKey) {
    listSource = 'b2_live_list_unavailable_use_cache';
  }

  const s3 = (cfg.b2KeyId && cfg.b2ApplicationKey)
    ? createS3({
      endpoint: cfg.b2S3Endpoint,
      bucket: cfg.b2Bucket,
      region: cfg.b2Region,
      accessKeyId: cfg.b2KeyId,
      secretAccessKey: cfg.b2ApplicationKey,
    })
    : null;

  let localCacheFiles = [];
  if (!frameKeys.length) {
    localCacheFiles = walkCache(cacheDir);
    listSource = localCacheFiles.length ? `cache:${cacheDir}` : listSource;
  }

  let downloadFailures = 0;
  let objectCount = 0;
  let notifyCount = 0;
  let framedCount = 0;
  let reassembled = 0;
  let crcValidFrames = 0;
  let crcInvalidFrames = 0;
  let maxNotify = 0;

  const loadBody = async (key, isLocalPath) => {
    if (isLocalPath) return readFileSync(key);
    const local = path.join(cacheDir, key.replaceAll('/', '_'));
    try { return readFileSync(local); } catch { /* download */ }
    if (!s3) throw new Error('no_s3');
    const obj = await s3.getObject(key);
    if (!obj?.body) throw new Error('missing');
    writeFileSync(local, obj.body);
    return obj.body;
  };

  const jobs = frameKeys.length
    ? frameKeys.map((key) => ({ key, local: false }))
    : localCacheFiles.map((p) => ({ key: p, local: true }));

  const layouts = {
    v18: emptyLayout(),
    v20: emptyLayout(),
    v21: emptyLayout(),
    v26: emptyLayout(),
    unknown: emptyLayout(),
  };
  const type43v21 = emptyLayout();
  const unexpected = [];
  const imuFrames = [];
  const ppgFrames = [];
  const opticalFrames = [];
  const hrByUnix = {};
  const uniq = { v20: new Set(), v21: new Set(), t43v21: new Set() };
  let crcRejected = 0;
  let shapeRejected = 0;
  let unknownLayout = 0;
  let type47 = 0;

  function compactV20(frame) {
    const compactBlock = (b) => ({
      sample_count: b.sample_count,
      channel_a: b.channel_a,
      channel_b: b.channel_b,
      reserved: b.reserved,
      unused_a_all_zero: b.unused_a_all_zero,
      unused_b_all_zero: b.unused_b_all_zero,
    });
    return {
      sample_count_pattern: frame.sample_count_pattern,
      block_0: compactBlock(frame.block_0),
      block_1: compactBlock(frame.block_1),
      block_2: compactBlock(frame.block_2),
      block_3: compactBlock(frame.block_3),
      block_4: compactBlock(frame.block_4),
    };
  }

  function noteTruncated(bucket, uniqSet, buf, row, objectKey) {
    const idx = u32le(buf, 11);
    const ts = u32le(buf, 15);
    const key = `${idx}|${ts}`;
    bucket.truncated_notifies += 1;
    if (!uniqSet.has(key)) {
      uniqSet.add(key);
      bucket.truncated_unique += 1;
      addMeta(bucket, {
        device: row.device || deviceOf(objectKey) || 'unknown',
        firmware: row.fw || row.firmware || 'unknown',
        day: dayOfIso(row.t || (ts ? new Date(ts * 1000).toISOString() : null)),
      }, objectKey);
    }
  }

  function ingestFrame(buf, row, objectKey) {
    if (buf[8] === 40 && buf.length >= 17) {
      const hr = buf[16];
      const ts = u32le(buf, 10);
      if (hr >= 25 && hr <= 230 && ts) hrByUnix[ts] = hr;
    }
    if (buf[8] !== 47) return;
    type47 += 1;
    const c = classifyType47Puffin(buf);
    const version = c.layout === 'unknown' ? 'unknown' : c.layout;
    const bucket = layouts[version] || layouts.unknown;
    const device = row.device || deviceOf(objectKey) || 'unknown';
    const firmware = row.fw || row.firmware || 'unknown';
    const meta = {
      packet_type: 47,
      layout_version: c.layout_version,
      total_frame_length: c.total_frame_length,
      record_index: c.record_index,
      strap_timestamp: c.strap_timestamp,
      device,
      firmware,
      frame_hash: null,
      source_object_id: objectKey,
      crc_ok: c.crc_ok,
      shape_ok: c.shape_ok,
      day: dayOfIso(row.t || (c.strap_timestamp ? new Date(c.strap_timestamp * 1000).toISOString() : null)),
    };
    bucket.frames += 1;
    if (c.crc_ok) bucket.crc_ok += 1;
    else { bucket.crc_failed += 1; crcRejected += 1; }
    if (c.shape_ok) bucket.shape_ok += 1;
    else { bucket.shape_rejected += 1; shapeRejected += 1; }
    if (version === 'unknown') unknownLayout += 1;
    addMeta(bucket, meta, objectKey);

    if (!c.crc_ok || !c.shape_ok) {
      if (unexpected.length < 20) unexpected.push({ ...meta, reason: c.reason });
      return;
    }
    if (version === 'v18' && buf.length === V18_FRAME_LEN) {
      const hr = buf[22];
      if (hr >= 25 && hr <= 230) hrByUnix[c.strap_timestamp] = hr;
      bucket.decoded += 1;
    } else if (version === 'v21') {
      const d = decodeWhoop5ImuV21(buf, { sourceObjectId: objectKey, fw: firmware });
      if (d.ok) {
        bucket.decoded += 1;
        imuFrames.push(d.frame);
      } else {
        bucket.decode_rejected += 1;
      }
    } else if (version === 'v26') {
      const d = decodeWhoop5PpgV26(buf, { sourceObjectId: objectKey, fw: firmware });
      if (d.ok) {
        bucket.decoded += 1;
        ppgFrames.push({ base_ts: d.frame.base_ts, samples: d.frame.samples });
      } else {
        bucket.decode_rejected += 1;
      }
    } else if (version === 'v20') {
      const d = decodeWhoop5OpticalV20(buf, { sourceObjectId: objectKey, fw: firmware });
      if (d.ok) {
        bucket.decoded += 1;
        opticalFrames.push(compactV20(d.frame));
      } else {
        bucket.decode_rejected += 1;
      }
    }
  }

  let remaining = limit;
  for (const job of jobs) {
    if (remaining != null && remaining <= 0) break;
    objectCount += 1;
    let rows;
    try {
      const body = await loadBody(job.key, job.local);
      rows = framedRowsOnly(parseArchiveRows(body));
    } catch {
      downloadFailures += 1;
      continue;
    }
    notifyCount += rows.length;
    framedCount += rows.length;
    const reassemblers = new Map();
    for (const row of rows) {
      if (remaining != null && remaining <= 0) break;
      const fam = familyOf(row);
      const bytes = typeof row.hex === 'string' ? Array.from(Buffer.from(row.hex, 'hex')) : null;
      if (!bytes?.length) continue;
      maxNotify = Math.max(maxNotify, bytes.length);
      const buf = Uint8Array.from(bytes);
      if (puffinHeaderOk(buf)) {
        const total = u16le(buf, 2) + 8;
        const type = buf[8];
        const ver = buf[9];
        const metaRow = { ...row, device: deviceOf(job.key) };
        if (buf.length < total) {
          if (type === 47 && ver === 20) noteTruncated(layouts.v20, uniq.v20, buf, metaRow, job.key);
          else if (type === 47 && ver === 21) noteTruncated(layouts.v21, uniq.v21, buf, metaRow, job.key);
          else if (type === 43 && ver === 21) noteTruncated(type43v21, uniq.t43v21, buf, metaRow, job.key);
        }
      }
      const ch = String(row.char || row.characteristic || fam);
      if (!reassemblers.has(ch)) reassemblers.set(ch, createReassembler({ family: fam }));
      const ack = reassemblers.get(ch).feed(bytes);
      for (const frame of ack.frames || []) {
        reassembled += 1;
        const check = verifyFrame(frame, fam);
        if (check.ok) crcValidFrames += 1;
        else crcInvalidFrames += 1;
        if (fam === 'puffin') ingestFrame(Uint8Array.from(frame), { ...row, device: deviceOf(job.key) }, job.key);
        if (remaining != null) remaining -= 1;
      }
    }
  }

  const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  const fixtureFrames = {
    v18: fixtures.v18?.length || 0,
    v20: fixtures.v20_real ? 1 : 0,
    v21: fixtures.v21_real ? 1 : 0,
    v26: fixtures.v26_real ? 1 : 0,
  };
  const frwhoopFix = existsSync(FRWHOOP_FIX) ? JSON.parse(readFileSync(FRWHOOP_FIX, 'utf8')) : null;
  const fixtureImu = [];
  const fixtureOptical = [];
  if (fixtures.v21_real) {
    const d = decodeWhoop5ImuV21(Buffer.from(fixtures.v21_real.hex, 'hex'), { sourceObjectId: 'fixture:noop-whoop5-parity' });
    if (d.ok) fixtureImu.push(d.frame);
  }
  if (fixtures.v20_real) {
    const d = decodeWhoop5OpticalV20(Buffer.from(fixtures.v20_real.hex, 'hex'), { sourceObjectId: 'fixture:noop-whoop5-parity' });
    if (d.ok) fixtureOptical.push(compactV20(d.frame));
  }
  if (frwhoopFix?.v21_type47_1236) {
    const d = decodeWhoop5ImuV21(Buffer.from(frwhoopFix.v21_type47_1236.hex, 'hex'), { sourceObjectId: 'fixture:deep_records_2026-09-01' });
    if (d.ok) fixtureImu.push(d.frame);
  }
  if (frwhoopFix?.v20_type47_2132) {
    const d = decodeWhoop5OpticalV20(Buffer.from(frwhoopFix.v20_type47_2132.hex, 'hex'), { sourceObjectId: 'fixture:deep_records_2026-09-01' });
    if (d.ok) fixtureOptical.push(compactV20(d.frame));
  }

  const v20qa = v20StructuralStats(opticalFrames.length ? opticalFrames : fixtureOptical);
  const v21grav = gravityShellStats(imuFrames.length ? imuFrames : fixtureImu);
  const v21gyro = gyroStats(imuFrames.length ? imuFrames : fixtureImu);
  const v21cad = v21Cadence(imuFrames.length ? imuFrames : fixtureImu);
  const v26hr = v26HrLock(ppgFrames, hrByUnix);
  const contiguousMin = ppgFrames.length ? ppgFrames.length / 60 : 0;

  const report = {
    decoder_version: DEEP_SENSOR_DECODER_VERSION,
    generated_at: new Date().toISOString(),
    list_source: listSource,
    cache_dir: cacheDir,
    r22_action: 'not_needed',
    r22_reason: 'v20/v21 are already banked as type-47 prefixes in Level A; missing bytes are ATT MTU 247 truncation (max notify 244 B), not missing R22 flags. No SET_FF writes were sent.',
    capture_gap: {
      max_notify_bytes: maxNotify,
      att_mtu_payload: 244,
      v20_v21_complete_in_level_a: layouts.v20.decoded + layouts.v21.decoded,
      note: 'CoreBluetooth delivered 244-byte notifies. Declared v21=1244 and v20=2140 never arrived as complete ATT values. Fail-closed decoders therefore emit 0 B2 deep frames from this corpus. Complete CRC-valid frames exist in docs/research/fixtures/deep_records_2026-09-01.json and tests/fixtures/noop-whoop5-parity.json.',
    },
    objects: objectCount,
    download_failures: downloadFailures,
    notifies: notifyCount,
    framed_notifies: framedCount,
    reassembled_frames: reassembled,
    type47_puffin: type47,
    expected_lengths: { v18: V18_FRAME_LEN, v20: V20_FRAME_LEN, v21: V21_FRAME_LEN, v26: V26_FRAME_LEN },
    counts: {
      v18: layouts.v18.decoded,
      v20: layouts.v20.decoded,
      v21: layouts.v21.decoded,
      v26: layouts.v26.decoded,
      v20_truncated_unique: layouts.v20.truncated_unique,
      v21_truncated_unique: layouts.v21.truncated_unique,
      type43_v21_truncated_unique: type43v21.truncated_unique,
      unknown: layouts.unknown.frames,
      crc_rejected: crcRejected,
      shape_rejected: shapeRejected,
      unknown_layout: unknownLayout,
    },
    layouts: {
      v18: compactLayout(layouts.v18),
      v20: compactLayout(layouts.v20),
      v21: compactLayout(layouts.v21),
      v26: compactLayout(layouts.v26),
      unknown: compactLayout(layouts.unknown),
      type43_v21_truncated: compactLayout(type43v21),
    },
    fixtures: fixtureFrames,
    fixture_complete_frames: {
      v21: fixtureImu.length,
      v20: fixtureOptical.length,
      gravity_shell: gravityShellStats(fixtureImu),
      gyro: gyroStats(fixtureImu),
      v20_structure: v20StructuralStats(fixtureOptical),
    },
    v21_validation: {
      source: imuFrames.length ? 'b2_complete' : 'fixtures_only',
      frames: (imuFrames.length ? imuFrames : fixtureImu).length,
      six_axis_samples: (imuFrames.length ? imuFrames : fixtureImu).length * 100,
      gravity_shell: v21grav,
      gyro: v21gyro,
      cadence: v21cad,
    },
    v26_validation: {
      frames: ppgFrames.length,
      ppg_samples: ppgFrames.length * 24,
      contiguous_minutes: contiguousMin,
      hr_lock: v26hr,
    },
    v20_validation: {
      source: opticalFrames.length ? 'b2_complete' : 'fixtures_only',
      ...v20qa,
    },
    unexpected: unexpected.slice(0, 20),
    replay_session: {
      crc_valid_frames: crcValidFrames,
      crc_invalid_frames: crcInvalidFrames,
    },
  };

  mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  writeFileSync(OUT_MD, renderMd(report));
  console.log(JSON.stringify({
    wrote: [OUT_JSON, OUT_MD],
    counts: report.counts,
    v21_frames: report.v21_validation.frames,
    v21_source: report.v21_validation.source,
    v26_frames: ppgFrames.length,
    v20_frames: report.v20_validation.source === 'b2_complete' ? opticalFrames.length : fixtureOptical.length,
    r22: report.r22_action,
    max_notify: maxNotify,
  }, null, 2));
}

function topn(map, n = 8) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}: ${v}`);
}

function renderMd(r) {
  const c = r.counts;
  return `# WHOOP 5/MG deep-sensor census

Generated: ${r.generated_at}
Decoder: \`${r.decoder_version}\`
Source: ${r.list_source}
R22: **${r.r22_action}** — ${r.r22_reason}

## Capture gap

Max ATT notify in Level A: **${r.capture_gap.max_notify_bytes} B** (MTU payload 244).
Complete CRC-valid v20+v21 in Level A: **${r.capture_gap.v20_v21_complete_in_level_a}**.
${r.capture_gap.note}

## Type-47 complete frames (exact length + CRC)

| layout | decoded | crc_ok | truncated unique records | truncated notifies |
|---|---:|---:|---:|---:|
| v18 (124 B) | ${r.layouts.v18.decoded} | ${r.layouts.v18.crc_ok} | 0 | 0 |
| v20 (2140 B) | ${r.layouts.v20.decoded} | ${r.layouts.v20.crc_ok} | ${r.layouts.v20.truncated_unique} | ${r.layouts.v20.truncated_notifies} |
| v21 (1244 B) | ${r.layouts.v21.decoded} | ${r.layouts.v21.crc_ok} | ${r.layouts.v21.truncated_unique} | ${r.layouts.v21.truncated_notifies} |
| v26 (88 B) | ${r.layouts.v26.decoded} | ${r.layouts.v26.crc_ok} | 0 | 0 |
| unknown version | ${r.layouts.unknown.decoded} | ${r.layouts.unknown.crc_ok} | — | — |
| live type-43 v21 (truncated) | 0 | 0 | ${r.layouts.type43_v21_truncated.truncated_unique} | ${r.layouts.type43_v21_truncated.truncated_notifies} |

CRC rejected complete-looking frames: ${c.crc_rejected}
Shape rejected: ${c.shape_rejected}
Unknown layout: ${c.unknown_layout}

Reassembled complete frames: ${r.reassembled_frames}. Type-47 complete: ${r.type47_puffin}.
Fixture complete frames: v18=${r.fixtures.v18} v20=${r.fixtures.v20} v21=${r.fixtures.v21} v26=${r.fixtures.v26}.

## v21 IMU

Source: **${r.v21_validation.source}**
Frames: ${r.v21_validation.frames}
Six-axis samples: ${r.v21_validation.six_axis_samples}
Gravity shell: ${JSON.stringify(r.v21_validation.gravity_shell)}
Gyro: ${JSON.stringify(r.v21_validation.gyro)}
Cadence: ${JSON.stringify(r.v21_validation.cadence)}

Fixture-only gravity/gyro: ${JSON.stringify(r.fixture_complete_frames.gravity_shell)} / ${JSON.stringify(r.fixture_complete_frames.gyro)}

## v26 PPG (24 Hz i16 waveform, no wavelength)

Frames: ${r.v26_validation.frames}
PPG samples: ${r.v26_validation.ppg_samples}
Contiguous minutes (record count / 60): ${r.v26_validation.contiguous_minutes}
HR-lock: ${JSON.stringify(r.v26_validation.hr_lock)}

## v20 optical structure (neutral blocks)

Source: **${r.v20_validation.source}**

${JSON.stringify(r.v20_validation, null, 2)}

## Breakdown (top)

### v21 truncated unique
- devices: ${topn(r.layouts.v21.by_device).join('; ') || 'none'}
- firmware: ${topn(r.layouts.v21.by_firmware).join('; ') || 'none'}
- days: ${topn(r.layouts.v21.by_day).join('; ') || 'none'}

### v26 complete
- devices: ${topn(r.layouts.v26.by_device).join('; ') || 'none'}
- firmware: ${topn(r.layouts.v26.by_firmware).join('; ') || 'none'}
- days: ${topn(r.layouts.v26.by_day).join('; ') || 'none'}

### v20 truncated unique
- devices: ${topn(r.layouts.v20.by_device).join('; ') || 'none'}
- firmware: ${topn(r.layouts.v20.by_firmware).join('; ') || 'none'}
- days: ${topn(r.layouts.v20.by_day).join('; ') || 'none'}

## Unexpected (first 20)

${r.unexpected.length ? r.unexpected.map((u) => `- v${u.layout_version} len=${u.total_frame_length} crc=${u.crc_ok} reason=${u.reason}`).join('\n') : '_none_'}
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
