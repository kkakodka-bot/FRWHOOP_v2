#!/usr/bin/env node
// List every object in the FRWHOOP B2 bucket (paginated).
import { storageConfig } from '../storage/config.js';
import { createHash, createHmac } from 'node:crypto';

function parseXmlKeys(xml) {
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml))) keys.push(m[1]);
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] || null;
  return { keys, truncated, token };
}

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
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(String(params[k]))}`)
    .join('&');
}
function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function signedList({ endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, token }) {
  const host = String(endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const now = new Date();
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
  if (token) query['continuation-token'] = token;
  const uri = `/${encodeRfc3986(bucket)}`;
  const q = canonicalQuery(query);
  const headers = {
    host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': date,
  };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = ['GET', uri, q, canonicalHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const sig = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, 's3'))
    .update(stringToSign)
    .digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
  const url = `https://${host}${uri}?${q}`;
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`list failed ${res.status} ${text.slice(0, 240)}`);
  }
  return parseXmlKeys(await res.text());
}

function classify(key) {
  if (key.includes('/frames/')) return 'frames';
  if (key.includes('/frames_reassembled/')) return 'frames_reassembled';
  if (key.includes('/physiology/')) return 'physiology';
  if (key.includes('/ppg/')) return 'ppg';
  if (key.includes('/imu/')) return 'imu';
  if (key.includes('/ble/')) return 'ble';
  if (key.includes('/diag/')) return 'diag';
  return 'other';
}

async function main() {
  const cfg = storageConfig();
  if (!cfg.b2KeyId || !cfg.b2ApplicationKey) {
    console.error('B2 credentials missing');
    process.exit(2);
  }
  const creds = {
    endpoint: cfg.b2S3Endpoint,
    bucket: cfg.b2Bucket,
    region: cfg.b2Region,
    accessKeyId: cfg.b2KeyId,
    secretAccessKey: cfg.b2ApplicationKey,
  };
  const keys = [];
  let token = null;
  do {
    const page = await signedList({ ...creds, prefix: '', token });
    keys.push(...page.keys);
    token = page.truncated ? page.token : null;
  } while (token);

  const byStream = {};
  for (const k of keys) {
    const s = classify(k);
    byStream[s] = (byStream[s] || 0) + 1;
  }
  console.log(JSON.stringify({
    bucket: cfg.b2Bucket,
    object_count: keys.length,
    by_stream: byStream,
    sample_keys: keys.slice(0, 40),
    frame_keys: keys.filter((k) => classify(k) === 'frames'),
    all_keys: keys,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
