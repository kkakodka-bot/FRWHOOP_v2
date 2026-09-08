#!/usr/bin/env node
// FRWHOOP protocol corpus census CLI.
//
// Reads the Level A notify archive list (Backblaze B2 `frames` stream),
// downloads each gzip NDJSON object through the same cache + pool pattern as
// bin/redecode-b2-archive.mjs, replays every FRAMED notify through the
// reassembler + decoder, and prints a per-axis census as JSON to stdout
// (optionally also to --out <file>).
//
// Read-only by design: this tool never uploads and never writes to B2. It only
// writes to the local frame object cache (--cache-dir) and the --out file.
//
// Requires /tmp/frwhoop-b2-list.json (produced by bin/list-b2-archive.mjs):
// {frame_keys:[...], ...}. If it is missing the tool prints an honest error
// and exits 2 — it never fabricates an archive.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { storageConfig } from '../storage/config.js';
import { createS3 } from '../storage/s3.js';
import { replayNotifies } from '../redecode/redecode.js';
import {
  censusFromLevelB, parseArchiveRows, framedRowsOnly,
  buildRowMetaMap, attachMetaToLevelB, CENSUS_VERSION,
} from '../protocol/census.js';

const LIST_PATH = '/tmp/frwhoop-b2-list.json';
const DEFAULT_CACHE_DIR = '/tmp/frwhoop-redecode/frames';

const USAGE = `protocol-census — FRWHOOP corpus census over the B2 Level A archive

Usage:
  node bin/protocol-census.mjs [options]

Replays every framed Level A notify row through the reassembler + decoder and
reports per-axis aggregates (model, firmware, service family, characteristic,
packet type, hist version, body tag, exact frame length) plus:
  - crc_ok vs crc_failed counts
  - payload bytes structurally mapped vs unknown bytes (decoder coverage sums)
  - semantically validated field counts
  - top 20 unknown byte spans, decode_status histogram, warnings histogram

Output is JSON on stdout (the whole census object). Read-only: never uploads.

Options:
  --out <file>       also write the census JSON to <file>
  --limit <N>        process at most N framed Level A notify rows
  --cache-dir <dir>  frame object cache directory
                     (default ${DEFAULT_CACHE_DIR})
  --list <path>      path to the B2 archive list JSON
                     (default ${LIST_PATH})
  --help             show this help and exit

Exit codes:
  0  census produced
  1  runtime failure (download/parse/replay)
  2  archive list missing or unreadable, or bad arguments
`;

function flagValue(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}

function userOf(key) {
  const m = /\/users\/([^/]+)\//.exec(key);
  return m ? m[1] : 'unknown';
}

function deviceOf(key) {
  const m = /\/devices\/([^/]+)\//.exec(key);
  return m ? m[1] : 'unknown';
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
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const outFile = flagValue(argv, 'out', null);
  const cacheDir = flagValue(argv, 'cache-dir', DEFAULT_CACHE_DIR);
  const listPath = flagValue(argv, 'list', LIST_PATH);
  const limitRaw = flagValue(argv, 'limit', null);

  let limit = null;
  if (limitRaw != null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`protocol-census: --limit must be a positive integer, got ${JSON.stringify(limitRaw)}`);
      process.exit(2);
    }
  }

  if (!existsSync(listPath)) {
    console.error(`protocol-census: archive list not found at ${listPath}`);
    console.error('  generate it with: node bin/list-b2-archive.mjs');
    console.error(`  (expected ${LIST_PATH}; override with --list <path>)`);
    process.exit(2);
  }

  let listed;
  try {
    listed = JSON.parse(readFileSync(listPath, 'utf8'));
  } catch (err) {
    console.error(`protocol-census: cannot parse ${listPath}: ${err.message}`);
    process.exit(2);
  }
  const frameKeys = Array.isArray(listed.frame_keys) ? listed.frame_keys : [];

  mkdirSync(cacheDir, { recursive: true });
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
    const local = path.join(cacheDir, key.replaceAll('/', '_'));
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
      const rows = parseArchiveRows(body);
      perObject.push({
        key,
        user: userOf(key),
        device: deviceOf(key),
        notifies: rows.length,
        rows,
      });
    } catch (err) {
      downloadFailures += 1;
      perObject.push({ key, user: userOf(key), device: deviceOf(key), error: String(err.message || err), rows: [] });
    }
  });

  const notifies = [];
  for (const o of perObject) {
    for (const row of o.rows || []) notifies.push({ ...row, _user: o.user, _device: o.device, _key: o.key });
  }

  // Framed-rows-only: GATT service reads (battery/model/fw) and non-WHOOP
  // vault blobs contain 0xAA bytes; only AA-framed payloads belong in the
  // reassembler (same filter as bin/redecode-b2-archive.mjs).
  let framed = framedRowsOnly(notifies);
  const framedTotal = framed.length;
  if (limit != null && framed.length > limit) framed = framed.slice(0, limit);

  const metaMap = buildRowMetaMap(framed);
  const result = replayNotifies(framed, { family: undefined });
  attachMetaToLevelB(result.levelB, metaMap);

  const census = censusFromLevelB(result.levelB);
  census.run = {
    census_version: CENSUS_VERSION,
    list_path: listPath,
    cache_dir: cacheDir,
    b2_objects_listed: listed.object_count ?? null,
    frame_objects: frameKeys.length,
    download_failures: downloadFailures,
    notifies: notifies.length,
    framed_notifies: framedTotal,
    limit,
    notifications_received: result.session.notifications_received,
    reassembled_frames: result.session.reassembled_frames,
    crc_valid_frames: result.session.crc_valid_frames,
    crc_invalid_frames: result.session.crc_invalid_frames,
    decoded_frames: result.session.decoded_frames,
    partially_decoded_frames: result.session.partially_decoded_frames,
    classified_frames: result.session.classified_frames,
    unknown_packet_types: result.session.unknown_packet_types,
    parser_exceptions: result.session.parser_exceptions,
    decoder: result.levelB[0]?.decoder ?? null,
  };

  if (outFile) {
    writeFileSync(outFile, JSON.stringify(census, null, 2) + '\n');
  }
  console.log(JSON.stringify(census, null, 2));
}

main().catch((err) => {
  console.error(`protocol-census: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
