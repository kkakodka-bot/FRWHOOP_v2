#!/usr/bin/env node
// Independent packet-54 corpus audit.
// Reassembles Puffin frames from B2 Level A `frames` archives and local
// ble-frames.ndjson dumps. Structure is read at fixed offsets; the semantic
// decoder is compared afterwards, not used to decide CRC/length validity.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageConfig } from '../storage/config.js';
import { createS3 } from '../storage/s3.js';
import { createReassembler, verifyFrame } from '../protocol/framing.js';
import { u16le, u32le } from '../protocol/crc.js';
import { readPuffin54Structure, decodePuffinEvents54, PUFFIN54_DECODER_VERSION } from '../protocol/puffin54.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { cache: '/tmp/frwhoop-p54-cache', outDir: process.cwd(), local: [], skipB2: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cache') out.cache = argv[++i];
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--local') out.local.push(argv[++i]);
    else if (a === '--skip-b2') out.skipB2 = true;
  }
  return out;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function compactChar(ch) {
  return String(ch || '').toUpperCase().replace(/-/g, '');
}

function isPuffinChar(ch) {
  return compactChar(ch).startsWith('FD4B');
}

function userOf(key) {
  return /\/users\/([^/]+)\//.exec(key)?.[1] || 'unknown';
}

function deviceOf(key) {
  return /\/devices\/([^/]+)\//.exec(key)?.[1] || 'unknown';
}

function parseRows(buf) {
  let text;
  try { text = gunzipSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  }
  return trimmed.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

async function paginateAllKeys(cfg) {
  const { createHmac } = await import('node:crypto');
  function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
  function sha(data) { return createHash('sha256').update(data).digest('hex'); }
  function amzDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  function enc(s) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
  function canonicalQuery(params) {
    return Object.keys(params).sort().map((k) => `${enc(k)}=${enc(String(params[k]))}`).join('&');
  }
  function signingKey(secret, dateStamp, region) {
    return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), 's3'), 'aws4_request');
  }
  const host = String(cfg.b2S3Endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const keys = [];
  let token = null;
  do {
    const now = new Date();
    const date = amzDate(now);
    const dateStamp = date.slice(0, 8);
    const query = { 'list-type': '2', prefix: 'v3/', 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const uri = `/${enc(cfg.b2Bucket)}`;
    const q = canonicalQuery(query);
    const headers = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': date };
    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join('');
    const canonicalRequest = ['GET', uri, q, canonicalHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
    const credentialScope = `${dateStamp}/${cfg.b2Region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, sha(canonicalRequest)].join('\n');
    const sig = createHmac('sha256', signingKey(cfg.b2ApplicationKey, dateStamp, cfg.b2Region)).update(stringToSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.b2KeyId}/${credentialScope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
    const url = `https://${host}${uri}?${q}`;
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) throw new Error(`list failed ${res.status}`);
    const xml = await res.text();
    const re = /<Key>([^<]+)<\/Key>/g;
    let m;
    while ((m = re.exec(xml))) keys.push(m[1]);
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    token = truncated ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] || null) : null;
  } while (token);
  return keys;
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

