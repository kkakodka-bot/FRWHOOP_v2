#!/usr/bin/env node
// Offline data-completeness reconciliation for a requested day.
//
// Answers, from B2 alone (no Supabase service role required):
//   * which physiology objects exist for the day, their sample counts and
//     first/last timestamps, with the stored object's sha256
//   * 5-minute-bucket coverage vs the expected 288 buckets/day
//   * the concrete gap intervals (which minutes have no samples)
//   * with --verify: re-read + decode every object and report decode failures
//
// Usage:
//   node bin/reconcile-day-coverage.mjs [--day YYYY-MM-DD] [--verify] [--json]
//
// Complements /api/ingest/verify (service-role + live buffers) with an
// archive-only view, so ingestion gaps stay diagnosable without a database.
import { gunzipSync } from 'node:zlib';
import { createHash, createHmac } from 'node:crypto';
import { storageConfig } from '../storage/config.js';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}
function amzDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function canonicalQuery(params) {
  return Object.keys(params).sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(String(params[k]))}`)
    .join('&');
}
function signingKey(secret, dateStamp, region) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function signedListRequest({ host, bucket, region, accessKeyId, secretAccessKey }, query) {
  const now = new Date();
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const uri = `/${encodeRfc3986(bucket)}`;
  const q = canonicalQuery(query);
  const headers = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': date };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = ['GET', uri, q, canonicalHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const sig = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region)).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
  return { url: `https://${host}${uri}?${q}`, headers };
}

function signedGetObject({ host, bucket, region, accessKeyId, secretAccessKey }, key) {
  const now = new Date();
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const uri = `/${encodeRfc3986(bucket)}/${key.split('/').map(encodeRfc3986).join('/')}`;
  const headers = {
    host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': date,
  };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = ['GET', uri, '', canonicalHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const sig = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region)).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
  return { url: `https://${host}${uri}`, headers };
}

function decodeRows(buf) {
  let text;
  try { text = gunzipSync(Buffer.from(buf)).toString('utf8'); }
  catch { text = Buffer.from(buf).toString('utf8'); }
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) { const a = JSON.parse(trimmed); return Array.isArray(a) ? a : []; }
  return trimmed.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function bucketOf(ms, dayStart) {
  return Math.min(287, Math.max(0, Math.floor((ms - dayStart) / 300_000)));
}

function gapRuns(buckets) {
  const runs = [];
  let run = null;
  for (let i = 0; i < buckets.length; i += 1) {
    if (!buckets[i]) {
      if (run) run.to_min = (i + 1) * 5;
      else { run = { from_min: i * 5, to_min: (i + 1) * 5 }; runs.push(run); }
    } else run = null;
  }
  return runs;
}

async function main() {
  const cfg = storageConfig();
  if (!cfg.b2KeyId || !cfg.b2ApplicationKey) {
    console.error('B2 credentials missing (backend/.env). Cannot reconcile.');
    process.exit(2);
  }
  const day = argOf('--day') || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const verify = hasFlag('--verify');
  const host = String(cfg.b2S3Endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const sig = { host, bucket: cfg.b2Bucket, region: cfg.b2Region, accessKeyId: cfg.b2KeyId, secretAccessKey: cfg.b2ApplicationKey };

  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const dayEnd = dayStart + 86_400_000;

  // Page through both v1/ and v2/ trees; keep physiology objects.
  const physiology = [];
  for (const prefix of ['v3/core/', 'v2/', 'v1/']) {
    let token = null;
    do {
      const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const { url, headers } = signedListRequest(sig, query);
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) { console.error(`list failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`); process.exit(2); }
      const xml = await res.text();
      let m;
      const keyRe = /<Key>([^<]+)<\/Key>/g;
      while ((m = keyRe.exec(xml))) {
        if (m[1].includes('/physiology/')) physiology.push(m[1]);
      }
      const trunc = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
      token = trunc ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] || null) : null;
    } while (token);
  }

  const report = {
    day,
    b2_bucket: cfg.b2Bucket,
    physiology_objects_total: physiology.length,
    day_objects: [],
    users: {},
    sample_count: 0,
    covered_buckets: 0,
    expected_buckets: 288,
    coverage_pct: 0,
    gaps: [],
    integrity: { checked: 0, decode_failures: 0 },
  };

  const buckets = new Array(288).fill(0);
  const tsOf = (row) => Date.parse(row.datetime || row.t || row.at || '');

  for (const key of physiology) {
    let res;
    try {
      const { url, headers } = signedGetObject(sig, key);
      res = await fetch(url, { method: 'GET', headers });
    } catch { continue; }
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    let rows = [];
    let decodeOk = true;
    try { rows = decodeRows(buf); } catch { decodeOk = false; }
    report.integrity.checked += 1;
    if (!decodeOk || !rows.length) {
      report.integrity.decode_failures += 1;
      continue;
    }
    const inDay = rows.filter((r) => {
      const t = tsOf(r);
      return Number.isFinite(t) && t >= dayStart && t < dayEnd;
    });
    if (!inDay.length) continue;
    const um = /\/users\/([^/]+)\//.exec(key);
    const user = um ? um[1] : 'unknown';
    report.day_objects.push({
      key,
      user,
      sample_count: inDay.length,
      sha256: sha256Hex(buf),
      first: inDay[0].datetime || inDay[0].t || null,
      last: inDay[inDay.length - 1].datetime || inDay[inDay.length - 1].t || null,
    });
    report.sample_count += inDay.length;
    const u = (report.users[user] ||= { sample_count: 0, objects: 0 });
    u.sample_count += inDay.length;
    u.objects += 1;
    for (const r of inDay) {
      const t = tsOf(r);
      buckets[bucketOf(t, dayStart)] = (buckets[bucketOf(t, dayStart)] || 0) + 1;
    }
  }

  report.covered_buckets = buckets.filter((b) => b > 0).length;
  report.coverage_pct = Math.round((report.covered_buckets / 288) * 1000) / 10;
  report.gaps = gapRuns(buckets.map((b) => b > 0));

  if (hasFlag('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`day=${day} objects=${report.day_objects.length}/${report.physiology_objects_total} samples=${report.sample_count} coverage=${report.coverage_pct}% (${report.covered_buckets}/288 buckets)`);
    for (const g of report.gaps.slice(0, 24)) {
      const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      console.log(`  gap ${fmt(g.from_min)} → ${fmt(g.to_min)} (${g.to_min - g.from_min} min)`);
    }
    if (report.gaps.length > 24) console.log(`  … +${report.gaps.length - 24} more gap runs`);
    console.log(`integrity: checked=${report.integrity.checked} decode_failures=${report.integrity.decode_failures}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
