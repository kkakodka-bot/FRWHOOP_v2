#!/usr/bin/env node
// Read-only v18 R-R unit + byte-43 respiration audit over the Level A frames corpus.
// Never writes to B2. Does not change production decode.
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { storageConfig } from '../storage/config.js';
import { createS3 } from '../storage/s3.js';
import { parseArchiveRows } from '../protocol/census.js';
import { auditV18Claims, ingestNotifyRow, AUDIT_VERSION } from '../protocol/v18ClaimsAudit.js';

const LIST_PATH = '/tmp/frwhoop-b2-list.json';
const DEFAULT_CACHE_DIR = '/tmp/frwhoop-redecode/frames';

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

function walkCache(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
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
  const cacheDir = flagValue(argv, 'cache-dir', DEFAULT_CACHE_DIR);
  const listPath = flagValue(argv, 'list', LIST_PATH);
  const outFile = flagValue(argv, 'out', null);
  const limitRaw = flagValue(argv, 'limit', null);
  const limit = limitRaw != null ? Number(limitRaw) : null;

  mkdirSync(cacheDir, { recursive: true });
  const cfg = storageConfig();
  let frameKeys = [];
  if (existsSync(listPath)) {
    const listed = JSON.parse(readFileSync(listPath, 'utf8'));
    frameKeys = Array.isArray(listed.frame_keys) ? listed.frame_keys : [];
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

  let localFiles = [];
  if (!frameKeys.length) localFiles = walkCache(cacheDir);
  if (!frameKeys.length && !localFiles.length) {
    console.error('v18-claims-audit: no frame_keys and empty cache');
    process.exit(2);
  }

  const v18 = [], gatt = [], type40 = [];
  let objects = 0, rows = 0, failures = 0, ingested = 0;

  async function consume(buf, objectKey) {
    const device = deviceOf(objectKey);
    let parsed;
    try { parsed = parseArchiveRows(buf); } catch { return; }
    objects += 1;
    for (const row of parsed) {
      rows += 1;
      if (limit && ingested >= limit) return;
      const rec = ingestNotifyRow(row, { device, fw: row.fw });
      if (!rec || rec.skipped) continue;
      ingested += 1;
      if (rec.kind === 'v18') v18.push(rec);
      else if (rec.kind === 'gatt') gatt.push(rec);
      else if (rec.kind === 'type40') type40.push(rec);
    }
  }

  if (frameKeys.length) {
    await pool(frameKeys, 8, async (key) => {
      if (limit && ingested >= limit) return;
      const local = path.join(cacheDir, key.replaceAll('/', '_'));
      try {
        let body;
        try { body = readFileSync(local); } catch {
          if (!s3) throw new Error('missing cache');
          const obj = await s3.getObject(key);
          if (!obj) throw new Error('missing');
          body = obj.body;
          writeFileSync(local, body);
        }
        await consume(body, key);
      } catch {
        failures += 1;
      }
    });
  } else {
    for (const file of localFiles) {
      if (limit && ingested >= limit) break;
      try { await consume(readFileSync(file), file); } catch { failures += 1; }
    }
  }

  const report = auditV18Claims({ v18, gatt, type40 });
  report.corpus = {
    audit_version: AUDIT_VERSION,
    objects, rows, ingest_failures: failures,
    cache_dir: cacheDir,
    list: existsSync(listPath) ? listPath : null,
  };
  report.production_changes = [];
  const text = JSON.stringify(report, null, 2);
  if (outFile) {
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, text);
  }
  console.log(text);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