function defaultLocalPaths(extra) {
  const fromEnv = String(process.env.FRWHOOP_BLE_FRAMES || '').split(/[,:]/).map((s) => s.trim()).filter(Boolean);
  const guessed = [
    '/tmp/frwhoop-ble-frames-current.ndjson',
    '/tmp/frwhoop-phone/ble-frames.ndjson',
    '/tmp/frwhoop-phone-logs/ble-frames.ndjson',
    '/tmp/frwhoop-audit24-now/ble-frames.ndjson',
    '/tmp/frwhoop-audit24/ble-frames.ndjson',
    '/tmp/frwhoop-lock10/data/ble-frames.ndjson',
  ];
  const seen = new Set();
  const out = [];
  for (const p of [...new Set([...extra, ...fromEnv, ...guessed])]) {
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      const id = `${st.dev}:${st.ino}:${st.size}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(p);
    } catch { out.push(p); }
  }
  return out;
}

async function readNdjson(file) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

function bump(map, key, by = 1) {
  const k = String(key);
  map[k] = (map[k] || 0) + by;
}

function entropy(bytes) {
  if (!bytes.length) return 0;
  const counts = new Map();
  for (const b of bytes) counts.set(b, (counts.get(b) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function utf8OkRate(bytes) {
  try {
    const s = Buffer.from(bytes).toString('utf8');
    const again = Buffer.from(s, 'utf8');
    if (again.length !== bytes.length) return 0;
    let printable = 0;
    for (const b of bytes) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable += 1;
    return printable / bytes.length;
  } catch {
    return 0;
  }
}

function receiveDay(iso) {
  if (!iso) return 'unknown';
  const d = String(iso).slice(0, 10);
  return d || 'unknown';
}

function ingestSource(store, rows, { origin, user, device, objectKey }) {
  const reassemblers = new Map();
  const out = [];
  for (const row of rows) {
    const hex = typeof row?.hex === 'string' ? row.hex : '';
    if (!hex) continue;
    let bytes;
    try { bytes = Buffer.from(hex, 'hex'); } catch { continue; }
    const ch = row.char || row.characteristic || '';
    if (ch && !isPuffinChar(ch) && !hex.startsWith('aa01')) continue;
    if (!isPuffinChar(ch) && !hex.startsWith('aa')) continue;
    const fam = (row.family || (isPuffinChar(ch) || hex.startsWith('aa01') ? 'puffin' : 'harvard')).toLowerCase();
    if (fam !== 'puffin' && !hex.startsWith('aa01')) continue;
    const deviceId = row.deviceId || row.device_id || device || 'unknown';
    const key = `${origin}|${deviceId}|${compactChar(ch) || 'none'}`;
    if (!reassemblers.has(key)) reassemblers.set(key, createReassembler({ family: 'puffin' }));
    const ack = reassemblers.get(key).feed(Array.from(bytes));
    for (const frame of ack.frames || []) {
      out.push({
        frame,
        origin,
        user: row._user || user,
        device: deviceId,
        char: ch,
        fw: row.fw || row.firmware || null,
        received_at: row.t || row.datetime || null,
        object_key: objectKey || null,
      });
    }
  }
  return out;
}

function analyzeFrame(entry) {
  const { frame } = entry;
  const hash = sha256Hex(frame);
  const check = verifyFrame(frame, 'puffin');
  const declared = frame.length >= 4 ? u16le(frame, 2) : null;
  const total = declared != null ? declared + 8 : null;
  let reject = null;
  if (frame[0] !== 0xAA || frame[1] !== 0x01) reject = 'length';
  else if (total != null && frame.length < total) reject = 'truncated';
  else if (total != null && frame.length !== total) reject = 'length';
  else if (!check.ok) reject = 'crc';
  else if (frame[8] !== 54) return { hash, packet_type: frame[8], skip: true };

  if (reject) {
    return {
      hash, reject, origin: entry.origin, fw: entry.fw, char: entry.char,
      device: entry.device, received_at: entry.received_at, length: frame.length,
    };
  }

  const independent = readPuffin54Structure(frame);
  const decoded = decodePuffinEvents54(frame, { fw: entry.fw, char: entry.char });
  const rec = independent.records[0] || decoded.records[0] || null;
  const agree = independent.ok && !decoded.unmapped && rec
    && decoded.records[0]?.kind === independent.records[0].kind
    && decoded.records[0]?.stored_unix === independent.records[0].stored_unix
    && decoded.records[0]?.tag === independent.records[0].tag
    && decoded.records[0]?.payload_len === independent.records[0].payload_len
    && decoded.records[0]?.payload_hex === independent.records[0].payload_hex;

  return {
    hash,
    reject: independent.ok ? null : independent.reason,
    leftover: independent.leftover,
    agree,
    decoder_unmapped: decoded.unmapped || false,
    decoder_reason: decoded.reject_reason || null,
    origin: entry.origin,
    user: entry.user,
    device: entry.device,
    char: entry.char,
    fw: entry.fw,
    received_at: entry.received_at,
    length: frame.length,
    packet_type: 54,
    rec,
    payload_bytes: independent.records[0]?.payload_bytes || [],
  };
}

function emptyTagStats() {
  return { n: 0, min: null, max: null, bit15: 0, unique: new Set() };
}

function noteTag(stats, tag) {
  stats.n += 1;
  stats.unique.add(tag);
  if (stats.min == null || tag < stats.min) stats.min = tag;
  if (stats.max == null || tag > stats.max) stats.max = tag;
  if (tag & 0x8000) stats.bit15 += 1;
}

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.cache, { recursive: true });
  mkdirSync(args.outDir, { recursive: true });

  const cfg = storageConfig();
  const b2Rows = [];
  const b2Meta = { objects: 0, download_failures: 0, keys: 0 };
  if (!args.skipB2 && cfg.b2KeyId && cfg.b2ApplicationKey) {
    const s3 = createS3({
      endpoint: cfg.b2S3Endpoint,
      bucket: cfg.b2Bucket,
      region: cfg.b2Region,
      accessKeyId: cfg.b2KeyId,
      secretAccessKey: cfg.b2ApplicationKey,
    });
    const keys = await paginateAllKeys(cfg);
    const frameKeys = keys.filter((k) => k.includes('/frames/') && !k.includes('/frames_reassembled/'));
    b2Meta.keys = frameKeys.length;
    await pool(frameKeys, 8, async (key) => {
      const local = path.join(args.cache, key.replaceAll('/', '_'));
      let body;
      try {
        try { body = readFileSync(local); } catch {
          const obj = await s3.getObject(key);
          if (!obj) throw new Error('missing');
          body = obj.body;
          writeFileSync(local, body);
        }
        b2Meta.objects += 1;
        const rows = parseRows(body).map((r) => ({ ...r, _user: userOf(key), _device: deviceOf(key) }));
        b2Rows.push({ key, user: userOf(key), device: deviceOf(key), rows });
      } catch {
        b2Meta.download_failures += 1;
      }
    });
  }

  const localPaths = defaultLocalPaths(args.local);
  const type48 = [];
  const type50 = [];
  const type47Wear = [];
  const p54raw = [];

  function absorb(origin, rows, meta) {
    const frames = ingestSource(origin, rows, meta);
    for (const entry of frames) {
      const pt = entry.frame.length > 8 ? entry.frame[8] : null;
      if (pt === 54) p54raw.push(entry);
      if (pt === 48 && verifyFrame(entry.frame, 'puffin').ok) {
        type48.push({
          event_id: entry.frame[10],
          unix: u32le(entry.frame, 12),
          tag: u16le(entry.frame, 16),
          received_at: entry.received_at,
          origin: entry.origin,
        });
      }
      if (pt === 50 && verifyFrame(entry.frame, 'puffin').ok) {
        type50.push({
          unix: u32le(entry.frame, 12),
          subsec: u16le(entry.frame, 16),
          received_at: entry.received_at,
          origin: entry.origin,
        });
      }
      if (pt === 47 && entry.frame[9] === 18 && entry.frame.length > 81 && verifyFrame(entry.frame, 'puffin').ok) {
        type47Wear.push({
          unix: u32le(entry.frame, 15),
          on_wrist: entry.frame[81] & 3,
          received_at: entry.received_at,
        });
      }
    }
  }

  for (const obj of b2Rows) {
    absorb('b2', obj.rows, { origin: 'b2', user: obj.user, device: obj.device, objectKey: obj.key });
    obj.rows = [];
  }
  for (const p of localPaths) {
    const rows = await readNdjson(p);
    absorb('phone', rows, { origin: 'phone', user: 'local', device: 'iphone', objectKey: p });
  }

  const analyzed = [];
  for (const entry of p54raw) {
    const row = analyzeFrame(entry);
    if (!row.skip) analyzed.push(row);
  }
  const byOriginOcc = { b2: 0, phone: 0 };
  const byOriginUnique = { b2: new Set(), phone: new Set() };
  const unique = new Map();
  const groups = {};
  const kinds = {};
  const tags = emptyTagStats();
  const type48Tags = emptyTagStats();
  const type50Sub = emptyTagStats();
  const sameUnix = new Map();
  const kind2 = { n: 0, utf8: 0, entropy_sum: 0, prefixes: {}, lens: {} };
  const decoderDisagree = [];
  const rejects = [];

  for (const row of type48) noteTag(type48Tags, row.tag);
  for (const row of type50) noteTag(type50Sub, row.subsec);

  for (const row of analyzed) {
    if (row.reject) {
      rejects.push({ hash: row.hash, reason: row.reject, origin: row.origin, leftover: row.leftover || null });
      continue;
    }
    bump(byOriginOcc, row.origin);
    byOriginUnique[row.origin].add(row.hash);
    if (!unique.has(row.hash)) unique.set(row.hash, row);
    if (row.agree === false) decoderDisagree.push({ hash: row.hash, decoder_reason: row.decoder_reason });
    const rec = row.rec;
    if (!rec) continue;
    bump(kinds, rec.kind);
    noteTag(tags, rec.tag);
    if (!sameUnix.has(rec.stored_unix)) sameUnix.set(rec.stored_unix, []);
    sameUnix.get(rec.stored_unix).push({ tag: rec.tag, received_at: row.received_at, kind: rec.kind });
    if (rec.kind === 2) {
      kind2.n += 1;
      kind2.utf8 += utf8OkRate(row.payload_bytes);
      kind2.entropy_sum += entropy(row.payload_bytes);
      bump(kind2.lens, rec.payload_len);
      bump(kind2.prefixes, rec.payload_hex.slice(0, 4));
    }
    const gkey = [
      row.fw || '-',
      row.device || '-',
      compactChar(row.char).slice(0, 8) || '-',
      row.length,
      rec.kind,
      rec.tag,
      rec.payload_len,
      receiveDay(row.received_at),
      rec.stored_unix,
    ].join('|');
    bump(groups, gkey);
  }

  let sameUnixNonDecreasing = 0;
  let sameUnixGroups = 0;
  for (const rows of sameUnix.values()) {
    if (rows.length < 2) continue;
    sameUnixGroups += 1;
    const ordered = [...rows].sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
    let ok = true;
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].tag < ordered[i - 1].tag) { ok = false; break; }
    }
    if (ok) sameUnixNonDecreasing += 1;
  }

  const t48ByUnix = new Map();
  for (const e of type48) {
    if (!t48ByUnix.has(e.unix)) t48ByUnix.set(e.unix, []);
    t48ByUnix.get(e.unix).push(e);
  }
  const t50Unix = new Set(type50.map((t) => t.unix));
  const wearByUnix = new Map();
  for (const w of type47Wear) {
    if (!wearByUnix.has(w.unix)) wearByUnix.set(w.unix, []);
    wearByUnix.get(w.unix).push(w);
  }

  function windowHits(unix, windowSec) {
    const hits = [];
    for (let u = unix - windowSec; u <= unix + windowSec; u += 1) {
      const rows = t48ByUnix.get(u);
      if (rows) for (const e of rows) hits.push(e);
    }
    return hits;
  }

  const kindCorr = {};
  for (const row of unique.values()) {
    const rec = row.rec;
    if (!rec) continue;
    if (!kindCorr[rec.kind]) {
      kindCorr[rec.kind] = { n: 0, exact: 0, sec1: 0, sec5: 0, type48_ids: {}, type50_exact: 0, wear: { n: 0, on: 0 } };
    }
    const k = kindCorr[rec.kind];
    k.n += 1;
    const exact = windowHits(rec.stored_unix, 0);
    const s1 = windowHits(rec.stored_unix, 1);
    const s5 = windowHits(rec.stored_unix, 5);
    if (exact.length) k.exact += 1;
    if (s1.length) k.sec1 += 1;
    if (s5.length) k.sec5 += 1;
    for (const e of exact) bump(k.type48_ids, e.event_id);
    if (t50Unix.has(rec.stored_unix)) k.type50_exact += 1;
    const wear = wearByUnix.get(rec.stored_unix) || [];
    if (wear.length) {
      k.wear.n += 1;
      if (wear.some((w) => w.on_wrist > 0)) k.wear.on += 1;
    }
  }
  const exceptions = analyzed.filter((r) => r.origin === 'b2' && (r.reject || r.decoder_unmapped));
  const summary = {
    decoder_version: PUFFIN54_DECODER_VERSION,
    generated_at: new Date().toISOString(),
    b2: {
      frame_objects: b2Meta.keys,
      downloaded: b2Meta.objects,
      download_failures: b2Meta.download_failures,
      type54_occurrences: byOriginOcc.b2 || 0,
      type54_unique: byOriginUnique.b2.size,
      crc_valid_occurrences: analyzed.filter((r) => r.origin === 'b2' && !r.reject).length,
    },
    phone: {
      files: localPaths,
      type54_occurrences: byOriginOcc.phone || 0,
      type54_unique: byOriginUnique.phone.size,
    },
    combined_unique: unique.size,
    kinds,
    frame_lengths: Object.fromEntries(
      [...analyzed.filter((r) => !r.reject)].reduce((m, r) => (m.set(r.length, (m.get(r.length) || 0) + 1), m), new Map()),
    ),
    tag: {
      n: tags.n,
      min: tags.min,
      max: tags.max,
      bit15: tags.bit15,
      unique: tags.unique.size,
      goose_label: 'timestamp_subseconds',
      kept_name: 'tag',
      decisive: false,
      reason: 'range 0..32767 matches 1/32768 s AND other 15-bit fields; Goose omits payload_len; keep opaque tag',
      same_unix_groups_n2: sameUnixGroups,
      same_unix_nondecreasing: sameUnixNonDecreasing,
      type48_u16_at_16: { n: type48Tags.n, min: type48Tags.min, max: type48Tags.max, unique: type48Tags.unique.size, bit15: type48Tags.bit15 },
      type50_subsec: { n: type50Sub.n, min: type50Sub.min, max: type50Sub.max, unique: type50Sub.unique.size, bit15: type50Sub.bit15 },
    },
    leftover: {
      padding: rejects.filter((r) => r.reason === 'padding').length,
      length: rejects.filter((r) => r.reason === 'length').length,
      truncated: rejects.filter((r) => r.reason === 'truncated').length,
      crc: rejects.filter((r) => r.reason === 'crc').length,
    },
    kind2_payload: kind2.n ? {
      n: kind2.n,
      mean_utf8_printable: kind2.utf8 / kind2.n,
      mean_entropy_bits: kind2.entropy_sum / kind2.n,
      lengths: kind2.lens,
      prefixes: kind2.prefixes,
      console_text: false,
    } : null,
    correlation: kindCorr,
    decoder_disagree: decoderDisagree.length,
    semantic_policy: {
      2: { candidate_name: 'CONSOLE_OUTPUT', semantic_status: 'candidate_semantic', hardware_verified: false },
      9: { candidate_name: 'WRIST_ON', semantic_status: 'candidate_semantic', hardware_verified: false },
      19: { candidate_name: 'SERIAL_HEAD_CONNECTED', semantic_status: 'candidate_semantic', hardware_verified: false },
      20: { candidate_name: 'SERIAL_HEAD_REMOVED', semantic_status: 'candidate_semantic', hardware_verified: false },
    },
    groups,
    exceptions: exceptions.slice(0, 50),
    exception_count: exceptions.length,
  };

  const uniqueKinds = {};
  for (const row of unique.values()) {
    if (row.rec) bump(uniqueKinds, row.rec.kind);
  }
  summary.unique_kinds = uniqueKinds;
  const md = [
    '# Packet 54 corpus audit',
    '',
    `- Decoder: \`${PUFFIN54_DECODER_VERSION}\``,
    `- B2 CRC-valid type 54 occurrences: **${summary.b2.crc_valid_occurrences}** (unique hashes ${summary.b2.type54_unique})`,
    `- Phone CRC-valid type 54 occurrences: **${analyzed.filter((r) => r.origin === 'phone' && !r.reject).length}** (unique hashes ${summary.phone.type54_unique})`,
    `- Combined unique hashes: **${summary.combined_unique}**`,
    `- Unique kinds: ${JSON.stringify(uniqueKinds)}`,
    `- Decoder disagreements: ${summary.decoder_disagree}`,
    `- B2 exceptions (reject or unmapped): ${summary.exception_count}`,
    `- Leftover after payload: padding=${summary.leftover.padding} length=${summary.leftover.length} truncated=${summary.leftover.truncated} crc=${summary.leftover.crc}`,
    `- Tag: kept as \`tag\` (Goose subseconds disagreement unresolved). range ${tags.min}..${tags.max}, bit15=${tags.bit15}, same-unix nondecreasing ${sameUnixNonDecreasing}/${sameUnixGroups}`,
    `- Kind 2 payload is not console text (utf8 printable ${(kind2.n ? kind2.utf8 / kind2.n : 0).toFixed(3)}, entropy ${(kind2.n ? kind2.entropy_sum / kind2.n : 0).toFixed(2)} bits); type50 exact ${kindCorr[2]?.type50_exact || 0}/${kindCorr[2]?.n || 0}`,
    `- Kind 9 vs type-48 event 9: exact ${kindCorr[9]?.type48_ids?.[9] || 0} of ${kindCorr[9]?.n || 0} unique; wear overlap ${kindCorr[9]?.wear?.n || 0}. Not hardware-verified WRIST_ON`,
    `- Kind 20 exact type-48 at stored unix: ${kindCorr[20]?.exact || 0}/${kindCorr[20]?.n || 0} (id 109 appears ${kindCorr[20]?.type48_ids?.[109] || 0} times). SERIAL_HEAD_* still not displayed as fact`,
    `- Kind 19 remains a neutral id (candidate_semantic only)`,
    '',
  ].join('\n');

  const jsonPath = path.join(args.outDir, 'packet54_audit.json');
  const mdPath = path.join(args.outDir, 'packet54_audit.md');
  writeFileSync(jsonPath, JSON.stringify(summary, (k, v) => (v instanceof Set ? [...v] : v), 2));
  writeFileSync(mdPath, md);
  console.log(md);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
